const { app } = window.comfyAPI.app;

const PALETTE = [
  "#4f8edc", "#e07b3a", "#5cb85c", "#d9534f", "#9b6cd6",
  "#a07060", "#e377c2", "#7f7f7f", "#c4c447", "#3fbac4",
];

const RULER_HEIGHT = 22;
const BLOCK_HEIGHT = 64;
const CANVAS_HEIGHT = RULER_HEIGHT + BLOCK_HEIGHT;
const HANDLE_HIT_PX = 6;
const REORDER_THRESHOLD_PX = 6;
const MIN_SEGMENT_LENGTH = 1;

// Derived from the schema's hidden inputs — keep in sync with define_schema().
const HIDDEN_WIDGET_NAMES = ["timeline_data", "local_prompts", "segment_lengths"];

const MAX_UNDO = 50;

function hideWidget(w) {
  if (!w) return;
  w.type = "hidden";
  w.hidden = true;
  w.computeSize = () => [0, -4];
}

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

function pickColor(existingColors) {
  for (const c of PALETTE) if (!existingColors.has(c)) return c;
  const idx = existingColors.size;
  const hue = (idx * 137.508) % 360;
  return `hsl(${hue.toFixed(0)}, 55%, 55%)`;
}

function defaultTimeline(maxFrames) {
  const half = Math.max(MIN_SEGMENT_LENGTH, Math.floor(maxFrames / 2));
  return {
    segments: [
      { prompt: "", length: half, color: PALETTE[0] },
      { prompt: "", length: Math.max(MIN_SEGMENT_LENGTH, maxFrames - half), color: PALETTE[1] },
    ],
  };
}

function parseInitial(jsonStr, maxFrames) {
  if (!jsonStr) return defaultTimeline(maxFrames);
  try {
    const obj = JSON.parse(jsonStr);
    if (Array.isArray(obj?.segments) && obj.segments.length > 0) {
      return {
        segments: obj.segments.map((s, i) => ({
          prompt: typeof s.prompt === "string" ? s.prompt : "",
          length: Math.max(MIN_SEGMENT_LENGTH, parseInt(s.length, 10) || MIN_SEGMENT_LENGTH),
          color: typeof s.color === "string" ? s.color : PALETTE[i % PALETTE.length],
        })),
      };
    }
  } catch (_) {}
  return defaultTimeline(maxFrames);
}

// Rough token estimate for the live counter (words × 1.3 for T5-style tokenizers).
function estimateTokens(text) {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.ceil(words * 1.3);
}

class TimelineEditor {
  constructor(node, container) {
    this.node = node;
    this.container = container;
    this.maxFramesWidget = node.widgets.find(w => w.name === "max_frames");
    this.fpsWidget = node.widgets.find(w => w.name === "fps");
    this.timeUnitsWidget = node.widgets.find(w => w.name === "time_units");
    this.timelineDataWidget = node.widgets.find(w => w.name === "timeline_data");
    this.localPromptsWidget = node.widgets.find(w => w.name === "local_prompts");
    this.segmentLengthsWidget = node.widgets.find(w => w.name === "segment_lengths");

    this.timeline = parseInitial(this.timelineDataWidget?.value, this.getMaxFrames());
    this.selectedIndex = 0;
    this.hoverIndex = -1;
    this.hoverHandle = -1;
    this.dragHandle = -1;
    this.dragStart = null;
    this.reorder = null;
    this._settling = false;
    this._inputBaseline = null;
    this._textCommitTimer = null;
    this._displayedX = new Map();
    this._targetX = new Map();
    this._animRaf = null;

    // Undo / redo stacks (JSON snapshots of this.timeline)
    this._undoStack = [];
    this._redoStack = [];

    this.buildDOM();
    this.bindEvents();
    this.syncWidgetsFromTimeline();
    this.updateUIFromSelection();
    this.render();
  }

  // ─── Undo / Redo ───

  _pushUndo() {
    this._undoStack.push(JSON.stringify(this.timeline));
    if (this._undoStack.length > MAX_UNDO) this._undoStack.shift();
    this._redoStack.length = 0;
  }

  undo() {
    if (!this._undoStack.length) return;
    this._redoStack.push(JSON.stringify(this.timeline));
    this.timeline = JSON.parse(this._undoStack.pop());
    this.selectedIndex = clamp(this.selectedIndex, 0, this.timeline.segments.length - 1);
    this.commit();
    this.updateUIFromSelection();
    this.render();
  }

  redo() {
    if (!this._redoStack.length) return;
    this._undoStack.push(JSON.stringify(this.timeline));
    this.timeline = JSON.parse(this._redoStack.pop());
    this.selectedIndex = clamp(this.selectedIndex, 0, this.timeline.segments.length - 1);
    this.commit();
    this.updateUIFromSelection();
    this.render();
  }

  // ─── Getters ───

  getMaxFrames() {
    return Math.max(1, parseInt(this.maxFramesWidget?.value, 10) || 1);
  }

  getFps() {
    const v = parseFloat(this.fpsWidget?.value);
    return Number.isFinite(v) && v > 0 ? v : 24;
  }

  isSecondsMode() {
    return this.timeUnitsWidget?.value === "seconds";
  }

  formatTime(frames) {
    if (!this.isSecondsMode()) return String(frames);
    const s = frames / this.getFps();
    return `${s.toFixed(2).replace(/\.?0+$/, "")}s`;
  }

  formatLength(frames) {
    return this.isSecondsMode() ? this.formatTime(frames) : `${frames}f`;
  }

  // ─── DOM ───

  buildDOM() {
    this.container.innerHTML = "";
    this.container.style.cssText = `
      display: flex; flex-direction: column; gap: 6px;
      padding: 6px 8px; box-sizing: border-box;
      font-family: sans-serif; font-size: 11px; color: #ddd;
      width: 100%; height: 100%; outline: none;
    `;
    // Make the container focusable for keyboard shortcuts
    this.container.tabIndex = 0;

    this.canvas = document.createElement("canvas");
    this.canvas.style.cssText = `
      width: 100%; height: ${CANVAS_HEIGHT}px;
      display: block; background: #1a1a1a; border-radius: 4px;
      cursor: default;
    `;
    this.container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d");

    // Prompt textarea + token counter
    const textRow = document.createElement("div");
    textRow.style.cssText = "display: flex; flex-direction: column; gap: 2px; flex: 1 1 auto;";

    this.textarea = document.createElement("textarea");
    this.textarea.placeholder = "Click a segment above to edit its prompt…";
    this.textarea.style.cssText = `
      width: 100%; min-height: 60px; flex: 1 1 auto;
      box-sizing: border-box; resize: none;
      background: #2a2a2a; color: #eee; border: 1px solid #444;
      border-radius: 4px; padding: 6px; font-family: inherit; font-size: 12px;
    `;
    textRow.appendChild(this.textarea);

    this.tokenLabel = document.createElement("span");
    this.tokenLabel.style.cssText = "color: #888; font-size: 10px; text-align: right;";
    this.tokenLabel.textContent = "";
    textRow.appendChild(this.tokenLabel);

    this.container.appendChild(textRow);

    // Controls row
    const row = document.createElement("div");
    row.style.cssText = "display: flex; gap: 6px; align-items: center; flex-wrap: wrap;";

    const lengthLabel = document.createElement("label");
    lengthLabel.style.cssText = "display: flex; align-items: center; gap: 4px;";
    lengthLabel.textContent = "Length:";
    this.lengthInput = document.createElement("input");
    this.lengthInput.type = "number";
    this.lengthInput.style.cssText = `
      width: 70px; background: #2a2a2a; color: #eee;
      border: 1px solid #444; border-radius: 3px; padding: 2px 4px;
    `;
    lengthLabel.appendChild(this.lengthInput);
    row.appendChild(lengthLabel);

    this.totalLabel = document.createElement("span");
    this.totalLabel.style.cssText = "color: #888; margin-left: 4px;";
    row.appendChild(this.totalLabel);

    const spacer = document.createElement("div");
    spacer.style.flex = "1";
    row.appendChild(spacer);

    this.undoBtn = this.makeButton("↩ Undo", "Undo last action (Ctrl+Z)");
    this.redoBtn = this.makeButton("↪ Redo", "Redo last undone action (Ctrl+Shift+Z)");
    this.addBtn = this.makeButton(
      "+ Add",
      "Add a new segment. Steals space from existing segments (from the end) if the timeline is full.",
    );
    this.duplicateBtn = this.makeButton(
      "⧉ Dup",
      "Duplicate the selected segment (Ctrl+D).",
    );
    this.distributeBtn = this.makeButton(
      "Equalize",
      "Set every segment to the same length so the total exactly fills max_frames.",
    );
    this.deleteBtn = this.makeButton(
      "Delete",
      "Remove the currently selected segment (Del). Disabled when only one segment is left.",
    );
    row.appendChild(this.undoBtn);
    row.appendChild(this.redoBtn);
    row.appendChild(this.addBtn);
    row.appendChild(this.duplicateBtn);
    row.appendChild(this.distributeBtn);
    row.appendChild(this.deleteBtn);

    this.container.appendChild(row);
  }

  makeButton(label, tooltip) {
    const b = document.createElement("button");
    b.textContent = label;
    if (tooltip) b.title = tooltip;
    b.style.cssText = `
      background: #3a3a3a; color: #eee; border: 1px solid #555;
      border-radius: 3px; padding: 3px 10px; cursor: pointer; font-size: 11px;
    `;
    b.addEventListener("mouseenter", () => b.style.background = "#4a4a4a");
    b.addEventListener("mouseleave", () => b.style.background = "#3a3a3a");
    return b;
  }

  // ─── Events ───

  bindEvents() {
    this.canvas.addEventListener("pointerdown", e => { e.stopPropagation(); this.onPointerDown(e); });
    this.canvas.addEventListener("pointermove", e => { e.stopPropagation(); this.onPointerMove(e); });
    this.canvas.addEventListener("pointerup", e => { e.stopPropagation(); this.onPointerUp(e); });
    this.canvas.addEventListener("contextmenu", e => { e.preventDefault(); e.stopPropagation(); });
    this.canvas.addEventListener("wheel", e => e.stopPropagation(), { passive: true });
    this.canvas.addEventListener("pointerleave", () => {
      if (this.dragHandle < 0) {
        this.hoverIndex = -1;
        this.hoverHandle = -1;
        this.canvas.style.cursor = "default";
        this.render();
      }
    });

    this.textarea.addEventListener("wheel", e => e.stopPropagation(), { passive: true });
    this.textarea.addEventListener("pointerdown", e => e.stopPropagation());
    this.lengthInput.addEventListener("pointerdown", e => e.stopPropagation());
    this.lengthInput.addEventListener("wheel", e => e.stopPropagation(), { passive: true });

    this.textarea.addEventListener("input", () => {
      const seg = this.timeline.segments[this.selectedIndex];
      if (!seg) return;
      seg.prompt = this.textarea.value;
      if (this.localPromptsWidget) {
        this.localPromptsWidget.value = this.timeline.segments.map(s => s.prompt).join(" | ");
      }
      this.updateTokenLabel();
      this.render();
      if (this._textCommitTimer) clearTimeout(this._textCommitTimer);
      this._textCommitTimer = setTimeout(() => {
        this._textCommitTimer = null;
        this.commit();
      }, 120);
    });
    this.textarea.addEventListener("blur", () => {
      if (this._textCommitTimer) {
        clearTimeout(this._textCommitTimer);
        this._textCommitTimer = null;
        this.commit();
      }
    });

    this.lengthInput.addEventListener("focus", () => { this._inputBaseline = null; });
    this.lengthInput.addEventListener("blur", () => { this._inputBaseline = null; });
    this.lengthInput.addEventListener("input", () => {
      const idx = this.selectedIndex;
      const seg = this.timeline.segments[idx];
      if (!seg) return;
      const raw = parseFloat(this.lengthInput.value);
      if (!Number.isFinite(raw)) return;
      const frames = Math.max(
        MIN_SEGMENT_LENGTH,
        Math.round(this.isSecondsMode() ? raw * this.getFps() : raw),
      );
      if (!this._inputBaseline) {
        this._pushUndo();
        this._inputBaseline = this.timeline.segments.map(s => s.length);
      }
      this._setLengthShifting(idx, frames, this._inputBaseline);
      this.commit();
      this.render();
      this.updateTotalLabel();
    });

    this.undoBtn.addEventListener("click", () => this.undo());
    this.redoBtn.addEventListener("click", () => this.redo());
    this.addBtn.addEventListener("click", () => this.addSegment());
    this.duplicateBtn.addEventListener("click", () => this.duplicateSelected());
    this.distributeBtn.addEventListener("click", () => this.distributeEvenly());
    this.deleteBtn.addEventListener("click", () => this.deleteSelected());

    // Keyboard shortcuts (only when the container itself is focused, not textarea/input)
    this.container.addEventListener("keydown", (e) => {
      if (e.target === this.textarea || e.target === this.lengthInput) return;
      const ctrl = e.ctrlKey || e.metaKey;
      switch (e.key) {
        case "Delete":
        case "Backspace":
          e.preventDefault();
          this.deleteSelected();
          break;
        case "z":
          if (ctrl && e.shiftKey) { e.preventDefault(); this.redo(); }
          else if (ctrl) { e.preventDefault(); this.undo(); }
          break;
        case "y":
          if (ctrl) { e.preventDefault(); this.redo(); }
          break;
        case "d":
          if (ctrl) { e.preventDefault(); this.duplicateSelected(); }
          break;
        case "ArrowLeft":
          e.preventDefault();
          this.selectedIndex = clamp(this.selectedIndex - 1, 0, this.timeline.segments.length - 1);
          this.updateUIFromSelection();
          this.render();
          break;
        case "ArrowRight":
          e.preventDefault();
          this.selectedIndex = clamp(this.selectedIndex + 1, 0, this.timeline.segments.length - 1);
          this.updateUIFromSelection();
          this.render();
          break;
      }
    });

    if (this.maxFramesWidget) {
      const prev = this.maxFramesWidget.callback;
      this.maxFramesWidget.callback = (...args) => {
        prev?.apply(this.maxFramesWidget, args);
        this._pushUndo();
        this.trimToFit();
        this.commit();
        this.updateUIFromSelection();
        this.render();
      };
    }

    for (const w of [this.fpsWidget, this.timeUnitsWidget]) {
      if (!w) continue;
      const prev = w.callback;
      w.callback = (...args) => {
        prev?.apply(w, args);
        this.updateUIFromSelection();
        this.render();
      };
    }

    this.resizeObserver = new ResizeObserver(() => this.resizeCanvas());
    this.resizeObserver.observe(this.container);
    this.resizeCanvas();
  }

  resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(50, Math.floor(this.canvas.offsetWidth));
    this.canvas.width = w * dpr;
    this.canvas.height = CANVAS_HEIGHT * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._cssWidth = w;
    this.render();
  }

  // ─── Layout ───

  pxPerFrame() {
    return this._cssWidth / this.getMaxFrames();
  }

  segmentRects(order) {
    const segs = this.timeline.segments;
    const ord = order ?? this._getEffectiveOrder();
    const ppf = this.pxPerFrame();
    const rects = [];
    let cursor = 0;
    for (let visualPos = 0; visualPos < ord.length; visualPos++) {
      const idx = ord[visualPos];
      const len = segs[idx].length;
      rects.push({ index: idx, visualPos, x: cursor * ppf, w: len * ppf, frameStart: cursor, frameEnd: cursor + len });
      cursor += len;
    }
    return rects;
  }

  _getEffectiveOrder() {
    const n = this.timeline.segments.length;
    const natural = Array.from({ length: n }, (_, i) => i);
    if (!this.reorder?.active || this.reorder.targetIdx === this.reorder.sourceIdx) return natural;
    const order = natural.filter(i => i !== this.reorder.sourceIdx);
    order.splice(this.reorder.targetIdx, 0, this.reorder.sourceIdx);
    return order;
  }

  _computeReorderTarget() {
    const ppf = this.pxPerFrame();
    const sourceIdx = this.reorder.sourceIdx;
    const sourceLen = this.timeline.segments[sourceIdx].length;
    const blockCenterFrame =
      (this.reorder.cursorX - this.reorder.dragOffsetPx) / ppf + sourceLen / 2;

    const others = [];
    for (let i = 0; i < this.timeline.segments.length; i++) {
      if (i !== sourceIdx) others.push(this.timeline.segments[i].length);
    }

    let bestTarget = 0;
    let bestDist = Infinity;
    let cum = 0;
    for (let target = 0; target <= others.length; target++) {
      const sourceCenter = cum + sourceLen / 2;
      const dist = Math.abs(blockCenterFrame - sourceCenter);
      if (dist < bestDist) { bestDist = dist; bestTarget = target; }
      if (target < others.length) cum += others[target];
    }
    return bestTarget;
  }

  hitBoundary(mx) {
    const rects = this.segmentRects();
    for (let i = 0; i < rects.length; i++) {
      const right = rects[i].x + rects[i].w;
      if (Math.abs(mx - right) <= HANDLE_HIT_PX) return i;
    }
    return -1;
  }

  hitBlock(mx, my) {
    if (my < RULER_HEIGHT) return -1;
    const rects = this.segmentRects();
    for (const r of rects) {
      if (mx >= r.x && mx < r.x + r.w) return r.index;
    }
    return -1;
  }

  // ─── Pointer ───

  onPointerDown(e) {
    const { x, y } = this.localPos(e);
    this._settling = false;
    const handle = this.hitBoundary(x);
    if (handle >= 0) {
      this._pushUndo();
      this.dragHandle = handle;
      const segs = this.timeline.segments;
      this.dragStart = { x, initialLengths: segs.map(s => s.length) };
      this.canvas.setPointerCapture(e.pointerId);
      return;
    }
    const block = this.hitBlock(x, y);
    if (block >= 0) {
      this.selectedIndex = block;
      this.updateUIFromSelection();
      this.render();
      const sourceX = this._displayedX.get(block) ?? 0;
      this.reorder = {
        sourceIdx: block, targetIdx: block,
        startX: x, startY: y,
        cursorX: x,
        dragOffsetPx: x - sourceX,
        active: false,
      };
      try { this.canvas.setPointerCapture(e.pointerId); } catch (_) {}
    }
  }

  onPointerMove(e) {
    const { x, y } = this.localPos(e);
    if (this.dragHandle >= 0) {
      const ppf = this.pxPerFrame();
      const dxFrames = Math.round((x - this.dragStart.x) / ppf);
      const handle = this.dragHandle;
      const initial = this.dragStart.initialLengths;
      this._setLengthShifting(handle, initial[handle] + dxFrames, initial);

      const segs = this.timeline.segments;
      this.commit();
      if (segs[this.selectedIndex]) this.lengthInput.value = this.lengthInputValueFor(segs[this.selectedIndex].length);
      this.updateTotalLabel();
      this.render();
      return;
    }

    if (this.reorder) {
      const dx = x - this.reorder.startX;
      const dy = y - this.reorder.startY;
      if (!this.reorder.active && Math.hypot(dx, dy) > REORDER_THRESHOLD_PX) {
        this._pushUndo();
        this.reorder.active = true;
        this.canvas.style.cursor = "grabbing";
      }
      if (this.reorder.active) {
        this.reorder.cursorX = x;
        this.reorder.targetIdx = this._computeReorderTarget();
        this.render();
        return;
      }
    }

    const handle = this.hitBoundary(x);
    const block = handle >= 0 ? -1 : this.hitBlock(x, y);
    if (handle !== this.hoverHandle || block !== this.hoverIndex) {
      this.hoverHandle = handle;
      this.hoverIndex = block;
      this.canvas.style.cursor = handle >= 0 ? "ew-resize" : (block >= 0 ? "pointer" : "default");
      this.render();
    }
  }

  onPointerUp(e) {
    if (this.dragHandle >= 0) {
      try { this.canvas.releasePointerCapture(e.pointerId); } catch (_) {}
      this.dragHandle = -1;
      this.dragStart = null;
    }
    if (this.reorder) {
      try { this.canvas.releasePointerCapture(e.pointerId); } catch (_) {}
      if (this.reorder.active) {
        this.canvas.style.cursor = "default";
        const { sourceIdx, targetIdx } = this.reorder;
        if (sourceIdx !== targetIdx) {
          const effective = this._getEffectiveOrder();
          const oldDisplayed = new Map(this._displayedX);
          const seg = this.timeline.segments.splice(sourceIdx, 1)[0];
          this.timeline.segments.splice(targetIdx, 0, seg);
          this._displayedX = new Map();
          for (let newIdx = 0; newIdx < effective.length; newIdx++) {
            const oldIdx = effective[newIdx];
            if (oldDisplayed.has(oldIdx)) this._displayedX.set(newIdx, oldDisplayed.get(oldIdx));
          }
          this.selectedIndex = targetIdx;
          this.commit();
          this.updateUIFromSelection();
          this._settling = true;
        }
      }
      this.reorder = null;
      this.render();
    }
  }

  localPos(e) {
    const rect = this.canvas.getBoundingClientRect();
    const sx = (rect.width / this.canvas.offsetWidth) || 1;
    const sy = (rect.height / this.canvas.offsetHeight) || 1;
    return {
      x: (e.clientX - rect.left) / sx,
      y: (e.clientY - rect.top) / sy,
    };
  }

  // ─── Mutations ───

  addSegment() {
    const max = this.getMaxFrames();
    const n = this.timeline.segments.length;
    if (max < (n + 1) * MIN_SEGMENT_LENGTH) return;

    this._pushUndo();
    const desired = Math.max(MIN_SEGMENT_LENGTH, Math.floor(max / (n + 1)));
    const newIdx = n;
    const usedColors = new Set(this.timeline.segments.map(s => s.color));
    this.timeline.segments.push({ prompt: "", length: desired, color: pickColor(usedColors) });
    this.trimToFit(newIdx);

    let total = this.timeline.segments.reduce((a, s) => a + s.length, 0);
    if (total > max) {
      this.timeline.segments[newIdx].length -= (total - max);
    }

    this.selectedIndex = newIdx;
    this.commit();
    this.updateUIFromSelection();
    this.updateTotalLabel();
    this.render();
  }

  duplicateSelected() {
    const seg = this.timeline.segments[this.selectedIndex];
    if (!seg) return;
    const max = this.getMaxFrames();
    const n = this.timeline.segments.length;
    if (max < (n + 1) * MIN_SEGMENT_LENGTH) return;

    this._pushUndo();
    const usedColors = new Set(this.timeline.segments.map(s => s.color));
    const copy = {
      prompt: seg.prompt,
      length: Math.max(MIN_SEGMENT_LENGTH, Math.floor(seg.length / 2)),
      color: pickColor(usedColors),
    };
    // Shrink the source to make room
    seg.length = Math.max(MIN_SEGMENT_LENGTH, seg.length - copy.length);
    this.timeline.segments.splice(this.selectedIndex + 1, 0, copy);
    this.trimToFit();

    this.selectedIndex = this.selectedIndex + 1;
    this.commit();
    this.updateUIFromSelection();
    this.updateTotalLabel();
    this.render();
  }

  maxLengthFor(idx) {
    const max = this.getMaxFrames();
    let others = 0;
    for (let i = 0; i < this.timeline.segments.length; i++) {
      if (i !== idx) others += this.timeline.segments[i].length;
    }
    return Math.max(MIN_SEGMENT_LENGTH, max - others);
  }

  _setLengthShifting(idx, newLen, baseline) {
    const segs = this.timeline.segments;
    const max = this.getMaxFrames();
    for (let i = 0; i < segs.length; i++) segs[i].length = baseline[i];
    segs[idx].length = Math.max(MIN_SEGMENT_LENGTH, newLen);
    let total = segs.reduce((a, s) => a + s.length, 0);
    for (let i = idx + 1; i < segs.length && total > max; i++) {
      const reducible = segs[i].length - MIN_SEGMENT_LENGTH;
      const take = Math.min(reducible, total - max);
      segs[i].length -= take;
      total -= take;
    }
    if (total > max) segs[idx].length -= (total - max);
  }

  trimToFit(protectIndex = -1) {
    const max = this.getMaxFrames();
    let total = this.timeline.segments.reduce((a, s) => a + s.length, 0);
    for (let i = this.timeline.segments.length - 1; i >= 0 && total > max; i--) {
      if (i === protectIndex) continue;
      const seg = this.timeline.segments[i];
      const reducible = seg.length - MIN_SEGMENT_LENGTH;
      const take = Math.min(reducible, total - max);
      seg.length -= take;
      total -= take;
    }
  }

  distributeEvenly() {
    const max = this.getMaxFrames();
    const n = this.timeline.segments.length;
    if (n === 0) return;
    this._pushUndo();
    const base = Math.max(MIN_SEGMENT_LENGTH, Math.floor(max / n));
    const remainder = Math.max(0, max - base * n);
    for (let i = 0; i < n; i++) {
      this.timeline.segments[i].length = base + (i < remainder ? 1 : 0);
    }
    this.commit();
    this.updateUIFromSelection();
    this.render();
  }

  deleteSelected() {
    if (this.timeline.segments.length <= 1) return;
    this._pushUndo();
    this.timeline.segments.splice(this.selectedIndex, 1);
    this.selectedIndex = clamp(this.selectedIndex, 0, this.timeline.segments.length - 1);
    this.commit();
    this.updateUIFromSelection();
    this.updateTotalLabel();
    this.render();
  }

  // ─── Persistence ───

  commit() {
    this.syncWidgetsFromTimeline();
    this.node.graph?.setDirtyCanvas?.(true, true);
  }

  syncWidgetsFromTimeline() {
    const segs = this.timeline.segments;
    if (this.timelineDataWidget) this.timelineDataWidget.value = JSON.stringify(this.timeline);
    if (this.localPromptsWidget) this.localPromptsWidget.value = segs.map(s => s.prompt).join(" | ");
    if (this.segmentLengthsWidget) this.segmentLengthsWidget.value = segs.map(s => s.length).join(", ");
  }

  // ─── UI sync ───

  lengthInputValueFor(frames) {
    if (!this.isSecondsMode()) return String(frames);
    return (frames / this.getFps()).toFixed(3).replace(/\.?0+$/, "");
  }

  updateUIFromSelection() {
    const seg = this.timeline.segments[this.selectedIndex];
    if (!seg) {
      this.textarea.value = "";
      this.lengthInput.value = "";
      this.tokenLabel.textContent = "";
    } else {
      if (this.textarea.value !== seg.prompt) this.textarea.value = seg.prompt;
      this.lengthInput.value = this.lengthInputValueFor(seg.length);
      this.updateTokenLabel();
    }
    this.lengthInput.step = this.isSecondsMode() ? (1 / this.getFps()).toFixed(4) : "1";
    this.lengthInput.min = this.isSecondsMode() ? (MIN_SEGMENT_LENGTH / this.getFps()).toFixed(4) : MIN_SEGMENT_LENGTH;
    this._inputBaseline = null;
    this.updateTotalLabel();
  }

  updateTokenLabel() {
    const seg = this.timeline.segments[this.selectedIndex];
    if (!seg || !seg.prompt.trim()) {
      this.tokenLabel.textContent = "";
      return;
    }
    const approx = estimateTokens(seg.prompt);
    this.tokenLabel.textContent = `~${approx} tokens`;
    this.tokenLabel.style.color = approx > 60 ? "#e07b3a" : "#888";
  }

  updateTotalLabel() {
    const total = this.timeline.segments.reduce((a, s) => a + s.length, 0);
    const max = this.getMaxFrames();
    if (this.isSecondsMode()) {
      const fps = this.getFps();
      const fmt = (f) => (f / fps).toFixed(2).replace(/\.?0+$/, "");
      this.totalLabel.textContent = `Total: ${fmt(total)} / ${fmt(max)} s @ ${fps}fps`;
    } else {
      this.totalLabel.textContent = `Total: ${total} / ${max} frames`;
    }
  }

  // ─── Render ───

  render() {
    const rects = this.segmentRects();
    this._targetX = new Map();
    for (const r of rects) this._targetX.set(r.index, r.x);

    if (this.reorder?.active) {
      const sourceIdx = this.reorder.sourceIdx;
      const sourcePos = this.reorder.cursorX - this.reorder.dragOffsetPx;
      this._targetX.set(sourceIdx, sourcePos);
      this._displayedX.set(sourceIdx, sourcePos);
      this._kickAnim();
    } else if (this._settling) {
      this._kickAnim();
    } else {
      for (const [idx, target] of this._targetX) this._displayedX.set(idx, target);
      this._draw();
    }
  }

  _kickAnim() {
    if (this._animRaf) return;
    this._animRaf = requestAnimationFrame(() => this._tick());
  }

  _tick() {
    this._animRaf = null;
    let needsMore = false;
    const speed = 0.15;
    for (const [idx, target] of this._targetX) {
      const cur = this._displayedX.get(idx);
      if (cur === undefined) { this._displayedX.set(idx, target); continue; }
      const diff = target - cur;
      if (Math.abs(diff) < 0.3) {
        this._displayedX.set(idx, target);
      } else {
        this._displayedX.set(idx, cur + diff * speed);
        needsMore = true;
      }
    }
    this._draw();
    if (needsMore) {
      this._animRaf = requestAnimationFrame(() => this._tick());
    } else if (!this.reorder?.active) {
      this._settling = false;
    }
  }

  _draw() {
    const ctx = this.ctx;
    const w = this._cssWidth;
    ctx.clearRect(0, 0, w, CANVAS_HEIGHT);
    this.drawRuler(ctx, w);
    this.drawSegments(ctx, w);
  }

  drawRuler(ctx, w) {
    const max = this.getMaxFrames();
    ctx.fillStyle = "#222";
    ctx.fillRect(0, 0, w, RULER_HEIGHT);

    const ppf = this.pxPerFrame();
    const targetLabelSpacing = 60;

    let step;
    if (this.isSecondsMode()) {
      const fps = this.getFps();
      const target = targetLabelSpacing / (ppf * fps);
      const nice = [0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
      let chosen = nice[nice.length - 1];
      for (const s of nice) { if (s >= target) { chosen = s; break; } }
      step = Math.max(1, Math.round(chosen * fps));
    } else {
      step = Math.max(1, Math.round(targetLabelSpacing / ppf));
      const niceSteps = [1, 2, 4, 5, 8, 10, 16, 20, 25, 50, 100];
      for (const s of niceSteps) { if (s >= step) { step = s; break; } }
    }

    ctx.strokeStyle = "#444";
    ctx.fillStyle = "#aaa";
    ctx.font = "10px sans-serif";
    ctx.textBaseline = "top";
    ctx.lineWidth = 1;

    for (let f = 0; f <= max; f += step) {
      const x = Math.floor(f * ppf) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, RULER_HEIGHT - 6);
      ctx.lineTo(x, RULER_HEIGHT);
      ctx.stroke();
      ctx.fillText(this.formatTime(f), x + 2, 2);
    }
    const xMax = Math.floor(max * ppf) - 0.5;
    ctx.strokeStyle = "#666";
    ctx.beginPath();
    ctx.moveTo(xMax, 0);
    ctx.lineTo(xMax, RULER_HEIGHT);
    ctx.stroke();
  }

  drawSegments(ctx, w) {
    const rects = this.segmentRects();
    const blockY = RULER_HEIGHT + 2;
    const blockH = BLOCK_HEIGHT - 4;

    ctx.fillStyle = "#101010";
    ctx.fillRect(0, blockY, w, blockH);

    const dragIdx = this.reorder?.active ? this.reorder.sourceIdx : -1;
    const rendered = [...rects].sort((a, b) => (a.index === dragIdx ? 1 : 0) - (b.index === dragIdx ? 1 : 0));

    for (const r of rendered) {
      const seg = this.timeline.segments[r.index];
      const color = seg.color || PALETTE[r.index % PALETTE.length];
      const isSelected = r.index === this.selectedIndex;
      const isHover = r.index === this.hoverIndex;
      const isDragging = r.index === dragIdx;

      const drawX = Math.floor(this._displayedX.get(r.index) ?? r.x);
      const drawW = Math.max(2, Math.floor(r.w));

      ctx.fillStyle = color;
      ctx.globalAlpha = isDragging ? 0.9 : (isSelected ? 1.0 : (isHover ? 0.9 : 0.75));
      ctx.fillRect(drawX, blockY, drawW, blockH);
      ctx.globalAlpha = 1.0;

      ctx.strokeStyle = isDragging ? "#ffd54f" : (isSelected ? "#fff" : "rgba(0,0,0,0.4)");
      ctx.lineWidth = isDragging || isSelected ? 2 : 1;
      ctx.strokeRect(drawX + 0.5, blockY + 0.5, drawW - 1, blockH - 1);

      ctx.fillStyle = "#fff";
      ctx.font = "11px sans-serif";
      ctx.textBaseline = "top";
      const label = seg.prompt || `(segment ${r.index + 1})`;
      const [line1, line2] = this.wrapTwoLines(ctx, label, drawW - 8);
      ctx.fillText(line1, drawX + 4, blockY + 4);
      if (line2) ctx.fillText(line2, drawX + 4, blockY + 18);

      ctx.fillStyle = "rgba(255,255,255,0.75)";
      ctx.font = "10px monospace";
      const range = `${this.formatTime(r.frameStart)}–${this.formatTime(r.frameEnd)} (${this.formatLength(seg.length)})`;
      const rangeTrunc = this.truncateText(ctx, range, drawW - 8);
      ctx.fillText(rangeTrunc, drawX + 4, blockY + blockH - 14);
    }

    if (!this.reorder?.active) {
      for (let i = 0; i < rects.length; i++) {
        const r = rects[i];
        const drawX = this._displayedX.get(r.index) ?? r.x;
        const right = Math.floor(drawX + r.w);
        const isHover = i === this.hoverHandle || i === this.dragHandle;
        ctx.fillStyle = isHover ? "#fff" : "rgba(255,255,255,0.4)";
        ctx.fillRect(right - 1, blockY + 4, 2, blockH - 8);
      }
    }
  }

  truncateText(ctx, text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) return text;
    let lo = 0, hi = text.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ctx.measureText(text.slice(0, mid) + "…").width <= maxWidth) lo = mid;
      else hi = mid - 1;
    }
    return lo > 0 ? text.slice(0, lo) + "…" : "";
  }

  wrapTwoLines(ctx, text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) return [text, ""];

    const tokens = text.split(/(\s+)/);
    let line1 = "";
    let consumed = 0;
    for (let i = 0; i < tokens.length; i++) {
      const candidate = line1 + tokens[i];
      if (ctx.measureText(candidate).width > maxWidth) break;
      line1 = candidate;
      consumed = i + 1;
    }

    if (!line1.trim()) return [this.truncateText(ctx, text, maxWidth), ""];

    let line2 = tokens.slice(consumed).join("").trim();
    if (!line2) return [line1.trimEnd(), ""];
    if (ctx.measureText(line2).width > maxWidth) {
      line2 = this.truncateText(ctx, line2, maxWidth);
    }
    return [line1.trimEnd(), line2];
  }

  destroy() {
    this.resizeObserver?.disconnect();
    if (this._animRaf) cancelAnimationFrame(this._animRaf);
    if (this._textCommitTimer) {
      clearTimeout(this._textCommitTimer);
      this._textCommitTimer = null;
      try { this.commit(); } catch (_) {}
    }
  }
}

// Workflows saved before fps/time_units existed restore with a shorter
// widgets_values array, leaving the new widgets at null / "".
const APPENDED_WIDGET_DEFAULTS = [["fps", 24.0], ["time_units", "frames"]];

app.registerExtension({
  name: "PromptRelay.Timeline",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== "PromptRelayEncodeTimeline") return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated?.apply(this, arguments);

      for (const name of HIDDEN_WIDGET_NAMES) {
        hideWidget(this.widgets.find(w => w.name === name));
      }

      const container = document.createElement("div");
      this._timelineWidget = this.addDOMWidget("prompt_relay_timeline", "PromptRelayTimeline", container, {
        serialize: false,
        hideOnZoom: false,
        getMinHeight: () => 240,
        getHeight: () => 240,
      });

      const self = this;
      setTimeout(() => {
        try {
          self._timelineEditor = new TimelineEditor(self, container);
        } catch (err) {
          console.error("[PromptRelay] timeline editor init failed:", err);
        }
      }, 0);

      const onRemoved = this.onRemoved;
      this.onRemoved = function () {
        this._timelineEditor?.destroy();
        return onRemoved?.apply(this, arguments);
      };

      const onConfigure = this.onConfigure;
      this.onConfigure = function (info) {
        const out = onConfigure?.apply(this, arguments);
        for (const [name, def] of APPENDED_WIDGET_DEFAULTS) {
          const w = this.widgets.find(x => x.name === name);
          if (w && (w.value == null || w.value === "")) w.value = def;
        }
        setTimeout(() => {
          if (this._timelineEditor) {
            this._timelineEditor.timeline = parseInitial(
              this._timelineEditor.timelineDataWidget?.value,
              this._timelineEditor.getMaxFrames(),
            );
            this._timelineEditor.selectedIndex = clamp(
              this._timelineEditor.selectedIndex, 0,
              this._timelineEditor.timeline.segments.length - 1,
            );
            this._timelineEditor.updateUIFromSelection();
            this._timelineEditor.render();
          }
        }, 10);
        return out;
      };

      return r;
    };
  },
});