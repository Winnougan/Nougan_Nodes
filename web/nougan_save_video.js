// Nougan Save Video - in-node player with filmstrip + waveform timeline, level meter,
// encode progress ring, draggable A-B loop, frame snapshot, info chips and encoder status.
// Pairs with nougan_save_video.py (sends ui.nougan_video, serves /nougan/video_encoders).
//
// v2 player: never autoplays (big play button + paused first frame), rAF-coalesced scrubbing
// (no seek pile-up), frame-accurate stepping with press-and-hold, SVG icon buttons, speed menu,
// hover-reveal volume, draggable A/B handles, keyboard shortcuts, requestVideoFrameCallback UI sync.
//
// Shortcuts (click the player first):  Space/K play   ←/→ frame   Shift+←/→ 1 s   , . frame
//   Home/End jump   I/O set loop in/out   L loop   M mute   F fullscreen   double-click = fullscreen

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_ID = "NouganSaveVideo";
const ADVANCED = ["speed", "encoder", "bit_depth", "resize", "audio_bitrate", "embed_workflow", "preview_proxy"];
const KIND_LABEL = { h264: "H.264", hevc: "HEVC", av1: "AV1", vp9: "VP9", prores: "ProRes", ffv1: "FFV1" };
const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];
const STRIP_H = 36;
const WAVE_H = 24;
const WAVE_MAX_BYTES = 150 * 1048576; // do not decode giant files just to draw a waveform

// ---------------------------------------------------------------- icons (24x24, Lucide-style)

// [filled?, markup]
const ICONS = {
    play:    [true,  '<path d="M8 5v14l11-7z"/>'],
    pause:   [true,  '<path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/>'],
    back:    [true,  '<path d="M6 5h2v14H6zM20 5v14L9 12z"/>'],
    fwd:     [true,  '<path d="M16 5h2v14h-2zM4 5v14l11-7z"/>'],
    loop:    [false, '<path d="M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3"/>'],
    vol:     [false, '<path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/>'],
    muted:   [false, '<path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M22 9l-6 6M16 9l6 6"/>'],
    camera:  [false, '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>'],
    full:    [false, '<path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/>'],
    copy:    [false, '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'],
    check:   [false, '<path d="M20 6L9 17l-5-5"/>'],
    cross:   [false, '<path d="M18 6L6 18M6 6l12 12"/>'],
};
const iconSvg = (name) => {
    const [filled, body] = ICONS[name];
    return `<svg viewBox="0 0 24 24" class="${filled ? "f" : ""}" aria-hidden="true">${body}</svg>`;
};
const setIcon = (btn, name) => { btn.innerHTML = iconSvg(name); };

// ---------------------------------------------------------------- styles

function injectStyles() {
    // Replace on hot-reload so CSS edits are picked up without a full page refresh.
    document.getElementById("nougan-sv-style")?.remove();
    const style = document.createElement("style");
    style.id = "nougan-sv-style";
    style.textContent = `
.nsv { box-sizing: border-box; display: flex; flex-direction: column; gap: 6px; width: 100%; height: 100%;
  padding: 6px; font: 12px/1.3 system-ui, sans-serif; color: #e8e6f0; user-select: none; outline: none;
  container-type: inline-size; }
.nsv * { box-sizing: border-box; }
.nsv-stage { position: relative; flex: 1 1 auto; min-height: 120px; border-radius: 10px; overflow: hidden; cursor: pointer;
  background: radial-gradient(circle at 30% 20%, #2a2140, #0d0b14); border: 1px solid #3b2f5c; }
.nsv-stage video { width: 100%; height: 100%; object-fit: contain; display: block; background: #000; }
.nsv-empty { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center;
  justify-content: center; gap: 4px; color: #8f86b3; text-align: center; padding: 12px; pointer-events: none; }
.nsv-empty b { font-size: 14px; color: #b9aee6; }
.nsv-badge { position: absolute; top: 6px; left: 6px; padding: 2px 8px; border-radius: 999px; font-weight: 600;
  background: rgba(20, 14, 36, .78); border: 1px solid #5b47a0; color: #d9ceff; pointer-events: none; }
.nsv-time { position: absolute; top: 6px; right: 6px; padding: 2px 8px; border-radius: 6px; font-variant-numeric: tabular-nums;
  background: rgba(20, 14, 36, .78); color: #fff; pointer-events: none; }
.nsv-meter { position: absolute; right: 6px; bottom: 6px; width: 16px; height: 72px; border-radius: 4px;
  background: rgba(20, 14, 36, .6); pointer-events: none; display: none; }
.nsv-flash { position: absolute; inset: 0; background: #fff; opacity: 0; pointer-events: none; }
.nsv-flash.go { animation: nsvflash .35s ease-out; }
@keyframes nsvflash { 0% { opacity: .55; } 100% { opacity: 0; } }

.nsv-big { position: absolute; left: 50%; top: 50%; width: 64px; height: 64px; margin: -32px 0 0 -32px; border-radius: 50%;
  display: none; align-items: center; justify-content: center; color: #fff; pointer-events: none;
  background: rgba(20, 14, 36, .72); border: 1px solid #8e6bff; backdrop-filter: blur(2px);
  box-shadow: 0 4px 24px rgba(0, 0, 0, .5); transition: transform .15s ease; }
.nsv-big.on { display: flex; animation: nsvpop .18s ease-out; }
.nsv-big svg { width: 28px; height: 28px; margin-left: 3px; fill: currentColor; }
.nsv-stage:hover .nsv-big { transform: scale(1.08); }
@keyframes nsvpop { from { opacity: 0; transform: scale(.8); } to { opacity: 1; transform: scale(1); } }

.nsv-prog { position: absolute; inset: 0; display: none; flex-direction: column; align-items: center; justify-content: center;
  gap: 8px; background: rgba(10, 7, 20, .72); backdrop-filter: blur(3px); pointer-events: none; }
.nsv-prog.on { display: flex; }
.nsv-ring { --p: 0; position: relative; width: 92px; height: 92px; border-radius: 50%;
  background: conic-gradient(#ff7ad9 calc(var(--p) * 1%), #2b2347 0); display: flex; align-items: center; justify-content: center; }
.nsv-ring::before { content: ""; position: absolute; inset: 8px; border-radius: 50%; background: #120e20; }
.nsv-ring span { position: relative; font-size: 18px; font-weight: 700; font-variant-numeric: tabular-nums; }
.nsv-ring.spin { background: conic-gradient(from 0deg, #ff7ad9 0 25%, #2b2347 0); animation: nsvspin 1s linear infinite; }
.nsv-ring.spin span { display: none; }
@keyframes nsvspin { to { transform: rotate(360deg); } }
.nsv-prog small { color: #b9aee6; }

.nsv-bar { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.nsv-grp { display: flex; align-items: center; gap: 3px; }
.nsv-sep { width: 1px; height: 18px; margin: 0 3px; background: #3b2f5c; }
.nsv .nsv-btn { appearance: none; -webkit-appearance: none; margin: 0; font: inherit; font-weight: 600; cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center; min-width: 30px; height: 28px; padding: 0 7px;
  border-radius: 7px; background: #2b2347; border: 1px solid #45367a; color: #e8e6f0; touch-action: manipulation;
  transition: background .12s, border-color .12s, transform .08s; }
.nsv .nsv-btn:hover { background: #3a2f63; border-color: #5b47a0; }
.nsv .nsv-btn:active { transform: scale(.93); }
.nsv .nsv-btn:focus-visible { outline: 2px solid #8e6bff; outline-offset: 1px; }
.nsv .nsv-btn.on { background: #6a46d8; border-color: #8e6bff; }
.nsv .nsv-btn.armed { background: #8f6a1f; border-color: #ffd36b; }
.nsv .nsv-btn.primary { min-width: 38px; background: linear-gradient(180deg, #7b55ec, #5a3bc2); border-color: #9b7cff; }
.nsv .nsv-btn.primary:hover { background: linear-gradient(180deg, #8d69f5, #6847d6); }
.nsv .nsv-btn svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2;
  stroke-linecap: round; stroke-linejoin: round; pointer-events: none; }
.nsv .nsv-btn svg.f { fill: currentColor; stroke: none; }
.nsv .nsv-btn.txt { min-width: 40px; font-variant-numeric: tabular-nums; }

.nsv-vg { display: flex; align-items: center; }
.nsv-volwrap { display: flex; align-items: center; width: 0; overflow: hidden; opacity: 0;
  transition: width .18s ease, opacity .18s ease, margin .18s ease; }
.nsv-vg:hover .nsv-volwrap, .nsv-vg:focus-within .nsv-volwrap { width: 76px; opacity: 1; margin: 0 4px 0 6px; }
.nsv-vol { --v: 100%; appearance: none; -webkit-appearance: none; width: 70px; height: 4px; margin: 0; border-radius: 2px;
  background: linear-gradient(90deg, #8e6bff var(--v), #3a2f63 var(--v)); outline: none; cursor: pointer; }
.nsv-vol:disabled { opacity: .4; cursor: default; }
.nsv-vol::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 12px; height: 12px; border-radius: 50%;
  background: #fff; border: 0; box-shadow: 0 0 0 3px rgba(142, 107, 255, .35); }
.nsv-vol::-moz-range-thumb { width: 12px; height: 12px; border-radius: 50%; background: #fff; border: 0;
  box-shadow: 0 0 0 3px rgba(142, 107, 255, .35); }
.nsv-spacer { flex: 1 1 auto; }

.nsv-rate { position: relative; }
.nsv-menu { position: absolute; bottom: calc(100% + 6px); left: 50%; transform: translateX(-50%); display: none;
  flex-direction: column; gap: 1px; padding: 4px; border-radius: 9px; background: #1a1430; border: 1px solid #5b47a0;
  box-shadow: 0 8px 22px rgba(0, 0, 0, .6); z-index: 20; }
.nsv-menu.on { display: flex; animation: nsvpop .12s ease-out; }
.nsv .nsv-mi { appearance: none; -webkit-appearance: none; margin: 0; font: inherit; cursor: pointer; border: 0; text-align: center;
  min-width: 54px; padding: 5px 10px; border-radius: 6px; background: transparent; color: #d9ceff; font-variant-numeric: tabular-nums; }
.nsv .nsv-mi:hover { background: #3a2f63; }
.nsv .nsv-mi.sel { background: #6a46d8; color: #fff; }

.nsv-scrub { position: relative; width: 100%; height: ${STRIP_H + WAVE_H + 6}px; cursor: pointer; touch-action: none;
  border-radius: 8px; overflow: visible; background: #120e20; border: 1px solid #3b2f5c; transition: border-color .12s; outline: none; }
.nsv-scrub:hover { border-color: #5b47a0; }
.nsv-scrub:focus-visible { border-color: #8e6bff; }
.nsv-scrub canvas { position: absolute; left: 0; pointer-events: none; }
.nsv-strip { top: 0; width: 100%; height: ${STRIP_H}px; border-radius: 7px 7px 0 0; }
.nsv-wave { top: ${STRIP_H + 2}px; height: ${WAVE_H}px; }
.nsv-wave.dim { width: 100%; opacity: .55; }
.nsv-waveclip { position: absolute; left: 0; top: ${STRIP_H + 2}px; height: ${WAVE_H}px; width: 0; overflow: hidden; pointer-events: none; }
.nsv-waveclip .nsv-wave { top: 0; }
.nsv-played { position: absolute; left: 0; top: 0; height: ${STRIP_H}px; width: 0; pointer-events: none;
  background: linear-gradient(90deg, rgba(142, 107, 255, .0), rgba(142, 107, 255, .35)); border-radius: 7px 0 0 0; }
.nsv-buffer { position: absolute; left: 0; bottom: 0; height: 3px; width: 0; background: #6a46d8; pointer-events: none; border-radius: 0 0 0 7px; }
.nsv-range { position: absolute; top: 0; bottom: 0; background: rgba(255, 211, 107, .18); border-left: 2px solid #ffd36b;
  border-right: 2px solid #ffd36b; display: none; pointer-events: none; }
.nsv-h { position: absolute; top: -2px; bottom: -2px; width: 14px; margin-left: -7px; display: none; cursor: ew-resize; z-index: 3; }
.nsv-h::after { content: ""; position: absolute; left: 50%; top: 50%; width: 5px; height: 16px; margin: -8px 0 0 -2.5px;
  border-radius: 3px; background: #ffd36b; box-shadow: 0 0 0 1px #0008; }
.nsv-h:hover::after { background: #fff; }
.nsv-head { position: absolute; top: -3px; bottom: -3px; width: 2px; margin-left: -1px; left: 0; background: #fff;
  box-shadow: 0 0 6px 2px rgba(255, 122, 217, .7); pointer-events: none; z-index: 4; }
.nsv-head::before { content: ""; position: absolute; top: -2px; left: -4px; border: 5px solid transparent; border-top-color: #fff; }
.nsv-ghost { position: absolute; bottom: calc(100% + 6px); display: none; flex-direction: column; align-items: center; gap: 2px;
  padding: 3px; border-radius: 6px; background: #000d; border: 1px solid #5b47a0; pointer-events: none; z-index: 5; }
.nsv-ghost canvas { position: static; border-radius: 3px; }
.nsv-ghost span { font-variant-numeric: tabular-nums; color: #fff; font-size: 11px; }

.nsv-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.nsv-chip { padding: 1px 8px; border-radius: 999px; background: #241d3d; border: 1px solid #3b2f5c; color: #c9c0ee; white-space: nowrap; }
.nsv-chip.good { border-color: #2f8f5b; color: #8ff0b8; }
.nsv-chip.bad { border-color: #8f3b4a; color: #ff9aa9; text-decoration: line-through; opacity: .8; }
.nsv-chip.note { border-color: #8f7a2f; color: #ffe08a; }
.nsv-chip.accent { border-color: #8e6bff; color: #fff; background: #3a2a78; }
.nsv-note { color: #8f86b3; font-size: 11px; }

@container (max-width: 400px) {
  .nsv-volwrap { display: none; }
  .nsv-hide-s { display: none !important; }
}
@media (prefers-reduced-motion: reduce) {
  .nsv *, .nsv *::before { animation: none !important; transition: none !important; }
}
`;
    document.head.appendChild(style);
}

// ---------------------------------------------------------------- helpers

const fmtTime = (s) => {
    if (!isFinite(s) || s < 0) s = 0;
    const m = Math.floor(s / 60);
    const sec = s - m * 60;
    return `${m}:${sec.toFixed(2).padStart(5, "0")}`;
};
const fmtSize = (b) => (b >= 1048576 ? (b / 1048576).toFixed(2) + " MB" : (b / 1024).toFixed(0) + " KB");
const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
};
const viewUrl = (f) =>
    api.apiURL(`/view?filename=${encodeURIComponent(f.filename)}&type=${f.type || "temp"}` +
        `&subfolder=${encodeURIComponent(f.subfolder || "")}&rand=${Math.random()}`);

// Resolve true when the event fires, false on error or timeout.
const waitEvent = (target, name, ms = 8000) =>
    new Promise((resolve) => {
        let done = false;
        const finish = (ok) => {
            if (done) return;
            done = true;
            target.removeEventListener(name, onOk);
            target.removeEventListener("error", onErr);
            clearTimeout(timer);
            resolve(ok);
        };
        const onOk = () => finish(true);
        const onErr = () => finish(false);
        const timer = setTimeout(() => finish(false), ms);
        target.addEventListener(name, onOk);
        target.addEventListener("error", onErr);
    });

function sizeCanvas(canvas, w, h) {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
}

let encoderReport = null;
async function loadEncoders() {
    if (encoderReport) return encoderReport;
    try {
        const r = await api.fetchApi("/nougan/video_encoders");
        encoderReport = await r.json();
    } catch {
        encoderReport = { ffmpeg: null, version: "", kinds: {} };
    }
    return encoderReport;
}

function setAdvancedVisible(node, show) {
    for (const name of ADVANCED) {
        const w = node.widgets?.find((x) => x.name === name);
        if (!w) continue;
        if (w._nsvOrig === undefined) {
            w._nsvOrig = { type: w.type, computeSize: w.computeSize, hidden: w.hidden };
        }
        w.hidden = !show;
        w.computeSize = show ? w._nsvOrig.computeSize : () => [0, -4];
        w.type = show ? w._nsvOrig.type : "hidden";
    }
    const size = node.computeSize();
    node.setSize([Math.max(node.size[0], size[0]), Math.max(node.size[1], size[1])]);
    node.setDirtyCanvas(true, true);
}

// ---------------------------------------------------------------- player

function buildPlayer(node) {
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    const ac = new AbortController();            // cleans up every document-level listener at once
    const { signal } = ac;

    // ---- stage
    const root = el("div", "nsv");
    const stage = el("div", "nsv-stage");
    const video = el("video");
    video.preload = "auto";
    video.autoplay = false;                      // explicit: this player only plays when asked
    video.playsInline = true;
    video.loop = true;
    video.controls = false;
    const empty = el("div", "nsv-empty");
    empty.append(el("b", "", "Nougan Save Video"), el("span", "", "Run the workflow to encode and preview."));
    const badge = el("div", "nsv-badge");
    badge.style.display = "none";
    const timeTag = el("div", "nsv-time", "0:00.00 / 0:00.00");
    timeTag.style.display = "none";
    const meter = el("canvas", "nsv-meter");
    const flash = el("div", "nsv-flash");
    const big = el("div", "nsv-big");
    big.innerHTML = iconSvg("play");
    const prog = el("div", "nsv-prog");
    const ring = el("div", "nsv-ring spin");
    const ringText = el("span", "", "0%");
    ring.appendChild(ringText);
    const progLabel = el("small", "", "Encoding...");
    prog.append(ring, progLabel);
    stage.append(video, empty, badge, timeTag, meter, flash, big, prog);

    // ---- timeline: filmstrip + waveform + playhead + A/B handles
    const scrub = el("div", "nsv-scrub");
    scrub.tabIndex = 0;
    scrub.setAttribute("role", "slider");
    scrub.setAttribute("aria-label", "Seek");
    const strip = el("canvas", "nsv-strip");
    const played = el("div", "nsv-played");
    const waveDim = el("canvas", "nsv-wave dim");
    const waveClip = el("div", "nsv-waveclip");
    const waveBright = el("canvas", "nsv-wave");
    waveClip.appendChild(waveBright);
    const buffer = el("div", "nsv-buffer");
    const range = el("div", "nsv-range");
    const hA = el("div", "nsv-h"); hA.dataset.h = "a"; hA.title = "Loop start (drag)";
    const hB = el("div", "nsv-h"); hB.dataset.h = "b"; hB.title = "Loop end (drag)";
    const head = el("div", "nsv-head");
    const ghost = el("div", "nsv-ghost");
    const ghostCanvas = el("canvas");
    ghostCanvas.width = 96;
    ghostCanvas.height = 54;
    const ghostText = el("span", "", "0:00.00");
    ghost.append(ghostCanvas, ghostText);
    scrub.append(strip, played, waveDim, waveClip, buffer, range, hA, hB, head, ghost);

    // ---- buttons
    const bar = el("div", "nsv-bar");
    const mk = (content, title, cls = "") => {
        const b = el("button", "nsv-btn " + cls);
        b.type = "button";
        b.title = title;
        b.setAttribute("aria-label", title);
        if (ICONS[content]) setIcon(b, content); else b.textContent = content;
        // Mouse presses must not steal focus from the player root, otherwise Space would re-click this button.
        b.addEventListener("mousedown", (e) => e.preventDefault());
        return b;
    };
    const group = (...kids) => { const g = el("div", "nsv-grp"); g.append(...kids); return g; };

    const prev = mk("back", "Previous frame (←)");
    const play = mk("play", "Play / pause (space)", "primary");
    const next = mk("fwd", "Next frame (→)");
    const loop = mk("loop", "Loop (L)");
    loop.classList.add("on");
    const ab = mk("A·B", "Loop a section: click for A, again for B, again to clear. Or press I / O, then drag the handles.", "txt");
    const mute = mk("vol", "Mute (M)");
    const vol = el("input", "nsv-vol");
    vol.type = "range"; vol.min = 0; vol.max = 1; vol.step = 0.02; vol.value = 1;
    vol.title = "Volume";
    const volwrap = el("div", "nsv-volwrap");
    volwrap.appendChild(vol);
    const vg = el("div", "nsv-vg");
    vg.append(mute, volwrap);

    const rateWrap = el("div", "nsv-rate");
    const rate = mk("1×", "Playback speed", "txt");
    const menu = el("div", "nsv-menu");
    for (const s of SPEEDS) {
        const b = el("button", "nsv-mi", s + "×");
        b.type = "button";
        b.dataset.s = String(s);
        b.addEventListener("mousedown", (e) => e.preventDefault());
        b.addEventListener("click", (e) => { e.stopPropagation(); setRate(s); closeMenu(); });
        menu.appendChild(b);
    }
    rateWrap.append(rate, menu);

    const snap = mk("camera", "Save the current frame as PNG");
    const copy = mk("copy", "Copy file path", "nsv-hide-s");
    const full = mk("full", "Fullscreen (F)");
    bar.append(
        group(prev, play, next), el("span", "nsv-sep"),
        group(loop, ab), el("span", "nsv-sep"),
        group(vg, rateWrap),
        el("span", "nsv-spacer"),
        group(snap, copy, full),
    );

    const chips = el("div", "nsv-chips");
    const encChips = el("div", "nsv-chips");
    root.append(stage, scrub, bar, chips, encChips);

    const state = {
        fps: 24, duration: 0, entry: null, rate: 1, dragging: false,
        a: null, b: null, token: 0, userMuted: false, dead: false,
    };
    let thumbs = [];      // canvases, evenly spaced across the duration
    let peaks = null;     // Float32Array of normalised amplitudes
    let audioCtx = null;
    let analysers = null;
    let peakHold = [0, 0];

    // seek coalescing: at most one seek in flight, always to the newest requested time
    let pending = null;   // newest requested time not yet sent to the video
    let target = null;    // what the UI should show while a seek is in flight
    let lastReq = null;   // last requested time (used for the exact seek when a drag ends)
    let seekRaf = 0;

    const duration = () => (isFinite(video.duration) && video.duration > 0 ? video.duration : state.duration);
    const frameDur = () => 1 / (state.fps || 24);
    const frameNo = (t) => Math.min(state.entry?.frames ?? 1, Math.floor(t * state.fps + 0.001) + 1);
    // Aim for the middle of a frame so the browser never lands on the previous frame by rounding.
    const snapT = (t) => {
        const f = frameDur(), d = duration();
        let s = (Math.floor(Math.max(0, t) / f + 1e-6) + 0.5) * f;
        if (d > 0) s = Math.min(s, Math.max(f / 2, d - f / 2));
        return s;
    };

    // ------------------------------------------------ drawing: filmstrip
    function drawStrip() {
        const w = scrub.clientWidth, h = STRIP_H;
        if (!w) return;
        const ctx = sizeCanvas(strip, w, h);
        ctx.fillStyle = "#120e20";
        ctx.fillRect(0, 0, w, h);
        const n = thumbs.length;
        if (!n) return;
        const tw = w / n;
        for (let i = 0; i < n; i++) {
            const t = thumbs[i];
            const s = Math.max(tw / t.width, h / t.height);
            const dw = t.width * s, dh = t.height * s;
            ctx.save();
            ctx.beginPath();
            ctx.rect(i * tw, 0, tw + 0.5, h);
            ctx.clip();
            ctx.drawImage(t, i * tw + (tw - dw) / 2, (h - dh) / 2, dw, dh);
            ctx.restore();
        }
    }

    async function buildThumbs(url, token) {
        thumbs = [];
        drawStrip();
        const tv = document.createElement("video");
        tv.muted = true;
        tv.preload = "auto";
        tv.crossOrigin = "anonymous";
        tv.src = url;
        if (!(await waitEvent(tv, "loadeddata"))) return;
        const d = tv.duration;
        if (!isFinite(d) || d <= 0 || !tv.videoWidth) return;
        const aspect = tv.videoWidth / tv.videoHeight;
        const n = Math.max(6, Math.min(24, Math.round(scrub.clientWidth / (STRIP_H * aspect))));
        const th = STRIP_H * 2;
        const tw = Math.round(th * aspect);
        for (let i = 0; i < n; i++) {
            if (token !== state.token) break;
            tv.currentTime = Math.min(d - 0.001, ((i + 0.5) / n) * d);
            if (!(await waitEvent(tv, "seeked"))) break;
            const c = document.createElement("canvas");
            c.width = tw;
            c.height = th;
            c.getContext("2d").drawImage(tv, 0, 0, tw, th);
            thumbs.push(c);
            // fill remaining slots with the latest frame so the strip is never half empty
            if (token === state.token && (i % 3 === 2 || i === n - 1)) drawStrip();
        }
        tv.removeAttribute("src");
        tv.load();
        if (token === state.token) drawStrip();
    }

    // ------------------------------------------------ drawing: waveform
    function drawWave() {
        const w = scrub.clientWidth, h = WAVE_H;
        if (!w) return;
        waveBright.style.width = w + "px";
        for (const [canvas, bright] of [[waveDim, false], [waveBright, true]]) {
            const ctx = sizeCanvas(canvas, w, h);
            ctx.clearRect(0, 0, w, h);
            if (!peaks) continue;
            const grad = ctx.createLinearGradient(0, 0, w, 0);
            grad.addColorStop(0, bright ? "#8e6bff" : "#7a6cb0");
            grad.addColorStop(1, bright ? "#ff7ad9" : "#9a7ab0");
            ctx.fillStyle = grad;
            const mid = h / 2;
            const bars = Math.floor(w / 2);
            for (let i = 0; i < bars; i++) {
                const amp = peaks[Math.min(peaks.length - 1, Math.floor((i / bars) * peaks.length))];
                const bh = Math.max(1, amp * (h - 2));
                ctx.fillRect(i * 2, mid - bh / 2, 1.4, bh);
            }
        }
    }

    async function buildWave(url, token) {
        peaks = null;
        drawWave();
        let ac = null;
        try {
            const res = await fetch(url);
            const buf = await res.arrayBuffer();
            if (token !== state.token) return;
            ac = new AudioCtor();
            const audio = await ac.decodeAudioData(buf);
            if (token !== state.token) return;
            const data = audio.getChannelData(0);
            const bins = 800;
            const per = Math.max(1, Math.floor(data.length / bins));
            const stride = Math.max(1, Math.floor(per / 48));
            const out = new Float32Array(bins);
            let top = 1e-6;
            for (let b = 0; b < bins; b++) {
                let m = 0;
                for (let i = b * per, end = Math.min(data.length, i + per); i < end; i += stride) {
                    const v = Math.abs(data[i]);
                    if (v > m) m = v;
                }
                out[b] = m;
                if (m > top) top = m;
            }
            for (let b = 0; b < bins; b++) out[b] = Math.pow(out[b] / top, 0.7);
            peaks = out;
            drawWave();
        } catch {
            /* browser cannot decode this audio; the timeline just has no waveform */
        } finally {
            try { ac?.close(); } catch { /* ignore */ }
        }
    }

    // ------------------------------------------------ level meter (Web Audio)
    function ensureAudio() {
        if (audioCtx || !state.entry?.has_audio || !AudioCtor) return;
        try {
            audioCtx = new AudioCtor();
            const src = audioCtx.createMediaElementSource(video);
            const split = audioCtx.createChannelSplitter(2);
            const mkAn = () => { const a = audioCtx.createAnalyser(); a.fftSize = 1024; return a; };
            analysers = [mkAn(), mkAn()];
            src.connect(split);
            split.connect(analysers[0], 0);
            split.connect(analysers[1], 1);
            src.connect(audioCtx.destination);
        } catch {
            audioCtx = null;
            analysers = null;
        }
    }

    const dbToUnit = (db) => Math.max(0, Math.min(1, (db + 60) / 60));
    function drawMeter() {
        const w = 16, h = 72;
        if (!state.entry?.has_audio) { meter.style.display = "none"; return; }
        meter.style.display = "block";
        const ctx = sizeCanvas(meter, w, h);
        ctx.clearRect(0, 0, w, h);
        const buf = new Float32Array(1024);
        for (let ch = 0; ch < 2; ch++) {
            let unit = 0;
            if (analysers && !video.paused) {
                analysers[ch].getFloatTimeDomainData(buf);
                let sum = 0;
                for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
                unit = dbToUnit(20 * Math.log10(Math.sqrt(sum / buf.length) + 1e-9));
            }
            peakHold[ch] = Math.max(unit, peakHold[ch] - 0.015);
            const x = 2 + ch * 7;
            const hh = unit * (h - 4);
            const g = ctx.createLinearGradient(0, h, 0, 0);
            g.addColorStop(0, "#2fd07a");
            g.addColorStop(0.7, "#f4d03f");
            g.addColorStop(1, "#ff4d6d");
            ctx.fillStyle = g;
            ctx.fillRect(x, h - 2 - hh, 5, hh);
            ctx.fillStyle = "#fff";
            ctx.fillRect(x, h - 2 - peakHold[ch] * (h - 4), 5, 1.5);
        }
    }


    // ------------------------------------------------ UI refresh
    const shownTime = () => target ?? (video.currentTime || 0);

    function positionRange() {
        const d = duration();
        if (state.a == null || d <= 0) { range.style.display = hA.style.display = hB.style.display = "none"; return; }
        const a = state.a / d;
        const b = (state.b ?? state.a) / d;
        range.style.display = "block";
        range.style.left = a * 100 + "%";
        range.style.width = Math.max(0.3, (b - a) * 100) + "%";
        hA.style.display = "block";
        hA.style.left = a * 100 + "%";
        hB.style.display = state.b != null ? "block" : "none";
        hB.style.left = b * 100 + "%";
    }

    const abStage = () => (state.a == null ? 0 : state.b == null ? 1 : 2);
    function syncAB() {
        const s = abStage();
        ab.classList.toggle("armed", s === 1);
        ab.classList.toggle("on", s === 2);
        ab.textContent = ["A·B", "A→", "A-B"][s];
        if (s === 2) { video.loop = true; loop.classList.add("on"); }
        positionRange();
    }

    function setHead(t) {
        const d = duration();
        const pct = (d > 0 ? Math.min(1, t / d) * 100 : 0).toFixed(3) + "%";
        head.style.left = pct;
        played.style.width = pct;
        waveClip.style.width = pct;
        timeTag.textContent = `${fmtTime(t)} / ${fmtTime(d)}  ·  f${frameNo(t)}`;
        scrub.setAttribute("aria-valuenow", String(Math.round(t * 100) / 100));
        scrub.setAttribute("aria-valuemax", String(Math.round(d * 100) / 100));
    }

    const updateUI = () => {
        const d = duration();
        // A-B loop only while actually playing, so stepping past B by hand is not yanked back.
        if (!state.dragging && !video.paused && state.a != null && state.b != null && video.currentTime >= state.b - 0.0005) {
            video.currentTime = state.a;
            return;
        }
        if (target != null && pending == null && !video.seeking && Math.abs(video.currentTime - target) < frameDur()) target = null;
        setHead(shownTime());
        try {
            if (video.buffered.length) buffer.style.width = Math.min(100, (video.buffered.end(video.buffered.length - 1) / (d || 1)) * 100) + "%";
        } catch { /* ignore */ }
    };

    const syncPlayState = () => {
        const paused = video.paused;
        setIcon(play, paused ? "play" : "pause");
        play.title = paused ? "Play (space)" : "Pause (space)";
        big.classList.toggle("on", !!state.entry && paused && !state.dragging && !prog.classList.contains("on"));
    };

    const raf = () => {
        updateUI();
        drawMeter();
        if (!video.paused) requestAnimationFrame(raf);
    };

    // ------------------------------------------------ seeking (coalesced)
    function flushSeek() {
        if (pending == null || video.seeking) return;     // the 'seeked' handler calls us again
        const t = pending;
        pending = null;
        if (state.dragging && typeof video.fastSeek === "function") video.fastSeek(t);
        else video.currentTime = t;
    }
    function requestSeek(t) {
        pending = lastReq = target = t;
        setHead(t);
        if (!seekRaf) seekRaf = requestAnimationFrame(() => { seekRaf = 0; flushSeek(); });
    }
    function seekTo(t) {
        const d = duration(), f = frameDur();
        if (d > 0) t = Math.max(f / 2, Math.min(t, d - f / 2));
        requestSeek(t);
    }
    const step = (dir) => {
        video.pause();
        seekTo(snapT(pending ?? target ?? video.currentTime) + dir * frameDur());
    };
    const seekBy = (dt) => seekTo((pending ?? target ?? video.currentTime) + dt);

    // ------------------------------------------------ scrubbing + A/B handle dragging
    const posFromEvent = (e) => {
        const rect = scrub.getBoundingClientRect();
        return { p: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)), px: e.clientX - rect.left, w: rect.width };
    };
    let drag = null;   // { kind: "seek" | "a" | "b", resume: bool }

    function dragTo(e) {
        const d = duration();
        if (d <= 0) return;
        const f = frameDur();
        let t = snapT(posFromEvent(e).p * d);
        if (drag.kind === "a") {
            t = state.a = Math.max(0, Math.min(t, (state.b ?? d) - f));
            positionRange();
        } else if (drag.kind === "b") {
            t = state.b = Math.min(d, Math.max(t, (state.a ?? 0) + f));
            positionRange();
        }
        requestSeek(t);
    }
    scrub.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || duration() <= 0) return;
        e.stopPropagation();
        e.preventDefault();
        scrub.focus({ preventScroll: true });
        const h = e.target.closest?.(".nsv-h");
        drag = { kind: h ? h.dataset.h : "seek", resume: false };
        state.dragging = true;
        if (drag.kind === "seek" && !video.paused) { drag.resume = true; video.pause(); }   // no audio stutter while scrubbing
        scrub.setPointerCapture(e.pointerId);
        syncPlayState();
        dragTo(e);
    });
    scrub.addEventListener("pointermove", (e) => {
        const { p, px, w } = posFromEvent(e);
        const d = duration();
        ghost.style.display = "flex";
        const half = 52;
        ghost.style.left = Math.max(0, Math.min(w - half * 2, px - half)) + "px";
        ghostText.textContent = `${fmtTime(p * d)}  ·  f${frameNo(p * d)}`;
        const gc = ghostCanvas.getContext("2d");
        gc.fillStyle = "#000";
        gc.fillRect(0, 0, 96, 54);
        if (thumbs.length) {
            const t = thumbs[Math.min(thumbs.length - 1, Math.floor(p * thumbs.length))];
            const s = Math.min(96 / t.width, 54 / t.height);
            gc.drawImage(t, (96 - t.width * s) / 2, (54 - t.height * s) / 2, t.width * s, t.height * s);
        }
        if (drag) dragTo(e);
    });
    const endDrag = (e) => {
        if (!drag) return;
        const d = drag;
        drag = null;
        state.dragging = false;
        try { scrub.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
        if (lastReq != null) { pending = lastReq; flushSeek(); }   // one exact seek (fastSeek is keyframe-only)
        if (d.resume) video.play().catch(() => {});
        syncPlayState();
    };
    scrub.addEventListener("pointerup", endDrag);
    scrub.addEventListener("pointercancel", endDrag);
    scrub.addEventListener("pointerleave", () => { ghost.style.display = "none"; });

    // ------------------------------------------------ controls
    let menuOpen = false;
    function closeMenu() { menuOpen = false; menu.classList.remove("on"); }
    function setRate(s) {
        state.rate = s;
        video.defaultPlaybackRate = video.playbackRate = s;
        rate.textContent = s + "×";
        for (const b of menu.children) b.classList.toggle("sel", Number(b.dataset.s) === s);
    }
    setRate(1);
    rate.onclick = () => { menuOpen = !menuOpen; menu.classList.toggle("on", menuOpen); };
    document.addEventListener("pointerdown", (e) => { if (menuOpen && !rateWrap.contains(e.target)) closeMenu(); }, { signal, capture: true });

    const toggle = () => {
        if (!state.entry) return;
        ensureAudio();
        audioCtx?.resume?.();
        if (video.paused) video.play().catch(() => {}); else video.pause();
    };
    // Press-and-hold repeat for the frame-step buttons (keyboard activation still works via click detail 0).
    function holdRepeat(btn, fn) {
        let t1 = 0, t2 = 0;
        const stop = () => { clearTimeout(t1); clearInterval(t2); t1 = t2 = 0; };
        btn.addEventListener("pointerdown", (e) => {
            if (e.button !== 0) return;
            fn();
            t1 = setTimeout(() => { t2 = setInterval(fn, 55); }, 350);
        });
        for (const ev of ["pointerup", "pointerleave", "pointercancel", "blur"]) btn.addEventListener(ev, stop);
        btn.addEventListener("click", (e) => { if (e.detail === 0) fn(); });
        signal.addEventListener("abort", stop);
    }
    holdRepeat(prev, () => step(-1));
    holdRepeat(next, () => step(1));

    play.onclick = toggle;
    stage.addEventListener("click", toggle);
    stage.addEventListener("dblclick", () => full.click());   // click toggled twice (net zero), then fullscreen
    loop.onclick = () => { video.loop = !video.loop; loop.classList.toggle("on", video.loop); };

    const syncVol = () => {
        const silent = video.muted || video.volume === 0;
        setIcon(mute, silent ? "muted" : "vol");
        vol.style.setProperty("--v", (video.muted ? 0 : video.volume * 100) + "%");
    };
    mute.onclick = () => { state.userMuted = !state.userMuted; video.muted = state.userMuted; syncVol(); };
    vol.oninput = () => {
        video.volume = Number(vol.value);
        state.userMuted = video.volume === 0;
        video.muted = state.userMuted;
        syncVol();
    };
    full.onclick = () => {
        if (document.fullscreenElement) document.exitFullscreen();
        else stage.requestFullscreen?.();
    };
    copy.onclick = async () => {
        const path = state.entry?.path;
        if (!path) return;
        try { await navigator.clipboard.writeText(path); setIcon(copy, "check"); }
        catch { setIcon(copy, "cross"); }
        setTimeout(() => setIcon(copy, "copy"), 1200);
    };
    ab.onclick = () => {
        const t = snapT(video.currentTime || 0);
        const s = abStage();
        if (s === 0) { state.a = t; state.b = null; }
        else if (s === 1) {
            if (t < state.a) { state.b = state.a; state.a = t; } else state.b = t;
            if (state.b - state.a < frameDur()) state.b = Math.min(duration(), state.a + frameDur());
        } else { state.a = state.b = null; }
        syncAB();
    };
    const markIn = () => {
        const t = snapT(video.currentTime || 0);
        state.a = t;
        if (state.b != null && state.b <= t) state.b = null;
        syncAB();
    };
    const markOut = () => {
        const t = snapT(video.currentTime || 0);
        if (state.a == null) state.a = 0;
        state.b = Math.min(duration() || t, Math.max(t, state.a + frameDur()));
        syncAB();
    };
    snap.onclick = () => {
        if (!video.videoWidth) return;
        const c = document.createElement("canvas");
        c.width = video.videoWidth;
        c.height = video.videoHeight;
        c.getContext("2d").drawImage(video, 0, 0);
        const n = frameNo(video.currentTime || 0);
        flash.classList.remove("go");
        void flash.offsetWidth;
        flash.classList.add("go");
        c.toBlob((blob) => {
            if (!blob) return;
            const a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = `nougan_frame_${String(n).padStart(5, "0")}.png`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 2000);
        }, "image/png");
    };

    // Keyboard: the root keeps focus after mouse use (buttons refuse focus on mousedown).
    root.tabIndex = 0;
    root.addEventListener("pointerdown", (e) => { if (e.target.tagName !== "INPUT") root.focus({ preventScroll: true }); });
    root.addEventListener("keydown", (e) => {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        const tag = e.target.tagName;
        if (tag === "INPUT") return;                                               // let the volume slider use its own keys
        if (tag === "BUTTON" && (e.code === "Space" || e.code === "Enter")) return; // native click on a Tab-focused button
        let handled = true;
        switch (e.code) {
            case "Space": case "KeyK": toggle(); break;
            case "ArrowLeft": e.shiftKey ? seekBy(-1) : step(-1); break;
            case "ArrowRight": e.shiftKey ? seekBy(1) : step(1); break;
            case "Comma": step(-1); break;
            case "Period": step(1); break;
            case "Home": seekTo(0); break;
            case "End": seekTo(duration()); break;
            case "KeyL": loop.click(); break;
            case "KeyM": mute.click(); break;
            case "KeyF": full.click(); break;
            case "KeyI": markIn(); break;
            case "KeyO": markOut(); break;
            case "Escape": if (menuOpen) closeMenu(); else handled = false; break;
            default: handled = false;
        }
        if (handled) { e.preventDefault(); e.stopPropagation(); }
    });

    video.addEventListener("play", () => { syncPlayState(); requestAnimationFrame(raf); });
    video.addEventListener("pause", () => { syncPlayState(); updateUI(); drawMeter(); });
    video.addEventListener("ended", syncPlayState);
    video.addEventListener("seeked", () => {
        if (pending != null) flushSeek(); else target = null;
        updateUI();
    });
    video.addEventListener("timeupdate", updateUI);
    video.addEventListener("loadedmetadata", () => { updateUI(); positionRange(); });
    video.addEventListener("progress", updateUI);
    video.addEventListener("error", () => {
        empty.style.display = "flex";
        empty.replaceChildren(
            el("b", "", "This browser can't play the file"),
            el("span", "", state.entry?.preview ? "Preview failed to load." :
                "The file was saved. Turn on preview_proxy for an H.264 preview copy."));
    });
    // Fires once per presented frame, also while paused/seeking: keeps the frame counter exact.
    if (typeof video.requestVideoFrameCallback === "function") {
        const onFrame = () => {
            if (state.dead) return;
            updateUI();
            video.requestVideoFrameCallback(onFrame);
        };
        video.requestVideoFrameCallback(onFrame);
    }

    // ------------------------------------------------ encode progress ring
    const myId = () => String(node.id);
    const showProgress = (pct) => {
        prog.classList.add("on");
        big.classList.remove("on");
        if (pct == null) {
            ring.classList.add("spin");
            progLabel.textContent = "Encoding...";
        } else {
            ring.classList.remove("spin");
            ring.style.setProperty("--p", pct.toFixed(1));
            ringText.textContent = Math.round(pct) + "%";
            progLabel.textContent = "Encoding frames";
        }
    };
    const hideProgress = () => { prog.classList.remove("on"); syncPlayState(); };
    const onProgress = (e) => {
        const d = e.detail || {};
        if (String(d.node) !== myId() || !d.max) return;
        showProgress((d.value / d.max) * 100);
    };
    const onExecuting = (e) => {
        const d = e.detail;
        const id = d && typeof d === "object" ? d.node : d;
        if (id != null && String(id) === myId()) showProgress(null);
    };
    api.addEventListener("progress", onProgress);
    api.addEventListener("executing", onExecuting);
    api.addEventListener("execution_error", hideProgress);
    api.addEventListener("execution_interrupted", hideProgress);

    // ------------------------------------------------ resize handling
    let resizeTimer = null;
    const ro = new ResizeObserver(() => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => { drawStrip(); drawWave(); positionRange(); }, 60);
    });
    ro.observe(scrub);

    // ------------------------------------------------ entry + chips
    const addChip = (text, cls = "") => chips.appendChild(el("span", "nsv-chip " + cls, text));

    function setEntry(entry) {
        hideProgress();
        state.token += 1;
        const token = state.token;
        state.entry = entry;
        state.fps = entry.fps || 24;
        state.duration = entry.duration || 0;
        state.a = state.b = null;
        pending = target = lastReq = null;
        syncAB();

        const source = entry.preview || entry;
        const url = viewUrl(source);
        empty.style.display = "none";
        badge.style.display = timeTag.style.display = "block";
        badge.textContent = entry.codec;
        video.pause();                                   // a fresh result waits for the user to press play
        video.src = url;
        video.load();
        setRate(state.rate);
        video.muted = !entry.has_audio || state.userMuted;
        mute.style.opacity = entry.has_audio ? "1" : ".4";
        vol.disabled = !entry.has_audio;
        syncVol();
        peakHold = [0, 0];
        setHead(0);
        syncPlayState();

        chips.replaceChildren();
        addChip(`${entry.width}×${entry.height}`, "accent");
        addChip(`${Number(entry.fps).toFixed(2).replace(/\.?0+$/, "")} fps`);
        addChip(`${entry.frames} frames`);
        addChip(`${entry.duration.toFixed(2)} s`);
        addChip(fmtSize(entry.size));
        addChip(entry.encoder);
        addChip(entry.has_audio ? "🔊 audio" : "🔇 no audio");
        if (entry.type === "temp") addChip("temp preview", "note");
        if (entry.preview) addChip("H.264 preview copy", "note");
        for (const n of entry.notes || []) addChip(n, "note");

        // Timeline visuals read their own copy of the file, so they never disturb playback.
        buildThumbs(url, token);
        if (entry.has_audio && (entry.preview || entry.size <= WAVE_MAX_BYTES)) buildWave(url, token);
        else { peaks = null; drawWave(); }
        drawMeter();
        node.setDirtyCanvas(true, true);
    }

    async function showEncoders() {
        const rep = await loadEncoders();
        encChips.replaceChildren();
        if (!rep.ffmpeg) {
            encChips.appendChild(el("span", "nsv-chip bad", "ffmpeg not found - pip install imageio-ffmpeg"));
            return;
        }
        for (const [kind, label] of Object.entries(KIND_LABEL)) {
            const have = rep.kinds?.[kind] || [];
            const chip = el("span", "nsv-chip " + (have.length ? "good" : "bad"), label);
            chip.title = have.length ? have.join(", ") : "no encoder in this ffmpeg build";
            encChips.appendChild(chip);
        }
        encChips.appendChild(el("span", "nsv-note",
            rep.version.replace(/^ffmpeg version /, "ffmpeg ").split(" Copyright")[0]));
    }

    function dispose() {
        state.token += 1;
        state.dead = true;
        ac.abort();
        cancelAnimationFrame(seekRaf);
        api.removeEventListener("progress", onProgress);
        api.removeEventListener("executing", onExecuting);
        api.removeEventListener("execution_error", hideProgress);
        api.removeEventListener("execution_interrupted", hideProgress);
        ro.disconnect();
        try { video.pause(); video.removeAttribute("src"); video.load(); } catch { /* ignore */ }
        try { audioCtx?.close(); } catch { /* ignore */ }
    }

    drawStrip();
    drawWave();
    syncVol();
    syncPlayState();
    showEncoders();
    return { root, setEntry, video, dispose };
}

// ---------------------------------------------------------------- extension

app.registerExtension({
    name: "Nougan.SaveVideo",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_ID) return;
        injectStyles();

        const onCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = onCreated?.apply(this, arguments);
            const player = buildPlayer(this);
            this._nsv = player;

            const widget = this.addDOMWidget("nougan_player", "nougan_video_player", player.root, {
                serialize: false,
                hideOnZoom: false,
                getMinHeight: () => 330,
            });
            widget.computeSize = (width) => [width, 420];

            const adv = this.widgets.find((w) => w.name === "advanced");
            if (adv) {
                const orig = adv.callback;
                adv.callback = (v, ...rest) => { setAdvancedVisible(this, !!v); return orig?.call(adv, v, ...rest); };
                setAdvancedVisible(this, !!adv.value);
            }
            this.setSize([Math.max(this.size[0], 480), Math.max(this.size[1], 720)]);
            return result;
        };

        const onExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            onExecuted?.apply(this, arguments);
            const entry = message?.nougan_video?.[0];
            if (entry && this._nsv) {
                this._nsv.setEntry(entry);
                this._nsvLast = entry;
            }
        };

        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const r = onConfigure?.apply(this, arguments);
            const adv = this.widgets?.find((w) => w.name === "advanced");
            if (adv) setAdvancedVisible(this, !!adv.value);
            return r;
        };

        const onRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            try { this._nsv?.dispose(); } catch { /* ignore */ }
            return onRemoved?.apply(this, arguments);
        };
    },
});
