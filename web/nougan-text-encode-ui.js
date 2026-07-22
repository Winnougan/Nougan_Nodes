// nougan-text-encode-ui.js
// D:\ComfyUI\custom_nodes\Nougan\web\nougan-text-encode-ui.js

let app;
try { ({ app } = await import("../../scripts/app.js")); }
catch { ({ app } = await import("/scripts/app.js")); }

const NODE_NAME = "NouganTextEncodeZeroNeg";

// Hide a widget visually AND reclaim its space (canvas footprint + DOM element).
function hideWidget(w) {
    if (!w) return;
    const el = w.element || w.inputEl;
    if (el) { el.style.display = "none"; el.style.height = "0"; el.style.pointerEvents = "none"; }
    if (w._ndlHidden) return;
    w._ndlHidden = true;
    w.computeSize = () => [0, -4];
    w.draw = () => {};
}
function recompute(node) {
    requestAnimationFrame(() => {
        node.setDirtyCanvas(true, true);
        if (typeof node.onResize === "function") node.onResize(node.size);
    });
}

// Resolve a link id → the id of the node it comes from (handles both the
// classic array-form graph.links and the newer LLink object/Map form).
function originIdOf(graph, linkId) {
    if (linkId == null || !graph || !graph.links) return null;
    const L = graph.links;
    const entry = (typeof L.get === "function") ? L.get(linkId) : L[linkId];
    if (!entry) return null;
    if (entry.origin_id != null) return entry.origin_id;   // object / LLink
    if (Array.isArray(entry)) return entry[1];             // [id, origin, ...]
    return null;
}
// Best-effort: read the first string widget a node exposes (the Text Box's
// `text`, a primitive's value, etc.). Returns null for computed / file sources.
function readStringWidget(n) {
    if (!n || !n.widgets) return null;
    for (const w of n.widgets) if (typeof w.value === "string") return w.value;
    return null;
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
            display: flex; align-items: center; gap: 4px; flex-wrap: wrap;
        }
        .nte-linked-tag {
            color: #ff9ec6; font-weight: 800; letter-spacing: .3px;
            text-transform: uppercase; font-size: 9.5px;
            background: rgba(255,93,158,.12); border: 1px solid rgba(255,93,158,.3);
            padding: 1px 7px; border-radius: 9px;
        }

        .nte-textarea {
            width: 100%; height: 110px; resize: vertical;
            padding: 8px 10px; border-radius: 6px;
            border: 1px solid #2e4f72; background: #0a1220;
            color: #e8f0f8; font-size: 12.5px; line-height: 1.5;
            font-family: 'JetBrains Mono','Fira Code','Consolas',monospace;
            outline: none; transition: border-color .2s, box-shadow .2s, opacity .2s;
        }
        .nte-textarea:focus {
            border-color: #5a9fd4;
            box-shadow: 0 0 0 3px rgba(90,159,212,.12);
        }
        .nte-textarea::placeholder { color: #4a6278; font-style: italic; }
        /* Locked state: dimmed + dashed + non-editing cursor */
        .nte-textarea.linked {
            opacity: .62; background: #0a0f17; color: #8aa0b8;
            border-style: dashed; border-color: #3a4d68; cursor: default;
        }

        .nte-mode-row { display: flex; gap: 6px; align-items: center; }
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
        .nte-status { display: inline-flex; align-items: center; gap: 4px; }
        .nte-status .dot {
            width: 6px; height: 6px; border-radius: 50%;
            background: #3a5a72; transition: background .3s;
        }
        .nte-status .dot.ok { background: #50c878; box-shadow: 0 0 4px #50c878; }
        .nte-status .dot.link { background: #ff9ec6; box-shadow: 0 0 4px #ff9ec6; }
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
            const node = this;

            this.color = "#16222f";
            this.bgcolor = "#0c1420";

            const wPos  = this.widgets?.find(w => w.name === "positive");
            const wMode = this.widgets?.find(w => w.name === "negative_mode");

            const panel = document.createElement("div");
            panel.className = "nte-panel";
            panel.innerHTML = `
                <div>
                    <div class="nte-label">
                        <span data-n="poslabel">✍️ Positive Prompt</span>
                        <span class="nte-linked-tag" data-n="linkedtag" hidden></span>
                    </div>
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
                    <span class="nte-status" data-n="status"><span class="dot"></span> ready</span>
                </div>
            `;

            this.addDOMWidget("nte_ui", "nte_ui", panel, {
                getHeight: () => 210,
                setValue: () => {},
                getValue: () => ({}),
            });

            const $ = s => panel.querySelector(`[data-n="${s}"]`);
            const ta        = $("pos");
            const linkedTag = $("linkedtag");
            const pillZ     = $("pill-zero");
            const pillE     = $("pill-empty");
            const countEl   = $("count");
            const statusEl  = $("status");

            function updateCount(text) {
                const v = text || "";
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
                const d = statusEl.querySelector(".dot");
                if (d) { d.classList.add("ok"); setTimeout(() => d.classList.remove("ok"), 1200); }
            }

            // Is the positive input currently driven by a link? If so, who from,
            // and what text are they sending (when readable)?
            function connectedState() {
                const posIn = node.inputs?.find(i => i.name === "positive");
                if (!posIn || !posIn.link) return { connected: false };
                const oid    = originIdOf(app.graph, posIn.link);
                const origin = oid != null ? app.graph.getNodeById(oid) : null;
                const title  = origin?.title || "upstream node";
                const preview = readStringWidget(origin);
                return { connected: true, originId: oid, originTitle: title, preview };
            }

            // Light poll so the greyed preview tracks the upstream text live
            // (only runs while connected; only re-renders on actual change).
            let pollTimer = null, lastPreview = null;
            function startPoll() {
                if (pollTimer) return;
                pollTimer = setInterval(() => {
                    const cs = connectedState();
                    if (!cs.connected) { render(); return; }
                    if (cs.preview !== lastPreview) { lastPreview = cs.preview; render(); }
                }, 250);
            }
            function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } lastPreview = null; }

            // ── The single render path: branch on connection state ──
            function render() {
                // Always keep the native widgets collapsed (covers ComfyUI's
                // own convert/un-convert on connect & disconnect).
                hideWidget(wPos);
                hideWidget(wMode);

                const cs = connectedState();
                if (cs.connected) {
                    const incoming = cs.preview;
                    const display = (incoming != null && incoming !== "")
                        ? incoming
                        : `🔗  linked from “${cs.originTitle}”  — text is provided by the connected node at run time`;
                    if (ta.value !== display) ta.value = display;
                    ta.readOnly = true;
                    ta.classList.add("linked");
                    linkedTag.hidden = false;
                    linkedTag.textContent = `🔗 FROM ${cs.originTitle}`;
                    updateCount(incoming || "");          // count the *incoming* text
                    statusEl.innerHTML = `<span class="dot link"></span> linked ← ${cs.originTitle}`;
                    lastPreview = incoming;
                    startPoll();
                } else {
                    ta.readOnly = false;
                    ta.classList.remove("linked");
                    linkedTag.hidden = true;
                    const own = wPos ? (wPos.value || "") : "";
                    if (ta.value !== own) ta.value = own;  // restore own (non-destructive)
                    updateCount(ta.value);
                    statusEl.innerHTML = `<span class="dot"></span> ready`;
                    stopPoll();
                }
                // reflect negative mode + (only when editable) keep widget synced
                if (wMode) setMode(wMode.value || "Zero Out");
            }

            // ── Events ──
            ta.addEventListener("input", () => {
                if (ta.readOnly) return;                  // locked: ignore (linked)
                if (wPos) wPos.value = ta.value;
                updateCount(ta.value);
                markOk();
            });
            pillZ.addEventListener("click", () => { if (wMode) wMode.value = "Zero Out"; setMode("Zero Out"); markOk(); });
            pillE.addEventListener("click", () => { if (wMode) wMode.value = "Empty String"; setMode("Empty String"); markOk(); });

            this._nte = { refreshDOM: render, stopPoll };

            render();
            recompute(this);
        };

        // Re-paint (and re-lock / unlock) after a saved graph is configured.
        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info) {
            onConfigure?.apply(this, arguments);
            this._nte?.refreshDOM();
        };

        // Flip the lock the instant a link is added or removed.
        const onConnectionsChange = nodeType.prototype.onConnectionsChange;
        nodeType.prototype.onConnectionsChange = function (type, index, connected, link_info, io) {
            onConnectionsChange?.apply(this, arguments);
            const INPUT = (window.LiteGraph && LiteGraph.INPUT) || 1;
            if (type === INPUT) this._nte?.refreshDOM();
        };

        // Don't leak the poll timer if the node is deleted.
        const onRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            this._nte?.stopPoll?.();
            onRemoved?.apply(this, arguments);
        };
    },
});