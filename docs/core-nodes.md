> 🌀 **Nougan Suite** · [← Back to overview](../README.md) · [All docs](./)

# 🧰 Nougan Core Nodes

The founding family of the suite — loaders, conditioning, utilities and masking. Every node ships with a themed, live custom UI.

| Node | Category | Outputs |
|------|----------|---------|
| **Diffusers Loader 🚀** | `loaders` | `MODEL`, `CLIP`, `VAE` |
| **Krea 2 · Uncensored 🌀** | `loaders` | `MODEL`, `CLIP`, `applied` |
| **Get Image 🖼️** | `image` | `IMAGE`, `MASK` |
| **Text Encode + Zero Neg 🎯** | `conditioning` | `POSITIVE`, `NEGATIVE` |
| **Text Box 📝** | `utils` | `TEXT` |
| **Title Font 🌈** | `utils` | `TEXT` |
| **Lora Loader 📁** | `loaders` | `MODEL`, `CLIP`, `lora_stack` |
| **Lora Loader (Multi‑Model) 📁** | `loaders` | `MODEL`, `CLIP`, `lora_stack`, `MODEL 2–5` |
| **Mask Editor 🎨** | `mask` | `MASK` |
| **Mask Composite 🎭** | `mask` | `MASK` |

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

```text
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

> 🎯 **Why a dedicated node instead of the regular LoRA loader?** The regular loader is a *general tool* ("which of my hundreds of LoRAs?"); this node is a *curated preset* ("give me the proven Krea 2 uncensor foundation, instantly, on any machine"). They're meant to be used **together** — Krea 2 lays the base, your regular loader handles styles/characters/concepts on top.

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

```text
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

```text
positive embedding : [ 0.42, -1.10,  0.03,  2.71, … ]   ← rich, meaningful
zero‑out negative  : [ 0.00,  0.00,  0.00,  0.00, … ]   ← mathematical zero
```

**Best for:** modern **flow‑matching / rectified‑flow** models — **Flux, Krea 2, Ideogram 4**, and similar — especially when you run them with **CFG > 1**. This matches ComfyUI's built‑in `ConditioningZeroOut` exactly.

##### ∅ Empty String

Encodes the literal text `""` (an empty string) **through CLIP as a normal prompt**. This produces a **real, non‑zero embedding** — CLIP's learned representation of *"no text."* The tokenizer still emits start/end tokens, the transformer layers still run, and the pooler still outputs a genuine (small but non‑zero) vector.

```text
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

```text
output = negative + CFG × (positive − negative)
```

Set **CFG = 1.0** and the math collapses:

```text
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

```text
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

**Right‑click canvas → Add Node → utils → Nougan Text Box 📝**

---

### 🌈 Nougan Title Font

A bold, colorful, fully‑styled **banner / title** node for labeling workflows, building cards, or signing outputs.

**Outputs:** `TEXT` (`STRING`)

**Styling kit:**
- **6 styles** · **glow** · **6 animations**
- **Color pickers** + **gradient presets**
- Optional **clickable web link** baked into the banner

**Custom UI:** a live preview panel — and the banner is a true **billboard**: it renders at a **constant on‑screen size no matter how far you zoom** the canvas, so titles stay readable in both bird's‑eye and close‑up views.

**Right‑click canvas → Add Node → utils → Nougan Title Font 🌈**

---

### 📁 Nougan Lora Loader

A themed LoRA **stack editor** — build a multi‑LoRA stack visually instead of chaining loader nodes.

**Outputs:** `MODEL` · `CLIP` · `LORA_STACK` (chains with the rest of the ecosystem).

**Custom UI:**
- A custom **chooser** with live search + **☆ favourites**
- A **folder filter** to slice your LoRA library
- A 🎲 **randomizer** with per‑line **roll / lock / auto‑roll**

#### Multi‑Model variant

**Nougan Lora Loader (Multi‑Model)** is the same editor applied to **up to 5 models at once** — one shared stack, five patched outputs (`MODEL`, plus `MODEL 2–5`). Ideal for A/B renders or parallel pipelines that must stay in lockstep.

**Right‑click canvas → Add Node → loaders → Nougan Lora Loader 📁**

---

### 🎨 Nougan Mask Editor

Paint and edit masks directly on the node — no external masking nodes required. Pairs naturally with **Get Image** (grab → edit) and **Mask Composite** (edit → combine).

**Outputs:** `MASK`

**Right‑click canvas → Add Node → mask → Nougan Mask Editor 🎨**

---

### 🎭 Nougan Mask Composite

Combines masks for **edit‑then‑composite** workflows — e.g. masking a Flux 2 edit to a painted region, then merging it back with the surrounding frame.

**Inputs:** mask operands (see node tooltips) · **Outputs:** `MASK`

**Right‑click canvas → Add Node → mask → Nougan Mask Composite 🎭**

---

> 🌀 **Nougan Suite** · [← Back to overview](../README.md) · [Lora Inspector](lora-inspector.md) · [Regional LoRA](regional-character-lora.md) · [Prompt Relay](prompt-relay.md) · [LM Studio Bridge](lm-studio-bridge.md)
