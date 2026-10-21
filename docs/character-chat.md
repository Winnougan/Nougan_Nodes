> 🌀 **Nougan Suite** · [← Back to docs](README.md)

# 💬 Character Chat

Chat with SillyTavern-style character cards **inside ComfyUI**, using the same LLM you already load as a text encoder. No external server, no API keys. Load a card, type a message, and the character answers right on the node.

Characters can come from a **card PNG**, a **card JSON**, or a **refmod** (a `.safetensors` file with the character baked into its header). It's the same node for all three.

The node is built and tested around **Qwen3.5** (for example `qwen3.5_9b`), run through ComfyUI's text-generation API, the same one the core "Generate Text" node uses.

---

## Features

- **Character Card V1 / V2 / V3** support, as `.png` (card data embedded in the image) or `.json`
- **Refmod characters**: load a character baked into a `.safetensors` refmod, avatar and system prompt included (see [Using refmods](#using-refmods))
- **Built-in chat panel** with avatars, roleplay formatting (`*actions*` in italics, `**bold**`), and a scrollable history
- **Edit, delete, and regenerate** any message
- **Alternate greetings** that you can swipe through before the chat starts
- **Lorebook / World Info** support, including keyword, regex, constant, and secondary-key entries
- **`{{char}}` / `{{user}}` substitution** (also `<BOT>` / `<USER>`)
- **Optional thinking mode** where the model reasons first and the reasoning is hidden
- **Chat is saved with your workflow**, so you can close ComfyUI and pick up where you left off
- **Outputs** (reply, full log, avatar image, and more) that you can wire into the rest of your graph

---

## Requirements

- A recent ComfyUI with the text-generation API (`clip.tokenize` / `clip.generate` / `clip.decode`)
- A **Qwen3.5** LLM in your `models/text_encoders` folder, loaded with a **Load CLIP** node
- At least one character card (see [Where to get character cards](#where-to-get-character-cards)) or a refmod with a baked character (see [Using refmods](#using-refmods))

> **Note:** The prompt is built in Qwen's ChatML format (`<|im_start|>` / `<|im_end|>`). Other model families may not follow it correctly.

---

## Installation

The node is part of the Nougan custom node pack. Make sure these files are in place:

| File | Location |
|---|---|
| `nougan_character_chat.py` | Root of the node pack folder |
| `nougan_refmod_io.py` | Root of the node pack folder (**required**: the chat node imports it to read refmods) |
| `nougan-character-chat-ui.js` | The pack's `web/` folder |
| `__init__.py` | Root of the node pack folder (already registers the node) |

To *make* refmod characters you also need `nougan_refmod_baker.py` (root folder) and, for its card preview, `nougan_v2_png_baker.js` (`web/` folder). See [PNG Bakers 🃏](png-bakers.md).

Then restart ComfyUI. You should see this in the console:

```
[Nougan] ✅ Character Chat loaded.
```

The node appears under **Nougan → Nougan Character Chat 💬**.

---

## Quick start

1. Add a **Load CLIP** node and select your Qwen3.5 model (type: `stable_diffusion`).
2. Add **Nougan Character Chat 💬** and connect the CLIP output to its `clip` input.
3. Click **⬆ Card** on the node and upload a character card PNG or JSON. (Using a refmod instead? See [Using refmods](#using-refmods).)
4. The character's greeting appears in the chat panel.
5. Type a message and press **Enter** (or click **Send**).
6. Optional: connect `reply` to a **Preview Any** node and `avatar` to a **Preview Image** node.

An example workflow, `Winnougan_Chatbot_Silly.json`, is included. Drag it into ComfyUI to see the full setup.

---

## Using the chat panel

| Control | What it does |
|---|---|
| **⬆ Card** | Upload a `.png` or `.json` card, or a `.safetensors` refmod, into `ComfyUI/input/characters/` |
| **↻** | Refresh the card and refmod list (use it after adding files manually) |
| **⚙** | Show or hide the sampling settings (this is also where `card_path` lives) |
| **Enter / Send** | Send your message (`Shift+Enter` adds a new line) |
| **✎ / ⟳ / ✕** | Hover over a message to edit it, regenerate it (last reply only), or delete it |
| **‹ ›** | Swipe between alternate greetings (only before you've sent anything) |
| **⟲ New chat** | Restart from the greeting (click twice to confirm) |
| **⎘ Copy chat** | Copy the whole conversation as plain text |

**Good to know**

- Each message you send **queues the workflow**. Don't mute or bypass the chat node, or nothing will generate.
- If generation fails or is interrupted, your message is put back in the input box so nothing is lost.
- Picking a different character **starts a new chat** with that character's greeting.
- If `card_path` is filled in, it **overrides the dropdown**. Clear it to go back to the dropdown.
- Characters loaded from a refmod show a **🧬 refmod** label under the name in the panel header.
- Edits you make to messages are included in the context the model sees on the next turn.

---

## Node inputs

### Main settings

| Input | Default | Description |
|---|---|---|
| `clip` | | The loaded LLM (Qwen3.5 via Load CLIP) |
| `character` | | Card to chat with, from `ComfyUI/input/characters/`, or a refmod with a baked character (listed as `refmod:<name>`) |
| `user_name` | `User` | Fills in `{{user}}` in the card and labels your lines in the log |

### Sampling settings (click ⚙ to show)

| Input | Default | Description |
|---|---|---|
| `max_length` | 400 | Max tokens per reply |
| `temperature` | 0.8 | Higher is more creative, lower is more predictable |
| `top_p` | 0.95 | Nucleus sampling |
| `top_k` | 64 | Only sample from the top K tokens (0 = off) |
| `min_p` | 0.05 | Drops very unlikely tokens |
| `repetition_penalty` | 1.05 | Raise slightly if the character loops |
| `presence_penalty` | 0.0 | Penalises any token that has already appeared. Raise a little to push toward new topics (range -2 to 2) |
| `seed` | random | Set to `randomize` for varied replies, or fix it for repeatable ones |
| `thinking` | false | `true` / `false` toggle. Lets the model reason before replying. Slower, and the reasoning is discarded |
| `mtp` | auto | Speculative decoding using the model's multi-token-prediction head: `auto`, `off`, or `2`-`5` to pin the draft depth. No effect if your checkpoint has no MTP weights |
| `context_messages` | 40 | How many recent messages are sent to the model |
| `card_path` | empty | Full path to a card (`.png` / `.json`) or a refmod (`.safetensors`) anywhere on disk. **Overrides the dropdown** |

### Internal inputs (hidden)

`action`, `user_message`, and `history_json` are managed by the chat panel. You don't need to touch them. `history_json` is how the conversation is saved with your workflow.

---

## Node outputs

| Output | Type | Description |
|---|---|---|
| `reply` | STRING | The character's latest message |
| `chat_log` | STRING | Whole conversation as `Name: message` text |
| `character_name` | STRING | Name from the card |
| `description` | STRING | The card's description, with `{{char}}` / `{{user}}` filled in |
| `avatar` | IMAGE | The card's PNG image, or the avatar baked into a refmod (a dark placeholder for `.json` cards) |
| `history_json` | STRING | Raw conversation history as JSON |

These make it easy to feed a character's reply into other nodes, for example turning the `reply` or `description` into an image prompt, or showing the `avatar` in a preview.

---

## Where to get character cards

Head over to **[Botbooru](https://botbooru.com/)** to browse and download a wide selection of ready-made character cards.

1. Visit [botbooru.com](https://botbooru.com/)
2. Browse or search for a character you like
3. Download the card (PNG or JSON)
4. Upload it with **⬆ Card** on the node, or drop it into `ComfyUI/input/characters/`

> **Tip:** Check each card's description and tags before downloading so you know what to expect from the character.

Cards from any SillyTavern-compatible source will also work. To make your own, see [PNG Bakers 🃏](png-bakers.md).

---

## Using refmods

A **refmod** is a `.safetensors` file. Besides its model data, the file has a small text header, and the **Nougan Refmod Baker** stores a character in that header: the card JSON, an optional system prompt, and an avatar. The chat node reads only that header, so loading a character is instant even if the file is gigabytes. The model data is never touched.

There are two kinds of baked file:

- **Character-only**: a tiny file with just the character. Good for chat, but a video model can't use it as a reference.
- **Hybrid**: a copy of a real refmod with the character added. One file works as a reference for your video model *and* as a chat character.

Make them with the Refmod Baker (see [PNG Bakers 🃏](png-bakers.md)). It saves to `ComfyUI/output/Refmods/` and never modifies the original refmod.

### Loading a refmod

Pick one of these:

1. **`card_path`**: click **⚙**, paste the full path to the `.safetensors` file (for example `C:\ComfyUI\output\Refmods\Adele_00001_.safetensors`). Works immediately, no restart.
2. **Dropdown**: put the file in a refmod folder, press **↻**, and choose `refmod:<name>`. Refmod folders are checked in this order:
   1. the `NOUGAN_REFMOD_DIR` environment variable (several folders separated by `;` on Windows)
   2. any ComfyUI folder registered as `refmod`, `refmods`, `h3_refmod`, `minimax_refmod`, `reference` or `references`
   3. `ComfyUI/models/refmods`
3. **⬆ Card**: upload the `.safetensors` file. Fine for small character-only files; for large hybrids, use option 1 or 2 instead.

Only refmods that actually have a character baked in appear in the dropdown. Plain refmods are skipped.

### What comes from the refmod

- **Avatar**: the image you gave the baker (shown in the panel and on the `avatar` output).
- **System prompt**: if you gave the baker one, it replaces the card's own system prompt. Priority, highest first: the node's `system_prompt` input, then the refmod's stored prompt, then the card's own, then the built-in default.
- Everything else (description, personality, scenario, lorebook, examples, greetings) comes from the card JSON stored in the file, exactly as with a PNG card.

---

## How it works

For each reply, the node builds a single prompt from the card:

1. The **system prompt**: the `system_prompt` input if connected, else the refmod's stored prompt, else the card's own (or a sensible default roleplay instruction)
2. **Description**, **personality**, and **scenario**
3. Triggered **lorebook entries**, matched against the last few messages
4. **Example dialogue** (used for voice and style only)
5. **Post-history instructions**
6. The most recent `context_messages` of your chat

That prompt is sent to the loaded LLM, and the reply is cleaned of any thinking tags or leaked chat markers before it appears.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| **"No character loaded"** | Pick a card or refmod in the `character` dropdown or upload one with ⬆ Card. Press ↻ if you added files manually. |
| **Dropdown changes nothing** | `card_path` is probably still filled in and overrides the dropdown. Click ⚙ and clear it. |
| **Refmod isn't in the dropdown** | It must be in a refmod folder (see [Using refmods](#using-refmods)) and have a character baked in. Press ↻. Or paste its full path into `card_path`. |
| **"has no embedded character"** | That refmod was never baked with a character. Run it through the Refmod Baker. |
| **"is not a valid safetensors file"** | The file is damaged, incomplete, or isn't really a `.safetensors`. Re-copy or re-bake it. |
| **Chat node missing after an update** | The chat node now imports `nougan_refmod_io.py`. Make sure it sits next to `nougan_character_chat.py`, then restart ComfyUI. |
| **Dropdown says "(none - add cards to input/characters)"** | No cards found yet. Upload one or place it in `ComfyUI/input/characters/`. |
| **"has no 'chara' / 'ccv3' text chunk"** | The PNG isn't a character card (or a re-saved copy lost its metadata). Download the original card again. |
| **"The chat node didn't run"** | The node is muted or bypassed. Enable it and try again. |
| **Nothing appears or the node has no chat panel** | Check that `nougan-character-chat-ui.js` is in the `web/` folder, then restart ComfyUI and hard-refresh the browser (`Ctrl+F5`). |
| **Replies are cut off** | Increase `max_length`. |
| **Character repeats itself** | Raise `repetition_penalty` slightly (e.g. 1.1) or `temperature`. |
| **Character forgets earlier events** | Raise `context_messages`, keeping in mind it uses more memory and is slower. |
| **Replies are slow** | Turn off `thinking` and lower `max_length`. |

---

## Credits

Part of the **Nougan Suite** by Winnougan. [← Back to docs](README.md)