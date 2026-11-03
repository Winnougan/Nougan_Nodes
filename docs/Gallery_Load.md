# Nougan Gallery Load 🗂️

Browse a folder as a thumbnail gallery, click the images you want, and get one `IMAGE` output per pick: **P1, P2, P3…**

**Add it:** double-click the canvas and search `Nougan Gallery`, or right-click → Add Node → **Nougan** → **Nougan Gallery Load 🗂️**.

---

## Quick start

1. **Choose a folder.** Paste a path into the `folder` field, or click **📂** in the footer to browse.
2. **Pick images.** Click the ones you want. They jump to the top of the gallery, highlighted, with a **P1, P2…** badge.
3. **Wire them up.** An output appears on the node for every selected image. Connect P1, P2… to whatever you like.

A new node starts with no outputs. They appear as you select.

---

## Controls

| Action | What it does |
|---|---|
| **Click** an image | Add it to the selection (next P number) |
| **Click** a selected image | Deselect it |
| **Drag a rectangle** | Add every image the box touches |
| **✕** (top-right of a selected image) | Deselect that image |
| **Shift + click** a selected image | Mark it (amber) for batch removal |
| **Shift + drag** over selected images | Mark them (amber); unselected ones inside the box are added |
| **Right-click** a selected image | Menu → **Remove** (removes all marked images if it's one of them) |
| **Clear** (footer) | Deselect everything |
| **🔄** (footer) | Re-scan the folder |
| **Bottom slider** | Thumbnail size (bigger / smaller) |
| **Right-hand bar** or **mouse wheel** | Scroll up and down |
| **Ctrl + mouse wheel** | Thumbnail size |

Selecting always scrolls the gallery back to the top so you can see your pinned picks. Removing images keeps your scroll position.

---

## Good to know

- **Sizing:** drag the node's corner to make it as large as you want. The thumbnails refit to the box, so there's no sideways scrolling. Smaller thumbnails fit more per row, and the largest size is capped by the box.
- **Output order:** P1 is the first image you picked, not the first in the grid. If you deselect an image, the ones after it renumber, and wires stay on their slot number (so a wire on P2 will receive what was P3).
- **Limit:** up to **64** images per node.
- **Saved with your workflow:** the folder, your selection and the thumbnail size all come back when you reload a workflow.
- **Moved or deleted files:** the footer shows a ⚠ missing count, and the run stops with an error naming the missing file.
- **Formats:** PNG, JPG, WEBP, BMP, GIF (first frame), TIFF. Images load as RGB, so transparency is dropped.
- **Re-runs:** the node only re-executes when the folder, the selection, or a selected file's modified time changes. Changing the thumbnail size doesn't trigger a run.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Node isn't in the menu | Check the startup console for the `Gallery Load` line and any error beside it. Restart ComfyUI. |
| Old look / old behavior after updating | Hard-refresh the browser with **Ctrl + F5** (the JS and CSS are cached). |
| "Folder not found" | Check the path. Quotes around a pasted path are fine. |
| Thumbnails won't load from another PC | The gallery only serves local requests. Set the environment variable `NOUGAN_GALLERY_ALLOW_REMOTE=1` before starting ComfyUI. |
| Plain dark backdrop instead of the animated one | Your browser has no WebGPU. Everything else works the same. |

Thumbnails are cached on disk in a `nougan_gallery_thumbs` folder (inside ComfyUI's user folder, or the temp folder on older versions). It's safe to delete.
