// web/nougan_r34_scraper.js — Nougan R34 Scraper
// Live preview + progress for the NouganR34Scraper node. Polls
// /nougan/r34/state while the node downloads; shows the newest image, a
// progress bar and the exact folder files are being saved to (always inside
// ComfyUI's output folder). The preview pane collapses when show_preview is off.
// The Stop button hard-stops the run (POST /nougan/r34/stop).

import { app } from "../../../scripts/app.js";

const MIN_NODE_W = 360;
const MIN_H_PREVIEW = 240;   // editor min height with the preview shown
const MIN_H_COMPACT = 96;    // editor min height with the preview hidden
const EXTRA_H = 90;          // extra room on first creation so the preview starts roomy

const CSS = `
.nr34-editor { box-sizing: border-box; width: 100%; height: 100%; min-height: 0; padding: 6px;
    display: flex; flex-direction: column; overflow: hidden;
    background: var(--comfy-input-bg, #1b1b21); border: 1px solid rgba(255,255,255,.08);
    border-radius: 8px; font-family: inherit; }
.nr34-preview { position: relative; width: 100%; flex: 1 1 140px; min-height: 80px;
    background: #0c0c10; border-radius: 5px; overflow: hidden; display: flex;
    align-items: center; justify-content: center; }
.nr34-preview img { position: absolute; inset: 0; width: 100%; height: 100%;
    object-fit: contain; display: none; }
.nr34-empty { color: #6b6b78; font-size: 11px; }
.nr34-bar { flex: 0 0 8px; height: 8px; margin-top: 6px; border-radius: 4px;
    background: rgba(255,255,255,.07); overflow: hidden; }
.nr34-fill { height: 100%; width: 0%; border-radius: 4px;
    background: linear-gradient(90deg, #8e44ad, #c46bd8); transition: width .25s ease; }
.nr34-row { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; margin-top: 5px; }
.nr34-status { flex: 1 1 auto; min-width: 0; font-size: 10.5px; color: #a5a5b3;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    font-variant-numeric: tabular-nums; }
.nr34-stop { flex: 0 0 auto; padding: 2px 10px; font-size: 11px; line-height: 1.4;
    color: #ffd9d9; background: #5c2020; border: 1px solid #8f3535; border-radius: 4px;
    cursor: pointer; font-family: inherit; }
.nr34-stop:hover:not(:disabled) { background: #7a2a2a; }
.nr34-stop:disabled { opacity: .35; cursor: default; }
.nr34-dest { flex: 0 0 auto; margin-top: 5px; font-size: 10px; color: #7d7d8c;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
`;

let _styleDone = false;
function injectStyle() {
    if (_styleDone) return;
    _styleDone = true;
    const el = document.createElement("style");
    el.textContent = CSS;
    document.head.appendChild(el);
}

// Grow the node to at least what its widgets need. setSize() (not size[1] = ...)
// so the layout engine hears about it; bare mutation is what made the DOM box
// spill out of the node until you dragged it bigger.
function fitNode(node) {
    try {
        const need = node.computeSize();
        const w = Math.max(node.size[0], MIN_NODE_W, need[0]);
        const h = Math.max(node.size[1], need[1]);
        if (w !== node.size[0] || h !== node.size[1]) node.setSize([w, h]);
        node.setDirtyCanvas?.(true, true);
    } catch {}
}

class R34Editor {
    constructor(node, widgets) {
        this.node = node;
        this.wShow = widgets.show;
        this.wUrl = widgets.url;
        this.wFolder = widgets.folder;
        this._timer = 0;
        this._lastDone = -1;
        this._imgKey = "";
        this._destSig = null;
        this._stopping = false;
        this._showWas = !!this.wShow.value;

        injectStyle();
        this.el = document.createElement("div");
        this.el.className = "nr34-editor";
        this.el.innerHTML = `
            <div class="nr34-preview">
                <img alt="">
                <span class="nr34-empty">idle — queue the node to scrape</span>
            </div>
            <div class="nr34-bar"><div class="nr34-fill"></div></div>
            <div class="nr34-row">
                <div class="nr34-status">0 / 0</div>
                <button class="nr34-stop" type="button" disabled title="Hard-stop the current run (files already saved are kept)">■ Stop</button>
            </div>
            <div class="nr34-dest">saving to: …</div>`;
        this.preview = this.el.querySelector(".nr34-preview");
        this.img = this.el.querySelector(".nr34-preview img");
        this.empty = this.el.querySelector(".nr34-empty");
        this.fill = this.el.querySelector(".nr34-fill");
        this.status = this.el.querySelector(".nr34-status");
        this.stopBtn = this.el.querySelector(".nr34-stop");
        this.dest = this.el.querySelector(".nr34-dest");

        this.stopBtn.addEventListener("click", (e) => { e.stopPropagation(); this._stop(); });
        this.stopBtn.addEventListener("pointerdown", (e) => e.stopPropagation());

        this._applyToggle();
        this.poll();
    }

    get minHeight() {
        return this.wShow.value ? MIN_H_PREVIEW : MIN_H_COMPACT;
    }

    async _stop() {
        if (this._stopping) return;
        this._stopping = true;
        this.stopBtn.disabled = true;
        this.stopBtn.textContent = "stopping…";
        try { await fetch("/nougan/r34/stop", { method: "POST" }); } catch {}
    }

    _showImage(on) {
        this.img.style.display = on ? "block" : "none";
        this.empty.style.display = on ? "none" : "";
    }

    _applyToggle() {
        const on = !!this.wShow.value;
        this.preview.style.display = on ? "flex" : "none";
        if (on !== this._showWas) {
            this._showWas = on;
            const node = this.node;
            if (on) {
                fitNode(node);
            } else {
                // preview gone: pull the node back to the compact size
                try { node.setSize([node.size[0], node.computeSize()[1]]); } catch {}
                node.setDirtyCanvas?.(true, true);
            }
        }
    }

    // Ask the server where files will land for the current url/folder values
    // (the server owns the rules: always inside ComfyUI's output folder).
    async _resolveDest() {
        const folder = this.wFolder?.value ?? "";
        const url = this.wUrl?.value ?? "";
        const sig = folder + "\n" + url;
        if (sig === this._destSig) return;
        this._destSig = sig;
        try {
            const res = await fetch(
                `/nougan/r34/resolve?folder=${encodeURIComponent(folder)}&url=${encodeURIComponent(url)}`);
            if (!res.ok) return;
            const { dest } = await res.json();
            if (dest) {
                this.dest.textContent = `saving to: ${dest}`;
                this.dest.title = dest;
            }
        } catch {
            this._destSig = null;   // retry next tick
        }
    }

    async poll() {
        if (this._disposed) return;
        clearTimeout(this._timer);
        try {
            this._applyToggle();
            this._resolveDest();
            const res = await fetch("/nougan/r34/state");
            if (res.ok) this._render(await res.json());
        } catch {}
        this._timer = setTimeout(() => this.poll(), 500);
    }

    _render(st) {
        // Stop button: live only while a run is going
        if (!st.running) this._stopping = false;
        this.stopBtn.disabled = !st.running || this._stopping;
        this.stopBtn.textContent = this._stopping ? "stopping…" : "■ Stop";

        const total = st.total || 0;
        const frac = total ? Math.min(1, (st.done || 0) / total) : 0;
        this.fill.style.width = `${frac * 100}%`;

        if (!st.running && !total && !st.files?.length) {
            this.status.textContent = st.stopped
                ? "stopped"
                : st.error
                    ? `error — ${st.error}`
                    : st.magick === false
                        ? "idle — ImageMagick not found on PATH (convert/compress will fail)"
                        : "0 / 0";
            this.status.title = st.error || "";
            if (this._lastDone !== 0) {
                this._showImage(false);
                this._imgKey = "";
            }
            this._lastDone = 0;
            return;
        }
        this._lastDone = 1;

        // "done" counts posts handled (so the bar can reach 100%); "images" counts files saved
        const images = st.images ?? st.files?.length ?? 0;
        const parts = [];
        if (st.running) {
            parts.push(`downloading ${st.done}/${total}`);
            parts.push(`${images} image${images === 1 ? "" : "s"}`);
            if (st.current) parts.push(st.current);
            if (st.skipped) parts.push(`${st.skipped} skipped`);
            if (st.failed) parts.push(`${st.failed} failed`);
        } else {
            parts.push(`${st.stopped ? "stopped" : "done"} — ${images} image${images === 1 ? "" : "s"}`);
            if (st.skipped) parts.push(`${st.skipped} skipped`);
            if (st.failed) parts.push(`${st.failed} failed`);
            if (st.error) parts.push(st.error);
        }
        this.status.textContent = parts.join(" · ");
        this.status.title = st.error || "";

        const files = st.files || [];
        if (files.length && st.folder) {
            const latest = files[files.length - 1];
            // Only reload when something actually changed (the old code stamped a fresh
            // timestamp every poll, so the image re-downloaded and flickered twice a second).
            const key = `${st.folder}|${latest}|${images}|${st.running}`;
            if (key !== this._imgKey) {
                this._imgKey = key;
                // /view wants the sub-folder and file name as SEPARATE params
                // (it basename()s `filename`, so "folder/file.jpg" lost the folder).
                this.img.src = `/view?filename=${encodeURIComponent(latest)}` +
                    `&subfolder=${encodeURIComponent(st.folder)}&type=output&rand=${Date.now()}`;
                this._showImage(true);
            }
        }
    }

    dispose() {
        this._disposed = true;
        clearTimeout(this._timer);
    }
}

app.registerExtension({
    name: "Nougan.R34Scraper",
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "NouganR34Scraper") return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            onNodeCreated?.apply(this, arguments);
            const find = (n) => this.widgets?.find((w) => w.name === n);
            const widgets = { show: find("show_preview"), url: find("url"), folder: find("folder") };
            if (!widgets.show) return;

            const editor = new R34Editor(this, widgets);
            this._nr34Editor = editor;
            this.addDOMWidget("r34_preview", "r34_preview", editor.el, {
                serialize: false, hideOnZoom: true,
                getMinHeight: () => editor.minHeight,   // node can't be shrunk below this
            });
            const need = this.computeSize();
            this.setSize([Math.max(need[0], MIN_NODE_W), need[1] + (widgets.show.value ? EXTRA_H : 0)]);
            requestAnimationFrame(() => fitNode(this));   // re-check once the DOM is mounted

            const cb = widgets.show.callback;
            widgets.show.callback = function () {
                cb?.apply(this, arguments);
                editor._applyToggle();
            };
        };

        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            onConfigure?.apply(this, arguments);
            // workflows saved with the old (too small) size get bumped to the real minimum
            requestAnimationFrame(() => {
                this._nr34Editor && (this._nr34Editor._showWas = !!this._nr34Editor.wShow.value);
                this._nr34Editor && (this._nr34Editor._destSig = null);
                fitNode(this);
            });
        };

        const onRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            onRemoved?.apply(this, arguments);
            this._nr34Editor?.dispose();
            this._nr34Editor = null;
        };
    },
});
