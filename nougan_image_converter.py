# nougan_image_converter.py
# Nougan Image Converter / Saver
#
#  • Works as a Save Image node (IMAGE in) or as a loader/converter (load_path).
#  • "Smart Squeeze" finds the smallest file that still meets a perceptual
#    quality target (SSIM), instead of guessing a quality number:
#       PNG / TIFF / BMP  -> always bit-exact: lossless mode reduction (RGBA->RGB,
#                            RGB->gray, <=256 colours -> palette), max deflate,
#                            optional oxipng/zopfli pass if `pip install pyoxipng`.
#       JPEG / WebP / AVIF -> binary-search the lowest quality whose decoded result
#                            still reaches the SSIM target of the chosen tier.
#                            WebP also tries true lossless and keeps the smaller one.
#  • quality_scale 5..10 picks the tier (see TIERS). 10 = pristine.

import io
import json
import os
import random
import string

import numpy as np
import torch
from PIL import Image, ImageOps
from PIL.PngImagePlugin import PngInfo

import folder_paths

try:
    from comfy.cli_args import args as _comfy_args
    _DISABLE_META = bool(getattr(_comfy_args, "disable_metadata", False))
except Exception:
    _DISABLE_META = False

try:
    import oxipng as _oxipng  # optional: pip install pyoxipng
except Exception:
    _oxipng = None

Image.init()
_HAS_AVIF = "AVIF" in Image.SAVE

FORMATS = ["png", "webp", "jpeg", "jpg"] + (["avif"] if _HAS_AVIF else []) + ["tiff", "bmp", "gif"]
PIL_NAME = {"png": "PNG", "webp": "WEBP", "jpeg": "JPEG", "jpg": "JPEG",
            "avif": "AVIF", "tiff": "TIFF", "bmp": "BMP", "gif": "GIF"}

# quality_scale -> (SSIM target, name). Keep in sync with the JS file.
TIERS = {
    5: (0.9300, "Compact"),
    6: (0.9500, "Lean"),
    7: (0.9650, "Balanced"),
    8: (0.9750, "Crisp"),
    9: (0.9850, "Fine"),
    10: (0.9950, "Pristine"),
}
# Plain (non-smart) quality per scale step.
STD_Q = {5: 75, 6: 82, 7: 88, 8: 92, 9: 96, 10: 100}

_LOAD_EXT = (".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff", ".gif", ".avif")


# ───────────────────────────── helpers ─────────────────────────────

def _tensor_to_pil(t):
    a = np.clip(t.detach().cpu().numpy() * 255.0 + 0.5, 0, 255).astype(np.uint8)
    if a.ndim == 2:
        return Image.fromarray(a)
    c = a.shape[-1]
    if c == 1:
        return Image.fromarray(np.ascontiguousarray(a[..., 0]))
    if c == 2:
        return Image.fromarray(np.ascontiguousarray(a))
    if c == 3:
        return Image.fromarray(np.ascontiguousarray(a))
    return Image.fromarray(np.ascontiguousarray(a[..., :4]))


def _has_alpha(img):
    return img.mode in ("RGBA", "LA", "PA") or "transparency" in img.info


def _flatten(img, bg=(255, 255, 255)):
    """For formats without alpha: composite over white, keep gray as L."""
    if _has_alpha(img):
        rgba = img.convert("RGBA")
        base = Image.new("RGB", rgba.size, bg)
        base.paste(rgba, mask=rgba.getchannel("A"))
        return base
    return img if img.mode in ("L", "RGB") else img.convert("RGB")


def _arr(img):
    return np.asarray(img.convert("RGB"))


def _dec(data):
    with Image.open(io.BytesIO(data)) as im:
        im.load()
        return np.asarray(im.convert("RGB"))


def _enc(img, fmt, **kw):
    buf = io.BytesIO()
    img.save(buf, format=fmt, **kw)
    return buf.getvalue()


def _load_from_path(path):
    path = os.path.expanduser(str(path).strip().strip('"'))
    if os.path.isdir(path):
        files = sorted(os.path.join(path, f) for f in os.listdir(path) if f.lower().endswith(_LOAD_EXT))
    elif os.path.isfile(path):
        files = [path]
    else:
        files = []
    out = []
    for f in files:
        try:
            with Image.open(f) as im:
                im = ImageOps.exif_transpose(im)
                im.load()
                im = im.convert("RGBA" if _has_alpha(im) else "RGB")
            out.append(im)
        except Exception as e:
            print(f"[Nougan] ⚠️  could not load {f}: {e}")
    return out


# ─────────────────── perceptual metric (SSIM, numpy) ───────────────────

def _box(x, w):
    c = np.pad(x.cumsum(0).cumsum(1), ((1, 0), (1, 0)))
    return (c[w:, w:] - c[:-w, w:] - c[w:, :-w] + c[:-w, :-w]) / float(w * w)


def _ssim(a, b, win=7, rows=512):
    if a.shape != b.shape:
        return 0.0
    if np.array_equal(a, b):
        return 1.0
    h, w = a.shape[:2]
    win = max(2, min(win, h, w))
    c1, c2 = (0.01 * 255) ** 2, (0.03 * 255) ** 2
    total = 0.0
    for ch in range(a.shape[2]):
        acc, cnt = 0.0, 0
        for r0 in range(0, max(1, h - win + 1), rows):
            r1 = min(r0 + rows + win - 1, h)
            x = a[r0:r1, :, ch].astype(np.float64)
            y = b[r0:r1, :, ch].astype(np.float64)
            mx, my = _box(x, win), _box(y, win)
            sxx = _box(x * x, win) - mx * mx
            syy = _box(y * y, win) - my * my
            sxy = _box(x * y, win) - mx * my
            m = ((2 * mx * my + c1) * (2 * sxy + c2)) / ((mx * mx + my * my + c1) * (sxx + syy + c2))
            acc += float(m.sum())
            cnt += m.size
        total += acc / max(cnt, 1)
    return total / a.shape[2]


def _search(enc, ref, target, lo, hi):
    """Smallest quality in [lo, hi] whose decoded output reaches `target` SSIM."""
    cache = {}

    def test(q):
        if q not in cache:
            d = enc(q)
            cache[q] = (d, _ssim(ref, _dec(d)))
        return cache[q]

    while lo < hi:
        mid = (lo + hi) // 2
        if test(mid)[1] >= target:
            hi = mid
        else:
            lo = mid + 1
    d, s = test(lo)
    return lo, d, s


# ───────────────────── lossless mode reduction ─────────────────────

def _reduce(img):
    """Bit-exact mode reduction: opaque alpha dropped, gray -> L, <=256 colours -> P."""
    if img.mode not in ("RGB", "RGBA", "L", "LA"):
        img = img.convert("RGBA" if _has_alpha(img) else "RGB")
    if img.mode in ("L", "LA"):
        return img
    a = np.asarray(img)
    if img.mode == "RGBA":
        alpha = a[..., 3]
        rgb = a[..., :3]
        if (alpha == 255).all():
            a = np.ascontiguousarray(rgb)
        else:
            if (rgb[..., 0] == rgb[..., 1]).all() and (rgb[..., 1] == rgb[..., 2]).all():
                return Image.fromarray(np.ascontiguousarray(np.dstack([rgb[..., 0], alpha])))
            return img
    if (a[..., 0] == a[..., 1]).all() and (a[..., 1] == a[..., 2]).all():
        return Image.fromarray(np.ascontiguousarray(a[..., 0]))
    h, w = a.shape[:2]
    packed = (a[..., 0].astype(np.uint32) << 16) | (a[..., 1].astype(np.uint32) << 8) | a[..., 2].astype(np.uint32)
    flat = packed.ravel()
    step = max(1, flat.size // 50000)
    if np.unique(flat[::step]).size > 256:
        return Image.fromarray(a)
    uniq, inv = np.unique(flat, return_inverse=True)
    if uniq.size > 256:
        return Image.fromarray(a)
    pal = np.stack([(uniq >> 16) & 255, (uniq >> 8) & 255, uniq & 255], axis=1).astype(np.uint8).ravel().tolist()
    out = Image.frombytes("P", (w, h), inv.reshape(h, w).astype(np.uint8).tobytes())
    out.putpalette(pal)
    return out


def _oxi(data, scale):
    if _oxipng is None:
        return data, False
    try:
        kw = {"level": {5: 2, 6: 3, 7: 4, 8: 4, 9: 5, 10: 6}[scale]}
        if scale >= 10 and hasattr(_oxipng, "Zopfli"):
            kw["deflate"] = _oxipng.Zopfli(iterations=15)
        out = _oxipng.optimize_from_memory(data, **kw)
        return (out, True) if len(out) < len(data) else (data, False)
    except Exception as e:
        print(f"[Nougan] oxipng pass skipped: {e}")
        return data, False


# ───────────────────────── per-format encoders ─────────────────────────
# Each returns (bytes, info) where info = {lossless, ssim, detail}

def _do_png(img, smart, scale, meta):
    pnginfo = meta.get("pnginfo")
    if not smart:
        return _enc(img, "PNG", pnginfo=pnginfo, compress_level=4), {"lossless": True, "ssim": 1.0, "detail": "zlib 4"}
    base = img if img.mode in ("L", "LA", "RGB", "RGBA") else img.convert("RGBA" if _has_alpha(img) else "RGB")
    red = _reduce(base)
    variants = [red] + ([base] if red.mode != base.mode else [])
    best, tag = None, ""
    for v in variants:
        d = _enc(v, "PNG", pnginfo=pnginfo, optimize=True, compress_level=9)
        if best is None or len(d) < len(best):
            best, tag = d, ("mode→" + v.mode if v.mode != base.mode else "deflate 9")
    best, used = _oxi(best, scale)
    if used:
        tag += " + oxipng"
    return best, {"lossless": True, "ssim": 1.0, "detail": tag}


def _do_jpeg(img, smart, scale, meta):
    img = _flatten(img)
    extra = {"exif": meta["exif"]} if meta.get("exif") else {}
    if not smart:
        sub = 0 if scale >= 9 else 2
        return _enc(img, "JPEG", quality=STD_Q[scale], subsampling=sub, **extra), \
            {"lossless": False, "ssim": None, "detail": f"q{STD_Q[scale]}"}
    target = TIERS[scale][0]
    ref = _arr(img)
    results = []
    for sub, name in ((2, "4:2:0"), (0, "4:4:4")):
        q, d, s = _search(lambda q, sub=sub: _enc(img, "JPEG", quality=q, subsampling=sub,
                                                  optimize=True, progressive=True, **extra),
                          ref, target, 40, 100)
        results.append((len(d), d, s, f"q{q} · {name}"))
    results.sort(key=lambda r: (r[2] < target, r[0]))
    _, d, s, tag = results[0]
    if s < target:
        # Very grainy image: the tier can't be reached without ballooning the file.
        # Fall back to a high-quality 4:4:4 encode and say so.
        d = _enc(img, "JPEG", quality=95, subsampling=0, optimize=True, progressive=True, **extra)
        s = _ssim(ref, _dec(d))
        tag = "q95 · 4:4:4 · best effort (grainy)"
    return d, {"lossless": False, "ssim": s, "detail": tag}


def _do_webp(img, smart, scale, meta):
    img = img.convert("RGBA" if _has_alpha(img) else "RGB")
    extra = {"exif": meta["exif"]} if meta.get("exif") else {}
    if not smart:
        if scale >= 10:
            return _enc(img, "WEBP", lossless=True, quality=80, method=4, exact=True, **extra), \
                {"lossless": True, "ssim": 1.0, "detail": "lossless"}
        return _enc(img, "WEBP", quality=STD_Q[scale], method=4, **extra), \
            {"lossless": False, "ssim": None, "detail": f"q{STD_Q[scale]}"}
    target = TIERS[scale][0]
    ref = _arr(img)
    cands = []
    ll = _enc(img, "WEBP", lossless=True, quality=50, method=4, exact=True, **extra)
    q, d, s = _search(lambda q: _enc(img, "WEBP", quality=q, method=4, alpha_quality=100, **extra),
                      ref, target, 40, 100)
    if s >= target:
        d6 = _enc(img, "WEBP", quality=q, method=6, alpha_quality=100, **extra)
        s6 = _ssim(ref, _dec(d6))
        if s6 >= target and len(d6) < len(d):
            d, s = d6, s6
    # Heavy lossless pass only when lossless is competitive (graphics, flat art, scale 10)
    if len(ll) < len(d) * 1.3 or scale >= 10:
        if img.size[0] * img.size[1] <= 4_200_000:
            ll2 = _enc(img, "WEBP", lossless=True, quality=75, method=6, exact=True, **extra)
            if len(ll2) < len(ll):
                ll = ll2
    cands.append((len(ll), ll, 1.0, "lossless", True))
    tag = f"q{q}"
    if s < target and len(ll) > 2 * len(d):
        # Grainy image: target unreachable lossy, lossless would be huge. Best effort instead.
        d = _enc(img, "WEBP", quality=95, method=4, alpha_quality=100, **extra)
        s = _ssim(ref, _dec(d))
        tag = "q95 · best effort (grainy)"
        cands.append((len(d), d, 1.0, tag, False))  # treated as passing so it wins on size
        cands[-1] = (len(d), d, s, tag, False)
        _, d, s, tag, lossless = min(cands, key=lambda r: r[0])
        return d, {"lossless": lossless, "ssim": s, "detail": tag}
    cands.append((len(d), d, s, tag, False))
    cands.sort(key=lambda r: (r[2] < target, r[0]))
    _, d, s, tag, lossless = cands[0]
    return d, {"lossless": lossless, "ssim": s, "detail": tag}


def _do_avif(img, smart, scale, meta):
    img = img.convert("RGBA" if _has_alpha(img) else "RGB")
    if not smart:
        return _enc(img, "AVIF", quality=STD_Q[scale], speed=6, subsampling="4:4:4"), \
            {"lossless": False, "ssim": None, "detail": f"q{STD_Q[scale]}"}
    target = TIERS[scale][0]
    ref = _arr(img)
    q, d, s = _search(lambda q: _enc(img, "AVIF", quality=q, speed=6, subsampling="4:4:4"), ref, target, 40, 100)
    tag = f"q{q} · 4:4:4"
    if s < target:
        d = _enc(img, "AVIF", quality=90, speed=6, subsampling="4:4:4")
        s = _ssim(ref, _dec(d))
        tag = "q90 · best effort (grainy)"
    return d, {"lossless": False, "ssim": s, "detail": tag}


def _do_tiff(img, smart, scale, meta):
    if not smart:
        return _enc(img, "TIFF", compression="raw"), {"lossless": True, "ssim": 1.0, "detail": "raw"}
    red = _reduce(img)
    best, tag = None, ""
    for comp in ("tiff_adobe_deflate", "tiff_lzw"):
        try:
            d = _enc(red, "TIFF", compression=comp)
        except Exception:
            continue
        if best is None or len(d) < len(best):
            best, tag = d, comp.replace("tiff_", "")
    return best, {"lossless": True, "ssim": 1.0, "detail": tag}


def _do_bmp(img, smart, scale, meta):
    img = _flatten(img)
    if smart:
        red = _reduce(img)
        if red.mode in ("L", "P", "RGB"):
            img = red
    return _enc(img, "BMP"), {"lossless": True, "ssim": 1.0, "detail": img.mode}


def _do_gif(img, smart, scale, meta):
    rgb = _flatten(img).convert("RGB")
    red = _reduce(rgb)
    if red.mode == "P":
        pal, lossless = red, True
    else:
        pal = rgb.quantize(256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.FLOYDSTEINBERG)
        lossless = False
    d = _enc(pal, "GIF", optimize=smart)
    s = 1.0 if lossless else _ssim(_arr(rgb), _dec(d))
    return d, {"lossless": lossless, "ssim": s, "detail": "256-colour" if not lossless else "exact palette"}


_ENCODERS = {"PNG": _do_png, "JPEG": _do_jpeg, "WEBP": _do_webp, "AVIF": _do_avif,
             "TIFF": _do_tiff, "BMP": _do_bmp, "GIF": _do_gif}


def _baseline(img, pil_fmt, meta):
    """Size of a typical 'standard' export, used to show how much Smart Squeeze saved."""
    try:
        if pil_fmt == "PNG":
            return len(_enc(img, "PNG", pnginfo=meta.get("pnginfo"), compress_level=4))
        if pil_fmt == "JPEG":
            kw = {"exif": meta["exif"]} if meta.get("exif") else {}
            return len(_enc(_flatten(img), "JPEG", quality=95, **kw))
        if pil_fmt == "WEBP":
            kw = {"exif": meta["exif"]} if meta.get("exif") else {}
            return len(_enc(img.convert("RGBA" if _has_alpha(img) else "RGB"), "WEBP", quality=90, method=4, **kw))
        if pil_fmt == "AVIF":
            return len(_enc(img.convert("RGB"), "AVIF", quality=80, speed=6, subsampling="4:4:4"))
        if pil_fmt == "TIFF":
            return len(_enc(img, "TIFF", compression="raw"))
        if pil_fmt == "BMP":
            return len(_enc(_flatten(img), "BMP"))
        if pil_fmt == "GIF":
            return len(_enc(_flatten(img).convert("P", palette=Image.Palette.ADAPTIVE), "GIF"))
    except Exception:
        pass
    return None


def _build_meta(prompt, extra_pnginfo):
    meta = {"pnginfo": None, "exif": None}
    if _DISABLE_META:
        return meta
    pi = PngInfo()
    if prompt is not None:
        pi.add_text("prompt", json.dumps(prompt))
    if extra_pnginfo is not None:
        for k in extra_pnginfo:
            pi.add_text(k, json.dumps(extra_pnginfo[k]))
    meta["pnginfo"] = pi
    try:
        ex = Image.Exif()
        if prompt is not None:
            ex[0x0110] = "prompt:" + json.dumps(prompt)
        if extra_pnginfo is not None:
            for i, k in enumerate(extra_pnginfo):
                ex[0x010F - i] = f"{k}:{json.dumps(extra_pnginfo[k])}"
        b = ex.tobytes()
        meta["exif"] = b if len(b) < 60000 else None  # JPEG EXIF segment limit is 64 KB
        meta["exif_big"] = b
    except Exception:
        pass
    return meta


# ───────────────────────────── the node ─────────────────────────────

class NouganImageConverter:
    CATEGORY = "Nougan/Image"
    FUNCTION = "run"
    OUTPUT_NODE = True
    RETURN_TYPES = ("IMAGE", "STRING", "STRING")
    RETURN_NAMES = ("images", "file_paths", "report")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "filename_prefix": ("STRING", {"default": "Nougan/image", "tooltip": "Folder/prefix inside the output directory."}),
                "format": (FORMATS, {"default": "webp"}),
                "smart_squeeze": ("BOOLEAN", {"default": True, "label_on": "Smart Squeeze on", "label_off": "Smart Squeeze off",
                                              "tooltip": "Finds the smallest file that still meets the quality tier. PNG/TIFF/BMP stay bit-exact."}),
                "quality_scale": ("INT", {"default": 8, "min": 5, "max": 10, "step": 1, "display": "slider",
                                          "tooltip": "5 Compact · 6 Lean · 7 Balanced · 8 Crisp · 9 Fine · 10 Pristine"}),
                "embed_workflow": ("BOOLEAN", {"default": True, "label_on": "Embed workflow", "label_off": "Strip metadata"}),
                "save_mode": (["save to output", "preview only"], {"default": "save to output"}),
            },
            "optional": {
                "images": ("IMAGE", {"tooltip": "Connect an image to save/convert it."}),
                "load_path": ("STRING", {"default": "", "tooltip": "Used when no image is connected: a file or a folder to load and convert."}),
            },
            "hidden": {"prompt": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO"},
        }

    @classmethod
    def IS_CHANGED(cls, load_path="", **kwargs):
        p = os.path.expanduser(str(load_path or "").strip().strip('"'))
        try:
            if os.path.isfile(p):
                return str(os.path.getmtime(p))
            if os.path.isdir(p):
                return str(sum(os.path.getmtime(os.path.join(p, f)) for f in os.listdir(p)))
        except Exception:
            pass
        return ""

    def run(self, filename_prefix, format, smart_squeeze, quality_scale, embed_workflow, save_mode,
            images=None, load_path="", prompt=None, extra_pnginfo=None):
        scale = int(max(5, min(10, quality_scale)))
        fmt_key = format.lower()
        pil_fmt = PIL_NAME[fmt_key]
        ext = "jpg" if fmt_key == "jpg" else ("jpeg" if fmt_key == "jpeg" else fmt_key)

        if images is not None:
            pil_list = [_tensor_to_pil(images[i]) for i in range(images.shape[0])]
        elif str(load_path).strip():
            pil_list = _load_from_path(load_path)
            if not pil_list:
                raise ValueError(f"[Nougan Image Converter] No images found at: {load_path}")
        else:
            raise ValueError("[Nougan Image Converter] Connect an image or set load_path.")

        meta = _build_meta(prompt, extra_pnginfo) if embed_workflow else {"pnginfo": None, "exif": None}

        if save_mode == "preview only":
            out_dir, ftype = folder_paths.get_temp_directory(), "temp"
            prefix = "nougan_tmp_" + "".join(random.choice(string.ascii_lowercase) for _ in range(6))
        else:
            out_dir, ftype = folder_paths.get_output_directory(), "output"
            prefix = filename_prefix

        encoder = _ENCODERS[pil_fmt]
        ui_images, stats, paths = [], [], []

        for img in pil_list:
            w, h = img.size
            data, info = encoder(img, smart_squeeze, scale, meta)
            base = _baseline(img, pil_fmt, meta) if smart_squeeze else None

            folder, name, counter, subfolder, _ = folder_paths.get_save_image_path(prefix, out_dir, w, h)
            os.makedirs(folder, exist_ok=True)
            fname = f"{name}_{counter:05}_.{ext}"
            full = os.path.join(folder, fname)
            with open(full, "wb") as f:
                f.write(data)
            paths.append(full)

            if pil_fmt != "TIFF":
                ui_images.append({"filename": fname, "subfolder": subfolder, "type": ftype})
            stats.append({
                "name": fname, "format": fmt_key, "bytes": len(data), "baseline": base,
                "ssim": info.get("ssim"), "lossless": bool(info.get("lossless")),
                "detail": info.get("detail", ""), "w": w, "h": h,
                "tier": TIERS[scale][1] if smart_squeeze else None,
            })

        lines = []
        for s in stats:
            sv = ""
            if s["baseline"]:
                sv = f"  ({(1 - s['bytes'] / s['baseline']) * 100:+.1f}% vs standard)"
            lines.append(f"{s['name']}: {s['bytes'] / 1024:.1f} KB{sv} · {s['detail']}")
        report = "\n".join(lines)

        if images is not None:
            out_t = images
        else:
            first = pil_list[0].size
            arrs = []
            for im in pil_list:
                rgb = im.convert("RGB")
                if rgb.size != first:
                    rgb = rgb.resize(first, Image.LANCZOS)
                arrs.append(np.asarray(rgb).astype(np.float32) / 255.0)
            out_t = torch.from_numpy(np.stack(arrs))

        return {"ui": {"images": ui_images, "nougan_stats": stats},
                "result": (out_t, "\n".join(paths), report)}
