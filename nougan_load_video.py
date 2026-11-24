"""nougan_load_video.py — Nougan Load Video (visual crop / trim / resize loader)."""
import asyncio
import hashlib
import math
import os
import tempfile
import threading
import time
from fractions import Fraction

import av
import numpy as np

try:
    import torch
except Exception:
    torch = None

try:
    import folder_paths
except Exception:
    folder_paths = None

VIDEO_EXTS = {
    ".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v", ".gif",
    ".wmv", ".flv", ".mpg", ".mpeg", ".ts", ".mts", ".m2ts", ".ogv",
}

RESIZE_MODES = ["none", "short_edge", "long_edge", "width", "height", "exact"]
RESIZE_METHODS = ["area", "bicubic", "bilinear", "lanczos", "nearest"]
_SWS = {
    "area": "AREA",
    "bicubic": "BICUBIC",
    "bilinear": "BILINEAR",
    "lanczos": "LANCZOS",
    "nearest": "POINT",
}
FRAME_RULES = {"none": None, "4n+1": (4, 1), "8n+1": (8, 1), "17n+5": (17, 5)}
SNAP_FROM = ["end", "start"]
MAX_INT = 10_000_000

_PLAN_CACHE = {}
_PLAN_LOCK = threading.Lock()


class PlanError(ValueError):
    """The widgets describe something that cannot be rendered."""


def _allowed_roots():
    roots = []
    if folder_paths is not None:
        for fn in ("get_input_directory", "get_output_directory", "get_temp_directory"):
            try:
                roots.append(os.path.realpath(getattr(folder_paths, fn)()))
            except Exception:
                pass
    return roots


def resolve_video_path(name: str) -> str:
    """Resolve a ComfyUI input/output/temp video filename safely."""
    if not name or not isinstance(name, str):
        raise PlanError("No video selected.")

    if folder_paths is None:
        path = os.path.abspath(name)
        if not os.path.isfile(path):
            raise PlanError(f"Video file not found: {name}")
        return path

    path = folder_paths.get_annotated_filepath(name)
    real = os.path.realpath(path)
    roots = _allowed_roots()
    if roots and not any(real == r or real.startswith(r + os.sep) for r in roots):
        raise PlanError(f"Refusing path outside ComfyUI media directories: {name}")

    if not os.path.isfile(real):
        raise PlanError(f"Video file not found: {name}")
    return real


def list_video_files():
    files = []
    if folder_paths is not None:
        try:
            inp = folder_paths.get_input_directory()
            for root, _, names in os.walk(inp):
                for fn in names:
                    if os.path.splitext(fn)[1].lower() in VIDEO_EXTS:
                        rel = os.path.relpath(os.path.join(root, fn), inp).replace(os.sep, "/")
                        files.append(rel)
        except Exception:
            pass
    return sorted(set(files))


def _rotation_steps_ccw(frame) -> int:
    """Return 90-degree CCW rotation steps needed to orient frame upright."""
    rot = getattr(frame, "rotation", 0) or 0
    try:
        deg = float(rot)
    except Exception:
        deg = 0.0
    nearest_90 = int(round(deg / 90.0)) * 90
    if abs(deg - nearest_90) < 1e-2:
        steps = ((nearest_90 % 360) // 90) % 4
        return steps
    return 0


def _apply_rotation_np(arr: np.ndarray, steps_ccw: int) -> np.ndarray:
    """Rotate HWC numpy array by steps_ccw * 90 degrees counter-clockwise."""
    steps = steps_ccw % 4
    if steps == 0:
        return arr
    return np.rot90(arr, k=steps, axes=(0, 1)).copy()


def _probe_video(path: str):
    """Inspect video stream metadata and decode first frame to get upright dimensions & rotation."""
    with av.open(path) as container:
        vstreams = [s for s in container.streams if s.type == "video"]
        if not vstreams:
            raise PlanError("No video stream found in file.")
        vstream = vstreams[0]

        raw_fps = float(vstream.average_rate or vstream.guessed_rate or 24.0)
        if not math.isfinite(raw_fps) or raw_fps <= 0:
            raw_fps = 24.0

        time_base = float(vstream.time_base) if vstream.time_base else (1.0 / raw_fps)
        duration_sec = 0.0
        if vstream.duration is not None and vstream.time_base is not None:
            duration_sec = max(0.0, float(vstream.duration * vstream.time_base))
        elif container.duration is not None:
            duration_sec = max(0.0, float(container.duration) / 1_000_000.0)

        first_w = int(vstream.codec_context.width or 0)
        first_h = int(vstream.codec_context.height or 0)
        steps_ccw = 0

        for packet in container.demux(vstream):
            for frame in packet.decode():
                steps_ccw = _rotation_steps_ccw(frame)
                rgb = frame.to_ndarray(format="rgb24")
                rot = _apply_rotation_np(rgb, steps_ccw)
                first_h, first_w = rot.shape[:2]
                break
            if first_w > 0 and first_h > 0:
                break

        if first_w <= 0 or first_h <= 0:
            raise PlanError("Could not determine video frame dimensions.")

        est_frames = int(vstream.frames or 0)
        if est_frames <= 0 and duration_sec > 0:
            est_frames = max(1, int(round(duration_sec * raw_fps)))
        if est_frames <= 0:
            est_frames = 1

        has_audio = any(s.type == "audio" for s in container.streams)

    return {
        "width": first_w,
        "height": first_h,
        "fps": raw_fps,
        "duration": duration_sec if duration_sec > 0 else (est_frames / raw_fps),
        "total_frames": est_frames,
        "steps_ccw": steps_ccw,
        "has_audio": has_audio,
    }


def _snap_down_rule(count: int, rule_name: str) -> int:
    rule = FRAME_RULES.get(rule_name)
    if not rule or count <= 0:
        return max(0, count)
    step, offset = rule
    if count < offset:
        return count
    k = (count - offset) // step
    return max(1, k * step + offset)


def _snap_to_multiple(val: int, multiple_of: int) -> int:
    m = max(1, int(multiple_of))
    return max(m, int(math.floor(val / m)) * m)


def _compute_output_size(crop_w: int, crop_h: int, resize_mode: str, size: int, size_h: int, multiple_of: int):
    w, h = float(crop_w), float(crop_h)
    mode = resize_mode if resize_mode in RESIZE_MODES else "none"
    s = max(1, int(size))
    sh = max(1, int(size_h))

    if mode == "none":
        out_w, out_h = crop_w, crop_h
    elif mode == "short_edge":
        short_src = min(w, h)
        scale = s / max(1.0, short_src)
        out_w = max(1, int(round(w * scale)))
        out_h = max(1, int(round(h * scale)))
    elif mode == "long_edge":
        long_src = max(w, h)
        scale = s / max(1.0, long_src)
        out_w = max(1, int(round(w * scale)))
        out_h = max(1, int(round(h * scale)))
    elif mode == "width":
        scale = s / max(1.0, w)
        out_w = s
        out_h = max(1, int(round(h * scale)))
    elif mode == "height":
        scale = sh / max(1.0, h)
        out_w = max(1, int(round(w * scale)))
        out_h = sh
    elif mode == "exact":
        out_w = s
        out_h = sh
    else:
        out_w, out_h = crop_w, crop_h

    out_w = _snap_to_multiple(out_w, multiple_of)
    out_h = _snap_to_multiple(out_h, multiple_of)
    return out_w, out_h


def build_plan(
    video: str,
    start_frame: int = 0,
    end_frame: int = 0,
    crop_x: int = 0,
    crop_y: int = 0,
    crop_w: int = 0,
    crop_h: int = 0,
    resize_mode: str = "none",
    size: int = 720,
    size_h: int = 720,
    multiple_of: int = 16,
    frame_rule: str = "none",
    snap_from: str = "end",
    max_frames: int = 0,
    target_fps: float = 0.0,
):
    """Compute exact trim, crop, resize, and frame-count plan from source metadata."""
    path = resolve_video_path(video)
    probe = _probe_video(path)

    src_w = probe["width"]
    src_h = probe["height"]
    src_fps = probe["fps"]
    total_frames = probe["total_frames"]

    s_frame = max(0, int(start_frame))
    if s_frame >= total_frames:
        s_frame = max(0, total_frames - 1)

    if int(end_frame) <= 0 or int(end_frame) > total_frames:
        e_frame = total_frames
    else:
        e_frame = max(s_frame + 1, int(end_frame))

    raw_count = max(1, e_frame - s_frame)
    out_fps = float(target_fps) if (target_fps and float(target_fps) > 0) else src_fps

    if abs(out_fps - src_fps) > 1e-3:
        fps_count = max(1, int(round(raw_count * (out_fps / src_fps))))
    else:
        fps_count = raw_count

    if int(max_frames) > 0:
        fps_count = min(fps_count, int(max_frames))

    final_count = _snap_down_rule(fps_count, frame_rule)

    # Effective source frame span after max_frames / frame_rule
    if abs(out_fps - src_fps) > 1e-3:
        effective_src_span = min(raw_count, max(1, int(math.ceil(final_count * (src_fps / out_fps)))))
    else:
        effective_src_span = min(raw_count, final_count)

    if snap_from == "start":
        eff_start = s_frame
        eff_end = min(e_frame, eff_start + effective_src_span)
    else:
        eff_end = e_frame
        eff_start = max(s_frame, eff_end - effective_src_span)

    cx = max(0, min(int(crop_x), src_w - 1))
    cy = max(0, min(int(crop_y), src_h - 1))

    cw = src_w - cx if int(crop_w) <= 0 else int(crop_w)
    ch = src_h - cy if int(crop_h) <= 0 else int(crop_h)

    cw = max(1, min(cw, src_w - cx))
    ch = max(1, min(ch, src_h - cy))

    out_w, out_h = _compute_output_size(cw, ch, resize_mode, size, size_h, multiple_of)

    start_sec = eff_start / src_fps
    end_sec = eff_end / src_fps
    trim_duration = max(0.0, end_sec - start_sec)

    plan = {
        "path": path,
        "source_width": src_w,
        "source_height": src_h,
        "source_fps": round(src_fps, 4),
        "source_duration": round(probe["duration"], 4),
        "total_frames": total_frames,
        "has_audio": probe["has_audio"],
        "steps_ccw": probe["steps_ccw"],
        "start_frame": eff_start,
        "end_frame": eff_end,
        "start_sec": round(start_sec, 4),
        "end_sec": round(end_sec, 4),
        "trim_duration": round(trim_duration, 4),
        "crop_x": cx,
        "crop_y": cy,
        "crop_w": cw,
        "crop_h": ch,
        "output_width": out_w,
        "output_height": out_h,
        "output_frames": final_count,
        "output_fps": round(out_fps, 4),
        "frame_rule": frame_rule,
        "snap_from": snap_from,
    }

    digest = hashlib.sha1(repr(sorted(plan.items())).encode("utf-8")).hexdigest()[:12]
    plan["plan_id"] = digest
    with _PLAN_LOCK:
        _PLAN_CACHE[digest] = plan
    return plan


try:
    from av.video.reformatter import Interpolation as _Interp
except Exception:
    _Interp = None


def _resize_frame_np(frame_rgb: np.ndarray, out_w: int, out_h: int, resize_method: str) -> np.ndarray:
    in_h, in_w = frame_rgb.shape[:2]
    if in_w == out_w and in_h == out_h:
        return frame_rgb
    name = _SWS.get(resize_method, "BICUBIC")
    flag = getattr(_Interp, name, None) if _Interp is not None else None
    vf = av.VideoFrame.from_ndarray(np.ascontiguousarray(frame_rgb), format="rgb24")
    scaled = None
    for interp in (flag, name, None):
        try:
            if interp is None:
                scaled = vf.reformat(width=out_w, height=out_h)
            else:
                scaled = vf.reformat(width=out_w, height=out_h, interpolation=interp)
            break
        except Exception:
            continue
    if scaled is None:
        raise PlanError("Resize failed.")
    return scaled.to_ndarray(format="rgb24")


def _resample_indices(src_count: int, target_count: int) -> list[int]:
    if src_count <= 0 or target_count <= 0:
        return []
    if src_count == target_count:
        return list(range(src_count))
    if target_count == 1:
        return [0]
    return [min(src_count - 1, int(round(i * (src_count - 1) / (target_count - 1)))) for i in range(target_count)]


def _extract_trimmed_audio(path: str, start_sec: float, end_sec: float, sample_rate: int = 44100):
    """Extract and trim audio to [start_sec, end_sec) as ComfyUI AUDIO dict."""
    if torch is None:
        return None
    duration = max(0.0, end_sec - start_sec)
    target_samples = max(1, int(round(duration * sample_rate)))

    with av.open(path) as container:
        astreams = [s for s in container.streams if s.type == "audio"]
        if not astreams:
            return {
                "waveform": torch.zeros((1, 2, target_samples), dtype=torch.float32),
                "sample_rate": sample_rate,
            }

        astream = astreams[0]
        resampler = av.AudioResampler(format="flt", layout="stereo", rate=sample_rate)
        chunks = []

        if start_sec > 0.05:
            seek_ts = int(start_sec / float(astream.time_base or (1.0 / sample_rate)))
            try:
                container.seek(seek_ts, stream=astream)
            except Exception:
                pass

        for packet in container.demux(astream):
            for frame in packet.decode():
                f_time = float(frame.pts * frame.time_base) if (frame.pts is not None and frame.time_base) else start_sec
                f_dur = float(frame.samples) / float(frame.sample_rate or sample_rate)
                if f_time + f_dur < start_sec:
                    continue
                if f_time > end_sec + 0.1:
                    break
                for rframe in resampler.resample(frame):
                    arr = rframe.to_ndarray()
                    if arr.ndim == 1:
                        arr = np.stack([arr, arr], axis=0)
                    elif arr.shape[0] == 1:
                        arr = np.repeat(arr, 2, axis=0)
                    r_time = float(rframe.pts * rframe.time_base) if (rframe.pts is not None and rframe.time_base) else f_time
                    r_dur = float(rframe.samples) / float(sample_rate)
                    # Trim partial edge samples
                    keep_start = 0
                    keep_end = arr.shape[1]
                    if r_time < start_sec and r_dur > 0:
                        keep_start = min(keep_end, int(round(((start_sec - r_time) / r_dur) * keep_end)))
                    if r_time + r_dur > end_sec and r_dur > 0:
                        keep_end = max(keep_start, int(round(((end_sec - r_time) / r_dur) * keep_end)))
                    if keep_end > keep_start:
                        chunks.append(arr[:, keep_start:keep_end])
            else:
                continue
            break

        for rframe in resampler.resample(None):
            arr = rframe.to_ndarray()
            if arr.ndim == 1:
                arr = np.stack([arr, arr], axis=0)
            elif arr.shape[0] == 1:
                arr = np.repeat(arr, 2, axis=0)
            chunks.append(arr)

    if not chunks:
        wav = torch.zeros((1, 2, target_samples), dtype=torch.float32)
    else:
        cat = np.concatenate(chunks, axis=1)
        if cat.shape[1] > target_samples:
            cat = cat[:, :target_samples]
        elif cat.shape[1] < target_samples:
            pad = np.zeros((cat.shape[0], target_samples - cat.shape[1]), dtype=np.float32)
            cat = np.concatenate([cat, pad], axis=1)
        wav = torch.from_numpy(np.clip(cat, -1.0, 1.0).astype(np.float32)).unsqueeze(0)

    return {"waveform": wav, "sample_rate": sample_rate}


def _iter_source_frames(plan: dict):
    """Yield upright, cropped uint8 RGB frames for [start_frame, end_frame).

    Frame indices come from each frame's timestamp, not from a running counter. After a seek the
    decoder restarts at the previous keyframe, which can be well before the requested start, so
    counting frames from the seek target gave the wrong trim.
    """
    path = plan["path"]
    start_f = plan["start_frame"]
    end_f = plan["end_frame"]
    cx, cy, cw, ch = plan["crop_x"], plan["crop_y"], plan["crop_w"], plan["crop_h"]
    steps_ccw = plan["steps_ccw"]
    src_fps = plan["source_fps"]

    with av.open(path) as container:
        vstream = next((s for s in container.streams if s.type == "video"), None)
        if vstream is None:
            raise PlanError("No video stream found.")

        t0 = 0.0
        if vstream.start_time is not None and vstream.time_base:
            t0 = float(vstream.start_time * vstream.time_base)

        if start_f > 0 and src_fps > 0 and vstream.time_base:
            approx_sec = max(0.0, (start_f - 2) / src_fps) + t0
            if approx_sec > 0.25:
                try:
                    container.seek(int(approx_sec / float(vstream.time_base)), stream=vstream)
                except Exception:
                    container.seek(0)

        counter = 0
        for packet in container.demux(vstream):
            for frame in packet.decode():
                if frame.pts is not None and frame.time is not None:
                    idx = int(round((float(frame.time) - t0) * src_fps))
                else:
                    idx = counter
                counter = idx + 1
                if idx < start_f:
                    continue
                if idx >= end_f:
                    return
                rgb = frame.to_ndarray(format="rgb24")
                upright = _apply_rotation_np(rgb, steps_ccw)
                yield upright[cy : cy + ch, cx : cx + cw]


def decode_plan(plan: dict, resize_method: str = "bicubic"):
    """Decode only [start_frame, end_frame), crop in source pixels, resize, and snap frame count."""
    if torch is None:
        raise RuntimeError("PyTorch is required to execute NouganLoadVideo.")

    out_w, out_h = plan["output_width"], plan["output_height"]
    target_count = plan["output_frames"]

    decoded = []
    for cropped in _iter_source_frames(plan):
        resized = _resize_frame_np(cropped, out_w, out_h, resize_method)
        decoded.append(resized.astype(np.float32) / 255.0)

    if not decoded:
        raise PlanError("Decoded 0 frames for the requested trim range.")

    indices = _resample_indices(len(decoded), target_count)
    selected = [decoded[i] for i in indices]
    batch = torch.from_numpy(np.stack(selected, axis=0)).to(torch.float32)
    audio = _extract_trimmed_audio(plan["path"], plan["start_sec"], plan["end_sec"])
    return batch, audio, int(batch.shape[0]), float(plan["output_fps"])


# ---------------------------------------------------------------------------------------------
# Result preview (what the "Update" button renders below the editor)
# ---------------------------------------------------------------------------------------------
PREVIEW_SUBFOLDER = "nougan_load_video"
PREVIEW_MAX_EDGE = 512
PREVIEW_KEEP = 24
_PREVIEW_LOCK = threading.Lock()


def _preview_dir() -> str:
    base = None
    if folder_paths is not None:
        try:
            base = folder_paths.get_temp_directory()
        except Exception:
            base = None
    if not base:
        base = os.path.join(tempfile.gettempdir(), "comfyui")
    d = os.path.join(base, PREVIEW_SUBFOLDER)
    os.makedirs(d, exist_ok=True)
    return d


def _prune_previews(d: str, keep: int = PREVIEW_KEEP):
    try:
        files = [os.path.join(d, f) for f in os.listdir(d) if f.endswith((".mp4", ".webm"))]
        files.sort(key=lambda p: os.path.getmtime(p), reverse=True)
        for old in files[keep:]:
            try:
                os.remove(old)
            except OSError:
                pass
    except OSError:
        pass


def _encode_preview(frames, fps: float, out_path: str, codec: str, container_opts: dict, codec_opts: dict):
    h, w = frames[0].shape[:2]
    rate = Fraction(float(fps)).limit_denominator(1000)
    with av.open(out_path, mode="w", options=container_opts) as out:
        stream = out.add_stream(codec, rate=rate)
        stream.width = w
        stream.height = h
        stream.pix_fmt = "yuv420p"
        stream.options = codec_opts
        for arr in frames:
            vf = av.VideoFrame.from_ndarray(np.ascontiguousarray(arr), format="rgb24")
            for pkt in stream.encode(vf):
                out.mux(pkt)
        for pkt in stream.encode(None):
            out.mux(pkt)


def render_preview(plan: dict, resize_method: str = "bicubic") -> dict:
    """Render the exact trim/crop/resize described by `plan` to a small browser-playable clip."""
    out_w, out_h = plan["output_width"], plan["output_height"]
    scale = min(1.0, PREVIEW_MAX_EDGE / float(max(out_w, out_h)))
    pw = max(2, int(round(out_w * scale / 2.0)) * 2)
    ph = max(2, int(round(out_h * scale / 2.0)) * 2)

    st = os.stat(plan["path"])
    key_src = f"{plan['plan_id']}|{resize_method}|{pw}x{ph}|{st.st_size}|{int(st.st_mtime)}"
    key = hashlib.sha1(key_src.encode("utf-8")).hexdigest()[:16]
    d = _preview_dir()

    info = {
        "subfolder": PREVIEW_SUBFOLDER,
        "type": "temp",
        "output_width": out_w,
        "output_height": out_h,
        "output_frames": plan["output_frames"],
        "output_fps": plan["output_fps"],
        "preview_width": pw,
        "preview_height": ph,
    }

    with _PREVIEW_LOCK:
        for ext in (".mp4", ".webm"):
            if os.path.isfile(os.path.join(d, key + ext)):
                return {**info, "filename": key + ext, "cached": True}

        frames = [_resize_frame_np(f, pw, ph, resize_method) for f in _iter_source_frames(plan)]
        if not frames:
            raise PlanError("Decoded 0 frames for the requested trim range.")
        frames = [frames[i] for i in _resample_indices(len(frames), plan["output_frames"])]

        attempts = [
            (".mp4", "libx264", {"movflags": "faststart"}, {"crf": "24", "preset": "veryfast"}),
            (".mp4", "libopenh264", {"movflags": "faststart"}, {}),
            (".mp4", "h264", {"movflags": "faststart"}, {}),
            (".webm", "libvpx-vp9", {}, {"crf": "34", "b": "0", "deadline": "realtime", "cpu-used": "8"}),
            (".webm", "libvpx", {}, {"crf": "12", "b": "2M"}),
        ]
        last_err = None
        for ext, codec, c_opts, k_opts in attempts:
            final = os.path.join(d, key + ext)
            tmp = os.path.join(d, f"{key}.part{ext}")
            try:
                _encode_preview(frames, plan["output_fps"], tmp, codec, c_opts, k_opts)
                os.replace(tmp, final)
                _prune_previews(d)
                return {**info, "filename": key + ext, "cached": False}
            except Exception as exc:  # codec missing in this PyAV build, try the next one
                last_err = exc
                try:
                    os.remove(tmp)
                except OSError:
                    pass
        raise PlanError(f"No browser-playable encoder available in PyAV ({last_err}).")


class NouganLoadVideo:
    @classmethod
    def INPUT_TYPES(cls):
        videos = list_video_files()
        return {
            "required": {
                "video": (videos if videos else [""], {"video_upload": True}),
                "start_frame": ("INT", {"default": 0, "min": 0, "max": MAX_INT, "step": 1}),
                "end_frame": ("INT", {"default": 0, "min": 0, "max": MAX_INT, "step": 1}),
                "crop_x": ("INT", {"default": 0, "min": 0, "max": MAX_INT, "step": 1}),
                "crop_y": ("INT", {"default": 0, "min": 0, "max": MAX_INT, "step": 1}),
                "crop_w": ("INT", {"default": 0, "min": 0, "max": MAX_INT, "step": 1}),
                "crop_h": ("INT", {"default": 0, "min": 0, "max": MAX_INT, "step": 1}),
                "resize_mode": (RESIZE_MODES, {"default": "none"}),
                "size": ("INT", {"default": 720, "min": 16, "max": 8192, "step": 1}),
                "size_h": ("INT", {"default": 720, "min": 16, "max": 8192, "step": 1}),
                "multiple_of": ("INT", {"default": 16, "min": 1, "max": 128, "step": 1}),
                "resize_method": (RESIZE_METHODS, {"default": "bicubic"}),
                "frame_rule": (list(FRAME_RULES.keys()), {"default": "17n+5"}),
                "snap_from": (SNAP_FROM, {"default": "end"}),
                "max_frames": ("INT", {"default": 0, "min": 0, "max": MAX_INT, "step": 1}),
                "target_fps": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 240.0, "step": 0.1}),
            }
        }

    RETURN_TYPES = ("IMAGE", "AUDIO", "INT", "FLOAT")
    RETURN_NAMES = ("frames", "audio", "frame_count", "fps")
    FUNCTION = "load_video"
    CATEGORY = "Nougan/Video"

    def load_video(
        self,
        video,
        start_frame=0,
        end_frame=0,
        crop_x=0,
        crop_y=0,
        crop_w=0,
        crop_h=0,
        resize_mode="none",
        size=720,
        size_h=720,
        multiple_of=16,
        resize_method="bicubic",
        frame_rule="17n+5",
        snap_from="end",
        max_frames=0,
        target_fps=0.0,
    ):
        plan = build_plan(
            video=video,
            start_frame=start_frame,
            end_frame=end_frame,
            crop_x=crop_x,
            crop_y=crop_y,
            crop_w=crop_w,
            crop_h=crop_h,
            resize_mode=resize_mode,
            size=size,
            size_h=size_h,
            multiple_of=multiple_of,
            frame_rule=frame_rule,
            snap_from=snap_from,
            max_frames=max_frames,
            target_fps=target_fps,
        )
        return decode_plan(plan, resize_method=resize_method)


def _plan_from_body(body: dict) -> dict:
    return build_plan(
        video=body.get("video", ""),
        start_frame=body.get("start_frame", 0),
        end_frame=body.get("end_frame", 0),
        crop_x=body.get("crop_x", 0),
        crop_y=body.get("crop_y", 0),
        crop_w=body.get("crop_w", 0),
        crop_h=body.get("crop_h", 0),
        resize_mode=body.get("resize_mode", "none"),
        size=body.get("size", 720),
        size_h=body.get("size_h", 720),
        multiple_of=body.get("multiple_of", 16),
        frame_rule=body.get("frame_rule", "17n+5"),
        snap_from=body.get("snap_from", "end"),
        max_frames=body.get("max_frames", 0),
        target_fps=body.get("target_fps", 0.0),
    )


def register_routes(prompt_server):
    """Register /nougan/load_video/plan and /nougan/load_video/preview on PromptServer."""
    from aiohttp import web

    routes = prompt_server.routes

    @routes.post("/nougan/load_video/plan")
    async def _plan_endpoint(request):
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"error": "Invalid JSON body."}, status=400)

        try:
            plan = await asyncio.get_running_loop().run_in_executor(None, lambda: _plan_from_body(body))
            return web.json_response(plan)
        except PlanError as exc:
            return web.json_response({"error": str(exc)}, status=400)
        except Exception as exc:
            return web.json_response({"error": f"Plan failed: {exc}"}, status=500)

    @routes.post("/nougan/load_video/preview")
    async def _preview_endpoint(request):
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"error": "Invalid JSON body."}, status=400)

        method = body.get("resize_method", "bicubic")
        if method not in RESIZE_METHODS:
            method = "bicubic"

        def _job():
            plan = _plan_from_body(body)
            result = render_preview(plan, resize_method=method)
            result["plan"] = {k: v for k, v in plan.items() if k != "path"}
            return result

        try:
            result = await asyncio.get_running_loop().run_in_executor(None, _job)
            return web.json_response(result)
        except PlanError as exc:
            return web.json_response({"error": str(exc)}, status=400)
        except Exception as exc:
            return web.json_response({"error": f"Preview failed: {exc}"}, status=500)


NODE_CLASS_MAPPINGS = {
    "NouganLoadVideo": NouganLoadVideo,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "NouganLoadVideo": "Nougan Load Video 🎬",
}