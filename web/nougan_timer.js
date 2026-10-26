import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

/* ------------------------------------------------------------------ *
 *  Nougan Timer
 *  - WebGPU renders an animated backdrop into an offscreen canvas
 *  - everything is blitted/drawn in onDrawForeground (classic UI safe,
 *    no DOM elements living on top of the graph)
 *  - falls back to a 2D gradient if WebGPU is missing / disabled
 * ------------------------------------------------------------------ */

const NODE_CLASS = "NouganTimer";
const EVT_UPDATE = "nougan_timer_update";
const SET_GPU = "Nougan.Timer.WebGPU";
const SET_SOUND = "Nougan.Timer.DoneSound";

const PALETTE = ["#4ade80", "#00bfff", "#ffcc00", "#ff007f", "#ffffff"];
const MONO = '"JetBrains Mono","SF Mono",Consolas,ui-monospace,monospace';
const IDLE_GRACE_MS = 1500;
const MIN_BODY_H = 190;

const MODE = { READY: 0, RUNNING: 1, PAUSED: 2, DONE: 3, INTERRUPT: 4, ERROR: 5 };
const CHIP_TEXT = {
    READY: "READY", RUNNING: "RUNNING", PAUSED: "PAUSED",
    DONE: "DONE", INTERRUPT: "INTERRUPTED", ERROR: "ERROR",
};
const ENERGY_TARGET = { READY: 0.12, RUNNING: 1, PAUSED: 0.25, DONE: 0.6, INTERRUPT: 0.45, ERROR: 0.55 };
const GREY = [0.62, 0.72, 0.66];
const END_COLORS = { DONE: [0.29, 0.87, 0.5], INTERRUPT: [0.87, 0.7, 0.0], ERROR: [0.9, 0.01, 0.45] };

/* ------------------------------ helpers ----------------------------- */

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const pad = (n) => String(n).padStart(2, "0");

function hexToRgb(hex) {
    const n = parseInt(hex.replace("#", ""), 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
function css(rgb, a = 1) {
    return `rgba(${Math.round(rgb[0] * 255)},${Math.round(rgb[1] * 255)},${Math.round(rgb[2] * 255)},${a})`;
}
function rr(ctx, x, y, w, h, r) {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
    else ctx.rect(x, y, w, h);
}
function splitTime(ms) {
    const s = Math.floor(Math.max(0, ms) / 1000);
    return {
        h: pad(Math.floor(s / 3600)),
        m: pad(Math.floor((s % 3600) / 60)),
        s: pad(s % 60),
        t: Math.floor((Math.max(0, ms) % 1000) / 100),
    };
}
function fmtDur(ms) {
    if (!isFinite(ms) || ms <= 0) return "--";
    const s = ms / 1000;
    if (s < 1) return `${Math.round(ms)}ms`;
    if (s < 60) return `${s.toFixed(s < 10 ? 2 : 1)}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${pad(Math.floor(s % 60))}s`;
    return `${Math.floor(m / 60)}h ${pad(m % 60)}m`;
}
function fmtClock(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
function widgetsBottom(node) {
    let b = 0;
    for (const w of node.widgets || []) {
        if (w.last_y === undefined) continue;
        const h = w.computedHeight ?? w.computeSize?.(node.size[0])?.[1] ?? 24;
        b = Math.max(b, w.last_y + h);
    }
    return b || 46;
}
function getSetting(id, fallback) {
    try {
        const v = app.extensionManager?.setting?.get(id);
        if (v !== undefined) return v;
    } catch { /* ignore */ }
    try {
        const v = app.ui?.settings?.getSettingValue(id);
        if (v !== undefined) return v;
    } catch { /* ignore */ }
    return fallback;
}
function beep() {
    try {
        const ac = new (window.AudioContext || window.webkitAudioContext)();
        const o = ac.createOscillator();
        const g = ac.createGain();
        o.type = "sine";
        o.frequency.value = 880;
        g.gain.setValueAtTime(0.0001, ac.currentTime);
        g.gain.exponentialRampToValueAtTime(0.2, ac.currentTime + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.6);
        o.connect(g).connect(ac.destination);
        o.start();
        o.stop(ac.currentTime + 0.65);
        setTimeout(() => ac.close(), 1000);
    } catch { /* autoplay blocked etc. */ }
}

/* ------------------------------ WebGPU ------------------------------ */

const WGSL = /* wgsl */ `
struct U {
  res: vec2f,
  time: f32,
  progress: f32,
  color: vec4f,
  params: vec4f, // x energy, y pulse, z mode
};
@group(0) @binding(0) var<uniform> u: U;

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[vi], 0.0, 1.0);
}

fn hash21(p: vec2f) -> f32 {
  var q = fract(p * vec2f(123.34, 456.21));
  q += dot(q, q + 45.32);
  return fract(q.x * q.y);
}

fn vnoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let s = f * f * (3.0 - 2.0 * f);
  let a = hash21(i);
  let b = hash21(i + vec2f(1.0, 0.0));
  let c = hash21(i + vec2f(0.0, 1.0));
  let d = hash21(i + vec2f(1.0, 1.0));
  return mix(mix(a, b, s.x), mix(c, d, s.x), s.y);
}

fn fbm(p0: vec2f) -> f32 {
  var p = p0;
  var a = 0.5;
  var v = 0.0;
  for (var i = 0; i < 4; i++) {
    v += a * vnoise(p);
    p = p * 2.03 + vec2f(17.1, 9.2);
    a *= 0.5;
  }
  return v;
}

@fragment
fn fs(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let uv = frag.xy / u.res;
  let aspect = u.res.x / u.res.y;
  let t = u.time;
  let energy = u.params.x;
  let pulse = u.params.y;
  let mode = u.params.z;
  let tint = u.color.rgb;

  // domain-warped flow field
  let p = vec2f(uv.x * aspect, uv.y) * 2.2;
  let w = vec2f(fbm(p + vec2f(t * 0.15, 0.0)), fbm(p + vec2f(5.2, t * 0.12)));
  let n = fbm(p + 1.6 * w + vec2f(0.0, t * 0.05));

  var col = vec3f(0.035, 0.075, 0.04);
  col += tint * pow(n, 2.2) * (0.16 + 0.5 * energy);
  col += vec3f(0.02, 0.05, 0.03) * n;

  // vignette
  let c = uv - vec2f(0.5, 0.5);
  let vig = 1.0 - smoothstep(0.25, 0.95, length(c * vec2f(1.0, 1.4)));
  col *= 0.5 + 0.6 * vig;

  // progress ribbon along the bottom edge (y grows downward in frag space)
  let ry = 1.0 - uv.y;
  let lit = smoothstep(0.0, 0.02, u.progress - uv.x);
  let flick = 0.75 + 0.25 * vnoise(vec2f(uv.x * 14.0 - t * 2.0, t));
  col += tint * exp(-ry * 11.0) * lit * flick * (0.3 + 0.5 * energy);

  // head flare
  let hx = (uv.x - u.progress) * 14.0;
  col += tint * exp(-(hx * hx) - ry * 9.0) * (0.35 + 0.9 * pulse);

  // ripple on every completed item
  let d = distance(vec2f(uv.x * aspect, uv.y), vec2f(u.progress * aspect, 1.0));
  let rad = (1.0 - pulse) * 0.9;
  let rd = (d - rad) * 12.0;
  col += tint * exp(-(rd * rd)) * pulse * 0.45;

  if (mode > 1.5 && mode < 2.5) { col = mix(col, vec3f(dot(col, vec3f(0.333))), 0.65); }
  if (mode > 2.5 && mode < 3.5) { col += tint * 0.10 * (0.5 + 0.5 * sin(t * 2.0)); }
  if (mode > 4.5) { col += vec3f(0.12, 0.0, 0.02) * (0.5 + 0.5 * sin(t * 6.0)); }

  col += (hash21(frag.xy + fract(t)) - 0.5) / 128.0;
  return vec4f(clamp(col, vec3f(0.0), vec3f(1.0)), 1.0);
}
`;

const GPU = {
    status: "idle", // idle | loading | ready | failed
    device: null, pipeline: null, format: null, promise: null,
    init() {
        if (this.promise) return this.promise;
        this.status = "loading";
        this.promise = (async () => {
            try {
                if (!navigator.gpu) throw new Error("navigator.gpu missing");
                const adapter = await navigator.gpu.requestAdapter({ powerPreference: "low-power" });
                if (!adapter) throw new Error("no adapter");
                const device = await adapter.requestDevice();
                device.lost.then(() => {
                    GPU.status = "failed";
                    GPU.device = null;
                });
                const format = navigator.gpu.getPreferredCanvasFormat();
                const module = device.createShaderModule({ code: WGSL });
                const pipeline = device.createRenderPipeline({
                    layout: "auto",
                    vertex: { module, entryPoint: "vs" },
                    fragment: { module, entryPoint: "fs", targets: [{ format }] },
                    primitive: { topology: "triangle-list" },
                });
                Object.assign(this, { device, pipeline, format, status: "ready" });
            } catch (err) {
                console.warn("[Nougan Timer] WebGPU unavailable, using 2D fallback:", err);
                this.status = "failed";
            }
        })();
        return this.promise;
    },
};

class Backdrop {
    constructor() {
        this.canvas = document.createElement("canvas"); // never attached to the DOM
        this.canvas.width = 2;
        this.canvas.height = 2;
        this.ctx = null;
        this.device = null;
        this.ubuf = null;
        this.bind = null;
        this.data = new Float32Array(12);
    }

    ensure(w, h) {
        if (GPU.status !== "ready") return false;
        if (this.device !== GPU.device) {
            this.ctx = this.canvas.getContext("webgpu");
            if (!this.ctx) return false;
            this.ctx.configure({ device: GPU.device, format: GPU.format, alphaMode: "opaque" });
            this.ubuf = GPU.device.createBuffer({
                size: 48,
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            });
            this.bind = GPU.device.createBindGroup({
                layout: GPU.pipeline.getBindGroupLayout(0),
                entries: [{ binding: 0, resource: { buffer: this.ubuf } }],
            });
            this.device = GPU.device;
        }
        if (this.canvas.width !== w || this.canvas.height !== h) {
            this.canvas.width = w;
            this.canvas.height = h;
        }
        return true;
    }

    // Renders one frame and returns true if the canvas is ready to be drawImage()'d
    // (must be called in the same task as the drawImage, so we do it inside onDrawForeground).
    draw(w, h, p) {
        try {
            if (!this.ensure(w, h)) return false;
            const d = this.data;
            d[0] = w; d[1] = h; d[2] = p.time; d[3] = p.progress;
            d[4] = p.rgb[0]; d[5] = p.rgb[1]; d[6] = p.rgb[2]; d[7] = 1;
            d[8] = p.energy; d[9] = p.pulse; d[10] = p.mode; d[11] = 0;
            const dev = GPU.device;
            dev.queue.writeBuffer(this.ubuf, 0, d);
            const enc = dev.createCommandEncoder();
            const pass = enc.beginRenderPass({
                colorAttachments: [{
                    view: this.ctx.getCurrentTexture().createView(),
                    clearValue: { r: 0, g: 0, b: 0, a: 1 },
                    loadOp: "clear",
                    storeOp: "store",
                }],
            });
            pass.setPipeline(GPU.pipeline);
            pass.setBindGroup(0, this.bind);
            pass.draw(3);
            pass.end();
            dev.queue.submit([enc.finish()]);
            return true;
        } catch (err) {
            console.warn("[Nougan Timer] WebGPU frame failed, falling back to 2D:", err);
            GPU.status = "failed";
            return false;
        }
    }
}

/* --------------------------- shared ticker -------------------------- */

const controllers = new Set();
let tickHandle = null;

function ensureTicker() {
    if (tickHandle) return;
    tickHandle = setInterval(() => {
        let any = false;
        for (const c of controllers) if (c.wantsAnimation()) any = true;
        if (any) {
            if (!document.hidden) app.graph?.setDirtyCanvas(true, false);
        } else {
            clearInterval(tickHandle);
            tickHandle = null;
        }
    }, 33);
}

/* ---------------------------- node timer ---------------------------- */

class NodeTimer {
    constructor(node) {
        this.node = node;
        this.backdrop = new Backdrop();
        this.hits = [];
        this.hover = null;
        this.energy = 0.12;
        this.pulse = 0;
        this.animT = Math.random() * 50;
        this.dispProgress = 0;
        this.lastFrame = performance.now();
        this.settled = false;
        this.reset(false);
    }

    /* ---- state ---- */

    get label() {
        return this.status === "RUNNING" && this.paused ? "PAUSED" : this.status;
    }
    readTotal() {
        const w = this.node.widgets?.find((x) => x.name === "total_images");
        return Math.max(1, Number(w?.value) || 1);
    }
    elapsed() {
        return this.baseMs + (this.status === "RUNNING" && !this.paused ? performance.now() - this.syncAt : 0);
    }
    matches(id) {
        const mine = String(this.node.id);
        const s = String(id);
        return s === mine || s.endsWith(":" + mine);
    }
    poke() {
        this.settled = false;
        ensureTicker();
        app.graph?.setDirtyCanvas(true, false);
    }

    reset(notify = true) {
        this.status = "READY";
        this.paused = false;
        this.baseMs = 0;
        this.syncAt = 0;
        this.current = 0;
        this.total = this.readTotal();
        this.durations = [];
        this.lastItemMs = 0;
        this.finishedAt = 0;
        if (notify) {
            api.fetchApi("/nougan_timer/reset", {
                method: "POST",
                body: JSON.stringify({ node_id: String(this.node.id) }),
            }).catch(() => {});
            this.poke();
        }
    }

    begin(offsetMs = 0) {
        this.status = "RUNNING";
        this.paused = false;
        this.baseMs = offsetMs;
        this.syncAt = performance.now();
        this.current = 0;
        this.total = this.readTotal();
        this.durations = [];
        this.lastItemMs = offsetMs;
        this.finishedAt = 0;
    }

    finish(kind) {
        if (this.status !== "RUNNING") return;
        this.baseMs = this.elapsed();
        this.status = kind;
        this.paused = false;
        this.finishedAt = Date.now();
        if (kind === "DONE") {
            this.current = this.total;
            this.pulse = 1;
            if (getSetting(SET_SOUND, false)) beep();
        } else {
            api.fetchApi("/nougan_timer/reset", {
                method: "POST",
                body: JSON.stringify({ node_id: String(this.node.id) }),
            }).catch(() => {});
        }
        this.poke();
    }

    togglePause() {
        if (this.status !== "RUNNING") return;
        if (this.paused) {
            this.syncAt = performance.now();
            this.paused = false;
        } else {
            this.baseMs = this.elapsed();
            this.paused = true;
        }
        this.poke();
    }

    /* ---- events ---- */

    onExecStart() {
        const m = this.node.mode;
        if ((m === 0 || m === undefined) && this.status !== "RUNNING") {
            this.begin(0); // arm at prompt start so the first item (model load etc.) is counted
            this.poke();
        }
    }

    onUpdate(d) {
        const cur = Number(d.current) || 0;
        let late = false;
        if (this.status !== "RUNNING" || cur < this.current) {
            late = true;
            const off = d.started_at && d.now ? Math.max(0, (d.now - d.started_at) * 1000) : 0;
            this.begin(off);
        }
        this.total = Number(d.total) || this.total;
        const n = cur - this.current;
        if (n > 0) {
            const el = this.elapsed();
            if (!late) {
                const per = (el - this.lastItemMs) / n;
                if (per > 0) for (let i = 0; i < Math.min(n, 5); i++) this.durations.push(per);
            }
            this.lastItemMs = el;
            this.current = cur;
            this.pulse = 1;
        }
        if (this.durations.length > 64) this.durations.splice(0, this.durations.length - 64);
        this.poke();
    }

    onSuccess() {
        if (this.status !== "RUNNING") return;
        if (this.current > 0 && this.current >= this.total) this.finish("DONE");
        else if (this.current === 0) {
            this.reset(false); // armed, but this node never fired in that prompt
            this.poke();
        }
    }

    onQueueIdle() {
        if (this.status !== "RUNNING") return;
        this.finish(this.current > 0 && this.current >= this.total ? "DONE" : "INTERRUPT");
    }

    tryResume(st) {
        if (this.status !== "READY" || lastQueueRemaining === 0) return;
        const run = st?.runs?.[String(this.node.id)];
        if (!run || !run.active) return;
        const off = Math.max(0, (st.now - run.started_at) * 1000);
        this.begin(off);
        this.total = run.total;
        this.current = run.completed;
        const s = run.stamps || [];
        for (let i = 1; i < s.length; i++) this.durations.push((s[i] - s[i - 1]) * 1000);
        this.lastItemMs = s.length ? (s[s.length - 1] - run.started_at) * 1000 : off;
        this.poke();
    }

    /* ---- numbers ---- */

    avgMs() {
        if (this.status === "DONE" && this.current > 0) return this.baseMs / this.current;
        const d = this.durations;
        if (!d.length) return 0;
        const use = d.length >= 2 ? d.slice(1).slice(-10) : d; // drop the warm-up item once we can
        return use.reduce((a, b) => a + b, 0) / use.length;
    }
    etaMs() {
        if (this.status !== "RUNNING" || this.paused || this.current === 0) return 0;
        return Math.max(0, this.total - this.current) * this.avgMs();
    }

    /* ---- animation ---- */

    wantsAnimation() {
        return !this.settled;
    }
    advance(dt) {
        const target = ENERGY_TARGET[this.label] ?? 0.12;
        const goal = this.total > 0 ? clamp(this.current / this.total, 0, 1) : 0;
        this.energy += (target - this.energy) * Math.min(1, dt * 3.5);
        this.animT += dt * (0.25 + this.energy * 1.1);
        this.pulse = Math.max(0, this.pulse - dt * 1.1);
        this.dispProgress += (goal - this.dispProgress) * Math.min(1, dt * 6);
        this.settled =
            !(this.status === "RUNNING" && !this.paused) &&
            Math.abs(target - this.energy) < 0.01 &&
            this.pulse < 0.01 &&
            Math.abs(goal - this.dispProgress) < 0.002;
    }

    tint() {
        return END_COLORS[this.status] || hexToRgb(this.node.properties?.accent || PALETTE[0]);
    }
    chipRgb() {
        const l = this.label;
        return l === "READY" || l === "PAUSED" ? GREY : this.tint();
    }

    /* ---- drawing ---- */

    fallbackBackdrop(ctx, x, y, w, h, tint) {
        ctx.fillStyle = "#0b170c";
        ctx.fillRect(x, y, w, h);
        const g = ctx.createRadialGradient(x + w / 2, y + h * 0.35, 4, x + w / 2, y + h * 0.35, w * 0.6);
        g.addColorStop(0, css(tint, 0.1 + 0.22 * this.energy));
        g.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = g;
        ctx.fillRect(x, y, w, h);
        const g2 = ctx.createLinearGradient(0, y + h - 26, 0, y + h);
        g2.addColorStop(0, "rgba(0,0,0,0)");
        g2.addColorStop(1, css(tint, 0.3 + 0.3 * this.pulse));
        ctx.fillStyle = g2;
        ctx.fillRect(x, y + h - 26, w * this.dispProgress, 26);
    }

    draw(ctx) {
        const node = this.node;
        const now = performance.now();
        const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
        this.lastFrame = now;
        if (this.status === "READY") this.total = this.readTotal();
        this.advance(dt);

        const W = node.size[0];
        const H = node.size[1];
        const M = 10;
        const x = M;
        const y = widgetsBottom(node) + 8;
        const w = W - M * 2;
        const h = H - y - M;
        this.hits = [];
        if (w < 140 || h < 100) return;

        const s = clamp(Math.min(w / 300, h / MIN_BODY_H), 0.75, 1.7);
        const tint = this.tint();
        const label = this.label;
        const live = this.status === "RUNNING" && !this.paused;

        ctx.save();
        rr(ctx, x, y, w, h, 9);
        ctx.clip();

        /* backdrop */
        let drew = false;
        if (!app.canvas?.low_quality && getSetting(SET_GPU, true)) {
            if (GPU.status === "idle") GPU.init();
            if (GPU.status === "ready") {
                const iw = clamp(Math.round(w * 0.5), 96, 480);
                const ih = Math.max(48, Math.round((iw * h) / w));
                drew = this.backdrop.draw(iw, ih, {
                    time: this.animT, progress: this.dispProgress, rgb: tint,
                    energy: this.energy, pulse: this.pulse, mode: MODE[label] ?? 0,
                });
                if (drew) ctx.drawImage(this.backdrop.canvas, x, y, w, h);
            }
        }
        if (!drew) this.fallbackBackdrop(ctx, x, y, w, h, tint);
        ctx.fillStyle = "rgba(4,10,5,0.30)";
        ctx.fillRect(x, y, w, h);

        /* badge + status chip */
        ctx.textBaseline = "middle";
        ctx.textAlign = "left";
        ctx.font = `700 ${9 * s}px ${MONO}`;
        ctx.fillStyle = "rgba(74,222,128,0.75)";
        const rowTop = y + h * 0.075;
        ctx.fillText("\u26A1 WINNOUGAN", x + 14 * s, rowTop);

        const chip = CHIP_TEXT[label];
        const chipRgb = this.chipRgb();
        const cw = ctx.measureText(chip).width + 26 * s;
        const ch = 16 * s;
        const cx = x + w - 14 * s - cw;
        const cy = rowTop - ch / 2;
        rr(ctx, cx, cy, cw, ch, ch / 2);
        ctx.fillStyle = css(chipRgb, 0.14);
        ctx.fill();
        ctx.strokeStyle = css(chipRgb, 0.5);
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = css(chipRgb, live ? 0.55 + 0.45 * Math.sin(now / 260) : 1);
        ctx.beginPath();
        ctx.arc(cx + 9 * s, rowTop, 3 * s, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = css(chipRgb, 1);
        ctx.fillText(chip, cx + 16 * s, rowTop + 0.5);

        /* big time */
        const t = splitTime(this.elapsed());
        const px = Math.min(w * 0.17, h * 0.27);
        ctx.font = `700 ${px}px ${MONO}`;
        const cell = ctx.measureText("0").width;
        const colon = cell * 0.55;
        const tpx = px * 0.42;
        ctx.font = `700 ${tpx}px ${MONO}`;
        const tcell = ctx.measureText("0").width;
        const totalW = cell * 6 + colon * 2 + tcell * 2;
        let tx = x + (w - totalW) / 2;
        const baseY = y + h * 0.30 + px * 0.36;
        const colonOn = !live || Math.floor(now / 500) % 2 === 0;

        ctx.textBaseline = "alphabetic";
        ctx.textAlign = "center";
        ctx.shadowColor = css(tint, 0.9);
        ctx.shadowBlur = (live ? 16 : 6) * s;
        ctx.font = `700 ${px}px ${MONO}`;
        ctx.fillStyle = this.status === "READY" ? "rgba(200,225,208,0.55)" : "#eafff1";
        for (const part of [t.h, ":", t.m, ":", t.s]) {
            if (part === ":") {
                ctx.globalAlpha = colonOn ? 1 : 0.25;
                ctx.fillText(":", tx + colon / 2, baseY - px * 0.04);
                ctx.globalAlpha = 1;
                tx += colon;
            } else {
                for (const chr of part) {
                    ctx.fillText(chr, tx + cell / 2, baseY);
                    tx += cell;
                }
            }
        }
        ctx.shadowBlur = 0;
        ctx.font = `700 ${tpx}px ${MONO}`;
        ctx.fillStyle = css(tint, 0.65);
        ctx.fillText(".", tx + tcell / 2, baseY);
        ctx.fillText(String(t.t), tx + tcell * 1.5, baseY);

        /* progress */
        const bx = x + 14 * s;
        const bw = w - 28 * s;
        const by = y + h * 0.565;
        const bh = 7 * s;
        const pct = this.total > 0 ? Math.floor((this.current / this.total) * 100) : 0;
        ctx.font = `600 ${10.5 * s}px ${MONO}`;
        ctx.textAlign = "left";
        ctx.fillStyle = "#d6f5df";
        ctx.fillText(`${this.current} / ${this.total}`, bx, y + h * 0.535);
        ctx.textAlign = "right";
        ctx.fillStyle = css(tint, 1);
        ctx.fillText(`${pct}%`, bx + bw, y + h * 0.535);

        rr(ctx, bx, by, bw, bh, bh / 2);
        ctx.fillStyle = "rgba(255,255,255,0.07)";
        ctx.fill();
        ctx.strokeStyle = css(tint, 0.25);
        ctx.lineWidth = 1;
        ctx.stroke();

        const pw = bw * clamp(this.dispProgress, 0, 1);
        if (pw > 1) {
            const g = ctx.createLinearGradient(bx, 0, bx + pw, 0);
            g.addColorStop(0, css(tint, 0.45));
            g.addColorStop(1, css(tint, 1));
            ctx.shadowColor = css(tint, 0.8);
            ctx.shadowBlur = 8 * s;
            rr(ctx, bx, by, Math.max(pw, bh), bh, bh / 2);
            ctx.fillStyle = g;
            ctx.fill();
            ctx.shadowBlur = 0;
        }
        if (live && this.current === 0) {
            const sw = bw * 0.22;
            const sx = bx + ((this.animT * 0.7) % 1.3 - 0.15) * bw;
            ctx.save();
            rr(ctx, bx, by, bw, bh, bh / 2);
            ctx.clip();
            const g = ctx.createLinearGradient(sx, 0, sx + sw, 0);
            g.addColorStop(0, "rgba(0,0,0,0)");
            g.addColorStop(0.5, css(tint, 0.9));
            g.addColorStop(1, "rgba(0,0,0,0)");
            ctx.fillStyle = g;
            ctx.fillRect(sx, by, sw, bh);
            ctx.restore();
        }

        /* stats */
        const avg = this.avgMs();
        const eta = this.etaMs();
        const done = this.status === "DONE";
        const cols = [
            ["AVG / IT", avg ? fmtDur(avg) : "--"],
            ["ETA", eta ? fmtDur(eta) : "--"],
            [done ? "TOTAL" : "EST. TOTAL", done ? fmtDur(this.baseMs) : eta ? fmtDur(this.elapsed() + eta) : "--"],
            [done ? "FINISHED" : "FINISH", done ? fmtClock(this.finishedAt) : eta ? fmtClock(Date.now() + eta) : "--"],
        ];
        const colW = bw / 4;
        ctx.textAlign = "center";
        cols.forEach(([lab, val], i) => {
            const cxm = bx + colW * (i + 0.5);
            ctx.font = `600 ${8 * s}px ${MONO}`;
            ctx.fillStyle = "rgba(180,210,190,0.55)";
            ctx.fillText(lab, cxm, y + h * 0.70);
            ctx.font = `700 ${12.5 * s}px ${MONO}`;
            ctx.fillStyle = "#eafff1";
            ctx.fillText(val, cxm, y + h * 0.80);
        });

        /* bottom row: swatches + buttons */
        const rowY = y + h * 0.925;
        const accent = (node.properties?.accent || PALETTE[0]).toLowerCase();
        const sz = 9 * s;
        let sx2 = x + 14 * s;
        for (const c of PALETTE) {
            ctx.fillStyle = c;
            rr(ctx, sx2, rowY - sz / 2, sz, sz, 2 * s);
            ctx.fill();
            if (c === accent) {
                ctx.strokeStyle = "rgba(255,255,255,0.85)";
                ctx.lineWidth = 1;
                rr(ctx, sx2 - 2, rowY - sz / 2 - 2, sz + 4, sz + 4, 3 * s);
                ctx.stroke();
            }
            this.hits.push({ id: "sw:" + c, type: "swatch", color: c, x: sx2 - 3, y: rowY - sz / 2 - 3, w: sz + 6, h: sz + 6 });
            sx2 += sz + 7 * s;
        }

        ctx.font = `700 ${8.5 * s}px ${MONO}`;
        ctx.textBaseline = "middle";
        ctx.textAlign = "center";
        const buttons = [
            { id: "reset", text: "RESET", enabled: true },
            { id: "pause", text: this.paused ? "RESUME" : "PAUSE", enabled: this.status === "RUNNING" },
        ];
        let bxr = x + w - 14 * s;
        for (const b of buttons) {
            const bw2 = ctx.measureText(b.text).width + 16 * s;
            const bh2 = 16 * s;
            bxr -= bw2;
            const hov = this.hover === b.id && b.enabled;
            rr(ctx, bxr, rowY - bh2 / 2, bw2, bh2, 4 * s);
            ctx.fillStyle = css(tint, hov ? 0.28 : 0.12);
            ctx.fill();
            ctx.strokeStyle = css(tint, b.enabled ? (hov ? 0.9 : 0.45) : 0.15);
            ctx.lineWidth = 1;
            ctx.stroke();
            ctx.fillStyle = b.enabled ? css(tint, 1) : "rgba(180,200,185,0.3)";
            ctx.fillText(b.text, bxr + bw2 / 2, rowY + 0.5);
            if (b.enabled) this.hits.push({ id: b.id, type: b.id, x: bxr, y: rowY - bh2 / 2, w: bw2, h: bh2 });
            bxr -= 6 * s;
        }

        /* border */
        rr(ctx, x + 0.5, y + 0.5, w - 1, h - 1, 9);
        ctx.strokeStyle = css(tint, 0.3);
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.restore();
        ctx.textBaseline = "alphabetic";
        ctx.textAlign = "left";
    }

    hitAt(pos) {
        for (const h of this.hits) {
            if (pos[0] >= h.x && pos[0] <= h.x + h.w && pos[1] >= h.y && pos[1] <= h.y + h.h) return h;
        }
        return null;
    }
}

/* --------------------------- global events -------------------------- */

let lastQueueRemaining = null;
let idleTimer = null;
let statePromise = null;

app.registerExtension({
    name: "Nougan.Timer",

    settings: [
        {
            id: SET_GPU,
            name: "WebGPU backdrop",
            type: "boolean",
            defaultValue: true,
            tooltip: "Animated shader behind the timer. Turn off if it renders black or you just want the plain gradient.",
            category: ["Nougan", "Timer", "WebGPU backdrop"],
        },
        {
            id: SET_SOUND,
            name: "Play a sound when a batch finishes",
            type: "boolean",
            defaultValue: false,
            category: ["Nougan", "Timer", "Done sound"],
        },
    ],

    async setup() {
        api.addEventListener(EVT_UPDATE, (e) => {
            const d = e.detail || {};
            for (const c of controllers) if (c.matches(d.node_id)) c.onUpdate(d);
        });
        api.addEventListener("execution_start", () => controllers.forEach((c) => c.onExecStart()));
        api.addEventListener("execution_success", () => controllers.forEach((c) => c.onSuccess()));
        api.addEventListener("execution_error", () => controllers.forEach((c) => c.finish("ERROR")));
        api.addEventListener("execution_interrupted", () => controllers.forEach((c) => c.finish("INTERRUPT")));

        api.addEventListener("status", (e) => {
            const d = e.detail;
            // detail shape differs between frontend versions, read both
            const q = d?.exec_info?.queue_remaining ?? d?.status?.exec_info?.queue_remaining;
            if (typeof q !== "number") return;
            lastQueueRemaining = q;
            clearTimeout(idleTimer);
            if (q === 0) {
                idleTimer = setTimeout(() => {
                    if (lastQueueRemaining === 0) controllers.forEach((c) => c.onQueueIdle());
                }, IDLE_GRACE_MS);
            }
        });

        statePromise = api
            .fetchApi("/nougan_timer/state")
            .then((r) => r.json())
            .catch(() => null);
    },

    async afterConfigureGraph() {
        const st = await statePromise;
        if (!st) return;
        controllers.forEach((c) => c.tryResume(st));
    },

    nodeCreated(node) {
        if (node.comfyClass !== NODE_CLASS || node._nougan) return;

        node.properties = node.properties || {};
        node.properties.accent = (node.properties.accent || PALETTE[0]).toLowerCase();
        node.color = "#1a2a1a";
        node.bgcolor = "#0f1f0f";

        const ctl = new NodeTimer(node);
        node._nougan = ctl;
        controllers.add(ctl);

        // keep the body big enough for the display
        const baseCompute = node.computeSize;
        node.computeSize = function () {
            const base = baseCompute ? baseCompute.apply(this, arguments) : [220, 60];
            return [Math.max(base[0], 300), base[1] + MIN_BODY_H];
        };
        const sz = node.computeSize();
        node.size = [Math.max(node.size?.[0] || 0, sz[0]), Math.max(node.size?.[1] || 0, sz[1])];

        const prevDraw = node.onDrawForeground;
        node.onDrawForeground = function (ctx) {
            prevDraw?.apply(this, arguments);
            if (this.flags?.collapsed) return;
            ctl.draw(ctx);
        };

        node.onMouseDown = function (e, pos) {
            const h = ctl.hitAt(pos);
            if (!h) return false;
            if (h.type === "swatch") {
                this.properties.accent = h.color;
                ctl.poke();
            } else if (h.type === "pause") ctl.togglePause();
            else if (h.type === "reset") ctl.reset(true);
            return true;
        };

        node.onMouseMove = function (e, pos) {
            const h = ctl.hitAt(pos);
            const id = h ? h.id : null;
            const cv = app.canvas?.canvas;
            if (id !== ctl.hover) {
                ctl.hover = id;
                app.graph?.setDirtyCanvas(true, false);
                if (cv) cv.style.cursor = h ? "pointer" : "";
            }
        };

        node.onMouseLeave = function () {
            ctl.hover = null;
            const cv = app.canvas?.canvas;
            if (cv) cv.style.cursor = "";
        };

        const prevRemoved = node.onRemoved;
        node.onRemoved = function () {
            controllers.delete(ctl);
            prevRemoved?.apply(this, arguments);
        };
    },
});
