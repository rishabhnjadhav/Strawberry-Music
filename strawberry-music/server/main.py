"""Strawberry Music API server.

Run from the strawberry-music directory:

    python -m uvicorn server.main:app --host 127.0.0.1 --port 8420
"""

from __future__ import annotations

import logging
import os
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager

import requests
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import node_runtime, stream, ytm

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("strawberry")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(os.path.dirname(BASE_DIR), "web")


@asynccontextmanager
async def lifespan(_: FastAPI):
    log.info("Strawberry Music starting")
    log.info(
        "Catalog auth: %s | country: %s",
        "connected" if ytm.is_authenticated() else "local",
        ytm.COUNTRY,
    )

    def warm():
        try:
            feed = ytm.home()
            log.info(
                "Home feed warmed: %d shelves, %d quick picks",
                len(feed.get("shelves", [])),
                len(feed.get("quickPicks", [])),
            )
        except Exception as exc:  # noqa: BLE001
            log.warning("Could not warm home feed: %s", exc)

    threading.Thread(target=warm, daemon=True, name="home-warmup").start()
    threading.Thread(
        target=stream.ensure_js_runtime, daemon=True, name="js-runtime"
    ).start()
    threading.Thread(
        target=node_runtime.start_sidecar, daemon=True, name="node-resolver"
    ).start()
    try:
        yield
    finally:
        stream.shutdown()
        log.info("Strawberry Music stopped")


app = FastAPI(title="Strawberry Music", version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def fail(exc: Exception, context: str) -> HTTPException:
    log.warning("%s failed: %s: %s", context, type(exc).__name__, exc)
    return HTTPException(status_code=502, detail=f"{context} failed: {exc}")


class AuthConnectRequest(BaseModel):
    headers: str = ""


# --------------------------------------------------------------------------
# API
# --------------------------------------------------------------------------


@app.get("/api/health")
def health():
    return {
        "ok": True,
        "app": "Strawberry Music",
        "version": app.version,
        **ytm.status(),
        "streams": stream.cache_info(),
        "jsRuntime": stream.runtime_info(),
        "nodeResolver": node_runtime.info(),
    }


@app.get("/api/auth")
def api_auth_status():
    return ytm.status()


@app.post("/api/auth/connect")
def api_auth_connect(payload: AuthConnectRequest):
    try:
        ytm.connect(payload.headers)
        return {"ok": True, **ytm.status()}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        log.warning("YouTube Music sign-in failed: %s", exc)
        raise HTTPException(status_code=400, detail=f"Could not sign in: {exc}") from exc


@app.post("/api/auth/disconnect")
def api_auth_disconnect():
    try:
        ytm.disconnect()
        return {"ok": True, **ytm.status()}
    except Exception as exc:  # noqa: BLE001
        raise fail(exc, "Sign out") from exc


@app.get("/api/home")
def api_home():
    try:
        return ytm.home()
    except Exception as exc:  # noqa: BLE001
        raise fail(exc, "Home feed") from exc


@app.get("/api/explore")
def api_explore():
    try:
        return ytm.explore()
    except Exception as exc:  # noqa: BLE001
        raise fail(exc, "Explore") from exc


@app.get("/api/search")
def api_search(
    q: str = Query("", min_length=0, max_length=200),
    type: str = Query("all"),
    limit: int = Query(20, ge=1, le=50),
):
    kind = type if type in ("all", "songs", "albums", "artists", "playlists") else "all"
    try:
        return ytm.search(q, kind, limit)
    except Exception as exc:  # noqa: BLE001
        raise fail(exc, "Search") from exc


@app.get("/api/suggestions")
def api_suggestions(q: str = Query("", max_length=200)):
    try:
        return {"items": ytm.suggestions(q)}
    except Exception as exc:  # noqa: BLE001
        raise fail(exc, "Suggestions") from exc


@app.get("/api/artist/{browse_id}")
def api_artist(browse_id: str):
    try:
        return ytm.artist(browse_id)
    except Exception as exc:  # noqa: BLE001
        raise fail(exc, "Artist") from exc


@app.get("/api/album/{browse_id}")
def api_album(browse_id: str):
    try:
        return ytm.album(browse_id)
    except Exception as exc:  # noqa: BLE001
        raise fail(exc, "Album") from exc


@app.get("/api/playlist/{playlist_id}")
def api_playlist(playlist_id: str, limit: int = Query(500, ge=1, le=1000)):
    try:
        return ytm.playlist(playlist_id, limit)
    except Exception as exc:  # noqa: BLE001
        raise fail(exc, "Playlist") from exc


@app.get("/api/watch/{video_id}")
def api_watch(video_id: str, limit: int = Query(50, ge=1, le=100)):
    try:
        return ytm.watch(video_id, limit)
    except Exception as exc:  # noqa: BLE001
        raise fail(exc, "Up next") from exc


def _radio_key(value: str) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip().lower())


def _radio_error(exc: Exception) -> str:
    return f"{type(exc).__name__}: {str(exc)[:240]}"


def _radio_seed_metadata(video_id: str, title: str, artist: str) -> tuple[str, str]:
    title = (title or "").strip()
    artist = (artist or "").strip()
    if title and artist:
        return title, artist
    try:
        response = requests.get(
            "https://www.youtube.com/oembed",
            params={
                "url": f"https://www.youtube.com/watch?v={video_id}",
                "format": "json",
            },
            headers={"User-Agent": ytm.USER_AGENT},
            timeout=8,
        )
        response.raise_for_status()
        data = response.json()
        title = title or str(data.get("title") or "").strip()
        artist = artist or str(data.get("author_name") or "").strip()
    except Exception as exc:  # noqa: BLE001 - metadata is only for the fallback
        log.info("Radio seed metadata %s failed: %s", video_id, _radio_error(exc))
    return title, artist


def _radio_search_fallback(
    video_id: str, title: str, artist: str, artist_id: str
) -> tuple[list[dict], str]:
    """Build a radio-like mix from YouTube Music search and related artists.

    The ``next`` endpoint used by YouTube Music radio is sometimes blocked for
    cloud-hosted IPs. Search and artist pages use different endpoints and keep
    working, so this fallback keeps autoplay useful instead of silently
    stopping after the current song.
    """
    title, artist = _radio_seed_metadata(video_id, title, artist)
    seen_ids = {video_id}
    seen_keys: set[str] = set()
    if title or artist:
        seen_keys.add(f"{_radio_key(title)}|{_radio_key(artist)}")
    allowed_artists: set[str] = set()
    if artist:
        allowed_artists.add(_radio_key(artist))
        for part in re.split(
            r"\s*(?:,|&|/|\bfeat\.?\b|\bft\.?\b)\s*", artist, flags=re.I
        ):
            part = _radio_key(part)
            if part:
                allowed_artists.add(part)
    seed_title_key = _radio_key(title)
    tracks: list[dict] = []

    def add(items, require_known_artist: bool = False) -> None:
        for item in items or []:
            if len(tracks) >= 50:
                return
            if not isinstance(item, dict) or not item.get("videoId"):
                continue
            item_id = item["videoId"]
            if item_id in seen_ids:
                continue
            item_title = _radio_key(item.get("title"))
            if seed_title_key and item_title == seed_title_key:
                continue
            item_artist = _radio_key(item.get("artistText"))
            if require_known_artist and allowed_artists:
                if not any(name in item_artist for name in allowed_artists):
                    continue
            key = f"{_radio_key(item.get('title'))}|{item_artist}"
            if key in seen_keys:
                continue
            seen_ids.add(item_id)
            seen_keys.add(key)
            tracks.append(item)

    queries = []
    if title and artist:
        queries.append(f"{title} {artist}")
    if artist:
        queries.append(artist)
    if title:
        queries.append(title)

    if queries:
        with ThreadPoolExecutor(max_workers=len(queries)) as pool:
            futures = [
                pool.submit(ytm.search, query, "songs", 25) for query in queries
            ]
            for query, future in zip(queries, futures):
                if len(tracks) >= 50:
                    break
                try:
                    add(
                        future.result().get("items"),
                        require_known_artist=bool(allowed_artists),
                    )
                except Exception as exc:  # noqa: BLE001
                    log.info("Radio search %r failed: %s", query, _radio_error(exc))

    if artist_id and len(tracks) < 12:
        related_ids: list[str] = []
        try:
            info = ytm.artist(artist_id)
            add(info.get("songs"))
            for related in (info.get("related") or [])[:3]:
                browse_id = related.get("browseId")
                if not browse_id:
                    continue
                related_ids.append(browse_id)
                related_name = _radio_key(related.get("name"))
                if related_name:
                    allowed_artists.add(related_name)
        except Exception as exc:  # noqa: BLE001
            log.info("Radio artist %s failed: %s", artist_id, _radio_error(exc))

        if related_ids and len(tracks) < 50:
            with ThreadPoolExecutor(max_workers=len(related_ids)) as pool:
                futures = {
                    browse_id: pool.submit(ytm.artist, browse_id)
                    for browse_id in related_ids
                }
                for browse_id, future in futures.items():
                    if len(tracks) >= 50:
                        break
                    try:
                        add(future.result().get("songs"))
                    except Exception as exc:  # noqa: BLE001
                        log.info(
                            "Radio related artist %s failed: %s",
                            browse_id,
                            _radio_error(exc),
                        )

    return tracks, title


_radio_sidecar_lock = threading.Lock()
_radio_sidecar_block_until = 0.0
_radio_watch_lock = threading.Lock()
_radio_watch_block_until = 0.0


@app.get("/api/radio/{video_id}")
def api_radio(
    video_id: str,
    request: Request,
    title: str = Query("", max_length=300),
    artist: str = Query("", max_length=300),
    artistId: str = Query("", max_length=100),
):
    _radio_rate_limit(request)

    if not stream.VIDEO_ID_RE.match(video_id or ""):
        raise HTTPException(status_code=400, detail="Invalid video id")

    global _radio_sidecar_block_until, _radio_watch_block_until

    cookie = ytm.auth_cookie() if ytm.is_authenticated() else None
    result: dict | None = None
    with _radio_sidecar_lock:
        sidecar_blocked = time.time() < _radio_sidecar_block_until
    if sidecar_blocked:
        log.info("Radio %s skipping sidecar after recent failure", video_id)
    else:
        try:
            result = node_runtime.radio(video_id, cookie=cookie, timeout=6.0)
        except Exception as exc:  # noqa: BLE001 - radio must never break playback
            log.warning("Radio %s sidecar failed: %s", video_id, _radio_error(exc))
            with _radio_sidecar_lock:
                _radio_sidecar_block_until = time.time() + 120.0

        if result and result.get("ok") and result.get("tracks"):
            with _radio_sidecar_lock:
                _radio_sidecar_block_until = 0.0
            return result
        if result:
            log.warning(
                "Radio %s sidecar returned %s: %s",
                video_id,
                result.get("reason") or ("empty" if result.get("ok") else "error"),
                str(result.get("detail") or "")[:240],
            )
            if not result.get("ok"):
                with _radio_sidecar_lock:
                    _radio_sidecar_block_until = time.time() + 120.0

    # Fall back to the catalog watch-next panel if the Node sidecar is down or
    # YouTube Music refuses the request. The frontend gets the same track shape.
    with _radio_watch_lock:
        watch_blocked = time.time() < _radio_watch_block_until
    if watch_blocked:
        log.info("Radio %s skipping watch fallback after recent failure", video_id)
    else:
        try:
            data = ytm.watch(video_id, 50)
            tracks = [track for track in (data.get("tracks") or []) if track]
            if tracks:
                with _radio_watch_lock:
                    _radio_watch_block_until = 0.0
                seed = next(
                    (track for track in tracks if track.get("videoId") == video_id),
                    tracks[0],
                )
                return {
                    "ok": True,
                    "seed": {
                        "videoId": video_id,
                        "title": (seed or {}).get("title") or "",
                        "isVideo": bool(seed and not seed.get("album")),
                    },
                    "tracks": tracks,
                    "personal": bool(cookie),
                    "fallback": "ytmusicapi",
                }
        except Exception as exc:  # noqa: BLE001
            log.warning(
                "Radio %s watch fallback failed: %s", video_id, _radio_error(exc)
            )
            with _radio_watch_lock:
                _radio_watch_block_until = time.time() + 120.0

    try:
        tracks, seed_title = _radio_search_fallback(
            video_id, title, artist, artistId
        )
        if tracks:
            return {
                "ok": True,
                "seed": {
                    "videoId": video_id,
                    "title": seed_title,
                    "isVideo": False,
                },
                "tracks": tracks,
                "personal": bool(cookie),
                "fallback": "search",
            }
    except Exception as exc:  # noqa: BLE001
        log.warning(
            "Radio %s search fallback failed: %s", video_id, _radio_error(exc)
        )

    raise HTTPException(status_code=502, detail="Radio is unavailable right now.")


@app.get("/api/lyrics")
def api_lyrics(
    videoId: str,
    title: str = "",
    artist: str = "",
    album: str = "",
    duration: float = Query(0, ge=0),
):
    try:
        return ytm.lyrics(videoId, title, artist, album, int(duration or 0))
    except Exception as exc:  # noqa: BLE001
        raise fail(exc, "Lyrics") from exc


@app.post("/api/prefetch/{video_id}")
def api_prefetch(video_id: str):
    stream.prefetch(video_id)
    return {"ok": True}


# --------------------------------------------------------------------------
# Audio proxy (Range-aware, 1 MiB upstream reads, mid-track refresh)
# --------------------------------------------------------------------------

STREAM_CHUNK = 1024 * 1024
UPSTREAM_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/131.0 Safari/537.36"
    ),
    "Accept": "*/*",
    "Accept-Encoding": "identity",
}

RATE_LIMIT = 180
RATE_WINDOW = 60.0
_rate_lock = threading.Lock()
_rate_hits: dict[str, list[float]] = {}


def _rate_limit(request: Request) -> None:
    client = request.client.host if request.client else "unknown"
    now = time.time()
    with _rate_lock:
        hits = [stamp for stamp in _rate_hits.get(client, []) if now - stamp < RATE_WINDOW]
        if len(hits) >= RATE_LIMIT:
            _rate_hits[client] = hits
            raise HTTPException(
                status_code=429,
                detail="Too many audio requests. Please wait a moment.",
                headers={"Retry-After": "30"},
            )
        hits.append(now)
        _rate_hits[client] = hits
        if len(_rate_hits) > 2048:
            for key, values in list(_rate_hits.items()):
                if not values or now - values[-1] > RATE_WINDOW:
                    _rate_hits.pop(key, None)


RADIO_RATE_LIMIT = 30
RADIO_RATE_WINDOW = 60.0
_radio_rate_lock = threading.Lock()
_radio_rate_hits: dict[str, list[float]] = {}


def _radio_rate_limit(request: Request) -> None:
    client = request.client.host if request.client else "unknown"
    now = time.time()
    with _radio_rate_lock:
        hits = [
            stamp
            for stamp in _radio_rate_hits.get(client, [])
            if now - stamp < RADIO_RATE_WINDOW
        ]
        if len(hits) >= RADIO_RATE_LIMIT:
            _radio_rate_hits[client] = hits
            raise HTTPException(
                status_code=429,
                detail="Too many radio requests. Please wait a moment.",
                headers={"Retry-After": "30"},
            )
        hits.append(now)
        _radio_rate_hits[client] = hits
        if len(_radio_rate_hits) > 2048:
            for key, values in list(_radio_rate_hits.items()):
                if not values or now - values[-1] > RADIO_RATE_WINDOW:
                    _radio_rate_hits.pop(key, None)


def _parse_range(
    range_header: str | None, total: int | None
) -> tuple[int, int | None, int]:
    if not range_header:
        if total:
            return 0, total - 1, 200
        # Unknown total: serve one bounded chunk so the browser can keep
        # asking for ranges as playback continues.
        return 0, STREAM_CHUNK - 1, 206

    match = re.match(r"^bytes=(\d*)-(\d*)$", range_header.strip())
    if not match:
        raise ValueError("Unsupported range")

    start_text, end_text = match.groups()
    if not start_text and not end_text:
        raise ValueError("Invalid range")
    if total is None:
        raise ValueError("Unknown content length")

    if not start_text:
        suffix = int(end_text)
        if suffix <= 0:
            raise ValueError("Invalid suffix range")
        start = max(0, total - suffix)
        end = total - 1
    else:
        start = int(start_text)
        end = int(end_text) if end_text else total - 1

    if start >= total or start > end:
        raise ValueError("Range not satisfiable")
    return start, min(end, total - 1), 206


def _probe_total(video_id: str, entry: dict) -> int | None:
    for _ in range(2):
        try:
            upstream = requests.get(
                entry["url"],
                headers={**UPSTREAM_HEADERS, "Range": "bytes=0-0"},
                stream=True,
                timeout=(15, 30),
                allow_redirects=True,
            )
        except requests.RequestException:
            return None

        if upstream.status_code in (401, 403, 410):
            upstream.close()
            try:
                entry = stream.refresh(video_id, entry.get("itag"))
            except Exception:  # noqa: BLE001
                return None
            continue

        if upstream.status_code == 206:
            content_range = upstream.headers.get("content-range") or ""
            upstream.close()
            match = re.match(r"bytes\s+\d+-\d+/(\d+)", content_range)
            if match:
                return int(match.group(1))
            return None

        if upstream.status_code == 200:
            length = upstream.headers.get("content-length")
            upstream.close()
            if length and length.isdigit():
                return int(length)
            return None

        upstream.close()
        return None
    return None


def _read_range(video_id: str, entry: dict, start: int, end: int) -> tuple[bytes, dict]:
    """Read one bounded range, refreshing the URL after a mid-track 403."""
    if end < start:
        return b"", entry

    last_error: Exception | None = None
    for attempt in range(3):
        try:
            upstream = requests.get(
                entry["url"],
                headers={**UPSTREAM_HEADERS, "Range": f"bytes={start}-{end}"},
                stream=True,
                timeout=(15, 60),
                allow_redirects=True,
            )
        except requests.RequestException as exc:
            last_error = exc
            time.sleep(0.2 * (attempt + 1))
            continue

        if upstream.status_code in (401, 403, 410):
            upstream.close()
            try:
                entry = stream.refresh(video_id, entry.get("itag"))
            except stream.UnplayableError:
                raise
            except Exception as exc:  # noqa: BLE001
                last_error = exc
                break
            continue

        if upstream.status_code == 416:
            upstream.close()
            raise HTTPException(status_code=416, detail="Requested range is not satisfiable")

        if upstream.status_code >= 400:
            upstream.close()
            last_error = RuntimeError(f"upstream returned HTTP {upstream.status_code}")
            continue

        remaining = end - start + 1
        buffer = bytearray()
        # If the upstream ignored the Range header and returned 200, skip the
        # prefix so the requested bytes still line up.
        skip = start if upstream.status_code == 200 else 0
        try:
            for chunk in upstream.iter_content(chunk_size=64 * 1024):
                if not chunk:
                    continue
                if skip:
                    if len(chunk) <= skip:
                        skip -= len(chunk)
                        continue
                    chunk = chunk[skip:]
                    skip = 0
                buffer.extend(chunk)
                if len(buffer) >= remaining:
                    del buffer[remaining:]
                    break
        finally:
            upstream.close()

        if len(buffer) < remaining:
            last_error = RuntimeError("upstream closed the range early")
            continue
        return bytes(buffer), entry

    raise HTTPException(
        status_code=502,
        detail=f"Audio upstream error: {last_error or 'could not read the requested range'}",
    )


def _iter_chunks(video_id: str, entry: dict, start: int, end: int):
    position = start
    while position <= end:
        chunk_end = min(position + STREAM_CHUNK - 1, end)
        data, entry = _read_range(video_id, entry, position, chunk_end)
        if data:
            yield data
        position = chunk_end + 1


@app.api_route("/api/stream/{video_id}", methods=["GET", "HEAD"])
def api_stream(video_id: str, request: Request):
    _rate_limit(request)

    if not stream.VIDEO_ID_RE.match(video_id or ""):
        raise HTTPException(status_code=400, detail="Invalid video id")

    try:
        entry = stream.resolve(video_id)
    except stream.UnplayableError as exc:
        status = 404 if exc.reason in ("removed", "private") else 403
        raise HTTPException(status_code=status, detail=exc.detail) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        log.warning("Stream %s failed: %s", video_id, exc)
        message = str(exc)
        if "Sign in to confirm" in message or "not a bot" in message:
            detail = "Could not resolve audio for this track right now. Please try again."
        else:
            detail = (
                "Could not resolve audio for this track. The service may be busy. "
                "Please try again in a moment."
            )
        raise HTTPException(status_code=502, detail=detail) from exc

    total = entry.get("content_length")
    if not total:
        total = _probe_total(video_id, entry)
        if total:
            entry["content_length"] = total

    try:
        start, end, status_code = _parse_range(request.headers.get("range"), total)
    except ValueError:
        headers = {"Accept-Ranges": "bytes", "Cache-Control": "no-store"}
        if total:
            headers["Content-Range"] = f"bytes */{total}"
        return Response(status_code=416, headers=headers)

    length = (end - start + 1) if end is not None else None
    headers = {
        "Content-Type": entry["mime"],
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
    }
    if status_code == 206:
        headers["Content-Range"] = f"bytes {start}-{end}/{total if total else '*'}"
    if length is not None:
        headers["Content-Length"] = str(length)

    if request.method == "HEAD":
        return Response(status_code=status_code, headers=headers)

    first_end = (
        min(start + STREAM_CHUNK - 1, end)
        if end is not None
        else start + STREAM_CHUNK - 1
    )
    try:
        first, entry = _read_range(video_id, entry, start, first_end)
    except stream.UnplayableError as exc:
        status = 404 if exc.reason in ("removed", "private") else 403
        raise HTTPException(status_code=status, detail=exc.detail) from exc
    remaining_start = start + len(first)

    def body():
        if first:
            yield first
        if end is not None and remaining_start <= end:
            yield from _iter_chunks(video_id, entry, remaining_start, end)

    return StreamingResponse(body(), status_code=status_code, headers=headers)


# --------------------------------------------------------------------------
# Static frontend
# --------------------------------------------------------------------------


@app.middleware("http")
async def revalidate_frontend(request: Request, call_next):
    """Keep the no-build frontend fresh: always revalidate HTML/JS/CSS."""
    response = await call_next(request)
    path = request.url.path
    if path == "/" or path.endswith((".html", ".js", ".css")):
        response.headers["Cache-Control"] = "no-cache, must-revalidate"
    return response


class SPAStaticFiles(StaticFiles):
    """Serve the SPA shell for client-side routes while keeping assets strict."""

    async def get_response(self, path: str, scope):
        try:
            return await super().get_response(path, scope)
        except StarletteHTTPException as exc:
            method = scope.get("method", "GET")
            last_segment = path.rsplit("/", 1)[-1]
            if (
                exc.status_code != 404
                or method not in ("GET", "HEAD")
                or path.startswith("api/")
                or "." in last_segment
            ):
                raise
            return await super().get_response("index.html", scope)


if os.path.isdir(WEB_DIR):
    app.mount("/", SPAStaticFiles(directory=WEB_DIR, html=True), name="web")
else:  # pragma: no cover
    log.warning("Web directory not found at %s", WEB_DIR)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        app,
        host="0.0.0.0",
        port=int(os.environ.get("PORT", "8420")),
    )
