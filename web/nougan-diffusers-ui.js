// nougan-diffusers-ui.js
// Location: D:\ComfyUI\custom_nodes\Nougan\web\nougan-diffusers-ui.js

// ─── Robust imports (old + new ComfyUI frontend) ────────────────────────────
let app, api;
try {
    ({ app } = await import("../../scripts/app.js"));
    ({ api } = await import("../../scripts/api.js"));
} catch (e1) {
    try {
        ({ app } = await import("/scripts/app.js"));
        ({ api } = await import("/scripts/api.js"));
    } catch (e2) {
        console.error("[Nougan UI] ❌ Cannot import app/api.", e1, e2);
        throw e2;
    }
}

console.log("[Nougan UI] ✅ Module loaded. Registering extension...");

const EXT_NAME  = "Nougan.DiffusersLoader";
const NODE_NAME = "NouganDiffusersLoader"; // must EXACTLY match NODE_CLASS_MAPPINGS key

// ─── Hide a widget VISUALLY but keep it serializing ─────────────────────────
// We do NOT change widget.type and we do NOT touch serializeValue, so the
// value still reaches the Python backend. We only collapse its height to 0
// ([0, -4] cancels LiteGraph's 4px widget margin) and no-op its draw().
function hideWidget(widget) {
    if (!widget || widget._nouganHidden) return;
    widget._nouganHidden = true;
    widget.computeSize = () => [0, -4];
    widget.draw = function () {};
}

// ─── Inject CSS once ────────────────────────────────────────────────────────
const STYLE_ID = "nougan-diffusers-loader-styles";
function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
        .nougan-dl-panel {
            font-family: 'Inter', 'Segoe UI', system-ui, sans-serif;
            padding: 10px; border-radius: 8px;
            background: linear-gradient(135deg, #1a2332 0%, #0f1923 100%);
            border: 1px solid #2a4a6b; color: #e0e8f0;
            font-size: 12px; user-select: none; pointer-events: auto;
        }
        .nougan-dl-panel * { pointer-events: auto; }
        .nougan-dl-panel h3 {
            margin: 0 0 8px 0; font-size: 13px; color: #7eb8ff;
            display: flex; align-items: center; gap: 6px;
        }
        .nougan-dl-section {
            margin-bottom: 8px; padding: 8px;
            background: rgba(255,255,255,0.03);
            border-radius: 6px; border: 1px solid rgba(255,255,255,0.06);
        }
        .nougan-dl-section label {
            display: block; font-size: 10px; text-transform: uppercase;
            letter-spacing: 0.5px; color: #8899aa; margin-bottom: 4px;
        }
        .nougan-dl-select {
            width: 100%; padding: 6px 8px; border-radius: 4px;
            border: 1px solid #3a5a7a; background: #0d1a2a;
            color: #e0e8f0; font-size: 12px; outline: none; cursor: pointer;
        }
        .nougan-dl-select:hover { border-color: #5a8abf; }
        .nougan-dl-badge {
            display: inline-flex; align-items: center; gap: 4px;
            padding: 3px 8px; border-radius: 10px; font-size: 10px; font-weight: 600;
        }
        .nougan-dl-badge.active {
            background: rgba(80,200,120,0.15); color: #50c878;
            border: 1px solid rgba(80,200,120,0.3);
        }
        .nougan-dl-badge.inactive {
            background: rgba(255,255,255,0.05); color: #667788;
            border: 1px solid rgba(255,255,255,0.1);
        }
        .nougan-dl-status {
            margin-top: 8px; padding: 6px 8px; border-radius: 4px;
            font-size: 10px; background: rgba(126,184,255,0.05);
            border: 1px solid rgba(126,184,255,0.1); color: #8899aa;
        }
        .nougan-dl-status .dot {
            display: inline-block; width: 6px; height: 6px;
            border-radius: 50%; margin-right: 5px;
        }
        .dot.green  { background: #50c878; }
        .dot.yellow { background: #f0c040; }
        .dot.red    { background: #e05050; }
        .nougan-dl-refresh-btn {
            margin-top: 6px; padding: 5px 12px; border-radius: 4px;
            border: 1px solid #3a5a7a; background: rgba(126,184,255,0.1);
            color: #7eb8ff; font-size: 11px; cursor: pointer;
        }
        .nougan-dl-refresh-btn:hover {
            background: rgba(126,184,255,0.2); border-color: #7eb8ff;
        }
    `;
    document.head.appendChild(s);
}

// ─── Register ───────────────────────────────────────────────────────────────
app.registerExtension({
    name: EXT_NAME,

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;

        console.log(`[Nougan UI] ✅ Matched node: ${nodeData.name}`);
        injectStyles();

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            onNodeCreated?.apply(this, arguments);

            this.color   = "#1a2a3a";
            this.bgcolor = "#0f1923";

            // ── Find widgets ──
            const wModel = this.widgets?.find(w => w.name === "model_name");
            const wSage  = this.widgets?.find(w => w.name === "sageattention_version");
            const wFlash = this.widgets?.find(w => w.name === "flashattention_version");
            const wData  = this.widgets?.find(w => w.name === "model_data");

            console.log("[Nougan UI] Widgets found:", {
                model: !!wModel, sage: !!wSage, flash: !!wFlash, data: !!wData
            });

            // ── HIDE all native widgets (visually only; values still serialize) ──
            hideWidget(wModel);
            hideWidget(wSage);
            hideWidget(wFlash);
            hideWidget(wData);

            // ── Build DOM panel ──
            const panel = document.createElement("div");
            panel.className = "nougan-dl-panel";
            panel.innerHTML = `
                <h3>🚀 Nougan Diffusers Loader</h3>
                <div class="nougan-dl-section">
                    <label>Model</label>
                    <select class="nougan-dl-select" data-nougan="model">
                        <option value="">— select —</option>
                    </select>
                    <button class="nougan-dl-refresh-btn" data-nougan="refresh">🔄 Rescan</button>
                </div>
                <div class="nougan-dl-section">
                    <label>Attention Backend</label>
                    <div style="display:flex;gap:6px;margin:4px 0;">
                        <span class="nougan-dl-badge inactive" data-nougan="sage-badge">Sage</span>
                        <span class="nougan-dl-badge inactive" data-nougan="flash-badge">Flash</span>
                    </div>
                    <select class="nougan-dl-select" data-nougan="sage" style="margin-top:4px;">
                        <option value="None">Sage: None</option>
                        <option value="SageAttention 2">SageAttention 2</option>
                        <option value="SageAttention 3">SageAttention 3</option>
                    </select>
                    <select class="nougan-dl-select" data-nougan="flash" style="margin-top:4px;">
                        <option value="None">Flash: None</option>
                        <option value="FlashAttention 2">FlashAttention 2</option>
                        <option value="FlashAttention 3">FlashAttention 3</option>
                        <option value="FlashAttention 4">FlashAttention 4</option>
                    </select>
                </div>
                <div class="nougan-dl-status" data-nougan="status">
                    <span class="dot yellow"></span> Ready
                </div>
            `;

            // ── Attach via addDOMWidget (the ONLY visible thing now) ──
            this.addDOMWidget("nougan_ui", "nougan_ui", panel, {
                getHeight: () => 250,
                setValue: () => {},
                getValue: () => ({}),
            });

            // ── Grab elements ──
            const selModel   = panel.querySelector('[data-nougan="model"]');
            const selSage    = panel.querySelector('[data-nougan="sage"]');
            const selFlash   = panel.querySelector('[data-nougan="flash"]');
            const btnRefresh = panel.querySelector('[data-nougan="refresh"]');
            const statusEl   = panel.querySelector('[data-nougan="status"]');
            const sageBadge  = panel.querySelector('[data-nougan="sage-badge"]');
            const flashBadge = panel.querySelector('[data-nougan="flash-badge"]');

            // ── Populate model dropdown (with sync safeguard) ──
            function populateModels() {
                if (!wModel) return;
                const vals = wModel.options?.values
                    || (Array.isArray(wModel.options) ? wModel.options : []);
                selModel.innerHTML = '<option value="">— select —</option>';
                vals.forEach(m => {
                    const o = document.createElement("option");
                    o.value = m; o.textContent = m;
                    selModel.appendChild(o);
                });
                // SAFEGUARD: if the saved value isn't in the scanned list
                // (e.g. model moved/renamed), add it so the <select> can
                // represent it and the value stays valid for the backend.
                if (wModel.value && ![...selModel.options].some(o => o.value === wModel.value)) {
                    const o = document.createElement("option");
                    o.value = wModel.value;
                    o.textContent = "⚠ " + wModel.value + "  (not in scan)";
                    selModel.appendChild(o);
                }
                selModel.value = wModel.value || "";
            }
            populateModels();

            // ── Sync helpers ──
            function syncConfig() {
                if (!wData) return;
                wData.value = JSON.stringify({
                    model_name: selModel.value || undefined,
                    sageattention_version: selSage.value,
                    flashattention_version: selFlash.value,
                });
            }
            function updateStatus() {
                const m = selModel.value;
                let dot = "yellow", msg = "Ready — select a model";
                if (m) {
                    dot = "green";
                    msg = m.split("/").pop();
                    if (selSage.value  !== "None") msg += " · " + selSage.value;
                    if (selFlash.value !== "None") msg += " · " + selFlash.value;
                }
                statusEl.innerHTML = `<span class="dot ${dot}"></span> ${msg}`;
            }
            function updateBadges() {
                sageBadge.className  = "nougan-dl-badge " + (selSage.value  !== "None" ? "active" : "inactive");
                flashBadge.className = "nougan-dl-badge " + (selFlash.value !== "None" ? "active" : "inactive");
                sageBadge.textContent  = selSage.value  !== "None" ? "⚡ " + selSage.value  : "Sage";
                flashBadge.textContent = selFlash.value !== "None" ? "⚡ " + selFlash.value : "Flash";
            }

            // ── Events ──
            selModel.addEventListener("change", () => {
                if (wModel) wModel.value = selModel.value;
                syncConfig(); updateStatus();
            });
            selSage.addEventListener("change", () => {
                if (wSage) wSage.value = selSage.value;
                updateBadges(); syncConfig();
            });
            selFlash.addEventListener("change", () => {
                if (wFlash) wFlash.value = selFlash.value;
                updateBadges(); syncConfig();
            });
            btnRefresh.addEventListener("click", () => {
                btnRefresh.textContent = "⏳...";
                // Nudge IS_CHANGED so the Python side re-scans
                if (wModel) { const v = wModel.value; wModel.value = ""; wModel.value = v; }
                app.graph.setDirtyCanvas(true, true);
                setTimeout(() => { populateModels(); btnRefresh.textContent = "🔄 Rescan"; }, 600);
            });

            // ── Init from existing widget values ──
            if (wSage?.value)  selSage.value  = wSage.value;
            if (wFlash?.value) selFlash.value = wFlash.value;
            updateBadges();
            updateStatus();
            syncConfig();

            // ── Force layout recompute so the hidden widgets truly collapse ──
            const recompute = () => {
                this.setDirtyCanvas(true, true);
                if (typeof this.onResize === "function") this.onResize(this.size);
            };
            requestAnimationFrame(recompute);
            setTimeout(recompute, 60);

            console.log("[Nougan UI] ✅ Panel attached; native widgets hidden.");
        };
    },
});

console.log("[Nougan UI] ✅ Extension registered:", EXT_NAME);
