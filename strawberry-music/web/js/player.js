/* ==========================================================================
   Audio player engine — queue, shuffle, repeat, autoplay radio, lyrics
   ========================================================================== */

import { api } from "./api.js";
import { store } from "./store.js";

const audio = new Audio();
audio.preload = "auto";
audio.volume = Math.max(0, Math.min(1, store.data.volume ?? 0.85));

const listeners = {
  state: new Set(),
  track: new Set(),
  time: new Set(),
  queue: new Set(),
  lyrics: new Set(),
  fullscreen: new Set(),
  error: new Set(),
  empty: new Set(),
};

let needsAuth = false;

const state = {
  queue: [],
  index: -1,
  playing: false,
  loading: false,
  shuffle: false,
  repeat: "off",
  autoplay: true,
  muted: false,
  volume: audio.volume,
  currentTime: 0,
  duration: 0,
  context: null,
  lyrics: null,
  lyricsLoading: false,
  fullscreen: false,
  tab: "upnext",
  extending: false,
};

const shuffleHistory = [];
const lyricCache = new Map();

function emit(event, payload) {
  listeners[event]?.forEach((fn) => {
    try {
      fn(payload);
    } catch (error) {
      console.error(`[player] ${event} listener failed`, error);
    }
  });
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function current() {
  return state.queue[state.index] || null;
}

function setPlaying(value) {
  state.playing = value;
  updateMediaSessionState();
  emit("state");
}

function setLoading(value) {
  state.loading = value;
  emit("state");
}

/* -------------------------------------------------------------------------- */
/* Track loading                                                              */
/* -------------------------------------------------------------------------- */

function playTracks(tracks, startIndex = 0, context = null) {
  const clean = [];
  for (const track of tracks || []) {
    if (!track || !track.videoId) continue;
    clean.push(track);
  }
  if (!clean.length) {
    emit("error", "No playable tracks here.");
    return false;
  }

  const requestedIndex = clamp(startIndex, 0, clean.length - 1);
  const requestedTrack = clean[requestedIndex];
  const active = current();
  if (active && clean[requestedIndex] && active.videoId === clean[requestedIndex].videoId) {
    toggle();
    return true;
  }

  state.queue = clean;
  state.index = requestedIndex;
  state.context = context || null;
  state.lyrics = null;
  shuffleHistory.length = 0;
  emit("queue");
  load(true);
  return true;
}

function playIndex(index, autoplay = true) {
  if (index < 0 || index >= state.queue.length) return;
  if (index === state.index && audio.src) {
    toggle();
    return;
  }
  state.index = index;
  load(autoplay);
}

function load(autoplay) {
  const track = current();
  if (!track) return;

  state.loading = true;
  setPlaying(Boolean(autoplay));
  state.currentTime = 0;
  state.duration = track.durationSeconds || 0;
  state.lyrics = null;
  state.lyricsLoading = true;

  audio.src = `/api/stream/${encodeURIComponent(track.videoId)}`;
  audio.load();

  store.addHistory(track);
  updateMediaSession();

  emit("state");
  emit("queue");
  emit("track");
  emit("lyrics");

  loadLyrics(track);
  prefetchAround();

  if (autoplay) {
    const promise = audio.play();
    if (promise) {
      promise.catch((error) => {
        if (error.name === "AbortError") return;
        state.playing = false;
        state.loading = false;
        emit("state");
        if (needsAuth) {
          emit("error", "Playback on this server needs YouTube Music sign-in. Open Settings → YouTube Music.");
          stopAtEnd();
          return;
        }
        emit(
          "error",
          error.name === "NotAllowedError"
            ? "Press play to start the audio."
            : "Could not play this track. Please try again in a moment."
        );
      });
    }
  }
}

function prefetchAround() {
  const nextIndex = state.index + 1;
  if (nextIndex < state.queue.length) api.prefetch(state.queue[nextIndex].videoId);
  const afterIndex = nextIndex + 1;
  if (afterIndex < state.queue.length) api.prefetch(state.queue[afterIndex].videoId);
}

/* -------------------------------------------------------------------------- */
/* Transport                                                                  */
/* -------------------------------------------------------------------------- */

function toggle() {
  if (!current()) {
    emit("empty");
    return;
  }
  if (audio.error) {
    load(true);
    return;
  }
  if (audio.paused) {
    const promise = audio.play();
    if (promise) {
      promise.catch((error) => {
        if (error.name !== "AbortError") {
          setPlaying(false);
        }
      });
    }
  } else {
    audio.pause();
  }
}

function stopAtEnd() {
  setPlaying(false);
  setLoading(false);
}

function next(manual = true) {
  if (!state.queue.length) return;

  const atEnd = state.index + 1 >= state.queue.length;
  if (atEnd) {
    if (state.repeat === "all") {
      playIndex(0);
      return;
    }
    if (state.autoplay) {
      extend().then((added) => {
        if (added > 0) next(false);
        else stopAtEnd();
      });
      return;
    }
    stopAtEnd();
    return;
  }

  if (state.shuffle && state.queue.length > 1) {
    let candidate = state.index;
    let guard = 0;
    while (candidate === state.index && guard < 24) {
      candidate = Math.floor(Math.random() * state.queue.length);
      guard += 1;
    }
    shuffleHistory.push(state.index);
    if (shuffleHistory.length > state.queue.length) shuffleHistory.shift();
    playIndex(candidate);
    return;
  }

  playIndex(state.index + 1);
}

function prev() {
  if (!state.queue.length) return;
  if (audio.currentTime > 3) {
    seek(0);
    return;
  }
  if (state.shuffle && shuffleHistory.length) {
    const index = shuffleHistory.pop();
    playIndex(index);
    return;
  }
  if (state.index > 0) {
    playIndex(state.index - 1);
    return;
  }
  if (state.repeat === "all") {
    playIndex(state.queue.length - 1);
    return;
  }
  seek(0);
}

function seek(seconds) {
  const duration = Number.isFinite(audio.duration) ? audio.duration : state.duration;
  if (!duration) return;
  const value = clamp(Number(seconds) || 0, 0, duration);
  try {
    audio.currentTime = value;
  } catch {
    /* ignore */
  }
  state.currentTime = value;
  emit("time");
}

function setVolume(volume) {
  const value = clamp(Number(volume) || 0, 0, 1);
  state.volume = value;
  state.muted = value === 0 ? state.muted : false;
  audio.muted = false;
  audio.volume = value;
  store.setVolume(value);
  emit("state");
}

function toggleMute() {
  const nextMuted = !state.muted;
  state.muted = nextMuted;
  audio.muted = nextMuted;
  if (!nextMuted && state.volume === 0) setVolume(0.5);
  emit("state");
}

function toggleShuffle() {
  state.shuffle = !state.shuffle;
  shuffleHistory.length = 0;
  emit("state");
}

function setShuffle(value) {
  state.shuffle = Boolean(value);
  shuffleHistory.length = 0;
  emit("state");
}

function cycleRepeat() {
  state.repeat = state.repeat === "off" ? "all" : state.repeat === "all" ? "one" : "off";
  emit("state");
}

/* -------------------------------------------------------------------------- */
/* Queue editing                                                              */
/* -------------------------------------------------------------------------- */

function playNext(track) {
  if (!track || !track.videoId) return;
  if (!state.queue.length) {
    playTracks([track], 0, { type: "single", title: track.title, thumb: track.thumb });
    return;
  }
  state.queue.splice(state.index + 1, 0, track);
  emit("queue");
}

function addToQueue(track) {
  if (!track || !track.videoId) return;
  if (!state.queue.length) {
    playTracks([track], 0, { type: "single", title: track.title, thumb: track.thumb });
    return;
  }
  state.queue.push(track);
  emit("queue");
}

function removeFromQueue(index) {
  if (index < 0 || index >= state.queue.length) return;
  const wasCurrent = index === state.index;
  state.queue.splice(index, 1);

  if (!state.queue.length) {
    clearQueue();
    return;
  }

  if (index < state.index) {
    state.index -= 1;
  } else if (wasCurrent) {
    state.index = clamp(state.index, 0, state.queue.length - 1);
    load(state.playing ? true : false);
  }
  emit("queue");
}

function clearQueue() {
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
  state.queue = [];
  state.index = -1;
  state.context = null;
  setPlaying(false);
  setLoading(false);
  state.currentTime = 0;
  state.duration = 0;
  state.lyrics = null;
  state.lyricsLoading = false;
  shuffleHistory.length = 0;
  emit("state");
  emit("queue");
  emit("lyrics");
}

async function extend() {
  if (state.extending) return 0;
  const base = state.queue[state.queue.length - 1] || current();
  if (!base) return 0;

  state.extending = true;
  try {
    const data = await api.watch(base.videoId, 50);
    const existing = new Set(state.queue.map((track) => track.videoId));
    const extra = (data.tracks || []).filter((track) => !existing.has(track.videoId)).slice(0, 30);
    if (extra.length) {
      state.queue.push(...extra);
      emit("queue");
    }
    return extra.length;
  } catch (error) {
    console.warn("[player] autoplay extension failed", error);
    return 0;
  } finally {
    state.extending = false;
  }
}

/* -------------------------------------------------------------------------- */
/* Lyrics                                                                     */
/* -------------------------------------------------------------------------- */

async function loadLyrics(track) {
  if (!track) return;
  const cached = lyricCache.get(track.videoId);
  if (cached) {
    state.lyrics = cached;
    state.lyricsLoading = false;
    emit("lyrics");
    return;
  }

  state.lyricsLoading = true;
  emit("lyrics");

  try {
    const data = await api.lyrics(track);
    if (current()?.videoId !== track.videoId) return;
    lyricCache.set(track.videoId, data);
    state.lyrics = data;
  } catch (error) {
    if (current()?.videoId === track.videoId) {
      state.lyrics = { synced: false, lines: [], plain: "", source: null, error: true };
    }
  } finally {
    if (current()?.videoId === track.videoId) {
      state.lyricsLoading = false;
      emit("lyrics");
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Fullscreen                                                                 */
/* -------------------------------------------------------------------------- */

function setFullscreen(value) {
  const nextValue = Boolean(value);
  if (state.fullscreen === nextValue) return;
  state.fullscreen = nextValue;
  emit("fullscreen", nextValue);
}

function setTab(tab) {
  state.tab = tab === "lyrics" ? "lyrics" : "upnext";
  emit("state");
}

/* -------------------------------------------------------------------------- */
/* Media Session                                                              */
/* -------------------------------------------------------------------------- */

function updateMediaSession() {
  if (!("mediaSession" in navigator)) return;
  const track = current();
  if (!track) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artistText || "Strawberry Music",
      album: track.album?.name || "Strawberry Music",
      artwork: track.thumb
        ? [{ src: track.thumb, sizes: "544x544", type: "image/jpeg" }]
        : [],
    });
  } catch {
    /* ignore */
  }
}

function updateMediaSessionState() {
  if (!("mediaSession" in navigator)) return;
  try {
    navigator.mediaSession.playbackState = state.playing
      ? "playing"
      : state.queue.length
        ? "paused"
        : "none";
  } catch {
    /* ignore */
  }
}

if ("mediaSession" in navigator) {
  try {
    navigator.mediaSession.setActionHandler("play", () => toggle());
    navigator.mediaSession.setActionHandler("pause", () => audio.pause());
    navigator.mediaSession.setActionHandler("previoustrack", () => prev());
    navigator.mediaSession.setActionHandler("nexttrack", () => next(true));
    navigator.mediaSession.setActionHandler("seekbackward", (details) =>
      seek(state.currentTime - (details.seekOffset || 10))
    );
    navigator.mediaSession.setActionHandler("seekforward", (details) =>
      seek(state.currentTime + (details.seekOffset || 10))
    );
    navigator.mediaSession.setActionHandler("seekto", (details) => {
      if (typeof details.seekTime === "number") seek(details.seekTime);
    });
  } catch {
    /* unsupported actions are fine */
  }
}

/* -------------------------------------------------------------------------- */
/* Audio events                                                               */
/* -------------------------------------------------------------------------- */

audio.addEventListener("play", () => {
  setPlaying(true);
});

audio.addEventListener("playing", () => {
  setPlaying(true);
  setLoading(false);
});

audio.addEventListener("pause", () => {
  if (audio.ended) return;
  setPlaying(false);
});

audio.addEventListener("waiting", () => {
  state.loading = true;
  emit("state");
});

audio.addEventListener("canplay", () => {
  state.loading = false;
  emit("state");
});

audio.addEventListener("loadedmetadata", () => {
  if (Number.isFinite(audio.duration) && audio.duration > 0) {
    state.duration = audio.duration;
  }
  emit("state");
  emit("time");
});

audio.addEventListener("timeupdate", () => {
  state.currentTime = audio.currentTime || 0;
  emit("time");

  if ("mediaSession" in navigator && Number.isFinite(audio.duration) && audio.duration > 0) {
    try {
      navigator.mediaSession.setPositionState({
        duration: audio.duration,
        playbackRate: audio.playbackRate || 1,
        position: Math.min(audio.currentTime || 0, audio.duration),
      });
    } catch {
      /* ignore */
    }
  }
});

audio.addEventListener("ended", () => {
  if (state.repeat === "one") {
    audio.currentTime = 0;
    const promise = audio.play();
    if (promise) promise.catch(() => {});
    return;
  }
  next(false);
});

audio.addEventListener("error", () => {
  if (!audio.src || !state.queue.length) return;
  state.loading = false;
  setPlaying(false);
  if (needsAuth) {
    emit("error", "Playback on this server needs YouTube Music sign-in. Open Settings → YouTube Music.");
    stopAtEnd();
    return;
  }
  emit("error", "Could not load audio for this track. Try again in a moment.");
  next(true);
});

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

export const player = {
  state,
  current,
  setNeedsAuth(value) {
    needsAuth = Boolean(value);
  },
  on(event, fn) {
    listeners[event]?.add(fn);
    return () => listeners[event]?.delete(fn);
  },
  playTracks,
  playIndex,
  playQueueIndex(index) {
    playIndex(index);
  },
  toggle,
  next,
  prev,
  seek,
  setVolume,
  toggleMute,
  toggleShuffle,
  setShuffle,
  cycleRepeat,
  setFullscreen,
  setTab,
  playNext,
  addToQueue,
  removeFromQueue,
  clearQueue,
  extend,
  loadLyrics,
};
