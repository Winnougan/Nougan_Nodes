"""
nougan_engine.engine

Vendored from ComfyUI-MiniMaxH3Mod by Luisa (luisacaotica), MIT License, commit 517e8c4
(https://github.com/Luisacaotica/ComfyUI-MiniMaxH3Mod). See LICENSE in this folder.

Only the pieces the Nougan RefMod nodes use were extracted from the upstream nodes.py, unchanged,
except that the Extract / Apply classes keep their execute() and drop the ComfyUI schema, because
they are called directly by the Nougan nodes and are NOT registered as nodes here.
core.py, common.py, audio.py, bundle.py and debug_grid.py in this folder are verbatim upstream.
"""

from __future__ import annotations
import json
import math
import ntpath
import os
import random
from dataclasses import replace
from typing import Dict, List, Optional
import torch
import torch.nn.functional as F
import comfy.patcher_extension
import comfy.utils
import folder_paths
from comfy_api.latest import io, ui
from .bundle import load_bundle, members as bundle_members
from .common import list_media_files, load_image_file, load_video_file, refmods_dir, mod_output_path, resize_ref as _resize_ref, sample_video_for_vae as _sample_video_for_vae, ensure_min_size as _ensure_min_size
from .core import CURVE_DIRECTIONS, CURVE_SHAPES, H3RefMod, _blur_latent, aspect_grid, curve_strengths, fit_token_budget, normalize_mode, optimize_latent, optimize_latent_multi, pool_latent, read_refmod_meta
from .debug_grid import graph_pnginfo, pil_to_tensor, read_graph_meta, render_debug_grid


try:
    folder_paths.add_model_folder_path("refmods", os.path.join(folder_paths.models_dir, "refmods"))
except Exception:
    pass



_PACK_DIR = os.path.dirname(os.path.abspath(__file__))


LEGACY_MODS_DIR = os.path.join(_PACK_DIR, "mods")  # pre-models/refmods storage, still read


_MOD_CACHE: Dict[str, H3RefMod] = {}


_MOD_CACHE_STAMPS = {}


_MOD_CACHE_BYTES = 256 * 1024 * 1024


_MOD_CACHE_MAX = 24          # cap: never pin more mods in RAM than this (FIFO eviction)


_MOD_LIST_CACHE_KEY = None   # (dirs, mtimes, sizes) signature of the last _list_mod_names() scan


_MOD_LIST_CACHE_VAL = None


_MOD_SKIP_DIRS = {"graph_presets", ".git", "__pycache__"}


RETENTION = {
    "fully_preserved": 1.0,
    "partially_preserved": 0.7,
    "attribute_transfer": 0.4,
    "weak_reference": 0.15,
}


def _resolve_visual_vae(vae=None, av_encoder=None):
    """Use native ComfyUI VAE loading for legacy VAERef connections too."""
    if vae is not None:
        return vae
    if av_encoder is None:
        raise ValueError("Connect the MiniMax H3 video VAE to vae.")
    import comfy.sd
    path = os.fspath(av_encoder.video_path)
    if not os.path.isfile(path):
        raise FileNotFoundError(f"H3 video VAE not found: {path}")
    state, metadata = comfy.utils.load_torch_file(path, return_metadata=True)
    loaded = comfy.sd.VAE(sd=state, metadata=metadata)
    loaded.throw_exception_if_invalid()
    return loaded


def _mod_search_dirs() -> List[str]:
    dirs = list(folder_paths.get_folder_paths("refmods"))
    for d in (os.path.join(folder_paths.models_dir, "refmods"), os.path.join(folder_paths.models_dir, "mods"),
              os.path.join(os.path.dirname(_PACK_DIR), "models", "mods"), LEGACY_MODS_DIR,
              os.path.join(folder_paths.models_dir, "audio_refmods")):
        if d not in dirs and os.path.isdir(d):
            dirs.append(d)
    return dirs


def _list_mod_names() -> List[str]:
    """Available RefMod names across the search dirs (for the loader dropdown).

    Only entries with valid RefMod metadata (embedded in the safetensors header
    or a legacy sidecar .json) are listed, so other mod formats in
    models/mods/ (e.g. LTXMod files) don't show up.

    Called by INPUT_TYPES/VALIDATE_INPUTS on every prompt validation, so the
    result is cached until any mod file appears/disappears/changes (checked
    via cheap os.stat, not by re-reading every safetensors header).
    """
    global _MOD_LIST_CACHE_KEY, _MOD_LIST_CACHE_VAL
    dirs = _mod_search_dirs()
    sig, candidates = [], []
    for d in dirs:
        for root, subdirs, files in os.walk(d):
            subdirs[:] = sorted(s for s in subdirs if s not in _MOD_SKIP_DIRS)
            for fn in sorted(files):
                if not fn.endswith(".safetensors"):
                    continue
                path = os.path.join(root, fn)
                stem = path[:-len(".safetensors")]
                try:
                    st = os.stat(path)
                except OSError:
                    continue
                sidecar = None
                try:
                    js = os.stat(stem + ".json")
                    sidecar = (js.st_size, js.st_mtime_ns)
                except OSError:
                    pass
                sig.append((path, st.st_size, st.st_mtime_ns, sidecar))
                name = os.path.relpath(stem, d).replace("\\", "/")
                candidates.append((name, stem))
    key = (tuple(dirs), tuple(sig))
    if key == _MOD_LIST_CACHE_KEY:
        return _MOD_LIST_CACHE_VAL
    names = set()
    seen = set()
    for name, stem in candidates:
        if name in seen:
            continue
        seen.add(name)  # match _find_mod_path's first-search-directory priority
        meta = read_refmod_meta(stem)
        if isinstance(meta, dict) and meta.get("kind") == "bundle":
            try:
                bundle_members(meta)
            except ValueError:
                continue
        if isinstance(meta, dict) and meta.get("kind") in ("image", "video", "audio", "bundle"):
            names.add(name)
    _MOD_LIST_CACHE_KEY, _MOD_LIST_CACHE_VAL = key, sorted(names)
    return _MOD_LIST_CACHE_VAL


def _normalize_mod_name(name) -> str:
    if name is None:
        return ""
    name = str(name).replace("\\", "/")
    return "" if name in ("", "None", "(none)") else name


def _find_mod_path(name: str) -> str:
    name = _normalize_mod_name(name)
    if (not name or ntpath.splitdrive(name)[0] or name.startswith("/")
            or ".." in name.split("/")
            or any(part in _MOD_SKIP_DIRS for part in name.split("/"))):
        raise ValueError(f"RefMod '{name}': expected a relative mod name under models/refmods/.")
    dirs = _mod_search_dirs()
    for d in dirs:
        p = os.path.join(d, name)
        root = os.path.realpath(d)
        target = os.path.realpath(p + ".safetensors")
        try:
            contained = os.path.commonpath((root, target)) == root
        except ValueError:  # a symlink can point to another Windows drive
            contained = False
        if not contained:
            continue
        if os.path.isfile(p + ".safetensors"):
            return os.path.abspath(p)
    raise FileNotFoundError(
        f"RefMod '{name}' not found. Searched:\n" +
        "\n".join(f"  - {d}/{name}.safetensors" for d in dirs))


def _file_stamp(path):
    stamps = []
    for ext in (".safetensors", ".json"):
        try:
            st = os.stat(path + ext)
            stamps.append((st.st_size, st.st_mtime_ns, st.st_ctime_ns))
        except FileNotFoundError:
            stamps.append(None)
    return (os.path.normcase(os.path.abspath(path)), *stamps)


def _cache_mod(path, mod):
    key = os.path.normcase(os.path.abspath(path))
    _MOD_CACHE[key] = mod
    _MOD_CACHE_STAMPS[key] = _file_stamp(path)
    while _MOD_CACHE and (len(_MOD_CACHE) > _MOD_CACHE_MAX or
            sum(m.latent.numel() * m.latent.element_size() for m in _MOD_CACHE.values()) > _MOD_CACHE_BYTES):
        evicted = next(iter(_MOD_CACHE))
        _MOD_CACHE.pop(evicted)
        _MOD_CACHE_STAMPS.pop(evicted, None)


def _load_mod(name: str) -> H3RefMod:
    path = _find_mod_path(name)
    key = os.path.normcase(path)
    if key in _MOD_CACHE and _MOD_CACHE_STAMPS.get(key) == _file_stamp(path):
        return _MOD_CACHE[key]
    _MOD_CACHE.pop(key, None)
    _MOD_CACHE_STAMPS.pop(key, None)
    mod = H3RefMod.load(path, device="cpu")
    _cache_mod(path, mod)
    return mod


def _mods_changed(kwargs):
    stamps = []
    for field, value in sorted(kwargs.items()):
        if not field.startswith("mod_"):
            continue
        if value is None:
            return float("nan")
        name = _normalize_mod_name(value)
        if name:
            try:
                stamps.append(_file_stamp(_find_mod_path(name)))
            except (FileNotFoundError, ValueError):
                stamps.append((name, "missing"))
    return tuple(stamps)


def _check_token_budget(mods, budget):
    if isinstance(budget, bool) or not isinstance(budget, (int, float)) or not math.isfinite(budget) or int(budget) != budget:
        raise ValueError("Token budget must be a finite integer.")
    total = sum(mod.token_count for mod, strength in mods if strength > 0)
    if budget < 0:
        raise ValueError("Token budget cannot be negative.")
    if budget and total > budget:
        raise ValueError(f"RefMods require {total} tokens after copies; budget is {budget}. Reduce copies or selected mods.")
    return total


def _graph_presets_dir() -> str:
    """models/refmods/graph_presets — shared curve presets, created on first use."""
    d = os.path.join(refmods_dir(), "graph_presets")
    os.makedirs(d, exist_ok=True)
    return d


def _load_graph_preset(name: str) -> Optional[tuple]:
    """Read a graph preset -> (direction, shape, value) or None if invalid.

    Presets are PNG files with the graph embedded in their tEXt metadata (the
    saved debug grid — share the image itself); legacy .json presets still
    load.
    """
    d = _graph_presets_dir()
    meta = read_graph_meta(os.path.join(d, name + ".png"))
    if meta is not None:
        return meta
    try:
        with open(os.path.join(d, name + ".json"), "r",
                  encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    direction, shape = data.get("direction"), data.get("shape")
    if direction not in CURVE_DIRECTIONS or shape not in CURVE_SHAPES:
        return None
    try:
        value = float(data.get("value", 1.0))
    except (TypeError, ValueError):
        return None
    return (direction, shape, value)


def _save_graph_preset(name: str, spec, img=None) -> str:
    """Write a (direction, shape, value) tuple as a PNG preset with tEXt meta.

    The saved file is the debug grid itself (a mini preview of the curve)
    with the graph embedded in its metadata, so sharing the image shares the
    curve.  ``img`` is the rendered grid from Apply; when absent a minimal
    grid is rendered just for the file.
    """
    safe = "".join(c if c.isalnum() or c in "-_" else "_"
                    for c in str(name).strip())
    if not safe:
        return ""
    if img is None:
        img = render_debug_grid(spec)
    img.save(os.path.join(_graph_presets_dir(), safe + ".png"),
             pnginfo=graph_pnginfo(spec))
    return safe


def _normalize_mask_batch(mask, label: str = "mask") -> torch.Tensor:
    """Canonicalize a MASK input to ``[N, H, W]`` float32 in [0, 1]."""
    if mask is None:
        return None
    if not isinstance(mask, torch.Tensor):
        raise ValueError(f"MiniMaxH3RefModExtract: {label} must be a MASK tensor, "
                          f"got {type(mask)}")
    if mask.dim() == 2:  # [H, W]
        mask = mask.unsqueeze(0)
    if mask.dim() != 3:
        raise ValueError(f"MiniMaxH3RefModExtract: {label} has unexpected shape "
                          f"{tuple(mask.shape)} (expected [H,W] or [N,H,W])")
    return mask.float().clamp(0.0, 1.0)


def _resize_mask(mask: torch.Tensor, target_h: int, target_w: int, crop="disabled") -> torch.Tensor:
    """Resize a ``[T, H, W]`` mask to ``target_h x target_w`` (bilinear)."""
    samples = mask.unsqueeze(1)  # [T, 1, H, W]
    samples = comfy.utils.common_upscale(samples, target_w, target_h, "bilinear", crop)
    return samples.squeeze(1).clamp(0.0, 1.0)


def _mask_latent(z: torch.Tensor, mask_px: torch.Tensor, background_retention: float,
                  seed_key: str) -> torch.Tensor:
    """Suppress the latent outside ``mask_px`` toward a blurred copy of itself, per cell.

    ``mask_px`` is pixel-space (already resized/cropped to match the encoded
    source), 1 = keep, 0 = suppress; ``background_retention`` sets the floor
    weight for suppressed regions (0 = fully blurred there, 1 = no
    suppression at all). ``seed_key`` is unused now (kept for call-site
    compatibility) — the suppression target is deterministic, not random.

    ``z``: ``[1, 24, T, H, W]`` VAE latent. Downsamples ``mask_px`` to the
    latent's ``H x W`` via average pooling (soft edges instead of a hard cut,
    since the DiT patchifies in 2x2 cells anyway).
    """
    t, h, w = z.shape[2], z.shape[3], z.shape[4]
    mp = mask_px.unsqueeze(1)  # [T_src, 1, H, W]
    if mp.shape[0] == 1 and t > 1:
        mp = mp.expand(t, -1, -1, -1)
    elif mp.shape[0] != t:
        idx = torch.linspace(0, mp.shape[0] - 1, t).round().long()
        mp = mp[idx]
    mp = F.adaptive_avg_pool2d(mp.float(), (h, w))          # [T, 1, h, w]
    mp = mp.permute(1, 0, 2, 3).unsqueeze(0).clamp(0.0, 1.0)  # [1, 1, T, h, w]
    weight = background_retention + (1.0 - background_retention) * mp
    blurred = _blur_latent(z)
    return (weight * z.float() + (1.0 - weight) * blurred).to(z.dtype)


def _normalize_ref(src, label: str = "reference") -> torch.Tensor:
    """Canonicalize any ref source to ``[T, H, W, C]`` (T=1 for stills).

    Accepts ``[H, W, C]``, ``[B, H, W, C]``, and batch-video ``[B, T, H, W, C]``
    (some video loaders emit the batch form).  Rejects empty frames with a
    clear error instead of letting the VAE crash on a zero spatial dim.
    """
    if not isinstance(src, torch.Tensor) or src.dim() not in (3, 4, 5):
        raise ValueError(
            f"MiniMaxH3RefModExtract: {label} must be a 3-5D tensor, "
            f"got {getattr(src, 'shape', src)}")
    if src.dim() == 5:  # [B, T, H, W, C] batch video
        if src.shape[0] == 0:
            raise ValueError(
                f"MiniMaxH3RefModExtract: {label} has no frames "
                f"(T=0) — check the source image/video.")
        src = src[0] if src.shape[0] == 1 else src.reshape(-1, *src.shape[2:])
    if src.dim() == 3:  # [H, W, C]
        src = src.unsqueeze(0)
    if src.shape[-1] != 3 and src.shape[1] == 3:  # channel-first [B, C, H, W]
        src = src.movedim(1, -1)
    if src.dim() != 4 or src.shape[-1] != 3:
        raise ValueError(
            f"MiniMaxH3RefModExtract: {label} has an unexpected layout "
            f"{tuple(src.shape)} (expected [T, H, W, 3])")
    if src.shape[0] <= 0:
        raise ValueError(
            f"MiniMaxH3RefModExtract: {label} has no frames (T={src.shape[0]}) "
            f"— check the source image/video.")
    if src.shape[1] <= 0 or src.shape[2] <= 0:
        raise ValueError(
            f"MiniMaxH3RefModExtract: {label} has an empty frame "
            f"({src.shape[1]}x{src.shape[2]}) — check the source image/video.")
    return src


def _sanitize_name(name: str) -> str:
    name = name.strip().replace("/", "_").replace("\\", "_")
    if not name:
        raise ValueError("mod name must not be empty")
    return name


def _resolve_folder(folder: str) -> str:
    """Resolve a folder input: absolute path, a name inside input/, or input/ itself."""
    folder = (folder or "").strip().strip('"')
    if not folder:
        return folder_paths.get_input_directory()
    if os.path.isabs(folder):
        resolved = os.path.normpath(folder)
    else:
        resolved = os.path.join(folder_paths.get_input_directory(), folder)
    if not os.path.isdir(resolved):
        raise ValueError(
            f"folder not found: {folder!r} (looked at '{resolved}'; use an "
            "absolute path or a folder name inside input/).")
    return resolved


def _summarize(mod: H3RefMod) -> str:
    if mod.kind == "audio":
        return f"{mod.name}: audio, {mod.latent_t / 40:.2f}s, {mod.token_count} tokens"
    mb = mod.latent.numel() * mod.latent.element_size() / 1024 / 1024
    return (f"'{mod.name}' {mod.mode} {mod.kind} {tuple(mod.latent.shape)} "
            f"({mod.token_count} tokens, {mb:.2f} MB)")


def _info_lines(mod: H3RefMod) -> List[str]:
    opt = mod.optimize_steps
    if mod.mode == "encode":
        opt = f"n/a ({mod.optimize_steps} — encode mode stores the actual encode)"
    return [
        "=" * 52,
        f"  MiniMax H3 RefMod: {mod.name}",
        f"  {'concept_type':<18} {mod.concept_type}",
        f"  {'mode':<18} {mod.mode}",
        f"  {'kind':<18} {mod.kind}",
        f"  {'latent':<18} {tuple(mod.latent.shape)}",
        f"  {'tokens injected':<18} {mod.token_count}",
        f"  {'source':<18} {mod.source} ({mod.source_shape})",
        f"  {'pool':<18} {mod.pool}",
        f"  {'identity':<18} {opt}",
        f"  {'tags':<18} {', '.join(mod.tags) if mod.tags else '-'}",
        f"  {'description':<18} {mod.description or '-'}",
        "=" * 52,
    ]


def _saved_curve(cfg: Optional[Dict], key: str) -> Optional[tuple]:
    """(direction, shape, value) from a mod's saved config entry, or None.

    Validates against the known curve names so hand-edited/foreign metadata
    can't inject junk into the Apply or Step Curve nodes — anything invalid
    just falls back to the manual widgets.
    """
    entry = (cfg or {}).get(key)
    if not isinstance(entry, (list, tuple)) or len(entry) != 3:
        return None
    direction, shape, value = entry
    if direction not in CURVE_DIRECTIONS or shape not in CURVE_SHAPES:
        return None
    try:
        return (direction, shape, float(value))
    except (TypeError, ValueError):
        return None


def _ref_blocks(mods, retention, curve=None, seed=-1, scramble_mode="legacy_subset", scramble_keep=1, max_total_tokens=0) -> List[Dict]:
    """Ref blocks for a loader bundle, scaled by row strength x retention.

    ``retention`` is a master strength multiplier: a float 0-1 (1.0 =
    fully_preserved, 0.7 = partially_preserved, 0.4 = attribute_transfer,
    0.15 = weak_reference), or one of those preset names for legacy
    workflows saved with the old combo widget.

    ``curve`` (optional) is a per-frame strength spec — a ``(direction,
    shape, value)`` tuple, a legacy preset name, per-frame values, control
    points (see ``core.curve_strengths``) — applied on top of the row
    strength.  A flat/no curve keeps today's behavior.

    ``seed`` (default -1 = off) enables ref scrambling: with 2+ refs in the
    bundle, the order is shuffled and a random subset kept, so a different
    ref leads each run instead of the same one always "popping".  Same seed
    -> same scramble; connect/randomize the seed for per-run variation.
    """
    if isinstance(retention, str):
        factor = RETENTION.get(retention, 1.0)
    else:
        factor = float(retention)
    items = list(mods)
    if int(seed) >= 0 and len(items) > 1:
        rng = random.Random(int(seed))
        rng.shuffle(items)
        if scramble_mode == "legacy_subset":
            keep = rng.randint(max(1, len(items) // 2), len(items))
            items = items[:keep]
        elif scramble_mode == "subset":
            items = items[:max(1, int(scramble_keep))]
        elif scramble_mode != "shuffle":
            raise ValueError("Unknown scramble mode.")
        print(f"[MiniMaxH3RefModApply] scramble seed={int(seed)}: "
              f"{len(mods)} refs -> kept {len(items)} (order shuffled)")
    _check_token_budget(items, max_total_tokens)
    blocks = []
    notes = []
    summaries = []  # (name, effective average multiplier)
    for mod, strength in items:
        eff = min(1.0, max(0.0, strength * factor))
        used_curve = curve
        if (mod.latent_t <= 1 and isinstance(curve, tuple) and len(curve) == 3
                and isinstance(curve[0], str) and str(curve[0]) != "constant"):
            # curve directions run across a mod's own ref frames, which is
            # meaningless on single-frame mods — previously this silently
            # no-op'ed and identity mods always injected at full strength.
            # Now: treat curve_value as a plain strength cap instead.
            cap = max(0.0, min(1.0, float(curve[2])))
            if cap < eff:
                notes.append(
                    f"'{mod.name}' is image-kind (1 frame): direction "
                    f"'{curve[0]}' has no effect; using curve_value "
                    f"{cap:.2f} as its strength cap instead")
                eff = min(eff, cap)
            used_curve = None
        block = mod.ref_block(eff, curve=used_curve)
        if block is not None:
            # marker the step-curve wrapper uses to tell this ref apart from
            # native ref2va refs (original input video, keyframes, ...) so it
            # only ever re-mixes what the Apply node injected
            block["refmod"] = True
            blocks.append(block)
        avg = eff
        if used_curve is not None and mod.latent_t > 1:
            strengths = curve_strengths(used_curve, mod.latent_t)
            if strengths:
                avg = eff * (sum(strengths) / len(strengths))
        summaries.append((mod.name, avg))
    for line in notes:
        print(f"[MiniMaxH3RefModApply] note: {line}")
    if summaries and any(s < 0.999 for _n, s in summaries):
        detail = ", ".join(f"{n}@{s:.2f}" for n, s in summaries)
        weak = min(s for _n, s in summaries) < 0.3
        print(f"[MiniMaxH3RefModApply] effective ref strength (row x retention"
              f"{' x curve-mean' if curve is not None else ''}): {detail}"
              + ("  <- below 0.30, expect a weak insertion" if weak else ""))
    return blocks


def _prompt_hint(loads) -> str:
    """Merge loaded mods' concept_type + description into one prompt-ready string.

    e.g. "identity: ginger woman, tattooed neck, black lipstick; pose_motion:
    slow twirl into camera, hair whipping". Concat this onto your positive
    prompt (a string-concat node ahead of CLIP Text Encode) instead of
    retyping each mod's description by hand. Mods with no description are
    skipped — a bare concept_type with nothing to say isn't a useful clue.
    """
    parts = []
    for mod, _strength in loads:
        if mod.description:
            parts.append(f"{mod.concept_type}: {mod.description}")
    return "; ".join(parts)


def _load_components(name, slot, kwargs):
    selection = kwargs.get(f"components_{slot}", "All")
    if selection not in ("All", "Visual", "Audio"):
        raise ValueError("Components must be All, Visual or Audio.")
    weights = {kind: float(kwargs.get(f"{kind}_strength_{slot}", 1.0)) for kind in ("visual", "audio")}
    path = _find_mod_path(name)
    meta = read_refmod_meta(path)
    if not isinstance(meta, dict):
        raise ValueError(f"'{name}' has no valid RefMod metadata.")
    if meta.get("kind") == "bundle":
        return load_bundle(path, selection, weights["visual"], weights["audio"])
    kind = "audio" if meta.get("kind") == "audio" else "visual"
    if weights[kind] <= 0 or (selection != "All" and selection.lower() != kind):
        return []
    return [(_load_mod(name), weights[kind])]


class MiniMaxH3RefModApply:
    """
    Inject a loader bundle of RefMods into a MiniMax H3 conditioning.

    Accepts either the ComfyUI-MiniMaxH3 pack's MINIMAX_H3_COND or the built-in
    ComfyUI CONDITIONING (from the core MiniMaxH3ReferenceToVideo node) and
    returns the same type.  Appends each mod's reference latent to the
    conditioning's ``refs`` / ``minimax_refs``, so the DiT attends to it
    through all blocks exactly like a reference image/video.  ``retention`` is
    a master strength over the loader's per-row strengths; the curve is split
    into ``curve_direction`` (constant / concept_at_start / concept_at_end),
    ``curve_shape`` (how the envelope travels between its endpoints) and
    ``curve_value`` (the non-zero endpoint) — all plain widgets, no ComfyUI
    Curve widget required.  ``scramble_seed`` (default -1 = off) shuffles the
    ref order and keeps a random subset per run so a multi-ref mod can "pop"
    a different ref each time instead of always the same one.
    """


    @classmethod
    def execute(cls, conditioning, mods, retention=1.0,
                curve_direction="constant", curve_shape="linear", curve_value=1.0,
                strength_curve=None, scramble_seed=-1, graph_preset="", save_preset_as="",
                override=False, scramble_mode="legacy_subset", scramble_keep=1, max_total_tokens=0):
        # workflows saved before the curve split pass the old single preset name
        curve = strength_curve if strength_curve is not None \
            else (curve_direction, curve_shape, curve_value)
        # a selected graph preset overrides the curve widgets
        preset_name = ""
        curve_source = "legacy strength_curve" if strength_curve is not None else "widgets"
        retention_source = "widget"
        if graph_preset and graph_preset != "(none)":
            loaded = _load_graph_preset(graph_preset)
            if loaded is None:
                print(f"[MiniMaxH3RefModApply] WARNING: graph preset '{graph_preset}' "
                      f"not found or invalid — using widget curve")
            else:
                curve = loaded
                preset_name = graph_preset
                curve_source = f"graph preset {graph_preset}"
        # override: pull retention + curve from the first mod with a fixed config
        if override:
            found = None
            for m, _s in (mods or []):
                saved = _saved_curve(getattr(m, "config", None), "curve")
                if saved is not None:
                    found = (m, saved)
                    break
            if found is None:
                print("[MiniMaxH3RefModApply] override=True but no valid saved curve "
                      f"was found — keeping {curve_source} and widget retention.")
            else:
                m, saved = found
                cfg = getattr(m, "config", None) or {}
                curve = saved
                curve_source = f"saved config {m.name}"
                if isinstance(cfg.get("retention"), (int, float)):
                    retention_source = f"saved config {m.name}"
                    retention = min(1.0, max(0.0, float(cfg["retention"])))
                print(f"[MiniMaxH3RefModApply] override: using config from '{m.name}' "
                      f"(retention={retention:.2f}, curve={curve[0]} + {curve[1]} "
                      f"@ {float(curve[2]):.2f})")
        ignored = []
        if curve_source != "widgets":
            ignored.append(f"curve_direction, curve_shape, curve_value (using {curve_source})")
        if retention_source != "widget":
            ignored.append(f"retention (using {retention_source})")
        if scramble_seed < 0 or len(mods) < 2:
            ignored.append("scramble_mode, scramble_keep (scrambling inactive)")
        elif scramble_mode in ("shuffle", "legacy_subset"):
            ignored.append(f"scramble_keep ({scramble_mode})")
        if ignored:
            print("[MiniMaxH3RefModApply] ignored: " + "; ".join(ignored))
        img = render_debug_grid(curve, preset_name)
        if save_preset_as:
            saved = _save_graph_preset(save_preset_as, curve, img)
            if saved:
                print(f"[MiniMaxH3RefModApply] graph preset saved: {saved}.png "
                      f"({curve[0]} + {curve[1]} @ {float(curve[2]):.2f})")
        blocks = _ref_blocks(mods, retention, curve, seed=scramble_seed,
                             scramble_mode=scramble_mode, scramble_keep=scramble_keep, max_total_tokens=max_total_tokens)
        if isinstance(conditioning, list):
            # built-in ComfyUI CONDITIONING (core MiniMaxH3ReferenceToVideo)
            out = []
            for t in conditioning:
                d = dict(t[1])
                d["minimax_refs"] = list(d.get("minimax_refs", [])) + blocks
                out.append([t[0], d])
            print(f"[MiniMaxH3RefModApply] retention={retention} "
                  f"({len(blocks)} ref block(s) injected)")
        else:
            # ComfyUI-MiniMaxH3 pack MINIMAX_H3_COND
            out = replace(conditioning, refs=list(conditioning.refs) + blocks)
            print(f"[MiniMaxH3RefModApply] retention={retention} "
                  f"({len(blocks)} ref block(s) injected, {len(out.refs)} total)")
        return io.NodeOutput(out, pil_to_tensor(img))


class MiniMaxH3RefModFolderLoader:
    """Load every image/video in a folder as an ordered ref list.

    Feed the ``refs_bundle`` input of Create H3 RefMod to bulk-extract a
    whole folder (e.g. all photos of a character).  Images load first (by
    filename), then videos; unreadable files are skipped with a note.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "folder": ("STRING", {"default": "",
                    "tooltip": "Folder with reference images/videos. An absolute path, or a folder "
                               "name inside ComfyUI's input/ directory (empty = input/ itself)."}),
                "max_items": ("INT", {"default": 32, "min": 1, "max": 256, "step": 1,
                    "display": "number",
                    "tooltip": "Max media files loaded (images first, then videos, by filename)."}),
                "max_frames": ("INT", {"default": 240, "min": 2, "max": 4800, "step": 1,
                    "display": "number",
                    "tooltip": "Video frames kept (uniformly sampled during decode, so a long video "
                               "is never fully decoded into RAM — memory stays bounded by this cap "
                               "x max_edge resolution). 240 = ~10s at 24fps."}),
                "max_edge": ("INT", {"default": 1024, "min": 256, "max": 4096, "step": 64,
                    "display": "number",
                    "tooltip": "Longest edge in px for loaded images/videos (downscale only, never "
                               "upscale). Loading many 4K files at native resolution is what OOMs "
                               "ComfyUI — the Extract node resizes to ref_resolution anyway, so "
                               "1024-1280 is plenty for folder extraction."}),
            },
        }

    RETURN_TYPES = ("H3_REF_LIST", "INT")
    RETURN_NAMES = ("refs", "count")
    FUNCTION = "load"
    CATEGORY = "MiniMax-H3/mod"

    @classmethod
    def VALIDATE_INPUTS(cls, folder):
        try:
            _resolve_folder(folder)
        except ValueError as exc:
            return str(exc)
        return True

    @classmethod
    def IS_CHANGED(cls, folder, max_items=32, max_frames=240, max_edge=1024):
        try:
            images, videos = list_media_files(_resolve_folder(folder))
            parts = []
            for p in (images + videos)[:max_items]:
                try:
                    st = os.stat(p)
                    parts.append(f"{os.path.basename(p)}:{st.st_size}:{int(st.st_mtime)}")
                except OSError:
                    parts.append(f"{os.path.basename(p)}:missing")
            return "|".join(parts)
        except Exception:
            return ""

    def load(self, folder, max_items=32, max_frames=240, max_edge=1024):
        folder = _resolve_folder(folder)
        images, videos = list_media_files(folder)
        items = (images + videos)[:max_items]
        total = len(items)
        refs, failed = [], []
        pbar = comfy.utils.ProgressBar(total)
        for i, p in enumerate(items, start=1):
            kind = "video" if p in videos else "image"
            print(f"[MiniMaxH3RefModFolderLoader] [{i}/{total}] loading {kind} "
                  f"{os.path.basename(p)}")
            try:
                if p in images:
                    refs.append(load_image_file(p, max_edge=max_edge))
                else:
                    refs.append(load_video_file(p, max_frames=max_frames, max_edge=max_edge))
            except Exception as exc:
                failed.append(f"{os.path.basename(p)} ({type(exc).__name__})")
                pbar.update_absolute(i)
                continue
            print(f"[MiniMaxH3RefModFolderLoader] [{i}/{total}] {os.path.basename(p)} "
                  f"-> {tuple(refs[-1].shape)}")
            pbar.update_absolute(i)
        if failed:
            print(f"[MiniMaxH3RefModFolderLoader] skipped unreadable files: {', '.join(failed)}")
        if not refs:
            raise ValueError(
                f"MiniMaxH3RefModFolderLoader: no images/videos found in {folder} "
                "(images: png/jpg/jpeg/webp/bmp/gif, videos: mp4/webm/mov/mkv/avi/m4v).")
        n_vid = sum(r.shape[0] > 1 for r in refs)
        print(f"[MiniMaxH3RefModFolderLoader] loaded {len(refs)} media from {folder} "
              f"({n_vid} video, {len(refs) - n_vid} image)")
        return (refs, len(refs))


class MiniMaxH3RefModMaskList:
    """Collect ComfyUI list items without batching or resizing their pixels."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"masks": ("MASK",)}}

    INPUT_IS_LIST = True
    RETURN_TYPES = ("H3_MASK_LIST",)
    RETURN_NAMES = ("mask_list",)
    FUNCTION = "collect"
    CATEGORY = "MiniMax-H3/mod"
    DESCRIPTION = ("Collect a MASK list or batch without resizing. Connect mask_list to Create H3 RefMod or Master. "
                   "Use one mask for all references, or one per image, video, then folder reference in order.")

    def collect(self, masks):
        items = []
        for mask in masks:
            batch = _normalize_mask_batch(mask)
            if batch is not None:
                items.extend(batch[i:i + 1] for i in range(batch.shape[0]))
        if not items:
            raise ValueError("Connect at least one mask to Collect H3 RefMod Masks.")
        return (items,)


class MiniMaxH3RefModExtract:
    """
    Turn one or more references of the same concept into a RefMod.

    Refs are added with the "+" button: stills plug into ``ref_image_1``,
    video frames into ``ref_video_1``, and the next slot of that type appears.
    Each ref is one row of the same concept (different angle / expression /
    setting / a dance move); they are stacked into a video-kind mod.

    Two modes:

      * ``encode`` (default) — each ref is resized to ``ref_resolution`` short
        edge (down only) and VAE-encoded at that resolution, exactly like the
        official ref2video node.  The mod stores the real encode, so identity
        (a face, an outfit) comes through; files are ~0.2-1 MB per frame.
        (Old name: ``full``.)
      * ``training`` — each ref is first resized to ``ref_resolution`` short
        edge too (the latent is pooled to a tiny grid anyway, so encoding at
        native resolution is wasted compute — this is the main speed dial for
        training mode), then average-pooled to a tiny grid (4x4 = 4 tokens
        per frame) and refined with gradient steps against the encode — still
        no diffusion model.  Nearly free to inject but only carries concept /
        motion, not fine identity.  (Old name: ``pooled``.)

    ``identity`` (training mode only) is the refinement loop — the only
    "training" in the pack.

    ``merge`` (training mode only): instead of stacking each ref's own pooled
    latent, one shared grid is refined jointly against *every* full encode
    (mean reconstruction error), so a collection lands on what's common
    across all the views — the cheap multi-exemplar analog of training, at
    one mod's token cost. See ``core.optimize_latent_multi``.

    ``motion_only`` (training mode only, experimental): video refs are
    converted to per-frame temporal differences (|f[t+1] - f[t]|) before
    encoding, so the latent carries where/how things move instead of what
    they look like — the static appearance never enters the mod. For a
    lineart animation this keeps the moving lines and drops the static
    drawing. Image refs have no motion and keep their appearance (warned).

    ``max_tokens`` (0 = off) hard-caps the total injected tokens: when the
    stacked refs exceed it, near-duplicate latent frames are dropped first,
    then frames are resampled to fit (see ``core.fit_token_budget``).
    """


    @classmethod
    def execute(cls, name, mode, refs_image=None, refs_video=None, refs_bundle=None,
                av_encoder=None, vae=None,
                ref_resolution=1024, pool_h=16, pool_w=16, latent_frames=16,
                identity=500, multiplier=1, max_tokens=0, description="", save=True,
                concept_type="generic", mask=None, background_retention=0.0, subfolder="",
                merge=False, motion_only=False, extraction_preset="manual", budget_policy="truncate", mask_list=None, **legacy) -> io.NodeOutput:
        if budget_policy not in ("truncate", "error"):
            raise ValueError("Unknown visual token budget policy.")
        name = _sanitize_name(name)
        # old pre-Autogrow workflows pass their widget values through as kwargs:
        # map them onto the new inputs so those saved workflows keep running.
        # ``pool`` is the old height; ``pool_w`` arrives as the named param.
        if legacy.get("optimize") is not None:
            identity = legacy["optimize"]
        if legacy.get("pool") is not None:
            pool_h = int(legacy["pool"])
            if pool_w == 16:  # old single-pool default: square grid
                pool_w = pool_h
        preset_replaced = ""
        if extraction_preset == "identity_encode":
            mode, ref_resolution, identity, merge, motion_only = "encode", 1024, 0, False, False
            preset_replaced = "mode=Full Reference, ref_resolution=1024, Refinement Steps=0, merge=False, motion_only=False"
        elif extraction_preset == "style_experimental":
            mode, pool_h, pool_w, identity, merge, motion_only = "training", 8, 8, 150, False, False
            preset_replaced = "mode=Compressed Reference, pool_h=8, pool_w=8, Refinement Steps=150, merge=False, motion_only=False"
        elif extraction_preset == "motion_sequence":
            mode, pool_h, pool_w, merge, motion_only = "training", 16, 16, False, False
            preset_replaced = "mode=Compressed Reference, pool_h=16, pool_w=16, merge=False, motion_only=False (frame limit and Refinement Steps preserved)"
        elif extraction_preset != "manual":
            raise ValueError("Unknown extraction preset.")
        mode = normalize_mode(mode)  # accept legacy 'full'/'pooled'
        if preset_replaced:
            print(f"[MiniMaxH3RefModExtract] preset={extraction_preset} replaces {preset_replaced}")
        ignored = []
        if mode == "encode":
            ignored.append("pool_h, pool_w, Refinement Steps, merge, motion_only (Full Reference)")
        if mask is None and mask_list is None:
            ignored.append("background_retention (no mask)")
        if max_tokens == 0:
            ignored.append("budget_policy (max_tokens=0)")
        if ignored:
            print("[MiniMaxH3RefModExtract] ignored: " + "; ".join(ignored))
        if concept_type == "identity" and mode == "training" and max(pool_h, pool_w) < 16:
            print(
                f"[MiniMaxH3RefModExtract] warning: concept_type='identity' with "
                f"mode='training' at a {pool_h}x{pool_w} grid — pooling averages away "
                f"exactly the detail that carries a face (this is almost certainly "
                f"your 'chubby/older' drift). For a person, either switch mode='encode' "
                f"(real identity, higher token cost) or raise pool_h/pool_w toward "
                f"32x32+ and expect it to still be a soft approximation, not a lock."
            )
        if av_encoder is None and vae is None:
            raise ValueError(
                "MiniMaxH3RefModExtract: connect an av_encoder (MiniMax-H3 "
                "VAE loader) or a standard VAE.")
        vae = _resolve_visual_vae(vae, av_encoder)

        # each Autogrow arrives as a dict keyed by its slot names
        # (ref_image_1..N / ref_video_1..N); videos stay multi-frame, images are
        # pinned to a single still.  Legacy workflows used flat image /
        # ref_image_N / ref_video_N inputs; a folder bundle is appended last.
        ordered = []
        for key in sorted((refs_image or {}).keys(),
                          key=lambda k: int(k.rsplit("_", 1)[1])):
            src = (refs_image or {})[key]
            if src is not None:
                ordered.append((src, False))
        for key in sorted((refs_video or {}).keys(),
                          key=lambda k: int(k.rsplit("_", 1)[1])):
            src = (refs_video or {})[key]
            if src is not None:
                ordered.append((src, True))
        legacy_keys = sorted(
            (k for k in legacy if k == "image" or k.startswith("ref_image_")
             or k.startswith("ref_video_")),
            key=lambda k: (0 if k == "image" else 1 if k.startswith("ref_image_") else 2,
                           int(k.rsplit("_", 1)[1]) if "_" in k else 0))
        for key in legacy_keys:
            if legacy[key] is not None:
                ordered.append((legacy[key], key.startswith("ref_video_")))
        if refs_bundle is not None:
            for src in refs_bundle:
                if src is not None:
                    norm = _normalize_ref(src, label="folder reference")
                    ordered.append((norm, norm.shape[0] > 1))
        if not ordered:
            raise ValueError(
                "MiniMaxH3RefModExtract: connect at least one image to "
                "ref_image_1, or video frames to ref_video_1, or a folder bundle.")
        if merge and mode != "training":
            print("[MiniMaxH3RefModExtract] warning: 'merge' only applies to "
                  "training mode — stacking the refs as usual for mode='encode'.")
        if motion_only and mode != "training":
            print("[MiniMaxH3RefModExtract] warning: 'motion_only' only applies to "
                  "training mode — extracting the full appearance for mode='encode'.")
            motion_only = False
        sources = []
        for i, (src, is_video) in enumerate(ordered):
            norm = _normalize_ref(src, label=f"reference {i + 1}")
            if is_video:
                sources.append((norm, norm.shape[0] > 1))
            else:
                # image slot: pin to a single still even if a batch arrived
                sources.append((norm[:1], False))
        # encode each source independently (full-res or pooled), then stack.
        # Full-res refs must share one spatial canvas so the stacked latent has
        # a single H/W: anchor on the first source, cover-crop the rest to it.
        canvas = None
        if mode == "encode" and len(sources) > 1:
            h, w = sources[0][0].shape[1], sources[0][0].shape[2]
            scale = min(1.0, ref_resolution / min(h, w))
            canvas = (max(32, round(w * scale / 32) * 32),
                      max(32, round(h * scale / 32) * 32))
        # training mode: anchor the pool grid to the first source's aspect so
        # a portrait person isn't squished into a square 16x16 grid (the
        # "fat" distortion).  The VAE scales space uniformly, so pixel
        # aspect == latent aspect.
        pool_grid = None
        if mode == "training":
            h0, w0 = sources[0][0].shape[1], sources[0][0].shape[2]
            pool_grid = aspect_grid(pool_h, pool_w, h0 / w0)
            if pool_grid != (pool_h, pool_w):
                print(f"[MiniMaxH3RefModExtract] pooled grid {pool_h}x{pool_w} -> "
                      f"{pool_grid[0]}x{pool_grid[1]} to match source aspect "
                      f"{w0}x{h0} (avoids squishing the subject wide)")
        gh, gw = pool_grid if pool_grid is not None else (pool_h, pool_w)

        if mask is not None and mask_list is not None:
            raise ValueError("Connect mask or mask_list, not both; their reference mapping is ambiguous.")
        masks = None
        if mask is not None or mask_list is not None:
            masks = MiniMaxH3RefModMaskList().collect([mask] if mask_list is None else mask_list)[0]
            if len(masks) == 1:
                masks = masks * len(sources)
            elif len(masks) != len(sources):
                raise ValueError(
                    f"MiniMaxH3RefModExtract: mask has {len(masks)} entries but "
                    f"there are {len(sources)} references (images then videos, in order). "
                    f"Connect one mask (broadcasts to every ref) or exactly one per ref.")

        frames = []
        n_img = n_vid = 0
        source_shapes = []
        n_refs = len(sources)
        motion_applied = False
        motion_warned = False
        # merge mode: hold each ref's pooled candidate + full encode, then
        # refine one shared latent against all of them jointly after the loop
        merge_refs = [] if (merge and mode == "training" and n_refs > 1) else None
        pbar = comfy.utils.ProgressBar(n_refs)
        for src_idx in range(len(sources)):
            src, is_video = sources[src_idx]
            label = f"ref {src_idx + 1}/{n_refs} ({'video' if is_video else 'image'})"
            print(f"[MiniMaxH3RefModExtract] {label}: "
                  f"source {tuple(src.shape)}, mode={mode}"
                  + (f", identity={identity} steps" if mode == "training" and identity > 0 else ""))
            if mode == "encode":
                # downscale (never upscale) to the target short edge, sample
                # videos to latent_frames frames, then encode at full res
                if is_video:
                    src = _sample_video_for_vae(src, latent_frames)
                src = _resize_ref(src, ref_resolution, canvas)
            else:
                # training mode: encode smaller too — the latent is pooled
                # to a tiny grid anyway, so encoding at native resolution is
                # wasted compute. Resize preserves aspect, so the pool grid
                # anchored on the first source's aspect still applies.
                orig = (src.shape[1], src.shape[2])
                src = _resize_ref(src, ref_resolution, None)
                if (src.shape[1], src.shape[2]) != orig:
                    print(f"[MiniMaxH3RefModExtract] {label}: resized "
                          f"{orig[0]}x{orig[1]} -> {src.shape[1]}x{src.shape[2]} "
                          f"(ref_resolution={ref_resolution}) before encode")
            if motion_only and is_video and src.shape[0] > 1:
                # temporal differences: |f[t+1] - f[t]|, normalized by the clip's
                # peak motion so static frames stay dark ("no motion here") and
                # moving parts light up — appearance never enters the latent
                d = (src[1:] - src[:-1]).abs()
                peak = d.max()
                if peak > 1e-6:
                    d = d / peak
                src = d
                motion_applied = True
                print(f"[MiniMaxH3RefModExtract] {label}: motion_only — "
                      f"encoded temporal differences instead of the frames "
                      f"(static appearance stripped)")
            elif motion_only and not is_video and not motion_warned:
                print("[MiniMaxH3RefModExtract] warning: motion_only needs video "
                      "refs — a still has no motion, keeping its appearance.")
                motion_warned = True
            src = _ensure_min_size(src)
            if is_video and src.shape[0] > 1:
                aligned = _sample_video_for_vae(src)
                if aligned.shape[0] != src.shape[0]:
                    print(f"[MiniMaxH3RefModExtract] reference {src_idx + 1} "
                          f"(video): sampling {src.shape[0]} -> {aligned.shape[0]} frames "
                          f"on H3's 17k+5 grid (short clips use the first image).")
                src = aligned
            mask_px = None
            if masks is not None:
                mask_px = _resize_mask(masks[src_idx], src.shape[1], src.shape[2],
                                       "center" if mode == "encode" and canvas is not None else "disabled")
            if src.shape[1] <= 0 or src.shape[2] <= 0:
                raise ValueError(
                    f"MiniMaxH3RefModExtract: reference {src_idx + 1} "
                    f"({'video' if is_video else 'image'}) has an empty frame "
                    f"{tuple(src.shape)} right before VAE encode (mode={mode}, "
                    f"ref_resolution={ref_resolution}, canvas={canvas}). "
                    f"Check that this specific reference's source image/video "
                    f"is valid.")
            z = vae.encode(src)
            if z.dim() != 5 or z.shape[1] != 24:
                raise ValueError(
                    f"Expected a MiniMax H3 video VAE latent [1,24,T,H,W], "
                    f"got {tuple(z.shape)}. The connected VAE is not the H3 VAE.")
            source_shapes.append(f"{z.shape[2]}x{z.shape[3]}x{z.shape[4]}")

            if mask_px is not None:
                z = _mask_latent(z, mask_px, background_retention, seed_key=f"{name}:{src_idx}")
                print(f"[MiniMaxH3RefModExtract] {label}: applied subject mask "
                      f"(background_retention={background_retention})")

            if mode == "encode":
                pooled = z.to(torch.float16)
            else:
                pool_t = min(latent_frames, z.shape[2]) if is_video else 1
                gh, gw = pool_grid if pool_grid is not None else (pool_h, pool_w)
                pooled = pool_latent(z, pool_t, gh, gw).to(torch.float16)
                if merge_refs is not None:
                    merge_refs.append((pooled.cpu(), z.float().cpu()))
                elif identity > 0:
                    print(f"[MiniMaxH3RefModExtract] {label}: refining identity "
                          f"({int(identity)} gradient steps)...")
                    pooled = optimize_latent(pooled, z.float(), steps=int(identity),
                                              progress_every=100)
                    print(f"[MiniMaxH3RefModExtract] {label}: identity refinement done")
            if merge_refs is None:
                frames.append(pooled)
            if is_video:
                n_vid += 1
            else:
                n_img += 1
            pbar.update_absolute(src_idx + 1)
            print(f"[MiniMaxH3RefModExtract] {label}: encoded "
                  f"{tuple(pooled.shape)} ({pooled.numel() * pooled.element_size() / 1024 / 1024:.2f} MB)")
            # drop the decoded source and the full-res latent as soon as we're
            # done with them, so a large folder doesn't keep every source +
            # every full encode resident while the remaining refs are encoded
            sources[src_idx] = None
            src = None
            z = None

        if mode == "encode" and identity > 0:
            print(f"[MiniMaxH3RefModExtract] warning: 'identity' only applies to "
                  f"training mode — encode mode stores the actual encode, so "
                  f"identity={identity} was ignored.")

        merged_n = 0
        if merge_refs is not None:
            # one shared grid refined against every full encode jointly, so the
            # result is the consensus of the collection, not any single shot
            common_t = max(p.shape[2] for p, _ in merge_refs)
            init = torch.stack([
                pool_latent(p, common_t, gh, gw) for p, _ in merge_refs
            ]).mean(0)
            print(f"[MiniMaxH3RefModExtract] merging {len(merge_refs)} references "
                  f"into one shared {common_t}x{gh}x{gw} latent"
                  + (f", {int(identity)} joint gradient steps" if identity > 0 else
                     " (pure pooling mean — identity=0)"))
            if identity > 0:
                init = optimize_latent_multi(
                    init, [f for _, f in merge_refs],
                    steps=int(identity), progress_every=100)
                print("[MiniMaxH3RefModExtract] merge refinement done")
            latent = init.to(torch.float16)
            merged_n = len(merge_refs)
        else:
            latent = torch.cat(frames, dim=2)  # [1, 24, total_t, h, w]
        if multiplier > 1:
            latent = latent.repeat(1, 1, multiplier, 1, 1)  # data multiplier
        if max_tokens > 0:
            tokens = latent.shape[2] * (latent.shape[3] // 2) * (latent.shape[4] // 2)
            if budget_policy == "error" and tokens > max_tokens:
                raise ValueError(f"RefMod '{name}' requires {tokens} visual tokens after multiplier; budget is {max_tokens}. Increase max_tokens, reduce extraction settings, or select truncate. Nothing was saved.")
            latent = fit_token_budget(latent, max_tokens, name)
        total_t = latent.shape[2]
        kind = "video" if total_t > 1 else "image"
        # the VAE encodes at 16x spatial scale, so a latent of 40x20 = 640x320 px
        px_w, px_h = latent.shape[4] * 16, latent.shape[3] * 16
        if merged_n:
            src = f"merge {merged_n} refs"
        elif len(frames) > 1:
            src = "stack"
        else:
            src = "video" if n_vid else "image"
        tags = [f"{n_img} img, {n_vid} vid"]
        if merged_n:
            tags.append(f"merged {merged_n} refs")
        if motion_applied:
            tags.append("motion_only")
        if multiplier > 1:
            tags.append(f"x{multiplier} repeat")
        if masks is not None:
            tags.append(f"masked (bg_retention={background_retention})")
        mod = H3RefMod(
            name=name,
            kind=kind,
            latent=latent,
            latent_h=latent.shape[3],
            latent_w=latent.shape[4],
            latent_t=total_t,
            mode=mode,
            source=src,
            source_shape=" +".join(source_shapes),
            pool=f"full-res {px_w}x{px_h}px (short-edge cap {ref_resolution}px)" if mode == "encode" else f"{total_t}x{gh}x{gw}",
            optimize_steps=int(identity) if mode == "training" else 0,
            tags=tags,
            description=(description or "").strip(),
            concept_type=concept_type,
        )

        if save:
            path_no_ext = mod_output_path(name, subfolder)
            path = mod.save(path_no_ext)
            mod.path = path_no_ext  # so Fix H3 RefMod Config can re-save in place
            _cache_mod(path_no_ext, mod)
            print(f"[MiniMaxH3RefModExtract] saved {_summarize(mod)} -> {path}")
        else:
            print(f"[MiniMaxH3RefModExtract] {_summarize(mod)} (not saved)")
        if mod.description:
            print(f"[MiniMaxH3RefModExtract] description: {mod.description}")
        details = json.dumps({"name": mod.name, "kind": mod.kind,
                              "latent_frames": mod.latent_t, "tokens": mod.token_count,
                              "source_shape": mod.source_shape,
                              "saved_paths": [path] if save else []}, indent=2, ensure_ascii=False)
        return io.NodeOutput([(mod, 1.0)], details, ui=ui.PreviewText(details))
