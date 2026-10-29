// Automagic 2222: Live Panel
//
// A floating, dockable panel that reads what is loaded in the current workflow
// (checkpoint, CLIP, VAE, every sampler, LoRAs) and lets you edit the values on
// the real nodes. No cables: it only reads and writes widget values.
//
// Put this file in web/ and nougan_live_panel.css in web/css/.

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const STORAGE_KEY = "nougan_live_panel_state";
const SETTING_ID = "Nougan.LivePanel.Enabled";
const POLL_MS = 400;

// ---- Config: add widget names from your custom loaders here ----------------
const CHECKPOINT_WIDGETS = ["ckpt_name", "unet_name"];
const CLIP_WIDGETS = ["clip_name", "clip_name1", "clip_name2", "clip_name3", "clip_name4"];
const VAE_WIDGETS = ["vae_name"];
const EXCLUDE_TYPES = /save/i;   // skip saver nodes
// -----------------------------------------------------------------------------

// ---- Visual presets (palettes taken from the Aimdo visualizer) ----------------
// "comfy" has no colors: it leaves the panel on ComfyUI's own theme tokens.
const THEMES = {
    comfy:   { label: "Comfy (follows ComfyUI)" },
    dark:    { label: "Dark",    scheme: "dark",  bg: "#181818", card: "#1f1f1f", head: "#202020", input: "#0e0e0e", fg: "#b0b0b0", dim: "#707070", border: "#2a2a2a", accent: "#e67e22" },
    light:   { label: "Light",   scheme: "light", bg: "#f5f5f5", card: "#ebebeb", head: "#e2e2e2", input: "#fdfdfd", fg: "#1a1a1a", dim: "#555555", border: "#a8a8a8", accent: "#c2410c" },
    sepia:   { label: "Sepia",   scheme: "light", bg: "#f4ecd8", card: "#ebe1c9", head: "#e0d4b6", input: "#faf6e8", fg: "#3a2f1e", dim: "#7a6a4e", border: "#b8a982", accent: "#b8732e" },
    fallout: { label: "Fallout", scheme: "dark",  bg: "#0a1a0a", card: "#0f2510", head: "#2a2520", input: "#051005", fg: "#7fff7f", dim: "#3a8a3a", border: "#5a4a3a", accent: "#88ff66" },
    pink:    { label: "Pink",    scheme: "light", bg: "#fff0f5", card: "#ffeaf2", head: "#ffd6e8", input: "#fff5fa", fg: "#4a1f3a", dim: "#8a4a6a", border: "#e8a4c4", accent: "#e91e63" },
    lucifer: { label: "Lucifer", scheme: "dark",  bg: "#000000", card: "#050000", head: "#000000", input: "#110000", fg: "#ffffff", dim: "#880000", border: "#ff0000", accent: "#ff0000" },
};
const THEME_VARS = {
    bg: "--nlp-bg", card: "--nlp-card", head: "--nlp-head", input: "--nlp-input",
    fg: "--nlp-fg", dim: "--nlp-dim", border: "--nlp-border", accent: "--nlp-accent",
};

const state = Object.assign(
    { x: null, y: 70, w: 300, h: null, collapsed: false, dock: "float", minimized: false, theme: "comfy" },
    loadState()
);
if (!THEMES[state.theme]) state.theme = "comfy";
function loadState() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; } catch { return {}; }
}
let saveTimer = null;
function saveState() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {}
    }, 150);
}

const cssLoaded = new Promise((resolve) => {
    const id = "nougan-live-panel-stylesheet";
    if (document.getElementById(id)) { resolve(); return; }
    const link = document.createElement("link");
    link.id = id;
    link.rel = "stylesheet";
    link.href = new URL("css/nougan_live_panel.css", import.meta.url).href;
    link.addEventListener("load", () => resolve(), { once: true });
    link.addEventListener("error", () => resolve(), { once: true });
    document.head.appendChild(link);
});

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
}

// ============================ graph reading ==================================

const nodeType = (n) => n.comfyClass || n.type || "";
// LiteGraph modes: 2 = muted, 4 = bypassed. Those nodes don't run, so we skip them.
const isActive = (n) => n.mode !== 2 && n.mode !== 4;

// subgraph -> the node instance that holds it (needed to follow promoted widgets)
const subParent = new Map();

function collectNodes(graph, out = [], seen = new Set()) {
    if (!graph || seen.has(graph)) return out;
    seen.add(graph);
    for (const n of (graph._nodes || graph.nodes || [])) {
        if (!isActive(n)) continue;
        out.push(n);
        if (n.subgraph) { subParent.set(n.subgraph, n); collectNodes(n.subgraph, out, seen); }
    }
    return out;
}

function linkOf(node, id) {
    const g = node?.graph;
    if (!g || id == null) return null;
    return g.getLink?.(id) ?? g.links?.[id] ?? g.links?.get?.(id) ?? null;
}

function originOf(node, input) {
    if (!input || input.link == null) return null;
    const g = node.graph;
    if (!g) return null;
    const link = linkOf(node, input.link);
    if (!link) return null;
    let o = g.getNodeById(link.origin_id);
    for (let hops = 0; o && nodeType(o) === "Reroute" && hops < 8; hops++) {
        o = originOf(o, o.inputs?.[0]);
    }
    return o;
}

function upstream(node, inputName) {
    if (!node) return null;
    return originOf(node, node.inputs?.find((i) => i.name === inputName));
}

// Walk up an input chain until a node that owns the wanted widget is found
// (e.g. sigmas -> SplitSigmas -> BasicScheduler).
function chase(node, inputName, widgetName) {
    let n = upstream(node, inputName);
    for (let i = 0; n && i < 6; i++) {
        if (n.widgets?.some((w) => w.name === widgetName)) return n;
        n = upstream(n, inputName);
    }
    return null;
}

// Find the widget that actually controls `name` on `node`. If the widget is
// driven by a link from a primitive-style node, edit that node instead;
// otherwise mark it linked (shown read-only).
function resolve(node, name) {
    const w = node?.widgets?.find((x) => x.name === name);
    if (!w) return null;
    const inp = node.inputs?.find((i) => i.widget?.name === name);
    if (inp && inp.link != null) {
        // Fed by a subgraph's own input (origin id -10): the real control is the
        // promoted widget on the subgraph node, so point at that instead of
        // showing a second, disabled copy.
        const g = node.graph;
        if (g && subParent.has(g)) {
            const lk = linkOf(node, inp.link);
            let si = lk && lk.origin_id === -10 ? g.inputs?.[lk.origin_slot] : null;
            if (!si) si = g.inputs?.find((x) => x.linkIds?.includes(inp.link));
            if (si) {
                const parent = subParent.get(g);
                const up = parent ? resolve(parent, si.name) : null;
                if (up) return up;
                return { node, w, linked: true, fromSubgraph: true };
            }
        }
        const o = originOf(node, inp);
        if (o) {
            const ow = o.widgets?.find((x) => x.name === "value" || x.name === name)
                || (/^Primitive/.test(nodeType(o)) ? o.widgets?.[0] : null);
            if (ow && typeof ow.value === typeof w.value) return { node: o, w: ow };
        }
        return { node, w, linked: true };
    }
    return { node, w };
}

function collectSamplers(nodes) {
    const out = [];
    for (const n of nodes) {
        const has = (nm) => n.widgets?.some((w) => w.name === nm);
        const hasIn = (nm) => n.inputs?.some((i) => i.name === nm);
        let f = null;
        if (has("sampler_name") && has("steps")) {
            // KSampler, KSamplerAdvanced and look-alikes
            f = {
                steps: resolve(n, "steps"),
                cfg: resolve(n, "cfg"),
                sampler: resolve(n, "sampler_name"),
                scheduler: resolve(n, "scheduler"),
                denoise: resolve(n, "denoise"),
            };
        } else if (hasIn("sigmas") && hasIn("sampler")) {
            // SamplerCustom / SamplerCustomAdvanced: settings live on upstream nodes
            const guider = upstream(n, "guider");
            const smp = chase(n, "sampler", "sampler_name");
            const sig = chase(n, "sigmas", "steps");
            f = {
                steps: resolve(sig, "steps"),
                cfg: resolve(n, "cfg") || resolve(guider, "cfg") || resolve(guider, "cfg_conds"),
                sampler: resolve(smp, "sampler_name"),
                scheduler: resolve(sig, "scheduler"),
                denoise: resolve(sig, "denoise"),
            };
        }
        if (f) out.push({ node: n, ...f });
    }
    out.sort((a, b) => Number(a.node.id) - Number(b.node.id));
    return out;
}

// ---- LoRA name list (for loaders whose widgets are not plain combos) ----
let loraNames = [];
async function loadLoraNames() {
    try {
        const r = await api.fetchApi("/object_info/LoraLoader");
        const j = await r.json();
        const v = j?.LoraLoader?.input?.required?.lora_name?.[0];
        if (Array.isArray(v)) loraNames = v.map(String);
    } catch {}
}

// rgthree "Power Lora Loader": each lora_N widget holds {on, lora, strength, strengthTwo}.
// We expose each field as a tiny widget-like object so the normal controls work on it.
const proxyCache = new WeakMap();
function loraProxies(w) {
    let p = proxyCache.get(w);
    if (p) return p;
    const field = (key, type, options, fallbackKey) => ({
        name: `${w.name}.${key}`,
        type,
        options,
        get value() {
            const v = w.value;
            if (!v || typeof v !== "object") return undefined;
            return v[key] ?? (fallbackKey ? v[fallbackKey] : undefined);
        },
        set value(x) { w.value = { ...(w.value || {}), [key]: x }; },
    });
    const num = { min: -10, max: 10, precision: 2, step: 1 };
    p = {
        on: field("on", "toggle", {}),
        lora: field("lora", "combo", { values: () => loraNames }),
        strength: field("strength", "number", num),
        strengthTwo: field("strengthTwo", "number", num, "strength"),
    };
    proxyCache.set(w, p);
    return p;
}

function collectLoras(nodes) {
    const out = [];
    for (const n of nodes) {
        if (EXCLUDE_TYPES.test(nodeType(n))) continue;
        for (const w of n.widgets || []) {
            if (/^lora_\d+$/.test(w.name) && w.value && typeof w.value === "object" && "lora" in w.value) {
                const p = loraProxies(w);
                const two = n.properties?.["Show Strengths"] === "Separate Model & Clip";
                out.push({
                    node: n,
                    on: { node: n, w: p.on },
                    name: { node: n, w: p.lora },
                    strength: { node: n, w: p.strength },
                    strengthClip: two ? { node: n, w: p.strengthTwo } : null,
                });
                continue;
            }
            const m = /^lora_name(.*)$/.exec(w.name);
            if (!m || w.type !== "combo") continue;
            const sfx = m[1];
            let strength = null;
            for (const nm of [`strength_model${sfx}`, `lora_strength${sfx}`, `strength${sfx}`]) {
                strength = resolve(n, nm);
                if (strength) break;
            }
            out.push({
                node: n,
                name: resolve(n, w.name),
                strength,
                strengthClip: resolve(n, `strength_clip${sfx}`),
            });
        }
    }
    out.sort((a, b) => Number(a.node.id) - Number(b.node.id));
    return out;
}

// Resolution selectors, plain width/height nodes, and duration sources.
const DURATION_WIDGETS = ["duration", "seconds", "duration_seconds", "length_seconds"];
function collectOutput(nodes) {
    const res = [], sizes = [], durs = [];
    const seenW = new Set();
    for (const n of nodes) {
        if (EXCLUDE_TYPES.test(nodeType(n))) continue;
        const has = (nm) => n.widgets?.some((w) => w.name === nm);

        if (has("aspect_ratio") && has("megapixels")) {
            res.push({
                node: n,
                aspect: resolve(n, "aspect_ratio"),
                mp: resolve(n, "megapixels"),
                multiple: has("multiple") ? resolve(n, "multiple") : null,
            });
        } else if (has("width") && has("height")) {
            const w = resolve(n, "width"), h = resolve(n, "height");
            // both driven by a selector/other node -> nothing to edit here
            if (w && h && !(w.linked && h.linked)) sizes.push({ node: n, width: w, height: h });
        }

        const add = (ref, float) => {
            if (!ref || seenW.has(ref.w) || typeof ref.w.value !== "number") return;
            seenW.add(ref.w);
            durs.push({ node: ref.node, value: ref, float });
        };
        if (/^Primitive(Float|Int)$/.test(nodeType(n)) && /dur|second|time|length/i.test(n.title || "")) {
            add(resolve(n, "value"), nodeType(n).endsWith("Float"));
        }
        for (const nm of DURATION_WIDGETS) if (has(nm)) add(resolve(n, nm), true);
    }
    const byId = (a, b) => Number(a.node.id) - Number(b.node.id);
    res.sort(byId); sizes.sort(byId); durs.sort(byId);
    return { res, sizes, durs };
}

function buildModel() {
    const nodes = collectNodes(app.graph);
    const byId = (a, b) => Number(a.node.id) - Number(b.node.id);

    const loaders = { ckpt: [], clip: [], vae: [] };
    const seen = new Set();
    for (const n of nodes) {
        if (EXCLUDE_TYPES.test(nodeType(n))) continue;
        for (const w of n.widgets || []) {
            if (w.type !== "combo") continue;
            const base = w.name.replace(/_\d+$/, "");
            const role = CHECKPOINT_WIDGETS.includes(base) ? "ckpt"
                : (CLIP_WIDGETS.includes(w.name) || CLIP_WIDGETS.includes(base)) ? "clip"
                : VAE_WIDGETS.includes(base) ? "vae" : null;
            if (!role) continue;
            const ref = resolve(n, w.name);
            if (!ref || ref.linked || seen.has(ref.w)) continue;
            seen.add(ref.w);
            loaders[role].push({ ...ref, title: n.title || nodeType(n) });
        }
    }
    for (const k in loaders) loaders[k].sort(byId);

    return { ...loaders, samplers: collectSamplers(nodes), loras: collectLoras(nodes), out: collectOutput(nodes) };
}

// Structure signature: when it changes we rebuild the DOM, otherwise we only
// refresh control values.
const wids = new WeakMap();
let widSeq = 0;
function rsig(r) {
    if (!r) return "NA";
    let i = wids.get(r.w);
    if (!i) { i = ++widSeq; wids.set(r.w, i); }
    return `${i}${r.linked ? "L" : ""}`;
}
function signature(m) {
    const L = (a) => a.map((r) => `${r.node.id}:${rsig(r)}`).join(",");
    return [
        L(m.ckpt), L(m.clip), L(m.vae),
        m.samplers.map((s) => `${s.node.id}:${s.node.title}:` +
            ["steps", "cfg", "sampler", "scheduler", "denoise"].map((k) => rsig(s[k])).join("/")).join(";"),
        m.loras.map((l) => `${l.node.id}:${rsig(l.on)}/${rsig(l.name)}/${rsig(l.strength)}/${rsig(l.strengthClip)}`).join(";"),
        m.out.res.map((r) => `${r.node.id}:${rsig(r.aspect)}/${rsig(r.mp)}/${rsig(r.multiple)}`).join(";"),
        m.out.sizes.map((r) => `${r.node.id}:${rsig(r.width)}/${rsig(r.height)}`).join(";"),
        m.out.durs.map((r) => `${r.node.id}:${rsig(r.value)}`).join(";"),
        JSON.stringify(readCfg()),
    ].join("|");
}

// ============================ graph writing ==================================

function setWidgetValue(node, w, v) {
    const old = w.value;
    if (old === v) return;
    w.value = v;
    try { w.callback?.(v, app.canvas, node, app.canvas?.graph_mouse, undefined); }
    catch (e) { console.warn("nougan-live-panel: widget callback failed", e); }
    try { node.onWidgetChanged?.(w.name, v, old, w); } catch {}
    try { node.graph?.setDirtyCanvas?.(true, true); app.canvas?.setDirty?.(true, true); } catch {}
    // register with undo/redo + mark the workflow as modified
    try { app.extensionManager?.workflow?.activeWorkflow?.changeTracker?.checkState?.(); } catch {}
}

function touchWorkflow() {
    try { app.extensionManager?.workflow?.activeWorkflow?.changeTracker?.checkState?.(); } catch {}
}

// ---- user layout: renamed labels, hidden items, custom order ----
// Stored inside the workflow itself (graph.extra.nougan_live_panel), so it
// travels with the file and each workflow keeps its own layout.
const EMPTY_CFG = { names: {}, hidden: {}, order: {} };
const readCfg = () => app.graph?.extra?.nougan_live_panel || EMPTY_CFG;
function editCfg(fn) {
    const g = app.graph;
    if (!g) return;
    g.extra = g.extra || {};
    const c = g.extra.nougan_live_panel || (g.extra.nougan_live_panel = {});
    c.names = c.names || {}; c.hidden = c.hidden || {}; c.order = c.order || {};
    fn(c);
    touchWorkflow();
    rebuild();
}
function resetCfg() {
    const g = app.graph;
    if (g?.extra?.nougan_live_panel) { delete g.extra.nougan_live_panel; touchWorkflow(); }
    rebuild();
}
function rebuild() { lastSig = null; tick(); }
// unique per node, even inside subgraphs where ids can repeat
const nkey = (n) => (n.graph && subParent.has(n.graph) ? `${n.graph.id}.` : "") + n.id;

function focusNode(node) {
    try {
        const c = app.canvas;
        if (node.graph && c.graph !== node.graph) c.setGraph?.(node.graph);
        c.centerOnNode?.(node);
        c.selectNode?.(node);
    } catch {}
}

// ============================ controls =======================================

let bindings = [];

function linkedHint(ctrl, ref) {
    if (ref.linked) {
        ctrl.disabled = true;
        ctrl.title = "Driven by a link from another node, edit it there";
    }
}

function makeCombo(ref) {
    const { node, w } = ref;
    const sel = el("select", "nlp-select");
    linkedHint(sel, ref);
    let listKey = null;
    let lastRaw = [];

    function sync(force) {
        if (!force && document.activeElement === sel) return;
        const v = w.options?.values;
        const raw = (typeof v === "function" ? v(w, node) : v) || [];
        lastRaw = Array.isArray(raw) ? raw : [];
        const list = lastRaw.map(String);
        const cur = String(w.value);
        const key = list.join("\u0001") + "\u0002" + (list.includes(cur) ? "" : cur);
        if (key !== listKey) {
            listKey = key;
            sel.textContent = "";
            const items = list.includes(cur) ? list : [cur, ...list];
            for (const s of items) {
                const op = el("option", null, s);
                op.value = s;
                sel.append(op);
            }
        }
        sel.value = cur;
        if (!ref.linked) sel.title = cur;
    }
    sel.addEventListener("change", () => {
        const orig = lastRaw.find((x) => String(x) === sel.value);
        setWidgetValue(node, w, orig !== undefined ? orig : sel.value);
        sync(true);
    });
    bindings.push({ sync });
    sync(true);
    return sel;
}

function makeToggle(ref) {
    const { node, w } = ref;
    const box = el("input", "nlp-check");
    box.type = "checkbox";
    linkedHint(box, ref);
    function sync() {
        box.checked = !!w.value;
        box.closest(".nlp-card")?.classList.toggle("nlp-off", !w.value);
    }
    box.addEventListener("change", () => { setWidgetValue(node, w, box.checked); sync(); });
    bindings.push({ sync });
    sync();
    return box;
}

function makeNumber(ref, withSlider, opts = {}) {
    const { node, w } = ref;
    const o = w.options || {};
    const prec = opts.prec ?? o.precision ?? (Number.isInteger(w.value) ? 0 : 2);
    const step = opts.step ?? (o.step ? o.step / 10 : (prec === 0 ? 1 : 0.1));
    const min = Number.isFinite(o.min) ? o.min : undefined;
    const max = Number.isFinite(o.max) ? o.max : undefined;

    const wrap = el("div", "nlp-numwrap" + (withSlider ? " nlp-withslider" : ""));
    const input = el("input", "nlp-num");
    input.type = "number";
    input.step = String(step);
    if (min !== undefined) input.min = String(min);
    if (max !== undefined) input.max = String(max);
    linkedHint(input, ref);

    let slider = null;
    if (withSlider) {
        slider = el("input");
        slider.type = "range";
        slider.min = String(Math.max(min ?? -2, -2));
        slider.max = String(Math.min(max ?? 2, 2));
        slider.step = String(step);
        slider.disabled = !!ref.linked;
        wrap.append(slider);
    }
    wrap.append(input);

    const fmt = (v) => String(prec === 0 ? Math.round(v) : Number(Number(v).toFixed(prec)));

    function sync(force) {
        const v = Number(w.value);
        if (force || document.activeElement !== input) input.value = fmt(v);
        if (slider && (force || document.activeElement !== slider)) slider.value = String(v);
    }
    function commit(raw) {
        let v = parseFloat(raw);
        if (!Number.isFinite(v)) { sync(true); return; }
        if (min !== undefined) v = Math.max(min, v);
        if (max !== undefined) v = Math.min(max, v);
        v = prec === 0 ? Math.round(v) : Number(v.toFixed(prec));
        setWidgetValue(node, w, v);
        sync(true);
    }
    input.addEventListener("change", () => commit(input.value));
    input.addEventListener("wheel", (e) => {
        if (document.activeElement !== input || input.disabled) return;
        e.preventDefault();
        const cur = parseFloat(input.value);
        commit((Number.isFinite(cur) ? cur : Number(w.value)) + (e.deltaY < 0 ? step : -step));
    }, { passive: false });
    if (slider) slider.addEventListener("input", () => commit(slider.value));

    bindings.push({ sync });
    sync(true);
    return wrap;
}

function makeControl(ref, kind, opts) {
    if (kind === "combo") return makeCombo(ref);
    if (kind === "toggle") return makeToggle(ref);
    return makeNumber(ref, kind === "strength", opts);
}

// ============================ panel DOM ======================================

let panel = null;
let body = null;
let visible = true;
let lastSig = null;

function row(parent, label, ref, kind, tip, opts) {
    const r = el("div", "nlp-row");
    const l = el("span", "nlp-label", label);
    if (tip) l.title = tip;
    r.append(l, ref ? makeControl(ref, kind, opts) : el("span", "nlp-na", "NA"));
    parent.append(r);
    return r;
}

function cell(label, ref, kind, opts) {
    const c = el("div", "nlp-cell");
    c.append(el("span", "nlp-label", label), ref ? makeControl(ref, kind, opts) : el("span", "nlp-na", "NA"));
    return c;
}

// Approximate output size from aspect ratio + megapixels (rounded to `multiple`).
function estimateSize(r) {
    const m = /(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)/.exec(String(r.aspect?.w.value ?? ""));
    const mp = Number(r.mp?.w.value);
    if (!m || !(mp > 0)) return "";
    const ar = Number(m[1]) / Number(m[2]);
    const mult = Math.max(1, Number(r.multiple?.w.value) || 1);
    const px = mp * 1e6;
    const rnd = (v) => Math.max(mult, Math.round(v / mult) * mult);
    return `\u2248 ${rnd(Math.sqrt(px * ar))} \u00D7 ${rnd(Math.sqrt(px / ar))}`;
}

// ---- item chrome: rename (double-click), remove (x), reorder (drag) ----
let dragging = null;
let armed = null;
window.addEventListener("mouseup", () => { if (armed) { armed.draggable = false; armed = null; } }, true);

function arm(item, handle) {
    handle.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        armed = item;
        item.draggable = true;
    });
    item.addEventListener("dragstart", (e) => {
        if (e.target !== item) return;
        dragging = item;
        item.classList.add("nlp-dragging");
        e.dataTransfer.effectAllowed = "move";
        try { e.dataTransfer.setData("text/plain", item.dataset.key); } catch {}
    });
    item.addEventListener("dragend", () => {
        item.draggable = false;
        armed = null;
        item.classList.remove("nlp-dragging");
        if (dragging !== item) return;
        dragging = null;
        const sec = item.parentElement;
        if (!sec?.dataset.sec) return;
        const keys = [...sec.querySelectorAll(":scope > .nlp-item")].map((e) => e.dataset.key);
        editCfg((c) => { c.order[sec.dataset.sec] = keys; });
    });
}

function wireSection(sec) {
    sec.addEventListener("dragover", (e) => {
        if (!dragging || dragging.parentElement !== sec) return;
        e.preventDefault();
        const others = [...sec.querySelectorAll(":scope > .nlp-item")].filter((x) => x !== dragging);
        const next = others.find((x) => {
            const r = x.getBoundingClientRect();
            return e.clientY < r.top + r.height / 2;
        });
        if (next) sec.insertBefore(dragging, next); else sec.append(dragging);
    });
    sec.addEventListener("drop", (e) => e.preventDefault());
}

function xBtn(key) {
    const b = el("span", "nlp-x", "\u00D7");
    b.title = "Remove from this panel (the Default button brings everything back)";
    b.addEventListener("click", (e) => {
        e.stopPropagation();
        editCfg((c) => { c.hidden[key] = true; });
    });
    return b;
}

// Single click = jump to the node, double click = rename. The jump is delayed a
// moment so a double click doesn't also fire it.
function nameEl(key, def, cls, node) {
    const sp = el("span", cls, readCfg().names[key] || def);
    sp.title = (node ? `${node.title || nodeType(node)}\n` : "")
        + "Click: go to node. Double-click: rename. Drag: reorder.";
    let timer = null;
    sp.addEventListener("click", (e) => {
        if (!node) return;
        e.stopPropagation();
        clearTimeout(timer);
        timer = setTimeout(() => { timer = null; focusNode(node); }, 250);
    });
    sp.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        clearTimeout(timer);
        timer = null;
        startRename(sp, key, def);
    });
    return sp;
}

function startRename(sp, key, def) {
    const inp = el("input", "nlp-rename");
    inp.type = "text";
    inp.value = sp.textContent;
    sp.replaceWith(inp);
    inp.focus();
    inp.select();
    let done = false;
    const finish = (save) => {
        if (done) return;
        done = true;
        const v = inp.value.trim();
        if (save) editCfg((c) => { if (v && v !== def) c.names[key] = v; else delete c.names[key]; });
        else rebuild();
    };
    inp.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(true);
        else if (e.key === "Escape") finish(false);
    });
    inp.addEventListener("keyup", (e) => e.stopPropagation());
    inp.addEventListener("blur", () => finish(true));
}

function modelRow(key, label, r) {
    const rw = el("div", "nlp-row nlp-item");
    rw.dataset.key = key;
    const l = nameEl(key, label, "nlp-label nlp-handle", r.node);
    arm(rw, l);
    rw.append(l, makeControl(r, "combo"), xBtn(key));
    return rw;
}

function cardShell(key, label, node) {
    const card = el("div", "nlp-card nlp-item");
    card.dataset.key = key;
    const head = el("div", "nlp-card-head");
    const grip = el("span", "nlp-grip nlp-handle");
    grip.title = "Drag to reorder";
    const name = nameEl(key, label, "nlp-card-name nlp-handle", node);
    const sub = el("span", "nlp-card-sub", node.title || nodeType(node));
    sub.title = "Click to jump to this node";
    sub.addEventListener("click", () => focusNode(node));
    arm(card, grip);
    arm(card, name);
    head.append(grip, name, sub, xBtn(key));
    card.append(head);
    return card;
}

function section(title, id) {
    const s = el("div", "nlp-section");
    s.dataset.sec = id;
    s.append(el("div", "nlp-section-title", title));
    body.append(s);
    wireSection(s);
    return s;
}

function fill(sec, id, items) {
    const ord = readCfg().order[id] || [];
    const idx = (k) => { const i = ord.indexOf(k); return i < 0 ? 1e6 : i; };
    items
        .map((it, n) => ({ it, n }))
        .sort((a, b) => idx(a.it.key) - idx(b.it.key) || a.n - b.n)
        .forEach(({ it }) => sec.append(it.build()));
}

function render(m) {
    bindings = [];
    body.textContent = "";

    const c = readCfg();
    let hiddenCount = 0;
    const keep = (list, kf) => list.filter((x) => {
        if (c.hidden[kf(x)]) { hiddenCount++; return false; }
        return true;
    });
    const K = {
        model: (r) => `m:${nkey(r.node)}:${r.w.name}`,
        smp: (s) => `smp:${nkey(s.node)}`,
        lora: (l) => `lora:${nkey(l.node)}:${l.name.w.name}`,
        res: (r) => `res:${nkey(r.node)}`,
        size: (r) => `size:${nkey(r.node)}`,
        dur: (r) => `dur:${nkey(r.node)}:${r.value.w.name}`,
    };
    const ckpt = keep(m.ckpt, K.model), clip = keep(m.clip, K.model), vae = keep(m.vae, K.model);
    const smps = keep(m.samplers, K.smp);
    const loras = keep(m.loras, K.lora);
    const res = keep(m.out.res, K.res), sizes = keep(m.out.sizes, K.size), durs = keep(m.out.durs, K.dur);
    hiddenNote.textContent = hiddenCount ? `${hiddenCount} hidden` : "";

    const total = ckpt.length + clip.length + vae.length + smps.length + loras.length
        + res.length + sizes.length + durs.length;
    if (!total) {
        body.append(el("div", "nlp-empty", hiddenCount
            ? "Everything is hidden. Press Default to bring it all back."
            : "Nothing to show yet: no loaders, samplers or LoRAs in this workflow."));
        return;
    }

    if (ckpt.length + clip.length + vae.length) {
        const items = [];
        const group = (label, refs) => refs.forEach((r, i) => {
            const key = K.model(r);
            items.push({ key, build: () => modelRow(key, refs.length > 1 ? `${label} ${i + 1}` : label, r) });
        });
        group("Checkpoint", ckpt);
        group("CLIP", clip);
        group("VAE", vae);
        fill(section("Models", "models"), "models", items);
    }

    if (res.length + sizes.length + durs.length) {
        const items = [];
        res.forEach((r) => {
            const key = K.res(r);
            items.push({ key, build: () => {
                const card = cardShell(key, "Resolution", r.node);
                row(card, "Aspect", r.aspect, "combo");
                const pair = el("div", "nlp-pair");
                pair.append(cell("MP", r.mp, "number", { prec: 2, step: 0.05 }));
                if (r.multiple) pair.append(cell("Mult", r.multiple, "number", { prec: 0, step: 8 }));
                card.append(pair);
                const est = el("div", "nlp-est");
                card.append(est);
                const upd = () => { const t = estimateSize(r); if (est.textContent !== t) est.textContent = t; };
                bindings.push({ sync: upd });
                upd();
                return card;
            } });
        });
        sizes.forEach((r) => {
            const key = K.size(r);
            items.push({ key, build: () => {
                const card = cardShell(key, "Size", r.node);
                const pair = el("div", "nlp-pair");
                pair.append(cell("W", r.width, "number", { prec: 0, step: 8 }), cell("H", r.height, "number", { prec: 0, step: 8 }));
                card.append(pair);
                return card;
            } });
        });
        durs.forEach((d) => {
            const key = K.dur(d);
            items.push({ key, build: () => {
                const card = cardShell(key, "Duration", d.node);
                row(card, "Seconds", d.value, "number", null, d.float ? { prec: 2, step: 0.5 } : { prec: 0, step: 1 });
                return card;
            } });
        });
        fill(section("Output", "output"), "output", items);
    }

    if (smps.length) {
        const items = smps.map((s, i) => {
            const key = K.smp(s);
            return { key, build: () => {
                const card = cardShell(key, smps.length > 1 ? `Sampler ${i + 1}` : "Sampler", s.node);
                const pair = el("div", "nlp-pair");
                pair.append(cell("Steps", s.steps, "number"), cell("CFG", s.cfg, "number"));
                card.append(pair);
                row(card, "Sampler", s.sampler, "combo");
                row(card, "Scheduler", s.scheduler, "combo");
                if (s.denoise) row(card, "Denoise", s.denoise, "number");
                return card;
            } };
        });
        fill(section(smps.length > 1 ? "Samplers" : "Sampler", "samplers"), "samplers", items);
    }

    if (loras.length) {
        const items = loras.map((l, i) => {
            const key = K.lora(l);
            return { key, build: () => {
                const card = cardShell(key, loras.length > 1 ? `LoRA ${i + 1}` : "LoRA", l.node);
                if (l.on) row(card, "On", l.on, "toggle").classList.add("nlp-keep");
                row(card, "File", l.name, "combo", l.node.title);
                if (l.strength) row(card, "Strength", l.strength, "strength");
                if (l.strengthClip) row(card, "Clip str.", l.strengthClip, "number");
                return card;
            } };
        });
        fill(section("LoRAs", "loras"), "loras", items);
    }
}

let errLogged = false;
function tick() {
    if (!panel || !visible) return;
    if (state.minimized) { placeLauncher(); return; }
    if (state.dock !== "float") applyLayout();   // follow sidebar / topbar changes
    if (state.collapsed || document.hidden) return;
    try {
        const m = buildModel();
        const sig = signature(m);
        if (sig !== lastSig) {
            lastSig = sig;
            render(m);
        } else {
            for (const b of bindings) b.sync(false);
        }
        errLogged = false;
    } catch (e) {
        if (!errLogged) { errLogged = true; console.error("nougan-live-panel: refresh failed", e); }
    }
}

// ============================ layout / docking ===============================

function canvasRect() {
    const el_ = document.querySelector(".graph-canvas-panel")
        || document.getElementById("graph-canvas-container")
        || document.getElementById("graph-canvas");
    if (el_) {
        const r = el_.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return r;
    }
    return { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
}

function topChromeBottom() {
    let b = 0;
    const sels = [".comfyui-body-top", ".topbar-container", ".workflow-tabs-container", ".workflow-tabs", ".actionbar-container"];
    for (const s of sels) {
        for (const e of document.querySelectorAll(s)) {
            const r = e.getBoundingClientRect();
            if (r.height > 0 && r.bottom < 200 && r.bottom > b) b = r.bottom;
        }
    }
    return b;
}

function clampFloat() {
    if (state.x == null) state.x = window.innerWidth - state.w - 24;
    state.x = Math.min(Math.max(state.x, -state.w + 80), window.innerWidth - 80);
    state.y = Math.min(Math.max(state.y, 0), window.innerHeight - 32);
}

function applyLayout() {
    if (!panel) return;
    const docked = state.dock !== "float";
    panel.classList.toggle("nlp-docked", docked);
    panel.classList.toggle("nlp-dock-left", state.dock === "left");
    panel.classList.toggle("nlp-dock-right", state.dock === "right");
    panel.classList.toggle("nlp-collapsed", state.collapsed);
    const s = panel.style;
    s.width = state.w + "px";
    if (docked) {
        const cr = canvasRect();
        s.top = (Math.max(cr.top, topChromeBottom()) + 4) + "px";
        s.bottom = state.collapsed ? "auto" : (window.innerHeight - cr.bottom + 4) + "px";
        s.height = "";
        if (state.dock === "left") { s.left = cr.left + "px"; s.right = "auto"; }
        else { s.right = (window.innerWidth - cr.right) + "px"; s.left = "auto"; }
    } else {
        clampFloat();
        s.left = state.x + "px";
        s.top = state.y + "px";
        s.right = "auto";
        s.bottom = "auto";
        s.height = (!state.collapsed && state.h) ? state.h + "px" : "";
    }
}

// ---- theme: applied as inline CSS variables on the panel, the launcher box and the menu ----
function applyTheme(target) {
    if (!target) return;
    const t = THEMES[state.theme] || THEMES.comfy;
    for (const [k, cssVar] of Object.entries(THEME_VARS)) {
        if (t[k]) target.style.setProperty(cssVar, t[k]);
        else target.style.removeProperty(cssVar);
    }
    target.style.colorScheme = t.scheme || "";
}
function applyThemeAll() {
    applyTheme(panel);
    applyTheme(launcher);
    applyTheme(themeMenu);
}

let themeMenu = null;
function closeThemeMenu() {
    if (!themeMenu) return;
    themeMenu.remove();
    themeMenu = null;
    document.removeEventListener("pointerdown", onMenuOutside, true);
    document.removeEventListener("keydown", onMenuKey, true);
}
function onMenuOutside(e) {
    if (themeMenu && !themeMenu.contains(e.target) && !e.target.closest?.(".nlp-theme-btn")) closeThemeMenu();
}
function onMenuKey(e) { if (e.key === "Escape") closeThemeMenu(); }

function openThemeMenu(anchor) {
    if (themeMenu) { closeThemeMenu(); return; }
    const menu = el("div", "nlp-menu");
    for (const [name, t] of Object.entries(THEMES)) {
        const item = el("div", "nlp-menu-item");
        item.append(el("span", "nlp-menu-check", state.theme === name ? "\u2713" : ""), el("span", null, t.label));
        if (t.bg) {
            const sw = el("span", "nlp-swatch");
            for (const c of [t.bg, t.card, t.accent, t.fg]) { const i = el("i"); i.style.background = c; sw.append(i); }
            item.append(sw);
        }
        item.addEventListener("click", () => {
            state.theme = name;
            saveState();
            closeThemeMenu();
            applyThemeAll();
        });
        menu.append(item);
    }
    document.body.append(menu);
    themeMenu = menu;
    applyTheme(menu);
    const r = anchor.getBoundingClientRect();
    menu.style.top = (r.bottom + 4) + "px";
    menu.style.left = Math.max(4, Math.min(r.left, window.innerWidth - menu.offsetWidth - 4)) + "px";
    document.addEventListener("pointerdown", onMenuOutside, true);
    document.addEventListener("keydown", onMenuKey, true);
}

// `visible` = the setting (extension enabled). `state.minimized` = shrunk to the launcher box.
let launcher = null;
function updateVisibility() {
    if (panel) panel.style.display = visible && !state.minimized ? "" : "none";
    if (launcher) launcher.style.display = visible && state.minimized ? "" : "none";
    if (visible && state.minimized) placeLauncher();
}
function setVisible(v) {
    visible = !!v;
    updateVisibility();
}
function placeLauncher() {
    if (!launcher) return;
    const cr = canvasRect();
    launcher.style.top = (Math.max(cr.top, topChromeBottom()) + 8) + "px";
    launcher.style.right = (window.innerWidth - cr.right + 10) + "px";
}

let footer = null, hiddenNote = null;

async function doReload(btn) {
    btn.textContent = "Reloading\u2026";
    btn.disabled = true;
    // same thing the "R" key does: rescan model / LoRA folders and refresh every combo list
    let ok = false;
    try { await app.extensionManager.command.execute("Comfy.RefreshNodeDefinitions"); ok = true; } catch {}
    if (!ok) { try { await app.refreshComboInNodes(); } catch (e) { console.warn("nougan-live-panel: reload failed", e); } }
    await loadLoraNames();
    rebuild();
    btn.disabled = false;
    btn.textContent = "Reloaded \u2713";
    setTimeout(() => { btn.textContent = "Reload"; }, 1500);
}

function createPanel() {
    panel = el("div", "nlp");
    panel.id = "nougan-live-panel";

    const header = el("div", "nlp-header");
    const mkBtn = (txt, title, fn) => {
        const b = el("span", "nlp-btn", txt);
        b.title = title;
        b.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
        return b;
    };
    const collapseBtn = mkBtn(state.collapsed ? "+" : "\u2212", "Collapse / expand", () => toggleCollapse());
    function toggleCollapse() {
        state.collapsed = !state.collapsed;
        collapseBtn.textContent = state.collapsed ? "+" : "\u2212";
        applyLayout();
        saveState();
        if (!state.collapsed) { lastSig = null; tick(); }
    }
    const dockBtn = mkBtn("\u21E5", "Dock: click to cycle right, left, floating (or drag to a canvas edge)", () => {
        state.dock = state.dock === "float" ? "right" : state.dock === "right" ? "left" : "float";
        applyLayout();
        saveState();
    });
    const hideBtn = mkBtn("\u00D7", "Minimize to a small box (click the box to bring the panel back)", () => {
        state.minimized = true;
        updateVisibility();
        saveState();
    });
    const themeBtn = mkBtn("\u25D0", "Visual presets (theme)", () => openThemeMenu(themeBtn));
    themeBtn.classList.add("nlp-theme-btn");
    header.append(el("span", "nlp-grip"), el("span", "nlp-title", "Automagic 2222: Live Panel"), el("span", "nlp-spacer"), themeBtn, dockBtn, collapseBtn, hideBtn);
    header.addEventListener("dblclick", (e) => { if (!e.target.closest(".nlp-btn")) toggleCollapse(); });

    body = el("div", "nlp-body");
    footer = el("div", "nlp-footer");
    hiddenNote = el("span", "nlp-hidden-note");
    const reloadBtn = el("button", "nlp-fbtn", "Reload");
    reloadBtn.type = "button";
    reloadBtn.title = 'Same as pressing "R" in ComfyUI: rescans model / LoRA folders and refreshes every list';
    reloadBtn.addEventListener("click", () => doReload(reloadBtn));
    const defBtn = el("button", "nlp-fbtn", "Default");
    defBtn.type = "button";
    defBtn.title = "Show everything again and clear all renames and custom ordering (click twice to confirm)";
    let armedTimer = null;
    defBtn.addEventListener("click", () => {
        if (!armedTimer) {
            defBtn.textContent = "Sure?";
            armedTimer = setTimeout(() => { defBtn.textContent = "Default"; armedTimer = null; }, 2500);
            return;
        }
        clearTimeout(armedTimer);
        armedTimer = null;
        defBtn.textContent = "Default";
        resetCfg();
    });
    footer.append(hiddenNote, el("span", "nlp-spacer"), reloadBtn, defBtn);
    panel.append(header, body, footer);
    document.body.appendChild(panel);

    launcher = el("div", "nlp-launcher", "\u2699 2222");
    launcher.title = "Show Automagic 2222: Live Panel";
    launcher.addEventListener("click", () => {
        state.minimized = false;
        updateVisibility();
        applyLayout();
        saveState();
        lastSig = null;
        tick();
    });
    document.body.appendChild(launcher);

    // ---- drag (floating) and edge snapping ----
    let drag = null;
    header.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || e.target.closest(".nlp-btn")) return;
        const r = panel.getBoundingClientRect();
        drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, sx: e.clientX, sy: e.clientY, moved: false };
        header.setPointerCapture(e.pointerId);
    });
    header.addEventListener("pointermove", (e) => {
        if (!drag) return;
        if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 5) return;
        drag.moved = true;
        if (state.dock !== "float") {
            state.dock = "float";
            drag.dx = Math.min(drag.dx, state.w - 24);
        }
        state.x = e.clientX - drag.dx;
        state.y = e.clientY - drag.dy;
        applyLayout();
    });
    const endDrag = (e) => {
        if (!drag) return;
        const moved = drag.moved;
        drag = null;
        try { header.releasePointerCapture(e.pointerId); } catch {}
        if (!moved) return;
        const r = panel.getBoundingClientRect();
        const cr = canvasRect();
        if (r.left < cr.left + 8) state.dock = "left";
        else if (r.right > cr.right - 8) state.dock = "right";
        applyLayout();
        saveState();
    };
    header.addEventListener("pointerup", endDrag);
    header.addEventListener("pointercancel", endDrag);

    // ---- persist native-resize size (floating only) ----
    if (typeof ResizeObserver !== "undefined") {
        new ResizeObserver(() => {
            if (state.dock !== "float" || state.collapsed) return;
            const w = parseFloat(panel.style.width);
            const h = parseFloat(panel.style.height);
            let changed = false;
            if (w && Math.abs(w - state.w) > 0.5) { state.w = w; changed = true; }
            if (Number.isFinite(h) && h > 0 && Math.abs(h - (state.h || 0)) > 0.5) { state.h = h; changed = true; }
            if (changed) saveState();
        }).observe(panel);
    }

    applyThemeAll();
    window.addEventListener("resize", () => { applyLayout(); placeLauncher(); });
    applyLayout();
    updateVisibility();
}

app.registerExtension({
    name: "nougan.LivePanel",
    settings: [{
        id: SETTING_ID,
        name: "Automagic 2222: Live Panel: enabled (off removes the panel and its box completely)",
        type: "boolean",
        defaultValue: true,
        onChange: (v) => setVisible(v !== false),
    }],
    async setup() {
        await cssLoaded;
        try { visible = app.ui.settings.getSettingValue(SETTING_ID) !== false; } catch {}
        createPanel();
        loadLoraNames();
        setInterval(loadLoraNames, 30000);
        setInterval(tick, POLL_MS);
        tick();
    },
});
