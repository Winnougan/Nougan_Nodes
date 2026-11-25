// NouganMossCanvas — live readout of the effective (snapped) canvas size.
// Mirrors compute_size() in nougan_moss_canvas.py — keep the math in sync.
import { app } from "../../../scripts/app.js";

const CSS = `
.ngmc-readout{font:12px/1.5 "Inter","Segoe UI",sans-serif;color:#9aa3b2;
  padding:6px 10px;border:1px solid #3a3a46;border-radius:6px;
  background:rgba(255,255,255,.02);display:flex;justify-content:space-between;align-items:center;}
.ngmc-size{color:#e8e8ee;font-weight:600;font-variant-numeric:tabular-nums;}
`;

let cssDone = false;
function injectCss() {
    if (cssDone) return;
    cssDone = true;
    const s = document.createElement("style");
    s.textContent = CSS;
    document.head.appendChild(s);
}

// Keep in sync with snap_to_grid()/compute_size() on the Python side
// (nearest multiple of 16, ties up, clamped to 64..8192).
const snapToGrid = (v) => Math.max(64, Math.min(8192, Math.floor(v / 16 + 0.5) * 16));

function effectiveSize(node) {
    const val = (n) => node.widgets?.find(w => w.name === n)?.value;
    const mode = val("mode");
    if (mode === "Aspect Ratio") {
        const m = /^\s*(\d+)\s*:\s*(\d+)/.exec(val("aspect") || "");
        if (!m) return null;
        const a = +m[1], b = +m[2], total = (val("scale_mp") ?? 1.5) * 1e6;
        return [snapToGrid(Math.sqrt(total * a / b)), snapToGrid(Math.sqrt(total * b / a))];
    }
    return [snapToGrid(val("width") ?? 1008), snapToGrid(val("height") ?? 1504)];
}

app.registerExtension({
    name: "nougan.moss.canvas",
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "NouganMossCanvas") return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            onNodeCreated?.apply(this, arguments);
            const node = this;
            injectCss();

            const el = document.createElement("div");
            el.className = "ngmc-readout";
            const label = document.createElement("span");
            label.textContent = "Effective size";
            const size = document.createElement("span");
            size.className = "ngmc-size";
            el.append(label, size);

            const update = () => {
                const s = effectiveSize(node);
                size.textContent = s ? `${s[0]}×${s[1]}` : "—";
            };

            // Recompute whenever any size-related widget changes (covers typing,
            // combo picks and drag-changes); saved workflows restore values
            // without callbacks, so also update once after configure.
            for (const w of node.widgets || []) {
                if (!["mode", "aspect", "scale_mp", "width", "height"].includes(w.name)) continue;
                const cb = w.callback;
                w.callback = function () { update(); return cb?.apply(this, arguments); };
            }
            const onConfigure = node.onConfigure;
            node.onConfigure = function () { const r = onConfigure?.apply(this, arguments); update(); return r; };

            const dw = node.addDOMWidget("ngmc_readout", "ngmc-readout", el, { hideOnZoom: false, serialize: false });
            dw.serializeValue = () => undefined; // readout is cosmetic; nothing to save
            update();
        };
    },
});
