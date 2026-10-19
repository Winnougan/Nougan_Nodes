// web/nougan_image_converter.js
// Visual panel for "Nougan Image Converter / Saver".
// Shows the active tier on a segmented meter and, after each run, a size card per image.

import { app } from "../../scripts/app.js";

const NODE_ID = "NouganImageConverter";

// Keep in sync with TIERS in nougan_image_converter.py
const TIERS = {
  5: ["Compact", 0.93],
  6: ["Lean", 0.95],
  7: ["Balanced", 0.965],
  8: ["Crisp", 0.975],
  9: ["Fine", 0.985],
  10: ["Pristine", 0.995],
};
// segment colours: cool (small file) -> warm (max fidelity)
const SEG = ["#38bdf8", "#22d3ee", "#34d399", "#a3e635", "#fbbf24", "#fb7185"];
const FMT = {
  png: "#4ade80", webp: "#38bdf8", jpeg: "#fbbf24", jpg: "#fbbf24",
  avif: "#c084fc", tiff: "#fb7185", bmp: "#94a3b8", gif: "#f472b6",
};
const EXACT = ["png", "tiff", "bmp"];

const CSS = `
.ng-ic{box-sizing:border-box;height:100%;overflow:auto;padding:12px 12px 14px;border-radius:14px;
  font:12px/1.4 "Segoe UI Variable","Segoe UI",system-ui,sans-serif;color:#e5e7f0;
  background:radial-gradient(120% 90% at 0% 0%,#1d2a4d 0%,#12172b 55%,#0c0f1d 100%);
  border:1px solid rgba(148,163,184,.16);scrollbar-width:thin}
.ng-ic *{box-sizing:border-box}
.ng-ic-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.ng-ic-title{font-size:15px;font-weight:700;letter-spacing:.02em;
  background:linear-gradient(90deg,#7dd3fc,#c4b5fd 55%,#f9a8d4);-webkit-background-clip:text;background-clip:text;color:transparent}
.ng-ic-pill{padding:2px 10px;border-radius:99px;font-weight:700;font-size:11px;border:1px solid currentColor;
  background:color-mix(in srgb,currentColor 14%,transparent);transition:color .25s}
.ng-ic-mode{margin-top:2px;color:#9aa4bf;font-size:11px}
.ng-ic-meter{display:flex;gap:5px;margin:12px 0 6px}
.ng-ic-seg{flex:1;height:12px;border-radius:3px;background:rgba(148,163,184,.14);position:relative;transition:background .25s,box-shadow .25s,opacity .25s}
.ng-ic-seg.on{background:var(--c);box-shadow:0 0 12px -1px var(--c)}
.ng-ic-seg.cur::after{content:"";position:absolute;left:50%;top:-5px;width:2px;height:22px;margin-left:-1px;background:#fff;border-radius:1px}
.ng-ic.off .ng-ic-seg{opacity:.35}
.ng-ic-tier{display:flex;justify-content:space-between;align-items:baseline}
.ng-ic-tier b{font-size:14px;font-weight:700}
.ng-ic-tier span{color:#9aa4bf;font-size:11px}
.ng-ic-note{margin-top:6px;color:#8892ad;font-size:11px}
.ng-ic-sum{margin-top:12px;padding:10px 12px;border-radius:10px;background:linear-gradient(120deg,rgba(52,211,153,.16),rgba(34,211,238,.10));
  border:1px solid rgba(52,211,153,.28);display:flex;justify-content:space-between;align-items:baseline}
.ng-ic-sum b{font-size:22px;font-weight:800;letter-spacing:-.01em;color:#6ee7b7}
.ng-ic-sum.neg{background:rgba(251,113,133,.10);border-color:rgba(251,113,133,.3)}
.ng-ic-sum.neg b{color:#fda4af}
.ng-ic-sum.plain b{color:#e5e7f0}
.ng-ic-sum.plain{background:rgba(148,163,184,.08);border-color:rgba(148,163,184,.2)}
.ng-ic-card{margin-top:8px;padding:8px 10px;border-radius:10px;background:rgba(9,12,24,.55);border:1px solid rgba(148,163,184,.12)}
.ng-ic-row{display:flex;justify-content:space-between;gap:8px}
.ng-ic-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#c9d0e4}
.ng-ic-size{white-space:nowrap;font-variant-numeric:tabular-nums;color:#9aa4bf}
.ng-ic-size b{color:#e5e7f0}
.ng-ic-bar{height:6px;border-radius:3px;background:rgba(148,163,184,.14);overflow:hidden;margin:7px 0}
.ng-ic-bar i{display:block;height:100%;border-radius:3px;background:linear-gradient(90deg,#34d399,#22d3ee);transition:width .9s cubic-bezier(.2,.8,.2,1)}
.ng-ic-chips{display:flex;flex-wrap:wrap;gap:5px}
.ng-ic-chips span{padding:1px 8px;border-radius:99px;font-size:10.5px;color:#aab3cc;background:rgba(148,163,184,.12)}
.ng-ic-chips span.ok{color:#6ee7b7;background:rgba(52,211,153,.14)}
.ng-ic-empty{margin-top:12px;padding:14px;border-radius:10px;border:1px dashed rgba(148,163,184,.25);color:#8892ad;text-align:center}
@media (prefers-reduced-motion:reduce){.ng-ic *{transition:none!important}}
`;

function injectCss() {
  if (document.getElementById("ng-ic-css")) return;
  const s = document.createElement("style");
  s.id = "ng-ic-css";
  s.textContent = CSS;
  document.head.appendChild(s);
}

function kb(n) {
  if (n == null) return "—";
  if (n >= 1048576) return (n / 1048576).toFixed(2) + " MB";
  return (n / 1024).toFixed(n < 10240 ? 1 : 0) + " KB";
}

function wval(node, name, fallback) {
  const w = node.widgets?.find((x) => x.name === name);
  return w ? w.value : fallback;
}

function render(node) {
  const el = node._ngPanel;
  if (!el) return;
  const fmt = String(wval(node, "format", "webp")).toLowerCase();
  const smart = !!wval(node, "smart_squeeze", true);
  const scale = Math.max(5, Math.min(10, Number(wval(node, "quality_scale", 8))));
  const [tierName, target] = TIERS[scale];
  const exact = EXACT.includes(fmt);
  const stats = node._ngStats || [];

  el.className = "ng-ic" + (smart ? "" : " off");
  const pillColor = FMT[fmt] || "#94a3b8";

  let modeText;
  if (!smart) modeText = "Standard export. Turn on Smart Squeeze for the smallest file.";
  else if (exact) modeText = "Pixel-perfect. Smart Squeeze trims size without changing a single pixel.";
  else modeText = `Finds the smallest file that scores at least ${target.toFixed(3)} similarity to the original.`;

  const segs = [5, 6, 7, 8, 9, 10]
    .map((n, i) => `<div class="ng-ic-seg${n <= scale ? " on" : ""}${n === scale ? " cur" : ""}" style="--c:${SEG[i]}"></div>`)
    .join("");

  let tierNote = "";
  if (smart && exact) tierNote = "The scale sets how hard the optimiser works. Output is always lossless.";
  else if (smart && fmt === "webp" && scale === 10) tierNote = "Pristine uses true lossless WebP when it is the smaller option.";
  else if (!smart) tierNote = `Plain quality ${scale === 10 ? "100" : { 5: 75, 6: 82, 7: 88, 8: 92, 9: 96 }[scale]}.`;

  let results;
  if (!stats.length) {
    results = `<div class="ng-ic-empty">Queue the workflow to see file sizes here.</div>`;
  } else {
    const withBase = stats.filter((s) => s.baseline);
    let sum = "";
    if (withBase.length) {
      const tb = withBase.reduce((a, s) => a + s.baseline, 0);
      const to = withBase.reduce((a, s) => a + s.bytes, 0);
      const pct = (1 - to / tb) * 100;
      const cls = pct < 0 ? "neg" : "";
      sum = `<div class="ng-ic-sum ${cls}"><div><b>${pct >= 0 ? "−" : "+"}${Math.abs(pct).toFixed(1)}%</b></div>
        <div class="ng-ic-size">${kb(tb)} standard → <b>${kb(to)}</b></div></div>`;
    } else {
      const to = stats.reduce((a, s) => a + s.bytes, 0);
      sum = `<div class="ng-ic-sum plain"><div><b>${kb(to)}</b></div><div class="ng-ic-size">${stats.length} file${stats.length > 1 ? "s" : ""} saved</div></div>`;
    }
    const cards = stats.slice(0, 12).map((s) => {
      const w = s.baseline ? Math.max(3, Math.min(100, (s.bytes / s.baseline) * 100)) : 100;
      const chips = [
        `<span>${s.w}×${s.h}</span>`,
        s.lossless ? `<span class="ok">bit-exact</span>` : s.ssim != null ? `<span class="ok">similarity ${s.ssim.toFixed(4)}</span>` : "",
        s.detail ? `<span>${s.detail}</span>` : "",
      ].join("");
      return `<div class="ng-ic-card">
        <div class="ng-ic-row"><div class="ng-ic-name">${s.name}</div>
        <div class="ng-ic-size">${s.baseline ? kb(s.baseline) + " → " : ""}<b>${kb(s.bytes)}</b></div></div>
        <div class="ng-ic-bar"><i style="width:${w}%"></i></div>
        <div class="ng-ic-chips">${chips}</div></div>`;
    }).join("");
    const more = stats.length > 12 ? `<div class="ng-ic-note">+ ${stats.length - 12} more saved</div>` : "";
    results = sum + cards + more;
  }

  el.innerHTML = `
    <div class="ng-ic-head"><div class="ng-ic-title">Image Converter</div>
      <div class="ng-ic-pill" style="color:${pillColor}">${fmt}</div></div>
    <div class="ng-ic-mode">${modeText}</div>
    <div class="ng-ic-meter">${segs}</div>
    <div class="ng-ic-tier"><b>${scale} · ${tierName}</b><span>${smart ? "target " + (exact ? "lossless" : target.toFixed(3)) : "Smart Squeeze off"}</span></div>
    ${tierNote ? `<div class="ng-ic-note">${tierNote}</div>` : ""}
    ${results}`;
}

app.registerExtension({
  name: "Nougan.ImageConverter",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_ID) return;
    injectCss();

    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onCreated?.apply(this, arguments);
      const el = document.createElement("div");
      this._ngPanel = el;
      this._ngStats = [];
      this.addDOMWidget("nougan_panel", "div", el, {
        serialize: false,
        hideOnZoom: false,
        getMinHeight: () => 230,
      });
      for (const n of ["format", "smart_squeeze", "quality_scale"]) {
        const w = this.widgets?.find((x) => x.name === n);
        if (!w) continue;
        const cb = w.callback;
        w.callback = (...a) => {
          const out = cb?.apply(w, a);
          render(this);
          return out;
        };
      }
      this.setSize([Math.max(this.size[0], 380), Math.max(this.size[1], 520)]);
      render(this);
      return r;
    };

    const onConf = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const r = onConf?.apply(this, arguments);
      render(this);
      return r;
    };

    const onExec = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      const r = onExec?.apply(this, arguments);
      this._ngStats = message?.nougan_stats || [];
      render(this);
      return r;
    };
  },
});
