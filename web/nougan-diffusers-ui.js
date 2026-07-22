// nougan-diffusers-ui.js
// D:\ComfyUI\custom_nodes\Nougan\web\nougan-diffusers-ui.js

let app;
try { ({ app } = await import("../../scripts/app.js")); }
catch { ({ app } = await import("/scripts/app.js")); }

const NODE_NAME = "NouganDiffusersLoader";

// Hide a widget visually AND reclaim its space. For canvas widgets the
// computeSize/draw override is enough; for DOM widgets (a multiline STRING
// like model_data, which ComfyUI renders as a real <textarea>) we MUST also
// hide the element itself, otherwise it paints as an empty grey box.
function hideWidget(w) {
    if (!w) return;
    const el = w.element || w.inputEl;
    if (el) { el.style.display = "none"; el.style.height = "0"; el.style.pointerEvents = "none"; }
    if (w._ndlHidden) return;
    w._ndlHidden = true;
    w.computeSize = () => [0, -4];
    w.draw = () => {};
}
// Force LiteGraph to re-measure the node so hidden widgets + the dynamic DOM
// card actually collapse/expand the node border to fit.
function recompute(node) {
    requestAnimationFrame(() => {
        node.setDirtyCanvas?.(true, true);
        if (typeof node.onResize === "function") node.onResize(node.size);
    });
}

const STYLE_ID = "nougan-dl-styles";
function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
        /* Outer element is just an invisible sizer; the VISIBLE card is the
           inner wrapper, so it is always exactly its content height and can
           never be clipped by a clamped outer height. */
        .ndl-panel{font-family:'Inter','Segoe UI',system-ui,sans-serif;pointer-events:auto}
        .ndl-inner{padding:8px;border-radius:8px;background:linear-gradient(135deg,#1a2332,#0f1923);
          border:1px solid #2a4a6b;color:#e0e8f0;font-size:12px;
          display:flex;flex-direction:column;gap:6px}
        .ndl-inner *{box-sizing:border-box;pointer-events:auto}
        .ndl-section{padding:7px;background:rgba(255,255,255,.03);border-radius:5px;
          border:1px solid rgba(255,255,255,.06);display:flex;flex-direction:column;gap:3px}
        .ndl-section label{font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:#8899aa}
        .ndl-select{width:100%;padding:5px 7px;border-radius:4px;border:1px solid #3a5a7a;
          background:#0d1a2a;color:#e0e8f0;font-size:12px;outline:none;cursor:pointer}
        .ndl-select:hover{border-color:#5a8abf}
        .ndl-badgerow{display:flex;gap:6px}
        .ndl-badge{display:inline-flex;align-items:center;gap:4px;padding:2px 7px;border-radius:10px;
          font-size:10px;font-weight:600}
        .ndl-badge.on{background:rgba(80,200,120,.15);color:#50c878;border:1px solid rgba(80,200,120,.3)}
        .ndl-badge.off{background:rgba(255,255,255,.05);color:#667788;border:1px solid rgba(255,255,255,.1)}
        .ndl-status{padding:5px 7px;border-radius:4px;font-size:10px;background:rgba(126,184,255,.05);
          border:1px solid rgba(126,184,255,.1);color:#8899aa}
        .ndl-status .dot{display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:5px}
        .dot.g{background:#50c878}.dot.y{background:#f0c040}.dot.r{background:#e05050}
        .ndl-btn{align-self:flex-start;margin-top:2px;padding:4px 10px;border-radius:4px;
          border:1px solid #3a5a7a;background:rgba(126,184,255,.1);color:#7eb8ff;font-size:11px;cursor:pointer}
        .ndl-btn:hover{background:rgba(126,184,255,.2);border-color:#7eb8ff}
    `;
    document.head.appendChild(s);
}

app.registerExtension({
    name: "Nougan.DiffusersLoader",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;
        injectStyles();

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            onNodeCreated?.apply(this, arguments);
            const node = this;

            this.color = "#1a2a3a";
            this.bgcolor = "#0f1923";

            const wModel = this.widgets?.find(w => w.name === "model_name");
            const wSage  = this.widgets?.find(w => w.name === "sageattention_version");
            const wFlash = this.widgets?.find(w => w.name === "flashattention_version");
            const wData  = this.widgets?.find(w => w.name === "model_data");

            // Hide all native widgets — combos (canvas) AND model_data (a real
            // <textarea>, which is the grey box we're killing).
            hideWidget(wModel); hideWidget(wSage); hideWidget(wFlash); hideWidget(wData);

            const panel = document.createElement("div");
            panel.className = "ndl-panel";
            panel.innerHTML = `
                <div class="ndl-inner">
                    <div class="ndl-section">
                        <label>Model</label>
                        <select class="ndl-select" data-n="model"><option value="">— select —</option></select>
                        <button class="ndl-btn" data-n="refresh">🔄 Rescan</button>
                    </div>
                    <div class="ndl-section">
                        <label>Attention Backend</label>
                        <div class="ndl-badgerow">
                            <span class="ndl-badge off" data-n="sage-badge">Sage</span>
                            <span class="ndl-badge off" data-n="flash-badge">Flash</span>
                        </div>
                        <select class="ndl-select" data-n="sage" style="margin-top:3px;">
                            <option value="None">Sage: None</option>
                            <option value="SageAttention 2">SageAttention 2</option>
                            <option value="SageAttention 3">SageAttention 3</option>
                        </select>
                        <select class="ndl-select" data-n="flash" style="margin-top:3px;">
                            <option value="None">Flash: None</option>
                            <option value="FlashAttention 2">FlashAttention 2</option>
                            <option value="FlashAttention 3">FlashAttention 3</option>
                            <option value="FlashAttention 4">FlashAttention 4</option>
                        </select>
                    </div>
                    <div class="ndl-status" data-n="status"><span class="dot y"></span> Ready</div>
                </div>`;

            // Dynamic height: the card reserves exactly what its content needs,
            // so nothing spills outside the blue border and no empty space is
            // left below it. (+2 absorbs sub-pixel rounding so the card never
            // clips; the native widgets' [0,-4] makes them net-zero height.)
            let storedH = 240;
            this.addDOMWidget("nougan_ui", "nougan_ui", panel, {
                getHeight: () => storedH,
                setValue: () => {}, getValue: () => ({}),
            });

            const $ = s => panel.querySelector(`[data-n="${s}"]`);
            const inner    = panel.querySelector(".ndl-inner");
            const selModel = $("model"), selSage = $("sage"), selFlash = $("flash");
            const btnRefresh = $("refresh"), statusEl = $("status");
            const sageBadge = $("sage-badge"), flashBadge = $("flash-badge");

            function populateModels() {
                if (!wModel) return;
                const vals = wModel.options?.values || (Array.isArray(wModel.options) ? wModel.options : []);
                selModel.innerHTML = '<option value="">— select —</option>';
                vals.forEach(m => { const o = document.createElement("option"); o.value = m; o.textContent = m; selModel.appendChild(o); });
                if (wModel.value && ![...selModel.options].some(o => o.value === wModel.value)) {
                    const o = document.createElement("option");
                    o.value = wModel.value; o.textContent = "⚠ " + wModel.value;
                    selModel.appendChild(o);
                }
                selModel.value = wModel.value || "";
            }
            function badges() {
                sageBadge.className  = "ndl-badge " + (selSage.value  !== "None" ? "on" : "off");
                flashBadge.className = "ndl-badge " + (selFlash.value !== "None" ? "on" : "off");
                sageBadge.textContent  = selSage.value  !== "None" ? "⚡ " + selSage.value  : "Sage";
                flashBadge.textContent = selFlash.value !== "None" ? "⚡ " + selFlash.value : "Flash";
            }
            function status() {
                const m = selModel.value;
                let d = "y", t = "Ready — select a model";
                if (m) { d = "g"; t = m.split("/").pop();
                    if (selSage.value  !== "None") t += " · " + selSage.value;
                    if (selFlash.value !== "None") t += " · " + selFlash.value;
                }
                statusEl.innerHTML = `<span class="dot ${d}"></span> ${t}`;
            }
            function fit() {
                const h = inner.offsetHeight;
                if (h > 0) storedH = h + 2;
            }
            // Single render path: mirror native widgets → DOM, then size the node.
            function render() {
                hideWidget(wModel); hideWidget(wSage); hideWidget(wFlash); hideWidget(wData);
                populateModels();
                if (wSage)  selSage.value  = wSage.value  || "None";
                if (wFlash) selFlash.value = wFlash.value || "None";
                badges(); status();
                fit(); recompute(node);
                requestAnimationFrame(() => { fit(); recompute(node); });
            }

            // Events write ONLY to the native widgets (the source of truth).
            selModel.onchange = () => { if (wModel) wModel.value = selModel.value; status(); };
            selSage.onchange  = () => { if (wSage)  wSage.value  = selSage.value;  badges(); };
            selFlash.onchange = () => { if (wFlash) wFlash.value = selFlash.value; badges(); };
            btnRefresh.onclick = () => {
                btnRefresh.textContent = "⏳";
                if (wModel) { const v = wModel.value; wModel.value = ""; wModel.value = v; }
                app.graph.setDirtyCanvas(true, true);
                setTimeout(() => { populateModels(); status(); btnRefresh.textContent = "🔄 Rescan"; }, 600);
            };

            this._ndl = {
                refreshDOM: render,
                rehide: () => { hideWidget(wModel); hideWidget(wSage); hideWidget(wFlash); hideWidget(wData); },
            };

            render();
        };

        // After a saved graph loads, the native widgets hold the real values and
        // the native textarea can reappear — re-hide it, repaint, and re-measure.
        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info) {
            onConfigure?.apply(this, arguments);
            this._ndl?.rehide();
            this._ndl?.refreshDOM();
        };
    },
});