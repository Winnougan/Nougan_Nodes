"""
Nougan Refmod Baker
-------------------
Bakes a Character Card V2 JSON, an optional system prompt and an avatar image into a
.safetensors "refmod" so the Nougan Character Chat node can load the character from it.

Two modes (set by `base_refmod`):
    * (none)            -> character-only file: no tensors, ~20-50 KB. Chat can use it; a video
                           model cannot use it as a reference.
    * an existing refmod -> hybrid file: a copy of that refmod with the character added to its
                           header. Tensors are copied byte-for-byte and verified; the original
                           file is never modified.

Wire it like this:
    Load Image ──► image                  (avatar, also the character's face in chat)
    String (Multiline) ──► json_text      (paste the card JSON)
    String (Multiline) ──► system_prompt  (optional)
"""
import base64
import os
import uuid

from .nougan_v2_png_baker import _parse_json, normalize_card, _safe_name, _tensor_to_pil, _card_info
from .nougan_refmod_io import (
    META_CARD, NONE_BASE, avatar_to_b64, character_metadata, list_refmods, read_character,
    resolve_refmod, write_with_metadata,
)

import folder_paths


def _write_preview(avatar_b64: str, name: str) -> dict:
    """The stored avatar, written to ComfyUI's temp folder so the node's card preview can show it."""
    folder = folder_paths.get_temp_directory()
    os.makedirs(folder, exist_ok=True)
    fname = f"nougan_refmod_{_safe_name(name)}_{uuid.uuid4().hex[:8]}.png"
    with open(os.path.join(folder, fname), "wb") as f:
        f.write(base64.b64decode(avatar_b64))
    return {"filename": fname, "subfolder": "", "type": "temp"}


def _output_path(prefix: str, name: str) -> str:
    """ComfyUI-style numbered file in the output folder: <prefix>_00001_.safetensors"""
    prefix = prefix.replace("%name%", _safe_name(name))
    parts = [p for p in prefix.replace("\\", "/").split("/") if p not in ("", ".", "..")]
    parts = [_safe_name(p) for p in parts] or [_safe_name(name)]
    folder = os.path.join(folder_paths.get_output_directory(), *parts[:-1])
    os.makedirs(folder, exist_ok=True)
    counter = 1
    while True:
        path = os.path.join(folder, f"{parts[-1]}_{counter:05}_.safetensors")
        if not os.path.exists(path):
            return path
        counter += 1


class NouganRefmodBaker:
    CATEGORY = "Nougan"
    FUNCTION = "bake"
    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("saved_path", "character_name")
    OUTPUT_NODE = True
    DESCRIPTION = ("Bake a character (card JSON + system prompt + avatar) into a .safetensors refmod. "
                   "Pick a base refmod to embed it into a copy of that file, or leave it on none for a character-only file.")

    @classmethod
    def INPUT_TYPES(cls):
        bases = [NONE_BASE] + list_refmods()
        return {
            "required": {
                "image": ("IMAGE", {"tooltip": "Avatar. Only the first image of a batch is used."}),
                "json_text": ("STRING", {"forceInput": True, "multiline": True}),
                "filename_prefix": ("STRING", {
                    "default": "Refmods/%name%",
                    "tooltip": "%name% is replaced by the character's name. Saved in the ComfyUI output folder.",
                }),
                "base_refmod": (bases, {
                    "default": NONE_BASE,
                    "tooltip": "Existing refmod to copy and embed the character into. The original is never modified.",
                }),
                "avatar_max_size": ("INT", {
                    "default": 512, "min": 64, "max": 2048, "step": 16,
                    "tooltip": "Avatar is downscaled so its longest side is at most this. Keep it small: it is stored in the file header.",
                }),
                "fill_missing_fields": ("BOOLEAN", {
                    "default": True,
                    "label_on": "fill missing V2 fields",
                    "label_off": "keep JSON exactly as pasted",
                }),
            },
            "optional": {
                # sockets/paths last: widget values are saved by position
                "system_prompt": ("STRING", {"forceInput": True, "multiline": True,
                                             "tooltip": "Optional. Stored in the file and used by the chat node instead of the card's own system prompt."}),
                "base_refmod_path": ("STRING", {"default": "", "multiline": False,
                                                "tooltip": "Optional full path to a refmod anywhere on disk. Overrides the dropdown."}),
            },
        }

    def bake(self, image, json_text, filename_prefix, base_refmod, avatar_max_size, fill_missing_fields=True,
             system_prompt="", base_refmod_path=""):
        card, notes = normalize_card(_parse_json(json_text), fill_missing_fields)
        for n in notes:
            print(f"[Refmod Baker] ℹ️  {n}")
        name = str(card["data"]["name"]).strip()

        # which file to embed into (if any)
        src = None
        path_in = (base_refmod_path or "").strip().strip('"')
        if path_in and path_in.lower() not in ("none", "null", "undefined"):
            if not os.path.isfile(path_in):
                raise ValueError(f"[Refmod Baker] base_refmod_path not found: {path_in!r}")
            src = path_in
        elif base_refmod and base_refmod != NONE_BASE:
            src = resolve_refmod(base_refmod)

        avatar_b64 = avatar_to_b64(_tensor_to_pil(image[0]), int(avatar_max_size))
        meta = character_metadata(card, system_prompt or "", avatar_b64)
        dst = _output_path(filename_prefix, name)

        report = write_with_metadata(dst, meta, src)

        # final check: the character reads back exactly as written
        back = read_character(dst)
        if back["card"] != card or back["avatar_b64"] != avatar_b64 or \
                back["system_prompt"] != ((system_prompt or "") if (system_prompt or "").strip() else ""):
            raise RuntimeError(f"[Refmod Baker] Verification failed for {dst}: character did not round-trip.")

        if report["had_character"]:
            print("[Refmod Baker] ℹ️  The base refmod already had a character; the copy has the new one.")
        kind = (f"hybrid: {report['tensors']} tensors copied unchanged from {os.path.basename(src)}"
                if src else "character-only")
        print(f"[Refmod Baker] ✅ Baked '{name}' ({kind}) -> {dst}")

        # data for the node's card preview (web/nougan_v2_png_baker.js handles both baker nodes)
        info = _card_info(card, meta[META_CARD], notes)
        info["refmod"] = {
            "kind": "hybrid" if src else "character-only",
            "tensors": report["tensors"],
            "bytes": os.path.getsize(dst),
            "saved": os.path.relpath(dst, folder_paths.get_output_directory()).replace(os.sep, "/"),
            "base": os.path.basename(src) if src else "",
        }
        ui = {"card_preview": [_write_preview(avatar_b64, name)], "card_info": [info]}
        return {"ui": ui, "result": (dst, name)}


NODE_CLASS_MAPPINGS = {"NouganRefmodBaker": NouganRefmodBaker}
NODE_DISPLAY_NAME_MAPPINGS = {"NouganRefmodBaker": "Nougan Refmod Baker 🧬"}
