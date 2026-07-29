# __init__.py
import os
from .diffusers_loader    import NouganDiffusersLoader
from .get_image           import NouganGetImage
from .krea2_loader        import NouganKrea2Loader, get_krea2_lora_status
from .text_encode         import NouganTextEncodeZeroNeg
from .text_box            import NouganTextBox
from .title_font          import NouganTitleFont

WEB_DIRECTORY = "./web"

# ── Core nodes: always registered (never wrapped — these must always load) ──
NODE_CLASS_MAPPINGS = {
    "NouganDiffusersLoader":   NouganDiffusersLoader,
    "NouganGetImage":          NouganGetImage,
    "NouganKrea2Loader":       NouganKrea2Loader,
    "NouganTextEncodeZeroNeg": NouganTextEncodeZeroNeg,
    "NouganTextBox":           NouganTextBox,
    "NouganTitleFont":         NouganTitleFont,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "NouganDiffusersLoader":   "Nougan Diffusers Loader 🚀",
    "NouganGetImage":          "Nougan Get Image 🖼️",
    "NouganKrea2Loader":       "Nougan Krea 2 · Uncensored 🌀",
    "NouganTextEncodeZeroNeg": "Nougan Text Encode + Zero Neg 🎯",
    "NouganTextBox":           "Nougan Text Box 📝",
    "NouganTitleFont":         "Nougan Title Font 🌈",
}

# ── Optional: Lora Loader (from-scratch build) ─────────────────────────────
try:
    from .nougan_lora_loader import NouganLoraLoader, NouganLoraLoaderMulti
    NODE_CLASS_MAPPINGS.update({
        "NouganLoraLoader":      NouganLoraLoader,
        "NouganLoraLoaderMulti": NouganLoraLoaderMulti,
    })
    NODE_DISPLAY_NAME_MAPPINGS.update({
        "NouganLoraLoader":      "Nougan Lora Loader 📁",
        "NouganLoraLoaderMulti": "Nougan Lora Loader (Multi-Model) 📁",
    })
    print("[Nougan] ✅ Lora Loader loaded (2 nodes).")
except Exception as _e:
    import traceback
    print(f"[Nougan] ⚠️  Lora Loader NOT loaded ({type(_e).__name__}: {_e}) — core 6 nodes are fine.")
    traceback.print_exc()

# ── Optional: Lora Inspector (Civitai metadata browser) ────────────────────
try:
    from .nougan_lora_inspector import NouganLoraInspector
    NODE_CLASS_MAPPINGS["NouganLoraInspector"] = NouganLoraInspector
    NODE_DISPLAY_NAME_MAPPINGS["NouganLoraInspector"] = "Nougan Lora Inspector 🔍"
    print("[Nougan] ✅ Lora Inspector loaded.")
except Exception as _e:
    import traceback
    print(f"[Nougan] ⚠️  Lora Inspector NOT loaded ({type(_e).__name__}: {_e}) — other nodes are fine.")
    traceback.print_exc()

# ── Optional: Mask Editor ──────────────────────────────────────────────────
try:
    from .mask_editor import NouganMaskEditor
    NODE_CLASS_MAPPINGS["NouganMaskEditor"] = NouganMaskEditor
    NODE_DISPLAY_NAME_MAPPINGS["NouganMaskEditor"] = "Nougan Mask Editor 🎨"
    print("[Nougan] ✅ Mask Editor loaded.")
except Exception as _e:
    import traceback
    print(f"[Nougan] ⚠️  Mask Editor NOT loaded ({type(_e).__name__}: {_e}) — other nodes are fine.")
    traceback.print_exc()

# ── Optional: Mask Composite ───────────────────────────────────────────────
try:
    from .mask_composite import NouganMaskComposite
    NODE_CLASS_MAPPINGS["NouganMaskComposite"] = NouganMaskComposite
    NODE_DISPLAY_NAME_MAPPINGS["NouganMaskComposite"] = "Nougan Mask Composite 🎭"
    print("[Nougan] ✅ Mask Composite loaded.")
except Exception as _e:
    import traceback
    print(f"[Nougan] ⚠️  Mask Composite NOT loaded ({type(_e).__name__}: {_e}) — other nodes are fine.")
    traceback.print_exc()

# ── Optional: Regional Character LoRA (Krea2 / Flux-2 single-stream DiT) ───
try:
    from .nougan_regional_lora import NouganRegionalCharacterLoRA
    NODE_CLASS_MAPPINGS["NouganRegionalCharacterLoRA"] = NouganRegionalCharacterLoRA
    NODE_CLASS_MAPPINGS["Krea2RegionalCharacterLoRA"]  = NouganRegionalCharacterLoRA
    NODE_CLASS_MAPPINGS["RegionalCharacterLora"]       = NouganRegionalCharacterLoRA
    NODE_DISPLAY_NAME_MAPPINGS["NouganRegionalCharacterLoRA"] = "Nougan Regional Character LoRA 👥"
    NODE_DISPLAY_NAME_MAPPINGS["Krea2RegionalCharacterLoRA"]  = "Nougan Regional Character LoRA 👥"
    NODE_DISPLAY_NAME_MAPPINGS["RegionalCharacterLora"]       = "Nougan Regional Character LoRA 👥"
    print("[Nougan] ✅ Regional Character LoRA loaded.")
except Exception as _e:
    import traceback
    print(f"[Nougan] ⚠️  Regional Character LoRA NOT loaded ({type(_e).__name__}: {_e}) — other nodes are fine.")
    traceback.print_exc()

# ── Optional: Prompt Relay (temporal local-prompt control for LTX Video) ───
# Its OWN try, so a problem here can never affect the core suite, the lora
# nodes, the mask nodes, or regional LoRA.  The sub-package contains three
# modules (relay_core, patches, advanced_options) and pairs with
# web/nougan-timeline_editor.js (the draggable-block timeline UI).
try:
    from .prompt_relay import (
        PromptRelayEncode,
        PromptRelayEncodeTimeline,
        PromptRelayAdvancedOptions,
    )
    NODE_CLASS_MAPPINGS.update({
        "PromptRelayEncode":          PromptRelayEncode,
        "PromptRelayEncodeTimeline":  PromptRelayEncodeTimeline,
        "PromptRelayAdvancedOptions": PromptRelayAdvancedOptions,
    })
    NODE_DISPLAY_NAME_MAPPINGS.update({
        "PromptRelayEncode":          "Nougan Prompt Relay Encode 🎬",
        "PromptRelayEncodeTimeline":  "Nougan Prompt Relay Timeline 🎞️",
        "PromptRelayAdvancedOptions": "Nougan Prompt Relay Options ⚙️",
    })
    print("[Nougan] ✅ Prompt Relay loaded (3 nodes).")
except Exception as _e:
    import traceback
    print(f"[Nougan] ⚠️  Prompt Relay NOT loaded ({type(_e).__name__}: {_e}) — other nodes are fine.")
    traceback.print_exc()


def _register_routes():
    try:
        from server import PromptServer
        from aiohttp import web
    except Exception:
        return

    @PromptServer.instance.routes.get("/nougan/krea2_loras")
    async def _krea2_loras(_request):
        return web.json_response({"loras": get_krea2_lora_status()})

    @PromptServer.instance.routes.get("/nougan/loras")
    async def _nougan_loras(_request):
        try:
            import os as _os
            import folder_paths as _fp
            names = [str(x).replace(_os.sep, "/") for x in _fp.get_filename_list("loras")]
        except Exception:
            names = []
        return web.json_response(names)


_register_routes()
__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]