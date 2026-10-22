// web/nougan_gif_maker.js  —  Nougan GIF Maker editor by Winnougan
// Visual trim / crop / size editor for the "Nougan GIF Maker" node.
// All state lives in the node's normal widgets (start_sec, end_sec, crop_*, width, ...),
// so workflows save/load and queue like any other node.

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_NAME = "NouganGifMaker";
const EDITOR_H = 600;
const MIN_LEN = 0.1;
const THUMBS = 16;
const STRIP_H = 52;

const SETTINGS = [
  "start_sec", "end_sec", "width", "fps", "format", "max_colors", "dither", "quality",
  "loop_count", "speed", "crop_x", "crop_y", "crop_w", "crop_h", "filename_prefix",
];

const PRESETS = {
  "Discord (GIF, ≤10 MB)":   { format: "gif",  width: 480, fps: 15, max_colors: 256, dither: "sierra2_4a" },
  "WhatsApp / Telegram (MP4)": { format: "mp4", width: 540, fps: 24, quality: 75 },
  "X / Twitter (GIF)":       { format: "gif",  width: 600, fps: 15, max_colors: 256, dither: "sierra2_4a" },
  "Tiny meme (GIF)":         { format: "gif",  width: 320, fps: 12, max_colors: 128, dither: "bayer" },
  "Sharp WebP":              { format: "webp", width: 480, fps: 20, quality: 80 },
};

const ASPECTS = { "No crop": null, "Crop: Free": 0, "Crop: 1:1": 1, "Crop: 16:9": 16 / 9, "Crop: 9:16": 9 / 16, "Crop: 4:3": 4 / 3, "Crop: 3:4": 3 / 4 };

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const r2 = (v) => Math.round(v * 100) / 100;
const r4 = (v) => Math.round(v * 10000) / 10000;
const even = (n) => Math.max(2, Math.floor(n / 2) * 2);
const num = (v, d) => (v === undefined || v === null || Number.isNaN(+v) ? d : +v);
const fmtT = (t) => `${t.toFixed(2)}s`;
const fmtBytes = (b) => (b < 1048576 ? `${Math.round(b / 1024)} KB` : `${(b / 1048576).toFixed(2)} MB`);

function el(tag, cls, parent, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  if (parent) parent.appendChild(e);
  return e;
}

function coverDraw(ctx, img, x, y, w, h) {
  const ir = img.width / img.height;
  const sr = w / h;
  let sx = 0, sy = 0, sw = img.width, sh = img.height;
  if (ir > sr) { sw = img.height * sr; sx = (img.width - sw) / 2; }
  else { sh = img.width / sr; sy = (img.height - sh) / 2; }
  ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
}

const CSS = `
.ngm{display:flex;flex-direction:column;gap:6px;width:100%;height:100%;padding:4px;overflow-y:auto;font:12px system-ui,sans-serif;color:var(--input-text,#ddd)}
.ngm *{box-sizing:border-box}
.ngm-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.ngm button,.ngm select{background:var(--comfy-input-bg,#2b2b2b);color:var(--input-text,#ddd);border:1px solid var(--border-color,#555);border-radius:6px;padding:4px 8px;font-size:12px;cursor:pointer}
.ngm button:hover{filter:brightness(1.25)}
.ngm button:disabled{opacity:.5;cursor:default}
.ngm .ngm-primary{background:#f5a623;color:#111;border-color:#f5a623;font-weight:700}
.ngm-status{opacity:.7;margin-left:auto}
.ngm-stage{display:flex;justify-content:center;background:#0c0c0c;border-radius:8px;padding:6px}
.ngm-wrap{position:relative;overflow:hidden;background:#000;width:320px;height:180px}
.ngm-video{position:absolute;inset:0;width:100%;height:100%;object-fit:fill;pointer-events:none}
.ngm-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;color:#aaa;background:#111;padding:8px;line-height:1.5}
.ngm-crop{position:absolute;border:2px solid #f5a623;box-shadow:0 0 0 9999px rgba(0,0,0,.55);cursor:move;touch-action:none}
.ngm-h{position:absolute;width:14px;height:14px;background:#f5a623;border-radius:3px;touch-action:none}
.ngm-h-nw{left:-8px;top:-8px;cursor:nwse-resize}
.ngm-h-ne{right:-8px;top:-8px;cursor:nesw-resize}
.ngm-h-sw{left:-8px;bottom:-8px;cursor:nesw-resize}
.ngm-h-se{right:-8px;bottom:-8px;cursor:nwse-resize}
.ngm-tl{position:relative;height:${STRIP_H}px;flex:0 0 ${STRIP_H}px;border-radius:6px;overflow:hidden;background:#111;touch-action:none;user-select:none;cursor:pointer}
.ngm-strip{position:absolute;inset:0;width:100%;height:100%}
.ngm-selr{position:absolute;top:0;bottom:0;border:2px solid #f5a623;box-shadow:0 0 0 9999px rgba(0,0,0,.55);cursor:grab}
.ngm-hl,.ngm-hr{position:absolute;top:-2px;bottom:-2px;width:12px;background:#f5a623;cursor:ew-resize}
.ngm-hl{left:-2px;border-radius:4px 0 0 4px}
.ngm-hr{right:-2px;border-radius:0 4px 4px 0}
.ngm-playhead{position:absolute;top:0;bottom:0;width:2px;background:#fff;pointer-events:none;transform:translateX(-1px)}
.ngm-info{opacity:.85}
.ngm-size{font-weight:700}
.ngm-size.warn{color:#f5a623}
.ngm-size.bad{color:#ff5c5c}
.ngm-result{display:flex;flex-direction:column;gap:4px;align-items:center}
.ngm-result img,.ngm-result video{max-width:100%;max-height:170px;border-radius:6px;background:#000}
.ngm-err{color:#ff7777;word-break:break-word}
`;

function injectCss() {
  if (document.getElementById("nougan-gif-css")) return;
  const s = document.createElement("style");
  s.id = "nougan-gif-css";
  s.textContent = CSS;
  document.head.appendChild(s);
}

class GifEditor {
  constructor(node) {
    this.node = node;
    this.info = null;
    this.token = null;
    this.playing = false;
    this.drag = null;
    this.cropOn = false;
    this.aspect = 0;
    this.thumbs = [];
    this.thumbRun = 0;
    this.estSeq = 0;
    this.estTimer = null;
    this._build();
    this._hookWidgets();
  }

  // ── widget access ────────────────────────────────────────────────────────
  _w(name) { return this.node.widgets?.find((w) => w.name === name); }
  _get(name) { return this._w(name)?.value; }
  _set(name, v) {
    const w = this._w(name);
    if (!w) return;
    w.value = v;
    app.graph?.setDirtyCanvas(true, false);
  }
  _hookWidgets() {
    for (const n of SETTINGS) {
      const w = this._w(n);
      if (!w) continue;
      const cb = w.callback;
      w.callback = (...a) => {
        const r = cb ? cb.apply(w, a) : undefined;
        this.refresh();
        return r;
      };
    }
  }
  _settings() {
    const o = {};
    for (const n of SETTINGS) { const w = this._w(n); if (w) o[n] = w.value; }
    return o;
  }

  // ── DOM ──────────────────────────────────────────────────────────────────
  _build() {
    const root = (this.root = el("div", "ngm"));

    const top = el("div", "ngm-row", root);
    this.presetSel = el("select", "", top);
    this.presetSel.innerHTML = `<option value="">Preset…</option>` + Object.keys(PRESETS).map((k) => `<option>${k}</option>`).join("");
    this.aspectSel = el("select", "", top);
    this.aspectSel.innerHTML = Object.keys(ASPECTS).map((k) => `<option>${k}</option>`).join("");
    this.status = el("span", "ngm-status", top, "Queue the workflow once to load the video");

    this.stage = el("div", "ngm-stage", root);
    this.wrap = el("div", "ngm-wrap", this.stage);
    this.video = el("video", "ngm-video", this.wrap);
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.preload = "auto";
    this.crop = el("div", "ngm-crop", this.wrap);
    for (const k of ["nw", "ne", "sw", "se"]) { el("div", `ngm-h ngm-h-${k}`, this.crop).dataset.h = k; }
    this.crop.style.display = "none";
    this.empty = el("div", "ngm-empty", this.wrap, "Connect a video, then queue once<br>to load it into the editor");

    const ctrl = el("div", "ngm-row", root);
    this.btnPlay = el("button", "", ctrl, "▶ Play");
    this.btnStart = el("button", "", ctrl, "[ Start here");
    this.btnEnd = el("button", "", ctrl, "End here ]");
    this.timeLbl = el("span", "", ctrl, "0.00s");

    this.tl = el("div", "ngm-tl", root);
    this.strip = el("canvas", "ngm-strip", this.tl);
    this.selEl = el("div", "ngm-selr", this.tl);
    this.hL = el("div", "ngm-hl", this.selEl);
    this.hR = el("div", "ngm-hr", this.selEl);
    this.head = el("div", "ngm-playhead", this.tl);

    this.infoEl = el("div", "ngm-info", root, "");

    const act = el("div", "ngm-row", root);
    this.btnExport = el("button", "ngm-primary", act, "⬇ Export");
    this.sizeLbl = el("span", "ngm-size", act, "");
    this.result = el("div", "ngm-result", root);

    // events
    this.btnPlay.onclick = () => this.togglePlay();
    this.btnStart.onclick = () => this._setRange(this.video.currentTime, null);
    this.btnEnd.onclick = () => this._setRange(null, this.video.currentTime);
    this.btnExport.onclick = () => this.doExport();
    this.presetSel.onchange = () => { this._applyPreset(this.presetSel.value); this.presetSel.value = ""; };
    this.aspectSel.onchange = () => this._onAspect(this.aspectSel.value);

    this.video.addEventListener("play", () => { this.playing = true; this.btnPlay.textContent = "⏸ Pause"; requestAnimationFrame(this._tick); });
    this.video.addEventListener("pause", () => { this.playing = false; this.btnPlay.textContent = "▶ Play"; });
    this.video.addEventListener("seeked", () => this._updHead());
    this.video.addEventListener("loadeddata", () => {
      this.empty.style.display = "none";
      const [s] = this.range();
      this.video.currentTime = s;
    });
    this.video.addEventListener("error", () => {
      if (!this.video.getAttribute("src")) return;
      this.empty.style.display = "flex";
      this.empty.innerHTML = "Preview expired.<br>Queue the workflow to reload the video.";
    });

    this.tl.addEventListener("pointerdown", (e) => this._onTlDown(e));
    this.tl.addEventListener("pointermove", (e) => this._onTlMove(e));
    this.tl.addEventListener("pointerup", (e) => this._onTlUp(e));
    this.tl.addEventListener("pointercancel", (e) => this._onTlUp(e));

    this.crop.addEventListener("pointerdown", (e) => this._onCropDown(e));
    this.crop.addEventListener("pointermove", (e) => this._onCropMove(e));
    this.crop.addEventListener("pointerup", (e) => this._onCropUp(e));
    this.crop.addEventListener("pointercancel", (e) => this._onCropUp(e));

    this.ro = new ResizeObserver(() => this.layout());
    this.ro.observe(root);
  }

  destroy() {
    this.playing = false;
    this.thumbRun++;
    clearTimeout(this.estTimer);
    this.ro?.disconnect();
    this.video.pause();
    this.video.removeAttribute("src");
  }

  // ── info loading ─────────────────────────────────────────────────────────
  onExecuted(message) {
    const info = message?.nougan_gif?.[0];
    if (info) this.loadInfo(info);
  }

  restore() {
    const info = this.node.properties?.nougan_gif_info;
    if (info?.token) this.loadInfo(info, true);
    else this._syncCropUI();
  }

  loadInfo(info, restoring = false) {
    this.info = info;
    this.token = info.token;
    this.node.properties = this.node.properties || {};
    this.node.properties.nougan_gif_info = info;

    // keep the range sane for this clip
    const s = num(this._get("start_sec"), 0);
    const e = num(this._get("end_sec"), 0);
    if (!restoring || e <= s || e > info.duration) {
      if (e <= s || e > info.duration) this._set("end_sec", r2(info.duration));
      if (s >= info.duration) this._set("start_sec", 0);
    }

    const url = api.apiURL(`/view?filename=proxy.mp4&type=temp&subfolder=${encodeURIComponent("nougan_gif/" + info.token)}&t=${Date.now()}`);
    this.video.src = url;
    this.status.textContent = `${info.width}×${info.height} · ${info.duration.toFixed(2)}s · ${Math.round(info.fps)} fps`;
    this._syncCropUI();
    this.makeThumbs(url);
    this.layout();
    this.refresh();
  }

  async makeThumbs(url) {
    const run = ++this.thumbRun;
    this.thumbs = [];
    this.drawStrip();
    const v = document.createElement("video");
    v.muted = true;
    v.preload = "auto";
    v.src = url;
    try {
      await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = rej; });
      const d = this.info?.duration || v.duration;
      for (let i = 0; i < THUMBS; i++) {
        if (run !== this.thumbRun) return;
        const t = Math.min(((i + 0.5) / THUMBS) * d, Math.max(v.duration - 0.05, 0));
        await Promise.race([
          new Promise((res) => { v.onseeked = res; v.currentTime = t; }),
          new Promise((res) => setTimeout(res, 1500)),
        ]);
        const c = document.createElement("canvas");
        c.height = 54;
        c.width = Math.max(8, Math.round(54 * (v.videoWidth / v.videoHeight)));
        c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
        this.thumbs.push(c);
        if (i % 3 === 2) this.drawStrip();
      }
      this.drawStrip();
    } catch (e) { /* preview unavailable; the strip just stays dark */ }
    v.removeAttribute("src");
    v.load();
  }

  // ── layout / drawing ─────────────────────────────────────────────────────
  layout() {
    const i = this.info;
    const ar = i ? i.width / i.height : 16 / 9;
    const availW = Math.max(120, this.stage.clientWidth - 12);
    const w = Math.min(availW, 270 * ar);
    this.wrap.style.width = `${Math.round(w)}px`;
    this.wrap.style.height = `${Math.round(w / ar)}px`;
    this.drawStrip();
    this._updRange();
    this._updCrop();
  }

  drawStrip() {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(10, Math.round(this.tl.clientWidth * dpr));
    const h = Math.round(STRIP_H * dpr);
    if (this.strip.width !== w) this.strip.width = w;
    if (this.strip.height !== h) this.strip.height = h;
    const ctx = this.strip.getContext("2d");
    ctx.fillStyle = "#151515";
    ctx.fillRect(0, 0, w, h);
    const n = this.thumbs.length;
    for (let i = 0; i < n; i++) {
      const x0 = Math.round((i * w) / THUMBS);
      const x1 = Math.round(((i + 1) * w) / THUMBS);
      coverDraw(ctx, this.thumbs[i], x0, 0, x1 - x0 + 1, h);
    }
  }

  // ── range ────────────────────────────────────────────────────────────────
  get dur() { return this.info?.duration || 0; }

  range() {
    const d = this.dur;
    let s = num(this._get("start_sec"), 0);
    let e = num(this._get("end_sec"), 0);
    if (d) {
      s = clamp(s, 0, Math.max(d - MIN_LEN, 0));
      if (e <= s || e > d) e = d;
    }
    return [s, e];
  }

  _setRange(s, e) {
    if (!this.info) return;
    let [cs, ce] = this.range();
    if (s != null) cs = clamp(s, 0, ce - MIN_LEN);
    if (e != null) ce = clamp(e, cs + MIN_LEN, this.dur);
    this._set("start_sec", r2(cs));
    this._set("end_sec", r2(ce));
    this.refresh();
  }

  _updRange() {
    const d = this.dur;
    if (!d) { this.selEl.style.display = "none"; this.head.style.display = "none"; return; }
    this.selEl.style.display = "";
    this.head.style.display = "";
    const [s, e] = this.range();
    this.selEl.style.left = `${(s / d) * 100}%`;
    this.selEl.style.width = `${((e - s) / d) * 100}%`;
    this._updHead();
  }

  _updHead() {
    const d = this.dur;
    if (!d) return;
    const t = this.video.currentTime || 0;
    this.head.style.left = `${clamp(t / d, 0, 1) * 100}%`;
    this.timeLbl.textContent = fmtT(t);
  }

  _tick = () => {
    if (!this.playing || !this.root.isConnected) return;
    const [s, e] = this.range();
    const v = this.video;
    if (v.currentTime >= e - 0.02 || v.currentTime < s - 0.1) v.currentTime = s;
    this._updHead();
    requestAnimationFrame(this._tick);
  };

  togglePlay() {
    if (!this.info) return;
    const v = this.video;
    if (v.paused) {
      const [s, e] = this.range();
      if (v.currentTime < s || v.currentTime >= e - 0.03) v.currentTime = s;
      v.playbackRate = clamp(num(this._get("speed"), 1), 0.0625, 16);
      v.play().catch(() => {});
    } else {
      v.pause();
    }
  }

  // ── timeline pointer handling ────────────────────────────────────────────
  _tAt(e, rect) { return clamp((e.clientX - rect.left) / rect.width, 0, 1) * this.dur; }

  _seek(t) { this.video.currentTime = clamp(t, 0, (this.video.duration || this.dur) - 0.01); this._updHead(); }

  _onTlDown(e) {
    if (!this.info) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = this.tl.getBoundingClientRect();
    const t = this._tAt(e, rect);
    const [s, en] = this.range();
    let mode = "seek";
    if (e.target === this.hL) mode = "l";
    else if (e.target === this.hR) mode = "r";
    else if (e.target === this.selEl) mode = "move";
    this.drag = { mode, rect, off: t - s, len: en - s, x0: e.clientX };
    this.tl.setPointerCapture(e.pointerId);
    if (mode === "seek") this._seek(t);
  }

  _onTlMove(e) {
    const dg = this.drag;
    if (!dg) return;
    const t = this._tAt(e, dg.rect);
    const [s, en] = this.range();
    if (dg.mode === "seek") { this._seek(t); return; }
    if (dg.mode === "l") {
      const ns = clamp(t, 0, en - MIN_LEN);
      this._writeRange(ns, en);
      this._seek(ns);
    } else if (dg.mode === "r") {
      const ne = clamp(t, s + MIN_LEN, this.dur);
      this._writeRange(s, ne);
      this._seek(Math.max(s, ne - 0.05));
    } else if (dg.mode === "move") {
      const ns = clamp(t - dg.off, 0, this.dur - dg.len);
      this._writeRange(ns, ns + dg.len);
      this._seek(ns);
    }
  }

  _onTlUp(e) {
    const dg = this.drag;
    if (!dg) return;
    this.drag = null;
    try { this.tl.releasePointerCapture(e.pointerId); } catch (_) {}
    if (dg.mode === "move" && Math.abs(e.clientX - dg.x0) < 3) this._seek(this._tAt(e, dg.rect)); // a click inside the range = seek
    this.refresh();
  }

  _writeRange(s, e) {
    this._set("start_sec", r2(s));
    this._set("end_sec", r2(e));
    this._updRange();
    this._updInfo();
  }

  // ── crop ─────────────────────────────────────────────────────────────────
  _crop() {
    return { x: num(this._get("crop_x"), 0), y: num(this._get("crop_y"), 0), w: num(this._get("crop_w"), 1), h: num(this._get("crop_h"), 1) };
  }

  _writeCrop(c) {
    this._set("crop_x", r4(c.x)); this._set("crop_y", r4(c.y));
    this._set("crop_w", r4(c.w)); this._set("crop_h", r4(c.h));
  }

  _syncCropUI() {
    const c = this._crop();
    this.cropOn = c.w < 0.999 || c.h < 0.999 || c.x > 0.001 || c.y > 0.001;
    if (!this.cropOn) { this.aspect = 0; this.aspectSel.value = "No crop"; }
    else if (this.aspectSel.value === "No crop") this.aspectSel.value = "Crop: Free";
    this._updCrop();
  }

  _onAspect(key) {
    const a = ASPECTS[key];
    if (a === null) {
      this.cropOn = false;
      this.aspect = 0;
      this._writeCrop({ x: 0, y: 0, w: 1, h: 1 });
    } else {
      this.cropOn = true;
      this.aspect = a;
      const W = this.info?.width || 16, H = this.info?.height || 9;
      if (a === 0) {
        const c = this._crop();
        if (c.w > 0.999 && c.h > 0.999) this._writeCrop({ x: 0.1, y: 0.1, w: 0.8, h: 0.8 });
      } else {
        let w = 1, h = W / (a * H);
        if (h > 1) { h = 1; w = (a * H) / W; }
        this._writeCrop({ x: (1 - w) / 2, y: (1 - h) / 2, w, h });
      }
    }
    this.refresh();
  }

  _updCrop() {
    const c = this._crop();
    this.crop.style.display = this.cropOn && this.info ? "" : "none";
    this.crop.style.left = `${c.x * 100}%`;
    this.crop.style.top = `${c.y * 100}%`;
    this.crop.style.width = `${c.w * 100}%`;
    this.crop.style.height = `${c.h * 100}%`;
  }

  _onCropDown(e) {
    e.preventDefault();
    e.stopPropagation();
    const h = e.target.dataset?.h || "move";
    const rect = this.wrap.getBoundingClientRect();
    this.cdrag = { mode: h, rect, c0: this._crop(), x0: e.clientX, y0: e.clientY };
    this.crop.setPointerCapture(e.pointerId);
  }

  _onCropMove(e) {
    const d = this.cdrag;
    if (!d) return;
    const { rect, c0 } = d;
    const MINC = 0.05;
    let c;
    if (d.mode === "move") {
      const dx = (e.clientX - d.x0) / rect.width;
      const dy = (e.clientY - d.y0) / rect.height;
      c = { ...c0, x: clamp(c0.x + dx, 0, 1 - c0.w), y: clamp(c0.y + dy, 0, 1 - c0.h) };
    } else {
      const px = clamp((e.clientX - rect.left) / rect.width, 0, 1);
      const py = clamp((e.clientY - rect.top) / rect.height, 0, 1);
      const ax = d.mode.includes("w") ? c0.x + c0.w : c0.x;   // anchor = the opposite corner
      const ay = d.mode.includes("n") ? c0.y + c0.h : c0.y;
      let w = Math.max(Math.abs(px - ax), MINC);
      let h = Math.max(Math.abs(py - ay), MINC);
      if (this.aspect > 0) {
        const W = this.info?.width || 16, H = this.info?.height || 9;
        const k = W / (this.aspect * H);        // h = w * k  (normalized units)
        w = Math.max(w, h / k, MINC);
        h = w * k;
        const availW = px >= ax ? 1 - ax : ax;
        const availH = py >= ay ? 1 - ay : ay;
        const f = Math.min(1, availW / w, availH / h);
        w *= f; h *= f;
      }
      c = { x: px >= ax ? ax : ax - w, y: py >= ay ? ay : ay - h, w, h };
    }
    this._writeCrop(c);
    this._updCrop();
    this._updInfo();
  }

  _onCropUp(e) {
    if (!this.cdrag) return;
    this.cdrag = null;
    try { this.crop.releasePointerCapture(e.pointerId); } catch (_) {}
    this.refresh();
  }

  // ── readouts / presets ───────────────────────────────────────────────────
  _outSize() {
    const i = this.info;
    if (!i) return null;
    const c = this._crop();
    const px = Math.round(c.x * i.width), py = Math.round(c.y * i.height);
    const pw = even(Math.min(Math.round(c.w * i.width), i.width - px));
    const ph = even(Math.min(Math.round(c.h * i.height), i.height - py));
    const ow = even(Math.min(num(this._get("width"), 480), pw));
    return { ow, oh: even(Math.round((ph * ow) / pw)) };
  }

  _updInfo() {
    if (!this.info) { this.infoEl.textContent = ""; return; }
    const [s, e] = this.range();
    const sp = clamp(num(this._get("speed"), 1), 0.25, 4);
    const len = e - s;
    const fr = Math.round((len / sp) * num(this._get("fps"), 15));
    const o = this._outSize();
    this.infoEl.textContent = `${fmtT(s)} → ${fmtT(e)}  ·  ${fmtT(len)} clip  ·  ~${fr} frames  ·  ${o.ow}×${o.oh}`;
  }

  _applyPreset(name) {
    const p = PRESETS[name];
    if (!p) return;
    for (const [k, v] of Object.entries(p)) this._set(k, v);
    this.refresh();
  }

  refresh() {
    this._updRange();
    this._updCrop();
    this._updInfo();
    this.scheduleEstimate();
  }

  // ── size estimate + export ───────────────────────────────────────────────
  scheduleEstimate() {
    clearTimeout(this.estTimer);
    if (!this.token) return;
    this.estTimer = setTimeout(() => this.estimate(), 600);
  }

  async estimate() {
    const seq = ++this.estSeq;
    this.sizeLbl.className = "ngm-size";
    this.sizeLbl.textContent = "estimating…";
    try {
      const r = await api.fetchApi("/nougan/gif/estimate", { method: "POST", body: JSON.stringify({ token: this.token, settings: this._settings() }) });
      const j = await r.json();
      if (seq !== this.estSeq) return;
      if (j.error) throw new Error(j.error);
      this.sizeLbl.textContent = `${j.exact ? "" : "≈ "}${fmtBytes(j.bytes)}`;
      this.sizeLbl.className = "ngm-size" + (j.bytes > 10 * 1048576 ? " bad" : j.bytes > 8 * 1048576 ? " warn" : "");
      this.sizeLbl.title = "Orange / red = getting close to / over Discord's 10 MB free upload limit";
    } catch (err) {
      if (seq !== this.estSeq) return;
      this.sizeLbl.className = "ngm-size";
      this.sizeLbl.textContent = "size n/a";
      this.sizeLbl.title = String(err.message || err);
    }
  }

  async doExport() {
    if (!this.token) { this.result.innerHTML = `<div class="ngm-err">Queue the workflow once first so the video loads.</div>`; return; }
    this.btnExport.disabled = true;
    this.btnExport.textContent = "Encoding…";
    this.result.innerHTML = "";
    try {
      const r = await api.fetchApi("/nougan/gif/export", { method: "POST", body: JSON.stringify({ token: this.token, settings: this._settings() }) });
      const j = await r.json();
      if (j.error) throw new Error(j.error);
      this._showResult(j);
    } catch (err) {
      const d = el("div", "ngm-err", this.result);
      d.textContent = String(err.message || err);
    } finally {
      this.btnExport.disabled = false;
      this.btnExport.textContent = "⬇ Export";
    }
  }

  _showResult(j) {
    this.result.innerHTML = "";
    const url = api.apiURL(`/view?filename=${encodeURIComponent(j.filename)}&subfolder=${encodeURIComponent(j.subfolder)}&type=${j.type}&t=${Date.now()}`);
    if (j.format === "mp4") {
      const v = el("video", "", this.result);
      v.src = url; v.loop = true; v.muted = true; v.autoplay = true; v.controls = true; v.playsInline = true;
    } else {
      el("img", "", this.result).src = url;
    }
    const row = el("div", "ngm-row", this.result);
    el("span", "", row).textContent = `${j.filename} · ${j.width}×${j.height} · ${fmtBytes(j.bytes)}`;
    const a = el("a", "", row, "Download");
    a.href = url; a.download = j.filename; a.style.color = "#f5a623";
    const cp = el("button", "", row, "Copy path");
    cp.onclick = async () => {
      try { await navigator.clipboard.writeText(j.path); cp.textContent = "Copied"; } catch (_) { cp.textContent = "Copy failed"; }
      setTimeout(() => (cp.textContent = "Copy path"), 1200);
    };
  }
}

app.registerExtension({
  name: "Nougan.GifMaker",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== NODE_NAME) return;
    injectCss();

    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onCreated ? onCreated.apply(this, arguments) : undefined;
      const editor = new GifEditor(this);
      this._nouganGif = editor;
      const widget = this.addDOMWidget("gif_editor", "nougan_gif_editor", editor.root, {
        serialize: false,
        hideOnZoom: false,
        getMinHeight: () => EDITOR_H,
      });
      widget.serialize = false;
      widget.computeSize = (w) => [w, EDITOR_H];
      try {  // put the editor on top, settings underneath
        const i = this.widgets.indexOf(widget);
        if (i > 0) { this.widgets.splice(i, 1); this.widgets.unshift(widget); }
      } catch (_) {}
      this.setSize([Math.max(this.size[0], 560), Math.max(this.size[1], EDITOR_H + 380)]);
      return r;
    };

    const onExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      const r = onExecuted ? onExecuted.apply(this, arguments) : undefined;
      this._nouganGif?.onExecuted(message);
      return r;
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;
      setTimeout(() => this._nouganGif?.restore(), 0);
      return r;
    };

    const onRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      this._nouganGif?.destroy();
      return onRemoved ? onRemoved.apply(this, arguments) : undefined;
    };
  },
});
