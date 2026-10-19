> 🌀 **Nougan Suite** · [← Back to docs](README.md)

# 💎 Image Converter / Saver

Save or convert images in any common format, and let **Smart Squeeze** find the smallest file that still looks the way it should. Use it as a Save Image node, or point it at a file or folder and convert what's there.

| Node | Display name | Category |
|---|---|---|
| `NouganImageConverter` | Nougan Image Converter / Saver 💎 | `Nougan/Image` |

It ships with Nougan Nodes, so there's nothing extra to install. For an extra lossless PNG pass, see [Optional extras](#-optional-extras).

---

## 🚀 Quick start

```
[Any IMAGE output] ──images──▶ [Nougan Image Converter / Saver]
```

1. Add **Nougan Image Converter / Saver 💎**.
2. Connect an `IMAGE` to `images`.
3. Pick a `format`, leave **Smart Squeeze** on, and set `quality_scale` (8 is a good start).
4. Press **Run**. The node saves the file and shows the sizes on its panel.

**To convert existing files instead:** leave `images` empty and put a file or folder path in `load_path`.

---

## ⚙️ Inputs

| Input | Description |
|---|---|
| `filename_prefix` | Folder and name inside the output directory, for example `Nougan/shots`. |
| `format` | png, webp, jpeg, jpg, tiff, bmp, gif. avif appears only if your Pillow build can write it. |
| `smart_squeeze` | **On:** finds the smallest file that still meets the quality tier. **Off:** a normal export. |
| `quality_scale` | A slider from 5 to 10. See [Quality scale](#-quality-scale). |
| `embed_workflow` | **Embed workflow** stores the ComfyUI workflow in the file. **Strip metadata** leaves it out. |
| `save_mode` | **save to output** writes to your output folder. **preview only** writes temporary files. |
| `images` | Optional. The images to save. |
| `load_path` | Optional. A file or a folder to load when no image is connected. Quotes are fine. Subfolders are not scanned. |

If an image is connected, it wins over `load_path`.

## 📤 Outputs

| Output | Type | Description |
|---|---|---|
| `images` | IMAGE | The images passed through, or the loaded images (resized to the first one if their sizes differ). |
| `file_paths` | STRING | Full path of each saved file, one per line. |
| `report` | STRING | File name, size, savings against a standard export, and the settings used. |

---

## 🎚️ Quality scale

With Smart Squeeze on, the scale picks a similarity target. The node compares the compressed result to the original and keeps the smallest file that reaches the target.

| Scale | Tier | Similarity target |
|---|---|---|
| 5 | Compact | 0.930 |
| 6 | Lean | 0.950 |
| 7 | Balanced | 0.965 |
| 8 | Crisp | 0.975 |
| 9 | Fine | 0.985 |
| 10 | Pristine | 0.995 |

With Smart Squeeze off, the scale sets a plain quality: 75, 82, 88, 92, 96 and 100 for scales 5 to 10.

---

## 🧠 What Smart Squeeze does

| Format | Behavior |
|---|---|
| **PNG** | Always pixel-perfect. Drops an unused alpha channel, turns gray images into single-channel, converts images with 256 colors or fewer to a palette, then compresses at the maximum level. |
| **TIFF** | Always lossless. Same mode reduction, then picks the smaller of deflate and LZW. |
| **BMP** | Always lossless. Uses a smaller mode (gray or palette) when the image allows it. |
| **JPEG / JPG** | Searches for the lowest quality that reaches the target. Tries both 4:2:0 and 4:4:4 chroma subsampling and keeps the smaller file. Uses optimized, progressive encoding. |
| **WebP** | Searches for the lowest lossy quality that reaches the target, also tries true lossless, and keeps the smaller one. |
| **AVIF** | Same search as JPEG, with 4:4:4 color. |
| **GIF** | Uses an exact palette when the image has 256 colors or fewer, otherwise a 256-color version. This format is lossy for photos. |

For PNG, TIFF and BMP the output is always lossless, so the scale only sets how hard the optimizer works.

**Very grainy images** can't reach the higher tiers without a huge file. In that case the node falls back to a high-quality setting (about q95) and labels the result **best effort (grainy)** on the panel.

---

## 🖼️ The panel

The node shows a live panel under its widgets:

- **Format pill:** the current format, in its own color.
- **Tier meter:** six segments, with the active tier marked.
- **Summary:** total saved against a standard export (PNG level 4, JPEG q95, WebP q90).
- **One card per image:** before and after size, a savings bar, dimensions, a similarity score (or **bit-exact**), and the quality used.

The panel fills in after each run.

---

## 💡 Tips

- **Photos for the web:** WebP or JPEG at scale 6 to 8 is a good balance.
- **Graphics, screenshots, flat art:** PNG or lossless WebP. Smart Squeeze often shrinks these a lot.
- **Archiving:** PNG, or WebP at scale 10.
- **Strip metadata** before sharing files publicly if you don't want your workflow embedded.
- **Preview without saving:** set `save_mode` to **preview only**.
- **Batch convert a folder:** put the folder in `load_path` and leave `images` empty.

---

## ➕ Optional extras

For an extra lossless PNG pass, install `pyoxipng`:

```
pip install pyoxipng
```

The node uses it automatically when present. At scale 10 it uses the strongest (zopfli) setting.

---

## 🛠️ Troubleshooting

| Problem | Fix |
|---|---|
| Node doesn't appear | Restart ComfyUI fully, then hard refresh (Ctrl+F5). The console should show `[Nougan] ✅ Image Converter loaded.` |
| Panel is missing or empty | Check that `web/nougan_image_converter.js` is in the `web` folder, then hard refresh. The panel fills in after the first run. |
| `Connect an image or set load_path` | Neither input is set. Connect `images` or fill in `load_path`. |
| `No images found at:` | Check the path. Subfolders aren't scanned. |
| TIFF shows no preview in the UI | Browsers can't display TIFF. The file is still saved. |
| Transparent areas turn white | JPEG, BMP and GIF can't store transparency. Use PNG or WebP. |
| Workflow missing from a JPEG | A workflow over about 60 KB doesn't fit in JPEG metadata, so it's left out. PNG and WebP store it. |
| Slow on large images | The search tries several qualities. Lower the scale, or use PNG for fast results. |

---

## 🔖 Notes

The node ID is `NouganImageConverter`. Files are named `<prefix>_00001_.<ext>` and count up, like core Save Image.
