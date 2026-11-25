"""NouganMossPrompt — MOSS-Image prompt assembly (Pre triggers + text + Post triggers).

Final prompt = non-empty parts of [triggers_pre, text, triggers_post],
joined with ", ". NouganMossHistory strips triggers again when saving, so a
regenerated entry doesn't accumulate duplicates (per the handoff brief).

Styles: only "General — No Style" is shipped. The full preset list from the
UI is TODO(verify) — stable-combo lesson: never rename a combo value once
users have it saved, so we don't ship guessed labels.

Enhance is intentionally absent here: the brief puts it in Phase 4 with the
OpenAI-compatible endpoint (base URL + model as inputs, key from env var).
"""

# Stable-combo lesson: append-only list, never rename an existing label.
# TODO(verify): full style preset list from the Moss Image Pro UI source.
STYLE_OPTIONS = ["General — No Style"]


def assemble_prompt(triggers_pre, text, triggers_post):
    """Pre triggers + text + Post triggers, ", "-joined, empties dropped."""
    parts = [p.strip() for p in (triggers_pre, text, triggers_post) if p and p.strip()]
    return ", ".join(parts)


class NouganMossPrompt:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "style": (STYLE_OPTIONS, {"default": STYLE_OPTIONS[0]}),
                "text": ("STRING", {"multiline": True, "default": "",
                                    "tooltip": "Main prompt. Trigger words from NouganMossLoras are added "
                                               "around it (Pre before, Post after)."}),
                "negative": ("STRING", {"multiline": True, "default": ""}),
            },
            "optional": {
                "triggers_pre": ("STRING", {"forceInput": True,
                                            "tooltip": "From NouganMossLoras.triggers_pre"}),
                "triggers_post": ("STRING", {"forceInput": True,
                                             "tooltip": "From NouganMossLoras.triggers_post"}),
                "clip": ("CLIP", {"tooltip": "Optional. When connected, positive/negative "
                                             "CONDITIONING are produced as well."}),
            },
        }

    RETURN_TYPES = ("STRING", "STRING", "CONDITIONING", "CONDITIONING")
    RETURN_NAMES = ("prompt", "negative", "positive", "negative_cond")
    FUNCTION = "run"
    CATEGORY = "Nougan/Moss"
    DESCRIPTION = ("Assembles the final MOSS-Image prompt: Pre triggers + text + "
                   "Post triggers. Encodes CONDITIONING when a CLIP is connected.")

    @classmethod
    def VALIDATE_INPUTS(cls, style, text, negative, triggers_pre=None, triggers_post=None, clip=None):
        if style not in STYLE_OPTIONS:
            return f"unknown style {style!r}"
        return True

    def run(self, style, text, negative, triggers_pre=None, triggers_post=None, clip=None):
        prompt = assemble_prompt(triggers_pre, text, triggers_post)
        negative = negative or ""

        positive = negative_cond = None
        if clip is not None:
            # Style presets beyond "General — No Style" are TODO(verify); when
            # they land, the style text is appended to the prompt before
            # tokenizing, NOT baked in here — keep this function style-agnostic.
            positive = clip.encode_from_tokens_scheduled(clip.tokenize(prompt))
            negative_cond = clip.encode_from_tokens_scheduled(clip.tokenize(negative))
        return (prompt, negative, positive, negative_cond)


NODE_CLASS_MAPPINGS = {"NouganMossPrompt": NouganMossPrompt}
NODE_DISPLAY_NAME_MAPPINGS = {"NouganMossPrompt": "Nougan Moss Prompt ✍️"}
