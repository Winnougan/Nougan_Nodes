"""
Nougan Flux 3 RefMod

Reusable character / reference files for FLUX.3 (natively reference-capable in ComfyUI).

  Nougan Flux 3 RefMod Bake   images + Flux VAE -> ONE file in models/refmods/<subfolder>/<name>.safetensors
  Nougan Flux 3 RefMod Apply  conditioning in -> conditioning out, with baked RefMods attached

Why this one is the simple one
------------------------------
ComfyUI's Flux 3 DiT has a dedicated `image_cond` stream for reference latents and its text
encoder (Qwen3-VL-4B) is text-only. So no model patch, no edit LoRA and no second copy of the
image for the text encoder: a RefMod is just the VAE latent, attached to the conditioning
exactly as core's "Set Reference Multi Latent" does:

    conditioning["reference_latents"] += [vae.encode(reference), ...]   (positive and negative)

Each baked reference stores one tensor, lat_i : float32 [1, 128, H/16, W/16] (raw vae.encode()
output; ComfyUI applies process_latent_in at sample time).

File format is NOT the H3 / Qwen / MOSS / Krea 2 format; metadata key `nougan_flux3` marks these files.
"""

import json
import math
import ntpath
import os
import re
import tempfile

import torch
from safetensors import safe_open
from safetensors.torch import save_file

import comfy.model_management
import comfy.utils
import folder_paths
import node_helpers

FORMAT = "nougan_flux3_refmod"
META_KEY = "nougan_flux3"
LATENT_CHANNELS = 128     # Flux2/Flux3 latent format
MAX_REFS = 16
DEFAULT_SUBFOLDER = "flux3"
NONE = "None"
_RESERVED = {"..", ".", "graph_presets", ".git", "__pycache__"}

# ── ref_strength: how long the references stay active ────────────────────────
# Not an amplitude: the references steer the first `ref_strength` of the denoise,
# then the plain prompt (same text conditioning, no reference latents) finishes it.
REF_STRENGTH_TIP = ("How long the references stay active, as a fraction of the denoising steps counted from the start. "
                    "1.0 = every step (default, same as before). 0.6 = the references steer the first 60% of the steps, "
                    "then the prompt alone finishes. 0 = references off. Lower = looser likeness and more prompt freedom.")


def _schedule(with_refs, without_refs, strength):
    """Conditioning list: `with_refs` for the first `strength` of the sampling, `without_refs` after."""
    if strength >= 1.0:
        return with_refs
    if strength <= 0.0:
        return without_refs
    head = node_helpers.conditioning_set_values(with_refs, {"start_percent": 0.0, "end_percent": strength})
    tail = node_helpers.conditioning_set_values(without_refs, {"start_percent": strength, "end_percent": 1.0})
    return head + tail


# ── folders ──────────────────────────────────────────────────────────────────

def _roots():
    try:
        roots = list(folder_paths.get_folder_paths("refmods"))
    except KeyError:
        roots = []
    return roots or [os.path.join(folder_paths.models_dir, "refmods")]


def _save_path(name, subfolder):
    name = re.sub(r"[^\w\- .]", "_", (name or "").strip()).strip(". ")
    if not name:
        raise ValueError("Give the RefMod a name.")
    relative = "/".join(p for p in (subfolder.replace("\\", "/").strip("/"), name) if p)
    if (ntpath.splitdrive(relative)[0] or relative.startswith("/")
            or any(p in _RESERVED for p in relative.split("/"))):
        raise ValueError("Use a relative subfolder without '..' or reserved directories.")
    root = os.path.realpath(_roots()[0])
    path = os.path.join(root, relative) + ".safetensors"
    if os.path.commonpath((root, os.path.realpath(path))) != root:
        raise ValueError("RefMod save path leaves the model folder.")
    return path


def _read_meta(path):
    try:
        with safe_open(path, framework="pt", device="cpu") as f:
            raw = (f.metadata() or {}).get(META_KEY)
        data = json.loads(raw) if raw else None
    except Exception:
        return None
    return data if isinstance(data, dict) and data.get("format") == FORMAT else None


_LIST_CACHE = {}  # path -> (mtime, is_flux3_refmod)


def list_refmods():
    """Relative names (no extension, forward slashes) of every Flux 3 RefMod on disk."""
    found = []
    for root in _roots():
        if not os.path.isdir(root):
            continue
        for folder, dirs, files in os.walk(root):
            dirs[:] = [d for d in dirs if d not in _RESERVED]
            for fn in files:
                if not fn.lower().endswith(".safetensors"):
                    continue
                path = os.path.join(folder, fn)
                try:
                    mtime = os.path.getmtime(path)
                except OSError:
                    continue
                hit = _LIST_CACHE.get(path)
                if hit is None or hit[0] != mtime:
                    hit = (mtime, _read_meta(path) is not None)
                    _LIST_CACHE[path] = hit
                if hit[1]:
                    rel = os.path.relpath(path, root)[:-len(".safetensors")]
                    found.append(rel.replace(os.sep, "/"))
    return sorted(set(found), key=str.lower)


def _resolve(rel):
    for root in _roots():
        path = os.path.join(root, rel) + ".safetensors"
        if os.path.isfile(path):
            return path
    raise FileNotFoundError(f"Flux 3 RefMod '{rel}' not found. Refresh the node list.")


def load_refmod(rel):
    """-> list of latents [1,128,h,w] float32."""
    path = _resolve(rel)
    meta = _read_meta(path)
    if meta is None:
        raise ValueError(f"'{rel}' is not a Nougan Flux 3 RefMod.")
    lats = []
    with safe_open(path, framework="pt", device="cpu") as f:
        for i in range(int(meta["count"])):
            lat = f.get_tensor(f"lat_{i}").float()
            if lat.ndim != 4 or lat.shape[0] != 1 or lat.shape[1] != LATENT_CHANNELS or min(lat.shape[2:]) < 1:
                raise ValueError(f"'{rel}' reference {i} has an invalid layout.")
            lats.append(lat)
    return lats


# ── encoding (mirrors core "Set Reference Multi Latent") ─────────────────────

def _encode_frame(frame, vae, megapixels):
    """frame [1,H,W,C] -> latent. megapixels > 0 resizes (lanczos, both ways) like core; 0 keeps size."""
    image = frame[:1][..., :3]
    if megapixels > 0:
        h, w = image.shape[1:3]
        scale = math.sqrt(megapixels * 1024 * 1024 / (w * h))
        nw, nh = max(1, round(w * scale)), max(1, round(h * scale))
        if (nw, nh) != (w, h):
            image = comfy.utils.common_upscale(image.movedim(-1, 1), nw, nh, "lanczos", "disabled").movedim(1, -1)
    lat = vae.encode(image)
    if lat.ndim != 4 or lat.shape[1] != LATENT_CHANNELS:
        raise ValueError(
            f"Expected a Flux 3 latent with {LATENT_CHANNELS} channels, got {tuple(lat.shape)}. "
            "Connect the Flux 2/3 VAE.")
    return lat


def _frames(*batches):
    out = []
    for batch in batches:
        if batch is not None:
            out.extend(batch[i:i + 1] for i in range(batch.shape[0]))
    return out


# ═════════════════════════════════════════════════════════════════════════════
#  Bake
# ═════════════════════════════════════════════════════════════════════════════

class NouganFlux3RefModBake:
    CATEGORY = "Nougan/RefMod"
    FUNCTION = "bake"
    OUTPUT_NODE = True
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("path",)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE", {"tooltip": f"Every frame in the batch becomes one reference (max {MAX_REFS})."}),
                "vae": ("VAE", {"tooltip": "The Flux 2 / Flux 3 VAE."}),
                "name": ("STRING", {"default": "my_character"}),
                "megapixels": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 16.0, "step": 0.01,
                                         "tooltip": "Target size of each reference, aspect preserved (1.0 = about "
                                                    "1024x1024). Every reference adds tokens to every step. "
                                                    "0 keeps each image's own size."}),
                "subfolder": ("STRING", {"default": DEFAULT_SUBFOLDER}),
                "overwrite": ("BOOLEAN", {"default": False}),
            },
            "optional": {
                "image_2": ("IMAGE",), "image_3": ("IMAGE",), "image_4": ("IMAGE",),
            },
        }

    def bake(self, images, vae, name, megapixels, subfolder, overwrite,
             image_2=None, image_3=None, image_4=None):
        frames = _frames(images, image_2, image_3, image_4)
        if not frames:
            raise ValueError("No images to bake.")
        if len(frames) > MAX_REFS:
            raise ValueError(f"{len(frames)} references; at most {MAX_REFS} per RefMod.")
        path = _save_path(name, subfolder)
        if os.path.exists(path) and not overwrite:
            note = (f"{os.path.basename(path)} already exists, skipped. "
                    "Enable overwrite to re-bake, or pick another name.")
            return {"ui": {"text": [note]}, "result": (path,)}

        tensors = {}
        for i, frame in enumerate(frames):
            lat = _encode_frame(frame, vae, megapixels)
            tensors[f"lat_{i}"] = lat.detach().cpu().float().contiguous().clone()

        meta = {"format": FORMAT, "version": 1, "name": os.path.basename(path)[:-len(".safetensors")],
                "count": len(frames), "latent_channels": LATENT_CHANNELS,
                "shapes": [list(tensors[f"lat_{i}"].shape) for i in range(len(frames))],
                "megapixels": float(megapixels)}
        directory = os.path.dirname(path)
        os.makedirs(directory, exist_ok=True)
        fd, tmp = tempfile.mkstemp(prefix=".refmod-", suffix=".tmp", dir=directory)
        os.close(fd)
        try:
            save_file(tensors, tmp, metadata={META_KEY: json.dumps(meta)})
            os.replace(tmp, path)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)
        _LIST_CACHE.pop(path, None)
        return {"ui": {"text": [f"Baked {len(frames)} reference(s) -> {path}"]}, "result": (path,)}


# ═════════════════════════════════════════════════════════════════════════════
#  Apply (conditioning in -> conditioning out)
# ═════════════════════════════════════════════════════════════════════════════

class NouganFlux3RefModApply:
    CATEGORY = "Nougan/RefMod"
    FUNCTION = "apply"
    RETURN_TYPES = ("CONDITIONING", "CONDITIONING", "LATENT")
    RETURN_NAMES = ("positive", "negative", "empty_latent")

    @classmethod
    def INPUT_TYPES(cls):
        names = [NONE] + list_refmods()
        return {
            "required": {
                "positive": ("CONDITIONING",),
                "refmod_1": (names,),
            },
            "optional": {
                "negative": ("CONDITIONING",),
                "refmod_2": (names,),
                "refmod_3": (names,),
                "extra_image": ("IMAGE", {"tooltip": "Optional plain reference(s), encoded on the fly. Needs the VAE."}),
                "vae": ("VAE", {"tooltip": "Only needed for extra_image."}),
                "extra_image_megapixels": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 16.0, "step": 0.01}),
                "ref_strength": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01, "tooltip": REF_STRENGTH_TIP}),
            },
        }

    @classmethod
    def IS_CHANGED(cls, refmod_1=NONE, refmod_2=NONE, refmod_3=NONE, **kwargs):
        stamp = []
        for rel in (refmod_1, refmod_2, refmod_3):
            if rel and rel != NONE:
                try:
                    stamp.append(str(os.path.getmtime(_resolve(rel))))
                except (OSError, FileNotFoundError):
                    stamp.append("missing")
        return "|".join(stamp)

    @classmethod
    def VALIDATE_INPUTS(cls, **kwargs):
        return True  # combo lists are rebuilt on refresh; missing files raise a clear error at run time

    def apply(self, positive, refmod_1, negative=None, refmod_2=NONE, refmod_3=NONE,
              extra_image=None, vae=None, extra_image_megapixels=1.0, ref_strength=1.0):
        ref_latents = []
        for rel in (refmod_1, refmod_2, refmod_3):
            if rel and rel != NONE:
                ref_latents.extend(load_refmod(rel))

        if extra_image is not None:
            if vae is None:
                raise ValueError("Connect the Flux VAE to encode extra_image.")
            for frame in _frames(extra_image):
                ref_latents.append(_encode_frame(frame, vae, extra_image_megapixels))

        if len(ref_latents) > MAX_REFS:
            raise ValueError(f"{len(ref_latents)} references in total; at most {MAX_REFS}.")

        device = comfy.model_management.intermediate_device()
        ref_latents = [lat.to(device) for lat in ref_latents]

        if ref_latents:
            ref_strength = float(ref_strength)
            plain_pos, plain_neg = positive, negative
            positive = _schedule(
                node_helpers.conditioning_set_values(positive, {"reference_latents": ref_latents}, append=True),
                plain_pos, ref_strength)
            if negative is not None:
                negative = _schedule(
                    node_helpers.conditioning_set_values(negative, {"reference_latents": ref_latents}, append=True),
                    plain_neg, ref_strength)
            empty = ref_latents[0] * 0.0            # same size as the first reference, like core
        else:
            empty = torch.zeros([1, LATENT_CHANNELS, 64, 64], device=device)  # 1024x1024
        return (positive, negative if negative is not None else positive, {"samples": empty})


NODE_CLASS_MAPPINGS = {
    "NouganFlux3RefModBake": NouganFlux3RefModBake,
    "NouganFlux3RefModApply": NouganFlux3RefModApply,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "NouganFlux3RefModBake": "Nougan Flux 3 RefMod Bake 🧬",
    "NouganFlux3RefModApply": "Nougan Flux 3 RefMod Apply 🎯",
}
