// Automagic 2222: Live Panel, output preview.
//
// Shows the finished result of output nodes (SaveImage, PreviewImage, SaveVideo, SaveAudio, VHS
// Video Combine, ...) inside the panel: images, animated images, video and audio. It listens to
// ComfyUI's normal "executed" event, so no extra node is needed.
//
//   * Results of the latest run are kept; a new run replaces them.
//   * If an output node is pinned in the Run selected row, only that node is shown.
//     Otherwise every output of the latest run is shown, one at a time (arrows to step through).
//   * Click the media or the open button to view the file full size in a new tab.
//
// While it is switched off it holds no listener and no media element.
//
// Put this file next to nougan_live_panel.js in web/.

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const STYLE_ID = "nlp-outprev-stylesheet";
const LS_COLLAPSED = "nlp.outprev.collapsed";

const VIDEO_EXT = /\.(mp4|webm|mov|mkv|m4v|avi)$/i;
const AUDIO_EXT = /\.(wav|mp3|flac|ogg|opus|m4a|aac)$/i;

const SVG = (body) => `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const ICON_PREV = SVG('<path d="M10 3.5L5.5 8 10 12.5"/>');
const ICON_NEXT = SVG('<path d="M6 3.5L10.5 8 6 12.5"/>');
const ICON_OPEN = SVG('<path d="M9 2.5h4.5V7M13.5 2.5L7.5 8.5M12 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3"/>');

const CSS = `
.nlp-op{flex:0 0 auto;border-bottom:1px solid var(--nlp-border,#3a3a3a);background:var(--nlp-bg,#1e1e1e);color:var(--nlp-fg,#d4d4d4);
  font:11px/1.35 system-ui,-apple-system,"Segoe UI",sans-serif;font-variant-numeric:tabular-nums}
.nlp-op-bar{display:flex;align-items:center;gap:6px;min-height:27px;box-sizing:border-box;padding:4px 10px;background:var(--nlp-head,#262626)}
.nlp-op-chev{background:transparent;border:0;color:var(--nlp-dim,#8a8a8a);cursor:pointer;padding:0 2px;font-size:11px;line-height:1}
.nlp-op-title{font-weight:600;white-space:nowrap}
.nlp-op-src{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0 6px;border-radius:999px;font-size:10px;line-height:16px;color:var(--nlp-accent,#e67e22);
  background:rgba(128,128,128,.16);background:color-mix(in srgb,var(--nlp-accent,#e67e22) 16%,transparent)}
.nlp-op-sp{flex:1 1 auto}
.nlp-op-count{font-size:10px;color:var(--nlp-dim,#8a8a8a);white-space:nowrap}
.nlp-op-btn{display:inline-flex;align-items:center;justify-content:center;width:22px;height:20px;padding:0;background:transparent;color:var(--nlp-dim,#8a8a8a);border:1px solid transparent;border-radius:4px;cursor:pointer}
.nlp-op-btn:hover:not(:disabled){background:var(--nlp-input,#121212);color:var(--nlp-fg,#d4d4d4)}
.nlp-op-btn:disabled{opacity:.35;cursor:default}
.nlp-op-area{position:relative;display:flex;align-items:center;justify-content:center;min-height:90px;max-height:260px;overflow:hidden;background:#09090b}
.nlp-op-collapsed .nlp-op-area{display:none}
.nlp-op-media{display:block;max-width:100%;max-height:260px;object-fit:contain;cursor:zoom-in}
.nlp-op-area video.nlp-op-media{cursor:default;width:100%}
.nlp-op-audio{width:100%;box-sizing:border-box;padding:14px 10px;display:flex;flex-direction:column;gap:8px;align-items:stretch}
.nlp-op-audio audio{width:100%;height:34px}
.nlp-op-fname{font-size:10px;color:var(--nlp-dim,#8a8a8a);text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nlp-op-empty{padding:0 18px;text-align:center;color:var(--nlp-dim,#8a8a8a);font-size:10px}
`;

function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = CSS;
    document.head.appendChild(s);
}

const $ = (tag, cls, parent) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (parent) parent.appendChild(e);
    return e;
};

function fileUrl(f) {
    const q = new URLSearchParams({ filename: f.filename, subfolder: f.subfolder || "", type: f.type || "output" });
    return api.apiURL("/view?" + q.toString());
}

function kindOf(f, hint) {
    const name = f.filename || "";
    if (f.format && /^video\//i.test(f.format)) return "video";
    if (f.format && /^audio\//i.test(f.format)) return "audio";
    if (VIDEO_EXT.test(name)) return "video";
    if (AUDIO_EXT.test(name)) return "audio";
    return hint === "audio" ? "audio" : hint === "video" ? "video" : "image";
}

// ComfyUI puts results under different keys depending on the node.
function mediaFrom(output) {
    const found = [];
    const take = (list, hint) => {
        if (!Array.isArray(list)) return;
        for (const f of list) {
            if (f && typeof f === "object" && f.filename) found.push({ f, kind: kindOf(f, hint) });
        }
    };
    take(output.images, "image");
    take(output.gifs, "video");
    take(output.video, "video");
    take(output.videos, "video");
    take(output.audio, "audio");
    return found;
}

function rootId(id) { return String(id).split(":")[0]; }

function nodeTitle(id) {
    const g = app.rootGraph || app.graph;
    const n = g?.getNodeById?.(Number(id));
    return n ? `${n.title || n.type} #${id}` : `Node #${id}`;
}

export function createOutputPreview({ getFilter } = {}) {
    ensureStyles();

    const root = $("div", "nlp-op");
    const bar = $("div", "nlp-op-bar", root);
    const chev = $("button", "nlp-op-chev", bar);
    chev.type = "button";
    $("span", "nlp-op-title", bar).textContent = "Output";
    const src = $("span", "nlp-op-src", bar);
    $("span", "nlp-op-sp", bar);
    const count = $("span", "nlp-op-count", bar);
    const prev = $("button", "nlp-op-btn", bar);
    prev.type = "button"; prev.innerHTML = ICON_PREV; prev.title = "Previous result";
    const next = $("button", "nlp-op-btn", bar);
    next.type = "button"; next.innerHTML = ICON_NEXT; next.title = "Next result";
    const open = $("button", "nlp-op-btn", bar);
    open.type = "button"; open.innerHTML = ICON_OPEN; open.title = "Open full size in a new tab";
    const area = $("div", "nlp-op-area", root);

    let items = [];          // every result of the latest run: { nodeId, kind, name, url }
    let promptId = null;
    let idx = 0;
    let enabled = false;
    let collapsed = false;
    try { collapsed = localStorage.getItem(LS_COLLAPSED) === "1"; } catch {}

    const visible = () => {
        const f = getFilter?.();
        return f ? items.filter((it) => f.includes(it.nodeId)) : items;
    };

    function disposeMedia() {
        for (const m of area.querySelectorAll("video,audio")) {
            try { m.pause(); m.removeAttribute("src"); m.load(); } catch {}
        }
        area.replaceChildren();
    }

    function render() {
        root.classList.toggle("nlp-op-collapsed", collapsed);
        chev.textContent = collapsed ? "\u25B8" : "\u25BE";
        chev.title = collapsed ? "Show output" : "Hide output";

        const list = visible();
        if (idx >= list.length) idx = Math.max(0, list.length - 1);
        const it = list[idx];

        prev.disabled = next.disabled = list.length < 2;
        open.disabled = !it;
        count.textContent = list.length > 1 ? `${idx + 1}/${list.length}` : "";
        src.textContent = it ? nodeTitle(it.nodeId) : "";
        src.style.display = it ? "" : "none";

        disposeMedia();
        if (collapsed) return;

        if (!it) {
            const filter = getFilter?.();
            const msg = $("div", "nlp-op-empty", area);
            msg.textContent = filter
                ? "Nothing yet from the pinned output node. Run it to see the result here."
                : "Run an output node to see its result here.";
            return;
        }

        if (it.kind === "video") {
            const v = $("video", "nlp-op-media", area);
            v.controls = true; v.loop = true; v.muted = true; v.autoplay = true; v.playsInline = true;
            v.src = it.url;
            v.play?.().catch(() => {});
        } else if (it.kind === "audio") {
            const box = $("div", "nlp-op-audio", area);
            const a = $("audio", null, box);
            a.controls = true; a.src = it.url;
            $("div", "nlp-op-fname", box).textContent = it.name;
        } else {
            const img = $("img", "nlp-op-media", area);
            img.src = it.url;
            img.alt = it.name;
            img.title = "Click to open full size";
            img.addEventListener("click", () => window.open(it.url, "_blank", "noopener"));
        }
    }

    // ---- events ----
    function onExecuted(e) {
        const d = e.detail;
        const out = d?.output;
        if (!out) return;
        const media = mediaFrom(out);
        if (!media.length) return;
        const nodeId = rootId(d.display_node ?? d.node);

        if (d.prompt_id !== promptId) { promptId = d.prompt_id; items = []; idx = 0; }
        for (const { f, kind } of media) {
            items.push({ nodeId, kind, name: f.filename, url: fileUrl(f) });
        }
        // jump to the newest result of the node(s) we are showing
        const list = visible();
        if (list.length) idx = list.length - 1;
        render();
    }

    const onPrev = () => { const n = visible().length; if (n) { idx = (idx - 1 + n) % n; render(); } };
    const onNext = () => { const n = visible().length; if (n) { idx = (idx + 1) % n; render(); } };
    const onOpen = () => { const it = visible()[idx]; if (it) window.open(it.url, "_blank", "noopener"); };
    const onChev = () => {
        collapsed = !collapsed;
        try { localStorage.setItem(LS_COLLAPSED, collapsed ? "1" : "0"); } catch {}
        render();
    };

    function setEnabled(on) {
        on = !!on;
        root.style.display = on ? "" : "none";
        if (on === enabled) return;
        enabled = on;
        if (on) {
            api.addEventListener("executed", onExecuted);
            prev.addEventListener("click", onPrev);
            next.addEventListener("click", onNext);
            open.addEventListener("click", onOpen);
            chev.addEventListener("click", onChev);
            render();
        } else {
            api.removeEventListener("executed", onExecuted);
            prev.removeEventListener("click", onPrev);
            next.removeEventListener("click", onNext);
            open.removeEventListener("click", onOpen);
            chev.removeEventListener("click", onChev);
            disposeMedia();
        }
    }

    function destroy() {
        setEnabled(false);
        items = [];
        root.remove();
    }

    root.style.display = "none";
    return { el: root, setEnabled, destroy, refresh: () => { if (enabled) render(); } };
}
