// Automagic 2222: Live Panel, render progress bar.
//
// A compact status line for the panel: what is running, step n/N, percent, ETA, queue depth,
// and a bar. It only listens to ComfyUI's own events (execution_start, executing, progress,
// execution_success / _error / _interrupted, status): numbers only, nothing is decoded.
//
// Two renderers for the bar:
//   * WebGPU  : a small fragment shader (smooth fill, moving sheen, glow on the leading edge).
//   * DOM     : plain CSS bar. Always works, and is the automatic fallback if WebGPU is missing,
//               fails to start, or the GPU device is lost.
//
// While switched off it holds no listener and no GPU device.
//
// Put this file next to nougan_live_panel.js in web/.

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const STYLE_ID = "nlp-progress-stylesheet";

const CSS = `
.nlp-pg{flex:0 0 auto;position:relative;padding:7px 10px 9px;background:var(--nlp-bg,#1e1e1e);border-bottom:1px solid var(--nlp-border,#3a3a3a);
  color:var(--nlp-fg,#d4d4d4);font:11px/1.3 system-ui,-apple-system,"Segoe UI",sans-serif;font-variant-numeric:tabular-nums;user-select:none}
.nlp-pg-row{display:flex;align-items:center;gap:8px;min-height:15px;margin-bottom:6px}
.nlp-pg-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--nlp-dim,#8a8a8a);transition:background .2s,box-shadow .2s}
.nlp-pg-label{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
.nlp-pg-meta{flex:none;display:flex;align-items:baseline;gap:6px;color:var(--nlp-dim,#8a8a8a);font-size:10px;white-space:nowrap}
.nlp-pg-meta b{color:var(--nlp-fg,#d4d4d4);font-weight:600;font-size:11px}
.nlp-pg-meta i{font-style:normal;opacity:.45}

.nlp-pg-track{position:relative;height:6px;border-radius:999px;overflow:hidden;background:var(--nlp-input,#121212);box-shadow:inset 0 0 0 1px var(--nlp-border,#3a3a3a)}
.nlp-pg-fill{position:absolute;left:0;top:0;bottom:0;width:0;border-radius:inherit;background:var(--nlp-accent,#e67e22);
  background:linear-gradient(90deg,color-mix(in srgb,var(--nlp-accent,#e67e22) 68%,#000),var(--nlp-accent,#e67e22));
  transition:width .28s cubic-bezier(.2,.8,.2,1)}
.nlp-pg-run .nlp-pg-fill::after{content:"";position:absolute;inset:0;
  background:linear-gradient(100deg,transparent 30%,rgba(255,255,255,.32) 50%,transparent 70%);background-size:220% 100%;
  animation:nlp-pg-sheen 1.5s linear infinite}
.nlp-pg-ind .nlp-pg-fill{width:34% !important;transition:none;animation:nlp-pg-slide 1.3s ease-in-out infinite}
@keyframes nlp-pg-sheen{from{background-position:220% 0}to{background-position:-220% 0}}
@keyframes nlp-pg-slide{0%{left:-34%}100%{left:100%}}

.nlp-pg-gpu{position:absolute;inset:0;width:100%;height:100%;display:none}
.nlp-pg-gpu-on .nlp-pg-gpu{display:block}
.nlp-pg-gpu-on .nlp-pg-fill{display:none}
.nlp-pg-gpu-on .nlp-pg-track{background:transparent;box-shadow:none}

.nlp-pg-run .nlp-pg-dot{background:var(--nlp-accent,#e67e22);box-shadow:0 0 0 3px color-mix(in srgb,var(--nlp-accent,#e67e22) 25%,transparent);animation:nlp-pg-pulse 1.6s ease-in-out infinite}
@keyframes nlp-pg-pulse{50%{box-shadow:0 0 0 5px color-mix(in srgb,var(--nlp-accent,#e67e22) 8%,transparent)}}
.nlp-pg-ok .nlp-pg-dot,.nlp-pg-ok .nlp-pg-fill{background:#3fb950}
.nlp-pg-err .nlp-pg-dot,.nlp-pg-err .nlp-pg-fill{background:#e5534b}
.nlp-pg-warn .nlp-pg-dot,.nlp-pg-warn .nlp-pg-fill{background:#d29922}
.nlp-pg-err .nlp-pg-label{color:#e5534b}

@media (prefers-reduced-motion:reduce){
  .nlp-pg *{animation:none !important}
  .nlp-pg-ind .nlp-pg-fill{left:0}
}

/* extra rows in the panel's settings menu */
.nlp-menu-sep{height:1px;margin:3px 0;background:var(--nlp-border,#3a3a3a)}
.nlp-menu-label{padding:4px 10px 1px;font-size:9px;letter-spacing:.07em;text-transform:uppercase;color:var(--nlp-dim,#8a8a8a)}
.nlp-menu-note{margin-left:auto;padding-left:12px;font-size:10px;color:var(--nlp-dim,#8a8a8a)}
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
const clamp01 = (v) => Math.max(0, Math.min(1, v));

function fmtDur(ms) {
    if (!Number.isFinite(ms) || ms < 0) return "\u2014";
    const s = ms / 1000;
    if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
    return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

function nodeTitle(id) {
    try {
        const last = String(id).split(":").pop();
        const n = app.graph?.getNodeById?.(Number(last));
        return n?.title || n?.type || `Node ${id}`;
    } catch {
        return `Node ${id}`;
    }
}

// ---------------------------------------------------------------------------------------------
// WebGPU: one full-screen triangle, everything is drawn in the fragment shader.
// ---------------------------------------------------------------------------------------------
const WGSL = /* wgsl */ `
struct U {
  res : vec2<f32>,
  progress : f32,
  time : f32,
  accent : vec4<f32>,
  track : vec4<f32>,
  mode : f32,
  calm : f32,
  pad0 : f32,
  pad1 : f32,
};
@group(0) @binding(0) var<uniform> u : U;

struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) uv : vec2<f32>,
};

@vertex
fn vs(@builtin(vertex_index) i : u32) -> VSOut {
  var p = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(3.0, -1.0),
    vec2<f32>(-1.0, 3.0)
  );
  var o : VSOut;
  let q = p[i];
  o.pos = vec4<f32>(q, 0.0, 1.0);
  o.uv = vec2<f32>(q.x * 0.5 + 0.5, 0.5 - q.y * 0.5);
  return o;
}

fn rrect(p : vec2<f32>, b : vec2<f32>, r : f32) -> f32 {
  let q = abs(p) - b + vec2<f32>(r, r);
  return min(max(q.x, q.y), 0.0) + length(max(q, vec2<f32>(0.0, 0.0))) - r;
}

@fragment
fn fs(v : VSOut) -> @location(0) vec4<f32> {
  let hs = u.res * 0.5;
  let d = rrect(v.uv * u.res - hs, hs, hs.y);
  let shape = 1.0 - smoothstep(-0.8, 0.8, d);

  let x = v.uv.x;
  let y = v.uv.y;
  let t = u.time;

  var fillMask = 0.0;
  var shade = 1.0;
  var sheen = 0.0;
  var glow = 0.0;

  if (u.mode > 0.5) {
    // unknown length: a soft block gliding left to right
    let pos = fract(t * 0.42) * 1.5 - 0.25;
    fillMask = 1.0 - smoothstep(0.0, 0.22, abs(x - pos));
    glow = fillMask * 0.2;
  } else {
    let edge = 1.5 / u.res.x;
    fillMask = (1.0 - smoothstep(u.progress - edge, u.progress + edge, x)) * step(0.0005, u.progress);
    shade = mix(0.72, 1.0, clamp(x / max(u.progress, 0.0001), 0.0, 1.0));
    if (u.calm < 0.5) {
      let band = 0.5 + 0.5 * sin((x - t * 0.5) * 6.2831853);
      sheen = pow(band, 10.0) * 0.22 * fillMask;
    }
    let dist = (x - u.progress) * u.res.x;
    glow = exp(-abs(dist) / 8.0) * 0.18 * step(0.0001, u.progress);
  }

  let hi = (1.0 - y) * 0.12;
  let fillCol = u.accent.rgb * shade + vec3<f32>(sheen + hi * fillMask);
  var col = mix(u.track.rgb, fillCol, fillMask);
  col = col + u.accent.rgb * glow * (1.0 - fillMask);

  // premultiplied alpha, clipped to the rounded track
  return vec4<f32>(col * shape, shape);
}
`;

// "rgb(...)", "rgba(...)" or "color(srgb r g b)" -> [r, g, b] in 0..1
function parseColor(str) {
    if (!str) return null;
    let m = str.match(/rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)/i);
    if (m) return [m[1] / 255, m[2] / 255, m[3] / 255];
    m = str.match(/color\(\s*srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/i);
    if (m) return [+m[1], +m[2], +m[3]];
    return null;
}

// ============================================================================
// createProgress: returns { el, setEnabled, setFx, renderer, destroy }
//   el          : DOM element to put in the panel
//   setEnabled  : attach / detach the ComfyUI event listeners (and the GPU device)
//   setFx       : "auto" (WebGPU when it works) | "dom"
//   renderer()  : "webgpu" | "dom" | "checking"
// ============================================================================
export function createProgress({ fx = "auto" } = {}) {
    ensureStyles();

    const root = $("div", "nlp-pg");
    root.style.display = "none";
    const row = $("div", "nlp-pg-row", root);
    const dot = $("span", "nlp-pg-dot", row);
    const label = $("span", "nlp-pg-label", row);
    const meta = $("span", "nlp-pg-meta", row);
    const track = $("div", "nlp-pg-track", root);
    const fill = $("div", "nlp-pg-fill", track);
    const canvas = $("canvas", "nlp-pg-gpu", track);
    const probe = $("span", null, root);
    probe.style.cssText = "position:absolute;visibility:hidden;pointer-events:none;width:0;height:0";

    // ---- run state ----
    let enabled = false;
    let mode = fx === "dom" ? "dom" : "auto";
    let st = "idle";                       // idle | run | ok | err | warn
    let runStart = 0, endMs = 0, lastRunMs = null, errText = "";
    let curNode = null, nodeText = "";
    let value = null, max = null;          // current node's own step counter
    let etaMs = null, pT0 = 0, pV0 = 0;
    let queued = 0;
    let target = 0, shown = 0;             // 0..1
    let doneTimer = null;

    const isDet = () => value != null && max != null && max > 1;

    // ---- colours (GPU path only; the DOM path uses CSS variables directly) ----
    let colAccent = [0.9, 0.49, 0.13], colTrack = [0.07, 0.07, 0.07], calm = 0, colAt = 0;
    const STATE_RGB = { ok: [0.25, 0.73, 0.31], err: [0.9, 0.33, 0.29], warn: [0.82, 0.6, 0.13] };
    function cssRGB(varName) {
        try {
            probe.style.color = `var(${varName})`;
            return parseColor(getComputedStyle(probe).color);
        } catch { return null; }
    }
    function refreshColors() {
        colAt = performance.now();
        colAccent = STATE_RGB[st] || cssRGB("--nlp-accent") || colAccent;
        colTrack = cssRGB("--nlp-input") || colTrack;
        try { calm = matchMedia("(prefers-reduced-motion: reduce)").matches ? 1 : 0; } catch { calm = 0; }
    }

    // ---- text / classes ----
    function setMeta(parts) {
        const nodes = [];
        parts.forEach((p, i) => {
            if (i) {
                const sep = $("i");
                sep.textContent = "\u00B7";
                nodes.push(sep);
            }
            const e = $(p.strong ? "b" : "span");
            e.textContent = p.t;
            nodes.push(e);
        });
        meta.replaceChildren(...nodes);
    }
    function paintText() {
        const now = performance.now();
        const q = queued > 0 ? [{ t: `+${queued} queued` }] : [];
        if (st === "run") {
            label.textContent = nodeText || "Running";
            if (isDet()) {
                const parts = [{ t: `${Math.floor(clamp01(value / max) * 100)}%`, strong: true }, { t: `${value}/${max}` }];
                if (etaMs != null && Number.isFinite(etaMs)) parts.push({ t: `ETA ${fmtDur(etaMs)}` });
                setMeta(parts.concat(q));
            } else {
                setMeta([{ t: fmtDur(now - runStart), strong: true }].concat(q));
            }
        } else if (st === "ok") {
            label.textContent = "Done";
            setMeta([{ t: fmtDur(endMs - runStart), strong: true }].concat(q));
        } else if (st === "err") {
            label.textContent = errText || "Failed";
            setMeta([{ t: fmtDur(endMs - runStart) }].concat(q));
        } else if (st === "warn") {
            label.textContent = "Interrupted";
            setMeta([{ t: fmtDur(endMs - runStart) }].concat(q));
        } else {
            label.textContent = "Idle";
            setMeta((lastRunMs != null ? [{ t: `Last run ${fmtDur(lastRunMs)}` }] : []).concat(q));
        }
    }
    function paintClasses() {
        root.classList.toggle("nlp-pg-run", st === "run");
        root.classList.toggle("nlp-pg-ok", st === "ok");
        root.classList.toggle("nlp-pg-err", st === "err");
        root.classList.toggle("nlp-pg-warn", st === "warn");
        root.classList.toggle("nlp-pg-ind", st === "run" && !isDet());
        if (!useGpu()) fill.style.width = `${(target * 100).toFixed(2)}%`;
    }
    function repaint() {
        if (st === "run") target = isDet() ? clamp01(value / max) : 0;
        else if (st === "ok") target = 1;
        else if (st === "idle") target = 0;
        refreshColors();
        paintClasses();
        paintText();
        wake();
    }

    // ---- events ----
    function begin() {
        clearTimeout(doneTimer);
        st = "run";
        runStart = performance.now();
        endMs = 0; errText = "";
        value = max = null; etaMs = null; pT0 = 0;
        curNode = null; nodeText = "";
        target = 0; shown = 0;
    }
    function finish(kind, text) {
        if (st !== "run") return;
        st = kind;
        endMs = performance.now();
        errText = text || "";
        if (kind === "ok") {
            lastRunMs = endMs - runStart;
            doneTimer = setTimeout(() => { if (st === "ok") { st = "idle"; repaint(); } }, 6000);
        }
        repaint();
    }

    const handlers = {
        execution_start() { begin(); repaint(); },
        executing(e) {
            let id = e.detail;
            if (id && typeof id === "object") id = id.display_node ?? id.node ?? null;
            if (id == null) { finish("ok"); return; }                // null = the whole prompt finished
            if (st !== "run") begin();
            curNode = id;
            nodeText = nodeTitle(id);
            value = max = null; etaMs = null; pT0 = 0;
            repaint();
        },
        progress(e) {
            const d = e.detail || {};
            const v = Number(d.value), m = Number(d.max);
            if (!(m > 0) || !Number.isFinite(v)) return;
            if (st !== "run") begin();
            if (d.node != null && String(d.node) !== String(curNode)) {
                curNode = d.node;
                nodeText = nodeTitle(d.node);
                pT0 = 0;
            }
            value = v; max = m;
            const now = performance.now();
            if (!pT0 || v < pV0) { pT0 = now; pV0 = v; etaMs = null; }
            else if (v > pV0) etaMs = (m - v) * ((now - pT0) / (v - pV0));
            if (v >= m) etaMs = 0;
            repaint();
        },
        execution_success() { finish("ok"); },
        execution_error(e) {
            const d = e.detail || {};
            finish("err", d.node_type ? `Error in ${d.node_type}` : "Error");
        },
        execution_interrupted() { finish("warn"); },
        status(e) {
            const n = e.detail?.exec_info?.queue_remaining;
            queued = Number.isFinite(n) ? Math.max(0, n - (st === "run" ? 1 : 0)) : 0;
            paintText();
        },
    };

    // ---- WebGPU ----
    let gpu = null, gpuState = "idle";     // idle | init | ready | failed
    const useGpu = () => mode === "auto" && gpuState === "ready";

    function applyRenderer() {
        root.classList.toggle("nlp-pg-gpu-on", useGpu());
        track.title = useGpu() ? "Drawn with WebGPU" : "Drawn with DOM";
        paintClasses();
    }
    function dropGpu() {
        const g = gpu;
        gpu = null;
        if (g) { try { g.ctx.unconfigure(); } catch {} try { g.device.destroy(); } catch {} }
        gpuState = "idle";
    }
    function loseGpu(why) {
        console.warn("nougan-live-panel: WebGPU progress bar disabled, using DOM.", why || "");
        dropGpu();
        gpuState = "failed";
        applyRenderer();
    }
    async function initGpu() {
        if (gpuState !== "idle") return;
        gpuState = "init";
        let device = null;
        try {
            if (!navigator.gpu) throw new Error("WebGPU not available");
            const adapter = await navigator.gpu.requestAdapter();
            if (!adapter) throw new Error("no GPU adapter");
            device = await adapter.requestDevice();
            const ctx = canvas.getContext("webgpu");
            if (!ctx) throw new Error("no webgpu canvas context");
            const format = navigator.gpu.getPreferredCanvasFormat();
            ctx.configure({ device, format, alphaMode: "premultiplied" });

            device.pushErrorScope("validation");
            const module = device.createShaderModule({ code: WGSL });
            const ubo = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
            const pipe = device.createRenderPipeline({
                layout: "auto",
                vertex: { module, entryPoint: "vs" },
                fragment: { module, entryPoint: "fs", targets: [{ format }] },
                primitive: { topology: "triangle-list" },
            });
            const bind = device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: ubo } }] });
            const err = await device.popErrorScope();
            if (err) throw new Error(err.message || "shader validation failed");

            if (!enabled || mode !== "auto") { device.destroy(); gpuState = "idle"; return; }   // switched off while starting
            device.lost.then(() => { if (gpu && gpu.device === device) loseGpu("device lost"); });
            device.addEventListener?.("uncapturedError", (ev) => { if (gpu && gpu.device === device) loseGpu(ev.error?.message); });
            gpu = { device, ctx, pipe, bind, ubo, data: new Float32Array(16) };
            gpuState = "ready";
            applyRenderer();
            repaint();
        } catch (e) {
            try { device?.destroy(); } catch {}
            gpu = null;
            gpuState = "failed";
            console.info("nougan-live-panel: progress bar uses DOM (", e?.message || e, ")");
            applyRenderer();
        }
    }
    function drawGpu(now) {
        if (!gpu || !useGpu()) return;
        const dpr = window.devicePixelRatio || 1;
        const w = Math.round(track.clientWidth * dpr), h = Math.round(track.clientHeight * dpr);
        if (w < 2 || h < 2) return;
        if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
        const d = gpu.data;
        d[0] = w; d[1] = h; d[2] = shown; d[3] = (now / 1000) % 100;   // 100 s is a whole number of cycles for every animation, so the wrap is seamless
        d[4] = colAccent[0]; d[5] = colAccent[1]; d[6] = colAccent[2]; d[7] = 1;
        d[8] = colTrack[0]; d[9] = colTrack[1]; d[10] = colTrack[2]; d[11] = 1;
        d[12] = st === "run" && !isDet() ? 1 : 0;
        d[13] = calm;
        try {
            const { device, ctx, pipe, bind, ubo } = gpu;
            device.queue.writeBuffer(ubo, 0, d);
            const enc = device.createCommandEncoder();
            const pass = enc.beginRenderPass({
                colorAttachments: [{ view: ctx.getCurrentTexture().createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: "clear", storeOp: "store" }],
            });
            pass.setPipeline(pipe);
            pass.setBindGroup(0, bind);
            pass.draw(3);
            pass.end();
            device.queue.submit([enc.finish()]);
        } catch (e) { loseGpu(e?.message); }
    }

    // ---- animation loop: runs only while something is moving ----
    let raf = null, lastText = 0;
    function wake() {
        if (enabled && raf == null) raf = requestAnimationFrame(frame);
    }
    function frame(now) {
        raf = null;
        if (!enabled) return;
        shown += (target - shown) * 0.18;
        if (Math.abs(target - shown) < 0.0005) shown = target;
        if (now - lastText > 250) { lastText = now; if (st === "run") paintText(); }
        if (now - colAt > 1000) refreshColors();
        drawGpu(now);
        const moving = st === "run" || shown !== target;
        if (moving) raf = requestAnimationFrame(frame);
    }

    const ro = new ResizeObserver(() => wake());
    ro.observe(track);

    // ---- public ----
    function setEnabled(on) {
        on = !!on;
        if (on === enabled) { root.style.display = on ? "" : "none"; return; }
        enabled = on;
        if (on) {
            for (const [name, fn] of Object.entries(handlers)) api.addEventListener(name, fn);
            root.style.display = "";
            refreshColors();
            applyRenderer();
            if (mode === "auto") initGpu();
            repaint();
        } else {
            for (const [name, fn] of Object.entries(handlers)) api.removeEventListener(name, fn);
            clearTimeout(doneTimer);
            if (raf != null) { cancelAnimationFrame(raf); raf = null; }
            dropGpu();
            st = "idle"; value = max = null; target = shown = 0; queued = 0;
            applyRenderer();
            root.style.display = "none";
        }
    }
    function setFx(next) {
        mode = next === "dom" ? "dom" : "auto";
        if (mode === "dom") dropGpu();
        else if (gpuState === "failed") gpuState = "idle";       // explicit retry
        applyRenderer();
        if (enabled && mode === "auto") initGpu();
        repaint();
    }
    const renderer = () => (useGpu() ? "webgpu" : mode === "auto" && gpuState === "init" ? "checking" : "dom");
    function destroy() {
        setEnabled(false);
        ro.disconnect();
        root.remove();
    }

    paintText();
    return { el: root, setEnabled, setFx, renderer, destroy };
}
