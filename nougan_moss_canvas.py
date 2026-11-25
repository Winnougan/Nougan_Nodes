"""NouganMossCanvas — canvas size math + empty MOSS-Image latent.

Ported from the "Moss Image Pro v2.8.0" standalone UI (canvas section).
Logic-only port; visual dressing lives in web/nougan_moss_canvas.js.

Canvas rules reproduced from the UI:
  Aspect Ratio mode:  w = sqrt(MP * 1e6 * a/b), h = sqrt(MP * 1e6 * b/a),
                      then BOTH snapped to the NEAREST multiple of 8.
                      Verified against the UI: 2:3 @ 1.5 MP shows 1000x1504
                      (sqrt(1e6) = 1000 stays 1000; sqrt(2.25e6) = 1500 -> 1504).
  Custom Dimensions:  user width/height, snapped to nearest multiple of 8.

Latent: MOSS-Image uses the FLUX.2 latent format -> 128 latent channels,
16 px spatial downscale (comfy/supported_models.py: class MOSSImage).
TODO(verify): a width like 1000 is NOT divisible by 16 (latent grid is
8x coarser than the 8 px snap). ComfyUI's VAE pads internally, so 1000x1504
is legal, but confirm the actual workflow JSON uses these exact sizes.
"""

import math
import re

import torch

import comfy.model_management

# Aspect preset labels. Stable-combo lesson: once shipped, never rename/remove
# an entry (saved workflows store the label string). Only append.
# TODO(verify): exact preset list + labels from the Moss Image Pro UI source.
ASPECT_PRESETS = [
    "1:1 (Square)",
    "4:3 (Classic Photo)",
    "3:2 (Landscape Photo)",
    "2:3 (Portrait Photo)",
    "3:4 (Portrait)",
    "16:9 (Widescreen)",
    "9:16 (Vertical)",
    "21:9 (Ultrawide)",
]

_MODES = ["Aspect Ratio", "Custom Dimensions"]

MIN_SIDE = 64
MAX_SIDE = 8192
MIN_MP = 0.1
MAX_MP = 24.0

_LATENT_CHANNELS = 128        # MOSS-Image / FLUX.2 latent format
_LATENT_DOWNSCALE = 16        # 16 px per latent cell

_ASPECT_RE = re.compile(r"^\s*(\d+)\s*:\s*(\d+)")


def snap8(v):
    """Nearest multiple of 8, clamped to [MIN_SIDE, MAX_SIDE]."""
    v = int(math.floor(v / 8.0 + 0.5)) * 8
    return max(MIN_SIDE, min(MAX_SIDE, v))


def parse_aspect(label):
    m = _ASPECT_RE.match(label or "")
    if not m:
        raise ValueError(f"bad aspect preset: {label!r}")
    a, b = int(m.group(1)), int(m.group(2))
    if a <= 0 or b <= 0:
        raise ValueError(f"bad aspect ratio in {label!r}")
    return a, b


def compute_size(mode, aspect, scale_mp, width, height):
    """Return (w, h) applying the UI's canvas rules. Pure — reused by tests."""
    if mode == "Aspect Ratio":
        a, b = parse_aspect(aspect)
        total = scale_mp * 1_000_000.0
        w = math.sqrt(total * a / b)
        h = math.sqrt(total * b / a)
        return snap8(w), snap8(h)
    if mode == "Custom Dimensions":
        return snap8(width), snap8(height)
    raise ValueError(f"unknown mode: {mode!r}")


class NouganMossCanvas:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "mode": (_MODES, {"default": "Aspect Ratio"}),
                "aspect": (ASPECT_PRESETS, {"default": "2:3 (Portrait Photo)"}),
                "scale_mp": ("FLOAT", {"default": 1.5, "min": MIN_MP, "max": MAX_MP, "step": 0.1,
                                       "tooltip": "Target megapixels. The UI rounds each side to the nearest "
                                                  "multiple of 8, so the final size can differ slightly."}),
                "width": ("INT", {"default": 1000, "min": MIN_SIDE, "max": MAX_SIDE, "step": 8,
                                  "tooltip": "Custom Dimensions mode only; snapped to a multiple of 8."}),
                "height": ("INT", {"default": 1504, "min": MIN_SIDE, "max": MAX_SIDE, "step": 8,
                                   "tooltip": "Custom Dimensions mode only; snapped to a multiple of 8."}),
                "batch_size": ("INT", {"default": 1, "min": 1, "max": 64}),
            },
        }

    RETURN_TYPES = ("INT", "INT", "LATENT")
    RETURN_NAMES = ("width", "height", "LATENT")
    FUNCTION = "run"
    CATEGORY = "Nougan/Moss"
    DESCRIPTION = ("MOSS-Image canvas: aspect-ratio / megapixel math or custom "
                   "dimensions (snapped to multiples of 8), plus the empty "
                   "128-channel latent.")

    @classmethod
    def VALIDATE_INPUTS(cls, mode, aspect, scale_mp, width, height, batch_size):
        if mode not in _MODES:
            return f"unknown mode {mode!r}"
        if mode == "Aspect Ratio":
            if aspect not in ASPECT_PRESETS:
                return f"unknown aspect preset {aspect!r}"
            try:
                parse_aspect(aspect)
            except ValueError as e:
                return str(e)
            if not (MIN_MP <= scale_mp <= MAX_MP):
                return f"scale_mp {scale_mp} out of range [{MIN_MP}, {MAX_MP}]"
        else:
            for name, v in (("width", width), ("height", height)):
                if not (MIN_SIDE <= v <= MAX_SIDE):
                    return f"{name} {v} out of range [{MIN_SIDE}, {MAX_SIDE}]"
        if not (1 <= batch_size <= 64):
            return f"batch_size {batch_size} out of range [1, 64]"
        return True

    def run(self, mode, aspect, scale_mp, width, height, batch_size):
        w, h = compute_size(mode, aspect, scale_mp, width, height)
        device = comfy.model_management.intermediate_device()
        latent = torch.zeros(
            [batch_size, _LATENT_CHANNELS, h // _LATENT_DOWNSCALE, w // _LATENT_DOWNSCALE],
            device=device,
        )
        return (w, h, {"samples": latent})


NODE_CLASS_MAPPINGS = {"NouganMossCanvas": NouganMossCanvas}
NODE_DISPLAY_NAME_MAPPINGS = {"NouganMossCanvas": "Nougan Moss Canvas 📐"}
