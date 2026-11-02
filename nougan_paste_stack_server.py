# nougan_paste_stack_server.py — clipboard helper for "Automagic 2222: Paste Stack"
#
# Why this exists: a web page can never read FILES you copied in Explorer/Finder (browser security rule),
# so a single click couldn't paste them. ComfyUI's server runs on your own PC, though, so it can look at
# the clipboard for the widget. The widget calls this only when you click the paste area and the browser
# found no text/image data.
#
# Safety: loopback / this-machine requests only, a custom header is required (so other websites can't
# trigger it), and only image and text files up to 25 MB are returned — the files you just copied.
# If ComfyUI runs on a different machine than your browser this returns nothing and the widget falls back
# to Ctrl+V.

import asyncio
import base64
import io
import mimetypes
import os
import socket
import subprocess
import sys

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

MAX_FILES = 10
MAX_FILE_BYTES = 25 * 1024 * 1024
MAX_TOTAL_BYTES = 60 * 1024 * 1024
ALLOWED_EXT = {
    ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".avif", ".tif", ".tiff",
    ".txt", ".md", ".json", ".csv", ".tsv", ".yaml", ".yml", ".log", ".ini", ".toml", ".xml",
}
_MIME_FIX = {".webp": "image/webp", ".avif": "image/avif", ".md": "text/markdown", ".json": "application/json"}


def _local_addrs():
    addrs = {"127.0.0.1", "::1", "localhost"}
    try:
        addrs.update(socket.gethostbyname_ex(socket.gethostname())[2])
    except Exception:
        pass
    return addrs


def _is_local(remote):
    if not remote:
        return False
    if remote.startswith("::ffff:"):          # IPv4-mapped IPv6
        remote = remote[7:]
    return remote in _local_addrs()


def _clipboard_content():
    """Return (paths, image). `paths` = files copied in the file manager; `image` = a PIL image if the
    clipboard holds raw picture data instead."""
    try:
        from PIL import ImageGrab
        data = ImageGrab.grabclipboard()
        if isinstance(data, (list, tuple)):
            return [str(p) for p in data], None
        if data is not None:
            return [], data
    except Exception:
        pass
    if sys.platform == "win32":
        try:
            ps = ("[Console]::OutputEncoding=[Text.Encoding]::UTF8;"
                  "Get-Clipboard -Format FileDropList | ForEach-Object { $_.FullName }")
            out = subprocess.run(
                ["powershell", "-NoProfile", "-NonInteractive", "-STA", "-Command", ps],
                capture_output=True, timeout=6, creationflags=0x08000000,   # CREATE_NO_WINDOW
            )
            lines = out.stdout.decode("utf-8", errors="replace").splitlines()
            return [l.strip() for l in lines if l.strip()], None
        except Exception:
            pass
    return [], None


def _collect():
    paths, image = _clipboard_content()
    files, total = [], 0
    for p in paths:
        if len(files) >= MAX_FILES:
            break
        try:
            ext = os.path.splitext(p)[1].lower()
            if ext not in ALLOWED_EXT or not os.path.isfile(p):
                continue
            size = os.path.getsize(p)
            if size > MAX_FILE_BYTES or total + size > MAX_TOTAL_BYTES:
                continue
            with open(p, "rb") as fh:
                raw = fh.read()
            total += size
            mime = _MIME_FIX.get(ext) or mimetypes.guess_type(p)[0] or "application/octet-stream"
            files.append({"name": os.path.basename(p), "mime": mime, "data": base64.b64encode(raw).decode("ascii")})
        except Exception:
            continue
    if not files and image is not None:                      # raw picture data (e.g. a screenshot)
        try:
            buf = io.BytesIO()
            image.convert("RGBA").save(buf, "PNG")
            files.append({"name": "clipboard.png", "mime": "image/png",
                          "data": base64.b64encode(buf.getvalue()).decode("ascii")})
        except Exception:
            pass
    return files


def _register():
    try:
        from aiohttp import web
        from server import PromptServer
        routes = PromptServer.instance.routes
    except Exception:
        return

    @routes.post("/nougan/paste_stack/clipboard")
    async def _paste_stack_clipboard(request):
        if request.headers.get("X-Nougan-Paste") != "1":
            return web.json_response({"files": [], "error": "forbidden"}, status=403)
        if not _is_local(request.remote):
            return web.json_response({"files": [], "error": "not-local"}, status=403)
        try:
            files = await asyncio.get_running_loop().run_in_executor(None, _collect)
        except Exception:
            files = []
        return web.json_response({"files": files})


_register()
