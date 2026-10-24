// nougan-character-chat-ui.js -- chat panel for the Nougan Character Chat node (classic LiteGraph DOM widget, no Nodes 2.0)
// v2: ambient WebGPU background (WebGL2 fallback) tinted from the avatar, pop-in messages, dialogue highlight, per-message copy.
//
// Characters come from V2/V3 card PNGs, card JSONs, or refmod .safetensors files with a baked character
// (made by Nougan Refmod Baker); the backend lists and reads all three, this panel just shows them.
//
// Turn flow: Send -> sets the hidden widgets (action / user_message / history_json) -> queues the graph ->
// the node generates the reply -> onExecuted hands back the full history, which becomes the saved chat.

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_NAME = "NouganCharacterChat";
const HIDDEN = ["action", "user_message", "history_json"];
const SETTINGS = ["max_length", "temperature", "top_p", "top_k", "min_p", "repetition_penalty", "seed", "control_after_generate", "thinking", "context_messages", "card_path", "presence_penalty", "mtp", "video_max_frames"];
const WIDTH = 520;
const MSG_MAX_H = 380;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const wget = (node, name) => node.widgets?.find(w => w.name === name);
const enc = encodeURIComponent;

// roleplay-friendly formatting: *actions* in italics, **bold**, newlines
function fmt(text) {
    return esc(text)
        .replace(/\*\*(.+?)\*\*/gs, "<b>$1</b>")
        .replace(/\*(.+?)\*/gs, '<i class="act">$1</i>')
        .replace(/`([^`\n]+)`/g, "<code>$1</code>")
        .replace(/&quot;(.+?)&quot;/gs, '<span class="q">&quot;$1&quot;</span>')
        .replace(/\n/g, "<br>");
}

// Saved widget values are restored by position. If an older / shifted save put values in the wrong widgets
// (e.g. the hidden action value "none" landing in card_path), put them back where they belong.
function repairWidgets(node) {
    const g = (n) => wget(node, n);
    const isHist = (s) => {
        try { const a = JSON.parse(s); return Array.isArray(a) && a.every(m => m && typeof m.content === "string"); } catch { return false; }
    };
    const cp = g("card_path"), ac = g("action"), um = g("user_message"), hj = g("history_json");

    if (cp && ["none", "null", "undefined"].includes(String(cp.value ?? "").trim().toLowerCase())) cp.value = "";

    if (hj && !isHist(hj.value)) {
        const src = [um, ac, cp].find(w => w && typeof w.value === "string" && w.value.trim().startsWith("[") && isHist(w.value));
        if (src) { hj.value = src.value; src.value = ""; } else hj.value = "[]";
    }
    if (ac && !["none", "send", "regenerate"].includes(ac.value)) ac.value = "none";
    if (um && ac && ac.value === "none" && um.value) um.value = "";

    // every numeric setting must be a real number inside its own min/max, otherwise back to its default
    const NUM_DEFAULTS = { max_length: 400, temperature: 0.8, top_p: 0.95, top_k: 64, min_p: 0.05, repetition_penalty: 1.05,
                           context_messages: 40, presence_penalty: 0, video_max_frames: 8 };
    for (const [name, def] of Object.entries(NUM_DEFAULTS)) {
        const w = g(name); if (!w) continue;
        const v = w.value, lo = w.options?.min, hi = w.options?.max;
        const ok = typeof v === "number" && Number.isFinite(v) && (lo == null || v >= lo) && (hi == null || v <= hi);
        if (!ok) w.value = def;
    }
    const seed = g("seed"); if (seed && !(typeof seed.value === "number" && Number.isFinite(seed.value))) seed.value = 0;
    const ctl = g("control_after_generate");
    if (ctl && !["fixed", "increment", "decrement", "randomize"].includes(ctl.value)) ctl.value = "randomize";
    const think = g("thinking"); if (think && typeof think.value !== "boolean") think.value = false;
    const un = g("user_name"); if (un && typeof un.value !== "string") un.value = "User";
    if (cp && typeof cp.value !== "string") cp.value = "";
    const mtp = g("mtp"); if (mtp && Array.isArray(mtp.options?.values) && !mtp.options.values.includes(mtp.value)) mtp.value = "auto";
}

function hideWidget(w) {
    if (!w || w._nbcHidden) return;
    w._nbcHidden = true;
    const el = w.element || w.inputEl;
    if (el) { el.style.display = "none"; el.style.height = "0"; el.style.pointerEvents = "none"; }
    w.computeSize = () => [0, -4];
    w.draw = () => { };
}

// reversible hide, for the collapsible settings
function setHidden(w, hide) {
    if (!w || w._nbcHidden) return;

    if (hide) {
        if (!w._nbcSaved) {
            w._nbcSaved = {
                cs: Object.prototype.hasOwnProperty.call(w, "computeSize") ? w.computeSize : null,
                dr: Object.prototype.hasOwnProperty.call(w, "draw") ? w.draw : null,
            };
        }
        w.computeSize = () => [0, -4];
        w.draw = () => { };
    } else if (w._nbcSaved) {
        if (w._nbcSaved.cs) w.computeSize = w._nbcSaved.cs; else delete w.computeSize;
        if (w._nbcSaved.dr) w.draw = w._nbcSaved.dr; else delete w.draw;
        w._nbcSaved = null;
    }
}


// -- styles -----------------------------------------------------------------

let _styled = false;

function styles() {
    if (_styled) return;
    _styled = true;

    const s = document.createElement("style");
    s.textContent = `
.nbc{--bg:#12141a;--card:#1a1d26;--card2:#20242f;--line:#2a2f3c;--fg:#e8ebf2;--dim:#8a93a6;--acc:#f5a524;--acc2:#ff7a18;--neg:#f0616d;--cA:245,165,36;--cB:255,122,24;
  font:12.5px/1.4 'Inter','Segoe UI',system-ui,sans-serif;color:var(--fg);box-sizing:border-box;width:100%;padding:10px;border-radius:12px;
  border:1px solid var(--line);background:radial-gradient(120% 80% at 0% 0%,rgba(var(--cA),.10),transparent 55%),var(--bg);
  box-shadow:0 8px 26px rgba(0,0,0,.5),inset 0 1px 0 rgba(255,255,255,.04)}
.nbc *{box-sizing:border-box}
.nbc button{font:inherit;color:inherit}

.nbc-head{display:flex;align-items:center;gap:10px;margin-bottom:8px}
.nbc-hav{width:44px;height:44px;border-radius:50%;object-fit:cover;border:2px solid rgb(var(--cA));background:#0d0f14;flex:none;box-shadow:0 0 14px rgba(var(--cA),.45);transition:box-shadow .4s,border-color .4s}
.nbc-hi{min-width:0;flex:1}
.nbc-name{font-weight:800;font-size:14px;letter-spacing:.03em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.nbc-sub{font-size:10px;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.nbc-tb{cursor:pointer;font-size:10.5px;font-weight:700;letter-spacing:.04em;color:var(--dim);background:var(--card);border:1px solid var(--line);
  border-radius:7px;padding:4px 8px;white-space:nowrap;transition:all .15s;flex:none}
.nbc-tb:hover{color:var(--acc);border-color:#4a3b1e;background:var(--card2)}
.nbc-tb.on{color:#1a1206;background:linear-gradient(180deg,#ffc35c,var(--acc));border-color:#c9821a}
.nbc-tb.warn{color:#fff;background:var(--neg);border-color:var(--neg)}

.nbc-log{min-height:160px;max-height:${MSG_MAX_H}px;overflow-y:auto;padding:8px 6px;border-radius:9px;position:relative;z-index:1;background:transparent;
  display:flex;flex-direction:column;gap:9px;scrollbar-width:thin;scrollbar-color:#3a4150 transparent;user-select:text}
.nbc-m{display:flex;gap:7px;align-items:flex-end;max-width:100%}
.nbc-m.user{flex-direction:row-reverse}
.nbc-av{width:26px;height:26px;border-radius:50%;object-fit:cover;flex:none;background:#20242f;border:1px solid #333948}
.nbc-b{position:relative;max-width:82%;padding:7px 10px 8px;border-radius:12px;word-break:break-word}
.nbc-m.assistant .nbc-b{background:rgba(26,29,38,.8);backdrop-filter:blur(6px);border:1px solid rgba(var(--cA),.22);border-bottom-left-radius:3px}
.nbc-m.user .nbc-b{background:linear-gradient(180deg,rgba(245,165,36,.22),rgba(255,122,24,.16));border:1px solid rgba(245,165,36,.4);border-bottom-right-radius:3px}
.nbc-t i.act{color:#aeb7cb}
.nbc-t b{color:#fff}
.nbc-act{position:absolute;top:-11px;right:6px;display:none;gap:2px;background:var(--card2);border:1px solid var(--line);border-radius:7px;padding:1px 3px;z-index:3}
.nbc-m.user .nbc-act{right:auto;left:6px}
.nbc-b:hover .nbc-act{display:flex}
.nbc-a{width:20px;height:18px;display:grid;place-items:center;font-size:11px;cursor:pointer;color:#8a93a6;border-radius:5px}
.nbc-a:hover{color:var(--acc);background:rgba(255,255,255,.06)}
.nbc-a.x:hover{color:#fff;background:var(--neg)}
.nbc-edit{width:100%;min-width:220px;min-height:60px;background:#0f1117;color:var(--fg);border:1px solid var(--acc);border-radius:7px;padding:6px 8px;font:inherit;outline:none;resize:vertical}
.nbc-ef{display:flex;gap:6px;margin-top:5px;justify-content:flex-end}
.nbc-sw{display:flex;align-items:center;gap:4px;margin-top:5px;font-size:10px;color:var(--dim)}
.nbc-sw span.n{cursor:pointer;padding:0 5px;border-radius:5px;background:var(--card2);color:var(--fg)}
.nbc-sw span.n:hover{color:var(--acc)}
.nbc-dots{display:inline-flex;gap:4px;padding:3px 2px}
.nbc-dots i{width:6px;height:6px;border-radius:50%;background:rgb(var(--cA));animation:nbc-bounce 1s infinite ease-in-out}
.nbc-dots i:nth-child(2){animation-delay:.15s}.nbc-dots i:nth-child(3){animation-delay:.3s}
@keyframes nbc-bounce{0%,80%,100%{opacity:.3;transform:translateY(0)}40%{opacity:1;transform:translateY(-3px)}}
.nbc-empty{margin:auto;color:var(--dim);text-align:center;padding:20px 10px;font-size:12px}
.nbc-err{align-self:center;color:#ffb3b9;background:rgba(240,97,109,.12);border:1px solid rgba(240,97,109,.4);border-radius:8px;padding:5px 10px;font-size:11px;max-width:96%}

.nbc-in{display:flex;gap:8px;margin-top:8px;align-items:flex-end}
.nbc-ta{flex:1;resize:none;min-height:42px;max-height:120px;background:#0f1117;color:var(--fg);border:1px solid #2d3342;border-radius:10px;padding:8px 10px;font:inherit;outline:none}
.nbc-ta:focus{border-color:var(--acc);box-shadow:0 0 0 3px rgba(245,165,36,.15)}
.nbc-ta:disabled{opacity:.5}
.nbc-send{cursor:pointer;height:42px;padding:0 16px;border-radius:10px;font-weight:800;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#1a1206;
  border:1px solid #c9821a;background:linear-gradient(180deg,#ffc35c,var(--acc));transition:transform .12s,box-shadow .12s,filter .12s}
.nbc-send:hover:not(:disabled){transform:translateY(-1px);box-shadow:0 5px 16px rgba(245,165,36,.35)}
.nbc-send:disabled{opacity:.5;cursor:default}
.nbc-foot{display:flex;gap:6px;margin-top:8px;align-items:center;flex-wrap:wrap}
.nbc-sp{flex:1}
.nbc-stage{position:relative;border-radius:9px;overflow:hidden;background:#0d0f14;border:1px solid #232834}
.nbc-fx{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;opacity:0;transition:opacity .8s;z-index:0}
.nbc-fx.live{opacity:1}
.nbc-fx.off{display:none}
.nbc-m.nbc-pop{animation:nbc-pop .28s cubic-bezier(.2,.9,.3,1.2) both}
@keyframes nbc-pop{from{opacity:0;transform:translateY(8px) scale(.97)}to{opacity:1;transform:none}}
.nbc-t .q{color:#ffe3ad}
.nbc-t code{background:rgba(255,255,255,.08);padding:0 4px;border-radius:4px;font:11.5px ui-monospace,Consolas,monospace}
.nbc.busy .nbc-hav{animation:nbc-ring 1.4s ease-in-out infinite}
@keyframes nbc-ring{0%,100%{box-shadow:0 0 10px rgba(var(--cA),.35)}50%{box-shadow:0 0 22px 3px rgba(var(--cA),.75)}}
.nbc-think{font-size:10.5px;color:var(--dim);margin-left:6px;font-style:italic;vertical-align:middle}
@media (prefers-reduced-motion:reduce){.nbc *{animation:none!important;transition:none!important}}
`;
    document.head.appendChild(s);
}


// -- ambient FX: WebGPU shader background (falls back to WebGL2, then to nothing) ----------------------
// A soft flowing-nebula shader sits behind the chat log, tinted from the character's avatar. It speeds up and
// pulses while the character is "thinking". Rendered at ~60% resolution, capped at 30 fps, and paused when the
// node is off-screen or the tab is hidden. WebGPU needs a secure context (localhost / 127.0.0.1 / https).

const FX_A = [0.96, 0.65, 0.14], FX_B = [1.0, 0.48, 0.09];       // default amber -> orange

const WGSL = `
struct U { res: vec2f, time: f32, busy: f32, colA: vec4f, colB: vec4f }
@group(0) @binding(0) var<uniform> u: U;
struct VO { @builtin(position) pos: vec4f, @location(0) uv: vec2f }

@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
    var tri = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
    var o: VO;
    o.pos = vec4f(tri[i], 0.0, 1.0);
    o.uv = tri[i] * 0.5 + 0.5;
    return o;
}

fn hsh(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453); }

fn vnoise(p: vec2f) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let w = f * f * (3.0 - 2.0 * f);
    return mix(mix(hsh(i), hsh(i + vec2f(1.0, 0.0)), w.x),
               mix(hsh(i + vec2f(0.0, 1.0)), hsh(i + vec2f(1.0, 1.0)), w.x), w.y);
}

fn fbm(p0: vec2f) -> f32 {
    var p = p0;
    var a = 0.5;
    var s = 0.0;
    for (var k = 0; k < 4; k++) {
        s += a * vnoise(p);
        p = p * 2.02 + vec2f(17.0, 9.0);
        a *= 0.5;
    }
    return s;
}

@fragment fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
    let asp = u.res.x / u.res.y;
    let p = (uv - 0.5) * vec2f(asp, 1.0) * 2.4;
    let t = u.time * (0.05 + 0.14 * u.busy);
    let q = vec2f(fbm(p + vec2f(t, -t * 0.7)), fbm(p + vec2f(-t * 0.6, t) + 5.2));
    let n = fbm(p + 2.0 * q + t);
    let col = mix(u.colA.rgb, u.colB.rgb, smoothstep(0.25, 0.85, n));
    let vig = smoothstep(1.3, 0.2, length(uv - 0.5) * 1.7);
    let pulse = 0.5 + 0.5 * sin(u.time * 3.0);
    let glow = 0.30 + 0.45 * u.busy * pulse;
    let a = clamp(n * n * 2.0 * glow * vig, 0.0, 0.85);
    return vec4f(col * a, a);
}`;

const GLSL_VS = `#version 300 es
void main() {
    vec2 p = vec2((gl_VertexID == 1) ? 3.0 : -1.0, (gl_VertexID == 2) ? 3.0 : -1.0);
    gl_Position = vec4(p, 0.0, 1.0);
}`;

const GLSL_FS = `#version 300 es
precision highp float;
uniform vec2 res; uniform float time; uniform float busy; uniform vec3 colA; uniform vec3 colB;
out vec4 o;
float hsh(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
    vec2 i = floor(p); vec2 f = fract(p); vec2 w = f * f * (3.0 - 2.0 * f);
    return mix(mix(hsh(i), hsh(i + vec2(1.0, 0.0)), w.x), mix(hsh(i + vec2(0.0, 1.0)), hsh(i + vec2(1.0, 1.0)), w.x), w.y);
}
float fbm(vec2 p) {
    float a = 0.5; float s = 0.0;
    for (int k = 0; k < 4; k++) { s += a * vnoise(p); p = p * 2.02 + vec2(17.0, 9.0); a *= 0.5; }
    return s;
}
void main() {
    vec2 uv = gl_FragCoord.xy / res;
    float asp = res.x / res.y;
    vec2 p = (uv - 0.5) * vec2(asp, 1.0) * 2.4;
    float t = time * (0.05 + 0.14 * busy);
    vec2 q = vec2(fbm(p + vec2(t, -t * 0.7)), fbm(p + vec2(-t * 0.6, t) + 5.2));
    float n = fbm(p + 2.0 * q + t);
    vec3 col = mix(colA, colB, smoothstep(0.25, 0.85, n));
    float vig = smoothstep(1.3, 0.2, length(uv - 0.5) * 1.7);
    float pulse = 0.5 + 0.5 * sin(time * 3.0);
    float glow = 0.30 + 0.45 * busy * pulse;
    float a = clamp(n * n * 2.0 * glow * vig, 0.0, 0.85);
    o = vec4(col * a, a);
}`;

// Uniform layout (12 floats): res.xy, time, busy | colA.rgb,1 | colB.rgb,1
async function webgpuBackend(canvas) {
    if (!navigator.gpu) throw new Error("WebGPU not available");
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "low-power" });
    if (!adapter) throw new Error("no WebGPU adapter");
    const device = await adapter.requestDevice();

    try {
        const module = device.createShaderModule({ code: WGSL });
        const info = await module.getCompilationInfo();
        if (info.messages.some(m => m.type === "error")) throw new Error(info.messages.map(m => m.message).join("; "));

        const format = navigator.gpu.getPreferredCanvasFormat();
        const pipeline = device.createRenderPipeline({
            layout: "auto",
            vertex: { module, entryPoint: "vs" },
            fragment: { module, entryPoint: "fs", targets: [{ format }] },
            primitive: { topology: "triangle-list" },
        });
        const ubuf = device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        const bind = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: ubuf } }] });

        const ctx = canvas.getContext("webgpu");
        if (!ctx) throw new Error("no WebGPU canvas context");
        ctx.configure({ device, format, alphaMode: "premultiplied" });

        let lost = false;
        device.lost.then(() => { lost = true; });

        return {
            draw(u) {
                if (lost) return false;
                device.queue.writeBuffer(ubuf, 0, u);
                const enc = device.createCommandEncoder();
                const pass = enc.beginRenderPass({
                    colorAttachments: [{ view: ctx.getCurrentTexture().createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
                });
                pass.setPipeline(pipeline);
                pass.setBindGroup(0, bind);
                pass.draw(3);
                pass.end();
                device.queue.submit([enc.finish()]);
                return true;
            },
            destroy() { try { device.destroy(); } catch { } },
        };
    } catch (e) {
        try { device.destroy(); } catch { }
        throw e;
    }
}

function webglBackend(canvas) {
    const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false, powerPreference: "low-power" });
    if (!gl) throw new Error("no WebGL2");

    const mk = (type, src) => {
        const sh = gl.createShader(type);
        gl.shaderSource(sh, src);
        gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) || "shader compile failed");
        return sh;
    };

    const prog = gl.createProgram();
    gl.attachShader(prog, mk(gl.VERTEX_SHADER, GLSL_VS));
    gl.attachShader(prog, mk(gl.FRAGMENT_SHADER, GLSL_FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || "link failed");

    const vao = gl.createVertexArray();
    const L = Object.fromEntries(["res", "time", "busy", "colA", "colB"].map(n => [n, gl.getUniformLocation(prog, n)]));

    return {
        draw(u, w, h) {
            if (gl.isContextLost()) return false;
            gl.viewport(0, 0, w, h);
            gl.clearColor(0, 0, 0, 0);
            gl.clear(gl.COLOR_BUFFER_BIT);
            gl.useProgram(prog);
            gl.bindVertexArray(vao);
            gl.uniform2f(L.res, u[0], u[1]);
            gl.uniform1f(L.time, u[2]);
            gl.uniform1f(L.busy, u[3]);
            gl.uniform3f(L.colA, u[4], u[5], u[6]);
            gl.uniform3f(L.colB, u[8], u[9], u[10]);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
            return true;
        },
        destroy() { try { gl.getExtension("WEBGL_lose_context")?.loseContext(); } catch { } },
    };
}

function createFX(canvas, onStatus) {
    const S = {
        on: false, dead: false, backend: "", inst: null, initP: null,
        busy: 0, busyT: 0, a: FX_A, b: FX_B, ca: [...FX_A], cb: [...FX_B],
        raf: 0, last: 0, vis: true, t0: performance.now(),
    };
    const u = new Float32Array(12);

    const io = typeof IntersectionObserver !== "undefined"
        ? new IntersectionObserver(es => { S.vis = es[es.length - 1].isIntersecting; })
        : { observe() { }, disconnect() { } };
    io.observe(canvas);

    function init() {
        if (S.initP) return S.initP;
        S.initP = (async () => {
            try { S.inst = await webgpuBackend(canvas); S.backend = "WebGPU"; }
            catch (e1) {
                console.info("[Nougan Chat] WebGPU unavailable, trying WebGL2:", e1?.message || e1);
                try { S.inst = webglBackend(canvas); S.backend = "WebGL2"; }
                catch (e2) { S.inst = null; S.backend = "off"; console.info("[Nougan Chat] ambient FX disabled:", e2?.message || e2); }
            }
            if (S.dead && S.inst) { S.inst.destroy(); S.inst = null; }
            onStatus?.(S.backend);
        })();
        return S.initP;
    }

    function frame(now) {
        S.raf = 0;
        if (!S.on || S.dead || !S.inst) return;
        S.raf = requestAnimationFrame(frame);

        if (document.hidden || !S.vis || !canvas.isConnected) return;
        if (now - S.last < 33) return;                              // ~30 fps is plenty for a soft background
        S.last = now;

        const w = canvas.clientWidth, h = canvas.clientHeight;
        if (w < 4 || h < 4) return;
        const tw = Math.round(w * 0.6), th = Math.round(h * 0.6);
        if (canvas.width !== tw || canvas.height !== th) { canvas.width = tw; canvas.height = th; }

        S.busyT += (S.busy - S.busyT) * 0.1;
        for (let k = 0; k < 3; k++) {
            S.ca[k] += (S.a[k] - S.ca[k]) * 0.08;                   // ease toward the new character's colours
            S.cb[k] += (S.b[k] - S.cb[k]) * 0.08;
        }

        u[0] = tw; u[1] = th; u[2] = (now - S.t0) / 1000; u[3] = S.busyT;
        u[4] = S.ca[0]; u[5] = S.ca[1]; u[6] = S.ca[2]; u[7] = 1;
        u[8] = S.cb[0]; u[9] = S.cb[1]; u[10] = S.cb[2]; u[11] = 1;

        if (S.inst.draw(u, tw, th) === false) { S.inst = null; S.backend = "off"; onStatus?.("off"); }
    }

    return {
        get backend() { return S.backend; },
        setColors(a, b) { S.a = a; S.b = b; },
        setBusy(v) { S.busy = v ? 1 : 0; },
        enable(on) {
            S.on = !!on;
            if (!S.on) { if (S.raf) cancelAnimationFrame(S.raf); S.raf = 0; return; }
            if (S.dead) return;
            init().then(() => { if (S.on && S.inst && !S.raf) S.raf = requestAnimationFrame(frame); });
        },
        destroy() {
            S.dead = true; S.on = false;
            if (S.raf) cancelAnimationFrame(S.raf);
            S.raf = 0;
            io.disconnect();
            S.inst?.destroy();
            S.inst = null;
        },
    };
}

// -- avatar -> two theme colours ---------------------------------------------

function rgb2hsl(r, g, b) {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, l = (mx + mn) / 2;
    const s = d ? d / (1 - Math.abs(2 * l - 1)) : 0;
    let h = 0;
    if (d) {
        if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
        h /= 6; if (h < 0) h += 1;
    }
    return [h, s, l];
}

function hsl2rgb(h, s, l) {
    const f = (n) => { const k = (n + h * 12) % 12; return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
    return [f(0), f(8), f(4)];
}

// Saturation-weighted average colour of the avatar, then a second colour a little further round the hue wheel.
async function themeFromImage(url) {
    const img = new Image();
    img.decoding = "async";
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error("avatar load failed")); img.src = url; });

    const c = document.createElement("canvas");
    c.width = c.height = 24;
    const g = c.getContext("2d", { willReadFrequently: true });
    g.drawImage(img, 0, 0, 24, 24);
    const d = g.getImageData(0, 0, 24, 24).data;

    let r = 0, gr = 0, b = 0, wsum = 0;
    for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] < 128) continue;
        const R = d[i] / 255, G = d[i + 1] / 255, B = d[i + 2] / 255;
        const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
        const sat = mx ? (mx - mn) / mx : 0;
        const wt = sat * sat * mx + 0.01;
        r += R * wt; gr += G * wt; b += B * wt; wsum += wt;
    }
    if (!wsum) throw new Error("empty avatar");

    const [h, s, l] = rgb2hsl(r / wsum, gr / wsum, b / wsum);
    if (s < 0.12) return { a: FX_A, b: FX_B };                      // grey / near-monochrome avatar -> keep the default look

    const s2 = Math.max(s, 0.55), l2 = Math.min(0.62, Math.max(0.5, l));
    return { a: hsl2rgb(h, s2, l2), b: hsl2rgb((h + 0.09) % 1, s2, Math.min(0.68, l2 + 0.05)) };
}


// -- node wiring ------------------------------------------------------------

function fit(node) {
    requestAnimationFrame(() => {
        if (!node.graph) return;

        const ph = node.__nbcPanel?.offsetHeight || 0;
        const dw = node.__nbcDW;
        const wy = (dw?.last_y > 0 ? dw.last_y : null) ?? (dw?.y > 0 ? dw.y : null) ?? 120;
        const h = ph > 0 ? wy + ph + 18 : node.computeSize()[1];

        if (Math.abs(h - node.size[1]) > 1) node.setSize([Math.max(node.size[0], 440), h]);

        node.setDirtyCanvas(true, true);
    });
}

function buildPanel(node) {
    styles();

    const st = node.__nbc;
    const root = document.createElement("div");
    root.className = "nbc";
    root.innerHTML = `
        <div class="nbc-head">
            <img class="nbc-hav" alt="">
            <div class="nbc-hi"><div class="nbc-name">No character</div><div class="nbc-sub">Pick a card or refmod below, or upload one</div></div>
            <button class="nbc-tb nbc-up" title="Upload a character card (PNG/JSON) or a character refmod (.safetensors) into input/characters">⬆ Card</button>
            <button class="nbc-tb nbc-rf" title="Refresh the card and refmod list">↻</button>
            <button class="nbc-tb nbc-fxb" title="Ambient background">✨</button>
            <button class="nbc-tb nbc-set" title="Show / hide sampling settings">⚙</button>
            <input type="file" class="nbc-file" accept=".png,.json,.safetensors" hidden>
        </div>
        <div class="nbc-stage"><canvas class="nbc-fx"></canvas><div class="nbc-log"></div></div>
        <div class="nbc-in">
            <textarea class="nbc-ta" rows="2" placeholder="Say something…  (Enter = send, Shift+Enter = new line)"></textarea>
            <button class="nbc-send">Send</button>
        </div>
        <div class="nbc-foot">
            <button class="nbc-tb nbc-new" title="Start over from the greeting">⟲ New chat</button>
            <button class="nbc-tb nbc-cp" title="Copy the chat as text">⎘ Copy chat</button>
            <span class="nbc-sp"></span>
            <span class="nbc-sub nbc-count"></span>
        </div>`;

    const $ = (s) => root.querySelector(s);
    const logEl = $(".nbc-log"), ta = $(".nbc-ta"), sendBtn = $(".nbc-send");
    const fxCanvas = $(".nbc-fx"), fxBtn = $(".nbc-fxb");
    const fx = createFX(fxCanvas, () => { fxCanvas.classList.toggle("live", !!fx.backend && fx.backend !== "off"); refreshFxUI(); });

    root.addEventListener("pointerdown", e => e.stopPropagation());
    root.addEventListener("keydown", e => { if (e.target.closest?.("input, textarea")) e.stopPropagation(); });
    root.addEventListener("wheel", e => {
        const l = e.target.closest?.(".nbc-log");
        if (l && l.scrollHeight > l.clientHeight) e.stopPropagation();      // scroll the chat, don't zoom the canvas
    }, { passive: true });

    const W = (name) => wget(node, name);
    const setW = (name, v) => { const w = W(name); if (w) w.value = v; };
    const userName = () => (W("user_name")?.value || "User");
    const avatarUrl = () => api.apiURL(`/nougan/character/avatar?character=${enc(W("character")?.value || "")}&card_path=${enc(W("card_path")?.value || "")}&t=${st.avatarTick}`);
    const cardKey = () => `${W("character")?.value || ""}|${W("card_path")?.value || ""}`;

    const save = () => { setW("history_json", JSON.stringify(st.history)); node.setDirtyCanvas(true, true); };

    // -- header / info --
    function renderHeader() {
        const i = st.info;
        $(".nbc-name").textContent = i ? i.name : "No character";
        $(".nbc-sub").textContent = i
            ? [i.source === "refmod" ? "🧬 refmod" : "", i.creator ? `by ${i.creator}` : "", (i.tags || []).slice(0, 4).join(" · "), i.lore_entries ? `${i.lore_entries} lore entries` : ""].filter(Boolean).join("  ·  ") || i.spec
            : (st.infoError || "Pick a card or refmod below, or upload one");
        $(".nbc-sub").title = i?.creator_notes || "";
        const img = $(".nbc-hav");
        if (i) { img.src = avatarUrl(); img.style.visibility = "visible"; } else { img.removeAttribute("src"); img.style.visibility = "hidden"; }
        if (i) applyTheme(); else resetTheme();
    }

    function greetings() {
        const i = st.info;
        return i ? [i.first_mes, ...(i.alternate_greetings || [])].filter(g => g && g.trim()) : [];
    }

    function seedGreeting() {
        const g = greetings();
        st.history = g.length ? [{ role: "assistant", content: g[0] }] : [];
        st.swipe = 0;
        save();
    }

    async function loadInfo(reset) {
        const key = cardKey();

        try {
            const r = await api.fetchApi(`/nougan/character/info?character=${enc(W("character")?.value || "")}&card_path=${enc(W("card_path")?.value || "")}&user=${enc(userName())}`);
            const j = await r.json();
            if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
            st.info = j;
            st.infoError = "";
            if (!st.busy) st.error = "";
        } catch (e) {
            st.info = null;
            st.infoError = e.message || "couldn't read the card";
            console.warn("[Nougan Chat] card load failed:", st.infoError);
            const noCard = String(W("character")?.value || "").startsWith("(none") && !(W("card_path")?.value || "").trim();
            if (!noCard) st.error = st.infoError;           // show it in the chat, not just the tiny header line
        }

        st.avatarTick = Date.now();
        const changed = node.properties?.nbc_card !== key;

        if (st.info && (reset || changed || !st.history.length)) {
            node.properties = node.properties || {};
            node.properties.nbc_card = key;
            if (reset || changed) seedGreeting(); else if (!st.history.length) seedGreeting();
        }

        renderHeader();
        render();
    }

    // -- messages --
    function bubble(m, i) {
        const row = document.createElement("div");
        row.className = "nbc-m " + m.role;

        if (m.role === "assistant") {
            const av = document.createElement("img");
            av.className = "nbc-av";
            av.src = avatarUrl();
            row.appendChild(av);
        }

        const b = document.createElement("div");
        b.className = "nbc-b";

        if (st.editing === i) {
            b.innerHTML = `<textarea class="nbc-edit">${esc(m.content)}</textarea>
                <div class="nbc-ef"><button class="nbc-tb nbc-ec">Cancel</button><button class="nbc-tb on nbc-es">Save</button></div>`;
            const e = b.querySelector("textarea");
            b.querySelector(".nbc-ec").onclick = () => { st.editing = -1; render(); };
            b.querySelector(".nbc-es").onclick = () => { m.content = e.value.trim() || m.content; st.editing = -1; save(); render(); };
            setTimeout(() => e.focus(), 0);
        } else {
            const last = i === st.history.length - 1;
            const acts = [];
            if (!st.busy) {
                acts.push(`<span class="nbc-a" data-a="edit" title="Edit">✎</span>`);
                if (m.role === "assistant" && last && st.history.length > 1) acts.push(`<span class="nbc-a" data-a="regen" title="Regenerate">⟳</span>`);
                acts.push(`<span class="nbc-a" data-a="copy" title="Copy">⎘</span>`);
                acts.push(`<span class="nbc-a x" data-a="del" title="Delete">✕</span>`);
            }
            b.innerHTML = `<div class="nbc-t">${fmt(m.content)}</div>${acts.length ? `<div class="nbc-act">${acts.join("")}</div>` : ""}`;

            const g = greetings();
            if (i === 0 && m.role === "assistant" && st.history.length === 1 && g.length > 1) {
                const sw = document.createElement("div");
                sw.className = "nbc-sw";
                sw.innerHTML = `<span class="n" data-a="prev">‹</span> greeting ${st.swipe + 1} / ${g.length} <span class="n" data-a="next">›</span>`;
                b.appendChild(sw);
            }

            b.addEventListener("click", (e) => {
                const a = e.target.closest?.("[data-a]")?.dataset.a;
                if (!a) return;
                if (a === "edit") { st.editing = i; render(); }
                else if (a === "del") { st.history.splice(i, 1); save(); render(); }
                else if (a === "regen") regenerate();
                else if (a === "copy") { try { navigator.clipboard?.writeText(m.content); } catch { } }
                else if (a === "prev" || a === "next") {
                    const gs = greetings();
                    st.swipe = (st.swipe + (a === "next" ? 1 : gs.length - 1)) % gs.length;
                    st.history[0].content = gs[st.swipe];
                    save();
                    render();
                }
            });
        }

        row.appendChild(b);
        return row;
    }

    function render() {
        logEl.textContent = "";

        if (!st.history.length && !st.busy) {
            const e = document.createElement("div");
            e.className = "nbc-empty";
            e.textContent = st.info ? "Say hello to start the chat." : "Choose a character card or refmod to begin.";
            logEl.appendChild(e);
        }

        const prevN = st.rendered;
        st.history.forEach((m, i) => {
            const row = bubble(m, i);
            if (prevN != null && i >= prevN) row.classList.add("nbc-pop");
            logEl.appendChild(row);
        });
        st.rendered = st.history.length;

        if (st.busy) {
            const row = document.createElement("div");
            row.className = "nbc-m assistant";
            row.innerHTML = `<img class="nbc-av" src="${avatarUrl()}" alt=""><div class="nbc-b"><span class="nbc-dots"><i></i><i></i><i></i></span><span class="nbc-think">${esc(st.info?.name || "…")} is thinking…</span></div>`;
            logEl.appendChild(row);
        }

        if (st.error) {
            const e = document.createElement("div");
            e.className = "nbc-err";
            e.textContent = st.error;
            logEl.appendChild(e);
        }

        logEl.scrollTop = logEl.scrollHeight;
        root.classList.toggle("busy", st.busy);
        fx.setBusy(st.busy);
        ta.disabled = st.busy;
        sendBtn.disabled = st.busy;
        $(".nbc-count").textContent = st.history.length ? `${st.history.length} messages` : "";
        fit(node);
    }

    // -- sending / generating --
    async function run(action, text) {
        st.error = "";
        const keepHist = W("history_json")?.value;
        repairWidgets(node);                            // never queue with a bad value in any setting
        if (keepHist !== undefined) setW("history_json", keepHist);
        setW("action", action);
        setW("user_message", text || "");
        save();                                         // history_json = history *before* the new user message
        st.busy = true;
        render();

        try {
            await app.queuePrompt(0, 1);
        } catch (e) {
            fail(e?.message || "couldn't queue the prompt");
        }
    }

    function send() {
        const text = ta.value.trim();
        if (!text || st.busy) return;
        if (!st.info) { st.error = "No character loaded — pick a card or refmod first."; render(); return; }

        st.lastSent = text;
        st.removed = null;
        ta.value = "";
        run("send", text).then(() => { });
        st.history.push({ role: "user", content: text });          // optimistic bubble (the node returns the real history)
        render();
    }

    function regenerate() {
        if (st.busy || !st.history.length) return;

        const last = st.history[st.history.length - 1];
        st.removed = last.role === "assistant" ? st.history.pop() : null;
        st.lastSent = null;
        run("regenerate", "");
    }

    function fail(msg) {
        if (!st.busy) return;
        st.busy = false;
        st.error = msg || "generation failed";

        if (st.lastSent) {                                  // put the message back so nothing is lost
            if (st.history.length && st.history[st.history.length - 1].role === "user") st.history.pop();
            ta.value = st.lastSent;
        } else if (st.removed) {
            st.history.push(st.removed);
        }

        st.lastSent = null; st.removed = null;
        setW("action", "none"); setW("user_message", "");
        save();
        render();
    }

    ta.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
    });
    ta.addEventListener("input", () => {
        ta.style.height = "auto";
        ta.style.height = Math.min(120, ta.scrollHeight) + "px";
    });
    sendBtn.onclick = send;

    // -- header / footer buttons --
    async function refreshList(selectName) {
        try {
            const r = await api.fetchApi("/nougan/character/list");
            const j = await r.json();
            const w = W("character");

            if (w && Array.isArray(j.cards)) {
                w.options = w.options || {};
                w.options.values = j.cards;
                if (selectName && j.cards.includes(selectName)) w.value = selectName;
                else if (!j.cards.includes(w.value)) w.value = j.cards[0];
            }
        } catch (e) {
            st.error = "couldn't refresh the card list";
        }
    }

    $(".nbc-rf").onclick = async () => { await refreshList(); await loadInfo(false); };

    $(".nbc-up").onclick = () => $(".nbc-file").click();
    $(".nbc-file").onchange = async (e) => {
        const f = e.target.files?.[0];
        e.target.value = "";
        if (!f) return;

        const fd = new FormData();
        fd.append("image", f, f.name);
        fd.append("type", "input");
        fd.append("subfolder", "characters");
        fd.append("overwrite", "true");

        try {
            const r = await api.fetchApi("/upload/image", { method: "POST", body: fd });
            const j = await r.json();
            if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
            await refreshList(j.name || f.name);
            await loadInfo(true);
        } catch (err) {
            st.error = `upload failed: ${err.message}`;
            render();
        }
    };

    $(".nbc-set").onclick = () => {
        node.properties = node.properties || {};
        node.properties.nbc_settings = !node.properties.nbc_settings;
        applySettings();
    };

    let armed = null;
    $(".nbc-new").onclick = () => {
        const b = $(".nbc-new");
        if (st.busy) return;

        if (st.history.length > 1 && !armed) {
            b.classList.add("warn");
            b.textContent = "Click again to confirm";
            armed = setTimeout(() => { armed = null; b.classList.remove("warn"); b.textContent = "⟲ New chat"; }, 2200);
            return;
        }

        clearTimeout(armed);
        armed = null;
        b.classList.remove("warn");
        b.textContent = "⟲ New chat";
        st.error = "";
        seedGreeting();
        render();
    };

    $(".nbc-cp").onclick = () => {
        const name = st.info?.name || "Character", u = userName();
        const text = st.history.map(m => `${m.role === "assistant" ? name : u}: ${m.content}`).join("\n\n");
        try { navigator.clipboard?.writeText(text); } catch { }
        const b = $(".nbc-cp");
        b.textContent = "Copied ✓";
        setTimeout(() => { b.textContent = "⎘ Copy chat"; }, 1000);
    };

    function applySettings() {
        const open = !!node.properties?.nbc_settings;
        SETTINGS.forEach(n => setHidden(W(n), !open));
        $(".nbc-set").classList.toggle("on", open);
        fit(node);
        node.setDirtyCanvas(true, true);
    }

    // -- ambient FX + avatar theme --
    let themeSeq = 0;

    function resetTheme() {
        ++themeSeq;
        root.style.removeProperty("--cA");
        root.style.removeProperty("--cB");
        fx.setColors(FX_A, FX_B);
    }

    async function applyTheme() {
        const seq = ++themeSeq;
        try {
            const t = await themeFromImage(avatarUrl());
            if (seq !== themeSeq) return;
            const css = (c) => c.map(v => Math.round(v * 255)).join(",");
            root.style.setProperty("--cA", css(t.a));
            root.style.setProperty("--cB", css(t.b));
            fx.setColors(t.a, t.b);
        } catch { if (seq === themeSeq) resetTheme(); }
    }

    function fxWanted() {
        const v = node.properties?.nbc_fx;
        if (v !== undefined) return !!v;
        return !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    }

    function refreshFxUI() {
        const on = fxWanted();
        fxBtn.classList.toggle("on", on);
        fxBtn.title = on
            ? `Ambient background: ${fx.backend || "starting…"} (click to turn off)`
            : "Ambient background is off (click to turn on)";
    }

    function applyFX() {
        const on = fxWanted();
        fxCanvas.classList.toggle("off", !on);
        fx.enable(on);
        refreshFxUI();
    }

    fxBtn.onclick = () => {
        node.properties = node.properties || {};
        node.properties.nbc_fx = !fxWanted();
        applyFX();
    };

    // -- hooks used by the extension --
    node.__nbcRender = render;
    node.__nbcLoadInfo = loadInfo;
    node.__nbcApplySettings = applySettings;
    node.__nbcFail = fail;
    node.__nbcSave = save;
    node.__nbcApplyFX = applyFX;
    node.__nbcDestroy = () => fx.destroy();

    node.__nbcOnExecuted = (message) => {
        const raw = message?.nbc_chat?.[0];
        if (!raw) return;

        const data = JSON.parse(raw);
        if (Array.isArray(data.history)) st.history = data.history;

        st.busy = false;
        st.error = "";
        st.lastSent = null;
        st.removed = null;
        setW("action", "none");
        setW("user_message", "");
        save();
        render();
    };

    if (typeof ResizeObserver !== "undefined") new ResizeObserver(() => fit(node)).observe(root);

    return root;
}

function buildUI(node) {
    if (node.__nbcBuilt) return;
    node.__nbcBuilt = true;
    node.__nbc = { history: [], info: null, infoError: "", busy: false, error: "", editing: -1, swipe: 0, avatarTick: Date.now(), lastSent: null, removed: null };

    HIDDEN.forEach(n => hideWidget(wget(node, n)));

    try {
        const h = JSON.parse(wget(node, "history_json")?.value || "[]");
        if (Array.isArray(h)) node.__nbc.history = h.filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string");
    } catch { }

    const panel = buildPanel(node);

    const holder = document.createElement("div");           // ComfyUI forces an inline height on the DOM widget element,
    holder.style.cssText = "width:100%;overflow:visible;";  // so the panel sits inside a holder and keeps its natural height
    holder.appendChild(panel);

    const getH = () => Math.max(panel.offsetHeight + 4, 300);

    const dw = node.addDOMWidget("nbc_panel", "div", holder, { serialize: false, getHeight: getH, getMinHeight: getH });
    dw.serializeValue = () => undefined;
    dw.computeSize = (w) => [w, getH()];

    node.__nbcPanel = panel;
    node.__nbcDW = dw;

    // changing the card / name refreshes the header (a different card restarts the chat)
    for (const name of ["character", "card_path", "user_name"]) {
        const w = wget(node, name);
        if (!w) continue;

        const cb = w.callback;
        w.callback = function () {
            const r = cb?.apply(this, arguments);
            node.__nbcLoadInfo(false);
            return r;
        };
    }

    node.__nbcApplySettings();
    node.__nbcApplyFX();
    node.__nbcRender();
    node.__nbcLoadInfo(false);
    setTimeout(() => fit(node), 60);
    setTimeout(() => fit(node), 400);
}

// generation errors / interruptions arrive as global events
function failBusyNodes(msg) {
    for (const n of app.graph?._nodes || []) {
        if (n.__nbcBuilt && n.__nbc?.busy) n.__nbcFail(msg);
    }
}

api.addEventListener("execution_error", (e) => failBusyNodes(e.detail?.exception_message || "execution error"));
api.addEventListener("execution_interrupted", () => failBusyNodes("generation interrupted"));
api.addEventListener("execution_success", () => {
    setTimeout(() => failBusyNodes("The chat node didn't run — is it muted or bypassed?"), 600);
});

app.registerExtension({
    name: "Nougan.CharacterChat",

    loadedGraphNode(node) {
        if (node?.type !== NODE_NAME) return;
        try { repairWidgets(node); node.__nbcApplySettings?.(); node.__nbcRender?.(); } catch (e) { console.warn("[Nougan Chat] repair failed", e); }
    },

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData?.name !== NODE_NAME) return;

        const onc = nodeType.prototype.onNodeCreated;

        nodeType.prototype.onNodeCreated = function () {
            onc?.apply(this, arguments);
            this.size = [WIDTH, 720];

            try { buildUI(this); } catch (e) { console.warn("[Nougan Chat] UI build failed", e); }
        };

        const ocf = nodeType.prototype.onConfigure;

        nodeType.prototype.onConfigure = function () {
            ocf?.apply(this, arguments);

            try {
                repairWidgets(this);
                if (!this.__nbcBuilt) buildUI(this);

                const st = this.__nbc;
                try {
                    const h = JSON.parse(wget(this, "history_json")?.value || "[]");
                    st.history = Array.isArray(h) ? h.filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string") : [];
                } catch { st.history = []; }

                st.busy = false;
                st.rendered = undefined;
                this.__nbcApplySettings();
                this.__nbcApplyFX?.();
                this.__nbcRender();
                this.__nbcLoadInfo(false);
                setTimeout(() => fit(this), 60);
                setTimeout(() => fit(this), 400);
            } catch (e) {
                console.warn("[Nougan Chat] onConfigure failed", e);
            }
        };

        const orm = nodeType.prototype.onRemoved;

        nodeType.prototype.onRemoved = function () {
            orm?.apply(this, arguments);

            try { this.__nbcDestroy?.(); } catch { }
        };

        const oex = nodeType.prototype.onExecuted;

        nodeType.prototype.onExecuted = function (message) {
            oex?.apply(this, arguments);

            try { this.__nbcOnExecuted?.(message); } catch (e) { console.warn("[Nougan Chat] onExecuted failed", e); }
        };
    },
});
