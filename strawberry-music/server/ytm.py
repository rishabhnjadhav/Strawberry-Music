"""Catalog client wrapper: auth, caching, normalisation and lyrics.

All responses are normalised into small, frontend-friendly objects:

    track    {kind, videoId, title, artists[], artistText, album, duration,
              durationSeconds, thumb, explicit, views, year}
    album    {kind, browseId, playlistId, title, artists[], artistText, year,
              type, thumb, explicit}
    playlist {kind, browseId, playlistId, title, author, itemCount,
              description, thumb, year}
    artist   {kind, browseId, name, subscribers, thumb, radioId}
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import requests
import ytmusicapi
from ytmusicapi import YTMusic

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(BASE_DIR)

COUNTRY = (os.environ.get("OMNI_COUNTRY") or "IN").upper()
AUTH_CANDIDATES = [
    os.environ.get("OMNI_AUTH"),
    os.environ.get("OMNI_YT_AUTH"),
    os.path.join(ROOT_DIR, "auth.json"),
    os.path.join(BASE_DIR, "auth.json"),
]
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0 Safari/537.36"
)

# --------------------------------------------------------------------------
# Client (one per thread so parallel searches do not share a requests session)
# --------------------------------------------------------------------------

_thread_local = threading.local()
_auth_path: str | None = None
_auth_lock = threading.Lock()
_client_generation = 0


def _is_browser_auth_file(path: str) -> bool:
    """Return True when *path* holds usable YouTube Music browser headers.

    ``ytmusicapi.setup`` happily writes a file for incomplete headers, so an
    existing file is not proof of a real session. Require the two values the
    browser flow always supplies.
    """
    try:
        with open(path, "r", encoding="utf-8-sig") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return False
    if not isinstance(data, dict):
        return False
    cookie = str(data.get("cookie") or "").strip()
    authorization = str(data.get("authorization") or "").strip()
    return bool(cookie and authorization)


def auth_path() -> str | None:
    global _auth_path
    with _auth_lock:
        if _auth_path is not None:
            return _auth_path or None
        for candidate in AUTH_CANDIDATES:
            if candidate and os.path.exists(candidate) and _is_browser_auth_file(candidate):
                _auth_path = candidate
                return candidate
        _auth_path = ""
        return None


def is_authenticated() -> bool:
    return bool(auth_path())


def auth_cookie() -> str | None:
    """Return the browser cookie header for an optional personal radio session.

    The value is read server-side and passed only to the local Node sidecar. It
    must never be logged or returned to the browser.
    """
    path = auth_path()
    if not path:
        return None
    try:
        with open(path, "r", encoding="utf-8-sig") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    cookie = str(data.get("cookie") or "").strip()
    cookie = re.sub(r"^\s*cookie\s*:\s*", "", cookie, flags=re.I)
    return cookie or None


def reset_clients() -> None:
    global _client_generation
    with _auth_lock:
        _client_generation += 1


def client() -> YTMusic:
    instance = getattr(_thread_local, "client", None)
    generation = getattr(_thread_local, "generation", -1)
    if instance is None or generation != _client_generation:
        path = auth_path()
        instance = YTMusic(path) if path else YTMusic()
        _thread_local.client = instance
        _thread_local.generation = _client_generation
    return instance


def _parse_cookie_pairs(text: str) -> dict[str, str]:
    text = re.sub(r"^\s*cookie\s*:\s*", "", text, flags=re.I)
    pairs: dict[str, str] = {}
    for part in text.split(";"):
        if "=" not in part:
            continue
        name, value = part.split("=", 1)
        name = name.strip()
        value = value.strip()
        if name and value:
            pairs[name] = value
    return pairs


def _parse_netscape_cookies(text: str) -> dict[str, str]:
    pairs: dict[str, str] = {}
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith("#HttpOnly_"):
            line = line[len("#HttpOnly_"):]
        elif line.startswith("#"):
            continue
        parts = line.split("\t")
        if len(parts) < 7:
            parts = line.split()
        if len(parts) < 7:
            continue
        domain, name, value = parts[0], parts[5], parts[6]
        if "youtube.com" in domain or "google.com" in domain:
            pairs[name] = value
    return pairs


def _sapisid_authorization(sapisid: str) -> str:
    timestamp = int(time.time())
    origin = "https://music.youtube.com"
    digest = hashlib.sha1(f"{timestamp} {sapisid} {origin}".encode("utf-8")).hexdigest()
    return f"SAPISIDHASH {timestamp}_{digest}"


def _headers_from_cookies(cookies: dict[str, str], sapisid_key: str) -> str:
    cookie_header = "; ".join(f"{name}={value}" for name, value in cookies.items())
    return "\n".join(
        (
            f"Cookie: {cookie_header}",
            f"Authorization: {_sapisid_authorization(cookies[sapisid_key])}",
            "X-Goog-AuthUser: 0",
            "Origin: https://music.youtube.com",
            f"User-Agent: {USER_AGENT}",
        )
    )


def _auth_header_candidates(raw: str) -> list[str]:
    """Turn a cookie string, cookies.txt export, or full headers into candidates."""
    text = (raw or "").strip()
    if not text:
        raise ValueError(
            "Paste the YouTube Music cookie or Request Headers, or upload a cookies.txt file."
        )

    lower = text.lower()
    if "authorization:" in lower and "cookie:" in lower:
        return [text]

    cookies: dict[str, str] | None = None
    if text.startswith("# Netscape") or "\t" in text:
        cookies = _parse_netscape_cookies(text)
    elif "cookie:" in lower:
        for line in text.splitlines():
            if line.lower().startswith("cookie:"):
                cookies = _parse_cookie_pairs(line.split(":", 1)[1])
                break
    else:
        cookies = _parse_cookie_pairs(text)

    if cookies:
        candidates = []
        for key in ("SAPISID", "__Secure-3PAPISID", "__Secure-1PAPISID"):
            if cookies.get(key):
                candidates.append(_headers_from_cookies(cookies, key))
        if candidates:
            return candidates
    return [text]


def connect(headers_raw: str) -> str:
    """Validate a YouTube Music session and persist it.

    Accepts a full Request Headers block, a raw Cookie value, or a Netscape
    cookies.txt export. Cookie-only input is upgraded by computing the
    SAPISIDHASH Authorization header, so users do not have to copy headers.

    Each candidate is written to a temporary file and probed against the
    account endpoint before it replaces the real auth file, so a failed attempt
    can never destroy an existing working session.
    """
    global _auth_path
    candidates = _auth_header_candidates(headers_raw)

    target = (
        os.environ.get("OMNI_AUTH")
        or os.environ.get("OMNI_YT_AUTH")
        or os.path.join(ROOT_DIR, "auth.json")
    )
    target = os.path.abspath(target)
    parent = os.path.dirname(target)
    if parent:
        os.makedirs(parent, exist_ok=True)

    last_error: Exception | None = None
    for headers in candidates:
        handle, temp_path = tempfile.mkstemp(
            prefix=".ytm-auth-", suffix=".json", dir=parent or None
        )
        os.close(handle)
        try:
            ytmusicapi.setup(filepath=temp_path, headers_raw=headers)
            if not _is_browser_auth_file(temp_path):
                raise ValueError(
                    "That session is missing the Cookie or Authorization value. "
                    "Export cookies for music.youtube.com and try again."
                )
            try:
                info = YTMusic(temp_path).get_account_info()
            except Exception as exc:  # noqa: BLE001
                raise ValueError(
                    "YouTube Music rejected that session. Sign in at music.youtube.com, "
                    "export fresh cookies, and try again."
                ) from exc
            if not isinstance(info, dict) or not (info.get("accountName") or info.get("channelHandle")):
                raise ValueError("YouTube Music did not return an account for that session.")
            os.replace(temp_path, target)
            last_error = None
            break
        except Exception as exc:  # noqa: BLE001 - try the next cookie candidate
            last_error = exc
            try:
                os.remove(temp_path)
            except OSError:
                pass

    if last_error is not None:
        raise last_error
    if not os.path.exists(target):
        raise ValueError("The sign-in did not create a session file.")

    with _auth_lock:
        _auth_path = target
    reset_clients()
    cache.clear()
    return target


def visitor_data() -> str | None:
    """Return the visitor id used by the catalog client.

    yt-dlp can reuse it so its YouTube requests look like the same client that
    already fetched the catalog successfully.
    """
    try:
        return client().headers.get("X-Goog-Visitor-Id") or None
    except Exception:  # noqa: BLE001
        return None


def cookie_file() -> str | None:
    """Write the signed-in browser cookies as a Netscape file for yt-dlp.

    YouTube rejects anonymous requests from many datacenter IPs with
    "Sign in to confirm you're not a bot". Reusing the cookies from the
    YouTube Music session lets the stream resolver pass that check.
    """
    path = auth_path()
    if not path:
        return None
    try:
        with open(path, "r", encoding="utf-8-sig") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return None
    raw = str(data.get("cookie") or "")
    pairs: list[tuple[str, str]] = []
    for part in raw.split(";"):
        if "=" not in part:
            continue
        name, value = part.split("=", 1)
        name = name.strip()
        value = value.strip().replace("\t", "").replace("\r", "").replace("\n", "")
        if name and value:
            pairs.append((name, value))
    if not pairs:
        return None

    target = os.path.join(os.path.dirname(path), "auth.cookies.txt")
    expires = int(time.time()) + 30 * 24 * 60 * 60
    lines = ["# Netscape HTTP Cookie File", "# Generated by Strawberry Music", ""]
    for domain in (".youtube.com", ".google.com"):
        for name, value in pairs:
            lines.append(f"{domain}\tTRUE\t/\tTRUE\t{expires}\t{name}\t{value}")
    temp_path = target + ".tmp"
    try:
        with open(temp_path, "w", encoding="utf-8", newline="\n") as handle:
            handle.write("\n".join(lines) + "\n")
        os.replace(temp_path, target)
        try:
            os.chmod(target, 0o600)
        except OSError:
            pass
    except OSError:
        try:
            os.remove(temp_path)
        except OSError:
            pass
        return None
    return target


def disconnect() -> None:
    global _auth_path
    paths = {candidate for candidate in AUTH_CANDIDATES if candidate}
    current = auth_path()
    if current:
        paths.add(current)
    for candidate in paths:
        if os.path.exists(candidate):
            try:
                os.remove(candidate)
            except OSError:
                pass
        cookie_path = os.path.join(os.path.dirname(candidate), "auth.cookies.txt")
        try:
            os.remove(cookie_path)
        except OSError:
            pass
    with _auth_lock:
        _auth_path = None
    reset_clients()
    cache.clear()


# --------------------------------------------------------------------------
# Tiny TTL cache
# --------------------------------------------------------------------------


class TTLCache:
    def __init__(self) -> None:
        self._data: dict[str, tuple[float, object]] = {}
        self._lock = threading.Lock()

    def get(self, key: str):
        with self._lock:
            entry = self._data.get(key)
            if not entry:
                return None
            expires, value = entry
            if expires < time.time():
                self._data.pop(key, None)
                return None
            return value

    def set(self, key: str, value, ttl: float) -> None:
        with self._lock:
            self._data[key] = (time.time() + ttl, value)

    def clear(self) -> None:
        with self._lock:
            self._data.clear()


cache = TTLCache()


def cached(key: str, ttl: float, producer):
    hit = cache.get(key)
    if hit is not None:
        return hit
    value = producer()
    cache.set(key, value, ttl)
    return value


# --------------------------------------------------------------------------
# Normalisers
# --------------------------------------------------------------------------


def parse_duration(value) -> int:
    if not value:
        return 0
    if isinstance(value, (int, float)):
        return int(value)
    parts = str(value).strip().split(":")
    try:
        numbers = [int(float(p)) for p in parts]
    except (TypeError, ValueError):
        return 0
    seconds = 0
    for number in numbers:
        seconds = seconds * 60 + number
    return seconds


def format_duration(seconds) -> str:
    try:
        seconds = int(seconds or 0)
    except (TypeError, ValueError):
        return ""
    if seconds <= 0:
        return ""
    hours, rem = divmod(seconds, 3600)
    minutes, secs = divmod(rem, 60)
    if hours:
        return f"{hours}:{minutes:02d}:{secs:02d}"
    return f"{minutes}:{secs:02d}"


def thumb_url(item, size: int = 544) -> str | None:
    if not isinstance(item, dict):
        return None
    thumbs = item.get("thumbnails") or item.get("thumbnail") or []
    if isinstance(thumbs, dict):
        thumbs = [thumbs]
    if not thumbs:
        return None
    best = max(
        thumbs,
        key=lambda t: (t.get("width") or 0) * (t.get("height") or 0),
    )
    url = best.get("url")
    if not url:
        return None
    if "googleusercontent.com" in url or "ggpht.com" in url:
        if re.search(r"=w\d+-h\d+", url):
            url = re.sub(r"=w\d+-h\d+[^=]*$", f"=w{size}-h{size}-l90-rj", url)
        elif re.search(r"=s\d+", url):
            url = re.sub(r"=s\d+[^=]*$", f"=s{size}", url)
    return url


def _artist_list(item) -> list[dict]:
    artists: list[dict] = []
    raw = item.get("artists") or []
    if isinstance(raw, dict):
        raw = [raw]
    for artist in raw:
        if isinstance(artist, dict) and artist.get("name"):
            artists.append({"name": artist["name"], "id": artist.get("id")})
        elif isinstance(artist, str) and artist:
            artists.append({"name": artist, "id": None})
    if not artists:
        name = item.get("artist") or item.get("author") or item.get("uploader")
        if isinstance(name, str) and name:
            artists.append({"name": name, "id": item.get("channelId")})
    return artists


def _artist_text(artists: list[dict]) -> str:
    return ", ".join(a["name"] for a in artists if a.get("name"))


_PLATFORM_AUTHOR_NAMES = {"youtube music", "youtube", "yt music", "ytmusic"}


def _author_text(author) -> str:
    if isinstance(author, dict):
        author = author.get("name") or ""
    text = str(author or "").strip()
    return "" if text.lower() in _PLATFORM_AUTHOR_NAMES else text


def norm_track(item, album_fallback=None, thumb_fallback=None) -> dict | None:
    if not isinstance(item, dict):
        return None
    video_id = item.get("videoId")
    if not video_id:
        return None
    artists = _artist_list(item)
    album = item.get("album") if isinstance(item.get("album"), dict) else album_fallback
    if isinstance(album, dict) and not album.get("id") and album_fallback:
        album = album_fallback
    duration_raw = item.get("duration") or item.get("length") or ""
    seconds = item.get("duration_seconds") or parse_duration(duration_raw)
    thumb = thumb_url(item) or thumb_fallback
    if thumb and "googleusercontent.com" in thumb and "=w" in thumb:
        pass
    return {
        "kind": "track",
        "videoId": video_id,
        "title": item.get("title") or "Unknown track",
        "artists": artists,
        "artistText": _artist_text(artists) or "Unknown artist",
        "album": (
            {"name": album.get("name"), "id": album.get("id")}
            if isinstance(album, dict) and album.get("name")
            else None
        ),
        "duration": duration_raw if isinstance(duration_raw, str) else format_duration(seconds),
        "durationSeconds": int(seconds or 0),
        "thumb": thumb,
        "explicit": bool(item.get("isExplicit")),
        "views": item.get("views"),
        "year": item.get("year"),
    }


def norm_album(item, artist_fallback: str | None = None) -> dict | None:
    if not isinstance(item, dict):
        return None
    browse_id = item.get("browseId")
    if not browse_id:
        return None
    artists = _artist_list(item)
    if not artists and artist_fallback:
        artists = [{"name": artist_fallback, "id": None}]
    return {
        "kind": "album",
        "browseId": browse_id,
        "playlistId": item.get("audioPlaylistId") or item.get("playlistId"),
        "title": item.get("title") or "Unknown album",
        "artists": artists,
        "artistText": _artist_text(artists),
        "year": item.get("year"),
        "type": item.get("type") or "Album",
        "thumb": thumb_url(item),
        "explicit": bool(item.get("isExplicit")),
    }


def norm_playlist(item) -> dict | None:
    if not isinstance(item, dict):
        return None
    playlist_id = item.get("playlistId") or item.get("browseId")
    if not playlist_id:
        return None
    return {
        "kind": "playlist",
        "browseId": item.get("browseId") or playlist_id,
        "playlistId": playlist_id,
        "title": item.get("title") or "Unknown playlist",
        "author": _author_text(item.get("author")),
        "itemCount": item.get("itemCount"),
        "description": item.get("description") or "",
        "thumb": thumb_url(item),
        "year": item.get("year"),
    }


def norm_artist(item) -> dict | None:
    if not isinstance(item, dict):
        return None
    browse_id = item.get("browseId") or item.get("channelId")
    if not browse_id:
        return None
    return {
        "kind": "artist",
        "browseId": browse_id,
        "name": item.get("artist") or item.get("title") or item.get("name") or "Unknown artist",
        "subscribers": item.get("subscribers"),
        "thumb": thumb_url(item),
        "radioId": item.get("radioId"),
    }


def norm_item(item) -> dict | None:
    if not isinstance(item, dict):
        return None
    result_type = item.get("resultType")
    if result_type in ("song", "video"):
        return norm_track(item)
    if result_type == "album":
        return norm_album(item)
    if result_type == "playlist":
        return norm_playlist(item)
    if result_type == "artist":
        return norm_artist(item)
    if result_type in ("episode", "podcast", "profile"):
        return None

    if item.get("videoId"):
        return norm_track(item)
    if item.get("browseId") and str(item.get("browseId") or "").lower().startswith("uc"):
        return norm_artist(item)
    if item.get("browseId") and (
        "subscribers" in item or (item.get("artist") and not item.get("type"))
    ):
        return norm_artist(item)
    if item.get("browseId") and (item.get("type") or item.get("audioPlaylistId")):
        return norm_album(item)
    if item.get("playlistId") and (
        "description" in item or "itemCount" in item or "author" in item
    ):
        return norm_playlist(item)
    if item.get("browseId"):
        return norm_album(item)
    if item.get("playlistId"):
        return norm_playlist(item)
    return None


def norm_items(items) -> list[dict]:
    output: list[dict] = []
    seen: set[str] = set()
    for item in items or []:
        normalised = norm_item(item)
        if not normalised:
            continue
        key = (
            normalised.get("videoId")
            or normalised.get("browseId")
            or normalised.get("playlistId")
        )
        if key and key in seen:
            continue
        if key:
            seen.add(key)
        output.append(normalised)
    return output


# --------------------------------------------------------------------------
# Endpoint helpers
# --------------------------------------------------------------------------

SEARCH_FILTERS = {
    "songs": "songs",
    "albums": "albums",
    "artists": "artists",
    "playlists": "playlists",
}


def search(query: str, kind: str = "all", limit: int = 20) -> dict:
    query = (query or "").strip()
    if not query:
        if kind in SEARCH_FILTERS:
            return {"items": [], "query": "", "type": kind}
        return {
            "songs": [],
            "albums": [],
            "artists": [],
            "playlists": [],
            "query": "",
            "type": "all",
        }

    key = f"search:{kind}:{limit}:{query.lower()}"
    return cached(key, 300, lambda: _search_uncached(query, kind, limit))


def _filtered_search(name: str, query: str, limit: int):
    # client() is thread-local, so this must run inside the worker thread.
    return client().search(query, filter=SEARCH_FILTERS[name], limit=limit)


def _charts(country: str):
    return client().get_charts(country=country)


def _search_uncached(query: str, kind: str, limit: int) -> dict:
    if kind in SEARCH_FILTERS:
        results = client().search(query, filter=SEARCH_FILTERS[kind], limit=limit)
        return {"items": norm_items(results)[:limit], "query": query, "type": kind}

    # "all": four filtered searches in parallel, so the UI can show real sections
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = {
            name: pool.submit(_filtered_search, name, query, min(limit, 12))
            for name in SEARCH_FILTERS
        }
        output = {"query": query, "type": "all"}
        per_section = max(3, min(limit, 12))
        for name, future in futures.items():
            try:
                output[name] = norm_items(future.result())[:per_section]
            except Exception:
                output[name] = []
        return output


def suggestions(query: str) -> list[str]:
    query = (query or "").strip()
    if not query:
        return []
    return cached(
        f"suggest:{query.lower()}",
        900,
        lambda: client().get_search_suggestions(query) or [],
    )


def home() -> dict:
    return cached("home", 600, _home_uncached)


def _home_uncached() -> dict:
    try:
        sections = client().get_home(limit=8) or []
    except Exception:
        return _fallback_home()

    quick_picks: list[dict] = []
    shelves: list[dict] = []
    for section in sections:
        items = norm_items(section.get("contents"))
        if not items:
            continue
        title = section.get("title") or "For you"
        if "quick pick" in title.lower():
            quick_picks = [item for item in items if item.get("kind") == "track"][:20]
            continue
        shelves.append({"title": title, "items": items})

    if not quick_picks:
        for shelf in shelves:
            tracks = [item for item in shelf["items"] if item.get("kind") == "track"]
            if tracks:
                quick_picks = tracks[:20]
                break

    _enrich_durations(quick_picks)
    return {"shelves": shelves, "quickPicks": quick_picks}


def _enrich_durations(tracks: list[dict]) -> None:
    """Home quick picks omit durations; fetch them from the song metadata."""
    missing = [track for track in tracks if not track.get("durationSeconds") and track.get("videoId")]
    if not missing:
        return

    def work(track: dict) -> None:
        try:
            data = client().get_song(track["videoId"]) or {}
            details = data.get("videoDetails") or {}
            seconds = int(details.get("lengthSeconds") or 0)
        except Exception:
            return
        if seconds:
            track["durationSeconds"] = seconds
            track["duration"] = format_duration(seconds)

    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(work, missing))


def _fallback_home() -> dict:
    """Used when the personalised home feed is unavailable."""

    queries = [
        ("Trending now", "top hits 2026"),
        ("Chill vibes", "chill hits"),
        ("Party starters", "party hits"),
        ("Focus flow", "focus instrumental"),
    ]
    results: dict[str, list[dict]] = {}
    artists: list[dict] = []

    def run_search(title: str, query: str):
        return title, norm_items(
            client().search(query, filter="songs", limit=12)
        )

    with ThreadPoolExecutor(max_workers=5) as pool:
        search_futures = [pool.submit(run_search, title, query) for title, query in queries]
        chart_future = pool.submit(_charts, COUNTRY)
        for future in search_futures:
            try:
                title, items = future.result()
                results[title] = items
            except Exception:
                continue
        try:
            charts = chart_future.result()
            artists = norm_items(charts.get("artists") or [])
        except Exception:
            pass

    shelves = []
    for title, _ in queries:
        if results.get(title):
            shelves.append({"title": title, "items": results[title]})
    if artists:
        shelves.append({"title": "Top artists", "items": artists[:12]})

    quick = results.get("Trending now", [])[:20]
    return {"shelves": shelves, "quickPicks": quick}


def explore() -> dict:
    return cached("explore", 900, _explore_uncached)


def _explore_uncached() -> dict:
    feed = home()
    new_releases = []
    for shelf in feed.get("shelves", []):
        if "new" in shelf["title"].lower():
            new_releases = [item for item in shelf["items"] if item.get("kind") == "album"]
            break

    if not new_releases:
        for shelf in feed.get("shelves", []):
            albums = [item for item in shelf.get("items", []) if item.get("kind") == "album"]
            if albums:
                new_releases = albums[:16]
                break

    if not new_releases:
        try:
            results = client().search("new releases", filter="albums", limit=12)
            new_releases = [item for item in norm_items(results) if item.get("kind") == "album"]
        except Exception:
            pass

    top_artists: list[dict] = []
    try:
        charts = client().get_charts(country=COUNTRY)
        top_artists = [a for a in norm_items(charts.get("artists") or []) if a["kind"] == "artist"]
    except Exception:
        pass

    if not top_artists:
        for shelf in feed.get("shelves", []):
            candidates = [item for item in shelf["items"] if item.get("kind") == "artist"]
            if candidates:
                top_artists = candidates
                break

    return {
        "trending": feed.get("quickPicks", []),
        "newReleases": new_releases,
        "topArtists": top_artists[:16],
        "shelves": feed.get("shelves", []),
    }


def artist(browse_id: str) -> dict:
    return cached(f"artist:{browse_id}", 1800, lambda: _artist_uncached(browse_id))


def _artist_uncached(browse_id: str) -> dict:
    raw = client().get_artist(browse_id)
    name = raw.get("name") or "Unknown artist"

    def section(key: str) -> list[dict]:
        data = raw.get(key) or {}
        results = data.get("results") if isinstance(data, dict) else None
        return results or []

    albums = [norm_album(item, name) for item in section("albums")]
    singles = [norm_album(item, name) for item in section("singles")]
    songs = [norm_track(item) for item in section("songs")]

    songs = [s for s in songs if s]
    _enrich_durations(songs)

    return {
        "kind": "artist",
        "browseId": browse_id,
        "name": name,
        "subscribers": raw.get("subscribers"),
        "description": raw.get("description") or "",
        "thumb": thumb_url(raw, 900),
        "songs": songs,
        "albums": [a for a in albums if a],
        "singles": [a for a in singles if a],
        "related": [
            artist_item
            for artist_item in norm_items(section("related"))
            if artist_item.get("kind") == "artist"
        ][:12],
    }


def album(browse_id: str) -> dict:
    return cached(f"album:{browse_id}", 1800, lambda: _album_uncached(browse_id))


def _album_uncached(browse_id: str) -> dict:
    raw = client().get_album(browse_id)
    title = raw.get("title") or "Unknown album"
    cover = thumb_url(raw, 900)
    album_ref = {"name": title, "id": browse_id}
    tracks = [
        norm_track(item, album_fallback=album_ref, thumb_fallback=cover)
        for item in raw.get("tracks") or []
    ]
    tracks = [t for t in tracks if t]
    artists = _artist_list(raw)
    total_seconds = sum(t.get("durationSeconds") or 0 for t in tracks)
    return {
        "kind": "album",
        "browseId": browse_id,
        "playlistId": raw.get("audioPlaylistId"),
        "title": title,
        "artists": artists,
        "artistText": _artist_text(artists),
        "year": raw.get("year"),
        "type": raw.get("type") or "Album",
        "description": raw.get("description") or "",
        "thumb": cover,
        "explicit": bool(raw.get("isExplicit")),
        "trackCount": len(tracks),
        "duration": format_duration(total_seconds),
        "tracks": tracks,
    }


def playlist(playlist_id: str, limit: int = 500) -> dict:
    return cached(
        f"playlist:{playlist_id}:{limit}",
        1800,
        lambda: _playlist_uncached(playlist_id, limit),
    )


def _playlist_uncached(playlist_id: str, limit: int) -> dict:
    raw = client().get_playlist(playlist_id, limit=limit)
    title = raw.get("title") or "Unknown playlist"
    cover = thumb_url(raw, 900)
    tracks = [
        norm_track(item, thumb_fallback=cover) for item in raw.get("tracks") or []
    ]
    tracks = [t for t in tracks if t]
    total_seconds = sum(t.get("durationSeconds") or 0 for t in tracks)
    return {
        "kind": "playlist",
        "browseId": raw.get("id") or playlist_id,
        "playlistId": playlist_id,
        "title": title,
        "author": _author_text(raw.get("author")),
        "description": raw.get("description") or "",
        "thumb": cover,
        "year": raw.get("year"),
        "trackCount": raw.get("trackCount") or len(tracks),
        "duration": format_duration(total_seconds),
        "tracks": tracks,
    }


def watch(video_id: str, limit: int = 50) -> dict:
    return cached(
        f"watch:{video_id}:{limit}", 900, lambda: _watch_uncached(video_id, limit)
    )


def _watch_uncached(video_id: str, limit: int) -> dict:
    raw = client().get_watch_playlist(video_id, limit=limit)
    tracks = [norm_track(item) for item in raw.get("tracks") or []]
    tracks = [t for t in tracks if t][:limit]
    return {
        "tracks": tracks,
        "lyricsId": raw.get("lyrics"),
        "relatedId": raw.get("related"),
    }


# --------------------------------------------------------------------------
# Lyrics (synced provider first, catalog lyrics as fallback)
# --------------------------------------------------------------------------

LRC_LINE = re.compile(r"\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]([^\[]*)")


def _parse_lrc(text: str) -> list[dict]:
    lines: list[dict] = []
    for raw_line in (text or "").splitlines():
        line = LRC_LINE.match((raw_line or "").strip())
        if not line:
            continue
        minutes = int(line.group(1))
        seconds = float(line.group(2).replace(":", "."))
        content = line.group(3).strip()
        if not content:
            continue
        lines.append({"time": minutes * 60 + seconds, "text": content})

    lines.sort(key=lambda line: line["time"])
    deduped: list[dict] = []
    for line in lines:
        if (
            not deduped
            or deduped[-1]["text"] != line["text"]
            or deduped[-1]["time"] != line["time"]
        ):
            deduped.append(line)
    return deduped


def _lrclib(title: str, artist: str, album: str, seconds: int):
    headers = {"User-Agent": "StrawberryMusic/1.0"}
    with requests.Session() as session:
        session.headers.update(headers)

        if title and artist and seconds:
            try:
                response = session.get(
                    "https://lrclib.net/api/get",
                    params={
                        "track_name": title,
                        "artist_name": artist.split(",")[0].strip(),
                        "album_name": album or "",
                        "duration": int(seconds),
                    },
                    timeout=8,
                )
                if response.ok:
                    data = response.json()
                    if data.get("syncedLyrics"):
                        return data
            except Exception:
                pass

        query = " ".join(part for part in (title, artist.split(",")[0] if artist else "") if part)
        if not query:
            return None
        try:
            response = session.get(
                "https://lrclib.net/api/search", params={"q": query}, timeout=8
            )
            if not response.ok:
                return None
            candidates = [item for item in response.json() if item.get("syncedLyrics")]
            if not candidates:
                return None

            def candidate_sort_key(item):
                duration = int(item.get("duration") or 0)
                distance = abs(duration - int(seconds or 0)) if seconds else -duration
                return distance

            candidates.sort(key=candidate_sort_key)
            return candidates[0]
        except Exception:
            return None


def lyrics(
    video_id: str,
    title: str = "",
    artist: str = "",
    album: str = "",
    seconds: int = 0,
) -> dict:
    key = f"lyrics:{video_id}:{int(seconds or 0)}"
    return cached(
        key,
        86400,
        lambda: _lyrics_uncached(video_id, title, artist, album, seconds),
    )


def _lyrics_uncached(video_id, title, artist, album, seconds) -> dict:
    data = _lrclib(title, artist, album, seconds)
    if data and data.get("syncedLyrics"):
        lines = _parse_lrc(data["syncedLyrics"])
        if lines:
            return {
                "synced": True,
                "lines": lines,
                "plain": "\n".join(line["text"] for line in lines),
                "source": "LRCLIB",
            }

    # Fall back to catalog plain lyrics
    try:
        watch_data = watch(video_id, limit=1)
        lyrics_id = watch_data.get("lyricsId")
        if lyrics_id:
            raw = client().get_lyrics(lyrics_id)
            if raw and raw.get("lyrics"):
                return {
                    "synced": False,
                    "lines": [],
                    "plain": raw["lyrics"],
                    "source": raw.get("source") or "Catalog",
                }
    except Exception:
        pass

    return {"synced": False, "lines": [], "plain": "", "source": None}


def status() -> dict:
    return {
        "authenticated": is_authenticated(),
        "country": COUNTRY,
        "authFile": os.path.basename(auth_path()) if auth_path() else None,
    }

