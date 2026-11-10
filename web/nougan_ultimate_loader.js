// nougan_ultimate_loader.js — DOM frontend for the Nougan Ultimate Model Loader.
// The whole control surface is ONE litegraph DOM widget: the frontend positions, zooms
// and sizes the node around it (no overlay drift, no dead space). Sections are boxed,
// renamable and drag-reorderable; dropdowns are type-to-search; status strip is WebGPU
// with a 2D fallback. No left sockets by default — right-click -> "Promote to input".
import { app } from "../../../scripts/app.js";

const BUILD = "2026-11-06i";
const NODE_ID = "NouganUltimateModelLoader";
const CONVERTED = "converted-widget"; // core widgetInputs marker — conversions serialize/restore like core's own

// core's DomWidgets.vue already hides widgets whose graph isn't the one on screen
// (per-frame in updateWidgets + v-show), so no visibility plumbing is needed here.

// section key -> heading widget + member widgets, in default order
const SECTIONS = [
    { key: "model",  heading: "heading_model",  widgets: ["model_enabled", "model_name", "quant_format", "model_type"] },
    { key: "engine", heading: "heading_engine", widgets: ["kitchen", "sage2", "sage3", "triton", "flash2", "pytorch", "sparse", "vsa"] },
    { key: "clips",  heading: "heading_clips",  widgets: ["clip1_enabled", "clip1_name", "clip1_type", "clip1_device", "clip2_enabled", "clip2_name", "clip2_type", "clip2_device"] },
    { key: "vaes",   heading: "heading_vaes",   widgets: ["vae_enabled", "vae_name", "audio_vae_enabled", "audio_vae_name"] },
];
// on/off knob -> the rows it switches. Off = dimmed here, skipped by the backend.
const KNOBS = {
    model_enabled:     ["model_name", "quant_format"],
    clip1_enabled:     ["clip1_name", "clip1_type", "clip1_device"],
    clip2_enabled:     ["clip2_name", "clip2_type", "clip2_device"],
    vae_enabled:       ["vae_name"],
    audio_vae_enabled: ["audio_vae_name"],
};
const HIDDEN_ALWAYS = ["section_order"];
const ORDER_WIDGET = "section_order";
const PANEL_WIDGET = "nguml_panel";

const CSS = `
.nguml-inner{display:flex;flex-direction:column;gap:6px;width:100%;box-sizing:border-box;
  padding:4px 2px 6px;font:12px/1.4 "Inter","Segoe UI",sans-serif;color:#dfe3ea;overflow:visible;
  pointer-events:auto;}
/* core's dom-widget wrapper assigns a fixed pixel height; never let flexbox squash
   the sections to fit it — height is always derived from content (scrollHeight) */
.nguml-inner>*{flex-shrink:0;}
.nguml-strip{display:flex;align-items:center;gap:8px;height:22px;}
.nguml-strip canvas{flex:0 0 64px;height:14px;border-radius:4px;background:#222;}
.nguml-status{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#9aa3b2;font-size:11px;}
.nguml-section{border:1px solid #3a3a46;border-radius:6px;background:rgba(255,255,255,.02);overflow:hidden;}
.nguml-sec-head{display:flex;align-items:center;gap:6px;padding:4px 6px;
  background:rgba(255,255,255,.045);border-bottom:1px solid #3a3a46;}
.nguml-grip{cursor:grab;color:#6b7280;user-select:none;padding:0 2px;}
.nguml-grip:active{cursor:grabbing;}
.nguml-sec-title{flex:1;background:transparent;border:none;outline:none;color:#e8b4ff;
  font-weight:600;font-size:12px;padding:1px 2px;border-radius:3px;min-width:0;}
.nguml-sec-title:focus{background:rgba(255,255,255,.07);}
.nguml-chev{cursor:pointer;color:#6b7280;user-select:none;width:14px;text-align:center;}
.nguml-sec-body{display:flex;flex-direction:column;gap:4px;padding:6px;}
.nguml-sec-body.nguml-collapsed{display:none;}
.nguml-row{display:flex;align-items:center;gap:8px;min-height:22px;}
.nguml-label{flex:0 0 104px;color:#9aa3b2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.nguml-row input.nguml-combo{flex:1;min-width:0;background:#1b1b23;color:#dfe3ea;border:1px solid #444;
  border-radius:4px;padding:2px 6px;font-size:12px;outline:none;}
.nguml-row input.nguml-combo:focus{border-color:#7c3aed;}
.nguml-switch{margin-left:auto;position:relative;width:34px;height:18px;border-radius:9px;
  background:#3a3a46;cursor:pointer;transition:background .15s;flex:0 0 auto;}
.nguml-switch::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;
  border-radius:50%;background:#aab;transition:transform .15s, background .15s;}
.nguml-switch.on{background:#7c3aed;}
.nguml-switch.on::after{transform:translateX(16px);background:#fff;}
.nguml-switch-label{color:#c9ced8;}
.nguml-drop-hint{outline:1px dashed #7c3aed;outline-offset:-1px;}
.nguml-row.nguml-off{opacity:.4;}
.nguml-row.nguml-wired{opacity:.45;}
.nguml-row.nguml-wired input,.nguml-row.nguml-wired .nguml-switch{pointer-events:none;}
.nguml-row.nguml-wired .nguml-label::after{content:" ⚡";color:#7c3aed;}
/* custom dropdown — body-appended so no widget wrapper can clip it */
.nguml-droplist{position:fixed;z-index:100000;background:#1b1b23;border:1px solid #444;
  border-radius:6px;max-height:240px;overflow-y:auto;box-shadow:0 8px 24px rgba(0,0,0,.55);
  font:12px/1.4 "Inter","Segoe UI",sans-serif;color:#dfe3ea;}
.nguml-opt{padding:4px 10px;cursor:pointer;white-space:nowrap;overflow:hidden;
  text-overflow:ellipsis;max-width:460px;}
.nguml-opt:hover,.nguml-opt.hi{background:rgba(124,58,237,.25);}
.nguml-opt.sel{color:#e8b4ff;}
.nguml-opt-more{color:#6b7280;cursor:default;}
`;

function injectCss() {
    if (document.getElementById("nguml-css")) return;
    const st = document.createElement("style");
    st.id = "nguml-css";
    st.textContent = CSS;
    document.head.appendChild(st);
}

// ── WebGPU status canvas (2D fallback) ────────────────────────────────────────
async function startStrip(canvas) {
    const w = canvas.width = 128, h = canvas.height = 28;
    if (navigator.gpu) {
        try {
            const adapter = await navigator.gpu.requestAdapter();
            if (adapter) {
                const device = await adapter.requestDevice();
                const ctx = canvas.getContext("webgpu");
                if (ctx) {
                    const format = navigator.gpu.getPreferredCanvasFormat();
                    ctx.configure({ device, format, alphaMode: "opaque" });
                    let raf, t0 = performance.now();
                    const frame = () => {
                        const t = (performance.now() - t0) / 1000;
                        const enc = device.createCommandEncoder();
                        const pass = enc.beginRenderPass({
                            colorAttachments: [{
                                view: ctx.getCurrentTexture().createView(),
                                loadOp: "clear",
                                clearValue: { r: .30 + .18 * Math.sin(t * 1.4), g: .12, b: .48 + .12 * Math.sin(t * .9 + 1), a: 1 },
                                storeOp: "store",
                            }],
                        });
                        pass.end();
                        device.queue.submit([enc.finish()]);
                        raf = requestAnimationFrame(frame);
                    };
                    frame();
                    return () => cancelAnimationFrame(raf);
                }
            }
        } catch (_) { /* fall through to 2D */ }
    }
    const c2 = canvas.getContext("2d");
    if (!c2) return () => {};
    let raf;
    const frame = () => {
        const t = performance.now() / 1000;
        const g = c2.createLinearGradient(0, 0, w, 0);
        g.addColorStop(0, `hsl(${(t * 40) % 360},70%,45%)`);
        g.addColorStop(1, `hsl(${(t * 40 + 80) % 360},70%,40%)`);
        c2.fillStyle = g; c2.fillRect(0, 0, w, h);
        raf = requestAnimationFrame(frame);
    };
    frame();
    return () => cancelAnimationFrame(raf);
}

// ── helpers ───────────────────────────────────────────────────────────────────
function wByName(node, name) {
    return node.widgets?.find(w => w.name === name);
}

function hideDataWidgets(node) {
    const names = new Set([...HIDDEN_ALWAYS, ...SECTIONS.flatMap(s => [s.heading, ...s.widgets])]);
    for (const w of node.widgets || []) {
        if (names.has(w.name)) { w.hidden = true; w.computeSize = () => [0, -4]; }
    }
}

function niceLabel(name) {
    const map = {
        model_enabled: "model · on/off", clip1_enabled: "clip 1 · on/off", vae_enabled: "vae · on/off",
        model_name: "model", quant_format: "format", model_type: "type",
        kitchen: "comfy-kitchen", sage2: "sageattention 2", sage3: "sageattention 3",
        triton: "triton", flash2: "flashattention 2", pytorch: "pytorch",
        sparse: "sparseattention", vsa: "vsa",
        clip1_name: "clip 1 · model", clip1_type: "clip 1 · type", clip1_device: "clip 1 · device",
        clip2_enabled: "clip 2 · on/off", clip2_name: "clip 2 · enhancer", clip2_type: "clip 2 · type",
        clip2_device: "clip 2 · device",
        vae_name: "video/default vae", audio_vae_enabled: "audio vae · on/off", audio_vae_name: "audio vae",
    };
    return map[name] || name.replace(/_/g, " ");
}

// ── event guards ──────────────────────────────────────────────────────────────
// Pointer/mouse events that bubble out of the panel into the canvas layers kill
// focus (drag/selection handlers preventDefault the mousedown that would focus an
// input). Stopping propagation at the panel root keeps every control alive; the
// deferred focus() wins any residual focus race.
function guardPanel(el) {
    const stop = (e) => e.stopPropagation();
    for (const t of ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick"]) {
        el.addEventListener(t, stop);
    }
}

function guardTextInput(input) {
    const stop = (e) => e.stopPropagation();
    for (const t of ["keydown", "keyup", "keypress"]) input.addEventListener(t, stop);
    input.addEventListener("pointerdown", () => setTimeout(() => input.focus({ preventScroll: true }), 0));
}

// combo values can be an array or (rarely) a lazy function
function comboValues(widget) {
    const v = widget.options?.values;
    return (typeof v === "function" ? v() : v) || [];
}

// ── custom dropdown ───────────────────────────────────────────────────────────
// Native datalist popups are browser chrome — flaky inside this frontend's
// transformed/clipped widget wrappers. This list is body-appended (nothing clips
// it) and commits on pointerdown, so a pick lands even if focus is stolen.
let openDroplist = null;
function closeDroplist() {
    openDroplist?.remove();
    openDroplist = null;
}
document.addEventListener("pointerdown", (e) => {
    if (openDroplist && !openDroplist.contains(e.target) && !e.target.classList?.contains("nguml-combo")) closeDroplist();
}, true);
document.addEventListener("wheel", (e) => {
    if (openDroplist && !openDroplist.contains(e.target)) closeDroplist(); // canvas pan/zoom
}, true);
window.addEventListener("blur", closeDroplist);

// searchable combo: text input + custom dropdown; invalid text reverts on close
function makeCombo(node, widget, onChanged) {
    const wrap = document.createElement("span");
    wrap.style.cssText = "flex:1;min-width:0;display:flex;";
    const input = document.createElement("input");
    input.className = "nguml-combo";
    input.spellcheck = false;
    input.autocomplete = "off";
    input.title = widget.tooltip || "";
    input.value = widget.value ?? "";
    guardTextInput(input);

    let hi = -1;

    const commitValue = (v) => {
        input.value = v;
        if (widget.value !== v) { widget.value = v; widget.callback?.(v); onChanged(); }
        closeDroplist();
    };

    const revertOrCommit = () => {
        if (comboValues(widget).includes(input.value)) {
            if (widget.value !== input.value) { widget.value = input.value; widget.callback?.(widget.value); onChanged(); }
        } else {
            input.value = widget.value ?? ""; // revert junk
        }
    };

    const openList = () => {
        closeDroplist();
        const filter = input.value === widget.value ? "" : input.value;
        const f = filter.toLowerCase();
        const vals = comboValues(widget).filter(v => !f || String(v).toLowerCase().includes(f));
        if (!vals.length) return;
        const list = document.createElement("div");
        list.className = "nguml-droplist";
        guardPanel(list);
        // wheel scrolls the list, never the canvas zoom
        list.addEventListener("wheel", (e) => e.stopPropagation());
        const show = vals.slice(0, 300);
        for (const v of show) {
            const opt = document.createElement("div");
            opt.className = "nguml-opt" + (v === widget.value ? " sel" : "");
            opt.textContent = v;
            opt.addEventListener("pointerdown", (e) => {
                e.preventDefault(); e.stopPropagation();
                commitValue(v);
            });
            list.appendChild(opt);
        }
        if (vals.length > show.length) {
            const more = document.createElement("div");
            more.className = "nguml-opt nguml-opt-more";
            more.textContent = `… ${vals.length - show.length} more — type to filter`;
            list.appendChild(more);
        }
        document.body.appendChild(list);
        const r = input.getBoundingClientRect();
        list.style.minWidth = `${r.width}px`;
        list.style.left = `${Math.max(4, Math.min(r.left, window.innerWidth - 480))}px`;
        list.style.top = `${r.bottom + 2}px`;
        openDroplist = list;
        hi = -1;
    };

    // focus -> select the whole value so typing immediately replaces it (no manual select-all).
    // The first mouseup after a click would collapse the selection, so swallow it.
    let justFocused = false;
    input.addEventListener("focus", () => {
        justFocused = true;
        setTimeout(() => input.select(), 0);
        openList();
    });
    input.addEventListener("mouseup", (e) => {
        if (justFocused) { e.preventDefault(); justFocused = false; }
    });
    input.addEventListener("pointerdown", () => setTimeout(() => {
        if (document.activeElement === input && !openDroplist) openList();
    }, 0));
    input.addEventListener("input", () => {
        if (comboValues(widget).includes(input.value)) {
            if (widget.value !== input.value) { widget.value = input.value; widget.callback?.(widget.value); onChanged(); }
            closeDroplist();
            return;
        }
        openList();
    });
    input.addEventListener("blur", () => setTimeout(() => { closeDroplist(); revertOrCommit(); }, 150));
    input.addEventListener("keydown", (e) => {
        if (!openDroplist) return;
        const opts = [...openDroplist.querySelectorAll(".nguml-opt:not(.nguml-opt-more)")];
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            if (!opts.length) return;
            hi = (hi + (e.key === "ArrowDown" ? 1 : -1) + opts.length) % opts.length;
            opts.forEach((o, i) => o.classList.toggle("hi", i === hi));
            opts[hi]?.scrollIntoView({ block: "nearest" });
        } else if (e.key === "Enter") {
            e.preventDefault();
            if (hi >= 0 && opts[hi]) commitValue(opts[hi].textContent);
            else { revertOrCommit(); closeDroplist(); }
        } else if (e.key === "Escape") {
            closeDroplist();
        }
    });

    wrap.appendChild(input);
    wrap.sync = () => { input.value = widget.value ?? ""; };
    // external editors (Live Panel, undo, workflow load) write widget.value directly —
    // reflect that in the control as long as the user isn't typing in it right now
    wrap.pull = () => {
        if (document.activeElement !== input && input.value !== String(widget.value ?? "")) {
            input.value = widget.value ?? "";
        }
    };
    return wrap;
}

function makeControl(node, widget, onChanged) {
    const row = document.createElement("div");
    row.className = "nguml-row";
    const label = document.createElement("div");
    label.className = "nguml-label";
    label.textContent = niceLabel(widget.name);
    row.appendChild(label);

    let ctl;
    if (widget.type === "toggle" || typeof widget.value === "boolean") {
        ctl = document.createElement("span");
        ctl.style.cssText = "flex:1;display:flex;align-items:center;gap:8px;";
        const sub = document.createElement("span");
        sub.className = "nguml-switch-label";
        sub.textContent = widget.options?.label_on || "";
        const sw = document.createElement("div");
        sw.className = "nguml-switch" + (widget.value ? " on" : "");
        sw.title = widget.tooltip || "";
        sw.onclick = () => {
            widget.value = !widget.value;
            widget.callback?.(widget.value);
            sw.classList.toggle("on", !!widget.value);
            onChanged();
        };
        ctl.appendChild(sub);
        ctl.appendChild(sw);
        ctl.sync = () => sw.classList.toggle("on", !!widget.value);
        ctl.pull = ctl.sync;
    } else {
        ctl = makeCombo(node, widget, onChanged);
    }
    row.appendChild(ctl);

    row._ngWidget = widget;
    row._ngWired = null;
    row.sync = () => {
        const wired = widget.type === CONVERTED;
        if (wired !== row._ngWired) {
            row._ngWired = wired;
            row.classList.toggle("nguml-wired", wired);
            row.title = wired ? "driven by an input socket — right-click the node to un-convert" : "";
        }
        ctl.sync?.();
    };
    row.pull = () => ctl.pull?.();
    row.sync();
    return row;
}

// widget -> real input socket, using core's converted-widget protocol so it
// serializes into the workflow and restores on load like core's own conversion.
function convertWidgetToInput(node, widget) {
    const isCombo = Array.isArray(widget.options?.values);
    const type = isCombo ? "COMBO" : (typeof widget.value === "boolean" ? "BOOLEAN" : "STRING");
    if (node.inputs?.some(i => i.widget?.name === widget.name)) return; // already converted
    node.addInput(widget.name, type, { widget: { name: widget.name } });
    widget.type = CONVERTED;
    widget.computeSize = () => [0, -4];
    widget.hidden = true;
    syncHeight(node);
    node.setDirtyCanvas(true, true);
}

// node height = title + slots + panel height — always, automatically
function syncHeight(node) {
    const st = node._nguml;
    if (!st || !node.graph) return;
    const w = Math.max(280, node.size[0]);
    const h = node.computeSize()[1];
    if (Math.abs(node.size[1] - h) > 1 || node.size[0] !== w) {
        node.setSize([w, h]);
    }
    node.setDirtyCanvas(true, true);
}

// ── main build ────────────────────────────────────────────────────────────────
function buildDom(node) {
    teardownDom(node);
    injectCss();

    const inner = document.createElement("div");
    inner.className = "nguml-inner";
    guardPanel(inner);
    // one-time probe: if this never logs on click, events aren't reaching the panel at all
    inner.addEventListener("pointerdown", () => console.debug("[Nougan.UML] panel pointer ok"), { once: true });

    // status strip (WebGPU canvas + text)
    const strip = document.createElement("div");
    strip.className = "nguml-strip";
    const gpuCanvas = document.createElement("canvas");
    const status = document.createElement("div");
    status.className = "nguml-status";
    status.textContent = node._ngumlStatus || "ready — queue a prompt to load";
    strip.appendChild(gpuCanvas);
    strip.appendChild(status);
    inner.appendChild(strip);
    const stopStrip = startStrip(gpuCanvas);

    // sections in saved order
    const orderW = wByName(node, ORDER_WIDGET);
    let order = (orderW?.value || "").split(",").map(s => s.trim()).filter(Boolean);
    const known = new Set(SECTIONS.map(s => s.key));
    order = [...order.filter(k => known.has(k)), ...SECTIONS.map(s => s.key).filter(k => !order.includes(k))];

    const onChanged = () => { node.setDirtyCanvas(true, true); };

    for (const key of order) {
        const spec = SECTIONS.find(s => s.key === key);
        if (!spec) continue;
        const sec = document.createElement("div");
        sec.className = "nguml-section";
        sec.dataset.key = key;

        const head = document.createElement("div");
        head.className = "nguml-sec-head";
        const grip = document.createElement("span");
        grip.className = "nguml-grip";
        grip.textContent = "⠿";
        grip.title = "drag to reorder sections";
        const title = document.createElement("input");
        title.className = "nguml-sec-title";
        const hw = wByName(node, spec.heading);
        title.value = hw?.value ?? key;
        title.spellcheck = false;
        title.title = "click to rename this heading";
        guardTextInput(title);
        title.addEventListener("input", () => { if (hw) { hw.value = title.value; hw.callback?.(hw.value); } node.setDirtyCanvas(true, true); });
        const chev = document.createElement("span");
        chev.className = "nguml-chev";
        chev.textContent = "▾";
        head.appendChild(grip);
        head.appendChild(title);
        head.appendChild(chev);

        const body = document.createElement("div");
        body.className = "nguml-sec-body";
        for (const wn of spec.widgets) {
            const w = wByName(node, wn);
            if (!w) continue;
            body.appendChild(makeControl(node, w, onChanged));
        }
        chev.onclick = () => {
            const collapsed = body.classList.toggle("nguml-collapsed");
            chev.textContent = collapsed ? "▸" : "▾";
            syncHeight(node);
        };

        // drag to reorder
        grip.addEventListener("pointerdown", (e) => {
            e.preventDefault(); e.stopPropagation();
            grip.setPointerCapture(e.pointerId);
            const onMove = (ev) => {
                const y = ev.clientY;
                for (const s of inner.querySelectorAll(".nguml-section")) {
                    s.classList.remove("nguml-drop-hint");
                    const r = s.getBoundingClientRect();
                    if (s !== sec && y > r.top && y < r.bottom) s.classList.add("nguml-drop-hint");
                }
            };
            const onUp = (ev) => {
                grip.removeEventListener("pointermove", onMove);
                grip.removeEventListener("pointerup", onUp);
                let target = null;
                for (const s of inner.querySelectorAll(".nguml-section")) {
                    const r = s.getBoundingClientRect();
                    if (s !== sec && ev.clientY > r.top && ev.clientY < r.bottom) target = s;
                    s.classList.remove("nguml-drop-hint");
                }
                if (target) {
                    const before = ev.clientY < target.getBoundingClientRect().top + target.offsetHeight / 2;
                    inner.insertBefore(sec, before ? target : target.nextSibling);
                    const newOrder = [...inner.querySelectorAll(".nguml-section")].map(s => s.dataset.key);
                    if (orderW) orderW.value = newOrder.join(",");
                    node.setDirtyCanvas(true, true);
                    syncHeight(node);
                }
            };
            grip.addEventListener("pointermove", onMove);
            grip.addEventListener("pointerup", onUp);
        });

        sec.appendChild(head);
        sec.appendChild(body);
        inner.appendChild(sec);
    }

    // register as a real DOM widget — the frontend positions/zooms/clips it and
    // the node's height falls out of computeSize(), so no gap is possible.
    const dw = node.addDOMWidget(PANEL_WIDGET, "nguml-panel", inner, { hideOnZoom: false });
    dw.serializeValue = () => undefined; // nothing to save; data lives in the hidden widgets
    // core hides off-graph widgets with display:none, which zeroes scrollHeight —
    // cache the last real content height so the node can't collapse while hidden.
    let lastH = 0;
    dw.computeSize = () => {
        const sh = inner.scrollHeight;
        if (sh > 4) lastH = sh;
        return [Math.max(280, node.size[0]), Math.max(60, (lastH || sh) + 10)];
    };

    const ro = new ResizeObserver(() => { if (inner.scrollHeight > 4) syncHeight(node); });
    ro.observe(inner);

    node._nguml = { inner, status, stopStrip, dw, ro };
    syncHeight(node);
}

function teardownDom(node) {
    const st = node._nguml;
    if (!st) return;
    try { st.ro?.disconnect(); } catch (_) {}
    try { st.stopStrip?.(); } catch (_) {}
    closeDroplist();
    if (st.dw && node.widgets) {
        // onRemove unregisters the widget from the frontend's dom-widget store —
        // without it the stale wrapper keeps re-mounting a ghost of the old panel.
        try { st.dw.onRemove?.(); } catch (_) {}
        const i = node.widgets.indexOf(st.dw);
        if (i >= 0) node.widgets.splice(i, 1);
    }
    st.inner.remove();
    node._nguml = null;
}

app.registerExtension({
    name: "Nougan.UltimateLoader",

    async setup() {
        console.log(`[Nougan.UML] extension loaded — build ${BUILD}`);
        api_addStatusListener();
    },

    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_ID) return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            onNodeCreated?.apply(this, arguments);
            hideDataWidgets(this);
            this.size[0] = Math.max(this.size[0], 320);
            requestAnimationFrame(() => buildDom(this));
        };

        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            onConfigure?.apply(this, arguments);
            hideDataWidgets(this);
            requestAnimationFrame(() => {
                buildDom(this);
                for (const row of this._nguml?.inner.querySelectorAll(".nguml-row") || []) row.sync?.();
                const st = this._nguml;
                if (st && this._ngumlStatus) st.status.textContent = this._ngumlStatus;
            });
        };

        const onRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            teardownDom(this);
            onRemoved?.apply(this, arguments);
        };

        // user-resizable width (clamped so controls never clip); height follows content
        const onResize = nodeType.prototype.onResize;
        nodeType.prototype.onResize = function (size) {
            if (size[0] < 280) size[0] = 280;
            onResize?.apply(this, [size]);
        };

        // cheap per-frame sync: wire/un-wire state, plus values changed from outside
        // (Live Panel edits, undo, workflow restore) flow back into the controls
        const onDrawBackground = nodeType.prototype.onDrawBackground;
        nodeType.prototype.onDrawBackground = function (ctx) {
            onDrawBackground?.apply(this, arguments);
            const st = this._nguml;
            if (!st) return;
            const off = new Set();
            for (const [knob, deps] of Object.entries(KNOBS)) {
                if (wByName(this, knob)?.value === false) deps.forEach(d => off.add(d));
            }
            for (const row of st.inner.querySelectorAll(".nguml-row")) {
                const w = row._ngWidget;
                if (!w) continue;
                row.classList.toggle("nguml-off", off.has(w.name));
                if ((w.type === CONVERTED) !== row._ngWired) row.sync();
                else row.pull?.();
            }
        };

        // right-click -> promote any parameter to a real input socket (subgraph-ready)
        const getExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;
        nodeType.prototype.getExtraMenuOptions = function (canvas, options) {
            getExtraMenuOptions?.apply(this, arguments);
            const items = [];
            for (const wn of SECTIONS.flatMap(s => s.widgets)) {
                const w = wByName(this, wn);
                if (!w || w.type === CONVERTED) continue;
                items.push({ content: niceLabel(wn), callback: () => convertWidgetToInput(this, w) });
            }
            if (items.length) {
                options.push(null, {
                    content: "Promote to input ⚡ (subgraph)",
                    submenu: { options: items },
                });
            }
        };
    },
});

// backend load-summary events ("nougan_uml_status") — registered so the ws layer
// dispatches this custom type to us.
function api_addStatusListener() {
    app.api.addEventListener("nougan_uml_status", (ev) => {
        const d = ev.detail || {};
        const nid = d.node == null ? null : String(d.node);
        if (nid == null) return;
        // node may live in a subgraph — look in the graph on screen, then the root
        const g = app.canvas?.graph ?? app.graph;
        const node = g?.getNodeById?.(nid) ?? g?.getNodeById?.(+nid)
            ?? app.graph?.getNodeById?.(nid) ?? app.graph?.getNodeById?.(+nid);
        if (!node || node.type !== NODE_ID) return;
        const bits = [];
        if (d.model !== "(model off)") bits.push(d.quant_detected?.length ? d.quant_detected.join("+") : "bf16");
        if (d.backend) bits.push(`attn:${d.backend}`);
        if (d.sparse) bits.push("sparse");
        if (d.vsa) bits.push("vsa");
        if (d.clip2) bits.push("2×clip");
        if (d.audio_vae) bits.push("audio-vae");
        node._ngumlStatus = `loaded ✓ ${d.model} — ${bits.join(" · ")}`;
        if (node._nguml) {
            node._nguml.status.textContent = node._ngumlStatus;
        }
    });
}
