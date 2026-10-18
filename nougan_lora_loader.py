# nougan_lora_loader.py — Nougan Lora Loader: MODEL + CLIP in, MODEL + CLIP out.
# The stack itself lives in the hidden `lora_data` JSON, managed by the frontend.

import json
import os

import folder_paths
import comfy.utils
import comfy.sd


# (path, mtime) -> state dict. mtime in the key so an overwritten LoRA file reloads.
_SD_CACHE = {}
_MAX_CACHE = 8


def _load_sd(path):
    key = (path, os.path.getmtime(path))
    sd = _SD_CACHE.get(key)

    if sd is None:
        sd = comfy.utils.load_torch_file(path, safe_load=True)

        if len(_SD_CACHE) >= _MAX_CACHE:
            _SD_CACHE.pop(next(iter(_SD_CACHE)))

        _SD_CACHE[key] = sd

    # shallow copy: load_lora_for_models may mutate the dict it is handed
    return dict(sd)


def _num(v, default=1.0):
    try:
        v = float(v)
        return default if v != v else v  # NaN guard
    except Exception:
        return default


def _parse(lora_data):
    """lora_data JSON -> [{'on', 'name', 'model', 'clip'}, ...] (UI-only keys ignored)."""
    if isinstance(lora_data, str):
        try:
            lora_data = json.loads(lora_data or "{}")
        except Exception:
            return []

    raw = lora_data.get("loras", []) if isinstance(lora_data, dict) else lora_data

    if not isinstance(raw, list):
        return []

    out = []

    for e in raw:
        if not isinstance(e, dict):
            continue

        name = e.get("name") or e.get("lora") or ""

        if not name or name in ("None", "NONE"):
            continue

        if e.get("strength") is not None:  # legacy single-strength entries
            m = c = _num(e["strength"])
        else:
            m = _num(e.get("model"), 1.0)
            c = _num(e.get("clip"), m)

        out.append({"on": bool(e.get("on", True)), "name": name, "model": m, "clip": c})

    return out


def _apply(model, clip, lora_data):
    seen = set()

    for e in _parse(lora_data):
        if not e["on"]:
            continue

        m = max(-10.0, min(10.0, e["model"]))
        c = max(-10.0, min(10.0, e["clip"]))

        if m == 0 and (clip is None or c == 0):
            continue

        path = folder_paths.get_full_path("loras", e["name"])

        if path is None:
            print(f"[Nougan] lora not found, skipping: {e['name']}")
            continue

        if path in seen:
            print(f"[Nougan] duplicate lora skipped: {e['name']}")
            continue

        seen.add(path)
        print(f"[Nougan] applying {e['name']}  M={m} C={c}")

        model, clip = comfy.sd.load_lora_for_models(model, clip, _load_sd(path), m, c)

    return model, clip


class NouganLoraLoader:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL",),
                "lora_data": (
                    "STRING",
                    {"default": "{}", "multiline": False,
                     "tooltip": "Managed by the Nougan Lora Loader UI."},
                ),
            },
            "optional": {
                "clip": ("CLIP",),
            },
        }

    RETURN_TYPES = ("MODEL", "CLIP")
    RETURN_NAMES = ("MODEL", "CLIP")
    FUNCTION = "load"
    CATEGORY = "loaders"
    TITLE = "Nougan Lora Loader"
    DESCRIPTION = "Stack as many LoRAs as you want, each with its own strength."

    @classmethod
    def IS_CHANGED(cls, lora_data="{}", **kw):
        return str(lora_data)

    def load(self, model, lora_data, clip=None):
        return _apply(model, clip, lora_data)
