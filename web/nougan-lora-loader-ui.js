// nougan-lora-loader-ui.js  — clean from-scratch frontend for the Nougan Lora Loader
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_NAME  = "NouganLoraLoader";
const MULTI_NAME = "NouganLoraLoaderMulti";
const ALL = [NODE_NAME, MULTI_NAME];
const DATA = "lora_data";
const COLOR = "#1a2a3a", BGCOLOR = "#0f1923", WIDTH = 460;
const PROP = "Nougan Lora Folders";     // node property: null | {folders:[...]}
const FAV_KEY = "nougan_lora_favorites";
const ROOT = "(root)";

// ── favourites ────────────────────────────────────────────────────────────
const loadFav = () => { try { return new Set(JSON.parse(localStorage.getItem(FAV_KEY) || "[]")); } catch { return new Set(); } };
const saveFav = (s) => { try { localStorage.setItem(FAV_KEY, JSON.stringify([...s])); } catch {} };

// ── lora list + folder helpers ─────────────────────────────────────────────
let _cache = null;
async function loras(force = false) {
    if (_cache == null || force) {
        try {
            const r = await api.fetchApi("/nougan/loras");
            const j = await r.json();
            _cache = (j || []).map(e => typeof e === "string" ? e : e?.name).filter(Boolean);
        } catch (e) { console.warn("[Nougan Lora] list fetch failed", e); _cache = _cache || []; }
    }
    return _cache;
}
const folderOf = (f) => { const n = String(f).replaceAll("\\", "/"); const i = n.lastIndexOf("/"); return i < 0 ? ROOT : n.slice(0, i); };
const baseOf   = (f) => { const n = String(f).replaceAll("\\", "/"); return n.slice(n.lastIndexOf("/") + 1); };
const foldersOf = (files) => [...new Set(files.map(folderOf))].sort((a, b) => a === ROOT ? -1 : b === ROOT ? 1 : a.localeCompare(b, undefined, { sensitivity: "base" }));

// ── enabled-folder resolution ──────────────────────────────────────────────
function enabledSet(node) {
    const v = node.properties?.[PROP];
    if (v == null) return null;                       // null = all folders
    return Array.isArray(v?.folders) ? new Set(v.folders) : null;
}
function setEnabled(node, setOrNull) {
    node.properties = node.properties || {};
    node.properties[PROP] = setOrNull == null ? null : { folders: [...setOrNull].sort() };
    sync(node); node.__nllBtn?.(); node.setDirtyCanvas(true, true);
}

// ── styles ─────────────────────────────────────────────────────────────────
let _styled = false;
function styles() {
    if (_styled) return; _styled = true;
    const s = document.createElement("style");
    s.textContent = `
     .nll-pop{position:fixed;z-index:10020;display:flex;flex-direction:column;max-height:70vh;
       background:var(--comfy-menu-bg,#202020);color:var(--fg-color,#ddd);
       border:1px solid var(--border-color,#4e4e4e);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.6);
       font:12px 'Inter',Arial,sans-serif;user-select:none;min-width:300px;max-width:92vw}
     .nll-pop *{box-sizing:border-box}
     .nll-hd{display:flex;align-items:center;gap:6px;padding:7px 10px;border-bottom:1px solid var(--border-color,#444);font-weight:700}
     .nll-hd .t{flex:1}.nll-x{cursor:pointer;opacity:.7;padding:0 4px}.nll-x:hover{opacity:1}
     .nll-search{padding:6px 8px;border-bottom:1px solid var(--border-color,#333)}
     .nll-search input{width:100%;padding:5px 8px;background:var(--comfy-input-bg,#2a2a2a);color:inherit;
       border:1px solid var(--border-color,#555);border-radius:4px;font:inherit;outline:none}
     .nll-search input:focus{border-color:#7eb8ff}
     .nll-list{overflow:auto;flex:1;padding:3px 0}
     .nll-item{display:flex;align-items:center;gap:6px;padding:4px 9px;cursor:pointer;border-radius:4px;margin:0 4px}
     .nll-item:hover{background:rgba(255,255,255,.08)}
     .nll-star{flex:none;width:20px;text-align:center;font-size:15px;line-height:1;cursor:pointer;transition:transform .12s}
     .nll-star.off{opacity:.3}.nll-star.off:hover{opacity:.7}.nll-star.on{color:#f5c518}.nll-star.on:hover{transform:scale(1.25)}
     .nll-nm{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
     .nll-dir{opacity:.45;font-size:11px}
     .nll-sep{margin:5px 10px;border:none;border-top:1px solid var(--border-color,#3a3a3a)}
     .nll-empty{padding:12px;opacity:.6}
     .nll-acts{display:flex;gap:6px;padding:6px 8px;border-bottom:1px solid var(--border-color,#444)}
     .nll-btn{cursor:pointer;padding:3px 10px;border-radius:4px;border:1px solid var(--border-color,#555);
       background:var(--comfy-input-bg,#2a2a2a);color:inherit;font:inherit}.nll-btn:hover{filter:brightness(1.3)}
     .nll-tree{overflow:auto;padding:4px 8px 8px}
     .nll-frow{display:flex;align-items:center;gap:6px;padding:2px;border-radius:3px}.nll-frow:hover{background:rgba(255,255,255,.06)}
     .nll-frow input{margin:0;cursor:pointer}.nll-frow .nm{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer}.nll-frow .ct{opacity:.5}
     .nll-row{display:flex;align-items:center;gap:4px;background:rgba(255,255,255,.04);border-radius:5px;padding:3px 6px}
     .nll-row .nm{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer}
     .nll-row .nm.off{opacity:.45;text-decoration:line-through}
     .nll-row .ph{opacity:.5;font-style:italic}.nll-row .dir{opacity:.45;font-size:11px}.nll-row .fn{font-weight:700}
     .nll-ic{flex:none;cursor:pointer;opacity:.75;min-width:20px;text-align:center;font-size:14px;line-height:1}.nll-ic:hover{opacity:1}
     .nll-num{width:52px;flex:none;background:var(--comfy-input-bg,#2a2a2a);color:inherit;
       border:1px solid var(--border-color,#555);border-radius:3px;font:inherit;text-align:center;padding:1px 3px}.nll-num:disabled{opacity:.35}
    `;
    document.head.appendChild(s);
}

// ── popup placement ────────────────────────────────────────────────────────
let _open = null;
function closePop() { if (_open) { _open.dispose(); _open = null; } }
function place(el, ev) {
    document.body.appendChild(el);
    const x = ev?.clientX ?? innerWidth / 2, y = ev?.clientY ?? innerHeight / 3;
    const r = el.getBoundingClientRect();
    el.style.left = Math.max(8, Math.min(x, innerWidth - r.width - 8)) + "px";
    el.style.top  = Math.max(8, Math.min(y + 6, innerHeight - r.height - 8)) + "px";
    const pd = e => { if (!el.contains(e.target)) closePop(); };
    const kd = e => { if (e.key === "Escape") closePop(); };
    setTimeout(() => { addEventListener("pointerdown", pd, true); addEventListener("keydown", kd, true); }, 0);
    _open = { dispose() { removeEventListener("pointerdown", pd, true); removeEventListener("keydown", kd, true); el.remove(); } };
}

// ── chooser (search + favourites + folder filter) ──────────────────────────
async function chooser(node, ev, onPick) {
    closePop(); styles();
    const files = await loras(true);
    const es = enabledSet(node);
    const pool = es == null ? files : files.filter(f => es.has(folderOf(f)));
    const favs = loadFav();
    const el = document.createElement("div"); el.className = "nll-pop"; el.style.width = "420px";
    el.innerHTML = `<div class="nll-hd"><span class="t">Choose a LoRA</span><span class="nll-x">✕</span></div>
      <div class="nll-search"><input placeholder="Filter LoRAs…" spellcheck="false"></div><div class="nll-list"></div>`;
    el.querySelector(".nll-x").onclick = closePop;
    const input = el.querySelector("input"), list = el.querySelector(".nll-list");
    input.addEventListener("pointerdown", e => e.stopPropagation());
    const alph = (a, b) => a.localeCompare(b, undefined, { sensitivity: "base" });
    function render(q = "") {
        list.textContent = "";
        const ql = q.trim().toLowerCase();
        const vis = ql ? pool.filter(f => f.toLowerCase().includes(ql)) : pool.slice();
        if (!vis.length) { const e = document.createElement("div"); e.className = "nll-empty";
            e.textContent = pool.length ? "No matches." : "No LoRAs in enabled folders — use 📁 Folders."; list.appendChild(e); return; }
        const fav = vis.filter(f => favs.has(f)).sort(alph), rest = vis.filter(f => !favs.has(f)).sort(alph);
        const item = (p) => {
            const row = document.createElement("div"); row.className = "nll-item";
            const on = favs.has(p); const star = document.createElement("span");
            star.className = "nll-star " + (on ? "on" : "off"); star.textContent = on ? "★" : "☆";
            star.onclick = (e) => { e.stopPropagation(); on ? favs.delete(p) : favs.add(p); saveFav(favs); render(input.value); };
            row.appendChild(star);
            const nm = document.createElement("span"); nm.className = "nll-nm";
            const d = folderOf(p); if (d !== ROOT) { const ds = document.createElement("span"); ds.className = "nll-dir"; ds.textContent = d + "/"; nm.appendChild(ds); }
            const fs = document.createElement("span"); fs.textContent = baseOf(p); nm.appendChild(fs); nm.title = p; row.appendChild(nm);
            row.onclick = () => { onPick(p); node.setDirtyCanvas(true, true); closePop(); };
            return row;
        };
        fav.forEach(p => list.appendChild(item(p)));
        if (fav.length && rest.length) { const hr = document.createElement("hr"); hr.className = "nll-sep"; list.appendChild(hr); }
        rest.forEach(p => list.appendChild(item(p)));
    }
    render(); input.oninput = () => render(input.value);
    place(el, ev); setTimeout(() => input.focus(), 30);
}

// ── folder filter panel (flat multi-select) ────────────────────────────────
async function folderPanel(node, ev) {
    closePop(); styles();
    const files = await loras(true);
    const all = foldersOf(files);
    const counts = {}; files.forEach(f => { const d = folderOf(f); counts[d] = (counts[d] || 0) + 1; });
    const el = document.createElement("div"); el.className = "nll-pop";
    el.innerHTML = `<div class="nll-hd"><span class="t">LoRA folder filter</span><span class="nll-x">✕</span></div>
      <div class="nll-acts"></div><div class="nll-tree"></div>`;
    el.querySelector(".nll-x").onclick = closePop;
    const acts = el.querySelector(".nll-acts"), tree = el.querySelector(".nll-tree");
    const mk = (t, fn) => { const b = document.createElement("button"); b.className = "nll-btn"; b.textContent = t; b.onclick = fn; acts.appendChild(b); };
    const cur = () => enabledSet(node);
    mk("All", () => { setEnabled(node, null); draw(); });
    mk("None", () => { setEnabled(node, new Set()); draw(); });
    function draw() {
        tree.textContent = "";
        if (!all.length) { const e = document.createElement("div"); e.className = "nll-empty"; e.textContent = "No LoRAs in models/loras."; tree.appendChild(e); return; }
        const set = cur(), allOn = set == null;
        all.forEach(f => {
            const row = document.createElement("div"); row.className = "nll-frow";
            const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = allOn || set.has(f);
            const toggle = () => { const s = cur() ?? new Set(all); cb.checked ? s.delete(f) : s.add(f); setEnabled(node, s.size === all.length ? null : s); draw(); };
            cb.onclick = (e) => { e.preventDefault(); toggle(); }; row.appendChild(cb);
            const nm = document.createElement("span"); nm.className = "nm"; nm.textContent = f; nm.title = f; nm.onclick = toggle; row.appendChild(nm);
            const ct = document.createElement("span"); ct.className = "ct"; ct.textContent = `(${counts[f] || 0})`; row.appendChild(ct);
            tree.appendChild(row);
        });
    }
    draw(); place(el, ev);
}

// ── data sync + widget hiding ──────────────────────────────────────────────
const dataW = (n) => n.widgets?.find(w => w.name === DATA);
function hideWidget(w) {
    if (!w) return;
    const el = w.element || w.inputEl;
    if (el) { el.style.display = "none"; el.style.height = "0"; el.style.pointerEvents = "none"; }
    if (w._nllHidden) return; w._nllHidden = true;
    w.computeSize = () => [0, -4]; w.draw = () => {};
}
function sync(node) {
    const w = dataW(node); if (!w) return;
    const v = node.properties?.[PROP];
    w.value = JSON.stringify({ loras: node.__stack || [], enabledFolders: (v && Array.isArray(v.folders)) ? v.folders : null });
}
function loadStack(node) {
    const w = dataW(node); let stack = [];
    try {
        const p = JSON.parse(w?.value || "{}");
        const entries = Array.isArray(p) ? p : (p.loras || []);
        stack = entries.filter(e => e && (e.name || e.lora || e.random)).map(e => {
            const s = e.strength != null ? Number(e.strength) : Number(e.model ?? 1);
            const o = { on: e.on !== false, name: e.name || e.lora || "", model: s, clip: e.clip != null && e.strength == null ? Number(e.clip) : s };
            if (e.random) { o.random = true; o.locked = !!e.locked; o.autoRoll = !!e.autoRoll; o.folders = Array.isArray(e.folders) ? e.folders : null; }
            return o;
        });
    } catch { stack = []; }
    node.__stack = stack;
}

// ── randomizer ─────────────────────────────────────────────────────────────
async function pickRandom(node, entry) {
    const files = await loras(true);
    const es = enabledSet(node);
    let allowed = es == null ? new Set(foldersOf(files)) : es;
    if (Array.isArray(entry.folders)) allowed = new Set(entry.folders.filter(f => allowed.has(f)));
    const pool = files.filter(f => allowed.has(folderOf(f)));
    if (!pool.length) return null;
    if (entry.name && pool.length > 1) { const o = pool.filter(f => f !== entry.name); return o[Math.floor(Math.random() * o.length)]; }
    return pool[Math.floor(Math.random() * pool.length)];
}

// ── stack row editor ───────────────────────────────────────────────────────
function rows(node) {
    styles();
    const root = document.createElement("div");
    root.style.cssText = "display:flex;flex-direction:column;gap:3px;width:100%;box-sizing:border-box;padding:2px 0;font:12px 'Inter',Arial,sans-serif;color:var(--fg-color,#ddd)";
    const num = (v, fn) => { const i = document.createElement("input"); i.type = "number"; i.step = "0.05"; i.value = String(v); i.className = "nll-num";
        i.onchange = () => fn(parseFloat(i.value)); i.addEventListener("pointerdown", e => e.stopPropagation()); return i; };
    const ic = (t, tip, col, fn) => { const b = document.createElement("span"); b.className = "nll-ic"; b.textContent = t; if (col) b.style.color = col; b.title = tip;
        b.onclick = () => fn(); b.addEventListener("pointerdown", e => e.stopPropagation()); return b; };
    const commit = () => { sync(node); render(); snap(node); node.setDirtyCanvas(true, true); };
    function render() {
        root.textContent = "";
        const st = node.__stack || [];
        if (!st.length) { const e = document.createElement("div"); e.style.cssText = "opacity:.55;padding:4px 2px"; e.textContent = "No LoRAs yet — click ➕ Add LoRA."; root.appendChild(e); return; }
        st.forEach((en, idx) => {
            const row = document.createElement("div"); row.className = "nll-row";
            const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = en.on; cb.title = "Enable / disable"; cb.style.flex = "none";
            cb.onchange = () => { en.on = cb.checked; commit(); }; cb.addEventListener("pointerdown", e => e.stopPropagation()); row.appendChild(cb);
            if (en.random) {
                const dice = ic("🎲", "Roll a random LoRA", null, async () => { if (en.locked) return; const p = await pickRandom(node, en); if (p != null) { en.name = p; commit(); } });
                if (en.locked) dice.style.opacity = ".3"; row.appendChild(dice);
                const lock = ic(en.locked ? "🔒" : "🔓", en.locked ? "Unlock this line" : "Lock this line", null, () => { en.locked = !en.locked; if (en.locked) en.autoRoll = false; commit(); });
                if (en.locked) { lock.style.background = "rgba(239,83,80,.22)"; lock.style.borderRadius = "4px"; lock.style.opacity = "1"; } else lock.style.opacity = ".4";
                row.appendChild(lock);
                const ar = ic("🔄", "Auto-roll every queue", null, () => { if (en.locked) return; en.autoRoll = !en.autoRoll; commit(); });
                ar.style.opacity = (en.autoRoll && !en.locked) ? "1" : ".3"; row.appendChild(ar);
            }
            const nameEl = document.createElement("span"); nameEl.className = "nm" + (en.on ? "" : " off");
            if (!en.name) { const ph = document.createElement("span"); ph.className = "ph"; ph.textContent = "(randomizer — roll 🎲)"; nameEl.appendChild(ph); }
            else { const d = folderOf(en.name); if (d !== ROOT) { const ds = document.createElement("span"); ds.className = "dir"; ds.textContent = d + "/"; nameEl.appendChild(ds); }
                const fs = document.createElement("span"); fs.className = "fn"; fs.textContent = baseOf(en.name); nameEl.appendChild(fs); }
            nameEl.title = en.name ? en.name + " (click to change)" : "Randomizer line";
            nameEl.onclick = () => chooser(node, event, v => { en.name = v; commit(); }); nameEl.addEventListener("pointerdown", e => e.stopPropagation()); row.appendChild(nameEl);
            const sl = document.createElement("span"); sl.textContent = "S"; sl.style.cssText = "opacity:.6;flex:none;font-size:11px"; sl.title = "Strength (model + clip)"; row.appendChild(sl);
            row.appendChild(num(en.model, v => { const x = isNaN(v) ? 0 : v; en.model = x; en.clip = x; sync(node); }));
            row.appendChild(ic("▲", "Move up", null, () => { if (idx > 0) { [st[idx], st[idx - 1]] = [st[idx - 1], st[idx]]; commit(); } }));
            row.appendChild(ic("▼", "Move down", null, () => { if (idx < st.length - 1) { [st[idx], st[idx + 1]] = [st[idx + 1], st[idx]]; commit(); } }));
            row.appendChild(ic("✕", "Remove", "#e57373", () => { st.splice(idx, 1); commit(); }));
            root.appendChild(row);
        });
    }
    node.__nllRender = render; node.__nllCommit = commit; render(); return root;
}
function snap(node) { const [, h] = node.computeSize(); node.size[1] = h; }

// ── core UI build ──────────────────────────────────────────────────────────
function buildUI(node) {
    if (node.__nllBuilt) return; node.__nllBuilt = true;
    hideWidget(dataW(node)); loadStack(node);
    const fbtn = node.addWidget("button", "nll_folders", null, (_v, _c, _n, _p, ev) => folderPanel(node, ev));
    fbtn.serialize = false; if (fbtn.options) fbtn.options.serialize = false; fbtn.serializeValue = () => undefined;
    node.__nllBtn = () => { const es = enabledSet(node); fbtn.label = es == null ? "📁 Folders: All" : `📁 Folders: ${es.size} on`; node.setDirtyCanvas(true, false); };
    node.__nllBtn(); loras().then(() => node.__nllBtn());
    const dom = rows(node);
    const dw = node.addDOMWidget("nll_rows", "div", dom, { serialize: false }); dw.serializeValue = () => undefined;
    dw.computeSize = function (w) { const n = node.__stack?.length || 0; return [w, n ? n * 27 + 6 : 28]; };
    const add = node.addWidget("button", "nll_add", null, (_v, _c, _n, _p, ev) => chooser(node, ev, v => { node.__stack.push({ on: true, name: v, model: 1, clip: 1 }); node.__nllCommit(); }));
    add.label = "➕ Add LoRA"; add.serialize = false; if (add.options) add.options.serialize = false; add.serializeValue = () => undefined;
    const rnd = node.addWidget("button", "nll_rand", null, async () => { const en = { on: true, name: "", model: 1, clip: 1, random: true, locked: false, autoRoll: false, folders: null }; const p = await pickRandom(node, en); if (p != null) en.name = p; node.__stack.push(en); node.__nllCommit(); });
    rnd.label = "🎲 Add Randomizer"; rnd.serialize = false; if (rnd.options) rnd.options.serialize = false; rnd.serializeValue = () => undefined;
    snap(node);
}

// ── extension ──────────────────────────────────────────────────────────────
app.registerExtension({
    name: "Nougan.LoraLoader",
    async setup() {
        // Auto-roll: bake a fresh random pick into lora_data just before each queue.
        const orig = app.queuePrompt;
        app.queuePrompt = async function (...a) {
            try {
                for (const node of (app.graph?._nodes || [])) {
                    if (!node.__stack) continue; let changed = false;
                    for (const en of node.__stack) { if (en.random && en.autoRoll && !en.locked) { const p = await pickRandom(node, en); if (p != null) { en.name = p; changed = true; } } }
                    if (changed) { sync(node); node.__nllRender?.(); node.setDirtyCanvas(true, false); }
                }
            } catch (e) { console.warn("[Nougan Lora] auto-roll failed", e); }
            return orig.apply(this, a);
        };
    },
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (!ALL.includes(nodeData?.name)) return;
        nodeType.color = COLOR; nodeType.bgcolor = BGCOLOR;
        const onc = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () { onc?.apply(this, arguments); this.size = [WIDTH, 170]; try { buildUI(this); } catch (e) { console.warn("[Nougan Lora] UI build failed", e); } };
        const occ = nodeType.prototype.onConnectionsChange;
        nodeType.prototype.onConnectionsChange = function () { occ?.apply(this, arguments); setTimeout(() => this.__nllRender?.(), 0); };
        const ocf = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info) { ocf?.apply(this, arguments); try { if (!this.__nllBuilt) buildUI(this); loadStack(this); this.__nllRender?.(); this.__nllBtn?.(); snap(this); } catch (e) { console.warn("[Nougan Lora] onConfigure failed", e); } };
    },
});