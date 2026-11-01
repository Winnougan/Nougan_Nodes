// nougan-lora-loader-ui.js — Nougan Lora Loader frontend
// Visual redesign after rgthree's Power Lora Loader: compact flat rows
// (toggle · name · ‹ 1.00 › steppers), a "Toggle All" header with column labels,
// node-level Single / Model & Clip mode, and a plain "＋ Add LoRA" button.
// Original look re-implemented from scratch (no rgthree code).
//
//  • DOM for structure & interaction; WebGPU draws the strength-bar fills
//    (one shared device, per-bar canvas), DOM gradient fallback like the
//    Live Panel progress bar.
//  • drag a stepper to scrub · click the value to type · Alt+click = 1.00
//    · Shift = fine · wheel = ±0.05 · ‹ › step ±0.05
//  • right-click a row: toggle / move up / move down / remove
//  • hover the row for the ⠿ drag handle (reorder) and the ✕ (remove)
//  • picker: search, folder chips, favourites, click to add / remove, ↑↓ Enter
//
// Data model is unchanged (hidden `lora_data` JSON: on / name / model / clip /
// split), so nougan_lora_loader.py and the Live Panel keep working as before.
// `split` now follows the node-level "Show Strengths" property instead of a
// per-row toggle, like rgthree's Single Strength / Separate Model & Clip.

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_NAME = "NouganLoraLoader";
const DATA = "lora_data";
const WIDTH = 430;

const S_MIN = -2;      // visual range of the strength bars
const S_MAX = 2;       // (typing a value allows ±10)
const HARD = 10;
const STEP = 0.05;
const FAV_KEY = "nougan_lora_favorites";
const ROOT = "(root)";

// node-level strength mode (same property name / values as rgthree)
const PROP_SHOW = "Show Strengths";
const MODE_SINGLE = "Single Strength";
const MODE_SEPARATE = "Separate Model & Clip";


// ── helpers ────────────────────────────────────────────────────────────────

const norm = (f) => String(f ?? "").replaceAll("\\", "/");
const folderOf = (f) => { const n = norm(f), i = n.lastIndexOf("/"); return i < 0 ? ROOT : n.slice(0, i); };
const baseOf = (f) => { const n = norm(f); return n.slice(n.lastIndexOf("/") + 1); };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const fmt = (v) => (v < 0 ? "−" : "") + Math.abs(v).toFixed(2);
const alpha = (a, b) => a.localeCompare(b, undefined, { sensitivity: "base" });

const loadFav = () => { try { return new Set(JSON.parse(localStorage.getItem(FAV_KEY) || "[]")); } catch { return new Set(); } };
const saveFav = (s) => { try { localStorage.setItem(FAV_KEY, JSON.stringify([...s])); } catch { } };

let _files = null;   // null until the first successful fetch

async function loras(force = false) {
    if (_files == null || force) {
        try {
            const r = await api.fetchApi("/nougan/loras");
            const j = await r.json();
            _files = (j || []).map(e => typeof e === "string" ? e : e?.name).filter(Boolean);
        } catch (e) {
            console.warn("[Nougan Lora] list fetch failed", e);
        }
    }
    return _files || [];
}

const isMissing = (name) => _files != null && !_files.some(f => norm(f) === norm(name));

const isSep = (node) => node?.properties?.[PROP_SHOW] === MODE_SEPARATE;

function setMode(node, sep) {
    node.properties = node.properties || {};
    node.properties[PROP_SHOW] = sep ? MODE_SEPARATE : MODE_SINGLE;
    for (const e of node.__stack || []) {
        if (sep) { e.split = true; if (!Number.isFinite(e.clip)) e.clip = e.model; }
        else { e.split = false; e.clip = e.model; }
    }
    node.__lzCommit?.();
}

function toggleAll(node) {
    const st = node.__stack || [];
    const anyOff = st.some(e => !e.on);
    st.forEach(e => { e.on = anyOff; });
    node.__lzCommit?.();
}


// ── styles ─────────────────────────────────────────────────────────────────

let _styled = false;

function styles() {
    if (_styled) return;
    _styled = true;

    const s = document.createElement("style");
    s.textContent = `
.lz{--acc:#f5a524;--acc2:#ff7a18;--neg:#f0616d;
  font:12px/1.3 'Inter','Segoe UI',system-ui,sans-serif;color:#d8d8d8;user-select:none;box-sizing:border-box;
  width:100%;padding:2px 0 0}
.lz *{box-sizing:border-box}
.lz button{font:inherit;color:inherit}

/* ---------- column header (toggle all + labels), rgthree style ---------- */
.lz-cols{display:flex;align-items:center;gap:7px;height:18px;padding:0 8px 0 6px;margin-bottom:4px;
  font-size:10.5px;color:#9a9a9a}
.lz-cols-t{white-space:nowrap}
.lz-count{font-size:10px;color:#6f6f6f;font-variant-numeric:tabular-nums}
.lz-cl{flex:none;width:92px;text-align:center;white-space:nowrap;overflow:hidden}
.lz-sp{flex:1}
.lz-hbtn{flex:none;width:18px;height:16px;display:grid;place-items:center;cursor:pointer;border-radius:4px;
  color:#6f6f6f;font-size:11px;transition:color .12s,background .12s}
.lz-hbtn:hover{color:#eee;background:#3a3a3a}
.lz-hbtn.on{color:var(--acc)}
.lz-hbtn.warn{color:#fff;background:#b33}

/* ---------- toggle pill ---------- */
.lz-tgl{flex:none;width:26px;height:14px;border-radius:99px;background:#3d3d3d;position:relative;cursor:pointer;
  transition:background .15s}
.lz-tgl::after{content:"";position:absolute;top:2px;left:2px;width:10px;height:10px;border-radius:50%;
  background:#9a9a9a;transition:left .15s,background .15s}
.lz-tgl.on{background:#2e7d32}
.lz-tgl.on::after{left:14px;background:#e8f5e9}
.lz-tgl.mid{background:#7a5c1e}
.lz-tgl.mid::after{left:8px;background:#f0e0b8}

/* ---------- rows ---------- */
.lz-list{display:flex;flex-direction:column;gap:4px}

.lz-row{position:relative;display:flex;align-items:center;gap:7px;height:24px;padding:0 8px 0 6px;
  background:#2a2a2a;border-radius:5px;transition:background .12s,opacity .12s}
.lz-row:hover{background:#313131}
.lz-row.off{opacity:.45}
.lz-row.drag{opacity:.55;box-shadow:0 6px 18px rgba(0,0,0,.5)}
.lz-row.over-t::before,.lz-row.over-b::after{content:"";position:absolute;left:2px;right:2px;height:2px;
  border-radius:1px;background:var(--acc)}
.lz-row.over-t::before{top:-3px}.lz-row.over-b::after{bottom:-3px}

.lz-nm{flex:1;min-width:0;display:flex;align-items:center;gap:6px;height:100%;cursor:pointer}
.lz-grip{flex:none;width:10px;text-align:center;color:#666;cursor:grab;font-size:12px;letter-spacing:-2px;
  opacity:0;transition:opacity .12s;touch-action:none}
.lz-row:hover .lz-grip{opacity:.9}
.lz-grip:active{cursor:grabbing}
.lz-txt{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}
.lz-txt .dir{color:#8a8a8a;font-size:10.5px}
.lz-row:hover .lz-txt .fn{color:#fff}
.lz-row.off .lz-txt .fn{text-decoration:line-through}
.lz-miss{flex:none;font-size:8.5px;font-weight:800;letter-spacing:.08em;color:#fff;background:#b3383e;
  border-radius:3px;padding:1px 4px}
.lz-rowx{flex:none;width:16px;height:16px;display:grid;place-items:center;cursor:pointer;border-radius:4px;
  color:#777;font-size:12px;opacity:0;transition:opacity .12s,color .12s,background .12s}
.lz-row:hover .lz-rowx{opacity:1}
.lz-rowx:hover{color:#fff;background:#b3383e}

/* ---------- strength stepper: ‹ 1.00 › ---------- */
.lz-st{position:relative;flex:none;width:92px;height:20px;border-radius:4px;background:#161616;
  border:1px solid #363636;overflow:hidden;cursor:ew-resize;touch-action:none;transition:border-color .12s}
.lz-st:hover{border-color:#4c4c4c}
.lz-gpu{position:absolute;inset:0;width:100%;height:100%;z-index:0;pointer-events:none}
.lz-fill{position:absolute;top:0;bottom:0;z-index:0;pointer-events:none;
  background:linear-gradient(90deg,rgba(245,165,36,.35),rgba(255,122,24,.75))}
.lz-fill.neg{background:linear-gradient(90deg,rgba(240,97,109,.8),rgba(240,97,109,.3))}
.lz-row.off .lz-fill{opacity:.35}
.lz-tick{position:absolute;top:2px;bottom:2px;width:1px;background:rgba(255,255,255,.12);pointer-events:none;z-index:1}
.lz-tick.z{background:rgba(255,255,255,.26)}
.lz-val{position:absolute;inset:0;z-index:2;display:flex;align-items:center;justify-content:center;
  font-size:11.5px;font-weight:700;font-variant-numeric:tabular-nums;color:#eee;
  text-shadow:0 1px 2px rgba(0,0,0,.8);pointer-events:none}
.lz-val.hard{color:var(--acc)}
.lz-ar{position:absolute;top:0;bottom:0;width:16px;z-index:2;display:grid;place-items:center;font-size:13px;
  color:#8a8a8a;opacity:.55;cursor:pointer;transition:opacity .12s,color .12s}
.lz-st:hover .lz-ar{opacity:1}
.lz-ar:hover{color:#fff}
.lz-ar.l{left:0}.lz-ar.r{right:0}
.lz-in{position:absolute;inset:0;width:100%;height:100%;z-index:3;background:#0b0b0b;color:#eee;border:0;
  outline:1px solid var(--acc);border-radius:4px;text-align:center;font:700 11.5px 'Inter',sans-serif}

/* ---------- add button (flat, rgthree-like) ---------- */
.lz-add{margin-top:6px;width:100%;height:24px;border-radius:5px;cursor:pointer;font-weight:600;font-size:11.5px;
  color:#bdbdbd;background:#2a2a2a;border:1px solid #3a3a3a;transition:background .12s,color .12s,border-color .12s}
.lz-add:hover{background:#343434;color:#fff;border-color:#4a4a4a}

/* ---------- picker ---------- */
.lzp{position:fixed;z-index:10020;width:430px;max-width:94vw;max-height:72vh;display:flex;flex-direction:column;
  background:#1b1b1b;color:#e8e8e8;border:1px solid #3a3a3a;border-radius:10px;
  box-shadow:0 18px 50px rgba(0,0,0,.7);font:12px 'Inter','Segoe UI',system-ui,sans-serif;user-select:none;overflow:hidden}
.lzp *{box-sizing:border-box}
.lzp button{font:inherit;color:inherit}
.lzp-h{display:flex;align-items:center;gap:8px;padding:10px 12px 6px}
.lzp-h .t{font-weight:700;letter-spacing:.1em;font-size:11px}
.lzp-h .c{font-size:10px;color:#8a8a8a}
.lzp-h .sp{flex:1}
.lzp-x{cursor:pointer;color:#8a8a8a;padding:0 4px;font-size:14px}.lzp-x:hover{color:#fff}
.lzp-s{padding:0 12px 8px}
.lzp-s input{width:100%;padding:7px 10px;border-radius:6px;background:#121212;color:inherit;border:1px solid #363636;
  font:inherit;outline:none}
.lzp-s input:focus{border-color:#f5a524;box-shadow:0 0 0 3px rgba(245,165,36,.15)}
.lzp-f{display:flex;flex-wrap:wrap;gap:5px;padding:0 12px 8px;max-height:64px;overflow:auto}
.lzp-fc{cursor:pointer;font-size:10.5px;padding:2px 9px;border-radius:99px;background:#242424;border:1px solid #363636;color:#a9a9a9;
  transition:all .12s}
.lzp-fc:hover{border-color:#6a5a2e;color:#ffd58a}
.lzp-fc.on{background:#f5a524;color:#1a1206;border-color:#c9821a;font-weight:700}
.lzp-l{flex:1;overflow:auto;padding:2px 6px 6px;border-top:1px solid #2a2a2a}
.lzp-it{display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:6px;cursor:pointer}
.lzp-it:hover,.lzp-it.hi{background:rgba(255,255,255,.07)}
.lzp-it.in{background:rgba(46,125,50,.18)}
.lzp-st{width:18px;text-align:center;font-size:15px;line-height:1;cursor:pointer;color:#555;transition:transform .12s,color .12s}
.lzp-st:hover{color:#ffd58a;transform:scale(1.2)}.lzp-st.on{color:#f5c518}
.lzp-ck{flex:none;width:15px;height:15px;border-radius:4px;border:1.5px solid #4a4a4a;display:grid;place-items:center;
  font-size:10px;color:transparent;transition:all .12s}
.lzp-it.in .lzp-ck{background:#2e7d32;border-color:#2e7d32;color:#e8f5e9;font-weight:900}
.lzp-nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lzp-nm .dir{color:#7d7d7d;font-size:10.5px}
.lzp-nm .fn{font-weight:600}
.lzp-sep{border:none;border-top:1px solid #2a2a2a;margin:5px 8px}
.lzp-em{padding:18px;text-align:center;color:#7d7d7d}
.lzp-ft{display:flex;align-items:center;gap:8px;padding:8px 12px;border-top:1px solid #2a2a2a;background:#161616}
.lzp-ft .h{flex:1;font-size:10px;color:#6c6c6c}
.lzp-done{cursor:pointer;padding:5px 16px;border-radius:6px;font-weight:700;font-size:11px;letter-spacing:.08em;
  text-transform:uppercase;color:#e8e8e8;background:#2a2a2a;border:1px solid #3a3a3a}
.lzp-done:hover{background:#343434;color:#fff}
`;
    document.head.appendChild(s);
}


// ── WebGPU strength fills (shared device, per-bar canvas, DOM fallback) ─────
// Same pattern as the Live Panel progress bar: one fragment shader draws the
// fill (gradient from center, edge glow), DOM keeps the track, ticks, text and
// interaction. If WebGPU is missing, fails or the device is lost, every bar
// silently falls back to its CSS gradient fill.

const WGSL = /* wgsl */ `
struct U {
  res : vec2<f32>,
  pos : f32,          // value mapped to 0..1 over the visual range
  neg : f32,          // 1 when value < 0
  offA : f32,         // alpha multiplier (row disabled -> 0.35)
  hard : f32,         // 1 when |value| is beyond the visual range
  pad0 : f32,
  pad1 : f32,
  cA : vec4<f32>,     // amber
  cB : vec4<f32>,     // orange
  cN : vec4<f32>,     // red (negative)
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
  o.pos = vec4<f32>(q, 0.0, 0.0, 1.0);
  o.uv = vec2<f32>(q.x * 0.5 + 0.5, 0.5 - q.y * 0.5);
  return o;
}

@fragment
fn fs(v : VSOut) -> @location(0) vec4<f32> {
  let x = v.uv.x;
  let lo = min(u.pos, 0.5);
  let hi = max(u.pos, 0.5);
  let fill = step(lo, x) * step(x, hi) * step(0.0005, hi - lo);

  let t = clamp((x - lo) / max(hi - lo, 0.0001), 0.0, 1.0);
  var col = mix(u.cA.rgb, u.cB.rgb, t);
  if (u.neg > 0.5) { col = mix(u.cN.rgb * 0.55, u.cN.rgb, 1.0 - t); }
  if (u.hard > 0.5) { col = mix(col, vec3<f32>(1.0), 0.25); }

  // soft glow at the leading edge of the fill
  let dpx = (x - u.pos) * u.res.x;
  let glow = exp(-abs(dpx) / 6.0) * 0.3 * step(0.0005, hi - lo);
  col += mix(u.cB.rgb, u.cN.rgb, u.neg) * glow;

  // gentle top highlight
  col += (1.0 - v.uv.y) * 0.12 * fill;

  let a = fill * u.offA;
  return vec4<f32>(col * a, a);   // premultiplied
}
`;

const GPU = { state: "idle", device: null, pipeline: null, format: null, bars: new Set() };
// amber -> orange, red for negatives (matches the DOM gradient)
const COL_A = [0.96, 0.65, 0.14, 1], COL_B = [1.0, 0.48, 0.09, 1], COL_N = [0.94, 0.38, 0.43, 1];

function gpuFail(why) {
    console.info("[Nougan Lora] strength bars use DOM (", why || "WebGPU unavailable", ")");
    GPU.state = "failed";
    GPU.device = null;
    GPU.pipeline = null;
    for (const b of GPU.bars) b.detachGpu();
}

async function gpuInit() {
    if (GPU.state !== "idle") return;
    GPU.state = "init";
    let device = null;
    try {
        if (!navigator.gpu) throw new Error("WebGPU not available");
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) throw new Error("no GPU adapter");
        device = await adapter.requestDevice();
        const format = navigator.gpu.getPreferredCanvasFormat();

        device.pushErrorScope("validation");
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
        const err = await device.popErrorScope();
        if (err) throw new Error(err.message || "shader validation failed");

        device.lost.then(() => { if (GPU.device === device) gpuFail("device lost"); });
        GPU.device = device;
        GPU.pipeline = pipeline;
        GPU.format = format;
        GPU.state = "ready";
        for (const b of GPU.bars) b.attachGpu();
    } catch (e) {
        try { device?.destroy(); } catch { }
        gpuFail(e?.message || e);
    }
}

// One strength stepper: ‹ 1.00 ›. DOM interaction, WebGPU or CSS fill.
class Bar {
    // get() -> number; set(v) writes the entry; onTouch() commits the JSON
    constructor(get, set, onTouch) {
        this.get = get;
        this.set = set;
        this.onTouch = onTouch;

        const el = document.createElement("div");
        el.className = "lz-st";
        el.title = "Drag to scrub · click value to type · Alt+click = 1.00 · Shift = fine · wheel = ±0.05";
        el.innerHTML = `
            <div class="lz-fill"></div>
            <div class="lz-tick" style="left:${((1 - S_MIN) / (S_MAX - S_MIN)) * 100}%"></div>
            <div class="lz-tick z" style="left:50%"></div>
            <span class="lz-val"></span>
            <span class="lz-ar l">‹</span><span class="lz-ar r">›</span>`;
        this.el = el;
        this.fill = el.querySelector(".lz-fill");
        this.val = el.querySelector(".lz-val");

        el.querySelector(".lz-ar.l").addEventListener("click", (e) => {
            e.stopPropagation();
            this.put(this.get() - (e.shiftKey ? 0.01 : STEP));
        });
        el.querySelector(".lz-ar.r").addEventListener("click", (e) => {
            e.stopPropagation();
            this.put(this.get() + (e.shiftKey ? 0.01 : STEP));
        });

        el.addEventListener("pointerdown", (e) => this.onDown(e));
        el.addEventListener("wheel", (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.put(this.get() + (e.deltaY < 0 ? 1 : -1) * (e.shiftKey ? 0.01 : STEP));
        }, { passive: false });

        if (typeof ResizeObserver !== "undefined") {
            this.ro = new ResizeObserver(() => this.paint());
            this.ro.observe(el);
        }

        GPU.bars.add(this);
        if (GPU.state === "ready") this.attachGpu();
        else if (GPU.state === "idle") gpuInit();

        this.paint();
    }

    put(v) {
        v = clamp(Math.round(v * 100) / 100, -HARD, HARD);
        this.set(v);
        this.paint();
        this.onTouch();
    }

    onDown(e) {
        if (e.target.closest(".lz-ar") || e.target.closest(".lz-in")) return;
        if (e.altKey) { this.put(1); return; }

        const el = this.el;
        el.setPointerCapture(e.pointerId);
        const startX = e.clientX, startV = this.get();
        let moved = false;

        const mv = (ev) => {
            const dx = ev.clientX - startX;
            if (!moved && Math.abs(dx) < 3) return;
            moved = true;
            this.put(startV + dx * (ev.shiftKey ? 0.005 : STEP));
        };
        const up = (ev) => {
            el.removeEventListener("pointermove", mv);
            el.removeEventListener("pointerup", up);
            el.removeEventListener("pointercancel", up);
            if (!moved && !ev.target.closest(".lz-ar")) this.edit();
        };
        el.addEventListener("pointermove", mv);
        el.addEventListener("pointerup", up);
        el.addEventListener("pointercancel", up);
    }

    edit() {
        if (this.el.querySelector(".lz-in")) return;
        const inp = document.createElement("input");
        inp.className = "lz-in";
        inp.value = String(this.get());
        this.el.appendChild(inp);
        inp.focus();
        inp.select();

        let done = false;
        const finish = (ok) => {
            if (done) return;
            done = true;
            if (ok) {
                const n = parseFloat(inp.value.replace("−", "-"));
                if (Number.isFinite(n)) this.put(n);
            }
            inp.remove();
        };
        inp.addEventListener("keydown", (ev) => {
            ev.stopPropagation();
            if (ev.key === "Enter") finish(true);
            else if (ev.key === "Escape") finish(false);
        });
        inp.addEventListener("keyup", (ev) => ev.stopPropagation());
        inp.addEventListener("blur", () => finish(true));
    }

    // ---- painting ----
    paint() {
        const v = this.get();
        const pos = clamp((v - S_MIN) / (S_MAX - S_MIN), 0, 1);
        const hard = v > S_MAX || v < S_MIN;
        this.val.textContent = fmt(v);
        this.val.classList.toggle("hard", hard);
        if (this.gCtx) this.paintGpu(v, pos, hard);
        else this.paintDom(v, pos);
    }

    paintDom(v, pos) {
        this.fill.className = "lz-fill" + (v < 0 ? " neg" : "");
        this.fill.style.left = (Math.min(pos, 0.5) * 100) + "%";
        this.fill.style.width = (Math.abs(pos - 0.5) * 100) + "%";
    }

    attachGpu() {
        if (this.gCtx || GPU.state !== "ready") return;
        try {
            const canvas = document.createElement("canvas");
            canvas.className = "lz-gpu";
            const ctx = canvas.getContext("webgpu");
            if (!ctx) return;
            ctx.configure({ device: GPU.device, format: GPU.format, alphaMode: "premultiplied" });
            const ubo = GPU.device.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
            const bind = GPU.device.createBindGroup({
                layout: GPU.pipeline.getBindGroupLayout(0),
                entries: [{ binding: 0, resource: { buffer: ubo } }],
            });
            this.el.insertBefore(canvas, this.el.firstChild);
            this.gCanvas = canvas;
            this.gCtx = ctx;
            this.gUbo = ubo;
            this.gBind = bind;
            this.gData = new Float32Array(20);
            this.fill.style.display = "none";
            this.paint();
        } catch (e) {
            this.detachGpu();
        }
    }

    detachGpu() {
        if (this.gCtx) { try { this.gCtx.unconfigure(); } catch { } }
        try { this.gUbo?.destroy(); } catch { }
        this.gCanvas?.remove();
        this.gCtx = this.gCanvas = this.gUbo = this.gBind = this.gData = null;
        if (this.fill) this.fill.style.display = "";
        this.paint();
    }

    paintGpu(v, pos, hard) {
        const canvas = this.gCanvas;
        const dpr = window.devicePixelRatio || 1;
        const w = Math.round((canvas.clientWidth || 92) * dpr), h = Math.round((canvas.clientHeight || 20) * dpr);
        if (w < 2 || h < 2) return;
        if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }

        const off = this.el.closest(".lz-row")?.classList.contains("off");
        const d = this.gData;
        d[0] = w; d[1] = h; d[2] = pos; d[3] = v < 0 ? 1 : 0;
        d[4] = off ? 0.35 : 1; d[5] = hard ? 1 : 0; d[6] = 0; d[7] = 0;
        d.set(COL_A, 8); d.set(COL_B, 12); d.set(COL_N, 16);

        try {
            const device = GPU.device;
            device.queue.writeBuffer(this.gUbo, 0, d);
            const enc = device.createCommandEncoder();
            const pass = enc.beginRenderPass({
                colorAttachments: [{
                    view: this.gCtx.getCurrentTexture().createView(),
                    clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: "clear", storeOp: "store",
                }],
            });
            pass.setPipeline(GPU.pipeline);
            pass.setBindGroup(0, this.gBind);
            pass.draw(3);
            pass.end();
            device.queue.submit([enc.finish()]);
        } catch (e) {
            this.detachGpu();   // this bar falls back; others keep their own state
        }
    }

    dispose() {
        GPU.bars.delete(this);
        this.ro?.disconnect();
        if (this.gCtx) { try { this.gCtx.unconfigure(); } catch { } }
        try { this.gUbo?.destroy(); } catch { }
        this.gCtx = null;
    }
}


// ── picker popup ───────────────────────────────────────────────────────────

let _pop = null;

function closePicker() {
    _pop?.dispose();
    _pop = null;
}

// replaceIdx: null = multi-add / toggle mode, number = swap that row's LoRA and close
async function openPicker(node, ev, replaceIdx = null) {
    closePicker();
    styles();

    const files = await loras(true);
    const favs = loadFav();
    const folders = [...new Set(files.map(folderOf))].sort((a, b) =>
        a === ROOT ? -1 : b === ROOT ? 1 : alpha(a, b));

    let query = "", folder = null, hi = 0, visible = [];

    const el = document.createElement("div");
    el.className = "lzp";
    el.innerHTML = `
        <div class="lzp-h"><span class="t">${replaceIdx == null ? "ADD LORAS" : "SWAP LORA"}</span>
            <span class="c"></span><span class="sp"></span><span class="lzp-x">✕</span></div>
        <div class="lzp-s"><input placeholder="Search ${files.length} LoRAs…" spellcheck="false"></div>
        <div class="lzp-f"></div>
        <div class="lzp-l"></div>
        <div class="lzp-ft"><span class="h">${replaceIdx == null ? "click to add / remove · ↑↓ Enter · Esc" : "click a LoRA to swap it in"}</span>
            <button class="lzp-done">Done</button></div>`;

    const $ = (s) => el.querySelector(s);
    const list = $(".lzp-l"), input = $("input"), chips = $(".lzp-f");

    $(".lzp-x").onclick = closePicker;
    $(".lzp-done").onclick = closePicker;
    el.addEventListener("pointerdown", e => e.stopPropagation());

    const inStack = (f) => (node.__stack || []).some(e => norm(e.name) === norm(f));

    function drawChips() {
        chips.textContent = "";
        if (folders.length < 2) { chips.style.display = "none"; return; }

        const mk = (label, val) => {
            const c = document.createElement("span");
            c.className = "lzp-fc" + (folder === val ? " on" : "");
            c.textContent = label;
            c.onclick = () => { folder = val; hi = 0; drawChips(); draw(); };
            chips.appendChild(c);
        };

        mk("All", null);
        folders.forEach(f => mk(f === ROOT ? "root" : f, f));
    }

    function toggle(f) {
        if (replaceIdx != null) {
            const en = node.__stack[replaceIdx];
            if (en) en.name = f;
            node.__lzCommit();
            closePicker();
            return;
        }

        if (inStack(f)) {
            node.__stack = node.__stack.filter(e => norm(e.name) !== norm(f));
        } else {
            node.__stack.push(newEntry({ name: f }));
        }

        node.__lzCommit();

        const top = list.scrollTop;
        draw();
        list.scrollTop = top;
    }

    function draw() {
        list.textContent = "";

        const q = query.trim().toLowerCase();
        let pool = files.filter(f => (folder == null || folderOf(f) === folder) && (!q || f.toLowerCase().includes(q)));

        const fav = pool.filter(f => favs.has(f)).sort(alpha);
        const rest = pool.filter(f => !favs.has(f)).sort(alpha);
        visible = [...fav, ...rest];
        hi = clamp(hi, 0, Math.max(0, visible.length - 1));

        $(".c").textContent = `${(node.__stack || []).length} in stack`;

        if (!visible.length) {
            const e = document.createElement("div");
            e.className = "lzp-em";
            e.textContent = files.length ? "No matches." : "No LoRAs found in models/loras.";
            list.appendChild(e);
            return;
        }

        const item = (f, i) => {
            const row = document.createElement("div");
            row.className = "lzp-it" + (inStack(f) ? " in" : "") + (i === hi ? " hi" : "");
            row.dataset.i = i;

            const star = document.createElement("span");
            star.className = "lzp-st" + (favs.has(f) ? " on" : "");
            star.textContent = favs.has(f) ? "★" : "☆";
            star.onclick = (e) => {
                e.stopPropagation();
                favs.has(f) ? favs.delete(f) : favs.add(f);
                saveFav(favs);
                const top = list.scrollTop;
                draw();
                list.scrollTop = top;
            };
            row.appendChild(star);

            if (replaceIdx == null) {
                const ck = document.createElement("span");
                ck.className = "lzp-ck";
                ck.textContent = "✓";
                row.appendChild(ck);
            }

            const nm = document.createElement("span");
            nm.className = "lzp-nm";
            nm.title = f;
            const d = folderOf(f);
            nm.innerHTML = (d !== ROOT ? `<span class="dir"></span>` : "") + `<span class="fn"></span>`;
            if (d !== ROOT) nm.querySelector(".dir").textContent = d + "/";
            nm.querySelector(".fn").textContent = baseOf(f);
            row.appendChild(nm);

            row.onclick = () => toggle(f);
            return row;
        };

        fav.forEach((f, i) => list.appendChild(item(f, i)));
        if (fav.length && rest.length) {
            const hr = document.createElement("hr");
            hr.className = "lzp-sep";
            list.appendChild(hr);
        }
        rest.forEach((f, i) => list.appendChild(item(f, fav.length + i)));
    }

    input.addEventListener("input", () => { query = input.value; hi = 0; draw(); });

    const kd = (e) => {
        if (e.key === "Escape") { closePicker(); return; }
        if (!el.contains(document.activeElement) && document.activeElement !== document.body) return;

        const move = (d) => {
            e.preventDefault();
            hi = clamp(hi + d, 0, visible.length - 1);
            list.querySelectorAll(".lzp-it").forEach(r => r.classList.toggle("hi", Number(r.dataset.i) === hi));
            list.querySelector(".lzp-it.hi")?.scrollIntoView({ block: "nearest" });
        };

        if (e.key === "ArrowDown") move(1);
        else if (e.key === "ArrowUp") move(-1);
        else if (e.key === "Enter" && visible[hi]) { e.preventDefault(); toggle(visible[hi]); }
    };

    const pd = (e) => { if (!el.contains(e.target)) closePicker(); };

    drawChips();
    draw();

    document.body.appendChild(el);

    const x = ev?.clientX ?? innerWidth / 2;
    const y = ev?.clientY ?? innerHeight / 3;
    const r = el.getBoundingClientRect();
    el.style.left = Math.max(8, Math.min(x - 40, innerWidth - r.width - 8)) + "px";
    el.style.top = Math.max(8, Math.min(y + 8, innerHeight - r.height - 8)) + "px";

    setTimeout(() => {
        addEventListener("pointerdown", pd, true);
        addEventListener("keydown", kd, true);
        input.focus();
    }, 0);

    _pop = {
        dispose() {
            removeEventListener("pointerdown", pd, true);
            removeEventListener("keydown", kd, true);
            el.remove();
        },
    };
}


// ── data ───────────────────────────────────────────────────────────────────

const dataW = (n) => n.widgets?.find(w => w.name === DATA);

function hideWidget(w) {
    if (!w || w._lzHidden) return;
    w._lzHidden = true;

    const el = w.element || w.inputEl;
    if (el) { el.style.display = "none"; el.style.height = "0"; el.style.pointerEvents = "none"; }

    w.computeSize = () => [0, 0];
    w.draw = () => { };
}

const newEntry = (extra) => ({ on: true, name: "", model: 1, clip: 1, split: false, ...extra });

function sync(node) {
    const w = dataW(node);
    if (!w) return;

    const sep = isSep(node);
    w.value = JSON.stringify({
        loras: (node.__stack || []).map(e => ({
            on: e.on, name: e.name, model: e.model, clip: sep ? e.clip : e.model, split: sep,
        })),
    });

    node.__lzLast = w.value;   // what this node itself last wrote
}

function loadStack(node) {
    let stack = [];

    try {
        const p = JSON.parse(dataW(node)?.value || "{}");
        const raw = Array.isArray(p) ? p : (p.loras || []);
        const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

        stack = raw.filter(e => e && (e.name || e.lora)).map(e => {
            const m = e.strength != null ? num(e.strength, 1) : num(e.model, 1);
            const c = e.strength != null ? m : num(e.clip, m);

            return newEntry({
                on: e.on !== false,
                name: e.name || e.lora,
                model: m,
                clip: c,
                split: e.split != null ? !!e.split : Math.abs(c - m) > 1e-6,
            });
        });
    } catch { stack = []; }

    node.__stack = stack;
    node.__lzLast = dataW(node)?.value;

    // migration: older workflows had a per-row split toggle and no node property.
    // Derive the mode once, from the entries.
    node.properties = node.properties || {};
    if (!(PROP_SHOW in node.properties)) {
        node.properties[PROP_SHOW] = stack.some(e => e.split) ? MODE_SEPARATE : MODE_SINGLE;
    }
}

// Something other than this node (the Live Panel, a script...) changed `lora_data`.
// Reload the stack from it and redraw, so the node UI, the saved workflow and the run all agree.
function pullFromWidget(node) {
    const w = dataW(node);
    if (!w || typeof w.value !== "string" || w.value === node.__lzLast) return;

    try {
        const p = JSON.parse(w.value);
        if (!Array.isArray(p) && !Array.isArray(p?.loras)) return;   // not a stack: ignore
    } catch { return; }

    loadStack(node);
    node.__lzRender?.();
}


// ── panel ──────────────────────────────────────────────────────────────────

// Size the node to its real content: widget top (below the slots) + measured panel height.
// Doesn't rely on node.computeSize(), which can't see how tall the DOM panel actually is.
function fit(node) {
    requestAnimationFrame(() => {
        if (!node.graph) return;

        const ph = node.__lzPanel?.offsetHeight || 0;
        const dw = node.__lzDW;
        const slots = Math.max(node.inputs?.length || 0, node.outputs?.length || 0);
        const wy = (dw?.last_y > 0 ? dw.last_y : null) ?? (dw?.y > 0 ? dw.y : null) ?? (slots * 20 + 24);

        const h = ph > 0 ? wy + ph + 16 : node.computeSize()[1];

        if (Math.abs(h - node.size[1]) > 1) {
            node.setSize([Math.max(node.size[0], 340), h]);
        }

        node.setDirtyCanvas(true, true);
    });
}

function rowMenu(node, idx, ev) {
    const st = node.__stack || [];
    const en = st[idx];
    if (!en) return;
    const LM = window.LiteGraph;
    if (!LM?.ContextMenu) return;

    const items = [
        { content: en.name || "LoRA", disabled: true },
        null,
        {
            content: `${en.on ? "⚫ Toggle Off" : "🟢 Toggle On"}`,
            callback: () => { en.on = !en.on; node.__lzCommit(); },
        },
        {
            content: "⬆️ Move Up",
            disabled: idx <= 0,
            callback: () => { [st[idx - 1], st[idx]] = [st[idx], st[idx - 1]]; node.__lzCommit(); },
        },
        {
            content: "⬇️ Move Down",
            disabled: idx >= st.length - 1,
            callback: () => { [st[idx + 1], st[idx]] = [st[idx], st[idx + 1]]; node.__lzCommit(); },
        },
        null,
        {
            content: "🗑️ Remove",
            callback: () => { st.splice(idx, 1); node.__lzCommit(); },
        },
    ];
    new LM.ContextMenu(items, { event: ev, title: "LORA" });
}

function buildPanel(node) {
    styles();

    const root = document.createElement("div");
    root.className = "lz";
    root.innerHTML = `
        <div class="lz-cols">
            <span class="lz-tgl lz-all" title="Toggle all LoRAs on / off"></span>
            <span class="lz-cols-t">Toggle All</span>
            <span class="lz-count"></span>
            <span class="lz-hbtn lz-mode" title="Single strength ↔ separate Model &amp; Clip (also in the node's right-click menu)">⇄</span>
            <span class="lz-hbtn lz-clear" title="Remove all LoRAs">🗑</span>
            <span class="lz-sp"></span>
        </div>
        <div class="lz-list"></div>
        <button class="lz-add">＋ Add LoRA</button>`;

    const $ = (s) => root.querySelector(s);
    const cols = $(".lz-cols");
    const list = $(".lz-list");

    root.addEventListener("pointerdown", e => e.stopPropagation());

    const touch = () => { sync(node); node.setDirtyCanvas(true, true); };
    const commit = () => { sync(node); render(); node.setDirtyCanvas(true, true); };

    // bars recreated by render() must release their GPU canvas first
    const disposeBars = () => {
        for (const b of node.__lzBars || []) b.dispose();
        node.__lzBars = new Set();
    };
    node.__lzBars = new Set();

    function paintHeader() {
        const st = node.__stack || [];
        const on = st.filter(e => e.on).length;
        const tgl = $(".lz-all");
        tgl.classList.toggle("on", st.length > 0 && on === st.length);
        tgl.classList.toggle("mid", on > 0 && on < st.length);
        $(".lz-count").textContent = st.length ? `${on}/${st.length}` : "";
        $(".lz-mode").classList.toggle("on", isSep(node));

        // column labels, aligned over the steppers (same widths / gaps as the rows)
        cols.querySelectorAll(".lz-cl").forEach(e => e.remove());
        const sep = isSep(node);
        const labels = sep ? ["Model", "Clip"] : ["Strength"];
        for (const t of labels) {
            const l = document.createElement("span");
            l.className = "lz-cl";
            l.textContent = t;
            cols.appendChild(l);
        }
        cols.style.display = st.length ? "" : "none";
    }

    function startDrag(e, row, idx) {
        e.preventDefault();

        const grip = e.currentTarget;
        grip.setPointerCapture(e.pointerId);
        row.classList.add("drag");

        const rows = [...list.querySelectorAll(".lz-row")];
        let target = idx, after = false;

        const clear = () => rows.forEach(r => r.classList.remove("over-t", "over-b"));

        const mv = (ev) => {
            clear();

            const first = rows[0].getBoundingClientRect();
            const last = rows[rows.length - 1].getBoundingClientRect();

            if (ev.clientY < first.top) { target = 0; after = false; }
            else if (ev.clientY > last.bottom) { target = rows.length - 1; after = true; }
            else {
                for (let i = 0; i < rows.length; i++) {
                    const b = rows[i].getBoundingClientRect();
                    if (ev.clientY >= b.top - 2 && ev.clientY <= b.bottom + 2) {
                        target = i;
                        after = ev.clientY > b.top + b.height / 2;
                        break;
                    }
                }
            }

            rows[target].classList.add(after ? "over-b" : "over-t");
        };

        const up = () => {
            grip.removeEventListener("pointermove", mv);
            grip.removeEventListener("pointerup", up);
            grip.removeEventListener("pointercancel", up);

            clear();
            row.classList.remove("drag");

            let to = target + (after ? 1 : 0);
            if (to > idx) to--;

            if (to !== idx) {
                const [m] = node.__stack.splice(idx, 1);
                node.__stack.splice(to, 0, m);
                commit();
            }
        };

        grip.addEventListener("pointermove", mv);
        grip.addEventListener("pointerup", up);
        grip.addEventListener("pointercancel", up);
    }

    function renderRow(en, idx) {
        const row = document.createElement("div");
        row.className = "lz-row" + (en.on ? "" : " off");
        row.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); rowMenu(node, idx, e); });

        const tgl = document.createElement("span");
        tgl.className = "lz-tgl" + (en.on ? " on" : "");
        tgl.title = en.on ? "Enabled" : "Disabled";
        tgl.onclick = () => { en.on = !en.on; commit(); };
        row.appendChild(tgl);

        const nm = document.createElement("span");
        nm.className = "lz-nm";
        nm.title = en.name + "\n(click to swap · right-click for more)";

        const grip = document.createElement("span");
        grip.className = "lz-grip";
        grip.textContent = "⠿";
        grip.title = "Drag to reorder";
        grip.addEventListener("pointerdown", (e) => startDrag(e, row, idx));
        nm.appendChild(grip);

        const txt = document.createElement("span");
        txt.className = "lz-txt";
        const d = folderOf(en.name);
        if (d !== ROOT) {
            const ds = document.createElement("span");
            ds.className = "dir";
            ds.textContent = d + "/";
            txt.appendChild(ds);
        }
        const fs = document.createElement("span");
        fs.className = "fn";
        fs.textContent = baseOf(en.name);
        txt.appendChild(fs);
        nm.appendChild(txt);

        if (isMissing(en.name)) {
            const m = document.createElement("span");
            m.className = "lz-miss";
            m.textContent = "MISSING";
            m.title = "This file isn't in models/loras — it will be skipped.";
            nm.appendChild(m);
        }

        const x = document.createElement("span");
        x.className = "lz-rowx";
        x.textContent = "✕";
        x.title = "Remove";
        x.onclick = (e) => { e.stopPropagation(); node.__stack.splice(idx, 1); commit(); };
        nm.appendChild(x);

        nm.onclick = (ev) => { if (!ev.target.closest(".lz-grip") && !ev.target.closest(".lz-rowx")) openPicker(node, ev, idx); };
        row.appendChild(nm);

        // steppers, right-aligned like rgthree's number widgets
        const sep = isSep(node);
        const mk = (get, set) => {
            const b = new Bar(get, set, touch);
            node.__lzBars.add(b);
            return b.el;
        };
        if (sep) {
            row.appendChild(mk(() => en.model, v => { en.model = v; }));
            row.appendChild(mk(() => en.clip, v => { en.clip = v; }));
        } else {
            row.appendChild(mk(() => en.model, v => { en.model = v; en.clip = v; }));
        }

        return row;
    }

    function render() {
        disposeBars();
        const st = node.__stack || [];

        list.textContent = "";
        paintHeader();

        st.forEach((en, i) => list.appendChild(renderRow(en, i)));

        fit(node);
    }

    $(".lz-add").onclick = (ev) => openPicker(node, ev);

    $(".lz-all").onclick = () => toggleAll(node);
    $(".lz-mode").onclick = () => setMode(node, !isSep(node));

    let armed = null;
    $(".lz-clear").onclick = () => {
        const b = $(".lz-clear");

        if (!node.__stack.length) return;

        if (!armed) {
            b.classList.add("warn");
            b.textContent = "?";
            b.title = "Click again to confirm";
            armed = setTimeout(() => { armed = null; b.classList.remove("warn"); b.textContent = "🗑"; b.title = "Remove all LoRAs"; }, 2000);
            return;
        }

        clearTimeout(armed);
        armed = null;
        b.classList.remove("warn");
        b.textContent = "🗑";
        node.__stack = [];
        commit();
    };

    node.__lzRender = render;
    node.__lzCommit = commit;

    if (typeof ResizeObserver !== "undefined") new ResizeObserver(() => fit(node)).observe(root);

    return root;
}

function buildUI(node) {
    if (node.__lzBuilt) return;
    node.__lzBuilt = true;

    hideWidget(dataW(node));
    loadStack(node);

    const dw0 = dataW(node);
    if (dw0 && !dw0._lzCb) {
        dw0._lzCb = true;
        const prev = dw0.callback;
        dw0.callback = function () {
            const r = prev?.apply(this, arguments);
            try { pullFromWidget(node); } catch (e) { console.warn("[Nougan Lora] pull failed", e); }
            return r;
        };
    }

    const panel = buildPanel(node);

    // ComfyUI force-sets an inline height on the element handed to addDOMWidget.
    // Hand it a holder instead, so `panel` keeps its natural content height and we can measure it.
    const holder = document.createElement("div");
    holder.style.cssText = "width:100%;overflow:visible;";
    holder.appendChild(panel);

    const getH = () => Math.max(panel.offsetHeight + 4, 64);

    const dw = node.addDOMWidget("lz_panel", "div", holder, {
        serialize: false,
        getHeight: getH,
        getMinHeight: getH,
    });

    dw.serializeValue = () => undefined;
    dw.computeSize = (w) => [w, getH()];

    node.__lzPanel = panel;
    node.__lzDW = dw;

    node.__lzRender();

    // widget y / panel height settle after the first draw — re-fit a couple of times
    setTimeout(() => fit(node), 60);
    setTimeout(() => fit(node), 400);

    // learn which files exist so missing LoRAs get flagged
    loras().then(() => node.__lzRender?.());

    // WebGPU strength fills (silent DOM fallback if unavailable)
    gpuInit();
}


// ── extension ──────────────────────────────────────────────────────────────

app.registerExtension({
    name: "Nougan.LoraLoader",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData?.name !== NODE_NAME) return;

        nodeType.color = "#1a2a3a";
        nodeType.bgcolor = "#0f1923";

        const onc = nodeType.prototype.onNodeCreated;

        nodeType.prototype.onNodeCreated = function () {
            onc?.apply(this, arguments);
            this.size = [WIDTH, 140];
            this.properties = this.properties || {};
            if (!(PROP_SHOW in this.properties)) this.properties[PROP_SHOW] = MODE_SINGLE;

            try { buildUI(this); } catch (e) { console.warn("[Nougan Lora] UI build failed", e); }
        };

        const ocf = nodeType.prototype.onConfigure;

        nodeType.prototype.onConfigure = function () {
            ocf?.apply(this, arguments);

            try {
                if (!this.__lzBuilt) buildUI(this);

                loadStack(this);
                sync(this);
                this.__lzRender?.();

                setTimeout(() => fit(this), 60);
                setTimeout(() => fit(this), 400);
            } catch (e) {
                console.warn("[Nougan Lora] onConfigure failed", e);
            }
        };
    },

    // node right-click menu: strength mode + toggle all, like rgthree's properties
    getNodeMenuItems(node) {
        try {
            if (!node || (node.comfyClass !== NODE_NAME && node.type !== NODE_NAME)) return [];
            const sep = isSep(node);
            return [
                null,
                {
                    content: `${sep ? "✓ " : ""}LoRA strengths: separate Model & Clip`,
                    callback: () => setMode(node, true),
                },
                {
                    content: `${!sep ? "✓ " : ""}LoRA strengths: single`,
                    callback: () => setMode(node, false),
                },
                {
                    content: "Toggle all LoRAs on/off",
                    callback: () => toggleAll(node),
                },
                null,
            ];
        } catch { return []; }
    },
});
