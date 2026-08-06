import torch
import numpy as np
import comfy.utils

try:
    from PIL import Image, ImageDraw, ImageFont
    _PIL_OK = True
except Exception:
    _PIL_OK = False


def _hex_to_rgb255(h, default=(255, 255, 255)):
    try:
        h = str(h).strip().lstrip("#")
        if len(h) == 3:
            h = "".join(c * 2 for c in h)
        return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))
    except Exception:
        return default


def _resize_to_height(img_hwc, target_h, method="lanczos"):
    h, w = img_hwc.shape[0], img_hwc.shape[1]
    if h <= 0 or w <= 0 or h == target_h:
        return img_hwc
    new_w = max(1, round(w * target_h / h))
    t = img_hwc.unsqueeze(0).movedim(-1, 1)   # 1,C,H,W
    t = comfy.utils.common_upscale(t, new_w, target_h, method, "center")
    return t.movedim(1, -1).squeeze(0)        # H,W,C


def _to_rgb(img_hwc):
    c = img_hwc.shape[-1]
    if c == 1:
        return img_hwc.repeat(1, 1, 3)
    if c >= 3:
        return img_hwc[..., :3]
    pad = torch.zeros(img_hwc.shape[0], img_hwc.shape[1], 3 - c, dtype=img_hwc.dtype)
    return torch.cat([img_hwc, pad], dim=-1)


def _font(size):
    try:
        return ImageFont.truetype("arial.ttf", max(12, int(size) - 8))
    except Exception:
        try:
            return ImageFont.load_default()
        except Exception:
            return None


class NouganBeforeAfterCompare:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image1": ("IMAGE",),
                "image2": ("IMAGE",),
            },
            "optional": {
                "image3": ("IMAGE",),
                "text1": ("STRING", {"default": "Before"}),
                "text2": ("STRING", {"default": "After"}),
                "text3": ("STRING", {"default": "Image 3"}),
                "gap": ("INT", {"default": 8, "min": 0, "max": 64, "step": 1}),
                "label_height": ("INT", {"default": 48, "min": 0, "max": 256, "step": 1}),
                "bg_color": ("STRING", {"default": "#000000"}),
                "text_color": ("STRING", {"default": "#FFFFFF"}),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "compare"
    CATEGORY = "Nougan/image"

    def compare(self, image1, image2, image3=None,
                text1="Before", text2="After", text3="Image 3",
                gap=8, label_height=48, bg_color="#000000", text_color="#FFFFFF"):
        frames = [image1[0], image2[0]]
        labels = [text1, text2]
        if image3 is not None:
            frames.append(image3[0])
            labels.append(text3)

        target_h = image1.shape[1]
        panels = [_to_rgb(_resize_to_height(f, target_h)) for f in frames]

        gap = max(0, int(gap))
        label_height = max(0, int(label_height))
        total_w = sum(p.shape[1] for p in panels) + gap * (len(panels) - 1)
        total_h = target_h + label_height

        bg = torch.tensor(_hex_to_rgb255(bg_color, (0, 0, 0)), dtype=panels[0].dtype) / 255.0
        canvas = bg.view(1, 1, 3).expand(total_h, total_w, 3).clone()

        x = 0
        rects = []
        for p in panels:
            pw = p.shape[1]
            canvas[label_height:label_height + target_h, x:x + pw, :] = p
            rects.append((x, pw))
            x += pw + gap

        out = canvas
        if _PIL_OK and label_height > 0:
            arr = (canvas.cpu().numpy() * 255).clip(0, 255).astype(np.uint8)
            pil = Image.fromarray(arr)
            draw = ImageDraw.Draw(pil)
            fnt = _font(label_height)
            tcol = _hex_to_rgb255(text_color, (255, 255, 255))
            for (px, pw), txt in zip(rects, labels):
                try:
                    bbox = draw.textbbox((0, 0), txt, font=fnt)
                    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
                except Exception:
                    tw, th = len(txt) * 8, 12
                tx = px + (pw - tw) // 2
                ty = (label_height - th) // 2
                try:
                    draw.text((tx, ty), txt, fill=tcol, font=fnt)
                except Exception:
                    draw.text((tx, ty), txt, fill=tcol)
            out = torch.from_numpy(np.array(pil).astype(np.float32) / 255.0)

        return (out.unsqueeze(0),)