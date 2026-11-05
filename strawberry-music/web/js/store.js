/* ==========================================================================
   Local library — likes, playlists, history, recent pages
   ========================================================================== */

const KEY = "strawberry.music.v1";
const LEGACY_KEY = "omni.music.v1";

function defaults() {
  return {
    liked: [],
    playlists: [],
    history: [],
    recentPages: [],
    searches: [],
    playCounts: {},
    savedAlbums: [],
    volume: 0.85,
    createdAt: Date.now(),
  };
}

function load() {
  try {
    const current = localStorage.getItem(KEY);
    const raw = JSON.parse(current || localStorage.getItem(LEGACY_KEY) || "{}");
    const merged = { ...defaults(), ...raw };
    if (!current && localStorage.getItem(LEGACY_KEY)) {
      localStorage.setItem(KEY, JSON.stringify(merged));
    }
    return merged;
  } catch {
    return defaults();
  }
}

let data = load();
const listeners = new Set();
let persistTimer = null;

function saveNow() {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    /* storage may be full or blocked — keep working in memory */
  }
}

function persist() {
  saveNow();
  listeners.forEach((fn) => {
    try {
      fn(data);
    } catch {
      /* ignore listener errors */
    }
  });
}

function scheduleSave() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(saveNow, 150);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function trimTrack(track) {
  return {
    kind: "track",
    videoId: track.videoId,
    title: track.title,
    artists: track.artists || [],
    artistText: track.artistText || "",
    album: track.album || null,
    duration: track.duration || "",
    durationSeconds: track.durationSeconds || 0,
    thumb: track.thumb || "",
    explicit: Boolean(track.explicit),
  };
}

export const store = {
  get data() {
    return data;
  },

  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  /* ---------------------------------------------------------------- likes */
  isLiked(videoId) {
    return Boolean(videoId) && data.liked.some((track) => track.videoId === videoId);
  },

  likedTracks() {
    return data.liked;
  },

  toggleLike(track) {
    if (!track || !track.videoId) return false;
    const index = data.liked.findIndex((item) => item.videoId === track.videoId);
    let liked;
    if (index >= 0) {
      data.liked.splice(index, 1);
      liked = false;
    } else {
      data.liked.unshift(trimTrack(track));
      liked = true;
    }
    persist();
    return liked;
  },

  /* -------------------------------------------------------------- history */
  addHistory(track) {
    if (!track || !track.videoId) return;
    const compact = trimTrack(track);
    data.history = [compact, ...data.history.filter((item) => item.videoId !== track.videoId)].slice(
      0,
      100
    );
    data.playCounts[track.videoId] = (data.playCounts[track.videoId] || 0) + 1;
    persist();
  },

  clearHistory() {
    data.history = [];
    data.playCounts = {};
    persist();
  },

  topTracks(limit = 20) {
    return [...data.history]
      .sort((a, b) => (data.playCounts[b.videoId] || 0) - (data.playCounts[a.videoId] || 0))
      .slice(0, limit);
  },

  /* --------------------------------------------------------- recent pages */
  addRecentPage(page) {
    if (!page || !page.id || !page.kind) return;
    if (page.kind === "artist" && !page.thumb) {
      /* still keep it — artist art can be missing */
    }
    data.recentPages = [
      { ...page, at: Date.now() },
      ...data.recentPages.filter((item) => !(item.kind === page.kind && item.id === page.id)),
    ].slice(0, 40);
    persist();
  },

  recentPages(kind) {
    if (!kind) return data.recentPages;
    return data.recentPages.filter((page) => page.kind === kind);
  },

  /* ------------------------------------------------------------- searches */
  addSearch(query) {
    const value = (query || "").trim();
    if (!value) return;
    data.searches = [value, ...data.searches.filter((item) => item.toLowerCase() !== value.toLowerCase())].slice(
      0,
      8
    );
    persist();
  },

  clearSearches() {
    data.searches = [];
    persist();
  },

  /* ------------------------------------------------------------ playlists */
  playlists() {
    return data.playlists;
  },

  getPlaylist(id) {
    return data.playlists.find((playlist) => playlist.id === id) || null;
  },

  createPlaylist(name, tracks = []) {
    const playlist = {
      id: `local_${Date.now().toString(36)}`,
      name: (name || "New playlist").trim() || "New playlist",
      description: "",
      tracks: tracks.map(trimTrack),
      createdAt: Date.now(),
    };
    data.playlists.unshift(playlist);
    persist();
    return playlist;
  },

  addToPlaylist(id, track) {
    const playlist = store.getPlaylist(id);
    if (!playlist || !track) return false;
    if (playlist.tracks.some((item) => item.videoId === track.videoId)) return false;
    playlist.tracks.push(trimTrack(track));
    persist();
    return true;
  },

  removeFromPlaylist(id, videoId) {
    const playlist = store.getPlaylist(id);
    if (!playlist) return;
    playlist.tracks = playlist.tracks.filter((track) => track.videoId !== videoId);
    persist();
  },

  deletePlaylist(id) {
    data.playlists = data.playlists.filter((playlist) => playlist.id !== id);
    persist();
  },

  renamePlaylist(id, name) {
    const playlist = store.getPlaylist(id);
    if (!playlist) return;
    playlist.name = (name || "").trim() || playlist.name;
    persist();
  },

  /* --------------------------------------------------------- saved albums */
  isAlbumSaved(id) {
    return data.savedAlbums.some((album) => album.browseId === id);
  },

  toggleSavedAlbum(album) {
    if (!album || !album.browseId) return false;
    const index = data.savedAlbums.findIndex((item) => item.browseId === album.browseId);
    let saved;
    if (index >= 0) {
      data.savedAlbums.splice(index, 1);
      saved = false;
    } else {
      data.savedAlbums.unshift({
        kind: "album",
        browseId: album.browseId,
        playlistId: album.playlistId,
        title: album.title,
        artists: album.artists || [],
        artistText: album.artistText || "",
        year: album.year,
        type: album.type,
        thumb: album.thumb,
      });
      saved = true;
    }
    persist();
    return saved;
  },

  savedAlbums() {
    return data.savedAlbums;
  },

  /* -------------------------------------------------------------- settings */
  setVolume(volume) {
    data.volume = Math.max(0, Math.min(1, Number(volume) || 0));
    scheduleSave();
  },

  reset() {
    data = defaults();
    persist();
  },
};
