> 🌀 **Nougan Suite** · [← Back to docs](README.md)

# 🃏 PNG Bakers

Two nodes that write structured JSON into an image's PNG metadata. They live in the **`image/cards`** category.

| Node | Bakes in | Read back by |
|---|---|---|
| **Nougan V2 PNG Baker 🃏** | A Character Card V2 | SillyTavern, Chub, RisuAI, Agnai and other card apps |
| **Nougan Workflow PNG Baker 🧬** | A ComfyUI workflow | ComfyUI itself (drag the PNG onto the canvas) |

Both take an `IMAGE` plus the JSON text from a **String (Multiline)** node, and both save a new PNG in the ComfyUI `output` folder. Your original file is never touched.

> ⚠️ **They are not interchangeable.** The card baker rejects a workflow, and the workflow baker rejects a character card. Each error message lists the top-level keys it received, which tells you straight away that you wired the wrong JSON.

---

## 🃏 Nougan V2 PNG Baker

Turns an image into a character card: the picture *is* the card.

### Wiring

```
Load Image ──────────► image
String (Multiline) ──► json_text      (paste the card JSON in that node)
```

`json_text` is a socket-only input. If you see *"Required input is missing: json_text"*, the String node isn't connected.

### Inputs and outputs

| Name | Type | Notes |
|---|---|---|
| `image` | IMAGE | Any image. JPEG/WebP are fine because Load Image decodes them first. |
| `json_text` | STRING | The card JSON. See [accepted JSON](#accepted-json) below. |
| `filename_prefix` | STRING | Default `V2_cards/%name%`. `%name%` becomes the character's name (unsafe characters replaced, 80 characters max). Saved in the ComfyUI output folder. |
| `fill_missing_fields` | BOOLEAN | **On** (default): missing V2 fields get empty defaults. **Off**: the JSON is kept exactly as pasted. |
| → `saved_path` | STRING | Path of the saved PNG (one per line for a batch). |
| → `character_name` | STRING | `data.name` of the card. |

### What gets written

A PNG `tEXt` chunk with keyword `chara`, whose value is `base64( UTF-8 JSON )`:

```json
{"spec": "chara_card_v2", "spec_version": "2.0", "data": { "name": "...", "...": "..." }}
```

This is the same layout real V2 cards use. After saving, the node **reads the PNG back from disk and decodes the card**. If it doesn't match what was baked, the node errors instead of reporting success.

For an image batch, every image gets the same card and the filename counter increments.

### Accepted JSON

The only hard requirement is a non-empty `data.name`. The node accepts what people actually paste:

| You paste | What happens |
|---|---|
| A full V2 card (`spec` + `data`) | Used as is |
| A V3 card (`chara_card_v3`) | Relabelled as V2. V3-only fields stay in `data`; older apps ignore them |
| Just the fields (`name`, `description`, `first_mes`, `personality`...) | Wrapped into a V2 card |
| `` ```json `` fences, a BOM, stray whitespace | Stripped |
| A card nested under `character`, `card`, `char`, `result`, `output`, `json`, or any single key | Unwrapped |
| A one-item list | Unwrapped |
| JSON that was encoded twice, or `data` stored as a string | Parsed |
| Capitalized keys (`Name`, `Description`) | Lowercased (top level and inside `data` only) |
| Old TavernAI keys | Converted (table below) |

Unknown keys such as `avatar`, `character_book` and `extensions` are preserved untouched. Every automatic repair is printed in the console and the first one is shown on the node's status line.

**Legacy key conversion**

| Old key | V2 field |
|---|---|
| `char_name` | `name` |
| `char_persona` | `description` |
| `world_scenario` | `scenario` |
| `char_greeting` | `first_mes` |
| `example_dialogue` | `mes_example` |

**Light type repair** (so card apps don't choke): non-string text fields become strings, a comma-separated `tags` string becomes a list, a single `alternate_greetings` string becomes a one-item list, and a non-object `extensions` becomes `{}`.

**Defaults added when `fill_missing_fields` is on:** `name`, `description`, `personality`, `scenario`, `first_mes`, `mes_example`, `creator_notes`, `system_prompt`, `post_history_instructions`, `creator`, `character_version` (all empty), `alternate_greetings` and `tags` (empty lists), `extensions` (empty object).

### The holographic preview

The node shows the card it just baked:

- **Tilt and foil.** The card follows your mouse, with a rainbow sheen and glare.
- **Flip.** Click the card or the **Flip card** button to see the description and first message on the back.
- **Download PNG** saves the baked file from the node.
- **Bake animation.** A forge glow while it runs, then a shockwave, embers and a "BAKED ✓" stamp.
- **Rarity** (common → rare → epic → legendary) is *just for fun*, from the card's estimated size at about 4 characters per token: under 600 tokens is common, under 1800 rare, under 3500 epic, above that legendary. Lorebook entries and alternate greetings count.
- The meters show the length of the description, first message and examples.

The preview respects your browser's *reduce motion* setting and pauses when off-screen.

The workflow remembers the last bake so the preview survives a reload. It stores the name, creator, tags and size stats, but **not** the description or first-message text, so sharing a workflow doesn't leak card text. The node can't be made narrower than 330 px, which is the width the card is laid out for.

### Troubleshooting

| Message | Cause and fix |
|---|---|
| `json_text is empty` | The String node has no text. Paste the card JSON into it. |
| `Invalid JSON: ... (line N, column M)` | A syntax error. The message shows the text near the problem. |
| `This doesn't look like a character card ... Top-level keys received: [...]` | The JSON isn't a card. Read the key list: `nodes`, `links` means you pasted a ComfyUI workflow (use the Workflow PNG Baker); `error`, `message` usually means an upstream LLM node returned an error instead of a card. |
| `The card has no 'name'` | V2 requires `data.name`. |
| `The JSON must be an object` | After unwrapping, it's still a list or a bare value. |
| `Verification failed ... did not round-trip` | The saved PNG didn't hold the card correctly. Check disk space and permissions on the output folder. |

> 💡 Many sites (Discord, image hosts, some social platforms) recompress uploads and strip PNG metadata. If a card app says the image has no card, share the PNG as a file download rather than an inline upload.

---

## 🧬 Nougan Workflow PNG Baker

Embeds a ComfyUI workflow into **any image** (JPEG, WebP, PNG...) and saves it as a PNG that ComfyUI opens as that workflow. JPEG and WebP can't carry a ComfyUI workflow, so the node re-saves the picture as a PNG.

### Wiring

```
Load Image (jpeg / webp / png) ──► image
String (Multiline) ─────────────► json_text      (paste the workflow JSON in that node)
```

### Inputs and outputs

| Name | Type | Notes |
|---|---|---|
| `image` | IMAGE | The picture to carry the workflow. |
| `json_text` | STRING | The workflow JSON. See below. |
| `filename_prefix` | STRING | Default `Workflow_PNG/workflow`. Saved in the ComfyUI output folder. Each path part is sanitized and `..` is dropped, so it can't write outside `output`. |
| → `saved_path` | STRING | Path of the saved PNG (one per line for a batch). |

The saved image shows in the node's normal image preview.

### Accepted JSON

| You paste | Stored as |
|---|---|
| A workflow save file (has `nodes` and `links`) | PNG chunk `workflow` |
| An API-format export (every entry has a `class_type`) | PNG chunk `prompt` |
| `{"workflow": {...}, "prompt": {...}}` | Both chunks |

Code fences, a BOM and double-encoded JSON are cleaned up the same way as in the card baker.

### How it works

ComfyUI's own Save Image stores a graph in two PNG `tEXt` chunks, `workflow` and `prompt`. When you drag a PNG onto the canvas, ComfyUI looks for them and rebuilds the graph. This node writes the same chunks into any image you give it.

- The JSON is written with plain `json.dumps`, exactly like Save Image, so it's ASCII-safe even if node titles contain emoji.
- After saving, the node reopens the PNG and checks the stored JSON equals what you provided.
- The PNG is built from the decoded pixels, so metadata from the source file (EXIF and similar) is not carried over.
- A PNG is usually larger than the JPEG or WebP it came from.
- For an image batch, every image gets the same workflow.

### Using the result

Drag the saved PNG onto the ComfyUI canvas and the workflow opens. If you only stored an **API export**, ComfyUI rebuilds the graph from it, but API format has no node positions, groups or titles, so expect an auto-arranged layout. For a faithful copy, paste the regular workflow save file.

### Troubleshooting

| Message | Cause and fix |
|---|---|
| `json_text is empty` | The String node has no text. |
| `Invalid JSON: ...` | A syntax error in the pasted workflow. |
| `This doesn't look like a ComfyUI workflow ... Top-level keys received: [...]` | You pasted something else, such as a character card (use the V2 PNG Baker) or an LLM reply. |
| `Required input is missing: json_text` | Connect the String (Multiline) node to `json_text`. |
| `Verification failed ... did not round-trip` | The saved PNG didn't keep the data. Check disk space and permissions on the output folder. |

> 💡 Platforms that recompress images will strip the workflow. Share the PNG as a file, and test by dropping the downloaded copy back onto ComfyUI.

---

## 🧭 Which one do I need?

| I want to... | Use |
|---|---|
| Make an image that SillyTavern or Chub imports as a character | **V2 PNG Baker 🃏** |
| Hide or attach a ComfyUI workflow in a JPEG/WebP/PNG | **Workflow PNG Baker 🧬** |
| Read a workflow back out of an image | Drag it onto ComfyUI, no node needed |
