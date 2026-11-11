// Nougan H3 Clip Doctor — DOM checklist panel. Reads the report the node returns in its
// `ui` payload (onExecuted), so it works without websockets or polling. Styling follows
// the suite's Timer / KSampler panels. No imports, no dependencies.
const { app } = window.comfyAPI.app;

const NODE_NAME = "NouganH3ClipDoctor";
const STYLE_ID = "ng-cd-stylesheet";

console.log("[Nougan.ClipDoctor] extension loaded — build 2026-11-11a");

const CSS = `.ng-cd-root{width:100%;height:100%;background:#151517;color:#b0b0b0;font:12px monospace;display:flex;flex-direction:column;overflow:hidden;user-select:none;border-radius:8px;box-sizing:border-box}
.ng-cd-box{flex:1 1 auto;margin:6px;display:flex;flex-direction:column;background:#17171a;border:1px solid #26262b;border-radius:8px;overflow:hidden;min-height:0}
.ng-cd-head{flex:0 0 26px;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:0 6px 0 10px;background:linear-gradient(#232328,#1b1b1f);border-bottom:1px solid #2a2a2e}
.ng-cd-title{color:#8a8a92;font:10px monospace;letter-spacing:.12em;text-transform:uppercase;pointer-events:none}
.ng-cd-head-right{display:flex;align-items:center;gap:8px}
.ng-cd-summary{color:#707078;font-size:10px;white-space:nowrap}
.ng-cd-btn{flex:0 0 auto;width:20px;height:18px;padding:0;background:transparent;color:#707078;border:1px solid transparent;border-radius:4px;font:11px monospace;cursor:pointer;display:flex;align-items:center;justify-content:center}
.ng-cd-btn:hover{background:#3a3a40;color:#e0e0e0;border-color:#4a4a52}
.ng-cd-body{flex:1 1 auto;min-height:0;overflow-y:auto;padding:5px 6px;display:flex;flex-direction:column;gap:2px}
.ng-cd-row{display:flex;align-items:baseline;gap:7px;padding:3px 7px;background:#101013;border:1px solid #1e1e22;border-radius:4px;line-height:1.35}
.ng-cd-icon{flex:0 0 12px;text-align:center;font-size:11px}
.ng-cd-label{flex:0 0 auto;color:#a0a0a8;font-size:10px;letter-spacing:.04em}
.ng-cd-detail{flex:1 1 auto;text-align:right;color:#808088;font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ng-cd-row.ok .ng-cd-icon{color:#66bb6a} .ng-cd-row.ok .ng-cd-detail{color:#8fa892}
.ng-cd-row.fail .ng-cd-icon{color:#ef5350} .ng-cd-row.fail{border-color:#4a2224;background:#1a1012} .ng-cd-row.fail .ng-cd-detail{color:#e08a88}
.ng-cd-row.warn .ng-cd-icon{color:#e8c91a} .ng-cd-row.warn .ng-cd-detail{color:#c0ac70}
.ng-cd-row.fixed .ng-cd-icon{color:#78c8dc} .ng-cd-row.fixed{border-color:#1e3a42;background:#101a1c} .ng-cd-row.fixed .ng-cd-detail{color:#9fd4e2}
.ng-cd-row.info .ng-cd-icon{color:#55555e}
.ng-cd-foot{flex:0 0 auto;padding:5px 10px;border-top:1px solid #2a2a2e;background:#131316;color:#707078;font-size:10px;display:flex;justify-content:space-between;gap:8px}
.ng-cd-foot b{color:#e67e22;font-weight:normal}
.ng-cd-root.ng-cd-collapsed .ng-cd-body,.ng-cd-root.ng-cd-collapsed .ng-cd-foot{display:none}
.ng-cd-root.ng-cd-collapsed .ng-cd-box{flex:0 0 26px}
.ng-cd-help{position:fixed;z-index:10000;max-width:320px;background:#1b1b1f;border:1px solid #e8c91a;border-radius:6px;color:#c8c8d0;font:11px/1.5 monospace;padding:10px 12px;box-shadow:0 4px 16px rgba(0,0,0,.6);white-space:pre-wrap}
.ng-cd-help-title{color:#e8c91a;font-weight:bold;letter-spacing:.06em;margin-bottom:5px}`;

function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = CSS;
    document.head.appendChild(s);
}

function el(tag, className, parent) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (parent) parent.appendChild(e);
    return e;
}

function chainCallback(obj, name, fn) {
    const orig = obj[name];
    obj[name] = function (...args) {
        const r = orig ? orig.apply(this, args) : undefined;
        const r2 = fn.apply(this, args);
        return r !== undefined ? r : r2;
    };
}

const ICONS = { ok: "\u2714", fail: "\u2718", warn: "\u26A0", fixed: "\u21BB", info: "\u00B7" };

function addMiddleClickPan(root) {
    root.addEventListener("pointerdown", (e) => {
        if (e.button !== 1) return;
        const ds = app.canvas?.ds;
        if (!ds) return;
        e.preventDefault(); e.stopPropagation();
        const sx = e.clientX, sy = e.clientY, ox = ds.offset[0], oy = ds.offset[1];
        const move = (ev) => {
            ds.offset[0] = ox + (ev.clientX - sx) / ds.scale;
            ds.offset[1] = oy + (ev.clientY - sy) / ds.scale;
            app.canvas.setDirty(true, true);
        };
        const up = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
    });
}

function addWheelPassthrough(root) {
    root.addEventListener("wheel", (e) => {
        // let the list scroll when it overflows, otherwise zoom the canvas
        const body = root.querySelector(".ng-cd-body");
        if (body && body.scrollHeight > body.clientHeight + 1) return;
        try { e.preventDefault(); app.canvas?.processMouseWheel?.(e); } catch {}
    }, { passive: false });
}

app.registerExtension({
    name: "Nougan.H3ClipDoctor",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData?.name !== NODE_NAME) return;

        chainCallback(nodeType.prototype, "onNodeCreated", function () {
            ensureStyles();
            const node = this;
            node.properties = node.properties || {};

            const root = el("div", "ng-cd-root");
            const box = el("div", "ng-cd-box", root);
            const head = el("div", "ng-cd-head", box);
            const title = el("span", "ng-cd-title", head);
            title.textContent = "Clip Doctor";
            const headRight = el("span", "ng-cd-head-right", head);
            const summary = el("span", "ng-cd-summary", headRight);
            const collapseBtn = el("button", "ng-cd-btn", headRight);
            collapseBtn.textContent = "\u2715";
            collapseBtn.title = "Minimize panel";
            const body = el("div", "ng-cd-body", box);
            const foot = el("div", "ng-cd-foot", box);
            const footL = el("span", "", foot);
            const footR = el("span", "", foot);

            let collapsed = !!node.properties.ngCdCollapsed;
            let expandedH = null;

            function applyCollapse(restoreSize = true) {
                root.classList.toggle("ng-cd-collapsed", collapsed);
                collapseBtn.textContent = collapsed ? "\u25A2" : "\u2715";
                collapseBtn.title = collapsed ? "Bring the panel back" : "Minimize panel";
                node.properties.ngCdCollapsed = collapsed;
                if (restoreSize) {
                    if (collapsed) {
                        expandedH = node.size?.[1] ?? null;
                        node.setSize([node.size[0], node.computeSize()[1]]);
                    } else if (expandedH != null) {
                        node.setSize([node.size[0], Math.max(expandedH, 420)]);
                        expandedH = null;
                    }
                }
                node.graph?.change?.();
            }
            collapseBtn.addEventListener("pointerdown", (ev) => ev.stopPropagation());
            collapseBtn.addEventListener("click", (ev) => {
                ev.preventDefault(); ev.stopPropagation();
                collapsed = !collapsed;
                applyCollapse(true);
            });

            const wv = (n, d) => {
                const w = node.widgets?.find((x) => x.name === n);
                const v = w ? +w.value : NaN;
                return Number.isFinite(v) ? v : d;
            };

            function pending() {
                body.replaceChildren();
                const row = el("div", "ng-cd-row info", body);
                el("span", "ng-cd-icon", row).textContent = ICONS.info;
                el("span", "ng-cd-label", row).textContent = "waiting";
                el("span", "ng-cd-detail", row).textContent = "run once to inspect the clip";
                summary.textContent = "idle";
                footL.textContent = `rules: ${wv("grid_a", 17)}n+${wv("grid_b", 5)} · ${wv("pixel_grid", 16)}px · ${wv("target_fps", 24)}fps`;
                footR.textContent = "";
            }

            function render(rep) {
                body.replaceChildren();
                let nOk = 0, nFix = 0, nWarn = 0, nFail = 0;
                for (const c of rep.checks || []) {
                    const state = c.state || "info";
                    if (state === "ok") nOk++;
                    else if (state === "fixed") nFix++;
                    else if (state === "warn") nWarn++;
                    else if (state === "fail") nFail++;
                    const row = el("div", `ng-cd-row ${state}`, body);
                    el("span", "ng-cd-icon", row).textContent = ICONS[state] || ICONS.info;
                    el("span", "ng-cd-label", row).textContent = c.label || c.id || "";
                    const d = el("span", "ng-cd-detail", row);
                    d.textContent = c.detail || "";
                    d.title = c.detail || "";
                }
                for (const w of rep.warnings || []) {
                    const row = el("div", "ng-cd-row warn", body);
                    el("span", "ng-cd-icon", row).textContent = ICONS.warn;
                    el("span", "ng-cd-label", row).textContent = "note";
                    const d = el("span", "ng-cd-detail", row);
                    d.textContent = w; d.title = w;
                    nWarn++;
                }
                const bits = [];
                if (nFail) bits.push(`${nFail} fail`);
                if (nFix) bits.push(`${nFix} fixed`);
                if (nWarn) bits.push(`${nWarn} warn`);
                bits.push(`${nOk} ok`);
                summary.textContent = bits.join(" · ");
                summary.style.color = nFail ? "#ef5350" : nFix ? "#78c8dc" : nWarn ? "#e8c91a" : "#66bb6a";

                const b = rep.before || {}, a = rep.after || {};
                if (rep.changed) {
                    footL.innerHTML = "";
                    footL.append(`${b.width}×${b.height} · ${b.frames}f  →  `);
                    const strong = document.createElement("b");
                    strong.textContent = `${a.width}×${a.height} · ${a.frames}f`;
                    footL.append(strong);
                } else {
                    footL.textContent = `${a.width}×${a.height} · ${a.frames}f · ${a.audio ? "AV" : "video only"}`;
                }
                footR.textContent = rep.ok ? (rep.changed ? "fixed" : "clean") : "off-grid";
                footR.style.color = rep.ok ? "#66bb6a" : "#ef5350";
                node.graph?.setDirtyCanvas?.(true, true);
            }

            pending();
            addMiddleClickPan(root);
            addWheelPassthrough(root);
            node.addDOMWidget("clip_doctor", "ng_cd_panel", root, {
                serialize: false,
                getMinHeight: () => (collapsed ? 40 : 210),
            });
            node.setSize([Math.max(node.size?.[0] ?? 420, 420), Math.max(node.size?.[1] ?? 620, 620)]);
            if (collapsed) applyCollapse(false);

            chainCallback(node, "onExecuted", function (msg) {
                const rep = msg?.nougan_clip_doctor?.[0];
                if (rep) render(rep);
            });
            chainCallback(node, "onConfigure", function () {
                if (node.properties?.ngCdCollapsed) { collapsed = true; applyCollapse(false); }
            });
            chainCallback(node, "onWidgetChanged", function () { pending(); });
        });

        // ---- yellow ? badge (suite convention) ----
        const HELP_TEXT = (nodeData?.description || "Nougan H3 Clip Doctor")
            + "\n\nWire it anywhere between the latent source and the sampler. IMAGE / AUDIO are optional: when IMAGE is connected its frame count is authoritative and it gets the same crop/trim, and AUDIO is resynced to the new duration."
            + "\n\nVAE is only read for the exact spatial compression — nothing is decoded."
            + "\n\nstrict ON turns the node into a gate: it raises a readable error instead of letting H3 fail later. The audio half is reported / stripped, never fabricated.";
        const BADGE_R = 8;
        const badgeCenter = (n) => [(n.size?.[0] ?? 200) - BADGE_R - 7, -14];
        let helpEl = null;
        const hideHelp = () => { helpEl?.remove(); helpEl = null; };
        document.addEventListener("pointerdown", (ev) => {
            if (helpEl && !helpEl.contains(ev.target)) hideHelp();
        }, true);

        chainCallback(nodeType.prototype, "onDrawForeground", function (ctx) {
            const [bx, by] = badgeCenter(this);
            ctx.save();
            ctx.beginPath();
            ctx.arc(bx, by, BADGE_R, 0, Math.PI * 2);
            ctx.fillStyle = "#e8c91a";
            ctx.fill();
            ctx.fillStyle = "#1a1a1a";
            ctx.font = "bold 11px monospace";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText("?", bx, by + 0.5);
            ctx.restore();
        });

        chainCallback(nodeType.prototype, "onMouseDown", function (e, pos) {
            const [bx, by] = badgeCenter(this);
            if (Math.abs(pos[0] - bx) <= BADGE_R + 2 && Math.abs(pos[1] - by) <= BADGE_R + 2) {
                if (helpEl) { hideHelp(); return true; }
                hideHelp();
                helpEl = document.createElement("div");
                helpEl.className = "ng-cd-help";
                const t = document.createElement("div");
                t.className = "ng-cd-help-title";
                t.textContent = "Nougan H3 Clip Doctor";
                const b = document.createElement("div");
                b.textContent = HELP_TEXT;
                helpEl.append(t, b);
                document.body.appendChild(helpEl);
                helpEl.style.left = Math.max(8, Math.min(e.clientX ?? 40, window.innerWidth - 340)) + "px";
                helpEl.style.top = Math.max(8, Math.min(e.clientY ?? 40, window.innerHeight - 240)) + "px";
                return true;
            }
        });
    },
});