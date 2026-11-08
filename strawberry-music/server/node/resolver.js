/**
 * Strawberry Music audio resolver sidecar.
 *
 * Runs next to the Python FastAPI server. It resolves an audio-only stream
 * through YouTube.js using this client order:
 *
 *   VISIONOS -> YTMUSIC -> WEB -> MWEB
 *
 * Only three clients are attempted per track. A client that refuses with a
 * bot/sign-in challenge is skipped for ten minutes. Itag 251 (Opus) is
 * preferred, with 140 (AAC) as the fallback. The resulting googlevideo URL is
 * handed back to Python, which proxies the bytes so the browser never sees or
 * follows a googlevideo redirect.
 */
import http from 'node:http';
import { Innertube, Platform } from 'youtubei.js';
import { getPoToken } from './po-token.js';

// YouTube's player script needs a real JavaScript evaluator. Node's Function
// constructor is sufficient here because the sidecar only runs trusted code
// fetched from YouTube's own player endpoint.
Platform.shim.eval = async (data) => new Function(data.output)();

const CLIENTS = (process.env.OMNI_YOUTUBEI_CLIENTS || 'VISIONOS,YTMUSIC,WEB,MWEB')
  .split(',')
  .map((client) => client.trim().toUpperCase())
  .filter(Boolean);
const ITAGS = [251, 140];
const MAX_CLIENT_ATTEMPTS = 3;
const CLIENT_COOLDOWN_MS = 10 * 60 * 1000;
const URL_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 30 * 60 * 1000;
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{6,20}$/;
const MAX_BODY_BYTES = 16 * 1024;

let session = null;
let sessionCreatedAt = 0;
let sessionPromise = null;

const cooldowns = new Map();
const cache = new Map();

function now() {
  return Date.now();
}

function setCooldown(client, reason) {
  cooldowns.set(client, { until: now() + CLIENT_COOLDOWN_MS, reason });
}

function coolingDown(client) {
  const entry = cooldowns.get(client);
  if (!entry) return false;
  if (entry.until <= now()) {
    cooldowns.delete(client);
    return false;
  }
  return true;
}

async function getSession() {
  if (session && now() - sessionCreatedAt < SESSION_TTL_MS) return session;
  if (sessionPromise) return sessionPromise;

  sessionPromise = (async () => {
    // Do not use generate_session_locally here. A visitor id obtained from
    // YouTube is what lets the VISIONOS client return playable streams.
    const yt = await Innertube.create({ retrieve_player: true });
    session = yt;
    sessionCreatedAt = now();
    return yt;
  })();

  try {
    return await sessionPromise;
  } finally {
    sessionPromise = null;
  }
}

function classifyPlayability(playability) {
  const status = String(playability?.status || 'ERROR');
  const reason = String(playability?.reason || '').toLowerCase();

  if (status === 'OK') return null;

  if (reason.includes('age') || reason.includes('confirm your age')) {
    return { reason: 'age-gate', unplayable: true, detail: 'This track is age-restricted.' };
  }
  if (reason.includes('private')) {
    return { reason: 'private', unplayable: true, detail: 'This track is private.' };
  }
  if (
    reason.includes('removed') ||
    reason.includes('no longer available') ||
    reason.includes('deleted') ||
    reason.includes('does not exist')
  ) {
    return { reason: 'removed', unplayable: true, detail: 'This track is no longer available.' };
  }
  if (
    reason.includes('country') ||
    reason.includes('region') ||
    reason.includes('not available in your') ||
    reason.includes('blocked it in your')
  ) {
    return { reason: 'region', unplayable: true, detail: 'This track is not available in this region.' };
  }
  if (status === 'LOGIN_REQUIRED' || reason.includes('bot') || reason.includes('sign in')) {
    return { reason: 'bot', unplayable: false, detail: 'YouTube asked this client to sign in.' };
  }
  return { reason: 'unavailable', unplayable: false, detail: playability?.reason || 'Playback is unavailable.' };
}

function chooseFormat(info, preferredItag, strictItag = false) {
  const formats = Array.isArray(info?.streaming_data?.adaptive_formats)
    ? info.streaming_data.adaptive_formats
    : [];

  // The spec requires audio-only, non-DRC formats.
  const candidates = formats.filter(
    (format) => format.has_audio && !format.has_video && !format.is_drc,
  );

  if (strictItag) {
    return candidates.find((format) => format.itag === preferredItag) || null;
  }

  const order = preferredItag === 140 ? [140, 251] : [251, 140];
  for (const itag of order) {
    const match = candidates.find((format) => format.itag === itag);
    if (match) return match;
  }

  // Some videos only expose another audio-only itag. Prefer Opus/WebM, then
  // any remaining audio-only format.
  return (
    candidates.find((format) => /webm|opus/i.test(String(format.mime_type || ''))) ||
    candidates[0] ||
    null
  );
}

function mimeOf(format) {
  return String(format?.mime_type || 'audio/webm').split(';')[0].trim();
}

async function resolve(videoId, preferredItag, strictItag = false) {
  const hit = cache.get(videoId);
  if (hit && hit.expiresAt > now()) {
    return { ok: true, ...hit.payload, cached: true };
  }

  const yt = await getSession();
  let attempts = 0;
  let last = null;
  let poToken;
  let poTokenTried = false;

  for (const client of CLIENTS) {
    if (attempts >= MAX_CLIENT_ATTEMPTS) break;
    if (coolingDown(client)) {
      last = { reason: 'cooldown', client, detail: 'This client is cooling down after a refusal.' };
      continue;
    }

    attempts += 1;
    const isWebClient = client !== 'VISIONOS';

    if (isWebClient && !poTokenTried && process.env.OMNI_PO_TOKEN !== '0') {
      poTokenTried = true;
      try {
        poToken = await getPoToken(yt, videoId);
      } catch {
        poToken = null;
      }
    }

    try {
      const options = { client };
      if (poToken) options.po_token = poToken;

      const info = await yt.getBasicInfo(videoId, options);
      const verdict = classifyPlayability(info?.playability_status);

      if (verdict) {
        last = { reason: verdict.reason, client, detail: verdict.detail };
        if (verdict.unplayable) {
          return {
            ok: false,
            reason: verdict.reason,
            client,
            retryable: false,
            detail: verdict.detail,
          };
        }
        // A bot/sign-in refusal is client-specific. Skip this client for a
        // while and let the next one try.
        setCooldown(client, verdict.reason);
        continue;
      }

      const format = chooseFormat(info, preferredItag, strictItag);
      if (!format) {
        last = { reason: 'no-format', client, detail: 'No audio-only format was returned.' };
        continue;
      }

      const url = await format.decipher(yt.session.player);
      if (!url) {
        last = { reason: 'no-url', client, detail: 'The audio URL could not be deciphered.' };
        continue;
      }

      const basic = info?.basic_info || {};
      const payload = {
        url,
        itag: format.itag,
        mime: mimeOf(format),
        contentLength: format.content_length ? Number(format.content_length) : null,
        client,
        title: basic.title || null,
        duration: basic.duration || null,
        source: 'youtubei',
      };

      cache.set(videoId, { expiresAt: now() + URL_TTL_MS, payload });
      return { ok: true, ...payload, cached: false };
    } catch (error) {
      const message = String(error?.message || error);
      if (/bot|sign in|login|not a bot/i.test(message)) {
        setCooldown(client, 'bot');
        last = { reason: 'bot', client, detail: message.slice(0, 240) };
      } else {
        last = { reason: 'error', client, detail: message.slice(0, 240) };
      }
    }
  }

  return {
    ok: false,
    reason: last?.reason || 'unavailable',
    client: last?.client || null,
    retryable: true,
    detail: last?.detail || 'No playable audio stream was returned.',
  };
}

function invalidate(videoId) {
  cache.delete(videoId);
}

function health() {
  return {
    ok: true,
    youtubei: true,
    session: Boolean(session),
    sessionAgeSeconds: session ? Math.floor((now() - sessionCreatedAt) / 1000) : null,
    cached: cache.size,
    cooldowns: Object.fromEntries(
      [...cooldowns.entries()].map(([client, entry]) => [
        client,
        { reason: entry.reason, secondsLeft: Math.max(0, Math.ceil((entry.until - now()) / 1000)) },
      ]),
    ),
    clients: CLIENTS,
    itags: ITAGS,
  };
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

function readBody(request) {
  return new Promise((resolveBody, rejectBody) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY_BYTES) {
        rejectBody(new Error('Request body too large'));
        request.destroy();
      }
    });
    request.on('end', () => resolveBody(body));
    request.on('error', rejectBody);
  });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || '/', 'http://127.0.0.1');

  if (request.method === 'GET' && url.pathname === '/health') {
    sendJson(response, 200, health());
    return;
  }

  if (request.method === 'POST' && url.pathname === '/resolve') {
    try {
      const body = await readBody(request);
      const payload = JSON.parse(body || '{}');
      const videoId = String(payload.videoId || '');
      if (!VIDEO_ID_RE.test(videoId)) {
        sendJson(response, 400, { ok: false, reason: 'invalid', detail: 'Invalid video id.' });
        return;
      }
      const preferredItag = Number(payload.itag) === 140 ? 140 : 251;
      const strictItag = Boolean(payload.strictItag);
      const result = await resolve(videoId, preferredItag, strictItag);
      sendJson(response, result.ok ? 200 : 502, result);
    } catch (error) {
      sendJson(response, 400, {
        ok: false,
        reason: 'invalid',
        detail: String(error?.message || error).slice(0, 240),
      });
    }
    return;
  }

  if (request.method === 'POST' && url.pathname === '/invalidate') {
    try {
      const body = await readBody(request);
      const payload = JSON.parse(body || '{}');
      const videoId = String(payload.videoId || '');
      if (VIDEO_ID_RE.test(videoId)) invalidate(videoId);
      sendJson(response, 200, { ok: true });
    } catch (error) {
      sendJson(response, 400, { ok: false, detail: String(error?.message || error).slice(0, 240) });
    }
    return;
  }

  sendJson(response, 404, { ok: false, reason: 'not-found' });
});

const port = Number(process.env.PORT) || 0;
server.listen(port, '127.0.0.1', () => {
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  // The Python supervisor reads this line to discover the ephemeral port.
  console.log(`SIDECAR_PORT=${actualPort}`);
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('uncaughtException', (error) => {
  console.error(`[resolver] uncaught: ${String(error?.stack || error).slice(0, 500)}`);
});
process.on('unhandledRejection', (error) => {
  console.error(`[resolver] unhandled: ${String(error?.stack || error).slice(0, 500)}`);
});
