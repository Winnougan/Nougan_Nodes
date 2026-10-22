> 🌀 **Nougan Suite** · [← Back to docs](README.md) · [Overview](../README.md)

# 🎞️ GIF Maker

Turn any video (or image batch) into a **GIF, animated WebP or looping MP4** without leaving ComfyUI. Trim the clip on a visual timeline, crop it right on the video, pick a social preset, watch the file size, and export. No re-queuing, no external editor.

**Node:** `Nougan GIF Maker 🎞️` · **Category:** `Nougan`

---

## ✨ What it does

- 🎬 **Visual timeline** with a thumbnail filmstrip, draggable start/end handles, and a playhead
- ▶️ **Loop preview** of just your selected range, at the speed you set
- ✂️ **On-video crop** with free or locked aspect ratios (1:1, 16:9, 9:16, 4:3, 3:4)
- 📏 **Live size estimate** that warns you before you blow past Discord's 10 MB limit
- 🎯 **Social presets** for Discord, WhatsApp/Telegram, X/Twitter, tiny memes, and sharp WebP
- 🖼️ **Real GIF quality**: ffmpeg two-pass palette (`palettegen` + `paletteuse`), not the muddy default encoder
- 🔁 **Frames out**: the trimmed clip comes out as an `IMAGE` batch, so you can chain it into other nodes

---

## 📦 Requirements

You need **ffmpeg**. Either:

- a system `ffmpeg` on your PATH, or
- `pip install imageio-ffmpeg` in your ComfyUI environment (most video-node users already have it)

If it's missing, the node tells you in the error message. Nothing else to install.

---

## 🚀 Quick start

1. Add **Load Video** and **Nougan GIF Maker 🎞️**, then connect `VIDEO` to `video`.
2. **Queue once.** This loads the clip into the editor.
3. Drag the orange handles on the timeline to pick your range.
4. Pick a **Preset** (or set width / fps yourself) and optionally a **Crop**.
5. Check the size readout, then hit **⬇ Export**.

The file lands in `ComfyUI/output/nougan_gif/` and shows up right in the node with a download link.

> 💡 You only queue once per video. After that, every edit and export happens in the node itself.

**Using frames instead of a video?** Connect an `IMAGE` batch to `images` and set `images_fps`. If both are connected, `video` wins.

---

## 🎛️ The editor

| Control | What it does |
|---|---|
| **Preset…** | Applies format, width, fps and quality settings in one click (see below) |
| **Crop dropdown** | `No crop`, `Free`, or a locked ratio. Pick a ratio and you get the largest centered box of that shape |
| **Timeline: handles** | Drag the left/right orange handles to set start and end |
| **Timeline: middle** | Drag the selected block to slide the whole window without changing its length |
| **Timeline: click / drag outside** | Scrub the playhead |
| **▶ Play** | Loops only your selected range, at your `speed` setting |
| **[ Start here / End here ]** | Sets start or end to wherever the playhead is |
| **Crop box** | Drag to move, drag the corner handles to resize |
| **⬇ Export** | Encodes the file with the current settings |
| **Size readout** | Estimated file size. Orange near 8 MB, red over 10 MB |

The minimum clip length is 0.1 seconds.

### 🎯 Presets

| Preset | Format | Width | FPS | Other |
|---|---|---|---|---|
| Discord (GIF, ≤10 MB) | gif | 480 | 15 | 256 colors, sierra2_4a dither |
| WhatsApp / Telegram (MP4) | mp4 | 540 | 24 | quality 75 |
| X / Twitter (GIF) | gif | 600 | 15 | 256 colors, sierra2_4a dither |
| Tiny meme (GIF) | gif | 320 | 12 | 128 colors, bayer dither |
| Sharp WebP | webp | 480 | 20 | quality 80 |

Presets are starting points. Tweak anything afterwards.

---

## ⚙️ Settings

Everything lives in normal widgets, so your workflow saves and loads like any other node. The editor just drives them.

| Widget | Range / options | Notes |
|---|---|---|
| `start_sec` | 0 – 36000 | Clip start in seconds |
| `end_sec` | 0 – 36000 | Clip end. `0`, or anything at or below start, means "to the end of the video". Default is 5s |
| `width` | 16 – 3840 | Output width in px. Height follows the crop's aspect ratio. It never upscales past the cropped size |
| `fps` | 1 – 60 | Output frame rate |
| `format` | `gif` / `webp` / `mp4` | See the format guide below |
| `max_colors` | 2 – 256 | GIF palette size. Fewer colors means a smaller file |
| `dither` | `sierra2_4a` / `bayer` / `floyd_steinberg` / `none` | GIF only. `bayer` gives the smallest files, `sierra2_4a` the nicest gradients |
| `quality` | 1 – 100 | WebP and MP4 only |
| `loop_count` | -1 – 1000 | `0` loops forever, `-1` plays once (GIF) |
| `speed` | 0.25 – 4.0 | Playback speed multiplier. 2.0 makes the clip twice as fast |
| `crop_x` `crop_y` `crop_w` `crop_h` | 0 – 1 | Crop box as a fraction of the frame. Normally set by dragging, not typing |
| `filename_prefix` | text | Files are named `prefix_00001.ext`, counting up |
| `export_on_run` | on / off | Also writes the file every time the workflow runs. Handy for batch workflows |
| `images_fps` | 1 – 120 | Frame rate of the `images` input (ignored for `video`) |

---

## 🧭 Which format should I use?

| Format | Best for | Notes |
|---|---|---|
| **GIF** | Works everywhere | Biggest files, 256 colors max. Lower `width`, `fps` and `max_colors` to shrink it |
| **WebP** | Discord, browsers, anywhere that supports it | Much smaller and sharper than GIF at the same size |
| **MP4** | WhatsApp, Telegram | Both treat short silent MP4s as GIFs, and it's the smallest and cleanest option |

### 📉 Getting under a size limit

If the readout is orange or red, try these in order (biggest win first):

1. **Shorten the clip.** Size scales almost linearly with length.
2. **Lower the width.** 480 to 360 roughly halves the pixel count.
3. **Drop the fps.** 15 to 12 saves about 20%.
4. **Reduce `max_colors`** to 128 or 64 and switch `dither` to `bayer`.
5. **Switch to WebP or MP4** if the platform supports it.
6. **Crop in** on the subject. Fewer pixels means a smaller file.

---

## 📤 Outputs

| Output | Type | What it is |
|---|---|---|
| `frames` | `IMAGE` | The trimmed, cropped, resized clip with the same fps and speed as the export. Capped at **600 frames** |
| `file_path` | `STRING` | Full path of the file written this run. Empty unless `export_on_run` is on |

Exported files go to `ComfyUI/output/nougan_gif/`. The Export button works independently of the workflow, so `file_path` only reflects `export_on_run`.

---

## 🔌 HTTP endpoints

The editor talks to two routes. They're handy if you want to script exports.

**`POST /nougan/gif/export`**
**`POST /nougan/gif/estimate`**

```json
{
  "token": "<24-char hex token from the node's last run>",
  "settings": {
    "start_sec": 1.0, "end_sec": 4.0, "width": 480, "fps": 15, "format": "gif"
  }
}
```

`export` returns `{ filename, subfolder, type, bytes, path, format, width, height }`. `estimate` returns `{ bytes, exact, width, height, frames }`. On failure both return `{ "error": "..." }` with HTTP 500.

Any setting you leave out falls back to its default. Tokens only refer to files the node itself prepared, so arbitrary paths aren't accepted.

---

## 🛠️ How it works

- On the first queue, the node resolves your video to a file on disk and builds a **720px preview proxy** in ComfyUI's temp folder (`temp/nougan_gif/<token>/`). The editor plays and scrubs the proxy so it stays smooth even on huge source files.
- **Exports always read the original source**, never the proxy, so quality isn't affected by the preview.
- File-backed videos from Load Video are used in place (no copy). The same file on the next queue reuses the existing proxy.
- GIFs use a two-pass palette: one pass builds the best 256 colors for your clip, a second maps the frames to it.
- The size estimate encodes about 1 second from the middle of your range and extrapolates. Ranges of ~1 second or less are encoded fully, so those numbers are exact. For longer clips it's an approximation, and scenes that vary a lot can land off.

---

## 🩺 Troubleshooting

| Problem | Fix |
|---|---|
| **"ffmpeg not found"** | Install ffmpeg, or run `pip install imageio-ffmpeg` in your ComfyUI env |
| **Editor says "Connect a video, then queue once"** | Nothing is loaded yet. Connect `video` or `images` and queue |
| **"Preview expired" after a restart** | ComfyUI clears its temp folder on startup. Queue the workflow again to rebuild the preview |
| **Export says "Queue the workflow once first"** | Same thing: the node has no loaded video yet |
| **Size readout says "size n/a"** | The estimate failed. Hover it for the reason. Export may still work |
| **WebP export fails** | Your ffmpeg build is missing the animated WebP encoder (`libwebp_anim`). Use GIF or MP4, or install a fuller ffmpeg build |
| **Output looks cropped wrong** | Crop is stored as fractions of the frame. Set the dropdown to `No crop` to reset it |
| **Frames output is shorter than expected** | The `frames` output is capped at 600 frames. The exported file is not capped |
| **Clip is only 5 seconds** | That's the default `end_sec`. Drag the end handle or set `end_sec` to `0` for the full video |
| **Editor didn't update after changing the video** | Queue again. The editor refreshes whenever the node runs |

---

## 💖 Credits

Built by **Winnougan** for the Nougan Suite. GIF encoding is powered by [ffmpeg](https://ffmpeg.org).

If this saves you time, support on [Patreon](https://www.patreon.com/c/Winnougan) or [Ko-fi](https://ko-fi.com/winnougan), and come hang out in the [Discord](https://discord.gg/CJv5wceJaN).
