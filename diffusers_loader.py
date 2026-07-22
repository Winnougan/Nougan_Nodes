# diffusers_loader.py
import os
import torch
import torch.nn.functional as F
import folder_paths
import comfy.sd
import comfy.utils
import comfy.model_management


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_MODEL_DATA_INPUT = (
    "STRING",
    {"default": "{}", "multiline": True,
     "tooltip": "Managed by the Nougan Diffusers Loader UI."},
)

_DIFFUSERS_FILE_EXTS = (".safetensors", ".bin", ".gguf", ".ckpt", ".pt")


def first_file(path, filenames):
    if path is None or not os.path.exists(path):
        return None
    for f in filenames:
        p = os.path.join(path, f)
        if os.path.exists(p):
            return p
    return None


# ---------------------------------------------------------------------------
# RoPE — try ComfyUI's own implementation first, fall back to a standard one
# ---------------------------------------------------------------------------
# IMPORTANT: Flux/Krea2-family models represent "freqs"/"pe" as a stack of
# 2x2 rotation matrices with shape [..., D//2, 2, 2] — NOT as a flat
# [..., D] vector meant to be paired up and treated as complex numbers.
# The previous complex-number implementation assumed the wrong layout,
# which is why reshape() blew up (e.g. trying to reshape a 6-D rotation
# matrix tensor as if it were a flat interleaved-pairs vector).
#
# The correct (and standard, e.g. black-forest-labs/flux) application is:
#   xq_ = xq.float().reshape(*xq.shape[:-1], -1, 1, 2)
#   xq_out = pe[..., 0] * xq_[..., 0] + pe[..., 1] * xq_[..., 1]
#   xq_out = xq_out.reshape(*xq.shape)
# applied independently to q and k using the same pe tensor.
# ---------------------------------------------------------------------------

_comfy_apply_rope = None
for _mod, _fn in (
    ("comfy.ldm.flux.math", "apply_rope"),
    ("comfy.ldm.krea2.model", "apply_rope"),
    ("comfy.ldm.modules.attention", "apply_rope"),
):
    try:
        _m = __import__(_mod, fromlist=[_fn])
        _f = getattr(_m, _fn, None)
        if _f is not None:
            _comfy_apply_rope = _f
            break
    except Exception:
        pass


def _apply_rope_matrix(x, pe):
    """Rotation-matrix RoPE application matching Flux/Krea2's convention.
    x:  [..., D]
    pe: [..., D//2, 2, 2]
    """
    while pe.dim() < x.dim() + 2:
        pe = pe.unsqueeze(0)

    orig_dtype = x.dtype
    x_ = x.float().reshape(*x.shape[:-1], -1, 1, 2)
    out = pe[..., 0] * x_[..., 0] + pe[..., 1] * x_[..., 1]
    return out.reshape(*x.shape).to(orig_dtype)


def _apply_rope_qk(q, k, pe):
    """Apply RoPE to q and k. Prefers ComfyUI's native apply_rope(q, k, pe)
    (which returns both tensors already correctly rotated together);
    falls back to the manual matrix-form implementation otherwise.
    """
    if _comfy_apply_rope is not None:
        try:
            return _comfy_apply_rope(q, k, pe)
        except Exception:
            pass  # fall through to manual implementation

    return _apply_rope_matrix(q, pe), _apply_rope_matrix(k, pe)


# ---------------------------------------------------------------------------
# Attention wrappers — Kijai-compatible ComfyUI patch signatures
# ---------------------------------------------------------------------------
# NOTE: Different ComfyUI model architectures call attention patches with
# different signatures. Some (older / generic path) call:
#     def patch(q, k, v, extra_options) -> Tensor
# while others (e.g. krea2, and other newer architectures) call:
#     def patch(q, k, v, pe=..., attn_mask=..., extra_options=...) -> Tensor
# i.e. "pe" and "attn_mask" arrive as their own keyword arguments rather
# than being bundled inside extra_options. To be compatible with both,
# every wrapper below accepts pe/attn_mask/extra_options as separate
# optional kwargs (falling back to extra_options if pe/attn_mask aren't
# passed directly), plus a **kwargs catch-all for forward-compatibility
# with any other call conventions.
#
# q, k, v arrive as [B, H, S, D] (batch, heads, seq_len, head_dim)
# ---------------------------------------------------------------------------


def _resolve_pe_and_mask(pe, attn_mask, extra_options):
    """Normalize the various calling conventions into (pe, attn_mask)."""
    extra_options = extra_options or {}
    if pe is None:
        pe = extra_options.get("pe", None)
    if attn_mask is None:
        attn_mask = extra_options.get("attn_mask", None)
    return pe, attn_mask


def _make_flash_wrapper():
    """Kijai-style full-attention wrapper. NOTE: some newer architectures
    (e.g. Krea2) call this hook purely as a q/k *preprocessing* step —
    they unconditionally do `out.get("q", q)` on whatever this returns,
    meaning the hook contract there is "return a dict of overrides",
    NOT "return the final attention output". For those architectures the
    real attention computation happens internally afterwards (often via
    ComfyUI's own comfy_kitchen fused kernels), so a custom Flash/Sage
    backend cannot be injected through this particular hook.

    IMPORTANT: we intentionally do NOT apply RoPE here anymore. Doing so
    produced heavily artifacted images — strong evidence that Krea2
    applies its own internal RoPE to q/k regardless of what this patch
    returns, so rotating them here caused a double-rotation (corrupting
    attention). This wrapper is now a no-op passthrough for q/k; it
    exists only so the attn1/attn2 patch slots are technically "filled"
    without breaking generation. Real attention backend selection is not
    functional through this hook for this architecture.
    """
    from flash_attn import flash_attn_func  # noqa: F401  (validates install)

    def _wrapper(q, k, v, pe=None, attn_mask=None, extra_options=None, **kwargs):
        # Deliberately not touching q/k/pe here — see docstring above.
        return {"q": q, "k": k}

    return _wrapper


def _make_sage_wrapper(sage_ver="SageAttention 2"):
    """See _make_flash_wrapper's docstring — same reasoning applies.
    RoPE is intentionally NOT applied here (caused artifacted images,
    almost certainly from double-rotation against Krea2's own internal
    RoPE application). This is now an inert q/k passthrough.
    """
    from sageattention import sageattn  # noqa: F401  (validates install)

    def _wrapper(q, k, v, pe=None, attn_mask=None, extra_options=None, **kwargs):
        # Deliberately not touching q/k/pe here — see docstring above.
        return {"q": q, "k": k}

    return _wrapper


def _apply_attention_patches(model, sage_ver, flash_ver):
    """Apply attention patches to the model using ComfyUI's native patch API.

    Priority: SageAttention > FlashAttention (if both set, Sage wins).
    This mirrors Kijai's approach in HunyuanVideoWrapper / FluxWrapper.
    """
    if sage_ver == "None" and flash_ver == "None":
        return model

    wrapper = None
    name = None

    # Flash first, then Sage overwrites (Sage wins if both are set)
    if flash_ver != "None":
        try:
            wrapper = _make_flash_wrapper()
            name = flash_ver
        except ImportError:
            print(f"[Nougan] ⚠️ {flash_ver} selected but 'flash-attn' not installed. "
                  f"Install with: pip install flash-attn --no-build-isolation")
        except Exception as e:
            print(f"[Nougan] ❌ Failed to build {flash_ver} wrapper: {e}")

    if sage_ver != "None":
        try:
            wrapper = _make_sage_wrapper(sage_ver)
            name = sage_ver
        except ImportError:
            print(f"[Nougan] ⚠️ {sage_ver} selected but 'sageattention' not installed. "
                  f"Install with: pip install sageattention")
        except Exception as e:
            print(f"[Nougan] ❌ Failed to build {sage_ver} wrapper: {e}")

    if wrapper is not None:
        # --- Primary method: ComfyUI model-level attention patches ---
        if hasattr(model, "set_model_attn1_patch"):
            model.set_model_attn1_patch(wrapper)
            model.set_model_attn2_patch(wrapper)
            print(f"[Nougan] ⚠️ {name} selected, but this architecture's "
                  f"attn1/attn2 hook only supports q/k preprocessing "
                  f"(dict-return contract) and applying RoPE there caused "
                  f"image corruption — so this patch is now an inert "
                  f"passthrough. {name} is NOT actually accelerating "
                  f"attention for this model; generation uses the "
                  f"model's own internal/native attention path.")
        else:
            # --- Fallback: patch at the module level (Kijai-style global patch) ---
            try:
                import comfy.ldm.modules.attention as attn_module

                _original_optimized = getattr(attn_module, "optimized_attention", None)

                def _patched_optimized_attention(q, k, v, heads, mask=None, **kwargs):
                    """Global fallback patch matching comfy.ldm.modules.attention.optimized_attention"""
                    # Reshape from [B, S, H*D] to [B, H, S, D]
                    b, s, _ = q.shape
                    d = q.shape[-1] // heads
                    q_r = q.view(b, s, heads, d).transpose(1, 2)
                    k_r = k.view(b, k.shape[1], heads, d).transpose(1, 2)
                    v_r = v.view(b, v.shape[1], heads, d).transpose(1, 2)

                    extra_opts = {}
                    if mask is not None:
                        extra_opts["attn_mask"] = mask

                    out = wrapper(q_r, k_r, v_r, extra_options=extra_opts)

                    # Back to [B, S, H*D]
                    out = out.transpose(1, 2).reshape(b, s, -1)
                    return out

                attn_module.optimized_attention = _patched_optimized_attention
                print(f"[Nougan] ✅ Applied global attention patch: {name} "
                      f"(module-level fallback)")
            except Exception as e:
                print(f"[Nougan] ❌ Model does not support attention patching "
                      f"({name}): {e}")

    return model


# ---------------------------------------------------------------------------
# Model scanning (unchanged)
# ---------------------------------------------------------------------------

def _is_diffusers_folder(path: str) -> bool:
    if not os.path.isdir(path):
        return False
    try:
        entries = os.listdir(path)
    except OSError:
        return False
    low = {e.lower() for e in entries}
    if "unet" in low:
        return True
    if "model_index.json" in low:
        return True
    if any(e.lower().startswith("diffusion_pytorch_model") for e in entries):
        return True
    return False


def _roots():
    roots = []
    for name in ("unet", "diffusion_models", "diffusers"):
        try:
            roots.extend(folder_paths.get_folder_paths(name))
        except Exception:
            pass
    bases = []
    md = getattr(folder_paths, "models_dir", None)
    if md:
        bases.append(md)
    try:
        bases.append(os.path.join(folder_paths.get_user_directory(), "models"))
    except Exception:
        pass
    for cat in ("checkpoints", "loras", "vae", "clip"):
        try:
            for p in folder_paths.get_folder_paths(cat):
                bases.append(os.path.dirname(p))
        except Exception:
            pass
    for base in bases:
        for sub in ("diffusion_models", "unet", "diffusers"):
            roots.append(os.path.join(base, sub))
    seen, out = set(), []
    for r in roots:
        r = os.path.normpath(r)
        if r and r not in seen and os.path.isdir(r):
            seen.add(r)
            out.append(r)
    return out


def _scan():
    roots = _roots()
    found = {}
    for root in roots:
        for dirpath, dirnames, filenames in os.walk(root):
            rel = os.path.relpath(dirpath, root)
            if rel != "." and _is_diffusers_folder(dirpath):
                found.setdefault(rel.replace(os.sep, "/"), "folder")
                dirnames[:] = []
                continue
            for fn in filenames:
                if fn.lower().endswith(_DIFFUSERS_FILE_EXTS):
                    key = fn if rel == "." else os.path.join(rel, fn)
                    found.setdefault(key.replace(os.sep, "/"), "file")
    return roots, found


def _get_available_diffusers_models():
    roots, found = _scan()
    names = sorted(found.keys())
    print(f"[Nougan] Diffusers scan — {len(roots)} root(s): {roots}")
    print(f"[Nougan] Diffusers scan — {len(names)} entries found: "
          f"{names[:25]}{'…' if len(names) > 25 else ''}")
    return names


def _resolve(name: str):
    rel = str(name).replace("/", os.sep)
    for root in _roots():
        p = os.path.join(root, rel)
        if os.path.exists(p):
            return p
    return None


# ---------------------------------------------------------------------------
# Node
# ---------------------------------------------------------------------------

class NouganDiffusersLoader:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model_name": (
                    _get_available_diffusers_models(),
                    {"tooltip": "Select the diffusers model folder or file."},
                ),
                "sageattention_version": (
                    ["None", "SageAttention 2", "SageAttention 3"],
                    {"default": "None",
                     "tooltip": "SageAttention version. Requires: pip install sageattention"},
                ),
                "flashattention_version": (
                    ["None", "FlashAttention 2", "FlashAttention 3", "FlashAttention 4"],
                    {"default": "None",
                     "tooltip": "FlashAttention version. Requires: pip install flash-attn"},
                ),
            },
            "optional": {
                "model_data": _MODEL_DATA_INPUT,
            },
        }

    RETURN_TYPES = ("MODEL", "CLIP", "VAE")
    RETURN_NAMES = ("MODEL", "CLIP", "VAE")
    FUNCTION = "load"
    CATEGORY = "loaders"
    TITLE = "Nougan Diffusers Loader"

    @classmethod
    def IS_CHANGED(cls, model_name, sageattention_version,
                   flashattention_version, model_data="{}", **kw):
        # model_data is kept in the key for signature stability, but the JS
        # panel no longer writes it, so it is effectively always "{}".
        return f"{model_name}_{sageattention_version}_{flashattention_version}_{model_data}"

    def load(self, model_name, sageattention_version,
             flashattention_version, model_data="{}"):

        # ── Single source of truth ─────────────────────────────────────────
        # The native combo widgets (model_name / sageattention_version /
        # flashattention_version) are authoritative. The JS panel mirrors
        # them 1:1 and writes back on every change, and they serialize and
        # restore with the workflow.
        #
        # The hidden `model_data` JSON is intentionally NOT parsed or used
        # here. It used to be a second source of truth that the panel wrote
        # and that this function let OVERRIDE the native widgets — but the
        # panel's DOM could be stale at load time (populated before the
        # saved values were restored), so it would write the alphabetically
        # first model into the JSON and clobber the real saved selection.
        # That was the "always resets to the Fal Ideogram model on reload"
        # bug. Ignoring model_data also auto-heals any workflow files that
        # were already saved with a corrupted JSON blob.
        # ───────────────────────────────────────────────────────────────────
        name  = model_name
        sage  = sageattention_version
        flash = flashattention_version

        model_path = _resolve(name)
        if model_path is None:
            raise ValueError(f"[Nougan] Model '{name}' not found in any scanned root.")

        unet = clip = vae = None

        if os.path.isdir(model_path):
            dm_names = [
                "diffusion_pytorch_model.fp16.safetensors",
                "diffusion_pytorch_model.safetensors",
                "diffusion_pytorch_model.fp16.bin",
                "diffusion_pytorch_model.bin",
            ]
            unet_path = (
                first_file(os.path.join(model_path, "unet"), dm_names)
                or first_file(model_path, dm_names)
            )
            if unet_path is None:
                raise ValueError(f"[Nougan] No UNet file found in {model_path}")

            print(f"[Nougan] Loading UNet: {unet_path}")
            unet = comfy.sd.load_diffusion_model(unet_path)

            te_names = [
                "model.fp16.safetensors", "model.safetensors",
                "pytorch_model.fp16.bin", "pytorch_model.bin",
            ]
            te_paths = []
            te1 = first_file(os.path.join(model_path, "text_encoder"), te_names)
            te2 = first_file(os.path.join(model_path, "text_encoder_2"), te_names)
            if te1: te_paths.append(te1)
            if te2: te_paths.append(te2)
            if te_paths:
                print(f"[Nougan] Loading CLIP: {te_paths}")
                clip = comfy.sd.load_clip(te_paths, embedding_directory=None)

            vae_path = first_file(os.path.join(model_path, "vae"), dm_names)
            if vae_path:
                print(f"[Nougan] Loading VAE: {vae_path}")
                vae = comfy.sd.VAE(sd=comfy.utils.load_torch_file(vae_path))
        else:
            print(f"[Nougan] Loading unified model: {model_path}")
            unet = comfy.sd.load_diffusion_model(model_path)

        if unet is not None:
            unet = _apply_attention_patches(unet, sage, flash)

        return (unet, clip, vae)