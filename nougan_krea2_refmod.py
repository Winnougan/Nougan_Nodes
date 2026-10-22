"""
Nougan Krea 2 RefMod

Reusable character / reference files for Krea 2 edit LoRAs.

  Nougan Krea 2 RefMod Bake    images + Krea 2 VAE -> ONE file in models/refmods/<subfolder>/<name>.safetensors
  Nougan Krea 2 RefMod Encode  replaces "Text Encode Krea 2 Ostris Edit"; takes baked RefMods

REQUIREMENTS (not provided by this pack)
----------------------------------------
Stock Krea 2 ignores reference latents. To actually use a RefMod you need:
  1. A Krea 2 edit LoRA trained with ai-toolkit (krea2 arch, model_kwargs.edit: true).
  2. ostris/ComfyUI-Krea2-Ostris-Edit (MIT) installed, and its
     "Krea 2 Ostris Edit Model Patch" node on the MODEL path (kv_cache off unless the
     LoRA was trained with kv_cache).
This module deliberately does NOT vendor that patch; it only produces the same conditioning
the Ostris encode node does:

    conditioning["reference_latents"] = [vae.encode(ref fitted to 1MP, snapped to 16px), ...]
    text encoder input = "Picture 1: <|vision_start|><|image_pad|><|vision_end|>..." + prompt,
                         Krea's own conditioning template, each image fitted (never upscaled)
                         into 384x384 total pixels.

So each baked reference stores:

    lat_i : float32  raw vae.encode() output of the reference
    img_i : uint8 [1, h, w, 3]  the small (<= 384x384 px area) copy the text encoder sees

File format is NOT the H3, Qwen or MOSS format; metadata key `nougan_krea2` marks these files.
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
from comfy.text_encoders.krea2 import KREA2_TEMPLATE

FORMAT = "nougan_krea2_refmod"
META_KEY = "nougan_krea2"
VLM_MAX_PIXELS = 384 * 384   # the Qwen3-VL encoder sees a coarse reference (as in training)
REF_SNAP = 16                # VAE f8 x patch 2: the latent grid must patchify
LATENT_DOWNSCALE = 8         # Krea 2 VAE spatial downscale
MAX_REFS = 8
DEFAULT_SUBFOLDER = "krea2"
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


_LIST_CACHE = {}  # path -> (mtime, is_krea2_refmod)


def list_refmods():
    """Relative names (no extension, forward slashes) of every Krea 2 RefMod on disk."""
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
    raise FileNotFoundError(f"Krea 2 RefMod '{rel}' not found. Refresh the node list.")


def load_refmod(rel):
    """-> (latents, vl images [1,h,w,3] float 0..1), both lists."""
    path = _resolve(rel)
    meta = _read_meta(path)
    if meta is None:
        raise ValueError(f"'{rel}' is not a Nougan Krea 2 RefMod.")
    lats, imgs = [], []
    with safe_open(path, framework="pt", device="cpu") as f:
        for i in range(int(meta["count"])):
            lat = f.get_tensor(f"lat_{i}").float()
            img = f.get_tensor(f"img_{i}")
            rw, rh = meta["ref_sizes"][i]
            if (lat.ndim not in (4, 5) or img.ndim != 4 or img.shape[-1] != 3
                    or lat.shape[-2] != rh // LATENT_DOWNSCALE or lat.shape[-1] != rw // LATENT_DOWNSCALE):
                raise ValueError(f"'{rel}' reference {i} has an invalid layout.")
            lats.append(lat)
            imgs.append(img.float() / 255.0)
    return lats, imgs


# ── encoding (mirrors the Ostris encode node, with the scaling done here) ────

def _fit_area(samples, max_pixels, snap=1):
    """(B,C,H,W): downscale (never upscale) to fit max_pixels, keep aspect, snap dims."""
    h, w = samples.shape[2], samples.shape[3]
    scale = min(1.0, math.sqrt(max_pixels / (w * h)))
    nw = max(round(w * scale / snap) * snap, snap)
    nh = max(round(h * scale / snap) * snap, snap)
    if (nh, nw) == (h, w):
        return samples
    return comfy.utils.common_upscale(samples, nw, nh, "area", "disabled")


def _encode_frame(frame, vae, resolution):
    """-> (latent, vl image [1,h,w,3], ref size (w,h)). Mirrors the Ostris encode node."""
    samples = frame[:1][..., :3].movedim(-1, 1)
    vl = _fit_area(samples, VLM_MAX_PIXELS).movedim(1, -1)
    ref = _fit_area(samples, resolution * resolution if resolution > 0 else float("inf"), snap=REF_SNAP)
    lat = vae.encode(ref.movedim(1, -1))
    rh, rw = ref.shape[2], ref.shape[3]
    if lat.ndim not in (4, 5) or lat.shape[-2] != rh // LATENT_DOWNSCALE or lat.shape[-1] != rw // LATENT_DOWNSCALE:
        raise ValueError(
            f"VAE returned {tuple(lat.shape)} for a {rw}x{rh} reference; expected a {LATENT_DOWNSCALE}x-downscale latent. "
            "Connect the Krea 2 VAE.")
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

class NouganKrea2RefModBake:
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
                "vae": ("VAE", {"tooltip": "The Krea 2 VAE."}),
                "name": ("STRING", {"default": "my_character"}),
                "resolution": ("INT", {"default": 1024, "min": 0, "max": 4096, "step": 16,
                                       "tooltip": "References larger than resolution x resolution pixels are scaled down to fit "
                                                  "(1024 = ~1MP, the training default; never upscaled), then snapped to 16 px. "
                                                  "0 = no cap."}),
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
#  Encode (replaces Text Encode Krea 2 Ostris Edit)
# ═════════════════════════════════════════════════════════════════════════════

def _picture_prefix(n):
    return "".join(f"Picture {i}: <|vision_start|><|image_pad|><|vision_end|>" for i in range(1, n + 1))


class NouganKrea2RefModEncode:
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

    def encode(self, clip, prompt, negative_prompt, refmod_1, refmod_2=NONE, refmod_3=NONE,
               extra_image=None, vae=None, extra_image_resolution=1024, ref_strength=1.0):
        ref_latents, images_vl = [], []
        for rel in (refmod_1, refmod_2, refmod_3):
            if rel and rel != NONE:
                lats, imgs = load_refmod(rel)
                ref_latents.extend(lats)
                images_vl.extend(imgs)

        if extra_image is not None:
            if vae is None:
                raise ValueError("Connect the Krea 2 VAE to encode extra_image.")
            for frame in _frames(extra_image):
                lat, vl, _ = _encode_frame(frame, vae, extra_image_resolution)
                ref_latents.append(lat)
                images_vl.append(vl)

        if len(ref_latents) > MAX_REFS:
            raise ValueError(f"{len(ref_latents)} references in total; at most {MAX_REFS}.")

        device = comfy.model_management.intermediate_device()
        ref_latents = [lat.to(device) for lat in ref_latents]

        prefix = _picture_prefix(len(images_vl))
        positive = clip.encode_from_tokens_scheduled(clip.tokenize(prefix + prompt, images=images_vl, llama_template=KREA2_TEMPLATE))
        negative = clip.encode_from_tokens_scheduled(clip.tokenize(prefix + negative_prompt, images=images_vl, llama_template=KREA2_TEMPLATE))
        if ref_latents:
            ref_strength = float(ref_strength)
            plain_pos, plain_neg = positive, negative   # same text conditioning, no reference latents
            positive = _schedule(
                node_helpers.conditioning_set_values(positive, {"reference_latents": ref_latents}, append=True),
                plain_pos, ref_strength)
            negative = _schedule(
                node_helpers.conditioning_set_values(negative, {"reference_latents": ref_latents}, append=True),
                plain_neg, ref_strength)
        return (positive, negative)


NODE_CLASS_MAPPINGS = {
    "NouganKrea2RefModBake": NouganKrea2RefModBake,
    "NouganKrea2RefModEncode": NouganKrea2RefModEncode,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "NouganKrea2RefModBake": "Nougan Krea 2 RefMod Bake 🧬",
    "NouganKrea2RefModEncode": "Nougan Krea 2 RefMod Encode 🎯",
}
