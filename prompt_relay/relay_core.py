"""Core Prompt Relay logic: tokenization, segment math, temporal penalty masks.

Public API (imported by __init__.py):
    get_raw_tokenizer, map_token_indices, build_segments,
    create_mask_fn, distribute_segment_lengths
"""

from __future__ import annotations

import logging
import math
from typing import Any, Callable, Optional, Sequence, TypedDict

import torch

__all__ = [
    "get_raw_tokenizer",
    "map_token_indices",
    "build_segments",
    "create_mask_fn",
    "distribute_segment_lengths",
    "SegmentMeta",
]

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Types
# ---------------------------------------------------------------------------

class SegmentMeta(TypedDict):
    """Per-segment metadata consumed by the temporal penalty builder."""
    local_token_idx: torch.Tensor   # 1-D long tensor of token indices
    midpoint: float                 # centre frame (float for sub-frame accuracy)
    window: float                   # flat anchor half-width (video)
    sigma: float                    # Gaussian decay width (video)
    strength: float                 # penalty multiplier (video)
    window_audio: float
    sigma_audio: float
    strength_audio: float


class RelayOptionsData:
    """Typed container for per-stream tuning knobs.

    Accepts keyword arguments; unknown keys are ignored so forward-compat
    with older workflow JSONs is preserved.
    """

    __slots__ = (
        "video_strength",
        "video_window_scale",
        "audio_epsilon",
        "audio_strength",
        "audio_window_scale",
        "per_segment_epsilon",
    )

    def __init__(
        self,
        video_strength: float = 1.0,
        video_window_scale: float = 1.0,
        audio_epsilon: Optional[float] = None,
        audio_strength: float = 1.0,
        audio_window_scale: float = 1.0,
        per_segment_epsilon: Optional[list[float]] = None,
        **_ignored: Any,
    ):
        self.video_strength = video_strength
        self.video_window_scale = video_window_scale
        self.audio_epsilon = audio_epsilon
        self.audio_strength = audio_strength
        self.audio_window_scale = audio_window_scale
        self.per_segment_epsilon = per_segment_epsilon

        # --- validation ---
        if not 0.0 <= self.video_strength <= 10.0:
            raise ValueError(f"video_strength must be in [0, 10], got {self.video_strength}")
        if not 0.0 <= self.video_window_scale <= 4.0:
            raise ValueError(f"video_window_scale must be in [0, 4], got {self.video_window_scale}")
        if self.audio_epsilon is not None and not 0.0 < self.audio_epsilon < 1.0:
            raise ValueError(f"audio_epsilon must be in (0, 1) or None, got {self.audio_epsilon}")
        if not 0.0 <= self.audio_strength <= 10.0:
            raise ValueError(f"audio_strength must be in [0, 10], got {self.audio_strength}")
        if not 0.0 <= self.audio_window_scale <= 4.0:
            raise ValueError(f"audio_window_scale must be in [0, 4], got {self.audio_window_scale}")

    # Allow dict-style access for backward compat with any external code
    # that still treats relay_options as a plain dict.
    def get(self, key: str, default: Any = None) -> Any:
        return getattr(self, key, default)

    def __repr__(self) -> str:
        fields = ", ".join(f"{k}={getattr(self, k)!r}" for k in self.__slots__)
        return f"RelayOptionsData({fields})"


# ---------------------------------------------------------------------------
# Tokenizer helpers
# ---------------------------------------------------------------------------

def get_raw_tokenizer(clip: Any) -> Any:
    """Extract the raw HuggingFace / SentencePiece tokenizer from a ComfyUI CLIP object.

    Tries known attribute names first (stable across ComfyUI 0.2.x–0.3.x),
    then falls back to a reflective walk.
    """
    tw = clip.tokenizer

    # Fast paths for known ComfyUI CLIP wrapper layouts
    for attr in ("t5xxl", "clip_l", "clip_g", "llama", "clip_h"):
        inner = getattr(tw, attr, None)
        if inner is not None and hasattr(inner, "tokenizer"):
            return inner.tokenizer

    # Generic fallback: walk public attributes
    for attr_name in dir(tw):
        if attr_name.startswith("_"):
            continue
        inner = getattr(tw, attr_name, None)
        if inner is not None and hasattr(inner, "tokenizer"):
            return inner.tokenizer

    raise RuntimeError(
        f"Could not find raw tokenizer on CLIP object (type={type(tw).__name__}). "
        f"Public attributes: {[a for a in dir(tw) if not a.startswith('_')]}"
    )


def map_token_indices(
    raw_tokenizer: Any,
    global_prompt: str,
    local_prompts: list[str],
) -> tuple[str, list[tuple[int, int]]]:
    """Tokenize *global_prompt* followed by space-prefixed *local_prompts*.

    Returns ``(full_prompt, token_ranges)`` where each range is
    ``(start, end)`` in token-index space (half-open).

    Uses incremental tokenization to avoid SentencePiece context-dependency
    issues at segment boundaries.  Warns and clamps if the combined prompt
    exceeds the tokenizer's context window.
    """
    prefixed_locals = [" " + lp for lp in local_prompts]
    full_prompt = global_prompt + "".join(prefixed_locals)

    has_eos = getattr(raw_tokenizer, "add_eos", False)
    eos_adj = 1 if has_eos else 0

    # Determine the effective context window
    model_max = getattr(raw_tokenizer, "model_max_length", None)
    if model_max is None or model_max > 1_000_000:
        # Some tokenizers report a sentinel huge value; probe instead
        probe_ids = raw_tokenizer("test")["input_ids"]
        model_max = len(probe_ids) + 74  # conservative fallback

    effective_max = model_max - eos_adj  # reserve room for EOS

    prev_len = len(raw_tokenizer(global_prompt)["input_ids"]) - eos_adj
    token_ranges: list[tuple[int, int]] = []
    built = global_prompt

    for plp in prefixed_locals:
        built += plp
        cur_len = len(raw_tokenizer(built)["input_ids"]) - eos_adj
        if cur_len <= prev_len:
            raise ValueError(
                f"Local prompt produced no new tokens: '{plp.strip()}'. "
                "It may be empty or consist entirely of whitespace / special characters."
            )
        token_ranges.append((prev_len, cur_len))
        prev_len = cur_len

    # --- Overflow guard ---
    if prev_len > effective_max:
        log.warning(
            "[PromptRelay] Full prompt is %d tokens but the tokenizer caps at %d "
            "(effective %d after EOS). Segments beyond token %d will be silently "
            "truncated and their temporal masks will have no effect. Shorten the "
            "global prompt or reduce the number of local prompts.",
            prev_len, model_max, effective_max, effective_max,
        )
        clamped: list[tuple[int, int]] = []
        for s, e in token_ranges:
            if s >= effective_max:
                continue  # entire segment lives past the window
            clamped.append((s, min(e, effective_max)))
        token_ranges = clamped
        # Truncate the prompt string so CLIP doesn't see dangling text
        truncated_ids = raw_tokenizer(full_prompt)["input_ids"][:effective_max]
        full_prompt = raw_tokenizer.decode(truncated_ids, skip_special_tokens=True)

    return full_prompt, token_ranges


# ---------------------------------------------------------------------------
# Segment length distribution
# ---------------------------------------------------------------------------

def distribute_segment_lengths(
    num_segments: int,
    latent_frames: int,
    specified_lengths: Optional[list[int]] = None,
) -> list[int]:
    """Validate or auto-distribute segment frame counts.

    If *specified_lengths* is given it must have exactly *num_segments*
    entries.  Otherwise segments are distributed as evenly as possible
    using ceiling division (matching the reference implementation).

    Every entry in the returned list is ≥ 0 and the sum ≤ *latent_frames*.
    """
    if specified_lengths is not None:
        if len(specified_lengths) != num_segments:
            raise ValueError(
                f"segment_lengths has {len(specified_lengths)} entries but there "
                f"are {num_segments} local prompts. They must match 1:1."
            )
        lengths = list(specified_lengths)
    else:
        # Ceiling division so the first segments absorb the remainder
        step = -(-latent_frames // num_segments)
        lengths = [step] * num_segments

    effective: list[int] = []
    cursor = 0
    for L in lengths:
        end = min(cursor + max(L, 0), latent_frames)
        seg_len = max(end - cursor, 0)
        if seg_len == 0 and L > 0:
            log.warning(
                "[PromptRelay] Segment requested %d frames but only 0 remain "
                "(latent_frames=%d, %d segments). It will be skipped.",
                L, latent_frames, num_segments,
            )
        effective.append(seg_len)
        cursor = end

    return effective


# ---------------------------------------------------------------------------
# Temporal penalty construction
# ---------------------------------------------------------------------------

def _epsilon_to_sigma(epsilon: float) -> float:
    """Paper formula: σ = 1 / ln(1/ε).  Falls back to 0.1448 for ε = 0.001."""
    if 0 < epsilon < 1:
        return 1.0 / math.log(1.0 / epsilon)
    return 0.1448  # ≈ 1/ln(1000)


def build_segments(
    token_ranges: list[tuple[int, int]],
    segment_lengths: list[int],
    epsilon: float = 1e-3,
    relay_options: Optional[RelayOptionsData] = None,
) -> list[SegmentMeta]:
    """Build per-segment metadata dicts consumed by the penalty matrix builder.

    *relay_options* (optional) overrides per-stream knobs.  Audio knobs only
    affect architectures whose cross-attention takes the scaled (non-integer-
    frame) path — currently LTX audio_attn2.
    """
    opts = relay_options or RelayOptionsData()

    v_strength = opts.video_strength
    v_window_scale = opts.video_window_scale
    a_strength = opts.audio_strength
    a_window_scale = opts.audio_window_scale

    sigma_audio = (
        _epsilon_to_sigma(opts.audio_epsilon)
        if opts.audio_epsilon is not None
        else _epsilon_to_sigma(epsilon)
    )

    if relay_options is not None:
        log.info(
            "[PromptRelay] Advanced options — video: strength=%.3f window_scale=%.3f | "
            "audio: epsilon=%s strength=%.3f window_scale=%.3f",
            v_strength, v_window_scale,
            f"{opts.audio_epsilon:.4f}" if opts.audio_epsilon is not None else "inherit",
            a_strength, a_window_scale,
        )

    q_token_idx: list[SegmentMeta] = []
    frame_cursor = 0

    for i, ((tok_start, tok_end), L) in enumerate(zip(token_ranges, segment_lengths)):
        if L <= 0:
            log.warning(
                "[PromptRelay] Segment %d has %d latent frames — dropped. "
                "Too few frames for %d segments.",
                i, L, len(segment_lengths),
            )
            # frame_cursor += 0  (no advance)
            continue

        # Per-segment epsilon override
        seg_epsilon = epsilon
        if opts.per_segment_epsilon and i < len(opts.per_segment_epsilon):
            seg_epsilon = opts.per_segment_epsilon[i]
        sigma = _epsilon_to_sigma(seg_epsilon)

        # True float centre (avoids integer-division leftward bias)
        midpoint = frame_cursor + (L - 1) / 2.0

        base_window = max(L / 2.0 - 2.0, 0.0)

        q_token_idx.append(SegmentMeta(
            local_token_idx=torch.arange(tok_start, tok_end),
            midpoint=midpoint,
            window=max(base_window * v_window_scale, 0.0),
            sigma=sigma,
            strength=v_strength,
            window_audio=max(base_window * a_window_scale, 0.0),
            sigma_audio=sigma_audio,
            strength_audio=a_strength,
        ))
        frame_cursor += L

    return q_token_idx


# ---------------------------------------------------------------------------
# Penalty matrices
# ---------------------------------------------------------------------------

def build_temporal_cost(
    q_token_idx: list[SegmentMeta],
    Lq: int,
    Lk: int,
    device: torch.device,
    dtype: torch.dtype,
    tokens_per_frame: int,
) -> torch.Tensor:
    """Gaussian penalty matrix ``[Lq, Lk]`` for video cross-attention.

    Queries map to integer frames via ``query_idx // tokens_per_frame``.
    """
    offset = torch.zeros(Lq, Lk, device=device, dtype=dtype)
    query_frames = (
        torch.arange(Lq, device=device, dtype=torch.float32) // tokens_per_frame
    )

    if not q_token_idx:
        return offset

    # Vectorise the per-segment distance / cost computation
    midpoints = torch.tensor(
        [s["midpoint"] for s in q_token_idx], device=device, dtype=torch.float32,
    )
    windows = torch.tensor(
        [s["window"] for s in q_token_idx], device=device, dtype=torch.float32,
    )
    sigmas = torch.tensor(
        [s["sigma"] for s in q_token_idx], device=device, dtype=torch.float32,
    )
    strengths = torch.tensor(
        [s["strength"] for s in q_token_idx], device=device, dtype=torch.float32,
    )

    # [num_seg, Lq]
    d = (query_frames[None, :] - midpoints[:, None]).abs()
    costs = strengths[:, None] * (torch.relu(d - windows[:, None]) ** 2) / (
        2.0 * sigmas[:, None] ** 2
    )

    for i, seg in enumerate(q_token_idx):
        local = seg["local_token_idx"].to(device=device)
        offset[:, local] = costs[i].to(offset.dtype)

    return offset


def build_temporal_cost_scaled(
    q_token_idx: list[SegmentMeta],
    Lq: int,
    Lk: int,
    device: torch.device,
    dtype: torch.dtype,
    latent_frames: int,
) -> torch.Tensor:
    """Penalty matrix for queries that don't map to integer frames.

    Used for e.g. LTXAV audio tokens where ``Lq != latent_frames * tpf``.
    """
    offset = torch.zeros(Lq, Lk, device=device, dtype=dtype)
    query_frames = (
        torch.arange(Lq, device=device, dtype=torch.float32) * latent_frames / max(Lq, 1)
    )

    if not q_token_idx:
        return offset

    midpoints = torch.tensor(
        [s["midpoint"] for s in q_token_idx], device=device, dtype=torch.float32,
    )
    windows_a = torch.tensor(
        [s["window_audio"] for s in q_token_idx], device=device, dtype=torch.float32,
    )
    sigmas_a = torch.tensor(
        [s["sigma_audio"] for s in q_token_idx], device=device, dtype=torch.float32,
    )
    strengths_a = torch.tensor(
        [s["strength_audio"] for s in q_token_idx], device=device, dtype=torch.float32,
    )

    d = (query_frames[None, :] - midpoints[:, None]).abs()
    costs = strengths_a[:, None] * (torch.relu(d - windows_a[:, None]) ** 2) / (
        2.0 * sigmas_a[:, None] ** 2
    )

    for i, seg in enumerate(q_token_idx):
        local = seg["local_token_idx"].to(device=device)
        offset[:, local] = costs[i].to(offset.dtype)

    return offset


# ---------------------------------------------------------------------------
# Mask closure
# ---------------------------------------------------------------------------

def create_mask_fn(
    q_token_idx: list[SegmentMeta],
    fallback_tokens_per_frame: int,
    latent_frames: int,
) -> Callable[[int, int, torch.dtype, torch.device, dict], Optional[torch.Tensor]]:
    """Return a closure suitable for use as a ComfyUI attn2 patch.

    Signature of the returned callable::

        mask_fn(Lq, Lk, dtype, device, transformer_options) -> Tensor | None

    It takes shapes / dtype / device instead of tensors so callers can
    compute the mask without first materialising q / k projections —
    required so PromptRelay can wrap an existing cross-attn forward
    (e.g. KJNodes NAG) instead of replacing it.
    """
    cache: dict[tuple, torch.Tensor] = {}

    if not q_token_idx:
        # No segments → no-op mask
        def _noop(Lq, Lk, dtype, device, transformer_options):
            return None
        return _noop

    max_token_idx = max(
        int(seg["local_token_idx"].max().item()) for seg in q_token_idx
    ) + 1

    _logged_cross_modal = False

    def mask_fn(
        Lq: int,
        Lk: int,
        dtype: torch.dtype,
        device: torch.device,
        transformer_options: dict,
    ) -> Optional[torch.Tensor]:
        nonlocal _logged_cross_modal

        # Self-attention: Lq == Lk → not cross-attn, skip
        if Lq == Lk:
            return None

        # Only apply on the conditional pass.
        # ComfyUI: 0 = conditional, 1 = unconditional.
        # When only the unconditional branch is running, skip.
        # When both are batched ([0, 1]) the mask applies to the full batch
        # intentionally — the negative prompt gets the same temporal structure
        # so the unconditional branch doesn't "fill in" regions the positive
        # branch is trying to suppress.
        cond_or_uncond = transformer_options.get("cond_or_uncond", [])
        if 1 in cond_or_uncond and 0 not in cond_or_uncond:
            return None

        grid_sizes = transformer_options.get("grid_sizes", None)
        if grid_sizes is not None:
            video_tpf = int(grid_sizes[1]) * int(grid_sizes[2])
        else:
            video_tpf = fallback_tokens_per_frame
        video_lq = latent_frames * video_tpf

        # Skip cross-modal attention (e.g. audio↔video) where the key
        # sequence is padded to a fixed length ≥ max_token_idx and != video_lq.
        if Lk == video_lq or Lk < max_token_idx:
            if not _logged_cross_modal and Lk < max_token_idx:
                log.debug(
                    "[PromptRelay] Skipping cross-modal attn (Lk=%d < max_token_idx=%d)",
                    Lk, max_token_idx,
                )
                _logged_cross_modal = True
            return None

        mode = "video" if Lq == video_lq else "scaled"

        # Include dtype in the cache key so mixed-precision layers don't
        # pay a cast on every call.
        key = (Lq, Lk, mode, device, dtype)
        if key not in cache:
            if mode == "video":
                cost = build_temporal_cost(
                    q_token_idx, Lq, Lk, device, dtype, video_tpf,
                )
            else:
                cost = build_temporal_cost_scaled(
                    q_token_idx, Lq, Lk, device, dtype, latent_frames,
                )
            nonzero = int((cost > 0).sum().item())
            log.debug(
                "[PromptRelay] Built penalty matrix (%s): Lq=%d Lk=%d "
                "nonzero=%d/%d (%.1f%%)",
                mode, Lq, Lk, nonzero, cost.numel(),
                100.0 * nonzero / max(cost.numel(), 1),
            )
            cache[key] = -cost  # negative → additive penalty

        return cache[key]

    return mask_fn