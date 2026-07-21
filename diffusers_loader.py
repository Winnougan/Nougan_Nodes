# diffusers_loader.py
import json
import os
import torch
import folder_paths
import comfy.sd
import comfy.utils
import comfy.model_management


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_MODEL_DATA_INPUT = (
    "STRING",
    {"default": "{}", "multiline": True,
     "tooltip": "Managed by the Nougan Diffusers Loader UI."},
)

_DIFFUSERS_FILE_EXTS = (".safetensors", ".bin", ".gguf", ".ckpt", ".pt")


def first_file(path, filenames):
    if path is None or not os.path.exists(path):
        return None
    for f in filenames:
        p = os.path.join(path, f)
        if os.path.exists(p):
            return p
    return None


def _is_diffusers_folder(path: str) -> bool:
    if not os.path.isdir(path):
        return False
    try:
        entries = os.listdir(path)
    except OSError:
        return False
    low = {e.lower() for e in entries}
    if "unet" in low:
        return True
    if "model_index.json" in low:
        return True
    if any(e.lower().startswith("diffusion_pytorch_model") for e in entries):
        return True
    return False


def _roots():
    roots = []
    for name in ("unet", "diffusion_models", "diffusers"):
        try:
            roots.extend(folder_paths.get_folder_paths(name))
        except Exception:
            pass
    bases = []
    md = getattr(folder_paths, "models_dir", None)
    if md:
        bases.append(md)
    try:
        bases.append(os.path.join(folder_paths.get_user_directory(), "models"))
    except Exception:
        pass
    for cat in ("checkpoints", "loras", "vae", "clip"):
        try:
            for p in folder_paths.get_folder_paths(cat):
                bases.append(os.path.dirname(p))
        except Exception:
            pass
    for base in bases:
        for sub in ("diffusion_models", "unet", "diffusers"):
            roots.append(os.path.join(base, sub))
    seen, out = set(), []
    for r in roots:
        r = os.path.normpath(r)
        if r and r not in seen and os.path.isdir(r):
            seen.add(r)
            out.append(r)
    return out


def _scan():
    roots = _roots()
    found = {}
    for root in roots:
        for dirpath, dirnames, filenames in os.walk(root):
            rel = os.path.relpath(dirpath, root)
            if rel != "." and _is_diffusers_folder(dirpath):
                found.setdefault(rel.replace(os.sep, "/"), "folder")
                dirnames[:] = []
                continue
            for fn in filenames:
                if fn.lower().endswith(_DIFFUSERS_FILE_EXTS):
                    key = fn if rel == "." else os.path.join(rel, fn)
                    found.setdefault(key.replace(os.sep, "/"), "file")
    return roots, found


def _get_available_diffusers_models():
    roots, found = _scan()
    names = sorted(found.keys())
    print(f"[Nougan] Diffusers scan — {len(roots)} root(s): {roots}")
    print(f"[Nougan] Diffusers scan — {len(names)} entries found: "
          f"{names[:25]}{'…' if len(names) > 25 else ''}")
    return names


def _resolve(name: str):
    rel = str(name).replace("/", os.sep)
    for root in _roots():
        p = os.path.join(root, rel)
        if os.path.exists(p):
            return p
    return None


# ---------------------------------------------------------------------------
# Node  (attention patching removed — use ComfyUI's native --use-flash-attention
#        or KJNodes' Patch Sage Attention node instead)
# ---------------------------------------------------------------------------

class NouganDiffusersLoader:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model_name": (
                    _get_available_diffusers_models(),
                    {"tooltip": "Select the diffusers model folder or file."},
                ),
            },
            "optional": {
                "model_data": _MODEL_DATA_INPUT,
            },
        }

    RETURN_TYPES = ("MODEL", "CLIP", "VAE")
    RETURN_NAMES = ("MODEL", "CLIP", "VAE")
    FUNCTION = "load"
    CATEGORY = "loaders"
    TITLE = "Nougan Diffusers Loader"

    @classmethod
    def IS_CHANGED(cls, model_name, model_data="{}", **kw):
        return f"{model_name}_{model_data}"

    def load(self, model_name, model_data="{}"):
        cfg = {}
        if model_data and model_data.strip():
            try:
                cfg = json.loads(model_data)
            except json.JSONDecodeError:
                pass

        name = cfg.get("model_name", model_name) or model_name

        model_path = _resolve(name)
        if model_path is None:
            raise ValueError(f"[Nougan] Model '{name}' not found in any scanned root.")

        unet = clip = vae = None

        if os.path.isdir(model_path):
            dm_names = [
                "diffusion_pytorch_model.fp16.safetensors",
                "diffusion_pytorch_model.safetensors",
                "diffusion_pytorch_model.fp16.bin",
                "diffusion_pytorch_model.bin",
            ]
            unet_path = (
                first_file(os.path.join(model_path, "unet"), dm_names)
                or first_file(model_path, dm_names)
            )
            if unet_path is None:
                raise ValueError(f"[Nougan] No UNet file found in {model_path}")

            print(f"[Nougan] Loading UNet: {unet_path}")
            unet = comfy.sd.load_diffusion_model(unet_path)

            te_names = [
                "model.fp16.safetensors", "model.safetensors",
                "pytorch_model.fp16.bin", "pytorch_model.bin",
            ]
            te_paths = []
            te1 = first_file(os.path.join(model_path, "text_encoder"), te_names)
            te2 = first_file(os.path.join(model_path, "text_encoder_2"), te_names)
            if te1: te_paths.append(te1)
            if te2: te_paths.append(te2)
            if te_paths:
                print(f"[Nougan] Loading CLIP: {te_paths}")
                clip = comfy.sd.load_clip(te_paths, embedding_directory=None)

            vae_path = first_file(os.path.join(model_path, "vae"), dm_names)
            if vae_path:
                print(f"[Nougan] Loading VAE: {vae_path}")
                vae = comfy.sd.VAE(sd=comfy.utils.load_torch_file(vae_path))
        else:
            print(f"[Nougan] Loading unified model: {model_path}")
            unet = comfy.sd.load_diffusion_model(model_path)

        return (unet, clip, vae)
