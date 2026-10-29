// Automagic 2222: Live Panel, built-in preview.
//
// This is the Preview Mirror, folded into the panel. It listens to the
// "kj_preview_override" websocket event that KJNodes' Model Preview Override
// already broadcasts and draws it (video/image, sigma/delta graph, step time,
// audio spectrogram) in a strip at the top of the Live Panel. No node needed.
//
// While it is switched off it holds NO listener and decodes nothing.
//
// Put this file next to nougan_live_panel.js in web/.

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const STYLE_ID = "nlp-preview-stylesheet";
const EVENT = "kj_preview_override";
const PAD = 4;

const CSS = `
.nlp-pv-host{flex:0 0 auto;border-bottom:1px solid var(--nlp-border,#3a3a3a)}
.nlp-collapsed .nlp-pv-host{display:none}
.nlp-pv{position:relative;display:flex;flex-direction:column;min-height:120px;overflow:hidden;
  background:var(--nlp-input,#121212);color:var(--nlp-fg,#d4d4d4);font:11px/1.3 system-ui,sans-serif;user-select:none}
.nlp-pv-area{flex:1 1 auto;min-height:50px;position:relative;background:#0a0a0a;overflow:hidden}
.nlp-pv-img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;image-rendering:pixelated;display:block}
.nlp-pv-ph{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#707070;pointer-events:none}
.nlp-pv-scrub{position:absolute;left:0;right:0;bottom:0;height:6px;background:rgba(0,0,0,.5);cursor:pointer;z-index:5;transition:height 80ms ease}
.nlp-pv-scrub:hover{height:10px}
.nlp-pv-fill{height:100%;width:0%;background:var(--nlp-accent,#e67e22);pointer-events:none}
.nlp-pv-scrub.nlp-pv-paused .nlp-pv-fill{background:#707070}
.nlp-pv-bar{flex:0 0 auto;display:flex;align-items:center;gap:6px;padding:3px 8px;background:var(--nlp-head,#262626);border-top:1px solid var(--nlp-border,#3a3a3a)}
.nlp-pv-title{color:var(--nlp-fg,#d4d4d4);white-space:nowrap}
.nlp-pv-sum{color:var(--nlp-dim,#8a8a8a);font-size:10px;margin-left:auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.nlp-pv-audio{background:var(--nlp-input,#121212);color:var(--nlp-dim,#8a8a8a);border:1px solid var(--nlp-border,#3a3a3a);border-radius:3px;font-size:11px;line-height:1;padding:1px 4px;cursor:pointer}
.nlp-pv-audio.nlp-pv-on{color:var(--nlp-accent,#e67e22);border-color:var(--nlp-accent,#e67e22)}
.nlp-pv-graphs{flex:0 0 auto;display:flex;gap:6px;padding:5px 6px 6px;height:84px;box-sizing:border-box}
.nlp-pv-cell{flex:1 1 0;min-width:0;display:flex;flex-direction:column;background:var(--nlp-bg,#1e1e1e);border:1px solid var(--nlp-border,#3a3a3a);border-radius:3px;overflow:hidden}
.nlp-pv-ghead{flex:0 0 auto;display:flex;justify-content:space-between;gap:4px;padding:2px 6px;font-size:10px;background:var(--nlp-head,#262626)}
.nlp-pv-glabel{color:var(--nlp-dim,#8a8a8a)}
.nlp-pv-gval{color:var(--nlp-fg,#d4d4d4);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right}
.nlp-pv-canvas{flex:1 1 auto;display:block;width:100%;min-height:0}
.nlp-pv-spec{flex:0 0 auto;display:none;flex-direction:column;border-top:1px solid var(--nlp-border,#3a3a3a)}
.nlp-pv-spec canvas{display:block;width:100%;height:36px}
.nlp-pv-grip{flex:0 0 5px;cursor:ns-resize;background:var(--nlp-head,#262626);position:relative}
.nlp-pv-grip::after{content:'';position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:26px;height:2px;background:var(--nlp-dim,#8a8a8a);border-radius:1px;opacity:.6}
.nlp-pv-grip:hover::after{opacity:1}
`;

function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = CSS;
    document.head.appendChild(s);
}

function el(tag, cls, parent) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (parent) parent.appendChild(e);
    return e;
}
const fmt = (n, d) => (Number.isFinite(n) ? n.toFixed(d) : "\u2014");

function b64ToBlob(b64, mime) {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
}

function syncDPR(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth || canvas.width;
    const H = canvas.clientHeight || canvas.height;
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
        canvas.width = Math.round(W * dpr);
        canvas.height = Math.round(H * dpr);
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, W, H };
}

function gridlines(ctx, W, H, padY, color) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    for (let g = 1; g < 4; g++) {
        const y = Math.round(padY + (g / 4) * (H - 2 * padY)) + 0.5;
        ctx.beginPath(); ctx.moveTo(PAD, y); ctx.lineTo(W - PAD, y); ctx.stroke();
    }
}

// canvas can't read CSS vars directly, so resolve the accent from the panel's theme
function accentOf(node) {
    try {
        const v = getComputedStyle(node).getPropertyValue("--nlp-accent").trim();
        if (v) return v;
    } catch {}
    return "#e67e22";
}

function drawSigmaDelta(canvas, accent, sigmas, deltas, step, totalSteps, hoverStep, lockedStep) {
    const { ctx, W, H } = syncDPR(canvas);
    const padY = 3, iW = W - 2 * PAD, iH = H - 2 * padY;
    ctx.clearRect(0, 0, W, H);
    gridlines(ctx, W, H, padY, "rgba(128,128,128,0.18)");

    const n = sigmas?.length || 0;
    const xSteps = Math.max(totalSteps || n, n, deltas.length);
    const xAt = (i) => PAD + (i / Math.max(1, xSteps - 1)) * iW;

    let sY = null;
    if (n > 1) {
        let sMax = -Infinity, sMin = Infinity;
        for (const s of sigmas) { if (s > sMax) sMax = s; if (s < sMin) sMin = s; }
        if (sMin > 0) sMin = 0;
        const range = Math.max(sMax - sMin, 1e-6);
        sY = (v) => padY + (1 - (v - sMin) / range) * iH;
        ctx.strokeStyle = "rgba(208,208,208,0.55)";
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
            const px = PAD + (i / (n - 1)) * iW;
            if (i === 0) ctx.moveTo(px, sY(sigmas[i])); else ctx.lineTo(px, sY(sigmas[i]));
        }
        ctx.stroke();
        ctx.setLineDash([]);
        const i = Math.max(0, Math.min(n - 1, step));
        ctx.fillStyle = "#d0d0d0";
        ctx.beginPath();
        ctx.arc(PAD + (i / Math.max(1, n - 1)) * iW, sY(sigmas[i]), 2.5, 0, Math.PI * 2);
        ctx.fill();
    }

    let dY = null;
    if (deltas.length) {
        let dMax = -Infinity;
        for (const v of deltas) if (Number.isFinite(v) && v > dMax) dMax = v;
        const range = Math.max(dMax, 1e-6);
        dY = (v) => padY + (1 - v / range) * iH;
        ctx.beginPath();
        ctx.moveTo(xAt(0), H - padY);
        ctx.lineTo(xAt(0), dY(deltas[0]));
        for (let i = 0; i < deltas.length; i++) ctx.lineTo(xAt(i + 1), dY(deltas[i]));
        ctx.lineTo(xAt(deltas.length), H - padY);
        ctx.closePath();
        ctx.globalAlpha = 0.15; ctx.fillStyle = accent; ctx.fill(); ctx.globalAlpha = 1;
        ctx.strokeStyle = accent; ctx.lineWidth = 1.3;
        ctx.beginPath();
        for (let i = 0; i < deltas.length; i++) {
            const px = xAt(i + 1), py = dY(deltas[i]);
            if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.stroke();
    }

    if (lockedStep != null && lockedStep >= 0 && lockedStep < xSteps) {
        const lx = xAt(lockedStep) + 0.5;
        ctx.strokeStyle = "rgba(245,200,60,0.9)"; ctx.lineWidth = 1.2; ctx.setLineDash([4, 2]);
        ctx.beginPath(); ctx.moveTo(lx, padY); ctx.lineTo(lx, H - padY); ctx.stroke();
        ctx.setLineDash([]);
    }
    if (hoverStep != null && hoverStep >= 0 && hoverStep < xSteps) {
        const hx = xAt(hoverStep) + 0.5;
        ctx.strokeStyle = "rgba(208,208,208,0.5)"; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(hx, padY); ctx.lineTo(hx, H - padY); ctx.stroke();
        if (sY && hoverStep < n) {
            ctx.fillStyle = "#d0d0d0";
            ctx.beginPath(); ctx.arc(hx - 0.5, sY(sigmas[hoverStep]), 2.5, 0, Math.PI * 2); ctx.fill();
        }
        if (dY && hoverStep >= 1 && hoverStep - 1 < deltas.length) {
            ctx.fillStyle = accent;
            ctx.beginPath(); ctx.arc(hx - 0.5, dY(deltas[hoverStep - 1]), 2.5, 0, Math.PI * 2); ctx.fill();
        }
    }
}

function drawLine(canvas, accent, values, totalSteps) {
    const { ctx, W, H } = syncDPR(canvas);
    const padY = 3, iW = W - 2 * PAD, iH = H - 2 * padY;
    ctx.clearRect(0, 0, W, H);
    gridlines(ctx, W, H, padY, "rgba(128,128,128,0.18)");
    if (!values.length) return;
    let vMax = -Infinity, vMin = Infinity;
    for (const v of values) { if (v > vMax) vMax = v; if (v < vMin) vMin = v; }
    if (vMin > 0) vMin = 0;
    const range = Math.max(vMax - vMin, 1e-6);
    const xSteps = Math.max(totalSteps || values.length, values.length);
    const px = (i) => PAD + (i / Math.max(1, xSteps - 1)) * iW;
    const py = (v) => padY + (1 - (v - vMin) / range) * iH;
    ctx.beginPath();
    ctx.moveTo(PAD, H - padY);
    for (let i = 0; i < values.length; i++) ctx.lineTo(px(i), py(values[i]));
    ctx.lineTo(px(values.length - 1), H - padY);
    ctx.closePath();
    ctx.globalAlpha = 0.15; ctx.fillStyle = accent; ctx.fill(); ctx.globalAlpha = 1;
    ctx.strokeStyle = accent; ctx.lineWidth = 1.3;
    ctx.beginPath();
    for (let i = 0; i < values.length; i++) { if (i === 0) ctx.moveTo(px(i), py(values[i])); else ctx.lineTo(px(i), py(values[i])); }
    ctx.stroke();
}

// ============================================================================
// createPanelPreview: returns { host, setEnabled, destroy }
//   host     : DOM element to put in the panel (hidden while disabled)
//   setEnabled(true/false): attach / detach the websocket listener and free memory
// ============================================================================
export function createPanelPreview({ height = 260, onResize } = {}) {
    ensureStyles();

    const host = el("div", "nlp-pv-host");
    host.style.display = "none";
    const root = el("div", "nlp-pv", host);
    root.style.height = height + "px";

    const area = el("div", "nlp-pv-area", root);
    const imgA = el("img", "nlp-pv-img", area);
    const imgB = el("img", "nlp-pv-img", area);
    imgA.draggable = false; imgB.draggable = false;
    imgB.style.opacity = "0";
    let visibleImg = imgA, pendingImg = imgB;

    const vCanvas = el("canvas", "nlp-pv-img", area);   // animated WebP frames
    vCanvas.style.opacity = "0";
    const vCtx = vCanvas.getContext("2d");

    const mkVideo = () => {
        const v = el("video", "nlp-pv-img", area);
        v.style.opacity = "0";
        v.muted = true; v.playsInline = true; v.loop = true; v.autoplay = true;
        v.disablePictureInPicture = true;
        return v;
    };
    let visibleVideo = mkVideo(), pendingVideo = mkVideo();

    const placeholder = el("div", "nlp-pv-ph", area);
    placeholder.textContent = "waiting for sample\u2026";
    const scrub = el("div", "nlp-pv-scrub", area);
    const scrubFill = el("div", "nlp-pv-fill", scrub);
    scrub.style.display = "none";

    const bar = el("div", "nlp-pv-bar", root);
    const title = el("span", "nlp-pv-title", bar);
    title.textContent = "Preview";
    let audioMuted = true;
    const audioBtn = el("button", "nlp-pv-audio", bar);
    audioBtn.type = "button";
    audioBtn.textContent = "\uD83D\uDD07";
    audioBtn.title = "Toggle preview audio";
    audioBtn.style.display = "none";
    const summary = el("span", "nlp-pv-sum", bar);
    summary.textContent = "idle";

    const graphs = el("div", "nlp-pv-graphs", root);
    const makeCell = (label) => {
        const cell = el("div", "nlp-pv-cell", graphs);
        const head = el("div", "nlp-pv-ghead", cell);
        const lbl = el("span", "nlp-pv-glabel", head);
        lbl.textContent = label;
        const val = el("span", "nlp-pv-gval", head);
        const canvas = el("canvas", "nlp-pv-canvas", cell);
        return { canvas, val, lbl };
    };
    const sd = makeCell("\u03C3 / \u0394");
    const tm = makeCell("step time (ms)");
    sd.canvas.style.cursor = "crosshair";
    tm.canvas.style.cursor = "pointer";
    tm.canvas.title = "Click to toggle ms / s";

    const specWrap = el("div", "nlp-pv-spec", root);
    const specHead = el("div", "nlp-pv-ghead", specWrap);
    el("span", "nlp-pv-glabel", specHead).textContent = "audio spectrogram";
    const specCanvas = el("canvas", null, specWrap);

    const grip = el("div", "nlp-pv-grip", root);
    grip.title = "Drag to resize the preview";

    // ---- per-run state ----
    let enabled = false;
    let source = null;                       // node_id this run is following
    let hoverStep = null, lockedStep = null, lastCurrentStep = -1;
    const history = { stepMs: [], delta: [] };
    let sigmas = null, totalSteps = 0;
    const stepBlobUrls = [], stepVideoFrames = [], stepMp4Urls = [];
    const stepSpecImgs = [], stepHasAudio = [], stepFps = [];
    let liveBlobUrl = null, liveMp4Url = null, currentMp4Url = null;
    let playbackStartMs = null, rafVideo = null, rafScrub = null;
    let secondsUnit = false;
    let lastAvg = null, lastTotal = null, lastStep = null, lastW = null, lastH = null;
    let paused = false, pauseAt = 0, bakedFps = null;
    let specShown = false, specRun = 0, specKey = null;

    const accent = () => accentOf(root);
    const fps = () => bakedFps > 0 ? bakedFps : 12;

    const activeStep = () => lockedStep ?? hoverStep ?? lastCurrentStep;
    const elapsed = () => playbackStartMs == null ? 0 : (paused ? pauseAt : performance.now()) - playbackStartMs;
    const mp4Active = () => currentMp4Url != null && Number.isFinite(visibleVideo.duration) && visibleVideo.duration > 0;
    function clipMs() {
        if (mp4Active()) return visibleVideo.duration * 1000;
        const v = stepVideoFrames[activeStep()];
        if (v && v.frames.length > 1) return v.frames.length * (1000 / fps());
        return 0;
    }
    function progress() {
        if (mp4Active()) return visibleVideo.currentTime / visibleVideo.duration;
        const d = clipMs();
        if (d <= 0 || playbackStartMs == null) return 0;
        return (elapsed() % d) / d;
    }
    function seek(pos) {
        pos = Math.max(0, Math.min(1, pos));
        const d = clipMs();
        if (d <= 0) return;
        const ref = paused ? pauseAt : performance.now();
        if (playbackStartMs == null) playbackStartMs = ref;
        playbackStartMs = ref - pos * d;
        if (mp4Active()) visibleVideo.currentTime = pos * visibleVideo.duration;
    }
    function togglePause() {
        const will = !paused;
        if (mp4Active()) { if (will) visibleVideo.pause(); else visibleVideo.play().catch(() => {}); }
        if (will) { pauseAt = performance.now(); paused = true; }
        else { if (playbackStartMs != null) playbackStartMs += performance.now() - pauseAt; paused = false; }
        scrub.classList.toggle("nlp-pv-paused", paused);
    }
    function applyMute() {
        visibleVideo.muted = audioMuted;
        pendingVideo.muted = true;
        audioBtn.textContent = audioMuted ? "\uD83D\uDD07" : "\uD83D\uDD0A";
        audioBtn.classList.toggle("nlp-pv-on", !audioMuted);
    }

    // ---- spectrogram ----
    function drawSpec(force) {
        const idx = activeStep();
        const im = stepSpecImgs[idx] || stepSpecImgs[lastCurrentStep];
        if (!im) return;
        const W = specCanvas.clientWidth || specCanvas.width;
        const px = clipMs() > 0 ? Math.round(progress() * W) : -1;
        const key = im.src.length + ":" + idx + ":" + px + ":" + W;
        if (!force && key === specKey) return;
        specKey = key;
        const { ctx, H } = syncDPR(specCanvas);
        ctx.clearRect(0, 0, W, H);
        ctx.drawImage(im, 0, 0, W, H);
        if (px >= 0) {
            ctx.strokeStyle = "rgba(255,255,255,0.85)"; ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(px + 0.5, 0); ctx.lineTo(px + 0.5, H); ctx.stroke();
        }
    }
    function setStepSpec(idx, b64) {
        const run = specRun;
        const im = new Image();
        im.onload = () => {
            if (run !== specRun) return;
            stepSpecImgs[idx] = im;
            if (!specShown) { specShown = true; specWrap.style.display = "flex"; }
            drawSpec(true);
        };
        im.src = "data:image/png;base64," + b64;
    }
    function resetSpec() {
        specRun++;
        stepSpecImgs.length = 0; stepHasAudio.length = 0; stepFps.length = 0;
        specShown = false; specKey = null;
        specWrap.style.display = "none";
        audioBtn.style.display = "none";
    }

    // ---- readouts ----
    const fmtTime = (ms) => ms == null || !Number.isFinite(ms) ? "\u2014"
        : secondsUnit ? `${(ms / 1000).toFixed(2)}s` : `${ms.toFixed(0)}ms`;
    function stepTime() {
        const idx = hoverStep ?? lockedStep ?? lastCurrentStep;
        const t = idx - 1;
        return t >= 0 && t < history.stepMs.length ? history.stepMs[t] : null;
    }
    function renderTime() {
        tm.lbl.textContent = secondsUnit ? "step time (s)" : "step time (ms)";
        tm.val.textContent = fmtTime(stepTime());
        if (lastAvg != null && lastTotal != null && lastStep != null) {
            const eta = Math.max(0, lastTotal - lastStep) * lastAvg / 1000;
            const avg = secondsUnit ? `${(lastAvg / 1000).toFixed(2)}s/step` : `${lastAvg.toFixed(0)}ms/step`;
            summary.textContent = `${lastW}\u00D7${lastH} \u00B7 ${lastStep}/${lastTotal} \u00B7 ${avg} \u00B7 ETA ${eta.toFixed(1)}s`;
        }
    }
    function updateSdHeader() {
        let idx = null, prefix = "";
        if (hoverStep != null && sigmas && hoverStep < sigmas.length) { idx = hoverStep; prefix = `[${idx}] `; }
        else if (lockedStep != null && sigmas && lockedStep < sigmas.length) { idx = lockedStep; prefix = `\uD83D\uDD12[${idx}] `; }
        else if (lastCurrentStep >= 0 && sigmas) idx = Math.min(lastCurrentStep, sigmas.length - 1);
        if (idx == null) return;
        const di = idx - 1;
        const d = di >= 0 && di < history.delta.length ? history.delta[di] : null;
        sd.val.textContent = `${prefix}${fmt(sigmas[idx], 3)} / ${fmt(d, 3)}`;
    }

    // ---- frame display ----
    function showLiveFrame(url) {
        const target = pendingImg;
        target.src = url;
        target.decode().then(() => {
            if (hoverStep != null || lockedStep != null) return;
            if (liveBlobUrl !== url || target !== pendingImg) return;
            target.style.opacity = "1";
            visibleImg.style.opacity = "0";
            const prev = visibleImg; visibleImg = target; pendingImg = prev;
        }).catch(() => {});
    }
    async function decodeAnimated(blob) {
        if (typeof ImageDecoder === "undefined") return null;
        try {
            const dec = new ImageDecoder({ data: blob.stream(), type: blob.type });
            await dec.completed;
            const track = dec.tracks.selectedTrack;
            if (!track || track.frameCount <= 1) { dec.close?.(); return null; }
            const frames = [];
            for (let i = 0; i < track.frameCount; i++) frames.push((await dec.decode({ frameIndex: i })).image);
            dec.close?.();
            return { frames };
        } catch { return null; }
    }
    function closeStepVideo(i) {
        const v = stepVideoFrames[i];
        if (!v) return;
        for (const f of v.frames) { try { f.close(); } catch {} }
        stepVideoFrames[i] = null;
    }
    function drawVideoFrame() {
        const v = stepVideoFrames[activeStep()];
        if (!v) return false;
        if (playbackStartMs == null) playbackStartMs = performance.now();
        const dur = 1000 / fps();
        const t = elapsed() % (v.frames.length * dur);
        const frame = v.frames[Math.min(v.frames.length - 1, Math.floor(t / dur))];
        if (vCanvas.width !== frame.displayWidth || vCanvas.height !== frame.displayHeight) {
            vCanvas.width = frame.displayWidth; vCanvas.height = frame.displayHeight;
        }
        vCtx.drawImage(frame, 0, 0);
        return true;
    }
    function startVideoLoop() {
        if (rafVideo != null) return;
        const loop = () => {
            rafVideo = requestAnimationFrame(loop);
            if (!drawVideoFrame()) return;
            if (vCanvas.style.opacity !== "1") {
                vCanvas.style.opacity = "1"; imgA.style.opacity = "0"; imgB.style.opacity = "0";
            }
        };
        rafVideo = requestAnimationFrame(loop);
    }
    function stopVideoLoop() {
        if (rafVideo != null) { cancelAnimationFrame(rafVideo); rafVideo = null; }
        vCanvas.style.opacity = "0";
        visibleImg.style.opacity = "1";
    }
    function showMp4(url) {
        if (url === currentMp4Url) return;
        currentMp4Url = url;
        if (playbackStartMs == null) playbackStartMs = performance.now();
        const target = pendingVideo;
        target.src = url;
        const promote = () => {
            if (currentMp4Url !== url || target !== pendingVideo) return;
            try {
                const d = target.duration;
                if (Number.isFinite(d) && d > 0) target.currentTime = (elapsed() / 1000) % d;
            } catch {}
            target.style.opacity = "1";
            requestAnimationFrame(() => requestAnimationFrame(() => {
                if (target !== visibleVideo && currentMp4Url === url) {
                    visibleVideo.style.opacity = "0";
                    visibleVideo.pause();
                    const prev = visibleVideo; visibleVideo = target; pendingVideo = prev;
                    applyMute();
                    imgA.style.opacity = "0"; imgB.style.opacity = "0"; vCanvas.style.opacity = "0";
                    if (paused) visibleVideo.pause();
                }
            }));
        };
        const afterSeek = () => {
            if (typeof target.requestVideoFrameCallback === "function") target.requestVideoFrameCallback(() => promote());
            else promote();
        };
        const onLoaded = () => {
            target.removeEventListener("loadeddata", onLoaded);
            try {
                const d = target.duration;
                if (Number.isFinite(d) && d > 0) {
                    target.addEventListener("seeked", afterSeek, { once: true });
                    target.currentTime = (elapsed() / 1000) % d;
                } else afterSeek();
                target.play().catch(() => {});
            } catch { promote(); }
        };
        if (target.readyState >= 2) onLoaded();
        else target.addEventListener("loadeddata", onLoaded, { once: true });
    }
    function hideMp4() {
        visibleVideo.pause(); visibleVideo.style.opacity = "0";
        pendingVideo.pause(); pendingVideo.style.opacity = "0";
        visibleImg.style.opacity = "1";
        currentMp4Url = null;
    }
    function setStepBlob(idx, blob) {
        const url = URL.createObjectURL(blob);
        if (placeholder.parentNode) placeholder.remove();
        const free = hoverStep == null && lockedStep == null;
        if (blob.type === "video/mp4") {
            if (stepMp4Urls[idx]) { try { URL.revokeObjectURL(stepMp4Urls[idx]); } catch {} }
            stepMp4Urls[idx] = url;
            liveMp4Url = url;
            if (free) showMp4(url);
            return;
        }
        if (stepBlobUrls[idx]) { try { URL.revokeObjectURL(stepBlobUrls[idx]); } catch {} }
        stepBlobUrls[idx] = url;
        liveBlobUrl = url;
        if (blob.type === "image/webp") {
            decodeAnimated(blob).then((v) => {
                if (!v) { if (hoverStep == null && lockedStep == null && liveBlobUrl === url) showLiveFrame(url); return; }
                closeStepVideo(idx);
                stepVideoFrames[idx] = v;
                startVideoLoop();
            });
        } else if (free) showLiveFrame(url);
    }
    function resetFrames() {
        for (const u of stepBlobUrls) if (u) try { URL.revokeObjectURL(u); } catch {}
        stepBlobUrls.length = 0; liveBlobUrl = null;
        for (let i = 0; i < stepVideoFrames.length; i++) closeStepVideo(i);
        stepVideoFrames.length = 0;
        stopVideoLoop();
        for (const u of stepMp4Urls) if (u) try { URL.revokeObjectURL(u); } catch {}
        stepMp4Urls.length = 0; liveMp4Url = null;
        hideMp4();
        resetSpec();
        playbackStartMs = null; bakedFps = null; paused = false;
        scrub.classList.remove("nlp-pv-paused");
    }
    function resetRun() {
        history.stepMs.length = 0; history.delta.length = 0;
        resetFrames();
        hoverStep = null; lockedStep = null; lastCurrentStep = -1;
    }
    function fullReset() {
        resetRun();
        sigmas = null; totalSteps = 0; source = null;
        lastAvg = lastTotal = lastStep = lastW = lastH = null;
        title.textContent = "Preview";
        summary.textContent = "idle";
        sd.val.textContent = ""; tm.val.textContent = "";
        const c = accent();
        drawSigmaDelta(sd.canvas, c, null, [], 0, 0, null, null);
        drawLine(tm.canvas, c, [], 0);
        if (!placeholder.parentNode) area.appendChild(placeholder);
    }

    function redraw() {
        drawSigmaDelta(sd.canvas, accent(), sigmas, history.delta, lastCurrentStep, totalSteps, hoverStep, lockedStep);
        updateSdHeader();
        renderTime();
        const shown = lockedStep ?? hoverStep;
        const target = shown != null ? shown : lastCurrentStep;
        if (stepMp4Urls[target]) { stopVideoLoop(); showMp4(stepMp4Urls[target]); }
        else if (stepVideoFrames[target]) { hideMp4(); startVideoLoop(); }
        else if (shown != null && stepBlobUrls[shown]) { stopVideoLoop(); hideMp4(); visibleImg.src = stepBlobUrls[shown]; }
        else if (liveMp4Url) { stopVideoLoop(); showMp4(liveMp4Url); }
        else if (liveBlobUrl) { stopVideoLoop(); hideMp4(); showLiveFrame(liveBlobUrl); }
    }

    // ---- scrub bar / playback-rate loop (only runs while enabled) ----
    function scrubTick() {
        rafScrub = requestAnimationFrame(scrubTick);
        const d = clipMs();
        if (d > 0) {
            if (scrub.style.display === "none") scrub.style.display = "block";
            scrubFill.style.width = (progress() * 100) + "%";
        } else if (scrub.style.display !== "none") scrub.style.display = "none";
        if (mp4Active()) {
            const idx = activeStep();
            const baked = stepFps[idx] ?? bakedFps;
            const rate = stepHasAudio[idx] ? 1 : (baked > 0 ? Math.min(16, Math.max(0.0625, 12 / baked)) : 1);
            if (Math.abs(visibleVideo.playbackRate - rate) > 0.001) visibleVideo.playbackRate = rate;
        }
        if (specShown) drawSpec(false);
    }

    scrub.addEventListener("mousedown", (ev) => {
        if (ev.button !== 0) return;
        ev.stopPropagation(); ev.preventDefault();
        const rect = scrub.getBoundingClientRect();
        const go = (e) => seek((e.clientX - rect.left) / rect.width);
        go(ev);
        const up = () => { document.removeEventListener("mousemove", go); document.removeEventListener("mouseup", up); };
        document.addEventListener("mousemove", go);
        document.addEventListener("mouseup", up);
    });
    area.addEventListener("click", (ev) => {
        if (scrub.contains(ev.target) || clipMs() <= 0) return;
        togglePause();
    });
    audioBtn.addEventListener("click", (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        audioMuted = !audioMuted;
        applyMute();
        if (!audioMuted && !paused) visibleVideo.play().catch(() => {});
    });
    const toggleUnit = (ev) => { ev.stopPropagation(); secondsUnit = !secondsUnit; renderTime(); };
    for (const t of [tm.canvas, tm.lbl, tm.val]) t.addEventListener("click", toggleUnit);

    const stepFromEvent = (ev) => {
        const rect = sd.canvas.getBoundingClientRect();
        const iW = Math.max(1, rect.width - 2 * PAD);
        const xSteps = Math.max(totalSteps || sigmas.length, sigmas.length, history.delta.length);
        const fx = (ev.clientX - rect.left - PAD) / iW;
        return Math.max(0, Math.min(xSteps - 1, Math.round(fx * (xSteps - 1))));
    };
    sd.canvas.addEventListener("mousemove", (ev) => {
        if (!sigmas) return;
        const i = stepFromEvent(ev);
        if (i !== hoverStep) { hoverStep = i; redraw(); }
    });
    sd.canvas.addEventListener("mouseleave", () => { if (hoverStep != null) { hoverStep = null; redraw(); } });
    sd.canvas.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (lockedStep != null) lockedStep = null;
        else if (sigmas) lockedStep = stepFromEvent(ev);
        redraw();
    });

    // keyboard: only while the cursor is over the preview, and never while typing in a field
    let over = false;
    root.addEventListener("mouseenter", () => { over = true; });
    root.addEventListener("mouseleave", () => { over = false; });
    const onKey = (ev) => {
        if (!over || !enabled) return;
        const tag = ev.target?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        if (ev.key === " " && clipMs() > 0) { ev.preventDefault(); ev.stopPropagation(); togglePause(); return; }
        if (!sigmas || (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight")) return;
        const xSteps = Math.max(totalSteps || sigmas.length, sigmas.length, history.delta.length);
        const cur = lockedStep ?? hoverStep ?? lastCurrentStep;
        ev.preventDefault(); ev.stopPropagation();
        lockedStep = Math.max(0, Math.min(xSteps - 1, cur + (ev.key === "ArrowRight" ? 1 : -1)));
        redraw();
    };

    // resize grip
    grip.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        e.preventDefault(); e.stopPropagation();
        const startY = e.clientY, startH = root.offsetHeight;
        const move = (ev) => { root.style.height = Math.max(120, Math.min(window.innerHeight * 0.7, startH + ev.clientY - startY)) + "px"; };
        const up = () => {
            document.removeEventListener("mousemove", move);
            document.removeEventListener("mouseup", up);
            onResize?.(root.offsetHeight);
        };
        document.addEventListener("mousemove", move);
        document.addEventListener("mouseup", up);
    });

    // ---- incoming data ----
    function handle(data) {
        try {
            const id = String(data.node_id);
            const isInit = Array.isArray(data.sigmas) && data.sigmas.length > 1;
            if (isInit) {
                // a new run: follow this preview node from now on
                sigmas = data.sigmas;
                resetRun();
                if (source !== id) { source = id; title.textContent = `Preview \u2190 ${id}`; }
            } else if (source != null && id !== source) {
                return;   // another preview node, ignore it
            } else if (source == null) {
                source = id; title.textContent = `Preview \u2190 ${id}`;
            }

            if (typeof data.image === "string") {
                const mime = typeof data.mime === "string" ? data.mime : "image/jpeg";
                if (typeof data.fps === "number" && data.fps > 0) { bakedFps = data.fps; stepFps[data.step] = data.fps; }
                stepHasAudio[data.step] = !!data.audio;
                if (data.audio && audioBtn.style.display === "none") { audioBtn.style.display = ""; applyMute(); }
                setStepBlob(data.step, b64ToBlob(data.image, mime));
            }
            if (typeof data.audio_spec === "string") setStepSpec(data.step, data.audio_spec);

            totalSteps = data.total || totalSteps;
            if (data.step_ms != null) history.stepMs.push(data.step_ms);
            if (data.delta != null) history.delta.push(data.delta);
            if (history.stepMs.length === 1 && data.step_ms > 1500) secondsUnit = true;
            lastAvg = data.avg_step_ms; lastStep = data.step; lastTotal = data.total;
            lastW = data.w; lastH = data.h; lastCurrentStep = data.step;
            renderTime();

            drawSigmaDelta(sd.canvas, accent(), sigmas, history.delta, lastCurrentStep, totalSteps, hoverStep, lockedStep);
            updateSdHeader();
            drawLine(tm.canvas, accent(), history.stepMs, totalSteps);
        } catch (err) {
            console.warn("nougan-live-panel: preview update failed", err);
        }
    }
    const onEvent = (e) => {
        const d = e.detail;
        if (d && d.node_id != null) handle(d);
    };

    function setEnabled(on) {
        on = !!on;
        if (on === enabled) { host.style.display = on ? "" : "none"; return; }
        enabled = on;
        if (on) {
            host.style.display = "";
            api.addEventListener(EVENT, onEvent);
            document.addEventListener("keydown", onKey, true);
            if (rafScrub == null) rafScrub = requestAnimationFrame(scrubTick);
            requestAnimationFrame(fullReset);   // draw empty graphs once it is laid out
        } else {
            api.removeEventListener(EVENT, onEvent);
            document.removeEventListener("keydown", onKey, true);
            if (rafScrub != null) { cancelAnimationFrame(rafScrub); rafScrub = null; }
            fullReset();
            host.style.display = "none";
        }
    }

    function destroy() {
        setEnabled(false);
        host.remove();
    }

    return { host, setEnabled, destroy };
}
