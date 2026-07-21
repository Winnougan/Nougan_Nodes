# get_image.py
import os
import time
import torch
import numpy as np
from PIL import Image
import folder_paths


class NouganGetImage:
    """
    Grabs an IMAGE already in the workflow and outputs IMAGE + MASK,
    just like the native Load Image node — but without loading from disk.
    """

    def __init__(self):
        self.temp_dir = folder_paths.get_temp_directory()
        self.prefix   = "nougan_preview"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE", {"tooltip": "Image to grab from your workflow."}),
            },
            "optional": {
                "invert_mask": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "Invert the mask (swap black ↔ white).",
                }),
                "mask_threshold": ("FLOAT", {
                    "default": 0.0, "min": 0.0, "max": 1.0, "step": 0.01,
                    "tooltip": "Binarise mask above this value. 0 = smooth.",
                }),
                "mask_mode": (["Alpha Channel", "Luminance", "Blank"], {
                    "default": "Alpha Channel",
                    "tooltip": (
                        "Alpha Channel: from RGBA alpha (like Load Image).\n"
                        "Luminance: from pixel brightness.\n"
                        "Blank: all-black (keep everything)."
                    ),
                }),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("IMAGE", "MASK")
    FUNCTION = "get_image"
    CATEGORY = "image"
    TITLE = "Nougan Get Image"
    OUTPUT_NODE = True

    def get_image(self, image, invert_mask=False,
                  mask_threshold=0.0, mask_mode="Alpha Channel"):

        B, H, W, C = image.shape
        rgb = image[:, :, :, :3]

        # ── mask ──────────────────────────────────────────────────────
        if mask_mode == "Alpha Channel" and C >= 4:
            mask = 1.0 - image[:, :, :, 3]
        elif mask_mode == "Luminance":
            mask = 1.0 - (0.2126 * rgb[:, :, :, 0]
                        + 0.7152 * rgb[:, :, :, 1]
                        + 0.0722 * rgb[:, :, :, 2])
        else:
            mask = torch.zeros((B, H, W), dtype=image.dtype, device=image.device)

        if mask_threshold > 0.0:
            mask = (mask > mask_threshold).to(dtype=image.dtype)
        if invert_mask:
            mask = 1.0 - mask

        # ── save preview thumbnails ───────────────────────────────────
        ts = int(time.time() * 1000)
        ui_images = []

        img_np = (rgb[0].detach().cpu().numpy() * 255).clip(0, 255).astype(np.uint8)
        img_file = f"{self.prefix}_{ts}_img.png"
        Image.fromarray(img_np, "RGB").save(
            os.path.join(self.temp_dir, img_file), compress_level=1)
        ui_images.append({"filename": img_file, "subfolder": "",
                          "type": "temp", "kind": "image"})

        msk_np = (mask[0].detach().cpu().numpy() * 255).clip(0, 255).astype(np.uint8)
        msk_file = f"{self.prefix}_{ts}_mask.png"
        Image.fromarray(msk_np, "L").save(
            os.path.join(self.temp_dir, msk_file), compress_level=1)
        ui_images.append({"filename": msk_file, "subfolder": "",
                          "type": "temp", "kind": "mask"})

        # NOTE: key is "nougan_previews", NOT "images".
        # ComfyUI auto-renders a native preview for any output key named
        # "images" — using a custom name suppresses that duplicate.
        return {"ui": {"nougan_previews": ui_images}, "result": (rgb, mask)}