# nougan_multi_load_image.py  —  Nougan Multi Load Image by Winnougan
#
# One node instead of a pile of Load Image nodes. Press "+" in the node (web/nougan_multi_load_image.js)
# to add another image slot; every slot gets its own IMAGE output.
#
# ComfyUI nodes have a fixed list of outputs, so this file declares MAX_SLOTS of them and the JS only
# shows as many as you have added. The chosen files are stored as a JSON list in one hidden widget
# (images_json), so the workflow saves and reloads like any other node.

import hashlib
import json

import numpy as np
import torch
from PIL import Image, ImageOps

import folder_paths

try:  # same safe Pillow wrappers LoadImage uses
    import node_helpers
    _pillow = node_helpers.pillow
except Exception:  # pragma: no cover - outside ComfyUI
    def _pillow(fn, arg):
        return fn(arg)

MAX_SLOTS = 16


def _names(raw):
    """images_json -> list of filenames (possibly empty strings), at most MAX_SLOTS."""
    try:
        data = json.loads(raw) if isinstance(raw, str) else raw
    except Exception:
        return []
    if not isinstance(data, list):
        return []
    return [str(x) if isinstance(x, str) else "" for x in data][:MAX_SLOTS]


def _load(name):
    path = folder_paths.get_annotated_filepath(name)
    img = _pillow(Image.open, path)
    img = _pillow(ImageOps.exif_transpose, img)
    if img.mode == "I":
        img = img.point(lambda i: i * (1 / 255))
    img = img.convert("RGB")
    arr = np.array(img).astype(np.float32) / 255.0
    return torch.from_numpy(arr)[None,]


class NouganMultiLoadImage:
    CATEGORY = "Nougan"
    FUNCTION = "load"
    RETURN_TYPES = ("IMAGE",) * MAX_SLOTS
    RETURN_NAMES = tuple(f"image_{i}" for i in range(1, MAX_SLOTS + 1))
    DESCRIPTION = "Load several images in one node. Press + to add a slot; each slot has its own IMAGE output."

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # Managed by the node's UI (hidden). JSON list of filenames, one per slot.
                "images_json": ("STRING", {"default": "[]", "multiline": False}),
            }
        }

    def load(self, images_json):
        names = _names(images_json)
        outputs = []
        for name in names:
            if name:
                outputs.append(_load(name))
            else:
                print("[Nougan] Multi Load Image: a slot has no image chosen, sending a black 64x64 placeholder.")
                outputs.append(torch.zeros((1, 64, 64, 3), dtype=torch.float32))
        # Slots beyond the ones you added are never shown or connected; fill them so the output count matches.
        while len(outputs) < MAX_SLOTS:
            outputs.append(torch.zeros((1, 64, 64, 3), dtype=torch.float32))
        return tuple(outputs)

    @classmethod
    def IS_CHANGED(cls, images_json):
        h = hashlib.sha256()
        for name in _names(images_json):
            h.update(name.encode("utf-8"))
            if name:
                try:
                    with open(folder_paths.get_annotated_filepath(name), "rb") as f:
                        h.update(f.read())
                except Exception:
                    pass
        return h.hexdigest()

    @classmethod
    def VALIDATE_INPUTS(cls, images_json):
        for name in _names(images_json):
            if name and not folder_paths.exists_annotated_filepath(name):
                return f"Invalid image file: {name}"
        return True


NODE_CLASS_MAPPINGS = {"NouganMultiLoadImage": NouganMultiLoadImage}
NODE_DISPLAY_NAME_MAPPINGS = {"NouganMultiLoadImage": "Nougan Multi Load Image 🖼️➕"}
