"""Resolve catalog audio streams and cache the result."""

from __future__ import annotations

import os
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import yt_dlp

from . import ytm

VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{6,20}$")
STREAM_TTL = 3 * 60 * 60  # googlevideo URLs are valid for ~6h
FAILURE_TTL = 60
LOCK_TTL = 10 * 60
MAX_CACHE = 512
MAX_PREFETCH_PENDING = 6

_cache: dict[str, dict] = {}
_failures: dict[str, float] = {}
_locks: dict[str, threading.Lock] = {}
_lock_seen: dict[str, float] = {}
_guard = threading.Lock()

_prefetch_pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="prefetch")
_prefetch_pending: set[str] = set()
_prefetch_guard = threading.Lock()

MIME_TYPES = {
    "m4a": "audio/mp4",
    "mp4": "audio/mp4",
    "webm": "audio/webm",
    "opus": "audio/ogg",
    "mp3": "audio/mpeg",
}


def clients() -> list[str]:
    value = (
        os.environ.get("OMNI_STREAM_CLIENTS")
        or os.environ.get("OMNI_YTDLP_CLIENTS")
        or "android"
    )
    return [client.strip() for client in value.split(",") if client.strip()]


def _base_options() -> dict:
    options = {
        "format": "bestaudio[ext=m4a]/bestaudio/best",
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "skip_download": True,
        "nocheckcertificate": True,
        "retries": 2,
        "socket_timeout": 20,
        "http_headers": {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/131.0 Safari/537.36"
            ),
            "Accept-Language": "en-US,en;q=0.9",
        },
    }
    cookies = os.environ.get("OMNI_COOKIES")
    if cookies and os.path.exists(cookies):
        options["cookiefile"] = cookies
    else:
        try:
            generated = ytm.cookie_file()
        except Exception:  # noqa: BLE001 - never let cookie export break playback
            generated = None
        if generated:
            options["cookiefile"] = generated
    proxy = os.environ.get("OMNI_PROXY")
    if proxy:
        options["proxy"] = proxy
    extractor_args = {"player_client": clients()}
    visitor = ytm.visitor_data()
    if visitor:
        extractor_args["visitor_data"] = [visitor]
    options["extractor_args"] = {"youtube": extractor_args}
    return options


def _prune_locked(now: float) -> None:
    """Drop expired streams, stale failures and idle per-track locks."""
    for video_id, entry in list(_cache.items()):
        if entry.get("expires", 0) <= now:
            _cache.pop(video_id, None)
    for video_id, failed_at in list(_failures.items()):
        if now - failed_at >= FAILURE_TTL:
            _failures.pop(video_id, None)
    for video_id, lock in list(_locks.items()):
        seen = _lock_seen.get(video_id, 0)
        if not lock.locked() and now - seen > LOCK_TTL:
            _locks.pop(video_id, None)
            _lock_seen.pop(video_id, None)


def _trim_cache_locked() -> None:
    if len(_cache) <= MAX_CACHE:
        return
    overflow = len(_cache) - MAX_CACHE
    oldest = sorted(_cache.items(), key=lambda item: item[1].get("expires", 0))[:overflow]
    for video_id, _ in oldest:
        _cache.pop(video_id, None)


def _lock_for(video_id: str) -> threading.Lock:
    with _guard:
        lock = _locks.get(video_id)
        if lock is None:
            lock = threading.Lock()
            _locks[video_id] = lock
        _lock_seen[video_id] = time.time()
        return lock


def invalidate(video_id: str) -> None:
    """Forget a cached URL that the upstream rejected."""
    with _guard:
        _cache.pop(video_id, None)
        _failures.pop(video_id, None)


def clear() -> None:
    with _guard:
        _cache.clear()
        _failures.clear()
        _locks.clear()
        _lock_seen.clear()


def resolve(video_id: str, force: bool = False) -> dict:
    """Return {url, ext, mime, title, duration} for a video id.

    Raises RuntimeError when the resolver cannot produce a playable stream.
    """
    if not VIDEO_ID_RE.match(video_id or ""):
        raise ValueError("Invalid video id")

    now = time.time()
    with _guard:
        _prune_locked(now)
        if not force:
            hit = _cache.get(video_id)
            if hit and hit["expires"] > now:
                return hit
            failed_at = _failures.get(video_id)
            if failed_at and now - failed_at < FAILURE_TTL:
                raise RuntimeError("Audio extraction recently failed; retrying shortly")

    lock = _lock_for(video_id)
    with lock:
        now = time.time()
        with _guard:
            _prune_locked(now)
            if not force:
                hit = _cache.get(video_id)
                if hit and hit["expires"] > now:
                    return hit

        try:
            with yt_dlp.YoutubeDL(_base_options()) as ydl:
                info = ydl.extract_info(
                    f"https://music.youtube.com/watch?v={video_id}", download=False
                )
            if info and info.get("entries"):
                info = info["entries"][0]
            if not info or not info.get("url"):
                raise RuntimeError("No audio stream returned by the resolver")

            ext = (info.get("ext") or "m4a").lower()
            entry = {
                "url": info["url"],
                "ext": ext,
                "mime": MIME_TYPES.get(ext, "audio/mp4"),
                "title": info.get("title"),
                "duration": info.get("duration"),
                "expires": time.time() + STREAM_TTL,
            }
            with _guard:
                _cache[video_id] = entry
                _failures.pop(video_id, None)
                _lock_seen[video_id] = time.time()
                _trim_cache_locked()
            return entry
        except Exception as exc:  # noqa: BLE001 - surface a clean message
            with _guard:
                _failures[video_id] = time.time()
            raise RuntimeError(str(exc) or "Audio extraction failed") from exc


def prefetch(video_id: str) -> None:
    """Warm a stream without spawning an unbounded thread per request."""
    if not VIDEO_ID_RE.match(video_id or ""):
        return
    with _prefetch_guard:
        if video_id in _prefetch_pending or len(_prefetch_pending) >= MAX_PREFETCH_PENDING:
            return
        _prefetch_pending.add(video_id)

    def run():
        try:
            resolve(video_id)
        except Exception:
            pass
        finally:
            with _prefetch_guard:
                _prefetch_pending.discard(video_id)

    try:
        _prefetch_pool.submit(run)
    except RuntimeError:
        with _prefetch_guard:
            _prefetch_pending.discard(video_id)


def shutdown() -> None:
    _prefetch_pool.shutdown(wait=False, cancel_futures=True)


def cache_info() -> dict:
    with _guard:
        now = time.time()
        _prune_locked(now)
        return {
            "resolved": len(_cache),
            "failed": len(_failures),
            "clients": clients(),
            "cookies": bool(os.environ.get("OMNI_COOKIES") or ytm.auth_path()),
        }
