# title_font.py

class NouganTitleFont:
    """A decorative, fully-styled title / banner node.

    Type your text, pick a size (8–240px), colors, style, glow and animation,
    and optionally a web URL that turns the rendered title into a clickable
    link. The node is primarily visual; it also passes the text through as a
    STRING output so the same title can be reused downstream if you want.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {"default": "TITLE"}),
                "font_size": ("INT", {"default": 56, "min": 8, "max": 240, "step": 1}),
                "bold": ("BOOLEAN", {"default": True}),
                "glow": ("BOOLEAN", {"default": True}),
                "style": (
                    ["Solid", "Gradient", "Neon", "Rainbow", "Outline", "Chrome"],
                    {"default": "Gradient"},
                ),
                "color_a": ("STRING", {"default": "#ff3d7f"}),
                "color_b": ("STRING", {"default": "#3da5ff"}),
                "animate": (
                    ["None", "Pulse", "Float", "Shimmer", "Rainbow Shift", "Glow Pulse"],
                    {"default": "None"},
                ),
                "url": ("STRING", {"default": ""}),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("TEXT",)
    FUNCTION = "show"
    CATEGORY = "utils"          # change to "Nougan" / "conditioning" if you prefer
    TITLE = "Nougan Title Font"

    @classmethod
    def IS_CHANGED(cls, text, **kw):
        # The only output is the text, so cache on the text alone.
        return text

    def show(self, text, font_size, bold, glow, style,
             color_a, color_b, animate, url):
        return (text,)