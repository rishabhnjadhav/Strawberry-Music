/* ==========================================================================
   Strawberry Music — application controller
   ========================================================================== */

import { api } from "./api.js";
import { player } from "./player.js";
import { store } from "./store.js";
import * as view from "./render.js";

const $ = (id) => document.getElementById(id);

const main = $("main");
const np = $("np");
const menu = $("menu");
const modalWrap = $("modalWrap");
const modal = $("modal");
const scrim = $("scrim");
const queuePanel = $("queuePanel");
const toastEl = $("toast");

const state = {
  route: { name: "home", id: null, query: new URLSearchParams() },
  home: null,
  homeAt: 0,
  homeError: "",
  explore: null,
  exploreAt: 0,
  search: { q: "", type: "all", data: null, loading: false, error: "" },
  cache: new Map(),
  renderToken: 0,
  currentView: null,
  mixes: [],
  npTab: "upnext",
  focusSearch: false,
  suggestionTimer: null,
  health: null,
  lastArtUrl: "",
};

const CACHE_TTL = 5 * 60 * 1000;
const THEME_KEY = "strawberry.theme";

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function go(path) {
  const hash = path.startsWith("#") ? path : `#${path}`;
  if (location.hash === hash) {
    route();
  } else {
    location.hash = hash;
  }
}

function setDocTitle(title) {
  document.title = title ? `${title} — Strawberry Music` : "Strawberry Music";
}

function applyTheme(theme, persist = true) {
  const next = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", next === "dark" ? "#101014" : "#ffffff");
  if (persist) {
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch (_) {
      /* Storage can be unavailable in private contexts. */
    }
  }
  document.querySelectorAll("[data-theme-choice]").forEach((button) => {
    const active = button.dataset.themeChoice === next;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function toast(message) {
  toastEl.textContent = message;
  toastEl.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => toastEl.classList.remove("show"), 2800);
}

function isLocalHost() {
  return ["localhost", "127.0.0.1", "::1"].includes(location.hostname);
}

function applyHealth(health) {
  state.health = health;
  player.setNeedsAuth(!isLocalHost() && !health?.authenticated);
}

async function refreshHealth() {
  try {
    applyHealth(await api.health());
  } catch {
    /* health is optional; playback still works locally */
  }
}

function cached(key, producer, ttl = CACHE_TTL) {
  const hit = state.cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return Promise.resolve(hit.data);
  return producer().then((data) => {
    state.cache.set(key, { data, at: Date.now() });
    return data;
  });
}

function uniqueTracks(tracks) {
  const seen = new Set();
  return (tracks || []).filter((track) => {
    if (!track || !track.videoId || seen.has(track.videoId)) return false;
    seen.add(track.videoId);
    return true;
  });
}

function seededShuffle(items, seed) {
  const array = [...items];
  let value = seed;
  for (let index = array.length - 1; index > 0; index -= 1) {
    value = (value * 9301 + 49297) % 233280;
    const swap = Math.floor((value / 233280) * (index + 1));
    [array[index], array[swap]] = [array[swap], array[index]];
  }
  return array;
}

function contextLabel(context) {
  if (!context) return "Strawberry Music";
  const labels = {
    album: "Album",
    playlist: "Playlist",
    artist: "Artist",
    radio: "Radio",
    liked: "Liked Music",
    mix: "Mix",
    search: "Search",
    quick: "Quick picks",
    recent: "Recently played",
    single: "Single",
  };
  return `${labels[context.type] || "Playing"} · ${context.title || ""}`;
}

/* -------------------------------------------------------------------------- */
/* Sidebar                                                                    */
/* -------------------------------------------------------------------------- */

function renderSidebarPlaylists() {
  const container = $("sidePlaylists");
  if (!container) return;
  const playlists = store.playlists();
  const signature = playlists.map((playlist) => `${playlist.id}:${playlist.name}`).join("|");
  if (container.dataset.signature === signature) return;
  container.dataset.signature = signature;
  container.innerHTML = playlists
    .slice(0, 10)
    .map(
      (playlist) => `<a href="#/playlist/${encodeURIComponent(playlist.id)}">
        ${view.icon("playlist")}<span>${view.esc(playlist.name)}</span>
      </a>`
    )
    .join("");
}

function setActiveNav(name) {
  const map = {
    home: "home",
    explore: "explore",
    search: "search",
    recent: "recent",
    artists: "artists",
    albums: "albums",
    liked: "liked-playlists",
    made: "made",
    playlists: "playlists",
    playlist: "playlists",
    album: "albums",
    artist: "artists",
  };
  const active = map[name] || "";
  document.querySelectorAll("[data-nav-link]").forEach((link) => {
    link.classList.toggle("is-active", link.dataset.navLink === active);
  });
}

function closeSidebar() {
  document.body.classList.remove("sidebar-open");
  updateScrim();
}

function updateScrim() {
  const open = queuePanel.classList.contains("open") || document.body.classList.contains("sidebar-open");
  scrim.classList.toggle("show", open);
}

/* -------------------------------------------------------------------------- */
/* Routing                                                                    */
/* -------------------------------------------------------------------------- */

function parseRoute() {
  const raw = location.hash.replace(/^#/, "") || "/home";
  const [pathPart, queryPart] = raw.split("?");
  const segments = pathPart.split("/").filter(Boolean);
  let id = null;
  if (segments[1]) {
    try {
      id = decodeURIComponent(segments[1]);
    } catch {
      id = segments[1];
    }
  }
  return {
    name: segments[0] || "home",
    id,
    query: new URLSearchParams(queryPart || ""),
  };
}

async function route() {
  const parsed = parseRoute();
  state.route = parsed;
  const token = ++state.renderToken;

  closeMenu();
  closeModal();
  closeQueue();
  closeSidebar();
  if (player.state.fullscreen) player.setFullscreen(false);

  view.resetLists();
  state.currentView = null;
  main.scrollTop = 0;
  setActiveNav(parsed.name);

  switch (parsed.name) {
    case "home":
      await renderHome(token);
      break;
    case "search":
      await renderSearch(token, parsed.query);
      break;
    case "explore":
      await renderExplore(token);
      break;
    case "album":
      await renderAlbumPage(token, parsed.id);
      break;
    case "playlist":
      await renderPlaylistPage(token, parsed.id);
      break;
    case "artist":
      await renderArtistPage(token, parsed.id);
      break;
    case "liked":
      paint(token, view.likedView());
      setDocTitle("Liked Music");
      break;
    case "recent":
      paint(token, view.recentView());
      setDocTitle("Recently played");
      break;
    case "artists":
      paint(token, view.artistsView());
      setDocTitle("Artists");
      break;
    case "albums":
      paint(token, view.albumsView());
      setDocTitle("Albums");
      break;
    case "playlists":
      paint(token, view.playlistsView());
      setDocTitle("Playlists");
      break;
    case "made":
      await renderMade(token);
      break;
    default:
      go("/home");
  }
}

function paint(token, html) {
  if (token !== state.renderToken) return false;
  main.innerHTML = `${html}
    <footer class="app-footer">
      <span>Strawberry Music</span>
      <span class="app-footer-credit">Developed by <strong>Rishabh Jadhav</strong></span>
    </footer>`;
  return true;
}

/* -------------------------------------------------------------------------- */
/* Views                                                                      */
/* -------------------------------------------------------------------------- */

async function renderHome(token) {
  const fresh = state.home && Date.now() - state.homeAt < CACHE_TTL;
  if (fresh) {
    paint(token, view.homeView(state.home));
    setDocTitle("Home");
    return;
  }
  if (!state.home) paint(token, view.skeletonHome());

  try {
    const feed = await api.home();
    if (token !== state.renderToken) return;
    state.home = feed;
    state.homeAt = Date.now();
    state.homeError = "";
    paint(token, view.homeView(feed));
    setDocTitle("Home");
  } catch (error) {
    if (token !== state.renderToken) return;
    state.homeError = error.message;
    if (state.home) {
      paint(token, view.homeView(state.home));
      toast("Could not refresh Home. Showing what we have.");
    } else {
      paint(token, view.errorView("Could not load Home", error.message));
      setDocTitle("Home");
    }
  }
}

async function renderSearch(token, query) {
  const q = (query.get("q") || "").trim();
  const type = query.get("type") || "all";
  state.search = { q, type, data: null, loading: Boolean(q), error: "" };

  paint(token, view.searchView({ q, type, loading: Boolean(q) }));
  setDocTitle(q ? `Search: ${q}` : "Search");
  if (state.focusSearch) focusSearchInput();

  if (!q) return;
  store.addSearch(q);

  try {
    const data = await api.search(q, type, type === "all" ? 8 : 50);
    if (token !== state.renderToken) return;
    state.search.data = data;
    state.search.loading = false;
    paint(token, view.searchView({ q, type, data }));
    setDocTitle(`${q} — Search`);
  } catch (error) {
    if (token !== state.renderToken) return;
    state.search.loading = false;
    state.search.error = error.message;
    paint(token, view.searchView({ q, type, error: error.message }));
  }
}

async function renderExplore(token) {
  if (state.explore && Date.now() - state.exploreAt < 10 * 60 * 1000) {
    paint(token, view.exploreView(state.explore));
    setDocTitle("Explore");
    return;
  }
  paint(token, view.skeletonHome());
  try {
    const data = await cached("explore", () => api.explore(), 10 * 60 * 1000);
    if (token !== state.renderToken) return;
    state.explore = data;
    state.exploreAt = Date.now();
    paint(token, view.exploreView(data));
    setDocTitle("Explore");
  } catch (error) {
    if (token !== state.renderToken) return;
    paint(token, view.errorView("Could not load Explore", error.message));
  }
}

async function renderAlbumPage(token, id) {
  if (!id) {
    go("/home");
    return;
  }
  paint(token, view.skeletonPage());
  try {
    const album = await cached(`album:${id}`, () => api.album(id));
    if (token !== state.renderToken) return;
    state.currentView = { type: "album", id, data: album };
    store.addRecentPage({
      kind: "album",
      id: album.browseId,
      title: album.title,
      thumb: album.thumb,
      subtitle: album.artistText || album.type || "Album",
    });
    paint(token, view.albumView(album));
    setDocTitle(album.title);
  } catch (error) {
    if (token !== state.renderToken) return;
    paint(token, view.errorView("Could not open this album", error.message));
  }
}

async function renderPlaylistPage(token, id) {
  if (!id) {
    go("/playlists");
    return;
  }

  if (id.startsWith("local_")) {
    const playlist = store.getPlaylist(id);
    if (!playlist) {
      paint(
        token,
        view.errorView("Playlist not found", "This playlist may have been deleted.")
      );
      return;
    }
    const data = {
      kind: "playlist",
      playlistId: playlist.id,
      title: playlist.name,
      author: "You",
      description: playlist.description || "",
      thumb: playlist.tracks[0]?.thumb || "",
      tracks: playlist.tracks,
      local: true,
    };
    state.currentView = { type: "playlist", id, data };
    paint(token, view.playlistView(data));
    setDocTitle(playlist.name);
    return;
  }

  paint(token, view.skeletonPage());
  try {
    const playlist = await cached(`playlist:${id}`, () => api.playlist(id, 500));
    if (token !== state.renderToken) return;
    state.currentView = { type: "playlist", id, data: playlist };
    store.addRecentPage({
      kind: "playlist",
      id,
      title: playlist.title,
      thumb: playlist.thumb,
      subtitle: view.cleanAuthor(playlist.author) || "Playlist",
    });
    paint(token, view.playlistView(playlist));
    setDocTitle(playlist.title);
  } catch (error) {
    if (token !== state.renderToken) return;
    paint(token, view.errorView("Could not open this playlist", error.message));
  }
}

async function renderArtistPage(token, id) {
  if (!id) {
    go("/home");
    return;
  }
  paint(token, view.skeletonPage());
  try {
    const artist = await cached(`artist:${id}`, () => api.artist(id));
    if (token !== state.renderToken) return;
    state.currentView = { type: "artist", id, data: artist };
    store.addRecentPage({
      kind: "artist",
      id: artist.browseId,
      title: artist.name,
      thumb: artist.thumb,
      subtitle: artist.subscribers || "Artist",
    });
    paint(token, view.artistView(artist));
    setDocTitle(artist.name);
  } catch (error) {
    if (token !== state.renderToken) return;
    paint(token, view.errorView("Could not open this artist", error.message));
  }
}

async function renderMade(token) {
  if (!state.home) {
    paint(token, view.skeletonHome());
    try {
      state.home = await api.home();
      state.homeAt = Date.now();
    } catch (error) {
      if (token !== state.renderToken) return;
      paint(token, view.errorView("Could not build your mixes", error.message));
      return;
    }
  }

  const liked = store.likedTracks();
  const history = store.data.history;
  const quick = state.home?.quickPicks || [];
  const trending = state.explore?.trending || [];
  const pool = uniqueTracks([...liked, ...history, ...quick, ...trending]);
  const mixes = [
    {
      id: "onrepeat",
      title: "On Repeat",
      sub: "Your most played",
      hue: 20,
      initials: "OR",
      tracks: uniqueTracks([...store.topTracks(24), ...liked]).slice(0, 30),
    },
    {
      id: "daily1",
      title: "Daily Mix 1",
      sub: "Made for you",
      hue: 336,
      initials: "01",
      tracks: seededShuffle(pool, 17).slice(0, 25),
    },
    {
      id: "daily2",
      title: "Daily Mix 2",
      sub: "A little of everything",
      hue: 268,
      initials: "02",
      tracks: seededShuffle(pool, 31).slice(0, 25),
    },
    {
      id: "chill",
      title: "Chill Mix",
      sub: "Slow down",
      hue: 170,
      initials: "CH",
      tracks: seededShuffle(pool, 53).slice(0, 22),
    },
    {
      id: "energy",
      title: "Energy Mix",
      sub: "Turn it up",
      hue: 42,
      initials: "EN",
      tracks: seededShuffle(pool, 71).slice(0, 22),
    },
    {
      id: "discovery",
      title: "Discovery",
      sub: "Fresh finds",
      hue: 200,
      initials: "DS",
      tracks: seededShuffle(uniqueTracks([...trending, ...quick]), 89).slice(0, 22),
    },
  ].filter((mix) => mix.tracks.length);

  state.mixes = mixes;
  paint(token, view.madeView(mixes));
  setDocTitle("Made for you");
}

/* -------------------------------------------------------------------------- */
/* Playback helpers                                                           */
/* -------------------------------------------------------------------------- */

function playDefault() {
  const tracks = uniqueTracks([
    ...(state.home?.quickPicks || []),
    ...store.data.history,
    ...store.likedTracks(),
  ]);
  if (!tracks.length) {
    toast("Nothing to play yet — search for a song.");
    return;
  }
  player.playTracks(tracks, 0, { type: "quick", title: "Quick picks", thumb: tracks[0].thumb });
}

async function playCollection(kind, id, shuffle = false) {
  try {
    let data;
    let tracks;
    let meta;

    if (kind === "album") {
      data = await cached(`album:${id}`, () => api.album(id));
      tracks = data.tracks;
      meta = { type: "album", id, title: data.title, thumb: data.thumb };
      state.currentView = { type: "album", id, data };
      store.addRecentPage({
        kind: "album",
        id,
        title: data.title,
        thumb: data.thumb,
        subtitle: data.artistText || "Album",
      });
    } else if (kind === "playlist") {
      if (id.startsWith("local_")) {
        const playlist = store.getPlaylist(id);
        if (!playlist) throw new Error("Playlist not found");
        data = {
          title: playlist.name,
          tracks: playlist.tracks,
          thumb: playlist.tracks[0]?.thumb || "",
        };
      } else {
        data = await cached(`playlist:${id}`, () => api.playlist(id, 500));
        store.addRecentPage({
          kind: "playlist",
          id,
          title: data.title,
          thumb: data.thumb,
          subtitle: view.cleanAuthor(data.author) || "Playlist",
        });
      }
      tracks = data.tracks;
      meta = { type: "playlist", id, title: data.title, thumb: data.thumb };
    } else if (kind === "artist") {
      data = await cached(`artist:${id}`, () => api.artist(id));
      tracks = data.songs;
      meta = { type: "artist", id, title: data.name, thumb: data.thumb };
    } else {
      return;
    }

    if (!tracks || !tracks.length) {
      toast("Nothing to play here yet.");
      return;
    }

    if (shuffle) {
      player.setShuffle(true);
      player.playTracks(tracks, Math.floor(Math.random() * tracks.length), meta);
    } else {
      player.playTracks(tracks, 0, meta);
    }
  } catch (error) {
    toast(error.message);
  }
}

function playLiked(shuffle = false) {
  const tracks = store.likedTracks();
  if (!tracks.length) {
    toast("Like a few songs first.");
    return;
  }
  const meta = { type: "liked", title: "Liked Music", thumb: tracks[0]?.thumb };
  if (shuffle) player.setShuffle(true);
  player.playTracks(tracks, shuffle ? Math.floor(Math.random() * tracks.length) : 0, meta);
}

function playMix(id) {
  const mix = state.mixes.find((item) => item.id === id);
  if (!mix || !mix.tracks.length) {
    toast("This mix needs a little more listening history.");
    return;
  }
  player.playTracks(mix.tracks, 0, {
    type: "mix",
    id: mix.id,
    title: mix.title,
    thumb: mix.tracks[0]?.thumb,
  });
}

async function startRadio(track) {
  if (!track) return;
  try {
    toast("Tuning your radio…");
    const data = await api.watch(track.videoId, 50);
    if (!data.tracks?.length) throw new Error("No radio tracks returned");
    const index = Math.max(
      0,
      data.tracks.findIndex((item) => item.videoId === track.videoId)
    );
    player.playTracks(data.tracks, index, {
      type: "radio",
      id: track.videoId,
      title: `${track.title} Radio`,
      thumb: track.thumb,
    });
    toast("Radio started");
  } catch (error) {
    toast(`Could not start radio: ${error.message}`);
  }
}

async function startArtistRadio(id) {
  try {
    const artist = await cached(`artist:${id}`, () => api.artist(id));
    if (!artist.songs?.length) {
      toast("No songs available for this artist.");
      return;
    }
    await startRadio(artist.songs[0]);
  } catch (error) {
    toast(error.message);
  }
}

/* -------------------------------------------------------------------------- */
/* Player UI                                                                  */
/* -------------------------------------------------------------------------- */

function setImage(img, url) {
  if (!img) return;
  const holder = img.parentElement;
  if (url) {
    if (img.dataset.src !== url) {
      img.dataset.src = url;
      img.style.display = "";
      img.src = url;
    }
    holder?.classList.remove("no-img");
  } else {
    img.removeAttribute("src");
    img.dataset.src = "";
    img.style.display = "none";
    holder?.classList.add("no-img");
  }
}

function syncLikeButtons() {
  document.querySelectorAll('[data-action="like-track"]').forEach((button) => {
    const liked = store.isLiked(button.dataset.videoId);
    button.classList.toggle("liked", liked);
    button.setAttribute("aria-label", liked ? "Unlike" : "Like");
  });
}

function syncPlayer() {
  const track = player.current();
  const hasTrack = Boolean(track);
  const title = hasTrack ? track.title : "Nothing playing";
  const artist = hasTrack ? track.artistText || "Unknown artist" : "Pick a song to start";

  $("pTitle").textContent = title;
  $("pArtist").textContent = artist;
  setImage($("pImg"), track?.thumb || "");

  $("npTitle").textContent = title;
  const artistLink = $("npArtist");
  artistLink.textContent = hasTrack ? artist : "Strawberry Music";
  const artistId = track?.artists?.find((item) => item && item.id)?.id;
  if (artistId) artistLink.setAttribute("href", `#/artist/${encodeURIComponent(artistId)}`);
  else artistLink.removeAttribute("href");
  setImage($("npImg"), track?.thumb || "");

  const bg = $("npBg");
  bg.style.backgroundImage = track?.thumb ? `url("${track.thumb}")` : "none";
  $("npContext").textContent = contextLabel(player.state.context);

  const liked = store.isLiked(track?.videoId);
  $("pLike").classList.toggle("liked", liked);
  $("npLike").classList.toggle("liked", liked);

  const playing = player.state.playing;
  const loading = player.state.loading;
  $("pPlay").classList.toggle("playing", playing);
  $("pPlay").classList.toggle("loading", loading);
  $("pPlay").setAttribute("aria-label", playing ? "Pause" : "Play");
  $("npPlay").classList.toggle("playing", playing);
  $("npPlay").classList.toggle("loading", loading);
  $("npPlay").setAttribute("aria-label", playing ? "Pause" : "Play");

  $("pShuffle").classList.toggle("active", player.state.shuffle);
  $("npShuffle").classList.toggle("active", player.state.shuffle);
  $("pRepeat").classList.toggle("active", player.state.repeat !== "off");
  $("npRepeat").classList.toggle("active", player.state.repeat !== "off");
  const repeatIcon = player.state.repeat === "one" ? "repeat-one" : "repeat";
  $("pRepeat").querySelector("use")?.setAttribute("href", `#i-${repeatIcon}`);
  $("npRepeat").querySelector("use")?.setAttribute("href", `#i-${repeatIcon}`);

  const volume = Math.round(player.state.volume * 100);
  $("pVol").value = String(volume);
  $("pVol").style.setProperty("--p", `${volume}%`);
  $("pMute").classList.toggle("muted", player.state.muted || volume === 0);

  const upcoming = Math.max(0, player.state.queue.length - player.state.index - 1);
  $("qCount").textContent = String(upcoming);
  $("qCount").classList.toggle("show", upcoming > 0);

  if (hasTrack) {
    setDocTitle(`${title} • ${artist}`);
    if (track.thumb !== state.lastArtUrl) {
      state.lastArtUrl = track.thumb || "";
      applyDynamicColor(track.thumb);
    }
  } else {
    setDocTitle("Strawberry Music");
    if (state.lastArtUrl) {
      state.lastArtUrl = "";
      applyDynamicColor("");
    }
  }

  syncTime();
}

function syncTime() {
  const duration = player.state.duration || 0;
  const current = player.state.currentTime || 0;
  const percent = duration ? Math.min(100, (current / duration) * 100) : 0;

  $("pCur").textContent = view.fmtTime(current);
  $("pDur").textContent = view.fmtTime(duration);
  $("npCur").textContent = view.fmtTime(current);
  $("npDur").textContent = view.fmtTime(duration);

  [
    ["pSeek", 1000],
    ["npSeek", 1000],
  ].forEach(([id, max]) => {
    const input = $(id);
    if (!input) return;
    if (document.activeElement !== input) {
      input.value = String(Math.round((percent / 100) * max));
    }
    input.style.setProperty("--p", `${percent}%`);
  });

  $("player").style.setProperty("--pp", `${percent}%`);
  syncLyricsHighlight();
}

let colorCache = new Map();
let colorToken = 0;

function extractColor(url) {
  return new Promise((resolve) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => {
      try {
        const size = 18;
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        context.drawImage(image, 0, 0, size, size);
        const data = context.getImageData(0, 0, size, size).data;
        let red = 0;
        let green = 0;
        let blue = 0;
        let weight = 0;
        for (let index = 0; index < data.length; index += 4) {
          const r = data[index];
          const g = data[index + 1];
          const b = data[index + 2];
          if (data[index + 3] < 128) continue;
          const max = Math.max(r, g, b);
          const min = Math.min(r, g, b);
          if (max < 26) continue;
          if (max - min < 12 && max > 205) continue;
          const w = 1 + (max - min) / 55;
          red += r * w;
          green += g * w;
          blue += b * w;
          weight += w;
        }
        if (!weight) {
          resolve(null);
          return;
        }
        red /= weight;
        green /= weight;
        blue /= weight;
        const max = Math.max(red, green, blue) || 1;
        const boost = Math.min(1.55, 185 / max);
        resolve(
          `${Math.min(255, Math.round(red * boost))}, ${Math.min(
            255,
            Math.round(green * boost)
          )}, ${Math.min(255, Math.round(blue * boost))}`
        );
      } catch {
        resolve(null);
      }
    };
    image.onerror = () => resolve(null);
    image.src = url;
  });
}

async function applyDynamicColor(url) {
  const token = ++colorToken;
  if (!url) {
    document.documentElement.style.setProperty("--dyn", "250, 55, 95");
    return;
  }
  let color = colorCache.get(url);
  if (color === undefined) {
    color = (await extractColor(url)) || "";
    colorCache.set(url, color);
  }
  if (token !== colorToken) return;
  document.documentElement.style.setProperty("--dyn", color || "250, 55, 95");
}

/* -------------------------------------------------------------------------- */
/* Fullscreen                                                                 */
/* -------------------------------------------------------------------------- */

function openFullscreen(tab) {
  if (!player.current()) {
    toast("Play something first.");
    return;
  }
  if (tab) state.npTab = tab;
  player.setFullscreen(true);
}

function closeFullscreen() {
  player.setFullscreen(false);
}

function updateNPTabs() {
  document.querySelectorAll(".np-tab").forEach((button) => {
    button.classList.toggle("active", button.dataset.npTab === state.npTab);
  });
}

function setNpTab(tab) {
  state.npTab = tab === "lyrics" ? "lyrics" : "upnext";
  updateNPTabs();
  lastLyricLine = null;
  renderNPPanel();
  if (state.npTab === "lyrics") requestAnimationFrame(syncLyricsHighlight);
}

function renderNPPanel() {
  const panel = $("npPanel");
  if (!panel) return;

  if (state.npTab === "lyrics") {
    renderLyrics(panel);
    return;
  }

  const queue = player.state.queue;
  const index = player.state.index;
  const context = player.state.context;
  const autoplay = player.state.autoplay;

  const header = `<div class="np-panel-head">
    <p>Playing from <strong>${view.esc(context?.title || "Strawberry Music")}</strong></p>
    <button class="autoplay-toggle" data-action="toggle-autoplay" aria-pressed="${autoplay}">
      <span class="switch ${autoplay ? "on" : ""}"></span> Autoplay
    </button>
  </div>`;

  if (!queue.length) {
    panel.innerHTML = `${header}${view.emptyState({
      iconName: "queue",
      title: "Your queue is empty",
      text: "Play a song to start a queue.",
    })}`;
    return;
  }

  const rows = queue
    .slice(index, index + 60)
    .map((track, offset) => {
      const itemIndex = index + offset;
      return upNextRow(track, itemIndex, itemIndex === index);
    })
    .join("");

  panel.innerHTML = `${header}<div class="upnext-list">${rows}</div>`;
}

function upNextRow(track, index, active) {
  return `<div class="upnext-row ${active ? "is-current" : ""}" data-action="play-queue"
               data-index="${index}" role="button" tabindex="0">
    ${view.artHTML(track)}
    <div class="meta">
      <div class="title">${view.esc(track.title)}</div>
      <div class="sub">${view.esc(track.artistText || "")}</div>
    </div>
    <span class="dur">${view.esc(track.duration || view.fmtTime(track.durationSeconds))}</span>
    <button class="icon-btn" data-action="remove-queue" data-index="${index}" aria-label="Remove from queue">
      ${view.icon("close")}
    </button>
  </div>`;
}

function renderLyrics(panel) {
  lastLyricLine = null;

  if (player.state.lyricsLoading) {
    panel.innerHTML = `<div class="lyrics">${Array.from(
      { length: 8 },
      (_, index) =>
        `<div class="sk sk-line" style="width:${55 + ((index * 13) % 40)}%;height:22px;border-radius:6px"></div>`
    ).join("")}</div>`;
    return;
  }

  const lyrics = player.state.lyrics;
  if (!lyrics || (!lyrics.lines?.length && !lyrics.plain)) {
    panel.innerHTML = `<div class="lyrics-empty">
      ${view.icon("lyrics")}
      <h4>Lyrics aren't available</h4>
      <p>We couldn't find lyrics for this track. Some songs don't have them yet.</p>
    </div>`;
    return;
  }

  if (lyrics.synced && lyrics.lines?.length) {
    panel.innerHTML = `<div class="lyrics">${lyrics.lines
      .map(
        (line) =>
          `<button class="lyric-line" data-action="seek-lyric" data-time="${line.time}">${view.esc(
            line.text
          )}</button>`
      )
      .join("")}<div class="lyrics-source">Synced lyrics</div></div>`;
  } else {
    panel.innerHTML = `<div class="lyrics">${(lyrics.plain || "")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => `<div class="lyric-line plain">${view.esc(line)}</div>`)
      .join("")}<div class="lyrics-source">Lyrics</div></div>`;
  }

  requestAnimationFrame(syncLyricsHighlight);
}

let lastLyricLine = null;

function syncLyricsHighlight() {
  if (!player.state.fullscreen || state.npTab !== "lyrics") return;
  const panel = $("npPanel");
  if (!panel) return;
  const lines = panel.querySelectorAll(".lyric-line[data-time]");
  if (!lines.length) return;

  const time = player.state.currentTime || 0;
  let active = null;
  lines.forEach((line) => {
    if (parseFloat(line.dataset.time) <= time + 0.25) active = line;
  });
  if (active === lastLyricLine) return;
  lastLyricLine = active;
  lines.forEach((line) => line.classList.toggle("active", line === active));

  if (active) {
    const panelRect = panel.getBoundingClientRect();
    const lineRect = active.getBoundingClientRect();
    const top =
      panel.scrollTop +
      (lineRect.top - panelRect.top) -
      panel.clientHeight / 2 +
      lineRect.height / 2;
    panel.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
  }
}

/* -------------------------------------------------------------------------- */
/* Queue drawer                                                               */
/* -------------------------------------------------------------------------- */

function toggleQueue(force) {
  const open = force === undefined ? !queuePanel.classList.contains("open") : Boolean(force);
  queuePanel.classList.toggle("open", open);
  queuePanel.setAttribute("aria-hidden", String(!open));
  if (open) {
    closeMenu();
    renderQueue();
  }
  updateScrim();
}

function closeQueue() {
  queuePanel.classList.remove("open");
  queuePanel.setAttribute("aria-hidden", "true");
  updateScrim();
}

function renderQueue() {
  const queue = player.state.queue;
  const index = player.state.index;
  const body = $("queueBody");
  if (!body) return;

  const upcoming = Math.max(0, queue.length - index - 1);
  $("queueSub").textContent = queue.length
    ? `${upcoming} up next · ${contextLabel(player.state.context)}`
    : "Nothing queued";

  if (!queue.length) {
    body.innerHTML = view.emptyState({
      iconName: "queue",
      title: "Your queue is empty",
      text: "Play a song to start a queue.",
    });
    return;
  }

  let html = `<div class="queue-label">Now playing</div>${queueRow(queue[index], index, true)}`;
  if (index + 1 < queue.length) {
    html += `<div class="queue-label">Next up</div>`;
    for (let cursor = index + 1; cursor < queue.length; cursor += 1) {
      html += queueRow(queue[cursor], cursor, false);
    }
  }
  body.innerHTML = html;
}

function queueRow(track, index, active) {
  if (!track) return "";
  return `<div class="qrow ${active ? "is-current" : ""}" data-action="play-queue"
               data-index="${index}" role="button" tabindex="0">
    <div class="qrow-art">${view.artHTML(track)}</div>
    <div class="qrow-meta">
      <div class="qrow-title">${view.esc(track.title)}</div>
      <div class="qrow-sub">${view.esc(track.artistText || "")}</div>
    </div>
    <span class="qrow-dur">${view.esc(track.duration || view.fmtTime(track.durationSeconds))}</span>
    <button class="icon-btn" data-action="remove-queue" data-index="${index}" aria-label="Remove from queue">
      ${view.icon("close")}
    </button>
  </div>`;
}

/* -------------------------------------------------------------------------- */
/* Menus                                                                      */
/* -------------------------------------------------------------------------- */

function showMenu(items, anchor) {
  menu.innerHTML = "";
  items.forEach((item) => {
    if (item.divider) {
      menu.appendChild(document.createElement("hr"));
      return;
    }
    const button = document.createElement("button");
    button.type = "button";
    button.innerHTML = `${view.icon(item.icon || "music")}<span></span>`;
    button.querySelector("span").textContent = item.label;
    if (item.danger) button.classList.add("danger");
    button.addEventListener("click", () => {
      closeMenu();
      item.action();
    });
    menu.appendChild(button);
  });

  menu.hidden = false;
  const rect = anchor?.getBoundingClientRect();
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  let x = rect ? rect.right - width : 20;
  let y = rect ? rect.bottom + 6 : 20;
  if (rect && y + height > window.innerHeight - 10) y = rect.top - height - 6;
  x = Math.max(8, Math.min(x, window.innerWidth - width - 8));
  y = Math.max(8, Math.min(y, window.innerHeight - height - 8));
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
}

function closeMenu() {
  menu.hidden = true;
  menu.innerHTML = "";
}

function openTrackMenu(track, anchor) {
  if (!track) return;
  const liked = store.isLiked(track.videoId);
  const artistWithId = track.artists?.find((item) => item && item.id) || null;
  const artistId = artistWithId?.id;
  const albumId = track.album?.id;

  const items = [
    {
      label: "Play now",
      icon: "play",
      action: () =>
        player.playTracks([track], 0, {
          type: "single",
          title: track.title,
          thumb: track.thumb,
        }),
    },
    { label: "Play next", icon: "list", action: () => player.playNext(track) },
    { label: "Add to queue", icon: "plus", action: () => player.addToQueue(track) },
    {
      label: liked ? "Remove from Liked Music" : "Add to Liked Music",
      icon: "heart",
      action: () => {
        store.toggleLike(track);
        syncLikeButtons();
        syncPlayer();
        toast(liked ? "Removed from Liked Music" : "Added to Liked Music");
        if (!liked && state.route.name === "liked") route();
      },
    },
    { divider: true },
    { label: "Start radio", icon: "radio", action: () => startRadio(track) },
  ];

  if (artistId) {
    items.push({
      label: `Go to ${artistWithId?.name || track.artists?.[0]?.name || "artist"}`,
      icon: "mic",
      action: () => go(`/artist/${encodeURIComponent(artistId)}`),
    });
  }
  if (albumId) {
    items.push({
      label: "Go to album",
      icon: "disc",
      action: () => go(`/album/${encodeURIComponent(albumId)}`),
    });
  }
  items.push({ divider: true });
  items.push({
    label: "Add to playlist…",
    icon: "playlist",
    action: () => openAddToPlaylist(track),
  });

  const localPlaylist = store.playlists().find(
    (playlist) =>
      playlist.id?.startsWith("local_") &&
      (playlist.tracks || []).some((item) => item?.videoId === track.videoId)
  );
  if (localPlaylist) {
    items.push({ divider: true });
    items.push({
      label: `Remove from “${localPlaylist.name}”`,
      icon: "trash",
      danger: true,
      action: () => {
        store.removeFromPlaylist(localPlaylist.id, track.videoId);
        renderSidebarPlaylists();
        if (state.route.name === "playlist" && state.route.id === localPlaylist.id) {
          go(`/playlist/${encodeURIComponent(localPlaylist.id)}`);
        } else {
          route();
        }
        toast("Removed from playlist");
      },
    });
  }

  showMenu(items, anchor);
}

async function openCollectionMenu(kind, id, anchor) {
  let data = state.currentView?.type === kind && state.currentView.id === id
    ? state.currentView.data
    : null;

  if (!data) {
    try {
      if (kind === "album") data = await cached(`album:${id}`, () => api.album(id));
      else if (kind === "playlist" && !id.startsWith("local_")) {
        data = await cached(`playlist:${id}`, () => api.playlist(id, 500));
      } else if (kind === "playlist") {
        const playlist = store.getPlaylist(id);
        if (playlist) {
          data = { title: playlist.name, tracks: playlist.tracks, local: true };
        }
      } else if (kind === "artist") {
        data = await cached(`artist:${id}`, () => api.artist(id));
      }
    } catch (error) {
      toast(error.message);
      return;
    }
  }

  if (!data) return;
  const tracks = data.tracks || data.songs || [];
  const title = data.title || data.name || "this collection";
  const items = [
    {
      label: "Play",
      icon: "play",
      action: () => playCollection(kind, id, false),
    },
    {
      label: "Shuffle",
      icon: "shuffle",
      action: () => playCollection(kind, id, true),
    },
    {
      label: "Add all to queue",
      icon: "plus",
      action: () => {
        if (!tracks.length) return;
        if (!player.state.queue.length) {
          player.playTracks(tracks, 0, { type: kind, id, title, thumb: data.thumb });
        } else {
          tracks.forEach((track) => player.addToQueue(track));
          toast(`${tracks.length} tracks added to queue`);
        }
      },
    },
  ];

  if (kind === "album") {
    items.push({
      label: store.isAlbumSaved(id) ? "Remove from library" : "Save album",
      icon: "heart",
      action: () => toggleSaveAlbum(id),
    });
  }

  items.push({
    label: "Copy link",
    icon: "download",
    action: async () => {
      try {
        await navigator.clipboard.writeText(location.href);
        toast("Link copied");
      } catch {
        toast("Could not copy link");
      }
    },
  });

  if (kind === "playlist" && id.startsWith("local_")) {
    items.push({ divider: true });
    items.push({
      label: "Delete playlist",
      icon: "trash",
      danger: true,
      action: () => confirmDeletePlaylist(id),
    });
  }

  showMenu(items, anchor);
}

/* -------------------------------------------------------------------------- */
/* Modals                                                                     */
/* -------------------------------------------------------------------------- */

function openModal(html) {
  modal.innerHTML = html;
  modal.setAttribute("aria-label", modal.querySelector("h2")?.textContent?.trim() || "Dialog");
  modalWrap.hidden = false;
  setTimeout(() => {
    if (modalWrap.hidden) return;
    const focusTarget =
      modal.querySelector("input") ||
      modal.querySelector('.theme-option[aria-pressed="true"]') ||
      modal.querySelector(".theme-option") ||
      modal.querySelector(".btn.primary") ||
      modal.querySelector(".btn");
    focusTarget?.focus();
  }, 30);
}

function closeModal() {
  modalWrap.hidden = true;
  modal.innerHTML = "";
}

function confirmModal(title, text, confirmLabel, onConfirm) {
  openModal(`<h2>${view.esc(title)}</h2>
    <p>${view.esc(text)}</p>
    <div class="modal-actions">
      <button class="btn" data-close>Cancel</button>
      <button class="btn primary" id="confirmAction">${view.esc(confirmLabel)}</button>
    </div>`);
  modal.querySelectorAll("[data-close]").forEach((button) => {
    button.addEventListener("click", closeModal);
  });
  $("confirmAction").addEventListener("click", () => {
    closeModal();
    onConfirm();
  });
}

function openCreatePlaylist(pendingTrack = null) {
  openModal(`<h2>New playlist</h2>
    <p>${pendingTrack ? `Add “${view.esc(pendingTrack.title)}” to a new playlist.` : "Give your playlist a name. You can add songs later from any track menu."}</p>
    <div class="modal-field">
      <label for="playlistName">Playlist name</label>
      <input id="playlistName" class="modal-input" maxlength="80" placeholder="My playlist" autocomplete="off">
    </div>
    <div class="modal-actions">
      <button class="btn" data-close>Cancel</button>
      <button class="btn primary" id="createPlaylistAction">Create</button>
    </div>`);

  const input = $("playlistName");
  const create = () => {
    const name = input.value.trim();
    if (!name) {
      input.focus();
      return;
    }
    const playlist = store.createPlaylist(name);
    if (pendingTrack) store.addToPlaylist(playlist.id, pendingTrack);
    closeModal();
    renderSidebarPlaylists();
    toast(`Created “${playlist.name}”`);
    if (pendingTrack) go(`/playlist/${encodeURIComponent(playlist.id)}`);
    else route();
  };

  modal.querySelectorAll("[data-close]").forEach((button) => {
    button.addEventListener("click", closeModal);
  });
  $("createPlaylistAction").addEventListener("click", create);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") create();
  });
}

function openAddToPlaylist(track) {
  const playlists = store.playlists();
  const list = playlists.length
    ? playlists
        .map(
          (playlist) => `<button class="modal-list-item" data-playlist="${view.esc(playlist.id)}">
            ${view.icon("playlist")}<span>${view.esc(playlist.name)}</span>
            <span class="count">${playlist.tracks.length}</span>
          </button>`
        )
        .join("")
    : `<p style="margin-top:12px">You don't have any playlists yet.</p>`;

  openModal(`<h2>Add to playlist</h2>
    <p>Choose a playlist for “${view.esc(track.title)}”.</p>
    <div class="modal-list">${list}</div>
    <div class="modal-actions">
      <button class="btn" data-close>Cancel</button>
      <button class="btn primary" id="newPlaylistForTrack">New playlist</button>
    </div>`);

  modal.querySelectorAll("[data-close]").forEach((button) => {
    button.addEventListener("click", closeModal);
  });
  modal.querySelectorAll("[data-playlist]").forEach((button) => {
    button.addEventListener("click", () => {
      const added = store.addToPlaylist(button.dataset.playlist, track);
      closeModal();
      toast(added ? "Added to playlist" : "Already in that playlist");
      renderSidebarPlaylists();
      if (state.route.name === "playlist" && state.route.id === button.dataset.playlist) route();
    });
  });
  $("newPlaylistForTrack").addEventListener("click", () => openCreatePlaylist(track));
}

async function openSettings() {
  openModal(`<h2>Strawberry Music</h2>
    <p>Your music, beautifully organized.</p>
    <div id="settingsStatus"><div class="status-line"><span>Checking server…</span></div></div>
    <div class="modal-field">
      <label>Appearance</label>
      <div class="theme-picker" role="group" aria-label="Appearance">
        <button type="button" class="theme-option" data-theme-choice="light" aria-pressed="false">
          ${view.icon("sun")}<span>Light</span>
        </button>
        <button type="button" class="theme-option" data-theme-choice="dark" aria-pressed="false">
          ${view.icon("moon")}<span>Dark</span>
        </button>
      </div>
    </div>
    <div class="modal-field">
      <label>YouTube Music</label>
      <div id="ytAuthStatus"><div class="status-line"><span>Checking…</span></div></div>
      <div id="ytAuthFields" hidden>
        <div class="modal-field">
          <label for="ytAuthHeaders">Paste headers from music.youtube.com</label>
          <textarea id="ytAuthHeaders" class="modal-input" rows="6" placeholder="Cookie=...; Authorization=..."></textarea>
        </div>
        <p style="margin:0 0 10px;color:var(--muted,#7b7b86);font-size:13px;line-height:1.45">
          Open music.youtube.com while signed in, press F12, open Network, click any request,
          then copy the full Request Headers block and paste it here.
        </p>
        <button class="btn primary" id="ytConnect">Connect YouTube Music</button>
      </div>
      <div id="ytDisconnectWrap" hidden>
        <button class="btn" id="ytDisconnect">Disconnect YouTube Music</button>
      </div>
    </div>
    <div class="modal-field">
      <label>Keyboard shortcuts</label>
      <div class="shortcuts">
        <span>Play / pause</span><kbd>Space</kbd>
        <span>Next / previous</span><kbd>N / P</kbd>
        <span>Seek 5 seconds</span><kbd>← →</kbd>
        <span>Volume</span><kbd>↑ ↓</kbd>
        <span>Like current song</span><kbd>L</kbd>
        <span>Full screen</span><kbd>F</kbd>
        <span>Queue</span><kbd>Q</kbd>
        <span>Search</span><kbd>/</kbd>
        <span>This panel</span><kbd>?</kbd>
      </div>
    </div>
    <div class="modal-field">
      <label>Credits</label>
      <div class="credit-line">
        <span>Developed by</span>
        <strong>Rishabh Jadhav</strong>
      </div>
    </div>
    <div class="status-line" style="border-top:0;padding-top:4px;justify-content:flex-end">
      <button class="text-btn danger-text" id="clearLibrary">Clear local library</button>
    </div>
    <div class="modal-actions">
      <button class="btn primary" data-close>Done</button>
    </div>`);

  modal.querySelectorAll("[data-close]").forEach((button) => {
    button.addEventListener("click", closeModal);
  });

  modal.querySelectorAll("[data-theme-choice]").forEach((button) => {
    button.addEventListener("click", () => applyTheme(button.dataset.themeChoice));
  });
  applyTheme(document.documentElement.dataset.theme || "light", false);

  $("clearLibrary").addEventListener("click", () => {
    confirmModal(
      "Clear local library?",
      "This removes your likes, playlists and listening history from this browser. It cannot be undone.",
      "Clear everything",
      () => {
        store.reset();
        player.clearQueue();
        state.cache.clear();
        state.home = null;
        state.homeAt = 0;
        renderSidebarPlaylists();
        toast("Local library cleared");
        route();
      }
    );
  });

  $("ytConnect").addEventListener("click", async () => {
    const headers = $("ytAuthHeaders").value.trim();
    if (!headers) {
      toast("Paste the music.youtube.com headers first.");
      return;
    }
    try {
      const data = await api.authConnect(headers);
      applyHealth({ ...(state.health || {}), ...data });
      state.home = null;
      state.homeAt = 0;
      state.explore = null;
      state.exploreAt = 0;
      state.cache.clear();
      if (modalWrap.hidden) return;
      $("ytAuthFields").hidden = true;
      $("ytDisconnectWrap").hidden = false;
      $("ytAuthStatus").innerHTML = `
        <div class="status-line">
          <span><span class="dot-ok"></span>YouTube Music</span><span>connected</span>
        </div>`;
      toast("YouTube Music connected");
      if (state.route.name === "home") route();
    } catch (error) {
      toast(error.message || "Could not connect YouTube Music");
    }
  });

  $("ytDisconnect").addEventListener("click", async () => {
    try {
      const data = await api.authDisconnect();
      applyHealth({ ...(state.health || {}), ...data });
      state.home = null;
      state.homeAt = 0;
      state.explore = null;
      state.exploreAt = 0;
      state.cache.clear();
      if (modalWrap.hidden) return;
      $("ytAuthFields").hidden = false;
      $("ytDisconnectWrap").hidden = true;
      $("ytAuthStatus").innerHTML = `
        <div class="status-line">
          <span><span class="dot-warn"></span>YouTube Music</span><span>on this device</span>
        </div>`;
      toast("YouTube Music disconnected");
      if (state.route.name === "home") route();
    } catch (error) {
      toast(error.message || "Could not disconnect YouTube Music");
    }
  });

  try {
    const health = state.health || (await api.health());
    applyHealth(health);
    if (modalWrap.hidden) return;
    const auth = Boolean(health.authenticated);
    $("ytAuthFields").hidden = auth;
    $("ytDisconnectWrap").hidden = !auth;
    $("ytAuthStatus").innerHTML = `
      <div class="status-line">
        <span><span class="${auth ? "dot-ok" : "dot-warn"}"></span>YouTube Music</span><span>${auth ? "connected" : "on this device"}</span>
      </div>`;
    $("settingsStatus").innerHTML = `
      <div class="status-line">
        <span><span class="dot-ok"></span>API server</span><span>online</span>
      </div>
      <div class="status-line">
        <span><span class="${auth ? "dot-ok" : "dot-warn"}"></span>YouTube Music</span><span>${auth ? "connected" : "on this device"}</span>
      </div>
      <div class="status-line">
        <span>Region</span><span>${view.esc(health.country || "")}</span>
      </div>
      <div class="status-line">
        <span>Audio engine</span><span>ready</span>
      </div>
      <div class="status-line">
        <span>Resolved streams</span><span>${health.streams?.resolved ?? 0}</span>
      </div>`;
  } catch (error) {
    if (modalWrap.hidden) return;
    $("settingsStatus").innerHTML = `<div class="status-line">
      <span><span class="dot-warn"></span>API server</span><span>offline</span>
    </div>`;
  }
}

function confirmDeletePlaylist(id) {
  const playlist = store.getPlaylist(id);
  if (!playlist) return;
  confirmModal(
    "Delete playlist?",
    `“${playlist.name}” will be removed from your local library.`,
    "Delete",
    () => {
      store.deletePlaylist(id);
      renderSidebarPlaylists();
      toast("Playlist deleted");
      if (state.route.name === "playlist" && state.route.id === id) go("/playlists");
      else route();
    }
  );
}

function toggleSaveAlbum(id) {
  const album =
    state.currentView?.type === "album" && state.currentView.id === id
      ? state.currentView.data
      : state.cache.get(`album:${id}`)?.data;

  if (!album) {
    toast("Album details are still loading.");
    return;
  }
  const saved = store.toggleSavedAlbum(album);
  toast(saved ? "Album saved to your library" : "Album removed from your library");
  document.querySelectorAll('[data-action="toggle-save-album"]').forEach((button) => {
    if (button.dataset.id === id) button.classList.toggle("active", saved);
  });
}

/* -------------------------------------------------------------------------- */
/* Search helpers                                                             */
/* -------------------------------------------------------------------------- */

function focusSearchInput() {
  requestAnimationFrame(() => {
    const input = $("searchInput");
    if (input) {
      input.focus();
      const length = input.value.length;
      input.setSelectionRange(length, length);
    }
    state.focusSearch = false;
  });
}

function navigateSearch(q, type = "all", focus = false) {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (type && type !== "all") params.set("type", type);
  const query = params.toString();
  const hash = `#/search${query ? `?${query}` : ""}`;
  state.focusSearch = focus;
  if (location.hash === hash) route();
  else location.hash = hash;
}

function onSearchInput(input) {
  const box = input.closest(".search-box");
  box?.classList.toggle("has-value", Boolean(input.value));
  clearTimeout(state.suggestionTimer);
  const query = input.value.trim();
  if (!query) {
    closeSuggestions();
    return;
  }
  state.suggestionTimer = setTimeout(async () => {
    try {
      const items = await api.suggestions(query);
      if ($("searchInput")?.value.trim() !== query) return;
      renderSuggestions(items);
    } catch {
      closeSuggestions();
    }
  }, 220);
}

function renderSuggestions(items) {
  const box = $("suggestions");
  if (!box) return;
  if (!items.length) {
    closeSuggestions();
    return;
  }
  box.innerHTML = items
    .slice(0, 8)
    .map(
      (suggestion) =>
        `<button class="suggestion" data-action="search-query" data-q="${view.esc(suggestion)}">
          ${view.icon("search")}<span>${view.esc(suggestion)}</span>
        </button>`
    )
    .join("");
  box.classList.add("open");
}

function closeSuggestions() {
  $("suggestions")?.classList.remove("open");
}

/* -------------------------------------------------------------------------- */
/* Actions                                                                    */
/* -------------------------------------------------------------------------- */

async function handleAction(element) {
  const action = element.dataset.action;
  const id = element.dataset.id;

  switch (action) {
    case "play-track": {
      const list = view.lists.get(element.dataset.list);
      if (!list) return;
      player.playTracks(
        list,
        Number(element.dataset.index) || 0,
        view.listMeta.get(element.dataset.list)
      );
      break;
    }

    case "like-track": {
      const track = view.getTrack(element.dataset.videoId);
      if (!track) return;
      const liked = store.toggleLike(track);
      syncLikeButtons();
      syncPlayer();
      toast(liked ? "Added to Liked Music" : "Removed from Liked Music");
      if (!liked && state.route.name === "liked") route();
      break;
    }

    case "like-current": {
      const track = player.current();
      if (!track) return;
      const liked = store.toggleLike(track);
      syncLikeButtons();
      syncPlayer();
      toast(liked ? "Added to Liked Music" : "Removed from Liked Music");
      if (!liked && state.route.name === "liked") route();
      break;
    }

    case "track-menu": {
      const track = view.getTrack(element.dataset.videoId);
      if (track) openTrackMenu(track, element);
      break;
    }

    case "current-menu":
      openTrackMenu(player.current(), element);
      break;

    case "open-album":
      go(`/album/${encodeURIComponent(id)}`);
      break;
    case "open-playlist":
      go(`/playlist/${encodeURIComponent(id)}`);
      break;
    case "open-artist":
      go(`/artist/${encodeURIComponent(id)}`);
      break;

    case "play-collection":
      await playCollection(element.dataset.kind, id, false);
      break;
    case "shuffle-collection":
      await playCollection(element.dataset.kind, id, true);
      break;

    case "play-mix":
      playMix(element.dataset.mix);
      break;
    case "play-liked":
      playLiked(false);
      break;
    case "shuffle-liked":
      playLiked(true);
      break;

    case "search-filter":
      navigateSearch(state.search.q, element.dataset.type);
      break;
    case "search-query":
      navigateSearch(element.dataset.q, "all");
      break;
    case "genre":
      navigateSearch(element.dataset.q, "all");
      break;
    case "clear-search":
      navigateSearch("", "all", true);
      break;
    case "clear-searches":
      store.clearSearches();
      route();
      break;
    case "open-search":
      state.focusSearch = true;
      go("/search");
      break;
    case "open-explore":
      go("/explore");
      break;
    case "open-recent":
      go("/recent");
      break;

    case "refresh-home":
      state.home = null;
      state.homeAt = 0;
      route();
      break;
    case "retry":
      route();
      break;

    case "create-playlist":
      openCreatePlaylist();
      break;
    case "delete-playlist":
      confirmDeletePlaylist(id);
      break;
    case "toggle-save-album":
      toggleSaveAlbum(id);
      break;
    case "collection-menu":
      await openCollectionMenu(element.dataset.kind, id, element);
      break;
    case "artist-radio":
      await startArtistRadio(id);
      break;

    case "clear-history":
      confirmModal(
        "Clear listening history?",
        "Your recently played tracks and play counts will be removed. Likes and playlists stay.",
        "Clear history",
        () => {
          store.clearHistory();
          route();
          toast("Listening history cleared");
        }
      );
      break;

    case "toggle-sidebar":
      document.body.classList.toggle("sidebar-open");
      updateScrim();
      break;
    case "close-queue":
      closeQueue();
      break;
    case "clear-queue":
      player.clearQueue();
      closeQueue();
      toast("Queue cleared");
      break;

    case "play-queue":
      player.playQueueIndex(Number(element.dataset.index));
      break;
    case "remove-queue":
      player.removeFromQueue(Number(element.dataset.index));
      break;

    case "seek-lyric":
      player.seek(Number(element.dataset.time));
      break;
    case "toggle-autoplay":
      player.state.autoplay = !player.state.autoplay;
      renderNPPanel();
      toast(player.state.autoplay ? "Autoplay on" : "Autoplay off");
      break;

    case "scroll-shelf": {
      const target = $(element.dataset.target);
      if (target) {
        target.scrollBy({
          left: Number(element.dataset.dir) * target.clientWidth * 0.82,
          behavior: "smooth",
        });
      }
      break;
    }

    case "settings":
      await openSettings();
      break;

    default:
      break;
  }
}

/* -------------------------------------------------------------------------- */
/* Player actions                                                             */
/* -------------------------------------------------------------------------- */

function handlePlayerAction(action) {
  switch (action) {
    case "toggle":
      if (!player.current()) playDefault();
      else player.toggle();
      break;
    case "next":
      player.next();
      break;
    case "prev":
      player.prev();
      break;
    case "shuffle":
      player.toggleShuffle();
      toast(player.state.shuffle ? "Shuffle on" : "Shuffle off");
      break;
    case "repeat": {
      player.cycleRepeat();
      const labels = { off: "Repeat off", all: "Repeat all", one: "Repeat one" };
      toast(labels[player.state.repeat]);
      break;
    }
    case "mute":
      player.toggleMute();
      break;
    case "expand":
      openFullscreen();
      break;
    case "collapse":
      closeFullscreen();
      break;
    case "queue":
      toggleQueue();
      break;
    case "lyrics":
      openFullscreen("lyrics");
      break;
    default:
      break;
  }
}

/* -------------------------------------------------------------------------- */
/* Event wiring                                                               */
/* -------------------------------------------------------------------------- */

function bindEvents() {
  document.addEventListener("click", (event) => {
    const searchNav = event.target.closest('[data-nav="search"]');
    if (searchNav) {
      event.preventDefault();
      state.focusSearch = true;
      if (state.route.name === "search") focusSearchInput();
      else go("/search");
      closeSidebar();
      return;
    }

    const playerControl = event.target.closest("[data-player]");
    if (playerControl) {
      event.preventDefault();
      handlePlayerAction(playerControl.dataset.player);
      return;
    }

    const npTab = event.target.closest("[data-np-tab]");
    if (npTab) {
      setNpTab(npTab.dataset.npTab);
      return;
    }

    const anchor = event.target.closest("a[href]");
    if (anchor) {
      closeMenu();
      closeSuggestions();
      if (anchor.closest(".sidebar")) closeSidebar();
      return;
    }

    const actionEl = event.target.closest("[data-action]");
    if (actionEl) {
      handleAction(actionEl);
    }

    if (
      !event.target.closest("#menu") &&
      !event.target.closest('[data-action="track-menu"]') &&
      !event.target.closest('[data-action="current-menu"]')
    ) {
      closeMenu();
    }

    if (!event.target.closest(".search-box")) closeSuggestions();
  });

  document.addEventListener("input", (event) => {
    if (event.target.id === "searchInput") onSearchInput(event.target);
  });

  document.addEventListener("keydown", (event) => {
    if (event.target.id === "searchInput") {
      if (event.key === "Enter") {
        event.preventDefault();
        const query = event.target.value.trim();
        if (query) navigateSearch(query, state.search.type || "all", true);
        else navigateSearch("", "all", true);
      } else if (event.key === "Escape") {
        closeSuggestions();
      }
      return;
    }

    const tag = document.activeElement?.tagName;
    const typing =
      tag === "INPUT" || tag === "TEXTAREA" || document.activeElement?.isContentEditable;
    const interactive = tag === "BUTTON" || tag === "A";

    if (event.key === "Escape") {
      if (!modalWrap.hidden) {
        closeModal();
        return;
      }
      if (!menu.hidden) {
        closeMenu();
        return;
      }
      if (queuePanel.classList.contains("open")) {
        closeQueue();
        return;
      }
      if (player.state.fullscreen) {
        closeFullscreen();
        return;
      }
      if (document.body.classList.contains("sidebar-open")) closeSidebar();
      return;
    }

    if (typing) return;

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      state.focusSearch = true;
      if (state.route.name === "search") focusSearchInput();
      else go("/search");
      return;
    }

    if (event.ctrlKey || event.metaKey || event.altKey) return;

    if (event.code === "Space") {
      if (interactive) return;
      event.preventDefault();
      handlePlayerAction("toggle");
      return;
    }

    if (event.key === "ArrowRight") {
      event.preventDefault();
      player.seek(player.state.currentTime + 5);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      player.seek(player.state.currentTime - 5);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      player.setVolume(player.state.volume + 0.05);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      player.setVolume(player.state.volume - 0.05);
    } else if (event.key.toLowerCase() === "n") {
      player.next();
    } else if (event.key.toLowerCase() === "p") {
      player.prev();
    } else if (event.key.toLowerCase() === "m") {
      player.toggleMute();
    } else if (event.key.toLowerCase() === "f") {
      if (player.state.fullscreen) closeFullscreen();
      else openFullscreen();
    } else if (event.key.toLowerCase() === "l") {
      const track = player.current();
      if (track) {
        const liked = store.toggleLike(track);
        syncLikeButtons();
        syncPlayer();
        toast(liked ? "Added to Liked Music" : "Removed from Liked Music");
      }
    } else if (event.key.toLowerCase() === "q") {
      toggleQueue();
    } else if (event.key === "/") {
      event.preventDefault();
      state.focusSearch = true;
      if (state.route.name === "search") focusSearchInput();
      else go("/search");
    } else if (event.key === "?") {
      openSettings();
    }
  });

  main.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const target = event.target.closest('[data-action][role="button"]');
    if (target && event.target === target) {
      event.preventDefault();
      event.stopPropagation();
      target.click();
    }
  });

  ["pSeek", "npSeek"].forEach((id) => {
    const input = $(id);
    input.addEventListener("input", () => {
      const duration = player.state.duration || 0;
      player.seek((Number(input.value) / 1000) * duration);
    });
  });

  $("pVol").addEventListener("input", (event) => {
    player.setVolume(Number(event.target.value) / 100);
  });

  scrim.addEventListener("click", () => {
    closeQueue();
    closeSidebar();
  });

  modalWrap.addEventListener("click", (event) => {
    if (event.target === modalWrap) closeModal();
  });

  main.addEventListener("scroll", closeMenu, { passive: true });
  window.addEventListener("resize", closeMenu);

  window.addEventListener("hashchange", route);

  document.addEventListener(
    "error",
    (event) => {
      if (event.target instanceof HTMLImageElement) {
        event.target.style.display = "none";
        event.target.parentElement?.classList.add("no-img");
      }
    },
    true
  );

  store.subscribe(() => {
    renderSidebarPlaylists();
    syncLikeButtons();
  });
}

function syncRowStates() {
  const currentId = player.current()?.videoId || "";
  const playing = player.state.playing;
  document
    .querySelectorAll('[data-action="play-track"][data-video-id]')
    .forEach((row) => {
      const active = Boolean(currentId) && row.dataset.videoId === currentId;
      row.classList.toggle("is-current", active);
      if (row.classList.contains("trow")) {
        row.classList.toggle("paused", active && !playing);
      } else if (row.classList.contains("tt-row")) {
        row.classList.toggle("playing", active && playing);
      }
    });
}

function bindPlayer() {
  player.on("state", () => {
    syncPlayer();
    syncRowStates();
    updateNPTabs();
  });

  player.on("track", () => {
    syncPlayer();
    syncRowStates();
    renderQueue();
    if (player.state.fullscreen) {
      updateNPTabs();
      renderNPPanel();
    }
  });

  player.on("queue", () => {
    syncPlayer();
    renderQueue();
    if (player.state.fullscreen && state.npTab === "upnext") renderNPPanel();
  });

  player.on("time", syncTime);

  player.on("lyrics", () => {
    if (player.state.fullscreen && state.npTab === "lyrics") renderNPPanel();
  });

  player.on("fullscreen", (open) => {
    np.classList.toggle("open", open);
    np.setAttribute("aria-hidden", String(!open));
    document.body.classList.toggle("np-open", open);
    if (open) {
      updateNPTabs();
      syncPlayer();
      renderNPPanel();
      requestAnimationFrame(syncLyricsHighlight);
    } else {
      closeMenu();
    }
  });

  player.on("error", (message) => toast(message));
  player.on("empty", playDefault);
}

/* -------------------------------------------------------------------------- */
/* Boot                                                                       */
/* -------------------------------------------------------------------------- */

function init() {
  bindEvents();
  bindPlayer();
  refreshHealth();

  applyTheme(document.documentElement.dataset.theme || "light", false);
  player.setVolume(store.data.volume ?? 0.85);
  renderSidebarPlaylists();
  syncPlayer();
  renderQueue();
  if (!location.hash) history.replaceState(null, "", "#/home");
  route();
}

init();
