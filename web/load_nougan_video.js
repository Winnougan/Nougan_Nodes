// web/nougan_load_video.js — visual crop & trim editor for NouganLoadVideo.
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE = "NouganLoadVideo";
const ACCENT = "#a855f7";
const MIN_CROP_PX = 16;

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
  "frame_rule", "snap_from", "max_frames", "target_fps",
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

function setWidgetValue(node, name, val) {
  const w = getWidget(node, name);
  if (!w) return;
  if (w.value === val) return;
  w.value = val;
  if (typeof w.callback === "function") {
    w.callback(val);
  }
}

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
    setWidgetValue(node, "crop_x", 0);
    setWidgetValue(node, "crop_y", 0);
    setWidgetValue(node, "crop_w", 0);
    setWidgetValue(node, "crop_h", 0);
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

  rowTransport.append(btnPlay, lblFrames);
  root.append(rowFile, rowAspect, stage, trimBar, rowTransport);

  function getMediaRect() {
    const sRect = stage.getBoundingClientRect();
    const vw = state.srcW || video.videoWidth || 16;
    const vh = state.srcH || video.videoHeight || 9;
    const scale = Math.min(sRect.width / vw, sRect.height / vh);
    const dw = vw * scale;
    const dh = vh * scale;
    const dx = (sRect.width - dw) * 0.5;
    const dy = (sRect.height - dh) * 0.5;
    return { left: dx, top: dy, width: dw, height: dh, vw, vh };
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

  function writeCropPx(x, y, w, h, vw, vh) {
    const cx = Math.max(0, Math.min(vw - MIN_CROP_PX, Math.round(x)));
    const cy = Math.max(0, Math.min(vh - MIN_CROP_PX, Math.round(y)));
    const cw = Math.max(MIN_CROP_PX, Math.min(vw - cx, Math.round(w)));
    const ch = Math.max(MIN_CROP_PX, Math.min(vh - cy, Math.round(h)));
    const isFull = cx === 0 && cy === 0 && cw === vw && ch === vh;
    setWidgetValue(node, "crop_x", cx);
    setWidgetValue(node, "crop_y", cy);
    setWidgetValue(node, "crop_w", isFull ? 0 : cw);
    setWidgetValue(node, "crop_h", isFull ? 0 : ch);
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
    nw = Math.max(MIN_CROP_PX, Math.min(vw - x, nw));
    nh = Math.max(MIN_CROP_PX, Math.min(vh - y, nh));
    writeCropPx(x, y, nw, nh, vw, vh);
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

  async function refreshPlan() {
    const videoName = getWidget(node, "video")?.value || "";
    if (!videoName) {
      msg.textContent = "Select or drop a video file";
      return;
    }
    lblName.textContent = videoName;

    const payload = {};
    for (const k of WATCH_WIDGETS) {
      const w = getWidget(node, k);
      if (w) payload[k] = w.value;
    }

    try {
      const resp = await api.fetchApi("/nougan/load_video/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await resp.json();
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
      lblPlan.textContent = "Plan offline";
    }
  }

  function schedulePlan() {
    if (state.planTimer) clearTimeout(state.planTimer);
    state.planTimer = setTimeout(refreshPlan, 80);
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
        setWidgetValue(node, "video", chosen);
      }
      loadVideoPreview(chosen);
      schedulePlan();
    } catch (err) {
      msg.textContent = `Upload failed: ${err}`;
    }
  }

  function loadVideoPreview(filename) {
    if (!filename) {
      video.removeAttribute("src");
      video.load();
      msg.textContent = "Select or drop a video file";
      return;
    }
    msg.textContent = "";
    video.src = buildViewUrl(filename);
    video.load();
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
    setWidgetValue(node, "crop_x", 0);
    setWidgetValue(node, "crop_y", 0);
    setWidgetValue(node, "crop_w", 0);
    setWidgetValue(node, "crop_h", 0);
    syncCropOverlay();
    schedulePlan();
  });

  stage.addEventListener("pointerdown", (e) => {
    root.focus();
    const mr = getMediaRect();
    const sRect = stage.getBoundingClientRect();
    const px = e.clientX - sRect.left;
    const py = e.clientY - sRect.top;
    const srcX = ((px - mr.left) / Math.max(1, mr.width)) * mr.vw;
    const srcY = ((py - mr.top) / Math.max(1, mr.height)) * mr.vh;

    const handleDir = e.target?.dataset?.dir;
    const isMove = e.target === cropBox;
    const mode = handleDir || (isMove ? "move" : "draw");

    state.draggingCrop = {
      mode,
      startSrcX: srcX,
      startSrcY: srcY,
      orig: currentCropPx(),
      vw: mr.vw,
      vh: mr.vh,
    };
    stage.setPointerCapture(e.pointerId);
  });

  stage.addEventListener("pointermove", (e) => {
    const d = state.draggingCrop;
    if (!d) return;
    const mr = getMediaRect();
    const sRect = stage.getBoundingClientRect();
    const curX = ((e.clientX - sRect.left - mr.left) / Math.max(1, mr.width)) * d.vw;
    const curY = ((e.clientY - sRect.top - mr.top) / Math.max(1, mr.height)) * d.vh;
    const dx = curX - d.startSrcX;
    const dy = curY - d.startSrcY;
    const ratio = resolvedAspectRatio();

    if (d.mode === "move") {
      const nx = Math.max(0, Math.min(d.vw - d.orig.w, d.orig.x + dx));
      const ny = Math.max(0, Math.min(d.vh - d.orig.h, d.orig.y + dy));
      writeCropPx(nx, ny, d.orig.w, d.orig.h, d.vw, d.vh);
    } else if (d.mode === "draw") {
      let x0 = Math.max(0, Math.min(d.vw, d.startSrcX));
      let y0 = Math.max(0, Math.min(d.vh, d.startSrcY));
      let w = Math.max(MIN_CROP_PX, curX - x0);
      let h = ratio ? w / ratio : Math.max(MIN_CROP_PX, curY - y0);
      if (x0 + w > d.vw) {
        w = d.vw - x0;
        if (ratio) h = w / ratio;
      }
      if (y0 + h > d.vh) {
        h = d.vh - y0;
        if (ratio) w = h * ratio;
      }
      writeCropPx(x0, y0, w, h, d.vw, d.vh);
    } else {
      let nx = d.orig.x;
      let ny = d.orig.y;
      let nw = d.orig.w;
      let nh = d.orig.h;
      if (d.mode.includes("e")) nw = Math.max(MIN_CROP_PX, d.orig.w + dx);
      if (d.mode.includes("s")) nh = Math.max(MIN_CROP_PX, d.orig.h + dy);
      if (d.mode.includes("w")) {
        const clampedDx = Math.min(dx, d.orig.w - MIN_CROP_PX);
        nx = d.orig.x + clampedDx;
        nw = d.orig.w - clampedDx;
      }
      if (d.mode.includes("n")) {
        const clampedDy = Math.min(dy, d.orig.h - MIN_CROP_PX);
        ny = d.orig.y + clampedDy;
        nh = d.orig.h - clampedDy;
      }
      if (ratio) nh = nw / ratio;
      writeCropPx(nx, ny, nw, nh, d.vw, d.vh);
    }
    syncCropOverlay();
  });

  stage.addEventListener("pointerup", () => {
    if (!state.draggingCrop) return;
    state.draggingCrop = null;
    schedulePlan();
  });

  function updateTrimFromClientX(clientX, mode) {
    const rect = trimBar.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
    const total = Math.max(1, state.totalFrames);
    const frame = Math.round(frac * total);

    if (mode === "start") {
      const rawEnd = Number(getWidget(node, "end_frame")?.value || 0);
      const e = rawEnd <= 0 || rawEnd > total ? total : rawEnd;
      setWidgetValue(node, "start_frame", Math.max(0, Math.min(e - 1, frame)));
    } else if (mode === "end") {
      const s = Number(getWidget(node, "start_frame")?.value || 0);
      const clamped = Math.max(s + 1, Math.min(total, frame));
      setWidgetValue(node, "end_frame", clamped >= total ? 0 : clamped);
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
    if (wasTrimHandle) schedulePlan();
  });

  video.addEventListener("loadedmetadata", () => {
    if (video.videoWidth && video.videoHeight) {
      state.srcW = video.videoWidth;
      state.srcH = video.videoHeight;
    }
    syncCropOverlay();
    syncTrimBar();
  });
  video.addEventListener("timeupdate", syncTrimBar);
  video.addEventListener("play", () => { btnPlay.textContent = "Pause"; });
  video.addEventListener("pause", () => { btnPlay.textContent = "Play"; });

  root.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 10 : 1;
    const total = Math.max(1, state.totalFrames);
    const curF = Math.round((video.currentTime || 0) * state.fps);
    if (e.code === "Space") {
      e.preventDefault();
      if (video.paused) video.play().catch(() => {});
      else video.pause();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      video.currentTime = Math.max(0, curF - step) / Math.max(1, state.fps);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      video.currentTime = Math.min(total - 1, curF + step) / Math.max(1, state.fps);
    } else if (e.key === "Home") {
      e.preventDefault();
      video.currentTime = 0;
    } else if (e.key === "End") {
      e.preventDefault();
      video.currentTime = Math.max(0, (total - 1) / Math.max(1, state.fps));
    } else if (e.key === "[" || e.key.toLowerCase() === "i") {
      e.preventDefault();
      setWidgetValue(node, "start_frame", Math.max(0, Math.min(total - 2, curF)));
      syncTrimBar();
      schedulePlan();
    } else if (e.key === "]" || e.key.toLowerCase() === "o") {
      e.preventDefault();
      const s = Number(getWidget(node, "start_frame")?.value || 0);
      const nf = Math.max(s + 1, Math.min(total, curF));
      setWidgetValue(node, "end_frame", nf >= total ? 0 : nf);
      syncTrimBar();
      schedulePlan();
    }
  });

  // Hook existing widget callbacks so manual edits update the preview & plan
  for (const w of node.widgets || []) {
    const prev = w.callback;
    w.callback = function (val) {
      const res = prev ? prev.apply(this, arguments) : undefined;
      if (w.name === "video") loadVideoPreview(val);
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
  domWidget.computeSize = () => [360, 320];

  node.setSize([Math.max(node.size?.[0] || 380, 380), Math.max(node.size?.[1] || 520, 520)]);

  const origResize = node.onResize;
  node.onResize = function () {
    const r = origResize ? origResize.apply(this, arguments) : undefined;
    syncCropOverlay();
    syncTrimBar();
    return r;
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