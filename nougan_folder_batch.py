"""
Nougan folder batch loaders + caption saver.

How `auto_run_folder` works
---------------------------
* OFF ("single image/video"): the node loads exactly files[index % total].
* ON  ("run whole folder"): the node loads files[index] and reports, through
  its UI output, which index comes next (`next_index`, or -1 at the end of the
  folder). The front-end extension (web/nougan_folder_batch.js) reads that and
  queues the next prompt, so ONE press of Run walks the entire folder.
  In this mode IS_CHANGED always returns NaN, so ComfyUI's cache can never
  skip an item (re-running a folder really re-runs it).

Node IDs, inputs and outputs are unchanged, so existing workflows keep working.
UI note: the preview is now sent under the "preview" key (not "images") so the
custom card draws it instead of ComfyUI drawing a second copy on the node.
"""
import hashlib
from fractions import Fraction
import os
import re

import numpy as np
import torch
from PIL import Image, ImageOps

import folder_paths

# Native ComfyUI VIDEO type (location differs between ComfyUI versions)
try:
    from comfy_api.latest import InputImpl as _InputImpl, Types as _Types
    _VideoFromComponents = _InputImpl.VideoFromComponents
    _VideoComponents = _Types.VideoComponents
except Exception:
    try:
        from comfy_api.input_impl import VideoFromComponents as _VideoFromComponents
        from comfy_api.input import VideoComponents as _VideoComponents
    except Exception:
        _VideoFromComponents = None
        _VideoComponents = None

IMAGE_EXTS = {
    ".png", ".jpg", ".jpeg", ".jfif", ".webp", ".bmp",
    ".tif", ".tiff", ".gif",
}
VIDEO_EXTS = {
    ".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v", ".flv",
    ".wmv", ".mpg", ".mpeg", ".ts", ".3gp",
}

SORT_NUMERIC = "numeric (001, 002, 10...)"
SORT_ALPHA = "alphabetical"

PREVIEW_MAX_SIDE = 1024


# ─────────────────────────────────────────────────────────────── helpers ──

def _clean_path(p: str) -> str:
    # Windows "Copy as path" wraps the path in quotes, strip them
    return os.path.expandvars(os.path.expanduser(p.strip().strip('"').strip("'")))


def _natural_key(name: str):
    # "img2" < "img10", "001" < "002" < "010"
    parts = re.split(r"(\d+)", name)
    key = [(0, int(t)) if t.isdigit() else (1, t.casefold()) for t in parts if t != ""]
    return (key, name)


def _alpha_key(name: str):
    return (name.casefold(), name)


def _list_files(label: str, folder: str, sort_mode: str, exts):
    if not folder:
        raise ValueError(f"[{label}] folder_path is empty.")
    if not os.path.isdir(folder):
        raise ValueError(f"[{label}] Folder not found: {folder}")

    names = [
        f for f in os.listdir(folder)
        if os.path.isfile(os.path.join(folder, f))
        and os.path.splitext(f)[1].lower() in exts
    ]
    names.sort(key=_alpha_key if sort_mode == SORT_ALPHA else _natural_key)
    return names


def list_images(folder: str, sort_mode: str):
    return _list_files("FolderImageBatchLoader", folder, sort_mode, IMAGE_EXTS)


def list_videos(folder: str, sort_mode: str):
    return _list_files("FolderVideoBatchLoader", folder, sort_mode, VIDEO_EXTS)


def _resolve_index(label: str, index: int, total: int, auto_run_folder: bool) -> int:
    """
    single mode : wrap around (index 12 of 10 files -> file 2), like before.
    folder mode : never wrap. Silently wrapping would make a chain run from
                  the wrong place or loop forever, so fail loudly instead.
    """
    index = int(index)
    if auto_run_folder:
        if index >= total:
            raise ValueError(
                f"[{label}] 'run whole folder' is on but index {index} is past the "
                f"last file ({total} files, last index is {total - 1}). Set index to 0."
            )
        return index
    return index % total


def _batch_ui(preview, idx: int, total: int, auto_run_folder: bool, name: str):
    """What the front-end card needs. This is where auto_run_folder takes effect."""
    next_index = idx + 1 if (auto_run_folder and idx + 1 < total) else -1
    return {
        "preview": [preview],
        "batch_info": [idx, total],
        "auto_run": [1 if auto_run_folder else 0],
        "next_index": [next_index],
        "file_name": [name],
    }


def _make_preview(img: Image.Image, key: str):
    prev = img.convert("RGBA") if "A" in img.getbands() else img.convert("RGB")
    prev.thumbnail((PREVIEW_MAX_SIDE, PREVIEW_MAX_SIDE), Image.Resampling.LANCZOS)

    fname = "fbl_" + hashlib.md5(key.encode("utf-8")).hexdigest()[:16] + ".png"
    temp_dir = folder_paths.get_temp_directory()
    os.makedirs(temp_dir, exist_ok=True)
    prev.save(os.path.join(temp_dir, fname), compress_level=1)
    return {"filename": fname, "subfolder": "", "type": "temp"}


# ───────────────────────────────────────────────────────────── image node ──

class FolderImageBatchLoader:
    CATEGORY = "image/batch"
    FUNCTION = "load"
    RETURN_TYPES = ("IMAGE", "MASK", "STRING", "STRING", "INT", "INT")
    RETURN_NAMES = ("image", "mask", "filename", "path", "index", "total")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "folder_path": ("STRING", {"default": "", "multiline": False}),
                "sort_mode": ([SORT_NUMERIC, SORT_ALPHA],),
                "index": ("INT", {"default": 0, "min": 0, "max": 0xFFFFFF, "step": 1}),
                "auto_run_folder": ("BOOLEAN", {
                    "default": True,
                    "label_on": "run whole folder",
                    "label_off": "single image",
                }),
            }
        }

    @classmethod
    def IS_CHANGED(cls, folder_path, sort_mode, index, auto_run_folder=True, **kwargs):
        # Folder mode: always execute. The cache must never swallow an item,
        # and the front-end relies on this node reporting back every time.
        if auto_run_folder:
            return float("nan")
        try:
            folder = _clean_path(folder_path)
            files = list_images(folder, sort_mode)
            if not files:
                return float("nan")
            full = os.path.join(folder, files[index % len(files)])
            st = os.stat(full)
            return f"{full}|{st.st_mtime_ns}|{st.st_size}|{len(files)}"
        except Exception:
            return float("nan")

    def load(self, folder_path, sort_mode, index, auto_run_folder=True):
        label = "FolderImageBatchLoader"
        folder = _clean_path(folder_path)
        files = list_images(folder, sort_mode)
        total = len(files)
        if total == 0:
            raise ValueError(f"[{label}] No images found in: {folder}")

        idx = _resolve_index(label, index, total, auto_run_folder)
        name = files[idx]
        full = os.path.join(folder, name)

        img = Image.open(full)
        img = ImageOps.exif_transpose(img)

        if img.mode == "I":
            img = img.point(lambda i: i * (1 / 255))
        if img.mode == "P" and "transparency" in img.info:
            img = img.convert("RGBA")

        has_alpha = "A" in img.getbands()
        rgb = img.convert("RGB")
        arr = np.array(rgb).astype(np.float32) / 255.0
        image = torch.from_numpy(arr)[None,]

        if has_alpha:
            alpha = np.array(img.getchannel("A")).astype(np.float32) / 255.0
            mask = 1.0 - torch.from_numpy(alpha)  # same convention as core LoadImage
        else:
            mask = torch.zeros((rgb.height, rgb.width), dtype=torch.float32)
        mask = mask.unsqueeze(0)

        preview = _make_preview(img, f"{full}|{os.stat(full).st_mtime_ns}")
        stem = os.path.splitext(name)[0]

        return {
            "ui": _batch_ui(preview, idx, total, auto_run_folder, name),
            "result": (image, mask, stem, full, idx, total),
        }


# ───────────────────────────────────────────────────────────── video node ──

def _video_first_frame(path: str):
    import av
    with av.open(path) as c:
        for frame in c.decode(video=0):
            return frame.to_image()
    raise ValueError(f"No video frames in: {path}")


def _decode_video(path, force_rate, frame_load_cap, skip_first, nth, max_side):
    """Returns (frames[N,H,W,3] float32 tensor, output_fps, start_sec, end_sec|None)."""
    import av

    frames = []
    nth = max(1, int(nth))
    size = None
    last_raw = skip_first

    with av.open(path) as c:
        vs = c.streams.video[0]
        src_fps = float(vs.average_rate) if vs.average_rate else 24.0
        step = src_fps / force_rate if 0 < force_rate < src_fps else 1.0
        next_t = float(skip_first)
        accepted = 0
        capped = False

        for raw_i, frame in enumerate(c.decode(video=0)):
            if raw_i < skip_first or raw_i < next_t:
                continue
            next_t += step
            accepted += 1
            if (accepted - 1) % nth != 0:
                continue

            if size is None:
                w, h = frame.width, frame.height
                if max_side and max(w, h) > max_side:
                    scale = max_side / float(max(w, h))
                    w, h = int(round(w * scale)), int(round(h * scale))
                size = (max(2, w - w % 2), max(2, h - h % 2))

            arr = frame.reformat(width=size[0], height=size[1], format="rgb24").to_ndarray()
            frames.append(arr)
            last_raw = raw_i
            if frame_load_cap and len(frames) >= frame_load_cap:
                capped = True
                break

    if not frames:
        raise ValueError(f"[FolderVideoBatchLoader] No frames decoded from: {path}")

    video = torch.from_numpy(np.stack(frames).astype(np.float32) / 255.0)
    out_fps = src_fps / step / nth
    start_sec = skip_first / src_fps
    end_sec = (last_raw + 1) / src_fps if capped else None
    return video, out_fps, start_sec, end_sec


def _decode_audio(path, start_sec=0.0, end_sec=None):
    """ComfyUI AUDIO dict, or None if the file has no audio stream."""
    import av

    with av.open(path) as c:
        if not c.streams.audio:
            return None
        a = c.streams.audio[0]
        sr = int(a.rate or 44100)
        rs = av.AudioResampler(format="fltp", layout="stereo", rate=sr)
        chunks = []

        def _grab(out):
            if out is None:
                return
            if not isinstance(out, list):
                out = [out]
            for o in out:
                chunks.append(o.to_ndarray())

        for fr in c.decode(a):
            _grab(rs.resample(fr))
        _grab(rs.resample(None))

    if not chunks:
        return None
    wave = np.concatenate(chunks, axis=1)
    s0 = int(start_sec * sr)
    s1 = int(end_sec * sr) if end_sec else wave.shape[1]
    wave = wave[:, s0:s1]
    if wave.shape[1] == 0:
        return None
    return {"waveform": torch.from_numpy(wave).float().unsqueeze(0), "sample_rate": sr}


def _silent_audio(sr=44100):
    return {"waveform": torch.zeros((1, 2, sr // 10), dtype=torch.float32), "sample_rate": sr}


class FolderVideoBatchLoader:
    CATEGORY = "video/batch"
    FUNCTION = "load"
    RETURN_TYPES = ("IMAGE", "AUDIO", "STRING", "STRING", "INT", "INT", "FLOAT", "VIDEO")
    RETURN_NAMES = ("frames", "audio", "filename", "path", "index", "total", "fps", "video")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "folder_path": ("STRING", {"default": "", "multiline": False}),
                "sort_mode": ([SORT_NUMERIC, SORT_ALPHA],),
                "index": ("INT", {"default": 0, "min": 0, "max": 0xFFFFFF, "step": 1}),
                "auto_run_folder": ("BOOLEAN", {
                    "default": True,
                    "label_on": "run whole folder",
                    "label_off": "single video",
                }),
            },
            "optional": {
                "force_rate": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 120.0, "step": 0.5}),
                "frame_load_cap": ("INT", {"default": 0, "min": 0, "max": 100000, "step": 1}),
                "skip_first_frames": ("INT", {"default": 0, "min": 0, "max": 1000000, "step": 1}),
                "select_every_nth": ("INT", {"default": 1, "min": 1, "max": 1000, "step": 1}),
                "resize_longest_side": ("INT", {"default": 0, "min": 0, "max": 8192, "step": 2}),
            },
        }

    @classmethod
    def IS_CHANGED(cls, folder_path, sort_mode, index, auto_run_folder=True, **kwargs):
        if auto_run_folder:
            return float("nan")
        try:
            folder = _clean_path(folder_path)
            files = list_videos(folder, sort_mode)
            if not files:
                return float("nan")
            full = os.path.join(folder, files[index % len(files)])
            st = os.stat(full)
            extra = "|".join(str(kwargs.get(k)) for k in sorted(kwargs))
            return f"{full}|{st.st_mtime_ns}|{st.st_size}|{len(files)}|{extra}"
        except Exception:
            return float("nan")

    def load(self, folder_path, sort_mode, index, auto_run_folder=True,
             force_rate=0.0, frame_load_cap=0, skip_first_frames=0,
             select_every_nth=1, resize_longest_side=0):
        label = "FolderVideoBatchLoader"
        folder = _clean_path(folder_path)
        files = list_videos(folder, sort_mode)
        total = len(files)
        if total == 0:
            raise ValueError(f"[{label}] No videos found in: {folder}")

        idx = _resolve_index(label, index, total, auto_run_folder)
        name = files[idx]
        full = os.path.join(folder, name)

        frames, fps, t0, t1 = _decode_video(
            full, force_rate, frame_load_cap, skip_first_frames,
            select_every_nth, resize_longest_side,
        )

        try:
            audio = _decode_audio(full, t0, t1)
        except Exception as e:
            print(f"[{label}] Audio decode failed for {name}: {e}")
            audio = None
        if audio is None:
            print(f"[{label}] No audio in {name}, using silence.")
            audio = _silent_audio()

        first = Image.fromarray((frames[0].numpy() * 255.0).clip(0, 255).astype(np.uint8))
        preview = _make_preview(first, f"{full}|{os.stat(full).st_mtime_ns}")
        stem = os.path.splitext(name)[0]

        video = None
        if _VideoFromComponents is not None:
            video = _VideoFromComponents(
                _VideoComponents(images=frames, audio=audio, frame_rate=Fraction(fps).limit_denominator(1000))
            )
        else:
            print(f"[{label}] Native VIDEO type unavailable in this ComfyUI version; "
                  "'video' output will be empty. Use frames + audio instead.")

        return {
            "ui": _batch_ui(preview, idx, total, auto_run_folder, name),
            "result": (frames, audio, stem, full, idx, total, float(fps), video),
        }


# ─────────────────────────────────────────────────────────── caption saver ──

SAVE_BESIDE = "next to image"
SAVE_CUSTOM = "custom folder"


class SaveCaptionMatchImage:
    """Saves text as <file name>.txt next to the image or video from the batch loader."""

    CATEGORY = "image/batch"
    FUNCTION = "save"
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("saved_path",)
    OUTPUT_NODE = True

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {"forceInput": True}),
                "image_path": ("STRING", {"forceInput": True}),
                "save_location": ([SAVE_BESIDE, SAVE_CUSTOM],),
                "custom_folder": ("STRING", {"default": "", "multiline": False}),
                "extension": ("STRING", {"default": "txt", "multiline": False}),
                "overwrite": ("BOOLEAN", {
                    "default": True,
                    "label_on": "overwrite existing",
                    "label_off": "skip if exists",
                }),
            }
        }

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        # always write, the text is the whole point
        return float("nan")

    def save(self, text, image_path, save_location, custom_folder, extension, overwrite):
        image_path = _clean_path(image_path)
        if not image_path:
            raise ValueError("[SaveCaptionMatchImage] image_path is empty.")

        stem = os.path.splitext(os.path.basename(image_path))[0]
        ext = extension.strip().lstrip(".") or "txt"

        if save_location == SAVE_CUSTOM:
            out_dir = _clean_path(custom_folder)
            if not out_dir:
                raise ValueError(
                    "[SaveCaptionMatchImage] save_location is 'custom folder' but custom_folder is empty."
                )
        else:
            out_dir = os.path.dirname(image_path)

        os.makedirs(out_dir, exist_ok=True)
        out_path = os.path.join(out_dir, f"{stem}.{ext}")

        if os.path.exists(out_path) and not overwrite:
            print(f"[SaveCaptionMatchImage] Skipped (already exists): {out_path}")
        else:
            with open(out_path, "w", encoding="utf-8", newline="\n") as f:
                f.write(text.strip())
            print(f"[SaveCaptionMatchImage] Saved: {out_path}")

        return {"ui": {"text": [out_path]}, "result": (out_path,)}


# ───────────────────────────────────────────────────────────────── routes ──

_ROUTE_REGISTERED = False


def _register_routes():
    """/nougan/folder_batch/scan powers the card's preview + refresh button."""
    global _ROUTE_REGISTERED
    if _ROUTE_REGISTERED:
        return
    try:
        from server import PromptServer
        from aiohttp import web
        routes = PromptServer.instance.routes
    except Exception:
        return

    @routes.get("/nougan/folder_batch/scan")
    async def _scan(request):
        try:
            folder = _clean_path(request.query.get("folder", ""))
            sort_mode = request.query.get("sort", SORT_NUMERIC)
            kind = request.query.get("kind", "image")
            try:
                index = int(request.query.get("index", "0"))
            except ValueError:
                index = 0

            files = (list_videos if kind == "video" else list_images)(folder, sort_mode)
            total = len(files)
            if total == 0:
                return web.json_response(
                    {"ok": False, "error": f"No {kind}s found in: {folder}"}
                )

            idx = index if 0 <= index < total else 0
            full = os.path.join(folder, files[idx])
            if kind == "video":
                preview = _make_preview(
                    _video_first_frame(full), f"{full}|{os.stat(full).st_mtime_ns}"
                )
            else:
                with Image.open(full) as raw:
                    img = ImageOps.exif_transpose(raw)
                    preview = _make_preview(img, f"{full}|{os.stat(full).st_mtime_ns}")

            return web.json_response({
                "ok": True,
                "total": total,
                "index": idx,
                "requested_index": index,
                "name": files[idx],
                "first": files[0],
                "last": files[-1],
                "preview": preview,
            })
        except Exception as e:
            return web.json_response({"ok": False, "error": str(e)})

    _ROUTE_REGISTERED = True


_register_routes()


NODE_CLASS_MAPPINGS = {
    "FolderImageBatchLoader": FolderImageBatchLoader,
    "FolderVideoBatchLoader": FolderVideoBatchLoader,
    "SaveCaptionMatchImage": SaveCaptionMatchImage,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "FolderImageBatchLoader": "Load Image Batch From Folder",
    "FolderVideoBatchLoader": "Load Video Batch From Folder",
    "SaveCaptionMatchImage": "Save Caption (Match Image/Video Name)",
}
