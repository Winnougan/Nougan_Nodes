"""Nougan Resolution Picker.

Pick a size either from an aspect ratio + megapixels, or from a prebuilt
WIDTHxHEIGHT preset. Outputs width and height as INT, so it can replace
ComfyUI's ResolutionSelector without rewiring.

The ratio and preset lists are plain labels. Both this file and the browser
preview (web/nougan_resolution_picker.js) read the numbers out of the labels,
so you can add or remove entries here and nothing else needs to change.
"""

import math
import re

MODE_RATIO = "Ratio + Megapixels"
MODE_PRESET = "Preset Resolution"
MODES = [MODE_RATIO, MODE_PRESET]

# 1.0 MP means 1024 x 1024 pixels, the same convention as ComfyUI's ResolutionSelector.
PIXELS_PER_MP = 1024 * 1024

# Label format: "<w>:<h> (Name)". Decimals are fine, e.g. "2.39:1".
RATIOS = [
    "1:1 (Square)",
    "5:4 (Large Format)",
    "4:3 (Standard)",
    "3:2 (Photo)",
    "16:10 (Laptop)",
    "16:9 (Widescreen)",
    "1.85:1 (Cinema Flat)",
    "2:1 (Univisium)",
    "2.35:1 (Cinemascope)",
    "2.39:1 (Anamorphic)",
    "21:9 (Ultrawide)",
    "32:9 (Super Ultrawide)",
    "3:1 (Banner)",
    "4:5 (Portrait Social)",
    "3:4 (Portrait Standard)",
    "2:3 (Portrait Photo)",
    "9:16 (Vertical Video)",
    "9:21 (Tall Ultrawide)",
    "1:2 (Tall)",
    "1:3 (Tall Banner)",
    "Custom",
]

# Label format: "<width>x<height> (Name)".
PRESETS = [
    "512x512 (Square S)",
    "768x768 (Square M)",
    "1024x1024 (Square 1MP)",
    "1280x1280 (Square L)",
    "1536x1536 (Square XL)",
    "2048x2048 (Square 4MP)",
    "640x480 (4:3 SD)",
    "1024x768 (4:3 XGA)",
    "1280x960 (4:3 HD)",
    "1600x1200 (4:3 UXGA)",
    "1152x768 (3:2)",
    "1536x1024 (3:2)",
    "1920x1280 (3:2)",
    "640x360 (16:9 nHD)",
    "832x480 (16:9 480p)",
    "960x544 (16:9 540p)",
    "1024x576 (16:9)",
    "1280x720 (HD 720p)",
    "1536x864 (16:9)",
    "1920x1080 (Full HD 1080p)",
    "2560x1440 (QHD 1440p)",
    "3840x2160 (4K UHD)",
    "1792x768 (21:9)",
    "2560x1080 (21:9 UW-FHD)",
    "3440x1440 (21:9 UW-QHD)",
    "1152x896 (SDXL 9:7)",
    "1216x832 (SDXL 3:2)",
    "1344x768 (SDXL 16:9)",
    "1536x640 (SDXL 21:9)",
    "480x832 (9:16 Small)",
    "576x1024 (9:16)",
    "720x1280 (9:16 HD)",
    "864x1536 (9:16)",
    "1080x1920 (9:16 Full HD)",
    "768x1024 (3:4)",
    "1024x1536 (2:3)",
    "896x1152 (SDXL 7:9)",
    "832x1216 (SDXL 2:3)",
    "768x1344 (SDXL 9:16)",
    "640x1536 (SDXL 9:21)",
]

_RATIO_RE = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)")
_PRESET_RE = re.compile(r"^\s*(\d+)\s*x\s*(\d+)", re.IGNORECASE)


def _snap(value, multiple):
    """Round to the nearest multiple (halves round up), never below one multiple."""
    return max(multiple, int(math.floor(value / multiple + 0.5)) * multiple)


def _parse_ratio(label):
    match = _RATIO_RE.match(label or "")
    if not match:
        return 1.0, 1.0, "1:1"
    return float(match.group(1)), float(match.group(2)), f"{match.group(1)}:{match.group(2)}"


def _parse_preset(label):
    match = _PRESET_RE.match(label or "")
    if not match:
        return 1024, 1024
    return int(match.group(1)), int(match.group(2))


def _fmt(number):
    return f"{number:.2f}".rstrip("0").rstrip(".")


def _nearest_ratio_text(width, height):
    """Name the closest known ratio, or fall back to a decimal like 1.76:1."""
    actual = math.log(width / height)
    best, best_gap = None, 0.02
    for label in RATIOS:
        if label == "Custom":
            continue
        rw, rh, text = _parse_ratio(label)
        gap = abs(actual - math.log(rw / rh))
        if gap < best_gap:
            best, best_gap = text, gap
    return best or f"{math.floor(width / height * 100 + 0.5) / 100:.2f}:1"


def resolve(mode, aspect_ratio, megapixels, multiple, preset_resolution,
            custom_ratio_w, custom_ratio_h, swap_orientation, snap_presets):
    """Return (width, height, ratio_text). Pure function, no ComfyUI needed."""
    multiple = max(1, int(multiple))
    if mode == MODE_RATIO:
        if aspect_ratio == "Custom":
            rw = min(100.0, max(0.1, float(custom_ratio_w)))
            rh = min(100.0, max(0.1, float(custom_ratio_h)))
            ratio_text = f"{_fmt(rw)}:{_fmt(rh)}"
        else:
            rw, rh, ratio_text = _parse_ratio(aspect_ratio)
        pixels = min(16.0, max(0.05, float(megapixels))) * PIXELS_PER_MP
        scale = math.sqrt(pixels / (rw * rh))
        width, height = _snap(rw * scale, multiple), _snap(rh * scale, multiple)
    else:
        width, height = _parse_preset(preset_resolution)
        if snap_presets:
            width, height = _snap(width, multiple), _snap(height, multiple)
        ratio_text = _nearest_ratio_text(width, height)
    if swap_orientation:
        width, height = height, width
        ratio_text = ":".join(reversed(ratio_text.split(":")))
    return width, height, ratio_text


class NouganResolutionPicker:
    CATEGORY = "Nougan"
    FUNCTION = "pick"
    RETURN_TYPES = ("INT", "INT", "FLOAT", "STRING")
    RETURN_NAMES = ("width", "height", "megapixels", "info")
    DESCRIPTION = (
        "Pick a size from an aspect ratio and megapixels, or from a prebuilt resolution. "
        "Connect only the outputs you need."
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "mode": (MODES, {"default": MODE_RATIO}),
                "aspect_ratio": (RATIOS, {"default": "16:9 (Widescreen)"}),
                "custom_ratio_w": ("FLOAT", {"default": 16.0, "min": 0.1, "max": 100.0, "step": 0.01}),
                "custom_ratio_h": ("FLOAT", {"default": 9.0, "min": 0.1, "max": 100.0, "step": 0.01}),
                "megapixels": ("FLOAT", {"default": 1.0, "min": 0.05, "max": 16.0, "step": 0.05}),
                "preset_resolution": (PRESETS, {"default": "1280x720 (HD 720p)"}),
                "snap_presets": ("BOOLEAN", {"default": True, "label_on": "snap to multiple", "label_off": "exact preset"}),
                "multiple": ("INT", {"default": 32, "min": 1, "max": 256, "step": 1}),
                "swap_orientation": ("BOOLEAN", {"default": False, "label_on": "portrait/landscape swapped", "label_off": "as listed"}),
            }
        }

    def pick(self, mode, aspect_ratio, custom_ratio_w, custom_ratio_h, megapixels,
             preset_resolution, snap_presets, multiple, swap_orientation):
        width, height, ratio_text = resolve(
            mode, aspect_ratio, megapixels, multiple, preset_resolution,
            custom_ratio_w, custom_ratio_h, swap_orientation, snap_presets,
        )
        actual_mp = width * height / PIXELS_PER_MP
        info = f"{width}x{height} | {ratio_text} | {actual_mp:.2f} MP"
        return (width, height, round(actual_mp, 4), info)
