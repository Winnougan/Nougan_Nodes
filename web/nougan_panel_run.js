// Automagic 2222: Live Panel, run selected output node.
//
// "Queue" runs every output node in the graph. This adds a button that runs only the output node(s)
// you choose (plus whatever they depend on), and a small target picker:
//
//   * "Selected on canvas" (default): runs whichever output nodes are selected right now.
//   * Any output node in the graph, picked from the list: that node is pinned as the target and the
//     button always runs it, regardless of what is selected. (Remembered between sessions.)
//
// Shift+click queues at the front of the queue instead of the back.
//
// How it works: it takes the normal graph->prompt conversion, keeps only the target node(s) and
// everything upstream of them, and queues that. Nothing else in the graph is sent to the server.
//
// Put this file next to nougan_live_panel.js in web/. The panel builds it under the Queue / Stop row.

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const STYLE_ID = "nlp-runsel-stylesheet";
const LS_KEY = "nlp.runsel.target";
const AUTO = "__selected__";

const ICON_RUN = '<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M4 2.6v10.8a.5.5 0 0 0 .76.43l8.6-5.4a.5.5 0 0 0 0-.86l-8.6-5.4A.5.5 0 0 0 4 2.6z"/></svg>';
const ICON_LOCATE = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="8" cy="8" r="3"/><path d="M8 1.5v2.5M8 12v2.5M1.5 8H4M12 8h2.5"/></svg>';

const CSS = `
.nlp-rs{display:flex;align-items:center;gap:6px;min-width:0;padding:0 10px 8px;color:var(--nlp-fg,#d4d4d4);font:11px/1.2 system-ui,-apple-system,"Segoe UI",sans-serif}
.nlp-rs .nlp-fbtn{flex:none;display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
.nlp-rs .nlp-fbtn:disabled{opacity:.5;cursor:default}
.nlp-rs-run svg{color:var(--nlp-accent,#e67e22)}
.nlp-rs select{flex:1 1 0;min-width:0;height:26px;padding:0 6px;font:inherit;color:inherit;cursor:pointer;text-overflow:ellipsis;
  background:var(--nlp-input,#121212);border:1px solid var(--nlp-border,#3a3a3a);border-radius:5px}
.nlp-rs select:hover{border-color:var(--nlp-accent,#e67e22)}
.nlp-rs-msg{position:absolute;right:12px;bottom:-1px;font-size:10px;color:var(--nlp-dim,#8a8a8a);white-space:nowrap;pointer-events:none}
.nlp-rs-msg.nlp-rs-bad{color:#e5534b}
.nlp-rs-msg.nlp-rs-ok{color:#3fb950}
.nlp-rs{position:relative;padding-bottom:12px}
`;

function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = CSS;
    document.head.appendChild(s);
}

const $ = (tag, cls, parent) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (parent) parent.appendChild(e);
    return e;
};

// ---- graph helpers ----
const isOutputNode = (n) => !!n?.constructor?.nodeData?.output_node;
const isActive = (n) => n.mode !== 2 && n.mode !== 4;      // not muted / bypassed
const nodeLabel = (n) => `${n.title || n.type} #${n.id}`;

function allOutputNodes() {
    const nodes = app.graph?._nodes || app.graph?.nodes || [];
    return nodes.filter(isOutputNode);
}

function canvasSelection() {
    const sel = app.canvas?.selected_nodes;
    if (sel && typeof sel === "object") return Object.values(sel);
    const items = app.canvas?.selectedItems;
    return items ? [...items].filter((x) => x && x.id != null && x.type) : [];
}

// Keep the targets and every node they (transitively) read from.
function pruneToTargets(output, targetIds) {
    const keep = new Set();
    const stack = targetIds.map(String);
    while (stack.length) {
        const id = stack.pop();
        if (keep.has(id)) continue;
        const node = output[id];
        if (!node) continue;
        keep.add(id);
        for (const v of Object.values(node.inputs || {})) {
            if (Array.isArray(v) && v.length === 2 && (typeof v[0] === "string" || typeof v[0] === "number")) {
                stack.push(String(v[0]));
            }
        }
    }
    const out = {};
    for (const id of keep) out[id] = output[id];
    return out;
}

export function createRunSelected() {
    ensureStyles();

    const root = $("div", "nlp-rs");
    const btn = $("button", "nlp-fbtn nlp-runbtn nlp-rs-run", root);
    btn.type = "button";
    btn.innerHTML = ICON_RUN + "<span>Run selected</span>";
    const sel = $("select", null, root);
    const loc = $("button", "nlp-fbtn nlp-runbtn nlp-rs-loc", root);
    loc.type = "button";
    loc.innerHTML = ICON_LOCATE;
    loc.title = "Show this output node on the canvas";
    const msg = $("span", "nlp-rs-msg", root);

    let enabled = false;
    let pinned = AUTO;
    try { pinned = localStorage.getItem(LS_KEY) || AUTO; } catch {}
    let msgTimer = null;

    function flash(text, kind) {
        clearTimeout(msgTimer);
        msg.textContent = text;
        msg.className = "nlp-rs-msg" + (kind ? " nlp-rs-" + kind : "");
        if (text) msgTimer = setTimeout(() => { msg.textContent = ""; msg.className = "nlp-rs-msg"; }, 3500);
    }

    // ---- target list ----
    function rebuildList() {
        const outs = allOutputNodes();
        sel.replaceChildren();
        const auto = $("option", null, sel);
        auto.value = AUTO;
        auto.textContent = "Selected on canvas";
        for (const n of outs) {
            const o = $("option", null, sel);
            o.value = String(n.id);
            o.textContent = nodeLabel(n) + (isActive(n) ? "" : " (off)");
        }
        // a pinned node that no longer exists falls back to auto
        if (pinned !== AUTO && !outs.some((n) => String(n.id) === pinned)) pinned = AUTO;
        sel.value = pinned;
        refreshUi();
    }

    function refreshUi() {
        const pin = pinned !== AUTO;
        loc.style.display = pin ? "" : "none";
        btn.title = pin
            ? "Run only the pinned output node (Shift: queue at the front)"
            : "Run only the output node(s) selected on the canvas (Shift: queue at the front)";
    }

    function resolveTargets() {
        if (pinned !== AUTO) {
            const n = allOutputNodes().find((x) => String(x.id) === pinned);
            return n ? [n] : [];
        }
        return canvasSelection().filter(isOutputNode);
    }

    // ---- run ----
    async function run(front) {
        if (btn.disabled) return;
        const targets = resolveTargets();
        if (!targets.length) {
            flash(pinned === AUTO ? "Select an output node first" : "Target node not found", "bad");
            return;
        }
        const live = targets.filter(isActive);
        if (!live.length) { flash("Target is muted or bypassed", "bad"); return; }

        btn.disabled = true;
        try {
            const { output, workflow } = await app.graphToPrompt();
            const ids = live.map((n) => String(n.id)).filter((id) => output[id]);
            if (!ids.length) { flash("Node is not in the prompt", "bad"); return; }

            const pruned = pruneToTargets(output, ids);
            await api.queuePrompt(front ? -1 : 0, { output: pruned, workflow });

            // keep "control after generate" behaviour, but only for nodes that actually ran
            for (const n of app.graph?._nodes || []) {
                if (!pruned[String(n.id)]) continue;
                for (const w of n.widgets || []) { try { w.afterQueued?.(); } catch {} }
            }
            const n = Object.keys(pruned).length;
            flash(`Queued ${ids.length} output, ${n} node${n === 1 ? "" : "s"}`, "ok");
        } catch (err) {
            console.warn("nougan-live-panel: run selected failed", err);
            const nodeErrors = err?.response?.node_errors;
            if (nodeErrors) { try { app.lastNodeErrors = nodeErrors; app.canvas?.draw(true, true); } catch {} }
            flash(err?.response?.error?.message || err?.message || "Queue failed", "bad");
        } finally {
            btn.disabled = false;
        }
    }

    // ---- events ----
    const onRun = (e) => run(e.shiftKey);
    const onPick = () => {
        pinned = sel.value || AUTO;
        try { pinned === AUTO ? localStorage.removeItem(LS_KEY) : localStorage.setItem(LS_KEY, pinned); } catch {}
        refreshUi();
    };
    const onLocate = () => {
        const n = allOutputNodes().find((x) => String(x.id) === pinned);
        if (!n) return;
        try {
            app.canvas.centerOnNode?.(n);
            app.canvas.selectNode?.(n);
            app.canvas.setDirty?.(true, true);
        } catch {}
    };
    const onOpen = () => rebuildList();      // refresh the list whenever it is about to be used

    function setEnabled(on) {
        on = !!on;
        if (on === enabled) { root.style.display = on ? "" : "none"; return; }
        enabled = on;
        if (on) {
            root.style.display = "";
            btn.addEventListener("click", onRun);
            sel.addEventListener("change", onPick);
            sel.addEventListener("mousedown", onOpen);
            sel.addEventListener("focus", onOpen);
            loc.addEventListener("click", onLocate);
            rebuildList();
        } else {
            btn.removeEventListener("click", onRun);
            sel.removeEventListener("change", onPick);
            sel.removeEventListener("mousedown", onOpen);
            sel.removeEventListener("focus", onOpen);
            loc.removeEventListener("click", onLocate);
            clearTimeout(msgTimer);
            root.style.display = "none";
        }
    }

    function destroy() {
        setEnabled(false);
        root.remove();
    }

    root.style.display = "none";
    return { el: root, setEnabled, destroy, run: () => run(false) };
}
