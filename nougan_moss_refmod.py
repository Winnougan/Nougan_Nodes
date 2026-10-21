"""
Nougan MOSS-Image RefMod

Reusable character / reference files for MOSS-Image edit models.

  Nougan MOSS RefMod Bake    images + MOSS (FLUX.2) VAE -> ONE file in models/refmods/<subfolder>/<name>.safetensors
  Nougan MOSS RefMod Encode  replaces "Text Encode MOSS-Image Ostris Edit"; takes baked RefMods

REQUIREMENTS (not provided by this pack)
----------------------------------------
Stock MOSS-Image ignores reference latents. To actually use a RefMod you need:
  1. An edit-trained MOSS-Image model or LoRA (ai-toolkit "MOSS-Image ... [Edit Training]").
  2. ostris/ComfyUI-MOSS-Image-Ostris-Edit (MIT) installed, and its
     "MOSS-Image Ostris Edit Model Patch" node on the MODEL path.
This module deliberately does NOT vendor that patch; it only produces the same conditioning
the Ostris encode node does:

    conditioning["reference_latents"] = [vae.encode(ref snapped to 16px), ...]
    text encoder input = "Picture 1: <|vision_start|><|image_pad|><|vision_end|>..." + prompt,
                         with each image fitted (never upscaled) into 384x384 total pixels.

So each baked reference stores:

    lat_i : float32  raw vae.encode() output of the reference (about 1MP by default)
    img_i : uint8 [1, h, w, 3]  the small (<= 384x384 px area) copy the text encoder sees

File format is NOT the H3 or Qwen format; metadata key `nougan_moss` marks these files.
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

FORMAT = "nougan_moss_refmod"
META_KEY = "nougan_moss"
VLM_MAX_PIXELS = 384 * 384   # the Qwen3.5 encoder sees a coarse reference (as in training)
REF_SNAP = 16                # FLUX.2 VAE latent grid
MAX_REFS = 8
DEFAULT_SUBFOLDER = "moss"
NONE = "None"
_RESERVED = {"..", ".", "graph_presets", ".git", "__pycache__"}


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


_LIST_CACHE = {}  # path -> (mtime, is_moss_refmod)


def list_refmods():
    """Relative names (no extension, forward slashes) of every MOSS RefMod on disk."""
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
    raise FileNotFoundError(f"MOSS RefMod '{rel}' not found. Refresh the node list.")


def load_refmod(rel):
    """-> (latents, vl images [1,h,w,3] float 0..1), both lists."""
    path = _resolve(rel)
    meta = _read_meta(path)
    if meta is None:
        raise ValueError(f"'{rel}' is not a Nougan MOSS RefMod.")
    lats, imgs = [], []
    with safe_open(path, framework="pt", device="cpu") as f:
        for i in range(int(meta["count"])):
            lat = f.get_tensor(f"lat_{i}").float()
            img = f.get_tensor(f"img_{i}")
            rw, rh = meta["ref_sizes"][i]
            if (lat.ndim not in (4, 5) or img.ndim != 4 or img.shape[-1] != 3
                    or lat.shape[-2] != rh // REF_SNAP or lat.shape[-1] != rw // REF_SNAP):
                raise ValueError(f"'{rel}' reference {i} has an invalid layout.")
            lats.append(lat)
            imgs.append(img.float() / 255.0)
    return lats, imgs


# ── encoding (mirrors the Ostris encode node, with the scaling done here) ────

def _scale_total(frame, resolution):
    """Scale [1,H,W,C] so total pixels ~ resolution^2 (the 'scale upstream' step). 0 = keep."""
    if resolution <= 0:
        return frame
    h, w = frame.shape[1], frame.shape[2]
    scale = math.sqrt(resolution * resolution / (w * h))
    nw, nh = max(round(w * scale), REF_SNAP), max(round(h * scale), REF_SNAP)
    if (nh, nw) == (h, w):
        return frame
    return comfy.utils.common_upscale(frame.movedim(-1, 1), nw, nh, "lanczos", "disabled").movedim(1, -1)


def _fit_area(samples, max_pixels):
    """(B,C,H,W): downscale, never upscale, to fit max_pixels."""
    h, w = samples.shape[2], samples.shape[3]
    scale = min(1.0, math.sqrt(max_pixels / (w * h)))
    nw, nh = max(round(w * scale), 1), max(round(h * scale), 1)
    if (nh, nw) == (h, w):
        return samples
    return comfy.utils.common_upscale(samples, nw, nh, "area", "disabled")


def _snap(samples, snap):
    h, w = samples.shape[2], samples.shape[3]
    nw, nh = max(round(w / snap) * snap, snap), max(round(h / snap) * snap, snap)
    if (nh, nw) == (h, w):
        return samples
    return comfy.utils.common_upscale(samples, nw, nh, "area", "disabled")


def _encode_frame(frame, vae, resolution):
    """-> (latent, vl image [1,h,w,3], ref size (w,h))."""
    scaled = _scale_total(frame[:1], resolution)[..., :3]
    samples = scaled.movedim(-1, 1)
    vl = _fit_area(samples, VLM_MAX_PIXELS).movedim(1, -1)
    snapped = _snap(samples, REF_SNAP)
    lat = vae.encode(snapped.movedim(1, -1))
    rh, rw = snapped.shape[2], snapped.shape[3]
    if lat.ndim not in (4, 5) or lat.shape[-2] != rh // REF_SNAP or lat.shape[-1] != rw // REF_SNAP:
        raise ValueError(
            f"VAE returned {tuple(lat.shape)} for a {rw}x{rh} reference; expected a {REF_SNAP}x-downscale latent. "
            "Connect the MOSS-Image (FLUX.2) VAE.")
    return lat, vl, (int(rw), int(rh))


def _frames(*batches):
    out = []
    for batch in batches:
        if batch is not None:
            out.extend(batch[i:i + 1] for i in range(batch.shape[0]))
    return out


# ═════════════════════════════════════════════════════════════════════════════
#  Bake
# ═════════════════════════════════════════════════════════════════════════════

class NouganMossRefModBake:
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
                "vae": ("VAE", {"tooltip": "The MOSS-Image VAE (FLUX.2 VAE)."}),
                "name": ("STRING", {"default": "my_character"}),
                "resolution": ("INT", {"default": 1024, "min": 0, "max": 4096, "step": 16,
                                       "tooltip": "References are scaled to about resolution x resolution pixels "
                                                  "(1024 = ~1MP, the training default), then snapped to 16 px. "
                                                  "Each costs ~4096 tokens per step at 1024. 0 keeps each image's size."}),
                "subfolder": ("STRING", {"default": DEFAULT_SUBFOLDER}),
                "overwrite": ("BOOLEAN", {"default": False}),
            },
            "optional": {
                "image_2": ("IMAGE",), "image_3": ("IMAGE",), "image_4": ("IMAGE",),
            },
        }

    def bake(self, images, vae, name, resolution, subfolder, overwrite,
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

        tensors, sizes = {}, []
        for i, frame in enumerate(frames):
            lat, vl, size = _encode_frame(frame, vae, resolution)
            tensors[f"lat_{i}"] = lat.detach().cpu().float().contiguous().clone()
            img = (vl.clamp(0, 1) * 255.0).round().to(torch.uint8)
            tensors[f"img_{i}"] = img.detach().cpu().contiguous().clone()
            sizes.append(list(size))

        meta = {"format": FORMAT, "version": 1, "name": os.path.basename(path)[:-len(".safetensors")],
                "count": len(frames), "ref_sizes": sizes, "downscale": REF_SNAP,
                "latent_channels": int(tensors["lat_0"].shape[1]), "resolution": int(resolution)}
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
#  Encode (replaces Text Encode MOSS-Image Ostris Edit)
# ═════════════════════════════════════════════════════════════════════════════

def _picture_prefix(n):
    return "".join(f"Picture {i}: <|vision_start|><|image_pad|><|vision_end|>" for i in range(1, n + 1))


class NouganMossRefModEncode:
    CATEGORY = "Nougan/RefMod"
    FUNCTION = "encode"
    RETURN_TYPES = ("CONDITIONING", "CONDITIONING")
    RETURN_NAMES = ("positive", "negative")

    @classmethod
    def INPUT_TYPES(cls):
        names = [NONE] + list_refmods()
        return {
            "required": {
                "clip": ("CLIP",),
                "prompt": ("STRING", {"multiline": True, "dynamicPrompts": True}),
                "negative_prompt": ("STRING", {"multiline": True, "dynamicPrompts": True}),
                "refmod_1": (names,),
            },
            "optional": {
                "refmod_2": (names,),
                "refmod_3": (names,),
                "extra_image": ("IMAGE", {"tooltip": "Optional plain reference(s), encoded on the fly. Needs the VAE."}),
                "vae": ("VAE", {"tooltip": "Only needed for extra_image."}),
                "extra_image_resolution": ("INT", {"default": 1024, "min": 0, "max": 4096, "step": 16}),
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

    def encode(self, clip, prompt, negative_prompt, refmod_1, refmod_2=NONE, refmod_3=NONE,
               extra_image=None, vae=None, extra_image_resolution=1024):
        ref_latents, images_vl = [], []
        for rel in (refmod_1, refmod_2, refmod_3):
            if rel and rel != NONE:
                lats, imgs = load_refmod(rel)
                ref_latents.extend(lats)
                images_vl.extend(imgs)

        if extra_image is not None:
            if vae is None:
                raise ValueError("Connect the MOSS-Image VAE to encode extra_image.")
            for frame in _frames(extra_image):
                lat, vl, _ = _encode_frame(frame, vae, extra_image_resolution)
                ref_latents.append(lat)
                images_vl.append(vl)

        if len(ref_latents) > MAX_REFS:
            raise ValueError(f"{len(ref_latents)} references in total; at most {MAX_REFS}.")

        device = comfy.model_management.intermediate_device()
        ref_latents = [lat.to(device) for lat in ref_latents]

        prefix = _picture_prefix(len(images_vl))
        positive = clip.encode_from_tokens_scheduled(clip.tokenize(prefix + prompt, images=images_vl))
        negative = clip.encode_from_tokens_scheduled(clip.tokenize(prefix + negative_prompt, images=images_vl))
        if ref_latents:
            positive = node_helpers.conditioning_set_values(positive, {"reference_latents": ref_latents}, append=True)
            negative = node_helpers.conditioning_set_values(negative, {"reference_latents": ref_latents}, append=True)
        return (positive, negative)


NODE_CLASS_MAPPINGS = {
    "NouganMossRefModBake": NouganMossRefModBake,
    "NouganMossRefModEncode": NouganMossRefModEncode,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "NouganMossRefModBake": "Nougan MOSS RefMod Bake 🧬",
    "NouganMossRefModEncode": "Nougan MOSS RefMod Encode 🎯",
}
