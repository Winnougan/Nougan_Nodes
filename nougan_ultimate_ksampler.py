"""
Nougan Ultimate KSampler
------------------------
The regular-workflow sampler: model + conditioning + latent in, latent / image(video) / audio out.

  * Sampler dropdown merges ComfyUI's built-in samplers with RES4LYF's (ClownsharK) samplers.
    Entries prefixed "clown: " run through ClownsharKSampler_Beta (eta, bongmath, sampler_mode and the
    optional OPTIONS input apply); everything else runs through the stock ComfyUI sampling path.
  * `bongmath` is the on/off toggle for RES4LYF's bongmath.
  * `steps_to_run`           -> chainsampling, RES4LYF-style: run only the FIRST N steps of the schedule and
                               stop partially denoised (-1 = all). Passed straight through to clown samplers;
                               with built-in samplers the run moves to the guider path and slices the schedule.
  * `cfg_enabled` OFF runs positive-only guidance (BasicGuider) for CFG-free models, ignoring negative
    and cfg at half the per-step cost. Clown samplers get cfg=1.0 instead.
  * `vae` / `audio_vae`      -> decode the result into the image/video and AUDIO outputs.
  * `sigmas`                 -> optional custom sigma schedule (replaces scheduler/steps/denoise).
  * Live preview: the Model Preview Override wrapper (vendored from KJNodes into
    nougan_preview_override.py) is attached to the model for this run, so the node's own DOM panel
    (web/nougan_ultimate_ksampler.js) gets the same stream the Preview Mirror uses.
  * `preview_tiny_vae`       -> tiny VAE decoder from models/vae_approx for true-RGB previews, like the
                               tiny_vae input on KJ's Model Preview Override. Needs the decoder code:
                               a vendored tiny_vae.py or a live KJNodes install (borrowed at runtime).

MiniMax H3 has its own node — Nougan MiniMax H3 KSampler (nougan_h3_ksampler.py) — built for the
SamplerCustomAdvanced-shaped reference workflow (noise / guider / sigmas in, no CFG anywhere).

Soft dependencies, resolved at call time and never imported at module load:
  RES4LYF (ClownsharK samplers). Without it the node still works as a plain KSampler + VAE decode and
  says so in the console. The live preview is baked in (nougan_preview_override.py, vendored from
  KJNodes) and needs nothing external.
"""

import logging
import sys

import torch

import comfy.patcher_extension
import comfy.samplers
import folder_paths
import nodes

try:
    from server import PromptServer
except Exception:  # running outside ComfyUI (tests)
    PromptServer = None

_WRAPPER_KEY = "kj_preview_override"
_CLOWN_PREFIX = "clown: "
_LOG = "[Nougan UltimateKSampler]"


# ───────────────────────── soft-dependency discovery ─────────────────────────

def _is_torch_ops(module_name, obj):
    """torch.ops / torch.classes and friends have a __getattr__ that fabricates a dummy namespace
    object for ANY attribute name, so a sys.modules scan can 'find' anything there. Those shells
    are never callable; real targets here (classes, functions) always are."""
    if module_name == "torch.ops" or module_name.startswith(("torch.ops.", "torch._ops", "torch._classes")):
        return True
    return obj is not None and not callable(obj)


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
        if obj is not None and not _is_torch_ops(mod_name, obj):
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
    """Preview wrapper: the baked-in copy (nougan_preview_override.py) wins; a live KJNodes
    install is only a fallback. Returns None if neither is available."""
    try:
        from .nougan_preview_override import _PreviewOverrideWrapper
        return _PreviewOverrideWrapper
    except Exception:
        pass
    return _find_in_modules("_PreviewOverrideWrapper", "preview_override_node")


def _tiny_vae_choices():
    """Tiny VAE decoders from models/vae_approx for true-RGB previews ('none' = core previewer / Latent2RGB)."""
    try:
        return ["none"] + list(folder_paths.get_filename_list("vae_approx"))
    except Exception:
        return ["none"]


def _sampler_choices():
    return list(comfy.samplers.SAMPLER_NAMES) + [_CLOWN_PREFIX + n for n in _clown_sampler_names()]


def _scheduler_choices():
    # "none" = the schedule comes from the wired sigmas input (scheduler/steps/denoise unused).
    out = ["none"] + list(comfy.samplers.SCHEDULER_NAMES)
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


def _apply_steps_to_run(sigmas, steps_to_run):
    """RES4LYF chainsampler semantics: keep only the FIRST N steps of the schedule (N >= 1);
    -1 (or N >= total) means run everything. The result is a partially denoised latent."""
    if steps_to_run is None or steps_to_run < 1:
        return sigmas
    total = len(sigmas) - 1
    if steps_to_run >= total:
        return sigmas
    logging.info(f"{_LOG} steps_to_run={steps_to_run}: running the first {steps_to_run} of {total} steps "
                 f"(partial denoise — continue with another sampler).")
    return sigmas[:steps_to_run + 1]


class NouganUltimateKSampler:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL",),
                "positive": ("CONDITIONING",),
                "latent_image": ("LATENT",),
                "sampler_name": (_sampler_choices(), {
                    "default": "euler",
                    "tooltip": "Built-in ComfyUI samplers plus RES4LYF samplers (prefixed 'clown: ').",
                }),
                "scheduler": (_scheduler_choices(), {
                    "default": "beta" if "beta" in comfy.samplers.SCHEDULER_NAMES else comfy.samplers.SCHEDULER_NAMES[0],
                    "tooltip": "'none' = the schedule comes from the wired sigmas input. "
                               "RES4LYF-only schedulers (e.g. beta57) fall back to 'beta' on a built-in sampler.",
                }),
                "steps": ("INT", {"default": 30, "min": 1, "max": 10000}),
                "steps_to_run": ("INT", {"default": -1, "min": -1, "max": 10000,
                                         "tooltip": "Chainsampling: run only the FIRST N steps of the schedule, then stop "
                                                    "partially denoised (a second sampler continues from there). -1 = all steps."}),
                "cfg": ("FLOAT", {"default": 5.5, "min": -100.0, "max": 100.0, "step": 0.01, "round": False,
                                  "tooltip": "Classifier-free guidance scale. Ignored when cfg_enabled is OFF."}),
                "cfg_enabled": ("BOOLEAN", {
                    "default": True, "label_on": "CFG ON", "label_off": "CFG OFF",
                    "tooltip": "OFF for CFG-free models: samples with positive conditioning only "
                               "(BasicGuider) at half the per-step cost. negative and cfg are ignored while OFF. "
                               "(MiniMax H3 has its own node: Nougan MiniMax H3 KSampler.)"}),
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
                "negative": ("CONDITIONING", {"tooltip": "Optional: leave unplugged for positive-only (CFG-free) sampling — cfg is ignored then."}),
                "vae": ("VAE", {"tooltip": "Video/image VAE: decodes the result into the IMAGE output and can drive the preview."}),
                "audio_vae": ("VAE", {"tooltip": "Audio VAE: decodes the audio half of the result into the AUDIO output and drives the spectrogram preview."}),
                "sigmas": ("SIGMAS", {"tooltip": "Advanced: custom sigma schedule. Replaces scheduler / steps / denoise when connected."}),
                "options": ("OPTIONS", {"tooltip": "RES4LYF options chain (clown samplers only)."}),
                "preview": ("BOOLEAN", {"default": True, "label_on": "preview ON", "label_off": "preview OFF"}),
                "preview_max_res": ("INT", {"default": 1024, "min": 0, "max": 8192, "step": 8}),
                "preview_frames": ("INT", {"default": 1, "min": 1, "max": 1024,
                                           "tooltip": "Frames per step for the animated video preview (1 = single frame)."}),
                "preview_jpeg_quality": ("INT", {"default": 80, "min": 30, "max": 100}),
                "preview_tiny_vae": (_tiny_vae_choices(), {
                    "default": "none",
                    "tooltip": "Tiny VAE decoder (models/vae_approx) for true-RGB previews, like KJ's Model Preview Override. Needs the decoder code: vendored tiny_vae.py or a KJNodes install."}),
            },
            "hidden": {"unique_id": "UNIQUE_ID", "dynprompt": "DYNPROMPT"},
        }

    RETURN_TYPES = ("LATENT", "LATENT", "IMAGE", "AUDIO")
    RETURN_NAMES = ("latent", "denoised", "image", "audio")
    FUNCTION = "run"
    OUTPUT_NODE = True
    CATEGORY = "Nougan/sampling"
    DESCRIPTION = ("KSampler + ClownsharK sampler + VAE encode/decode + live preview in one node. "
                   "Image/video and audio outputs. For MiniMax H3 (SamplerCustomAdvanced-style: "
                   "noise / guider / sigmas in, no CFG) use the Nougan MiniMax H3 KSampler instead.")

    # ───────────────────────────── preview wiring ─────────────────────────────
    @staticmethod
    def _attach_preview(model, node_id, vae, audio_vae, max_res, quality, frames, fps, tiny_vae="none"):
        cls = _kj_wrapper_class()
        if cls is None:
            logging.warning(f"{_LOG} preview wrapper unavailable (nougan_preview_override.py missing/broken and no KJNodes); using ComfyUI's default preview only.")
            return model
        try:
            m = model.clone()
            m.add_wrapper_with_key(
                comfy.patcher_extension.WrappersMP.OUTER_SAMPLE, _WRAPPER_KEY,
                cls(max_res, node_id, quality, True, frames, fps, vae, tiny_vae, audio_vae),
            )
            return m
        except Exception as e:
            logging.warning(f"{_LOG} could not attach preview wrapper ({type(e).__name__}: {e}); continuing without it.")
            return model

    # ─────────────────────────────── sampling ────────────────────────────────
    def _sample_clown(self, model, positive, negative, latent, sampler_name, scheduler, steps, cfg, denoise,
                      seed, eta, sampler_mode, bongmath, sigmas, options, steps_to_run=-1):
        clown = _clown_class()
        if clown is None:
            raise RuntimeError(f"{_LOG} '{sampler_name}' needs RES4LYF (ClownsharK), which is not installed/loaded.")
        out = clown.execute(
            model=model, positive=positive, negative=negative, latent_image=latent,
            sampler_name=sampler_name[len(_CLOWN_PREFIX):], scheduler=scheduler,
            steps=steps, steps_to_run=steps_to_run, denoise=denoise, cfg=cfg, seed=seed,
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

    # ─────────────── CFG-off / custom-sigmas path ───────────────
    def _sample_custom(self, model, positive, negative, latent, sampler_name, scheduler, steps, cfg,
                       denoise, seed, sigmas, cfg_enabled=True, steps_to_run=-1):
        """Guider-based run for cfg_enabled OFF, a wired custom sigma schedule, or a partial
        (steps_to_run) run — delegating to ComfyUI's own node classes."""
        from comfy_extras import nodes_custom_sampler as ncs
        noise = _first(ncs.RandomNoise.execute(int(seed)))
        if cfg_enabled:
            guider = _first(ncs.CFGGuider.execute(model, positive, negative, cfg))
        else:
            guider = _first(ncs.BasicGuider.execute(model, positive))
        sampler_obj = _first(ncs.KSamplerSelect.execute(sampler_name))
        if sigmas is None:
            if scheduler not in comfy.samplers.SCHEDULER_NAMES:
                logging.warning(f"{_LOG} scheduler '{scheduler}' is RES4LYF-only; using 'beta' with '{sampler_name}'.")
                scheduler = "beta"
            ms = model.get_model_object("model_sampling")
            if denoise >= 0.9999:
                sigmas = comfy.samplers.calculate_sigmas(ms, scheduler, steps)
            else:
                sigmas = comfy.samplers.calculate_sigmas(ms, scheduler, max(1, int(steps / max(denoise, 1e-6))))[-(steps + 1):]
        sigmas = _apply_steps_to_run(sigmas, steps_to_run)
        out = ncs.SamplerCustomAdvanced.execute(noise, guider, sampler_obj, sigmas, latent)
        args = out.args if hasattr(out, "args") else out
        return args[0], (args[1] if len(args) > 1 and args[1] is not None else args[0])

    # ──────────────────────────────── entry ──────────────────────────────────
    def run(self, model, positive, latent_image, sampler_name, scheduler, steps, steps_to_run, cfg, cfg_enabled,
            denoise, seed, eta, sampler_mode, bongmath, decode, tiled_decode, preview_fps,
            negative=None, vae=None, audio_vae=None, sigmas=None, options=None,
            preview=True, preview_max_res=1024, preview_frames=1, preview_jpeg_quality=80,
            preview_tiny_vae="none",
            unique_id=None, dynprompt=None):
        node_id = _display_id(unique_id, dynprompt)
        node_raw = str(unique_id)
        logging.info(f"{_LOG} run start: unique_id={unique_id!r} node_id={node_id!r} "
                     f"(dynprompt {'available' if dynprompt is not None else 'MISSING'})")
        _emit("nougan_uk_phase", {"node": node_id, "node_raw": node_raw, "phase": "sampling"})

        latent = latent_image

        # No negative wired: run positive-only. positive as its own negative cancels CFG at
        # any cfg (cond − uncond = 0); forcing cfg off also skips the wasted second eval.
        if negative is None:
            logging.info(f"{_LOG} no negative connected — positive-only sampling this run (cfg ignored).")
            negative = positive
            cfg_enabled = False

        work_model = model
        if preview:
            work_model = self._attach_preview(model, node_id, vae, audio_vae, preview_max_res,
                                              preview_jpeg_quality, preview_frames, preview_fps,
                                              tiny_vae=preview_tiny_vae)

        if scheduler == "none":
            if sigmas is None:
                raise ValueError(f"{_LOG} scheduler is 'none' but no sigmas input is connected — "
                                 f"pick a scheduler, or wire a custom sigmas schedule.")
            scheduler = "beta"  # inert placeholder; the wired sigmas replace the schedule downstream
        if not cfg_enabled:
            logging.info(f"{_LOG} CFG OFF — positive-only guidance; negative and cfg are ignored.")
        if sigmas is not None:
            logging.info(f"{_LOG} sigmas input connected — it wins over the scheduler/steps/denoise widgets.")
        if sampler_name.startswith(_CLOWN_PREFIX):
            # Clown samplers have no guider concept; cfg=1.0 is the CFG-free equivalent there.
            out_latent, denoised = self._sample_clown(work_model, positive, negative, latent, sampler_name,
                                                      scheduler, steps, cfg if cfg_enabled else 1.0, denoise, seed, eta,
                                                      sampler_mode, bongmath, sigmas, options, steps_to_run=steps_to_run)
        elif sigmas is not None or not cfg_enabled or steps_to_run >= 1:
            # common_ksampler can't do partial runs, so steps_to_run routes here where we can slice the schedule.
            out_latent, denoised = self._sample_custom(work_model, positive, negative, latent, sampler_name,
                                                       scheduler, steps, cfg, denoise, seed,
                                                       sigmas, cfg_enabled=cfg_enabled, steps_to_run=steps_to_run)
        else:
            out_latent, denoised = self._sample_standard(work_model, positive, negative, latent, sampler_name,
                                                         scheduler, steps, cfg, denoise, seed)

        image_out, audio_out = None, _silent_audio()
        if decode and vae is not None:
            _emit("nougan_uk_phase", {"node": node_id, "node_raw": node_raw, "phase": "decoding"})
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

        _emit("nougan_uk_phase", {"node": node_id, "node_raw": node_raw, "phase": "done"})
        return {"ui": {"nougan_source_id": [node_id]},
                "result": (out_latent, denoised, image_out, audio_out)}


NODE_CLASS_MAPPINGS = {"NouganUltimateKSampler": NouganUltimateKSampler}
NODE_DISPLAY_NAME_MAPPINGS = {"NouganUltimateKSampler": "Nougan Ultimate KSampler"}
