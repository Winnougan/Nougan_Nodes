"""Nougan Compare.

Interactive image / batch comparison with five modes (slider, box, diff, toggle, mask).
Based on KJNodes' Image Compare, rebuilt as a classic node so it registers through the
normal _FEATURES table, with no KJNodes dependency.

Python only writes preview files into ComfyUI's temp folder:
  - single images  -> lossless PNG (lossy previews would show up as false differences in diff mode)
  - image batches and videos -> H.264 MP4, played back frame-synced in the browser
  - mask           -> gray+alpha PNG of the first frame
Everything interactive (modes, WebGPU diff heatmap, backdrop) lives in web/nougan_compare.js.
"""

import os
import secrets
import threading
import weakref
from concurrent.futures import ThreadPoolExecutor, wait
from fractions import Fraction

import numpy as np
import torch
from PIL import Image

import folder_paths
from comfy import model_management
from comfy.utils import ProgressBar

# Low crf keeps codec noise out of diff mode, short GOP keeps frame scrubbing responsive
_MP4_OPTIONS = {"crf": "16", "preset": "veryfast", "g": "8"}

# Unchanged upstream outputs come back as the same object on re-runs, so their files are reused.
# id(source) -> (weakref, fingerprint, filename, (width, height, frames)); entries drop out when the source is freed
_reuse = {}

# Same idea for video inputs, keyed by the video object so an unchanged video is never decoded again.
# id(video) -> (weakref, fps, filename, (width, height, frames))
_video_reuse = {}


def _is_video(x):
    # ComfyUI VIDEO inputs are VideoInput objects, not tensors
    return x is not None and not torch.is_tensor(x) and hasattr(x, "get_components")


def _fingerprint(src, fps):
    # Sparse sample sum catches in-place edits of a cached tensor, cheap even for long batches
    H, W = src.shape[1], src.shape[2]
    return tuple(src.shape), src.dtype, src.data_ptr(), fps, float(src[:, ::max(1, H // 16), ::max(1, W // 16)].float().sum())


def _to_uint8(images):
    # Same 255-scale truncation as core's SaveImage, so previews match saved files
    if images.shape[-1] == 1:
        images = images.repeat(1, 1, 1, 3)
    return images[..., :3].mul(255).clamp(0, 255).to(torch.uint8).cpu().numpy()


def _batch_frames(images, chunk=16):
    for start in range(0, images.shape[0], chunk):
        yield from _to_uint8(images[start:start + chunk])


def _open_mp4(path, width, height, fps):
    import av  # ships with ComfyUI

    container = av.open(path, mode="w", options={"movflags": "faststart"})
    stream = container.add_stream("libx264", rate=Fraction(fps).limit_denominator(1001), options=_MP4_OPTIONS)
    stream.width, stream.height = width, height
    stream.pix_fmt = "yuv420p"
    # Tag BT.709 so the browser decodes the same colors we encode. Older PyAV builds lack some of these attributes.
    for attr in ("colorspace", "color_primaries", "color_trc"):
        try:
            setattr(stream.codec_context, attr, 1)
        except Exception:
            pass
    return av, container, stream


def _save_mp4(frames, width, height, path, fps, progress):
    # yuv420p needs even sides, edge padding keeps every source pixel; the frontend crops it back off
    pad = ((0, height & 1), (0, width & 1), (0, 0))
    av, container, stream = _open_mp4(path, width + (width & 1), height + (height & 1), fps)
    use_709 = True
    try:
        count = 0
        for img in frames:
            if (width | height) & 1:
                img = np.pad(img, pad, mode="edge")
            frame = av.VideoFrame.from_ndarray(np.ascontiguousarray(img), format="rgb24")
            if use_709:
                try:
                    frame = frame.reformat(format="yuv420p", src_colorspace="ITU709", dst_colorspace="ITU709")
                except Exception:
                    use_709 = False
            for packet in stream.encode(frame):
                container.mux(packet)
            count += 1
            progress(1)
        for packet in stream.encode():
            container.mux(packet)
        return count
    finally:
        container.close()


def _save(src, kind, path, fps, progress):
    # Returns the (width, height, frames) shown for the file
    with torch.inference_mode():  # per thread
        B, H, W = src.shape[:3]
        if kind == "mask":
            # Gray+alpha PNG of the first frame, CSS masks read alpha; the browser stretches it over the reference frame
            m = src[0].mul(255).clamp(0, 255).to(torch.uint8).cpu().numpy()
            Image.fromarray(np.stack([np.full_like(m, 255), m], axis=-1)).save(path, compress_level=1)
        elif B > 1:
            _save_mp4(_batch_frames(src), W, H, path, fps, progress)
        else:
            Image.fromarray(_to_uint8(src[:1])[0]).save(path, compress_level=1)
        return W, H, B


def _frames_hint(src, kind):
    return src.shape[0] if kind == "image" and src.shape[0] > 1 else 0


class NouganCompare:
    CATEGORY = "Nougan/image"
    FUNCTION = "compare"
    RETURN_TYPES = ()
    OUTPUT_NODE = True
    DESCRIPTION = (
        "Interactive image comparison.\n\n"
        "Modes: slider (Shift+drag rotates), box, diff (WebGPU heatmap), toggle and mask.\n"
        "Two inputs (image, image batch or video), the first one is the reference. Batches and videos "
        "play back in sync, frame by frame; a single image next to a batch stays still. Video audio is ignored.\n"
        "The optional mask (first frame) reveals the compared image where it is white."
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image1": ("IMAGE,VIDEO", {"tooltip": "The reference image, batch or video."}),
                "image2": ("IMAGE,VIDEO", {"tooltip": "Compared against the reference."}),
            },
            "optional": {
                "mask": ("MASK", {"tooltip": "Mask mode: white shows the compared image, black the reference, gray blends. Only the first frame is used."}),
                "fps": ("FLOAT", {"default": 24.0, "min": 1.0, "max": 120.0, "step": 0.1,
                                  "tooltip": "Playback frame rate for image batches. A connected video overrides it with its own frame rate."}),
                # Labels are only read by the browser UI (web/nougan_compare.js)
                "text1": ("STRING", {"default": "Before"}),
                "text2": ("STRING", {"default": "After"}),
            },
        }

    def compare(self, image1, image2, mask=None, fps=24.0, text1="Before", text2="After"):
        inputs = [x for x in (image1, image2) if x is not None]
        fps = float(fps)
        # A connected video sets the playback rate (read from the file header, nothing is decoded for it)
        for x in inputs:
            if _is_video(x):
                try:
                    fps = float(x.get_frame_rate())
                except Exception:
                    pass
                break

        temp_dir = folder_paths.get_temp_directory()
        os.makedirs(temp_dir, exist_ok=True)

        # Videos decode into frame batches, but one that was already encoded at this frame rate keeps its file
        # and is not decoded at all. Empty batches have nothing to show
        sources, cached, decoded, by_video = [], {}, {}, {}
        for x in inputs:
            if _is_video(x):
                e = _video_reuse.get(id(x))
                if e and e[0]() is x and e[1] == fps and os.path.exists(os.path.join(temp_dir, e[2])):
                    cached[id(x)] = (e[2], e[3])
                    sources.append((x, "image"))
                    continue
                if id(x) not in by_video:  # the same video on two inputs decodes once
                    frames = x.get_components().images
                    by_video[id(x)] = frames
                    decoded[id(frames)] = x
                frames = by_video[id(x)]
                if frames.shape[0] > 0:
                    sources.append((frames, "image"))
            elif x.shape[0] > 0:
                sources.append((x, "image"))
        if len(sources) < 2:
            return {"ui": {"compare_data": []}}
        if mask is not None:
            mask = mask[None] if mask.ndim == 2 else mask
            mask = mask if mask.shape[0] > 0 else None
        # Random names, a restarted server reuses counters and the browser would show cached files
        prefix = f"nougan_compare_{secrets.token_hex(5)}"

        # One job per distinct source, sources unchanged since an earlier run keep their files
        targets = sources + ([(mask, "mask")] if mask is not None else [])
        names, meta, jobs = {}, {}, {}
        for idx, (src, kind) in enumerate(targets):
            if id(src) in names:
                continue
            if id(src) in cached:
                names[id(src)], meta[id(src)] = cached[id(src)]
                continue
            moving = kind == "image" and src.shape[0] > 1
            fp, e = _fingerprint(src, fps if moving else None), _reuse.get(id(src))
            if e and e[0]() is src and e[1] == fp and os.path.exists(os.path.join(temp_dir, e[2])):
                names[id(src)], meta[id(src)] = e[2], e[3]
            else:
                names[id(src)] = fname = f"{prefix}_{idx}.{'mp4' if moving else 'png'}"
                jobs[fname] = (src, kind, fp)

        # Workers only watch a stop event: taking the interrupt clears the global flag, so a worker raising
        # it would leave the others encoding. The main thread takes it and drives the progress bar
        stop, lock, done = threading.Event(), threading.Lock(), [0]
        pbar = ProgressBar(sum(_frames_hint(src, kind) for src, kind, _ in jobs.values()) or 1)

        def progress(n):
            if stop.is_set():
                raise model_management.InterruptProcessingException()
            with lock:
                done[0] += n

        # Encoders and zlib release the GIL, sources encode in parallel
        if jobs:
            with ThreadPoolExecutor(max(1, len(jobs))) as pool:
                futures = {fname: pool.submit(_save, src, kind, os.path.join(temp_dir, fname), fps, progress)
                           for fname, (src, kind, _) in jobs.items()}
                try:
                    while wait(futures.values(), timeout=0.1).not_done:
                        model_management.throw_exception_if_processing_interrupted()
                        pbar.update_absolute(done[0])
                    for fname, (src, _, fp) in jobs.items():
                        meta[id(src)] = futures[fname].result()
                        _reuse[id(src)] = (weakref.ref(src, lambda _, k=id(src): _reuse.pop(k, None)), fp, fname, meta[id(src)])
                        video = decoded.get(id(src))
                        if video is not None:
                            try:
                                _video_reuse[id(video)] = (weakref.ref(video, lambda _, k=id(video): _video_reuse.pop(k, None)),
                                                           fps, fname, meta[id(src)])
                            except TypeError:  # not weak-referenceable, it is simply decoded again next time
                                pass
                except BaseException:
                    stop.set()
                    raise

        entries = []
        for src, _ in sources:
            w, h, n = meta[id(src)]
            entries.append({"filename": names[id(src)], "subfolder": "", "type": "temp", "width": w, "height": h, "frames": n})
        data = {"fps": fps, "images": entries}
        if mask is not None:
            data["mask"] = {"filename": names[id(mask)], "subfolder": "", "type": "temp"}
        return {"ui": {"compare_data": [data]}}
