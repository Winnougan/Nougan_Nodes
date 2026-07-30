# nougan_set_get.py
import threading

_NOUGAN_REMOTE_STATE = {}
_STATE_LOCK = threading.Lock()

EPIC_COLORS = [
    "Default", "Void", "Neon", "Plasma", "Toxic", 
    "Flare", "Blood", "Quantum", "Gold", 
    "Abyss", "Ghost", "Rose", "Matrix", "Nebula"
]

class NouganSet:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "key": ("STRING", {"default": "lora", "multiline": False}),
                "value": ("*", {}),
                "color": (EPIC_COLORS, {"default": "Default"}),
            },
            "hidden": {"unique_id": "UNIQUE_ID"}
        }

    RETURN_TYPES = ("*",)
    RETURN_NAMES = ("pass_through",)
    FUNCTION = "store_value"
    CATEGORY = "Nougan/Data"
    OUTPUT_NODE = False

    def store_value(self, key, value, color, unique_id=None):
        with _STATE_LOCK:
            _NOUGAN_REMOTE_STATE[key] = {
                "value": value,
                "color": color,
                "node_id": unique_id
            }
        return (value,)

class NouganGet:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "key": (["select a key..."], {}),
            }
        }

    RETURN_TYPES = ("*",)
    RETURN_NAMES = ("value",)
    FUNCTION = "retrieve_value"
    CATEGORY = "Nougan/Data"
    OUTPUT_NODE = False

    def retrieve_value(self, key):
        with _STATE_LOCK:
            if key not in _NOUGAN_REMOTE_STATE or key == "select a key...":
                raise ValueError(f"[Nougan Get] Key '{key}' not found or not selected.")
            data = _NOUGAN_REMOTE_STATE[key]
            return (data["value"],)