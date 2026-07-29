> 🌀 **Nougan Suite** · [← Back to overview](../README.md) · [All docs](./)

# Nougan LM Studio Bridge 🧠

**Local LLMs, vision, audio and video — inside your ComfyUI graph, powered by LM Studio.**

Two nodes that turn any model loaded in LM Studio's dev server into a live, streaming, multimodal ComfyUI node — with an on-node DOM console, a drag-and-drop image strip, and a resizable output reader.

![ComfyUI](https://img.shields.io/badge/ComfyUI-custom%20nodes-2b3342?style=flat-square)
![LM Studio](https://img.shields.io/badge/LM%20Studio-dev%20mode-ffb347?style=flat-square)
![Python](https://img.shields.io/badge/Python-3.10+-39c2ff?style=flat-square)
![Frontend](https://img.shields.io/badge/Frontend-live%20DOM%20console-43e08c?style=flat-square)
![Nodes](https://img.shields.io/badge/Nodes-2-c9d3e0?style=flat-square)

```text
┌─ NOUGAN LM STUDIO 🧠 ────────────────────────────────────┐
│ ● RENDERING · qwen2.5-vl · 🖼 1  🎞 0  🎧 0    ⟳ models ■│
│ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░░   128/512 tok    │
│ "…a rain-slicked rooftop, neon bleeding into puddles…"   │
│ ┌──────────────────────────────────────────────────────┐ │
│ │          [ dropped image · live preview ]            │ │
│ └──────────────────────────────────────────────────────┘ │
│                      ─── grip ───                        │
│ pasted.png                                     ⤢   ✕     │
└──────────────────────────────────────────────────────────┘
        │ RESPONSE                    │ PROMPT
        ▼                             ▼
┌─ NOUGAN LM STUDIO PROMPT BOX 💬 ─────────────────────────┐
│ ● PROMPT BOX · output ready   LINKED   1 842 ch   ⧉ copy │
│ ┌──────────────────────────────────────────────────────┐ │
│ │  combined prompt text — scrolls, resizes, copies     │ │
│ └──────────────────────────────────────────────────────┘ │
│                      ─── grip ───                        │
└──────────────────────────────────────────────────────────┘
```

---

## Contents

- [Nodes at a glance](#nodes-at-a-glance)
- [Features](#features)
- [Installation](#installation)
- [LM Studio setup](#lm-studio-setup)
- [Node reference — Nougan LM Studio 🧠](#node-reference--nougan-lm-studio-)
- [Node reference — Prompt Box 💬](#node-reference--prompt-box-)
- [Image strip gestures](#image-strip-gestures)
- [Progress bar lifecycle](#progress-bar-lifecycle)
- [Example workflows](#example-workflows)
- [Krea 2 Prompt Director](#krea-2-prompt-director)
- [Model compatibility](#model-compatibility)
- [Troubleshooting](#troubleshooting)
- [Technical notes](#technical-notes)
- [Dependencies](#dependencies)

---

## Nodes at a glance

| Node class | Display name | Role |
|---|---|---|
| `NouganLMStudio` | **Nougan LM Studio 🧠** | Streams chat completions from LM Studio. Text, vision, audio and video aware. Live DOM console with progress bar. |
| `NouganLMStudioPromptBox` | **Nougan LM Studio Prompt Box 💬** | Editable text box fed by the main node's `PROMPT` output. Renders results live on the node. |

Both are **output nodes** — either one can terminate a graph on its own.

---

## Features

- 🔌 Connects to **LM Studio's OpenAI-compatible dev server** (`/v1/chat/completions`)
- 🌊 **Token streaming** with an animated on-node progress bar
- 🚦 Status LED: idle → queued → rendering → streaming → done / error
- ⚡ **First-token latency** + tokens/sec readout
- 🖼️ **Built-in image strip** — click, drag-drop, or Ctrl+V an image straight onto the node
- 🔍 Resizable preview (drag grip), fit toggle, full-size **lightbox**
- 🎞️ **Video input** — IMAGE batches, VHS dicts, or file paths (evenly sampled frames)
- 🎧 **Audio input** — WAV-encoded for audio-capable models
- ⟳ **Model auto-detect** button (cycles loaded models) · ■ **interrupt** button
- 💬 Prompt Box with **live output pane**, LINKED/LOCAL chip, char count, one-click copy
- 📐 Both panes drag-resizable, sizes **persist with the workflow**
- 🛡️ Hardened: INT-field sanitizer, prompt-build injection, `urllib` fallback, isolated `try/except` registration

---

## Installation

### 1 · Files

Drop these into your Nougan Suite custom-node folder:

```text
ComfyUI/custom_nodes/YourNouganSuite/
├── __init__.py
├── lm_studio.py
└── web/
    └── nougan-lmstudio.js
```

### 2 · Register the nodes

Add this block to `__init__.py` alongside the other optional loaders (its own `try/except`, so it can never take down the rest of the suite):

```python
# ── Optional: LM Studio Bridge (LLM · vision · audio via LM Studio dev mode) ─
# Pairs with web/nougan-lmstudio.js (live DOM console + progress bar on node).
try:
    from .lm_studio import NouganLMStudio, NouganLMStudioPromptBox
    NODE_CLASS_MAPPINGS.update({
        "NouganLMStudio":          NouganLMStudio,
        "NouganLMStudioPromptBox": NouganLMStudioPromptBox,
    })
    NODE_DISPLAY_NAME_MAPPINGS.update({
        "NouganLMStudio":          "Nougan LM Studio 🧠",
        "NouganLMStudioPromptBox": "Nougan LM Studio Prompt Box 💬",
    })
    print("[Nougan] ✅ LM Studio Bridge loaded (2 nodes).")
except Exception as _e:
    import traceback
    print(f"[Nougan] ⚠️  LM Studio Bridge NOT loaded ({type(_e).__name__}: {_e}) — other nodes are fine.")
    traceback.print_exc()
```

### 3 · Restart & refresh

Restart ComfyUI (web files are scanned at boot), then hard-refresh the browser (**Ctrl + Shift + R**). The nodes appear under **Nougan Suite**.

---

## LM Studio setup

1. Open **LM Studio** and load a model.
2. Go to the **Developer** tab and start the local server (default port `1234`, CORS on by default).
3. Add **Nougan LM Studio 🧠** to your graph.
4. Click **⟳ models** on the node — it auto-fills `model_name` (click again to cycle through multiple loaded models).

Sanity check — this URL should return JSON listing your model:

```text
http://127.0.0.1:1234/v1/models
```

---

## Node reference — Nougan LM Studio 🧠

### Widgets

| Widget | Type | Notes |
|---|---|---|
| `server_url` | STRING | LM Studio dev server. Default `http://127.0.0.1:1234` |
| `model_name` | STRING | Auto-filled by the ⟳ button |
| `system_prompt` | STRING | Assistant instructions (system role) |
| `generate_prompt` | STRING | The main prompt box |
| `max_tokens` | INT | `-1` lets the model decide (bar goes indeterminate) |
| `temperature` | FLOAT | 0.0 – 2.0 |
| `top_p` | FLOAT | 0.0 – 1.0 |
| `stream` | BOOLEAN | Drives the live progress bar |
| `seed` | INT | Optional |
| `image_size` | COMBO | `1024 / 768 / 512` — longest side before encoding |
| `video_frames` | INT | Evenly-spaced frames sampled from video |

### Inputs

| Input | Type | Notes |
|---|---|---|
| `image` | IMAGE | Single image or batch → vision content parts |
| `audio` | AUDIO | → base64 WAV `input_audio` part (audio-capable model required) |
| `video` | `*` | IMAGE batch, VHS video dict, or file path string |
| `prompt_override` | STRING | Wired string replaces `generate_prompt` (feed the Prompt Box back in) |
| *(embedded image)* | — | Set invisibly by the on-node drop zone |

### Outputs

| Output | Type | Notes |
|---|---|---|
| `RESPONSE` | STRING | The model's answer |
| `PROMPT` | STRING | The final prompt that was sent — wire it into the Prompt Box |

---

## Node reference — Prompt Box 💬

### Widgets

| Widget | Type | Notes |
|---|---|---|
| `text` | STRING | Local editable text |
| `mode` | COMBO | How local text combines with the incoming prompt |
| `separator` | STRING | Inserted between texts in APPEND / PREPEND |

### Input & output

| Socket | Type | Notes |
|---|---|---|
| `prompt_in` | STRING | Wire from the main node's `PROMPT` (or any STRING) |
| `PROMPT_OUT` | STRING | Combined result — route anywhere, including back into `prompt_override` |

### Modes

| Mode | Behavior |
|---|---|
| `APPEND` | Incoming first, then local text |
| `PREPEND` | Local text first, then incoming |
| `REPLACE (local wins)` | Local text if present, else incoming |
| `PASSTHROUGH (incoming wins)` | Incoming if present, else local |

> 💡 **Live reader trick:** wire `RESPONSE → prompt_in` and set mode to `PASSTHROUGH` — the box becomes an on-node reader for whatever the LLM says.

---

## Image strip gestures

| Gesture | Effect |
|---|---|
| Click the dashed strip | Open file picker |
| Drag a file onto the panel | Load / replace the image |
| Hover the node + **Ctrl+V** | Paste a clipboard image |
| Click the preview | Toggle cover ↔ contain fit |
| Double-click the preview | Replace via picker |
| **Drag the grip** | Resize preview (48–480 px) — node grows live |
| Double-click the grip | Reset to default height |
| **⤢** | Full-size lightbox (click or Esc to close) |
| **✕** | Remove the image |

Dropped images upload to `ComfyUI/input/nougan_lms/` and the reference **survives save/reload** — the preview restores with the workflow, at your chosen height.

---

## Progress bar lifecycle

| Phase | LED | Bar | Readout |
|---|---|---|---|
| **QUEUED** | 🟠 amber pulse | indeterminate slide | — |
| **RENDERING** | 🟠 amber pulse | indeterminate (until first token) | media counts `🖼 🎞 🎧` |
| **STREAMING** | 🟢 green pulse | fills toward `max
