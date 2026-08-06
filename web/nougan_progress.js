import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

let active = false;
let wrap = null, fill = null, label = null;

function build() {
    if (document.getElementById("nougan-progress-wrap")) return;

    wrap = document.createElement("div");
    wrap.id = "nougan-progress-wrap";
    Object.assign(wrap.style, {
        position: "fixed", left: "50%", bottom: "18px", transform: "translateX(-50%)",
        width: "340px", zIndex: "9999", fontFamily: "monospace",
        background: "rgba(10,10,14,0.92)", border: "1px solid #3d3d5c",
        borderRadius: "10px", padding: "10px 14px",
        boxShadow: "0 6px 24px rgba(0,0,0,0.5)", display: "none",
        pointerEvents: "none",
    });

    label = document.createElement("div");
    Object.assign(label.style, {
        color: "#9aa0ff", fontSize: "11px", letterSpacing: "0.5px",
        marginBottom: "6px", textTransform: "uppercase",
        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
    });
    label.textContent = "NOUGAN";

    const track = document.createElement("div");
    Object.assign(track.style, {
        width: "100%", height: "8px", background: "#1c1c2e",
        borderRadius: "6px", overflow: "hidden",
    });

    fill = document.createElement("div");
    Object.assign(fill.style, {
        width: "0%", height: "100%",
        background: "linear-gradient(90deg, #6c5ce7, #00cec9)",
        borderRadius: "6px", transition: "width 120ms ease",
    });

    track.appendChild(fill);
    wrap.appendChild(label);
    wrap.appendChild(track);
    document.body.appendChild(wrap);
}

function hide() { if (wrap) wrap.style.display = "none"; }

function set(pct, text) {
    build();
    wrap.style.display = "block";
    fill.style.width = Math.max(0, Math.min(100, pct)) + "%";
    if (text) label.textContent = text;
}

app.registerExtension({
    name: "nougan.progress-bar",
    async setup() {
        build(); // prebuild (hidden)

        // Stage-level progress emitted by the Python nodes
        api.addEventListener("nougan_progress", (e) => {
            active = true;
            const d = e.detail || {};
            set(d.percent || 0, "NOUGAN · " + (d.stage || ""));
        });

        // ComfyUI sampling steps — only render if a Nougan node kicked it off
        api.addEventListener("progress", (e) => {
            if (!active) return;
            const d = e.detail || {};
            if (d.max && d.max > 0) {
                set((d.value / d.max) * 100, `NOUGAN · Sampling ${d.value}/${d.max}`);
            }
        });

        // Execution finished (whole prompt done)
        api.addEventListener("executing", (e) => {
            if (e.detail === null) { active = false; hide(); }
        });

        // Safety net: queue empty → hide
        api.addEventListener("status", (e) => {
            const s = e.detail && e.detail.exec_info;
            if (s && s.queue_remaining === 0) { active = false; hide(); }
        });
    },
});