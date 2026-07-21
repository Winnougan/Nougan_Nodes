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

# File extensions that may be a single-file UNet / diffusion model.
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
    """True if `path` looks like a HuggingFace/Diffusers model directory."""
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
    """Every directory that may contain a diffusers model folder or unet file.

    Union of: ComfyUI category mappings (unet + diffusion_models + diffusers, so
    extra_model_paths.yaml overrides are honoured) AND the physical default
    subfolders derived from the real models root (so a folder that is only
    registered under a different category key — a common cause of 'invisible'
    models — is still scanned).
    """
    roots = []

    # 1) category mappings
    for name in ("unet", "diffusion_models", "diffusers"):
        try:
            roots.extend(folder_paths.get_folder_paths(name))
        except Exception:
            pass

    # 2) physical subfolders under every models root we can discover
    bases = []
    md = getattr(folder_paths, "models_dir", None)
    if md:
        bases.append(md)
    try:
        bases.append(os.path.join(folder_paths.get_user_directory(), "models"))
    except Exception:
        pass
    for cat in ("checkpoints", "loras", "vae", "clip"):   # derive a models root
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
    """Recursively find models. Returns (roots, found) where found maps a
    slash-normalised relative path -> 'folder' | 'file'. Diffusers folders are
    detected by signature and pruned (we don't descend into them, so their
    internal unet/vae files never show up as standalone models)."""
    roots = _roots()
    found = {}
    for root in roots:
        for dirpath, dirnames, filenames in os.walk(root):
            rel = os.path.relpath(dirpath, root)
            if rel != "." and _is_diffusers_folder(dirpath):
                found.setdefault(rel.replace(os.sep, "/"), "folder")
                dirnames[:] = []          # prune — don't list its internals
                continue
            for fn in filenames:
                if fn.lower().endswith(_DIFFUSERS_FILE_EXTS):
                    key = fn if rel == "." else os.path.join(rel, fn)
                    found.setdefault(key.replace(os.sep, "/"), "file")
    return roots, found


def _get_available_diffusers_models():
    roots, found = _scan()
    names = sorted(found.keys())
    # ── diagnostics: proves the new code is loaded and shows exactly what
    #    was scanned, so a miss is debuggable from the console in one look. ──
    print(f"[Nougan] Diffusers scan — {len(roots)} root(s): {roots}")
    print(f"[Nougan] Diffusers scan — {len(names)} entr{'y' if len(names)==1 else 'ies'} found: {names[:25]}{'…' if len(names) > 25 else ''}")
    return names


def _resolve(name: str):
    """Resolve a dropdown entry (relative path) back to a real path, trying
    every root in the same order the scan used."""
    rel = str(name).replace("/", os.sep)
    for root in _roots():
        p = os.path.join(root, rel)
        if os.path.exists(p):
            return p
    return None


def _apply_attention_patches(model, sage_ver, flash_ver):
    if sage_ver == "None" and flash_ver == "None":
        return model

    print(f"[Nougan] Applying attention patches: Sage={sage_ver}, Flash={flash_ver}")

    def _patch(m, func, name):
        if hasattr(m, "set_model_attn1_patch"):
            m.set_model_attn1_patch(func)
            m.set_model_attn2_patch(func)
            print(f"[Nougan] ✅ Patched attn1 + attn2 with {name}")
        else:
            print(f"[Nougan] ❌ Model does not support attention patching ({name})")

    if sage_ver != "None":
        try:
            from sageattention import sageattn
            _patch(model, sageattn, sage_ver)
        except ImportError:
            print(f"[Nougan] ⚠️ {sage_ver} selected but 'sageattention' not installed.")
        except Exception as e:
            print(f"[Nougan] ❌ {sage_ver} failed: {e}")

    if flash_ver != "None":
        try:
            from flash_attn import flash_attn_func
            _patch(model, flash_attn_func, flash_ver)
        except ImportError:
            print(f"[Nougan] ⚠️ {flash_ver} selected but 'flash-attn' not installed.")
        except Exception as e:
            print(f"[Nougan] ❌ {flash_ver} failed: {e}")

    return model


# ---------------------------------------------------------------------------
# Node
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
                "sageattention_version": (
                    ["None", "SageAttention 2", "SageAttention 3"],
                    {"default": "None",
                     "tooltip": "SageAttention version. Requires: pip install sageattention"},
                ),
                "flashattention_version": (
                    ["None", "FlashAttention 2", "FlashAttention 3", "FlashAttention 4"],
                    {"default": "None",
                     "tooltip": "FlashAttention version. Requires: pip install flash-attn"},
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
    def IS_CHANGED(cls, model_name, sageattention_version,
                   flashattention_version, model_data="{}", **kw):
        return f"{model_name}_{sageattention_version}_{flashattention_version}_{model_data}"

    def load(self, model_name, sageattention_version,
             flashattention_version, model_data="{}"):

        cfg = {}
        if model_data and model_data.strip():
            try:
                cfg = json.loads(model_data)
            except json.JSONDecodeError:
                pass

        name  = cfg.get("model_name", model_name) or model_name
        sage  = cfg.get("sageattention_version", sageattention_version)
        flash = cfg.get("flashattention_version", flashattention_version)

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

        if unet is not None:
            unet = _apply_attention_patches(unet, sage, flash)

        return (unet, clip, vae)
