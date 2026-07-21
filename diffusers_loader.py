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


def first_file(path, filenames):
    if path is None or not os.path.exists(path):
        return None
    for f in filenames:
        p = os.path.join(path, f)
        if os.path.exists(p):
            return p
    return None


def _candidate_dirs():
    """Every directory that may hold a diffusers model folder or a unet file.

    Combines ComfyUI's category mappings (so user overrides in
    extra_model_paths.yaml and user-dir models are honoured) with the *physical*
    default subfolders under each models root. Some ComfyUI builds don't list
    models/diffusion_models under the category strings we query, which silently
    hid models placed there — adding the physical dirs closes that gap.
    """
    dirs = []

    # 1) ComfyUI category mappings (covers extra_model_paths + user models dir)
    for name in ("diffusion_models", "unet", "diffusers"):
        try:
            dirs.extend(folder_paths.get_folder_paths(name))
        except Exception:
            pass

    # 2) Explicit physical subfolders under every known models root
    roots = []
    md = getattr(folder_paths, "models_dir", None)
    if md:
        roots.append(md)
    try:
        roots.append(os.path.join(folder_paths.get_user_directory(), "models"))
    except Exception:
        pass
    for cat in ("checkpoints", "loras"):        # last-resort: derive a models root
        try:
            for p in folder_paths.get_folder_paths(cat):
                roots.append(os.path.dirname(p))
        except Exception:
            pass
    for root in roots:
        for sub in ("diffusion_models", "unet", "diffusers"):
            dirs.append(os.path.join(root, sub))

    # dedupe (keep order); non-existent dirs are filtered at the use-site
    seen, out = set(), []
    for d in dirs:
        d = os.path.normpath(d)
        if d and d not in seen:
            seen.add(d)
            out.append(d)
    return out


def _get_available_diffusers_models():
    models = []
    for base in _candidate_dirs():
        if not os.path.isdir(base):
            continue
        for item in os.listdir(base):
            full = os.path.join(base, item)
            if os.path.isdir(full) or item.endswith(
                (".safetensors", ".ckpt", ".bin", ".gguf")
            ):
                models.append(item)
    return sorted(set(models))


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

        # ── resolve path (same dir list the dropdown was built from) ───
        model_path = None
        for base in _candidate_dirs():
            p = os.path.join(base, name)
            if os.path.exists(p):
                model_path = p
                break
        if model_path is None:
            raise ValueError(f"[Nougan] Model '{name}' not found.")

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
