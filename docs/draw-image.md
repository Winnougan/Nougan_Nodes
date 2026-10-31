> 🌀 **Nougan Suite** · [← Back to docs](README.md)

# ✏️ Draw Image

A sketch pad that lives on a node and behaves like **Load Image**. Draw a pose, a layout or a rough guide with your mouse or a stylus, and the node hands the result to the rest of your workflow as an `IMAGE` (plus a `MASK`).

The main use is **pose guidance for edit models** (Flux 3, Fibo 2.0, Qwen 2.1 and friends): sketch a stick figure, feed it in as a reference image, and tell the model to follow that image for the character's pose.

> Node name: **Nougan Draw Image ✏️** · Category: `Nougan`

---

## Contents

- [Quick start](#quick-start)
- [The node](#the-node)
- [Drawing](#drawing)
- [Colour](#colour)
- [Layers](#layers)
- [Undo and Clear all](#undo-and-clear-all)
- [Outputs](#outputs)
- [How saving works](#how-saving-works)
- [Using it with edit models](#using-it-with-edit-models)
- [Limits](#limits)
- [Troubleshooting](#troubleshooting)
- [Technical notes](#technical-notes)

---

## Quick start

1. Add **Nougan Draw Image** (double-click the canvas, search "Draw Image").
2. Set `width` / `height` to the size you want out. Default is 1024 × 1024.
3. Draw. Pick a colour on the wheel, change the brush size, add layers as needed.
4. Connect `image` to the reference-image input of your edit model's node.
5. Queue. The last stroke is saved automatically before the prompt is sent.

---

## The node

| Widget | What it does |
|---|---|
| `width` / `height` | Size of the drawing and of the output image. 64 – 8192, steps of 8, default 1024. |
| `background` | `white`, `black` or `transparent`. Fills behind all layers in the preview and in the output. |
| Sketch pad | The editor itself: toolbar on top, canvas on the left, colour and layers on the right. |

Two more widgets (`image` and `drawing_state`) exist but are hidden. The editor fills them in for you; see [How saving works](#how-saving-works).

**Resizing the node** makes the canvas bigger or smaller on screen. This only changes how large it is to work in. The output size is always `width` × `height`.

**Changing `width` / `height`** resizes every layer. Existing drawing stays anchored to the top-left corner: growing leaves empty space on the right and bottom, shrinking crops. The undo history is cleared when the size changes.

---

## Drawing

| Control | Notes |
|---|---|
| **✏️ Brush** | Draws in the current colour. |
| **🧽 Eraser** | Erases on the active layer only. A stylus's eraser end also erases, whichever tool is selected. |
| **Size** | 1 – 150 px (in drawing pixels, not screen pixels). |
| Brush ring | A ring follows the cursor and shows the real brush size at the current zoom. |

**Stylus pressure.** With a pen, line width follows pressure, from about 10 % up to 100 % of the brush size, lightly smoothed so strokes stay clean. Mouse and touch draw at a constant width.

**Layer must be visible.** If you draw on a hidden layer it is switched back on automatically.

---

## Colour

On the right side of the pad:

- **Colour wheel**: click or drag. Angle is hue, distance from the centre is saturation.
- **Brightness slider** under the wheel. The track shows black → your current hue.
- **Hex box**: type or paste `#rrggbb` and press Enter.
- **Swatches**: black, white, red, orange, yellow, green, blue, purple, one click each.

Picking a colour switches you back to the Brush. If the brightness was at 0, clicking the wheel resets it to full so you never pick a colour you can't see.

> **Pose tip:** give each limb its own colour (left arm red, right arm blue, and so on). It helps the model tell sides apart.

---

## Layers

| Button | Does |
|---|---|
| **+** (Layers header) | Adds a new empty layer directly above the active one. Up to 12 layers. |
| Click a row | Makes that layer active. Drawing and erasing affect only the active layer. |
| **👁** | Show / hide the layer. Hidden layers are not in the output. |
| **▲ / ▼** | Move the layer up or down the stack. |
| **✕** | Remove the layer. Removing the last remaining layer just clears it. |

The list shows the top layer first, each with a small thumbnail. Use layers to put a rough pose underneath and cleaner lines on top, or to keep a background sketch you can toggle off.

---

## Undo and Clear all

- **↶ Undo** steps back through the last 25 actions: strokes, adding a layer, removing a layer, reordering and Clear all.
- **Ctrl+Z** does the same while the canvas has focus (click the canvas first).
- **🗑 Clear all** wipes everything and deletes all layers, leaving a single empty layer. It is one click with no confirmation, but it **can be undone**.
- There is no redo.
- Changing `width` / `height` clears the undo history.

---

## Outputs

| Output | Type | Contents |
|---|---|---|
| `image` | `IMAGE` | The flattened drawing: background plus all visible layers, `width` × `height`. |
| `mask` | `MASK` | `1 − alpha`, the same convention as Load Image. With an opaque background this is all zeros. With a `transparent` background, drawn areas are 0 and empty areas are 1. |

With `background = transparent`, the `image` output is composited over black.

---

## How saving works

The drawing happens in your browser, but the nodes that run it live on the server, so the sketch has to be written to disk.

- About **0.7 seconds after you stop drawing**, the node uploads the flattened image and any changed layers to ComfyUI's input folder:

  ```
  ComfyUI/input/nougan_draw/flat_<id>.png          ← what the node outputs
  ComfyUI/input/nougan_draw/layer_<id>_<layer>.png ← one per layer, so you can keep editing
  ```
- Queueing a prompt **waits for any pending save**, so your last stroke is never missed.
- The workflow itself stores only the file references and the layer list, not the pixels. Reopening a workflow reloads each layer from `input/nougan_draw/`.
- Copying and pasting the node gives the copy its own files, so the two don't overwrite each other.
- A node that has never been drawn on outputs a blank canvas of the right size.

**Housekeeping.** Files from removed layers and deleted nodes are not cleaned up automatically. Delete old files from `input/nougan_draw/` whenever you like.

**Moving a workflow to another machine?** Copy the matching files from `input/nougan_draw/` too. Without them the node outputs a blank canvas and the layers open empty.

---

## Using it with edit models

1. Draw the pose on a plain background (white works well) with thick, high-contrast lines.
2. Connect `image` to the reference-image input of the edit model's node. Flux 3, Fibo 2.0 and Qwen 2.1 edit workflows all take one or more reference images.
3. Refer to that reference in your prompt, for example:

   > Follow image_input_01 as a guide for the character's pose.

   The exact reference name depends on how your edit workflow labels its inputs, for example if you build the prompt with **Edit Prompt Template**.
4. If the edit model and the sketch have different aspect ratios, set `width` / `height` to match the size you're generating, or use **Match Image Size**.

Simple stick figures, clear joints and one colour per limb tend to be the easiest for a model to read. Fine detail is wasted: the model only needs the pose.

---

## Limits

By design this is a sketch pad, not an image editor. It does not have:

- zoom or pan (resize the node instead)
- fill, shapes, text, selection or transform tools
- layer opacity, blend modes or renaming
- redo
- importing a picture to trace over (not yet)

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Node says **Draw Image NOT loaded** in the console banner | `nougan_draw_image.py` is missing from the suite folder, or has an import error. The banner prints the reason. |
| The node loads but there is no sketch pad | `web/nougan_draw_image.js` is missing, or the browser is showing a cached copy. Hard-refresh (Ctrl+F5). |
| Output is blank even though I drew | Wait a second after your last stroke, then queue. If it still fails, open the browser console and look for `[Nougan Draw] save failed`. This usually means the upload to the input folder was blocked. |
| Layers are empty after reopening a workflow | The files in `input/nougan_draw/` were deleted or not copied along with the workflow. |
| Pen draws at a constant width | The browser isn't receiving pressure. Check your tablet driver; some drivers need "Windows Ink" enabled. Mouse and touch never report pressure. |
| Ctrl+Z undoes the graph instead of the drawing | Click on the canvas first so it has focus, or use the **↶ Undo** button. |
| The pad looks tiny | Drag the node's corner to make it larger. |
| Preview seems to be using the 2D fallback | WebGPU isn't available in this browser or was lost. Drawing and output are unaffected. |

---

## Technical notes

- **Drawing:** each layer is its own 2D canvas. Strokes are segments with round caps, using pointer events and coalesced events so fast strokes stay smooth.
- **Display:** layers are composited with a small **WebGPU** shader (premultiplied alpha "over" blending, one texture per layer, re-uploaded only when that layer changes). If WebGPU is unavailable, fails to start or the device is lost, the pad switches to a plain 2D composite automatically. The exported image is always built with the 2D canvas, so the output doesn't depend on WebGPU.
- **Undo** stores only the bounding box of each stroke, not whole layers, so 25 steps stay light even at large sizes.
- **Files:** uploads go through ComfyUI's standard `/upload/image` route into the `input/nougan_draw` subfolder. The `image` widget holds a path such as `nougan_draw/flat_abc123.png`, validated to stay inside the input folder.
- **Cache:** the node's change detection hashes the saved PNG, so ComfyUI only re-runs downstream nodes when the drawing actually changed.
