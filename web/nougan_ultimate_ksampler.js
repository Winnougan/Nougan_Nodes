// Nougan Ultimate KSampler — frontend. Preview panel derived from the Preview Mirror
// (same kj_preview_override stream) plus a WebGPU progress bar along the bottom.
// Listens to the "kj_preview_override" websocket event that KJNodes' Model Preview Override already
// broadcasts, and renders it in its own panel (video/image, σ/Δ graph, step time, audio spectrogram).
// No imports from KJNodes; CSS is injected from this file.

const { app } = window.comfyAPI.app;
const { api } = window.comfyAPI.api;

const NODE_NAME = "NouganUltimateKSampler";
const STYLE_ID = "ng-uk-stylesheet";
const GRAPH_PAD_X = 4;

const CSS = `
.ng-uk-root{width:100%;height:100%;position:relative;background:#181818;color:#b0b0b0;font:12px monospace;display:flex;flex-direction:column;overflow:hidden;user-select:none}
.ng-uk-image-area{flex:1 1 auto;min-height:80px;position:relative;display:flex;align-items:center;justify-content:center;background:#0a0a0a;overflow:hidden}
.ng-uk-img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;image-rendering:pixelated;display:block}
.ng-uk-placeholder{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#707070;font:12px monospace;pointer-events:none}
.ng-uk-scrub{position:absolute;left:0;right:0;bottom:0;height:6px;background:rgba(0,0,0,.5);cursor:pointer;z-index:5;transition:height 80ms ease}
.ng-uk-scrub:hover{height:10px}
.ng-uk-scrub-fill{height:100%;width:0%;background:#e67e22;pointer-events:none}
.ng-uk-scrub.ng-uk-paused .ng-uk-scrub-fill{background:#707070}
.ng-uk-panel-grip{flex:0 0 5px;background:#2a2a2a;cursor:ns-resize;position:relative;z-index:4}
.ng-uk-panel-grip::after{content:'';position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:26px;height:2px;background:#555;border-radius:1px}
.ng-uk-panel-grip:hover{background:#3a3a3a}
.ng-uk-panel-grip:hover::after{background:#888}
.ng-uk-panel{flex:0 0 auto;height:140px;min-height:60px;background:#181818;font:11px monospace;color:#b0b0b0;display:flex;flex-direction:column;overflow:hidden}
.ng-uk-panel-header{display:flex;justify-content:space-between;align-items:center;padding:4px 10px;gap:8px;background:#202020;border-bottom:1px solid #2a2a2a}
.ng-uk-header-left{display:flex;align-items:center;gap:8px}
.ng-uk-panel-title{color:#b0b0b0;font-size:11px}
.ng-uk-panel-summary{color:#707070;font-size:10px}
.ng-uk-graphs-grid{display:flex;align-items:stretch;padding:6px 6px 7px;gap:6px;flex:1 1 auto;min-height:0;box-sizing:border-box}
.ng-uk-graph-cell{flex:1 1 0;min-width:0;display:flex;flex-direction:column;background:#0e0e0e;border:1px solid #1c1c1c;border-radius:3px;overflow:hidden}
.ng-uk-graph-head{flex:0 0 auto;display:flex;justify-content:space-between;align-items:baseline;padding:3px 6px 2px;background:#161616;border-bottom:1px solid #1c1c1c;font-size:10px;line-height:1.1;gap:4px}
.ng-uk-graph-label{color:#707070;letter-spacing:.05em;flex:0 0 auto}
.ng-uk-graph-value{color:#b0b0b0;font-size:10px;text-align:right;flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ng-uk-graph-canvas{flex:1 1 auto;display:block;width:100%;min-height:0}
.ng-uk-spec{flex:0 0 auto;display:flex;flex-direction:column;border-top:1px solid #2a2a2a;background:#141414}
.ng-uk-spec-canvas{display:block;width:100%;height:44px}
.ng-uk-audio-btn{background:#262626;color:#707070;border:1px solid #333;border-radius:3px;font-size:11px;line-height:1;padding:1px 4px;cursor:pointer}
.ng-uk-audio-btn:hover{background:#333;color:#b0b0b0}
.ng-uk-audio-btn.ng-uk-audio-on{color:#e67e22;border-color:#e67e22}
.ng-uk-bar{flex:0 0 auto;display:flex;flex-direction:column;gap:3px;padding:5px 8px 7px;background:#141414;border-top:1px solid #2a2a2a}
.ng-uk-bar-row{display:flex;justify-content:space-between;font:10px monospace;color:#707070}
.ng-uk-bar-canvas{display:block;width:100%;height:14px;border-radius:7px}
`;

function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = CSS;
    document.head.appendChild(s);
}

// ---------- helpers (self-contained replacements for KJNodes' utility.js) ----------
function chainCallback(obj, name, fn) {
    const orig = obj[name];
    obj[name] = function (...args) {
        const r = orig ? orig.apply(this, args) : undefined;
        const r2 = fn.apply(this, args);
        return r !== undefined ? r : r2;
    };
}

function addMiddleClickPan(root) {
    root.addEventListener("pointerdown", (e) => {
        if (e.button !== 1) return;
        const ds = app.canvas?.ds;
        if (!ds) return;
        e.preventDefault();
        e.stopPropagation();
        const sx = e.clientX, sy = e.clientY, ox = ds.offset[0], oy = ds.offset[1];
        const move = (ev) => {
            ds.offset[0] = ox + (ev.clientX - sx) / ds.scale;
            ds.offset[1] = oy + (ev.clientY - sy) / ds.scale;
            app.canvas.setDirty(true, true);
        };
        const up = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
    });
}

function addWheelPassthrough(root) {
    // let the canvas zoom while the cursor is over the panel
    root.addEventListener("wheel", (e) => {
        try {
            e.preventDefault();
            app.canvas?.processMouseWheel?.(e);
        } catch { /* best effort */ }
    }, { passive: false });
}

function fmt(n, d) { return Number.isFinite(n) ? n.toFixed(d) : "—"; }

function el(tag, className, parent) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (parent) parent.appendChild(e);
    return e;
}

function b64ToBlob(b64, mime) {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
}

function syncCanvasDPR(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || canvas.width;
    const cssH = canvas.clientHeight || canvas.height;
    if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
        canvas.width = Math.round(cssW * dpr);
        canvas.height = Math.round(cssH * dpr);
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, W: cssW, H: cssH };
}

function drawGridlines(ctx, W, H, padX, padY) {
    ctx.strokeStyle = "#1e1e1e";
    ctx.lineWidth = 1;
    for (let g = 1; g < 4; g++) {
        const y = Math.round(padY + (g / 4) * (H - 2 * padY)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(padX, y);
        ctx.lineTo(W - padX, y);
        ctx.stroke();
    }
}

function drawSigmaDeltaGraph(canvas, sigmas, deltas, step, totalSteps, hoverStep, dbCurve, lockedStep) {
    const { ctx, W, H } = syncCanvasDPR(canvas);
    const padX = GRAPH_PAD_X, padY = 3;
    const iW = W - 2 * padX, iH = H - 2 * padY;
    ctx.clearRect(0, 0, W, H);
    drawGridlines(ctx, W, H, padX, padY);

    const n = sigmas?.length || 0;
    const xSteps = Math.max(totalSteps || n, n, deltas?.length || 0);
    const xAt = i => padX + (i / Math.max(1, xSteps - 1)) * iW;

    let sYAt = null;
    if (n > 1) {
        let sMax = -Infinity, sMin = Infinity;
        for (const s of sigmas) { if (s > sMax) sMax = s; if (s < sMin) sMin = s; }
        if (sMin > 0) sMin = 0;
        const sRange = Math.max(sMax - sMin, 1e-6);
        sYAt = v => padY + (1 - (v - sMin) / sRange) * iH;

        ctx.strokeStyle = "rgba(208,208,208,0.55)";
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
            const px = padX + (i / (n - 1)) * iW;
            const py = sYAt(sigmas[i]);
            if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.stroke();
        ctx.setLineDash([]);

        const i = Math.max(0, Math.min(n - 1, step));
        ctx.fillStyle = "#d0d0d0";
        ctx.beginPath();
        ctx.arc(padX + (i / Math.max(1, n - 1)) * iW, sYAt(sigmas[i]), 2.5, 0, Math.PI * 2);
        ctx.fill();
    }

    let dYAt = null;
    if (deltas && deltas.length >= 1) {
        let dMax = -Infinity;
        for (const v of deltas) if (Number.isFinite(v) && v > dMax) dMax = v;
        const dRange = Math.max(dMax, 1e-6);
        dYAt = v => padY + (1 - v / dRange) * iH;

        ctx.beginPath();
        ctx.moveTo(xAt(0), H - padY);
        ctx.lineTo(xAt(0), dYAt(deltas[0]));
        for (let i = 0; i < deltas.length; i++) ctx.lineTo(xAt(i + 1), dYAt(deltas[i]));
        ctx.lineTo(xAt(deltas.length), H - padY);
        ctx.closePath();
        ctx.fillStyle = "rgba(230,126,34,0.15)";
        ctx.fill();

        ctx.strokeStyle = "#e67e22";
        ctx.lineWidth = 1.3;
        if (deltas.length === 1) {
            ctx.fillStyle = "#e67e22";
            ctx.beginPath();
            ctx.arc(xAt(1), dYAt(deltas[0]), 2, 0, Math.PI * 2);
            ctx.fill();
        } else {
            ctx.beginPath();
            for (let i = 0; i < deltas.length; i++) {
                const px = xAt(i + 1), py = dYAt(deltas[i]);
                if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
            }
            ctx.stroke();
        }
    }

    if (Array.isArray(dbCurve) && dbCurve.length > 1) {
        let dbMaxAbs = 0;
        for (const v of dbCurve) if (Number.isFinite(v) && Math.abs(v) > dbMaxAbs) dbMaxAbs = Math.abs(v);
        const dbXAt = i => padX + (i / Math.max(1, dbCurve.length - 1)) * iW;
        const baselineY = H - padY - 0.5;
        const isActive = v => Number.isFinite(v);

        ctx.strokeStyle = "rgba(120,200,220,0.25)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        let inactiveOpen = false;
        for (let i = 0; i < dbCurve.length; i++) {
            if (!isActive(dbCurve[i])) {
                if (!inactiveOpen) { ctx.moveTo(dbXAt(i), baselineY); inactiveOpen = true; }
                else ctx.lineTo(dbXAt(i), baselineY);
            } else inactiveOpen = false;
        }
        ctx.stroke();

        if (dbMaxAbs > 1e-9) {
            const dbYAt = v => padY + (1 - Math.abs(v) / dbMaxAbs) * iH;
            ctx.strokeStyle = "rgba(120,200,220,0.85)";
            ctx.fillStyle = "rgba(120,200,220,0.85)";
            ctx.lineWidth = 1.2;
            ctx.beginPath();
            let segStart = -1;
            for (let i = 0; i <= dbCurve.length; i++) {
                const v = i < dbCurve.length ? dbCurve[i] : null;
                if (isActive(v)) {
                    if (segStart < 0) { segStart = i; ctx.moveTo(dbXAt(i), dbYAt(v)); }
                    else ctx.lineTo(dbXAt(i), dbYAt(v));
                } else if (segStart >= 0) {
                    if (i - segStart === 1) ctx.fillRect(dbXAt(segStart) - 1, dbYAt(dbCurve[segStart]) - 1, 2, 2);
                    segStart = -1;
                }
            }
            ctx.stroke();
        }
    }

    if (lockedStep != null && lockedStep >= 0 && lockedStep < xSteps) {
        const lx = xAt(lockedStep) + 0.5;
        ctx.strokeStyle = "rgba(245,200,60,0.9)";
        ctx.lineWidth = 1.2;
        ctx.setLineDash([4, 2]);
        ctx.beginPath();
        ctx.moveTo(lx, padY);
        ctx.lineTo(lx, H - padY);
        ctx.stroke();
        ctx.setLineDash([]);
    }

    if (hoverStep != null && hoverStep >= 0 && hoverStep < xSteps) {
        const hx = xAt(hoverStep) + 0.5;
        ctx.strokeStyle = "rgba(208,208,208,0.5)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(hx, padY);
        ctx.lineTo(hx, H - padY);
        ctx.stroke();
        if (sYAt && hoverStep < n) {
            ctx.fillStyle = "#d0d0d0";
            ctx.beginPath();
            ctx.arc(hx - 0.5, sYAt(sigmas[hoverStep]), 2.5, 0, Math.PI * 2);
            ctx.fill();
        }
        if (dYAt && hoverStep >= 1 && (hoverStep - 1) < deltas.length) {
            ctx.fillStyle = "#e67e22";
            ctx.beginPath();
            ctx.arc(hx - 0.5, dYAt(deltas[hoverStep - 1]), 2.5, 0, Math.PI * 2);
            ctx.fill();
        }
    }
}

function drawLineGraph(canvas, values, totalSteps) {
    const { ctx, W, H } = syncCanvasDPR(canvas);
    const padX = GRAPH_PAD_X, padY = 3;
    const iW = W - 2 * padX, iH = H - 2 * padY;
    ctx.clearRect(0, 0, W, H);
    drawGridlines(ctx, W, H, padX, padY);
    if (!values || values.length < 1) return;

    let vMax = -Infinity, vMin = Infinity;
    for (const v of values) { if (v > vMax) vMax = v; if (v < vMin) vMin = v; }
    if (vMin > 0) vMin = 0;
    const vRange = Math.max(vMax - vMin, 1e-6);
    const xSteps = Math.max(totalSteps || values.length, values.length);
    const px = i => padX + (i / Math.max(1, xSteps - 1)) * iW;
    const py = v => padY + (1 - (v - vMin) / vRange) * iH;

    ctx.beginPath();
    ctx.moveTo(padX, H - padY);
    for (let i = 0; i < values.length; i++) ctx.lineTo(px(i), py(values[i]));
    ctx.lineTo(px(values.length - 1), H - padY);
    ctx.closePath();
    ctx.fillStyle = "rgba(230,126,34,0.15)";
    ctx.fill();

    ctx.strokeStyle = "#e67e22";
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    for (let i = 0; i < values.length; i++) {
        if (i === 0) ctx.moveTo(px(i), py(values[i])); else ctx.lineTo(px(i), py(values[i]));
    }
    ctx.stroke();
}

// ---------- WebGPU progress bar ----------
const WGSL = `
struct U { res: vec2<f32>, t: f32, p: f32, col: vec4<f32> };
@group(0) @binding(0) var<uniform> u: U;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  var pos = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  return vec4<f32>(pos[i], 0.0, 1.0);
}
fn sdBox(p: vec2<f32>, b: vec2<f32>, r: f32) -> f32 {
  let q = abs(p) - b + vec2<f32>(r, r);
  return length(max(q, vec2<f32>(0.0, 0.0))) + min(max(q.x, q.y), 0.0) - r;
}
@fragment fn fs(@builtin(position) fc: vec4<f32>) -> @location(0) vec4<f32> {
  let hs = u.res * 0.5;
  let r = hs.y;
  let d = sdBox(fc.xy - hs, hs - vec2<f32>(1.0, 1.0), r - 1.0);
  let aa = 1.0 - smoothstep(-1.0, 1.0, d);
  if (aa <= 0.0) { return vec4<f32>(0.0, 0.0, 0.0, 0.0); }
  let x = fc.x / u.res.x;
  let vy = fc.y / u.res.y;
  let fillMask = 1.0 - smoothstep(u.p - 0.003, u.p + 0.003, x);
  let flow = 0.5 + 0.5 * sin((x * 10.0 - u.t * 1.6) * 3.14159);
  let sheen = 1.0 - abs(vy * 2.0 - 1.0);
  let fillCol = u.col.rgb * (0.62 + 0.38 * flow) * (0.78 + 0.32 * sheen);
  let edge = exp(-abs(x - u.p) * 45.0) * step(0.002, u.p) * (1.0 - step(0.999, u.p));
  let rgb = mix(vec3<f32>(0.07, 0.07, 0.08), fillCol, fillMask) + u.col.rgb * edge * 0.55;
  return vec4<f32>(rgb * aa, aa);
}`;

let _gpuPromise = null;
function getGPU() {
    if (_gpuPromise) return _gpuPromise;
    _gpuPromise = (async () => {
        try {
            if (!navigator.gpu) return null;
            const adapter = await navigator.gpu.requestAdapter();
            if (!adapter) return null;
            const device = await adapter.requestDevice();
            const format = navigator.gpu.getPreferredCanvasFormat();
            const module = device.createShaderModule({ code: WGSL });
            const pipeline = device.createRenderPipeline({
                layout: "auto",
                vertex: { module, entryPoint: "vs" },
                fragment: { module, entryPoint: "fs", targets: [{ format }] },
                primitive: { topology: "triangle-list" },
            });
            return { device, format, pipeline };
        } catch (err) {
            console.warn("[Nougan.UltimateKSampler] WebGPU unavailable, using 2D bar:", err);
            return null;
        }
    })();
    return _gpuPromise;
}

const PHASE_COLORS = {            // rgb 0..1
    idle:     [0.44, 0.44, 0.46],
    sampling: [0.90, 0.49, 0.13],
    decoding: [0.47, 0.78, 0.86],
    done:     [0.40, 0.80, 0.50],
};

function createProgressBar(parent) {
    const wrap = el("div", "ng-uk-bar", parent);
    const row = el("div", "ng-uk-bar-row", wrap);
    const left = el("span", "", row);
    const right = el("span", "", row);
    const canvas = el("canvas", "ng-uk-bar-canvas", wrap);
    left.textContent = "idle";
    right.textContent = "";

    const st = { p: 0, target: 0, phase: "idle", gpu: null, ctx: null, buf: null, bind: null, raf: null, alive: true };
    const uni = new Float32Array(8);

    function fit() {
        const dpr = window.devicePixelRatio || 1;
        const w = Math.max(1, Math.round((canvas.clientWidth || 200) * dpr));
        const h = Math.max(1, Math.round((canvas.clientHeight || 14) * dpr));
        if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    }

    function draw2d(t) {
        const c = st.ctx2d || (st.ctx2d = canvas.getContext("2d"));
        const { width: W, height: H } = canvas;
        c.clearRect(0, 0, W, H);
        c.fillStyle = "#121214";
        c.beginPath(); c.roundRect(0, 0, W, H, H / 2); c.fill();
        const col = PHASE_COLORS[st.phase].map(v => Math.round(v * 255));
        c.save(); c.beginPath(); c.roundRect(0, 0, W, H, H / 2); c.clip();
        const a = 0.75 + 0.25 * Math.sin(t * 3);
        c.fillStyle = `rgba(${col[0]},${col[1]},${col[2]},${a})`;
        c.fillRect(0, 0, W * st.p, H);
        c.restore();
    }

    function drawGpu(t) {
        const { device, pipeline } = st.gpu;
        const col = PHASE_COLORS[st.phase];
        uni[0] = canvas.width; uni[1] = canvas.height; uni[2] = t; uni[3] = st.p;
        uni[4] = col[0]; uni[5] = col[1]; uni[6] = col[2]; uni[7] = 1;
        device.queue.writeBuffer(st.buf, 0, uni);
        const enc = device.createCommandEncoder();
        const pass = enc.beginRenderPass({
            colorAttachments: [{
                view: st.ctx.getCurrentTexture().createView(),
                clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: "clear", storeOp: "store",
            }],
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, st.bind);
        pass.draw(3);
        pass.end();
        device.queue.submit([enc.finish()]);
    }

    function frame(ms) {
        if (!st.alive) return;
        st.raf = requestAnimationFrame(frame);
        if (!canvas.isConnected || canvas.clientWidth === 0) return;     // node collapsed / off-screen
        fit();
        st.p += (st.target - st.p) * 0.18;                                // ease toward target
        if (Math.abs(st.target - st.p) < 0.0005) st.p = st.target;
        const t = ms / 1000;
        try { st.gpu ? drawGpu(t) : draw2d(t); } catch (err) { st.gpu = null; }
    }

    getGPU().then((gpu) => {
        if (!gpu || !st.alive) return;
        try {
            const ctx = canvas.getContext("webgpu");
            ctx.configure({ device: gpu.device, format: gpu.format, alphaMode: "premultiplied" });
            const buf = gpu.device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
            const bind = gpu.device.createBindGroup({
                layout: gpu.pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: buf } }],
            });
            st.gpu = gpu; st.ctx = ctx; st.buf = buf; st.bind = bind;
        } catch (err) { st.gpu = null; }
    });
    st.raf = requestAnimationFrame(frame);

    return {
        set(value, max) { if (max > 0) st.target = Math.max(0, Math.min(1, value / max)); },
        phase(name) {
            if (!PHASE_COLORS[name]) return;
            st.phase = name;
            if (name === "idle") { st.target = 0; st.p = 0; }
            if (name === "decoding" || name === "done") st.target = 1;
        },
        text(l, r) { left.textContent = l; right.textContent = r ?? ""; },
        get current() { return st.phase; },
        destroy() { st.alive = false; if (st.raf != null) cancelAnimationFrame(st.raf); try { st.buf?.destroy(); } catch {} },
    };
}

// ---------- progress routing (independent of KJNodes so the bar works with the default preview too) ----------
const bars = new Set();
function forBars(detailNode, fn) {
    for (const n of [...bars]) {
        if (!n.graph) { bars.delete(n); continue; }
        if (detailNode == null || String(detailNode) === String(n._ngSource ?? n.id) || String(detailNode) === String(n.id)) fn(n);
    }
}
api.addEventListener("execution_start", () => { for (const n of bars) { n._ngBar?.phase("idle"); n._ngBar?.text("queued", ""); } });
api.addEventListener("progress", (e) => {
    const d = e.detail || {};
    forBars(d.node, (n) => {
        const bar = n._ngBar;
        if (!bar || bar.current === "decoding" || bar.current === "done") return;
        if (bar.current !== "sampling") bar.phase("sampling");
        bar.set(d.value, d.max);
        const pct = d.max > 0 ? Math.round((100 * d.value) / d.max) : 0;
        bar.text(`sampling ${d.value}/${d.max}`, `${pct}%`);
    });
});
api.addEventListener("nougan_uk_phase", (e) => {
    const d = e.detail || {};
    forBars(d.node, (n) => {
        const bar = n._ngBar;
        if (!bar) return;
        bar.phase(d.phase);
        if (d.phase === "sampling") { bar.set(0, 1); bar.text("sampling…", "0%"); }
        if (d.phase === "decoding") bar.text("decoding", "…");
        if (d.phase === "done") bar.text("done", "100%");
    });
});

// ---------- event routing ----------
const mirrors = new Set();
const lastInit = new Map();   // source node_id -> step-0 payload (sigmas etc., image stripped)

api.addEventListener("kj_preview_override", (e) => {
    const data = e.detail;
    if (!data || data.node_id == null) return;
    const id = String(data.node_id);

    if (data.step === 0 && Array.isArray(data.sigmas)) {
        const { image, ...init } = data;
        lastInit.set(id, init);
    }
    for (const m of [...mirrors]) {
        if (!m.graph) { mirrors.delete(m); continue; }                 // node removed
        if (m._ngSource != null && m._ngSource !== id) continue;       // bound to a different preview
        if (m._ngSeen !== id) {                                        // new source (or joined mid-run)
            m._ngSeen = id;
            m._ngSetLabel?.(id);
            const init = lastInit.get(id);
            if (init && data.step !== 0) m._ngHandler?.(init);         // replay sigmas for the graph
        }
        m._ngHandler?.(data);
    }
});

// ---------- the node ----------
app.registerExtension({
    name: "Nougan.UltimateKSampler",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData?.name !== NODE_NAME) return;

        chainCallback(nodeType.prototype, "onNodeCreated", function () {
            ensureStyles();
            const node = this;

            const root = el("div", "ng-uk-root");
            const imageArea = el("div", "ng-uk-image-area", root);

            // double-buffered <img>
            const imgA = el("img", "ng-uk-img", imageArea);
            const imgB = el("img", "ng-uk-img", imageArea);
            imgA.draggable = false; imgB.draggable = false;
            imgB.style.opacity = "0";
            let visibleImg = imgA, pendingImg = imgB;

            // animated WebP: ImageDecoder -> VideoFrame[] -> canvas
            const videoCanvas = el("canvas", "ng-uk-img", imageArea);
            videoCanvas.style.opacity = "0";
            const videoCtx = videoCanvas.getContext("2d");

            // MP4: double-buffered <video>
            function mkVideo() {
                const v = el("video", "ng-uk-img", imageArea);
                v.style.opacity = "0";
                v.muted = true;
                v.playsInline = true;
                v.loop = true;
                v.autoplay = true;
                v.disablePictureInPicture = true;
                return v;
            }
            let visibleVideo = mkVideo(), pendingVideo = mkVideo();

            const placeholder = el("div", "ng-uk-placeholder", imageArea);
            placeholder.textContent = "waiting for sample…";
            const scrubBar = el("div", "ng-uk-scrub", imageArea);
            const scrubFill = el("div", "ng-uk-scrub-fill", scrubBar);
            scrubBar.style.display = "none";

            const grip = el("div", "ng-uk-panel-grip", root);
            grip.title = "Drag to resize panel";
            const panel = el("div", "ng-uk-panel", root);
            const header = el("div", "ng-uk-panel-header", panel);
            const headerLeft = el("span", "ng-uk-header-left", header);
            const headerTitle = el("span", "ng-uk-panel-title", headerLeft);
            headerTitle.textContent = "Preview";
            let audioMuted = true;
            const audioBtn = el("button", "ng-uk-audio-btn", headerLeft);
            audioBtn.textContent = "🔇";
            audioBtn.title = "Toggle preview audio";
            audioBtn.style.display = "none";
            const headerSummary = el("span", "ng-uk-panel-summary", header);
            headerSummary.textContent = "idle";

            node.properties = node.properties || {};
            if (typeof node.properties.ngUkPanelH === "number") panel.style.height = node.properties.ngUkPanelH + "px";

            grip.addEventListener("mousedown", (e) => {
                if (e.button !== 0) return;
                e.preventDefault();
                e.stopPropagation();
                const startY = e.clientY, startH = panel.offsetHeight;
                const move = (ev) => {
                    const scale = app.canvas?.ds?.scale || 1;
                    const dy = (ev.clientY - startY) / scale;
                    const maxH = Math.max(60, root.getBoundingClientRect().height / scale - 80);
                    panel.style.height = Math.max(60, Math.min(maxH, startH - dy)) + "px";
                };
                const up = () => {
                    document.removeEventListener("mousemove", move);
                    document.removeEventListener("mouseup", up);
                    node.properties.ngUkPanelH = panel.offsetHeight;
                    node.graph?.change?.();
                };
                document.addEventListener("mousemove", move);
                document.addEventListener("mouseup", up);
            });
            chainCallback(node, "onConfigure", function () {
                if (typeof node.properties?.ngUkPanelH === "number") panel.style.height = node.properties.ngUkPanelH + "px";
            });

            const grid = el("div", "ng-uk-graphs-grid", panel);
            function makeCell(labelText) {
                const cell = el("div", "ng-uk-graph-cell", grid);
                const head = el("div", "ng-uk-graph-head", cell);
                const lbl = el("span", "ng-uk-graph-label", head);
                lbl.textContent = labelText;
                const valEl = el("span", "ng-uk-graph-value", head);
                const canvas = el("canvas", "ng-uk-graph-canvas", cell);
                return { canvas, valEl, lbl };
            }
            const sdRow = makeCell("σ / Δ");
            const timeRow = makeCell("step time (ms)");

            const specWrap = el("div", "ng-uk-spec", panel);
            const specHead = el("div", "ng-uk-graph-head", specWrap);
            el("span", "ng-uk-graph-label", specHead).textContent = "audio spectrogram";
            const specCanvas = el("canvas", "ng-uk-spec-canvas", specWrap);
            specWrap.style.display = "none";
            let specShown = false, specBumped = false, specRun = 0, specDrawKey = null;
            const stepSpecImgs = [], stepHasAudio = [], stepFps = [];

            // ---- per-run state ----
            let hoverStep = null, lockedStep = null, lastCurrentStep = -1;
            const history = { stepMs: [], delta: [] };
            let cachedSigmas = null, cachedDbCurve = null, totalSteps = 0;
            const stepBlobUrls = [], stepVideoFrames = [], stepMp4Urls = [];
            let liveBlobUrl = null, liveMp4Url = null;
            let playbackStartMs = null, videoRafId = null, currentMp4Url = null;
            let timeUnitSeconds = false;
            let lastStepMs = null, lastAvgStepMs = null, lastTotal = null, lastStep = null, lastW = null, lastH = null;
            let isPaused = false, pauseAtMs = 0, bakedFps = null;

            function applyMute() {
                visibleVideo.muted = audioMuted;
                pendingVideo.muted = true;
                audioBtn.textContent = audioMuted ? "🔇" : "🔊";
                audioBtn.classList.toggle("ng-uk-audio-on", !audioMuted);
            }
            audioBtn.addEventListener("mousedown", (ev) => ev.stopPropagation());
            audioBtn.addEventListener("click", (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                audioMuted = !audioMuted;
                applyMute();
                if (!audioMuted && !isPaused) visibleVideo.play().catch(() => {});
            });

            // mirror's own preview_fps widget
            const fpsWidget = node.widgets?.find(w => w.name === "preview_fps");
            function currentFps() {
                const v = +fpsWidget?.value;
                return Number.isFinite(v) && v > 0 ? v : 12;
            }

            function activeStepIdx() {
                if (lockedStep != null) return lockedStep;
                if (hoverStep != null) return hoverStep;
                return lastCurrentStep;
            }
            function elapsedMs() {
                if (playbackStartMs == null) return 0;
                return (isPaused ? pauseAtMs : performance.now()) - playbackStartMs;
            }
            function mp4Active() {
                return currentMp4Url != null && Number.isFinite(visibleVideo.duration) && visibleVideo.duration > 0;
            }
            function clipDurationMs() {
                if (mp4Active()) return visibleVideo.duration * 1000;
                const v = stepVideoFrames[activeStepIdx()];
                if (v && v.frames.length > 1) return v.frames.length * (1000 / currentFps());
                return 0;
            }
            function getProgress() {
                if (mp4Active()) return visibleVideo.currentTime / visibleVideo.duration;
                const dur = clipDurationMs();
                if (dur <= 0 || playbackStartMs == null) return 0;
                return (elapsedMs() % dur) / dur;
            }
            function setProgress(pos) {
                pos = Math.max(0, Math.min(1, pos));
                const dur = clipDurationMs();
                if (dur <= 0) return;
                const ref = isPaused ? pauseAtMs : performance.now();
                if (playbackStartMs == null) playbackStartMs = ref;
                playbackStartMs = ref - pos * dur;
                if (mp4Active()) visibleVideo.currentTime = pos * visibleVideo.duration;
            }
            function togglePause() {
                const willPause = !isPaused;
                if (mp4Active()) {
                    if (willPause) visibleVideo.pause(); else visibleVideo.play().catch(() => {});
                }
                if (willPause) {
                    pauseAtMs = performance.now();
                    isPaused = true;
                } else {
                    if (playbackStartMs != null) playbackStartMs += performance.now() - pauseAtMs;
                    isPaused = false;
                }
                scrubBar.classList.toggle("ng-uk-paused", isPaused);
            }

            // ---- spectrogram ----
            function drawSpec(force) {
                const idx = activeStepIdx();
                const im = stepSpecImgs[idx] || stepSpecImgs[lastCurrentStep];
                if (!im) return;
                const W = specCanvas.clientWidth || specCanvas.width;
                const px = clipDurationMs() > 0 ? Math.round(getProgress() * W) : -1;
                const key = im.src.length + ":" + idx + ":" + px + ":" + W;
                if (!force && key === specDrawKey) return;
                specDrawKey = key;
                const { ctx, H } = syncCanvasDPR(specCanvas);
                ctx.clearRect(0, 0, W, H);
                ctx.imageSmoothingEnabled = true;
                ctx.drawImage(im, 0, 0, W, H);
                if (px >= 0) {
                    ctx.strokeStyle = "rgba(255,255,255,0.85)";
                    ctx.lineWidth = 1;
                    ctx.beginPath();
                    ctx.moveTo(px + 0.5, 0);
                    ctx.lineTo(px + 0.5, H);
                    ctx.stroke();
                }
            }
            function setStepSpec(stepIdx, b64) {
                const run = specRun;
                const im = new Image();
                im.onload = () => {
                    if (run !== specRun) return;
                    stepSpecImgs[stepIdx] = im;
                    if (!specShown) {
                        specShown = true;
                        specWrap.style.display = "";
                        if (!specBumped && typeof node.properties?.ngUkPanelH !== "number") {
                            specBumped = true;
                            panel.style.height = (panel.offsetHeight + 60) + "px";
                        }
                    }
                    drawSpec(true);
                };
                im.src = "data:image/png;base64," + b64;
            }
            function resetSpec() {
                specRun++;
                stepSpecImgs.length = 0;
                stepHasAudio.length = 0;
                stepFps.length = 0;
                specShown = false;
                specDrawKey = null;
                specWrap.style.display = "none";
                audioBtn.style.display = "none";
            }

            // ---- time / header ----
            function fmtTime(ms) {
                if (ms == null || !Number.isFinite(ms)) return "—";
                return timeUnitSeconds ? `${(ms / 1000).toFixed(2)}s` : `${ms.toFixed(0)}ms`;
            }
            function stepTimeForDisplay() {
                let idx = lastCurrentStep;
                if (hoverStep != null) idx = hoverStep;
                else if (lockedStep != null) idx = lockedStep;
                const t = idx - 1;
                return (t >= 0 && t < history.stepMs.length) ? history.stepMs[t] : null;
            }
            function renderTime() {
                timeRow.lbl.textContent = timeUnitSeconds ? "step time (s)" : "step time (ms)";
                timeRow.valEl.textContent = fmtTime(stepTimeForDisplay());
                if (lastAvgStepMs != null && lastTotal != null && lastStep != null) {
                    const eta = Math.max(0, lastTotal - lastStep) * lastAvgStepMs / 1000;
                    const avgTxt = timeUnitSeconds
                        ? `${(lastAvgStepMs / 1000).toFixed(2)}s/step`
                        : `${lastAvgStepMs.toFixed(0)}ms/step`;
                    headerSummary.textContent = `${lastW}×${lastH} · ${lastStep}/${lastTotal} · ${avgTxt} · ETA ${eta.toFixed(1)}s`;
                }
            }
            const toggleTimeUnit = (ev) => { ev.stopPropagation(); timeUnitSeconds = !timeUnitSeconds; renderTime(); };
            for (const t of [timeRow.canvas, timeRow.lbl, timeRow.valEl]) {
                t.style.cursor = "pointer";
                t.addEventListener("click", toggleTimeUnit);
            }
            timeRow.canvas.title = "Click to toggle ms ↔ s";
            sdRow.canvas.style.cursor = "crosshair";

            const SD_LEG_BASE =
                '<span title="sigma — noise level at this boundary" style="color:#d0d0d0">σ</span> / '
                + '<span title="delta — magnitude of x0 change per step" style="color:#e67e22">Δ</span>';
            const SD_LEG_WITH_DB = SD_LEG_BASE
                + ' / <span title="SamplerDetailBoost curve" style="color:rgb(120,200,220)">DB</span>';
            function applySdLegend() { sdRow.lbl.innerHTML = cachedDbCurve ? SD_LEG_WITH_DB : SD_LEG_BASE; }
            applySdLegend();

            // ---- frame display ----
            function showLiveFrame(url) {
                const target = pendingImg;
                target.src = url;
                target.decode().then(() => {
                    if (hoverStep != null || lockedStep != null) return;
                    if (liveBlobUrl !== url) return;
                    if (target !== pendingImg) return;
                    target.style.opacity = "1";
                    visibleImg.style.opacity = "0";
                    const prev = visibleImg;
                    visibleImg = target;
                    pendingImg = prev;
                }).catch(() => {});
            }
            async function decodeAnimatedBlob(blob) {
                if (typeof ImageDecoder === "undefined") return null;
                try {
                    const decoder = new ImageDecoder({ data: blob.stream(), type: blob.type });
                    await decoder.completed;
                    const track = decoder.tracks.selectedTrack;
                    if (!track || track.frameCount <= 1) { decoder.close?.(); return null; }
                    const frames = [];
                    for (let i = 0; i < track.frameCount; i++) {
                        const r = await decoder.decode({ frameIndex: i });
                        frames.push(r.image);
                    }
                    decoder.close?.();
                    return { frames };
                } catch { return null; }
            }
            function closeStepVideo(stepIdx) {
                const v = stepVideoFrames[stepIdx];
                if (!v) return;
                for (const f of v.frames) { try { f.close(); } catch {} }
                stepVideoFrames[stepIdx] = null;
            }
            function drawCurrentVideoFrame() {
                const v = stepVideoFrames[activeStepIdx()];
                if (!v) return false;
                if (playbackStartMs == null) playbackStartMs = performance.now();
                const frameDurMs = 1000 / currentFps();
                const elapsed = elapsedMs() % (v.frames.length * frameDurMs);
                const frame = v.frames[Math.min(v.frames.length - 1, Math.floor(elapsed / frameDurMs))];
                if (videoCanvas.width !== frame.displayWidth || videoCanvas.height !== frame.displayHeight) {
                    videoCanvas.width = frame.displayWidth;
                    videoCanvas.height = frame.displayHeight;
                }
                videoCtx.drawImage(frame, 0, 0);
                return true;
            }
            function startVideoLoop() {
                if (videoRafId != null) return;
                const tick = () => {
                    videoRafId = requestAnimationFrame(tick);
                    if (!drawCurrentVideoFrame()) return;
                    if (videoCanvas.style.opacity !== "1") {
                        videoCanvas.style.opacity = "1";
                        imgA.style.opacity = "0";
                        imgB.style.opacity = "0";
                    }
                };
                videoRafId = requestAnimationFrame(tick);
            }
            function stopVideoLoop() {
                if (videoRafId != null) { cancelAnimationFrame(videoRafId); videoRafId = null; }
                videoCanvas.style.opacity = "0";
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
                        const dur = target.duration;
                        if (Number.isFinite(dur) && dur > 0) target.currentTime = (elapsedMs() / 1000) % dur;
                    } catch {}
                    target.style.opacity = "1";
                    requestAnimationFrame(() => requestAnimationFrame(() => {
                        if (target !== visibleVideo && currentMp4Url === url) {
                            visibleVideo.style.opacity = "0";
                            visibleVideo.pause();
                            const prev = visibleVideo;
                            visibleVideo = target;
                            pendingVideo = prev;
                            applyMute();
                            imgA.style.opacity = "0";
                            imgB.style.opacity = "0";
                            videoCanvas.style.opacity = "0";
                            if (isPaused) visibleVideo.pause();
                        }
                    }));
                };
                const afterSeek = () => {
                    if (typeof target.requestVideoFrameCallback === "function") {
                        target.requestVideoFrameCallback(() => promote());
                    } else promote();
                };
                const onLoaded = () => {
                    target.removeEventListener("loadeddata", onLoaded);
                    try {
                        const dur = target.duration;
                        if (Number.isFinite(dur) && dur > 0) {
                            target.addEventListener("seeked", afterSeek, { once: true });
                            target.currentTime = (elapsedMs() / 1000) % dur;
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
            function setStepBlob(stepIdx, blob) {
                const url = URL.createObjectURL(blob);
                if (placeholder.parentNode) placeholder.remove();
                if (blob.type === "video/mp4") {
                    if (stepMp4Urls[stepIdx]) { try { URL.revokeObjectURL(stepMp4Urls[stepIdx]); } catch {} }
                    stepMp4Urls[stepIdx] = url;
                    liveMp4Url = url;
                    if (hoverStep == null && lockedStep == null) showMp4(url);
                    return;
                }
                if (stepBlobUrls[stepIdx]) { try { URL.revokeObjectURL(stepBlobUrls[stepIdx]); } catch {} }
                stepBlobUrls[stepIdx] = url;
                liveBlobUrl = url;
                if (blob.type === "image/webp") {
                    decodeAnimatedBlob(blob).then(v => {
                        if (!v) {
                            if (hoverStep == null && lockedStep == null && liveBlobUrl === url) showLiveFrame(url);
                            return;
                        }
                        closeStepVideo(stepIdx);
                        stepVideoFrames[stepIdx] = v;
                        startVideoLoop();
                    });
                } else if (hoverStep == null && lockedStep == null) {
                    showLiveFrame(url);
                }
            }
            function resetFrames() {
                for (const u of stepBlobUrls) if (u) try { URL.revokeObjectURL(u); } catch {}
                stepBlobUrls.length = 0;
                liveBlobUrl = null;
                for (let i = 0; i < stepVideoFrames.length; i++) closeStepVideo(i);
                stepVideoFrames.length = 0;
                stopVideoLoop();
                for (const u of stepMp4Urls) if (u) try { URL.revokeObjectURL(u); } catch {}
                stepMp4Urls.length = 0;
                liveMp4Url = null;
                hideMp4();
                resetSpec();
                playbackStartMs = null;
                bakedFps = null;
                isPaused = false;
                scrubBar.classList.remove("ng-uk-paused");
            }
            function resetHistory() {
                history.stepMs.length = 0;
                history.delta.length = 0;
                resetFrames();
                hoverStep = null;
                lockedStep = null;
                lastStepMs = null;
            }

            function updateSdHeader() {
                let idx = null, prefix = "";
                if (hoverStep != null && cachedSigmas && hoverStep < cachedSigmas.length) {
                    idx = hoverStep; prefix = `[${idx}] `;
                } else if (lockedStep != null && cachedSigmas && lockedStep < cachedSigmas.length) {
                    idx = lockedStep; prefix = `🔒[${idx}] `;
                } else if (lastCurrentStep >= 0 && cachedSigmas) {
                    idx = Math.min(lastCurrentStep, cachedSigmas.length - 1);
                }
                if (idx == null) return;
                const dIdx = idx - 1;
                const d = (dIdx >= 0 && dIdx < history.delta.length) ? history.delta[dIdx] : null;
                let text = `${prefix}${fmt(cachedSigmas[idx], 3)} / ${fmt(d, 3)}`;
                if (cachedDbCurve && idx < cachedDbCurve.length) text += ` / ${fmt(cachedDbCurve[idx], 3)}`;
                sdRow.valEl.textContent = text;
            }
            function redrawSd() {
                drawSigmaDeltaGraph(sdRow.canvas, cachedSigmas, history.delta, lastCurrentStep, totalSteps, hoverStep, cachedDbCurve, lockedStep);
                updateSdHeader();
                renderTime();
                const displayStep = lockedStep != null ? lockedStep : hoverStep;
                const targetIdx = displayStep != null ? displayStep : lastCurrentStep;
                if (stepMp4Urls[targetIdx]) {
                    stopVideoLoop();
                    showMp4(stepMp4Urls[targetIdx]);
                } else if (stepVideoFrames[targetIdx]) {
                    hideMp4();
                    startVideoLoop();
                } else if (displayStep != null && stepBlobUrls[displayStep]) {
                    stopVideoLoop();
                    hideMp4();
                    visibleImg.src = stepBlobUrls[displayStep];
                } else if (liveMp4Url) {
                    stopVideoLoop();
                    showMp4(liveMp4Url);
                } else if (liveBlobUrl) {
                    stopVideoLoop();
                    hideMp4();
                    showLiveFrame(liveBlobUrl);
                }
            }

            // ---- scrub bar / tick loop ----
            let scrubRafId = null;
            function tickScrub() {
                scrubRafId = requestAnimationFrame(tickScrub);
                const dur = clipDurationMs();
                if (dur > 0) {
                    if (scrubBar.style.display === "none") scrubBar.style.display = "block";
                    scrubFill.style.width = (getProgress() * 100) + "%";
                } else if (scrubBar.style.display !== "none") {
                    scrubBar.style.display = "none";
                }
                if (mp4Active()) {
                    const idx = activeStepIdx();
                    const baked = stepFps[idx] ?? bakedFps;
                    const rate = stepHasAudio[idx] ? 1 : (baked > 0 ? Math.min(16, Math.max(0.0625, currentFps() / baked)) : 1);
                    if (Math.abs(visibleVideo.playbackRate - rate) > 0.001) visibleVideo.playbackRate = rate;
                }
                if (specShown) drawSpec(false);
            }
            scrubRafId = requestAnimationFrame(tickScrub);

            scrubBar.addEventListener("mousedown", (ev) => {
                if (ev.button !== 0) return;
                ev.stopPropagation();
                ev.preventDefault();
                const rect = scrubBar.getBoundingClientRect();
                const seek = (e) => setProgress((e.clientX - rect.left) / rect.width);
                seek(ev);
                const up = () => {
                    document.removeEventListener("mousemove", seek);
                    document.removeEventListener("mouseup", up);
                };
                document.addEventListener("mousemove", seek);
                document.addEventListener("mouseup", up);
            });
            imageArea.addEventListener("click", (ev) => {
                if (scrubBar.contains(ev.target)) return;
                if (clipDurationMs() <= 0) return;
                ev.stopPropagation();
                togglePause();
            });

            // ---- σ/Δ graph interaction ----
            function stepFromEvent(ev) {
                const rect = sdRow.canvas.getBoundingClientRect();
                const iW = Math.max(1, rect.width - 2 * GRAPH_PAD_X);
                const xSteps = Math.max(totalSteps || cachedSigmas.length, cachedSigmas.length, history.delta.length);
                const fx = (ev.clientX - rect.left - GRAPH_PAD_X) / iW;
                return Math.max(0, Math.min(xSteps - 1, Math.round(fx * (xSteps - 1))));
            }
            sdRow.canvas.addEventListener("mousemove", (ev) => {
                if (!cachedSigmas) return;
                const idx = stepFromEvent(ev);
                if (idx !== hoverStep) { hoverStep = idx; redrawSd(); }
            });
            sdRow.canvas.addEventListener("mouseleave", () => {
                if (hoverStep != null) { hoverStep = null; redrawSd(); }
            });
            sdRow.canvas.addEventListener("mousedown", (ev) => ev.stopPropagation());
            sdRow.canvas.addEventListener("click", (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                if (lockedStep != null) lockedStep = null;
                else if (cachedSigmas) lockedStep = stepFromEvent(ev);
                redrawSd();
            });

            // keyboard: only while the cursor is over this panel
            let mouseOverPanel = false;
            root.addEventListener("mouseenter", () => { mouseOverPanel = true; });
            root.addEventListener("mouseleave", () => { mouseOverPanel = false; });
            const onKey = (ev) => {
                if (!mouseOverPanel) return;
                if (ev.key === " " && clipDurationMs() > 0) {
                    ev.preventDefault(); ev.stopPropagation();
                    togglePause();
                    return;
                }
                if (!cachedSigmas) return;
                if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
                const xSteps = Math.max(totalSteps || cachedSigmas.length, cachedSigmas.length, history.delta.length);
                const cur = lockedStep != null ? lockedStep : (hoverStep != null ? hoverStep : lastCurrentStep);
                ev.preventDefault(); ev.stopPropagation();
                lockedStep = Math.max(0, Math.min(xSteps - 1, cur + (ev.key === "ArrowRight" ? 1 : -1)));
                redrawSd();
            };
            document.addEventListener("keydown", onKey, true);

            node._ngBar = createProgressBar(root);
            bars.add(node);
            addMiddleClickPan(root);
            addWheelPassthrough(root);

            node.addDOMWidget("preview", "ng_uk_preview", root, { serialize: false, getMinHeight: () => 360 });
            node.setSize([Math.max(node.size?.[0] ?? 440, 440), Math.max(node.size?.[1] ?? 940, 940)]);

            // ---- incoming data ----
            const handler = (data) => {
                try {
                    if (Array.isArray(data.sigmas) && data.sigmas.length > 1) {
                        cachedSigmas = data.sigmas;
                        cachedDbCurve = Array.isArray(data.db_curve) ? data.db_curve : null;
                        resetHistory();
                        applySdLegend();
                    }
                    if (typeof data.image === "string") {
                        const mime = typeof data.mime === "string" ? data.mime : "image/jpeg";
                        if (typeof data.fps === "number" && data.fps > 0) {
                            bakedFps = data.fps;
                            stepFps[data.step] = data.fps;
                        }
                        stepHasAudio[data.step] = !!data.audio;
                        if (data.audio && audioBtn.style.display === "none") {
                            audioBtn.style.display = "";
                            applyMute();
                        }
                        setStepBlob(data.step, b64ToBlob(data.image, mime));
                    }
                    if (typeof data.audio_spec === "string") setStepSpec(data.step, data.audio_spec);

                    totalSteps = data.total || totalSteps;
                    if (data.step_ms != null) history.stepMs.push(data.step_ms);
                    if (data.delta != null) history.delta.push(data.delta);
                    if (lastStepMs == null && data.step_ms != null && data.step_ms > 1500) timeUnitSeconds = true;
                    lastStepMs = data.step_ms;
                    lastAvgStepMs = data.avg_step_ms;
                    lastStep = data.step;
                    lastTotal = data.total;
                    lastW = data.w;
                    lastH = data.h;
                    lastCurrentStep = data.step;
                    renderTime();
                    if (node._ngBar?.current === "sampling" && lastAvgStepMs != null && lastTotal != null) {
                        const eta = Math.max(0, lastTotal - lastStep) * lastAvgStepMs / 1000;
                        node._ngBar.text(`sampling ${lastStep}/${lastTotal} · ${(lastAvgStepMs / 1000).toFixed(2)}s/step`, `ETA ${eta.toFixed(1)}s`);
                    }

                    drawSigmaDeltaGraph(sdRow.canvas, cachedSigmas, history.delta, lastCurrentStep, totalSteps, hoverStep, cachedDbCurve, lockedStep);
                    updateSdHeader();
                    drawLineGraph(timeRow.canvas, history.stepMs, totalSteps);
                } catch (err) {
                    console.warn("[Nougan.UltimateKSampler] preview update failed:", err);
                }
            };

            // ---- mirror wiring ----
            node._ngHandler = handler;
            node._ngSource = String(node.id);   // this node's own preview only
            node._ngSeen = null;
            node._ngSetLabel = (id) => { headerTitle.textContent = `Preview ← ${id}`; };
            mirrors.add(node);

            chainCallback(node, "onExecuted", function (msg) {
                const ids = msg?.nougan_source_id;
                const next = Array.isArray(ids) && ids.length ? String(ids[0]) : null;
                if (next != null && next !== node._ngSource) {
                    node._ngSource = next;
                    node._ngSeen = null;
                }
            });

            chainCallback(node, "onRemoved", function () {
                mirrors.delete(node);
                bars.delete(node);
                node._ngBar?.destroy();
                document.removeEventListener("keydown", onKey, true);
                node._ngHandler = null;
                resetFrames();
                stopVideoLoop();
                if (scrubRafId != null) cancelAnimationFrame(scrubRafId);
            });
        });
    },
});
