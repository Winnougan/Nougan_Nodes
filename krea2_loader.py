# krea2_loader.py
import os
import comfy.sd
import comfy.utils


# ===========================================================================
#  BAKED-IN LORA CONFIG  —  edit this list to match your files.
#  Drop the .safetensors files into  nougan/loras/  and set "filename"
#  to the exact name. The node reads them from its OWN folder, so they
#  ship with the pack (no need to copy anything into models/loras/).
# ===========================================================================
KREA2_LORAS = [
    {
        "key": "a",
        "display_name": "Uncensor A",          # shown in the node UI
        "filename": "krea2_uncensor_a.safetensors",  # file in nougan/loras/
        "default_enable": False,               # start OFF (opt-in preload)
        "default_strength": 1.0,
    },
    {
        "key": "b",
        "display_name": "Uncensor B",
        "filename": "krea2_uncensor_b.safetensors",
        "default_enable": False,
        "default_strength": 1.0,
    },
    {
        "key": "c",
        "display_name": "Uncensor C",
        "filename": "krea2_uncensor_c.safetensors",
        "default_enable": False,
        "default_strength": 1.0,
    },
]

# ---------------------------------------------------------------------------
NODE_DIR  = os.path.dirname(os.path.abspath(__file__))
LORAS_DIR = os.path.join(NODE_DIR, "loras")

_SD_CACHE: dict = {}


def _baked_lora_path(filename: str):
    """Resolve a bundled lora inside nougan/loras/. basename() guards traversal."""
    if not filename:
        return None
    return os.path.join(LORAS_DIR, os.path.basename(str(filename)))


def _load_lora_sd(path: str):
    """Cached state dict. Returns a SHALLOW COPY — comfy.lora may mutate the
    dict it's handed, so the cached original must stay pristine for re-runs."""
    sd = _SD_CACHE.get(path)
    if sd is None:
        sd = comfy.utils.load_torch_file(path, safe_load=True)
        _SD_CACHE[path] = sd
    return dict(sd)


def _human_size(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} TB"


def get_krea2_lora_status():
    """For the frontend: present/size of every baked lora, by widget index."""
    out = []
    for i, spec in enumerate(KREA2_LORAS, start=1):
        p = _baked_lora_path(spec["filename"])
        present = bool(p and os.path.isfile(p))
        size = os.path.getsize(p) if present else 0
        out.append({
            "index": i,
            "key": spec["key"],
            "display_name": spec["display_name"],
            "filename": spec["filename"],
            "present": present,
            "size": size,
            "size_str": _human_size(size) if present else "—",
        })
    return out


def _build_input_types():
    opt = {"clip": ("CLIP",)}
    for i, spec in enumerate(KREA2_LORAS, start=1):
        dn = spec["display_name"]
        opt[f"enable_{i}"] = ("BOOLEAN", {
            "default": bool(spec.get("default_enable", False)),
            "label_on": f"{dn}: ON", "label_off": f"{dn}: OFF",
            "tooltip": f"Preload {dn} into the model.",
        })
        opt[f"strength_{i}"] = ("FLOAT", {
            "default": float(spec.get("default_strength", 1.0)),
            "min": 0.0, "step": 0.05, "max": 1000.0,   # effectively uncapped
            "tooltip": f"Strength for {dn}. 0 = off. No practical upper limit.",
        })
    return {"required": {"model": ("MODEL",)}, "optional": opt}


# ---------------------------------------------------------------------------
class NouganKrea2Loader:
    """Applies 1–3 bundled 'uncensored' LoRAs to MODEL (+ optional CLIP) and
    passes them straight through, so it slots between your model loader and
    your regular LoRA loader."""

    @classmethod
    def INPUT_TYPES(cls):
        return _build_input_types()

    RETURN_TYPES = ("MODEL", "CLIP", "STRING")
    RETURN_NAMES = ("MODEL", "CLIP", "applied")
    FUNCTION = "load"
    CATEGORY = "loaders"
    TITLE = "Nougan Krea 2 · Uncensored"
    DESCRIPTION = ("Bakes in bundled uncensored LoRAs (stored in nougan/loras/). "
                   "Toggle 1, 2 or all 3 and set each strength. Sits after the "
                   "model and before your LoRA loader.")

    @classmethod
    def IS_CHANGED(cls, **kw):
        parts = [f"{kw.get(f'enable_{i}')}:{kw.get(f'strength_{i}')}"
                 for i in range(1, len(KREA2_LORAS) + 1)]
        return "|".join(parts)

    def load(self, model, clip=None, **kw):
        applied = []
        for i, spec in enumerate(KREA2_LORAS, start=1):
            en = bool(kw.get(f"enable_{i}", spec.get("default_enable", False)))
            try:
                s = float(kw.get(f"strength_{i}", spec.get("default_strength", 1.0)))
            except (TypeError, ValueError):
                s = 1.0
            s = max(-1000.0, min(1000.0, s))   # NaN/inf guard only

            if not en or s == 0.0:
                continue

            path = _baked_lora_path(spec["filename"])
            if not path or not os.path.isfile(path):
                print(f"[Nougan Krea2] ⚠️ '{spec['display_name']}' is ON but the "
                      f"file is missing (nougan/loras/{spec['filename']}) — skipped.")
                continue

            sd = _load_lora_sd(path)
            model, clip = comfy.sd.load_lora_for_models(model, clip, sd, s, s)
            applied.append(f"{spec['display_name']}@{s:g}")
            print(f"[Nougan Krea2] ✅ {spec['display_name']}  strength={s:g}")

        summary = ", ".join(applied) if applied else "(none)"
        print(f"[Nougan Krea2] baked loras applied: {summary}")
        return (model, clip, summary)