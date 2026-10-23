// Nougan Resolution Picker: animated ratio / megapixel preview and mode-aware widgets.
// The size math mirrors resolution_picker.py (Python is what actually produces the outputs).
import { app } from "../../scripts/app.js";

const NODE_NAME = "NouganResolutionPicker";
const MODE_RATIO = "Ratio + Megapixels";
const PIXELS_PER_MP = 1024 * 1024;
const REF_SIDE = 1024; // the dashed "1 MP" reference square
const RATIO_RE = /^\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)/;
const PRESET_RE = /^\s*(\d+)\s*x\s*(\d+)/i;
const RATIO_WEIGHT = 20; // keep in step with resolution_picker.py
const RATIO_NOTE_MIN = 0.0005;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const snap = (value, multiple) => Math.max(multiple, Math.floor(value / multiple + 0.5) * multiple);
const fmt = (n) => String(+Number(n).toFixed(2));

export function computeResolution(v, ratioLabels) {
  const multiple = Math.max(1, Math.floor(Number(v.multiple) || 1));
  let w;
  let h;
  let ratio;
  let drift = 0; // how far the final ratio is from the wanted one (Ratio mode only)
  if (v.mode === MODE_RATIO) {
    let rw = 1;
    let rh = 1;
    if (v.aspect_ratio === "Custom") {
      rw = clamp(Number(v.custom_ratio_w) || 1, 0.1, 100);
      rh = clamp(Number(v.custom_ratio_h) || 1, 0.1, 100);
      ratio = `${fmt(rw)}:${fmt(rh)}`;
    } else {
      const m = RATIO_RE.exec(v.aspect_ratio || "");
      if (m) {
        rw = Number(m[1]);
        rh = Number(m[2]);
        ratio = `${m[1]}:${m[2]}`;
      } else {
        ratio = "1:1";
      }
    }
    const pixels = clamp(Number(v.megapixels) || 1, 0.05, 16) * PIXELS_PER_MP;
    [w, h] = fitRatio(rw, rh, pixels, multiple);
    drift = ratioError(w, h, rw, rh);
  } else {
    const m = PRESET_RE.exec(v.preset_resolution || "");
    w = m ? Number(m[1]) : 1024;
    h = m ? Number(m[2]) : 1024;
    if (v.snap_presets) {
      w = snap(w, multiple);
      h = snap(h, multiple);
    }
    ratio = nearestRatio(w, h, ratioLabels);
  }
  if (v.swap_orientation) {
    [w, h] = [h, w];
    ratio = ratio.split(":").reverse().join(":");
  }
  const note = drift > RATIO_NOTE_MIN ? `actual ${(Math.floor((w / h) * 1000 + 0.5) / 1000).toFixed(3)}` : "";
  return { w, h, ratio, note };
}

// Symmetric: being 10% too wide scores the same as being 10% too tall.
const ratioError = (w, h, rw, rh) => {
  const a = w * rh;
  const b = h * rw;
  return Math.abs(a - b) / ((a + b) / 2);
};

// The same search as _fit_ratio in resolution_picker.py (Python produces the real outputs).
function fitRatio(rw, rh, pixels, multiple) {
  if (rh > rw) {
    // search landscape only, so a ratio and its mirror always give mirrored sizes
    const [h, w] = fitRatio(rh, rw, pixels, multiple);
    return [w, h];
  }
  const scale = Math.sqrt(pixels / (rw * rh));
  const idealW = rw * scale;
  // plain per-side rounding is always a candidate, so the result is never worse than it
  const candidates = [[snap(rw * scale, multiple), snap(rh * scale, multiple)]];
  const first = Math.max(1, Math.floor((idealW * 0.7) / multiple));
  const last = Math.ceil((idealW * 1.3) / multiple) + 1;
  for (let k = first; k <= last; k++) {
    const w = k * multiple;
    const rows = Math.floor((w * rh) / rw / multiple);
    for (const r of [rows, rows + 1]) candidates.push([w, Math.max(1, r) * multiple]);
  }
  let best = null;
  let bestCost = 0;
  for (const [w, h] of candidates) {
    const cost = RATIO_WEIGHT * ratioError(w, h, rw, rh) + Math.abs((w * h) / pixels - 1);
    if (!best || cost < bestCost || (cost === bestCost && w < best[0])) {
      best = [w, h];
      bestCost = cost;
    }
  }
  return best;
}

function nearestRatio(w, h, labels) {
  const actual = Math.log(w / h);
  let best = null;
  let bestGap = 0.02;
  for (const label of labels || []) {
    const m = RATIO_RE.exec(label);
    if (!m) continue;
    const gap = Math.abs(actual - Math.log(Number(m[1]) / Number(m[2])));
    if (gap < bestGap) {
      bestGap = gap;
      best = `${m[1]}:${m[2]}`;
    }
  }
  return best || `${(w / h).toFixed(2)}:1`;
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
  const mp = (s.w * s.h) / PIXELS_PER_MP;
  // Colour follows megapixels on a log scale: blue (small) to pink (large).
  const hue = 200 + clamp(Math.log2(Math.max(mp, 0.0625) * 4) / 6, 0, 1) * 130;
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

  // Layout: header strip, footer strip, and a main area with room for dimension labels.
  const area = { x: 34, y: 28, w: Math.max(40, cw - 50), h: Math.max(40, ch - 68) };
  const k = Math.min(area.w / Math.max(s.w, REF_SIDE), area.h / Math.max(s.h, REF_SIDE));
  const rw = s.w * k;
  const rh = s.h * k;
  const cx = area.x + area.w / 2;
  const cy = area.y + area.h / 2;
  const rx = cx - rw / 2;
  const ry = cy - rh / 2;

  // Dashed 1 MP reference square, so the megapixel size reads at a glance.
  const side = REF_SIDE * k;
  ctx.save();
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = "rgba(255,255,255,0.22)";
  ctx.lineWidth = 1;
  ctx.strokeRect(cx - side / 2, cy - side / 2, side, side);
  ctx.restore();
  ctx.fillStyle = "rgba(255,255,255,0.35)";
  ctx.font = "600 9px ui-sans-serif, system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText("1 MP", cx - side / 2 + 4, cy - side / 2 + 3);

  // Frame fill and rule-of-thirds lines.
  const fill = ctx.createLinearGradient(rx, ry, rx + rw, ry + rh);
  fill.addColorStop(0, tone(55, 0.38));
  fill.addColorStop(1, tone(35, 0.12));
  ctx.fillStyle = fill;
  ctx.fillRect(rx, ry, rw, rh);
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 1; i <= 2; i++) {
    ctx.moveTo(rx + (rw * i) / 3, ry);
    ctx.lineTo(rx + (rw * i) / 3, ry + rh);
    ctx.moveTo(rx, ry + (rh * i) / 3);
    ctx.lineTo(rx + rw, ry + (rh * i) / 3);
  }
  ctx.stroke();

  // Pulse ring when the size changes.
  if (s.pulse > 0.02) {
    const grow = (1 - s.pulse) * 16;
    ctx.strokeStyle = tone(70, s.pulse * 0.6);
    ctx.lineWidth = 1.5;
    ctx.strokeRect(rx - grow, ry - grow, rw + grow * 2, rh + grow * 2);
  }

  // Glowing frame edge.
  ctx.save();
  ctx.shadowColor = tone(60, 0.9);
  ctx.shadowBlur = 10 + s.pulse * 18;
  ctx.strokeStyle = tone(72, 0.95);
  ctx.lineWidth = 1.6;
  ctx.strokeRect(rx, ry, rw, rh);
  ctx.restore();

  // Corner ticks.
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

  // Ratio text inside the frame.
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.font = `700 ${clamp(Math.min(rw, rh) * 0.3, 11, 28)}px ui-sans-serif, system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(s.ratio, cx, cy);
  // When the grid cannot hit the ratio exactly, say how far off the real size is.
  if (s.note && rh > 70) {
    ctx.font = "600 10px ui-sans-serif, system-ui, sans-serif";
    ctx.fillStyle = "rgba(255,200,100,0.95)";
    ctx.fillText(s.note, cx, cy + clamp(Math.min(rw, rh) * 0.3, 11, 28) * 0.8 + 4);
  }

  // Dimension lines: width under the frame, height on its left.
  const dw = Math.round(s.w);
  const dh = Math.round(s.h);
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

  // Header and footer.
  const orient = Math.abs(s.tw - s.th) < 1 ? "SQUARE" : s.tw > s.th ? "LANDSCAPE" : "PORTRAIT";
  ctx.font = "700 10px ui-sans-serif, system-ui, sans-serif";
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillStyle = tone(70, 1);
  ctx.beginPath();
  ctx.arc(14, 14, 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.65)";
  ctx.fillText(orient, 24, 14);
  ctx.textAlign = "right";
  ctx.fillStyle = tone(75, 1);
  ctx.fillText(`${mp.toFixed(2)} MP`, cw - 12, 14);
  ctx.textAlign = "center";
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  ctx.font = "700 12px ui-sans-serif, system-ui, sans-serif";
  ctx.fillText(`${dw} \u00d7 ${dh} px`, cw / 2, ch - 12);

  ctx.restore();
}

// ---------------------------------------------------------------- node glue

// Which widgets show depends on mode and aspect_ratio. That is derived state: it is reconciled
// against the real widgets on every sync, never cached, so nothing that resets a widget behind our
// back (workflow reload, undo, node refresh) can leave the ratio / megapixel widgets stuck hidden.
const FALLBACK_TYPE = {
  aspect_ratio: "combo",
  preset_resolution: "combo",
  megapixels: "number",
  custom_ratio_w: "number",
  custom_ratio_h: "number",
  snap_presets: "toggle",
};

function desiredHidden(v) {
  const ratioMode = v.mode === MODE_RATIO;
  const custom = ratioMode && v.aspect_ratio === "Custom";
  return {
    aspect_ratio: !ratioMode,
    custom_ratio_w: !custom,
    custom_ratio_h: !custom,
    megapixels: !ratioMode,
    preset_resolution: ratioMode,
    snap_presets: ratioMode,
  };
}

// Returns true when it had to change the widget.
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
  else delete widget.computeSize; // fall back to the widget class's own sizing
  return true;
}

function setupNode(node) {
  const byName = (name) => node.widgets?.find((w) => w.name === name);
  const readValues = () => {
    const values = {};
    for (const w of node.widgets || []) if (w.name !== "ratio_preview") values[w.name] = w.value;
    return values;
  };
  const ratioLabels = () => byName("aspect_ratio")?.options?.values ?? [];

  const wrap = document.createElement("div");
  wrap.style.cssText = "width:100%;height:100%;position:relative;overflow:hidden;";
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "width:100%;height:100%;display:block;";
  wrap.appendChild(canvas);
  const ctx = canvas.getContext("2d");

  const preview = node.addDOMWidget("ratio_preview", "ratio_preview", wrap, {
    serialize: false,
    hideOnZoom: false,
    getMinHeight: () => 190,
  });
  preview.computeSize = (width) => [width, 200];

  const s = { w: 0, h: 0, tw: 0, th: 0, ratio: "", note: "", pulse: 0, raf: 0, ready: false, sig: "" };
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
  const step = () => {
    s.raf = 0;
    s.w += (s.tw - s.w) * 0.2;
    s.h += (s.th - s.h) * 0.2;
    s.pulse *= 0.9;
    if (Math.abs(s.tw - s.w) < 0.4 && Math.abs(s.th - s.h) < 0.4) {
      s.w = s.tw;
      s.h = s.th;
    }
    render();
    if (s.w !== s.tw || s.h !== s.th || s.pulse > 0.02) s.raf = requestAnimationFrame(step);
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
    applyLayout(values); // every call, even when no value changed: see desiredHidden()
    const sig = JSON.stringify(values);
    if (sig === s.sig && !immediate) return;
    s.sig = sig;
    const r = computeResolution(values, ratioLabels());
    s.tw = r.w;
    s.th = r.h;
    s.ratio = r.ratio;
    s.note = r.note;
    if (immediate || !s.ready) {
      s.w = r.w;
      s.h = r.h;
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
  // Catches changes that do not fire a widget callback, for example a linked input.
  const onDrawForeground = node.onDrawForeground;
  node.onDrawForeground = function () {
    if (onDrawForeground) onDrawForeground.apply(this, arguments);
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
  name: "Nougan.ResolutionPicker",
  async nodeCreated(node) {
    if ((node.comfyClass || node.constructor?.comfyClass) !== NODE_NAME) return;
    setupNode(node);
  },
});
