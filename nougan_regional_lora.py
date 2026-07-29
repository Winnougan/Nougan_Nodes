"""nougan_regional_lora.py — Nougan Regional Character LoRA"""

import json
import re
import torch
import folder_paths

try:
    import safetensors.torch
except ImportError:
    safetensors = None

try:
    import comfy.patcher_extension as _pext
    _WRAPPER_ENUM = _pext.WrappersMP.DIFFUSION_MODEL
except Exception:
    _pext = None
    _WRAPPER_ENUM = "diffusion_model"

WRAPPER_KEY = "nougan_regional_lora"


def _lora_list():
    try:
        return folder_paths.get_filename_list("loras")
    except Exception:
        return ["<no loras found>"]


def _resolve(name):
    try:
        p = folder_paths.get_full_path("loras", name)
        if p:
            return p
    except Exception:
        pass
    return name


def _norm(s):
    s = s.lower()
    for pre in ("lora_unet_", "lora_te_", "lora_", "diffusion_model.",
                "diffusion_model_", "transformer.", "model.diffusion_model.",
                "model.", "base_model."):
        if s.startswith(pre):
            s = s[len(pre):]
    return s.replace(".", "").replace("_", "")


def _load_lora_matrices(path):
    if safetensors is None:
        return {}
    sd = safetensors.torch.load_file(path)
    groups = {}
    alphas = {}
    for k, v in sd.items():
        if k.endswith(".alpha") or k.endswith("alpha"):
            alphas[re.sub(r"\.?alpha$", "", k)] = float(v.flatten()[0].item())
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
        down = mats["down"]
        up = mats["up"]
        rank = down.shape[0]
        alpha = alphas.get(base, alphas.get(base + ".alpha", float(rank)))
        out[_norm(base)] = {"down": down, "up": up, "scale": float(alpha) / float(rank)}
    return out


def _iter_linears(module):
    for name, sub in module.named_modules():
        if isinstance(sub, torch.nn.Linear):
            yield name, sub
            continue
        w = getattr(sub, "weight", None)
        if w is not None and torch.is_tensor(w) and w.dim() == 2:
            yield name, sub


def _parse_regions(s):
    try:
        d = json.loads(s) if s else {}
    except Exception:
        d = {}
    if isinstance(d, list):
        regs, g = d, ""
    elif isinstance(d, dict):
        regs, g = d.get("regions", []), d.get("global", "")
    else:
        regs, g = [], ""
    norm = []
    for r in regs:
        if not isinstance(r, dict):
            continue
        norm.append({
            "char": "b" if str(r.get("char", "a")).lower() == "b" else "a",
            "x": float(r.get("x", 0)),
            "y": float(r.get("y", 0)),
            "w": float(r.get("w", 0.5)),
            "h": float(r.get("h", 1)),
            "text": str(r.get("text", "")),
        })
    return {"regions": norm, "global": str(g or "")}


def _rect_grid(rows, cols, x, y, w, h, feather):
    c0 = x * cols
    c1 = (x + w) * cols
    r0 = y * rows
    r1 = (y + h) * rows
    fc = max(1e-3, feather * cols)
    fr = max(1e-3, feather * rows)
    cc = torch.arange(cols, dtype=torch.float32).unsqueeze(0)
    rr = torch.arange(rows, dtype=torch.float32).unsqueeze(1)
    inx = torch.sigmoid((cc - c0) / fc) * torch.sigmoid((c1 - cc) / fc)
    iny = torch.sigmoid((rr - r0) / fr) * torch.sigmoid((r1 - rr) / fr)
    return (iny * inx).reshape(-1).clamp(0.0, 1.0)


def _build_layer_map(dm, la, lb, sa, sb):
    amap = {}
    for s, d in la.items():
        amap[s] = dict(d)
        amap[s]["scale"] = d["scale"] * sa
    bmap = {}
    for s, d in lb.items():
        bmap[s] = dict(d)
        bmap[s]["scale"] = d["scale"] * sb
    lmap = {}
    matched = 0
    for name, mod in _iter_linears(dm):
        sig = _norm(name)
        entry = {}
        if sig in amap:
            entry["a"] = amap[sig]
        if sig in bmap:
            entry["b"] = bmap[sig]
        if entry:
            lmap[name] = (mod, entry)
            matched += 1
    return lmap, matched, len(amap), len(bmap)


def _encode(clip, text):
    toks = clip.tokenize(text if text else "")
    try:
        c = clip.encode_from_tokens_scheduled(toks)
    except Exception:
        c = clip.encode_from_tokens(toks, return_pooled=True)
    if isinstance(c, tuple):
        c = c[0]
    if torch.is_tensor(c):
        c = [[c, {}]]
    if isinstance(c, list):
        return c
    return []


def _manual_mask(c, h, w, y, x, dtype=torch.float32):
    """Build a rectangular mask (1,H,W) in [0,1] coords and attach it the way
    ConditioningSetMask does, instead of using the raw 'area' percentage tuple.
    The old tuple format ("percentage", h, w, y, x) assumes a fixed number of
    spatial dims in the latent; that assumption breaks on ComfyUI builds/models
    where noise.shape[2:] has a different dim count (e.g. 3 dims instead of 2),
    causing an IndexError deep in resolve_areas_and_cond_masks_multidim.
    A mask is resolved against the actual tensor shape at sample time, so it
    sidesteps that mismatch entirely.
    """
    MASK_H, MASK_W = 256, 256
    mask = torch.zeros((1, MASK_H, MASK_W), dtype=dtype)
    y0 = int(round(y * MASK_H)); y1 = int(round((y + h) * MASK_H))
    x0 = int(round(x * MASK_W)); x1 = int(round((x + w) * MASK_W))
    y1 = max(y0 + 1, min(MASK_H, y1))
    x1 = max(x0 + 1, min(MASK_W, x1))
    y0 = max(0, min(y0, MASK_H - 1))
    x0 = max(0, min(x0, MASK_W - 1))
    mask[:, y0:y1, x0:x1] = 1.0

    out = []
    for item in c:
        t0, t1 = item[0], item[1]
        d = dict(t1)
        d.pop("area", None)               # drop old-style area if present
        d["mask"] = mask
        d["mask_strength"] = 1.0
        d["set_area_to_bounds"] = False   # soft regional mask, not a hard area
        out.append([t0, d])
    return out


def _build_regional_conditioning(clip, regs, global_text):
    out = []
    g = (global_text or "").strip()
    has_region_text = any((r.get("text") or "").strip() for r in regs)

    if g:
        out.extend(_encode(clip, g))
    elif not has_region_text:
        out.extend(_encode(clip, ""))

    for r in regs:
        t = (r.get("text") or "").strip()
        if not t:
            continue
        c = _encode(clip, t)
        if not c:
            continue
        rw = float(r["w"])
        rh = float(r["h"])
        rx = float(r["x"])
        ry = float(r["y"])
        c = _manual_mask(c, rh, rw, ry, rx)
        out.extend(c)

    if not out:
        out = _encode(clip, "")
    return out


def _zero_conditioning(cond):
    if not cond:
        return cond
    t = cond[0]
    d = {}
    for k, v in t[1].items():
        if k != "area":
            d[k] = v
    if "pooled_output" in d and d["pooled_output"] is not None:
        d["pooled_output"] = d["pooled_output"].clone().zero_()
    return [[t[0].clone().zero_(), d]]


class _RegionalSession:
    def __init__(self, lmap, regs, feather):
        self.lmap = lmap
        self.regs = regs
        self.feather = feather
        self.grid = None
        self.grid_mask = {}
        self.mult_cache = {}
        self.n_text = None
        self.dev = None
        self.cd = None
        self.prepared = False
        self.probe_done = False
        self.seen_seqs = set()

    def set_grid(self, rows, cols):
        g = (rows, cols) if (rows and cols) else None
        if g == self.grid:
            return
        self.grid = g
        self.grid_mask = {}
        self.mult_cache = {}
        self.n_text = None
        if g:
            rows, cols = g
            for ch in ("a", "b"):
                m = None
                for r in self.regs:
                    if r["char"] != ch:
                        continue
                    rm = _rect_grid(rows, cols, r["x"], r["y"], r["w"], r["h"], self.feather)
                    if m is None:
                        m = rm
                    else:
                        m = torch.maximum(m, rm)
                if m is not None:
                    self.grid_mask[ch] = m

    def ensure_prepared(self, out):
        if self.prepared:
            return
        self.dev = out.device
        if out.dtype in (torch.float16, torch.bfloat16):
            self.cd = out.dtype
        else:
            self.cd = torch.float32
        for (_mod, entry) in self.lmap.values():
            for ch in ("a", "b"):
                d = entry.get(ch)
                if d and "down_d" not in d:
                    d["down_d"] = d["down"].to(self.dev, self.cd)
                    d["up_d"] = (d["up"] * d["scale"]).to(self.dev, self.cd)
        self.prepared = True

    def probe_once(self, seq):
        self.seen_seqs.add(int(seq))
        if self.probe_done:
            return
        if self.grid and any(s > self.grid[0] * self.grid[1] for s in self.seen_seqs):
            self.probe_done = True
            n_img = self.grid[0] * self.grid[1]
            print(f"[NouganRegionalLoRA] probe: grid={self.grid} n_img={n_img} "
                  f"n_text~{self.n_text} seq_lengths_seen={sorted(self.seen_seqs)}")

    def mask_mult(self, ch, seq):
        if self.grid is None or ch not in self.grid_mask:
            return None
        rows, cols = self.grid
        n_img = rows * cols
        key = (ch, seq)
        if key in self.mult_cache:
            return self.mult_cache[key]
        gm = self.grid_mask[ch]
        if seq == n_img:
            base = gm
        elif seq > n_img:
            self.n_text = seq - n_img
            base = torch.cat([torch.zeros(self.n_text), gm])
        else:
            self.mult_cache[key] = None
            return None
        t = base.to(self.dev, self.cd)
        self.mult_cache[key] = t
        return t


def _make_hook(sess, entry):
    def hook(module, inp, out):
        if not torch.is_tensor(out) or out.dim() < 2:
            return out
        seq = out.shape[-2]
        sess.ensure_prepared(out)
        sess.probe_once(seq)
        x = inp[0]
        if not torch.is_tensor(x) or x.dim() < 2:
            return out
        xf = None
        res = None
        for ch in ("a", "b"):
            d = entry.get(ch)
            if d is None:
                continue
            mult = sess.mask_mult(ch, seq)
            if mult is None:
                continue
            if xf is None:
                xf = x.to(sess.cd)
            try:
                delta = (xf @ d["down_d"].t()) @ d["up_d"].t()
            except RuntimeError:
                continue
            add = delta * mult.view(1, seq, 1)
            if res is None:
                res = add
            else:
                res = res + add
        if res is None:
            return out
        return out + res.to(out.dtype)
    return hook


class NouganRegionalCharacterLoRA:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL",),
                "clip": ("CLIP",),
                "lora_a": (_lora_list(),),
                "strength_a": ("FLOAT", {"default": 1.0, "min": -4.0, "max": 4.0, "step": 0.05}),
                "lora_b": (_lora_list(),),
                "strength_b": ("FLOAT", {"default": 1.0, "min": -4.0, "max": 4.0, "step": 0.05}),
                "feather": ("FLOAT", {"default": 0.06, "min": 0.0, "max": 0.3, "step": 0.01}),
                "regions": ("STRING", {"default": "{}", "multiline": False}),
            },
        }

    RETURN_TYPES = ("MODEL", "CONDITIONING", "CONDITIONING")
    RETURN_NAMES = ("MODEL", "CONDITIONING", "NEGATIVE")
    FUNCTION = "apply"
    CATEGORY = "conditioning/regional"
    TITLE = "Nougan Regional Character LoRA"

    @classmethod
    def IS_CHANGED(cls, regions="{}", lora_a="", lora_b="", strength_a=1.0,
                   strength_b=1.0, feather=0.06, **kw):
        return f"{regions}|{lora_a}|{lora_b}|{strength_a}|{strength_b}|{feather}"

    def apply(self, model, clip, lora_a, lora_b, strength_a, strength_b, feather, regions="{}"):
        la = _load_lora_matrices(_resolve(lora_a))
        lb = _load_lora_matrices(_resolve(lora_b))
        data = _parse_regions(regions)
        regs = data["regions"]
        global_text = data["global"]

        patched = model.clone()
        dm = getattr(patched.model, "diffusion_model", patched.model)
        lmap, matched, na, nb = _build_layer_map(dm, la, lb, strength_a, strength_b)
        print(f"[NouganRegionalLoRA] matched {matched} spatial-capable layers "
              f"(A:{na} B:{nb} targets in file).")
        if matched == 0:
            print("[NouganRegionalLoRA] !! 0 layers matched.")
            sample_lora = list(la.keys())[:5] if la else list(lb.keys())[:5]
            sample_model = [n for n, _ in _iter_linears(dm)][:5]
            print(f"[NouganRegionalLoRA]   LoRA key stems (first 5):  {sample_lora}")
            print(f"[NouganRegionalLoRA]   Model module names (first 5): {sample_model}")

        sess = _RegionalSession(lmap, regs, feather)

        def wrapper(executor, *args, **kwargs):
            x = None
            for a in args:
                if torch.is_tensor(a) and a.dim() == 4:
                    x = a
                    break
            if x is None:
                for v in kwargs.values():
                    if torch.is_tensor(v) and v.dim() == 4:
                        x = v
                        break
            if x is not None:
                H = x.shape[-2]
                W = x.shape[-1]
                sess.set_grid(max(1, H // 2), max(1, W // 2))
            else:
                sess.set_grid(None, None)
            handles = []
            for (mod, entry) in sess.lmap.values():
                handles.append(mod.register_forward_hook(_make_hook(sess, entry)))
            try:
                return executor(*args, **kwargs)
            finally:
                for h in handles:
                    h.remove()

        if hasattr(patched, "add_wrapper_with_key"):
            patched.add_wrapper_with_key(_WRAPPER_ENUM, WRAPPER_KEY, wrapper)
        elif hasattr(patched, "add_wrapper"):
            patched.add_wrapper(_WRAPPER_ENUM, wrapper)
        else:
            raise RuntimeError("This ComfyUI build lacks model wrapper support.")

        cond = _build_regional_conditioning(clip, regs, global_text)
        neg = _zero_conditioning(cond)

        n_reg = sum(1 for r in regs if (r.get("text") or "").strip())
        print(f"[NouganRegionalLoRA] regional text: {n_reg} region prompt(s)"
              + (" + global" if global_text.strip() else ""))

        return (patched, cond, neg)


NODE_CLASS_MAPPINGS = {"NouganRegionalCharacterLoRA": NouganRegionalCharacterLoRA}
NODE_DISPLAY_NAME_MAPPINGS = {"NouganRegionalCharacterLoRA": "Nougan Regional Character LoRA"}