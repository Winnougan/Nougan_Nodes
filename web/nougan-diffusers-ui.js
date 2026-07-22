// nougan-diffusers-ui.js
// D:\ComfyUI\custom_nodes\Nougan\web\nougan-diffusers-ui.js

let app;
try {
    ({ app } = await import("../../scripts/app.js"));
} catch {
    ({ app } = await import("/scripts/app.js"));
}

const NODE_NAME = "NouganDiffusersLoader";

function hideWidget(w) {
    if (!w || w._nouganHidden) return;
    w._nouganHidden = true;
    w.computeSize = () => [0, -4];
    w.draw = () => {};
}

const STYLE_ID = "nougan-dl-styles";
function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
        .ndl-panel {
            font-family: 'Inter','Segoe UI',system-ui,sans-serif;
            padding: 8px; border-radius: 6px;
            background: linear-gradient(135deg,#1a2332,#0f1923);
            border: 1px solid #2a4a6b; color: #e0e8f0;
            font-size: 12px; pointer-events: auto;
        }
        .ndl-panel * { pointer-events: auto; }
        .ndl-section {
            margin-bottom: 6px; padding: 7px;
            background: rgba(255,255,255,.03);
            border-radius: 5px; border: 1px solid rgba(255,255,255,.06);
        }
        .ndl-section label {
            display: block; font-size: 10px; text-transform: uppercase;
            letter-spacing: .5px; color: #8899aa; margin-bottom: 3px;
        }
        .ndl-select {
            width: 100%; padding: 5px 7px; border-radius: 4px;
            border: 1px solid #3a5a7a; background: #0d1a2a;
            color: #e0e8f0; font-size: 12px; outline: none; cursor: pointer;
        }
        .ndl-select:hover { border-color: #5a8abf; }
        .ndl-badge {
            display: inline-flex; align-items: center; gap: 4px;
            padding: 2px 7px; border-radius: 10px; font-size: 10px; font-weight: 600;
        }
        .ndl-badge.on  { background: rgba(80,200,120,.15); color: #50c878; border: 1px solid rgba(80,200,120,.3); }
        .ndl-badge.off { background: rgba(255,255,255,.05); color: #667788; border: 1px solid rgba(255,255,255,.1); }
        .ndl-status {
            margin-top: 6px; padding: 5px 7px; border-radius: 4px;
            font-size: 10px; background: rgba(126,184,255,.05);
            border: 1px solid rgba(126,184,255,.1); color: #8899aa;
        }
        .ndl-status .dot { display:inline-block; width:6px; height:6px; border-radius:50%; margin-right:5px; }
        .dot.g { background:#50c878; } .dot.y { background:#f0c040; } .dot.r { background:#e05050; }
        .ndl-btn {
            margin-top: 5px; padding: 4px 10px; border-radius: 4px;
            border: 1px solid #3a5a7a; background: rgba(126,184,255,.1);
            color: #7eb8ff; font-size: 11px; cursor: pointer;
        }
        .ndl-btn:hover { background: rgba(126,184,255,.2); border-color: #7eb8ff; }
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

            this.color   = "#1a2a3a";
            this.bgcolor = "#0f1923";

            const wModel = this.widgets?.find(w => w.name === "model_name");
            const wSage  = this.widgets?.find(w => w.name === "sageattention_version");
            const wFlash = this.widgets?.find(w => w.name === "flashattention_version");
            const wData  = this.widgets?.find(w => w.name === "model_data");

            hideWidget(wModel);
            hideWidget(wSage);
            hideWidget(wFlash);
            hideWidget(wData);

            // ── Panel (no <h3> — the node title bar already says the name) ──
            const panel = document.createElement("div");
            panel.className = "ndl-panel";
            panel.innerHTML = `
                <div class="ndl-section">
                    <label>Model</label>
                    <select class="ndl-select" data-n="model"><option value="">— select —</option></select>
                    <button class="ndl-btn" data-n="refresh">🔄 Rescan</button>
                </div>
                <div class="ndl-section">
                    <label>Attention Backend</label>
                    <div style="display:flex;gap:6px;margin:3px 0;">
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
            `;

            this.addDOMWidget("nougan_ui", "nougan_ui", panel, {
                getHeight: () => 210,
                setValue: () => {},
                getValue: () => ({}),
            });

            const $ = s => panel.querySelector(`[data-n="${s}"]`);
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
            populateModels();

            function sync() {
                if (wData) wData.value = JSON.stringify({
                    model_name: selModel.value || undefined,
                    sageattention_version: selSage.value,
                    flashattention_version: selFlash.value,
                });
            }
            function status() {
                const m = selModel.value;
                let d = "y", t = "Ready — select a model";
                if (m) { d = "g"; t = m.split("/").pop();
                    if (selSage.value !== "None") t += " · " + selSage.value;
                    if (selFlash.value !== "None") t += " · " + selFlash.value;
                }
                statusEl.innerHTML = `<span class="dot ${d}"></span> ${t}`;
            }
            function badges() {
                sageBadge.className  = "ndl-badge " + (selSage.value !== "None" ? "on" : "off");
                flashBadge.className = "ndl-badge " + (selFlash.value !== "None" ? "on" : "off");
                sageBadge.textContent  = selSage.value !== "None" ? "⚡ " + selSage.value : "Sage";
                flashBadge.textContent = selFlash.value !== "None" ? "⚡ " + selFlash.value : "Flash";
            }

            selModel.onchange = () => { if (wModel) wModel.value = selModel.value; sync(); status(); };
            selSage.onchange  = () => { if (wSage) wSage.value = selSage.value; badges(); sync(); };
            selFlash.onchange = () => { if (wFlash) wFlash.value = selFlash.value; badges(); sync(); };
            btnRefresh.onclick = () => {
                btnRefresh.textContent = "⏳";
                if (wModel) { const v = wModel.value; wModel.value = ""; wModel.value = v; }
                app.graph.setDirtyCanvas(true, true);
                setTimeout(() => { populateModels(); btnRefresh.textContent = "🔄 Rescan"; }, 600);
            };

            if (wSage?.value)  selSage.value  = wSage.value;
            if (wFlash?.value) selFlash.value = wFlash.value;
            badges(); status(); sync();

            // ── Resync after ComfyUI restores saved widget values ──────────
            // onNodeCreated runs BEFORE the saved workflow's widget values
            // are applied to this node (that happens in onConfigure). At the
            // point above, wModel/wSage/wFlash still hold their *defaults*,
            // and the <select> elements snapshot those defaults. Nothing
            // then re-reads the widgets once the real saved values land —
            // which is exactly why it looked like "resets to Fal Ideogram /
            // attention off" on every reload.
            const onConfigure = nodeType.prototype.onConfigure;
            nodeType.prototype.onConfigure = function (info) {
                onConfigure?.apply(this, arguments);

                populateModels();                       // re-read wModel.value now that it's real
                if (wSage)  selSage.value  = wSage.value  || "None";
                if (wFlash) selFlash.value = wFlash.value || "None";
                badges();
                status();
                sync();
            };

            requestAnimationFrame(() => { this.setDirtyCanvas(true, true); this.onResize?.(this.size); });
        };
    },
});