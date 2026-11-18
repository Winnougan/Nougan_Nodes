// nougan_audio_trim.js — frontend for "Nougan Audio Loader 🎵" (node ID: NouganAudioTrimLoader).
// Same design language as the Ultimate Model Loader / Lora Loader: ONE litegraph DOM widget, a
// boxed renamable section, purple accent, WebGPU status strip with a 2D fallback.
//
//  • waveform: min/max bars from /nougan/audio_trim/peaks, Canvas2D (always works)
//  • drag the two purple handles to trim · click outside the selection = nearest handle jumps there
//  • drag inside the selection to scrub (a short audible preview plays on release)
//  • Space = play / pause the selection · double-click the waveform = select all
//  • ▶ play · 🔁 loop · ⟲ reset trim · start / end boxes accept seconds or m:ss.mmm
//  • 📂 Load audio… (or drop a file on the waveform) uploads into ComfyUI's input folder
//
// The three real widgets (audio, start_time, end_time) are untouched: start/end are hidden and
// driven by this panel, so values save, link and run exactly like any other widget.
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const BUILD = "2026-11-18a";
const NODE_NAME = "NouganAudioTrimLoader";
const PANEL = "nga_panel";
const PROP_HEAD = "Heading Waveform";
const MIN_W = 380;
const MIN_SEL = 0.01;        // shortest selectable span, seconds
const BUCKETS = 1600;
const HIT = 9;               // px grab radius of a trim handle
const AUDIO_EXT = /\.(mp3|wav|flac|ogg|oga|opus|m4a|aac|wma|aif|aiff|webm|mp4|mkv|mov|avi)$/i;


// ── css (same palette as the other Nougan loaders) ─────────────────────────

const CSS = `
.nga-inner{display:flex;flex-direction:column;gap:6px;width:100%;box-sizing:border-box;padding:4px 2px 6px;
  font:12px/1.4 "Inter","Segoe UI",sans-serif;color:#dfe3ea;overflow:visible;pointer-events:auto;
  user-select:none;outline:none;}
.nga-inner *{box-sizing:border-box;}
.nga-inner button{font:inherit;color:inherit;}
.nga-inner>*{flex-shrink:0;}
.nga-strip{display:flex;align-items:center;gap:8px;height:22px;}
.nga-strip canvas{flex:0 0 64px;height:14px;border-radius:4px;background:#222;}
.nga-status{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#9aa3b2;font-size:11px;}
.nga-status.err{color:#f0616d;}
.nga-section{border:1px solid #3a3a46;border-radius:6px;background:rgba(255,255,255,.02);overflow:hidden;}
.nga-head{display:flex;align-items:center;gap:6px;padding:4px 6px;background:rgba(255,255,255,.045);
  border-bottom:1px solid #3a3a46;}
.nga-title{flex:1;background:transparent;border:none;outline:none;color:#e8b4ff;user-select:text;
  font-weight:600;font-size:12px;padding:1px 2px;border-radius:3px;min-width:0;}
.nga-title:focus{background:rgba(255,255,255,.07);}
.nga-chev{cursor:pointer;color:#6b7280;user-select:none;width:14px;text-align:center;}
.nga-body{display:flex;flex-direction:column;gap:6px;padding:6px;}
.nga-body.nga-collapsed{display:none;}

.nga-stage{position:relative;height:112px;border-radius:5px;overflow:hidden;background:#15151b;
  border:1px solid #2f2f3a;}
.nga-stage.drop{border-color:#7c3aed;box-shadow:0 0 0 2px rgba(124,58,237,.35);}
.nga-canvas{display:block;width:100%;height:100%;touch-action:none;cursor:crosshair;}
.nga-msg{position:absolute;inset:0;display:grid;place-items:center;text-align:center;padding:0 16px;
  color:#6b7280;font-size:11.5px;pointer-events:none;}
.nga-msg.err{color:#f0616d;}

.nga-row{display:flex;align-items:center;gap:6px;min-height:24px;}
.nga-sp{flex:1;}
.nga-btn{cursor:pointer;background:#1b1b23;color:#dfe3ea;border:1px solid #444;border-radius:4px;
  padding:2px 9px;height:24px;font-size:12px;transition:border-color .12s,background .12s,color .12s;}
.nga-btn:hover{border-color:#7c3aed;color:#e8b4ff;}
.nga-btn.on{background:#7c3aed;border-color:#a78bfa;color:#fff;}
.nga-btn.play{min-width:34px;font-weight:700;}
.nga-time{font-variant-numeric:tabular-nums;color:#c9ced8;font-size:11.5px;white-space:nowrap;}
.nga-lbl{color:#9aa3b2;font-size:11px;}
.nga-in{width:78px;height:22px;background:#1b1b23;color:#dfe3ea;border:1px solid #444;border-radius:4px;
  padding:0 6px;font:11.5px "Inter",sans-serif;font-variant-numeric:tabular-nums;text-align:center;
  outline:none;user-select:text;}
.nga-in:focus{border-color:#7c3aed;box-shadow:0 0 0 2px rgba(124,58,237,.2);}
.nga-len{color:#e8b4ff;font-size:11.5px;font-variant-numeric:tabular-nums;white-space:nowrap;}
.nga-hint{color:#6b7280;font-size:10.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
`;

function injectCss() {
    if (document.getElementById("nga-css")) return;
    const st = document.createElement("style");
    st.id = "nga-css";
    st.textContent = CSS;
    document.head.appendChild(st);
}


// ── helpers ────────────────────────────────────────────────────────────────

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const round3 = (v) => Math.round(v * 1000) / 1000;

function h(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
}

function fmtTime(t) {
    t = Math.max(0, t || 0);
    const m = Math.floor(t / 60);
    return `${m}:${(t - m * 60).toFixed(3).padStart(6, "0")}`;
}

function parseTime(str) {
    str = String(str ?? "").trim().replace(",", ".");
    if (!str) return NaN;
    if (str.includes(":")) {
        const p = str.split(":");
        const sec = parseFloat(p.pop());
        const min = parseFloat(p.pop() || "0");
        const hr = parseFloat(p.pop() || "0");
        return hr * 3600 + min * 60 + sec;
    }
    return parseFloat(str);
}

// "folder/clip.wav [input]" -> parts for /view
function splitName(name) {
    let type = "input", n = String(name || "");
    const m = n.match(/^(.*)\s+\[(input|output|temp)\]\s*$/);
    if (m) { n = m[1]; type = m[2]; }
    const i = n.lastIndexOf("/");
    return { base: i >= 0 ? n.slice(i + 1) : n, sub: i >= 0 ? n.slice(0, i) : "", type };
}

function viewUrl(name) {
    const { base, sub, type } = splitName(name);
    return api.apiURL(`/view?filename=${encodeURIComponent(base)}&type=${type}&subfolder=${encodeURIComponent(sub)}`);
}

// pointer/mouse events that bubble out of the panel into the canvas layers kill focus
function guardPanel(el) {
    const stop = (e) => e.stopPropagation();
    for (const t of ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick"]) el.addEventListener(t, stop);
}
function guardTextInput(input) {
    const stop = (e) => e.stopPropagation();
    for (const t of ["keydown", "keyup", "keypress"]) input.addEventListener(t, stop);
    input.addEventListener("pointerdown", () => setTimeout(() => input.focus({ preventScroll: true }), 0));
}

// widgets: every write is guarded — on some frontends a property can be read-only
function hideWidget(w) {
    if (!w) return;
    try { w.hidden = true; } catch { }
    try { w.computeSize = () => [0, -4]; } catch { }
}


// ── WebGPU status canvas (2D fallback) — same strip as the other loaders ───

async function startStrip(canvas) {
    const w = canvas.width = 128, hgt = canvas.height = 28;
    if (navigator.gpu) {
        try {
            const adapter = await navigator.gpu.requestAdapter({ powerPreference: "low-power" });
            if (adapter) {
                const device = await adapter.requestDevice();
                const ctx = canvas.getContext("webgpu");
                if (ctx) {
                    const format = navigator.gpu.getPreferredCanvasFormat();
                    ctx.configure({ device, format, alphaMode: "opaque" });
                    let raf, t0 = performance.now();
                    const frame = () => {
                        if (!canvas.isConnected) return;
                        if (document.hidden) { raf = requestAnimationFrame(frame); return; }
                        const t = (performance.now() - t0) / 1000;
                        const enc = device.createCommandEncoder();
                        const pass = enc.beginRenderPass({
                            colorAttachments: [{
                                view: ctx.getCurrentTexture().createView(),
                                loadOp: "clear",
                                clearValue: { r: .30 + .18 * Math.sin(t * 1.4), g: .12, b: .48 + .12 * Math.sin(t * .9 + 1), a: 1 },
                                storeOp: "store",
                            }],
                        });
                        pass.end();
                        device.queue.submit([enc.finish()]);
                        raf = requestAnimationFrame(frame);
                    };
                    frame();
                    return () => cancelAnimationFrame(raf);
                }
            }
        } catch (_) { /* fall through to 2D */ }
    }
    const c2 = canvas.getContext("2d");
    if (!c2) return () => { };
    let raf;
    const frame = () => {
        if (!canvas.isConnected) return;
        if (!document.hidden) {
            const t = performance.now() / 1000;
            const g = c2.createLinearGradient(0, 0, w, 0);
            g.addColorStop(0, `hsl(${(t * 40) % 360},70%,45%)`);
            g.addColorStop(1, `hsl(${(t * 40 + 80) % 360},70%,40%)`);
            c2.fillStyle = g; c2.fillRect(0, 0, w, hgt);
        }
        raf = requestAnimationFrame(frame);
    };
    frame();
    return () => cancelAnimationFrame(raf);
}


// ── node sizing: title + slots + panel height, always, automatically ───────

function syncHeight(node) {
    if (!node._nga || !node.graph) return;
    const w = Math.max(MIN_W, node.size[0]);
    const hgt = node.computeSize()[1];
    if (Math.abs(node.size[1] - hgt) > 1 || node.size[0] !== w) node.setSize([w, hgt]);
    node.setDirtyCanvas(true, true);
}


// ── per-node editor ────────────────────────────────────────────────────────

function buildDom(node) {
    teardownDom(node);
    injectCss();

    const audioW = node.widgets?.find((w) => w.name === "audio");
    const startW = node.widgets?.find((w) => w.name === "start_time");
    const endW = node.widgets?.find((w) => w.name === "end_time");
    hideWidget(startW);
    hideWidget(endW);

    node.properties = node.properties || {};
    if (node.properties[PROP_HEAD] == null) node.properties[PROP_HEAD] = "Waveform";

    const S = {
        dur: 0, sr: 0, ch: 0, peaks: null, gain: 1,
        start: 0, end: 0, pos: 0,
        playing: false, loop: false, snippetEnd: null,
        lastName: null, seq: 0, dead: false, raf: 0, abort: null,
        statusText: "", statusErr: false,
    };
    const audio = new Audio();
    audio.preload = "auto";

    // ── dom ──
    const inner = h("div", "nga-inner");
    inner.tabIndex = 0;
    guardPanel(inner);

    const strip = h("div", "nga-strip");
    const gpuCanvas = document.createElement("canvas");
    const status = h("div", "nga-status");
    strip.appendChild(gpuCanvas);
    strip.appendChild(status);
    inner.appendChild(strip);
    let stripStop = null, stripDead = false;
    startStrip(gpuCanvas).then((fn) => { if (stripDead) fn?.(); else stripStop = fn; }).catch(() => { });

    const sec = h("div", "nga-section");
    const head = h("div", "nga-head");
    const title = h("input", "nga-title");
    title.value = node.properties[PROP_HEAD];
    title.spellcheck = false;
    title.title = "click to rename this heading";
    guardTextInput(title);
    title.addEventListener("input", () => { node.properties[PROP_HEAD] = title.value; node.setDirtyCanvas(true, true); });
    const chev = h("span", "nga-chev", "▾");
    head.appendChild(title);
    head.appendChild(chev);

    const body = h("div", "nga-body");
    chev.onclick = () => {
        const c = body.classList.toggle("nga-collapsed");
        chev.textContent = c ? "▸" : "▾";
        syncHeight(node);
    };

    const stage = h("div", "nga-stage");
    const canvas = h("canvas", "nga-canvas");
    const msg = h("div", "nga-msg", "Pick or load an audio file");
    stage.appendChild(canvas);
    stage.appendChild(msg);
    body.appendChild(stage);

    const ctl = h("div", "nga-row");
    const playBtn = h("button", "nga-btn play", "▶");
    playBtn.title = "Play / pause the selection (Space)";
    const loopBtn = h("button", "nga-btn", "🔁");
    loopBtn.title = "Loop the selection";
    const resetBtn = h("button", "nga-btn", "⟲");
    resetBtn.title = "Reset trim (select everything)";
    const timeEl = h("span", "nga-time", "0:00.000 / 0:00.000");
    ctl.appendChild(playBtn);
    ctl.appendChild(loopBtn);
    ctl.appendChild(resetBtn);
    ctl.appendChild(h("span", "nga-sp"));
    ctl.appendChild(timeEl);
    body.appendChild(ctl);

    const trim = h("div", "nga-row");
    const inStart = h("input", "nga-in");
    const inEnd = h("input", "nga-in");
    inStart.title = "Trim start — seconds or m:ss.mmm";
    inEnd.title = "Trim end — seconds or m:ss.mmm";
    guardTextInput(inStart);
    guardTextInput(inEnd);
    const lenEl = h("span", "nga-len", "");
    trim.appendChild(h("span", "nga-lbl", "start"));
    trim.appendChild(inStart);
    trim.appendChild(h("span", "nga-lbl", "end"));
    trim.appendChild(inEnd);
    trim.appendChild(h("span", "nga-sp"));
    trim.appendChild(lenEl);
    body.appendChild(trim);

    const fileRow = h("div", "nga-row");
    const loadBtn = h("button", "nga-btn", "📂 Load audio…");
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "audio/*,video/*,.mp3,.wav,.flac,.ogg,.opus,.m4a,.aac";
    fileInput.style.display = "none";
    const hint = h("span", "nga-hint", "or drop a file on the waveform");
    fileRow.appendChild(loadBtn);
    fileRow.appendChild(hint);
    fileRow.appendChild(fileInput);
    body.appendChild(fileRow);

    sec.appendChild(head);
    sec.appendChild(body);
    inner.appendChild(sec);

    // ── state <-> widgets ──
    function readWidgets() {
        S.start = clamp(+(startW?.value ?? 0) || 0, 0, S.dur);
        const ev = +(endW?.value ?? 0) || 0;
        S.end = ev <= 0 || ev > S.dur ? S.dur : ev;
        if (S.end - S.start < MIN_SEL) { S.start = 0; S.end = S.dur; }
        S.pos = clamp(S.pos, S.start, S.end);
    }
    function writeWidgets() {
        try { if (startW) startW.value = round3(S.start); } catch { }
        try { if (endW) endW.value = S.end >= S.dur - 0.005 ? 0 : round3(S.end); } catch { }
        node.setDirtyCanvas(true, true);
    }

    function setStatus(text, err = false) {
        S.statusText = text;
        S.statusErr = err;
        status.textContent = text;
        status.classList.toggle("err", err);
    }
    function showMsg(text, err = false) {
        msg.textContent = text || "";
        msg.style.display = text ? "grid" : "none";
        msg.classList.toggle("err", err);
    }

    function updateUI() {
        const len = Math.max(0, S.end - S.start);
        timeEl.textContent = `${fmtTime(S.pos)} / ${fmtTime(S.dur)}`;
        lenEl.textContent = S.dur ? `selection ${len.toFixed(2)} s` : "";
        if (document.activeElement !== inStart) inStart.value = S.dur ? fmtTime(S.start) : "";
        if (document.activeElement !== inEnd) inEnd.value = S.dur ? fmtTime(S.end) : "";
        playBtn.textContent = S.playing ? "⏸" : "▶";
        loopBtn.classList.toggle("on", S.loop);
    }

    // ── waveform drawing (Canvas2D) ──
    function draw() {
        if (S.dead) return;
        const W = canvas.clientWidth, H = canvas.clientHeight;
        if (!W || !H) return;
        const dpr = window.devicePixelRatio || 1;
        const pw = Math.round(W * dpr), ph = Math.round(H * dpr);
        if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, W, H);
        ctx.fillStyle = "#15151b";
        ctx.fillRect(0, 0, W, H);
        const mid = H / 2;
        ctx.fillStyle = "rgba(255,255,255,.07)";
        ctx.fillRect(0, Math.round(mid), W, 1);
        if (!S.peaks || !S.dur) return;

        const n = S.peaks.length, amp = mid * 0.92 * S.gain;
        for (let x = 0; x < W; x++) {
            const i0 = Math.min(n - 1, Math.floor((x / W) * n));
            const i1 = Math.max(i0 + 1, Math.min(n, Math.floor(((x + 1) / W) * n)));
            let mn = 1, mx = -1;
            for (let i = i0; i < i1; i++) {
                const p = S.peaks[i];
                if (p[0] < mn) mn = p[0];
                if (p[1] > mx) mx = p[1];
            }
            if (mn > mx) { mn = 0; mx = 0; }
            const t = (x / W) * S.dur;
            ctx.fillStyle = t >= S.start && t <= S.end ? "#a78bfa" : "#3a3a48";
            const y0 = mid - clamp(mx, -1, 1) * amp;
            const y1 = mid - clamp(mn, -1, 1) * amp;
            ctx.fillRect(x, y0, 1, Math.max(1, y1 - y0));
        }

        const sx = (S.start / S.dur) * W, ex = (S.end / S.dur) * W;
        ctx.fillStyle = "rgba(124,58,237,.12)";
        ctx.fillRect(sx, 0, Math.max(0, ex - sx), H);
        ctx.fillStyle = "rgba(0,0,0,.35)";
        ctx.fillRect(0, 0, sx, H);
        ctx.fillRect(ex, 0, W - ex, H);

        // trim handles
        ctx.fillStyle = "#e8b4ff";
        ctx.fillRect(Math.round(sx) - 1, 0, 2, H);
        ctx.fillRect(Math.round(ex) - 1, 0, 2, H);
        ctx.fillStyle = "#7c3aed";
        ctx.fillRect(Math.round(sx) - 1, 0, 8, 12);
        ctx.fillRect(Math.round(ex) - 7, H - 12, 8, 12);

        // playhead
        const px = (S.pos / S.dur) * W;
        ctx.fillStyle = "#22d3ee";
        ctx.fillRect(Math.round(px) - 1, 0, 2, H);
    }

    // ── playback ──
    function stop() {
        S.playing = false;
        S.snippetEnd = null;
        try { audio.pause(); } catch { }
        updateUI();
    }
    function playFrom(t, limit = null) {
        if (!S.dur || S.dead) return;
        S.pos = t;
        try { audio.currentTime = t; } catch { }
        try { audio.play()?.catch?.(() => { }); } catch { }
        S.playing = true;
        S.snippetEnd = limit;
        cancelAnimationFrame(S.raf);
        S.raf = requestAnimationFrame(tick);
        updateUI();
    }
    function tick() {
        if (S.dead || !S.playing) return;
        S.pos = audio.currentTime;
        const lim = S.snippetEnd ?? S.end;
        if (S.pos >= lim - 0.005) {
            if (S.snippetEnd == null && S.loop) {
                try { audio.currentTime = S.start; } catch { }
                S.pos = S.start;
            } else {
                const snippet = S.snippetEnd != null;
                stop();
                if (!snippet) S.pos = S.start;
                draw();
                updateUI();
                return;
            }
        }
        draw();
        updateUI();
        S.raf = requestAnimationFrame(tick);
    }
    function togglePlay() {
        if (S.playing) { stop(); return; }
        const t = S.pos < S.start || S.pos >= S.end - 0.01 ? S.start : S.pos;
        playFrom(t);
    }
    audio.addEventListener("ended", () => {
        if (S.dead || !S.playing) return;
        if (S.loop && S.snippetEnd == null) playFrom(S.start);
        else { stop(); S.pos = S.start; draw(); updateUI(); }
    });

    playBtn.onclick = togglePlay;
    loopBtn.onclick = () => { S.loop = !S.loop; updateUI(); };
    resetBtn.onclick = () => {
        if (!S.dur) return;
        S.start = 0; S.end = S.dur; S.pos = 0;
        if (S.playing) { try { audio.currentTime = 0; } catch { } }
        writeWidgets(); draw(); updateUI();
    };
    inner.addEventListener("keydown", (e) => {
        if (e.target instanceof HTMLInputElement) return;
        if (e.code === "Space" || e.key === " ") { e.preventDefault(); e.stopPropagation(); togglePlay(); }
    });

    // typed trim values
    function commitTyped(which, el) {
        const v = parseTime(el.value);
        if (Number.isFinite(v) && S.dur) {
            if (which === "start") S.start = clamp(v, 0, S.end - MIN_SEL);
            else S.end = clamp(v, S.start + MIN_SEL, S.dur);
            S.pos = clamp(S.pos, S.start, S.end);
            writeWidgets();
        }
        el.value = S.dur ? fmtTime(which === "start" ? S.start : S.end) : "";
        draw(); updateUI();
    }
    for (const [el, which] of [[inStart, "start"], [inEnd, "end"]]) {
        el.addEventListener("keydown", (e) => { if (e.key === "Enter") { commitTyped(which, el); el.blur(); } });
        el.addEventListener("blur", () => commitTyped(which, el));
    }

    // ── waveform pointer interaction ──
    function hitTest(x, W) {
        const sx = (S.start / S.dur) * W, ex = (S.end / S.dur) * W;
        const ds = Math.abs(x - sx), de = Math.abs(x - ex);
        if (Math.min(ds, de) <= HIT) return { mode: ds <= de ? "start" : "end", grab: true };
        if (x > sx && x < ex) return { mode: "body", grab: false };
        return { mode: ds < de ? "start" : "end", grab: false };
    }
    canvas.addEventListener("pointerdown", (e) => {
        if (!S.dur) return;
        e.preventDefault();
        inner.focus({ preventScroll: true });
        const rect = canvas.getBoundingClientRect();
        const W = rect.width || canvas.clientWidth;
        const tOf = (ev) => clamp(((ev.clientX - rect.left) / W) * S.dur, 0, S.dur);
        const { mode, grab } = hitTest(e.clientX - rect.left, W);
        try { canvas.setPointerCapture?.(e.pointerId); } catch { }

        const apply = (ev) => {
            const t = tOf(ev);
            if (mode === "start") S.start = clamp(t, 0, S.end - MIN_SEL);
            else if (mode === "end") S.end = clamp(t, S.start + MIN_SEL, S.dur);
            else {
                S.pos = clamp(t, S.start, S.end);
                if (S.playing) { try { audio.currentTime = S.pos; } catch { } }
            }
            if (mode !== "body") S.pos = clamp(S.pos, S.start, S.end);
            writeWidgets(); draw(); updateUI();
        };
        if (!grab) apply(e);     // click outside a handle acts at once; grabbing a handle waits for movement
        const mv = (ev) => apply(ev);
        const up = () => {
            canvas.removeEventListener("pointermove", mv);
            canvas.removeEventListener("pointerup", up);
            canvas.removeEventListener("pointercancel", up);
            if (mode === "body" && !S.playing) playFrom(S.pos, Math.min(S.end, S.pos + 0.6));
        };
        canvas.addEventListener("pointermove", mv);
        canvas.addEventListener("pointerup", up);
        canvas.addEventListener("pointercancel", up);
    });
    canvas.addEventListener("pointermove", (e) => {
        if (!S.dur || e.buttons) return;
        const rect = canvas.getBoundingClientRect();
        const { mode, grab } = hitTest(e.clientX - rect.left, rect.width || canvas.clientWidth);
        canvas.style.cursor = grab ? "ew-resize" : mode === "body" ? "crosshair" : "col-resize";
    });
    canvas.addEventListener("dblclick", () => { resetBtn.onclick(); });

    // ── upload / drop ──
    async function uploadFile(file) {
        if (!file) return;
        if (!(file.type.startsWith("audio/") || file.type.startsWith("video/") || AUDIO_EXT.test(file.name))) {
            setStatus("⚠ that doesn't look like an audio file", true);
            return;
        }
        setStatus(`uploading ${file.name}…`);
        try {
            const body = new FormData();
            body.append("image", file);        // ComfyUI's generic upload field
            body.append("type", "input");
            const r = await api.fetchApi("/upload/image", { method: "POST", body });
            if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
            const j = await r.json();
            const value = (j.subfolder ? j.subfolder + "/" : "") + j.name;
            const vals = audioW?.options?.values;
            if (Array.isArray(vals) && !vals.includes(value)) vals.push(value);
            if (audioW) {
                audioW.value = value;
                try { audioW.callback?.(value); } catch (e) { console.warn("[Nougan.Audio] callback", e); }
            }
            node.setDirtyCanvas(true, true);
        } catch (e) {
            setStatus(`⚠ upload failed: ${e.message || e}`, true);
        }
    }
    loadBtn.onclick = () => fileInput.click();
    fileInput.onchange = () => { const f = fileInput.files?.[0]; fileInput.value = ""; uploadFile(f); };
    for (const t of ["dragenter", "dragover"]) {
        stage.addEventListener(t, (e) => { e.preventDefault(); e.stopPropagation(); stage.classList.add("drop"); });
    }
    stage.addEventListener("dragleave", () => stage.classList.remove("drop"));
    stage.addEventListener("drop", (e) => {
        e.preventDefault(); e.stopPropagation();
        stage.classList.remove("drop");
        uploadFile(e.dataTransfer?.files?.[0]);
    });

    // ── loading the selected file ──
    async function reload(resetTrim) {
        const name = audioW?.value ? String(audioW.value) : "";
        S.lastName = name;
        const my = ++S.seq;
        S.abort?.abort();
        stop();
        S.peaks = null; S.dur = 0; S.pos = 0;
        if (resetTrim) {
            try { if (startW) startW.value = 0; if (endW) endW.value = 0; } catch { }
        }
        if (!name) {
            setStatus("no audio selected");
            showMsg("Pick or load an audio file");
            draw(); updateUI();
            return;
        }
        setStatus(`loading ${splitName(name).base}…`);
        showMsg("Loading…");
        draw(); updateUI();

        const ctl = new AbortController();
        S.abort = ctl;
        try {
            const r = await api.fetchApi(
                `/nougan/audio_trim/peaks?filename=${encodeURIComponent(name)}&buckets=${BUCKETS}`,
                { signal: ctl.signal });
            const j = await r.json().catch(() => ({}));
            if (my !== S.seq || S.dead) return;
            if (!r.ok || j.error) throw new Error(j.error || `${r.status} ${r.statusText}`);

            S.peaks = j.peaks || [];
            S.dur = +j.duration || 0;
            S.sr = +j.sample_rate || 0;
            S.ch = +j.channels || 0;
            let m = 0;
            for (const p of S.peaks) m = Math.max(m, Math.abs(p[0]), Math.abs(p[1]));
            S.gain = m > 0 ? Math.min(8, 1 / m) : 1;
            readWidgets();
            S.pos = S.start;
            audio.src = viewUrl(name);

            const chs = S.ch === 1 ? "mono" : S.ch === 2 ? "stereo" : `${S.ch} ch`;
            setStatus(`${splitName(name).base} · ${fmtTime(S.dur)} · ${(S.sr / 1000).toFixed(1)} kHz · ${chs}`);
            showMsg("");
            writeWidgets();
        } catch (e) {
            if (e?.name === "AbortError" || my !== S.seq || S.dead) return;
            setStatus(`⚠ ${e.message || e}`, true);
            showMsg(String(e.message || e), true);
        }
        draw(); updateUI();
    }

    // changing the combo (user pick, upload, workflow script) reloads and resets the trim
    if (audioW && !audioW._ngaCb) {
        audioW._ngaCb = true;
        const orig = audioW.callback;
        audioW.callback = function () {
            let r;
            try { r = orig?.apply(this, arguments); } catch (e) { console.warn("[Nougan.Audio] callback", e); }
            try { node._nga?.reload(true); } catch (e) { console.warn("[Nougan.Audio] reload", e); }
            return r;
        };
    }

    // ── register as ONE real DOM widget (same pattern as the other Nougan loaders) ──
    const dw = node.addDOMWidget(PANEL, "nga-panel", inner, { hideOnZoom: false, serialize: false });
    try { dw.serializeValue = () => undefined; } catch { }
    let lastH = 0;
    dw.computeSize = () => {
        const sh = inner.scrollHeight;
        if (sh > 4) lastH = sh;
        return [Math.max(MIN_W, node.size[0]), Math.max(60, (lastH || sh) + 10)];
    };
    const ro = new ResizeObserver(() => {
        if (inner.scrollHeight > 4) syncHeight(node);
        draw();
    });
    ro.observe(inner);
    ro.observe(stage);

    node._nga = {
        S, audioW, reload, draw,
        destroy() {
            S.dead = true;
            cancelAnimationFrame(S.raf);
            S.abort?.abort();
            try { audio.pause(); audio.removeAttribute("src"); audio.load(); } catch { }
            try { ro.disconnect(); } catch { }
            stripDead = true;
            try { stripStop?.(); } catch { }
            try { dw.onRemove?.(); } catch { }
            const i = node.widgets?.indexOf(dw) ?? -1;
            if (i >= 0) node.widgets.splice(i, 1);
            inner.remove();
        },
    };

    updateUI();
    reload(false);
}

function teardownDom(node) {
    const st = node._nga;
    if (!st) return;
    try { st.destroy(); } catch { }
    node._nga = null;
}


// ── extension ──────────────────────────────────────────────────────────────

app.registerExtension({
    name: "Nougan.AudioTrim",
    async setup() { console.log(`[Nougan.AudioTrim] extension loaded — build ${BUILD}`); },

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData?.name !== NODE_NAME) return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onNodeCreated?.apply(this, arguments);
            try { this.size[0] = Math.max(this.size[0], MIN_W); } catch { }
            try { buildDom(this); }
            catch (e) { console.error("[Nougan.AudioTrim] UI build failed — the node still works with its plain widgets:", e); }
            return r;
        };

        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const r = onConfigure?.apply(this, arguments);
            try { buildDom(this); }   // widget values + properties are restored by now
            catch (e) { console.error("[Nougan.AudioTrim] onConfigure failed:", e); }
            return r;
        };

        const onRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            try { teardownDom(this); } catch { }
            return onRemoved?.apply(this, arguments);
        };

        const onResize = nodeType.prototype.onResize;
        nodeType.prototype.onResize = function (size) {
            if (size[0] < MIN_W) size[0] = MIN_W;
            return onResize?.apply(this, [size]);
        };

        // picks up the file being changed without going through the widget callback
        const onDrawForeground = nodeType.prototype.onDrawForeground;
        nodeType.prototype.onDrawForeground = function () {
            const r = onDrawForeground?.apply(this, arguments);
            try {
                const st = this._nga;
                if (st && st.audioW && String(st.audioW.value || "") !== (st.S.lastName ?? "")) st.reload(false);
            } catch { }
            return r;
        };
    },
});
