// nougan-lora-loader-ui.js — Nougan Lora Loader frontend (from scratch)
//
//  • drag a bar to set strength · double-click to type · Alt+click resets to 1.00
//  • ‹ › nudge ±0.05 (Shift = ±0.01) · ⇄ splits a LoRA into separate model / clip strength
//  • grab the ⠿ handle to reorder
//  • picker: search, folder chips, favourites, click to add / remove, ↑↓ Enter, stays open for multi-add

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_NAME = "NouganLoraLoader";
const DATA = "lora_data";
const WIDTH = 430;

const S_MIN = -2;      // visual range of the strength bars
const S_MAX = 2;       // (typing a value allows ±10)
const HARD = 10;
const STEP = 0.05;
const FAV_KEY = "nougan_lora_favorites";
const ROOT = "(root)";


// ── helpers ────────────────────────────────────────────────────────────────

const norm = (f) => String(f ?? "").replaceAll("\\", "/");
const folderOf = (f) => { const n = norm(f), i = n.lastIndexOf("/"); return i < 0 ? ROOT : n.slice(0, i); };
const baseOf = (f) => { const n = norm(f); return n.slice(n.lastIndexOf("/") + 1); };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const r2 = (v) => Math.round(v * 100) / 100;
const fmt = (v) => (v < 0 ? "−" : "") + Math.abs(v).toFixed(2);
const alpha = (a, b) => a.localeCompare(b, undefined, { sensitivity: "base" });

const loadFav = () => { try { return new Set(JSON.parse(localStorage.getItem(FAV_KEY) || "[]")); } catch { return new Set(); } };
const saveFav = (s) => { try { localStorage.setItem(FAV_KEY, JSON.stringify([...s])); } catch { } };

let _files = null;   // null until the first successful fetch

async function loras(force = false) {
    if (_files == null || force) {
        try {
            const r = await api.fetchApi("/nougan/loras");
            const j = await r.json();
            _files = (j || []).map(e => typeof e === "string" ? e : e?.name).filter(Boolean);
        } catch (e) {
            console.warn("[Nougan Lora] list fetch failed", e);
        }
    }
    return _files || [];
}

const isMissing = (name) => _files != null && !_files.some(f => norm(f) === norm(name));


// ── styles ─────────────────────────────────────────────────────────────────

let _styled = false;

function styles() {
    if (_styled) return;
    _styled = true;

    const s = document.createElement("style");
    s.textContent = `
.lz{--bg:#12141a;--card:#1a1d26;--card2:#20242f;--line:#2a2f3c;--fg:#e8ebf2;--dim:#8a93a6;
  --acc:#f5a524;--acc2:#ff7a18;--neg:#f0616d;--ok:#5ee08a;
  font:12px/1.3 'Inter','Segoe UI',system-ui,sans-serif;color:var(--fg);user-select:none;box-sizing:border-box;
  width:100%;padding:10px;border-radius:12px;border:1px solid var(--line);
  background:radial-gradient(120% 80% at 0% 0%,rgba(245,165,36,.07),transparent 55%),var(--bg);
  box-shadow:0 8px 26px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,255,255,.04)}
.lz *{box-sizing:border-box}
.lz button{font:inherit;color:inherit}

.lz-head{display:flex;align-items:center;gap:8px;margin-bottom:9px}
.lz-logo{width:4px;height:18px;border-radius:2px;background:linear-gradient(180deg,var(--acc),var(--acc2));
  box-shadow:0 0 10px rgba(245,165,36,.6)}
.lz-title{font-weight:800;letter-spacing:.16em;font-size:11px}
.lz-chip{font-size:10px;font-weight:700;color:var(--dim);background:var(--card);border:1px solid var(--line);
  padding:2px 8px;border-radius:99px}
.lz-chip b{color:var(--acc)}
.lz-sp{flex:1}
.lz-ib{width:26px;height:24px;display:grid;place-items:center;cursor:pointer;border-radius:7px;
  background:var(--card);border:1px solid var(--line);color:var(--dim);font-size:12px;
  transition:color .15s,border-color .15s,background .15s}
.lz-ib:hover{color:var(--acc);border-color:#4a3b1e;background:var(--card2)}
.lz-ib.warn{color:#fff;background:var(--neg);border-color:var(--neg)}

.lz-list{display:flex;flex-direction:column;gap:6px}

.lz-row{position:relative;background:var(--card);border:1px solid var(--line);border-radius:9px;
  padding:6px 8px 7px 6px;transition:border-color .15s,box-shadow .15s,opacity .15s,background .15s}
.lz-row:hover{border-color:#3b4254;background:#1d212b}
.lz-row.off{opacity:.5}
.lz-row.drag{opacity:.55;box-shadow:0 6px 18px rgba(0,0,0,.5);border-color:var(--acc)}
.lz-row.over-t::before,.lz-row.over-b::after{content:"";position:absolute;left:4px;right:4px;height:3px;
  border-radius:2px;background:var(--acc);box-shadow:0 0 8px var(--acc)}
.lz-row.over-t::before{top:-5px}.lz-row.over-b::after{bottom:-5px}

.lz-top{display:flex;align-items:center;gap:7px;min-height:22px}
.lz-grip{width:14px;flex:none;text-align:center;color:#4b5266;cursor:grab;font-size:13px;letter-spacing:-2px;touch-action:none}
.lz-grip:hover{color:var(--acc)}.lz-grip:active{cursor:grabbing}
.lz-sw{flex:none;width:28px;height:16px;border-radius:99px;background:#2b3040;border:1px solid #3a4054;cursor:pointer;
  position:relative;transition:background .18s,border-color .18s}
.lz-sw::after{content:"";position:absolute;top:1px;left:1px;width:12px;height:12px;border-radius:50%;
  background:#9aa3b8;transition:transform .18s,background .18s}
.lz-sw.on{background:linear-gradient(90deg,var(--acc),var(--acc2));border-color:var(--acc)}
.lz-sw.on::after{transform:translateX(12px);background:#fff}
.lz-nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer;font-size:12.5px}
.lz-nm:hover .fn{color:var(--acc)}
.lz-nm .dir{color:var(--dim);font-size:10.5px}.lz-nm .fn{font-weight:700;transition:color .12s}
.lz-row.off .fn{text-decoration:line-through}
.lz-miss{flex:none;font-size:9px;font-weight:800;letter-spacing:.1em;color:#fff;background:var(--neg);
  border-radius:4px;padding:1px 5px}
.lz-mini{flex:none;width:22px;height:20px;display:grid;place-items:center;cursor:pointer;border-radius:6px;
  color:#69718a;font-size:12px;transition:color .12s,background .12s}
.lz-mini:hover{color:var(--fg);background:var(--card2)}
.lz-mini.on{color:var(--acc);background:rgba(245,165,36,.12)}
.lz-mini.x:hover{color:#fff;background:var(--neg)}

.lz-bars{display:flex;gap:6px;margin-top:6px;padding-left:21px}
.lz-sc{position:relative;flex:1;height:22px;border-radius:6px;background:#10121a;border:1px solid var(--line);
  overflow:hidden;cursor:ew-resize;touch-action:none;transition:border-color .15s}
.lz-sc:hover{border-color:#4a3b1e}
.lz-fill{position:absolute;top:0;bottom:0;background:linear-gradient(90deg,rgba(245,165,36,.35),rgba(255,122,24,.75));
  pointer-events:none}
.lz-fill.neg{background:linear-gradient(90deg,rgba(240,97,109,.8),rgba(240,97,109,.3))}
.lz-tick{position:absolute;top:3px;bottom:3px;width:1px;background:rgba(255,255,255,.14);pointer-events:none}
.lz-tick.z{background:rgba(255,255,255,.3)}
.lz-lbl{position:absolute;left:8px;top:0;bottom:0;display:flex;align-items:center;font-size:9px;font-weight:800;
  letter-spacing:.12em;color:#8a93a6;pointer-events:none}
.lz-val{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:12px;
  font-weight:700;font-variant-numeric:tabular-nums;text-shadow:0 1px 2px rgba(0,0,0,.7);pointer-events:none}
.lz-val.hard{color:var(--acc)}
.lz-ar{position:absolute;top:0;bottom:0;width:20px;display:grid;place-items:center;font-size:14px;color:#8a93a6;
  opacity:0;cursor:pointer;transition:opacity .12s,color .12s;z-index:2}
.lz-sc:hover .lz-ar{opacity:1}.lz-ar:hover{color:var(--acc)}
.lz-ar.l{left:0}.lz-ar.r{right:0}
.lz-in{position:absolute;inset:0;width:100%;height:100%;background:#0b0c11;color:var(--fg);border:0;outline:2px solid var(--acc);
  border-radius:6px;text-align:center;font:700 12px 'Inter',sans-serif;z-index:3}

.lz-empty{border:1.5px dashed #343a4b;border-radius:10px;padding:18px 10px;text-align:center;color:var(--dim);
  cursor:pointer;transition:border-color .15s,color .15s,background .15s}
.lz-empty:hover{border-color:var(--acc);color:var(--acc);background:rgba(245,165,36,.05)}
.lz-empty .big{font-size:20px;line-height:1;margin-bottom:5px}

.lz-add{margin-top:9px;width:100%;padding:8px 10px;border-radius:9px;cursor:pointer;font-weight:800;letter-spacing:.14em;
  font-size:11px;text-transform:uppercase;color:#1a1206;border:1px solid #c9821a;
  background:linear-gradient(180deg,#ffc35c,var(--acc));transition:transform .12s,box-shadow .12s,filter .12s}
.lz-add:hover{transform:translateY(-1px);box-shadow:0 5px 16px rgba(245,165,36,.35);filter:brightness(1.05)}
.lz-add:active{transform:none}

/* ---------- picker ---------- */
.lzp{position:fixed;z-index:10020;width:430px;max-width:94vw;max-height:72vh;display:flex;flex-direction:column;
  background:#15171e;color:#e8ebf2;border:1px solid #333948;border-radius:12px;
  box-shadow:0 18px 50px rgba(0,0,0,.7);font:12px 'Inter','Segoe UI',system-ui,sans-serif;user-select:none;overflow:hidden}
.lzp *{box-sizing:border-box}
.lzp button{font:inherit;color:inherit}
.lzp-h{display:flex;align-items:center;gap:8px;padding:10px 12px 6px}
.lzp-h .t{font-weight:800;letter-spacing:.14em;font-size:11px}
.lzp-h .c{font-size:10px;color:#8a93a6}
.lzp-h .sp{flex:1}
.lzp-x{cursor:pointer;color:#8a93a6;padding:0 4px;font-size:14px}.lzp-x:hover{color:#fff}
.lzp-s{padding:0 12px 8px}
.lzp-s input{width:100%;padding:8px 10px;border-radius:8px;background:#0f1117;color:inherit;border:1px solid #2d3342;
  font:inherit;outline:none}
.lzp-s input:focus{border-color:#f5a524;box-shadow:0 0 0 3px rgba(245,165,36,.15)}
.lzp-f{display:flex;flex-wrap:wrap;gap:5px;padding:0 12px 8px;max-height:64px;overflow:auto}
.lzp-fc{cursor:pointer;font-size:10.5px;padding:2px 9px;border-radius:99px;background:#1c202a;border:1px solid #2d3342;color:#a9b1c4;
  transition:all .12s}
.lzp-fc:hover{border-color:#4a3b1e;color:#ffd58a}
.lzp-fc.on{background:linear-gradient(180deg,#ffc35c,#f5a524);color:#1a1206;border-color:#c9821a;font-weight:700}
.lzp-l{flex:1;overflow:auto;padding:2px 6px 6px;border-top:1px solid #232834}
.lzp-it{display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:7px;cursor:pointer}
.lzp-it:hover,.lzp-it.hi{background:rgba(255,255,255,.07)}
.lzp-it.in{background:rgba(245,165,36,.09)}
.lzp-st{width:18px;text-align:center;font-size:15px;line-height:1;cursor:pointer;color:#555d72;transition:transform .12s,color .12s}
.lzp-st:hover{color:#ffd58a;transform:scale(1.2)}.lzp-st.on{color:#f5c518}
.lzp-ck{flex:none;width:16px;height:16px;border-radius:5px;border:1.5px solid #3b4254;display:grid;place-items:center;
  font-size:11px;color:transparent;transition:all .12s}
.lzp-it.in .lzp-ck{background:linear-gradient(180deg,#ffc35c,#f5a524);border-color:#c9821a;color:#1a1206;font-weight:900}
.lzp-nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lzp-nm .dir{color:#7d8595;font-size:10.5px}
.lzp-nm .fn{font-weight:600}
.lzp-sep{border:none;border-top:1px solid #232834;margin:5px 8px}
.lzp-em{padding:18px;text-align:center;color:#7d8595}
.lzp-ft{display:flex;align-items:center;gap:8px;padding:8px 12px;border-top:1px solid #232834;background:#12141a}
.lzp-ft .h{flex:1;font-size:10px;color:#6c7488}
.lzp-done{cursor:pointer;padding:5px 16px;border-radius:7px;font-weight:800;font-size:11px;letter-spacing:.1em;
  text-transform:uppercase;color:#1a1206;background:linear-gradient(180deg,#ffc35c,#f5a524);border:1px solid #c9821a}
.lzp-done:hover{filter:brightness(1.07)}
`;
    document.head.appendChild(s);
}


// ── picker popup ───────────────────────────────────────────────────────────

let _pop = null;

function closePicker() {
    _pop?.dispose();
    _pop = null;
}

// replaceIdx: null = multi-add / toggle mode, number = swap that row's LoRA and close
async function openPicker(node, ev, replaceIdx = null) {
    closePicker();
    styles();

    const files = await loras(true);
    const favs = loadFav();
    const folders = [...new Set(files.map(folderOf))].sort((a, b) =>
        a === ROOT ? -1 : b === ROOT ? 1 : alpha(a, b));

    let query = "", folder = null, hi = 0, visible = [];

    const el = document.createElement("div");
    el.className = "lzp";
    el.innerHTML = `
        <div class="lzp-h"><span class="t">${replaceIdx == null ? "ADD LORAS" : "SWAP LORA"}</span>
            <span class="c"></span><span class="sp"></span><span class="lzp-x">✕</span></div>
        <div class="lzp-s"><input placeholder="Search ${files.length} LoRAs…" spellcheck="false"></div>
        <div class="lzp-f"></div>
        <div class="lzp-l"></div>
        <div class="lzp-ft"><span class="h">${replaceIdx == null ? "click to add / remove · ↑↓ Enter · Esc" : "click a LoRA to swap it in"}</span>
            <button class="lzp-done">Done</button></div>`;

    const $ = (s) => el.querySelector(s);
    const list = $(".lzp-l"), input = $("input"), chips = $(".lzp-f");

    $(".lzp-x").onclick = closePicker;
    $(".lzp-done").onclick = closePicker;
    el.addEventListener("pointerdown", e => e.stopPropagation());

    const inStack = (f) => (node.__stack || []).some(e => norm(e.name) === norm(f));

    function drawChips() {
        chips.textContent = "";
        if (folders.length < 2) { chips.style.display = "none"; return; }

        const mk = (label, val) => {
            const c = document.createElement("span");
            c.className = "lzp-fc" + (folder === val ? " on" : "");
            c.textContent = label;
            c.onclick = () => { folder = val; hi = 0; drawChips(); draw(); };
            chips.appendChild(c);
        };

        mk("All", null);
        folders.forEach(f => mk(f === ROOT ? "root" : f, f));
    }

    function toggle(f) {
        if (replaceIdx != null) {
            const en = node.__stack[replaceIdx];
            if (en) en.name = f;
            node.__lzCommit();
            closePicker();
            return;
        }

        if (inStack(f)) {
            node.__stack = node.__stack.filter(e => norm(e.name) !== norm(f));
        } else {
            node.__stack.push(newEntry({ name: f }));
        }

        node.__lzCommit();

        const top = list.scrollTop;
        draw();
        list.scrollTop = top;
    }

    function draw() {
        list.textContent = "";

        const q = query.trim().toLowerCase();
        let pool = files.filter(f => (folder == null || folderOf(f) === folder) && (!q || f.toLowerCase().includes(q)));

        const fav = pool.filter(f => favs.has(f)).sort(alpha);
        const rest = pool.filter(f => !favs.has(f)).sort(alpha);
        visible = [...fav, ...rest];
        hi = clamp(hi, 0, Math.max(0, visible.length - 1));

        $(".c").textContent = `${(node.__stack || []).length} in stack`;

        if (!visible.length) {
            const e = document.createElement("div");
            e.className = "lzp-em";
            e.textContent = files.length ? "No matches." : "No LoRAs found in models/loras.";
            list.appendChild(e);
            return;
        }

        const item = (f, i) => {
            const row = document.createElement("div");
            row.className = "lzp-it" + (inStack(f) ? " in" : "") + (i === hi ? " hi" : "");
            row.dataset.i = i;

            const star = document.createElement("span");
            star.className = "lzp-st" + (favs.has(f) ? " on" : "");
            star.textContent = favs.has(f) ? "★" : "☆";
            star.onclick = (e) => {
                e.stopPropagation();
                favs.has(f) ? favs.delete(f) : favs.add(f);
                saveFav(favs);
                const top = list.scrollTop;
                draw();
                list.scrollTop = top;
            };
            row.appendChild(star);

            if (replaceIdx == null) {
                const ck = document.createElement("span");
                ck.className = "lzp-ck";
                ck.textContent = "✓";
                row.appendChild(ck);
            }

            const nm = document.createElement("span");
            nm.className = "lzp-nm";
            nm.title = f;
            const d = folderOf(f);
            nm.innerHTML = (d !== ROOT ? `<span class="dir"></span>` : "") + `<span class="fn"></span>`;
            if (d !== ROOT) nm.querySelector(".dir").textContent = d + "/";
            nm.querySelector(".fn").textContent = baseOf(f);
            row.appendChild(nm);

            row.onclick = () => toggle(f);
            return row;
        };

        fav.forEach((f, i) => list.appendChild(item(f, i)));
        if (fav.length && rest.length) {
            const hr = document.createElement("hr");
            hr.className = "lzp-sep";
            list.appendChild(hr);
        }
        rest.forEach((f, i) => list.appendChild(item(f, fav.length + i)));
    }

    input.addEventListener("input", () => { query = input.value; hi = 0; draw(); });

    const kd = (e) => {
        if (e.key === "Escape") { closePicker(); return; }
        if (!el.contains(document.activeElement) && document.activeElement !== document.body) return;

        const move = (d) => {
            e.preventDefault();
            hi = clamp(hi + d, 0, visible.length - 1);
            list.querySelectorAll(".lzp-it").forEach(r => r.classList.toggle("hi", Number(r.dataset.i) === hi));
            list.querySelector(".lzp-it.hi")?.scrollIntoView({ block: "nearest" });
        };

        if (e.key === "ArrowDown") move(1);
        else if (e.key === "ArrowUp") move(-1);
        else if (e.key === "Enter" && visible[hi]) { e.preventDefault(); toggle(visible[hi]); }
    };

    const pd = (e) => { if (!el.contains(e.target)) closePicker(); };

    drawChips();
    draw();

    document.body.appendChild(el);

    const x = ev?.clientX ?? innerWidth / 2;
    const y = ev?.clientY ?? innerHeight / 3;
    const r = el.getBoundingClientRect();
    el.style.left = Math.max(8, Math.min(x - 40, innerWidth - r.width - 8)) + "px";
    el.style.top = Math.max(8, Math.min(y + 8, innerHeight - r.height - 8)) + "px";

    setTimeout(() => {
        addEventListener("pointerdown", pd, true);
        addEventListener("keydown", kd, true);
        input.focus();
    }, 0);

    _pop = {
        dispose() {
            removeEventListener("pointerdown", pd, true);
            removeEventListener("keydown", kd, true);
            el.remove();
        },
    };
}


// ── data ───────────────────────────────────────────────────────────────────

const dataW = (n) => n.widgets?.find(w => w.name === DATA);

function hideWidget(w) {
    if (!w || w._lzHidden) return;
    w._lzHidden = true;

    const el = w.element || w.inputEl;
    if (el) { el.style.display = "none"; el.style.height = "0"; el.style.pointerEvents = "none"; }

    w.computeSize = () => [0, 0];
    w.draw = () => { };
}

const newEntry = (extra) => ({ on: true, name: "", model: 1, clip: 1, split: false, ...extra });

function sync(node) {
    const w = dataW(node);
    if (!w) return;

    w.value = JSON.stringify({
        loras: (node.__stack || []).map(e => ({
            on: e.on, name: e.name, model: e.model, clip: e.split ? e.clip : e.model, split: e.split,
        })),
    });
}

function loadStack(node) {
    let stack = [];

    try {
        const p = JSON.parse(dataW(node)?.value || "{}");
        const raw = Array.isArray(p) ? p : (p.loras || []);
        const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

        stack = raw.filter(e => e && (e.name || e.lora)).map(e => {
            const m = e.strength != null ? num(e.strength, 1) : num(e.model, 1);
            const c = e.strength != null ? m : num(e.clip, m);

            return newEntry({
                on: e.on !== false,
                name: e.name || e.lora,
                model: m,
                clip: c,
                split: e.split != null ? !!e.split : Math.abs(c - m) > 1e-6,
            });
        });
    } catch { stack = []; }

    node.__stack = stack;
}


// ── strength bar ───────────────────────────────────────────────────────────

function scrub(label, get, set) {
    const el = document.createElement("div");
    el.className = "lz-sc";
    el.title = "Drag to set · double-click to type · Alt+click = 1.00 · Shift = fine";
    el.innerHTML = `
        <div class="lz-fill"></div>
        <div class="lz-tick" style="left:${((1 - S_MIN) / (S_MAX - S_MIN)) * 100}%"></div>
        <div class="lz-tick z" style="left:50%"></div>
        ${label ? `<span class="lz-lbl">${label}</span>` : ""}
        <span class="lz-val"></span>
        <span class="lz-ar l">‹</span><span class="lz-ar r">›</span>`;

    const fill = el.querySelector(".lz-fill"), val = el.querySelector(".lz-val");

    const paint = () => {
        const v = get();
        const pos = clamp((v - S_MIN) / (S_MAX - S_MIN), 0, 1);

        fill.className = "lz-fill" + (v < 0 ? " neg" : "");
        fill.style.left = (Math.min(pos, 0.5) * 100) + "%";
        fill.style.width = (Math.abs(pos - 0.5) * 100) + "%";

        val.textContent = fmt(v);
        val.classList.toggle("hard", v > S_MAX || v < S_MIN);
    };

    const put = (v, fine) => {
        v = clamp(fine ? Math.round(v * 100) / 100 : Math.round(v / STEP) * STEP, -HARD, HARD);
        set(r2(v));
        paint();
    };

    paint();

    el.addEventListener("pointerdown", (e) => {
        if (e.target.closest(".lz-ar") || e.target.closest(".lz-in")) return;

        if (e.altKey) { put(1); return; }

        el.setPointerCapture(e.pointerId);

        const fromX = (ev) => {
            const b = el.getBoundingClientRect();
            put(S_MIN + clamp((ev.clientX - b.left) / b.width, 0, 1) * (S_MAX - S_MIN), ev.shiftKey);
        };

        fromX(e);

        const mv = (ev) => fromX(ev);
        const up = () => {
            el.removeEventListener("pointermove", mv);
            el.removeEventListener("pointerup", up);
            el.removeEventListener("pointercancel", up);
        };

        el.addEventListener("pointermove", mv);
        el.addEventListener("pointerup", up);
        el.addEventListener("pointercancel", up);
    });

    el.querySelector(".lz-ar.l").onclick = (e) => { e.stopPropagation(); put(get() - (e.shiftKey ? 0.01 : STEP), e.shiftKey); };
    el.querySelector(".lz-ar.r").onclick = (e) => { e.stopPropagation(); put(get() + (e.shiftKey ? 0.01 : STEP), e.shiftKey); };

    el.addEventListener("dblclick", (e) => {
        if (e.target.closest(".lz-ar")) return;

        const inp = document.createElement("input");
        inp.className = "lz-in";
        inp.value = String(get());
        el.appendChild(inp);
        inp.focus();
        inp.select();

        let done = false;
        const finish = (ok) => {
            if (done) return;
            done = true;

            if (ok) {
                const n = parseFloat(inp.value.replace("−", "-"));
                if (Number.isFinite(n)) put(n, true);
            }

            inp.remove();
        };

        inp.onkeydown = (ev) => {
            ev.stopPropagation();
            if (ev.key === "Enter") finish(true);
            if (ev.key === "Escape") finish(false);
        };
        inp.onblur = () => finish(true);
    });

    return el;
}


// ── panel ──────────────────────────────────────────────────────────────────

// Size the node to its real content: widget top (below the slots) + measured panel height.
// Doesn't rely on node.computeSize(), which can't see how tall the DOM panel actually is.
function fit(node) {
    requestAnimationFrame(() => {
        if (!node.graph) return;

        const ph = node.__lzPanel?.offsetHeight || 0;
        const dw = node.__lzDW;
        const slots = Math.max(node.inputs?.length || 0, node.outputs?.length || 0);
        const wy = (dw?.last_y > 0 ? dw.last_y : null) ?? (dw?.y > 0 ? dw.y : null) ?? (slots * 20 + 24);

        const h = ph > 0 ? wy + ph + 16 : node.computeSize()[1];

        if (Math.abs(h - node.size[1]) > 1) {
            node.setSize([Math.max(node.size[0], 340), h]);
        }

        node.setDirtyCanvas(true, true);
    });
}

function buildPanel(node) {
    styles();

    const root = document.createElement("div");
    root.className = "lz";
    root.innerHTML = `
        <div class="lz-head">
            <span class="lz-logo"></span><span class="lz-title">LORA&nbsp;STACK</span>
            <span class="lz-chip"></span><span class="lz-sp"></span>
            <span class="lz-ib lz-all" title="Toggle all on / off">⏻</span>
            <span class="lz-ib lz-clear" title="Remove all LoRAs">🗑</span>
        </div>
        <div class="lz-list"></div>
        <button class="lz-add">＋ Add LoRA</button>`;

    const $ = (s) => root.querySelector(s);
    const list = $(".lz-list");

    root.addEventListener("pointerdown", e => e.stopPropagation());

    const touch = () => { sync(node); node.setDirtyCanvas(true, true); };

    const commit = () => { sync(node); render(); node.setDirtyCanvas(true, true); };

    function chip() {
        const st = node.__stack;
        $(".lz-chip").innerHTML = `<b>${st.filter(e => e.on).length}</b> / ${st.length} active`;
    }

    function startDrag(e, row, idx) {
        e.preventDefault();

        const grip = e.currentTarget;
        grip.setPointerCapture(e.pointerId);
        row.classList.add("drag");

        const rows = [...list.querySelectorAll(".lz-row")];
        let target = idx, after = false;

        const clear = () => rows.forEach(r => r.classList.remove("over-t", "over-b"));

        const mv = (ev) => {
            clear();

            const first = rows[0].getBoundingClientRect();
            const last = rows[rows.length - 1].getBoundingClientRect();

            if (ev.clientY < first.top) { target = 0; after = false; }
            else if (ev.clientY > last.bottom) { target = rows.length - 1; after = true; }
            else {
                for (let i = 0; i < rows.length; i++) {
                    const b = rows[i].getBoundingClientRect();
                    if (ev.clientY >= b.top - 3 && ev.clientY <= b.bottom + 3) {
                        target = i;
                        after = ev.clientY > b.top + b.height / 2;
                        break;
                    }
                }
            }

            rows[target].classList.add(after ? "over-b" : "over-t");
        };

        const up = () => {
            grip.removeEventListener("pointermove", mv);
            grip.removeEventListener("pointerup", up);
            grip.removeEventListener("pointercancel", up);

            clear();
            row.classList.remove("drag");

            let to = target + (after ? 1 : 0);
            if (to > idx) to--;

            if (to !== idx) {
                const [m] = node.__stack.splice(idx, 1);
                node.__stack.splice(to, 0, m);
                commit();
            }
        };

        grip.addEventListener("pointermove", mv);
        grip.addEventListener("pointerup", up);
        grip.addEventListener("pointercancel", up);
    }

    function renderRow(en, idx) {
        const row = document.createElement("div");
        row.className = "lz-row" + (en.on ? "" : " off");

        const top = document.createElement("div");
        top.className = "lz-top";

        const grip = document.createElement("span");
        grip.className = "lz-grip";
        grip.textContent = "⠿";
        grip.title = "Drag to reorder";
        grip.addEventListener("pointerdown", (e) => startDrag(e, row, idx));
        top.appendChild(grip);

        const sw = document.createElement("span");
        sw.className = "lz-sw" + (en.on ? " on" : "");
        sw.title = en.on ? "Enabled" : "Disabled";
        sw.onclick = () => { en.on = !en.on; commit(); };
        top.appendChild(sw);

        const nm = document.createElement("span");
        nm.className = "lz-nm";
        nm.title = en.name + "\n(click to swap)";

        const d = folderOf(en.name);
        if (d !== ROOT) {
            const ds = document.createElement("span");
            ds.className = "dir";
            ds.textContent = d + "/";
            nm.appendChild(ds);
        }
        const fs = document.createElement("span");
        fs.className = "fn";
        fs.textContent = baseOf(en.name);
        nm.appendChild(fs);

        nm.onclick = (ev) => openPicker(node, ev, idx);
        top.appendChild(nm);

        if (isMissing(en.name)) {
            const m = document.createElement("span");
            m.className = "lz-miss";
            m.textContent = "MISSING";
            m.title = "This file isn't in models/loras — it will be skipped.";
            top.appendChild(m);
        }

        const mini = (txt, tip, cls, fn) => {
            const b = document.createElement("span");
            b.className = "lz-mini " + cls;
            b.textContent = txt;
            b.title = tip;
            b.onclick = fn;
            return b;
        };

        top.appendChild(mini("⇄", en.split ? "Linked: use one strength for model + clip" : "Split model / clip strength",
            en.split ? "on" : "", () => {
                en.split = !en.split;
                if (!en.split) en.clip = en.model;
                else en.clip = en.model;
                commit();
            }));

        top.appendChild(mini("✕", "Remove", "x", () => {
            node.__stack.splice(idx, 1);
            commit();
        }));

        row.appendChild(top);

        const bars = document.createElement("div");
        bars.className = "lz-bars";

        if (en.split) {
            bars.appendChild(scrub("MODEL", () => en.model, v => { en.model = v; touch(); }));
            bars.appendChild(scrub("CLIP", () => en.clip, v => { en.clip = v; touch(); }));
        } else {
            bars.appendChild(scrub("", () => en.model, v => { en.model = v; en.clip = v; touch(); }));
        }

        row.appendChild(bars);

        return row;
    }

    function render() {
        const st = node.__stack || [];

        list.textContent = "";
        chip();

        if (!st.length) {
            const e = document.createElement("div");
            e.className = "lz-empty";
            e.innerHTML = `<div class="big">＋</div>Add your first LoRA`;
            e.onclick = (ev) => openPicker(node, ev);
            list.appendChild(e);
        } else {
            st.forEach((en, i) => list.appendChild(renderRow(en, i)));
        }

        fit(node);
    }

    $(".lz-add").onclick = (ev) => openPicker(node, ev);

    $(".lz-all").onclick = () => {
        const st = node.__stack;
        const anyOff = st.some(e => !e.on);
        st.forEach(e => { e.on = anyOff; });
        commit();
    };

    let armed = null;
    $(".lz-clear").onclick = () => {
        const b = $(".lz-clear");

        if (!node.__stack.length) return;

        if (!armed) {
            b.classList.add("warn");
            b.textContent = "?";
            b.title = "Click again to confirm";
            armed = setTimeout(() => { armed = null; b.classList.remove("warn"); b.textContent = "🗑"; b.title = "Remove all LoRAs"; }, 2000);
            return;
        }

        clearTimeout(armed);
        armed = null;
        b.classList.remove("warn");
        b.textContent = "🗑";
        node.__stack = [];
        commit();
    };

    node.__lzRender = render;
    node.__lzCommit = commit;

    if (typeof ResizeObserver !== "undefined") new ResizeObserver(() => fit(node)).observe(root);

    return root;
}

function buildUI(node) {
    if (node.__lzBuilt) return;
    node.__lzBuilt = true;

    hideWidget(dataW(node));
    loadStack(node);

    const panel = buildPanel(node);

    // ComfyUI force-sets an inline height on the element handed to addDOMWidget.
    // Hand it a holder instead, so `panel` keeps its natural content height and we can measure it.
    const holder = document.createElement("div");
    holder.style.cssText = "width:100%;overflow:visible;";
    holder.appendChild(panel);

    const getH = () => Math.max(panel.offsetHeight + 4, 110);

    const dw = node.addDOMWidget("lz_panel", "div", holder, {
        serialize: false,
        getHeight: getH,
        getMinHeight: getH,
    });

    dw.serializeValue = () => undefined;
    dw.computeSize = (w) => [w, getH()];

    node.__lzPanel = panel;
    node.__lzDW = dw;

    node.__lzRender();

    // widget y / panel height settle after the first draw — re-fit a couple of times
    setTimeout(() => fit(node), 60);
    setTimeout(() => fit(node), 400);

    // learn which files exist so missing LoRAs get flagged
    loras().then(() => node.__lzRender?.());
}


// ── extension ──────────────────────────────────────────────────────────────

app.registerExtension({
    name: "Nougan.LoraLoader",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData?.name !== NODE_NAME) return;

        nodeType.color = "#1a2a3a";
        nodeType.bgcolor = "#0f1923";

        const onc = nodeType.prototype.onNodeCreated;

        nodeType.prototype.onNodeCreated = function () {
            onc?.apply(this, arguments);
            this.size = [WIDTH, 200];

            try { buildUI(this); } catch (e) { console.warn("[Nougan Lora] UI build failed", e); }
        };

        const ocf = nodeType.prototype.onConfigure;

        nodeType.prototype.onConfigure = function () {
            ocf?.apply(this, arguments);

            try {
                if (!this.__lzBuilt) buildUI(this);

                loadStack(this);
                sync(this);
                this.__lzRender?.();

                setTimeout(() => fit(this), 60);
                setTimeout(() => fit(this), 400);
            } catch (e) {
                console.warn("[Nougan Lora] onConfigure failed", e);
            }
        };
    },
});
