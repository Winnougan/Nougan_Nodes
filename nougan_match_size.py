import torch
import comfy.utils


class NouganMatchImageSize:
    """Resize an IMAGE or MASK toward a reference's dimensions (or explicit W/H),
    with the same resize-type flexibility as the core ResizeImageMaskNode."""

    SCALE_METHODS = ["nearest-exact", "bilinear", "area", "bicubic", "lanczos"]

    RESIZE_TYPES = [
        "scale dimensions",   # exact W×H — crop widget decides stretch vs center-crop
        "fit within",         # keep aspect, fit inside W×H (no padding)
        "fill (crop)",        # keep aspect, cover W×H, center-cropped
        "pad to",             # keep aspect, fit inside W×H, padded to exact size
        "shortest side",      # shortest side == width value
        "longest side",       # longest side == width value
        "fit width",          # width == width value
        "fit height",         # height == height value
    ]

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "input": ("IMAGE,MASK",),
                "resize_type": (cls.RESIZE_TYPES, {"default": "scale dimensions"}),
                "scale_method": (cls.SCALE_METHODS, {"default": "lanczos"}),
            },
            "optional": {
                "reference_image": ("IMAGE,MASK",),
                "width": ("INT", {"default": 0, "min": 0, "max": 16384, "step": 1,
                                  "tooltip": "0 = use reference width"}),
                "height": ("INT", {"default": 0, "min": 0, "max": 16384, "step": 1,
                                   "tooltip": "0 = use reference height"}),
                "crop": (["center", "disabled"], {"default": "center",
                                                  "tooltip": "used by 'scale dimensions'"}),
                "pad_color": ("STRING", {"default": "#000000",
                                         "tooltip": "hex color used by 'pad to'"}),
                "round_to": ("INT", {"default": 1, "min": 1, "max": 128, "step": 1,
                                     "tooltip": "round computed dims to a multiple (e.g. 32)"}),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK", "INT", "INT")
    RETURN_NAMES = ("image", "mask", "width", "height")
    FUNCTION = "resize"
    CATEGORY = "Nougan/image"

    # ── helpers ─────────────────────────────────────────────────────────────
    @staticmethod
    def _parse_color(h):
        try:
            h = str(h).strip().lstrip("#")
            if len(h) == 3:
                h = "".join(c * 2 for c in h)
            return tuple(int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4))
        except Exception:
            return (0.0, 0.0, 0.0)

    def _resize_bchw(self, img, tw, th, resize_type, method, crop, pad_color, round_to):
        """img: (B, C, H, W) → resized (B, C, H', W')"""
        _, c, h, w = img.shape

        def rnd(v):
            return max(round_to, int(round(int(v) / round_to) * round_to))

        # Exact-target modes
        if resize_type == "scale dimensions":
            return comfy.utils.common_upscale(img, tw, th, method, crop)
        if resize_type == "fill (crop)":
            return comfy.utils.common_upscale(img, tw, th, method, "center")

        # Aspect-preserving modes → compute new dims
        if resize_type == "fit width":
            nw, nh = tw, rnd(h * tw / w)
        elif resize_type == "fit height":
            nw, nh = rnd(w * th / h), th
        elif resize_type == "shortest side":
            if w <= h:
                nw, nh = tw, rnd(h * tw / w)
            else:
                nw, nh = rnd(w * tw / h), tw
        elif resize_type == "longest side":
            if w >= h:
                nw, nh = tw, rnd(h * tw / w)
            else:
                nw, nh = rnd(w * tw / h), tw
        elif resize_type in ("fit within", "pad to"):
            scale = min(tw / w, th / h)
            nw, nh = rnd(w * scale), rnd(h * scale)
        else:
            return comfy.utils.common_upscale(img, tw, th, method, crop)

        nw, nh = max(round_to, nw), max(round_to, nh)
        scaled = comfy.utils.common_upscale(img, nw, nh, method, "disabled")

        if resize_type == "pad to":
            canvas = torch.zeros(img.shape[0], c, th, tw, dtype=img.dtype, device=img.device)
            rgb = self._parse_color(pad_color)
            for i in range(min(c, 3)):
                canvas[:, i, :, :] = rgb[i]
            y0, x0 = max(0, (th - nh) // 2), max(0, (tw - nw) // 2)
            paste_h, paste_w = min(nh, th - y0), min(nw, tw - x0)
            canvas[:, :, y0:y0 + paste_h, x0:x0 + paste_w] = scaled[:, :, :paste_h, :paste_w]
            return canvas

        return scaled

    # ── main ────────────────────────────────────────────────────────────────
    def resize(self, input, resize_type, scale_method,
               reference_image=None, width=0, height=0,
               crop="center", pad_color="#000000", round_to=1):

        is_mask = input.ndim == 3  # MASK = (B,H,W), IMAGE = (B,H,W,C)
        img = input.unsqueeze(1) if is_mask else input.movedim(-1, 1)  # → B,C,H,W

        # Resolve target dims: explicit overrides win, else reference
        ref_w = ref_h = None
        if reference_image is not None:
            ref_h, ref_w = reference_image.shape[1], reference_image.shape[2]
        target_w = int(width) if width and width > 0 else ref_w
        target_h = int(height) if height and height > 0 else ref_h
        if not target_w or not target_h:
            raise ValueError("[Nougan Match/Resize] No target size — connect a "
                             "reference_image or set explicit width/height.")

        round_to = max(1, int(round_to))
        out = self._resize_bchw(img, int(target_w), int(target_h),
                                resize_type, scale_method, crop, pad_color, round_to)

        out_h, out_w = out.shape[2], out.shape[3]
        image_out = out.movedim(1, -1)   # B,H,W,C
        mask_out = out[:, 0, :, :]       # B,H,W
        return (image_out, mask_out, out_w, out_h)