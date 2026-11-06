# nougan_ultimate_loader.py — Nougan Ultimate Model Loader
# One node: diffusion model (bf16 / int8 / convrot w4a8-w6a8 / future w5a8 w3a8 via ComfyUI's
# native quant registry) + attention/efficiency backends + main & prompt-enhancer CLIPs
# + video/default VAE + optional audio VAE. DOM frontend: nougan_ultimate_loader.js
import logging
import torch

import folder_paths
import comfy.sd
import comfy.utils
import comfy.model_management

_LOG = "[Nougan.UML]"

MODEL_TYPES = ["default", "minimax_h3", "flux3", "moss"]
CLIP_DEVICES = ["default", "cpu"]

# Dense backend candidates, in priority order (first enabled switch that resolves wins).
# Candidate names are probed against ComfyUI's REGISTERED_ATTENTION_FUNCTIONS so the node
# survives registry renames across ComfyUI builds.
_BACKEND_CANDIDATES = [
    ("sage3",   ["sage3", "sageattn3", "sage_attention3"]),
    ("sage2",   ["sage", "sage2", "sageattn", "sage_attention"]),
    ("flash2",  ["flash", "flash2", "flash_attention", "flash_attn", "flash_attention2"]),
    ("kitchen", ["comfy_kitchen_int8", "comfy_kitchen", "kitchen_int8"]),
    ("pytorch", ["pytorch", "pytorch_attention", "sdpa"]),
]

# model_type -> CLIPType fallbacks when a clip "type" widget is left on "auto"
_MODEL_TYPE_CLIP_FALLBACKS = {
    "minimax_h3": ["MINIMAX_H3", "HUNYUAN_VIDEO"],
    "flux3":      ["FLUX2", "FLUX"],
    "moss":       ["STABLE_DIFFUSION"],
    "default":    ["STABLE_DIFFUSION"],
}


def _quant_choices():
    """'auto' + 'bf16' + every algo in ComfyUI's native quant registry (so w5a8/w3a8
    appear by themselves the day ComfyUI ships them)."""
    out = ["auto", "bf16"]
    try:
        import comfy.quant_ops as _q
        for k in sorted(getattr(_q, "QUANT_ALGOS", {}).keys()):
            if k not in out:
                out.append(k)
    except Exception:
        pass
    return out


def _clip_type_choices():
    names = []
    try:
        names = [m.name.lower() for m in comfy.sd.CLIPType]
    except Exception:
        names = ["stable_diffusion", "sd3", "flux", "mochi", "ltxv", "pixart", "cosmos",
                 "lumina2", "wan", "hidream", "chroma", "ace", "qwen_image", "hunyuan_video",
                 "minimax_h3", "kandinsky5"]
    preferred = ["stable_diffusion", "sd3", "flux", "minimax_h3", "hunyuan_video", "wan", "ltxv"]
    rest = sorted(n for n in set(names) if n not in preferred)
    return ["auto"] + [p for p in preferred if p in names] + rest


def _resolve_clip_type(widget_value, model_type):
    if widget_value and widget_value != "auto":
        ct = getattr(comfy.sd.CLIPType, widget_value.upper(), None)
        if ct is None:
            raise ValueError(f"{_LOG} unknown clip type '{widget_value}'. "
                             f"Available: {[m.name.lower() for m in comfy.sd.CLIPType]}")
        return ct
    for cand in _MODEL_TYPE_CLIP_FALLBACKS.get(model_type, ["STABLE_DIFFUSION"]):
        ct = getattr(comfy.sd.CLIPType, cand, None)
        if ct is not None:
            return ct
    return comfy.sd.CLIPType.STABLE_DIFFUSION


def _resolve_dense_backend(switches):
    """Return (switch_name, registry_name, function) or None."""
    import comfy.ldm.modules.attention as attn
    for switch_name, candidates in _BACKEND_CANDIDATES:
        if not switches.get(switch_name):
            continue
        for reg_name in candidates:
            fn = attn.get_attention_function(reg_name, None)
            if fn is not None:
                return switch_name, reg_name, fn
        logging.warning(f"{_LOG} '{switch_name}' is switched on but no matching attention "
                        f"backend is registered in this ComfyUI build — skipping it.")
    return None


def _enable_triton_backend():
    try:
        from comfy.cli_args import args
        if not getattr(args, "enable_triton_backend", False):
            args.enable_triton_backend = True
            logging.info(f"{_LOG} triton backend ENABLED (comfy-kitchen quant ops opt-in, global for this session).")
        else:
            logging.info(f"{_LOG} triton backend already enabled.")
    except Exception as e:
        logging.warning(f"{_LOG} could not flip enable_triton_backend: {e}")


def _apply_sparse(model, vsa, model_type):
    try:
        from comfy_extras.nodes_sparse_attention import apply_block_sparse_attention
    except Exception as e:
        raise RuntimeError(f"{_LOG} this ComfyUI build has no comfy_extras.nodes_sparse_attention "
                           f"(needed for the sparseattention/vsa switches): {e}")
    if vsa and model_type != "minimax_h3":
        logging.warning(f"{_LOG} VSA is a MiniMax-H3 sparse pattern — model_type is '{model_type}'. "
                        f"The core patcher will refuse non-H3 models.")
    logging.info(f"{_LOG} applying {'VSA (video sparse attention)' if vsa else 'block-sparse attention (sol-attn)'}")
    return apply_block_sparse_attention(
        model, tau=1.3, topk_ratio=0.0, vsa=vsa,
        start_percent=0.2, end_percent=1.0, min_tokens=12288,
        dense_blocks=set(), sink_conditioning="exact_kv_and_rows",
        extra_tokens=0 if vsa else 256, verbose=False)


def _clip_model_options(device):
    if device == "cpu":
        return {"load_device": torch.device("cpu"), "offload_device": torch.device("cpu")}
    return {}


def _load_one_clip(name, clip_type, device, label):
    if not name:
        return None
    path = folder_paths.get_full_path_or_raise("text_encoders", name)
    ct = _resolve_clip_type(clip_type, "default")
    clip = comfy.sd.load_clip(
        ckpt_paths=[path],
        embedding_directory=(folder_paths.get_folder_paths("embeddings")[0]
                             if folder_paths.get_folder_paths("embeddings") else None),
        clip_type=ct,
        model_options=_clip_model_options(device),
    )
    logging.info(f"{_LOG} {label}: '{name}' (type={ct.name.lower()}, device={device})")
    return clip


def _load_vae(name, label):
    path = folder_paths.get_full_path_or_raise("vae", name)
    sd = comfy.utils.load_torch_file(path)
    vae = comfy.sd.VAE(sd=sd)
    logging.info(f"{_LOG} {label}: '{name}' loaded.")
    return vae


class NouganUltimateModelLoader:
    """All-in-one loader: quantized diffusion model + attention backends + 2 CLIPs + 2 VAEs."""

    CATEGORY = "Nougan/Loaders"
    FUNCTION = "load"
    RETURN_TYPES = ("MODEL", "CLIP", "CLIP", "VAE", "VAE")
    RETURN_NAMES = ("MODEL", "CLIP (main)", "CLIP (enhancer)", "VAE (video/default)", "VAE (audio)")
    OUTPUT_TOOLTIPS = (
        "Diffusion model, patched with the chosen efficiency backends.",
        "Main text encoder for the diffusion model.",
        "Second text encoder (e.g. prompt enhancer) — None while its switch is off.",
        "Video/default VAE (image VAE for image models, video VAE for MiniMax-H3 etc.).",
        "Audio VAE — None while its switch is off.",
    )
    DESCRIPTION = ("Loads any diffusers/UNET checkpoint (bf16, int8 convrot, w6a8/w4a8 convrot, "
                   "and new w*a8 formats as ComfyUI adds them), applies attention/efficiency "
                   "backends, and loads up to two CLIPs plus video/default and audio VAEs.")

    @classmethod
    def INPUT_TYPES(cls):
        try:
            unets = folder_paths.get_filename_list("diffusion_models")
        except Exception:
            unets = []
        try:
            clips = folder_paths.get_filename_list("text_encoders")
        except Exception:
            clips = []
        try:
            vaes = folder_paths.get_filename_list("vae")
        except Exception:
            vaes = []
        clip_types = _clip_type_choices()
        return {
            "required": {
                # ── MODEL ────────────────────────────────────────────────────────
                "model_name": (unets, {"tooltip": "Diffusion model / UNET from the diffusers (diffusion_models) folder."}),
                "quant_format": (_quant_choices(), {
                    "default": "auto",
                    "tooltip": "Expected weight format. 'auto' trusts the checkpoint's embedded quant metadata "
                               "(int8 / w6a8 / w4a8 convrot etc. are detected automatically). Pick a format to "
                               "validate it after load — you'll get a warning if the file doesn't match."}),
                "model_type": (MODEL_TYPES, {"default": "default", "tooltip": "Preset family — drives 'auto' CLIP types and guards (VSA needs minimax_h3)."}),
                # ── EFFICIENCIES ────────────────────────────────────────────────
                "kitchen": ("BOOLEAN", {"default": True, "label_on": "comfy-kitchen", "label_off": "comfy-kitchen",
                                        "tooltip": "comfy-kitchen INT8 attention (dense backend candidate)."}),
                "sage2": ("BOOLEAN", {"default": False, "label_on": "sageattention 2", "label_off": "sageattention 2",
                                      "tooltip": "SageAttention 2 (dense backend candidate). Beats comfy-kitchen in priority."}),
                "sage3": ("BOOLEAN", {"default": False, "label_on": "sageattention 3", "label_off": "sageattention 3",
                                      "tooltip": "SageAttention 3 (Blackwell; dense backend candidate). Highest priority."}),
                "triton": ("BOOLEAN", {"default": False, "label_on": "triton", "label_off": "triton",
                                       "tooltip": "Opt into ComfyUI's triton backend for comfy-kitchen quant ops "
                                                  "(global session flag, like --enable-triton-backend)."}),
                "flash2": ("BOOLEAN", {"default": False, "label_on": "flashattention 2", "label_off": "flashattention 2",
                                       "tooltip": "FlashAttention 2 (dense backend candidate)."}),
                "pytorch": ("BOOLEAN", {"default": False, "label_on": "pytorch", "label_off": "pytorch",
                                        "tooltip": "Force PyTorch SDPA attention explicitly (dense backend candidate)."}),
                "sparse": ("BOOLEAN", {"default": False, "label_on": "sparseattention", "label_off": "sparseattention",
                                       "tooltip": "Block-sparse attention (sol-attn) on eligible layers; wraps the dense backend. "
                                                  "Long sequences only — short ones stay dense."}),
                "vsa": ("BOOLEAN", {"default": False, "label_on": "vsa", "label_off": "vsa",
                                    "tooltip": "Video Sparse Attention (FastH3) — MiniMax-H3 only; conflicts with sparseattention."}),
                # ── CLIPS ───────────────────────────────────────────────────────
                "clip1_name": (clips, {"tooltip": "Main text encoder (from text_encoders folder)."}),
                "clip1_type": (clip_types, {"default": "auto", "tooltip": "'auto' infers from the model type selector."}),
                "clip1_device": (CLIP_DEVICES, {"default": "default", "tooltip": "'cpu' pins this encoder to system RAM."}),
                "clip2_enabled": ("BOOLEAN", {"default": False, "label_on": "prompt enhancer clip", "label_off": "prompt enhancer clip",
                                              "tooltip": "Load a second CLIP (e.g. for a prompt enhancer chain)."}),
                "clip2_name": (clips, {"tooltip": "Second text encoder — used when its switch is on."}),
                "clip2_type": (clip_types, {"default": "auto"}),
                "clip2_device": (CLIP_DEVICES, {"default": "default"}),
                # ── VAEs ────────────────────────────────────────────────────────
                "vae_name": (vaes, {"tooltip": "Video/default VAE: the image VAE for image models, the video VAE for MiniMax-H3."}),
                "audio_vae_enabled": ("BOOLEAN", {"default": False, "label_on": "audio vae", "label_off": "audio vae",
                                                  "tooltip": "Also load an audio VAE (MiniMax-H3 audio, LTX-2, ...)."}),
                "audio_vae_name": (vaes, {"tooltip": "Audio VAE file — used when its switch is on."}),
                # ── section headings / order (edited by the DOM frontend) ───────
                "heading_model": ("STRING", {"default": "Model"}),
                "heading_engine": ("STRING", {"default": "Efficiencies"}),
                "heading_clips": ("STRING", {"default": "Text Encoders"}),
                "heading_vaes": ("STRING", {"default": "VAEs"}),
                "section_order": ("STRING", {"default": "model,engine,clips,vaes"}),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    @classmethod
    def VALIDATE_INPUTS(cls, **_kwargs):
        return True

    def load(self, model_name, quant_format, model_type,
             kitchen, sage2, sage3, triton, flash2, pytorch, sparse, vsa,
             clip1_name, clip1_type, clip1_device,
             clip2_enabled, clip2_name, clip2_type, clip2_device,
             vae_name, audio_vae_enabled, audio_vae_name,
             heading_model="Model", heading_engine="Efficiencies",
             heading_clips="Text Encoders", heading_vaes="VAEs",
             section_order="model,engine,clips,vaes", unique_id=None):

        logging.info(f"{_LOG} load: model='{model_name}' quant={quant_format} type={model_type} "
                     f"node={unique_id!r}")

        if sparse and vsa:
            raise ValueError(f"{_LOG} sparseattention and vsa are both on — they conflict. "
                             f"Pick one (VSA is for MiniMax-H3/FastH3 weights).")

        # ── triton opt-in (affects how the quant layers below are built) ────────
        if triton:
            _enable_triton_backend()

        # ── diffusion model ─────────────────────────────────────────────────────
        try:
            model_path = folder_paths.get_full_path_or_raise("diffusion_models", model_name)
        except Exception:
            model_path = folder_paths.get_full_path_or_raise("unet", model_name)
        model = comfy.sd.load_diffusion_model(model_path, model_options={})
        logging.info(f"{_LOG} diffusion model '{model_name}' loaded.")

        # ── quant validation (detection itself already happened inside the load) ─
        detected = None
        try:
            detected = (model.model_options or {}).get("quantization_metadata")
        except Exception:
            pass
        import json as _json
        flat = _json.dumps(detected, default=str) if detected else ""
        algos = []
        try:
            import comfy.quant_ops as _q
            algos = [a for a in getattr(_q, "QUANT_ALGOS", {}) if a in flat]
        except Exception:
            pass
        det_names = algos or (["metadata present"] if flat else [])
        if quant_format == "bf16":
            if flat:
                logging.warning(f"{_LOG} quant_format is 'bf16' but the checkpoint carries quant metadata "
                                f"({', '.join(det_names)}) — it loaded as a quantized model.")
            else:
                logging.info(f"{_LOG} quant check: bf16 ✓ (no quant metadata).")
        elif quant_format != "auto":
            if not flat:
                logging.warning(f"{_LOG} quant_format '{quant_format}' selected but the checkpoint has NO quant "
                                f"metadata — it loaded as a plain (bf16/fp16) model.")
            elif quant_format not in flat:
                logging.warning(f"{_LOG} quant_format '{quant_format}' selected, checkpoint reports "
                                f"{det_names or 'unknown metadata'} — ComfyUI used the checkpoint's own metadata.")
            else:
                logging.info(f"{_LOG} quant check: '{quant_format}' ✓")
        else:
            logging.info(f"{_LOG} quant auto-detect: {', '.join(det_names) if det_names else 'none (bf16/fp16 weights)'}")

        # ── dense attention backend ─────────────────────────────────────────────
        switches = {"kitchen": kitchen, "sage2": sage2, "sage3": sage3,
                    "flash2": flash2, "pytorch": pytorch}
        chosen = _resolve_dense_backend(switches)
        if chosen is not None:
            switch_name, reg_name, fn = chosen
            model = model.clone()
            model.set_model_optimized_attention(fn)
            logging.info(f"{_LOG} dense attention backend: '{reg_name}' (via {switch_name})")
        else:
            logging.info(f"{_LOG} no dense backend switch resolved — model keeps ComfyUI's default attention.")

        # ── sparse attention / VSA (wraps whatever dense backend is in place) ───
        if sparse or vsa:
            model = _apply_sparse(model, vsa=vsa, model_type=model_type)

        # ── CLIPs ───────────────────────────────────────────────────────────────
        clip1 = _load_one_clip(clip1_name, clip1_type if clip1_type != "auto" else _auto_type_for(model_type),
                               clip1_device, "CLIP (main)")
        clip2 = None
        if clip2_enabled:
            clip2 = _load_one_clip(clip2_name, clip2_type if clip2_type != "auto" else _auto_type_for(model_type),
                                   clip2_device, "CLIP (enhancer)")
        else:
            logging.info(f"{_LOG} prompt-enhancer CLIP off — second CLIP output is None.")

        # ── VAEs ────────────────────────────────────────────────────────────────
        vae = _load_vae(vae_name, "VAE (video/default)")
        audio_vae = None
        if audio_vae_enabled:
            audio_vae = _load_vae(audio_vae_name, "VAE (audio)")
        else:
            logging.info(f"{_LOG} audio VAE off — audio VAE output is None.")

        # ── status ping for the DOM panel ───────────────────────────────────────
        try:
            from server import PromptServer
            PromptServer.instance.send_sync("nougan_uml_status", {
                "node": unique_id,
                "model": model_name,
                "quant_detected": det_names,
                "backend": chosen[1] if chosen else None,
                "sparse": bool(sparse), "vsa": bool(vsa),
                "clip2": bool(clip2_enabled), "audio_vae": bool(audio_vae_enabled),
            })
        except Exception:
            pass

        logging.info(f"{_LOG} done: MODEL + main CLIP{' + enhancer CLIP' if clip2 else ''} "
                     f"+ VAE{' + audio VAE' if audio_vae else ''}.")
        return (model, clip1, clip2, vae, audio_vae)


def _auto_type_for(model_type):
    """Return the resolved 'auto' clip type as a lowercase string for _resolve_clip_type."""
    for cand in _MODEL_TYPE_CLIP_FALLBACKS.get(model_type, ["STABLE_DIFFUSION"]):
        if getattr(comfy.sd.CLIPType, cand, None) is not None:
            return cand.lower()
    return "stable_diffusion"


NODE_CLASS_MAPPINGS = {"NouganUltimateModelLoader": NouganUltimateModelLoader}
NODE_DISPLAY_NAME_MAPPINGS = {"NouganUltimateModelLoader": "Nougan Ultimate Model Loader 🚀"}
