# text_encode.py
import torch


class NouganTextEncodeZeroNeg:
    """Combined CLIP text encoder (positive) + zero/empty conditioning (negative).
    Replaces the common CLIPTextEncode → ConditioningZeroOut two-node chain
    with a single node that outputs both at once.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "clip": ("CLIP",),
                "positive": (
                    "STRING",
                    {"multiline": True, "default": "",
                     "tooltip": "Positive prompt. Encoded normally via CLIP."},
                ),
                "negative_mode": (
                    ["Zero Out", "Empty String"],
                    {"default": "Zero Out",
                     "tooltip": (
                         "Zero Out: zeros the conditioning tensors (standard for "
                         "Flux/Krea2/Ideogram-style flow models with CFG > 1).\n"
                         "Empty String: encodes \"\" through CLIP (use when the "
                         "model expects a real empty-text embedding)."
                     )},
                ),
            },
        }

    RETURN_TYPES = ("CONDITIONING", "CONDITIONING")
    RETURN_NAMES = ("POSITIVE", "NEGATIVE")
    FUNCTION = "encode"
    CATEGORY = "conditioning"
    TITLE = "Nougan Text Encode + Zero Neg"

    def encode(self, clip, positive, negative_mode="Zero Out"):
        # ── Positive: standard CLIP text encode ──
        tokens_pos = clip.tokenize(positive)
        positive_cond = clip.encode_from_tokens_scheduled(tokens_pos)

        # ── Negative ──
        if negative_mode == "Zero Out":
            # Mirror ComfyUI's built-in ConditioningZeroOut:
            # zero the main tensor AND the pooled_output (if present).
            negative_cond = []
            for tensor, meta in positive_cond:
                d = meta.copy()
                pooled = d.get("pooled_output", None)
                if pooled is not None:
                    d["pooled_output"] = torch.zeros_like(pooled)
                negative_cond.append([torch.zeros_like(tensor), d])
        else:
            # Encode an empty string through CLIP.
            tokens_neg = clip.tokenize("")
            negative_cond = clip.encode_from_tokens_scheduled(tokens_neg)

        return (positive_cond, negative_cond)