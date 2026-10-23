"""Nougan Save Video.

Frames (+ optional audio) -> H.264 / H.265 / AV1 / VP9 / ProRes / FFV1 video, using ffmpeg.
Pairs with web/nougan_save_video.js, which draws the player, scrub bar and info chips.

ffmpeg is found on PATH first, then through `pip install imageio-ffmpeg`. For AV1 and HEVC
you want a *full* ffmpeg build (for example the "full" build from gyan.dev). The player
in the node shows which encoders your ffmpeg has.
"""

import asyncio
import functools
import json
import os
import random
import re
import shutil
import string
import subprocess
import tempfile
import wave

import numpy as np

import folder_paths

TAG = "[Nougan]"

# kind -> encoders, CPU first then GPU. Used for the status chips and fallbacks.
KIND_ENCODERS = {
    "h264": ["libx264", "h264_nvenc"],
    "hevc": ["libx265", "hevc_nvenc"],
    "av1": ["libsvtav1", "libaom-av1", "av1_nvenc"],
    "vp9": ["libvpx-vp9"],
    "prores": ["prores_ks"],
    "ffv1": ["ffv1"],
}

CODECS = {
    "H.264 (MP4)": dict(kind="h264", ext="mp4", audio="aac"),
    "H.265 / HEVC (MP4)": dict(kind="hevc", ext="mp4", audio="aac"),
    "AV1 (MP4)": dict(kind="av1", ext="mp4", audio="aac"),
    "AV1 (WebM)": dict(kind="av1", ext="webm", audio="opus"),
    "VP9 (WebM)": dict(kind="vp9", ext="webm", audio="opus"),
    "H.264 (MKV)": dict(kind="h264", ext="mkv", audio="aac"),
    "H.265 / HEVC (MKV)": dict(kind="hevc", ext="mkv", audio="aac"),
    "ProRes 422 HQ (MOV)": dict(kind="prores", ext="mov", audio="pcm"),
    "FFV1 Lossless (MKV)": dict(kind="ffv1", ext="mkv", audio="flac"),
}

# (worst, best) CRF/CQ for the 0-100 quality slider, per encoder.
QUALITY_RANGE = {
    "libx264": (38, 12), "libx265": (40, 14), "libsvtav1": (55, 16), "libaom-av1": (55, 16),
    "libvpx-vp9": (52, 12), "h264_nvenc": (38, 14), "hevc_nvenc": (40, 16), "av1_nvenc": (55, 20),
}
SPEEDS = ["fast", "balanced", "slow"]
RESIZE = {"original": None, "480p": 480, "720p": 720, "1080p": 1080, "1440p": 1440, "2160p (4K)": 2160}
ENCODER_MODES = ["CPU", "GPU (NVIDIA NVENC)"]
# Formats browsers cannot be relied on to play, so the node also makes a small H.264 preview.
PROXY_KINDS = {"hevc", "prores", "ffv1"}


# ------------------------------------------------------------------ ffmpeg discovery

def _popen_flags():
    return {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}


@functools.lru_cache(maxsize=1)
def _ffmpeg():
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


@functools.lru_cache(maxsize=4)
def _encoders(exe):
    result = subprocess.run([exe, "-hide_banner", "-encoders"], capture_output=True, text=True,
                            errors="replace", timeout=30, **_popen_flags())
    return set(re.findall(r"^\s*[VAS][.\w]{5}\s+(\S+)", result.stdout, re.M))


def encoder_report():
    exe = _ffmpeg()
    if not exe:
        return {"ffmpeg": None, "version": "", "kinds": {}}
    available = _encoders(exe)
    version = ""
    try:
        out = subprocess.run([exe, "-version"], capture_output=True, text=True, errors="replace",
                             timeout=20, **_popen_flags())
        version = (out.stdout.splitlines() or [""])[0]
    except Exception:
        pass
    return {
        "ffmpeg": exe,
        "version": version,
        "kinds": {kind: [name for name in names if name in available] for kind, names in KIND_ENCODERS.items()},
    }


# ------------------------------------------------------------------ encoding helpers

def _candidates(kind, use_gpu, available):
    names = [n for n in KIND_ENCODERS[kind] if n in available]
    gpu = [n for n in names if n.endswith("_nvenc")]
    cpu = [n for n in names if not n.endswith("_nvenc")]
    return (gpu + cpu) if use_gpu else (cpu + gpu)


def _crf(encoder, quality):
    worst, best = QUALITY_RANGE[encoder]
    return int(round(worst + (best - worst) * max(0, min(100, quality)) / 100.0))


def _video_args(encoder, quality, speed, container):
    idx = SPEEDS.index(speed)
    if encoder == "libx264":
        return ["-c:v", "libx264", "-preset", ["veryfast", "medium", "slow"][idx], "-crf", str(_crf(encoder, quality))]
    if encoder == "libx265":
        args = ["-c:v", "libx265", "-preset", ["veryfast", "medium", "slow"][idx], "-crf", str(_crf(encoder, quality)),
                "-x265-params", "log-level=error"]
        return args + (["-tag:v", "hvc1"] if container in ("mp4", "mov") else [])
    if encoder == "libsvtav1":
        return ["-c:v", "libsvtav1", "-preset", str([10, 7, 4][idx]), "-crf", str(_crf(encoder, quality))]
    if encoder == "libaom-av1":
        return ["-c:v", "libaom-av1", "-crf", str(_crf(encoder, quality)), "-b:v", "0",
                "-cpu-used", str([8, 6, 4][idx]), "-row-mt", "1"]
    if encoder == "libvpx-vp9":
        return ["-c:v", "libvpx-vp9", "-crf", str(_crf(encoder, quality)), "-b:v", "0",
                "-deadline", "good", "-cpu-used", str([4, 2, 1][idx]), "-row-mt", "1"]
    if encoder in ("h264_nvenc", "hevc_nvenc", "av1_nvenc"):
        args = ["-c:v", encoder, "-preset", ["p3", "p5", "p7"][idx], "-rc", "vbr",
                "-cq", str(_crf(encoder, quality)), "-b:v", "0"]
        return args + (["-tag:v", "hvc1"] if encoder == "hevc_nvenc" and container in ("mp4", "mov") else [])
    if encoder == "prores_ks":
        return ["-c:v", "prores_ks", "-profile:v", "3", "-vendor", "apl0"]
    if encoder == "ffv1":
        return ["-c:v", "ffv1", "-level", "3", "-coder", "1", "-context", "1", "-slicecrc", "1"]
    raise ValueError(f"Unknown encoder {encoder}")


def _pix_fmt(encoder, kind, ten_bit):
    if kind == "prores":
        return "yuv422p10le"
    if kind == "ffv1":
        return "gbrp"
    if not ten_bit or encoder == "h264_nvenc":  # NVENC H.264 has no 10-bit mode
        return "yuv420p"
    return "p010le" if encoder in ("hevc_nvenc", "av1_nvenc") else "yuv420p10le"


def _filter_chain(pix_fmt, resize_h):
    chain = ["crop=trunc(iw/2)*2:trunc(ih/2)*2"]  # 4:2:0 needs even sizes
    size = f"-2:'min({resize_h},ih)'" if resize_h else "iw:ih"
    if pix_fmt == "gbrp":
        if resize_h:
            chain.append(f"scale={size}:flags=lanczos")
    else:  # RGB -> YUV with an explicit BT.709 matrix so players show the same colours
        chain.append(f"scale={size}:flags=lanczos+accurate_rnd+full_chroma_int:out_color_matrix=bt709:out_range=tv")
    chain.append(f"format={pix_fmt}")
    return ",".join(chain)


def _audio_args(kind, bitrate, available):
    if kind == "aac":
        return ["-c:a", "aac", "-b:a", bitrate]
    if kind == "opus":
        if "libopus" in available:
            return ["-c:a", "libopus", "-b:a", bitrate, "-ar", "48000"]
        return ["-c:a", "libvorbis", "-b:a", bitrate]
    if kind == "flac":
        return ["-c:a", "flac"]
    return ["-c:a", "pcm_s16le"]


def _to_numpy(value):
    if hasattr(value, "detach"):
        value = value.detach().cpu().numpy()
    return np.asarray(value)


def _frame_bytes(images, start, stop):
    chunk = _to_numpy(images[start:stop])
    if chunk.shape[-1] == 1:
        chunk = np.repeat(chunk, 3, axis=-1)
    chunk = chunk[..., :3]
    if chunk.dtype != np.uint8:
        chunk = np.clip(chunk.astype(np.float32) * 255.0 + 0.5, 0, 255).astype(np.uint8)
    return np.ascontiguousarray(chunk).tobytes()


def _write_wav(audio, path):
    """AUDIO dict -> 16-bit WAV. Returns False when there is no usable audio."""
    if not isinstance(audio, dict) or "waveform" not in audio:
        return False
    wave_data = _to_numpy(audio["waveform"]).astype(np.float32)
    while wave_data.ndim > 2:
        wave_data = wave_data[0]
    if wave_data.ndim == 1:
        wave_data = wave_data[None, :]
    wave_data = wave_data[:2]
    if wave_data.shape[1] == 0:
        return False
    pcm = np.rint(np.clip(wave_data.T, -1.0, 1.0) * 32767.0).astype("<i2")
    with wave.open(path, "wb") as handle:
        handle.setnchannels(wave_data.shape[0])
        handle.setsampwidth(2)
        handle.setframerate(int(audio.get("sample_rate", 44100)))
        handle.writeframes(np.ascontiguousarray(pcm).tobytes())
    return True


def _escape_meta(text):
    for char in ("\\", "=", ";", "#", "\n"):
        text = text.replace(char, "\\" + char)
    return text


def _write_metadata(path, prompt, extra_pnginfo):
    lines = [";FFMETADATA1"]
    if prompt is not None:
        lines.append("prompt=" + _escape_meta(json.dumps(prompt, ensure_ascii=False, separators=(",", ":"))))
    for key, value in (extra_pnginfo or {}).items():
        lines.append(f"{key}=" + _escape_meta(json.dumps(value, ensure_ascii=False, separators=(",", ":"))))
    if len(lines) == 1:
        return False
    with open(path, "w", encoding="utf-8", newline="\n") as handle:
        handle.write("\n".join(lines) + "\n")
    return True


def _check_interrupt():
    try:
        import comfy.model_management as mm
        mm.throw_exception_if_processing_interrupted()
    except ImportError:
        pass


def _progress(total):
    try:
        import comfy.utils
        return comfy.utils.ProgressBar(total)
    except Exception:
        return None


def _stream_frames(cmd, images, count, width, height, workdir):
    """Run ffmpeg, feeding it raw RGB frames. Returns (returncode, stderr tail)."""
    err_path = os.path.join(workdir, "ffmpeg_stderr.txt")
    per = max(1, min(32, 4_000_000 // max(1, width * height)))
    bar = _progress(count)
    with open(err_path, "wb") as err_file:
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=err_file,
                                **_popen_flags())
        try:
            for start in range(0, count, per):
                _check_interrupt()
                stop = min(count, start + per)
                proc.stdin.write(_frame_bytes(images, start, stop))
                if bar:
                    bar.update(stop - start)
        except (BrokenPipeError, OSError):
            pass  # ffmpeg stopped early; its message is read below
        except BaseException:
            proc.kill()
            proc.wait()
            raise
        finally:
            try:
                proc.stdin.close()
            except Exception:
                pass
        code = proc.wait()
    with open(err_path, "rb") as handle:
        tail = handle.read()[-1500:].decode("utf-8", errors="replace").strip()
    return code, tail


def _probe_size(exe, path, fallback):
    try:
        out = subprocess.run([exe, "-hide_banner", "-i", path], capture_output=True, text=True,
                             errors="replace", timeout=30, **_popen_flags())
        match = re.search(r"Video:.*?, (\d{2,5})x(\d{2,5})", out.stderr)
        if match:
            return int(match.group(1)), int(match.group(2))
    except Exception:
        pass
    return fallback


def _make_proxy(exe, source, target, available, has_audio):
    """Small H.264 copy for the in-node player when the browser may not play the real file."""
    if "libx264" not in available:
        return False
    cmd = [exe, "-y", "-hide_banner", "-loglevel", "error", "-nostdin", "-i", source,
           "-vf", "scale=-2:'min(720,ih)',format=yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-crf", "26"]
    if has_audio:
        cmd += ["-c:a", "aac", "-b:a", "128k"]
    cmd += ["-movflags", "+faststart", target]
    try:
        result = subprocess.run(cmd, capture_output=True, timeout=600, **_popen_flags())
        return result.returncode == 0 and os.path.getsize(target) > 0
    except Exception:
        return False


def _random_tag(n=8):
    return "".join(random.choice(string.ascii_lowercase + string.digits) for _ in range(n))


# ------------------------------------------------------------------ node

class NouganSaveVideo:
    CATEGORY = "Nougan"
    FUNCTION = "save"
    OUTPUT_NODE = True
    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("path", "info")
    DESCRIPTION = "Save frames and optional audio as H.264, H.265, AV1, VP9, ProRes or FFV1 video, with an in-node player."

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE", {"tooltip": "The video frames."}),
                "fps": ("FLOAT", {"default": 24.0, "min": 1.0, "max": 240.0, "step": 0.01, "tooltip": "Frames per second."}),
                "codec": (list(CODECS), {"default": "H.264 (MP4)", "tooltip": "Codec and container."}),
                "quality": ("INT", {"default": 80, "min": 0, "max": 100, "step": 1,
                                    "tooltip": "Higher is better and larger. 80 is near-lossless for most content."}),
                "filename_prefix": ("STRING", {"default": "Nougan/video", "tooltip": "Subfolders allowed, e.g. Nougan/clips/scene"}),
                "save_to_output": ("BOOLEAN", {"default": True, "label_on": "save to output folder",
                                               "label_off": "preview only (temp)"}),
                "advanced": ("BOOLEAN", {"default": False, "label_on": "advanced: shown", "label_off": "advanced: hidden"}),
                "speed": (SPEEDS, {"default": "balanced", "tooltip": "Slower is smaller at the same quality."}),
                "encoder": (ENCODER_MODES, {"default": "CPU", "tooltip": "GPU uses NVENC if available and falls back to CPU if it fails."}),
                "bit_depth": (["8-bit", "10-bit"], {"default": "8-bit", "tooltip": "10-bit reduces banding. Not every player supports it."}),
                "resize": (list(RESIZE), {"default": "original", "tooltip": "Downscale to this height. Never upscales."}),
                "audio_bitrate": (["96k", "128k", "192k", "256k", "320k"], {"default": "192k"}),
                "embed_workflow": ("BOOLEAN", {"default": True, "tooltip": "Store the workflow and prompt inside the video file."}),
                "preview_proxy": ("BOOLEAN", {"default": True, "tooltip": "For HEVC / ProRes / FFV1, make a small H.264 copy so the in-node player works in any browser."}),
            },
            "optional": {
                "audio": ("AUDIO", {"tooltip": "Optional soundtrack. Padded with silence or trimmed to the video length."}),
            },
            "hidden": {"prompt": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO"},
        }

    def save(self, images, fps, codec, quality, filename_prefix, save_to_output, advanced, speed, encoder,
             bit_depth, resize, audio_bitrate, embed_workflow, preview_proxy,
             audio=None, prompt=None, extra_pnginfo=None):
        exe = _ffmpeg()
        if not exe:
            raise RuntimeError(
                "Nougan Save Video: ffmpeg was not found. Install ffmpeg and add it to PATH, "
                "or run: pip install imageio-ffmpeg")
        count = int(images.shape[0])
        height, width = int(images.shape[1]), int(images.shape[2])
        if count < 1:
            raise RuntimeError("Nougan Save Video: no frames to save.")
        fps = float(fps)
        spec = CODECS[codec]
        kind, container = spec["kind"], spec["ext"]
        available = _encoders(exe)
        candidates = _candidates(kind, encoder.startswith("GPU"), available)
        if not candidates:
            raise RuntimeError(
                f"Nougan Save Video: this ffmpeg has no {codec.split(' (')[0]} encoder "
                f"(needs one of: {', '.join(KIND_ENCODERS[kind])}). Install a full ffmpeg build, "
                "for example the 'full' build from gyan.dev, and put it on PATH.")

        duration = count / fps
        resize_h = RESIZE[resize]
        ten_bit = bit_depth == "10-bit"

        if save_to_output:
            base = folder_paths.get_output_directory()
            folder, name, counter, subfolder, _ = folder_paths.get_save_image_path(filename_prefix, base, width, height)
            out_type = "output"
        else:
            base = folder_paths.get_temp_directory()
            folder, name, counter, subfolder, _ = folder_paths.get_save_image_path(
                "nougan_video_" + _random_tag(), base, width, height)
            out_type = "temp"
        os.makedirs(folder, exist_ok=True)
        file_name = f"{name}_{counter:05}_.{container}"
        out_path = os.path.join(folder, file_name)

        with tempfile.TemporaryDirectory(prefix="nougan_sv_") as work:
            wav_path = os.path.join(work, "audio.wav")
            has_audio = audio is not None and _write_wav(audio, wav_path)
            meta_path = os.path.join(work, "meta.txt")
            has_meta = embed_workflow and _write_metadata(meta_path, prompt, extra_pnginfo)

            used, notes, last_error = None, [], ""
            for enc in candidates:
                pix = _pix_fmt(enc, kind, ten_bit)
                cmd = [exe, "-y", "-hide_banner", "-loglevel", "error", "-nostdin",
                       "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{width}x{height}",
                       "-framerate", repr(fps), "-i", "pipe:0"]
                next_input = 1
                if has_audio:
                    cmd += ["-i", wav_path]
                    next_input += 1
                if has_meta:
                    cmd += ["-f", "ffmetadata", "-i", meta_path]
                cmd += ["-map", "0:v:0"]
                if has_audio:
                    cmd += ["-map", "1:a:0"]
                if has_meta:
                    cmd += ["-map_metadata", str(next_input)]
                cmd += ["-vf", _filter_chain(pix, resize_h)]
                cmd += _video_args(enc, quality, speed, container)
                if kind not in ("ffv1",):
                    cmd += ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv"]
                if has_audio:
                    cmd += _audio_args(spec["audio"], audio_bitrate, available) + ["-af", "apad"]
                cmd += ["-t", f"{duration:.6f}"]
                if container in ("mp4", "mov"):
                    cmd += ["-movflags", "+faststart" + ("+use_metadata_tags" if has_meta else "")]
                cmd.append(out_path)

                code, tail = _stream_frames(cmd, images, count, width, height, work)
                if code == 0 and os.path.exists(out_path) and os.path.getsize(out_path) > 0:
                    used = enc
                    if ten_bit and pix == "yuv420p":
                        notes.append("10-bit not available for this encoder, used 8-bit")
                    break
                last_error = tail
                notes.append(f"{enc} failed")
                print(f"{TAG} Save Video: {enc} failed, trying the next encoder. {tail[-300:]}")
                if os.path.exists(out_path):
                    os.remove(out_path)
            if not used:
                raise RuntimeError(f"Nougan Save Video: ffmpeg could not encode this video.\n{last_error}")

            out_w, out_h = _probe_size(exe, out_path, ((width // 2) * 2, (height // 2) * 2))
            size = os.path.getsize(out_path)

            preview = None
            if preview_proxy and kind in PROXY_KINDS:
                proxy_name = f"nougan_proxy_{_random_tag()}.mp4"
                proxy_path = os.path.join(folder_paths.get_temp_directory(), proxy_name)
                if _make_proxy(exe, out_path, proxy_path, available, has_audio):
                    preview = {"filename": proxy_name, "subfolder": "", "type": "temp"}

        info = (f"{codec} | {out_w}x{out_h} @ {fps:g} fps | {count} frames ({duration:.2f}s) | "
                f"{size / 1048576:.2f} MB | {used}{' | audio' if has_audio else ''}")
        if notes:
            info += " | " + "; ".join(notes)
        print(f"{TAG} Save Video: {info}")
        entry = {
            "filename": file_name, "subfolder": subfolder, "type": out_type, "preview": preview,
            "kind": kind, "container": container, "codec": codec, "encoder": used,
            "width": out_w, "height": out_h, "fps": fps, "frames": count, "duration": duration,
            "size": size, "has_audio": bool(has_audio), "path": out_path, "notes": notes,
        }
        return {"ui": {"nougan_video": [entry]}, "result": (out_path, info)}


# ------------------------------------------------------------------ route for the encoder status chips

def _register_routes():
    try:
        from aiohttp import web
        from server import PromptServer

        @PromptServer.instance.routes.get("/nougan/video_encoders")
        async def _video_encoders(_request):
            loop = asyncio.get_running_loop()
            return web.json_response(await loop.run_in_executor(None, encoder_report))
    except Exception as error:  # outside ComfyUI, or the route already exists
        print(f"{TAG} Save Video: could not register /nougan/video_encoders ({error})")


_register_routes()
