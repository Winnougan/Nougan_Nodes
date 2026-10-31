// Automagic 2222: Live Panel
//
// A floating, dockable panel that reads what is loaded in the current workflow
// (checkpoint, CLIP, VAE, every sampler, LoRAs) and lets you edit the values on
// the real nodes. No cables: it only reads and writes widget values.
//
// Extras: seed row (value, dice, fixed/increment/decrement/randomize) on every sampler,
// "pin any widget" (header pin button, or right-click a node), and a run bar with
// Queue / Stop, progress, queue count and a VRAM / RAM meter with per-run VRAM peak.
//
// Compare: drop any Preview / Save Image node on the panel (or right-click it, "Add to Compare")
// and it becomes an image source. Pick A and B, then wipe, fade, blink or diff them. Rename sources
// by double-click, x removes one.
//
// Drag & drop: grab any node (or subgraph node) by its title bar and release it over the panel.
// A node pins all its editable widgets; a subgraph node brings its group back. The node snaps back
// to where it was. Every pinned row / subgraph card has an x to take it out again.
//
// Subgraphs: every widget inside a subgraph that the panel does not already show (a Steps INT
// node, a prompt box, ...) gets its own card in the "Subgraphs" section. The subgraph, each node
// and each widget has an x. That only hides it in the panel (the real node is never touched),
// and Default brings everything back.
//
// Put this file and nougan_panel_preview.js in web/, and nougan_live_panel.css in web/css/.

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { createPanelPreview } from "./nougan_panel_preview.js";
import { createProgress } from "./nougan_panel_progress.js";

const STORAGE_KEY = "nougan_live_panel_state";
const SETTING_ID = "Nougan.LivePanel.Enabled";
const POLL_MS = 400;

// ---- Config: add widget names from your custom loaders here ----------------
const CHECKPOINT_WIDGETS = ["ckpt_name", "unet_name"];
const CLIP_WIDGETS = ["clip_name", "clip_name1", "clip_name2", "clip_name3", "clip_name4"];
const VAE_WIDGETS = ["vae_name"];
const EXCLUDE_TYPES = /save/i;   // skip saver nodes
const SG_SKIP_TYPES = /^(Note|MarkdownNote|Reroute)$/;   // Subgraphs card: nodes with nothing to edit
const GENERIC_WIDGET = /^(value|int|float|number|text|string|boolean|bool|val)$/i;   // such rows get the node title as label
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
    synthwave: { label: "Synthwave", scheme: "dark", bg: "#150f2e", card: "#1d1442", head: "#2a1a5e", input: "#0d0820", fg: "#f0e6ff", dim: "#9b7fd4", border: "#4a2d8f", accent: "#ff2bd6" },
    cyberpunk: { label: "Cyberpunk", scheme: "dark", bg: "#0b0b14", card: "#12121f", head: "#1a1a2e", input: "#06060c", fg: "#e8f6ff", dim: "#6b7fa3", border: "#00e5ff", accent: "#fcee0a" },
    dracula: { label: "Dracula", scheme: "dark", bg: "#282a36", card: "#2f3142", head: "#343746", input: "#1e1f29", fg: "#f8f8f2", dim: "#8e93b8", border: "#44475a", accent: "#bd93f9" },
    nord: { label: "Nord", scheme: "dark", bg: "#2e3440", card: "#353c4a", head: "#3b4252", input: "#242933", fg: "#d8dee9", dim: "#7b88a1", border: "#4c566a", accent: "#88c0d0" },
    solardark: { label: "Solarized Dark", scheme: "dark", bg: "#002b36", card: "#073642", head: "#0a4553", input: "#00212b", fg: "#93a1a1", dim: "#657b83", border: "#124e5c", accent: "#b58900" },
    solarlight: { label: "Solarized Light", scheme: "light", bg: "#fdf6e3", card: "#f5eed8", head: "#eee8d5", input: "#fffdf5", fg: "#586e75", dim: "#93a1a1", border: "#d3cbb0", accent: "#268bd2" },
    gruvbox: { label: "Gruvbox", scheme: "dark", bg: "#282828", card: "#32302f", head: "#3c3836", input: "#1d2021", fg: "#ebdbb2", dim: "#928374", border: "#504945", accent: "#fe8019" },
    monokai: { label: "Monokai", scheme: "dark", bg: "#272822", card: "#2f302a", head: "#3e3d32", input: "#1e1f1a", fg: "#f8f8f2", dim: "#908b73", border: "#49483e", accent: "#a6e22e" },
    tokyonight: { label: "Tokyo Night", scheme: "dark", bg: "#1a1b26", card: "#1f2335", head: "#24283b", input: "#16161e", fg: "#c0caf5", dim: "#6a73a3", border: "#2f334d", accent: "#7aa2f7" },
    catppuccin: { label: "Catppuccin Mocha", scheme: "dark", bg: "#1e1e2e", card: "#262637", head: "#313244", input: "#181825", fg: "#cdd6f4", dim: "#8087a8", border: "#45475a", accent: "#cba6f7" },
    midnight: { label: "Midnight Blue", scheme: "dark", bg: "#0a1128", card: "#101a3a", head: "#16224d", input: "#060b1c", fg: "#d6e4ff", dim: "#6f85b8", border: "#24366e", accent: "#4da3ff" },
    ocean: { label: "Ocean", scheme: "dark", bg: "#06232b", card: "#0a2f3a", head: "#0e3b48", input: "#041a20", fg: "#d0f4f2", dim: "#5fa5a8", border: "#14525e", accent: "#2ee6d6" },
    forest: { label: "Forest", scheme: "dark", bg: "#14201a", card: "#1b2b22", head: "#233628", input: "#0d1511", fg: "#d8ecd8", dim: "#7a9a82", border: "#2f4a39", accent: "#7bc47f" },
    sunset: { label: "Sunset", scheme: "dark", bg: "#2a1018", card: "#3a1822", head: "#4a2030", input: "#1d0a10", fg: "#ffe8d6", dim: "#c98a86", border: "#6b2e3e", accent: "#ff7a45" },
    mocha: { label: "Mocha", scheme: "dark", bg: "#211a17", card: "#2b221e", head: "#362b26", input: "#171210", fg: "#eadccf", dim: "#a38d7d", border: "#4a3a31", accent: "#d9a066" },
    amber: { label: "Amber Terminal", scheme: "dark", bg: "#0d0a00", card: "#161000", head: "#201700", input: "#080600", fg: "#ffb000", dim: "#a67500", border: "#4d3600", accent: "#ffcc33" },
    matrix: { label: "Matrix", scheme: "dark", bg: "#000a00", card: "#001400", head: "#002000", input: "#000500", fg: "#00ff41", dim: "#008f23", border: "#004d12", accent: "#00ff41" },
    vaporwave: { label: "Vaporwave", scheme: "dark", bg: "#1b1035", card: "#251548", head: "#321a5c", input: "#120a28", fg: "#ffd9f5", dim: "#c18fd9", border: "#5a2f8a", accent: "#01cdfe" },
    blood: { label: "Blood Moon", scheme: "dark", bg: "#140607", card: "#1d0a0c", head: "#290d10", input: "#0c0304", fg: "#f2d4d4", dim: "#a15d5d", border: "#4a1519", accent: "#e03a3e" },
    lavender: { label: "Lavender", scheme: "light", bg: "#f3eefc", card: "#e9e0f8", head: "#ddd0f3", input: "#faf7ff", fg: "#2d2147", dim: "#7a6a9e", border: "#c3b3e3", accent: "#7c4dff" },
    mint: { label: "Mint", scheme: "light", bg: "#eefaf4", card: "#e0f3ea", head: "#cfeadb", input: "#f7fffb", fg: "#12382a", dim: "#5b8a74", border: "#a9d6bf", accent: "#10b981" },
    sky: { label: "Sky", scheme: "light", bg: "#eef6ff", card: "#e1eefb", head: "#d0e4f8", input: "#f8fbff", fg: "#12304f", dim: "#5a7fa6", border: "#a9c9ea", accent: "#2b7de9" },
    peach: { label: "Peach", scheme: "light", bg: "#fff3ea", card: "#ffe9da", head: "#ffdcc6", input: "#fffaf5", fg: "#4a2a1a", dim: "#a3745a", border: "#f0bd9f", accent: "#ff6b35" },
    paper: { label: "Paper (mono)", scheme: "light", bg: "#fafafa", card: "#f0f0f0", head: "#e6e6e6", input: "#ffffff", fg: "#111111", dim: "#6b6b6b", border: "#c4c4c4", accent: "#111111" },
    hicontrast: { label: "High Contrast", scheme: "dark", bg: "#000000", card: "#0a0a0a", head: "#141414", input: "#000000", fg: "#ffffff", dim: "#bdbdbd", border: "#ffffff", accent: "#ffd400" },
};
const THEME_VARS = {
    bg: "--nlp-bg", card: "--nlp-card", head: "--nlp-head", input: "--nlp-input",
    fg: "--nlp-fg", dim: "--nlp-dim", border: "--nlp-border", accent: "--nlp-accent",
};

const state = Object.assign(
    { x: null, y: 70, w: 300, h: null, collapsed: false, dock: "float", minimized: false, theme: "comfy", preview: false, previewH: 260, progress: true, progressFx: "auto", cmpMode: "wipe", cmpPos: 50 },
    loadState()
);
if (!THEMES[state.theme]) state.theme = "comfy";
if (state.progressFx !== "dom") state.progressFx = "auto";
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
                seed: resolve(n, "seed") || resolve(n, "noise_seed"),
            };
        } else if (hasIn("sigmas") && hasIn("sampler")) {
            // SamplerCustom / SamplerCustomAdvanced: settings live on upstream nodes
            const guider = upstream(n, "guider");
            const smp = chase(n, "sampler", "sampler_name");
            const sig = chase(n, "sigmas", "steps");
            const noise = chase(n, "noise", "noise_seed");
            f = {
                steps: resolve(sig, "steps"),
                cfg: resolve(n, "cfg") || resolve(guider, "cfg") || resolve(guider, "cfg_conds"),
                sampler: resolve(smp, "sampler_name"),
                scheduler: resolve(sig, "scheduler"),
                denoise: resolve(sig, "denoise"),
                seed: resolve(n, "noise_seed") || resolve(noise, "noise_seed"),
            };
        }
        if (f) out.push({ node: n, ...f, seedCtl: seedControl(f.seed) });
    }
    out.sort((a, b) => Number(a.node.id) - Number(b.node.id));
    return out;
}

// The "control after generate" combo that sits next to a seed widget (fixed / increment /
// decrement / randomize). Primitive-style seed nodes carry their own copy.
function seedControl(ref) {
    if (!ref || ref.linked) return null;
    const ws = ref.node?.widgets || [];
    const i = ws.indexOf(ref.w);
    if (i < 0) return null;
    let c = ws[i + 1]?.name === "control_after_generate" ? ws[i + 1] : null;
    if (!c) c = ws.find((x) => x.name === "control_after_generate");
    return c ? { node: ref.node, w: c } : null;
}

// ---- pinned widgets ----
// Which control a pinned widget gets, or null when it can't be shown (buttons, images...).
function pinKind(ref) {
    const w = ref?.w;
    if (!w || w.hidden || w.name === "control_after_generate") return null;
    const t = String(w.type);
    if (t === "button" || t.startsWith("converted")) return null;
    if (t === "combo") return "combo";
    if (typeof w.value === "boolean" || t === "toggle") return "toggle";
    if (typeof w.value === "number" || t === "number" || t === "slider") {
        return /seed/i.test(w.name) && seedControl(ref) ? "seed" : "number";
    }
    if (typeof w.value === "string") {
        return (w.options?.multiline || t === "customtext" || w.inputEl?.tagName === "TEXTAREA") ? "textarea" : "text";
    }
    return null;
}
const isPinned = (node, name) =>
    (readCfg().pins || []).some((p) => p.k === nkey(node) && p.name === name);

function togglePin(node, name) {
    const k = nkey(node);
    editCfg((c) => {
        c.pins = c.pins || [];
        const i = c.pins.findIndex((p) => p.k === k && p.name === name);
        if (i >= 0) {
            c.pins.splice(i, 1);
            const key = `pin:${k}:${name}`;
            delete c.names[key];
            if (c.order.pins) c.order.pins = c.order.pins.filter((x) => x !== key);
        } else {
            c.pins.push({ k, name });
        }
    });
}

function collectPins(nodes) {
    const pins = readCfg().pins || [];
    const live = [];
    let missing = 0;
    if (!pins.length) return { live, missing };
    const byKey = new Map(nodes.map((n) => [nkey(n), n]));
    for (const p of pins) {
        const n = byKey.get(p.k);
        const ref = n ? resolve(n, p.name) : null;
        const kind = ref ? pinKind(ref) : null;
        if (!ref || !kind) { missing++; continue; }   // node deleted, bypassed or widget gone
        live.push({ key: `pin:${p.k}:${p.name}`, k: p.k, name: p.name, ref, kind });
    }
    return { live, missing };
}

// ---- subgraph contents ----
// Widgets already shown by another section (loaders, samplers, resolution, pins) or owned by a
// LoRA node are "claimed" and are not repeated in the Subgraphs section.
function claimedBy(m) {
    const W = new Set(), N = new Set();
    const add = (r) => { if (r?.w) W.add(r.w); };
    for (const k of ["ckpt", "clip", "vae"]) m[k].forEach(add);
    for (const s of m.samplers) {
        for (const k of ["steps", "cfg", "sampler", "scheduler", "denoise", "seed", "seedCtl"]) add(s[k]);
    }
    const hid = readCfg().hidden || {};
    for (const l of m.loras) {
        if (l.node.subgraph) {
            // a subgraph node that merely exposes lora_name / strength: claim only those widgets
            // (claiming the whole node hid every other promoted widget, e.g. turbo steps),
            // and let them fall through to the Subgraphs card if the LoRA card was x-ed
            if (hid[`lora:${nkey(l.node)}:${l.name?.w?.name}`]) continue;
            add(l.on); add(l.name); add(l.strength); add(l.strengthClip);
        } else N.add(l.node);
    }
    for (const r of m.out.res) { add(r.aspect); add(r.mp); add(r.multiple); }
    for (const r of m.out.sizes) { add(r.width); add(r.height); }
    for (const d of m.out.durs) add(d.value);
    for (const p of m.pins.live) add(p.ref);
    return { W, N };
}

function sgPath(S) {
    const parts = [];
    for (let n = S, i = 0; n && i < 6; i++) {
        parts.unshift(n.title || "Subgraph");
        n = n.graph ? subParent.get(n.graph) : null;
    }
    return parts.join(" \u203A ");
}

// One group per subgraph node: { key, node, path, nodes: [{ key, node, rows: [{ key, owner, ref, kind, name, label }] }] }.
// The subgraph node's own exposed widgets come first, then every active node inside it.
function collectSubgraphs(nodes, claim) {
    const groups = [];
    const seenW = new Set();
    for (const S of nodes) {
        const sg = S.subgraph;
        if (!sg) continue;

        // widgets promoted through "proxyWidgets" are copies of inner widgets, which are listed directly
        const proxied = [];
        try {
            const pw = S.properties?.proxyWidgets;
            if (Array.isArray(pw)) for (const e of pw) if (Array.isArray(e) && e[1]) proxied.push(String(e[1]));
        } catch {}
        const isProxy = (nm) => proxied.some((p) => nm === p || nm.endsWith(` ${p}`) || nm.endsWith(`.${p}`) || nm.endsWith(`:${p}`));

        const cand = [];
        for (const w of S.widgets || []) if (!isProxy(String(w.name))) cand.push({ node: S, w });
        for (const n of (sg._nodes || sg.nodes || [])) {
            if (!isActive(n) || n.subgraph) continue;      // nested subgraphs get their own group
            const t = nodeType(n);
            if (EXCLUDE_TYPES.test(t) || SG_SKIP_TYPES.test(t)) continue;
            for (const w of n.widgets || []) cand.push({ node: n, w });
        }

        const byNode = new Map();
        for (const { node, w } of cand) {
            const ref = resolve(node, w.name);
            if (!ref || ref.linked) continue;              // driven by a cable: nothing to edit here
            const owner = ref.node;
            if (owner !== S && owner.graph !== sg) continue;   // lives elsewhere, its own group lists it
            if (seenW.has(ref.w) || claim.W.has(ref.w) || claim.N.has(owner)) continue;
            const kind = pinKind(ref);
            if (!kind) continue;
            seenW.add(ref.w);
            const row = { key: `sgw:${nkey(owner)}:${ref.w.name}`, owner, ref, kind, name: ref.w.name, label: ref.w.label || ref.w.name };
            if (!byNode.has(owner)) byNode.set(owner, []);
            byNode.get(owner).push(row);
        }
        if (!byNode.size) continue;

        const list = [...byNode].map(([owner, rows]) => ({ key: `sgn:${nkey(owner)}`, node: owner, rows }));
        list.sort((a, b) => (a.node === S ? -1 : b.node === S ? 1 : Number(a.node.id) - Number(b.node.id)));
        groups.push({ key: `sg:${nkey(S)}`, node: S, path: sgPath(S), nodes: list });
    }
    groups.sort((a, b) => Number(a.node.id) - Number(b.node.id));
    return groups;
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

// Nougan Lora Loader: the whole stack lives in ONE string widget, `lora_data`:
//   {"loras":[{"on":true,"name":"x.safetensors","model":1,"clip":1,"split":false}, ...]}
// Each item gets the same widget-like proxies as the rgthree loader, but reads and
// writes go through JSON.parse / JSON.stringify on that one widget.
const nlProxyCache = new WeakMap();
function nouganLoraList(w) {
    if (typeof w.value !== "string") return null;
    try {
        const d = JSON.parse(w.value);
        return Array.isArray(d?.loras) ? d.loras : null;
    } catch { return null; }
}
function nouganLoraProxies(w, idx) {
    let arr = nlProxyCache.get(w);
    if (!arr) nlProxyCache.set(w, (arr = []));
    if (arr[idx]) return arr[idx];
    const field = (key, type, options, fallbackKey) => ({
        name: `${w.name}.${idx}.${key}`,
        type,
        options,
        get value() {
            const it = nouganLoraList(w)?.[idx];
            if (!it) return undefined;
            return it[key] ?? (fallbackKey ? it[fallbackKey] : undefined);
        },
        set value(x) {
            let d;
            try { d = JSON.parse(w.value); } catch { return; }
            if (!Array.isArray(d?.loras) || !d.loras[idx]) return;
            d.loras[idx] = { ...d.loras[idx], [key]: x };
            const s = JSON.stringify(d);
            w.value = s;
            // let the node's own UI know the stack changed
            try { w.callback?.(s); } catch (e) { console.warn("nougan-live-panel: lora_data callback failed", e); }
        },
    });
    const num = { min: -10, max: 10, precision: 2, step: 1 };
    arr[idx] = {
        on: field("on", "toggle", {}),
        lora: field("name", "combo", { values: () => loraNames }),
        strength: field("model", "number", num),
        strengthClip: field("clip", "number", num, "model"),
    };
    return arr[idx];
}

function collectLoras(nodes) {
    const out = [];
    for (const n of nodes) {
        if (EXCLUDE_TYPES.test(nodeType(n))) continue;
        for (const w of n.widgets || []) {
            // Nougan Lora Loader (JSON string in `lora_data`)
            if (w.name === "lora_data" || (typeof w.value === "string" && w.value.startsWith('{"loras"'))) {
                const list = nouganLoraList(w);
                if (list) {
                    list.forEach((it, idx) => {
                        const p = nouganLoraProxies(w, idx);
                        out.push({
                            node: n,
                            on: { node: n, w: p.on },
                            name: { node: n, w: p.lora },
                            strength: { node: n, w: p.strength },
                            strengthClip: it?.split ? { node: n, w: p.strengthClip } : null,
                        });
                    });
                    continue;
                }
            }
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

    const m = { ...loaders, samplers: collectSamplers(nodes), loras: collectLoras(nodes), out: collectOutput(nodes), pins: collectPins(nodes) };
    m.sub = collectSubgraphs(nodes, claimedBy(m));
    m.cmp = collectCompare(nodes);
    return m;
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
            ["steps", "cfg", "sampler", "scheduler", "denoise", "seed", "seedCtl"].map((k) => rsig(s[k])).join("/")).join(";"),
        m.loras.map((l) => `${l.node.id}:${rsig(l.on)}/${rsig(l.name)}/${rsig(l.strength)}/${rsig(l.strengthClip)}`).join(";"),
        m.out.res.map((r) => `${r.node.id}:${rsig(r.aspect)}/${rsig(r.mp)}/${rsig(r.multiple)}`).join(";"),
        m.out.sizes.map((r) => `${r.node.id}:${rsig(r.width)}/${rsig(r.height)}`).join(";"),
        m.out.durs.map((r) => `${r.node.id}:${rsig(r.value)}`).join(";"),
        m.pins.live.map((p) => `${p.key}:${rsig(p.ref)}:${p.kind}`).join(";") + `#${m.pins.missing}`,
        m.sub.map((g) => `${g.key}:` + g.nodes.map((nd) => `${nd.key}[` +
            nd.rows.map((r) => `${r.key}:${rsig(r.ref)}:${r.kind}`).join(",") + "]").join("")).join(";"),
        m.cmp.srcs.map((x) => `${x.k}:${x.node ? 1 : 0}`).join(","),
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
const EMPTY_CFG = { names: {}, hidden: {}, order: {}, pins: [], collapsed: {} };
const readCfg = () => app.graph?.extra?.nougan_live_panel || EMPTY_CFG;
function editCfg(fn) {
    const g = app.graph;
    if (!g) return;
    g.extra = g.extra || {};
    const c = g.extra.nougan_live_panel || (g.extra.nougan_live_panel = {});
    c.names = c.names || {}; c.hidden = c.hidden || {}; c.order = c.order || {}; c.pins = c.pins || []; c.collapsed = c.collapsed || {};
    fn(c);
    touchWorkflow();
    rebuild();
}
function resetCfg() {
    const g = app.graph;
    const cur = g?.extra?.nougan_live_panel;
    if (cur) {
        // pins are content, not layout: Default keeps them
        const pins = Array.isArray(cur.pins) ? cur.pins.slice() : [];
        const cmp = cur.cmp?.srcs?.length ? cur.cmp : null;
        if (pins.length || cmp) g.extra.nougan_live_panel = { names: {}, hidden: {}, order: {}, pins, ...(cmp ? { cmp } : {}) };
        else delete g.extra.nougan_live_panel;
        touchWorkflow();
    }
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

// ---- searchable dropdown (replaces the plain <select>) ----
// Click the field and type to filter. Every word you type has to match somewhere in the
// path (so "ltx ingr" finds "ltx-2.5-22b-ic-lora-ingredients"). Up/Down + Enter to pick,
// Esc to cancel. The list is a fixed-position popup on <body>, so the panel never clips it.
let comboList = null;   // { owner, close } for the one popup that can be open at a time
function closeComboList() { comboList?.close(); }
const normKey = (s) => String(s).toLowerCase().replace(/\\/g, "/");
const COMBO_MAX = 300;  // rows drawn at once; keep typing to narrow the rest

function makeCombo(ref) {
    const { node, w } = ref;
    const wrap = el("div", "nlp-combo");
    const input = el("input", "nlp-select");
    input.type = "text";
    input.spellcheck = false;
    input.autocomplete = "off";
    wrap.append(input);
    linkedHint(input, ref);
    let lastRaw = [];
    let justFocused = false;

    const getRaw = () => {
        const v = w.options?.values;
        const raw = (typeof v === "function" ? v(w, node) : v) || [];
        return Array.isArray(raw) ? raw : [];
    };

    function sync(force) {
        if (!force && document.activeElement === input) return;
        const cur = String(w.value);
        if (input.value !== cur) input.value = cur;
        if (!ref.linked) input.title = cur;
    }

    function open() {
        if (ref.linked || comboList?.owner === input) return;
        closeComboList();
        lastRaw = getRaw();
        const all = lastRaw.map(String);
        const keys = all.map(normKey);
        const cur = String(w.value);
        let typed = false, matches = [], hi = 0;

        const box = el("div", "nlp-menu nlp-combo-list");
        applyTheme(box);

        function filter() {
            const toks = typed ? normKey(input.value).split(/\s+/).filter(Boolean) : [];
            matches = [];
            for (let i = 0; i < all.length; i++) {
                if (toks.every((t) => keys[i].includes(t))) matches.push(i);
            }
        }
        const lastRow = () => Math.min(matches.length, COMBO_MAX) - 1;
        function setHi(n) {
            box.children[hi]?.classList.remove("nlp-active");
            hi = n;
            const c = box.children[hi];
            if (c) { c.classList.add("nlp-active"); c.scrollIntoView?.({ block: "nearest" }); }
        }
        function paint(resetHi) {
            filter();
            if (resetHi) hi = Math.max(0, typed ? 0 : matches.findIndex((i) => all[i] === cur));
            box.textContent = "";
            if (!matches.length) { box.append(el("div", "nlp-combo-note", "No matches")); return; }
            const shown = matches.slice(0, COMBO_MAX);
            shown.forEach((i, n) => {
                const str = all[i];
                const item = el("div", "nlp-combo-item"
                    + (n === hi ? " nlp-active" : "") + (str === cur ? " nlp-current" : ""));
                const cut = Math.max(str.lastIndexOf("/"), str.lastIndexOf("\\"));
                item.append(el("span", "nlp-combo-base", cut >= 0 ? str.slice(cut + 1) : str));
                if (cut >= 0) item.append(el("span", "nlp-combo-dir", str.slice(0, cut)));
                item.title = str;
                item.addEventListener("mousemove", () => { if (hi !== n) setHi(n); });
                item.addEventListener("click", () => pick(i));
                box.append(item);
            });
            if (matches.length > shown.length) {
                box.append(el("div", "nlp-combo-note", `${matches.length - shown.length} more, keep typing to narrow`));
            }
            box.children[hi]?.scrollIntoView?.({ block: "nearest" });
        }
        function place() {
            const r = input.getBoundingClientRect();
            const width = Math.min(Math.max(r.width, 260), window.innerWidth - 8);
            const left = Math.max(4, Math.min(r.left, window.innerWidth - width - 4));
            const below = window.innerHeight - r.bottom - 8;
            const above = r.top - 8;
            const up = below < 180 && above > below;
            const st = box.style;
            st.left = left + "px";
            st.width = width + "px";
            st.maxHeight = Math.max(120, Math.min(320, up ? above : below)) + "px";
            if (up) { st.top = "auto"; st.bottom = (window.innerHeight - r.top + 2) + "px"; }
            else { st.bottom = "auto"; st.top = (r.bottom + 2) + "px"; }
        }

        function pick(i) {
            const str = all[i];
            const orig = lastRaw.find((x) => String(x) === str);
            setWidgetValue(node, w, orig !== undefined ? orig : str);
            finish();
        }
        function finish() { close(); input.blur(); }
        function close() {
            input.removeEventListener("input", onInput);
            input.removeEventListener("keydown", onKey);
            input.removeEventListener("blur", close);
            window.removeEventListener("resize", close);
            document.removeEventListener("scroll", onScroll, true);
            box.remove();
            if (comboList?.owner === input) comboList = null;
            sync(true);
        }
        function onInput() { typed = true; paint(true); }
        function onScroll(e) { if (e.target !== box && !box.contains(e.target)) close(); }
        function onKey(e) {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault(); e.stopPropagation();
                if (lastRow() >= 0) setHi(e.key === "ArrowDown" ? Math.min(lastRow(), hi + 1) : Math.max(0, hi - 1));
            } else if (e.key === "Enter") {
                e.preventDefault(); e.stopPropagation();
                if (matches.length) pick(matches[hi]); else finish();
            } else if (e.key === "Escape") {
                e.preventDefault(); e.stopPropagation();
                finish();
            }
        }

        // keep focus in the text field while the mouse is over the list
        box.addEventListener("mousedown", (e) => e.preventDefault());
        input.addEventListener("input", onInput);
        input.addEventListener("keydown", onKey);
        input.addEventListener("blur", close);
        window.addEventListener("resize", close);
        document.addEventListener("scroll", onScroll, true);
        document.body.append(box);
        comboList = { owner: input, close };
        paint(true);
        place();
    }

    input.addEventListener("focus", () => { justFocused = true; open(); input.select(); });
    input.addEventListener("mouseup", (e) => { if (justFocused) { e.preventDefault(); justFocused = false; } });
    input.addEventListener("click", () => { if (comboList?.owner !== input) open(); });

    bindings.push({ sync });
    sync(true);
    return wrap;
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

    wrap.__sync = sync;
    bindings.push({ sync });
    sync(true);
    return wrap;
}

const SEED_MODES = ["fixed", "increment", "decrement", "randomize"];

function randomSeed(w) {
    const lo = Number.isFinite(w.options?.min) ? w.options.min : 0;
    const hi = Math.min(Number.isFinite(w.options?.max) ? w.options.max : 2 ** 50, 2 ** 50);
    return lo + Math.floor(Math.random() * Math.max(1, hi - lo));
}

// Seed value + dice + control-after-generate mode, in one row.
function makeSeed(ref, ctl) {
    const { node, w } = ref;
    const wrap = el("div", "nlp-seedwrap");
    const num = makeNumber(ref, false, { prec: 0, step: 1 });
    const dice = el("span", "nlp-btn nlp-dice", "\uD83C\uDFB2");
    dice.title = "Roll a new random seed";
    if (ref.linked) dice.classList.add("nlp-btn-off");
    dice.addEventListener("click", () => {
        if (ref.linked) return;
        setWidgetValue(node, w, randomSeed(w));
        num.__sync?.(true);
    });
    wrap.append(num, dice);

    if (ctl) {
        const sel = el("select", "nlp-select nlp-mode");
        sel.title = "Seed mode: what happens to the seed after each run";
        const raw = ctl.w.options?.values;
        const vals = (typeof raw === "function" ? raw(ctl.w, ctl.node) : raw);
        for (const v of (Array.isArray(vals) && vals.length ? vals : SEED_MODES)) sel.append(new Option(String(v), String(v)));
        sel.addEventListener("change", () => setWidgetValue(ctl.node, ctl.w, sel.value));
        const sync = (force) => {
            if (!force && document.activeElement === sel) return;
            const cur = String(ctl.w.value);
            if (sel.value !== cur) sel.value = cur;
        };
        bindings.push({ sync });
        sync(true);
        wrap.append(sel);
    }
    return wrap;
}

// Text widget: single-line input, or a textarea for multiline widgets (prompt boxes).
// Writes on every keystroke so you can hit Ctrl+Enter without leaving the box.
function makeText(ref, multiline) {
    const { node, w } = ref;
    const input = el(multiline ? "textarea" : "input", "nlp-text");
    if (multiline) input.rows = 3; else input.type = "text";
    input.spellcheck = false;
    linkedHint(input, ref);
    function sync(force) {
        if (!force && document.activeElement === input) return;
        const cur = w.value == null ? "" : String(w.value);
        if (input.value !== cur) input.value = cur;
    }
    input.addEventListener("input", () => {
        if (ref.linked) return;
        w.value = input.value;
        try { w.callback?.(input.value, app.canvas, node, app.canvas?.graph_mouse, undefined); }
        catch (e) { console.warn("nougan-live-panel: widget callback failed", e); }
        try { app.canvas?.setDirty?.(true, true); } catch {}
    });
    input.addEventListener("change", touchWorkflow);
    // keep typing away from ComfyUI hotkeys, but let Ctrl/Cmd+Enter through so it still queues
    const stop = (e) => { if (!((e.ctrlKey || e.metaKey) && e.key === "Enter")) e.stopPropagation(); };
    input.addEventListener("keydown", stop);
    input.addEventListener("keyup", stop);
    bindings.push({ sync });
    sync(true);
    return input;
}

function makeControl(ref, kind, opts) {
    if (kind === "combo") return makeCombo(ref);
    if (kind === "toggle") return makeToggle(ref);
    if (kind === "seed") return makeSeed(ref, opts?.ctl);
    if (kind === "text") return makeText(ref, false);
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

function xBtn(key, onClick, title) {
    const b = el("span", "nlp-x", "\u00D7");
    b.title = title || "Remove from this panel (the Default button brings everything back)";
    b.addEventListener("click", (e) => {
        e.stopPropagation();
        if (onClick) onClick();
        else editCfg((c) => { c.hidden[key] = true; });
    });
    return b;
}

// One widget: a normal row, or label-over-textarea for multiline text, with an x on the far right.
// onX = null means "hide it in the panel" (the default x); pins pass their own unpin handler.
function widgetItem(key, label, ref, kind, onX, xTitle, opts = {}) {
    const drag = opts.drag !== false;
    const x = xBtn(key, onX, xTitle);
    if (kind === "textarea") {
        const it = el("div", "nlp-item nlp-textitem");
        it.dataset.key = key;
        const head = el("div", "nlp-texthead");
        const l = nameEl(key, label, "nlp-label" + (drag ? " nlp-handle" : ""), ref.node, !drag);
        if (drag) arm(it, l);
        head.append(l, x);
        it.append(head, makeText(ref, true));
        return it;
    }
    const rw = el("div", "nlp-row nlp-item");
    rw.dataset.key = key;
    const l = nameEl(key, label, "nlp-label" + (drag ? " nlp-handle" : ""), ref.node, !drag);
    if (drag) arm(rw, l);
    const ctl = kind === "seed" ? { ctl: seedControl(ref) } : undefined;
    rw.append(l, makeControl(ref, kind, ctl), x);
    return rw;
}

// One pinned widget.
function pinItem(p, label) {
    const key = p.key;
    const unpin = () => editCfg((c) => {
        c.pins = (c.pins || []).filter((x) => !(x.k === p.k && x.name === p.name));
        delete c.names[key];
        if (c.order.pins) c.order.pins = c.order.pins.filter((x) => x !== key);
    });
    return widgetItem(key, label, p.ref, p.kind, unpin, "Unpin from this panel");
}

// Single click = jump to the node, double click = rename. The jump is delayed a
// moment so a double click doesn't also fire it.
function nameEl(key, def, cls, node, noDrag) {
    const sp = el("span", cls, readCfg().names[key] || def);
    sp.title = (node ? `${node.title || nodeType(node)}\n` : "")
        + (noDrag ? "Click: go to node. Double-click: rename." : "Click: go to node. Double-click: rename. Drag: reorder.");
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

// One subgraph: header (drag, collapse, rename, x), then its nodes and their widgets.
function sgCard(g) {
    const collapsed = !!readCfg().collapsed?.[g.key];
    const count = g.nodes.reduce((a, nd) => a + nd.rows.length, 0);
    const card = el("div", "nlp-sg nlp-item");
    card.dataset.key = g.key;
    const head = el("div", "nlp-card-head");
    const grip = el("span", "nlp-grip nlp-handle");
    grip.title = "Drag to reorder";
    const chev = el("span", "nlp-btn nlp-sg-chev", collapsed ? "\u25B8" : "\u25BE");
    chev.title = collapsed ? "Expand" : "Collapse";
    chev.addEventListener("click", (e) => {
        e.stopPropagation();
        editCfg((c) => { if (c.collapsed[g.key]) delete c.collapsed[g.key]; else c.collapsed[g.key] = true; });
    });
    const name = nameEl(g.key, g.path, "nlp-card-name nlp-handle", g.node);
    const sub = el("span", "nlp-card-sub", `${count} widget${count === 1 ? "" : "s"}`);
    sub.title = "Click to jump to this subgraph node";
    sub.addEventListener("click", () => focusNode(g.node));
    arm(card, grip);
    arm(card, name);
    head.append(grip, chev, name, sub, xBtn(g.key, null, "Remove this whole subgraph from the panel (the Default button brings it back)"));
    card.append(head);
    if (collapsed) return card;

    const title = (n) => (n === g.node ? "Exposed inputs" : (n.title || nodeType(n)));
    for (const nd of g.nodes) {
        const multi = nd.rows.length > 1;
        if (multi) {
            const nh = el("div", "nlp-sg-node");
            nh.append(
                nameEl(nd.key, title(nd.node), "nlp-label", nd.node, true),
                xBtn(nd.key, null, "Remove all of this node's widgets from the panel (the Default button brings them back)"),
            );
            card.append(nh);
        }
        for (const r of nd.rows) {
            // a lone generic "value" widget is labelled by its node ("Turbo Steps"), not "value"
            const label = !multi && GENERIC_WIDGET.test(r.name) ? title(r.owner) : r.label;
            card.append(widgetItem(r.key, label, r.ref, r.kind, null, null, { drag: false }));
        }
    }
    return card;
}

function render(m) {
    closeComboList();
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
    const pinned = m.pins.live;
    // subgraphs: group > node > widget, each level can be removed (hidden) on its own
    const subs = [];
    for (const g of m.sub) {
        if (c.hidden[g.key]) { hiddenCount++; continue; }
        const nodes = [];
        for (const nd of g.nodes) {
            if (c.hidden[nd.key]) { hiddenCount++; continue; }
            const rows = nd.rows.filter((r) => {
                if (c.hidden[r.key]) { hiddenCount++; return false; }
                return true;
            });
            if (rows.length) nodes.push({ ...nd, rows });
        }
        if (nodes.length) subs.push({ ...g, nodes });
    }
    const subRows = subs.reduce((a, g) => a + g.nodes.reduce((b, nd) => b + nd.rows.length, 0), 0);
    const note = [];
    if (hiddenCount) note.push(`${hiddenCount} hidden`);
    if (m.pins.missing) note.push(`${m.pins.missing} pin${m.pins.missing > 1 ? "s" : ""} off`);
    hiddenNote.textContent = note.join(" \u00B7 ");
    hiddenNote.title = m.pins.missing
        ? "Some pinned widgets are not shown: their node was deleted, bypassed or muted"
        : "";

    const total = ckpt.length + clip.length + vae.length + smps.length + loras.length
        + res.length + sizes.length + durs.length + pinned.length + subRows + m.cmp.srcs.length;
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
                if (s.seed) row(card, "Seed", s.seed, "seed", null, { ctl: s.seedCtl });
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

    if (pinned.length) {
        const count = {};
        for (const p of pinned) count[p.name] = (count[p.name] || 0) + 1;
        const items = pinned.map((p) => {
            const label = count[p.name] > 1 ? `${p.name} #${p.ref.node.id}` : p.name;
            return { key: p.key, build: () => pinItem(p, label) };
        });
        fill(section("Pinned", "pins"), "pins", items);
    }

    if (m.cmp.srcs.length) fill(section("Compare", "cmp"), "cmp", [{ key: "cmp", build: () => cmpCard(m.cmp) }]);

    if (subs.length) {
        const items = subs.map((g) => ({ key: g.key, build: () => sgCard(g) }));
        fill(section("Subgraphs", "subgraphs"), "subgraphs", items);
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
    menu.append(el("div", "nlp-menu-sep"), el("div", "nlp-menu-label", "Progress bar"));
    const opt = (label, on, note, fn) => {
        const item = el("div", "nlp-menu-item");
        item.append(el("span", "nlp-menu-check", on ? "\u2713" : ""), el("span", null, label));
        if (note) item.append(el("span", "nlp-menu-note", note));
        item.addEventListener("click", () => { fn(); saveState(); closeThemeMenu(); });
        menu.append(item);
    };
    opt("Show progress bar", state.progress, "", () => { state.progress = !state.progress; syncProgress(); });
    opt("WebGPU effects", state.progressFx === "auto", `now: ${progress?.renderer() || "dom"}`, () => {
        state.progressFx = state.progressFx === "auto" ? "dom" : "auto";
        progress?.setFx(state.progressFx);
    });
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
    syncPreview();
    syncProgress();
}

// The preview only listens (and decodes frames) while it is switched on AND the panel
// is actually showing. Collapsed, minimized or disabled = no listener, no memory.
let preview = null, previewBtn = null;
function syncPreview() {
    const on = !!state.preview && visible && !state.minimized && !state.collapsed;
    preview?.setEnabled(on);
    previewBtn?.classList.toggle("nlp-btn-on", !!state.preview);
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
        syncPreview();
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
    previewBtn = mkBtn("\u25B6", "Live preview on/off (mirrors Model Preview Override from KJNodes)", () => {
        state.preview = !state.preview;
        saveState();
        syncPreview();
    });
    const pinBtn = mkBtn("\uD83D\uDCCC", "Pin widgets from the selected node(s) to this panel", () => {
        if (popMenu) { closePopMenu(); return; }
        const r = pinBtn.getBoundingClientRect();
        const sel = selectedNodes();
        showPopMenu(sel.length ? pinMenuItems(sel)
            : [{ label: "Select a node on the canvas first", disabled: true }], r.left, r.bottom + 4);
    });
    pinBtn.classList.add("nlp-pin-btn");
    header.append(el("span", "nlp-grip"), el("span", "nlp-title", "Automagic 2222: Live Panel"), el("span", "nlp-spacer"), previewBtn, pinBtn, themeBtn, dockBtn, collapseBtn, hideBtn);

    preview = createPanelPreview({
        height: state.previewH,
        onResize: (h) => { state.previewH = Math.round(h); saveState(); },
    });
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
    defBtn.title = "Show everything again and clear all renames and custom ordering. Pins stay. (click twice to confirm)";
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
    panel.append(header, buildRunBar(), preview.host, body, footer);
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
    updateVisibility();   // also starts the preview if it was left on
}

// ============================ pin menu =======================================

function nodeByKey(k) {
    return collectNodes(app.graph).find((n) => nkey(n) === k) || null;
}

function selectedNodes() {
    const c = app.canvas;
    let list = [];
    try { list = [...(c?.selectedItems || [])]; } catch {}
    if (!list.length) { try { list = Object.values(c?.selected_nodes || {}); } catch {} }
    return list.filter((n) => n && Array.isArray(n.widgets)).slice(0, 4);
}

function pinMenuItems(nodes) {
    const items = [];
    for (const n of nodes) {
        const ws = (n.widgets || []).filter((w) => pinKind({ node: n, w }));
        if (!ws.length) continue;
        items.push({ head: n.title || nodeType(n) });
        for (const w of ws) {
            items.push({
                label: w.label || w.name,
                checked: () => isPinned(n, w.name),
                onClick: () => togglePin(n, w.name),
            });
        }
    }
    if (!items.length) items.push({ label: "No pinnable widgets on this node", disabled: true });
    return items;
}

let popMenu = null;
function closePopMenu() {
    if (!popMenu) return;
    popMenu.remove();
    popMenu = null;
    document.removeEventListener("pointerdown", onPopOutside, true);
    document.removeEventListener("keydown", onPopKey, true);
}
function onPopOutside(e) {
    if (popMenu && !popMenu.contains(e.target) && !e.target.closest?.(".nlp-pin-btn")) closePopMenu();
}
function onPopKey(e) { if (e.key === "Escape") closePopMenu(); }

// items: { head } | { label, checked?: () => bool, onClick?, disabled? }. Stays open after a
// click so you can pin several widgets in a row; Esc or a click elsewhere closes it.
function showPopMenu(items, x, y) {
    closePopMenu();
    closeThemeMenu();
    const menu = el("div", "nlp-menu nlp-popmenu");
    const paints = [];
    for (const it of items) {
        if (it.head) { menu.append(el("div", "nlp-menu-head", it.head)); continue; }
        const r = el("div", "nlp-menu-item" + (it.disabled ? " nlp-disabled" : ""));
        const chk = el("span", "nlp-menu-check", "");
        r.append(chk, el("span", null, it.label));
        const paint = () => { chk.textContent = it.checked?.() ? "\u2713" : ""; };
        paint();
        paints.push(paint);
        if (!it.disabled) r.addEventListener("click", () => { it.onClick?.(); paints.forEach((f) => f()); });
        menu.append(r);
    }
    document.body.append(menu);
    popMenu = menu;
    applyTheme(menu);
    menu.style.left = Math.max(4, Math.min(x, window.innerWidth - menu.offsetWidth - 4)) + "px";
    menu.style.top = Math.max(4, Math.min(y, window.innerHeight - menu.offsetHeight - 4)) + "px";
    document.addEventListener("pointerdown", onPopOutside, true);
    document.addEventListener("keydown", onPopKey, true);
}

// Node right-click menu: pin the widget under the cursor, or pick from the node's widgets.
// Needs a frontend that supports the getNodeMenuItems hook; the header pin button always works.
function nodeMenuItems(node) {
    try {
        let hover = null;
        try {
            const gm = app.canvas?.graph_mouse;
            const hw = gm && node.getWidgetOnPos ? node.getWidgetOnPos(gm[0], gm[1]) : null;
            if (hw && pinKind({ node, w: hw })) hover = hw;
        } catch {}
        const any = (node.widgets || []).some((w) => pinKind({ node, w }));
        const img = isImageNode(node);
        if (!hover && !any && !img) return [];
        const out = [null];
        if (hover) {
            const on = isPinned(node, hover.name);
            out.push({
                content: `${on ? "Unpin" : "Pin"} \u201C${hover.label || hover.name}\u201D ${on ? "from" : "to"} Live Panel`,
                callback: () => togglePin(node, hover.name),
            });
        }
        if (any) {
            out.push({
                content: "Pin widgets to Live Panel\u2026",
                callback: (_v, _o, e) => showPopMenu(pinMenuItems([node]), e?.clientX ?? 120, e?.clientY ?? 120),
            });
        }
        if (img) out.push({ content: "Add to Compare (Live Panel)", callback: () => { cmpAdd(node); toast(`Added \u201C${node.title || nodeType(node)}\u201D to Compare`); } });
        return out;
    } catch { return []; }
}

// ============================ image compare ===================================
// Sources are image-output nodes (Preview Image, Save Image, ...). Their latest image is read from
// app.nodeOutputs (or node.imgs), so the viewer follows every run on its own.

const CMP_MODES = { wipe: "Wipe", fade: "Fade", diff: "Difference", blink: "Blink" };
const CMP_LABEL = { wipe: "Divider", fade: "Mix", diff: "Gain", blink: "Click view" };
const CMP_TYPE = /(preview|save|compare).*image|image.*(preview|save|compare)|^LoadImage/i;

// id used by app.nodeOutputs: "parent:child" for nodes inside subgraphs
function execId(node) {
    const ids = [node.id];
    for (let g = node.graph, i = 0; g && subParent.has(g) && i < 8; i++) {
        const p = subParent.get(g);
        ids.unshift(p.id);
        g = p.graph;
    }
    return ids.join(":");
}

function nodeImageUrl(node) {
    try {
        const out = app.nodeOutputs?.[execId(node)] || app.nodeOutputs?.[String(node.id)];
        const im = out?.images?.[0];
        if (im?.filename) {
            const q = new URLSearchParams({ filename: im.filename, type: im.type || "output", subfolder: im.subfolder || "" });
            return api.apiURL(`/view?${q}`);
        }
        const img = node.imgs?.[0];
        if (img?.src) return img.src;
    } catch {}
    return null;
}

const isImageNode = (node) => !!node && (!!nodeImageUrl(node) || CMP_TYPE.test(nodeType(node)));
const isPlainPreview = (node) => !(node.widgets || []).some((w) => pinKind({ node, w }));

function cmpAdd(node) {
    const k = nkey(node);
    editCfg((c) => {
        const cm = c.cmp = c.cmp || { srcs: [], a: null, b: null };
        if (!cm.srcs.includes(k)) cm.srcs.push(k);
        if (cm.a === k || cm.b === k) return;
        if (!cm.a) cm.a = k; else cm.b = k;     // first drop is A, the next is B, later ones replace B
    });
}

function cmpRemove(k) {
    editCfg((c) => {
        const cm = c.cmp;
        if (!cm) return;
        cm.srcs = cm.srcs.filter((x) => x !== k);
        delete c.names[`cmp:${k}`];
        if (cm.a === k) cm.a = null;
        if (cm.b === k) cm.b = null;
        const free = cm.srcs.filter((x) => x !== cm.a && x !== cm.b);
        if (!cm.a && free.length) cm.a = free.shift();
        if (!cm.b && free.length) cm.b = free.shift();
        if (!cm.srcs.length) delete c.cmp;
    });
}

function cmpSetSlot(slot, k) {
    editCfg((c) => {
        const cm = c.cmp;
        if (!cm) return;
        const other = slot === "a" ? "b" : "a";
        if (cm[other] === k) cm[other] = cm[slot];   // swap
        cm[slot] = k;
    });
}

function collectCompare(nodes) {
    const cm = readCfg().cmp;
    if (!cm?.srcs?.length) return { srcs: [], a: null, b: null };
    const byKey = new Map(nodes.map((n) => [nkey(n), n]));
    return { a: cm.a, b: cm.b, srcs: cm.srcs.map((k) => ({ k, node: byKey.get(k) || null })) };
}

function cmpCard(cm) {
    const card = el("div", "nlp-card nlp-item nlp-cmp");
    card.dataset.key = "cmp";

    const head = el("div", "nlp-card-head");
    const grip = el("span", "nlp-grip nlp-handle");
    grip.title = "Drag to reorder";
    const title = nameEl("cmp", "Compare", "nlp-card-name nlp-handle", null);
    arm(card, grip);
    arm(card, title);
    const mode = el("select", "nlp-select nlp-mode");
    for (const [k, l] of Object.entries(CMP_MODES)) {
        const o = el("option", null, l);
        o.value = k;
        mode.append(o);
    }
    mode.value = CMP_MODES[state.cmpMode] ? state.cmpMode : "wipe";
    const clear = xBtn("cmp", () => editCfg((c) => {
        delete c.cmp;
        for (const k of Object.keys(c.names)) if (k.startsWith("cmp:")) delete c.names[k];
    }), "Remove Compare and all its sources");
    head.append(grip, title, el("span", "nlp-spacer"), mode, clear);

    // ---- viewer ----
    const view = el("div", "nlp-cmp-view");
    const imgB = el("img", "nlp-cmp-img");
    const imgA = el("img", "nlp-cmp-img");
    imgA.draggable = imgB.draggable = false;
    const line = el("div", "nlp-cmp-line");
    const tagA = el("span", "nlp-cmp-tag nlp-cmp-taga");
    const tagB = el("span", "nlp-cmp-tag nlp-cmp-tagb");
    const empty = el("div", "nlp-cmp-empty");
    view.append(imgB, imgA, line, tagA, tagB, empty);

    // ---- slider row ----
    const sr = el("div", "nlp-row");
    const slLabel = el("span", "nlp-label");
    const rng = el("input");
    rng.type = "range"; rng.min = "0"; rng.max = "100"; rng.step = "0.5";
    rng.value = String(state.cmpPos);
    rng.style.accentColor = "var(--nlp-accent)";
    sr.append(slLabel, rng);

    // ---- sources ----
    const list = el("div", "nlp-cmp-list");
    const find = (k) => cm.srcs.find((s) => s.k === k) || null;
    const defName = (s) => s.node ? `${s.node.title || nodeType(s.node)} #${s.node.id}` : `${s.k} (node off)`;
    const nameFor = (s) => (s && (readCfg().names[`cmp:${s.k}`] || defName(s))) || "";
    for (const s of cm.srcs) {
        const rw = el("div", "nlp-cmp-src" + (s.node ? "" : " nlp-off"));
        const bA = el("span", "nlp-cmp-ab" + (cm.a === s.k ? " nlp-on" : ""), "A");
        const bB = el("span", "nlp-cmp-ab" + (cm.b === s.k ? " nlp-on" : ""), "B");
        bA.title = "Use as image A"; bB.title = "Use as image B";
        bA.addEventListener("click", () => cmpSetSlot("a", s.k));
        bB.addEventListener("click", () => cmpSetSlot("b", s.k));
        rw.append(bA, bB, nameEl(`cmp:${s.k}`, defName(s), "nlp-label", s.node), xBtn(`cmp:${s.k}`, () => cmpRemove(s.k), "Remove from Compare"));
        list.append(rw);
    }
    list.append(el("div", "nlp-hint", "Drop an image node on the panel to add one. Double-click a name to rename."));

    // ---- painting ----
    let urlA = null, urlB = null, blinkA = true;
    const paint = () => {
        const m = mode.value, pos = Math.max(0, Math.min(100, Number(state.cmpPos) || 0));
        imgA.style.cssText = "";
        view.style.filter = "";
        line.style.display = "none";
        if (m === "wipe") {
            imgA.style.clipPath = `inset(0 ${100 - pos}% 0 0)`;
            line.style.display = "block";
            line.style.left = pos + "%";
        } else if (m === "fade") {
            imgA.style.opacity = String(pos / 100);
        } else if (m === "diff") {
            imgA.style.mixBlendMode = "difference";
            view.style.filter = `brightness(${(1 + (pos / 100) * 9).toFixed(2)})`;
        } else {
            imgA.style.opacity = blinkA ? "1" : "0";
        }
        view.style.cursor = m === "blink" ? "pointer" : "ew-resize";
        slLabel.textContent = CMP_LABEL[m];
        rng.disabled = m === "blink";
        tagA.style.opacity = m === "blink" && !blinkA ? "0.35" : "1";
        tagB.style.opacity = m === "blink" && blinkA ? "0.35" : "1";
    };
    const sync = () => {
        const sa = find(cm.a), sb = find(cm.b);
        const ua = sa?.node ? nodeImageUrl(sa.node) : null;
        const ub = sb?.node ? nodeImageUrl(sb.node) : null;
        if (ua !== urlA) { urlA = ua; if (ua) imgA.src = ua; else imgA.removeAttribute("src"); }
        if (ub !== urlB) { urlB = ub; if (ub) imgB.src = ub; else imgB.removeAttribute("src"); }
        imgA.style.visibility = ua ? "" : "hidden";
        imgB.style.visibility = ub ? "" : "hidden";
        tagA.textContent = "A \u00B7 " + nameFor(sa);
        tagB.textContent = "B \u00B7 " + nameFor(sb);
        empty.textContent = !cm.a || !cm.b ? "Pick A and B below"
            : (!ua || !ub) ? "Run the workflow to fill both images" : "";
        paint();
    };
    const fit = (img) => img.addEventListener("load", () => {
        if (img.naturalWidth && (img === imgA || !imgA.naturalWidth)) view.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`;
    });
    fit(imgA); fit(imgB);

    mode.addEventListener("change", () => { state.cmpMode = mode.value; saveState(); paint(); });
    rng.addEventListener("input", () => { state.cmpPos = Number(rng.value); saveState(); paint(); });
    rng.addEventListener("keydown", (e) => e.stopPropagation());

    let down = false;
    const setFromEvent = (e) => {
        const r = view.getBoundingClientRect();
        state.cmpPos = Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width) * 100));
        rng.value = String(state.cmpPos);
        paint();
    };
    view.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        if (mode.value === "blink") { blinkA = !blinkA; paint(); return; }
        down = true;
        try { view.setPointerCapture(e.pointerId); } catch {}
        setFromEvent(e);
    });
    view.addEventListener("pointermove", (e) => { if (down) setFromEvent(e); });
    const up = () => { if (down) { down = false; saveState(); } };
    view.addEventListener("pointerup", up);
    view.addEventListener("pointercancel", up);

    card.append(head, view, sr, list);
    bindings.push({ sync });
    sync();
    return card;
}

// ============================ drag a node onto the panel ======================
// Canvas nodes are not DOM elements, so there is no native HTML5 drag from them. Instead we watch
// the title-bar drag LiteGraph already does: pointerdown on a node title, pointermove past a small
// threshold, and if the pointer is released over the panel the node is "dropped" into it, then it
// snaps back to where it was. A normal node drop = pin every editable widget on it. A subgraph
// node = un-hide its group (and every node / widget in it) in the Subgraphs section.

const DROP = { node: null, start: null, origin: null, moved: false, hot: false };

function overPanel(e) {
    if (!panel || !panel.isConnected || !visible) return false;
    const r = panel.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
}

function titleHit(e) {
    try {
        const c = app.canvas;
        if (!c?.graph || e.button !== 0) return null;
        const cr = c.canvas.getBoundingClientRect();
        if (e.clientX < cr.left || e.clientX > cr.right || e.clientY < cr.top || e.clientY > cr.bottom) return null;
        const [gx, gy] = c.convertEventToCanvasOffset(e);
        const n = c.graph.getNodeOnPos(gx, gy);
        if (!n || gy >= n.pos[1]) return null;     // only the title bar, not widgets / body
        return n;
    } catch { return null; }
}

function setDropHot(on) {
    if (DROP.hot === on) return;
    DROP.hot = on;
    panel?.classList.toggle("nlp-drop-hot", on);
}

function toast(msg) {
    try { app.extensionManager?.toast?.add({ severity: "info", summary: "Live Panel", detail: msg, life: 2500 }); } catch {}
}

function pinNodeWidgets(n) {
    const ws = (n.widgets || []).filter((w) => pinKind({ node: n, w }));
    if (!ws.length) { toast(`\u201C${n.title || nodeType(n)}\u201D has nothing editable`); return; }
    let added = 0;
    for (const w of ws) if (!isPinned(n, w.name)) { togglePin(n, w.name); added++; }
    rebuild();
    toast(added ? `Pinned ${added} widget${added > 1 ? "s" : ""} from \u201C${n.title || nodeType(n)}\u201D`
                : `\u201C${n.title || nodeType(n)}\u201D is already in the panel`);
}

function dropNode(n, ev, single) {
    // subgraph: bring its whole group back
    if (n.subgraph) {
        const prefixes = [`sg:${nkey(n)}`];
        for (const inner of (n.subgraph._nodes || n.subgraph.nodes || [])) {
            prefixes.push(`sgn:${nkey(inner)}`, `sgw:${nkey(inner)}:`);
        }
        prefixes.push(`sgw:${nkey(n)}:`);
        editCfg((c) => {
            for (const k of Object.keys(c.hidden)) {
                if (prefixes.some((p) => k === p || (p.endsWith(":") && k.startsWith(p)))) delete c.hidden[k];
            }
        });
        rebuild();
        toast(`Subgraph \u201C${n.title || "Subgraph"}\u201D added`);
        return;
    }
    // image nodes go to Compare; ones that also have widgets (SaveImage, LoadImage) ask first
    if (isImageNode(n)) {
        const name = n.title || nodeType(n);
        const toCompare = () => { closePopMenu(); cmpAdd(n); toast(`Added \u201C${name}\u201D to Compare`); };
        if (!isPlainPreview(n) && single && ev) {
            showPopMenu([
                { head: name },
                { label: "Add to Compare", onClick: toCompare },
                { label: "Pin its widgets", onClick: () => { closePopMenu(); pinNodeWidgets(n); } },
            ], ev.clientX, ev.clientY);
            return;
        }
        toCompare();
        return;
    }
    pinNodeWidgets(n);
}

function setupNodeDrop() {
    window.addEventListener("pointerdown", (e) => {
        DROP.node = titleHit(e);
        DROP.moved = false;
        if (DROP.node) { DROP.start = [e.clientX, e.clientY]; DROP.origin = DROP.node.pos.slice(); }
    }, true);

    window.addEventListener("pointermove", (e) => {
        if (!DROP.node) return;
        if (!DROP.moved) {
            if (Math.hypot(e.clientX - DROP.start[0], e.clientY - DROP.start[1]) < 8) return;
            DROP.moved = true;
        }
        setDropHot(overPanel(e));
    }, true);

    const end = (e) => {
        const n = DROP.node;
        const hot = DROP.moved && n && e.type === "pointerup" && overPanel(e);
        DROP.node = null;
        setDropHot(false);
        if (!hot) return;
        // put the dragged node(s) back so they don't end up buried under the panel
        try {
            const dx = n.pos[0] - DROP.origin[0], dy = n.pos[1] - DROP.origin[1];
            const group = new Set([n, ...selectedNodesAll()]);
            for (const m of group) { m.pos[0] -= dx; m.pos[1] -= dy; }
            app.canvas.setDirty(true, true);
        } catch {}
        const picked = [...new Set([n, ...selectedNodesAll()])];
        for (const m of picked) dropNode(m, e, picked.length === 1);
    };
    window.addEventListener("pointerup", end, true);
    window.addEventListener("pointercancel", end, true);
}

function selectedNodesAll() {
    const c = app.canvas;
    let list = [];
    try { list = [...(c?.selectedItems || [])]; } catch {}
    if (!list.length) { try { list = Object.values(c?.selected_nodes || {}); } catch {} }
    return list.filter((n) => n && Array.isArray(n.widgets));
}

// ============================ run feedback ===================================
// Queue / Stop, progress of the node that is running, queue count, and a VRAM / RAM meter
// from /system_stats. The tick on the VRAM bar marks the highest use seen during the last run.

const run = { running: false, peak: 0 };
let stats = null;
let runEls = null;
let progress = null;   // nougan_panel_progress.js: label, step n/N, ETA, queue depth, WebGPU or DOM bar

async function doQueue() {
    try { await app.extensionManager.command.execute("Comfy.QueuePrompt"); return; } catch {}
    try { await app.queuePrompt(0, 1); } catch (e) { console.warn("nougan-live-panel: queue failed", e); }
}
async function doInterrupt() {
    try { await app.extensionManager.command.execute("Comfy.Interrupt"); return; } catch {}
    try { await api.interrupt(); } catch (e) { console.warn("nougan-live-panel: interrupt failed", e); }
}

function buildRunBar() {
    const host = el("div", "nlp-run");
    const top = el("div", "nlp-run-top");
    const qBtn = el("button", "nlp-fbtn nlp-runbtn", "\u25B6 Queue");
    qBtn.type = "button";
    qBtn.title = "Queue the workflow (same as the Run button)";
    qBtn.addEventListener("click", doQueue);
    const sBtn = el("button", "nlp-fbtn nlp-runbtn", "\u25A0 Stop");
    sBtn.type = "button";
    sBtn.title = "Interrupt the running generation";
    sBtn.addEventListener("click", doInterrupt);
    top.append(qBtn, sBtn);

    progress = createProgress({ fx: state.progressFx });

    const meters = el("div", "nlp-meters");
    const mk = (name) => {
        const m = el("div", "nlp-meter");
        const t = el("span", "nlp-meter-text", name);
        const b = el("div", "nlp-bar nlp-bar-thin");
        const f = el("i");
        const pk = el("i", "nlp-peak");
        b.append(f, pk);
        m.append(t, b);
        m.style.display = "none";
        return { m, t, b, f, pk };
    };
    const vram = mk("VRAM"), ram = mk("RAM");
    meters.append(vram.m, ram.m);

    host.append(top, progress.el, meters);
    runEls = { vram, ram };
    return host;
}

// the progress module only listens while it is switched on AND the panel is showing
function syncProgress() {
    progress?.setEnabled(!!state.progress && visible && !state.minimized);
}

const GB = 1073741824;
function paintMeter(m, name, total, free, peak) {
    if (!total) { m.m.style.display = "none"; return; }
    m.m.style.display = "";
    const used = Math.max(0, total - free);
    const pct = Math.min(100, used / total * 100);
    const s = `${name} ${(used / GB).toFixed(1)}/${(total / GB).toFixed(1)} GB`;
    if (m.t.textContent !== s) m.t.textContent = s;
    m.f.style.width = pct + "%";
    m.b.classList.toggle("nlp-hot", pct > 90);
    if (peak > 0) {
        m.pk.style.display = "";
        m.pk.style.left = Math.min(100, peak / total * 100) + "%";
    } else m.pk.style.display = "none";
    m.m.title = peak > 0 ? `Peak during the last run: ${(peak / GB).toFixed(1)} GB` : "";
}

function paintRun() {
    if (!runEls || !stats) return;
    paintMeter(runEls.vram, "VRAM", stats.vramT, stats.vramF, run.peak);
    paintMeter(runEls.ram, "RAM", stats.ramT, stats.ramF, 0);
}

// only tracks "is a run active" (for faster VRAM polling + peak); the progress module does the rest
function hookRunEvents() {
    const on = (name, fn) => { try { api.addEventListener(name, fn); } catch {} };
    on("execution_start", () => { run.running = true; run.peak = 0; pollStats(); });
    for (const n of ["execution_success", "execution_error", "execution_interrupted"]) {
        on(n, () => { run.running = false; });
    }
}

let statsTimer = null, statsBusy = false;
async function pollStats() {
    clearTimeout(statsTimer);
    if (statsBusy) return;                // the call in flight reschedules itself
    statsBusy = true;
    try {
        if (panel && visible && !state.minimized && !document.hidden) {
            const r = await api.fetchApi("/system_stats");
            const j = await r.json();
            const d = (j.devices || []).find((x) => x.type !== "cpu");
            const sys = j.system || {};
            stats = { vramT: d?.vram_total || 0, vramF: d?.vram_free || 0, ramT: sys.ram_total || 0, ramF: sys.ram_free || 0 };
            if (run.running && stats.vramT) run.peak = Math.max(run.peak, stats.vramT - stats.vramF);
            paintRun();
        }
    } catch {}
    statsBusy = false;
    statsTimer = setTimeout(pollStats, run.running ? 1000 : 4000);
}

// ---- Queue-time fix for the Nougan Lora Loader ------------------------------
// The panel writes the stack into the node's `lora_data` widget. If the node's own
// JS re-serializes from a private copy of the stack, the queued prompt can carry
// the OLD stack and the panel's On/Off never reaches the run. Right after the
// prompt is built, put the widget's current value into it.
function patchPromptLoras(res) {
    const out = res?.output;
    if (!out || !app.graph) return;
    for (const n of collectNodes(app.graph)) {
        const w = n.widgets?.find((x) => x.name === "lora_data");
        if (!w) continue;                      // match by widget, not by class name
        const entry = out[String(n.id)];
        if (!entry || !entry.inputs || typeof entry.inputs.lora_data !== "string") continue;
        const cur = typeof w.value === "string" ? w.value
            : (w.value && typeof w.value === "object" ? JSON.stringify(w.value) : null);
        if (cur == null) continue;
        if (entry.inputs.lora_data !== cur) {
            console.warn(`nougan-live-panel: node ${n.id} queued a stale lora_data, using the widget value instead`);
            entry.inputs.lora_data = cur;
        }
    }
}
function hookGraphToPrompt() {
    if (app.__nouganGtpHooked || typeof app.graphToPrompt !== "function") return;
    app.__nouganGtpHooked = true;
    const orig = app.graphToPrompt;
    app.graphToPrompt = async function (...args) {
        const res = await orig.apply(this, args);
        try { patchPromptLoras(res); } catch (e) { console.warn("nougan-live-panel: prompt patch failed", e); }
        return res;
    };
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
    getNodeMenuItems(node) { return nodeMenuItems(node); },
    async setup() {
        await cssLoaded;
        try { visible = app.ui.settings.getSettingValue(SETTING_ID) !== false; } catch {}
        hookGraphToPrompt();
        createPanel();
        setupNodeDrop();
        hookRunEvents();
        pollStats();
        loadLoraNames();
        setInterval(loadLoraNames, 30000);
        setInterval(tick, POLL_MS);
        tick();
    },
});
