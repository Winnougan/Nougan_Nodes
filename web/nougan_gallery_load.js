// web/nougan_gallery_load.js  —  Nougan Gallery Load
//
// DOM thumbnail gallery for the NouganGalleryLoad node.
//  • folder: paste a path into the "folder" widget, or click 📂 to browse (server-side folder picker)
//  • bottom slider  = magnify thumbnails (bounded by the node's size, always fills the row, never scrolls sideways)
//  • right bar      = scrub up / down   (mouse wheel works too, Ctrl+wheel = magnify)
//  • click = select (click again = deselect) · Shift/Ctrl+click = add more · drag a rectangle = box select
//  • selected images are pinned at the top in P order, with a highlight, a P# badge and an ✕;
//    the node grows one IMAGE output per selected image
//  • Shift+click a pinned image to mark it (amber); right-click a pinned image -> Remove (removes all marked)
//  • WebGPU animated backdrop behind the thumbnails (falls back to a CSS gradient)

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_ID = "NouganGalleryLoad";
const MAX_OUT = 64;            // keep in sync with MAX_OUTPUTS in nougan_gallery_load.py
const MIN_CELL = 48;           // smallest thumbnail cell (px)
const BUCKETS = [128, 256, 512, 1024];
const DEFAULT_ZOOM = 0.15;

// ── stylesheet ──────────────────────────────────────────────────────────────
(function loadCss() {
    if (document.getElementById("nougan-gallery-load-css")) return;
    const link = document.createElement("link");
    link.id = "nougan-gallery-load-css";
    link.rel = "stylesheet";
    link.href = new URL("./css/nougan_gallery_load.css", import.meta.url).href;
    document.head.appendChild(link);
})();

// ── tiny helpers ────────────────────────────────────────────────────────────
function h(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
}
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// Show exactly `n` outputs named P1..Pn (the Python node defines MAX_OUT of them).
function syncOutputs(node, n) {
    n = clamp(n | 0, 0, MAX_OUT);
    if (!node.outputs) node.outputs = [];
    while (node.outputs.length > n) node.removeOutput(node.outputs.length - 1);
    while (node.outputs.length < n) node.addOutput("P" + (node.outputs.length + 1), "IMAGE");
    node.outputs.forEach((o, i) => {
        o.name = "P" + (i + 1);
        o.label = "P" + (i + 1);
        o.type = "IMAGE";
    });
    node.setDirtyCanvas?.(true, true);
}

// ── WebGPU backdrop ─────────────────────────────────────────────────────────
const WGSL = /* wgsl */ `
struct U { res: vec2f, time: f32, glow: f32, mouse: vec2f, pad: vec2f };
@group(0) @binding(0) var<uniform> u: U;

@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}

@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let uv = pos.xy / u.res;
  let asp = vec2f(u.res.x / u.res.y, 1.0);
  let t = u.time * 0.12;
  var c = vec3f(0.050, 0.050, 0.068);
  let a = vec2f(0.28 + 0.20 * sin(t), 0.32 + 0.20 * cos(t * 1.3));
  let b = vec2f(0.76 + 0.14 * cos(t * 0.8), 0.72 + 0.20 * sin(t * 1.1));
  c += vec3f(0.42, 0.14, 0.52) * 0.14 * exp(-length((uv - a) * asp) * 3.0);
  c += vec3f(0.10, 0.34, 0.50) * 0.12 * exp(-length((uv - b) * asp) * 3.0);
  c += vec3f(0.60, 0.38, 0.85) * 0.14 * u.glow * exp(-length((uv - u.mouse) * asp) * 5.5);
  let g = fract(sin(dot(pos.xy, vec2f(12.9898, 78.233))) * 43758.5453);
  c += (g - 0.5) * 0.012;
  return vec4f(c, 1.0);
}`;

async function startBackdrop(canvas) {
    try {
        if (!navigator.gpu) return null;
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) return null;
        const device = await adapter.requestDevice();
        const ctx = canvas.getContext("webgpu");
        if (!ctx) return null;
        const format = navigator.gpu.getPreferredCanvasFormat();
        ctx.configure({ device, format, alphaMode: "opaque" });

        const module = device.createShaderModule({ code: WGSL });
        const pipeline = device.createRenderPipeline({
            layout: "auto",
            vertex: { module, entryPoint: "vs" },
            fragment: { module, entryPoint: "fs", targets: [{ format }] },
            primitive: { topology: "triangle-list" },
        });
        const ubuf = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        const bind = device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [{ binding: 0, resource: { buffer: ubuf } }],
        });

        const api = { mx: 0.5, my: 0.5, target: 0, glow: 0, dead: false, raf: 0 };
        let last = 0;
        const data = new Float32Array(8);

        const frame = (t) => {
            if (api.dead) return;
            api.raf = requestAnimationFrame(frame);
            if (t - last < 33) return;                       // ~30 fps is plenty for a backdrop
            last = t;
            if (document.hidden || !canvas.offsetParent || canvas.width < 2) return;
            api.glow += (api.target - api.glow) * 0.12;
            data[0] = canvas.width; data[1] = canvas.height;
            data[2] = t / 1000; data[3] = api.glow;
            data[4] = api.mx; data[5] = api.my;
            device.queue.writeBuffer(ubuf, 0, data);
            const enc = device.createCommandEncoder();
            const pass = enc.beginRenderPass({
                colorAttachments: [{
                    view: ctx.getCurrentTexture().createView(),
                    clearValue: { r: 0, g: 0, b: 0, a: 1 },
                    loadOp: "clear", storeOp: "store",
                }],
            });
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, bind);
            pass.draw(3);
            pass.end();
            device.queue.submit([enc.finish()]);
        };
        api.raf = requestAnimationFrame(frame);

        device.lost.then(() => { api.dead = true; canvas.classList.remove("on"); });
        api.resize = (w, h2) => {
            const dpr = Math.min(window.devicePixelRatio || 1, 2);
            canvas.width = Math.max(1, Math.round(w * dpr));
            canvas.height = Math.max(1, Math.round(h2 * dpr));
        };
        api.stop = () => {
            api.dead = true;
            cancelAnimationFrame(api.raf);
            try { device.destroy(); } catch { /* ignore */ }
        };
        return api;
    } catch (e) {
        console.warn("[Nougan Gallery] WebGPU backdrop unavailable, using CSS fallback.", e);
        return null;
    }
}

// ── server-side folder browser (browsers can't reveal real folder paths) ────
function openFolderBrowser(start, onPick) {
    const ov = h("div", "ngl-modal-ov");
    const box = h("div", "ngl-modal");
    const title = h("div", "ngl-modal-t", "Choose a folder");
    const row = h("div", "ngl-modal-row");
    const up = h("button", "ngl-btn", "⬆ Up");
    const inp = h("input", "ngl-modal-in");
    inp.spellcheck = false;
    inp.placeholder = "Type or paste a path, then press Enter";
    const go = h("button", "ngl-btn", "Go");
    row.append(up, inp, go);
    const list = h("div", "ngl-modal-list");
    const info = h("div", "ngl-modal-info");
    const btns = h("div", "ngl-modal-btns");
    const cancel = h("button", "ngl-btn", "Cancel");
    const ok = h("button", "ngl-btn ngl-btn-pri", "Use this folder");
    btns.append(cancel, ok);
    box.append(title, row, list, info, btns);
    ov.append(box);
    document.body.appendChild(ov);

    let cur = { path: "", parent: null };
    const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
    const close = () => { ov.remove(); document.removeEventListener("keydown", onKey, true); };
    document.addEventListener("keydown", onKey, true);
    ov.addEventListener("pointerdown", (e) => { if (e.target === ov) close(); });

    async function nav(p, fallback = true) {
        try {
            const r = await api.fetchApi(`/nougan/gallery/dirs?path=${encodeURIComponent(p)}`);
            const j = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
            cur = j;
            inp.value = j.path;
            up.disabled = j.parent === null;
            ok.disabled = !j.path;
            list.replaceChildren(...j.dirs.map((d) => {
                const it = h("div", "ngl-modal-item", "📁 " + d.name);
                it.addEventListener("click", () => nav(d.path));
                return it;
            }));
            if (!j.dirs.length) list.textContent = "No sub-folders here.";
            info.textContent = j.path
                ? `${j.images} image${j.images === 1 ? "" : "s"} in this folder`
                : "Pick a drive";
        } catch (e) {
            info.textContent = "⚠ " + e.message;
            if (fallback && p) nav("", false);
        }
    }

    up.addEventListener("click", () => { if (cur.parent !== null) nav(cur.parent); });
    go.addEventListener("click", () => nav(inp.value));
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") nav(inp.value); });
    cancel.addEventListener("click", close);
    ok.addEventListener("click", () => { if (cur.path) { onPick(cur.path); close(); } });
    nav((start || "").trim());
}

// ── the node UI ─────────────────────────────────────────────────────────────
function build(node) {
    const folderW = node.widgets?.find((w) => w.name === "folder");
    const selW = node.widgets?.find((w) => w.name === "selection");
    if (!folderW || !selW) return;

    // The selection JSON is internal: keep it in the saved workflow, but don't draw it.
    selW.hidden = true;
    selW.computeSize = () => [0, -4];
    selW.draw = () => {};

    // DOM
    const root = h("div", "ngl-root");
    const main = h("div", "ngl-main");
    const view = h("div", "ngl-view");
    const bg = h("canvas", "ngl-bg");
    const grid = h("div", "ngl-grid");
    const sep = h("div", "ngl-sep");
    const marq = h("div", "ngl-marq");
    const empty = h("div", "ngl-empty");
    view.append(bg, grid, sep, marq, empty);
    const vbar = h("div", "ngl-vbar ngl-idle");
    const vthumb = h("div", "ngl-vthumb");
    vbar.append(vthumb);
    main.append(view, vbar);

    const foot = h("div", "ngl-foot");
    const zIcon = h("span", "ngl-zi", "🔍");
    zIcon.title = "Thumbnail size (Ctrl + mouse wheel also works)";
    const slider = h("input", "ngl-zoom");
    slider.type = "range"; slider.min = "0"; slider.max = "1000"; slider.step = "1";
    slider.title = "Thumbnail size";
    const status = h("span", "ngl-status");
    const bClear = h("button", "ngl-btn", "Clear");
    bClear.title = "Deselect everything";
    const bBrowse = h("button", "ngl-btn", "📂");
    bBrowse.title = "Browse for a folder";
    const bRefresh = h("button", "ngl-btn", "🔄");
    bRefresh.title = "Re-scan the folder";
    foot.append(zIcon, slider, status, bClear, bBrowse, bRefresh);
    root.append(main, foot);

    node.addDOMWidget("gallery", "nougan_gallery", root, {
        serialize: false,
        hideOnZoom: false,
        getMinHeight: () => 140,
    });

    // State
    const st = {
        items: [], idx: new Map(), root: "", folder: "",
        selected: [],            // file names, selection order = P1..Pn
        active: new Set(),       // "marked" subset of selected (amber) — used for batch remove
        order: [], pinRows: 0,   // display order: pinned selection block first, then the rest
        zoom: DEFAULT_ZOOM, scroll: 0, maxScroll: 0,
        cols: 1, cell: 100, offX: 0, W: 0, H: 0,
        cells: new Map(),        // item index -> element
        preview: null, drag: null,
        raf: 0, auto: 0, token: 0, loading: false, error: "",
    };
    let bd = null; // WebGPU backdrop
    let ctx = null; // right-click menu

    const activeSel = () => (st.preview ? st.preview.sel : st.selected);
    const activeAct = () => (st.preview ? st.preview.act : st.active);
    const markDirty = () => { node.graph?.setDirtyCanvas?.(true, true); };

    // ── layout ──
    // Selected images are pinned in whole rows at the top (in P order); everything else follows.
    function rebuildOrder() {
        const pinned = [];
        for (const n of st.selected) {
            const i = st.idx.get(n);
            if (i !== undefined) pinned.push(i);
        }
        const pinSet = new Set(pinned);
        const cols = st.cols;
        const pinRows = Math.ceil(pinned.length / cols);
        const order = pinned.slice();
        while (order.length < pinRows * cols) order.push(-1);       // padding in the last pinned row
        for (let i = 0; i < st.items.length; i++) if (!pinSet.has(i)) order.push(i);
        st.order = order;
        st.pinRows = pinRows;
    }

    function refreshExtent() {
        const rows = Math.ceil(st.order.length / st.cols);
        st.maxScroll = Math.max(0, rows * st.cell - st.H);
        st.scroll = clamp(st.scroll, 0, st.maxScroll);
    }

    function layout() {
        const W = view.clientWidth, H = view.clientHeight;
        if (W <= 0 || H <= 0) return;
        const oldCell = st.cell, oldCols = st.cols;
        const anchor = oldCell > 0 ? (st.scroll / oldCell) * oldCols : 0;   // index at the top edge

        const maxS = Math.max(MIN_CELL, Math.min(W, H));                    // never bigger than the box
        const target = MIN_CELL + st.zoom * (maxS - MIN_CELL);
        const cols = Math.max(1, Math.floor(W / target));
        const cell = Math.min(W / cols, Math.max(H, MIN_CELL));
        st.W = W; st.H = H; st.cols = cols; st.cell = cell;
        st.offX = (W - cols * cell) / 2;

        if (cols !== oldCols || Math.abs(cell - oldCell) > 0.01) st.scroll = (anchor / cols) * cell;
        rebuildOrder();
        refreshExtent();
    }

    function schedule() {
        if (st.raf) return;
        st.raf = requestAnimationFrame(() => { st.raf = 0; render(); updateBar(); });
    }

    function setScroll(v) {
        st.scroll = clamp(v, 0, st.maxScroll);
        schedule();
    }

    function setZoom(z, persist = true) {
        st.zoom = clamp(z, 0, 1);
        slider.value = String(Math.round(st.zoom * 1000));
        layout();
        if (persist) {
            node.properties = node.properties || {};
            node.properties.nglZoom = +st.zoom.toFixed(3);
        }
        schedule();
    }

    // ── cells ──
    function makeCell(i) {
        const el = h("div", "ngl-cell");
        const inn = h("div", "ngl-in");
        const img = h("img");
        img.draggable = false;
        img.decoding = "async";
        img.alt = "";
        const badge = h("div", "ngl-badge");
        const x = h("button", "ngl-x", "✕");
        x.title = "Deselect";
        img.addEventListener("load", () => el.classList.add("ngl-loaded"));
        img.addEventListener("error", () => el.classList.add("ngl-err"));
        inn.append(img, badge, x);
        el.append(inn);
        el._i = i; el._img = img; el._badge = badge; el._b = 0; el._k = -1; el._a = null; el._s = 0;
        el.title = st.items[i].n;
        return el;
    }

    function dropCell(i, el) {
        el._img.removeAttribute("src");
        el.remove();
        st.cells.delete(i);
    }

    function clearCells() {
        for (const [i, el] of st.cells) dropCell(i, el);
    }

    function thumbURL(item, px) {
        return api.apiURL(
            `/nougan/gallery/thumb?path=${encodeURIComponent(st.root)}` +
            `&name=${encodeURIComponent(item.n)}&px=${px}&m=${item.m}`
        );
    }

    function render() {
        st.raf = 0;
        const total = st.order.length;
        const { cols, cell, offX, H } = st;
        if (!total || cell <= 0) { clearCells(); sep.style.display = "none"; return; }

        const r0 = Math.max(0, Math.floor(st.scroll / cell) - 1);
        const r1 = Math.min(Math.ceil(total / cols) - 1, Math.floor((st.scroll + H) / cell) + 1);
        const d0 = r0 * cols, d1 = Math.min(total - 1, (r1 + 1) * cols - 1);

        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const want = cell * dpr;
        const bucket = BUCKETS.find((b) => b >= want) || BUCKETS[BUCKETS.length - 1];
        const order = new Map();
        activeSel().forEach((nm, k) => order.set(nm, k + 1));
        const act = activeAct();

        const seen = new Set();
        for (let d = d0; d <= d1; d++) {
            const ii = st.order[d];
            if (ii < 0) continue;
            seen.add(ii);
            let el = st.cells.get(ii);
            if (!el) { el = makeCell(ii); st.cells.set(ii, el); grid.appendChild(el); }
            const x = Math.round(offX + (d % cols) * cell);
            const y = Math.round(Math.floor(d / cols) * cell - st.scroll);
            const s = Math.round(cell);
            el.style.transform = `translate(${x}px,${y}px)`;
            if (el._s !== s) { el.style.width = el.style.height = s + "px"; el._s = s; }
            if (el._b < bucket) { el._b = bucket; el._img.src = thumbURL(st.items[ii], bucket); }
            const nm = st.items[ii].n;
            const k = order.get(nm) || 0;
            if (el._k !== k) {
                el._k = k;
                el.classList.toggle("ngl-sel", k > 0);
                el._badge.textContent = k ? "P" + k : "";
            }
            const a = k > 0 && act.has(nm);
            if (el._a !== a) { el._a = a; el.classList.toggle("ngl-act", a); }
        }
        for (const [i, el] of st.cells) if (!seen.has(i)) dropCell(i, el);

        // divider under the pinned block
        const sy = st.pinRows * cell - st.scroll;
        if (st.pinRows > 0 && sy > 0 && sy < H) {
            sep.style.display = "block";
            sep.style.transform = `translateY(${Math.round(sy) - 1}px)`;
        } else {
            sep.style.display = "none";
        }
    }

    function updateBar() {
        const trackH = vbar.clientHeight;
        if (trackH <= 0) return;
        if (st.maxScroll <= 0) {
            vbar.classList.add("ngl-idle");
            vthumb.style.height = trackH + "px";
            vthumb.style.transform = "translateY(0)";
            return;
        }
        vbar.classList.remove("ngl-idle");
        const contentH = st.maxScroll + st.H;
        const th = Math.max(28, (trackH * st.H) / contentH);
        const range = trackH - th;
        vthumb.style.height = th + "px";
        vthumb.style.transform = `translateY(${(range * st.scroll) / st.maxScroll}px)`;
    }

    function updateStatus(msg) {
        const missing = st.selected.filter((n) => !st.idx.has(n)).length;
        status.textContent = msg ?? (
            `${st.selected.length} selected · ${st.items.length} image${st.items.length === 1 ? "" : "s"}` +
            (st.active.size ? ` · ${st.active.size} marked` : "") +
            (missing ? ` · ⚠ ${missing} missing` : "")
        );
        bClear.disabled = !st.selected.length;
    }

    function flash(msg) {
        updateStatus(msg);
        setTimeout(() => updateStatus(), 1800);
    }

    function updateEmpty() {
        let t = "";
        if (st.error) t = st.error;
        else if (!st.folder.trim()) t = "Paste a folder path in the “folder” field above,\nor click 📂 to browse.";
        else if (st.loading) t = "Loading…";
        else if (!st.items.length) t = "No images found in this folder.";
        empty.textContent = t;
        empty.style.display = t ? "flex" : "none";
    }

    // ── selection ──
    // `act` = the marked (amber) subset to keep; omitted = clear all marks.
    function commit(list, act) {
        const oldRows = st.pinRows;
        const oldCount = st.selected.length;
        const oldSet = new Set(st.selected);
        st.selected = list.slice(0, MAX_OUT);
        const keep = new Set(st.selected);
        st.active = new Set([...(act || [])].filter((n) => keep.has(n)));
        st.preview = null;

        rebuildOrder();
        // Newly selected images are pinned at the top, so jump there to show them.
        // (Removing images keeps your place in the library instead.)
        const added = st.selected.some((n) => !oldSet.has(n));
        if (added && st.selected.length >= oldCount) st.scroll = 0;
        else if (st.scroll > 0) st.scroll += (st.pinRows - oldRows) * st.cell;
        refreshExtent();

        selW.value = JSON.stringify(st.selected);
        syncOutputs(node, st.selected.length);
        schedule();
        updateStatus();
        markDirty();
    }

    // Item index under a point in view pixels (-1 = nothing).
    function hitTest(x, y) {
        const col = Math.floor((x - st.offX) / st.cell);
        const row = Math.floor((y + st.scroll) / st.cell);
        if (col < 0 || col >= st.cols || row < 0) return -1;
        const d = row * st.cols + col;
        return d < st.order.length ? st.order[d] : -1;
    }

    function marqueeHits(d) {
        const x0 = Math.min(d.sx, d.x), x1 = Math.max(d.sx, d.x);
        const y0 = Math.min(d.sy, d.y + st.scroll), y1 = Math.max(d.sy, d.y + st.scroll);
        const { cols, cell, offX } = st;
        const total = st.order.length;
        if (x1 < offX || x0 > offX + cols * cell) return [];
        const c0 = clamp(Math.floor((x0 - offX) / cell), 0, cols - 1);
        const c1 = clamp(Math.floor((x1 - offX) / cell), 0, cols - 1);
        const r0 = Math.max(0, Math.floor(y0 / cell)), r1 = Math.floor(y1 / cell);
        const out = [];
        for (let r = r0; r <= r1; r++) {
            for (let c = c0; c <= c1; c++) {
                const di = r * cols + c;
                if (di >= total) break;
                const ii = st.order[di];
                if (ii >= 0) out.push(st.items[ii].n);
            }
        }
        return out;
    }

    function showMarquee(d) {
        const x0 = Math.min(d.sx, d.x), x1 = Math.max(d.sx, d.x);
        const y0 = Math.min(d.sy, d.y + st.scroll) - st.scroll;
        const y1 = Math.max(d.sy, d.y + st.scroll) - st.scroll;
        const L = clamp(x0, 0, st.W), R = clamp(x1, 0, st.W);
        const T = clamp(y0, 0, st.H), B = clamp(y1, 0, st.H);
        marq.style.cssText = `display:block;left:${L}px;top:${T}px;width:${R - L}px;height:${B - T}px`;
    }

    function dragUpdate() {
        const d = st.drag;
        if (!d) return;
        showMarquee(d);
        const hits = marqueeHits(d);
        // A box always ADDS to the current selection. With Shift held, images that were
        // already selected and fall inside the box are also marked (amber) for batch removal.
        let sel = d.baseSel.slice();
        const act = new Set(d.baseAct);
        const seen = new Set(sel);
        for (const nm of hits) {
            if (seen.has(nm)) { if (d.additive) act.add(nm); }
            else { seen.add(nm); sel.push(nm); }
        }
        d.capped = sel.length > MAX_OUT;
        sel = sel.slice(0, MAX_OUT);
        st.preview = { sel, act };
        updateStatus(`${sel.length} selected…`);
        schedule();
    }

    function autoScrollTick() {
        const d = st.drag;
        if (!d || !d.moved) return;
        const edge = 28;
        let dy = 0;
        if (d.y < edge) dy = -clamp((edge - d.y) * 0.6, 0, 40);
        else if (d.y > st.H - edge) dy = clamp((d.y - (st.H - edge)) * 0.6, 0, 40);
        if (dy) { setScroll(st.scroll + dy); dragUpdate(); }
    }

    // Pointer position in the view's own (unscaled) pixels — correct at any canvas zoom.
    function toLocal(e) {
        const r = view.getBoundingClientRect();
        const sx = r.width / (view.offsetWidth || 1) || 1;
        const sy = r.height / (view.offsetHeight || 1) || 1;
        return { x: (e.clientX - r.left) / sx, y: (e.clientY - r.top) / sy };
    }

    view.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || e.target.closest(".ngl-x")) return;
        e.preventDefault();
        e.stopPropagation();
        closeCtx();
        const p = toLocal(e);
        st.drag = {
            vx: p.x, vy: p.y,
            sx: p.x, sy: p.y + st.scroll,
            x: p.x, y: p.y,
            moved: false, capped: false,
            additive: e.shiftKey || e.ctrlKey || e.metaKey,
            baseSel: st.selected.slice(),
            baseAct: new Set(st.active),
            hit: hitTest(p.x, p.y),
        };
        try { view.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        clearInterval(st.auto);
        st.auto = setInterval(autoScrollTick, 30);
    });

    view.addEventListener("pointermove", (e) => {
        const p = toLocal(e);
        if (bd) { bd.mx = clamp(p.x / (st.W || 1), 0, 1); bd.my = clamp(p.y / (st.H || 1), 0, 1); bd.target = 1; }
        const d = st.drag;
        if (!d) return;
        d.x = p.x; d.y = p.y;
        if (!d.moved && Math.hypot(p.x - d.vx, p.y - d.vy) > 5) d.moved = true;
        if (d.moved) dragUpdate();
    });

    view.addEventListener("pointerleave", () => { if (bd) bd.target = 0; });

    function endDrag(e, cancelled) {
        const d = st.drag;
        if (!d) return;
        st.drag = null;
        clearInterval(st.auto);
        marq.style.display = "none";
        try { view.releasePointerCapture(e.pointerId); } catch { /* ignore */ }

        if (cancelled) { st.preview = null; schedule(); updateStatus(); return; }

        if (d.moved) {
            const pv = st.preview || { sel: st.selected, act: st.active };
            commit(pv.sel, pv.act);
            if (d.capped) flash(`Max ${MAX_OUT} images`);
        } else if (d.hit >= 0) {
            const nm = st.items[d.hit].n;
            const isSel = st.selected.includes(nm);
            if (d.additive) {
                if (isSel) {
                    // Shift-click a pinned image: mark / unmark it for batch removal.
                    const act = new Set(st.active);
                    if (act.has(nm)) act.delete(nm); else act.add(nm);
                    commit(st.selected, act);
                } else if (st.selected.length >= MAX_OUT) {
                    flash(`Max ${MAX_OUT} images`);
                } else {
                    commit([...st.selected, nm], st.active);
                }
            } else if (isSel) {
                commit(st.selected.filter((x) => x !== nm));      // plain click on a selected image = toggle off
            } else if (st.selected.length >= MAX_OUT) {
                flash(`Max ${MAX_OUT} images`);
            } else {
                commit([...st.selected, nm]);                      // plain click on a new image = add it
            }
        } else {
            st.preview = null; schedule(); updateStatus();
        }
    }
    view.addEventListener("pointerup", (e) => endDrag(e, false));
    view.addEventListener("pointercancel", (e) => endDrag(e, true));

    // ✕ on a selected thumbnail
    grid.addEventListener("click", (e) => {
        const x = e.target.closest(".ngl-x");
        if (!x) return;
        e.stopPropagation();
        const it = st.items[x.closest(".ngl-cell")._i];
        if (it) commit(st.selected.filter((n) => n !== it.n), st.active);
    });

    // ── right-click: remove from selection ──
    function closeCtx() {
        if (!ctx) return;
        ctx.remove();
        ctx = null;
        document.removeEventListener("pointerdown", onCtxAway, true);
        document.removeEventListener("keydown", onCtxKey, true);
        window.removeEventListener("wheel", closeCtx, true);
        window.removeEventListener("blur", closeCtx);
    }
    function onCtxAway(e) { if (ctx && !ctx.contains(e.target)) closeCtx(); }
    function onCtxKey(e) { if (e.key === "Escape") { e.stopPropagation(); closeCtx(); } }

    function openCtx(cx, cy, targets) {
        closeCtx();
        ctx = h("div", "ngl-ctx");
        const item = h("div", "ngl-ctx-item",
            targets.length > 1 ? `Remove ${targets.length} images` : "Remove");
        ctx.append(item);
        ctx.style.left = clamp(cx, 4, window.innerWidth - 170) + "px";
        ctx.style.top = clamp(cy, 4, window.innerHeight - 50) + "px";
        document.body.appendChild(ctx);
        item.addEventListener("click", () => {
            commit(st.selected.filter((n) => !targets.includes(n)), st.active);
            closeCtx();
        });
        setTimeout(() => {
            if (!ctx) return;
            document.addEventListener("pointerdown", onCtxAway, true);
            document.addEventListener("keydown", onCtxKey, true);
            window.addEventListener("wheel", closeCtx, true);
            window.addEventListener("blur", closeCtx);
        }, 0);
    }

    view.addEventListener("contextmenu", (e) => {
        e.preventDefault();       // no browser / canvas menu over the gallery
        e.stopPropagation();
        closeCtx();
        if (st.drag) return;
        const p = toLocal(e);
        const hit = hitTest(p.x, p.y);
        if (hit < 0) return;
        const nm = st.items[hit].n;
        if (!st.selected.includes(nm)) return;                    // only selected images can be removed
        const targets = st.active.has(nm) ? [...st.active] : [nm];
        openCtx(e.clientX, e.clientY, targets);
    });

    // wheel: scroll (Ctrl = magnify). Must not reach the graph canvas, or it would zoom the whole canvas.
    main.addEventListener("wheel", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.ctrlKey || e.metaKey) setZoom(st.zoom - Math.sign(e.deltaY) * 0.04);
        else setScroll(st.scroll + e.deltaY * (e.deltaMode === 1 ? 32 : 1));
    }, { passive: false });

    // ── right-hand scrub bar ──
    let barDrag = null;
    vthumb.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        barDrag = { y0: e.clientY, s0: st.scroll };
        vthumb.setPointerCapture(e.pointerId);
        vthumb.classList.add("ngl-grab");
    });
    vthumb.addEventListener("pointermove", (e) => {
        if (!barDrag) return;
        const sc = vbar.getBoundingClientRect().height / (vbar.offsetHeight || 1) || 1;
        const range = Math.max(1, vbar.clientHeight - vthumb.offsetHeight);
        setScroll(barDrag.s0 + ((e.clientY - barDrag.y0) / sc) * (st.maxScroll / range));
    });
    const endBar = () => { barDrag = null; vthumb.classList.remove("ngl-grab"); };
    vthumb.addEventListener("pointerup", endBar);
    vthumb.addEventListener("pointercancel", endBar);
    vbar.addEventListener("pointerdown", (e) => {
        if (e.target === vthumb || st.maxScroll <= 0) return;
        e.preventDefault();
        e.stopPropagation();
        const r = vbar.getBoundingClientRect();
        const sc = r.height / (vbar.offsetHeight || 1) || 1;
        const y = (e.clientY - r.top) / sc;
        const th = vthumb.offsetHeight;
        const range = Math.max(1, vbar.clientHeight - th);
        setScroll(((y - th / 2) / range) * st.maxScroll);
    });

    // ── magnify slider ──
    slider.addEventListener("input", () => setZoom(Number(slider.value) / 1000));

    // ── folder handling ──
    async function loadFolder(path) {
        const tok = ++st.token;
        st.folder = path || "";
        st.error = "";
        if (!st.folder.trim()) {
            st.items = []; st.idx = new Map(); st.loading = false;
            clearCells(); layout(); updateBar(); updateEmpty(); updateStatus();
            return;
        }
        st.loading = true;
        updateEmpty();
        try {
            const r = await api.fetchApi(`/nougan/gallery/list?path=${encodeURIComponent(path)}`);
            const j = await r.json().catch(() => ({}));
            if (tok !== st.token) return;
            if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
            st.root = j.path;
            st.items = j.images;
            st.idx = new Map(j.images.map((it, i) => [it.n, i]));
            if (folderW.value !== j.path) folderW.value = j.path;
            st.folder = j.path;
        } catch (e) {
            if (tok !== st.token) return;
            st.items = []; st.idx = new Map();
            st.error = "⚠ " + (e.message || e);
        }
        st.loading = false;
        clearCells();
        layout();
        schedule();
        updateEmpty();
        updateStatus();
    }

    function folderChanged(v) {
        if ((v || "") === st.folder) { loadFolder(v); return; }   // same path: just re-scan, keep selection
        st.scroll = 0;
        commit([]);
        loadFolder(v);
    }

    const prevCb = folderW.callback;
    folderW.callback = function (v) {
        prevCb?.apply(this, arguments);
        folderChanged(v);
    };

    bBrowse.addEventListener("click", () => openFolderBrowser(folderW.value, (p) => {
        folderW.value = p;
        folderChanged(p);
    }));
    bRefresh.addEventListener("click", () => loadFolder(folderW.value));
    bClear.addEventListener("click", () => commit([]));

    // ── restore from saved workflow ──
    function restore() {
        let files = [];
        try {
            const v = JSON.parse(selW.value || "[]");
            const arr = Array.isArray(v) ? v : (v && Array.isArray(v.files) ? v.files : []);
            files = arr.filter((x) => typeof x === "string");
        } catch { /* ignore */ }
        st.selected = files.slice(0, MAX_OUT);
        st.active = new Set();
        const z = Number(node.properties?.nglZoom);
        st.zoom = Number.isFinite(z) ? clamp(z, 0, 1) : DEFAULT_ZOOM;
        slider.value = String(Math.round(st.zoom * 1000));
        syncOutputs(node, st.selected.length);
        layout();
        updateStatus();
        updateEmpty();
        loadFolder(folderW.value);
    }

    const origConfigure = node.onConfigure;
    node.onConfigure = function () {
        const r = origConfigure?.apply(this, arguments);
        restore();
        return r;
    };

    const origRemoved = node.onRemoved;
    node.onRemoved = function () {
        origRemoved?.apply(this, arguments);
        ro.disconnect();
        closeCtx();
        clearInterval(st.auto);
        cancelAnimationFrame(st.raf);
        bd?.stop();
    };

    const ro = new ResizeObserver(() => {
        layout();
        bd?.resize?.(st.W, st.H);
        schedule();
    });
    ro.observe(view);

    startBackdrop(bg).then((b) => {
        if (!b) return;
        bd = b;
        bg.classList.add("on");
        bd.resize(st.W || view.clientWidth, st.H || view.clientHeight);
    });

    // fresh node: compact starting size — drag the corner to make it as big as you like
    if (node.size) node.setSize([Math.max(node.size[0], 330), 350]);
    restore();
}

app.registerExtension({
    name: "Nougan.GalleryLoad",
    nodeCreated(node) {
        if (node.comfyClass !== NODE_ID && node.type !== NODE_ID) return;
        try {
            build(node);
        } catch (e) {
            console.error("[Nougan Gallery Load] failed to build UI", e);
        }
    },
});
