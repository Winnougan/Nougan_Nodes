# text_box.py

class NouganTextBox:
    """A plain, styled text box. Whatever you type is emitted as a STRING
    output, ready to feed a CLIP text encoder (or any other string input).
    The editable widget IS the source of truth; the JS panel only mirrors it.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": (
                    "STRING",
                    {
                        "multiline": True,
                        "default": "",
                        "tooltip": "Type anything. This text is sent to the STRING output.",
                    },
                ),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("TEXT",)
    FUNCTION = "passthrough"
    CATEGORY = "utils"
    TITLE = "Nougan Text Box"

    @classmethod
    def IS_CHANGED(cls, text, **kw):
        # Re-run only when the text actually changes (keeps caching sane,
        # but guarantees downstream nodes see your edits on the next queue).
        return text

    def passthrough(self, text):
        return (text,)