// web/nougan_refmods.js — Nougan RefMods console for the unified Bake / Apply nodes.
//
// Scope: ONLY NouganUnifiedRefModBake / NouganUnifiedRefModApply. The legacy Qwen 2.1 shells
// (NouganQwen21RefModBake / NouganQwen21RefModEncode) intentionally stay plain: they must keep the
// exact widget layout old workflows were saved with, so nothing here touches them beyond
// refreshing their refmod combo lists after a bake.
//
//  * DOM      model chips, reference cards with thumbnails, a real searchable library picker,
//             token meter, ref_strength timeline, connection checklist, warnings, undo toast.
//  * WebGPU   an aurora strip in the model's accent colour rendering up to three references as
//             textured cards with chromatic-aberration shimmer, rim light and scanlines. It reacts
//             to token pressure (warms up over budget) and pulses while the node executes.
//             Falls back to an animated CSS gradient + <img> cards when WebGPU is unavailable.
//  * Data     everything comes from /nougan/refmod_lib (the Handler classes in nougan_refmods.py),
//             so adding a model needs no change here.
//
// No serialized widgets are added and no widget is ever removed or reordered — hiding only flips
// `hidden`/`computeSize`, so `widgets_values` keeps its positional meaning for older frontends.

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// ───────────────────────────── constants ─────────────────────────────
const KINDS = { NouganUnifiedRefModBake: "bake", NouganUnifiedRefModApply: "apply" };
const LEGACY_QWEN = "NouganQwen21RefModEncode";
const AUTO = "auto (from refmod)";
const NONE = "None";
const SLOTS = ["refmod_1", "refmod_2", "refmod_3"];
const APPLY_COND = ["extra_image_scale", "ref_strength", "ref_on_negative", "frame_idx", "strength"];
const APPLY_TEXT = ["prompt", "negative_prompt"];
const BAKE_COND = ["scale_mode"];
const HOOKED = [
  "model", ...SLOTS, "name", "subfolder", "overwrite",
  "resolution", "extra_image_resolution", "ref_strength", "ref_on_negative",
];
const TOKEN_BUDGET = 16384;
const STRIP_H = 84;
const POLL_MS = 15000;
const LIB_TTL = 4000;
const ACCENT = "#a78bfa";
const CAN_BITMAP = typeof createImageBitmap === "function";
const REDUCED = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

// ───────────────────────────── helpers ─────────────────────────────
const W = (n, name) => n.widgets?.find((w) => w.name === name);
const linked = (n, name) => n.inputs?.find((i) => i.name === name)?.link != null;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const base = (s) => String(s || "").split("/").pop();
const cmp = (a, b) => String(a).toLowerCase().localeCompare(String(b).toLowerCase());
const fmt = (t) => (t >= 1000 ? `${(t / 1000).toFixed(t >= 10000 ? 0 : 1)}k` : `${Math.round(t)}`);
const hexRGB = (h) => {
  const n = parseInt(String(h || ACCENT).slice(1), 16) || 0xa78bfa;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const css = (h, a = 1) => { const [r, g, b] = hexRGB(h); return `rgba(${r},${g},${b},${a})`; };

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

// Keep LiteGraph (and the suite's hold-key gestures) away from our controls.
function guard(e, wheel = false) {
  const stop = (ev) => ev.stopPropagation();
  for (const t of ["pointerdown", "mousedown", "touchstart", "dblclick", "click", "contextmenu"]) {
    e.addEventListener(t, stop);
  }
  if (wheel) e.addEventListener("wheel", stop, { passive: true });
  return e;
}

function button(cls, label, title, fn) {
  const b = el("button", cls, label);
  b.type = "button";
  if (title) b.title = title;
  b.addEventListener("click", (ev) => { ev.preventDefault(); ev.stopPropagation(); fn(ev); });
  return guard(b);
}

function store(key, val) {
  try {
    if (val === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, val);
  } catch (_) { /* private mode / disabled storage */ }
  return null;
}

function setHidden(w, hide) {
  if (!w) return false;
  hide = !!hide;
  if (!!w.__nrmHidden === hide) return false;
  if (!w.__nrmOrig) {
    w.__nrmOrig = {
      type: w.type,
      hidden: w.hidden,
      own: Object.prototype.hasOwnProperty.call(w, "computeSize"),
      cs: w.computeSize,
    };
  }
  w.__nrmHidden = hide;
  try { w.hidden = hide; } catch (_) { /* getter-only */ }
  if (hide) {
    try { w.type = "converted-widget"; } catch (_) { /* class getter */ }
    w.computeSize = () => [0, -4];
  } else {
    try { w.type = w.__nrmOrig.type; } catch (_) { /* ignore */ }
    try { w.hidden = w.__nrmOrig.hidden; } catch (_) { /* ignore */ }
    if (w.__nrmOrig.own) w.computeSize = w.__nrmOrig.cs; else delete w.computeSize;
  }
  return true;
}

function callWidget(w, value) {
  if (!w) return;
  w.value = value;
  try { w.callback?.(value, app.canvas, null, null, null); } catch (_) { /* third-party callback */ }
}

// ───────────────────────────── styles ─────────────────────────────
function injectCSS() {
  if (document.getElementById("nougan-refmods-css")) return;
  const s = el("style");
  s.id = "nougan-refmods-css";
  s.textContent = `
.nrm-root{--bg:#0d0a16;--surf:#171226;--raise:#241b3f;--line:#3b2d66;--vio:#7c5cff;--lil:#a78bfa;
--txt:#ece8ff;--dim:#9d93bd;--ok:#34d399;--warn:#fbbf24;--bad:#f87171;--info:#60a5fa;
--acc:${ACCENT};--acc-soft:${css(ACCENT, 0.18)};
box-sizing:border-box;width:100%;padding:2px 0 0;font:11px/1.35 system-ui,-apple-system,"Segoe UI",sans-serif;
color:var(--txt);display:flex;flex-direction:column;gap:6px;user-select:none;-webkit-user-select:none}
.nrm-root *{box-sizing:border-box;min-width:0}
.nrm-sel{user-select:text;-webkit-user-select:text;cursor:text}
.nrm-strip{position:relative;height:${STRIP_H}px;flex:none;border-radius:12px;overflow:hidden;background:#100c1b;
border:1px solid rgba(167,139,250,.22);box-shadow:0 6px 18px -10px #000 inset,0 0 0 1px rgba(0,0,0,.4)}
.nrm-strip canvas{position:absolute;inset:0;width:100%;height:100%;display:block}
.nrm-fb{position:absolute;inset:0;display:none;align-items:center;gap:8px;padding:8px 12px;
background:linear-gradient(120deg,#171226,var(--acc-soft),#241b3f,var(--acc-soft),#171226);
background-size:220% 100%;animation:nrm-drift 11s linear infinite}
.nrm-fb img{height:100%;border-radius:8px;border:1px solid var(--acc);box-shadow:0 2px 12px rgba(0,0,0,.6)}
@keyframes nrm-drift{to{background-position:220% 0}}
.nrm-badge{position:absolute;left:9px;top:7px;padding:1px 8px;border-radius:9px;font-weight:800;font-size:9px;
letter-spacing:.09em;background:rgba(6,4,12,.55);border:1px solid var(--acc);color:var(--acc);backdrop-filter:blur(6px)}
.nrm-tools{position:absolute;right:6px;top:6px;display:flex;gap:4px}
.nrm-icon{width:20px;height:20px;padding:0;line-height:1;display:grid;place-items:center;font-size:11px;
border-radius:7px;border:1px solid rgba(167,139,250,.3);background:rgba(8,5,16,.6);color:var(--dim);
cursor:pointer;backdrop-filter:blur(6px);transition:.15s}
.nrm-icon:hover{color:#fff;border-color:var(--acc);background:var(--acc-soft);transform:translateY(-1px)}
.nrm-icon.on{color:var(--acc);border-color:var(--acc)}
.nrm-body{display:flex;flex-direction:column;gap:6px}
.nrm-row{display:flex;flex-wrap:wrap;gap:5px;align-items:center}
.nrm-chip{padding:1px 9px;border-radius:10px;font-size:10px;font-weight:700;border:1px solid rgba(167,139,250,.2);
color:var(--dim);background:rgba(124,92,255,.07);cursor:default;transition:.15s;white-space:nowrap}
.nrm-chip.pick{cursor:pointer}
.nrm-chip.pick:hover{color:#fff;border-color:var(--c,var(--lil));transform:translateY(-1px)}
.nrm-chip.on{color:var(--c,var(--lil));border-color:var(--c,var(--lil));background:var(--c-soft,rgba(124,92,255,.16))}
.nrm-chip.ok{color:var(--ok);border-color:rgba(52,211,153,.65);background:rgba(52,211,153,.12)}
.nrm-chip.miss{color:var(--warn);border-color:rgba(251,191,36,.7);background:rgba(251,191,36,.12);cursor:pointer}
.nrm-chip.bad{color:var(--bad);border-color:rgba(248,113,113,.7);background:rgba(248,113,113,.12)}
.nrm-chip.info{color:var(--info);border-color:rgba(96,165,250,.6);background:rgba(96,165,250,.12)}
.nrm-chip .dot{display:inline-block;width:5px;height:5px;border-radius:50%;background:currentColor;margin-right:5px;
vertical-align:middle;box-shadow:0 0 6px currentColor}
.nrm-card{display:flex;gap:9px;align-items:center;padding:5px 8px 5px 5px;border-radius:10px;cursor:pointer;
background:linear-gradient(100deg,#241b3f,#1a1430 65%,#191233);border:1px solid var(--line);
transition:border-color .15s,transform .15s,box-shadow .15s;animation:nrm-in .22s ease both}
.nrm-card:hover{border-color:var(--c,var(--lil));transform:translateX(2px);box-shadow:-2px 0 0 0 var(--c,var(--lil))}
@keyframes nrm-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
.nrm-thumb{width:38px;height:38px;border-radius:8px;flex:none;object-fit:cover;display:flex;align-items:center;
justify-content:center;font-weight:800;font-size:16px;color:rgba(255,255,255,.94);overflow:hidden;
background:linear-gradient(135deg,var(--c,var(--vio)),#22d3ee)}
.nrm-thumb img{width:100%;height:100%;object-fit:cover;display:block}
.nrm-main{flex:1;min-width:0}
.nrm-name{font-weight:700;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.nrm-sub{color:var(--dim);font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.nrm-side{display:flex;align-items:center;gap:4px;flex:none}
.nrm-slot{width:16px;height:16px;border-radius:5px;display:grid;place-items:center;font-size:9px;font-weight:800;
color:#0d0a16;background:linear-gradient(140deg,var(--lil),#22d3ee)}
.nrm-x{width:17px;height:17px;padding:0;border-radius:6px;border:1px solid rgba(248,113,113,.35);
background:rgba(248,113,113,.1);color:#f87171;font-size:11px;line-height:1;cursor:pointer;display:grid;place-items:center}
.nrm-x:hover{background:rgba(248,113,113,.28);color:#fff;border-color:#f87171}
.nrm-empty{padding:10px;border-radius:10px;border:1px dashed rgba(167,139,250,.28);color:var(--dim);
text-align:center;display:flex;flex-direction:column;gap:7px;align-items:center;
background:radial-gradient(120% 100% at 50% 0%,rgba(124,92,255,.1),transparent 70%)}
.nrm-btn{padding:3px 12px;border-radius:9px;font-size:10px;font-weight:800;letter-spacing:.02em;cursor:pointer;
color:#0d0a16;border:0;background:linear-gradient(100deg,var(--lil),#22d3ee 55%,var(--acc));
box-shadow:0 3px 12px -4px var(--acc);transition:.15s}
.nrm-btn:hover{filter:brightness(1.12);transform:translateY(-1px);box-shadow:0 6px 16px -5px var(--acc)}
.nrm-btn.ghost{background:rgba(124,92,255,.12);color:var(--lil);border:1px solid rgba(167,139,250,.32);box-shadow:none}
.nrm-btn.ghost:hover{color:#fff;border-color:var(--acc);background:var(--acc-soft)}
.nrm-meter{height:6px;border-radius:4px;background:rgba(124,92,255,.12);overflow:hidden;position:relative}
.nrm-meter>i{display:block;height:100%;border-radius:4px;background:linear-gradient(90deg,var(--vio),#22d3ee 60%,var(--acc));
transition:width .35s cubic-bezier(.2,.8,.2,1)}
.nrm-meter.over>i{background:linear-gradient(90deg,var(--vio),var(--warn) 70%,var(--bad))}
.nrm-time{display:flex;height:16px;border-radius:8px;overflow:hidden;border:1px solid var(--line);font-size:9px;font-weight:800}
.nrm-time>span{display:grid;place-items:center;white-space:nowrap;overflow:hidden;transition:flex-basis .25s}
.nrm-time .a{background:linear-gradient(90deg,var(--acc-soft),var(--acc));color:#0d0a16}
.nrm-time .b{background:rgba(124,92,255,.1);color:var(--dim)}
.nrm-foot{color:var(--dim);font-size:10px;display:flex;justify-content:space-between;align-items:center;gap:8px;
padding-top:1px;border-top:1px solid rgba(167,139,250,.12)}
.nrm-foot>span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.nrm-warn{color:var(--warn);font-size:10px;line-height:1.4;padding:4px 8px;border-radius:8px;
background:rgba(251,191,36,.09);border:1px solid rgba(251,191,36,.28)}
.nrm-toast{display:flex;align-items:center;gap:8px;padding:4px 8px;border-radius:9px;font-size:10px;font-weight:700;
color:var(--ok);background:rgba(52,211,153,.1);border:1px solid rgba(52,211,153,.35);animation:nrm-in .18s ease both}
.nrm-toast span{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nrm-toast.bad{color:var(--bad);background:rgba(248,113,113,.1);border-color:rgba(248,113,113,.35)}
.nrm-pick{border-radius:11px;border:1px solid var(--line);overflow:hidden;background:linear-gradient(180deg,#1c1533,#141026);
animation:nrm-in .2s ease both;box-shadow:0 10px 26px -14px #000}
.nrm-pick-head{display:flex;align-items:center;gap:6px;padding:6px 8px;
background:linear-gradient(100deg,rgba(124,92,255,.3),rgba(244,114,182,.18) 60%,rgba(34,211,238,.2));
border-bottom:1px solid var(--line)}
.nrm-pick-head b{flex:1;font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:#fff}
.nrm-pick-body{padding:7px 8px;display:flex;flex-direction:column;gap:6px}
.nrm-input{width:100%;padding:4px 9px;border-radius:8px;font:11px/1.4 system-ui,sans-serif;color:var(--txt);
background:#0d0a16;border:1px solid var(--line);outline:none;user-select:text;-webkit-user-select:text}
.nrm-input:focus{border-color:var(--acc);box-shadow:0 0 0 2px var(--acc-soft)}
.nrm-input::placeholder{color:#6f6690}
.nrm-list{max-height:184px;overflow-y:auto;overflow-x:hidden;display:flex;flex-direction:column;gap:3px;padding-right:2px}
.nrm-scroll{scrollbar-width:thin;scrollbar-color:#7c5cff rgba(124,92,255,.1)}
.nrm-scroll::-webkit-scrollbar{width:8px;height:8px}
.nrm-scroll::-webkit-scrollbar-track{background:rgba(124,92,255,.1);border-radius:8px}
.nrm-scroll::-webkit-scrollbar-thumb{border-radius:8px;border:2px solid transparent;background-clip:padding-box;
background-image:linear-gradient(180deg,#7c5cff,#a78bfa)}
.nrm-scroll::-webkit-scrollbar-thumb:hover{background-image:linear-gradient(180deg,#22d3ee,#7c5cff)}
.nrm-scroll::-webkit-scrollbar-corner{background:transparent}
.nrm-opt{display:flex;align-items:center;gap:8px;padding:4px 6px;border-radius:8px;cursor:pointer;
border:1px solid transparent;background:rgba(124,92,255,.05)}
.nrm-opt:hover,.nrm-opt.hi{background:var(--acc-soft);border-color:var(--c,var(--lil))}
.nrm-opt .nrm-thumb{width:26px;height:26px;border-radius:6px;font-size:12px}
.nrm-opt .nrm-name{font-size:11px}
.nrm-pick-empty{padding:14px;text-align:center;color:var(--dim);font-size:10px}
.nrm-hint{color:#6f6690;font-size:9px;text-align:center;letter-spacing:.03em}
.nrm-busy{animation:nrm-pulse 1.1s ease-in-out infinite}
@keyframes nrm-pulse{0%,100%{box-shadow:0 0 0 0 var(--acc-soft)}50%{box-shadow:0 0 0 3px var(--acc-soft)}}
@media (prefers-reduced-motion:reduce){
.nrm-root *,.nrm-root{animation:none!important;transition:none!important}}
`;
  document.head.appendChild(s);
}

// ───────────────────────────── library ─────────────────────────────
const LIB = { models: new Map(), refmods: new Map(), t: 0, busy: null, error: null };
const panels = new Set();

function refreshCombos() {
  const nodes = app.graph?._nodes;
  if (!nodes) return;
  const names = [...LIB.refmods.keys()].sort(cmp);
  const all = [NONE, ...names];
  const qwen = [NONE, ...[...LIB.refmods.values()].filter((e) => e.model === "qwen21").map((e) => e.name).sort(cmp)];
  for (const n of nodes) {
    if (!n?.widgets) continue;
    const list = n.type === "NouganUnifiedRefModApply" ? all : n.type === LEGACY_QWEN ? qwen : null;
    if (!list) continue;
    for (const s of SLOTS) {
      const w = W(n, s);
      if (!w) continue;
      if (!w.options) w.options = {};
      // Keep a stale selection visible instead of silently rewriting a saved workflow value.
      w.options.values = w.value && w.value !== NONE && !list.includes(w.value) ? [w.value, ...list] : list.slice();
    }
  }
}

function loadLib(force = false) {
  if (LIB.busy) return LIB.busy;
  if (!force && Date.now() - LIB.t < LIB_TTL) return Promise.resolve();
  LIB.busy = api.fetchApi("/nougan/refmod_lib")
    .then((r) => r.json())
    .then((d) => {
      LIB.error = d?.error || null;
      LIB.models = new Map((d?.models || []).map((m) => [m.key, m]));
      LIB.refmods = new Map((d?.refmods || []).map((e) => [e.name, e]));
      LIB.t = Date.now();
      refreshCombos();
      for (const p of [...panels]) { p.refresh(); p.renderPickerList(); }
    })
    .catch((e) => { LIB.error = String(e?.message || e); })
    .finally(() => { LIB.busy = null; });
  return LIB.busy;
}

setInterval(() => { if (panels.size && !document.hidden) loadLib(true); }, POLL_MS);

const thumbURL = (e) => api.apiURL(`/nougan/refmod_lib/thumb?name=${encodeURIComponent(e.name)}&v=${e.stamp}`);
const BMP = new Map();
function thumbBitmap(e) {
  if (!e?.thumb || !CAN_BITMAP) return Promise.resolve(null);
  const key = `${e.name}|${e.stamp}`;
  if (!BMP.has(key)) {
    if (BMP.size > 96) BMP.delete(BMP.keys().next().value);
    BMP.set(key, api.fetchApi(thumbURL(e))
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => (b ? createImageBitmap(b) : null))
      .catch(() => null));
  }
  return BMP.get(key);
}

// ───────────────────────────── WebGPU strip ─────────────────────────────
const WGSL = /* wgsl */ `
struct U { res: vec2f, time: f32, count: f32, accent: vec4f, m: vec4f, e: vec4f };
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var smp: sampler;
@group(0) @binding(2) var t0: texture_2d<f32>;
@group(0) @binding(3) var t1: texture_2d<f32>;
@group(0) @binding(4) var t2: texture_2d<f32>;

@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}

fn hash(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453); }
fn noise(p: vec2f) -> f32 {
  let i = floor(p); let f = fract(p); let w = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2f(1.0, 0.0)), w.x),
             mix(hash(i + vec2f(0.0, 1.0)), hash(i + vec2f(1.0, 1.0)), w.x), w.y);
}
fn fbm(p: vec2f) -> f32 {
  var a = 0.5; var s = 0.0; var q = p;
  for (var i = 0; i < 4; i++) { s += a * noise(q); q = q * 2.03 + vec2f(17.1, 9.2); a *= 0.5; }
  return s;
}
fn sdRound(p: vec2f, b: vec2f, r: f32) -> f32 {
  let q = abs(p) - b + vec2f(r);
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - r;
}
fn slot(i: i32, uv: vec2f) -> vec4f {
  switch i {
    case 0: { return textureSampleLevel(t0, smp, uv, 0.0); }
    case 1: { return textureSampleLevel(t1, smp, uv, 0.0); }
    default: { return textureSampleLevel(t2, smp, uv, 0.0); }
  }
}
fn aspectOf(i: i32) -> f32 {
  if (i == 0) { return u.m.y; }
  if (i == 1) { return u.m.z; }
  return u.m.w;
}

@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let dpr = u.e.x;
  let busy = u.e.y;
  let load = u.e.z;
  let px = pos.xy;
  let uv = px / u.res;
  let t = u.time * (1.0 + 0.75 * busy);
  // over budget the aurora heats up toward amber — the strip is a live readout, not decoration
  let acc = mix(u.accent.rgb, vec3f(1.0, 0.72, 0.25), clamp(load - 1.0, 0.0, 1.0) * 0.85);

  let n = fbm(vec2f(uv.x * 5.0 + t * 0.07, uv.y * 2.2 - t * 0.05));
  let n2 = fbm(vec2f(uv.x * 3.0 - t * 0.04 + n, uv.y * 3.0 + t * 0.06));
  var col = mix(vec3f(0.055, 0.04, 0.095), acc * 0.55, smoothstep(0.24, 0.86, n2));
  col += acc * 0.10 * pow(1.0 - uv.y, 3.0);
  col += vec3f(0.30, 0.20, 0.55) * 0.06 * fbm(vec2f(uv.x * 2.0 - t * 0.02, uv.y * 1.4));

  let g = abs(fract(px / (14.0 * dpr)) - vec2f(0.5));
  col += vec3f(0.012) * smoothstep(0.46, 0.5, max(g.x, g.y));

  let pad = 8.0 * dpr;
  let h = u.res.y - 2.0 * pad;
  var x = 12.0 * dpr;
  for (var i = 0; i < 3; i++) {
    if (f32(i) >= u.count) { break; }
    let w = h * clamp(aspectOf(i), 0.55, 1.7);
    let c = vec2f(x + w * 0.5, u.res.y * 0.5);
    let d = sdRound(px - c, vec2f(w * 0.5, h * 0.5), 9.0 * dpr);
    let hov = select(0.0, 1.0, abs(u.m.x - f32(i)) < 0.5);
    col *= 1.0 - 0.45 * (1.0 - smoothstep(0.0, 14.0 * dpr, d)) * step(0.0, d);
    if (d < 0.0) {
      let l = (px - vec2f(x, pad)) / vec2f(w, h);
      let sweep = fract(t * 0.22 + f32(i) * 0.31);
      let band = 1.0 - smoothstep(0.0, 0.10, abs(l.x * 0.8 + l.y * 0.35 - (sweep * 1.6 - 0.2)));
      let ca = (0.0025 + 0.006 * hov) * (1.0 + band * 3.0);
      let r = slot(i, l + vec2f(ca, 0.0)).r;
      let gg = slot(i, l).g;
      let b = slot(i, l - vec2f(ca, 0.0)).b;
      var tc = vec3f(r, gg, b);
      tc *= 0.86 + 0.14 * hov;
      tc += acc * band * 0.35;
      tc *= 0.94 + 0.06 * sin(px.y / (2.0 * dpr) + t * 3.0);
      let rim = smoothstep(-3.0 * dpr, 0.0, d);
      col = mix(tc, acc * 1.2, rim * (0.55 + 0.35 * hov));
    } else {
      col += acc * 0.5 * (1.0 - smoothstep(0.0, 3.0 * dpr, d)) * (0.25 + 0.5 * hov);
    }
    x += w + 10.0 * dpr;
  }

  // execution pulse sweeping the whole strip while this node runs
  let head = fract(u.time * 0.55);
  col += acc * busy * 0.30 * (1.0 - smoothstep(0.0, 0.14, abs(uv.x - head)));

  let v = 1.0 - smoothstep(0.35, 1.15, length((uv - vec2f(0.5)) * vec2f(1.0, 1.6)));
  col *= 0.7 + 0.3 * v;
  return vec4f(col, 1.0);
}
`;

let GPU = null;
let GPU_GEN = 0;

function getGpu() {
  if (GPU) return GPU;
  GPU = (async () => {
    if (!navigator.gpu || !CAN_BITMAP) return null;
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "low-power" });
    if (!adapter) return null;
    const dev = await adapter.requestDevice();
    const format = navigator.gpu.getPreferredCanvasFormat();
    const module = dev.createShaderModule({ code: WGSL });
    const info = await module.getCompilationInfo?.();
    if (info?.messages?.some((m) => m.type === "error")) {
      console.warn("[Nougan RefMods] WGSL error", info.messages.map((m) => `${m.lineNum}: ${m.message}`));
      return null;
    }
    const pipeline = dev.createRenderPipeline({
      layout: "auto",
      vertex: { module, entryPoint: "vs" },
      fragment: { module, entryPoint: "fs", targets: [{ format }] },
      primitive: { topology: "triangle-list" },
    });
    const sampler = dev.createSampler({
      magFilter: "linear", minFilter: "linear",
      addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge",
    });
    const dummy = dev.createTexture({
      size: [1, 1], format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    dev.queue.writeTexture({ texture: dummy }, new Uint8Array([22, 17, 34, 255]), { bytesPerRow: 4 }, [1, 1]);
    const gen = ++GPU_GEN;
    dev.lost.then((i) => {
      if (i?.reason === "destroyed" || gen !== GPU_GEN) return;
      GPU = null;
      for (const p of [...panels]) p.strip?.lost();
    });
    return { dev, format, pipeline, sampler, dummy, gen };
  })().catch((e) => { console.warn("[Nougan RefMods] WebGPU unavailable —", e?.message || e); return null; });
  return GPU;
}

class Strip {
  constructor(root) {
    this.root = root;
    this.canvas = el("canvas");
    this.fb = el("div", "nrm-fb");
    this.badge = el("span", "nrm-badge", "");
    this.tools = el("div", "nrm-tools");
    root.append(this.canvas, this.fb, this.badge, this.tools);
    this.ok = false; this.dead = false; this.visible = true;
    this.hover = -1; this.count = 0; this.busy = 0; this.load = 0;
    this.asp = [1, 1, 1];
    this.textures = [null, null, null];
    this.accent = hexRGB(ACCENT).map((v) => v / 255);
    this.seq = 0; this.gen = -1; this.g = null;
    this.io = new IntersectionObserver((es) => { this.visible = es.some((e) => e.isIntersecting); });
    this.io.observe(root);
    this.init();
  }

  async init() {
    const g = await getGpu();
    if (this.dead) return;
    if (!g) return this.fallback();
    try {
      this.g = g; this.gen = g.gen;
      this.ctx = this.canvas.getContext("webgpu");
      if (!this.ctx) return this.fallback();
      this.ctx.configure({ device: g.dev, format: g.format, alphaMode: "premultiplied" });
      this.ubuf = g.dev.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.ok = true;
      this.fb.style.display = "none";
      this.canvas.style.display = "block";
      this.bind();
    } catch (e) {
      console.warn("[Nougan RefMods] strip init failed", e);
      this.fallback();
    }
  }

  fallback() {
    this.ok = false;
    this.canvas.style.display = "none";
    this.fb.style.display = "flex";
  }

  lost() {
    this.ok = false;
    this.textures = [null, null, null];
    this.count = 0;
    this.init();
  }

  setAccent(hex) {
    const h = hex || ACCENT;
    this.accent = hexRGB(h).map((v) => v / 255);
    this.root.style.setProperty("--acc", h);
    this.root.style.setProperty("--acc-soft", css(h, 0.25));
  }

  setBusy(b) { this.busy = b ? 1 : 0; this.root.classList.toggle("nrm-busy", !!b); }
  setLoad(v) { this.load = clamp(Number(v) || 0, 0, 2); }

  async setItems(items) {
    const seq = ++this.seq;
    this.fb.replaceChildren(...items.map((i) => { const im = el("img"); im.src = i.url; im.alt = ""; return im; }));
    if (!this.ok || !this.g) return;
    const bitmaps = await Promise.all(items.map((i) => i.bitmap));
    if (seq !== this.seq || this.dead || !this.ok || !this.g) return;
    for (const t of this.textures) t?.destroy();
    this.textures = [null, null, null];
    this.count = 0;
    try {
      const { dev } = this.g;
      for (const bmp of bitmaps.slice(0, 3)) {
        if (!bmp) continue;
        const t = dev.createTexture({
          size: [bmp.width, bmp.height], format: "rgba8unorm",
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
        });
        dev.queue.copyExternalImageToTexture({ source: bmp }, { texture: t }, [bmp.width, bmp.height]);
        this.asp[this.count] = bmp.width / Math.max(1, bmp.height);
        this.textures[this.count++] = t;
      }
      this.bind();
    } catch (e) {
      this.count = 0;
      this.fallback();
    }
  }

  bind() {
    if (!this.g || !this.ubuf) return;
    const { dev, pipeline, sampler, dummy } = this.g;
    const view = (i) => (this.textures[i] || dummy).createView();
    this.bg = dev.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.ubuf } },
        { binding: 1, resource: sampler },
        { binding: 2, resource: view(0) },
        { binding: 3, resource: view(1) },
        { binding: 4, resource: view(2) },
      ],
    });
  }

  render(t) {
    if (!this.ok || !this.g || !this.bg || this.gen !== this.g.gen) return;
    const { dev, pipeline } = this.g;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(this.canvas.clientWidth * dpr);
    const h = Math.round(this.canvas.clientHeight * dpr);
    if (w < 2 || h < 2) return;
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    try {
      dev.queue.writeBuffer(this.ubuf, 0, new Float32Array([
        w, h, REDUCED ? t * 0.12 : t, this.count,
        this.accent[0], this.accent[1], this.accent[2], 1,
        this.hover, this.asp[0], this.asp[1], this.asp[2],
        dpr, this.busy, this.load, 0,
      ]));
      const enc = dev.createCommandEncoder();
      const pass = enc.beginRenderPass({
        colorAttachments: [{
          view: this.ctx.getCurrentTexture().createView(),
          loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 },
        }],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, this.bg);
      pass.draw(3);
      pass.end();
      dev.queue.submit([enc.finish()]);
    } catch (_) {
      this.ok = false;
      this.fallback();
    }
  }

  destroy() {
    this.dead = true;
    this.seq++;
    this.io.disconnect();
    for (const t of this.textures) t?.destroy();
    this.textures = [null, null, null];
    try { this.ubuf?.destroy(); } catch (_) { /* already gone */ }
    try { this.ctx?.unconfigure(); } catch (_) { /* ignore */ }
  }
}

let lastFrame = 0;
function tick(ms) {
  requestAnimationFrame(tick);
  if (document.hidden || ms - lastFrame < 33) return;      // ~30 fps, idle when hidden
  const scale = app.canvas?.ds?.scale ?? 1;
  if (scale < 0.32) return;                                // too small to read: stop burning frames
  lastFrame = ms;
  for (const p of [...panels]) {
    const s = p.strip;
    if (s.ok && s.visible && s.g) s.render(ms / 1000);
  }
}
requestAnimationFrame(tick);

// ───────────────────────────── panel ─────────────────────────────
class Panel {
  constructor(node, kind) {
    injectCSS();
    this.node = node;
    this.kind = kind;
    this.dead = false;
    this.h = STRIP_H + 110;
    this.collapsed = store(`nougan.refmods.collapsed.${kind}`) === "1";
    this.toast = null;
    this.toastTimer = 0;
    this.picker = null;
    this.pickerEl = null;
    this.flash = null;
    this._sizeSig = "";
    this._stripSig = "";

    this.el = el("div", "nrm-root");
    const stripBox = el("div", "nrm-strip");
    this.strip = new Strip(stripBox);
    this.body = el("div", "nrm-body");
    this.foot = el("div", "nrm-foot");

    this.btnRefresh = button("nrm-icon", "↻", "Reload the RefMod library", () => {
      this.btnRefresh.classList.add("on");
      loadLib(true).finally(() => this.btnRefresh.classList.remove("on"));
    });
    this.btnFold = button("nrm-icon", this.collapsed ? "▸" : "▾", "Collapse / expand the console", () => {
      this.collapsed = !this.collapsed;
      store(`nougan.refmods.collapsed.${kind}`, this.collapsed ? "1" : "0");
      this.btnFold.textContent = this.collapsed ? "▸" : "▾";
      if (this.collapsed) this.closePicker();
      this.refresh();
      this.syncSize(true);
    });
    this.strip.tools.append(this.btnRefresh, this.btnFold);

    this.el.append(stripBox, this.body, this.foot);
    guard(this.body);
    guard(this.foot);
    guard(this.strip.tools);
    panels.add(this);
  }

  height() { return this.h; }

  setBusy(b) {
    this.strip.setBusy(b);
    if (b && this.collapsed) this.strip.badge.textContent = "WORKING…";
    else this.refresh();
  }

  // ── state ────────────────────────────────────────────────────────
  state() {
    const n = this.node, apply = this.kind === "apply";
    const sel = W(n, "model")?.value;
    let slots = [];
    if (apply) {
      slots = SLOTS
        .map((k, i) => ({ key: k, i, name: W(n, k)?.value }))
        .filter((s) => s.name && s.name !== NONE)
        .map((s) => ({ ...s, e: LIB.refmods.get(s.name) }));
    } else {
      const name = String(W(n, "name")?.value ?? "").trim();
      const sub = String(W(n, "subfolder")?.value ?? "").trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
      const m = LIB.models.get(sel);
      const folder = sub || m?.subfolder || "";
      const key = name ? (folder ? `${folder}/${name}` : name) : "";
      this.target = key ? `models/refmods/${key}.safetensors` : "";
      const e = key ? LIB.refmods.get(key) : null;
      if (e) slots = [{ key: "target", i: 0, name: key, e }];
    }
    const eff = apply && sel === AUTO ? slots.find((s) => s.e)?.e.model : sel;
    return { sel, slots, eff, mdl: LIB.models.get(eff) };
  }

  firstEmptySlot() {
    for (let i = 0; i < SLOTS.length; i++) {
      const v = W(this.node, SLOTS[i])?.value;
      if (!v || v === NONE) return i;
    }
    return 0;
  }

  // ── render ───────────────────────────────────────────────────────
  refresh() {
    if (this.dead) return;
    const n = this.node, apply = this.kind === "apply";
    const st = this.state();
    this._st = st;
    const { mdl, slots } = st;
    const accent = mdl?.accent || ACCENT;
    this.el.style.setProperty("--acc", accent);
    this.el.style.setProperty("--acc-soft", css(accent, 0.18));
    this.strip.setAccent(accent);
    this.strip.badge.textContent = mdl ? mdl.label.toUpperCase() : apply ? "REFMOD" : "BAKE";

    // 1) hide widgets that do nothing for this model (never remove, never reorder)
    const uses = mdl ? new Set(apply ? mdl.apply_uses : mdl.bake_uses) : null;
    let changed = false;
    for (const name of apply ? APPLY_COND : BAKE_COND) {
      changed = setHidden(W(n, name), uses ? !uses.has(name) : false) || changed;
    }
    if (apply) {
      // conditioning models (Flux 3) take an encoded prompt: the text boxes are dead weight there
      const condModel = !!mdl?.apply_needs?.includes("positive");
      for (const name of APPLY_TEXT) changed = setHidden(W(n, name), mdl ? condModel : false) || changed;
    }
    this._changed = changed;

    // 2) strip contents + live load
    const shown = slots.filter((s) => s.e?.thumb).slice(0, 3);
    const stripSig = shown.map((s) => `${s.e.name}|${s.e.stamp}`).join(",");
    if (stripSig !== this._stripSig) {
      this._stripSig = stripSig;
      this.strip.setItems(shown.map((s) => ({ bitmap: thumbBitmap(s.e), url: thumbURL(s.e) })));
    }

    const total = apply
      ? slots.reduce((a, s) => a + (s.e?.tokens || 0), 0)
      : (slots[0]?.e?.tokens || this.estimateTokens());
    this.strip.setLoad(total / TOKEN_BUDGET);

    // 3) body
    this.body.replaceChildren();
    if (this.collapsed) {
      this.body.style.display = "none";
      this.foot.style.display = "none";
      this.syncSize();
      return;
    }
    this.body.style.display = "flex";
    this.foot.style.display = "flex";

    const warns = [];
    this.body.append(this.modelRow(st));

    if (apply) {
      if (!slots.length) {
        const box = el("div", "nrm-empty");
        box.append(el("div", "", "No reference loaded — pick one from the library, or choose a model and wire extra_image."));
        box.append(button("nrm-btn", "Browse library", "Search every baked RefMod", () => this.openPicker(0)));
        this.body.append(box);
      } else {
        slots.forEach((s, i) => this.body.append(this.card(s, i, mdl, warns)));
        if (slots.length < SLOTS.length) {
          const row = el("div", "nrm-row");
          row.append(button("nrm-btn ghost", "＋ add reference", "Fill the next free slot", () => this.openPicker(this.firstEmptySlot())));
          this.body.append(row);
        }
      }
      if (total) this.body.append(this.meter(total));
      const strength = Number(W(n, "ref_strength")?.value ?? 1);
      if (mdl && strength < 1) this.body.append(this.timeline(strength, !!W(n, "ref_on_negative")?.value));
      const nrefs = slots.reduce((a, s) => a + (s.e?.count || 0), 0);
      if (mdl && nrefs > mdl.max_refs) warns.push(`${nrefs} references — ${mdl.label} supports ${mdl.max_refs}`);
      const models = new Set(slots.map((s) => s.e?.model).filter(Boolean));
      if (models.size > 1) warns.push("mixed models across refmod_1..3");
      if (slots.some((s) => !s.e)) warns.push("a selected file is not in the library — press ↻");
      if (total > TOKEN_BUDGET) warns.push(`${fmt(total)} reference tokens per step is heavy — lower the bake resolution`);
      this.foot.replaceChildren(
        el("span", "", total ? `${fmt(total)} reference tokens / step` : "no references"),
        el("span", "", mdl ? `max ${mdl.max_refs} refs` : "")
      );
    } else {
      const ex = slots[0];
      if (ex) this.body.append(this.card(ex, 0, mdl, warns, "exists"));
      else {
        const box = el("div", "nrm-empty");
        box.append(el("div", "", this.target ? "New file — nothing baked at this path yet." : "Give the RefMod a name to see its target path."));
        this.body.append(box);
      }
      const res = Number(W(n, "resolution")?.value ?? 0);
      const per = this.estimateTokens();
      this.body.append(this.meter(per * Math.max(1, this.imageInputCount())));
      const info = el("div", "nrm-row");
      info.append(el("span", "nrm-chip info", res > 0 ? `≈${fmt(per)} tokens / reference @ ${res}px` : "native size — tokens depend on the image"));
      if (mdl) info.append(el("span", "nrm-chip", `${this.imageInputCount()} image input${this.imageInputCount() === 1 ? "" : "s"} wired`));
      this.body.append(info);
      if (ex && !W(n, "overwrite")?.value) warns.push("file exists — it will be skipped unless overwrite is on");
      if (!linked(n, "images")) warns.push("wire images: nothing to bake");
      const path = el("span", "nrm-sel", this.target || "—");
      path.title = this.target || "";
      this.foot.replaceChildren(path, button("nrm-btn ghost", "copy path", "Copy the target path", () => this.copyPath()));
    }

    // 4) what to connect
    if (mdl) {
      const needs = (apply ? mdl.apply_needs : mdl.bake_needs).slice();
      if (apply && linked(n, "extra_image") && !needs.includes("vae")) needs.push("vae");
      if (!apply && !needs.includes("images")) needs.push("images");
      if (needs.length) {
        const row = el("div", "nrm-row");
        row.append(el("span", "nrm-sub", "connect:"));
        for (const k of needs) {
          const ok = linked(n, k);
          const chip = el("span", `nrm-chip ${ok ? "ok" : "miss"}`, k);
          if (!ok) {
            chip.title = `Click to highlight the ${k} socket`;
            guard(chip);
            chip.addEventListener("click", () => this.flashInput(k));
            warns.push(`${k} is not connected`);
          }
          row.append(chip);
        }
        this.body.append(row);
      }
    }

    if (LIB.error) warns.push(`library: ${LIB.error}`);
    if (warns.length) this.body.append(el("div", "nrm-warn", "⚠ " + warns.slice(0, 3).join(" · ")));
    if (this.toast) this.body.append(this.toastEl());

    this.syncSize();
    requestAnimationFrame(() => { if (!this.dead) this.syncSize(); });
  }

  imageInputCount() {
    let c = 0;
    for (const k of ["images", "image_2", "image_3", "image_4"]) if (linked(this.node, k)) c++;
    return Math.max(1, c);
  }

  estimateTokens() {
    const res = Number(W(this.node, "resolution")?.value ?? 0);
    const ds = this._st?.mdl?.token_downscale || 16;
    if (!(res > 0)) return 0;
    const side = Math.max(32, Math.round(res / 32) * 32);
    return Math.round((side / ds) * (side / ds));
  }

  modelRow(st) {
    const apply = this.kind === "apply";
    const row = el("div", "nrm-row");
    const mk = (key, label, accent, on, detected) => {
      const c = el("span", "nrm-chip pick" + (on ? " on" : ""));
      if (detected) c.append(el("i", "dot"));
      c.append(document.createTextNode(label));
      c.style.setProperty("--c", accent);
      c.style.setProperty("--c-soft", css(accent, 0.16));
      c.title = detected ? `${label} — detected from the RefMod file` : `Use ${label}`;
      guard(c);
      c.addEventListener("click", () => { callWidget(W(this.node, "model"), key); this.refresh(); });
      return c;
    };
    if (apply) row.append(mk(AUTO, "auto", ACCENT, st.sel === AUTO, false));
    for (const m of LIB.models.values()) {
      const on = st.sel === m.key;
      const detected = apply && st.sel === AUTO && st.eff === m.key;
      row.append(mk(m.key, m.label, m.accent, on || detected, detected));
    }
    if (!LIB.models.size) row.append(el("span", "nrm-chip miss", "loading library…"));
    return row;
  }

  meter(value) {
    const over = value > TOKEN_BUDGET;
    const m = el("div", "nrm-meter" + (over ? " over" : ""));
    const bar = el("i");
    bar.style.width = `${clamp((value / TOKEN_BUDGET) * 100, 2, 100)}%`;
    m.append(bar);
    m.title = `${fmt(value)} of ${fmt(TOKEN_BUDGET)} reference tokens per step`;
    return m;
  }

  timeline(strength, onNeg) {
    const pct = Math.round(clamp(strength, 0, 1) * 100);
    const wrap = el("div");
    const bar = el("div", "nrm-time");
    const a = el("span", "a", pct >= 22 ? `refs ${pct}%` : "");
    a.style.flex = `0 0 ${pct}%`;
    const b = el("span", "b", 100 - pct >= 26 ? `prompt alone ${100 - pct}%` : "");
    b.style.flex = `1 1 auto`;
    bar.append(a, b);
    wrap.append(bar);
    const row = el("div", "nrm-row");
    row.append(el("span", "nrm-chip", `references stop at ${pct}% of the steps`));
    row.append(el("span", "nrm-chip " + (onNeg ? "info" : ""), onNeg ? "refs → positive + negative" : "refs → positive only"));
    wrap.append(row);
    return wrap;
  }

  card(s, i, mdl, warns, tag) {
    const e = s.e;
    const m = LIB.models.get(e?.model) || mdl;
    const accent = m?.accent || ACCENT;
    const c = el("div", "nrm-card");
    c.style.setProperty("--c", accent);
    c.style.animationDelay = `${i * 45}ms`;
    c.onmouseenter = () => { this.strip.hover = i; };
    c.onmouseleave = () => { this.strip.hover = -1; };

    const t = el("div", "nrm-thumb");
    const letter = (base(s.name).charAt(0) || "?").toUpperCase();
    if (e?.thumb) {
      const im = el("img");
      im.alt = "";
      im.src = thumbURL(e);
      im.onerror = () => { im.remove(); t.textContent = letter; };
      t.append(im);
    } else t.textContent = letter;

    const main = el("div", "nrm-main");
    main.append(el("div", "nrm-name", base(s.name)));
    const dims = e?.sizes?.length
      ? ` · ${e.sizes.slice(0, 2).map(([w, h]) => `${w}×${h}`).join(", ")}${e.sizes.length > 2 ? "…" : ""}`
      : "";
    main.append(el("div", "nrm-sub", e
      ? `${e.count} ref${e.count === 1 ? "" : "s"}${dims}${e.tokens ? ` · ${fmt(e.tokens)} tok` : ""}`
      : "not found in the library — press ↻"));

    const side = el("div", "nrm-side");
    if (e) {
      const chip = el("span", "nrm-chip on", tag === "exists" ? "baked" : (m?.label || e.model));
      chip.style.setProperty("--c", accent);
      chip.style.setProperty("--c-soft", css(accent, 0.16));
      side.append(chip);
      const sel = W(this.node, "model")?.value;
      if (this.kind === "apply" && sel && sel !== AUTO && sel !== e.model) {
        side.append(el("span", "nrm-chip bad", "wrong model"));
        warns.push(`${base(s.name)} is a ${m?.label || e.model} RefMod`);
      }
    }
    if (this.kind === "apply") {
      side.append(el("span", "nrm-slot", String(s.i + 1)));
      side.append(button("nrm-x", "×", `Clear ${s.key}`, () => this.clearSlot(s.i)));
      c.title = "Click to replace this reference";
      c.addEventListener("click", () => this.openPicker(s.i));
    } else {
      c.title = "Already baked at this path";
    }
    c.append(t, main, side);
    return c;
  }

  // ── library picker ───────────────────────────────────────────────
  openPicker(slotIdx) {
    if (this.kind !== "apply" || this.dead) return;
    if (this.collapsed) { this.collapsed = false; this.btnFold.textContent = "▾"; this.refresh(); }
    if (this.pickerEl) { this.setPickerSlot(slotIdx ?? this.picker.slot); this._search?.focus(); return; }
    this.picker = { slot: slotIdx ?? this.firstEmptySlot(), q: "", filter: "all", idx: 0 };

    const root = el("div", "nrm-pick");
    const head = el("div", "nrm-pick-head");
    head.append(el("b", "", "Reference library"));
    head.append(button("nrm-icon", "×", "Close (Esc)", () => this.closePicker()));
    const body = el("div", "nrm-pick-body");

    this._slotRow = el("div", "nrm-row");
    this._search = el("input", "nrm-input");
    this._search.type = "text";
    this._search.placeholder = "search name or folder…";
    this._search.spellcheck = false;
    guard(this._search);
    for (const t of ["keydown", "keyup", "keypress"]) {
      this._search.addEventListener(t, (ev) => {
        ev.stopPropagation();                       // don't trigger the suite's hold-key gestures
        if (t !== "keydown") return;
        const items = this._pickerItems || [];
        if (ev.key === "Escape") { ev.preventDefault(); this.closePicker(); }
        else if (ev.key === "ArrowDown") { ev.preventDefault(); this.movePick(1); }
        else if (ev.key === "ArrowUp") { ev.preventDefault(); this.movePick(-1); }
        else if (ev.key === "Enter") { ev.preventDefault(); if (items[this.picker.idx]) this.assign(this.picker.slot, items[this.picker.idx].name); }
      });
    }
    this._search.addEventListener("input", () => { this.picker.q = this._search.value; this.picker.idx = 0; this.renderPickerList(); });

    this._filterRow = el("div", "nrm-row");
    this._list = el("div", "nrm-list nrm-scroll");
    guard(this._list, true);
    body.append(this._slotRow, this._search, this._filterRow, this._list, el("div", "nrm-hint", "↑↓ move · Enter pick · Esc close"));
    root.append(head, body);
    guard(root);
    this.pickerEl = root;
    this.el.insertBefore(root, this.foot);

    this.renderPickerChrome();
    this.renderPickerList();
    this.syncSize(true);
    loadLib(true).then(() => this.renderPickerList());
    requestAnimationFrame(() => { try { this._search?.focus(); } catch (_) { /* ignore */ } });
  }

  closePicker() {
    if (!this.pickerEl) return;
    this.pickerEl.remove();
    this.pickerEl = null;
    this.picker = null;
    this._pickerItems = [];
    this._search = this._list = this._slotRow = this._filterRow = null;
    this.syncSize(true);
  }

  setPickerSlot(i) {
    if (!this.picker) return;
    this.picker.slot = clamp(i, 0, SLOTS.length - 1);
    this.picker.idx = 0;
    this.renderPickerChrome();
    this.renderPickerList();
  }

  movePick(d) {
    const items = this._pickerItems || [];
    if (!items.length) return;
    this.picker.idx = clamp(this.picker.idx + d, 0, items.length - 1);
    [...this._list.children].forEach((c, i) => c.classList?.toggle("hi", i === this.picker.idx));
    const row = this._list.children[this.picker.idx];
    if (row?.scrollIntoView) row.scrollIntoView({ block: "nearest" });
  }

  renderPickerChrome() {
    if (!this.picker || !this._slotRow) return;
    this._slotRow.replaceChildren();
    SLOTS.forEach((k, i) => {
      const v = W(this.node, k)?.value;
      const label = `${i + 1} · ${v && v !== NONE ? base(v) : "empty"}`;
      const c = el("span", "nrm-chip pick" + (this.picker.slot === i ? " on" : ""), label);
      c.style.setProperty("--c", ACCENT);
      c.style.setProperty("--c-soft", css(ACCENT, 0.16));
      c.title = `Assign to ${k}`;
      guard(c);
      c.addEventListener("click", () => this.setPickerSlot(i));
      this._slotRow.append(c);
    });
    this._filterRow.replaceChildren();
    const mkFilter = (key, label, accent) => {
      const c = el("span", "nrm-chip pick" + (this.picker.filter === key ? " on" : ""), label);
      c.style.setProperty("--c", accent);
      c.style.setProperty("--c-soft", css(accent, 0.16));
      guard(c);
      c.addEventListener("click", () => { this.picker.filter = key; this.picker.idx = 0; this.renderPickerChrome(); this.renderPickerList(); });
      this._filterRow.append(c);
    };
    mkFilter("all", "all", ACCENT);
    for (const m of LIB.models.values()) mkFilter(m.key, m.label, m.accent);
  }

  renderPickerList() {
    if (!this.picker || !this._list || this.dead) return;
    const q = this.picker.q.trim().toLowerCase();
    const items = [...LIB.refmods.values()]
      .filter((e) => (this.picker.filter === "all" || e.model === this.picker.filter) && (!q || e.name.toLowerCase().includes(q)))
      .sort((a, b) => cmp(a.name, b.name));
    this._pickerItems = items;
    this.picker.idx = clamp(this.picker.idx, 0, Math.max(0, items.length - 1));
    const used = new Set(SLOTS.map((k) => W(this.node, k)?.value).filter((v) => v && v !== NONE));
    this._list.replaceChildren();
    if (!items.length) {
      this._list.append(el("div", "nrm-pick-empty", LIB.refmods.size ? "no matches" : "library is empty — bake a RefMod first"));
      this.syncSize();
      return;
    }
    items.forEach((e, i) => {
      const m = LIB.models.get(e.model);
      const accent = m?.accent || ACCENT;
      const row = el("div", "nrm-opt" + (i === this.picker.idx ? " hi" : ""));
      row.style.setProperty("--c", accent);
      const t = el("div", "nrm-thumb");
      if (e.thumb) {
        const im = el("img"); im.alt = ""; im.src = thumbURL(e);
        im.onerror = () => { im.remove(); t.textContent = (base(e.name).charAt(0) || "?").toUpperCase(); };
        t.append(im);
      } else t.textContent = (base(e.name).charAt(0) || "?").toUpperCase();
      const main = el("div", "nrm-main");
      main.append(el("div", "nrm-name", e.name));
      main.append(el("div", "nrm-sub", `${m?.label || e.model} · ${e.count} ref${e.count === 1 ? "" : "s"} · ${fmt(e.tokens || 0)} tok`));
      row.append(t, main);
      if (used.has(e.name)) row.append(el("span", "nrm-chip ok", "in use"));
      row.addEventListener("mouseenter", () => {
        this.picker.idx = i;
        [...this._list.children].forEach((c, j) => c.classList?.toggle("hi", j === i));
      });
      row.addEventListener("click", () => this.assign(this.picker.slot, e.name));
      this._list.append(row);
    });
    this.syncSize();
  }

  assign(slotIdx, name) {
    const w = W(this.node, SLOTS[slotIdx]);
    if (!w) return;
    const prev = w.value;
    callWidget(w, name);
    refreshCombos();
    this.closePicker();
    this.refresh();
    this.showToast(`${base(name)} → ${SLOTS[slotIdx]}`, () => { callWidget(w, prev); this.refresh(); });
  }

  clearSlot(i) {
    const w = W(this.node, SLOTS[i]);
    if (!w) return;
    const prev = w.value;
    callWidget(w, NONE);
    this.refresh();
    this.showToast(`cleared ${SLOTS[i]}`, () => { callWidget(w, prev); this.refresh(); });
  }

  // ── feedback ─────────────────────────────────────────────────────
  showToast(text, undo, bad) {
    clearTimeout(this.toastTimer);
    this.toast = { text, undo, bad };
    this.toastTimer = setTimeout(() => { this.toast = null; this.refresh(); }, 6000);
    this.refresh();
  }

  toastEl() {
    const t = el("div", "nrm-toast" + (this.toast.bad ? " bad" : ""));
    t.append(el("span", "", this.toast.text));
    if (this.toast.undo) {
      t.append(button("nrm-btn ghost", "undo", "Restore the previous value", () => {
        const fn = this.toast?.undo;
        clearTimeout(this.toastTimer);
        this.toast = null;
        fn?.();
      }));
    }
    t.append(button("nrm-icon", "×", "Dismiss", () => { clearTimeout(this.toastTimer); this.toast = null; this.refresh(); }));
    return t;
  }

  async copyPath() {
    const text = this.target || "";
    if (!text) return this.showToast("nothing to copy — name the RefMod first", null, true);
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch (_) {
      try {
        const ta = el("textarea");
        ta.value = text;
        ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand("copy");
        ta.remove();
      } catch (__) { ok = false; }
    }
    this.showToast(ok ? "path copied to clipboard" : "copy blocked — select the path text instead", null, !ok);
  }

  flashInput(name) {
    const i = this.node.inputs?.findIndex((x) => x.name === name) ?? -1;
    if (i < 0) return;
    this.flash = { name, until: performance.now() + 1600 };
    if (this._flashLoop) return;
    this._flashLoop = true;
    const step = () => {
      if (this.dead) { this._flashLoop = false; return; }
      this.node.setDirtyCanvas(true, false);
      if (this.flash && performance.now() < this.flash.until) requestAnimationFrame(step);
      else { this.flash = null; this._flashLoop = false; this.node.setDirtyCanvas(true, false); }
    };
    requestAnimationFrame(step);
  }

  // ── sizing ───────────────────────────────────────────────────────
  syncSize(force) {
    if (this.dead) return;
    const n = this.node;
    if (this.collapsed) {
      this.h = STRIP_H + 8;
    } else {
      const bodyH = this.body.scrollHeight || 0;
      const pickH = this.pickerEl?.offsetHeight || 0;
      const footH = this.foot.offsetHeight || 14;
      const est = 24 + Math.max(1, this._st?.slots.length || 1) * 52 + 44;
      this.h = STRIP_H + 6 + (bodyH || est) + (pickH ? pickH + 6 : 0) + 6 + footH + 6;
    }
    const sig = `${Math.round(this.h)}|${this.collapsed ? 1 : 0}`;
    if (!force && sig === this._sizeSig) return;
    this._sizeSig = sig;
    let s;
    try { s = n.computeSize(); } catch (_) { return; }
    n.setSize([Math.max(n.size[0], s[0], 340), s[1]]);
    n.setDirtyCanvas(true, true);
  }

  destroy() {
    this.dead = true;
    clearTimeout(this.toastTimer);
    panels.delete(this);
    this.closePicker();
    this.strip.destroy();
    this.el.remove();
  }
}

// ───────────────────────────── execution state ─────────────────────────────
function execId(detail) {
  if (detail == null) return null;
  return String(typeof detail === "object" ? (detail.node ?? detail.id ?? "") : detail);
}
function syncBusy(id) {
  for (const p of [...panels]) p.setBusy(id != null && id === String(p.node.id));
}
api.addEventListener("executing", (e) => syncBusy(execId(e.detail)));
for (const ev of ["execution_success", "execution_error", "execution_interrupted", "execution_cached"]) {
  api.addEventListener(ev, () => syncBusy(null));
}

// ───────────────────────────── extension ─────────────────────────────
app.registerExtension({
  name: "Nougan.RefMods",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    const kind = KINDS[nodeData.name];
    if (!kind) return;                                  // legacy Qwen shells stay untouched
    const proto = nodeType.prototype;

    const onCreated = proto.onNodeCreated;
    proto.onNodeCreated = function () {
      const r = onCreated?.apply(this, arguments);
      if (this.__nrm) return r;
      this.color = "#4a2f8c";
      this.bgcolor = "#171226";
      const panel = new Panel(this, kind);
      this.__nrm = panel;
      const wid = this.addDOMWidget("nougan_refmod_panel", "nougan_refmod_panel", panel.el, {
        serialize: false,
        hideOnZoom: false,
        getMinHeight: () => panel.height(),
        getMaxHeight: () => panel.height(),
      });
      wid.serialize = false;
      wid.computeSize = (w) => [w, panel.height()];
      panel.widget = wid;

      for (const name of HOOKED) {
        const w = W(this, name);
        if (!w) continue;
        const orig = w.callback;
        w.callback = function () {
          const res = orig?.apply(this, arguments);
          if (name.startsWith("refmod_") && w.value !== NONE && !LIB.refmods.has(w.value)) loadLib(true);
          panel.refresh();
          panel.renderPickerChrome();
          panel.renderPickerList();
          return res;
        };
      }

      loadLib(true).then(() => panel.refresh());
      panel.refresh();
      return r;
    };

    const onConfigure = proto.onConfigure;
    proto.onConfigure = function () {
      const r = onConfigure?.apply(this, arguments);
      this.__nrm?.refresh();
      requestAnimationFrame(() => this.__nrm?.refresh());
      return r;
    };

    const onConn = proto.onConnectionsChange;
    proto.onConnectionsChange = function () {
      const r = onConn?.apply(this, arguments);
      this.__nrm?.refresh();
      return r;
    };

    const onDrawFg = proto.onDrawForeground;
    proto.onDrawForeground = function (ctx) {
      const r = onDrawFg?.apply(this, arguments);
      const p = this.__nrm;
      if (p?.flash && !this.flags?.collapsed && performance.now() < p.flash.until) {
        const i = this.inputs?.findIndex((x) => x.name === p.flash.name) ?? -1;
        if (i >= 0) {
          const pos = this.getConnectionPos(true, i);
          const a = 0.5 + 0.5 * Math.sin(performance.now() / 110);
          ctx.save();
          ctx.strokeStyle = `rgba(251,191,36,${0.3 + 0.55 * a})`;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(pos[0] - this.pos[0], pos[1] - this.pos[1], 8 + 3 * a, 0, Math.PI * 2);
          ctx.stroke();
          ctx.restore();
        }
      }
      return r;
    };

    const onRemoved = proto.onRemoved;
    proto.onRemoved = function () {
      this.__nrm?.destroy();
      this.__nrm = null;
      return onRemoved?.apply(this, arguments);
    };

    const onExec = proto.onExecuted;
    proto.onExecuted = function (message) {
      const r = onExec?.apply(this, arguments);
      if (kind === "bake") {
        const text = message?.text?.[0];
        if (text) this.__nrm?.showToast(String(text).replace(/^Baked /, "baked "), null);
        loadLib(true).then(() => { this.__nrm?.refresh(); refreshCombos(); });
      }
      return r;
    };
  },
});