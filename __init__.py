# __init__.py
from .diffusers_loader import NouganDiffusersLoader
from .get_image        import NouganGetImage
from .krea2_loader     import NouganKrea2Loader, get_krea2_lora_status

WEB_DIRECTORY = "./web"

NODE_CLASS_MAPPINGS = {
    "NouganDiffusersLoader": NouganDiffusersLoader,
    "NouganGetImage":        NouganGetImage,
    "NouganKrea2Loader":     NouganKrea2Loader,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "NouganDiffusersLoader": "Nougan Diffusers Loader 🚀",
    "NouganGetImage":        "Nougan Get Image 🖼️",
    "NouganKrea2Loader":     "Nougan Krea 2 · Uncensored 🌀",
}


def _register_routes():
    try:
        from server import PromptServer
        from aiohttp import web
    except Exception:
        return

    @PromptServer.instance.routes.get("/nougan/krea2_loras")
    async def _krea2_loras(_request):
        return web.json_response({"loras": get_krea2_lora_status()})


_register_routes()

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]