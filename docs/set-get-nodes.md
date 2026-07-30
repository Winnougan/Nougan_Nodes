> 🌀 **Nougan Suite** · [← Back to overview](../README.md) · [All docs](./)

# 📚 Nougan Docs

Permalink: 📚 Nougan Docs

One page per node family.

| Page | Covers |
| --- | --- |
| Core nodes 🧰 | Diffusers Loader · Krea 2 · Get Image · Text Encode + Zero Neg · Text Box · Title Font · Lora Loaders · Masks |
| **Remote Data Nodes 📡** | **Set (Remote) · Get (Remote) · Auto-color sync · Key management** |
| Lora Inspector 🔍 | Civitai lookup, sample strip, caching, HTTP endpoint |
| Regional Character LoRA 🎭 | Token-space masking, regions, recon tool, debugging |
| Prompt Relay 🎬 | Timeline editor, epsilon tuning, technical deep dives |
| LM Studio Bridge 🧠 | Dev-server setup, vision/audio/video, Krea 2 prompt director |

---

## 📡 Remote Data Nodes (NEW!)

Wireless data passing across your ComfyUI graphs with automatic color synchronization.

### ⚡ Nougan Set (Remote)

Stores any data type in a global remote state dictionary for wireless access.

**Features:**
- **Auto-prefix:** Type `lora` → automatically becomes `set_lora`
- **Epic color palette:** 14 cyberpunk-inspired colors with neon glow effects
- **Pass-through output:** Drop it inline without breaking existing wire flows
- **Smart darkening:** Backgrounds are darkened for perfect text readability
- **Real-time sync:** Color changes instantly propagate to all matching Get nodes

**Inputs:**
- `key` (String): Unique identifier (auto-prefixed with `set_`)
- `value` (*): Any data type (images, latents, strings, etc.)
- `color` (Dropdown): Visual color for node, wires, and badge

**Outputs:**
- `pass_through` (*): The same value that was input (for inline use)

---

### 📥 Nougan Get (Remote)

Retrieves data from a Set node using the same key identifier.

**Features:**
- **Dynamic dropdown:** Auto-populates with all active Set node keys
- **Color inheritance:** Automatically matches the color of its Set node
- **Real-time updates:** Changes color instantly when Set node color changes
- **Type-agnostic:** Receives any data type stored by Set node

**Inputs:**
- `key` (Dropdown): Select from available Set node keys (e.g., `set_lora`)

**Outputs:**
- `value` (*): The data stored in the matching Set node

---

### 🎨 Color Palette

| Color Name | Hex Code | Use Case |
|------------|----------|----------|
| **Void** | `#0a0a0a` | Dark/stealth mode |
| **Neon** | `#00f3ff` | Cyan highlights |
| **Plasma** | `#bc13fe` | Purple/pink effects |
| **Toxic** | `#39ff14` | Green accents |
| **Flare** | `#ff5e00` | Orange warmth |
| **Blood** | `#ff0000` | Red alerts |
| **Quantum** | `#0044ff` | Blue tech |
| **Gold** | `#ffaa00` | Premium/golden |
| **Abyss** | `#ff007f` | Magenta pop |
| **Ghost** | `#e0e0e0` | Light/neutral |
| **Rose** | `#ff0055` | Pink emphasis |
| **Matrix** | `#00ff41` | Terminal green |
| **Nebula** | `#4b0082` | Deep purple |

**Visual Design:**
- Title bar: 45% darkened color
- Body: 65% darkened color  
- Border/wires/badge: Full neon brightness
- White text on all backgrounds for maximum readability

---

### 🔧 Usage Example

**Scenario:** Pass a LoRA embedding from one part of your graph to another without long wires.

1. **Create Set Node:**
   - Add `Nougan Set (Remote)`
   - Type key: `lora` → auto-becomes `set_lora`
   - Connect your LoRA data to `value`
   - Select color: `Plasma` (purple)

2. **Create Get Node:**
   - Add `Nougan Get (Remote)` anywhere in your graph
   - Click the key dropdown → `set_lora` appears automatically
   - Select it → node instantly turns purple to match the Set node
   - Connect output to your model loader

3. **Real-Time Sync:**
   - Change Set node color to `Neon` (cyan)
   - Get node **instantly** updates to cyan
   - Wires and badges update automatically

---

### 🛠️ Technical Details

**Backend:**
- Thread-safe global dictionary (`_NOUGAN_REMOTE_STATE`)
- Lock-based concurrency protection
- Zero performance overhead on graph execution

**Frontend:**
- DOM-based badge positioning (no canvas overlap)
- Canvas background override for exact color control
- Real-time graph scanning for key discovery
- Automatic wire color synchronization

**Compatibility:**
- ✅ ComfyUI Nodes 2.0 ready
- ✅ Works with any data type (images, latents, strings, models)
- ✅ Browser-cached script with hard-refresh requirement (Ctrl+F5)

---

### ⚠️ Troubleshooting

**"Key not found" error:**
- Ensure the Set node executes BEFORE the Get node in your graph
- Check that the key names match exactly (case-sensitive)

**Colors not syncing:**
- Hard-refresh your browser (Ctrl+F5 / Cmd+Shift+R)
- ComfyUI aggressively caches JavaScript files

**Dropdown not populating:**
- Click the dropdown to trigger a refresh
- Ensure at least one Set node exists in your graph

---

## 🧰 Core Nodes

### Diffusers Loader 🚀
Load and manage Hugging Face Diffusers models for Krea 2 and other pipelines.

### Krea 2 Loader 🌀
Uncensored model loading for Krea 2 with LoRA support and status monitoring.

### Get Image 🖼️
Fetch images from URLs, local paths, or remote sources with caching.

### Text Encode + Zero Neg 🎯
Advanced text encoding with automatic zero negative prompt handling.

### Text Box 📝
Multi-line text input with formatting and validation.

### Title Font 🌈
Custom typography for image overlays and titles.

---

## 🔍 Lora Inspector

Browse Civitai metadata, view sample strips, and cache LoRA information with HTTP endpoint integration.

---

## 🎭 Regional Character LoRA

Apply character-specific LoRAs to specific regions/tokens with token-space masking and debugging tools.

---

##  Prompt Relay

Timeline-based prompt editing for video generation with epsilon tuning and advanced temporal control.

---

## 🧠 LM Studio Bridge

Connect to LM Studio's dev server for LLM-powered vision, audio, and video generation with Krea 2 prompt direction.

---

## 📦 Installation
