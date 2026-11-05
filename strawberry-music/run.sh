#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

if ! python -c "import fastapi, uvicorn, ytmusicapi, yt_dlp, requests" >/dev/null 2>&1; then
  echo "Installing dependencies..."
  python -m pip install -r requirements.txt
fi

PORT="${PORT:-8420}"
python -m uvicorn server.main:app --host 0.0.0.0 --port "$PORT"
