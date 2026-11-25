"""NouganMossCanvas — canvas size math + empty MOSS-Image latent.

Ported from the "Moss Image Pro v2.8.0" standalone UI (canvas section).
Logic-only port; visual dressing lives in web/nougan_moss_canvas.js.

Aspect Ratio mode:  w = sqrt(MP * 1e6 * a/b), h = sqrt(MP * 1e6 * b/a).
Custom Dimensions:  user width/height.
Both are snapped to the NEAREST multiple of 16 (ties round up).

Why 16 and not the UI's 8: MOSS-Image uses the FLUX.2 latent format (128 channels,
16 px per latent cell; comfy/supported_models.py: MOSSImage), and ComfyUI's own
EmptyFlux2LatentImage builds the latent as height // 16, width // 16 with step=16.
A size that is not a multiple of 16 is silently floored by the latent (1000 px ->
62 cells -> 992 px decoded), so the width/height outputs would lie to anything
downstream (layout boxes are placed in these pixels). Snapping here keeps the
outputs and the latent identical. Consequence: where the UI shows 1000x1504 this
node shows 1008x1504 (the UI's 1000 decodes to 992 in ComfyUI anyway).
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
_GRID = 16                    # px per latent cell; sizes are snapped to this

_ASPECT_RE = re.compile(r"^\s*(\d+)\s*:\s*(\d+)")


def snap_to_grid(v):
    """Nearest multiple of 16 (ties up), clamped to [MIN_SIDE, MAX_SIDE].

    web/nougan_moss_canvas.js uses the same rule (floor(v/16 + 0.5)); keep them equal.
    """
    v = int(math.floor(v / _GRID + 0.5)) * _GRID
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
        return snap_to_grid(w), snap_to_grid(h)
    if mode == "Custom Dimensions":
        return snap_to_grid(width), snap_to_grid(height)
    raise ValueError(f"unknown mode: {mode!r}")


class NouganMossCanvas:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "mode": (_MODES, {"default": "Aspect Ratio"}),
                "aspect": (ASPECT_PRESETS, {"default": "2:3 (Portrait Photo)"}),
                "scale_mp": ("FLOAT", {"default": 1.5, "min": MIN_MP, "max": MAX_MP, "step": 0.1,
                                       "tooltip": "Target megapixels. Each side is rounded to the nearest "
                                                  "multiple of 16 (the latent grid), so the final size can differ slightly."}),
                "width": ("INT", {"default": 1008, "min": MIN_SIDE, "max": MAX_SIDE, "step": _GRID,
                                  "tooltip": "Custom Dimensions mode only; snapped to a multiple of 16."}),
                "height": ("INT", {"default": 1504, "min": MIN_SIDE, "max": MAX_SIDE, "step": _GRID,
                                   "tooltip": "Custom Dimensions mode only; snapped to a multiple of 16."}),
                "batch_size": ("INT", {"default": 1, "min": 1, "max": 64}),
            },
        }

    RETURN_TYPES = ("INT", "INT", "LATENT")
    RETURN_NAMES = ("width", "height", "LATENT")
    FUNCTION = "run"
    CATEGORY = "Nougan/Moss"
    DESCRIPTION = ("MOSS-Image canvas: aspect-ratio / megapixel math or custom "
                   "dimensions (snapped to multiples of 16, the latent grid), plus the "
                   "empty 128-channel latent.")

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
            [batch_size, _LATENT_CHANNELS, h // _GRID, w // _GRID],
            device=device,
        )
        return (w, h, {"samples": latent})


NODE_CLASS_MAPPINGS = {"NouganMossCanvas": NouganMossCanvas}
NODE_DISPLAY_NAME_MAPPINGS = {"NouganMossCanvas": "Nougan Moss Canvas 📐"}
