"""
Nougan Workflow PNG Baker
-------------------------
Embeds a ComfyUI workflow into any image (JPEG, WebP, PNG, ...) and saves it as
a PNG that ComfyUI opens as that workflow when you drag it onto the canvas.

How ComfyUI does it (and so do we):
    PNG tEXt chunk, keyword "workflow"  = JSON of the graph (frontend format)
    PNG tEXt chunk, keyword "prompt"    = JSON of the API-format graph (optional)

Wire it like this:
    Load Image (jpeg/webp/png) ──► image
    String (Multiline) ──► json_text      (paste the workflow JSON in that node)

Accepted json_text:
    * a workflow save file         {"nodes": [...], "links": [...], ...}
    * an API-format export         {"3": {"class_type": ..., "inputs": {...}}, ...}
    * both, as shown by PNG info   {"workflow": {...}, "prompt": {...}}
"""
import json
import os

from PIL import Image
from PIL.PngImagePlugin import PngInfo

import folder_paths

from .nougan_v2_png_baker import _strip_wrappers, _tensor_to_pil, _safe_name


# ─────────────────────────────────────────────────────────── JSON handling ──

def _load(text: str):
    cleaned = _strip_wrappers(text or "")
    if not cleaned:
        raise ValueError("[Workflow PNG Baker] json_text is empty. Paste your workflow JSON into the string node.")
    try:
        obj = json.loads(cleaned)
    except json.JSONDecodeError as e:
        raise ValueError(
            f"[Workflow PNG Baker] Invalid JSON: {e.msg} (line {e.lineno}, column {e.colno})."
        ) from None
    for _ in range(3):  # tolerate a workflow that was JSON-encoded twice
        if not isinstance(obj, str):
            break
        try:
            obj = json.loads(_strip_wrappers(obj))
        except json.JSONDecodeError:
            break
    return obj


def _as_dict(v):
    if isinstance(v, str):
        try:
            v = json.loads(v)
        except json.JSONDecodeError:
            return None
    return v if isinstance(v, dict) else None


def _is_workflow(d: dict) -> bool:
    return isinstance(d.get("nodes"), list) and "links" in d


def _is_api(d: dict) -> bool:
    return bool(d) and all(isinstance(v, dict) and "class_type" in v for v in d.values())


def split_payload(obj):
    """Return (workflow, prompt); either may be None, never both."""
    if not isinstance(obj, dict):
        raise ValueError("[Workflow PNG Baker] The JSON must be an object ({...}), not a list or a bare value.")
    wf = pr = None
    if _is_workflow(obj):
        wf = obj
    elif _is_api(obj):
        pr = obj
    else:
        w, p = _as_dict(obj.get("workflow")), _as_dict(obj.get("prompt"))
        wf = w if w and _is_workflow(w) else None
        pr = p if p and _is_api(p) else None
    if wf is None and pr is None:
        got = sorted(map(str, obj.keys()))[:12]
        raise ValueError(
            "[Workflow PNG Baker] This doesn't look like a ComfyUI workflow: expected 'nodes' + 'links' "
            "(workflow save file) or nodes with 'class_type' (API export). "
            f"Top-level keys received: {got}"
        )
    return wf, pr


# ─────────────────────────────────────────────────────────────── the node ──

class NouganWorkflowPNGBaker:
    CATEGORY = "image/cards"
    FUNCTION = "bake"
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("saved_path",)
    OUTPUT_NODE = True

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                # forceInput -> plain socket, fed by ComfyUI's native String (Multiline) node
                "json_text": ("STRING", {"forceInput": True, "multiline": True}),
                "filename_prefix": ("STRING", {
                    "default": "Workflow_PNG/workflow",
                    "tooltip": "Saved in the ComfyUI output folder. Drag the resulting PNG onto the canvas to open the workflow.",
                }),
            }
        }

    def bake(self, image, json_text, filename_prefix):
        wf, pr = split_payload(_load(json_text))

        # Same serialization as ComfyUI's own Save Image: plain json.dumps (ASCII-safe, so it
        # is valid in a Latin-1 tEXt chunk even when node titles contain emoji).
        meta = PngInfo()
        if wf is not None:
            meta.add_text("workflow", json.dumps(wf))
        if pr is not None:
            meta.add_text("prompt", json.dumps(pr))

        out_dir = folder_paths.get_output_directory()
        first = image[0]
        h, w = int(first.shape[0]), int(first.shape[1])
        full_folder, fname, counter, subfolder, _ = folder_paths.get_save_image_path(
            _safe_prefix(filename_prefix), out_dir, w, h
        )
        os.makedirs(full_folder, exist_ok=True)

        saved, previews = [], []
        for img in image:
            file = f"{fname}_{counter:05}_.png"
            path = os.path.join(full_folder, file)
            _tensor_to_pil(img).save(path, format="PNG", pnginfo=meta, compress_level=4)

            # read it back from disk: never report success on a file ComfyUI can't open
            with Image.open(path) as chk:
                info = dict(chk.info)
            if wf is not None and json.loads(info.get("workflow", "null")) != wf:
                raise RuntimeError(f"[Workflow PNG Baker] Verification failed for {path}: workflow did not round-trip.")
            if pr is not None and json.loads(info.get("prompt", "null")) != pr:
                raise RuntimeError(f"[Workflow PNG Baker] Verification failed for {path}: prompt did not round-trip.")

            kinds = "+".join(k for k, v in (("workflow", wf), ("prompt", pr)) if v is not None)
            print(f"[Workflow PNG Baker] ✅ Embedded {kinds} -> {path}")
            saved.append(path)
            previews.append({"filename": file, "subfolder": subfolder, "type": "output"})
            counter += 1

        return {"ui": {"images": previews}, "result": ("\n".join(saved),)}


def _safe_prefix(prefix: str) -> str:
    # keep subfolders, but sanitize each path part like the card baker does for names
    parts = [p for p in prefix.replace("\\", "/").split("/") if p not in ("", ".", "..")]
    return "/".join(_safe_name(p) for p in parts) or "workflow"


NODE_CLASS_MAPPINGS = {"NouganWorkflowPNGBaker": NouganWorkflowPNGBaker}
NODE_DISPLAY_NAME_MAPPINGS = {"NouganWorkflowPNGBaker": "Nougan Workflow PNG Baker 🧬"}
