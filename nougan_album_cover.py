# nougan_album_cover.py
# Nougan Album Cover Maker
# Takes a ComfyUI IMAGE (Load Image) + AUDIO (Load Audio), encodes the audio to the
# chosen format and embeds the image as the file's cover art (ID3 APIC / FLAC picture /
# Vorbis-Opus METADATA_BLOCK_PICTURE / MP4 covr), plus optional title/artist/album tags.

import base64
import io
import os

import numpy as np

try:
    import folder_paths
except Exception:  # allows importing outside ComfyUI for testing
    folder_paths = None

FORMATS = ["mp3", "flac", "ogg", "opus", "m4a", "wav"]
BITRATES = ["128k", "192k", "256k", "320k"]

# ext -> (container, codec, sample format fed to the encoder, lossy?)
_FMT = {
    "mp3":  ("mp3",  "libmp3lame", "fltp", True),
    "flac": ("flac", "flac",       "s16",  False),
    "ogg":  ("ogg",  "libvorbis",  "fltp", True),
    "opus": ("ogg",  "libopus",    "flt",  True),
    "m4a":  ("ipod", "aac",        "fltp", True),
    "wav":  ("wav",  "pcm_s16le",  "s16",  False),
}


# ─────────────────────────── cover image ────────────────────────────────────
def _cover_bytes(img_np, max_side, cover_format):
    """img_np: float32 [H,W,C] in 0..1  ->  (bytes, mime, width, height)."""
    from PIL import Image

    arr = (np.clip(img_np, 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8)
    if arr.ndim == 2:
        arr = arr[..., None]
    if arr.shape[-1] == 1:
        arr = np.repeat(arr, 3, axis=-1)
    pil = Image.fromarray(arr)
    if pil.mode == "RGBA":
        bg = Image.new("RGB", pil.size, (255, 255, 255))
        bg.paste(pil, mask=pil.split()[3])
        pil = bg
    else:
        pil = pil.convert("RGB")

    if max_side and max(pil.size) > max_side:
        scale = max_side / float(max(pil.size))
        pil = pil.resize(
            (max(1, round(pil.width * scale)), max(1, round(pil.height * scale))),
            Image.LANCZOS,
        )

    buf = io.BytesIO()
    if cover_format == "png":
        pil.save(buf, format="PNG", optimize=True)
        mime = "image/png"
    else:
        pil.save(buf, format="JPEG", quality=95)
        mime = "image/jpeg"
    return buf.getvalue(), mime, pil.width, pil.height


# ─────────────────────────── audio encoding ─────────────────────────────────
def _encode_audio(wave_np, sample_rate, path, ext, bitrate):
    """wave_np: float32 [C,T]. Encodes to `path` with PyAV (bundled with ComfyUI)."""
    import av

    container_name, codec, sample_fmt, lossy = _FMT[ext]

    wave_np = np.clip(wave_np, -1.0, 1.0)
    channels = wave_np.shape[0]
    if channels > 2:
        wave_np = wave_np[:2]
        channels = 2
    native_vorbis = False
    if codec == "libvorbis" and "libvorbis" not in av.codecs_available:
        # PyAV build without libvorbis: fall back to FFmpeg's native (stereo-only) encoder
        codec, native_vorbis = "vorbis", True
        if channels == 1:
            wave_np = np.repeat(wave_np, 2, axis=0)
            channels = 2
    layout = "mono" if channels == 1 else "stereo"

    out_rate = 48000 if ext == "opus" else int(sample_rate)

    container = av.open(path, mode="w", format=container_name)
    try:
        try:
            stream = container.add_stream(codec, rate=out_rate, layout=layout)
        except TypeError:
            stream = container.add_stream(codec, rate=out_rate)
            stream.layout = layout

        ctx = stream.codec_context
        if native_vorbis:
            ctx.options = {"strict": "experimental"}
        try:
            ctx.format = sample_fmt
        except Exception:
            pass
        if lossy:
            ctx.bit_rate = int(bitrate.rstrip("k")) * 1000

        resampler = av.AudioResampler(
            format=stream.format.name, layout=layout, rate=out_rate
        )

        # packed/interleaved float frame, the same way ComfyUI's SaveAudio does it
        packed = np.ascontiguousarray(wave_np.T.reshape(1, -1), dtype=np.float32)
        frame = av.AudioFrame.from_ndarray(packed, format="flt", layout=layout)
        frame.sample_rate = int(sample_rate)
        frame.pts = 0

        for rf in resampler.resample(frame):
            for packet in stream.encode(rf):
                container.mux(packet)
        for rf in resampler.resample(None):
            for packet in stream.encode(rf):
                container.mux(packet)
        for packet in stream.encode(None):
            container.mux(packet)
    finally:
        container.close()


# ─────────────────────────── tagging ────────────────────────────────────────
def _embed(path, ext, data, mime, width, height, title, artist, album):
    if ext in ("mp3", "wav"):
        from mutagen.id3 import APIC, ID3, TALB, TIT2, TPE1, ID3NoHeaderError

        if ext == "mp3":
            try:
                tags = ID3(path)
            except ID3NoHeaderError:
                tags = ID3()
            owner = None
        else:
            from mutagen.wave import WAVE
            owner = WAVE(path)
            if owner.tags is None:
                owner.add_tags()
            tags = owner.tags

        tags.delall("APIC")
        tags.add(APIC(encoding=3, mime=mime, type=3, desc="Cover", data=data))
        if title:
            tags.add(TIT2(encoding=3, text=title))
        if artist:
            tags.add(TPE1(encoding=3, text=artist))
        if album:
            tags.add(TALB(encoding=3, text=album))

        if ext == "mp3":
            tags.save(path, v2_version=3)  # v2.3: widest player compatibility
        else:
            owner.save()
        return

    if ext == "m4a":
        from mutagen.mp4 import MP4, MP4Cover

        f = MP4(path)
        if f.tags is None:
            f.add_tags()
        fmt = MP4Cover.FORMAT_PNG if mime == "image/png" else MP4Cover.FORMAT_JPEG
        f.tags["covr"] = [MP4Cover(data, imageformat=fmt)]
        if title:
            f.tags["\xa9nam"] = [title]
        if artist:
            f.tags["\xa9ART"] = [artist]
        if album:
            f.tags["\xa9alb"] = [album]
        f.save()
        return

    # flac / ogg / opus all use a FLAC-style Picture block
    from mutagen.flac import FLAC, Picture

    pic = Picture()
    pic.type = 3  # front cover
    pic.mime = mime
    pic.desc = "Cover"
    pic.width, pic.height, pic.depth = width, height, 24
    pic.data = data

    if ext == "flac":
        f = FLAC(path)
        f.clear_pictures()
        f.add_picture(pic)
    else:
        if ext == "ogg":
            from mutagen.oggvorbis import OggVorbis
            f = OggVorbis(path)
        else:
            from mutagen.oggopus import OggOpus
            f = OggOpus(path)
        f["metadata_block_picture"] = [base64.b64encode(pic.write()).decode("ascii")]

    if title:
        f["title"] = [title]
    if artist:
        f["artist"] = [artist]
    if album:
        f["album"] = [album]
    f.save()


# ─────────────────────────── node ───────────────────────────────────────────
class NouganAlbumCoverMaker:
    CATEGORY = "Nougan"
    FUNCTION = "make"
    OUTPUT_NODE = True
    RETURN_TYPES = ("AUDIO", "IMAGE", "STRING")
    RETURN_NAMES = ("audio", "cover", "file_path")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE", {"tooltip": "Cover art, e.g. from Load Image."}),
                "audio": ("AUDIO", {"tooltip": "Song, e.g. from Load Audio."}),
                "format": (FORMATS, {"default": "mp3"}),
                "bitrate": (BITRATES, {"default": "320k",
                                       "tooltip": "Lossy formats only (mp3, ogg, opus, m4a)."}),
                "filename_prefix": ("STRING", {"default": "audio/AlbumCover"}),
            },
            "optional": {
                "title": ("STRING", {"default": ""}),
                "artist": ("STRING", {"default": ""}),
                "album": ("STRING", {"default": ""}),
                "cover_max_size": ("INT", {"default": 1400, "min": 0, "max": 8192, "step": 8,
                                           "tooltip": "Downscale the longest side to this. 0 = keep original."}),
                "cover_format": (["jpeg", "png"], {"default": "jpeg"}),
            },
        }

    def make(self, image, audio, format, bitrate, filename_prefix,
             title="", artist="", album="", cover_max_size=1400, cover_format="jpeg"):
        try:
            import mutagen  # noqa: F401
        except ImportError:
            raise RuntimeError(
                "Nougan Album Cover Maker needs the 'mutagen' package. Install it into "
                "ComfyUI's Python, e.g.:  python_embeded\\python.exe -m pip install mutagen"
            )

        # audio: {"waveform": [B,C,T], "sample_rate": int} -> first item of the batch
        wave = audio["waveform"][0].detach().float().cpu().numpy()
        sample_rate = int(audio["sample_rate"])
        img_np = image[0].detach().float().cpu().numpy()

        data, mime, w, h = _cover_bytes(img_np, cover_max_size, cover_format)

        out_dir = folder_paths.get_output_directory()
        full_dir, name, counter, subfolder, _ = folder_paths.get_save_image_path(
            filename_prefix, out_dir
        )
        os.makedirs(full_dir, exist_ok=True)
        file_name = f"{name}_{counter:05}_.{format}"
        path = os.path.join(full_dir, file_name)

        _encode_audio(wave, sample_rate, path, format, bitrate)
        _embed(path, format, data, mime, w, h,
               title.strip(), artist.strip(), album.strip())

        # small preview copy of the cover for the node's album card (web/nougan-album-cover.js)
        cover_ui = []
        try:
            tmp_dir = folder_paths.get_temp_directory()
            os.makedirs(tmp_dir, exist_ok=True)
            prev_name = (f"nougan_cover_{os.path.splitext(file_name)[0].replace('/', '_')}"
                         f".{'png' if mime == 'image/png' else 'jpg'}")
            with open(os.path.join(tmp_dir, prev_name), "wb") as fh:
                fh.write(data)
            cover_ui = [{"filename": prev_name, "subfolder": "", "type": "temp"}]
        except Exception as e:
            print(f"[Nougan] Album Cover Maker: cover preview not written ({e})")

        print(f"[Nougan] 💿 Album Cover Maker: saved {path} (cover {w}x{h} {mime})")
        return {
            "ui": {
                "audio": [{"filename": file_name, "subfolder": subfolder, "type": "output"}],
                "cover": cover_ui,
                "info": [{
                    "title": title.strip(), "artist": artist.strip(), "album": album.strip(),
                    "format": format, "cover_size": f"{w}x{h}", "file": file_name,
                }],
            },
            "result": (audio, image, path),
        }
