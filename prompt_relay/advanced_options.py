"""Prompt Relay Advanced Options node and RelayOptions custom type."""

from __future__ import annotations

import logging

from comfy_api.latest import io

# Changed: was "from .prompt_relay import …"
from .relay_core import RelayOptionsData

log = logging.getLogger(__name__)

RelayOptions = io.Custom("RELAY_OPTIONS")


class PromptRelayAdvancedOptions(io.ComfyNode):
    """Per-stream temporal-penalty knobs for Prompt Relay encoders."""

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="PromptRelayAdvancedOptions",
            display_name="Nougan Prompt Relay Options ⚙️",
            category="conditioning/prompt_relay",
            is_experimental=True,
            description=(
                "Optional per-stream tuning. Connect to the relay_options input "
                "on a Prompt Relay encoder. Audio fields only affect LTX2 / LTXAV."
            ),
            inputs=[
                io.Float.Input(
                    "video_strength",
                    default=1.0, min=0.0, max=10.0, step=0.05,
                    tooltip=(
                        "Multiplier on the video temporal penalty. 0 disables video "
                        "segmentation. Most useful in the 0–1 range to soften boundaries; "
                        "values >1 saturate quickly at the default epsilon (1e-3) because "
                        "the bias is already large enough to zero out distant tokens. To "
                        "make >1 visibly meaningful, raise epsilon to ~0.1 or higher."
                    ),
                ),
                io.Float.Input(
                    "video_window_scale",
                    default=1.0, min=0.0, max=4.0, step=0.05,
                    tooltip=(
                        "Scales the flat anchor zone (default L/2 − 2 frames). "
                        "<1 starts the soft falloff sooner; >1 widens the rigid zone. "
                        "0 collapses the anchor to a point — falloff begins immediately "
                        "at the segment midpoint (sharper than default, not softer)."
                    ),
                ),
                io.Float.Input(
                    "audio_epsilon",
                    default=0.0, min=0.0, max=0.99, step=1e-4,
                    tooltip=(
                        "Epsilon for the audio stream. 0 = inherit from the encoder's "
                        "main epsilon."
                    ),
                ),
                io.Float.Input(
                    "audio_strength",
                    default=1.0, min=0.0, max=10.0, step=0.05,
                    tooltip=(
                        "Multiplier on the audio temporal penalty. 0 lets audio bleed "
                        "across visual cuts. Most useful in the 0–1 range; values >1 "
                        "saturate quickly at the default epsilon (1e-3) — raise "
                        "audio_epsilon to ~0.1 or higher to make >1 visibly meaningful."
                    ),
                ),
                io.Float.Input(
                    "audio_window_scale",
                    default=1.0, min=0.0, max=4.0, step=0.05,
                    tooltip=(
                        "Scales the flat anchor zone width for the audio stream. "
                        "<1 starts the soft falloff sooner; >1 widens the rigid zone. "
                        "0 collapses the anchor to a point."
                    ),
                ),
            ],
            outputs=[
                RelayOptions.Output(display_name="relay_options"),
            ],
        )

    @classmethod
    def execute(
        cls,
        video_strength: float,
        video_window_scale: float,
        audio_epsilon: float,
        audio_strength: float,
        audio_window_scale: float,
    ) -> io.NodeOutput:
        opts = RelayOptionsData(
            video_strength=video_strength,
            video_window_scale=video_window_scale,
            audio_epsilon=audio_epsilon if audio_epsilon > 0 else None,
            audio_strength=audio_strength,
            audio_window_scale=audio_window_scale,
        )
        return io.NodeOutput(opts)