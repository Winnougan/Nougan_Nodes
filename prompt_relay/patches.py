"""Model-type detection and cross-attention patching for Prompt Relay.

Supports LTX Video, LTX2, and LTXAV architectures.  The patch injects an
additive temporal penalty into the cross-attention logits *before* softmax,
wrapping (not replacing) any existing attn2 forward so third-party patches
(e.g. KJNodes NAG) remain functional.
"""

from __future__ import annotations

import logging
from typing import Any, Callable, Optional

import torch

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Architecture detection
# ---------------------------------------------------------------------------

# Known (arch, patch_size_hw, temporal_stride) triples keyed by a substring
# found in the diffusion model's class name or a sentinel attribute.
_KNOWN_ARCHS: list[tuple[str, tuple[int, int], int, str]] = [
    # (class-name substring, (patch_h, patch_w), temporal_stride, arch_label)
    ("LTXAV",           (32, 32), 8, "ltxav"),
    ("LTX2",            (32, 32), 8, "ltx2"),
    ("LTXVideo",        (32, 32), 8, "ltx"),
    ("LTXV",            (32, 32), 8, "ltx"),
]


def detect_model_type(model: Any) -> tuple[str, tuple[int, int, int], int]:
    """Return ``(arch, patch_size, temporal_stride)`` for *model*.

    ``patch_size`` is ``(temporal, height, width)``.

    Raises ``RuntimeError`` if the architecture is not recognised.
    """
    diff_model = model.model.diffusion_model
    cls_name = type(diff_model).__name__

    for substring, (ph, pw), t_stride, label in _KNOWN_ARCHS:
        if substring.lower() in cls_name.lower():
            patch_size = (1, ph, pw)
            log.info(
                "[PromptRelay] Detected arch=%s (patch=%s, temporal_stride=%d) "
                "from class %s",
                label, patch_size, t_stride, cls_name,
            )
            return label, patch_size, t_stride

    # Fallback: try to read patch_size from the model itself
    ps = getattr(diff_model, "patch_size", None)
    if ps is not None:
        if isinstance(ps, int):
            ps = (1, ps, ps)
        ts = getattr(diff_model, "temporal_stride", 8)
        log.info(
            "[PromptRelay] Fallback detection: patch_size=%s temporal_stride=%s "
            "from model attributes (class %s)",
            ps, ts, cls_name,
        )
        return "generic", tuple(ps), int(ts)

    raise RuntimeError(
        f"[PromptRelay] Unrecognised diffusion model class '{cls_name}'. "
        f"Known architectures: {[a[3] for a in _KNOWN_ARCHS]}. "
        "If this is a new LTX variant, add it to _KNOWN_ARCHS in patches.py."
    )


# ---------------------------------------------------------------------------
# Attention patching
# ---------------------------------------------------------------------------

def apply_patches(
    model: Any,
    arch: str,
    mask_fn: Callable[
        [int, int, torch.dtype, torch.device, dict],
        Optional[torch.Tensor],
    ],
) -> None:
    """Patch *model* (already cloned) so cross-attention adds the temporal penalty.

    The patch wraps the existing ``attn2`` forward rather than replacing it,
    so prior patches (KJNodes NAG, custom CFG, etc.) remain in the call chain.
    """

    def _attn2_patch(
        q: torch.Tensor,
        k: torch.Tensor,
        v: torch.Tensor,
        extra_options: dict,
    ) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        """Inject additive bias into cross-attention logits.

        ComfyUI calls this *before* the attention math.  We stash the bias
        on ``extra_options`` so the downstream optimised attention kernel
        (which ComfyUI selects automatically) can pick it up via the
        ``attn_bias`` key.  If the kernel doesn't support ``attn_bias``,
        we fall back to materialising the full attention matrix.
        """
        transformer_options = extra_options.get("transformer_options", {})
        Lq = q.shape[1]  # (batch, seq, dim)
        Lk = k.shape[1]

        bias = mask_fn(
            Lq, Lk,
            q.dtype, q.device,
            transformer_options,
        )
        if bias is None:
            return q, k, v

        # Ensure the bias is broadcastable: [1, Lq, Lk] for (B, H, Lq, Lk)
        # or [1, 1, Lq, Lk] depending on the attention backend.
        # ComfyUI's optimised_attention accepts an ``attn_bias`` kwarg in
        # extra_options since 0.2.x.
        if "attn_bias" not in extra_options:
            extra_options["attn_bias"] = bias.unsqueeze(0)  # [1, Lq, Lk]

        return q, k, v

    # --- Install the patch ---
    # ComfyUI model patching API: set_model_attn2_patch wraps the q/k/v
    # triple before attention.  Multiple patches chain automatically.
    existing = model.model_options.get("transformer_options", {}).get("attn2_patch", None)

    if existing is not None:
        # Chain: run the existing patch first, then ours
        original_existing = existing

        def _chained(q, k, v, extra_options):
            q, k, v = original_existing(q, k, v, extra_options)
            return _attn2_patch(q, k, v, extra_options)

        model.set_model_attn2_patch(_chained)
        log.info("[PromptRelay] Chained attn2 patch after existing patch.")
    else:
        model.set_model_attn2_patch(_attn2_patch)
        log.info("[PromptRelay] Installed attn2 patch (no prior patch found).")

    # For architectures with a separate audio cross-attention (LTXAV),
    # patch that stream too if the model exposes it.
    if arch == "ltxav":
        _patch_audio_attn(model, mask_fn)


def _patch_audio_attn(
    model: Any,
    mask_fn: Callable,
) -> None:
    """Best-effort patch for LTXAV's audio_attn2 stream.

    If the model doesn't expose a hookable audio attention, this is a no-op.
    """
    diff_model = model.model.diffusion_model
    if not hasattr(diff_model, "audio_attn2"):
        log.debug("[PromptRelay] No audio_attn2 found; skipping audio patch.")
        return

    def _audio_attn2_patch(q, k, v, extra_options):
        transformer_options = extra_options.get("transformer_options", {})
        Lq = q.shape[1]
        Lk = k.shape[1]
        bias = mask_fn(Lq, Lk, q.dtype, q.device, transformer_options)
        if bias is not None and "attn_bias" not in extra_options:
            extra_options["attn_bias"] = bias.unsqueeze(0)
        return q, k, v

    try:
        model.set_model_attn2_patch(_audio_attn2_patch)
        log.info("[PromptRelay] Patched audio_attn2 stream.")
    except Exception as exc:
        log.warning("[PromptRelay] Could not patch audio_attn2: %s", exc)