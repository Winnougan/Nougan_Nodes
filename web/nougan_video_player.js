// Nougan in-node video player.
//
// Replaces the browser's native <video controls>. The native bar crams play, time, scrub,
// volume and menu buttons into one strip (so they pile onto the scrubber when the node is
// narrow), and its volume popup fights with the canvas, which is where the glitching comes from.
//
// This one puts the scrubber on its own full-width row and the buttons on a row below it,
// handles volume itself, and keeps pointer / keyboard / wheel events off the canvas.
//
//   const player = createNouganPlayer({ onLayout: () => resizeNode() });
//   panel.appendChild(player.el);
//   player.load(url, { width, height });     // shows the player and starts playing (muted)
//   player.destroy();                        // call from node.onRemoved
//
// Put this file next to nougan_video_save.js in web/. It injects its own CSS.

const STYLE_ID = "nougan-player-style";

const CSS = `
.nvs-player{--nvs-accent:var(--nougan-theme-frame,var(--p-primary-color,#e67e22));--nvs-fg:var(--input-text,#d4d4d4);
  --nvs-dim:var(--descrip-text,#8a8a8a);--nvs-track:var(--border-color,#3a3a3a);
  display:flex;flex-direction:column;gap:6px;width:100%;box-sizing:border-box;margin-top:6px;outline:none;
  color:var(--nvs-fg);font:11px/1.3 system-ui,-apple-system,"Segoe UI",sans-serif;user-select:none}
.nvs-stage{position:relative;background:#000;border-radius:6px;overflow:hidden;line-height:0;cursor:pointer}
.nvs-video{display:block;width:100%;max-height:360px;object-fit:contain;background:#000}
.nvs-big{position:absolute;left:50%;top:50%;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;
  background:rgba(0,0,0,.55);display:none;align-items:center;justify-content:center;pointer-events:none}
.nvs-big svg{width:18px;height:18px;fill:#fff;margin-left:3px}
.nvs-paused .nvs-big{display:flex}

.nvs-controls{display:flex;flex-direction:column;gap:5px;padding:0 2px}
.nvs-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.nvs-btn{flex:none;width:26px;height:24px;padding:0;display:flex;align-items:center;justify-content:center;cursor:pointer;
  background:transparent;color:var(--nvs-dim);border:1px solid transparent;border-radius:4px}
.nvs-btn:hover{color:var(--nvs-fg);background:rgba(127,127,127,.16)}
.nvs-btn:focus-visible{outline:1px solid var(--nvs-accent)}
.nvs-btn svg{width:14px;height:14px;fill:currentColor}
.nvs-time{flex:none;color:var(--nvs-dim);font-variant-numeric:tabular-nums;white-space:nowrap}
.nvs-spacer{flex:1 1 auto}

.nvs-range{-webkit-appearance:none;appearance:none;display:block;height:14px;margin:0;padding:0;background:transparent;cursor:pointer}
.nvs-seek{width:100%}
.nvs-vol{flex:none;width:72px}
.nvs-range:focus{outline:none}
.nvs-range::-webkit-slider-runnable-track{height:4px;border-radius:2px;
  background:linear-gradient(to right,var(--nvs-accent) var(--p,0%),var(--nvs-track) var(--p,0%))}
.nvs-range::-webkit-slider-thumb{-webkit-appearance:none;width:11px;height:11px;margin-top:-3.5px;border-radius:50%;
  background:var(--nvs-fg);border:none}
.nvs-range::-moz-range-track{height:4px;border-radius:2px;background:var(--nvs-track)}
.nvs-range::-moz-range-progress{height:4px;border-radius:2px;background:var(--nvs-accent)}
.nvs-range::-moz-range-thumb{width:11px;height:11px;border-radius:50%;background:var(--nvs-fg);border:none}
.nvs-range:focus-visible::-webkit-slider-thumb{box-shadow:0 0 0 2px var(--nvs-accent)}

.nvs-msg{padding:4px 6px;color:#e5534b;font-size:10px}

.nvs-player:fullscreen{background:#000;justify-content:center;padding:16px;margin:0}
.nvs-player:fullscreen .nvs-video{max-height:calc(100vh - 110px)}
`;

const ICON = {
    play: '<svg viewBox="0 0 16 16"><path d="M4 2.5v11l9-5.5z"/></svg>',
    pause: '<svg viewBox="0 0 16 16"><path d="M3.5 2h3.5v12H3.5zM9 2h3.5v12H9z"/></svg>',
    vol: '<svg viewBox="0 0 16 16"><path d="M2 6h3l4-3.5v11L5 10H2z"/><path d="M11 5.2a4 4 0 0 1 0 5.6M12.8 3.4a6.6 6.6 0 0 1 0 9.2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
    mute: '<svg viewBox="0 0 16 16"><path d="M2 6h3l4-3.5v11L5 10H2z"/><path d="M11.5 6l3.5 4M15 6l-3.5 4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
    fs: '<svg viewBox="0 0 16 16"><path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = CSS;
    document.head.appendChild(s);
}

const mk = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
};

const fmt = (t) => {
    if (!Number.isFinite(t) || t < 0) t = 0;
    return `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
};

export function createNouganPlayer({ muted = true, loop = true, onLayout = null } = {}) {
    ensureStyle();

    const el = mk("div", "nvs-player nvs-paused");
    el.tabIndex = 0;
    el.style.display = "none";

    // ---- picture ----
    const stage = mk("div", "nvs-stage");
    const video = document.createElement("video");
    video.className = "nvs-video";
    video.muted = !!muted;
    video.loop = !!loop;
    video.playsInline = true;
    video.preload = "auto";
    video.controls = false;
    const big = mk("div", "nvs-big");
    big.innerHTML = ICON.play;
    stage.append(video, big);

    // ---- controls: scrubber on its own row, buttons on the row under it ----
    const controls = mk("div", "nvs-controls");
    const seek = mk("input", "nvs-range nvs-seek");
    seek.type = "range"; seek.min = "0"; seek.max = "1000"; seek.step = "1"; seek.value = "0";
    seek.title = "Seek";

    const bar = mk("div", "nvs-bar");
    const mkBtn = (icon, title) => {
        const b = mk("button", "nvs-btn");
        b.type = "button";
        b.title = title;
        b.innerHTML = icon;
        return b;
    };
    const playBtn = mkBtn(ICON.play, "Play / pause");
    const time = mk("span", "nvs-time", "0:00 / 0:00");
    const spacer = mk("span", "nvs-spacer");
    const muteBtn = mkBtn(ICON.mute, "Mute / unmute");
    const vol = mk("input", "nvs-range nvs-vol");
    vol.type = "range"; vol.min = "0"; vol.max = "100"; vol.step = "1"; vol.value = "100";
    vol.title = "Volume";
    const fsBtn = mkBtn(ICON.fs, "Fullscreen");
    bar.append(playBtn, time, spacer, muteBtn, vol, fsBtn);
    controls.append(seek, bar);

    const msg = mk("div", "nvs-msg");
    msg.style.display = "none";
    el.append(stage, controls, msg);

    // ---- state painting ----
    let seeking = false;
    let raf = 0;
    const setFill = (inp) => {
        const span = Number(inp.max) - Number(inp.min) || 1;
        inp.style.setProperty("--p", `${((Number(inp.value) - Number(inp.min)) / span) * 100}%`);
    };
    function paint() {
        const dur = video.duration;
        const ok = Number.isFinite(dur) && dur > 0;
        if (!seeking) {
            seek.value = ok ? String(Math.round((video.currentTime / dur) * 1000)) : "0";
            setFill(seek);
        }
        const cur = seeking && ok ? (Number(seek.value) / 1000) * dur : video.currentTime;
        const t = `${fmt(cur)} / ${fmt(ok ? dur : 0)}`;
        if (time.textContent !== t) time.textContent = t;
    }
    function paintPlay() {
        playBtn.innerHTML = video.paused ? ICON.play : ICON.pause;
        el.classList.toggle("nvs-paused", video.paused);
    }
    function paintVol() {
        const silent = video.muted || video.volume === 0;
        vol.value = String(silent ? 0 : Math.round(video.volume * 100));
        setFill(vol);
        muteBtn.innerHTML = silent ? ICON.mute : ICON.vol;
    }
    function loop_() {
        raf = 0;
        paint();
        if (!video.paused && !video.ended) raf = requestAnimationFrame(loop_);
    }

    // ---- actions ----
    const toggle = () => { if (video.paused) video.play().catch(() => {}); else video.pause(); };
    const toggleFs = () => {
        if (document.fullscreenElement === el) document.exitFullscreen?.();
        else el.requestFullscreen?.().catch?.(() => {});
    };

    playBtn.addEventListener("click", toggle);
    stage.addEventListener("click", toggle);
    stage.addEventListener("dblclick", (e) => { e.preventDefault(); toggleFs(); });
    fsBtn.addEventListener("click", toggleFs);

    muteBtn.addEventListener("click", () => {
        if (video.muted || video.volume === 0) {
            video.muted = false;
            if (video.volume === 0) video.volume = 0.5;
        } else {
            video.muted = true;
        }
    });
    const setVolume = (pct) => {
        const x = Math.max(0, Math.min(100, pct)) / 100;
        video.volume = x;
        video.muted = x === 0;
    };
    vol.addEventListener("input", () => setVolume(Number(vol.value)));
    vol.addEventListener("wheel", (e) => {
        e.preventDefault();
        e.stopPropagation();
        setVolume(Number(vol.value) + (e.deltaY < 0 ? 5 : -5));
    }, { passive: false });

    const endSeek = () => { if (seeking) { seeking = false; paint(); } };
    seek.addEventListener("input", () => {
        seeking = true;
        const dur = video.duration;
        if (Number.isFinite(dur) && dur > 0) video.currentTime = (Number(seek.value) / 1000) * dur;
        setFill(seek);
        paint();
    });
    for (const ev of ["change", "pointerup", "pointercancel", "blur"]) seek.addEventListener(ev, endSeek);

    // keep the controls' pointer / key events away from the canvas and ComfyUI hotkeys
    for (const ev of ["pointerdown", "mousedown", "touchstart", "keydown", "keyup", "dblclick", "contextmenu"]) {
        controls.addEventListener(ev, (e) => e.stopPropagation());
    }
    el.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.target !== el) return;
        if (e.code === "Space") { e.preventDefault(); toggle(); }
        else if (e.code === "ArrowLeft") { e.preventDefault(); video.currentTime = Math.max(0, video.currentTime - 1); }
        else if (e.code === "ArrowRight") { e.preventDefault(); video.currentTime += 1; }
    });
    el.addEventListener("keyup", (e) => e.stopPropagation());

    // ---- video events ----
    video.addEventListener("loadedmetadata", () => {
        if (video.videoWidth > 0 && video.videoHeight > 0) video.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
        msg.style.display = "none";
        paint();
        onLayout?.();
    });
    video.addEventListener("durationchange", paint);
    video.addEventListener("timeupdate", paint);
    video.addEventListener("volumechange", paintVol);
    video.addEventListener("play", () => { paintPlay(); if (!raf) raf = requestAnimationFrame(loop_); });
    video.addEventListener("pause", () => { paintPlay(); paint(); });
    video.addEventListener("ended", () => { paintPlay(); paint(); });
    video.addEventListener("error", () => {
        msg.textContent = "The browser can't play this file. Turn on preview_proxy, or open the saved file in a player.";
        msg.style.display = "";
        onLayout?.();
    });
    const onFsChange = () => onLayout?.();
    document.addEventListener("fullscreenchange", onFsChange);

    paintPlay();
    paintVol();
    setFill(seek);

    // ---- public ----
    function load(url, meta = {}) {
        msg.style.display = "none";
        el.style.display = "";
        if (meta.width > 0 && meta.height > 0) video.style.aspectRatio = `${meta.width} / ${meta.height}`;
        seeking = false;
        video.src = url;
        video.load();
        video.play().catch(() => {});
        paintPlay();
        paintVol();
        paint();
        onLayout?.();
    }
    function clear() {
        video.pause();
        video.removeAttribute("src");
        video.load();
        el.style.display = "none";
        paint();
    }
    function destroy() {
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
        document.removeEventListener("fullscreenchange", onFsChange);
        try { if (document.fullscreenElement === el) document.exitFullscreen?.(); } catch {}
        video.pause();
        video.removeAttribute("src");
        video.load();
        el.remove();
    }

    return { el, video, load, clear, destroy };
}
