> 🌀 **Nougan Suite** · [← Back to docs](README.md)

# 💬 Character Chat

Chat with SillyTavern-style character cards **inside ComfyUI**, using the same LLM you already load as a text encoder. No external server, no API keys. Load a card, type a message, and the character answers right on the node.

The node is built and tested around **Qwen3.5** (for example `qwen3.5_9b`), run through ComfyUI's text-generation API, the same one the core "Generate Text" node uses.

---

## Features

- **Character Card V1 / V2 / V3** support, as `.png` (card data embedded in the image) or `.json`
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
- At least one character card (see [Where to get character cards](#where-to-get-character-cards))

> **Note:** The prompt is built in Qwen's ChatML format (`<|im_start|>` / `<|im_end|>`). Other model families may not follow it correctly.

---

## Installation

The node is part of the Nougan custom node pack. Make sure these files are in place:

| File | Location |
|---|---|
| `nougan_character_chat.py` | Root of the node pack folder |
| `nougan-character-chat-ui.js` | The pack's `web/` folder |
| `__init__.py` | Root of the node pack folder (already registers the node) |

Then restart ComfyUI. You should see this in the console:

```
[Nougan] ✅ Character Chat loaded.
```

The node appears under **Nougan → Nougan Character Chat 💬**.

---

## Quick start

1. Add a **Load CLIP** node and select your Qwen3.5 model (type: `stable_diffusion`).
2. Add **Nougan Character Chat 💬** and connect the CLIP output to its `clip` input.
3. Click **⬆ Card** on the node and upload a character card PNG or JSON.
4. The character's greeting appears in the chat panel.
5. Type a message and press **Enter** (or click **Send**).
6. Optional: connect `reply` to a **Preview Any** node and `avatar` to a **Preview Image** node.

An example workflow, `Winnougan_Chatbot_Silly.json`, is included. Drag it into ComfyUI to see the full setup.

---

## Using the chat panel

| Control | What it does |
|---|---|
| **⬆ Card** | Upload a `.png` or `.json` card into `ComfyUI/input/characters/` |
| **↻** | Refresh the card list (use it after adding cards manually) |
| **⚙** | Show or hide the sampling settings |
| **Enter / Send** | Send your message (`Shift+Enter` adds a new line) |
| **✎ / ⟳ / ✕** | Hover over a message to edit it, regenerate it (last reply only), or delete it |
| **‹ ›** | Swipe between alternate greetings (only before you've sent anything) |
| **⟲ New chat** | Restart from the greeting (click twice to confirm) |
| **⎘ Copy chat** | Copy the whole conversation as plain text |

**Good to know**

- Each message you send **queues the workflow**. Don't mute or bypass the chat node, or nothing will generate.
- If generation fails or is interrupted, your message is put back in the input box so nothing is lost.
- Picking a different character **starts a new chat** with that character's greeting.
- Edits you make to messages are included in the context the model sees on the next turn.

---

## Node inputs

### Main settings

| Input | Default | Description |
|---|---|---|
| `clip` | | The loaded LLM (Qwen3.5 via Load CLIP) |
| `character` | | Card to chat with, from `ComfyUI/input/characters/` |
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
| `card_path` | empty | Full path to a card anywhere on disk. **Overrides the dropdown** |

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
| `avatar` | IMAGE | The card's PNG image (a dark placeholder for `.json` cards) |
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

## How it works

For each reply, the node builds a single prompt from the card:

1. The card's **system prompt** (or a sensible default roleplay instruction)
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
| **"No character loaded"** | Pick a card in the `character` dropdown or upload one with ⬆ Card. Press ↻ if you added files manually. |
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
