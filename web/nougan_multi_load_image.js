// web/nougan_multi_load_image.js  —  Nougan Multi Load Image by Winnougan
// A list of image slots inside one node. "+" adds a slot (and a matching IMAGE output),
// "-" removes the last one. Each slot has a thumbnail, a file dropdown and an upload button;
// you can also drop image files onto the node. The chosen files live in the hidden
// "images_json" widget, so workflows save and load normally.

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_ID = "NouganMultiLoadImage";
const MAX_SLOTS = 16;
const TILE_H = 76;
const FOOT_H = 42;
const MIN_W = 330;

// ---------------------------------------------------------------- styles

function injectStyles() {
  if (document.getElementById("nougan-mli-style")) return;
  const s = document.createElement("style");
  s.id = "nougan-mli-style";
  s.textContent = `
.nmi{box-sizing:border-box;display:flex;flex-direction:column;gap:6px;width:100%;height:100%;padding:4px;
  font:12px system-ui,sans-serif;color:#e8e6f0;user-select:none;overflow-y:auto}
.nmi *{box-sizing:border-box}
.nmi-tile{display:flex;gap:8px;align-items:stretch;height:${TILE_H - 6}px;flex:0 0 ${TILE_H - 6}px;padding:5px;border-radius:9px;
  background:#1a1430;border:1px solid #3b2f5c;transition:border-color .12s,background .12s}
.nmi-tile.drop{border-color:#ff7ad9;background:#2a1b45}
.nmi-tile.empty{border-style:dashed;border-color:#8f3b4a}
.nmi-thumb{position:relative;flex:0 0 ${TILE_H - 16}px;width:${TILE_H - 16}px;border-radius:6px;overflow:hidden;background:#0d0b14;cursor:zoom-in}
.nmi-thumb img{width:100%;height:100%;object-fit:cover;display:block}
.nmi-badge{position:absolute;left:3px;top:3px;padding:0 6px;border-radius:999px;font-weight:700;font-size:11px;
  background:rgba(20,14,36,.85);border:1px solid #8e6bff;color:#fff}
.nmi-col{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;justify-content:space-between}
.nmi-head{color:#b9aee6;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.nmi select{width:100%;height:24px;border-radius:6px;background:#2b2347;border:1px solid #45367a;color:#e8e6f0;padding:0 4px;font-size:12px}
.nmi-row{display:flex;gap:5px;align-items:center}
.nmi-btn{all:unset;cursor:pointer;height:24px;padding:0 9px;line-height:24px;border-radius:6px;text-align:center;
  background:#2b2347;border:1px solid #45367a;color:#e8e6f0;white-space:nowrap}
.nmi-btn:hover{background:#3a2f63}
.nmi-btn:active{transform:translateY(1px)}
.nmi-btn.off{opacity:.4;pointer-events:none}
.nmi-add{background:linear-gradient(90deg,#6a46d8,#b44ad0);border-color:#8e6bff;font-weight:700;flex:1 1 auto}
.nmi-add:hover{filter:brightness(1.2)}
.nmi-foot{display:flex;gap:6px;align-items:center;flex:0 0 auto;padding-top:2px}
.nmi-count{color:#b9aee6;font-variant-numeric:tabular-nums;padding:0 4px}
.nmi-status{color:#ffe08a;font-size:11px;flex:0 0 auto;min-height:14px}
`;
  document.head.appendChild(s);
}

// ---------------------------------------------------------------- helpers

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

function parseRef(v) {
  if (!v) return null;
  let s = String(v).replace(/\\/g, "/");
  let type = "input";
  const m = s.match(/^(.*) \[(input|output|temp)\]$/);
  if (m) { s = m[1]; type = m[2]; }
  const i = s.lastIndexOf("/");
  return { filename: i >= 0 ? s.slice(i + 1) : s, subfolder: i >= 0 ? s.slice(0, i) : "", type };
}

const thumbUrl = (v) => {
  const r = parseRef(v);
  return r ? api.apiURL(`/view?filename=${encodeURIComponent(r.filename)}&type=${r.type}&subfolder=${encodeURIComponent(r.subfolder)}`) : "";
};

const shortName = (v, n = 20) => {
  const r = parseRef(v);
  const f = r ? r.filename : "";
  return f.length > n ? f.slice(0, n - 1) + "…" : f;
};

// The input folder's file list (same list the stock Load Image node shows).
const fileCache = { files: [], at: 0 };
async function getFiles(force = false) {
  if (!force && Date.now() - fileCache.at < 3000) return fileCache.files;
  try {
    const r = await api.fetchApi("/object_info/LoadImage");
    const j = await r.json();
    const spec = j?.LoadImage?.input?.required?.image;
    const list = Array.isArray(spec?.[0]) ? spec[0] : spec?.[1]?.options || [];
    fileCache.files = list.map(String);
    fileCache.at = Date.now();
  } catch (_) { /* keep the old list */ }
  return fileCache.files;
}

async function uploadImage(file) {
  const body = new FormData();
  body.append("image", file);
  body.append("type", "input");
  const r = await api.fetchApi("/upload/image", { method: "POST", body });
  if (r.status !== 200) throw new Error(`${r.status} ${r.statusText}`);
  const j = await r.json();
  return j.subfolder ? `${j.subfolder}/${j.name}` : j.name;
}

const isImageFile = (f) => f && (f.type?.startsWith("image/") || /\.(png|jpe?g|webp|bmp|gif|tiff?)$/i.test(f.name || ""));

function hideWidget(w) {
  if (!w) return;
  w.hidden = true;
  w.computeSize = () => [0, -4];
  w.type = "hidden";
  if (w.element) w.element.style.display = "none";
}

// ---------------------------------------------------------------- UI

function buildUI(node) {
  const store = node.widgets.find((w) => w.name === "images_json");
  hideWidget(store);

  const root = el("div", "nmi");
  const list = el("div", "");
  list.style.cssText = "display:flex;flex-direction:column;gap:6px";
  const status = el("div", "nmi-status");
  const foot = el("div", "nmi-foot");
  const add = el("button", "nmi-btn nmi-add", "＋ Add image");
  const sub = el("button", "nmi-btn", "−");
  sub.title = "Remove the last image slot (and its output)";
  const count = el("span", "nmi-count");
  const refresh = el("button", "nmi-btn", "🔄");
  refresh.title = "Re-read the input folder";
  foot.append(add, sub, count, refresh);
  root.append(list, status, foot);

  let names = [""];
  let busyUploads = 0;

  const read = () => {
    let arr = [];
    try { arr = JSON.parse(store?.value ?? "[]"); } catch (_) { arr = []; }
    names = (Array.isArray(arr) ? arr : []).map((x) => (typeof x === "string" ? x : "")).slice(0, MAX_SLOTS);
    if (!names.length) names = [""];
  };

  const write = () => {
    if (!store) return;
    store.value = JSON.stringify(names);
    store.callback?.(store.value);
    app.graph?.setDirtyCanvas(true, true);
  };

  const flash = (msg, ms = 2500) => {
    status.textContent = msg;
    if (ms) setTimeout(() => { if (status.textContent === msg) status.textContent = ""; }, ms);
  };

  // ---- outputs: one IMAGE output per slot
  function syncOutputs(allowShrink) {
    while (node.outputs.length < names.length) node.addOutput(`image_${node.outputs.length + 1}`, "IMAGE");
    if (allowShrink) {
      while (node.outputs.length > names.length) node.removeOutput(node.outputs.length - 1);
    }
    node.outputs.forEach((o, i) => {
      o.label = `P${i + 1}` + (names[i] ? ` · ${shortName(names[i])}` : "");
    });
  }

  function fit() {
    const h = names.length * TILE_H + FOOT_H + 22;
    if (node._nmiWidget) node._nmiWidget.computeSize = (w) => [w, h];
    const sz = node.computeSize();
    node.setSize([Math.max(node.size[0], MIN_W), sz[1]]);
    app.graph?.setDirtyCanvas(true, true);
  }

  // ---- upload handling (also used by drag & drop)
  async function handleFiles(index, files) {
    const imgs = [...files].filter(isImageFile);
    if (!imgs.length) return;
    for (let k = 0; k < imgs.length; k++) {
      let target = k === 0 ? index : names.length;
      if (target >= MAX_SLOTS) { flash(`Max ${MAX_SLOTS} images`); break; }
      if (target >= names.length) { names.push(""); structureChanged(false); target = names.length - 1; }
      busyUploads++;
      flash(`Uploading ${imgs[k].name}…`, 0);
      try {
        const value = await uploadImage(imgs[k]);
        await getFiles(true);
        names[target] = value;
        write();
        syncOutputs(false);
        render();
        flash("");
      } catch (err) {
        console.error("[Nougan] upload failed:", err);
        flash(`Upload failed: ${err.message || err}`, 5000);
      } finally {
        busyUploads--;
      }
    }
  }

  // ---- rendering
  function makeTile(i, files) {
    const value = names[i];
    const tile = el("div", "nmi-tile" + (value ? "" : " empty"));

    const thumb = el("div", "nmi-thumb");
    if (value) {
      const img = el("img");
      img.src = thumbUrl(value);
      img.draggable = false;
      img.onerror = () => { img.style.display = "none"; };
      thumb.appendChild(img);
      thumb.title = "Click to open full size";
      thumb.onclick = () => window.open(thumbUrl(value), "_blank");
    } else {
      thumb.style.cursor = "default";
    }
    thumb.appendChild(el("div", "nmi-badge", `P${i + 1}`));

    const col = el("div", "nmi-col");
    col.appendChild(el("div", "nmi-head", `Picture ${i + 1}  →  image_${i + 1}`));

    const sel = el("select");
    const addOpt = (v, label) => { const o = el("option", "", label); o.value = v; sel.appendChild(o); };
    addOpt("", "(choose an image…)");
    const known = new Set(files);
    if (value && !known.has(value)) addOpt(value, `${value}  (not in input folder)`);
    for (const f of files) addOpt(f, f);
    sel.value = value;
    sel.onfocus = () => getFiles(true).then((fresh) => {
      // pick up files added since the node was drawn, without resetting the dropdown
      for (const f of fresh) {
        if (![...sel.options].some((o) => o.value === f)) addOpt(f, f);
      }
    });
    sel.onchange = () => {
      names[i] = sel.value;
      write();
      syncOutputs(false);
      render();
    };

    const row = el("div", "nmi-row");
    const up = el("button", "nmi-btn", "📁 Upload");
    const input = el("input");
    input.type = "file";
    input.accept = "image/*";
    input.multiple = true;
    input.style.display = "none";
    input.onchange = () => { handleFiles(i, input.files); input.value = ""; };
    up.onclick = () => input.click();
    row.append(up, input);
    col.append(sel, row);

    tile.append(thumb, col);

    tile.addEventListener("dragover", (e) => {
      if ([...(e.dataTransfer?.items || [])].some((it) => it.kind === "file")) {
        e.preventDefault();
        tile.classList.add("drop");
      }
    });
    tile.addEventListener("dragleave", () => tile.classList.remove("drop"));
    tile.addEventListener("drop", (e) => {
      tile.classList.remove("drop");
      if (e.dataTransfer?.files?.length) {
        e.preventDefault();
        e.stopPropagation();
        handleFiles(i, e.dataTransfer.files);
      }
    });
    return tile;
  }

  async function render() {
    const files = await getFiles();
    list.replaceChildren(...names.map((_, i) => makeTile(i, files)));
    count.textContent = `${names.length} / ${MAX_SLOTS}`;
    add.classList.toggle("off", names.length >= MAX_SLOTS);
    sub.classList.toggle("off", names.length <= 1);
  }

  function structureChanged(shrink) {
    write();
    syncOutputs(shrink);
    fit();
    render();
  }

  add.onclick = () => {
    if (names.length >= MAX_SLOTS) return;
    names.push("");
    structureChanged(false);
  };
  sub.onclick = () => {
    if (names.length <= 1) return;
    names.pop();
    structureChanged(true); // removeOutput also drops any link on that output
  };
  refresh.onclick = async () => { await getFiles(true); render(); flash("Input folder re-read", 1500); };

  // Dropping files anywhere on the node adds them as new slots.
  root.addEventListener("dragover", (e) => {
    if ([...(e.dataTransfer?.items || [])].some((it) => it.kind === "file")) e.preventDefault();
  });
  root.addEventListener("drop", (e) => {
    if (e.dataTransfer?.files?.length) {
      e.preventDefault();
      handleFiles(names.length, e.dataTransfer.files);
    }
  });

  // Called after the workflow loads: rebuild everything from the saved widget value.
  function reload() {
    read();
    syncOutputs(false);
    fit();
    render();
  }

  read();
  return { root, reload, write, syncOutputs, fit, render, getNames: () => names };
}

// ---------------------------------------------------------------- extension

app.registerExtension({
  name: "Nougan.MultiLoadImage",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== NODE_ID) return;
    injectStyles();

    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onCreated ? onCreated.apply(this, arguments) : undefined;

      // Python declares MAX_SLOTS outputs; start with just the first one.
      while (this.outputs.length > 1) this.removeOutput(this.outputs.length - 1);

      const ui = buildUI(this);
      this._nmi = ui;
      const widget = this.addDOMWidget("nmi_list", "nougan_multi_images", ui.root, {
        serialize: false,
        hideOnZoom: false,
        getMinHeight: () => TILE_H + FOOT_H + 22,
      });
      widget.computeSize = (w) => [w, TILE_H + FOOT_H + 22];
      this._nmiWidget = widget;

      ui.write();
      ui.syncOutputs(false);
      ui.fit();
      ui.render();
      return r;
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;
      // widgets_values are applied by now; re-hide the store widget and rebuild the list
      hideWidget(this.widgets?.find((w) => w.name === "images_json"));
      this._nmi?.reload();
      return r;
    };
  },
});
