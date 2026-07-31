# krea2_loader.py
# ─────────────────────────────────────────────────────────────────────────────
# PYTHON ONLY. The frontend lives in web/nougan-krea2-loader.js (separate file).
# A stray "// ..." line here is a SyntaxError that kills the whole suite.
# Architecture mirrors nougan_lora_loader.py 1:1 — only the path layer differs:
# this loader reads the BUNDLED nougan/loras/ folder, not models/loras/.
# ─────────────────────────────────────────────────────────────────────────────
import os
import json
import glob
import comfy.sd
import comfy.utils

NODE_DIR  = os.path.dirname(os.path.abspath(__file__))
LORAS_DIR = os.path.join(NODE_DIR, "loras")
_LORA_SD_CACHE = {}


# ── path layer (bundled folder) ──────────────────────────────────────────────
def _scan_loras():
    """Every .safetensors in nougan/loras/, sorted case-insensitive."""
    if not os.path.isdir(LORAS_DIR):
        os.makedirs(LORAS_DIR, exist_ok=True)
        return []
    names = [os.path.basename(f) for f in glob.glob(os.path.join(LORAS_DIR, "*.safetensors"))]
    names.sort(key=str.lower)
    return names


def _resolve(name):
    """Map a stored name to its bundled file. basename() blocks traversal."""
    if not name:
        return None
    p = os.path.join(LORAS_DIR, os.path.basename(str(name)))
    return p if os.path.isfile(p) else None


def _load_lora_sd(path):
    # Shallow copy: comfy.sd.load_lora_for_models may mutate the dict it is
    # handed; returning the cached original would drain it on a second apply.
    sd = _LORA_SD_CACHE.get(path)
    if sd is None:
        sd = comfy.utils.load_torch_file(path, safe_load=True)
        _LORA_SD_CACHE[path] = sd
    return dict(sd)


def _human_size(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} TB"


def get_krea2_lora_status():
    """Frontend payload for /nougan/krea2_loras (the chooser list)."""
    out = []
    for i, name in enumerate(_scan_loras(), start=1):
        p = _resolve(name)
        present = bool(p)
        size = os.path.getsize(p) if present else 0
        out.append({
            "index": i,
            "filename": name,
            "present": present,
            "size": size,
            "size_str": _human_size(size) if present else "—",
        })
    return out


# ── shared parse / apply (copied from the proven Power Lora Loader) ──────────
def _parse(lora_data):
    if not lora_data:
        return []
    try:
        data = json.loads(lora_data)
    except Exception:
        return []
    if isinstance(data, list):
        raw = data
    elif isinstance(data, dict):
        raw = data.get("loras", [])
    else:
        return []
    if not isinstance(raw, list):
        return []
    out = []
    for e in raw:
        if not isinstance(e, dict):
            continue
        name = e.get("name") or e.get("lora") or ""
        if not name or name in ("None", "NONE"):
            continue
        if e.get("strength") is not None:
            ms = cs = float(e["strength"])
        else:
            ms = float(e.get("model", 1.0))
            cs = float(e.get("clip", ms))
        out.append({"on": bool(e.get("on", True)), "name": name, "model": ms, "clip": cs})
    return out


def _apply(model, clip, lora_data):
    entries = _parse(lora_data)
    seen, stack = set(), []
    for e in entries:
        if not e["on"]:
            continue
        name = e["name"]
        if not name or name in ("None", "NONE"):
            continue
        ms = max(-10.0, min(10.0, float(e["model"])))
        cs = max(-10.0, min(10.0, float(e["clip"])))
        if ms == 0 and (clip is None or cs == 0):
            continue
        path = _resolve(name)
        if path is None:
            print(f"[Nougan Krea2] lora not found, skipping: {name}")
            continue
        if path in seen:
            print(f"[Nougan Krea2] duplicate lora skipped: {name}")
            continue
        seen.add(path)
        print(f"[Nougan Krea2] applying {name}  M={ms} C={cs}")
        model, clip = comfy.sd.load_lora_for_models(model, clip, _load_lora_sd(path), ms, cs)
        stack.append((name, ms, cs))
    return model, clip, stack


# REQUIRED STRING widget — identical trick to the Power Lora Loader.
# The JS hides it visually but ComfyUI MUST create it, or the ➕/✕ buttons
# never appear. This was the root cause of every earlier breakage.
_LORA_DATA = ("STRING", {"default": "{}", "multiline": False,
                         "tooltip": "Managed by the Nougan Krea 2 LoRA UI."})


class NouganKrea2Loader:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"model": ("MODEL",), "lora_data": _LORA_DATA},
                "optional": {"clip": ("CLIP",)}}

    RETURN_TYPES = ("MODEL", "CLIP", "STRING")
    RETURN_NAMES = ("MODEL", "CLIP", "applied")
    FUNCTION = "load"
    CATEGORY = "loaders"
    TITLE = "Nougan Krea 2 · LoRA"

    @classmethod
    def IS_CHANGED(cls, lora_data="{}", **kw):
        return lora_data

    def load(self, model, lora_data, clip=None):
        m, c, stack = _apply(model, clip, lora_data)
        summary = ", ".join(f"{n}@{ms:g}" for n, ms, _cs in stack) if stack else "(none)"
        return (m, c, summary)


class NouganKrea2LoaderMulti:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"model": ("MODEL",), "lora_data": _LORA_DATA},
                "optional": {"clip": ("CLIP",), "model_2": ("MODEL",), "model_3": ("MODEL",),
                             "model_4": ("MODEL",), "model_5": ("MODEL",)}}

    RETURN_TYPES = ("MODEL", "CLIP", "STRING", "MODEL", "MODEL", "MODEL", "MODEL")
    RETURN_NAMES = ("MODEL", "CLIP", "applied", "MODEL 2", "MODEL 3", "MODEL 4", "MODEL 5")
    FUNCTION = "load"
    CATEGORY = "loaders"
    TITLE = "Nougan Krea 2 · LoRA (Multi-Model)"

    @classmethod
    def IS_CHANGED(cls, lora_data="{}", **kw):
        return lora_data

    def load(self, model, lora_data, clip=None,
             model_2=None, model_3=None, model_4=None, model_5=None):
        m, c, stack = _apply(model, clip, lora_data)
        summary = ", ".join(f"{n}@{ms:g}" for n, ms, _cs in stack) if stack else "(none)"
        extras = []
        for em in (model_2, model_3, model_4, model_5):
            extras.append(_apply(em, None, lora_data)[0] if em is not None else None)
        return (m, c, summary, *extras)