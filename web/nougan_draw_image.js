// nougan_draw_image.js — Nougan Draw Image: DOM sketch pad + WebGPU layer compositor
// Layers are drawn with the 2D canvas API (pressure-sensitive pointer events); WebGPU composites
// them for display (falls back to plain 2D if WebGPU is unavailable). Export is always a 2D composite.
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_ID = "NouganDrawImage";
const SUBFOLDER = "nougan_draw";
const MAX_UNDO = 25;
const MAX_LAYERS = 12;
const SAVE_DELAY = 700;
const SWATCHES = ["#000000", "#ffffff", "#e53935", "#fb8c00", "#fdd835", "#43a047", "#1e88e5", "#8e24aa"];
const BG_CLEAR = { white: [1, 1, 1, 1], black: [0, 0, 0, 1], transparent: [0, 0, 0, 0] };

const editors = new Set();

// ───────────────────────────── styles ─────────────────────────────
const CSS = `
.nd-root{display:flex;flex-direction:column;gap:6px;width:100%;height:100%;box-sizing:border-box;padding:4px;
  color:var(--input-text,#ddd);font:12px sans-serif;user-select:none;-webkit-user-select:none}
.nd-bar{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.nd-btn{background:var(--comfy-input-bg,#222);color:inherit;border:1px solid var(--border-color,#444);
  border-radius:5px;padding:3px 9px;cursor:pointer;font:inherit;line-height:1.3}
.nd-btn:hover{filter:brightness(1.3)}
.nd-btn.on{background:#5b4bd6;border-color:#8a7dff;color:#fff}
.nd-btn.danger:hover{background:#a02828;border-color:#d44}
.nd-btn.sm{padding:1px 5px;font-size:11px}
.nd-btn.off{opacity:.4}
.nd-sep{flex:1}
.nd-size{display:flex;align-items:center;gap:5px}
.nd-size input{width:110px}
.nd-main{display:flex;gap:6px;flex:1;min-height:0}
.nd-stage{position:relative;flex:1;min-width:0;display:flex;align-items:center;justify-content:center;
  background:#111;border-radius:6px;overflow:hidden;touch-action:none;cursor:crosshair;outline:none}
.nd-canvas{display:block;max-width:none;box-shadow:0 0 0 1px #555}
.nd-checker{background-color:#fff;background-image:linear-gradient(45deg,#bbb 25%,transparent 25%,transparent 75%,#bbb 75%),
  linear-gradient(45deg,#bbb 25%,transparent 25%,transparent 75%,#bbb 75%);background-size:16px 16px;background-position:0 0,8px 8px}
.nd-ring{position:absolute;pointer-events:none;border:1px solid #000;border-radius:50%;
  box-shadow:0 0 0 1px #fff;transform:translate(-50%,-50%);display:none}
.nd-side{width:150px;display:flex;flex-direction:column;gap:6px;min-height:0}
.nd-colors{display:flex;flex-direction:column;gap:6px;flex:none}
.nd-lbox{display:flex;flex-direction:column;gap:6px;flex:1;min-height:0;min-width:0}
.nd-host{position:relative;width:100%;height:100%}
.nd-placeholder{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;width:100%;height:100%;
  box-sizing:border-box;padding:12px;text-align:center;color:var(--input-text,#ddd);font:12px sans-serif;opacity:.85}
/* narrow (inside the Live Panel, or a small node): canvas on top, colours + layers side by side underneath */
.nd-narrow .nd-main{flex-direction:column}
.nd-narrow .nd-stage{flex:1 1 auto;min-height:150px}
.nd-narrow .nd-side{width:auto;flex:0 0 auto;height:212px;flex-direction:row}
.nd-narrow .nd-colors{width:132px}
.nd-narrow .nd-size input{width:80px}
.nd-wheel{display:block;margin:0 auto;cursor:crosshair;touch-action:none;border-radius:50%}
.nd-val{width:100%;height:14px;margin:0;-webkit-appearance:none;appearance:none;border-radius:7px;border:1px solid #555}
.nd-val::-webkit-slider-thumb{-webkit-appearance:none;width:12px;height:16px;border-radius:4px;background:#fff;border:1px solid #000}
.nd-val::-moz-range-thumb{width:10px;height:14px;border-radius:4px;background:#fff;border:1px solid #000}
.nd-color{display:flex;gap:5px;align-items:center}
.nd-swatch{width:22px;height:22px;border-radius:4px;border:1px solid #888;flex:none}
.nd-hex{flex:1;min-width:0;background:var(--comfy-input-bg,#222);color:inherit;border:1px solid var(--border-color,#444);
  border-radius:4px;padding:2px 4px;font:inherit}
.nd-swatches{display:grid;grid-template-columns:repeat(8,1fr);gap:3px}
.nd-swatches div{aspect-ratio:1;border-radius:3px;border:1px solid #777;cursor:pointer}
.nd-lhead{display:flex;align-items:center;justify-content:space-between;font-weight:600}
.nd-layers{flex:1;min-height:60px;overflow-y:auto;display:flex;flex-direction:column;gap:3px;
  background:#1a1a1a;border-radius:6px;padding:3px}
.nd-layer{display:flex;align-items:center;gap:4px;padding:2px;border-radius:5px;border:1px solid transparent;cursor:pointer}
.nd-layer.active{border-color:#8a7dff;background:#2b2750}
.nd-thumb{width:34px;height:34px;border-radius:3px;flex:none;object-fit:contain;
  background-color:#fff;background-image:linear-gradient(45deg,#ccc 25%,transparent 25%,transparent 75%,#ccc 75%),
  linear-gradient(45deg,#ccc 25%,transparent 25%,transparent 75%,#ccc 75%);background-size:8px 8px;background-position:0 0,4px 4px}
.nd-lname{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nd-lbtns{display:flex;gap:2px;flex:none}
`;
function injectCSS() {
  if (document.getElementById("nougan-draw-css")) return;
  const s = document.createElement("style");
  s.id = "nougan-draw-css";
  s.textContent = CSS;
  document.head.appendChild(s);
}

// ───────────────────────────── helpers ─────────────────────────────
const uid = () => Math.random().toString(36).slice(2, 10);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function btn(label, title, onclick, cls = "") {
  const b = el("button", "nd-btn " + cls, label);
  b.type = "button";
  b.title = title;
  b.addEventListener("click", (e) => { e.stopPropagation(); onclick(e); });
  return b;
}
function newCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return c;
}
function toBlob(canvas) {
  return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("toBlob failed"))), "image/png"));
}
function hsv2rgb(h, s, v) {
  const i = Math.floor(h * 6), f = h * 6 - i, p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  let r, g, b;
  switch (i % 6) {
    case 0: [r, g, b] = [v, t, p]; break;
    case 1: [r, g, b] = [q, v, p]; break;
    case 2: [r, g, b] = [p, v, t]; break;
    case 3: [r, g, b] = [p, q, v]; break;
    case 4: [r, g, b] = [t, p, v]; break;
    default: [r, g, b] = [v, p, q];
  }
  return [r, g, b].map((x) => Math.round(x * 255));
}
function rgb2hsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) {
    if (mx === r) h = ((g - b) / d + 6) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return { h, s: mx ? d / mx : 0, v: mx };
}
const toHex = ([r, g, b]) => "#" + [r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("");

// ───────────────────────────── shared WebGPU ─────────────────────────────
const SHADER = `
struct VOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var o: VOut;
  o.pos = vec4f(p[i], 0.0, 1.0);
  o.uv = vec2f((p[i].x + 1.0) * 0.5, 1.0 - (p[i].y + 1.0) * 0.5);
  return o;
}
@group(0) @binding(0) var smp: sampler;
@group(0) @binding(1) var tex: texture_2d<f32>;
@fragment fn fs(in: VOut) -> @location(0) vec4f { return textureSample(tex, smp, in.uv); }
`;
let gpuPromise = null;
function getGPU() {
  if (gpuPromise) return gpuPromise;
  gpuPromise = (async () => {
    try {
      if (!navigator.gpu) return null;
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) return null;
      const device = await adapter.requestDevice();
      const format = navigator.gpu.getPreferredCanvasFormat();
      const module = device.createShaderModule({ code: SHADER });
      const over = { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" }; // premultiplied "over"
      const pipeline = device.createRenderPipeline({
        layout: "auto",
        vertex: { module, entryPoint: "vs" },
        fragment: { module, entryPoint: "fs", targets: [{ format, blend: { color: over, alpha: over } }] },
        primitive: { topology: "triangle-list" },
      });
      const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
      const gpu = { device, format, pipeline, sampler };
      device.lost.then(() => { gpuPromise = null; editors.forEach((e) => e.onDeviceLost(gpu)); });
      return gpu;
    } catch (err) {
      console.warn("[Nougan Draw] WebGPU unavailable, using 2D fallback:", err);
      return null;
    }
  })();
  return gpuPromise;
}

// ───────────────────────────── the editor ─────────────────────────────
class DrawEditor {
  constructor(node) {
    this.node = node;
    this.uid = uid();
    this.w = 1024; this.h = 1024; this.bg = "white";
    this.layers = [];
    this.activeId = null;
    this.layerCounter = 0;
    this.undoStack = [];
    this.tool = "brush";
    this.size = 6;
    this.hsv = { h: 0, s: 0, v: 0 }; // black
    this.stroke = null;
    this.mode = "pending"; // pending | gpu | 2d
    this.gpu = null;
    this.raf = 0;
    this.saveT = 0;
    this.pending = false;
    this.chain = Promise.resolve();
    this.loadToken = 0;
    this.loading = false;

    const get = (n) => node.widgets.find((w) => w.name === n);
    this.wW = get("width"); this.hW = get("height"); this.bgW = get("background");
    this.imageW = get("image"); this.stateW = get("drawing_state");
    for (const w of [this.imageW, this.stateW]) {
      w.hidden = true;
      w.computeSize = () => [0, -4];
    }
    this.w = this.wW.value; this.h = this.hW.value; this.bg = this.bgW.value;
    this.hook(this.wW, () => this.onDocSize());
    this.hook(this.hW, () => this.onDocSize());
    this.hook(this.bgW, () => { this.bg = this.bgW.value; this.fit(); this.invalidate(); this.touchFlat(); });

    this.buildDOM();
    const first = this.makeLayer("Layer 1");
    this.layers.push(first);
    this.activeId = first.id;
    this.renderLayerList();

    // ComfyUI owns `host`; the real editor (`root`) lives inside it and can be lent to the Live Panel.
    this.host = el("div", "nd-host");
    this.host.appendChild(this.root);
    this.widget = node.addDOMWidget("draw_editor", "nougan_draw", this.host, {
      serialize: false,
      hideOnZoom: false,
      getMinHeight: () => 320,
    });
    editors.add(this);
    new ResizeObserver(() => this.fit()).observe(this.stage);
    new ResizeObserver(() => this.root.classList.toggle("nd-narrow", this.root.clientWidth < 520)).observe(this.root);
    this.initRenderer();
  }

  hook(widget, fn) {
    const prev = widget.callback;
    widget.callback = function (...a) { prev?.apply(this, a); fn(); };
  }

  // ── layers ──
  makeLayer(name, id) {
    const canvas = newCanvas(this.w, this.h);
    return { id: id || uid(), name, visible: true, canvas, ctx: canvas.getContext("2d"),
             dirty: true, gpuDirty: true, tex: null, bind: null, thumb: null };
  }
  layer(id) { return this.layers.find((l) => l.id === id); }
  get active() { return this.layer(this.activeId) || this.layers[this.layers.length - 1]; }
  freeGPU(l) { try { l.tex?.destroy(); } catch {} l.tex = null; l.bind = null; l.gpuDirty = true; }

  addLayer() {
    if (this.layers.length >= MAX_LAYERS) return;
    const l = this.makeLayer(`Layer ${++this.layerCounter + 1}`);
    const idx = this.layers.indexOf(this.active);
    this.layers.splice(idx + 1, 0, l); // directly above the active layer
    this.activeId = l.id;
    this.pushUndo({ type: "add", id: l.id });
    this.layersChanged();
  }
  removeLayer(id) {
    if (this.layers.length === 1) return this.clearAll();
    const idx = this.layers.findIndex((l) => l.id === id);
    if (idx < 0) return;
    const [l] = this.layers.splice(idx, 1);
    const prevActive = this.activeId;
    if (this.activeId === id) this.activeId = this.layers[Math.min(idx, this.layers.length - 1)].id;
    this.freeGPU(l);
    this.pushUndo({ type: "remove", layer: l, index: idx, activeId: prevActive });
    this.layersChanged();
  }
  moveLayer(id, dir) {
    const from = this.layers.findIndex((l) => l.id === id), to = from + dir;
    if (from < 0 || to < 0 || to >= this.layers.length) return;
    const [l] = this.layers.splice(from, 1);
    this.layers.splice(to, 0, l);
    this.pushUndo({ type: "move", id, from, to });
    this.layersChanged();
  }
  clearAll() {
    const removed = this.layers.splice(0);
    removed.forEach((l) => this.freeGPU(l));
    const fresh = this.makeLayer("Layer 1");
    this.layers.push(fresh);
    const prevActive = this.activeId;
    this.activeId = fresh.id;
    this.layerCounter = 0;
    this.pushUndo({ type: "clear", removed, fresh, activeId: prevActive });
    this.layersChanged();
  }
  layersChanged() { this.renderLayerList(); this.invalidate(); this.touchFlat(); }

  // ── undo ──
  pushUndo(e) {
    this.undoStack.push(e);
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
  }
  undo() {
    if (this.stroke) return;
    const e = this.undoStack.pop();
    if (!e) return;
    switch (e.type) {
      case "stroke": {
        const l = this.layer(e.id);
        if (!l) break;
        l.ctx.save();
        l.ctx.globalCompositeOperation = "copy";
        l.ctx.clearRect(e.x, e.y, e.img.width, e.img.height);
        l.ctx.globalCompositeOperation = "source-over";
        l.ctx.drawImage(e.img, e.x, e.y);
        l.ctx.restore();
        this.touch(l);
        this.updateThumb(l);
        return;
      }
      case "add": {
        const i = this.layers.findIndex((l) => l.id === e.id);
        if (i >= 0) {
          const [l] = this.layers.splice(i, 1);
          this.freeGPU(l);
          if (this.activeId === e.id) this.activeId = this.layers[Math.min(i, this.layers.length - 1)]?.id;
        }
        break;
      }
      case "remove":
        this.layers.splice(e.index, 0, e.layer);
        e.layer.dirty = true;
        this.activeId = e.activeId;
        break;
      case "move": {
        const i = this.layers.findIndex((l) => l.id === e.id);
        if (i >= 0) { const [l] = this.layers.splice(i, 1); this.layers.splice(e.from, 0, l); }
        break;
      }
      case "clear":
        this.layers.splice(0).forEach((l) => this.freeGPU(l));
        e.removed.forEach((l) => { l.dirty = true; this.layers.push(l); });
        this.activeId = e.activeId;
        break;
    }
    this.layersChanged();
  }

  // ── drawing ──
  canvasPoint(e) {
    const r = this.canvas.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * this.w, ((e.clientY - r.top) / r.height) * this.h];
  }
  pressureOf(e) {
    if (e.pointerType !== "pen") return 1;
    return 0.1 + 0.9 * (e.pressure > 0 ? e.pressure : 0.5);
  }
  get hex() { return toHex(hsv2rgb(this.hsv.h, this.hsv.s, this.hsv.v)); }

  beginStroke(e) {
    const l = this.active;
    if (!l) return;
    if (!l.visible) { l.visible = true; this.renderLayerList(); }
    const erasing = this.tool === "eraser" || (e.buttons & 32) !== 0; // pen eraser end
    const snap = newCanvas(this.w, this.h);
    snap.getContext("2d").drawImage(l.canvas, 0, 0);
    this.stroke = { l, erasing, snap, pid: e.pointerId, last: null, lastW: 0, pr: this.pressureOf(e),
                    box: [Infinity, Infinity, -Infinity, -Infinity] };
    this.stage.setPointerCapture(e.pointerId);
    this.strokeTo(e, true);
  }
  strokeTo(e, first = false) {
    const s = this.stroke;
    const [x, y] = this.canvasPoint(e);
    const raw = this.pressureOf(e);
    s.pr = first ? raw : s.pr * 0.6 + raw * 0.4;
    const wd = Math.max(0.5, this.size * s.pr);
    const c = s.l.ctx;
    c.save();
    c.globalCompositeOperation = s.erasing ? "destination-out" : "source-over";
    c.fillStyle = c.strokeStyle = s.erasing ? "#000" : this.hex;
    c.lineCap = c.lineJoin = "round";
    if (!s.last) {
      c.beginPath(); c.arc(x, y, wd / 2, 0, Math.PI * 2); c.fill();
    } else {
      c.lineWidth = (wd + s.lastW) / 2;
      c.beginPath(); c.moveTo(s.last[0], s.last[1]); c.lineTo(x, y); c.stroke();
    }
    c.restore();
    const pad = wd / 2 + 2, b = s.box;
    b[0] = Math.min(b[0], x - pad); b[1] = Math.min(b[1], y - pad);
    b[2] = Math.max(b[2], x + pad); b[3] = Math.max(b[3], y + pad);
    s.last = [x, y]; s.lastW = wd;
    s.l.gpuDirty = true; s.l.dirty = true;
    this.invalidate();
  }
  endStroke() {
    const s = this.stroke;
    if (!s) return;
    this.stroke = null;
    const x0 = clamp(Math.floor(s.box[0]), 0, this.w), y0 = clamp(Math.floor(s.box[1]), 0, this.h);
    const x1 = clamp(Math.ceil(s.box[2]), 0, this.w), y1 = clamp(Math.ceil(s.box[3]), 0, this.h);
    if (x1 > x0 && y1 > y0) {
      const crop = newCanvas(x1 - x0, y1 - y0);
      crop.getContext("2d").drawImage(s.snap, -x0, -y0);
      this.pushUndo({ type: "stroke", id: s.l.id, x: x0, y: y0, img: crop });
    }
    this.updateThumb(s.l);
    this.touch(s.l);
  }
  touch(l) { l.dirty = true; l.gpuDirty = true; this.invalidate(); this.touchFlat(); }

  // ── UI ──
  buildDOM() {
    injectCSS();
    const root = (this.root = el("div", "nd-root"));

    // top bar
    const bar = el("div", "nd-bar");
    this.brushB = btn("✏️ Brush", "Brush", () => this.setTool("brush"));
    this.eraserB = btn("🧽 Eraser", "Eraser (a pen's eraser end works too)", () => this.setTool("eraser"));
    const sizeWrap = el("div", "nd-size");
    const sizeIn = document.createElement("input");
    sizeIn.type = "range"; sizeIn.min = 1; sizeIn.max = 150; sizeIn.value = this.size;
    this.sizeLabel = el("span", "", this.size + "px");
    sizeIn.addEventListener("input", () => { this.size = +sizeIn.value; this.sizeLabel.textContent = this.size + "px"; });
    sizeWrap.append(el("span", "", "Size"), sizeIn, this.sizeLabel);
    this.undoB = btn("↶ Undo", "Undo (Ctrl+Z while the canvas is focused)", () => this.undo());
    const clearB = btn("🗑 Clear all", "Wipe everything and delete all layers (undoable)", () => this.clearAll(), "danger");
    bar.append(this.brushB, this.eraserB, sizeWrap, el("div", "nd-sep"), this.undoB, clearB);

    // stage
    const main = el("div", "nd-main");
    const stage = (this.stage = el("div", "nd-stage"));
    stage.tabIndex = 0;
    this.canvas = el("canvas", "nd-canvas");
    this.canvas.width = this.w; this.canvas.height = this.h;
    this.ring = el("div", "nd-ring");
    stage.append(this.canvas, this.ring);
    this.bindStage();

    // side panel
    const side = el("div", "nd-side");
    this.wheel = document.createElement("canvas");
    this.wheel.className = "nd-wheel";
    this.wheel.width = this.wheel.height = 132;
    this.wheelBase = this.makeWheelBase(132);
    this.valIn = document.createElement("input");
    this.valIn.type = "range"; this.valIn.min = 0; this.valIn.max = 100; this.valIn.className = "nd-val";
    this.valIn.addEventListener("input", () => { this.hsv.v = +this.valIn.value / 100; this.syncColor(); });
    const colorRow = el("div", "nd-color");
    this.swatch = el("div", "nd-swatch");
    this.hexIn = document.createElement("input");
    this.hexIn.className = "nd-hex"; this.hexIn.maxLength = 7; this.hexIn.spellcheck = false;
    this.hexIn.addEventListener("change", () => {
      const m = /^#?([0-9a-f]{6})$/i.exec(this.hexIn.value.trim());
      if (m) { const n = parseInt(m[1], 16); this.hsv = rgb2hsv(n >> 16, (n >> 8) & 255, n & 255); }
      this.syncColor();
    });
    this.hexIn.addEventListener("keydown", (e) => e.stopPropagation());
    colorRow.append(this.swatch, this.hexIn);
    const sw = el("div", "nd-swatches");
    for (const c of SWATCHES) {
      const d = el("div"); d.style.background = c; d.title = c;
      d.addEventListener("click", () => {
        const n = parseInt(c.slice(1), 16);
        this.hsv = rgb2hsv(n >> 16, (n >> 8) & 255, n & 255);
        this.setTool("brush"); this.syncColor();
      });
      sw.append(d);
    }
    const lhead = el("div", "nd-lhead");
    lhead.append(el("span", "", "Layers"), btn("+", "Add a layer above the active one", () => this.addLayer(), "sm"));
    this.layerList = el("div", "nd-layers");
    const colors = el("div", "nd-colors");
    colors.append(this.wheel, this.valIn, colorRow, sw);
    const lbox = el("div", "nd-lbox");
    lbox.append(lhead, this.layerList);
    side.append(colors, lbox);
    this.bindWheel();

    main.append(stage, side);
    root.append(bar, main);
    this.setTool("brush");
    this.syncColor();
  }

  setTool(t) {
    this.tool = t;
    this.brushB.classList.toggle("on", t === "brush");
    this.eraserB.classList.toggle("on", t === "eraser");
  }

  bindStage() {
    const st = this.stage;
    const stop = (e) => e.stopPropagation();
    st.addEventListener("pointerdown", (e) => {
      stop(e);
      if (e.button !== 0 && e.pointerType !== "pen") return;
      st.focus({ preventScroll: true });
      e.preventDefault();
      this.beginStroke(e);
    });
    st.addEventListener("pointermove", (e) => {
      stop(e);
      this.moveRing(e);
      if (!this.stroke || e.pointerId !== this.stroke.pid) return;
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
      for (const ce of evs.length ? evs : [e]) this.strokeTo(ce);
    });
    const end = (e) => { stop(e); if (this.stroke && e.pointerId === this.stroke.pid) this.endStroke(); };
    st.addEventListener("pointerup", end);
    st.addEventListener("pointercancel", end);
    st.addEventListener("pointerleave", () => { this.ring.style.display = "none"; });
    st.addEventListener("contextmenu", (e) => e.preventDefault());
    st.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault(); e.stopPropagation(); this.undo();
      }
    });
  }
  moveRing(e) {
    const sr = this.stage.getBoundingClientRect();
    const k = sr.width / this.stage.offsetWidth || 1; // canvas zoom factor of the ComfyUI graph
    const px = (this.canvas.offsetWidth / this.w) * this.size * (this.stroke ? this.stroke.pr : this.pressureOf(e));
    const d = Math.max(3, px);
    Object.assign(this.ring.style, {
      display: "block", width: d + "px", height: d + "px",
      left: (e.clientX - sr.left) / k + "px", top: (e.clientY - sr.top) / k + "px",
    });
  }

  // colour wheel
  makeWheelBase(n) {
    const c = newCanvas(n, n), ctx = c.getContext("2d"), img = ctx.createImageData(n, n), R = n / 2;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const dx = x + 0.5 - R, dy = y + 0.5 - R, d = Math.hypot(dx, dy);
      if (d > R) continue;
      const h = (Math.atan2(dy, dx) / (Math.PI * 2) + 1) % 1;
      const [r, g, b] = hsv2rgb(h, d / R, 1);
      const i = (y * n + x) * 4;
      img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }
  bindWheel() {
    const pick = (e) => {
      const r = this.wheel.getBoundingClientRect(), R = r.width / 2;
      const dx = e.clientX - r.left - R, dy = e.clientY - r.top - R;
      this.hsv.h = (Math.atan2(dy, dx) / (Math.PI * 2) + 1) % 1;
      this.hsv.s = Math.min(1, Math.hypot(dx, dy) / R);
      if (this.hsv.v < 0.05) this.hsv.v = 1; // picking a hue while brightness is 0 would look broken
      this.setTool("brush");
      this.syncColor();
    };
    let down = false;
    this.wheel.addEventListener("pointerdown", (e) => { e.stopPropagation(); down = true; this.wheel.setPointerCapture(e.pointerId); pick(e); });
    this.wheel.addEventListener("pointermove", (e) => { e.stopPropagation(); if (down) pick(e); });
    const up = (e) => { e.stopPropagation(); down = false; };
    this.wheel.addEventListener("pointerup", up);
    this.wheel.addEventListener("pointercancel", up);
  }
  syncColor() {
    const n = this.wheel.width, R = n / 2, c = this.wheel.getContext("2d");
    c.clearRect(0, 0, n, n);
    c.drawImage(this.wheelBase, 0, 0);
    const a = this.hsv.h * Math.PI * 2, r = this.hsv.s * R;
    const x = R + Math.cos(a) * r, y = R + Math.sin(a) * r;
    c.lineWidth = 2; c.strokeStyle = "#000"; c.beginPath(); c.arc(x, y, 6, 0, Math.PI * 2); c.stroke();
    c.lineWidth = 1.5; c.strokeStyle = "#fff"; c.beginPath(); c.arc(x, y, 6, 0, Math.PI * 2); c.stroke();
    const hue = toHex(hsv2rgb(this.hsv.h, this.hsv.s, 1));
    this.valIn.style.background = `linear-gradient(90deg,#000,${hue})`;
    this.valIn.value = Math.round(this.hsv.v * 100);
    this.swatch.style.background = this.hex;
    this.hexIn.value = this.hex;
  }

  // layer list
  renderLayerList() {
    this.layerList.replaceChildren();
    for (const l of [...this.layers].reverse()) { // top layer first
      const row = el("div", "nd-layer" + (l.id === this.activeId ? " active" : ""));
      row.addEventListener("click", () => { this.activeId = l.id; this.renderLayerList(); });
      row.addEventListener("pointerdown", (e) => e.stopPropagation());
      l.thumb = el("canvas", "nd-thumb");
      l.thumb.width = l.thumb.height = 34;
      const eye = btn("👁", "Show / hide", () => { l.visible = !l.visible; this.layersChanged(); }, "sm" + (l.visible ? "" : " off"));
      const up = btn("▲", "Move up", () => this.moveLayer(l.id, +1), "sm");
      const dn = btn("▼", "Move down", () => this.moveLayer(l.id, -1), "sm");
      const x = btn("✕", "Remove layer", () => this.removeLayer(l.id), "sm danger");
      const bts = el("div", "nd-lbtns"); bts.append(eye, up, dn, x);
      row.append(l.thumb, el("div", "nd-lname", l.name), bts);
      this.layerList.append(row);
      this.updateThumb(l);
    }
  }
  updateThumb(l) {
    const t = l.thumb;
    if (!t) return;
    const c = t.getContext("2d");
    c.clearRect(0, 0, 34, 34);
    const k = Math.min(34 / this.w, 34 / this.h), w = this.w * k, h = this.h * k;
    c.drawImage(l.canvas, (34 - w) / 2, (34 - h) / 2, w, h);
  }

  // ── sizing ──
  fit() {
    const st = this.stage;
    const aw = Math.max(40, st.clientWidth - 12), ah = Math.max(40, st.clientHeight - 12);
    const k = Math.min(aw / this.w, ah / this.h);
    this.canvas.style.width = Math.floor(this.w * k) + "px";
    this.canvas.style.height = Math.floor(this.h * k) + "px";
    this.canvas.classList.toggle("nd-checker", this.bg === "transparent");
  }
  onDocSize() {
    const w = clamp(Math.round(this.wW.value) || 1024, 64, 8192);
    const h = clamp(Math.round(this.hW.value) || 1024, 64, 8192);
    if (w === this.w && h === this.h) return;
    this.w = w; this.h = h;
    for (const l of this.layers) {
      const old = l.canvas, c = newCanvas(w, h);
      c.getContext("2d").drawImage(old, 0, 0); // keeps content anchored top-left
      l.canvas = c; l.ctx = c.getContext("2d");
      this.freeGPU(l); l.dirty = true;
    }
    this.undoStack.length = 0;
    this.canvas.width = w; this.canvas.height = h;
    this.fit(); this.renderLayerList(); this.invalidate(); this.touchFlat();
  }

  // ── rendering ──
  async initRenderer() {
    const gpu = await getGPU();
    if (gpu) {
      try {
        const ctx = this.canvas.getContext("webgpu");
        if (!ctx) throw new Error("no webgpu context");
        ctx.configure({ device: gpu.device, format: gpu.format, alphaMode: "premultiplied" });
        this.gpu = gpu; this.gctx = ctx; this.mode = "gpu";
      } catch (err) {
        console.warn("[Nougan Draw] WebGPU canvas failed, using 2D:", err);
        this.fallback2D();
      }
    } else this.fallback2D();
    this.fit();
    this.invalidate();
  }
  fallback2D() {
    const c = el("canvas", "nd-canvas");
    c.width = this.w; c.height = this.h;
    this.canvas.replaceWith(c);
    this.canvas = c;
    this.ctx2d = c.getContext("2d");
    this.mode = "2d";
    this.layers.forEach((l) => this.freeGPU(l));
    this.fit();
  }
  onDeviceLost(gpu) { if (this.gpu === gpu) { this.gpu = null; this.fallback2D(); this.invalidate(); } }
  invalidate() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      try {
        if (this.mode === "gpu") this.drawGPU();
        else if (this.mode === "2d") this.draw2D();
      } catch (err) {
        console.warn("[Nougan Draw] render failed, switching to 2D:", err);
        this.gpu = null; this.fallback2D(); this.draw2D();
      }
    });
  }
  drawGPU() {
    const { device, pipeline, sampler } = this.gpu;
    const enc = device.createCommandEncoder();
    const vis = this.layers.filter((l) => l.visible);
    for (const l of vis) {
      if (!l.tex || l.tex.width !== this.w || l.tex.height !== this.h) {
        l.tex?.destroy();
        l.tex = device.createTexture({
          size: [this.w, this.h], format: "rgba8unorm",
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
        });
        l.bind = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: sampler }, { binding: 1, resource: l.tex.createView() }],
        });
        l.gpuDirty = true;
      }
      if (l.gpuDirty) {
        device.queue.copyExternalImageToTexture({ source: l.canvas }, { texture: l.tex, premultipliedAlpha: true }, [this.w, this.h]);
        l.gpuDirty = false;
      }
    }
    const pass = enc.beginRenderPass({
      colorAttachments: [{
        view: this.gctx.getCurrentTexture().createView(),
        loadOp: "clear", storeOp: "store",
        clearValue: (BG_CLEAR[this.bg] || BG_CLEAR.white).reduce((o, v, i) => (o["rgba"[i]] = v, o), {}),
      }],
    });
    pass.setPipeline(pipeline);
    for (const l of vis) { pass.setBindGroup(0, l.bind); pass.draw(3); }
    pass.end();
    device.queue.submit([enc.finish()]);
  }
  draw2D() {
    const c = this.ctx2d;
    c.clearRect(0, 0, this.w, this.h);
    if (this.bg !== "transparent") { c.fillStyle = this.bg; c.fillRect(0, 0, this.w, this.h); }
    for (const l of this.layers) if (l.visible) c.drawImage(l.canvas, 0, 0);
  }
  flatten() {
    const c = newCanvas(this.w, this.h), x = c.getContext("2d");
    if (this.bg !== "transparent") { x.fillStyle = this.bg; x.fillRect(0, 0, this.w, this.h); }
    for (const l of this.layers) if (l.visible) x.drawImage(l.canvas, 0, 0);
    return c;
  }

  // ── persistence ──
  touchFlat() {
    this.pending = true;
    clearTimeout(this.saveT);
    this.saveT = setTimeout(() => this.flush(), SAVE_DELAY);
  }
  flush() {
    clearTimeout(this.saveT);
    this.chain = this.chain.then(() => this._save()).catch((e) => console.error("[Nougan Draw] save failed:", e));
    return this.chain;
  }
  async upload(blob, name) {
    const fd = new FormData();
    fd.append("image", blob, name);
    fd.append("type", "input");
    fd.append("subfolder", SUBFOLDER);
    fd.append("overwrite", "true");
    const r = await api.fetchApi("/upload/image", { method: "POST", body: fd });
    if (!r.ok) throw new Error(`upload ${name}: HTTP ${r.status}`);
  }
  async _save() {
    if (!this.pending || this.loading) return;
    this.pending = false;
    const dirty = this.layers.filter((l) => l.dirty);
    try {
      for (const l of dirty) {
        l.dirty = false;
        try { await this.upload(await toBlob(l.canvas), `layer_${this.uid}_${l.id}.png`); }
        catch (e) { l.dirty = true; throw e; }
      }
      await this.upload(await toBlob(this.flatten()), `flat_${this.uid}.png`);
    } catch (e) { this.pending = true; throw e; }
    this.imageW.value = `${SUBFOLDER}/flat_${this.uid}.png`;
    this.stateW.value = JSON.stringify({
      uid: this.uid, w: this.w, h: this.h, active: this.activeId, counter: this.layerCounter,
      layers: this.layers.map((l) => ({ id: l.id, name: l.name, visible: l.visible })),
    });
    this.node.graph?.setDirtyCanvas?.(true, true);
  }

  async restore() {
    const token = ++this.loadToken;
    this.w = this.wW.value; this.h = this.hW.value; this.bg = this.bgW.value;
    this.canvas.width = this.w; this.canvas.height = this.h;
    let st = null;
    try { st = JSON.parse(this.stateW.value); } catch {}
    this.undoStack.length = 0;
    if (!st?.layers?.length) { this.fit(); this.invalidate(); return; }

    this.loading = true;
    this.uid = st.uid || this.uid;
    this.layerCounter = st.counter || 0;
    const layers = st.layers.map((s) => { const l = this.makeLayer(s.name, s.id); l.visible = s.visible !== false; l.dirty = false; return l; });
    await Promise.all(layers.map((l) => new Promise((res) => {
      const img = new Image();
      img.onload = () => { l.ctx.drawImage(img, 0, 0); res(); };
      img.onerror = () => res(); // missing file -> empty layer
      img.src = api.apiURL(`/view?filename=${encodeURIComponent(`layer_${this.uid}_${l.id}.png`)}&type=input&subfolder=${SUBFOLDER}&rand=${Math.random()}`);
    })));
    if (token !== this.loadToken) return;
    this.layers.forEach((l) => this.freeGPU(l));
    this.layers = layers;
    this.activeId = layers.some((l) => l.id === st.active) ? st.active : layers[layers.length - 1].id;
    this.loading = false;
    this.fit(); this.renderLayerList(); this.invalidate();
    setTimeout(() => this.dedupeUid(), 300);
  }
  // A copy/pasted node inherits the source's uid; give the newer one its own files.
  dedupeUid() {
    for (const o of editors) {
      if (o !== this && o.uid === this.uid && !o.loading && o.node.id < this.node.id) {
        this.uid = uid();
        this.layers.forEach((l) => (l.dirty = true));
        this.touchFlat();
        return;
      }
    }
  }
  // ── lending the editor to the Live Panel ──
  // The panel moves `root` into its own card; the node shows a placeholder until it comes back.
  mountInto(target) {
    if (!this.placeholder) {
      this.placeholder = el("div", "nd-placeholder");
      this.placeholder.append(
        el("div", "", "The sketch pad is open in the Live Panel."),
        btn("Bring it back here", "Move the sketch pad back onto this node", () => this.releaseFromPanel()),
      );
    }
    this.mountedIn = target;
    target.appendChild(this.root);
    this.host.appendChild(this.placeholder);
    this.fit(); this.invalidate();
  }
  release() {
    if (!this.mountedIn) return;
    this.mountedIn = null;
    this.placeholder?.remove();
    this.host.appendChild(this.root);
    this.fit(); this.invalidate();
  }
  releaseFromPanel() {
    this.release();
    window.dispatchEvent(new CustomEvent("nougan-draw-released", { detail: { node: this.node } }));
  }
  destroy() {
    editors.delete(this);
    clearTimeout(this.saveT);
    cancelAnimationFrame(this.raf);
    this.layers.forEach((l) => this.freeGPU(l));
    if (this.mountedIn) { this.mountedIn = null; this.root.remove(); }
  }
}

// small public API so the Live Panel can find a node's editor without importing this file
window.NouganDraw = Object.assign(window.NouganDraw || {}, { editorOf: (node) => node?._nougan_draw || null });

// ───────────────────────────── extension ─────────────────────────────
app.registerExtension({
  name: "Nougan.DrawImage",

  setup() {
    // make sure the last stroke is on disk before a prompt is built
    const orig = app.graphToPrompt;
    app.graphToPrompt = async function (...args) {
      await Promise.all([...editors].map((e) => (e.pending ? e.flush() : e.chain)));
      return orig.apply(this, args);
    };
  },

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_ID) return;

    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      onCreated?.apply(this, arguments);
      this._nougan_draw = new DrawEditor(this);
      this.setSize([720, 640]);
    };
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      onConfigure?.apply(this, arguments);
      this._nougan_draw?.restore();
    };
    const onRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      onRemoved?.apply(this, arguments);
      this._nougan_draw?.destroy();
    };
  },
});
