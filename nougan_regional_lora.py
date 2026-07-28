# nougan_regional_lora.py — Nougan Regional Character LoRA (Krea2 / Flux-2 family)
# ---------------------------------------------------------------------------------
# EXPERIMENTAL BUILD. Two independent, region-gated controls from one editor:
#   (1) REGIONAL LoRA  — each character LoRA's delta is added at forward time and
#       masked to that character's image tokens (standard Linear-level mechanism;
#       architecture-agnostic at the Linear, but the image-token LAYOUT is an
#       assumption — the first forward PRINTS a probe so you can confirm it).
#   (2) REGIONAL TEXT  — each region's typed prompt is encoded with the CLIP and
#       wrapped with ComfyUI's OWN ConditioningSetAreaPercentage (we call the core
#       node's method, so the area math is ComfyUI's tested code, NOT a guess).
#       A global prompt (no area) layers shared direction on top.
# The editor stores {regions:[{char,x,y,w,h,text}...], global:"..."} in the hidden
# "regions" widget — the single source of truth.
import re
import json
import torch
import safetensors.torch
import folder_paths

try:
    import comfy.patcher_extension as _pext
    _WRAPPER_ENUM = _pext.WrappersMP.DIFFUSION_MODEL
except Exception:
    _pext = None
    _WRAPPER_ENUM = "diffusion_model"

WRAPPER_KEY = "nougan_regional_lora"


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
def _lora_list():
    try:
        return folder_paths.get_filename_list("loras")
    except Exception:
        return ["<put .safetensors in models/loras>"]


def _resolve(name):
    if folder_paths is not None:
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
    sd = safetensors.torch.load_file(path)
    groups, alphas = {}, {}
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
        down, up = mats["down"], mats["up"]
        rank = down.shape[0]
        alpha = alphas.get(base, alphas.get(base + ".alpha", float(rank)))
        out[_norm(base)] = {"down": down, "up": up, "scale": float(alpha) / float(rank)}
    return out


def _iter_linears(module):
    for name, sub in module.named_modules():
        if isinstance(sub, torch.nn.Linear):
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
            "x": float(r.get("x", 0)), "y": float(r.get("y", 0)),
            "w": float(r.get("w", 0.5)), "h": float(r.get("h", 1)),
            "text": str(r.get("text", "")),
        })
    return {"regions": norm, "global": str(g or "")}


def _rect_grid(rows, cols, x, y, w, h, feather):
    c0, c1 = x * cols, (x + w) * cols
    r0, r1 = y * rows, (y + h) * rows
    fc, fr = max(1e-3, feather * cols), max(1e-3, feather * rows)
    cc = torch.arange(cols, dtype=torch.float32).unsqueeze(0)
    rr = torch.arange(rows, dtype=torch.float32).unsqueeze(1)
    inx = torch.sigmoid((cc - c0) / fc) * torch.sigmoid((c1 - cc) / fc)
    iny = torch.sigmoid((rr - r0) / fr) * torch.sigmoid((r1 - rr) / fr)
    return (iny * inx).reshape(-1).clamp(0.0, 1.0)


def _build_layer_map(dm, la, lb, sa, sb):
    amap = {s: {**d, "scale": d["scale"] * sa} for s, d in la.items()}
    bmap = {s: {**d, "scale": d["scale"] * sb} for s, d in lb.items()}
    lmap, matched = {}, 0
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


# ---------------------------------------------------------------------------
# regional text conditioning (ComfyUI's own area mechanism)
# ---------------------------------------------------------------------------
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
    return c if isinstance(c, list) else []


def _build_regional_conditioning(clip, regs, global_text):
    try:
        from nodes import ConditioningSetAreaPercentage as CSAP
    except Exception:
        CSAP = None
    out = []
    g = (global_text or "").strip()
    has_region_text = any((r.get("text") or "").strip() for r in regs)
    if g:
        out.extend(_encode(clip, g))                 # global: no area -> applies everywhere
    elif not has_region_text:
        out.extend(_encode(clip, ""))                # never hand back empty conditioning
    for r in regs:
        t = (r.get("text") or "").strip()
        if not t:
            continue
        c = _encode(clip, t)
        if not c:
            continue
        if CSAP is not None:
            c = CSAP().append(c, float(r["w"]), float(r["h"]), float(r["x"]), float(r["y"]))[0]
        else:  # best-effort manual percentage (only if the core node is somehow absent)
            c = [[t0, {**t1, "area": ("percentage", float(r["h"]), float(r["w"]),
                                       float(r["y"]), float(r["x"]))}] for (t0, t1) in c]
        out.extend(c)
    if not out:
        out = _encode(clip, "")
    return out


# ---------------------------------------------------------------------------
# per-forward session: grid + masks + lazy device prep + probe
# ---------------------------------------------------------------------------
class _RegionalSession:
    def __init__(self, lmap, regs, feather):
        self.lmap = lmap
        self.regs = regs
        self.feather = feather
        self.grid = None
        self.grid_mask = {}      # char -> [rows*cols] cpu
        self.mult_cache = {}     # (char, seq) -> device tensor
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
                    m = rm if m is None else torch.maximum(m, rm)
                if m is not None:
                    self.grid_mask[ch] = m

    def ensure_prepared(self, out):
        if self.prepared:
            return
        self.dev = out.device
        self.cd = out.dtype if out.dtype in (torch.float16, torch.bfloat16) else torch.float32
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
            print(f"[NouganRegionalLoRA] probe: grid={self.grid} n_img={self.grid[0]*self.grid[1]} "
                  f"n_text≈{self.n_text} seq_lengths_seen={sorted(self.seen_seqs)} "
                  f"(seq==n_img→image stream · seq>n_img→joint · seq<n_img→text stream, skipped)")

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
        else:  # text-only stream: no spatial tokens -> cannot regionalize here
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
            delta = (xf @ d["down_d"].t()) @ d["up_d"].t()
            add = delta * mult.view(1, seq, 1)
            res = add if res is None else res + add
        if res is None:
            return out
        return out + res.to(out.dtype)
    return hook


# ---------------------------------------------------------------------------
# node
# ---------------------------------------------------------------------------
class NouganRegionalCharacterLoRA:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL",),
                "clip": ("CLIP", {"tooltip": "Needed to encode each region's typed prompt."}),
                "lora_a": (_lora_list(),),
                "strength_a": ("FLOAT", {"default": 1.0, "min": -4.0, "max": 4.0, "step": 0.05}),
                "lora_b": (_lora_list(),),
                "strength_b": ("FLOAT", {"default": 1.0, "min": -4.0, "max": 4.0, "step": 0.05}),
                "feather": ("FLOAT", {"default": 0.06, "min": 0.0, "max": 0.3, "step": 0.01,
                                      "tooltip": "Softness of the LoRA region seam (fraction of the token grid)."}),
                "regions": ("STRING", {"default": "{}", "multiline": False,
                                       "tooltip": "Managed by the in-node region editor."}),
            },
        }

    RETURN_TYPES = ("MODEL", "CONDITIONING")
    RETURN_NAMES = ("MODEL", "CONDITIONING")
    FUNCTION = "apply"
    CATEGORY = "conditioning/regional"
    TITLE = "Nougan Regional Character LoRA 🎭"

    @classmethod
    def IS_CHANGED(cls, regions="{}", lora_a="", lora_b="", strength_a=1.0,
                   strength_b=1.0, feather=0.06, **kw):
        return f"{regions}|{lora_a}|{lora_b}|{strength_a}|{strength_b}|{feather}"

    def apply(self, model, clip, lora_a, lora_b, strength_a, strength_b, feather, regions="{}"):
        la = _load_lora_matrices(_resolve(lora_a))
        lb = _load_lora_matrices(_resolve(lora_b))
        data = _parse_regions(regions)
        regs, global_text = data["regions"], data["global"]

        patched = model.clone()
        dm = getattr(patched.model, "diffusion_model", patched.model)
        lmap, matched, na, nb = _build_layer_map(dm, la, lb, strength_a, strength_b)
        print(f"[NouganRegionalLoRA] matched {matched} spatial-capable layers "
              f"(A:{na} B:{nb} targets in file).")
        if matched == 0:
            print("[NouganRegionalLoRA] !! 0 layers matched — LoRA key stems don't line up "
                  "with this model; run recon_krea2.py to compare.")

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
                H, W = x.shape[-2], x.shape[-1]
                sess.set_grid(max(1, H // 2), max(1, W // 2))
            else:
                sess.set_grid(None, None)
            handles = [mod.register_forward_hook(_make_hook(sess, entry))
                       for (mod, entry) in sess.lmap.values()]
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
            raise RuntimeError("This ComfyUI build lacks model wrapper support. Update ComfyUI.")

        cond = _build_regional_conditioning(clip, regs, global_text)
        n_reg = sum(1 for r in regs if (r.get("text") or "").strip())
        print(f"[NouganRegionalLoRA] regional text: {n_reg} region prompt(s)"
              + (" + global" if global_text.strip() else ""))
        return (patched, cond)


NODE_CLASS_MAPPINGS = {"NouganRegionalCharacterLoRA": NouganRegionalCharacterLoRA}
NODE_DISPLAY_NAME_MAPPINGS = {"NouganRegionalCharacterLoRA": "Nougan Regional Character LoRA 🎭"}