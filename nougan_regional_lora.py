# nougan_regional_lora.py — Nougan Regional Character LoRA (Krea2 / Flux-2 single-stream DiT)
# ------------------------------------------------------------------------------------------
# Place two trained character LoRAs into ONE coherent image, each concentrated in its own
# spatial region, WITHOUT identity blend — no compositing, no inpainting. The base model
# still generates a single image with full attention across the whole token sequence; this
# node only injects each character LoRA's *activation delta* (x @ downᵀ @ upᵀ · scale) into
# the image tokens that fall inside that character's region, via forward hooks on the
# Linear layers the LoRA actually targets.
#
# WHY THIS WORKS (vs. a LoRA stack): a normal LoRA load MERGES a low-rank weight delta into
# the model globally, so every pixel carries both identities -> blend. Here the deltas are
# never merged; they are added at forward time and masked to a token region, so identity A
# only reaches region A's tokens.
#
# SELF-DISCOVERING (does not hardcode recon answers):
#   * LoRA target layers are read from the file and matched to live model modules by
#     normalised name (collapses '_' vs '.', strips lora_unet_/diffusion_model_ prefixes).
#   * Fused-qkv vs separate q/k/v is irrelevant: we patch whatever Linear the LoRA targets.
#   * Text-token offset is measured from the real activation at hook time
#     (n_text = seq_len - n_image_tokens); image tokens assumed to be the trailing block
#     ([text | image], per Krea2). The first forward PRINTS the measured split so a
#     wrong assumption is immediately visible instead of silently mis-placing a region.
#
# NOUGAN IMPROVEMENTS over the standalone original:
#   * compute_precision toggle (bf16 fast / fp32 precise) — bf16 loses precision on small
#     deltas accumulated across many layers; fp32 is the fix for "identity looks slightly off".
#   * Self-diagnostic prints: matched-layer count at prepare, and the measured
#     seq / n_text / n_img on the first forward (confirms the trailing-image assumption).
#   * Loud warning (not a silent uniform mask) when n_img can't be placed in the sequence.
#   * Nougan class name + legacy IDs kept so existing graphs still load.

import os
import re
import json

import torch
import safetensors.torch

try:
    import folder_paths
except Exception:
    folder_paths = None

try:
    import comfy.patcher_extension as _pext
    _WRAPPER_ENUM = _pext.WrappersMP.DIFFUSION_MODEL
except Exception:
    _pext = None
    _WRAPPER_ENUM = "diffusion_model"

WRAPPER_KEY = "nougan_regional_character_lora"
__version__ = "1.1.0"


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
def _lora_dir_list():
    if folder_paths is not None:
        try:
            return folder_paths.get_filename_list("loras")
        except Exception:
            pass
    return []


def _resolve_lora_path(name):
    if folder_paths is not None:
        try:
            p = folder_paths.get_full_path("loras", name)
            if p:
                return p
        except Exception:
            pass
    return name  # assume an absolute path was given


def _norm(s):
    """Collapse a key/module name to a comparison signature."""
    s = s.lower()
    for pre in ("lora_unet_", "lora_te_", "lora_", "diffusion_model.",
                "diffusion_model_", "transformer.", "model.diffusion_model.",
                "model.", "base_model."):
        if s.startswith(pre):
            s = s[len(pre):]
    return s.replace(".", "").replace("_", "")


def _load_lora_matrices(path):
    """Return { module_sig: {'down':T, 'up':T, 'scale':float} } in fp32 on CPU.
    Handles kohya (lora_down/lora_up + alpha) and diffusers (lora_A/lora_B)."""
    sd = safetensors.torch.load_file(path)
    groups = {}
    alphas = {}
    for k, v in sd.items():
        if k.endswith(".alpha") or k.endswith("alpha"):
            base = re.sub(r"\.?alpha$", "", k)
            alphas[base] = float(v.flatten()[0].item())
            continue
        m = re.search(r"(.*?)\.(lora_down|lora_A)\.weight$", k)
        if m:
            groups.setdefault(m.group(1), {})["down"] = v.float()
            continue
        m = re.search(r"(.*?)\.(lora_up|lora_B)\.weight$", k)
        if m:
            groups.setdefault(m.group(1), {})["up"] = v.float()
            continue

    out = {}
    for base, mats in groups.items():
        if "down" not in mats or "up" not in mats:
            continue
        down, up = mats["down"], mats["up"]
        rank = down.shape[0]
        alpha = alphas.get(base, alphas.get(base + ".alpha", float(rank)))
        out[_norm(base)] = {
            "down": down,                       # [rank, in]
            "up": up,                           # [out, rank]
            "scale": float(alpha) / float(rank),
            "_dbg": base,
        }
    return out


def _iter_named_linears(module):
    for name, sub in module.named_modules():
        if isinstance(sub, torch.nn.Linear) or hasattr(sub, "weight"):
            yield name, sub


def _build_token_grid(w, h):
    # Krea2: VAE f8 (/8) then patch=2 (/2) -> /16 total. Row-major raster.
    cols = max(1, w // 16)
    rows = max(1, h // 16)
    return rows, cols


def _smoothstep_ramp(n, lo, hi):
    """1.0 left of lo, 0.0 right of hi, smooth ramp between (indices 0..n-1)."""
    xs = torch.arange(n, dtype=torch.float32)
    if hi <= lo:
        return (xs < lo).float()
    t = ((xs - lo) / (hi - lo)).clamp(0.0, 1.0)
    s = t * t * (3 - 2 * t)          # smoothstep
    return 1.0 - s


def _apply_blend(a, b, blend):
    # blend 0 -> pure regional ; blend 1 -> both at 0.5 everywhere (controlled merge)
    a = (1.0 - blend) * a + blend * 0.5
    b = (1.0 - blend) * b + blend * 0.5
    return a, b


def _masks_from_grid(split_mode, rows, cols, feather, blend):
    if split_mode == "horizontal_auto":
        ramp = _smoothstep_ramp(rows, rows / 2 - feather * rows, rows / 2 + feather * rows)
        a = ramp.unsqueeze(1).expand(rows, cols).reshape(-1)
    else:  # vertical_auto
        ramp = _smoothstep_ramp(cols, cols / 2 - feather * cols, cols / 2 + feather * cols)
        a = ramp.unsqueeze(0).expand(rows, cols).reshape(-1)
    b = 1.0 - a
    return _apply_blend(a, b, blend)


def _resolve_auto_split(rows, cols):
    """portrait/square -> vertical (L/R); landscape -> horizontal (T/B)."""
    return "horizontal_auto" if cols > rows else "vertical_auto"


def _rect_token_mask(rows, cols, nx0, ny0, nx1, ny1, feather):
    """Soft-edged rectangle (normalized coords) rendered onto the rows x cols grid."""
    c0, c1 = nx0 * cols, nx1 * cols
    r0, r1 = ny0 * rows, ny1 * rows
    fc = max(1e-3, feather * cols)
    fr = max(1e-3, feather * rows)
    cc = torch.arange(cols, dtype=torch.float32).unsqueeze(0)
    rr = torch.arange(rows, dtype=torch.float32).unsqueeze(1)
    in_x = torch.sigmoid((cc - c0) / fc) * torch.sigmoid((c1 - cc) / fc)
    in_y = torch.sigmoid((rr - r0) / fr) * torch.sigmoid((r1 - rr) / fr)
    return (in_y * in_x).reshape(-1).clamp(0.0, 1.0)


def _masks_from_regions(regions, rows, cols, feather, blend):
    """Parse the JS editor's regions JSON: [{x,y,w,h,char:'a'|'b'}, ...] in
    normalized 0-1 coords. Union of each character's rects -> two token masks."""
    try:
        items = json.loads(regions) if isinstance(regions, str) else regions
    except Exception:
        return None
    if not isinstance(items, list) or not items:
        return None
    n = rows * cols
    ma = torch.zeros(n)
    mb = torch.zeros(n)
    na = nb = 0
    for it in items:
        if not isinstance(it, dict):
            continue
        try:
            x = float(it["x"]); y = float(it["y"])
            w = float(it.get("w", it.get("width", 0)))
            h = float(it.get("h", it.get("height", 0)))
        except Exception:
            continue
        if w <= 0 or h <= 0:
            continue
        ch = str(it.get("char", "a")).lower()
        m = _rect_token_mask(rows, cols, x, y, x + w, y + h, feather)
        if ch == "b":
            mb = torch.maximum(mb, m); nb += 1
        else:
            ma = torch.maximum(ma, m); na += 1
    if na == 0 and nb == 0:
        return None
    if na == 0:
        ma = 1.0 - mb
    if nb == 0:
        mb = 1.0 - ma
    return _apply_blend(ma, mb, blend)


def _mask_from_bbox(bboxes, idx, rows, cols, w, h, feather):
    n = rows * cols
    if idx >= len(bboxes):
        return torch.zeros(n)
    x0, y0, x1, y1 = _coerce_bbox(bboxes[idx], w, h)
    c0, c1 = x0 / w * cols, x1 / w * cols
    r0, r1 = y0 / h * rows, y1 / h * rows
    fc = max(1e-3, feather * cols)
    fr = max(1e-3, feather * rows)
    cc = torch.arange(cols).float().unsqueeze(0)
    rr = torch.arange(rows).float().unsqueeze(1)
    in_x = (torch.sigmoid((cc - c0) / fc) * torch.sigmoid((c1 - cc) / fc))
    in_y = (torch.sigmoid((rr - r0) / fr) * torch.sigmoid((r1 - rr) / fr))
    return (in_y * in_x).reshape(-1).clamp(0.0, 1.0)


def _coerce_bbox(box, w, h):
    vals = list(box) if not isinstance(box, dict) else [
        box.get("x", box.get("x0", 0)), box.get("y", box.get("y0", 0)),
        box.get("x1", box.get("x", 0) + box.get("w", box.get("width", 0))),
        box.get("y1", box.get("y", 0) + box.get("h", box.get("height", 0)))]
    x0, y0, x1, y1 = [float(v) for v in vals[:4]]
    if max(x0, y0, x1, y1) <= 1.0:
        x0, x1 = x0 * w, x1 * w
        y0, y1 = y0 * h, y1 * h
    if x1 < x0:
        x0, x1 = x1, x0
    if y1 < y0:
        y0, y1 = y1, y0
    return x0, y0, x1, y1


def _flatten_bboxes(bboxes):
    """KJ/BoundingBox output is per-frame nested list[list[dict]]; unwrap to flat (frame 0)."""
    if not bboxes:
        return []
    try:
        first = bboxes[0]
    except Exception:
        return []
    if isinstance(first, (list, tuple)):
        return list(first)
    return list(bboxes)


def _masks_from_boxlist(boxes, rows, cols, w, h, feather, blend):
    """box[0] -> A, box[1] -> B (draw order). One box -> B is the complement of A."""
    ma = _mask_from_bbox(boxes, 0, rows, cols, w, h, feather)
    mb = _mask_from_bbox(boxes, 1, rows, cols, w, h, feather) if len(boxes) > 1 else (1.0 - ma)
    return _apply_blend(ma, mb, blend)


def _mask_to_token_grid(mask, rows, cols):
    """Resize a full-canvas MASK [.,H,W] down to the token grid (rows x cols) and
    flatten row-major to [n_image_tokens], matching image-token order."""
    import torch.nn.functional as F
    m = mask
    if m.dim() == 2:
        m = m.unsqueeze(0)
    if m.dim() == 3:
        m = m.unsqueeze(1)
    m = m.float()
    m = F.interpolate(m, size=(rows, cols), mode="bilinear", align_corners=False)
    return m[0, 0].reshape(-1).clamp(0.0, 1.0)


# ---------------------------------------------------------------------------
# forward-time delta injection
# ---------------------------------------------------------------------------
def _make_hook(session, entry):
    """Forward hook: out += mask_a*delta_a + mask_b*delta_b on the image-token tail.
    Heavy tensors (LoRA up/down, masks) are pre-moved to device + compute dtype ONCE
    in session._prepare(), so the hook only does two matmuls per side."""
    a = entry.get("a")
    b = entry.get("b")

    def hook(module, inp, out):
        if not torch.is_tensor(out) or out.dim() < 2:
            return out
        x = inp[0]
        if not torch.is_tensor(x) or x.dim() < 2:
            return out
        seq = x.shape[-2]
        session._maybe_diag_seq(seq)              # one-time measured text/image split
        xf = x.to(session.cdt)
        res = None
        if a is not None:
            da = (xf @ a["down_d"].t()) @ a["up_d"].t()
            res = session._full_mask("a", seq, out.dim()) * da
        if b is not None:
            db = (xf @ b["down_d"].t()) @ b["up_d"].t()
            mb = session._full_mask("b", seq, out.dim()) * db
            res = mb if res is None else res + mb
        if res is None:
            return out
        return out + res.to(out.dtype)

    return hook


class _RegionalSession:
    """Holds per-apply config; builds masks at RUNTIME from the real latent grid, then
    installs/removes hooks each forward."""
    def __init__(self, patcher, lora_a, lora_b, strength_a, strength_b,
                 split_mode, seam_feather, blend_override, bboxes,
                 mask_a_in, mask_b_in, regions_str="",
                 compute_dtype=torch.bfloat16, debug=False):
        self.patcher = patcher
        self.lora_a, self.lora_b = lora_a, lora_b
        self.strength_a, self.strength_b = strength_a, strength_b
        self.split_mode = split_mode
        self.seam_feather = seam_feather
        self.blend_override = blend_override
        self.bboxes = bboxes
        self.mask_a_in, self.mask_b_in = mask_a_in, mask_b_in
        self.regions_str = regions_str
        self.cdt = compute_dtype
        self.debug = debug
        self.n_img = 0
        self.mask_a = None
        self.mask_b = None
        self._layer_map = None
        self._prepared = False
        self._full_mask_cache = {}
        self._diag_seq_done = False
        self._n_img_warned = False

    def _diffusion_model(self):
        m = self.patcher.model
        return getattr(m, "diffusion_model", m)

    def _build_layer_map(self, dm):
        amap, bmap = {}, {}
        for sig, d in self.lora_a.items():
            amap[sig] = {**d, "scale": d["scale"] * self.strength_a}
        for sig, d in self.lora_b.items():
            bmap[sig] = {**d, "scale": d["scale"] * self.strength_b}
        layer_map = {}
        matched = 0
        for name, mod in _iter_named_linears(dm):
            sig = _norm(name)
            entry = {}
            if sig in amap:
                entry["a"] = amap[sig]
            if sig in bmap:
                entry["b"] = bmap[sig]
            if entry:
                layer_map[name] = (mod, entry)
                matched += 1
        # DIAGNOSTIC #2: is the LoRA actually hooking enough layers?
        print(f"[NouganRegionalLoRA] matched {matched} layers "
              f"(A:{len(amap)} B:{len(bmap)} targets in file).")
        if matched == 0:
            print("[NouganRegionalLoRA] !! 0 layers matched — characters will NOT appear. "
                  "Run recon_krea2.py and compare LoRA stems vs UNet module names.")
        elif matched < max(len(amap), len(bmap)) * 0.5:
            print("[NouganRegionalLoRA] ⚠️  fewer than half the LoRA targets matched — "
                  "identity may be weak/inconsistent. Check recon Q3 key naming.")
        self._matched = matched
        return layer_map

    def _infer_device(self, dm, args):
        x0 = args[0] if args else None
        if torch.is_tensor(x0):
            return x0.device
        try:
            return next(dm.parameters()).device
        except StopIteration:
            return torch.device("cpu")

    def _resolve_grid(self, x):
        """Token grid (rows, cols) from the runtime latent [B,C,H,W]; Krea2 patch size = 2."""
        if torch.is_tensor(x) and x.dim() >= 4:
            H, W = int(x.shape[-2]), int(x.shape[-1])
            rows, cols = H // 2, W // 2
            if rows > 0 and cols > 0:
                return rows, cols, "latent"
        rows, cols = _build_token_grid(1024, 1536)   # fallback if latent unreadable
        return rows, cols, "canvas-fallback"

    def _build_masks_now(self, rows, cols):
        feather, blend = self.seam_feather, self.blend_override
        pw, ph = cols * 16, rows * 16

        # painted MASK sockets are an always-on advanced override
        if self.mask_a_in is not None or self.mask_b_in is not None:
            ma = _mask_to_token_grid(self.mask_a_in, rows, cols) if self.mask_a_in is not None else None
            mb = _mask_to_token_grid(self.mask_b_in, rows, cols) if self.mask_b_in is not None else None
            if ma is None:
                ma = 1.0 - mb
            if mb is None:
                mb = 1.0 - ma
            a, b = _apply_blend(ma, mb, blend)
            return a, b, "mask-socket"

        mode = self.split_mode

        # manual = the on-node visual editor (regions JSON)
        if mode == "manual":
            res = _masks_from_regions(self.regions_str, rows, cols, feather, blend)
            if res is not None:
                a, b = res
                return a, b, "manual"
            mode = "auto"   # nothing drawn yet -> sensible fallback

        # bbox = KJ/BoundingBox wire
        if mode == "bbox":
            wire = _flatten_bboxes(self.bboxes)
            if wire:
                a, b = _masks_from_boxlist(wire, rows, cols, pw, ph, feather, blend)
                return a, b, "bbox-wire(%d)" % len(wire)
            mode = "auto"

        if mode == "auto":
            mode = _resolve_auto_split(rows, cols)
        a, b = _masks_from_grid(mode, rows, cols, feather, blend)
        return a, b, mode

    def _prepare(self, dev, x):
        cdt = self.cdt
        self._dev = dev
        for name, (mod, entry) in self._layer_map.items():
            for side in ("a", "b"):
                d = entry.get(side)
                if d is None or "down_d" in d:
                    continue
                d["down_d"] = d["down"].to(dev, cdt)
                d["up_d"] = d["up"].to(dev, cdt) * d["scale"]
        rows, cols, src = self._resolve_grid(x)
        self.n_img = rows * cols
        a, b, used = self._build_masks_now(rows, cols)
        self.mask_a, self.mask_b = a, b
        self._mask_a_d = a.to(dev, cdt)
        self._mask_b_d = b.to(dev, cdt)
        self._full_mask_cache = {}
        self._grid_info = (rows, cols, src, used)
        self._prepared = True

    def _maybe_diag_seq(self, seq):
        """DIAGNOSTIC #1 (the big one): print the MEASURED text/image split on the first
        forward so a wrong trailing-image assumption is visible, not silent."""
        if self._diag_seq_done:
            return
        self._diag_seq_done = True
        n_img = self.n_img
        n_text = seq - n_img
        rows, cols, src, used = self._grid_info
        print(f"[NouganRegionalLoRA] forward: seq={seq}  n_text={n_text}  n_img={n_img} "
              f"(grid {rows}x{cols}, {src})  split={used}  dtype={self.cdt}")
        if n_img <= 0 or n_img > seq:
            print(f"[NouganRegionalLoRA] !! n_img ({n_img}) does not fit in seq ({seq}) — "
                  f"falling back to a UNIFORM mask (both characters everywhere = blend). "
                  f"The trailing-image-token assumption is wrong for this model; the region "
                  f"masks cannot be placed. Report this seq/n_img pair.")
        elif n_text < 0:
            print(f"[NouganRegionalLoRA] ⚠️  negative n_text ({n_text}) — image-token count "
                  f"exceeds the sequence; check the patch size / grid math.")
        elif self.debug:
            print(f"[NouganRegionalLoRA] image tokens assumed trailing: base[{seq - n_img}:] = mask")

    def _full_mask(self, side, seq, ndim):
        """Cached full-sequence mask: zeros over text prefix, mask over image tail."""
        key = (side, seq, ndim)
        fm = self._full_mask_cache.get(key)
        if fm is None:
            mv = self._mask_a_d if side == "a" else self._mask_b_d
            base = torch.zeros(seq, device=self._dev, dtype=self.cdt)
            n_img = self.n_img
            if n_img <= 0 or n_img > seq:
                base[:] = mv.mean()
            else:
                base[seq - n_img:] = mv
            fm = base.view(*([1] * (ndim - 2)), seq, 1)
            self._full_mask_cache[key] = fm
        return fm

    def run(self, executor, *args, **kwargs):
        dm = self._diffusion_model()
        if self._layer_map is None:
            self._layer_map = self._build_layer_map(dm)
        if not self._prepared:
            dev = self._infer_device(dm, args)
            x0 = args[0] if args else None
            self._prepare(dev, x0)
            rows, cols, src, used = self._grid_info
            shp = tuple(x0.shape) if torch.is_tensor(x0) else None
            print(f"[NouganRegionalLoRA] prepared on {dev} | latent={shp} "
                  f"grid={rows}x{cols} ({src}) n_img={self.n_img} split={used}")
        handles = []
        try:
            for name, (mod, entry) in self._layer_map.items():
                handles.append(mod.register_forward_hook(_make_hook(self, entry)))
            return executor(*args, **kwargs)
        finally:
            for h in handles:
                h.remove()


# ---------------------------------------------------------------------------
# the node
# ---------------------------------------------------------------------------
class NouganRegionalCharacterLoRA:
    @classmethod
    def INPUT_TYPES(cls):
        loras = _lora_dir_list() or ["<put .safetensors in models/loras>"]
        return {
            "required": {
                "model": ("MODEL",),
                "lora_a": (loras,),
                "strength_a": ("FLOAT", {"default": 1.0, "min": -4.0, "max": 4.0, "step": 0.05}),
                "lora_b": (loras,),
                "strength_b": ("FLOAT", {"default": 1.0, "min": -4.0, "max": 4.0, "step": 0.05}),
                "split_mode": (["manual", "auto", "vertical_auto", "horizontal_auto", "bbox"],),
                "seam_feather": ("FLOAT", {"default": 0.08, "min": 0.0, "max": 0.3, "step": 0.01}),
                "blend_override": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 1.0, "step": 0.05}),
                "compute_precision": (["bf16 (fast)", "fp32 (precise)"],
                                      {"default": "bf16 (fast)",
                                       "tooltip": "bf16 is faster but loses precision on small LoRA "
                                                  "deltas accumulated across many layers. Switch to "
                                                  "fp32 if a character looks slightly off / inconsistent."}),
            },
            "optional": {
                "regions": ("STRING", {"default": "", "tooltip": "managed by the visual editor widget"}),
                "bboxes": ("BOUNDINGBOX",),
                "mask_a": ("MASK",),
                "mask_b": ("MASK",),
                "debug": ("BOOLEAN", {"default": False,
                                      "tooltip": "Print extra per-run diagnostics (token placement)."}),
            },
        }

    RETURN_TYPES = ("MODEL",)
    FUNCTION = "apply"
    CATEGORY = "conditioning/regional"
    TITLE = "Nougan Regional Character LoRA 🎭"

    def apply(self, model, lora_a, strength_a, lora_b, strength_b, split_mode,
              seam_feather, blend_override, compute_precision="bf16 (fast)",
              regions="", bboxes=None, mask_a=None, mask_b=None, debug=False):
        la = _load_lora_matrices(_resolve_lora_path(lora_a))
        lb = _load_lora_matrices(_resolve_lora_path(lora_b))

        cdt = torch.float32 if str(compute_precision).startswith("fp32") else torch.bfloat16

        patched = model.clone()
        session = _RegionalSession(
            patched, la, lb, strength_a, strength_b,
            split_mode, seam_feather, blend_override, bboxes,
            mask_a, mask_b, regions,
            compute_dtype=cdt, debug=bool(debug))

        def wrapper(executor, *args, **kwargs):
            return session.run(executor, *args, **kwargs)

        if hasattr(patched, "add_wrapper_with_key"):
            patched.add_wrapper_with_key(_WRAPPER_ENUM, WRAPPER_KEY, wrapper)
        elif hasattr(patched, "add_wrapper"):
            patched.add_wrapper(_WRAPPER_ENUM, wrapper)
        else:
            raise RuntimeError(
                "This ComfyUI build lacks model wrapper support "
                "(add_wrapper_with_key). Update ComfyUI.")
        return (patched,)