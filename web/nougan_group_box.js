import { app } from "/scripts/app.js";

// Nougan Group Box
// Hold G (a left-hand key, so your right hand stays on the mouse) and drag a box over nodes.
// Release and they are wrapped in a group. Box exactly the nodes of an existing group and the
// group is removed again (the nodes stay).
//
// Rule, decided by what is inside the box when you let go:
//   - the captured nodes are exactly the nodes inside an existing group -> UNGROUP it
//   - one or more nodes, anything else                                  -> make a GROUP around them
//   - no nodes                                                          -> nothing happens
// The box, a dashed frame of the group to come, and a label preview which one you are about to get.
//
// With the default colour this runs ComfyUI's own "Group Selected Nodes" command, so the padding
// setting and the type-the-name-right-away title editor behave exactly as with Ctrl+G. If you pick a
// colour (or the command is missing) the group is built directly so title and colour land in the
// same single undo step.
//
// Classic ComfyUI canvas only. Preview and flash are a DOM/SVG overlay; nothing touches the draw loop.

const KEY_SETTING = "Nougan.GroupBox.Key";
const CAPTURE_SETTING = "Nougan.GroupBox.Capture";
const COLOR_SETTING = "Nougan.GroupBox.Color";
const TITLE_SETTING = "Nougan.GroupBox.Title";
const OTHER_KEYS = [
    ["Nougan.ZipTies.Key", "Z"],
    ["Nougan.BypassSlash.Key", "B"],
    ["Nougan.SubgraphBox.Key", "V"],
];
const KEYS = ["G", "E", "D", "S", "A"]; // left-hand letters ComfyUI does not bind on its own
const CAPTURES = ["Fully enclosed", "Anything touched"];
// Same palette as ComfyUI's group colours.
const COLORS_BY_NAME = {
    Default: null,
    Red: "#A88",
    Brown: "#b06634",
    Green: "#8A8",
    Blue: "#88A",
    "Pale blue": "#3f789e",
    Cyan: "#8AA",
    Purple: "#a1309b",
    Yellow: "#b58b2a",
    Black: "#444",
};

const CMD_GROUP = "Comfy.Graph.GroupSelectedNodes";
const PADDING = 10; // matches ComfyUI's default group padding; used for the preview and the direct build

const COLORS = { group: "#60a5fa", ungroup: "#f87171", idle: "rgba(255,255,255,0.55)" };
const LABELS = { group: "GROUP", ungroup: "UNGROUP" };

const state = {
    keyHeld: false,
    armed: false, // "Box group" from the canvas menu: the next drag is a box
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
    const k = setting(KEY_SETTING, "G");
    return KEYS.includes(k) ? k : "G";
}
function keyActive() {
    // the other gestures keep their keys if someone picks the same letter
    const k = keyName();
    return OTHER_KEYS.every(([id, def]) => k !== setting(id, def));
}
function enclosedOnly() {
    return setting(CAPTURE_SETTING, CAPTURES[0]) !== CAPTURES[1];
}
function chosenColor() {
    return COLORS_BY_NAME[setting(COLOR_SETTING, "Default")] ?? null;
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
function groupsOf(graph) {
    return graph._groups ?? graph.groups ?? [];
}
function toast(msg) {
    try {
        app.extensionManager?.toast?.add?.({ severity: "warn", summary: msg, life: 3500 });
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

function groupRect(g) {
    return [g.pos[0], g.pos[1], g.size[0], g.size[1]];
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

/** Nodes whose centre sits inside the group, which is how litegraph decides membership. */
function nodesInside(graph, group) {
    const [x, y, w, h] = groupRect(group);
    return nodesOf(graph).filter((n) => {
        const r = nodeRect(n);
        const cx = r[0] + r[2] / 2;
        const cy = r[1] + r[3] / 2;
        return cx >= x && cx <= x + w && cy >= y && cy <= y + h;
    });
}

function exactGroup(graph, nodes) {
    const set = new Set(nodes);
    let best = null;
    for (const g of groupsOf(graph)) {
        const inside = nodesInside(graph, g);
        if (inside.length !== set.size || !inside.every((n) => set.has(n))) continue;
        // several groups around the same nodes: take the innermost (smallest) one
        if (!best || g.size[0] * g.size[1] < best.size[0] * best.size[1]) best = g;
    }
    return best;
}

function planFor(graph, nodes) {
    if (!nodes.length) return { kind: "idle" };
    const group = exactGroup(graph, nodes);
    if (group) return { kind: "ungroup", group };
    return { kind: "group" };
}

function unionRect(nodes) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of nodes) {
        const r = nodeRect(n);
        x0 = Math.min(x0, r[0]);
        y0 = Math.min(y0, r[1]);
        x1 = Math.max(x1, r[0] + r[2]);
        y1 = Math.max(y1, r[1] + r[3]);
    }
    return [x0, y0, x1 - x0, y1 - y0];
}

/** Where the new group will roughly sit, so the preview can show its frame. */
function predictedFrame(nodes) {
    const u = unionRect(nodes);
    const titleH = 34;
    return [u[0] - PADDING, u[1] - PADDING - titleH, u[2] + PADDING * 2, u[3] + PADDING * 2 + titleH];
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

function rectEl(r, color, fillAlpha, dashed = false) {
    const e = el("rect", {
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
    if (dashed) e.setAttribute("stroke-dasharray", "7 5");
    return e;
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
    box.setAttribute("fill-opacity", plan.kind === "idle" ? 0.03 : 0.06);
    if (plan.kind === "idle") box.setAttribute("stroke-dasharray", "6 5");
    else box.removeAttribute("stroke-dasharray");
    box.style.display = "block";

    const els = nodes.map((n) => rectEl(clientRect(canvas, nodeRect(n)), color, 0.14));
    if (plan.kind === "group") els.push(rectEl(clientRect(canvas, predictedFrame(nodes)), color, 0.05, true));
    if (plan.kind === "ungroup") els.push(rectEl(clientRect(canvas, groupRect(plan.group)), color, 0.1, true));
    preview.replaceChildren(...els);

    if (plan.kind === "idle") {
        label.style.display = "none";
        return;
    }
    label.textContent = `${LABELS[plan.kind]} \u00B7 ${nodes.length} node${nodes.length === 1 ? "" : "s"}`;
    label.setAttribute("x", x + 6);
    label.setAttribute("y", y - 8);
    label.setAttribute("fill", color);
    label.style.display = "block";
}

function flash(canvas, rects, color) {
    const { svg } = overlay();
    const g = el("g", {});
    g.style.opacity = "0.9";
    g.style.transition = "opacity 450ms ease-out";
    g.append(...rects.map((r) => rectEl(clientRect(canvas, r), color, 0.35)));
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
        "padding:7px 14px;border-radius:999px;background:rgba(10,20,36,0.92);border:1px solid rgba(96,165,250,0.5);" +
        "color:#d6e6fb;font:600 11px ui-monospace,Consolas,monospace;letter-spacing:.02em;display:none;" +
        "box-shadow:0 4px 18px rgba(0,0,0,0.45)";
    document.body.appendChild(d);
    state.hint = d;
    return d;
}

function refreshHint(canvas) {
    const d = hint();
    const on = state.keyHeld || state.armed;
    d.textContent = `\u25A2 ${keyName()}  \u00B7  box nodes to group them  \u00B7  box a whole group to ungroup it`;
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
        console.warn(`[Nougan.GroupBox] ${id} failed`, err);
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

function buildGroup(canvas, graph, nodes, color) {
    const Group = window.LiteGraph?.LGraphGroup;
    if (!Group) return null;
    const title = String(setting(TITLE_SETTING, "Group") || "Group");
    let made = null;
    direct(canvas, graph, () => {
        const g = new Group(title);
        if (color) g.color = color;
        if (typeof g.resizeTo === "function") {
            g.resizeTo(nodes, PADDING);
        } else {
            const f = predictedFrame(nodes);
            g.pos = [f[0], f[1]];
            g.size = [f[2], f[3]];
        }
        graph.add(g);
        made = g;
    });
    return made;
}

async function makeGroup(canvas, graph, nodes) {
    const before = new Set(groupsOf(graph));
    const color = chosenColor();
    let made = false;

    if (!color) {
        selectOnly(canvas, nodes);
        await runCommand(CMD_GROUP);
        made = groupsOf(graph).some((g) => !before.has(g));
    }
    if (!made) made = !!buildGroup(canvas, graph, nodes, color);
    if (!made) toast("Couldn't create a group. This needs a ComfyUI frontend with groups available.");
}

function removeGroup(canvas, graph, group) {
    direct(canvas, graph, () => graph.remove(group));
}

async function applyBox(canvas, graph, start, end) {
    if (Math.hypot(end[0] - start[0], end[1] - start[1]) < 6 / canvas.ds.scale) return; // a click, not a box
    const nodes = capture(graph, start, end);
    const plan = planFor(graph, nodes);
    if (plan.kind === "idle") return;

    flash(canvas, plan.kind === "ungroup" ? [groupRect(plan.group)] : nodes.map(nodeRect), COLORS[plan.kind]);
    try {
        if (plan.kind === "group") await makeGroup(canvas, graph, nodes);
        else removeGroup(canvas, graph, plan.group);
    } catch (err) {
        console.warn("[Nougan.GroupBox]", err);
        toast("Group box failed. See the browser console for details.");
    }
    canvas.setDirty(true, true);
}

/* ------------------------------ strokes ----------------------------- */

function updatePreview(canvas) {
    state.frame = 0;
    const s = state.stroke;
    if (!s?.last || !canvas.graph) return;
    const nodes = capture(canvas.graph, s.start, s.last);
    paintStroke(canvas, nodes, planFor(canvas.graph, nodes));
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
    name: "Nougan.GroupBox",

    settings: [
        {
            id: KEY_SETTING,
            category: ["Nougan", "Group Box", "Key"],
            name: "Key to hold while boxing nodes",
            tooltip: "Hold this key and drag a box over nodes to wrap them in a group; box a whole group again to remove it. Left-hand keys ComfyUI does not use on their own are offered.",
            type: "combo",
            options: KEYS,
            defaultValue: "G",
        },
        {
            id: CAPTURE_SETTING,
            category: ["Nougan", "Group Box", "Capture"],
            name: "Which nodes the box captures",
            tooltip: "Fully enclosed: only nodes completely inside the box. Anything touched: every node the box overlaps.",
            type: "combo",
            options: CAPTURES,
            defaultValue: CAPTURES[0],
        },
        {
            id: COLOR_SETTING,
            category: ["Nougan", "Group Box", "Colour"],
            name: "Colour of new groups",
            tooltip: "Default uses ComfyUI's own Group Selected Nodes (type the name right away). Picking a colour builds the group directly with the title below.",
            type: "combo",
            options: Object.keys(COLORS_BY_NAME),
            defaultValue: "Default",
        },
        {
            id: TITLE_SETTING,
            category: ["Nougan", "Group Box", "Title"],
            name: "Title of new groups (when a colour is chosen)",
            type: "text",
            defaultValue: "Group",
        },
    ],

    getCanvasMenuItems() {
        const canvas = app.canvas;
        if (!canvas) return [];
        return [null, { content: "Box group", callback: () => setArmed(canvas, true) }];
    },

    async setup() {
        installInput(app.canvas);
    },
});
