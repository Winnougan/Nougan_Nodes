# nougan_gallery_load.py  —  Nougan Gallery Load
#
# Thumbnail gallery loader. The UI lives in web/nougan_gallery_load.js (+ web/css/nougan_gallery_load.css).
#
#   /nougan/gallery/list?path=...            -> images in a folder  [{n: name, m: mtime}]
#   /nougan/gallery/thumb?path=&name=&px=&m= -> cached WEBP thumbnail (128 / 256 / 512 / 1024)
#   /nougan/gallery/dirs?path=...            -> sub-folders, for the in-node folder browser
#
# All routes are local-requests-only. Set NOUGAN_GALLERY_ALLOW_REMOTE=1 to allow LAN access
# (e.g. when ComfyUI runs with --listen and you browse from another machine).
#
# The node has MAX_OUTPUTS image outputs (P1..P64). The JS shows only as many as there are
# selected images; the selection is stored in the hidden "selection" widget as a JSON list of file names,
# in selection order (first image you picked = P1).

import asyncio
import hashlib
import json
import os
import re
import string
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import torch
from PIL import Image, ImageOps

import folder_paths
from aiohttp import web
from server import PromptServer

MAX_OUTPUTS = 64
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff"}
THUMB_BUCKETS = (128, 256, 512, 1024)

_pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="nougan_gallery")
_LANCZOS = getattr(getattr(Image, "Resampling", Image), "LANCZOS")


# ─────────────────────────────────────────────────────────────────────────────
#  helpers
# ─────────────────────────────────────────────────────────────────────────────
def _clean_path(p):
    p = (p or "").strip().strip('"').strip("'").strip()
    if not p:
        return ""
    return os.path.normpath(os.path.expanduser(p))


def _natural_key(s):
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", s)]


def _safe_name(name):
    if not name or name in (".", ".."):
        return False
    if "/" in name or "\\" in name or name != os.path.basename(name):
        return False
    return os.path.splitext(name)[1].lower() in IMAGE_EXTS


def _local_only(request):
    if os.environ.get("NOUGAN_GALLERY_ALLOW_REMOTE") == "1":
        return True
    peer = request.remote or ""
    return peer in ("127.0.0.1", "::1", "localhost") or peer.startswith("::ffff:127.")


def _cache_dir():
    base = None
    getter = getattr(folder_paths, "get_user_directory", None)
    if callable(getter):
        try:
            base = getter()
        except Exception:
            base = None
    if not base:
        try:
            base = folder_paths.get_temp_directory()
        except Exception:
            base = tempfile.gettempdir()
    d = os.path.join(base, "nougan_gallery_thumbs")
    os.makedirs(d, exist_ok=True)
    return d


def _scan(root):
    out = []
    with os.scandir(root) as it:
        for e in it:
            try:
                if not e.is_file():
                    continue
                if os.path.splitext(e.name)[1].lower() not in IMAGE_EXTS:
                    continue
                out.append((e.name, int(e.stat().st_mtime)))
            except OSError:
                continue
    out.sort(key=lambda t: _natural_key(t[0]))
    return out


def _make_thumb(src, dst, px):
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    with Image.open(src) as im:
        try:
            im.draft("RGB", (px, px))  # fast JPEG downscale on decode
        except Exception:
            pass
        im = ImageOps.exif_transpose(im)
        if im.mode.startswith("I"):  # 16 / 32-bit greyscale
            a = np.asarray(im, dtype=np.float32)
            if a.max() > 255:
                a = a / 65535.0 * 255.0
            im = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), "L")
        if im.mode not in ("RGB", "RGBA"):
            has_alpha = im.mode in ("LA", "PA") or "transparency" in im.info
            im = im.convert("RGBA" if has_alpha else "RGB")
        im.thumbnail((px, px), _LANCZOS)
        tmp = f"{dst}.{os.getpid()}.{threading.get_ident()}.tmp"
        im.save(tmp, "WEBP", quality=82, method=4)
    os.replace(tmp, dst)


def _parse_selection(selection):
    try:
        data = json.loads(selection) if isinstance(selection, str) else selection
    except Exception:
        return []
    if isinstance(data, dict):
        data = data.get("files", [])
    if not isinstance(data, list):
        return []
    seen, out = set(), []
    for n in data:
        if isinstance(n, str) and _safe_name(n) and n not in seen:
            seen.add(n)
            out.append(n)
    return out


def _load_tensor(path):
    with Image.open(path) as im:
        im = ImageOps.exif_transpose(im)
        if im.mode.startswith("I"):
            a = np.asarray(im, dtype=np.float32)
            a = a / 65535.0 if a.max() > 255 else a / 255.0
            a = np.stack([a, a, a], axis=-1)
        else:
            a = np.asarray(im.convert("RGB"), dtype=np.float32) / 255.0
    return torch.from_numpy(np.ascontiguousarray(a))[None,]


# ─────────────────────────────────────────────────────────────────────────────
#  routes
# ─────────────────────────────────────────────────────────────────────────────
_routes = PromptServer.instance.routes


@_routes.get("/nougan/gallery/list")
async def _gallery_list(request):
    if not _local_only(request):
        return web.json_response({"error": "Local requests only"}, status=403)
    root = _clean_path(request.rel_url.query.get("path", ""))
    if not root or not os.path.isdir(root):
        return web.json_response({"error": "Folder not found"}, status=404)
    loop = asyncio.get_running_loop()
    try:
        items = await loop.run_in_executor(_pool, _scan, root)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)
    return web.json_response({"path": root, "images": [{"n": n, "m": m} for n, m in items]})


@_routes.get("/nougan/gallery/thumb")
async def _gallery_thumb(request):
    if not _local_only(request):
        return web.Response(status=403)
    q = request.rel_url.query
    root = _clean_path(q.get("path", ""))
    name = q.get("name", "")
    if not root or not _safe_name(name):
        return web.Response(status=400)
    src = os.path.join(root, name)
    if not os.path.isfile(src):
        return web.Response(status=404)
    try:
        want = int(q.get("px", "256"))
    except ValueError:
        want = 256
    px = next((b for b in THUMB_BUCKETS if b >= want), THUMB_BUCKETS[-1])

    st = os.stat(src)
    key = hashlib.sha1(f"{src}|{st.st_mtime_ns}|{st.st_size}|{px}".encode("utf-8")).hexdigest()
    dst = os.path.join(_cache_dir(), key[:2], key + ".webp")
    if not os.path.isfile(dst):
        loop = asyncio.get_running_loop()
        try:
            await loop.run_in_executor(_pool, _make_thumb, src, dst, px)
        except Exception as e:
            return web.Response(status=500, text=f"thumbnail failed: {e}")
    return web.FileResponse(dst, headers={"Cache-Control": "public, max-age=31536000, immutable"})


@_routes.get("/nougan/gallery/dirs")
async def _gallery_dirs(request):
    if not _local_only(request):
        return web.json_response({"error": "Local requests only"}, status=403)
    raw = request.rel_url.query.get("path", "")

    def work():
        p = _clean_path(raw)
        if not p:
            if os.name == "nt":
                drives = [f"{c}:\\" for c in string.ascii_uppercase if os.path.exists(f"{c}:\\")]
                return {"path": "", "parent": None,
                        "dirs": [{"name": d, "path": d} for d in drives], "images": 0}
            p = os.path.expanduser("~")
        if not os.path.isdir(p):
            raise FileNotFoundError("Folder not found")
        dirs, imgs = [], 0
        with os.scandir(p) as it:
            for e in it:
                try:
                    if e.is_dir():
                        if not e.name.startswith("."):
                            dirs.append({"name": e.name, "path": e.path})
                    elif os.path.splitext(e.name)[1].lower() in IMAGE_EXTS:
                        imgs += 1
                except OSError:
                    continue
        dirs.sort(key=lambda d: _natural_key(d["name"]))
        parent = os.path.dirname(p)
        if parent == p:
            parent = "" if os.name == "nt" else None  # "" = drive list on Windows
        return {"path": p, "parent": parent, "dirs": dirs, "images": imgs}

    loop = asyncio.get_running_loop()
    try:
        return web.json_response(await loop.run_in_executor(_pool, work))
    except FileNotFoundError as e:
        return web.json_response({"error": str(e)}, status=404)
    except PermissionError:
        return web.json_response({"error": "Permission denied"}, status=403)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


# ─────────────────────────────────────────────────────────────────────────────
#  node
# ─────────────────────────────────────────────────────────────────────────────
class NouganGalleryLoad:
    CATEGORY = "Nougan"
    FUNCTION = "load"
    DESCRIPTION = ("Browse a folder as a thumbnail gallery and pick images. "
                   "Each selected image gets its own output: P1, P2, P3 ...")
    RETURN_TYPES = ("IMAGE",) * MAX_OUTPUTS
    RETURN_NAMES = tuple(f"P{i + 1}" for i in range(MAX_OUTPUTS))

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "folder": ("STRING", {"default": "", "multiline": False}),
                # Hidden by the JS. JSON list of selected file names, in selection order.
                "selection": ("STRING", {"default": "[]", "multiline": False}),
            }
        }

    @classmethod
    def IS_CHANGED(cls, folder, selection):
        root = _clean_path(folder)
        h = hashlib.sha1(root.encode("utf-8"))
        for n in _parse_selection(selection):
            try:
                h.update(f"{n}|{os.stat(os.path.join(root, n)).st_mtime_ns}".encode("utf-8"))
            except OSError:
                h.update(f"{n}|missing".encode("utf-8"))
        return h.hexdigest()

    def load(self, folder, selection):
        root = _clean_path(folder)
        files = _parse_selection(selection)[:MAX_OUTPUTS]
        if files and not os.path.isdir(root):
            raise FileNotFoundError(f"[Nougan Gallery Load] Folder not found: {root}")

        images = []
        for n in files:
            p = os.path.join(root, n)
            if not os.path.isfile(p):
                raise FileNotFoundError(f"[Nougan Gallery Load] File not found: {p}")
            images.append(_load_tensor(p))

        # Unused outputs are never wired (the UI only shows P1..Pn), so pad with a tiny blank.
        blank = torch.zeros((1, 64, 64, 3), dtype=torch.float32)
        while len(images) < MAX_OUTPUTS:
            images.append(blank)
        return tuple(images)
