<div align="center">

# 🌀 Winnougan (Nougan's Nodes)
<img width="1536" height="1024" alt="c9feac02-8d77-46da-81cb-26230211a3e9" src="https://github.com/user-attachments/assets/99c620fe-598c-4ae3-9bf9-29eb585f748a" />

### Custom nodes for [ComfyUI](https://github.com/comfyanonymous/ComfyUI)

**An intuitive Diffusers loader, a workflow‑native image/mask grabber, and a one‑toggle Krea 2 uncensor stage with bundled LoRAs.**

[![ComfyUI](https://img.shields.io/badge/ComfyUI-nodes-006064?style=for-the-badge)](https://github.com/comfyanonymous/ComfyUI)
[![Python](https://img.shields.io/badge/Python-3.10%2B-3776ab?style=for-the-badge&logo=python&logoColor=white)](https://www.python.org/)
[![Nodes](https://img.shields.io/badge/nodes-3-ff4081?style=for-the-badge)](#-nodes)
[![License](https://img.shields.io/badge/license-MIT-69f0ae?style=for-the-badge)](#-license)

</div>

---

## ✨ Overview

**Nougan** is a small, focused collection of ComfyUI nodes built for clean workflows and fast iteration:

- 🚀 **Nougan Diffusers Loader** — drop in a Diffusers model *folder* (or single file) and get `MODEL`, `CLIP`, and `VAE` out automatically. Precision is auto‑detected from the files (no weight‑type dropdown). Optionally patch in **SageAttention 2/3** or **FlashAttention 2/3/4** for faster inference.
- 🖼️ **Nougan Get Image** — grab an image that's *already in your workflow* (no loading from disk) and split it into `IMAGE` + `MASK`, exactly like the native Load Image node. Includes live in‑node previews.
- 🌀 **Nougan Krea 2 · Uncensored** — a single pipeline stage that **bakes in three bundled uncensored LoRAs**. Toggle 1, 2, or all 3 and set each strength (uncapped). Sits *after* the model and *before* your regular LoRA loader. The LoRAs ship inside the pack, so the workflow is fully portable.

All three nodes ship with a custom, themed frontend UI.

---

## 📦 Nodes

| Node | Category | Outputs | Description |
|------|----------|---------|-------------|
| **Nougan Diffusers Loader 🚀** | `loaders` | `MODEL`, `CLIP`, `VAE` | Intuitively loads a Diffusers model folder or file; optional attention patching. |
| **Nougan Get Image 🖼️** | `image` | `IMAGE`, `MASK` | Grabs an in‑workflow image and extracts a mask, with live previews. |
| **Nougan Krea 2 · Uncensored 🌀** | `loaders` | `MODEL`, `CLIP`, `applied` | Bakes in 1–3 bundled uncensored LoRAs with per‑LoRA ON/OFF + uncapped strength. |

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

**Custom UI:** a themed node with a **🔄 Refresh Model List** button and a live, color‑coded **Attention** status badge (🧠 Sage = green, ⚡ Flash = blue, 🚀 both = pink).

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

---

## The two negative modes — what they actually do

This is the part worth understanding, because the two options are **not** the same thing even though they both mean "no negative prompt."

### ⊘ Zero Out *(default)*

Takes the positive conditioning and **replaces every value with `0`** — including the `pooled_output` (the global CLIP pooler embedding that SDXL / Flux‑family models carry alongside the token sequence). The tensor keeps the exact same *shape* as the positive (same token length, same hidden dimension); only the numbers become zero.

Mathematically this is a **true null vector** — a signal CLIP itself could never produce. It represents *absolute nothing*, so when classifier‑free guidance runs, the model is pushed maximally "away from the void" and toward your positive prompt.

```
positive embedding : [ 0.42, -1.10,  0.03,  2.71, … ]   ← rich, meaningful
zero‑out negative  : [ 0.00,  0.00,  0.00,  0.00, … ]   ← mathematical zero
```

**Best for:** modern **flow‑matching / rectified‑flow** models — **Flux, Krea 2, Ideogram 4**, and similar — especially when you run them with **CFG > 1**. This matches ComfyUI's built‑in `ConditioningZeroOut` exactly.

### ∅ Empty String

Encodes the literal text `""` (an empty string) **through CLIP as a normal prompt**. This produces a **real, non‑zero embedding** — CLIP's learned representation of *"no text."* The tokenizer still emits start/end tokens, the transformer layers still run, and the pooler still outputs a genuine (small but non‑zero) vector.

```
positive embedding     : [ 0.42, -1.10,  0.03,  2.71, … ]   ← rich, meaningful
empty‑string negative  : [ 0.05,  0.11, -0.02,  0.09, … ]   ← CLIP's idea of "nothing"
```

That's the key distinction: **`CLIP("")` ≠ `0`**. An empty‑string embedding is *in‑distribution* for the text encoder; a zero vector is not.

**Best for:** models **trained with traditional CFG and blank negatives** — classic **SD 1.5 / SD 2.1 / SDXL** workflows where you'd normally just leave the negative box empty. Feeding those models a real empty‑text embedding keeps you inside the distribution they were trained on.

---

## Side‑by‑side

| | **⊘ Zero Out** | **∅ Empty String** |
|---|---|---|
| What it is | Tensor of literal zeros | CLIP encoding of `""` |
| Values | All `0.0` | Small, real, non‑zero |
| `pooled_output` | Zeroed too | Real empty‑text pooler vector |
| In‑distribution for CLIP? | ❌ No (a null CLIP can't produce) | ✅ Yes |
| Ideal models | Flux, Krea 2, Ideogram 4, flow models | SD 1.5 / 2.1 / SDXL, classic CFG |
| Equivalent built‑in node | `ConditioningZeroOut` | `CLIP Text Encode` with `""` |

---

## 💡 The CFG = 1 shortcut (why it often doesn't matter)

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

---

## Which one should I pick?

- **Flux / Krea 2 / Ideogram 4 / any flow‑matching model** → **⊘ Zero Out** (the default).
- **SD 1.5 / SDXL / traditionally‑trained models with a blank negative** → **∅ Empty String**.
- **Running at CFG 1.0?** → Either; it makes no difference. Leave it on Zero Out.
- **Unsure?** → Generate the same seed with both and compare. For most modern models you won't see a difference at CFG 1, and Zero Out is the safe default once you raise CFG.

---

## The UI

The node ships with a styled front‑end panel:

- A **monospace prompt textarea** with live **character / word count**.
- **Pill‑button toggles** for the negative mode (no fiddly dropdown).
- A small **status dot** that pulses green on every change so you know your edit registered.
- Saved prompt text and mode **restore correctly** on workflow reload.

---

## Install

Drop the package into `ComfyUI/custom_nodes/Nougan/`, restart ComfyUI, hard‑refresh the browser, then:

**Right‑click canvas → Add Node → conditioning → Nougan Text Encode + Zero Neg 🎯**

---

*Part of the **Nougan** node suite — Diffusers Loader 🚀 · Krea 2 Loader 🌀 · Get Image 🖼️ · Text Encode + Zero Neg 🎯*

## 📥 Bundled LoRAs — copy & rename your 3 favorites

The Krea 2 node reads its LoRAs from its **own** folder — `nougan/loras/` — **not** from the global `ComfyUI/models/loras/`. That's what makes the workflow portable. To use your own three uncensored LoRAs, just copy them in and rename them to the three names the node expects.

Grab an uncensored LoRA like this one and rename it accordingly: https://civitai.com/models/2775340/krea2-textfusion-refusal-reduction-lora

### The three target names

| Slot | Rename your file to (exact) |
|------|------------------------------|
| LoRA 1 | `krea2_uncensor_a.safetensors` |
| LoRA 2 | `krea2_uncensor_b.safetensors` |
| LoRA 3 | `krea2_uncensor_c.safetensors` |

### Step by step

1. **Find your three favorite uncensored LoRAs** wherever you keep them (Downloads, `models/loras/`, a CivitAI folder, etc.).
2. **Copy** them (don't move — keep your originals safe).
3. **Rename** the copies to the three names above — `a`, `b`, `c` in the order you want them to appear as LoRA 1, 2, 3 in the node.
4. **Paste** the renamed copies into:
   ```
   ComfyUI/custom_nodes/nougan/loras/
   ```
   (Create the `loras/` folder if it isn't there yet.)
5. **Refresh** the browser (`Ctrl + Shift + R`) or delete & re‑add the node. No ComfyUI restart needed — the node checks the folder live.
6. Open the node: each row's dot should now be **🟢**. Hover a dot to confirm the filename + size (e.g. `22.0 MB`). Toggle the ones you want and dial the strengths.

> ⚠️ **Spelling trap:** the extension is **`safetensors`** (safe‑**tensors**, with the *e*), not `saftensors`. A one‑letter typo means the file won't be found and that row stays 🔴.

> 💡 **Don't want to rename?** You don't have to. Open `krea2_loader.py` and set each `filename` to your file's *actual* name (and `display_name` to whatever label you want in the UI). The node reads the name from that list, so any filename works — renaming is just the zero‑code shortcut.

Because these LoRAs are tiny (a few KB up to ~22 MB), bundling them costs almost nothing — and sharing your workflow + the `nougan` folder shares the LoRAs too, with nothing to re‑download.

---

## 🚀 Installation

### Option 1 — Git clone (recommended)

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/YOUR_USERNAME/nougan.git
```

Then restart ComfyUI and (for the Krea 2 node) drop your three LoRAs into `nougan/loras/` as described above.

### Option 2 — ComfyUI Manager

Search for **"Nougan"** in the ComfyUI‑Manager custom node list and click **Install**. *(Available once the repo is registered.)*

### Option 3 — Manual

Download the repo and place the `nougan` folder inside `ComfyUI/custom_nodes/`.

---

## 🧠 Optional: Attention Acceleration

The Diffusers Loader can patch in faster attention kernels. These are **optional** — the node works fine without them and logs a warning if a selected library isn't installed.

**SageAttention (2 / 3):**
```bash
pip install sageattention
```

**FlashAttention (2 / 3 / 4):**
```bash
pip install flash-attn --no-build-isolation
```

> ⚠️ **Windows note:** `flash-attn` compiles against CUDA and can be hard to build on Windows. If you hit build errors, use a prebuilt wheel matching your Python/CUDA/torch versions, or stick with **SageAttention**.

Install these into the **same Python environment** you run ComfyUI with.

---

## 📁 Project Structure

```
nougan/
├── __init__.py                  # Node registration + WEB_DIRECTORY + status route
├── diffusers_loader.py          # Nougan Diffusers Loader
├── get_image.py                 # Nougan Get Image
├── krea2_loader.py              # Nougan Krea 2 · Uncensored  (edit KREA2_LORAS here)
├── loras/                       # ← drop your 3 bundled Krea 2 LoRAs here
│     ├── krea2_uncensor_a.safetensors
│     ├── krea2_uncensor_b.safetensors
│     └── krea2_uncensor_c.safetensors
├── README.md
└── web/
    ├── nougan-diffusers-ui.js   # Diffusers Loader frontend
    ├── nougan-get-image-ui.js   # Get Image frontend
    └── nougan-krea2-ui.js       # Krea 2 frontend
```

---

## 🛠️ Troubleshooting / FAQ

**The custom UI isn't showing / looks like the default node.**
The frontend is served from `web/` via `WEB_DIRECTORY = "./web"` in `__init__.py`. Make sure that line is present, then **restart ComfyUI** and **hard‑refresh** the browser (`Ctrl + Shift + R` / `Cmd + Shift + R`). Browsers aggressively cache ComfyUI's JS.

**I see duplicate image/mask previews on the Get Image node.**
Make sure you're on the latest version. The node sends its previews under a custom key (`nougan_previews`) specifically to avoid triggering ComfyUI's built‑in `"images"` auto‑preview.

**The Diffusers Loader model list is empty or missing a model I just added.**
Click the **🔄 Refresh Model List** button on the node, or restart ComfyUI. Models are scanned from `diffusion_models/`, `unet/`, and `diffusers/`.

**A Krea 2 LoRA row shows a 🔴 dot.**
The bundled file wasn't found in `nougan/loras/`. Check that (1) the file is actually in `nougan/loras/` (not `models/loras/`), (2) the name matches exactly — including the `a`/`b`/`c` suffix and the **`safetensors`** extension (not `saftensors`), and (3) the name matches the `filename` entry in `krea2_loader.py` if you didn't use the default names. Hover the dot to see exactly which file it's looking for. The node still runs — it just skips any enabled LoRA whose file is missing and prints a `⚠️` in the console.

**I added/renamed Krea 2 LoRA files but the dots didn't update.**
The node checks the folder live, so you don't need to restart ComfyUI — just **hard‑refresh** the browser or delete & re‑add the node.

**"sageattention / flash‑attn not installed" warning in the console.**
Install the relevant library into your ComfyUI Python environment (see [Optional: Attention Acceleration](#-optional-attention-acceleration)), or set that dropdown back to `None`.

### Why use the Krea 2 node over the regular LoRA loader?

You don't replace the regular loader — you use both. The regular loader is a *general tool* for arbitrary/dynamic stacks, randomizers, folder filters, and XY sweeps. The Krea 2 node is a *curated, portable preset*: the three proven uncensor LoRAs are bundled inside the pack, pre‑wired with sane defaults, and travel with the workflow so it works on any machine with zero setup. In practice the Krea 2 node lays the uncensor **foundation** (after the model), and your regular loader stacks styles/characters/concepts **on top** (after Krea 2). Baking in is essentially free here because the LoRAs are tiny (KB–MB scale).

---

## 📄 License

Released under the [MIT License](LICENSE).

---

<div align="center">

**Made with 🌀 by Nougan**

*If these nodes save you time, consider starring the repo ⭐*

</div>
