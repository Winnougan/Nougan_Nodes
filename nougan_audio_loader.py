# nougan_audio_loader.py — Nougan suite
# Load an audio file (AUDIO upload widget) and crop it with the visual
# waveform editor in web/nougan_audio_loader.js.
#
# crop_end = 0 means "end of file" so a freshly placed node passes the
# audio through untouched until you drag a crop edge in the editor.

import torch


class NouganAudioLoader:
    CATEGORY = "Nougan"
    RETURN_TYPES = ("AUDIO",)
    RETURN_NAMES = ("audio",)
    FUNCTION = "load"
    DESCRIPTION = (
        "Load an audio file and crop it with a visual waveform editor: "
        "drag the region edges to crop, drag anywhere to scrub with audible preview."
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "audio": ("AUDIO", {"audio_upload": True, "file_filter": "audio"}),
                "crop_start": ("FLOAT", {
                    "default": 0.0, "min": 0.0, "max": 1e7, "step": 0.01,
                    "tooltip": "Crop start in seconds (driven by the waveform editor).",
                }),
                "crop_end": ("FLOAT", {
                    "default": 0.0, "min": 0.0, "max": 1e7, "step": 0.01,
                    "tooltip": "Crop end in seconds. 0 = end of file (driven by the waveform editor).",
                }),
            }
        }

    def load(self, audio, crop_start, crop_end):
        waveform = audio["waveform"]
        sample_rate = audio["sample_rate"]

        total = waveform.shape[-1] / sample_rate
        start = min(max(float(crop_start), 0.0), total)
        end = total if crop_end <= 0 else min(float(crop_end), total)

        if end - start < 0.01:
            raise ValueError(
                f"[Nougan Audio Loader] Crop is empty ({start:.2f}s → {end:.2f}s). "
                "Widen the crop region in the editor."
            )

        i0 = int(round(start * sample_rate))
        i1 = int(round(end * sample_rate))
        out = waveform[..., i0:i1].contiguous()

        return ({"waveform": out, "sample_rate": sample_rate},)


NODE_CLASS_MAPPINGS = {"NouganAudioLoader": NouganAudioLoader}
NODE_DISPLAY_NAME_MAPPINGS = {"NouganAudioLoader": "Nougan Audio Loader 🎵"}
