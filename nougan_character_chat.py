# nougan_character_chat.py -- Nougan Character Chat
#
# Chat with a character from a Character Card V2/V3 PNG (SillyTavern format: JSON in the PNG "chara"/"ccv3" text chunk)
# using the LLM you already load as CLIP (built and tested around Qwen3.5 via ComfyUI's text-generation API:
# clip.tokenize / clip.generate / clip.decode, exactly like the core "Generate Text" node).
#
# Cards live in  ComfyUI/input/characters/  (the node's upload button puts them there), or point `card_path` at any card.
# The chat history is kept by the node's UI (hidden `history_json` widget) and saved with the workflow.

import base64
import json
import os
import re
import struct
import zlib

import numpy as np
import torch
from PIL import Image

import folder_paths

CARD_DIR_NAME = "characters"
NONE_CHOICE = "(none - add cards to input/characters)"
CARD_EXTS = (".png", ".json")


# ---------------------------------------------------------------------------------------------------------------
# card reading
# ---------------------------------------------------------------------------------------------------------------
def _png_text_chunks(data: bytes) -> dict:
    """keyword -> text for every tEXt / zTXt / iTXt chunk."""
    out = {}
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        return out
    pos = 8
    while pos + 8 <= len(data):
        length, ctype = struct.unpack(">I4s", data[pos:pos + 8])
        body = data[pos + 8:pos + 8 + length]
        pos += 12 + length
        try:
            if ctype == b"tEXt":
                k, _, v = body.partition(b"\x00")
                out.setdefault(k.decode("latin-1"), v.decode("latin-1"))
            elif ctype == b"zTXt":
                k, _, rest = body.partition(b"\x00")
                out.setdefault(k.decode("latin-1"), zlib.decompress(rest[1:]).decode("utf-8", "replace"))
            elif ctype == b"iTXt":
                k, _, rest = body.partition(b"\x00")
                flag = rest[0]
                rest = rest[2:]
                _, _, rest = rest.partition(b"\x00")      # language tag
                _, _, text = rest.partition(b"\x00")      # translated keyword
                if flag:
                    text = zlib.decompress(text)
                out.setdefault(k.decode("latin-1"), text.decode("utf-8", "replace"))
            elif ctype == b"IEND":
                break
        except Exception:
            continue
    return out


def _decode_payload(text: str):
    text = text.strip()
    try:
        return json.loads(base64.b64decode(text, validate=False).decode("utf-8"))
    except Exception:
        pass
    try:
        return json.loads(text)
    except Exception:
        return None


def _norm_card(raw: dict) -> dict:
    """Any of V1 (flat) / V2 / V3 -> one flat dict with the fields we use."""
    d = raw.get("data") if isinstance(raw.get("data"), dict) else raw
    s = lambda k: str(d.get(k) or "")
    alts = d.get("alternate_greetings")
    book = d.get("character_book")
    return {
        "spec": str(raw.get("spec") or "chara_card_v1"),
        "name": s("name") or "Character",
        "description": s("description"),
        "personality": s("personality"),
        "scenario": s("scenario"),
        "first_mes": s("first_mes"),
        "mes_example": s("mes_example"),
        "system_prompt": s("system_prompt"),
        "post_history_instructions": s("post_history_instructions"),
        "creator_notes": s("creator_notes"),
        "creator": s("creator"),
        "tags": [str(t) for t in d.get("tags", [])] if isinstance(d.get("tags"), list) else [],
        "alternate_greetings": [str(a) for a in alts if a] if isinstance(alts, list) else [],
        "character_book": book if isinstance(book, dict) else None,
    }


def read_card(path: str) -> dict:
    """Parse a card file (.png with chara/ccv3 chunk, or .json). Raises ValueError with a readable message."""
    if not path or not os.path.isfile(path):
        raise ValueError(f"character card not found: {path!r}")
    ext = os.path.splitext(path)[1].lower()
    with open(path, "rb") as f:
        data = f.read()
    if ext == ".json":
        raw = _decode_payload(data.decode("utf-8", "replace"))
    else:
        chunks = _png_text_chunks(data)
        payload = chunks.get("ccv3") or chunks.get("chara")
        if payload is None:
            raise ValueError(f"{os.path.basename(path)} has no 'chara' / 'ccv3' text chunk - is it a character card PNG?")
        raw = _decode_payload(payload)
    if not isinstance(raw, dict):
        raise ValueError(f"couldn't read the card JSON in {os.path.basename(path)}")
    return _norm_card(raw)


def card_dir() -> str:
    return os.path.join(folder_paths.get_input_directory(), CARD_DIR_NAME)


def list_cards() -> list:
    base = card_dir()
    found = []
    if os.path.isdir(base):
        for root, _, files in os.walk(base):
            for fn in files:
                if fn.lower().endswith(CARD_EXTS):
                    found.append(os.path.relpath(os.path.join(root, fn), base).replace(os.sep, "/"))
    return sorted(found, key=str.lower)


def resolve_card_path(character: str, card_path: str = "") -> str:
    if card_path and card_path.strip():
        return card_path.strip().strip('"')
    if not character or character == NONE_CHOICE:
        raise ValueError("pick a character card (or set card_path)")
    full = os.path.normpath(os.path.join(card_dir(), character))
    if not full.startswith(os.path.normpath(card_dir())):
        raise ValueError("invalid character name")
    return full


def load_avatar(path: str) -> torch.Tensor:
    try:
        img = Image.open(path).convert("RGB")
    except Exception:
        img = Image.new("RGB", (256, 256), (30, 34, 44))
    return torch.from_numpy(np.array(img).astype(np.float32) / 255.0)[None, ...]


# ---------------------------------------------------------------------------------------------------------------
# prompt building
# ---------------------------------------------------------------------------------------------------------------
def subst(text: str, char: str, user: str) -> str:
    if not text:
        return ""
    text = re.sub(r"\{\{//.*?\}\}", "", text, flags=re.S)
    text = re.sub(r"\{\{\s*char\s*\}\}|<BOT>", char, text, flags=re.I)
    text = re.sub(r"\{\{\s*user\s*\}\}|<USER>", user, text, flags=re.I)
    return text.replace("{{original}}", "")


def _key_hit(key: str, haystack: str, case_sensitive: bool) -> bool:
    if not key:
        return False
    m = re.fullmatch(r"/(.+)/([a-z]*)", key)
    if m:                                       # regex key, SillyTavern style
        try:
            return re.search(m.group(1), haystack, 0 if case_sensitive or "i" not in m.group(2) else re.I) is not None
        except re.error:
            return False
    return (key in haystack) if case_sensitive else (key.lower() in haystack.lower())


def lore_for(card: dict, scan_text: str, budget_chars: int = 3500):
    """Triggered lorebook entries -> (before_char_texts, after_char_texts)."""
    book = card.get("character_book") or {}
    entries = [e for e in book.get("entries", []) if isinstance(e, dict) and e.get("enabled", True) and e.get("content")]
    picked = []
    for e in entries:
        cs = bool(e.get("case_sensitive"))
        keys = [str(k) for k in e.get("keys", []) if k]
        sec = [str(k) for k in e.get("secondary_keys", []) if k]
        hit = bool(e.get("constant")) or any(_key_hit(k, scan_text, cs) for k in keys)
        if hit and e.get("selective") and sec:
            hit = any(_key_hit(k, scan_text, cs) for k in sec)
        if hit:
            picked.append(e)
    picked.sort(key=lambda e: (e.get("insertion_order", 100), -int(e.get("priority", 0) or 0)))
    before, after, used = [], [], 0
    for e in picked:
        c = str(e["content"]).strip()
        if used + len(c) > budget_chars:
            continue
        used += len(c)
        (after if e.get("position") == "after_char" else before).append(c)
    return before, after


def _example_block(mes_example: str, char: str, user: str) -> str:
    parts = [p.strip() for p in re.split(r"<START>", mes_example, flags=re.I) if p.strip()]
    if not parts:
        return ""
    return "Example conversations (for voice and style only):\n\n" + "\n\n".join(subst(p, char, user) for p in parts)


def build_system(card: dict, user: str, scan_text: str) -> str:
    char = card["name"]
    sub = lambda t: subst(t, char, user).strip()
    base = sub(card["system_prompt"]) or (
        f"Write {char}'s next reply in a fictional chat between {char} and {user}. Stay in character, write only "
        f"{char}'s side, and never write {user}'s actions, thoughts or dialogue.")
    parts = [base]
    if card["description"].strip():
        parts.append(f"{char}'s description:\n{sub(card['description'])}")
    if card["personality"].strip():
        parts.append(f"{char}'s personality: {sub(card['personality'])}")
    if card["scenario"].strip():
        parts.append(f"Scenario: {sub(card['scenario'])}")
    before, after = lore_for(card, scan_text)
    if before:
        parts.append("World info:\n" + "\n".join(sub(t) for t in before))
    ex = _example_block(card["mes_example"], char, user)
    if ex:
        parts.append(ex)
    if after:
        parts.append("World info:\n" + "\n".join(sub(t) for t in after))
    if card["post_history_instructions"].strip():
        parts.append(f"Reminder: {sub(card['post_history_instructions'])}")
    return "\n\n".join(parts)


def build_prompt(card: dict, user: str, history: list, context_messages: int, thinking: bool, scan_depth: int = 4) -> str:
    """Qwen ChatML conversation, ending with the open assistant turn (ComfyUI's Qwen3.5 tokenizer keeps text that
    starts with <|im_start|> as-is)."""
    char = card["name"]
    hist = history[-context_messages:] if context_messages > 0 else history
    scan = "\n".join(m["content"] for m in history[-scan_depth:])
    out = "<|im_start|>system\n" + build_system(card, user, scan) + "<|im_end|>\n"
    for m in hist:
        role = "user" if m["role"] == "user" else "assistant"
        out += f"<|im_start|>{role}\n{subst(m['content'], char, user).strip()}<|im_end|>\n"
    out += "<|im_start|>assistant\n"
    out += "<think>\n" if thinking else "<think>\n\n</think>\n\n"     # same convention as ComfyUI's Qwen3.5 template
    return out


def clean_reply(text: str, char: str) -> str:
    _, sep, rest = text.partition("</think>")
    text = rest if sep else text.replace("<think>", "", 1)
    for stop in ("<|im_end|>", "<|im_start|>", "<|endoftext|>"):
        text = text.split(stop)[0]
    text = text.strip()
    text = re.sub(rf"^{re.escape(char)}\s*:\s*", "", text)          # models sometimes echo "Name:"
    return text.strip()


def parse_history(history_json) -> list:
    try:
        data = json.loads(history_json) if isinstance(history_json, str) and history_json.strip() else []
    except ValueError:
        data = []
    out = []
    for m in data if isinstance(data, list) else []:
        if isinstance(m, dict) and m.get("role") in ("user", "assistant") and isinstance(m.get("content"), str):
            out.append({"role": m["role"], "content": m["content"]})
    return out


def _mtp_value(choice):
    """Combo value -> what clip.generate expects (same mapping as ComfyUI's core Generate Text node)."""
    c = str(choice).strip().lower()
    if c == "off":
        return False
    if c == "auto":
        return True
    try:
        return int(c)
    except ValueError:
        return True


def card_info(card: dict, user: str = "User") -> dict:
    char = card["name"]
    book = card.get("character_book") or {}
    return {
        "name": char,
        "creator": card["creator"],
        "tags": card["tags"][:8],
        "spec": card["spec"],
        "first_mes": subst(card["first_mes"], char, user).strip(),
        "alternate_greetings": [subst(a, char, user).strip() for a in card["alternate_greetings"]],
        "description": subst(card["description"], char, user).strip()[:600],
        "creator_notes": card["creator_notes"][:600],
        "lore_entries": len(book.get("entries", [])) if isinstance(book.get("entries"), list) else 0,
    }


# ---------------------------------------------------------------------------------------------------------------
# the node
# ---------------------------------------------------------------------------------------------------------------
class NouganCharacterChat:
    @classmethod
    def INPUT_TYPES(cls):
        cards = list_cards() or [NONE_CHOICE]
        return {
            "required": {
                "clip": ("CLIP", {"tooltip": "The LLM (e.g. Qwen3.5 9B loaded as a text encoder / CLIP)."}),
                "character": (cards, {"tooltip": "Character card from ComfyUI/input/characters. Use the upload button on the node to add cards."}),
                "user_name": ("STRING", {"default": "User", "multiline": False, "tooltip": "What {{user}} is called in the card."}),
                "max_length": ("INT", {"default": 400, "min": 16, "max": 4096, "step": 1, "tooltip": "Max tokens per reply."}),
                "temperature": ("FLOAT", {"default": 0.8, "min": 0.01, "max": 2.0, "step": 0.01}),
                "top_p": ("FLOAT", {"default": 0.95, "min": 0.0, "max": 1.0, "step": 0.01}),
                "top_k": ("INT", {"default": 64, "min": 0, "max": 1000}),
                "min_p": ("FLOAT", {"default": 0.05, "min": 0.0, "max": 1.0, "step": 0.01}),
                "repetition_penalty": ("FLOAT", {"default": 1.05, "min": 0.0, "max": 5.0, "step": 0.01}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff}),
                "thinking": ("BOOLEAN", {"default": False, "label_on": "true", "label_off": "false", "tooltip": "Let the model reason before replying (slower). The reasoning is discarded."}),
                "context_messages": ("INT", {"default": 40, "min": 2, "max": 400, "tooltip": "How many of the most recent chat messages are sent to the model."}),
            },
            "optional": {
                "card_path": ("STRING", {"default": "", "multiline": False, "tooltip": "Optional full path to a card (.png/.json) anywhere on disk. Overrides the dropdown."}),
                "action": ("STRING", {"default": "none", "multiline": False}),
                "user_message": ("STRING", {"default": "", "multiline": False}),
                "history_json": ("STRING", {"default": "[]", "multiline": False}),
                # appended last on purpose: widget values are saved by position, so adding these at the end
                # keeps every existing workflow loading correctly (old workflows just get the defaults).
                "presence_penalty": ("FLOAT", {"default": 0.0, "min": -2.0, "max": 2.0, "step": 0.01, "tooltip": "Penalises tokens that have already appeared at all. Raise a little to nudge the character toward new topics."}),
                "mtp": (["auto", "off", "2", "3", "4", "5"], {"default": "auto", "tooltip": "Speculative decoding with the checkpoint's multi-token-prediction head. No effect without MTP weights. auto adapts the draft depth; 2-5 pins it. Output differs from non-MTP output for the same seed."}),
            },
        }

    RETURN_TYPES = ("STRING", "STRING", "STRING", "STRING", "IMAGE", "STRING")
    RETURN_NAMES = ("reply", "chat_log", "character_name", "description", "avatar", "history_json")
    FUNCTION = "chat"
    OUTPUT_NODE = True
    CATEGORY = "Nougan"
    DESCRIPTION = "Chat with a Character Card V2/V3 PNG using the LLM you've loaded (built around Qwen3.5)."

    def chat(self, clip, character, user_name, max_length, temperature, top_p, top_k, min_p, repetition_penalty,
             seed, thinking, context_messages, card_path="", action="none", user_message="", history_json="[]",
             presence_penalty=0.0, mtp="auto"):
        path = resolve_card_path(character, card_path)
        card = read_card(path)
        user = (user_name or "User").strip() or "User"
        char = card["name"]
        history = parse_history(history_json)

        if not history and card["first_mes"].strip():
            history.append({"role": "assistant", "content": card["first_mes"].strip()})

        if action == "send":
            msg = (user_message or "").strip()
            if msg:
                history.append({"role": "user", "content": msg})
        elif action == "regenerate":
            while history and history[-1]["role"] == "assistant" and len(history) > 1:
                history.pop()

        generate = action in ("send", "regenerate") and history and history[-1]["role"] == "user"
        reply = ""

        if generate:
            mtp_value = _mtp_value(mtp)
            prompt = build_prompt(card, user, history, int(context_messages), bool(thinking))
            tokens = clip.tokenize(prompt, image=None, skip_template=True, min_length=1, thinking=bool(thinking),
                                   video=None, audio=None, system_prompt="")
            ids = clip.generate(tokens, do_sample=True, max_length=int(max_length), temperature=float(temperature),
                                top_k=int(top_k), top_p=float(top_p), min_p=float(min_p),
                                repetition_penalty=float(repetition_penalty), presence_penalty=float(presence_penalty),
                                seed=int(seed), mtp=mtp_value)
            reply = clean_reply(clip.decode(ids), char)
            history.append({"role": "assistant", "content": reply or "..."})
        elif history and history[-1]["role"] == "assistant":
            reply = history[-1]["content"]

        log = "\n\n".join(f"{char if m['role'] == 'assistant' else user}: {subst(m['content'], char, user)}" for m in history)
        hj = json.dumps(history, ensure_ascii=False)
        avatar = load_avatar(path) if path.lower().endswith(".png") else load_avatar("")

        return {
            "ui": {"nbc_chat": [json.dumps({"history": history, "reply": reply, "generated": bool(generate)}, ensure_ascii=False)]},
            "result": (reply, log, char, subst(card["description"], char, user).strip(), avatar, hj),
        }


# ---------------------------------------------------------------------------------------------------------------
# routes for the UI (card list / info / avatar)
# ---------------------------------------------------------------------------------------------------------------
_ROUTES_DONE = False


def _register_routes():
    global _ROUTES_DONE
    if _ROUTES_DONE:
        return
    try:
        from server import PromptServer
        from aiohttp import web
        routes = PromptServer.instance.routes
    except Exception:
        return

    @routes.get("/nougan/character/list")
    async def _list(_request):
        return web.json_response({"cards": list_cards() or [NONE_CHOICE]})

    @routes.get("/nougan/character/info")
    async def _info(request):
        try:
            path = resolve_card_path(request.query.get("character", ""), request.query.get("card_path", ""))
            return web.json_response(card_info(read_card(path), request.query.get("user", "User") or "User"))
        except Exception as e:
            return web.json_response({"error": str(e)}, status=400)

    @routes.get("/nougan/character/avatar")
    async def _avatar(request):
        try:
            path = resolve_card_path(request.query.get("character", ""), request.query.get("card_path", ""))
            read_card(path)                                       # only ever serve files that really are cards
            if not path.lower().endswith(".png"):
                raise ValueError("no avatar")
            return web.FileResponse(path)
        except Exception:
            return web.Response(status=404)

    _ROUTES_DONE = True


_register_routes()
