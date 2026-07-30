// web/nougan_set_get.js
import { app } from "../../scripts/app.js";

const COLOR_MAP = {
    "Default": null,
    "Void":    "#0a0a0a",
    "Neon":    "#00f3ff",
    "Plasma":  "#bc13fe",
    "Toxic":   "#39ff14",
    "Flare":   "#ff5e00",
    "Blood":   "#ff0000",
    "Quantum": "#0044ff",
    "Gold":    "#ffaa00",
    "Abyss":   "#ff007f",
    "Ghost":   "#e0e0e0",
    "Rose":    "#ff0055",
    "Matrix":  "#00ff41",
    "Nebula":  "#4b0082"
};

function darkenColor(hex, percent) {
    if (!hex) return null;
    let r = parseInt(hex.substring(1, 3), 16);
    let g = parseInt(hex.substring(3, 5), 16);
    let b = parseInt(hex.substring(5, 7), 16);
    r = parseInt(r * (100 - percent) / 100);
    g = parseInt(g * (100 - percent) / 100);
    b = parseInt(b * (100 - percent) / 100);
    return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}

function applyColor(node, colorName) {
    const brightHex = COLOR_MAP[colorName] || null;
    const titleHex = brightHex ? darkenColor(brightHex, 45) : null; 
    const bodyHex = brightHex ? darkenColor(brightHex, 65) : null; 

    node.nougan_hex = brightHex;

    if (brightHex) {
        node.color = titleHex;
        node.bgcolor = bodyHex;
        node.boxcolor = brightHex;
        
        if (node.nouganBadge) {
            node.nouganBadge.style.background = bodyHex;
            node.nouganBadge.style.color = "#ffffff";
            node.nouganBadge.style.borderColor = brightHex;
            node.nouganBadge.style.boxShadow = `0 0 10px ${brightHex}88, 0 0 4px ${brightHex}44`;
        }
    } else {
        node.color = null;
        node.bgcolor = null;
        node.boxcolor = null;
        node.nougan_hex = null;
        
        if (node.nouganBadge) {
            node.nouganBadge.style.background = "";
            node.nouganBadge.style.color = "";
            node.nouganBadge.style.borderColor = "";
            node.nouganBadge.style.boxShadow = "";
        }
    }

    const updateLinks = (slots) => {
        if (!slots) return;
        slots.forEach(slot => {
            if (slot.link) {
                const link = app.graph.links[slot.link];
                if (link) link.color = brightHex;
            }
            if (slot.links) {
                slot.links.forEach(linkId => {
                    const link = app.graph.links[linkId];
                    if (link) link.color = brightHex;
                });
            }
        });
    };
    updateLinks(node.inputs);
    updateLinks(node.outputs);
    
    if (app.graph) app.graph.setDirtyCanvas(true, true);
}

function syncGetNodesForSet(setNode) {
    if (!app.graph) return;
    const setKey = setNode.widgets.find(w => w.name === "key")?.value;
    const setColor = setNode.widgets.find(w => w.name === "color")?.value || "Default";

    app.graph.nodes.forEach(n => {
        if (n.type === "NouganGet") {
            const getKey = n.widgets.find(w => w.name === "key");
            if (getKey) {
                if (getKey.value === setKey) {
                    applyColor(n, setColor);
                } else {
                    const matchingSet = app.graph.nodes.find(sn =>
                        sn.type === "NouganSet" && sn.widgets.find(w => w.name === "key")?.value === getKey.value
                    );
                    if (matchingSet) {
                        applyColor(n, matchingSet.widgets.find(w => w.name === "color").value);
                    } else {
                        applyColor(n, "Default");
                    }
                }
            }
        }
    });
}

app.registerExtension({
    name: "Nougan.RemoteSetGet",
    
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name === "NouganSet" || nodeData.name === "NouganGet") {
            
            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function() {
                const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
                this.isNouganRemote = true;
                this.remoteType = nodeData.name === "NouganSet" ? "SET" : "GET";
                
                // DOM Badge
                const badge = document.createElement("div");
                badge.className = "nougan-remote-badge";
                badge.style.position = "absolute";
                badge.style.padding = "4px 12px";
                badge.style.borderRadius = "6px";
                badge.style.fontSize = "11px";
                badge.style.fontWeight = "bold";
                badge.style.fontFamily = "monospace";
                badge.style.letterSpacing = "0.5px";
                badge.style.pointerEvents = "none"; 
                badge.style.zIndex = "10000";
                badge.style.border = "2px solid";
                badge.style.transition = "all 0.2s ease";
                badge.style.whiteSpace = "nowrap";
                badge.style.textTransform = "uppercase";
                document.body.appendChild(badge);
                this.nouganBadge = badge;
                
                const colorWidget = this.widgets.find(w => w.name === "color");
                const keyWidget = this.widgets.find(w => w.name === "key");
                
                const updateBadge = () => {
                    const icon = this.remoteType === "SET" ? "⚡" : "";
                    const key = keyWidget ? keyWidget.value : "unknown";
                    badge.textContent = `${icon} ${key}`;
                };

                if (nodeData.name === "NouganSet") {
                    if (keyWidget) {
                        keyWidget.callback = (val) => {
                            if (val && !val.startsWith("set_")) {
                                setTimeout(() => {
                                    keyWidget.value = "set_" + val;
                                    updateBadge();
                                    syncGetNodesForSet(this);
                                }, 10);
                            }
                        };
                    }
                    if (colorWidget) {
                        setTimeout(() => applyColor(this, colorWidget.value), 100);
                        colorWidget.callback = (val) => {
                            applyColor(this, val);
                            syncGetNodesForSet(this);
                        };
                    }
                } 
                else if (nodeData.name === "NouganGet") {
                    const updateGetKeys = () => {
                        if (!keyWidget) return;
                        const setNodes = app.graph.nodes.filter(n => n.type === "NouganSet");
                        const keys = ["select a key..."];
                        setNodes.forEach(n => {
                            const k = n.widgets.find(w => w.name === "key");
                            if (k && k.value && !keys.includes(k.value)) keys.push(k.value);
                        });
                        keyWidget.options.values = keys;
                    };

                    keyWidget.mouse = (e, pos, node) => { updateGetKeys(); return false; };
                    
                    if (keyWidget) {
                        keyWidget.callback = (val) => {
                            updateBadge();
                            const matchingSet = app.graph.nodes.find(sn => 
                                sn.type === "NouganSet" && sn.widgets.find(w => w.name === "key")?.value === val
                            );
                            if (matchingSet) {
                                applyColor(this, matchingSet.widgets.find(w => w.name === "color").value);
                            } else {
                                applyColor(this, "Default");
                            }
                        };
                    }
                    
                    setTimeout(() => {
                        updateGetKeys();
                        if (keyWidget.value && keyWidget.value !== "select a key...") {
                            const matchingSet = app.graph.nodes.find(sn => 
                                sn.type === "NouganSet" && sn.widgets.find(w => w.name === "key")?.value === keyWidget.value
                            );
                            if (matchingSet) {
                                applyColor(this, matchingSet.widgets.find(w => w.name === "color").value);
                            }
                        }
                    }, 100);
                }

                if (keyWidget) {
                    const orig = keyWidget.callback;
                    keyWidget.callback = function() {
                        updateBadge();
                        if (orig) return orig.apply(this, arguments);
                    };
                    updateBadge();
                }
                return r;
            };

            // Canvas override to draw darkened background
            const onDrawBackground = nodeType.prototype.onDrawBackground;
            nodeType.prototype.onDrawBackground = function(ctx) {
                const r = onDrawBackground ? onDrawBackground.apply(this, arguments) : undefined;
                if (this.nougan_hex) {
                    ctx.save();
                    const w = this.size[0];
                    const h = this.size[1];
                    const radius = 10;
                    ctx.beginPath();
                    ctx.moveTo(radius, 0); ctx.lineTo(w - radius, 0); ctx.quadraticCurveTo(w, 0, w, radius);
                    ctx.lineTo(w, h - radius); ctx.quadraticCurveTo(w, h, w - radius, h);
                    ctx.lineTo(radius, h); ctx.quadraticCurveTo(0, h, 0, h - radius);
                    ctx.lineTo(0, radius); ctx.quadraticCurveTo(0, 0, radius, 0);
                    ctx.closePath();
                    ctx.fillStyle = darkenColor(this.nougan_hex, 65);
                    ctx.fill();
                    ctx.restore();
                }
                return r;
            };

            // Badge positioning
            const onDrawForeground = nodeType.prototype.onDrawForeground;
            nodeType.prototype.onDrawForeground = function(ctx) {
                const r = onDrawForeground ? onDrawForeground.apply(this, arguments) : undefined;
                
                if (this.nouganBadge && !this.flags.collapsed) {
                    const canvas = app.canvas;
                    const rect = canvas.canvas.getBoundingClientRect();
                    const scale = canvas.ds.scale;
                    const offset = canvas.ds.offset;
                    const x = (this.pos[0] + offset[0]) * scale + rect.left + 10;
                    const y = (this.pos[1] + this.size[1] + offset[1]) * scale + rect.top + 8; 
                    this.nouganBadge.style.left = `${x}px`;
                    this.nouganBadge.style.top = `${y}px`;
                    this.nouganBadge.style.display = "block";
                } else if (this.nouganBadge) {
                    this.nouganBadge.style.display = "none";
                }
                return r;
            };
            
            const onRemoved = nodeType.prototype.onRemoved;
            nodeType.prototype.onRemoved = function() {
                if (this.nouganBadge) { this.nouganBadge.remove(); this.nouganBadge = null; }
                return onRemoved ? onRemoved.apply(this, arguments) : undefined;
            };
        }
    }
});