> 🌀 **Nougan Suite** · [← Back to docs](README.md)

# 📋 Automagic 2222: Paste Stack

A floating clipboard-history panel for ComfyUI. Click it to save whatever you copied, click a saved card to copy it back, or drag an image card straight onto a **Load Image** node. It is not a node: there is nothing to add to your graph and nothing to wire up.

- **Saves** text, images and text files, newest first, with a delete button on every card
- **Remembers** everything across page reloads and ComfyUI restarts
- **One click** pastes text, images, screenshots and files you copied in Explorer / Finder
- **Drag and drop** an image card onto a Load Image node to upload it and load it
- **Minimizes** to a small chip with a count badge, like the [Live Panel](live-panel.md)
- **WebGPU backdrop** with a plain CSS fallback

---

## Files

| File | What it does |
|---|---|
| `web/nougan_paste_stack.js` | The panel itself (DOM + WebGPU), saving, drag-to-node |
| `web/css/nougan_paste_stack.css` | Styles |
| `nougan_paste_stack_server.py` | Small server helper so one click can paste **files** you copied in Explorer / Finder |

`__init__.py` registers the panel in `_WEB_ONLY` and the helper in `_FEATURES`. After updating, **restart ComfyUI** (not just a page refresh) so the helper loads, then hard-refresh the browser.

The startup banner should list:

```
✔ Paste Stack clipboard helper (0 nodes)
✔ Automagic 2222: Paste Stack (web extension)
```

The helper has no nodes, so `0 nodes` is expected.

---

## Using it

### Save something

| You copied | Do this |
|---|---|
| Text, or a prompt | Hover the panel and **left-click** the paste area |
| An image, or a screenshot | Hover the panel and **left-click** the paste area |
| An image or text file in Explorer / Finder | Hover the panel and **left-click** the paste area |
| Anything, any time | Hover (or click) the panel and press **Ctrl+V** |
| Files from a folder | **Drag** them onto the panel |

There is no "+" button. The dashed area at the bottom of the panel is the paste target, and so is any free space between cards. Pasting the same thing twice does not stack it twice: it moves to the top instead.

### Use something again

- **Click a card** and it goes back on your clipboard. Press **Ctrl+V** wherever you want it: a prompt box, a text widget, or the canvas.
- **Click and hold an image card, then drag** it onto a **Load Image** node. The card follows your cursor, the node under it lights up in teal, and releasing uploads the image to ComfyUI's `input` folder and loads it into the node. If the same file is already there, ComfyUI reuses it. Press **Esc** to cancel mid-drag.
- Dropping on a node that can't take an image does nothing and tells you so.

### Delete

- **×** on a card deletes that card (it appears when you hover the card).
- **Clear** in the header deletes everything. It asks you to click a second time within a couple of seconds.

### Move, resize, minimize

- Drag the header to move the panel. Drag the bottom-right corner to resize it.
- **×** in the header minimizes the panel to a small chip. The chip shows how many entries you have, pulses when something is pasted while it is minimized, and opens the panel when you click it.
- Position, size and minimized state are remembered.

---

## Which nodes accept a dropped image

Any node with an input-folder **`image`** dropdown: Load Image, Load Image (as Mask), and custom loaders that name their dropdown `image`. **Load Image (from Output)** is skipped on purpose, because it reads from the output folder instead of the input folder. Collapsed nodes are skipped too.

---

## Settings

Both are in ComfyUI **Settings**, under the Nougan Paste Stack entries.

| Setting | Default | What it does |
|---|---|---|
| Maximum saved entries | 50 (5 to 500) | When you go over, the oldest entries drop off |
| WebGPU backdrop | On | Turns the animated background on or off |

---

## Where your stack is stored

In your browser's own database (IndexedDB), as text or image copies with timestamps. The panel position, size and minimized state live in the browser's local storage. Nothing is written to your ComfyUI folders until you drag an image onto a node, and nothing is ever sent anywhere except to your own ComfyUI server.

The stack **survives** page reloads, ComfyUI restarts and switching workflows. It is **not** shared:

- **Per address.** `localhost:8188` and `127.0.0.1:8188` are different sites to a browser and each has its own stack. Pick one address and stick to it.
- **Per browser profile.** It does not sync between browsers or computers.
- **Cleared with site data.** Clearing cookies and site data for ComfyUI, or using a private window, removes it or never keeps it.

Limits per item: text up to 1,000,000 characters, images and files up to 25 MB.

---

## How one-click file paste works

Browsers can read text and image data from the clipboard on a click, but they never let a web page read **files** you copied in Explorer or Finder. That is a browser security rule, not something the panel can get around by itself.

ComfyUI's server runs on your computer, so `nougan_paste_stack_server.py` reads the clipboard for the panel. The flow on a click:

1. The panel checks the browser clipboard for text or image data.
2. If it finds none, it asks the helper for any files you copied.
3. The helper returns the files (Pillow reads the clipboard; on Windows there is a PowerShell fallback), and the panel saves them.

**Safety**

- Only requests from the same machine are answered.
- A custom header is required, so other websites in your browser can't trigger it.
- Only image and text files up to 25 MB are returned (up to 10 files, 60 MB in total), and only the files on your clipboard.
- If ComfyUI runs on a different computer than your browser, the helper returns nothing and the panel asks you to use **Ctrl+V** instead.

Endpoint, for reference: `POST /nougan/paste_stack/clipboard` with the header `X-Nougan-Paste: 1`.

---

## Limitations

- **Text, images and text files only.** Video and audio files can't be saved as previewable cards. Browsers can't put them back on the clipboard, so they are out of scope for now. A video or audio file you drop is stored as a plain file card that downloads when clicked.
- **Clicking a card can copy text and images back.** Other files can't go back on the clipboard, so clicking a file card downloads it.
- **Click-to-paste needs `localhost` or https.** On a plain `http://192.168.x.x` address the browser hides the clipboard API. Text and image pasting then needs **Ctrl+V**, while copied files still work through the helper if the browser and ComfyUI are on the same PC.
- **Ctrl+V leaves a focused text box alone.** If your cursor is in a text box elsewhere, Ctrl+V pastes there as usual. Click the panel first, or hover it with nothing focused.
- **Dragging is for a mouse or pen.** On touch screens, dragging a card scrolls the list.
- **Windows is the tested platform for copied files.** The helper uses Pillow, which reads copied files on Windows and macOS. Linux support depends on your clipboard tools.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Click says *Nothing to paste yet* after copying a file | Restart ComfyUI and check the banner for the **Paste Stack clipboard helper** line. Also check the file is an image or text file under 25 MB, and that your browser and ComfyUI are on the same PC |
| *Clipboard access is blocked* | Allow clipboard access in the address bar (the lock or tune icon), or use **Ctrl+V** while hovering |
| Text and image clicks do nothing on a LAN address | Open ComfyUI via `localhost`, or use **Ctrl+V** |
| **Ctrl+V** does nothing | Make sure no text box has focus, then hover the panel or click it once and try again |
| Dragged image doesn't light up a node | The node has no input-folder `image` dropdown, or it is collapsed. Expand it, or check the dropdown is named `image` |
| Image loaded but the preview didn't refresh | Click the node or the canvas once. If it keeps happening, report your ComfyUI frontend version |
| Stack is gone after a restart | You opened ComfyUI on a different address, a different browser or profile, a private window, or cleared site data |
| *Saving is blocked in this browser* | The browser refused IndexedDB. The stack works until you refresh. Allow site data for ComfyUI to keep it |
| Backdrop is a plain gradient | WebGPU isn't available in your browser or is turned off in the setting. Everything else works the same |
| Panel is off-screen | Resize the window slightly and it snaps back, or clear `nougan.pasteStack.ui` from your browser's local storage |

---

## Credits

Built for the Nougan Suite by Winnougan. The WebGPU backdrop is a small hand-written shader and has no external dependencies.
