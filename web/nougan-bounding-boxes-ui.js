// nougan-bounding-boxes-ui.js -- Nougan Bounding Boxes editor (classic LiteGraph DOM widget, no Nodes 2.0 needed)
//
//  - drag on the canvas to draw a box (Draw tool, D) -- click a box to select it
//  - Select tool (V): drag a box to move it, drag its handles to resize (hold Shift to draw instead)
//  - layer order = box number: first box is the background, last is the foreground
//  - Delete removes, arrows nudge (Shift = bigger steps), Ctrl+D duplicates
//  - state is stored as 0-1 fractions in the hidden `editor_state` widget, so it survives resolution changes

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_NAME = "NouganBoundingBoxes";
const STATE = "editor_state";
const LAST = "last_incoming";
const WIDTH = 600;
const MAX_STAGE_H = 400;
const GRID = 16;
const MAX_PALETTE = 5;


// -- helpers ----------------------------------------------------------------

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const isHex = (s) => typeof s === "string" && /^#[0-9a-f]{6}$/i.test(s);

function hslHex(h, s, l) {
    s /= 100; l /= 100;
    const k = (n) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    const to = (x) => Math.round(255 * x).toString(16).padStart(2, "0");
    return ("#" + to(f(0)) + to(f(8)) + to(f(4))).toUpperCase();
}

const autoHex = (i) => hslHex((i * 47 + 12) % 360, 72, 60);

function textOn(hex) {
    const n = parseInt(hex.slice(1), 16);
    const lum = 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
    return lum > 140 ? "#000" : "#fff";
}

const regionColor = (r, i) => (isHex(r.palette?.[0]) ? r.palette[0].toUpperCase() : autoHex(i));

const newRegion = (extra) => ({ x: 0.25, y: 0.25, w: 0.5, h: 0.5, type: "obj", text: "", desc: "", palette: [], ...extra });

// pixel boxes (the BOUNDING_BOX socket format) -> regions
function boxesToRegions(boxes, W, H) {
    const out = [];
    for (const b of boxes || []) {
        if (!b || typeof b !== "object") continue;
        const m = b.metadata && typeof b.metadata === "object" ? b.metadata : {};
        out.push(newRegion({
            x: (b.x || 0) / W, y: (b.y || 0) / H, w: (b.width || 0) / W, h: (b.height || 0) / H,
            type: m.type === "text" ? "text" : "obj",
            text: m.text || "", desc: m.desc || "",
            palette: Array.isArray(m.palette) ? m.palette.filter(isHex).map(c => c.toUpperCase()) : [],
        }));
    }
    return out;
}

// elements ([ymin, xmin, ymax, xmax] on a 0-1000 grid) -> regions
function elementsToRegions(els) {
    const out = [];
    for (const e of els || []) {
        if (!e || !Array.isArray(e.bbox) || e.bbox.length !== 4) continue;
        const [y0, x0, y1, x1] = e.bbox.map(v => Number(v) / 1000);
        out.push(newRegion({
            x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0),
            type: e.type === "text" ? "text" : "obj",
            text: e.type === "text" ? (e.text || "") : "", desc: e.desc || "",
            palette: Array.isArray(e.color_palette) ? e.color_palette.filter(isHex).map(c => c.toUpperCase()) : [],
        }));
    }
    return out;
}

function regionsToElements(regions) {
    const g = (v) => clamp(Math.round(v * 1000), 0, 1000);
    return regions.map(r => {
        const el = { type: r.type === "text" ? "text" : "obj" };
        const y0 = g(r.y), x0 = g(r.x), y1 = g(r.y + r.h), x1 = g(r.x + r.w);
        el.bbox = [Math.min(y0, y1), Math.min(x0, x1), Math.max(y0, y1), Math.max(x0, x1)];
        if (el.type === "text") el.text = r.text || "";
        el.desc = r.desc || "";
        const pal = (r.palette || []).filter(isHex).map(c => c.toUpperCase()).slice(0, MAX_PALETTE);
        if (pal.length) el.color_palette = pal;
        return el;
    });
}

function regionsToPixelBoxes(regions, W, H) {
    return regions.map(r => {
        let x = r.x, y = r.y, w = r.w, h = r.h;
        if (w < 0) { x += w; w = -w; }
        if (h < 0) { y += h; h = -h; }
        return {
            x: Math.round(x * W), y: Math.round(y * H), width: Math.round(w * W), height: Math.round(h * H),
            metadata: { type: r.type, text: r.text || "", desc: r.desc || "", palette: (r.palette || []).slice(0, MAX_PALETTE) },
        };
    });
}

function parseImport(text, W, H) {
    const data = JSON.parse(text);
    const list = Array.isArray(data) ? data : [data];
    if (Array.isArray(list[0])) list.splice(0, list.length, ...list[0]);     // BOUNDING_BOX frame list
    if (!list.length) return [];
    if (list[0].bbox) return elementsToRegions(list);
    if ("x" in list[0] && "width" in list[0]) return boxesToRegions(list, W, H);
    throw new Error("expected prompt elements (with a 'bbox') or pixel boxes (x, y, width, height)");
}

function hideWidget(w) {
    if (!w || w._nbbHidden) return;
    w._nbbHidden = true;

    const el = w.element || w.inputEl;
    if (el) { el.style.display = "none"; el.style.height = "0"; el.style.pointerEvents = "none"; }

    w.computeSize = () => [0, 0];
    w.draw = () => { };
}

const wget = (node, name) => node.widgets?.find(w => w.name === name);
const isLinked = (node, name) => node.inputs?.some(i => i.name === name && i.link != null);


// -- styles -----------------------------------------------------------------

let _styled = false;

function styles() {
    if (_styled) return;
    _styled = true;

    const s = document.createElement("style");
    s.textContent = `
.nbb{--bg:#12141a;--card:#1a1d26;--card2:#20242f;--line:#2a2f3c;--fg:#e8ebf2;--dim:#8a93a6;--acc:#f5a524;--acc2:#ff7a18;--neg:#f0616d;
  font:12px/1.3 'Inter','Segoe UI',system-ui,sans-serif;color:var(--fg);user-select:none;box-sizing:border-box;width:100%;
  padding:10px;border-radius:12px;border:1px solid var(--line);
  background:radial-gradient(120% 80% at 0% 0%,rgba(245,165,36,.07),transparent 55%),var(--bg);
  box-shadow:0 8px 26px rgba(0,0,0,.5),inset 0 1px 0 rgba(255,255,255,.04)}
.nbb *{box-sizing:border-box}
.nbb button{font:inherit;color:inherit}

.nbb-bar{display:flex;align-items:center;gap:6px;margin-bottom:8px;flex-wrap:wrap}
.nbb-logo{width:4px;height:18px;border-radius:2px;background:linear-gradient(180deg,var(--acc),var(--acc2));box-shadow:0 0 10px rgba(245,165,36,.6)}
.nbb-title{font-weight:800;letter-spacing:.16em;font-size:11px;white-space:nowrap}
.nbb-dims{font-size:10px;font-weight:700;color:var(--dim);background:var(--card);border:1px solid var(--line);padding:2px 8px;border-radius:99px;white-space:nowrap}
.nbb-sp{flex:1}
.nbb-tb{cursor:pointer;font-size:10.5px;font-weight:700;letter-spacing:.06em;color:var(--dim);background:var(--card);
  border:1px solid var(--line);border-radius:7px;padding:4px 10px;white-space:nowrap;transition:all .15s}
.nbb-tb:hover{color:var(--acc);border-color:#4a3b1e;background:var(--card2)}
.nbb-tb.on{color:#1a1206;background:linear-gradient(180deg,#ffc35c,var(--acc));border-color:#c9821a}
.nbb-tb.warn{color:#fff;background:var(--neg);border-color:var(--neg)}

.nbb-area{width:100%;display:flex;justify-content:center;padding:2px 0 8px}
.nbb-stage{position:relative;outline:none;border:1px solid #343a4b;border-radius:6px;overflow:hidden;touch-action:none;cursor:crosshair;
  background-color:#0d0f14;
  background-image:linear-gradient(rgba(255,255,255,.045) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.045) 1px,transparent 1px);
  background-size:12.5% 12.5%}
.nbb-stage.sel{cursor:default}
.nbb-stage:focus-visible{border-color:var(--acc)}
.nbb-bg{position:absolute;inset:0;width:100%;height:100%;object-fit:fill;opacity:.4;pointer-events:none;-webkit-user-drag:none}
.nbb-boxes{position:absolute;inset:0}
.nbb-hint{position:absolute;left:8px;bottom:6px;font-size:9.5px;color:rgba(255,255,255,.35);pointer-events:none;letter-spacing:.04em}
.nbb-empty{position:absolute;inset:0;display:grid;place-items:center;color:rgba(255,255,255,.3);font-size:12px;pointer-events:none;text-align:center;padding:10px}

.nbb-box{position:absolute;border:2px solid var(--c);background:color-mix(in srgb,var(--c) 11%,transparent);
  overflow:visible;cursor:inherit}
.nbb-box.sel{background:color-mix(in srgb,var(--c) 20%,transparent);box-shadow:0 0 0 1px #000,0 0 14px color-mix(in srgb,var(--c) 70%,transparent);z-index:5}
.nbb-box.text{border-style:dashed}
.nbb-tag{position:absolute;left:-2px;top:-2px;font-size:9.5px;font-weight:800;line-height:1;padding:3px 5px;background:var(--c);color:var(--tc);
  border-radius:0 0 4px 0;pointer-events:none}
.nbb-body{position:absolute;inset:16px 3px 2px 3px;overflow:hidden;font-size:9.5px;line-height:1.25;color:var(--c);
  filter:brightness(1.25);pointer-events:none;word-break:break-word}
.nbb-h{position:absolute;width:11px;height:11px;margin:-6px 0 0 -6px;background:#fff;border:2px solid var(--c);border-radius:3px;z-index:6;box-shadow:0 0 0 1px #000}
.nbb-h[data-h=nw]{left:0;top:0;cursor:nwse-resize}.nbb-h[data-h=n]{left:50%;top:0;cursor:ns-resize}
.nbb-h[data-h=ne]{left:100%;top:0;cursor:nesw-resize}.nbb-h[data-h=e]{left:100%;top:50%;cursor:ew-resize}
.nbb-h[data-h=se]{left:100%;top:100%;cursor:nwse-resize}.nbb-h[data-h=s]{left:50%;top:100%;cursor:ns-resize}
.nbb-h[data-h=sw]{left:0;top:100%;cursor:nesw-resize}.nbb-h[data-h=w]{left:0;top:50%;cursor:ew-resize}

.nbb-cols{display:grid;grid-template-columns:minmax(150px,38%) 1fr;gap:8px}
.nbb-layers,.nbb-insp{background:var(--card);border:1px solid var(--line);border-radius:9px;padding:7px;min-width:0}
.nbb-lh{display:flex;align-items:baseline;gap:6px;font-size:9.5px;font-weight:800;letter-spacing:.14em;color:var(--dim);margin-bottom:6px}
.nbb-lh span{font-weight:500;letter-spacing:.02em;font-size:9px;opacity:.7}
.nbb-ll{display:flex;flex-direction:column;gap:4px;max-height:210px;overflow:auto;scrollbar-width:thin;scrollbar-color:#3a4150 transparent}
.nbb-li{display:flex;align-items:center;gap:6px;padding:4px 5px;border-radius:7px;border:1px solid transparent;cursor:pointer;background:rgba(255,255,255,.03)}
.nbb-li:hover{background:rgba(255,255,255,.07)}
.nbb-li.sel{border-color:var(--acc);background:rgba(245,165,36,.1)}
.nbb-chip{flex:none;min-width:22px;text-align:center;font-size:9.5px;font-weight:800;padding:2px 4px;border-radius:4px;background:var(--c);color:var(--tc)}
.nbb-kind{flex:none;font-size:8px;font-weight:800;letter-spacing:.1em;color:var(--dim)}
.nbb-lt{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:#c9cfdc}
.nbb-mv{flex:none;width:17px;height:17px;display:grid;place-items:center;border-radius:5px;color:#69718a;font-size:10px;cursor:pointer}
.nbb-mv:hover{color:var(--fg);background:var(--card2)}
.nbb-lx{margin-left:2px}
.nbb-lx:hover{color:#fff;background:#e5484d}
.nbb-cm{position:fixed;z-index:10000;min-width:168px;padding:5px;border-radius:10px;background:#181c27;border:1px solid #2c3345;box-shadow:0 14px 34px rgba(0,0,0,.55);font:12px/1.2 system-ui,sans-serif;color:#d8deee}
.nbb-cmi{padding:7px 10px;border-radius:6px;cursor:pointer;white-space:nowrap}
.nbb-cmi:hover{background:#262c3d}
.nbb-cmi.danger{color:#ff8b8f}
.nbb-cmi.danger:hover{background:#e5484d;color:#fff}
.nbb-none{color:var(--dim);font-size:11px;padding:8px 2px;text-align:center}

.nbb-ih{display:flex;align-items:center;gap:6px;margin-bottom:7px}
.nbb-ih b{font-size:11px;letter-spacing:.08em}
.nbb-ib{cursor:pointer;font-size:10px;font-weight:700;color:var(--dim);background:var(--card2);border:1px solid var(--line);border-radius:6px;padding:3px 8px}
.nbb-ib:hover{color:var(--acc);border-color:#4a3b1e}
.nbb-ib.del:hover{color:#fff;background:var(--neg);border-color:var(--neg)}
.nbb-seg{display:flex;border:1px solid var(--line);border-radius:7px;overflow:hidden;margin-bottom:7px;width:fit-content}
.nbb-seg button{cursor:pointer;border:0;background:var(--card2);color:var(--dim);font-size:10.5px;font-weight:700;padding:4px 14px}
.nbb-seg button.on{background:linear-gradient(180deg,#ffc35c,var(--acc));color:#1a1206}
.nbb-fl{display:block;font-size:8.5px;font-weight:800;letter-spacing:.14em;color:var(--dim);margin:6px 0 3px}
.nbb-ta{width:100%;resize:vertical;min-height:34px;max-height:140px;background:#0f1117;color:var(--fg);border:1px solid #2d3342;border-radius:7px;
  padding:5px 7px;font:inherit;font-size:11.5px;outline:none;user-select:text}
.nbb-ta:focus,.nbb-n:focus{border-color:var(--acc);box-shadow:0 0 0 2px rgba(245,165,36,.15)}
.nbb-pal{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.nbb-sw{position:relative;width:26px;height:22px;border-radius:6px;border:1px solid #000;box-shadow:0 0 0 1px #3a4150;overflow:hidden;cursor:pointer}
.nbb-sw input{position:absolute;inset:-6px;width:40px;height:34px;border:0;padding:0;cursor:pointer;opacity:0}
.nbb-sx{position:absolute;right:0;top:0;width:11px;height:11px;line-height:11px;text-align:center;font-size:9px;background:rgba(0,0,0,.65);color:#fff;cursor:pointer;z-index:2;display:none}
.nbb-sw:hover .nbb-sx{display:block}
.nbb-padd{width:26px;height:22px;border-radius:6px;border:1px dashed #4a5262;color:var(--dim);display:grid;place-items:center;cursor:pointer;font-size:13px;background:none}
.nbb-padd:hover{color:var(--acc);border-color:var(--acc)}
.nbb-xywh{display:grid;grid-template-columns:repeat(4,1fr);gap:5px}
.nbb-xywh label{font-size:8.5px;font-weight:800;letter-spacing:.12em;color:var(--dim)}
.nbb-n{width:100%;background:#0f1117;color:var(--fg);border:1px solid #2d3342;border-radius:6px;padding:3px 4px;font:inherit;font-size:11px;outline:none;text-align:center}

.nbb-foot{display:flex;gap:6px;margin-top:8px;align-items:center}
.nbb-io{margin-top:8px;display:none}
.nbb-io.open{display:block}
.nbb-io .nbb-ta{min-height:90px}
.nbb-iorow{display:flex;gap:6px;margin-top:6px;align-items:center;flex-wrap:wrap}
.nbb-msg{font-size:10px;color:var(--dim)}
.nbb-msg.err{color:var(--neg)}
`;
    document.head.appendChild(s);
}


// -- editor panel -----------------------------------------------------------

// Size the node to its real content: widget top + measured panel height (computeSize can't see the DOM panel).
function fit(node) {
    requestAnimationFrame(() => {
        if (!node.graph) return;

        const ph = node.__nbbPanel?.offsetHeight || 0;
        const dw = node.__nbbDW;
        const wy = (dw?.last_y > 0 ? dw.last_y : null) ?? (dw?.y > 0 ? dw.y : null) ?? 120;
        const h = ph > 0 ? wy + ph + 18 : node.computeSize()[1];

        if (Math.abs(h - node.size[1]) > 1) node.setSize([Math.max(node.size[0], 460), h]);

        node.setDirtyCanvas(true, true);
    });
}

function buildPanel(node) {
    styles();

    const bb = node.__bb;
    const root = document.createElement("div");
    root.className = "nbb";
    root.innerHTML = `
        <div class="nbb-bar">
            <span class="nbb-logo"></span><span class="nbb-title">BOUNDING&nbsp;BOXES</span><span class="nbb-dims"></span>
            <span class="nbb-sp"></span>
            <button class="nbb-tb" data-tool="draw" title="Draw tool (D): drag anywhere to draw a box">✎ Draw</button>
            <button class="nbb-tb" data-tool="select" title="Select tool (V): drag boxes to move, handles to resize. Shift+drag draws">⬚ Select</button>
            <button class="nbb-tb nbb-snap" title="Snap to the 16 px grid">▦ Snap ${GRID}</button>
        </div>
        <div class="nbb-area">
            <div class="nbb-stage" tabindex="0">
                <img class="nbb-bg" hidden alt="">
                <div class="nbb-boxes"></div>
                <div class="nbb-empty">Drag on the canvas to draw your first box</div>
                <div class="nbb-hint"></div>
            </div>
        </div>
        <div class="nbb-cols">
            <div class="nbb-layers"><div class="nbb-lh">LAYERS <span>01 = background · last = foreground</span></div><div class="nbb-ll"></div></div>
            <div class="nbb-insp"></div>
        </div>
        <div class="nbb-foot">
            <button class="nbb-tb nbb-iot">⇅ Import / Export</button>
            <span class="nbb-sp"></span>
            <button class="nbb-tb nbb-clear">🗑 Clear all</button>
        </div>
        <div class="nbb-io">
            <textarea class="nbb-ta" spellcheck="false" placeholder='Paste prompt elements ([{"type":"obj","bbox":[ymin,xmin,ymax,xmax],"desc":"..."}]) or pixel boxes ([{"x":..,"y":..,"width":..,"height":..}])'></textarea>
            <div class="nbb-iorow">
                <button class="nbb-tb nbb-load">Load into canvas</button>
                <button class="nbb-tb nbb-cpe">Copy elements</button>
                <button class="nbb-tb nbb-cpp">Copy pixel boxes</button>
                <span class="nbb-msg"></span>
            </div>
        </div>`;

    const $ = (s) => root.querySelector(s);
    const area = $(".nbb-area"), stage = $(".nbb-stage"), boxesEl = $(".nbb-boxes"), bgEl = $(".nbb-bg");
    const layersEl = $(".nbb-ll"), inspEl = $(".nbb-insp");

    root.addEventListener("pointerdown", e => e.stopPropagation());

    // -- state helpers --
    const dims = () => {
        const wv = Number(wget(node, "width")?.value) || 1024;
        const hv = Number(wget(node, "height")?.value) || 1024;
        return [isLinked(node, "width") && bb.dims ? bb.dims[0] : wv, isLinked(node, "height") && bb.dims ? bb.dims[1] : hv];
    };
    const minSize = () => (bb.snap ? GRID : 8);
    const snapV = (px) => (bb.snap ? Math.round(px / GRID) * GRID : Math.round(px));
    const r6 = (v) => Math.round(v * 1e6) / 1e6;

    function sync() {
        const w = wget(node, STATE);
        if (w) w.value = JSON.stringify({ v: 1, regions: bb.regions.map(r => ({ ...r, x: r6(r.x), y: r6(r.y), w: r6(r.w), h: r6(r.h) })) });
    }

    const commit = () => { sync(); node.setDirtyCanvas(true, true); };

    function setRectPx(r, l, t, rt, b) {
        const [W, H] = dims();
        r.x = l / W; r.y = t / H; r.w = (rt - l) / W; r.h = (b - t) / H;
    }

    const pxRect = (r) => { const [W, H] = dims(); return { x: r.x * W, y: r.y * H, w: r.w * W, h: r.h * H }; };

    // -- rendering --
    function layoutStage() {
        const [W, H] = dims();
        const avail = area.clientWidth;
        if (avail <= 0) return;

        const sc = Math.min(avail / W, MAX_STAGE_H / H);
        stage.style.width = Math.max(60, Math.floor(W * sc)) + "px";
        stage.style.height = Math.max(60, Math.floor(H * sc)) + "px";
    }

    function renderStage() {
        boxesEl.textContent = "";

        bb.regions.forEach((r, i) => {
            const c = regionColor(r, i);
            const el = document.createElement("div");
            el.className = "nbb-box" + (i === bb.sel ? " sel" : "") + (r.type === "text" ? " text" : "");
            el.style.cssText = `left:${r.x * 100}%;top:${r.y * 100}%;width:${r.w * 100}%;height:${r.h * 100}%;--c:${c};--tc:${textOn(c)}`;

            let body = r.desc || "";
            if (r.type === "text" && r.text) body = `"${r.text}"${body ? " — " + body : ""}`;

            el.innerHTML = `<span class="nbb-tag">${String(i + 1).padStart(2, "0")}</span><div class="nbb-body">${esc(body)}</div>`
                + (i === bb.sel ? ["nw", "n", "ne", "e", "se", "s", "sw", "w"].map(h => `<span class="nbb-h" data-h="${h}"></span>`).join("") : "");

            boxesEl.appendChild(el);
        });

        $(".nbb-empty").style.display = bb.regions.length ? "none" : "grid";
    }

    function renderLayers() {
        layersEl.textContent = "";

        if (!bb.regions.length) {
            layersEl.innerHTML = `<div class="nbb-none">No boxes yet</div>`;
            return;
        }

        bb.regions.forEach((r, i) => {
            const c = regionColor(r, i);
            const li = document.createElement("div");
            li.className = "nbb-li" + (i === bb.sel ? " sel" : "");
            li.style.cssText = `--c:${c};--tc:${textOn(c)}`;

            const label = (r.type === "text" ? (r.text || r.desc) : r.desc) || "(no description)";
            li.innerHTML = `<span class="nbb-chip">${String(i + 1).padStart(2, "0")}</span>
                <span class="nbb-kind">${r.type === "text" ? "TXT" : "OBJ"}</span>
                <span class="nbb-lt" title="${esc(label)}">${esc(label)}</span>
                <span class="nbb-mv" data-mv="-1" title="Move toward background">▲</span>
                <span class="nbb-mv" data-mv="1" title="Move toward foreground">▼</span>
                <span class="nbb-mv nbb-lx" title="Delete this box">✕</span>`;

            li.addEventListener("click", (e) => {
                if (e.target.closest?.(".nbb-lx")) { removeAt(i); return; }

                const mv = e.target.closest?.(".nbb-mv");

                if (mv) {
                    const j = i + Number(mv.dataset.mv);

                    if (j >= 0 && j < bb.regions.length) {
                        [bb.regions[i], bb.regions[j]] = [bb.regions[j], bb.regions[i]];
                        bb.sel = j;
                        commit();
                        renderAll();
                    }
                    return;
                }

                bb.sel = i;
                renderAll();
            });

            layersEl.appendChild(li);
        });
    }

    function updateXYWH() {
        const r = bb.regions[bb.sel];
        if (!r) return;

        const p = pxRect(r);
        inspEl.querySelectorAll(".nbb-n").forEach(inp => {
            inp.value = Math.round(p[inp.dataset.k]);
        });
    }

    function renderInspector() {
        const r = bb.regions[bb.sel];

        if (!r) {
            inspEl.innerHTML = `<div class="nbb-none">Select a box on the canvas or in the layer list to edit its type, text, description and palette.</div>`;
            return;
        }

        const c = regionColor(r, bb.sel);
        const pal = (r.palette || []).slice(0, MAX_PALETTE);

        inspEl.innerHTML = `
            <div class="nbb-ih"><span class="nbb-chip" style="--c:${c};--tc:${textOn(c)}">${String(bb.sel + 1).padStart(2, "0")}</span><b>BOX</b>
                <span class="nbb-sp"></span>
                <button class="nbb-ib nbb-dup" title="Duplicate (Ctrl+D)">⧉ Duplicate</button>
                <button class="nbb-ib del nbb-del" title="Delete (Del)">✕ Delete</button></div>
            <div class="nbb-seg"><button data-type="obj" class="${r.type === "text" ? "" : "on"}">Object</button><button data-type="text" class="${r.type === "text" ? "on" : ""}">Text</button></div>
            ${r.type === "text" ? `<label class="nbb-fl">TEXT TO RENDER</label><textarea class="nbb-ta" data-f="text" rows="2" spellcheck="false">${esc(r.text)}</textarea>` : ""}
            <label class="nbb-fl">DESCRIPTION</label><textarea class="nbb-ta" data-f="desc" rows="3" spellcheck="false">${esc(r.desc)}</textarea>
            <label class="nbb-fl">COLOR PALETTE</label>
            <div class="nbb-pal">
                ${pal.map((hx, k) => `<span class="nbb-sw" style="background:${isHex(hx) ? hx : "#ffffff"}"><input type="color" data-k="${k}" value="${isHex(hx) ? hx.toLowerCase() : "#ffffff"}"><span class="nbb-sx" data-k="${k}" title="Remove">✕</span></span>`).join("")}
                ${pal.length < MAX_PALETTE ? `<button class="nbb-padd" title="Add a color">+</button>` : ""}
            </div>
            <label class="nbb-fl">POSITION (PX)</label>
            <div class="nbb-xywh">${[["x", "X"], ["y", "Y"], ["w", "W"], ["h", "H"]].map(([k, l]) => `<div><label>${l}</label><input class="nbb-n" type="number" data-k="${k}" step="${bb.snap ? GRID : 1}"></div>`).join("")}</div>`;

        updateXYWH();
    }

    function updateHeader() {
        const [W, H] = dims();
        $(".nbb-dims").textContent = `${W} × ${H}`;
        root.querySelectorAll("[data-tool]").forEach(b => b.classList.toggle("on", b.dataset.tool === bb.tool));
        $(".nbb-snap").classList.toggle("on", bb.snap);
        stage.classList.toggle("sel", bb.tool === "select");
        $(".nbb-hint").textContent = bb.tool === "draw"
            ? "drag = draw · click = select · D / V switch tool"
            : "drag = move · handles = resize · Shift+drag = draw";
    }

    function renderAll() {
        layoutStage();
        updateHeader();
        renderStage();
        renderLayers();
        renderInspector();
        fit(node);
    }

    // -- selection / editing actions --
    function removeAt(i) {
        bb.regions.splice(i, 1);
        if (bb.sel > i) bb.sel -= 1;
        else if (bb.sel === i) bb.sel = Math.min(i, bb.regions.length - 1);
        commit();
        renderAll();
    }

    function duplicate(i) {
        const src = bb.regions[i];
        if (!src) return;

        const [W, H] = dims();
        const cp = JSON.parse(JSON.stringify(src));
        cp.x = clamp(cp.x + GRID / W, 0, Math.max(0, 1 - cp.w));
        cp.y = clamp(cp.y + GRID / H, 0, Math.max(0, 1 - cp.h));

        bb.regions.splice(i + 1, 0, cp);
        bb.sel = i + 1;
        commit();
        renderAll();
    }

    const hit = (p) => {
        for (let i = bb.regions.length - 1; i >= 0; i--) {
            const q = pxRect(bb.regions[i]);
            if (p.x >= q.x && p.x <= q.x + q.w && p.y >= q.y && p.y <= q.y + q.h) return i;
        }
        return -1;
    };

    // -- pointer interaction on the stage --
    let drag = null;

    const toCanvas = (e) => {
        const [W, H] = dims();
        const rc = stage.getBoundingClientRect();
        return { x: clamp((e.clientX - rc.left) / (rc.width || 1), 0, 1) * W, y: clamp((e.clientY - rc.top) / (rc.height || 1), 0, 1) * H };
    };

    stage.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;

        stage.focus({ preventScroll: true });
        const p = toCanvas(e);
        const handle = e.target.closest?.(".nbb-h");
        const cur = bb.regions[bb.sel];

        drag = null;

        if (handle && cur) {
            drag = { mode: "resize", h: handle.dataset.h, orig: pxRect(cur) };
        } else {
            const i = hit(p);

            if (bb.tool === "select" && !e.shiftKey) {
                bb.sel = i;
                renderAll();
                if (i >= 0) drag = { mode: "move", start: p, orig: pxRect(bb.regions[i]) };
            } else {
                drag = { mode: "draw", start: p, cx: e.clientX, cy: e.clientY, moved: false, hit: i };
            }
        }

        if (drag) {
            stage.setPointerCapture?.(e.pointerId);
            e.preventDefault();
        }
    });

    stage.addEventListener("pointermove", (e) => {
        if (!drag) return;

        const [W, H] = dims();
        const p = toCanvas(e);
        const ms = minSize();

        if (drag.mode === "draw" && !drag.moved) {
            if (Math.hypot(e.clientX - drag.cx, e.clientY - drag.cy) < 4) return;

            drag.moved = true;
            drag.anchor = { x: snapV(drag.start.x), y: snapV(drag.start.y) };
            bb.regions.push(newRegion({ x: 0, y: 0, w: 0, h: 0 }));
            bb.sel = bb.regions.length - 1;
            drag.created = true;
        }

        const r = bb.regions[bb.sel];
        if (!r) return;

        if (drag.mode === "draw" && drag.moved) {
            const sx = snapV(p.x), sy = snapV(p.y);
            setRectPx(r, Math.min(drag.anchor.x, sx), Math.min(drag.anchor.y, sy), Math.max(drag.anchor.x, sx), Math.max(drag.anchor.y, sy));
        } else if (drag.mode === "move") {
            const o = drag.orig;
            const nx = clamp(snapV(o.x + (p.x - drag.start.x)), 0, Math.max(0, W - o.w));
            const ny = clamp(snapV(o.y + (p.y - drag.start.y)), 0, Math.max(0, H - o.h));
            setRectPx(r, nx, ny, nx + o.w, ny + o.h);
        } else if (drag.mode === "resize") {
            const o = drag.orig, h = drag.h;
            const sx = clamp(snapV(p.x), 0, W), sy = clamp(snapV(p.y), 0, H);
            let l = o.x, t = o.y, rt = o.x + o.w, b = o.y + o.h;

            if (h.includes("w")) l = Math.min(sx, rt - ms);
            if (h.includes("e")) rt = Math.max(sx, l + ms);
            if (h.includes("n")) t = Math.min(sy, b - ms);
            if (h.includes("s")) b = Math.max(sy, t + ms);

            setRectPx(r, Math.max(0, l), Math.max(0, t), Math.min(W, rt), Math.min(H, b));
        } else {
            return;
        }

        renderStage();
        updateXYWH();
    });

    const endDrag = () => {
        if (!drag) return;

        const d = drag;
        drag = null;

        if (d.mode === "draw") {
            if (!d.moved) {
                bb.sel = d.hit;                       // plain click: select what's under the cursor (or nothing)
            } else {
                const r = bb.regions[bb.sel];
                const [W, H] = dims();

                if (r && (r.w * W < minSize() || r.h * H < minSize())) {
                    bb.regions.splice(bb.sel, 1);      // stray click-drag: too small to be a box
                    bb.sel = -1;
                }
            }
        }

        commit();
        renderAll();
    };

    stage.addEventListener("pointerup", endDrag);
    stage.addEventListener("pointercancel", endDrag);

    // -- keyboard (only while the canvas has focus) --
    stage.addEventListener("keydown", (e) => {
        const r = bb.regions[bb.sel];
        const k = e.key;
        let used = true;

        if (k === "Delete" || k === "Backspace") {
            if (r) removeAt(bb.sel);
        } else if (k === "d" && !(e.ctrlKey || e.metaKey)) {
            bb.tool = "draw"; updateHeader();
        } else if (k === "v") {
            bb.tool = "select"; updateHeader();
        } else if ((k === "d" || k === "D") && (e.ctrlKey || e.metaKey)) {
            if (r) duplicate(bb.sel);
        } else if (r && k.startsWith("Arrow")) {
            const step = (bb.snap ? GRID : 1) * (e.shiftKey ? 4 : 1);
            const [W, H] = dims();
            const o = pxRect(r);
            const dx = k === "ArrowLeft" ? -step : k === "ArrowRight" ? step : 0;
            const dy = k === "ArrowUp" ? -step : k === "ArrowDown" ? step : 0;
            const nx = clamp(o.x + dx, 0, Math.max(0, W - o.w));
            const ny = clamp(o.y + dy, 0, Math.max(0, H - o.h));

            setRectPx(r, nx, ny, nx + o.w, ny + o.h);
            commit();
            renderStage();
            updateXYWH();
        } else {
            used = false;
        }

        if (used) {
            e.preventDefault();
            e.stopPropagation();       // keep ComfyUI from treating Delete etc. as "delete the node"
        }
    });

    // typing inside the panel must never reach ComfyUI's global shortcuts
    root.addEventListener("keydown", (e) => {
        if (e.target.closest?.("input, textarea")) e.stopPropagation();
    });

    // -- right-click menu (stage + layer list) --
    let menuEl = null;
    const closeMenu = () => { if (menuEl) { menuEl.remove(); menuEl = null; } };

    function showMenu(x, y, i) {
        closeMenu();
        const r = bb.regions[i];
        const items = r
            ? [["Delete box", "del", true], ["Duplicate", "dup"], ["Bring forward", "fwd"], ["Send backward", "back"],
               [r.type === "text" ? "Change to Object" : "Change to Text", "type"]]
            : (bb.regions.length ? [["Delete all boxes", "clear", true]] : []);
        if (!items.length) return;

        const m = document.createElement("div");
        m.className = "nbb-cm";
        m.innerHTML = items.map(([label, a, danger]) => `<div class="nbb-cmi${danger ? " danger" : ""}" data-a="${a}">${label}</div>`).join("");
        document.body.appendChild(m);
        menuEl = m;
        m.style.left = Math.max(4, Math.min(x, window.innerWidth - m.offsetWidth - 6)) + "px";
        m.style.top = Math.max(4, Math.min(y, window.innerHeight - m.offsetHeight - 6)) + "px";

        m.addEventListener("click", (ev) => {
            const a = ev.target.closest(".nbb-cmi")?.dataset.a;
            if (!a) return;
            closeMenu();
            if (a === "del") removeAt(i);
            else if (a === "dup") duplicate(i);
            else if (a === "fwd" || a === "back") {
                const j = i + (a === "fwd" ? 1 : -1);
                if (j >= 0 && j < bb.regions.length) {
                    [bb.regions[i], bb.regions[j]] = [bb.regions[j], bb.regions[i]];
                    bb.sel = j; commit(); renderAll();
                }
            } else if (a === "type") {
                r.type = r.type === "text" ? "obj" : "text"; commit(); renderAll();
            } else if (a === "clear") {
                if (confirm(`Delete all ${bb.regions.length} boxes?`)) { bb.regions = []; bb.sel = -1; commit(); renderAll(); }
            }
        });
    }

    document.addEventListener("pointerdown", (ev) => { if (menuEl && !menuEl.contains(ev.target)) closeMenu(); }, true);
    window.addEventListener("keydown", () => closeMenu(), true);
    window.addEventListener("wheel", () => closeMenu(), { passive: true });

    stage.addEventListener("contextmenu", (e) => {
        e.preventDefault(); e.stopPropagation();
        const i = hit(toCanvas(e));
        if (i >= 0 && bb.sel !== i) { bb.sel = i; renderAll(); }
        showMenu(e.clientX, e.clientY, i);
    });

    layersEl.addEventListener("contextmenu", (e) => {
        const li = e.target.closest?.(".nbb-li");
        if (!li) return;
        e.preventDefault(); e.stopPropagation();
        const i = [...layersEl.children].indexOf(li);
        if (i < 0) return;
        if (bb.sel !== i) { bb.sel = i; renderAll(); }
        showMenu(e.clientX, e.clientY, i);
    });

    // -- inspector events (delegated) --
    inspEl.addEventListener("click", (e) => {
        const r = bb.regions[bb.sel];
        if (!r) return;

        const seg = e.target.closest("[data-type]");
        if (seg) { r.type = seg.dataset.type; commit(); renderAll(); return; }

        if (e.target.closest(".nbb-dup")) { duplicate(bb.sel); return; }
        if (e.target.closest(".nbb-del")) { removeAt(bb.sel); return; }

        const sx = e.target.closest(".nbb-sx");
        if (sx) {
            e.stopPropagation();
            r.palette.splice(Number(sx.dataset.k), 1);
            commit();
            renderAll();
            return;
        }

        if (e.target.closest(".nbb-padd")) {
            r.palette = [...(r.palette || []), autoHex(bb.sel + (r.palette?.length || 0) * 2)].slice(0, MAX_PALETTE);
            commit();
            renderAll();
        }
    });

    inspEl.addEventListener("input", (e) => {
        const r = bb.regions[bb.sel];
        if (!r) return;

        const f = e.target.dataset?.f;
        if (f) {
            r[f] = e.target.value;
            commit();
            renderStage();
            renderLayers();
            return;
        }

        if (e.target.type === "color") {
            const k = Number(e.target.dataset.k);
            r.palette[k] = e.target.value.toUpperCase();
            e.target.parentElement.style.background = e.target.value;
            commit();
            renderStage();
            renderLayers();
        }
    });

    inspEl.addEventListener("change", (e) => {
        const r = bb.regions[bb.sel];
        if (!r || !e.target.classList.contains("nbb-n")) return;

        const [W, H] = dims();
        const p = pxRect(r);
        const k = e.target.dataset.k;
        const v = Number(e.target.value);

        if (Number.isFinite(v)) p[k] = Math.max(k === "w" || k === "h" ? 1 : 0, v);

        p.w = Math.min(p.w, W); p.h = Math.min(p.h, H);
        p.x = clamp(p.x, 0, W - p.w); p.y = clamp(p.y, 0, H - p.h);

        setRectPx(r, p.x, p.y, p.x + p.w, p.y + p.h);
        commit();
        renderStage();
        updateXYWH();
    });

    // -- toolbar / footer --
    root.querySelectorAll("[data-tool]").forEach(b => { b.onclick = () => { bb.tool = b.dataset.tool; updateHeader(); }; });
    $(".nbb-snap").onclick = () => { bb.snap = !bb.snap; updateHeader(); renderInspector(); };

    let armed = null;
    $(".nbb-clear").onclick = () => {
        const b = $(".nbb-clear");
        if (!bb.regions.length) return;

        if (!armed) {
            b.classList.add("warn");
            b.textContent = "Click again to confirm";
            armed = setTimeout(() => { armed = null; b.classList.remove("warn"); b.textContent = "🗑 Clear all"; }, 2200);
            return;
        }

        clearTimeout(armed);
        armed = null;
        b.classList.remove("warn");
        b.textContent = "🗑 Clear all";
        bb.regions = [];
        bb.sel = -1;
        commit();
        renderAll();
    };

    const io = $(".nbb-io"), ioTa = io.querySelector("textarea"), msg = $(".nbb-msg");
    const say = (t, err = false) => { msg.textContent = t; msg.classList.toggle("err", err); };

    $(".nbb-iot").onclick = () => {
        io.classList.toggle("open");
        fit(node);
    };

    $(".nbb-load").onclick = () => {
        try {
            const [W, H] = dims();
            const regs = parseImport(ioTa.value, W, H);

            bb.regions = regs;
            bb.sel = -1;
            commit();
            renderAll();
            say(`loaded ${regs.length} box${regs.length === 1 ? "" : "es"}`);
        } catch (err) {
            say(err.message || "couldn't parse that", true);
        }
    };

    const copyOut = (text, label) => {
        ioTa.value = text;
        try { navigator.clipboard?.writeText(text); } catch { }
        say(`${label} copied`);
    };

    $(".nbb-cpe").onclick = () => copyOut(JSON.stringify(regionsToElements(bb.regions), null, 1), "elements");
    $(".nbb-cpp").onclick = () => { const [W, H] = dims(); copyOut(JSON.stringify(regionsToPixelBoxes(bb.regions, W, H), null, 1), "pixel boxes"); };

    // -- hooks used by the extension --
    node.__nbbRender = renderAll;
    node.__nbbCommit = commit;

    node.__nbbSetBg = (url) => {
        if (url) { bgEl.src = url; bgEl.hidden = false; } else { bgEl.hidden = true; bgEl.removeAttribute("src"); }
    };

    node.__nbbDims = dims;

    if (typeof ResizeObserver !== "undefined") {
        new ResizeObserver(() => { layoutStage(); fit(node); }).observe(root);
    }

    return root;
}


// -- node wiring ------------------------------------------------------------

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

function loadState(node) {
    const bb = node.__bb;
    let regs = [];

    try {
        const d = JSON.parse(wget(node, STATE)?.value || "{}");
        const raw = Array.isArray(d) ? d : (d.regions || []);

        regs = raw.filter(r => r && typeof r === "object").map(r => newRegion({
            x: num(r.x, 0), y: num(r.y, 0), w: num(r.w, 0), h: num(r.h, 0),
            type: r.type === "text" ? "text" : "obj",
            text: String(r.text ?? ""), desc: String(r.desc ?? ""),
            palette: Array.isArray(r.palette) ? r.palette.filter(isHex).map(c => c.toUpperCase()).slice(0, MAX_PALETTE) : [],
        }));
    } catch { regs = []; }

    bb.regions = regs;
    bb.sel = Math.min(bb.sel, regs.length - 1);
}

function buildUI(node) {
    if (node.__nbbBuilt) return;
    node.__nbbBuilt = true;
    node.__bb = { regions: [], sel: -1, tool: "draw", snap: true, dims: null };

    hideWidget(wget(node, STATE));
    hideWidget(wget(node, LAST));
    loadState(node);

    const panel = buildPanel(node);

    // ComfyUI forces an inline height on the element given to addDOMWidget, so hand it a holder and
    // keep `panel` at its natural height so we can measure it.
    const holder = document.createElement("div");
    holder.style.cssText = "width:100%;overflow:visible;";
    holder.appendChild(panel);

    const getH = () => Math.max(panel.offsetHeight + 4, 200);

    const dw = node.addDOMWidget("nbb_panel", "div", holder, {
        serialize: false,
        getHeight: getH,
        getMinHeight: getH,
    });

    dw.serializeValue = () => undefined;
    dw.computeSize = (w) => [w, getH()];

    node.__nbbPanel = panel;
    node.__nbbDW = dw;

    // resolution changes re-fit the canvas
    for (const name of ["width", "height"]) {
        const w = wget(node, name);
        if (!w) continue;

        const cb = w.callback;
        w.callback = function () {
            const r = cb?.apply(this, arguments);
            node.__nbbRender?.();
            return r;
        };
    }

    node.__nbbRender();
    setTimeout(() => fit(node), 60);
    setTimeout(() => fit(node), 400);
}

function handleExecuted(node, message) {
    const bb = node.__bb;
    if (!bb || !message) return;

    if (Array.isArray(message.dims) && message.dims.length === 2) bb.dims = [message.dims[0], message.dims[1]];

    // A new upstream value initializes the canvas; after that, canvas edits win until upstream changes again.
    const inc = message.input_bboxes;
    const lastW = wget(node, LAST);

    if (Array.isArray(inc) && inc.length && lastW) {
        const s = JSON.stringify(inc);

        if (s !== lastW.value) {
            const [W, H] = bb.dims || node.__nbbDims();
            bb.regions = boxesToRegions(inc, W, H);
            bb.sel = -1;
            lastW.value = s;
            node.__nbbCommit();
        }
    }

    const img = message.background_images?.[0];
    node.__nbbSetBg(img
        ? api.apiURL(`/view?filename=${encodeURIComponent(img.filename)}&type=${img.type || "temp"}&subfolder=${encodeURIComponent(img.subfolder || "")}&rand=${Math.random()}`)
        : null);

    node.__nbbRender();
}

app.registerExtension({
    name: "Nougan.BoundingBoxes",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData?.name !== NODE_NAME) return;

        const onc = nodeType.prototype.onNodeCreated;

        nodeType.prototype.onNodeCreated = function () {
            onc?.apply(this, arguments);
            this.size = [WIDTH, 760];

            try { buildUI(this); } catch (e) { console.warn("[Nougan BBoxes] UI build failed", e); }
        };

        const ocf = nodeType.prototype.onConfigure;

        nodeType.prototype.onConfigure = function () {
            ocf?.apply(this, arguments);

            try {
                if (!this.__nbbBuilt) buildUI(this);

                loadState(this);
                this.__nbbRender?.();

                setTimeout(() => fit(this), 60);
                setTimeout(() => fit(this), 400);
            } catch (e) {
                console.warn("[Nougan BBoxes] onConfigure failed", e);
            }
        };

        const oce = nodeType.prototype.onConnectionsChange;

        nodeType.prototype.onConnectionsChange = function () {
            oce?.apply(this, arguments);
            this.__nbbRender?.();
        };

        const oex = nodeType.prototype.onExecuted;

        nodeType.prototype.onExecuted = function (message) {
            oex?.apply(this, arguments);

            try { handleExecuted(this, message); } catch (e) { console.warn("[Nougan BBoxes] onExecuted failed", e); }
        };
    },
});
