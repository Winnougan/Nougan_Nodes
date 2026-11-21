import os
import re
import json
import shutil
import tempfile
import functools
import subprocess

import numpy as np
import torch
import folder_paths
from PIL import Image

try:
    from comfy.utils import ProgressBar
except Exception:  # keeps the file importable outside ComfyUI
    class ProgressBar:
        def __init__(self, total):
            pass

        def update(self, n):
            pass


# ----------------------------------------------------------------------
# Format / codec tables
# ----------------------------------------------------------------------
# Which codecs each container may use. The first entry is the default that is
# used when the chosen codec does not fit the chosen format.
FORMAT_CODECS = {
    "mp4": ["h264", "h265", "av1"],
    "webm": ["vp9", "av1"],
    "mkv": ["h264", "h265", "av1", "vp9", "ffv1"],
    "mov": ["prores_4444", "prores_422", "h264", "h265"],
    "gif": ["none (gif)"],
    "webp": ["none (gif)"],
}
ALL_CODECS = ["h264", "h265", "av1", "vp9", "prores_4444", "prores_422", "ffv1", "none (gif)"]

# (format, codec) pairs that can really store transparency.
# gif is 1-bit alpha only, webp has full alpha.
ALPHA_CAPABLE = {
    ("webm", "vp9"),
    ("mkv", "vp9"),
    ("mkv", "ffv1"),
    ("mov", "prores_4444"),
    ("gif", "none (gif)"),
    ("webp", "none (gif)"),
}

# Codecs a browser cannot play, so the UI gets an H.264 proxy to preview instead.
NEEDS_PROXY_CODECS = {"h265", "prores_4444", "prores_422", "ffv1"}
NEEDS_PROXY_FORMATS = {"mkv", "mov"}

EVEN_DIM_CODECS = {"h264", "h265", "av1", "vp9", "prores_422"}  # 4:2:0 / 4:2:2 need even sizes
YUV_BT709_CODECS = {"h264", "h265", "av1", "vp9", "prores_4444", "prores_422"}


@functools.lru_cache(maxsize=1)
def _ffmpeg_exe():
    path = shutil.which("ffmpeg")
    if path:
        return path
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


@functools.lru_cache(maxsize=1)
def _encoder_names():
    exe = _ffmpeg_exe()
    if not exe:
        return set()
    try:
        out = subprocess.run([exe, "-hide_banner", "-encoders"], capture_output=True, text=True, timeout=20).stdout
    except Exception:
        return set()
    names = set()
    for line in out.splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[0][:1] in ("V", "A") and len(parts[0]) == 6:
            names.add(parts[1])
    return names


def _has_encoder(name):
    return name in _encoder_names()


class NouganVideoSave:
    BGCOLOR = "#3d124d"
    COLOR = "#19124d"
    CATEGORY = "Nougan/Video"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # "*" accepts IMAGE batches, VIDEO objects and most custom video types.
                "video": ("*",),
                "filename_prefix": ("STRING", {"default": "NouganVideo"}),
                "format": (list(FORMAT_CODECS.keys()),),
                "codec": (ALL_CODECS,),
                "fps": ("FLOAT", {"default": 24.0, "min": 1.0, "max": 120.0, "step": 0.1}),
                "crf": ("INT", {"default": 23, "min": 0, "max": 63}),
            },
            # New options are optional so workflows saved with the old node still load.
            "optional": {
                "audio": ("AUDIO", {"tooltip": "Sound to mux into the video (mp4, webm, mkv, mov)."}),
                "alpha": (["keep if possible", "drop"], {
                    "default": "keep if possible",
                    "tooltip": "RGBA input keeps transparency in webm/vp9, mov/prores_4444, mkv/ffv1, gif and webp.",
                }),
                "use_video_fps": ("BOOLEAN", {
                    "default": True,
                    "tooltip": "If the incoming VIDEO carries its own frame rate, use it instead of the fps value.",
                }),
                "pingpong": ("BOOLEAN", {"default": False}),
                "loop_count": ("INT", {
                    "default": 0, "min": 0, "max": 100,
                    "tooltip": "gif/webp: times the animation loops (0 = forever). Other formats: extra repeats of the clip.",
                }),
                "trim_to_audio": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "Stop at the end of the audio if it is shorter than the video. Off = pad the audio with silence.",
                }),
                "save_metadata": ("BOOLEAN", {
                    "default": True,
                    "tooltip": "Embed the prompt and workflow JSON in the file's metadata (mp4, mov, mkv, webm).",
                }),
                "save_output": ("BOOLEAN", {"default": True, "tooltip": "Off = write to the temp folder instead of output."}),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("filepath",)
    FUNCTION = "save_video"
    OUTPUT_NODE = True
    DESCRIPTION = (
        "Save a VIDEO or an IMAGE batch with ffmpeg. Streams frames straight to ffmpeg (no temp PNGs), "
        "muxes audio in one pass, keeps transparency (webm/vp9, mov/ProRes 4444, mkv/FFV1, gif, webp), "
        "and embeds the workflow."
    )

    # ------------------------------------------------------------------
    # Incoming object handling
    # ------------------------------------------------------------------
    def _resolve_input(self, video):
        """Returns dict(frames, path, audio, fps). Exactly one of frames / path is set."""
        res = {"frames": None, "path": None, "audio": None, "fps": None}

        # ComfyUI's own VIDEO type
        if hasattr(video, "get_components") and callable(video.get_components):
            if type(video).__name__ == "VideoFromFile" and hasattr(video, "get_stream_source"):
                try:
                    src = video.get_stream_source()
                    if isinstance(src, str) and os.path.isfile(src):
                        res["path"] = src
                        return res
                except Exception:
                    pass
            comps = video.get_components()
            res["frames"] = self._to_frames(comps.images)
            res["audio"] = getattr(comps, "audio", None)
            try:
                res["fps"] = float(comps.frame_rate)
            except Exception:
                pass
            return res

        extracted = self._extract_video(video)
        if extracted is None:
            return res
        if isinstance(extracted, str):
            res["path"] = extracted
        else:
            res["frames"] = self._to_frames(extracted)
        return res

    def _extract_video(self, video, depth=0):
        """Recursively search tensors, dicts, tuples, lists and objects for frames or a video file path."""
        if video is None or depth > 6:
            return None

        if isinstance(video, torch.Tensor):
            return video

        if isinstance(video, str):
            if os.path.isfile(video):
                return video
            for base in [folder_paths.get_output_directory(), folder_paths.get_input_directory()]:
                candidate = os.path.join(base, video)
                if os.path.isfile(candidate):
                    return candidate
            return None

        if isinstance(video, dict):
            if "ui" in video and isinstance(video["ui"], dict):
                ui = video["ui"]
                for key in ("videos", "images", "gifs"):
                    if key in ui and isinstance(ui[key], list) and len(ui[key]) > 0:
                        res = self._extract_video(ui[key][0], depth + 1)
                        if res is not None:
                            return res
            for key in ("filename", "path", "filepath", "video_path", "file", "src"):
                if key in video and isinstance(video[key], str):
                    res = self._extract_video(video[key], depth + 1)
                    if res is not None:
                        return res
            for key in ("frames", "images", "video", "pixels", "tensor", "image", "data", "videos", "gifs"):
                if key in video:
                    res = self._extract_video(video[key], depth + 1)
                    if res is not None:
                        return res

        if isinstance(video, (list, tuple)):
            if len(video) == 0:
                return None
            if isinstance(video[0], torch.Tensor):
                return self._extract_video(video[0], depth + 1)
            if isinstance(video[0], (np.ndarray, Image.Image)) or (hasattr(video[0], "size") and hasattr(video[0], "mode")):
                return video
            for item in video:
                res = self._extract_video(item, depth + 1)
                if res is not None:
                    return res

        for attr in ("frames", "images", "video", "pixels", "tensor", "image", "data", "path", "filepath", "video_path", "file", "src"):
            if hasattr(video, attr):
                res = self._extract_video(getattr(video, attr), depth + 1)
                if res is not None:
                    return res

        if hasattr(video, "__dict__"):
            for val in video.__dict__.values():
                res = self._extract_video(val, depth + 1)
                if res is not None:
                    return res

        if depth == 0:
            print(f"[Nougan Video Save] DEBUG: Could not extract video. Type: {type(video)}")
            if isinstance(video, dict):
                print(f"[Nougan Video Save] DEBUG: Dict keys: {list(video.keys())}")
            elif isinstance(video, (list, tuple)):
                print(f"[Nougan Video Save] DEBUG: {type(video).__name__} length: {len(video)}, first item type: {type(video[0]) if len(video) > 0 else 'empty'}")
            elif hasattr(video, "__dict__"):
                print(f"[Nougan Video Save] DEBUG: Object attributes: {list(video.__dict__.keys())}")
            else:
                print(f"[Nougan Video Save] DEBUG: Value: {str(video)[:200]}")
        return None

    def _to_frames(self, frames):
        """Normalise to a [B, H, W, C] float tensor in 0..1 with C in (3, 4)."""
        if not isinstance(frames, torch.Tensor):
            arrs = [np.array(f) for f in frames]
            frames = torch.from_numpy(np.stack(arrs).astype(np.float32))
            if frames.max() > 1.5:
                frames = frames / 255.0
        if frames.ndim == 3:
            frames = frames.unsqueeze(0)
        if frames.ndim == 4 and frames.shape[1] in (1, 3, 4) and frames.shape[-1] not in (1, 3, 4):
            frames = frames.permute(0, 2, 3, 1)  # BCHW -> BHWC
        if frames.ndim == 5:
            frames = frames.reshape(-1, frames.shape[-3], frames.shape[-2], frames.shape[-1])
        if frames.shape[-1] == 1:
            frames = frames.repeat(1, 1, 1, 3)
        elif frames.shape[-1] == 2:
            frames = frames[..., :1].repeat(1, 1, 1, 3)
        elif frames.shape[-1] > 4:
            frames = frames[..., :3]
        if frames.numel() > 0 and float(frames.max()) > 1.5:
            frames = frames / 255.0
        return frames

    # ------------------------------------------------------------------
    # Frame streaming
    # ------------------------------------------------------------------
    def _frame_stream(self, frames, indices, channels, depth16, pbar, chunk=8):
        """Yields raw bytes for ffmpeg's rawvideo input, a few frames at a time."""
        for s in range(0, len(indices), chunk):
            idx = indices[s:s + chunk]
            batch = frames[idx][..., :channels]
            if depth16:
                arr = (batch.clamp(0, 1) * 65535.0 + 0.5).cpu().numpy().astype("<u2")
            else:
                arr = (batch.clamp(0, 1) * 255.0 + 0.5).to(torch.uint8).cpu().numpy()
            yield np.ascontiguousarray(arr).tobytes()
            pbar.update(len(idx))

    # ------------------------------------------------------------------
    # Output path (same counter behaviour as VHS: name_00001.ext)
    # ------------------------------------------------------------------
    def _prepare_output_path(self, filename_prefix, ext, save_output):
        base_dir = folder_paths.get_output_directory() if save_output else folder_paths.get_temp_directory()
        full_folder, filename, _, subfolder, _ = folder_paths.get_save_image_path(filename_prefix, base_dir)
        os.makedirs(full_folder, exist_ok=True)

        matcher = re.compile(rf"{re.escape(filename)}_(\d+)\D*\..+", re.IGNORECASE)
        max_counter = 0
        for existing in os.listdir(full_folder):
            m = matcher.fullmatch(existing)
            if m:
                max_counter = max(max_counter, int(m.group(1)))
        counter = max_counter + 1
        out_filename = f"{filename}_{counter:05d}.{ext}"
        return subfolder, out_filename, os.path.join(full_folder, out_filename), base_dir

    # ------------------------------------------------------------------
    # ffmetadata (prompt + workflow), written to a file to avoid command-line length limits
    # ------------------------------------------------------------------
    def _write_metadata_file(self, path, prompt, extra_pnginfo):
        def esc(key, value):
            value = str(value)
            for a, b in (("\\", "\\\\"), (";", "\\;"), ("#", "\\#"), ("=", "\\="), ("\n", "\\\n")):
                value = value.replace(a, b)
            return f"{key}={value}"

        lines = [";FFMETADATA1"]
        if prompt is not None:
            lines.append(esc("prompt", json.dumps(prompt)))
        if extra_pnginfo:
            if "workflow" in extra_pnginfo:
                lines.append(esc("workflow", json.dumps(extra_pnginfo["workflow"])))
            for k, v in extra_pnginfo.items():
                if k != "workflow":
                    lines.append(esc(k, json.dumps(v)))
        if len(lines) == 1:
            return False
        with open(path, "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
        return True

    # ------------------------------------------------------------------
    # Encoder arguments
    # ------------------------------------------------------------------
    def _encoder_args(self, fmt, codec, crf, keep_alpha, av1_encoder):
        """Returns (args, pix_fmt)."""
        if codec == "h264":
            return ["-c:v", "libx264", "-crf", str(min(crf, 51)), "-preset", "medium"], "yuv420p"
        if codec == "h265":
            args = ["-c:v", "libx265", "-crf", str(min(crf, 51)), "-preset", "medium", "-x265-params", "log-level=error"]
            if fmt in ("mp4", "mov"):
                args += ["-tag:v", "hvc1"]  # Apple / QuickTime compatibility
            return args, "yuv420p"
        if codec == "av1":
            if av1_encoder == "libaom-av1":
                return ["-c:v", "libaom-av1", "-crf", str(crf), "-b:v", "0", "-cpu-used", "4"], "yuv420p"
            return ["-c:v", "libsvtav1", "-crf", str(crf), "-preset", "6"], "yuv420p"
        if codec == "vp9":
            args = ["-c:v", "libvpx-vp9", "-crf", str(crf), "-b:v", "0", "-row-mt", "1"]
            if keep_alpha:
                args += ["-auto-alt-ref", "0"]  # required by libvpx for alpha
                return args, "yuva420p"
            return args, "yuv420p"
        if codec == "prores_4444":
            args = ["-c:v", "prores_ks", "-profile:v", "4444", "-vendor", "apl0"]
            return args, ("yuva444p10le" if keep_alpha else "yuv444p10le")
        if codec == "prores_422":
            return ["-c:v", "prores_ks", "-profile:v", "3", "-vendor", "apl0"], "yuv422p10le"
        if codec == "ffv1":
            return ["-c:v", "ffv1", "-level", "3", "-coder", "1", "-context", "1", "-g", "1", "-slicecrc", "1"], \
                   ("bgra" if keep_alpha else "bgr0")
        raise ValueError(f"Unknown codec: {codec}")

    def _audio_encoder_args(self, fmt, codec):
        if fmt in ("mp4",) or (fmt == "mov" and not codec.startswith("prores")):
            return ["-c:a", "aac", "-b:a", "192k"]
        if fmt == "mov":
            return ["-c:a", "pcm_s16le"]
        if fmt == "mkv" and codec == "ffv1":
            return ["-c:a", "flac"]
        if _has_encoder("libopus"):
            return ["-c:a", "libopus", "-b:a", "128k"]
        if _has_encoder("libvorbis"):
            return ["-c:a", "libvorbis", "-q:a", "5"]
        return ["-c:a", "aac", "-b:a", "192k"]

    # ------------------------------------------------------------------
    # Running ffmpeg
    # ------------------------------------------------------------------
    def _run(self, cmd, stream=None):
        with tempfile.TemporaryFile() as errf:
            proc = subprocess.Popen(
                cmd,
                stdin=subprocess.PIPE if stream is not None else subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=errf,
            )
            try:
                if stream is not None:
                    try:
                        for data in stream:
                            proc.stdin.write(data)
                    except BrokenPipeError:
                        pass
                    try:
                        proc.stdin.close()
                    except BrokenPipeError:
                        pass
                rc = proc.wait()
            except BaseException:
                proc.kill()
                proc.wait()
                raise
            errf.seek(0)
            err = errf.read().decode("utf-8", errors="ignore")
        if rc != 0:
            raise RuntimeError(err.strip() or f"ffmpeg exited with code {rc}")
        return err

    # ------------------------------------------------------------------
    # Browser preview proxy (H.264) for codecs the browser cannot play
    # ------------------------------------------------------------------
    def _make_proxy(self, out_path, base_name, width, height, fps, flatten_alpha, has_audio):
        exe = _ffmpeg_exe()
        proxy_dir = os.path.join(folder_paths.get_temp_directory(), "nougan_preview")
        os.makedirs(proxy_dir, exist_ok=True)
        proxy_name = f"{os.path.splitext(base_name)[0]}_preview.mp4"
        proxy_path = os.path.join(proxy_dir, proxy_name)

        even = "crop=trunc(iw/2)*2:trunc(ih/2)*2"
        cmd = [exe, "-y", "-v", "error", "-i", out_path]
        if flatten_alpha:
            cmd += ["-f", "lavfi", "-i", f"color=c=0x2a2a2a:s={width}x{height}:r={fps}",
                    "-filter_complex", f"[1:v][0:v]overlay=shortest=1:format=auto,{even},format=yuv420p[v]",
                    "-map", "[v]"]
        else:
            cmd += ["-vf", f"{even},format=yuv420p", "-map", "0:v:0"]
        if has_audio:
            cmd += ["-map", "0:a?", "-c:a", "aac", "-b:a", "128k"]
        cmd += ["-c:v", "libx264", "-crf", "23", "-preset", "veryfast", "-movflags", "+faststart", proxy_path]
        self._run(cmd)
        return {"filename": proxy_name, "subfolder": "nougan_preview", "type": "temp"}

    # ------------------------------------------------------------------
    # Main
    # ------------------------------------------------------------------
    def save_video(
        self,
        video,
        filename_prefix="NouganVideo",
        format="mp4",
        codec="h264",
        fps=24.0,
        crf=23,
        audio=None,
        alpha="keep if possible",
        use_video_fps=True,
        pingpong=False,
        loop_count=0,
        trim_to_audio=False,
        save_metadata=True,
        save_output=True,
        prompt=None,
        extra_pnginfo=None,
    ):
        exe = _ffmpeg_exe()
        if exe is None:
            raise RuntimeError(
                "[Nougan Video Save] ffmpeg was not found. Install ffmpeg and make sure it is on your PATH "
                "(or `pip install imageio-ffmpeg`)."
            )

        src = self._resolve_input(video)
        if src["frames"] is None and src["path"] is None:
            raise ValueError(
                "Nougan Video Save could not extract frames or a video file from the incoming video. "
                "Check the ComfyUI console for DEBUG info."
            )

        # ---- format / codec sanity ------------------------------------------------
        fmt = format
        allowed = FORMAT_CODECS.get(fmt, FORMAT_CODECS["mp4"])
        if codec not in allowed:
            print(f"[Nougan Video Save] '{codec}' cannot go in .{fmt}; using '{allowed[0]}' instead.")
            codec = allowed[0]
        is_anim = fmt in ("gif", "webp")

        av1_candidates = [None]
        if codec == "av1":
            av1_candidates = [e for e in ("libsvtav1", "libaom-av1") if _has_encoder(e)]
            if not av1_candidates:
                raise RuntimeError("[Nougan Video Save] Your ffmpeg build has no AV1 encoder (libsvtav1 / libaom-av1).")
        else:
            needed = {"h264": "libx264", "h265": "libx265", "vp9": "libvpx-vp9", "prores_4444": "prores_ks",
                      "prores_422": "prores_ks", "ffv1": "ffv1"}.get(codec)
            if needed and not _has_encoder(needed):
                raise RuntimeError(f"[Nougan Video Save] Your ffmpeg build does not include the '{needed}' encoder.")
            if fmt == "webp" and not _has_encoder("libwebp_anim"):
                raise RuntimeError("[Nougan Video Save] Your ffmpeg build does not include libwebp_anim (needed for webp).")

        subfolder, out_filename, out_path, base_dir = self._prepare_output_path(filename_prefix, fmt, save_output)
        out_type = "output" if save_output else "temp"
        temp_dir = tempfile.mkdtemp(prefix="nougan_")

        try:
            # ---- audio -> raw f32le temp file --------------------------------------
            audio_in = []
            has_audio = False
            audio_data = audio if audio is not None else src["audio"]
            if audio_data is not None and not is_anim:
                try:
                    wf = audio_data["waveform"]
                    wf = wf[0] if wf.ndim == 3 else wf          # [C, N]
                    channels = int(wf.shape[0])
                    audio_path = os.path.join(temp_dir, "audio.f32le")
                    with open(audio_path, "wb") as f:
                        f.write(wf.transpose(0, 1).contiguous().cpu().numpy().astype("<f4").tobytes())
                    audio_in = ["-f", "f32le", "-ar", str(int(audio_data["sample_rate"])), "-ac", str(channels), "-i", audio_path]
                    has_audio = True
                except Exception as e:
                    print(f"[Nougan Video Save] Could not use the audio input: {e}")

            # ---- frames mode vs. file mode -----------------------------------------
            frames_mode = src["frames"] is not None
            if frames_mode:
                frames = src["frames"]
                n = int(frames.shape[0])
                if n == 0:
                    return {"ui": {"nougan_video": []}, "result": ("",)}
                height, width = int(frames.shape[1]), int(frames.shape[2])
                if use_video_fps and src["fps"]:
                    fps = src["fps"]
                fps = float(fps)

                has_alpha = frames.shape[-1] == 4
                keep_alpha = has_alpha and alpha == "keep if possible"
                if keep_alpha and (fmt, codec) not in ALPHA_CAPABLE:
                    print(f"[Nougan Video Save] .{fmt}/{codec} cannot store transparency, so the alpha channel is dropped. "
                          f"Use webm/vp9, mov/prores_4444, mkv/ffv1, gif or webp to keep it.")
                    keep_alpha = False
            else:
                has_alpha = keep_alpha = False
                width = height = None

            # ---- metadata file -----------------------------------------------------
            meta_idx = None
            meta_in = []
            if save_metadata and not is_anim:
                meta_path = os.path.join(temp_dir, "metadata.txt")
                if self._write_metadata_file(meta_path, prompt, extra_pnginfo):
                    meta_in = ["-f", "ffmetadata", "-i", meta_path]

            # ---- encode attempts: (av1 encoder) x (with / without metadata) --------
            attempts = []
            for enc in av1_candidates:
                for with_meta in ([True, False] if meta_in else [False]):
                    attempts.append((enc, with_meta))

            last_error = None
            for av1_enc, with_meta in attempts:
                try:
                    cmd, stream, pbar_total = self._build_command(
                        exe, out_path, fmt, codec, crf, fps, keep_alpha, av1_enc, src, frames_mode,
                        audio_in, has_audio, meta_in if with_meta else [], trim_to_audio, pingpong, loop_count,
                    )
                    pbar = ProgressBar(pbar_total)
                    stream_gen = stream(pbar) if stream is not None else None
                    self._run(cmd, stream_gen)
                    last_error = None
                    break
                except RuntimeError as e:
                    last_error = e
                    if os.path.exists(out_path):
                        try:
                            os.remove(out_path)
                        except OSError:
                            pass
            if last_error is not None:
                print(f"[Nougan Video Save] FFmpeg error:\n{last_error}")
                raise last_error

            # ---- UI info + optional browser proxy ----------------------------------
            info = {"filename": out_filename, "subfolder": subfolder, "type": out_type}
            if width and height:
                info["width"], info["height"] = width, height

            needs_proxy = (not is_anim) and (codec in NEEDS_PROXY_CODECS or fmt in NEEDS_PROXY_FORMATS)
            if needs_proxy:
                try:
                    info["preview"] = self._make_proxy(
                        out_path, out_filename, width or 640, height or 360, fps if frames_mode else 24,
                        flatten_alpha=keep_alpha, has_audio=has_audio,
                    )
                except Exception as e:
                    print(f"[Nougan Video Save] Preview proxy failed (the saved file is fine): {e}")

            return {"ui": {"nougan_video": [info]}, "result": (out_path,)}

        finally:
            shutil.rmtree(temp_dir, ignore_errors=True)

    # ------------------------------------------------------------------
    # Command construction
    # ------------------------------------------------------------------
    def _build_command(self, exe, out_path, fmt, codec, crf, fps, keep_alpha, av1_enc, src, frames_mode,
                       audio_in, has_audio, meta_in, trim_to_audio, pingpong, loop_count):
        is_anim = fmt in ("gif", "webp")
        cmd = [exe, "-y", "-v", "error"]
        stream = None
        total = 0

        if frames_mode:
            frames = src["frames"]
            n = int(frames.shape[0])
            height, width = int(frames.shape[1]), int(frames.shape[2])

            indices = list(range(n))
            if pingpong and n > 2:
                indices += list(range(n - 2, 0, -1))
            if not is_anim and loop_count > 0:
                indices = indices * (1 + loop_count)
            total = len(indices)

            depth16 = codec in ("prores_4444", "prores_422") and not is_anim
            channels = 4 if keep_alpha else 3
            if depth16:
                i_pix = "rgba64le" if keep_alpha else "rgb48le"
            else:
                i_pix = "rgba" if keep_alpha else "rgb24"
            yuv_out = (codec in YUV_BT709_CODECS) and not is_anim
            fake_trc = "bt709" if yuv_out else "iec61966-2-1"

            cmd += ["-f", "rawvideo", "-pix_fmt", i_pix,
                    "-color_range", "pc", "-colorspace", "rgb", "-color_primaries", "bt709", "-color_trc", fake_trc,
                    "-s", f"{width}x{height}", "-r", str(fps), "-i", "-"]
            stream = lambda pbar: self._frame_stream(frames, indices, channels, depth16, pbar)
        else:
            cmd += ["-i", src["path"]]
            total = 1
            yuv_out = False

        n_inputs = 1
        audio_idx = None
        if audio_in:
            cmd += audio_in
            audio_idx = n_inputs
            n_inputs += 1
        meta_idx = None
        if meta_in:
            cmd += meta_in
            meta_idx = n_inputs
            n_inputs += 1

        # ---- animated image outputs ------------------------------------------------
        if is_anim:
            fps_filter = "" if frames_mode else f"fps={fps},"
            if fmt == "gif":
                gen = "palettegen=reserve_transparent=1" if keep_alpha else "palettegen"
                use = "paletteuse=alpha_threshold=128" if keep_alpha else "paletteuse"
                cmd += ["-filter_complex", f"[0:v]{fps_filter}split[a][b];[a]{gen}[p];[b][p]{use}[v]",
                        "-map", "[v]", "-loop", str(loop_count)]
            else:
                quality = max(1, min(100, 100 - 2 * crf))
                lossless = "1" if crf == 0 else "0"
                cmd += ["-map", "0:v:0"]
                if fps_filter:
                    cmd += ["-vf", fps_filter.rstrip(",")]
                cmd += ["-c:v", "libwebp_anim", "-lossless", lossless, "-quality", str(quality),
                        "-loop", str(loop_count), "-pix_fmt", "bgra"]
            cmd += [out_path]
            return cmd, stream, total

        # ---- regular video ---------------------------------------------------------
        enc_args, pix_fmt = self._encoder_args(fmt, codec, crf, keep_alpha, av1_enc)

        vf = []
        if codec in EVEN_DIM_CODECS:
            vf.append("crop=trunc(iw/2)*2:trunc(ih/2)*2")
        if yuv_out:
            vf.append("scale=out_color_matrix=bt709")
        if frames_mode or yuv_out:
            vf.append(f"format={pix_fmt}")

        cmd += ["-map", "0:v:0"]
        if has_audio:
            cmd += ["-map", f"{audio_idx}:a:0"]
        elif not frames_mode:
            cmd += ["-map", "0:a?"]

        if meta_idx is not None:
            cmd += ["-map_metadata", str(meta_idx)]

        if vf:
            cmd += ["-vf", ",".join(vf)]
        cmd += enc_args + ["-pix_fmt", pix_fmt]
        if yuv_out:
            cmd += ["-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709"]

        if has_audio or (not frames_mode):
            cmd += self._audio_encoder_args(fmt, codec)
        if has_audio:
            if not trim_to_audio:
                cmd += ["-af", "apad"]
            cmd += ["-shortest"]

        movflags = []
        if fmt in ("mp4", "mov"):
            if fmt == "mp4":
                movflags.append("+faststart")
            if meta_idx is not None:
                movflags.append("+use_metadata_tags")
        if movflags:
            cmd += ["-movflags", "".join(movflags).replace("++", "+")]

        cmd += [out_path]
        return cmd, stream, total


NODE_CLASS_MAPPINGS = {"NouganVideoSave": NouganVideoSave}
NODE_DISPLAY_NAME_MAPPINGS = {"NouganVideoSave": "Nougan Video Save"}
