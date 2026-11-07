# nougan_convert_video.py — Nougan suite
# HandBrake-style transcoder. IMAGE batch + AUDIO in -> trim / cut / crop in
# the visual editor (web/nougan_convert_video.js) -> H.264 / H.265 / AV1,
# 8- or 10-bit, via ffmpeg (CPU encoders, or NVENC when present).
#
# The editor's visuals come from a thumbnail/audio cache this module writes
# after each run (see _write_cache). Registers its own /nougan/convert/*
# routes (probe + cache; local requests only).

import os
import re
import json
import wave
import shutil
import tempfile
import subprocess
import hashlib
from fractions import Fraction

import torch
from PIL import Image

import folder_paths

_MODULE_DIR = os.path.dirname(os.path.abspath(__file__))
_CACHE_DIR = os.path.join(_MODULE_DIR, "cache", "convert_video")
MAX_THUMBS = 600
PREVIEW_SR = 22050

FFMPEG = shutil.which("ffmpeg")
if not FFMPEG:
    try:
        import imageio_ffmpeg
        FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        FFMPEG = None

# label -> (encoder, pix_fmt, crf_flag, crf_min, crf_max, crf_default)
_SPECS = {
    "H.264":               ("libx264",    "yuv420p",     "-crf", 0, 51, 23),
    "H.264 10-bit":        ("libx264",    "yuv420p10le", "-crf", 0, 51, 23),
    "H.265":               ("libx265",    "yuv420p",     "-crf", 0, 51, 28),
    "H.265 10-bit":        ("libx265",    "yuv420p10le", "-crf", 0, 51, 28),
    "AV1":                 ("__AV1__",    "yuv420p",     "-crf", 0, 63, 32),
    "AV1 10-bit":          ("__AV1__",    "yuv420p10le", "-crf", 0, 63, 32),
    "H.264 (NVENC)":       ("h264_nvenc", "yuv420p",     "-cq",  0, 51, 23),
    "H.265 (NVENC)":       ("hevc_nvenc", "yuv420p",     "-cq",  0, 51, 28),
    "H.265 10-bit (NVENC)": ("hevc_nvenc", "p010le",     "-cq",  0, 51, 28),
    "AV1 (NVENC)":         ("av1_nvenc",  "yuv420p",     "-cq",  0, 51, 32),
    "AV1 10-bit (NVENC)":  ("av1_nvenc",  "p010le",      "-cq",  0, 51, 32),
}
_BASE_LABELS = ["H.264", "H.264 10-bit", "H.265", "H.265 10-bit", "AV1", "AV1 10-bit"]


def _preset_args(enc, preset):
    if enc in ("libx264", "libx265"):
        return ["-preset", {"fast": "veryfast", "balanced": "medium", "slow": "slow"}[preset]]
    if enc == "libsvtav1":
        return ["-preset", {"fast": "11", "balanced": "8", "slow": "6"}[preset]]
    if enc == "libaom-av1":
        return ["-cpu-used", {"fast": "8", "balanced": "4", "slow": "2"}[preset], "-row-mt", "1"]
    if enc.endswith("_nvenc"):
        return ["-preset", {"fast": "p2", "balanced": "p4", "slow": "p6"}[preset]]
    return []


# ── probe (cached after first call) ──────────────────────────────────────────
_probe_cache = None


def probe():
    """What encoders/filters this ffmpeg has. Served to the frontend so the
    codec dropdown only lists what will actually run."""
    global _probe_cache
    if _probe_cache is not None:
        return _probe_cache
    caps = {"ffmpeg": bool(FFMPEG), "encoders": [], "pix_fmts": {}, "zscale": False}
    if FFMPEG:
        try:
            out = subprocess.run([FFMPEG, "-hide_banner", "-encoders"],
                                 capture_output=True, text=True, timeout=30).stdout
            for name in ("libx264", "libx265", "libsvtav1", "libaom-av1",
                         "h264_nvenc", "hevc_nvenc", "av1_nvenc"):
                if re.search(r"\b" + name + r"\b", out):
                    caps["encoders"].append(name)
            filt = subprocess.run([FFMPEG, "-hide_banner", "-filters"],
                                  capture_output=True, text=True, timeout=30).stdout
            caps["zscale"] = bool(re.search(r"\bzscale\b", filt))
            for name in caps["encoders"]:
                h = subprocess.run([FFMPEG, "-hide_banner", "-h", f"encoder={name}"],
                                   capture_output=True, text=True, timeout=30).stdout
                caps["pix_fmts"][name] = {
                    "10bit": ("yuv420p10le" in h) or ("p010le" in h),
                }
        except Exception:
            pass
    caps["codecs"] = [
        {"label": l, "ok": _codec_available(l, caps)} for l in _BASE_LABELS
    ]
    nv = caps["pix_fmts"]
    if "h264_nvenc" in caps["encoders"]:
        caps["codecs"].append({"label": "H.264 (NVENC)", "ok": True})
    if "hevc_nvenc" in caps["encoders"]:
        caps["codecs"].append({"label": "H.265 (NVENC)", "ok": True})
        if nv.get("hevc_nvenc", {}).get("10bit"):
            caps["codecs"].append({"label": "H.265 10-bit (NVENC)", "ok": True})
    if "av1_nvenc" in caps["encoders"]:
        caps["codecs"].append({"label": "AV1 (NVENC)", "ok": True})
        if nv.get("av1_nvenc", {}).get("10bit"):
            caps["codecs"].append({"label": "AV1 10-bit (NVENC)", "ok": True})
    _probe_cache = caps
    return caps


def _codec_available(label, caps):
    enc, pix, *_ = _SPECS[label]
    if enc == "__AV1__":
        return ("libsvtav1" in caps["encoders"]) or ("libaom-av1" in caps["encoders"])
    if enc not in caps["encoders"]:
        return False
    if pix in ("yuv420p10le", "p010le"):
        return caps["pix_fmts"].get(enc, {}).get("10bit", False)
    return True


def _resolve(label, caps):
    enc, pix, crf_flag, lo, hi, dflt = _SPECS[label]
    if enc == "__AV1__":
        enc = "libsvtav1" if "libsvtav1" in caps["encoders"] else "libaom-av1"
    if enc not in caps["encoders"]:
        raise RuntimeError(
            f"[Nougan Convert Video] encoder '{enc}' not available in this ffmpeg. "
            f"Pick another codec (the dropdown greys these out)."
        )
    return enc, pix, crf_flag, lo, hi, dflt


# ── helpers ──────────────────────────────────────────────────────────────────

def _parse_segments(segments, dur, n, fps):
    """JSON [[start,end],...] seconds -> list of (sec_start, sec_end) clamped,
    gapless order preserved. [] / bad input = full range."""
    try:
        segs = json.loads(segments) if segments else []
        segs = [[float(a), float(b)] for a, b in segs if float(b) - float(a) > 0.001]
    except Exception:
        segs = []
    if not segs:
        segs = [[0.0, dur]]
    out = []
    for a, b in segs:
        a = min(max(a, 0.0), dur)
        b = min(max(b, 0.0), dur)
        if b - a > 0.001:
            out.append([a, b])
    return out or [[0.0, dur]]


def _parse_crop(crop, w0, h0):
    """JSON {x,y,w,h} source pixels -> (x, y, w, h) clamped, even dimensions.
    "" / bad input = no crop."""
    try:
        c = json.loads(crop) if crop else None
        if not c:
            return 0, 0, w0 & ~1, h0 & ~1   # yuv420p needs even dimensions
        x = int(c["x"]); y = int(c["y"])
        cw = int(c["w"]); ch = int(c["h"])
    except Exception:
        return 0, 0, w0 & ~1, h0 & ~1
    x = min(max(x, 0), w0 - 2)
    y = min(max(y, 0), h0 - 2)
    cw = min(cw & ~1, w0 - x) & ~1
    ch = min(ch & ~1, h0 - y) & ~1
    if cw < 16 or ch < 16:
        raise ValueError(f"[Nougan Convert Video] crop too small ({cw}x{ch}); min 16x16, even dims.")
    return x, y, cw, ch


def _kept_frames(segs, fps, n):
    idx = []
    for a, b in segs:
        f0 = min(n, max(0, int(round(a * fps))))
        f1 = min(n, max(f0, int(round(b * fps))))
        idx.extend(range(f0, f1))
    # de-dup while keeping order (overlapping segments)
    seen = set()
    out = []
    for i in idx:
        if i not in seen:
            seen.add(i)
            out.append(i)
    return out


def _write_wav(path, wf, sr):
    """wf: [channels, samples] float -1..1 -> 16-bit PCM wav."""
    pcm = (wf.clamp(-1, 1) * 32767).to(torch.int16).numpy()
    with wave.open(path, "wb") as w:
        w.setnchannels(pcm.shape[0])
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.T.copy().tobytes())


def _unpack_media(media, audio, fps):
    """Accept either an IMAGE batch (tensor) or a VIDEO object (Load Video etc).

    Returns (frames[N,H,W,C], audio, fps_float, fps_arg_for_ffmpeg).
    For VIDEO the clip's own frame rate wins over the fps widget (so the cut list
    maps to the right frames) and its audio track is used unless an AUDIO input
    is connected."""
    if torch.is_tensor(media):
        return media, audio, float(fps), f"{float(fps):g}"

    get_components = getattr(media, "get_components", None)
    if callable(get_components):
        comps = get_components()
        frames = getattr(comps, "images", None)
        if frames is None:
            raise ValueError("[Nougan Convert Video] the VIDEO input has no frames.")
        out_fps, fps_arg = float(fps), f"{float(fps):g}"
        rate = getattr(comps, "frame_rate", None)
        if rate:
            try:
                fr = Fraction(rate).limit_denominator(100000)
                out_fps = float(fr)
                # exact rational (e.g. 30000/1001) keeps audio in sync on 29.97 / 23.976 clips
                fps_arg = f"{fr.numerator}/{fr.denominator}"
            except Exception:
                out_fps = float(rate)
                fps_arg = f"{out_fps:g}"
        if audio is None:
            audio = getattr(comps, "audio", None)
        return frames, audio, out_fps, fps_arg

    raise TypeError(
        f"[Nougan Convert Video] unsupported input type {type(media).__name__}; "
        "connect an IMAGE batch or a VIDEO."
    )


# ── the node ─────────────────────────────────────────────────────────────────

class NouganConvertVideo:
    CATEGORY = "Nougan"
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("filepath",)
    FUNCTION = "convert"
    OUTPUT_NODE = True   # runs on its own (no downstream output node needed) and can send UI updates
    DESCRIPTION = (
        "HandBrake-style transcode: IMAGE frames or a VIDEO (+ audio) in, H.264/H.265/AV1 "
        "8- or 10-bit out. Trim, cut and crop in the visual editor."
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # "IMAGE,VIDEO" = one socket that takes an image batch OR a video
                # (Load Video, etc.). Key stays "images" so saved workflows keep working.
                "images": ("IMAGE,VIDEO", {"tooltip": "Image batch or video. A video's own fps and audio are used automatically."}),
                "codec": (_BASE_LABELS, {"default": "H.264"}),
                "preset": (["fast", "balanced", "slow"], {"default": "balanced"}),
                "crf": ("INT", {"default": 23, "min": 0, "max": 63, "step": 1,
                                "tooltip": "Quality: lower = better (x264/x265: 18-28, AV1: 25-40)."}),
                "tonemap": (["none", "pq_to_sdr", "hlg_to_sdr"], {"default": "none",
                            "tooltip": "Only if the incoming frames are HDR; needs ffmpeg with libzimg (zscale)."}),
                "fps": ("FLOAT", {"default": 24.0, "min": 1.0, "max": 240.0, "step": 0.5,
                                  "tooltip": "Frames-per-second of an incoming IMAGE batch (ignored when a VIDEO is connected: its own fps is used)."}),
                "segments": ("STRING", {"default": "[]",
                                        "tooltip": "Cut list in seconds, set by the editor. [] = full range."}),
                "crop": ("STRING", {"default": "", "tooltip": "Crop box in source pixels, set by the editor."}),
            },
            "optional": {
                "audio": ("AUDIO",),
                "filename_prefix": ("STRING", {"default": "nougan_convert"}),
            }
        }

    def convert(self, images, codec, preset, crf, tonemap, fps, segments, crop,
                audio=None, filename_prefix="nougan_convert"):
        if not FFMPEG:
            raise RuntimeError("[Nougan Convert Video] ffmpeg not found. Install it or `pip install imageio-ffmpeg`.")

        caps = probe()
        enc, pix, crf_flag, crf_lo, crf_hi, crf_dflt = _resolve(codec, caps)
        crf = min(max(int(crf), crf_lo), crf_hi)

        # IMAGE batch or VIDEO -> frames tensor (+ audio + fps taken from the video if given)
        tens, audio, fps, fps_arg = _unpack_media(images, audio, fps)
        tens = tens.detach().cpu()
        if tens.dtype != torch.float32:
            tens = tens.float()
        if tens.dim() == 3:
            tens = tens.unsqueeze(0)
        tens = tens[..., :3]            # drop alpha if present (rawvideo is rgb24 / rgb48)
        n, h0, w0, _ = tens.shape       # no full-clip copy: values are clamped per frame below
        a_len = (audio["waveform"].shape[-1] / audio["sample_rate"]) if audio is not None else 0.0
        dur = max(a_len, n / fps)

        segs = _parse_segments(segments, dur, n, fps)
        kept = _kept_frames(segs, fps, n)
        if not kept:
            raise ValueError("[Nougan Convert Video] cut list removes every frame.")

        cx, cy, cw, ch = _parse_crop(crop, w0, h0)

        # ── audio: slice + concat the kept ranges, write temp wav ──
        wav_path = None
        tmp_paths = []
        if audio is not None:
            wf = audio["waveform"].detach().cpu().float()
            if wf.dim() == 3:
                wf = wf[0]  # [channels, samples]
            sr = audio["sample_rate"]
            parts = [wf[:, int(a * sr):int(b * sr)] for a, b in segs]
            parts = [p for p in parts if p.shape[-1] > 16]
            if parts:
                kept_audio = torch.cat(parts, dim=-1)
                fd, wav_path = tempfile.mkstemp(suffix=".wav")
                os.close(fd)
                tmp_paths.append(wav_path)
                _write_wav(wav_path, kept_audio, sr)

        # ── tonemap filter ──
        vf = []
        if tonemap != "none":
            if not caps["zscale"]:
                raise RuntimeError("[Nougan Convert Video] tonemap needs ffmpeg with libzimg (zscale filter).")
            tin = "smpte2084" if tonemap == "pq_to_sdr" else "arib-std-b67"
            vf.append(f"zscale=tin={tin}:min=bt2020nc:t=bt709:m=bt709:r=full")
        vf.append(f"format={pix}")

        ten_bit = pix in ("yuv420p10le", "p010le")
        raw_pix = "rgb48le" if ten_bit else "rgb24"

        cmd = [FFMPEG, "-y", "-hide_banner", "-loglevel", "error",
               "-f", "rawvideo", "-pix_fmt", raw_pix,
               "-s", f"{cw}x{ch}", "-r", fps_arg, "-i", "-"]
        if wav_path:
            cmd += ["-i", wav_path]
        cmd += ["-map", "0:v"]
        if wav_path:
            cmd += ["-map", "1:a", "-c:a", "aac", "-b:a", "192k"]
        cmd += ["-vf", ",".join(vf), "-c:v", enc]
        cmd += _preset_args(enc, preset)
        cmd += [crf_flag, str(crf), "-pix_fmt", pix]
        if enc in ("libx265", "hevc_nvenc"):
            cmd += ["-tag:v", "hvc1"]
        if wav_path:
            cmd += ["-shortest"]
        out_path = _unique_output(filename_prefix)
        cmd += [out_path]

        # ── stream frames ──
        scale = 65535.0 if ten_bit else 255.0
        np_dtype = "<u2" if ten_bit else "u1"
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            for fi in kept:
                fr = tens[fi, cy:cy + ch, cx:cx + cw, :].clamp(0, 1)
                arr = (fr * scale).round().numpy().astype(np_dtype)
                proc.stdin.write(arr.tobytes())
            proc.stdin.close()
        except BrokenPipeError:
            pass
        err = proc.stderr.read().decode("utf-8", "ignore")
        if proc.wait() != 0:
            raise RuntimeError(f"[Nougan Convert Video] ffmpeg failed:\n{err[-2500:]}")
        for p in tmp_paths:
            try:
                os.remove(p)
            except OSError:
                pass

        self._write_cache(tens, audio, fps, dur, w0, h0, n)
        # "ui" makes the frontend fire onExecuted, which refreshes the editor's thumbnails
        return {"ui": {"text": [out_path]}, "result": (out_path,)}

    # ── editor preview cache ──
    def _write_cache(self, tens, audio, fps, dur, w0, h0, n):
        try:
            a_len = 0
            sig_src = f"{n}x{w0}x{h0}:{fps:.3f}:{dur:.3f}"
            sig_src += f":{tens[0].mean().item():.5f}:{tens[n // 2].mean().item():.5f}"
            if audio is not None:
                wf = audio["waveform"].detach().cpu().float()
                if wf.dim() == 3:
                    wf = wf[0]
                a_len = wf.shape[-1] / audio["sample_rate"]
                sig_src += f":{wf.shape[-1]}:{wf[:, : min(4096, wf.shape[-1])].mean().item():.5f}"
            key = hashlib.sha256(sig_src.encode()).hexdigest()[:24]
            cdir = os.path.join(_CACHE_DIR, key)
            os.makedirs(cdir, exist_ok=True)

            manifest = {"key": key, "src_n": n, "fps": fps, "w": w0, "h": h0,
                        "dur": dur, "has_audio": audio is not None}

            # thumbnails of the SOURCE frames (editor scrubs source time)
            tcount = min(MAX_THUMBS, n)
            indices = [int(round(i * (n - 1) / max(1, tcount - 1))) for i in range(tcount)]
            tw = min(320, w0)
            th = max(1, round(tw * h0 / w0))
            for ti, fi in enumerate(indices):
                img = (tens[fi].clamp(0, 1) * 255).byte().numpy()
                Image.fromarray(img).resize((tw, th), Image.BILINEAR).save(
                    os.path.join(cdir, f"t_{ti:04d}.jpg"), quality=72)
            manifest["n"] = tcount
            manifest["tw"] = tw
            manifest["th"] = th

            if audio is not None:
                wf = audio["waveform"].detach().cpu().float()
                if wf.dim() == 3:
                    wf = wf[0]
                sr = audio["sample_rate"]
                mono = wf.mean(dim=0, keepdim=True)
                stride = max(1, int(round(sr / PREVIEW_SR)))
                mono = mono[:, ::stride]
                _write_wav(os.path.join(cdir, "audio.wav"), mono, PREVIEW_SR)

            with open(os.path.join(cdir, "manifest.json"), "w", encoding="utf-8") as f:
                json.dump(manifest, f)
            # remember the newest cache for the routes
            with open(os.path.join(_CACHE_DIR, "latest.json"), "w", encoding="utf-8") as f:
                json.dump({"key": key}, f)
            # prune old caches, keep the newest 5
            _prune_cache()
        except Exception as e:
            print(f"[Nougan Convert Video] preview cache not written: {e}")


def _prune_cache(keep=5):
    try:
        dirs = []
        for name in os.listdir(_CACHE_DIR):
            p = os.path.join(_CACHE_DIR, name)
            if os.path.isdir(p):
                dirs.append((os.path.getmtime(p), name))
        dirs.sort(reverse=True)
        for _, name in dirs[keep:]:
            shutil.rmtree(os.path.join(_CACHE_DIR, name), ignore_errors=True)
    except Exception:
        pass


def _unique_output(prefix):
    prefix = re.sub(r"[^\w\-]+", "_", str(prefix)).strip("_") or "nougan_convert"
    out_dir = folder_paths.get_output_directory()
    candidate = os.path.join(out_dir, f"{prefix}.mp4")
    i = 1
    while os.path.exists(candidate):
        candidate = os.path.join(out_dir, f"{prefix}_{i:05d}.mp4")
        i += 1
    return candidate


# ── routes (registered at import; fully guarded) ─────────────────────────────

def register_routes():
    try:
        from server import PromptServer
        from aiohttp import web
    except Exception:
        return
    try:
        routes = PromptServer.instance.routes
    except Exception:
        return
    if getattr(register_routes, "_done", False):
        return
    register_routes._done = True

    def _local(request):
        return request.remote in ("127.0.0.1", "::1", "localhost")

    def _latest():
        try:
            with open(os.path.join(_CACHE_DIR, "latest.json"), encoding="utf-8") as f:
                return json.load(f).get("key", "")
        except Exception:
            return ""

    @routes.get("/nougan/convert/probe")
    async def _probe(_request):
        return web.json_response(probe())

    @routes.get("/nougan/convert/manifest")
    async def _manifest(_request):
        key = _latest()
        if not key:
            return web.json_response({"error": "no cache yet"}, status=404)
        try:
            with open(os.path.join(_CACHE_DIR, key, "manifest.json"), encoding="utf-8") as f:
                return web.json_response(json.load(f))
        except Exception:
            return web.json_response({"error": "no manifest"}, status=404)

    @routes.get("/nougan/convert/thumb")
    async def _thumb(request):
        if not _local(request):
            return web.Response(status=403)
        key = request.query.get("k", "")
        if not re.fullmatch(r"[0-9a-f]{24}", key):
            return web.Response(status=400)
        try:
            i = int(request.query.get("i", "-1"))
            mf = json.load(open(os.path.join(_CACHE_DIR, key, "manifest.json"), encoding="utf-8"))
            if not (0 <= i < int(mf.get("n", 0))):
                return web.Response(status=400)
            p = os.path.join(_CACHE_DIR, key, f"t_{i:04d}.jpg")
            return web.Response(body=open(p, "rb").read(), content_type="image/jpeg")
        except Exception:
            return web.Response(status=404)

    @routes.get("/nougan/convert/audio")
    async def _audio(request):
        if not _local(request):
            return web.Response(status=403)
        key = request.query.get("k", "")
        if not re.fullmatch(r"[0-9a-f]{24}", key):
            return web.Response(status=400)
        try:
            p = os.path.join(_CACHE_DIR, key, "audio.wav")
            return web.Response(body=open(p, "rb").read(), content_type="audio/wav")
        except Exception:
            return web.Response(status=404)

    print("  [Nougan] Convert Video routes registered (/nougan/convert/*)")


register_routes()


NODE_CLASS_MAPPINGS = {"NouganConvertVideo": NouganConvertVideo}
NODE_DISPLAY_NAME_MAPPINGS = {"NouganConvertVideo": "Nougan Convert Video 🎞️"}
