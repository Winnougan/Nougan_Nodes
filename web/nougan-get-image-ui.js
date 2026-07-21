// web/nougan-get-image-ui.js
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

console.log("[Nougan] ✅ Get Image UI loaded");

const NODE_NAME    = "NouganGetImage";
const NODE_COLOR   = "#1a237e";
const NODE_BGCOLOR = "#0d1442";

app.registerExtension({
  name: "Nougan.GetImage.UI",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== NODE_NAME) return;

    nodeType.color   = NODE_COLOR;
    nodeType.bgcolor = NODE_BGCOLOR;

    const origONC = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      origONC?.apply(this, arguments);

      // ── BUILD GUARD: only construct the UI once per node instance ──
      if (this._ngGiBuilt) return;
      this._ngGiBuilt = true;

      if (!document.getElementById("ng-gi-styles")) {
        const s = document.createElement("style");
        s.id = "ng-gi-styles";
        s.textContent = `
          .ng-gi-panel{display:flex;gap:10px;padding:6px 2px;
            font:11px Arial,sans-serif;color:var(--fg-color,#ddd);
            width:100%;box-sizing:border-box;}
          .ng-gi-box{flex:1;display:flex;flex-direction:column;
            align-items:center;gap:4px;}
          .ng-gi-lbl{font-size:10px;text-transform:uppercase;
            letter-spacing:.6px;opacity:.55;}
          .ng-gi-thumb{width:100%;aspect-ratio:1;border-radius:5px;
            border:1px solid rgba(255,255,255,.14);
            background:#111 center/contain no-repeat;}
          .ng-gi-empty{display:flex;align-items:center;justify-content:center;
            width:100%;aspect-ratio:1;border-radius:5px;
            border:1px dashed rgba(255,255,255,.18);
            color:rgba(255,255,255,.25);font-size:11px;}
        `;
        document.head.appendChild(s);
      }

      const panel = document.createElement("div");
      panel.className = "ng-gi-panel";

      const mkBox = (label) => {
        const box = document.createElement("div");
        box.className = "ng-gi-box";
        const lbl = document.createElement("span");
        lbl.className = "ng-gi-lbl";
        lbl.textContent = label;
        const el = document.createElement("div");
        el.className = "ng-gi-empty";
        el.textContent = `no ${label.toLowerCase()}`;
        box.appendChild(lbl);
        box.appendChild(el);
        panel.appendChild(box);
        return el;
      };

      const imgEl  = mkBox("Image");
      const maskEl = mkBox("Mask");

      const dw = this.addDOMWidget("ng_gi_preview", "div", panel, { serialize: false });
      dw.serializeValue = () => undefined;
      dw.computeSize = w => [w, 170];

      const url = r =>
        api.apiURL(
          `/view?filename=${encodeURIComponent(r.filename)}` +
          `&subfolder=${encodeURIComponent(r.subfolder || "")}` +
          `&type=${encodeURIComponent(r.type || "temp")}` +
          `&t=${Date.now()}`
        );

      const show = (el, u) => {
        el.textContent = "";
        el.className = "ng-gi-thumb";
        el.style.backgroundImage = `url("${u}")`;
      };

      const origExec = this.onExecuted;
      this.onExecuted = function (output) {
        origExec?.apply(this, arguments);
        // Read OUR custom key — the generic ComfyUI preview only looks for
        // "images", so it never sees this and never draws a duplicate.
        const previews = output?.nougan_previews;
        if (!previews) return;
        for (const r of previews) {
          const u = url(r);
          if (r.kind === "image") show(imgEl, u);
          if (r.kind === "mask")  show(maskEl, u);
        }
      };
    };
  },
});