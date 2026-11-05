# Strawberry Music

A desktop-first web music player with a clean, Apple Music-inspired interface.
No build step, no frontend framework — a small FastAPI backend and vanilla
ES-module JavaScript in the browser.

```
omni-music/
├── server/
│   ├── main.py      FastAPI app, REST endpoints, audio proxy, static mount
│   ├── ytm.py       catalog client, caches, normalisers, lyrics
│   └── stream.py    stream resolver + prefetch cache
├── web/
│   ├── index.html   app shell, SVG sprite, sidebar, player, queue, now-playing
│   ├── css/
│   │   ├── styles.css
│   │   └── strawberry.css   light theme + SF Pro Display
│   ├── fonts/       SF Pro Display (uploaded)
│   ├── img/         Strawberry app icon + favicon
│   └── js/
│       ├── app.js      router, views, menus/modals/fullscreen
│       ├── api.js      fetch wrappers
│       ├── player.js   audio engine, queue/shuffle/repeat, lyrics, Media Session
│       ├── render.js   HTML templates
│       └── store.js    localStorage library (likes, playlists, history)
├── requirements.txt
├── run.bat
└── README.md
```

## Requirements

- **Python 3.11+** (tested on 3.13)
- Internet access for catalog data, artwork and audio
- No `ffmpeg` needed — audio is streamed, never downloaded or transcoded

## Run

Double-click `run.bat` (installs dependencies on first run and opens the browser),
or:

```powershell
cd omni-music
python -m pip install -r requirements.txt
python -m uvicorn server.main:app --host 127.0.0.1 --port 8420
```

Then open <http://127.0.0.1:8420>.

If port 8420 is busy:

```powershell
Get-NetTCPConnection -LocalPort 8420 | Select-Object -ExpandProperty OwningProcess -Unique |
  ForEach-Object { Stop-Process -Id $_ -Force }
```

## Features

- **Home** — greeting, recently played, listen-again albums/playlists, quick picks,
  and curated shelves.
- **Search** — songs/albums/artists/playlists, type filters, suggestions, recent
  searches, genre tiles.
- **Explore** — charts, new releases, trending, top artists, community playlists.
- **Library** — liked songs, saved albums, followed artists, local playlists,
  listening history (all in `localStorage`).
- **Player** — floating player bar, seek, volume/mute, shuffle, repeat off/all/one,
  autoplay radio when the queue ends, Media Session integration.
- **Now playing** — fullscreen overlay with blurred art-derived background, dynamic
  accent colour, Up Next, and synced lyrics.
- **Appearance** — light and dark themes, switchable in Settings and remembered on
  this device.
- **Queue drawer**, track context menus (play next, add to queue, like, start radio,
  go to artist/album, add to playlist), create/delete local playlists.

## Optional session

The app works without an account. For a more stable session, place a compatible
`auth.json` session file in `omni-music/` (or `server/`), or point
`OMNI_AUTH` at it, then restart the server. `/api/health` will report
`"authenticated": true`.

> Session files are local-only. Never commit `auth.json`.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `OMNI_AUTH` | – | Path to a session file |
| `OMNI_COUNTRY` | `IN` | Catalog country/region code |
| `OMNI_COOKIES` | – | Netscape cookies file for age/region-locked tracks |
| `OMNI_PROXY` | – | HTTP/SOCKS proxy for the stream resolver |
| `OMNI_STREAM_CLIENTS` | `android` | Comma-separated resolver clients, e.g. `android,ios` |

Example:

```powershell
$env:OMNI_COUNTRY="US"
$env:OMNI_COOKIES="C:\path\to\cookies.txt"
python -m uvicorn server.main:app --host 127.0.0.1 --port 8420
```

## API

| Method | Endpoint | Notes |
| --- | --- | --- |
| GET | `/api/health` | Version, session mode, stream cache stats |
| GET | `/api/home` | Shelves + quick picks (10 min cache) |
| GET | `/api/explore` | Charts/new releases/trending (10 min cache) |
| GET | `/api/search?q=&type=&limit=` | `all`, `songs`, `albums`, `artists`, `playlists` |
| GET | `/api/suggestions?q=` | Search autocomplete |
| GET | `/api/artist/{id}` | Artist page data |
| GET | `/api/album/{id}` | Album + tracks |
| GET | `/api/playlist/{id}?limit=` | Playlist + tracks |
| GET | `/api/watch/{videoId}?limit=` | Radio/queue tracks |
| GET | `/api/lyrics?videoId=&title=&artist=&album=&duration=` | Synced lyrics if available |
| POST | `/api/prefetch/{videoId}` | Warm the stream cache for the next track |
| GET/HEAD | `/api/stream/{videoId}` | Audio proxy with HTTP Range support |

Caches: home/search 5–10 min, artist/album/playlist 30 min, watch 15 min, lyrics
24 h, resolved streams 3 h.

## Troubleshooting

**Empty shelves or “Could not load Home”**
The catalog occasionally rate-limits bursts. Wait a few minutes and retry; the
server caches successful responses, so it recovers on its own. If it persists,
restart the server or add an optional session file.

**A track won't play**
The stream resolver can fail on age/region-restricted tracks. Set `OMNI_COOKIES`
(exported browser cookies) and/or `OMNI_PROXY`, then retry. The player will skip to
the next track after showing a toast.

**No lyrics**
Not every song has synced lyrics. The app falls back to plain lyrics when
available; instrumentals and very new releases may have neither.

**Port already in use**
Use the PowerShell snippet above, or run on another port:
`python -m uvicorn server.main:app --port 8421`.

**Nothing is saved between runs**
Likes, playlists and history live in the browser's `localStorage` under
`strawberry.music.v1`. Clearing site data resets the library. Existing
`omni.music.v1` data is migrated automatically.

## Credits

**Developed by Rishabh Jadhav**
