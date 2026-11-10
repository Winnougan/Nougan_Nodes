// web/nougan_h3_duration.js — Nougan suite by Winnougan
// The expression box is collapsed until "edit_expression" is switched on.

import { app } from "../../../scripts/app.js";

function applyVisibility(node) {
    const expr = node.widgets?.find((w) => w.name === "expression");
    const toggle = node.widgets?.find((w) => w.name === "edit_expression");
    if (!expr || !toggle) return;

    const show = !!toggle.value;
    if (!("_origCompute" in expr)) expr._origCompute = expr.computeSize;

    expr.hidden = !show;                                        // current frontend
    expr.computeSize = show ? expr._origCompute : () => [0, -4]; // legacy: take no space
    const el = expr.element ?? expr.inputEl;                    // the textarea
    if (el) el.style.display = show ? "" : "none";

    node.setSize([node.size[0], node.computeSize()[1]]);
    node.setDirtyCanvas(true, true);
}

app.registerExtension({
    name: "nougan.h3Duration",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "NouganH3Duration") return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onNodeCreated?.apply(this, arguments);
            const toggle = this.widgets?.find((w) => w.name === "edit_expression");
            if (toggle) {
                const prev = toggle.callback;
                toggle.callback = (...args) => {
                    prev?.apply(toggle, args);
                    applyVisibility(this);
                };
            }
            applyVisibility(this);
            return r;
        };

        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const r = onConfigure?.apply(this, arguments);
            applyVisibility(this);
            return r;
        };
    },
});
