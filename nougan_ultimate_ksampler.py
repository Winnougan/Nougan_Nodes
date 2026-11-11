"""
Nougan Ultimate KSampler — one sampler node for everything, MiniMax H3 included.

model + conditioning + latent in; latent / image(video) / audio out.

CFG is a plain number:
  cfg > 0   -> classifier-free guidance (CFGGuider, needs negative).
  cfg == 0  -> CFG-free: positive-only BasicGuider at half the per-step cost.
               The right setting for CFG-distilled models (MiniMax H3 etc.).
No negative wired? The node quietly runs positive-only at any cfg.

SamplerCustomAdvanced-shaped inputs, all optional, each wins over what it replaces:
  guider  -> carries the model + conditioning; cfg / positive / negative are ignored.
  noise   -> replaces seed.
  sampler -> replaces sampler_name (built-in path only).
  sigmas  -> replaces scheduler / steps / denoise.
Without a guider, connect model + positive and the node builds the guider itself.

Sampler dropdown merges ComfyUI built-ins with RES4LYF (ClownsharK) samplers. Entries
prefixed "clown: " run through ClownsharKSampler_Beta (eta / sampler_mode / bongmath /
options apply; cfg == 0 becomes cfg = 1.0 there). Clown samplers need model + positive
and ignore wired guider / noise / sampler.

steps_to_run -> chainsampling: run only the FIRST N steps of the schedule and stop
partially denoised (-1 = all). Passed through to clown samplers; slices the schedule
on the built-in path.

vae / audio_vae -> decode into the IMAGE / AUDIO outputs (H3's nested AV latent is
split automatically; the audio half goes through LTXVAudioVAEDecode).

Live preview: the vendored Model Preview Override wrapper (nougan_preview_override.py)
rides the sampling model — including a model borrowed from a wired guider — so the DOM
panel + WebGPU progress bar (web/nougan_ultimate_ksampler.js) show every step.

Soft dependencies, resolved at call time: RES4LYF (clown samplers). Without it the node
still works as a plain KSampler + VAE decode. The preview is vendored in.
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
_CLOWN_PREFIX = "clown: "
_LOG = "[Nougan UltimateKSampler]"

# ───────────────────────── soft-dependency discovery ─────────────────────────

def _is_torch_ops(module_name, obj):
    """torch.ops fabricates dummy namespaces for any attribute; real targets are callable."""
    if module_name == "torch.ops" or module_name.startswith(("torch.ops.", "torch._ops", "torch._classes")):
        return True
    return obj is not None and not callable(obj)


def _find_in_modules(attr, name_hint=None):
    """Search already-imported custom-node modules for `attr` (no dependency on install folder names)."""
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
    """Baked-in preview wrapper wins; a live KJNodes install is only a fallback."""
    try:
        from .nougan_preview_override import _PreviewOverrideWrapper
        return _PreviewOverrideWrapper
    except Exception:
        pass
    return _find_in_modules("_PreviewOverrideWrapper", "preview_override_node")


def _tiny_vae_choices():
    try:
        return ["none"] + list(folder_paths.get_filename_list("vae_approx"))
    except Exception:
        return ["none"]


def _sampler_choices():
    return list(comfy.samplers.SAMPLER_NAMES) + [_CLOWN_PREFIX + n for n in _clown_sampler_names()]


def _scheduler_choices():
    out = ["none"] + list(comfy.samplers.SCHEDULER_NAMES)
    for n in _clown_scheduler_names():
        if n not in out:
            out.append(n)
    return out


def _guider_model_slot(guider):
    """(attribute_name, model_patcher) of the model inside a wired guider, whatever the
    guider class calls it. Core guiders use .model_patcher; custom packs may differ."""
    for attr in ("model_patcher", "model", "patcher", "_model_patcher"):
        mp = getattr(guider, attr, None)
        if mp is not None and hasattr(mp, "clone") and hasattr(mp, "add_wrapper_with_key"):
            return attr, mp
    return None, None

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
    args = result.args if hasattr(result, "args") else result
    return args[0]


def _decode_audio(audio_vae, latent):
    from comfy_extras.nodes_lt_audio import LTXVAudioVAEDecode
    return _first(LTXVAudioVAEDecode.execute(latent, audio_vae))


def _apply_steps_to_run(sigmas, steps_to_run):
    """RES4LYF chainsampler semantics: keep only the FIRST N steps (N >= 1);
    -1 (or N >= total) runs everything. Result is a partially denoised latent."""
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
                "steps": ("INT", {"default": 30, "min": 1, "max": 10000,
                                  "tooltip": "MiniMax H3 is distilled: its reference workflow uses ~8 steps."}),
                "steps_to_run": ("INT", {"default": -1, "min": -1, "max": 10000,
                                         "tooltip": "Chainsampling: run only the FIRST N steps of the schedule, then stop "
                                                    "partially denoised (a second sampler continues from there). -1 = all steps."}),
                "cfg": ("FLOAT", {"default": 5.5, "min": -100.0, "max": 100.0, "step": 0.01, "round": False,
                                  "tooltip": "Classifier-free guidance scale. 0 = CFG-free: positive-only sampling "
                                             "(BasicGuider) at half the per-step cost — use for CFG-distilled models "
                                             "like MiniMax H3. Ignored when a guider is wired, or when negative "
                                             "is unconnected (the node then runs positive-only at any cfg)."}),
                "denoise": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff,
                                 "tooltip": "Ignored when a NOISE input is connected."}),
                "eta": ("FLOAT", {"default": 0.5, "min": -100.0, "max": 100.0, "step": 0.01, "round": False,
                                  "tooltip": "Clown samplers only: noise added then removed after each step."}),
                "sampler_mode": (["standard", "unsample", "resample"], {
                    "default": "standard", "tooltip": "Clown samplers only.",
                }),
                "bongmath": ("BOOLEAN", {
                    "default": True, "label_on": "bongmath ON", "label_off": "bongmath OFF",
                    "tooltip": "Clown samplers only: RES4LYF's bongmath on/off.",
                }),
                "decode": ("BOOLEAN", {
                    "default": True, "label_on": "decode ON", "label_off": "decode OFF",
                    "tooltip": "Decode the result with the connected VAE(s). Off = latent only.",
                }),
                "tiled_decode": ("BOOLEAN", {"default": False}),
                "preview_fps": ("INT", {"default": 12, "min": 1, "max": 60, "step": 1,
                                        "tooltip": "Playback FPS of the live preview (ignored for clips with audio)."}),
            },
            "optional": {
                "model": ("MODEL", {"tooltip": "Used to build a guider when none is wired (and for sigmas + the live "
                                               "preview). Optional when a guider is connected — a guider carries its own model."}),
                "positive": ("CONDITIONING", {"tooltip": "Used to build the guider when none is wired. "
                                                         "Optional when a guider is connected."}),
                "negative": ("CONDITIONING", {"tooltip": "Leave unplugged for positive-only (CFG-free) sampling — "
                                                         "the node runs silently without it and cfg is ignored then."}),
                "guider": ("GUIDER", {"tooltip": "Custom guider (e.g. BasicGuider). Carries the model and conditioning, "
                                                 "so model/positive/negative/cfg are ignored while it's wired. "
                                                 "Built-in samplers only (clown samplers ignore it)."}),
                "noise": ("NOISE", {"tooltip": "Custom noise source (e.g. RandomNoise). Replaces the seed widget "
                                                "when connected (the widget hides itself)."}),
                "sampler": ("SAMPLER", {"tooltip": "Custom sampler (e.g. KSamplerSelect). Replaces sampler_name "
                                                  "when connected (the widget hides itself). Built-in path only."}),
                "sigmas": ("SIGMAS", {"tooltip": "Custom sigma schedule. Replaces scheduler / steps / denoise when connected."}),
                "vae": ("VAE", {"tooltip": "Video/image VAE: decodes the result into the IMAGE output and can drive the preview."}),
                "audio_vae": ("VAE", {"tooltip": "Audio VAE: decodes the audio half of an AV latent (e.g. MiniMax H3) "
                                                "into the AUDIO output and drives the spectrogram preview."}),
                "options": ("OPTIONS", {"tooltip": "RES4LYF options chain (clown samplers only)."}),
                "preview": ("BOOLEAN", {"default": True, "label_on": "preview ON", "label_off": "preview OFF"}),
                "preview_max_res": ("INT", {"default": 1024, "min": 0, "max": 8192, "step": 8}),
                "preview_frames": ("INT", {"default": 1, "min": 1, "max": 1024,
                                           "tooltip": "Frames per step for the animated video preview (1 = single frame)."}),
                "preview_jpeg_quality": ("INT", {"default": 80, "min": 30, "max": 100}),
                "preview_tiny_vae": (_tiny_vae_choices(), {
                    "default": "none",
                    "tooltip": "Tiny VAE decoder (models/vae_approx) for true-RGB previews. Needs the decoder code: "
                               "vendored tiny_vae.py or a KJNodes install.",
                }),
            },
            "hidden": {"unique_id": "UNIQUE_ID", "dynprompt": "DYNPROMPT"},
        }

    RETURN_TYPES = ("LATENT", "LATENT", "IMAGE", "AUDIO")
    RETURN_NAMES = ("latent", "denoised", "image", "audio")
    FUNCTION = "run"
    OUTPUT_NODE = True
    CATEGORY = "Nougan/sampling"
    DESCRIPTION = ("One sampler for everything, MiniMax H3 included. CFG is a number: 0 = CFG-free "
                   "(positive-only, half the per-step cost). No negative wired = positive-only at any cfg. "
                   "Optional guider / noise / sampler / sigmas inputs win over the widgets they replace; "
                   "without a guider, model + positive builds BasicGuider/CFGGuider automatically. "
                   "Built-in + clown (RES4LYF) samplers, chainsampling, VAE + audio-VAE decode, live preview.")

    # ───────────────────────────── preview wiring ─────────────────────────────
    @staticmethod
    def _attach_preview(model, node_id, vae, audio_vae, max_res, quality, frames, fps, tiny_vae="none"):
        cls = _kj_wrapper_class()
        if cls is None:
            logging.warning(f"{_LOG} preview wrapper unavailable (nougan_preview_override.py missing/broken and no KJNodes); "
                            f"using ComfyUI's default preview only.")
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

    def _sample_builtin(self, model, positive, negative, latent, sampler_name, scheduler, steps, cfg,
                        denoise, seed, sigmas, noise, guider, sampler, steps_to_run, cfg_free=False):
        """Guider-based run (SamplerCustomAdvanced-shaped), delegating to ComfyUI's own node
        classes. A wired NOISE / GUIDER / SAMPLER / SIGMAS input wins over the widgets."""
        from comfy_extras import nodes_custom_sampler as ncs
        if denoise <= 0 and sigmas is None:
            logging.info(f"{_LOG} denoise=0 — passing the latent through unchanged.")
            return latent, latent
        if noise is None:
            noise = _first(ncs.RandomNoise.execute(int(seed)))
        if guider is None:
            if not cfg_free and negative is not None:
                guider = _first(ncs.CFGGuider.execute(model, positive, negative, cfg))
            else:
                guider = _first(ncs.BasicGuider.execute(model, positive))
        sampler_obj = sampler if sampler is not None else _first(ncs.KSamplerSelect.execute(sampler_name))
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
    def run(self, latent_image, sampler_name, scheduler, steps, steps_to_run, cfg, denoise, seed,
            eta, sampler_mode, bongmath, decode, tiled_decode, preview_fps,
            model=None, positive=None, negative=None, guider=None, noise=None, sampler=None,
            sigmas=None, vae=None, audio_vae=None, options=None,
            preview=True, preview_max_res=1024, preview_frames=1, preview_jpeg_quality=80,
            preview_tiny_vae="none",
            unique_id=None, dynprompt=None):
        node_id = _display_id(unique_id, dynprompt)
        node_raw = str(unique_id)
        logging.info(f"{_LOG} run start: unique_id={unique_id!r} node_id={node_id!r} "
                     f"(dynprompt {'available' if dynprompt is not None else 'MISSING'})")
        _emit("nougan_uk_phase", {"node": node_id, "node_raw": node_raw, "phase": "sampling"})

        latent = latent_image
        is_clown = sampler_name.startswith(_CLOWN_PREFIX)

        # ---- guidance mode: cfg is a number, 0 means CFG-free ----
        cfg_free = (cfg == 0)
        if guider is not None and not is_clown:
            logging.info(f"{_LOG} guider connected — it carries the model and conditioning; cfg/positive/negative are ignored.")
        elif cfg_free:
            logging.info(f"{_LOG} cfg=0 — CFG-free positive-only sampling (negative ignored).")
        elif negative is None:
            logging.info(f"{_LOG} no negative connected — positive-only sampling this run (cfg ignored).")
            cfg_free = True

        if scheduler == "none":
            if sigmas is None:
                raise ValueError(f"{_LOG} scheduler is 'none' but no sigmas input is connected — "
                                 f"pick a scheduler, or wire a custom sigmas schedule.")
            scheduler = "beta"  # inert placeholder; the wired sigmas replace the schedule downstream
        if sigmas is not None:
            logging.info(f"{_LOG} sigmas input connected — it wins over the scheduler/steps/denoise widgets.")

        # ---- resolve which model the preview rides on, and validate ----
        guider_slot, guider_model = (None, None)
        sample_guider = None
        if is_clown:
            if guider is not None:
                logging.warning(f"{_LOG} clown samplers can't use a wired guider — ignoring it (model + positive are used).")
            if noise is not None or sampler is not None:
                logging.warning(f"{_LOG} clown samplers can't use wired noise/sampler — ignoring them (seed / sampler_name are used).")
            if model is None or positive is None:
                raise ValueError(f"{_LOG} clown samplers need model + positive connected "
                                 f"(a wired guider can't drive RES4LYF).")
            base_model = model
        else:
            if guider is not None:
                guider_slot, guider_model = _guider_model_slot(guider)
                sample_guider = guider
            base_model = guider_model if guider_model is not None else model
            if guider is None:
                if model is None:
                    raise ValueError(f"{_LOG} nothing to sample with: connect model, or wire a guider "
                                     f"(a guider carries its own model).")
                if positive is None:
                    raise ValueError(f"{_LOG} positive is required to build a guider: connect positive, "
                                     f"or wire a ready-made guider.")
            elif guider_model is None:
                # Opaque custom guider: we can't inject the preview wrapper into it.
                if base_model is None and sigmas is None:
                    raise ValueError(f"{_LOG} could not read the model out of the wired guider (custom guider class?) "
                                     f"and no model is connected — needed to build the sigma schedule. "
                                     f"Connect the model input, or wire sigmas (e.g. BasicScheduler).")
                if preview:
                    logging.warning(f"{_LOG} could not read the model out of the wired guider; live preview is OFF this run.")
                preview = False

        work_model = base_model
        if preview and base_model is not None:
            work_model = self._attach_preview(base_model, node_id, vae, audio_vae, preview_max_res,
                                              preview_jpeg_quality, preview_frames, preview_fps,
                                              tiny_vae=preview_tiny_vae)

        # The preview wrapper lives on a model clone; a wired guider still points at the
        # original patcher, so hand the sampler a shallow guider copy using the wrapped clone.
        if sample_guider is not None and guider_slot is not None and work_model is not base_model:
            try:
                g = copy.copy(sample_guider)
                setattr(g, guider_slot, work_model)
                sample_guider = g
            except Exception as e:
                logging.warning(f"{_LOG} could not rebind the guider to the preview-wrapped model "
                                f"({type(e).__name__}: {e}); live preview may not appear this run.")

        # ---- sample ----
        if is_clown:
            # Clown samplers have no guider concept; cfg=1.0 is the CFG-free equivalent there.
            out_latent, denoised = self._sample_clown(
                work_model, positive, negative if negative is not None else positive, latent,
                sampler_name, scheduler, steps, 1.0 if cfg_free else cfg, denoise, seed,
                eta, sampler_mode, bongmath, sigmas, options, steps_to_run=steps_to_run)
        else:
            out_latent, denoised = self._sample_builtin(
                work_model, positive, negative, latent, sampler_name, scheduler, steps, cfg,
                denoise, seed, sigmas, noise, sample_guider, sampler, steps_to_run, cfg_free=cfg_free)

        # ---- decode ----
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

# Optional: let old MiniMax H3 workflows load into the unified node instead of showing
# a missing-node error. Uncomment, then re-check widget values on those nodes.
# NODE_CLASS_MAPPINGS["NouganH3KSampler"] = NouganUltimateKSampler