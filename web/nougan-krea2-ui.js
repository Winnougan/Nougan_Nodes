// web/nougan-krea2-ui.js
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

console.log("[Nougan Krea2] ✅ UI loaded");

const NODE_NAME    = "NouganKrea2Loader";
const NODE_COLOR   = "#7b1fa2";   // Krea-ish purple
const NODE_BGCOLOR = "#4a148c";

function hideWidget(w) {
  if (!w) return;
  w.type = "hidden"; w.hidden = true;
  if (w.element) w.element.style.display = "none";
  w.computeSize = () => [0, -4];
}

let _statusPromise = null;
function fetchStatus() {
  if (_statusPromise) return _statusPromise;
  _statusPromise = api.fetchApi("/nougan/krea2_loras")
    .then(r => r.json()).then(j => j.loras || []).catch(() => []);
  return _statusPromise;
}
let _lastMeta = [];

app.registerExtension({
  name: "Nougan.Krea2.UI",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== NODE_NAME) return;

    nodeType.color   = NODE_COLOR;
    nodeType.bgcolor = NODE_BGCOLOR;

    const origONC = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      origONC?.apply(this, arguments);

      // ── BUILD GUARD ──
      if (this._ngK2Built) return;
      this._ngK2Built = true;

      // Hide the native enable_/strength_ widgets (they still serialize).
      this.widgets?.forEach(w => {
        if (/^(enable|strength)_\d+$/.test(w.name)) hideWidget(w);
      });

      // How many baked loras does the backend expose? (probe enable_1,2,…)
      let count = 0;
      while (this.widgets?.some(w => w.name === `enable_${count + 1}`)) count++;
      this._ngK2Count = count;

      // ── styles (once) ──
      if (!document.getElementById("ng-k2-styles")) {
        const s = document.createElement("style");
        s.id = "ng-k2-styles";
        s.textContent = `
          .ng-k2-panel{display:flex;flex-direction:column;gap:6px;
            font:12px Arial,sans-serif;color:var(--fg-color,#ddd);
            width:100%;box-sizing:border-box;padding:2px 0;}
          .ng-k2-head{display:flex;align-items:center;gap:6px;font-size:11px;
            text-transform:uppercase;letter-spacing:.6px;opacity:.7;padding:0 2px;}
          .ng-k2-rows{display:flex;flex-direction:column;gap:5px;}
          .ng-k2-row{display:flex;align-items:center;gap:7px;
            background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);
            border-radius:5px;padding:5px 7px;}
          .ng-k2-pill{flex:none;cursor:pointer;user-select:none;font-size:10px;
            font-weight:700;letter-spacing:.5px;padding:3px 9px;border-radius:10px;
            border:1px solid transparent;transition:all .12s;}
          .ng-k2-pill.on{background:rgba(224,64,251,.22);
            border-color:rgba(224,64,251,.6);color:#f3a4ff;}
          .ng-k2-pill.off{background:rgba(255,255,255,.06);
            border-color:rgba(255,255,255,.14);color:rgba(255,255,255,.4);}
          .ng-k2-dot{flex:none;width:9px;height:9px;border-radius:50%;}
          .ng-k2-dot.present{background:#69f0ae;box-shadow:0 0 6px rgba(105,240,174,.6);}
          .ng-k2-dot.missing{background:#ff5252;box-shadow:0 0 6px rgba(255,82,82,.5);}
          .ng-k2-dot.unknown{background:#888;}
          .ng-k2-name{flex:1;overflow:hidden;text-overflow:ellipsis;
            white-space:nowrap;font-weight:600;font-size:12px;}
          .ng-k2-str{width:62px;flex:none;background:var(--comfy-input-bg,#2a2a2a);
            color:inherit;border:1px solid var(--border-color,#555);border-radius:4px;
            font:inherit;text-align:center;padding:2px 4px;}
          .ng-k2-str:disabled{opacity:.35;}
          .ng-k2-foot{font-size:10px;opacity:.45;padding:2px 2px 0;}
        `;
        document.head.appendChild(s);
      }

      const setDirty = () => this.setDirtyCanvas(true, true);
      const wEnable  = i => this.widgets?.find(w => w.name === `enable_${i}`);
      const wStrength= i => this.widgets?.find(w => w.name === `strength_${i}`);

      const pills = [], dots = [], names = [], inputs = [];

      // ── build panel ──
      const panel = document.createElement("div");
      panel.className = "ng-k2-panel";

      const head = document.createElement("div");
      head.className = "ng-k2-head";
      head.textContent = "🌀 Krea 2 · uncensored loras";
      panel.appendChild(head);

      const rows = document.createElement("div");
      rows.className = "ng-k2-rows";
      panel.appendChild(rows);

      for (let i = 1; i <= count; i++) {
        const row = document.createElement("div");
        row.className = "ng-k2-row";

        const pill = document.createElement("span");
        pill.className = "ng-k2-pill off";
        pill.textContent = "OFF";
        pill.addEventListener("click", () => {
          const w = wEnable(i); if (!w) return;
          w.value = !w.value;
          try { w.callback?.(w.value); } catch (_) {}
          syncRow(i); setDirty();
        });
        row.appendChild(pill); pills[i] = pill;

        const dot = document.createElement("span");
        dot.className = "ng-k2-dot unknown";
        row.appendChild(dot); dots[i] = dot;

        const name = document.createElement("span");
        name.className = "ng-k2-name";
        name.textContent = `LoRA ${i}`;          // replaced once meta loads
        row.appendChild(name); names[i] = name;

        const inp = document.createElement("input");
        inp.className = "ng-k2-str";
        inp.type = "number"; inp.step = "0.05"; inp.min = "0";   // NO max
        inp.title = "Strength (no upper limit)";
        inp.addEventListener("pointerdown", e => e.stopPropagation());
        inp.addEventListener("change", () => {           // change, not input → no focus loss
          let v = parseFloat(inp.value);
          if (isNaN(v)) v = 0;
          const w = wStrength(i); if (!w) return;
          w.value = v;
          try { w.callback?.(v); } catch (_) {}
          setDirty();
        });
        row.appendChild(inp); inputs[i] = inp;

        rows.appendChild(row);
      }

      const foot = document.createElement("div");
      foot.className = "ng-k2-foot";
      foot.textContent = "🟢 present  🔴 missing · files live in nougan/loras/";
      panel.appendChild(foot);

      const dw = this.addDOMWidget("ng_k2_panel", "div", panel, { serialize: false });
      dw.serializeValue = () => undefined;
      dw.computeSize = w => [w, 26 + count * 34];

      // ── sync helpers ──
      const syncRow = (i) => {
        const on = !!wEnable(i)?.value;
        pills[i].className = "ng-k2-pill " + (on ? "on" : "off");
        pills[i].textContent = on ? "ON" : "OFF";
        inputs[i].disabled = !on;
      };
      const syncAll = () => {
        for (let i = 1; i <= count; i++) {
          syncRow(i);
          const v = wStrength(i)?.value;
          inputs[i].value = (v == null ? "" : String(v));
        }
      };
      const applyMeta = (list) => {
        _lastMeta = list || [];
        const byIdx = Object.fromEntries(_lastMeta.map(m => [m.index, m]));
        for (let i = 1; i <= count; i++) {
          const m = byIdx[i];
          if (!m) continue;
          names[i].textContent = m.display_name || `LoRA ${i}`;
          dots[i].className = "ng-k2-dot " + (m.present ? "present" : "missing");
          dots[i].title = m.present
            ? `✓ ${m.filename}  (${m.size_str})`
            : `✗ missing: nougan/loras/${m.filename}`;
        }
      };
      const refresh = () => fetchStatus().then(applyMeta);

      this._ngK2SyncAll   = syncAll;
      this._ngK2ApplyMeta = applyMeta;
      this._ngK2Refresh   = refresh;

      syncAll();
      refresh();
    };

    const origConf = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (info) {
      origConf?.apply(this, arguments);
      if (this._ngK2SyncAll) {
        this._ngK2SyncAll();
        if (_lastMeta.length) this._ngK2ApplyMeta(_lastMeta);
        this._ngK2Refresh?.();   // re-check presence (files may have been added)
      }
    };
  },
});