# Deploy Strawberry Music on Render + DigitalPlat .dpdns.org

This guide is written for a beginner. You do **not** need to use the command line.
The project already contains the Render configuration files:

- `render.yaml` — Render build/start settings
- `runtime.txt` — Python version
- `.gitignore` — keeps private files out of GitHub

> **Repository layout:** the app lives in the `strawberry-music/` folder.
> The root-level `render.yaml` sets `rootDir: strawberry-music`, so Render
> finds `requirements.txt` and `server/`. If you create the service manually,
> set **Root Directory** to `strawberry-music` (see Option B).

---

## 1. What Render will run

Render will run one Python web service:

- **Build command:** `pip install -r requirements.txt`
- **Start command:** `python -m server.main`
- **Health check path:** `/api/health`
- **Runtime:** Python 3
- **Plan:** Free

The server reads Render's `PORT` environment variable automatically. It also serves the `web/` folder, so the website and API are on the same URL.

---

## 2. Make sure private files stay off GitHub

The `.gitignore` file already excludes:

- `auth.json` and `server/auth.json`
- `cookies.txt`
- `.env` files
- private keys and client secrets
- Python cache files

Before you commit, open GitHub Desktop and check the **Changes** list. You should **not** see `auth.json`, `cookies.txt`, `.env`, or any secret file. If you do, stop and remove it from the repository before publishing.

---

## 3. Put the project on GitHub (easiest: GitHub Desktop)

1. Install **GitHub Desktop** from <https://desktop.github.com/>.
2. Open GitHub Desktop and sign in with your GitHub account.
3. Click **File → Add Local Repository**.
4. Choose this folder:
   `C:\Users\Rishabh Jadhav\Downloads\strawberry-music`
5. GitHub Desktop will say it is not a Git repository. Click **create a repository**.
6. Use these values:
   - **Name:** `strawberry-music`
   - **Description:** `Strawberry Music web player`
   - **Local path:** keep the current folder
   - **Initialize with a README:** leave unchecked (the project already has one)
   - **Git ignore:** None (the project already has `.gitignore`)
7. Click **Create Repository**.
8. In the left sidebar, type a summary such as `Initial commit`.
9. Click **Commit to main**.
10. Click **Publish repository**.
11. Choose **Private** (recommended), then click **Publish repository**.
12. Copy the GitHub repository URL. You will need it in Render.

> If GitHub Desktop asks you to install Git or configure your name/email, accept the defaults and continue.

---

## 4. Deploy on Render

### Option A — Blueprint (recommended, uses `render.yaml`)

1. Go to <https://render.com/> and sign up with GitHub.
2. In the Render dashboard, click **New + → Blueprint**.
3. Connect your GitHub account if asked.
4. Select the `strawberry-music` repository.
5. Render will detect the root-level `render.yaml` (the one that sets `rootDir: strawberry-music`). If Render asks for a Blueprint path, choose `render.yaml` at the repository root, not the copy inside `strawberry-music/`. Click **Apply** or **Create Resources**.
6. Wait for the deploy to finish. It can take a few minutes.
7. Open the URL Render gives you, for example:
   `https://strawberry-music.onrender.com`

> If a `strawberry-music` service already exists, do not create a second
> Blueprint with the same name. Either update the existing service's
> **Root Directory** to `strawberry-music` and use **Manual Deploy**, or
> change the existing Blueprint's path to the root-level `render.yaml` and
> sync it.

### Option B — Manual Web Service

Use this if Blueprint does not appear:

1. Click **New + → Web Service**.
2. Connect GitHub and select `strawberry-music`.
3. Fill in:
   - **Name:** `strawberry-music`
   - **Region:** choose the one closest to you
   - **Branch:** `main`
   - **Root Directory:** `strawberry-music`
   - **Runtime:** `Python 3`
   - **Build Command:** `pip install -r requirements.txt`
   - **Start Command:** `python -m server.main`
   - **Health Check Path:** `/api/health`
   - **Plan:** `Free`
4. Add an environment variable:
   - **Key:** `PYTHON_VERSION`
   - **Value:** `3.12.4`
5. Click **Create Web Service**.
6. Wait for the deploy to finish, then open the `onrender.com` URL.

### If the build fails or the site returns 503

- Check the Render **Logs** tab.
- If the build cannot find `requirements.txt`, or the site returns 503, open
  **Settings → Build & Deploy → Root Directory** and set it to
  `strawberry-music`, then redeploy. The app is not at the repository root.
  This is the most common cause when the service was created before the
  root-level `render.yaml` was added.
- If you cannot set a Root Directory, use these commands from the repository
  root instead:
  - **Build Command:** `pip install -r strawberry-music/requirements.txt`
  - **Start Command:** `cd strawberry-music && python -m server.main`
- If Render says Python 3.12.4 is unavailable, change `PYTHON_VERSION` to `3.11.9` or `3.13.4` and redeploy.
- If the service is slow on the first visit, that is normal on the free plan. Free services sleep after inactivity and take 30–60 seconds to wake up.
- If the service status is **Suspended**, open the Render dashboard's **Billing** or **Usage** page. Free services can be suspended when the monthly instance-hour limit is reached or a payment method is required.

---

## 5. Test the Render URL before adding your domain

Open these in your browser:

1. `https://YOUR-SERVICE.onrender.com/api/health`
   You should see JSON containing `"ok": true`.
2. `https://YOUR-SERVICE.onrender.com/`
   The Strawberry Music interface should load.
3. Use the search bar to find a song.
4. Play a song. Test pause, next, previous, volume, and the queue.

Playback does not require a YouTube Music account. The primary resolver is a
pre-bundled YouTube.js sidecar that runs next to the Python server. If Render's
Python runtime does not already have Node.js, the server downloads a pinned
official Node.js build (about 25 MB) into `.bin/` on first use and verifies it
by SHA-256. This happens in the background, so the site can load immediately.
The first playback may wait a few seconds while the resolver starts.

The sidecar tries the `VISIONOS`, `YTMUSIC`, `WEB` and `MWEB` clients in order,
preferring Opus and falling back to AAC. BotGuard PO tokens are generated with
`bgutils-js` only as a fallback for web clients. If the sidecar is unavailable,
the server falls back to the YouTube Music player endpoint with a local
JavaScript solver, then a public Invidious proxy, and finally `yt-dlp`.

If Render does not auto-deploy after a GitHub push, open the service in the
Render dashboard and use **Manual Deploy → Deploy latest commit**.

If search works but playback still fails, open the Render **Logs** tab. YouTube
sometimes blocks cloud servers. You can try adding this environment variable in
Render:

- **Key:** `OMNI_STREAM_CLIENTS`
- **Value:** `web,android`

Then redeploy and test again.

> `auth.json` is not saved permanently on Render's free plan. If you sign in to YouTube Music, the login may disappear after a redeploy or restart. For permanent login storage, you would need a paid Render Disk and the `OMNI_AUTH` environment variable. Do not commit `auth.json` to GitHub.

---

## 6. Add your `.dpdns.org` domain in Render

1. In Render, open your **strawberry-music** service.
2. Go to **Settings → Custom Domains**.
3. Click **Add Custom Domain**.
4. Enter the exact domain you want, for example:
   - `yourname.dpdns.org`, or
   - `music.yourname.dpdns.org`
5. Click **Add**.
6. Render will show one or more DNS records. **Do not guess these values.** Copy exactly what Render displays.
   - For a subdomain, Render usually shows a **CNAME** record with a target like `strawberry-music.onrender.com`.
   - For a root/apex domain, Render may show **A** and/or **AAAA** records, or an **ALIAS/ANAME** instruction.
7. Leave this Render page open. You will paste the values into DigitalPlat next.

---

## 7. Add the DNS records in DigitalPlat Domains

1. Log in to your DigitalPlat Domains account.
2. Open the domain you are using, for example `yourname.dpdns.org`.
3. Find **DNS Management**, **DNS Records**, or **Manage DNS**.
4. Add the record Render showed:
   - **Type:** exactly what Render says (usually `CNAME`; sometimes `A` or `AAAA`)
   - **Name / Host:** exactly what Render says (often `@`, blank, or the subdomain part)
   - **Value / Target:** exactly what Render says
   - **TTL:** Automatic or the default
5. Save the record.
6. If Render showed more than one record, add every one of them.
7. Return to Render and click **Verify** if the button is available.

### Important DNS notes

- Do **not** type `https://` in the DNS value.
- Do **not** add a trailing dot unless Render shows one.
- DNS changes can take a few minutes, but sometimes up to 48 hours.
- Render will automatically create the HTTPS certificate after the domain is verified. Wait for the status to become **Verified** and for the certificate to be issued.
- If DigitalPlat does not support `ALIAS`/`ANAME` for the root domain, use a `www` subdomain with a CNAME instead, and set up a redirect from the root to `www` in DigitalPlat if available.

---

## 8. Final checks

After Render says the domain is verified:

1. Open `https://yourname.dpdns.org`.
   - The browser should show a padlock (HTTPS).
2. Open `https://yourname.dpdns.org/api/health`.
   - You should see `"ok": true`.
3. Search for a song.
4. Play a song and test:
   - pause/play
   - next/previous
   - volume
   - queue
   - shuffle/repeat
   - lyrics if available
5. Open the site on a phone-sized window to check the responsive layout.
6. Check Render **Logs** if anything fails.

---

## Quick reference

| Setting | Value |
| --- | --- |
| Render service type | Web Service |
| Root directory | `strawberry-music` |
| Runtime | Python 3 |
| Build command | `pip install -r requirements.txt` |
| Start command | `python -m server.main` |
| Health check path | `/api/health` |
| Plan | Free |
| Python version | `3.12.4` (or `3.11.9` if unavailable) |
| Stream order | `OMNI_STREAM_ORDER=youtubei` |
| Node version | `OMNI_NODE_VERSION=22.11.0` |
| PO-token fallback | `OMNI_PO_TOKEN=1` |

---

## What not to upload

Never commit or share:

- `auth.json`
- `cookies.txt`
- `.env`
- private keys
- client secrets

The included `.gitignore` already blocks these files.
