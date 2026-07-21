# __init__.py
from .diffusers_loader import (
    NouganDiffusersLoader,
)
from .get_image import (
    NouganGetImage,
)

WEB_DIRECTORY = "./web"

NODE_CLASS_MAPPINGS = {
    "NouganDiffusersLoader": NouganDiffusersLoader,
    "NouganGetImage":        NouganGetImage,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "NouganDiffusersLoader": "Nougan Diffusers Loader 🚀",
    "NouganGetImage":        "Nougan Get Image 🖼️",
}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]