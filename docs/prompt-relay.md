> 🌀 **Nougan Suite** · [← Back to overview](../README.md) · [All docs](./)

# 🎬 Nougan Prompt Relay
<img width="1086" height="1448" alt="Prompt_Replay_Revamp_03" src="https://github.com/user-attachments/assets/53420daa-ff67-4ce9-99a0-65e57b9ae107" />

**Temporal local-prompt control for LTX Video · LTX2 · LTXAV**

A ground-up rewrite of Kijai's Prompt Relay — with a visual timeline editor, token-overflow safety, non-destructive model patching, and per-stream audio tuning.

[![ComfyUI](https://img.shields.io/badge/ComfyUI-custom%20nodes-orange)](https://github.com/comfyanonymous/ComfyUI)
[![Models](https://img.shields.io/badge/models-LTX%20%C2%B7%20LTX2%20%C2%B7%20LTXAV-blue)](https://huggingface.co/Lightricks/LTX-Video)
[![Nodes](https://img.shields.io/badge/nodes-3-success)](#node-reference)
[![License](https://img.shields.io/badge/license-MIT-green)](../README.md#license)
---

## What it does

Prompt Relay conditions **different time segments of a video with different prompts**, while one global prompt anchors the whole scene. It injects a Gaussian temporal penalty into cross-attention so segment A's tokens are suppressed when the model attends from segment B's frames — producing smooth, text-driven scene transitions with no keyframes, no ControlNet, no img2img chains.

```text
GLOBAL:  "cinematic, 35mm film, a red fox"

  0s ──────── 2s ──────── 4s ──────── 5.4s
  ┌───────────┬───────────┬───────────┐
  │ trots     │ pauses at │ vanishes  │
  │ through   │ the edge  │ into      │
  │ snowfall  │ of a lake │ morning   │
  │           │           │ mist      │
  └───────────┴───────────┴───────────┘
   segment 1    segment 2   segment 3
```

One latent. One sampler pass. Three distinct scenes, blended where you want them blended.

---

## ✨ Why this fork

Kijai's original introduced Prompt Relay to ComfyUI. This is a full rewrite of every layer — tokenization, segment math, penalty construction, model patching, and the UI — fixing correctness bugs and adding what was missing.

| Area | Kijai's original | Nougan Prompt Relay |
|---|---|---|
| **Token overflow** | Silent truncation; mask indices desync from real tokens | Detected, warned, clamped; ranges remapped to the live window |
| **Segment midpoint** | Integer division, biases left on even-length segments | True float centre |
| **Penalty cache** | Key omits `dtype` → redundant casts in mixed precision | Key includes `dtype` → zero casts after first build |
| **Penalty math** | Per-segment Python loop | Vectorised broadcast, single pass |
| **Full-coverage snap** | Hijacks intentionally partial timelines | Snaps only within ±1 temporal stride of full extent |
| **Model patching** | Replaces attn2 forward, discarding prior patches | Wraps & chains after KJNodes NAG, custom CFG, etc. |
| **CFG batching** | Mask can leak into the unconditional branch | Explicit `cond_or_uncond` guard, documented behaviour |
| **Audio stream** | Not handled | LTXAV `audio_attn2` patched with independent knobs |
| **Tokenizer extraction** | Pure reflection, breaks on refactors | Fast paths for known wrappers + reflective fallback |
| **Options** | Raw `dict` — typos silently become defaults | Typed `RelayOptionsData` with validation |
| **Per-segment epsilon** | Single global value | Optional per-segment override list |
| **Zero-length segments** | Cursor stalls, segments overlap | Warned and cleanly skipped |
| **Pipeline** | Monolithic function | Decomposed, unit-testable stages |
| **Interface** | Two text fields | WYSIWYG timeline editor |
| **Advanced tuning** | None | Dedicated options node |
| **Suite isolation** | Standalone pack | `try/except` — never takes down sibling nodes |

---

## 📖 Table of Contents

- [What it does](#what-it-does)
- [Why this fork](#why-this-fork)
- [Installation](#installation)
- [Quick start](#quick-start)
- [The timeline editor](#the-timeline-editor)
- [Node reference](#node-reference)
- [Advanced options](#advanced-options)
- [Epsilon cheat sheet](#epsilon-cheat-sheet)
- [Technical deep dives](#technical-deep-dives)
- [Architecture](#architecture)
- [Troubleshooting](#troubleshooting)
- [Credits](#credits)

---

## 📦 Installation

Part of the Nougan suite. Drop the pack into `ComfyUI/custom_nodes/` and restart.

```bash
cd ComfyUI/custom_nodes
git clone <your-repo-url>
# restart ComfyUI
```

On success the console prints:

```text
[Nougan] ✅ Prompt Relay loaded (3 nodes).
```

If the sub-package fails for any reason, the suite's isolation guarantees your other nodes keep working:

```text
[Nougan] ⚠️  Prompt Relay NOT loaded (ImportError: …) — other nodes are fine.
```

---

##
