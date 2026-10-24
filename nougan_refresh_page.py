# nougan_refresh_page.py  -  Nougan Refresh Page by Winnougan
#
# Pass-through node (any in -> any out) that frees VRAM / caches every time it executes, plus a
# live WebGPU VRAM gauge and Reload / Refresh / Clean-now buttons (see web/nougan_refresh_page.js).
#
#   clean_vram       unload every model from the GPU, then release the CUDA allocator cache
#   clear_cache      Python gc + release the CUDA allocator cache (models stay loaded)
#   clear_node_cache also drop ComfyUI's cached node outputs once the run finishes (slows re-runs)
#   kitchen_backend  comfy-kitchen kernel backend preference (cuda / triton / eager / auto)
#
# Wire it INLINE where you want the clear to happen (e.g. after VAE Decode, or between sampler
# stages). Putting it on the MODEL line right before a sampler would unload the model it just
# passed, and ComfyUI would have to reload it.

import gc
import time


class AnyType(str):
    """Wildcard type: compares equal to every other type, so it links to anything."""

    def __ne__(self, other):
        return False


ANY = AnyType("*")

KITCHEN_CHOICES = ["leave as is", "auto", "cuda", "triton", "eager"]
_DEFAULT_PRIORITY = ["ascend", "cuda", "triton", "eager"]  # comfy_kitchen's own default order
_orig_priority = None


# ----------------------------------------------------------------------------- helpers
def _mm():
    try:
        import comfy.model_management as mm

        return mm
    except Exception:
        return None


def _device_mem():
    """(free_bytes, total_bytes, device_name). Zeros when the device is not CUDA."""
    try:
        import torch

        mm = _mm()
        dev = mm.get_torch_device() if mm else torch.device("cuda")
        if getattr(dev, "type", "cpu") != "cuda":
            return 0, 0, str(dev)
        free, total = torch.cuda.mem_get_info(dev)
        return int(free), int(total), torch.cuda.get_device_name(dev)
    except Exception:
        return 0, 0, "n/a"


def _ck():
    try:
        import comfy_kitchen as ck

        return ck
    except Exception:
        return None


def kitchen_state():
    """Backend availability and the current priority order, for the UI."""
    ck = _ck()
    if ck is None:
        return {"installed": False, "priority": [], "backends": {}}
    try:
        reg = getattr(ck, "registry", None)
        priority = list(getattr(reg, "_priority", _DEFAULT_PRIORITY))
        backends = {
            name: bool(info.get("available")) and not info.get("disabled")
            for name, info in ck.list_backends().items()
        }
        return {"installed": True, "priority": priority, "backends": backends}
    except Exception as exc:
        return {"installed": True, "priority": [], "backends": {}, "error": str(exc)}


def apply_kitchen(choice):
    """Set comfy-kitchen's backend preference. Returns a short status string, or None."""
    global _orig_priority
    if choice in (None, "leave as is"):
        return None
    ck = _ck()
    if ck is None:
        return "kitchen: comfy_kitchen not installed"
    try:
        reg = getattr(ck, "registry", None)
        if _orig_priority is None:  # remember the original order so "auto" can restore it
            _orig_priority = list(getattr(reg, "_priority", _DEFAULT_PRIORITY))
        if choice == "auto":
            ck.set_backend_priority(_orig_priority)
            return "kitchen: auto (" + " > ".join(_orig_priority) + ")"
        info = ck.list_backends().get(choice)
        if not info or not info.get("available"):
            why = (info or {}).get("unavailable_reason") or "not registered"
            return f"kitchen: {choice} unavailable ({why})"
        ck.enable_backend(choice)
        # Preferred backend first; the rest stay as fallbacks so unsupported calls still work.
        ck.set_backend_priority([choice] + [b for b in _orig_priority if b != choice])
        return f"kitchen: {choice} first"
    except Exception as exc:
        return f"kitchen: failed ({exc})"


def do_clean(clean_vram, clear_cache, clear_node_cache, kitchen_backend="leave as is"):
    """Free what was asked for and return stats for the UI."""
    t0 = time.perf_counter()
    free_before, total, device = _device_mem()
    notes = []
    mm = _mm()

    if clean_vram and mm:
        mm.unload_all_models()
        notes.append("models unloaded")
    if clean_vram or clear_cache:
        gc.collect()
        if mm:
            mm.soft_empty_cache(True)
        else:
            try:
                import torch

                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            except Exception:
                pass
        notes.append("cache cleared")
    if clear_node_cache:
        try:
            from server import PromptServer

            PromptServer.instance.prompt_queue.set_flag("free_memory", True)
            notes.append("node cache drops after run")
        except Exception:
            notes.append("node cache: server not available")

    kitchen_note = apply_kitchen(kitchen_backend)
    if kitchen_note:
        notes.append(kitchen_note)

    free_after, _, _ = _device_mem()
    return {
        "device": device,
        "total": total,
        "free_before": free_before,
        "free_after": free_after,
        "freed": max(0, free_after - free_before),
        "ms": round((time.perf_counter() - t0) * 1000),
        "notes": notes,
    }


def vram_state():
    free, total, device = _device_mem()
    return {
        "device": device,
        "total": total,
        "free": free,
        "used": max(0, total - free),
        "kitchen": kitchen_state(),
    }


def _queue_busy():
    try:
        from server import PromptServer

        running, _pending = PromptServer.instance.prompt_queue.get_current_queue_volatile()
        return len(running) > 0
    except Exception:
        return False


# ----------------------------------------------------------------------------- HTTP routes
def _register_routes():
    try:
        from aiohttp import web
        from server import PromptServer

        routes = PromptServer.instance.routes
    except Exception:
        return  # not running inside ComfyUI (tests, import checks)

    @routes.get("/nougan/vram")
    async def nougan_vram(request):
        return web.json_response(vram_state())

    @routes.post("/nougan/clean")
    async def nougan_clean(request):
        try:
            body = await request.json()
        except Exception:
            body = {}
        if _queue_busy():
            return web.json_response({"error": "busy"}, status=409)
        stats = do_clean(
            bool(body.get("vram", True)),
            bool(body.get("cache", True)),
            bool(body.get("node_cache", False)),
            body.get("kitchen", "leave as is"),
        )
        return web.json_response(stats)


try:
    _register_routes()
except Exception as _exc:  # e.g. routes already registered by a second import
    print(f"[Nougan] refresh-page routes not registered: {_exc}")


# ----------------------------------------------------------------------------- the node
class NouganRefreshPage:
    CATEGORY = "Nougan"
    FUNCTION = "run"
    OUTPUT_NODE = True  # runs every time the graph runs, even if nothing is wired to its output
    RETURN_TYPES = (ANY,)
    RETURN_NAMES = ("anything",)
    DESCRIPTION = (
        "Pass-through. Frees VRAM / caches each time it runs. Wire it inline after a heavy stage."
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "clean_vram": ("BOOLEAN", {
                    "default": True,
                    "tooltip": "Unload all models from the GPU and release the CUDA cache.",
                }),
                "clear_cache": ("BOOLEAN", {
                    "default": True,
                    "tooltip": "Python gc + release the CUDA allocator cache (models stay loaded).",
                }),
                "clear_node_cache": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "Also drop ComfyUI's cached node outputs after the run. "
                               "Frees RAM but makes repeat runs recompute everything.",
                }),
                "kitchen_backend": (KITCHEN_CHOICES, {
                    "default": "leave as is",
                    "tooltip": "comfy-kitchen kernel backend to prefer. Others stay as fallbacks.",
                }),
            },
            "optional": {
                "anything": (ANY, {"tooltip": "Passed straight through to the output."}),
            },
        }

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")  # never cached: always execute

    def run(self, clean_vram, clear_cache, clear_node_cache, kitchen_backend, anything=None):
        stats = do_clean(clean_vram, clear_cache, clear_node_cache, kitchen_backend)
        return {"ui": {"nougan_vram": [stats]}, "result": (anything,)}


NODE_CLASS_MAPPINGS = {"NouganRefreshPage": NouganRefreshPage}
NODE_DISPLAY_NAME_MAPPINGS = {"NouganRefreshPage": "Nougan Refresh Page 🔄"}
