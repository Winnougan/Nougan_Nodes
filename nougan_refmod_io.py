"""
Nougan RefMod IO
----------------
Shared helpers for storing a chat character inside a .safetensors file (a "refmod").

Format
    A .safetensors file is:  8 bytes (little-endian header length) + JSON header + raw tensor bytes.
    The JSON header may hold a "__metadata__" object of string -> string pairs. Loaders ignore keys
    they don't know, so we keep the character there and never touch the tensors:

        nougan_character_card              Character Card V2 JSON (string)
        nougan_character_system_prompt     optional system prompt (string)
        nougan_character_avatar_png_b64    avatar as base64 PNG (string)
        nougan_character_name              plain name, for quick listing
        nougan_character_version           "1"

    Embedding into an existing refmod rewrites only the header. Tensor bytes are streamed across
    unchanged (offsets in the header are relative to the data section, so they stay valid), and the
    result is read back and compared before we report success.
"""
import base64
import io
import json
import os
import struct

from PIL import Image

import folder_paths

META_CARD = "nougan_character_card"
META_SYSTEM = "nougan_character_system_prompt"
META_AVATAR = "nougan_character_avatar_png_b64"
META_NAME = "nougan_character_name"
META_VERSION = "nougan_character_version"
FORMAT_VERSION = "1"

MAX_HEADER = 100 * 1024 * 1024      # same ceiling the safetensors library uses
REFMOD_PREFIX = "refmod:"           # marks refmod entries in the chat node's dropdown
NONE_BASE = "(none - character-only file)"


# ───────────────────────────────────────────────────────────── header I/O ──

def read_header(path: str):
    """Return (header_dict, data_start_offset). Reads only the header, never the tensors."""
    with open(path, "rb") as f:
        raw = f.read(8)
        if len(raw) < 8:
            raise ValueError(f"{os.path.basename(path)} is too small to be a safetensors file.")
        (n,) = struct.unpack("<Q", raw)
        if n < 2 or n > MAX_HEADER:
            raise ValueError(f"{os.path.basename(path)} is not a valid safetensors file (bad header length).")
        hb = f.read(n)
        if len(hb) != n:
            raise ValueError(f"{os.path.basename(path)} is truncated (header incomplete).")
    try:
        header = json.loads(hb.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise ValueError(f"{os.path.basename(path)} is not a valid safetensors file (header is not JSON).") from None
    if not isinstance(header, dict):
        raise ValueError(f"{os.path.basename(path)} is not a valid safetensors file (header is not an object).")
    return header, 8 + n


def _build_header_bytes(header: dict) -> bytes:
    hb = json.dumps(header, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return hb + b" " * ((-len(hb)) % 8)           # safetensors pads the header to 8 bytes with spaces


def _same_bytes(path_a, start_a, path_b, start_b, length, chunk=16 * 1024 * 1024) -> bool:
    with open(path_a, "rb") as a, open(path_b, "rb") as b:
        a.seek(start_a)
        b.seek(start_b)
        left = length
        while left > 0:
            n = min(chunk, left)
            if a.read(n) != b.read(n):
                return False
            left -= n
    return True


def write_with_metadata(dst: str, updates: dict, src: str = None) -> dict:
    """
    Write `dst` = `src` (or an empty tensor-less file) + `updates` in __metadata__.
    Tensor bytes are copied untouched and verified. Returns a small report dict.
    """
    if src and os.path.abspath(src) == os.path.abspath(dst):
        raise ValueError("Refusing to overwrite the source refmod. Choose a different output name.")

    if src:
        header, data_start = read_header(src)
        data_len = os.path.getsize(src) - data_start
    else:
        header, data_start, data_len = {}, 0, 0

    old_meta = header.get("__metadata__")
    meta = dict(old_meta) if isinstance(old_meta, dict) else {}
    meta.update({k: str(v) for k, v in updates.items()})

    new_header = {"__metadata__": meta}
    new_header.update({k: v for k, v in header.items() if k != "__metadata__"})
    hb = _build_header_bytes(new_header)

    os.makedirs(os.path.dirname(os.path.abspath(dst)), exist_ok=True)
    tmp = dst + ".tmp"
    try:
        with open(tmp, "wb") as out:
            out.write(struct.pack("<Q", len(hb)))
            out.write(hb)
            if src:
                with open(src, "rb") as f:
                    f.seek(data_start)
                    left = data_len
                    while left > 0:
                        buf = f.read(min(16 * 1024 * 1024, left))
                        if not buf:
                            raise RuntimeError("Source file ended early while copying tensor data.")
                        out.write(buf)
                        left -= len(buf)
        os.replace(tmp, dst)
    finally:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass

    # read it back from disk: never report success on a file we can't verify
    chk_header, chk_start = read_header(dst)
    if chk_header.get("__metadata__") != meta:
        raise RuntimeError(f"Verification failed for {dst}: metadata did not round-trip.")
    for k, v in header.items():
        if k != "__metadata__" and chk_header.get(k) != v:
            raise RuntimeError(f"Verification failed for {dst}: tensor entry {k!r} changed.")
    if os.path.getsize(dst) - chk_start != data_len:
        raise RuntimeError(f"Verification failed for {dst}: tensor data size changed.")
    if src and data_len and not _same_bytes(src, data_start, dst, chk_start, data_len):
        raise RuntimeError(f"Verification failed for {dst}: tensor bytes differ from the source.")

    n_tensors = sum(1 for k in header if k != "__metadata__")
    return {"tensors": n_tensors, "data_bytes": data_len, "had_character": bool(old_meta and META_CARD in old_meta)}


# ───────────────────────────────────────────────────────── character I/O ──

def avatar_to_b64(pil_img: Image.Image, max_size: int = 512) -> str:
    img = pil_img.convert("RGB")
    if max_size and max(img.size) > max_size:
        img.thumbnail((max_size, max_size), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def character_metadata(card: dict, system_prompt: str = "", avatar_b64: str = "") -> dict:
    meta = {
        META_VERSION: FORMAT_VERSION,
        META_NAME: str(card.get("data", {}).get("name", "")),
        META_CARD: json.dumps(card, ensure_ascii=False),
    }
    if system_prompt and system_prompt.strip():
        meta[META_SYSTEM] = system_prompt
    if avatar_b64:
        meta[META_AVATAR] = avatar_b64
    return meta


def read_character(path: str) -> dict:
    """Header-only read. Returns {"card": dict, "system_prompt": str, "avatar_b64": str}."""
    header, _ = read_header(path)
    meta = header.get("__metadata__")
    fname = os.path.basename(path)
    if not isinstance(meta, dict) or META_CARD not in meta:
        raise ValueError(f"{fname} has no embedded character. Bake one into it with the Nougan Refmod Baker.")
    try:
        card = json.loads(meta[META_CARD])
    except (TypeError, json.JSONDecodeError):
        raise ValueError(f"{fname} has a damaged character entry (card JSON is invalid).") from None
    if not isinstance(card, dict):
        raise ValueError(f"{fname} has a damaged character entry (card is not an object).")
    return {
        "card": card,
        "system_prompt": str(meta.get(META_SYSTEM, "") or ""),
        "avatar_b64": str(meta.get(META_AVATAR, "") or ""),
    }


def has_character(path: str) -> bool:
    try:
        header, _ = read_header(path)
    except Exception:
        return False
    meta = header.get("__metadata__")
    return isinstance(meta, dict) and META_CARD in meta


def read_avatar_bytes(path: str):
    """PNG bytes of the embedded avatar, or None."""
    b64 = read_character(path)["avatar_b64"]
    if not b64:
        return None
    try:
        return base64.b64decode(b64)
    except Exception:
        return None


# ─────────────────────────────────────────────────────────── refmod folders ──

# Folder names a refmod loader might register with ComfyUI; harmless if absent.
_FOLDER_KEYS = ("refmod", "refmods", "h3_refmod", "minimax_refmod", "reference", "references")


def refmod_dirs() -> list:
    """
    Where refmod files live. Checked in order:
      1. env NOUGAN_REFMOD_DIR (several folders separated by ; on Windows or : elsewhere)
      2. any ComfyUI folder registered under a refmod-like name
      3. ComfyUI/models/refmods
    Only folders that exist are returned.
    """
    cands = [p for p in os.environ.get("NOUGAN_REFMOD_DIR", "").split(os.pathsep) if p.strip()]
    for key in _FOLDER_KEYS:
        try:
            cands.extend(folder_paths.get_folder_paths(key))
        except Exception:
            pass
    cands.append(os.path.join(folder_paths.models_dir, "refmods"))
    seen, out = set(), []
    for c in cands:
        c = os.path.normpath(c.strip().strip('"'))
        if c.lower() not in seen and os.path.isdir(c):
            seen.add(c.lower())
            out.append(c)
    return out


def list_refmods(only_with_character: bool = False) -> list:
    """Relative paths (forward slashes) of .safetensors files across the refmod folders."""
    found = set()
    for base in refmod_dirs():
        for root, _, files in os.walk(base):
            for fn in files:
                if not fn.lower().endswith(".safetensors"):
                    continue
                full = os.path.join(root, fn)
                if only_with_character and not has_character(full):
                    continue
                found.add(os.path.relpath(full, base).replace(os.sep, "/"))
    return sorted(found, key=str.lower)


def resolve_refmod(rel: str) -> str:
    rel = (rel or "").strip()
    for base in refmod_dirs():
        full = os.path.normpath(os.path.join(base, rel))
        if full.startswith(os.path.normpath(base)) and os.path.isfile(full):
            return full
    raise ValueError(f"refmod not found in the refmod folders: {rel!r}")
