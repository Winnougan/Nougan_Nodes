"""MiniMax-H3 AdaLN dense ↔ curve LoRA basis conversion for Nougan Lora Loader.

H3 ships in two forms:
  - Dense:  adaln_proj.linear takes silu(time_embedder(t))  → 2688-dim
  - Curve:  adaln_proj.linear takes a row of adaln_t_table  → 8-dim

A LoRA trained on the dense form carries lora_A of width 2688.  When ComfyUI
tries to apply it to a curve checkpoint it computes a 260112384-element delta
and fails the reshape onto [96768, 8], logging one ERROR per block and silently
skipping the AdaLN half of the adapter.

The two spaces are related by an affine map recovered by least squares:

    S(t) = c + V @ table(t)          V: [2688, k],  c: [2688]

dense → curve:  A' = A @ V ,  bias delta = B @ (A @ c)
curve → dense:  A' = A @ pinv(V), bias delta = -B @ (A' @ c)

The bias term is the DC component; dropping it makes the port nearly worthless
for turbo / Acc / PDD LoRAs.
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import struct
from typing import Optional

import torch
import torch.nn.functional as F

LOG = logging.getLogger("Nougan.H3AdaLN")

GRID_ROWS = 1025
FREQ_DIM = 256
MAX_RESIDUAL = 5e-3
BASIS_SUBDIR = "h3_adaln"
GRID_FILENAME = "h3_silu_temb_grid.safetensors"
GRID_TENSOR_KEY = "silu_t_emb_grid"

TE_IN_W = "time_embedder.proj_in.weight"
TE_IN_B = "time_embedder.proj_in.bias"
TE_OUT_W = "time_embedder.proj_out.weight"
TE_OUT_B = "time_embedder.proj_out.bias"

_A_SUFFIXES = (
    "lora_A.weight", "lora_A.default.weight", "lora_A",
    "lora_down.weight", "_lora.down.weight", "lora.down.weight",
    "lora_linear_layer.down.weight",
)
_B_SUFFIXES = (
    "lora_B.weight", "lora_B.default.weight", "lora_B",
    "lora_up.weight", "_lora.up.weight", "lora.up.weight",
    "lora_linear_layer.up.weight",
)

_basis_cache: dict = {}
_grid_cache: dict = {}


def _cpu_f32(t: torch.Tensor) -> torch.Tensor:
    return t.detach().to(device="cpu", dtype=torch.float32).contiguous()


def tensor_hash(t: torch.Tensor) -> str:
    t = _cpu_f32(t)
    h = hashlib.sha256()
    h.update(str(tuple(t.shape)).encode())
    h.update(t.numpy().tobytes())
    return h.hexdigest()[:16]


def silu_temb_grid(proj_in_w, proj_in_b, proj_out_w, proj_out_b,
                   rows=GRID_ROWS, freq_dim=FREQ_DIM) -> torch.Tensor:
    t = torch.arange(rows, dtype=torch.float32) / float(rows - 1)
    half = freq_dim // 2
    freqs = torch.exp(-math.log(10000.0) * torch.arange(half, dtype=torch.float32) / half)
    args = t[:, None] * freqs[None]
    emb = torch.cat([torch.cos(args), torch.sin(args)], dim=-1)
    hidden = F.silu(emb @ proj_in_w.float().T + proj_in_b.float())
    temb = hidden @ proj_out_w.float().T + proj_out_b.float()
    return F.silu(temb)


def solve_basis(table: torch.Tensor, grid: torch.Tensor):
    table = _cpu_f32(table)
    grid = _cpu_f32(grid)
    if table.shape[0] != grid.shape[0]:
        raise ValueError(f"table rows {table.shape[0]} != grid rows {grid.shape[0]}")
    ones = torch.ones(table.shape[0], 1, dtype=torch.float64)
    design = torch.cat([ones, table.to(torch.float64)], dim=1)
    sol = torch.linalg.lstsq(design, grid.to(torch.float64)).solution
    resid = design @ sol - grid.to(torch.float64)
    denom = grid.norm().clamp(min=1e-12)
    rel = float(resid.norm() / denom)
    c = sol[0].to(torch.float32).contiguous()
    V = sol[1:].T.to(torch.float32).contiguous()
    return c, V, rel


def _safetensors_header(path: str):
    try:
        with open(path, "rb") as fh:
            raw = fh.read(8)
            if len(raw) < 8:
                return None
            size = struct.unpack("<Q", raw)[0]
            if size <= 0 or size > (64 << 20):
                return None
            return json.loads(fh.read(size))
    except Exception:
        return None


def _time_embedder_prefix(header) -> Optional[str]:
    if not header:
        return None
    if any(k.endswith("adaln_t_table") for k in header):
        return None
    for key in header:
        if key.endswith(TE_OUT_W):
            prefix = key[: -len(TE_OUT_W)]
            if all(prefix + n in header for n in (TE_IN_W, TE_IN_B, TE_OUT_B)):
                return prefix
    return None


def _load_named(path: str, names):
    from safetensors import safe_open
    with safe_open(path, framework="pt") as f:
        return [_cpu_f32(f.get_tensor(n)) for n in names]


def _grid_from_checkpoint(path: str, rows=GRID_ROWS) -> Optional[torch.Tensor]:
    try:
        prefix = _time_embedder_prefix(_safetensors_header(path))
        if prefix is None:
            return None
        tensors = _load_named(path, [prefix + n for n in (TE_IN_W, TE_IN_B, TE_OUT_W, TE_OUT_B)])
        return silu_temb_grid(*tensors, rows=rows)
    except Exception:
        return None


def _basis_dir() -> str:
    try:
        import folder_paths
        return os.path.join(folder_paths.models_dir, BASIS_SUBDIR)
    except Exception:
        return ""


def _cache_path(key: str) -> str:
    d = _basis_dir()
    return os.path.join(d, f"basis_{key}.safetensors") if d else ""


def _read_basis_cache(key: str):
    path = _cache_path(key)
    if not path or not os.path.isfile(path):
        return None
    try:
        from safetensors import safe_open
        with safe_open(path, framework="pt") as f:
            meta = f.metadata() or {}
            return (
                _cpu_f32(f.get_tensor("c")),
                _cpu_f32(f.get_tensor("V")),
                float(meta.get("residual", "nan")),
                meta.get("source", "cache"),
            )
    except Exception:
        return None


def _write_basis_cache(key: str, c, V, residual, source: str):
    path = _cache_path(key)
    if not path:
        return
    try:
        from safetensors.torch import save_file
        os.makedirs(os.path.dirname(path), exist_ok=True)
        save_file(
            {"c": c.contiguous(), "V": V.contiguous()},
            path,
            metadata={"residual": repr(residual), "source": source, "table_hash": key},
        )
    except Exception:
        pass


def _iter_diffusion_safetensors():
    try:
        import folder_paths
    except Exception:
        return
    for name in folder_paths.get_filename_list("diffusion_models"):
        if not name.lower().endswith(".safetensors"):
            continue
        path = folder_paths.get_full_path("diffusion_models", name)
        if path:
            yield os.path.basename(name), path


def _candidate_grids(rows: int):
    try:
        import folder_paths
    except Exception:
        return

    for name, path in _iter_diffusion_safetensors():
        grid = _grid_from_checkpoint(path, rows)
        if grid is not None:
            yield name, grid

    seen = set()
    search = [_basis_dir()]
    try:
        search += list(folder_paths.get_folder_paths("loras"))
        search += list(folder_paths.get_folder_paths("diffusion_models"))
    except Exception:
        pass

    for directory in search:
        if not directory or not os.path.isdir(directory):
            continue
        path = os.path.join(directory, GRID_FILENAME)
        if path in seen or not os.path.isfile(path):
            continue
        seen.add(path)
        try:
            from safetensors import safe_open
            with safe_open(path, framework="pt") as f:
                keys = list(f.keys())
                key = GRID_TENSOR_KEY if GRID_TENSOR_KEY in keys else (keys[0] if len(keys) == 1 else None)
                if key is None:
                    continue
                grid = _cpu_f32(f.get_tensor(key))
            yield f"{GRID_FILENAME} ({os.path.basename(directory)})", grid
        except Exception:
            continue


def get_basis_for_table(table: torch.Tensor, use_cache=True):
    key = tensor_hash(table)
    if use_cache:
        cached = _read_basis_cache(key)
        if cached is not None:
            return cached

    best = None
    for label, grid in _candidate_grids(table.shape[0]):
        try:
            c, V, rel = solve_basis(table, grid)
        except Exception:
            continue
        if best is None or rel < best[2]:
            best = (c, V, rel, label)

    if best is not None and use_cache:
        _write_basis_cache(key, best[0], best[1], best[2], best[3])
    return best


def _diffusion_model(model):
    m = getattr(model, "model", model)
    return getattr(m, "diffusion_model", m)


def is_h3_curve_model(model) -> bool:
    dm = _diffusion_model(model)
    if getattr(dm, "use_adaln_curves", False):
        return True
    if hasattr(dm, "adaln_t_table") and dm.adaln_t_table is not None:
        return True
    return False


def get_model_table(model) -> Optional[torch.Tensor]:
    dm = _diffusion_model(model)
    table = getattr(dm, "adaln_t_table", None)
    if table is not None and torch.is_tensor(table):
        return table
    return None


def get_target_dim(model) -> int:
    dm = _diffusion_model(model)
    try:
        for name, mod in dm.named_modules():
            if name.endswith("adaln_proj.linear") or name.endswith("adaln_proj"):
                w = getattr(mod, "weight", None)
                if w is not None and w.ndim == 2:
                    return int(w.shape[1])
    except Exception:
        pass
    if is_h3_curve_model(model):
        return 8
    return 2688


def port_lora_sd(sd: dict, model, strength_model: float = 1.0) -> tuple[dict, dict]:
    stats = {"ported": 0, "ok": 0, "skipped": 0, "residual": None, "direction": None}

    modules: dict[str, dict] = {}
    for key in list(sd.keys()):
        if ".adaln_proj.linear." not in key:
            continue
        body, _, suffix = key.rpartition(".adaln_proj.linear.")
        stem = body + ".adaln_proj.linear"
        modules.setdefault(stem, {})[suffix] = key

    if not modules:
        return sd, stats

    target_dim = get_target_dim(model)
    table = get_model_table(model)
    is_curve = is_h3_curve_model(model) or target_dim == 8

    basis = None
    if table is not None and is_curve:
        basis = get_basis_for_table(table)
        if basis is not None:
            stats["residual"] = basis[2]
            if basis[2] > MAX_RESIDUAL:
                LOG.warning(
                    "[Nougan] AdaLN basis residual %.2e exceeds %.0e — port may be inaccurate",
                    basis[2], MAX_RESIDUAL,
                )

    out = dict(sd)

    for stem, parts in modules.items():
        a_key = next((parts[s] for s in _A_SUFFIXES if s in parts), None)
        b_key = next((parts[s] for s in _B_SUFFIXES if s in parts), None)
        if a_key is None or b_key is None:
            continue

        a = sd[a_key]
        b = sd[b_key]
        if not (torch.is_tensor(a) and torch.is_tensor(b)):
            continue
        if a.ndim != 2 or b.ndim != 2 or b.shape[1] != a.shape[0]:
            LOG.warning("[Nougan] malformed AdaLN pair %s — skipped", stem)
            stats["skipped"] += 1
            continue

        source_dim = a.shape[1]

        if source_dim == target_dim:
            stats["ok"] += 1
            continue

        if basis is None:
            LOG.info(
                "[Nougan] AdaLN pair %s width %d → target %d but no basis available — skipped",
                stem, source_dim, target_dim,
            )
            stats["skipped"] += 1
            for k in parts.values():
                out.pop(k, None)
            continue

        c, V, residual, source = basis
        stats["residual"] = residual

        a32 = a.to(torch.float32)
        b32 = b.to(torch.float32)

        alpha_key = parts.get("alpha")
        scale = float(strength_model)
        if alpha_key is not None and alpha_key in sd:
            try:
                alpha = sd[alpha_key]
                alpha_val = float(alpha.item() if hasattr(alpha, "item") else alpha)
                scale *= alpha_val / max(a.shape[0], 1)
            except Exception:
                pass

        if source_dim == V.shape[0] and target_dim == V.shape[1]:
            a_new = a32 @ V.to(a32.device)
            const = a32 @ c.to(a32.device)
            sign = 1.0
            stats["direction"] = "dense→curve"
        elif source_dim == V.shape[1] and target_dim == V.shape[0]:
            pinv = torch.linalg.pinv(V.to(a32.device))
            a_new = a32 @ pinv
            const = a_new @ c.to(a32.device)
            sign = -1.0
            stats["direction"] = "curve→dense"
        else:
            LOG.warning(
                "[Nougan] AdaLN pair %s width %d incompatible with basis %s→%s — skipped",
                stem, source_dim, V.shape[0], V.shape[1],
            )
            for k in parts.values():
                out.pop(k, None)
            stats["skipped"] += 1
            continue

        bias_delta = sign * scale * (b32 @ const)

        out.pop(a_key, None)
        out.pop(b_key, None)
        if alpha_key and alpha_key in out:
            out[stem + ".alpha"] = out.pop(alpha_key)

        out[stem + ".lora_A.weight"] = a_new.to(a.dtype)
        out[stem + ".lora_B.weight"] = b
        out[stem + ".diff_b"] = bias_delta.to(b.dtype)

        stats["ported"] += 1

    if stats["ported"]:
        LOG.info(
            "[Nougan] AdaLN port %s: %d pairs rewritten (residual %.2e, source %s)",
            stats.get("direction") or "?",
            stats["ported"],
            stats["residual"] or float("nan"),
            basis[3] if basis else "?",
        )
    if stats["skipped"]:
        LOG.info("[Nougan] AdaLN port: %d pairs skipped (no basis or malformed)", stats["skipped"])

    return out, stats


def should_try_port(model) -> bool:
    try:
        dm = _diffusion_model(model)
        if getattr(dm, "use_adaln_curves", None) is not None:
            return True
        if hasattr(dm, "adaln_t_table"):
            return True
        for name, _ in dm.named_modules():
            if "adaln_proj" in name:
                return True
            if name.count(".") > 6:
                break
    except Exception:
        pass
    return False