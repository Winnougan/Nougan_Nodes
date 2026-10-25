// web/nougan_multi_load_image.js  —  Nougan Multi Load Image by Winnougan
// A list of image slots inside one node. "+" adds a slot (and a matching IMAGE output),
// "-" removes the last one. Each slot has a thumbnail, a file dropdown and an upload button;
// you can also drop image files onto the node. The chosen files live in the hidden
// "images_json" widget, so workflows save and load normally.
//
// v2 additions (all UI-side; nougan_multi_load_image.py is unchanged):
//   * List / Grid layouts and S / M / L thumbnail sizes (saved per node), thumbnails show the whole image
//   * Hover peek: a big floating preview when you rest the mouse on a thumbnail (toggle with the eye button)
//   * Full-screen viewer on click: zoom, pan, arrow-key browsing across slots, pixel (nearest) mode.
//     Rendered with WebGPU (mip-mapped, GPU zoom/pan); falls back to a plain <img> if WebGPU is unavailable.
//   * Per-slot clear / remove (removing a middle slot shifts later outputs and keeps their links)
//   * Paste from clipboard (button, or Ctrl+V while the mouse is over the node), drag & drop highlight
//   * "Clear all" with a two-step confirm, image dimensions on every slot

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_ID = "NouganMultiLoadImage";
const MAX_SLOTS = 16;
const MIN_W = 330;
const CHROME_H = 100;                         // header bar + footer + status + padding
const GAP = 6;
const LIST_TH = { S: 60, M: 112, L: 168 };    // list-view thumbnail size (px)
const GRID_MIN = { S: 104, M: 150, L: 210 };  // grid-view minimum cell width (px)
const DEFAULT_VIEW = { layout: "list", size: "S", hover: true };

// ---------------------------------------------------------------- styles

function injectStyles() {
  if (document.getElementById("nougan-mli-style")) return;
  const s = document.createElement("style");
  s.id = "nougan-mli-style";
  s.textContent = `
.nmi{box-sizing:border-box;position:relative;display:flex;flex-direction:column;gap:${GAP}px;width:100%;height:100%;padding:4px;
  font:12px system-ui,sans-serif;color:#e8e6f0;user-select:none;overflow-y:auto;overflow-x:hidden;border-radius:10px}
.nmi *{box-sizing:border-box}
.nmi.dragging{outline:2px dashed #ff7ad9;outline-offset:-2px;background:rgba(80,30,90,.18)}

.nmi-btn{all:unset;display:inline-block;cursor:pointer;height:24px;padding:0 9px;line-height:24px;border-radius:6px;text-align:center;
  background:#2b2347;border:1px solid #45367a;color:#e8e6f0;white-space:nowrap;transition:background .12s,filter .12s}
.nmi-btn:hover{background:#3a2f63}
.nmi-btn:active{transform:translateY(1px)}
.nmi-btn.off{opacity:.35;pointer-events:none}
.nmi-btn.on{background:linear-gradient(90deg,#6a46d8,#b44ad0);border-color:#8e6bff;color:#fff}
.nmi-btn.warn{background:#7a2a3c;border-color:#c0506a;color:#fff}
.nmi-add{background:linear-gradient(90deg,#6a46d8,#b44ad0);border-color:#8e6bff;font-weight:700;flex:1 1 auto}
.nmi-add:hover{filter:brightness(1.2);background:linear-gradient(90deg,#6a46d8,#b44ad0)}

.nmi-bar{display:flex;gap:5px;align-items:center;flex:0 0 26px;height:26px}
.nmi-seg{display:flex;border:1px solid #45367a;border-radius:7px;overflow:hidden;flex:0 0 auto}
.nmi-seg .nmi-btn{border:0;border-radius:0;height:24px;line-height:24px;padding:0 8px}
.nmi-count{margin-left:auto;color:#b9aee6;font-variant-numeric:tabular-nums;padding:0 4px;white-space:nowrap}

.nmi-list{display:flex;flex-direction:column;gap:${GAP}px;flex:0 0 auto}
.nmi-list.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(var(--cell,104px),1fr))}

.nmi-tile,.nmi-cell{position:relative;border-radius:9px;background:#1a1430;border:1px solid #3b2f5c;padding:5px;
  transition:border-color .12s,background .12s}
.nmi-tile{display:flex;gap:8px;align-items:stretch;height:calc(var(--th,60px) + 12px);flex:0 0 auto}
.nmi-cell{display:flex;flex-direction:column;gap:5px}
.nmi-tile.empty,.nmi-cell.empty{border-style:dashed;border-color:#8f3b4a}
.nmi-tile.drop,.nmi-cell.drop{border-color:#ff7ad9;background:#2a1b45}
.nmi-pop{animation:nmi-pop .26s cubic-bezier(.2,.9,.3,1.2) both}
@keyframes nmi-pop{from{opacity:0;transform:translateY(8px) scale(.96)}to{opacity:1;transform:none}}

.nmi-thumb{position:relative;overflow:hidden;border-radius:6px;cursor:zoom-in;
  background:repeating-conic-gradient(#1c1634 0% 25%,#120e20 0% 50%) 50%/12px 12px}
.nmi-tile .nmi-thumb{flex:0 0 var(--th,60px);width:var(--th,60px);height:var(--th,60px)}
.nmi-cell .nmi-thumb{width:100%;aspect-ratio:1/1}
.nmi-thumb img{width:100%;height:100%;object-fit:contain;display:block;transition:transform .18s}
.nmi-thumb:hover img{transform:scale(1.05)}
.nmi-thumb.blank{cursor:pointer;display:flex;align-items:center;justify-content:center;flex-direction:column;
  color:#7a6cab;font-size:11px;text-align:center;line-height:1.3}
.nmi-thumb.blank b{font-size:20px;font-weight:400}
.nmi-thumb.blank:hover{color:#d9ccff}
.nmi-badge{position:absolute;left:3px;top:3px;padding:0 6px;border-radius:999px;font-weight:700;font-size:11px;
  background:rgba(20,14,36,.85);border:1px solid #8e6bff;color:#fff;pointer-events:none}
.nmi-dims{position:absolute;right:3px;bottom:3px;padding:0 5px;border-radius:5px;background:rgba(20,14,36,.82);
  font-size:10px;color:#cfc6f5;font-variant-numeric:tabular-nums;pointer-events:none}
.nmi-dims:empty{display:none}
.nmi.sz-S .nmi-tile .nmi-dims{display:none}

.nmi-col{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;justify-content:space-between}
.nmi-head{color:#b9aee6;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.nmi-head span{color:#8f84bd}
.nmi select{width:100%;height:24px;border-radius:6px;background:#2b2347;border:1px solid #45367a;color:#e8e6f0;padding:0 4px;font-size:12px}
.nmi-row{display:flex;gap:5px;align-items:center}
.nmi-row .nmi-btn{flex:0 0 auto}
.nmi-row .nmi-btn.grow{flex:1 1 auto}

.nmi-foot{display:flex;gap:5px;align-items:center;flex:0 0 auto;padding-top:2px}
.nmi-status{color:#ffe08a;font-size:11px;flex:0 0 auto;min-height:14px}

/* hover peek (floats over everything, in screen space) */
.nmi-peek{position:fixed;z-index:99999;left:0;top:0;visibility:hidden;opacity:0;pointer-events:none;padding:6px;border-radius:10px;
  background:rgba(20,14,36,.96);border:1px solid #8e6bff;box-shadow:0 12px 40px rgba(0,0,0,.6);transition:opacity .12s;
  font:11px system-ui,sans-serif;color:#cfc6f5}
.nmi-peek.on{visibility:visible;opacity:1}
.nmi-peek img{display:block;max-width:min(440px,42vw);max-height:min(440px,52vh);border-radius:6px;
  background:repeating-conic-gradient(#1c1634 0% 25%,#120e20 0% 50%) 50%/12px 12px}
.nmi-peek div{margin-top:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:min(440px,42vw)}

/* full-screen viewer */
.nmv{position:fixed;inset:0;z-index:100000;display:none;flex-direction:column;background:rgba(8,6,16,.9);
  backdrop-filter:blur(8px);color:#e8e6f0;font:13px system-ui,sans-serif;user-select:none}
.nmv.open{display:flex;animation:nmv-in .16s ease-out}
@keyframes nmv-in{from{opacity:0}to{opacity:1}}
.nmv-top,.nmv-bot{display:flex;align-items:center;gap:8px;padding:8px 14px;flex:0 0 auto;background:rgba(20,14,36,.75)}
.nmv-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nmv-title b{color:#ff9be4;margin-right:4px}
.nmv-meta{color:#b9aee6;font-variant-numeric:tabular-nums;white-space:nowrap}
.nmv-hint{margin-left:auto;color:#7f74ab;font-size:11px}
.nmv-btn{all:unset;display:inline-block;cursor:pointer;height:28px;padding:0 12px;line-height:28px;border-radius:7px;text-align:center;
  background:#2b2347;border:1px solid #45367a;color:#e8e6f0;white-space:nowrap}
.nmv-btn:hover{background:#3a2f63}
.nmv-btn.on{background:linear-gradient(90deg,#6a46d8,#b44ad0);border-color:#8e6bff;color:#fff}
.nmv-stage{position:relative;flex:1 1 auto;min-height:0;overflow:hidden;cursor:grab;touch-action:none;
  background:repeating-conic-gradient(#171226 0% 25%,#120e20 0% 50%) 50%/16px 16px}
.nmv-stage.drag{cursor:grabbing}
.nmv-stage canvas{position:absolute;inset:0;width:100%;height:100%;display:block}
.nmv-load{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#cfc6f5;pointer-events:none}
.nmv-badge{position:absolute;right:10px;top:10px;padding:2px 8px;border-radius:999px;font-size:11px;background:rgba(20,14,36,.85);
  border:1px solid #45367a;color:#b9aee6;pointer-events:none}
.nmv-nav{all:unset;position:absolute;top:50%;transform:translateY(-50%);width:46px;height:70px;line-height:66px;text-align:center;
  font-size:38px;cursor:pointer;color:#e8e6f0;background:rgba(20,14,36,.55);border-radius:10px;transition:background .12s}
.nmv-nav:hover{background:rgba(106,70,216,.7)}
.nmv-nav.prev{left:12px}.nmv-nav.next{right:12px}
.nmv-nav.hide{display:none}
@media (prefers-reduced-motion:reduce){.nmi *,.nmv,.nmi-peek{animation:none!important;transition:none!important}}
`;
  document.head.appendChild(s);
}

// ---------------------------------------------------------------- helpers

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

const btn = (text, title, cls = "") => {
  const b = el("button", "nmi-btn" + (cls ? " " + cls : ""), text);
  if (title) b.title = title;
  return b;
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function parseRef(v) {
  if (!v) return null;
  let s = String(v).replace(/\\/g, "/");
  let type = "input";
  const m = s.match(/^(.*) \[(input|output|temp)\]$/);
  if (m) { s = m[1]; type = m[2]; }
  const i = s.lastIndexOf("/");
  return { filename: i >= 0 ? s.slice(i + 1) : s, subfolder: i >= 0 ? s.slice(0, i) : "", type };
}

const thumbUrl = (v) => {
  const r = parseRef(v);
  return r ? api.apiURL(`/view?filename=${encodeURIComponent(r.filename)}&type=${r.type}&subfolder=${encodeURIComponent(r.subfolder)}`) : "";
};

const shortName = (v, n = 20) => {
  const r = parseRef(v);
  const f = r ? r.filename : "";
  return f.length > n ? f.slice(0, n - 1) + "…" : f;
};

// The input folder's file list (same list the stock Load Image node shows).
const fileCache = { files: [], at: 0 };
async function getFiles(force = false) {
  if (!force && Date.now() - fileCache.at < 3000) return fileCache.files;
  try {
    const r = await api.fetchApi("/object_info/LoadImage");
    const j = await r.json();
    const spec = j?.LoadImage?.input?.required?.image;
    const list = Array.isArray(spec?.[0]) ? spec[0] : spec?.[1]?.options || [];
    fileCache.files = list.map(String);
    fileCache.at = Date.now();
  } catch (_) { /* keep the old list */ }
  return fileCache.files;
}

async function uploadImage(file) {
  const body = new FormData();
  body.append("image", file);
  body.append("type", "input");
  const r = await api.fetchApi("/upload/image", { method: "POST", body });
  if (r.status !== 200) throw new Error(`${r.status} ${r.statusText}`);
  const j = await r.json();
  return j.subfolder ? `${j.subfolder}/${j.name}` : j.name;
}

const isImageFile = (f) => f && (f.type?.startsWith("image/") || /\.(png|jpe?g|webp|bmp|gif|tiff?)$/i.test(f.name || ""));

function hideWidget(w) {
  if (!w) return;
  w.hidden = true;
  w.computeSize = () => [0, -4];
  w.type = "hidden";
  if (w.element) w.element.style.display = "none";
}

// image dimensions we've already seen, so re-rendering doesn't blank the labels
const dimsCache = new Map();

// ---------------------------------------------------------------- hover peek

const Peek = (() => {
  let box = null, img = null, cap = null, timer = 0, cur = "";

  function ensure() {
    if (box) return;
    box = el("div", "nmi-peek");
    img = el("img");
    img.draggable = false;
    cap = el("div");
    box.append(img, cap);
    document.body.appendChild(box);
  }

  function place(anchor) {
    const r = anchor.getBoundingClientRect();
    const bw = box.offsetWidth, bh = box.offsetHeight;
    let x = r.right + 12;
    if (x + bw > window.innerWidth - 8) x = r.left - 12 - bw;
    x = Math.max(8, x);
    const y = clamp(r.top, 8, Math.max(8, window.innerHeight - bh - 8));
    box.style.left = `${Math.round(x)}px`;
    box.style.top = `${Math.round(y)}px`;
  }

  function show(anchor, value, tag) {
    clearTimeout(timer);
    timer = setTimeout(() => {
      ensure();
      const url = thumbUrl(value);
      cur = url;
      img.onload = () => {
        if (cur !== url) return;
        cap.textContent = `${tag} · ${shortName(value, 40)} · ${img.naturalWidth}×${img.naturalHeight}`;
        place(anchor);
        box.classList.add("on");
      };
      img.src = url;
    }, 320);
  }

  function hide() {
    clearTimeout(timer);
    cur = "";
    box?.classList.remove("on");
  }

  return { show, hide };
})();

// ---------------------------------------------------------------- full-screen viewer (WebGPU, CSS fallback)

const VIEW_WGSL = `
struct U { canvas: vec2f, img: vec2f, off: vec2f, scale: f32, nearest: f32 }
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var tex: texture_2d<f32>;
@group(0) @binding(2) var smp: sampler;

struct VO { @builtin(position) pos: vec4f, @location(0) px: vec2f }

@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
    var tri = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
    var o: VO;
    o.pos = vec4f(tri[i], 0.0, 1.0);
    o.px = (vec2f(tri[i].x, -tri[i].y) * 0.5 + 0.5) * u.canvas;
    return o;
}

@fragment fn fs(@location(0) px: vec2f) -> @location(0) vec4f {
    let p = (px - u.canvas * 0.5 - u.off) / u.scale + u.img * 0.5;
    let uv = p / u.img;
    let cell = floor(px / 14.0);
    let chk = select(0.075, 0.105, ((i32(cell.x) + i32(cell.y)) & 1) == 0);
    var col = vec3f(chk);
    if (all(uv >= vec2f(0.0)) && all(uv <= vec2f(1.0))) {
        let lod = select(max(0.0, -log2(u.scale)), 0.0, u.nearest > 0.5);
        col = textureSampleLevel(tex, smp, uv, lod).rgb;
    }
    return vec4f(col, 1.0);
}`;

const mkCanvas = (w, h) => {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return c;
};

// WebGPU renderer: uploads the image once (with a mip chain, so zooming out stays smooth), then every
// pan / zoom is just a uniform update + one draw call.
async function gpuRenderer(canvas) {
  if (!navigator.gpu) throw new Error("WebGPU not available");
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("no WebGPU adapter");
  const device = await adapter.requestDevice();

  try {
    const module = device.createShaderModule({ code: VIEW_WGSL });
    const info = await module.getCompilationInfo();
    if (info.messages.some((m) => m.type === "error")) throw new Error(info.messages.map((m) => m.message).join("; "));

    const format = navigator.gpu.getPreferredCanvasFormat();
    const pipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: { module, entryPoint: "vs" },
      fragment: { module, entryPoint: "fs", targets: [{ format }] },
      primitive: { topology: "triangle-list" },
    });
    const ctx = canvas.getContext("webgpu");
    if (!ctx) throw new Error("no WebGPU canvas context");
    ctx.configure({ device, format, alphaMode: "opaque" });

    const ubuf = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const smpLinear = device.createSampler({ magFilter: "linear", minFilter: "linear", mipmapFilter: "linear" });
    const smpNearest = device.createSampler({ magFilter: "nearest", minFilter: "nearest", mipmapFilter: "nearest" });
    const u = new Float32Array(8);

    let texture = null, binds = null, W = 0, H = 0, lost = false;
    device.lost.then(() => { lost = true; });

    return {
      kind: "WebGPU",

      async load(blob) {
        const bitmap = await createImageBitmap(blob);
        try {
          const w = bitmap.width, h = bitmap.height;
          const max = device.limits.maxTextureDimension2D;
          if (w > max || h > max) throw new Error(`image is larger than the GPU texture limit (${max}px)`);

          const levels = Math.floor(Math.log2(Math.max(w, h))) + 1;
          const tex = device.createTexture({
            size: [w, h],
            format: "rgba8unorm",
            mipLevelCount: levels,
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
          });
          device.queue.copyExternalImageToTexture({ source: bitmap }, { texture: tex }, [w, h]);
          for (let l = 1; l < levels; l++) {
            const lw = Math.max(1, w >> l), lh = Math.max(1, h >> l);
            const oc = mkCanvas(lw, lh);
            const c2 = oc.getContext("2d");
            c2.imageSmoothingQuality = "high";
            c2.drawImage(bitmap, 0, 0, lw, lh);
            device.queue.copyExternalImageToTexture({ source: oc }, { texture: tex, mipLevel: l }, [lw, lh]);
          }

          texture?.destroy();
          texture = tex;
          W = w; H = h;
          const view = tex.createView();
          const layout = pipeline.getBindGroupLayout(0);
          const mk = (sampler) => device.createBindGroup({
            layout,
            entries: [{ binding: 0, resource: { buffer: ubuf } }, { binding: 1, resource: view }, { binding: 2, resource: sampler }],
          });
          binds = { linear: mk(smpLinear), nearest: mk(smpNearest) };
          return { w, h };
        } finally {
          bitmap.close?.();
        }
      },

      draw({ cw, ch, ox, oy, scale, nearest, dpr }) {
        if (lost) return false;
        if (!texture) return true;
        const pw = Math.max(1, Math.round(cw * dpr)), ph = Math.max(1, Math.round(ch * dpr));
        if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
        u[0] = pw; u[1] = ph; u[2] = W; u[3] = H;
        u[4] = ox * dpr; u[5] = oy * dpr; u[6] = scale * dpr; u[7] = nearest ? 1 : 0;
        device.queue.writeBuffer(ubuf, 0, u);

        const enc = device.createCommandEncoder();
        const pass = enc.beginRenderPass({
          colorAttachments: [{ view: ctx.getCurrentTexture().createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, nearest ? binds.nearest : binds.linear);
        pass.draw(3);
        pass.end();
        device.queue.submit([enc.finish()]);
        return true;
      },

      destroy() {
        try { texture?.destroy(); } catch { }
        try { device.destroy(); } catch { }
      },
    };
  } catch (e) {
    try { device.destroy(); } catch { }
    throw e;
  }
}

// Plain-<img> fallback with the same interface (CSS transform does the zoom / pan).
function cssRenderer(stage) {
  const img = el("img");
  img.draggable = false;
  img.alt = "";
  img.style.cssText = "position:absolute;left:50%;top:50%;max-width:none;max-height:none;transform-origin:center center;will-change:transform";
  stage.prepend(img);
  let url = "";
  return {
    kind: "CSS",
    async load(blob) {
      if (url) URL.revokeObjectURL(url);
      url = URL.createObjectURL(blob);
      img.src = url;
      await img.decode();
      return { w: img.naturalWidth, h: img.naturalHeight };
    },
    draw({ ox, oy, scale, nearest }) {
      img.style.transform = `translate(-50%,-50%) translate(${ox}px,${oy}px) scale(${scale})`;
      img.style.imageRendering = nearest ? "pixelated" : "auto";
      return true;
    },
    destroy() {
      if (url) URL.revokeObjectURL(url);
      img.remove();
    },
  };
}

const Viewer = (() => {
  let root = null, stage = null, titleEl, metaEl, zoomEl, badge, loadEl, btnPixel, navPrev, navNext;
  let items = [], idx = 0, renderer = null, canvas = null, token = 0, raf = 0, ro = null, isOpen = false;
  const V = { scale: 1, ox: 0, oy: 0, w: 0, h: 0, fit: true, nearest: false };

  const vbtn = (text, title, fn) => {
    const b = el("button", "nmv-btn", text);
    b.title = title;
    b.onclick = (e) => { e.stopPropagation(); fn(); };
    return b;
  };

  function build() {
    if (root) return;
    root = el("div", "nmv");

    const top = el("div", "nmv-top");
    titleEl = el("div", "nmv-title");
    metaEl = el("div", "nmv-meta");
    top.append(titleEl, metaEl, vbtn("✕", "Close (Esc)", close));

    stage = el("div", "nmv-stage");
    loadEl = el("div", "nmv-load", "Loading…");
    badge = el("div", "nmv-badge");
    navPrev = el("button", "nmv-nav prev", "‹");
    navNext = el("button", "nmv-nav next", "›");
    navPrev.onclick = (e) => { e.stopPropagation(); go(-1); };
    navNext.onclick = (e) => { e.stopPropagation(); go(1); };
    for (const n of [navPrev, navNext]) n.addEventListener("pointerdown", (e) => e.stopPropagation());
    stage.append(loadEl, badge, navPrev, navNext);

    const bot = el("div", "nmv-bot");
    zoomEl = el("span", "nmv-meta");
    btnPixel = vbtn("Pixels", "Nearest-neighbour sampling, for pixel peeping (P)", togglePixels);
    bot.append(
      zoomEl,
      vbtn("Fit", "Fit to window (F)", () => { fitView(); schedule(); }),
      vbtn("1:1", "Actual pixels (1)", () => zoomTo(1)),
      btnPixel,
      el("span", "nmv-hint", "wheel = zoom · drag = pan · double-click = fit / 100% · ← → = browse · Esc = close"),
    );

    root.append(top, stage, bot);
    document.body.appendChild(root);

    // pan
    let drag = null;
    stage.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      drag = { x: e.clientX, y: e.clientY, ox: V.ox, oy: V.oy };
      stage.setPointerCapture(e.pointerId);
      stage.classList.add("drag");
    });
    stage.addEventListener("pointermove", (e) => {
      if (!drag) return;
      V.ox = drag.ox + (e.clientX - drag.x);
      V.oy = drag.oy + (e.clientY - drag.y);
      V.fit = false;
      schedule();
    });
    const end = () => { drag = null; stage.classList.remove("drag"); };
    stage.addEventListener("pointerup", end);
    stage.addEventListener("pointercancel", end);

    // zoom around the cursor
    stage.addEventListener("wheel", (e) => {
      e.preventDefault();
      const r = stage.getBoundingClientRect();
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-dy * 0.0015));
    }, { passive: false });

    stage.addEventListener("dblclick", (e) => {
      const r = stage.getBoundingClientRect();
      if (V.fit || V.scale < 0.99) zoomAt(e.clientX - r.left, e.clientY - r.top, 1 / V.scale);
      else { fitView(); schedule(); }
    });
  }

  function fitView() {
    if (!stage || !V.w) return;
    const cw = stage.clientWidth, ch = stage.clientHeight;
    V.scale = Math.max(0.02, Math.min((cw - 32) / V.w, (ch - 32) / V.h, 4));
    V.ox = V.oy = 0;
    V.fit = true;
  }

  // keep the image point under (cx, cy) fixed while the scale changes (cx, cy relative to the stage)
  function zoomAt(cx, cy, factor) {
    const px = cx - stage.clientWidth / 2, py = cy - stage.clientHeight / 2;
    const s2 = clamp(V.scale * factor, 0.02, 64);
    const k = s2 / V.scale;
    V.ox = px - (px - V.ox) * k;
    V.oy = py - (py - V.oy) * k;
    V.scale = s2;
    V.fit = false;
    schedule();
  }

  const zoomTo = (s) => zoomAt(stage.clientWidth / 2, stage.clientHeight / 2, s / V.scale);

  function togglePixels() {
    V.nearest = !V.nearest;
    btnPixel.classList.toggle("on", V.nearest);
    schedule();
  }

  function schedule() { if (!raf) raf = requestAnimationFrame(draw); }

  function draw() {
    raf = 0;
    if (!renderer || !V.w || !stage) return;
    const ok = renderer.draw({
      cw: stage.clientWidth, ch: stage.clientHeight, ox: V.ox, oy: V.oy,
      scale: V.scale, nearest: V.nearest, dpr: window.devicePixelRatio || 1,
    });
    if (ok === false) { fallbackToCSS(); return; }
    zoomEl.textContent = `${Math.round(V.scale * 100)}%`;
  }

  function fallbackToCSS() {
    console.info("[Nougan] viewer: falling back to the plain image renderer");
    renderer?.destroy();
    canvas?.remove();
    canvas = null;
    renderer = cssRenderer(stage);
    badge.textContent = renderer.kind;
    show(idx);
  }

  function go(d) { if (items.length > 1) show(idx + d); }

  async function show(i) {
    idx = ((i % items.length) + items.length) % items.length;
    const my = ++token;
    const it = items[idx];
    titleEl.replaceChildren(el("b", "", it.tag), document.createTextNode(it.name));
    metaEl.textContent = items.length > 1 ? `${idx + 1} / ${items.length}` : "";
    loadEl.textContent = "Loading…";
    loadEl.style.display = "flex";
    navPrev.classList.toggle("hide", items.length < 2);
    navNext.classList.toggle("hide", items.length < 2);

    try {
      const res = await fetch(it.url);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const blob = await res.blob();
      if (my !== token) return;
      const dims = await renderer.load(blob);
      if (my !== token) return;
      V.w = dims.w; V.h = dims.h;
      dimsCache.set(it.name, { w: dims.w, h: dims.h });
      loadEl.style.display = "none";
      metaEl.textContent = `${dims.w}×${dims.h}` + (items.length > 1 ? `  ·  ${idx + 1} / ${items.length}` : "");
      fitView();
      schedule();
    } catch (e) {
      if (my !== token) return;
      if (renderer?.kind === "WebGPU") { console.warn("[Nougan] viewer GPU load failed:", e?.message || e); fallbackToCSS(); return; }
      console.error("[Nougan] viewer:", e);
      loadEl.textContent = `Couldn't load this image (${e?.message || e})`;
    }
  }

  function onKey(e) {
    const k = e.key;
    const cx = stage.clientWidth / 2, cy = stage.clientHeight / 2;
    if (k === "Escape") close();
    else if (k === "ArrowLeft") go(-1);
    else if (k === "ArrowRight") go(1);
    else if (k === "f" || k === "F") { fitView(); schedule(); }
    else if (k === "1") zoomTo(1);
    else if (k === "p" || k === "P") togglePixels();
    else if (k === "+" || k === "=") zoomAt(cx, cy, 1.25);
    else if (k === "-" || k === "_") zoomAt(cx, cy, 0.8);
    else { e.stopPropagation(); return; }     // keep ComfyUI shortcuts (Delete, etc.) from firing behind the viewer
    e.preventDefault();
    e.stopPropagation();
  }

  async function open(list, start = 0) {
    if (!list?.length || isOpen) return;
    build();
    Peek.hide();
    items = list;
    isOpen = true;
    root.classList.add("open");
    window.addEventListener("keydown", onKey, true);
    ro = typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(() => { if (V.fit) fitView(); schedule(); })
      : null;
    ro?.observe(stage);

    canvas = document.createElement("canvas");
    stage.prepend(canvas);
    let r;
    try { r = await gpuRenderer(canvas); }
    catch (e) {
      console.info("[Nougan] viewer: WebGPU unavailable, using the plain image renderer:", e?.message || e);
      canvas.remove();
      canvas = null;
      r = cssRenderer(stage);
    }
    if (!isOpen) { r.destroy(); return; }       // closed while the GPU was starting up
    renderer = r;
    badge.textContent = renderer.kind;
    V.nearest = false;
    btnPixel.classList.remove("on");
    show(start);
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    token++;
    root.classList.remove("open");
    window.removeEventListener("keydown", onKey, true);
    ro?.disconnect();
    ro = null;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    renderer?.destroy();
    renderer = null;
    canvas?.remove();
    canvas = null;
    V.w = V.h = 0;
  }

  return { open, close, get isOpen() { return isOpen; } };
})();

// ---------------------------------------------------------------- node UI

function buildUI(node) {
  const store = node.widgets.find((w) => w.name === "images_json");
  hideWidget(store);

  const view = { ...DEFAULT_VIEW };
  const loadView = () => {
    const p = node.properties?.nmi_view;
    if (p && typeof p === "object") {
      if (p.layout === "list" || p.layout === "grid") view.layout = p.layout;
      if (p.size === "S" || p.size === "M" || p.size === "L") view.size = p.size;
      if (typeof p.hover === "boolean") view.hover = p.hover;
    }
  };
  const saveView = () => { node.properties = node.properties || {}; node.properties.nmi_view = { ...view }; };

  // ---- skeleton
  const root = el("div", "nmi");

  const bar = el("div", "nmi-bar");
  const segLayout = el("div", "nmi-seg");
  const bList = btn("☰", "List view");
  const bGrid = btn("▦", "Grid view");
  segLayout.append(bList, bGrid);
  const segSize = el("div", "nmi-seg");
  const sizeBtns = {};
  for (const k of ["S", "M", "L"]) { sizeBtns[k] = btn(k, `Thumbnail size ${k}`); segSize.appendChild(sizeBtns[k]); }
  const bHover = btn("👁", "Hover preview: rest the mouse on a thumbnail to see it bigger");
  const count = el("span", "nmi-count");
  const refresh = btn("🔄", "Re-read the input folder");
  bar.append(segLayout, segSize, bHover, count, refresh);

  const list = el("div", "nmi-list");
  const status = el("div", "nmi-status");

  const foot = el("div", "nmi-foot");
  const add = btn("＋ Add image", "Add another image slot (and output)", "nmi-add");
  const paste = btn("📋", "Paste an image from the clipboard (or press Ctrl+V while the mouse is over this node)");
  const sub = btn("−", "Remove the last image slot (and its output)");
  const clear = btn("🗑", "Clear all slots (click twice to confirm)");
  foot.append(add, paste, sub, clear);

  root.append(bar, list, status, foot);

  let names = [""];
  let lastCount = null;           // slots drawn last time, so only new ones animate
  let clearTimer = 0;

  const read = () => {
    let arr = [];
    try { arr = JSON.parse(store?.value ?? "[]"); } catch (_) { arr = []; }
    names = (Array.isArray(arr) ? arr : []).map((x) => (typeof x === "string" ? x : "")).slice(0, MAX_SLOTS);
    if (!names.length) names = [""];
  };

  const write = () => {
    if (!store) return;
    store.value = JSON.stringify(names);
    store.callback?.(store.value);
    app.graph?.setDirtyCanvas(true, true);
  };

  const flash = (msg, ms = 2500) => {
    status.textContent = msg;
    if (ms) setTimeout(() => { if (status.textContent === msg) status.textContent = ""; }, ms);
  };

  // ---- outputs: one IMAGE output per slot
  function syncOutputs(allowShrink) {
    while (node.outputs.length < names.length) node.addOutput(`image_${node.outputs.length + 1}`, "IMAGE");
    if (allowShrink) {
      while (node.outputs.length > names.length) node.removeOutput(node.outputs.length - 1);
    }
    node.outputs.forEach((o, i) => {
      o.label = `P${i + 1}` + (names[i] ? ` · ${shortName(names[i])}` : "");
    });
  }

  // ---- sizing: tell LiteGraph how tall the widget wants to be
  function contentHeight() {
    const n = names.length;
    if (view.layout === "list") return n * (LIST_TH[view.size] + 12) + (n - 1) * GAP + CHROME_H;
    const inner = Math.max(node.size?.[0] ?? MIN_W, MIN_W) - 28;
    const min = GRID_MIN[view.size];
    const cols = Math.max(1, Math.floor((inner + GAP) / (min + GAP)));
    const cellW = (inner - (cols - 1) * GAP) / cols;
    const rows = Math.ceil(n / cols);
    return Math.round(rows * (cellW + 62) + (rows - 1) * GAP + CHROME_H);
  }

  function fit() {
    const h = contentHeight();
    if (node._nmiWidget) node._nmiWidget.computeSize = (w) => [w, h];
    const sz = node.computeSize();
    node.setSize([Math.max(node.size[0], MIN_W), sz[1]]);
    app.graph?.setDirtyCanvas(true, true);
  }

  // ---- upload handling (also used by drag & drop and paste)
  async function handleFiles(index, files) {
    const imgs = [...files].filter(isImageFile);
    if (!imgs.length) return;
    for (let k = 0; k < imgs.length; k++) {
      let target = k === 0 ? index : names.length;
      if (target >= MAX_SLOTS) { flash(`Max ${MAX_SLOTS} images`); break; }
      if (target >= names.length) { names.push(""); structureChanged(false); target = names.length - 1; }
      flash(`Uploading ${imgs[k].name}…`, 0);
      try {
        const value = await uploadImage(imgs[k]);
        await getFiles(true);
        names[target] = value;
        write();
        syncOutputs(false);
        render();
        flash("");
      } catch (err) {
        console.error("[Nougan] upload failed:", err);
        flash(`Upload failed: ${err.message || err}`, 5000);
      }
    }
  }

  // new images fill the first empty slot, the rest get new slots
  const addFiles = (files) => {
    const firstEmpty = names.findIndex((n) => !n);
    return handleFiles(firstEmpty >= 0 ? firstEmpty : names.length, files);
  };

  async function pasteFromClipboard() {
    try {
      const clip = await navigator.clipboard.read();
      const files = [];
      for (const it of clip) {
        const type = it.types.find((t) => t.startsWith("image/"));
        if (!type) continue;
        const blob = await it.getType(type);
        files.push(new File([blob], `pasted_${Date.now()}_${files.length}.${(type.split("/")[1] || "png").replace("jpeg", "jpg")}`, { type }));
      }
      if (!files.length) { flash("No image on the clipboard"); return; }
      addFiles(files);
    } catch (err) {
      console.warn("[Nougan] clipboard read failed:", err);
      flash("Clipboard blocked by the browser. Hover the node and press Ctrl+V instead.", 5000);
    }
  }

  // ---- slot operations
  function clearSlot(i) {
    names[i] = "";
    write();
    syncOutputs(false);
    render();
  }

  // Removing a slot in the middle: LiteGraph's removeOutput shifts later outputs (and their links) down by one,
  // which matches names.splice, so downstream connections stay attached to the same pictures.
  function removeAt(i) {
    if (names.length <= 1) { clearSlot(0); return; }
    names.splice(i, 1);
    if (i < node.outputs.length) node.removeOutput(i);
    structureChanged(true);
  }

  function structureChanged(shrink) {
    write();
    syncOutputs(shrink);
    fit();
    render();
  }

  function openViewer(slot) {
    const items = names
      .map((n, i) => ({ n, i }))
      .filter((x) => x.n)
      .map(({ n, i }) => ({ tag: `P${i + 1}`, name: n, url: thumbUrl(n), slot: i }));
    if (!items.length) return;
    const k = Math.max(0, items.findIndex((it) => it.slot === slot));
    Peek.hide();
    Viewer.open(items, k);
  }

  // ---- tiles
  function makeTile(i, files, grid) {
    const value = names[i];
    const tile = el("div", (grid ? "nmi-cell" : "nmi-tile") + (value ? "" : " empty"));
    if (lastCount !== null && i >= lastCount) tile.classList.add("nmi-pop");

    // hidden file input for this slot
    const input = el("input");
    input.type = "file";
    input.accept = "image/*";
    input.multiple = true;
    input.style.display = "none";
    input.onchange = () => { handleFiles(i, input.files); input.value = ""; };
    const pick = () => input.click();

    // thumbnail
    const thumb = el("div", "nmi-thumb" + (value ? "" : " blank"));
    const dimsEl = el("div", "nmi-dims");
    let headDims = null;
    const setDims = (d) => {
      const txt = d ? `${d.w}×${d.h}` : "";
      dimsEl.textContent = txt;
      if (headDims) headDims.textContent = txt ? ` · ${txt}` : "";
    };

    if (value) {
      const img = el("img");
      img.draggable = false;
      img.alt = "";
      img.onload = () => {
        dimsCache.set(value, { w: img.naturalWidth, h: img.naturalHeight });
        setDims(dimsCache.get(value));
      };
      img.onerror = () => { img.style.display = "none"; };
      img.src = thumbUrl(value);
      thumb.appendChild(img);
      thumb.title = "Click to view full size";
      thumb.onclick = () => openViewer(i);
      thumb.addEventListener("mouseenter", () => { if (view.hover) Peek.show(thumb, value, `P${i + 1}`); });
      thumb.addEventListener("mouseleave", () => Peek.hide());
      thumb.addEventListener("pointerdown", () => Peek.hide());
      thumb.addEventListener("wheel", () => Peek.hide(), { passive: true });
    } else {
      const b = el("b", "", "＋");
      thumb.append(b, document.createTextNode("empty"));
      thumb.title = "Click to upload an image";
      thumb.onclick = pick;
    }
    thumb.append(el("div", "nmi-badge", `P${i + 1}`), dimsEl);

    // dropdown
    const sel = el("select");
    const addOpt = (v, label) => { const o = el("option", "", label); o.value = v; sel.appendChild(o); };
    addOpt("", "(choose an image…)");
    const known = new Set(files);
    if (value && !known.has(value)) addOpt(value, `${value}  (not in input folder)`);
    for (const f of files) addOpt(f, f);
    sel.value = value;
    sel.onfocus = () => getFiles(true).then((fresh) => {
      // pick up files added since the node was drawn, without resetting the dropdown
      for (const f of fresh) {
        if (![...sel.options].some((o) => o.value === f)) addOpt(f, f);
      }
    });
    sel.onchange = () => {
      names[i] = sel.value;
      write();
      syncOutputs(false);
      render();
    };

    // buttons
    const row = el("div", "nmi-row");
    const up = btn(grid ? "📁" : "📁 Upload", "Upload image(s) into this slot", grid ? "grow" : "");
    up.onclick = pick;
    const clr = btn("⌫", "Clear this slot's image", value ? "" : "off");
    clr.onclick = () => clearSlot(i);
    const del = btn("✕", "Remove this slot (and its output)", names.length > 1 ? "" : "off");
    del.onclick = () => removeAt(i);
    row.append(up, clr, del, input);

    if (grid) {
      tile.append(thumb, sel, row);
    } else {
      const col = el("div", "nmi-col");
      const head = el("div", "nmi-head", `Picture ${i + 1}  →  image_${i + 1}`);
      headDims = el("span");
      head.appendChild(headDims);
      col.append(head, sel, row);
      tile.append(thumb, col);
    }
    if (value && dimsCache.has(value)) setDims(dimsCache.get(value));

    // drop files on a tile to put them in that slot
    tile.addEventListener("dragover", (e) => {
      if ([...(e.dataTransfer?.items || [])].some((it) => it.kind === "file")) {
        e.preventDefault();
        tile.classList.add("drop");
      }
    });
    tile.addEventListener("dragleave", () => tile.classList.remove("drop"));
    tile.addEventListener("drop", (e) => {
      tile.classList.remove("drop");
      if (e.dataTransfer?.files?.length) {
        e.preventDefault();
        e.stopPropagation();
        handleFiles(i, e.dataTransfer.files);
      }
    });
    return tile;
  }

  function updateBar() {
    bList.classList.toggle("on", view.layout === "list");
    bGrid.classList.toggle("on", view.layout === "grid");
    for (const k of Object.keys(sizeBtns)) sizeBtns[k].classList.toggle("on", view.size === k);
    bHover.classList.toggle("on", view.hover);
    count.textContent = `${names.length} / ${MAX_SLOTS}`;
    count.title = `${names.filter(Boolean).length} of ${names.length} slots have an image`;
    add.classList.toggle("off", names.length >= MAX_SLOTS);
    sub.classList.toggle("off", names.length <= 1);
  }

  async function render() {
    const files = await getFiles();
    const grid = view.layout === "grid";
    root.classList.toggle("lay-grid", grid);
    root.classList.toggle("lay-list", !grid);
    for (const k of ["S", "M", "L"]) root.classList.toggle(`sz-${k}`, view.size === k);
    root.style.setProperty("--th", `${LIST_TH[view.size]}px`);
    root.style.setProperty("--cell", `${GRID_MIN[view.size]}px`);
    list.classList.toggle("grid", grid);

    list.replaceChildren(...names.map((_, i) => makeTile(i, files, grid)));
    lastCount = names.length;
    updateBar();
  }

  function setView(patch) {
    Object.assign(view, patch);
    saveView();
    if (!view.hover) Peek.hide();
    fit();
    lastCount = null;           // no pop-in animation just for switching views
    render();
  }

  // ---- header / footer wiring
  bList.onclick = () => setView({ layout: "list" });
  bGrid.onclick = () => setView({ layout: "grid" });
  for (const k of Object.keys(sizeBtns)) sizeBtns[k].onclick = () => setView({ size: k });
  bHover.onclick = () => setView({ hover: !view.hover });
  refresh.onclick = async () => { await getFiles(true); render(); flash("Input folder re-read", 1500); };

  add.onclick = () => {
    if (names.length >= MAX_SLOTS) return;
    names.push("");
    structureChanged(false);
  };
  sub.onclick = () => {
    if (names.length <= 1) return;
    names.pop();
    structureChanged(true); // removeOutput also drops any link on that output
  };
  paste.onclick = pasteFromClipboard;
  clear.onclick = () => {
    if (clear.classList.contains("warn")) {
      clearTimeout(clearTimer);
      clear.classList.remove("warn");
      clear.textContent = "🗑";
      names = [""];
      structureChanged(true);
      return;
    }
    clear.classList.add("warn");
    clear.textContent = "Sure?";
    clearTimer = setTimeout(() => { clear.classList.remove("warn"); clear.textContent = "🗑"; }, 2500);
  };

  // ---- dropping files anywhere on the node adds them (first empty slot first)
  let dragDepth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.items || [])].some((it) => it.kind === "file");
  root.addEventListener("dragenter", (e) => { if (hasFiles(e)) { dragDepth++; root.classList.add("dragging"); } });
  root.addEventListener("dragleave", () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) root.classList.remove("dragging"); });
  root.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
  root.addEventListener("drop", () => { dragDepth = 0; root.classList.remove("dragging"); }, true);
  root.addEventListener("drop", (e) => {
    if (e.dataTransfer?.files?.length) {
      e.preventDefault();
      addFiles(e.dataTransfer.files);
    }
  });

  // Ctrl+V with the mouse over this node: take the image ourselves so ComfyUI doesn't spawn a new Load Image node
  const onPaste = (e) => {
    if (!root.isConnected || !root.matches(":hover")) return;
    const files = [...(e.clipboardData?.files || [])].filter(isImageFile);
    if (!files.length) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    addFiles(files);
  };
  window.addEventListener("paste", onPaste, true);

  // Called after the workflow loads: rebuild everything from the saved widget value.
  function reload() {
    read();
    loadView();
    syncOutputs(false);
    fit();
    lastCount = null;
    render();
  }

  function destroy() {
    window.removeEventListener("paste", onPaste, true);
    clearTimeout(clearTimer);
    Peek.hide();
  }

  read();
  loadView();
  return { root, reload, write, syncOutputs, fit, render, destroy, getNames: () => names, minHeight: () => LIST_TH.S + 12 + CHROME_H };
}

// ---------------------------------------------------------------- extension

app.registerExtension({
  name: "Nougan.MultiLoadImage",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== NODE_ID) return;
    injectStyles();

    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onCreated ? onCreated.apply(this, arguments) : undefined;

      // Python declares MAX_SLOTS outputs; start with just the first one.
      while (this.outputs.length > 1) this.removeOutput(this.outputs.length - 1);

      const ui = buildUI(this);
      this._nmi = ui;
      const widget = this.addDOMWidget("nmi_list", "nougan_multi_images", ui.root, {
        serialize: false,
        hideOnZoom: false,
        getMinHeight: () => ui.minHeight(),
      });
      widget.computeSize = (w) => [w, ui.minHeight()];
      this._nmiWidget = widget;

      ui.write();
      ui.syncOutputs(false);
      ui.fit();
      ui.render();
      return r;
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;
      // widgets_values are applied by now; re-hide the store widget and rebuild the list
      hideWidget(this.widgets?.find((w) => w.name === "images_json"));
      this._nmi?.reload();
      return r;
    };

    const onRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      onRemoved?.apply(this, arguments);
      try { this._nmi?.destroy(); } catch (_) { /* ignore */ }
    };
  },
});
