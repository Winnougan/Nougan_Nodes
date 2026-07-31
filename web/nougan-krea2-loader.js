// web/nougan-krea2-loader.js  ·  v3-spaced
// Stack UI for Nougan Krea 2 · LoRA (+ Multi-Model). Mirrors the Power Lora
// Loader 1:1; reads the bundled nougan/loras/ via /nougan/krea2_loras.
// v3: fixed flex truncation (min-width:0), real spacing, layered row strip,
//     hover/focus micro-interactions, version log for cache confirmation.
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const UI_VERSION = "krea2-ui-v3-spaced";
console.log(`[Nougan Krea2 UI] loaded ${UI_VERSION}`);

const SINGLE = "NouganKrea2Loader";
const MULTI  = "NouganKrea2LoaderMulti";
const ALL    = [SINGLE, MULTI];
const DATA   = "lora_data";
const COLOR  = "#1a2a3a", BGCOLOR = "#0f1923", WIDTH = 470;
const FAV_KEY = "nougan_krea2_favorites";

// ── favourites ───────────────────────────────────────────────────────────
const loadFav = () => { try { return new Set(JSON.parse(localStorage.getItem(FAV_KEY) || "[]")); } catch { return new Set(); } };
const saveFav = (s) => { try { localStorage.setItem(FAV_KEY, JSON.stringify([...s])); } catch {} };

// ── lora list (bundled nougan/loras/) ─────────────────────────────────────
let _cache = null;
async function loras(force = false) {
    if (_cache == null || force) {
        try {
            const r = await api.fetchApi("/nougan/krea2_loras");
            const j = await r.json();
            _cache = (j.loras || []).filter(l => l.present);
        } catch (e) { console.warn("[Nougan Krea2] list fetch failed", e); _cache = _cache || []; }
    }
    return _cache;
}

// ── styles ────────────────────────────────────────────────────────────────
let _styled = false;
function styles() {
    if (_styled) return; _styled = true;
    const s = document.createElement("style");
    s.textContent = `
     /* box-sizing for the in-node row tree (NOT inside .nk2-pop) */
     .nk2-root, .nk2-root *{box-sizing:border-box}

     /* chooser popup */
     .nk2-pop{position:fixed;z-index:10020;display:flex;flex-direction:column;max-height:70vh;
       background:var(--comfy-menu-bg,#1c2530);color:var(--fg-color,#ddd);
       border:1px solid var(--border-color,#3a5068);border-radius:10px;box-shadow:0 14px 44px rgba(0,0,0,.6);
       font:12px 'Inter',system-ui,Arial,sans-serif;user-select:none;min-width:320px;max-width:92vw;
       -webkit-font-smoothing:antialiased}
     .nk2-pop *{box-sizing:border-box}
     .nk2-hd{display:flex;align-items:center;gap:8px;padding:11px 14px;border-bottom:1px solid var(--border-color,#33485c);
       font-weight:700;font-size:13px;letter-spacing:.2px}
     .nk2-hd .t{flex:1}.nk2-x{cursor:pointer;opacity:.6;font-size:16px;line-height:1;transition:opacity .12s,transform .12s}
     .nk2-x:hover{opacity:1;transform:rotate(90deg)}
     .nk2-search{padding:9px 12px;border-bottom:1px solid var(--border-color,#28384a)}
     .nk2-search input{width:100%;padding:7px 11px;background:var(--comfy-input-bg,#16202b);color:inherit;
       border:1px solid var(--border-color,#3a5068);border-radius:7px;font:inherit;outline:none;transition:border-color .12s,box-shadow .12s}
     .nk2-search input:focus{border-color:#7eb8ff;box-shadow:0 0 0 3px rgba(126,184,255,.16)}
     .nk2-list{overflow:auto;flex:1;padding:5px 0}
     .nk2-item{display:flex;align-items:center;gap:9px;padding:7px 13px;cursor:pointer;border-radius:7px;margin:2px 7px;
       border-left:2px solid transparent;transition:background .12s,border-color .12s,transform .1s}
     .nk2-item:hover{background:rgba(126,184,255,.12);border-left-color:#7eb8ff;transform:translateX(2px)}
     .nk2-star{flex:0 0 auto;width:20px;text-align:center;font-size:15px;line-height:1;cursor:pointer;transition:transform .12s,opacity .12s}
     .nk2-star.off{opacity:.3}.nk2-star.off:hover{opacity:.7}.nk2-star.on{color:#f5c518}.nk2-star.on:hover{transform:scale(1.25)}
     .nk2-nm{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
     .nk2-sz{flex:0 0 auto;opacity:.45;font-size:11px;font-variant-numeric:tabular-nums}
     .nk2-sep{margin:6px 12px;border:none;border-top:1px solid var(--border-color,#2c3e50)}
     .nk2-empty{padding:14px;opacity:.6;text-align:center}

     /* in-node stack rows */
     .nk2-root{display:flex;flex-direction:column;gap:5px;width:100%;padding:3px 1px 1px;
       font:12px 'Inter',system-ui,Arial,sans-serif;color:var(--fg-color,#ddd);-webkit-font-smoothing:antialiased}
     .nk2-row{position:relative;display:flex;align-items:center;gap:8px;min-height:30px;padding:5px 10px 5px 13px;
       border-radius:8px;background:rgba(255,255,255,.035);border:1px solid rgba(255,255,255,.06);
       transition:background .14s,border-color .14s,box-shadow .14s}
     .nk2-row:hover{background:rgba(255,255,255,.07);border-color:rgba(126,184,255,.28);
       box-shadow:0 2px 10px rgba(0,0,0,.25)}
     .nk2-row.on::before{content:"";position:absolute;left:3px;top:7px;bottom:7px;width:3px;border-radius:3px;
       background:#5ba3e0;box-shadow:0 0 8px rgba(91,163,224,.6)}
     .nk2-row.off{opacity:.55}
     .nk2-row .cb{flex:0 0 auto;width:15px;height:15px;margin:0;cursor:pointer;accent-color:#5ba3e0}
     .nk2-row .nm{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
       font-size:12px;font-weight:500;letter-spacing:.1px;cursor:pointer;padding:2px 0;transition:color .12s}
     .nk2-row .nm:hover{color:#7eb8ff}
     .nk2-row.off .nm{text-decoration:line-through}
     .nk2-tag{flex:0 0 auto;font-size:9px;font-weight:700;letter-spacing:.7px;text-transform:uppercase;
       opacity:.55;padding:2px 5px;border-radius:4px;background:rgba(255,255,255,.07)}
     .nk2-num{flex:0 0 auto;width:56px;height:23px;background:var(--comfy-input-bg,#16202b);color:inherit;
       border:1px solid var(--border-color,#3a5068);border-radius:6px;font:600 12px/1 'Inter',inherit;
       text-align:center;padding:0 4px;font-variant-numeric:tabular-nums;transition:border-color .12s,box-shadow .12s}
     .nk2-num:focus{border-color:#7eb8ff;box-shadow:0 0 0 3px rgba(126,184,255,.18);outline:none}
     .nk2-ic{flex:0 0 auto;width:23px;height:23px;display:inline-flex;align-items:center;justify-content:center;
       border-radius:6px;font-size:12px;line-height:1;opacity:.6;cursor:pointer;
       transition:background .12s,opacity .12s,color .12s,transform .1s}
     .nk2-ic:hover{opacity:1;background:rgba(255,255,255,.09);transform:translateY(-1px)}
     .nk2-ic.up:hover,.nk2-ic.dn:hover{color:#7eb8ff}
     .nk2-ic.rm{color:#e57373}.nk2-ic.rm:hover{background:rgba(229,115,115,.16);color:#ff9a9a}

     /* empty state */
     .nk2-emptybox{display:flex;align-items:center;justify-content:center;gap:8px;padding:14px 8px;
       border:1px dashed rgba(255,255,255,.14);border-radius:8px;opacity:.6;font-size:11px;letter-spacing:.2px}
     .nk2-dot{width:7px;height:7px;border-radius:50%;background:#5ba3e0;flex:0 0 auto;
       animation:nk2-breathe 1.8s ease-in-out infinite}
     @keyframes nk2-breathe{0%,100%{opacity:.3;transform:scale(.8)}50%{opacity:1;transform:scale(1.15)}}
    `;
    document.head.appendChild(s);
}

// ── popup placement ───────────────────────────────────────────────────────
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

// ── chooser ───────────────────────────────────────────────────────────────
async function chooser(node, ev, onPick) {
    closePop(); styles();
    const list0 = await loras(true);
    const favs = loadFav();
    const el = document.createElement("div"); el.className = "nk2-pop"; el.style.width = "430px";
    el.innerHTML = `<div class="nk2-hd"><span class="t">🌀 Choose a LoRA</span><span class="nk2-x">✕</span></div>
      <div class="nk2-search"><input placeholder="Filter LoRAs…" spellcheck="false"></div><div class="nk2-list"></div>`;
    el.querySelector(".nk2-x").onclick = closePop;
    const input = el.querySelector("input"), listEl = el.querySelector(".nk2-list");
    input.addEventListener("pointerdown", e => e.stopPropagation());
    const alph = (a, b) => a.localeCompare(b, undefined, { sensitivity: "base" });
    function render(q = "") {
        listEl.textContent = "";
        const ql = q.trim().toLowerCase();
        const vis = ql ? list0.filter(l => l.filename.toLowerCase().includes(ql)) : list0.slice();
        if (!vis.length) { const e = document.createElement("div"); e.className = "nk2-empty";
            e.textContent = list0.length ? "No matches." : "No .safetensors in nougan/loras/."; listEl.appendChild(e); return; }
        const fav = vis.filter(l => favs.has(l.filename)).sort((a, b) => alph(a.filename, b.filename));
        const rest = vis.filter(l => !favs.has(l.filename)).sort((a, b) => alph(a.filename, b.filename));
        const item = (l) => {
            const row = document.createElement("div"); row.className = "nk2-item";
            const on = favs.has(l.filename); const star = document.createElement("span");
            star.className = "nk2-star " + (on ? "on" : "off"); star.textContent = on ? "★" : "☆";
            star.onclick = (e) => { e.stopPropagation(); on ? favs.delete(l.filename) : favs.add(l.filename); saveFav(favs); render(input.value); };
            row.appendChild(star);
            const nm = document.createElement("span"); nm.className = "nk2-nm"; nm.textContent = l.filename; nm.title = l.filename; row.appendChild(nm);
            const sz = document.createElement("span"); sz.className = "nk2-sz"; sz.textContent = l.size_str; row.appendChild(sz);
            row.onclick = () => { onPick(l.filename); node.setDirtyCanvas(true, true); closePop(); };
            return row;
        };
        fav.forEach(l => listEl.appendChild(item(l)));
        if (fav.length && rest.length) { const hr = document.createElement("hr"); hr.className = "nk2-sep"; listEl.appendChild(hr); }
        rest.forEach(l => listEl.appendChild(item(l)));
    }
    render(); input.oninput = () => render(input.value);
    place(el, ev); setTimeout(() => input.focus(), 30);
}

// ── data sync + widget hiding ─────────────────────────────────────────────
const dataW = (n) => n.widgets?.find(w => w.name === DATA);
function hideWidget(w) {
    if (!w) return;
    const el = w.element || w.inputEl;
    if (el) { el.style.display = "none"; el.style.height = "0"; el.style.pointerEvents = "none"; }
    if (w._nk2Hidden) return; w._nk2Hidden = true;
    w.computeSize = () => [0, -4]; w.draw = () => {};
}
function sync(node) {
    const w = dataW(node); if (!w) return;
    w.value = JSON.stringify({ loras: node.__nk2Stack || [] });
}
function loadStack(node) {
    const w = dataW(node); let stack = [];
    try {
        const p = JSON.parse(w?.value || "{}");
        const entries = Array.isArray(p) ? p : (p.loras || []);
        stack = entries.filter(e => e && (e.name || e.lora)).map(e => {
            const s = e.strength != null ? Number(e.strength) : Number(e.model ?? 1);
            return { on: e.on !== false, name: e.name || e.lora || "", model: s, clip: e.clip != null && e.strength == null ? Number(e.clip) : s };
        });
    } catch { stack = []; }
    node.__nk2Stack = stack;
}

// ── stack row editor ──────────────────────────────────────────────────────
function rows(node) {
    styles();
    const root = document.createElement("div");
    root.className = "nk2-root";
    const num = (v, fn) => { const i = document.createElement("input"); i.type = "number"; i.step = "0.05"; i.value = String(v); i.className = "nk2-num";
        i.onchange = () => fn(parseFloat(i.value)); i.addEventListener("pointerdown", e => e.stopPropagation()); return i; };
    const ic = (t, tip, kind, fn) => { const b = document.createElement("span"); b.className = "nk2-ic" + (kind ? " " + kind : ""); b.textContent = t; b.title = tip;
        b.onclick = () => fn(); b.addEventListener("pointerdown", e => e.stopPropagation()); return b; };
    const commit = () => { sync(node); render(); snap(node); node.setDirtyCanvas(true, true); };
    function render() {
        root.textContent = "";
        const st = node.__nk2Stack || [];
        if (!st.length) {
            const box = document.createElement("div"); box.className = "nk2-emptybox";
            const dot = document.createElement("span"); dot.className = "nk2-dot"; box.appendChild(dot);
            const txt = document.createElement("span"); txt.textContent = "No LoRAs — ➕ Add or right-click the node"; box.appendChild(txt);
            root.appendChild(box); return;
        }
        st.forEach((en, idx) => {
            const row = document.createElement("div"); row.className = "nk2-row " + (en.on ? "on" : "off");

            const cb = document.createElement("input"); cb.type = "checkbox"; cb.className = "cb"; cb.checked = en.on; cb.title = "Enable / disable";
            cb.onchange = () => { en.on = cb.checked; commit(); }; cb.addEventListener("pointerdown", e => e.stopPropagation()); row.appendChild(cb);

            const nameEl = document.createElement("span"); nameEl.className = "nm";
            nameEl.textContent = en.name || "(empty)";
            nameEl.title = en.name + "  ·  click to change";
            nameEl.onclick = () => chooser(node, event, v => { en.name = v; commit(); });
            nameEl.addEventListener("pointerdown", e => e.stopPropagation()); row.appendChild(nameEl);

            const tag = document.createElement("span"); tag.className = "nk2-tag"; tag.textContent = "S"; tag.title = "Strength (model + clip)"; row.appendChild(tag);
            row.appendChild(num(en.model, v => { const x = isNaN(v) ? 0 : v; en.model = x; en.clip = x; sync(node); }));

            row.appendChild(ic("▲", "Move up", "up", () => { if (idx > 0) { [st[idx], st[idx - 1]] = [st[idx - 1], st[idx]]; commit(); } }));
            row.appendChild(ic("▼", "Move down", "dn", () => { if (idx < st.length - 1) { [st[idx], st[idx + 1]] = [st[idx + 1], st[idx]]; commit(); } }));
            row.appendChild(ic("✕", "Remove", "rm", () => { st.splice(idx, 1); commit(); }));

            root.appendChild(row);
        });
    }
    node.__nk2Render = render; node.__nk2Commit = commit; render(); return root;
}
function snap(node) { const [, h] = node.computeSize(); node.size[1] = Math.max(h, 150); }

// ── core UI build ─────────────────────────────────────────────────────────
function buildUI(node) {
    if (node.__nk2Built) return; node.__nk2Built = true;
    hideWidget(dataW(node)); loadStack(node);
    const dom = rows(node);
    const dw = node.addDOMWidget("nk2_rows", "div", dom, { serialize: false }); dw.serializeValue = () => undefined;
    dw.computeSize = function (w) { const n = node.__nk2Stack?.length || 0; return [w, n ? n * 36 + 8 : 50]; };
    const add = node.addWidget("button", "nk2_add", null, (_v, _c, _n, _p, ev) =>
        chooser(node, ev, v => { node.__nk2Stack.push({ on: true, name: v, model: 1, clip: 1 }); node.__nk2Commit(); }));
    add.label = "➕  Add LoRA"; add.serialize = false; if (add.options) add.options.serialize = false; add.serializeValue = () => undefined;
    const clr = node.addWidget("button", "nk2_clear", null, () => { node.__nk2Stack = []; node.__nk2Commit(); });
    clr.label = "🗑️  Clear All"; clr.serialize = false; if (clr.options) clr.options.serialize = false; clr.serializeValue = () => undefined;
    snap(node);
}

// ── extension ─────────────────────────────────────────────────────────────
app.registerExtension({
    name: "Nougan.Krea2Loader",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (!ALL.includes(nodeData?.name)) return;
        nodeType.color = COLOR; nodeType.bgcolor = BGCOLOR;
        const onc = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () { onc?.apply(this, arguments); this.size = [WIDTH, 200]; try { buildUI(this); } catch (e) { console.warn("[Nougan Krea2] UI build failed", e); } };
        const occ = nodeType.prototype.onConnectionsChange;
        nodeType.prototype.onConnectionsChange = function () { occ?.apply(this, arguments); setTimeout(() => this.__nk2Render?.(), 0); };
        const ocf = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info) { ocf?.apply(this, arguments); try { if (!this.__nk2Built) buildUI(this); loadStack(this); this.__nk2Render?.(); snap(this); } catch (e) { console.warn("[Nougan Krea2] onConfigure failed", e); } };

        // RIGHT-CLICK menu
        const origExtra = nodeType.prototype.getExtraMenuOptions;
        nodeType.prototype.getExtraMenuOptions = function (canvas, options) {
            const r = origExtra ? origExtra.apply(this, arguments) : undefined;
            const ev = { clientX: innerWidth / 2, clientY: innerHeight / 3 };
            options.push(null);
            options.push({ content: "🌀 Add LoRA…", callback: () => chooser(this, ev, v => { this.__nk2Stack.push({ on: true, name: v, model: 1, clip: 1 }); this.__nk2Commit(); }) });
            options.push({ content: "🎯 Add with strength…", callback: () => chooser(this, ev, v => { const s = prompt(`Strength for ${v}:`, "1.0"); const x = parseFloat(s); this.__nk2Stack.push({ on: true, name: v, model: isNaN(x) ? 1 : x, clip: isNaN(x) ? 1 : x }); this.__nk2Commit(); }) });
            options.push({ content: "📦 Add ALL @ 1.0", callback: async () => { const ls = await loras(true); ls.forEach(l => this.__nk2Stack.push({ on: true, name: l.filename, model: 1, clip: 1 })); this.__nk2Commit(); } });
            options.push(null);
            options.push({ content: "🗑️ Clear all", callback: () => { this.__nk2Stack = []; this.__nk2Commit(); } });
            return r;
        };
    },
});