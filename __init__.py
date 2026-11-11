"""__init__.py — Nougan suite by Winnougan"""
import os
import sys
import traceback
import importlib

WEB_DIRECTORY = "./web"
VERSION = "1.0"  # edit me

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

# ═════════════════════════════════════════════════════════════════════════════
# Pretty console output (ANSI). Set NO_COLOR=1 in your environment to disable.
# ═════════════════════════════════════════════════════════════════════════════
_COLOR = "NO_COLOR" not in os.environ
if _COLOR and os.name == "nt":
    os.system("")  # flips on ANSI/VT processing in Windows terminals


def _c(code, text):
    return f"\033[{code}m{text}\033[0m" if _COLOR else str(text)


def _bold(t):    return _c("1", t)
def _dim(t):     return _c("2", t)
def _green(t):   return _c("1;92", t)
def _yellow(t):  return _c("1;93", t)
def _red(t):     return _c("1;91", t)
def _cyan(t):    return _c("96", t)
def _magenta(t): return _c("95", t)
def _orange(t):  return _c("38;5;208", t)


OK = _green("✔")
FAIL = _red("✘")
WARN = _yellow("⚠")
TAG = _magenta("[Nougan]")

SOCIALS = [
    ("Patreon",     "https://www.patreon.com/c/Winnougan",       _orange),
    ("Ko-fi",       "https://ko-fi.com/winnougan",               _cyan),
    ("YouTube",     "https://www.youtube.com/@Winnougan",        _red),
    ("Discord",     "https://discord.gg/CJv5wceJaN",             _magenta),
    ("HuggingFace", "https://huggingface.co/Winnougan",          _yellow),
    ("GitHub",      "https://github.com/Winnougan/Nougan_Nodes", _green),
]


def _banner():
    line = _magenta("═" * 62)
    print()
    print(line)
    print(f"  {_bold(_magenta('N O U G A N'))}  {_cyan('·')}  {_bold('ComfyUI node suite')}  {_dim('v' + VERSION)}")
    print(f"  {_dim('made with love by')} {_orange('Winnougan')}")
    print(line)
    print(f"  {_bold('Support & community')}")
    for name, url, color in SOCIALS:
        print(f"   {color('●')} {color(name.ljust(12))} {_dim(url)}")
    print(line)


def _footer(loaded, failed, total_nodes, skipped=()):
    line = _magenta("═" * 62)
    print(line)
    status = f"{OK} {_green(str(loaded) + ' modules loaded')}"
    if failed:
        status += f"   {FAIL} {_red(str(len(failed)) + ' failed')} {_dim('(' + ', '.join(failed) + ')')}"
    print(f"  {status}")
    if skipped:
        print(f"  {_dim('– ' + str(len(skipped)) + ' skipped (removed or disabled): ' + ', '.join(skipped))}")
    print(f"  {_cyan('◆')} {_bold(str(total_nodes))} nodes registered")
    if not failed:
        print(f"  {_yellow('★')} {_dim('Enjoying Nougan? Support on')} {_orange('Patreon')}{_dim(' / ')}{_cyan('Ko-fi')} {_dim('— thank you!')}")
    print(line)
    print()


# Fallback so the /nougan/krea2_loras route can never NameError.
def get_krea2_lora_status():
    return []


# ═════════════════════════════════════════════════════════════════════════════
# Feature table — each entry loads in its own try/except so ONE bad file
# can't take down the rest of the suite.
#   (label, module, [(node_id, class_name_in_module, display_name), ...])
# Use "*" as the class name to pull the module's own NODE_CLASS_MAPPINGS /
# NODE_DISPLAY_NAME_MAPPINGS instead (used by the RefMod toolkit).
# The same class may be registered under several node IDs (legacy aliases).
# ═════════════════════════════════════════════════════════════════════════════
_FEATURES = [
    # All-in-one loader: quantized diffusion model (bf16 / int8 / w4a8 / w6a8 convrot, auto-detected),
    # attention/efficiency backend switches (comfy-kitchen, sage 2/3, triton, flash 2, pytorch,
    # sparse attention, VSA), main + prompt-enhancer CLIPs, video/default + audio VAEs.
    # Boxed renamable drag-sortable DOM sections live in web/nougan_ultimate_loader.js.
    ("Ultimate Model Loader", "nougan_ultimate_loader", [
        ("NouganUltimateModelLoader", "NouganUltimateModelLoader", "Nougan Ultimate Model Loader 🚀"),
    ]),
    ("Get Image", "get_image", [
        ("NouganGetImage", "NouganGetImage", "Nougan Get Image 🖼️"),
    ]),
    ("Krea 2 Loader", "krea2_loader", [
        ("NouganKrea2Loader",      "NouganKrea2Loader",      "Nougan Krea 2 · LoRA 🌀"),
        ("NouganKrea2LoaderMulti", "NouganKrea2LoaderMulti", "Nougan Krea 2 · LoRA Stack 🌀"),
    ]),
    ("Text Encode + Zero Neg", "text_encode", [
        ("NouganTextEncodeZeroNeg", "NouganTextEncodeZeroNeg", "Nougan Text Encode + Zero Neg 🎯"),
    ]),
    ("Text Box", "text_box", [
        ("NouganTextBox", "NouganTextBox", "Nougan Text Box 📝"),
    ]),
    ("Title Font", "title_font", [
        ("NouganTitleFont", "NouganTitleFont", "Nougan Title Font 🌈"),
    ]),
    ("Remote Set / Get", "nougan_set_get", [
        ("NouganSet", "NouganSet", "Nougan Set (Remote) 📡"),
        ("NouganGet", "NouganGet", "Nougan Get (Remote) 📥"),
    ]),
    ("Power Lora Loader", "nougan_lora_loader", [
        ("NouganLoraLoader", "NouganLoraLoader", "Nougan Lora Loader 📁"),
    ]),
    ("Lora Inspector", "nougan_lora_inspector", [
        ("NouganLoraInspector", "NouganLoraInspector", "Nougan Lora Inspector 🔍"),
    ]),
    ("Mask Editor", "mask_editor", [
        ("NouganMaskEditor", "NouganMaskEditor", "Nougan Mask Editor 🎨"),
    ]),
    ("Mask Composite", "mask_composite", [
        ("NouganMaskComposite", "NouganMaskComposite", "Nougan Mask Composite 🎭"),
    ]),
    ("Regional Character LoRA", "nougan_regional_lora", [
        ("NouganRegionalCharacterLoRA", "NouganRegionalCharacterLoRA", "Nougan Regional Character LoRA 👥"),
        ("Krea2RegionalCharacterLoRA",  "NouganRegionalCharacterLoRA", "Nougan Regional Character LoRA 👥"),
        ("RegionalCharacterLora",       "NouganRegionalCharacterLoRA", "Nougan Regional Character LoRA 👥"),
    ]),
    ("Prompt Relay", "prompt_relay", [
        ("PromptRelayEncode",          "PromptRelayEncode",          "Nougan Prompt Relay Encode 🎬"),
        ("PromptRelayEncodeTimeline",  "PromptRelayEncodeTimeline",  "Nougan Prompt Relay Timeline 🎞️"),
        ("PromptRelayAdvancedOptions", "PromptRelayAdvancedOptions", "Nougan Prompt Relay Options ⚙️"),
    ]),
    ("LM Studio Bridge", "lm_studio", [
        ("NouganLMStudio",          "NouganLMStudio",          "Nougan LM Studio 🧠"),
        ("NouganLMStudioPromptBox", "NouganLMStudioPromptBox", "Nougan LM Studio Prompt Box 💬"),
    ]),
    ("Match Image Size", "nougan_match_size", [
        ("NouganMatchImageSize", "NouganMatchImageSize", "Nougan Match Image Size 📐"),
    ]),
    # Interactive compare (slider / box / diff / toggle / mask) for up to 4 images or batches, WebGPU backdrop + diff
    # heatmap with CSS / 2D fallbacks (web/nougan_compare.js). Replaces the old Before / After node. No KJNodes needed.
    ("Compare", "nougan_compare", [
        ("NouganCompare", "NouganCompare", "Nougan Compare"),
    ]),
    ("Edit Prompt Template", "nougan_edit_prompt", [
        ("NouganEditPromptTemplate", "NouganEditPromptTemplate", "Nougan Edit Prompt Template 🧩"),
    ]),
    ("MiniMax H3 Image Edit", "nougan_h3_edit", [
        ("NouganH3ImageEdit", "NouganH3ImageEdit", "Nougan MiniMax H3 · Image Edit 🎬"),
    ]),
    # Node IDs are kept as FolderImageBatchLoader / SaveCaptionMatchImage so
    # existing captioning workflows keep working. Only the display names are new.
    ("Folder Batch Loaders + Save Caption", "nougan_folder_batch", [
        ("FolderImageBatchLoader", "FolderImageBatchLoader", "Nougan Load Image Batch From Folder 📂"),
        ("FolderVideoBatchLoader", "FolderVideoBatchLoader", "Nougan Load Video Batch From Folder 🎞️"),
        ("SaveCaptionMatchImage",  "SaveCaptionMatchImage",  "Nougan Save Caption (Match Image/Video Name) 💾"),
    ]),
    ("Bounding Boxes", "nougan_bounding_boxes", [
        ("NouganBoundingBoxes", "NouganBoundingBoxes", "Nougan Bounding Boxes 🔲"),
    ]),
    ("Character Chat", "nougan_character_chat", [
        ("NouganCharacterChat", "NouganCharacterChat", "Nougan Character Chat 💬"),
    ]),
    ("V2 PNG Baker", "nougan_v2_png_baker", [
        ("NouganV2PNGBaker", "NouganV2PNGBaker", "Nougan V2 PNG Baker 🃏"),
    ]),
    ("Workflow PNG Baker", "nougan_workflow_png_baker", [
        ("NouganWorkflowPNGBaker", "NouganWorkflowPNGBaker", "Nougan Workflow PNG Baker 🧬"),
    ]),
    ("Refmod Baker", "nougan_refmod_baker", [
        ("NouganRefmodBaker", "NouganRefmodBaker", "Nougan Refmod Baker 🧬"),
    ]),
    # Bake / Loader / Apply — vendored MiniMaxH3Mod engine (MIT, Luisa).
    ("RefMod Toolkit", "nougan_refmod", "*"),
    # ONE Bake + ONE Apply for Qwen 2.1, MOSS-Image, Flux 3, Fibo 2 and LTX-2.5 (registry of handlers;
    # add a model by adding a Handler class). Reads the old per-model file formats unchanged.
    ("RefMods (unified)", "nougan_refmods", "*"),
    ("Album Cover Maker", "nougan_album_cover", [
        ("NouganAlbumCoverMaker", "NouganAlbumCoverMaker", "Nougan Album Cover Maker 💿"),
    ]),
    ("Layout LLM Prompt", "nougan_layout_llm", [
        ("NouganLayoutLLMPrompt", "NouganLayoutLLMPrompt", "Nougan Layout LLM Prompt 🧱"),
    ]),
    # Older/alternate video saver, has its own mappings. Remove if it's a leftover.
    ("Video Save (legacy)", "nougan_video_save", "*"),
    ("Image Converter", "nougan_image_converter", [
        ("NouganImageConverter", "NouganImageConverter", "Nougan Image Converter 🖼️"),
    ]),
    # Video / frames -> trimmed + cropped GIF / WebP / MP4 with a visual editor (web/nougan_gif_maker.js).
    # Needs ffmpeg on PATH or `pip install imageio-ffmpeg`. Registers its own /nougan/gif/* routes.
    ("GIF Maker", "nougan_gif_maker", [
        ("NouganGifMaker", "NouganGifMaker", "Nougan GIF Maker 🎞️"),
    ]),
    # Frames (+ audio) -> H.264 / HEVC / AV1 / VP9 / ProRes / FFV1 with player + scrub bar (web/nougan_save_video.js).
    # Needs ffmpeg on PATH or `pip install imageio-ffmpeg`. Registers its own /nougan/video_encoders route.
    ("Save Video", "nougan_save_video", [
        ("NouganSaveVideo", "NouganSaveVideo", "Nougan Save Video 🎬"),
    ]),
    # Duration (seconds) -> frame count: presets (MiniMax H3 17n+5 / 24 / 30 FPS) + lockable custom expression,
    # live preview (web/nougan_duration_frames.js). Registers /nougan/duration_frames/* routes.
    ("Duration -> Frames", "nougan_duration_frames", [
        ("NouganDurationFrames", "NouganDurationFrames", "Nougan Duration → Frames ⏱️"),
    ]),
    # MiniMax H3 only: seconds -> frames, hardwired to the 17n+5 grid at 24 FPS.
    # The expression is a hidden DOM textarea, unlocked by the edit_expression toggle
    # (web/nougan_h3_duration.js); toggle off = always the built-in default.
    ("MiniMax H3 Duration", "nougan_h3_duration", [
        ("NouganH3Duration", "NouganH3Duration", "Nougan MiniMax H3 · Duration ⏱️"),
    ]),
    # UI-only button node that reloads the browser tab (web/nougan_refresh_page.js). No inputs or outputs.
    ("Refresh Page", "nougan_refresh_page", [
        ("NouganRefreshPage", "NouganRefreshPage", "Nougan Refresh Page 🔄"),
    ]),
    # One node, many images: "+" adds a slot and a matching IMAGE output (web/nougan_multi_load_image.js).
    ("Multi Load Image", "nougan_multi_load_image", [
        ("NouganMultiLoadImage", "NouganMultiLoadImage", "Nougan Multi Load Image 🖼️➕"),
    ]),
    # Thumbnail-gallery loader: pick/paste a folder, magnify slider, scrub bar, click / shift / marquee select,
    # one IMAGE output (P1, P2, ...) per selected image (web/nougan_gallery_load.js + web/css/nougan_gallery_load.css).
    # Registers /nougan/gallery/{list,thumb,dirs} routes (local requests only).
    ("Gallery Load", "nougan_gallery_load", [
        ("NouganGalleryLoad", "NouganGalleryLoad", "Nougan Gallery Load 🗂️"),
    ]),
    # Load an audio file (AUDIO upload widget), crop it with a visual waveform editor:
    # drag the region edges to crop, drag anywhere to scrub with audible preview,
    # WebGPU waveform + Canvas2D fallback (web/nougan_audio_loader.js).
    ("Audio Loader", "nougan_audio_loader", [
        ("NouganAudioLoader", "NouganAudioLoader", "Nougan Audio Loader 🎵"),
    ]),
    # HandBrake-style transcode: IMAGE batch + AUDIO in -> visual trim/cut/crop editor
    # (cut list + magnetic timeline + draw-a-box crop, web/nougan_convert_video.js) ->
    # H.264/H.265/AV1 8/10-bit via ffmpeg, CPU or NVENC (auto-probed). Registers
    # its own /nougan/convert/* routes.
    ("Convert Video", "nougan_convert_video", [
        ("NouganConvertVideo", "NouganConvertVideo", "Nougan Convert Video 🎞️"),
    ]),
    # Gelbooru-style scraper: list URL in -> raw images to a folder in output/
    # (web/nougan_r34_scraper.js: live preview + progress bar). Optional
    # ImageMagick convert/compress + sequential rename. Registers /nougan/r34/state.
    ("R34 Scraper", "nougan_r34_scraper", [
        ("NouganR34Scraper", "NouganR34Scraper", "Nougan R34 Scraper 🕸️"),
    ]),
    # Pixiv scraper: artist / works URL in -> raw images to a folder in output/ (PHPSESSID cookie for
    # R-18 / locked works, see nougan_pixiv_credentials.example.json). Live preview + progress with a
    # WebGPU backdrop (CSS fallback) in web/nougan_pixiv_scraper.js. Registers /nougan/pixiv/* routes.
    ("Pixiv Scraper", "nougan_pixiv_scraper", [
        ("NouganPixivScraper", "NouganPixivScraper", "Nougan Pixiv Scraper 🅿️"),
    ]),
    ("Resolution Picker", "resolution_picker", [
        ("NouganResolutionPicker", "NouganResolutionPicker", "Nougan Resolution Picker"),
    ]),
    # Sister to the Resolution Picker: pick an upscale factor or a target MP count and get an H3-safe
    # width/height (same scale on both axes, snapped to the 16 px latent grid) for
    # MiniMax H3 Latent Upscale With Model. Animated preview lives in web/nougan_h3_upscale_picker.js.
    ("H3 Upscale Picker", "nougan_h3_upscale_picker", [
        ("NouganH3UpscalePicker", "NouganH3UpscalePicker", "Nougan H3 Upscale Picker 📈"),
    ]),
    # Pre-flight check + auto-fix for MiniMax H3 clips: frame count on the 17n+5 grid, dims on the 16 px grid,
    # fps, audio half, IMAGE <-> latent cross-check. Keeps a wired IMAGE / AUDIO in sync with the latent.
    # Live DOM checklist in web/nougan_h3_clip_doctor.js. No extra dependencies.
    ("H3 Clip Doctor", "nougan_h3_clip_doctor", [
        ("NouganH3ClipDoctor", "NouganH3ClipDoctor", "Nougan H3 Clip Doctor 🩺"),
    ]),
    # Mirrors KJNodes' Model Preview Override live preview on its own node (web/nougan_preview_mirror.js).
    # Needs KJNodes installed. No model input = follow any preview; connect a model to follow just that one.
    ("Model Preview Mirror", "nougan_preview_mirror", [
        ("NouganModelPreviewMirror", "NouganModelPreviewMirror", "Nougan Model Preview Mirror 🪞"),
    ]),
    # ONE sampler for everything, MiniMax H3 included. CFG is a plain number (0 = CFG-free
    # positive-only BasicGuider; no negative wired = positive-only at any cfg). Optional
    # guider / noise / sampler / sigmas inputs win over the widgets they replace; without a
    # guider, model + positive builds BasicGuider/CFGGuider. Built-in + ClownsharK samplers,
    # bongmath toggle, chainsampling, VAE + audio-VAE decode, image/video + audio out,
    # live preview + WebGPU progress bar (web/nougan_ultimate_ksampler.js).
    # RES4LYF is the only soft dependency; the live preview is vendored in nougan_preview_override.py.
    ("Ultimate KSampler", "nougan_ultimate_ksampler", [
        ("NouganUltimateKSampler", "NouganUltimateKSampler", "Nougan Ultimate KSampler"),
        # Legacy alias: old MiniMax H3 workflows load into the unified node instead of
        # erroring. Same class, same panel. Delete this line once your graphs are migrated.
        ("NouganH3KSampler", "NouganUltimateKSampler", "Nougan Ultimate KSampler (H3 legacy) 🎬"),
    ]),
    # Batch stopwatch: elapsed / progress / avg per item / ETA / finish time, WebGPU shader backdrop
    # (web/nougan_timer.js). Registers /nougan_timer/state and /nougan_timer/reset routes.
    ("Timer", "nougan_timer", [
        ("NouganTimer", "NouganTimer", "Nougan Timer ⏱️"),
    ]),
    # Sketch pad that behaves like Load Image: draw poses/guides with mouse or stylus (pressure), colour wheel,
    # layers, undo; outputs IMAGE + MASK (web/nougan_draw_image.js). Saves PNGs to input/nougan_draw/.
    ("Draw Image", "nougan_draw_image", [
        ("NouganDrawImage", "NouganDrawImage", "Nougan Draw Image ✏️"),
    ]),
    # Server half of the Paste Stack widget: lets a single click paste FILES you copied in Explorer/Finder
    # (browsers can't read those). Registers /nougan/paste_stack/clipboard, local requests only. No nodes.
    ("Paste Stack clipboard helper", "nougan_paste_stack_server", []),
]

# Frontend-only features: no Python module, no nodes, just a script in WEB_DIRECTORY that ComfyUI
# serves and loads on its own. Listed here so the banner confirms the file is actually present.
#   (label, filename inside ./web, [extra files that must sit beside it, e.g. a stylesheet])
_WEB_ONLY = [
    # Hold Z and drag across wires to bundle them into zip-tie ribbons. Based on safzan's ZipTies;
    # stands down if the original safzan.ZipTies extension is also installed.
    ("Zip Ties", "nougan_zip_ties.js"),
    # Hold B and slash across nodes to bypass them (or mute, see settings); slash again to restore.
    ("Bypass Slash", "nougan_bypass_slash.js"),
    # Figma-style alignment guides + snapping while dragging nodes; Alt+L / canvas menu tidies nodes into columns by dependency depth.
    ("Smart Guides", "nougan_smart_guides.js"),
    # Hold V and drag a box over nodes to make a subgraph; box a subgraph to unpack it.
    ("Subgraph Box", "nougan_subgraph_box.js"),
    # Hold G and drag a box over nodes to wrap them in a group; box a whole group to ungroup it.
    ("Group Box", "nougan_group_box.js"),
    # Hold S and click a group's title (or slash across several) to bypass everything inside; again to restore.
    ("Group Switch", "nougan_group_switch.js"),
    # Hold C and drag node -> node to connect the best matching sockets (Shift = all, Alt = hide links); hold C and
    # drag across wires to cut them. Live preview HUD, auto-reverse, drop on a socket to force it, Esc cancels.
    # Legacy Alt/Ctrl/Shift + RMB gestures kept. Based on CRZ Node Wrangler.
    ("Node Wrangler", "nougan_node_wrangler.js"),
    # Floating, dockable panel: reads the loaded checkpoint / CLIP / VAE / every sampler / LoRAs and edits
    # the real node values live (no cables). Stylesheet lives in web/css/.
    ("Automagic 2222: Live Panel", "nougan_live_panel.js", "css/nougan_live_panel.css"),
    # Floating clipboard-history widget: click to paste text/images into a saved stack, click a saved card to copy it
    # back. Square panel that minimizes to a small chip; WebGPU backdrop (CSS fallback). Stack lives in IndexedDB.
    ("Automagic 2222: Paste Stack", "nougan_paste_stack.js", "css/nougan_paste_stack.css"),
]

_HERE = os.path.dirname(os.path.abspath(__file__))


def _module_present(module_name):
    """True if the module's file (or package folder) still exists. A node you deleted on purpose is
    skipped quietly; a file that exists but fails to import is still reported as a real failure."""
    return (os.path.isfile(os.path.join(_HERE, module_name + ".py"))
            or os.path.isdir(os.path.join(_HERE, module_name)))


def _read_disabled():
    """Optional nougan_disabled.txt next to this file: one module name or feature label per line
    ('#' starts a comment). Lets you switch features off without deleting files, so updates
    can't bring them back."""
    try:
        with open(os.path.join(_HERE, "nougan_disabled.txt"), encoding="utf-8") as f:
            lines = (ln.split("#", 1)[0].strip().lower() for ln in f)
            return {ln for ln in lines if ln}
    except OSError:
        return set()


def _load_feature(label, module_name, spec):
    """Import one module and register its nodes. Returns node count; raises on failure."""
    mod = importlib.import_module(f".{module_name}", package=__name__)

    # Module-provided mappings (RefMod toolkit)
    if spec == "*":
        classes = dict(mod.NODE_CLASS_MAPPINGS)
        NODE_CLASS_MAPPINGS.update(classes)
        NODE_DISPLAY_NAME_MAPPINGS.update(mod.NODE_DISPLAY_NAME_MAPPINGS)
        return len(classes)

    # Resolve everything first so a missing class registers nothing (all-or-nothing).
    resolved = [(nid, getattr(mod, cls), display) for nid, cls, display in spec]
    for nid, cls, display in resolved:
        NODE_CLASS_MAPPINGS[nid] = cls
        NODE_DISPLAY_NAME_MAPPINGS[nid] = display

    # Krea 2 exposes a LoRA status helper that the /nougan/krea2_loras route uses.
    if module_name == "krea2_loader":
        global get_krea2_lora_status
        get_krea2_lora_status = getattr(mod, "get_krea2_lora_status", get_krea2_lora_status)

    return len(resolved)


# ═════════════════════════════════════════════════════════════════════════════
# Load everything
# ═════════════════════════════════════════════════════════════════════════════
_banner()
_loaded = 0
_failed = []
_skipped = []
_disabled = _read_disabled()

for _label, _module, _spec in _FEATURES:
    if _label.lower() in _disabled or _module.lower() in _disabled or not _module_present(_module):
        _skipped.append(_label)
        continue
    try:
        _n = _load_feature(_label, _module, _spec)
        _loaded += 1
        _plural = "node" if _n == 1 else "nodes"
        print(f"  {OK} {_bold(_label)} {_dim(f'({_n} {_plural})')}")
    except Exception as _e:
        _failed.append(_label)
        print(f"  {FAIL} {_red(_label)} {_dim('NOT loaded —')} {_yellow(type(_e).__name__ + ': ' + str(_e))}")
        traceback.print_exc()

_web_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), WEB_DIRECTORY)
for _label, _file, *_extra in _WEB_ONLY:
    if not os.path.isfile(os.path.join(_web_dir, _file)):
        _skipped.append(_label)  # main script removed on purpose
        continue
    _missing = [f for f in (_file, *_extra) if not os.path.isfile(os.path.join(_web_dir, f))]
    if not _missing:
        _loaded += 1
        print(f"  {OK} {_bold(_label)} {_dim('(web extension)')}")
    else:
        _failed.append(_label)
        print(f"  {FAIL} {_red(_label)} {_dim('NOT loaded —')} {_yellow('missing web/' + ', web/'.join(_missing))}")


# ═════════════════════════════════════════════════════════════════════════════
# Routes — always attempted, fully guarded
# ═════════════════════════════════════════════════════════════════════════════
_NOUGAN_ROUTES_REGISTERED = False


def _register_routes():
    global _NOUGAN_ROUTES_REGISTERED
    if _NOUGAN_ROUTES_REGISTERED:
        return
    try:
        from server import PromptServer
        from aiohttp import web
    except Exception:
        return
    try:
        routes = PromptServer.instance.routes
    except Exception:
        return
    try:
        @routes.get("/nougan/krea2_loras")
        async def _krea2_loras(_request):
            try:
                return web.json_response({"loras": get_krea2_lora_status()})
            except Exception:
                return web.json_response({"loras": []})

        @routes.get("/nougan/loras")
        async def _nougan_loras(_request):
            try:
                import folder_paths as _fp
                names = [str(x).replace(os.sep, "/") for x in _fp.get_filename_list("loras")]
            except Exception:
                names = []
            return web.json_response(names)

        @routes.get("/nougan/socials")
        async def _nougan_socials(_request):
            return web.json_response({n: u for n, u, _ in SOCIALS})

        _NOUGAN_ROUTES_REGISTERED = True
        print(f"  {OK} {_bold('Routes registered')}")
    except Exception as _e:
        print(f"  {WARN} {_yellow('Could not register routes:')} {_e}")


_register_routes()
_footer(_loaded, _failed, len(NODE_CLASS_MAPPINGS), _skipped)

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]