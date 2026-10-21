// Nougan RefMod — compact, pretty UI for the Bake / Loader / Apply nodes.
// Draw-only: no new serialized widgets, so saved workflows stay compatible.
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const KINDS = { NouganRefModBake: "bake", NouganRefModLoader: "loader", NouganRefModApply: "apply" };
const SLOTS = 4;
const NONE = "(none)";
const SOFT_BUDGET = 16384;

const C = {
  panel: "#120e1d", card: "#1d1632", edge: "#3b2d66", text: "#f1ecff", sub: "#9d93bd",
  face: "#22d3ee", voice: "#c084fc", warn: "#fbbf24", ok: "#34d399", a1: "#7c5cff", a2: "#22d3ee",
  dim: "#4b4466",
};

// ───────────── widget groups ─────────────
const BAKE_ADV = ["audio_type", "audio_max_seconds", "audio_max_tokens", "ref_resolution", "max_visual_tokens",
  "visual_budget", "folder_max_items", "folder_max_edge", "subfolder", "overwrite"];
const LOADER_ADV = ["show_info", "max_total_tokens"];
const APPLY_ADV = ["max_total_tokens", "curve_direction", "curve_shape", "curve_value",
  "scramble_seed", "scramble_mode", "scramble_keep"];

// ───────────── library (cards need token counts / thumbs / waveforms) ─────────────
const LIB = { map: new Map(), t: 0, busy: null };
const THUMBS = new Map();

function redraw() { app.graph?.setDirtyCanvas(true, true); }

function loadLib(force = false) {
  if (LIB.busy) return LIB.busy;
  if (!force && Date.now() - LIB.t < 4000) return Promise.resolve();
  LIB.busy = api.fetchApi("/nougan/refmods")
    .then((r) => r.json())
    .then((list) => {
      if (Array.isArray(list)) LIB.map = new Map(list.map((e) => [e.name, e]));
      LIB.t = Date.now();
      redraw();
    })
    .catch(() => {})
    .finally(() => { LIB.busy = null; });
  return LIB.busy;
}

function thumbOf(e) {
  if (!e || !e.thumb) return null;
  const key = `${e.name}|${e.stamp}`;
  let img = THUMBS.get(key);
  if (!img) {
    img = new Image();
    img.onload = redraw;
    img.src = api.apiURL(`/nougan/refmods/thumb?name=${encodeURIComponent(e.name)}&v=${e.stamp}`);
    THUMBS.set(key, img);
  }
  return img.complete && img.naturalWidth ? img : null;
}

// ───────────── tiny helpers ─────────────
const W = (n, name) => n.widgets?.find((w) => w.name === name);
const num = (n, name, d) => { const v = W(n, name)?.value; return typeof v === "number" ? v : d; };
const ng = (n) => (n.__ng ??= { kind: "", slots: 1, adv: false, hit: [], result: null });
const fmt = (t) => (t >= 1000 ? `${(t / 1000).toFixed(t >= 10000 ? 0 : 1)}k` : `${t}`);

function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) { ctx.roundRect(x, y, w, h, r); return; }
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

function alpha(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function chip(ctx, x, y, label, color, on) {
  ctx.font = "bold 9px sans-serif";
  const w = ctx.measureText(label).width + 12;
  rr(ctx, x, y, w, 15, 7.5);
  ctx.fillStyle = on ? alpha(color, 0.18) : "rgba(255,255,255,0.04)";
  ctx.fill();
  ctx.strokeStyle = on ? alpha(color, 0.85) : "rgba(255,255,255,0.10)";
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = on ? color : C.dim;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillText(label, x + 6, y + 8);
  return w + 5;
}

function waveform(ctx, peaks, x, y, w, h, color, a) {
  if (!peaks?.length) return;
  const bars = Math.min(24, Math.floor(w / 3));
  const step = peaks.length / bars;
  ctx.fillStyle = alpha(color, a);
  for (let i = 0; i < bars; i++) {
    const p = peaks[Math.min(peaks.length - 1, Math.floor(i * step))] ?? 0;
    const bh = Math.max(1.5, p * h);
    ctx.fillRect(x + i * (w / bars), y + (h - bh) / 2, Math.max(1, w / bars - 1.2), bh);
  }
}

function thumb(ctx, e, x, y, s, label) {
  ctx.save();
  rr(ctx, x, y, s, s, 7);
  ctx.clip();
  const img = thumbOf(e);
  if (img) {
    ctx.drawImage(img, x, y, s, s);
  } else {
    const g = ctx.createLinearGradient(x, y, x + s, y + s);
    g.addColorStop(0, C.a1); g.addColorStop(1, C.a2);
    ctx.fillStyle = g; ctx.fillRect(x, y, s, s);
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    ctx.font = `bold ${Math.round(s * 0.5)}px sans-serif`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText((label || "?").charAt(0).toUpperCase(), x + s / 2, y + s / 2 + 1);
  }
  ctx.restore();
  rr(ctx, x, y, s, s, 7);
  ctx.strokeStyle = "rgba(255,255,255,0.18)"; ctx.lineWidth = 1; ctx.stroke();
}

function trunc(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  while (text.length > 1 && ctx.measureText(text + "…").width > maxW) text = text.slice(0, -1);
  return text + "…";
}

// ───────────── widget hiding / layout ─────────────
function setHidden(w, hide) {
  if (!w) return;
  if (!w.__ng) {
    w.__ng = { type: w.type, own: Object.prototype.hasOwnProperty.call(w, "computeSize"), cs: w.computeSize };
  }
  if (hide) {
    w.hidden = true;
    try { w.type = "converted-widget"; } catch (_) { /* class getter */ }
    w.computeSize = () => [0, -4];
  } else {
    w.hidden = false;
    try { w.type = w.__ng.type; } catch (_) { /* ignore */ }
    if (w.__ng.own) w.computeSize = w.__ng.cs; else delete w.computeSize;
  }
}

function labelWidgets(node, kind) {
  const set = (name, label) => { const w = W(node, name); if (w) w.label = label; };
  if (kind === "bake") {
    set("ref_resolution", "resolution"); set("max_visual_tokens", "token cap"); set("visual_budget", "on overflow");
    set("audio_max_seconds", "audio seconds"); set("audio_max_tokens", "audio token cap"); set("audio_type", "audio label");
    set("folder_max_items", "folder max files"); set("folder_max_edge", "folder max px");
    return;
  }
  for (let i = 1; i <= SLOTS; i++) {
    const s = i > 1 ? ` ${i}` : "";
    set("mod_" + i, "character" + s); set("visual_strength_" + i, "face" + s); set("audio_strength_" + i, "voice" + s);
    set("strength_" + i, "master" + s); set("copies_" + i, "copies" + s); set("components_" + i, "use" + s);
  }
  set("max_total_tokens", "token budget");
}

function inferSlots(node) {
  let n = 1;
  for (let i = 1; i <= SLOTS; i++) { const v = W(node, "mod_" + i)?.value; if (v && v !== NONE) n = i; }
  return n;
}

function layout(node, resize) {
  const st = ng(node);
  const adv = !!st.adv;
  if (st.kind === "bake") {
    for (const nm of BAKE_ADV) setHidden(W(node, nm), !adv);
  } else {
    for (let i = 1; i <= SLOTS; i++) {
      const on = i <= st.slots;
      for (const p of ["mod_", "visual_strength_", "audio_strength_"]) setHidden(W(node, p + i), !on);
      for (const p of ["strength_", "copies_", "components_"]) setHidden(W(node, p + i), !(on && adv));
    }
    for (const nm of st.kind === "apply" ? APPLY_ADV : LOADER_ADV) setHidden(W(node, nm), !adv);
  }
  node.properties = node.properties || {};
  node.properties.nougan_slots = st.slots;
  node.properties.nougan_adv = adv;
  if (resize) {
    const s = node.computeSize();
    node.setSize([Math.max(node.size[0], s[0]), s[1]]);
  }
  node.setDirtyCanvas(true, true);
}

function addSlot(node) { const st = ng(node); if (st.slots < SLOTS) { st.slots++; layout(node, true); } }
function dropSlot(node) {
  const st = ng(node);
  if (st.slots <= 1) return;
  const w = W(node, "mod_" + st.slots);
  if (w) { w.value = NONE; w.callback?.(NONE); }     // a hidden slot must not stay active
  st.slots--;
  layout(node, true);
}
function toggleAdv(node) { const st = ng(node); st.adv = !st.adv; layout(node, true); }

// ───────────── panel geometry ─────────────
function activeSlots(node) {
  const out = [];
  for (let i = 1; i <= ng(node).slots; i++) { const m = W(node, "mod_" + i)?.value; if (m && m !== NONE) out.push(i); }
  return out;
}
function panelH(node) {
  if (ng(node).kind === "bake") return 28 + 92 + 8;
  const a = activeSlots(node).length;
  return 28 + (a ? a * 48 : 38) + 24;
}

// ───────────── drawing ─────────────
function toolbar(ctx, node, x, y, w) {
  const st = ng(node);
  st.hit = [];
  let cx = x;
  const pill = (id, label, active) => {
    ctx.font = "bold 10px sans-serif";
    const pw = ctx.measureText(label).width + 18;
    rr(ctx, cx, y, pw, 22, 11);
    ctx.fillStyle = active ? alpha(C.a1, 0.35) : "rgba(255,255,255,0.05)";
    ctx.fill();
    ctx.strokeStyle = active ? C.a1 : "rgba(255,255,255,0.14)";
    ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = active ? "#fff" : C.sub;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(label, cx + pw / 2, y + 11.5);
    st.hit.push({ id, x: cx, y, w: pw, h: 22 });
    cx += pw + 6;
  };
  if (st.kind !== "bake") {
    if (st.slots < SLOTS) pill("add", "＋ character", false);
    if (st.slots > 1) pill("drop", "－", false);
  }
  pill("adv", st.adv ? "⚙ advanced ▲" : "⚙ advanced ▼", st.adv);
}

function slotCard(ctx, node, i, x, y, w, h) {
  const name = W(node, "mod_" + i).value;
  const e = LIB.map.get(name);
  const vs = num(node, "visual_strength_" + i, 1), as = num(node, "audio_strength_" + i, 1);
  const ms = num(node, "strength_" + i, 1), cp = num(node, "copies_" + i, 1);
  const comp = W(node, "components_" + i)?.value || "All";
  const vOn = (!e || e.visual_tokens > 0) && comp !== "Audio" && vs * ms > 0;
  const aOn = (!e || e.audio_tokens > 0) && comp !== "Visual" && as * ms > 0;

  rr(ctx, x, y, w, h, 9);
  const g = ctx.createLinearGradient(x, y, x + w, y);
  g.addColorStop(0, "#241b3f"); g.addColorStop(1, "#1a1430");
  ctx.fillStyle = g; ctx.fill();
  ctx.strokeStyle = C.edge; ctx.lineWidth = 1; ctx.stroke();

  const base = name.split("/").pop();
  thumb(ctx, e, x + 5, y + 5, h - 10, base);

  const tx = x + h + 3;
  ctx.fillStyle = C.text; ctx.font = "bold 12px sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
  ctx.fillText(trunc(ctx, base, w - h - 90), tx, y + 14);

  let cx = tx;
  const faceLabel = e ? `FACE ${e.faces}×${Math.round(vs * 100)}%` : "FACE";
  const voiceLabel = e ? `VOICE ${e.audio_seconds ? e.audio_seconds.toFixed(0) + "s " : ""}${Math.round(as * 100)}%` : "VOICE";
  if (!e || e.visual_tokens > 0) cx += chip(ctx, cx, y + 24, faceLabel, C.face, vOn);
  if (!e || e.audio_tokens > 0) cx += chip(ctx, cx, y + 24, voiceLabel, C.voice, aOn);

  let tokens = 0;
  if (e) tokens = ((vOn ? e.visual_tokens : 0) + (aOn ? e.audio_tokens : 0)) * cp;
  ctx.textAlign = "right"; ctx.font = "10px sans-serif"; ctx.fillStyle = C.sub;
  ctx.fillText(e ? `${fmt(tokens)} tok${cp > 1 ? ` ×${cp}` : ""}` : "…", x + w - 8, y + 13);
  if (e && aOn) waveform(ctx, e.peaks, x + w - 72, y + 24, 64, 14, C.voice, 0.85);
  return tokens;
}

function drawLoaderPanel(ctx, node) {
  const w = node.size[0] - 20, ph = panelH(node);
  const top = node.size[1] - ph + 2;
  toolbar(ctx, node, 10, top, w);
  const act = activeSlots(node);
  let y = top + 28, total = 0;
  if (!act.length) {
    rr(ctx, 10, y, w, 32, 9);
    ctx.fillStyle = "rgba(255,255,255,0.04)"; ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.12)"; ctx.setLineDash([4, 3]); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = C.sub; ctx.font = "11px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText("pick a character above", 10 + w / 2, y + 17);
    y += 38;
  } else {
    for (const i of act) { total += slotCard(ctx, node, i, 10, y, w, 44); y += 48; }
  }
  // token meter
  const budget = num(node, "max_total_tokens", 0) || SOFT_BUDGET;
  const ratio = Math.min(1, total / budget), over = total > budget;
  rr(ctx, 10, y + 3, w, 6, 3); ctx.fillStyle = "rgba(255,255,255,0.07)"; ctx.fill();
  if (ratio > 0) {
    rr(ctx, 10, y + 3, Math.max(6, w * ratio), 6, 3);
    const g = ctx.createLinearGradient(10, 0, 10 + w, 0);
    g.addColorStop(0, C.a1); g.addColorStop(1, over ? C.warn : C.a2);
    ctx.fillStyle = g; ctx.fill();
  }
  ctx.fillStyle = over ? C.warn : C.sub; ctx.font = "9px sans-serif"; ctx.textAlign = "right"; ctx.textBaseline = "top";
  ctx.fillText(`${fmt(total)} / ${fmt(budget)} tokens`, 10 + w, y + 11);
}

function linked(node, name) { return node.inputs?.find((i) => i.name === name)?.link != null; }

function drawBakePanel(ctx, node) {
  const st = ng(node);
  const w = node.size[0] - 20, ph = panelH(node);
  const top = node.size[1] - ph + 2;
  toolbar(ctx, node, 10, top, w);

  // entry: freshly baked result, else a saved bake matching the current name
  const nm = (W(node, "name")?.value || "").trim();
  const sub = (W(node, "subfolder")?.value || "").trim().replace(/\\/g, "/");
  const guess = LIB.map.get(sub ? `${sub}/${nm}` : nm);
  const e = st.result && st.result.name ? (LIB.map.get(st.result.name) || st.result) : guess;

  const facesSrc = linked(node, "images") || linked(node, "video_frames") || !!(W(node, "folder")?.value || "").trim();
  const voiceSrc = linked(node, "audio");
  const y = top + 28, h = 92;
  rr(ctx, 10, y, w, h, 10);
  const g = ctx.createLinearGradient(10, y, 10 + w, y + h);
  g.addColorStop(0, "#261c45"); g.addColorStop(1, "#191331");
  ctx.fillStyle = g; ctx.fill(); ctx.strokeStyle = C.edge; ctx.lineWidth = 1; ctx.stroke();

  thumb(ctx, e, 18, y + 8, 76, nm || "?");
  const tx = 104;
  ctx.textAlign = "left"; ctx.textBaseline = "middle";
  ctx.fillStyle = C.text; ctx.font = "bold 13px sans-serif";
  ctx.fillText(trunc(ctx, nm || "unnamed", w - 110), tx, y + 18);

  let cx = tx;
  cx += chip(ctx, cx, y + 31, e && e.faces ? `FACES ${e.faces}` : "FACES", C.face, facesSrc || !!(e && e.faces));
  cx += chip(ctx, cx, y + 31, e && e.audio_seconds ? `VOICE ${e.audio_seconds.toFixed(0)}s` : "VOICE", C.voice, voiceSrc || !!(e && e.audio_seconds));

  // status line
  let msg = "", col = C.sub;
  if (facesSrc && !linked(node, "vae")) { msg = "⚠ connect the video VAE"; col = C.warn; }
  else if (voiceSrc && !linked(node, "audio_vae")) { msg = "⚠ connect the audio VAE"; col = C.warn; }
  else if (!facesSrc && !voiceSrc && !e) { msg = "connect portraits and/or audio, then run"; }
  else if (e && e.visual_tokens !== undefined) {
    msg = `baked · ${fmt((e.visual_tokens || 0) + (e.audio_tokens || 0))} tokens`; col = C.ok;
  } else { msg = "ready to bake"; col = C.ok; }
  ctx.fillStyle = col; ctx.font = "10px sans-serif";
  ctx.fillText(trunc(ctx, msg, w - 110), tx, y + 58);

  if (e?.peaks?.length) waveform(ctx, e.peaks, tx, y + 68, w - 112, 16, C.voice, 0.9);
  else {
    ctx.fillStyle = C.dim; ctx.font = "9px sans-serif";
    ctx.fillText(e ? "" : "saved to models/refmods", tx, y + 76);
  }
}

// ───────────── extension ─────────────
app.registerExtension({
  name: "Nougan.RefMod",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    const kind = KINDS[nodeData.name];
    if (!kind) return;
    const proto = nodeType.prototype;

    const onCreated = proto.onNodeCreated;
    proto.onNodeCreated = function () {
      const r = onCreated?.apply(this, arguments);
      const st = ng(this);
      st.kind = kind;
      this.color = "#4a2f8c";
      this.bgcolor = "#171226";
      labelWidgets(this, kind);

      const orig = this.computeSize;
      this.computeSize = function (out) {
        const s = orig.apply(this, arguments);
        s[0] = Math.max(s[0], 340);
        s[1] += panelH(this) + 6;
        return s;
      };

      st.slots = Math.max(1, inferSlots(this));
      layout(this, true);
      loadLib(true);
      return r;
    };

    const onConfigure = proto.onConfigure;
    proto.onConfigure = function (info) {
      const r = onConfigure?.apply(this, arguments);
      const st = ng(this);
      st.kind = kind;
      const p = this.properties || {};
      st.adv = !!p.nougan_adv;
      st.slots = Math.max(1, Math.min(SLOTS, Math.max(Number(p.nougan_slots) || 1, inferSlots(this))));
      labelWidgets(this, kind);
      layout(this, false);
      loadLib(true);
      return r;
    };

    const onDraw = proto.onDrawForeground;
    proto.onDrawForeground = function (ctx) {
      const r = onDraw?.apply(this, arguments);
      if (this.flags?.collapsed) return r;
      try {
        if (Date.now() - LIB.t > 8000) loadLib(false);
        ctx.save();
        if (ng(this).kind === "bake") drawBakePanel(ctx, this); else drawLoaderPanel(ctx, this);
        ctx.restore();
      } catch (err) { ctx.restore(); console.warn("[Nougan RefMod] draw error", err); }
      return r;
    };

    const onDown = proto.onMouseDown;
    proto.onMouseDown = function (e, pos) {
      const r = onDown?.apply(this, arguments);
      const hit = ng(this).hit.find((h) => pos[0] >= h.x && pos[0] <= h.x + h.w && pos[1] >= h.y && pos[1] <= h.y + h.h);
      if (hit) {
        if (hit.id === "add") addSlot(this);
        else if (hit.id === "drop") dropSlot(this);
        else if (hit.id === "adv") toggleAdv(this);
        return true;
      }
      return r;
    };

    const onExec = proto.onExecuted;
    proto.onExecuted = function (message) {
      const r = onExec?.apply(this, arguments);
      const res = message?.nougan?.[0];
      if (res && kind === "bake") {
        ng(this).result = res;
        loadLib(true).then(() => { try { app.refreshComboInNodes?.(); } catch (_) { /* ignore */ } });
        this.setDirtyCanvas(true, true);
      }
      return r;
    };

    const menu = proto.getExtraMenuOptions;
    proto.getExtraMenuOptions = function (canvas, options) {
      const r = menu?.apply(this, arguments);
      const node = this;
      options.push(null, { content: "Nougan: toggle advanced", callback: () => toggleAdv(node) });
      if (kind !== "bake") {
        options.push({ content: "Nougan: add character slot", callback: () => addSlot(node) });
        options.push({ content: "Nougan: remove last slot", callback: () => dropSlot(node) });
      }
      return r;
    };
  },
});
