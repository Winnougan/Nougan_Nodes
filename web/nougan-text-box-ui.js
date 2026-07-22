// nougan-text-box-ui.js
// D:\ComfyUI\custom_nodes\Nougan\web\nougan-text-box-ui.js

let app;
try { ({ app } = await import("../../scripts/app.js")); }
catch { ({ app } = await import("/scripts/app.js")); }

const NODE_NAME = "NouganTextBox";

// Hide the native widget whether it's canvas-drawn OR a DOM textarea
// (newer ComfyUI renders multiline strings as a real <textarea> element).
function hideWidget(w) {
    if (!w || w._ntbHidden) return;
    w._ntbHidden = true;
    w.computeSize = () => [0, -4];
    w.draw = () => {};
    const el = w.element || w.inputEl;
    if (el) { el.style.display = "none"; el.style.height = "0"; el.style.pointerEvents = "none"; }
}

const STYLE_ID = "nougan-tb-styles";
function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
        .ntb-panel {
            font-family: 'Inter','Segoe UI',system-ui,sans-serif;
            padding: 10px 10px 8px 12px; border-radius: 8px;
            background: linear-gradient(150deg, #1c1a14 0%, #12110c 100%);
            border: 1px solid #4a3d22; border-left: 3px solid #d9a441;
            color: #ece3cf; font-size: 12px; pointer-events: auto;
            display: flex; flex-direction: column; gap: 8px;
            box-shadow: inset 0 1px 0 rgba(255,225,150,.04);
        }
        .ntb-panel * { pointer-events: auto; box-sizing: border-box; }

        .ntb-head {
            display: flex; align-items: center; gap: 6px;
            font-size: 11px; font-weight: 700; letter-spacing: .4px;
            color: #e7c878; text-transform: uppercase;
        }
        .ntb-head .ico { font-size: 13px; filter: saturate(1.2); }

        .ntb-textarea {
            width: 100%; min-height: 130px; resize: vertical;
            padding: 9px 11px; border-radius: 6px;
            border: 1px solid #4a3d22; background: #0d0c08;
            color: #f3ecd8; font-size: 13px; line-height: 1.6;
            font-family: 'JetBrains Mono','Fira Code','Consolas',monospace;
            outline: none; transition: border-color .2s, box-shadow .2s;
        }
        .ntb-textarea:focus {
            border-color: #d9a441;
            box-shadow: 0 0 0 3px rgba(217,164,65,.14);
        }
        .ntb-textarea::placeholder { color: #6b5d3c; font-style: italic; }

        .ntb-foot {
            display: flex; justify-content: space-between; align-items: center;
            gap: 8px;
        }
        .ntb-counts {
            font-size: 10px; color: #8a7a52; font-variant-numeric: tabular-nums;
            display: flex; gap: 8px;
        }
        .ntb-counts b { color: #c9b483; font-weight: 600; }
        .ntb-actions { display: flex; gap: 6px; align-items: center; }
        .ntb-btn {
            padding: 3px 10px; border-radius: 11px; font-size: 10px; font-weight: 600;
            cursor: pointer; border: 1px solid #4a3d22; background: rgba(217,164,65,.08);
            color: #d9b463; transition: all .15s; user-select: none;
        }
        .ntb-btn:hover { background: rgba(217,164,65,.18); border-color: #d9a441; color: #f0d690; }
        .ntb-btn:active { transform: translateY(1px); }
        .ntb-dot {
            width: 6px; height: 6px; border-radius: 50%; background: #5a4d2c;
            transition: background .3s, box-shadow .3s;
        }
        .ntb-dot.ok { background: #d9a441; box-shadow: 0 0 6px #d9a441; }
    `;
    document.head.appendChild(s);
}

app.registerExtension({
    name: "Nougan.TextBox",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;
        injectStyles();

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            onNodeCreated?.apply(this, arguments);

            this.color = "#221d12";
            this.bgcolor = "#12110c";

            const wText = this.widgets?.find(w => w.name === "text");
            hideWidget(wText);

            const panel = document.createElement("div");
            panel.className = "ntb-panel";
            panel.innerHTML = `
                <div class="ntb-head"><span class="ico">📝</span> Text Box</div>
                <textarea class="ntb-textarea" data-n="ta"
                    placeholder="Write your text here…" spellcheck="false"></textarea>
                <div class="ntb-foot">
                    <div class="ntb-counts">
                        <span><b data-n="chars">0</b> chars</span>
                        <span><b data-n="words">0</b> words</span>
                        <span><b data-n="lines">0</b> lines</span>
                    </div>
                    <div class="ntb-actions">
                        <span class="ntb-dot" data-n="dot"></span>
                        <span class="ntb-btn" data-n="copy">⧉ Copy</span>
                        <span class="ntb-btn" data-n="clear">✕ Clear</span>
                    </div>
                </div>
            `;

            this.addDOMWidget("ntb_ui", "ntb_ui", panel, {
                getHeight: () => 220, setValue: () => {}, getValue: () => ({}),
            });

            const $ = s => panel.querySelector(`[data-n="${s}"]`);
            const ta = $("ta"), dot = $("dot");
            const cChars = $("chars"), cWords = $("words"), cLines = $("lines");
            const btnCopy = $("copy"), btnClear = $("clear");

            function counts() {
                const v = ta.value;
                cChars.textContent = v.length;
                cWords.textContent = v.trim() ? v.trim().split(/\s+/).length : 0;
                cLines.textContent = v ? v.split("\n").length : 0;
            }
            function pulse() {
                dot.classList.add("ok");
                setTimeout(() => dot.classList.remove("ok"), 1100);
            }
            function refreshDOM() {
                ta.value = wText ? (wText.value || "") : "";
                counts();
            }

            ta.addEventListener("input", () => {
                if (wText) wText.value = ta.value;   // widget = source of truth
                counts(); pulse();
            });

            btnCopy.addEventListener("click", async () => {
                try {
                    await navigator.clipboard.writeText(ta.value);
                } catch {
                    ta.select(); document.execCommand?.("copy");
                }
                const old = btnCopy.textContent;
                btnCopy.textContent = "✓ Copied";
                setTimeout(() => { btnCopy.textContent = old; }, 1200);
            });

            btnClear.addEventListener("click", () => {
                ta.value = "";
                if (wText) wText.value = "";
                counts(); pulse();
                ta.focus();
            });

            this._ntb = { refreshDOM };
            refreshDOM();

            requestAnimationFrame(() => { this.setDirtyCanvas(true, true); this.onResize?.(this.size); });
        };

        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info) {
            onConfigure?.apply(this, arguments);
            this._ntb?.refreshDOM();
        };
    },
});