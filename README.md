<div align="center">

# 🌀 Winnougan (Nougan's Nodes)
<img width="1536" height="1024" alt="Nougan_nodes" src="https://github.com/user-attachments/assets/76276d28-bc06-40ec-94dc-831164ffc96a" />


### Custom nodes for [ComfyUI](https://github.com/comfyanonymous/ComfyUI)

**An intuitive Diffusers model loader with attention acceleration, and a workflow-native image/mask grabber.**

[![ComfyUI](https://img.shields.io/badge/ComfyUI-nodes-006064?style=for-the-badge)](https://github.com/comfyanonymous/ComfyUI)
[![Python](https://img.shields.io/badge/Python-3.10%2B-3776ab?style=for-the-badge&logo=python&logoColor=white)](https://www.python.org/)
[![Nodes](https://img.shields.io/badge/nodes-2-ff4081?style=for-the-badge)](#-nodes)
[![License](https://img.shields.io/badge/license-MIT-69f0ae?style=for-the-badge)](#-license)

</div>

---

## ✨ Overview

**Nougan** is a small, focused collection of ComfyUI nodes built for clean workflows and fast iteration:

- 🚀 **Nougan Diffusers Loader** — drop in a Diffusers model *folder* (or single file) and get `MODEL`, `CLIP`, and `VAE` out automatically. No manual weight-type selection — precision is auto-detected from the files, just like the native loader. Optionally patch in **SageAttention 2/3** or **FlashAttention 2/3/4** for faster inference.
- 🖼️ **Nougan Get Image** — grab an image that's *already in your workflow* (no loading from disk) and split it into `IMAGE` + `MASK`, exactly like the native Load Image node. Includes live in-node previews.

Both nodes ship with a custom, themed frontend UI.

---

## 📦 Nodes

| Node | Category | Outputs | Description |
|------|----------|---------|-------------|
| **Nougan Diffusers Loader 🚀** | `loaders` | `MODEL`, `CLIP`, `VAE` | Intuitively loads a Diffusers model folder or file and optionally patches attention. |
| **Nougan Get Image 🖼️** | `image` | `IMAGE`, `MASK` | Grabs an in-workflow image and extracts a mask, with live previews. |

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

> 💡 **Precision is auto-detected** from the model files (bf16 / fp16 / etc.) — there's no weight-type dropdown to fiddle with.

**Custom UI:** a themed node with a **🔄 Refresh Model List** button and a live, color-coded **Attention** status badge (🧠 Sage = green, ⚡ Flash = blue, 🚀 both = pink).

---

### 🖼️ Nougan Get Image

Takes an `IMAGE` that already exists in your graph (from a generator, composite, paste node, etc.) and outputs the image plus a mask — mirroring the native **Load Image** node, but without touching the disk.

**Inputs**

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `image` | `IMAGE` | — | The image to grab from your workflow. |
| `mask_mode` | combo | `Alpha Channel` | `Alpha Channel` (from RGBA), `Luminance` (from brightness), or `Blank` (all-black). |
| `invert_mask` | bool | `False` | Swap black ↔ white. |
| `mask_threshold` | float | `0.0` | Binarize the mask above this value. `0` = smooth. |

**Outputs:** `IMAGE` · `MASK`

**Mask convention** (matches native Load Image):
- `Alpha Channel` → transparent pixels become **white** (masked out), opaque pixels become **black** (kept).
- No alpha channel → a blank **black** mask (keep everything).

**Custom UI:** side-by-side live **Image** and **Mask** thumbnail previews rendered directly inside the node.

---

## 🚀 Installation

### Option 1 — Git clone (recommended)

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/YOUR_USERNAME/nougan.git
```

Then restart ComfyUI.

### Option 2 — ComfyUI Manager

Search for **"Nougan"** in the ComfyUI-Manager custom node list and click **Install**. *(Available once the repo is registered.)*

### Option 3 — Manual

Download the repo and place the `nougan` folder inside `ComfyUI/custom_nodes/`.

---

## 🧠 Optional: Attention Acceleration

The Diffusers Loader can patch in faster attention kernels. These are **optional** — the node works fine without them, and will simply log a warning if a selected library isn't installed.

**SageAttention (2 / 3):**
```bash
pip install sageattention
```

**FlashAttention (2 / 3 / 4):**
```bash
pip install flash-attn --no-build-isolation
```

> ⚠️ **Windows note:** `flash-attn` compiles against CUDA and can be difficult to build on Windows. If you hit build errors, either use a prebuilt wheel matching your Python/CUDA/torch versions, or stick with **SageAttention**, which is generally easier to install.

Install these into the **same Python environment** you use to run ComfyUI.

---

## 📁 Project Structure

```
nougan/
├── __init__.py                  # Node registration + WEB_DIRECTORY
├── diffusers_loader.py          # Nougan Diffusers Loader
├── get_image.py                 # Nougan Get Image
├── README.md
└── web/
    ├── nougan-diffusers-ui.js   # Diffusers Loader frontend
    └── nougan-get-image-ui.js   # Get Image frontend
```

---

## 🛠️ Troubleshooting / FAQ

**The custom UI isn't showing / looks like the default node.**
The frontend is served from the `web/` folder via the `WEB_DIRECTORY = "./web"` variable in `__init__.py`. Make sure that line is present, then **restart ComfyUI** and **hard-refresh** your browser (`Ctrl + Shift + R` / `Cmd + Shift + R`). Browsers aggressively cache ComfyUI's JS.

**I see duplicate image/mask previews on the Get Image node.**
Make sure you're on the latest version. The node sends its previews under a custom key (`nougan_previews`) specifically to avoid triggering ComfyUI's built-in `"images"` auto-preview.

**The model list is empty or missing a model I just added.**
Click the **🔄 Refresh Model List** button on the Diffusers Loader node, or restart ComfyUI. Models are scanned from the `diffusion_models/`, `unet/`, and `diffusers/` folders.

**"sageattention / flash-attn not installed" warning in the console.**
Install the relevant library into your ComfyUI Python environment (see [Optional: Attention Acceleration](#-optional-attention-acceleration)), or set that dropdown back to `None`.

---

## 📄 License

Released under the [MIT License](LICENSE).

---

<div align="center">

**Made with 🌀 by Nougan**

*If these nodes save you time, consider starring the repo ⭐*

</div>
