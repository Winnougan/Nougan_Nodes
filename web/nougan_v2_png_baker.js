// web/nougan_v2_png_baker.js
// Holographic trading-card preview for "Nougan V2 PNG Baker" and "Nougan Refmod Baker".
// Both nodes send the same card_preview / card_info; the refmod baker adds an info.refmod block
// (hybrid or character-only, tensor count, file size, saved path) that changes a few labels.
//
//  • 3D tilt that follows the mouse, with a rainbow foil sheen + glare
//  • Rarity tiers (common / rare / epic / legendary) from the card's size, just for fun
//  • Bake animation: forge glow while running, then shockwave + ember burst + "BAKED" stamp
//  • Click the card (or the Flip button) to see the back: description + first message
//  • Floating ember particles, typewriter name, staggered tag chips, animated meters
//  • Respects "reduce motion" (prefers-reduced-motion) and pauses when off-screen
//
// Keep this file directly inside web/ so the relative imports resolve.

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// Per-node wording. Everything else (tilt, foil, rarity, stamp) is shared.
const NODES = {
  NouganV2PNGBaker: {
    widget: "nougan_v2_card",
    icon: "🃏",
    idleText: "Connect an image and your<br>card JSON, then press Run",
    ready: "Ready. Connect an image + json_text.",
    dlLabel: "⬇ Download PNG",
  },
  NouganRefmodBaker: {
    widget: "nougan_refmod_card",
    icon: "🧬",
    idleText: "Connect an avatar and your<br>card JSON, then press Run",
    ready: "Ready. Connect an avatar + json_text (and pick a base refmod, or leave it on none).",
    dlLabel: "⬇ Avatar PNG",
  },
};
const CARD_H = 462;
const MIN_W = 330; // the card is laid out for this width; the node is never allowed to be narrower
const REDUCED = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

const RARITY = {
  common:    { label: "COMMON",    c1: "#94a3b8", c2: "#cbd5e1", foil: 0.18, embers: [148, 163, 184] },
  rare:      { label: "RARE",      c1: "#38bdf8", c2: "#818cf8", foil: 0.32, embers: [56, 189, 248] },
  epic:      { label: "EPIC",      c1: "#a78bfa", c2: "#f472b6", foil: 0.5,  embers: [192, 132, 252] },
  legendary: { label: "LEGENDARY", c1: "#fbbf24", c2: "#f472b6", foil: 0.75, embers: [251, 191, 36] },
};

// ───────────────────────────────────────────────────────────────── styles ──

const CSS = `
.nv2-root{position:relative;box-sizing:border-box;width:100%;height:${CARD_H}px;overflow:hidden;border-radius:14px;
  background:radial-gradient(120% 90% at 50% 0%,#1b1536 0%,#0b0d16 60%,#07080e 100%);
  font:12px/1.35 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#e5e7eb;user-select:none;
  --c1:#94a3b8;--c2:#cbd5e1;--foil:.18;--rx:0deg;--ry:0deg;--mx:50%;--my:50%;--hyp:0}
.nv2-root[data-rarity=rare]{--c1:#38bdf8;--c2:#818cf8;--foil:.32}
.nv2-root[data-rarity=epic]{--c1:#a78bfa;--c2:#f472b6;--foil:.5}
.nv2-root[data-rarity=legendary]{--c1:#fbbf24;--c2:#f472b6;--foil:.75}
.nv2-fx{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:3}

.nv2-stage{position:absolute;left:0;right:0;top:10px;bottom:76px;display:flex;align-items:center;justify-content:center;perspective:900px}
.nv2-float{width:min(86%,296px);aspect-ratio:5/7;max-height:100%;animation:nv2-float 5s ease-in-out infinite}
@keyframes nv2-float{50%{transform:translateY(-5px)}}
.nv2-card{position:relative;width:100%;height:100%;transform-style:preserve-3d;
  transform:rotateX(var(--rx)) rotateY(var(--ry));will-change:transform;border-radius:16px;
  filter:drop-shadow(0 14px 22px rgba(0,0,0,.55))}
.nv2-inner{position:relative;width:100%;height:100%;transform-style:preserve-3d;transition:transform .7s cubic-bezier(.3,1.3,.4,1)}
.nv2-root[data-flipped=true] .nv2-inner{transform:rotateY(180deg)}
.nv2-face{position:absolute;inset:0;border-radius:16px;backface-visibility:hidden;-webkit-backface-visibility:hidden;overflow:hidden;
  background:linear-gradient(145deg,var(--c1),var(--c2));padding:5px;box-sizing:border-box}
.nv2-back{transform:rotateY(180deg)}
.nv2-frame{position:relative;width:100%;height:100%;border-radius:12px;background:linear-gradient(180deg,#14172a,#0c0e1a);
  display:flex;flex-direction:column;padding:8px;box-sizing:border-box;gap:6px;overflow:hidden}

.nv2-head{display:flex;align-items:center;justify-content:space-between;gap:6px;min-height:20px}
.nv2-name{font-weight:800;font-size:14px;letter-spacing:.2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  background:linear-gradient(90deg,#fff,var(--c2));-webkit-background-clip:text;background-clip:text;color:transparent}
.nv2-name.typing::after{content:"▍";margin-left:1px;animation:nv2-blink .7s steps(1) infinite;-webkit-text-fill-color:var(--c2)}
@keyframes nv2-blink{50%{opacity:0}}
.nv2-gem{flex:0 0 auto;font-size:9px;font-weight:800;letter-spacing:.9px;padding:2px 7px;border-radius:999px;color:#0b0d16;
  background:linear-gradient(135deg,var(--c1),var(--c2));box-shadow:0 0 10px color-mix(in srgb,var(--c1) 60%,transparent)}

.nv2-art{position:relative;flex:1 1 auto;min-height:0;border-radius:9px;overflow:hidden;background:#07080e;
  box-shadow:inset 0 0 0 1px rgba(255,255,255,.12),0 0 0 1px color-mix(in srgb,var(--c1) 55%,transparent)}
.nv2-art img{position:absolute;inset:-6%;width:112%;height:112%;object-fit:cover;object-position:50% 20%;
  transform:translate(calc(var(--ry) * -.9),calc(var(--rx) * .9));transition:opacity .5s}
.nv2-art img.nv2-hide{opacity:0}
.nv2-idle{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;color:#8b93a7;text-align:center;padding:10px;
  background:repeating-linear-gradient(135deg,rgba(255,255,255,.025) 0 10px,transparent 10px 20px)}
.nv2-idle b{font-size:34px;animation:nv2-pulse 2.2s ease-in-out infinite;filter:drop-shadow(0 0 12px var(--c1))}
@keyframes nv2-pulse{50%{transform:scale(1.12);opacity:.75}}
.nv2-root:not([data-state=idle]) .nv2-idle{display:none}

.nv2-tags{display:flex;flex-wrap:wrap;gap:4px;max-height:38px;overflow:hidden}
.nv2-tag{font-size:10px;padding:1px 7px;border-radius:999px;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.12);
  opacity:0;transform:translateY(6px) scale(.9);animation:nv2-chip .35s ease forwards}
@keyframes nv2-chip{to{opacity:1;transform:none}}

.nv2-meters{display:grid;gap:3px}
.nv2-m{display:grid;grid-template-columns:52px 1fr 34px;align-items:center;gap:6px;font-size:9.5px;color:#9ca3af;font-variant-numeric:tabular-nums}
.nv2-m i{display:block;height:5px;border-radius:3px;background:rgba(255,255,255,.08);overflow:hidden}
.nv2-m i::before{content:"";display:block;height:100%;width:var(--w,0%);border-radius:3px;
  background:linear-gradient(90deg,var(--c1),var(--c2));transition:width .9s cubic-bezier(.2,.8,.2,1) .25s}
.nv2-m span:last-child{text-align:right}
.nv2-foot{display:flex;justify-content:space-between;gap:8px;font-size:10px;color:#8b93a7;white-space:nowrap}
.nv2-foot span{overflow:hidden;text-overflow:ellipsis}

.nv2-foil,.nv2-glare{position:absolute;inset:0;border-radius:16px;pointer-events:none}
.nv2-foil{mix-blend-mode:color-dodge;opacity:calc(var(--foil) * (.35 + var(--hyp) * .9));
  background:linear-gradient(115deg,transparent 15%,#ff5ecb 30%,#ffd35e 38%,#5effa6 46%,#5ec8ff 54%,#a45eff 62%,transparent 78%);
  background-size:260% 260%;background-position:calc(var(--mx) * 1.2) calc(var(--my) * 1.2);transition:opacity .25s}
.nv2-glare{background:radial-gradient(circle at var(--mx) var(--my),rgba(255,255,255,.42),transparent 48%);
  mix-blend-mode:overlay;opacity:calc(.25 + var(--hyp) * .75)}
.nv2-root[data-state=idle] .nv2-foil{opacity:calc(var(--foil) * .25)}

.nv2-stamp{position:absolute;left:50%;top:44%;padding:6px 16px;border:3px solid #34d399;border-radius:8px;color:#34d399;font-weight:900;
  font-size:26px;letter-spacing:3px;background:rgba(6,20,14,.35);backdrop-filter:blur(2px);opacity:0;pointer-events:none;
  transform:translate(-50%,-50%) rotate(-14deg) scale(2.4);text-shadow:0 0 14px rgba(52,211,153,.7)}
.nv2-root[data-stamp=on] .nv2-stamp{animation:nv2-stamp 2.4s cubic-bezier(.2,1.4,.4,1) forwards}
@keyframes nv2-stamp{0%{opacity:0;transform:translate(-50%,-50%) rotate(-14deg) scale(2.4)}
  14%{opacity:1;transform:translate(-50%,-50%) rotate(-14deg) scale(.92)}
  20%{transform:translate(-50%,-50%) rotate(-14deg) scale(1.04)}
  26%{transform:translate(-50%,-50%) rotate(-14deg) scale(1)}
  78%{opacity:1}100%{opacity:0;transform:translate(-50%,-50%) rotate(-14deg) scale(1)}}
.nv2-ring{position:absolute;left:50%;top:50%;width:40px;height:40px;margin:-20px;border-radius:50%;pointer-events:none;opacity:0;
  border:3px solid var(--c1);box-shadow:0 0 30px var(--c1),inset 0 0 30px var(--c1)}
.nv2-root[data-stamp=on] .nv2-ring{animation:nv2-ring 1.1s ease-out forwards}
@keyframes nv2-ring{0%{opacity:.95;transform:scale(.4)}100%{opacity:0;transform:scale(11)}}

.nv2-root[data-state=baking] .nv2-card{animation:nv2-forge 1s ease-in-out infinite}
@keyframes nv2-forge{50%{filter:drop-shadow(0 0 22px #fb923c) drop-shadow(0 14px 22px rgba(0,0,0,.55)) brightness(1.18) saturate(1.2)}}
.nv2-root[data-landing=on] .nv2-card{animation:nv2-land .8s cubic-bezier(.2,1.2,.3,1)}
@keyframes nv2-land{0%{transform:rotateX(var(--rx)) rotateY(var(--ry)) scale(1.28) translateY(-24px);filter:blur(6px) brightness(1.8)}
  100%{transform:rotateX(var(--rx)) rotateY(var(--ry)) scale(1);filter:drop-shadow(0 14px 22px rgba(0,0,0,.55))}}

.nv2-back .nv2-frame{gap:8px;padding:10px 11px}
.nv2-back h4{margin:0;font-size:10px;letter-spacing:1.3px;color:var(--c2);font-weight:800}
.nv2-back p{margin:0;font-size:11px;line-height:1.45;color:#cbd2e1;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:7;overflow:hidden}
.nv2-back .nv2-pills{display:flex;gap:5px;flex-wrap:wrap;margin-top:auto}
.nv2-back .nv2-pills span{font-size:10px;padding:2px 8px;border-radius:999px;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.12)}

.nv2-btns{position:absolute;left:10px;right:10px;bottom:30px;display:flex;gap:6px;z-index:4}
.nv2-btn{flex:1 1 0;height:28px;border-radius:9px;cursor:pointer;display:flex;align-items:center;justify-content:center;text-decoration:none;
  font:600 11.5px system-ui,sans-serif;color:#e5e7eb;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.12);
  transition:transform .12s,background .15s,opacity .15s}
.nv2-btn:hover:not([aria-disabled=true]){background:rgba(255,255,255,.15);transform:translateY(-1px)}
.nv2-btn[aria-disabled=true]{opacity:.38;cursor:not-allowed;pointer-events:none}
.nv2-status{position:absolute;left:10px;right:10px;bottom:8px;font-size:11px;color:#8b93a7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;z-index:4}
.nv2-status[data-tone=ok]{color:#34d399}.nv2-status[data-tone=warn]{color:#fbbf24}.nv2-status[data-tone=err]{color:#f87171}
@media (prefers-reduced-motion:reduce){.nv2-float,.nv2-idle b{animation:none!important}.nv2-inner{transition:none}}
`;

function injectCSS() {
  if (document.getElementById("nv2-style")) return;
  const el = document.createElement("style");
  el.id = "nv2-style";
  el.textContent = CSS;
  document.head.appendChild(el);
}

const viewURL = (p) =>
  api.apiURL(`/view?${new URLSearchParams({ filename: p.filename, subfolder: p.subfolder || "", type: p.type || "output" })}`);

const fmtK = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));

const fmtBytes = (n) => {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
};

// ──────────────────────────────────────────────────────────── controller ──

class BakerCard {
  constructor(node, cfg) {
    this.node = node;
    this.cfg = cfg;
    this.visible = true;
    this.raf = 0;
    this.last = 0;
    this.particles = [];
    this.tgt = { rx: 0, ry: 0, mx: 50, my: 50, hyp: 0 };
    this.cur = { rx: 0, ry: 0, mx: 50, my: 50, hyp: 0 };
    this.hover = false;
    this.rarity = "common";
    this.typeTimer = 0;
    this.lastBake = null;
    this.build();
  }

  build() {
    const root = (this.root = document.createElement("div"));
    root.className = "nv2-root";
    root.dataset.state = "idle";
    root.dataset.rarity = "common";
    root.dataset.flipped = "false";
    root.innerHTML = `
      <canvas class="nv2-fx"></canvas>
      <div class="nv2-stage"><div class="nv2-float"><div class="nv2-card" data-k="card"><div class="nv2-inner">
        <div class="nv2-face nv2-front">
          <div class="nv2-frame">
            <div class="nv2-head"><span class="nv2-name" data-k="name">Awaiting bake</span><span class="nv2-gem" data-k="gem">COMMON</span></div>
            <div class="nv2-art">
              <img data-k="img" class="nv2-hide" alt="" draggable="false">
              <div class="nv2-idle"><b>${this.cfg.icon}</b><span>${this.cfg.idleText}</span></div>
            </div>
            <div class="nv2-tags" data-k="tags"></div>
            <div class="nv2-meters">
              <div class="nv2-m"><span>Description</span><i data-k="m0"></i><span data-k="v0">–</span></div>
              <div class="nv2-m"><span>Greeting</span><i data-k="m1"></i><span data-k="v1">–</span></div>
              <div class="nv2-m"><span>Examples</span><i data-k="m2"></i><span data-k="v2">–</span></div>
            </div>
            <div class="nv2-foot"><span data-k="creator">by —</span><span data-k="meta">V2</span></div>
          </div>
          <div class="nv2-foil"></div><div class="nv2-glare"></div>
          <div class="nv2-ring"></div><div class="nv2-stamp">BAKED ✓</div>
        </div>
        <div class="nv2-face nv2-back">
          <div class="nv2-frame">
            <h4>DESCRIPTION</h4><p data-k="bdesc">—</p>
            <h4>FIRST MESSAGE</h4><p data-k="bmes">—</p>
            <div class="nv2-pills" data-k="pills"></div>
          </div>
          <div class="nv2-foil"></div><div class="nv2-glare"></div>
        </div>
      </div></div></div></div>
      <div class="nv2-btns">
        <div class="nv2-btn" data-k="flip" role="button" aria-disabled="true">↻ Flip card</div>
        <a class="nv2-btn" data-k="dl" aria-disabled="true">${this.cfg.dlLabel}</a>
      </div>
      <div class="nv2-status" data-k="status">${this.cfg.ready}</div>`;

    const q = (n) => root.querySelector(`[data-k="${n}"]`);
    this.q = q;
    this.fx = root.querySelector(".nv2-fx");
    this.cardEl = q("card");

    // interactions
    root.addEventListener("pointermove", (e) => this.onMove(e));
    root.addEventListener("pointerleave", () => this.onLeave());
    root.addEventListener("pointerenter", () => { this.hover = true; this.ensureLoop(); });
    for (const ev of ["pointerdown", "dblclick", "contextmenu"]) root.addEventListener(ev, (e) => e.stopPropagation());
    this.cardEl.addEventListener("click", () => this.flip());
    q("flip").addEventListener("click", () => this.flip());

    new ResizeObserver(() => this.sizeCanvas()).observe(root);
    if ("IntersectionObserver" in window) {
      new IntersectionObserver((es) => {
        this.visible = es[0]?.isIntersecting ?? true;
        if (this.visible) this.ensureLoop();
      }).observe(root);
    }

    const w = this.node.addDOMWidget(this.cfg.widget, this.cfg.widget, root, {
      serialize: false, hideOnZoom: false, getMinHeight: () => CARD_H,
    });
    w.computeSize = (width) => [width, CARD_H];

    this.seedAmbient();
    this.ensureLoop();
  }

  // ── tilt ──────────────────────────────────────────────────────────────
  onMove(e) {
    if (REDUCED) return;
    const r = this.cardEl.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height;
    const nx = Math.max(-1, Math.min(1.4, px * 2 - 1)), ny = Math.max(-1, Math.min(1.4, py * 2 - 1));
    this.tgt = {
      ry: nx * 14, rx: -ny * 12,
      mx: Math.max(0, Math.min(100, px * 100)), my: Math.max(0, Math.min(100, py * 100)),
      hyp: Math.min(1, Math.hypot(nx, ny) / 1.2),
    };
    this.hover = true;
    this.ensureLoop();
  }
  onLeave() {
    this.tgt = { rx: 0, ry: 0, mx: 50, my: 50, hyp: 0 };
  }

  flip() {
    if (this.root.dataset.state === "idle") return;
    this.root.dataset.flipped = this.root.dataset.flipped === "true" ? "false" : "true";
  }

  // ── particles ─────────────────────────────────────────────────────────
  sizeCanvas() {
    const c = this.fx, dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.root.clientWidth, h = this.root.clientHeight;
    if (!w || !h) return;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    this.dpr = dpr; this.W = w; this.H = h;
  }

  seedAmbient() {
    this.particles = [];
    if (REDUCED) return;
    for (let i = 0; i < 26; i++) this.particles.push(this.ember(true));
  }

  ember(randomY = false) {
    const W = this.W || 300, H = this.H || CARD_H;
    return {
      x: Math.random() * W, y: randomY ? Math.random() * H : H + 10,
      vx: (Math.random() - 0.5) * 0.25, vy: -(0.15 + Math.random() * 0.45),
      r: 0.6 + Math.random() * 1.6, life: 1, decay: 0, a: 0.25 + Math.random() * 0.5,
      ph: Math.random() * 6.28, ambient: true,
    };
  }

  burst() {
    if (REDUCED) return;
    this.sizeCanvas();
    const W = this.W || 300, H = this.H || CARD_H;
    const cx = W / 2, cy = (H - 76) / 2 + 10;
    const n = 110;
    for (let i = 0; i < n; i++) {
      const ang = Math.random() * Math.PI * 2, sp = 1.5 + Math.random() * 6.5;
      this.particles.push({
        x: cx, y: cy, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp - 1.2,
        r: 1 + Math.random() * 2.6, life: 1, decay: 0.012 + Math.random() * 0.016,
        a: 1, ph: 0, ambient: false, g: 0.07 + Math.random() * 0.06,
      });
    }
    this.ensureLoop();
  }

  ensureLoop() {
    if (this.raf || !this.visible || document.hidden) return;
    this.last = 0;
    this.raf = requestAnimationFrame((t) => this.tick(t));
  }

  tick(t) {
    this.raf = 0;
    if (!this.visible || document.hidden || !this.root.isConnected) return;
    if (t - this.last >= 30) { // ~33fps is plenty and keeps the graph responsive
      this.last = t;
      this.step(t);
    }
    const settled = this.settled() && !this.particles.length;
    // ambient embers keep the loop alive; stop only for reduced motion
    if (!REDUCED || !settled) this.raf = requestAnimationFrame((tt) => this.tick(tt));
  }

  settled() {
    const c = this.cur, g = this.tgt;
    return Math.abs(c.rx - g.rx) < 0.05 && Math.abs(c.ry - g.ry) < 0.05 && Math.abs(c.hyp - g.hyp) < 0.01;
  }

  step(t) {
    // smooth the tilt toward its target
    const k = 0.16, c = this.cur, g = this.tgt;
    for (const key of ["rx", "ry", "mx", "my", "hyp"]) c[key] += (g[key] - c[key]) * k;
    const s = this.cardEl.style;
    s.setProperty("--rx", `${c.rx.toFixed(2)}deg`);
    s.setProperty("--ry", `${c.ry.toFixed(2)}deg`);
    this.root.style.setProperty("--rx", `${c.rx.toFixed(2)}deg`);
    this.root.style.setProperty("--ry", `${c.ry.toFixed(2)}deg`);
    for (const f of this.root.querySelectorAll(".nv2-foil,.nv2-glare")) {
      f.style.setProperty("--mx", `${c.mx.toFixed(1)}%`);
      f.style.setProperty("--my", `${c.my.toFixed(1)}%`);
      f.style.setProperty("--hyp", c.hyp.toFixed(3));
    }

    // embers
    this.sizeCanvas();
    const ctx = this.fx.getContext("2d");
    if (!ctx || !this.W) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.W, this.H);
    ctx.globalCompositeOperation = "lighter";
    const [er, eg, eb] = (RARITY[this.rarity] || RARITY.common).embers;
    const baking = this.root.dataset.state === "baking";
    const next = [];
    for (const p of this.particles) {
      if (p.ambient) {
        p.ph += 0.04;
        p.x += p.vx + Math.sin(p.ph) * 0.25;
        p.y += p.vy * (baking ? 2.4 : 1);
        if (p.y < -10) Object.assign(p, this.ember());
        const col = baking ? [251, 146, 60] : [er, eg, eb];
        ctx.fillStyle = `rgba(${col[0]},${col[1]},${col[2]},${p.a * (0.55 + 0.45 * Math.sin(p.ph * 1.7))})`;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.283); ctx.fill();
        next.push(p);
      } else {
        p.vy += p.g; p.vx *= 0.985; p.x += p.vx; p.y += p.vy; p.life -= p.decay;
        if (p.life <= 0) continue;
        ctx.fillStyle = `rgba(${er},${eg},${eb},${p.life * p.a})`;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r * (0.4 + p.life), 0, 6.283); ctx.fill();
        next.push(p);
      }
    }
    this.particles = next;
    ctx.globalCompositeOperation = "source-over";
  }

  // ── state ─────────────────────────────────────────────────────────────
  setStatus(text, tone = "") {
    const el = this.q("status");
    el.textContent = text; el.dataset.tone = tone; el.title = text;
  }

  setBaking(on) {
    if (on) {
      this.root.dataset.state = "baking";
      this.setStatus("🔥 Baking…", "warn");
    } else if (this.root.dataset.state === "baking") {
      this.root.dataset.state = this.lastBake ? "ready" : "idle";
    }
  }

  typewrite(text) {
    clearInterval(this.typeTimer);
    const el = this.q("name");
    if (REDUCED) { el.textContent = text; return; }
    el.textContent = "";
    el.classList.add("typing");
    let i = 0;
    this.typeTimer = setInterval(() => {
      el.textContent = text.slice(0, ++i);
      if (i >= text.length) { clearInterval(this.typeTimer); el.classList.remove("typing"); }
    }, Math.max(18, Math.min(55, 700 / Math.max(1, text.length))));
  }

  showBake(previews, info, { animate = true } = {}) {
    const first = previews?.[0];
    if (!first || !info) return;
    this.lastBake = { previews, info };
    this.rarity = RARITY[info.rarity] ? info.rarity : "common";
    const r = RARITY[this.rarity];
    this.root.dataset.rarity = this.rarity;
    this.root.dataset.state = "ready";
    this.root.dataset.flipped = "false";

    // art
    const img = this.q("img");
    const url = viewURL(first);
    const pre = new Image();
    pre.onload = () => { img.src = url; img.classList.remove("nv2-hide"); };
    pre.src = url;

    // front
    this.q("gem").textContent = r.label;
    this.q("gem").title = `Rarity is just for fun: based on ~${info.tokens} estimated tokens`;
    animate ? this.typewrite(info.name) : (this.q("name").textContent = info.name);
    this.q("creator").textContent = info.creator ? `by ${info.creator}` : "by unknown";
    const extra = previews.length > 1 ? ` · ×${previews.length}` : "";
    const rm = info.refmod; // only present for the Refmod Baker
    this.q("meta").textContent = rm
      ? `refmod · ${rm.kind} · ${fmtBytes(rm.bytes)}`
      : `V${info.spec_version || "2.0"} · ~${fmtK(info.tokens)} tok · ${info.kb} KB${extra}`;
    this.q("meta").title = rm ? (rm.base ? `Embedded into a copy of ${rm.base}` : "Character-only file (no tensors)") : "";

    const tags = this.q("tags");
    tags.textContent = "";
    (info.tags || []).forEach((t, i) => {
      const s = document.createElement("span");
      s.className = "nv2-tag";
      s.style.animationDelay = `${animate ? 250 + i * 55 : 0}ms`;
      s.textContent = t;
      tags.appendChild(s);
    });

    const ch = info.chars || {};
    const meters = [[ch.description, 3000], [ch.first_mes, 2000], [ch.mes_example, 1500]];
    meters.forEach(([v, max], i) => {
      const bar = this.q(`m${i}`);
      bar.style.setProperty("--w", "0%");
      this.q(`v${i}`).textContent = v == null ? "–" : fmtK(v);
      const w = `${Math.max(v ? 4 : 0, Math.min(100, ((v || 0) / max) * 100)).toFixed(0)}%`;
      if (animate) { void bar.offsetWidth; requestAnimationFrame(() => bar.style.setProperty("--w", w)); }
      else bar.style.setProperty("--w", w);
    });

    // back
    this.q("bdesc").textContent = info.excerpt_description || "Run again to load the text preview.";
    this.q("bmes").textContent = info.excerpt_first_mes || "Run again to load the text preview.";
    const pills = this.q("pills");
    pills.textContent = "";
    for (const txt of [
      ...(rm ? [rm.tensors ? `${rm.tensors} tensor${rm.tensors === 1 ? "" : "s"} kept` : "no tensors"] : []),
      `${info.alt_greetings || 0} alt greeting${info.alt_greetings === 1 ? "" : "s"}`,
      `${info.book_entries || 0} lorebook entr${info.book_entries === 1 ? "y" : "ies"}`,
      `~${info.tokens} tokens`,
    ]) {
      const s = document.createElement("span"); s.textContent = txt; pills.appendChild(s);
    }

    // buttons
    const flip = this.q("flip"), dl = this.q("dl");
    flip.setAttribute("aria-disabled", "false");
    dl.setAttribute("aria-disabled", "false");
    dl.href = url; dl.download = rm ? `${info.name || "avatar"}.png` : first.filename;

    // for a refmod the saved file is the .safetensors, not the preview image
    const where = rm?.saved || (first.subfolder ? `${first.subfolder}/${first.filename}` : first.filename);
    this.setStatus(`✓ Saved ${where}`, "ok");
    if ((info.notes || []).length) this.setStatus(`✓ Saved ${where}  ·  ℹ ${info.notes[0]}`, "ok");

    if (animate) {
      const rt = this.root;
      rt.dataset.landing = "off"; rt.dataset.stamp = "off";
      void rt.offsetWidth;
      rt.dataset.landing = "on"; rt.dataset.stamp = "on";
      setTimeout(() => { rt.dataset.landing = "off"; }, 900);
      setTimeout(() => { rt.dataset.stamp = "off"; }, 2500);
      this.burst();
    }
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    clearInterval(this.typeTimer);
  }
}

// ──────────────────────────────────────────────────────────── extension ──

const cards = new Set();
const sameNode = (evtNode, node) => {
  if (evtNode == null) return false;
  const a = String(evtNode), b = String(node.id);
  return a === b || a.split(":").pop() === b;
};

app.registerExtension({
  name: "nougan.v2PngBaker",

  setup() {
    injectCSS();
    api.addEventListener("executing", (e) => {
      const d = e.detail;
      const nodeId = d && typeof d === "object" ? d.node : d;
      for (const c of cards) {
        if (sameNode(nodeId, c.node)) c.setBaking(true);
        else if (c.root.dataset.state === "baking") c.setBaking(false);
      }
    });
    for (const ev of ["execution_error", "execution_interrupted"]) {
      api.addEventListener(ev, () => {
        for (const c of cards) {
          if (c.root.dataset.state === "baking") { c.setBaking(false); c.setStatus(ev === "execution_error" ? "Bake failed. See the red error on the node." : "Interrupted.", "err"); }
        }
      });
    }
  },

  async beforeRegisterNodeDef(nodeType, nodeData) {
    const cfg = NODES[nodeData?.name];
    if (!cfg) return;

    // Enforce MIN_W as the node's minimum width. Setting it once on creation isn't enough: a saved
    // workflow (or a manual resize) could leave the node narrower than the card, which then spills
    // out past the node's right edge.
    const baseCompute = nodeType.prototype.computeSize;
    nodeType.prototype.computeSize = function () {
      const size = baseCompute ? baseCompute.apply(this, arguments) : [MIN_W, CARD_H];
      size[0] = Math.max(size[0], MIN_W);
      return size;
    };

    const onResize = nodeType.prototype.onResize;
    nodeType.prototype.onResize = function (size) {
      if (size && size[0] < MIN_W) size[0] = MIN_W;
      return onResize?.apply(this, arguments);
    };

    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onCreated?.apply(this, arguments);
      injectCSS();
      const card = new BakerCard(this, cfg);
      this.__nv2 = card;
      cards.add(card);
      this.setSize([Math.max(this.size[0], MIN_W), Math.max(this.size[1], this.computeSize()[1])]);
      return r;
    };

    const onExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      const r = onExecuted?.apply(this, arguments);
      const info = message?.card_info?.[0], previews = message?.card_preview;
      if (info && previews?.length) {
        this.__nv2?.showBake(previews, info, { animate: true });
        // remember the last bake with the workflow (no text excerpts, so shared workflows don't leak card text)
        const { excerpt_description, excerpt_first_mes, ...slim } = info;
        this.properties = this.properties || {};
        this.properties.nv2_last_bake = { previews, info: slim };
      }
      return r;
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const r = onConfigure?.apply(this, arguments);
      // workflows saved with a narrower node (or by an older version) would otherwise reload too small
      if (this.size[0] < MIN_W) this.setSize([MIN_W, Math.max(this.size[1], this.computeSize()[1])]);
      const saved = this.properties?.nv2_last_bake;
      if (saved?.previews?.length && saved.info) {
        setTimeout(() => this.__nv2?.showBake(saved.previews, saved.info, { animate: false }), 250);
      }
      return r;
    };

    const onRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      if (this.__nv2) { this.__nv2.destroy(); cards.delete(this.__nv2); }
      return onRemoved?.apply(this, arguments);
    };
  },
});
