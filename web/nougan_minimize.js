import { app } from "/scripts/app.js";

// Nougan Minimize
// Hold C (a left-hand key, so your right hand stays on the mouse) and drag with the left mouse button
// to minimize nodes. The drag is a BOX by default; hold Shift as you start it and it is a SLASH instead
// (a line: every node it crosses is hit). Settings > Nougan > Minimize swaps which one is the default.
//
// Rule, decided by what is under the box / slash when you let go:
//   - every node under it is already minimized -> EXPAND them all
//   - otherwise                                -> MINIMIZE them (ones already minimized stay as they are)
// The box or line and a label preview which one you are about to get. One gesture is one undo step.
// Nodes that cannot be collapsed (pinned nodes, Reroutes ...) are ignored.
//
// "Minimize" is ComfyUI's own node collapse, so it is the exact same state Alt+C / the dot in the
// node's title bar gives you. Nothing here is a custom node state.
//
// Classic ComfyUI canvas only. Preview and flash are a DOM/SVG overlay; nothing touches the draw loop.
//
// Key priority: if you pick a letter another Nougan gesture already uses, that gesture keeps it and
// this one switches itself off until you pick a different letter.

const KEY_SETTING = "Nougan.Minimize.Key";
const SHAPE_SETTING = "Nougan.Minimize.Shape";
const CAPTURE_SETTING = "Nougan.Minimize.Capture";
const OTHER_KEYS = [
    ["Nougan.ZipTies.Key", "Z"],
    ["Nougan.BypassSlash.Key", "B"],
    ["Nougan.SubgraphBox.Key", "V"],
    ["Nougan.GroupBox.Key", "G"],
    ["Nougan.GroupSwitch.Key", "S"],
];
const KEYS = ["C", "X", "T", "Y", "E", "D", "A"]; // left-hand letters ComfyUI does not bind on their own
const SHAPES = ["Box", "Slash"];
const CAPTURES = ["Fully enclosed", "Anything touched"];

const COLORS = { minimize: "#38bdf8", expand: "#4ade80", idle: "rgba(255,255,255,0.55)" };
const LABELS = { minimize: "MINIMIZE", expand: "EXPAND" };

const state = {
    keyHeld: false,
    shiftHeld: false,
    armed: null, // "box" | "slash" from the canvas menu: the next drag is that shape
    stroke: null, // { shape, start (graph), startClient, last (graph), lastClient, pointerId }
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
    const k = setting(KEY_SETTING, "C");
    return KEYS.includes(k) ? k : "C";
}
function keyActive() {
    // every other canvas gesture keeps its key if someone picks the same letter
    const k = keyName();
    return OTHER_KEYS.every(([id, def]) => k !== setting(id, def));
}
function defaultShape() {
    return setting(SHAPE_SETTING, SHAPES[0]) === SHAPES[1] ? "slash" : "box";
}
function enclosedOnly() {
    return setting(CAPTURE_SETTING, CAPTURES[0]) !== CAPTURES[1];
}
function isTyping(e) {
    const el = e.target;
    return el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
}
// Shift is how you flip box <-> slash, so it is allowed; anything else means a different shortcut.
function hasBlockingModifier(e) {
    return e.altKey || e.ctrlKey || e.metaKey;
}
function nodesOf(graph) {
    return graph._nodes ?? graph.nodes ?? [];
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
/** The shape a drag started now would have. */
function currentShape(shiftKey = state.shiftHeld) {
    if (state.armed) return state.armed;
    const base = defaultShape();
    if (!shiftKey) return base;
    return base === "box" ? "slash" : "box";
}

/* --------------------------- collapse state ------------------------- */

const isCollapsed = (n) => !!n.flags?.collapsed;
const canCollapse = (n) => n.collapsible !== false; // pinned nodes and Reroutes report false

function setCollapsed(node, want) {
    if (isCollapsed(node) === want) return;
    if (typeof node.collapse === "function") {
        node.collapse(); // ComfyUI's own toggle (no force: it refuses nodes that must not collapse)
    } else {
        node.flags = node.flags || {};
        node.flags.collapsed = want;
    }
}

/* ----------------------------- geometry ----------------------------- */

/** [x, y, w, h] in graph space, title bar included. A collapsed node is only its title bar. */
function nodeRect(node) {
    const title = window.LiteGraph?.NODE_TITLE_HEIGHT ?? 30;
    let b = null;
    try {
        b = node.getBounding?.(new Float32Array(4));
    } catch { /* fall through */ }
    let r;
    if (b && b.length >= 4 && isFinite(b[0])) r = [b[0], b[1], b[2], b[3]];
    else r = [node.pos[0], node.pos[1] - title, node.size[0], node.size[1] + title];
    if (isCollapsed(node)) {
        // some frontends keep reporting the expanded size for a collapsed node
        r[3] = Math.min(r[3], title);
        if (isFinite(node._collapsed_width) && node._collapsed_width > 0) r[2] = Math.min(r[2], node._collapsed_width);
    }
    return r;
}

function captureBox(graph, a, b) {
    const x0 = Math.min(a[0], b[0]);
    const y0 = Math.min(a[1], b[1]);
    const x1 = Math.max(a[0], b[0]);
    const y1 = Math.max(a[1], b[1]);
    const inside = enclosedOnly();
    const out = [];
    for (const node of nodesOf(graph)) {
        const [x, y, w, h] = nodeRect(node);
        const hit = inside
            ? x >= x0 && y >= y0 && x + w <= x1 && y + h <= y1
            : x < x1 && x + w > x0 && y < y1 && y + h > y0;
        if (hit) out.push(node);
    }
    return out;
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

function captureSlash(canvas, graph, p, q) {
    const pad = 2 / canvas.ds.scale;
    const out = [];
    for (const node of nodesOf(graph)) {
        const b = nodeRect(node);
        if (segmentHitsRect(p, q, [b[0] - pad, b[1] - pad, b[2] + pad * 2, b[3] + pad * 2])) out.push(node);
    }
    return out;
}

/** What the gesture would do right now: { plan: {kind, collapse}, nodes: the ones that would change }. */
function evaluate(canvas, graph, shape, a, b) {
    const hit = shape === "slash" ? captureSlash(canvas, graph, a, b) : captureBox(graph, a, b);
    const eligible = hit.filter(canCollapse);
    if (!eligible.length) return { plan: { kind: "idle" }, nodes: [] };
    if (eligible.every(isCollapsed)) return { plan: { kind: "expand", collapse: false }, nodes: eligible };
    return { plan: { kind: "minimize", collapse: true }, nodes: eligible.filter((n) => !isCollapsed(n)) };
}

function clientRect(canvas, r) {
    const base = canvas.canvas.getBoundingClientRect();
    const a = canvas.ds.convertOffsetToCanvas([r[0], r[1]]);
    const z = canvas.ds.convertOffsetToCanvas([r[0] + r[2], r[1] + r[3]]);
    return { x: base.left + a[0], y: base.top + a[1], w: z[0] - a[0], h: z[1] - a[1] };
}

/* ------------------------------ overlay ----------------------------- */

const NS = "http://www.w3.org/2000/svg";

function el(name, attrs) {
    const e = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    return e;
}

function overlay() {
    if (state.overlay) return state.overlay;
    const svg = el("svg", {});
    svg.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:9999";
    const preview = el("g", {});
    const box = el("rect", { rx: 4, "stroke-width": 2 });
    box.style.display = "none";
    const line = el("line", { "stroke-width": 2, "stroke-linecap": "round" });
    line.style.display = "none";
    const label = el("text", {
        "font-size": 12,
        "font-weight": 700,
        "font-family": "ui-monospace,Consolas,monospace",
        stroke: "rgba(0,0,0,0.75)",
        "stroke-width": 3,
        "paint-order": "stroke",
    });
    label.style.display = "none";
    svg.append(preview, box, line, label);
    document.body.appendChild(svg);
    state.overlay = { svg, preview, box, line, label };
    return state.overlay;
}

function rectEl(r, color, fillAlpha) {
    return el("rect", {
        x: r.x,
        y: r.y,
        width: Math.max(1, r.w),
        height: Math.max(1, r.h),
        rx: 8,
        fill: color,
        "fill-opacity": fillAlpha,
        stroke: color,
        "stroke-width": 2,
    });
}

function hideStrokeOverlay() {
    if (!state.overlay) return;
    const { box, line, label, preview } = state.overlay;
    box.style.display = "none";
    line.style.display = "none";
    label.style.display = "none";
    preview.replaceChildren();
}

function paintStroke(canvas, nodes, plan) {
    const { box, line, preview, label } = overlay();
    const s = state.stroke;
    const color = COLORS[plan.kind];
    const idle = plan.kind === "idle";

    if (s.shape === "box") {
        const x = Math.min(s.startClient[0], s.lastClient[0]);
        const y = Math.min(s.startClient[1], s.lastClient[1]);
        box.setAttribute("x", x);
        box.setAttribute("y", y);
        box.setAttribute("width", Math.abs(s.lastClient[0] - s.startClient[0]));
        box.setAttribute("height", Math.abs(s.lastClient[1] - s.startClient[1]));
        box.setAttribute("stroke", color);
        box.setAttribute("fill", color);
        box.setAttribute("fill-opacity", idle ? 0.03 : 0.07);
        if (idle) box.setAttribute("stroke-dasharray", "6 5");
        else box.removeAttribute("stroke-dasharray");
        box.style.display = "block";
    } else {
        line.setAttribute("stroke", color);
        if (idle) line.setAttribute("stroke-dasharray", "6 5");
        else line.removeAttribute("stroke-dasharray");
    }

    preview.replaceChildren(...nodes.map((n) => rectEl(clientRect(canvas, nodeRect(n)), color, 0.16)));

    if (idle) {
        label.style.display = "none";
        return;
    }
    label.textContent = `${LABELS[plan.kind]} \u00B7 ${nodes.length} node${nodes.length === 1 ? "" : "s"}`;
    if (s.shape === "box") {
        label.setAttribute("x", Math.min(s.startClient[0], s.lastClient[0]) + 6);
        label.setAttribute("y", Math.min(s.startClient[1], s.lastClient[1]) - 8);
    } else {
        label.setAttribute("x", s.lastClient[0] + 14);
        label.setAttribute("y", s.lastClient[1] - 14);
    }
    label.setAttribute("fill", color);
    label.style.display = "block";
}

function flash(canvas, nodes, color) {
    const { svg } = overlay();
    const g = el("g", {});
    g.style.opacity = "0.9";
    g.style.transition = "opacity 450ms ease-out";
    g.append(...nodes.map((n) => rectEl(clientRect(canvas, nodeRect(n)), color, 0.35)));
    svg.appendChild(g);
    requestAnimationFrame(() => requestAnimationFrame(() => (g.style.opacity = "0")));
    setTimeout(() => g.remove(), 600);
}

/* --------------------------- hint pill + cursor --------------------- */

function hint() {
    if (state.hint) return state.hint;
    const d = document.createElement("div");
    d.style.cssText =
        "position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:9999;pointer-events:none;" +
        "padding:7px 14px;border-radius:999px;background:rgba(8,24,36,0.92);border:1px solid rgba(56,189,248,0.5);" +
        "color:#d3effc;font:600 11px ui-monospace,Consolas,monospace;letter-spacing:.02em;display:none;" +
        "box-shadow:0 4px 18px rgba(0,0,0,0.45)";
    document.body.appendChild(d);
    state.hint = d;
    return d;
}

function refreshHint(canvas) {
    const d = hint();
    const on = state.keyHeld || state.armed;
    const shape = currentShape();
    const verb = shape === "slash" ? "slash across nodes" : "drag a box over nodes";
    const flip = shape === "slash" ? "box" : "slash";
    d.textContent =
        `${shape === "slash" ? "\u2571" : "\u25AD"} ${state.armed ? "next drag" : keyName()}  \u00B7  ${verb} to minimize them` +
        `  \u00B7  again to expand${state.armed ? "" : `  \u00B7  Shift: ${flip}`}`;
    d.style.display = on ? "block" : "none";
    const cv = canvas.canvas;
    if (cv && !state.stroke) cv.style.cursor = on ? "crosshair" : "";
}

/* ------------------------------ strokes ----------------------------- */

function updatePreview(canvas) {
    state.frame = 0;
    const s = state.stroke;
    if (!s?.last || !canvas.graph) return;
    const { plan, nodes } = evaluate(canvas, canvas.graph, s.shape, s.start, s.last);
    paintStroke(canvas, nodes, plan);
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

function applyStroke(canvas, graph, shape, start, end) {
    const tooShort = (shape === "box" ? 6 : 4) / canvas.ds.scale; // a click, not a gesture
    if (Math.hypot(end[0] - start[0], end[1] - start[1]) < tooShort) return;
    const { plan, nodes } = evaluate(canvas, graph, shape, start, end);
    if (plan.kind === "idle" || !nodes.length) return;

    flash(canvas, nodes, COLORS[plan.kind]);
    graph.beforeChange?.();
    canvas.emitBeforeChange?.();
    try {
        for (const node of nodes) setCollapsed(node, plan.collapse);
    } finally {
        graph.afterChange?.();
        canvas.emitAfterChange?.();
    }
    commit(canvas);
}

function setArmed(canvas, shape) {
    state.armed = shape;
    refreshHint(canvas);
}

/* ------------------------------- input ------------------------------ */

function installInput(canvas) {
    const cv = canvas.canvas;

    window.addEventListener("keydown", (e) => {
        if (e.code === "Escape") {
            if (state.stroke) endStroke(canvas);
            if (state.armed) setArmed(canvas, null);
        }
        if (e.key === "Shift" && !state.shiftHeld) {
            state.shiftHeld = true;
            if (state.keyHeld) refreshHint(canvas);
        }
        if (keyActive() && e.code === `Key${keyName()}` && !hasBlockingModifier(e) && !isTyping(e) && !state.keyHeld) {
            state.keyHeld = true;
            state.shiftHeld = e.shiftKey;
            refreshHint(canvas);
        }
    }, true);

    window.addEventListener("keyup", (e) => {
        if (e.key === "Shift" && state.shiftHeld) {
            state.shiftHeld = false;
            if (state.keyHeld) refreshHint(canvas);
        }
        if (e.code === `Key${keyName()}` && state.keyHeld) {
            state.keyHeld = false;
            refreshHint(canvas);
        }
    }, true);

    window.addEventListener("blur", () => {
        state.keyHeld = false;
        state.shiftHeld = false;
        if (state.stroke) endStroke(canvas);
        refreshHint(canvas);
    });

    window.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || e.target !== cv || !canvas.graph) return;
        const go = state.armed || (state.keyHeld && keyActive() && !hasBlockingModifier(e));
        if (!go) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        const shape = currentShape(e.shiftKey);
        if (state.armed) setArmed(canvas, null);
        state.stroke = {
            shape,
            start: graphPoint(canvas, e),
            last: null,
            startClient: [e.clientX, e.clientY],
            lastClient: [e.clientX, e.clientY],
            pointerId: e.pointerId,
        };
        if (shape === "slash") {
            const { line } = overlay();
            line.setAttribute("x1", e.clientX);
            line.setAttribute("y1", e.clientY);
            line.setAttribute("x2", e.clientX);
            line.setAttribute("y2", e.clientY);
            line.setAttribute("stroke", COLORS.idle);
            line.setAttribute("stroke-dasharray", "6 5");
            line.style.display = "block";
        }
    }, true);

    window.addEventListener("pointermove", (e) => {
        const s = state.stroke;
        if (s && e.pointerId === s.pointerId) {
            e.stopImmediatePropagation();
            s.lastClient = [e.clientX, e.clientY];
            s.last = graphPoint(canvas, e);
            if (s.shape === "slash") {
                const { line } = overlay();
                line.setAttribute("x2", e.clientX);
                line.setAttribute("y2", e.clientY);
            }
            schedulePreview(canvas);
            return;
        }
        // litegraph resets the cursor while handling the move; set ours afterwards
        if ((state.keyHeld || state.armed) && e.target === cv) requestAnimationFrame(() => (cv.style.cursor = "crosshair"));
    }, true);

    const end = (e) => {
        const s = state.stroke;
        if (!s || e.pointerId !== s.pointerId) return;
        e.stopImmediatePropagation();
        const { shape, start } = s;
        endStroke(canvas);
        if (e.type === "pointerup" && canvas.graph) applyStroke(canvas, canvas.graph, shape, start, graphPoint(canvas, e));
    };
    window.addEventListener("pointerup", end, true);
    window.addEventListener("pointercancel", end, true);
}

/* ----------------------------- extension ---------------------------- */

app.registerExtension({
    name: "Nougan.Minimize",

    settings: [
        {
            id: KEY_SETTING,
            category: ["Nougan", "Minimize", "Key"],
            name: "Key to hold while minimizing nodes",
            tooltip: "Hold this key and drag over nodes to minimize them; do it again over minimized nodes to expand them. Left-hand keys ComfyUI does not use on their own are offered. If another Nougan gesture already uses the letter, that one keeps it and this one switches off.",
            type: "combo",
            options: KEYS,
            defaultValue: "C",
        },
        {
            id: SHAPE_SETTING,
            category: ["Nougan", "Minimize", "Shape"],
            name: "Default drag shape",
            tooltip: "Box: drag a rectangle over the nodes. Slash: drag a line across them. Hold Shift as you start the drag to get the other one.",
            type: "combo",
            options: SHAPES,
            defaultValue: SHAPES[0],
        },
        {
            id: CAPTURE_SETTING,
            category: ["Nougan", "Minimize", "Capture"],
            name: "Which nodes a box captures",
            tooltip: "Fully enclosed: only nodes completely inside the box. Anything touched: every node the box overlaps. (A slash always hits every node the line crosses.)",
            type: "combo",
            options: CAPTURES,
            defaultValue: CAPTURES[0],
        },
    ],

    getCanvasMenuItems() {
        const canvas = app.canvas;
        if (!canvas) return [];
        return [
            null,
            { content: "Box minimize", callback: () => setArmed(canvas, "box") },
            { content: "Slash minimize", callback: () => setArmed(canvas, "slash") },
        ];
    },

    async setup() {
        installInput(app.canvas);
    },
});
