// web/nougan-diffusers-ui.js
import { app } from "../../scripts/app.js";

console.log("[Nougan] ✅ Diffusers Loader UI loaded");

const NODE_NAME    = "NouganDiffusersLoader";
const NODE_COLOR   = "#006064";
const NODE_BGCOLOR = "#004d40";
const DATA_WIDGET  = "model_data";

function hideWidget(node, w) {
  if (!w) return;
  w.type = "hidden"; w.hidden = true;
  if (w.element) w.element.style.display = "none";
  w.computeSize = () => [0, -4];
}

app.registerExtension({
  name: "Nougan.Diffusers.UI",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== NODE_NAME) return;

    nodeType.color   = NODE_COLOR;
    nodeType.bgcolor = NODE_BGCOLOR;

    const origONC = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      origONC?.apply(this, arguments);

      // ── BUILD GUARD: only build the UI once per node instance ──
      if (this._ngDlBuilt) return;
      this._ngDlBuilt = true;
      // ────────────────────────────────────────────────────────────

      hideWidget(this, this.widgets?.find(w => w.name === DATA_WIDGET));

      if (!document.getElementById("ng-dl-styles")) {
        const s = document.createElement("style");
        s.id = "ng-dl-styles";
        s.textContent = `
          .ng-panel{display:flex;flex-direction:column;gap:6px;
            font:12px Arial,sans-serif;color:var(--fg-color,#ddd);
            width:100%;box-sizing:border-box;padding:4px 0;}
          .ng-row{display:flex;align-items:center;gap:8px;
            background:rgba(255,255,255,.06);border-radius:4px;
            padding:6px 8px;border:1px solid rgba(255,255,255,.08);}
          .ng-icon{font-size:16px;width:24px;text-align:center;flex:none;}
          .ng-label{opacity:.7;flex:1;font-size:11px;
            text-transform:uppercase;letter-spacing:.5px;}
          .ng-value{font-weight:600;font-size:13px;}
          .ng-btn{cursor:pointer;padding:6px 12px;border-radius:4px;
            border:1px solid var(--border-color,#555);
            background:linear-gradient(180deg,#2a2a2a,#1a1a1a);
            color:#4dd0e1;font:12px Arial,sans-serif;font-weight:600;
            text-align:center;transition:all .15s;width:100%;}
          .ng-btn:hover{filter:brightness(1.3);border-color:#4dd0e1;}
        `;
        document.head.appendChild(s);
      }

      const panel = document.createElement("div");
      panel.className = "ng-panel";

      const btn = document.createElement("button");
      btn.className = "ng-btn";
      btn.textContent = "🔄 Refresh Model List";
      btn.addEventListener("click", () => {
        btn.textContent = "⏳ Refreshing…";
        app.refreshComboInNodes?.();
        setTimeout(() => (btn.textContent = "🔄 Refresh Model List"), 600);
      });
      panel.appendChild(btn);

      const update = () => {
        panel.querySelectorAll(".ng-row").forEach(r => r.remove());

        const sage  = this.widgets?.find(w => w.name === "sageattention_version")?.value || "None";
        const flash = this.widgets?.find(w => w.name === "flashattention_version")?.value || "None";

        let txt = "Standard (PyTorch)", icon = "⚙️", col = "#aaa";
        if (sage !== "None" && flash !== "None") {
          txt = `${sage} + ${flash}`; icon = "🚀"; col = "#ff4081";
        } else if (sage !== "None") {
          txt = sage; icon = "🧠"; col = "#69f0ae";
        } else if (flash !== "None") {
          txt = flash; icon = "⚡"; col = "#40c4ff";
        }

        const row = document.createElement("div");
        row.className = "ng-row";
        row.innerHTML =
          `<span class="ng-icon">${icon}</span>` +
          `<span class="ng-label">Attention</span>` +
          `<span class="ng-value" style="color:${col}">${txt}</span>`;
        panel.appendChild(row);
      };

      update();

      const dw = this.addDOMWidget("ng_dl_panel", "div", panel, { serialize: false });
      dw.serializeValue = () => undefined;
      dw.computeSize = w => [w, 80];

      const hook = w => {
        if (!w) return;
        const cb = w.callback;
        w.callback = function (v, ...a) {
          cb?.call(this, v, ...a);
          update();
          this.node.setDirtyCanvas(true, true);
        };
      };
      hook(this.widgets?.find(w => w.name === "sageattention_version"));
      hook(this.widgets?.find(w => w.name === "flashattention_version"));

      this._ngUpdate = update;
    };

    const origConf = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (info) {
      origConf?.apply(this, arguments);
      if (this._ngUpdate) setTimeout(() => this._ngUpdate(), 50);
    };
  },
});