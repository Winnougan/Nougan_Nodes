# nougan_pixiv_scraper.py — Nougan suite
# Pixiv scraper, sister of nougan_r34_scraper.py. Paste an artist URL (or a single
# artwork URL); the node downloads the original-resolution images to a folder in
# ComfyUI's output directory. Optional post-pass via ImageMagick: convert to
# jpeg/jpg/png/webp, max compression, sequential rename (001...).
# Live progress + preview are served to the node widget over /nougan/pixiv/state.
#
# Uses pixiv's web endpoints (the same JSON the site itself loads), not an official API:
#   /ajax/user/<id>/profile/all      -> ids of the artist's illustrations and manga
#   /ajax/illust/<id>/pages          -> original image URL of every page of a work
# Original files come from i.pximg.net and need a pixiv Referer header.

import os
import re
import json
import time
import shutil
import threading
import subprocess
from urllib.parse import urlparse

import folder_paths

try:
    import requests
except Exception:
    requests = None

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

SITE = "https://www.pixiv.net"
# pixiv sits behind Cloudflare, which rejects user agents that don't say Mozilla/5.0
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"}

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
    "folder": "", "dest": "", "files": [], "failed": 0, "skipped": 0,
    "error": "", "stopped": False, "magick": bool(_MAGICK),
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


class PixivError(RuntimeError):
    pass


# ── what the user pasted ─────────────────────────────────────────────────────

def _parse_target(text):
    """-> ('user', id) | ('work', id) | None
    https://www.pixiv.net/en/users/124609772/artworks  -> user
    https://www.pixiv.net/en/artworks/12345678         -> work
    https://www.pixiv.net/member.php?id=124609772      -> user
    124609772 (digits only)                            -> user
    """
    s = str(text or "").strip()
    m = re.search(r"/artworks/(\d+)", s) or re.search(r"illust_id=(\d+)", s)
    if m:
        return "work", int(m.group(1))
    m = re.search(r"/users/(\d+)", s) or re.search(r"[?&]id=(\d+)", s)
    if m:
        return "user", int(m.group(1))
    if re.fullmatch(r"\d+", s):
        return "user", int(s)
    return None


# ── session cookie ───────────────────────────────────────────────────────────

_MODULE_DIR = os.path.dirname(os.path.abspath(__file__))
_CRED_FILE = os.path.join(_MODULE_DIR, "nougan_pixiv_credentials.json")
_CRED_NOTE = ""   # what happened with the credentials file; shown in errors


def _clean_cookie(v):
    """Accept the bare value, 'PHPSESSID=value', or a whole copied Cookie header."""
    v = str(v or "").strip()
    m = re.search(r"PHPSESSID=([^;\s]+)", v)
    if m:
        v = m.group(1)
    return v.strip().strip(";\"' \t\r\n")


def _credentials(cookie):
    """Widget value > environment variable PIXIV_PHPSESSID > nougan_pixiv_credentials.json."""
    global _CRED_NOTE
    fcfg = {}
    if not os.path.exists(_CRED_FILE):
        _CRED_NOTE = f"credentials file not found at {_CRED_FILE}"
    else:
        try:
            with open(_CRED_FILE, encoding="utf-8-sig") as f:   # tolerate Notepad's BOM
                fcfg = json.load(f)
            _CRED_NOTE = f"credentials file loaded from {_CRED_FILE}"
        except Exception as e:
            _CRED_NOTE = f"credentials file found but unreadable ({e})"
    return (_clean_cookie(cookie)
            or _clean_cookie(os.environ.get("PIXIV_PHPSESSID", ""))
            or _clean_cookie(fcfg.get("phpsessid", "")))


def _cookie_state(cookie):
    return f"PHPSESSID: set, {len(cookie)} chars" if cookie else "PHPSESSID: not set"


# ── pixiv requests ───────────────────────────────────────────────────────────

def _new_session(cookie):
    s = requests.Session()
    s.headers.update({"User-Agent": UA, "Referer": SITE + "/", "Accept": "application/json"})
    if cookie:
        s.cookies.set("PHPSESSID", cookie, domain=".pixiv.net")
    return s


def _get_json(session, path, params=None):
    """GET a pixiv ajax endpoint and return its 'body'. Raises PixivError with a readable reason."""
    r = None
    for attempt in range(3):          # back off on rate limiting
        _checkpoint()
        try:
            r = session.get(SITE + path, params={"lang": "en", **(params or {})}, timeout=(10, 30))
        except Exception as e:
            _checkpoint()           # a Stop closes the socket: report it as a stop, not a network error
            raise PixivError(f"network error: {e}")
        if r.status_code in (429, 503) and attempt < 2:
            _nap(3 * (attempt + 1))
            continue
        break
    if r.status_code == 403:
        raise PixivError("HTTP 403 (blocked by pixiv or Cloudflare, or a login is required)")
    if r.status_code == 429:
        raise PixivError("HTTP 429 (rate-limited; raise 'delay' and try again later)")
    try:
        data = r.json()
    except Exception:
        raise PixivError(f"unexpected reply (HTTP {r.status_code}): {(r.text or '')[:160]!r}")
    if isinstance(data, dict) and data.get("error"):
        raise PixivError(data.get("message") or f"the API reported an error (HTTP {r.status_code})")
    return data.get("body") if isinstance(data, dict) else data


def _work_ids(body, include):
    keys = {"illustrations + manga": ("illusts", "manga"),
            "illustrations": ("illusts",),
            "manga": ("manga",)}.get(include, ("illusts", "manga"))
    ids = set()
    for k in keys:
        v = (body or {}).get(k) or {}
        items = v.keys() if isinstance(v, dict) else (v if isinstance(v, list) else [])
        for x in items:
            try:
                ids.add(int(x))
            except (TypeError, ValueError):
                pass
    return ids


# ── folder rules (same as the R34 scraper) ───────────────────────────────────

def _safe_name(s):
    return re.sub(r"[^\w\-. ]+", "_", str(s)).strip(" ._")[:64]


def _resolve_dest(folder, hint=""):
    """What the user typed -> (relative path using '/', absolute path).
    Always lands INSIDE ComfyUI's output directory:
      - relative names are taken as sub-folders of output/ (nesting is fine: datasets/artist)
      - a pasted absolute path that already points inside output/ is trimmed to the part below it
      - drive letters, leading slashes and '..' are stripped, so it can never escape output/
      - empty = pixiv_<user id>, else 'pixiv'
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
        parts = [_safe_name(hint)] if hint else []
    rel = "/".join(parts) or "pixiv"
    dest = os.path.abspath(os.path.join(root, *rel.split("/")))
    try:
        if os.path.commonpath([dest, root]) != root:
            rel, dest = "pixiv", os.path.join(root, "pixiv")
    except ValueError:
        rel, dest = "pixiv", os.path.join(root, "pixiv")
    return rel, dest


def _hint(target):
    if not target:
        return ""
    return f"pixiv_{target[1]}" if target[0] == "user" else f"pixiv_work_{target[1]}"


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
        dst_name = os.path.splitext(f)[0] + ext
        dst = os.path.join(out_dir, dst_name)
        try:
            flags = _compress_flags(ext) if compress else ["-strip"]
            if dst == src:      # same name: write beside it, then swap in
                tmp = src + ".tmp" + ext
                _magick(src, tmp, flags)
                os.replace(tmp, src)
            else:
                _magick(src, dst, flags)
                os.remove(src)
            out.append(dst_name)
            _set(current=dst_name)
        except Exception as e:
            print(f"[Nougan Pixiv] convert failed for {f}: {e}")
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
            print(f"[Nougan Pixiv] compress failed for {f}: {e}")
            _STATE["failed"] += 1


def _rename_seq(files, out_dir):
    """Sort by work id then page, rename to NNN.ext. Numbering continues after the highest
    NNN.ext already in the folder, so running again with rename on never overwrites an
    earlier batch. Two-phase through a temp prefix so a target can't clobber a pending file."""
    if not files:
        return files

    def key(f):
        m = re.match(r"(\d+)(?:_p(\d+))?", os.path.splitext(f)[0])
        return (0, int(m.group(1)), int(m.group(2) or 0)) if m else (1, f, 0)

    mine = set(files)
    taken = [int(os.path.splitext(n)[0]) for n in os.listdir(out_dir)
             if n not in mine and re.fullmatch(r"\d{3,}\.\w+", n)]
    start = max(taken) + 1 if taken else 1

    ordered = sorted(files, key=key)
    final = [f"{i:03d}{os.path.splitext(f)[1]}" for i, f in enumerate(ordered, start)]
    tmp = [f".pxtmp_{i:04d}{os.path.splitext(f)[1]}" for i, f in enumerate(ordered)]
    for f, t in zip(ordered, tmp):
        os.replace(os.path.join(out_dir, f), os.path.join(out_dir, t))
    for t, n in zip(tmp, final):
        os.replace(os.path.join(out_dir, t), os.path.join(out_dir, n))
    return final


# ── the node ─────────────────────────────────────────────────────────────────

class NouganPixivScraper:
    CATEGORY = "Nougan"
    RETURN_TYPES = ("STRING", "INT")
    RETURN_NAMES = ("folder", "count")
    FUNCTION = "scrape"
    OUTPUT_NODE = True   # a downloader has side effects: run it even with nothing connected after it
    DESCRIPTION = ("Download the original images of a pixiv artist's works (or one artwork) into "
                   "a folder in the output directory, with optional convert / compress / "
                   "sequential-rename post-processing. Paced requests; see the docs page for "
                   "pixiv's terms.")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "url": ("STRING", {"default": "",
                                   "tooltip": "Artist page or artwork URL, e.g. https://www.pixiv.net/en/users/124609772/artworks or https://www.pixiv.net/en/artworks/12345678. A bare number is read as an artist ID."}),
                "max_works": ("INT", {"default": 20, "min": 1, "max": 5000, "step": 1,
                                      "tooltip": "How many works to fetch. A work can hold several pages, so the image count can be higher."}),
                "include": (["illustrations + manga", "illustrations", "manga"],
                            {"default": "illustrations + manga"}),
                "order": (["newest first", "oldest first"], {"default": "newest first"}),
                "delay": ("FLOAT", {"default": 1.0, "min": 0.5, "max": 10.0, "step": 0.1,
                                    "tooltip": "Seconds to wait between requests. Keep it polite: pixiv's terms prohibit loading its servers excessively."}),
                "skip_existing": ("BOOLEAN", {"default": True,
                                              "tooltip": "Skip pages already in the folder (matched by name, ignoring the extension). Works when 'rename' is off; renamed files can't be matched. Ignored when 'overwrite' is on."}),
                "convert_format": (["original", "jpeg", "jpg", "png", "webp"],
                                   {"default": "original",
                                    "tooltip": "Re-encode every image to this format with ImageMagick. 'jpeg' writes .jpeg, 'jpg' writes .jpg. The originals are deleted after conversion."}),
                "rename": ("BOOLEAN", {"default": False,
                                       "tooltip": "When done, rename to 001.ext, 002.ext, ... ordered by work id and page. Numbering continues after any NNN files already in the folder."}),
                "compress": ("BOOLEAN", {"default": False,
                                         "tooltip": "Maximum compression for the target format (png level 9, jpeg q85, webp method 6). JPEG and WebP are lossy; leave this off to keep the files exactly as posted."}),
                "show_preview": ("BOOLEAN", {"default": True,
                                             "tooltip": "Show the live preview window on the node."}),
                "folder": ("STRING", {"default": "nougan_pixiv",
                                      "tooltip": "Where to save, relative to ComfyUI's output folder (nesting ok: datasets/artist). Empty = pixiv_<artist id>."}),
            },
            "optional": {
                "cookie": ("STRING", {"default": "",
                                      "tooltip": "Your pixiv PHPSESSID cookie. Needed for R-18 and login-only works; public works may work without it. Leave empty to use PIXIV_PHPSESSID or nougan_pixiv_credentials.json instead - keeps the session out of your workflow files and PNG metadata."}),
                "overwrite": ("BOOLEAN", {"default": False,
                                          "tooltip": "Re-download pages that already exist in the folder and replace them (also removes an older converted copy of the same page, e.g. a .webp). Off = existing pages are skipped when skip_existing is on."}),
            },
        }

    def scrape(self, url, max_works, include, order, delay, skip_existing, convert_format,
               rename, compress, show_preview, folder, cookie="", overwrite=False):
        if requests is None:
            raise RuntimeError("[Nougan Pixiv] 'requests' is not installed. "
                               "Add it to requirements.txt and restart ComfyUI.")
        needs_magick = convert_format != "original" or compress
        if needs_magick and not _MAGICK:
            raise RuntimeError(
                "[Nougan Pixiv] ImageMagick not found on PATH. Install ImageMagick 7 "
                "(https://imagemagick.org/script/download.php#windows), tick "
                "'Add application directory to your system PATH', restart ComfyUI. "
                "ImageMagick is a system program - it cannot be pip-installed. "
                "Or set convert_format to 'original' and turn compress off.")

        target = _parse_target(url)
        if not target:
            raise ValueError("[Nougan Pixiv] Could not read an artist or artwork from the URL. "
                             "Expected something like "
                             "https://www.pixiv.net/en/users/124609772/artworks "
                             "or https://www.pixiv.net/en/artworks/12345678")

        out_name, out_dir = _resolve_dest(folder, _hint(target))
        os.makedirs(out_dir, exist_ok=True)
        _STOP.clear()
        _set(running=True, done=0, total=0, images=0, current="", folder=out_name, dest=out_dir,
             files=[], failed=0, skipped=0, error="", stopped=False)

        sess_cookie = _credentials(cookie)
        ctx = f"{_cookie_state(sess_cookie)}; {_CRED_NOTE}"
        session = _new_session(sess_cookie)
        _LIVE["session"] = session
        delay = max(0.5, float(delay))
        downloaded = []

        try:
            # ── which works ──
            if target[0] == "work":
                ids = [target[1]]
            else:
                try:
                    body = _get_json(session, f"/ajax/user/{target[1]}/profile/all")
                except PixivError as e:
                    raise RuntimeError(f"[Nougan Pixiv] could not list works for user {target[1]}: "
                                       f"{e} ({ctx})")
                ids = sorted(_work_ids(body, include), reverse=(order == "newest first"))
                _nap(delay)
            ids = ids[:max_works]
            if not ids:
                raise ValueError(f"[Nougan Pixiv] No {include} found for {target[0]} {target[1]}. "
                                 f"Private or R-18 works need a login cookie ({ctx}).")
            _set(total=len(ids))

            # stem -> file names already in the folder (any extension)
            existing = {}
            for nm in os.listdir(out_dir):
                if not nm.endswith(".part"):
                    existing.setdefault(os.path.splitext(nm)[0], []).append(nm)
            last_err = ""

            # ── each work: page list, then the originals ──
            for n, wid in enumerate(ids, 1):
                _checkpoint()
                try:
                    pages = _get_json(session, f"/ajax/illust/{wid}/pages")
                    _nap(delay)
                except PixivError as e:
                    _STATE["failed"] += 1
                    last_err = f"work {wid}: {e}"
                    print(f"[Nougan Pixiv] {last_err}")
                    _set(done=n)
                    continue

                for pg in (pages if isinstance(pages, list) else []):
                    _checkpoint()
                    furl = ((pg or {}).get("urls") or {}).get("original") or ""
                    if not furl or "ugoira" in furl.lower():
                        continue   # animated works are zip frame sets, not images
                    name = os.path.basename(urlparse(furl).path)
                    stem, ext = os.path.splitext(name)
                    if ext.lower() not in IMAGE_EXTS:
                        continue
                    if skip_existing and not overwrite and stem in existing:
                        _STATE["skipped"] += 1
                        continue
                    dest = os.path.join(out_dir, name)
                    part = dest + ".part"
                    try:
                        with session.get(furl, stream=True, timeout=(10, 60)) as r:
                            _LIVE["resp"] = r
                            r.raise_for_status()
                            with open(part, "wb") as f:
                                for chunk in r.iter_content(1 << 16):
                                    _checkpoint()
                                    f.write(chunk)
                        os.replace(part, dest)
                        # overwrite: drop an older copy of this page under another extension
                        for old in existing.get(stem, []):
                            if old != name:
                                _rm(os.path.join(out_dir, old))
                        existing[stem] = [name]
                        downloaded.append(name)
                        _set(images=len(downloaded), current=name, files=downloaded[-200:])
                    except _Stopped:
                        _rm(part)
                        raise
                    except Exception as e:
                        if _STOP.is_set():          # Stop closed the connection under us
                            _rm(part)
                            raise _Stopped()
                        _STATE["failed"] += 1
                        last_err = f"{name}: {e}"
                        _rm(part)
                    finally:
                        _LIVE["resp"] = None
                    _nap(delay)
                _set(done=n)

            if not downloaded and not _STATE["skipped"]:
                raise RuntimeError(f"[Nougan Pixiv] nothing was downloaded"
                                   f"{': ' + last_err if last_err else ''} ({ctx}). "
                                   "R-18 and login-only works need your PHPSESSID cookie.")

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
                print(f"[Nougan Pixiv] post-processing error: {e}")

            _set(images=len(files), files=files[-200:], current="")
            print(f"[Nougan Pixiv] {len(files)} images from {len(ids)} works -> {out_dir} "
                  f"({_STATE['skipped']} skipped, {_STATE['failed']} failed)")
            return (out_dir, len(files))
        except _Stopped:
            # hard stop: keep what's already saved, skip convert / compress / rename
            _set(stopped=True, images=len(downloaded), files=downloaded[-200:], current="")
            print(f"[Nougan Pixiv] stopped by user - {len(downloaded)} images kept in {out_dir}")
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

    @routes.get("/nougan/pixiv/state")
    async def _state(request):
        if not _local(request):
            return web.Response(status=403)
        return web.json_response({k: v for k, v in _STATE.items()})

    @routes.get("/nougan/pixiv/resolve")
    async def _resolve(request):
        """Lets the node show exactly where files will go before you queue."""
        if not _local(request):
            return web.Response(status=403)
        rel, dest = _resolve_dest(request.query.get("folder", ""),
                                  _hint(_parse_target(request.query.get("url", ""))))
        return web.json_response({"rel": rel, "dest": dest})

    @routes.post("/nougan/pixiv/stop")
    async def _stop(request):
        """Hard stop for the current run (the node's Stop button)."""
        if not _local(request):
            return web.Response(status=403)
        return web.json_response({"stopped": _stop_now()})

    print("  [Nougan] Pixiv scraper routes registered (/nougan/pixiv/*)")


register_routes()


NODE_CLASS_MAPPINGS = {"NouganPixivScraper": NouganPixivScraper}
NODE_DISPLAY_NAME_MAPPINGS = {"NouganPixivScraper": "Nougan Pixiv Scraper 🎨"}
