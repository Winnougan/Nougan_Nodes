// web/nougan_convert_video.js — Nougan Convert Video
// Visual editor for the NouganConvertVideo node.
// - Preview canvas fed by server-side thumbnails (written when the node runs)
// - Scrub with audible preview (downmixed audio from the same cache)
// - Cut list on a filmstrip timeline: split at playhead, delete segments
//   (ripple), drag boundaries with magnetic snapping to neighbors/playhead
// - Draw-a-box crop on the preview with move/resize handles
// - Codec dropdown rebuilt from /nougan/convert/probe (NVENC extras, greys)

import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

const ACCENT = "#c46bd8";

const CSS = `
.ncv-editor { box-sizing: border-box; width: 100%; height: 100%; min-height: 0; padding: 6px;
    display: flex; flex-direction: column; overflow: hidden;
    background: var(--comfy-input-bg, #1b1b21); border: 1px solid rgba(255,255,255,.08);
    border-radius: 8px; font-family: inherit; user-select: none; }
.ncv-preview { position: relative; width: 100%; flex: 1 1 140px; min-height: 90px;
    background: #000; border-radius: 5px; overflow: hidden; cursor: crosshair; }
.ncv-preview canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
.ncv-crop { position: absolute; border: 1.5px solid ${ACCENT}; border-radius: 2px;
    box-shadow: 0 0 0 9999px rgba(0,0,0,.45); cursor: move; display: none; }
.ncv-crop i { position: absolute; width: 9px; height: 9px; background: ${ACCENT};
    border-radius: 2px; }
.ncv-crop i[data-h="nw"] { left: -5px; top: -5px; cursor: nwse-resize; }
.ncv-crop i[data-h="ne"] { right: -5px; top: -5px; cursor: nesw-resize; }
.ncv-crop i[data-h="sw"] { left: -5px; bottom: -5px; cursor: nesw-resize; }
.ncv-crop i[data-h="se"] { right: -5px; bottom: -5px; cursor: nwse-resize; }
.ncv-transport { display: flex; align-items: center; gap: 8px; margin-top: 6px; flex: 0 0 auto; }
.ncv-play { width: 26px; height: 22px; border: 0; border-radius: 5px;
    background: rgba(196,107,216,.18); color: #e0b0ee; font-size: 11px; cursor: pointer; }
.ncv-play:hover { background: rgba(196,107,216,.32); }
.ncv-time { flex: 1; font-size: 11px; color: #b8b8c4; font-variant-numeric: tabular-nums;
    white-space: nowrap; overflow: hidden; }
.ncv-tools { display: flex; gap: 6px; margin-top: 6px; flex: 0 0 auto; }
.ncv-tools button { border: 0; border-radius: 5px; padding: 3px 10px; font-size: 10.5px;
    background: rgba(255,255,255,.07); color: #c5c5d2; cursor: pointer; }
.ncv-tools button:hover { background: rgba(255,255,255,.13); color: #e8e8f0; }
.ncv-timeline { position: relative; height: 58px; flex: 0 0 58px; margin-top: 6px;
    background: #101014; border-radius: 5px; overflow: hidden; cursor: crosshair; }
.ncv-timeline canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
.ncv-hint { margin-top: 5px; font-size: 10px; color: #7d7d8c; line-height: 1.45; flex: 0 0 auto; }
`;

let _styleDone = false;
function injectStyle() {
    if (_styleDone) return;
    _styleDone = true;
    const el = document.createElement("style");
    el.textContent = CSS;
    document.head.appendChild(el);
}

const r3 = (v) => Math.round(v * 1000) / 1000;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function fmt(t) {
    t = Math.max(0, t);
    const m = Math.floor(t / 60);
    const s = t - m * 60;
    return `${m}:${s < 10 ? "0" : ""}${s.toFixed(2)}`;
}

// ── Editor ───────────────────────────────────────────────────────────────────

class ConvertEditor {
    constructor(node, widgets) {
        this.node = node;
        this.wSegs = widgets.segments;
        this.wCrop = widgets.crop;
        this.wCodec = widgets.codec;

        this.mf = null;          // manifest
        this.segs = [];          // [[s,e],...] source seconds, gapless
        this.sel = -1;
        this.playhead = 0;
        this.crop = null;        // {x,y,w,h} source px
        this.playing = false;
        this.actx = null;
        this.audioBuf = null;
        this.src = null;
        this.snippet = null;
        this.imgs = new Map();   // thumb idx -> Image (loading or loaded)
        this.drag = null;
        this._raf = 0;
        this._syncing = false;
        this._lastSnippet = 0;

        injectStyle();
        this.el = document.createElement("div");
        this.el.className = "ncv-editor";
        this.el.innerHTML = `
            <div class="ncv-preview"><canvas></canvas>
                <div class="ncv-crop"><i data-h="nw"></i><i data-h="ne"></i><i data-h="sw"></i><i data-h="se"></i></div>
            </div>
            <div class="ncv-transport">
                <button class="ncv-play" title="Play kept regions">▶</button>
                <span class="ncv-time">queue the node once to load the editor</span>
            </div>
            <div class="ncv-tools">
                <button class="ncv-cut" title="Split the segment under the playhead">cut</button>
                <button class="ncv-del" title="Delete selected segment">delete</button>
                <button class="ncv-clearcrop" title="Clear crop">clear crop</button>
            </div>
            <div class="ncv-timeline"><canvas></canvas></div>
            <div class="ncv-hint">drag on preview: draw crop · drag timeline: scrub (audible) ·
                drag edges: trim/cut points (snap) · double-click timeline: cut at playhead</div>`;
        this.preview = this.el.querySelector(".ncv-preview");
        this.pCanvas = this.el.querySelector(".ncv-preview canvas");
        this.cropEl = this.el.querySelector(".ncv-crop");
        this.timeEl = this.el.querySelector(".ncv-time");
        this.tl = this.el.querySelector(".ncv-timeline");
        this.tCanvas = this.el.querySelector(".ncv-timeline canvas");
        this.playBtn = this.el.querySelector(".ncv-play");

        this._bind();
        this._ro = new ResizeObserver(() => this.draw());
        this._ro.observe(this.preview);
        this._ro.observe(this.tl);
    }

    // ── data ──
    async refresh(tries = 12) {
        try {
            const res = await fetch("/nougan/convert/manifest");
            if (!res.ok) throw new Error("no cache");
            const mf = await res.json();
            if (!mf || !mf.key) throw new Error("no cache");
            this.mf = mf;
            if (!this._restoreState()) {
                this.segs = [[0, mf.dur]];
                this.crop = null;
            }
            if (mf.has_audio && !this.audioBuf) this._loadAudio();
            this.playhead = this.segs[0][0];
            this.draw();
        } catch {
            this.mf = null;
            this.timeEl.textContent = "queue the node once to load the editor";
            if (tries > 0) setTimeout(() => this.refresh(tries - 1), 400);
        }
    }

    _restoreState() {
        // keep editor state that still fits the new source, else reset
        try {
            const segs = JSON.parse(this.wSegs.value || "[]");
            if (Array.isArray(segs) && segs.length && this.mf &&
                segs.every(([a, b]) => b > a && a < this.mf.dur + 0.01)) {
                this.segs = segs.map(([a, b]) => [clamp(a, 0, this.mf.dur), clamp(b, 0, this.mf.dur)]);
            } else return false;
            const c = JSON.parse(this.wCrop.value || "null");
            if (c && this.mf && c.w >= 16 && c.h >= 16 && c.x + c.w <= this.mf.w && c.y + c.h <= this.mf.h) {
                this.crop = c;
            } else this.crop = null;
            return true;
        } catch {
            return false;
        }
    }

    async _loadAudio() {
        try {
            const res = await fetch(`/nougan/convert/audio?k=${this.mf.key}`);
            if (!res.ok) return;
            this.audioBuf = await this._audioCtx().decodeAudioData(await res.arrayBuffer());
        } catch {}
    }

    _audioCtx() {
        if (!this.actx) this.actx = new (window.AudioContext || window.webkitAudioContext)();
        if (this.actx.state === "suspended") this.actx.resume();
        return this.actx;
    }

    thumb(srcFrame) {
        const n = this.mf.n;
        const i = clamp(Math.round(srcFrame / Math.max(1, this.mf.src_n - 1) * (n - 1)), 0, n - 1);
        let im = this.imgs.get(i);
        if (!im) {
            im = new Image();
            im.onload = () => this.draw();
            im.src = `/nougan/convert/thumb?k=${this.mf.key}&i=${i}`;
            this.imgs.set(i, im);
        }
        return im.complete && im.naturalWidth ? im : null;
    }

    // ── state -> widgets ──
    push() {
        if (this._syncing) return;
        this._syncing = true;
        try {
            this.wSegs.value = JSON.stringify(this.segs.map(([a, b]) => [r3(a), r3(b)]));
            this.wCrop.value = this.crop ? JSON.stringify(this.crop) : "";
        } finally {
            this._syncing = false;
        }
        this.draw();
    }

    // ── geometry helpers ──
    // Where the video frame sits inside the preview (contain-fit, letterboxed), in the
    // preview's own CSS px. Crop box, drawing and pointer mapping all go through this so
    // any aspect ratio (vertical video, ultra-wide) lines up and the preview can flex.
    _vidRect() {
        const w = this.preview.clientWidth, h = this.preview.clientHeight;
        if (!this.mf || !w || !h) return { x: 0, y: 0, w: w || 1, h: h || 1 };
        const s = Math.min(w / this.mf.w, h / this.mf.h);
        const vw = this.mf.w * s, vh = this.mf.h * s;
        return { x: (w - vw) / 2, y: (h - vh) / 2, w: vw, h: vh };
    }
    // pointer -> source pixels. Divides out canvas zoom (rect size vs layout size).
    _srcPoint(e) {
        const r = this.preview.getBoundingClientRect();
        const k = r.width / (this.preview.clientWidth || 1) || 1;
        const v = this._vidRect();
        return [
            clamp((e.clientX - r.left) / k - v.x, 0, v.w) / v.w * this.mf.w,
            clamp((e.clientY - r.top) / k - v.y, 0, v.h) / v.h * this.mf.h,
        ];
    }
    _tlRect() { return this.tl.getBoundingClientRect(); }
    _timeAt(clientX) {
        const r = this._tlRect();
        return clamp((clientX - r.left) / r.width, 0, 1) * this.mf.dur;
    }
    _xOf(t) { return (t / this.mf.dur) * this._tlRect().width; }
    _bounds() { return [...this.segs.flat()]; }

    // magnetic snap: nearest candidate within threshold
    _snap(t, excludeIdx) {
        const px = 7;
        const th = (px / this._tlRect().width) * this.mf.dur;
        let best = t, bd = th;
        const cands = [0, this.mf.dur, this.playhead,
            ...this._bounds().filter((_, i) => i !== excludeIdx)];
        for (const c of cands) {
            const d = Math.abs(c - t);
            if (d < bd) { bd = d; best = c; }
        }
        return best;
    }

    _segAt(t) { return this.segs.findIndex(([a, b]) => t >= a && t <= b); }

    // ── interactions: preview crop box ──
    _bind() {
        const pct = this.preview;

        pct.addEventListener("pointerdown", (e) => {
            if (!this.mf) return;
            e.preventDefault();
            pct.setPointerCapture(e.pointerId);
            const [px, py] = this._srcPoint(e);
            const c = this.crop;
            const hov = e.target.dataset?.h;
            if (c && hov) this.drag = { mode: "resize", h: hov };
            else if (c && px >= c.x && px <= c.x + c.w && py >= c.y && py <= c.y + c.h)
                this.drag = { mode: "move", ox: px - c.x, oy: py - c.y };
            else {
                this.crop = { x: px, y: py, w: 0, h: 0 };
                this.drag = { mode: "draw", ax: px, ay: py };
            }
            this._applyCropDrag(px, py);
        });
        pct.addEventListener("pointermove", (e) => {
            if (!this.drag || !this.mf) return;
            this._applyCropDrag(...this._srcPoint(e));
        });
        const up = () => {
            if (this.crop && (this.crop.w < 16 || this.crop.h < 16)) this.crop = null;
            if (this.drag) this.push();
            this.drag = null;
        };
        pct.addEventListener("pointerup", up);
        pct.addEventListener("pointercancel", up);

        // ── interactions: timeline ──
        this.tl.addEventListener("pointerdown", (e) => {
            if (!this.mf) return;
            e.preventDefault();
            this.tl.setPointerCapture(e.pointerId);
            const t = this._timeAt(e.clientX);
            const x = e.clientX - this._tlRect().left;
            const b = this._bounds();
            // near a boundary? -> drag it (magnetic). else scrub / select.
            for (let i = 0; i < b.length; i++) {
                if (Math.abs(x - this._xOf(b[i])) <= 6) {
                    this.drag = { mode: "bound", i };
                    return;
                }
            }
            const si = this._segAt(t);
            if (si >= 0 && e.target.closest?.(".ncv-timeline")) {
                this.sel = si;
                this.drag = { mode: "scrub" };
                this.playhead = t;
                this._audition(t);
                this.draw();
            }
        });
        this.tl.addEventListener("pointermove", (e) => {
            if (!this.drag || !this.mf) return;
            const t = this._timeAt(e.clientX);
            if (this.drag.mode === "bound") {
                const i = this.drag.i;
                const si = Math.floor(i / 2);
                const isStart = i % 2 === 0;
                const s = this._snap(t, i);
                if (isStart) {
                    this.segs[si][0] = clamp(s, 0, this.segs[si][1] - 0.04);
                    if (si > 0) this.segs[si][0] = Math.max(this.segs[si][0], this.segs[si - 1][1]);
                    this.playhead = this.segs[si][0];
                } else {
                    this.segs[si][1] = clamp(s, this.segs[si][0] + 0.04, this.mf.dur);
                    if (si < this.segs.length - 1) this.segs[si][1] = Math.min(this.segs[si][1], this.segs[si + 1][0]);
                    this.playhead = this.segs[si][1];
                }
                this.push();
            } else if (this.drag.mode === "scrub") {
                this.playhead = t;
                this._audition(t);
                this.draw();
            }
        });
        const tlUp = () => { this.drag = null; };
        this.tl.addEventListener("pointerup", tlUp);
        this.tl.addEventListener("pointercancel", tlUp);
        this.tl.addEventListener("dblclick", (e) => {
            if (!this.mf) return;
            this.playhead = this._timeAt(e.clientX);
            this.cutAtPlayhead();
        });

        this.playBtn.addEventListener("click", () => {
            if (!this.mf) return;
            this._audioCtx();
            this.playing ? this.stop() : this.play();
        });
        this.el.querySelector(".ncv-cut").addEventListener("click", () => this.cutAtPlayhead());
        this.el.querySelector(".ncv-del").addEventListener("click", () => this.deleteSelected());
        this.el.querySelector(".ncv-clearcrop").addEventListener("click", () => {
            this.crop = null;
            this.push();
        });
    }

    _applyCropDrag(px, py) {
        const c = this.crop;
        if (!c || !this.drag) return;
        const W = this.mf.w, H = this.mf.h;
        if (this.drag.mode === "draw") {
            c.x = clamp(Math.min(this.drag.ax, px), 0, W);
            c.y = clamp(Math.min(this.drag.ay, py), 0, H);
            c.w = Math.abs(px - this.drag.ax);
            c.h = Math.abs(py - this.drag.ay);
        } else if (this.drag.mode === "move") {
            c.x = clamp(px - this.drag.ox, 0, W - c.w);
            c.y = clamp(py - this.drag.oy, 0, H - c.h);
        } else {
            const h = this.drag.h;
            if (h.includes("w")) { const x2 = c.x + c.w; c.x = clamp(px, 0, x2 - 16); c.w = x2 - c.x; }
            if (h.includes("e")) { c.w = clamp(px - c.x, 16, W - c.x); }
            if (h.includes("n")) { const y2 = c.y + c.h; c.y = clamp(py, 0, y2 - 16); c.h = y2 - c.y; }
            if (h.includes("s")) { c.h = clamp(py - c.y, 16, H - c.y); }
        }
        this.draw();
    }

    // ── edits ──
    cutAtPlayhead() {
        if (!this.mf) return;
        const t = this.playhead;
        const si = this._segAt(t);
        if (si < 0) return;
        const [a, b] = this.segs[si];
        if (t - a < 0.04 || b - t < 0.04) return;
        this.segs.splice(si, 1, [a, t], [t, b]);
        this.sel = si;
        this.push();
    }

    deleteSelected() {
        if (this.sel < 0 || this.segs.length <= 1) return;
        this.segs.splice(this.sel, 1);
        this.sel = Math.min(this.sel, this.segs.length - 1);
        this.push();
    }

    // ── audible scrub + playback ──
    _audition(t) {
        if (!this.audioBuf) return;
        const now = performance.now();
        if (now - this._lastSnippet < 45) return;
        this._lastSnippet = now;
        try { this.snippet?.stop(); } catch {}
        const start = Math.max(0, Math.min(t, this.audioBuf.duration - 0.05));
        const src = this._audioCtx().createBufferSource();
        const gain = this.actx.createGain();
        gain.gain.value = 0.8;
        src.buffer = this.audioBuf;
        src.connect(gain).connect(this.actx.destination);
        src.start(0, start, Math.min(0.22, this.audioBuf.duration - start));
        this.snippet = src;
    }

    play() {
        this.stopSources();
        let si = this._segAt(this.playhead);
        if (si < 0) si = this.segs.findIndex(([a]) => a > this.playhead);
        if (si < 0) return;
        this.sel = si;
        this.playhead = Math.max(this.playhead, this.segs[si][0]);
        if (this.audioBuf) {
            this.src = this._audioCtx().createBufferSource();
            this.src.buffer = this.audioBuf;
            this.src.connect(this.actx.destination);
            this.src.start(0, this.playhead);
        }
        this._t0 = performance.now();
        this._tPlayhead = this.playhead;
        this.playing = true;
        this.playBtn.textContent = "⏸";
        const tick = () => {
            if (!this.playing) return;
            const now = performance.now();
            let t = this._tPlayhead + (now - this._t0) / 1000;
            while (si < this.segs.length && t > this.segs[si][1]) {
                si++;
                if (si >= this.segs.length) { this.stop(); return; }
                t = this.segs[si][0];
                this._t0 = now;
                this._tPlayhead = t;
                if (this.audioBuf) {
                    try { this.src?.stop(); } catch {}
                    this.src = this._audioCtx().createBufferSource();
                    this.src.buffer = this.audioBuf;
                    this.src.connect(this.actx.destination);
                    this.src.start(0, t);
                }
            }
            this.playhead = t;
            this.draw();
            this._raf = requestAnimationFrame(tick);
        };
        this._raf = requestAnimationFrame(tick);
    }

    stopSources() {
        try { this.src?.stop(); } catch {}
        try { this.snippet?.stop(); } catch {}
        this.src = this.snippet = null;
    }

    stop() {
        this.playing = false;
        cancelAnimationFrame(this._raf);
        this.stopSources();
        this.playBtn.textContent = "▶";
        this.draw();
    }

    // ── drawing ──
    draw() {
        if (this._disposed || !this.mf) return;
        this._drawPreview();
        this._drawTimeline();
        const outDur = this.segs.reduce((s, [a, b]) => s + b - a, 0);
        this.timeEl.textContent =
            `${fmt(this.playhead)}  ·  kept ${fmt(outDur)} of ${fmt(this.mf.dur)}` +
            (this.crop ? `  ·  crop ${Math.round(this.crop.w)}×${Math.round(this.crop.h)}` : "");
    }

    _drawPreview() {
        const w = this.preview.clientWidth, h = this.preview.clientHeight;
        if (!w || !h) return;
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
        if (this.pCanvas.width !== pw || this.pCanvas.height !== ph) { this.pCanvas.width = pw; this.pCanvas.height = ph; }
        const ctx = this.pCanvas.getContext("2d");
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, w, h);
        const im = this.thumb(this.playhead * this.mf.fps);
        const v = this._vidRect();
        if (im) ctx.drawImage(im, v.x, v.y, v.w, v.h);   // contain-fit
        // crop overlay (source px -> frame rect inside the preview)
        if (this.crop) {
            const sx = v.w / this.mf.w, sy = v.h / this.mf.h;
            Object.assign(this.cropEl.style, {
                display: "block",
                left: `${v.x + this.crop.x * sx}px`, top: `${v.y + this.crop.y * sy}px`,
                width: `${this.crop.w * sx}px`, height: `${this.crop.h * sy}px`,
            });
        } else {
            this.cropEl.style.display = "none";
        }
    }

    _drawTimeline() {
        const w = this.tl.clientWidth, h = this.tl.clientHeight;
        if (!w || !h) return;
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const tw = Math.round(w * dpr), th = Math.round(h * dpr);
        if (this.tCanvas.width !== tw || this.tCanvas.height !== th) { this.tCanvas.width = tw; this.tCanvas.height = th; }
        const ctx = this.tCanvas.getContext("2d");
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = "#101014";
        ctx.fillRect(0, 0, w, h);
        // filmstrip
        const step = 6;
        for (let x = 0; x < w; x += step) {
            const t = (x / w) * this.mf.dur;
            const im = this.thumb(t * this.mf.fps);
            if (im) {
                const s = Math.max(step / im.naturalWidth, h / im.naturalHeight);
                ctx.drawImage(im, x - (im.naturalWidth * s - step) / 2, (h - im.naturalHeight * s) / 2,
                    im.naturalWidth * s, im.naturalHeight * s);
            }
        }
        const x = (t) => (t / this.mf.dur) * w;
        // cut regions dark
        let prev = 0;
        for (const [a, b] of this.segs) {
            ctx.fillStyle = "rgba(0,0,0,.62)";
            ctx.fillRect(x(prev), 0, Math.max(0, x(a) - x(prev)), h);
            prev = b;
        }
        ctx.fillStyle = "rgba(0,0,0,.62)";
        ctx.fillRect(x(prev), 0, w - x(prev), h);
        // kept tint + selection
        this.segs.forEach(([a, b], i) => {
            ctx.fillStyle = i === this.sel ? "rgba(196,107,216,.30)" : "rgba(196,107,216,.12)";
            ctx.fillRect(x(a), 0, x(b) - x(a), h);
        });
        // boundaries
        ctx.fillStyle = ACCENT;
        for (const t of this._bounds()) ctx.fillRect(x(t) - 0.75, 0, 1.5, h);
        // playhead
        ctx.fillStyle = "#f2f2f2";
        ctx.fillRect(x(this.playhead) - 0.75, 0, 1.5, h);
    }

    dispose() {
        this._disposed = true;
        this._ro.disconnect();
        this.stop();
        this.actx?.close();
    }
}

// ── ComfyUI extension wiring ─────────────────────────────────────────────────

const MIN_NODE_W = 400;
const EDITOR_MIN_H = 320;   // smallest height the editor widget may be given (preview flexes above this)
const EDITOR_EXTRA_H = 64;  // extra room on first creation so the preview starts roomy

// Hide an editor-driven widget so it takes no space on any frontend version.
function hideWidget(w) {
    w.hidden = true;                                   // newer frontends skip it entirely
    w.type = "hidden";                                 // legacy litegraph
    w.computeSize = () => [0, -4];
    w.computeLayoutSize = () => ({ minHeight: 0, maxHeight: 0, minWidth: 0 });
    w.computedHeight = 0;
}

// Grow the node to at least what its widgets need. Uses setSize() (not size[1] = ...)
// so the layout engine hears about it; a bare mutation is why the DOM box used to
// look wrong until you dragged the node bigger.
function fitNode(node) {
    try {
        const need = node.computeSize();
        const w = Math.max(node.size[0], MIN_NODE_W, need[0]);
        const h = Math.max(node.size[1], need[1]);
        if (w !== node.size[0] || h !== node.size[1]) node.setSize([w, h]);
        node.setDirtyCanvas?.(true, true);
    } catch {}
}

app.registerExtension({
    name: "Nougan.ConvertVideo",
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "NouganConvertVideo") return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            onNodeCreated?.apply(this, arguments);
            const widgets = {
                codec: this.widgets?.find((w) => w.name === "codec"),
                segments: this.widgets?.find((w) => w.name === "segments"),
                crop: this.widgets?.find((w) => w.name === "crop"),
            };
            if (!widgets.codec || !widgets.segments || !widgets.crop) return;

            // cut list + crop are editor-driven; keep them off the node face
            for (const w of [widgets.segments, widgets.crop]) hideWidget(w);

            const editor = new ConvertEditor(this, widgets);
            this._ncvEditor = editor;
            this.addDOMWidget("convert_editor", "convert_editor", editor.el, {
                serialize: false, hideOnZoom: true,
                getMinHeight: () => EDITOR_MIN_H,   // node can't be shrunk below this
            });
            const need = this.computeSize();
            this.setSize([Math.max(need[0], MIN_NODE_W), need[1] + EDITOR_EXTRA_H]);
            // re-check once the DOM element is mounted and laid out
            requestAnimationFrame(() => fitNode(this));

            // codec dropdown from the live probe (greys out what won't run,
            // appends NVENC variants when the GPU encoder exists)
            fetch("/nougan/convert/probe").then((r) => r.json()).then((caps) => {
                if (!caps?.codecs) return;
                const avail = caps.codecs.filter((c) => c.ok).map((c) => c.label);
                const cur = widgets.codec.value;
                widgets.codec.options.values =
                    avail.includes(cur) ? avail : [...avail, cur];
            }).catch(() => {});

            editor.refresh();
        };

        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            onConfigure?.apply(this, arguments);
            // workflows saved with the old (too small) size get bumped up to the real minimum
            requestAnimationFrame(() => fitNode(this));
            this._ncvEditor?.refresh();
        };

        const onExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function () {
            onExecuted?.apply(this, arguments);
            // cache is written during the run; poll for the fresh manifest
            this._ncvEditor?.refresh();
        };

        const onRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            onRemoved?.apply(this, arguments);
            this._ncvEditor?.dispose();
            this._ncvEditor = null;
        };
    },
});
