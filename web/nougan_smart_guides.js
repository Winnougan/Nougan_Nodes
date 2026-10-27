import { app } from "/scripts/app.js";

// Nougan Smart Guides
// 1) Drag nodes and they snap to the edges and centres of nearby nodes, with Figma-style magenta
//    guide lines showing what they are aligned to. Hold Ctrl/Cmd (or Shift, ComfyUI's own grid snap)
//    to drag freely.
// 2) Tidy: arranges nodes into columns by dependency depth (right-click canvas > "Tidy by dependency",
//    the command palette, or Alt+L). With two or more nodes selected only those are arranged,
//    otherwise the whole graph. One tidy is one undo step.
//
// Classic ComfyUI canvas only. Guides are a DOM/SVG overlay, so nothing here touches the canvas draw
// loop. Snapping runs after litegraph has moved the nodes for a pointer event and applies only the
// *difference* to the snap it already applied, so it never fights litegraph's own delta-based dragging.
// Dragging groups or reroutes is left alone (snapping only runs when every selected item is a node).

const ENABLE_SETTING = "Nougan.SmartGuides.Enabled";
const SNAP_SETTING = "Nougan.SmartGuides.SnapDistance";
const COL_GAP_SETTING = "Nougan.SmartGuides.ColumnGap";
const ROW_GAP_SETTING = "Nougan.SmartGuides.RowGap";
const PULL_SETTING = "Nougan.SmartGuides.PullSources";
const TIDY_COMMAND = "Nougan.SmartGuides.Tidy";

const GUIDE_COLOR = "#ff3d71";
const TIDY_MS = 220;

const state = {
    down: null, // { pointerId, snap: Map(node -> {pos, size}) } from the last pointerdown on the canvas
    drag: null, // { nodes, applied: [x, y], cand }
    overlay: null,
    anim: null, // { finish() } while a tidy is animating
};

/* ------------------------------ helpers ----------------------------- */

function setting(id, fallback) {
    try {
        return app.extensionManager?.setting?.get?.(id) ?? app.ui?.settings?.getSettingValue?.(id) ?? fallback;
    } catch {
        return fallback;
    }
}
function num(id, fallback) {
    const v = Number(setting(id, fallback));
    return Number.isFinite(v) ? v : fallback;
}
function nodesOf(graph) {
    return graph._nodes ?? graph.nodes ?? [];
}
function isNode(item) {
    return !!item && typeof item.getBounding === "function" && Array.isArray(item.size ?? []) && item.type !== undefined && item.pos;
}
function getLink(graph, id) {
    return graph.getLink?.(id) ?? (graph.links instanceof Map ? graph.links.get(id) : graph.links?.[id]);
}
function toast(msg) {
    try {
        app.extensionManager?.toast?.add?.({ severity: "info", summary: msg, life: 2200 });
    } catch { /* toast is optional */ }
}
function commit(canvas) {
    canvas.setDirty(true, true);
    const ct = app.extensionManager?.workflow?.activeWorkflow?.changeTracker;
    const capture = ct?.captureCanvasState ?? ct?.checkState;
    if (capture) capture.call(ct);
    else window.dispatchEvent(new MouseEvent("mouseup"));
}

/** [x, y, w, h] in graph space, title bar included. */
function nodeRect(node) {
    if (node.flags?.collapsed) {
        try {
            const b = node.getBounding(new Float32Array(4));
            if (b && isFinite(b[0])) return [b[0], b[1], b[2], b[3]];
        } catch { /* fall through */ }
    }
    const title = window.LiteGraph?.NODE_TITLE_HEIGHT ?? 30;
    return [node.pos[0], node.pos[1] - title, node.size[0], node.size[1] + title];
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

function shiftNode(node, dx, dy) {
    node.pos[0] += dx;
    node.pos[1] += dy;
}

/* ------------------------------ overlay ----------------------------- */

const NS = "http://www.w3.org/2000/svg";

function overlay() {
    if (state.overlay) return state.overlay;
    const svg = document.createElementNS(NS, "svg");
    svg.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:9998";
    document.body.appendChild(svg);
    state.overlay = svg;
    return svg;
}

function clearGuides() {
    state.overlay?.replaceChildren();
}

function toClient(canvas, gx, gy) {
    const base = canvas.canvas.getBoundingClientRect();
    const p = canvas.ds.convertOffsetToCanvas([gx, gy]);
    return [base.left + p[0], base.top + p[1]];
}

function svgEl(name, attrs) {
    const el = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
}

/** guides: [{ vertical, at, from, to }] in graph space. */
function paintGuides(canvas, guides) {
    const svg = overlay();
    const els = [];
    for (const g of guides) {
        const [x1, y1] = g.vertical ? toClient(canvas, g.at, g.from) : toClient(canvas, g.from, g.at);
        const [x2, y2] = g.vertical ? toClient(canvas, g.at, g.to) : toClient(canvas, g.to, g.at);
        els.push(svgEl("line", { x1, y1, x2, y2, stroke: GUIDE_COLOR, "stroke-width": 1 }));
        for (const [cx, cy] of [[x1, y1], [x2, y2]]) {
            els.push(svgEl("path", {
                d: `M${cx - 3} ${cy - 3}L${cx + 3} ${cy + 3}M${cx + 3} ${cy - 3}L${cx - 3} ${cy + 3}`,
                stroke: GUIDE_COLOR,
                "stroke-width": 1,
                fill: "none",
            }));
        }
    }
    svg.replaceChildren(...els);
}

/* ------------------------------ snapping ---------------------------- */

const edgesX = (r) => [r[0], r[0] + r[2] / 2, r[0] + r[2]];
const edgesY = (r) => [r[1], r[1] + r[3] / 2, r[1] + r[3]];

/** Alignment targets from every node that is not being dragged and is on or near the screen. */
function candidates(canvas, graph, moving) {
    const area = canvas.visible_area;
    const mx = area ? area[2] * 0.5 : Infinity;
    const my = area ? area[3] * 0.5 : Infinity;
    const out = [];
    for (const node of nodesOf(graph)) {
        if (moving.has(node)) continue;
        const r = nodeRect(node);
        if (area && (r[0] > area[0] + area[2] + mx || r[0] + r[2] < area[0] - mx || r[1] > area[1] + area[3] + my || r[1] + r[3] < area[1] - my)) continue;
        out.push(r);
    }
    return out;
}

function bestOffset(mine, cand, edgesOf, thr) {
    let best = 0;
    let bestAbs = thr;
    for (const m of mine) {
        for (const r of cand) {
            for (const c of edgesOf(r)) {
                const d = c - m;
                const ad = Math.abs(d);
                if (ad < bestAbs) {
                    bestAbs = ad;
                    best = d;
                }
            }
        }
    }
    return best;
}

/** After snapping, every aligned pair becomes a line spanning both rectangles. */
function guidesFor(fin, cand) {
    const found = new Map();
    const add = (vertical, at, from, to) => {
        const key = `${vertical}:${Math.round(at * 10)}`;
        const g = found.get(key);
        if (g) {
            g.from = Math.min(g.from, from);
            g.to = Math.max(g.to, to);
        } else {
            found.set(key, { vertical, at, from, to });
        }
    };
    for (const r of cand) {
        for (const m of edgesX(fin)) {
            for (const c of edgesX(r)) {
                if (Math.abs(c - m) < 0.5) add(true, c, Math.min(fin[1], r[1]), Math.max(fin[1] + fin[3], r[1] + r[3]));
            }
        }
        for (const m of edgesY(fin)) {
            for (const c of edgesY(r)) {
                if (Math.abs(c - m) < 0.5) add(false, c, Math.min(fin[0], r[0]), Math.max(fin[0] + fin[2], r[0] + r[2]));
            }
        }
    }
    return [...found.values()];
}

/* ------------------------------- dragging --------------------------- */

function beginDrag(canvas, graph, down) {
    const items = [...(canvas.selectedItems ?? [])];
    if (!items.length || !items.every(isNode)) return false;
    // Only a real move counts: positions changed, sizes did not (that would be a resize).
    let moved = false;
    for (const n of items) {
        const s = down.snap.get(n);
        if (!s) return false;
        if (n.size[0] !== s.size[0] || n.size[1] !== s.size[1]) return false;
        if (n.pos[0] !== s.pos[0] || n.pos[1] !== s.pos[1]) moved = true;
    }
    if (!moved) return false;
    state.drag = { nodes: items, applied: [0, 0], cand: candidates(canvas, graph, new Set(items)) };
    return true;
}

function stepDrag(canvas, e) {
    const d = state.drag;
    // Litegraph just added this event's delta on top of the snap we applied earlier; undo that to see the raw box.
    const cur = unionRect(d.nodes);
    const raw = [cur[0] - d.applied[0], cur[1] - d.applied[1], cur[2], cur[3]];

    const suspended = e.ctrlKey || e.metaKey || e.shiftKey;
    let s = [0, 0];
    if (!suspended) {
        const thr = num(SNAP_SETTING, 6) / canvas.ds.scale;
        s = [bestOffset(edgesX(raw), d.cand, edgesX, thr), bestOffset(edgesY(raw), d.cand, edgesY, thr)];
    }

    const dx = s[0] - d.applied[0];
    const dy = s[1] - d.applied[1];
    if (dx || dy) {
        for (const n of d.nodes) shiftNode(n, dx, dy);
        canvas.setDirty(true, true);
    }
    d.applied = s;

    if (suspended) {
        clearGuides();
        return;
    }
    const fin = [raw[0] + s[0], raw[1] + s[1], raw[2], raw[3]];
    paintGuides(canvas, guidesFor(fin, d.cand));
}

function endDrag() {
    state.down = null;
    state.drag = null;
    clearGuides();
}

function installDrag(canvas) {
    const el = canvas.canvas;

    window.addEventListener("pointerdown", (e) => {
        state.drag = null;
        state.down = null;
        clearGuides();
        if (e.button !== 0 || e.target !== el || !canvas.graph) return;
        const snap = new Map();
        for (const n of nodesOf(canvas.graph)) snap.set(n, { pos: [n.pos[0], n.pos[1]], size: [n.size[0], n.size[1]] });
        state.down = { pointerId: e.pointerId, snap };
    }, true);

    // Bubble phase on purpose: litegraph has already moved the nodes for this event when we run.
    window.addEventListener("pointermove", (e) => {
        const down = state.down;
        if (!down || e.pointerId !== down.pointerId) return;
        if (!(e.buttons & 1)) {
            endDrag();
            return;
        }
        if (!setting(ENABLE_SETTING, true) || !canvas.graph) return;
        if (!state.drag && !beginDrag(canvas, canvas.graph, down)) return;
        stepDrag(canvas, e);
    });

    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);
    window.addEventListener("blur", endDrag);
}

/* -------------------------------- tidy ------------------------------ */

/** Dependency depth per node id: longest path from a node with no inputs inside the set. Cycles are cut, not looped on. */
function planLayout(graph, nodes) {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const preds = new Map(nodes.map((n) => [n.id, []]));
    const succs = new Map(nodes.map((n) => [n.id, []]));
    for (const n of nodes) {
        for (const input of n.inputs ?? []) {
            if (input.link == null) continue;
            const origin = getLink(graph, input.link)?.origin_id;
            if (origin == null || origin === n.id || !byId.has(origin) || preds.get(n.id).includes(origin)) continue;
            preds.get(n.id).push(origin);
            succs.get(origin).push(n.id);
        }
    }

    const depth = new Map();
    const visiting = new Set();
    const walk = (id) => {
        if (depth.has(id)) return depth.get(id);
        if (visiting.has(id)) return -1; // back edge of a cycle
        visiting.add(id);
        let d = 0;
        for (const p of preds.get(id)) {
            const pd = walk(p);
            if (pd >= 0) d = Math.max(d, pd + 1);
        }
        visiting.delete(id);
        depth.set(id, d);
        return d;
    };
    for (const n of nodes) walk(n.id);

    // Loaders and other pure sources sit right before the first node that uses them instead of far left.
    if (setting(PULL_SETTING, true)) {
        const pulled = new Map();
        for (const n of nodes) {
            if (preds.get(n.id).length || !succs.get(n.id).length) continue;
            const first = Math.min(...succs.get(n.id).map((s) => depth.get(s)));
            pulled.set(n.id, Math.max(0, first - 1));
        }
        for (const [id, d] of pulled) depth.set(id, d);
    }

    const columns = new Map();
    for (const n of nodes) {
        const d = depth.get(n.id);
        if (!columns.has(d)) columns.set(d, []);
        columns.get(d).push(n);
    }

    const rects = new Map(nodes.map((n) => [n.id, nodeRect(n)]));
    const left = Math.min(...[...rects.values()].map((r) => r[0]));
    const colGap = num(COL_GAP_SETTING, 80);
    const rowGap = num(ROW_GAP_SETTING, 30);
    const placed = new Map();
    const targets = [];
    let x = left;

    for (const d of [...columns.keys()].sort((a, b) => a - b)) {
        const col = columns.get(d);
        // Each node wants to sit level with the middle of what feeds it; nodes with no placed inputs keep their height.
        const want = (n) => {
            const r = rects.get(n.id);
            const ps = preds.get(n.id).map((p) => placed.get(p)).filter(Boolean);
            if (!ps.length) return r[1];
            return ps.reduce((sum, p) => sum + p.y + p.h / 2, 0) / ps.length - r[3] / 2;
        };
        const keyed = col.map((n) => ({ n, want: want(n), y: rects.get(n.id)[1] }));
        keyed.sort((a, b) => a.want - b.want || a.y - b.y);

        let cursor = -Infinity;
        let width = 0;
        for (const { n, want: wantY } of keyed) {
            const r = rects.get(n.id);
            const y = Math.max(wantY, cursor);
            cursor = y + r[3] + rowGap;
            width = Math.max(width, r[2]);
            placed.set(n.id, { y, h: r[3] });
            // pos is the body's top-left; the title bar sits above it.
            targets.push({ node: n, to: [x, y + (n.pos[1] - r[1])] });
        }
        x += width + colGap;
    }
    return { targets, columns: columns.size };
}

function tidy(canvas = app.canvas) {
    const graph = canvas?.graph;
    if (!graph) return;
    state.anim?.finish();

    const selected = [...(canvas.selectedItems ?? [])].filter(isNode);
    const nodes = selected.length >= 2 ? selected : nodesOf(graph);
    if (nodes.length < 2) {
        toast("Nothing to tidy");
        return;
    }

    const { targets, columns } = planLayout(graph, nodes);
    const moves = targets
        .map((t) => ({ node: t.node, from: [t.node.pos[0], t.node.pos[1]], to: t.to }))
        .filter((m) => Math.abs(m.to[0] - m.from[0]) > 0.5 || Math.abs(m.to[1] - m.from[1]) > 0.5);
    if (!moves.length) {
        toast("Already tidy");
        return;
    }

    const apply = (t) => {
        for (const m of moves) {
            m.node.pos[0] = m.from[0] + (m.to[0] - m.from[0]) * t;
            m.node.pos[1] = m.from[1] + (m.to[1] - m.from[1]) * t;
        }
        canvas.setDirty(true, true);
    };

    let raf = 0;
    let done = false;
    const finish = () => {
        if (done) return;
        done = true;
        cancelAnimationFrame(raf);
        state.anim = null;
        graph.beforeChange?.();
        canvas.emitBeforeChange?.();
        try {
            apply(1);
        } finally {
            graph.afterChange?.();
            canvas.emitAfterChange?.();
        }
        commit(canvas);
    };
    state.anim = { finish };

    const t0 = performance.now();
    const tick = (now) => {
        if (done) return;
        const p = Math.min(1, (now - t0) / TIDY_MS);
        if (p >= 1) {
            finish();
            return;
        }
        apply(1 - Math.pow(1 - p, 3));
        raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    toast(`Tidied ${moves.length} node${moves.length === 1 ? "" : "s"} into ${columns} column${columns === 1 ? "" : "s"}`);
}

/* ----------------------------- extension ---------------------------- */

app.registerExtension({
    name: "Nougan.SmartGuides",

    settings: [
        {
            id: ENABLE_SETTING,
            category: ["Nougan", "Smart Guides", "Enabled"],
            name: "Snap nodes to each other while dragging",
            tooltip: "Shows alignment guides and snaps to the edges and centres of nearby nodes. Hold Ctrl/Cmd or Shift while dragging to move freely.",
            type: "boolean",
            defaultValue: true,
        },
        {
            id: SNAP_SETTING,
            category: ["Nougan", "Smart Guides", "Snap distance"],
            name: "Snap distance (screen pixels)",
            type: "slider",
            attrs: { min: 1, max: 20, step: 1 },
            defaultValue: 6,
        },
        {
            id: COL_GAP_SETTING,
            category: ["Nougan", "Smart Guides", "Column gap"],
            name: "Tidy: gap between columns",
            type: "slider",
            attrs: { min: 20, max: 300, step: 10 },
            defaultValue: 80,
        },
        {
            id: ROW_GAP_SETTING,
            category: ["Nougan", "Smart Guides", "Row gap"],
            name: "Tidy: gap between nodes in a column",
            type: "slider",
            attrs: { min: 10, max: 200, step: 5 },
            defaultValue: 30,
        },
        {
            id: PULL_SETTING,
            category: ["Nougan", "Smart Guides", "Pull sources"],
            name: "Tidy: put loaders next to the node that uses them",
            tooltip: "Nodes with no inputs go in the column just before their first consumer instead of the far-left column, which keeps their wires short.",
            type: "boolean",
            defaultValue: true,
        },
    ],

    commands: [
        {
            id: TIDY_COMMAND,
            label: "Tidy nodes by dependency",
            function: () => tidy(),
        },
    ],

    keybindings: [{ combo: { key: "l", alt: true }, commandId: TIDY_COMMAND }],

    getCanvasMenuItems() {
        return [null, { content: "Tidy by dependency", callback: () => tidy() }];
    },

    getNodeMenuItems() {
        return [null, { content: "Tidy by dependency", callback: () => tidy() }];
    },

    async setup() {
        installDrag(app.canvas);
    },
});
