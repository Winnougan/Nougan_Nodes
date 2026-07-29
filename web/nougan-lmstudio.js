/**
 * Nougan LM Studio — frontend half of the bridge.
 *
 * NouganLMStudio console:
 *   · status LED (idle / queued / rendering / streaming / done / error)
 *   · animated progress bar — amber "rendering" phase until the first token
 *     lands, then green streaming (indeterminate when max_tokens = -1)
 *   · tokens/sec + ⚡ first-token latency readout
 *   · streaming tail, model auto-detect (⟳), interrupt (■)
 *   · built-in image strip — click/drop/paste to load, drag the grip to
 *     resize the preview, click it to toggle fit, ⤢ for a full-size lightbox
 *   · INT widget sanitizer — cleared number fields fall back to defaults
 *   · graphToPrompt hook — guarantees the drop-zone image reaches the backend
 *
 * NouganLMStudioPromptBox panel:
 *   · live render of the combined output text (via the `executed` event)
 *   · LINKED / LOCAL chip, char count, one-click copy
 *   · drag grip to resize the output pane (double-click grip to reset)
 */
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

console.log("[Nougan LMS] frontend extension loaded");

const NODE_TYPE   = "NouganLMStudio";
const BOX_TYPE    = "NouganLMStudioPromptBox";
const WS_EVENT    = "nougan_lmstudio_progress";
const BASE_H      = 126;   // console height with no image loaded
const CHROME_H    = 102;   // header + bar + tail + meta row (preview height adds on top)
const BOX_CHROME_H = 48;   // box header row + paddings (output pane height adds on top)
const BOX_OUT_H   = 132;   // default output pane height
const GRIP_MIN    = 48;
const GRIP_MAX    = 480;

/* ── one-time stylesheet ─────────────────────────────────────────────────── */
const CSS = `
.nougan-lms, .lms-box {
  font-family: "JetBrains Mono", "Fira Code", Consolas, monospace;
  background: linear-gradient(180deg, #161b24 0%, #0f1319 100%);
  border: 1px solid #2b3342;
  border-radius: 8px;
  color: #c9d3e0;
  padding: 8px 10px;
  box-sizing: border-box;
  user-select: none;
  box-shadow: inset 0 1px 0 rgba(255,255,255,.04), 0 4px 14px rgba(0,0,0,.35);
}
.lms-row { display: flex; align-items: center; gap: 7px; }
.lms-led { width: 9px; height: 9px; border-radius: 50%; background: #5a6473;
  flex: 0 0 auto; transition: background .25s, box-shadow .25s; }
.lms-led.rend { background: #ffb347; box-shadow: 0 0 8px #ffb347; animation: lmsPulse .7s ease-in-out infinite; }
.lms-led.live { background: #43e08c; box-shadow: 0 0 8px #43e08c; animation: lmsPulse 1.1s ease-in-out infinite; }
.lms-led.done { background: #39c2ff; box-shadow: 0 0 8px #39c2ff; }
.lms-led.err  { background: #ff5d5d; box-shadow: 0 0 8px #ff5d5d; }
@keyframes lmsPulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }
.lms-status { font-size: 10px; letter-spacing: .4px; white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis; flex: 1 1 auto; color: #9fb0c4; }
.lms-tps { font-size: 10px; color: #7fd4ff; white-space: nowrap; }
.lms-btn { font: inherit; font-size: 10px; color: #c9d3e0; background: #1c2330;
  border: 1px solid #33405a; border-radius: 5px; padding: 2px 7px; cursor: pointer;
  transition: background .15s, transform .1s, border-color .15s; }
.lms-btn:hover { background: #27334a; border-color: #4a5f85; }
.lms-btn:active { transform: scale(.94); }
.lms-glyph { display: inline-block; }
.lms-btn.spin .lms-glyph { animation: lmsSpin .8s linear infinite; }
@keyframes lmsSpin { to { transform: rotate(360deg); } }
.lms-track { margin: 7px 0 6px 0; height: 8px; border-radius: 4px; background: #0a0d12;
  border: 1px solid #232b39; overflow: hidden; position: relative; }
.lms-fill { height: 100%; width: 0%; border-radius: 4px; position: relative;
  background: linear-gradient(90deg, #1f8f5f, #43e08c 45%, #39c2ff);
  background-size: 200% 100%; transition: width .18s ease-out; }
.lms-fill.rend { background: linear-gradient(90deg, #8a5a1f, #ffb347 45%, #ffd98a); background-size: 200% 100%; }
.lms-fill::after { content: ""; position: absolute; inset: 0;
  background: linear-gradient(105deg, transparent 30%, rgba(255,255,255,.35) 50%, transparent 70%);
  background-size: 250% 100%; animation: lmsShimmer 1.4s linear infinite; }
@keyframes lmsShimmer { from { background-position: 120% 0; } to { background-position: -120% 0; } }
.lms-fill.indet { width: 38% !important; animation: lmsSlide 1.1s ease-in-out infinite; }
@keyframes lmsSlide { 0% { margin-left: -40%; } 100% { margin-left: 102%; } }
.lms-tail { font-size: 10px; line-height: 1.45; color: #8fa1b8; max-height: 2.9em;
  overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2;
  -webkit-box-orient: vertical; word-break: break-word; }

/* ── media strip ── */
.lms-media { margin-top: 7px; position: relative; }
.lms-drop { border: 1px dashed #3a465c; border-radius: 6px; padding: 8px 6px;
  font-size: 10px; color: #6f7f95; text-align: center; letter-spacing: .4px;
  cursor: pointer; transition: border-color .2s, color .2s, background .2s; }
.lms-drop:hover { border-color: #4a5f85; color: #9fb0c4; }
.lms-media.drag .lms-drop { border-color: #43e08c; color: #43e08c; background: rgba(67,224,140,.07); }
.lms-prev { display: none; width: 100%; height: 64px; object-fit: cover; border-radius: 6px;
  border: 1px solid #2b3342; cursor: pointer; transition: filter .2s; }
.lms-prev:hover { filter: brightness(1.18); }
.lms-prev[data-fit="contain"] { object-fit: contain; background: #0a0d12; }
.lms-grip { display: none; margin: 4px auto 0; width: 46px; height: 5px; border-radius: 3px;
  background: #2b3342; cursor: ns-resize; transition: background .15s, width .15s; }
.lms-grip:hover { background: #4a5f85; width: 62px; }
.lms-box .lms-grip { display: block; }
.lms-meta { display: none; margin-top: 4px; align-items: center; gap: 4px; }
.lms-fname { flex: 1 1 auto; font-size: 9px; color: #7f92aa; white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis; }
.lms-meta .lms-btn { padding: 0 6px; font-size: 10px; line-height: 1.6; }
.lms-media.has-img .lms-prev { display: block; }
.lms-media.has-img .lms-grip { display: block; }
.lms-media.has-img .lms-meta { display: flex; }
.lms-media.has-img .lms-drop { display: none; }

/* ── lightbox ── */
.lms-lightbox { position: fixed; inset: 0; z-index: 9999; display: none; align-items: center;
  justify-content: center; flex-direction: column; gap: 10px; cursor: zoom-out;
  background: rgba(5,8,12,.88); backdrop-filter: blur(4px); }
.lms-lightbox.open { display: flex; animation: lmsFade .18s ease-out; }
@keyframes lmsFade { from { opacity: 0; } to { opacity: 1; } }
.lms-lightbox img { max-width: 92vw; max-height: 84vh; border-radius: 8px;
  border: 1px solid #2b3342; box-shadow: 0 18px 60px rgba(0,0,0,.6);
  animation: lmsZoom .22s cubic-bezier(.2,.9,.3,1.2); }
@keyframes lmsZoom { from { transform: scale(.92); opacity: 0; } to { transform: scale(1); opacity: 1; } }
.lms-lb-name { font-family: "JetBrains Mono", Consolas, monospace; font-size: 11px;
  color: #9fb0c4; letter-spacing: .4px; }

/* ── prompt box panel ── */
.lms-box-out {
  margin-top: 7px; height: 132px; overflow-y: auto; white-space: pre-wrap;
  word-break: break-word; font-size: 10px; line-height: 1.5; color: #aebccb;
  background: #0a0d12; border: 1px solid #232b39; border-radius: 6px; padding: 6px 8px;
  transition: border-color .3s;
}
.lms-box-out::-webkit-scrollbar { width: 6px; }
.lms-box-out::-webkit-scrollbar-thumb { background: #2b3342; border-radius: 3px; }
.lms-box-out::-webkit-scrollbar-thumb:hover { background: #3a465c; }
.lms-box-out.flash { animation: lmsBoxFlash .7s ease-out; }
@keyframes lmsBoxFlash {
  from { border-color: #43e08c; box-shadow: 0 0 12px rgba(67,224,140,.28); }
  to   { border-color: #232b39; box-shadow: none; }
}
.lms-chip { font-size: 9px; padding: 1px 6px; border-radius: 4px; border: 1px solid #33405a;
  color: #7f92aa; letter-spacing: .5px; white-space: nowrap; transition: color .25s, border-color .25s; }
.lms-chip.linked { border-color: #2f6e4d; color: #43e08c; }
.lms-count { font-size: 9px; color: #6f7f95; white-space: nowrap; }
`;

function injectCSS() {
  if (document.getElementById("nougan-lms-css")) return;
  const s = document.createElement("style");
  s.id = "nougan-lms-css";
  s.textContent = CSS;
  document.head.appendChild(s);
}

function setState(ui, state, statusText) {
  ui.led.className = "lms-led " + state;          // idle | rend | live | done | err
  if (statusText) ui.status.textContent = statusText;
}

function refreshSize(node) {
  const s = node.computeSize();
  node.setSize([Math.max(node.size[0], s[0]), Math.max(node.size[1], s[1])]);
  app.graph.setDirtyCanvas(true, true);
}

function previewURL(meta) {
  const url =
    `/view?filename=${encodeURIComponent(meta.name)}` +
    `&subfolder=${encodeURIComponent(meta.subfolder || "")}` +
    `&type=${encodeURIComponent(meta.type || "input")}` +
    `&t=${Date.now()}`;
  return typeof api.apiURL === "function" ? api.apiURL(url) : url;
}

/* ── guarantee embedded_image reaches the backend ──────────────────────────
   Hidden widgets aren't always serialized into the API prompt, so inject
   the drop-zone value directly at prompt-build time. Works on every
   frontend version. */
let promptHooked = false;
function hookGraphToPrompt() {
  if (promptHooked || typeof app.graphToPrompt !== "function") return;
  promptHooked = true;
  const orig = app.graphToPrompt.bind(app);
  app.graphToPrompt = async function () {
    const res = await orig();
    try {
      for (const [id, entry] of Object.entries(res.output || {})) {
        if (!entry || entry.class_type !== NODE_TYPE) continue;
        const real = app.graph.getNodeById(Number(id));
        const w = real && real.widgets && real.widgets.find(x => x.name === "embedded_image");
        if (w) {
          entry.inputs = entry.inputs || {};
          entry.inputs.embedded_image = w.value || "";
        }
      }
    } catch (e) {
      console.warn("[Nougan LMS] graphToPrompt injection failed:", e);
    }
    return res;
  };
}

/* ── full-size lightbox (singleton) ──────────────────────────────────────── */
let lightbox = null;
function getLightbox() {
  if (lightbox) return lightbox;
  const el = document.createElement("div");
  el.className = "lms-lightbox";
  el.innerHTML = `<img alt="" /><div class="lms-lb-name"></div>`;
  el.addEventListener("click", () => el.classList.remove("open"));
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") el.classList.remove("open");
  });
  document.body.appendChild(el);
  lightbox = { el, img: el.querySelector("img"), name: el.querySelector(".lms-lb-name") };
  return lightbox;
}

/* ── shared grip drag (used by image preview + box output pane) ──────────── */
function wireGrip(ui, grip, el, getH, setH, onDone) {
  grip.addEventListener("mousedown", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const startY = ev.clientY;
    const startH = getH();
    let raf = 0;
    const onMove = (me) => {
      const h = Math.max(GRIP_MIN, Math.min(GRIP_MAX, startH + (me.clientY - startY)));
      setH(h);
      el.style.height = h + "px";
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; refreshSize(ui.node); });
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (onDone) onDone(getH());
      refreshSize(ui.node);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });
  grip.addEventListener("dblclick", () => {
    setH(null);                                   // null → caller resets to default
    if (onDone) onDone(null);
    refreshSize(ui.node);
  });
}

/* ── embedded image plumbing (shared by picker / drop / paste) ───────────── */
function applyEmbedded(ui, meta) {
  const w = ui.node.widgets.find(x => x.name === "embedded_image");
  if (w) w.value = JSON.stringify(meta);
  ui.prev.src = previewURL(meta);
  ui.prev.style.height = ui.prevH + "px";
  ui.fname.textContent = meta.name;
  ui.media.classList.add("has-img");
  refreshSize(ui.node);
  ui.node.setDirtyCanvas(true, true);
}

function persistHeight(ui) {
  const w = ui.node.widgets.find(x => x.name === "embedded_image");
  if (!w || !w.value) return;
  try {
    const meta = JSON.parse(w.value);
    if (ui.prevH != null) meta.h = ui.prevH; else delete meta.h;
    w.value = JSON.stringify(meta);
  } catch (_) {}
}

async function uploadEmbedded(ui, file, label) {
  try {
    ui.status.textContent = "UPLOADING · " + (label || file.name);
    const fd = new FormData();
    fd.append("image", file, (file && file.name) || "pasted.png");
    fd.append("overwrite", "true");
    fd.append("subfolder", "nougan_lms");
    fd.append("type", "input");
    const res = await api.fetchApi("/upload/image", { method: "POST", body: fd });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const meta = await res.json();                // {name, subfolder, type}
    applyEmbedded(ui, meta);
    setState(ui, "done", "IMAGE LOADED · " + meta.name);
  } catch (e) {
    setState(ui, "err", "UPLOAD FAILED · " + String(e).slice(0, 50));
  }
}

function clearEmbedded(ui) {
  const w = ui.node.widgets.find(x => x.name === "embedded_image");
  if (w) w.value = "";
  ui.media.classList.remove("has-img");
  ui.prev.removeAttribute("src");
  ui.fname.textContent = "";
  refreshSize(ui.node);
  ui.node.setDirtyCanvas(true, true);
}

/* hover-to-paste: only intercepts while the pointer is over a panel */
let hoverUI = null;
document.addEventListener("paste", (ev) => {
  const t = ev.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
  if (!hoverUI) return;
  const items = (ev.clipboardData && ev.clipboardData.items) || [];
  const item = Array.from(items).find(i => i.type.startsWith("image/"));
  if (item) { ev.preventDefault(); uploadEmbedded(hoverUI, item.getAsFile(), "pasted image"); }
});

/* ── main node panel builder ─────────────────────────────────────────────── */
function buildPanel(node) {
  const root = document.createElement("div");
  root.className = "nougan-lms";
  root.innerHTML = `
    <div class="lms-row">
      <span class="lms-led idle"></span>
      <span class="lms-status">IDLE · waiting for prompt</span>
      <span class="lms-tps"></span>
      <button class="lms-btn lms-sync" title="Auto-detect models from LM Studio"><span class="lms-glyph">⟳</span> models</button>
      <button class="lms-btn lms-stop" title="Interrupt generation">■</button>
    </div>
    <div class="lms-track"><div class="lms-fill"></div></div>
    <div class="lms-tail">—</div>
    <div class="lms-media">
      <div class="lms-drop">🖼 drop · click · paste an image</div>
      <img class="lms-prev" alt="" draggable="false"
           title="Click: toggle fit · Double-click: replace" />
      <div class="lms-grip" title="Drag to resize · Double-click to reset"></div>
      <div class="lms-meta">
        <span class="lms-fname"></span>
        <button class="lms-btn lms-expand" title="View full size">⤢</button>
        <button class="lms-btn lms-clear" title="Remove image">✕</button>
      </div>
      <input type="file" class="lms-file" accept="image/*" style="display:none" />
    </div>`;

  const ui = {
    node, root,
    led:    root.querySelector(".lms-led"),
    status: root.querySelector(".lms-status"),
    tps:    root.querySelector(".lms-tps"),
    fill:   root.querySelector(".lms-fill"),
    tail:   root.querySelector(".lms-tail"),
    sync:   root.querySelector(".lms-sync"),
    stop:   root.querySelector(".lms-stop"),
    media:  root.querySelector(".lms-media"),
    drop:   root.querySelector(".lms-drop"),
    prev:   root.querySelector(".lms-prev"),
    grip:   root.querySelector(".lms-grip"),
    fname:  root.querySelector(".lms-fname"),
    expand: root.querySelector(".lms-expand"),
    clear:  root.querySelector(".lms-clear"),
    file:   root.querySelector(".lms-file"),
    t0: 0, first: false, ttft: null,
    prevH: 64,                                    // live preview height
  };

  /* drop strip → file picker */
  ui.drop.addEventListener("click", () => ui.file.click());

  /* preview: click = toggle cover/contain · double-click = replace */
  ui.prev.addEventListener("click", (ev) => {
    ev.stopPropagation();
    ui.prev.dataset.fit = ui.prev.dataset.fit === "contain" ? "cover" : "contain";
  });
  ui.prev.addEventListener("dblclick", (ev) => {
    ev.stopPropagation();
    ui.file.click();
  });

  /* ⤢ → full-size lightbox */
  ui.expand.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const lb = getLightbox();
    lb.img.src = ui.prev.src;
    lb.name.textContent = ui.fname.textContent;
    lb.el.classList.add("open");
  });

  /* ✕ → remove */
  ui.clear.addEventListener("click", (ev) => { ev.stopPropagation(); clearEmbedded(ui); });

  /* grip → drag-resize the preview (node grows/shrinks live) */
  wireGrip(ui, ui.grip, ui.prev,
    () => ui.prevH,
    (h) => { ui.prevH = (h == null) ? 64 : h; },
    () => persistHeight(ui)
  );

  ui.file.addEventListener("change", () => {
    if (ui.file.files && ui.file.files[0]) uploadEmbedded(ui, ui.file.files[0]);
    ui.file.value = "";
  });

  /* drag & drop anywhere on the panel (also swaps an existing preview) */
  root.addEventListener("dragover", (ev) => { ev.preventDefault(); ui.media.classList.add("drag"); });
  root.addEventListener("dragleave", () => ui.media.classList.remove("drag"));
  root.addEventListener("drop", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    ui.media.classList.remove("drag");
    const f = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
    if (f && f.type.startsWith("image/")) uploadEmbedded(ui, f);
  });

  /* track hover for the global paste handler */
  root.addEventListener("pointerenter", () => { hoverUI = ui; });
  root.addEventListener("pointerleave", () => { if (hoverUI === ui) hoverUI = null; });

  /* ⟳ — fetch /v1/models, cycle model_name on repeat clicks */
  ui.sync.addEventListener("click", async () => {
    const urlW   = node.widgets.find(w => w.name === "server_url");
    const modelW = node.widgets.find(w => w.name === "model_name");
    const base   = ((urlW && urlW.value) || "http://127.0.0.1:1234").replace(/\/+$/, "");
    ui.sync.classList.add("spin");
    let names = [];
    try {                                          // LM Studio ships CORS on
      const r = await fetch(base + "/v1/models");
      names = ((await r.json()).data || []).map(m => m.id).filter(Boolean);
    } catch (_) {
      try {                                        // fallback: ComfyUI proxy route
        const r2 = await fetch("/nougan/lmstudio/models?base=" + encodeURIComponent(base));
        names = (await r2.json()).models || [];
      } catch (_) {}
    }
    ui.sync.classList.remove("spin");
    if (!names.length) { setState(ui, "err", "NO MODELS · is the dev server up?"); return; }
    const i = names.indexOf(modelW.value);
    modelW.value = names[(i + 1) % names.length];
    setState(ui, "done", names.length + " MODEL" + (names.length > 1 ? "S" : "") + " · " + modelW.value);
    node.setDirtyCanvas(true, true);
  });

  /* ■ — hard interrupt */
  ui.stop.addEventListener("click", () => api.interrupt());

  return ui;
}

/* ── prompt box panel builder ────────────────────────────────────────────── */
function updateBoxChip(ui) {
  const inp = ui.node.inputs && ui.node.inputs.find(i => i.name === "prompt_in");
  const linked = !!(inp && inp.link != null);
  ui.chip.textContent = linked ? "LINKED" : "LOCAL";
  ui.chip.classList.toggle("linked", linked);
}

function renderBoxText(ui, text) {
  ui.text = text || "";
  ui.out.textContent = ui.text || "—";
  ui.count.textContent = ui.text.length + " ch";
  ui.out.classList.remove("flash");
  void ui.out.offsetWidth;                        // restart the flash animation
  ui.out.classList.add("flash");
  setState(ui, "done", "PROMPT BOX · output ready");
}

function buildBoxPanel(node) {
  const root = document.createElement("div");
  root.className = "lms-box";
  root.innerHTML = `
    <div class="lms-row">
      <span class="lms-led idle"></span>
      <span class="lms-status">PROMPT BOX · idle</span>
      <span class="lms-chip">LOCAL</span>
      <span class="lms-count"></span>
      <button class="lms-btn lms-copy" title="Copy output to clipboard">⧉ copy</button>
    </div>
    <div class="lms-box-out">—</div>
    <div class="lms-grip" title="Drag to resize · Double-click to reset"></div>`;

  const ui = {
    node, root,
    led:    root.querySelector(".lms-led"),
    status: root.querySelector(".lms-status"),
    chip:   root.querySelector(".lms-chip"),
    count:  root.querySelector(".lms-count"),
    copy:   root.querySelector(".lms-copy"),
    out:    root.querySelector(".lms-box-out"),
    grip:   root.querySelector(".lms-grip"),
    text: "",
    outH: BOX_OUT_H,
  };

  /* restore saved pane height (rides along in the workflow via node.properties) */
  const saved = node.properties && node.properties.lms_box_h;
  if (saved && saved >= GRIP_MIN && saved <= GRIP_MAX) {
    ui.outH = saved;
    ui.out.style.height = saved + "px";
  }

  /* grip → drag-resize the output pane (node grows/shrinks live) */
  wireGrip(ui, ui.grip, ui.out,
    () => ui.outH,
    (h) => { ui.outH = (h == null) ? BOX_OUT_H : h; },
    (h) => {
      node.properties = node.properties || {};
      if (h != null) node.properties.lms_box_h = h;
      else delete node.properties.lms_box_h;
    }
  );

  ui.copy.addEventListener("click", async () => {
    if (!ui.text) return;
    try {
      await navigator.clipboard.writeText(ui.text);
      const old = ui.copy.textContent;
      ui.copy.textContent = "✓ copied";
      setTimeout(() => { ui.copy.textContent = old; }, 900);
    } catch (_) {
      setState(ui, "err", "COPY FAILED");
    }
  });

  updateBoxChip(ui);
  return ui;
}

/* ── websocket wiring (once) ─────────────────────────────────────────────── */
let wired = false;
function wireEvents() {
  if (wired) return;
  wired = true;
  hookGraphToPrompt();

  /* whole queue started → mark every bridge node as queued */
  api.addEventListener("execution_start", () => {
    for (const n of app.graph.nodes) {
      if (n._lms) {
        n._lms.fill.style.width = "0%";
        n._lms.fill.classList.add("indet", "rend");
        n._lms.tps.textContent = "";
        setState(n._lms, "rend", "QUEUED · waiting for executor…");
      }
      if (n._lmsBox) setState(n._lmsBox, "rend", "PROMPT BOX · queued…");
    }
  });

  /* Prompt Box output arrives via the standard `executed` event (ui payload) */
  api.addEventListener("executed", (e) => {
    const d = e.detail || {};
    const node = app.graph.getNodeById(Number(d.node));
    if (!node || !node._lmsBox) return;
    const text = d.output && d.output.text && d.output.text[0];
    if (text != null) renderBoxText(node._lmsBox, text);
  });

  api.addEventListener(WS_EVENT, (e) => {
    const d = e.detail || {};
    const node = app.graph.getNodeById(Number(d.node));
    if (!node || !node._lms) return;
    const ui = node._lms;

    switch (d.state) {
      case "start": {
        ui.t0 = performance.now();
        ui.first = false;
        ui.ttft = null;
        ui.fill.style.width = "0%";
        ui.fill.classList.add("indet", "rend");   // amber "rendering" until 1st token
        const m = d.media || {};
        setState(ui, "rend",
          "RENDERING · " + (d.model || "model") +
          " · 🖼 " + (m.image || 0) + "  🎞 " + (m.video || 0) + "  🎧 " + (m.audio || 0));
        break;
      }
      case "stream": {
        if (!ui.first) {                          // first token just landed
          ui.first = true;
          ui.ttft = ((performance.now() - ui.t0) / 1000).toFixed(2);
          ui.fill.classList.remove("rend");
          if (d.max_tokens) ui.fill.classList.remove("indet");
        }
        const el = (performance.now() - ui.t0) / 1000;
        ui.tps.textContent = el > 0.3
          ? (d.tokens / el).toFixed(1) + " tok/s · ⚡" + ui.ttft + "s"
          : "⚡" + ui.ttft + "s";
        if (d.max_tokens) {
          ui.fill.style.width = Math.min(100, (d.tokens / d.max_tokens) * 100) + "%";
        }
        if (d.tail) ui.tail.textContent = d.tail;
        setState(ui, "live", "STREAMING · " + d.tokens + (d.max_tokens ? "/" + d.max_tokens : "") + " tok");
        break;
      }
      case "done":
        ui.fill.style.width = "100%";
        ui.fill.classList.remove("indet", "rend");
        if (d.tail) ui.tail.textContent = d.tail;
        setState(ui, "done", "DONE · " + d.tokens + " tok · " + d.elapsed + "s");
        break;
      case "error":
        ui.fill.classList.remove("indet", "rend");
        setState(ui, "err", "ERROR · " + String(d.error || "unknown").slice(0, 60));
        break;
    }
  });
}

/* ── extension entry ─────────────────────────────────────────────────────── */
app.registerExtension({
  name: "Nougan.LMStudio.Bridge",

  async nodeCreated(node) {
    try {
      const title = (node.constructor && node.constructor.title) ? String(node.constructor.title) : "";

      /* ── Prompt Box companion panel ── */
      if (node.type === BOX_TYPE || title.indexOf("Prompt Box") !== -1) {
        console.log("[Nougan LMS] attaching output panel to Prompt Box", node.id);
        injectCSS();
        wireEvents();

        const ui = buildBoxPanel(node);
        node._lmsBox = ui;

        /* keep the LINKED/LOCAL chip honest when wires change */
        const orig = node.onConnectionsChange;
        node.onConnectionsChange = function () {
          if (orig) orig.apply(this, arguments);
          updateBoxChip(ui);
        };

        node.addDOMWidget("lms_box_out", "lms_box_out", ui.root, {
          getHeight: () => BOX_CHROME_H + ui.outH,   // grows live while dragging the grip
        });
        refreshSize(node);
        return;
      }

      /* ── main LM Studio console ── */
      const isOurs = node.type === NODE_TYPE ||
        (title.indexOf("Nougan LM Studio") !== -1);
      if (!isOurs) return;

      console.log("[Nougan LMS] attaching console to node", node.id, "(" + node.type + ")");
      injectCSS();
      wireEvents();

      const ui = buildPanel(node);
      node._lms = ui;

      /* ── INT sanitizer: empty fields fall back to defaults at queue time ── */
      const INT_DEFAULTS = { video_frames: 8, max_tokens: 512, seed: 0 };
      for (const [name, def] of Object.entries(INT_DEFAULTS)) {
        const w = node.widgets.find(x => x.name === name);
        if (!w) continue;
        w.serializeValue = async () => {
          const n = parseInt(w.value, 10);
          if (!Number.isFinite(n)) { w.value = def; return def; }
          return n;
        };
      }

      /* restore preview + its saved height after graph reload */
      const w = node.widgets.find(x => x.name === "embedded_image");
      if (w && w.value) {
        try {
          const meta = JSON.parse(w.value);
          if (meta.h) { ui.prevH = meta.h; ui.prev.style.height = ui.prevH + "px"; }
          ui.prev.src = previewURL(meta);
          ui.fname.textContent = meta.name;
          ui.media.classList.add("has-img");
        } catch (_) {}
      }

      node.addDOMWidget("lms_console", "lms_console", ui.root, {
        getHeight: () => ui.media.classList.contains("has-img")
          ? (CHROME_H + ui.prevH)                 // grows live while dragging the grip
          : BASE_H,
      });

      if (ui.media.classList.contains("has-img")) refreshSize(node);
    } catch (err) {
      console.error("[Nougan LMS] nodeCreated failed:", err);
    }
  },
});