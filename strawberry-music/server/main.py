"""Strawberry Music API server.

Run from the strawberry-music directory:

    python -m uvicorn server.main:app --host 127.0.0.1 --port 8420
"""

from __future__ import annotations

import logging
import os
import threading
from contextlib import asynccontextmanager

import requests
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import stream, ytm

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
# Audio proxy (supports HTTP range requests so seeking works)
# --------------------------------------------------------------------------


def _stream_chunks(response: requests.Response):
    try:
        for chunk in response.iter_content(chunk_size=64 * 1024):
            if chunk:
                yield chunk
    finally:
        response.close()


def _stream_headers(upstream: requests.Response, mime: str) -> dict[str, str]:
    passthrough: dict[str, str] = {}
    for header in (
        "content-type",
        "content-length",
        "content-range",
        "accept-ranges",
        "etag",
        "last-modified",
    ):
        value = upstream.headers.get(header)
        if value:
            passthrough[header] = value
    # Content-Range is only valid on 206/416 responses, never on a plain 200.
    if upstream.status_code == 200:
        passthrough.pop("content-range", None)
    passthrough.setdefault("content-type", mime)
    passthrough.setdefault("accept-ranges", "bytes")
    passthrough["cache-control"] = "no-store"
    return passthrough


@app.api_route("/api/stream/{video_id}", methods=["GET", "HEAD"])
def api_stream(video_id: str, request: Request):
    headers = {"Accept-Encoding": "identity"}
    range_header = request.headers.get("range")
    if range_header:
        headers["Range"] = range_header

    attempts = 0
    while True:
        try:
            info = stream.resolve(video_id)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            log.warning("Stream %s failed: %s", video_id, exc)
            message = str(exc)
            if "Sign in to confirm" in message or "not a bot" in message:
                detail = (
                    "YouTube is blocking anonymous playback from this server. "
                    "Open Settings → YouTube Music, connect your account, then try again."
                )
            else:
                detail = (
                    "Could not resolve audio for this track. The service may be busy. "
                    "Please try again in a moment."
                )
            raise HTTPException(status_code=502, detail=detail) from exc

        try:
            upstream = requests.get(
                info["url"],
                headers=headers,
                stream=True,
                timeout=(15, None),
                allow_redirects=True,
            )
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=502, detail=f"Audio upstream error: {exc}") from exc

        # A cached googlevideo URL can expire. Drop it and resolve once more.
        if upstream.status_code in (401, 403, 410) and attempts == 0:
            upstream.close()
            stream.invalidate(video_id)
            attempts += 1
            continue
        break

    if upstream.status_code == 416:
        passthrough = _stream_headers(upstream, info["mime"])
        upstream.close()
        return Response(status_code=416, headers=passthrough)

    if upstream.status_code >= 400:
        upstream.close()
        raise HTTPException(
            status_code=502,
            detail=f"Audio upstream returned HTTP {upstream.status_code}",
        )

    passthrough = _stream_headers(upstream, info["mime"])

    if request.method == "HEAD":
        upstream.close()
        return Response(status_code=upstream.status_code, headers=passthrough)

    return StreamingResponse(
        _stream_chunks(upstream),
        status_code=upstream.status_code,
        headers=passthrough,
    )


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
