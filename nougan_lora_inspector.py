"""
Nougan Lora Inspector — standalone inspector node + direct HTTP endpoint.
Pick a LoRA and it looks itself up immediately (on-node button / auto on
selection), or queue the prompt to use the string outputs. Hashes the file,
reads its safetensors header, and pulls the matching Civitai record
(civitai.com with red.civitai.com fallback). Pairs with
web/nougan-lora_inspector.js. Stdlib + aiohttp (bundled with ComfyUI) only.
"""

import asyncio
import hashlib
import html
import json
import os
import re
import struct
import threading
import time
import urllib.error
import urllib.request

import folder_paths
from aiohttp import web
from server import PromptServer

SUITE_DIR = os.path.dirname(os.path.abspath(__file__))
CACHE_DIR = os.path.join(SUITE_DIR, "cache")
CACHE_FILE = os.path.join(CACHE_DIR, "lora_inspector_cache.json")
KEY_FILE = os.path.join(SUITE_DIR, "civitai_api_key.txt")

EVENT_NS = "nougan_lora_inspector"

SOURCES = {
    "civitai.com": "https://civitai.com/api/v1",
    "red.civitai.com": "https://red.civitai.com/api/v1",
}

# ------------------------------------------------------------------ cache

_lock = threading.Lock()
_cache = None


def _load_cache():
    global _cache
    if _cache is None:
        _cache = {}
        if os.path.isfile(CACHE_FILE):
            try:
                with open(CACHE_FILE, "r", encoding="utf-8") as f:
                    _cache = json.load(f)
            except Exception:
                _cache = {}
    return _cache


def _save_cache():
    try:
        os.makedirs(CACHE_DIR, exist_ok=True)
        with open(CACHE_FILE, "w", encoding="utf-8") as f:
            json.dump(_cache, f)
    except Exception:
        pass


def cache_get(key):
    with _lock:
        return _load_cache().get(key)


def cache_set(key, value):
    with _lock:
        _load_cache()[key] = value
        _save_cache()


# ------------------------------------------------------------------ events

def emit(node_id, kind, **payload):
    """Push an event to the frontend over the ComfyUI websocket."""
    try:
        PromptServer.instance.send_sync(
            f"{EVENT_NS}/{kind}",
            {"node": str(node_id), **payload},
            PromptServer.instance.client_id,
        )
    except Exception:
        pass


# ------------------------------------------------------------------ api key

def resolve_api_key(widget_key=""):
    """Priority: node widget > env var > civitai_api_key.txt (suite root)"""
    widget_key = (widget_key or "").strip()
    if widget_key:
        return widget_key
    for var in ("CIVITAI_API_TOKEN", "CIVITAI_API_KEY"):
        v = os.environ.get(var, "").strip()
        if v:
            return v
    if os.path.isfile(KEY_FILE):
        try:
            with open(KEY_FILE, "r", encoding="utf-8") as f:
                t = f.read().strip()
            if t:
                return t
        except Exception:
            pass
    return None


# ------------------------------------------------------------------ http

def http_json(url, api_key=None, timeout=25):
    headers = {"User-Agent": "Nougan-LoraInspector/1.0", "Accept": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8", errors="replace"))


# ------------------------------------------------------------------ hashing

def sha256_of(path, node_id):
    total = max(os.path.getsize(path), 1)
    digest = hashlib.sha256()
    read = 0
    last_sent = -1.0
    with open(path, "rb", buffering=0) as f:
        while True:
            block = f.read(8 * 1024 * 1024)  # 8 MB chunks
            if not block:
                break
            digest.update(block)
            read += len(block)
            frac = read / total
            if frac - last_sent >= 0.01 or read == total:  # throttle to ~1%/emit
                last_sent = frac
                emit(node_id, "progress", stage="hash", value=round(frac, 4),
                     message=f"SHA-256  {read / 1048576:.0f} / {total / 1048576:.0f} MB")
    return digest.hexdigest()


def file_sha256_cached(path, node_id, force=False):
    st = os.stat(path)
    key = f"sha::{path}::{int(st.st_mtime)}::{st.st_size}"
    if not force:
        hit = cache_get(key)
        if hit:
            emit(node_id, "progress", stage="hash", value=1.0,
                 message="SHA-256 from cache")
            return hit
    sha = sha256_of(path, node_id)
    cache_set(key, sha)
    return sha


# ------------------------------------------------------- local safetensors

def read_local_metadata(path):
    """Read the __metadata__ block (Kohya ss_* / modelspec tags) from the header."""
    try:
        if path.lower().endswith(".safetensors"):
            with open(path, "rb") as f:
                (n,) = struct.unpack("<Q", f.read(8))
                header = json.loads(f.read(min(n, 20 * 1024 * 1024)))
            return header.get("__metadata__", {}) or {}
    except Exception as e:
        return {"_error": f"could not read header: {e}"}
    return {}


# ------------------------------------------------------------------ civitai

def fetch_civitai(sha, source_pref, api_key, node_id):
    if source_pref == "auto":
        order = ["civitai.com", "red.civitai.com"]
    else:
        order = [source_pref] + [s for s in ("civitai.com", "red.civitai.com")
                                 if s != source_pref]
    errors, not_found = [], []
    for i, name in enumerate(order):
        url = f"{SOURCES[name]}/model-versions/by-hash/{sha}"
        emit(node_id, "progress", stage="fetch", value=0.0,
             message=f"Querying {name} …")
        try:
            data = http_json(url, api_key)
            emit(node_id, "progress", stage="fetch", value=1.0,
                 message=f"Found on {name}")
            return name, data
        except urllib.error.HTTPError as e:
            if e.code == 404:
                not_found.append(name)
            elif e.code in (401, 403):
                errors.append(f"{name}: auth rejected ({e.code}) — check API key")
            else:
                errors.append(f"{name}: HTTP {e.code}")
        except Exception as e:
            errors.append(f"{name}: {e}")
        emit(node_id, "progress", stage="fetch", value=(i + 1) / len(order),
             message=f"{name} failed, trying next …")

    if not_found and not errors:
        return not_found[-1], None  # definitively not on Civitai
    raise RuntimeError("Civitai lookup failed — " + " | ".join(errors + not_found))


TAG_RE = re.compile(r"<[^>]+>")


def strip_html(s):
    if not s:
        return ""
    s = html.unescape(TAG_RE.sub(" ", s))
    return re.sub(r"\s+", " ", s).strip()


def build_payload(sha, source, civ, local_meta, lora_name):
    payload = {
        "found": civ is not None,
        "source": source,
        "lora_file": lora_name,
        "sha256": sha,
        "model_name": None, "version_name": None, "model_type": None,
        "base_model": None, "trigger_words": [], "description": "",
        "url": None, "image": None, "images": [],
        "downloads": None, "rating": None,
        "nsfw": False, "file_size_kb": None, "format": None,
        "local": {},
    }

    pick = lambda *keys: next((str(local_meta[k]) for k in keys if local_meta.get(k)), None)
    payload["local"] = {
        "base_model_version": pick("ss_base_model_version"),
        "sd_model_name": pick("ss_sd_model_name"),
        "network_module": pick("ss_network_module"),
        "resolution": pick("ss_resolution"),
        "clip_skip": pick("ss_clip_skip"),
        "steps": pick("ss_steps"),
        "modelspec_title": pick("modelspec.title", "ss_output_name"),
    }

    if civ:
        model = civ.get("model") or {}
        stats = civ.get("stats") or {}
        files = civ.get("files") or [{}]
        primary = next((f for f in files if f.get("primary")), files[0])

        # Every sample image + its generation metadata (prompt, seed, …)
        imgs = [i for i in (civ.get("images") or [])
                if i.get("type") == "image" and i.get("url")]

        payload.update(
            model_name=model.get("name"),
            version_name=civ.get("name"),
            model_type=model.get("type"),
            base_model=civ.get("baseModel"),
            trigger_words=list(civ.get("trainedWords") or []),
            description=strip_html(civ.get("description"))[:600],
            url=(f"https://civitai.com/models/{model.get('id')}?modelVersionId={civ.get('id')}"
                 if model.get("id") else None),
            image=(imgs[0] if imgs else {}).get("url"),
            images=[{
                "url": i.get("url"),
                "width": i.get("width"),
                "height": i.get("height"),
                "nsfw": i.get("nsfw") or "None",
                "meta": i.get("meta") or {},
            } for i in imgs],
            downloads=stats.get("downloadCount"),
            rating=stats.get("rating"),
            nsfw=bool(model.get("nsfw")),
            file_size_kb=primary.get("sizeKB"),
            format=(primary.get("metadata") or {}).get("format"),
        )
    return payload


# ------------------------------------------------------------- shared core

def run_inspection(lora_name, source="auto", api_key="", force=False, node_id="0"):
    """Hash → Civitai lookup → payload. Used by the node AND the HTTP endpoint."""
    path = folder_paths.get_full_path("loras", lora_name)
    if not path or not os.path.isfile(path):
        raise FileNotFoundError(f"LoRA not found in models/loras: {lora_name}")

    emit(node_id, "progress", stage="start", value=0.0,
         message=f"Inspecting {lora_name} …")

    local_meta = read_local_metadata(path)
    sha = file_sha256_cached(path, node_id, force=force)
    key = resolve_api_key(api_key)

    cache_key = f"civitai::{sha}"
    civ = source_name = None
    warning = None
    cached = None if force else cache_get(cache_key)
    if cached:
        source_name, civ = cached.get("source"), cached.get("data")
        emit(node_id, "progress", stage="fetch", value=1.0,
             message=f"Civitai record from cache ({source_name})")
    else:
        try:
            source_name, civ = fetch_civitai(sha, source, key, node_id)
            cache_set(cache_key, {"source": source_name, "data": civ})
        except Exception as e:
            warning = str(e)                     # fall back to local metadata
            source_name, civ = "local only", None

    payload = build_payload(sha, source_name or "local only", civ, local_meta, lora_name)
    if warning:
        payload["warning"] = warning
    return payload


# ------------------------------------------------------------------ node

class NouganLoraInspector:
    """
    Standalone inspector — no model/clip plumbing. Pick a LoRA and it looks
    itself up (button / auto on selection), or queue the prompt to use the
    string outputs. Shows thumbnail strip, base model, trigger words, stats.
    Click a sample image to copy its positive prompt.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "lora_name": (folder_paths.get_filename_list("loras"),),
            },
            "optional": {
                "source": (["auto", "civitai.com", "red.civitai.com"], {"default": "auto"}),
                "refresh": (["use cache", "force refresh"], {"default": "use cache",
                            "tooltip": "force refresh bypasses all caches and re-hashes / re-fetches."}),
                "api_key": ("STRING", {"default": "",
                                       "tooltip": "Optional Civitai bearer token. Falls back to CIVITAI_API_TOKEN env var or civitai_api_key.txt in the suite folder."}),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = ("STRING", "STRING", "STRING", "STRING")
    RETURN_NAMES = ("model_name", "base_model", "trigger_words", "metadata_json")
    FUNCTION = "inspect"
    OUTPUT_NODE = True
    CATEGORY = "nougan"
    DESCRIPTION = ("Pick a LoRA and it looks itself up on Civitai (civitai.com / "
                   "red.civitai.com): thumbnail strip, base model, trigger words and "
                   "stats right on the node. Click a sample image to copy its prompt.")

    @classmethod
    def IS_CHANGED(cls, lora_name, source="auto", refresh="use cache",
                   api_key="", unique_id=None):
        # "force refresh" returns a new value every run → node always re-executes.
        if refresh == "force refresh":
            return time.time()
        return f"{lora_name}|{source}|{api_key}"

    def inspect(self, lora_name, source="auto", refresh="use cache",
                api_key="", unique_id=None):
        node_id = unique_id or "0"
        try:
            payload = run_inspection(lora_name, source, api_key,
                                     refresh == "force refresh", node_id)
        except Exception as e:
            emit(node_id, "error", message=str(e))
            raise

        emit(node_id, "metadata", payload=payload)
        emit(node_id, "progress", stage="done", value=1.0, message="Done")

        base_model = payload["base_model"] or payload["local"].get("base_model_version") or ""
        triggers = ", ".join(payload["trigger_words"])
        name = payload["model_name"] or payload["local"].get("modelspec_title") or lora_name

        return (name, base_model, triggers, json.dumps(payload, ensure_ascii=False))


# --------------------------------------------------------- direct HTTP endpoint
# Self-registered on import (same pattern as the Mask Editor), so the on-node
# inspect button / auto-run can trigger a lookup without queueing a prompt.

try:
    @PromptServer.instance.routes.get("/nougan/lora_inspector/inspect")
    async def _nougan_lora_inspector_inspect(request):
        q = request.rel_url.query
        lora = q.get("lora", "")
        if not lora:
            return web.json_response({"error": "missing 'lora' parameter"}, status=400)
        node_id = q.get("node", "0")
        try:
            payload = await asyncio.get_running_loop().run_in_executor(
                None,
                lambda: run_inspection(
                    lora,
                    q.get("source", "auto"),
                    q.get("api_key", ""),
                    q.get("force", "0") == "1",
                    node_id,
                ),
            )
        except Exception as e:
            emit(node_id, "error", message=str(e))
            return web.json_response({"error": str(e)}, status=500)
        emit(node_id, "metadata", payload=payload)
        emit(node_id, "progress", stage="done", value=1.0, message="Done")
        return web.json_response(payload)
except Exception:
    print("[Nougan] ⚠️  Lora Inspector route not registered (server not available?).")