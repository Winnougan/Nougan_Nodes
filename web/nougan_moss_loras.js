// NouganMossLoras — LoRA slot panel with trigger words (Pre/Post).
// Same design language as nougan-lora-loader-ui.js (hidden JSON widget +
// DOM panel), nglm- prefix to avoid CSS collisions with the existing nglz-*.
//
// Data model: hidden `lora_data` STRING widget holding
//   {"loras": [{on, name, strength, trigger, pos}, ...]}
// `strength` matches the existing loader's single-strength branch
// (model = clip = strength), so the Python side can reuse
// nougan_lora_loader._apply unchanged. `trigger`/`pos` are ignored by the
// old loader and read only by NouganMossLoras — compatible both ways.
import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

const DATA = "lora_data";
const PANEL_WIDGET = "nglm_panel";
const MIN_W = 330;
const TRIG_KEY = "nougan_moss_lora_triggers";   // localStorage: {loraName: {trigger, pos}}

const CSS = `
.nglm-inner{display:flex;flex-direction:column;gap:6px;padding:8px;
  font:12px/1.4 "Inter","Segoe UI",sans-serif;color:#c9ced8;user-select:none;}
.nglm-head{display:flex;align-items:center;justify-content:space-between;
  color:#9aa3b2;font-size:11px;text-transform:uppercase;letter-spacing:.06em;}
.nglm-add{background:#7c3aed;color:#fff;border:0;border-radius:5px;
  padding:3px 10px;cursor:pointer;font-size:12px;}
.nglm-add:hover{background:#8b5cf6;}
.nglm-empty{color:#666f7d;font-size:11px;padding:6px 2px;}
.nglm-slot{border:1px solid #3a3a46;border-radius:6px;background:rgba(255,255,255,.02);
  display:flex;flex-direction:column;gap:4px;padding:6px;}
.nglm-row{display:flex;align-items:center;gap:6px;min-width:0;}
.nglm-name{flex:1;min-width:0;background:#1b1b22;color:#e8e8ee;border:1px solid #444;
  border-radius:4px;padding:3px 6px;font-size:12px;}
.nglm-num{width:64px;background:#1b1b22;color:#e8e8ee;border:1px solid #444;
  border-radius:4px;padding:3px 4px;font-size:12px;text-align:right;}
.nglm-trig{flex:1;min-width:0;background:#1b1b22;color:#e8e8ee;border:1px solid #444;
  border-radius:4px;padding:3px 6px;font-size:12px;}
.nglm-trig::placeholder{color:#5a6270;}
.nglm-pos{background:#1b1b22;color:#e8e8ee;border:1px solid #444;border-radius:4px;
  padding:3px 4px;font-size:12px;}
.nglm-icon{background:none;border:0;color:#9aa3b2;cursor:pointer;font-size:13px;
  padding:2px 4px;border-radius:4px;}
.nglm-icon:hover{color:#e8e8ee;background:rgba(255,255,255,.06);}
.nglm-off .nglm-name,.nglm-off .nglm-num,.nglm-off .nglm-trig,.nglm-off .nglm-pos{opacity:.45;}
`;

let cssDone = false;
function injectCss() {
    if (cssDone) return;
    cssDone = true;
    const s = document.createElement("style");
    s.textContent = CSS;
    document.head.appendChild(s);
}

const h = (tag, cls, text) => {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
};

// Keep pointer/key events inside the panel (ComfyUI would otherwise steal
// them for canvas pan / shortcuts) — same lesson as the existing loader UI.
function guardPanel(el) {
    for (const ev of ["pointerdown", "pointerup", "pointermove", "wheel"])
        el.addEventListener(ev, (e) => e.stopPropagation());
}
function guardTextInput(el) {
    el.addEventListener("keydown", (e) => e.stopPropagation());
}

async function fetchList() {
    try {
        const r = await api.fetchApi("/nougan/loras");
        if (r.ok) {
            const j = await r.json();
            const a = (j || []).map(e => typeof e === "string" ? e : e?.name).filter(Boolean);
            if (a.length) return a;
        }
    } catch { /* fall through */ }
    try {
        const r = await api.fetchApi("/object_info/LoraLoader");
        const j = await r.json();
        const v = j?.LoraLoader?.input?.required?.lora_name;
        const vals = Array.isArray(v?.[0]) ? v[0] : v?.[1]?.options;
        if (Array.isArray(vals)) return vals.filter(x => typeof x === "string");
    } catch (e) {
        console.warn("[Nougan Moss Loras] list fetch failed", e);
    }
    return [];
}

function loadSavedTriggers() {
    try { return JSON.parse(localStorage.getItem(TRIG_KEY) || "{}") || {}; }
    catch { return {}; }
}

const dataW = (n) => n.widgets?.find(w => w.name === DATA) || null;

function hideDataWidget(node) {
    const w = dataW(node);
    if (!w) return;
    w.hidden = true;
    w.computeSize = () => [0, -4];
    const el = w.element || w.inputEl;
    if (el) { el.style.display = "none"; el.style.height = "0"; el.style.pointerEvents = "none"; }
}

function sync(node) {
    const w = dataW(node);
    if (!w) return;
    w.value = JSON.stringify({
        loras: (node.__nglmStack || []).map(e => ({
            on: !!e.on, name: e.name, strength: e.strength, trigger: e.trigger, pos: e.pos,
        })),
    });
    node.setDirtyCanvas(true, true);
}

function loadStack(node) {
    let stack = [];
    try {
        const p = JSON.parse(dataW(node)?.value || "{}");
        const raw = Array.isArray(p) ? p : (p.loras || []);
        stack = raw.filter(e => e && (e.name || e.lora)).map(e => ({
            on: e.on !== false,
            name: e.name || e.lora,
            strength: Number.isFinite(+e.strength) ? +e.strength : 1,
            trigger: typeof e.trigger === "string" ? e.trigger : "",
            pos: String(e.pos || "pre").toLowerCase() === "post" ? "post" : "pre",
        }));
    } catch { /* keep empty */ }
    node.__nglmStack = stack;
}

function syncHeight(node) {
    if (!node._nglm || !node.graph) return;
    const w = Math.max(MIN_W, node.size[0]);
    const hgt = node.computeSize()[1];
    if (Math.abs(node.size[1] - hgt) > 1 || node.size[0] !== w) node.setSize([w, hgt]);
    node.setDirtyCanvas(true, true);
}

function buildDom(node) {
    // Built once per node. Rebuilding on configure would leave the first DOM widget
    // behind in node.widgets (an empty, space-taking ghost), so onConfigure re-renders instead.
    if (node._nglm) return;
    injectCss();
    hideDataWidget(node);
    loadStack(node);

    const inner = h("div", "nglm-inner");
    guardPanel(inner);

    const head = h("div", "nglm-head");
    head.append(h("span", "", "LoRA slots"));
    const addBtn = h("button", "nglm-add", "+ Add");
    head.append(addBtn);
    inner.append(head);

    const listEl = h("div");
    listEl.style.cssText = "display:flex;flex-direction:column;gap:6px;";
    inner.append(listEl);

    const saved = loadSavedTriggers();

    const render = () => {
        listEl.textContent = "";
        const stack = node.__nglmStack;
        if (!stack.length) listEl.append(h("div", "nglm-empty", "No LoRAs — click + Add."));
        stack.forEach((e, i) => {
            const slot = h("div", "nglm-slot" + (e.on ? "" : " nglm-off"));

            // row 1: enable · name · strength · remove
            const r1 = h("div", "nglm-row");
            const on = h("input");
            on.type = "checkbox";
            on.checked = e.on;
            on.addEventListener("change", () => { e.on = on.checked; sync(node); render(); });
            const name = h("select", "nglm-name");
            const names = node.__nglmNames || [];
            if (e.name && !names.includes(e.name)) name.append(new Option(e.name, e.name));
            for (const n of names) name.append(new Option(n, n));
            if (!names.length && !e.name) name.append(new Option("(no LoRAs found)", ""));
            name.value = e.name;
            name.addEventListener("change", () => {
                e.name = name.value;
                const s = saved[e.name];
                if (s && !e.trigger) { e.trigger = s.trigger || ""; e.pos = s.pos === "post" ? "post" : "pre"; }
                sync(node); render();
            });
            const num = h("input", "nglm-num");
            num.type = "number"; num.step = "0.05"; num.min = "-10"; num.max = "10";
            num.value = String(e.strength);
            num.title = "Strength (model + clip)";
            guardTextInput(num);
            num.addEventListener("change", () => {
                const v = +num.value;
                e.strength = Number.isFinite(v) ? Math.max(-10, Math.min(10, v)) : 1;
                num.value = String(e.strength);
                sync(node);
            });
            const del = h("button", "nglm-icon", "✕");
            del.title = "Remove slot";
            del.addEventListener("click", () => { stack.splice(i, 1); sync(node); render(); });
            r1.append(on, name, num, del);

            // row 2: trigger word · pre/post · save trigger
            const r2 = h("div", "nglm-row");
            const trig = h("input", "nglm-trig");
            trig.type = "text";
            trig.placeholder = "trigger words (optional)";
            trig.value = e.trigger;
            guardTextInput(trig);
            trig.addEventListener("input", () => { e.trigger = trig.value; sync(node); });
            const pos = h("select", "nglm-pos");
            pos.append(new Option("Pre", "pre"), new Option("Post", "post"));
            pos.value = e.pos;
            pos.title = "Pre: before prompt · Post: after prompt";
            pos.addEventListener("change", () => { e.pos = pos.value; sync(node); });
            const save = h("button", "nglm-icon", "💾");
            save.title = "Remember trigger words for this LoRA";
            save.addEventListener("click", () => {
                if (!e.name) return;
                saved[e.name] = { trigger: e.trigger, pos: e.pos };
                try { localStorage.setItem(TRIG_KEY, JSON.stringify(saved)); } catch { /* quota */ }
            });
            r2.append(trig, pos, save);

            slot.append(r1, r2);
            listEl.append(slot);
        });
        syncHeight(node);
    };

    addBtn.addEventListener("click", () => {
        const nm = (node.__nglmNames || [])[0] || "";
        const s = nm ? saved[nm] : null;
        node.__nglmStack.push({
            on: true, name: nm, strength: 1,
            trigger: s?.trigger || "", pos: s?.pos === "post" ? "post" : "pre",
        });
        sync(node); render();
    });

    fetchList().then(names => { node.__nglmNames = names || []; render(); });

    const dw = node.addDOMWidget(PANEL_WIDGET, "nglm-panel", inner, { hideOnZoom: false, serialize: false });
    dw.serializeValue = () => undefined;   // nothing to save; data lives in lora_data
    let lastH = 0;
    dw.computeSize = () => {
        const sh = inner.scrollHeight;
        if (sh > 4) lastH = sh;
        return [Math.max(MIN_W, node.size[0]), Math.max(60, (lastH || sh) + 10)];
    };
    const ro = new ResizeObserver(() => { if (inner.scrollHeight > 4) syncHeight(node); });
    ro.observe(inner);

    node._nglm = { inner, dw, ro, render };
    render();
}

app.registerExtension({
    name: "nougan.moss.loras",
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "NouganMossLoras") return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            onNodeCreated?.apply(this, arguments);
            buildDom(this);
        };

        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const r = onConfigure?.apply(this, arguments);
            // Saved workflows restore lora_data without callbacks — re-read it into the existing panel.
            try {
                if (this._nglm) { hideDataWidget(this); loadStack(this); this._nglm.render(); }
                else buildDom(this);
            } catch (e) { console.warn("[Nougan Moss Loras] onConfigure failed", e); }
            return r;
        };

        const onRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            this._nglm?.ro?.disconnect();
            return onRemoved?.apply(this, arguments);
        };
    },
});
