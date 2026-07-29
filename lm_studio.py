"""
Nougan LM Studio Bridge
=======================
Talk to any model loaded in LM Studio (dev mode, OpenAI-compatible server)
straight from the graph.

Nodes
-----
NouganLMStudio           chat node · optional IMAGE / AUDIO / VIDEO inputs are
                         auto-converted into the content parts LM Studio
                         speaks (vision models work out of the box). Also
                         accepts an image dropped directly onto the node's DOM
                         strip (uploaded by web/nougan-lmstudio.js). Streams
                         tokens over the ComfyUI websocket and drives the DOM
                         console + progress bar on the node.
NouganLMStudioPromptBox  editable text box that hangs off the main node's
                         PROMPT output — append / prepend / replace before the
                         text flies to the model (or anywhere a STRING goes).

Both nodes are OUTPUT_NODEs, so either can terminate a graph on its own
(fixes ComfyUI's "prompt has no outputs" validation).

Deps: only what ComfyUI already ships (torch, numpy, Pillow, soundfile).
      opencv-python is optional — only needed to decode video *files*;
      IMAGE-batch frames need nothing extra.
"""

import base64
import io
import json
import os
import time
import urllib.request

import numpy as np
import torch

DEFAULT_SERVER = "http://127.0.0.1:1234"
WS_EVENT = "nougan_lmstudio_progress"

SIZE_MAP = {"1024": 1024, "768": 768, "512": 512}


# ── websocket helper ────────────────────────────────────────────────────────
def _emit(payload):
    """Fire-and-forget progress packet to every connected frontend."""
    try:
        from server import PromptServer
        PromptServer.instance.send_sync(WS_EVENT, payload)
    except Exception:
        pass


# ── small utilities ─────────────────────────────────────────────────────────
def _safe_int(v, default):
    """Tolerate empty/garbage widget values (e.g. a cleared INT field)."""
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


# ── media → base64 converters ───────────────────────────────────────────────
def _tensor_to_b64(t, max_side=1024, quality=90):
    """(H, W, C) float tensor in [0,1] → (mime, base64 jpeg)."""
    from PIL import Image
    arr = (t.detach().clamp(0.0, 1.0) * 255.0).round().to(torch.uint8).cpu().numpy()
    img = Image.fromarray(arr)
    if max(img.size) > max_side:
        img.thumbnail((max_side, max_side), Image.LANCZOS)
    img = img.convert("RGB")
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=quality)
    return "image/jpeg", base64.b64encode(buf.getvalue()).decode("ascii")


def _audio_to_b64(audio):
    """ComfyUI AUDIO dict → (mime, base64 wav)."""
    import soundfile as sf
    wav = audio["waveform"]
    if wav.dim() == 3:
        wav = wav.squeeze(0)                      # (frames, channels)
    sr = int(audio.get("sample_rate", 22050))
    buf = io.BytesIO()
    sf.write(buf, wav.cpu().numpy(), sr, format="WAV", subtype="PCM_16")
    return "audio/wav", base64.b64encode(buf.getvalue()).decode("ascii")


def _resolve_video_path(meta):
    import folder_paths
    if isinstance(meta, str):
        if os.path.isabs(meta) and os.path.exists(meta):
            return meta
        return os.path.join(folder_paths.get_input_directory(), meta)
    vtype = str(meta.get("type", "temp")).lower()
    base = {
        "output": folder_paths.get_output_directory(),
        "temp":   folder_paths.get_temp_directory(),
        "input":  folder_paths.get_input_directory(),
    }.get(vtype, folder_paths.get_temp_directory())
    return os.path.join(base, meta.get("subfolder", ""), meta.get("filename", ""))


def _video_file_to_frames(meta, max_frames=8, max_side=512):
    """VHS-style dict / path string → evenly sampled (mime, b64) frames."""
    try:
        import cv2
    except ImportError:
        raise RuntimeError(
            "opencv-python is required to decode video files — "
            "or wire an IMAGE batch of frames into the video input instead."
        )
    path = _resolve_video_path(meta)
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        raise RuntimeError(f"could not open video: {path}")
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    want = set(np.linspace(0, total - 1, max_frames).round().astype(int).tolist()) if total > 1 else set()

    frames, i = [], 0
    while True:
        ok, f = cap.read()
        if not ok:
            break
        if (not want) or (i in want):
            rgb = cv2.cvtColor(f, cv2.COLOR_BGR2RGB)
            t = torch.from_numpy(np.ascontiguousarray(rgb)).float() / 255.0
            frames.append(_tensor_to_b64(t, max_side=max_side))
        i += 1
    cap.release()

    if len(frames) > max_frames:                  # unknown-length fallback
        idxs = np.linspace(0, len(frames) - 1, max_frames).round().astype(int)
        frames = [frames[j] for j in idxs]
    if not frames:
        raise RuntimeError("no frames decoded from video")
    return frames


def _video_to_frames(video, max_frames=8, max_side=512):
    """Accepts IMAGE batch tensor, VHS dict, or a path string."""
    if isinstance(video, str):
        return _video_file_to_frames(video, max_frames, max_side)
    if isinstance(video, dict):
        return _video_file_to_frames(video, max_frames, max_side)
    if isinstance(video, (list, tuple)) and len(video) and isinstance(video[0], dict):
        return _video_file_to_frames(video[0], max_frames, max_side)
    if torch.is_tensor(video):
        n = video.shape[0]
        idxs = np.linspace(0, n - 1, min(max_frames, n)).round().astype(int)
        return [_tensor_to_b64(video[i], max_side=max_side) for i in idxs]
    return []


def _load_embedded_image(meta_json, max_side=1024):
    """Image dropped onto the node's DOM strip (uploaded by the frontend) → (mime, b64)."""
    import folder_paths
    from PIL import Image
    meta = json.loads(meta_json)
    base = {
        "input":  folder_paths.get_input_directory(),
        "temp":   folder_paths.get_temp_directory(),
        "output": folder_paths.get_output_directory(),
    }.get(str(meta.get("type", "input")).lower(), folder_paths.get_input_directory())
    # /upload/image returns {"name", "subfolder", "type"} — NOT "filename"
    fname = meta.get("name") or meta.get("filename") or ""
    path = os.path.join(base, meta.get("subfolder", ""), fname)
    if not fname or not os.path.isfile(path):
        raise RuntimeError(f"embedded image not found on disk: {path}")
    with Image.open(path) as im:
        t = torch.from_numpy(np.array(im.convert("RGB"))).float() / 255.0
    return _tensor_to_b64(t, max_side=max_side)


def _post_json(url, payload, stream):
    """('requests', resp) or ('urllib', resp) — no hard dependency."""
    try:
        import requests
        return "requests", requests.post(url, json=payload, stream=stream, timeout=(10, 600))
    except ImportError:
        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        return "urllib", urllib.request.urlopen(req, timeout=600)


# ── main node ───────────────────────────────────────────────────────────────
class NouganLMStudio:
    """
    Streams a chat completion from LM Studio's dev server. Plug in IMAGE /
    AUDIO / VIDEO and the node converts them into the right content parts
    automatically — vision models work out of the box. You can also drop an
    image directly onto the node's DOM strip. The on-node DOM console (status
    LED, progress bar, tok/s, live tail) is drawn by web/nougan-lmstudio.js
    and fed by the `nougan_lmstudio_progress` websocket event.
    """

    CATEGORY = "Nougan Suite"
    FUNCTION = "generate"
    OUTPUT_NODE = True                          # valid graph endpoint
    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("RESPONSE", "PROMPT")
    DESCRIPTION = "Chat with any model loaded in LM Studio (dev mode). Supports vision, audio and video inputs."

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "server_url": ("STRING", {"default": DEFAULT_SERVER, "multiline": False,
                                          "tooltip": "LM Studio dev-mode server. Default http://127.0.0.1:1234"}),
                "model_name": ("STRING", {"default": "local-model", "multiline": False,
                                          "tooltip": "Use the ⟳ button on the node to auto-detect loaded models."}),
                "system_prompt": ("STRING", {"default": "You are a helpful assistant.",
                                             "multiline": True, "dynamicPrompts": True,
                                             "tooltip": "Instructions for the assistant (system role)."}),
                "generate_prompt": ("STRING", {"default": "", "multiline": True, "dynamicPrompts": True,
                                               "placeholder": "Ask the model anything…"}),
                "max_tokens": ("INT", {"default": 512, "min": -1, "max": 65536, "step": 1,
                                       "tooltip": "-1 lets the model decide."}),
                "temperature": ("FLOAT", {"default": 0.70, "min": 0.0, "max": 2.0, "step": 0.01}),
                "top_p": ("FLOAT", {"default": 0.95, "min": 0.0, "max": 1.0, "step": 0.01}),
                "stream": ("BOOLEAN", {"default": True,
                                       "tooltip": "Token-by-token streaming drives the progress bar."}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xFFFFFFFFFFFFFFFF}),
                "image_size": (["1024", "768", "512"], {"default": "1024",
                                "tooltip": "Longest side images/frames are downscaled to before encoding."}),
                "video_frames": ("INT", {"default": 8, "min": 1, "max": 32,
                                         "tooltip": "How many evenly-spaced frames to sample from a video."}),
            },
            "optional": {
                "image": ("IMAGE", {"tooltip": "Single image or batch — every frame becomes a vision content part."}),
                "audio": ("AUDIO", {"tooltip": "Sent as an input_audio part — needs an audio-capable model."}),
                "video": ("*", {"tooltip": "IMAGE batch of frames, a VHS video dict, or a file path string."}),
                "prompt_override": ("STRING", {"forceInput": True,
                                               "tooltip": "Wired STRING replaces the generate_prompt widget "
                                                          "(feed the Prompt Box back in here)."}),
                "embedded_image": ("STRING", {"default": "", "hidden": True,
                                              "tooltip": "Internal — populated by the on-node image drop zone."}),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")                       # always re-run: model is remote state

    def generate(self, server_url, model_name, system_prompt, generate_prompt,
                 max_tokens, temperature, top_p, stream, seed,
                 image_size="1024", video_frames=8,
                 image=None, audio=None, video=None, prompt_override=None,
                 embedded_image="", unique_id=None):

        nid = str(unique_id) if unique_id is not None else "-1"
        user_text = (prompt_override or "").strip() or generate_prompt
        max_side = SIZE_MAP.get(str(image_size), 1024)

        # tolerate empty/garbage widget values (e.g. a cleared INT field)
        max_tokens   = _safe_int(max_tokens, 512)
        video_frames = _safe_int(video_frames, 8)
        seed         = _safe_int(seed, 0)

        # ── assemble multimodal content parts ───────────────────────────────
        parts = []
        n_media = {"image": 0, "video": 0, "audio": 0}

        # image dropped directly onto the node (DOM strip → uploaded to input/)
        if embedded_image and embedded_image.strip():
            try:
                mime, b64 = _load_embedded_image(embedded_image, max_side=max_side)
                parts.append({"type": "image_url",
                              "image_url": {"url": f"data:{mime};base64,{b64}"}})
                n_media["image"] += 1
            except Exception as e:
                print(f"[Nougan LM Studio] embedded image load failed: {e}")

        if image is not None:
            try:
                batch = image if image.dim() == 4 else image.unsqueeze(0)
                for i in range(batch.shape[0]):
                    mime, b64 = _tensor_to_b64(batch[i], max_side=max_side)
                    parts.append({"type": "image_url",
                                  "image_url": {"url": f"data:{mime};base64,{b64}"}})
                    n_media["image"] += 1
            except Exception as e:
                print(f"[Nougan LM Studio] image encode failed: {e}")

        if video is not None:
            try:
                for mime, b64 in _video_to_frames(video, max_frames=video_frames, max_side=max_side):
                    parts.append({"type": "image_url",
                                  "image_url": {"url": f"data:{mime};base64,{b64}"}})
                    n_media["video"] += 1
            except Exception as e:
                print(f"[Nougan LM Studio] video encode failed: {e}")

        if audio is not None:
            try:
                _mime, b64 = _audio_to_b64(audio)
                parts.append({"type": "input_audio",
                              "input_audio": {"data": b64, "format": "wav"}})
                n_media["audio"] += 1
            except Exception as e:
                print(f"[Nougan LM Studio] audio encode failed: {e}")

        parts.append({"type": "text", "text": user_text})

        messages = []
        if system_prompt and system_prompt.strip():
            messages.append({"role": "system", "content": system_prompt})
        messages.append({
            "role": "user",
            "content": parts if len(parts) > 1 else user_text,
        })

        payload = {
            "model": model_name or "local-model",
            "messages": messages,
            "temperature": float(temperature),
            "top_p": float(top_p),
            "stream": bool(stream),
        }
        if max_tokens > 0:
            payload["max_tokens"] = max_tokens
        if seed > 0:
            payload["seed"] = seed

        url = server_url.rstrip("/") + "/v1/chat/completions"

        _emit({"node": nid, "state": "start", "tokens": 0,
               "max_tokens": max_tokens if max_tokens > 0 else 0,
               "media": n_media, "model": payload["model"]})

        t0 = time.perf_counter()
        collected, tokens = [], 0

        try:
            kind, resp = _post_json(url, payload, bool(stream))

            if kind == "requests":
                if resp.status_code != 200:
                    raise RuntimeError(f"HTTP {resp.status_code} — {resp.text[:300]}")
                line_iter = resp.iter_lines(decode_unicode=True)
            else:                                 # urllib raises HTTPError on non-2xx
                line_iter = iter(lambda: resp.readline().decode("utf-8", "ignore").rstrip("\r\n"), "")

            if stream:
                for raw in line_iter:
                    if not raw or not raw.startswith("data:"):
                        continue
                    data = raw[5:].strip()
                    if data == "[DONE]":
                        break
                    try:
                        choice = json.loads(data)["choices"][0]
                    except Exception:
                        continue
                    piece = (choice.get("delta") or {}).get("content") or ""
                    if piece:
                        collected.append(piece)
                        tokens += 1
                        _emit({"node": nid, "state": "stream", "tokens": tokens,
                               "max_tokens": max_tokens if max_tokens > 0 else 0,
                               "tail": "".join(collected)[-240:]})
            else:
                raw_body = resp.content if kind == "requests" else resp.read()
                body = json.loads(raw_body)
                collected.append(body["choices"][0]["message"].get("content") or "")
                tokens = (body.get("usage") or {}).get("completion_tokens", 0) or 0

        except Exception as e:
            elapsed = round(time.perf_counter() - t0, 2)
            _emit({"node": nid, "state": "error", "tokens": tokens,
                   "error": str(e)[:300], "elapsed": elapsed})
            err = (f"[Nougan LM Studio] request failed — is the LM Studio dev server "
                   f"running at {server_url}? ({e})")
            return {"ui": {"text": [err]}, "result": (err, user_text)}

        response = "".join(collected)
        elapsed = round(time.perf_counter() - t0, 2)
        _emit({"node": nid, "state": "done", "tokens": tokens,
               "elapsed": elapsed, "tail": response[-240:]})
        return {"ui": {"text": [response]}, "result": (response, user_text)}


# ── companion text box ──────────────────────────────────────────────────────
class NouganLMStudioPromptBox:
    """
    Editable text box that hangs off the Nougan LM Studio node's PROMPT
    output. Wire PROMPT → prompt_in, tweak / extend the text here, and send
    the result anywhere a STRING is accepted — including straight back into
    the main node's prompt_override for a two-stage prompt pipeline.
    """

    CATEGORY = "Nougan Suite"
    FUNCTION = "process"
    OUTPUT_NODE = True                          # valid graph endpoint
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("PROMPT_OUT",)
    DESCRIPTION = "Editable text box fed by the Nougan LM Studio node's PROMPT output."

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {"default": "", "multiline": True, "dynamicPrompts": True,
                                    "placeholder": "Local text — combined with the incoming prompt per the mode below."}),
                "mode": (["APPEND", "PREPEND", "REPLACE (local wins)", "PASSTHROUGH (incoming wins)"],
                         {"default": "APPEND"}),
                "separator": ("STRING", {"default": "\n\n", "multiline": False}),
            },
            "optional": {
                "prompt_in": ("STRING", {"forceInput": True,
                                         "tooltip": "Wire the LM Studio node's PROMPT output here."}),
            },
        }

    def process(self, text, mode, separator="\n\n", prompt_in=None):
        incoming = prompt_in or ""
        local = text or ""
        if mode.startswith("APPEND"):
            out = f"{incoming}{separator}{local}" if incoming and local else (incoming or local)
        elif mode.startswith("PREPEND"):
            out = f"{local}{separator}{incoming}" if incoming and local else (incoming or local)
        elif mode.startswith("REPLACE"):
            out = local or incoming
        else:
            out = incoming or local
        return {"ui": {"text": [out]}, "result": (out,)}


# ── optional proxy route (⟳ button fallback when CORS is off) ──────────────
def _register_lmstudio_routes():
    try:
        from server import PromptServer
        from aiohttp import web
        import aiohttp
    except Exception:
        return

    @PromptServer.instance.routes.get("/nougan/lmstudio/models")
    async def _models(request):
        base = (request.rel_url.query.get("base") or DEFAULT_SERVER).rstrip("/")
        try:
            timeout = aiohttp.ClientTimeout(total=5)
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.get(base + "/v1/models") as r:
                    data = await r.json()
            names = [m.get("id", "") for m in data.get("data", []) if m.get("id")]
            return web.json_response({"models": names})
        except Exception as e:
            return web.json_response({"models": [], "error": str(e)[:200]})


try:
    _register_lmstudio_routes()
except Exception:
    pass