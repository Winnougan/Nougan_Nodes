// nougan-lora-loader-ui.js — DOM frontend for the Nougan Lora Loader.
// Same design language as the Nougan Ultimate Model Loader: ONE litegraph DOM widget,
// boxed / renamable / drag-reorderable sections, purple accent, status strip (WebGPU with a
// 2D fallback), type-to-search picker. MODEL / CLIP in and out are real sockets, so the node
// wires into subgraphs like any other.
//
//  • Section "LoRA Stack": toggle-all row, one row per LoRA (switch · ⠿ grip · name · ✕ ·
//    strength stepper), "＋ Add LoRA".
//  • Section "Options": single strength ↔ separate Model & Clip, remove all.
//  • stepper: drag to scrub · click the value to type · Alt+click = 1.00 · Shift = fine ·
//    wheel = ±0.05 · ‹ › step ±0.05
//  • row: click the name to swap · right-click for toggle / move / remove · hover for ⠿ and ✕
//  • picker: search, folder chips, favourites, click to add / remove, ↑↓ Enter
//
// Data model is UNCHANGED — hidden `lora_data` JSON (on / name / model / clip / split) — so
// nougan_lora_loader.py and the Live Panel keep working. Section headings and order are saved
// in node.properties (no Python change needed).
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const BUILD = "2026-11-17a";
const NODE_NAME = "NouganLoraLoader";
const DATA = "lora_data";
const PANEL_WIDGET = "lz_panel";
const MIN_W = 340;

const S_MIN = -2;      // visual range of the strength bars
const S_MAX = 2;       // (typing a value allows ±10)
const HARD = 10;
const STEP = 0.05;
const FAV_KEY = "nougan_lora_favorites";
const ROOT = "(root)";

// node-level strength mode (same property name / values as before, so old workflows load)
const PROP_SHOW = "Show Strengths";
const MODE_SINGLE = "Single Strength";
const MODE_SEPARATE = "Separate Model & Clip";

// section headings + order live in node.properties
const PROP_ORDER = "Section Order";
const SECTIONS = [
    { key: "stack",   prop: "Heading Stack",   def: "LoRA Stack" },
    { key: "options", prop: "Heading Options", def: "Options" },
];


// ── css (same palette as the Ultimate Loader) ──────────────────────────────

const CSS = `
.nglz-inner{display:flex;flex-direction:column;gap:6px;width:100%;box-sizing:border-box;
  padding:4px 2px 6px;font:12px/1.4 "Inter","Segoe UI",sans-serif;color:#dfe3ea;overflow:visible;
  pointer-events:auto;user-select:none;}
.nglz-inner *{box-sizing:border-box;}
.nglz-inner button{font:inherit;color:inherit;}
.nglz-inner>*{flex-shrink:0;}
.nglz-strip{display:flex;align-items:center;gap:8px;height:22px;}
.nglz-strip canvas{flex:0 0 64px;height:14px;border-radius:4px;background:#222;}
.nglz-status{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#9aa3b2;font-size:11px;}
.nglz-section{border:1px solid #3a3a46;border-radius:6px;background:rgba(255,255,255,.02);overflow:hidden;}
.nglz-sec-head{display:flex;align-items:center;gap:6px;padding:4px 6px;
  background:rgba(255,255,255,.045);border-bottom:1px solid #3a3a46;}
.nglz-grip{cursor:grab;color:#6b7280;user-select:none;padding:0 2px;}
.nglz-grip:active{cursor:grabbing;}
.nglz-sec-title{flex:1;background:transparent;border:none;outline:none;color:#e8b4ff;user-select:text;
  font-weight:600;font-size:12px;padding:1px 2px;border-radius:3px;min-width:0;}
.nglz-sec-title:focus{background:rgba(255,255,255,.07);}
.nglz-chev{cursor:pointer;color:#6b7280;user-select:none;width:14px;text-align:center;}
.nglz-sec-body{display:flex;flex-direction:column;gap:4px;padding:6px;}
.nglz-sec-body.nglz-collapsed{display:none;}
.nglz-drop-hint{outline:1px dashed #7c3aed;outline-offset:-1px;}

/* switch (identical look to the Ultimate Loader) */
.nglz-switch{position:relative;width:34px;height:18px;border-radius:9px;background:#3a3a46;
  cursor:pointer;transition:background .15s;flex:0 0 auto;}
.nglz-switch::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;
  border-radius:50%;background:#aab;transition:transform .15s, background .15s;}
.nglz-switch.on{background:#7c3aed;}
.nglz-switch.on::after{transform:translateX(16px);background:#fff;}
.nglz-switch.mid{background:#5b3aa6;}
.nglz-switch.mid::after{transform:translateX(8px);background:#e8d9ff;}
.nglz-switch-label{color:#c9ced8;}

/* options rows */
.nglz-orow{display:flex;align-items:center;gap:8px;min-height:22px;}
.nglz-label{flex:0 0 104px;color:#9aa3b2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.nglz-octl{flex:1;display:flex;align-items:center;gap:8px;justify-content:flex-end;}
.nglz-btn{cursor:pointer;background:#1b1b23;color:#dfe3ea;border:1px solid #444;border-radius:4px;
  padding:2px 10px;font-size:12px;transition:border-color .12s,background .12s,color .12s;}
.nglz-btn:hover{border-color:#7c3aed;color:#e8b4ff;}
.nglz-btn.warn{background:#b3383e;border-color:#b3383e;color:#fff;}

/* stack: column header + rows */
.nglz-cols{display:flex;align-items:center;gap:7px;height:20px;padding:0 7px 0 7px;font-size:10.5px;color:#9aa3b2;}
.nglz-cols-t{white-space:nowrap;}
.nglz-cl{flex:none;width:92px;text-align:center;white-space:nowrap;overflow:hidden;}
.nglz-sp{flex:1;}
.nglz-list{display:flex;flex-direction:column;gap:4px;}
.nglz-empty{padding:8px;text-align:center;color:#6b7280;font-size:11px;}
.nglz-row{position:relative;display:flex;align-items:center;gap:7px;min-height:26px;padding:2px 6px;
  background:rgba(255,255,255,.03);border:1px solid #2f2f3a;border-radius:5px;
  transition:background .12s,opacity .12s,border-color .12s;}
.nglz-row:hover{background:rgba(255,255,255,.06);border-color:#3a3a46;}
.nglz-row.off{opacity:.45;}
.nglz-row.drag{opacity:.55;box-shadow:0 6px 18px rgba(0,0,0,.5);}
.nglz-row.over-t::before,.nglz-row.over-b::after{content:"";position:absolute;left:2px;right:2px;height:2px;
  border-radius:1px;background:#7c3aed;}
.nglz-row.over-t::before{top:-3px;}.nglz-row.over-b::after{bottom:-3px;}
.nglz-nm{flex:1;min-width:0;display:flex;align-items:center;gap:6px;height:22px;cursor:pointer;}
.nglz-rgrip{flex:none;width:10px;text-align:center;color:#6b7280;cursor:grab;font-size:12px;letter-spacing:-2px;
  opacity:0;transition:opacity .12s;touch-action:none;}
.nglz-row:hover .nglz-rgrip{opacity:.9;}
.nglz-rgrip:active{cursor:grabbing;}
.nglz-txt{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.nglz-txt .dir{color:#6b7280;font-size:10.5px;}
.nglz-row:hover .nglz-txt .fn{color:#fff;}
.nglz-row.off .nglz-txt .fn{text-decoration:line-through;}
.nglz-miss{flex:none;font-size:8.5px;font-weight:800;letter-spacing:.08em;color:#fff;background:#b3383e;
  border-radius:3px;padding:1px 4px;}
.nglz-rowx{flex:none;width:16px;height:16px;display:grid;place-items:center;cursor:pointer;border-radius:4px;
  color:#6b7280;font-size:12px;opacity:0;transition:opacity .12s,color .12s,background .12s;}
.nglz-row:hover .nglz-rowx{opacity:1;}
.nglz-rowx:hover{color:#fff;background:#b3383e;}

/* strength stepper: ‹ 1.00 › */
.nglz-st{position:relative;flex:none;width:92px;height:20px;border-radius:4px;background:#1b1b23;
  border:1px solid #444;overflow:hidden;cursor:ew-resize;touch-action:none;transition:border-color .12s;}
.nglz-st:hover{border-color:#7c3aed;}
.nglz-fill{position:absolute;top:0;bottom:0;pointer-events:none;
  background:linear-gradient(90deg,rgba(124,58,237,.35),rgba(168,85,247,.8));}
.nglz-fill.neg{background:linear-gradient(90deg,rgba(34,211,238,.8),rgba(34,211,238,.3));}
.nglz-row.off .nglz-fill{opacity:.35;}
.nglz-tick{position:absolute;top:2px;bottom:2px;width:1px;background:rgba(255,255,255,.12);pointer-events:none;}
.nglz-tick.z{background:rgba(255,255,255,.26);}
.nglz-val{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
  font-size:11.5px;font-weight:700;font-variant-numeric:tabular-nums;color:#dfe3ea;
  text-shadow:0 1px 2px rgba(0,0,0,.8);pointer-events:none;}
.nglz-val.hard{color:#e8b4ff;}
.nglz-ar{position:absolute;top:0;bottom:0;width:16px;display:grid;place-items:center;font-size:13px;
  color:#9aa3b2;opacity:.55;cursor:pointer;transition:opacity .12s,color .12s;}
.nglz-st:hover .nglz-ar{opacity:1;}
.nglz-ar:hover{color:#fff;}
.nglz-ar.l{left:0;}.nglz-ar.r{right:0;}
.nglz-in{position:absolute;inset:0;width:100%;height:100%;z-index:3;background:#0f0f14;color:#dfe3ea;border:0;
  outline:1px solid #7c3aed;border-radius:4px;text-align:center;font:700 11.5px "Inter",sans-serif;user-select:text;}

/* add button */
.nglz-add{margin-top:4px;width:100%;height:26px;border-radius:5px;cursor:pointer;font-weight:600;font-size:11.5px;
  color:#c9ced8;background:#1b1b23;border:1px solid #444;transition:border-color .12s,color .12s,background .12s;}
.nglz-add:hover{border-color:#7c3aed;color:#e8b4ff;background:rgba(124,58,237,.12);}

/* picker (body-appended so no node wrapper can clip it) */
.nglzp{position:fixed;z-index:100000;width:430px;max-width:94vw;max-height:72vh;display:flex;flex-direction:column;
  background:#1b1b23;color:#dfe3ea;border:1px solid #3a3a46;border-radius:10px;
  box-shadow:0 18px 50px rgba(0,0,0,.7);font:12px/1.4 "Inter","Segoe UI",sans-serif;user-select:none;overflow:hidden;}
.nglzp *{box-sizing:border-box;}
.nglzp button{font:inherit;color:inherit;}
.nglzp-h{display:flex;align-items:center;gap:8px;padding:10px 12px 6px;}
.nglzp-h .t{font-weight:700;letter-spacing:.1em;font-size:11px;color:#e8b4ff;}
.nglzp-h .c{font-size:10px;color:#9aa3b2;}
.nglzp-h .sp{flex:1;}
.nglzp-x{cursor:pointer;color:#6b7280;padding:0 4px;font-size:14px;}.nglzp-x:hover{color:#fff;}
.nglzp-s{padding:0 12px 8px;}
.nglzp-s input{width:100%;padding:7px 10px;border-radius:6px;background:#15151b;color:inherit;border:1px solid #444;
  font:inherit;outline:none;user-select:text;}
.nglzp-s input:focus{border-color:#7c3aed;box-shadow:0 0 0 3px rgba(124,58,237,.18);}
.nglzp-f{display:flex;flex-wrap:wrap;gap:5px;padding:0 12px 8px;max-height:64px;overflow:auto;}
.nglzp-fc{cursor:pointer;font-size:10.5px;padding:2px 9px;border-radius:99px;background:#23232c;border:1px solid #3a3a46;
  color:#9aa3b2;transition:all .12s;}
.nglzp-fc:hover{border-color:#7c3aed;color:#e8b4ff;}
.nglzp-fc.on{background:#7c3aed;color:#fff;border-color:#a78bfa;font-weight:700;}
.nglzp-l{flex:1;overflow:auto;padding:2px 6px 6px;border-top:1px solid #2a2a33;}
.nglzp-it{display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:6px;cursor:pointer;}
.nglzp-it:hover,.nglzp-it.hi{background:rgba(124,58,237,.25);}
.nglzp-it.in{background:rgba(124,58,237,.14);}
.nglzp-st{width:18px;text-align:center;font-size:15px;line-height:1;cursor:pointer;color:#555;transition:transform .12s,color .12s;}
.nglzp-st:hover{color:#e8b4ff;transform:scale(1.2);}.nglzp-st.on{color:#e8b4ff;}
.nglzp-ck{flex:none;width:15px;height:15px;border-radius:4px;border:1.5px solid #4a4a56;display:grid;place-items:center;
  font-size:10px;color:transparent;transition:all .12s;}
.nglzp-it.in .nglzp-ck{background:#7c3aed;border-color:#7c3aed;color:#fff;font-weight:900;}
.nglzp-nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.nglzp-nm .dir{color:#6b7280;font-size:10.5px;}
.nglzp-nm .fn{font-weight:600;}
.nglzp-sep{border:none;border-top:1px solid #2a2a33;margin:5px 8px;}
.nglzp-em{padding:18px;text-align:center;color:#6b7280;}
.nglzp-ft{display:flex;align-items:center;gap:8px;padding:8px 12px;border-top:1px solid #2a2a33;background:#15151b;}
.nglzp-ft .h{flex:1;font-size:10px;color:#6b7280;}
.nglzp-done{cursor:pointer;padding:5px 16px;border-radius:6px;font-weight:700;font-size:11px;letter-spacing:.08em;
  text-transform:uppercase;color:#fff;background:#7c3aed;border:1px solid #a78bfa;}
.nglzp-done:hover{background:#8b5cf6;}
`;

function injectCss() {
    if (document.getElementById("nglz-css")) return;
    const st = document.createElement("style");
    st.id = "nglz-css";
    st.textContent = CSS;
    document.head.appendChild(st);
}


// ── helpers ────────────────────────────────────────────────────────────────

const norm = (f) => String(f ?? "").replaceAll("\\", "/");
const folderOf = (f) => { const n = norm(f), i = n.lastIndexOf("/"); return i < 0 ? ROOT : n.slice(0, i); };
const baseOf = (f) => { const n = norm(f); return n.slice(n.lastIndexOf("/") + 1); };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const fmt = (v) => (v < 0 ? "−" : "") + Math.abs(v).toFixed(2);
const alpha = (a, b) => a.localeCompare(b, undefined, { sensitivity: "base" });

function h(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
}

const loadFav = () => { try { return new Set(JSON.parse(localStorage.getItem(FAV_KEY) || "[]")); } catch { return new Set(); } };
const saveFav = (s) => { try { localStorage.setItem(FAV_KEY, JSON.stringify([...s])); } catch { } };

// Pointer/mouse events that bubble out of the panel into the canvas layers kill focus.
function guardPanel(el) {
    const stop = (e) => e.stopPropagation();
    for (const t of ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick"]) el.addEventListener(t, stop);
}
function guardTextInput(input) {
    const stop = (e) => e.stopPropagation();
    for (const t of ["keydown", "keyup", "keypress"]) input.addEventListener(t, stop);
    input.addEventListener("pointerdown", () => setTimeout(() => input.focus({ preventScroll: true }), 0));
}

// LoRA list: our own endpoint first, ComfyUI's LoraLoader combo as a fallback
let _files = null;   // null until the first successful fetch

async function fetchList() {
    try {
        const r = await api.fetchApi("/nougan/loras");
        if (r.ok) {
            const j = await r.json();
            const a = (j || []).map(e => typeof e === "string" ? e : e?.name).filter(Boolean);
            if (a.length) return a;
        }
    } catch { /* fall through */ }
    try {
        const r = await api.fetchApi("/object_info/LoraLoader");
        const j = await r.json();
        const v = j?.LoraLoader?.input?.required?.lora_name;
        const vals = Array.isArray(v?.[0]) ? v[0] : v?.[1]?.options;
        if (Array.isArray(vals)) return vals.filter(x => typeof x === "string");
    } catch (e) {
        console.warn("[Nougan Lora] list fetch failed", e);
    }
    return null;
}

async function loras(force = false) {
    if (_files == null || force) {
        const l = await fetchList();
        if (l) _files = l;
    }
    return _files || [];
}

const isMissing = (name) => _files != null && !_files.some(f => norm(f) === norm(name));


// ── WebGPU status canvas (2D fallback) — same strip as the Ultimate Loader ──

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


// ── data ───────────────────────────────────────────────────────────────────

const dataW = (n) => n.widgets?.find(w => w.name === DATA);
const isSep = (node) => node?.properties?.[PROP_SHOW] === MODE_SEPARATE;
const newEntry = (extra) => ({ on: true, name: "", model: 1, clip: 1, split: false, ...extra });

function hideDataWidget(node) {
    const w = dataW(node);
    if (!w) return;
    w.hidden = true;
    w.computeSize = () => [0, -4];
    const el = w.element || w.inputEl;
    if (el) { el.style.display = "none"; el.style.height = "0"; el.style.pointerEvents = "none"; }
}

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

    // migration: older workflows had a per-row split toggle and no node property
    node.properties = node.properties || {};
    if (!(PROP_SHOW in node.properties)) {
        node.properties[PROP_SHOW] = stack.some(e => e.split) ? MODE_SEPARATE : MODE_SINGLE;
    }
}

// Something other than this node (the Live Panel, a script...) changed `lora_data`.
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

function sectionOrder(node) {
    const known = SECTIONS.map(s => s.key);
    const saved = String(node.properties?.[PROP_ORDER] || "").split(",").map(s => s.trim()).filter(k => known.includes(k));
    return [...saved, ...known.filter(k => !saved.includes(k))];
}


// ── strength stepper: ‹ 1.00 › (DOM) ───────────────────────────────────────

class Bar {
    // get() -> number; set(v) writes the entry; onTouch() commits the JSON
    constructor(get, set, onTouch) {
        this.get = get; this.set = set; this.onTouch = onTouch;

        const el = h("div", "nglz-st");
        el.title = "Drag to scrub · click value to type · Alt+click = 1.00 · Shift = fine · wheel = ±0.05";
        el.innerHTML = `
            <div class="nglz-fill"></div>
            <div class="nglz-tick" style="left:${((1 - S_MIN) / (S_MAX - S_MIN)) * 100}%"></div>
            <div class="nglz-tick z" style="left:50%"></div>
            <span class="nglz-val"></span>
            <span class="nglz-ar l">‹</span><span class="nglz-ar r">›</span>`;
        this.el = el;
        this.fill = el.querySelector(".nglz-fill");
        this.val = el.querySelector(".nglz-val");

        el.querySelector(".nglz-ar.l").addEventListener("click", (e) => { e.stopPropagation(); this.put(this.get() - (e.shiftKey ? 0.01 : STEP)); });
        el.querySelector(".nglz-ar.r").addEventListener("click", (e) => { e.stopPropagation(); this.put(this.get() + (e.shiftKey ? 0.01 : STEP)); });
        el.addEventListener("pointerdown", (e) => this.onDown(e));
        el.addEventListener("wheel", (e) => {
            e.preventDefault(); e.stopPropagation();
            this.put(this.get() + (e.deltaY < 0 ? 1 : -1) * (e.shiftKey ? 0.01 : STEP));
        }, { passive: false });
        this.paint();
    }

    put(v) {
        v = clamp(Math.round(v * 100) / 100, -HARD, HARD);
        this.set(v);
        this.paint();
        this.onTouch();
    }

    onDown(e) {
        if (e.target.closest(".nglz-ar") || e.target.closest(".nglz-in")) return;
        if (e.altKey) { this.put(1); return; }
        const el = this.el;
        el.setPointerCapture?.(e.pointerId);
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
            if (!moved && !ev.target.closest(".nglz-ar")) this.edit();
        };
        el.addEventListener("pointermove", mv);
        el.addEventListener("pointerup", up);
        el.addEventListener("pointercancel", up);
    }

    edit() {
        if (this.el.querySelector(".nglz-in")) return;
        const inp = h("input", "nglz-in");
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

    paint() {
        const v = this.get();
        const pos = clamp((v - S_MIN) / (S_MAX - S_MIN), 0, 1);
        this.val.textContent = fmt(v);
        this.val.classList.toggle("hard", v > S_MAX || v < S_MIN);
        this.fill.className = "nglz-fill" + (v < 0 ? " neg" : "");
        this.fill.style.left = (Math.min(pos, 0.5) * 100) + "%";
        this.fill.style.width = (Math.abs(pos - 0.5) * 100) + "%";
    }
}


// ── picker popup ───────────────────────────────────────────────────────────

let _pop = null;
function closePicker() { _pop?.dispose(); _pop = null; }

// replaceIdx: null = multi-add / toggle mode, number = swap that row's LoRA and close
async function openPicker(node, ev, replaceIdx = null) {
    closePicker();
    injectCss();

    const files = await loras(true);
    const favs = loadFav();
    const folders = [...new Set(files.map(folderOf))].sort((a, b) => a === ROOT ? -1 : b === ROOT ? 1 : alpha(a, b));
    let query = "", folder = null, hi = 0, visible = [];

    const el = h("div", "nglzp");
    el.innerHTML = `
        <div class="nglzp-h"><span class="t">${replaceIdx == null ? "ADD LORAS" : "SWAP LORA"}</span>
            <span class="c"></span><span class="sp"></span><span class="nglzp-x">✕</span></div>
        <div class="nglzp-s"><input placeholder="Search ${files.length} LoRAs…" spellcheck="false"></div>
        <div class="nglzp-f"></div>
        <div class="nglzp-l"></div>
        <div class="nglzp-ft"><span class="h">${replaceIdx == null ? "click to add / remove · ↑↓ Enter · Esc" : "click a LoRA to swap it in"}</span>
            <button class="nglzp-done">Done</button></div>`;

    const $ = (s) => el.querySelector(s);
    const list = $(".nglzp-l"), input = $("input"), chips = $(".nglzp-f");
    $(".nglzp-x").onclick = closePicker;
    $(".nglzp-done").onclick = closePicker;
    guardPanel(el);
    guardTextInput(input);
    list.addEventListener("wheel", (e) => e.stopPropagation());

    const inStack = (f) => (node.__stack || []).some(e => norm(e.name) === norm(f));

    function drawChips() {
        chips.textContent = "";
        if (folders.length < 2) { chips.style.display = "none"; return; }
        const mk = (label, val) => {
            const c = h("span", "nglzp-fc" + (folder === val ? " on" : ""), label);
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
        if (inStack(f)) node.__stack = node.__stack.filter(e => norm(e.name) !== norm(f));
        else node.__stack.push(newEntry({ name: f }));
        node.__lzCommit();
        const top = list.scrollTop;
        draw();
        list.scrollTop = top;
    }

    function draw() {
        list.textContent = "";
        const q = query.trim().toLowerCase();
        const pool = files.filter(f => (folder == null || folderOf(f) === folder) && (!q || f.toLowerCase().includes(q)));
        const fav = pool.filter(f => favs.has(f)).sort(alpha);
        const rest = pool.filter(f => !favs.has(f)).sort(alpha);
        visible = [...fav, ...rest];
        hi = clamp(hi, 0, Math.max(0, visible.length - 1));
        $(".c").textContent = `${(node.__stack || []).length} in stack`;

        if (!visible.length) {
            list.appendChild(h("div", "nglzp-em", files.length ? "No matches." : "No LoRAs found in models/loras."));
            return;
        }

        const item = (f, i) => {
            const row = h("div", "nglzp-it" + (inStack(f) ? " in" : "") + (i === hi ? " hi" : ""));
            row.dataset.i = i;

            const star = h("span", "nglzp-st" + (favs.has(f) ? " on" : ""), favs.has(f) ? "★" : "☆");
            star.onclick = (e) => {
                e.stopPropagation();
                favs.has(f) ? favs.delete(f) : favs.add(f);
                saveFav(favs);
                const top = list.scrollTop;
                draw();
                list.scrollTop = top;
            };
            row.appendChild(star);

            if (replaceIdx == null) row.appendChild(h("span", "nglzp-ck", "✓"));

            const nm = h("span", "nglzp-nm");
            nm.title = f;
            const d = folderOf(f);
            if (d !== ROOT) nm.appendChild(h("span", "dir", d + "/"));
            nm.appendChild(h("span", "fn", baseOf(f)));
            row.appendChild(nm);

            row.onclick = () => toggle(f);
            return row;
        };

        fav.forEach((f, i) => list.appendChild(item(f, i)));
        if (fav.length && rest.length) list.appendChild(h("hr", "nglzp-sep"));
        rest.forEach((f, i) => list.appendChild(item(f, fav.length + i)));
    }

    input.addEventListener("input", () => { query = input.value; hi = 0; draw(); });

    const kd = (e) => {
        if (e.key === "Escape") { closePicker(); return; }
        if (!el.contains(document.activeElement) && document.activeElement !== document.body) return;
        const move = (d) => {
            e.preventDefault();
            hi = clamp(hi + d, 0, visible.length - 1);
            list.querySelectorAll(".nglzp-it").forEach(r => r.classList.toggle("hi", Number(r.dataset.i) === hi));
            list.querySelector(".nglzp-it.hi")?.scrollIntoView({ block: "nearest" });
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

function rowMenu(node, idx, ev) {
    const st = node.__stack || [];
    const en = st[idx];
    if (!en) return;
    const LM = window.LiteGraph;
    if (!LM?.ContextMenu) return;
    new LM.ContextMenu([
        { content: en.name || "LoRA", disabled: true },
        null,
        { content: en.on ? "⚫ Toggle Off" : "🟢 Toggle On", callback: () => { en.on = !en.on; node.__lzCommit(); } },
        { content: "⬆️ Move Up", disabled: idx <= 0, callback: () => { [st[idx - 1], st[idx]] = [st[idx], st[idx - 1]]; node.__lzCommit(); } },
        { content: "⬇️ Move Down", disabled: idx >= st.length - 1, callback: () => { [st[idx + 1], st[idx]] = [st[idx], st[idx + 1]]; node.__lzCommit(); } },
        null,
        { content: "🗑️ Remove", callback: () => { st.splice(idx, 1); node.__lzCommit(); } },
    ], { event: ev, title: "LORA" });
}


// ── node sizing: title + slots + panel height, always, automatically ───────

function syncHeight(node) {
    if (!node._nglz || !node.graph) return;
    const w = Math.max(MIN_W, node.size[0]);
    const hgt = node.computeSize()[1];
    if (Math.abs(node.size[1] - hgt) > 1 || node.size[0] !== w) node.setSize([w, hgt]);
    node.setDirtyCanvas(true, true);
}


// ── main build ─────────────────────────────────────────────────────────────

function buildDom(node) {
    teardownDom(node);
    injectCss();
    hideDataWidget(node);
    loadStack(node);
    node.properties = node.properties || {};
    for (const s of SECTIONS) if (node.properties[s.prop] == null) node.properties[s.prop] = s.def;

    const inner = h("div", "nglz-inner");
    guardPanel(inner);

    // status strip (WebGPU canvas + text)
    const strip = h("div", "nglz-strip");
    const gpuCanvas = document.createElement("canvas");
    const status = h("div", "nglz-status");
    strip.appendChild(gpuCanvas);
    strip.appendChild(status);
    inner.appendChild(strip);
    let stripStop = null, stripDead = false;
    startStrip(gpuCanvas).then((fn) => { if (stripDead) fn?.(); else stripStop = fn; });

    const parts = {};
    const touch = () => { sync(node); paintStatus(); node.setDirtyCanvas(true, true); };
    const commit = () => { sync(node); render(); node.setDirtyCanvas(true, true); };

    function paintStatus() {
        const st = node.__stack || [];
        const on = st.filter(e => e.on).length;
        const miss = st.filter(e => e.on && isMissing(e.name)).length;
        if (!st.length) { status.textContent = "empty — add a LoRA below"; return; }
        const bits = [`${on}/${st.length} on`, isSep(node) ? "model + clip" : "single strength"];
        if (miss) bits.push(`⚠ ${miss} missing`);
        status.textContent = bits.join(" · ");
    }

    function render() {
        parts.stack?.render();
        parts.options?.paint();
        paintStatus();
        syncHeight(node);
    }

    // ── section: LoRA stack ─────────────────────────────────────────────────
    function buildStack(body) {
        const cols = h("div", "nglz-cols");
        const all = h("div", "nglz-switch");
        all.title = "Toggle all LoRAs on / off";
        all.onclick = () => toggleAll(node);
        cols.appendChild(all);
        cols.appendChild(h("span", "nglz-cols-t", "Toggle all"));
        cols.appendChild(h("span", "nglz-sp"));
        const list = h("div", "nglz-list");
        const add = h("button", "nglz-add", "＋ Add LoRA");
        add.onclick = (ev) => openPicker(node, ev);
        body.appendChild(cols);
        body.appendChild(list);
        body.appendChild(add);

        function startDrag(e, row, idx) {
            e.preventDefault();
            const grip = e.currentTarget;
            grip.setPointerCapture?.(e.pointerId);
            row.classList.add("drag");
            const rows = [...list.querySelectorAll(".nglz-row")];
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
            const row = h("div", "nglz-row" + (en.on ? "" : " off"));
            row.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); rowMenu(node, idx, e); });

            const sw = h("div", "nglz-switch" + (en.on ? " on" : ""));
            sw.title = en.on ? "Enabled" : "Disabled";
            sw.onclick = () => { en.on = !en.on; commit(); };
            row.appendChild(sw);

            const nm = h("span", "nglz-nm");
            nm.title = en.name + "\n(click to swap · right-click for more)";
            const grip = h("span", "nglz-rgrip", "⠿");
            grip.title = "Drag to reorder";
            grip.addEventListener("pointerdown", (e) => startDrag(e, row, idx));
            nm.appendChild(grip);

            const txt = h("span", "nglz-txt");
            const d = folderOf(en.name);
            if (d !== ROOT) txt.appendChild(h("span", "dir", d + "/"));
            txt.appendChild(h("span", "fn", baseOf(en.name)));
            nm.appendChild(txt);

            if (isMissing(en.name)) {
                const m = h("span", "nglz-miss", "MISSING");
                m.title = "This file isn't in models/loras — it will be skipped.";
                nm.appendChild(m);
            }

            const x = h("span", "nglz-rowx", "✕");
            x.title = "Remove";
            x.onclick = (e) => { e.stopPropagation(); node.__stack.splice(idx, 1); commit(); };
            nm.appendChild(x);

            nm.onclick = (ev) => { if (!ev.target.closest(".nglz-rgrip") && !ev.target.closest(".nglz-rowx")) openPicker(node, ev, idx); };
            row.appendChild(nm);

            if (isSep(node)) {
                row.appendChild(new Bar(() => en.model, v => { en.model = v; }, touch).el);
                row.appendChild(new Bar(() => en.clip, v => { en.clip = v; }, touch).el);
            } else {
                row.appendChild(new Bar(() => en.model, v => { en.model = v; en.clip = v; }, touch).el);
            }
            return row;
        }

        return {
            render() {
                const st = node.__stack || [];
                const on = st.filter(e => e.on).length;
                all.classList.toggle("on", st.length > 0 && on === st.length);
                all.classList.toggle("mid", on > 0 && on < st.length);

                cols.querySelectorAll(".nglz-cl").forEach(e => e.remove());
                for (const t of (isSep(node) ? ["Model", "Clip"] : ["Strength"])) cols.appendChild(h("span", "nglz-cl", t));
                cols.style.display = st.length ? "" : "none";

                list.textContent = "";
                if (!st.length) list.appendChild(h("div", "nglz-empty", "No LoRAs yet."));
                st.forEach((en, i) => list.appendChild(renderRow(en, i)));
            },
        };
    }

    // ── section: options ────────────────────────────────────────────────────
    function buildOptions(body) {
        // strengths mode
        const r1 = h("div", "nglz-orow");
        r1.appendChild(h("div", "nglz-label", "strengths"));
        const c1 = h("span", "nglz-octl");
        c1.appendChild(h("span", "nglz-switch-label", "separate model & clip"));
        const sw = h("div", "nglz-switch");
        sw.title = "Single strength ↔ separate Model & Clip strengths";
        sw.onclick = () => setMode(node, !isSep(node));
        c1.appendChild(sw);
        r1.appendChild(c1);
        body.appendChild(r1);

        // remove all (two-click confirm)
        const r2 = h("div", "nglz-orow");
        r2.appendChild(h("div", "nglz-label", "stack"));
        const c2 = h("span", "nglz-octl");
        const clr = h("button", "nglz-btn", "remove all");
        let armed = null;
        const reset = () => { armed = null; clr.classList.remove("warn"); clr.textContent = "remove all"; };
        clr.onclick = () => {
            if (!(node.__stack || []).length) return;
            if (!armed) {
                clr.classList.add("warn");
                clr.textContent = "click again to confirm";
                armed = setTimeout(reset, 2000);
                return;
            }
            clearTimeout(armed);
            reset();
            node.__stack = [];
            commit();
        };
        c2.appendChild(clr);
        r2.appendChild(c2);
        body.appendChild(r2);

        return { paint() { sw.classList.toggle("on", isSep(node)); } };
    }

    const builders = { stack: buildStack, options: buildOptions };

    // sections in saved order — boxed, renamable, collapsible, drag-reorderable
    for (const key of sectionOrder(node)) {
        const spec = SECTIONS.find(s => s.key === key);
        const sec = h("div", "nglz-section");
        sec.dataset.key = key;

        const head = h("div", "nglz-sec-head");
        const grip = h("span", "nglz-grip", "⠿");
        grip.title = "drag to reorder sections";
        const title = h("input", "nglz-sec-title");
        title.value = node.properties[spec.prop] ?? spec.def;
        title.spellcheck = false;
        title.title = "click to rename this heading";
        guardTextInput(title);
        title.addEventListener("input", () => { node.properties[spec.prop] = title.value; node.setDirtyCanvas(true, true); });
        const chev = h("span", "nglz-chev", "▾");
        head.appendChild(grip);
        head.appendChild(title);
        head.appendChild(chev);

        const body = h("div", "nglz-sec-body");
        parts[key] = builders[key](body);
        chev.onclick = () => {
            const collapsed = body.classList.toggle("nglz-collapsed");
            chev.textContent = collapsed ? "▸" : "▾";
            syncHeight(node);
        };

        grip.addEventListener("pointerdown", (e) => {
            e.preventDefault(); e.stopPropagation();
            grip.setPointerCapture?.(e.pointerId);
            const onMove = (ev) => {
                for (const s of inner.querySelectorAll(".nglz-section")) {
                    s.classList.remove("nglz-drop-hint");
                    const r = s.getBoundingClientRect();
                    if (s !== sec && ev.clientY > r.top && ev.clientY < r.bottom) s.classList.add("nglz-drop-hint");
                }
            };
            const onUp = (ev) => {
                grip.removeEventListener("pointermove", onMove);
                grip.removeEventListener("pointerup", onUp);
                let target = null;
                for (const s of inner.querySelectorAll(".nglz-section")) {
                    const r = s.getBoundingClientRect();
                    if (s !== sec && ev.clientY > r.top && ev.clientY < r.bottom) target = s;
                    s.classList.remove("nglz-drop-hint");
                }
                if (target) {
                    const before = ev.clientY < target.getBoundingClientRect().top + target.offsetHeight / 2;
                    inner.insertBefore(sec, before ? target : target.nextSibling);
                    node.properties[PROP_ORDER] = [...inner.querySelectorAll(".nglz-section")].map(s => s.dataset.key).join(",");
                    node.setDirtyCanvas(true, true);
                    syncHeight(node);
                }
            };
            grip.addEventListener("pointermove", onMove);
            grip.addEventListener("pointerup", onUp);
        });

        sec.appendChild(head);
        sec.appendChild(body);
        inner.appendChild(sec);
    }

    // hooks other code (Live Panel, picker, menus) relies on
    node.__lzRender = render;
    node.__lzCommit = commit;

    // pick up Live Panel / script edits of lora_data
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

    // register as a real DOM widget — the frontend positions/zooms/clips it and the node's
    // height falls out of computeSize(), so no gap is possible.
    const dw = node.addDOMWidget(PANEL_WIDGET, "nglz-panel", inner, { hideOnZoom: false, serialize: false });
    dw.serializeValue = () => undefined;   // nothing to save; data lives in lora_data
    let lastH = 0;
    dw.computeSize = () => {
        const sh = inner.scrollHeight;
        if (sh > 4) lastH = sh;
        return [Math.max(MIN_W, node.size[0]), Math.max(60, (lastH || sh) + 10)];
    };
    const ro = new ResizeObserver(() => { if (inner.scrollHeight > 4) syncHeight(node); });
    ro.observe(inner);

    node._nglz = { inner, status, dw, ro, stopStrip: () => { stripDead = true; stripStop?.(); } };

    render();
    // learn which files exist so missing LoRAs get flagged
    loras().then(() => node.__lzRender?.());
}

function teardownDom(node) {
    const st = node._nglz;
    if (!st) return;
    try { st.ro?.disconnect(); } catch { }
    try { st.stopStrip?.(); } catch { }
    closePicker();
    if (st.dw && node.widgets) {
        // unregister from the frontend's dom-widget store, or a ghost of the old panel re-mounts
        try { st.dw.onRemove?.(); } catch { }
        const i = node.widgets.indexOf(st.dw);
        if (i >= 0) node.widgets.splice(i, 1);
    }
    st.inner.remove();
    node._nglz = null;
}


// ── extension ──────────────────────────────────────────────────────────────

app.registerExtension({
    name: "Nougan.LoraLoader",
    async setup() { console.log(`[Nougan.Lora] extension loaded — build ${BUILD}`); },

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData?.name !== NODE_NAME) return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            onNodeCreated?.apply(this, arguments);
            this.size[0] = Math.max(this.size[0], MIN_W);
            this.properties = this.properties || {};
            if (!(PROP_SHOW in this.properties)) this.properties[PROP_SHOW] = MODE_SINGLE;
            try { buildDom(this); } catch (e) { console.warn("[Nougan Lora] UI build failed", e); }
        };

        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            onConfigure?.apply(this, arguments);
            try {
                buildDom(this);   // after properties + lora_data are restored
                sync(this);
            } catch (e) { console.warn("[Nougan Lora] onConfigure failed", e); }
        };

        const onRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            teardownDom(this);
            onRemoved?.apply(this, arguments);
        };

        const onResize = nodeType.prototype.onResize;
        nodeType.prototype.onResize = function (size) {
            if (size[0] < MIN_W) size[0] = MIN_W;
            onResize?.apply(this, [size]);
        };

        // cheap per-frame check: lora_data edited from outside (Live Panel, undo, script)
        const onDrawBackground = nodeType.prototype.onDrawBackground;
        nodeType.prototype.onDrawBackground = function () {
            onDrawBackground?.apply(this, arguments);
            if (!this._nglz) return;
            try { pullFromWidget(this); } catch { }
        };
    },

    // node right-click menu: strength mode + toggle all
    getNodeMenuItems(node) {
        try {
            if (!node || (node.comfyClass !== NODE_NAME && node.type !== NODE_NAME)) return [];
            const sep = isSep(node);
            return [
                null,
                { content: `${sep ? "✓ " : ""}LoRA strengths: separate Model & Clip`, callback: () => setMode(node, true) },
                { content: `${!sep ? "✓ " : ""}LoRA strengths: single`, callback: () => setMode(node, false) },
                { content: "Toggle all LoRAs on/off", callback: () => toggleAll(node) },
                null,
            ];
        } catch { return []; }
    },
});
