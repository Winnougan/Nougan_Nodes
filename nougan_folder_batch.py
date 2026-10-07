import hashlib
import os
import re

import numpy as np
import torch
from PIL import Image, ImageOps

import folder_paths

IMAGE_EXTS = {
    ".png", ".jpg", ".jpeg", ".jfif", ".webp", ".bmp",
    ".tif", ".tiff", ".gif",
}

SORT_NUMERIC = "numeric (001, 002, 10...)"
SORT_ALPHA = "alphabetical"

PREVIEW_MAX_SIDE = 1024


def _clean_path(p: str) -> str:
    # Windows "Copy as path" wraps the path in quotes, strip them
    return os.path.expandvars(os.path.expanduser(p.strip().strip('"').strip("'")))


def _natural_key(name: str):
    # "img2" < "img10", "001" < "002" < "010"
    parts = re.split(r"(\d+)", name)
    key = [int(t) if t.isdigit() else t.casefold() for t in parts]
    return (key, name)


def _alpha_key(name: str):
    return (name.casefold(), name)


def list_images(folder: str, sort_mode: str):
    if not folder:
        raise ValueError("[FolderImageBatchLoader] folder_path is empty.")
    if not os.path.isdir(folder):
        raise ValueError(f"[FolderImageBatchLoader] Folder not found: {folder}")

    names = [
        f for f in os.listdir(folder)
        if os.path.isfile(os.path.join(folder, f))
        and os.path.splitext(f)[1].lower() in IMAGE_EXTS
    ]
    names.sort(key=_alpha_key if sort_mode == SORT_ALPHA else _natural_key)
    return names


def _make_preview(img: Image.Image, key: str):
    prev = img.convert("RGBA") if "A" in img.getbands() else img.convert("RGB")
    prev.thumbnail((PREVIEW_MAX_SIDE, PREVIEW_MAX_SIDE), Image.Resampling.LANCZOS)

    fname = "fbl_" + hashlib.md5(key.encode("utf-8")).hexdigest()[:16] + ".png"
    temp_dir = folder_paths.get_temp_directory()
    os.makedirs(temp_dir, exist_ok=True)
    prev.save(os.path.join(temp_dir, fname), compress_level=1)
    return {"filename": fname, "subfolder": "", "type": "temp"}


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
    def IS_CHANGED(cls, folder_path, sort_mode, index, **kwargs):
        try:
            folder = _clean_path(folder_path)
            files = list_images(folder, sort_mode)
            if not files:
                return float("nan")
            name = files[index % len(files)]
            full = os.path.join(folder, name)
            st = os.stat(full)
            return f"{full}|{st.st_mtime_ns}|{st.st_size}|{len(files)}"
        except Exception:
            return float("nan")

    def load(self, folder_path, sort_mode, index, auto_run_folder=True):
        folder = _clean_path(folder_path)
        files = list_images(folder, sort_mode)
        total = len(files)
        if total == 0:
            raise ValueError(f"[FolderImageBatchLoader] No images found in: {folder}")

        idx = index % total  # wraps if index is past the end
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
            "ui": {
                "images": [preview],
                "batch_info": [idx, total],
            },
            "result": (image, mask, stem, full, idx, total),
        }


SAVE_BESIDE = "next to image"
SAVE_CUSTOM = "custom folder"


class SaveCaptionMatchImage:
    """Saves text as <image name>.txt, using the path from the batch loader."""

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


_ROUTE_REGISTERED = False


def _register_routes():
    """/nougan/folder_batch/scan powers the 'Refresh folder' button."""
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
            try:
                index = int(request.query.get("index", "0"))
            except ValueError:
                index = 0

            files = list_images(folder, sort_mode)
            total = len(files)
            if total == 0:
                return web.json_response(
                    {"ok": False, "error": f"No images found in: {folder}"}
                )

            idx = index if 0 <= index < total else 0
            full = os.path.join(folder, files[idx])
            with Image.open(full) as raw:
                img = ImageOps.exif_transpose(raw)
                preview = _make_preview(img, f"{full}|{os.stat(full).st_mtime_ns}")

            return web.json_response({
                "ok": True,
                "total": total,
                "index": idx,
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
    "SaveCaptionMatchImage": SaveCaptionMatchImage,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "FolderImageBatchLoader": "Load Image Batch From Folder",
    "SaveCaptionMatchImage": "Save Caption (Match Image Name)",
}
