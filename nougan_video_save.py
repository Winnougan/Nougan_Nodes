import os
import numpy as np
import subprocess
import tempfile
import shutil
import folder_paths
import torch
from PIL import Image


class NouganVideoSave:
    BGCOLOR = "#3d124d"
    COLOR = "#19124d"
    CATEGORY = "Nougan/Video"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # Using "*" (wildcard) ensures this node accepts connections from 
                # ANY video generator (IMAGE, VIDEO, VHS_VIDEO, MINIMAX_VIDEO, etc.)
                "video": ("*",),
                "filename_prefix": ("STRING", {"default": "NouganVideo"}),
                "format": (["mp4", "webm", "mkv", "gif"],),
                "codec": (["h264", "h265", "av1", "vp9", "none (gif)"],),
                "fps": ("FLOAT", {"default": 24.0, "min": 1.0, "max": 120.0, "step": 0.1}),
                "crf": ("INT", {"default": 23, "min": 0, "max": 51}),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    RETURN_TYPES = ()
    FUNCTION = "save_video"
    OUTPUT_NODE = True
    DESCRIPTION = (
        "Save an incoming VIDEO object using ffmpeg. "
        "Supports MP4, WEBM, MKV, GIF, H.264, H.265, AV1, and VP9."
    )

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------
    def _get_ffmpeg_codec(self, codec):
        codec_map = {
            "h264": "libx264",
            "h265": "libx265",
            "av1": "libsvtav1",
            "vp9": "libvpx-vp9",
            "none (gif)": "gif",
        }
        return codec_map.get(codec, "libx264")

    def _run_ffmpeg(self, cmd, quiet=False):
        try:
            subprocess.run(
                cmd,
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
            )
        except FileNotFoundError:
            print(
                "[Nougan] ERROR: ffmpeg was not found. "
                "Please install ffmpeg and make sure it is available in your PATH."
            )
            raise
        except subprocess.CalledProcessError as e:
            if not quiet:
                stderr = e.stderr.decode("utf-8", errors="ignore") if e.stderr else ""
                print(f"[Nougan] FFmpeg error: {stderr}")
            raise

    def _av1_fallback(self, cmd):
        new_cmd = []
        skip_next = False

        for part in cmd:
            if skip_next:
                skip_next = False
                continue

            if part == "libsvtav1":
                new_cmd.append("libaom-av1")
            elif part == "-preset":
                new_cmd.append("-cpu-used")
                new_cmd.append("4")
                skip_next = True
            else:
                new_cmd.append(part)

        return new_cmd

    def _run_encode(self, cmd, codec):
        try:
            self._run_ffmpeg(cmd, quiet=(codec == "av1"))
        except subprocess.CalledProcessError:
            if codec == "av1":
                print("[Nougan] libsvtav1 failed, trying libaom-av1 fallback...")
                fallback_cmd = self._av1_fallback(cmd)
                self._run_ffmpeg(fallback_cmd, quiet=False)
            else:
                raise

    # ------------------------------------------------------------------
    # Bulletproof Incoming VIDEO Extraction
    # ------------------------------------------------------------------
    def _extract_video(self, video, depth=0):
        """
        Recursively searches through tensors, dicts, tuples, lists, and custom objects
        to find either a frame tensor or a saved video file path.
        """
        if video is None or depth > 6:
            return None

        # 1. Direct tensor (Standard ComfyUI IMAGE batch)
        if isinstance(video, torch.Tensor):
            return video

        # 2. Direct path (String)
        if isinstance(video, str):
            if os.path.isfile(video):
                return video
            for base in [folder_paths.get_output_directory(), folder_paths.get_input_directory()]:
                candidate = os.path.join(base, video)
                if os.path.isfile(candidate):
                    return candidate
            return None

        # 3. Dictionary (e.g., MiniMax H3, VHS, or custom nodes)
        if isinstance(video, dict):
            # Check ComfyUI UI output format: {"ui": {"videos": [{"filename": ...}]}}
            if "ui" in video and isinstance(video["ui"], dict):
                ui = video["ui"]
                for key in ("videos", "images", "gifs"):
                    if key in ui and isinstance(ui[key], list) and len(ui[key]) > 0:
                        res = self._extract_video(ui[key][0], depth + 1)
                        if res is not None: return res

            # Check for file path keys
            for key in ("filename", "path", "filepath", "video_path", "file", "src"):
                if key in video and isinstance(video[key], str):
                    res = self._extract_video(video[key], depth + 1)
                    if res is not None: return res
            
            # Check for tensor/frame keys
            for key in ("frames", "images", "video", "pixels", "tensor", "image", "data", "videos", "gifs"):
                if key in video:
                    res = self._extract_video(video[key], depth + 1)
                    if res is not None: return res

        # 4. Tuple / List (e.g., VHS_VIDEO outputs (frames, fps) or (frames, audio))
        if isinstance(video, (list, tuple)):
            if len(video) == 0:
                return None
            
            # If first item is tensor, assume list of frames or (frames, audio/fps)
            if isinstance(video[0], torch.Tensor):
                return self._extract_video(video[0], depth + 1)
            
            # If it's a list of PIL images or numpy arrays
            if isinstance(video[0], (np.ndarray, Image.Image)) or (hasattr(video[0], "size") and hasattr(video[0], "mode")):
                return video

            # Recurse into items
            for item in video:
                res = self._extract_video(item, depth + 1)
                if res is not None:
                    return res

        # 5. Object attributes (Custom video container classes)
        for attr in ("frames", "images", "video", "pixels", "tensor", "image", "data", "path", "filepath", "video_path", "file", "src"):
            if hasattr(video, attr):
                res = self._extract_video(getattr(video, attr), depth + 1)
                if res is not None:
                    return res

        # 6. Fallback: search recursively if it's a custom class with __dict__
        if hasattr(video, "__dict__"):
            for val in video.__dict__.values():
                res = self._extract_video(val, depth + 1)
                if res is not None:
                    return res

        # If we reach here, we couldn't extract it. Print debug info to console.
        if depth == 0:
            print(f"[Nougan Video Save] DEBUG: Could not extract video. Type: {type(video)}")
            if isinstance(video, dict):
                print(f"[Nougan Video Save] DEBUG: Dict keys: {list(video.keys())}")
            elif isinstance(video, (list, tuple)):
                print(f"[Nougan Video Save] DEBUG: {type(video).__name__} length: {len(video)}, first item type: {type(video[0]) if len(video) > 0 else 'empty'}")
            elif hasattr(video, "__dict__"):
                print(f"[Nougan Video Save] DEBUG: Object attributes: {list(video.__dict__.keys())}")
            else:
                print(f"[Nougan Video Save] DEBUG: Value: {str(video)[:200]}")

        return None

    # ------------------------------------------------------------------
    # Frame writing
    # ------------------------------------------------------------------
    def _write_frames(self, frames, temp_dir):
        if frames is None:
            return 0

        if isinstance(frames, torch.Tensor):
            if frames.ndim == 3:
                frames = frames.unsqueeze(0)

            # Convert BCHW to BHWC if needed.
            if frames.ndim == 4 and frames.shape[1] in (1, 3):
                frames = frames.permute(0, 2, 3, 1)

        count = 0

        for i, img in enumerate(frames):
            if isinstance(img, torch.Tensor):
                # Convert CHW to HWC if needed.
                if img.ndim == 3 and img.shape[0] in (1, 3):
                    img = img.permute(1, 2, 0)

                img_np = img.detach().cpu().numpy()
            else:
                img_np = np.array(img)

            img_np = img_np.astype(np.float32)

            # If values are normalized 0-1, convert to 0-255.
            if img_np.size > 0 and img_np.max() <= 1.5:
                img_np *= 255.0

            img_np = img_np.clip(0, 255).astype(np.uint8)

            # Grayscale -> RGB
            if img_np.ndim == 2:
                img_np = np.stack([img_np] * 3, axis=-1)

            # Single channel -> RGB
            elif img_np.shape[-1] == 1:
                img_np = np.repeat(img_np, 3, axis=-1)

            # RGBA -> RGB
            elif img_np.shape[-1] == 4:
                img_np = img_np[..., :3]

            pil_img = Image.fromarray(img_np)
            pil_img.save(os.path.join(temp_dir, f"{i:08d}.png"))
            count += 1

        return count

    # ------------------------------------------------------------------
    # Output path
    # ------------------------------------------------------------------
    def _prepare_output_path(self, filename_prefix, format):
        output_dir = folder_paths.get_output_directory()

        subfolder = os.path.dirname(filename_prefix)
        if subfolder:
            output_dir = os.path.join(output_dir, subfolder)
            os.makedirs(output_dir, exist_ok=True)
            base_prefix = os.path.basename(filename_prefix)
        else:
            base_prefix = filename_prefix

        counter = 1
        existing = [
            f
            for f in os.listdir(output_dir)
            if f.startswith(base_prefix) and f.endswith(f".{format}")
        ]

        if existing:
            nums = []
            for f in existing:
                try:
                    num_str = (
                        f.replace(base_prefix, "")
                        .replace(f".{format}", "")
                        .replace("_", "")
                    )
                    if num_str.isdigit():
                        nums.append(int(num_str))
                except Exception:
                    pass

            if nums:
                counter = max(nums) + 1

        out_filename = f"{base_prefix}_{counter:05d}.{format}"
        out_path = os.path.join(output_dir, out_filename)

        return subfolder, out_filename, out_path

    # ------------------------------------------------------------------
    # Encoding from PNG sequence
    # ------------------------------------------------------------------
    def _encode_from_frames(self, temp_dir, out_path, format, codec, fps, crf):
        frame_input = os.path.join(temp_dir, "%08d.png")
        ffmpeg_codec = self._get_ffmpeg_codec(codec)

        if format == "gif":
            palette_path = os.path.join(temp_dir, "palette.png")

            palette_cmd = [
                "ffmpeg", "-y", "-framerate", str(fps), "-i", frame_input,
                "-vf", f"fps={fps},palettegen", palette_path,
            ]
            self._run_ffmpeg(palette_cmd)

            gif_cmd = [
                "ffmpeg", "-y", "-framerate", str(fps), "-i", frame_input, "-i", palette_path,
                "-lavfi", f"fps={fps} [x]; [x][1:v] paletteuse", "-loop", "0", out_path,
            ]
            self._run_ffmpeg(gif_cmd)
            return

        cmd = [
            "ffmpeg", "-y", "-framerate", str(fps), "-i", frame_input,
            "-c:v", ffmpeg_codec,
        ]

        if codec == "av1":
            cmd += ["-preset", "6", "-crf", str(crf)]
        else:
            cmd += ["-crf", str(crf)]

        cmd += ["-pix_fmt", "yuv420p", out_path]
        self._run_encode(cmd, codec)

    # ------------------------------------------------------------------
    # Encoding from an existing video file
    # ------------------------------------------------------------------
    def _encode_from_source(self, source_path, out_path, format, codec, fps, crf):
        ffmpeg_codec = self._get_ffmpeg_codec(codec)

        if format == "gif":
            temp_dir = os.path.dirname(out_path)
            palette_path = os.path.join(temp_dir, f"_nougan_palette_{os.getpid()}.png")

            palette_cmd = [
                "ffmpeg", "-y", "-i", source_path,
                "-vf", f"fps={fps},palettegen", palette_path,
            ]
            self._run_ffmpeg(palette_cmd)

            gif_cmd = [
                "ffmpeg", "-y", "-i", source_path, "-i", palette_path,
                "-lavfi", f"fps={fps} [x]; [x][1:v] paletteuse", "-loop", "0", out_path,
            ]

            try:
                self._run_ffmpeg(gif_cmd)
            finally:
                if os.path.isfile(palette_path):
                    try: os.remove(palette_path)
                    except Exception: pass
            return

        cmd = [
            "ffmpeg", "-y", "-i", source_path, "-c:v", ffmpeg_codec,
        ]

        if codec == "av1":
            cmd += ["-preset", "6", "-crf", str(crf)]
        else:
            cmd += ["-crf", str(crf)]

        audio_codec = "aac"
        if format == "webm":
            audio_codec = "libopus"

        cmd += [
            "-pix_fmt", "yuv420p", "-map", "0:v:0", "-map", "0:a?",
            "-c:a", audio_codec, out_path,
        ]
        self._run_encode(cmd, codec)

    # ------------------------------------------------------------------
    # Main node function
    # ------------------------------------------------------------------
    def save_video(
        self,
        video,
        filename_prefix="NouganVideo",
        format="mp4",
        codec="h264",
        fps=24.0,
        crf=23,
        prompt=None,
        extra_pnginfo=None,
    ):
        extracted = self._extract_video(video)

        if extracted is None:
            raise ValueError(
                "Nougan Video Save could not extract frames or a video file "
                "from the incoming VIDEO object. Check the ComfyUI console for DEBUG info."
            )

        subfolder, out_filename, out_path = self._prepare_output_path(
            filename_prefix, format,
        )

        temp_dir = tempfile.mkdtemp()

        try:
            # Case 1: incoming object already contains a saved video file.
            if isinstance(extracted, str) and os.path.isfile(extracted):
                self._encode_from_source(extracted, out_path, format, codec, fps, crf)

            # Case 2: incoming object contains frames.
            else:
                frame_count = self._write_frames(extracted, temp_dir)

                if frame_count == 0:
                    return {"ui": {"videos": []}}

                self._encode_from_frames(temp_dir, out_path, format, codec, fps, crf)

            return {
                "ui": {
                    "videos": [
                        {
                            "filename": out_filename,
                            "subfolder": subfolder,
                            "type": "output",
                        }
                    ]
                }
            }

        finally:
            shutil.rmtree(temp_dir, ignore_errors=True)


NODE_CLASS_MAPPINGS = { "NouganVideoSave": NouganVideoSave }
NODE_DISPLAY_NAME_MAPPINGS = { "NouganVideoSave": "Nougan Video Save" }