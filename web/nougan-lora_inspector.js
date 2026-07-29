// Nougan Lora Inspector — progress bar + sample strip (click = copy prompt) +
// one-click inspect via /nougan/lora_inspector/inspect. No Queue needed.
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_TYPE = "NouganLoraInspector";
const WIDGET = "nli_panel";

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Archivo:wght@600;800;900&family=IBM+Plex+Mono:wght@400;500;700&display=swap');

.nli-panel{font-family:'IBM Plex Mono',ui-monospace,Menlo,monospace;color:#e6e9f0;
  background:#15171d;
  background-image:
    repeating-linear-gradient(0deg, rgba(255,255,255,.022) 0 1px, transparent 1px 22px),
    repeating-linear-gradient(90deg, rgba(255,255,255,.022) 0 1px, transparent 1px 22px);
  border:1px solid #2b303c;border-top:3px solid #f5a524;border-radius:8px;
  overflow:hidden;box-shadow:0 6px 20px rgba(0,0,0,.45);user-select:none;margin-top:6px}
.nli-inner{padding:10px 12px 12px}

.nli-head{display:flex;align-items:center;gap:6px;margin-bottom:8px}
.nli-title{font-size:10px;font-weight:700;letter-spacing:.22em;color:#9aa3b2}
.nli-dot{width:8px;height:8px;border-radius:50%;background:#5b6270;flex:none}
.nli-busy{background:#f5a524;animation:nli-pulse 1s ease-in-out infinite}
.nli-ok{background:#5ee08a}.nli-err{background:#f87171}
@keyframes nli-pulse{0%,100%{box-shadow:0 0 0 0 rgba(245,165,36,.5)}50%{box-shadow:0 0 0 5px rgba(245,165,36,0)}}
.nli-stage{margin-left:auto;font-size:9px;letter-spacing:.14em;text-transform:uppercase;
  color:#7d8595;background:#1d212a;border:1px solid #2b303c;padding:2px 7px;border-radius:3px}
.nli-run{font-family:inherit;font-size:9.5px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;
  color:#1a1206;background:linear-gradient(180deg,#ffc35c,#f5a524);border:1px solid #c9821a;
  border-radius:4px;padding:3px 11px;cursor:pointer;
  transition:transform .12s ease,box-shadow .12s ease,filter .12s}
.nli-run:hover{transform:translateY(-1px);box-shadow:0 3px 10px rgba(245,165,36,.35);filter:brightness(1.06)}
.nli-run:active{transform:translateY(0)}
.nli-run:disabled{filter:grayscale(.5) brightness(.7);cursor:default;transform:none;box-shadow:none}
.nli-again{font-family:inherit;font-size:11px;line-height:1;color:#9aa3b2;background:#1d212a;
  border:1px solid #2b303c;border-radius:4px;width:22px;height:22px;cursor:pointer;padding:0;
  transition:color .15s,border-color .15s,transform .3s ease}
.nli-again:hover{color:#ffd58a;border-color:#4a3b1e;transform:rotate(180deg)}
.nli-again:disabled{opacity:.4;cursor:default;transform:none}

.nli-bar-row{display:flex;align-items:center;gap:8px}
.nli-bar{flex:1;height:10px;background:#1d212a;border:1px solid #2b303c;border-radius:3px;overflow:hidden}
.nli-fill{height:100%;width:0%;transition:width .18s ease;
  background:repeating-linear-gradient(-45deg,#f5a524 0 8px,#c9821a 8px 16px);
  animation:nli-stripes .8s linear infinite}
.nli-fill.nli-fetch{background:repeating-linear-gradient(-45deg,#41c7e0 0 8px,#2293a6 8px 16px);
  animation:nli-stripes .5s linear infinite,nli-throb 1s ease-in-out infinite}
.nli-fill.nli-done{background:#5ee08a;animation:none}
.nli-fill.nli-error{background:#f87171;animation:none}
@keyframes nli-stripes{to{background-position:32px 0}}
@keyframes nli-throb{0%,100%{opacity:1}50%{opacity:.55}}
.nli-pct{font-size:10px;color:#9aa3b2;min-width:34px;text-align:right}
.nli-msg{margin-top:6px;font-size:10px;color:#7d8595;min-height:13px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

/* ---------- result card ---------- */
.nli-card{margin-top:10px;animation:nli-in .4s cubic-bezier(.22,1,.36,1)}
@keyframes nli-in{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}

.nli-name{font-family:'Archivo',sans-serif;font-weight:900;font-size:18px;line-height:1.15;
  color:#f4f6fa;margin-bottom:7px}
.nli-badges{display:flex;gap:5px;flex-wrap:wrap;margin-bottom:10px}
.nli-badge{font-size:8.5px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;
  padding:2.5px 7px;border-radius:3px;background:#1d212a;color:#c7cdd8;border:1px solid #2b303c}
.nli-badge.nli-nsfw{background:rgba(248,115,115,.16);border-color:rgba(248,115,115,.45);color:#ffb3b3}

/* ---------- trigger words (top of card) ---------- */
.nli-k{font-size:9px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:#7d8595}
.nli-tw-head{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.nli-copyall{margin-left:auto;font-family:inherit;font-size:9px;font-weight:700;
  letter-spacing:.12em;text-transform:uppercase;color:#ffd58a;background:#2b2416;
  border:1px solid #4a3b1e;border-radius:3px;padding:3px 9px;cursor:pointer;
  transition:background .15s,transform .1s}
.nli-copyall:hover{background:#3a3019;transform:translateY(-1px)}
.nli-chips{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:10px}
.nli-chip{font-family:inherit;font-size:12px;font-weight:500;color:#ffd58a;background:#2b2416;
  border:1px solid #4a3b1e;border-radius:3px;padding:4px 11px;cursor:pointer;
  transition:background .15s,transform .1s}
.nli-chip:hover{background:#3a3019;transform:translateY(-1px)}
.nli-chip.nli-copied,.nli-copyall.nli-copied{
  background:#173321!important;border-color:#2f6b45!important;color:#5ee08a!important}
.nli-none{font-size:11px;color:#5b6270;margin-bottom:10px}

.nli-base-row{display:flex;align-items:center;gap:9px;margin-bottom:10px}
.nli-for{font-size:9px;font-weight:700;letter-spacing:.24em;text-transform:uppercase;color:#7d8595}
.nli-base-badge{font-family:'Archivo',sans-serif;font-weight:800;font-size:14px;
  padding:4px 12px;border-radius:4px;border:1px solid;
  transition:transform .15s ease,box-shadow .15s ease}
.nli-base-badge:hover{transform:translateY(-1px);box-shadow:0 4px 12px rgba(0,0,0,.45)}
.nli-base-none{font-size:11px;color:#5b6270}

/* ---------- sample strip ---------- */
.nli-strip-wrap{position:relative}
.nli-strip{display:flex;gap:6px;overflow-x:auto;padding:4px 2px 8px;
  scroll-snap-type:x mandatory;scrollbar-width:thin;scrollbar-color:#3a4150 transparent}
.nli-strip::-webkit-scrollbar{height:6px}
.nli-strip::-webkit-scrollbar-thumb{background:#3a4150;border-radius:3px}
.nli-strip::-webkit-scrollbar-track{background:transparent}
.nli-frame{flex:0 0 auto;width:86px;height:112px;margin:0;position:relative;cursor:pointer;
  border:2px solid #2b303c;border-radius:5px;overflow:hidden;scroll-snap-align:start;
  background:#1b1e26;transition:transform .2s ease,border-color .2s ease,box-shadow .2s ease}
.nli-frame img{width:100%;height:100%;object-fit:cover;display:block;transition:transform .35s ease}
.nli-frame:hover{transform:translateY(-3px);border-color:#4a5262}
.nli-frame:hover img{transform:scale(1.07)}
.nli-frame.nli-broken{display:none}
.nli-frame-flag{position:absolute;left:0;right:0;bottom:0;font-size:7.5px;font-weight:700;
  letter-spacing:.12em;text-transform:uppercase;text-align:center;
  background:rgba(248,115,115,.85);color:#fff;padding:1.5px 0}
.nli-toast{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
  text-align:center;padding:4px;font-size:9px;font-weight:700;letter-spacing:.05em;
  background:rgba(13,14,18,.84);color:#5ee08a;pointer-events:none;
  animation:nli-toast 1.15s ease forwards}
.nli-toast.nli-toast-warn{color:#f5a524}
@keyframes nli-toast{0%{opacity:0}12%{opacity:1}72%{opacity:1}100%{opacity:0}}
.nli-nav{position:absolute;top:50%;transform:translateY(-50%);z-index:2;width:22px;height:36px;
  border:1px solid #2b303c;background:rgba(21,23,29,.88);color:#9aa3b2;font-size:15px;line-height:1;
  border-radius:4px;cursor:pointer;padding:0;transition:color .15s,background .15s,opacity .2s}
.nli-nav:hover{color:#ffd58a;background:rgba(43,36,22,.95)}
.nli-nav-l{left:-4px}.nli-nav-r{right:-4px}
.nli-nav:disabled{opacity:.22;cursor:default}
.nli-nav:disabled:hover{color:#9aa3b2;background:rgba(21,23,29,.88)}
.nli-noimg-note{font-size:10px;color:#5b6270;font-style:italic;margin:2px 0 8px}

/* ---------- body rows ---------- */
.nli-row{display:flex;gap:8px;font-size:11px;margin:4px 0;align-items:baseline}
.nli-row .nli-k{flex:none;width:74px}
.nli-v{color:#dfe3ea;word-break:break-word}
.nli-desc{font-size:10.5px;color:#9aa3b2;margin-top:8px;line-height:1.5;
  border-left:2px solid #2b303c;padding-left:9px}
.nli-foot{display:flex;align-items:center;gap:10px;margin-top:10px;font-size:9px}
.nli-src{padding:2.5px 8px;border-radius:3px;letter-spacing:.1em;text-transform:uppercase;font-weight:700}
.nli-src-ok{background:#173321;color:#5ee08a;border:1px solid #2f6b45}
.nli-src-off{background:#2a2118;color:#f5a524;border:1px solid #4a3b1e}
.nli-sha{color:#5b6270}
.nli-link{margin-left:auto;color:#41c7e0;text-decoration:none;border-bottom:1px dotted #41c7e0;
  transition:color .15s}
.nli-link:hover{color:#8fe3f2}
`;

let cssInjected = false;
function injectCSS() {
  if (cssInjected) return;
  const s = document.createElement("style");
  s.textContent = CSS;
  document.head.appendChild(s);
  cssInjected = true;
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Color-code the base-model badge per architecture family (stable hash).
const ARCH_HUES = [
  ["#41c7e0", "rgba(65,199,224,.12)"],
  ["#f5a524", "rgba(245,165,36,.12)"],
  ["#c4a7ff", "rgba(196,167,255,.14)"],
  ["#5ee08a", "rgba(94,224,138,.12)"],
  ["#f883b6", "rgba(248,131,182,.12)"],
  ["#9db4ff", "rgba(157,180,255,.13)"],
];
function archHue(name) {
  let h = 0;
  for (const c of String(name || "")) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return ARCH_HUES[h % ARCH_HUES.length];
}

function flashCopied(el, label = "copied ✓") {
  const old = el.textContent;
  el.classList.add("nli-copied");
  el.textContent = label;
  setTimeout(() => { el.classList.remove("nli-copied"); el.textContent = old; }, 900);
}
function copyText(t) { try { navigator.clipboard?.writeText(t); } catch (_) {} }

class InspectorPanel {
  constructor(node) {
    this.node = node;
    this.lastMeta = null;
    this.running = false;
    this._queued = false;
    this._timer = null;

    const root = (this.root = document.createElement("div"));
    root.className = "nli-panel";
    root.innerHTML = `
      <div class="nli-inner">
        <div class="nli-head">
          <span class="nli-dot"></span>
          <span class="nli-title">NOUGAN&nbsp;·&nbsp;LORA&nbsp;INSPECTOR</span>
          <span class="nli-stage">idle</span>
          <button class="nli-run" title="look up this LoRA now">inspect</button>
          <button class="nli-again" title="force refresh — bypass cache">↻</button>
        </div>
        <div class="nli-bar-row">
          <div class="nli-bar"><div class="nli-fill"></div></div>
          <span class="nli-pct">—</span>
        </div>
        <div class="nli-msg">Pick a LoRA — it looks itself up, or press inspect.</div>
        <div class="nli-card"></div>
      </div>`;

    root.addEventListener("click", (e) => {
      if (e.target.closest(".nli-run")) { this.inspect(false); return; }
      if (e.target.closest(".nli-again")) { this.inspect(true); return; }

      // frame click → copy THAT image's positive prompt (nothing else)
      const frame = e.target.closest(".nli-frame");
      if (frame) {
        const im = (this.lastMeta?.images || [])[Number(frame.dataset.idx)];
        const p = String(im?.meta?.prompt || im?.meta?.Prompt || "").trim();
        if (p) { copyText(p); this.toast(frame, "prompt copied ✓"); }
        else { this.toast(frame, "no prompt", true); }
        return;
      }

      const nav = e.target.closest(".nli-nav");
      if (nav && !nav.disabled) {
        this.root.querySelector(".nli-strip")
          ?.scrollBy({ left: Number(nav.dataset.dir) * 192, behavior: "smooth" });
        return;
      }

      const chip = e.target.closest(".nli-chip");
      if (chip) { copyText(chip.dataset.word); flashCopied(chip); return; }

      const all = e.target.closest(".nli-copyall");
      if (all) { copyText(all.dataset.words); flashCopied(all); return; }

      const a = e.target.closest("a.nli-link");
      if (a) { e.preventDefault(); window.open(a.href, "_blank"); }
    });

    // vertical wheel → horizontal strip scroll (capture: scroll doesn't bubble)
    root.addEventListener("wheel", (e) => {
      const strip = e.target.closest(".nli-strip");
      if (strip && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        strip.scrollLeft += e.deltaY;
      }
    }, { passive: false });

    root.addEventListener("scroll", () => this.updateNav(), true);
  }

  // ---------------- inspection (no Queue needed) ----------------

  async inspect(force = false) {
    if (this.running) { this._queued = true; return; }
    const node = this.node;
    const wv = (name) => node.widgets?.find((w) => w.name === name)?.value ?? "";
    const params = new URLSearchParams({
      lora: String(wv("lora_name") || ""),
      source: String(wv("source") || "auto"),
      api_key: String(wv("api_key") || ""),
      node: String(node.id),
      force: force ? "1" : "0",
    });
    if (!params.get("lora")) { this.setError("no LoRA selected"); return; }

    this.setRunning(true);
    this.setProgress({ stage: "start", value: 0, message: "Contacting backend…" });
    try {
      const resp = await api.fetchApi(`/nougan/lora_inspector/inspect?${params.toString()}`);
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data?.error || `HTTP ${resp.status}`);
      if (data.error) throw new Error(data.error);
      this.render(data);
      this.setProgress(data.warning
        ? { stage: "error", value: 1, message: "⚠ " + data.warning }
        : { stage: "done", value: 1, message: "Done" });
    } catch (err) {
      this.setError(err.message || "inspection failed");
    } finally {
      this.setRunning(false);
      if (this._queued) { this._queued = false; this.scheduleInspect(); }
    }
  }

  scheduleInspect() {                 // debounced auto-run on LoRA change
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.inspect(false), 400);
  }

  setRunning(on) {
    this.running = on;
    const b = this.root.querySelector(".nli-run");
    const a = this.root.querySelector(".nli-again");
    b.disabled = on; a.disabled = on;
    b.textContent = on ? "working…" : "inspect";
  }

  toast(frame, text, warn = false) {
    frame.querySelector(".nli-toast")?.remove();
    const t = document.createElement("div");
    t.className = "nli-toast" + (warn ? " nli-toast-warn" : "");
    t.textContent = text;
    frame.appendChild(t);
    setTimeout(() => t.remove(), 1200);
  }

  // ---------------- progress ----------------

  setProgress({ stage = "hash", value = 0, message = "" } = {}) {
    const $ = (sel) => this.root.querySelector(sel);
    const fill = $(".nli-fill"), pct = $(".nli-pct"), msg = $(".nli-msg"),
          dot = $(".nli-dot"), stageEl = $(".nli-stage");

    const v = Math.max(0, Math.min(1, value));
    fill.className = "nli-fill nli-" + stage;
    if (stage === "fetch" && v === 0) {           // indeterminate while querying
      fill.style.width = "100%";
      pct.textContent = "···";
    } else {
      fill.style.width = (v * 100).toFixed(1) + "%";
      pct.textContent = stage === "done" ? "100%" : Math.round(v * 100) + "%";
    }
    if (message) msg.textContent = message;
    stageEl.textContent = { start: "starting", hash: "hashing", fetch: "civitai",
                            done: "done", error: "error" }[stage] || stage;
    dot.className = "nli-dot " + (stage === "done" ? "nli-ok"
                                : stage === "error" ? "nli-err" : "nli-busy");
    this.fit();
  }

  setError(message) {
    this.setProgress({ stage: "error", value: 1, message: "⚠ " + message });
  }

  // ---------------- full card ----------------

  render(meta) {
    this.lastMeta = meta;
    this.node.properties = this.node.properties || {};
    this.node.properties.nli_meta = meta;         // persists in saved workflows

    const card = this.root.querySelector(".nli-card");
    if (!meta) { card.innerHTML = ""; return; }

    const loc = meta.local || {};
    const base = meta.base_model || loc.base_model_version;
    const [fg, bg] = archHue(base);
    const words = meta.trigger_words || [];
    const imgs = meta.images || [];

    const row = (k, v) => v
      ? `<div class="nli-row"><span class="nli-k">${esc(k)}</span><span class="nli-v">${esc(v)}</span></div>`
      : "";

    const stats = [];
    if (meta.downloads != null) stats.push(`⬇ ${Number(meta.downloads).toLocaleString()}`);
    if (meta.rating != null) stats.push(`★ ${Number(meta.rating).toFixed(2)}`);
    if (meta.file_size_kb != null) stats.push(`${(meta.file_size_kb / 1024).toFixed(0)} MB`);

    const strip = imgs.length
      ? `<div class="nli-strip-wrap">
           <button class="nli-nav nli-nav-l" data-dir="-1" title="scroll left">‹</button>
           <div class="nli-strip">${imgs.map((im, i) => `
             <figure class="nli-frame" data-idx="${i}" title="click to copy this image's prompt">
               <img loading="lazy" src="${esc(im.url)}" alt="" referrerpolicy="no-referrer"
                    onerror="this.closest('.nli-frame').classList.add('nli-broken')">
               ${im.nsfw && im.nsfw !== "None" ? `<span class="nli-frame-flag">${esc(im.nsfw)}</span>` : ""}
             </figure>`).join("")}
           </div>
           <button class="nli-nav nli-nav-r" data-dir="1" title="scroll right">›</button>
         </div>`
      : `<div class="nli-noimg-note">no sample images on this record</div>`;

    card.innerHTML = `
      <div class="nli-name">${esc(meta.model_name || meta.lora_file)}</div>
      <div class="nli-badges">
        ${meta.version_name ? `<span class="nli-badge">${esc(meta.version_name)}</span>` : ""}
        ${meta.model_type ? `<span class="nli-badge">${esc(meta.model_type)}</span>` : ""}
        ${meta.format ? `<span class="nli-badge">${esc(meta.format)}</span>` : ""}
        ${meta.nsfw ? `<span class="nli-badge nli-nsfw">NSFW</span>` : ""}
      </div>
      <div class="nli-tw-head">
        <span class="nli-k">trigger words</span>
        ${words.length > 1 ? `<button class="nli-copyall" data-words="${esc(words.join(", "))}">copy all</button>` : ""}
      </div>
      ${words.length
        ? `<div class="nli-chips">${words.map((w) =>
            `<button class="nli-chip" data-word="${esc(w)}" title="click to copy">${esc(w)}</button>`).join("")}</div>`
        : `<div class="nli-none">none listed on this record</div>`}
      <div class="nli-base-row">
        <span class="nli-for">for</span>
        ${base
          ? `<span class="nli-base-badge" style="color:${fg};background:${bg};border-color:${fg}55">${esc(base)}</span>`
          : `<span class="nli-base-none">unknown base model</span>`}
      </div>
      ${strip}
      ${row("file", meta.lora_file)}
      ${row("trained", [loc.resolution ? loc.resolution + " px" : null,
                        loc.clip_skip ? "clip skip " + loc.clip_skip : null,
                        loc.steps ? loc.steps + " steps" : null].filter(Boolean).join(" · "))}
      ${row("stats", stats.join("   "))}
      ${meta.description ? `<div class="nli-desc">${esc(meta.description.slice(0, 200))}${meta.description.length > 200 ? "…" : ""}</div>` : ""}
      <div class="nli-foot">
        <span class="nli-src ${meta.found ? "nli-src-ok" : "nli-src-off"}">${esc(meta.found ? meta.source : "local only")}</span>
        <span class="nli-sha" title="${esc(meta.sha256)}">sha256 ${esc((meta.sha256 || "").slice(0, 10))}…</span>
        ${meta.url ? `<a class="nli-link" href="${esc(meta.url)}">open ↗</a>` : ""}
      </div>`;
    this.fit();
  }

  // ---------------- housekeeping ----------------

  updateNav() {
    const strip = this.root.querySelector(".nli-strip");
    const l = this.root.querySelector(".nli-nav-l");
    const r = this.root.querySelector(".nli-nav-r");
    if (!strip || !l || !r) return;
    l.disabled = strip.scrollLeft <= 2;
    r.disabled = strip.scrollLeft >= strip.scrollWidth - strip.clientWidth - 2;
  }

  fit() {
    const node = this.node;
    requestAnimationFrame(() => {
      if (!node.graph) return;
      const h = node.computeSize()[1];
      node.setSize([Math.max(node.size[0], 400), Math.max(h, node.size[1])]);
      node.setDirtyCanvas(true, true);
      this.updateNav();
    });
  }
}

app.registerExtension({
  name: "nougan.lora-inspector",

  init() { injectCSS(); },

  async nodeCreated(node) {
    if (node.type !== NODE_TYPE && node.constructor?.comfyClass !== NODE_TYPE) return;

    const panel = new InspectorPanel(node);
    node._nliPanel = panel;

    node.addDOMWidget(WIDGET, "nli_panel", panel.root, {
      getHeight: () => panel.root.offsetHeight + 4,
      serializeValue: async () => panel.lastMeta,
    });

    // Auto-inspect whenever the LoRA dropdown changes (no Queue needed).
    const loraW = node.widgets?.find((w) => w.name === "lora_name");
    if (loraW) {
      const orig = loraW.callback;
      loraW.callback = function (v) {
        const r = orig ? orig.apply(this, arguments) : undefined;
        panel.scheduleInspect();
        return r;
      };
    }

    // Model info + strip re-render immediately when a saved workflow loads.
    if (node.properties?.nli_meta) panel.render(node.properties.nli_meta);
    node.setSize([Math.max(node.size[0], 400), node.size[1]]);
  },
});

// ---------------- websocket events from the python side ----------------

function panelFor(detail) {
  const id = detail?.node;
  if (id == null) return null;
  const n = app.graph?.getNodeById(Number(id)) || app.graph?.getNodeById(String(id));
  return n?._nliPanel || null;
}

api.addEventListener("nougan_lora_inspector/progress", (e) => panelFor(e.detail)?.setProgress(e.detail));
api.addEventListener("nougan_lora_inspector/metadata", (e) => panelFor(e.detail)?.render(e.detail?.payload));
api.addEventListener("nougan_lora_inspector/error",    (e) => panelFor(e.detail)?.setError(e.detail?.message || "unknown error"));