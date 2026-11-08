/**
 * Optional BotGuard / WebPO token fallback.
 *
 * YouTube's web clients sometimes ask for a proof-of-origin token. VISIONOS
 * normally does not need one, so this module is only called after VISIONOS is
 * refused and a web client is about to be tried. Any failure is non-fatal:
 * the resolver continues with the normal client fallback order.
 */
import { BotGuardClient } from 'bgutils-js/botguard';
import { WebPoMinter } from 'bgutils-js/webpo';
import { buildURL, getHeaders, USER_AGENT } from 'bgutils-js/utils';

const REQUEST_KEY = 'O43z0dpjhgX20SCx4KAo';
const DEFAULT_TTL_MS = 30 * 60 * 1000;
const MAX_TTL_MS = 60 * 60 * 1000;

let globalsReady = false;
let cached = { token: null, videoId: null, expiresAt: 0, bound: false };
let inFlight = null;

function installBrowserGlobals() {
  if (globalsReady) return;
  globalsReady = true;

  const element = () => ({
    style: {},
    innerHTML: '',
    textContent: '',
    setAttribute() {},
    getAttribute() { return null; },
    appendChild() {},
    removeChild() {},
    addEventListener() {},
    removeEventListener() {},
    getContext() { return null; },
  });

  const location = {
    href: 'https://www.youtube.com/',
    origin: 'https://www.youtube.com',
    protocol: 'https:',
    host: 'www.youtube.com',
    hostname: 'www.youtube.com',
    pathname: '/',
    search: '',
    hash: '',
    toString() { return this.href; },
  };

  const document = {
    createElement: element,
    createElementNS: element,
    getElementById() { return null; },
    getElementsByTagName() { return []; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
    removeEventListener() {},
    cookie: '',
    referrer: 'https://www.youtube.com/',
    title: '',
    location,
    head: element(),
    body: element(),
    documentElement: element(),
  };

  const navigator = {
    userAgent: USER_AGENT,
    language: 'en-US',
    languages: ['en-US', 'en'],
    platform: 'MacIntel',
    webdriver: false,
    cookieEnabled: true,
    hardwareConcurrency: 8,
    deviceMemory: 8,
    maxTouchPoints: 0,
    onLine: true,
  };

  if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
  if (typeof globalThis.self === 'undefined') globalThis.self = globalThis;
  if (typeof globalThis.document === 'undefined') globalThis.document = document;
  if (typeof globalThis.location === 'undefined') globalThis.location = location;
  if (typeof globalThis.origin === 'undefined') globalThis.origin = 'https://www.youtube.com';

  try {
    Object.defineProperty(globalThis, 'navigator', {
      value: navigator,
      configurable: true,
      writable: true,
    });
  } catch {
    // Node may expose a read-only navigator. The resolver can still run.
  }
}

async function mint(yt, videoId) {
  installBrowserGlobals();

  const challenge = await yt.getAttestationChallenge('ENGAGEMENT_TYPE_UNBOUND');
  const bg = challenge?.bg_challenge;
  if (!bg?.program || !bg?.global_name) return null;

  const interpreterUrl = bg.interpreter_url?.private_do_not_access_or_else_trusted_resource_url_wrapped_value;
  if (!interpreterUrl) return null;

  const interpreterResponse = await fetch(`https:${interpreterUrl}`, {
    headers: { 'user-agent': USER_AGENT },
  });
  if (!interpreterResponse.ok) return null;
  const interpreterJavascript = await interpreterResponse.text();
  if (!interpreterJavascript) return null;
  new Function(interpreterJavascript)();

  const botGuard = await BotGuardClient.create({
    program: bg.program,
    globalName: bg.global_name,
    globalObject: globalThis,
  });

  const webPoSignalOutput = [];
  const botguardResponse = await botGuard.snapshot({ webPoSignalOutput });

  const integrityResponse = await fetch(buildURL('GenerateIT', true), {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify([REQUEST_KEY, botguardResponse]),
  });
  if (!integrityResponse.ok) return null;

  const data = await integrityResponse.json();
  const [integrityToken, estimatedTtlSecs, mintRefreshThreshold, websafeFallbackToken] = data;

  // A video-bound token is preferred. BotGuard can return only a fallback
  // token in some environments; that fallback is still useful for web clients.
  if (integrityToken && webPoSignalOutput[0]) {
    try {
      const minter = await WebPoMinter.create(
        { integrityToken, estimatedTtlSecs, mintRefreshThreshold, websafeFallbackToken },
        webPoSignalOutput,
      );
      const token = await minter.mintAsWebsafeString(videoId);
      if (token) {
        return {
          token,
          bound: true,
          ttlMs: Math.min(Math.max(Number(estimatedTtlSecs) || 3600, 60), 3600) * 1000,
        };
      }
    } catch {
      // Fall through to the websafe fallback token.
    }
  }

  if (websafeFallbackToken) {
    return { token: websafeFallbackToken, bound: false, ttlMs: DEFAULT_TTL_MS };
  }

  return null;
}

export async function getPoToken(yt, videoId) {
  const now = Date.now();
  if (cached.token && cached.expiresAt > now) {
    if (!cached.bound || cached.videoId === videoId) return cached.token;
  }
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const result = await mint(yt, videoId);
      if (!result) return null;
      cached = {
        token: result.token,
        videoId,
        expiresAt: Date.now() + Math.min(result.ttlMs, MAX_TTL_MS),
        bound: result.bound,
      };
      return result.token;
    } catch (error) {
      console.error(`[po-token] ${String(error?.message || error).slice(0, 200)}`);
      return null;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}
