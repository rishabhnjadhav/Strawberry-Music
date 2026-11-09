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

const state = {
  queue: [],
  index: -1,
  playing: false,
  loading: false,
  shuffle: false,
  repeat: "off",
  autoplay: store.data.autoplay !== false,
  muted: false,
  volume: audio.volume,
  currentTime: 0,
  duration: 0,
  context: null,
  lyrics: null,
  lyricsLoading: false,
  fullscreen: false,
  tab: "upnext",
  radioLoading: false,
  radioToken: 0,
  radioRequestToken: -1,
  lastRadioAttempt: 0,
  pendingAutoAdvance: false,
  radioExhausted: new Set(),
  sessionPlayedIds: new Set(),
  sessionPlayedTitles: new Set(),
};

const shuffleHistory = [];
const lyricCache = new Map();
let radioRequestSeq = 0;

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

function normalizeKeyPart(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function artistTextOf(track) {
  if (track?.artistText) return track.artistText;
  return (track?.artists || [])
    .map((artist) => artist?.name)
    .filter(Boolean)
    .join(", ");
}

function trackTitleKey(track) {
  const title = normalizeKeyPart(track?.title);
  const artist = normalizeKeyPart(artistTextOf(track));
  if (!title && !artist) return "";
  return `${title}|${artist}`;
}

function rememberPlayed(track) {
  if (!track?.videoId) return;
  state.sessionPlayedIds.add(track.videoId);
  const key = trackTitleKey(track);
  if (key) state.sessionPlayedTitles.add(key);
}

function isKnownTrack(track, queueIds, queueKeys) {
  if (!track?.videoId) return true;
  if (queueIds.has(track.videoId) || state.sessionPlayedIds.has(track.videoId)) {
    return true;
  }
  const key = trackTitleKey(track);
  return Boolean(key && (queueKeys.has(key) || state.sessionPlayedTitles.has(key)));
}

function remainingAfterCurrent() {
  return Math.max(0, state.queue.length - state.index - 1);
}

function manualInsertIndex() {
  const start = Math.max(0, state.index + 1);
  for (let cursor = start; cursor < state.queue.length; cursor += 1) {
    if (state.queue[cursor]?.radio) return cursor;
  }
  return state.queue.length;
}

function withRadioLabel(track, seed) {
  const seedTitle = String(seed?.title || "Unknown").trim() || "Unknown";
  return {
    ...track,
    radio: { seedVideoId: seed?.videoId || "", seedTitle },
    radioLabel: `${seedTitle} Radio`,
  };
}

function radioCandidates() {
  const candidates = [];
  for (let cursor = state.index; cursor >= 0 && candidates.length < 3; cursor -= 1) {
    const track = state.queue[cursor];
    if (track?.videoId && !state.radioExhausted.has(track.videoId)) {
      candidates.push(track);
    }
  }
  return candidates;
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
  state.radioExhausted.clear();
  state.pendingAutoAdvance = false;
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

  state.radioToken += 1;
  state.pendingAutoAdvance = false;
  rememberPlayed(track);

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
  maybeTopUpRadio();

  if (autoplay) {
    const promise = audio.play();
    if (promise) {
      promise.catch((error) => {
        if (error.name === "AbortError") return;
        state.playing = false;
        state.loading = false;
        emit("state");
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
      state.pendingAutoAdvance = true;
      extend().then((added) => {
        if (added > 0) {
          state.pendingAutoAdvance = false;
          next(false);
        } else if (!state.radioLoading) {
          state.pendingAutoAdvance = false;
          stopAtEnd();
        }
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

function setAutoplay(value) {
  state.autoplay = Boolean(value);
  store.setAutoplay(state.autoplay);
  emit("state");
  if (state.autoplay) maybeTopUpRadio();
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
  state.queue.splice(manualInsertIndex(), 0, track);
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
  state.radioToken += 1;
  radioRequestSeq += 1;
  state.radioLoading = false;
  state.radioRequestToken = -1;
  state.pendingAutoAdvance = false;
  state.lastRadioAttempt = 0;
  state.radioExhausted.clear();
  state.sessionPlayedIds.clear();
  state.sessionPlayedTitles.clear();
  emit("state");
  emit("queue");
  emit("lyrics");
}

function maybeTopUpRadio() {
  if (!state.autoplay || state.repeat !== "off" || !current()) return;
  if (remainingAfterCurrent() >= 5) return;
  if (state.radioLoading && state.radioRequestToken === state.radioToken) return;
  topUpRadio({ force: false, autoAdvance: true }).catch((error) => {
    console.warn("[player] autoplay top-up failed", error);
  });
}

async function topUpRadio({ force = false, autoAdvance = true } = {}) {
  if (!state.autoplay || state.repeat !== "off" || !current()) return 0;
  if (!force && remainingAfterCurrent() >= 5) return 0;
  if (state.radioLoading && state.radioRequestToken === state.radioToken) return 0;

  const token = state.radioToken;
  const playing = current();
  const requestId = ++radioRequestSeq;
  state.radioLoading = true;
  state.radioRequestToken = token;
  state.lastRadioAttempt = Date.now();

  try {
    const seeds = radioCandidates();
    for (const seed of seeds) {
      let data;
      try {
        data = await api.radio(seed.videoId);
      } catch (error) {
        console.warn("[player] radio request failed", error);
        return 0;
      }

      if (token !== state.radioToken || current()?.videoId !== playing.videoId) {
        return 0;
      }
      if (!state.autoplay || state.repeat !== "off") return 0;
      if (data?.ok === false) {
        console.warn("[player] radio returned no data", data.reason || "unknown");
        return 0;
      }

      const queueIds = new Set(state.queue.map((track) => track.videoId));
      const queueKeys = new Set(
        state.queue.map((track) => trackTitleKey(track)).filter(Boolean)
      );
      const extra = (data?.tracks || [])
        .filter((track) => track?.videoId && !isKnownTrack(track, queueIds, queueKeys))
        .slice(0, 30);

      if (extra.length) {
        state.queue.push(...extra.map((track) => withRadioLabel(track, seed)));
        emit("queue");
        if (autoAdvance && state.pendingAutoAdvance) {
          state.pendingAutoAdvance = false;
          setTimeout(() => {
            if (current() && state.index + 1 < state.queue.length) {
              playIndex(state.index + 1);
            }
          }, 0);
        }
        return extra.length;
      }

      state.radioExhausted.add(seed.videoId);
    }
    return 0;
  } finally {
    if (requestId === radioRequestSeq) {
      state.radioLoading = false;
      state.radioRequestToken = -1;
      emit("state");
    }
  }
}

function extend() {
  return topUpRadio({ force: true, autoAdvance: false });
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
  emit("error", "Could not load audio for this track. Try again in a moment.");
  next(true);
});

/* -------------------------------------------------------------------------- */
/* Autoplay watchdog                                                          */
/* -------------------------------------------------------------------------- */

setInterval(() => {
  if (!state.autoplay || state.repeat !== "off" || state.radioLoading) return;
  if (!current() || remainingAfterCurrent() > 0) return;
  if (Date.now() - state.lastRadioAttempt < 15000) return;
  if (audio.ended) state.pendingAutoAdvance = true;
  topUpRadio({ force: true, autoAdvance: true }).catch((error) => {
    console.warn("[player] autoplay watchdog failed", error);
  });
}, 5000);

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

export const player = {
  state,
  current,
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
  setAutoplay,
  setFullscreen,
  setTab,
  playNext,
  addToQueue,
  removeFromQueue,
  clearQueue,
  extend,
  loadLyrics,
};
