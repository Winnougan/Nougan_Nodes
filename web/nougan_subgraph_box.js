import { app } from "/scripts/app.js";

// Nougan Subgraph Box
// Hold V (a left-hand key, so your right hand stays on the mouse) and drag a box over nodes.
// Release and they become a subgraph. Hold V and box a subgraph node and it unpacks again.
//
// Rule, decided by what is inside the box when you let go:
//   - every captured node is a subgraph   -> UNPACK them
//   - two or more nodes, any mix          -> make a SUBGRAPH out of them
//   - anything else (0 nodes, 1 plain node) -> nothing happens
// The box and a label preview which one you are about to get.
//
// This does not reimplement subgraphs. It selects what you boxed and runs ComfyUI's own
// "Convert to Subgraph" / "Unpack Subgraph" commands (falling back to the litegraph methods where
// they exist), so wiring, inputs/outputs and undo behave exactly as the native feature does.
//
// Classic ComfyUI canvas only. Preview and flash are a DOM/SVG overlay; nothing touches the draw loop.

const KEY_SETTING = "Nougan.SubgraphBox.Key";
const CAPTURE_SETTING = "Nougan.SubgraphBox.Capture";
const BYPASS_KEY_SETTING = "Nougan.BypassSlash.Key";
const ZIPTIES_KEY_SETTING = "Nougan.ZipTies.Key";
const KEYS = ["V", "E", "D", "S", "A"]; // left-hand letters ComfyUI does not bind on their own
const CAPTURES = ["Fully enclosed", "Anything touched"];

const CMD_CONVERT = "Comfy.Graph.ConvertToSubgraph";
const CMD_UNPACK = "Comfy.Graph.UnpackSubgraph";

const COLORS = { subgraph: "#2dd4bf", unpack: "#fb923c", idle: "rgba(255,255,255,0.55)" };
const LABELS = { subgraph: "SUBGRAPH", unpack: "UNPACK" };

const state = {
    keyHeld: false,
    armed: false, // "Box subgraph" from the canvas menu: the next drag is a box
    stroke: null, // { start (graph), startClient, last (graph), lastClient, pointerId }
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
    const k = setting(KEY_SETTING, "V");
    return KEYS.includes(k) ? k : "V";
}
function keyActive() {
    // the other two gestures keep their keys if someone picks the same letter
    const k = keyName();
    return k !== setting(ZIPTIES_KEY_SETTING, "Z") && k !== setting(BYPASS_KEY_SETTING, "B");
}
function enclosedOnly() {
    return setting(CAPTURE_SETTING, CAPTURES[0]) !== CAPTURES[1];
}
function isTyping(e) {
    const el = e.target;
    return el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
}
function hasModifier(e) {
    return e.altKey || e.ctrlKey || e.metaKey || e.shiftKey;
}
function nodesOf(graph) {
    return graph._nodes ?? graph.nodes ?? [];
}
function isSubgraphNode(n) {
    return typeof n.isSubgraphNode === "function" ? n.isSubgraphNode() : !!n.subgraph;
}
function toast(msg, severity = "warn") {
    try {
        app.extensionManager?.toast?.add?.({ severity, summary: msg, life: 3500 });
    } catch { /* toast is optional */ }
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

/** [x, y, w, h] in graph space, title bar included. */
function nodeRect(node) {
    let b = null;
    try {
        b = node.getBounding?.(new Float32Array(4));
    } catch { /* fall through */ }
    if (b && b.length >= 4 && isFinite(b[0])) return [b[0], b[1], b[2], b[3]];
    const title = window.LiteGraph?.NODE_TITLE_HEIGHT ?? 30;
    return [node.pos[0], node.pos[1] - title, node.size[0], node.size[1] + title];
}

function capture(graph, a, b) {
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

function planFor(nodes) {
    if (!nodes.length) return { kind: "idle" };
    if (nodes.every(isSubgraphNode)) return { kind: "unpack" };
    if (nodes.length >= 2) return { kind: "subgraph" };
    return { kind: "idle" };
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
    const box = el("rect", { rx: 4, "stroke-width": 2 });
    box.style.display = "none";
    const preview = el("g", {});
    const label = el("text", {
        "font-size": 12,
        "font-weight": 700,
        "font-family": "ui-monospace,Consolas,monospace",
        stroke: "rgba(0,0,0,0.75)",
        "stroke-width": 3,
        "paint-order": "stroke",
    });
    label.style.display = "none";
    svg.append(preview, box, label);
    document.body.appendChild(svg);
    state.overlay = { svg, box, preview, label };
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
    state.overlay.box.style.display = "none";
    state.overlay.label.style.display = "none";
    state.overlay.preview.replaceChildren();
}

function paintStroke(canvas, nodes, plan) {
    const { box, preview, label } = overlay();
    const s = state.stroke;
    const color = COLORS[plan.kind];
    const x = Math.min(s.startClient[0], s.lastClient[0]);
    const y = Math.min(s.startClient[1], s.lastClient[1]);
    box.setAttribute("x", x);
    box.setAttribute("y", y);
    box.setAttribute("width", Math.abs(s.lastClient[0] - s.startClient[0]));
    box.setAttribute("height", Math.abs(s.lastClient[1] - s.startClient[1]));
    box.setAttribute("stroke", color);
    box.setAttribute("fill", color);
    box.setAttribute("fill-opacity", plan.kind === "idle" ? 0.03 : 0.07);
    if (plan.kind === "idle") box.setAttribute("stroke-dasharray", "6 5");
    else box.removeAttribute("stroke-dasharray");
    box.style.display = "block";

    preview.replaceChildren(...nodes.map((n) => rectEl(clientRect(canvas, nodeRect(n)), color, 0.16)));

    if (plan.kind === "idle") {
        label.style.display = "none";
        return;
    }
    const noun = plan.kind === "unpack" ? "subgraph" : "node";
    label.textContent = `${LABELS[plan.kind]} \u00B7 ${nodes.length} ${noun}${nodes.length === 1 ? "" : "s"}`;
    label.setAttribute("x", x + 6);
    label.setAttribute("y", y - 8);
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
        "padding:7px 14px;border-radius:999px;background:rgba(10,30,28,0.92);border:1px solid rgba(45,212,191,0.5);" +
        "color:#d0f5ef;font:600 11px ui-monospace,Consolas,monospace;letter-spacing:.02em;display:none;" +
        "box-shadow:0 4px 18px rgba(0,0,0,0.45)";
    document.body.appendChild(d);
    state.hint = d;
    return d;
}

function refreshHint(canvas) {
    const d = hint();
    const on = state.keyHeld || state.armed;
    d.textContent = `\u25A3 ${keyName()}  \u00B7  box nodes to make a subgraph  \u00B7  box a subgraph to unpack it`;
    d.style.display = on ? "block" : "none";
    const cv = canvas.canvas;
    if (cv && !state.stroke) cv.style.cursor = on ? "crosshair" : "";
}

/* ------------------------------ actions ----------------------------- */

function selectOnly(canvas, nodes) {
    canvas.deselectAll?.();
    if (canvas.selectItems) canvas.selectItems(nodes);
    else canvas.selectNodes?.(nodes);
}

async function runCommand(id) {
    const cmd = app.extensionManager?.command;
    if (!cmd?.execute) return false;
    try {
        await cmd.execute(id);
        return true;
    } catch (err) {
        console.warn(`[Nougan.SubgraphBox] ${id} failed`, err);
        return false;
    }
}

function direct(canvas, graph, fn) {
    graph.beforeChange?.();
    canvas.emitBeforeChange?.();
    try {
        fn();
    } finally {
        graph.afterChange?.();
        canvas.emitAfterChange?.();
    }
    commit(canvas);
}

async function makeSubgraph(canvas, graph, nodes) {
    const allStillThere = () => nodes.every((n) => nodesOf(graph).includes(n));
    await runCommand(CMD_CONVERT);
    if (allStillThere() && typeof graph.convertToSubgraph === "function") {
        try {
            direct(canvas, graph, () => graph.convertToSubgraph(new Set(nodes)));
        } catch (err) {
            console.warn("[Nougan.SubgraphBox] convertToSubgraph failed", err);
        }
    }
    if (allStillThere()) toast("Couldn't turn those nodes into a subgraph. This needs a ComfyUI frontend with subgraph support.");
}

async function unpackSubgraphs(canvas, graph, nodes) {
    const remaining = () => nodes.filter((n) => nodesOf(graph).includes(n));
    await runCommand(CMD_UNPACK);
    if (remaining().length && typeof graph.unpackSubgraph === "function") {
        try {
            direct(canvas, graph, () => {
                for (const n of remaining()) graph.unpackSubgraph(n);
            });
        } catch (err) {
            console.warn("[Nougan.SubgraphBox] unpackSubgraph failed", err);
        }
    }
    if (remaining().length === nodes.length) toast("Couldn't unpack that subgraph. This needs a newer ComfyUI frontend with Unpack Subgraph.");
}

async function applyBox(canvas, graph, start, end) {
    if (Math.hypot(end[0] - start[0], end[1] - start[1]) < 6 / canvas.ds.scale) return; // a click, not a box
    const nodes = capture(graph, start, end);
    const plan = planFor(nodes);
    if (plan.kind === "idle") return;

    flash(canvas, nodes, COLORS[plan.kind]);
    try {
        selectOnly(canvas, nodes);
        if (plan.kind === "subgraph") await makeSubgraph(canvas, graph, nodes);
        else await unpackSubgraphs(canvas, graph, nodes);
    } catch (err) {
        console.warn("[Nougan.SubgraphBox]", err);
        toast("Subgraph box failed. See the browser console for details.");
    }
    canvas.setDirty(true, true);
}

/* ------------------------------ strokes ----------------------------- */

function updatePreview(canvas) {
    state.frame = 0;
    const s = state.stroke;
    if (!s?.last || !canvas.graph) return;
    const nodes = capture(canvas.graph, s.start, s.last);
    paintStroke(canvas, nodes, planFor(nodes));
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

function setArmed(canvas, armed) {
    state.armed = armed;
    refreshHint(canvas);
}

/* ------------------------------- input ------------------------------ */

function installInput(canvas) {
    const cv = canvas.canvas;

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
        if (e.button !== 0 || e.target !== cv || !canvas.graph) return;
        const go = state.armed || (state.keyHeld && !hasModifier(e));
        if (!go) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (state.armed) setArmed(canvas, false);
        state.stroke = {
            start: graphPoint(canvas, e),
            last: null,
            startClient: [e.clientX, e.clientY],
            lastClient: [e.clientX, e.clientY],
            pointerId: e.pointerId,
        };
    }, true);

    window.addEventListener("pointermove", (e) => {
        const s = state.stroke;
        if (s && e.pointerId === s.pointerId) {
            e.stopImmediatePropagation();
            s.lastClient = [e.clientX, e.clientY];
            s.last = graphPoint(canvas, e);
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
        const start = s.start;
        endStroke(canvas);
        if (e.type === "pointerup" && canvas.graph) applyBox(canvas, canvas.graph, start, graphPoint(canvas, e));
    };
    window.addEventListener("pointerup", end, true);
    window.addEventListener("pointercancel", end, true);
}

/* ----------------------------- extension ---------------------------- */

app.registerExtension({
    name: "Nougan.SubgraphBox",

    settings: [
        {
            id: KEY_SETTING,
            category: ["Nougan", "Subgraph Box", "Key"],
            name: "Key to hold while boxing nodes",
            tooltip: "Hold this key and drag a box over nodes to turn them into a subgraph; box a subgraph to unpack it. Left-hand keys ComfyUI does not use on their own are offered.",
            type: "combo",
            options: KEYS,
            defaultValue: "V",
        },
        {
            id: CAPTURE_SETTING,
            category: ["Nougan", "Subgraph Box", "Capture"],
            name: "Which nodes the box captures",
            tooltip: "Fully enclosed: only nodes completely inside the box. Anything touched: every node the box overlaps.",
            type: "combo",
            options: CAPTURES,
            defaultValue: CAPTURES[0],
        },
    ],

    getCanvasMenuItems() {
        const canvas = app.canvas;
        if (!canvas) return [];
        return [null, { content: "Box subgraph", callback: () => setArmed(canvas, true) }];
    },

    async setup() {
        installInput(app.canvas);
    },
});
