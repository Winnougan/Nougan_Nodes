> 🌀 **Nougan Suite** · [← Back to docs](README.md)

# 🪟 Live Settings Panel

A floating, dockable panel that shows the settings you actually touch while generating — **checkpoint, CLIP, VAE, resolution, duration, every sampler and every LoRA** — in one small window, and edits the *real* nodes live. No cables, no hunting across a huge graph.

![Live Settings panel](images/live-panel.png)

> **It is a frontend extension, not a node.** There is nothing to add to the canvas — the panel appears on its own the moment ComfyUI loads.

---

## ✨ What it does

- **Reads your workflow** and builds itself from what is in it. Add a sampler and it shows up; bypass it and it disappears.
- **Edits the real widgets.** Change a value in the panel and the node changes, exactly as if you had typed it on the node. Undo / redo and the "modified" marker work as normal.
- **Follows primitives.** If a value is driven by a Primitive node, the panel edits the primitive for you.
- **Looks inside subgraphs.** A loader exposed on a subgraph is shown once, with its promoted widget.
- **Skips what doesn't run.** Bypassed and muted nodes are ignored, and so are saver nodes.
- **Make it yours.** Rename, hide and reorder anything; layouts are saved with the workflow.
- **Visual presets.** Seven colour themes, borrowed from the Aimdo visualizer.

---

## 📦 Install

The panel ships with the Nougan Suite. It needs two files:

| File | Location |
|---|---|
| `nougan_live_panel.js` | `web/` |
| `nougan_live_panel.css` | `web/css/` |

Restart ComfyUI and hard-refresh the browser tab. The console banner confirms it:

```
✔ Live Settings Panel (web extension)
```

If either file is missing, the banner shows `✘ Live Settings Panel NOT loaded — missing web/…` and names the missing file.

---

## 🧭 What shows up

The panel is split into sections. Each section only appears if the workflow has something for it.

### Models

| Row | Picks up |
|---|---|
| **Checkpoint** | `ckpt_name`, `unet_name` (Load Checkpoint, UNET Loader, and look-alikes) |
| **CLIP** | `clip_name`, `clip_name1`–`clip_name4` |
| **VAE** | `vae_name` (and numbered copies such as `vae_name_1`) |

Every row is a dropdown of the files ComfyUI knows about. Loaders whose widget is driven by a link from another node are not listed (there is nothing to edit); the node that really owns the widget is.

### Output

| Card | What it edits |
|---|---|
| **Resolution** | Any node with `aspect_ratio` + `megapixels` (e.g. *Resolution Selector*): aspect ratio dropdown, **MP**, **Mult**, plus a live `≈ width × height` estimate |
| **Size** | Any node with unlinked `width` + `height` widgets (e.g. *Empty Latent Image*): **W** and **H** |
| **Duration** | A Primitive Float / Int whose title contains *dur*, *second*, *time* or *length* (for example "Float (duration)"), or any widget named `duration`, `seconds`, `duration_seconds` or `length_seconds` |

> The `≈` size is calculated in the panel from the aspect ratio, megapixels and multiple, so treat it as a close estimate rather than a read-back from the node.
>
> A width/height pair that is fully driven by a selector node is not shown as a Size card; edit the Resolution card instead.

### Samplers

One card per sampler, numbered in node order. Works with **KSampler**, **KSampler (Advanced)**, look-alikes, and **SamplerCustom / SamplerCustomAdvanced** (the panel follows the `sampler`, `sigmas` and `guider` inputs upstream to find the real settings).

| Field | Notes |
|---|---|
| **Steps**, **CFG** | `NA` when the node chain has no such value (e.g. a guider without CFG) |
| **Sampler**, **Scheduler** | Dropdowns |
| **Denoise** | Shown when the chain has one |

### LoRAs

One card per LoRA, for both the standard `lora_name` loaders and the **rgthree Power Lora Loader**.

| Control | Notes |
|---|---|
| **On** | Checkbox (Power Lora Loader). Cards for LoRAs that are switched off are dimmed. |
| **File** | Dropdown of your LoRAs |
| **Strength** | Slider (−2 to 2) and number field (−10 to 10) |
| **Clip str.** | Shown when the loader is set to *Separate Model & Clip* |

---

## 🎛️ Using the panel

| Action | How |
|---|---|
| **Move** | Drag the header |
| **Dock** | Click **⇥** to cycle right → left → floating, or drag the panel to the edge of the canvas |
| **Resize** | Drag the bottom-right corner (floating only) |
| **Collapse / expand** | **−** / **+** in the header, or double-click the header |
| **Minimize** | **×** shrinks the panel to a small **⚙ Live** box at the top right of the canvas. Click the box to bring the panel back. |
| **Nudge a number** | Click a number field and use the mouse wheel |
| **Turn it off completely** | Settings → **Nougan Live Panel: enabled**. Off removes the panel *and* the box. |

Position, size, dock side, collapsed / minimized state and theme are remembered in your browser.

---

## 🧩 Customize the layout

| Action | How |
|---|---|
| **Go to the node** | Single-click a row label (Checkpoint, CLIP, …) or a card title. The canvas centres on that node and selects it. Clicking the node name on the right of a card does the same. |
| **Rename** | Double-click a label or card title. **Enter** saves, **Esc** cancels, an empty name restores the default. |
| **Remove** | Click the **×** on a row or card. A "*n* hidden" note appears in the footer. |
| **Reorder** | Drag a card by its grip dots or title, or a model row by its label. Items reorder within their own section. |
| **Bring everything back** | **Default** in the footer. Click twice (it asks *Sure?*) to restore hidden items, remove renames and clear custom ordering. |

Names, hidden items and order are stored **inside the workflow file** (`extra.nougan_live_panel`), so every workflow keeps its own layout and it travels when you share the file. Changing the layout marks the workflow as modified; save it to keep the layout.

> Default names are numbered among the items you can currently see — hide "Checkpoint 1" and the remaining one simply becomes "Checkpoint". Renamed items keep their name.

---

## 🔄 Reload

The **Reload** button in the footer does what pressing **R** in ComfyUI does: it rescans your model and LoRA folders and refreshes every dropdown, including the panel's LoRA list. Add a new LoRA, press **Reload**, and it appears — no keyboard needed. The button shows *Reloaded ✓* when it is done.

---

## 🎨 Visual presets

Click **◐** in the header to pick a theme. It repaints the whole panel, its dropdowns, and the minimized box — and nothing else in ComfyUI.

| Preset | Look |
|---|---|
| **Comfy** *(default)* | Follows ComfyUI's own theme, light or dark |
| **Dark** | Neutral dark grey with orange accents |
| **Light** | Clean light grey |
| **Sepia** | Warm paper tones |
| **Fallout** | Green CRT in metallic chrome |
| **Pink** | Pastel pink |
| **Lucifer** | Black and red |

The theme is stored in your browser, so it is the same across all workflows. The palettes are adapted from the Aimdo memory visualizer.

---

## 🛠️ For tinkerers

Matching is done by widget name. To teach the panel about a custom loader, edit the lists at the top of `nougan_live_panel.js`:

```js
const CHECKPOINT_WIDGETS = ["ckpt_name", "unet_name"];
const CLIP_WIDGETS = ["clip_name", "clip_name1", "clip_name2", "clip_name3", "clip_name4"];
const VAE_WIDGETS = ["vae_name"];
const EXCLUDE_TYPES = /save/i;   // node types to skip
```

Duration widget names live in `DURATION_WIDGETS`, and new theme palettes go in the `THEMES` table.

The panel checks the graph about every 0.4 s and pauses while the tab is hidden or the panel is collapsed.

---

## 🩺 Troubleshooting

| Problem | Fix |
|---|---|
| **No panel at all** | Look for the small **⚙ Live** box (you minimized it) and click it. Then check Settings → *Nougan Live Panel: enabled*. Finally check the console banner for `✘ Live Settings Panel NOT loaded` and make sure both files are in place. |
| **A loader is missing** | It may be bypassed or muted, driven by a link from another node, or use a widget name that is not in the lists above. Check **Default** in case you hid it. |
| **Everything is hidden** | Press **Default** (twice). |
| **A new LoRA isn't in the list** | Press **Reload**. |
| **A number is greyed out** | It is driven by a link from another node. Edit it at its source. |
| **CFG / Denoise shows `NA`** | The sampler chain has no such value (e.g. a guider without CFG). |
| **My layout is gone after reopening a workflow** | The layout lives in the workflow file. Save the workflow after changing it. |
| **Dropdown text is hard to read** | Switch theme with **◐**. *Comfy* follows ComfyUI's own colours. |

---

## ⚠️ Good to know

- The panel shows **duration in seconds only**. Frame count and FPS are not shown.
- Samplers, LoRAs and resolution nodes are found by widget name. Heavily customised nodes with unusual widget names may need an entry in the lists above.
- Loaders that come from a link are hidden by design; the panel never shows a control it cannot edit.

---

*See also:* [Canvas Tools 🖱️](canvas-tools.md) — the other frontend-only part of the suite.
