// nougan-regional_lora.js — Nougan Regional Character LoRA · in-node region editor
// (DOM + canvas). Two semantic regions: A = lora_a, B = lora_b. The canvas widget
// IS the "regions" input — it carries the normalized-coords JSON the Python node
// reads, so there is no separate text widget to leak. Active when split_mode is
// "manual" (or when the node has no split_mode widget at all).
//
// Serialized schema (UNCHANGED — the backend reads this verbatim):
//   [ { char:"a", x, y, w, h }, { char:"b", x, y, w, h } ]   // all values 0..1
//
// The DOM control layer (clean-tilt presets, live coverage readout, overlap/gap
// warnings) is frontend-only state and never touches the widget, so the backend
// is unaffected. It exists to prevent the region-shape mistakes that cause
// character bleed: overlapping boxes (conflicting conditioning) and uncovered
// gaps (no regional guidance) are now visible and one-click fixable.
import { app } from "../../scripts/app.js";

const NODE_NAMES = [
  "NouganRegionalCharacterLoRA",
  "Krea2RegionalCharacterLoRA", // legacy / upstream names — harmless if absent
  "RegionalCharacterLora",
];
const COL_A = "#4ea1ff";
const COL_B = "#ff4d8d";
const HANDLE = 13;
const GUIDES = [0, 0.25, 0.333333, 0.5, 0.666667, 0.75, 1];
const SNAP_THR = 0.014;

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const defaultRegions = () => ([
  { char: "a", x: 0.0, y: 0.0, w: 0.5, h: 1.0 },
  { char: "b", x: 0.5, y: 0.0, w: 0.5, h: 1.0 },
]);
function parseRegions(v) {
  try {
    const a = JSON.parse(v);
    if (Array.isArray(a) && a.length) {
      return a.map((r) => ({
        char: r.char === "b" ? "b" : "a",
        x: +r.x || 0, y: +r.y || 0, w: +r.w || 0.5, h: +r.h || 1,
      }));
    }
  } catch (_) {}
  return defaultRegions();
}
function wval(node, name) {
  const w = node.widgets && node.widgets.find((x) => x.name === name);
  return w ? w.value : undefined;
}
function shortName(p) {
  if (!p || typeof p !== "string") return "";
  const s = p.split(/[\\/]/).pop().replace(/\.safetensors$/i, "");
  return s.length > 16 ? s.slice(0, 15) + "…" : s;
}
function snapValue(v, extra) {
  const set = GUIDES.concat(extra || []);
  let best = v, bd = SNAP_THR;
  for (const g of set) { const d = Math.abs(v - g); if (d < bd) { bd = d; best = g; } }
  return best;
}
const rectArea = (r) => Math.max(0, r.w) * Math.max(0, r.h);
function intersectArea(a, b) {
  const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return x * y;
}

let stylesInjected = false;
function injectStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const s = document.createElement("style");
  s.textContent = `
    .rcl-wrap{font:12px/1.4 ui-sans-serif,system-ui,"Segoe UI",sans-serif;color:#dce6f5;
      pointer-events:auto;display:flex;flex-direction:column;gap:7px;
      background:linear-gradient(160deg,#1a2332,#0c111b);border:1px solid #2a4a6b;
      border-radius:9px;padding:8px;box-shadow:inset 0 1px 0 rgba(255,255,255,.04)}
    .rcl-wrap *{box-sizing:border-box;pointer-events:auto}
    .rcl-cv{width:100%;height:210px;display:block;border-radius:7px;cursor:crosshair;
      background:#0a0e16;touch-action:none;outline:none;
      box-shadow:0 0 0 1px rgba(255,255,255,.06),0 6px 18px rgba(0,0,0,.4)}
    .rcl-cv:focus{box-shadow:0 0 0 2px rgba(78,161,255,.45),0 6px 18px rgba(0,0,0,.4)}
    .rcl-bar{display:flex;flex-wrap:wrap;gap:5px;align-items:center}
    .rcl-tile{padding:4px 9px;border-radius:6px;border:1px solid #2c3a55;
      background:rgba(255,255,255,.03);color:#9fb2c8;cursor:pointer;
      font:600 11px/1 inherit;letter-spacing:.2px;transition:all .12s;user-select:none}
    .rcl-tile:hover{border-color:#5a8abf;color:#eaf2ff;background:rgba(90,138,191,.14)}
    .rcl-tile:active{transform:translateY(1px)}
    .rcl-cov{display:flex;gap:10px;align-items:center;flex-wrap:wrap;
      font:600 10px/1 ui-monospace,"SF Mono",Menlo,Consolas,monospace;color:#7f93ad}
    .rcl-cov b{color:#cdd9ea;font-weight:700}
    .rcl-cov .bad{color:#ffd23f}
    .rcl-legend{display:flex;gap:8px;align-items:center;flex-wrap:wrap;
      font:600 10px/1 ui-monospace,"SF Mono",Menlo,Consolas,monospace;letter-spacing:.3px}
    .rcl-chip{display:inline-flex;align-items:center;gap:5px;padding:3px 8px;
      border-radius:20px;border:1px solid currentColor}
    .rcl-chip .dot{width:8px;height:8px;border-radius:50%;background:currentColor;
      box-shadow:0 0 6px currentColor}
    .rcl-chip.a{color:#4ea1ff}.rcl-chip.b{color:#ff4d8d}
    .rcl-chip .nm{color:#cdd9ea;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .rcl-tip{font:500 10px/1.35 inherit;color:#5d6e87;letter-spacing:.1px;
      border-top:1px dashed #243149;padding-top:6px}
    .rcl-tip b{color:#9fb2c8}
  `;
  document.head.appendChild(s);
}

let activeEditor = null;

function buildEditor(node, initVal) {
  injectStyles();

  let regions = parseRegions(initVal);
  let store = JSON.stringify(regions);
  let sel = null, hover = null, drag = null, phase = 0, raf = 0, animating = false;

  const wrap = document.createElement("div"); wrap.className = "rcl-wrap";
  const canvas = document.createElement("canvas"); canvas.className = "rcl-cv"; canvas.tabIndex = 0;
  const cov = document.createElement("canvas");
  const vctx = canvas.getContext("2d");
  const octx = cov.getContext("2d");

  const bar = document.createElement("div"); bar.className = "rcl-bar";
  const covRow = document.createElement("div"); covRow.className = "rcl-cov";
  const legend = document.createElement("div"); legend.className = "rcl-legend";
  const tip = document.createElement("div"); tip.className = "rcl-tip";
  tip.innerHTML = "<b>Tip</b> · keep A &amp; B a clean split — <b>overlap</b> and <b>gaps</b> both make characters bleed. Hold <b>Shift</b> to snap; arrows nudge the selected box.";

  wrap.appendChild(canvas); wrap.appendChild(bar); wrap.appendChild(covRow); wrap.appendChild(legend); wrap.appendChild(tip);

  const widget = node.addDOMWidget("regions", "rcl_editor", wrap, {
    getValue() { return store; },
    setValue(v) { store = v; regions = parseRegions(v); sel = null; redraw(); },
    getHeight() { return wrap.offsetHeight || 286; },
    getMinHeight() { return wrap.offsetHeight || 286; },
    hideOnZoom: false,
  });
  widget.serializeValue = () => store;

  const isManual = () => { const sm = wval(node, "split_mode"); return sm === undefined ? true : sm === "manual"; };
  const colOf = (ch) => (ch === "b" ? COL_B : COL_A);

  function sync() { store = JSON.stringify(regions); widget.value = store; }

  const chip = (cls, nm) => `<span class="rcl-chip ${cls}"><span class="dot"></span>${cls.toUpperCase()} <span class="nm" title="${nm}">${nm}</span></span>`;
  function updateReadout() {
    const a = regions[0], b = regions[1];
    legend.innerHTML = chip("a", shortName(wval(node, "lora_a")) || "lora A") + chip("b", shortName(wval(node, "lora_b")) || "lora B");
    if (a && b) {
      const aA = rectArea(a), aB = rectArea(b), ov = intersectArea(a, b);
      const uncov = Math.max(0, 1 - (aA + aB - ov));
      const pct = (v) => (v * 100).toFixed(0) + "%";
      covRow.innerHTML =
        `A <b>${pct(aA)}</b> · B <b>${pct(aB)}</b> · ` +
        `overlap <b class="${ov > 0.002 ? "bad" : ""}">${pct(ov)}</b> · ` +
        `gap <b class="${uncov > 0.002 ? "bad" : ""}">${pct(uncov)}</b>`;
    } else covRow.textContent = "";
  }

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const cw = canvas.clientWidth || 300, chh = canvas.clientHeight || 210;
    if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(chh * dpr)) {
      canvas.width = Math.round(cw * dpr); canvas.height = Math.round(chh * dpr);
      cov.width = canvas.width; cov.height = canvas.height;
    }
    vctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const manual = isManual();

    vctx.clearRect(0, 0, cw, chh);
    vctx.fillStyle = "#0a0e16"; vctx.fillRect(0, 0, cw, chh);
    const vg = vctx.createRadialGradient(cw * 0.5, chh * 0.42, 10, cw * 0.5, chh * 0.5, cw * 0.75);
    vg.addColorStop(0, "rgba(40,58,92,.30)"); vg.addColorStop(1, "rgba(8,11,18,0)");
    vctx.fillStyle = vg; vctx.fillRect(0, 0, cw, chh);
    vctx.fillStyle = "rgba(120,140,180,.10)";
    for (let y = 16; y < chh; y += 16) for (let x = 16; x < cw; x += 16) vctx.fillRect(x, y, 1, 1);

    // coverage layer: gap tint everywhere, punched out inside boxes, overlap on top
    octx.clearRect(0, 0, cw, chh);
    if (regions.length >= 2) {
      octx.fillStyle = "rgba(127,138,163,.16)"; octx.fillRect(0, 0, cw, chh);
      octx.globalCompositeOperation = "destination-out";
      for (const r of regions) octx.fillRect(r.x * cw, r.y * chh, r.w * cw, r.h * chh);
      octx.globalCompositeOperation = "source-over";
      const a = regions[0], b = regions[1];
      const ix = Math.max(a.x, b.x), iy = Math.max(a.y, b.y);
      const iw = Math.min(a.x + a.w, b.x + b.w) - ix, ih = Math.min(a.y + a.h, b.y + b.h) - iy;
      if (iw > 0 && ih > 0) { octx.fillStyle = "rgba(255,210,63,.20)"; octx.fillRect(ix * cw, iy * chh, iw * cw, ih * chh); }
    }
    vctx.drawImage(cov, 0, 0, cw, chh);

    regions.forEach((r, i) => {
      const col = colOf(r.char);
      const x = r.x * cw, y = r.y * chh, w = r.w * cw, h = r.h * chh;
      vctx.fillStyle = col + "1f"; vctx.fillRect(x, y, w, h);
      vctx.lineWidth = sel === i ? 2.4 : 1.6; vctx.strokeStyle = col;
      if (sel === i) {
        vctx.save(); vctx.setLineDash([7, 5]); vctx.lineDashOffset = -phase;
        vctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1); vctx.restore();
      } else vctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
      vctx.fillStyle = col; vctx.fillRect(x + w - HANDLE, y + h - HANDLE, HANDLE, HANDLE);
      vctx.fillStyle = "#0a0e16"; vctx.fillRect(x + w - HANDLE + 4, y + h - HANDLE + 4, HANDLE - 7, HANDLE - 7);
      const nm = shortName(wval(node, r.char === "b" ? "lora_b" : "lora_a"));
      const txt = (r.char === "b" ? "B" : "A") + (nm ? "  " + nm : "");
      vctx.font = "600 11px ui-sans-serif,system-ui,sans-serif"; vctx.textBaseline = "top";
      const tw = vctx.measureText(txt).width + 12;
      vctx.fillStyle = col + "e6";
      vctx.beginPath();
      vctx.roundRect ? vctx.roundRect(x + 5, y + 5, tw, 18, 4) : vctx.rect(x + 5, y + 5, tw, 18);
      vctx.fill();
      vctx.fillStyle = "#08111c"; vctx.fillText(txt, x + 11, y + 8);
    });

    if (!manual) {
      vctx.fillStyle = "rgba(8,11,18,.55)"; vctx.fillRect(0, 0, cw, chh);
      vctx.fillStyle = "#cdd9ea"; vctx.font = "600 12px ui-sans-serif,system-ui,sans-serif";
      vctx.textAlign = "center"; vctx.textBaseline = "middle";
      vctx.fillText("set  split_mode = manual  to edit regions", cw / 2, chh / 2);
      vctx.textAlign = "start"; vctx.textBaseline = "alphabetic";
    }
    updateReadout();
  }
  function redraw() { draw(); }

  function ensureAnim() {
    if (animating) return; animating = true;
    const loop = (t) => { phase = (t * 0.05) % 1000; draw(); if (sel != null || drag) raf = requestAnimationFrame(loop); else { animating = false; raf = 0; } };
    raf = requestAnimationFrame(loop);
  }
  function stopAnim() { if (raf) cancelAnimationFrame(raf); raf = 0; animating = false; draw(); }

  function toLocal(e) {
    const r = canvas.getBoundingClientRect();
    return [clamp01((e.clientX - r.left) / r.width), clamp01((e.clientY - r.top) / r.height)];
  }
  function hitTest(nx, ny) {
    for (let i = regions.length - 1; i >= 0; i--) {
      const r = regions[i];
      if (Math.abs(nx - (r.x + r.w)) * canvas.clientWidth <= HANDLE &&
          Math.abs(ny - (r.y + r.h)) * canvas.clientHeight <= HANDLE) return { i, part: "resize" };
      if (nx >= r.x && nx <= r.x + r.w && ny >= r.y && ny <= r.y + r.h) return { i, part: "move" };
    }
    return null;
  }

  canvas.addEventListener("pointerdown", (e) => {
    if (!isManual()) return;
    activeEditor = node.__rcl; canvas.focus();
    const [nx, ny] = toLocal(e);
    const hit = hitTest(nx, ny);
    sel = hit ? hit.i : null;
    if (hit) {
      const r = regions[hit.i];
      drag = hit.part === "resize" ? { i: hit.i, mode: "resize" } : { i: hit.i, mode: "move", ox: nx - r.x, oy: ny - r.y };
      canvas.setPointerCapture(e.pointerId);
      e.preventDefault(); ensureAnim();
    } else stopAnim();
    redraw();
  });
  canvas.addEventListener("pointermove", (e) => {
    const [nx, ny] = toLocal(e);
    if (drag && isManual()) {
      const r = regions[drag.i], shift = e.shiftKey;
      const g = regions[1 - drag.i] ? [regions[1 - drag.i].x, regions[1 - drag.i].x + regions[1 - drag.i].w, regions[1 - drag.i].y, regions[1 - drag.i].y + regions[1 - drag.i].h] : [];
      if (drag.mode === "move") {
        let mx = clamp01(nx - drag.ox), my = clamp01(ny - drag.oy);
        if (r.x + r.w > 1) mx = 1 - r.w; if (r.y + r.h > 1) my = 1 - r.h;
        if (shift) {
          const sx = snapValue(mx, g), sxr = snapValue(mx + r.w, g);
          if (sx !== mx) mx = sx; else if (sxr !== mx + r.w) mx = sxr - r.w;
          const sy = snapValue(my, g), syr = snapValue(my + r.h, g);
          if (sy !== my) my = sy; else if (syr !== my + r.h) my = syr - r.h;
        }
        r.x = clamp01(mx); r.y = clamp01(my);
        if (r.x + r.w > 1) r.x = 1 - r.w; if (r.y + r.h > 1) r.y = 1 - r.h;
      } else {
        let rw = Math.max(0.04, clamp01(nx - r.x)), rh = Math.max(0.04, clamp01(ny - r.y));
        if (shift) { rw = Math.max(0.04, snapValue(r.x + rw, g) - r.x); rh = Math.max(0.04, snapValue(r.y + rh, g) - r.y); }
        r.w = rw; r.h = rh;
      }
      sync(); redraw();
    } else {
      const hit = hitTest(nx, ny);
      const key = hit ? (hit.i + ":" + hit.part) : null;
      const prev = hover ? (hover.i + ":" + hover.part) : null;
      hover = hit;
      canvas.style.cursor = !isManual() ? "default" : (hit ? (hit.part === "resize" ? "nwse-resize" : "move") : "crosshair");
      if (key !== prev && sel == null) redraw();
    }
  });
  const endDrag = () => { if (drag) { drag = null; sync(); redraw(); if (sel == null) stopAnim(); } };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  canvas.addEventListener("focus", () => { activeEditor = node.__rcl; });

  window.addEventListener("keydown", (e) => {
    if (activeEditor !== node.__rcl || sel == null || !isManual()) return;
    const tag = (document.activeElement && document.activeElement.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    const r = regions[sel], big = e.shiftKey ? 0.02 : 0.005;
    let used = true;
    if (e.key === "ArrowLeft") r.x = clamp01(r.x - big);
    else if (e.key === "ArrowRight") r.x = clamp01(r.x + big);
    else if (e.key === "ArrowUp") r.y = clamp01(r.y - big);
    else if (e.key === "ArrowDown") r.y = clamp01(r.y + big);
    else if (e.key === "Delete" || e.key === "Backspace") { regions = defaultRegions(); sel = null; }
    else used = false;
    if (used) {
      e.preventDefault();
      if (r.x + r.w > 1) r.x = 1 - r.w; if (r.y + r.h > 1) r.y = 1 - r.h;
      sync(); redraw();
    }
  });

  // clean-tilt presets
  const setTilt = (axis, t) => {
    regions = axis === "v"
      ? [{ char: "a", x: 0, y: 0, w: t, h: 1 }, { char: "b", x: t, y: 0, w: 1 - t, h: 1 }]
      : [{ char: "a", x: 0, y: 0, w: 1, h: t }, { char: "b", x: 0, y: t, w: 1, h: 1 - t }];
    sel = null; sync(); redraw();
  };
  const tile = (label, fn) => {
    const b = document.createElement("span"); b.className = "rcl-tile"; b.textContent = label;
    b.addEventListener("click", fn); b.addEventListener("pointerdown", (e) => e.stopPropagation());
    bar.appendChild(b);
  };
  tile("50 / 50", () => setTilt("v", 0.5));
  tile("33 / 67", () => setTilt("v", 0.333333));
  tile("67 / 33", () => setTilt("v", 0.666667));
  tile("top / bottom", () => setTilt("h", 0.5));
  tile("reset", () => { regions = defaultRegions(); sel = null; sync(); redraw(); });

  node.__rcl = { refresh() { regions = parseRegions(store); redraw(); } };

  try { new ResizeObserver(() => redraw()).observe(canvas); } catch (_) {}
  const oldResize = node.onResize;
  node.onResize = function () { oldResize && oldResize.apply(this, arguments); redraw(); };

  redraw();
  requestAnimationFrame(() => { const h = wrap.offsetHeight; if (h > 0) { node.size[1] = h + 24; node.setDirtyCanvas(true, true); } });
}

app.registerExtension({
  name: "Nougan.RegionalCharacterLora",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (!NODE_NAMES.includes(nodeData?.name)) return;
    nodeType.color = "#1a2a3a"; nodeType.bgcolor = "#0f1923";

    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onCreated ? onCreated.apply(this, arguments) : undefined;
      const node = this;
      node.size = [420, 320];
      let initVal = JSON.stringify(defaultRegions());
      const autoIdx = node.widgets ? node.widgets.findIndex((w) => w.name === "regions") : -1;
      if (autoIdx >= 0) {
        if (node.widgets[autoIdx].value) initVal = node.widgets[autoIdx].value;
        node.widgets.splice(autoIdx, 1);
      }
      try { buildEditor(node, initVal); } catch (e) { console.warn("[NouganRegionalLora] editor build failed", e); }
      return r;
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (info) {
      onConfigure && onConfigure.apply(this, arguments);
      try {
        if (!this.__rcl) buildEditor(this, JSON.stringify(defaultRegions()));
        this.__rcl.refresh();
      } catch (e) { console.warn("[NouganRegionalLora] editor configure failed", e); }
    };
  },
});