"""
Nougan Ultimate KSampler
------------------------
One node: model + conditioning + latent (or an image + VAE to encode) in, latent / image(video) / audio out.

  * Sampler dropdown merges ComfyUI's built-in samplers with RES4LYF's (ClownsharK) samplers.
    Entries prefixed "clown: " run through ClownsharKSampler_Beta (eta, bongmath, sampler_mode and the
    optional OPTIONS input apply); everything else runs through the stock ComfyUI sampling path.
  * `bongmath` is the on/off toggle for RES4LYF's bongmath.
  * `image` + `vae`          -> encoded as the starting video latent (no separate VAE Encode node).
  * `audio` + `audio_vae`    -> encoded as the audio latent; with `image` the two are joined into one
                               audio+video latent (MiniMax H3 / LTX style). Connect a Load Video's image + audio.
  * `vae` / `audio_vae`      -> also decode the result into the image/video and AUDIO outputs.
  * Live preview: KJNodes' Model Preview Override wrapper is attached to the model for this run, so the
    node's own DOM panel (web/nougan_ultimate_ksampler.js) gets the same stream the Preview Mirror uses.

Soft dependencies, resolved at call time and never imported at module load:
  RES4LYF (ClownsharK samplers) and KJNodes (live preview). Without them the node still works as a
  plain KSampler + VAE decode and says so in the console.
"""

import logging
import sys

import torch

import comfy.patcher_extension
import comfy.samplers
import nodes

try:
    from server import PromptServer
except Exception:  # running outside ComfyUI (tests)
    PromptServer = None

_WRAPPER_KEY = "kj_preview_override"
_CLOWN_PREFIX = "clown: "
_LOG = "[Nougan UltimateKSampler]"


# ───────────────────────── soft-dependency discovery ─────────────────────────

def _find_in_modules(attr, name_hint=None):
    """Search already-imported custom-node modules for `attr` (so we never depend on the install folder name)."""
    for mod_name, mod in list(sys.modules.items()):
        if mod is None:
            continue
        if name_hint and name_hint not in mod_name:
            continue
        try:
            obj = getattr(mod, attr, None)
        except Exception:
            continue
        if obj is not None:
            return obj
    return None


def _clown_class():
    return _find_in_modules("ClownsharKSampler_Beta", "samplers")


def _clown_sampler_names():
    fn = _find_in_modules("get_sampler_name_list", "rk_coefficients")
    if fn is None:
        return []
    try:
        return [str(n) for n in fn()]
    except Exception:
        return []


def _clown_scheduler_names():
    fn = _find_in_modules("get_res4lyf_scheduler_list", "helper")
    if fn is None:
        return []
    try:
        return [str(n) for n in fn()]
    except Exception:
        return []


def _kj_wrapper_class():
    return _find_in_modules("_PreviewOverrideWrapper", "preview_override_node")


def _sampler_choices():
    return list(comfy.samplers.SAMPLER_NAMES) + [_CLOWN_PREFIX + n for n in _clown_sampler_names()]


def _scheduler_choices():
    out = list(comfy.samplers.SCHEDULER_NAMES)
    for n in _clown_scheduler_names():
        if n not in out:
            out.append(n)
    return out


# ───────────────────────────────── helpers ───────────────────────────────────

def _emit(event, payload):
    if PromptServer is None or getattr(PromptServer, "instance", None) is None:
        return
    try:
        PromptServer.instance.send_sync(event, payload, PromptServer.instance.client_id)
    except Exception:
        pass


def _display_id(unique_id, dynprompt):
    try:
        if dynprompt is not None:
            return str(dynprompt.get_display_node_id(unique_id))
    except Exception:
        pass
    return str(unique_id)


def _split_nested(latent_tensor):
    """(video_latent, audio_latent_or_None). Plain tensors come back as (tensor, None)."""
    if getattr(latent_tensor, "is_nested", False):
        parts = list(latent_tensor.unbind())
        return parts[0], (parts[-1] if len(parts) > 1 else None)
    return latent_tensor, None


def _silent_audio():
    return {"waveform": torch.zeros((1, 1, 1)), "sample_rate": 44100}


def _first(result):
    """First value of a V3 NodeOutput (or a plain tuple)."""
    args = result.args if hasattr(result, "args") else result
    return args[0]


def _decode_audio(audio_vae, latent):
    """Audio half of an AV latent -> AUDIO dict, using ComfyUI's own LTXVAudioVAEDecode (also used for MiniMax H3)."""
    from comfy_extras.nodes_lt_audio import LTXVAudioVAEDecode
    return _first(LTXVAudioVAEDecode.execute(latent, audio_vae))


def _encode_inputs(vae, audio_vae, image, audio):
    """image (+ audio) -> starting latent. Video + audio become a joint nested AV latent (video stream first)."""
    video_lat = audio_lat = None
    if image is not None:
        if vae is None:
            raise ValueError(f"{_LOG} `image` is connected but there is no `vae` to encode it with.")
        video_lat = {"samples": vae.encode(image[:, :, :, :3])}
    if audio is not None:
        if audio_vae is None:
            raise ValueError(f"{_LOG} `audio` is connected but there is no `audio_vae` to encode it with.")
        from comfy_extras.nodes_audio import VAEEncodeAudio
        audio_lat = _first(VAEEncodeAudio.execute(audio_vae, audio))
    if video_lat is not None and audio_lat is not None:
        from comfy_extras.nodes_lt import LTXVConcatAVLatent
        return _first(LTXVConcatAVLatent.execute(video_lat, audio_lat))
    return video_lat if video_lat is not None else audio_lat


class NouganUltimateKSampler:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL",),
                "positive": ("CONDITIONING",),
                "negative": ("CONDITIONING",),
                "sampler_name": (_sampler_choices(), {
                    "default": "euler",
                    "tooltip": "Built-in ComfyUI samplers plus RES4LYF samplers (prefixed 'clown: ').",
                }),
                "scheduler": (_scheduler_choices(), {
                    "default": "beta" if "beta" in comfy.samplers.SCHEDULER_NAMES else comfy.samplers.SCHEDULER_NAMES[0],
                    "tooltip": "RES4LYF-only schedulers (e.g. beta57) fall back to 'beta' on a built-in sampler.",
                }),
                "steps": ("INT", {"default": 30, "min": 1, "max": 10000}),
                "cfg": ("FLOAT", {"default": 5.5, "min": -100.0, "max": 100.0, "step": 0.01, "round": False}),
                "denoise": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff}),
                "eta": ("FLOAT", {"default": 0.5, "min": -100.0, "max": 100.0, "step": 0.01, "round": False,
                                  "tooltip": "Clown samplers only: noise added then removed after each step."}),
                "sampler_mode": (["standard", "unsample", "resample"], {
                    "default": "standard", "tooltip": "Clown samplers only."}),
                "bongmath": ("BOOLEAN", {
                    "default": True, "label_on": "bongmath ON", "label_off": "bongmath OFF",
                    "tooltip": "Clown samplers only: RES4LYF's bongmath on/off."}),
                "decode": ("BOOLEAN", {
                    "default": True, "label_on": "decode ON", "label_off": "decode OFF",
                    "tooltip": "Decode the result with the connected VAE(s). Off = latent only."}),
                "tiled_decode": ("BOOLEAN", {"default": False}),
                "preview_fps": ("INT", {"default": 12, "min": 1, "max": 60, "step": 1,
                                        "tooltip": "Playback FPS of the live preview (ignored for clips with audio)."}),
            },
            "optional": {
                "latent_image": ("LATENT",),
                "image": ("IMAGE", {"tooltip": "Image / video frames. Encoded with `vae` into the starting latent when latent_image is not connected."}),
                "audio": ("AUDIO", {"tooltip": "Audio track. Encoded with `audio_vae`; combined with `image` into one audio+video latent."}),
                "vae": ("VAE", {"tooltip": "Video/image VAE: encodes `image`, decodes the result, and can drive the preview."}),
                "audio_vae": ("VAE", {"tooltip": "Audio VAE: encodes `audio`, decodes the audio half of the result, and drives the spectrogram preview."}),
                "sigmas": ("SIGMAS",),
                "options": ("OPTIONS", {"tooltip": "RES4LYF options chain (clown samplers only)."}),
                "preview": ("BOOLEAN", {"default": True, "label_on": "preview ON", "label_off": "preview OFF"}),
                "preview_max_res": ("INT", {"default": 1024, "min": 0, "max": 8192, "step": 8}),
                "preview_frames": ("INT", {"default": 1, "min": 1, "max": 1024,
                                           "tooltip": "Frames per step for the animated video preview (1 = single frame)."}),
                "preview_jpeg_quality": ("INT", {"default": 80, "min": 30, "max": 100}),
            },
            "hidden": {"unique_id": "UNIQUE_ID", "dynprompt": "DYNPRMPT"},
        }

    RETURN_TYPES = ("LATENT", "LATENT", "IMAGE", "AUDIO")
    RETURN_NAMES = ("latent", "denoised", "image", "audio")
    FUNCTION = "run"
    OUTPUT_NODE = True
    CATEGORY = "Nougan/sampling"
    DESCRIPTION = ("KSampler + ClownsharK sampler + VAE encode/decode + live preview in one node. "
                   "Image/video and audio outputs.")

    # ───────────────────────────── preview wiring ─────────────────────────────
    @staticmethod
    def _attach_preview(model, node_id, vae, audio_vae, max_res, quality, frames, fps):
        cls = _kj_wrapper_class()
        if cls is None:
            logging.warning(f"{_LOG} KJNodes preview wrapper not found; using ComfyUI's default preview only.")
            return model
        try:
            m = model.clone()
            m.add_wrapper_with_key(
                comfy.patcher_extension.WrappersMP.OUTER_SAMPLE, _WRAPPER_KEY,
                cls(max_res, node_id, quality, True, frames, fps, vae, "none", audio_vae),
            )
            return m
        except Exception as e:
            logging.warning(f"{_LOG} could not attach preview wrapper ({type(e).__name__}: {e}); continuing without it.")
            return model

    # ─────────────────────────────── sampling ────────────────────────────────
    def _sample_clown(self, model, positive, negative, latent, sampler_name, scheduler, steps, cfg, denoise,
                      seed, eta, sampler_mode, bongmath, sigmas, options):
        clown = _clown_class()
        if clown is None:
            raise RuntimeError(f"{_LOG} '{sampler_name}' needs RES4LYF (ClownsharK), which is not installed/loaded.")
        out = clown.execute(
            model=model, positive=positive, negative=negative, latent_image=latent,
            sampler_name=sampler_name[len(_CLOWN_PREFIX):], scheduler=scheduler,
            steps=steps, steps_to_run=-1, denoise=denoise, cfg=cfg, seed=seed,
            eta=eta, sampler_mode=sampler_mode, bongmath=bool(bongmath), sigmas=sigmas,
            options_group={"options0": options} if options is not None else None,
        )
        args = out.args if hasattr(out, "args") else out
        return args[0], (args[1] if len(args) > 1 and args[1] is not None else args[0])

    def _sample_standard(self, model, positive, negative, latent, sampler_name, scheduler, steps, cfg, denoise, seed):
        if scheduler not in comfy.samplers.SCHEDULER_NAMES:
            logging.warning(f"{_LOG} scheduler '{scheduler}' is RES4LYF-only; using 'beta' with '{sampler_name}'.")
            scheduler = "beta"
        out = nodes.common_ksampler(model, seed, steps, cfg, sampler_name, scheduler,
                                    positive, negative, latent, denoise=denoise)[0]
        return out, out

    # ──────────────────────────────── entry ──────────────────────────────────
    def run(self, model, positive, negative, sampler_name, scheduler, steps, cfg, denoise, seed, eta,
            sampler_mode, bongmath, decode, tiled_decode, preview_fps,
            latent_image=None, image=None, audio=None, vae=None, audio_vae=None, sigmas=None, options=None,
            preview=True, preview_max_res=1024, preview_frames=1, preview_jpeg_quality=80,
            unique_id=None, dynprompt=None):
        node_id = _display_id(unique_id, dynprompt)
        _emit("nougan_uk_phase", {"node": node_id, "phase": "sampling"})

        # starting latent: a connected latent wins; otherwise encode image / audio with their VAEs
        latent = latent_image
        if latent is not None and (image is not None or audio is not None):
            logging.warning(f"{_LOG} latent_image is connected, so image/audio inputs are ignored.")
        if latent is None:
            latent = _encode_inputs(vae, audio_vae, image, audio)
            if latent is None:
                raise ValueError(f"{_LOG} connect latent_image, or image (+ vae) and/or audio (+ audio_vae) to encode from.")

        work_model = model
        if preview:
            work_model = self._attach_preview(model, node_id, vae, audio_vae, preview_max_res,
                                              preview_jpeg_quality, preview_frames, preview_fps)

        if sampler_name.startswith(_CLOWN_PREFIX):
            out_latent, denoised = self._sample_clown(work_model, positive, negative, latent, sampler_name,
                                                      scheduler, steps, cfg, denoise, seed, eta,
                                                      sampler_mode, bongmath, sigmas, options)
        else:
            out_latent, denoised = self._sample_standard(work_model, positive, negative, latent, sampler_name,
                                                         scheduler, steps, cfg, denoise, seed)

        image_out, audio_out = None, _silent_audio()
        if decode and vae is not None:
            _emit("nougan_uk_phase", {"node": node_id, "phase": "decoding"})
            video_lat, audio_lat = _split_nested(out_latent["samples"])
            sub = {"samples": video_lat}
            if tiled_decode:
                image_out = nodes.VAEDecodeTiled().decode(vae, sub, 512, 64, 64, 8)[0]
            else:
                image_out = nodes.VAEDecode().decode(vae, sub)[0]
            if audio_vae is not None and audio_lat is not None:
                try:
                    audio_out = _decode_audio(audio_vae, out_latent)
                except Exception as e:
                    logging.warning(f"{_LOG} audio decode failed ({type(e).__name__}: {e}); returning silent audio.")
        elif decode and vae is None:
            logging.warning(f"{_LOG} decode is ON but no vae is connected; returning latent only.")

        if image_out is None:
            image_out = torch.zeros((1, 64, 64, 3))  # placeholder so downstream IMAGE links never receive None

        _emit("nougan_uk_phase", {"node": node_id, "phase": "done"})
        return {"ui": {"nougan_source_id": [node_id]},
                "result": (out_latent, denoised, image_out, audio_out)}


NODE_CLASS_MAPPINGS = {"NouganUltimateKSampler": NouganUltimateKSampler}
NODE_DISPLAY_NAME_MAPPINGS = {"NouganUltimateKSampler": "Nougan Ultimate KSampler 🦈"}
