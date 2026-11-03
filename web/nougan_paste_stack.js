// nougan_paste_stack.js — Automagic 2222: Paste Stack
//
// A floating, draggable clipboard-history widget for ComfyUI. Frontend only: no node, no Python.
//   • Hover the panel and left-click the paste area → whatever is on your clipboard (text or image) is saved.
//   • Hover + Ctrl+V, or drop files on it → text, images and text files are saved.
//   • Click any saved card → it goes back on your clipboard, ready to Ctrl+V anywhere (an old prompt, an image).
//   • Click-and-hold an image card and drag it onto a Load Image node → the image is uploaded and loaded into it.
//   • Files copied in Explorer/Finder paste with one click too (via nougan_paste_stack_server.py on the ComfyUI side).
//   • Drag any card up or down to reorder the stack (Alt+Up / Alt+Down on a focused card works too).
//   • Double-click a text card (or press F2) → it grows into an editor. Edits autosave; Esc, Ctrl+Enter, Done or clicking away closes it.
//   • "×" on a card deletes it. "×" in the header minimizes the panel to a small chip; click the chip to reopen.
//   • DOM for the UI, WebGPU for the animated backdrop (falls back to a plain CSS gradient without WebGPU).
//   • Settings → "Nougan Paste Stack: show widget" switches the whole widget off (and Ctrl+V goes back to normal).
//
// The stack lives in the browser's IndexedDB, so it survives refreshes and is shared by every workflow.

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const LS_UI = "nougan.pasteStack.ui";
const ID_ENABLED = "Nougan.PasteStack.Enabled";
const ID_LIMIT = "Nougan.PasteStack.Limit";
const ID_GPU = "Nougan.PasteStack.WebGPU";
const CHIP = 46;
const MAX_TEXT = 1_000_000;            // characters
const MAX_BLOB = 25 * 1024 * 1024;     // bytes
const TEXT_EXT = /\.(txt|md|markdown|json|csv|tsv|ya?ml|log|ini|toml|xml|html?|css|js|py)$/i;

// ─────────────────────────────────────────────────────────────────────────────
//  WebGPU backdrop: slow domain-warped noise, a soft glow that follows the pointer,
//  and a ripple that leaves the spot you last clicked.
// ─────────────────────────────────────────────────────────────────────────────
const WGSL = /* wgsl */ `
struct U {
  res: vec2f, time: f32, pulse: f32,
  mouse: vec2f, click: vec2f,
  hover: f32, fill: f32, pad: vec2f,
};
@group(0) @binding(0) var<uniform> u: U;

struct VO { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var o: VO;
  o.pos = vec4f(p[i], 0.0, 1.0);
  o.uv = vec2f(p[i].x * 0.5 + 0.5, 0.5 - p[i].y * 0.5);
  return o;
}

fn hash(p: vec2f) -> f32 {
  var q = fract(p * vec2f(123.34, 456.21));
  q = q + vec2f(dot(q, q + vec2f(45.32)));
  return fract(q.x * q.y);
}

fn noise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let s = f * f * (vec2f(3.0) - 2.0 * f);
  let a = hash(i);
  let b = hash(i + vec2f(1.0, 0.0));
  let c = hash(i + vec2f(0.0, 1.0));
  let d = hash(i + vec2f(1.0, 1.0));
  return mix(mix(a, b, s.x), mix(c, d, s.x), s.y);
}

fn fbm(p: vec2f) -> f32 {
  var q = p;
  var a = 0.5;
  var v = 0.0;
  for (var i = 0; i < 4; i = i + 1) {
    v = v + a * noise(q);
    q = q * 2.03 + vec2f(1.7, 9.2);
    a = a * 0.5;
  }
  return v;
}

@fragment fn fs(v: VO) -> @location(0) vec4f {
  let asp = u.res.x / u.res.y;
  let k = vec2f(asp, 1.0) * 2.4;
  let p = (v.uv - vec2f(0.5)) * k;
  let t = u.time * 0.05;

  let w = vec2f(fbm(p + vec2f(t, -t * 0.7)), fbm(p + vec2f(5.2, 1.3) - vec2f(t * 0.5)));
  let f = fbm(p + 2.0 * w);

  let base = vec3f(0.045, 0.062, 0.078);
  let teal = vec3f(0.10, 0.62, 0.58);
  let violet = vec3f(0.36, 0.26, 0.78);

  var col = base;
  col = mix(col, teal * 0.34, smoothstep(0.38, 0.85, f));
  col = mix(col, violet * 0.30, smoothstep(0.45, 0.95, w.x) * 0.8);
  col = col * (0.8 + 0.5 * u.fill);

  let m = (u.mouse - vec2f(0.5)) * k;
  let dm = length(p - m);
  col = col + teal * 0.20 * u.hover * exp(-dm * dm * 2.2);

  let c = (u.click - vec2f(0.5)) * k;
  let dc = length(p - c);
  let e = (dc - u.pulse * 1.6) * 7.0;
  col = col + vec3f(0.35, 0.95, 0.85) * exp(-e * e) * exp(-u.pulse * 1.8) * 0.5;

  let vd = length(v.uv - vec2f(0.5));
  col = col * (1.0 - 0.55 * smoothstep(0.25, 0.75, vd));
  return vec4f(col, 1.0);
}
`;

// ─────────────────────────────────────────────────────────────────────────────
//  Small helpers
// ─────────────────────────────────────────────────────────────────────────────
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));

function fmtAgo(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
async function hashBlob(blob) {
  try {
    const buf = await blob.arrayBuffer();
    if (window.crypto?.subtle) {
      const d = await crypto.subtle.digest("SHA-256", buf);
      return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
    }
  } catch { /* fall through */ }
  return `${blob.size}:${blob.type}`;
}
function getSetting(id, def) {
  try {
    const v = app.ui.settings.getSettingValue(id);
    return v === undefined || v === null ? def : v;
  } catch { return def; }
}

// ─────────────────────────────────────────────────────────────────────────────
//  IndexedDB (falls back to memory-only if the browser refuses)
// ─────────────────────────────────────────────────────────────────────────────
const DB_NAME = "nougan_paste_stack";
const STORE = "items";
let dbPromise = null;
let dbBroken = false;

function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: "id" });
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  return dbPromise;
}
async function dbTx(mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  Extension
// ─────────────────────────────────────────────────────────────────────────────
if (!window.__nouganPasteStackLoaded) {
  window.__nouganPasteStackLoaded = true;

  app.registerExtension({
    name: "Nougan.PasteStack",

    async setup() {
      // ---- settings ---------------------------------------------------------
      let limit = 50;
      let gpuWanted = true;
      let enabled = true;
      let applyEnabled = () => {};     // real version is assigned once the DOM exists
      const tryAdd = (def) => { try { app.ui.settings.addSetting(def); } catch { /* old frontend: defaults apply */ } };

      tryAdd({
        id: ID_ENABLED,
        name: "Nougan Paste Stack: show widget",
        type: "boolean",
        defaultValue: true,
        tooltip: "Turn the floating paste stack off. Ctrl+V and clipboard handling return to normal ComfyUI behavior.",
        onChange: (v) => { enabled = !!v; applyEnabled(); },
      });
      tryAdd({
        id: ID_LIMIT,
        name: "Nougan Paste Stack: maximum saved entries",
        type: "number",
        defaultValue: 50,
        attrs: { min: 5, max: 500, step: 5 },
        onChange: (v) => { limit = clamp(Number(v) || 50, 5, 500); try { trim(); render(); } catch { /* not ready yet */ } },
      });
      tryAdd({
        id: ID_GPU,
        name: "Nougan Paste Stack: WebGPU backdrop",
        type: "boolean",
        defaultValue: true,
        onChange: (v) => { gpuWanted = !!v; try { syncGpuVisibility(); } catch { /* not ready yet */ } },
      });
      enabled = !!getSetting(ID_ENABLED, true);
      limit = clamp(Number(getSetting(ID_LIMIT, 50)) || 50, 5, 500);
      gpuWanted = !!getSetting(ID_GPU, true);

      // ---- stylesheet -------------------------------------------------------
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = new URL("./css/nougan_paste_stack.css", import.meta.url).href;
      document.head.append(link);

      // ---- UI state ---------------------------------------------------------
      let ui = { x: null, y: null, w: 300, h: 310, cx: null, cy: null, state: "open" };
      try { Object.assign(ui, JSON.parse(localStorage.getItem(LS_UI) || "{}")); } catch { /* keep defaults */ }
      if (ui.x == null) { ui.x = Math.max(8, window.innerWidth - ui.w - 24); ui.y = 120; }
      const saveUi = () => { try { localStorage.setItem(LS_UI, JSON.stringify(ui)); } catch { /* ignore */ } };

      // ---- DOM --------------------------------------------------------------
      const root = el("div", "nps-root nps-empty");
      root.setAttribute("data-state", ui.state);
      root.setAttribute("data-gpu", "off");

      const panel = el("div", "nps-panel");
      panel.setAttribute("role", "region");
      panel.setAttribute("aria-label", "Paste stack");
      panel.style.width = `${ui.w}px`;
      panel.style.height = `${ui.h}px`;

      const canvas = el("canvas", "nps-gpu");
      canvas.setAttribute("aria-hidden", "true");

      const head = el("div", "nps-head");
      const title = el("span", "nps-title", "Paste stack");
      const countEl = el("span", "nps-count", "0 / 50");
      const clearBtn = el("button", "nps-btn", "Clear");
      clearBtn.type = "button";
      clearBtn.title = "Delete every saved entry";
      const closeBtn = el("button", "nps-btn nps-close", "×");
      closeBtn.type = "button";
      closeBtn.title = "Minimize";
      closeBtn.setAttribute("aria-label", "Minimize paste stack");
      head.append(title, countEl, clearBtn, closeBtn);

      const list = el("div", "nps-list");
      const drop = el("button", "nps-drop");
      drop.type = "button";
      const dropMain = el("span", "nps-drop-main", "Click here to paste");
      const dropHint = el("small", "", "Or hover and press Ctrl+V. You can also drop files here.");
      drop.append(dropMain, dropHint);

      const toastEl = el("div", "nps-toast");
      toastEl.setAttribute("role", "status");
      toastEl.setAttribute("aria-live", "polite");

      panel.append(canvas, head, list, drop, toastEl);

      const chip = el("button", "nps-chip");
      chip.type = "button";
      chip.title = "Paste stack — click to open";
      chip.setAttribute("aria-label", "Open paste stack");
      chip.innerHTML =
        '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="4" width="14" height="17" rx="2.5"/>' +
        '<path d="M9 4.5V3.8A1.3 1.3 0 0 1 10.3 2.5h3.4A1.3 1.3 0 0 1 15 3.8v.7"/><path d="M9 11h6M9 15h4"/></svg>';
      const badge = el("span", "nps-badge", "0");
      chip.append(badge);

      root.append(panel, chip);
      document.body.append(root);

      // ---- positioning ------------------------------------------------------
      function place() {
        const open = ui.state === "open";
        const w = open ? panel.offsetWidth || ui.w : CHIP;
        const h = open ? panel.offsetHeight || ui.h : CHIP;
        let x = open ? ui.x : ui.cx;
        let y = open ? ui.y : ui.cy;
        if (x == null) { x = window.innerWidth - CHIP - 24; y = window.innerHeight - CHIP - 24; }
        x = clamp(x, 0, window.innerWidth - w);
        y = clamp(y, 0, window.innerHeight - h);
        if (open) { ui.x = x; ui.y = y; } else { ui.cx = x; ui.cy = y; }
        root.style.left = `${x}px`;
        root.style.top = `${y}px`;
      }
      function minimize() {
        ui.cx = ui.x + (panel.offsetWidth || ui.w) - CHIP;
        ui.cy = ui.y;
        ui.state = "chip";
        root.setAttribute("data-state", "chip");
        place(); saveUi(); stopLoop();
      }
      function expand() {
        ui.x = (ui.cx ?? ui.x) + CHIP - ui.w;
        ui.y = ui.cy ?? ui.y;
        ui.state = "open";
        root.setAttribute("data-state", "open");
        place(); saveUi(); sizeCanvas(); startLoop();
      }
      closeBtn.addEventListener("click", minimize);
      chip.addEventListener("click", (e) => { if (e.detail === 0) expand(); });   // keyboard activation
      window.addEventListener("resize", () => { if (!enabled) return; place(); sizeCanvas(); });

      function makeDraggable(handle, { ignore, get, set, tap }) {
        let sx = 0, sy = 0, ox = 0, oy = 0, moved = false, active = false;
        handle.addEventListener("pointerdown", (e) => {
          if (e.button !== 0 || (ignore && e.target.closest(ignore))) return;
          active = true; moved = false; sx = e.clientX; sy = e.clientY;
          [ox, oy] = get();
          try { handle.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        });
        handle.addEventListener("pointermove", (e) => {
          if (!active) return;
          const dx = e.clientX - sx, dy = e.clientY - sy;
          if (!moved && Math.hypot(dx, dy) < 4) return;
          moved = true;
          set(ox + dx, oy + dy);
        });
        handle.addEventListener("pointerup", (e) => {
          if (!active) return;
          active = false;
          try { handle.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
          if (moved) saveUi(); else if (tap) tap(e);
        });
        handle.addEventListener("pointercancel", () => { active = false; });
      }
      makeDraggable(head, {
        ignore: "button",
        get: () => [ui.x, ui.y],
        set: (x, y) => { ui.x = x; ui.y = y; place(); },
      });
      makeDraggable(chip, {
        get: () => [ui.cx, ui.cy],
        set: (x, y) => { ui.cx = x; ui.cy = y; place(); },
        tap: () => expand(),
      });

      let editBoost = false;     // true while the panel is temporarily taller for editing

      // Persist the size the user drags the panel to, and keep the WebGPU canvas matched to it.
      // Skipped while the widget is switched off: a hidden panel measures 0×0 and must not be saved.
      let sizeTimer = 0;
      if (window.ResizeObserver) {
        new ResizeObserver(() => {
          if (ui.state !== "open" || !enabled) return;
          if (editBoost) { sizeCanvas(); return; }          // temporary editing size: don't save it
          ui.w = panel.offsetWidth; ui.h = panel.offsetHeight;
          clearTimeout(sizeTimer);
          sizeTimer = setTimeout(() => { place(); saveUi(); }, 150);
          sizeCanvas();
        }).observe(panel);
      }

      // ---- toast ------------------------------------------------------------
      let toastTimer = 0;
      function toast(msg, ms = 2400) {
        toastEl.textContent = msg;
        toastEl.classList.add("nps-on");
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => toastEl.classList.remove("nps-on"), ms);
      }

      // ---- data -------------------------------------------------------------
      let items = [];            // newest first
      let urls = [];             // object URLs for thumbnails, revoked on every re-render

      const persist = async (fn) => {
        if (dbBroken) return;
        try { await fn(); } catch {
          dbBroken = true;
          toast("Saving is blocked in this browser. Your stack will last until you refresh.", 4200);
        }
      };

      try {
        const stored = await dbTx("readonly", (s) => s.getAll());
        const all = stored || [];
        // `ord` is the manual order (lowest = top). Older entries without it go on top, newest first.
        const ordered = all.filter((x) => typeof x.ord === "number").sort((a, b) => a.ord - b.ord);
        const legacy = all.filter((x) => typeof x.ord !== "number").sort((a, b) => b.ts - a.ts);
        const top = ordered.length ? ordered[0].ord : 0;
        legacy.forEach((x, i) => { x.ord = top - (legacy.length - i); });
        items = [...legacy, ...ordered];
        if (legacy.length) persist(() => dbTx("readwrite", (s) => { legacy.forEach((x) => s.put(x)); }));
      } catch { dbBroken = true; }

      function trim() {
        while (items.length > limit) {                     // drop the oldest entry, wherever you've moved it
          let oi = 0;
          items.forEach((x, i) => { if (x.ts < items[oi].ts) oi = i; });
          const [old] = items.splice(oi, 1);
          persist(() => dbTx("readwrite", (s) => s.delete(old.id)));
        }
      }

      async function addItem(it) {
        let moved = false;
        const i = items.findIndex((x) => x.key === it.key && x.kind === it.kind);
        if (i >= 0) {
          const [old] = items.splice(i, 1);
          persist(() => dbTx("readwrite", (s) => s.delete(old.id)));
          moved = true;
        }
        it.id = uid();
        it.ts = Date.now();
        it.ord = items.length ? items[0].ord - 1 : 0;
        items.unshift(it);
        persist(() => dbTx("readwrite", (s) => s.put(it)));
        trim();
        render();
        list.scrollTop = 0;
        flashChip();
        return moved ? "moved" : "added";
      }
      async function removeItem(id) {
        items = items.filter((x) => x.id !== id);
        persist(() => dbTx("readwrite", (s) => s.delete(id)));
        render();
      }

      async function addText(text, name) {
        if (!text || !text.trim()) return null;
        if (text.length > MAX_TEXT) { toast("That text is too long to save (over 1,000,000 characters)."); return null; }
        const key = await hashBlob(new Blob([text]));
        return addItem({ kind: "text", text, name: name || "", key });
      }
      async function addImage(blob, name) {
        if (blob.size > MAX_BLOB) { toast("That image is over 25 MB, so it wasn't saved."); return null; }
        let w = 0, h = 0;
        try { const bmp = await createImageBitmap(blob); w = bmp.width; h = bmp.height; bmp.close?.(); } catch { /* size unknown */ }
        const key = await hashBlob(blob);
        return addItem({ kind: "image", blob, w, h, name: name || "", mime: blob.type, key });
      }
      async function addFile(file) {
        if (!file.type && /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(file.name)) {
          const ext = file.name.split(".").pop().toLowerCase().replace("jpg", "jpeg");
          file = new File([file], file.name, { type: `image/${ext}` });
        }
        if (file.type.startsWith("image/")) return addImage(file, file.name);
        if (file.type.startsWith("text/") || file.type === "application/json" || TEXT_EXT.test(file.name)) {
          if (file.size > MAX_TEXT) { toast(`${file.name} is too large to save as text.`); return null; }
          return addText(await file.text(), file.name);
        }
        if (file.size > MAX_BLOB) { toast(`${file.name} is over 25 MB, so it wasn't saved.`); return null; }
        const key = await hashBlob(file);
        return addItem({ kind: "file", blob: file, name: file.name, mime: file.type, key });
      }
      function report(results) {
        const added = results.filter((r) => r === "added").length;
        const moved = results.filter((r) => r === "moved").length;
        if (added) toast(added > 1 ? `Saved ${added} items.` : "Saved.");
        else if (moved) toast("Already in your stack. Moved it to the top.");
        else if (!results.length || results.every((r) => r == null)) toast("Nothing to save from the clipboard.");
      }
      async function addFiles(files) {
        const out = [];
        for (const f of files) out.push(await addFile(f));
        report(out);
      }

      // ---- reorder ----------------------------------------------------------
      // `toIndex` is the position in the list after the card has been lifted out.
      function moveItem(id, toIndex) {
        const from = items.findIndex((x) => x.id === id);
        if (from < 0) return false;
        toIndex = clamp(toIndex, 0, items.length - 1);
        if (toIndex === from) return false;
        const [it] = items.splice(from, 1);
        items.splice(toIndex, 0, it);
        const prev = items[toIndex - 1], next = items[toIndex + 1];
        let ord;
        if (!prev && !next) ord = 0;
        else if (!prev) ord = next.ord - 1;
        else if (!next) ord = prev.ord + 1;
        else ord = (prev.ord + next.ord) / 2;
        if (prev && next && !(ord > prev.ord && ord < next.ord)) {     // ran out of float room: renumber
          items.forEach((x, i) => { x.ord = i; });
          persist(() => dbTx("readwrite", (s) => { items.forEach((x) => s.put(x)); }));
        } else {
          it.ord = ord;
          persist(() => dbTx("readwrite", (s) => s.put(it)));
        }
        render();
        return true;
      }

      // ---- edit a text card ---------------------------------------------------
      const EDIT_MIN_H = 440;
      let editing = null;        // { it, card, ta, statusEl, timer, restore }
      const saveSeq = new WeakMap();

      async function saveText(it, text) {
        const n = (saveSeq.get(it) || 0) + 1;
        saveSeq.set(it, n);
        it.text = text;
        const key = await hashBlob(new Blob([text]));
        if (saveSeq.get(it) !== n || !items.includes(it)) return;     // newer save running, or card was deleted
        it.key = key;
        await persist(() => dbTx("readwrite", (s) => s.put(it)));
      }

      function boostPanel(ed) {
        if (ui.state !== "open") return;
        const h = panel.offsetHeight;
        const want = Math.min(Math.max(h, EDIT_MIN_H), window.innerHeight - 16);
        if (want <= h + 4) return;
        ed.restore = { h: ui.h, y: ui.y };
        editBoost = true;
        panel.style.height = `${want}px`;
        ui.y = clamp(ui.y, 8, window.innerHeight - want - 8);
        place();
        ed.restore.boostedH = panel.offsetHeight;
        ed.restore.boostedY = ui.y;
      }
      function unboostPanel(ed) {
        if (!ed.restore) return;
        const r = ed.restore;
        editBoost = false;
        if (panel.offsetHeight === r.boostedH) {          // untouched by the user: put the old size back
          panel.style.height = `${r.h}px`;
          ui.h = r.h;
          if (ui.y === r.boostedY) ui.y = r.y;
        } else { ui.h = panel.offsetHeight; }
        place(); saveUi(); sizeCanvas();
      }

      function endEdit(rerender = true) {
        const ed = editing;
        if (!ed) return;
        editing = null;
        clearTimeout(ed.timer);
        const text = ed.ta.value;
        if (items.includes(ed.it)) {
          if (!text.trim()) { if (text !== ed.it.text) toast("Empty text can't be saved, so I kept the previous version."); }
          else if (text !== ed.it.text) saveText(ed.it, text);
        }
        unboostPanel(ed);
        if (rerender) render();
      }

      function startEdit(it, card) {
        if (it.kind !== "text") return;
        if (editing) {
          if (editing.it === it) return;
          endEdit();
          card = list.querySelector(`[data-id="${it.id}"]`);
          if (!card) return;
        }
        const textDiv = card.querySelector(".nps-text");
        if (!textDiv) return;

        const ta = el("textarea", "nps-edit");
        ta.value = it.text;
        ta.maxLength = MAX_TEXT;
        ta.spellcheck = false;
        ta.setAttribute("aria-label", "Edit this entry. Changes save automatically.");
        textDiv.replaceWith(ta);

        const meta = card.querySelector(".nps-meta");
        const statusEl = el("span", "nps-status", "Editing. Saves automatically.");
        const done = el("button", "nps-btn nps-done", "Done");
        done.type = "button";
        done.title = "Finish editing (Esc)";
        done.addEventListener("pointerdown", (e) => e.preventDefault());    // keep focus so blur doesn't fire first
        done.addEventListener("click", (e) => { e.stopPropagation(); endEdit(); });
        meta.replaceChildren(statusEl, done);

        card.classList.add("nps-editing");
        card.setAttribute("role", "group");
        card.removeAttribute("title");
        card.setAttribute("aria-label", "Editing text entry");

        const ed = { it, card, ta, statusEl, timer: 0, restore: null };
        editing = ed;
        boostPanel(ed);
        card.style.minHeight = `${Math.max(190, list.clientHeight - 14)}px`;
        card.scrollIntoView?.({ block: "nearest" });

        const count = () => `${ta.value.length.toLocaleString()} characters`;
        ta.addEventListener("input", () => {
          statusEl.textContent = "Saving…";
          clearTimeout(ed.timer);
          ed.timer = setTimeout(async () => {
            if (editing !== ed) return;
            const v = ta.value;
            if (!v.trim()) { statusEl.textContent = "Empty text isn't saved"; return; }
            if (v !== it.text) await saveText(it, v);
            if (editing === ed) statusEl.textContent = `Saved · ${count()}`;
          }, 600);
        });
        ta.addEventListener("keydown", (e) => {
          if (e.key === "Escape" || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) {
            e.preventDefault(); e.stopPropagation();
            endEdit();
          }
        });
        ta.addEventListener("blur", () => { setTimeout(() => { if (editing === ed) endEdit(); }, 0); });
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
        ta.scrollTop = ta.scrollHeight;
      }

      // ---- clipboard in -----------------------------------------------------
      // Browsers can read text and image data on a click, but never files copied in Explorer/Finder.
      // ComfyUI's server runs on this machine, so for files we ask it (nougan_paste_stack_server.py).
      async function serverClipboardFiles() {
        try {
          const r = await api.fetchApi("/nougan/paste_stack/clipboard", { method: "POST", headers: { "X-Nougan-Paste": "1" } });
          if (!r.ok) return [];
          const j = await r.json();
          return (j.files || []).map((f) => {
            const bin = atob(f.data);
            const u8 = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
            return new File([u8], f.name, { type: f.mime });
          });
        } catch { return []; }
      }
      const LOOKS_LIKE_IMAGE_PATH = /^(?:[A-Za-z]:\\|\/)[^\r\n]*\.(?:png|jpe?g|webp|gif|bmp|avif)$/i;

      async function pasteFromClipboard() {
        let out = [];
        let blocked = false;
        if (navigator.clipboard && window.isSecureContext) {
          try {
            if (navigator.clipboard.read) {
              for (const c of await navigator.clipboard.read()) {
                if (c.types.includes("text/plain")) {
                  const text = await (await c.getType("text/plain")).text();
                  if (LOOKS_LIKE_IMAGE_PATH.test(text.trim())) continue;   // a copied file's path, not a prompt: use the file itself
                  out.push(await addText(text));
                } else {
                  const imgType = c.types.find((t) => t.startsWith("image/"));
                  if (imgType) out.push(await addImage(await c.getType(imgType)));
                }
              }
            } else {
              out.push(await addText(await navigator.clipboard.readText()));
            }
          } catch (err) {
            blocked = !!err && err.name === "NotAllowedError";
            if (!blocked) { try { out.push(await addText(await navigator.clipboard.readText())); } catch { /* nothing */ } }
          }
        }
        if (out.some(Boolean)) { report(out); return; }

        const files = await serverClipboardFiles();
        if (files.length) { await addFiles(files); return; }

        if (blocked) toast("Clipboard access is blocked. Allow it in the address bar, or hover and press Ctrl+V.", 4800);
        else toast("Nothing to paste yet. Copy some text, an image, or a file, then click again.", 3600);
      }

      // ---- clipboard out ----------------------------------------------------
      async function writeText(text) {
        if (navigator.clipboard?.writeText && window.isSecureContext) {
          await navigator.clipboard.writeText(text);
          return;
        }
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
        document.body.append(ta);
        ta.select();
        const ok = document.execCommand("copy");
        ta.remove();
        if (!ok) throw new Error("copy blocked");
      }
      async function toPng(blob) {
        const bmp = await createImageBitmap(blob);
        const c = document.createElement("canvas");
        c.width = bmp.width; c.height = bmp.height;
        c.getContext("2d").drawImage(bmp, 0, 0);
        bmp.close?.();
        return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("png failed"))), "image/png"));
      }
      async function writeImage(blob) {
        if (!navigator.clipboard?.write || !window.ClipboardItem || !window.isSecureContext) {
          throw new Error("image copy needs localhost or https");
        }
        const png = blob.type === "image/png" ? blob : await toPng(blob);
        await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
      }
      function download(it) {
        const a = document.createElement("a");
        const url = URL.createObjectURL(it.blob);
        a.href = url; a.download = it.name || "paste";
        document.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
      }
      async function copyItem(it, card, ev) {
        if (ev) ripple(ev.clientX, ev.clientY);
        try {
          if (it.kind === "text") { await writeText(it.text); toast("Copied. Press Ctrl+V to use it."); }
          else if (it.kind === "image") { await writeImage(it.blob); toast("Image copied. Press Ctrl+V to use it."); }
          else { download(it); toast(`Downloaded ${it.name}. Files can't go back on the clipboard.`, 3600); return; }
          card.classList.add("nps-copied");
          setTimeout(() => card.classList.remove("nps-copied"), 900);
        } catch (err) {
          toast(String(err?.message || "").includes("localhost")
            ? "Copying an image needs localhost or https."
            : "The browser blocked that copy. Click the card again.", 3600);
        }
      }

      // ---- drag cards: reorder inside the panel, or drop an image on a Load Image node ----------
      let drag = null;
      let justDragged = false;
      const ghost = el("div", "nps-ghost");
      const ghostImg = el("img");
      ghostImg.alt = ""; ghostImg.draggable = false;
      ghost.hidden = true;
      const targetBox = el("div", "nps-target");
      targetBox.hidden = true;
      const insertBar = el("div", "nps-insert");
      insertBar.hidden = true;
      root.append(ghost, targetBox, insertBar);

      const graphOf = () => app.canvas?.graph ?? app.graph;
      // Any node with an input-folder "image" combo (Load Image, Load Image (as Mask), custom loaders).
      function imageWidgetOf(node) {
        if (!node || node.flags?.collapsed || node.comfyClass === "LoadImageOutput") return null;
        return node.widgets?.find((w) => w.name === "image" && (w.type === "combo" || w.options?.values)) || null;
      }
      function nodeAt(cx, cy) {
        const c = app.canvas;
        if (!c?.canvas || document.elementFromPoint(cx, cy) !== c.canvas) return null;   // not over the graph canvas
        const rect = c.canvas.getBoundingClientRect();
        const gx = (cx - rect.left) / c.ds.scale - c.ds.offset[0];
        const gy = (cy - rect.top) / c.ds.scale - c.ds.offset[1];
        return graphOf()?.getNodeOnPos?.(gx, gy) ?? null;
      }
      function showTarget(node) {
        if (!node) { targetBox.hidden = true; return; }
        const c = app.canvas, ds = c.ds, rect = c.canvas.getBoundingClientRect();
        const th = window.LiteGraph?.NODE_TITLE_HEIGHT ?? 30;
        targetBox.style.left = `${rect.left + (node.pos[0] + ds.offset[0]) * ds.scale - 3}px`;
        targetBox.style.top = `${rect.top + (node.pos[1] - th + ds.offset[1]) * ds.scale - 3}px`;
        targetBox.style.width = `${node.size[0] * ds.scale + 6}px`;
        targetBox.style.height = `${(node.size[1] + th) * ds.scale + 6}px`;
        targetBox.hidden = false;
      }
      async function uploadImage(it) {
        const sub = (it.blob.type.split("/")[1] || "png").replace("jpeg", "jpg").replace(/\+.*$/, "");
        let name = (it.name || "").replace(/[\\/:*?"<>|]+/g, "_").trim() || `paste_${it.id}`;
        if (!/\.[a-z0-9]{2,5}$/i.test(name)) name += `.${sub}`;
        const fd = new FormData();
        fd.append("image", new File([it.blob], name, { type: it.blob.type || "image/png" }));
        fd.append("type", "input");
        fd.append("overwrite", "false");        // ComfyUI reuses the file if identical, otherwise renames it
        const r = await api.fetchApi("/upload/image", { method: "POST", body: fd });
        if (!r.ok) throw new Error(`upload failed (${r.status})`);
        const j = await r.json();
        return j.subfolder ? `${j.subfolder}/${j.name}` : j.name;
      }
      async function dropOnNode(it, node) {
        const w = imageWidgetOf(node);
        if (!w) return;
        try {
          const name = await uploadImage(it);
          const old = w.value;
          if (Array.isArray(w.options?.values) && !w.options.values.includes(name)) w.options.values.push(name);
          w.value = name;
          try { w.callback?.(name, app.canvas, node); } catch { /* preview refresh is best effort */ }
          try { node.onWidgetChanged?.(w.name, name, old, w); } catch { /* ignore */ }
          try { graphOf()?.change?.(); } catch { /* ignore */ }
          app.canvas?.setDirty?.(true, true);
          toast(`Loaded into ${node.title || node.type}.`);
        } catch (err) {
          toast(`Couldn't load it: ${err?.message || "upload failed"}`, 4200);
        }
      }

      const inRect = (x, y, r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;

      // Where would the dragged card land? Returns the index among the *other* cards plus the bar position.
      function reorderSpot(y) {
        const others = [...list.querySelectorAll(".nps-card")].filter((c) => c !== drag.card);
        let idx = others.length;
        for (let i = 0; i < others.length; i++) {
          const r = others[i].getBoundingClientRect();
          if (y < r.top + r.height / 2) { idx = i; break; }
        }
        const lr = list.getBoundingClientRect();
        let by;
        if (!others.length) by = lr.top + 8;
        else if (idx < others.length) by = others[idx].getBoundingClientRect().top - 3;
        else by = others[others.length - 1].getBoundingClientRect().bottom + 3;
        return { idx, by: clamp(by, lr.top, lr.bottom - 3), left: lr.left + 8, width: lr.width - 16 };
      }
      function updateReorder() {
        const spot = reorderSpot(drag.y);
        drag.spot = spot;
        insertBar.style.left = `${spot.left}px`;
        insertBar.style.top = `${spot.by}px`;
        insertBar.style.width = `${spot.width}px`;
        insertBar.hidden = false;
      }

      function onDragKey(e) { if (e.key === "Escape") endDrag(null, true); }
      function startDrag() {
        drag.active = true;
        ghost.replaceChildren();
        ghost.classList.toggle("nps-ghost-text", drag.it.kind !== "image");
        if (drag.it.kind === "image") {
          ghostImg.src = drag.card.querySelector("img")?.src || "";
          ghost.append(ghostImg);
        } else {
          ghost.append(el("div", "nps-ghost-line", drag.it.kind === "text" ? drag.it.text.slice(0, 160) : (drag.it.name || "file")));
        }
        ghost.hidden = false;
        drag.card.classList.add("nps-dragging");
        document.body.style.cursor = "grabbing";
        window.addEventListener("keydown", onDragKey, true);
        drag.scroller = setInterval(() => {           // auto-scroll the list when you hold near its edge
          if (!drag || drag.mode !== "reorder") return;
          const lr = list.getBoundingClientRect();
          const edge = 30;
          if (drag.y < lr.top + edge) list.scrollTop -= 12;
          else if (drag.y > lr.bottom - edge) list.scrollTop += 12;
          else return;
          updateReorder();
        }, 30);
      }
      function moveDrag(e) {
        drag.x = e.clientX; drag.y = e.clientY;
        ghost.style.transform = `translate(${e.clientX + 14}px, ${e.clientY + 14}px)`;
        const inside = inRect(e.clientX, e.clientY, panel.getBoundingClientRect());
        drag.mode = inside ? "reorder" : "node";
        if (inside) {
          drag.node = null;
          targetBox.hidden = true;
          ghost.classList.remove("nps-ok");
          updateReorder();
        } else {
          insertBar.hidden = true;
          drag.spot = null;
          const node = drag.it.kind === "image" ? nodeAt(e.clientX, e.clientY) : null;
          const ok = imageWidgetOf(node) ? node : null;
          drag.node = ok;
          showTarget(ok);
          ghost.classList.toggle("nps-ok", !!ok);
        }
      }
      function endDrag(e, cancel) {
        if (!drag) return;
        const d = drag;
        drag = null;
        clearInterval(d.scroller);
        try { d.card.releasePointerCapture(d.id); } catch { /* ignore */ }
        ghost.hidden = true; ghost.classList.remove("nps-ok");
        targetBox.hidden = true;
        insertBar.hidden = true;
        d.card.classList.remove("nps-dragging");
        document.body.style.cursor = "";
        window.removeEventListener("keydown", onDragKey, true);
        if (!d.active) return;                         // never moved far enough: it's a plain click
        justDragged = true;
        setTimeout(() => { justDragged = false; }, 60);   // the card may be rebuilt, so its click might never arrive
        if (cancel) return;
        if (d.mode === "reorder" && d.spot) moveItem(d.it.id, d.spot.idx);
        else if (d.node) dropOnNode(d.it, d.node);
        else if (d.it.kind === "image") toast("Drop it on a Load Image node to use it, or inside the stack to reorder.");
      }
      function attachDrag(card, it) {
        card.addEventListener("pointerdown", (e) => {
          if (e.button !== 0 || e.target.closest(".nps-x, .nps-done, .nps-edit") || card.classList.contains("nps-editing")) return;
          justDragged = false;
          drag = { it, card, id: e.pointerId, sx: e.clientX, sy: e.clientY, x: e.clientX, y: e.clientY,
                   active: false, node: null, mode: "reorder", spot: null, scroller: 0 };
          try { card.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        });
        card.addEventListener("pointermove", (e) => {
          if (!drag || drag.card !== card) return;
          if (!drag.active) {
            if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 6) return;
            startDrag();
          }
          moveDrag(e);
        });
        card.addEventListener("pointerup", (e) => { if (drag?.card === card) endDrag(e, false); });
        card.addEventListener("pointercancel", (e) => { if (drag?.card === card) endDrag(e, true); });
      }

      // ---- render -----------------------------------------------------------
      function cardEl(it) {
        const card = el("div", "nps-card");
        card.tabIndex = 0;
        card.setAttribute("role", "button");
        card.setAttribute("aria-label", it.kind === "file" ? `Download ${it.name}` : `Copy this ${it.kind} entry`);
        card.dataset.id = it.id;
        card.dataset.kind = it.kind;
        card.title = it.kind === "image"
          ? "Click to copy. Drag to reorder, or drag onto a Load Image node to use it."
          : it.kind === "text"
            ? "Click to copy. Double-click to edit. Drag to reorder."
            : "Click to download. Drag to reorder.";

        const meta = el("div", "nps-meta");
        const left = el("span");
        const when = el("span", "", fmtAgo(it.ts));
        when.dataset.ts = String(it.ts);
        when.title = new Date(it.ts).toLocaleString();

        if (it.kind === "text") {
          card.append(el("div", "nps-text", it.text.length > 400 ? it.text.slice(0, 400) : it.text));
          left.textContent = (it.name ? `${it.name}, ` : "") + `${it.text.length.toLocaleString()} characters`;
        } else if (it.kind === "image") {
          const img = el("img", "nps-thumb");
          const u = URL.createObjectURL(it.blob);
          urls.push(u);
          img.src = u; img.alt = ""; img.draggable = false;
          card.append(img);
          left.textContent = it.w ? `${it.w}×${it.h} image` : "image";
        } else {
          card.append(el("div", "nps-text", it.name || "file"));
          left.textContent = `${fmtBytes(it.blob.size)}, click to download`;
        }
        meta.append(left, when);
        card.append(meta);

        const x = el("button", "nps-x", "×");
        x.type = "button";
        x.title = "Delete";
        x.setAttribute("aria-label", "Delete this entry");
        x.addEventListener("click", (e) => { e.stopPropagation(); removeItem(it.id); });
        card.append(x);

        let copyTimer = 0;
        card.addEventListener("click", (e) => {
          if (justDragged) { justDragged = false; return; }       // that click was the end of a drag
          if (editing?.card === card || e.target.closest(".nps-edit, .nps-done")) return;
          if (it.kind !== "text") { copyItem(it, card, e); return; }
          // Text cards wait a beat so a double-click means "edit", not "copy twice".
          clearTimeout(copyTimer);
          if (e.detail > 1) return;
          const pos = { clientX: e.clientX, clientY: e.clientY };
          copyTimer = setTimeout(() => copyItem(it, card, pos), 230);
        });
        card.addEventListener("dblclick", (e) => {
          if (it.kind !== "text" || e.target.closest(".nps-x")) return;
          clearTimeout(copyTimer);
          startEdit(it, card);
        });
        attachDrag(card, it);
        card.addEventListener("keydown", (e) => {
          if (e.target !== card) return;
          if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
            e.preventDefault();
            const from = items.findIndex((x) => x.id === it.id);
            if (moveItem(it.id, from + (e.key === "ArrowUp" ? -1 : 1))) {
              list.querySelector(`[data-id="${it.id}"]`)?.focus();
            }
          } else if (e.key === "F2" && it.kind === "text") {
            e.preventDefault(); startEdit(it, card);
          } else if (e.key === "Enter" || e.key === " ") {
            e.preventDefault(); copyItem(it, card);
          }
        });
        return card;
      }
      function render() {
        if (editing) endEdit(false);          // the card is about to be rebuilt: save and close the editor
        urls.forEach((u) => URL.revokeObjectURL(u));
        urls = [];
        const frag = document.createDocumentFragment();
        items.forEach((it) => frag.append(cardEl(it)));
        list.replaceChildren(frag);
        const n = items.length;
        countEl.textContent = `${n} / ${limit}`;
        badge.textContent = String(n);
        clearBtn.disabled = n === 0;
        root.classList.toggle("nps-empty", n === 0);
        fill = Math.min(1, n / limit);
      }
      setInterval(() => {
        if (!enabled) return;
        panel.querySelectorAll("[data-ts]").forEach((s) => { s.textContent = fmtAgo(Number(s.dataset.ts)); });
      }, 30000);

      function flashChip() {
        if (ui.state !== "chip") return;
        chip.classList.remove("nps-flash");
        void chip.offsetWidth;
        chip.classList.add("nps-flash");
      }

      // ---- clear all (two clicks) --------------------------------------------
      let armTimer = 0;
      clearBtn.addEventListener("click", () => {
        if (clearBtn.dataset.armed === "1") {
          clearTimeout(armTimer);
          clearBtn.dataset.armed = "0"; clearBtn.textContent = "Clear";
          items = [];
          persist(() => dbTx("readwrite", (s) => s.clear()));
          render(); toast("Stack cleared.");
        } else {
          clearBtn.dataset.armed = "1"; clearBtn.textContent = "Clear all?";
          armTimer = setTimeout(() => { clearBtn.dataset.armed = "0"; clearBtn.textContent = "Clear"; }, 2600);
        }
      });

      // ---- input wiring -----------------------------------------------------
      let hovering = false;
      root.addEventListener("pointerenter", () => { hovering = true; hoverTarget = 1; });
      root.addEventListener("pointerleave", () => { hovering = false; hoverTarget = 0; });
      panel.addEventListener("pointermove", (e) => {
        const r = panel.getBoundingClientRect();
        mouse.x = (e.clientX - r.left) / r.width;
        mouse.y = (e.clientY - r.top) / r.height;
      });

      drop.addEventListener("click", (e) => { ripple(e.clientX, e.clientY); pasteFromClipboard(); });
      list.addEventListener("click", (e) => {            // free space between cards pastes too
        if (e.target === list) { ripple(e.clientX, e.clientY); pasteFromClipboard(); }
      });

      // Ctrl+V while hovering. Capture phase + stopImmediatePropagation so ComfyUI doesn't also
      // turn the clipboard into a new Load Image node. If a text box has focus we leave it alone.
      // When the widget is switched off in Settings, do nothing so ComfyUI's own paste works normally.
      window.addEventListener("paste", async (e) => {
        if (!enabled) return;
        const ae = document.activeElement;
        if (ae?.classList?.contains("nps-edit")) return;       // pasting into the editor is a normal paste
        if (!hovering && !(ae && root.contains(ae))) return;
        if (ae && ae !== document.body && !root.contains(ae) &&
            (ae.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName))) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        ripple();
        const dt = e.clipboardData;
        if (!dt) return;
        let files = [...(dt.files || [])];
        if (!files.length && dt.items) {
          files = [...dt.items].filter((i) => i.kind === "file").map((i) => i.getAsFile()).filter(Boolean);
        }
        if (files.length) { await addFiles(files); return; }
        report([await addText(dt.getData("text/plain"))]);
      }, true);

      // Drag and drop files (or dragged text) onto the panel.
      let dragDepth = 0;
      panel.addEventListener("dragenter", (e) => { e.preventDefault(); dragDepth++; root.classList.add("nps-dragover"); });
      panel.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; root.classList.remove("nps-dragover"); } });
      panel.addEventListener("dragover", (e) => { e.preventDefault(); e.stopPropagation(); });
      panel.addEventListener("drop", async (e) => {
        e.preventDefault(); e.stopPropagation();
        dragDepth = 0; root.classList.remove("nps-dragover");
        ripple(e.clientX, e.clientY);
        const files = [...(e.dataTransfer?.files || [])];
        if (files.length) await addFiles(files);
        else report([await addText(e.dataTransfer?.getData("text/plain") || "")]);
      });

      // ---- WebGPU backdrop ----------------------------------------------------
      const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      const mouse = { x: 0.5, y: 0.5 };
      const clickPos = { x: 0.5, y: 0.5 };
      let clickAt = -1e9;
      let hoverCur = 0, hoverTarget = 0, fill = 0;
      const t0 = performance.now();
      const f32 = new Float32Array(12);
      let gpu = null;
      let gpuTried = false;      // the GPU device is only requested once the widget is actually shown
      let raf = 0, lastDraw = 0;

      function ripple(cx, cy) {
        if (cx != null) {
          const r = panel.getBoundingClientRect();
          clickPos.x = (cx - r.left) / r.width;
          clickPos.y = (cy - r.top) / r.height;
        } else { clickPos.x = 0.5; clickPos.y = 0.5; }
        clickAt = performance.now();
        if (reduceMotion && gpu) drawGpu(performance.now());
      }

      function sizeCanvas() {
        if (!gpu || ui.state !== "open" || !enabled) return;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const scale = 0.5;      // soft noise doesn't need full resolution
        const w = Math.max(2, Math.round(panel.clientWidth * dpr * scale));
        const h = Math.max(2, Math.round(panel.clientHeight * dpr * scale));
        if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
        if (reduceMotion) drawGpu(performance.now());
      }

      async function initGpu() {
        try {
          if (!navigator.gpu) return false;
          const adapter = await navigator.gpu.requestAdapter();
          if (!adapter) return false;
          const device = await adapter.requestDevice();
          const ctx = canvas.getContext("webgpu");
          if (!ctx) return false;
          const format = navigator.gpu.getPreferredCanvasFormat();
          ctx.configure({ device, format, alphaMode: "opaque" });
          const module = device.createShaderModule({ code: WGSL });
          const info = await module.getCompilationInfo?.();
          if (info && info.messages.some((m) => m.type === "error")) {
            console.warn("[Nougan Paste Stack] shader errors:", info.messages);
            return false;
          }
          const pipeline = device.createRenderPipeline({
            layout: "auto",
            vertex: { module, entryPoint: "vs" },
            fragment: { module, entryPoint: "fs", targets: [{ format }] },
            primitive: { topology: "triangle-list" },
          });
          const ubuf = device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
          const bind = device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [{ binding: 0, resource: { buffer: ubuf } }],
          });
          device.lost.then(() => { gpu = null; stopLoop(); root.setAttribute("data-gpu", "off"); });
          gpu = { device, ctx, pipeline, ubuf, bind };
          return true;
        } catch (err) {
          console.warn("[Nougan Paste Stack] WebGPU unavailable, using the CSS backdrop.", err);
          return false;
        }
      }

      function drawGpu(now) {
        if (!gpu) return;
        hoverCur += (hoverTarget - hoverCur) * 0.12;
        const pulse = Math.min(99, (now - clickAt) / 1000);
        f32.set([
          canvas.width, canvas.height, reduceMotion ? 0 : (now - t0) / 1000, pulse,
          mouse.x, mouse.y, clickPos.x, clickPos.y,
          hoverCur, fill, 0, 0,
        ]);
        const { device, ctx, pipeline, ubuf, bind } = gpu;
        device.queue.writeBuffer(ubuf, 0, f32);
        const enc = device.createCommandEncoder();
        const pass = enc.beginRenderPass({
          colorAttachments: [{
            view: ctx.getCurrentTexture().createView(),
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
            loadOp: "clear",
            storeOp: "store",
          }],
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bind);
        pass.draw(3);
        pass.end();
        device.queue.submit([enc.finish()]);
      }

      function frame(now) {
        raf = 0;
        if (!gpu || !gpuWanted || !enabled || ui.state !== "open" || document.hidden) return;
        if (now - lastDraw >= 33) { lastDraw = now; drawGpu(now); }   // ~30 fps is plenty
        raf = requestAnimationFrame(frame);
      }
      function startLoop() { if (!raf && !reduceMotion && gpu && gpuWanted && enabled && ui.state === "open") raf = requestAnimationFrame(frame); }
      function stopLoop() { if (raf) { cancelAnimationFrame(raf); raf = 0; } }
      document.addEventListener("visibilitychange", () => { if (!document.hidden) startLoop(); });

      function syncGpuVisibility() {
        const on = !!gpu && gpuWanted;
        root.setAttribute("data-gpu", on ? "on" : "off");
        if (on) { sizeCanvas(); startLoop(); if (reduceMotion && enabled) drawGpu(performance.now()); } else stopLoop();
      }

      // ---- show / hide the whole widget (Settings → "Nougan Paste Stack: show widget") ---------
      applyEnabled = () => {
        root.hidden = !enabled;                    // .nps-root has no display rule, so [hidden] works
        if (!enabled) {
          if (editing) endEdit();
          if (drag) endDrag(null, true);
          hovering = false;
          stopLoop();
          return;
        }
        place();
        if (!gpu && !gpuTried) {                   // only grab a GPU device once the widget is actually shown
          gpuTried = true;
          initGpu().then((ok) => { if (ok) syncGpuVisibility(); });
        } else { sizeCanvas(); startLoop(); }
      };

      // ---- go ---------------------------------------------------------------
      render();
      place();
      applyEnabled();
    },
  });
}
