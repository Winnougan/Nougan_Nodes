# nougan_gif_maker.py  —  Nougan GIF Maker by Winnougan
#
# VIDEO (Load Video) or IMAGE batch in  ->  visual trim / crop / size editor inside the node
# ->  animated GIF / WebP / MP4 out (socials-ready), plus the trimmed frames as IMAGE.
#
# Only external dependency is ffmpeg: either a system ffmpeg on PATH, or `pip install imageio-ffmpeg`.
#
# How it works:
#   1. Queue the workflow once. The node saves a small scrub-friendly preview proxy to ComfyUI's temp
#      folder and tells the JS editor (web/nougan_gif_maker.js) where it is.
#   2. Edit the range / crop / size in the node. Everything is stored in normal widgets.
#   3. Hit "Export" in the node. That calls /nougan/gif/export (no workflow re-queue) and ffmpeg
#      writes the file to  output/nougan_gif/.  Or tick `export_on_run` to export on every queue.

import os
import re
import json
import uuid
import shutil
import hashlib
import asyncio
import subprocess

import numpy as np
import torch

import folder_paths

MAX_FRAMES = 600     # cap on the IMAGE output so a long range can't eat all your RAM
PROXY_WIDTH = 720    # width of the preview proxy the editor plays / scrubs
FORMATS = ["gif", "webp", "mp4"]
DITHERS = ["sierra2_4a", "bayer", "floyd_steinberg", "none"]
_NOWIN = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0

_DEFAULTS = dict(
    start_sec=0.0, end_sec=5.0, width=480, fps=15, format="gif", max_colors=256,
    dither="sierra2_4a", quality=75, loop_count=0, speed=1.0,
    crop_x=0.0, crop_y=0.0, crop_w=1.0, crop_h=1.0, filename_prefix="nougan_gif",
)


# ─────────────────────────────────────────────────────────────────────────────
#  ffmpeg helpers
# ─────────────────────────────────────────────────────────────────────────────
_FFMPEG = None


def _ffmpeg():
    global _FFMPEG
    if _FFMPEG and os.path.isfile(_FFMPEG):
        return _FFMPEG
    exe = shutil.which("ffmpeg")
    if not exe:
        try:
            import imageio_ffmpeg
            exe = imageio_ffmpeg.get_ffmpeg_exe()
        except Exception:
            exe = None
    if not exe:
        raise RuntimeError("ffmpeg not found. Install ffmpeg, or run:  pip install imageio-ffmpeg")
    _FFMPEG = exe
    return exe


def _run(cmd, timeout=900):
    p = subprocess.run(cmd, capture_output=True, timeout=timeout, creationflags=_NOWIN)
    if p.returncode != 0:
        raise RuntimeError("ffmpeg failed: " + p.stderr.decode("utf-8", "replace").strip()[-600:])
    return p


def _probe(path):
    """Duration / size / fps via `ffmpeg -i` (no ffprobe needed)."""
    p = subprocess.run([_ffmpeg(), "-hide_banner", "-i", path], capture_output=True, creationflags=_NOWIN)
    err = p.stderr.decode("utf-8", "replace")

    v = re.search(r"Stream #[^\n]*Video:[^\n]*", err)
    if not v:
        raise RuntimeError("No video stream found in the source.")
    line = v.group(0)
    d = re.search(r",\s*(\d{2,5})x(\d{2,5})", line)
    if not d:
        raise RuntimeError("Could not read the video size.")
    w, h = int(d.group(1)), int(d.group(2))
    fm = re.search(r"(\d+(?:\.\d+)?)\s*fps", line)
    fps = float(fm.group(1)) if fm else 24.0
    rot = re.search(r"rotation of (-?\d+(?:\.\d+)?) degrees", err)
    if rot and int(round(abs(float(rot.group(1))))) % 180 == 90:
        w, h = h, w  # ffmpeg auto-rotates, so the real frame is swapped

    m = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", err)
    duration = (int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))) if m else 0.0
    if duration <= 0:  # Duration: N/A (some webm / raw streams) -> decode to null and read the clock
        q = subprocess.run([_ffmpeg(), "-hide_banner", "-i", path, "-an", "-f", "null", "-"],
                           capture_output=True, creationflags=_NOWIN)
        ts = re.findall(r"time=(\d+):(\d+):(\d+(?:\.\d+)?)", q.stderr.decode("utf-8", "replace"))
        if ts:
            a, b, c = ts[-1]
            duration = int(a) * 3600 + int(b) * 60 + float(c)
    if duration <= 0:
        raise RuntimeError("Could not determine the video duration.")
    return dict(duration=duration, width=w, height=h, fps=fps)


# ─────────────────────────────────────────────────────────────────────────────
#  Temp / source management
# ─────────────────────────────────────────────────────────────────────────────
def _tmp_root():
    d = os.path.join(folder_paths.get_temp_directory(), "nougan_gif")
    os.makedirs(d, exist_ok=True)
    return d


def _token_dir(token):
    # tokens are 24 hex chars we generate ourselves; reject anything else (no path tricks)
    if not isinstance(token, str) or not re.fullmatch(r"[0-9a-f]{24}", token):
        raise ValueError("Missing or bad token. Queue the workflow once to load the video.")
    return os.path.join(_tmp_root(), token)


def _load_meta(token):
    p = os.path.join(_token_dir(token), "meta.json")
    if not os.path.isfile(p):
        raise ValueError("Preview expired (temp folder was cleared). Queue the workflow again.")
    with open(p, "r", encoding="utf-8") as f:
        meta = json.load(f)
    if not os.path.isfile(meta.get("source", "")):
        raise ValueError("Source video is gone. Queue the workflow again.")
    return meta


def _frames_to_mp4(images, fps, out):
    """IMAGE batch [N,H,W,C] -> near-lossless mp4 so the rest of the pipeline can treat it like a video."""
    n, h, w = int(images.shape[0]), int(images.shape[1]), int(images.shape[2])
    cmd = [_ffmpeg(), "-y", "-hide_banner", "-loglevel", "error",
           "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}", "-r", f"{float(fps):.4f}", "-i", "-",
           "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
           "-c:v", "libx264", "-crf", "12", "-pix_fmt", "yuv420p", out]
    p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=_NOWIN)
    try:
        for i in range(0, n, 16):
            chunk = (images[i:i + 16, :, :, :3].clamp(0, 1) * 255).round().to(torch.uint8).cpu().numpy()
            p.stdin.write(chunk.tobytes())
        p.stdin.close()
        err = p.stderr.read()
        p.wait()
    except Exception:
        p.kill()
        raise
    if p.returncode != 0:
        raise RuntimeError("ffmpeg failed: " + err.decode("utf-8", "replace").strip()[-600:])


def _make_proxy(src, dst):
    _run([_ffmpeg(), "-y", "-hide_banner", "-loglevel", "error", "-i", src, "-an",
          "-vf", f"scale=min({PROXY_WIDTH}\\,iw):-2",
          "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-pix_fmt", "yuv420p",
          "-movflags", "+faststart", dst])


def _prepare_source(video, images, images_fps):
    """Resolve the input to a real file on disk, build the preview proxy, return meta (incl. token)."""
    src = None
    token = None

    if video is not None:
        try:  # Load Video gives us a file-backed VIDEO: use the file in place, no copy
            ss = video.get_stream_source()
            if isinstance(ss, str) and os.path.isfile(ss):
                src = os.path.abspath(ss)
        except Exception:
            src = None
        if src:
            st = os.stat(src)
            token = hashlib.sha1(f"{src}|{st.st_mtime_ns}|{st.st_size}".encode()).hexdigest()[:24]
    elif images is None:
        raise ValueError("GIF Maker: connect a VIDEO (Load Video) or an IMAGE batch.")

    if token is None:
        token = uuid.uuid4().hex[:24]
    tdir = _token_dir(token)
    meta_path = os.path.join(tdir, "meta.json")
    proxy = os.path.join(tdir, "proxy.mp4")

    # same file as last time and the proxy is still there -> reuse
    if src and os.path.isfile(meta_path) and os.path.isfile(proxy):
        try:
            with open(meta_path, "r", encoding="utf-8") as f:
                meta = json.load(f)
            if meta.get("source") == src:
                return meta
        except Exception:
            pass

    os.makedirs(tdir, exist_ok=True)

    if not src:
        src = os.path.join(tdir, "source.mp4")
        if video is not None:
            try:
                video.save_to(src)
            except Exception:
                comps = video.get_components()
                _frames_to_mp4(comps.images, float(comps.frame_rate), src)
        else:
            _frames_to_mp4(images, float(images_fps), src)

    info = _probe(src)
    _make_proxy(src, proxy)
    meta = dict(token=token, source=src, **info)
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta, f)
    return meta


# ─────────────────────────────────────────────────────────────────────────────
#  Settings / geometry
# ─────────────────────────────────────────────────────────────────────────────
def _clamp(v, a, b):
    return min(b, max(a, v))


def _even(n):
    return max(2, int(n) // 2 * 2)


def _clean(raw):
    s = dict(_DEFAULTS)
    for k in _DEFAULTS:
        if raw.get(k) is not None:
            s[k] = raw[k]
    for k in ("start_sec", "end_sec", "speed", "crop_x", "crop_y", "crop_w", "crop_h"):
        s[k] = float(s[k])
    for k in ("width", "fps", "max_colors", "quality", "loop_count"):
        s[k] = int(s[k])
    s["format"] = s["format"] if s["format"] in FORMATS else "gif"
    s["dither"] = s["dither"] if s["dither"] in DITHERS else "sierra2_4a"
    s["speed"] = _clamp(s["speed"], 0.25, 4.0)
    s["fps"] = _clamp(s["fps"], 1, 60)
    s["width"] = _clamp(s["width"], 16, 3840)
    s["max_colors"] = _clamp(s["max_colors"], 2, 256)
    s["quality"] = _clamp(s["quality"], 1, 100)
    prefix = re.sub(r"[^\w\-. ]", "_", str(s["filename_prefix"])).strip(" .") or "nougan_gif"
    s["filename_prefix"] = prefix[:80]
    return s


def _plan(meta, s):
    dur, W, H = meta["duration"], meta["width"], meta["height"]
    start = _clamp(s["start_sec"], 0.0, max(dur - 0.05, 0.0))
    end = s["end_sec"]
    if end <= start:
        end = dur
    end = min(end, dur)
    length = max(end - start, 0.05)

    cx = _clamp(s["crop_x"], 0.0, 0.98)
    cy = _clamp(s["crop_y"], 0.0, 0.98)
    cw = _clamp(s["crop_w"], 0.02, 1.0 - cx)
    ch = _clamp(s["crop_h"], 0.02, 1.0 - cy)
    full = cx <= 0.0005 and cy <= 0.0005 and cw >= 0.9995 and ch >= 0.9995
    px, py = int(round(cx * W)), int(round(cy * H))
    pw = _even(min(round(cw * W), W - px))
    ph = _even(min(round(ch * H), H - py))

    ow = _even(min(s["width"], pw))
    oh = _even(round(ph * ow / pw))
    return dict(start=start, end=end, length=length, full=full, crop=(pw, ph, px, py), ow=ow, oh=oh)


def _vf(plan, s):
    parts = []
    if not plan["full"]:
        parts.append("crop={}:{}:{}:{}".format(*plan["crop"]))
    parts += [
        f"setpts=(PTS-STARTPTS)/{s['speed']:.4f}",
        f"fps={s['fps']}",
        f"scale={plan['ow']}:{plan['oh']}:flags=lanczos",
    ]
    return ",".join(parts)


# ─────────────────────────────────────────────────────────────────────────────
#  Encode / decode / export
# ─────────────────────────────────────────────────────────────────────────────
def _encode(meta, s, plan, out, t0=None, tlen=None):
    t0 = plan["start"] if t0 is None else t0
    tlen = plan["length"] if tlen is None else tlen
    chain = _vf(plan, s)
    fmt = s["format"]
    cmd = [_ffmpeg(), "-y", "-hide_banner", "-loglevel", "error",
           "-ss", f"{t0:.3f}", "-t", f"{tlen:.3f}", "-i", meta["source"], "-an"]

    if fmt == "gif":
        d = s["dither"]
        dither = "none" if d == "none" else ("bayer:bayer_scale=3" if d == "bayer" else d)
        fc = (f"[0:v]{chain},split[a][b];"
              f"[a]palettegen=max_colors={s['max_colors']}:stats_mode=diff[p];"
              f"[b][p]paletteuse=dither={dither}:diff_mode=rectangle")
        cmd += ["-filter_complex", fc, "-loop", str(s["loop_count"])]
    elif fmt == "webp":
        loop = 1 if s["loop_count"] < 0 else s["loop_count"]
        cmd += ["-vf", chain, "-c:v", "libwebp_anim", "-lossless", "0",
                "-q:v", str(s["quality"]), "-loop", str(loop)]
    else:  # mp4 — WhatsApp / Telegram treat short silent mp4s as GIFs
        crf = int(round(36 - s["quality"] * 0.21))
        cmd += ["-vf", chain, "-c:v", "libx264", "-preset", "medium", "-crf", str(crf),
                "-pix_fmt", "yuv420p", "-movflags", "+faststart"]
    cmd.append(out)
    _run(cmd)


def _decode_frames(meta, s, plan):
    """Trimmed / cropped / resized frames as a float IMAGE batch (same look as the export)."""
    ow, oh = plan["ow"], plan["oh"]
    cmd = [_ffmpeg(), "-hide_banner", "-loglevel", "error",
           "-ss", f"{plan['start']:.3f}", "-t", f"{plan['length']:.3f}", "-i", meta["source"], "-an",
           "-vf", _vf(plan, s), "-frames:v", str(MAX_FRAMES),
           "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
    p = _run(cmd)
    fsz = ow * oh * 3
    n = len(p.stdout) // fsz
    if n == 0:
        return torch.zeros((1, oh, ow, 3), dtype=torch.float32)
    arr = np.frombuffer(p.stdout[: n * fsz], dtype=np.uint8).reshape(n, oh, ow, 3).copy()
    return torch.from_numpy(arr).float() / 255.0


def _next_output(prefix, ext):
    d = os.path.join(folder_paths.get_output_directory(), "nougan_gif")
    os.makedirs(d, exist_ok=True)
    pat = re.compile(re.escape(prefix) + r"_(\d+)\." + re.escape(ext) + r"$")
    nums = [int(m.group(1)) for m in (pat.match(f) for f in os.listdir(d)) if m]
    name = f"{prefix}_{(max(nums) + 1) if nums else 1:05d}.{ext}"
    return os.path.join(d, name), "nougan_gif", name


def _export_file(meta, s):
    plan = _plan(meta, s)
    path, sub, name = _next_output(s["filename_prefix"], s["format"])
    _encode(meta, s, plan, path)
    return dict(filename=name, subfolder=sub, type="output", bytes=os.path.getsize(path),
                path=path, format=s["format"], width=plan["ow"], height=plan["oh"])


def _estimate(meta, s):
    """Encode ~1s from the middle of the range and extrapolate. Exact when the range is short."""
    plan = _plan(meta, s)
    length, sample = plan["length"], 1.0
    tmp = os.path.join(_token_dir(meta["token"]), f"est_{uuid.uuid4().hex[:8]}.{s['format']}")
    try:
        if length <= sample * 1.2:
            _encode(meta, s, plan, tmp)
            size, exact = os.path.getsize(tmp), True
        else:
            _encode(meta, s, plan, tmp, plan["start"] + (length - sample) / 2, sample)
            size, exact = os.path.getsize(tmp) * (length / sample), False
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass
    return dict(bytes=int(size), exact=exact, width=plan["ow"], height=plan["oh"],
                frames=int(round(length / s["speed"] * s["fps"])))


# ─────────────────────────────────────────────────────────────────────────────
#  The node
# ─────────────────────────────────────────────────────────────────────────────
class NouganGifMaker:
    CATEGORY = "Nougan"
    FUNCTION = "run"
    OUTPUT_NODE = True
    RETURN_TYPES = ("IMAGE", "STRING")
    RETURN_NAMES = ("frames", "file_path")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "start_sec": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 36000.0, "step": 0.01,
                                        "tooltip": "Clip start in seconds (drag the handles in the editor)."}),
                "end_sec": ("FLOAT", {"default": 5.0, "min": 0.0, "max": 36000.0, "step": 0.01,
                                      "tooltip": "Clip end in seconds. 0 or less than start = to the end of the video."}),
                "width": ("INT", {"default": 480, "min": 16, "max": 3840, "step": 2,
                                  "tooltip": "Output width in px. Height follows the crop's aspect ratio."}),
                "fps": ("INT", {"default": 15, "min": 1, "max": 60}),
                "format": (FORMATS, {"default": "gif",
                                     "tooltip": "gif = universal. webp = way smaller. mp4 = what WhatsApp/Telegram really want."}),
                "max_colors": ("INT", {"default": 256, "min": 2, "max": 256, "tooltip": "GIF palette size."}),
                "dither": (DITHERS, {"default": "sierra2_4a", "tooltip": "GIF only. bayer = smallest files."}),
                "quality": ("INT", {"default": 75, "min": 1, "max": 100, "tooltip": "WebP / MP4 only."}),
                "loop_count": ("INT", {"default": 0, "min": -1, "max": 1000,
                                       "tooltip": "0 = loop forever, -1 = play once (GIF)."}),
                "speed": ("FLOAT", {"default": 1.0, "min": 0.25, "max": 4.0, "step": 0.05}),
                "crop_x": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 1.0, "step": 0.001}),
                "crop_y": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 1.0, "step": 0.001}),
                "crop_w": ("FLOAT", {"default": 1.0, "min": 0.02, "max": 1.0, "step": 0.001}),
                "crop_h": ("FLOAT", {"default": 1.0, "min": 0.02, "max": 1.0, "step": 0.001}),
                "filename_prefix": ("STRING", {"default": "nougan_gif"}),
                "export_on_run": ("BOOLEAN", {"default": False,
                                              "tooltip": "Also write the file every time the workflow runs."}),
            },
            "optional": {
                "video": ("VIDEO",),
                "images": ("IMAGE",),
                "images_fps": ("FLOAT", {"default": 24.0, "min": 1.0, "max": 120.0, "step": 0.5,
                                         "tooltip": "Frame rate of the IMAGE batch (ignored for VIDEO)."}),
            },
        }

    def run(self, start_sec, end_sec, width, fps, format, max_colors, dither, quality, loop_count,
            speed, crop_x, crop_y, crop_w, crop_h, filename_prefix, export_on_run,
            video=None, images=None, images_fps=24.0):
        meta = _prepare_source(video, images, images_fps)
        s = _clean(dict(start_sec=start_sec, end_sec=end_sec, width=width, fps=fps, format=format,
                        max_colors=max_colors, dither=dither, quality=quality, loop_count=loop_count,
                        speed=speed, crop_x=crop_x, crop_y=crop_y, crop_w=crop_w, crop_h=crop_h,
                        filename_prefix=filename_prefix))
        plan = _plan(meta, s)
        frames = _decode_frames(meta, s, plan)

        out_path = ""
        if export_on_run:
            out_path = _export_file(meta, s)["path"]

        ui = dict(token=meta["token"], duration=meta["duration"], width=meta["width"],
                  height=meta["height"], fps=meta["fps"])
        return {"ui": {"nougan_gif": [ui]}, "result": (frames, out_path)}


# ─────────────────────────────────────────────────────────────────────────────
#  API routes (called by the editor's Export button + size estimate)
# ─────────────────────────────────────────────────────────────────────────────
def _api_export(body):
    meta = _load_meta(body.get("token"))
    return _export_file(meta, _clean(body.get("settings") or {}))


def _api_estimate(body):
    meta = _load_meta(body.get("token"))
    return _estimate(meta, _clean(body.get("settings") or {}))


_ROUTES_DONE = False


def _register_routes():
    global _ROUTES_DONE
    if _ROUTES_DONE:
        return
    try:
        from server import PromptServer
        from aiohttp import web
        routes = PromptServer.instance.routes
    except Exception:
        return

    async def _handle(request, fn):
        try:
            body = await request.json()
            loop = asyncio.get_running_loop()
            res = await loop.run_in_executor(None, fn, body)
            return web.json_response(res)
        except Exception as e:
            return web.json_response({"error": str(e)}, status=500)

    @routes.post("/nougan/gif/export")
    async def _gif_export(request):
        return await _handle(request, _api_export)

    @routes.post("/nougan/gif/estimate")
    async def _gif_estimate(request):
        return await _handle(request, _api_estimate)

    _ROUTES_DONE = True


_register_routes()

NODE_CLASS_MAPPINGS = {"NouganGifMaker": NouganGifMaker}
NODE_DISPLAY_NAME_MAPPINGS = {"NouganGifMaker": "Nougan GIF Maker 🎞️"}
