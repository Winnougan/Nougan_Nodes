"""
Nougan Model Preview Mirror
---------------------------
Server half of the mirror node. It does no sampling and no encoding: the live preview data is already
broadcast to the browser by KJNodes' "Model Preview Override" (event "kj_preview_override"). This node
only (a) exists so the frontend has something to attach a DOM preview widget to, and (b) passes any value
straight through, so it can be dropped inline anywhere in a chain. If the value happens to be a MODEL that
carries a Model Preview Override, the mirror also pins itself to that one preview.

Requires KJNodes (the Model Preview Override node) to be installed; nothing here imports it.
"""

import comfy.patcher_extension

_WRAPPER_KEY = "kj_preview_override"


class _AnyType(str):
    """Wildcard socket type: compares equal to every other type, so it connects to anything."""
    def __ne__(self, other):
        return False

    def __eq__(self, other):
        return True

    def __hash__(self):
        return hash("*")


ANY = _AnyType("*")


class NouganModelPreviewMirror:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "preview_fps": ("INT", {
                    "default": 12, "min": 1, "max": 60, "step": 1,
                    "tooltip": "Playback FPS for this mirror (ignored for clips that carry audio).",
                }),
            },
            "optional": {
                "any": (ANY, {
                    "tooltip": "Optional. Connect anything, anywhere in your chain; it is passed through unchanged. "
                               "Leave empty (or connect a non-model) to mirror whichever preview is sampling. "
                               "Connect a MODEL that carries a Model Preview Override to follow only that one.",
                }),
            },
        }

    RETURN_TYPES = (ANY,)
    RETURN_NAMES = ("any",)
    FUNCTION = "run"
    OUTPUT_NODE = True          # executes even when nothing is connected to its output
    CATEGORY = "Nougan/sampling"
    DESCRIPTION = (
        "Mirrors the live preview of KJNodes' Model Preview Override onto this node. "
        "Any input / any output: drop it inline anywhere (or leave it unconnected) and it shows the live "
        "preview. Connect a MODEL carrying a preview override to follow only that one."
    )

    def run(self, preview_fps=12, any=None):
        source = None
        # only a MODEL (ModelPatcher) can tell us which preview node it carries; anything else is ignored
        if any is not None and hasattr(any, "get_wrappers"):
            try:
                wrappers = any.get_wrappers(comfy.patcher_extension.WrappersMP.OUTER_SAMPLE, _WRAPPER_KEY)
                if wrappers and getattr(wrappers[-1], "node_id", None) is not None:
                    source = str(wrappers[-1].node_id)
            except Exception:
                source = None
        # empty list => frontend follows any preview
        return {"ui": {"nougan_source_id": [source] if source else []}, "result": (any,)}


NODE_CLASS_MAPPINGS = {"NouganModelPreviewMirror": NouganModelPreviewMirror}
NODE_DISPLAY_NAME_MAPPINGS = {"NouganModelPreviewMirror": "Model Preview Mirror (Nougan)"}
