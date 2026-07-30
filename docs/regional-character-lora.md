> 🌀 **Nougan Suite** · [← Back to overview](../README.md) · [All docs](./)

# Nougan Regional Character LoRA 🎭
<img width="1536" height="1024" alt="Regional_Prompter" src="https://github.com/user-attachments/assets/966c9b41-b1b1-4f8e-a78b-3e73d64c865a" />

> Place two trained character LoRAs into **one** coherent image, each concentrated
> in its own spatial region, **without identity blend** — no compositing, no
> inpainting, no post-processing. The base model still generates a single image
> with full attention across the whole token sequence; this node only injects each
> character LoRA's *activation delta* into the image tokens that fall inside that
> character's region.

---

## Table of Contents

1. [What It Does (30-second version)](#1-what-it-does-30-second-version)
2. [Why Not Just Stack Two LoRAs?](#2-why-not-just-stack-two-loras)
3. [How It Works — The Big Picture](#3-how-it-works--the-big-picture)
4. [The Forward-Time Injection (the key mechanism)](#4-the-forward-time-injection-the-key-mechanism)
5. [Regions — How the Model Knows "Where"](#5-regions--how-the-model-knows-where)
6. [Inputs & Outputs](#6-inputs--outputs)
7. [Wiring Guide (with a real Flux 2 workflow)](#7-wiring-guide-with-a-real-flux-2-workflow)
8. [Token-Space Mechanics (deeper dive)](#8-token-space-mechanics-deeper-dive)
9. [Krea 2 / Flux 2 Architecture Notes](#9-krea-2--flux-2-architecture-notes)
10. [Debugging — "It Sometimes Makes Mistakes"](#10-debugging--it-sometimes-makes-mistakes)
11. [The Recon Tool](#11-the-recon-tool)
12. [FAQ / Troubleshooting](#12-faq--troubleshooting)

---

## 1. What It Does (30-second version)

You have two character LoRAs (say, **Character A** and **Character B**). You want
both characters in the same image — A on the left, B on the right — each looking
like *themselves*, not a blend of both.

This node makes that happen by **masking each LoRA's influence to a spatial
region** of the image, at the level of individual attention tokens, during the
model's forward pass. The model still "sees" the whole image with full attention;
only the *LoRA deltas* are region-gated.

```text
┌─────────────────────────────────────────────────┐
│              GENERATED IMAGE                     │
│                                                  │
│   ┌──────────────┐    ┌──────────────┐          │
│   │  REGION A    │    │  REGION B    │          │
│   │  (LoRA A     │    │  (LoRA B     │          │
│   │   active)    │    │   active)    │          │
│   │              │    │              │          │
│   │  Character A │    │  Character B │          │
│   │  appears here│    │  appears here│          │
│   └──────────────┘    └──────────────┘          │
│                                                  │
│   ← LoRA A's delta    LoRA B's delta →          │
│     only reaches        only reaches             │
│     these tokens        these tokens             │
└─────────────────────────────────────────────────┘
```

---

## 2. Why Not Just Stack Two LoRAs?

A normal LoRA load **merges** a low-rank weight delta into the model **globally**:

```text
W_effective = W_base + strength × (up @ down)
```

Every pixel carries **both** identities → **blend**. Character A gets B's features
and vice versa. The more LoRAs you stack, the more they interfere.

This node **never merges**. The deltas are added at forward time and **masked to a
token region**, so identity A only reaches region A's tokens:

```text
                    ┌─────────────────────────────────────┐
  NORMAL STACK:     │  W' = W + ΔA + ΔB   (everywhere)    │  → BLEND
                    └─────────────────────────────────────┘

                    ┌─────────────────────────────────────┐
  THIS NODE:        │  tokens in A:  out += mask_A × ΔA   │  → CLEAN
                    │  tokens in B:  out += mask_B × ΔB   │  → CLEAN
                    │  (ΔA and ΔB never touch each other) │
                    └─────────────────────────────────────┘
```

---

## 3. How It Works — The Big Picture

```text
                         ┌──────────────────┐
                         │   UNETLoader /   │
                         │   Diffusers      │
                         │   Loader         │
                         └────────┬─────────┘
                                  │ MODEL
                                  ▼
                    ┌─────────────────────────────┐
                    │  Nougan Krea 2 · Uncensored │  ← optional base LoRAs
                    └─────────────┬───────────────┘
                                  │ MODEL
                                  ▼
                    ┌─────────────────────────────┐
                    │  Your LoRA Loader           │  ← style / global LoRAs
                    │  (Fantastic / native)       │
                    └─────────────┬───────────────┘
                                  │ MODEL
                                  ▼
              ┌───────────────────────────────────────┐
              │                                       │
              │   NOUGAN REGIONAL CHARACTER LORA 🎭   │  ← THIS NODE
              │                                       │
              │   lora_a ──► Region A tokens          │
              │   lora_b ──► Region B tokens          │
              │   regions ──► visual editor (manual)  │
              │                                       │
              └───────────────────┬───────────────────┘
                                  │ MODEL (patched)
                                  ▼
                    ┌─────────────────────────────┐
                    │  BasicGuider / KSampler     │
                    └─────────────┬───────────────┘
                                  │
                                  ▼
                    ┌─────────────────────────────┐
                    │  VAEDecode → SaveImage      │
                    └─────────────────────────────┘
```

The node sits **after** your model loaders and global LoRAs, and **before** the
sampler. It returns a patched `MODEL` — the base weights are untouched; the
regional deltas are applied via forward hooks at inference time.

---

## 4. The Forward-Time Injection (the key mechanism)

This is the part worth understanding, because it's what makes regional LoRA
possible without compositing.

### Step by step

```text
 1. LOAD PHASE (once, when the node runs)
 ─────────────────────────────────────────
    lora_a.safetensors ──► { module_sig: {down, up, scale} }
    lora_b.safetensors ──► { module_sig: {down, up, scale} }

    Match each LoRA's target modules to the live model's Linear layers
    by normalised name (collapses _ vs ., strips prefixes).

    Result: layer_map = {
      "blocks.0.attn.wq": (module, {a: {...}, b: {...}}),
      "blocks.0.attn.wk": (module, {a: {...}, b: {...}}),
      ...
    }


 2. PREPARE PHASE (once, on first forward call)
 ──────────────────────────────────────────────
    Read the latent shape → compute token grid (rows × cols)
    Build mask_A and mask_B over the token grid
    Move LoRA matrices + masks to GPU in compute dtype (bf16/fp32)


 3. FORWARD PHASE (every diffusion step, every layer)
 ────────────────────────────────────────────────────
    For each matched Linear layer, a forward hook fires:

    ┌─────────────────────────────────────────────────────────┐
    │  hook(module, input, output):                           │
    │                                                         │
    │    x = input[0]              # [batch, seq, dim]        │
    │                                                         │
    │    # LoRA A's delta, masked to region A                 │
    │    Δa = (x @ down_aᵀ) @ up_aᵀ                          │
    │    res = mask_A × Δa         # zero outside region A    │
    │                                                         │
    │    # LoRA B's delta, masked to region B                 │
    │    Δb = (x @ down_bᵀ) @ up_bᵀ                          │
    │    res += mask_B × Δb        # zero outside region B    │
    │                                                         │
    │    return output + res       # add to layer output      │
    └─────────────────────────────────────────────────────────┘

    The base model's own weights are NEVER modified.
    The hooks are registered before each forward call and
    removed immediately after — no leakage between steps.
```

### Why this avoids blend

```text
  Token in Region A:     mask_A = 1.0,  mask_B = 0.0
                         → gets Δa only → Character A's identity

  Token in Region B:     mask_A = 0.0,  mask_B = 1.0
                         → gets Δb only → Character B's identity

  Token on the seam:     mask_A = 0.6,  mask_B = 0.4  (feathered)
                         → gets a soft mix → smooth transition

  Text tokens:           mask_A = 0.0,  mask_B = 0.0
                         → no LoRA delta → prompt conditioning unchanged
```

---

## 5. Regions — How the Model Knows "Where"

### The token grid

The model doesn't work in pixels — it works in **tokens**. For Krea 2 / Flux 2:

```text
  Original image:  1248 × 832 pixels
                         │
                    VAE encode (÷8)
                         │
                         ▼
  Latent:           156 × 104
                         │
                    Patchify (÷2)
                         │
                         ▼
  Token grid:        78 × 52  =  4,056 image tokens
```

Each token corresponds to a 16×16 pixel patch of the original image. The region
masks are built on this token grid, not on pixels.

### Split modes

The node supports five ways to define regions:

| Mode | What it does | When to use |
|---|---|---|
| **`manual`** | You draw boxes in the on-node visual editor | Precise control over character placement |
| **`auto`** | Picks vertical (L/R) for portrait/square, horizontal (T/B) for landscape | Quick test, no fiddling |
| **`vertical_auto`** | Always splits left / right | Two characters side by side |
| **`horizontal_auto`** | Always splits top / bottom | Two characters stacked |
| **`bbox`** | Reads boxes from a KJ BoundingBox wire | Programmatic / animated placement |

### Visual: split modes

```text
  vertical_auto (L/R)          horizontal_auto (T/B)         manual (custom)
  ┌─────────┬─────────┐       ┌───────────────────┐          ┌───────────────────┐
  │         │         │       │                   │          │                   │
  │  A      │      B  │       │        A          │          │    ┌───┐          │
  │         │         │       │                   │          │    │ A │    ┌───┐ │
  │         │         │       ├───────────────────┤          │    └───┘    │ B │ │
  │         │         │       │                   │          │             └───┘ │
  │         │         │       │        B          │          │                   │
  └─────────┴─────────┘       │                   │          └───────────────────┘
   mask_A ←──→ mask_B         └───────────────────┘           boxes from editor
   (smooth ramp at seam)       mask_A ↑↓ mask_B
```

### The visual editor (manual mode)

When `split_mode = manual`, the node shows a canvas editor with two
draggable/resizable boxes:

- **Blue box** = Region A (lora_a)
- **Red box** = Region B (lora_b)
- Drag to move, drag the corner handle to resize
- Coordinates are normalised (0–1) and stored in the `regions` widget as JSON
- The editor is **cosmetic** — it shows your intent; the actual masking happens
  in token space at execution time

---

## 6. Inputs & Outputs

### Inputs

| Name | Type | Required | Description |
|---|---|---|---|
| `model` | `MODEL` | ✅ | The model to patch (after loaders / global LoRAs) |
| `lora_a` | combo | ✅ | Character A's LoRA file (from `models/loras/`) |
| `strength_a` | `FLOAT` | ✅ | LoRA A strength (`-4.0` to `4.0`, default `1.0`) |
| `lora_b` | combo | ✅ | Character B's LoRA file |
| `strength_b` | `FLOAT` | ✅ | LoRA B strength |
| `split_mode` | combo | ✅ | `manual` / `auto` / `vertical_auto` / `horizontal_auto` / `bbox` |
| `seam_feather` | `FLOAT` | ✅ | Softness of the region boundary (`0.0`–`0.3`, default `0.08`) |
| `blend_override` | `FLOAT` | ✅ | `0` = pure regional, `1` = both at 0.5 everywhere (controlled merge) |
| `compute_precision` | combo | ✅ | `bf16 (fast)` or `fp32 (precise)` |
| `regions` | `STRING` | optional | Managed by the visual editor (JSON of box coords) |
| `bboxes` | `BOUNDINGBOX` | optional | KJ BoundingBox wire (for `bbox` mode) |
| `mask_a` | `MASK` | optional | Painted mask override for region A |
| `mask_b` | `MASK` | optional | Painted mask override for region B |
| `debug` | `BOOLEAN` | optional | Print extra per-run diagnostics |

### Outputs

| Name | Type | Description |
|---|---|---|
| `MODEL` | `MODEL` | The patched model (base weights untouched, hooks applied at forward time) |

---

## 7. Wiring Guide (with a real Flux 2 workflow)

Here's how the node fits into a typical Krea 2 / Flux 2 editing pipeline:

```text
  ┌────────────┐     ┌──────────────────┐     ┌────────────────────┐
  │ UNETLoader │────►│ Krea 2 Uncensored│────►│ LoraLoaderModelOnly│
  │ (flux2-dev)│     │ (base LoRAs)     │     │ (turbo / style)    │
  └────────────┘     └──────────────────┘     └─────────┬──────────┘
                                                        │ MODEL
                                                        ▼
  ┌────────────┐     ┌──────────────────┐     ┌────────────────────┐
  │ CLIPLoader │────►│ CLIPTextEncode   │────►│ FluxGuidance       │
  │ (mistral)  │     │ (your prompt)    │     │ (guidance = 4)     │
  └────────────┘     └──────────────────┘     └─────────┬──────────┘
                                                        │ CONDITIONING
                                                        ▼
  ┌────────────┐     ┌──────────────────┐     ┌────────────────────┐
  │ MaskEditor │────►│ ImageScale       │────►│ VAEEncode          │
  │ (paint     │     │ (to 1 MP)        │     │                    │
  │  mask)     │     └────────┬─────────┘     └─────────┬──────────┘
  └─────┬──────┘              │                         │ LATENT
        │                     ▼                         ▼
        │            ┌──────────────────┐     ┌────────────────────┐
        │            │ GetImageSize     │────►│ ReferenceLatent    │
        │            │ (→ scheduler,    │     │ (conditioning +    │
        │            │  empty latent)   │     │  reference latent) │
        │            └──────────────────┘     └─────────┬──────────┘
        │                                              │ CONDITIONING
        │                                              ▼
        │            ┌──────────────────────────────────────────────┐
        │            │                                              │
        │            │   NOUGAN REGIONAL CHARACTER LORA 🎭          │
        │            │                                              │
        │            │   model ◄──── from LoraLoaderModelOnly       │
        │            │   lora_a = "character_a.safetensors"         │
        │            │   lora_b = "character_b.safetensors"         │
        │            │   split_mode = "manual"                      │
        │            │   regions ◄──── (visual editor)              │
        │            │                                              │
        │            └──────────────────┬───────────────────────────┘
        │                               │ MODEL (patched)
        │                               ▼
        │            ┌──────────────────────────────────────────────┐
        │            │  BasicGuider ← model + conditioning          │
        │            └──────────────────┬───────────────────────────┘
        │                               │ GUIDER
        │                               ▼
        │            ┌──────────────────────────────────────────────┐
        │            │  SamplerCustomAdvanced                       │
        │            │  (noise + guider + sampler + sigmas + latent)│
        │            └──────────────────┬───────────────────────────┘
        │                               │ LATENT
        │                               ▼
        │            ┌──────────────────────────────────────────────┐
        │            │  VAEDecode → NouganMaskComposite → SaveImage │
        │            └──────────────────────────────────────────────┘
        │
        └──► MASK ──► NouganMaskComposite (for edit-then-composite)
```

### Key wiring rules

1. **Regional LoRA goes AFTER all global LoRAs** — it patches the model that
   already has your style/turbo/uncensor LoRAs baked in.
2. **Regional LoRA goes BEFORE the sampler** — it returns a patched `MODEL`
   that the guider/sampler consumes.
3. **The `regions` widget is managed by the visual editor** — you don't type
   JSON by hand (unless you want to).
4. **`mask_a` / `mask_b` sockets override the editor** — if you wire a painted
   mask in, it takes priority over the box-based regions.

---

## 8. Token-Space Mechanics (deeper dive)

### How pixel boxes become token masks

```text
  Editor box (normalised):          Token grid (78 × 52):
  ┌───────────────────────┐         ┌───────────────────────┐
  │ x=0.0  y=0.0         │         │ 0 0 0 ... 0 │ 0 0 0  │
  │ w=0.5  h=1.0         │  ───►   │ 0 0 0 ... 0 │ 0 0 0  │
  │                       │         │ . . .       │ . . .  │
  │ (left half)           │         │ 1 1 1 ... 0 │ 0 0 0  │
  │                       │         │ 1 1 1 ... 0 │ 0 0 0  │
  └───────────────────────┘         └───────────────────────┘
                                     ▲ mask_A = 1 inside box
                                     ▲ mask_B = 1 - mask_A (complement)
```

The conversion:
1. Normalised coords `(x, y, w, h)` → token-grid coords `(x×cols, y×rows, ...)`
2. A **sigmoid ramp** at the box edges creates a soft feather (controlled by
   `seam_feather`)
3. The mask is flattened row-major to match the image-token order in the sequence

### The text/image token split

The model's sequence is `[text tokens | image tokens]`:

```text
  ┌──────────────────────────────────────────────────────────────┐
  │  text tokens (prompt)  │  image tokens (latent grid)        │
  │  ← mask = 0 (no LoRA) │  ← mask = region value             │
  │                        │                                    │
  │  n_text tokens         │  n_img = rows × cols tokens        │
  └──────────────────────────────────────────────────────────────┘
                           ▲
                           │
                    seq - n_img = n_text
```

The node measures `n_img` from the latent shape at runtime and places the region
mask on the **trailing** `n_img` tokens. Text tokens always get mask = 0, so the
LoRA deltas never touch the prompt conditioning.

### Feathering

`seam_feather` controls how soft the boundary between regions is:

```text
  feather = 0.0 (hard)          feather = 0.08 (default)       feather = 0.2 (soft)
  ┌──────┬──────┐               ┌──────┬──────┐                ┌──────┬──────┐
  │ A=1  │ B=1  │               │ A=1  │░░░░░░│                │ A=1  │▒▒▒▒▒▒│
  │ A=1  │ B=1  │               │ A=1  │░░░░░░│                │ A=1  │▒▒▒▒▒▒│
  │ A=1  │ B=1  │               │ A=1  │░░░░░░│                │ A=1  │▒▒▒▒▒▒│
  └──────┴──────┘               └──────┴──────┘                └──────┴──────┘
  abrupt seam                   smooth transition              very wide blend
  (visible line)                (natural)                      (characters merge)
```

### Blend override

`blend_override` mixes between pure regional and a controlled global merge:

```text
  blend = 0.0                   blend = 0.5                    blend = 1.0
  ┌──────┬──────┐               ┌──────┬──────┐                ┌──────┬──────┐
  │ A=1  │ A=0  │               │ A=.75│ A=.25│                │ A=.5 │ A=.5 │
  │ B=0  │ B=1  │               │ B=.25│ B=.75│                │ B=.5 │ B=.5 │
  └──────┴──────┘               └──────┴──────┘                └──────┴──────┘
  pure regional                 partial merge                  both everywhere
  (no cross-contamination)      (slight blend at seam)         (same as stacking)
```

---

## 9. Krea 2 / Flux 2 Architecture Notes

These are the architectural facts that determine whether the regional patch works
correctly. They were confirmed via `recon_krea2.py` and the session's own logs.

### Attention projections: SEPARATE (not fused)

```text
  Krea 2 / Flux 2 image transformer block:
  ┌─────────────────────────────────────────────────┐
  │  blocks.N.attn.wq    ← separate Q projection    │
  │  blocks.N.attn.wk    ← separate K projection    │
  │  blocks.N.attn.wv    ← separate V projection    │
  │  blocks.N.attn.wo    ← separate output proj     │
  │  blocks.N.mlp.gate   ← MLP gate                 │
  │  blocks.N.mlp.up     ← MLP up                   │
  │  blocks.N.mlp.down   ← MLP down                 │
  └─────────────────────────────────────────────────┘
```

This means the node patches **whatever Linear the LoRA actually targets** — it
doesn't assume fused qkv. If your LoRA targets `wq` and `wk`, those are the only
layers that get hooks.

### The txtfusion branch

Krea 2's character/refusal LoRAs (like the CivitAI TextFusion Refusal-Reduction
LoRA) target a **separate conditioning pathway**:

```text
  Qwen-VL text encoder
         │
         │  hidden-state taps
         ▼
  ┌─────────────────────────────────────┐
  │  txtfusion.layerwise_blocks.0       │  ← LoRA targets here
  │  txtfusion.layerwise_blocks.1       │  ← LoRA targets here
  │  txtfusion.refiner_blocks.0         │  ← LoRA targets here
  │  txtfusion.refiner_blocks.1         │  ← LoRA targets here
  └──────────────────┬──────────────────┘
                     │  conditioning
                     ▼
  ┌─────────────────────────────────────┐
  │  Image transformer (blocks.0..N)    │  ← character LoRAs target here
  └─────────────────────────────────────┘
```

**Important:** if your character LoRAs target the image transformer blocks
(`blocks.N.attn.*`), the regional masking works as described. If they target
`txtfusion.*` instead, the regional mask still applies, but the effect is on the
*conditioning pathway* rather than the image tokens directly — which may produce
different (less spatially precise) results.

### LoRA key naming

The node normalises LoRA keys and model module names to a common signature:

```text
  LoRA key:    lora_unet_blocks_0_attn_wq.lora_down.weight
               ─────────────────────────────────────────────
               strip prefix → "blocks_0_attn_wq.lora_down.weight"
               strip suffix → "blocks_0_attn_wq"
               collapse _/. → "blocks0attnwq"

  Model name:  blocks.0.attn.wq
               ─────────────────
               collapse _/. → "blocks0attnwq"

  Match! ✓
```

---

## 10. Debugging — "It Sometimes Makes Mistakes"

The most common causes of intermittent issues, ranked by likelihood:

### Diagnostic checklist

| # | Symptom | Likely cause | Fix |
|---|---|---|---|
| 1 | Character appears in the **wrong region** | Token offset mismatch — the text/image boundary is wrong for your model | Run the recon runtime snippet; check the `[NouganRegionalLoRA] forward: seq=… n_text=… n_img=…` print |
| 2 | Characters **blend** despite clean boxes | `blend_override` > 0, or `seam_feather` too high | Set `blend_override = 0`, reduce `seam_feather` to `0.04` |
| 3 | Character is **weak or inconsistent** | Few layers matched — LoRA key stems don't normalise-match the model | Check the `matched N layers` print; run `recon_krea2.py` to compare LoRA stems vs model keys |
| 4 | **No effect at all** | 0 layers matched, or LoRA file not found | Check console for `!! 0 layers matched` or file-not-found warnings |
| 5 | Character looks **slightly off / noisy** | bf16 precision loss on small deltas | Switch `compute_precision` to `fp32 (precise)` |
| 6 | **Hard visible seam** between regions | `seam_feather = 0` | Increase to `0.06`–`0.12` |
| 7 | Whole image changes, not just the region | `mask_a`/`mask_b` wired but covering the full frame, or `regions` JSON is empty/corrupt | Check the visual editor; verify boxes are drawn |

### Console prints to watch

When you queue a generation, the node prints diagnostic lines:

```text
[NouganRegionalLoRA] matched 128 layers (A:64 B:64 targets in file).
[NouganRegionalLoRA] prepared on cuda:0 | latent=(1, 16, 104, 156) grid=52x78 (latent) n_img=4056 split=manual
[NouganRegionalLoRA] forward: seq=4312  n_text=256  n_img=4056 (grid 52x78, latent)  split=manual  dtype=torch.bfloat16
```

**What to check:**
- `matched N layers` — should be > 0, ideally close to the LoRA's target count
- `n_img` — should equal `rows × cols` from the grid
- `n_text` — should be a positive number (the text encoder's token count)
- If you see `!! n_img does not fit in seq` — the trailing-image assumption is
  wrong for your model; report the `seq` and `n_img` values

---

## 11. The Recon Tool

`recon_krea2.py` is a **CPU-only diagnostic** that parses safetensors headers
(no tensor loading, no GPU needed). Run it before first use to confirm your
LoRA and model are compatible:

```bash
cd <ComfyUI root>
python_embeded\python.exe custom_nodes\Nougan\recon_krea2.py ^
    --unet "models\unet\krea2TurboOfficialComfy_krea2TurboFp8.safetensors" ^
    --lora "models\loras\your_character_lora.safetensors"
```

It answers three questions:

| Question | What it tells you | Why it matters |
|---|---|---|
| **Q1** | Fused qkv vs separate q/k/v, + MLP presence | Determines which Linear layers get hooks |
| **Q2** | Standard LoRA vs LoHa (LyCORIS) | LoHa needs special handling; standard up@down works |
| **Q3** | LoRA key naming convention | Must normalise-match the model's module names |

The script also prints a **runtime snippet** you can paste into the node wrapper
to measure the live `x.shape` / `context.shape` during a generation — this
confirms the text/image token split for your specific model.

---

## 12. FAQ / Troubleshooting

**Q: Does this modify my base model?**
No. The base weights are never touched. LoRA deltas are added via forward hooks
at inference time and removed after each forward call.

**Q: Can I use more than 2 characters?**
Not with this node as-is — it's designed for exactly 2 regions (A and B). For
more characters, you'd need to extend the hook to handle N masks.

**Q: Does it work with inpainting / compositing?**
It's designed to work *without* compositing — the regional masking happens inside
the model's forward pass. But you can still use the `NouganMaskComposite` node
downstream for edit-then-composite workflows (e.g., masking a Flux 2 edit to a
painted region).

**Q: Why does the visual editor show a portrait aspect ratio?**
The editor canvas is cosmetic — it shows your box layout in a fixed preview
aspect. The actual masking uses the real latent dimensions at execution time, so
the boxes map correctly regardless of the preview shape.

**Q: The `regions` widget shows a long JSON string. Should I edit it?**
No — it's managed by the visual editor. If you need to reset it, delete the node
and re-add it, or switch `split_mode` away from `manual` and back.

**Q: Can I use painted masks instead of boxes?**
Yes. Wire a `MASK` into the `mask_a` and/or `mask_b` sockets. Painted masks
**always override** the box-based regions, regardless of `split_mode`.

**Q: What does `blend_override` actually do?**
It interpolates between pure regional masking (`0`) and a uniform 50/50 mix
(`1`). At `0`, each region gets only its own LoRA. At `1`, every token gets both
LoRAs at half strength (equivalent to a normal stack). Values in between give a
controlled partial blend. Default is `0` (pure regional).

**Q: The node prints `!! 0 layers matched`. What now?**
Your LoRA's key stems don't match the model's module names after normalisation.
Run `recon_krea2.py` with both `--unet` and `--lora` and compare the printed
stems. Common causes: the LoRA was trained for a different model architecture,
or it uses a non-standard key prefix.

**Q: Does `compute_precision` matter?**
For most use cases, `bf16 (fast)` is fine. If you notice subtle fidelity issues
(character looks slightly different from a global-LoRA reference), switch to
`fp32 (precise)`. The difference is in the matmul precision of the LoRA deltas,
which accumulate across many layers.

---

> 🌀 **Nougan Suite** · [← Back to overview](../README.md) · [Core nodes](core-nodes.md) · [Lora Inspector](lora-inspector.md) · [Prompt Relay](prompt-relay.md) · [LM Studio Bridge](lm-studio-bridge.md)
