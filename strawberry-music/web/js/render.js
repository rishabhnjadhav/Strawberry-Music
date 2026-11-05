/* ==========================================================================
   View rendering
   ========================================================================== */

import { player } from "./player.js";
import { store } from "./store.js";

/* -------------------------------------------------------------------------- */
/* Utilities                                                                  */
/* -------------------------------------------------------------------------- */

export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return char;
    }
  });
}

export function fmtTime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours) return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

export function fmtDuration(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  if (!total) return "";
  const totalMinutes = Math.round(total / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours) return minutes ? `${hours} hr ${minutes} min` : `${hours} hr`;
  return `${minutes} min`;
}

function plural(count, singular, pluralForm = `${singular}s`) {
  return `${count} ${Number(count) === 1 ? singular : pluralForm}`;
}

export function hashHue(text) {
  let hash = 0;
  const value = String(text || "omni");
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) % 360;
  }
  return hash;
}

export function icon(name, className = "") {
  return `<svg class="icon ${className}"><use href="#i-${name}"/></svg>`;
}

export function artHTML(item, className = "") {
  const seed = item?.title || item?.name || item?.playlistId || item?.browseId || "omni";
  const hue = hashHue(seed);
  const src = item?.thumb || item?.thumbnail || "";
  return `<div class="art ${className}" style="--h:${hue}">${
    src ? `<img src="${esc(src)}" alt="" loading="lazy" decoding="async">` : ""
  }</div>`;
}

function explicitBadge(track) {
  return track?.explicit ? '<span class="explicit" title="Explicit">E</span>' : "";
}

export function artistsHTML(artists, fallback = "Unknown artist") {
  if (!artists || !artists.length) return esc(fallback);
  return artists
    .filter((artist) => artist && artist.name)
    .map((artist) =>
      artist.id
        ? `<a href="#/artist/${encodeURIComponent(artist.id)}">${esc(artist.name)}</a>`
        : `<span>${esc(artist.name)}</span>`
    )
    .join(", ");
}

function trackArtistsHTML(track) {
  return artistsHTML(track.artists, track.artistText || "Unknown artist");
}

/* -------------------------------------------------------------------------- */
/* Play lists registry                                                        */
/* -------------------------------------------------------------------------- */

export const lists = new Map();
export const listMeta = new Map();
export const trackIndex = new Map();
let listSequence = 0;

export function registerList(tracks, meta) {
  const id = `list${++listSequence}`;
  lists.set(id, tracks);
  listMeta.set(id, meta || null);
  tracks.forEach((track) => {
    if (track?.videoId) trackIndex.set(track.videoId, track);
  });
  return id;
}

export function resetLists() {
  lists.clear();
  listMeta.clear();
  trackIndex.clear();
}

export function getTrack(videoId) {
  return trackIndex.get(videoId) || player.state.queue.find((track) => track.videoId === videoId) || null;
}

function isCurrent(track) {
  const active = player.current();
  return Boolean(active && track && active.videoId === track.videoId);
}

/* -------------------------------------------------------------------------- */
/* Buttons                                                                    */
/* -------------------------------------------------------------------------- */

function likeButton(track, extra = "") {
  const liked = store.isLiked(track.videoId);
  return `<button class="icon-btn like-btn ${liked ? "liked" : ""} ${extra}" data-action="like-track" data-video-id="${esc(
    track.videoId
  )}" aria-label="${liked ? "Unlike" : "Like"} ${esc(track.title)}">${icon("heart")}</button>`;
}

function menuButton(track, extra = "") {
  return `<button class="icon-btn ${extra}" data-action="track-menu" data-video-id="${esc(
    track.videoId
  )}" aria-label="More options for ${esc(track.title)}">${icon("more")}</button>`;
}

/* -------------------------------------------------------------------------- */
/* Track rows                                                                 */
/* -------------------------------------------------------------------------- */

function rowHTML(track, index, listId) {
  const active = isCurrent(track);
  const playing = active && player.state.playing;
  const hue = hashHue(track.title + track.artistText);
  return `
    <div class="trow ${active ? "is-current" : ""} ${active && !playing ? "paused" : ""}"
         data-action="play-track" data-list="${listId}" data-index="${index}"
         data-video-id="${esc(track.videoId)}" role="button" tabindex="0">
      <div class="trow-art">
        <div class="art" style="--h:${hue}">${
          track.thumb ? `<img src="${esc(track.thumb)}" alt="" loading="lazy" decoding="async">` : ""
        }</div>
        <span class="trow-play">${icon("play", "fill")}</span>
        <span class="row-eq"><i></i><i></i><i></i></span>
      </div>
      <div class="trow-meta">
        <div class="trow-title">${esc(track.title)} ${explicitBadge(track)}</div>
        <div class="trow-sub">${esc(track.artistText || "Unknown artist")}</div>
      </div>
      <div class="trow-side">
        <span class="dur">${esc(track.duration || fmtTime(track.durationSeconds))}</span>
        ${likeButton(track)}
        ${menuButton(track)}
      </div>
    </div>`;
}

export function trackRows(tracks, { meta = null, limit = 0 } = {}) {
  const items = (tracks || []).filter((track) => track && track.videoId);
  const visible = limit ? items.slice(0, limit) : items;
  if (!visible.length) return "";
  const listId = registerList(items, meta);
  return `<div class="rows-grid">${visible
    .map((track, index) => rowHTML(track, index, listId))
    .join("")}</div>`;
}

/* -------------------------------------------------------------------------- */
/* Track table                                                                */
/* -------------------------------------------------------------------------- */

function tableRowHTML(track, index, listId, { showAlbum, showArt }) {
  const active = isCurrent(track);
  const playing = active && player.state.playing;
  const album = track.album;
  return `
    <div class="tt-row ${active ? "is-current" : ""} ${playing ? "playing" : ""}"
         data-action="play-track" data-list="${listId}" data-index="${index}"
         data-video-id="${esc(track.videoId)}" role="button" tabindex="0">
      <div class="tt-index">
        <span class="num">${index + 1}</span>
        ${icon("play", "fill icon-play")}
        <span class="tt-eq"><i></i><i></i><i></i></span>
      </div>
      <div class="tt-main">
        ${showArt ? `<div class="tt-art">${artHTML(track)}</div>` : ""}
        <div class="tt-text">
          <div class="tt-title">${esc(track.title)} ${explicitBadge(track)}</div>
          <div class="tt-sub">${trackArtistsHTML(track)}</div>
        </div>
      </div>
      ${
        showAlbum
          ? `<div class="tt-album">${
              album && album.name
                ? album.id
                  ? `<a href="#/album/${encodeURIComponent(album.id)}">${esc(album.name)}</a>`
                  : esc(album.name)
                : ""
            }</div>`
          : ""
      }
      <div class="tt-dur">${esc(track.duration || fmtTime(track.durationSeconds))}</div>
      <div class="tt-actions">${likeButton(track)}${menuButton(track)}</div>
    </div>`;
}

export function trackTable(
  tracks,
  { meta = null, showAlbum = true, showArt = true, sticky = false, limit = 0 } = {}
) {
  const items = (tracks || []).filter((track) => track && track.videoId);
  if (!items.length) return "";
  const listId = registerList(items, meta);
  const visible = limit ? items.slice(0, limit) : items;
  return `
    <div class="track-table ${showAlbum ? "" : "compact"} ${sticky ? "sticky" : ""}">
      <div class="tt-head">
        <span>#</span>
        <span>Title</span>
        ${showAlbum ? "<span>Album</span>" : ""}
        <span class="tt-dur">Time</span>
        <span></span>
      </div>
      ${visible
        .map((track, index) => tableRowHTML(track, index, listId, { showAlbum, showArt }))
        .join("")}
    </div>`;
}

/* -------------------------------------------------------------------------- */
/* Cards                                                                      */
/* -------------------------------------------------------------------------- */

const PLATFORM_AUTHOR_NAMES = new Set(["youtube music", "youtube", "yt music", "ytmusic"]);

export function cleanAuthor(value) {
  const text = String(value || "").trim();
  return PLATFORM_AUTHOR_NAMES.has(text.toLowerCase()) ? "" : text;
}

function cardSubtitle(item) {
  const subtitle = cleanAuthor(item.subtitle);
  if (subtitle) return subtitle;
  if (item.kind === "artist") return "Artist";
  if (item.kind === "playlist") {
    const author = cleanAuthor(item.author);
    if (author) return author;
    if (item.itemCount) return `Playlist · ${plural(item.itemCount, "song")}`;
    return "Playlist";
  }
  return item.artistText || item.type || "Album";
}

function cardId(item) {
  if (item.kind === "artist") return item.browseId || item.id;
  if (item.kind === "playlist") return item.playlistId || item.browseId || item.id;
  return item.browseId || item.id;
}

export function card(item, { round = false } = {}) {
  if (!item || item.kind === "track") return "";
  const kind = item.kind;
  const id = cardId(item);
  if (!id) return "";
  const title = item.title || item.name || "Untitled";
  const subtitle = cardSubtitle(item);
  const isRound = round || kind === "artist";
  const openAction =
    kind === "artist" ? "open-artist" : kind === "playlist" ? "open-playlist" : "open-album";
  return `
    <article class="card ${isRound ? "is-round" : ""}"
             data-action="${openAction}" data-id="${esc(id)}" data-kind="${esc(kind)}"
             role="button" tabindex="0" aria-label="Open ${esc(title)} ${esc(subtitle)}">
      <div class="card-art">
        ${artHTML(item)}
        <button class="card-play" data-action="play-collection" data-kind="${esc(kind)}" data-id="${esc(
    id
  )}" aria-label="Play ${esc(title)}">${icon("play", "fill")}</button>
      </div>
      <div class="card-title">${esc(title)}</div>
      <div class="card-sub">${esc(subtitle)}</div>
    </article>`;
}

export function cardRow(items, { round = false } = {}) {
  const filtered = (items || []).filter((item) => item && item.kind && item.kind !== "track");
  if (!filtered.length) return "";
  return `<div class="shelf-track">${filtered.map((item) => card(item, { round })).join("")}</div>`;
}

export function cardsGrid(items, { round = false } = {}) {
  const filtered = (items || []).filter((item) => item && item.kind && item.kind !== "track");
  if (!filtered.length) return "";
  return `<div class="cards-grid">${filtered.map((item) => card(item, { round })).join("")}</div>`;
}

function mixCard(mix) {
  return `
    <article class="card mix-card" data-action="play-mix" data-mix="${esc(mix.id)}"
             role="button" tabindex="0" aria-label="Play ${esc(mix.title)} ${esc(mix.sub)}">
      <div class="card-art" style="--h:${mix.hue}">
        <span class="mix-initials">${esc(mix.initials)}</span>
        <button class="card-play" data-action="play-mix" data-mix="${esc(mix.id)}"
                aria-label="Play ${esc(mix.title)}">${icon("play", "fill")}</button>
      </div>
      <div class="card-title">${esc(mix.title)}</div>
      <div class="card-sub">${esc(mix.sub)}</div>
    </article>`;
}

/* -------------------------------------------------------------------------- */
/* Page furniture                                                             */
/* -------------------------------------------------------------------------- */

export function pageHead(title, subtitle = "", actions = "") {
  return `
    <div class="page-head">
      <div>
        <h1>${esc(title)}</h1>
        ${subtitle ? `<p class="head-sub">${subtitle}</p>` : ""}
      </div>
      ${actions ? `<div class="head-actions">${actions}</div>` : ""}
    </div>`;
}

export function sectionHead(title, { moreAction = "", moreLabel = "Show all", tools = "", small = "" } = {}) {
  return `
    <div class="section-head">
      <h2>${esc(title)} ${small ? `<small>${esc(small)}</small>` : ""}</h2>
      <div class="section-tools">
        ${
          moreAction
            ? `<button class="text-btn" data-action="${moreAction}">${esc(moreLabel)} ${icon("arrow-right")}</button>`
            : ""
        }
        ${tools}
      </div>
    </div>`;
}

function shelfSection(title, items, { scrollId = "" } = {}) {
  if (!items || !items.length) return "";
  const tools = scrollId
    ? `<div class="section-tools">
         <button class="round-btn" data-action="scroll-shelf" data-target="${scrollId}" data-dir="-1" aria-label="Scroll left">${icon(
        "chevron-left"
      )}</button>
         <button class="round-btn" data-action="scroll-shelf" data-target="${scrollId}" data-dir="1" aria-label="Scroll right">${icon(
        "chevron-right"
      )}</button>
       </div>`
    : "";
  return `<section class="section">
    ${sectionHead(title, { tools })}
    <div class="shelf-track" id="${scrollId}">${items
    .map((item) => card(item))
    .join("")}</div>
  </section>`;
}

export function emptyState({ iconName = "music", title, text, action = "", actionLabel = "" }) {
  return `<div class="empty">
    <div class="empty-icon">${icon(iconName)}</div>
    <h3>${esc(title)}</h3>
    ${text ? `<p>${esc(text)}</p>` : ""}
    ${action ? `<button class="text-btn" data-action="${action}">${esc(actionLabel)}</button>` : ""}
  </div>`;
}

export function errorView(title, message) {
  return `<div class="view">${emptyState({
    iconName: "radio",
    title,
    text: message,
    action: "retry",
    actionLabel: "Try again",
  })}</div>`;
}

/* -------------------------------------------------------------------------- */
/* Skeletons                                                                  */
/* -------------------------------------------------------------------------- */

export function skeletonHome() {
  const row = `<div class="sk-row"><div class="sk sk-art"></div><div class="sk-lines"><div class="sk sk-line w60"></div><div class="sk sk-line w35"></div></div></div>`;
  return `<div class="view">
    <div class="sk sk-line" style="width:180px;height:38px;margin-bottom:26px"></div>
    <div class="rows-grid">${row.repeat(6)}</div>
    <div class="sk-cards" style="margin-top:34px">${Array.from(
      { length: 6 },
      () => `<div class="sk-card"><div class="sk sk-art"></div><div class="sk sk-line w60"></div><div class="sk sk-line w35"></div></div>`
    ).join("")}</div>
  </div>`;
}

export function skeletonPage() {
  return `<div class="view">
    <div class="page-hero">
      <div class="sk sk-art" style="width:190px;height:190px;border-radius:14px"></div>
      <div style="flex:1">
        <div class="sk sk-line" style="width:80px"></div>
        <div class="sk sk-line" style="width:min(480px,70%);height:44px;margin-top:14px"></div>
        <div class="sk sk-line" style="width:260px;margin-top:14px"></div>
      </div>
    </div>
    <div style="margin-top:30px">${`<div class="sk-row"><div class="sk sk-art"></div><div class="sk-lines"><div class="sk sk-line w60"></div><div class="sk sk-line w35"></div></div></div>`.repeat(
      8
    )}</div>
  </div>`;
}

export function skeletonSearch() {
  return `
    <div class="sk sk-line" style="width:100%;height:54px;border-radius:14px;margin-top:20px"></div>
    <div style="margin-top:30px">${`<div class="sk-row"><div class="sk sk-art"></div><div class="sk-lines"><div class="sk sk-line w60"></div><div class="sk sk-line w35"></div></div></div>`.repeat(
      7
    )}</div>`;
}

/* -------------------------------------------------------------------------- */
/* Home                                                                       */
/* -------------------------------------------------------------------------- */

function greeting() {
  const hour = new Date().getHours();
  if (hour < 5) return "Good night";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

export function homeView(feed) {
  const history = store.data.history.slice(0, 9);
  const recent = store
    .recentPages()
    .filter((page) => page.kind === "album" || page.kind === "playlist")
    .slice(0, 12);
  const quickPicks = feed?.quickPicks || [];
  const shelves = (feed?.shelves || []).filter((shelf) => shelf.items?.length);
  const parts = [];

  if (history.length) {
    parts.push(`<section class="section">
      ${sectionHead("Recently played", {
        moreAction: "open-recent",
        moreLabel: "Show all",
      })}
      ${trackRows(history, { meta: { type: "recent", title: "Recently played" } })}
    </section>`);
  }

  if (recent.length) {
    parts.push(`<section class="section">
      ${sectionHead("Listen again", { moreAction: "open-recent", moreLabel: "Show all" })}
      ${cardRow(recent)}
    </section>`);
  }

  if (quickPicks.length) {
    parts.push(`<section class="section">
      ${sectionHead("Quick picks", {
        tools: `<button class="round-btn" data-action="refresh-home" title="Refresh" aria-label="Refresh home">${icon(
          "refresh"
        )}</button>`,
      })}
      ${trackRows(quickPicks, { meta: { type: "quick", title: "Quick picks" } })}
    </section>`);
  }

  shelves.forEach((shelf, index) => {
    const tracks = shelf.items.filter((item) => item.kind === "track");
    const others = shelf.items.filter((item) => item.kind !== "track");
    if (others.length) {
      parts.push(shelfSection(shelf.title, others, { scrollId: `shelf${index}` }));
    } else if (tracks.length) {
      parts.push(`<section class="section">
        ${sectionHead(shelf.title)}
        ${trackRows(tracks, { meta: { type: "shelf", title: shelf.title } })}
      </section>`);
    }
  });

  if (!parts.length) {
    parts.push(
      emptyState({
        iconName: "sparkle",
        title: "Your home is warming up",
        text: "Play a song or search for something new. Recommendations will appear here.",
        action: "open-search",
        actionLabel: "Search music",
      })
    );
  }

  return `<div class="view" data-view="home">
    ${pageHead("Home", `${greeting()} — here's what's moving today.`)}
    ${parts.join("")}
  </div>`;
}

/* -------------------------------------------------------------------------- */
/* Search                                                                     */
/* -------------------------------------------------------------------------- */

const SEARCH_TYPES = [
  { key: "all", label: "All" },
  { key: "songs", label: "Songs" },
  { key: "albums", label: "Albums" },
  { key: "artists", label: "Artists" },
  { key: "playlists", label: "Playlists" },
];

const GENRES = [
  { name: "Bollywood", q: "bollywood hits", h: 8 },
  { name: "Punjabi", q: "punjabi hits", h: 36 },
  { name: "Pop", q: "pop hits", h: 318 },
  { name: "Hip-Hop", q: "hip hop hits", h: 268 },
  { name: "Indie", q: "indie essentials", h: 196 },
  { name: "Chill", q: "chill lofi", h: 172 },
  { name: "Workout", q: "workout songs", h: 24 },
  { name: "Romance", q: "romantic songs", h: 338 },
  { name: "Rock", q: "rock classics", h: 0 },
  { name: "Devotional", q: "bhakti songs", h: 44 },
  { name: "Jazz", q: "jazz classics", h: 210 },
  { name: "K-Pop", q: "kpop hits", h: 292 },
];

export function genreTiles() {
  return `<div class="genre-grid">${GENRES.map(
    (genre) =>
      `<button class="genre-tile" data-action="genre" data-q="${esc(genre.q)}" style="--h:${genre.h}">
        <span>${esc(genre.name)}</span>
      </button>`
  ).join("")}</div>`;
}

export function searchView({ q = "", type = "all", data = null, loading = false, error = "" } = {}) {
  const recent = store.data.searches;
  const chips = q
    ? `<div class="chips">${SEARCH_TYPES.map(
        (item) =>
          `<button class="chip ${item.key === type ? "active" : ""}" data-action="search-filter" data-type="${item.key}">${
            item.label
          }</button>`
      ).join("")}</div>`
    : "";

  let body = "";

  if (!q) {
    body = `<div class="search-empty">
      ${
        recent.length
          ? `<section class="section" style="margin-top:18px">
              ${sectionHead("Recent searches", {
                tools: `<button class="text-btn" data-action="clear-searches">Clear</button>`,
              })}
              <div class="recent-searches">${recent
                .map(
                  (query) =>
                    `<button class="recent-chip" data-action="search-query" data-q="${esc(query)}">${icon(
                      "clock"
                    )}${esc(query)}</button>`
                )
                .join("")}</div>
            </section>`
          : ""
      }
      <section class="section" style="margin-top:${recent.length ? "30" : "8"}px">
        ${sectionHead("Browse all")}
        ${genreTiles()}
      </section>
    </div>`;
  } else if (loading) {
    body = skeletonSearch();
  } else if (error) {
    body = emptyState({
      iconName: "radio",
      title: "Search didn't go through",
      text: error,
      action: "retry",
      actionLabel: "Try again",
    });
  } else if (data) {
    body = searchResults(q, type, data);
  }

  return `<div class="view" data-view="search">
    <div class="search-head">
      <div class="search-box ${q ? "has-value" : ""}">
        ${icon("search")}
        <input id="searchInput" type="text" placeholder="Search songs, albums, artists…"
               autocomplete="off" spellcheck="false" value="${esc(q)}" aria-label="Search">
        <button class="icon-btn clear-btn" data-action="clear-search" aria-label="Clear search">${icon(
          "close"
        )}</button>
        <span class="search-hint">Enter</span>
        <div class="suggestions" id="suggestions"></div>
      </div>
      ${chips}
    </div>
    ${body}
  </div>`;
}

function searchResults(q, type, data) {
  const meta = { type: "search", title: `Search: ${q}` };
  const section = (title, items, kind, limit) => {
    if (!items || !items.length) return "";
    const more = `<button class="text-btn" data-action="search-filter" data-type="${kind}">Show all ${icon(
      "arrow-right"
    )}</button>`;
    const body =
      kind === "songs"
        ? trackTable(items, { meta, showAlbum: true, showArt: true, limit })
        : `<div class="cards-grid">${items
            .slice(0, limit || items.length)
            .map((item) => card(item))
            .join("")}</div>`;
    return `<section class="section">
      ${sectionHead(title, { tools: more })}
      ${body}
    </section>`;
  };

  if (type === "all") {
    const parts = [
      section("Songs", data.songs, "songs", 6),
      section("Albums", data.albums, "albums", 6),
      section("Artists", data.artists, "artists", 6),
      section("Playlists", data.playlists, "playlists", 6),
    ].filter(Boolean);
    if (!parts.length) {
      return emptyState({
        iconName: "search",
        title: `No results for "${q}"`,
        text: "Try a different spelling, or search for an artist, album or song.",
      });
    }
    return parts.join("");
  }

  if (type === "songs") {
    return data.items?.length
      ? `<section class="section" style="margin-top:8px">${trackTable(data.items, {
          meta,
          showAlbum: true,
          showArt: true,
        })}</section>`
      : emptyState({
          iconName: "music",
          title: `No songs for "${q}"`,
          text: "Try another search term.",
        });
  }

  return data.items?.length
    ? `<section class="section" style="margin-top:14px"><div class="cards-grid">${data.items
        .map((item) => card(item))
        .join("")}</div></section>`
    : emptyState({
        iconName: "music",
        title: `No ${type} for "${q}"`,
        text: "Try another search term.",
      });
}

/* -------------------------------------------------------------------------- */
/* Collection views                                                           */
/* -------------------------------------------------------------------------- */

function heroGlow(thumb) {
  return thumb ? `<div class="hero-glow" style="background-image:url('${esc(thumb)}')"></div>` : "";
}

function collectionActions(kind, id, { saved = false, local = false } = {}) {
  return `
    <div class="hero-actions">
      <button class="play-fab" data-action="play-collection" data-kind="${kind}" data-id="${esc(id)}">
        ${icon("play", "fill")}<span>Play</span>
      </button>
      <button class="play-fab ghost" data-action="shuffle-collection" data-kind="${kind}" data-id="${esc(id)}">
        ${icon("shuffle")}<span>Shuffle</span>
      </button>
      ${
        kind === "album"
          ? `<button class="round-btn ${saved ? "active" : ""}" data-action="toggle-save-album" data-id="${esc(
              id
            )}" title="${saved ? "Remove from library" : "Save album"}" aria-label="Save album">${icon("heart")}</button>`
          : ""
      }
      <button class="round-btn" data-action="collection-menu" data-kind="${kind}" data-id="${esc(
        id
      )}" aria-label="More options">${icon("more")}</button>
      ${
        local
          ? `<button class="round-btn" data-action="delete-playlist" data-id="${esc(id)}" title="Delete playlist" aria-label="Delete playlist">${icon(
              "trash"
            )}</button>`
          : ""
      }
    </div>`;
}

export function albumView(album) {
  const saved = store.isAlbumSaved(album.browseId);
  const meta = { type: "album", id: album.browseId, title: album.title, thumb: album.thumb };
  const totalSeconds = album.tracks.reduce((sum, track) => sum + (track.durationSeconds || 0), 0);
  const year = album.year ? `<span class="dot"></span><span>${esc(album.year)}</span>` : "";
  return `<div class="view" data-view="album">
    <div class="page-hero">
      ${heroGlow(album.thumb)}
      <div class="hero-art">${artHTML(album)}</div>
      <div class="hero-info">
        <span class="eyebrow">${esc(album.type || "Album")}</span>
        <h1 class="${album.title.length > 28 ? "long" : ""}">${esc(album.title)}</h1>
        <div class="hero-meta">
          ${artistsHTML(album.artists, album.artistText || "Unknown artist")}
          ${year}
          <span class="dot"></span><span>${plural(album.trackCount || album.tracks.length, "song")}</span>
          ${totalSeconds ? `<span class="dot"></span><span>${fmtDuration(totalSeconds)}</span>` : ""}
        </div>
        ${album.description ? `<p class="hero-desc">${esc(album.description)}</p>` : ""}
        ${collectionActions("album", album.browseId, { saved })}
      </div>
    </div>
    <div class="collection-body">
      ${trackTable(album.tracks, { meta, showAlbum: false, showArt: false, sticky: true })}
    </div>
    <p class="credits">${esc(album.year || "")}${album.year ? " · " : ""}${plural(
    album.tracks.length,
    "song"
  )}${totalSeconds ? `, ${fmtDuration(totalSeconds)}` : ""}</p>
  </div>`;
}

export function playlistView(playlist) {
  const meta = {
    type: "playlist",
    id: playlist.playlistId,
    title: playlist.title,
    thumb: playlist.thumb,
  };
  const totalSeconds = playlist.tracks.reduce((sum, track) => sum + (track.durationSeconds || 0), 0);
  return `<div class="view" data-view="playlist">
    <div class="page-hero">
      ${heroGlow(playlist.thumb)}
      <div class="hero-art">${artHTML(playlist)}</div>
      <div class="hero-info">
        <span class="eyebrow">${playlist.local ? "Your playlist" : "Playlist"}</span>
        <h1 class="${playlist.title.length > 28 ? "long" : ""}">${esc(playlist.title)}</h1>
        <div class="hero-meta">
          <span>${esc(cleanAuthor(playlist.author) || (playlist.local ? "You" : "Strawberry Music"))}</span>
          <span class="dot"></span><span>${plural(playlist.tracks.length, "song")}</span>
          ${totalSeconds ? `<span class="dot"></span><span>${fmtDuration(totalSeconds)}</span>` : ""}
        </div>
        ${playlist.description ? `<p class="hero-desc">${esc(playlist.description)}</p>` : ""}
        ${collectionActions("playlist", playlist.playlistId, { local: Boolean(playlist.local) })}
      </div>
    </div>
    <div class="collection-body">
      ${
        playlist.tracks.length
          ? trackTable(playlist.tracks, { meta, showAlbum: true, showArt: true, sticky: true })
          : `<div class="empty">
              <div class="empty-icon">${icon("music")}</div>
              <h3>This playlist is empty</h3>
              <p>Use the ••• menu on any track and choose “Add to playlist”.</p>
            </div>`
      }
    </div>
    <p class="credits">${plural(playlist.tracks.length, "song")}${
    totalSeconds ? `, ${fmtDuration(totalSeconds)}` : ""
  }</p>
  </div>`;
}

export function artistView(artist) {
  const meta = { type: "artist", id: artist.browseId, title: artist.name, thumb: artist.thumb };
  const songs = artist.songs || [];
  const albums = artist.albums || [];
  const singles = artist.singles || [];
  const related = artist.related || [];
  return `<div class="view" data-view="artist">
    <div class="page-hero">
      ${heroGlow(artist.thumb)}
      <div class="hero-art artist-art">${artHTML({ ...artist, title: artist.name })}</div>
      <div class="hero-info">
        <span class="eyebrow">Artist</span>
        <h1 class="${artist.name.length > 24 ? "long" : ""}">${esc(artist.name)}</h1>
        <div class="hero-meta">
          ${artist.subscribers ? `<span>${esc(artist.subscribers)}</span>` : ""}
          ${songs.length ? `<span class="dot"></span><span>${plural(songs.length, "popular song")}</span>` : ""}
        </div>
        ${artist.description ? `<p class="hero-desc">${esc(artist.description)}</p>` : ""}
        <div class="hero-actions">
          <button class="play-fab" data-action="play-collection" data-kind="artist" data-id="${esc(
            artist.browseId
          )}">${icon("play", "fill")}<span>Play</span></button>
          <button class="play-fab ghost" data-action="shuffle-collection" data-kind="artist" data-id="${esc(
            artist.browseId
          )}">${icon("shuffle")}<span>Shuffle</span></button>
          <button class="round-btn" data-action="artist-radio" data-id="${esc(artist.browseId)}" title="Start radio" aria-label="Start radio">${icon(
            "radio"
          )}</button>
        </div>
      </div>
    </div>
    ${
      songs.length
        ? `<section class="section">
            ${sectionHead("Popular")}
            ${trackTable(songs, { meta, showAlbum: true, showArt: true, limit: 10 })}
          </section>`
        : ""
    }
    ${albums.length ? shelfSection("Albums", albums, { scrollId: "artistAlbums" }) : ""}
    ${singles.length ? shelfSection("Singles & EPs", singles, { scrollId: "artistSingles" }) : ""}
    ${related.length ? shelfSection("Fans also like", related, { scrollId: "artistRelated" }) : ""}
  </div>`;
}

/* -------------------------------------------------------------------------- */
/* Library                                                                    */
/* -------------------------------------------------------------------------- */

export function likedView() {
  const tracks = store.likedTracks();
  const totalSeconds = tracks.reduce((sum, track) => sum + (track.durationSeconds || 0), 0);
  return `<div class="view" data-view="liked">
    <div class="page-hero liked-hero">
      <div class="hero-art">${icon("heart")}</div>
      <div class="hero-info">
        <span class="eyebrow">Your collection</span>
        <h1>Liked Music</h1>
        <div class="hero-meta">
          <span>${tracks.length} songs</span>
          ${totalSeconds ? `<span class="dot"></span><span>${fmtDuration(totalSeconds)}</span>` : ""}
        </div>
        <div class="hero-actions">
          <button class="play-fab" data-action="play-liked">${icon("play", "fill")}<span>Play</span></button>
          <button class="play-fab ghost" data-action="shuffle-liked">${icon("shuffle")}<span>Shuffle</span></button>
        </div>
      </div>
    </div>
    ${
      tracks.length
        ? `<div class="collection-body">${trackTable(tracks, {
            meta: { type: "liked", title: "Liked Music" },
            showAlbum: true,
            showArt: true,
            sticky: true,
          })}</div>`
        : emptyState({
            iconName: "heart",
            title: "Songs you like will appear here",
            text: "Tap the heart on any song to save it to your library.",
            action: "open-search",
            actionLabel: "Find something to like",
          })
    }
  </div>`;
}

export function recentView() {
  const tracks = store.data.history;
  return `<div class="view" data-view="recent">
    ${pageHead(
      "Recently played",
      tracks.length ? `${tracks.length} tracks from your listening history` : "Your listening history",
      tracks.length
        ? `<button class="text-btn" data-action="clear-history">${icon("trash")} Clear history</button>`
        : ""
    )}
    ${
      tracks.length
        ? `<div class="collection-body" style="margin-top:18px">${trackTable(tracks, {
            meta: { type: "recent", title: "Recently played" },
            showAlbum: true,
            showArt: true,
          })}</div>`
        : emptyState({
            iconName: "clock",
            title: "Nothing played yet",
            text: "Tracks you listen to will show up here so you can jump back in.",
            action: "open-search",
            actionLabel: "Start listening",
          })
    }
  </div>`;
}

export function artistsView() {
  const map = new Map();
  const addTrackArtist = (track) => {
    const artist = (track.artists || []).find((item) => item && item.id);
    if (!artist) return;
    if (!map.has(artist.id)) {
      map.set(artist.id, {
        kind: "artist",
        browseId: artist.id,
        name: artist.name,
        thumb: track.thumb || "",
      });
    }
  };
  store.data.history.forEach(addTrackArtist);
  store.likedTracks().forEach(addTrackArtist);
  store.recentPages("artist").forEach((page) => {
    if (!map.has(page.id)) {
      map.set(page.id, { kind: "artist", browseId: page.id, name: page.title, thumb: page.thumb });
    }
  });
  const artists = [...map.values()];

  return `<div class="view" data-view="artists">
    ${pageHead("Artists", artists.length ? `${artists.length} artists from your library` : "")}
    ${
      artists.length
        ? `<div class="section">${cardsGrid(artists, { round: true })}</div>`
        : emptyState({
            iconName: "mic",
            title: "No artists yet",
            text: "Artists you listen to will be collected here.",
            action: "open-search",
            actionLabel: "Discover artists",
          })
    }
  </div>`;
}

export function albumsView() {
  const map = new Map();
  store.savedAlbums().forEach((album) => map.set(album.browseId, album));
  store.recentPages("album").forEach((page) => {
    if (!map.has(page.id)) {
      map.set(page.id, {
        kind: "album",
        browseId: page.id,
        title: page.title,
        thumb: page.thumb,
        artistText: page.subtitle || "",
      });
    }
  });
  const albums = [...map.values()];

  return `<div class="view" data-view="albums">
    ${pageHead("Albums", albums.length ? `${albums.length} albums in your library` : "")}
    ${
      albums.length
        ? `<div class="section">${cardsGrid(albums)}</div>`
        : emptyState({
            iconName: "disc",
            title: "No albums saved",
            text: "Open an album and save it to keep it close.",
            action: "open-explore",
            actionLabel: "Explore albums",
          })
    }
  </div>`;
}

export function playlistsView() {
  const playlists = store.playlists().map((playlist) => ({
    kind: "playlist",
    playlistId: playlist.id,
    title: playlist.name,
    thumb: playlist.tracks[0]?.thumb || "",
    author: "You",
    itemCount: playlist.tracks.length,
    local: true,
  }));
  return `<div class="view" data-view="playlists">
    ${pageHead(
      "Playlists",
      playlists.length ? `${playlists.length} playlists` : "Build your own collections",
      `<button class="text-btn" data-action="create-playlist">${icon("plus")} New playlist</button>`
    )}
    <div class="section">
      <div class="cards-grid">
        <button class="card" data-action="create-playlist" style="text-align:left">
          <div class="card-art" style="display:grid;place-items:center;background:rgba(255,255,255,.04);border:1px dashed var(--line-strong);box-shadow:none">
            <span style="display:grid;place-items:center;width:52px;height:52px;border-radius:50%;background:var(--accent-soft);color:var(--accent)">${icon(
              "plus"
            )}</span>
          </div>
          <div class="card-title">New playlist</div>
          <div class="card-sub">Create a collection</div>
        </button>
        ${playlists.map((playlist) => card(playlist)).join("")}
      </div>
    </div>
    ${
      playlists.length
        ? ""
        : `<p class="credits">Playlists are stored locally in your browser. Add songs from any track menu.</p>`
    }
  </div>`;
}

export function madeView(mixes) {
  const onRepeat = store.topTracks(8);
  return `<div class="view" data-view="made">
    ${pageHead("Made for you", "Mixes tuned to what you've been playing.")}
    <div class="section">
      <div class="cards-grid">${mixes.map(mixCard).join("")}</div>
    </div>
    ${
      onRepeat.length
        ? `<section class="section">
            ${sectionHead("On repeat")}
            ${trackRows(onRepeat, { meta: { type: "mix", title: "On repeat" } })}
          </section>`
        : ""
    }
    <section class="section">
      ${sectionHead("Browse all")}
      ${genreTiles()}
    </section>
  </div>`;
}

/* -------------------------------------------------------------------------- */
/* Explore                                                                    */
/* -------------------------------------------------------------------------- */

export function exploreView(data) {
  const trending = data?.trending || [];
  const newReleases = data?.newReleases || [];
  const topArtists = data?.topArtists || [];
  const shelves = (data?.shelves || []).filter(
    (shelf) => shelf.items?.some((item) => item.kind !== "track") && shelf.items.length
  );

  return `<div class="view" data-view="explore">
    ${pageHead("Explore", "New releases, charts and sounds worth your time.")}
    ${
      topArtists.length
        ? `<section class="section">
            ${sectionHead("Top artists")}
            <div class="shelf-track">${topArtists.map((artist) => card(artist)).join("")}</div>
          </section>`
        : ""
    }
    ${
      newReleases.length
        ? `<section class="section">
            ${sectionHead("New releases")}
            <div class="shelf-track">${newReleases.map((album) => card(album)).join("")}</div>
          </section>`
        : ""
    }
    ${
      trending.length
        ? `<section class="section">
            ${sectionHead("Trending now")}
            ${trackRows(trending, { meta: { type: "explore", title: "Trending now" } })}
          </section>`
        : ""
    }
    <section class="section">
      ${sectionHead("Browse all")}
      ${genreTiles()}
    </section>
    ${shelves
      .slice(0, 3)
      .map((shelf, index) =>
        shelfSection(
          shelf.title,
          shelf.items.filter((item) => item.kind !== "track"),
          { scrollId: `exploreShelf${index}` }
        )
      )
      .join("")}
  </div>`;
}
