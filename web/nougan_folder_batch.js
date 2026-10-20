// web/nougan_folder_batch.js
// Nougan folder batch loaders: preview card, progress, Run / Stop, auto-chaining.
//
// How it fits together
//   Python  : each time the loader runs it reports { batch_info:[idx,total],
//             auto_run:[0|1], next_index:[n|-1], preview:[{...}] }.
//             `next_index` is only >= 0 when auto_run_folder is ON.
//   This file: when it sees next_index >= 0 it sets the index widget and queues
//             the next prompt, so one Run walks the whole folder. It tracks every
//             prompt by id for progress, ETA and a clean Stop.
//
// IMPORTANT: keep this file directly inside web/ (not a sub-folder) so the
// relative imports below resolve.

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const EXT_NAME = "nougan.folderBatch";
const KINDS = { FolderImageBatchLoader: "image", FolderVideoBatchLoader: "video" };
const CARD_H = 352;

const S = { PENDING: 0, RUNNING: 1, DONE: 2, ERROR: 3 };

const controllers = new Set();
let lastStartedId = null;

// ───────────────────────────────────────────────────────────────── styles ──

const CSS = `
.nfb-card{box-sizing:border-box;width:100%;padding:6px 4px 2px;display:flex;flex-direction:column;gap:8px;
  font:12px/1.35 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#e5e7eb;user-select:none;
  --a:#8b5cf6;--b:#22d3ee;--ok:#34d399;--err:#f87171;--warn:#fbbf24}
.nfb-card[data-state=done]{--a:#10b981;--b:#34d399}
.nfb-card[data-state=error]{--a:#ef4444;--b:#f97316}
.nfb-card[data-state=stopped]{--a:#f59e0b;--b:#fbbf24}

.nfb-thumb{position:relative;height:190px;border-radius:14px;overflow:hidden;background:#0a0c11;
  border:1px solid rgba(255,255,255,.09);box-shadow:0 8px 26px rgba(0,0,0,.5);transition:box-shadow .4s}
.nfb-card[data-state=running] .nfb-thumb{box-shadow:0 0 0 1px color-mix(in srgb,var(--a) 70%,transparent),0 0 30px color-mix(in srgb,var(--a) 38%,transparent);animation:nfb-glow 2.4s ease-in-out infinite}
@keyframes nfb-glow{50%{box-shadow:0 0 0 1px color-mix(in srgb,var(--b) 70%,transparent),0 0 38px color-mix(in srgb,var(--b) 38%,transparent)}}
.nfb-bg,.nfb-img{position:absolute;inset:0;width:100%;height:100%}
.nfb-bg{object-fit:cover;filter:blur(24px) saturate(1.4) brightness(.5);transform:scale(1.25);transition:opacity .4s}
.nfb-img{object-fit:contain;transition:opacity .22s ease,transform .22s ease}
.nfb-img.swap{opacity:0;transform:scale(.97)}
.nfb-empty{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;color:#6b7280}
.nfb-empty b{font-size:30px;filter:grayscale(.4);opacity:.7}
.nfb-fx{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}

.nfb-chip{position:absolute;top:8px;padding:3px 9px;border-radius:999px;font-weight:600;letter-spacing:.2px;
  background:rgba(10,12,17,.62);backdrop-filter:blur(8px);border:1px solid rgba(255,255,255,.12)}
.nfb-kind{left:8px;font-size:11px;opacity:.9}
.nfb-count{right:8px;font-variant-numeric:tabular-nums}
.nfb-count.pop{animation:nfb-pop .28s ease}
@keyframes nfb-pop{40%{transform:scale(1.14);border-color:var(--b)}}
.nfb-count i{font-style:normal;opacity:.55;margin:0 3px}
.nfb-cap{position:absolute;left:0;right:0;bottom:0;padding:22px 12px 9px;font-size:12px;font-weight:600;
  background:linear-gradient(to top,rgba(0,0,0,.78),transparent);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

.nfb-bar{position:relative;height:22px;border-radius:11px;overflow:hidden;background:rgba(255,255,255,.07);
  border:1px solid rgba(255,255,255,.07)}
.nfb-fill{position:absolute;inset:0 auto 0 0;width:0;border-radius:11px;transition:width .45s cubic-bezier(.2,.8,.2,1);
  background:linear-gradient(90deg,var(--a),var(--b));overflow:hidden}
.nfb-card[data-state=running] .nfb-fill::after{content:"";position:absolute;inset:0;
  background:linear-gradient(110deg,transparent 30%,rgba(255,255,255,.45) 50%,transparent 70%);
  transform:translateX(-100%);animation:nfb-shimmer 1.5s linear infinite}
@keyframes nfb-shimmer{to{transform:translateX(100%)}}
.nfb-pct{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-weight:700;
  font-variant-numeric:tabular-nums;text-shadow:0 1px 3px rgba(0,0,0,.6)}
.nfb-sub{height:3px;margin-top:-4px;border-radius:2px;background:rgba(255,255,255,.05);overflow:hidden}
.nfb-subfill{height:100%;width:0;background:var(--b);opacity:.85;transition:width .25s linear}

.nfb-stats{display:flex;justify-content:space-between;color:#9ca3af;font-variant-numeric:tabular-nums}
.nfb-map{width:100%;height:26px;display:block}

.nfb-btns{display:flex;gap:6px}
.nfb-btn{flex:0 0 auto;height:30px;padding:0 12px;border-radius:9px;cursor:pointer;color:#e5e7eb;font:600 12px system-ui,sans-serif;
  background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.1);transition:transform .12s,background .15s,opacity .15s,box-shadow .2s}
.nfb-btn:hover:not(:disabled){background:rgba(255,255,255,.14);transform:translateY(-1px)}
.nfb-btn:active:not(:disabled){transform:translateY(0) scale(.97)}
.nfb-btn:disabled{opacity:.38;cursor:not-allowed}
.nfb-btn.nfb-primary{flex:1 1 auto;border:0;color:#fff;background:linear-gradient(135deg,#8b5cf6,#22d3ee);
  box-shadow:0 4px 16px rgba(139,92,246,.35)}
.nfb-btn.nfb-primary:hover:not(:disabled){background:linear-gradient(135deg,#9b72ff,#4ddcf2);box-shadow:0 6px 22px rgba(34,211,238,.4)}
.nfb-btn.nfb-danger:not(:disabled){background:rgba(239,68,68,.18);border-color:rgba(239,68,68,.5);color:#fecaca}
.nfb-btn.nfb-icon{width:30px;padding:0;font-size:15px}
.nfb-status{min-height:16px;font-size:11.5px;color:#9ca3af;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.nfb-status[data-tone=ok]{color:var(--ok)}.nfb-status[data-tone=err]{color:var(--err)}.nfb-status[data-tone=warn]{color:var(--warn)}
`;

function injectCSS() {
  if (document.getElementById("nfb-style")) return;
  const el = document.createElement("style");
  el.id = "nfb-style";
  el.textContent = CSS;
  document.head.appendChild(el);
}

// ──────────────────────────────────────────────────────────────── helpers ──

const fmtTime = (s) => {
  if (!isFinite(s) || s < 0) return "–";
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
};

const previewURL = (p) =>
  api.apiURL(`/view?${new URLSearchParams({
    filename: p.filename, type: p.type || "temp", subfolder: p.subfolder || "",
  })}`);

const mix = (a, b, t) => Math.round(a + (b - a) * t);
// accent gradient used on the segment map (violet -> cyan); other states tint via hue shift
const GRADS = {
  running: [[139, 92, 246], [34, 211, 238]],
  done: [[16, 185, 129], [52, 211, 153]],
  error: [[239, 68, 68], [249, 115, 22]],
  stopped: [[245, 158, 11], [251, 191, 36]],
};

// ──────────────────────────────────────────────────────────── controller ──

class FolderBatchCard {
  constructor(node, kind) {
    this.node = node;
    this.kind = kind;
    this.total = 0;
    this.idx = 0;
    this.status = new Uint8Array(1);
    this.run = null;
    this.deadIds = new Set();
    this.curUrl = null;
    this.scanToken = 0;
    this.scanTimer = null;
    this.raf = 0;
    this.lastStatsAt = 0;
    this.build();
  }

  // ── DOM ───────────────────────────────────────────────────────────────
  build() {
    const k = this.kind;
    const root = (this.root = document.createElement("div"));
    root.className = "nfb-card";
    root.dataset.state = "idle";
    root.innerHTML = `
      <div class="nfb-thumb">
        <img class="nfb-bg" alt="" draggable="false">
        <img class="nfb-img" alt="" draggable="false">
        <div class="nfb-empty"><b>${k === "video" ? "🎞️" : "🖼️"}</b><span>Choose a folder to see a preview</span></div>
        <canvas class="nfb-fx"></canvas>
        <div class="nfb-chip nfb-kind">${k === "video" ? "🎞️ VIDEO BATCH" : "🖼️ IMAGE BATCH"}</div>
        <div class="nfb-chip nfb-count"><span data-k="idx">–</span><i>/</i><span data-k="total">–</span></div>
        <div class="nfb-cap" data-k="name">—</div>
      </div>
      <div class="nfb-bar"><div class="nfb-fill"></div><div class="nfb-pct" data-k="pct">0%</div></div>
      <div class="nfb-sub"><div class="nfb-subfill"></div></div>
      <div class="nfb-stats"><span data-k="speed">– /min</span><span data-k="eta">ETA –</span><span data-k="elapsed">0:00</span></div>
      <canvas class="nfb-map"></canvas>
      <div class="nfb-btns">
        <button class="nfb-btn nfb-primary" data-k="run"></button>
        <button class="nfb-btn nfb-danger" data-k="stop" disabled>■ Stop</button>
        <button class="nfb-btn nfb-icon" data-k="prev" title="Previous file">‹</button>
        <button class="nfb-btn nfb-icon" data-k="next" title="Next file">›</button>
        <button class="nfb-btn nfb-icon" data-k="refresh" title="Rescan folder">⟳</button>
      </div>
      <div class="nfb-status" data-k="status"></div>`;

    const q = (n) => root.querySelector(`[data-k="${n}"]`);
    this.q = q;
    this.imgEl = root.querySelector(".nfb-img");
    this.bgEl = root.querySelector(".nfb-bg");
    this.emptyEl = root.querySelector(".nfb-empty");
    this.fillEl = root.querySelector(".nfb-fill");
    this.subEl = root.querySelector(".nfb-subfill");
    this.countEl = root.querySelector(".nfb-count");
    this.mapC = root.querySelector(".nfb-map");
    this.fxC = root.querySelector(".nfb-fx");

    q("run").onclick = () => this.startManual();
    q("stop").onclick = () => this.stop();
    q("prev").onclick = () => this.step(-1);
    q("next").onclick = () => this.step(+1);
    q("refresh").onclick = () => this.scan();

    // stop the canvas from hijacking clicks/drags on the card
    for (const ev of ["pointerdown", "dblclick", "contextmenu"]) {
      root.addEventListener(ev, (e) => e.stopPropagation());
    }
    new ResizeObserver(() => this.drawMap()).observe(root);

    const w = this.node.addDOMWidget("nougan_batch_card", "nougan_batch_card", root, {
      serialize: false,            // never touches saved widgets_values
      hideOnZoom: false,
      getMinHeight: () => CARD_H,
    });
    w.computeSize = (width) => [width, CARD_H];
    this.widgetEl = w;

    this.updateRunLabel();
    this.render();
  }

  // ── widget access ─────────────────────────────────────────────────────
  widget(name) { return this.node.widgets?.find((w) => w.name === name); }
  val(name) { return this.widget(name)?.value; }
  setIndexWidget(v) {
    const w = this.widget("index");
    if (!w) return;
    w.value = Math.max(0, v | 0);
    this.node.setDirtyCanvas(true, true);
  }
  get running() { return !!this.run && this.run.state === "running"; }

  hookWidgets() {
    for (const name of ["folder_path", "sort_mode", "index", "auto_run_folder"]) {
      const w = this.widget(name);
      if (!w || w.__nfbHooked) continue;
      w.__nfbHooked = true;
      const orig = w.callback;
      w.callback = (...args) => {
        const r = orig?.apply(w, args);
        if (name === "auto_run_folder") this.updateRunLabel();
        if (!this.running) this.scanSoon();
        return r;
      };
    }
  }

  updateRunLabel() {
    const auto = !!this.val("auto_run_folder");
    this.q("run").textContent = auto ? "▶ Run whole folder" : `▶ Run this ${this.kind}`;
  }

  // ── preview / scan ────────────────────────────────────────────────────
  scanSoon() {
    clearTimeout(this.scanTimer);
    this.scanTimer = setTimeout(() => this.scan(), 350);
  }

  async scan() {
    const folder = String(this.val("folder_path") ?? "").trim();
    if (!folder) {
      this.total = 0;
      this.showEmpty(true);
      this.setStatus("Set folder_path to begin", "");
      this.render();
      return;
    }
    const token = ++this.scanToken;
    const qs = new URLSearchParams({
      folder, sort: this.val("sort_mode") ?? "", kind: this.kind, index: String(this.val("index") ?? 0),
    });
    try {
      const r = await api.fetchApi(`/nougan/folder_batch/scan?${qs}`);
      const j = await r.json();
      if (token !== this.scanToken) return;
      if (!j.ok) {
        this.total = 0;
        this.showEmpty(true);
        this.setStatus(j.error || "Scan failed", "err");
        this.render();
        return;
      }
      this.total = j.total;
      this.idx = j.index;
      this.ensureStatus(j.total);
      this.setCurrent(j.index, j.total, j.name, j.preview);
      if (!this.running) {
        const auto = !!this.val("auto_run_folder");
        if (auto && j.requested_index >= j.total) {
          this.setStatus(`Index ${j.requested_index} is past the last file (${j.total - 1}). Set index to 0.`, "warn");
        } else {
          this.setStatus(`${j.total} ${this.kind}s  ·  ${j.first}  →  ${j.last}`, "");
        }
      }
      this.render();
    } catch (e) {
      if (token === this.scanToken) this.setStatus(`Scan error: ${e.message || e}`, "err");
    }
  }

  step(d) {
    if (this.running || !this.total) return;
    const next = Math.min(this.total - 1, Math.max(0, (this.val("index") | 0) + d));
    this.setIndexWidget(next);
    this.scanSoon();
  }

  setCurrent(idx, total, name, preview) {
    this.idx = idx;
    this.total = total;
    const prevIdx = this.q("idx").textContent;
    this.q("idx").textContent = String(idx + 1);
    this.q("total").textContent = String(total);
    this.q("name").textContent = name || "—";
    this.q("name").title = name || "";
    if (prevIdx !== String(idx + 1)) {
      this.countEl.classList.remove("pop");
      void this.countEl.offsetWidth;
      this.countEl.classList.add("pop");
    }
    if (preview) this.setPreview(previewURL(preview));
    this.drawMap();
  }

  setPreview(url) {
    if (!url || url === this.curUrl) return;
    this.curUrl = url;
    const pre = new Image();
    pre.onload = () => {
      if (url !== this.curUrl) return;
      this.showEmpty(false);
      this.imgEl.classList.add("swap");
      setTimeout(() => {
        this.imgEl.src = url;
        this.bgEl.src = url;
        this.imgEl.classList.remove("swap");
      }, 150);
    };
    pre.onerror = () => {};
    pre.src = url;
  }

  showEmpty(on) {
    this.emptyEl.style.display = on ? "flex" : "none";
    if (on) {
      this.imgEl.removeAttribute("src");
      this.bgEl.removeAttribute("src");
      this.curUrl = null;
    }
  }

  setStatus(text, tone = "") {
    const el = this.q("status");
    el.textContent = text;
    el.dataset.tone = tone;
    el.title = text;
  }

  ensureStatus(total) {
    if (this.status.length !== Math.max(total, 1)) {
      const next = new Uint8Array(Math.max(total, 1));
      next.set(this.status.subarray(0, Math.min(this.status.length, next.length)));
      this.status = next;
    }
  }

  // ── run lifecycle ─────────────────────────────────────────────────────
  newRun({ startIndex, total, adopted, auto }) {
    this.deadIds.clear();
    this.status = new Uint8Array(Math.max(total || this.total || 1, 1));
    this.run = {
      state: "running", startIndex, total: total || this.total || 0, adopted, auto,
      ids: new Map(), pending: new Set(), reported: new Set(), finished: new Set(),
      startedAt: new Map(), queuedIdx: new Set([startIndex]),
      awaitingFirst: !adopted, chainEnded: false, stopping: false,
      t0: performance.now(), tEnd: 0, durEma: 0, done: 0, errors: 0, sub: 0,
    };
    this.root.dataset.state = "running";
    this.startLoop();
    return this.run;
  }

  expected() {
    const r = this.run;
    if (!r) return 0;
    return r.auto ? Math.max(1, r.total - r.startIndex) : 1;
  }

  async startManual() {
    if (this.running) return;
    const folderOk = String(this.val("folder_path") ?? "").trim();
    if (!folderOk) {
      this.setStatus("Set folder_path first", "warn");
      return;
    }
    const auto = !!this.val("auto_run_folder");
    const start = this.val("index") | 0;
    const run = this.newRun({ startIndex: start, total: this.total, adopted: false, auto });
    this.setStatus(auto ? "Queued · starting folder run…" : "Queued…", "");
    this.render();
    try {
      await app.queuePrompt(0, 1);
    } catch (e) {
      this.finish("error", `Could not queue: ${e?.message || e}`);
      return;
    }
    // if nothing starts at all (e.g. validation error), don't hang forever
    setTimeout(() => {
      if (this.run === run && run.state === "running" && !run.ids.size && !run.pending.size && run.awaitingFirst) {
        // still waiting after 20s with an empty queue -> give up quietly
        api.fetchApi("/queue").then((r) => r.json()).then((q) => {
          const busy = (q.queue_running?.length || 0) + (q.queue_pending?.length || 0);
          if (!busy && this.run === run && run.state === "running" && !run.ids.size) {
            this.finish("stopped", "Nothing started. Check the red error on the node.");
          }
        }).catch(() => {});
      }
    }, 20000);
  }

  // Called when our loader reports back from Python.
  onExecuted(msg) {
    const info = msg?.batch_info;
    if (!info) return;
    const [idx, total] = info;
    const auto = !!msg.auto_run?.[0];
    const next = msg.next_index?.[0] ?? -1;
    const name = msg.file_name?.[0];
    const prev = msg.preview?.[0];

    this.total = total;
    this.ensureStatus(total);
    this.setCurrent(idx, total, name, prev);

    if (!auto) {
      if (!this.running) this.setStatus(`Loaded ${name ?? "file"}  (single mode)`, "");
      // a manual single-mode run still resolves through execution_success
      if (this.running) this.noteLoader(idx, total, false, -1);
      this.render();
      return;
    }

    let run = this.run;
    const dead = lastStartedId && this.deadIds.has(lastStartedId);
    if (dead) return; // late loader from a prompt we already stopped
    if (!run || run.state !== "running") {
      run = this.newRun({ startIndex: idx, total, adopted: true, auto: true });
    }
    run.auto = true;
    this.noteLoader(idx, total, true, next);
    this.render();
  }

  noteLoader(idx, total, auto, next) {
    const run = this.run;
    if (!run) return;
    run.total = total;
    run.auto = auto;
    const pid = lastStartedId;
    if (pid) {
      run.ids.set(pid, idx);
      run.reported.add(pid);
      if (!run.startedAt.has(pid)) run.startedAt.set(pid, performance.now());
    }
    this.status[idx] = S.RUNNING;
    this.setStatus(`Processing ${this.q("name").textContent}`, "");
    if (next >= 0 && !run.stopping) this.queueAhead(run, next);
    else if (next < 0) run.chainEnded = true;
  }

  async queueAhead(run, next) {
    if (run.queuedIdx.has(next)) return; // dedupe (batch-count > 1, multiple tabs, etc.)
    run.queuedIdx.add(next);
    this.setIndexWidget(next);
    try {
      const p = await app.graphToPrompt();
      const res = await api.queuePrompt(0, p);
      if (res?.prompt_id) {
        if (run.stopping) {
          // Stop was pressed while this was being queued: cancel it right away
          this.deadIds.add(res.prompt_id);
          api.fetchApi("/queue", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ delete: [res.prompt_id] }),
          }).catch(() => {});
        } else {
          run.pending.add(res.prompt_id);
        }
      }
    } catch (e) {
      try {
        await app.queuePrompt(0, 1); // fallback shows ComfyUI's own error dialog if invalid
      } catch (e2) {
        this.finish("error", `Could not queue item ${next + 1}: ${e2?.message || e2}`);
      }
    }
  }

  // ── events from ComfyUI ───────────────────────────────────────────────
  onExecutionStart(pid) {
    const run = this.run;
    if (this.deadIds.has(pid)) {
      api.fetchApi("/interrupt", { method: "POST" }).catch(() => {});
      return;
    }
    if (!run || run.state !== "running") return;
    if (run.pending.has(pid)) run.pending.delete(pid);
    if (run.awaitingFirst && !run.ids.size) {
      run.ids.set(pid, run.startIndex);
      run.awaitingFirst = false;
    }
    run.runningId = pid;
    run.sub = 0;
    if (!run.startedAt.has(pid)) run.startedAt.set(pid, performance.now());
  }

  onProgress(pid, value, max) {
    const run = this.run;
    if (!run || run.state !== "running" || run.runningId !== pid || !max) return;
    run.sub = Math.max(run.sub, Math.min(1, value / max)); // monotonic so the bar never jumps back
  }

  onPromptEnd(pid) {
    const run = this.run;
    if (!run || run.state !== "running" || !run.ids.has(pid) || run.finished.has(pid)) return;
    run.finished.add(pid);
    const idx = run.ids.get(pid);
    this.status[idx] = S.DONE;
    run.done++;
    run.sub = 0;
    const t = run.startedAt.get(pid);
    if (t) {
      const d = (performance.now() - t) / 1000;
      run.durEma = run.durEma ? run.durEma * 0.7 + d * 0.3 : d;
    }
    // a prompt that finished without our loader reporting = loader was cached (single mode)
    if (!run.reported.has(pid)) run.chainEnded = true;
    this.maybeFinish();
    this.render();
  }

  onPromptError(pid, detail) {
    const run = this.run;
    if (!run || run.state !== "running" || !run.ids.has(pid)) return;
    const idx = run.ids.get(pid);
    this.status[idx] = S.ERROR;
    run.errors++;
    const where = detail?.node_type ? ` in ${detail.node_type}` : "";
    this.finish("error", `Failed on item ${idx + 1}${where}: ${detail?.exception_message?.split("\n")[0] || "see node error"}`);
  }

  onPromptInterrupted(pid) {
    const run = this.run;
    if (!run || run.state !== "running" || !run.ids.has(pid)) return;
    this.finish("stopped", "Interrupted");
  }

  onQueueStatus(remaining) {
    // safety net: queue went empty but we never saw the end (e.g. cleared from the Queue panel)
    if (remaining !== 0 || !this.running) return;
    const run = this.run;
    setTimeout(() => {
      if (this.run !== run || run.state !== "running") return;
      if (run.chainEnded && run.done >= run.ids.size && run.ids.size) this.finish("done");
      else if (!run.awaitingFirst || run.ids.size) this.finish("stopped", "Queue emptied before the folder finished");
    }, 1500);
  }

  maybeFinish() {
    const run = this.run;
    if (!run || run.state !== "running") return;
    if (run.chainEnded && run.pending.size === 0 && run.done >= run.ids.size && run.ids.size > 0) {
      this.finish("done");
    }
  }

  async stop() {
    const run = this.run;
    if (!run || run.state !== "running") return;
    run.stopping = true;
    const ids = [...run.pending];
    for (const id of [...run.ids.keys(), ...run.pending]) this.deadIds.add(id);
    if (run.runningId) this.deadIds.add(run.runningId);
    try {
      if (ids.length) {
        await api.fetchApi("/queue", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ delete: ids }),
        });
      }
      if (run.runningId && !run.finished.has(run.runningId)) {
        await api.fetchApi("/interrupt", { method: "POST" });
      }
    } catch (e) { /* best effort */ }
    this.finish("stopped", "Stopped");
  }

  finish(state, message = "") {
    const run = this.run;
    if (!run || run.state !== "running") return;
    run.state = state;
    run.tEnd = performance.now();
    run.stopping = true;

    // done -> put index back where the run started. stopped/error -> park on the first
    // unfinished item so pressing Run again RESUMES instead of starting over.
    let resume = run.startIndex;
    if (state !== "done") {
      for (let i = run.startIndex; i < this.status.length; i++) {
        if (this.status[i] !== S.DONE) { resume = i; break; }
        resume = i + 1;
      }
    }
    this.setIndexWidget(Math.min(resume, Math.max(0, (run.total || 1) - 1)));
    for (let i = 0; i < this.status.length; i++) if (this.status[i] === S.RUNNING) this.status[i] = S.PENDING;

    this.root.dataset.state = state;
    const el = (run.tEnd - run.t0) / 1000;
    if (state === "done") {
      this.setStatus(`✓ Finished ${run.done} item${run.done === 1 ? "" : "s"} in ${fmtTime(el)}`, "ok");
      this.burst();
    } else if (state === "stopped") {
      this.setStatus(`${message} · ${run.done} done · press Run to resume at #${resume + 1}`, "warn");
    } else {
      this.setStatus(`${message} · press Run to retry from #${resume + 1}`, "err");
    }
    this.render();
    setTimeout(() => this.scanSoon(), 200);
  }

  // ── rendering ─────────────────────────────────────────────────────────
  startLoop() {
    cancelAnimationFrame(this.raf);
    const tick = (t) => {
      if (!this.running) { this.drawMap(); this.renderStats(); return; }
      this.drawMap(t);
      if (t - this.lastStatsAt > 400) { this.lastStatsAt = t; this.render(true); }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  render(light = false) {
    const run = this.run;
    const running = this.running;
    const exp = this.expected();
    let frac = 0;
    if (run) {
      if (run.state === "done") frac = 1;
      else frac = Math.min(1, (run.done + (running ? run.sub : 0)) / exp);
    }
    this.fillEl.style.width = `${(frac * 100).toFixed(1)}%`;
    this.q("pct").textContent = run ? `${Math.floor(frac * 100)}%   ·   ${run.done} / ${exp}` : "Ready";
    this.subEl.style.width = running ? `${(run.sub * 100).toFixed(0)}%` : "0%";

    this.q("run").disabled = running;
    this.q("stop").disabled = !running;
    this.q("prev").disabled = running || !this.total;
    this.q("next").disabled = running || !this.total;
    this.q("refresh").disabled = running;
    this.renderStats();
    if (!light) this.drawMap();
  }

  renderStats() {
    const run = this.run;
    if (!run) {
      this.q("speed").textContent = "– /min";
      this.q("eta").textContent = "ETA –";
      this.q("elapsed").textContent = "0:00";
      return;
    }
    const end = run.state === "running" ? performance.now() : run.tEnd;
    const el = (end - run.t0) / 1000;
    const speed = run.done > 0 && el > 0 ? (run.done / el) * 60 : null;
    this.q("speed").textContent = speed ? `${speed.toFixed(speed < 10 ? 1 : 0)} /min` : "– /min";
    const remaining = Math.max(0, this.expected() - run.done);
    this.q("eta").textContent =
      run.state === "running" ? `ETA ${run.durEma ? fmtTime(run.durEma * remaining) : "–"}` :
      run.state === "done" ? "Complete" : run.state === "stopped" ? "Stopped" : "Failed";
    this.q("elapsed").textContent = fmtTime(el);
  }

  drawMap(t = performance.now()) {
    const c = this.mapC;
    const cssW = c.clientWidth || 300, cssH = 26;
    const dpr = window.devicePixelRatio || 1;
    if (c.width !== Math.round(cssW * dpr) || c.height !== Math.round(cssH * dpr)) {
      c.width = Math.round(cssW * dpr);
      c.height = Math.round(cssH * dpr);
    }
    const ctx = c.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const total = this.total;
    if (!total) {
      ctx.fillStyle = "rgba(255,255,255,.07)";
      ctx.fillRect(0, cssH / 2 - 1, cssW, 2);
      return;
    }
    const state = this.run?.state === "running" ? "running" : (this.run?.state || "running");
    const [c0, c1] = GRADS[state] || GRADS.running;
    const n = Math.max(1, Math.min(total, Math.floor(cssW / 4)));
    const cw = cssW / n;
    const gap = cw > 3 ? 1 : 0;
    const pulse = 0.55 + 0.45 * Math.sin(t / 180);
    const cur = Math.min(this.idx, total - 1);

    for (let i = 0; i < n; i++) {
      const lo = Math.floor((i * total) / n);
      const hi = Math.max(lo + 1, Math.floor(((i + 1) * total) / n));
      let doneC = 0, running = false, err = false;
      for (let k = lo; k < hi; k++) {
        const s = this.status[k];
        if (s === S.DONE) doneC++;
        else if (s === S.RUNNING) running = true;
        else if (s === S.ERROR) err = true;
      }
      const f = doneC / (hi - lo);
      const x = i * cw, y = 5, h = cssH - 10;
      const tcol = n > 1 ? i / (n - 1) : 0;
      let fill;
      if (err) fill = "rgba(248,113,113,.95)";
      else if (running) fill = `rgba(255,255,255,${0.55 + pulse * 0.4})`;
      else if (f > 0) fill = `rgba(${mix(c0[0], c1[0], tcol)},${mix(c0[1], c1[1], tcol)},${mix(c0[2], c1[2], tcol)},${0.35 + 0.65 * f})`;
      else fill = "rgba(255,255,255,.09)";
      ctx.fillStyle = fill;
      const yy = running ? y - 3 : y, hh = running ? h + 6 : h;
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(x, yy, Math.max(1, cw - gap), hh, 2) : ctx.rect(x, yy, Math.max(1, cw - gap), hh);
      ctx.fill();
    }
    // cursor: where the preview/next run is pointing
    const cx = ((cur + 0.5) / total) * cssW;
    ctx.fillStyle = "rgba(255,255,255,.9)";
    ctx.beginPath();
    ctx.moveTo(cx - 3.5, 0); ctx.lineTo(cx + 3.5, 0); ctx.lineTo(cx, 4.5);
    ctx.closePath();
    ctx.fill();
  }

  burst() {
    const c = this.fxC;
    const w = c.clientWidth, h = c.clientHeight;
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = w * dpr; c.height = h * dpr;
    const ctx = c.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const colors = ["#8b5cf6", "#22d3ee", "#34d399", "#fbbf24", "#f472b6", "#ffffff"];
    const P = Array.from({ length: 90 }, () => ({
      x: w / 2, y: h * 0.85,
      vx: (Math.random() - 0.5) * 9, vy: -(Math.random() * 9 + 4),
      r: Math.random() * 3 + 2, rot: Math.random() * 6, vr: (Math.random() - 0.5) * 0.4,
      col: colors[(Math.random() * colors.length) | 0],
    }));
    const t0 = performance.now();
    const frame = (t) => {
      const age = (t - t0) / 1600;
      ctx.clearRect(0, 0, w, h);
      if (age >= 1) return;
      for (const p of P) {
        p.vy += 0.28; p.x += p.vx; p.y += p.vy; p.rot += p.vr;
        ctx.save();
        ctx.globalAlpha = 1 - age;
        ctx.translate(p.x, p.y); ctx.rotate(p.rot);
        ctx.fillStyle = p.col;
        ctx.fillRect(-p.r, -p.r / 2, p.r * 2, p.r);
        ctx.restore();
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    clearTimeout(this.scanTimer);
    controllers.delete(this);
  }
}

// ──────────────────────────────────────────────────────────── extension ──

function installApiListeners() {
  const each = (fn) => { for (const c of controllers) { try { fn(c); } catch (e) { console.warn("[nougan batch]", e); } } };

  api.addEventListener("execution_start", (e) => {
    const pid = e.detail?.prompt_id;
    lastStartedId = pid ?? null;
    each((c) => c.onExecutionStart(pid));
  });
  api.addEventListener("progress", (e) => {
    const d = e.detail || {};
    each((c) => c.onProgress(d.prompt_id, d.value, d.max));
  });
  // newer ComfyUI sends execution_success; older sends executing{node:null}. onPromptEnd is idempotent.
  api.addEventListener("execution_success", (e) => each((c) => c.onPromptEnd(e.detail?.prompt_id)));
  api.addEventListener("executing", (e) => {
    const d = e.detail;
    // legacy builds send the bare node id (or null) instead of an object
    const node = d && typeof d === "object" ? d.node : d;
    const pid = d && typeof d === "object" ? d.prompt_id : lastStartedId;
    if (node === null || node === undefined) each((c) => c.onPromptEnd(pid));
  });
  api.addEventListener("execution_error", (e) => each((c) => c.onPromptError(e.detail?.prompt_id, e.detail)));
  api.addEventListener("execution_interrupted", (e) => each((c) => c.onPromptInterrupted(e.detail?.prompt_id)));
  api.addEventListener("status", (e) => {
    const rem = e.detail?.exec_info?.queue_remaining;
    if (typeof rem === "number") each((c) => c.onQueueStatus(rem));
  });
}

app.registerExtension({
  name: EXT_NAME,

  setup() {
    injectCSS();
    installApiListeners();
  },

  async beforeRegisterNodeDef(nodeType, nodeData) {
    const kind = KINDS[nodeData?.name];
    if (!kind) return;

    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onCreated?.apply(this, arguments);
      injectCSS();
      const ctl = new FolderBatchCard(this, kind);
      this.__nfb = ctl;
      controllers.add(ctl);
      ctl.hookWidgets();
      this.setSize([Math.max(this.size[0], 340), Math.max(this.size[1], this.computeSize()[1])]);
      setTimeout(() => ctl.scan(), 400);
      return r;
    };

    const onExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      const r = onExecuted?.apply(this, arguments);
      this.__nfb?.onExecuted(message);
      return r;
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const r = onConfigure?.apply(this, arguments);
      // widget values are restored by now: refresh the card from them
      setTimeout(() => {
        this.__nfb?.hookWidgets();
        this.__nfb?.updateRunLabel();
        this.__nfb?.scan();
      }, 300);
      return r;
    };

    const onRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      this.__nfb?.destroy();
      return onRemoved?.apply(this, arguments);
    };
  },
});
