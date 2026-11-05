// Nougan H3 Upscale Picker: animated source -> target preview and mode-aware widgets.
// The size math mirrors nougan_h3_upscale_picker.py (Python is what actually produces the outputs).
// The source size comes from the wired Nougan Resolution Picker when it can be read (also when this node sits inside a
// subgraph and the picker is wired to the subgraph node's inputs); after a run, the exact size the run used is
// remembered and shown instead of the estimate.
import { app } from "../../scripts/app.js";

let pickerModule = null;
import("./nougan_resolution_picker.js").then((m) => { pickerModule = m; }).catch(() => {});

const NODE_NAME = "NouganH3UpscalePicker";
const PICKER_NAME = "NouganResolutionPicker";
const MODE_SCALE = "Scale factor";
const PIXELS_PER_MP = 1024 * 1024;
const MIN_SCALE = 1.0;
const MAX_SCALE = 4.0;
const LATENT_STEP = 16;
const AXIS_WEIGHT = 20; // keep in step with nougan_h3_upscale_picker.py
const SCALE_RE = /^\s*(\d+(?:\.\d+)?)\s*[x\u00d7]/i;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const snap = (value, multiple) => Math.max(multiple, Math.floor(value / multiple + 0.5) * multiple);

// ---------------------------------------------------------------- size math (mirrors the Python)

function parseScale(label) {
  const m = SCALE_RE.exec(label || "");
  return m ? Number(m[1]) : 2.0;
}

function fitScale(w, h, scale, multiple) {
  const candidates = [[snap(w * scale, multiple), snap(h * scale, multiple)]];
  const first = Math.max(1, Math.floor((w * scale * 0.8) / multiple));
  const last = Math.ceil((w * scale * 1.2) / multiple) + 1;
  for (let k = first; k <= last; k++) {
    const cw = k * multiple;
    const rows = Math.floor((cw * h) / w / multiple);
    for (const r of [rows, rows + 1]) candidates.push([cw, Math.max(1, r) * multiple]);
  }
  let best = null;
  let bestCost = 0;
  for (const [cw, ch] of candidates) {
    const sw = cw / w;
    const sh = ch / h;
    if (sw < 1 - 1e-9 || sh < 1 - 1e-9) continue;
    const eff = (sw + sh) / 2;
    if (eff > MAX_SCALE + 1e-9) continue;
    const cost = AXIS_WEIGHT * (Math.abs(sw - sh) / eff) + Math.abs(eff / scale - 1);
    if (!best || cost < bestCost || (cost === bestCost && cw < best[0])) {
      best = [cw, ch];
      bestCost = cost;
    }
  }
  if (!best) best = [Math.ceil((w * scale) / multiple) * multiple, Math.ceil((h * scale) / multiple) * multiple];
  return best;
}

export function computeUpscale(v, width, height) {
  const w = Math.max(1, Math.floor(Number(width) || 1));
  const h = Math.max(1, Math.floor(Number(height) || 1));
  const m = Math.max(LATENT_STEP, Math.floor((Math.floor(Number(v.multiple) || LATENT_STEP) + LATENT_STEP - 1) / LATENT_STEP) * LATENT_STEP);
  let note = "";
  let scale;
  if (v.mode === MODE_SCALE) {
    scale = v.scale === "Custom" ? Number(v.custom_scale) : parseScale(v.scale);
  } else {
    const pixels = Math.min(16, Math.max(0.05, Number(v.target_megapixels))) * PIXELS_PER_MP;
    scale = Math.sqrt(pixels / (w * h));
  }
  if (scale < MIN_SCALE) {
    scale = MIN_SCALE;
    if (v.mode !== MODE_SCALE) note = "no upscale (target <= source)";
  } else if (scale > MAX_SCALE) {
    scale = MAX_SCALE;
    note = "capped at 4x (max)";
  }
  const [tw, th] = fitScale(w, h, scale, m);
  const sw = tw / w;
  const sh = th / h;
  const eff = (sw + sh) / 2;
  return { w, h, tw, th, sw, sh, scale: eff, mismatch: Math.abs(sw - sh) / eff, note };
}

// ---------------------------------------------------------------- drawing

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawPreview(ctx, cw, ch, s) {
  const mpOut = (s.tw * s.th) / PIXELS_PER_MP;
  const mpIn = (s.w * s.h) / PIXELS_PER_MP;
  // Same colour rule as the Resolution Picker: blue (small) to pink (large), by target megapixels.
  const hue = 200 + clamp(Math.log2(Math.max(mpOut, 0.0625) * 4) / 6, 0, 1) * 130;
  const tone = (light, alpha) => `hsla(${hue}, 90%, ${light}%, ${alpha})`;

  ctx.clearRect(0, 0, cw, ch);
  ctx.save();
  roundRect(ctx, 0.5, 0.5, cw - 1, ch - 1, 10);
  const bg = ctx.createLinearGradient(0, 0, 0, ch);
  bg.addColorStop(0, "#171a22");
  bg.addColorStop(1, "#0c0e13");
  ctx.fillStyle = bg;
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.clip();

  ctx.fillStyle = "rgba(255,255,255,0.05)";
  for (let x = 14; x < cw; x += 14) {
    for (let y = 14; y < ch; y += 14) ctx.fillRect(x, y, 1, 1);
  }

  const area = { x: 34, y: 28, w: Math.max(40, cw - 50), h: Math.max(40, ch - 68) };
  const k = Math.min(area.w / Math.max(s.tw, 1), area.h / Math.max(s.th, 1));
  const rw = s.tw * k;
  const rh = s.th * k;
  const cx = area.x + area.w / 2;
  const cy = area.y + area.h / 2;
  const rx = cx - rw / 2;
  const ry = cy - rh / 2;
  const iw = s.w * k;
  const ih = s.h * k;
  const ix = cx - iw / 2;
  const iy = cy - ih / 2;

  // Target frame.
  const fill = ctx.createLinearGradient(rx, ry, rx + rw, ry + rh);
  fill.addColorStop(0, tone(55, 0.3));
  fill.addColorStop(1, tone(35, 0.08));
  ctx.fillStyle = fill;
  ctx.fillRect(rx, ry, rw, rh);
  if (s.pulse > 0.02) {
    const grow = (1 - s.pulse) * 16;
    ctx.strokeStyle = tone(70, s.pulse * 0.6);
    ctx.lineWidth = 1.5;
    ctx.strokeRect(rx - grow, ry - grow, rw + grow * 2, rh + grow * 2);
  }
  ctx.save();
  ctx.shadowColor = tone(60, 0.9);
  ctx.shadowBlur = 10 + s.pulse * 18;
  ctx.strokeStyle = tone(72, 0.95);
  ctx.lineWidth = 1.6;
  ctx.strokeRect(rx, ry, rw, rh);
  ctx.restore();

  // Source frame, nested at the same centre so the scale reads at a glance.
  ctx.fillStyle = "rgba(255,255,255,0.10)";
  ctx.fillRect(ix, iy, iw, ih);
  ctx.save();
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = "rgba(255,255,255,0.55)";
  ctx.lineWidth = 1;
  ctx.strokeRect(ix, iy, iw, ih);
  ctx.restore();
  if (iw > 64 && ih > 22) {
    ctx.fillStyle = "rgba(255,255,255,0.75)";
    ctx.font = "600 10px ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(`${Math.round(s.w)} \u00d7 ${Math.round(s.h)}`, cx, cy);
  }

  // Corner ticks on the target.
  const tick = clamp(Math.min(rw, rh) * 0.14, 4, 12);
  ctx.strokeStyle = "rgba(255,255,255,0.8)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (const [x, y, dx, dy] of [
    [rx, ry, 1, 1],
    [rx + rw, ry, -1, 1],
    [rx, ry + rh, 1, -1],
    [rx + rw, ry + rh, -1, -1],
  ]) {
    ctx.moveTo(x + dx * tick, y);
    ctx.lineTo(x, y);
    ctx.lineTo(x, y + dy * tick);
  }
  ctx.stroke();

  // Target dimension lines: width under the frame, height on its left.
  const dw = Math.round(s.tw);
  const dh = Math.round(s.th);
  ctx.strokeStyle = "rgba(255,255,255,0.4)";
  ctx.fillStyle = "rgba(255,255,255,0.7)";
  ctx.lineWidth = 1;
  ctx.font = "600 10px ui-sans-serif, system-ui, sans-serif";
  ctx.beginPath();
  ctx.moveTo(rx, ry + rh + 7);
  ctx.lineTo(rx + rw, ry + rh + 7);
  ctx.moveTo(rx, ry + rh + 4);
  ctx.lineTo(rx, ry + rh + 10);
  ctx.moveTo(rx + rw, ry + rh + 4);
  ctx.lineTo(rx + rw, ry + rh + 10);
  ctx.moveTo(rx - 7, ry);
  ctx.lineTo(rx - 7, ry + rh);
  ctx.moveTo(rx - 10, ry);
  ctx.lineTo(rx - 4, ry);
  ctx.moveTo(rx - 10, ry + rh);
  ctx.lineTo(rx - 4, ry + rh);
  ctx.stroke();
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillText(String(dw), cx, ry + rh + 12);
  ctx.save();
  ctx.translate(rx - 12, cy);
  ctx.rotate(-Math.PI / 2);
  ctx.textBaseline = "bottom";
  ctx.fillText(String(dh), 0, 0);
  ctx.restore();

  // Header: scale on the left, megapixels on the right, fit status in the middle.
  ctx.font = "700 10px ui-sans-serif, system-ui, sans-serif";
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillStyle = tone(70, 1);
  ctx.beginPath();
  ctx.arc(14, 14, 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.fillText(`UPSCALE ${s.scale.toFixed(2)}\u00d7`, 24, 14);
  ctx.textAlign = "right";
  ctx.fillStyle = tone(75, 1);
  ctx.fillText(`${mpIn.toFixed(2)} \u2192 ${mpOut.toFixed(2)} MP`, cw - 12, 14);
  let status = "EXACT";
  let statusColor = "rgba(120,230,150,0.95)";
  if (s.note) {
    status = s.note.toUpperCase();
    statusColor = "rgba(255,120,120,0.95)";
  } else if (s.mismatch >= 1e-6) {
    status = `UNEVEN ${(s.mismatch * 100).toFixed(1)}%`;
    statusColor = "rgba(255,200,100,0.95)";
  }
  if (cw > 300 || !s.note) {
    ctx.textAlign = "center";
    ctx.fillStyle = statusColor;
    ctx.font = "700 9px ui-sans-serif, system-ui, sans-serif";
    ctx.fillText(status.length > 34 ? status.slice(0, 33) + "\u2026" : status, cw / 2, 14);
  }

  // Footer.
  ctx.textAlign = "center";
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  ctx.font = "700 12px ui-sans-serif, system-ui, sans-serif";
  ctx.fillText(`${Math.round(s.w)} \u00d7 ${Math.round(s.h)}  \u2192  ${dw} \u00d7 ${dh} px`, cw / 2, ch - 12);

  ctx.restore();
}

// ---------------------------------------------------------------- node glue

const FALLBACK_TYPE = { scale: "combo", custom_scale: "number", target_megapixels: "number" };

function desiredHidden(v) {
  const scaleMode = v.mode === MODE_SCALE;
  return {
    scale: !scaleMode,
    custom_scale: !(scaleMode && v.scale === "Custom"),
    target_megapixels: scaleMode,
  };
}

// Returns true when it had to change the widget. Reconciled on every sync, like the Resolution Picker.
function setHidden(widget, hidden) {
  if (!widget) return false;
  if (!widget.__nougan) {
    widget.__nougan = {
      type: widget.type === "hidden" ? FALLBACK_TYPE[widget.name] : widget.type,
      ownSize: Object.prototype.hasOwnProperty.call(widget, "computeSize"),
      computeSize: widget.computeSize,
      stub: () => [0, -4],
    };
  }
  const st = widget.__nougan;
  const wantType = hidden ? "hidden" : st.type;
  if (!!widget.hidden === hidden && widget.type === wantType && (!hidden || widget.computeSize === st.stub)) {
    return false;
  }
  widget.hidden = hidden;
  widget.type = wantType;
  if (hidden) widget.computeSize = st.stub;
  else if (st.ownSize) widget.computeSize = st.computeSize;
  else delete widget.computeSize;
  return true;
}

// A subgraph's own input pins are not nodes: links from them carry this origin id.
const SUBGRAPH_INPUT_ID = -10;
const hostCache = new WeakMap();

// The node (in the parent graph) that holds subgraph `g`. Found by walking down from the root graph.
function findSubgraphHost(g) {
  const cached = hostCache.get(g);
  if (cached && cached.subgraph === g && cached.graph) return cached;
  const roots = [g.rootGraph, app.rootGraph, app.graph?.rootGraph, app.graph].filter(Boolean);
  const seen = new Set();
  const visit = (graph, depth) => {
    if (!graph || seen.has(graph) || depth > 8) return null;
    seen.add(graph);
    for (const n of graph._nodes || graph.nodes || []) {
      if (n.subgraph === g) return n;
      const hit = n.subgraph ? visit(n.subgraph, depth + 1) : null;
      if (hit) return hit;
    }
    return null;
  };
  for (const root of roots) {
    const host = visit(root, 0);
    if (host) {
      hostCache.set(g, host);
      return host;
    }
  }
  return null;
}

// The real node feeding `inputName`, however many hops away: through Reroutes, and out through subgraph input
// pins to whatever feeds the subgraph node one level up. Returns { node, slot } or null.
function linkedOrigin(node, inputName, depth = 0) {
  if (!node || depth > 12) return null;
  const inp = node.inputs?.find((i) => i.name === inputName);
  if (inp?.link == null) return null;
  const g = node.graph || app.graph;
  const link = g.links?.[inp.link] ?? g.links?.get?.(inp.link);
  if (!link) return null;

  if (link.origin_id === SUBGRAPH_INPUT_ID) {
    // fed by the subgraph's own input: continue from the matching input of the subgraph node
    let pin = g.inputs?.[link.origin_slot];
    if (!pin) pin = g.inputs?.find((x) => x.linkIds?.includes(inp.link));
    const host = pin ? findSubgraphHost(g) : null;
    return host ? linkedOrigin(host, pin.name, depth + 1) : null;
  }

  const origin = g.getNodeById(link.origin_id);
  if (!origin) return null;
  if ((origin.comfyClass || origin.type) === "Reroute") {
    const through = linkedOrigin(origin, origin.inputs?.[0]?.name, depth + 1);
    return through || null;
  }
  return { node: origin, slot: link.origin_slot };
}

function widgetValues(n) {
  const v = {};
  for (const w of n.widgets || []) v[w.name] = w.value;
  return v;
}

function setupNode(node) {
  const byName = (name) => node.widgets?.find((w) => w.name === name);
  const readValues = () => {
    const values = {};
    for (const w of node.widgets || []) if (w.name !== "size_preview") values[w.name] = w.value;
    return values;
  };

  // The source size: an upstream Resolution Picker is read directly; anything else linked falls back to the size
  // the last run used; an unlinked axis uses this node's own widget.
  const upstreamSig = () => {
    const parts = [];
    for (const name of ["width", "height"]) {
      const o = linkedOrigin(node, name);
      parts.push(o ? `${o.node.id}:${o.slot}:${JSON.stringify(widgetValues(o.node))}` : "-");
    }
    return parts.join("|");
  };
  const fromPicker = (o) => {
    if (!o || !pickerModule || (o.node.comfyClass || o.node.type) !== PICKER_NAME) return null;
    const labels = o.node.widgets?.find((x) => x.name === "aspect_ratio")?.options?.values ?? [];
    const r = pickerModule.computeResolution(widgetValues(o.node), labels);
    return o.slot === 0 ? r.w : o.slot === 1 ? r.h : null;
  };
  const sourceSize = (values) => {
    const wo = linkedOrigin(node, "width");
    const ho = linkedOrigin(node, "height");
    if ((wo || ho) && s.last && s.lastSig === upstreamSig()) return { w: s.last.sw, h: s.last.sh };
    const w = fromPicker(wo);
    const h = fromPicker(ho);
    return { w: w ?? Number(values.width), h: h ?? Number(values.height) };
  };

  const wrap = document.createElement("div");
  wrap.style.cssText = "width:100%;height:100%;position:relative;overflow:hidden;";
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "width:100%;height:100%;display:block;";
  wrap.appendChild(canvas);
  const ctx = canvas.getContext("2d");

  const preview = node.addDOMWidget("size_preview", "size_preview", wrap, {
    serialize: false,
    hideOnZoom: false,
    getMinHeight: () => 190,
  });
  preview.computeSize = (width) => [width, 200];

  // w/h/tw/th are the drawn (tweened) numbers; goal* are where they are heading.
  const s = {
    w: 0, h: 0, tw: 0, th: 0, goalW: 0, goalH: 0, goalTw: 0, goalTh: 0,
    scale: 1, mismatch: 0, note: "", pulse: 0, raf: 0, ready: false, sig: "", last: null, lastSig: "",
  };
  let cw = 0;
  let ch = 0;

  const fit = () => {
    const dpr = window.devicePixelRatio || 1;
    cw = wrap.clientWidth;
    ch = wrap.clientHeight;
    if (!cw || !ch) return;
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  const render = () => {
    if (cw && ch) drawPreview(ctx, cw, ch, s);
  };
  const settled = () => s.w === s.goalW && s.h === s.goalH && s.tw === s.goalTw && s.th === s.goalTh;
  const step = () => {
    s.raf = 0;
    for (const [cur, goal] of [["w", "goalW"], ["h", "goalH"], ["tw", "goalTw"], ["th", "goalTh"]]) {
      s[cur] += (s[goal] - s[cur]) * 0.2;
      if (Math.abs(s[goal] - s[cur]) < 0.4) s[cur] = s[goal];
    }
    s.pulse *= 0.9;
    render();
    if (!settled() || s.pulse > 0.02) s.raf = requestAnimationFrame(step);
  };
  const kick = () => {
    if (!s.raf) s.raf = requestAnimationFrame(step);
  };

  const applyLayout = (v) => {
    let changed = false;
    for (const [name, hide] of Object.entries(desiredHidden(v))) {
      changed = setHidden(byName(name), hide) || changed;
    }
    if (!changed) return;
    node.setSize([node.size[0], node.computeSize()[1]]);
    app.graph?.setDirtyCanvas(true, true);
  };

  const sync = (immediate) => {
    const values = readValues();
    applyLayout(values); // every call, even when nothing changed: see the Resolution Picker's desiredHidden()
    const src = sourceSize(values);
    const sig = JSON.stringify([values, src]);
    if (sig === s.sig && !immediate) return;
    s.sig = sig;
    const r = computeUpscale(values, src.w, src.h);
    s.goalW = r.w;
    s.goalH = r.h;
    s.goalTw = r.tw;
    s.goalTh = r.th;
    s.scale = r.scale;
    s.mismatch = r.mismatch;
    s.note = r.note;
    if (immediate || !s.ready) {
      s.w = r.w;
      s.h = r.h;
      s.tw = r.tw;
      s.th = r.th;
      s.ready = true;
      render();
    } else {
      s.pulse = 1;
      kick();
    }
  };

  for (const w of node.widgets) {
    if (w === preview) continue;
    const original = w.callback;
    w.callback = function () {
      const result = original ? original.apply(this, arguments) : undefined;
      sync(false);
      return result;
    };
  }

  const onConfigure = node.onConfigure;
  node.onConfigure = function () {
    const result = onConfigure ? onConfigure.apply(this, arguments) : undefined;
    sync(true);
    return result;
  };
  // Catches changes that fire no widget callback: a re-wired link, or the picker upstream being edited.
  const onDrawForeground = node.onDrawForeground;
  node.onDrawForeground = function () {
    if (onDrawForeground) onDrawForeground.apply(this, arguments);
    sync(false);
  };
  // After a run, remember the exact source size Python used, so the preview matches the outputs.
  const onExecuted = node.onExecuted;
  node.onExecuted = function (output) {
    if (onExecuted) onExecuted.apply(this, arguments);
    const d = output?.nougan_upscale?.[0];
    if (!d) return;
    s.last = d;
    s.lastSig = upstreamSig();
    sync(false);
  };

  const observer = new ResizeObserver(() => {
    fit();
    render();
  });
  observer.observe(wrap);
  const onRemoved = node.onRemoved;
  node.onRemoved = function () {
    observer.disconnect();
    if (s.raf) cancelAnimationFrame(s.raf);
    if (onRemoved) onRemoved.apply(this, arguments);
  };

  node.setSize([Math.max(node.size[0], 340), node.size[1]]);
  sync(true);
}

app.registerExtension({
  name: "Nougan.H3UpscalePicker",
  async nodeCreated(node) {
    if ((node.comfyClass || node.constructor?.comfyClass) !== NODE_NAME) return;
    setupNode(node);
  },
});
