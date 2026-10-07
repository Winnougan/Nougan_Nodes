> 🌀 **Nougan Suite** · [← Back to docs](README.md)

# 📂 Dataset Captioning

Caption a whole folder of images with one press of **Run**, and save each caption as a `.txt` file named after its image (`044.jpeg` → `044.txt`). Built for LoRA dataset prep.

| Node | Display name | Category |
|---|---|---|
| `FolderImageBatchLoader` | Nougan Load Image Batch From Folder 📂 | `image/batch` |
| `SaveCaptionMatchImage` | Nougan Save Caption (Match Image Name) 💾 | `image/batch` |

Both ship with Nougan Nodes, so there's nothing extra to install.

---

## 🚀 Quick start

```
[Load Image Batch From Folder] ──image──▶ [your captioner, e.g. TextGenerate] ──generated_text──▶ [Save Caption] ◀──path── [Load Image Batch From Folder]
```

1. Add **Nougan Load Image Batch From Folder 📂**.
2. Set `folder_path` to your dataset folder. Pasting a Windows "Copy as path" (with quotes) is fine.
3. Connect `image` to your captioning node (any node that takes an `IMAGE` and outputs a `STRING`, such as ComfyUI's `TextGenerate`).
4. Add **Nougan Save Caption (Match Image Name) 💾**.
5. Connect the captioner's text output to `text`.
6. Connect the loader's **`path`** output to `image_path`.
7. Press **Run**. It captions every image in the folder, one at a time, then stops.

> ⚠️ Wire `path`, not `filename`. `path` carries the folder, which is what lets the caption land next to the image.

---

## 📂 Load Image Batch From Folder

Loads one image per run from a folder, in order, with a live preview.

### Inputs

| Input | Description |
|---|---|
| `folder_path` | Folder containing the images. Quotes and `%ENV%` / `~` are handled. Subfolders are **not** scanned. |
| `sort_mode` | **numeric**: natural order (`001, 002, 2, 010, 10`, `img2` before `img10`). **alphabetical**: plain case-insensitive A→Z. |
| `index` | Which image to load (0 = first). With auto-run on, this advances by itself. |
| `auto_run_folder` | **run whole folder**: after each successful run, queues the next image until the last one. **single image**: runs once on the current `index`. |

### Outputs

| Output | Type | Description |
|---|---|---|
| `image` | IMAGE | The loaded image (EXIF rotation applied). |
| `mask` | MASK | Inverted alpha (same convention as core Load Image). All zeros if the image has no alpha. |
| `filename` | STRING | File name without folder or extension (`044`). |
| `path` | STRING | Full path of the file. |
| `index` | INT | Index of the image just loaded. |
| `total` | INT | Number of images in the folder. |

### Behavior

- **Formats:** png, jpg, jpeg, jfif, webp, bmp, tif, tiff, gif (first frame only).
- **Preview:** shown on the node and scales when you resize it. It's a downscaled temp copy (max 1024 px), so your originals are never touched.
- **Whole-folder run:** when the last image finishes, `index` resets to 0, so the next Run starts from the top.
- **Stopping:** Cancel/Interrupt or any error stops the chain. Press Run again to continue from the current `index`.
- **Starting mid-folder:** set `index` to where you want to begin.
- **Out-of-range index:** wraps around instead of erroring.
- **Batch count:** leave the queue's batch count at **1**. The node does its own looping.

---

## 💾 Save Caption (Match Image Name)

Writes text to a file named after the image that was just loaded.

### Inputs

| Input | Description |
|---|---|
| `text` | The caption (connect from your captioner). |
| `image_path` | Connect the loader's **`path`** output. The file name comes from here. |
| `save_location` | **next to image** writes into the image's own folder. **custom folder** writes to `custom_folder` instead. |
| `custom_folder` | Used only when `save_location` is *custom folder*. Created if it doesn't exist. |
| `extension` | Defaults to `txt`. A leading dot is fine (`.caption`). |
| `overwrite` | **overwrite existing** replaces files. **skip if exists** leaves existing captions alone (see tips). |

### Output

| Output | Type | Description |
|---|---|---|
| `saved_path` | STRING | Full path of the file written (or the one that was skipped). |

### Behavior

- Text is whitespace-stripped and saved as UTF-8 with no trailing newline.
- The node never caches, so it writes on every run.
- The caption and the file name always come from the same run, so they can't drift out of sync.

---

## 💡 Tips

- **Resume a half-captioned folder:** set `overwrite` to **skip if exists**. Existing captions are kept. The VLM still runs on those images, so to skip the compute too, set `index` to where you left off.
- **Keep captions out of your dataset folder while testing:** use `save_location` → **custom folder**.
- **Check your trigger word first:** run a single image (`auto_run_folder` → **single image**) and read the caption before committing to the whole folder.

---

## 🛠️ Troubleshooting

| Problem | Fix |
|---|---|
| Nodes don't appear | Restart ComfyUI fully, then hard refresh (Ctrl+F5). The console should show `[Nougan] ✅ Folder Batch Loader + Save Caption loaded (2 nodes).` |
| Captions one image, then stops | The auto-run needs the `web/nougan_folder_batch.js` extension loaded. Hard refresh, and make sure the file sits at the top level of `web/`. |
| Queues each image twice | An old standalone copy of the loader is still in `custom_nodes`. Delete it and restart. |
| `Folder not found` / `No images found` | Check the path, and note subfolders aren't scanned. |
| Caption files have the wrong name | `image_path` isn't connected to the loader's `path` output. |
| Preview is blank before the first run | Normal. The preview appears once the node has executed. |

---

## 🔖 Notes

Node IDs are `FolderImageBatchLoader` and `SaveCaptionMatchImage`, kept short and unprefixed so workflows built with the standalone version load without missing-node errors.
