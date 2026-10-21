> 🌀 **Nougan Suite** · [← Back to docs](README.md)

# 🧬 Nougan RefMod

Self-contained RefMod toolkit for **MiniMax H3**. **No other custom-node pack required.**

Bake a character (portraits and/or video frames, plus a voice sample) into a single reusable file, then drop that character into any H3 video workflow with one node.

## Install

RefMod ships as part of the Nougan suite, so there is nothing extra to install.

1. Keep the suite folder in `ComfyUI/custom_nodes/`.
2. Make sure these are present inside it:
   - `nougan_refmod.py`: the three nodes
   - `nougan_engine/`: the vendored engine (and its `LICENSE`)
   - `web/nougan_refmod.js`: the card UI
3. Restart ComfyUI and hard-refresh the browser (Ctrl+F5).

On a good start the console shows `✔ RefMod Toolkit (3 nodes)`.

## Nodes

Category: `Nougan/RefMod`

### Nougan RefMod Bake (Character)
portraits (images / video_frames / folder) + audio → **ONE** file in
`models/refmods/<subfolder>/<name>.safetensors`,
plus a face thumbnail and an audio waveform for the UI cards. Extraction only, no training.

### Nougan RefMod Apply
**The one you want in your video workflow.**
conditioning in → conditioning out. Character dropdown, face / voice sliders, retention.

### Nougan RefMod Loader
Same character picker, outputs `mods` (`H3_REF_MODS`) if you want to wire your own Apply.

## UI

- **Compact by default:** one character, face / voice sliders. `＋ character` adds up to 4 slots, `－` removes one.
- **`⚙ advanced`** reveals:
  - Per slot: master / copies / use
  - **Apply:** token budget, curve (direction / shape / value) and scramble (seed / mode / keep)
  - **Loader:** show info, token budget
  - **Bake:** resolution, visual budget, audio type and limits, folder limits, subfolder, overwrite
- **Cards** show the thumbnail, FACE / VOICE chips with live strengths, the waveform and the token count.
- **Right-click** a node for the same actions.

## Workflow

**Bake**

```
Load Image / folder ─┐
Load Audio ──────────┤
VAELoader (video) ───┼─► Nougan RefMod Bake ─► models/refmods/…
VAELoader (audio) ───┘
```

**Generate**

```
MiniMax H3 Image To Video (positive) ─► Nougan RefMod Apply ─► sampler (conditioning)
```

## Files on disk

| File | What it is |
|---|---|
| `<name>.safetensors` | The baked character (bundle format v5) |
| `<name>.safetensors.nougan.jpg` | Face thumbnail shown on the card |
| `<name>.safetensors.nougan.json` | Sidecar info (token counts, waveform peaks) |

The card UI reads the library through `GET /nougan/refmods` and thumbnails through `GET /nougan/refmods/thumb`.

## Troubleshooting

- **The nodes don't appear:** check the console for `✘ RefMod Toolkit NOT loaded` and read the error under it. The engine needs a ComfyUI build with MiniMax H3 support, and a missing module there stops only RefMod, not the rest of Nougan.
- **Dropdown is empty:** bake a character first, or confirm your files are in `models/refmods`, then refresh the node list.
- **Cards look unstyled or missing:** hard-refresh (Ctrl+F5) so the browser loads `nougan_refmod.js`.
- **Audio won't bake:** connect the MiniMax **H3 audio** VAE to the audio input, not the video VAE.

## Credits / license

The RefMod engine in `nougan_engine/` is vendored from **ComfyUI-MiniMaxH3Mod by Luisa (luisacaotica)**,
MIT License, upstream commit `517e8c4` ([github.com/Luisacaotica/ComfyUI-MiniMaxH3Mod](https://github.com/Luisacaotica/ComfyUI-MiniMaxH3Mod)).

Her license text is kept in `nougan_engine/LICENSE`; keep it if you redistribute.
The bundle file format is hers (v5), so her stock loader opens files baked here.
