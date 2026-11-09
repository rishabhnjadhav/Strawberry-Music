"""Supervise the Node.js YouTube.js audio resolver sidecar.

The FastAPI app is deployed as a Python web service. Render's Python runtime
does not guarantee that Node.js is installed, so this module finds an existing
``node`` binary or downloads a pinned official Node.js build into ``.bin/``.
The resolver itself is committed as a pre-bundled CommonJS file, so no npm
install is needed at runtime.
"""

from __future__ import annotations

import hashlib
import logging
import os
import platform
import shutil
import subprocess
import tarfile
import threading
import time
import urllib.request
import zipfile
from typing import Any

import requests

log = logging.getLogger("strawberry.node")

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE_DIR = os.path.join(PROJECT_ROOT, ".bin", "node")
RESOLVER_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "node")
RESOLVER_BUNDLE = os.path.join(RESOLVER_DIR, "resolver.bundle.cjs")

NODE_VERSION = os.environ.get("OMNI_NODE_VERSION", "22.11.0")
NODE_ASSETS = {
    ("linux", "x86_64"): (
        f"node-v{NODE_VERSION}-linux-x64.tar.xz",
        "83bf07dd343002a26211cf1fcd46a9d9534219aad42ee02847816940bf610a72",
        "tar.xz",
    ),
    ("windows", "x86_64"): (
        f"node-v{NODE_VERSION}-win-x64.zip",
        "905373a059aecaf7f48c1ce10ffbd5334457ca00f678747f19db5ea7d256c236",
        "zip",
    ),
}

_guard = threading.Lock()
_node_lock = threading.Lock()
_process: subprocess.Popen | None = None
_port: int | None = None
_last_error: str | None = None
_node_path: str | None = None


class SidecarUnavailable(RuntimeError):
    """Raised when the Node resolver is not running."""


def _runtime_platform() -> tuple[str, str]:
    system = platform.system().lower()
    machine = platform.machine().lower()
    if machine == "amd64":
        machine = "x86_64"
    return system, machine


def _find_node() -> str | None:
    override = os.environ.get("OMNI_NODE_BIN")
    if override and os.path.exists(override):
        return override

    found = shutil.which("node")
    if found:
        return found

    candidates = [
        os.path.join(NODE_DIR, "node.exe" if os.name == "nt" else "node"),
        os.path.join(
            NODE_DIR,
            f"node-v{NODE_VERSION}-win-x64",
            "node.exe",
        ),
        os.path.join(
            NODE_DIR,
            f"node-v{NODE_VERSION}-linux-x64",
            "bin",
            "node",
        ),
    ]
    for candidate in candidates:
        if os.path.exists(candidate):
            return candidate
    return None


def ensure_node() -> str | None:
    """Return a Node.js binary, downloading a pinned build if necessary."""
    global _node_path, _last_error

    if _node_path and os.path.exists(_node_path):
        return _node_path

    with _node_lock:
        if _node_path and os.path.exists(_node_path):
            return _node_path

        found = _find_node()
        if found:
            _node_path = found
            return found

        asset = NODE_ASSETS.get(_runtime_platform())
        if not asset:
            _last_error = "No Node.js download is configured for this platform."
            return None

        asset_name, expected_hash, kind = asset
        url = f"https://nodejs.org/dist/v{NODE_VERSION}/{asset_name}"
        os.makedirs(NODE_DIR, exist_ok=True)
        archive_path = os.path.join(NODE_DIR, asset_name)

        try:
            log.info("Downloading Node.js %s for the audio resolver", NODE_VERSION)
            with urllib.request.urlopen(url, timeout=120) as response:
                payload = response.read()
            digest = hashlib.sha256(payload).hexdigest().lower()
            if digest != expected_hash.lower():
                _last_error = "Downloaded Node.js archive failed its SHA-256 check."
                return None

            with open(archive_path, "wb") as handle:
                handle.write(payload)

            if kind == "zip":
                with zipfile.ZipFile(archive_path) as archive:
                    archive.extractall(NODE_DIR)
            else:
                with tarfile.open(archive_path, "r:xz") as archive:
                    archive.extractall(NODE_DIR)

            found = _find_node()
            if found:
                try:
                    os.chmod(found, 0o755)
                except OSError:
                    pass
                _node_path = found
                _last_error = None
                return found

            _last_error = "Node.js archive did not contain a node binary."
            return None
        except Exception as exc:  # noqa: BLE001 - playback can fall back
            _last_error = f"Node.js download failed: {exc}"
            log.warning("Could not prepare Node.js: %s", exc)
            return None
        finally:
            try:
                if os.path.exists(archive_path):
                    os.remove(archive_path)
            except OSError:
                pass


def _read_stdout(process: subprocess.Popen) -> None:
    global _port
    stream = process.stdout
    if stream is None:
        return
    try:
        for line in stream:
            line = line.strip()
            if line.startswith("SIDECAR_PORT="):
                try:
                    _port = int(line.split("=", 1)[1])
                except (TypeError, ValueError):
                    continue
            elif line:
                log.debug("[node] %s", line)
    except Exception:  # noqa: BLE001 - process is exiting
        pass


def _read_stderr(process: subprocess.Popen) -> None:
    stream = process.stderr
    if stream is None:
        return
    try:
        for line in stream:
            line = line.rstrip()
            if line:
                log.warning("[node] %s", line[:500])
    except Exception:  # noqa: BLE001 - process is exiting
        pass


def start_sidecar(wait: float = 60.0) -> bool:
    """Start the Node resolver once and wait for its ephemeral port."""
    global _process, _port, _last_error

    with _guard:
        if _process is not None and _process.poll() is None and _port:
            return True

        if not os.path.exists(RESOLVER_BUNDLE):
            _last_error = "The bundled Node resolver is missing."
            log.warning(_last_error)
            return False

        node = ensure_node()
        if not node:
            _last_error = _last_error or "Node.js is not available."
            log.warning("Audio resolver disabled: %s", _last_error)
            return False

        env = os.environ.copy()
        env["PORT"] = "0"
        env.setdefault("NODE_ENV", "production")
        # Keep the sidecar memory footprint modest on the free Render plan.
        env.setdefault("NODE_OPTIONS", "--max-old-space-size=256")

        try:
            process = subprocess.Popen(
                [node, RESOLVER_BUNDLE],
                cwd=RESOLVER_DIR,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                stdin=subprocess.DEVNULL,
                text=True,
                bufsize=1,
                env=env,
            )
        except Exception as exc:  # noqa: BLE001 - playback can fall back
            _last_error = f"Could not start the Node resolver: {exc}"
            log.warning(_last_error)
            return False

        _process = process
        _port = None
        threading.Thread(
            target=_read_stdout, args=(process,), daemon=True, name="node-stdout"
        ).start()
        threading.Thread(
            target=_read_stderr, args=(process,), daemon=True, name="node-stderr"
        ).start()

        deadline = time.time() + max(1.0, wait)
        while time.time() < deadline:
            if process.poll() is not None:
                _last_error = f"Node resolver exited with code {process.returncode}."
                log.warning(_last_error)
                return False
            if _port:
                log.info("Audio resolver ready on 127.0.0.1:%s", _port)
                return True
            time.sleep(0.1)

        _last_error = "Timed out waiting for the Node resolver."
        log.warning(_last_error)
        return False


def available() -> bool:
    with _guard:
        return bool(_port and _process is not None and _process.poll() is None)


def resolve(
    video_id: str, timeout: float = 45.0, itag: int | None = None, strict: bool = False
) -> dict[str, Any]:
    """Ask the sidecar to resolve a video id."""
    if not available() and not start_sidecar(wait=30):
        raise SidecarUnavailable(_last_error or "The audio resolver is not ready.")

    with _guard:
        port = _port
    if not port:
        raise SidecarUnavailable("The audio resolver has no listening port.")

    payload: dict[str, Any] = {"videoId": video_id}
    if itag:
        payload["itag"] = int(itag)
    if strict:
        payload["strictItag"] = True

    try:
        response = requests.post(
            f"http://127.0.0.1:{port}/resolve",
            json=payload,
            timeout=(5, timeout),
        )
    except requests.RequestException as exc:
        raise SidecarUnavailable(f"Audio resolver request failed: {exc}") from exc

    if response.status_code not in (200, 502):
        raise SidecarUnavailable(
            f"Audio resolver returned HTTP {response.status_code}"
        )
    try:
        return response.json()
    except ValueError as exc:
        raise SidecarUnavailable("Audio resolver returned invalid JSON") from exc


def radio(
    video_id: str, cookie: str | None = None, timeout: float = 45.0
) -> dict[str, Any]:
    """Ask the sidecar for the YouTube Music radio mix for a video id."""
    if not available() and not start_sidecar(wait=30):
        raise SidecarUnavailable(_last_error or "The radio resolver is not ready.")

    with _guard:
        port = _port
    if not port:
        raise SidecarUnavailable("The radio resolver has no listening port.")

    payload: dict[str, Any] = {"videoId": video_id}
    if cookie:
        payload["cookie"] = cookie

    try:
        response = requests.post(
            f"http://127.0.0.1:{port}/radio",
            json=payload,
            timeout=(5, timeout),
        )
    except requests.RequestException as exc:
        raise SidecarUnavailable(f"Radio resolver request failed: {exc}") from exc

    if response.status_code not in (200, 502):
        raise SidecarUnavailable(
            f"Radio resolver returned HTTP {response.status_code}"
        )
    try:
        return response.json()
    except ValueError as exc:
        raise SidecarUnavailable("Radio resolver returned invalid JSON") from exc


def invalidate(video_id: str) -> None:
    if not available():
        return
    with _guard:
        port = _port
    if not port:
        return
    try:
        requests.post(
            f"http://127.0.0.1:{port}/invalidate",
            json={"videoId": video_id},
            timeout=5,
        )
    except requests.RequestException:
        pass


def health() -> dict[str, Any] | None:
    if not available():
        return None
    with _guard:
        port = _port
    if not port:
        return None
    try:
        response = requests.get(f"http://127.0.0.1:{port}/health", timeout=3)
        if response.status_code == 200:
            return response.json()
    except (requests.RequestException, ValueError):
        return None
    return None


def info() -> dict[str, Any]:
    with _guard:
        running = bool(_port and _process is not None and _process.poll() is None)
        port = _port
    return {
        "available": running,
        "port": port,
        "node": _node_path or _find_node(),
        "bundle": os.path.exists(RESOLVER_BUNDLE),
        "error": _last_error,
    }


def shutdown() -> None:
    global _process, _port
    with _guard:
        process = _process
        _process = None
        _port = None
    if process is None:
        return
    try:
        process.terminate()
        process.wait(timeout=3)
    except Exception:  # noqa: BLE001 - best effort
        try:
            process.kill()
        except Exception:  # noqa: BLE001
            pass
