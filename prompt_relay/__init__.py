"""Nougan Prompt Relay — temporal local-prompt control for LTX Video.

Sub-package layout:
    relay_core.py        tokenisation, segment math, penalty masks
    patches.py           model-type detection, cross-attention patching
    advanced_options.py  RelayOptions custom type + advanced-options node

This __init__ re-exports the three node classes for registration by the
parent package's __init__.py.
"""

from __future__ import annotations

import logging
from typing import Optional

from comfy_api.latest import io

from .relay_core import (
    RelayOptionsData,
    get_raw_tokenizer,
    map_token_indices,
    build_segments,
    create_mask_fn,
    distribute_segment_lengths,
)
from .patches import detect_model_type, apply_patches
from .advanced_options import PromptRelayAdvancedOptions, RelayOptions

log = logging.getLogger(__name__)

__all__ = [
    "PromptRelayEncode",
    "PromptRelayEncodeTimeline",
    "PromptRelayAdvancedOptions",
]


# ---------------------------------------------------------------------------
# Pixel → latent length conversion
# ---------------------------------------------------------------------------

def _convert_to_latent_lengths(
    pixel_lengths: list[int],
    temporal_stride: int,
    latent_frames: int,
) -> list[int]:
    """Convert pixel-space segment lengths to integer latent-space lengths.

    Uses the largest-remainder method for fair rounding.  Only snaps to
    ``latent_frames`` when the pixel total is within one *stride* of the
    full pixel extent (i.e. the user clearly intended full coverage).
    """
    if not pixel_lengths:
        return []

    total_pixel = sum(pixel_lengths)
    if total_pixel <= 0:
        return [1] * len(pixel_lengths)

    naive_total = max(1, round(total_pixel / temporal_stride))
    target_total = min(latent_frames, naive_total)

    full_pixel = latent_frames * temporal_stride
    if abs(total_pixel - full_pixel) <= temporal_stride:
        target_total = latent_frames

    exact = [p * target_total / total_pixel for p in pixel_lengths]
    result = [int(e) for e in exact]
    diff = target_total - sum(result)
    if diff > 0:
        order = sorted(
            range(len(exact)),
            key=lambda i: -(exact[i] - int(exact[i])),
        )
        for k in range(diff):
            result[order[k % len(order)]] += 1

    for i in range(len(result)):
        if result[i] < 1:
            max_idx = max(range(len(result)), key=lambda j: result[j])
            if result[max_idx] > 1:
                result[max_idx] -= 1
                result[i] = 1

    return result


# ---------------------------------------------------------------------------
# Validation helpers
# ---------------------------------------------------------------------------

def _validate_inputs(
    global_prompt: Optional[str],
    local_prompts: Optional[str],
    segment_lengths: Optional[str],
) -> None:
    for name, val in (
        ("global_prompt", global_prompt),
        ("local_prompts", local_prompts),
        ("segment_lengths", segment_lengths),
    ):
        if val is None:
            raise ValueError(
                f"PromptRelay: '{name}' arrived as None. "
                "Likely causes: a stale workflow JSON saved with null, the "
                "timeline editor's web extension failing to load, or an "
                "upstream node returning None. Set the field to an empty "
                "string or fix the upstream connection."
            )


def _parse_local_prompts(local_prompts: str) -> list[str]:
    parts = [p.strip() for p in local_prompts.split("|") if p.strip()]
    if not parts:
        raise ValueError(
            "At least one local prompt is required (separate with |)."
        )
    return parts


def _parse_pixel_lengths(
    segment_lengths: str,
    num_prompts: int,
) -> Optional[list[int]]:
    if not segment_lengths.strip():
        return None
    pixel_lengths = [
        int(x.strip())
        for x in segment_lengths.split(",")
        if x.strip()
    ]
    if len(pixel_lengths) != num_prompts:
        raise ValueError(
            f"segment_lengths has {len(pixel_lengths)} entries but there "
            f"are {num_prompts} local prompts. They must match 1:1."
        )
    return pixel_lengths


# ---------------------------------------------------------------------------
# Core encode pipeline
# ---------------------------------------------------------------------------

def _build_relay_state(
    clip,
    global_prompt: str,
    locals_list: list[str],
    latent_frames: int,
    tokens_per_frame: int,
    parsed_lengths: Optional[list[int]],
    epsilon: float,
    relay_options: Optional[RelayOptionsData],
):
    """Pure computation: tokenise, encode, build mask.  No model mutation."""
    raw_tokenizer = get_raw_tokenizer(clip)
    full_prompt, token_ranges = map_token_indices(
        raw_tokenizer, global_prompt, locals_list,
    )

    log.info(
        "[PromptRelay] Global: tokens [0:%d] (%d tokens)",
        token_ranges[0][0] if token_ranges else 0,
        token_ranges[0][0] if token_ranges else 0,
    )
    for i, (s, e) in enumerate(token_ranges):
        log.info(
            "[PromptRelay] Segment %d: tokens [%d:%d] (%d tokens)",
            i, s, e, e - s,
        )

    conditioning = clip.encode_from_tokens_scheduled(
        clip.tokenize(full_prompt),
    )

    effective_lengths = distribute_segment_lengths(
        len(locals_list), latent_frames, parsed_lengths,
    )

    log.info(
        "[PromptRelay] Latent: %d frames, %d tokens/frame, segments: %s",
        latent_frames, tokens_per_frame, effective_lengths,
    )

    q_token_idx = build_segments(
        token_ranges, effective_lengths, epsilon, relay_options,
    )
    mask_fn = create_mask_fn(q_token_idx, tokens_per_frame, latent_frames)

    return conditioning, mask_fn


def _encode_relay(
    model,
    clip,
    latent,
    global_prompt: str,
    local_prompts: str,
    segment_lengths: str,
    epsilon: float,
    relay_options: Optional[RelayOptionsData] = None,
):
    """Full pipeline: validate → detect arch → build state → patch model."""
    _validate_inputs(global_prompt, local_prompts, segment_lengths)

    locals_list = _parse_local_prompts(local_prompts)
    arch, patch_size, temporal_stride = detect_model_type(model)

    samples = latent["samples"]
    latent_frames = samples.shape[2]
    tokens_per_frame = (
        (samples.shape[3] // patch_size[1])
        * (samples.shape[4] // patch_size[2])
    )

    pixel_lengths = _parse_pixel_lengths(segment_lengths, len(locals_list))
    parsed_lengths: Optional[list[int]] = None
    if pixel_lengths is not None:
        parsed_lengths = _convert_to_latent_lengths(
            pixel_lengths, temporal_stride, latent_frames,
        )

    conditioning, mask_fn = _build_relay_state(
        clip, global_prompt, locals_list,
        latent_frames, tokens_per_frame,
        parsed_lengths, epsilon, relay_options,
    )

    patched = model.clone()
    apply_patches(patched, arch, mask_fn)

    return patched, conditioning


# ---------------------------------------------------------------------------
# Nodes
# ---------------------------------------------------------------------------

class PromptRelayEncode(io.ComfyNode):
    """Encodes temporal local prompts and patches the model for Prompt Relay."""

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="PromptRelayEncode",
            display_name="Nougan Prompt Relay Encode 🎬",
            category="conditioning/prompt_relay",
            description=(
                "Encodes a global prompt combined with temporal local prompts "
                "and patches the model for Prompt Relay temporal control. "
                "Local prompts are separated by |. Use a standard "
                "CLIPTextEncode for the negative prompt."
            ),
            inputs=[
                io.Model.Input("model"),
                io.Clip.Input("clip"),
                io.Latent.Input(
                    "latent",
                    tooltip="Empty latent video — dimensions are read from its shape.",
                ),
                io.String.Input(
                    "global_prompt", multiline=True, default="",
                    tooltip=(
                        "Conditions the entire video. Anchors persistent "
                        "characters, objects, and scene context."
                    ),
                ),
                io.String.Input(
                    "local_prompts", multiline=True, default="",
                    tooltip="Ordered prompts for each temporal segment, separated by |",
                ),
                io.String.Input(
                    "segment_lengths", default="",
                    tooltip=(
                        "Comma-separated pixel-space frame counts per segment. "
                        "Leave empty to auto-distribute evenly."
                    ),
                ),
                io.Float.Input(
                    "epsilon", default=1e-3, min=1e-6, max=0.99, step=1e-4,
                    tooltip=(
                        "Penalty decay parameter. Values below ~0.1 all produce "
                        "sharp boundaries (paper default 0.001). For softer "
                        "transitions, try 0.5 or higher."
                    ),
                ),
                RelayOptions.Input(
                    "relay_options", optional=True,
                    tooltip=(
                        "Optional advanced per-stream tuning. Connect a "
                        "Prompt Relay Advanced Options node."
                    ),
                ),
            ],
            outputs=[
                io.Model.Output(display_name="model"),
                io.Conditioning.Output(display_name="positive"),
            ],
        )

    @classmethod
    def execute(
        cls,
        model,
        clip,
        latent,
        global_prompt: str,
        local_prompts: str,
        segment_lengths: str,
        epsilon: float,
        relay_options=None,
    ) -> io.NodeOutput:
        patched, conditioning = _encode_relay(
            model, clip, latent,
            global_prompt, local_prompts, segment_lengths,
            epsilon, relay_options,
        )
        return io.NodeOutput(patched, conditioning)


class PromptRelayEncodeTimeline(io.ComfyNode):
    """WYSIWYG timeline variant — segments and lengths come from a visual editor."""

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="PromptRelayEncodeTimeline",
            display_name="Nougan Prompt Relay Timeline 🎞️",
            category="conditioning/prompt_relay",
            description=(
                "Same as Prompt Relay Encode, but local prompts and segment "
                "lengths are edited visually as draggable blocks on a timeline. "
                "The max_frames input only sets the timeline scale (pixel space) "
                "— actual frame count is still read from the latent."
            ),
            inputs=[
                io.Model.Input("model"),
                io.Clip.Input("clip"),
                io.Latent.Input(
                    "latent",
                    tooltip="Empty latent video — dimensions are read from its shape.",
                ),
                io.String.Input(
                    "global_prompt", multiline=True, default="",
                    tooltip=(
                        "Conditions the entire video. Anchors persistent "
                        "characters, objects, and scene context."
                    ),
                ),
                io.Int.Input(
                    "max_frames", default=129, min=1, max=10000, step=1,
                    tooltip=(
                        "Total timeline length in pixel-space frames. Used by "
                        "the editor for visual scale only."
                    ),
                ),
                io.String.Input(
                    "timeline_data", default="",
                    tooltip="JSON state of the timeline editor (auto-managed; do not edit by hand).",
                ),
                io.String.Input(
                    "local_prompts", multiline=True, default="",
                    tooltip="Auto-populated from the timeline editor.",
                ),
                io.String.Input(
                    "segment_lengths", default="",
                    tooltip="Auto-populated from the timeline editor (pixel-space frame counts).",
                ),
                io.Float.Input(
                    "epsilon", default=1e-3, min=1e-6, max=0.99, step=1e-4,
                    tooltip=(
                        "Penalty decay parameter. Values below ~0.1 all produce "
                        "sharp boundaries (paper default 0.001). For softer "
                        "transitions, try 0.5 or higher."
                    ),
                ),
                io.Float.Input(
                    "fps", default=24.0, min=0.1, max=240.0, step=0.1,
                    optional=True,
                    tooltip=(
                        "Frames per second — only affects how time is displayed "
                        "in the timeline editor when time_units is set to 'seconds'."
                    ),
                ),
                io.Combo.Input(
                    "time_units",
                    options=["frames", "seconds"],
                    default="frames",
                    optional=True,
                    tooltip=(
                        "Display the ruler, segment ranges, length input, and "
                        "total in frames or seconds. Internal storage is always "
                        "pixel-space frames."
                    ),
                ),
                RelayOptions.Input(
                    "relay_options", optional=True,
                    tooltip=(
                        "Optional advanced per-stream tuning. Connect a "
                        "Prompt Relay Advanced Options node."
                    ),
                ),
            ],
            outputs=[
                io.Model.Output(display_name="model"),
                io.Conditioning.Output(display_name="positive"),
            ],
        )

    @classmethod
    def execute(
        cls,
        model,
        clip,
        latent,
        global_prompt: str,
        max_frames: int,
        timeline_data: str,
        local_prompts: str,
        segment_lengths: str,
        epsilon: float,
        fps: float = 24.0,
        time_units: str = "frames",
        relay_options=None,
    ) -> io.NodeOutput:
        # Log a hint when max_frames disagrees with the latent's implied
        # pixel extent so users understand which value is authoritative.
        try:
            _, _, temporal_stride = detect_model_type(model)
            implied_pixel = (latent["samples"].shape[2] - 1) * temporal_stride + 1
            if max_frames != implied_pixel:
                log.info(
                    "[PromptRelay] max_frames=%d but latent implies %d pixel "
                    "frames (latent_frames=%d, stride=%d). The latent is "
                    "authoritative; max_frames only affects the editor scale.",
                    max_frames, implied_pixel,
                    latent["samples"].shape[2], temporal_stride,
                )
        except Exception:
            pass  # detection may fail for exotic models; non-fatal

        patched, conditioning = _encode_relay(
            model, clip, latent,
            global_prompt, local_prompts, segment_lengths,
            epsilon, relay_options,
        )
        return io.NodeOutput(patched, conditioning)