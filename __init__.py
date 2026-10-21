# __init__.py  —  Nougan suite by Winnougan
import os
import sys
import traceback
import importlib

WEB_DIRECTORY = "./web"
VERSION = "1.0"  # edit me

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

# ═════════════════════════════════════════════════════════════════════════════
#  Pretty console output (ANSI). Set NO_COLOR=1 in your environment to disable.
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
    ("Patreon",     "https://www.patreon.com/c/Winnougan",        _orange),
    ("Ko-fi",       "https://ko-fi.com/winnougan",                _cyan),
    ("YouTube",     "https://www.youtube.com/@Winnougan",         _red),
    ("Discord",     "https://discord.gg/CJv5wceJaN",              _magenta),
    ("HuggingFace", "https://huggingface.co/Winnougan",           _yellow),
    ("GitHub",      "https://github.com/Winnougan/Nougan_No",     _green),
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


def _footer(loaded, failed, total_nodes):
    line = _magenta("═" * 62)
    print(line)
    status = f"{OK} {_green(str(loaded) + ' modules loaded')}"
    if failed:
        status += f"   {FAIL} {_red(str(len(failed)) + ' failed')} {_dim('(' + ', '.join(failed) + ')')}"
    print(f"  {status}")
    print(f"  {_cyan('◆')} {_bold(str(total_nodes))} nodes registered")
    if not failed:
        print(f"  {_yellow('★')} {_dim('Enjoying Nougan? Support on')} {_orange('Patreon')}{_dim(' / ')}{_cyan('Ko-fi')} {_dim('— thank you!')}")
    print(line)
    print()


# Fallback so the /nougan/krea2_loras route can never NameError.
def get_krea2_lora_status():
    return []


# ═════════════════════════════════════════════════════════════════════════════
#  Feature table — each entry loads in its own try/except so ONE bad file
#  can't take down the rest of the suite.
#
#  (label, module, [(node_id, class_name_in_module, display_name), ...])
#  Use "*" as the class name to pull the module's own NODE_CLASS_MAPPINGS /
#  NODE_DISPLAY_NAME_MAPPINGS instead (used by the RefMod toolkit).
#  The same class may be registered under several node IDs (legacy aliases).
# ═════════════════════════════════════════════════════════════════════════════
_FEATURES = [
    ("Diffusers Loader", "diffusers_loader", [
        ("NouganDiffusersLoader", "NouganDiffusersLoader", "Nougan Diffusers Loader 🚀"),
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
        ("RegionalCharacterLora",        "NouganRegionalCharacterLoRA", "Nougan Regional Character LoRA 👥"),
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
    ("Before / After Compare", "nougan_before_after", [
        ("NouganBeforeAfterCompare", "NouganBeforeAfterCompare", "Nougan Before / After 🔀"),
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
    # Bake / Encode for Qwen Image 2.1 (own file format, no engine dependency).
    ("Qwen 2.1 RefMod", "nougan_qwen_refmod", "*"),
    # Bake / Encode for MOSS-Image edit models (needs the Ostris edit patch for generation).
    ("MOSS RefMod", "nougan_moss_refmod", "*"),
    # Bake / Encode for Krea 2 edit LoRAs (needs the Ostris Krea 2 edit patch for generation).
    ("Krea 2 RefMod", "nougan_krea2_refmod", "*"),
    ("Image Converter", "nougan_image_converter", [
        ("NouganImageConverter", "NouganImageConverter", "Nougan Image Converter 🖼️"),
    ]),
]


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
#  Load everything
# ═════════════════════════════════════════════════════════════════════════════
_banner()

_loaded = 0
_failed = []

for _label, _module, _spec in _FEATURES:
    try:
        _n = _load_feature(_label, _module, _spec)
        _loaded += 1
        _plural = "node" if _n == 1 else "nodes"
        print(f"  {OK} {_bold(_label)} {_dim(f'({_n} {_plural})')}")
    except Exception as _e:
        _failed.append(_label)
        print(f"  {FAIL} {_red(_label)} {_dim('NOT loaded —')} {_yellow(type(_e).__name__ + ': ' + str(_e))}")
        traceback.print_exc()


# ═════════════════════════════════════════════════════════════════════════════
#  Routes — always attempted, fully guarded
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

_footer(_loaded, _failed, len(NODE_CLASS_MAPPINGS))

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
