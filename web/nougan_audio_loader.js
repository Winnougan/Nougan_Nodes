// web/nougan_audio_loader.js — Nougan Audio Loader
// Visual waveform editor for the NouganAudioLoader node.
// - DOM widget: waveform canvas, crop region with draggable edges, playhead,
//   play/pause, time readout, reset.
// - WebGPU fragment-shader waveform renderer, Canvas2D fallback.
// - Scrubbing plays a short audible snippet at the playhead.

import { app } from "../../../scripts/app.js";

const BINS = 1024; // fixed peak-bin count; renderers scale it to any width

const COL = {
    bg: "#17171c",
    barIn: "#b07cc9",
    barOut: "#565662",
    edge: "#c46bd8",
    playhead: "#f2f2f2",
};

const CSS = `
.nougan-audio-editor {
    box-sizing: border-box;
    width: 100%;
    padding: 6px;
    background: var(--comfy-input-bg, #1b1b21);
    border: 1px solid rgba(255,255,255,.08);
    border-radius: 8px;
    font-family: inherit;
}
.nae-wave {
    position: relative;
    height: 92px;
    border-radius: 5px;
    overflow: hidden;
    background: ${COL.bg};
    cursor: crosshair;
}
.nae-wave canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
.nae-wave.nae-drag-edge { cursor: ew-resize; }
.nae-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 6px;
}
.nae-play {
    width: 26px; height: 22px;
    border: 0; border-radius: 5px;
    background: rgba(196,107,216,.18);
    color: #e0b0ee;
    font-size: 11px;
    cursor: pointer;
    line-height: 1;
}
.nae-play:hover { background: rgba(196,107,216,.32); }
.nae-time {
    flex: 1;
    font-size: 11px;
    color: #b8b8c4;
    white-space: nowrap;
    overflow: hidden;
    font-variant-numeric: tabular-nums;
}
.nae-reset {
    border: 0; border-radius: 5px;
    padding: 3px 8px;
    background: rgba(255,255,255,.06);
    color: #9a9aa8;
    font-size: 10.5px;
    cursor: pointer;
}
.nae-reset:hover { background: rgba(255,255,255,.12); color: #d0d0da; }
`;

let _styleDone = false;
function injectStyle() {
    if (_styleDone) return;
    _styleDone = true;
    const el = document.createElement("style");
    el.textContent = CSS;
    document.head.appendChild(el);
}

function hexRGB(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}

function fmt(t) {
    t = Math.max(0, t);
    const m = Math.floor(t / 60);
    const s = t - m * 60;
    return `${m}:${s < 10 ? "0" : ""}${s.toFixed(2)}`;
}

function round3(v) { return Math.round(v * 1000) / 1000; }

// ── WebGPU renderer ──────────────────────────────────────────────────────────

const WGSL = `
struct U {
    a: vec4f, // res.xy, bins, playheadFrac
    b: vec4f, // cropStartFrac, cropEndFrac, widthPx, pad
    cIn: vec4f,
    cOut: vec4f,
    cEdge: vec4f,
    cPlay: vec4f,
    cBg: vec4f,
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var peaksTex: texture_2d<f32>;

@vertex fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
    var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
    return vec4f(p[vi], 0.0, 1.0);
}

@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
    let res = u.a.xy;
    let uv = pos.xy / res;
    let fi = clamp(uv.x, 0.0, 0.99999) * u.a.z;
    let pm = textureLoad(peaksTex, vec2i(i32(fi), 0), 0).xy;
    let mid = res.y * 0.5;
    let amp = max(abs(pm.x), abs(pm.y)) * (mid - 3.0);
    let inCrop = uv.x >= u.b.x && uv.x <= u.b.y;
    var col = u.cBg.xyz;
    if (abs(pos.y - mid) <= amp) {
        col = select(u.cOut.xyz, u.cIn.xyz, inCrop);
    }
    if (!inCrop) { col = mix(col, u.cBg.xyz, 0.75); }
    if (abs(uv.x - u.b.x) * u.b.z < 1.25 || abs(uv.x - u.b.y) * u.b.z < 1.25) {
        col = u.cEdge.xyz;
    }
    if (abs(uv.x - u.a.w) * u.b.z < 1.1) {
        col = u.cPlay.xyz;
    }
    return vec4f(col, 1.0);
}
`;

let _gpuDevice = null;
let _gpuTried = false;
async function getGPUDevice() {
    if (_gpuTried) return _gpuDevice;
    _gpuTried = true;
    try {
        if (!navigator.gpu) return null;
        const adapter = await navigator.gpu.requestAdapter();
        _gpuDevice = adapter ? await adapter.requestDevice() : null;
    } catch {
        _gpuDevice = null;
    }
    return _gpuDevice;
}

class GpuWave {
    constructor(canvas) {
        this.canvas = canvas;
        this.ok = false;
    }
    async init(peaks) {
        this.device = await getGPUDevice();
        if (!this.device) return false;
        this.ctx = this.canvas.getContext("webgpu");
        if (!this.ctx) return false;
        this.format = navigator.gpu.getPreferredCanvasFormat();
        this.module = this.device.createShaderModule({ code: WGSL });
        this.pipeline = this.device.createRenderPipeline({
            layout: "auto",
            vertex: { module: this.module, entryPoint: "vs" },
            fragment: { module: this.module, entryPoint: "fs", targets: [{ format: this.format }] },
            primitive: { topology: "triangle-list" },
        });
        this.ubo = this.device.createBuffer({
            size: 7 * 16,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this.tex = this.device.createTexture({
            size: [BINS, 1],
            format: "rg32float",
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        this.bindGroup = this.device.createBindGroup({
            layout: this.pipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: this.ubo } },
                { binding: 1, resource: this.tex.createView() },
            ],
        });
        this.ok = true;
        this.setPeaks(peaks);
        this.configure();
        return true;
    }
    configure() {
        if (!this.ok) return;
        this.ctx.configure({ device: this.device, format: this.format, alphaMode: "opaque" });
    }
    setPeaks(peaks) {
        if (!this.ok || !peaks) return;
        this.device.queue.writeTexture({ texture: this.tex }, peaks, { bytesPerRow: BINS * 8 }, [BINS, 1]);
    }
    draw(w, h, cropS, cropE, playFrac) {
        if (!this.ok) return;
        const u = new Float32Array(28);
        u.set([w, h, BINS, playFrac], 0);
        u.set([cropS, cropE, w, 0], 4);
        u.set([...hexRGB(COL.barIn), 0], 8);
        u.set([...hexRGB(COL.barOut), 0], 12);
        u.set([...hexRGB(COL.edge), 0], 16);
        u.set([...hexRGB(COL.playhead), 0], 20);
        u.set([...hexRGB(COL.bg), 0], 24);
        this.device.queue.writeBuffer(this.ubo, 0, u);
        const enc = this.device.createCommandEncoder();
        const pass = enc.beginRenderPass({
            colorAttachments: [{
                view: this.ctx.getCurrentTexture().createView(),
                loadOp: "clear",
                clearValue: { r: 0, g: 0, b: 0, a: 1 },
                storeOp: "store",
            }],
        });
        pass.setPipeline(this.pipeline);
        pass.setBindGroup(0, this.bindGroup);
        pass.draw(3);
        pass.end();
        this.device.queue.submit([enc.finish()]);
    }
}

// ── Canvas2D fallback ────────────────────────────────────────────────────────

class CpuWave {
    constructor(canvas) {
        this.ctx2d = canvas.getContext("2d");
        this.ok = !!this.ctx2d;
    }
    configure() {}
    setPeaks(peaks) { this.peaks = peaks; }
    draw(w, h, cropS, cropE, playFrac) {
        if (!this.ok) return;
        const ctx = this.ctx2d;
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = COL.bg;
        ctx.fillRect(0, 0, w, h);
        if (!this.peaks) return;
        const mid = h / 2;
        const bw = w / BINS;
        const xs = cropS * w, xe = cropE * w;
        for (let i = 0; i < BINS; i++) {
            const mn = this.peaks[i * 2], mx = this.peaks[i * 2 + 1];
            const amp = Math.max(Math.abs(mn), Math.abs(mx)) * (mid - 3);
            if (amp < 0.4) continue;
            const x = i * bw;
            const inCrop = x + bw >= xs && x <= xe;
            ctx.fillStyle = inCrop ? COL.barIn : COL.barOut;
            ctx.globalAlpha = inCrop ? 1 : 0.35;
            ctx.fillRect(x, mid - amp, Math.max(1, bw * 0.7), amp * 2);
        }
        ctx.globalAlpha = 1;
        ctx.fillStyle = COL.edge;
        ctx.fillRect(xs - 1, 0, 2, h);
        ctx.fillRect(xe - 1, 0, 2, h);
        ctx.fillStyle = COL.playhead;
        ctx.fillRect(playFrac * w - 0.75, 0, 1.5, h);
    }
}

// ── Editor ───────────────────────────────────────────────────────────────────

function computePeaks(channelData, bins) {
    const n = channelData.length;
    const out = new Float32Array(bins * 2);
    const per = n / bins;
    for (let b = 0; b < bins; b++) {
        const s = Math.floor(b * per);
        const e = Math.min(n, Math.max(s + 1, Math.floor((b + 1) * per)));
        const step = Math.max(1, Math.floor((e - s) / 64));
        let mn = 0, mx = 0;
        for (let i = s; i < e; i += step) {
            const v = channelData[i];
            if (v < mn) mn = v;
            if (v > mx) mx = v;
        }
        out[b * 2] = mn;
        out[b * 2 + 1] = mx;
    }
    return out;
}

// ComfyUI stores the upload widget value as a plain filename string, or as
// {name, type, files:[{name, type, subfolder}]}. Accept both.
function fileInfo(value) {
    if (!value) return null;
    if (Array.isArray(value.files) && value.files.length) {
        const f = value.files[0];
        return { name: f.name ?? value.name, type: f.type ?? value.type ?? "input", subfolder: f.subfolder ?? "" };
    }
    if (typeof value === "object" && value.name) value = value.name;
    if (typeof value !== "string" || !value) return null;
    const i = value.indexOf("/");
    return i > 0
        ? { name: value.slice(i + 1), type: value.type ?? "input", subfolder: value.slice(0, i) }
        : { name: value, type: value.type ?? "input", subfolder: "" };
}

class AudioEditor {
    constructor(node, widgets) {
        this.node = node;
        this.wAudio = widgets.audio;
        this.wStart = widgets.start;
        this.wEnd = widgets.end;
        this.dur = 0;
        this.crop = [0, 0];      // seconds; [0, 0] = full range not yet touched
        this.playhead = 0;
        this.buffer = null;
        this.actx = null;
        this.src = null;         // region-play source
        this.snippet = null;     // scrub-audition source
        this.playing = false;
        this.drag = null;        // "start" | "end" | "scrub"
        this._syncing = false;
        this._raf = 0;
        this._lastSnippet = 0;
        this._gpu = null;        // set after async init

        injectStyle();
        this.el = document.createElement("div");
        this.el.className = "nougan-audio-editor";
        this.el.innerHTML = `
            <div class="nae-wave"><canvas></canvas></div>
            <div class="nae-bar">
                <button class="nae-play" title="Play crop region">▶</button>
                <span class="nae-time">no audio loaded</span>
                <button class="nae-reset" title="Reset crop to full length">reset</button>
            </div>`;
        this.wave = this.el.querySelector(".nae-wave");
        this.canvas = this.el.querySelector("canvas");
        this.timeEl = this.el.querySelector(".nae-time");
        this.playBtn = this.el.querySelector(".nae-play");

        this.renderer = new CpuWave(this.canvas);
        getGPUDevice().then(() => this._tryGpu());

        this._bind();
        this.pullFromWidgets();
    }

    async _tryGpu() {
        if (this._disposed || this._gpu) return;
        const gpu = new GpuWave(this.canvas);
        if (await gpu.init(this.peaks)) {
            this.renderer = gpu;
            this.resize();
        }
    }

    _bind() {
        this._ro = new ResizeObserver(() => this.resize());
        this._ro.observe(this.wave);

        this.wave.addEventListener("pointerdown", (e) => this._down(e));
        this.wave.addEventListener("pointermove", (e) => this._move(e));
        this.wave.addEventListener("pointerup", (e) => this._up(e));
        this.wave.addEventListener("pointercancel", (e) => this._up(e));

        this.playBtn.addEventListener("click", () => {
            this._audioCtx();
            this.playing ? this.stop() : this.play();
        });
        this.el.querySelector(".nae-reset").addEventListener("click", () => {
            this.crop = [0, 0];
            this.playhead = 0;
            this.pushToWidgets();
            this.render();
        });
    }

    _audioCtx() {
        if (!this.actx) this.actx = new (window.AudioContext || window.webkitAudioContext)();
        if (this.actx.state === "suspended") this.actx.resume();
        return this.actx;
    }

    // ── file loading ──
    async reload() {
        const info = fileInfo(this.wAudio?.value);
        if (!info) {
            this.buffer = null;
            this.dur = 0;
            this.crop = [0, 0];
            this.playhead = 0;
            this.peaks = null;
            this.renderer.setPeaks(null);
            this.timeEl.textContent = "no audio loaded";
            this.stop();
            this.render();
            return;
        }
        try {
            const url = `/view?filename=${encodeURIComponent(info.name)}&type=${encodeURIComponent(info.type)}&subfolder=${encodeURIComponent(info.subfolder)}&rand=${Date.now()}`;
            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const bytes = await res.arrayBuffer();
            const buf = await this._audioCtx().decodeAudioData(bytes);
            if (this._disposed) return;
            this.buffer = buf;
            this.dur = buf.duration;
            // downmix to one channel for the waveform
            const ch0 = buf.getChannelData(0);
            if (buf.numberOfChannels === 1) {
                this.peaks = computePeaks(ch0, BINS);
            } else {
                const mixed = new Float32Array(buf.length);
                for (let c = 0; c < buf.numberOfChannels; c++) {
                    const ch = buf.getChannelData(c);
                    for (let i = 0; i < ch.length; i++) mixed[i] += ch[i] / buf.numberOfChannels;
                }
                this.peaks = computePeaks(mixed, BINS);
            }
            this.renderer.setPeaks(this.peaks);
            // keep a crop saved in the workflow; clamp it to the new length.
            // fresh node / fresh upload has 0/0 = full range.
            const savedS = this.wStart.value, savedE = this.wEnd.value;
            this.crop = [
                Math.min(Math.max(savedS, 0), this.dur),
                savedE > 0 ? Math.min(savedE, this.dur) : this.dur,
            ];
            this.playhead = this.crop[0];
            this.pushToWidgets();
            this.render();
        } catch (err) {
            console.warn("[NouganAudioLoader] could not load audio:", err);
            this.timeEl.textContent = "failed to load audio";
        }
    }

    // ── widget <-> editor sync ──
    cropSecs() {
        const end = this.wEnd.value > 0 ? Math.min(this.wEnd.value, this.dur || this.wEnd.value) : (this.dur || 0);
        const start = Math.min(this.wStart.value, end);
        return [start, end];
    }

    pullFromWidgets() {
        if (this._syncing || !this.dur) return;
        const [s, e] = this.cropSecs();
        if (Math.abs(s - this.crop[0]) > 1e-4 || Math.abs(e - this.crop[1]) > 1e-4) {
            this.crop = [s, e];
            this.render();
        }
    }

    pushToWidgets() {
        if (this._syncing) return;
        this._syncing = true;
        try {
            this.wStart.value = round3(this.crop[0]);
            // 0 means "to end" on the Python side, so write 0 for a full-range crop
            this.wEnd.value = this.crop[1] >= this.dur - 1e-3 ? 0 : round3(this.crop[1]);
        } finally {
            this._syncing = false;
        }
        this.render();
    }

    // ── interaction ──
    _timeAt(e) {
        const r = this.wave.getBoundingClientRect();
        const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
        return f * this.dur;
    }
    _xOf(t) {
        const r = this.wave.getBoundingClientRect();
        return (t / (this.dur || 1)) * r.width;
    }

    _down(e) {
        if (!this.buffer) return;
        e.preventDefault();
        this.wave.setPointerCapture(e.pointerId);
        const t = this._timeAt(e);
        const [cs, ce] = this.cropSecs();
        const x = e.clientX - this.wave.getBoundingClientRect().left;
        const grab = 7;
        if (Math.abs(x - this._xOf(cs)) <= grab) this.drag = "start";
        else if (Math.abs(x - this._xOf(ce)) <= grab) this.drag = "end";
        else this.drag = "scrub";
        this._applyDrag(t);
    }

    _move(e) {
        if (!this.buffer) return;
        if (!this.drag) {
            // hover cursor only
            const [cs, ce] = this.cropSecs();
            const x = e.clientX - this.wave.getBoundingClientRect().left;
            const near = Math.abs(x - this._xOf(cs)) <= 7 || Math.abs(x - this._xOf(ce)) <= 7;
            this.wave.classList.toggle("nae-drag-edge", near);
            return;
        }
        this._applyDrag(this._timeAt(e));
    }

    _applyDrag(t) {
        if (this.drag === "start") {
            this.crop[0] = Math.min(Math.max(t, 0), this.cropSecs()[1] - 0.01);
            this.playhead = this.crop[0];
            this._audition(this.crop[0]);
            this.pushToWidgets();
        } else if (this.drag === "end") {
            this.crop[1] = Math.max(Math.min(t, this.dur), this.cropSecs()[0] + 0.01);
            this.playhead = this.crop[1];
            this._audition(this.crop[1]);
            this.pushToWidgets();
        } else {
            this.playhead = Math.min(Math.max(t, 0), this.dur);
            this._audition(this.playhead);
            this.render();
        }
    }

    _up() {
        this.drag = null;
        this.wave.classList.remove("nae-drag-edge");
    }

    // short audible snippet while scrubbing
    _audition(t) {
        if (!this.buffer) return;
        const now = performance.now();
        if (now - this._lastSnippet < 45) return; // throttle restarts
        this._lastSnippet = now;
        try {
            this.snippet?.stop();
        } catch {}
        const start = Math.max(0, Math.min(t, this.dur - 0.05));
        const len = Math.min(0.22, this.dur - start);
        const src = this._audioCtx().createBufferSource();
        const gain = this.actx.createGain();
        gain.gain.value = 0.8;
        src.buffer = this.buffer;
        src.connect(gain).connect(this.actx.destination);
        src.start(0, start, len);
        this.snippet = src;
    }

    // ── playback of the crop region ──
    play() {
        if (!this.buffer) return;
        const [cs, ce] = this.cropSecs();
        this.stopSources();
        const src = this._audioCtx().createBufferSource();
        src.buffer = this.buffer;
        src.connect(this.actx.destination);
        this._t0 = this.actx.currentTime;
        this._offset = cs;
        src.start(0, cs, ce - cs);
        src.onended = () => { if (this.playing) this.stop(); };
        this.src = src;
        this.playing = true;
        this.playBtn.textContent = "⏸";
        const tick = () => {
            if (!this.playing) return;
            this.playhead = this._offset + (this.actx.currentTime - this._t0);
            if (this.playhead >= ce) { this.stop(); return; }
            this.render();
            this._raf = requestAnimationFrame(tick);
        };
        this._raf = requestAnimationFrame(tick);
    }

    stopSources() {
        try { this.src?.stop(); } catch {}
        try { this.snippet?.stop(); } catch {}
        this.src = this.snippet = null;
    }

    stop() {
        this.playing = false;
        cancelAnimationFrame(this._raf);
        this.stopSources();
        this.playBtn.textContent = "▶";
        this.render();
    }

    // ── rendering ──
    resize() {
        if (this._disposed) return;
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const w = this.wave.clientWidth, h = this.wave.clientHeight;
        if (!w || !h) return;
        const bw = Math.round(w * dpr), bh = Math.round(h * dpr);
        if (this.canvas.width !== bw || this.canvas.height !== bh) {
            this.canvas.width = bw;
            this.canvas.height = bh;
            this.renderer.configure();
        }
        this.render();
    }

    render() {
        if (this._disposed) return;
        const w = this.wave.clientWidth, h = this.wave.clientHeight;
        if (!w || !h) return;
        const [cs, ce] = this.cropSecs();
        const cropS = this.dur ? cs / this.dur : 0;
        const cropE = this.dur ? ce / this.dur : 1;
        const playFrac = this.dur ? Math.min(this.playhead, this.dur) / this.dur : 0;
        this.renderer.draw(w, h, cropS, cropE, playFrac);
        this.timeEl.textContent = this.buffer
            ? `${fmt(cs)} – ${fmt(ce)}  /  ${fmt(this.dur)}`
            : "no audio loaded";
    }

    dispose() {
        this._disposed = true;
        this._ro.disconnect();
        this.stop();
        this.actx?.close();
    }
}

// ── ComfyUI extension wiring ─────────────────────────────────────────────────

app.registerExtension({
    name: "Nougan.AudioLoader",
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "NouganAudioLoader") return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            onNodeCreated?.apply(this, arguments);
            const widgets = {
                audio: this.widgets?.find((w) => w.name === "audio"),
                start: this.widgets?.find((w) => w.name === "crop_start"),
                end: this.widgets?.find((w) => w.name === "crop_end"),
            };
            if (!widgets.audio || !widgets.start || !widgets.end) return;

            const editor = new AudioEditor(this, widgets);
            this._nouganAudioEditor = editor;

            const widget = this.addDOMWidget("audio_editor", "audio_editor", editor.el, {
                serialize: false,
                hideOnZoom: true,
            });

            // react to the upload widget changing (file picked / uploaded)
            const audioCb = widgets.audio.callback;
            widgets.audio.callback = function () {
                audioCb?.apply(this, arguments);
                editor.reload();
            };
            const startCb = widgets.start.callback;
            widgets.start.callback = function () {
                startCb?.apply(this, arguments);
                editor.pullFromWidgets();
            };
            const endCb = widgets.end.callback;
            widgets.end.callback = function () {
                endCb?.apply(this, arguments);
                editor.pullFromWidgets();
            };

            if (widgets.audio.value) editor.reload();
        };

        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            onConfigure?.apply(this, arguments);
            const editor = this._nouganAudioEditor;
            if (editor) {
                editor.pullFromWidgets();
                if (editor.wAudio?.value && !editor.buffer) editor.reload();
            }
        };

        const onRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            onRemoved?.apply(this, arguments);
            this._nouganAudioEditor?.dispose();
            this._nouganAudioEditor = null;
        };
    },
});
