"""Nougan H3 Upscale Picker.

Sister node to the Nougan Resolution Picker. Wire the picker's width and height in, choose either an upscale
factor (1.5x, 2x, 2.5x ...) or a target megapixel count, and it outputs the width and height to give
MiniMax H3 Latent Upscale With Model.

Why a node for this: the H3 latent upscaler is conditioned on one number, the average of the width scale and the
height scale, and the latent grid is 16 px. So a good target keeps both axes at the SAME scale and lands on a multiple
of 16. This node searches for the size that does that as closely as possible (exact whenever the maths allows it) and
tells you what it got.

Scale range: the upscaler only upscales, 1.0x to 4.0x. Its model card lists 1.5x, 2x, 2.5x, 3x and 4x as the factors
it was explicitly trained on (2x the most); anything in between is interpolated.

The scale labels are plain text. Both this file and the browser preview (web/nougan_h3_upscale_picker.js) read the
number out of the label, so you can add or remove entries in SCALES and nothing else needs to change.
"""

import math
import re

MODE_SCALE = "Scale factor"
MODE_MP = "Target megapixels"
MODES = [MODE_SCALE, MODE_MP]

# 1.0 MP means 1024 x 1024 pixels, the same convention as the Nougan Resolution Picker.
PIXELS_PER_MP = 1024 * 1024

# Label format: "<number>x". "Custom" uses the custom_scale box.
SCALES = ["1.5x", "2x", "2.5x", "3x", "4x", "Custom"]
DEFAULT_SCALE = "2x"

MIN_SCALE = 1.0   # the upscaler never shrinks
MAX_SCALE = 4.0   # the largest factor it was trained on
LATENT_STEP = 16  # H3's VAE compresses 16x spatially, so sizes must be multiples of 16
AXIS_WEIGHT = 20  # how much a width/height scale mismatch costs versus missing the requested scale (keep in step with the JS)

_SCALE_RE = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*[x\u00d7]", re.IGNORECASE)


def _snap(value, multiple):
    """Round to the nearest multiple (halves round up), never below one multiple."""
    return max(multiple, int(math.floor(value / multiple + 0.5)) * multiple)


def _parse_scale(label):
    match = _SCALE_RE.match(label or "")
    return float(match.group(1)) if match else 2.0


def _grid(multiple):
    """The size grid: a multiple of 16, at least 16."""
    return max(LATENT_STEP, ((int(multiple) + LATENT_STEP - 1) // LATENT_STEP) * LATENT_STEP)


def _fit_scale(w, h, scale, multiple):
    """Best (width, height) on the grid for an upscale of w x h by `scale`.

    Cost = how unequal the two axis scales are (weighted) + how far the average scale is from the one asked for.
    Candidates never shrink an axis and never average above MAX_SCALE. Same search as fitScale in the JS."""
    candidates = [(_snap(w * scale, multiple), _snap(h * scale, multiple))]
    first = max(1, int(math.floor(w * scale * 0.8 / multiple)))
    last = int(math.ceil(w * scale * 1.2 / multiple)) + 1
    for k in range(first, last + 1):
        cw = k * multiple
        rows = int(math.floor(cw * h / w / multiple))
        for r in (rows, rows + 1):
            candidates.append((cw, max(1, r) * multiple))
    best, best_cost = None, 0.0
    for cw, ch in candidates:
        sw, sh = cw / w, ch / h
        if sw < 1 - 1e-9 or sh < 1 - 1e-9:
            continue
        eff = (sw + sh) / 2
        if eff > MAX_SCALE + 1e-9:
            continue
        cost = AXIS_WEIGHT * (abs(sw - sh) / eff) + abs(eff / scale - 1)
        if best is None or cost < best_cost or (cost == best_cost and cw < best[0]):
            best, best_cost = (cw, ch), cost
    if best is None:
        best = (int(math.ceil(w * scale / multiple)) * multiple, int(math.ceil(h * scale / multiple)) * multiple)
    return best


def resolve(width, height, mode, scale_label, custom_scale, target_megapixels, multiple):
    """Return a dict with the target size and how well it matches. Pure function, no ComfyUI needed."""
    w, h = max(1, int(width)), max(1, int(height))
    m = _grid(multiple)
    note = ""
    if mode == MODE_SCALE:
        scale = float(custom_scale) if scale_label == "Custom" else _parse_scale(scale_label)
    else:
        pixels = min(16.0, max(0.05, float(target_megapixels))) * PIXELS_PER_MP
        scale = math.sqrt(pixels / (w * h))
    if scale < MIN_SCALE:
        scale = MIN_SCALE
        if mode == MODE_MP:
            note = "no upscale (target <= source)"
    elif scale > MAX_SCALE:
        scale = MAX_SCALE
        note = "capped at 4x (max)"
    tw, th = _fit_scale(w, h, scale, m)
    sw, sh = tw / w, th / h
    eff = (sw + sh) / 2
    return {"w": w, "h": h, "tw": tw, "th": th, "sw": sw, "sh": sh, "scale": eff,
            "mismatch": abs(sw - sh) / eff, "note": note}


class NouganH3UpscalePicker:
    CATEGORY = "Nougan"
    FUNCTION = "pick"
    RETURN_TYPES = ("INT", "INT", "FLOAT", "STRING")
    RETURN_NAMES = ("width", "height", "scale", "info")
    DESCRIPTION = (
        "Wire the Nougan Resolution Picker's width and height in, pick an upscale factor or a target megapixel count, "
        "and connect width / height to MiniMax H3 Latent Upscale With Model. The size keeps both axes at the same "
        "scale on the 16 px latent grid, so the upscaler gets exactly the factor you chose."
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "width": ("INT", {"default": 640, "min": 1, "max": 16384, "step": 1,
                                  "tooltip": "Source width: connect the Resolution Picker's width."}),
                "height": ("INT", {"default": 352, "min": 1, "max": 16384, "step": 1,
                                   "tooltip": "Source height: connect the Resolution Picker's height."}),
                "mode": (MODES, {"default": MODE_SCALE,
                                 "tooltip": "Scale factor: you choose the factor. Target megapixels: you choose the "
                                            "size you want and the node works out the factor (e.g. 0.2 MP to 0.5 MP is about 1.58x)."}),
                "scale": (SCALES, {"default": DEFAULT_SCALE,
                                   "tooltip": "Upscale factor. The upscaler's model card lists 1.5x, 2x, 2.5x, 3x and 4x as "
                                              "explicitly trained, 2x the most; other values in 1.0-4.0 are interpolated."}),
                "custom_scale": ("FLOAT", {"default": 2.0, "min": MIN_SCALE, "max": MAX_SCALE, "step": 0.01,
                                           "tooltip": "Used when scale = Custom."}),
                "target_megapixels": ("FLOAT", {"default": 0.5, "min": 0.05, "max": 16.0, "step": 0.05,
                                                "tooltip": "Wanted size of the upscaled video (1.0 MP = 1024 x 1024)."}),
                "multiple": ("INT", {"default": LATENT_STEP, "min": LATENT_STEP, "max": 256, "step": LATENT_STEP,
                                     "tooltip": "Snap the result to a multiple of this. 16 is the smallest the H3 latent "
                                                "allows; larger values (32) make the result chunkier and less exact."}),
            }
        }

    def pick(self, width, height, mode, scale, custom_scale, target_megapixels, multiple):
        r = resolve(width, height, mode, scale, custom_scale, target_megapixels, multiple)
        mp_in = r["w"] * r["h"] / PIXELS_PER_MP
        mp_out = r["tw"] * r["th"] / PIXELS_PER_MP
        fit = "exact" if r["mismatch"] < 1e-6 else f"uneven {r['mismatch'] * 100:.1f}%"
        info = (f"{r['w']}x{r['h']} -> {r['tw']}x{r['th']} | {r['sw']:.3f}x by {r['sh']:.3f}x ({fit}) | "
                f"upscaler scale {r['scale']:.2f}x | {mp_in:.2f} -> {mp_out:.2f} MP")
        if r["note"]:
            info += f" | {r['note']}"
        print(f"[Nougan H3 Upscale Picker] {info}")
        ui = {"nougan_upscale": [{"sw": r["w"], "sh": r["h"], "tw": r["tw"], "th": r["th"], "scale": r["scale"]}]}
        return {"ui": ui, "result": (r["tw"], r["th"], float(r["scale"]), info)}


NODE_CLASS_MAPPINGS = {"NouganH3UpscalePicker": NouganH3UpscalePicker}
NODE_DISPLAY_NAME_MAPPINGS = {"NouganH3UpscalePicker": "Nougan H3 Upscale Picker 📈"}
