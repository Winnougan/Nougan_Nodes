> 🌀 **Nougan Suite** · [← Back to docs](README.md)

# 🔲 Bounding Boxes

Draw a layout on a canvas, or let an LLM draw it for you, and send the boxes to any node that takes `BOUNDING_BOX` or prompt elements, such as MOSS-Image Layout Prompt. It's a classic-UI clone of ComfyUI's core **Create Bounding Boxes**, so it works without Nodes 2.0.

| Node | Display name | Category |
|---|---|---|
| `NouganBoundingBoxes` | Nougan Bounding Boxes 🔲 | `Nougan` |
| `NouganLayoutLLMPrompt` | Nougan Layout LLM Prompt 🧭 | `Nougan` |

Both ship with Nougan Nodes, so there's nothing extra to install.

---

## 🚀 Quick start

```
[Resolution Selector] ──width/height──▶ [Nougan Bounding Boxes] ──elements──▶ [MOSS-Image Layout Prompt] ──prompt──▶ [your sampler]
```

1. Add **Nougan Bounding Boxes 🔲**.
2. Set `width` and `height` to your image size, or link them from a Resolution Selector.
3. Drag on the canvas to draw a box. Click it to select it.
4. In the inspector, choose **Object** or **Text**, and fill in the description (and the words, for Text).
5. Connect `elements` to the node that builds your layout prompt.

> ⚠️ A box that should render words must be set to **Text** and have its **Text to render** filled in. Putting `text that says "..."` in the description of an Object box won't make the model write it.

---

## 🔲 Nougan Bounding Boxes

### Inputs

| Input | Description |
|---|---|
| `width` / `height` | Size of the canvas and of the pixel grid for the boxes (64 to 16384, step 16). Can be linked. |
| `background` | Optional image shown behind the boxes in the editor and the preview. |
| `bboxes` | Optional. Boxes, prompt elements, or a **JSON string** (for example from an LLM) used to fill the canvas. |
| `editor_state` / `last_incoming` | Managed by the editor. Leave them alone. |

### Outputs

| Output | Type | Description |
|---|---|---|
| `preview` | IMAGE | The boxes drawn over a dimmed background, with box numbers, descriptions and palette swatches. |
| `bboxes` | BOUNDING_BOX | Pixel-space boxes (`x`, `y`, `width`, `height`). |
| `elements` | ARRAY | Prompt elements: `type`, `bbox`, `text`, `desc`, `color_palette`. |

### How `bboxes` input and the canvas work together

- A **new** upstream value fills the canvas.
- After that, **your edits win** until the upstream value changes again.
- The `bboxes` input accepts pixel boxes, prompt elements, or a JSON string. Code fences, text around the JSON, `<think>` blocks and trailing commas are cleaned up for you.
- A wrapped list such as `{"elements": [...]}` also works.
- An element with no valid `bbox` is skipped with a console message. If the text contains no JSON at all, the error shows how it started.

---

## ✏️ The editor

### Tools and shortcuts

| Action | How |
|---|---|
| Draw tool | **D**, or the ✎ Draw button. Drag anywhere to draw a box. |
| Select tool | **V**, or the ⬚ Select button. Drag a box to move it and its handles to resize. Hold **Shift** to draw instead. |
| Snap | ▦ Snap 16 snaps edges to a 16 px grid. |
| Nudge | Arrow keys. **Shift** for bigger steps. |
| Duplicate | **Ctrl+D** |
| Delete | **Delete** or **Backspace** |

### Layers

The list under the canvas shows every box. **01 is the background, the last one is the foreground**, and the number is the tag shown in the preview.

Each row has **▲ ▼** to change the order and **✕** to delete that box. Click a row to select the box.

### Inspector

For the selected box:

- **Object / Text** toggle
- **Text to render** (Text boxes only)
- **Description**
- Position and size fields
- Up to 5 palette colors
- **Duplicate** and **Delete** buttons

### Right-click menu

| Where | Options |
|---|---|
| On a box or a layer row | Delete box · Duplicate · Bring forward · Send backward · Change to Text / Object |
| On empty canvas | Delete all boxes (asks first) |

### Import / Export

**⇅ Import / Export** opens a text area. Paste prompt elements or pixel boxes and press **Load into canvas**, or use **Copy elements** / **Copy pixel boxes**. **🗑 Clear all** empties the canvas.

---

## 🧭 Nougan Layout LLM Prompt

Writes the instructions that make an LLM answer with bounding-box JSON, so you can describe a scene in words and get boxes on the canvas.

### Inputs

| Input | Description |
|---|---|
| `scene` | What the image shows and where things go ("headline at the top, parrot at the bottom middle"). |
| `width` / `height` | Canvas size. Use the same values as Nougan Bounding Boxes. |
| `max_boxes` | Upper limit on the number of boxes (1 to 16). |
| `extra_rules` | Optional. Extra instructions, such as "keep the bottom 15% empty". |

### Outputs

| Output | Type | Description |
|---|---|---|
| `system_prompt` | STRING | Teaches the LLM the JSON format and the 0 to 1000 grid. |
| `prompt` | STRING | Your scene plus a request for the JSON. |

### Wiring

```
[Layout LLM Prompt] ──system_prompt / prompt──▶ [TextGenerate] ──text──▶ [Nougan Bounding Boxes: bboxes]
                                       [CLIPLoader (Qwen)] ──clip──▶ ┘
```

1. Add a **CLIPLoader** with the text encoder you use for captioning or MOSS, and a **TextGenerate**.
2. Connect `system_prompt` and `prompt` to the matching TextGenerate inputs.
3. Connect TextGenerate's text output to the `bboxes` input of Nougan Bounding Boxes.
4. Run. The boxes appear on the canvas, and you can edit them.

The format the LLM is asked for:

```json
[
  {"type": "text", "bbox": [40, 250, 140, 750], "text": "HOME", "desc": "large white serif lettering"},
  {"type": "obj",  "bbox": [420, 120, 900, 880], "desc": "a ginger cat curled up on a grey sofa"}
]
```

`bbox` is `[ymin, xmin, ymax, xmax]` (top, left, bottom, right) on a 0 to 1000 grid, where 0 is the top or left edge.

---

## 🎯 Using it with MOSS-Image

- Connect `elements` to **MOSS-Image Layout Prompt**. Its `character_boxes` field uses the box numbers shown in the preview.
- Keep the layout prompt consistent with the boxes. A summary that says "no objects, no signage" works against your text and object boxes.
- If the prompt enhancer in your workflow is on, it can rewrite the prompt and drop the layout. Turn it off when the boxes must survive verbatim.

---

## 💡 Tips

- **Text at the top:** a wide, short Text box near the top, for example y 3% to 13%, x 8% to 92%.
- **Fixed result from the LLM:** use a fixed seed and a low temperature on TextGenerate. Each new answer resets the canvas.
- **Overlaps:** let boxes overlap only when one thing really sits in front of another, and put the foreground box later in the list.
- **Check the preview:** the `preview` output shows exactly what the boxes look like before you sample.

---

## 🛠️ Troubleshooting

| Problem | Fix |
|---|---|
| Nodes don't appear | Restart ComfyUI fully, then hard refresh (Ctrl+F5). The console should show `[Nougan] ✅ Bounding Boxes loaded.` and `[Nougan] ✅ Layout LLM Prompt loaded.` |
| Text isn't rendered | The box is set to **Object**. Switch it to **Text** and fill in **Text to render**. |
| Boxes come out in the wrong place | Check that `width` and `height` match the image size you generate. |
| Right-click shows the ComfyUI menu | Right-click on a box, a layer row or the canvas area, not the node title. |
| LLM output isn't turned into boxes | Check the console for `no JSON found`. Lower the temperature and make sure the system prompt reaches the LLM. |
| Canvas keeps resetting | The LLM gives a new answer every run. Fix the seed, or disconnect `bboxes` once you're happy. |
| Boxes ignored by the model | MOSS layout control is experimental. Try a simpler layout and make sure the prompt doesn't contradict the boxes. |

---

## 🔖 Notes

Node IDs are `NouganBoundingBoxes` and `NouganLayoutLLMPrompt`. Box positions are stored as 0 to 1 fractions, so they survive a change of resolution.
