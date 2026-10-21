"""
Nougan RefMod nodes for MiniMax H3.

Self-contained: the RefMod engine (encoders, version-5 bundle container, loader and Apply
logic) is vendored from ComfyUI-MiniMaxH3Mod by Luisa (luisacaotica), MIT License, in
./nougan_engine (see nougan_engine/LICENSE). Files baked here use the same v5 bundle format,
so they also open in her stock "Load H3 RefMods" node, and her files open here.

Extras for the JS UI (web/nougan_refmod.js):
  * Bake writes <name>.nougan.jpg (face thumbnail) and <name>.nougan.json (audio waveform peaks)
    next to the .safetensors. Cosmetic only; the RefMod itself never depends on them.
  * GET /nougan/refmods         -> library listing (kinds, token counts, waveform peaks)
  * GET /nougan/refmods/thumb   -> thumbnail jpg
"""

from __future__ import annotations

import json
import os
import sys
import time

NONE = "(none)"
SLOTS = 4
AUDIO_CONCEPTS = ["voice", "singing", "music_style", "sound_fx", "ambience"]
THUMB_EXT = ".nougan.jpg"
META_EXT = ".nougan.json"


# ─────────────────────────────────────────────────────────────────────────
# Engine (vendored upstream code)
# ─────────────────────────────────────────────────────────────────────────
class _Up:
    pass


_UP = None


def _upstream():
    """Return the vendored engine. Imported lazily so ComfyUI's own modules are ready."""
    global _UP
    if _UP is not None:
        return _UP
    from .nougan_engine import engine, bundle, audio, common
    up = _Up()
    up.nodes, up.bundle, up.audio, up.common = engine, bundle, audio, common
    _UP = up
    return up


def _mod_names():
    try:
        return _upstream().nodes._list_mod_names()
    except Exception:
        return []  # engine not importable yet; VALIDATE_INPUTS lets saved values through


# ─────────────────────────────────────────────────────────────────────────
# Library entries (for the JS cards) + sidecar helpers
# ─────────────────────────────────────────────────────────────────────────
_ENTRY_CACHE = {}


def _np(x):
    import numpy as np
    if hasattr(x, "detach"):
        x = x.detach().cpu().float().numpy()
    return np.asarray(x, dtype="float32")


def _sidecar(path):
    try:
        with open(path + META_EXT, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _entry(name):
    up = _upstream()
    n = up.nodes
    path = n._find_mod_path(name)
    st = os.stat(path + ".safetensors")
    thumb = os.path.isfile(path + THUMB_EXT)
    tstamp = int(os.stat(path + THUMB_EXT).st_mtime) if thumb else 0
    key = (st.st_mtime_ns, st.st_size, tstamp)
    hit = _ENTRY_CACHE.get(name)
    if hit and hit[0] == key:
        return hit[1]
    meta = n.read_refmod_meta(path)
    if not isinstance(meta, dict):
        raise ValueError(f"{name}: no RefMod metadata")
    refs = up.bundle.members(meta) if meta.get("kind") == "bundle" else [meta]
    visual_tokens = audio_tokens = faces = 0
    seconds = 0.0
    desc = ""
    for r in refs:
        t = int(r.get("latent_t", 0) or 0)
        if r.get("kind") == "audio":
            audio_tokens += t * 2
            seconds += t / 40.0
        else:
            h, w = int(r.get("latent_h", 0) or 0), int(r.get("latent_w", 0) or 0)
            visual_tokens += t * (h // 2) * (w // 2)
            faces += t
        desc = desc or str(r.get("description", "") or "")
    side = _sidecar(path)
    entry = {
        "name": name,
        "bundle": meta.get("kind") == "bundle",
        "faces": faces,
        "visual_tokens": visual_tokens,
        "audio_tokens": audio_tokens,
        "audio_seconds": round(seconds, 2),
        "description": desc,
        "peaks": side.get("peaks") if isinstance(side.get("peaks"), list) else [],
        "thumb": thumb,
        "stamp": f"{int(st.st_mtime)}{tstamp}",
        "path": path + ".safetensors",
    }
    _ENTRY_CACHE[name] = (key, entry)
    return entry


def _library():
    out = []
    for name in _mod_names():
        try:
            out.append(_entry(name))
        except Exception:
            continue
    return out


def _register_routes():
    try:
        from aiohttp import web
        from server import PromptServer
        if PromptServer.instance is None:
            return
        routes = PromptServer.instance.routes

        @routes.get("/nougan/refmods")
        async def nougan_refmods(request):
            try:
                return web.json_response(_library())
            except Exception as exc:  # engine import problem etc.
                return web.json_response({"error": str(exc)}, status=500)

        @routes.get("/nougan/refmods/thumb")
        async def nougan_thumb(request):
            try:
                path = _upstream().nodes._find_mod_path(request.query.get("name", "")) + THUMB_EXT
            except Exception:
                return web.Response(status=404)
            if not os.path.isfile(path):
                return web.Response(status=404)
            return web.FileResponse(path, headers={"Cache-Control": "no-cache"})
    except Exception as exc:
        print(f"[Nougan RefMod] route registration skipped: {exc}")


_register_routes()


def _peaks(audio, max_seconds, bins=64):
    wf = _np(audio["waveform"])            # [1, C, L]
    sr = int(audio["sample_rate"])
    x = abs(wf[0]).mean(axis=0)
    x = x[:max(1, round(max_seconds * sr))]
    length = x.shape[0]
    bins = max(1, min(bins, length))
    edges = [round(i * length / bins) for i in range(bins + 1)]
    vals = []
    for i in range(bins):
        seg = x[edges[i]:max(edges[i + 1], edges[i] + 1)]
        vals.append(float((seg ** 2).mean() ** 0.5))
    top = max(vals) or 1.0
    return [round(v / top, 3) for v in vals], length / sr


def _save_thumb(tensor, path):
    import numpy as np
    from PIL import Image
    t = tensor[0] if getattr(tensor, "ndim", 3) == 4 else tensor   # [H, W, C]
    arr = np.clip(_np(t)[..., :3], 0.0, 1.0)
    arr = (arr * 255.0).round().astype("uint8")
    h, w = arr.shape[:2]
    side = min(h, w)
    left, top = (w - side) // 2, int((h - side) * 0.2)             # faces sit high in portraits
    Image.fromarray(arr[top:top + side, left:left + side]).resize((256, 256), Image.LANCZOS) \
        .save(path + THUMB_EXT, "JPEG", quality=88)


def _write_sidecar(path, first_image, audio, audio_seconds):
    """Cosmetic extras. Never allowed to fail a bake."""
    data = {"created": int(time.time())}
    try:
        if first_image is not None:
            _save_thumb(first_image, path)
        elif os.path.isfile(path + THUMB_EXT):
            os.remove(path + THUMB_EXT)            # stale thumb from an older bake
    except Exception as exc:
        print(f"[Nougan RefMod Bake] thumbnail skipped: {exc}")
    try:
        if audio is not None:
            data["peaks"], data["seconds"] = _peaks(audio, audio_seconds)
    except Exception as exc:
        print(f"[Nougan RefMod Bake] waveform skipped: {exc}")
    try:
        with open(path + META_EXT, "w", encoding="utf-8") as f:
            json.dump(data, f)
    except Exception as exc:
        print(f"[Nougan RefMod Bake] sidecar skipped: {exc}")


# ─────────────────────────────────────────────────────────────────────────
# Node 1: Bake
# ─────────────────────────────────────────────────────────────────────────
class NouganRefModBake:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "name": ("STRING", {"default": "my_character",
                    "tooltip": "Character name = filename. Same name + subfolder replaces the old file; use _v2 etc. for versions."}),
                "vae": ("VAE", {"tooltip": "MiniMax H3 VIDEO VAE."}),
            },
            "optional": {
                "images": ("IMAGE", {"tooltip": "Portrait batch (each image in the batch is one reference still)."}),
                "video_frames": ("IMAGE", {"tooltip": "Optional: one video clip's frames [T,H,W,C] as a motion/appearance reference."}),
                "folder": ("STRING", {"default": "",
                    "tooltip": "Optional: folder of images/videos (absolute path, or a folder inside ComfyUI/input). Added after the connected images."}),
                "audio": ("AUDIO", {"tooltip": "Voice / music / ambience reference. Needs audio_vae."}),
                "audio_vae": ("VAE", {"tooltip": "MiniMax H3 AUDIO VAE (minimax_h3_audio_vae_fp32)."}),
                "audio_type": (AUDIO_CONCEPTS, {"default": "voice", "tooltip": "Metadata label only."}),
                "audio_max_seconds": ("FLOAT", {"default": 30.0, "min": 0.025, "max": 600.0, "step": 0.5}),
                "audio_max_tokens": ("INT", {"default": 5120, "min": 0, "max": 2147483647}),
                "ref_resolution": ("INT", {"default": 1024, "min": 256, "max": 2048, "step": 64,
                    "tooltip": "Short edge for the visual encode. Lower = fewer tokens."}),
                "max_visual_tokens": ("INT", {"default": 16384, "min": 0, "max": 2147483647, "step": 512,
                    "tooltip": "0 = no cap."}),
                "visual_budget": (["error", "truncate"], {"default": "error",
                    "tooltip": "error = stop if over budget (nothing saved). truncate = drop/resample frames to fit."}),
                "folder_max_items": ("INT", {"default": 8, "min": 1, "max": 256}),
                "folder_max_edge": ("INT", {"default": 1536, "min": 256, "max": 4096, "step": 64}),
                "description": ("STRING", {"default": "", "multiline": True,
                    "tooltip": "Optional. Shows up in the prompt_hint (e.g. 'adult oni woman, tiny horns, red hair')."}),
                "subfolder": ("STRING", {"default": "characters",
                    "tooltip": "Folder inside models/refmods."}),
                "overwrite": ("BOOLEAN", {"default": True}),
            },
        }

    RETURN_TYPES = ("H3_REF_MODS", "STRING", "STRING")
    RETURN_NAMES = ("mods", "saved_path", "details")
    FUNCTION = "bake"
    OUTPUT_NODE = True
    CATEGORY = "Nougan/RefMod"
    DESCRIPTION = ("Bake portraits (+ optional clip) and an audio reference into ONE character RefMod file "
                   "(MiniMax RefMod bundle v5). Load it with Nougan RefMod Loader / Apply. Extraction only, no training.")

    @classmethod
    def IS_CHANGED(cls, folder="", folder_max_items=8, folder_max_edge=1536, **kw):
        if not folder or not folder.strip():
            return ""
        try:
            up = _upstream()
            return up.nodes.MiniMaxH3RefModFolderLoader.IS_CHANGED(folder.strip(), folder_max_items, 240, folder_max_edge)
        except Exception:
            return ""

    def bake(self, name, vae, images=None, video_frames=None, folder="", audio=None, audio_vae=None,
             audio_type="voice", audio_max_seconds=30.0, audio_max_tokens=5120, ref_resolution=1024,
             max_visual_tokens=16384, visual_budget="error", folder_max_items=8, folder_max_edge=1536,
             description="", subfolder="characters", overwrite=True):
        up = _upstream()
        n = up.nodes
        name = n._sanitize_name(name)
        subfolder = (subfolder or "").strip()

        refs_image, refs_video, refs_bundle = {}, {}, None
        if images is not None:
            for i in range(images.shape[0]):
                refs_image[f"ref_image_{i + 1}"] = images[i:i + 1]
        if video_frames is not None:
            refs_video["ref_video_1"] = video_frames
        if folder and folder.strip():
            refs_bundle, _count = n.MiniMaxH3RefModFolderLoader().load(
                folder.strip(), max_items=folder_max_items, max_frames=240, max_edge=folder_max_edge)
        has_visual = bool(refs_image or refs_video or refs_bundle)
        has_audio = audio is not None

        if not has_visual and not has_audio:
            raise ValueError("Nougan Bake: connect images / video_frames / a folder and/or audio.")
        if has_audio and audio_vae is None:
            raise ValueError("Nougan Bake: audio is connected but audio_vae is not (use the H3 AUDIO VAE).")

        path = up.common.mod_output_path(name, subfolder)
        if not overwrite and os.path.isfile(path + ".safetensors"):
            raise FileExistsError(f"{path}.safetensors already exists and overwrite is off.")

        mods = []
        if has_visual:
            out = n.MiniMaxH3RefModExtract.execute(
                name=name + "_visual", mode="Full Reference",
                refs_image=refs_image or None, refs_video=refs_video or None, refs_bundle=refs_bundle,
                vae=vae, ref_resolution=ref_resolution, max_tokens=max_visual_tokens,
                description=description, save=False, concept_type="identity",
                extraction_preset="identity_encode", budget_policy=visual_budget)
            mods.extend(out[0])
        if has_audio:
            mods.append((up.audio.make_audio_mod(
                audio_vae, audio, name + "_audio", audio_max_seconds, audio_max_tokens,
                "error", description, audio_type), 1.0))

        total = sum(m.token_count for m, _ in mods)
        dest = up.bundle.save_bundle(path, name, mods)
        loaded = up.bundle.load_bundle(path)  # reload so downstream gets path/bundle_index set

        # cosmetic extras for the UI cards (thumbnail from the first portrait, audio waveform)
        first = None
        if images is not None:
            first = images[0]
        elif video_frames is not None:
            first = video_frames[0]
        elif refs_bundle:
            first = refs_bundle[0]
        _write_sidecar(path, first, audio if has_audio else None, audio_max_seconds)

        rel = "/".join(p for p in (subfolder.replace("\\", "/"), name) if p)
        try:
            ui_entry = _entry(rel)
        except Exception:
            ui_entry = {"name": rel}

        details = json.dumps({
            "name": name, "file": dest, "total_tokens": total,
            "members": [{"name": m.name, "kind": m.kind, "tokens": m.token_count} for m, _ in loaded],
        }, indent=2, ensure_ascii=False)
        print(f"[Nougan RefMod Bake] {name}: {len(loaded)} member(s), {total} tokens -> {dest}")
        return {"ui": {"text": [dest], "nougan": [ui_entry]}, "result": (loaded, dest, details)}


# ─────────────────────────────────────────────────────────────────────────
# Shared loading logic (Loader + Apply)
# ─────────────────────────────────────────────────────────────────────────
def _slot_inputs(names):
    """Per-slot widgets. Names must match what upstream's _load_components reads."""
    out = {}
    for i in range(1, SLOTS + 1):
        out[f"mod_{i}"] = (names, {"tooltip": "Baked character (or any RefMod). Press R to refresh the list."})
        out[f"visual_strength_{i}"] = ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01,
            "tooltip": "Face / visual strength. 0 skips loading the visuals."})
        out[f"audio_strength_{i}"] = ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01,
            "tooltip": "Voice / audio strength. 0 skips loading the audio."})
        out[f"strength_{i}"] = ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01,
            "tooltip": "Master strength for this slot, multiplied with face/voice."})
        out[f"copies_{i}"] = ("INT", {"default": 1, "min": 1, "max": 10,
            "tooltip": "Repeats the ref. Each copy costs its full tokens in every block."})
        out[f"components_{i}"] = (["All", "Visual", "Audio"], {"default": "All",
            "tooltip": "Which parts of a baked character to load. Unused parts are never read from disk."})
    return out


def _collect(kw, max_total_tokens=0, show_info=False, tag="Nougan RefMod"):
    up = _upstream()
    n = up.nodes
    rows = []  # (mod, strength, copies)
    for i in range(1, SLOTS + 1):
        name = n._normalize_mod_name(kw.get(f"mod_{i}"))
        strength = float(kw.get(f"strength_{i}", 1.0))
        if not name or strength <= 0.0:
            continue
        for mod, comp_strength in n._load_components(name, i, kw):
            rows.append((mod, strength * comp_strength, int(kw.get(f"copies_{i}", 1))))

    loads = []
    for mod, strength, copies in rows:
        loads.extend([(mod, strength)] * copies)
    total = n._check_token_budget(loads, max_total_tokens)
    hint = n._prompt_hint([(m, s) for m, s, _ in rows])

    lines = [f"{m.name} [{m.kind}] strength {s:.2f}" + (f" x{c}" if c > 1 else "")
             + f" - {m.token_count * c} tokens" for m, s, c in rows]
    lines.append(f"total: {total} tokens")
    info = "\n".join(lines)
    print(f"[{tag}]\n" + info)
    if show_info:
        for mod, _s, _c in rows:
            print("\n".join(n._info_lines(mod)))
    return loads, hint, info


# ─────────────────────────────────────────────────────────────────────────
# Node 2: Loader
# ─────────────────────────────────────────────────────────────────────────
class NouganRefModLoader:
    SLOTS = SLOTS

    @classmethod
    def INPUT_TYPES(cls):
        names = [NONE] + _mod_names()
        required = {}
        optional = {"show_info": ("BOOLEAN", {"default": False}),
                    "max_total_tokens": ("INT", {"default": 0, "min": 0, "max": 1048576,
                        "tooltip": "0 = no budget. Counted after copies."})}
        slots = _slot_inputs(names)
        for i in range(1, SLOTS + 1):
            required[f"mod_{i}"] = slots[f"mod_{i}"]
            required[f"strength_{i}"] = slots[f"strength_{i}"]
            required[f"copies_{i}"] = slots[f"copies_{i}"]
            optional[f"components_{i}"] = slots[f"components_{i}"]
            optional[f"visual_strength_{i}"] = slots[f"visual_strength_{i}"]
            optional[f"audio_strength_{i}"] = slots[f"audio_strength_{i}"]
        return {"required": required, "optional": optional}

    RETURN_TYPES = ("H3_REF_MODS", "STRING", "STRING")
    RETURN_NAMES = ("mods", "prompt_hint", "info")
    FUNCTION = "load"
    CATEGORY = "Nougan/RefMod"
    DESCRIPTION = ("Load up to 4 baked characters. Face and voice strengths are separate per slot. "
                   "Wire 'mods' into an Apply node. (Nougan RefMod Apply does load + apply in one node.)")

    @classmethod
    def VALIDATE_INPUTS(cls, input_types=None, **kwargs):
        return True  # saved names missing from the dropdown fail with a clear message at run time

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        try:
            return _upstream().nodes._mods_changed(kwargs)
        except Exception:
            return float("nan")

    def load(self, show_info=False, max_total_tokens=0, **kw):
        loads, hint, info = _collect(kw, max_total_tokens, show_info, "Nougan RefMod Loader")
        return (loads, hint, info)


# ─────────────────────────────────────────────────────────────────────────
# Node 3: Apply (Loader + Apply H3 RefMod in one)
# ─────────────────────────────────────────────────────────────────────────
class NouganRefModApply:
    SLOTS = SLOTS

    @classmethod
    def INPUT_TYPES(cls):
        names = [NONE] + _mod_names()
        required = {"conditioning": ("CONDITIONING", {"tooltip": "Positive conditioning from MiniMax H3 Image To Video."})}
        required.update(_slot_inputs(names))
        required.update({
            "retention": ("FLOAT", {"default": 0.85, "min": 0.0, "max": 1.0, "step": 0.01,
                "tooltip": "Master reference strength. 1.0 fully preserved, 0.7 partially, 0.4 attribute transfer, 0.15 weak."}),
            "max_total_tokens": ("INT", {"default": 0, "min": 0, "max": 1048576,
                "tooltip": "0 = no budget. Counted after copies."}),
            "curve_direction": (["constant", "concept_at_start", "concept_at_end", "concept_at_middle", "concept_at_ends"],
                {"default": "constant"}),
            "curve_shape": (["linear", "ease", "sigmoid", "tanh", "quadratic", "cubic", "exponential",
                             "stair", "elastic", "bump", "dip"], {"default": "linear"}),
            "curve_value": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01}),
            "scramble_seed": ("INT", {"default": -1, "min": -1, "max": 2147483647,
                "tooltip": "-1 = off. With 2+ refs a seed >= 0 shuffles ref order."}),
            "scramble_mode": (["shuffle", "subset", "legacy_subset"], {"default": "shuffle"}),
            "scramble_keep": ("INT", {"default": 1, "min": 1, "max": 80}),
        })
        return {"required": required}

    RETURN_TYPES = ("CONDITIONING", "STRING", "STRING")
    RETURN_NAMES = ("conditioning", "prompt_hint", "info")
    FUNCTION = "apply"
    CATEGORY = "Nougan/RefMod"
    DESCRIPTION = ("Pick baked characters and inject them into the MiniMax H3 conditioning. "
                   "Replaces Load H3 RefMods + Apply H3 RefMod.")

    @classmethod
    def VALIDATE_INPUTS(cls, input_types=None, **kwargs):
        return True

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        try:
            return _upstream().nodes._mods_changed(kwargs)
        except Exception:
            return float("nan")

    def apply(self, conditioning, retention=0.85, max_total_tokens=0, curve_direction="constant",
              curve_shape="linear", curve_value=1.0, scramble_seed=-1, scramble_mode="shuffle",
              scramble_keep=1, **kw):
        up = _upstream()
        loads, hint, info = _collect(kw, max_total_tokens, False, "Nougan RefMod Apply")
        if not loads:
            print("[Nougan RefMod Apply] no character selected - conditioning passed through unchanged.")
            return (conditioning, hint, info)
        out = up.nodes.MiniMaxH3RefModApply.execute(
            conditioning, loads, retention=retention,
            curve_direction=curve_direction, curve_shape=curve_shape, curve_value=curve_value,
            scramble_seed=scramble_seed, graph_preset="(none)", save_preset_as="",
            override=False, scramble_mode=scramble_mode, scramble_keep=scramble_keep,
            max_total_tokens=max_total_tokens)
        return (out[0], hint, info)


NODE_CLASS_MAPPINGS = {
    "NouganRefModBake": NouganRefModBake,
    "NouganRefModLoader": NouganRefModLoader,
    "NouganRefModApply": NouganRefModApply,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "NouganRefModBake": "Nougan RefMod Bake (Character)",
    "NouganRefModLoader": "Nougan RefMod Loader",
    "NouganRefModApply": "Nougan RefMod Apply",
}
