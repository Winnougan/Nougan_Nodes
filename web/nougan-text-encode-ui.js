// nougan-text-encode-ui.js
// D:\ComfyUI\custom_nodes\Nougan\web\nougan-text-encode-ui.js

let app;
try { ({ app } = await import("../../scripts/app.js")); }
catch { ({ app } = await import("/scripts/app.js")); }

const NODE_NAME = "NouganTextEncodeZeroNeg";

function hideWidget(w) {
    if (!w || w._ndlHidden) return;
    w._ndlHidden = true;
    w.computeSize = () => [0, -4];
    w.draw = () => {};
}

const STYLE_ID = "nougan-te-styles";
function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
        .nte-panel {
            font-family: 'Inter','Segoe UI',system-ui,sans-serif;
            padding: 10px; border-radius: 8px;
            background: linear-gradient(145deg, #141e2e 0%, #0c1420 100%);
            border: 1px solid #264060; color: #dce6f0;
            font-size: 12px; pointer-events: auto;
            display: flex; flex-direction: column; gap: 8px;
        }
        .nte-panel * { pointer-events: auto; box-sizing: border-box; }

        .nte-label {
            font-size: 10px; text-transform: uppercase; letter-spacing: .6px;
            color: #7a9ab8; font-weight: 600; margin-bottom: 2px;
        }

        .nte-textarea {
            width: 100%; height: 110px; resize: vertical;
            padding: 8px 10px; border-radius: 6px;
            border: 1px solid #2e4f72; background: #0a1220;
            color: #e8f0f8; font-size: 12.5px; line-height: 1.5;
            font-family: 'JetBrains Mono','Fira Code','Consolas',monospace;
            outline: none; transition: border-color .2s, box-shadow .2s;
        }
        .nte-textarea:focus {
            border-color: #5a9fd4;
            box-shadow: 0 0 0 3px rgba(90,159,212,.12);
        }
        .nte-textarea::placeholder { color: #4a6278; font-style: italic; }

        .nte-mode-row {
            display: flex; gap: 6px; align-items: center;
        }
        .nte-pill {
            padding: 4px 12px; border-radius: 12px; font-size: 11px;
            font-weight: 600; cursor: pointer; transition: all .15s;
            border: 1px solid #2e4f72; background: rgba(255,255,255,.03);
            color: #7a9ab8; user-select: none;
        }
        .nte-pill:hover { border-color: #5a9fd4; color: #a8d0f0; }
        .nte-pill.active {
            background: rgba(90,159,212,.15); border-color: #5a9fd4;
            color: #7ec8ff; box-shadow: 0 0 8px rgba(90,159,212,.15);
        }

        .nte-footer {
            display: flex; justify-content: space-between; align-items: center;
            font-size: 10px; color: #5a7a94;
        }
        .nte-count { font-variant-numeric: tabular-nums; }
        .nte-status {
            display: inline-flex; align-items: center; gap: 4px;
        }
        .nte-status .dot {
            width: 6px; height: 6px; border-radius: 50%;
            background: #3a5a72; transition: background .3s;
        }
        .nte-status .dot.ok { background: #50c878; box-shadow: 0 0 4px #50c878; }
    `;
    document.head.appendChild(s);
}

app.registerExtension({
    name: "Nougan.TextEncodeZeroNeg",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;
        injectStyles();

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            onNodeCreated?.apply(this, arguments);

            this.color = "#16222f";
            this.bgcolor = "#0c1420";

            const wPos  = this.widgets?.find(w => w.name === "positive");
            const wMode = this.widgets?.find(w => w.name === "negative_mode");

            hideWidget(wPos);
            hideWidget(wMode);

            // ── Build panel ──
            const panel = document.createElement("div");
            panel.className = "nte-panel";
            panel.innerHTML = `
                <div>
                    <div class="nte-label">✍️ Positive Prompt</div>
                    <textarea class="nte-textarea" data-n="pos"
                        placeholder="Describe what you want to generate…"
                        spellcheck="false"></textarea>
                </div>
                <div>
                    <div class="nte-label">Negative Conditioning</div>
                    <div class="nte-mode-row">
                        <span class="nte-pill active" data-n="pill-zero">⊘ Zero Out</span>
                        <span class="nte-pill" data-n="pill-empty">∅ Empty String</span>
                    </div>
                </div>
                <div class="nte-footer">
                    <span class="nte-count" data-n="count">0 chars · 0 words</span>
                    <span class="nte-status"><span class="dot" data-n="dot"></span> ready</span>
                </div>
            `;

            this.addDOMWidget("nte_ui", "nte_ui", panel, {
                getHeight: () => 210,
                setValue: () => {},
                getValue: () => ({}),
            });

            const $ = s => panel.querySelector(`[data-n="${s}"]`);
            const ta      = $("pos");
            const pillZ   = $("pill-zero");
            const pillE   = $("pill-empty");
            const countEl = $("count");
            const dot     = $("dot");

            // ── Helpers ──
            function updateCount() {
                const v = ta.value;
                const words = v.trim() ? v.trim().split(/\s+/).length : 0;
                countEl.textContent = `${v.length} chars · ${words} words`;
            }
            function setMode(mode) {
                const zero = mode === "Zero Out";
                pillZ.classList.toggle("active", zero);
                pillE.classList.toggle("active", !zero);
                if (wMode) wMode.value = mode;
            }
            function markOk() {
                dot.classList.add("ok");
                setTimeout(() => dot.classList.remove("ok"), 1200);
            }
            function refreshDOM() {
                if (wPos) ta.value = wPos.value || "";
                if (wMode) setMode(wMode.value || "Zero Out");
                updateCount();
            }

            // ── Events ──
            ta.addEventListener("input", () => {
                if (wPos) wPos.value = ta.value;
                updateCount();
                markOk();
            });
            pillZ.addEventListener("click", () => { setMode("Zero Out"); markOk(); });
            pillE.addEventListener("click", () => { setMode("Empty String"); markOk(); });

            // Stash for onConfigure
            this._nte = { refreshDOM };
            refreshDOM();
        };

        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info) {
            onConfigure?.apply(this, arguments);
            this._nte?.refreshDOM();
        };
    },
});