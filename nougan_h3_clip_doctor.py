"""
Nougan H3 Clip Doctor 🩺 — pre-flight check + auto-fix for MiniMax H3 clips.

LATENT (+ optional IMAGE / AUDIO / VAE) in -> the same things out, fixed.

Checks, in order:
  * latent shape / rank (info)
  * frame count on the H3 grid: frames = grid_a * (T - 1) + grid_b   (17n + 5)
  * width / height on the pixel grid (16 px), i.e. latent dims * spatial_compress
  * IMAGE frame count vs what the latent T implies (only when IMAGE is wired; warn-only)
  * frame rate vs target_fps (24)
  * audio half present in the nested AV latent
  * batch size (H3 expects 1)

auto_fix snaps frames + dims to the nearest legal values (crop/pad for size, trim/pad
for frames), writes frame_rate, and applies the SAME change to a connected IMAGE / AUDIO
so the outputs stay in sync. Every change is logged and shown in the DOM checklist
(web/nougan_h3_clip_doctor.js). Nothing is ever silently guessed: the frame count comes
from IMAGE when it's wired (authoritative), otherwise from the latent T mapping above.

`strict` turns the node into a gate: if a hard check still fails after fixing, it raises
with a readable message instead of letting H3 fail cryptically three nodes later.

Audio policy: the node reports / strips the audio half but never fabricates one — an
audio latent can't be invented safely. Use strip_audio for still-image work.

No dependencies beyond torch + ComfyUI core.
"""
import logging
import math

import torch
import torch.nn.functional as TF

_LOG = "[Nougan H3 ClipDoctor]"

# Defaults mirror the suite's H3 nodes. Override per-node with the widgets if needed.
_GRID_A = 17          # frames added per latent step
_GRID_B = 5           # frames at T = 1  ->  5, 22, 39, 56, ...
_PIXEL_GRID = 16      # pixel width/height must be multiples of this
_TARGET_FPS = 24.0
_SPATIAL = 8          # fallback spatial compression when no VAE / IMAGE is wired


# ───────────────────────────────── helpers ───────────────────────────────────

def _display_id(unique_id, dynprompt):
    try:
        if dynprompt is not None:
            return str(dynprompt.get_display_node_id(unique_id))
    except Exception:
        pass
    return str(unique_id)


def _split_nested(t):
    """(video, audio_or_None, was_nested). Plain tensors come back as (t, None, False)."""
    if getattr(t, "is_nested", False):
        try:
            parts = list(t.unbind())
            return parts[0], (parts[-1] if len(parts) > 1 else None), True
        except Exception as e:
            logging.warning(f"{_LOG} could not unbind nested latent ({type(e).__name__}: {e}).")
    return t, None, False


def _rebuild_av(video, audio_part):
    """Re-nest a fixed video half with the untouched audio half. None = couldn't."""
    try:
        return torch.nested.nested_tensor([video, audio_part], device=video.device, dtype=video.dtype)
    except Exception as e:
        logging.warning(f"{_LOG} could not rebuild the AV latent ({type(e).__name__}: {e}); leaving it unchanged.")
        return None


def _snap_multiple(v, step, mode):
    """Snap v to a multiple of step. mode: crop (down) | pad (up) | nearest."""
    if step <= 1 or v % step == 0:
        return v
    lo = max(step, (v // step) * step)
    hi = lo + step
    if mode == "crop":
        return lo
    if mode == "pad":
        return hi
    return lo if (v - lo) <= (hi - v) else hi


def _legal_frames(f, a, b, mode):
    """Nearest legal frame count on the a*n+b grid. mode: down | up | nearest."""
    if a <= 0:
        return f
    if f <= b:
        return b
    lo = b + ((f - b) // a) * a
    if f == lo:
        return f
    hi = lo + a
    if mode == "down":
        return lo
    if mode == "up":
        return hi
    return lo if (f - lo) <= (hi - f) else hi


def _frames_from_t(t, a, b):
    return a * (t - 1) + b


def _t_from_frames(f, a, b):
    return max(1, (f - b) // a + 1)


def _resize_spatial(t, th, tw, mode):
    """Crop / pad the last two dims of a latent to (th, tw)."""
    h, w = int(t.shape[-2]), int(t.shape[-1])
    if mode == "crop" or (th <= h and tw <= w):
        return t[..., :th, :tw]
    return TF.pad(t, (0, max(0, tw - w), 0, max(0, th - h)))


def _resize_frames(t, tt):
    """Trim / repeat-last along the T axis of a [B,C,T,H,W] latent."""
    cur = int(t.shape[2])
    if tt == cur:
        return t
    if tt < cur:
        return t[:, :, :tt]
    tail = t[:, :, -1:].repeat(1, 1, tt - cur, 1, 1)
    return torch.cat([t, tail], dim=2)


def _image_spatial(img, dh, dw, mode):
    """img: [F,H,W,C]. dh/dw are pixel deltas (negative = crop)."""
    if dh == 0 and dw == 0:
        return img
    if dh <= 0 and dw <= 0:
        h = max(1, int(img.shape[1]) + dh)
        w = max(1, int(img.shape[2]) + dw)
        return img[:, :h, :w, :]
    x = img.permute(0, 3, 1, 2)
    x = TF.pad(x, (0, max(0, dw), 0, max(0, dh)))
    return x.permute(0, 2, 3, 1)


def _image_frames(img, f2):
    cur = int(img.shape[0])
    if f2 == cur:
        return img
    if f2 < cur:
        return img[:f2]
    return torch.cat([img, img[-1:].repeat(f2 - cur, 1, 1, 1)], dim=0)


def _audio_rescale(audio, ratio):
    """Trim / zero-pad an AUDIO dict to a new duration ratio. Best effort."""
    try:
        wave = audio["waveform"]
        n = int(wave.shape[-1])
        target = max(1, int(round(n * ratio)))
        if target == n:
            return audio
        if target < n:
            new = wave[..., :target]
        else:
            new = TF.pad(wave, (0, target - n))
        out = dict(audio)
        out["waveform"] = new
        return out
    except Exception as e:
        logging.warning(f"{_LOG} audio resync skipped ({type(e).__name__}: {e}).")
        return audio


def _silent_audio():
    return {"waveform": torch.zeros((1, 1, 1)), "sample_rate": 44100}


def _spatial_compress(vae, image, video, fallback):
    """VAE first (authoritative), then IMAGE/latent ratio, then the widget."""
    if vae is not None:
        for attr in ("spacial_compression_decode", "spatial_compression_decode", "spacial_compression_encode"):
            fn = getattr(vae, attr, None)
            if callable(fn):
                try:
                    val = int(fn())
                    if val > 0:
                        return val, f"VAE.{attr}()"
                except Exception:
                    continue
    if image is not None and video.ndim >= 4:
        try:
            ratio = int(image.shape[1]) / int(video.shape[-2])
            if ratio >= 1 and abs(ratio - round(ratio)) < 1e-6:
                return int(round(ratio)), "IMAGE / latent height"
        except Exception:
            pass
    return int(fallback), "widget"


class NouganH3ClipDoctor:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "latent_image": ("LATENT",),
                "auto_fix": ("BOOLEAN", {
                    "default": True, "label_on": "auto-fix ON", "label_off": "report only",
                    "tooltip": "Snap frames + dims to the legal grid and keep IMAGE / AUDIO in sync. "
                               "Off = just report.",
                }),
                "size_mode": (["crop", "pad", "nearest"], {
                    "default": "crop",
                    "tooltip": "How width/height reach the pixel grid. crop = lose a few edge pixels, "
                               "pad = add a border, nearest = whichever is closer.",
                }),
                "frame_mode": (["nearest", "down", "up"], {
                    "default": "nearest",
                    "tooltip": "How the frame count reaches the 17n+5 grid. down = trim, up = repeat the last frame.",
                }),
                "strip_audio": ("BOOLEAN", {
                    "default": False, "label_on": "strip audio", "label_off": "keep audio",
                    "tooltip": "Drop the audio half of the AV latent (video-only output). Handy for still-image work.",
                }),
                "target_fps": ("FLOAT", {"default": _TARGET_FPS, "min": 0.1, "max": 240.0, "step": 0.01,
                                         "tooltip": "H3's reference frame rate is 24."}),
                "strict": ("BOOLEAN", {
                    "default": False, "label_on": "strict (raise)", "label_off": "pass through",
                    "tooltip": "ON: raise with a readable message if a hard check still fails after fixing, "
                               "instead of letting H3 error later.",
                }),
                "grid_a": ("INT", {"default": _GRID_A, "min": 1, "max": 1024,
                                   "tooltip": "Frames per latent step (the 17 in 17n+5)."}),
                "grid_b": ("INT", {"default": _GRID_B, "min": 1, "max": 1024,
                                   "tooltip": "Frames at T=1 (the 5 in 17n+5)."}),
                "pixel_grid": ("INT", {"default": _PIXEL_GRID, "min": 1, "max": 256,
                                       "tooltip": "Pixel width/height must be multiples of this (H3: 16)."}),
                "spatial_compress": ("INT", {"default": _SPATIAL, "min": 1, "max": 64,
                                             "tooltip": "Fallback VAE spatial compression. Ignored when a VAE or IMAGE "
                                                        "is connected — those are read directly."}),
            },
            "optional": {
                "image": ("IMAGE", {"tooltip": "Decoded frames. When wired, its frame count is authoritative and it "
                                               "gets the same crop/trim as the latent."}),
                "audio": ("AUDIO", {"tooltip": "Passed through; resynced to the new duration if frames change."}),
                "vae": ("VAE", {"tooltip": "Only used to read the exact spatial compression. Nothing is decoded."}),
            },
            "hidden": {"unique_id": "UNIQUE_ID", "dynprompt": "DYNPROMPT"},
        }

    RETURN_TYPES = ("LATENT", "IMAGE", "AUDIO")
    RETURN_NAMES = ("latent", "image", "audio")
    FUNCTION = "run"
    OUTPUT_NODE = True
    CATEGORY = "Nougan/H3"
    DESCRIPTION = ("Pre-flight check + auto-fix for MiniMax H3: frame count on the 17n+5 grid, dims on the 16px "
                   "grid, fps, audio half present. Live DOM checklist; auto_fix snaps frames/dims and keeps "
                   "IMAGE/AUDIO in sync. strict = raise instead of letting H3 fail cryptically.")

    def run(self, latent_image, auto_fix, size_mode, frame_mode, strip_audio, target_fps, strict,
            grid_a, grid_b, pixel_grid, spatial_compress,
            image=None, audio=None, vae=None, unique_id=None, dynprompt=None):
        node_id = _display_id(unique_id, dynprompt)
        checks, fixes, warns = [], [], []

        def add(cid, label, state, detail=""):
            checks.append({"id": cid, "label": label, "state": state, "detail": detail})

        latent = dict(latent_image)
        samples = latent["samples"]
        video, audio_part, was_nested = _split_nested(samples)

        if not torch.is_tensor(video):
            raise ValueError(f"{_LOG} unsupported latent: expected a tensor, got {type(video).__name__}.")

        is_video = video.ndim == 5
        batch = int(video.shape[0])
        h, w = int(video.shape[-2]), int(video.shape[-1])
        t_len = int(video.shape[2]) if is_video else 1
        sc, sc_src = _spatial_compress(vae, image, video, spatial_compress)

        frames = int(image.shape[0]) if image is not None else (_frames_from_t(t_len, grid_a, grid_b) if is_video else 1)
        frames_src = "IMAGE" if image is not None else ("latent T" if is_video else "single image")
        fps_in = latent.get("frame_rate", None)

        before = {"frames": frames, "width": w * sc, "height": h * sc, "t": t_len,
                  "lat_h": h, "lat_w": w, "fps": fps_in, "audio": audio_part is not None,
                  "batch": batch}

        add("shape", "latent", "info",
            f"{tuple(video.shape)} · {'video' if is_video else 'image'} · spatial ×{sc} ({sc_src})")
        add("batch", "batch size", "ok" if batch == 1 else "warn",
            str(batch) + ("" if batch == 1 else " — H3 expects 1"))

        # ---- what's legal ----
        step = max(1, pixel_grid // math.gcd(pixel_grid, sc))
        w_ok = (w * sc) % pixel_grid == 0
        h_ok = (h * sc) % pixel_grid == 0
        f_ok = (frames - grid_b) % grid_a == 0 and frames >= grid_b
        f_target = _legal_frames(frames, grid_a, grid_b, frame_mode)
        w_target = _snap_multiple(w, step, size_mode)
        h_target = _snap_multiple(h, step, size_mode)

        add("frames", f"frames · {grid_a}n+{grid_b}", "ok" if f_ok else "fail",
            f"{frames} ({frames_src})" + ("" if f_ok else f" → {f_target}"))
        add("width", f"width · {pixel_grid}px grid", "ok" if w_ok else "fail",
            f"{w * sc}px (latent {w})" + ("" if w_ok else f" → {w_target * sc}px"))
        add("height", f"height · {pixel_grid}px grid", "ok" if h_ok else "fail",
            f"{h * sc}px (latent {h})" + ("" if h_ok else f" → {h_target * sc}px"))

        # IMAGE vs latent cross-check: when IMAGE is wired its frame count wins above, so a
        # disagreement with what the latent T implies would otherwise pass silently.
        if image is not None and is_video:
            lat_frames = _frames_from_t(t_len, grid_a, grid_b)
            if frames == lat_frames:
                add("sync", "IMAGE ↔ latent", "ok", f"{frames}f match (T={t_len})")
            else:
                add("sync", "IMAGE ↔ latent", "warn",
                    f"IMAGE {frames}f vs latent {lat_frames}f (T={t_len}) — check grid_a/grid_b or upstream")

        if fps_in is None:
            add("fps", "frame rate", "warn", f"not set · target {target_fps:g}")
        else:
            same = abs(float(fps_in) - float(target_fps)) < 1e-3
            add("fps", "frame rate", "ok" if same else "warn",
                f"{float(fps_in):g}" + ("" if same else f" → {target_fps:g}"))

        if strip_audio and audio_part is not None:
            add("audio", "audio half", "info", "present · will be stripped")
        elif audio_part is not None:
            add("audio", "audio half", "ok", "present")
        else:
            add("audio", "audio half", "warn", "none (video-only latent)")

        if audio is not None:
            n = int(audio["waveform"].shape[-1])
            add("audio_in", "AUDIO input", "ok" if n > 1 else "warn",
                f"{n} samples" + ("" if n > 1 else " (silent)"))

        # ---- fix ----
        changed = False
        new_video, new_image, new_audio = video, image, audio
        did_size = auto_fix and (h_target != h or w_target != w)
        did_frames = auto_fix and is_video and f_target != frames

        if did_size or did_frames:
            cand = video
            if did_size:
                cand = _resize_spatial(cand, h_target, w_target, size_mode)
            if did_frames:
                cand = _resize_frames(cand, _t_from_frames(f_target, grid_a, grid_b))

            rebuilt = samples
            ok = True
            if was_nested and audio_part is not None and not strip_audio:
                rebuilt = _rebuild_av(cand, audio_part)
                ok = rebuilt is not None
                if not ok:
                    warns.append("AV latent could not be rebuilt — geometry left unchanged.")
            else:
                rebuilt = cand

            if ok:
                new_video = cand
                samples = rebuilt
                changed = True
                if did_size:
                    fixes.append(f"size {w * sc}×{h * sc} → {w_target * sc}×{h_target * sc}px ({size_mode})")
                if did_frames:
                    fixes.append(f"frames {frames} → {f_target} ({frame_mode})")

                if image is not None:
                    try:
                        new_image = _image_spatial(image, (h_target - h) * sc, (w_target - w) * sc, size_mode)
                        if did_frames:
                            new_image = _image_frames(new_image, f_target)
                    except Exception as e:
                        warns.append(f"IMAGE not resynced ({type(e).__name__}).")
                        new_image = image
                if audio is not None and did_frames and frames > 0:
                    new_audio = _audio_rescale(audio, f_target / frames)

        if auto_fix and strip_audio and audio_part is not None and not changed:
            samples = new_video
            changed = True
            fixes.append("audio half stripped")
        elif auto_fix and strip_audio and audio_part is not None:
            fixes.append("audio half stripped")

        if auto_fix and (fps_in is None or abs(float(fps_in) - float(target_fps)) > 1e-3):
            latent["frame_rate"] = float(target_fps)
            fixes.append(f"frame_rate → {target_fps:g}")
            changed = True

        # noise_mask must follow the geometry, or it will blow up downstream
        if changed and "noise_mask" in latent:
            mask = latent["noise_mask"]
            try:
                if torch.is_tensor(mask) and mask.shape[-2:] == (h, w):
                    latent["noise_mask"] = _resize_spatial(mask, h_target, w_target, size_mode)
                elif torch.is_tensor(mask):
                    latent.pop("noise_mask")
                    warns.append("noise_mask dropped (shape didn't match the latent).")
            except Exception:
                latent.pop("noise_mask", None)
                warns.append("noise_mask dropped (couldn't resize it).")

        if changed:
            latent["samples"] = samples

        # ---- re-check what actually landed ----
        v2, a2, nested2 = _split_nested(latent["samples"])
        h2, w2 = int(v2.shape[-2]), int(v2.shape[-1])
        t2 = int(v2.shape[2]) if v2.ndim == 5 else 1
        frames2 = int(new_image.shape[0]) if new_image is not None else (_frames_from_t(t2, grid_a, grid_b) if v2.ndim == 5 else 1)

        for c in checks:
            if c["id"] == "frames" and c["state"] == "fail":
                good = (frames2 - grid_b) % grid_a == 0 and frames2 >= grid_b
                c["state"] = "fixed" if good else "fail"
                c["detail"] = f"{frames} → {frames2}" if good else f"{frames2} (still off-grid)"
            elif c["id"] == "width" and c["state"] == "fail":
                good = (w2 * sc) % pixel_grid == 0
                c["state"] = "fixed" if good else "fail"
                c["detail"] = f"{w * sc} → {w2 * sc}px"
            elif c["id"] == "height" and c["state"] == "fail":
                good = (h2 * sc) % pixel_grid == 0
                c["state"] = "fixed" if good else "fail"
                c["detail"] = f"{h * sc} → {h2 * sc}px"
            elif c["id"] == "fps" and c["state"] == "warn" and "frame_rate" in latent:
                c["state"] = "fixed"
                c["detail"] = f"{fps_in if fps_in is not None else 'unset'} → {target_fps:g}"
            elif c["id"] == "sync" and c["state"] == "warn" and new_image is not None and v2.ndim == 5:
                if frames2 == _frames_from_t(t2, grid_a, grid_b):
                    c["state"] = "fixed"
                    c["detail"] = f"both {frames2}f"
            elif c["id"] == "audio" and strip_audio and a2 is None and audio_part is not None:
                c["state"] = "fixed"
                c["detail"] = "stripped"

        after = {"frames": frames2, "width": w2 * sc, "height": h2 * sc, "t": t2,
                 "lat_h": h2, "lat_w": w2, "fps": latent.get("frame_rate"),
                 "audio": a2 is not None, "batch": batch}

        fails = [c for c in checks if c["state"] == "fail"]
        for wn in warns:
            logging.warning(f"{_LOG} {wn}")
        for fx in fixes:
            logging.info(f"{_LOG} fixed: {fx}")
        if not fixes and not fails:
            logging.info(f"{_LOG} clean: {frames2} frames · {w2 * sc}×{h2 * sc}px · audio={'yes' if a2 is not None else 'no'}")

        report = {
            "node": node_id,
            "ok": not fails,
            "changed": bool(fixes),
            "checks": checks,
            "fixes": fixes,
            "warnings": warns,
            "before": before,
            "after": after,
            "params": {"grid_a": grid_a, "grid_b": grid_b, "pixel_grid": pixel_grid,
                       "fps": target_fps, "spatial": sc, "spatial_src": sc_src,
                       "auto_fix": bool(auto_fix)},
        }

        if strict and fails:
            raise ValueError(f"{_LOG} strict: " + "; ".join(f"{c['label']} — {c['detail']}" for c in fails))

        return {"ui": {"nougan_clip_doctor": [report]},
                "result": (latent,
                           new_image if new_image is not None else torch.zeros((1, 64, 64, 3)),
                           new_audio if new_audio is not None else _silent_audio())}


NODE_CLASS_MAPPINGS = {"NouganH3ClipDoctor": NouganH3ClipDoctor}
NODE_DISPLAY_NAME_MAPPINGS = {"NouganH3ClipDoctor": "Nougan H3 Clip Doctor 🩺"}