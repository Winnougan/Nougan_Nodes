// nougan-regional-lora.js — Nougan Regional Character LoRA · in-node editor (DOM)
// Type each character's prompt INSIDE its region box; a global bar holds shared
// direction. Boxes are draggable (badge) / resizable (corner grip). The editor
// writes { regions:[{char,x,y,w,h,text}...], global:"..." } into the hidden
// "regions" widget — the single source of truth the backend reads.
//
// SELF-HEAL: scrubWidgets() + the parseFloat coercion in refresh() reset any
// number widget that loaded a non-number (e.g. an old "manual" split_mode value
// that slid into the feather slot after the widget list changed). This makes old
// saved graphs runnable again on a plain hard-refresh — no node deletion needed.
import { app } from "../../scripts/app.js";

const NODE_NAMES = ["NouganRegionalCharacterLoRA", "Krea2RegionalCharacterLoRA", "RegionalCharacterLora"];

// Number widgets we know about + the default to restore if a stale string lands in them.
const FLOAT_DEFAULTS = { feather: 0.06, seam_feather: 0.08, strength_a: 1.0, strength_b: 1.0, blend_override: 0.0 };

function scrubWidgets(node) {
  for (const w of node.widgets || []) {
    if (typeof w.value === "string" && Object.prototype.hasOwnProperty.call(FLOAT_DEFAULTS, w.name)) {
      const n = parseFloat(w.value);
      if (!isFinite(n)) w.value = FLOAT_DEFAULTS[w.name];   // drop the stale string
    }
  }
}

function hideWidget(w) {
  if (!w) return;
  const el = w.element || w.inputEl;
  if (el) { el.style.display = "none"; el.style.height = "0"; el.style.pointerEvents = "none"; }
  if (w._nrlHidden) return; w._nrlHidden = true;
  w.computeSize = () => [0, -4]; w.draw = () => {};
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const clamp01 = (v) => clamp(v, 0, 1);

function defaultRegions() {
  return [
    { char: "a", x: 0.0, y: 0.0, w: 0.5, h: 1.0, text: "" },
    { char: "b", x: 0.5, y: 0.0, w: 0.5, h: 1.0, text: "" },
  ];
}
function parseState(v) {
  let d = {};
  try { d = v ? JSON.parse(v) : {}; } catch (e) { d = {}; }
  let regs = Array.isArray(d) ? d : (d && Array.isArray(d.regions) ? d.regions : []);
  const global = (d && !Array.isArray(d) && typeof d.global === "string") ? d.global : "";
  regs = regs.filter((r) => r && typeof r === "object").map((r) => ({
    char: String(r.char || "a").toLowerCase() === "b" ? "b" : "a",
    x: +r.x || 0, y: +r.y || 0, w: +r.w || 0.5, h: +r.h || 1, text: String(r.text || ""),
  }));
  while (regs.length < 2) regs.push({ char: regs.length ? "b" : "a", x: regs.length ? 0.5 : 0, y: 0, w: 0.5, h: 1, text: "" });
  return { regions: regs.slice(0, 2), global };
}

let styled = false;
function injectStyles() {
  if (styled) return; styled = true;
  const s = document.createElement("style");
  s.textContent = `
    .nrl-panel{font-family:'Inter','Segoe UI',system-ui,sans-serif;color:#dce6f5;font-size:12px;
      pointer-events:auto;display:flex;flex-direction:column;gap:8px;padding:8px;border-radius:9px;
      background:linear-gradient(160deg,#141b29,#0c111b);border:1px solid #243149;
      box-shadow:inset 0 1px 0 rgba(255,255,255,.04)}
    .nrl-panel *{box-sizing:border-box;pointer-events:auto}
    .nrl-stage{position:relative;height:232px;border-radius:8px;overflow:hidden;border:1px solid #1c2740;background:#0a0e16}
    .nrl-ta{position:absolute;margin:0;padding:24px 8px 16px 8px;border:none;outline:none;resize:none;overflow:auto;
      background:transparent;color:#eaf2ff;font:500 11.5px/1.35 'Inter',system-ui,sans-serif;white-space:pre-wrap;
      word-break:break-word;letter-spacing:.1px;scrollbar-width:thin;transition:box-shadow .15s, background .15s}
    .nrl-ta::placeholder{color:#5d6e87;font-style:italic}
    .nrl-ta::-webkit-scrollbar{width:6px}.nrl-ta::-webkit-scrollbar-thumb{background:rgba(255,255,255,.14);border-radius:3px}
    .nrl-badge{position:absolute;display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border-radius:9px;
      font:800 10.5px/1 ui-monospace,'SF Mono',Menlo,Consolas,monospace;letter-spacing:.4px;color:#08111c;
      cursor:move;user-select:none;box-shadow:0 2px 8px rgba(0,0,0,.4);transition:transform .12s, filter .12s}
    .nrl-badge:hover{transform:scale(1.05);filter:brightness(1.12)}
    .nrl-badge .ct{font-weight:700;opacity:.62}
    .nrl-grip{position:absolute;width:13px;height:13px;border-radius:3px;cursor:nwse-resize;box-shadow:0 1px 4px rgba(0,0,0,.45);transition:transform .12s}
    .nrl-grip:hover{transform:scale(1.25)}
    .nrl-row{display:flex;align-items:center;gap:8px}
    .nrl-lbl{font:700 9.5px/1 ui-monospace,'SF Mono',Menlo,Consolas,monospace;text-transform:uppercase;letter-spacing:.6px;color:#7f93ad;min-width:54px}
    .nrl-lbl.glob{color:#b388ff}
    .nrl-num{width:64px;padding:3px 6px;border-radius:5px;border:1px solid #2c3a55;background:#0a1018;color:#eaf2ff;font-size:12px;text-align:center;outline:none}
    .nrl-num:focus{border-color:#5a8abf}
    .nrl-globta{width:100%;min-height:46px;resize:vertical;padding:7px 9px;border-radius:6px;border:1px solid #2c3a55;
      background:#0a1018;color:#eaf2ff;font:500 12px/1.4 'Inter',system-ui,sans-serif;outline:none;transition:border-color .15s, box-shadow .15s}
    .nrl-globta:focus{border-color:#b388ff;box-shadow:0 0 0 3px rgba(179,136,255,.12)}
    .nrl-globta::placeholder{color:#5d6e87;font-style:italic}
    .nrl-tiles{display:flex;flex-wrap:wrap;gap:5px;align-items:center}
    .nrl-tile{padding:4px 9px;border-radius:6px;border:1px solid #2c3a55;background:rgba(255,255,255,.03);color:#9fb2c8;
      cursor:pointer;font:600 11px/1 inherit;user-select:none;transition:all .12s}
    .nrl-tile:hover{border-color:#5a8abf;color:#eaf2ff;background:rgba(90,138,191,.14);transform:translateY(-1px)}
    .nrl-tile:active{transform:translateY(0)}
    .nrl-foot{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;
      font:600 10px/1 ui-monospace,'SF Mono',Menlo,Consolas,monospace;color:#7f93ad;border-top:1px dashed #243149;padding-top:7px}
    .nrl-foot b{color:#cdd9ea}.nrl-foot .bad{color:#ffd23f}
    .nrl-foot .hint{color:#5d6e87;font-weight:500;font-family:'Inter',system-ui,sans-serif}
  `;
  document.head.appendChild(s);
}

function buildEditor(node) {
  injectStyles();
  const wRegions = node.widgets && node.widgets.find((w) => w.name === "regions");
  const wFeather = node.widgets && node.widgets.find((w) => w.name === "feather");
  hideWidget(wRegions);
  hideWidget(wFeather);   // feather now lives in the panel below

  let state = { regions: defaultRegions(), global: "" };
  let store = JSON.stringify(state);

  const panel = document.createElement("div"); panel.className = "nrl-panel";
  panel.innerHTML = `
    <div class="nrl-stage" data-n="stage">
      <textarea class="nrl-ta" data-n="ta0" spellcheck="false" placeholder="Character A — who/what lives in this region…"></textarea>
      <textarea class="nrl-ta" data-n="ta1" spellcheck="false" placeholder="Character B — who/what lives in this region…"></textarea>
      <span class="nrl-badge" data-n="bd0"></span>
      <span class="nrl-badge" data-n="bd1"></span>
      <span class="nrl-grip" data-n="gp0"></span>
      <span class="nrl-grip" data-n="gp1"></span>
    </div>
    <div class="nrl-tiles">
      <span class="nrl-tile" data-t="50">50 / 50</span>
      <span class="nrl-tile" data-t="33">33 / 67</span>
      <span class="nrl-tile" data-t="67">67 / 33</span>
      <span class="nrl-tile" data-t="tb">top / bottom</span>
      <span class="nrl-tile" data-t="rs">reset boxes</span>
    </div>
    <div class="nrl-row"><span class="nrl-lbl">Feather</span>
      <input class="nrl-num" data-n="feather" type="number" min="0" max="0.3" step="0.01">
      <span class="nrl-lbl" style="min-width:auto;opacity:.6">seam softness</span></div>
    <div class="nrl-row" style="flex-direction:column;align-items:stretch;gap:3px">
      <span class="nrl-lbl glob">Global prompt · shared scene / style</span>
      <textarea class="nrl-globta" data-n="glob" spellcheck="false" placeholder="e.g. cinematic bar interior, warm rim light — applies everywhere on top of each region"></textarea>
    </div>
    <div class="nrl-foot">
      <span data-n="cov"></span>
      <span class="hint">drag badge = move · corner = resize · body = type</span>
    </div>`;

  let storedH = 470;
  const dom = node.addDOMWidget("nrl_ui", "div", panel, {
    getHeight: () => storedH, setValue: () => {}, getValue: () => ({}),
  });
  dom.serializeValue = () => undefined;

  const $ = (s) => panel.querySelector(`[data-n="${s}"]`);
  const stage = $("stage");
  const ta = [$("ta0"), $("ta1")], bd = [$("bd0"), $("bd1")], gp = [$("gp0"), $("gp1")];
  const glob = $("glob"), cov = $("cov"), featherIn = $("feather");

  const COL = { a: "#4ea1ff", b: "#ff4d8d" };
  const TINT = { a: "rgba(78,161,255,.12)", b: "rgba(255,77,141,.12)" };

  function sync() {
    store = JSON.stringify(state);
    if (wRegions) wRegions.value = store;
    readout();
  }
  function readout() {
    const a = state.regions[0], b = state.regions[1];
    const aA = a.w * a.h, bA = b.w * b.h;
    const ox = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
    const oy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    const ov = ox * oy, gap = Math.max(0, 1 - (aA + bA - ov));
    const p = (v) => (v * 100).toFixed(0) + "%";
    cov.innerHTML = `A <b>${p(aA)}</b> · B <b>${p(bA)}</b> · overlap <b class="${ov > 0.002 ? "bad" : ""}">${p(ov)}</b> · gap <b class="${gap > 0.002 ? "bad" : ""}">${p(gap)}</b>`;
  }
  function layout() {
    const W = stage.clientWidth, H = stage.clientHeight;
    if (!W || !H) return;
    state.regions.forEach((r, i) => {
      const x = r.x * W, y = r.y * H, w = r.w * W, h = r.h * H, c = COL[r.char];
      ta[i].style.left = x + "px"; ta[i].style.top = y + "px"; ta[i].style.width = w + "px"; ta[i].style.height = h + "px";
      ta[i].style.background = TINT[r.char];
      bd[i].style.left = (x + 5) + "px"; bd[i].style.top = (y + 5) + "px"; bd[i].style.background = c;
      bd[i].innerHTML = r.char.toUpperCase() + ` <span class="ct">${r.text.trim().length}</span>`;
      gp[i].style.left = (x + w - 16) + "px"; gp[i].style.top = (y + h - 16) + "px"; gp[i].style.background = c;
    });
  }

  // refresh = the load path. It scrubs stale values, coerces feather to a number,
  // and repopulates the DOM. This is what makes an old saved node runnable again.
  function refresh() {
    scrubWidgets(node);
    state = parseState(wRegions ? wRegions.value : store);
    store = JSON.stringify(state);
    ta.forEach((t, i) => { t.value = state.regions[i].text; });
    glob.value = state.global;
    // Coerce feather: if a stale string ("manual") survived scrub somehow, or the
    // slot is empty, fall back to the default and write the NUMBER back to the widget.
    if (wFeather) {
      let fv = parseFloat(wFeather.value);
      if (!isFinite(fv)) fv = FLOAT_DEFAULTS.feather;
      fv = clamp(fv, 0, 0.3);
      wFeather.value = fv;            // native widget now holds a real float → validation passes
      featherIn.value = fv;
    }
    sync(); layout();
    fit();
  }
  function fit() {
    const h = panel.offsetHeight;
    if (h > 0 && Math.abs(h - storedH) > 2) { storedH = h; node.setDirtyCanvas(true, true); }
  }

  // typing
  ta.forEach((t, i) => {
    t.addEventListener("input", () => { state.regions[i].text = t.value; bd[i].querySelector(".ct").textContent = t.value.trim().length; sync(); });
    t.addEventListener("pointerdown", (e) => e.stopPropagation());
  });
  glob.addEventListener("input", () => { state.global = glob.value; sync(); });
  glob.addEventListener("pointerdown", (e) => e.stopPropagation());
  featherIn.addEventListener("input", () => {
    if (!wFeather) return;
    const fv = clamp(parseFloat(featherIn.value) || 0, 0, 0.3);
    wFeather.value = fv;              // keep the native float widget in sync
  });
  featherIn.addEventListener("pointerdown", (e) => e.stopPropagation());

  // drag: badge = move, grip = resize
  function startDrag(i, mode, e) {
    e.preventDefault(); e.stopPropagation();
    const W = stage.clientWidth, H = stage.clientHeight;
    const sx = e.clientX, sy = e.clientY, r = state.regions[i];
    const s = { x: r.x, y: r.y, w: r.w, h: r.h };
    const move = (ev) => {
      if (mode === "move") {
        r.x = clamp01(s.x + (ev.clientX - sx) / W); r.y = clamp01(s.y + (ev.clientY - sy) / H);
        if (r.x + r.w > 1) r.x = 1 - r.w; if (r.y + r.h > 1) r.y = 1 - r.h;
      } else {
        r.w = clamp(s.w + (ev.clientX - sx) / W, 0.05, 1); r.h = clamp(s.h + (ev.clientY - sy) / H, 0.05, 1);
        if (r.x + r.w > 1) r.x = 1 - r.w; if (r.y + r.h > 1) r.y = 1 - r.h;
      }
      layout(); sync();
    };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); sync(); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  }
  bd.forEach((b, i) => b.addEventListener("pointerdown", (e) => startDrag(i, "move", e)));
  gp.forEach((g, i) => g.addEventListener("pointerdown", (e) => startDrag(i, "resize", e)));

  // tiles
  panel.querySelectorAll("[data-t]").forEach((b) => b.addEventListener("click", () => {
    const t = b.getAttribute("data-t"), a = state.regions[0], bb = state.regions[1];
    if (t === "50") { a.x = 0; a.y = 0; a.w = 0.5; a.h = 1; bb.x = 0.5; bb.y = 0; bb.w = 0.5; bb.h = 1; }
    else if (t === "33") { a.x = 0; a.y = 0; a.w = 0.3333; a.h = 1; bb.x = 0.3333; bb.y = 0; bb.w = 0.6667; bb.h = 1; }
    else if (t === "67") { a.x = 0; a.y = 0; a.w = 0.6667; a.h = 1; bb.x = 0.6667; bb.y = 0; bb.w = 0.3333; bb.h = 1; }
    else if (t === "tb") { a.x = 0; a.y = 0; a.w = 1; a.h = 0.5; bb.x = 0; bb.y = 0.5; bb.w = 1; bb.h = 0.5; }
    else if (t === "rs") { const d = defaultRegions(); Object.assign(a, { x: d[0].x, y: d[0].y, w: d[0].w, h: d[0].h }); Object.assign(bb, { x: d[1].x, y: d[1].y, w: d[1].w, h: d[1].h }); }
    layout(); sync();
  }));

  node.__nrl = { refresh };
  refresh();
  requestAnimationFrame(() => { layout(); fit(); });
}

app.registerExtension({
  name: "Nougan.RegionalCharacterLora",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (!NODE_NAMES.includes(nodeData && nodeData.name)) return;
    nodeType.color = "#1a2a3a"; nodeType.bgcolor = "#0f1923";

    const onc = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onc ? onc.apply(this, arguments) : undefined;
      this.size = [440, 470];
      try { buildEditor(this); } catch (e) { console.warn("[NouganRegionalLora] editor build failed", e); }
      return r;
    };
    const ocf = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (info) {
      ocf && ocf.apply(this, arguments);
      // Scrub FIRST (kills stale "manual"-in-feather etc.), then (re)build/refresh.
      try { scrubWidgets(this); } catch (e) {}
      try {
        if (!this.__nrl) buildEditor(this);
        this.__nrl.refresh();
      } catch (e) { console.warn("[NouganRegionalLora] configure failed", e); }
    };
  },
});