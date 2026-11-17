// Nougan Audio Loader 🎵 — DOM waveform editor: scrub + trim from either side.
// WebGPU bar renderer with Canvas2D fallback. Trim lives in the start_time /
// end_time widgets (hidden), so workflows serialize it for free.
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const BUCKETS = 1600;
const MIN_GAP = 0.05;

// ── styles (injected once) ───────────────────────────────────────────────────
let _stylesDone = false;
function ensureStyles() {
    if (_stylesDone) return;
    _stylesDone = true;
    const el = document.createElement("style");
    el.textContent = `
.na-wrap{display:flex;flex-direction:column;gap:6px;width:100%;padding:4px 6px;box-sizing:border-box;
  font:11px/1.4 'Segoe UI',system-ui,sans-serif;color:#cfc6e8;user-select:none;outline:none}
.na-bar{display:flex;align-items:center;gap:6px}
.na-btn{background:#241b38;border:1px solid #4c4368;color:#e879f9;border-radius:8px;padding:2px 10px;
  cursor:pointer;font-size:12px;line-height:1.5}
.na-btn:hover{border-color:#e879f9;box-shadow:0 0 8px rgba(232,121,249,.35)}
.na-btn.on{background:#173042;color:#22d3ee;border-color:#22d3ee}
.na-time{font-family:Consolas,monospace;color:#22d3ee;font-size:11px}
.na-wave{position:relative;height:132px;border-radius:10px;overflow:hidden;cursor:crosshair;touch-action:none;
  background:linear-gradient(180deg,#171226,#100c1c);border:1px solid #322a4d}
.na-wave canvas{position:absolute;inset:0;width:100%;height:100%;display:block}
.na-shade{position:absolute;top:0;bottom:0;background:rgba(8,6,14,.62);pointer-events:none}
.na-handle{position:absolute;top:0;bottom:0;width:12px;margin-left:-6px;pointer-events:none}
.na-handle::before{content:"";position:absolute;left:5px;top:0;bottom:0;width:2px;background:#e879f9;
  box-shadow:0 0 6px rgba(232,121,249,.8)}
.na-handle::after{content:"";position:absolute;left:2px;top:50%;width:8px;height:22px;margin-top:-11px;
  border-radius:3px;background:#e879f9;box-shadow:0 0 8px rgba(232,121,249,.6)}
.na-play{position:absolute;top:0;bottom:0;width:2px;margin-left:-1px;background:#22d3ee;
  box-shadow:0 0 8px #22d3ee;pointer-events:none}
.na-tip{position:absolute;top:4px;transform:translateX(-50%);background:#241b38;border:1px solid #4c4368;
  border-radius:6px;padding:1px 6px;font-family:Consolas,monospace;color:#22d3ee;pointer-events:none;
  display:none;white-space:nowrap;z-index:2}
.na-msg{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;
  color:#8f84b8;background:rgba(12,9,20,.55);pointer-events:none;font-size:12px;padding:0 10px;z-index:3}
.na-in{width:84px;background:#171226;border:1px solid #4c4368;color:#e8d9ff;border-radius:6px;padding:2px 6px;
  font-family:Consolas,monospace;font-size:11px}
.na-in:focus{outline:none;border-color:#22d3ee}
.na-lbl{color:#8f84b8}
.na-info{margin-left:auto;color:#8f84b8;font-family:Consolas,monospace;font-size:10px;text-align:right}
`;
    document.head.appendChild(el);
}

// ── helpers ──────────────────────────────────────────────────────────────────
const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
const round3 = (v) => Math.round(v * 1000) / 1000;

function fmt(t) {
    if (!isFinite(t) || t < 0) t = 0;
    const m = Math.floor(t / 60), s = t - m * 60, h = Math.floor(m / 60);
    const mm = h ? String(m % 60).padStart(2, "0") : String(m);
    return (h ? h + ":" : "") + mm + ":" + s.toFixed(2).padStart(5, "0");
}
function parseTime(v) {
    v = String(v).trim();
    if (!v) return 0;
    if (/^[\d.]+$/.test(v)) return parseFloat(v) || 0;
    const parts = v.split(":").map(parseFloat);
    if (parts.some(isNaN)) return null;
    let t = 0;
    for (const p of parts) t = t * 60 + p;
    return t;
}
function splitName(name) {
    let type = "input", n = name;
    const m = n.match(/^(.*)\s+\[(input|output|temp)\]\s*$/);
    if (m) { n = m[1]; type = m[2]; }
    const i = n.lastIndexOf("/");
    return { base: i >= 0 ? n.slice(i + 1) : n, sub: i >= 0 ? n.slice(0, i) : "", type };
}
function hideWidget(w) {
    if (!w) return;
    w.hidden = true;
    w.type = "hidden";
    w.computeSize = () => [0, -4];
}

// ── WebGPU renderer (min/max bars, trim-aware coloring, playhead glow) ───────
const WGSL = `
struct U {
  a: vec4f,    // trimStart, trimEnd, playhead, time   (normalized 0..1)
  cin: vec4f,
  cout: vec4f,
  m: vec4f,    // count, glow, -, -
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> pk: array<f32>;

struct VO { @builtin(position) pos: vec4f, @location(0) col: vec3f, @location(1) alp: f32 };

@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VO {
  let n = u.m.x;
  let lo = pk[ii * 2u];
  let hi = pk[ii * 2u + 1u];
  let mid = (lo + hi) * 0.5;
  let half = max((hi - lo) * 0.5, 0.006);
  var corners = array<vec2f, 6>(
    vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
    vec2f(1.0, 0.0), vec2f(1.0, 1.0), vec2f(0.0, 1.0));
  let c = corners[vi];
  let x = mix((f32(ii) / n) * 2.0 - 1.0, (f32(ii + 1u) / n) * 2.0 - 1.0, c.x);
  let y = mix(mid - half, mid + half, c.y) * 0.92;
  let cx = (f32(ii) + 0.5) / n;
  let inTrim = cx >= u.a.x && cx <= u.a.y;
  var col = select(u.cout.rgb, u.cin.rgb, inTrim);
  col *= 0.85 + 0.3 * c.y;
  col *= 1.0 + 0.06 * sin(u.a.w * 5.0 + cx * 30.0) * step(0.4, u.m.y);
  col += vec3f(0.35, 0.9, 1.0) * (u.m.y * exp(-abs(cx - u.a.z) * 50.0));
  var o: VO;
  o.pos = vec4f(x, y, 0.0, 1.0);
  o.col = col;
  o.alp = select(0.5, 1.0, inTrim);
  return o;
}
@fragment fn fs(i: VO) -> @location(0) vec4f {
  return vec4f(i.col * i.alp, i.alp);   // premultiplied
}
`;

async function initGPU(canvas) {
    if (!navigator.gpu) return null;
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "low-power" });
    if (!adapter) return null;
    const device = await adapter.requestDevice();
    // Anything past getContext("webgpu") locks the canvas — throw so the caller
    // swaps in a fresh canvas for the 2D fallback.
    const format = navigator.gpu.getPreferredCanvasFormat();
    const ctx = canvas.getContext("webgpu");
    if (!ctx) throw new Error("no webgpu context");
    ctx.configure({ device, format, alphaMode: "premultiplied" });
    const module = device.createShaderModule({ code: WGSL });
    const pipeline = device.createRenderPipeline({
        layout: "auto",
        vertex: { module, entryPoint: "vs" },
        fragment: {
            module, entryPoint: "fs",
            targets: [{
                format,
                blend: {
                    color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
                    alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
                },
            }],
        },
        primitive: { topology: "triangle-list" },
    });
    const ubuf = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const udata = new Float32Array(16);
    let pbuf = null, bind = null, count = 0;

    return {
        device,
        setPeaks(arr) {
            pbuf?.destroy();
            count = arr.length / 2;
            pbuf = device.createBuffer({
                size: Math.max(arr.byteLength, 16),
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            });
            device.queue.writeBuffer(pbuf, 0, arr);
            bind = device.createBindGroup({
                layout: pipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: { buffer: ubuf } },
                    { binding: 1, resource: { buffer: pbuf } },
                ],
            });
        },
        draw(st) {
            if (!bind || !count) return;
            udata.set([st.start, st.end, st.pos, st.time,
                       0.91, 0.47, 0.98, 1,   // #e879f9 in-trim
                       0.30, 0.26, 0.41, 1,   // #4c4368 out-of-trim
                       count, st.glow, 0, 0]);
            device.queue.writeBuffer(ubuf, 0, udata);
            const enc = device.createCommandEncoder();
            const pass = enc.beginRenderPass({
                colorAttachments: [{
                    view: ctx.getCurrentTexture().createView(),
                    clearValue: { r: 0, g: 0, b: 0, a: 0 },
                    loadOp: "clear", storeOp: "store",
                }],
            });
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, bind);
            pass.draw(6, count);
            pass.end();
            device.queue.submit([enc.finish()]);
        },
        destroy() { try { pbuf?.destroy(); ubuf.destroy(); device.destroy(); } catch { } },
    };
}

// ── per-node editor ──────────────────────────────────────────────────────────
function buildEditor(node) {
    ensureStyles();
    const audioW = node.widgets?.find((w) => w.name === "audio");
    const startW = node.widgets?.find((w) => w.name === "start_time");
    const endW = node.widgets?.find((w) => w.name === "end_time");
    hideWidget(startW);
    hideWidget(endW);

    const S = {
        audioW, startW, endW,
        dur: 0, sr: 0, ch: 0, peaks: null,
        start: 0, end: 0, pos: 0,
        playing: false, previewing: false, previewUntil: 0, loop: false,
        drag: null, raf: 0, reloadT: 0, abort: null,
        gpu: null, ctx2d: null, dead: false, lastName: null,
        audio: new Audio(),
    };
    S.audio.preload = "auto";
    node.__na = S;

    // DOM
    const wrap = document.createElement("div");
    wrap.className = "na-wrap";
    wrap.tabIndex = 0;
    wrap.innerHTML = `
      <div class="na-bar">
        <button class="na-btn na-playbtn" title="Play selection (Space)">▶</button>
        <button class="na-btn na-loopbtn" title="Loop selection">🔁</button>
        <span class="na-time">0:00.00 / 0:00.00</span>
        <button class="na-btn na-resetbtn" title="Reset trim (double-click waveform)" style="margin-left:auto">⟲</button>
      </div>
      <div class="na-wave">
        <canvas></canvas>
        <div class="na-shade na-shadel" style="left:0;width:0%"></div>
        <div class="na-shade na-shader" style="right:0;width:0%"></div>
        <div class="na-handle na-handlel" style="left:0%"></div>
        <div class="na-handle na-handler" style="left:100%"></div>
        <div class="na-play" style="left:0%"></div>
        <div class="na-tip"></div>
        <div class="na-msg" style="display:none"></div>
      </div>
      <div class="na-bar">
        <span class="na-lbl">In</span><input class="na-in na-instart" spellcheck="false">
        <span class="na-lbl">Out</span><input class="na-in na-inend" spellcheck="false">
        <span class="na-info"></span>
      </div>`;
    const $ = (sel) => wrap.querySelector(sel);
    const wave = $(".na-wave"), canvas = $("canvas"),
        shadeL = $(".na-shadel"), shadeR = $(".na-shader"),
        handleL = $(".na-handlel"), handleR = $(".na-handler"),
        playhead = $(".na-play"), tip = $(".na-tip"), msg = $(".na-msg"),
        playBtn = $(".na-playbtn"), loopBtn = $(".na-loopbtn"), resetBtn = $(".na-resetbtn"),
        timeEl = $(".na-time"), inStart = $(".na-instart"), inEnd = $(".na-inend"), info = $(".na-info");
    S.canvas = canvas;

    const domW = node.addDOMWidget("nougan_audio_editor", "custom", wrap, {
        serialize: false,
        getMinHeight: () => 210,
    });
    domW.serialize = false;
    node.setSize([480, 340]);

    // ── state <-> widgets ──
    function readWidgets() {
        S.start = clamp(+(startW?.value ?? 0) || 0, 0, S.dur);
        const ev = +(endW?.value ?? 0) || 0;
        S.end = ev > 0 ? clamp(ev, Math.min(S.start + MIN_GAP, S.dur), S.dur) : S.dur;
        if (!S.dur) { S.start = 0; S.end = 0; }
    }
    function writeWidgets() {
        if (startW) startW.value = round3(S.start);
        if (endW) endW.value = S.end >= S.dur - 0.005 ? 0 : round3(S.end);
        node.setDirtyCanvas(true, true);
    }
    function setMsg(t) {
        msg.style.display = t ? "flex" : "none";
        msg.textContent = t || "";
    }
    function updatePlayBtn() { playBtn.textContent = S.playing ? "⏸" : "▶"; }

    // ── rendering ──
    function resizeCanvas() {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        S.canvas.width = Math.max(2, Math.round(wave.clientWidth * dpr));
        S.canvas.height = Math.max(2, Math.round(wave.clientHeight * dpr));
    }
    function draw2D() {
        const c = S.canvas, ctx = S.ctx2d;
        if (!ctx) return;
        const W = c.width, H = c.height;
        ctx.clearRect(0, 0, W, H);
        ctx.fillStyle = "rgba(76,67,104,.5)";
        ctx.fillRect(0, H / 2, W, 1);
        const pk = S.peaks;
        if (!pk) return;
        const n = pk.length / 2, bw = W / n;
        const s = S.dur ? S.start / S.dur : 0, e = S.dur ? S.end / S.dur : 1;
        for (let i = 0; i < n; i++) {
            const cx = (i + 0.5) / n;
            ctx.fillStyle = (cx >= s && cx <= e) ? "rgba(232,121,249,.95)" : "rgba(76,67,104,.55)";
            const lo = pk[i * 2], hi = pk[i * 2 + 1];
            const mid = (lo + hi) / 2, half = Math.max((hi - lo) / 2, 0.006);
            const y0 = (1 - (mid + half) * 0.92) * H / 2;
            const y1 = (1 - (mid - half) * 0.92) * H / 2;
            ctx.fillRect(i * bw, y0, Math.ceil(bw), Math.max(y1 - y0, 1));
        }
    }
    function draw() {
        if (S.dead) return;
        const d = S.dur || 0;
        const s = d ? S.start / d : 0, e = d ? S.end / d : 1, p = d ? S.pos / d : 0;
        shadeL.style.width = (s * 100) + "%";
        shadeR.style.width = ((1 - e) * 100) + "%";
        handleL.style.left = (s * 100) + "%";
        handleR.style.left = (e * 100) + "%";
        playhead.style.left = (p * 100) + "%";
        timeEl.textContent = `${fmt(S.pos)} / ${fmt(d)}`;
        if (document.activeElement !== inStart) inStart.value = fmt(S.start);
        if (document.activeElement !== inEnd) inEnd.value = fmt(S.end);
        info.textContent = S.dur
            ? `sel ${fmt(S.end - S.start)} · ${(S.sr / 1000).toFixed(1)} kHz · ${S.ch === 1 ? "mono" : S.ch === 2 ? "stereo" : S.ch + "ch"}`
            : "";
        if (S.gpu) {
            try {
                S.gpu.draw({ start: s, end: e, pos: p, glow: S.playing ? 0.55 : 0.22, time: performance.now() / 1000 });
            } catch { fallback2D(); }
        } else if (S.ctx2d) {
            draw2D();
        }
    }
    function fallback2D() {
        try { S.gpu?.destroy(); } catch { }
        S.gpu = null;
        const c = document.createElement("canvas");
        S.canvas.replaceWith(c);
        S.canvas = c;
        S.ctx2d = c.getContext("2d");
        resizeCanvas();
        draw();
    }

    resizeCanvas();
    initGPU(S.canvas).then((g) => {
        if (S.dead) { g?.destroy(); return; }
        if (g) {
            S.gpu = g;
            if (S.peaks) g.setPeaks(S.peaks);
            g.device.lost.then(() => { if (!S.dead) fallback2D(); });
        } else {
            S.ctx2d = S.canvas.getContext("2d");
        }
        draw();
    }).catch(() => { if (!S.dead) fallback2D(); });

    const ro = new ResizeObserver(() => { resizeCanvas(); draw(); });
    ro.observe(wave);

    // ── playback ──
    function tick() {
        S.raf = 0;
        if (S.dead) return;
        const a = S.audio;
        if (S.playing || S.previewing) {
            S.pos = a.currentTime;
            const limit = S.previewing ? Math.min(S.previewUntil, S.dur) : S.end;
            if (S.pos >= limit - 0.004 || a.ended) {
                if (S.previewing) { a.pause(); S.previewing = false; S.pos = limit; }
                else if (S.loop) { a.currentTime = S.start; S.pos = S.start; }
                else { a.pause(); S.playing = false; S.pos = S.start; updatePlayBtn(); }
            }
        }
        draw();
        if (S.playing || S.previewing || S.drag === "scrub") S.raf = requestAnimationFrame(tick);
    }
    function kick() { if (!S.raf) S.raf = requestAnimationFrame(tick); }

    async function togglePlay() {
        const a = S.audio;
        if (S.playing) { a.pause(); S.playing = false; updatePlayBtn(); draw(); return; }
        if (!S.dur) return;
        S.previewing = false;
        if (S.pos < S.start || S.pos >= S.end - 0.01) S.pos = S.start;
        try { a.currentTime = S.pos; } catch { }
        try {
            await a.play();
            S.playing = true;
            updatePlayBtn();
            kick();
        } catch { setMsg("⚠ browser can't play this codec (trim still works)"); }
    }
    function seek(t) {
        S.pos = clamp(t, 0, S.dur);
        if (!S.playing && S.audio.readyState > 0) {
            try { S.audio.currentTime = S.pos; } catch { }
        } else if (S.playing) {
            try { S.audio.currentTime = S.pos; } catch { }
        }
    }
    function snippet(t) {
        if (S.playing || !S.dur) return;
        S.previewing = true;
        S.previewUntil = Math.min(t + 0.7, S.dur);
        try { S.audio.currentTime = t; } catch { }
        S.audio.play().then(kick).catch(() => { S.previewing = false; });
    }

    S.audio.addEventListener("loadedmetadata", () => {
        if (S.dead) return;
        if (!S.dur && isFinite(S.audio.duration) && S.audio.duration > 0) {
            S.dur = S.audio.duration;   // peaks route failed but playback works
            readWidgets();
        }
        try { S.audio.currentTime = S.pos; } catch { }
        draw();
    });
    S.audio.addEventListener("ended", () => {
        if (S.dead) return;
        S.playing = false; S.pos = S.start; updatePlayBtn(); draw();
    });

    // ── pointer: trim handles + scrub ──
    function evTime(e) {
        const r = wave.getBoundingClientRect();
        return clamp((e.clientX - r.left) / Math.max(r.width, 1), 0, 1) * S.dur;
    }
    function showTip(e, t) {
        const r = wave.getBoundingClientRect();
        tip.style.display = "block";
        tip.style.left = clamp(e.clientX - r.left, 24, r.width - 24) + "px";
        tip.textContent = fmt(t);
    }
    wave.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || !S.dur) return;
        e.preventDefault();
        wrap.focus({ preventScroll: true });
        const r = wave.getBoundingClientRect();
        const x = e.clientX - r.left;
        const sx = (S.start / S.dur) * r.width, ex = (S.end / S.dur) * r.width;
        if (Math.abs(x - sx) < 9) S.drag = "start";
        else if (Math.abs(x - ex) < 9) S.drag = "end";
        else { S.drag = "scrub"; seek(evTime(e)); kick(); }
        wave.setPointerCapture(e.pointerId);
        showTip(e, evTime(e));
        draw();
    });
    wave.addEventListener("pointermove", (e) => {
        if (!S.drag || !S.dur) return;
        const t = evTime(e);
        if (S.drag === "start") S.start = clamp(t, 0, S.end - MIN_GAP);
        else if (S.drag === "end") S.end = clamp(t, S.start + MIN_GAP, S.dur);
        else seek(t);
        if (S.drag !== "scrub") writeWidgets();
        showTip(e, t);
        draw();
    });
    function endDrag(e) {
        if (!S.drag) return;
        const wasScrub = S.drag === "scrub";
        S.drag = null;
        tip.style.display = "none";
        try { wave.releasePointerCapture(e.pointerId); } catch { }
        if (wasScrub) snippet(S.pos);
        draw();
    }
    wave.addEventListener("pointerup", endDrag);
    wave.addEventListener("pointercancel", endDrag);
    wave.addEventListener("dblclick", (e) => {
        e.preventDefault();
        S.start = 0; S.end = S.dur;
        writeWidgets(); draw();
    });
    wave.addEventListener("contextmenu", (e) => e.preventDefault());

    // ── buttons / inputs / keys ──
    playBtn.addEventListener("click", togglePlay);
    loopBtn.addEventListener("click", () => {
        S.loop = !S.loop;
        loopBtn.classList.toggle("on", S.loop);
    });
    resetBtn.addEventListener("click", () => {
        S.start = 0; S.end = S.dur;
        writeWidgets(); draw();
    });
    function commitInputs() {
        const s = parseTime(inStart.value), e = parseTime(inEnd.value);
        if (s !== null) S.start = clamp(s, 0, Math.max(S.end - MIN_GAP, 0));
        if (e !== null) S.end = clamp(e, S.start + MIN_GAP, S.dur);
        writeWidgets(); draw();
    }
    inStart.addEventListener("change", commitInputs);
    inEnd.addEventListener("change", commitInputs);
    for (const inp of [inStart, inEnd]) {
        inp.addEventListener("keydown", (e) => {
            e.stopPropagation();
            if (e.key === "Enter") { commitInputs(); inp.blur(); }
        });
    }
    wrap.addEventListener("keydown", (e) => {
        if (e.target.tagName === "INPUT") return;
        let used = true;
        if (e.code === "Space") togglePlay();
        else if (e.key === "ArrowLeft") { seek(S.pos - (e.shiftKey ? 5 : 1)); draw(); }
        else if (e.key === "ArrowRight") { seek(S.pos + (e.shiftKey ? 5 : 1)); draw(); }
        else if (e.key === "Home") { seek(S.start); draw(); }
        else if (e.key === "End") { seek(S.end); draw(); }
        else used = false;
        if (used) { e.preventDefault(); e.stopPropagation(); }
    });

    // ── file loading ──
    async function loadFile(resetTrim) {
        const name = audioW?.value || "";
        S.lastName = name;
        S.abort?.abort();
        S.playing = false; S.previewing = false; updatePlayBtn();
        try { S.audio.pause(); } catch { }
        S.pos = 0;
        if (resetTrim && startW && endW) { startW.value = 0; endW.value = 0; }
        if (!name) {
            S.peaks = null; S.dur = 0; S.start = 0; S.end = 0;
            setMsg("choose or upload an audio file ↑");
            draw();
            return;
        }
        const { base, sub, type } = splitName(name);
        S.audio.src = api.apiURL(`/view?filename=${encodeURIComponent(base)}&subfolder=${encodeURIComponent(sub)}&type=${type}`);
        setMsg("analyzing waveform…");
        S.abort = new AbortController();
        try {
            const res = await api.fetchApi(
                `/nougan/audio_loader/peaks?filename=${encodeURIComponent(name)}&buckets=${BUCKETS}`,
                { signal: S.abort.signal });
            const data = await res.json();
            if (S.dead) return;
            if (!res.ok || data.error) throw new Error(data.error || res.statusText);
            S.dur = data.duration; S.sr = data.sample_rate; S.ch = data.channels;
            const flat = new Float32Array(data.peaks.length * 2);
            for (let i = 0; i < data.peaks.length; i++) {
                flat[i * 2] = data.peaks[i][0];
                flat[i * 2 + 1] = data.peaks[i][1];
            }
            S.peaks = flat;
            S.gpu?.setPeaks(flat);
            readWidgets();
            if (S.pos > S.dur) S.pos = 0;
            setMsg("");
            draw();
        } catch (err) {
            if (S.dead || err?.name === "AbortError") return;
            S.peaks = null;
            setMsg("⚠ " + (err?.message || "could not read audio"));
            draw();
        }
    }
    function scheduleReload(resetTrim = false) {
        clearTimeout(S.reloadT);
        S.reloadT = setTimeout(() => loadFile(resetTrim), 60);
    }
    S.scheduleReload = scheduleReload;
    S.destroy = () => {
        S.dead = true;
        clearTimeout(S.reloadT);
        S.abort?.abort();
        cancelAnimationFrame(S.raf);
        ro.disconnect();
        try { S.audio.pause(); S.audio.removeAttribute("src"); S.audio.load(); } catch { }
        try { S.gpu?.destroy(); } catch { }
    };

    if (audioW) {
        const orig = audioW.callback;
        audioW.callback = function (...args) {
            const r = orig?.apply(this, args);
            scheduleReload(true);
            return r;
        };
    }
    scheduleReload(false);
}

// ── extension ────────────────────────────────────────────────────────────────
app.registerExtension({
    name: "Nougan.AudioLoader",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "NouganAudioLoader") return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onNodeCreated?.apply(this, arguments);
            buildEditor(this);
            return r;
        };
        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const r = onConfigure?.apply(this, arguments);
            this.__na?.scheduleReload(false);   // widgets_values are applied by now
            return r;
        };
        const onDrawForeground = nodeType.prototype.onDrawForeground;
        nodeType.prototype.onDrawForeground = function () {
            const r = onDrawForeground?.apply(this, arguments);
            const S = this.__na;
            if (S && S.audioW && S.audioW.value !== S.lastName) S.scheduleReload(false);
            return r;
        };
        const onRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            this.__na?.destroy();
            return onRemoved?.apply(this, arguments);
        };
    },
});