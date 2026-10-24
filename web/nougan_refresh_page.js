// web/nougan_refresh_page.js  -  Nougan Refresh Page by Winnougan
//
// Buttons:  Reload models (same as pressing R) | Refresh page (full reload) | Clean now (runs the
//           node's current toggles immediately, only while no run is active).
// Visual:   a DOM widget holding a WebGPU canvas (live VRAM ring + ripple when memory is freed).
//           Falls back to Canvas2D when WebGPU is missing. WebGPU needs a secure context, so it
//           works on localhost / https but not on http://<LAN-ip>.

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_NAME = "NouganRefreshPage";
const RELOAD_LABEL = "Reload models ♻️ (R)";
const PAGE_LABEL = "Refresh page 🔄";
const CLEAN_LABEL = "Clean now 🧹";
const GB = 1024 ** 3;
const fmtGB = (b) => (b / GB).toFixed(2);

// Run whatever "refresh node definitions" mechanism this ComfyUI frontend has.
async function reloadModels() {
  const cmd = app.extensionManager?.command;
  if (cmd?.execute) {
    try {
      await cmd.execute("Comfy.RefreshNodeDefinitions"); // the command the R key runs
      return true;
    } catch (_) { /* fall through to the older API */ }
  }
  if (typeof app.refreshComboInNodes === "function") {
    await app.refreshComboInNodes();
    return true;
  }
  return false;
}

// ------------------------------------------------------------------ shared VRAM poller
// One GET every 2 s, only while at least one node is on screen.
const poller = { subs: new Set(), timer: null, busy: false };
async function pollOnce() {
  if (poller.busy) return;
  poller.busy = true;
  try {
    const r = await api.fetchApi("/nougan/vram");
    if (r.ok) {
      const data = await r.json();
      for (const fn of poller.subs) fn(data);
    }
  } catch (_) { /* server restarting, ignore */ }
  finally { poller.busy = false; }
}
function subscribe(fn) {
  poller.subs.add(fn);
  if (!poller.timer) {
    pollOnce();
    poller.timer = setInterval(() => { if (!document.hidden) pollOnce(); }, 2000);
  }
  return () => {
    poller.subs.delete(fn);
    if (!poller.subs.size && poller.timer) {
      clearInterval(poller.timer);
      poller.timer = null;
    }
  };
}

// ------------------------------------------------------------------ WebGPU
const SHADER = /* wgsl */ `
struct U { res: vec2f, time: f32, used: f32, ripple: f32, pad0: f32, pad1: f32, pad2: f32 };
@group(0) @binding(0) var<uniform> u: U;

fn hash(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453); }
fn noise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let w = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2f(1.0, 0.0)), w.x),
             mix(hash(i + vec2f(0.0, 1.0)), hash(i + vec2f(1.0, 1.0)), w.x), w.y);
}
fn fbm(p: vec2f) -> f32 {
  var v = 0.0;
  var a = 0.5;
  var q = p;
  for (var k = 0; k < 4; k++) { v += a * noise(q); q = q * 2.0; a = a * 0.5; }
  return v;
}
fn ramp(t: f32) -> vec3f {
  let g = vec3f(0.0, 0.80, 0.30);
  let y = vec3f(0.98, 0.78, 0.20);
  let p = vec3f(1.0, 0.30, 0.50);
  return mix(mix(g, y, smoothstep(0.0, 0.6, t)), p, smoothstep(0.6, 1.0, t));
}

@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}

@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let m = min(u.res.x, u.res.y);
  let uv = (pos.xy - 0.5 * u.res) / m;
  let r = length(uv);
  var a = (atan2(uv.y, uv.x) + 1.5707963) / 6.2831853;   // 0 at 12 o'clock, clockwise
  a = a - floor(a);
  let px = 1.5 / m;

  let n = fbm(uv * 3.0 + vec2f(u.time * 0.05, -u.time * 0.03));
  var col = mix(vec3f(0.025, 0.035, 0.05), vec3f(0.04, 0.11, 0.09), n);

  let R = 0.30;
  let wd = 0.05 + 0.004 * sin(u.time * 1.6 + a * 18.0);
  let d = abs(r - R) - wd * 0.5;
  let ringMask = 1.0 - smoothstep(0.0, px, d);
  let fillMask = 1.0 - smoothstep(0.0, 0.004, a - u.used);
  let tint = ramp(u.used);

  col += vec3f(0.5) * ringMask * 0.10;                               // empty track
  col = mix(col, tint, ringMask * fillMask);                         // filled arc
  col += tint * exp(-max(d, 0.0) * 22.0) * 0.35 * fillMask;          // glow
  col += tint * (1.0 - smoothstep(0.0, 0.22, r)) * 0.06;             // soft core

  if (u.ripple >= 0.0) {                                             // "memory freed" ripple
    let rr = 0.12 + u.ripple * 0.55;
    let k = (r - rr) * 16.0;
    col += vec3f(0.55, 1.0, 0.8) * exp(-k * k) * (1.0 - u.ripple) * 0.8;
  }
  col = col * (1.0 - 0.35 * smoothstep(0.35, 0.9, r));               // vignette
  return vec4f(col, 1.0);
}
`;

// One GPUDevice shared by every node on the graph.
let gpuDevicePromise = null;
function getGPUDevice() {
  if (!navigator.gpu) {
    return Promise.reject(new Error("navigator.gpu missing (needs a secure context: localhost or https)"));
  }
  if (!gpuDevicePromise) {
    gpuDevicePromise = navigator.gpu.requestAdapter().then((adapter) => {
      if (!adapter) throw new Error("no WebGPU adapter");
      return adapter.requestDevice();
    }).then((device) => {
      device.lost.then(() => { gpuDevicePromise = null; });
      return device;
    });
    gpuDevicePromise.catch(() => { gpuDevicePromise = null; });
  }
  return gpuDevicePromise;
}

async function makeGPURenderer(canvas) {
  const device = await getGPUDevice();
  const ctx = canvas.getContext("webgpu");
  if (!ctx) throw new Error("no webgpu canvas context");
  const format = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({ device, format, alphaMode: "opaque" });

  // WebGPU reports shader errors asynchronously and does not throw, so catch them explicitly
  // and let the caller fall back to Canvas2D instead of showing a blank box.
  device.pushErrorScope("validation");
  const module = device.createShaderModule({ code: SHADER });
  const pipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: { module, entryPoint: "vs" },
    fragment: { module, entryPoint: "fs", targets: [{ format }] },
    primitive: { topology: "triangle-list" },
  });
  const gpuError = await device.popErrorScope();
  if (gpuError) throw new Error("shader/pipeline error: " + gpuError.message);
  const buffer = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const bind = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer } }],
  });
  const data = new Float32Array(8);

  return {
    kind: "WebGPU",
    lost: device.lost,
    draw(s) {
      data[0] = canvas.width;
      data[1] = canvas.height;
      data[2] = s.time;
      data[3] = s.used;
      data[4] = s.ripple;
      device.queue.writeBuffer(buffer, 0, data);
      const enc = device.createCommandEncoder();
      const pass = enc.beginRenderPass({
        colorAttachments: [{
          view: ctx.getCurrentTexture().createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: "clear",
          storeOp: "store",
        }],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bind);
      pass.draw(3);
      pass.end();
      device.queue.submit([enc.finish()]);
    },
    destroy() {
      try { buffer.destroy(); ctx.unconfigure(); } catch (_) { /* already gone */ }
    },
  };
}

function make2DRenderer(canvas) {
  const ctx = canvas.getContext("2d");
  return {
    kind: "Canvas2D",
    draw(s) {
      const W = canvas.width, H = canvas.height, m = Math.min(W, H);
      const cx = W / 2, cy = H / 2, R = m * 0.30;
      ctx.fillStyle = "#0a0d12";
      ctx.fillRect(0, 0, W, H);
      ctx.lineCap = "round";
      ctx.lineWidth = m * 0.05;
      ctx.strokeStyle = "rgba(255,255,255,0.10)";
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = `hsl(${140 - 140 * s.used}, 80%, 55%)`;
      ctx.beginPath(); ctx.arc(cx, cy, R, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * s.used); ctx.stroke();
      if (s.ripple >= 0) {
        ctx.lineWidth = 2 * (window.devicePixelRatio || 1);
        ctx.strokeStyle = `rgba(140,255,200,${0.8 * (1 - s.ripple)})`;
        ctx.beginPath(); ctx.arc(cx, cy, m * (0.12 + 0.55 * s.ripple), 0, Math.PI * 2); ctx.stroke();
      }
    },
    destroy() {},
  };
}

// ------------------------------------------------------------------ node glue
function addButton(node, label, onClick) {
  // serialize:false keeps buttons out of widgets_values, so saved workflows stay aligned.
  return node.addWidget("button", label, null, onClick, { serialize: false });
}

function flash(node, btn, text, original, ms = 1600) {
  btn.name = text;
  node.setDirtyCanvas(true, true);
  setTimeout(() => {
    btn.name = original;
    node.setDirtyCanvas(true, true);
  }, ms);
}

function setupNode(node) {
  const widgetValue = (name, fallback) => node.widgets?.find((w) => w.name === name)?.value ?? fallback;

  // ---- buttons
  let reloading = false;
  const reloadBtn = addButton(node, RELOAD_LABEL, async () => {
    if (reloading) return;
    reloading = true;
    reloadBtn.name = "Reloading models…";
    node.setDirtyCanvas(true, true);
    let label = "Models reloaded ✔";
    try {
      if (!(await reloadModels())) label = "Reload not supported ✘";
    } catch (err) {
      console.error("[Nougan] Reload models failed:", err);
      label = "Reload failed ✘ (see console)";
    }
    reloadBtn.name = label;
    node.setDirtyCanvas(true, true);
    setTimeout(() => {
      reloadBtn.name = RELOAD_LABEL;
      reloading = false;
      node.setDirtyCanvas(true, true);
    }, 1500);
  });

  addButton(node, PAGE_LABEL, () => window.location.reload());

  let cleaning = false;
  const cleanBtn = addButton(node, CLEAN_LABEL, async () => {
    if (cleaning) return;
    cleaning = true;
    cleanBtn.name = "Cleaning…";
    node.setDirtyCanvas(true, true);
    let label = "Cleaned ✔";
    try {
      const res = await api.fetchApi("/nougan/clean", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vram: widgetValue("clean_vram", true),
          cache: widgetValue("clear_cache", true),
          node_cache: widgetValue("clear_node_cache", false),
          kitchen: widgetValue("kitchen_backend", "leave as is"),
        }),
      });
      if (res.status === 409) label = "Busy: a run is active ✘";
      else if (!res.ok) label = "Clean failed ✘";
      else showResult(await res.json());
    } catch (err) {
      console.error("[Nougan] Clean now failed:", err);
      label = "Clean failed ✘ (see console)";
    }
    cleaning = false;
    flash(node, cleanBtn, label, CLEAN_LABEL);
  });

  // ---- DOM widget: WebGPU canvas + text overlay
  const root = document.createElement("div");
  root.style.cssText =
    "position:relative;width:100%;height:100%;min-height:150px;border-radius:8px;overflow:hidden;background:#0a0d12;";
  const overlay = document.createElement("div");
  overlay.style.cssText =
    "position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;" +
    "gap:2px;pointer-events:none;font:12px/1.3 ui-monospace,Consolas,monospace;color:#d8fff0;" +
    "text-shadow:0 1px 3px #000;text-align:center;";
  const big = document.createElement("div");
  big.style.cssText = "font-size:15px;font-weight:600;";
  big.textContent = "… / … GB";
  const sub = document.createElement("div");
  sub.style.cssText = "opacity:.8;font-size:11px;";
  const foot = document.createElement("div");
  foot.style.cssText = "position:absolute;left:0;right:0;bottom:5px;opacity:.6;font-size:10px;";
  overlay.append(big, sub);
  root.append(overlay, foot);

  node.addDOMWidget("nougan_viz", "nougan_viz", root, {
    serialize: false,
    hideOnZoom: true,
    getMinHeight: () => 150,
  });

  const st = { time: 0, used: 0, target: 0, ripple: -1, rippleStart: 0 };
  let total = 0, used = 0, kitchenText = "", subUntil = 0, subText = "";
  let canvas = null, renderer = null, raf = 0, last = 0, visible = false, removed = false;

  const paint = () => {
    big.textContent = total ? `${fmtGB(used)} / ${fmtGB(total)} GB` : "no CUDA device";
    sub.textContent = performance.now() < subUntil ? subText : total ? `${Math.round((used / total) * 100)}% used` : "";
    foot.textContent = `${renderer?.kind ?? "…"}${kitchenText ? " · " + kitchenText : ""}`;
  };

  const onData = (d) => {
    total = d.total || 0;
    used = d.used || 0;
    st.target = total ? used / total : 0;
    const k = d.kitchen;
    kitchenText = k?.installed
      ? "kitchen " + (k.priority || []).filter((b) => k.backends?.[b]).join(" › ")
      : k ? "kitchen n/a" : "";
    paint();
  };

  function showResult(r) {
    if (!r) return;
    total = r.total || total;
    used = total - (r.free_after || 0);
    st.target = total ? used / total : 0;
    st.rippleStart = performance.now();
    subText = `freed ${fmtGB(r.freed || 0)} GB · ${r.ms} ms` + (r.notes?.length ? ` · ${r.notes.join(", ")}` : "");
    subUntil = performance.now() + 6000;
    paint();
    kick();
  }

  const mountCanvas = () => {
    const c = document.createElement("canvas");
    c.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;";
    root.insertBefore(c, root.firstChild);
    return c;
  };

  const fit = () => {
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round(root.clientWidth * dpr));
    canvas.height = Math.max(1, Math.round(root.clientHeight * dpr));
  };

  const frame = (t) => {
    raf = 0;
    if (removed || !visible || !renderer) return;
    raf = requestAnimationFrame(frame);
    if (t - last < 33) return; // ~30 fps cap: the visual should cost almost nothing
    const dt = (t - last) / 1000;
    last = t;
    st.time = t / 1000;
    st.used += (st.target - st.used) * Math.min(1, dt * 6);
    if (st.rippleStart) {
      const p = (t - st.rippleStart) / 1400;
      st.ripple = p >= 1 ? -1 : p;
      if (p >= 1) st.rippleStart = 0;
    }
    renderer.draw(st);
  };
  const kick = () => { if (!raf && visible && renderer && !removed) raf = requestAnimationFrame(frame); };

  const useCanvas2D = () => {
    renderer?.destroy();
    canvas?.remove();
    canvas = mountCanvas();
    renderer = make2DRenderer(canvas);
    fit(); paint(); kick();
  };

  (async () => {
    canvas = mountCanvas();
    try {
      renderer = await makeGPURenderer(canvas);
      renderer.lost.then(() => { if (!removed) useCanvas2D(); });
      fit(); paint(); kick();
    } catch (err) {
      console.info("[Nougan] WebGPU unavailable, using Canvas2D:", err.message);
      useCanvas2D();
    }
  })();

  // Only animate and poll while the node is actually on screen.
  let unsubscribe = null;
  const io = new IntersectionObserver((entries) => {
    visible = entries.some((e) => e.isIntersecting);
    if (visible) {
      if (!unsubscribe) unsubscribe = subscribe(onData);
      kick();
    } else if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
  });
  io.observe(root);

  const ro = new ResizeObserver(() => { fit(); renderer?.draw(st); });
  ro.observe(root);

  // Result of a graph run: the Python node sends its stats as ui.nougan_vram.
  const prevExecuted = node.onExecuted;
  node.onExecuted = function (msg) {
    if (prevExecuted) prevExecuted.apply(this, arguments);
    showResult(msg?.nougan_vram?.[0]);
  };

  const prevRemoved = node.onRemoved;
  node.onRemoved = function () {
    removed = true;
    if (raf) cancelAnimationFrame(raf);
    io.disconnect();
    ro.disconnect();
    if (unsubscribe) unsubscribe();
    renderer?.destroy();
    if (prevRemoved) prevRemoved.apply(this, arguments);
  };

  node.setSize([Math.max(node.size[0], 300), Math.max(node.size[1], 400)]);
}

app.registerExtension({
  name: "Nougan.RefreshPage",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== NODE_NAME) return;

    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onCreated ? onCreated.apply(this, arguments) : undefined;
      setupNode(this);
      return r;
    };
  },
});
