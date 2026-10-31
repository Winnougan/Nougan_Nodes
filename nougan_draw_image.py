# nougan_draw_image.py — Nougan Draw Image
#
# Behaves like Load Image: outputs IMAGE + MASK read from a PNG in ComfyUI's input folder.
# The drawing itself happens in the browser (web/nougan_draw_image.js), which uploads a flattened
# PNG to  input/nougan_draw/flat_<uid>.png  and writes that path into the hidden `image` widget.
import hashlib
import os

import numpy as np
import torch
from PIL import Image, ImageOps

import folder_paths


class NouganDrawImage:
    CATEGORY = "Nougan"
    FUNCTION = "load"
    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("image", "mask")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "width": ("INT", {"default": 1024, "min": 64, "max": 8192, "step": 8}),
                "height": ("INT", {"default": 1024, "min": 64, "max": 8192, "step": 8}),
                "background": (["white", "black", "transparent"], {"default": "white"}),
                # Both of these are driven by the JS editor and hidden in the UI.
                # `image` is a plain STRING (not a combo) so subfolder paths pass validation.
                "image": ("STRING", {"default": ""}),
                "drawing_state": ("STRING", {"default": ""}),
            }
        }

    @staticmethod
    def _resolve(image):
        """Return an absolute path inside the input dir, or None."""
        if not image:
            return None
        try:
            base = os.path.realpath(folder_paths.get_input_directory())
            full = os.path.realpath(os.path.join(base, image))
            if os.path.commonpath([base, full]) != base:
                return None
        except ValueError:
            return None
        return full if os.path.isfile(full) else None

    @classmethod
    def IS_CHANGED(cls, width, height, background, image, drawing_state):
        path = cls._resolve(image)
        if path is None:
            return f"blank-{width}x{height}-{background}"
        h = hashlib.sha256()
        with open(path, "rb") as f:
            h.update(f.read())
        h.update(background.encode())
        return h.hexdigest()

    def load(self, width, height, background, image, drawing_state):
        path = self._resolve(image)

        if path is None:  # nothing drawn / saved yet -> blank canvas
            fill = 0.0 if background == "black" else 1.0
            if background == "transparent":
                fill = 0.0
            img = torch.full((1, height, width, 3), fill, dtype=torch.float32)
            mask = torch.full((1, height, width), 1.0 if background == "transparent" else 0.0,
                              dtype=torch.float32)
            return (img, mask)

        with Image.open(path) as im:
            im = ImageOps.exif_transpose(im)
            arr = np.asarray(im.convert("RGBA"), dtype=np.float32) / 255.0

        rgb, alpha = arr[..., :3], arr[..., 3]
        if background == "transparent":
            rgb = rgb * alpha[..., None]  # composite over black for the IMAGE output

        # Same convention as the core Load Image node: MASK = 1 - alpha.
        return (torch.from_numpy(np.ascontiguousarray(rgb))[None],
                torch.from_numpy(np.ascontiguousarray(1.0 - alpha))[None])
