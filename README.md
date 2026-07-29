<div align="center">

# 🌀 Winnougan (Nougan's Nodes)
<img width="1536" height="1024" alt="Nougan Nodes" src="https://github.com/user-attachments/assets/e292034a-5854-43a4-9141-705c170dfd3f" />

### Custom nodes for [ComfyUI](https://github.com/comfyanonymous/ComfyUI)

**Seventeen nodes across five families — loaders, LoRA tooling, masking, temporal video prompts, and a local LLM bridge — every one with its own themed, live UI.**

[![ComfyUI](https://img.shields.io/badge/ComfyUI-nodes-006064?style=for-the-badge)](https://github.com/comfyanonymous/ComfyUI)
[![Python](https://img.shields.io/badge/Python-3.10%2B-3776ab?style=for-the-badge&logo=python&logoColor=white)](https://www.python.org/)
[![Nodes](https://img.shields.io/badge/nodes-17-ff4081?style=for-the-badge)]#-node-index)
[![Docs](https://img.shields.io/badge/docs-per--node-69f0ae?style=for-the-badge)](docs/)
[![License](https://img.shields.io/badge/license-MIT-69f0ae?style=for-the-badge)](#-license)

</div>

---

## ✨ Overview

- 🚀 **Loaders** — a folder-aware [Diffusers Loader](docs/core-nodes.md) and the one-toggle [Krea 2 · Uncensored](docs/core-nodes.md) stage with three bundled LoRAs.
- 📁 **LoRA tooling** — a themed [LoRA stack editor](docs/core-nodes.md) with favourites, folder filters and a randomizer, plus the [Lora Inspector](docs/lora-inspector.md) that identifies any LoRA live from Civitai.
- 🎨 **Image & masks** — [Get Image](docs/core-nodes.md) for in-graph grabs, a full [Mask Editor](docs/core-nodes.md) and [Mask Composite](docs/core-nodes.md).
- 🎭 **Characters & video** — [Regional Character LoRA](docs/regional-character-lora.md) for two identities without blend, and [Prompt Relay](docs/prompt-relay.md) for per-segment prompts in LTX video.
- 🧠 **Local LLMs** — the [LM Studio Bridge](docs/lm-studio-bridge.md) streams chat, vision, audio and video through any model in LM Studio, with a live on-node console.

Every node ships a custom frontend UI. The pack also includes a global **Tab-cycler** quality-of-life extension that works on every node in your graph.

---

## 📦 Node index

| Node | What it does | Docs |
|---|---|---|
| **Nougan Diffusers Loader 🚀** | Loads a Diffusers folder/file → `MODEL · CLIP · VAE`, auto-precision, optional Sage/Flash attention | [core](docs/core-nodes.md) |
| **Nougan Krea 2 · Uncensored 🌀** | Bakes in 1–3 bundled uncensor LoRAs with per-LoRA toggle + uncapped strength | [core](docs/core-nodes.md) |
| **Nougan Get Image 🖼️** | Grabs an in-workflow image → `IMAGE + MASK`, live previews | [core](docs/core-nodes.md) |
| **Nougan Text Encode + Zero Neg 🎯** | Encodes positive **and** builds the negative (zero-out / empty-string) in one node | [core](docs/core-nodes.md) |
| **Nougan Text Box 📝** | Reusable prompt card emitting a `STRING`, with counts + copy/clear | [core](docs/core-nodes.md) |
| **Nougan Title Font 🌈** | Zoom-proof styled title banner with glow, animations, gradient presets, web link | [core](docs/core-nodes.md) |
| **Nougan Lora Loader 📁** | Themed LoRA stack editor: chooser, ☆ favourites, folder filter, 🎲 randomizer | [core](docs/core-nodes.md) |
| **Nougan Lora Loader (Multi) 📁** | Same editor, sharing one stack across up to 5 models | [core](docs/core-nodes.md) |
| **Nougan Lora Inspector 🔍** | Point at a LoRA → trigger words, base model, samples, stats, live from Civitai | [docs](docs/lora-inspector.md) |
| **Nougan Mask Editor 🎨** | Paint and edit masks on-node | [core](docs/core-nodes.md) |
| **Nougan Mask Composite 🎭** | Combine masks for edit-then-composite workflows | [core](docs/core-nodes.md) |
| **Nougan Regional Character LoRA 🎭** | Two character LoRAs, one image, each masked to its own region — no blend | [docs](docs/regional-character-lora.md) |
| **Nougan Prompt Relay Encode 🎬** | Per-segment temporal prompts for LTX · LTX2 · LTXAV | [docs](docs/prompt-relay.md) |
| **Nougan Prompt Relay Timeline 🎞️** | Same pipeline + a draggable WYSIWYG timeline editor | [docs](docs/prompt-relay.md) |
| **Nougan Prompt Relay Options ⚙️** | Per-stream epsilon / strength / window tuning | [docs](docs/prompt-relay.md) |
| **Nougan LM Studio 🧠** | Streaming LLM chat + vision + audio + video via LM Studio, live DOM console | [docs](docs/lm-studio-bridge.md) |
| **Nougan LM Studio Prompt Box 💬** | Live on-node reader/editor for LLM output | [docs](docs/lm-studio-bridge.md) |

---

## 🧭 Which node do I need?

| I want to… | Use |
|---|---|
| Load a Diffusers model folder | [Diffusers Loader 🚀](docs/core-nodes.md) |
| Uncensor Krea 2 in one toggle | [Krea 2 · Uncensored 🌀](docs/core-nodes.md) |
| Stack style/character LoRAs with favourites + a randomizer | [Lora Loader 📁](docs/core-nodes.md) |
| Find out what an unknown LoRA actually is | [Lora Inspector 🔍](docs/lora-inspector.md) |
| Encode positive + negative without the two-node dance | [Text Encode + Zero Neg 🎯](docs/core-nodes.md) |
| Put two characters in one image without identity blend | [Regional Character LoRA 🎭](docs/regional-character-lora.md) |
| Give different video segments different prompts | [Prompt Relay 🎬](docs/prompt-relay.md) |
| Chat with / analyze images via a local LLM | [LM Studio Bridge 🧠](docs/lm-studio-bridge.md) |

---

## ⚡ Install

```bash
cd ComfyUI/custom_nodes
git clone <your-repo-url>
# restart ComfyUI
```

Each family announces itself on boot — and each loads in its own `try/except`, so a problem in one can never take down the others:

```
[Nougan] ✅ Lora Inspector loaded.
[Nougan] ✅ Prompt Relay loaded (3 nodes).
[Nougan] ✅ LM Studio Bridge loaded (2 nodes).
```

Or install via **ComfyUI Manager** — search *Nougan*.

---

## 📚 Documentation

Every node family has its own page in [`docs/`](docs/):

| Page | Covers |
|---|---|
| [Core nodes](docs/core-nodes.md) | Diffusers Loader · Krea 2 · Get Image · Text Encode + Zero Neg · Text Box · Title Font · Lora Loaders · Mask Editor · Mask Composite |
| [Lora Inspector](docs/lora-inspector.md) | Civitai lookup, caching, HTTP endpoint |
| [Regional Character LoRA](docs/regional-character-lora.md) | Token-space masking, regions, recon tool |
| [Prompt Relay](docs/prompt-relay.md) | Timeline editor, epsilon tuning, technical deep dives |
| [LM Studio Bridge](docs/lm-studio-bridge.md) | Dev-server setup, vision/audio/video, Krea 2 prompt director |

---

## 📄 License

MIT — take it, ship it, remix it.
[![Nodes](https://img.shields.io/badge/nodes-17-ff4081?style=for-the-badge)](#node-index)
[![Docs](https://img.shields.io/badge/docs-per--node-69f0ae?style=for-the-badge)](docs/)
[![License](https://img.shields.io/badge/license-MIT-69f0ae?style=for-the-badge)](#license)

---

<div align="center">

**Nougan's Nodes** · if something here saves you a render, ⭐ the repo.

</div>
