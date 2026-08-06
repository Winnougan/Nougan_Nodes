import inspect

import torch
import comfy.utils
import comfy.sample

try:
    from comfy.samplers import KSampler as _KS
    SAMPLERS = list(_KS.SAMPLERS)
    SCHEDULERS = list(_KS.SCHEDULERS)
except Exception:
    SAMPLERS = ["euler", "res_multistep", "dpmpp_2m", "uni_pc"]
    SCHEDULERS = ["simple", "normal", "karras"]

# Locate the core MiniMax H3 conditioning node
_H3Node = None
try:
    from nodes import NODE_CLASS_MAPPINGS as _CORE_NODES
    _H3Node = _CORE_NODES.get("MiniMaxH3ImageToVideo")
except Exception:
    _H3Node = None


def _empty_cond(clip):
    try:
        from nodes import CLIPTextEncode
        return CLIPTextEncode().encode(clip, "")[0]
    except Exception:
        return None


def _r32(v):
    return max(32, int(round(int(v) / 32)) * 32)


class NouganH3ImageEdit:
    """Drop-in superset of MiniMaxH3ImageToVideo: same prompt/width/height/length
    and first/last-frame interface, exposes positive + latent, AND runs the full
    sampling/decode pipeline so you get a finished image out the other side."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL",),
                "clip": ("CLIP",),
                "vae": ("VAE",),
                "prompt": ("STRING", {"multiline": True, "dynamicPrompts": True}),
                "width": ("INT", {"default": 0, "min": 0, "max": 8192, "step": 8,
                                  "tooltip": "0 = auto (from image/megapixels, else 1344x768)"}),
                "height": ("INT", {"default": 0, "min": 0, "max": 8192, "step": 8,
                                   "tooltip": "0 = auto"}),
                "frame_length": ("INT", {"default": 1, "min": 1, "max": 257, "step": 1,
                                         "tooltip": "the core node's 'length'"}),
                "batch_index": ("INT", {"default": 0, "min": 0, "max": 256, "step": 1}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff}),
                "steps": ("INT", {"default": 20, "min": 1, "max": 150, "step": 1}),
                "cfg": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 100.0, "step": 0.1}),
                "sampler_name": (SAMPLERS,),
                "scheduler": (SCHEDULERS,),
                "denoise": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01}),
            },
            "optional": {
                "image": ("IMAGE", {"tooltip": "first_frame — connect to edit, leave empty to generate"}),
                "last_frame": ("IMAGE",),
                "megapixels": ("FLOAT", {"default": 1.0, "min": 0.1, "max": 8.0, "step": 0.01,
                                         "tooltip": "auto-size target when width/height = 0"}),
                "resize_back_method": (["lanczos", "bicubic", "bilinear", "area", "nearest-exact"],
                                       {"default": "lanczos"}),
            },
            "hidden": {"prompt_id": "PROMPT_ID"},
        }

    RETURN_TYPES = ("IMAGE", "IMAGE", "CONDITIONING", "LATENT", "INT", "INT")
    RETURN_NAMES = ("image", "native_res", "positive", "latent", "width", "height")
    FUNCTION = "edit"
    CATEGORY = "Nougan/MiniMax H3"

    # ── helpers ─────────────────────────────────────────────────────────────
    def _progress(self, percent, stage, prompt_id):
        try:
            from server import PromptServer
            PromptServer.instance.send_sync("nougan_progress", {
                "percent": float(percent),
                "stage": str(stage),
                "prompt_id": prompt_id,
            })
        except Exception:
            pass

    def _scale_to_megapixels(self, image, megapixels, multiple=32, method="nearest-exact"):
        h, w = image.shape[1], image.shape[2]
        total = h * w
        if total <= 0:
            return image, w, h
        target = float(megapixels) * 1024 * 1024
        scale = (target / total) ** 0.5
        new_w = max(multiple, int(round(w * scale / multiple)) * multiple)
        new_h = max(multiple, int(round(h * scale / multiple)) * multiple)
        t = image.movedim(-1, 1)
        t = comfy.utils.common_upscale(t, new_w, new_h, method, "center")
        return t.movedim(1, -1), new_w, new_h

    # ── main ────────────────────────────────────────────────────────────────
    def edit(self, model, clip, vae, prompt,
             width=0, height=0, frame_length=1, batch_index=0, seed=0,
             steps=20, cfg=1.0, sampler_name="res_multistep", scheduler="simple",
             denoise=1.0, image=None, last_frame=None, megapixels=1.0,
             resize_back_method="lanczos", prompt_id=None):

        if _H3Node is None:
            raise RuntimeError("[Nougan H3] Core node 'MiniMaxH3ImageToVideo' not found. "
                               "Update ComfyUI to a version that supports MiniMax H3.")

        orig_w = orig_h = None
        if image is not None:
            orig_h, orig_w = image.shape[1], image.shape[2]

        # ── resolve target dims + first_frame ──
        if width and width > 0 and height and height > 0:
            tw, th = _r32(width), _r32(height)
            first_frame = image                      # core node resizes to tw×th internally
        elif image is not None:
            first_frame, tw, th = self._scale_to_megapixels(image, megapixels, multiple=32)
        else:
            tw, th = 1344, 768                        # H3 native canvas
            first_frame = None

        self._progress(10, "Building conditioning", prompt_id)

        h3 = _H3Node()
        fn = getattr(h3, _H3Node.FUNCTION)
        try:
            valid = set(inspect.signature(fn).parameters.keys())
        except Exception:
            valid = None

        kwargs = {"clip": clip, "vae": vae, "prompt": prompt,
                  "width": tw, "height": th, "length": frame_length}
        if first_frame is not None:
            kwargs["first_frame"] = first_frame
        if last_frame is not None:
            kwargs["last_frame"] = last_frame
        if valid is not None:
            kwargs = {k: v for k, v in kwargs.items() if k in valid}

        out = fn(**kwargs)
        if isinstance(out, dict):
            positive = out.get("positive")
            latent = out.get("LATENT") or out.get("latent")
        else:
            positive, latent = out[0], out[1]

        negative = _empty_cond(clip) or positive     # cfg=1 → effectively unused

        self._progress(30, "Sampling", prompt_id)
        noise = comfy.sample.prepare_noise(latent, seed)
        samples = comfy.sample.sample(model, noise, steps, cfg, sampler_name, scheduler,
                                      positive, negative, latent, denoise=denoise)

        self._progress(85, "Decoding", prompt_id)
        decoded = vae.decode(samples["samples"])

        self._progress(92, "Extracting frame", prompt_id)
        bi = max(0, min(int(batch_index), decoded.shape[0] - 1))
        native_frame = decoded[bi:bi + 1]

        # ── final image: resize back to source dims only in edit mode ──
        if image is not None and orig_w and orig_h:
            self._progress(96, "Resizing back", prompt_id)
            t = native_frame.movedim(-1, 1)
            t = comfy.utils.common_upscale(t, orig_w, orig_h, resize_back_method, "center")
            image_out = t.movedim(1, -1)
        else:
            image_out = native_frame

        self._progress(100, "Done", prompt_id)
        out_h, out_w = image_out.shape[1], image_out.shape[2]
        return (image_out, native_frame, positive, latent, out_w, out_h)