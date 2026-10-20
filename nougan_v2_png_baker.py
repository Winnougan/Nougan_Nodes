"""
Nougan V2 PNG Baker
-------------------
Bakes a Character Card V2 JSON (the format used by SillyTavern, Chub, RisuAI,
Agnai, ...) into a PNG so the image *is* the character card.

Format (verified against a real V2 card):
    PNG tEXt chunk, keyword  "chara"
    value = base64( UTF-8 JSON )
    JSON  = {"spec": "chara_card_v2", "spec_version": "2.0", "data": {...}}

Wire it like this:
    Load Image ──► image
    String (Multiline) ──► json_text      (paste the card JSON in that node)
"""
import base64
import json
import os
import re

import numpy as np
from PIL import Image
from PIL.PngImagePlugin import PngInfo

import folder_paths

SPEC = "chara_card_v2"
SPEC_VERSION = "2.0"
CHUNK_KEY = "chara"

# Fields every V2 `data` object is expected to carry (missing ones get these).
V2_DEFAULTS = {
    "name": "",
    "description": "",
    "personality": "",
    "scenario": "",
    "first_mes": "",
    "mes_example": "",
    "creator_notes": "",
    "system_prompt": "",
    "post_history_instructions": "",
    "alternate_greetings": [],
    "tags": [],
    "creator": "",
    "character_version": "",
    "extensions": {},
}
STRING_FIELDS = (
    "name", "description", "personality", "scenario", "first_mes", "mes_example",
    "creator_notes", "system_prompt", "post_history_instructions", "creator",
    "character_version",
)


# ─────────────────────────────────────────────────────────── JSON handling ──

def _strip_wrappers(text: str) -> str:
    """Tolerate what people actually paste: BOM, whitespace, ```json fences."""
    t = text.lstrip("\ufeff").strip()
    m = re.match(r"^```[a-zA-Z0-9_-]*\s*\n?(.*?)\n?```$", t, re.DOTALL)
    return m.group(1).strip() if m else t


def _parse_json(text: str):
    cleaned = _strip_wrappers(text or "")
    if not cleaned:
        raise ValueError("[V2 PNG Baker] json_text is empty. Paste your character card JSON into the string node.")
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError as e:
        lines = cleaned.splitlines()
        line = lines[e.lineno - 1] if 0 < e.lineno <= len(lines) else ""
        start = max(0, e.colno - 40)
        snippet = line[start:e.colno + 20]
        raise ValueError(
            f"[V2 PNG Baker] Invalid JSON: {e.msg} (line {e.lineno}, column {e.colno}).\n"
            f"Near: ...{snippet}..."
        ) from None


LEGACY_KEYS = {
    "char_name": "name", "char_persona": "description",
    "world_scenario": "scenario", "char_greeting": "first_mes",
    "example_dialogue": "mes_example",
}
CARD_HINTS = ("name", "description", "first_mes", "personality")
WRAPPER_KEYS = ("character", "card", "char", "result", "output", "json")


def _lower_keys(d: dict) -> dict:
    return {(k.lower() if isinstance(k, str) else k): v for k, v in d.items()}


def _coerce(obj, notes):
    """Peel off common wrappers: double-encoding, 1-item lists, {"character": {...}}, odd key casing."""
    for _ in range(5):
        if isinstance(obj, str):
            try:
                obj = json.loads(_strip_wrappers(obj))
                notes.append("Unwrapped a JSON string that contained JSON (double-encoded).")
                continue
            except json.JSONDecodeError:
                return obj
        if isinstance(obj, list) and len(obj) == 1:
            obj = obj[0]
            notes.append("Unwrapped a single-item list.")
            continue
        if not isinstance(obj, dict):
            return obj

        obj = _lower_keys(obj)
        if isinstance(obj.get("data"), str):
            try:
                obj["data"] = json.loads(_strip_wrappers(obj["data"]))
                notes.append("'data' was a JSON string; parsed it.")
            except json.JSONDecodeError:
                pass
        if isinstance(obj.get("data"), dict):
            obj["data"] = _lower_keys(obj["data"])
            return obj

        if any(k in obj for k in CARD_HINTS):
            return obj
        if any(k in obj for k in LEGACY_KEYS):
            obj = {LEGACY_KEYS.get(k, k): v for k, v in obj.items()}
            notes.append("Converted legacy TavernAI keys (char_name, char_persona, ...).")
            return obj

        inner = next((obj[k] for k in WRAPPER_KEYS if isinstance(obj.get(k), (dict, str))), None)
        if inner is None and len(obj) == 1:
            inner = next(iter(obj.values()))
        if isinstance(inner, (dict, str, list)):
            obj = inner
            notes.append("Unwrapped a nested card object.")
            continue
        return obj
    return obj


def normalize_card(obj, fill_missing: bool = True):
    """
    Returns (card_dict, notes). Accepts:
      * a full V2 card              {"spec": "chara_card_v2", "data": {...}}
      * a V3 card                   relabelled to V2 (data is a superset, kept as-is)
      * just the data object        {"name": ..., "description": ...}  (V1 / bare)
    Unknown keys (e.g. "avatar", "character_book", extensions) are preserved untouched.
    """
    notes = []
    obj = _coerce(obj, notes)
    if not isinstance(obj, dict):
        raise ValueError("[V2 PNG Baker] The JSON must be an object ({...}), not a list or a bare value.")

    if isinstance(obj.get("data"), dict):
        spec = obj.get("spec")
        if spec == "chara_card_v3":
            notes.append("V3 card relabelled as V2 (V3-only fields are kept in data but older apps ignore them).")
        elif spec not in (None, SPEC):
            notes.append(f"Unknown spec {spec!r} replaced with {SPEC!r}.")
        card = {"spec": SPEC, "spec_version": SPEC_VERSION, "data": dict(obj["data"])}
        for k, v in obj.items():           # keep any extra top-level keys
            if k not in card and k not in ("spec", "spec_version", "data"):
                card[k] = v
    elif "name" in obj or any(k in obj for k in ("description", "first_mes", "personality")):
        notes.append("No 'data' wrapper found: wrapped your fields into a V2 card.")
        card = {"spec": SPEC, "spec_version": SPEC_VERSION, "data": dict(obj)}
    else:
        got = sorted(map(str, obj.keys()))[:12]
        raise ValueError(
            "[V2 PNG Baker] This doesn't look like a character card: expected a 'data' object "
            "(V2) or fields like 'name' / 'description' / 'first_mes'. "
            f"Top-level keys received: {got}"
        )

    data = card["data"]
    if fill_missing:
        for k, default in V2_DEFAULTS.items():
            if data.get(k) is None:
                data[k] = json.loads(json.dumps(default))  # fresh copy of list/dict defaults
    # light type repair so frontends don't choke
    for k in STRING_FIELDS:
        if k in data and not isinstance(data[k], str):
            data[k] = "" if data[k] is None else str(data[k])
    if isinstance(data.get("tags"), str):
        data["tags"] = [t.strip() for t in data["tags"].split(",") if t.strip()]
    if isinstance(data.get("alternate_greetings"), str):
        data["alternate_greetings"] = [data["alternate_greetings"]]
    if "extensions" in data and not isinstance(data["extensions"], dict):
        data["extensions"] = {}

    if not str(data.get("name", "")).strip():
        raise ValueError("[V2 PNG Baker] The card has no 'name'. V2 cards require data.name.")
    return card, notes


def encode_card(card: dict) -> str:
    # same serialization as real cards: default separators, real UTF-8 (not \uXXXX)
    return base64.b64encode(json.dumps(card, ensure_ascii=False).encode("utf-8")).decode("ascii")


def decode_card(b64: str) -> dict:
    return json.loads(base64.b64decode(b64).decode("utf-8"))



# ───────────────────────────────────────────────── info for the front-end card ──

def _book_entries(data: dict):
    book = data.get("character_book")
    if isinstance(book, dict) and isinstance(book.get("entries"), list):
        return book["entries"]
    return []


def _rarity_for(tokens: int) -> str:
    # Just for fun (drives the card's foil colour). Based on estimated token count.
    if tokens < 600:
        return "common"
    if tokens < 1800:
        return "rare"
    if tokens < 3500:
        return "epic"
    return "legendary"


def _excerpt(text: str, n: int = 380) -> str:
    t = " ".join(str(text).split())
    return t if len(t) <= n else t[: n - 1].rstrip() + "…"


def _card_info(card: dict, b64: str, notes) -> dict:
    d = card["data"]
    entries = _book_entries(d)
    text_chars = sum(len(str(d.get(k, ""))) for k in STRING_FIELDS)
    text_chars += sum(len(str(g)) for g in (d.get("alternate_greetings") or []))
    text_chars += sum(len(str(e.get("content", ""))) for e in entries if isinstance(e, dict))
    tokens = max(1, round(text_chars / 4))  # rough: ~4 chars per token
    return {
        "name": str(d.get("name", "")).strip(),
        "creator": str(d.get("creator", "")).strip(),
        "tags": [str(t) for t in (d.get("tags") or [])][:10],
        "spec_version": card.get("spec_version", SPEC_VERSION),
        "chars": {
            "description": len(str(d.get("description", ""))),
            "first_mes": len(str(d.get("first_mes", ""))),
            "mes_example": len(str(d.get("mes_example", ""))),
        },
        "alt_greetings": len(d.get("alternate_greetings") or []),
        "book_entries": len(entries),
        "tokens": tokens,
        "kb": round(len(b64) / 1024, 1),
        "rarity": _rarity_for(tokens),
        "excerpt_description": _excerpt(d.get("description", "")),
        "excerpt_first_mes": _excerpt(d.get("first_mes", "")),
        "notes": list(notes),
    }


# ─────────────────────────────────────────────────────────────── the node ──

def _safe_name(name: str) -> str:
    s = re.sub(r'[\\/:*?"<>|%\x00-\x1f]', "_", name).strip(" .")
    return s[:80] or "card"


def _tensor_to_pil(img) -> Image.Image:
    arr = np.clip(255.0 * img.cpu().numpy(), 0, 255).astype(np.uint8)
    if arr.ndim == 3 and arr.shape[-1] == 1:
        arr = arr[..., 0]
    return Image.fromarray(arr)


class NouganV2PNGBaker:
    CATEGORY = "image/cards"
    FUNCTION = "bake"
    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("saved_path", "character_name")
    OUTPUT_NODE = True

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                # forceInput -> plain socket, fed by ComfyUI's native String (Multiline) node
                "json_text": ("STRING", {"forceInput": True, "multiline": True}),
                "filename_prefix": ("STRING", {
                    "default": "V2_cards/%name%",
                    "tooltip": "%name% is replaced by the character's name. Saved in the ComfyUI output folder.",
                }),
                "fill_missing_fields": ("BOOLEAN", {
                    "default": True,
                    "label_on": "fill missing V2 fields",
                    "label_off": "keep JSON exactly as pasted",
                }),
            }
        }

    def bake(self, image, json_text, filename_prefix, fill_missing_fields=True):
        obj = _parse_json(json_text)
        card, notes = normalize_card(obj, fill_missing_fields)
        for n in notes:
            print(f"[V2 PNG Baker] ℹ️  {n}")

        name = str(card["data"]["name"]).strip()
        b64 = encode_card(card)

        meta = PngInfo()
        meta.add_text(CHUNK_KEY, b64)  # tEXt (ASCII), same as real cards. No ComfyUI workflow is embedded.

        prefix = filename_prefix.replace("%name%", _safe_name(name))
        out_dir = folder_paths.get_output_directory()
        first = image[0]
        h, w = int(first.shape[0]), int(first.shape[1])
        full_folder, fname, counter, subfolder, _ = folder_paths.get_save_image_path(prefix, out_dir, w, h)
        os.makedirs(full_folder, exist_ok=True)

        saved, previews = [], []
        for img in image:
            file = f"{fname}_{counter:05}_.png"
            path = os.path.join(full_folder, file)
            _tensor_to_pil(img).save(path, format="PNG", pnginfo=meta, compress_level=4)

            # read it back from disk: never report success on a card that can't be loaded
            with Image.open(path) as chk:
                got = chk.info.get(CHUNK_KEY) or getattr(chk, "text", {}).get(CHUNK_KEY)
            if not got or decode_card(got) != card:
                raise RuntimeError(f"[V2 PNG Baker] Verification failed for {path}: card did not round-trip.")

            print(f"[V2 PNG Baker] ✅ Baked '{name}' ({len(b64) // 1024} KB card data) -> {path}")
            saved.append(path)
            previews.append({"filename": file, "subfolder": subfolder, "type": "output"})
            counter += 1

        ui = {"card_preview": previews, "card_info": [_card_info(card, b64, notes)]}
        return {"ui": ui, "result": ("\n".join(saved), name)}


NODE_CLASS_MAPPINGS = {"NouganV2PNGBaker": NouganV2PNGBaker}
NODE_DISPLAY_NAME_MAPPINGS = {"NouganV2PNGBaker": "Nougan V2 PNG Baker 🃏"}
