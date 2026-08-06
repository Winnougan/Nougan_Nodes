class NouganEditPromptTemplate:
    DEFAULT_SUFFIX = "Preserve the composition, lighting, style, facial expressions and backgrounds."

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "edit_instruction": ("STRING", {"multiline": True, "dynamicPrompts": True,
                                                "default": "Change the ... into ..."}),
            },
            "optional": {
                "enable_suffix": ("BOOLEAN", {"default": True}),
                "suffix": ("STRING", {"multiline": True, "default": cls.DEFAULT_SUFFIX}),
                "separator": (["newline", "space", "comma"], {"default": "newline"}),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("prompt",)
    FUNCTION = "build"
    CATEGORY = "Nougan/text"

    def build(self, edit_instruction, enable_suffix=True, suffix=None, separator="newline"):
        if suffix is None:
            suffix = self.DEFAULT_SUFFIX
        sep = {"newline": "\n", "space": " ", "comma": ", "}.get(separator, "\n")
        out = str(edit_instruction).strip()
        sfx = str(suffix).strip()
        if enable_suffix and sfx:
            out = (out + sep + sfx).strip()
        return (out,)