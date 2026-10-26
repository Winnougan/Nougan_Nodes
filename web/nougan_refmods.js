// Nougan RefMods — DOM panel + WebGPU strip for the unified Bake / Apply nodes.
//
//  * DOM:    a panel widget under the node's widgets: model chips, reference cards with thumbnails,
//            "what to connect" chips, token meter, warnings. Styled with injected CSS.
//  * WebGPU: an animated strip at the top of the panel. A fragment shader draws a drifting aurora in
//            the model's accent colour and renders the selected references as textured cards with a
//            chromatic-aberration shimmer. Falls back to plain <img> cards if WebGPU is unavailable.
//  * Per-model widget hiding is data-driven: everything comes from /nougan/refmod_lib (the Handler
//    classes in nougan_refmods.py), so a new model needs no change here.
//
// No serialized widgets are added (the panel is serialize:false), so saved workflows stay compatible.
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const KINDS = { NouganUnifiedRefModBake: "bake", NouganUnifiedRefModApply: "apply" };
const AUTO = "auto (from refmod)";
const NONE = "None";
const SLOTS = ["refmod_1", "refmod_2", "refmod_3"];
const APPLY_COND = ["extra_image_scale", "ref_strength", "ref_on_negative", "frame_idx", "strength"];
const BAKE_COND = ["scale_mode"];
const TOKEN_BUDGET = 16384;
const STRIP_H = 84;

// ───────────────────────────── library ─────────────────────────────
const LIB = { models: new Map(), refmods: new Map(), t: 0, busy: null };
const panels = new Set();

function loadLib(force = false) {
  if (LIB.busy) return LIB.busy;
  if (!force && Date.now() - LIB.t < 4000) return Promise.resolve();
  LIB.busy = api.fetchApi("/nougan/refmod_lib")
    .then((r) => r.json())
    .then((d) => {
      LIB.models = new Map((d.models || []).map((m) => [m.key, m]));
      LIB.refmods = new Map((d.refmods || []).map((e) => [e.name, e]));
      LIB.t = Date.now();
      for (const p of panels) p.refresh();
    })
    .catch(() => {})
    .finally(() => { LIB.busy = null; });
  return LIB.busy;
}
setInterval(() => { if (panels.size && !document.hidden) loadLib(true); }, 15000);

const thumbURL = (e) => api.apiURL(`/nougan/refmod_lib/thumb?name=${encodeURIComponent(e.name)}&v=${e.stamp}`);
const BMP = new Map();
function thumbBitmap(e) {
  if (!e || !e.thumb) return Promise.resolve(null);
  const key = `${e.name}|${e.stamp}`;
  if (!BMP.has(key)) {
    BMP.set(key, fetch(thumbURL(e)).then((r) => (r.ok ? r.blob() : null))
      .then((b) => (b ? createImageBitmap(b) : null)).catch(() => null));
  }
  return BMP.get(key);
}

// ───────────────────────────── helpers ─────────────────────────────
const W = (n, name) => n.widgets?.find((w) => w.name === name);
const linked = (n, name) => n.inputs?.find((i) => i.name === name)?.link != null;
const fmt = (t) => (t >= 1000 ? `${(t / 1000).toFixed(t >= 10000 ? 0 : 1)}k` : `${t}`);
const hexRGB = (h) => { const n = parseInt((h || "#a78bfa").slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const css = (h, a = 1) => { const [r, g, b] = hexRGB(h); return `rgba(${r},${g},${b},${a})`; };

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function setHidden(w, hide) {
  if (!w || !!w.hidden === hide) return false;
  if (!w.__nrm) w.__nrm = { type: w.type, own: Object.prototype.hasOwnProperty.call(w, "computeSize"), cs: w.computeSize };
  if (hide) {
    w.hidden = true;
    try { w.type = "converted-widget"; } catch (_) { /* class getter */ }
    w.computeSize = () => [0, -4];
  } else {
    w.hidden = false;
    try { w.type = w.__nrm.type; } catch (_) { /* ignore */ }
    if (w.__nrm.own) w.computeSize = w.__nrm.cs; else delete w.computeSize;
  }
  return true;
}

// ───────────────────────────── styles ─────────────────────────────
function injectCSS() {
  if (document.getElementById("nougan-refmods-css")) return;
  const s = document.createElement("style");
  s.id = "nougan-refmods-css";
  s.textContent = `
.nrm-root{box-sizing:border-box;width:100%;font:11px/1.35 system-ui,sans-serif;color:#ece8ff;display:flex;flex-direction:column;gap:6px;user-select:none}
.nrm-strip{position:relative;height:${STRIP_H}px;border-radius:12px;overflow:hidden;background:#100c1b;border:1px solid rgba(255,255,255,.08)}
.nrm-strip canvas{position:absolute;inset:0;width:100%;height:100%;display:block}
.nrm-fb{position:absolute;inset:0;display:none;align-items:center;gap:8px;padding:8px 12px;background:linear-gradient(120deg,#171226,var(--acc-soft),#171226);background-size:200% 100%;animation:nrm-drift 9s linear infinite}
.nrm-fb img{height:100%;border-radius:8px;border:1px solid var(--acc);box-shadow:0 2px 10px rgba(0,0,0,.5)}
@keyframes nrm-drift{to{background-position:200% 0}}
.nrm-badge{position:absolute;right:8px;top:6px;padding:1px 8px;border-radius:9px;font-weight:700;font-size:9px;letter-spacing:.06em;background:rgba(0,0,0,.45);border:1px solid var(--acc);color:var(--acc);backdrop-filter:blur(4px)}
.nrm-row{display:flex;flex-wrap:wrap;gap:5px;align-items:center}
.nrm-chip{padding:1px 9px;border-radius:10px;font-size:10px;font-weight:700;border:1px solid rgba(255,255,255,.14);color:#9d93bd;background:rgba(255,255,255,.04);cursor:default;transition:all .15s}
.nrm-chip.pick{cursor:pointer}
.nrm-chip.pick:hover{color:#fff;border-color:var(--c);transform:translateY(-1px)}
.nrm-chip.on{color:var(--c);border-color:var(--c);background:var(--c-soft)}
.nrm-chip.ok{color:#34d399;border-color:rgba(52,211,153,.7);background:rgba(52,211,153,.12)}
.nrm-chip.miss{color:#fbbf24;border-color:rgba(251,191,36,.8);background:rgba(251,191,36,.12)}
.nrm-chip.bad{color:#f87171;border-color:rgba(248,113,113,.8);background:rgba(248,113,113,.12)}
.nrm-card{display:flex;gap:9px;align-items:center;padding:5px 8px 5px 5px;border-radius:10px;background:linear-gradient(90deg,#241b3f,#1a1430);border:1px solid #3b2d66;transition:border-color .15s,transform .15s}
.nrm-card:hover{border-color:var(--c);transform:translateX(2px)}
.nrm-thumb{width:38px;height:38px;border-radius:7px;flex:none;object-fit:cover;background:linear-gradient(135deg,var(--c),#22d3ee);display:flex;align-items:center;justify-content:center;font-weight:800;font-size:17px;color:rgba(255,255,255,.92);overflow:hidden}
.nrm-thumb img{width:100%;height:100%;object-fit:cover;display:block}
.nrm-main{flex:1;min-width:0}
.nrm-name{font-weight:700;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.nrm-sub{color:#9d93bd;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.nrm-empty{padding:9px;border-radius:10px;border:1px dashed rgba(255,255,255,.14);color:#9d93bd;text-align:center}
.nrm-meter{height:5px;border-radius:3px;background:rgba(255,255,255,.07);overflow:hidden}
.nrm-meter>i{display:block;height:100%;background:linear-gradient(90deg,#7c5cff,var(--acc));transition:width .3s}
.nrm-meter.over>i{background:linear-gradient(90deg,#7c5cff,#fbbf24)}
.nrm-foot{color:#9d93bd;font-size:10px;display:flex;justify-content:space-between}
.nrm-warn{color:#fbbf24;font-size:10px}
`;
  document.head.appendChild(s);
}

// ───────────────────────────── WebGPU ─────────────────────────────
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
  let px = pos.xy;
  let uv = px / u.res;
  let t = u.time;
  let acc = u.accent.rgb;

  // drifting aurora in the model's accent colour
  let n = fbm(vec2f(uv.x * 5.0 + t * 0.07, uv.y * 2.2 - t * 0.05));
  let n2 = fbm(vec2f(uv.x * 3.0 - t * 0.04 + n, uv.y * 3.0 + t * 0.06));
  var col = mix(vec3f(0.06, 0.045, 0.10), acc * 0.55, smoothstep(0.25, 0.85, n2));
  col += acc * 0.10 * pow(1.0 - uv.y, 3.0);
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
    col *= 1.0 - 0.45 * (1.0 - smoothstep(0.0, 14.0 * dpr, d)) * step(0.0, d);   // drop shadow
    if (d < 0.0) {
      let l = (px - vec2f(x, pad)) / vec2f(w, h);
      let sweep = fract(t * 0.22 + f32(i) * 0.31);
      let band = 1.0 - smoothstep(0.0, 0.10, abs(l.x * 0.8 + l.y * 0.35 - (sweep * 1.6 - 0.2)));
      let ca = (0.0025 + 0.006 * hov) * (1.0 + band * 3.0);       // chromatic aberration
      let r = slot(i, l + vec2f(ca, 0.0)).r;
      let gg = slot(i, l).g;
      let b = slot(i, l - vec2f(ca, 0.0)).b;
      var tc = vec3f(r, gg, b);
      tc *= 0.86 + 0.14 * hov;
      tc += acc * band * 0.35;
      tc *= 0.94 + 0.06 * sin(px.y / (2.0 * dpr) + t * 3.0);       // scanlines
      let rim = smoothstep(-3.0 * dpr, 0.0, d);
      col = mix(tc, acc * 1.2, rim * (0.55 + 0.35 * hov));
    } else {
      col += acc * 0.5 * (1.0 - smoothstep(0.0, 3.0 * dpr, d)) * (0.25 + 0.5 * hov);
    }
    x += w + 10.0 * dpr;
  }
  let v = 1.0 - smoothstep(0.35, 1.15, length((uv - vec2f(0.5)) * vec2f(1.0, 1.6)));
  col *= 0.7 + 0.3 * v;
  return vec4f(col, 1.0);
}
`;

let GPU = null;
function getGpu() {
  if (GPU) return GPU;
  GPU = (async () => {
    if (!navigator.gpu) return null;
    const adapter = await navigator.gpu.requestAdapter();
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
    const sampler = dev.createSampler({ magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" });
    const dummy = dev.createTexture({ size: [1, 1], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    dev.queue.writeTexture({ texture: dummy }, new Uint8Array([20, 16, 30, 255]), { bytesPerRow: 4 }, [1, 1]);
    dev.lost.then(() => { GPU = null; for (const p of panels) p.strip.lost(); });
    return { dev, format, pipeline, sampler, dummy };
  })().catch((e) => { console.warn("[Nougan RefMods] WebGPU unavailable", e); return null; });
  return GPU;
}

class Strip {
  constructor(root) {
    this.root = root;
    this.canvas = el("canvas");
    this.fb = el("div", "nrm-fb");
    this.badge = el("span", "nrm-badge", "");
    root.append(this.canvas, this.fb, this.badge);
    this.ok = false; this.visible = true; this.hover = -1; this.count = 0;
    this.asp = [1, 1, 1]; this.textures = [null, null, null];
    this.accent = hexRGB("#a78bfa").map((v) => v / 255);
    this.seq = 0;
    new IntersectionObserver((es) => { this.visible = es.some((e) => e.isIntersecting); }).observe(root);
    this.init();
  }

  async init() {
    const g = await getGpu();
    if (!g) return this.fallback();
    try {
      this.g = g;
      this.ctx = this.canvas.getContext("webgpu");
      this.ctx.configure({ device: g.dev, format: g.format, alphaMode: "premultiplied" });
      this.ubuf = g.dev.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.ok = true;
      this.fb.style.display = "none";
      this.canvas.style.display = "block";
      this.bind();
    } catch (e) { console.warn("[Nougan RefMods] strip init failed", e); this.fallback(); }
  }

  fallback() { this.ok = false; this.canvas.style.display = "none"; this.fb.style.display = "flex"; }
  lost() { this.ok = false; this.init(); }

  setAccent(hex) {
    this.accent = hexRGB(hex).map((v) => v / 255);
    this.root.style.setProperty("--acc", hex);
    this.root.style.setProperty("--acc-soft", css(hex, 0.25));
  }

  // items: [{ bitmap, url }] (max 3). Rebuilds textures only when the set changed.
  async setItems(items) {
    const seq = ++this.seq;
    this.fb.replaceChildren(...items.map((i) => { const im = el("img"); im.src = i.url; return im; }));
    const bitmaps = await Promise.all(items.map((i) => i.bitmap));
    if (seq !== this.seq) return;
    this.count = Math.min(3, items.length);
    if (!this.ok) return;
    const { dev } = this.g;
    for (const t of this.textures) t?.destroy();
    this.textures = [null, null, null];
    this.count = 0;
    bitmaps.slice(0, 3).forEach((bmp) => {
      if (!bmp) return;
      const t = dev.createTexture({
        size: [bmp.width, bmp.height], format: "rgba8unorm",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      });
      dev.queue.copyExternalImageToTexture({ source: bmp }, { texture: t }, [bmp.width, bmp.height]);
      this.asp[this.count] = bmp.width / bmp.height;
      this.textures[this.count++] = t;
    });
    this.bind();
  }

  bind() {
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
    const { dev, pipeline } = this.g;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(this.canvas.clientWidth * dpr), h = Math.round(this.canvas.clientHeight * dpr);
    if (w < 2 || h < 2) return;
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    dev.queue.writeBuffer(this.ubuf, 0, new Float32Array([
      w, h, t, this.count,
      this.accent[0], this.accent[1], this.accent[2], 1,
      this.hover, this.asp[0], this.asp[1], this.asp[2],
      dpr, 0, 0, 0,
    ]));
    const enc = dev.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: this.ctx.getCurrentTexture().createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
    });
    pass.setPipeline(pipeline); pass.setBindGroup(0, this.bg); pass.draw(3); pass.end();
    dev.queue.submit([enc.finish()]);
  }

  destroy() { this.seq++; for (const t of this.textures) t?.destroy(); }
}

let lastFrame = 0;
function tick(ms) {
  requestAnimationFrame(tick);
  if (document.hidden || ms - lastFrame < 33) return;     // ~30 fps, and idle when the tab is hidden
  lastFrame = ms;
  for (const p of panels) if (p.strip.ok && p.strip.visible && p.strip.g) p.strip.render(ms / 1000);
}
requestAnimationFrame(tick);

// ───────────────────────────── panel ─────────────────────────────
class Panel {
  constructor(node, kind) {
    injectCSS();
    this.node = node; this.kind = kind; this.h = STRIP_H + 60; this.sig = "";
    this.el = el("div", "nrm-root");
    const stripBox = el("div", "nrm-strip");
    this.strip = new Strip(stripBox);
    this.body = el("div"); this.body.style.cssText = "display:flex;flex-direction:column;gap:6px";
    this.foot = el("div", "nrm-foot");
    this.el.append(stripBox, this.body, this.foot);
    panels.add(this);
  }

  height() { return this.h; }

  state() {
    const n = this.node, apply = this.kind === "apply";
    const sel = W(n, "model")?.value;
    let slots = [];
    if (apply) {
      slots = SLOTS.map((k) => W(n, k)?.value).filter((v) => v && v !== NONE).map((name) => ({ name, e: LIB.refmods.get(name) }));
    } else {
      const name = (W(n, "name")?.value || "").trim();
      const sub = (W(n, "subfolder")?.value || "").trim().replace(/\\/g, "/").replace(/^\/|\/$/g, "");
      const m = LIB.models.get(sel);
      const key = `${sub || m?.subfolder || ""}/${name}`.replace(/^\//, "");
      const e = LIB.refmods.get(key);
      if (e) slots = [{ name: key, e }];
      this.target = `models/refmods/${key}.safetensors`;
    }
    const eff = apply && sel === AUTO ? slots.find((s) => s.e)?.e.model : sel;
    return { sel, slots, eff, mdl: LIB.models.get(eff) };
  }

  refresh() {
    const n = this.node, apply = this.kind === "apply";
    const st = this.state(), { mdl, slots } = st;

    // 1) widgets that don't matter for this model are hidden
    const uses = mdl ? new Set(apply ? mdl.apply_uses : mdl.bake_uses) : null;
    let changed = false;
    for (const w of apply ? APPLY_COND : BAKE_COND) changed = setHidden(W(n, w), uses ? !uses.has(w) : false) || changed;

    // 2) strip
    this.strip.setAccent(mdl?.accent || "#a78bfa");
    this.strip.badge.textContent = mdl ? mdl.label.toUpperCase() : (apply ? "REFMOD" : "BAKE");
    const shown = slots.filter((s) => s.e?.thumb).slice(0, 3);
    const stripSig = shown.map((s) => `${s.e.name}|${s.e.stamp}`).join(",");
    if (stripSig !== this._stripSig) {
      this._stripSig = stripSig;
      this.strip.setItems(shown.map((s) => ({ bitmap: thumbBitmap(s.e), url: thumbURL(s.e) })));
    }

    // 3) body
    this.body.replaceChildren();
    const warns = [];
    if (apply) {
      if (!slots.length) this.body.append(el("div", "nrm-empty", "pick a RefMod above, or choose a model and use extra_image"));
      slots.forEach((s, i) => this.body.append(this.card(s, i, mdl, warns)));
      const total = slots.reduce((a, s) => a + (s.e?.tokens || 0), 0);
      const meter = el("div", "nrm-meter" + (total > TOKEN_BUDGET ? " over" : ""));
      const bar = el("i"); bar.style.width = `${Math.min(100, (total / TOKEN_BUDGET) * 100)}%`;
      meter.append(bar);
      if (total) this.body.append(meter);
      this.foot.replaceChildren(el("span", "", total ? `${fmt(total)} reference tokens / step` : ""), el("span", "", mdl ? `max ${mdl.max_refs} refs` : ""));
      const nrefs = slots.reduce((a, s) => a + (s.e?.count || 0), 0);
      if (mdl && nrefs > mdl.max_refs) warns.push(`${nrefs} references, ${mdl.label} supports ${mdl.max_refs}`);
      const models = new Set(slots.map((s) => s.e?.model).filter(Boolean));
      if (models.size > 1) warns.push("mixed models in refmod_1..3");
    } else {
      const row = el("div", "nrm-row");
      for (const m of LIB.models.values()) {
        const c = el("span", "nrm-chip pick" + (m.key === st.sel ? " on" : ""), m.label);
        c.style.setProperty("--c", m.accent); c.style.setProperty("--c-soft", css(m.accent, 0.16));
        c.onclick = () => { const w = W(n, "model"); if (w) { w.value = m.key; w.callback?.(m.key); } };
        row.append(c);
      }
      this.body.append(row);
      const ex = slots[0];
      if (ex) this.body.append(this.card(ex, 0, mdl, warns, "exists"));
      this.foot.replaceChildren(el("span", "", this.target || ""), el("span", ""));
      if (ex && !W(n, "overwrite")?.value) warns.push("file exists: it will be skipped unless overwrite is on");
    }

    // 4) what to connect
    if (mdl) {
      const needs = apply ? mdl.apply_needs : mdl.bake_needs;
      const row = el("div", "nrm-row");
      if (needs.length) row.append(el("span", "nrm-sub", "connect:"));
      for (const k of needs) row.append(el("span", "nrm-chip " + (linked(n, k) ? "ok" : "miss"), k));
      if (!apply) row.append(el("span", "nrm-chip " + (linked(n, "images") ? "ok" : "miss"), "images"));
      this.body.append(row);
    }
    if (warns.length) this.body.append(el("div", "nrm-warn", "⚠ " + warns.join(" · ")));

    // 5) size
    const rows = apply ? Math.max(1, slots.length) : 2;
    this.h = STRIP_H + 24 + rows * 52 + (apply ? 40 : 44) + (warns.length ? 16 : 0);
    const sig = `${changed ? Math.random() : 0}|${this.h}`;
    if (sig !== this.sig) {
      this.sig = sig;
      const s = n.computeSize();
      n.setSize([Math.max(n.size[0], s[0], 340), s[1]]);
      n.setDirtyCanvas(true, true);
    }
  }

  card(s, i, mdl, warns, tag) {
    const e = s.e, m = LIB.models.get(e?.model) || mdl;
    const c = el("div", "nrm-card");
    c.style.setProperty("--c", m?.accent || "#a78bfa");
    c.onmouseenter = () => { this.strip.hover = i; };
    c.onmouseleave = () => { this.strip.hover = -1; };
    const t = el("div", "nrm-thumb");
    if (e?.thumb) { const im = el("img"); im.src = thumbURL(e); im.onerror = () => { im.remove(); t.textContent = s.name.split("/").pop().charAt(0).toUpperCase(); }; t.append(im); }
    else t.textContent = s.name.split("/").pop().charAt(0).toUpperCase();
    const main = el("div", "nrm-main");
    main.append(el("div", "nrm-name", s.name.split("/").pop()));
    const dims = e?.sizes?.length ? ` · ${e.sizes.map(([w, h]) => `${w}×${h}`).slice(0, 2).join(", ")}${e.sizes.length > 2 ? "…" : ""}` : "";
    main.append(el("div", "nrm-sub", e ? `${e.count} ref${e.count === 1 ? "" : "s"}${dims}` : "not found: refresh the list (R)"));
    const side = el("div");
    if (e) {
      const chip = el("span", "nrm-chip on", tag === "exists" ? "baked" : (m?.label || e.model));
      chip.style.setProperty("--c", m?.accent || "#a78bfa"); chip.style.setProperty("--c-soft", css(m?.accent || "#a78bfa", 0.16));
      side.append(chip);
      const sel = W(this.node, "model")?.value;
      if (this.kind === "apply" && sel && sel !== AUTO && sel !== e.model) {
        side.append(el("span", "nrm-chip bad", "wrong model"));
        warns.push(`${s.name} is a ${m?.label || e.model} RefMod`);
      }
    }
    c.append(t, main, side);
    return c;
  }

  destroy() { panels.delete(this); this.strip.destroy(); }
}

// ───────────────────────────── extension ─────────────────────────────
app.registerExtension({
  name: "Nougan.RefMods",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    const kind = KINDS[nodeData.name];
    if (!kind) return;
    const proto = nodeType.prototype;

    const onCreated = proto.onNodeCreated;
    proto.onNodeCreated = function () {
      const r = onCreated?.apply(this, arguments);
      this.color = "#4a2f8c"; this.bgcolor = "#171226";
      const panel = new Panel(this, kind);
      this.__nrm = panel;
      const wid = this.addDOMWidget("nougan_refmod_panel", "nougan_refmod_panel", panel.el, {
        serialize: false, hideOnZoom: false,
        getMinHeight: () => panel.height(), getMaxHeight: () => panel.height(),
      });
      wid.serialize = false;
      wid.computeSize = (w) => [w, panel.height()];
      for (const name of ["model", ...SLOTS, "name", "subfolder", "overwrite"]) {
        const w = W(this, name);
        if (!w) continue;
        const orig = w.callback;
        w.callback = function () {
          const res = orig?.apply(this, arguments);
          if (name.startsWith("refmod_") && !LIB.refmods.has(w.value) && w.value !== NONE) loadLib(true);
          panel.refresh();
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
      return r;
    };

    const onConn = proto.onConnectionsChange;
    proto.onConnectionsChange = function () {
      const r = onConn?.apply(this, arguments);
      this.__nrm?.refresh();
      return r;
    };

    const onRemoved = proto.onRemoved;
    proto.onRemoved = function () {
      this.__nrm?.destroy();
      return onRemoved?.apply(this, arguments);
    };

    const onExec = proto.onExecuted;
    proto.onExecuted = function (message) {
      const r = onExec?.apply(this, arguments);
      if (kind === "bake") {
        loadLib(true).then(() => { this.__nrm?.refresh(); try { app.refreshComboInNodes?.(); } catch (_) { /* ignore */ } });
      }
      return r;
    };
  },
});
