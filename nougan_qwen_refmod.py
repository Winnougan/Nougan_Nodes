"""
Nougan Qwen 2.1 RefMod

Reusable character / reference files for Qwen Image 2.1.

  Nougan Qwen 2.1 RefMod Bake    images + Qwen 2.1 VAE  ->  ONE file in models/refmods/<subfolder>/<name>.safetensors
  Nougan Qwen 2.1 RefMod Encode  drop-in for "Text Encode Qwen Image 2.1" that takes baked RefMods

Why Encode replaces the stock text-encode node
----------------------------------------------
Qwen Image 2.1 does not just append reference latents to the DiT. The text encoder
also looks at every reference image, its vision tokens are dropped from the output,
and the DiT splices each reference latent into the prompt sequence at the position
(`image_slots`) where that image's tokens used to be. Slots are produced by the text
encoder, so a RefMod must supply BOTH the VAE latent and a copy of the image.
A baked file therefore stores, per reference:

    lat_i : float32 [1, 64, H/16, W/16]   raw vae.encode() output (no process_latent_in)
    img_i : uint8   [1, H, W, 3]          the exact resized image the text encoder sees

Baking skips the VAE at generation time and gives you a reusable library; the vision
tower still runs on the stored image, exactly as the stock node does.

File format is NOT the H3 bundle format. Metadata key `nougan_qwen21` marks these files,
so the H3 loaders ignore them and these nodes ignore H3 bundles.
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

FORMAT = "nougan_qwen21_refmod"
META_KEY = "nougan_qwen21"
LATENT_CHANNELS = 64      # Qwen Image 2.1 latent format
DOWNSCALE = 16            # Qwen Image 2.1 spatial downscale
MAX_REFS = 16             # same cap as the stock 2.1 encode node
DEFAULT_SUBFOLDER = "qwen21"
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


_LIST_CACHE = {}  # path -> (mtime, is_qwen_refmod)


def list_refmods():
    """Relative names (no extension, forward slashes) of every Qwen 2.1 RefMod on disk."""
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
    raise FileNotFoundError(f"Qwen 2.1 RefMod '{rel}' not found. Refresh the node list.")


def load_refmod(rel):
    """-> (latents [1,64,h,w] float32, images [1,H,W,3] float32 0..1), both lists."""
    path = _resolve(rel)
    meta = _read_meta(path)
    if meta is None:
        raise ValueError(f"'{rel}' is not a Nougan Qwen 2.1 RefMod.")
    lats, imgs = [], []
    with safe_open(path, framework="pt", device="cpu") as f:
        for i in range(int(meta["count"])):
            lat = f.get_tensor(f"lat_{i}").float()
            img = f.get_tensor(f"img_{i}")
            if (lat.ndim != 4 or lat.shape[0] != 1 or lat.shape[1] != LATENT_CHANNELS
                    or img.ndim != 4 or img.shape[-1] != 3
                    or img.shape[1] // DOWNSCALE != lat.shape[2]
                    or img.shape[2] // DOWNSCALE != lat.shape[3]):
                raise ValueError(f"'{rel}' reference {i} has an invalid layout.")
            lats.append(lat)
            imgs.append(img.float() / 255.0)
    return lats, imgs


# ── encoding (mirrors the stock TextEncodeQwenImage21 resize) ────────────────

def _resize(frame, resolution):
    """frame [1,H,W,C] -> resized to ~resolution^2 px, multiples of 32 (0 keeps own size)."""
    samples = frame[:1].movedim(-1, 1)
    h, w = samples.shape[2], samples.shape[3]
    if resolution > 0:
        ratio = w / h
        width = round(math.sqrt(resolution * resolution * ratio) / 32) * 32
        height = round(math.sqrt(resolution * resolution / ratio) / 32) * 32
    else:
        width, height = round(w / 32) * 32, round(h / 32) * 32
    width, height = max(32, width), max(32, height)
    if (width, height) == (w, h):
        return frame[:1]
    return comfy.utils.common_upscale(samples, width, height, "lanczos", "disabled").movedim(1, -1)


def _encode_frame(frame, vae, resolution):
    s = _resize(frame, resolution)
    rgb = s[:, :, :, :3]
    if s.shape[-1] > 3:  # vision tower sees alpha over white, the VAE keeps all channels
        rgb = rgb * s[:, :, :, 3:] + (1.0 - s[:, :, :, 3:])
    lat = vae.encode(s)
    if lat.ndim != 4 or lat.shape[1] != LATENT_CHANNELS:
        raise ValueError(
            f"Expected a Qwen Image 2.1 latent with {LATENT_CHANNELS} channels, got {tuple(lat.shape)}. "
            "Connect the Qwen Image 2.1 VAE.")
    return lat, rgb


def _frames(*batches):
    out = []
    for batch in batches:
        if batch is not None:
            out.extend(batch[i:i + 1] for i in range(batch.shape[0]))
    return out


# ═════════════════════════════════════════════════════════════════════════════
#  Bake
# ═════════════════════════════════════════════════════════════════════════════

class NouganQwen21RefModBake:
    CATEGORY = "Nougan/RefMod"
    FUNCTION = "bake"
    OUTPUT_NODE = True
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("path",)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE", {"tooltip": "Every frame in the batch becomes one reference (max 16)."}),
                "vae": ("VAE", {"tooltip": "The Qwen Image 2.1 VAE."}),
                "name": ("STRING", {"default": "my_character"}),
                "resolution": ("INT", {"default": 1024, "min": 0, "max": 4096, "step": 32,
                                       "tooltip": "References are resized to about resolution x resolution pixels "
                                                  "(multiples of 32). 0 keeps each image's own size."}),
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
            raise ValueError(f"{len(frames)} references; the Qwen 2.1 encoder supports at most {MAX_REFS}.")
        path = _save_path(name, subfolder)
        if os.path.exists(path) and not overwrite:
            # Re-queuing a workflow shouldn't fail: keep the existing file and say so.
            note = (f"{os.path.basename(path)} already exists, skipped. "
                    "Enable overwrite to re-bake, or pick another name.")
            return {"ui": {"text": [note]}, "result": (path,)}

        tensors, sizes = {}, []
        for i, frame in enumerate(frames):
            lat, rgb = _encode_frame(frame, vae, resolution)
            tensors[f"lat_{i}"] = lat.detach().cpu().float().contiguous().clone()
            img = (rgb.clamp(0, 1) * 255.0).round().to(torch.uint8)
            tensors[f"img_{i}"] = img.detach().cpu().contiguous().clone()
            sizes.append([int(img.shape[2]), int(img.shape[1])])

        meta = {"format": FORMAT, "version": 1, "name": os.path.basename(path)[:-len(".safetensors")],
                "count": len(frames), "sizes": sizes, "latent_channels": LATENT_CHANNELS,
                "downscale": DOWNSCALE, "resolution": int(resolution)}
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
        summary = f"Baked {len(frames)} reference(s) -> {path}"
        return {"ui": {"text": [summary]}, "result": (path,)}


# ═════════════════════════════════════════════════════════════════════════════
#  Encode (loader + apply in one, drop-in for Text Encode Qwen Image 2.1)
# ═════════════════════════════════════════════════════════════════════════════

class NouganQwen21RefModEncode:
    CATEGORY = "Nougan/RefMod"
    FUNCTION = "encode"
    RETURN_TYPES = ("CONDITIONING", "CONDITIONING", "LATENT")
    RETURN_NAMES = ("positive", "negative", "latent")

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
                "extra_image_resolution": ("INT", {"default": 1024, "min": 0, "max": 4096, "step": 32}),
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
                raise ValueError("Connect the Qwen 2.1 VAE to encode extra_image.")
            for frame in _frames(extra_image):
                lat, rgb = _encode_frame(frame, vae, extra_image_resolution)
                ref_latents.append(lat)
                images_vl.append(rgb)

        if len(ref_latents) > MAX_REFS:
            raise ValueError(f"{len(ref_latents)} references in total; the Qwen 2.1 encoder supports at most {MAX_REFS}.")

        device = comfy.model_management.intermediate_device()
        ref_latents = [lat.to(device) for lat in ref_latents]

        keep_vision = len(ref_latents) == 0
        positive = clip.encode_from_tokens_scheduled(
            clip.tokenize(prompt, images=images_vl, keep_vision=keep_vision, prevent_empty_text=True))
        negative = clip.encode_from_tokens_scheduled(
            clip.tokenize(negative_prompt, images=images_vl, keep_vision=keep_vision, prevent_empty_text=True))
        if ref_latents:
            positive = node_helpers.conditioning_set_values(positive, {"reference_latents": ref_latents}, append=True)
            negative = node_helpers.conditioning_set_values(negative, {"reference_latents": ref_latents}, append=True)
            ref_strength = float(ref_strength)
            if ref_strength < 1.0:
                # what the stock node encodes with no references: plain prompt, vision tokens kept
                plain_pos = clip.encode_from_tokens_scheduled(
                    clip.tokenize(prompt, images=[], keep_vision=True, prevent_empty_text=True))
                plain_neg = clip.encode_from_tokens_scheduled(
                    clip.tokenize(negative_prompt, images=[], keep_vision=True, prevent_empty_text=True))
                positive = _schedule(positive, plain_pos, ref_strength)
                negative = _schedule(negative, plain_neg, ref_strength)

        # empty latent on the first reference's size: any other size shifts the edit
        if ref_latents:
            lh, lw = ref_latents[0].shape[-2:]
        else:
            lh = lw = 1024 // DOWNSCALE
        latent = torch.zeros([1, LATENT_CHANNELS, lh, lw], device=device)
        return (positive, negative, {"samples": latent})


NODE_CLASS_MAPPINGS = {
    "NouganQwen21RefModBake": NouganQwen21RefModBake,
    "NouganQwen21RefModEncode": NouganQwen21RefModEncode,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "NouganQwen21RefModBake": "Nougan Qwen 2.1 RefMod Bake 🧬",
    "NouganQwen21RefModEncode": "Nougan Qwen 2.1 RefMod Encode 🎯",
}
