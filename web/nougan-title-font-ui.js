// nougan-title-font-ui.js
// D:\ComfyUI\custom_nodes\Nougan\web\nougan-title-font-ui.js
//
// BILLBOARD MODE: the entire card is rendered at a constant on-screen size
// regardless of canvas zoom. We counter-scale the panel by 1/zoom (so the
// layer's zoom cancels out) and resize the canvas node rectangle to match,
// keeping the outline + hit-testing aligned with the visible card.

let app;
try { ({ app } = await import("../../scripts/app.js")); }
catch { ({ app } = await import("/scripts/app.js")); }

const NODE_NAME = "NouganTitleFont";
const DESIGN_W = 360; // card design width in px (its on-screen width at all zooms)

function hideWidget(w) {
    if (!w) return;
    const el = w.element || w.inputEl;
    if (el) { el.style.display = "none"; el.style.height = "0"; el.style.pointerEvents = "none"; }
    if (w._ntfHidden) return;
    w._ntfHidden = true;
    w.computeSize = () => [0, -4];
    w.draw = () => {};
}
function recompute(node) {
    requestAnimationFrame(() => {
        if (typeof node.onResize === "function") node.onResize(node.size);
        node.setDirtyCanvas?.(true, true);
    });
}
function curScale() { return (app.canvas && app.canvas.ds && app.canvas.ds.scale) || 1; }
function curInv()   { return Math.max(0.125, Math.min(8, 1 / curScale())); }

const PRESETS = [
    { n: "Sunset", a: "#ff512f", b: "#f09819", s: "Gradient" },
    { n: "Ocean",  a: "#2193b0", b: "#6dd5ed", s: "Gradient" },
    { n: "Candy",  a: "#ff6ec4", b: "#7873f5", s: "Gradient" },
    { n: "Lime",   a: "#11998e", b: "#38ef7d", s: "Gradient" },
    { n: "Neon",   a: "#00f0ff", b: "#ff00e5", s: "Neon" },
    { n: "Chrome", a: "#e6ebf2", b: "#8893a3", s: "Chrome" },
];
const ANIM_CLASS = {
    "None": "", "Pulse": "ntf-a-pulse", "Float": "ntf-a-float",
    "Shimmer": "ntf-a-shimmer", "Rainbow Shift": "ntf-a-rainbow", "Glow Pulse": "ntf-a-glow",
};

function hexA(hex, a) {
    let h = (hex || "").replace("#", "");
    if (h.length === 3) h = h.split("").map(c => c + c).join("");
    const n = parseInt(h || "0", 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function applyStyle(el, v) {
    el.style.fontSize = v.size + "px";
    el.style.fontWeight = v.bold ? "900" : "700";
    el.style.fontFamily = '"Inter","Segoe UI",system-ui,sans-serif';
    el.style.letterSpacing = "0.5px";
    el.style.lineHeight = "1.02";
    el.style.margin = "0";
    el.style.setProperty("--ga", v.a);
    el.style.setProperty("--gb", v.b);
    el.style.background = ""; el.style.webkitBackgroundClip = ""; el.style.backgroundClip = "";
    el.style.webkitTextFillColor = ""; el.style.color = ""; el.style.webkitTextStroke = "";
    el.style.textShadow = "none";

    const sw = Math.max(1, Math.round(v.size / 28));
    const g  = Math.max(6, Math.round(v.size / 5));

    switch (v.style) {
        case "Solid":    el.style.color = v.a; break;
        case "Gradient":
            el.style.background = `linear-gradient(95deg, ${v.a}, ${v.b})`;
            el.style.webkitBackgroundClip = "text"; el.style.backgroundClip = "text";
            el.style.webkitTextFillColor = "transparent"; el.style.color = "transparent";
            break;
        case "Neon":
            el.style.color = "#fff";
            el.style.textShadow = `0 0 ${g * 0.5}px #fff, 0 0 ${g}px ${v.a}, 0 0 ${g * 2}px ${v.b}`;
            break;
        case "Rainbow":
            el.style.background = "linear-gradient(90deg,#ff004c,#ff8a00,#ffe600,#00d26a,#00a3ff,#7a00ff,#ff004c)";
            el.style.backgroundSize = "200% 100%";
            el.style.webkitBackgroundClip = "text"; el.style.backgroundClip = "text";
            el.style.webkitTextFillColor = "transparent"; el.style.color = "transparent";
            break;
        case "Outline":
            el.style.color = "transparent";
            el.style.webkitTextStroke = `${sw}px ${v.a}`;
            break;
        case "Chrome":
            el.style.background = "linear-gradient(180deg,#fff 0%,#d7dee8 35%,#8893a3 50%,#eef2f7 63%,#9aa6b4 100%)";
            el.style.webkitBackgroundClip = "text"; el.style.backgroundClip = "text";
            el.style.webkitTextFillColor = "transparent"; el.style.color = "transparent";
            break;
    }
    if (v.glow) {
        const base = (el.style.textShadow && el.style.textShadow !== "none") ? el.style.textShadow + "," : "";
        el.style.textShadow = base + `0 0 ${g}px ${v.a}, 0 0 ${g * 1.8}px ${hexA(v.b, 0.8)}`;
    }
}

const STYLE_ID = "nougan-tf-styles";
function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
        /* Panel is a billboard: it does NOT grab pointer events itself, so the
           empty banner/preview area falls through to the canvas (=> the node
           stays draggable). Only the real controls opt back in. */
        .ntf-panel{font-family:'Inter','Segoe UI',system-ui,sans-serif;padding:0;overflow:hidden;
          border-radius:8px;background:linear-gradient(160deg,#11151f,#0a0d14);border:1px solid #243149;
          color:#dce6f5;font-size:12px;pointer-events:none;box-shadow:0 10px 30px rgba(0,0,0,.45)}
        .ntf-panel *{box-sizing:border-box}
        .ntf-controls,.ntf-controls *{pointer-events:auto}
        .ntf-title.ntf-linked{pointer-events:auto}

        .ntf-inner{padding:10px;display:flex;flex-direction:column;gap:9px}
        .ntf-bar{height:3px;margin:-10px -10px 0 -10px;border-radius:0;
          background:linear-gradient(90deg,#ff3d7f,#7a5cff,#3da5ff,#ff3d7f);background-size:200% 100%;
          animation:ntf-bar 3s linear infinite}
        @keyframes ntf-bar{to{background-position:200% 0}}

        .ntf-preview{position:relative;min-height:64px;border-radius:8px;display:flex;align-items:center;
          justify-content:center;text-align:center;padding:10px;overflow:hidden;
          background:#0a0e16;border:1px solid #1c2740}
        .ntf-title{display:inline-block;max-width:100%;word-break:break-word;text-decoration:none;
          transform-origin:center}
        .ntf-title.ntf-linked{cursor:pointer}
        .ntf-title.ntf-linked:hover{text-decoration:underline}
        .ntf-linkbadge{position:absolute;top:6px;right:8px;font-size:11px;opacity:.85}

        .ntf-controls{display:flex;flex-direction:column;gap:7px}
        .ntf-lbl{font-size:9.5px;text-transform:uppercase;letter-spacing:.6px;color:#7f93ad;font-weight:700}
        .ntf-text{width:100%;padding:7px 9px;border-radius:6px;border:1px solid #2c3a55;background:#0a1018;
          color:#eaf2ff;font-size:13px;outline:none}
        .ntf-text:focus{border-color:#ff5d9e;box-shadow:0 0 0 3px rgba(255,93,158,.12)}
        .ntf-row{display:flex;gap:8px;align-items:center}
        .ntf-row>.ntf-lbl{min-width:42px}
        .ntf-slider{flex:1;accent-color:#ff5d9e;cursor:pointer}
        .ntf-num{width:54px;padding:4px 6px;border-radius:5px;border:1px solid #2c3a55;background:#0a1018;
          color:#eaf2ff;font-size:12px;text-align:center}
        .ntf-swatch{width:30px;height:30px;border:none;border-radius:50%;padding:0;background:none;
          cursor:pointer;box-shadow:0 0 0 2px #2c3a55}
        .ntf-swatch::-webkit-color-swatch-wrapper{padding:0}
        .ntf-swatch::-webkit-color-swatch{border:none;border-radius:50%}
        .ntf-pill{padding:4px 12px;border-radius:12px;font-size:11px;font-weight:700;cursor:pointer;
          border:1px solid #2c3a55;background:rgba(255,255,255,.03);color:#7f93ad;user-select:none}
        .ntf-pill.on{background:rgba(255,93,158,.16);border-color:#ff5d9e;color:#ff9ec6;
          box-shadow:0 0 8px rgba(255,93,158,.18)}
        .ntf-sel{flex:1;padding:5px 7px;border-radius:6px;border:1px solid #2c3a55;background:#0a1018;
          color:#dce6f5;font-size:11.5px;outline:none;cursor:pointer}
        .ntf-chips{display:flex;gap:5px;flex-wrap:wrap}
        .ntf-chip{width:22px;height:22px;border-radius:50%;cursor:pointer;border:2px solid rgba(255,255,255,.14);
          transition:transform .12s}
        .ntf-chip:hover{transform:scale(1.18);border-color:#fff}
        .ntf-open{padding:4px 9px;border-radius:11px;font-size:11px;font-weight:700;cursor:pointer;
          border:1px solid #2c3a55;background:rgba(90,180,255,.1);color:#8fd0ff;white-space:nowrap}
        .ntf-open:hover{border-color:#5ab4ff;background:rgba(90,180,255,.2)}
        .ntf-open[disabled]{opacity:.35;cursor:not-allowed}

        .ntf-a-pulse{animation:ntf-pulse 1.6s ease-in-out infinite}
        .ntf-a-float{animation:ntf-float 2.4s ease-in-out infinite}
        .ntf-a-shimmer{animation:ntf-shimmer 1.8s ease-in-out infinite}
        .ntf-a-rainbow{animation:ntf-rainbow 4s linear infinite}
        .ntf-a-glow{animation:ntf-glow 1.8s ease-in-out infinite}
        @keyframes ntf-pulse{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(1.04);opacity:.82}}
        @keyframes ntf-float{0%,100%{transform:translateY(0)}50%{transform:translateY(-7px)}}
        @keyframes ntf-shimmer{0%,100%{filter:brightness(1) contrast(1)}50%{filter:brightness(1.5) contrast(1.15)}}
        @keyframes ntf-rainbow{to{filter:hue-rotate(360deg)}}
        @keyframes ntf-glow{0%,100%{filter:drop-shadow(0 0 3px var(--ga,#fff))}50%{filter:drop-shadow(0 0 16px var(--gb,#fff))}}
    `;
    document.head.appendChild(s);
}

app.registerExtension({
    name: "Nougan.TitleFont",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;
        injectStyles();

        // Keep the canvas rectangle width glued to the billboard card width,
        // even if LiteGraph's own onResize tries to expand it to the panel's
        // unscaled (design) width.
        const onResize = nodeType.prototype.onResize;
        nodeType.prototype.onResize = function (size) {
            onResize?.apply(this, arguments);
            this.size[0] = Math.round(DESIGN_W * curInv()) + 4;
        };

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            onNodeCreated?.apply(this, arguments);
            const node = this;

            this.color = "#1a1320";
            this.bgcolor = "#0a0d14";

            const wText   = this.widgets?.find(w => w.name === "text");
            const wSize   = this.widgets?.find(w => w.name === "font_size");
            const wBold   = this.widgets?.find(w => w.name === "bold");
            const wGlow   = this.widgets?.find(w => w.name === "glow");
            const wStyle  = this.widgets?.find(w => w.name === "style");
            const wColorA = this.widgets?.find(w => w.name === "color_a");
            const wColorB = this.widgets?.find(w => w.name === "color_b");
            const wAnim   = this.widgets?.find(w => w.name === "animate");
            const wUrl    = this.widgets?.find(w => w.name === "url");

            [wText, wSize, wBold, wGlow, wStyle, wColorA, wColorB, wAnim, wUrl].forEach(hideWidget);

            const panel = document.createElement("div");
            panel.className = "ntf-panel";
            // Fixed design width + counter-scale origin → the billboard math.
            panel.style.width = DESIGN_W + "px";
            panel.style.transformOrigin = "top left";
            panel.innerHTML = `
                <div class="ntf-inner">
                    <div class="ntf-bar"></div>
                    <div class="ntf-preview" data-n="preview">
                        <span class="ntf-linkbadge" data-n="badge" style="display:none">🔗</span>
                        <a class="ntf-title" data-n="title">Your Title</a>
                    </div>
                    <div class="ntf-controls">
                        <div>
                            <div class="ntf-lbl">Title text</div>
                            <input class="ntf-text" data-n="ta" type="text" placeholder="Type your title…" spellcheck="false">
                        </div>
                        <div class="ntf-row">
                            <span class="ntf-lbl">Size</span>
                            <input class="ntf-slider" data-n="slider" type="range" min="8" max="240" step="1">
                            <input class="ntf-num" data-n="num" type="number" min="8" max="240">
                        </div>
                        <div class="ntf-row">
                            <span class="ntf-lbl">Colors</span>
                            <input class="ntf-swatch" data-n="swA" type="color">
                            <input class="ntf-swatch" data-n="swB" type="color">
                            <span class="ntf-lbl" style="min-width:auto;color:#6f8099">A → B</span>
                        </div>
                        <div class="ntf-chips" data-n="chips"></div>
                        <div class="ntf-row">
                            <span class="ntf-pill on" data-n="pillBold"><b>B</b> Bold</span>
                            <span class="ntf-pill on" data-n="pillGlow">✦ Glow</span>
                        </div>
                        <div class="ntf-row">
                            <select class="ntf-sel" data-n="selStyle">
                                <option>Solid</option><option>Gradient</option><option>Neon</option>
                                <option>Rainbow</option><option>Outline</option><option>Chrome</option>
                            </select>
                            <select class="ntf-sel" data-n="selAnim">
                                <option>None</option><option>Pulse</option><option>Float</option>
                                <option>Shimmer</option><option>Rainbow Shift</option><option>Glow Pulse</option>
                            </select>
                        </div>
                        <div>
                            <div class="ntf-lbl">Web link (optional — makes the title clickable)</div>
                            <div class="ntf-row">
                                <input class="ntf-text" data-n="url" type="url" placeholder="https://…" spellcheck="false" style="flex:1;width:auto">
                                <span class="ntf-open" data-n="open" disabled>↗ open</span>
                            </div>
                        </div>
                    </div>
                </div>`;

            let storedH = 380;
            this.addDOMWidget("ntf_ui", "ntf_ui", panel, {
                getHeight: () => storedH,
                setValue: () => {}, getValue: () => ({}),
            });

            const $ = s => panel.querySelector(`[data-n="${s}"]`);
            const preview = $("preview"), titleEl = $("title"), badge = $("badge");
            const ta = $("ta"), slider = $("slider"), numIn = $("num");
            const swA = $("swA"), swB = $("swB"), chips = $("chips");
            const pillBold = $("pillBold"), pillGlow = $("pillGlow");
            const selStyle = $("selStyle"), selAnim = $("selAnim");
            const urlIn = $("url"), openBtn = $("open");

            PRESETS.forEach(p => {
                const c = document.createElement("span");
                c.className = "ntf-chip"; c.title = p.n;
                c.style.background = `linear-gradient(135deg, ${p.a}, ${p.b})`;
                c.addEventListener("click", () => { wColorA.value = p.a; wColorB.value = p.b; wStyle.value = p.s; render(); });
                chips.appendChild(c);
            });

            const vals = () => ({
                text: wText ? (wText.value || "") : "",
                size: wSize ? (parseInt(wSize.value) || 56) : 56,
                bold: wBold ? !!wBold.value : true,
                glow: wGlow ? !!wGlow.value : true,
                style: wStyle ? wStyle.value : "Gradient",
                a: wColorA ? (wColorA.value || "#ff3d7f") : "#ff3d7f",
                b: wColorB ? (wColorB.value || "#3da5ff") : "#3da5ff",
                animate: wAnim ? wAnim.value : "None",
                url: wUrl ? (wUrl.value || "") : "",
            });

            let lastAnim = "None";

            // Counter-scale the card and resize the canvas rectangle to match,
            // so the card is a constant on-screen size at every zoom level.
            function applyBillboard() {
                const inv = curInv();
                panel.style.transform = `scale(${inv})`;
                const natH = panel.offsetHeight || 380;     // design height (transform ignored)
                storedH = Math.round(natH * inv) + 4;       // widget height in graph units
                node.size[0] = Math.round(DESIGN_W * inv) + 4;
                if (node._ntf) node._ntf.lastScale = curScale();
            }

            function render() {
                const v = vals();
                if (ta.value !== v.text) ta.value = v.text;
                if (urlIn.value !== v.url) urlIn.value = v.url;
                slider.value = v.size; numIn.value = v.size;
                swA.value = v.a; swB.value = v.b;
                pillBold.classList.toggle("on", v.bold);
                pillGlow.classList.toggle("on", v.glow);
                selStyle.value = v.style; selAnim.value = v.animate;

                titleEl.textContent = v.text || "Your Title";
                titleEl.style.opacity = v.text ? "1" : ".4";
                applyStyle(titleEl, v);

                titleEl.classList.toggle("ntf-linked", !!v.url);
                if (v.url) {
                    titleEl.setAttribute("href", v.url);
                    titleEl.setAttribute("target", "_blank");
                    titleEl.setAttribute("rel", "noopener");
                } else {
                    titleEl.removeAttribute("href");
                    titleEl.removeAttribute("target");
                    titleEl.removeAttribute("rel");
                }
                if (v.animate !== lastAnim) {
                    if (ANIM_CLASS[lastAnim]) titleEl.classList.remove(ANIM_CLASS[lastAnim]);
                    if (ANIM_CLASS[v.animate]) titleEl.classList.add(ANIM_CLASS[v.animate]);
                    lastAnim = v.animate;
                }
                badge.style.display = v.url ? "" : "none";
                openBtn.disabled = !v.url;

                preview.style.background =
                    `radial-gradient(120% 130% at 50% 0%, ${hexA(v.a, 0.14)}, transparent 70%), #0a0e16`;

                applyBillboard();
                recompute(node);
                requestAnimationFrame(() => { applyBillboard(); recompute(node); });
            }

            ta.addEventListener("input", () => { wText.value = ta.value; render(); });
            slider.addEventListener("input", () => { wSize.value = +slider.value; render(); });
            numIn.addEventListener("input", () => { wSize.value = Math.max(8, Math.min(240, +numIn.value || 8)); render(); });
            swA.addEventListener("input", () => { wColorA.value = swA.value; render(); });
            swB.addEventListener("input", () => { wColorB.value = swB.value; render(); });
            pillBold.addEventListener("click", () => { wBold.value = !wBold.value; render(); });
            pillGlow.addEventListener("click", () => { wGlow.value = !wGlow.value; render(); });
            selStyle.addEventListener("change", () => { wStyle.value = selStyle.value; render(); });
            selAnim.addEventListener("change", () => { wAnim.value = selAnim.value; render(); });
            urlIn.addEventListener("input", () => { wUrl.value = urlIn.value; render(); });
            openBtn.addEventListener("click", () => { const u = (wUrl.value || "").trim(); if (u) window.open(u, "_blank", "noopener"); });

            // Exposed for the zoom + configure hooks below.
            this._ntf = { refreshDOM: render, lastScale: null };

            render();
        };

        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info) {
            onConfigure?.apply(this, arguments);
            this._ntf?.refreshDOM();
        };

        // Re-billboard whenever the zoom changes (detected on canvas draw).
        const onDrawForeground = nodeType.prototype.onDrawForeground;
        nodeType.prototype.onDrawForeground = function (ctx) {
            onDrawForeground?.apply(this, arguments);
            if (this._ntf && curScale() !== this._ntf.lastScale) this._ntf.refreshDOM();
        };
    },
});