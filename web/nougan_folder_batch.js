import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_CLASS = "FolderImageBatchLoader";
const BTN_LABEL = "🔄 Refresh folder";

function getWidget(node, name) {
    return node.widgets?.find((w) => w.name === name);
}

function nodeClassOf(node) {
    return node?.comfyClass ?? node?.type;
}

function toast(severity, summary, detail) {
    try {
        app.extensionManager?.toast?.add({ severity, summary, detail, life: 4000 });
    } catch (e) {
        console.log(`[Nougan] ${summary}: ${detail}`);
    }
}

async function refreshFolder(node, btn) {
    const folder = getWidget(node, "folder_path")?.value ?? "";
    const sort = getWidget(node, "sort_mode")?.value ?? "";
    const idxWidget = getWidget(node, "index");
    const oldIndex = idxWidget?.value ?? 0;

    const params = new URLSearchParams({
        folder,
        sort,
        index: String(oldIndex),
    });

    btn.label = "⏳ Scanning...";
    app.graph.setDirtyCanvas(true, true);

    try {
        const resp = await api.fetchApi(`/nougan/folder_batch/scan?${params}`);
        const data = await resp.json();

        if (!data.ok) {
            btn.label = BTN_LABEL;
            app.graph.setDirtyCanvas(true, true);
            toast("error", "Refresh failed", data.error ?? "Unknown error");
            return;
        }

        if (idxWidget) idxWidget.value = data.index;
        btn.label = `${BTN_LABEL} (${data.total} images)`;

        // best-effort: show the current image in the node preview without running the graph
        const p = data.preview;
        if (p) {
            const url = api.apiURL(
                `/view?filename=${encodeURIComponent(p.filename)}` +
                `&type=${p.type}&subfolder=${encodeURIComponent(p.subfolder)}` +
                `&rand=${Math.random()}`
            );
            const img = new Image();
            img.onload = () => {
                node.imgs = [img];
                app.graph.setDirtyCanvas(true, true);
            };
            img.src = url;
        }

        let detail = `${data.total} images (${data.first} → ${data.last})`;
        if (oldIndex !== data.index) {
            detail += ` · index was past the end, reset to ${data.index}`;
        }
        toast("success", "Folder refreshed", detail);
        app.graph.setDirtyCanvas(true, true);
    } catch (err) {
        console.error("[Nougan] folder refresh failed", err);
        btn.label = BTN_LABEL;
        app.graph.setDirtyCanvas(true, true);
        toast("error", "Refresh failed", String(err));
    }
}

app.registerExtension({
    name: "Winnougan.FolderImageBatchLoader",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_CLASS) return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onNodeCreated?.apply(this, arguments);

            const btn = this.addWidget("button", BTN_LABEL, null, () => {
                refreshFolder(this, btn);
            });
            btn.label = BTN_LABEL;
            btn.serialize = false; // buttons never get saved into the workflow

            // give the preview some room by default, still freely resizable
            this.setSize([
                Math.max(this.size[0], 340),
                Math.max(this.size[1], 500),
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
