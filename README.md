<div align="center">

# 🌀 Winnougan (Nougan's Nodes)
<img width="1536" height="1024" alt="Nougan Nodes" src="https://github.com/user-attachments/assets/e292034a-5854-43a4-9141-705c170dfd3f" />


### Custom nodes for [ComfyUI](https://github.com/comfyanonymous/ComfyUI)

**An intuitive Diffusers loader, a workflow‑native image/mask grabber, a one‑toggle Krea 2 uncensor stage with bundled LoRAs, a combined text‑encode + zero‑negative node, a reusable prompt card, a zoom‑proof billboard title, and a themed LoRA loader with favourites, folder filters and a randomizer — all with custom UIs.**

[![ComfyUI](https://img.shields.io/badge/ComfyUI-nodes-006064?style=for-the-badge)](https://github.com/comfyanonymous/ComfyUI)
[![Python](https://img.shields.io/badge/Python-3.10%2B-3776ab?style=for-the-badge&logo=python&logoColor=white)](https://www.python.org/)
[![Nodes](https://img.shields.io/badge/nodes-8-ff4081?style=for-the-badge)](#-nodes)
[![License](https://img.shields.io/badge/license-MIT-69f0ae?style=for-the-badge)](#-license)

</div>

---

## ✨ Overview

**Nougan** is a small, focused collection of ComfyUI nodes built for clean workflows and fast iteration:

- 🚀 **Nougan Diffusers Loader** — drop in a Diffusers model *folder* (or single file) and get `MODEL`, `CLIP`, and `VAE` out automatically. Precision is auto‑detected from the files (no weight‑type dropdown). Optionally patch in **SageAttention 2/3** or **FlashAttention 2/3/4** for faster inference.
- 🌀 **Nougan Krea 2 · Uncensored** — a single pipeline stage that **bakes in three bundled uncensored LoRAs**. Toggle 1, 2, or all 3 and set each strength (uncapped). Sits *after* the model and *before* your regular LoRA loader. The LoRAs ship inside the pack, so the workflow is fully portable.
- 🖼️ **Nougan Get Image** — grab an image that's *already in your workflow* (no loading from disk) and split it into `IMAGE` + `MASK`, exactly like the native Load Image node. Includes live in‑node previews.
- 🎯 **Nougan Text Encode + Zero Neg** — one node that encodes your positive prompt **and** builds the negative conditioning (zero‑out *or* empty‑string) in a single step, replacing the classic two‑node chain.
- 📝 **Nougan Text Box** — a clean, save‑safe **prompt card**: type once, emit a `STRING` you can feed any text input (usually a text encoder). Live char / word / line counts, Copy & Clear buttons.
- 🌈 **Nougan Title Font** — a bold, colorful, fully‑styled **banner / title** node with a live preview, 6 styles, glow, 6 animations, color pickers + gradient presets, an optional clickable web link — and it stays a **constant on‑screen size no matter how far you zoom** (a true billboard).
- 📁 **Nougan Lora Loader** *(+ a **Multi‑Model** variant for up to 5 models)* — a themed LoRA **stack editor** with a custom chooser (live search + ☆ favourites), a folder filter, and a 🎲 **randomizer** with per‑line roll / lock / auto‑roll. Outputs `MODEL · CLIP · LORA_STACK` so it chains with the rest of the ecosystem.

All eight nodes ship with a custom, themed frontend UI. The pack also includes a **global Tab‑cycler** quality‑of‑life extension (not a node — see below) that works on *every* node in your graph.

---

## 📦 Nodes

| Node | Category | Outputs | Description |
|------|----------|---------|-------------|
| **Nougan Diffusers Loader 🚀** | `loaders` | `MODEL`, `CLIP`, `VAE` | Intuitively loads a Diffusers model folder or file; optional attention patching. |
| **Nougan Krea 2 · Uncensored 🌀** | `loaders` | `MODEL`, `CLIP`, `applied` | Bakes in 1–3 bundled uncensored LoRAs with per‑LoRA ON/OFF + uncapped strength. |
| **Nougan Get Image 🖼️** | `image` | `IMAGE`, `MASK` | Grabs an in‑workflow image and extracts a mask, with live previews. |
| **Nougan Text Encode + Zero Neg 🎯** | `conditioning` | `POSITIVE`, `NEGATIVE` | Encodes the positive prompt and builds the negative (zero‑out / empty‑string) in one node. |
| **Nougan Text Box 📝** | `utils` | `TEXT` | A reusable, styled prompt card that emits its text as a `STRING`. |
| **Nougan Title Font 🌈** | `utils` | `TEXT` | A zoom‑proof, fully‑styled title banner with optional clickable web link. |
| **Nougan Lora Loader 📁** | `loaders` | `MODEL`, `CLIP`, `lora_stack` | Themed LoRA stack editor: chooser + favourites + folder filter + randomizer. |
| **Nougan Lora Loader (Multi‑Model) 📁** | `loaders` | `MODEL`, `CLIP`, `lora_stack`, `MODEL 2–5` | Same editor, plus up to 4 extra model paths that share the stack. |

---

### 🚀 Nougan Diffusers Loader

Loads a Diffusers model and returns its components. Point it at a model **folder** containing `unet/`, `text_encoder/`, `text_encoder_2/`, and `vae/` subfolders — or at a single unified model file. The node hunts down the right files for you.

**Inputs**

| Name | Type | Description |
|------|------|-------------|
| `model_name` | combo | Any folder or file found in `diffusion_models/`, `unet/`, or `diffusers/`. |
| `sageattention_version` | combo | `None`, `SageAttention 2`, `SageAttention 3`. |
| `flashattention_version` | combo | `None`, `FlashAttention 2`, `FlashAttention 3`, `FlashAttention 4`. |

**Outputs:** `MODEL` · `CLIP` · `VAE`

> 💡 **Precision is auto‑detected** from the model files (bf16 / fp16 / etc.) — there's no weight‑type dropdown to fiddle with.

**Custom UI:** a themed node with a **🔄 Rescan** button and a live, color‑coded **Attention** status badge (🧠 Sage = green, ⚡ Flash = blue, both = pink). The native combo widgets are mirrored into the panel, and the saved selection is the single source of truth — so the chosen model **persists correctly across reloads**.

---

### 🌀 Nougan Krea 2 · Uncensored

A single node that lays down the **uncensoring foundation** for Krea 2 by baking in three small LoRAs that travel *inside* the node pack. It slots into your graph exactly where you'd expect:

```
[ Diffusers / Checkpoint loader ]
        MODEL ──►
        CLIP  ──►│  Nougan Krea 2 · Uncensored   MODEL ──►  [ your LoRA loader ]
                 │     (toggle 1–3 loras)         CLIP  ──►│
                 └────────────────────────────────────────┘
```

**Inputs**

| Name | Type | Description |
|------|------|-------------|
| `model` | `MODEL` | The model to patch (required). |
| `clip` | `CLIP` | Optional — patch the text encoder too when connected. |
| `LoRA 1 / 2 / 3` (ON/OFF) | bool | Preload that bundled LoRA into the model. |
| `LoRA 1 / 2 / 3` strength | float | Per‑LoRA strength. `0` = off. **No upper limit** — `1.0`, `3.0`, `12.5`, whatever you need. |

**Outputs:** `MODEL` · `CLIP` · `applied` (a short text summary of which LoRAs fired, e.g. `Uncensor A@1, Uncensor C@3`).

**Custom UI:** a themed magenta panel, one row per bundled LoRA:
- A clickable **ON/OFF pill** (the strength field greys out when OFF).
- A **presence dot** — 🟢 when the bundled file is found (hover it for the filename + size), 🔴 when it's missing.
- An **uncapped strength** field.

> 🎯 **Why a dedicated node instead of the regular LoRA loader?** The regular loader is a *general tool* ("which of my hundreds of LoRAs?"); this node is a *curated preset* ("give me the proven Krea 2 uncensor foundation, instantly, on any machine"). They're meant to be used **together** — Krea 2 lays the base, your regular loader handles styles/characters/concepts on top. See the [FAQ](#why-use-the-krea-2-node-over-the-regular-lora-loader).

---

### 🖼️ Nougan Get Image

Takes an `IMAGE` that already exists in your graph (from a generator, composite, paste node, etc.) and outputs the image plus a mask — mirroring the native **Load Image** node, but without touching the disk.

**Inputs**

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `image` | `IMAGE` | — | The image to grab from your workflow. |
| `mask_mode` | combo | `Alpha Channel` | `Alpha Channel` (from RGBA), `Luminance` (from brightness), or `Blank` (all‑black). |
| `invert_mask` | bool | `False` | Swap black ↔ white. |
| `mask_threshold` | float | `0.0` | Binarize the mask above this value. `0` = smooth. |

**Outputs:** `IMAGE` · `MASK`

**Mask convention** (matches native Load Image):
- `Alpha Channel` → transparent pixels become **white** (masked out), opaque pixels become **black** (kept).
- No alpha channel → a blank **black** mask (keep everything).

**Custom UI:** side‑by‑side live **Image** and **Mask** thumbnail previews rendered directly inside the node.

---

### 🎯 Nougan Text Encode + Zero Neg

A single ComfyUI node that replaces the classic **`CLIP Text Encode` → `Conditioning Zero Out`** two‑node chain. Feed it a `CLIP` and a positive prompt, and it hands you back **both** conditioning outputs at once — a properly encoded positive *and* a ready‑made negative — so your graph stays clean and you never have to wire up a separate zero‑out node again.

```
        ┌──────────────────────────────────────────┐
  CLIP ─┤  Nougan Text Encode + Zero Neg 🎯        │
        │                                          │
        │  ✍️ Positive Prompt                      │──► POSITIVE  (CONDITIONING)
        │  ┌────────────────────────────────────┐  │
        │  │ a cinematic portrait, golden hour… │  │
        │  └────────────────────────────────────┘  │
        │                                          │
        │  Negative Conditioning                   │
        │  ( ⊘ Zero Out )  ( ∅ Empty String )      │──► NEGATIVE  (CONDITIONING)
        │                                          │
        │  42 chars · 8 words            ● ready   │
        └──────────────────────────────────────────┘
```

| Output | Contents |
|---|---|
| **POSITIVE** | Your prompt text, tokenized and encoded through CLIP (`clip.tokenize` → `encode_from_tokens_scheduled`). |
| **NEGATIVE** | Generated automatically from the mode you pick — **Zero Out** or **Empty String** (below). |

Wire **POSITIVE** → sampler `positive`, **NEGATIVE** → sampler `negative`. Done.

> 🔗 **Plug a Text Box into `positive`** and the panel **greys out + locks**, shows a `🔗 FROM <source>` tag, and previews the incoming text live — so you can always see exactly which string the encoder will use. Unplug and it returns to an editable prompt.

#### The two negative modes — what they actually do

This is the part worth understanding, because the two options are **not** the same thing even though they both mean "no negative prompt."

##### ⊘ Zero Out *(default)*

Takes the positive conditioning and **replaces every value with `0`** — including the `pooled_output` (the global CLIP pooler embedding that SDXL / Flux‑family models carry alongside the token sequence). The tensor keeps the exact same *shape* as the positive (same token length, same hidden dimension); only the numbers become zero.

Mathematically this is a **true null vector** — a signal CLIP itself could never produce. It represents *absolute nothing*, so when classifier‑free guidance runs, the model is pushed maximally "away from the void" and toward your positive prompt.

```
positive embedding : [ 0.42, -1.10,  0.03,  2.71, … ]   ← rich, meaningful
zero‑out negative  : [ 0.00,  0.00,  0.00,  0.00, … ]   ← mathematical zero
```

**Best for:** modern **flow‑matching / rectified‑flow** models — **Flux, Krea 2, Ideogram 4**, and similar — especially when you run them with **CFG > 1**. This matches ComfyUI's built‑in `ConditioningZeroOut` exactly.

##### ∅ Empty String

Encodes the literal text `""` (an empty string) **through CLIP as a normal prompt**. This produces a **real, non‑zero embedding** — CLIP's learned representation of *"no text."* The tokenizer still emits start/end tokens, the transformer layers still run, and the pooler still outputs a genuine (small but non‑zero) vector.

```
positive embedding     : [ 0.42, -1.10,  0.03,  2.71, … ]   ← rich, meaningful
empty‑string negative  : [ 0.05,  0.11, -0.02,  0.09, … ]   ← CLIP's idea of "nothing"
```

That's the key distinction: **`CLIP("")` ≠ `0`**. An empty‑string embedding is *in‑distribution* for the text encoder; a zero vector is not.

**Best for:** models **trained with traditional CFG and blank negatives** — classic **SD 1.5 / SD 2.1 / SDXL** workflows where you'd normally just leave the negative box empty. Feeding those models a real empty‑text embedding keeps you inside the distribution they were trained on.

#### Side‑by‑side

| | **⊘ Zero Out** | **∅ Empty String** |
|---|---|---|
| What it is | Tensor of literal zeros | CLIP encoding of `""` |
| Values | All `0.0` | Small, real, non‑zero |
| `pooled_output` | Zeroed too | Real empty‑text pooler vector |
| In‑distribution for CLIP? | ❌ No (a null CLIP can't produce) | ✅ Yes |
| Ideal models | Flux, Krea 2, Ideogram 4, flow models | SD 1.5 / 2.1 / SDXL, classic CFG |
| Equivalent built‑in node | `ConditioningZeroOut` | `CLIP Text Encode` with `""` |

#### 💡 The CFG = 1 shortcut (why it often doesn't matter)

Classifier‑free guidance combines the two conditionings like this:

```
output = negative + CFG × (positive − negative)
```

Set **CFG = 1.0** and the math collapses:

```
output = negative + 1 × (positive − negative) = positive
```

The negative term **cancels out entirely**. So if you're running a flow model at **CFG 1.0** (the default for Flux / Krea 2 / Ideogram 4), the negative conditioning has **literally zero effect on the image** — the sampler still *requires* the input, but it never uses it. In that case either mode gives identical results; the node simply provides a valid placeholder so the pipeline doesn't error.

The moment you push **CFG above 1**, the negative starts mattering again — and that's when choosing the right mode (usually **Zero Out** for flow models) gives you a cleaner, stronger guidance signal.

#### Which one should I pick?

- **Flux / Krea 2 / Ideogram 4 / any flow‑matching model** → **⊘ Zero Out** (the default).
- **SD 1.5 / SDXL / traditionally‑trained models with a blank negative** → **∅ Empty String**.
- **Running at CFG 1.0?** → Either; it makes no difference. Leave it on Zero Out.
- **Unsure?** → Generate the same seed with both and compare. For most modern models you won't see a difference at CFG 1, and Zero Out is the safe default once you raise CFG.

#### The UI

- A **monospace prompt textarea** with live **character / word count**.
- **Pill‑button toggles** for the negative mode (no fiddly dropdown).
- A small **status dot** that pulses green on every change so you know your edit registered.
- Saved prompt text and mode **restore correctly** on workflow reload.

**Right‑click canvas → Add Node → conditioning → Nougan Text Encode + Zero Neg 🎯**

---

### 📝 Nougan Text Box

A clean, styled **plain‑text** node. You type into it, and it emits your text as a single `STRING` output you can plug into *any* string input — most commonly the **positive** prompt of a text encoder. Think of it as a reusable, save‑safe **prompt card** you can drop anywhere in your graph.

```
  ┌──────────────────────────────┐
  │ 📝  TEXT BOX                 │
  │ ┌──────────────────────────┐ │
  │ │ a cinematic portrait,    │ │
  │ │ golden hour, soft light… │ │
  │ └──────────────────────────┘ │
  │ 42 chars · 8 words · 2 lines │
  │                       ● ⧉   │   ← status · Copy · Clear
  └──────────────┬───────────────┘
            TEXT │  (STRING)  ──►  any STRING input (e.g. an encoder's positive)
```

**Inputs**

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `text` | STRING (multiline) | `""` | Anything you type; emitted verbatim on the `TEXT` output. |

**Outputs:** `TEXT` (`STRING`)

**Custom UI:** an amber note‑card with a resizable monospace editor, live **char / word / line counts**, a **⧉ Copy** button (with a `✓ Copied` confirmation), a **✕ Clear** button, and a status dot that pulses gold on every edit.

> 💡 **Why a separate Text Box?** It *decouples the words from the encoding*: wire **one** Text Box into **several** encoders and edit the prompt once; A/B‑swap prompts by rewiring a single link; rename the node to label your prompt blocks; and **⧉ Copy** grabs exactly what you typed for pasting into a prompt library. The text is the source of truth, so it **saves, restores, and smart‑caches** correctly (it only re‑runs when the text actually changes).

**Right‑click canvas → Add Node → utils → Nou
