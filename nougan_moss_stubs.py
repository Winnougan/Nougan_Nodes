"""NouganMoss stubs — Loader / Sampler / I2I / Layout / Vision.

These are PLACEHOLDERS ONLY, per the handoff brief: "Stub them, don't guess."
Each node raises immediately at execution time with a clear message. They are
registered so the graph UX (adding nodes, seeing sockets) can be evaluated,
but NO behaviour is implied and no defaults here are final.

Waiting on: the API-format workflow JSONs captured from the UI's POST /prompt
requests (one per mode; Vision/Enhance separately if they exist).
"""

_AWAITING = ("This node is a stub awaiting the captured ComfyUI workflow JSON "
             "for its mode. It does nothing yet — see NOTES.md.")


class _MossStub:
    FUNCTION = "run"
    CATEGORY = "Nougan/Moss"
    OUTPUT_NODE = False

    def run(self, **_kwargs):
        raise RuntimeError(f"{type(self).__name__}: {_AWAITING}")


class NouganMossLoader(_MossStub):
    """Stub: UNET (moss_image) + CLIP (type moss_image) + VAE loading."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("stub_status",)


class NouganMossSampler(_MossStub):
    """Stub: sampling (er_sde/simple per UI), seed control, Sequential Batch."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("stub_status",)


class NouganMossI2I(_MossStub):
    """Stub: image-to-image (denoise, resize, Match Source Aspect)."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("stub_status",)


class NouganMossLayout(_MossStub):
    """Stub: layout/box mode. Box semantics NOT approved — TODO(verify) against
    the Layout workflow JSON before any regional-prompt behaviour is built."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("stub_status",)


class NouganMossVision(_MossStub):
    """Stub: analyze-image -> prompt via OpenAI-compatible endpoint
    (base URL + model as inputs, API key from env var, never stored)."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("stub_status",)


NODE_CLASS_MAPPINGS = {
    "NouganMossLoader": NouganMossLoader,
    "NouganMossSampler": NouganMossSampler,
    "NouganMossI2I": NouganMossI2I,
    "NouganMossLayout": NouganMossLayout,
    "NouganMossVision": NouganMossVision,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "NouganMossLoader": "Nougan Moss Loader ⚠ stub",
    "NouganMossSampler": "Nougan Moss Sampler ⚠ stub",
    "NouganMossI2I": "Nougan Moss I2I ⚠ stub",
    "NouganMossLayout": "Nougan Moss Layout ⚠ stub",
    "NouganMossVision": "Nougan Moss Vision ⚠ stub",
}
