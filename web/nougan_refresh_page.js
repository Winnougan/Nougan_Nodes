// web/nougan_refresh_page.js  —  Nougan Refresh Page by Winnougan
// Two buttons on the "Nougan Refresh Page" node:
//   Reload models  - same as pressing R: re-reads the model folders and refreshes every
//                    dropdown (checkpoints, LoRAs, VAEs...) without losing the workflow.
//   Refresh page   - full browser reload.

import { app } from "../../scripts/app.js";

const NODE_NAME = "NouganRefreshPage";
const RELOAD_LABEL = "Reload models ♻️ (R)";
const PAGE_LABEL = "Refresh page 🔄";

// Run whatever "refresh node definitions" mechanism this ComfyUI frontend has.
async function reloadModels() {
  const cmd = app.extensionManager?.command;
  if (cmd?.execute) {
    try {
      await cmd.execute("Comfy.RefreshNodeDefinitions"); // the command the R key runs
      return true;
    } catch (_) { /* fall through to the older API */ }
  }
  if (typeof app.refreshComboInNodes === "function") {
    await app.refreshComboInNodes();
    return true;
  }
  return false;
}

app.registerExtension({
  name: "Nougan.RefreshPage",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== NODE_NAME) return;

    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onCreated ? onCreated.apply(this, arguments) : undefined;

      let busy = false;
      const reloadBtn = this.addWidget("button", RELOAD_LABEL, null, async () => {
        if (busy) return;
        busy = true;
        reloadBtn.name = "Reloading models…";
        this.setDirtyCanvas(true, true);
        let label = "Models reloaded ✔";
        try {
          if (!(await reloadModels())) label = "Reload not supported ✘";
        } catch (err) {
          console.error("[Nougan] Reload models failed:", err);
          label = "Reload failed ✘ (see console)";
        }
        reloadBtn.name = label;
        this.setDirtyCanvas(true, true);
        setTimeout(() => {
          reloadBtn.name = RELOAD_LABEL;
          busy = false;
          this.setDirtyCanvas(true, true);
        }, 1500);
      });

      this.addWidget("button", PAGE_LABEL, null, () => {
        window.location.reload();
      });

      this.setSize([Math.max(this.size[0], 260), Math.max(this.size[1], 90)]);
      return r;
    };
  },
});
