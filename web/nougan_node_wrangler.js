// Nougan Node Wrangler  —  web/nougan_node_wrangler.js
// Based on CRZ Node Wrangler (Blender-style node connection shortcuts), reworked for the Nougan suite.
//
// HOLD  C  (rebindable in Settings) and LEFT-drag:
//   node  → node ................ connect the best matching socket pair
//     + Shift ................... connect ALL matching pairs
//     + Alt ..................... hide the new links as they're made
//   empty → across wires ........ cut them   (+ Alt = hide them instead)
//   Drop the cursor ON a socket (or start the drag on one) to force that exact socket.
//   If nothing matches A → B, it automatically tries B → A (HUD shows "reversed").
//   Esc cancels a drag.
//
// Legacy right-button gestures (can be switched off in Settings):
//   Alt + RMB drag ................ connect (one pair)
//   Ctrl + Alt + RMB drag ......... connect all matching sockets
//   Ctrl + Alt + Shift + RMB drag . connect all and hide the links
//   Ctrl + RMB drag ............... cut wires
//   Shift + RMB drag .............. hide wires

const NW_COLOR = "#5B9DF0";
const NW_REVERSE_COLOR = "#B58CFF";
const NW_NO_MATCH_COLOR = "#E85050";
const NW_CUT_COLOR = "#E85050";
const NW_HIDE_COLOR = "#D6AA50";
const NW_GLOW = 12;
const NW_RADIUS = 12;
const NW_DOT = 6;
const NW_SLOT_SNAP_PX = 16; // cursor distance (screen px) that counts as "on a socket"
// Nodes 2.0 socket position corrections
const NW_V2_OFFSET_Y = 9;
const NW_V2_OFFSET_X = -10;
const NW_V2_SLOT_SPACING = 4;

const TYPE_PRIORITY = [
    "MODEL", "CLIP", "VAE", "CONDITIONING", "LATENT",
    "IMAGE", "MASK", "CONTROL_NET", "UPSCALE_MODEL",
    "CLIP_VISION", "CLIP_VISION_OUTPUT", "STYLE_MODEL",
    "GLIGEN", "SAMPLER", "SIGMAS", "NOISE", "GUIDER",
    "INT", "FLOAT", "STRING", "BOOLEAN",
];

let app;
try {
    app = (await import("../../scripts/app.js")).app;
} catch (_) {
    try {
        app = (await import("/extensions/core/scripts/app.js")).app;
    } catch (_) {}
}
app = app || (typeof window !== "undefined" && window.comfyAPI?.app?.app);

// Settings live at module scope so onChange can fire before setup() runs.
const S = { enabled: true, key: "c", legacy: true, autoReverse: true };
let legacyLocked = false;   // true when the original CRZ.NodeWrangler is installed too
let resetFn = () => {};     // assigned in setup()

if (app) {
    app.registerExtension({
        name: "Nougan.NodeWrangler",

        settings: [
            {
                id: "Nougan.Wrangler.Enabled",
                name: "Nougan Node Wrangler: enabled",
                type: "boolean",
                defaultValue: true,
                onChange: (v) => { S.enabled = !!v; if (!S.enabled) resetFn(); },
            },
            {
                id: "Nougan.Wrangler.Key",
                name: "Nougan Node Wrangler: hold-key (hold it, then left-drag)",
                type: "combo",
                options: ["C", "X", "E", "D", "A", "Off"],
                defaultValue: "C",
                onChange: (v) => { S.key = (!v || v === "Off") ? "" : String(v).toLowerCase(); resetFn(); },
            },
            {
                id: "Nougan.Wrangler.AutoReverse",
                name: "Nougan Node Wrangler: auto-reverse when A → B has no match (tries B → A)",
                type: "boolean",
                defaultValue: true,
                onChange: (v) => { S.autoReverse = !!v; },
            },
            {
                id: "Nougan.Wrangler.Legacy",
                name: "Nougan Node Wrangler: right-button gestures (Alt / Ctrl / Shift + RMB)",
                type: "boolean",
                defaultValue: true,
                onChange: (v) => { S.legacy = !!v && !legacyLocked; },
            },
        ],

        async setup() {
            const canvas = app.canvas;
            if (!canvas) return;
            if (window.__nougan_node_wrangler) return;
            window.__nougan_node_wrangler = true;

            // Stand down on the RMB gestures if the original CRZ extension is also installed.
            if (Array.isArray(app.extensions) && app.extensions.some((x) => x?.name === "CRZ.NodeWrangler")) {
                legacyLocked = true;
                S.legacy = false;
                console.info("[Nougan] Node Wrangler: CRZ.NodeWrangler detected, right-button gestures left to it.");
            }

            const canvasEl = canvas.canvas;
            const canvasParent = canvasEl.parentElement;

            // ── runtime state ────────────────────────────────────────────────
            let g = null;            // active gesture
            let armed = false;       // hold-key is down
            let lastX = 0, lastY = 0;
            let suppressCtx = false;
            let swallowUp = null;    // button whose next pointerup we eat (after Esc-cancel)

            // ── small helpers ────────────────────────────────────────────────
            function killEvent(e) {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
            }

            function getActiveGraph() { return canvas.graph || app.graph; }

            function allLinks(graph) {
                const l = graph?.links;
                if (!l) return [];
                return l instanceof Map ? [...l.values()] : Object.values(l);
            }

            function getLink(graph, id) {
                const l = graph?.links;
                if (!l) return null;
                return l instanceof Map ? l.get(id) : l[id];
            }

            function isNodesV2() {
                try { return !!app.ui.settings.getSettingValue("Comfy.VueNodes.Enabled"); } catch (_) {}
                return false;
            }

            // NOTE: litegraph's getConnectionPos takes is_input (true = input slot).
            function getSlotPos(node, isInput, slotIdx) {
                const pos = node.getConnectionPos(isInput, slotIdx);
                if (pos && isNodesV2()) {
                    pos[1] += NW_V2_OFFSET_Y + (slotIdx * NW_V2_SLOT_SPACING);
                    pos[0] += isInput ? NW_V2_OFFSET_X : -NW_V2_OFFSET_X;
                }
                return pos;
            }

            function getNodeAt(gx, gy) {
                const graph = getActiveGraph();
                if (!graph) return null;
                return graph.getNodeOnPos(gx, gy, graph._nodes_in_order) || null;
            }

            function eventToGraph(e, forHitTest) {
                if (canvas.convertEventToCanvasOffset) {
                    const pos = canvas.convertEventToCanvasOffset(e);
                    return [pos[0], pos[1]];
                }
                const rect = canvasEl.getBoundingClientRect();
                const scaleX = canvasEl.width / rect.width;
                const scaleY = canvasEl.height / rect.height;
                const needsDpiFix = (Math.abs(scaleX - 1) > 0.01 || Math.abs(scaleY - 1) > 0.01) && forHitTest;
                const x = (e.clientX - rect.left) * (needsDpiFix ? scaleX : 1);
                const y = (e.clientY - rect.top) * (needsDpiFix ? scaleY : 1);
                const ds = canvas.ds;
                return [x / ds.scale - ds.offset[0], y / ds.scale - ds.offset[1]];
            }

            function slotLabel(slot) {
                return slot?.label || slot?.localized_name || slot?.name || String(slot?.type ?? "?");
            }

            function isTyping(t) {
                return t instanceof Element && !!t.closest("input,textarea,select,[contenteditable='true']");
            }

            function isMaskEditorOpen() {
                return !!document.querySelector(".maskEditor_toolPanelContainer") ||
                       !!document.querySelector("#maskEditor_brush");
            }

            function onCanvas(e) {
                const rect = canvasEl.getBoundingClientRect();
                if (e.clientX < rect.left || e.clientX > rect.right ||
                    e.clientY < rect.top || e.clientY > rect.bottom) return false;
                const t = e.target;
                if (!(t instanceof Element)) return false;
                if (t.closest("input,textarea,select,button,[contenteditable='true'],.nw-hud")) return false;
                return t === canvasEl || !canvasParent || canvasParent.contains(t);
            }

            function pointerOverCanvas() {
                const rect = canvasEl.getBoundingClientRect();
                return lastX >= rect.left && lastX <= rect.right && lastY >= rect.top && lastY <= rect.bottom;
            }

            // ── type matching ────────────────────────────────────────────────
            function normalizeType(t) {
                if (t == null) return "*";
                if (typeof t === "number") return "*";
                if (typeof t === "object" && Array.isArray(t)) return "COMBO";
                return String(t).toUpperCase();
            }

            // Handles comma-separated multi-types (e.g. "IMAGE,MASK")
            function typesMatch(outType, inType) {
                const a = normalizeType(outType);
                const b = normalizeType(inType);
                if (a === "*" || b === "*" || a === b) return true;
                const bTypes = b.split(",");
                for (const at of a.split(",")) if (bTypes.includes(at)) return true;
                return false;
            }

            function outputLinkedTo(node, oi, targetId) {
                const links = node.outputs?.[oi]?.links;
                const graph = getActiveGraph();
                if (!links || !graph) return false;
                for (const id of links) {
                    const l = getLink(graph, id);
                    if (l && l.target_id === targetId) return true;
                }
                return false;
            }

            // ── the matching engine (one scorer for single AND connect-all) ──
            // Connections go a.outputs[o] → b.inputs[i]. Lowest cost wins:
            //   occupied input +1000 · name mismatch +100 · wildcard +50 · widget input +20
            //   type priority 0..30 · output already fanned out +5 · slot order as tie-break
            // Connect-all only overwrites an occupied input when the names match exactly.
            function rank(a, b, o) {
                const outs = a.outputs, ins = b.inputs;
                if (!outs?.length || !ins?.length) return [];
                const cands = [];
                for (let oi = 0; oi < outs.length; oi++) {
                    if (o.outHint != null && oi !== o.outHint) continue;
                    if (o.outHint == null && outputLinkedTo(a, oi, b.id)) continue;
                    const out = outs[oi];
                    const oT = normalizeType(out.type);
                    const oName = (out.name || "").toLowerCase();
                    const outBusy = !!(out.links && out.links.length);
                    let prio = 30;
                    for (const t of oT.split(",")) {
                        const idx = TYPE_PRIORITY.indexOf(t);
                        if (idx >= 0 && idx < prio) prio = idx;
                    }
                    for (let ii = 0; ii < ins.length; ii++) {
                        if (o.inHint != null && ii !== o.inHint) continue;
                        const inp = ins[ii];
                        if (!typesMatch(out.type, inp.type)) continue;
                        const nameEq = !!oName && oName === (inp.name || "").toLowerCase();
                        const occupied = inp.link != null;
                        if (o.all && occupied && !nameEq && o.inHint == null) continue;
                        const wild = oT === "*" || normalizeType(inp.type) === "*";
                        let cost = prio + oi * 0.01 + ii * 0.001;
                        if (occupied) cost += 1000;
                        if (!nameEq) cost += 100;
                        if (wild) cost += 50;
                        if (inp.widget) cost += 20;
                        if (outBusy) cost += 5;
                        cands.push({ o: oi, i: ii, cost });
                    }
                }
                cands.sort((x, y) => x.cost - y.cost);
                if (!o.all) return cands.slice(0, 1);
                const usedO = new Set(), usedI = new Set(), res = [];
                for (const c of cands) {
                    if (usedO.has(c.o) || usedI.has(c.i)) continue;
                    usedO.add(c.o);
                    usedI.add(c.i);
                    res.push(c);
                }
                return res;
            }

            // Is the cursor sitting on one of this node's sockets?
            function slotNear(node, gx, gy) {
                const maxD = NW_SLOT_SNAP_PX / (canvas.ds?.scale || 1);
                let best = null, bd = maxD;
                try {
                    (node.outputs || []).forEach((_, i) => {
                        const p = getSlotPos(node, false, i);
                        if (!p) return;
                        const d = Math.hypot(p[0] - gx, p[1] - gy);
                        if (d < bd) { bd = d; best = { isOutput: true, idx: i }; }
                    });
                    (node.inputs || []).forEach((_, i) => {
                        const p = getSlotPos(node, true, i);
                        if (!p) return;
                        const d = Math.hypot(p[0] - gx, p[1] - gy);
                        if (d < bd) { bd = d; best = { isOutput: false, idx: i }; }
                    });
                } catch (_) {}
                return best;
            }

            function computePlan(gs) {
                if (!gs.dst) return { pairs: [], reversed: false };
                const end = slotNear(gs.dst, gs.hx, gs.hy);
                const sh = gs.startHint;
                const fwd = rank(gs.src, gs.dst, {
                    all: gs.all,
                    outHint: sh?.isOutput ? sh.idx : null,
                    inHint: end && !end.isOutput ? end.idx : null,
                });
                if (fwd.length) return { pairs: fwd, reversed: false };
                if (S.autoReverse) {
                    const rev = rank(gs.dst, gs.src, {
                        all: gs.all,
                        outHint: end?.isOutput ? end.idx : null,
                        inHint: sh && !sh.isOutput ? sh.idx : null,
                    });
                    if (rev.length) return { pairs: rev, reversed: true };
                }
                return { pairs: [], reversed: false };
            }

            function commit() {
                const gr = getActiveGraph();
                try { gr?.change?.(); } catch (_) {}
                try { app.extensionManager?.workflow?.activeWorkflow?.changeTracker?.checkState?.(); } catch (_) {}
                canvas.setDirty(true, true);
            }

            // ── native "Hide Link" (kept from the original) ──────────────────
            function hideNativeLink(link, event) {
                const lg = typeof LiteGraph !== "undefined" ? LiteGraph : window.LiteGraph;
                if (!lg?.ContextMenu || !canvas.showLinkMenu) return false;
                // Easy Use converts links to Set/Get when showLinkMenu receives Shift.
                // The modifier selects our gesture, not an extension's menu shortcut.
                const menuEvent = new MouseEvent("contextmenu", {
                    clientX: event.clientX,
                    clientY: event.clientY,
                    button: 2,
                    view: window,
                });
                const OriginalMenu = lg.ContextMenu;
                const menus = [];
                // The native hide helper is private. Capture its menu callback synchronously;
                // close the menus before the browser paints and restore the constructor.
                lg.ContextMenu = new Proxy(OriginalMenu, {
                    construct(target, args) {
                        const menu = Reflect.construct(target, args);
                        menus.push({ menu, items: args[0], options: args[1] });
                        return menu;
                    },
                });
                try {
                    canvas.showLinkMenu(link, menuEvent);
                } finally {
                    lg.ContextMenu = OriginalMenu;
                    for (const { menu } of menus) menu.close();
                }
                for (const { items, options } of menus) {
                    const item = items.find((it) => (it?.value ?? it) === "Hide Link");
                    if (item && options?.callback) {
                        options.callback(item, options, menuEvent);
                        return true;
                    }
                }
                return false;
            }

            // ── slash hit-testing (cut / hide) ───────────────────────────────
            const hitCtx = document.createElement("canvas").getContext("2d");

            function segmentsIntersect(p1x, p1y, p2x, p2y, p3x, p3y, p4x, p4y) {
                const d1x = p2x - p1x, d1y = p2y - p1y;
                const d2x = p4x - p3x, d2y = p4y - p3y;
                const cross = d1x * d2y - d1y * d2x;
                if (Math.abs(cross) < 1e-10) return false;
                const t = ((p3x - p1x) * d2y - (p3y - p1y) * d2x) / cross;
                const u = ((p3x - p1x) * d1y - (p3y - p1y) * d1x) / cross;
                return t >= 0 && t <= 1 && u >= 0 && u <= 1;
            }

            function sampleBezier(x1, y1, x2, y2, n) {
                const dx = Math.abs(x2 - x1) * 0.5;
                const c1x = x1 + dx, c2x = x2 - dx;
                const pts = [];
                for (let i = 0; i <= n; i++) {
                    const t = i / n, it = 1 - t;
                    pts.push([
                        it * it * it * x1 + 3 * it * it * t * c1x + 3 * it * t * t * c2x + t * t * t * x2,
                        it * it * it * y1 + 3 * it * it * t * y1 + 3 * it * t * t * y2 + t * t * t * y2,
                    ]);
                }
                return pts;
            }

            // Preferred: the frontend's own rendered link paths (respects link render mode + reroutes).
            // Fallback for older frontends: sample our own bezier per link.
            function findHitLinks(points, graph) {
                const scale = canvas.ds?.scale || 1;
                const links = new Set();
                const rendered = canvas.renderedPaths;
                if (rendered !== undefined) {
                    const step = 3 / scale;
                    hitCtx.lineWidth = step * 2;
                    for (const segment of rendered) {
                        if (!segment.path) continue;
                        let hit = false;
                        for (let i = 1; i < points.length && !hit; i++) {
                            const [x, y] = points[i - 1];
                            const dx = points[i][0] - x, dy = points[i][1] - y;
                            const samples = Math.max(1, Math.ceil(Math.hypot(dx, dy) / step));
                            for (let j = 0; j <= samples; j++) {
                                if (hitCtx.isPointInStroke(segment.path, x + dx * j / samples, y + dy * j / samples)) {
                                    hit = true;
                                    break;
                                }
                            }
                        }
                        if (!hit) continue;
                        // A reroute segment can carry several links.
                        for (const id of segment.linkIds || [segment.id]) {
                            const l = getLink(graph, id);
                            if (l) links.add(l);
                        }
                    }
                    return links;
                }
                for (const link of allLinks(graph)) {
                    if (!link) continue;
                    const from = graph.getNodeById(link.origin_id);
                    const to = graph.getNodeById(link.target_id);
                    if (!from || !to) continue;
                    const a = getSlotPos(from, false, link.origin_slot);
                    const b = getSlotPos(to, true, link.target_slot);
                    if (!a || !b) continue;
                    const bez = sampleBezier(a[0], a[1], b[0], b[1], 24);
                    outer:
                    for (let ci = 0; ci < points.length - 1; ci++) {
                        for (let bi = 0; bi < bez.length - 1; bi++) {
                            if (segmentsIntersect(points[ci][0], points[ci][1], points[ci + 1][0], points[ci + 1][1],
                                bez[bi][0], bez[bi][1], bez[bi + 1][0], bez[bi + 1][1])) {
                                links.add(link);
                                break outer;
                            }
                        }
                    }
                }
                return links;
            }

            function finishSlash(gs, e) {
                const graph = getActiveGraph();
                if (!graph || graph !== gs.graph || gs.points.length < 2) return;
                const scale = canvas.ds?.scale || 1;
                const [x0, y0] = gs.points[0];
                if (!gs.points.some(([x, y]) => Math.hypot(x - x0, y - y0) * scale >= 4)) return; // a click, not a slash
                const links = findHitLinks(gs.points, graph);
                if (!links.size) return;
                if (gs.hide) {
                    for (const l of links) hideNativeLink(l, e);
                } else {
                    for (const l of links) graph.getNodeById(l.target_id)?.disconnectInput(l.target_slot);
                    commit();
                }
            }

            function finishConnect(gs, e) {
                if (!gs.dst || !gs.plan.pairs.length) return;
                const [from, to] = gs.plan.reversed ? [gs.dst, gs.src] : [gs.src, gs.dst];
                for (const p of gs.plan.pairs) {
                    if (to.inputs[p.i].link != null) to.disconnectInput(p.i);
                    const link = from.connect(p.o, to, p.i);
                    if (gs.hide && link) hideNativeLink(link, e);
                }
                commit();
            }

            // ── overlay canvas (works in classic + Nodes 2.0) ────────────────
            const overlayCanvas = document.createElement("canvas");
            overlayCanvas.dataset.nwOverlay = "1";
            overlayCanvas.style.cssText = "position:absolute;top:0;left:0;pointer-events:none;z-index:9998;";
            if (canvasParent) {
                if (getComputedStyle(canvasParent).position === "static") canvasParent.style.position = "relative";
                canvasParent.appendChild(overlayCanvas);
            }
            function syncOverlaySize() {
                overlayCanvas.width = canvasEl.width;
                overlayCanvas.height = canvasEl.height;
                overlayCanvas.style.width = canvasEl.offsetWidth + "px";
                overlayCanvas.style.height = canvasEl.offsetHeight + "px";
            }
            syncOverlaySize();
            new ResizeObserver(syncOverlaySize).observe(canvasEl);
            const overlayCtx = overlayCanvas.getContext("2d");

            function drawNoodle(ctx, x1, y1, x2, y2, color, alpha) {
                ctx.save();
                ctx.globalAlpha = alpha;
                ctx.strokeStyle = color;
                ctx.lineWidth = 2.5;
                ctx.shadowColor = color;
                ctx.shadowBlur = 8;
                const dx = Math.abs(x2 - x1) * 0.5;
                ctx.beginPath();
                ctx.moveTo(x1, y1);
                ctx.bezierCurveTo(x1 + dx, y1, x2 - dx, y2, x2, y2);
                ctx.stroke();
                ctx.shadowBlur = 0;
                ctx.fillStyle = color;
                ctx.beginPath(); ctx.arc(x1, y1, NW_DOT, 0, Math.PI * 2); ctx.fill();
                ctx.beginPath(); ctx.arc(x2, y2, NW_DOT, 0, Math.PI * 2); ctx.fill();
                ctx.restore();
            }

            function drawNodeHighlight(ctx, node, color) {
                const titleH = (typeof LiteGraph !== "undefined" && LiteGraph.NODE_TITLE_HEIGHT) || 20;
                const collapsed = node.flags?.collapsed;
                const w = collapsed ? (node._collapsed_width || node.size[0]) : node.size[0];
                const h = collapsed ? titleH : node.size[1] + titleH;
                ctx.save();
                ctx.strokeStyle = color;
                ctx.lineWidth = 2;
                ctx.globalAlpha = 0.7;
                ctx.shadowColor = color;
                ctx.shadowBlur = NW_GLOW;
                ctx.beginPath();
                if (ctx.roundRect) ctx.roundRect(node.pos[0], node.pos[1] - titleH, w, h, NW_RADIUS);
                else ctx.rect(node.pos[0], node.pos[1] - titleH, w, h);
                ctx.stroke();
                ctx.restore();
            }

            function toneOf(gs) {
                if (gs.kind === "slash") return gs.hide ? NW_HIDE_COLOR : NW_CUT_COLOR;
                if (gs.dst && !gs.plan.pairs.length) return NW_NO_MATCH_COLOR;
                if (gs.hide) return NW_HIDE_COLOR;
                return gs.plan.reversed ? NW_REVERSE_COLOR : NW_COLOR;
            }

            function drawConnectOverlay(ctx, gs) {
                const color = toneOf(gs);
                drawNodeHighlight(ctx, gs.src, color);
                if (gs.dst) drawNodeHighlight(ctx, gs.dst, color);
                if (!gs.dst) {
                    drawNoodle(ctx, gs.sx, gs.sy, gs.mx, gs.my, color, 0.8);
                    return;
                }
                if (!gs.plan.pairs.length) return;
                const [from, to] = gs.plan.reversed ? [gs.dst, gs.src] : [gs.src, gs.dst];
                for (const p of gs.plan.pairs) {
                    const a = getSlotPos(from, false, p.o);
                    const b = getSlotPos(to, true, p.i);
                    if (a && b) drawNoodle(ctx, a[0], a[1], b[0], b[1], color, 0.8);
                }
            }

            function drawSlashOverlay(ctx, gs) {
                if (gs.points.length < 2) return;
                const color = toneOf(gs);
                ctx.save();
                ctx.strokeStyle = color;
                ctx.lineWidth = 2;
                ctx.globalAlpha = 0.9;
                ctx.shadowColor = color;
                ctx.shadowBlur = NW_GLOW;
                ctx.setLineDash([6, 4]);
                ctx.beginPath();
                ctx.moveTo(gs.points[0][0], gs.points[0][1]);
                for (let i = 1; i < gs.points.length; i++) ctx.lineTo(gs.points[i][0], gs.points[i][1]);
                ctx.stroke();
                ctx.restore();
            }

            if (typeof canvas.drawFrontCanvas === "function") {
                const origDrawFrontCanvas = canvas.drawFrontCanvas.bind(canvas);
                canvas.drawFrontCanvas = function () {
                    origDrawFrontCanvas.apply(this, arguments);
                    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
                    if (S.enabled && g) {
                        overlayCtx.save();
                        const ds = this.ds;
                        if (ds) {
                            const dpr = Math.max(canvasEl.width / canvasEl.offsetWidth || 1, canvasEl.height / canvasEl.offsetHeight || 1, 1);
                            overlayCtx.setTransform(
                                ds.scale * dpr, 0, 0, ds.scale * dpr,
                                ds.offset[0] * ds.scale * dpr, ds.offset[1] * ds.scale * dpr
                            );
                        }
                        if (g.kind === "connect") drawConnectOverlay(overlayCtx, g);
                        else drawSlashOverlay(overlayCtx, g);
                        overlayCtx.restore();
                    }
                };
            }

            // ── HUD: tells you what the drop WILL do before you let go ───────
            const style = document.createElement("style");
            style.textContent = `
.nw-hud{position:fixed;left:0;top:0;z-index:10000;pointer-events:none;display:none;padding:6px 10px;border-radius:8px;
  background:rgba(22,22,26,.93);border:1px solid var(--nw-tone,#5B9DF0);box-shadow:0 0 12px var(--nw-tone,#5B9DF0);
  color:#e8e8ea;font:11px/1.5 monospace;white-space:nowrap;max-width:380px;overflow:hidden;text-overflow:ellipsis}
.nw-hud .nw-h{font-weight:700;color:var(--nw-tone,#5B9DF0)}
.nw-hud .nw-d{opacity:.6}
.nw-armed-zone,.nw-armed-zone *{cursor:crosshair!important}`;
            document.head.appendChild(style);
            const hud = document.createElement("div");
            hud.className = "nw-hud";
            document.body.appendChild(hud);

            function hudLine(cls, text) {
                const d = document.createElement("div");
                if (cls) d.className = cls;
                d.textContent = text;
                hud.appendChild(d);
            }

            function updateHud() {
                if (!S.enabled || (!g && !armed) || (!g && !pointerOverCanvas())) {
                    hud.style.display = "none";
                    return;
                }
                let head = "", rows = [], hint = "", tone = NW_COLOR;
                if (!g) {
                    head = "⚡ Wrangler";
                    rows = ["drag node → node: connect", "drag across wires: cut"];
                    hint = "Shift: all · Alt: hide links";
                } else if (g.kind === "connect") {
                    tone = toneOf(g);
                    const n = g.plan.pairs.length;
                    if (!g.dst) {
                        head = g.all ? "Connect all" : "Connect";
                        rows = ["drop on a node"];
                        if (g.live) hint = "Shift: all · Alt: hide links · Esc: cancel";
                    } else if (!n) {
                        head = "No matching sockets";
                    } else {
                        head = (g.all ? `Connect all (${n})` : "Connect") +
                               (g.plan.reversed ? " ↩ reversed" : "") + (g.hide ? " · hide links" : "");
                        const [from, to] = g.plan.reversed ? [g.dst, g.src] : [g.src, g.dst];
                        rows = g.plan.pairs.slice(0, 5).map((p) => {
                            const inp = to.inputs[p.i];
                            return `${slotLabel(from.outputs[p.o])} → ${slotLabel(inp)}${inp.link != null ? "  (replaces)" : ""}`;
                        });
                        if (n > 5) rows.push(`+${n - 5} more`);
                    }
                } else {
                    tone = toneOf(g);
                    head = g.hide ? "Hide wires" : "Cut wires";
                    if (g.live) hint = g.hide ? "release Alt to cut instead" : "Alt: hide instead";
                }
                hud.replaceChildren();
                hud.style.setProperty("--nw-tone", tone);
                hudLine("nw-h", head);
                for (const r of rows) hudLine("", r);
                if (hint) hudLine("nw-d", hint);
                hud.style.display = "block";
                let x = lastX + 18, y = lastY + 20;
                const w = hud.offsetWidth, h = hud.offsetHeight;
                if (x + w > window.innerWidth - 8) x = lastX - w - 14;
                if (y + h > window.innerHeight - 8) y = lastY - h - 14;
                hud.style.transform = `translate(${Math.max(4, x)}px,${Math.max(4, y)}px)`;
            }

            // ── arming + gesture lifecycle ───────────────────────────────────
            function setArmed(v) {
                armed = v;
                document.body.classList.toggle("nw-armed", v);
                (canvasParent || canvasEl).classList.toggle("nw-armed-zone", v);
                updateHud();
            }

            function cancelGesture(eatPointerUp) {
                if (g && eatPointerUp) swallowUp = g.button;
                g = null;
                canvas.setDirty(true, true);
                updateHud();
            }

            resetFn = () => { cancelGesture(false); setArmed(false); };

            function suppressContextMenu() {
                suppressCtx = true;
                setTimeout(() => { suppressCtx = false; }, 80);
            }

            window.addEventListener("keydown", (e) => {
                if (e.key === "Escape" && g) { cancelGesture(true); killEvent(e); return; }
                if (!S.enabled || !S.key || armed) return;
                if (String(e.key).toLowerCase() !== S.key) return;
                if (e.ctrlKey || e.metaKey || e.altKey) return; // leave Ctrl+C / Alt+C etc. alone
                if (isTyping(e.target)) return;
                setArmed(true);
            }, true);

            window.addEventListener("keyup", (e) => {
                if (armed && String(e.key).toLowerCase() === S.key) setArmed(false);
            }, true);

            window.addEventListener("blur", () => { cancelGesture(false); setArmed(false); });
            window.addEventListener("pointercancel", () => cancelGesture(false), true);

            window.addEventListener("pointerdown", (e) => {
                if (!S.enabled || g || isMaskEditorOpen() || !onCanvas(e)) return;
                let kind = null, all = false, hide = false, live = false;
                const [hx, hy] = eventToGraph(e, true);
                const node = getNodeAt(hx, hy);

                if (armed && e.button === 0 && !e.ctrlKey && !e.metaKey) {
                    live = true;
                    kind = node ? "connect" : "slash";
                    all = e.shiftKey;
                    hide = e.altKey;
                } else if (S.legacy && e.button === 2) {
                    const { ctrlKey: c, altKey: a, shiftKey: s } = e;
                    if (c && a) { kind = "connect"; all = true; hide = s; }
                    else if (a && !c && !s) { kind = "connect"; }
                    else if (!a && c !== s) { kind = "slash"; hide = s; }
                    else return;
                    if (kind === "connect" && !node) return;
                } else {
                    return;
                }

                const [gx, gy] = eventToGraph(e, false);
                g = {
                    kind, live, all, hide, button: e.button,
                    src: kind === "connect" ? node : null,
                    startHint: kind === "connect" ? slotNear(node, hx, hy) : null,
                    sx: gx, sy: gy, mx: gx, my: gy, hx, hy,
                    dst: null, plan: { pairs: [], reversed: false },
                    points: [[gx, gy]],
                    graph: getActiveGraph(),
                };
                lastX = e.clientX; lastY = e.clientY;
                canvas.setDirty(true, true);
                updateHud();
                killEvent(e);
            }, true);

            window.addEventListener("pointermove", (e) => {
                lastX = e.clientX;
                lastY = e.clientY;
                if (!g) { if (armed) updateHud(); return; }

                const [gx, gy] = eventToGraph(e, false);
                const [hx, hy] = eventToGraph(e, true);
                g.mx = gx; g.my = gy; g.hx = hx; g.hy = hy;
                if (g.live) {
                    g.hide = e.altKey;
                    if (g.kind === "connect") g.all = e.shiftKey;
                }
                if (g.kind === "connect") {
                    const n = getNodeAt(hx, hy);
                    g.dst = (n && n !== g.src) ? n : null;
                    g.plan = computePlan(g);
                } else {
                    g.points.push([gx, gy]);
                }
                canvas.setDirty(true, true);
                updateHud();
                killEvent(e);
            }, true);

            window.addEventListener("pointerup", (e) => {
                if (!g) {
                    if (swallowUp !== null && e.button === swallowUp) { swallowUp = null; killEvent(e); }
                    return;
                }
                if (e.button !== g.button) return;

                const gs = g;
                g = null;
                const [gx, gy] = eventToGraph(e, false);
                const [hx, hy] = eventToGraph(e, true);
                gs.mx = gx; gs.my = gy; gs.hx = hx; gs.hy = hy;
                if (gs.live) {
                    gs.hide = e.altKey;
                    if (gs.kind === "connect") gs.all = e.shiftKey;
                }
                killEvent(e);
                try {
                    if (gs.kind === "connect") {
                        const n = getNodeAt(hx, hy);
                        gs.dst = (n && n !== gs.src) ? n : null;
                        gs.plan = computePlan(gs);
                        finishConnect(gs, e);
                        if (gs.button === 2 && canvas.deselectAllNodes) canvas.deselectAllNodes();
                    } else {
                        gs.points.push([gx, gy]);
                        finishSlash(gs, e);
                    }
                } finally {
                    if (gs.button === 2) suppressContextMenu();
                    else {
                        // eat the click that follows a left-button gesture so nodes don't get selected
                        const swallow = (ev) => killEvent(ev);
                        window.addEventListener("click", swallow, true);
                        setTimeout(() => window.removeEventListener("click", swallow, true), 100);
                    }
                    canvas.setDirty(true, true);
                    updateHud();
                }
            }, true);

            window.addEventListener("contextmenu", (e) => {
                if (g || suppressCtx) {
                    suppressCtx = false;
                    killEvent(e);
                }
            }, true);
        },
    });
}
