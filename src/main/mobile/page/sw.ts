/**
 * The phone page's service worker, and the screen it shows when the network is
 * gone.
 *
 * It exists for one reason: a Home Screen app opened on a train with no signal
 * used to land on Safari's error page, which says nothing about Wanigan and
 * offers nothing but a reload. This worker replaces that with Wanigan's own
 * sentence — *this device has no network* — and, when the shell was cached
 * while online, with the real page, which then says the same thing in its own
 * connection line and heals itself the moment the radio comes back.
 *
 * Its only job is the shell. It must never cache an /api/ response, and the
 * guard below is deliberately doubled — an allow-list at the fetch handler and
 * a second check inside the one function that writes to the cache. A cached
 * fleet reading replayed tomorrow is exactly the lie the rest of this codebase
 * spends its assertions preventing: it would look like an answer, it would be
 * indistinguishable from a live one, and it would be about agents that stopped
 * hours ago. The offline screen therefore shows no reading at all rather than
 * yesterday's, and says so in as many words.
 *
 * Two conventions here are for the offline suite rather than for the browser.
 * Everything the worker touches is reached through `self` — self.fetch,
 * self.caches, self.clients, self.crypto — all of which are real properties of
 * a ServiceWorkerGlobalScope, so the shipped text runs unchanged in a stubbed
 * scope. That lets the suite drive a real fetch event at /api/status and prove
 * nothing was cached, instead of grepping for a guard and trusting it.
 */

/** The one cache this worker owns. Activation deletes every other. */
export const MOBILE_SHELL_CACHE = 'wanigan-shell';

/** Where dispatch serves the worker, and therefore the scope it controls. */
export const MOBILE_SERVICE_WORKER_PATH = '/sw.js';

/**
 * Every path, relative to the worker's scope, that may be stored. The shell,
 * its two static assets, and nothing else. An allow-list rather than an /api/
 * denylist because the dashboard may be proxied under a path prefix — a
 * denylist written against '/api/' would wave through '/wanigan/api/status'.
 */
const SHELL_FILES = ['', 'index.html', 'icon.svg', 'icon-180.png', 'manifest.webmanifest'];

/** The placeholder the worker replaces with a per-response CSP nonce. */
const NONCE_MARK = '%NONCE%';

const DARK_TOKENS = '--bg:#14100d; --glow:#312117; --panel:#1b1714; --panel-raised:#241e19; '
  + '--line:#382e28; --ink:#f0e8db; --dim:#b0a494; --faint:#82776a; --accent:#e3643b; '
  + '--accent-ink:#22110a; --critical:#f07068; --shadow:#160f0991;';

const LIGHT_TOKENS = '--bg:#f8f3ea; --glow:#f5dfc4; --panel:#fffdf9; --panel-raised:#f2ebe0; '
  + '--line:#d9cebf; --ink:#29221c; --dim:#655b50; --faint:#82766a; --accent:#b84620; '
  + '--accent-ink:#fffaf5; --critical:#b3261e; --shadow:#5a46301f;';

/**
 * The screen itself. It is deliberately a whole document with its own tokens
 * rather than a stripped-down apology: someone reading it is away from their
 * desk and needs to recognise it as Wanigan at a glance, and the two sentences
 * that matter — this is the phone's connection, and no reading is being shown
 * — have to be readable in sunlight without a stylesheet fetch that would
 * itself fail. There is no script in it, which is why the retry is a link: a
 * plain navigation back to the scope root, which this worker retries against
 * the network.
 */
function offlineDocument(appearance: string): string {
  // The caller passes the app's appearance setting; anything else lands on the
  // device's own preference rather than being written into an attribute
  // unchecked.
  const mode = appearance === 'light' || appearance === 'dark' ? appearance : 'system';
  return `<!doctype html>
<html lang="en" data-theme="${mode}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="apple-mobile-web-app-capable" content="yes">
<title>Wanigan — no network</title>
<style nonce="${NONCE_MARK}">
:root { color-scheme:dark; ${DARK_TOKENS} }
:root[data-theme="light"] { color-scheme:light; ${LIGHT_TOKENS} }
:root[data-theme="system"] { color-scheme:light dark; }
@media (prefers-color-scheme:light) { :root[data-theme="system"] { color-scheme:light; ${LIGHT_TOKENS} } }
* { box-sizing:border-box; }
html { background:var(--bg); }
body { margin:0; min-height:100vh; color:var(--ink); background:radial-gradient(circle at 80% -10%,var(--glow) 0,transparent 34rem),var(--bg); font:15px/1.45 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
main { width:min(560px,100%); margin:0 auto; padding:max(28px,env(safe-area-inset-top)) max(18px,env(safe-area-inset-right)) max(30px,env(safe-area-inset-bottom)) max(18px,env(safe-area-inset-left)); }
.eyebrow { color:var(--accent); font-size:11px; letter-spacing:.18em; text-transform:uppercase; font-weight:750; }
h1 { margin:6px 0 18px; font-size:clamp(24px,7vw,38px); letter-spacing:-.04em; font-weight:760; }
.state { display:grid; grid-template-columns:auto minmax(0,1fr); gap:10px; align-items:start; padding:16px; border:1px solid color-mix(in srgb,var(--critical) 50%,var(--line)); border-radius:13px; background:linear-gradient(145deg,var(--panel),var(--panel-raised)); box-shadow:0 12px 35px var(--shadow); color:var(--dim); }
.state-glyph { color:var(--critical); font-size:15px; line-height:1.4; }
.state strong { display:block; margin-bottom:5px; color:var(--ink); font-weight:720; }
.state p { margin:0; font-size:13px; }
.note { margin:15px 0 0; color:var(--faint); font-size:13px; }
.again { display:inline-flex; align-items:center; justify-content:center; min-height:48px; margin-top:20px; padding:8px 20px; border:1px solid var(--accent); border-radius:9px; background:var(--accent); color:var(--accent-ink); font-weight:760; text-decoration:none; touch-action:manipulation; }
.again:focus-visible { outline:3px solid var(--accent); outline-offset:2px; }
footer { margin-top:26px; color:var(--faint); font-size:11px; }
</style>
</head>
<body>
<main>
<div class="eyebrow">Wanigan</div>
<h1>This device has no network.</h1>
<div class="state"><span class="state-glyph" aria-hidden="true">&#10005;</span><div><strong>Nothing left this device to reach the Mac.</strong><p>This is the phone&rsquo;s own connection, not a reading about the Mac. From here Wanigan cannot tell you whether the Mac is awake, what your agents are doing, or whether one of them is waiting on you.</p></div></div>
<p class="note">No fleet reading is shown here, and none is kept on this device to show. A reading from earlier is not what your agents are doing now, so this screen offers none rather than one you might read as current.</p>
<a class="again" href="./">Try again</a>
<footer>Wanigan &middot; private phone monitor</footer>
</main>
</body>
</html>`;
}

/**
 * The worker's source, as served. Built as a string rather than a separate
 * bundled entry point for the same reason the page's script is: this app ships
 * one main-process bundle, and a second build target for eighty lines would be
 * a build system to keep in step for no gain.
 */
export function mobileServiceWorker(appearance: string): string {
  return `'use strict';
// Wanigan's phone shell, and nothing else. See src/main/mobile/page/sw.ts for
// why an /api/ response may never enter this cache.
const SHELL_CACHE = ${JSON.stringify(MOBILE_SHELL_CACHE)};
const SHELL_FILES = ${JSON.stringify(SHELL_FILES)};
const NONCE_MARK = ${JSON.stringify(NONCE_MARK)};
const OFFLINE_HTML = ${JSON.stringify(offlineDocument(appearance))};
// The scope root, which is also the cache key every navigation shares: '/' and
// '/index.html' are the same document, and storing them separately would leave
// one of the two stale after an update.
const SCOPE = new URL('./', self.location.href);

// A path relative to the scope, or null for anything this worker has no
// business touching. Relative because the dashboard can be proxied under a
// path prefix, and an absolute '/api/' test would wave through the same
// endpoint served at '/wanigan/api/'.
function scopePath(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch (ignored) { return null; }
  if (url.origin !== SCOPE.origin) return null;
  if (url.pathname.indexOf(SCOPE.pathname) !== 0) return null;
  return url.pathname.slice(SCOPE.pathname.length);
}

// Everything the page asks the Mac about. None of it is ever answered, cached
// or replayed from here: a fleet reading is only true at the second it was
// taken, and a worker that could serve one from storage would turn a dead
// battery into three agents that look like they are still running.
function isFleetRead(path) {
  return path === 'api' || path.indexOf('api/') === 0;
}

async function shellCache() {
  // Storage can be denied outright — private browsing, a device out of space.
  // The page still works without a cache; only the offline screen is lost.
  try { return await self.caches.open(SHELL_CACHE); } catch (ignored) { return null; }
}

async function remember(key, response) {
  // The second guard, deliberately redundant with the fetch handler's. This is
  // the only function in the worker that writes, so this is the one place a
  // future edit could turn the offline screen into a replayed fleet — and it
  // refuses anything that is not one of the four shell files by name.
  const path = scopePath(key);
  if (path === null || isFleetRead(path) || SHELL_FILES.indexOf(path) < 0) return;
  const cache = await shellCache();
  if (!cache) return;
  try { await cache.put(key, response); } catch (ignored) { /* quota, or an opaque response */ }
}

async function remembered(key) {
  const cache = await shellCache();
  if (!cache) return null;
  try { return (await cache.match(key)) || null; } catch (ignored) { return null; }
}

function offlineScreen() {
  // A nonce per response, so the document's own stylesheet is the only thing
  // its policy admits. A synthesised response carries no headers but the ones
  // written here, and a page served with no policy at all would be the one
  // document in this app that had none.
  const nonce = self.crypto && self.crypto.randomUUID ? self.crypto.randomUUID() : String(Date.now());
  // Deliberately 200 rather than 503. The status is not the message — the
  // document is — and a browser that decides to draw its own error page over a
  // 5xx body would take back the whole point of this worker.
  return new Response(OFFLINE_HTML.split(NONCE_MARK).join(nonce), {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; base-uri 'none'; form-action 'none'; "
        + "frame-ancestors 'none'; img-src 'none'; script-src 'none'; style-src 'nonce-" + nonce + "'",
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    },
  });
}

// Network first, always. The shell is small, it is served no-store, and it
// carries the nonce its own inline script is signed with — so a cached copy is
// a fallback for a dead radio, never a shortcut past a live one.
async function shellFirst(request, navigating) {
  const key = navigating ? SCOPE.href : request.url;
  try {
    const response = await self.fetch(request);
    if (response && response.ok) await remember(key, response.clone());
    return response;
  } catch (unreachable) {
    const cached = await remembered(key);
    if (cached) return cached;
    // Only a navigation gets Wanigan's screen. Returning an HTML apology in
    // place of an icon would be a stranger failure than the network error the
    // browser was going to report anyway.
    return navigating ? offlineScreen() : Response.error();
  }
}

self.addEventListener('install', (event) => {
  // The phone has one tab and closing it is the only way out of a waiting
  // worker, so a shell update takes effect now rather than at some later visit
  // the operator has no way to schedule.
  self.skipWaiting();
  event.waitUntil((async () => {
    try {
      const response = await self.fetch(SCOPE.href, { cache: 'reload' });
      if (response && response.ok) await remember(SCOPE.href, response);
    } catch (unreachable) { /* installed on a bad connection; the first good navigation caches it */ }
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      const names = await self.caches.keys();
      await Promise.all(names.map((name) => (name === SHELL_CACHE ? null : self.caches.delete(name))));
    } catch (ignored) { /* nothing to sweep */ }
    try { await self.clients.claim(); } catch (ignored) { /* no clients yet */ }
  })());
});

// ── notifications ──────────────────────────────────────────────────
// The only reason this worker runs when the app is closed. Everything above is
// about a page that is open; a push arrives at a worker with no page at all,
// which is exactly the case the whole alert path exists for.

self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let data = {};
    // The payload was encrypted by the Mac and decrypted by the browser, so it
    // is Wanigan's own bytes rather than a third party's — but a worker that
    // threw here would show nothing, and showing nothing is the one outcome
    // that gets this app's notification permission taken away. So every field
    // is read defensively and every branch still ends in showNotification.
    try { data = event.data ? event.data.json() : {}; } catch (unreadable) { data = {}; }
    const title = typeof data.title === 'string' && data.title ? data.title : 'Wanigan';
    const body = typeof data.body === 'string' && data.body
      ? data.body
      : 'A session needs you. Open Wanigan to see which.';
    const options = {
      body: body,
      // iOS draws the installed app's own icon and ignores these two; every
      // other browser uses them. Naming them costs nothing and is the
      // difference between a branded alert and a grey circle on Android.
      icon: SCOPE.href + 'icon-180.png',
      badge: SCOPE.href + 'icon-180.png',
      data: { view: typeof data.view === 'string' ? data.view : '' },
      // A permission wait is a question that stays unanswered until somebody
      // answers it, so it stays on screen. A finished turn is news and behaves
      // like news.
      requireInteraction: data.urgent === true,
    };
    // Tagging collapses repeats about one session into a single banner rather
    // than a column of them; renotify makes the replacement still buzz, which
    // is the point of sending it at all.
    if (typeof data.tag === 'string' && data.tag) {
      options.tag = data.tag;
      options.renotify = true;
    }
    await self.registration.showNotification(title, options);
  })());
});

// The browser rotated or revoked this device's subscription without being
// asked. Firefox fires this; Safari's support is unreliable and Chrome's has
// been incomplete for years, which is why the page also re-registers on every
// launch — belt and braces, because between the rotation and the next launch
// this device is subscribed to nothing and nobody is told.
//
// The worker cannot reach the pairing token: it lives in the page's
// localStorage, which a worker has no access to. So it re-subscribes and hands
// the result to whatever page is open; if none is, the next launch's own
// re-registration does the same job a moment later.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    try {
      const old = event.oldSubscription || (await self.registration.pushManager.getSubscription());
      const key = event.newSubscription
        ? null
        : (old && old.options && old.options.applicationServerKey) || null;
      const next = event.newSubscription
        || (key ? await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }) : null);
      if (!next) return;
      const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (let i = 0; i < open.length; i++) {
        try { open[i].postMessage({ wanigan: 'resubscribe' }); } catch (gone) { /* client died */ }
      }
    } catch (ignored) {
      // Nothing this worker can do about it alone. The page repairs it on its
      // next launch, which is the path that has the token.
    }
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const wanted = (event.notification.data && event.notification.data.view) || '';
  event.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (let i = 0; i < open.length; i++) {
      const client = open[i];
      if (client.url.indexOf(SCOPE.href) !== 0) continue;
      try { await client.focus(); } catch (denied) { /* the platform refused to raise it */ }
      // Asked for, not navigated to. Which screen the app is on lives in
      // localStorage and never in the URL (see nav.ts for why), so a worker
      // that tried to route by changing the address would be fighting the one
      // design decision that keeps a pairing token out of the address bar.
      try { client.postMessage({ wanigan: 'view', view: wanted }); } catch (gone) { /* client died mid-focus */ }
      return;
    }
    // Nothing open: a cold launch lands on the remembered screen, which is the
    // best available answer — the app has to boot before it can be told where
    // to go, and by then the operator is looking at it.
    try { await self.clients.openWindow(SCOPE.href); } catch (blocked) { /* nothing more this worker can do */ }
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (!request || request.method !== 'GET') return;
  const path = scopePath(request.url);
  // Returning without calling respondWith leaves the request exactly as it was:
  // straight to the network, unseen by this worker, uncacheable by it. Every
  // /api/ read the page makes takes that path, which is why a stale fleet
  // cannot be served from here even if the cache above were compromised.
  if (path === null || isFleetRead(path)) return;
  const navigating = request.mode === 'navigate';
  if (!navigating && SHELL_FILES.indexOf(path) < 0) return;
  event.respondWith(shellFirst(request, navigating));
});
`;
}
