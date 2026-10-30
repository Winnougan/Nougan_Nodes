> 🌀 **Nougan Suite** · [← Back to docs](README.md)

# 🪟 Automagic 2222: Live Panel

**Automagic 2222: Live Panel** (a nod to the Automatic1111 days) is a floating, dockable panel that shows the settings you actually touch while generating: **checkpoint, CLIP, VAE, resolution, duration, every sampler (seed included) and every LoRA**, plus any widget you pin to it, all in one small window, and edits the *real* nodes live. It also has its own **Queue / Stop buttons, progress bar and VRAM meter**, so you can run a generation without leaving the panel. No cables, no hunting across a huge graph.
<img width="1672" height="941" alt="automagic_2222" src="https://github.com/user-attachments/assets/e60e13cb-9062-4c49-b210-1041d1052101" />
> **It is a frontend extension, not a node.** There is nothing to add to the canvas — the panel appears on its own the moment ComfyUI loads.

---

## ✨ What it does

- **Reads your workflow** and builds itself from what is in it. Add a sampler and it shows up; bypass it and it disappears.
- **Edits the real widgets.** Change a value in the panel and the node changes, exactly as if you had typed it on the node. Undo / redo and the "modified" marker work as normal.
- **Seed control.** Every sampler gets a seed row with a 🎲 button and the fixed / increment / decrement / randomize mode.
- **Pin any widget.** Pin a widget from any node (including custom nodes and prompt boxes) to the panel. No code editing needed.
- **Runs from the panel.** Queue and Stop buttons, a progress bar with step count and ETA, and a live VRAM / RAM meter.
- **Follows primitives.** If a value is driven by a Primitive node, the panel edits the primitive for you.
- **Looks inside subgraphs.** A loader exposed on a subgraph is shown once, with its promoted widget.
- **Skips what doesn't run.** Bypassed and muted nodes are ignored, and so are saver nodes.
- **Make it yours.** Rename, hide and reorder anything; layouts and pins are saved with the workflow.
- **Visual presets.** Seven colour themes, borrowed from the Aimdo visualizer.
- **Built-in live preview.** An optional strip at the top of the panel shows the sampling preview, σ/Δ graph, step time and audio spectrogram from KJNodes' *Model Preview Override*. No extra node needed, and off by default.

---

## 📦 Install

The panel ships with the Nougan Suite. It needs four files:

| File | Location |
|---|---|
| `nougan_live_panel.js` | `web/` |
| `nougan_panel_preview.js` | `web/` (next to `nougan_live_panel.js`) |
| `nougan_panel_progress.js` | `web/` (next to `nougan_live_panel.js`) |
| `nougan_live_panel.css` | `web/css/` |

Restart ComfyUI and hard-refresh the browser tab (Ctrl+F5, browsers cache the scripts). The console banner confirms it:

```
✔ Automagic 2222: Live Panel (web extension)
```

If a file is missing, the banner shows `✘ Automagic 2222: Live Panel NOT loaded — missing web/…` and names the missing file.

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

One card per sampler, numbered in node order. Works with **KSampler**, **KSampler (Advanced)**, look-alikes, and **SamplerCustom / SamplerCustomAdvanced** (the panel follows the `sampler`, `sigmas`, `guider` and `noise` inputs upstream to find the real settings).

| Field | Notes |
|---|---|
| **Steps**, **CFG** | `NA` when the node chain has no such value (e.g. a guider without CFG) |
| **Seed** | Value, 🎲 and mode dropdown. See [Seed](#-seed). Not shown when the chain has no seed. |
| **Sampler**, **Scheduler** | Dropdowns |
| **Denoise** | Shown when the chain has one |

### LoRAs

One card per LoRA, for the standard `lora_name` loaders, the **rgthree Power Lora Loader** and the **Nougan Lora Loader**.

| Control | Notes |
|---|---|
| **On** | Checkbox (Power Lora Loader, Nougan Lora Loader). Cards for LoRAs that are switched off are dimmed. |
| **File** | Dropdown of your LoRAs |
| **Strength** | Slider (−2 to 2) and number field (−10 to 10) |
| **Clip str.** | Shown when the loader is set to *Separate Model & Clip* (or the Nougan loader entry is split) |

### Pinned

Widgets you pinned yourself. See [Pin any widget](#-pin-any-widget).

---

## 🎲 Seed

Each sampler card has a **Seed** row with three parts:

| Part | What it does |
|---|---|
| **Number field** | The seed. Type a value, or click it and use the mouse wheel to nudge it by 1. |
| **🎲** | Rolls a new random seed right now. |
| **Mode dropdown** | The node's own *control after generate*: **fixed**, **increment**, **decrement** or **randomize**. This decides what happens to the seed after each run. |

The seed is found on `seed` (KSampler), `noise_seed` (KSampler Advanced, SamplerCustom) and on the **RandomNoise** node feeding a SamplerCustomAdvanced. If the seed is driven by a Primitive node, the panel edits the primitive and its mode instead. A seed driven by a link from any other node is shown greyed out, and the 🎲 is disabled.

> With **randomize**, the seed in the panel changes by itself after each run. That is the node doing it, the panel just shows it.

---

## 📌 Pin any widget

Anything the panel doesn't know about by name can be pinned. Pinned widgets appear in a **Pinned** section at the bottom of the panel and edit the real node, just like everything else.

**How to pin**

| Action | How |
|---|---|
| **From the header** | Select one or more nodes on the canvas, click **📌**, and tick the widgets you want. The menu stays open so you can pin several in a row. Tick again to unpin. **Esc** or a click elsewhere closes it. |
| **From the node's right-click menu** | Right-click a node. If the cursor is over a widget you get *Pin "name" to Live Panel*. You also get *Pin widgets to Live Panel…* for the node's full list. |
| **Unpin** | Click the **×** on a pinned row, or untick it in the 📌 menu. |

> The right-click entries need a ComfyUI frontend that supports node menu extensions. If they don't show up, the **📌** header button always works.

**What can be pinned**

| Widget type | Control in the panel |
|---|---|
| Dropdown | Searchable dropdown |
| Number | Number field |
| Toggle | Checkbox |
| Single-line text | Text field |
| Multiline text (prompts) | Text box. Edit your positive and negative prompts from the panel. **Ctrl+Enter** still queues while you type. |
| Seed widget (has a *control after generate*) | The full [seed row](#-seed) |

Buttons and image / file upload widgets can't be pinned.

**Good to know**

- Default labels are the widget name. If two pinned widgets share a name (two prompt boxes, say) they get the node id appended, e.g. `text #6`. Rename them like anything else.
- Pins are stored **inside the workflow file** with the rest of your layout.
- A pin whose node was deleted, bypassed or muted is not shown. The footer shows "*n* pins off", and the pin comes back when the node does.
- **Default** in the footer does *not* remove pins.

---

## ▶️ Run bar

A strip under the header that stays visible even when the panel is collapsed.

| Part | What it does |
|---|---|
| **▶ Queue** | Queues the workflow, same as ComfyUI's Run button |
| **■ Stop** | Interrupts the running generation |
| **Progress bar** | Current node, **%**, **step n/N**, **ETA**, and **+n queued**. Shows elapsed time for nodes without steps, then *Done*, *Interrupted* or the failing node on errors. |
| **VRAM / RAM** | How much video and system memory is in use, e.g. `VRAM 5.1/8.0 GB`. The bar turns red above 90%. |

**VRAM peak.** A thin tick on the VRAM bar marks the highest use seen during the last run, and hovering shows the exact number. Handy for checking whether a model or quant really fits your card. The tick resets when the next run starts.

**Good to know**

- VRAM is the **whole GPU** as ComfyUI reports it (other programs on the card count too), which is what decides whether something fits.
- The meters update about once a second while generating and every few seconds when idle, and pause when the tab is hidden or the panel is minimized.
- The VRAM meter is hidden if ComfyUI is running on CPU only.

### Progress bar options

Open **◐** in the header; the **Progress bar** section at the bottom of the menu has:

| Option | What it does |
|---|---|
| **Show progress bar** | Switches the progress bar on or off. While off it holds no listener and no GPU device. The Queue / Stop buttons and the meters stay. |
| **WebGPU effects** | Draws the bar with a small WebGPU shader (smooth fill, moving sheen, glow on the leading edge). The row shows `now: webgpu`, `now: dom` or `now: checking` so you can see which renderer is actually active. |

**The DOM bar is the automatic fallback.** If WebGPU is missing, fails to start, or the GPU device is lost, the panel switches to a plain CSS bar without any message. Turn **WebGPU effects** off to force the DOM bar. Both settings are remembered in your browser. The bar respects your system's *reduce motion* setting.

---

## 🎛️ Using the panel

| Action | How |
|---|---|
| **Move** | Drag the header |
| **Dock** | Click **⇥** to cycle right → left → floating, or drag the panel to the edge of the canvas |
| **Resize** | Drag the bottom-right corner (floating only) |
| **Collapse / expand** | **−** / **+** in the header, or double-click the header. The run bar stays visible when collapsed. |
| **Minimize** | **×** shrinks the panel to a small **⚙ 2222** box at the top right of the canvas. Click the box to bring the panel back. |
| **Live preview on / off** | Click **▶** in the header (see [Live preview](#-live-preview)) |
| **Pin widgets** | Click **📌** with nodes selected (see [Pin any widget](#-pin-any-widget)) |
| **Themes and progress options** | Click **◐** |
| **Nudge a number** | Click a number field and use the mouse wheel |
| **Turn it off completely** | Settings → **Automagic 2222: Live Panel: enabled**. Off removes the panel *and* the box. |

Position, size, dock side, collapsed / minimized state, theme, the progress bar settings, and the live preview's on/off state and height are remembered in your browser.

---

## 🧩 Customize the layout

| Action | How |
|---|---|
| **Go to the node** | Single-click a row label (Checkpoint, CLIP, …) or a card title. The canvas centres on that node and selects it. Clicking the node name on the right of a card does the same. |
| **Rename** | Double-click a label or card title. **Enter** saves, **Esc** cancels, an empty name restores the default. |
| **Remove** | Click the **×** on a row or card. A "*n* hidden" note appears in the footer. On a pinned row the **×** unpins it instead. |
| **Reorder** | Drag a card by its grip dots or title, or a model or pinned row by its label. Items reorder within their own section. |
| **Bring everything back** | **Default** in the footer. Click twice (it asks *Sure?*) to restore hidden items, remove renames and clear custom ordering. Pins are kept. |

Names, hidden items, order and pins are stored **inside the workflow file** (`extra.nougan_live_panel`), so every workflow keeps its own layout and it travels when you share the file. Changing the layout marks the workflow as modified; save it to keep the layout.

> Default names are numbered among the items you can currently see — hide "Checkpoint 1" and the remaining one simply becomes "Checkpoint". Renamed items keep their name.

---

## 🔄 Reload

The **Reload** button in the footer does what pressing **R** in ComfyUI does: it rescans your model and LoRA folders and refreshes every dropdown, including the panel's LoRA list. Add a new LoRA, press **Reload**, and it appears — no keyboard needed. The button shows *Reloaded ✓* when it is done.

---

## 📺 Live preview

The panel can show what the sampler is doing, right inside the panel, so you can watch a generation without hunting for a preview node on the canvas. It is the same feature the *Model Preview Mirror* node used to provide, built in.

> **Requires [KJNodes](https://github.com/kijai/ComfyUI-KJNodes).** The panel does not create previews; it displays the ones KJNodes' **Model Preview Override** node already broadcasts while sampling.

**Turn it on:** click **▶** in the panel header. The button lights up in the theme accent colour and a preview strip appears between the header and the settings. Click **▶** again to turn it off. It is **off by default**.

| Part | What it shows |
|---|---|
| **Preview** | The live image or video of the current step. Animated WebP and MP4 previews play in a loop. |
| **Scrub bar** | Seek through a video preview. Click the preview to pause / resume. |
| **σ / Δ graph** | The sigma schedule (dashed) and the per-step change (filled). Hover to inspect a step, click to lock it (🔒), click again to unlock. |
| **Step time** | Time per step. Click it to switch between ms and seconds. |
| **Header line** | Output size, current step, average step time and ETA |
| **Audio spectrogram** | Appears for previews that carry audio. **🔇 / 🔊** mutes or unmutes the preview sound. |

**Controls**

| Action | How |
|---|---|
| **Resize** | Drag the grip at the bottom of the strip |
| **Pause / resume** | Click the preview, or press **Space** while the mouse is over it |
| **Step through** | **← / →** while the mouse is over the preview (locks that step) |

**Good to know**

- **Nothing runs while it is off.** There is no listener and no frame decoding. The preview also switches itself off while the panel is collapsed, minimized or disabled in settings, and comes back with it.
- It follows the preview node that **most recently started a run** and ignores other preview nodes during that run.
- If you turn it on **mid-run**, the σ graph stays empty until the next run (the sigma data is only sent at step 0).
- Keyboard shortcuts are ignored while you are typing in a field.
- It replaces the old *Model Preview Mirror* node. You can remove that node's files (`nougan_preview_mirror.js` / `.py`) and any copies of the node from your workflows.

---

## 🎨 Visual presets

Click **◐** in the header to pick a theme. It repaints the whole panel, its dropdowns, the run bar, the live preview and the minimized box — and nothing else in ComfyUI.

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

For anything else, you no longer need to edit code: [pin the widget](#-pin-any-widget) instead.

The panel checks the graph about every 0.4 s and pauses while the tab is hidden or the panel is collapsed.

---

## 🩺 Troubleshooting

| Problem | Fix |
|---|---|
| **No panel at all** | Look for the small **⚙ 2222** box (you minimized it) and click it. Then check Settings → *Automagic 2222: Live Panel: enabled*. Finally check the console banner for `✘ Automagic 2222: Live Panel NOT loaded` and make sure all the files are in place. |
| **Changes don't show after an update** | Hard-refresh the tab (Ctrl+F5). The browser caches the scripts. Make sure `nougan_panel_progress.js` and `nougan_panel_preview.js` are in `web/` next to `nougan_live_panel.js`. |
| **No progress bar** | Open **◐** and check **Show progress bar** is ticked. If the panel doesn't load at all or the console shows an import error, `nougan_panel_progress.js` is missing from `web/`. |
| **The progress bar isn't using WebGPU** | Check the **◐** menu: *WebGPU effects* shows `now: dom` when it fell back. Your browser may not support WebGPU, or the GPU device failed. The DOM bar looks the same minus the shader effects. Toggle *WebGPU effects* off and on to retry. |
| **No VRAM meter** | ComfyUI is running on CPU only, or the panel is minimized or the tab is hidden (the meter pauses). |
| **Queue does nothing** | Queue uses ComfyUI's own Run command, so it behaves like the Run button. Check the console for a validation error from the workflow. |
| **No Seed row on a sampler** | The sampler chain has no seed widget the panel can find. [Pin](#-pin-any-widget) the seed widget on the node that has it. |
| **A seed is greyed out** | It is driven by a link from another node. Edit it at its source. |
| **No right-click "Pin to Live Panel"** | Your ComfyUI frontend doesn't support node menu extensions. Use the **📌** header button. |
| **A pinned widget disappeared** | Its node was deleted, bypassed or muted (the footer says "*n* pins off"). It returns with the node. |
| **A loader is missing** | It may be bypassed or muted, driven by a link from another node, or use a widget name that is not in the lists above. Check **Default** in case you hid it, or pin the widget. |
| **Everything is hidden** | Press **Default** (twice). |
| **A new LoRA isn't in the list** | Press **Reload**. |
| **A number is greyed out** | It is driven by a link from another node. Edit it at its source. |
| **CFG / Denoise shows `NA`** | The sampler chain has no such value (e.g. a guider without CFG). |
| **My layout or pins are gone after reopening a workflow** | They live in the workflow file. Save the workflow after changing them. |
| **Dropdown text is hard to read** | Switch theme with **◐**. *Comfy* follows ComfyUI's own colours. |
| **The preview strip stays on "waiting for sample…"** | Make sure KJNodes is installed and a **Model Preview Override** is in the sampling chain, then queue a run. The preview only fills while sampling. |
| **No ▶ preview button, or an import error in the console** | `nougan_panel_preview.js` must sit in `web/` next to `nougan_live_panel.js`. Hard-refresh the tab (Ctrl+F5) after copying it. |
| **The σ graph is empty** | You turned the preview on mid-run. It fills from the next run. |

---

## ⚠️ Good to know

- The panel shows **duration in seconds only**. Frame count and FPS are not shown.
- Samplers, LoRAs and resolution nodes are found by widget name. Heavily customised nodes with unusual widget names may need an entry in the lists above, or just pin the widgets.
- Loaders that come from a link are hidden by design; the panel never shows a control it cannot edit.
- The progress bar and the live preview are separate: the progress bar only reads ComfyUI's own run events, so it works without KJNodes.

---

*See also:* [Canvas Tools 🖱️](canvas-tools.md) — the other frontend-only part of the suite.
