# nougan_r34_scraper.py — Nougan suite
# Gelbooru-engine scraper (rule34.xxx and siblings). Paste a list/search URL,
# the node downloads the raw (original-resolution) images to a folder in
# ComfyUI's output directory. Optional post-pass via ImageMagick:
# convert to jpeg/jpg/png/webp, max compression, sequential rename (001...).
# Live progress + preview are served to the node widget over /nougan/r34/state.

import os
import re
import json
import time
import shutil
import threading
import subprocess
from urllib.parse import urlparse, parse_qs, quote_plus

import folder_paths

try:
    import requests
except Exception:
    requests = None

HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                         "AppleWebKit/537.36 (KHTML, like Gecko) "
                         "Chrome/124.0 Safari/537.36"}
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"}

try:    # lets ComfyUI's Cancel button (and our Stop button) halt a long run
    from comfy.model_management import (
        throw_exception_if_processing_interrupted as _check_interrupt,
        interrupt_current_processing as _interrupt_comfy,
        InterruptProcessingException as _Interrupted,
    )
except Exception:
    class _Interrupted(Exception):
        pass

    def _check_interrupt():
        pass

    def _interrupt_comfy(value=True):
        pass

_MAGICK = shutil.which("magick")
if not _MAGICK:
    _convert = shutil.which("convert")
    if _convert:
        try:
            if "imagemagick" in subprocess.run([_convert, "-version"],
                                               capture_output=True, text=True,
                                               timeout=10).stdout.lower():
                _MAGICK = _convert
        except Exception:
            pass

_STATE = {
    "running": False, "done": 0, "total": 0, "images": 0, "current": "",
    "folder": "", "dest": "", "files": [], "failed": 0, "skipped": 0, "error": "",
    "stopped": False, "magick": bool(_MAGICK),
}


def _set(**kw):
    _STATE.update(kw)


# ── hard stop ────────────────────────────────────────────────────────────────
# The node's Stop button POSTs to /nougan/<x>/stop. That sets _STOP, closes the request that is
# in flight, wakes any delay sleep and fires ComfyUI's own interrupt, so the whole run halts
# exactly like ComfyUI's Cancel button. _Stopped is a BaseException on purpose: the
# `except Exception` blocks around individual downloads must not swallow it.
class _Stopped(BaseException):
    pass


_STOP = threading.Event()
_LIVE = {"session": None, "resp": None}


def _checkpoint():
    """Call between every request and every downloaded chunk."""
    if _STOP.is_set():
        raise _Stopped()
    try:
        _check_interrupt()          # ComfyUI's own Cancel counts as a stop too
    except _Interrupted:
        _STOP.set()
        raise _Stopped()


def _nap(seconds):
    """time.sleep that wakes the instant Stop is pressed."""
    if _STOP.wait(seconds):
        raise _Stopped()
    _checkpoint()


def _rm(path):
    try:
        os.remove(path)
    except OSError:
        pass


def _kill_socket(resp):
    """close() alone does not wake a thread blocked in recv(); shutting the socket down does."""
    import socket
    raw = getattr(resp, "raw", None)
    socks = [getattr(getattr(raw, "_connection", None), "sock", None),
             getattr(getattr(getattr(getattr(raw, "_fp", None), "fp", None), "raw", None), "_sock", None)]
    for sk in socks:
        if sk is not None:
            try:
                sk.shutdown(socket.SHUT_RDWR)
            except Exception:
                pass


def _stop_now():
    if not _STATE["running"]:
        return False
    _STOP.set()
    _set(current="stopping…")
    resp = _LIVE.get("resp")
    if resp is not None:
        _kill_socket(resp)
    for k in ("resp", "session"):
        try:
            if _LIVE.get(k) is not None:
                _LIVE[k].close()
        except Exception:
            pass
    try:
        _interrupt_comfy(True)
    except Exception:
        pass
    return True


def _parse_url(url):
    """https://rule34.xxx/index.php?page=post&s=list&tags=rockbot -> (host, 'rockbot')"""
    try:
        p = urlparse(url.strip())
        host = p.netloc
        tags = parse_qs(p.query).get("tags", [""])[0].replace("+", " ").strip()
        return host, re.sub(r"\s+", " ", tags)
    except Exception:
        return "", ""


_MODULE_DIR = os.path.dirname(os.path.abspath(__file__))
_CRED_FILE = os.path.join(_MODULE_DIR, "nougan_r34_credentials.json")
AUTH_HELP = ("rule34.xxx now requires an API key + user ID. Get both at "
             "https://rule34.xxx/index.php?page=account&s=options (row 'API Access Credentials'), "
             "then either paste them into the node's api_key / user_id fields, set the "
             "RULE34_API_KEY / RULE34_USER_ID environment variables, or put them in "
             "nougan_r34_credentials.json next to this node.")


_CRED_NOTE = ""   # what happened with the credentials file; shown in auth errors


def _clean(v):
    """Drop the stray '&', '?', quotes and whitespace that ride along when the value is
    copied out of the '&api_key=...&user_id=...' string on the account page."""
    return str(v or "").strip().strip("&?\"' \t\r\n")


def _credentials(api_key, user_id):
    """Widget value > environment variable > nougan_r34_credentials.json.
    Pasting the whole '&api_key=...&user_id=...' string from the account page into
    the api_key field also works."""
    global _CRED_NOTE
    fcfg = {}
    if not os.path.exists(_CRED_FILE):
        _CRED_NOTE = f"credentials file not found at {_CRED_FILE}"
    else:
        try:
            # utf-8-sig: Windows Notepad can save a BOM, which plain utf-8 rejects
            with open(_CRED_FILE, encoding="utf-8-sig") as f:
                fcfg = json.load(f)
            _CRED_NOTE = f"credentials file loaded from {_CRED_FILE}"
        except Exception as e:
            _CRED_NOTE = f"credentials file found but unreadable ({e})"
    k = (api_key or "").strip()
    u = (user_id or "").strip()
    if "api_key=" in k or "user_id=" in k:
        q = parse_qs(k.lstrip("?&"))
        k = q.get("api_key", [""])[0].strip()
        u = u or q.get("user_id", [""])[0].strip()
    k = k or os.environ.get("RULE34_API_KEY", "").strip() or str(fcfg.get("api_key", "")).strip()
    u = u or os.environ.get("RULE34_USER_ID", "").strip() or str(fcfg.get("user_id", "")).strip()
    return _clean(k), _clean(u)


def _auth_error(key, uid):
    """Say WHICH auth problem it is: nothing found vs. server said no."""
    have = (f"api_key: {'set, %d chars' % len(key) if key else 'MISSING'}, "
            f"user_id: {'set' if uid else 'MISSING'}")
    if not (key and uid):
        return f"no usable credentials found ({have}; {_CRED_NOTE}). {AUTH_HELP}"
    return (f"the server rejected the credentials that were sent ({have}; {_CRED_NOTE}). "
            "Check the key was copied whole (no spaces, no '&', no 'api_key=' label), "
            "that it belongs to this user ID, or regenerate it on the account page.")


def _api_hosts(host):
    """rule34.xxx serves its API from api.rule34.xxx; try that first, then the page host."""
    bare = re.sub(r"^www\.", "", host.lower())
    return [f"api.{bare}", host] if bare == "rule34.xxx" else [host]


def _fetch_page(host, tags, pid, key, uid, limit=100):
    """One page of posts as a list. Raises RuntimeError with a readable reason instead of
    silently returning nothing (the old code swallowed API errors and reported 'no posts')."""
    last = ""
    for h in _api_hosts(host):
        params = {"page": "dapi", "s": "post", "q": "index", "json": "1",
                  "tags": tags, "pid": pid, "limit": limit}   # API hard cap: 1000 per request
        if key and uid:
            params.update(api_key=key, user_id=uid)
        r = None
        for attempt in range(3):          # API limits can change; back off on 429/503
            _checkpoint()
            try:
                r = (_LIVE["session"] or requests).get(f"https://{h}/index.php", params=params,
                                                       headers=HEADERS, timeout=(10, 30))
            except Exception as e:
                _checkpoint()       # a Stop closes the socket: report it as a stop, not an error
                last = f"{h}: {e}"
                r = None
                break
            if r.status_code in (429, 503) and attempt < 2:
                _nap(1.5 * (attempt + 1))
                continue
            break
        if r is None:
            continue
        text = (r.text or "").strip()
        if "Missing authentication" in text or r.status_code == 401:
            raise RuntimeError(_auth_error(key, uid))
        if r.status_code in (403, 429):
            last = f"{h}: HTTP {r.status_code} (blocked or rate-limited) {text[:120]}"
            continue
        if not text or text == "[]":
            return []                      # genuinely no results
        try:
            data = r.json()
        except Exception:
            last = f"{h}: unexpected reply (HTTP {r.status_code}): {text[:160]}"
            continue
        if isinstance(data, dict) and data.get("success") is False:
            # documented failure shape: {"success": false, "message": "search down"}
            raise RuntimeError(f"{h}: API error - {data.get('message') or 'search down'}")
        if isinstance(data, dict):         # some boards wrap posts: {"post": [...]}
            data = data.get("post", [])
            if isinstance(data, dict):
                data = [data]
        if isinstance(data, list):
            return data
        last = f"{h}: unexpected JSON shape"
    raise RuntimeError(last or "no response from the API")


def _api_url(host, tags, pid):
    return (f"https://{host}/index.php?page=dapi&s=post&q=index&json=1"
            f"&tags={quote_plus(tags)}&pid={pid}")


def _safe_name(s):
    return re.sub(r"[^\w\-. ]+", "_", str(s)).strip(" ._")[:64]


def _resolve_dest(folder, tags=""):
    """What the user typed -> (relative path using '/', absolute path).
    Always lands INSIDE ComfyUI's output directory:
      - relative names are taken as sub-folders of output/ (nesting is fine: datasets/rockbot)
      - a pasted absolute path that already points inside output/ is trimmed to the part below it
      - drive letters, leading slashes and '..' are stripped, so it can never escape output/
      - empty = first tag, else 'r34'
    """
    root = os.path.abspath(folder_paths.get_output_directory())
    raw = str(folder or "").strip().strip("\"'")
    if raw and os.path.isabs(raw):
        try:
            ab = os.path.abspath(raw)
            if os.path.commonpath([ab, root]) == root:
                raw = os.path.relpath(ab, root)
        except ValueError:      # different drive
            pass
    raw = re.sub(r"^[A-Za-z]:", "", raw.replace("\\", "/"))
    parts = [p for p in (_safe_name(seg) for seg in raw.split("/")) if p]
    if not parts:
        parts = [_safe_name(tags.split(" ")[0]) if tags else ""]
    rel = "/".join(p for p in parts if p) or "r34"
    dest = os.path.abspath(os.path.join(root, *rel.split("/")))
    try:
        if os.path.commonpath([dest, root]) != root:
            rel, dest = "r34", os.path.join(root, "r34")
    except ValueError:
        rel, dest = "r34", os.path.join(root, "r34")
    return rel, dest


# ── ImageMagick post-processing ──────────────────────────────────────────────

def _compress_flags(ext):
    """Max-compression flags per format."""
    ext = ext.lower()
    if ext == ".png":
        return ["-strip", "-define", "png:compression-level=9",
                "-define", "png:compression-strategy=2"]
    if ext in (".jpg", ".jpeg"):
        return ["-strip", "-interlace", "Plane", "-quality", "85"]
    if ext == ".webp":
        return ["-strip", "-quality", "90", "-define", "webp:method=6"]
    return ["-strip"]


def _magick(src, dst, flags):
    r = subprocess.run([_MAGICK, src, *flags, dst],
                       capture_output=True, text=True, timeout=300)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip()[-400:] or "magick failed")


def _convert_all(files, out_dir, fmt, compress):
    ext = ".jpeg" if fmt == "jpeg" else f".{fmt}"
    out = []
    for f in files:
        src = os.path.join(out_dir, f)
        stem = os.path.splitext(f)[0]
        dst_name = stem + ext
        dst = os.path.join(out_dir, dst_name)
        try:
            flags = _compress_flags(ext) if compress else ["-strip"]
            _magick(src, dst, flags)
            if dst != src:
                os.remove(src)
            out.append(dst_name)
            _set(current=dst_name)
        except Exception as e:
            print(f"[Nougan R34] convert failed for {f}: {e}")
            _STATE["failed"] += 1
            out.append(f)  # keep the original
    return out


def _compress_all(files, out_dir):
    for f in files:
        src = os.path.join(out_dir, f)
        ext = os.path.splitext(f)[1]
        try:
            tmp = src + ".tmp" + ext
            _magick(src, tmp, _compress_flags(ext))
            os.replace(tmp, src)
        except Exception as e:
            print(f"[Nougan R34] compress failed for {f}: {e}")
            _STATE["failed"] += 1


def _rename_seq(files, out_dir):
    """Sort by post id, rename to 001.ext, 002.ext, ... Two-phase through a
    temp prefix so a target name can never clobber a not-yet-renamed file."""
    if not files:
        return files

    def key(f):
        m = re.match(r"(\d+)", os.path.splitext(f)[0])
        return (0, int(m.group(1))) if m else (1, f)

    ordered = sorted(files, key=key)
    final = [f"{i:03d}{os.path.splitext(f)[1]}" for i, f in enumerate(ordered, 1)]
    tmp = [f".r34tmp_{i:04d}{os.path.splitext(f)[1]}" for i, f in enumerate(ordered)]
    for f, t in zip(ordered, tmp):
        os.replace(os.path.join(out_dir, f), os.path.join(out_dir, t))
    for t, n in zip(tmp, final):
        os.replace(os.path.join(out_dir, t), os.path.join(out_dir, n))
    return final


# ── the node ─────────────────────────────────────────────────────────────────

class NouganR34Scraper:
    CATEGORY = "Nougan"
    RETURN_TYPES = ("STRING", "INT")
    RETURN_NAMES = ("folder", "count")
    FUNCTION = "scrape"
    OUTPUT_NODE = True   # a downloader has side effects: run it even with nothing connected after it
    DESCRIPTION = ("Download images from a Gelbooru-style board (rule34.xxx) into "
                   "a folder in the output directory, with optional convert / "
                   "compress / sequential-rename post-processing.")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "url": ("STRING", {"default": "",
                                   "tooltip": "List/search URL, e.g. https://rule34.xxx/index.php?page=post&s=list&tags=rockbot"}),
                "max_images": ("INT", {"default": 50, "min": 1, "max": 20000, "step": 1}),
                "convert_format": (["original", "jpeg", "jpg", "png", "webp"],
                                   {"default": "original",
                                    "tooltip": "Re-encode every image to this format with ImageMagick. 'jpeg' writes .jpeg, 'jpg' writes .jpg."}),
                "rename": ("BOOLEAN", {"default": False,
                                       "tooltip": "When done, rename to 001.ext, 002.ext, ... ordered by post id."}),
                "compress": ("BOOLEAN", {"default": True,
                                         "tooltip": "Maximum compression for the target format (png level 9, jpeg q85, webp method 6)."}),
                "show_preview": ("BOOLEAN", {"default": True,
                                             "tooltip": "Show the live preview window on the node."}),
                "folder": ("STRING", {"default": "nougan_r34",
                                      "tooltip": "Where to save, relative to ComfyUI's output folder (nesting ok: datasets/rockbot). Empty = named after the first tag."}),
            },
            "optional": {
                "api_key": ("STRING", {"default": "",
                                       "tooltip": "rule34.xxx API key (account options page). Leave empty to use RULE34_API_KEY or nougan_r34_credentials.json instead - keeps the key out of your workflow files and PNG metadata."}),
                "user_id": ("STRING", {"default": "",
                                       "tooltip": "rule34.xxx numeric user ID. Same fallbacks as api_key (RULE34_USER_ID / nougan_r34_credentials.json)."}),
                "overwrite": ("BOOLEAN", {"default": False,
                                          "tooltip": "Re-download images that already exist in the folder and replace them (also removes an older converted copy of the same post, e.g. a .webp). Off = posts already in the folder are skipped. Renamed files (001.ext) can't be matched."}),
            },
        }

    def scrape(self, url, max_images, convert_format, rename, compress,
               show_preview, folder, api_key="", user_id="", overwrite=False):
        if requests is None:
            raise RuntimeError("[Nougan R34] 'requests' is not installed. "
                               "Add it to requirements.txt and restart ComfyUI.")
        needs_magick = convert_format != "original" or compress
        if needs_magick and not _MAGICK:
            raise RuntimeError(
                "[Nougan R34] ImageMagick not found on PATH. Install ImageMagick 7 "
                "(https://imagemagick.org/script/download.php#windows), tick "
                "'Add application directory to your system PATH', restart ComfyUI. "
                "ImageMagick is a system program - it cannot be pip-installed.")

        host, tags = _parse_url(url)
        if not host or not tags:
            raise ValueError("[Nougan R34] Could not read host/tags from the URL. "
                             "Expected something like "
                             "https://rule34.xxx/index.php?page=post&s=list&tags=rockbot")

        out_name, out_dir = _resolve_dest(folder, tags)
        os.makedirs(out_dir, exist_ok=True)

        _STOP.clear()
        _set(running=True, done=0, total=0, images=0, current="", folder=out_name, dest=out_dir,
             files=[], failed=0, skipped=0, error="", stopped=False)
        session = requests.Session()
        _LIVE["session"] = session
        downloaded = []

        try:
            # ── collect post list via the dapi ──
            key, uid = _credentials(api_key, user_id)
            dl_headers = {**HEADERS, "Referer": f"https://{host}/"}
            page_size = max(1, min(1000, int(max_images)))   # fewer requests; API caps at 1000
            posts, pid = [], 0
            while len(posts) < max_images:
                _checkpoint()
                try:
                    data = _fetch_page(host, tags, pid, key, uid, page_size)
                except Exception as e:
                    _set(error=str(e))
                    break
                if not data:
                    break
                posts.extend(data)
                if len(data) < page_size:
                    break
                pid += 1
            posts = posts[:max_images]
            if not posts:
                err = _STATE.get("error") or ""
                if err:
                    raise RuntimeError(f"[Nougan R34] {err}")
                raise ValueError(f"[Nougan R34] No posts found for tags '{tags}' on {host}.")

            _set(total=len(posts))

            # stem (post id) -> file names already in the folder (any extension)
            existing = {}
            for nm in os.listdir(out_dir):
                if not nm.endswith(".part"):
                    existing.setdefault(os.path.splitext(nm)[0], []).append(nm)

            # ── download raw images ──
            for i, p in enumerate(posts, 1):
                _checkpoint()
                furl = (p.get("file_url") or "").strip()
                ext = os.path.splitext(urlparse(furl).path)[1].lower() if furl else ""
                if not furl or ext not in IMAGE_EXTS:   # no file, or video/swf - raw images only
                    _set(done=i)
                    continue
                stem = str(p.get("id", "x"))
                name = f"{stem}{ext}"
                if not overwrite and stem in existing:
                    _STATE["skipped"] += 1
                    _set(done=i)
                    continue
                dest = os.path.join(out_dir, name)
                part = dest + ".part"
                try:
                    with session.get(furl, headers=dl_headers, timeout=(10, 60), stream=True) as r:
                        _LIVE["resp"] = r
                        r.raise_for_status()
                        with open(part, "wb") as f:
                            for chunk in r.iter_content(1 << 16):
                                _checkpoint()
                                f.write(chunk)
                    os.replace(part, dest)
                    # overwrite: drop an older copy of this post under another extension
                    for old in existing.get(stem, []):
                        if old != name:
                            _rm(os.path.join(out_dir, old))
                    existing[stem] = [name]
                    downloaded.append(name)
                    _set(images=len(downloaded), current=name, files=downloaded[-200:])
                except _Stopped:
                    _rm(part)
                    raise
                except Exception:
                    if _STOP.is_set():          # Stop closed the connection under us
                        _rm(part)
                        raise _Stopped()
                    _STATE["failed"] += 1
                    _rm(part)
                finally:
                    _LIVE["resp"] = None
                _set(done=i)

            # ── post-processing ──
            files = downloaded
            try:
                if convert_format != "original":
                    files = _convert_all(files, out_dir, convert_format, compress)
                elif compress:
                    _compress_all(files, out_dir)
                if rename:
                    files = _rename_seq(files, out_dir)
            except Exception as e:
                _STATE["failed"] += 1
                print(f"[Nougan R34] post-processing error: {e}")

            _set(images=len(files), files=files[-200:], current="", done=len(posts))
            print(f"[Nougan R34] {len(files)} images -> {out_dir} "
                  f"({_STATE['skipped']} skipped, {_STATE['failed']} failed)")
            return (out_dir, len(files))
        except _Stopped:
            # hard stop: keep what's already saved, skip convert / compress / rename
            _set(stopped=True, images=len(downloaded), files=downloaded[-200:], current="")
            print(f"[Nougan R34] stopped by user - {len(downloaded)} images kept in {out_dir}")
            raise _Interrupted()
        except Exception as e:
            _set(error=str(e))
            raise
        finally:
            _LIVE["resp"] = None
            _LIVE["session"] = None
            try:
                session.close()
            except Exception:
                pass
            _set(running=False)


# ── routes ───────────────────────────────────────────────────────────────────

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

    @routes.get("/nougan/r34/state")
    async def _state(request):
        if not _local(request):
            return web.Response(status=403)
        return web.json_response({k: v for k, v in _STATE.items()})

    @routes.get("/nougan/r34/resolve")
    async def _resolve(request):
        """Lets the node show exactly where files will go before you queue."""
        if not _local(request):
            return web.Response(status=403)
        _, tags = _parse_url(request.query.get("url", ""))
        rel, dest = _resolve_dest(request.query.get("folder", ""), tags)
        return web.json_response({"rel": rel, "dest": dest})

    @routes.post("/nougan/r34/stop")
    async def _stop(request):
        """Hard stop for the current run (the node's Stop button)."""
        if not _local(request):
            return web.Response(status=403)
        return web.json_response({"stopped": _stop_now()})

    print("  [Nougan] R34 scraper routes registered (/nougan/r34/*)")


register_routes()


NODE_CLASS_MAPPINGS = {"NouganR34Scraper": NouganR34Scraper}
NODE_DISPLAY_NAME_MAPPINGS = {"NouganR34Scraper": "Nougan R34 Scraper 🕸️"}
