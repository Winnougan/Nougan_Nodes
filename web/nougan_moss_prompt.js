// NouganMossPrompt — live preview of the assembled final prompt.
// Assembly mirrors assemble_prompt() in nougan_moss_prompt.py:
// [triggers_pre, text, triggers_post] non-empty parts joined with ", ".
//
// triggers_pre/post are socket-only inputs (no widget), so their text is read from the
// NouganMossLoras node they are linked to. Any other source shows as a placeholder.
import { app } from "../../../scripts/app.js";

const CSS = `
.ngmp-preview{font:11px/1.5 "Inter","Segoe UI",sans-serif;color:#9aa3b2;
  padding:6px 10px;border:1px solid #3a3a46;border-radius:6px;
  background:rgba(255,255,255,.02);max-height:96px;overflow:auto;white-space:pre-wrap;}
.ngmp-preview b{color:#e8e8ee;font-weight:600;}
.ngmp-final{color:#c9ced8;}
.ngmp-final:empty::before{content:"(empty prompt)";color:#5a6270;font-style:italic;}
`;

let cssDone = false;
function injectCss() {
    if (cssDone) return;
    cssDone = true;
    const s = document.createElement("style");
    s.textContent = CSS;
    document.head.appendChild(s);
}

const wval = (node, n) => node.widgets?.find(w => w.name === n)?.value;

// Mirrors parse_trigger_slots() in nougan_moss_loras.py: enabled slots with trigger text, split by pos.
function triggersFromLoras(loraNode) {
    const pre = [], post = [];
    try {
        const p = JSON.parse(wval(loraNode, "lora_data") || "{}");
        for (const e of (Array.isArray(p) ? p : (p.loras || []))) {
            const t = String(e?.trigger ?? "").trim();
            if (!e || e.on === false || !t) continue;
            (String(e.pos ?? "pre").toLowerCase() === "post" ? post : pre).push(t);
        }
    } catch { /* malformed data: Python side reports it */ }
    return { pre: pre.join(", "), post: post.join(", ") };
}

function triggerText(node, name) {
    const slot = node.inputs?.findIndex(i => i.name === name) ?? -1;
    if (slot < 0 || node.inputs[slot].link == null) return "";
    const origin = node.getInputNode?.(slot);
    if (origin?.comfyClass === "NouganMossLoras" || origin?.type === "NouganMossLoras") {
        const t = triggersFromLoras(origin);
        return name === "triggers_pre" ? t.pre : t.post;
    }
    return `‹${name}›`;   // linked to something else; its value is only known at run time
}

function assemble(node) {
    const parts = [triggerText(node, "triggers_pre"), wval(node, "text"), triggerText(node, "triggers_post")]
        .map(p => (p ?? "").toString().trim())
        .filter(Boolean);
    return parts.join(", ");
}

app.registerExtension({
    name: "nougan.moss.prompt",
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "NouganMossPrompt") return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            onNodeCreated?.apply(this, arguments);
            const node = this;
            injectCss();

            const el = document.createElement("div");
            el.className = "ngmp-preview";
            const label = document.createElement("b");
            label.textContent = "Final: ";
            const body = document.createElement("span");
            body.className = "ngmp-final";
            el.append(label, body);

            const update = () => {
                const s = assemble(node);
                if (body.textContent !== s) body.textContent = s;
            };

            for (const w of node.widgets || []) {
                if (w.name !== "text") continue;
                const cb = w.callback;
                w.callback = function () { update(); return cb?.apply(this, arguments); };
                w.element?.addEventListener?.("input", update);
            }
            const onConfigure = node.onConfigure;
            node.onConfigure = function () { const r = onConfigure?.apply(this, arguments); update(); return r; };
            // Linked LoRA slots change without touching this node; every canvas redraw is cheap enough to re-check.
            const onDraw = node.onDrawForeground;
            node.onDrawForeground = function () { update(); return onDraw?.apply(this, arguments); };

            const dw = node.addDOMWidget("ngmp_preview", "ngmp-preview", el, { hideOnZoom: false, serialize: false });
            dw.serializeValue = () => undefined; // preview is cosmetic; nothing to save
            update();
        };
    },
});
