"""
Nougan Timer - backend.

Counts how many times it has executed (one tick per generated item), tells the
frontend about it, and keeps a small per-node run record so a browser reload
can pick a running batch back up.

Merge NODE_CLASS_MAPPINGS / NODE_DISPLAY_NAME_MAPPINGS into your pack's __init__.py.
"""

import time

from aiohttp import web
from server import PromptServer


class _AnyType(str):
    """Compares equal to every socket type so `trigger` can be wired to anything."""

    def __ne__(self, other):
        return False


ANY = _AnyType("*")

MAX_STAMPS = 64
_RUNS = {}  # unique_id (str) -> run dict


def _new_run(total, now):
    return {
        "active": True,
        "completed": 0,
        "total": total,
        "started_at": now,
        "stamps": [],
    }


@PromptServer.instance.routes.get("/nougan_timer/state")
async def nougan_timer_state(request):
    snapshot = {k: dict(v, stamps=list(v["stamps"])) for k, v in list(_RUNS.items())}
    return web.json_response({"now": time.time(), "runs": snapshot})


@PromptServer.instance.routes.post("/nougan_timer/reset")
async def nougan_timer_reset(request):
    try:
        body = await request.json()
    except Exception:
        body = {}
    node_id = body.get("node_id") if isinstance(body, dict) else None
    if node_id is None:
        _RUNS.clear()
    else:
        _RUNS.pop(str(node_id), None)
    return web.json_response({"status": "ok"})


class NouganTimer:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "total_images": (
                    "INT",
                    {
                        "default": 1,
                        "min": 1,
                        "max": 999999,
                        "tooltip": "How many items the whole batch will produce (= your queue / batch count).",
                    },
                ),
            },
            "optional": {
                "trigger": (
                    ANY,
                    {
                        "tooltip": "Wire anything from the end of your workflow (saved image, etc.) "
                        "so the timer ticks after that step has finished."
                    },
                ),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = ()
    FUNCTION = "tick"
    CATEGORY = "Nougan/Utils"
    OUTPUT_NODE = True
    DESCRIPTION = "Batch stopwatch with progress, per-item average, ETA and finish time."

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        # Always re-run, never let the cache swallow a tick.
        return float("nan")

    @classmethod
    def VALIDATE_INPUTS(cls, input_types):
        # `trigger` is a wildcard socket; skip the type check.
        return True

    def tick(self, total_images, trigger=None, unique_id=None):
        key = str(unique_id)
        now = time.time()

        run = _RUNS.get(key)
        if run is None or not run["active"] or run["total"] != total_images:
            run = _new_run(total_images, now)
            _RUNS[key] = run

        run["completed"] += 1
        run["stamps"].append(now)
        del run["stamps"][:-MAX_STAMPS]
        if run["completed"] >= run["total"]:
            run["active"] = False

        PromptServer.instance.send_sync(
            "nougan_timer_update",
            {
                "node_id": key,
                "current": run["completed"],
                "total": run["total"],
                "started_at": run["started_at"],
                "now": now,
            },
        )
        return ()


NODE_CLASS_MAPPINGS = {"NouganTimer": NouganTimer}
NODE_DISPLAY_NAME_MAPPINGS = {"NouganTimer": "\U0001F33F Nougan Timer"}
