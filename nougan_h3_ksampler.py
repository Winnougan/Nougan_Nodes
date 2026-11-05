"""
Nougan MiniMax H3 KSampler
--------------------------
The MiniMax H3 sampler: SamplerCustomAdvanced-shaped, CFG-free (H3 is CFG-distilled), with the
suite's live preview panel and VAE / audio-VAE decode built in.

  * Wire it like the reference MiniMax H3 workflow: noise + guider + sampler + sigmas + latent_image.
    A GUIDER carries the model and the conditioning, so model/positive are optional with one wired.
  * No guider? Connect model + positive and the node builds a positive-only BasicGuider itself
    (the right thing for H3 — there is no CFG pass anywhere in this node, ever).
  * The sampler_name / scheduler / steps / denoise / seed widgets are fallbacks for running standalone;
    wire a SAMPLER / SIGMAS / NOISE input and the widgets it replaces hide themselves.
  * `steps_to_run`           -> chainsampling, RES4LYF-style: run only the FIRST N steps of the schedule and
                               stop partially denoised (-1 = all); also slices a wired sigmas schedule.
  * `vae` / `audio_vae`      -> decode the result into the image/video and AUDIO outputs
                               (the audio half of H3's AV latent goes through the audio VAE).
  * Live preview: the Model Preview Override wrapper (vendored from KJNodes into
    nougan_preview_override.py) rides the sampling model — including a model borrowed from a wired
    guider — so the node's DOM panel (web/nougan_ultimate_ksampler.js) shows every step.
  * `preview_tiny_vae`       -> tiny VAE decoder from models/vae_approx for true-RGB previews, like the
                               tiny_vae input on KJ's Model Preview Override. Needs the decoder code:
                               a vendored tiny_vae.py or a live KJNodes install (borrowed at runtime).

For everything that is not MiniMax H3, use the Nougan Ultimate KSampler (clown samplers, CFG toggle).

No hard dependencies: built-in samplers only, and the live preview is vendored in.
"""

import copy
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
_LOG = "[Nougan H3 KSampler]"


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


def _guider_model(guider):
    """Pull the model patcher out of a wired guider, whatever attribute the guider class
    stores it under. Core guiders (BasicGuider/CFGGuider) use .model_patcher; custom H3
    guider packs may use something else."""
    for attr in ("model_patcher", "model", "patcher", "_model_patcher"):
        mp = getattr(guider, attr, None)
        if mp is not None and hasattr(mp, "clone") and hasattr(mp, "add_wrapper_with_key"):
            return mp
    return None


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
    """Audio half of an AV latent -> AUDIO dict, using ComfyUI's own LTXVAudioVAEDecode (used for MiniMax H3)."""
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


class NouganH3KSampler:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "latent_image": ("LATENT",),
                "sampler_name": (list(comfy.samplers.SAMPLER_NAMES), {
                    "default": "euler",
                    "tooltip": "Built-in ComfyUI samplers (same list as KSamplerSelect).",
                }),
                "scheduler": (list(comfy.samplers.SCHEDULER_NAMES), {
                    "default": "beta" if "beta" in comfy.samplers.SCHEDULER_NAMES else comfy.samplers.SCHEDULER_NAMES[0],
                }),
                "steps": ("INT", {"default": 8, "min": 1, "max": 10000,
                                  "tooltip": "H3 is distilled: the reference workflow uses 8 steps."}),
                "steps_to_run": ("INT", {"default": -1, "min": -1, "max": 10000,
                                         "tooltip": "Chainsampling: run only the FIRST N steps of the schedule, then stop "
                                                    "partially denoised (a second sampler continues from there). -1 = all steps. "
                                                    "Also slices a wired sigmas schedule."}),
                "denoise": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff,
                                 "tooltip": "Ignored when a NOISE input is connected."}),
                "decode": ("BOOLEAN", {
                    "default": True, "label_on": "decode ON", "label_off": "decode OFF",
                    "tooltip": "Decode the result with the connected VAE(s). Off = latent only."}),
                "tiled_decode": ("BOOLEAN", {"default": False}),
                "preview_fps": ("INT", {"default": 12, "min": 1, "max": 60, "step": 1,
                                        "tooltip": "Playback FPS of the live preview (ignored for clips with audio)."}),
            },
            "optional": {
                "noise": ("NOISE", {"tooltip": "Custom noise source (e.g. RandomNoise). Replaces the seed widget when connected (the widget hides itself)."}),
                "guider": ("GUIDER", {"tooltip": "Custom guider (e.g. BasicGuider). Carries the model and conditioning, "
                                                 "so model/positive are optional with one wired."}),
                "sampler": ("SAMPLER", {"tooltip": "Custom sampler (e.g. KSamplerSelect). Replaces the sampler_name widget "
                                                   "when connected (the widget hides itself)."}),
                "sigmas": ("SIGMAS", {"tooltip": "Custom sigma schedule (e.g. BasicScheduler). Replaces the scheduler / steps / "
                                                 "denoise widgets when connected (they hide themselves)."}),
                "model": ("MODEL", {"tooltip": "Used to build a positive-only BasicGuider when no guider is wired "
                                               "(and for sigmas + the live preview). Optional when a guider is wired."}),
                "positive": ("CONDITIONING", {"tooltip": "Used with model to build the BasicGuider. Optional when a guider is wired."}),
                "vae": ("VAE", {"tooltip": "Video VAE: decodes the result into the IMAGE output and can drive the preview."}),
                "audio_vae": ("VAE", {"tooltip": "Audio VAE: decodes the audio half of H3's AV latent into the AUDIO output "
                                                 "and drives the spectrogram preview."}),
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
    DESCRIPTION = ("MiniMax H3 sampler: SamplerCustomAdvanced-shaped (noise / guider / sigmas / latent in), "
                   "CFG-free like H3 itself, with live preview and VAE + audio-VAE decode built in. "
                   "model/positive are only needed to auto-build a BasicGuider when no guider is wired.")

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
    def _sample(self, model, positive, latent, sampler_name, scheduler, steps, steps_to_run, denoise, seed,
                noise, guider, sampler, sigmas):
        """SamplerCustomAdvanced-style run, delegating to ComfyUI's own node classes. H3 is
        CFG-distilled, so a guider we build ourselves is always the positive-only BasicGuider.
        A wired NOISE / SAMPLER / SIGMAS input wins over the seed / sampler_name /
        scheduler / steps / denoise widgets."""
        from comfy_extras import nodes_custom_sampler as ncs
        if noise is None:
            noise = _first(ncs.RandomNoise.execute(int(seed)))
        if guider is None:
            guider = _first(ncs.BasicGuider.execute(model, positive))
        sampler_obj = sampler if sampler is not None else _first(ncs.KSamplerSelect.execute(sampler_name))
        if sigmas is None:
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
    def run(self, latent_image, sampler_name, scheduler, steps, steps_to_run, denoise, seed, decode, tiled_decode,
            preview_fps,
            noise=None, guider=None, sampler=None, sigmas=None, model=None, positive=None,
            vae=None, audio_vae=None,
            preview=True, preview_max_res=1024, preview_frames=1, preview_jpeg_quality=80,
            preview_tiny_vae="none",
            unique_id=None, dynprompt=None):
        node_id = _display_id(unique_id, dynprompt)
        node_raw = str(unique_id)
        logging.info(f"{_LOG} run start: unique_id={unique_id!r} node_id={node_id!r} "
                     f"(dynprompt {'available' if dynprompt is not None else 'MISSING'})")
        _emit("nougan_uk_phase", {"node": node_id, "node_raw": node_raw, "phase": "sampling"})

        latent = latent_image

        # A GUIDER carries the model and the conditioning (SamplerCustomAdvanced style):
        # model/positive are only needed to build a BasicGuider when no guider is wired.
        base_model = model if model is not None else (_guider_model(guider) if guider is not None else None)
        if base_model is None:
            if guider is None:
                raise ValueError(f"{_LOG} nothing to sample with: connect model, or wire a guider "
                                 f"(a guider carries its own model).")
            if sigmas is None:
                raise ValueError(f"{_LOG} could not read the model out of the wired guider "
                                 f"(custom guider class?), and no model is connected — needed to build the "
                                 f"sigma schedule. Connect the model input, or wire sigmas (e.g. BasicScheduler).")
            # guider + sigmas wired: sampling needs no model at all; only the live preview does.
            logging.warning(f"{_LOG} could not read the model out of the wired guider; live preview is OFF "
                            f"this run (connect the model input to bring it back).")
            preview = False
        if guider is None and positive is None:
            raise ValueError(f"{_LOG} positive is required to build a guider: connect positive, "
                             f"or wire a ready-made guider.")
        if guider is not None:
            logging.info(f"{_LOG} guider connected — sampling with the guider's model and conditioning.")

        work_model = base_model
        if preview and base_model is not None:
            work_model = self._attach_preview(base_model, node_id, vae, audio_vae, preview_max_res,
                                              preview_jpeg_quality, preview_frames, preview_fps,
                                              tiny_vae=preview_tiny_vae)

        # The preview wrapper lives on a model clone; a connected guider still points at the
        # original patcher, so hand the sampler a shallow guider copy that uses the wrapped clone.
        sample_guider = guider
        if guider is not None and base_model is not None and work_model is not base_model:
            try:
                sample_guider = copy.copy(guider)
                sample_guider.model_patcher = work_model
            except Exception as e:
                logging.warning(f"{_LOG} could not rebind the guider to the preview-wrapped model "
                                f"({type(e).__name__}: {e}); live preview may not appear this run.")
                sample_guider = guider

        out_latent, denoised = self._sample(work_model, positive, latent, sampler_name,
                                            scheduler, steps, steps_to_run, denoise, seed,
                                            noise, sample_guider, sampler, sigmas)

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


NODE_CLASS_MAPPINGS = {"NouganH3KSampler": NouganH3KSampler}
NODE_DISPLAY_NAME_MAPPINGS = {"NouganH3KSampler": "Nougan MiniMax H3 KSampler"}
