"""
Nougan RefMods (unified)

ONE Bake node and ONE Apply node for every model that uses baked reference files.

  Nougan RefMod Bake   model + images (+ VAE) -> ONE file in models/refmods/<subfolder>/<name>.safetensors
  Nougan RefMod Apply  baked RefMod(s) -> positive / negative / latent, ready for the sampler

Supported models: Qwen 2.1, MOSS-Image, Flux 3, Fibo 2, LTX-2.5.
(Krea 2 was removed; MiniMax H3 still lives in nougan_refmod.py until it is folded in.)

Adding a model later
--------------------
Write one Handler subclass and decorate it with @register. That is the whole job: the model
dropdowns, file listing, baking, loading, validation and auto-detection all come from the registry.

    @register
    class MyModel(Handler):
        key = "mymodel"; label = "My Model"
        format = "nougan_mymodel_refmod"; meta_key = "nougan_mymodel"; subfolder = "mymodel"
        def encode_frame(self, frame, vae, resolution, scale_mode): ...   # -> dict(lat=, img=, size=)
        def check(self, i, lat, img, meta): ...                            # -> bool, is the stored ref sane
        def apply(self, c): ...                                            # -> (positive, negative, latent)

File compatibility
------------------
Every handler keeps the exact FORMAT / metadata key / tensor layout of the node it replaces, so
RefMods you already baked with the old Qwen 2.1 / MOSS / Flux 3 / Fibo 2 nodes load unchanged.
Apply reads the model from the file itself, so `model = auto` just works.
"""

import base64
import inspect
import io
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

NONE = "None"
AUTO = "auto (from refmod)"
_RESERVED = {"..", ".", "graph_presets", ".git", "__pycache__"}

REF_STRENGTH_TIP = (
    "How long the references stay active, as a fraction of the denoising steps counted from the start. "
    "1.0 = every step. 0.6 = the references steer the first 60% of the steps, then the prompt alone finishes. "
    "0 = references off. Lower = looser likeness and more prompt freedom. (Not used by LTX-2.5: its guides are "
    "part of the latent.)")


# ═════════════════════════════════════════════════════════════════════════════
#  Shared helpers
# ═════════════════════════════════════════════════════════════════════════════

def _schedule(with_refs, without_refs, strength):
    """Conditioning list: `with_refs` for the first `strength` of the sampling, `without_refs` after."""
    if strength >= 1.0:
        return with_refs
    if strength <= 0.0:
        return without_refs
    head = node_helpers.conditioning_set_values(with_refs, {"start_percent": 0.0, "end_percent": strength})
    tail = node_helpers.conditioning_set_values(without_refs, {"start_percent": strength, "end_percent": 1.0})
    return head + tail


def _attach(cond, latents):
    return node_helpers.conditioning_set_values(cond, {"reference_latents": latents}, append=True)


def _frames(*batches):
    out = []
    for batch in batches:
        if batch is not None:
            out.extend(batch[i:i + 1] for i in range(batch.shape[0]))
    return out


def _resize32(frame, resolution):
    """frame [1,H,W,C] -> ~resolution^2 px, multiples of 32 (0 keeps own size)."""
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


THUMB_SIZE = 192


def _jpeg_bytes(arr):
    from PIL import Image
    im = Image.fromarray(arr)
    im.thumbnail((THUMB_SIZE, THUMB_SIZE))
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=82)
    return buf.getvalue()


def _thumb_b64(frame):
    """frame [1,H,W,C] float 0..1 -> base64 JPEG preview stored in the file header."""
    arr = (frame[0][..., :3].clamp(0, 1) * 255.0).round().to(torch.uint8).cpu().numpy()
    return base64.b64encode(_jpeg_bytes(arr)).decode("ascii")


def _alpha_over_white(s):
    rgb = s[:, :, :, :3]
    if s.shape[-1] > 3:
        rgb = rgb * s[:, :, :, 3:] + (1.0 - s[:, :, :, 3:])
    return rgb


def _fit_area(samples, max_pixels, snap=1):
    """(B,C,H,W): downscale (never upscale) to fit max_pixels, keep aspect, snap dims."""
    h, w = samples.shape[2], samples.shape[3]
    scale = min(1.0, math.sqrt(max_pixels / (w * h)))
    nw = max(round(w * scale / snap) * snap, snap)
    nh = max(round(h * scale / snap) * snap, snap)
    if (nh, nw) == (h, w):
        return samples
    return comfy.utils.common_upscale(samples, nw, nh, "area", "disabled")


def _empty_latent(lats, channels, device):
    """Zeros on the first reference's size (any other size shifts an edit), else 1024x1024."""
    if lats:
        return {"samples": torch.zeros_like(lats[0])}
    return {"samples": torch.zeros([1, channels, 64, 64], device=device)}


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


# ═════════════════════════════════════════════════════════════════════════════
#  Handler registry
# ═════════════════════════════════════════════════════════════════════════════

HANDLERS = {}


def register(cls):
    HANDLERS[cls.key] = cls()
    return cls


class Ctx:
    """Everything an Apply handler can use."""
    def __init__(self, **kw):
        self.__dict__.update(kw)

    def need_clip(self):
        if self.clip is None:
            raise ValueError(f"{self.handler.label} encodes the prompt with the text encoder: connect `clip`.")
        return self.clip

    def need_positive(self):
        if self.positive is None:
            raise ValueError(f"{self.handler.label} attaches references to your conditioning: connect `positive`.")
        return self.positive


class Handler:
    key = ""
    label = ""
    format = ""
    meta_key = ""
    subfolder = ""
    max_refs = 8
    latent_channels = 128
    stores_images = False      # file holds img_i (uint8) next to lat_i
    stores_latents = True
    needs_vae_to_bake = True

    # -- UI metadata (read by web/nougan_refmods.js through /nougan/refmod_lib) --
    accent = "#a78bfa"                      # colour of the model chip and the WebGPU strip
    token_downscale = 16                    # reference tokens/step = sum((w/ds) * (h/ds))
    apply_needs = ()                        # Apply sockets that must be connected for this model
    apply_uses = frozenset()                # Apply widgets that matter for this model (others are hidden)
    bake_needs = ("vae",)                   # Bake sockets that must be connected
    bake_uses = frozenset({"vae"})          # Bake widgets that matter (others are hidden)

    # -- bake side --
    def encode_frame(self, frame, vae, resolution, scale_mode):
        raise NotImplementedError

    def meta_extra(self, refs, resolution, scale_mode):
        return {"sizes": [list(r["size"]) for r in refs], "resolution": int(resolution)}

    # -- load side --
    def check(self, i, lat, img, meta):
        return True

    # -- apply side --
    def apply(self, c):
        raise NotImplementedError

    def _vae_for_extra(self, c):
        if c.vae is None:
            raise ValueError(f"Connect the {self.label} VAE to encode extra_image.")
        return c.vae

    def _extra_refs(self, c):
        if c.extra_image is None:
            return []
        vae = self._vae_for_extra(c)
        return [self.encode_frame(f, vae, c.extra_image_resolution, c.extra_image_scale)
                for f in _frames(c.extra_image)]


def _tokens_check(count, limit, label):
    if count > limit:
        raise ValueError(f"{count} references in total; {label} supports at most {limit}.")


# ── Qwen Image 2.1 ───────────────────────────────────────────────────────────

@register
class Qwen21(Handler):
    key = "qwen21"
    label = "Qwen 2.1"
    format = "nougan_qwen21_refmod"
    meta_key = "nougan_qwen21"
    subfolder = "qwen21"
    accent = "#22d3ee"
    apply_needs = ("clip",)
    apply_uses = frozenset({"clip", "ref_strength", "ref_on_negative"})
    max_refs = 16
    latent_channels = 64
    stores_images = True
    downscale = 16

    def encode_frame(self, frame, vae, resolution, scale_mode):
        s = _resize32(frame, resolution)
        rgb = _alpha_over_white(s)
        lat = vae.encode(s)
        if lat.ndim != 4 or lat.shape[1] != self.latent_channels:
            raise ValueError(f"Expected a Qwen Image 2.1 latent with {self.latent_channels} channels, got "
                             f"{tuple(lat.shape)}. Connect the Qwen Image 2.1 VAE.")
        return {"lat": lat, "img": rgb, "size": (int(rgb.shape[2]), int(rgb.shape[1]))}

    def meta_extra(self, refs, resolution, scale_mode):
        return {"sizes": [list(r["size"]) for r in refs], "latent_channels": self.latent_channels,
                "downscale": self.downscale, "resolution": int(resolution)}

    def check(self, i, lat, img, meta):
        return (lat is not None and img is not None and lat.ndim == 4 and lat.shape[0] == 1
                and lat.shape[1] == self.latent_channels and img.ndim == 4 and img.shape[-1] == 3
                and img.shape[1] // self.downscale == lat.shape[2]
                and img.shape[2] // self.downscale == lat.shape[3])

    def apply(self, c):
        clip = c.need_clip()
        refs = c.refs + self._extra_refs(c)
        _tokens_check(len(refs), self.max_refs, "the Qwen 2.1 encoder")
        lats = [r["lat"].to(c.device) for r in refs]
        imgs = [r["img"] for r in refs]
        keep_vision = len(lats) == 0
        enc = lambda text, im, kv: clip.encode_from_tokens_scheduled(
            clip.tokenize(text, images=im, keep_vision=kv, prevent_empty_text=True))
        positive, negative = enc(c.prompt, imgs, keep_vision), enc(c.negative_prompt, imgs, keep_vision)
        if lats:
            positive = _attach(positive, lats)
            if c.ref_on_negative:
                negative = _attach(negative, lats)
            if c.ref_strength < 1.0:
                # what the stock node encodes with no references: plain prompt, vision tokens kept
                positive = _schedule(positive, enc(c.prompt, [], True), c.ref_strength)
                if c.ref_on_negative:
                    negative = _schedule(negative, enc(c.negative_prompt, [], True), c.ref_strength)
        return positive, negative, _empty_latent(lats, self.latent_channels, c.device)


# ── MOSS-Image ───────────────────────────────────────────────────────────────

SCALE_KONTEXT = "kontext (matches Ostris example)"
SCALE_MEGAPIXELS = "megapixels"
# FluxKontextImageScale's presets (core ComfyUI): nearest preset by aspect + CENTER CROP.
KONTEXT_RESOLUTIONS = [
    (672, 1568), (688, 1504), (720, 1456), (752, 1392), (800, 1328), (832, 1248),
    (880, 1184), (944, 1104), (1024, 1024), (1104, 944), (1184, 880), (1248, 832),
    (1328, 800), (1392, 752), (1456, 720), (1504, 688), (1568, 672),
]


def _picture_prefix(n):
    return "".join(f"Picture {i}: <|vision_start|><|image_pad|><|vision_end|>" for i in range(1, n + 1))


@register
class Moss(Handler):
    key = "moss"
    label = "MOSS-Image"
    format = "nougan_moss_refmod"
    meta_key = "nougan_moss"
    subfolder = "moss"
    accent = "#a78bfa"
    apply_needs = ("clip",)
    apply_uses = frozenset({"clip", "extra_image_scale", "ref_strength", "ref_on_negative"})
    bake_uses = frozenset({"vae", "scale_mode"})
    snap = 16
    vlm_max_pixels = 384 * 384
    stores_images = True

    def _scale_total(self, frame, resolution):
        if resolution <= 0:
            return frame
        h, w = frame.shape[1], frame.shape[2]
        scale = math.sqrt(resolution * resolution / (w * h))
        nw, nh = max(round(w * scale), self.snap), max(round(h * scale), self.snap)
        if (nh, nw) == (h, w):
            return frame
        return comfy.utils.common_upscale(frame.movedim(-1, 1), nw, nh, "lanczos", "disabled").movedim(1, -1)

    def _scale_kontext(self, frame):
        h, w = frame.shape[1], frame.shape[2]
        aspect = w / h
        _, tw, th = min((abs(aspect - pw / ph), pw, ph) for pw, ph in KONTEXT_RESOLUTIONS)
        return comfy.utils.common_upscale(frame.movedim(-1, 1), tw, th, "lanczos", "center").movedim(1, -1)

    def _snap(self, samples):
        h, w = samples.shape[2], samples.shape[3]
        nw, nh = max(round(w / self.snap) * self.snap, self.snap), max(round(h / self.snap) * self.snap, self.snap)
        if (nh, nw) == (h, w):
            return samples
        return comfy.utils.common_upscale(samples, nw, nh, "area", "disabled")

    def encode_frame(self, frame, vae, resolution, scale_mode):
        frame = frame[:1]
        scaled = (self._scale_kontext(frame) if scale_mode == SCALE_KONTEXT
                  else self._scale_total(frame, resolution))[..., :3]
        samples = scaled.movedim(-1, 1)
        vl = _fit_area(samples, self.vlm_max_pixels).movedim(1, -1)
        snapped = self._snap(samples)
        lat = vae.encode(snapped.movedim(1, -1))
        rh, rw = snapped.shape[2], snapped.shape[3]
        if lat.ndim not in (4, 5) or lat.shape[-2] != rh // self.snap or lat.shape[-1] != rw // self.snap:
            raise ValueError(f"VAE returned {tuple(lat.shape)} for a {rw}x{rh} reference; expected a "
                             f"{self.snap}x-downscale latent. Connect the MOSS-Image (FLUX.2) VAE.")
        return {"lat": lat, "img": vl, "size": (int(rw), int(rh))}

    def meta_extra(self, refs, resolution, scale_mode):
        return {"ref_sizes": [list(r["size"]) for r in refs], "downscale": self.snap,
                "latent_channels": int(refs[0]["lat"].shape[1]), "resolution": int(resolution),
                "scale_mode": scale_mode}

    def check(self, i, lat, img, meta):
        rw, rh = meta["ref_sizes"][i]
        return (lat is not None and img is not None and lat.ndim in (4, 5) and img.ndim == 4
                and img.shape[-1] == 3 and lat.shape[-2] == rh // self.snap and lat.shape[-1] == rw // self.snap)

    def apply(self, c):
        clip = c.need_clip()
        refs = c.refs + self._extra_refs(c)
        _tokens_check(len(refs), self.max_refs, "MOSS-Image")
        lats = [r["lat"].to(c.device) for r in refs]
        imgs = [r["img"] for r in refs]
        if lats:
            grids = [tuple(lat.shape[-2:]) for lat in lats]
            print(f"[Nougan RefMod/MOSS] {len(lats)} ref(s), latent grids {grids}, "
                  f"{sum(a * b for a, b in grids)} ref tokens/step, VL images {[tuple(v.shape[1:3]) for v in imgs]}")
        prefix = _picture_prefix(len(imgs))
        positive = clip.encode_from_tokens_scheduled(clip.tokenize(prefix + c.prompt, images=imgs))
        negative = clip.encode_from_tokens_scheduled(clip.tokenize(prefix + c.negative_prompt, images=imgs))
        if lats:
            plain_pos, plain_neg = positive, negative   # same text conditioning, no reference latents
            positive = _schedule(_attach(positive, lats), plain_pos, c.ref_strength)
            if c.ref_on_negative:
                negative = _schedule(_attach(negative, lats), plain_neg, c.ref_strength)
        return positive, negative, _empty_latent(lats, 128, c.device)


# ── Fibo 2 ───────────────────────────────────────────────────────────────────

@register
class Fibo2(Handler):
    key = "fibo2"
    label = "Fibo 2"
    format = "nougan_fibo2_refmod"
    meta_key = "nougan_fibo2"
    subfolder = "fibo2"
    accent = "#f472b6"
    apply_needs = ("clip",)
    apply_uses = frozenset({"clip", "ref_strength", "ref_on_negative"})
    max_refs = 8
    latent_channels = 128
    stores_images = True
    downscale = 16

    def encode_frame(self, frame, vae, resolution, scale_mode):
        s = _resize32(frame, resolution)
        rgb = _alpha_over_white(s)
        lat = vae.encode(rgb)
        if lat.ndim != 4 or lat.shape[1] != self.latent_channels:
            raise ValueError(f"Expected a Fibo 2 (Flux2) latent with {self.latent_channels} channels, got "
                             f"{tuple(lat.shape)}. Connect the Flux2 VAE (flux2-vae.safetensors).")
        return {"lat": lat, "img": rgb, "size": (int(rgb.shape[2]), int(rgb.shape[1]))}

    def meta_extra(self, refs, resolution, scale_mode):
        return {"sizes": [list(r["size"]) for r in refs], "latent_channels": self.latent_channels,
                "downscale": self.downscale, "resolution": int(resolution)}

    check = Qwen21.check   # same layout: lat [1,C,H/16,W/16] + img [1,H,W,3]

    def apply(self, c):
        clip = c.need_clip()
        refs = c.refs + self._extra_refs(c)
        _tokens_check(len(refs), self.max_refs, "Fibo 2")
        lats = [r["lat"].to(c.device) for r in refs]
        imgs = [r["img"] for r in refs]
        enc = lambda text, im: clip.encode_from_tokens_scheduled(clip.tokenize(text, images=im))
        # references go to the text encoder as images (edit mode) and to the DiT as latents;
        # an empty negative is the null caption (never sees images)
        positive, negative = enc(c.prompt, imgs), enc(c.negative_prompt, [])
        if lats:
            positive = _attach(positive, lats)
            if c.ref_on_negative:
                negative = _attach(negative, lats)
            if c.ref_strength < 1.0:
                # no references at all: plain prompt as a caption (text-to-image behaviour)
                positive = _schedule(positive, enc(c.prompt, []), c.ref_strength)
                if c.ref_on_negative:
                    negative = _schedule(negative, enc(c.negative_prompt, []), c.ref_strength)
        return positive, negative, _empty_latent(lats, self.latent_channels, c.device)


# ── Flux 3 ───────────────────────────────────────────────────────────────────

@register
class Flux3(Handler):
    key = "flux3"
    label = "Flux 3"
    format = "nougan_flux3_refmod"
    meta_key = "nougan_flux3"
    subfolder = "flux3"
    accent = "#fbbf24"
    apply_needs = ("positive",)
    apply_uses = frozenset({"positive", "ref_strength", "ref_on_negative"})
    max_refs = 16
    latent_channels = 128

    def encode_frame(self, frame, vae, resolution, scale_mode):
        image = frame[:1][..., :3]
        if resolution > 0:      # same as the old megapixels widget: resolution 1024 == 1.0 MP
            h, w = image.shape[1:3]
            scale = math.sqrt(resolution * resolution / (w * h))
            nw, nh = max(1, round(w * scale)), max(1, round(h * scale))
            if (nw, nh) != (w, h):
                image = comfy.utils.common_upscale(image.movedim(-1, 1), nw, nh, "lanczos", "disabled").movedim(1, -1)
        lat = vae.encode(image)
        if lat.ndim != 4 or lat.shape[1] != self.latent_channels:
            raise ValueError(f"Expected a Flux 3 latent with {self.latent_channels} channels, got "
                             f"{tuple(lat.shape)}. Connect the Flux 2/3 VAE.")
        return {"lat": lat, "img": None, "size": (int(image.shape[2]), int(image.shape[1]))}

    def meta_extra(self, refs, resolution, scale_mode):
        return {"latent_channels": self.latent_channels, "shapes": [list(r["lat"].shape) for r in refs],
                "megapixels": float(resolution * resolution) / (1024.0 * 1024.0)}

    def check(self, i, lat, img, meta):
        return (lat is not None and lat.ndim == 4 and lat.shape[0] == 1
                and lat.shape[1] == self.latent_channels and min(lat.shape[2:]) >= 1)

    def apply(self, c):
        pos = c.need_positive()
        refs = c.refs + self._extra_refs(c)
        _tokens_check(len(refs), self.max_refs, "Flux 3")
        lats = [r["lat"].to(c.device) for r in refs]
        negative = c.negative
        if lats:
            plain_pos, plain_neg = pos, negative
            pos = _schedule(_attach(pos, lats), plain_pos, c.ref_strength)
            if negative is not None and c.ref_on_negative:
                negative = _schedule(_attach(negative, lats), plain_neg, c.ref_strength)
        return pos, (negative if negative is not None else pos), _empty_latent(lats, self.latent_channels, c.device)


# ── LTX-2.5 ──────────────────────────────────────────────────────────────────

def _ltx_add_guide(positive, negative, vae, latent, image, frame_idx, strength):
    """Run core's LTXVAddGuide on one image. Core owns keyframe_idxs / noise mask / guide attention
    bookkeeping, which changes between ComfyUI versions, so it is never re-implemented here."""
    from comfy_extras import nodes_lt
    node = nodes_lt.LTXVAddGuide
    fn = getattr(node, "execute", None) or node().generate
    wanted = dict(positive=positive, negative=negative, vae=vae, latent=latent,
                  image=image, frame_idx=frame_idx, strength=strength)
    params = inspect.signature(fn).parameters
    out = fn(**{k: v for k, v in wanted.items() if k in params})
    res = getattr(out, "result", None) or getattr(out, "args", None) or out
    return res[0], res[1], res[2]


@register
class Ltx25(Handler):
    """
    LTX-2.5 takes references as guide frames on the video latent (core LTXVAddGuide), and that
    node needs the latent being sampled, so a RefMod stores the prepared IMAGES (multiples of 32 px)
    and Apply encodes them with the VAE through LTXVAddGuide. Bake therefore needs no VAE.
    """
    key = "ltx25"
    label = "LTX-2.5"
    format = "nougan_ltx25_refmod"
    meta_key = "nougan_ltx25"
    subfolder = "ltx25"
    accent = "#34d399"
    token_downscale = 32
    apply_needs = ("positive", "latent", "vae")
    apply_uses = frozenset({"positive", "latent", "vae", "frame_idx", "strength"})
    bake_needs = ()
    bake_uses = frozenset()
    max_refs = 8
    stores_images = True
    stores_latents = False
    needs_vae_to_bake = False

    def encode_frame(self, frame, vae, resolution, scale_mode):
        rgb = _alpha_over_white(_resize32(frame, resolution))
        return {"lat": None, "img": rgb, "size": (int(rgb.shape[2]), int(rgb.shape[1]))}

    def meta_extra(self, refs, resolution, scale_mode):
        return {"sizes": [list(r["size"]) for r in refs], "downscale": 32, "resolution": int(resolution)}

    def check(self, i, lat, img, meta):
        return img is not None and img.ndim == 4 and img.shape[-1] == 3 and min(img.shape[1:3]) >= 32

    def apply(self, c):
        pos, neg = c.need_positive(), c.negative
        if c.latent is None:
            raise ValueError("LTX-2.5 guides are added to the video latent: connect `latent` (e.g. Empty LTXV Latent).")
        if c.vae is None:
            raise ValueError("Connect the LTX-2.5 video VAE: the guide images are encoded at apply time.")
        refs = c.refs
        if c.extra_image is not None:
            refs = refs + [self.encode_frame(f, None, c.extra_image_resolution, c.extra_image_scale)
                           for f in _frames(c.extra_image)]
        _tokens_check(len(refs), self.max_refs, "LTX-2.5")
        neg = neg if neg is not None else pos
        latent = c.latent
        if c.ref_strength <= 0.0:
            refs = []
        for r in refs:
            pos, neg, latent = _ltx_add_guide(pos, neg, c.vae, latent, r["img"], c.frame_idx, c.strength)
        return pos, neg, latent


# ═════════════════════════════════════════════════════════════════════════════
#  File IO (generic)
# ═════════════════════════════════════════════════════════════════════════════

_INDEX_CACHE = {}  # path -> (mtime, handler key or None, meta or None)


def _detect(path):
    """-> (handler, meta dict) for a Nougan RefMod file, else (None, None)."""
    try:
        with safe_open(path, framework="pt", device="cpu") as f:
            raw = f.metadata() or {}
    except Exception:
        return None, None
    for h in HANDLERS.values():
        blob = raw.get(h.meta_key)
        if not blob:
            continue
        try:
            meta = json.loads(blob)
        except Exception:
            continue
        if isinstance(meta, dict) and meta.get("format") == h.format:
            return h, meta
    return None, None


def _scan():
    """Yield (relative name, path, handler, meta) for every RefMod of any registered model."""
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
                hit = _INDEX_CACHE.get(path)
                if hit is None or hit[0] != mtime:
                    h, meta = _detect(path)
                    hit = (mtime, h.key if h else None, meta)
                    _INDEX_CACHE[path] = hit
                if hit[1]:
                    rel = os.path.relpath(path, root)[:-len(".safetensors")]
                    yield rel.replace(os.sep, "/"), path, HANDLERS[hit[1]], hit[2]


def _index():
    """{relative name: handler key}."""
    return {rel: h.key for rel, _, h, _ in _scan()}


def list_refmods():
    return sorted(_index(), key=str.lower)


def _resolve(rel):
    for root in _roots():
        path = os.path.join(root, rel) + ".safetensors"
        if os.path.isfile(path):
            return path
    raise FileNotFoundError(f"RefMod '{rel}' not found. Refresh the node list.")


def load_refmod(rel, expect=None):
    """-> (handler, [ref dicts with lat / img / size])."""
    path = _resolve(rel)
    h, meta = _detect(path)
    if h is None:
        raise ValueError(f"'{rel}' is not a Nougan RefMod for any supported model.")
    if expect is not None and h.key != expect.key:
        raise ValueError(f"'{rel}' is a {h.label} RefMod but the model is set to {expect.label}.")
    refs = []
    with safe_open(path, framework="pt", device="cpu") as f:
        keys = set(f.keys())
        for i in range(int(meta["count"])):
            lat = f.get_tensor(f"lat_{i}").float() if f"lat_{i}" in keys else None
            img = f.get_tensor(f"img_{i}").float() / 255.0 if f"img_{i}" in keys else None
            if not h.check(i, lat, img, meta):
                raise ValueError(f"'{rel}' reference {i} has an invalid layout.")
            refs.append({"lat": lat, "img": img, "size": None})
    return h, refs


def _stamp(*rels):
    out = []
    for rel in rels:
        if rel and rel != NONE:
            try:
                out.append(str(os.path.getmtime(_resolve(rel))))
            except (OSError, FileNotFoundError):
                out.append("missing")
    return "|".join(out)


# ═════════════════════════════════════════════════════════════════════════════
#  Bake
# ═════════════════════════════════════════════════════════════════════════════

class NouganUnifiedRefModBake:
    CATEGORY = "Nougan/RefMod"
    FUNCTION = "bake"
    OUTPUT_NODE = True
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("path",)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": (list(HANDLERS), {"tooltip": "Which model this RefMod is for. Decides the file format."}),
                "images": ("IMAGE", {"tooltip": "Every frame in the batch becomes one reference."}),
                "name": ("STRING", {"default": "my_character"}),
                "resolution": ("INT", {"default": 1024, "min": 0, "max": 4096, "step": 16,
                                       "tooltip": "References are fitted to about resolution x resolution pixels "
                                                  "(1024 = ~1MP). 0 keeps each image's own size. Every reference "
                                                  "adds tokens to every step."}),
                "subfolder": ("STRING", {"default": "", "tooltip": "Empty = the model's own folder (qwen21, moss, flux3, fibo2, ltx25)."}),
                "overwrite": ("BOOLEAN", {"default": False}),
            },
            "optional": {
                "vae": ("VAE", {"tooltip": "The model's VAE. Not needed for LTX-2.5."}),
                "scale_mode": ([SCALE_KONTEXT, SCALE_MEGAPIXELS], {
                    "tooltip": "MOSS-Image only. kontext = what the Ostris example workflow does (nearest ~1MP "
                               "preset by aspect, center-cropped). megapixels = keep the full image."}),
                "image_2": ("IMAGE",), "image_3": ("IMAGE",), "image_4": ("IMAGE",),
            },
        }

    def bake(self, model, images, name, resolution, subfolder, overwrite, vae=None,
             scale_mode=SCALE_KONTEXT, image_2=None, image_3=None, image_4=None):
        h = HANDLERS[model]
        frames = _frames(images, image_2, image_3, image_4)
        if not frames:
            raise ValueError("No images to bake.")
        if len(frames) > h.max_refs:
            raise ValueError(f"{len(frames)} references; {h.label} supports at most {h.max_refs} per RefMod.")
        if h.needs_vae_to_bake and vae is None:
            raise ValueError(f"Connect the {h.label} VAE to bake.")
        path = _save_path(name, subfolder.strip() or h.subfolder)
        if os.path.exists(path) and not overwrite:
            # Re-queuing a workflow shouldn't fail: keep the existing file and say so.
            note = (f"{os.path.basename(path)} already exists, skipped. "
                    "Enable overwrite to re-bake, or pick another name.")
            return {"ui": {"text": [note]}, "result": (path,)}

        refs = [h.encode_frame(f, vae, resolution, scale_mode) for f in frames]
        tensors = {}
        for i, r in enumerate(refs):
            if h.stores_latents:
                tensors[f"lat_{i}"] = r["lat"].detach().cpu().float().contiguous().clone()
            if h.stores_images:
                img = (r["img"].clamp(0, 1) * 255.0).round().to(torch.uint8)
                tensors[f"img_{i}"] = img.detach().cpu().contiguous().clone()

        meta = {"format": h.format, "version": 1, "name": os.path.basename(path)[:-len(".safetensors")],
                "count": len(refs), **h.meta_extra(refs, resolution, scale_mode)}
        try:
            meta["thumb"] = _thumb_b64(frames[0])      # preview for the node UI; ignored by every loader
        except Exception as e:                         # PIL missing etc.: the file is still fine
            print(f"[Nougan RefMod] no preview stored: {e}")
        directory = os.path.dirname(path)
        os.makedirs(directory, exist_ok=True)
        fd, tmp = tempfile.mkstemp(prefix=".refmod-", suffix=".tmp", dir=directory)
        os.close(fd)
        try:
            save_file(tensors, tmp, metadata={h.meta_key: json.dumps(meta)})
            os.replace(tmp, path)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)
        _INDEX_CACHE.pop(path, None)
        return {"ui": {"text": [f"Baked {len(refs)} {h.label} reference(s) -> {path}"]}, "result": (path,)}


# ═════════════════════════════════════════════════════════════════════════════
#  Apply
# ═════════════════════════════════════════════════════════════════════════════

class NouganUnifiedRefModApply:
    CATEGORY = "Nougan/RefMod"
    FUNCTION = "apply"
    RETURN_TYPES = ("CONDITIONING", "CONDITIONING", "LATENT")
    RETURN_NAMES = ("positive", "negative", "latent")

    @classmethod
    def INPUT_TYPES(cls):
        names = [NONE] + list_refmods()
        return {
            "required": {
                "model": ([AUTO] + list(HANDLERS), {
                    "tooltip": "auto reads the model from the RefMod file. Pick one explicitly to apply "
                               "extra_image only, or to refuse files from another model."}),
                "refmod_1": (names,),
            },
            "optional": {
                # text-encoder models (Qwen 2.1, MOSS-Image, Fibo 2)
                "clip": ("CLIP", {"tooltip": "Qwen 2.1 / MOSS-Image / Fibo 2: the text encoder."}),
                "prompt": ("STRING", {"multiline": True, "dynamicPrompts": True,
                                      "tooltip": "Qwen 2.1 / MOSS-Image / Fibo 2: encoded here with the references."}),
                "negative_prompt": ("STRING", {"multiline": True, "dynamicPrompts": True}),
                # conditioning models (Flux 3, LTX-2.5)
                "positive": ("CONDITIONING", {"tooltip": "Flux 3 / LTX-2.5: your encoded prompt."}),
                "negative": ("CONDITIONING",),
                "refmod_2": (names,),
                "refmod_3": (names,),
                "extra_image": ("IMAGE", {"tooltip": "Optional plain reference(s), prepared on the fly."}),
                "vae": ("VAE", {"tooltip": "Needed for extra_image, and always for LTX-2.5."}),
                "extra_image_resolution": ("INT", {"default": 1024, "min": 0, "max": 4096, "step": 16}),
                "extra_image_scale": ([SCALE_KONTEXT, SCALE_MEGAPIXELS], {"tooltip": "MOSS-Image only."}),
                "ref_strength": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01, "tooltip": REF_STRENGTH_TIP}),
                "ref_on_negative": ("BOOLEAN", {"default": True, "tooltip": "Also attach the reference latents to the negative (usual for edit models). Turn off if the result looks over-copied."}),
                # LTX-2.5 only
                "latent": ("LATENT", {"tooltip": "LTX-2.5: the video latent the guide frames are added to."}),
                "frame_idx": ("INT", {"default": 0, "min": -9999, "max": 9999, "tooltip": "LTX-2.5: frame the references are placed at."}),
                "strength": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01, "tooltip": "LTX-2.5: guide strength."}),
            },
        }

    @classmethod
    def IS_CHANGED(cls, refmod_1=NONE, refmod_2=NONE, refmod_3=NONE, **kwargs):
        return _stamp(refmod_1, refmod_2, refmod_3)

    @classmethod
    def VALIDATE_INPUTS(cls, **kwargs):
        return True  # combo lists are rebuilt on refresh; missing files raise a clear error at run time

    def apply(self, model, refmod_1, clip=None, prompt="", negative_prompt="", positive=None, negative=None,
              refmod_2=NONE, refmod_3=NONE, extra_image=None, vae=None, extra_image_resolution=1024,
              extra_image_scale=SCALE_KONTEXT, ref_strength=1.0, ref_on_negative=True,
              latent=None, frame_idx=0, strength=1.0):
        handler = None if model == AUTO else HANDLERS[model]
        refs = []
        for rel in (refmod_1, refmod_2, refmod_3):
            if rel and rel != NONE:
                h, got = load_refmod(rel, expect=handler)
                if handler is None:
                    handler = h
                elif h.key != handler.key:
                    raise ValueError(f"Mixed models: '{rel}' is {h.label}, the others are {handler.label}.")
                refs.extend(got)
        if handler is None:
            raise ValueError("Pick a model, or choose a RefMod so the model can be read from it.")

        c = Ctx(handler=handler, refs=refs, clip=clip, prompt=prompt, negative_prompt=negative_prompt,
                positive=positive, negative=negative, extra_image=extra_image, vae=vae,
                extra_image_resolution=extra_image_resolution, extra_image_scale=extra_image_scale,
                ref_strength=float(ref_strength), ref_on_negative=bool(ref_on_negative),
                latent=latent, frame_idx=int(frame_idx), strength=float(strength),
                device=comfy.model_management.intermediate_device())
        return handler.apply(c)


# ═════════════════════════════════════════════════════════════════════════════
#  UI routes (web/nougan_refmods.js)
# ═════════════════════════════════════════════════════════════════════════════

def _library():
    models = [{"key": h.key, "label": h.label, "accent": h.accent, "subfolder": h.subfolder,
               "max_refs": h.max_refs, "token_downscale": h.token_downscale,
               "apply_needs": list(h.apply_needs), "apply_uses": sorted(h.apply_uses),
               "bake_needs": list(h.bake_needs), "bake_uses": sorted(h.bake_uses)}
              for h in HANDLERS.values()]
    refmods = []
    for rel, path, h, meta in _scan():
        sizes = meta.get("sizes") or meta.get("ref_sizes")
        if not sizes and meta.get("shapes"):                       # Flux 3: latent grid * 16
            sizes = [[s[-1] * 16, s[-2] * 16] for s in meta["shapes"]]
        sizes = sizes or []
        ds = h.token_downscale
        refmods.append({"name": rel, "model": h.key, "count": int(meta.get("count", 0)), "sizes": sizes,
                        "tokens": sum((w // ds) * (hh // ds) for w, hh in sizes),
                        "stamp": int(os.path.getmtime(path)), "thumb": bool(meta.get("thumb")) or h.stores_images})
    return {"models": models, "refmods": refmods}


_THUMB_CACHE = {}  # path -> (mtime, jpeg bytes or None)


def _thumb_bytes(rel):
    parts = rel.replace("\\", "/").split("/")
    if not rel or rel.startswith("/") or ntpath.splitdrive(rel)[0] or any(p in _RESERVED for p in parts):
        return None
    for name, path, h, meta in _scan():
        if name != rel:
            continue
        mtime = os.path.getmtime(path)
        hit = _THUMB_CACHE.get(path)
        if hit and hit[0] == mtime:
            return hit[1]
        data = None
        if meta.get("thumb"):
            data = base64.b64decode(meta["thumb"])
        elif h.stores_images:                                      # older files: shrink the stored image
            try:
                with safe_open(path, framework="pt", device="cpu") as f:
                    data = _jpeg_bytes(f.get_tensor("img_0")[0].numpy())
            except Exception:
                data = None
        _THUMB_CACHE[path] = (mtime, data)
        return data
    return None


_ROUTES_DONE = False


def _register_routes():
    global _ROUTES_DONE
    if _ROUTES_DONE:
        return
    try:
        from aiohttp import web
        from server import PromptServer
        routes = PromptServer.instance.routes
    except Exception:
        return

    @routes.get("/nougan/refmod_lib")
    async def _lib(_request):
        try:
            return web.json_response(_library())
        except Exception as e:
            return web.json_response({"models": [], "refmods": [], "error": str(e)})

    @routes.get("/nougan/refmod_lib/thumb")
    async def _thumb(request):
        data = _thumb_bytes(request.query.get("name", ""))
        if not data:
            return web.Response(status=404)
        return web.Response(body=data, content_type="image/jpeg", headers={"Cache-Control": "max-age=3600"})

    _ROUTES_DONE = True


_register_routes()


NODE_CLASS_MAPPINGS = {
    "NouganUnifiedRefModBake": NouganUnifiedRefModBake,
    "NouganUnifiedRefModApply": NouganUnifiedRefModApply,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "NouganUnifiedRefModBake": "Nougan RefMod Bake 🧬",
    "NouganUnifiedRefModApply": "Nougan RefMod Apply 🎯",
}
