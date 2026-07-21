<div align="center">

# 🌀 Winnougan (Nougan's Nodes)
<img width="1536" height="1024" alt="f8ba2080-1d9e-4188-afc5-02e01f898dfd" src="https://github.com/user-attachments/assets/7bc16746-2f0b-4ff7-8de5-d6e076bc3f6a" />

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
