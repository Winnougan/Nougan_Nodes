// web/load_nougan_video.js — visual crop & trim editor for NouganLoadVideo.
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE = "NouganLoadVideo";
const ACCENT = "#a855f7";
const MIN_CROP_PX = 16;
const PREVIEW_ENDPOINT = "/nougan/load_video/preview";

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

const ASPECTS = [
  ["Free", null],
  ["Source", "src"],
  ["16:9", 16 / 9],
  ["9:16", 9 / 16],
  ["4:3", 4 / 3],
  ["3:4", 3 / 4],
  ["1:1", 1],
  ["21:9", 21 / 9],
];

const WATCH_WIDGETS = [
  "video", "start_frame", "end_frame",
  "crop_x", "crop_y", "crop_w", "crop_h",
  "resize_mode", "size", "size_h", "multiple_of",
  "resize_method", "frame_rule", "snap_from", "max_frames", "target_fps",
];

const CSS = `
.nlv{display:flex;flex-direction:column;gap:6px;width:100%;height:100%;box-sizing:border-box;padding:4px;
  font:12px/1.35 system-ui,-apple-system,Segoe UI,sans-serif;color:var(--input-text,#ddd);outline:none;user-select:none}
.nlv *{box-sizing:border-box}
.nlv-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.nlv-grow{flex:1 1 auto;min-width:0}
.nlv-btn,.nlv select{background:var(--comfy-input-bg,#2a2a31);color:var(--input-text,#ddd);
  border:1px solid var(--border-color,#4a4a55);border-radius:5px;padding:3px 7px;font:inherit;cursor:pointer}
.nlv-btn:hover,.nlv select:hover{border-color:${ACCENT}}
.nlv-btn.on{background:${ACCENT};border-color:${ACCENT};color:#fff}
.nlv-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.9}
.nlv-dim{opacity:.72;font-size:11px;white-space:nowrap}
.nlv-stage{position:relative;flex:1 1 auto;min-height:175px;background:#08080b;border-radius:6px;
  overflow:hidden;touch-action:none;cursor:crosshair}
.nlv-stage.drop{outline:2px dashed ${ACCENT};outline-offset:-4px}
.nlv-video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;pointer-events:none;background:#000}
.nlv-msg{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;
  padding:16px;color:#b8b8c6;pointer-events:none;white-space:pre-line}
.nlv-crop{position:absolute;border:1.5px solid ${ACCENT};box-shadow:0 0 0 9999px rgba(0,0,0,.55);
  cursor:move;touch-action:none}
.nlv-crop::before{content:"";position:absolute;inset:0;pointer-events:none;
  background:linear-gradient(to right,transparent 33.2%,rgba(255,255,255,.28) 33.3%,transparent 33.5%,transparent 66.5%,rgba(255,255,255,.28) 66.6%,transparent 66.8%),
  linear-gradient(to bottom,transparent 33.2%,rgba(255,255,255,.28) 33.3%,transparent 33.5%,transparent 66.5%,rgba(255,255,255,.28) 66.6%,transparent 66.8%)}
.nlv-crop.full{border-color:rgba(255,255,255,.25);box-shadow:none}
.nlv-crop.full::before{display:none}
.nlv-handle{position:absolute;width:10px;height:10px;background:#fff;border:1.5px solid ${ACCENT};border-radius:2px}
.nlv-handle.nw{top:-5px;left:-5px;cursor:nwse-resize}
.nlv-handle.ne{top:-5px;right:-5px;cursor:nesw-resize}
.nlv-handle.sw{bottom:-5px;left:-5px;cursor:nesw-resize}
.nlv-handle.se{bottom:-5px;right:-5px;cursor:nwse-resize}
.nlv-trim{position:relative;height:26px;background:#1b1b22;border:1px solid var(--border-color,#454552);
  border-radius:6px;cursor:pointer;touch-action:none}
.nlv-trim-range{position:absolute;top:2px;bottom:2px;background:rgba(168,85,247,.28);
  border-top:2px solid ${ACCENT};border-bottom:2px solid ${ACCENT}}
.nlv-trim-play{position:absolute;top:0;bottom:0;width:2px;background:#fff;pointer-events:none}
.nlv-btn.primary{background:${ACCENT};border-color:${ACCENT};color:#fff;font-weight:600}
.nlv-btn.stale{animation:nlvpulse 1.4s ease-in-out infinite}
.nlv-btn:disabled{opacity:.55;cursor:default;animation:none}
@keyframes nlvpulse{0%,100%{box-shadow:0 0 0 0 rgba(168,85,247,0)}50%{box-shadow:0 0 0 3px rgba(168,85,247,.5)}}
.nlv-prev{position:relative;flex:0 0 auto;height:190px;background:#08080b;border-radius:6px;overflow:hidden}
.nlv-prev video{display:block;width:100%;height:100%;object-fit:contain;background:#000}
.nlv-t-handle{position:absolute;top:0;bottom:0;width:10px;margin-left:-5px;background:${ACCENT};
  border-radius:3px;cursor:ew-resize;display:flex;align-items:center;justify-content:center;color:#fff;font-size:10px}
`;

function ensureStyles() {
  if (document.getElementById("nougan-load-video-css")) return;
  const el = document.createElement("style");
  el.id = "nougan-load-video-css";
  el.textContent = CSS;
  document.head.appendChild(el);
}

function getWidget(node, name) {
  return (node.widgets || []).find((w) => w.name === name) || null;
}

function setWidgetValue(node, name, val, silent = false) {
  const w = getWidget(node, name);
  if (!w) return;
  if (w.value === val) return;
  w.value = val;
  if (!silent && typeof w.callback === "function") {
    w.callback(val);
  }
}

// Fire the (hooked) callbacks once after a drag that wrote values silently.
function commitWidgets(node, names) {
  for (const n of names) {
    const w = getWidget(node, n);
    if (w && typeof w.callback === "function") w.callback(w.value);
  }
  node.setDirtyCanvas?.(true, true);
}

const CROP_WIDGETS = ["crop_x", "crop_y", "crop_w", "crop_h"];
const TRIM_WIDGETS = ["start_frame", "end_frame"];

function buildViewUrl(filename) {
  if (!filename) return "";
  const match = /^(.*?)\s*\[(input|output|temp)\]$/.exec(filename.trim());
  const raw = match ? match[1] : filename;
  const folderType = match ? match[2] : "input";
  const parts = raw.replace(/\\/g, "/").split("/");
  const file = parts.pop();
  const subfolder = parts.join("/");
  const qs = new URLSearchParams({ filename: file, type: folderType });
  if (subfolder) qs.set("subfolder", subfolder);
  return api.apiURL(`/view?${qs.toString()}`);
}

function installEditor(node) {
  if (node._nlvInstalled) return;
  node._nlvInstalled = true;
  ensureStyles();

  const state = {
    aspectKey: "Free",
    aspectVal: null,
    plan: null,
    srcW: 1920,
    srcH: 1080,
    totalFrames: 1,
    fps: 24,
    draggingCrop: null, // { mode: 'move' | 'draw' | 'nw' | 'ne' | 'sw' | 'se', startX, startY, orig }
    draggingTrim: null, // 'start' | 'end' | 'scrub'
    planTimer: null,
    planSeq: 0,
    loadedName: null,
    previewBusy: false,
    renderedKey: null,
  };

  const root = document.createElement("div");
  root.className = "nlv";
  root.tabIndex = 0;

  // Row 1: file load + status
  const rowFile = document.createElement("div");
  rowFile.className = "nlv-row";

  const btnLoad = document.createElement("button");
  btnLoad.type = "button";
  btnLoad.className = "nlv-btn";
  btnLoad.textContent = "Load…";

  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = "video/*";
  fileInput.style.display = "none";

  const lblName = document.createElement("span");
  lblName.className = "nlv-name nlv-grow";
  lblName.textContent = "No video";

  const lblPlan = document.createElement("span");
  lblPlan.className = "nlv-dim";
  lblPlan.textContent = "";

  rowFile.append(btnLoad, fileInput, lblName, lblPlan);

  // Row 2: aspect ratio presets + reset
  const rowAspect = document.createElement("div");
  rowAspect.className = "nlv-row";

  const aspectButtons = [];
  for (const [label, ratio] of ASPECTS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "nlv-btn";
    b.textContent = label;
    if (label === "Free") b.classList.add("on");
    b.addEventListener("click", () => {
      state.aspectKey = label;
      state.aspectVal = ratio;
      for (const btn of aspectButtons) btn.classList.toggle("on", btn === b);
      applyAspectLock();
      syncCropOverlay();
      schedulePlan();
    });
    aspectButtons.push(b);
    rowAspect.appendChild(b);
  }

  const btnResetCrop = document.createElement("button");
  btnResetCrop.type = "button";
  btnResetCrop.className = "nlv-btn";
  btnResetCrop.textContent = "Reset Crop";
  btnResetCrop.addEventListener("click", () => {
    for (const n of CROP_WIDGETS) setWidgetValue(node, n, 0);
    syncCropOverlay();
    schedulePlan();
  });
  rowAspect.appendChild(btnResetCrop);

  // Stage: HTML5 <video> + crop box
  const stage = document.createElement("div");
  stage.className = "nlv-stage";

  const video = document.createElement("video");
  video.className = "nlv-video";
  video.muted = true;
  video.playsInline = true;

  const msg = document.createElement("div");
  msg.className = "nlv-msg";
  msg.textContent = "Select or drop a video file";

  const cropBox = document.createElement("div");
  cropBox.className = "nlv-crop full";

  for (const dir of ["nw", "ne", "sw", "se"]) {
    const h = document.createElement("div");
    h.className = `nlv-handle ${dir}`;
    h.dataset.dir = dir;
    cropBox.appendChild(h);
  }

  stage.append(video, cropBox, msg);

  // Trim bar
  const trimBar = document.createElement("div");
  trimBar.className = "nlv-trim";

  const trimRange = document.createElement("div");
  trimRange.className = "nlv-trim-range";

  const trimPlay = document.createElement("div");
  trimPlay.className = "nlv-trim-play";

  const hStart = document.createElement("div");
  hStart.className = "nlv-t-handle";
  hStart.textContent = "[";

  const hEnd = document.createElement("div");
  hEnd.className = "nlv-t-handle";
  hEnd.textContent = "]";

  trimBar.append(trimRange, trimPlay, hStart, hEnd);

  // Row 3: transport + frame readout
  const rowTransport = document.createElement("div");
  rowTransport.className = "nlv-row";

  const btnPlay = document.createElement("button");
  btnPlay.type = "button";
  btnPlay.className = "nlv-btn";
  btnPlay.textContent = "Play";
  btnPlay.addEventListener("click", () => {
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  });

  const lblFrames = document.createElement("span");
  lblFrames.className = "nlv-dim nlv-grow";
  lblFrames.textContent = "Frames: 0..0";

  const btnUpdate = document.createElement("button");
  btnUpdate.type = "button";
  btnUpdate.className = "nlv-btn primary";
  btnUpdate.textContent = "⟳ Update";
  btnUpdate.title = "Render the cropped / trimmed / resized result into the preview below";
  btnUpdate.addEventListener("click", () => renderPreview());

  rowTransport.append(btnPlay, lblFrames, btnUpdate);

  // Result preview (rendered by the backend so it matches what the node outputs)
  const rowPrev = document.createElement("div");
  rowPrev.className = "nlv-row";
  const lblPrev = document.createElement("span");
  lblPrev.className = "nlv-dim nlv-grow";
  lblPrev.textContent = "Result preview";
  rowPrev.appendChild(lblPrev);

  const prevBox = document.createElement("div");
  prevBox.className = "nlv-prev";
  const prevVideo = document.createElement("video");
  prevVideo.muted = true;
  prevVideo.loop = true;
  prevVideo.controls = true;
  prevVideo.playsInline = true;
  const prevMsg = document.createElement("div");
  prevMsg.className = "nlv-msg";
  prevMsg.textContent = "Press “Update” to render the cropped / trimmed result";
  prevBox.append(prevVideo, prevMsg);

  root.append(rowFile, rowAspect, stage, trimBar, rowTransport, rowPrev, prevBox);

  // The node lives inside a CSS-scaled canvas layer, so getBoundingClientRect() is in screen px while
  // style.left/top/width/height are in unscaled layout px. Everything below works in layout px and
  // converts pointer events through the scale factor, otherwise the overlay drifts as soon as you zoom.
  function eventToStage(e) {
    const r = stage.getBoundingClientRect();
    const lw = stage.clientWidth || 1;
    const lh = stage.clientHeight || 1;
    return {
      x: (e.clientX - r.left) / (r.width / lw || 1),
      y: (e.clientY - r.top) / (r.height / lh || 1),
    };
  }

  function getMediaRect() {
    const sw = stage.clientWidth || 1;
    const sh = stage.clientHeight || 1;
    const vw = state.srcW || video.videoWidth || 16;
    const vh = state.srcH || video.videoHeight || 9;
    const scale = Math.min(sw / vw, sh / vh);
    const dw = vw * scale;
    const dh = vh * scale;
    return { left: (sw - dw) * 0.5, top: (sh - dh) * 0.5, width: dw, height: dh, vw, vh };
  }

  function stageToSrc(p, mr) {
    return {
      x: ((p.x - mr.left) / Math.max(1, mr.width)) * mr.vw,
      y: ((p.y - mr.top) / Math.max(1, mr.height)) * mr.vh,
    };
  }

  function currentCropPx() {
    const vw = state.srcW || 1920;
    const vh = state.srcH || 1080;
    const x = Math.max(0, Math.min(vw - 1, Number(getWidget(node, "crop_x")?.value || 0)));
    const y = Math.max(0, Math.min(vh - 1, Number(getWidget(node, "crop_y")?.value || 0)));
    let w = Number(getWidget(node, "crop_w")?.value || 0);
    let h = Number(getWidget(node, "crop_h")?.value || 0);
    if (w <= 0) w = vw - x;
    if (h <= 0) h = vh - y;
    w = Math.max(MIN_CROP_PX, Math.min(vw - x, w));
    h = Math.max(MIN_CROP_PX, Math.min(vh - y, h));
    return { x, y, w, h, vw, vh };
  }

  function writeCropPx(x, y, w, h, vw, vh, silent = false) {
    const cx = Math.max(0, Math.min(vw - MIN_CROP_PX, Math.round(x)));
    const cy = Math.max(0, Math.min(vh - MIN_CROP_PX, Math.round(y)));
    const cw = Math.max(MIN_CROP_PX, Math.min(vw - cx, Math.round(w)));
    const ch = Math.max(MIN_CROP_PX, Math.min(vh - cy, Math.round(h)));
    const isFull = cx === 0 && cy === 0 && cw === vw && ch === vh;
    setWidgetValue(node, "crop_x", cx, silent);
    setWidgetValue(node, "crop_y", cy, silent);
    setWidgetValue(node, "crop_w", isFull ? 0 : cw, silent);
    setWidgetValue(node, "crop_h", isFull ? 0 : ch, silent);
    if (silent) markStale();
  }

  function resolvedAspectRatio() {
    const vw = state.srcW || 1920;
    const vh = state.srcH || 1080;
    if (state.aspectKey === "Free" || !state.aspectVal) return null;
    if (state.aspectKey === "Source") return vw / Math.max(1, vh);
    return state.aspectVal;
  }

  function applyAspectLock() {
    const ratio = resolvedAspectRatio();
    if (!ratio) return;
    const { x, y, w, h, vw, vh } = currentCropPx();
    let nw = w;
    let nh = Math.round(nw / ratio);
    if (nh > h) {
      nh = h;
      nw = Math.round(nh * ratio);
    }
    nw = Math.max(MIN_CROP_PX, Math.min(vw, nw));
    nh = Math.max(MIN_CROP_PX, Math.min(vh, nh));
    writeCropPx(x + (w - nw) / 2, y + (h - nh) / 2, nw, nh, vw, vh);
  }

  function syncCropOverlay() {
    const mr = getMediaRect();
    const c = currentCropPx();
    const left = mr.left + (c.x / c.vw) * mr.width;
    const top = mr.top + (c.y / c.vh) * mr.height;
    const width = (c.w / c.vw) * mr.width;
    const height = (c.h / c.vh) * mr.height;
    cropBox.style.left = `${left.toFixed(1)}px`;
    cropBox.style.top = `${top.toFixed(1)}px`;
    cropBox.style.width = `${Math.max(4, width).toFixed(1)}px`;
    cropBox.style.height = `${Math.max(4, height).toFixed(1)}px`;
    const isFull = c.x === 0 && c.y === 0 && c.w === c.vw && c.h === c.vh;
    cropBox.classList.toggle("full", isFull);
  }

  function syncTrimBar() {
    const total = Math.max(1, state.totalFrames);
    const s = Math.max(0, Math.min(total - 1, Number(getWidget(node, "start_frame")?.value || 0)));
    const rawEnd = Number(getWidget(node, "end_frame")?.value || 0);
    const e = rawEnd <= 0 || rawEnd > total ? total : Math.max(s + 1, rawEnd);

    const pStart = (s / total) * 100;
    const pEnd = (e / total) * 100;
    trimRange.style.left = `${pStart}%`;
    trimRange.style.width = `${Math.max(0.5, pEnd - pStart)}%`;
    hStart.style.left = `${pStart}%`;
    hEnd.style.left = `${pEnd}%`;

    const curF = Math.max(0, Math.min(total, Math.round((video.currentTime || 0) * state.fps)));
    trimPlay.style.left = `${(curF / total) * 100}%`;

    const outF = state.plan ? state.plan.output_frames : (e - s);
    const outW = state.plan ? state.plan.output_width : currentCropPx().w;
    const outH = state.plan ? state.plan.output_height : currentCropPx().h;
    lblFrames.textContent = `Trim ${s}..${e} → ${outF}f (${outW}×${outH})`;
  }

  function payloadFromWidgets() {
    const payload = {};
    for (const k of WATCH_WIDGETS) {
      const w = getWidget(node, k);
      if (w) payload[k] = w.value;
    }
    return payload;
  }

  function markStale() {
    const name = getWidget(node, "video")?.value;
    const stale = !!name && state.renderedKey !== JSON.stringify(payloadFromWidgets());
    btnUpdate.classList.toggle("stale", stale && !state.previewBusy);
    if (state.renderedKey && stale && !state.previewBusy) lblPrev.textContent = "Result preview — out of date, press Update";
  }

  async function refreshPlan() {
    const videoName = getWidget(node, "video")?.value || "";
    if (!videoName) {
      msg.textContent = "Select or drop a video file";
      return;
    }
    lblName.textContent = videoName;

    const seq = ++state.planSeq;
    try {
      const resp = await api.fetchApi("/nougan/load_video/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payloadFromWidgets()),
      });
      const data = await resp.json();
      if (seq !== state.planSeq) return;               // a newer request is already in flight
      if (!resp.ok || data.error) {
        lblPlan.textContent = data.error || "Plan error";
        return;
      }
      state.plan = data;
      state.srcW = data.source_width;
      state.srcH = data.source_height;
      state.totalFrames = Math.max(1, data.total_frames);
      state.fps = data.source_fps || 24;
      lblPlan.textContent = `${data.source_width}×${data.source_height} @ ${data.output_fps}fps`;
      syncCropOverlay();
      syncTrimBar();
    } catch (err) {
      if (seq === state.planSeq) lblPlan.textContent = "Plan offline";
    }
  }

  function schedulePlan() {
    markStale();
    if (state.planTimer) clearTimeout(state.planTimer);
    state.planTimer = setTimeout(refreshPlan, 80);
  }

  function clearPreview() {
    prevVideo.pause();
    prevVideo.removeAttribute("src");
    prevVideo.load();
    state.renderedKey = null;
    prevMsg.textContent = "Press “Update” to render the cropped / trimmed result";
    prevMsg.style.display = "";
    lblPrev.textContent = "Result preview";
    btnUpdate.classList.remove("stale");
  }

  async function renderPreview() {
    const name = getWidget(node, "video")?.value;
    if (!name || state.previewBusy) return;
    const payload = payloadFromWidgets();
    const key = JSON.stringify(payload);

    state.previewBusy = true;
    btnUpdate.disabled = true;
    btnUpdate.classList.remove("stale");
    btnUpdate.textContent = "Rendering…";
    prevMsg.textContent = "Rendering…";
    prevMsg.style.display = "";
    try {
      const resp = await api.fetchApi(PREVIEW_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await resp.json();
      if (!resp.ok || data.error) throw new Error(data.error || "Preview failed");

      const qs = new URLSearchParams({ filename: data.filename, type: data.type, subfolder: data.subfolder || "" });
      prevVideo.src = api.apiURL(`/view?${qs.toString()}`);
      prevVideo.load();
      prevVideo.play().catch(() => {});
      state.renderedKey = key;
      prevMsg.style.display = "none";
      lblPrev.textContent = `Output ${data.output_width}×${data.output_height} · ${data.output_frames}f @ ${data.output_fps}fps (preview ${data.preview_width}×${data.preview_height})`;
    } catch (err) {
      prevMsg.textContent = `Preview failed: ${err.message || err}`;
      prevMsg.style.display = "";
    } finally {
      state.previewBusy = false;
      btnUpdate.disabled = false;
      btnUpdate.textContent = "⟳ Update";
      markStale();                                     // widgets may have changed while rendering
    }
  }

  function resetCropAndTrim() {
    for (const n of CROP_WIDGETS) setWidgetValue(node, n, 0, true);
    for (const n of TRIM_WIDGETS) setWidgetValue(node, n, 0, true);
  }

  async function uploadAndSelect(file) {
    if (!file) return;
    const body = new FormData();
    body.append("image", file, file.name);
    body.append("type", "input");
    body.append("overwrite", "true");
    try {
      const resp = await api.fetchApi("/upload/image", { method: "POST", body });
      const data = await resp.json();
      const chosen = data.subfolder ? `${data.subfolder}/${data.name}` : data.name;
      const vidWidget = getWidget(node, "video");
      if (vidWidget) {
        if (Array.isArray(vidWidget.options?.values) && !vidWidget.options.values.includes(chosen)) {
          vidWidget.options.values.push(chosen);
        }
        resetCropAndTrim();
        setWidgetValue(node, "video", chosen, true);
        commitWidgets(node, ["video"]);
      }
      loadVideoPreview(chosen, true);                  // cache-bust: same name may have been overwritten
      schedulePlan();
    } catch (err) {
      msg.textContent = `Upload failed: ${err}`;
    }
  }

  function loadVideoPreview(filename, bust = false) {
    state.loadedName = filename || null;
    clearPreview();
    if (!filename) {
      video.removeAttribute("src");
      video.load();
      msg.textContent = "Select or drop a video file";
      return;
    }
    msg.textContent = "";
    const url = buildViewUrl(filename);
    video.src = bust ? `${url}${url.includes("?") ? "&" : "?"}t=${Date.now()}` : url;
    video.load();
  }

  // A different clip makes the old crop/trim meaningless, so start fresh (widget loads never get here).
  function onVideoChanged(val) {
    if (val === state.loadedName) return;
    if (state.loadedName) resetCropAndTrim();
    loadVideoPreview(val);
  }

  btnLoad.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    if (fileInput.files && fileInput.files[0]) uploadAndSelect(fileInput.files[0]);
    fileInput.value = "";
  });

  stage.addEventListener("dragover", (e) => {
    e.preventDefault();
    stage.classList.add("drop");
  });
  stage.addEventListener("dragleave", () => stage.classList.remove("drop"));
  stage.addEventListener("drop", (e) => {
    e.preventDefault();
    stage.classList.remove("drop");
    const f = e.dataTransfer?.files?.[0];
    if (f) uploadAndSelect(f);
  });

  stage.addEventListener("dblclick", () => {
    for (const n of CROP_WIDGETS) setWidgetValue(node, n, 0);
    syncCropOverlay();
    schedulePlan();
  });

  stage.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    root.focus({ preventScroll: true });
    const mr = getMediaRect();
    const src = stageToSrc(eventToStage(e), mr);

    const cur = currentCropPx();
    const isFull = cur.x === 0 && cur.y === 0 && cur.w === cur.vw && cur.h === cur.vh;
    const handleDir = e.target?.dataset?.dir;
    // A full-frame box covers the whole picture, so clicking it must START a new crop, not "move" it.
    const isMove = e.target === cropBox && !isFull;
    const mode = handleDir || (isMove ? "move" : "draw");

    state.draggingCrop = {
      mode,
      active: mode !== "draw",
      cx0: e.clientX,
      cy0: e.clientY,
      startSrcX: src.x,
      startSrcY: src.y,
      orig: cur,
      vw: mr.vw,
      vh: mr.vh,
    };
    stage.setPointerCapture(e.pointerId);
  });

  stage.addEventListener("pointermove", (e) => {
    const d = state.draggingCrop;
    if (!d) return;
    if (!d.active) {                                   // a plain click must not leave a tiny crop behind
      if (Math.hypot(e.clientX - d.cx0, e.clientY - d.cy0) < 4) return;
      d.active = true;
    }
    const mr = getMediaRect();
    const cursor = stageToSrc(eventToStage(e), mr);
    const dx = cursor.x - d.startSrcX;
    const dy = cursor.y - d.startSrcY;
    const ratio = resolvedAspectRatio();
    const o = d.orig;

    if (d.mode === "move") {
      const nx = clamp(o.x + dx, 0, d.vw - o.w);
      const ny = clamp(o.y + dy, 0, d.vh - o.h);
      writeCropPx(nx, ny, o.w, o.h, d.vw, d.vh, true);
    } else if (d.mode === "draw") {
      const x0 = clamp(d.startSrcX, 0, d.vw);
      const y0 = clamp(d.startSrcY, 0, d.vh);
      const x1 = clamp(cursor.x, 0, d.vw);
      const y1 = clamp(cursor.y, 0, d.vh);
      const sx = x1 >= x0 ? 1 : -1;                    // drag direction: any corner works
      const sy = y1 >= y0 ? 1 : -1;
      let w = Math.abs(x1 - x0);
      let h = Math.abs(y1 - y0);
      if (ratio) {
        if (w / ratio >= h) h = w / ratio; else w = h * ratio;
        const maxW = sx > 0 ? d.vw - x0 : x0;           // keep the locked ratio inside the frame
        const maxH = sy > 0 ? d.vh - y0 : y0;
        if (w > maxW) { w = maxW; h = w / ratio; }
        if (h > maxH) { h = maxH; w = h * ratio; }
      }
      w = Math.max(MIN_CROP_PX, w);
      h = Math.max(MIN_CROP_PX, h);
      writeCropPx(sx > 0 ? x0 : x0 - w, sy > 0 ? y0 : y0 - h, w, h, d.vw, d.vh, true);
    } else {
      // Corner resize: the opposite corner is the anchor and never moves. Working from the anchor
      // (instead of editing x/y/w/h separately) is what stops the far edge from sliding when the
      // dragged edge hits the frame boundary.
      const west = d.mode.includes("w");
      const north = d.mode.includes("n");
      const ax = west ? o.x + o.w : o.x;
      const ay = north ? o.y + o.h : o.y;
      const sx = west ? -1 : 1;
      const sy = north ? -1 : 1;
      const roomW = sx > 0 ? d.vw - ax : ax;
      const roomH = sy > 0 ? d.vh - ay : ay;
      let w = clamp(sx * ((west ? o.x : o.x + o.w) + dx - ax), MIN_CROP_PX, roomW);
      let h = clamp(sy * ((north ? o.y : o.y + o.h) + dy - ay), MIN_CROP_PX, roomH);
      if (ratio) {
        if (w / ratio >= h) h = w / ratio; else w = h * ratio;
        if (w > roomW) { w = roomW; h = w / ratio; }
        if (h > roomH) { h = roomH; w = h * ratio; }
      }
      writeCropPx(sx > 0 ? ax : ax - w, sy > 0 ? ay : ay - h, w, h, d.vw, d.vh, true);
    }
    syncCropOverlay();
    node.setDirtyCanvas?.(true, true);
  });

  const endCropDrag = () => {
    const d = state.draggingCrop;
    if (!d) return;
    state.draggingCrop = null;
    if (d.active) commitWidgets(node, CROP_WIDGETS);   // one callback pass instead of one per mouse move
    syncCropOverlay();
    schedulePlan();
  };
  stage.addEventListener("pointerup", endCropDrag);
  stage.addEventListener("pointercancel", endCropDrag);

  function updateTrimFromClientX(clientX, mode) {
    const rect = trimBar.getBoundingClientRect();
    const frac = clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1);
    const total = Math.max(1, state.totalFrames);
    const frame = Math.round(frac * total);

    if (mode === "start") {
      const rawEnd = Number(getWidget(node, "end_frame")?.value || 0);
      const e = rawEnd <= 0 || rawEnd > total ? total : rawEnd;
      const f = clamp(frame, 0, e - 1);
      setWidgetValue(node, "start_frame", f, true);
      video.currentTime = Math.min(f, total - 1) / Math.max(1, state.fps);
      markStale();
    } else if (mode === "end") {
      const s0 = Number(getWidget(node, "start_frame")?.value || 0);
      const f = Math.max(s0 + 1, Math.min(total, frame));
      setWidgetValue(node, "end_frame", f >= total ? 0 : f, true);
      video.currentTime = Math.max(0, Math.min(f, total) - 1) / Math.max(1, state.fps);
      markStale();
    } else if (mode === "scrub") {
      video.currentTime = frame / Math.max(1, state.fps);
    }
    syncTrimBar();
  }

  hStart.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    state.draggingTrim = "start";
    hStart.setPointerCapture(e.pointerId);
  });
  hEnd.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    state.draggingTrim = "end";
    hEnd.setPointerCapture(e.pointerId);
  });
  trimBar.addEventListener("pointerdown", (e) => {
    if (e.target === hStart || e.target === hEnd) return;
    state.draggingTrim = "scrub";
    trimBar.setPointerCapture(e.pointerId);
    updateTrimFromClientX(e.clientX, "scrub");
  });
  trimBar.addEventListener("pointermove", (e) => {
    if (!state.draggingTrim) return;
    updateTrimFromClientX(e.clientX, state.draggingTrim);
  });
  trimBar.addEventListener("pointerup", () => {
    if (!state.draggingTrim) return;
    const wasTrimHandle = state.draggingTrim === "start" || state.draggingTrim === "end";
    state.draggingTrim = null;
    if (wasTrimHandle) {
      commitWidgets(node, TRIM_WIDGETS);
      schedulePlan();
    }
  });
  trimBar.addEventListener("pointercancel", () => { state.draggingTrim = null; });

  video.addEventListener("loadedmetadata", () => {
    if (video.videoWidth && video.videoHeight) {
      state.srcW = video.videoWidth;
      state.srcH = video.videoHeight;
    }
    syncCropOverlay();
    syncTrimBar();
  });
  video.addEventListener("error", () => {
    msg.textContent = "This browser can't play this file, but cropping and trimming still work.";
  });
  video.addEventListener("timeupdate", syncTrimBar);
  video.addEventListener("play", () => { btnPlay.textContent = "Pause"; });
  video.addEventListener("pause", () => { btnPlay.textContent = "Play"; });

  root.addEventListener("keydown", (e) => {
    // Leave Ctrl/Cmd/Alt shortcuts (copy, paste, undo, ...) to ComfyUI and the browser.
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const step = e.shiftKey ? 10 : 1;
    const total = Math.max(1, state.totalFrames);
    const curF = Math.round((video.currentTime || 0) * state.fps);
    if (e.code === "Space") {
      e.preventDefault();
      e.stopPropagation();
      if (video.paused) video.play().catch(() => {});
      else video.pause();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      e.stopPropagation();
      video.currentTime = Math.max(0, curF - step) / Math.max(1, state.fps);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      e.stopPropagation();
      video.currentTime = Math.min(total - 1, curF + step) / Math.max(1, state.fps);
    } else if (e.key === "Home") {
      e.preventDefault();
      e.stopPropagation();
      video.currentTime = 0;
    } else if (e.key === "End") {
      e.preventDefault();
      e.stopPropagation();
      video.currentTime = Math.max(0, (total - 1) / Math.max(1, state.fps));
    } else if (e.key === "[" || e.key.toLowerCase() === "i") {
      e.preventDefault();
      e.stopPropagation();
      setWidgetValue(node, "start_frame", Math.max(0, Math.min(total - 2, curF)));
      syncTrimBar();
      schedulePlan();
    } else if (e.key === "]" || e.key.toLowerCase() === "o") {
      e.preventDefault();
      e.stopPropagation();
      const s = Number(getWidget(node, "start_frame")?.value || 0);
      const nf = Math.max(s + 1, Math.min(total, curF));
      setWidgetValue(node, "end_frame", nf >= total ? 0 : nf);
      syncTrimBar();
      schedulePlan();
    }
  });

  // Hook existing widget callbacks so manual edits update the preview & plan
  for (const w of node.widgets || []) {
    if (!WATCH_WIDGETS.includes(w.name)) continue;
    const prev = w.callback;
    w.callback = function (val) {
      const res = prev ? prev.apply(this, arguments) : undefined;
      if (w.name === "video") onVideoChanged(val);
      syncCropOverlay();
      syncTrimBar();
      schedulePlan();
      return res;
    };
  }

  const domWidget = node.addDOMWidget("nlv_editor", "nlv_editor", root, {
    serialize: false,
    hideOnZoom: false,
  });
  domWidget.computeSize = () => [360, 610];

  const ensureNodeSize = () => {
    const need = node.computeSize?.() || [0, 0];
    node.setSize([Math.max(node.size?.[0] || 0, 400, need[0]), Math.max(node.size?.[1] || 0, need[1])]);
  };
  ensureNodeSize();

  const origResize = node.onResize;
  node.onResize = function () {
    const r = origResize ? origResize.apply(this, arguments) : undefined;
    syncCropOverlay();
    syncTrimBar();
    return r;
  };

  // Saved workflows restore widget values directly (no callbacks), so the editor has to be re-synced
  // here, otherwise it keeps showing the default video while the widgets hold the saved one.
  const origConfigure = node.onConfigure;
  node.onConfigure = function () {
    const r = origConfigure ? origConfigure.apply(this, arguments) : undefined;
    const name = getWidget(node, "video")?.value;
    if (name && name !== state.loadedName) loadVideoPreview(name);
    ensureNodeSize();
    syncCropOverlay();
    syncTrimBar();
    schedulePlan();
    return r;
  };

  // Overlay must follow the stage whenever its layout size changes (node resize, first load, etc.).
  let ro = null;
  if (typeof ResizeObserver !== "undefined") {
    ro = new ResizeObserver(() => syncCropOverlay());
    ro.observe(stage);
  }

  const origRemoved = node.onRemoved;
  node.onRemoved = function () {
    ro?.disconnect();
    video.pause();
    prevVideo.pause();
    return origRemoved ? origRemoved.apply(this, arguments) : undefined;
  };

  const initialVideo = getWidget(node, "video")?.value;
  if (initialVideo) {
    loadVideoPreview(initialVideo);
    schedulePlan();
  }
}

app.registerExtension({
  name: "Nougan.LoadVideo",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE) return;
    const origCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = origCreated ? origCreated.apply(this, arguments) : undefined;
      installEditor(this);
      return r;
    };
  },
});