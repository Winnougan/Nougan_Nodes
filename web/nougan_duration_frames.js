// Nougan Duration -> Frames - one node instead of "Float (duration)" + "Math Expression".
//   * preset dropdown (MiniMax H3 / 24 FPS / 30 FPS / Custom) fills in expression + fps
//   * lock / unlock button protects the expression (locked by default)
//   * live preview: result for the current duration plus a sample table, evaluated by the
//     backend itself (/nougan/duration_frames/eval) so it can never disagree with the real run
//   * when "duration" is wired from another node, the preview follows the value from the last run
// Pairs with nougan_duration_frames.py.

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_ID = "NouganDurationFrames";
const CUSTOM = "Custom";
const SAMPLES = [2, 3, 4, 5, 6, 8, 10, 12, 15];
const LOCKED = "🔒 Locked  ·  click to edit expression";
const UNLOCKED = "🔓 Unlocked  ·  click to lock";

// ---------------------------------------------------------------- styles

function injectStyles() {
    document.getElementById("nougan-df-style")?.remove();
    const style = document.createElement("style");
    style.id = "nougan-df-style";
    style.textContent = `
.ndf { box-sizing: border-box; width: 100%; height: 100%; display: flex; flex-direction: column; gap: 6px; padding: 4px 2px;
  font: 12px/1.3 system-ui, sans-serif; color: #e8e6f0; user-select: none; }
.ndf * { box-sizing: border-box; }
.ndf-main { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; padding: 8px 10px; border-radius: 9px;
  background: radial-gradient(circle at 20% 0%, #2a2140, #120e20); border: 1px solid #3b2f5c; }
.ndf-big { font-size: 22px; font-weight: 700; font-variant-numeric: tabular-nums; color: #fff; }
.ndf-big small { font-size: 12px; font-weight: 500; color: #b9aee6; margin-left: 4px; }
.ndf-sub { color: #b9aee6; font-variant-numeric: tabular-nums; }
.ndf-main.bad { border-color: #8f3b4a; }
.ndf-main.bad .ndf-big { color: #ff9aa9; }
.ndf-err { display: none; padding: 5px 9px; border-radius: 7px; background: #2b1620; border: 1px solid #8f3b4a; color: #ff9aa9; }
.ndf-err.on { display: block; }
.ndf-note { color: #8f86b3; font-size: 11px; padding: 0 2px; }
.ndf-table { display: grid; grid-template-columns: repeat(auto-fill, minmax(54px, 1fr)); gap: 4px; }
.ndf-cell { display: flex; flex-direction: column; align-items: center; padding: 3px 2px; border-radius: 7px;
  background: #241d3d; border: 1px solid #3b2f5c; font-variant-numeric: tabular-nums; }
.ndf-cell b { color: #c9c0ee; font-weight: 600; font-size: 11px; }
.ndf-cell span { color: #fff; font-size: 13px; }
.ndf-cell.err span { color: #ff9aa9; }
`;
    document.head.appendChild(style);
}

// ---------------------------------------------------------------- helpers

const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
};
const num = (v) => Number(Number(v).toFixed(3)).toString();
const W = (node, name) => node.widgets?.find((w) => w.name === name);
const textareaOf = (w) =>
    w?.inputEl || w?.element?.querySelector?.("textarea") || (w?.element?.tagName === "TEXTAREA" ? w.element : null);
const isLinked = (node, name) =>
    !!node.inputs?.some((i) => (i.widget?.name === name || i.name === name) && i.link != null);

let presetCache = null;
async function loadPresets() {
    if (presetCache) return presetCache;
    try {
        const r = await api.fetchApi("/nougan/duration_frames/presets");
        if (r.ok) presetCache = await r.json();
    } catch { /* retry next time */ }
    return presetCache || {};
}

// ---------------------------------------------------------------- per-node wiring

function setup(node) {
    injectStyles();

    // ---- preview widget
    const root = el("div", "ndf");
    const main = el("div", "ndf-main");
    const big = el("div", "ndf-big", "…");
    const sub = el("div", "ndf-sub");
    main.append(big, sub);
    const err = el("div", "ndf-err");
    const note = el("div", "ndf-note");
    const table = el("div", "ndf-table");
    root.append(main, err, note, table);

    const preview = node.addDOMWidget("nougan_duration_preview", "nougan_duration_preview", root, {
        serialize: false,
        hideOnZoom: false,
        getMinHeight: () => 150,
    });
    preview.computeSize = (width) => [width, 160];

    // ---- lock button, placed right under the expression box
    const lockBtn = node.addWidget("button", LOCKED, null, () => {
        setLocked(!isLocked());
    }, { serialize: false });
    const exprW = W(node, "expression");
    const widgets = node.widgets;
    widgets.splice(widgets.indexOf(lockBtn), 1);
    widgets.splice(widgets.indexOf(exprW) + 1, 0, lockBtn);

    const durW = W(node, "duration");
    const presetW = W(node, "preset");
    const fpsW = W(node, "fps");

    const isLocked = () => node.properties?.nougan_locked !== false;   // locked unless explicitly unlocked
    let seq = 0;
    let timer = 0;
    let dead = false;

    function setText(value) {
        exprW.value = value;
        const ta = textareaOf(exprW);
        if (ta) ta.value = value;
    }

    function applyLock(tries = 0) {
        const locked = isLocked();
        lockBtn.label = lockBtn.name = locked ? LOCKED : UNLOCKED;
        fpsW.disabled = locked || presetW.value !== CUSTOM;
        const ta = textareaOf(exprW);
        if (!ta) {
            if (tries < 30 && !dead) requestAnimationFrame(() => applyLock(tries + 1));
            return;
        }
        ta.readOnly = locked;
        ta.spellcheck = false;
        ta.style.fontFamily = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
        ta.style.opacity = locked ? "0.6" : "1";
        ta.style.cursor = locked ? "not-allowed" : "text";
        ta.title = locked ? "Locked. Press the lock button below to edit." : "Editing switches the preset to Custom.";
        node.setDirtyCanvas(true, true);
    }

    function setLocked(locked) {
        node.properties = node.properties || {};
        node.properties.nougan_locked = locked;
        applyLock();
        if (!locked) textareaOf(exprW)?.focus();
    }

    // Presets always run their own expression on the backend, so show exactly that.
    async function applyPreset(name) {
        const p = (await loadPresets())[name];
        if (!p) return;
        setText(p.expression);
        fpsW.value = p.fps;
    }

    // ---- live preview
    function currentSettings() {
        const table = presetCache || {};
        const p = table[presetW.value];
        return p ? { expression: p.expression, fps: p.fps } : { expression: exprW.value, fps: fpsW.value };
    }

    function render(res, current, linkedNote) {
        const waiting = !isFinite(current);                       // duration is wired in and nothing has run yet
        const row = res.rows.find((r) => r.current);
        const failed = !waiting && !!row?.error;
        main.classList.toggle("bad", failed);
        err.classList.toggle("on", failed);
        err.textContent = failed ? "Expression error: " + row.error : "";
        if (waiting) {
            big.textContent = "…";
            sub.textContent = "";
        } else if (failed) {
            big.textContent = "—";
            sub.textContent = "";
        } else {
            big.replaceChildren(document.createTextNode(String(row.frames)), el("small", "", "frames"));
            sub.textContent = `${num(row.a)} s @ ${res.fps} fps  →  ${row.seconds.toFixed(2)} s actual`;
        }
        note.textContent = linkedNote || "";
        note.style.display = linkedNote ? "block" : "none";
        table.replaceChildren();
        for (const r of res.rows) {
            if (r.current) continue;
            const cell = el("div", "ndf-cell" + (r.error ? " err" : ""));
            cell.append(el("b", "", num(r.a) + " s"), el("span", "", r.error ? "×" : String(r.frames)));
            if (r.error) cell.title = r.error;
            table.appendChild(cell);
        }
    }

    async function refresh() {
        if (dead) return;
        const mine = ++seq;
        await loadPresets();
        const linked = isLinked(node, "duration");
        const last = node._ndfLast;
        let current = Number(durW.value);
        let linkedNote = "";
        if (linked) {
            if (last) { current = last.duration; linkedNote = "duration comes from a connected node (value from the last run)"; }
            else { linkedNote = "duration comes from a connected node. Run the workflow to see its value."; current = NaN; }
        }
        const { expression, fps } = currentSettings();
        const values = [...(isFinite(current) ? [current] : []), ...SAMPLES.filter((s) => s !== current)];
        let res;
        try {
            const r = await api.fetchApi("/nougan/duration_frames/eval", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ preset: presetW.value, expression, fps, values }),
            });
            res = await r.json();
        } catch {
            if (mine === seq) { big.textContent = "—"; sub.textContent = "preview unavailable (backend not reachable)"; }
            return;
        }
        if (mine !== seq || dead || !res.rows) return;
        if (isFinite(current)) res.rows[0].current = true;
        render(res, current, linkedNote);
    }
    const schedule = () => { clearTimeout(timer); timer = setTimeout(refresh, 120); };

    // ---- wire events
    const chain = (w, after) => {
        const orig = w.callback;
        w.callback = function () {
            const r = orig?.apply(this, arguments);
            after(...arguments);
            return r;
        };
    };
    chain(durW, schedule);
    chain(fpsW, schedule);
    chain(presetW, async (value) => {
        if (value === CUSTOM) {
            if (isLocked()) setLocked(false);        // choosing Custom means "I want to type"
            else applyLock();
        } else {
            await applyPreset(value);
            applyLock();
        }
        schedule();
    });

    const hookTextarea = (tries = 0) => {
        const ta = textareaOf(exprW);
        if (!ta) { if (tries < 30 && !dead) requestAnimationFrame(() => hookTextarea(tries + 1)); return; }
        ta.addEventListener("input", async () => {
            if (isLocked()) return;
            const p = (await loadPresets())[presetW.value];
            if (p && ta.value !== p.expression) { presetW.value = CUSTOM; applyLock(); }
            schedule();
        });
    };
    hookTextarea();

    // After a workflow loads: make the box show what will really run, restore the lock state.
    node._ndfSync = async () => {
        const p = (await loadPresets())[presetW.value];
        if (p) { setText(p.expression); fpsW.value = p.fps; }
        applyLock();
        schedule();
    };
    node._ndfDispose = () => { dead = true; clearTimeout(timer); };
    node._ndfRefresh = schedule;

    node.setSize([Math.max(node.size[0], 400), Math.max(node.size[1], node.computeSize()[1])]);
    applyLock();
    node._ndfSync();
}

// ---------------------------------------------------------------- extension

app.registerExtension({
    name: "Nougan.DurationFrames",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_ID) return;

        const onCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onCreated?.apply(this, arguments);
            setup(this);
            return r;
        };

        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const r = onConfigure?.apply(this, arguments);
            this._ndfSync?.();
            return r;
        };

        const onExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            onExecuted?.apply(this, arguments);
            const info = message?.nougan_duration_frames?.[0];
            if (info) { this._ndfLast = info; this._ndfRefresh?.(); }
        };

        const onConnectionsChange = nodeType.prototype.onConnectionsChange;
        nodeType.prototype.onConnectionsChange = function () {
            const r = onConnectionsChange?.apply(this, arguments);
            this._ndfRefresh?.();
            return r;
        };

        const onRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            try { this._ndfDispose?.(); } catch { /* ignore */ }
            return onRemoved?.apply(this, arguments);
        };
    },
});
