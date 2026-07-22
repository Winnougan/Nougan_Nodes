// nougan-tab-cycler.js
// D:\ComfyUI\custom_nodes\Nougan\web\nougan-tab-cycler.js
//
// Tab / Shift+Tab cycles through number & slider widgets within a node.
// Works on ALL nodes in the graph (not just Nougan nodes).

import { app } from "../../scripts/app.js";

const DEBUG = false;
const log = (...a) => DEBUG && console.log("[tab-cycler]", ...a);

const ALLOWED = new Set(["number", "slider"]);
const activeIdx = new WeakMap();   // node → last active widget index
const clickXMap = new WeakMap();   // node → clientX of original click
let currentNode = null;

// ─── Helpers ────────────────────────────────────────────────────────────────

function eligible(node) {
    if (!node?.widgets) return [];
    return node.widgets.filter(w => ALLOWED.has(w.type) && !w.disabled && !w.hidden);
}

function getDialog() {
    return document.querySelector(".graphdialog");
}

function commitDialog() {
    const input = getDialog()?.querySelector("input");
    if (!input) return;
    input.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true,
    }));
}

function screenToGraph(cx, cy) {
    const c = app.canvas;
    const r = c.canvas.getBoundingClientRect();
    const s = c.ds.scale, o = c.ds.offset;
    return [(cx - r.left) / s - o[0], (cy - r.top) / s - o[1]];
}

function widgetAtLocalY(node, localY) {
    const ws = (node.widgets || []).filter(w => !w.hidden);
    if (!ws.length) return null;
    if (ws.every(w => typeof w.last_y === "number")) {
        let match = null;
        for (const w of ws) { if (w.last_y <= localY) match = w; else break; }
        return match || ws[0];
    }
    const th = (window.LiteGraph?.NODE_TITLE_HEIGHT) || 30;
    const rh = (window.LiteGraph?.NODE_WIDGET_HEIGHT) || 20;
    return ws[Math.max(0, Math.min(Math.floor((localY - th) / rh), ws.length - 1))];
}

function hitTest(cx, cy) {
    const graph = app.canvas?.graph;
    if (!graph) return null;
    const [gx, gy] = screenToGraph(cx, cy);
    for (const node of graph._nodes || []) {
        const [nx, ny] = node.pos, [w, h] = node.size;
        if (gx >= nx && gx <= nx + w && gy >= ny && gy <= ny + h) {
            return { node, widget: widgetAtLocalY(node, gy - ny) };
        }
    }
    return null;
}

function hookNode(node) {
    if (node.__tabHooked) return;
    node.__tabHooked = true;
    const orig = node.onMouseDown;
    node.onMouseDown = function (e, pos) {
        currentNode = node;
        if (pos) {
            const w = widgetAtLocalY(node, pos[1]);
            if (w && ALLOWED.has(w.type)) {
                const idx = eligible(node).indexOf(w);
                if (idx !== -1) activeIdx.set(node, idx);
            }
        }
        return orig?.apply(this, arguments);
    };
}

function fakeEvent(node, widget) {
    const c = app.canvas, r = c.canvas.getBoundingClientRect();
    const s = c.ds.scale, o = c.ds.offset;
    const gy = node.pos[1] + (typeof widget.last_y === "number" ? widget.last_y : 40);
    const cx = clickXMap.has(node)
        ? clickXMap.get(node)
        : r.left + (node.pos[0] + node.size[0] / 2 + o[0]) * s;
    return { clientX: cx, clientY: r.top + (gy + o[1]) * s, target: c.canvas };
}

function activate(node, widget) {
    const ev = fakeEvent(node, widget);
    app.canvas.prompt("Value", widget.value, v => {
        widget.value = v;
        widget.callback?.(widget.value, app.canvas, node, ev);
        node.graph?.setDirtyCanvas(true, true);
    }, ev);

    requestAnimationFrame(() => {
        const dlg = getDialog();
        if (!dlg) return;
        const name = dlg.querySelector(".name");
        if (name) name.textContent = widget.name;
        const input = dlg.querySelector("input");
        if (input) { input.focus(); input.select(); }
    });
}

// ─── Extension ──────────────────────────────────────────────────────────────

app.registerExtension({
    name: "Nougan.TabCycler",

    async nodeCreated(node) {
        hookNode(node);
    },

    setup() {
        // Hook nodes that existed before this extension registered
        (app.graph?._nodes || []).forEach(hookNode);

        // Track which node/widget was clicked
        app.canvas.canvas.addEventListener("pointerdown", e => {
            const hit = hitTest(e.clientX, e.clientY);
            if (!hit) return;
            currentNode = hit.node;
            if (hit.widget && ALLOWED.has(hit.widget.type)) {
                const idx = eligible(hit.node).indexOf(hit.widget);
                if (idx !== -1) activeIdx.set(hit.node, idx);
                clickXMap.set(hit.node, e.clientX);
            }
        }, true);

        // Tab / Shift+Tab handler
        document.addEventListener("keydown", e => {
            if (e.key !== "Tab") return;
            const node = currentNode;
            if (!node) return;

            const ws = eligible(node);
            if (!ws.length) return;
            if (!getDialog()) return; // only cycle while a value dialog is open

            e.preventDefault();
            e.stopPropagation();

            const idx = activeIdx.has(node) ? activeIdx.get(node) : 0;
            commitDialog();

            const next = (idx + (e.shiftKey ? -1 : 1) + ws.length) % ws.length;
            activeIdx.set(node, next);
            log("Tab →", ws[next]?.name);

            requestAnimationFrame(() => activate(node, ws[next]));
        }, true);
    },
});