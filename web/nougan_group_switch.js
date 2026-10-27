import { app } from "/scripts/app.js";

// Nougan Group Switch
// Hold S, then click a group's title bar to bypass everything inside it. Click again to bring it back.
// Drag a line across several title bars to switch them all at once (same gesture as Bypass Slash).
// Bypass or mute follows the same mode as Bypass Slash (Settings > Nougan > Bypass Slash > Mode).
//
// Rule: if every group under the slash is already switched off, the slash restores them all;
// otherwise it switches all of them off. A group counts as "off" when every node in it is in the
// target mode. The label and colours preview which one you are about to get.
// One click or slash is one undo step.
//
// Restoring is exact: when a group is switched off, each node's previous mode is remembered, so a node
// you had bypassed by hand beforehand stays bypassed afterwards. That memory lasts for the session
// only and is not saved into the workflow. A group with no memory (switched off some other way) is
// restored to normal.
//
// Classic ComfyUI canvas only. Preview and flash are a DOM/SVG overlay; nothing touches the draw loop.

const KEY_SETTING = "Nougan.GroupSwitch.Key";
const HIT_SETTING = "Nougan.GroupSwitch.Hit";
const MODE_SETTING = "Nougan.BypassSlash.Mode"; // shared on purpose: one place to choose bypass vs mute
const OTHER_KEYS = [
    ["Nougan.ZipTies.Key", "Z"],
    ["Nougan.BypassSlash.Key", "B"],
    ["Nougan.SubgraphBox.Key", "V"],
    ["Nougan.GroupBox.Key", "G"],
];
const KEYS = ["S", "E", "D", "A"]; // left-hand letters ComfyUI does not bind on its own
const HITS = ["Title bar", "Anywhere on the group"];
const MODES = { Bypass: 4, Mute: 2 }; // ComfyUI: ALWAYS 0, NEVER (mute) 2, BYPASS 4
const ALWAYS = 0;

const COLORS = { bypass: "#d946ef", mute: "#94a3b8", restore: "#4ade80", idle: "rgba(255,255,255,0.55)" };
const LABELS = { bypass: "BYPASS", mute: "MUTE", restore: "RESTORE" };

const state = {
    keyHeld: false,
    armed: false, // "Slash group" from the canvas menu: the next click or drag is a switch
    stroke: null, // { start (graph), last (graph), lastClient, pointerId }
    hover: null, // client point while the key is held and no stroke is running
    frame: 0,
    overlay: null,
    hint: null,
    memory: new WeakMap(), // graph -> Map(nodeId -> previous mode)
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
    const k = setting(KEY_SETTING, "S");
    return KEYS.includes(k) ? k : "S";
}
function keyActive() {
    // every other canvas gesture keeps its key if someone picks the same letter
    const k = keyName();
    return OTHER_KEYS.every(([id, def]) => k !== setting(id, def));
}
function targetMode() {
    return MODES[setting(MODE_SETTING, "Bypass")] ?? 4;
}
function titleBarOnly() {
    return setting(HIT_SETTING, HITS[0]) !== HITS[1];
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
function graphPoint(canvas, clientX, clientY) {
    const rect = canvas.canvas.getBoundingClientRect();
    return canvas.ds.convertCanvasToOffset([clientX - rect.left, clientY - rect.top]);
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

function groupHitRect(g) {
    const r = groupRect(g);
    if (!titleBarOnly()) return r;
    const h = g.titleHeight ?? (g.font_size ?? 24) * 1.4;
    return [r[0], r[1], r[2], Math.min(h, r[3])];
}

// Liang-Barsky: does the segment p->q touch the rectangle? (A zero-length segment is a point test.)
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

/** Groups under the stroke that have something inside them, each with its nodes. */
function groupsOnStroke(canvas, graph, p, q) {
    const pad = 2 / canvas.ds.scale;
    const out = [];
    for (const g of groupsOf(graph)) {
        const [x, y, w, h] = groupHitRect(g);
        if (!segmentHitsRect(p, q, [x - pad, y - pad, w + pad * 2, h + pad * 2])) continue;
        const nodes = nodesInside(graph, g);
        if (nodes.length) out.push({ group: g, nodes });
    }
    return out;
}

function planFor(hits) {
    if (!hits.length) return { kind: "idle", next: null };
    const target = targetMode();
    if (hits.every((h) => h.nodes.every((n) => n.mode === target))) return { kind: "restore", next: ALWAYS };
    return { kind: target === 4 ? "bypass" : "mute", next: target };
}

function uniqueNodes(hits) {
    return [...new Set(hits.flatMap((h) => h.nodes))];
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
    svg.append(preview, line, label);
    document.body.appendChild(svg);
    state.overlay = { svg, preview, line, label };
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

function hideOverlay() {
    if (!state.overlay) return;
    state.overlay.line.style.display = "none";
    state.overlay.label.style.display = "none";
    state.overlay.preview.replaceChildren();
}

function paint(canvas, hits, plan, at) {
    const { preview, label } = overlay();
    const color = COLORS[plan.kind];
    const els = [];
    for (const h of hits) {
        els.push(rectEl(clientRect(canvas, groupRect(h.group)), color, 0.08));
        els.push(rectEl(clientRect(canvas, groupHitRect(h.group)), color, 0.22));
    }
    preview.replaceChildren(...els);

    if (plan.kind === "idle" || !at) {
        label.style.display = "none";
        return;
    }
    const nodes = uniqueNodes(hits).length;
    label.textContent =
        `${LABELS[plan.kind]} \u00B7 ${hits.length} group${hits.length === 1 ? "" : "s"} \u00B7 ${nodes} node${nodes === 1 ? "" : "s"}`;
    label.setAttribute("x", at[0] + 14);
    label.setAttribute("y", at[1] - 14);
    label.setAttribute("fill", color);
    label.style.display = "block";
}

function flash(canvas, hits, color) {
    const { svg } = overlay();
    const g = el("g", {});
    g.style.opacity = "0.9";
    g.style.transition = "opacity 450ms ease-out";
    g.append(...hits.map((h) => rectEl(clientRect(canvas, groupRect(h.group)), color, 0.3)));
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
        "padding:7px 14px;border-radius:999px;background:rgba(32,12,34,0.92);border:1px solid rgba(217,70,239,0.5);" +
        "color:#f3d6f7;font:600 11px ui-monospace,Consolas,monospace;letter-spacing:.02em;display:none;" +
        "box-shadow:0 4px 18px rgba(0,0,0,0.45)";
    document.body.appendChild(d);
    state.hint = d;
    return d;
}

function refreshHint(canvas) {
    const d = hint();
    const on = state.keyHeld || state.armed;
    const mode = String(setting(MODE_SETTING, "Bypass")).toLowerCase();
    const where = titleBarOnly() ? "a group's title" : "a group";
    d.textContent = `\u23FB ${keyName()}  \u00B7  click ${where} to ${mode} it  \u00B7  slash across several  \u00B7  again to restore`;
    d.style.display = on ? "block" : "none";
    const cv = canvas.canvas;
    if (cv && !state.stroke) cv.style.cursor = on ? "crosshair" : "";
    if (!on) {
        state.hover = null;
        if (!state.stroke) hideOverlay();
    }
}

/* ------------------------------ actions ----------------------------- */

function memoryFor(graph) {
    let m = state.memory.get(graph);
    if (!m) {
        m = new Map();
        state.memory.set(graph, m);
    }
    return m;
}

function applySwitch(canvas, graph, hits, plan) {
    const nodes = uniqueNodes(hits);
    const mem = memoryFor(graph);

    flash(canvas, hits, COLORS[plan.kind]);
    graph.beforeChange?.();
    canvas.emitBeforeChange?.();
    try {
        if (plan.kind === "restore") {
            const remembered = nodes.some((n) => mem.has(n.id));
            for (const n of nodes) {
                if (mem.has(n.id)) {
                    n.mode = mem.get(n.id);
                    mem.delete(n.id);
                } else if (!remembered) {
                    n.mode = plan.next; // switched off some other way: back to normal
                }
                // else: it was already off before the group was switched, so it stays off
            }
        } else {
            for (const n of nodes) {
                if (n.mode === plan.next) continue; // already off: leave it, and do not remember it
                mem.set(n.id, n.mode);
                n.mode = plan.next;
            }
        }
    } finally {
        graph.afterChange?.();
        canvas.emitAfterChange?.();
    }
    commit(canvas);
}

/* ------------------------------ strokes ----------------------------- */

function updatePreview(canvas) {
    state.frame = 0;
    if (!canvas.graph) return;
    const s = state.stroke;
    if (s?.last) {
        const hits = groupsOnStroke(canvas, canvas.graph, s.start, s.last);
        paint(canvas, hits, planFor(hits), s.lastClient);
    } else if (!s && state.hover) {
        const p = graphPoint(canvas, state.hover[0], state.hover[1]);
        const hits = groupsOnStroke(canvas, canvas.graph, p, p);
        paint(canvas, hits, planFor(hits), state.hover);
    }
}

function schedulePreview(canvas) {
    if (!state.frame) state.frame = requestAnimationFrame(() => updatePreview(canvas));
}

function endStroke(canvas) {
    if (state.frame) cancelAnimationFrame(state.frame);
    state.frame = 0;
    state.stroke = null;
    hideOverlay();
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
        if (keyActive() && e.code === `Key${keyName()}` && !hasModifier(e) && !isTyping(e)) {
            // Swallow the key (including auto-repeat) so no other ComfyUI shortcut bound to it fires.
            e.preventDefault();
            e.stopImmediatePropagation();
            if (!state.keyHeld) {
                state.keyHeld = true;
                refreshHint(canvas);
            }
        }
    }, true);

    window.addEventListener("keyup", (e) => {
        if (e.code === `Key${keyName()}` && state.keyHeld) {
            e.stopImmediatePropagation();
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
        const p = graphPoint(canvas, e.clientX, e.clientY);
        state.hover = null;
        state.stroke = { start: p, last: p, lastClient: [e.clientX, e.clientY], pointerId: e.pointerId };
        const { line } = overlay();
        for (const k of ["x1", "x2"]) line.setAttribute(k, e.clientX);
        for (const k of ["y1", "y2"]) line.setAttribute(k, e.clientY);
        line.setAttribute("stroke", COLORS.idle);
        line.setAttribute("stroke-dasharray", "6 5");
        line.style.display = "block";
        schedulePreview(canvas);
    }, true);

    window.addEventListener("pointermove", (e) => {
        const s = state.stroke;
        if (s && e.pointerId === s.pointerId) {
            e.stopImmediatePropagation();
            s.lastClient = [e.clientX, e.clientY];
            s.last = graphPoint(canvas, e.clientX, e.clientY);
            const { line } = overlay();
            line.setAttribute("x2", e.clientX);
            line.setAttribute("y2", e.clientY);
            schedulePreview(canvas);
            return;
        }
        if ((state.keyHeld || state.armed) && e.target === cv) {
            state.hover = [e.clientX, e.clientY]; // preview the group under the cursor before you click
            schedulePreview(canvas);
            // litegraph resets the cursor while handling the move; set ours afterwards
            requestAnimationFrame(() => (cv.style.cursor = "crosshair"));
        }
    }, true);

    const end = (e) => {
        const s = state.stroke;
        if (!s || e.pointerId !== s.pointerId) return;
        e.stopImmediatePropagation();
        const start = s.start;
        endStroke(canvas);
        if (e.type !== "pointerup" || !canvas.graph) return;
        const graph = canvas.graph;
        const hits = groupsOnStroke(canvas, graph, start, graphPoint(canvas, e.clientX, e.clientY));
        const plan = planFor(hits);
        if (plan.kind !== "idle") applySwitch(canvas, graph, hits, plan);
    };
    window.addEventListener("pointerup", end, true);
    window.addEventListener("pointercancel", end, true);
}

/* ----------------------------- extension ---------------------------- */

app.registerExtension({
    name: "Nougan.GroupSwitch",

    settings: [
        {
            id: KEY_SETTING,
            category: ["Nougan", "Group Switch", "Key"],
            name: "Key to hold while clicking or slashing groups",
            tooltip: "Hold this key and click a group's title (or drag across several) to bypass everything inside; do it again to restore. Bypass or mute follows Bypass Slash's mode setting.",
            type: "combo",
            options: KEYS,
            defaultValue: "S",
        },
        {
            id: HIT_SETTING,
            category: ["Nougan", "Group Switch", "Hit area"],
            name: "Where a click or slash counts",
            tooltip: "Title bar: only the title strip of a group, so a slash across a big group does not catch it by accident. Anywhere on the group: the whole frame counts.",
            type: "combo",
            options: HITS,
            defaultValue: HITS[0],
        },
    ],

    getCanvasMenuItems() {
        const canvas = app.canvas;
        if (!canvas) return [];
        return [null, { content: "Slash group", callback: () => setArmed(canvas, true) }];
    },

    async setup() {
        installInput(app.canvas);
    },
});
