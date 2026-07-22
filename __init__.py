# __init__.py
import os
from .diffusers_loader    import NouganDiffusersLoader
from .get_image           import NouganGetImage
from .krea2_loader        import NouganKrea2Loader, get_krea2_lora_status
from .text_encode         import NouganTextEncodeZeroNeg
from .text_box            import NouganTextBox
from .title_font          import NouganTitleFont

WEB_DIRECTORY = "./web"

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

# Lora Loader (from-scratch build): wrapped so it can NEVER take down the six
# core nodes above. Only the two classes that exist are imported/registered.
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