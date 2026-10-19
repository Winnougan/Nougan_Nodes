// web/nougan-album-cover.js
// Nougan Album Cover Maker — styled node + live "album card" (cover, title, artist, format badge, player)

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_ID = "NouganAlbumCoverMaker";
const STYLE_ID = "nougan-album-cover-style";

const CSS = `
.nac-card{
  box-sizing:border-box;width:100%;height:100%;padding:12px;border-radius:14px;
  display:flex;flex-direction:column;gap:10px;overflow:hidden;
  background:linear-gradient(145deg,#2b1d4a 0%,#1a1230 55%,#2a1633 100%);
  border:1px solid rgba(255,255,255,.08);box-shadow:inset 0 1px 0 rgba(255,255,255,.06);
  font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#f3eefc;
}
.nac-row{display:flex;gap:12px;align-items:center;min-height:0;flex:1 1 auto}
.nac-art{
  position:relative;flex:0 0 auto;aspect-ratio:1/1;height:100%;max-height:150px;border-radius:10px;
  overflow:hidden;background:radial-gradient(circle at 30% 30%,#3a2a66,#150e26);
  box-shadow:0 8px 22px rgba(0,0,0,.55),0 0 0 1px rgba(255,255,255,.08);
  display:flex;align-items:center;justify-content:center;
}
.nac-art img{width:100%;height:100%;object-fit:cover;display:block}
.nac-disc{font-size:46px;opacity:.55;animation:nac-spin 6s linear infinite}
@keyframes nac-spin{to{transform:rotate(360deg)}}
.nac-meta{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1 1 auto}
.nac-title{font-size:15px;font-weight:700;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.nac-artist{font-size:12.5px;opacity:.85;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.nac-album{font-size:11.5px;opacity:.55;font-style:italic;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.nac-badges{display:flex;gap:6px;margin-top:6px;flex-wrap:wrap}
.nac-badge{
  font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;padding:2px 8px;border-radius:999px;
  background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.12);
}
.nac-badge.hot{background:linear-gradient(90deg,#ff5fa2,#ffb457);color:#1a0f2a;border:none}
.nac-card audio{width:100%;height:30px;flex:0 0 auto;display:none;filter:invert(.92) hue-rotate(200deg) saturate(.8)}
.nac-card audio.on{display:block}
.nac-hint{font-size:11px;opacity:.45;text-align:center;flex:0 0 auto}
`;

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}

const viewURL = (f) =>
  api.apiURL(
    `/view?filename=${encodeURIComponent(f.filename)}&type=${f.type || "output"}` +
      `&subfolder=${encodeURIComponent(f.subfolder || "")}&rand=${Date.now()}`
  );

app.registerExtension({
  name: "Nougan.AlbumCoverMaker",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== NODE_ID) return;
    injectStyle();

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
      const node = this;

      // ── node look ──
      node.color = "#3b2760";
      node.bgcolor = "#1c1230";

      // ── album card ──
      const card = document.createElement("div");
      card.className = "nac-card";
      card.innerHTML = `
        <div class="nac-row">
          <div class="nac-art"><span class="nac-disc">💿</span></div>
          <div class="nac-meta">
            <div class="nac-title"></div>
            <div class="nac-artist"></div>
            <div class="nac-album"></div>
            <div class="nac-badges"></div>
          </div>
        </div>
        <audio controls preload="metadata"></audio>
        <div class="nac-hint">Run the workflow to embed the cover</div>`;

      const $ = (s) => card.querySelector(s);
      const art = $(".nac-art"), audioEl = $("audio"), hint = $(".nac-hint");
      const state = { cover: null, info: null };

      const wval = (name) => node.widgets?.find((w) => w.name === name)?.value ?? "";

      const render = () => {
        const info = state.info || {};
        const title = wval("title") || info.title || "Untitled";
        const artist = wval("artist") || info.artist || "Unknown artist";
        const album = wval("album") || info.album || "";
        $(".nac-title").textContent = title;
        $(".nac-artist").textContent = artist;
        $(".nac-album").textContent = album;

        const fmt = (wval("format") || "mp3").toString().toUpperCase();
        const badges = [`<span class="nac-badge hot">${fmt}</span>`];
        if (info.cover_size) badges.push(`<span class="nac-badge">cover ${info.cover_size}</span>`);
        $(".nac-badges").innerHTML = badges.join("");

        if (state.cover) {
          art.innerHTML = `<img src="${viewURL(state.cover)}" alt="cover">`;
        }
      };

      const domWidget = node.addDOMWidget("album_card", "album_card", card, {
        serialize: false,
        hideOnZoom: false,
        getMinHeight: () => 210,
      });
      domWidget.computeSize = (width) => [width, 220];

      // keep the card in sync with the widgets
      const hook = (name) => {
        const w = node.widgets?.find((x) => x.name === name);
        if (!w) return;
        const cb = w.callback;
        w.callback = function () {
          const out = cb ? cb.apply(this, arguments) : undefined;
          render();
          return out;
        };
      };
      ["title", "artist", "album", "format"].forEach(hook);

      node._nacSet = (message) => {
        state.cover = message?.cover?.[0] || state.cover;
        state.info = message?.info?.[0] || state.info;
        const a = message?.audio?.[0];
        if (a) {
          audioEl.src = viewURL(a);
          audioEl.classList.add("on");
        }
        hint.textContent = state.info?.file ? `Saved → ${state.info.file}` : "Saved";
        render();
      };

      render();
      node.setSize([Math.max(node.size[0], 360), Math.max(node.size[1], 470)]);
      return r;
    };

    const onExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      const r = onExecuted ? onExecuted.apply(this, arguments) : undefined;
      this._nacSet?.(message);
      return r;
    };
  },
});
