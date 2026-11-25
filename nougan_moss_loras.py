"""NouganMossLoras — MOSS-Image LoRA stack with trigger words (Pre/Post).

Reuses the existing Nougan LoRA stack code (nougan_lora_loader._parse/_apply)
so application behaviour — strength clamp, H3 AdaLN port hook, SD cache — is
identical to NouganLoraLoader. This node only ADDS two things on top:

  * per-slot `trigger` (trigger word text) and `pos` ("pre"/"post") fields
    in the hidden lora_data JSON. The existing _parse() only reads
    on/name/model/clip/strength, so old and new data are fully compatible
    in both directions (extra keys are ignored there).
  * two trigger outputs: triggers_pre (prompt prefix) and triggers_post
    (prompt suffix), assembled from ENABLED slots with non-empty triggers.

Wire triggers_pre/triggers_post into NouganMossPrompt.
"""

import json

try:
    from .nougan_lora_loader import _apply as _apply_lora_stack
except ImportError:  # direct import (tests, standalone)
    from nougan_lora_loader import _apply as _apply_lora_stack

_POS_VALUES = ("pre", "post")


def parse_trigger_slots(lora_data):
    """Return (triggers_pre, triggers_post) as ", "-joined strings.

    Only ENABLED slots with non-empty trigger text contribute. Never raises —
    malformed JSON simply yields empty strings (the loader side validates).
    """
    try:
        parsed = json.loads(lora_data or "{}")
    except (TypeError, ValueError):
        return "", ""
    raw = parsed if isinstance(parsed, list) else parsed.get("loras", [])
    pre, post = [], []
    for e in raw if isinstance(raw, list) else []:
        if not isinstance(e, dict):
            continue
        if e.get("on", True) is False:
            continue
        t = str(e.get("trigger") or "").strip()
        if not t:
            continue
        (post if str(e.get("pos", "pre")).lower() == "post" else pre).append(t)
    return ", ".join(pre), ", ".join(post)


class NouganMossLoras:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL",),
                # Hidden widget: populated by the DOM slot UI
                # (web/nougan_moss_loras.js). JSON:
                # {"loras": [{on, name, strength, trigger, pos}, ...]}
                "lora_data": ("STRING", {"default": "{}", "multiline": True}),
            },
            "optional": {
                "clip": ("CLIP",),
            },
        }

    RETURN_TYPES = ("MODEL", "CLIP", "STRING", "STRING")
    RETURN_NAMES = ("MODEL", "CLIP", "triggers_pre", "triggers_post")
    FUNCTION = "run"
    CATEGORY = "Nougan/Moss"
    DESCRIPTION = ("MOSS-Image LoRA slots with per-slot trigger words. "
                   "Pre triggers go before the prompt, Post triggers after. "
                   "Shares the Nougan LoRA loader's data format and application code.")

    @classmethod
    def IS_CHANGED(cls, model, lora_data, clip=None):
        return str(lora_data)

    @classmethod
    def VALIDATE_INPUTS(cls, model=None, lora_data="{}", clip=None):
        try:
            parsed = json.loads(lora_data or "{}")
        except (TypeError, ValueError):
            return "lora_data is not valid JSON"
        raw = parsed if isinstance(parsed, list) else parsed.get("loras", [])
        if not isinstance(raw, list):
            return "lora_data.loras must be a list"
        for i, e in enumerate(raw):
            if not isinstance(e, dict):
                return f"lora slot #{i} is not an object"
            pos = str(e.get("pos", "pre")).lower()
            if pos not in _POS_VALUES:
                return f"lora slot #{i}: pos must be one of {_POS_VALUES}"
            if "strength" in e:
                try:
                    float(e["strength"])
                except (TypeError, ValueError):
                    return f"lora slot #{i}: strength must be a number"
        return True

    def run(self, model, lora_data, clip=None):
        model_out, clip_out = _apply_lora_stack(model, clip, lora_data)
        pre, post = parse_trigger_slots(lora_data)
        return (model_out, clip_out, pre, post)


NODE_CLASS_MAPPINGS = {"NouganMossLoras": NouganMossLoras}
NODE_DISPLAY_NAME_MAPPINGS = {"NouganMossLoras": "Nougan Moss LoRAs 🎚️"}
