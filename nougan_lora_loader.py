# nougan_lora_loader.py  — clean from-scratch Nougan Lora Loader (loader + multi-model)
import json
import os
import folder_paths
import comfy.utils
import comfy.sd

_LORA_SD_CACHE = {}
_ROOT = "(root)"


def _load_lora_sd(path):
    # Shallow copy: comfy.sd.load_lora_for_models may mutate the dict it is
    # handed; returning the cached original would drain it on a second apply.
    sd = _LORA_SD_CACHE.get(path)
    if sd is None:
        sd = comfy.utils.load_torch_file(path, safe_load=True)
        _LORA_SD_CACHE[path] = sd
    return dict(sd)


def _all_lora_files():
    try:
        return [str(x).replace(os.sep, "/") for x in folder_paths.get_filename_list("loras")]
    except Exception as e:
        print(f"[Nougan] lora list failed: {e}")
        return []


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
        is_rand = bool(e.get("random"))
        if not is_rand and (not name or name in ("None", "NONE")):
            continue
        if e.get("strength") is not None:
            ms = cs = float(e["strength"])
        else:
            ms = float(e.get("model", 1.0))
            cs = float(e.get("clip", ms))
        item = {"on": bool(e.get("on", True)), "name": name, "model": ms, "clip": cs}
        if is_rand:
            item["random"] = True
            item["autoRoll"] = bool(e.get("autoRoll"))
            item["locked"] = bool(e.get("locked"))
            item["folders"] = e.get("folders") if isinstance(e.get("folders"), list) else None
        out.append(item)
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
        path = folder_paths.get_full_path("loras", name)
        if path is None:
            print(f"[Nougan] lora not found, skipping: {name}")
            continue
        if path in seen:
            print(f"[Nougan] duplicate lora skipped: {name}")
            continue
        seen.add(path)
        print(f"[Nougan] applying {name}  M={ms} C={cs}")
        model, clip = comfy.sd.load_lora_for_models(model, clip, _load_lora_sd(path), ms, cs)
        stack.append((name, ms, cs))
    return model, clip, stack


_LORA_DATA = ("STRING", {"default": "{}", "multiline": False,
                         "tooltip": "Managed by the Nougan Lora Loader UI."})


class NouganLoraLoader:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"model": ("MODEL",), "lora_data": _LORA_DATA},
                "optional": {"clip": ("CLIP",)}}

    RETURN_TYPES = ("MODEL", "CLIP", "LORA_STACK")
    RETURN_NAMES = ("MODEL", "CLIP", "lora_stack")
    FUNCTION = "load"
    CATEGORY = "loaders"
    TITLE = "Nougan Lora Loader"

    @classmethod
    def IS_CHANGED(cls, lora_data="{}", **kw):
        return lora_data  # frontend bakes auto-roll picks into this each queue

    def load(self, model, lora_data, clip=None):
        m, c, stack = _apply(model, clip, lora_data)
        return (m, c, stack)


class NouganLoraLoaderMulti:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"model": ("MODEL",), "lora_data": _LORA_DATA},
                "optional": {"clip": ("CLIP",), "model_2": ("MODEL",), "model_3": ("MODEL",),
                             "model_4": ("MODEL",), "model_5": ("MODEL",)}}

    RETURN_TYPES = ("MODEL", "CLIP", "LORA_STACK", "MODEL", "MODEL", "MODEL", "MODEL")
    RETURN_NAMES = ("MODEL", "CLIP", "lora_stack", "MODEL 2", "MODEL 3", "MODEL 4", "MODEL 5")
    FUNCTION = "load"
    CATEGORY = "loaders"
    TITLE = "Nougan Lora Loader (Multi-Model)"

    @classmethod
    def IS_CHANGED(cls, lora_data="{}", **kw):
        return lora_data

    def load(self, model, lora_data, clip=None,
             model_2=None, model_3=None, model_4=None, model_5=None):
        m, c, stack = _apply(model, clip, lora_data)
        extras = []
        for em in (model_2, model_3, model_4, model_5):
            extras.append(_apply(em, None, lora_data)[0] if em is not None else None)
        return (m, c, stack, *extras)