"""Resolve catalog audio streams and cache the result."""

from __future__ import annotations

import hashlib
import os
import platform
import re
import shutil
import threading
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import parse_qs, quote

import requests
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

_jsc_lock = threading.Lock()
_jsc_director = None
_jsc_disabled = False
_player_lock = threading.Lock()
_player_cache: dict = {"at": 0.0, "sts": None, "player_url": None}

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUNTIME_DIR = os.path.join(PROJECT_ROOT, ".bin")
_QUICKJS_VERSION = "0.18.0"
_QUICKJS_ASSETS = {
    ("linux", "x86_64"): (
        "qjs-linux-x86_64",
        "85DED23B9FABE8C1644FC40A8D2BBDD71157AFFCBD807359C618CC717EE24D7D",
    ),
    ("windows", "x86_64"): (
        "qjs-windows-x86_64.exe",
        "FF03398D74EA6E6BD3A8E58058F7003225ABCAC229D7D57775B7AAAE812A49C7",
    ),
}
_runtime_lock = threading.Lock()
_runtime_attempted = False


def _runtime_platform() -> tuple[str, str]:
    system = platform.system().lower()
    machine = platform.machine().lower()
    if machine in ("amd64",):
        machine = "x86_64"
    elif machine in ("arm64",):
        machine = "aarch64"
    return system, machine


def _quickjs_path() -> str | None:
    found = shutil.which("qjs")
    if found:
        return found
    candidate = os.path.join(RUNTIME_DIR, "qjs.exe" if os.name == "nt" else "qjs")
    return candidate if os.path.exists(candidate) else None


def _js_runtimes() -> dict:
    runtimes: dict = {}
    for name in ("node", "deno"):
        if shutil.which(name):
            runtimes[name] = {}
    quickjs = _quickjs_path()
    if quickjs:
        runtimes["quickjs"] = {"path": quickjs}
    return runtimes


def js_runtime_available() -> bool:
    return bool(_js_runtimes())


def runtime_info() -> dict:
    runtimes = _js_runtimes()
    return {"available": bool(runtimes), "runtimes": sorted(runtimes)}


def ensure_js_runtime() -> bool:
    """Download the pinned QuickJS binary when no JS runtime is installed.

    yt-dlp needs a JavaScript runtime to solve YouTube signature/n challenges
    for the catalog player endpoint. Render's Python image may not include one,
    so the small QuickJS-ng binary is fetched once and verified by SHA-256.
    """
    global _runtime_attempted
    if js_runtime_available():
        return True
    with _runtime_lock:
        if js_runtime_available():
            return True
        if _runtime_attempted:
            return False
        _runtime_attempted = True
        asset = _QUICKJS_ASSETS.get(_runtime_platform())
        if not asset:
            return False
        asset_name, expected_hash = asset
        url = (
            f"https://github.com/quickjs-ng/quickjs/releases/download/"
            f"v{_QUICKJS_VERSION}/{asset_name}"
        )
        target = os.path.join(RUNTIME_DIR, "qjs.exe" if os.name == "nt" else "qjs")
        try:
            os.makedirs(RUNTIME_DIR, exist_ok=True)
            with urllib.request.urlopen(url, timeout=60) as response:
                payload = response.read()
            if hashlib.sha256(payload).hexdigest().upper() != expected_hash:
                return False
            temp_path = f"{target}.tmp"
            with open(temp_path, "wb") as handle:
                handle.write(payload)
            os.chmod(temp_path, 0o755)
            os.replace(temp_path, target)
            return True
        except Exception:  # noqa: BLE001 - fall back to other resolvers
            return False


def _get_jsc_director():
    """Build a yt-dlp JS challenge director for signature/n solving."""
    global _jsc_director, _jsc_disabled
    if _jsc_disabled:
        return None
    with _jsc_lock:
        if _jsc_director is not None:
            return _jsc_director
        try:
            from yt_dlp.extractor.youtube import YoutubeIE
            from yt_dlp.extractor.youtube.jsc._director import initialize_jsc_director

            runtimes = _js_runtimes()
            if not runtimes:
                _jsc_disabled = True
                return None
            ydl = yt_dlp.YoutubeDL(
                {
                    "quiet": True,
                    "no_warnings": True,
                    "js_runtimes": runtimes,
                    "remote_components": {"ejs:github"},
                }
            )
            _jsc_director = initialize_jsc_director(YoutubeIE(ydl))
        except Exception:  # noqa: BLE001 - fall back to other resolvers
            _jsc_disabled = True
            _jsc_director = None
        return _jsc_director


def _player_info(client) -> tuple[int | None, str | None]:
    now = time.time()
    with _player_lock:
        if _player_cache["sts"] and now - _player_cache["at"] < 3600:
            return _player_cache["sts"], _player_cache["player_url"]
    player_url = client.get_basejs_url()
    sts = client.get_signatureTimestamp(player_url)
    with _player_lock:
        _player_cache.update(at=time.time(), sts=sts, player_url=player_url)
    return sts, player_url


def _solve_sig(signature: str, player_url: str) -> str | None:
    director = _get_jsc_director()
    if director is None:
        return None
    try:
        from yt_dlp.extractor.youtube.jsc.provider import (
            JsChallengeRequest,
            JsChallengeType,
            SigChallengeInput,
        )

        dummy = "".join(map(chr, range(len(signature))))
        request = JsChallengeRequest(
            type=JsChallengeType.SIG,
            input=SigChallengeInput(challenges=[dummy], player_url=player_url),
        )
        with _jsc_lock:
            results = director.bulk_solve([request])
        for _, response in results:
            if response.type == JsChallengeType.SIG:
                spec = [ord(char) for char in response.output.results[dummy]]
                return "".join(signature[index] for index in spec)
    except Exception:  # noqa: BLE001 - fall back to other resolvers
        return None
    return None


def _solve_n(challenge: str, player_url: str) -> str | None:
    director = _get_jsc_director()
    if director is None:
        return None
    try:
        from yt_dlp.extractor.youtube.jsc.provider import (
            JsChallengeRequest,
            JsChallengeType,
            NChallengeInput,
        )

        request = JsChallengeRequest(
            type=JsChallengeType.N,
            input=NChallengeInput(challenges=[challenge], player_url=player_url),
        )
        with _jsc_lock:
            results = director.bulk_solve([request])
        for _, response in results:
            if response.type == JsChallengeType.N:
                return response.output.results[challenge]
    except Exception:  # noqa: BLE001 - fall back to other resolvers
        return None
    return None


def _resolve_ytmusic(video_id: str) -> dict | None:
    """Resolve audio through the catalog player endpoint and yt-dlp's JS solver.

    The catalog client keeps working from datacenter IPs where yt-dlp's
    anonymous clients are challenged. Its player response contains ciphered
    URLs, so a local JS runtime solves the signature/n challenges.
    """
    if not js_runtime_available() and not ensure_js_runtime():
        return None
    try:
        client = ytm.client()
        signature_timestamp, player_url = _player_info(client)
        if not signature_timestamp or not player_url:
            return None
        song = client.get_song(video_id, signatureTimestamp=signature_timestamp)
        if (song.get("playabilityStatus") or {}).get("status") != "OK":
            return None
        formats = (song.get("streamingData") or {}).get("adaptiveFormats") or []
        if not isinstance(formats, list):
            return None
        audio = [
            item
            for item in formats
            if str(item.get("mimeType") or "").startswith("audio/")
        ]
        if not audio:
            return None
        audio.sort(
            key=lambda item: (
                1 if "mp4" in str(item.get("mimeType") or "") else 0,
                item.get("bitrate") or 0,
            ),
            reverse=True,
        )
        best = audio[0]
        mime = str(best.get("mimeType") or "audio/mp4").split(";")[0].strip()
        if "mp4" in mime:
            ext = "m4a"
        elif "webm" in mime:
            ext = "webm"
        elif "mpeg" in mime:
            ext = "mp3"
        else:
            ext = "opus"

        url = best.get("url")
        if not url:
            cipher = best.get("signatureCipher")
            if not cipher:
                return None
            values = parse_qs(cipher)
            url = (values.get("url") or [None])[0]
            encrypted = (values.get("s") or [None])[0]
            signature_param = (values.get("sp") or ["signature"])[0]
            if not url or not encrypted:
                return None
            signature = _solve_sig(encrypted, player_url)
            if not signature:
                return None
            url = f"{url}&{signature_param}={signature}"

        if "n=" in url:
            match = re.search(r"([?&])n=([^&]+)", url)
            if match:
                solved_n = _solve_n(match.group(2), player_url)
                if not solved_n:
                    return None
                url = (
                    url[: match.start(2)]
                    + quote(solved_n, safe="")
                    + url[match.end(2) :]
                )

        details = song.get("videoDetails") or {}
        try:
            duration = int(details.get("lengthSeconds"))
        except (TypeError, ValueError):
            duration = None
        return {
            "url": url,
            "ext": ext,
            "mime": mime,
            "title": details.get("title"),
            "duration": duration,
            "expires": time.time() + 60 * 60,
        }
    except Exception:  # noqa: BLE001 - fall back to other resolvers
        return None


DEFAULT_INVIDIOUS = [
    "https://yt.chocolatemoo53.com",
    "https://inv.nadeko.net",
    "https://invidious.nerdvpn.de",
    "https://invidious.tiekoetter.com",
]


def invidious_instances() -> list[str]:
    value = os.environ.get("OMNI_INVIDIOUS")
    if value:
        return [item.strip().rstrip("/") for item in value.split(",") if item.strip()]
    return list(DEFAULT_INVIDIOUS)


def _invidious_first() -> bool:
    order = (os.environ.get("OMNI_STREAM_ORDER") or "").strip().lower()
    if order:
        return order == "invidious"
    # Render's datacenter IP is usually challenged by YouTube for anonymous
    # extraction, so use the proxy first there and keep yt-dlp as the fallback.
    return bool(os.environ.get("RENDER"))


def _resolve_invidious(video_id: str) -> dict | None:
    """Resolve through a public Invidious proxy.

    YouTube blocks anonymous extraction from many datacenter IPs. Invidious
    instances resolve the video from their own network and expose a proxied
    audio URL, which keeps playback working without asking every listener to
    sign in. The first working instance wins.
    """
    for base in invidious_instances():
        try:
            response = requests.get(
                f"{base}/api/v1/videos/{video_id}",
                params={"local": "true"},
                timeout=12,
            )
            if response.status_code != 200:
                continue
            data = response.json()
            formats = data.get("adaptiveFormats") or []
            if not isinstance(formats, list):
                continue
            audio = [
                item
                for item in formats
                if str(item.get("type") or "").startswith("audio/") and item.get("url")
            ]
            if not audio:
                continue
            # Prefer URLs proxied by the instance itself. A raw googlevideo URL
            # is bound to the instance's IP and would fail from our server.
            proxied = [item for item in audio if str(item["url"]).startswith(base)]
            if proxied:
                audio = proxied
            audio.sort(
                key=lambda item: (
                    1 if "mp4" in str(item.get("type") or "") else 0,
                    item.get("bitrate") or 0,
                ),
                reverse=True,
            )
            best = audio[0]
            mime = str(best.get("type") or "audio/mp4").split(";")[0].strip()
            if "mp4" in mime:
                ext = "m4a"
            elif "webm" in mime:
                ext = "webm"
            elif "mpeg" in mime:
                ext = "mp3"
            else:
                ext = "opus"
            return {
                "url": best["url"],
                "ext": ext,
                "mime": mime,
                "title": data.get("title"),
                "duration": data.get("lengthSeconds"),
                "expires": time.time() + 60 * 60,
            }
        except Exception:  # noqa: BLE001 - try the next mirror
            continue
    return None


def clients() -> list[str]:
    value = os.environ.get("OMNI_STREAM_CLIENTS") or os.environ.get("OMNI_YTDLP_CLIENTS")
    if value:
        return [client.strip() for client in value.split(",") if client.strip()]
    # The tv client does not require a PO token and works with account
    # cookies, which is what a signed-in YouTube Music session provides.
    # Anonymous requests fall back to android, which works on residential IPs.
    return ["tv", "android"] if ytm.auth_path() else ["android"]


def _base_options(client: str | None = None) -> dict:
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
    extractor_args = {"player_client": [client] if client else clients()}
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

        prefer_invidious = _invidious_first()
        if prefer_invidious:
            entry = _resolve_ytmusic(video_id)
            if entry:
                with _guard:
                    _cache[video_id] = entry
                    _failures.pop(video_id, None)
                    _lock_seen[video_id] = time.time()
                    _trim_cache_locked()
                return entry
            fallback = _resolve_invidious(video_id)
            if fallback:
                with _guard:
                    _cache[video_id] = fallback
                    _failures.pop(video_id, None)
                    _lock_seen[video_id] = time.time()
                    _trim_cache_locked()
                return fallback

        last_error: Exception | None = None
        for client in clients():
            try:
                with yt_dlp.YoutubeDL(_base_options(client)) as ydl:
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
            except Exception as exc:  # noqa: BLE001 - try the next client
                last_error = exc
                continue

        if not prefer_invidious:
            entry = _resolve_ytmusic(video_id)
            if entry:
                with _guard:
                    _cache[video_id] = entry
                    _failures.pop(video_id, None)
                    _lock_seen[video_id] = time.time()
                    _trim_cache_locked()
                return entry
            fallback = _resolve_invidious(video_id)
            if fallback:
                with _guard:
                    _cache[video_id] = fallback
                    _failures.pop(video_id, None)
                    _lock_seen[video_id] = time.time()
                    _trim_cache_locked()
                return fallback

        with _guard:
            _failures[video_id] = time.time()
        raise RuntimeError(str(last_error) or "Audio extraction failed") from last_error


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
