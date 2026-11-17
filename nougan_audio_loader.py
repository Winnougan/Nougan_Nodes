"""nougan_audio_loader.py — Nougan Audio Loader 🎵

Load an audio file, scrub it on a DOM waveform, trim from either side.
Outputs ComfyUI AUDIO ({"waveform": [1, C, T], "sample_rate": int}) plus the
trimmed duration (FLOAT) and sample rate (INT) — handy for Duration -> Frames.

Decode chain (first one that works wins):
  torchaudio -> soundfile -> stdlib wave (PCM .wav) -> ffmpeg (PATH or imageio-ffmpeg)
so mp3/m4a/opus/etc. work even on torch nightlies where torchaudio has no backend.

Registers GET /nougan/audio_loader/peaks (min/max envelope for the JS editor).
"""

import os
import io
import wave
import shutil
import asyncio
import tempfile
import subprocess

import numpy as np
import torch
import torch.nn.functional as F

import folder_paths

# ─────────────────────────────────────────────────────────────────────────────
# Decoding
# ─────────────────────────────────────────────────────────────────────────────

_AUDIO_EXTS = (".mp3", ".wav", ".flac", ".ogg", ".oga", ".opus", ".m4a", ".aac",
               ".wma", ".aif", ".aiff", ".webm", ".mp4", ".mkv", ".mov", ".avi")


def _ffmpeg_exe():
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


def _pcm_to_float(raw, sampwidth):
    if sampwidth == 1:
        return (np.frombuffer(raw, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
    if sampwidth == 2:
        return np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    if sampwidth == 3:
        b = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 3)
        a = (b[:, 0].astype(np.int32) | (b[:, 1].astype(np.int32) << 8)
             | (b[:, 2].astype(np.int32) << 16))
        a = np.where(a & 0x800000, a - 0x1000000, a)
        return a.astype(np.float32) / 8388608.0
    if sampwidth == 4:
        return np.frombuffer(raw, dtype="<i4").astype(np.float32) / 2147483648.0
    raise ValueError(f"unsupported PCM sample width: {sampwidth}")


def _load_waveform(path):
    """Return (FloatTensor [C, T] in -1..1, sample_rate). Raises if nothing can decode it."""
    # 1) torchaudio (fast path when a backend exists)
    try:
        import torchaudio
        wf, sr = torchaudio.load(path)
        if wf.numel() > 0 and sr > 0:
            return wf.float(), int(sr)
    except Exception:
        pass

    # 2) soundfile (wav / flac / ogg, mp3 on libsndfile >= 1.1)
    try:
        import soundfile as sf
        data, sr = sf.read(path, dtype="float32", always_2d=True)
        if data.size and sr > 0:
            return torch.from_numpy(data.T.copy()), int(sr)
    except Exception:
        pass

    # 3) stdlib wave — plain PCM .wav, zero dependencies
    try:
        with wave.open(path, "rb") as w:
            sr, ch, sw = w.getframerate(), w.getnchannels(), w.getsampwidth()
            raw = w.readframes(w.getnframes())
        a = _pcm_to_float(raw, sw)
        if a.size and sr > 0:
            return torch.from_numpy(a.reshape(-1, ch).T.copy()), int(sr)
    except Exception:
        pass

    # 4) ffmpeg -> temp 16-bit WAV (seekable file = valid header, unlike a pipe)
    exe = _ffmpeg_exe()
    if exe is None:
        raise RuntimeError(
            "Could not decode this audio. Put ffmpeg on PATH, or "
            "`pip install imageio-ffmpeg` / `pip install soundfile`.")
    flags = 0x08000000 if os.name == "nt" else 0  # CREATE_NO_WINDOW
    with tempfile.TemporaryDirectory(prefix="nougan_audio_") as td:
        out = os.path.join(td, "decoded.wav")
        proc = subprocess.run(
            [exe, "-hide_banner", "-v", "error", "-y", "-i", path,
             "-vn", "-acodec", "pcm_s16le", "-f", "wav", out],
            capture_output=True, creationflags=flags)
        if proc.returncode != 0 or not os.path.isfile(out):
            err = proc.stderr.decode("utf-8", "ignore")[-400:]
            raise RuntimeError(f"ffmpeg failed: {err or 'no output'}")
        with wave.open(out, "rb") as w:
            sr, ch = w.getframerate(), w.getnchannels()
            raw = w.readframes(w.getnframes())
    a = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    if not a.size or sr <= 0:
        raise RuntimeError("file contains no audio samples")
    return torch.from_numpy(a.reshape(-1, ch).T.copy()), int(sr)


# ─────────────────────────────────────────────────────────────────────────────
# Peaks (min/max envelope) + small cache
# ─────────────────────────────────────────────────────────────────────────────

_BASE_BUCKETS = 8192          # computed once per file, downsampled per request
_PEAK_CACHE = {}              # (realpath, mtime_ns, size) -> entry
_CACHE_MAX = 24


def _compute_peaks(wf, buckets=_BASE_BUCKETS):
    """Per-bucket [min, max] across all channels (no stereo phase cancellation)."""
    x = wf.unsqueeze(1)                                        # [C, 1, T]
    mx = F.adaptive_max_pool1d(x, buckets).amax(dim=0)[0]      # [B]
    mn = (-F.adaptive_max_pool1d(-x, buckets)).amin(dim=0)[0]  # [B]
    return torch.stack([mn, mx], dim=-1).cpu().numpy()


def _resample_peaks(pk, out):
    n = pk.shape[0]
    if out == n:
        return pk
    starts = (np.arange(out) * n) // out
    if out > n:
        return pk[starts]
    return np.stack([np.minimum.reduceat(pk[:, 0], starts),
                     np.maximum.reduceat(pk[:, 1], starts)], axis=-1)


def _peaks_for(path, buckets):
    st = os.stat(path)
    key = (os.path.realpath(path), st.st_mtime_ns, st.st_size)
    ent = _PEAK_CACHE.get(key)
    if ent is None:
        wf, sr = _load_waveform(path)
        t = wf.shape[-1]
        if t == 0 or sr <= 0:
            raise RuntimeError("file contains no audio samples")
        ent = {"peaks": _compute_peaks(wf), "duration": t / sr,
               "sample_rate": sr, "channels": int(wf.shape[0])}
        _PEAK_CACHE[key] = ent
        while len(_PEAK_CACHE) > _CACHE_MAX:
            _PEAK_CACHE.pop(next(iter(_PEAK_CACHE)))
    pk = _resample_peaks(ent["peaks"], buckets)
    return {"duration": ent["duration"], "sample_rate": ent["sample_rate"],
            "channels": ent["channels"], "buckets": buckets,
            "peaks": np.round(pk, 4).tolist()}


# ─────────────────────────────────────────────────────────────────────────────
# Route — guarded, path-contained, decode off the event loop
# ─────────────────────────────────────────────────────────────────────────────

def _register_routes():
    try:
        from server import PromptServer
        from aiohttp import web
    except Exception:
        return
    routes = getattr(getattr(PromptServer, "instance", None), "routes", None)
    if routes is None:
        return

    @routes.get("/nougan/audio_loader/peaks")
    async def _nougan_audio_peaks(request):
        try:
            filename = request.query.get("filename", "")
            if not filename:
                return web.json_response({"error": "filename required"}, status=400)
            try:
                buckets = max(64, min(4096, int(request.query.get("buckets", "1600"))))
            except ValueError:
                buckets = 1600
            real = os.path.realpath(folder_paths.get_annotated_filepath(filename))
            roots = [os.path.realpath(folder_paths.get_input_directory()),
                     os.path.realpath(folder_paths.get_output_directory()),
                     os.path.realpath(folder_paths.get_temp_directory())]
            if not any(real == r or real.startswith(r + os.sep) for r in roots):
                return web.json_response({"error": "path outside ComfyUI directories"}, status=403)
            if not os.path.isfile(real):
                return web.json_response({"error": "file not found"}, status=404)
            loop = asyncio.get_running_loop()
            data = await loop.run_in_executor(None, _peaks_for, real, buckets)
            return web.json_response(data)
        except Exception as e:
            return web.json_response({"error": f"{type(e).__name__}: {e}"}, status=500)


_register_routes()


# ─────────────────────────────────────────────────────────────────────────────
# Node
# ─────────────────────────────────────────────────────────────────────────────

class NouganAudioLoader:
    """Load audio, scrub the waveform, trim from either side. end_time = 0 means 'to the end'."""

    @classmethod
    def INPUT_TYPES(cls):
        input_dir = folder_paths.get_input_directory()
        try:
            files = [f for f in os.listdir(input_dir)
                     if os.path.isfile(os.path.join(input_dir, f))]
            files = folder_paths.filter_files_content_types(files, ["audio", "video"])
        except Exception:
            files = [f for f in os.listdir(input_dir) if f.lower().endswith(_AUDIO_EXTS)]
        return {
            "required": {
                "audio": (sorted(files) or [""], {"audio_upload": True}),
                "start_time": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 1e9,
                                         "step": 0.01, "round": 0.001}),
                "end_time": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 1e9,
                                       "step": 0.01, "round": 0.001}),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = ("AUDIO", "FLOAT", "INT")
    RETURN_NAMES = ("AUDIO", "duration_sec", "sample_rate")
    FUNCTION = "load"
    CATEGORY = "Nougan"
    DESCRIPTION = ("Audio loader with a DOM waveform editor: drag the edge handles to trim, "
                   "drag the body to scrub (audible preview on release), space to play the "
                   "selection. end_time = 0 keeps the full tail.")

    def load(self, audio, start_time=0.0, end_time=0.0, unique_id=None):
        path = folder_paths.get_annotated_filepath(audio)
        wf, sr = _load_waveform(path)                      # [C, T]
        total = wf.shape[-1]
        if total == 0 or sr <= 0:
            raise RuntimeError(f"'{audio}' contains no audio samples")
        dur = total / sr

        s = max(0.0, float(start_time))
        e = dur if float(end_time) <= 0.0 else min(float(end_time), dur)
        if e <= s:                                       # degenerate selection -> 1 sample
            e = min(s + 1.0 / sr, dur)
            s = max(0.0, e - 1.0 / sr)
        i0 = min(max(int(round(s * sr)), 0), total - 1)
        i1 = min(max(int(round(e * sr)), i0 + 1), total)

        out = {"waveform": wf[:, i0:i1].unsqueeze(0).contiguous(), "sample_rate": sr}
        return (out, (i1 - i0) / sr, sr)

    @classmethod
    def VALIDATE_INPUTS(cls, audio, **kwargs):
        if not folder_paths.exists_annotated_filepath(audio):
            return f"Audio file not found: {audio}"
        return True

    @classmethod
    def IS_CHANGED(cls, audio, start_time=0.0, end_time=0.0, **kwargs):
        try:
            st = os.stat(folder_paths.get_annotated_filepath(audio))
            return (st.st_mtime_ns, st.st_size, float(start_time), float(end_time))
        except Exception:
            return float("nan")


NODE_CLASS_MAPPINGS = {"NouganAudioLoader": NouganAudioLoader}
NODE_DISPLAY_NAME_MAPPINGS = {"NouganAudioLoader": "Nougan Audio Loader 🎵"}