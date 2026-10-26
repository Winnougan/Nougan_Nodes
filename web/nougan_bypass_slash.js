import { app } from "/scripts/app.js";

// Nougan Bypass Slash
// Hold B and drag a line across nodes to bypass them. Slash across them again to bring them back.
// Same gesture works for muting (Settings > Nougan > Bypass Slash > Mode).
//
// Rule: if every node under the slash is already in the target mode, the slash restores them all;
// otherwise it puts all of them into the target mode. The slash line and a label preview which one
// you are about to get. One slash is one undo step.
//
// Classic ComfyUI canvas only. Preview and flash are a DOM/SVG overlay, so nothing here touches
// the canvas draw loop. Plain B is unbound in ComfyUI; Ctrl+B (native bypass) is left alone.

const KEY_SETTING = "Nougan.BypassSlash.Key";
const MODE_SETTING = "Nougan.BypassSlash.Mode";
const ZIPTIES_KEY_SETTING = "Nougan.ZipTies.Key";
const KEYS = ["B", "X", "C", "G", "T", "Y"]; // not Z: that's zip ties
const MODES = { Bypass: 4, Mute: 2 }; // ComfyUI: ALWAYS 0, NEVER (mute) 2, BYPASS 4
const ALWAYS = 0;

const COLORS = { bypass: "#d946ef", mute: "#94a3b8", restore: "#4ade80", idle: "rgba(255,255,255,0.55)" };
const LABELS = { bypass: "BYPASS", mute: "MUTE", restore: "RESTORE" };

const state = {
    keyHeld: false,
    armed: false, // "Slash bypass" from the canvas menu: the next drag is a slash
    stroke: null, // { start (graph), client, pointerId, last (graph), clientLast }
    frame: 0,
    overlay: null,
    hint: null,
};

/* ------------------------------ helpers ----------------------------- */

function setting(id, fallback) {
    try {
        return app.extensionManager?.setting?.get?.(id) ?? app.ui?.settings?.getSettingValue?.(id) ?? fallback;
    } catch {
        return fallback;
    }
}
function keyName() {
    const k = setting(KEY_SETTING, "B");
    return KEYS.includes(k) ? k : "B";
}
function keyActive() {
    // if someone sets both gestures to the same key, zip ties keeps it
    return keyName() !== setting(ZIPTIES_KEY_SETTING, "Z");
}
function targetMode() {
    return MODES[setting(MODE_SETTING, "Bypass")] ?? 4;
}
function isTyping(e) {
    const el = e.target;
    return el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
}
function hasModifier(e) {
    return e.altKey || e.ctrlKey || e.metaKey || e.shiftKey;
}
function graphPoint(canvas, e) {
    const rect = canvas.canvas.getBoundingClientRect();
    return canvas.ds.convertCanvasToOffset([e.clientX - rect.left, e.clientY - rect.top]);
}
function commit(canvas) {
    canvas.setDirty(true, true);
    const ct = app.extensionManager?.workflow?.activeWorkflow?.changeTracker;
    const capture = ct?.captureCanvasState ?? ct?.checkState;
    if (capture) capture.call(ct);
    else window.dispatchEvent(new MouseEvent("mouseup"));
}

/* ----------------------------- geometry ----------------------------- */

function nodeBounds(node) {
    let b = null;
    try {
        b = node.getBounding?.(new Float32Array(4));
    } catch { /* fall through */ }
    if (b && b.length >= 4 && isFinite(b[0])) return [b[0], b[1], b[2], b[3]];
    const title = window.LiteGraph?.NODE_TITLE_HEIGHT ?? 30;
    return [node.pos[0], node.pos[1] - title, node.size[0], node.size[1] + title];
}

// Liang-Barsky: does the segment p->q touch the rectangle?
function segmentHitsRect(p, q, [x, y, w, h]) {
    let t0 = 0;
    let t1 = 1;
    const dx = q[0] - p[0];
    const dy = q[1] - p[1];
    const clip = (pp, qq) => {
        if (pp === 0) return qq >= 0;
        const r = qq / pp;
        if (pp < 0) {
            if (r > t1) return false;
            if (r > t0) t0 = r;
        } else {
            if (r < t0) return false;
            if (r < t1) t1 = r;
        }
        return true;
    };
    return clip(-dx, p[0] - x) && clip(dx, x + w - p[0]) && clip(-dy, p[1] - y) && clip(dy, y + h - p[1]);
}

function nodesOnStroke(canvas, graph, p, q) {
    const pad = 2 / canvas.ds.scale;
    const out = [];
    for (const node of graph._nodes ?? graph.nodes ?? []) {
        const b = nodeBounds(node);
        if (segmentHitsRect(p, q, [b[0] - pad, b[1] - pad, b[2] + pad * 2, b[3] + pad * 2])) out.push(node);
    }
    return out;
}

function planFor(hits) {
    if (!hits.length) return { kind: "idle", next: null };
    const target = targetMode();
    if (hits.every((n) => n.mode === target)) return { kind: "restore", next: ALWAYS };
    return { kind: target === 4 ? "bypass" : "mute", next: target };
}

function clientRect(canvas, b) {
    const base = canvas.canvas.getBoundingClientRect();
    const a = canvas.ds.convertOffsetToCanvas([b[0], b[1]]);
    const z = canvas.ds.convertOffsetToCanvas([b[0] + b[2], b[1] + b[3]]);
    return { x: base.left + a[0], y: base.top + a[1], w: z[0] - a[0], h: z[1] - a[1] };
}

/* ------------------------------ overlay ----------------------------- */

function overlay() {
    if (state.overlay) return state.overlay;
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:9999";
    const preview = document.createElementNS(ns, "g");
    preview.style.display = "none";
    const line = document.createElementNS(ns, "line");
    line.setAttribute("stroke-width", "2");
    line.setAttribute("stroke-linecap", "round");
    line.style.display = "none";
    const label = document.createElementNS(ns, "text");
    label.setAttribute("font-size", "12");
    label.setAttribute("font-weight", "700");
    label.setAttribute("font-family", "ui-monospace,Consolas,monospace");
    label.setAttribute("stroke", "rgba(0,0,0,0.75)");
    label.setAttribute("stroke-width", "3");
    label.setAttribute("paint-order", "stroke");
    label.style.display = "none";
    svg.append(preview, line, label);
    document.body.appendChild(svg);
    state.overlay = { svg, preview, line, label };
    return state.overlay;
}

function rectEl(r, color, fillAlpha) {
    const el = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    el.setAttribute("x", r.x);
    el.setAttribute("y", r.y);
    el.setAttribute("width", Math.max(1, r.w));
    el.setAttribute("height", Math.max(1, r.h));
    el.setAttribute("rx", 8);
    el.setAttribute("fill", color);
    el.setAttribute("fill-opacity", fillAlpha);
    el.setAttribute("stroke", color);
    el.setAttribute("stroke-width", 2);
    return el;
}

function hideStrokeOverlay() {
    if (!state.overlay) return;
    state.overlay.line.style.display = "none";
    state.overlay.label.style.display = "none";
    state.overlay.preview.style.display = "none";
    state.overlay.preview.replaceChildren();
}

function paintStroke(canvas, hits, plan) {
    const { preview, line, label } = overlay();
    const color = COLORS[plan.kind];
    line.setAttribute("stroke", color);
    if (plan.kind === "idle") line.setAttribute("stroke-dasharray", "6 5");
    else line.removeAttribute("stroke-dasharray");

    preview.replaceChildren(...hits.map((n) => rectEl(clientRect(canvas, nodeBounds(n)), color, 0.16)));
    preview.style.display = "block";

    if (plan.kind === "idle") {
        label.style.display = "none";
    } else {
        const [cx, cy] = state.stroke.clientLast;
        label.textContent = `${LABELS[plan.kind]} \u00B7 ${hits.length} node${hits.length === 1 ? "" : "s"}`;
        label.setAttribute("x", cx + 14);
        label.setAttribute("y", cy - 14);
        label.setAttribute("fill", color);
        label.style.display = "block";
    }
}

function flash(canvas, hits, color) {
    const { svg } = overlay();
    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    g.style.opacity = "0.9";
    g.style.transition = "opacity 450ms ease-out";
    g.append(...hits.map((n) => rectEl(clientRect(canvas, nodeBounds(n)), color, 0.35)));
    svg.appendChild(g);
    requestAnimationFrame(() => requestAnimationFrame(() => (g.style.opacity = "0")));
    setTimeout(() => g.remove(), 600);
}

/* --------------------------- hint pill + cursor --------------------- */

function hint() {
    if (state.hint) return state.hint;
    const el = document.createElement("div");
    el.style.cssText =
        "position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:9999;pointer-events:none;" +
        "padding:7px 14px;border-radius:999px;background:rgba(15,31,15,0.92);border:1px solid rgba(74,222,128,0.45);" +
        "color:#d6f5df;font:600 11px ui-monospace,Consolas,monospace;letter-spacing:.02em;display:none;" +
        "box-shadow:0 4px 18px rgba(0,0,0,0.45)";
    document.body.appendChild(el);
    state.hint = el;
    return el;
}

function refreshHint(canvas) {
    const el = hint();
    const on = state.keyHeld || state.armed;
    const mode = setting(MODE_SETTING, "Bypass").toLowerCase();
    el.textContent = `\u26A1 ${keyName()}  \u00B7  slash across nodes to ${mode} them  \u00B7  slash again to restore`;
    el.style.display = on ? "block" : "none";
    const cv = canvas.canvas;
    if (cv && !state.stroke) cv.style.cursor = on ? "crosshair" : "";
}

/* ------------------------------ strokes ----------------------------- */

function updatePreview(canvas) {
    state.frame = 0;
    const s = state.stroke;
    if (!s?.last || !canvas.graph) return;
    const hits = nodesOnStroke(canvas, canvas.graph, s.start, s.last);
    paintStroke(canvas, hits, planFor(hits));
}

function schedulePreview(canvas) {
    if (!state.frame) state.frame = requestAnimationFrame(() => updatePreview(canvas));
}

function endStroke(canvas) {
    if (state.frame) cancelAnimationFrame(state.frame);
    state.frame = 0;
    state.stroke = null;
    hideStrokeOverlay();
    refreshHint(canvas);
}

function applyStroke(canvas, graph, start, end) {
    if (Math.hypot(end[0] - start[0], end[1] - start[1]) < 4 / canvas.ds.scale) return;
    const hits = nodesOnStroke(canvas, graph, start, end);
    const plan = planFor(hits);
    if (!hits.length) return;

    flash(canvas, hits, COLORS[plan.kind]);
    graph.beforeChange?.();
    canvas.emitBeforeChange?.();
    try {
        for (const node of hits) node.mode = plan.next;
    } finally {
        graph.afterChange?.();
        canvas.emitAfterChange?.();
    }
    commit(canvas);
}

function setArmed(canvas, armed) {
    state.armed = armed;
    refreshHint(canvas);
}

/* ------------------------------- input ------------------------------ */

function installInput(canvas) {
    const el = canvas.canvas;

    window.addEventListener("keydown", (e) => {
        if (e.code === "Escape") {
            if (state.stroke) endStroke(canvas);
            if (state.armed) setArmed(canvas, false);
        }
        if (keyActive() && e.code === `Key${keyName()}` && !hasModifier(e) && !isTyping(e) && !state.keyHeld) {
            state.keyHeld = true;
            refreshHint(canvas);
        }
    }, true);

    window.addEventListener("keyup", (e) => {
        if (e.code === `Key${keyName()}` && state.keyHeld) {
            state.keyHeld = false;
            refreshHint(canvas);
        }
    }, true);

    window.addEventListener("blur", () => {
        state.keyHeld = false;
        if (state.stroke) endStroke(canvas);
        refreshHint(canvas);
    });

    window.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || e.target !== el || !canvas.graph) return;
        const go = state.armed || (state.keyHeld && !hasModifier(e));
        if (!go) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (state.armed) setArmed(canvas, false);
        state.stroke = {
            start: graphPoint(canvas, e),
            last: null,
            client: [e.clientX, e.clientY],
            clientLast: [e.clientX, e.clientY],
            pointerId: e.pointerId,
        };
        const { line } = overlay();
        line.setAttribute("x1", e.clientX);
        line.setAttribute("y1", e.clientY);
        line.setAttribute("x2", e.clientX);
        line.setAttribute("y2", e.clientY);
        line.setAttribute("stroke", COLORS.idle);
        line.setAttribute("stroke-dasharray", "6 5");
        line.style.display = "block";
    }, true);

    window.addEventListener("pointermove", (e) => {
        const s = state.stroke;
        if (s && e.pointerId === s.pointerId) {
            e.stopImmediatePropagation();
            s.clientLast = [e.clientX, e.clientY];
            s.last = graphPoint(canvas, e);
            const { line } = overlay();
            line.setAttribute("x2", e.clientX);
            line.setAttribute("y2", e.clientY);
            schedulePreview(canvas);
            return;
        }
        // litegraph resets the cursor while handling the move; set ours afterwards
        if ((state.keyHeld || state.armed) && e.target === el) requestAnimationFrame(() => (el.style.cursor = "crosshair"));
    }, true);

    const end = (e) => {
        const s = state.stroke;
        if (!s || e.pointerId !== s.pointerId) return;
        e.stopImmediatePropagation();
        const start = s.start;
        endStroke(canvas);
        if (e.type === "pointerup" && canvas.graph) applyStroke(canvas, canvas.graph, start, graphPoint(canvas, e));
    };
    window.addEventListener("pointerup", end, true);
    window.addEventListener("pointercancel", end, true);
}

/* ----------------------------- extension ---------------------------- */

app.registerExtension({
    name: "Nougan.BypassSlash",

    settings: [
        {
            id: KEY_SETTING,
            category: ["Nougan", "Bypass Slash", "Key"],
            name: "Key to hold while slashing across nodes",
            tooltip: "Hold this key and drag a line across nodes to bypass them; slash across them again to restore them. Only keys ComfyUI does not use on their own are offered.",
            type: "combo",
            options: KEYS,
            defaultValue: "B",
        },
        {
            id: MODE_SETTING,
            category: ["Nougan", "Bypass Slash", "Mode"],
            name: "What a slash does",
            tooltip: "Bypass passes inputs straight through the node. Mute skips the node and everything that only feeds it.",
            type: "combo",
            options: Object.keys(MODES),
            defaultValue: "Bypass",
        },
    ],

    getCanvasMenuItems() {
        const canvas = app.canvas;
        if (!canvas) return [];
        return [null, { content: "Slash bypass", callback: () => setArmed(canvas, true) }];
    },

    async setup() {
        installInput(app.canvas);
    },
});
