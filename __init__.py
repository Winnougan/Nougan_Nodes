# __init__.py
import os
import traceback

WEB_DIRECTORY = "./web"

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

# Fallback so the /nougan/krea2_loras route can never NameError.
def get_krea2_lora_status():
    return []

# ── Core nodes — each in its own try/except so ONE bad file can't kill all ──
try:
    from .diffusers_loader import NouganDiffusersLoader
    NODE_CLASS_MAPPINGS["NouganDiffusersLoader"] = NouganDiffusersLoader
    NODE_DISPLAY_NAME_MAPPINGS["NouganDiffusersLoader"] = "Nougan Diffusers Loader 🚀"
except Exception as _e:
    print(f"[Nougan] ⚠️  diffusers_loader NOT loaded ({type(_e).__name__}: {_e})")
    traceback.print_exc()

try:
    from .get_image import NouganGetImage
    NODE_CLASS_MAPPINGS["NouganGetImage"] = NouganGetImage
    NODE_DISPLAY_NAME_MAPPINGS["NouganGetImage"] = "Nougan Get Image 🖼️"
except Exception as _e:
    print(f"[Nougan] ⚠️  get_image NOT loaded ({type(_e).__name__}: {_e})")
    traceback.print_exc()

try:
    from .krea2_loader import (
        NouganKrea2Loader,
        NouganKrea2LoaderMulti,
        get_krea2_lora_status as _gk2,
    )
    get_krea2_lora_status = _gk2
    NODE_CLASS_MAPPINGS["NouganKrea2Loader"] = NouganKrea2Loader
    NODE_CLASS_MAPPINGS["NouganKrea2LoaderMulti"] = NouganKrea2LoaderMulti
    NODE_DISPLAY_NAME_MAPPINGS["NouganKrea2Loader"] = "Nougan Krea 2 · LoRA 🌀"
    NODE_DISPLAY_NAME_MAPPINGS["NouganKrea2LoaderMulti"] = "Nougan Krea 2 · LoRA Stack 🌀"
    print("[Nougan] ✅ Krea 2 loader loaded (2 nodes).")
except Exception as _e:
    print(f"[Nougan] ⚠️  krea2_loader NOT loaded ({type(_e).__name__}: {_e}) — other nodes are fine.")
    traceback.print_exc()

try:
    from .text_encode import NouganTextEncodeZeroNeg
    NODE_CLASS_MAPPINGS["NouganTextEncodeZeroNeg"] = NouganTextEncodeZeroNeg
    NODE_DISPLAY_NAME_MAPPINGS["NouganTextEncodeZeroNeg"] = "Nougan Text Encode + Zero Neg 🎯"
except Exception as _e:
    print(f"[Nougan] ⚠️  text_encode NOT loaded ({type(_e).__name__}: {_e})")
    traceback.print_exc()

try:
    from .text_box import NouganTextBox
    NODE_CLASS_MAPPINGS["NouganTextBox"] = NouganTextBox
    NODE_DISPLAY_NAME_MAPPINGS["NouganTextBox"] = "Nougan Text Box 📝"
except Exception as _e:
    print(f"[Nougan] ⚠️  text_box NOT loaded ({type(_e).__name__}: {_e})")
    traceback.print_exc()

try:
    from .title_font import NouganTitleFont
    NODE_CLASS_MAPPINGS["NouganTitleFont"] = NouganTitleFont
    NODE_DISPLAY_NAME_MAPPINGS["NouganTitleFont"] = "Nougan Title Font 🌈"
except Exception as _e:
    print(f"[Nougan] ⚠️  title_font NOT loaded ({type(_e).__name__}: {_e})")
    traceback.print_exc()

# ── Optional: Remote Set / Get ──────────────────────────────────────────────
try:
    from .nougan_set_get import NouganSet, NouganGet
    NODE_CLASS_MAPPINGS.update({"NouganSet": NouganSet, "NouganGet": NouganGet})
    NODE_DISPLAY_NAME_MAPPINGS.update({
        "NouganSet": "Nougan Set (Remote) 📡",
        "NouganGet": "Nougan Get (Remote) 📥",
    })
    print("[Nougan] ✅ Remote Set/Get loaded (2 nodes).")
except Exception as _e:
    print(f"[Nougan] ⚠️  Remote Set/Get NOT loaded ({type(_e).__name__}: {_e})")
    traceback.print_exc()

# ── Optional: Power Lora Loader ─────────────────────────────────────────────
try:
    from .nougan_lora_loader import NouganLoraLoader, NouganLoraLoaderMulti
    NODE_CLASS_MAPPINGS.update({
        "NouganLoraLoader": NouganLoraLoader,
        "NouganLoraLoaderMulti": NouganLoraLoaderMulti,
    })
    NODE_DISPLAY_NAME_MAPPINGS.update({
        "NouganLoraLoader": "Nougan Lora Loader 📁",
        "NouganLoraLoaderMulti": "Nougan Lora Loader (Multi-Model) 📁",
    })
    print("[Nougan] ✅ Power Lora Loader loaded (2 nodes).")
except Exception as _e:
    print(f"[Nougan] ⚠️  Power Lora Loader NOT loaded ({type(_e).__name__}: {_e})")
    traceback.print_exc()

# ── Optional: Lora Inspector ────────────────────────────────────────────────
try:
    from .nougan_lora_inspector import NouganLoraInspector
    NODE_CLASS_MAPPINGS["NouganLoraInspector"] = NouganLoraInspector
    NODE_DISPLAY_NAME_MAPPINGS["NouganLoraInspector"] = "Nougan Lora Inspector 🔍"
    print("[Nougan] ✅ Lora Inspector loaded.")
except Exception as _e:
    print(f"[Nougan] ⚠️  Lora Inspector NOT loaded ({type(_e).__name__}: {_e})")
    traceback.print_exc()

# ── Optional: Mask Editor ───────────────────────────────────────────────────
try:
    from .mask_editor import NouganMaskEditor
    NODE_CLASS_MAPPINGS["NouganMaskEditor"] = NouganMaskEditor
    NODE_DISPLAY_NAME_MAPPINGS["NouganMaskEditor"] = "Nougan Mask Editor 🎨"
    print("[Nougan] ✅ Mask Editor loaded.")
except Exception as _e:
    print(f"[Nougan] ⚠️  Mask Editor NOT loaded ({type(_e).__name__}: {_e})")
    traceback.print_exc()

# ── Optional: Mask Composite ────────────────────────────────────────────────
try:
    from .mask_composite import NouganMaskComposite
    NODE_CLASS_MAPPINGS["NouganMaskComposite"] = NouganMaskComposite
    NODE_DISPLAY_NAME_MAPPINGS["NouganMaskComposite"] = "Nougan Mask Composite 🎭"
    print("[Nougan] ✅ Mask Composite loaded.")
except Exception as _e:
    print(f"[Nougan] ⚠️  Mask Composite NOT loaded ({type(_e).__name__}: {_e})")
    traceback.print_exc()

# ── Optional: Regional Character LoRA ───────────────────────────────────────
try:
    from .nougan_regional_lora import NouganRegionalCharacterLoRA
    NODE_CLASS_MAPPINGS["NouganRegionalCharacterLoRA"] = NouganRegionalCharacterLoRA
    NODE_CLASS_MAPPINGS["Krea2RegionalCharacterLoRA"] = NouganRegionalCharacterLoRA
    NODE_CLASS_MAPPINGS["RegionalCharacterLora"] = NouganRegionalCharacterLoRA
    NODE_DISPLAY_NAME_MAPPINGS["NouganRegionalCharacterLoRA"] = "Nougan Regional Character LoRA 👥"
    NODE_DISPLAY_NAME_MAPPINGS["Krea2RegionalCharacterLoRA"] = "Nougan Regional Character LoRA 👥"
    NODE_DISPLAY_NAME_MAPPINGS["RegionalCharacterLora"] = "Nougan Regional Character LoRA 👥"
    print("[Nougan] ✅ Regional Character LoRA loaded.")
except Exception as _e:
    print(f"[Nougan] ⚠️  Regional Character LoRA NOT loaded ({type(_e).__name__}: {_e})")
    traceback.print_exc()

# ── Optional: Prompt Relay ──────────────────────────────────────────────────
try:
    from .prompt_relay import (
        PromptRelayEncode,
        PromptRelayEncodeTimeline,
        PromptRelayAdvancedOptions,
    )
    NODE_CLASS_MAPPINGS.update({
        "PromptRelayEncode": PromptRelayEncode,
        "PromptRelayEncodeTimeline": PromptRelayEncodeTimeline,
        "PromptRelayAdvancedOptions": PromptRelayAdvancedOptions,
    })
    NODE_DISPLAY_NAME_MAPPINGS.update({
        "PromptRelayEncode": "Nougan Prompt Relay Encode 🎬",
        "PromptRelayEncodeTimeline": "Nougan Prompt Relay Timeline 🎞️",
        "PromptRelayAdvancedOptions": "Nougan Prompt Relay Options ⚙️",
    })
    print("[Nougan] ✅ Prompt Relay loaded (3 nodes).")
except Exception as _e:
    print(f"[Nougan] ⚠️  Prompt Relay NOT loaded ({type(_e).__name__}: {_e})")
    traceback.print_exc()

# ── Optional: LM Studio Bridge ──────────────────────────────────────────────
try:
    from .lm_studio import NouganLMStudio, NouganLMStudioPromptBox
    NODE_CLASS_MAPPINGS.update({
        "NouganLMStudio": NouganLMStudio,
        "NouganLMStudioPromptBox": NouganLMStudioPromptBox,
    })
    NODE_DISPLAY_NAME_MAPPINGS.update({
        "NouganLMStudio": "Nougan LM Studio 🧠",
        "NouganLMStudioPromptBox": "Nougan LM Studio Prompt Box 💬",
    })
    print("[Nougan] ✅ LM Studio Bridge loaded (2 nodes).")
except Exception as _e:
    print(f"[Nougan] ⚠️  LM Studio Bridge NOT loaded ({type(_e).__name__}: {_e})")
    traceback.print_exc()

# ── Routes — always attempted, fully guarded ────────────────────────────────
_NOUGAN_ROUTES_REGISTERED = False

def _register_routes():
    global _NOUGAN_ROUTES_REGISTERED
    if _NOUGAN_ROUTES_REGISTERED:
        return
    try:
        from server import PromptServer
        from aiohttp import web
    except Exception:
        return
    try:
        routes = PromptServer.instance.routes
    except Exception:
        return
    try:
        @routes.get("/nougan/krea2_loras")
        async def _krea2_loras(_request):
            try:
                return web.json_response({"loras": get_krea2_lora_status()})
            except Exception:
                return web.json_response({"loras": []})

        @routes.get("/nougan/loras")
        async def _nougan_loras(_request):
            try:
                import folder_paths as _fp
                names = [str(x).replace(os.sep, "/") for x in _fp.get_filename_list("loras")]
            except Exception:
                names = []
            return web.json_response(names)

        _NOUGAN_ROUTES_REGISTERED = True
        print("[Nougan] ✅ Routes registered.")
    except Exception as _e:
        print(f"[Nougan] ⚠️  Could not register routes: {_e}")

_register_routes()

print(f"[Nougan] ── total nodes registered: {len(NODE_CLASS_MAPPINGS)} ──")

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]