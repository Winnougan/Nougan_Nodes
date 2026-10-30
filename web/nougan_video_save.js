import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { createNouganPlayer } from "./nougan_video_player.js";

// ---------------------------------------------------------------------------
// Load the Nougan Nodes stylesheet.
// ---------------------------------------------------------------------------
(() => {
    const cssUrl = new URL("./css/nougan_nodes_v2.css", import.meta.url).href;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = cssUrl;
    document.head.appendChild(link);
})();

let _app = null;

// ---------------------------------------------------------------------------
// Theme helpers.
// ---------------------------------------------------------------------------
const FALLBACK_THEMES = {
    default: { bg: null, title: null, frame: null },
    nougan_purple: { bg: "#3d124d", title: "#19124d", frame: "#ffffff" },
    starnodes_purple: { bg: "#3d124d", title: "#19124d", frame: "#ffffff" },
    midnight: { bg: "#0b1220", title: "#0f2a5f", frame: "#4cc9f0" },
    emerald: { bg: "#0e2a1f", title: "#145a32", frame: "#34d399" },
    sunset: { bg: "#2b0b10", title: "#7c2d12", frame: "#fb923c" },
    ocean: { bg: "#062a3a", title: "#075985", frame: "#22d3ee" },
    rose: { bg: "#2a0b1e", title: "#9f1239", frame: "#fb7185" },
    lavender: { bg: "#1c1630", title: "#5b21b6", frame: "#c4b5fd" },
    amber: { bg: "#1f1407", title: "#92400e", frame: "#fbbf24" },
    forest: { bg: "#0f1f12", title: "#14532d", frame: "#86efac" },
    ice: { bg: "#0b1d26", title: "#164e63", frame: "#a5f3fc" },
    mono: { bg: "#1a1a1a", title: "#333333", frame: "#bdbdbd" },
    coffee: { bg: "#1a0f0a", title: "#7c3f1d", frame: "#e7c6a5" },
};

function getActiveTheme() {
    const themes = globalThis.NouganThemeMap || globalThis.StarNodesThemeMap || FALLBACK_THEMES;
    let themeId = "nougan_purple";
    try {
        themeId = _app?.extensionManager?.setting?.get?.("Nougan.Theme") ?? _app?.extensionManager?.setting?.get?.("StarNodes.Theme") ?? themeId;
    } catch (_) {}
    const theme = themes[themeId] || themes.nougan_purple || themes.starnodes_purple;
    return { themeId, theme };
}

// ---------------------------------------------------------------------------
// Shared layout helpers.
// ---------------------------------------------------------------------------
function setDirty(node) {
    node.graph?.setDirtyCanvas?.(true, true);
    _app?.graph?.setDirtyCanvas?.(true, true);
}

function fitNodeToContent(node, el, minWidth = 340) {
    const apply = () => {
        try {
            const neededW = Math.max(minWidth, el.scrollWidth + 30, node.size[0]);
            const sz = node.computeSize();
            const neededH = Math.max(sz[1] + 6, node.size[1]);
            if (neededW > node.size[0] || neededH > node.size[1]) {
                node.setSize([neededW, neededH]);
                setDirty(node);
            }
        } catch (e) {}
    };
    requestAnimationFrame(() => { apply(); requestAnimationFrame(apply); });
    setTimeout(apply, 60); setTimeout(apply, 180);
}

function applyThemeToPanel(panel) {
    const { theme, themeId } = getActiveTheme();
    if (themeId === "default" || !theme.bg) return;
    panel.style.setProperty("--nougan-theme-bg", theme.bg);
    panel.style.setProperty("--nougan-theme-title", theme.title || "");
    panel.style.setProperty("--nougan-theme-frame", theme.frame || "");
}

function makeHeader(title, subtitle) {
    const header = document.createElement("div");
    header.className = "nougan-header";
    const t = document.createElement("div");
    t.className = "nougan-header-title";
    t.textContent = title;
    header.appendChild(t);
    if (subtitle) {
        const s = document.createElement("div");
        s.className = "nougan-header-sub";
        s.textContent = subtitle;
        header.appendChild(s);
    }
    return header;
}

function createCustomSelect(values, currentValue, onSelect) {
    const trigger = document.createElement("div");
    trigger.className = "nougan-select";
    trigger.tabIndex = 0;
    trigger.textContent = currentValue || values[0];
    let panel = null;

    function closePanel() {
        if (!panel) return;
        panel.remove(); panel = null;
        trigger.classList.remove("open");
    }

    function openPanel() {
        if (panel) return;
        panel = document.createElement("div");
        panel.className = "nougan-dropdown";
        const listEl = document.createElement("div");
        listEl.className = "nougan-dropdown-list";
        values.forEach((v) => {
            const item = document.createElement("div");
            item.className = "nougan-dropdown-item";
            item.textContent = v;
            if (v === trigger.textContent) item.classList.add("selected");
            item.addEventListener("mousedown", (e) => {
                e.preventDefault();
                trigger.textContent = v;
                onSelect(v);
                closePanel();
            });
            listEl.appendChild(item);
        });
        panel.appendChild(listEl);
        const rect = trigger.getBoundingClientRect();
        panel.style.position = "fixed";
        panel.style.left = `${rect.left}px`;
        panel.style.top = `${rect.bottom + 2}px`;
        panel.style.minWidth = `${Math.max(rect.width, 150)}px`;
        document.body.appendChild(panel);
        trigger.classList.add("open");
        const onDown = (e) => {
            if (panel && !panel.contains(e.target) && e.target !== trigger) {
                closePanel(); document.removeEventListener("mousedown", onDown, true);
            }
        };
        setTimeout(() => { document.addEventListener("mousedown", onDown, true); }, 0);
    }

    trigger.addEventListener("click", () => { if (panel) closePanel(); else openPanel(); });
    return { trigger, closePanel };
}

// ---------------------------------------------------------------------------
// DOM panel.
// ---------------------------------------------------------------------------
function buildVideoPanel(node) {
    if (node._nouganVideoPanel) return node._nouganVideoPanel;

    const panel = document.createElement("div");
    panel.className = "nougan-panel nougan-video-panel";
    applyThemeToPanel(panel);
    panel.appendChild(makeHeader("🎬 NOUGAN VIDEO SAVER", "format · codec · quality"));

    const rows = document.createElement("div");
    rows.className = "nougan-video-rows";

    function createSettingRow(labelText) {
        const row = document.createElement("div");
        row.className = "nougan-video-row";
        const label = document.createElement("label");
        label.className = "nougan-video-label";
        label.textContent = labelText;
        row.appendChild(label);
        return row;
    }

    const formatRow = createSettingRow("Format");
    const formatW = node.widgets?.find((w) => w.name === "format");
    const formatSelect = createCustomSelect(["mp4", "webm", "mkv", "gif"], formatW ? formatW.value : "mp4", (val) => {
        if (formatW) formatW.value = val; if (node.graph) node.graph.change(); setDirty(node);
    });
    formatRow.appendChild(formatSelect.trigger); rows.appendChild(formatRow);

    const codecRow = createSettingRow("Codec");
    const codecW = node.widgets?.find((w) => w.name === "codec");
    const codecSelect = createCustomSelect(["h264", "h265", "av1", "vp9", "none (gif)"], codecW ? codecW.value : "h264", (val) => {
        if (codecW) codecW.value = val; if (node.graph) node.graph.change(); setDirty(node);
    });
    codecRow.appendChild(codecSelect.trigger); rows.appendChild(codecRow);

    const fpsRow = createSettingRow("FPS");
    const fpsW = node.widgets?.find((w) => w.name === "fps");
    const fpsInput = document.createElement("input");
    fpsInput.type = "number"; fpsInput.className = "nougan-value-input"; fpsInput.step = "0.1";
    fpsInput.value = fpsW ? fpsW.value : 24.0;
    fpsInput.addEventListener("change", () => {
        let v = parseFloat(fpsInput.value); if (isNaN(v)) v = 24.0;
        if (fpsW) fpsW.value = v; if (node.graph) node.graph.change(); setDirty(node);
    });
    fpsRow.appendChild(fpsInput); rows.appendChild(fpsRow);

    const crfRow = createSettingRow("Quality (CRF)");
    const crfW = node.widgets?.find((w) => w.name === "crf");
    const crfInput = document.createElement("input");
    crfInput.type = "number"; crfInput.className = "nougan-value-input"; crfInput.min = "0"; crfInput.max = "51";
    crfInput.value = crfW ? crfW.value : 23;
    crfInput.addEventListener("change", () => {
        let v = parseInt(crfInput.value); if (isNaN(v)) v = 23;
        if (crfW) crfW.value = v; if (node.graph) node.graph.change(); setDirty(node);
    });
    crfRow.appendChild(crfInput); rows.appendChild(crfRow);

    panel.appendChild(rows);

    // --- VIDEO PLAYER (custom controls: scrubber on its own row, buttons under it) ---
    const player = createNouganPlayer({ onLayout: () => fitNodeToContent(node, panel, 340) });
    panel.appendChild(player.el);   // hidden until the first video finishes

    const widget = node.addDOMWidget("nougan_video_panel", "nouganVideoPanel", panel, { hideOnZoom: false });
    widget.serialize = false;
    widget.serializeValue = () => undefined;
    widget.computeSize = (width) => [width || 340, (panel.scrollHeight || 200) + 6];

    node._nouganVideoPanel = panel;
    node._nouganVideoWidget = widget;
    node._nouganPlayer = player;

    return panel;
}

function hideWidget(node, name) {
    const w = node.widgets?.find((w) => w.name === name);
    if (!w) return null;
    const originalSerialize = w.serializeValue ? w.serializeValue.bind(w) : null;
    w.serializeValue = () => (originalSerialize ? originalSerialize() : w.value);
    w.type = "hidden"; w.hidden = true; w.computeSize = () => [0, -4];
    return w;
}

// ---------------------------------------------------------------------------
// Robust app loader & Extension registration.
// ---------------------------------------------------------------------------
async function loadComfyApp() {
    const candidates = ["../../scripts/app.js", "../../../scripts/app.js", "../../../../scripts/app.js", "/scripts/app.js"];
    for (const path of candidates) {
        try {
            const module = await import(path);
            if (module?.app) return module.app;
        } catch (_) {}
    }
    return null;
}

loadComfyApp().then((app) => {
    if (!app) return;
    _app = app;

    // Listen for node execution to update the video player.
    // The Python node reports `nougan_video` (with an H.264 `preview` proxy for HEVC / ProRes / FFV1);
    // `videos` is kept for the older output shape.
    api.addEventListener("executed", ({ detail }) => {
        const { node: nodeId, output } = detail;
        const vids = output?.nougan_video || output?.videos;
        if (!vids || vids.length === 0) return;

        const node = app.graph.getNodeById(nodeId);
        if (!node || !node._nouganPlayer) return;
        if (node.type !== "NouganVideoSave" && node.type !== "NouganSaveVideo") return;

        const info = vids[0];
        const src = info.preview || info;        // play the proxy when there is one
        // no `preview=` param here: that is for image thumbnails and breaks video requests
        const params = new URLSearchParams({
            filename: src.filename,
            type: src.type || "output",
            subfolder: src.subfolder || "",
        });
        node._nouganPlayer.load(api.apiURL(`/view?${params.toString()}`), { width: info.width, height: info.height });
    });

    app.registerExtension({
        name: "NouganNodes.VideoSave",
        beforeRegisterNodeDef(nodeType, nodeData) {
            if (nodeData.name !== "NouganVideoSave") return;

            const origOnNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                if (origOnNodeCreated) origOnNodeCreated.apply(this, arguments);
                const node = this;
                const origRemoved = node.onRemoved;
                node.onRemoved = function () {
                    node._nouganPlayer?.destroy();
                    if (origRemoved) origRemoved.apply(this, arguments);
                };
                ["format", "codec", "fps", "crf"].forEach((w) => hideWidget(node, w));
                buildVideoPanel(node);
                setTimeout(() => fitNodeToContent(node, node._nouganVideoPanel, 340), 100);
            };

            const origConfigure = nodeType.prototype.configure;
            if (origConfigure) {
                nodeType.prototype.configure = function (data) {
                    origConfigure.apply(this, arguments);
                    const node = this;
                    ["format", "codec", "fps", "crf"].forEach((w) => hideWidget(node, w));
                    buildVideoPanel(node);
                    setTimeout(() => fitNodeToContent(node, node._nouganVideoPanel, 340), 100);
                };
            }
        },
    });
});