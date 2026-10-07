import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_CLASS = "FolderImageBatchLoader";

function getWidget(node, name) {
    return node.widgets?.find((w) => w.name === name);
}

function nodeClassOf(node) {
    return node?.comfyClass ?? node?.type;
}

app.registerExtension({
    name: "Winnougan.FolderImageBatchLoader",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_CLASS) return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onNodeCreated?.apply(this, arguments);
            // give the preview some room by default, still freely resizable
            this.setSize([
                Math.max(this.size[0], 340),
                Math.max(this.size[1], 480),
            ]);
            return r;
        };
    },

    setup() {
        // info from the loader's last execution: { node, index, total }
        let pending = null;

        api.addEventListener("executed", ({ detail }) => {
            const info = detail?.output?.batch_info;
            if (!info) return;
            const node = app.graph.getNodeById(Number(detail.node));
            if (!node || nodeClassOf(node) !== NODE_CLASS) return;
            pending = { node, index: info[0], total: info[1] };
        });

        api.addEventListener("execution_success", () => {
            const p = pending;
            pending = null;
            if (!p) return;

            const auto = getWidget(p.node, "auto_run_folder");
            const idxWidget = getWidget(p.node, "index");
            if (!auto?.value || !idxWidget) return;

            const next = p.index + 1;
            if (next < p.total) {
                idxWidget.value = next;
                app.graph.setDirtyCanvas(true, true);
                // small delay so the UI state settles before re-queueing
                setTimeout(() => app.queuePrompt(0, 1), 50);
            } else {
                // finished the folder, rewind so the next Run starts from the top
                idxWidget.value = 0;
                app.graph.setDirtyCanvas(true, true);
            }
        });

        // stop the chain on cancel or error
        api.addEventListener("execution_error", () => { pending = null; });
        api.addEventListener("execution_interrupted", () => { pending = null; });
    },
});
