import type http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { theme } from '../settings';
import { ensureMobileToken, pairingCodeValid } from './secrets';
import { dashboardHtml, dashboardIcon, dashboardManifest } from './page';

/**
 * The one gate every mobile API request passes through, and the only module
 * that writes an HTTP response.
 *
 * Routes are registered with a declared scope instead of being handed to the
 * HTTP server directly, so a new endpoint cannot be added that skips loopback,
 * bearer auth, the remote-control opt-in, or the write rate limit: there is no
 * way to reach a handler except through handle().
 */

export type MobileApiScope = 'monitor' | 'control';

export type MobileApiRoute = {
  path: string;
  method: 'GET' | 'POST';
  /** 'control' routes are refused unless the separate remote-control opt-in is on. */
  scope: MobileApiScope;
  /**
   * Only /api/pair: the endpoint that hands out the bearer token cannot itself
   * require one. Such a route is written against a separate, stricter window,
   * because a caller with no credential must not be able to spend the
   * operator's remote-action budget by guessing pairing codes.
   */
  unauthenticated?: boolean;
  handler: (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => Promise<void> | void;
};

const routes = new Map<string, Map<string, MobileApiRoute>>();

// Two sliding one-minute windows. Remote actions start real local processes,
// and a pairing attempt is a guess at a ten-character code; they are capped
// separately so eight guesses cannot eat the operator's twenty actions.
const actionTimes: number[] = [];
const pairingAttempts: number[] = [];

/** Add one route to the table. Registering the same path and verb twice is a bug. */
export function registerApiRoute(route: MobileApiRoute): void {
  const byMethod = routes.get(route.path) ?? new Map<string, MobileApiRoute>();
  if (byMethod.has(route.method)) {
    throw new Error(`The mobile API already answers ${route.method} ${route.path}.`);
  }
  byMethod.set(route.method, route);
  routes.set(route.path, byMethod);
}

// The gate is registered rather than imported so this module stays below every
// module that registers a route: importing ./control from here would make the
// route table and the thing it guards a cycle. An unregistered gate refuses
// every control-scope request, so a mis-wired build fails closed.
let controlGate: (() => boolean) | null = null;

/** Called once by the module that owns the remote-control bridge. */
export function registerControlGate(gate: () => boolean): void {
  controlGate = gate;
}

/** Whether control-scope routes and the console UI are available right now. */
export function controlScopeAllowed(): boolean {
  return controlGate ? controlGate() : false;
}

function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  const unwrapped = address.replace(/^::ffff:/, '');
  return unwrapped === '::1' || /^127\.\d+\.\d+\.\d+$/.test(unwrapped);
}

function authorized(req: http.IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!match) return false;

  let expected: string;
  try {
    expected = ensureMobileToken();
  } catch {
    return false;
  }
  const given = Buffer.from(match[1]);
  const wanted = Buffer.from(expected);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

export function securityHeaders(nonce?: string): Record<string, string> {
  const script = nonce ? `'nonce-${nonce}'` : "'none'";
  const style = nonce ? `'nonce-${nonce}'` : "'none'";
  return {
    'cache-control': 'no-store, max-age=0',
    pragma: 'no-cache',
    expires: '0',
    'content-security-policy':
      `default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; ` +
      `script-src ${script}; style-src ${style}; connect-src 'self'; img-src 'self' data:`,
    'x-frame-options': 'DENY',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'cross-origin-resource-policy': 'same-origin',
  };
}

export function send(
  res: http.ServerResponse,
  status: number,
  contentType: string,
  body: string,
  nonce?: string,
  extra: Record<string, string> = {},
): void {
  res.writeHead(status, {
    ...securityHeaders(nonce),
    'content-type': contentType,
    'content-length': String(Buffer.byteLength(body)),
    ...extra,
  });
  res.end(body);
}

export function json(res: http.ServerResponse, status: number, body: unknown, extra?: Record<string, string>): void {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(body), undefined, extra);
}

function windowAllows(times: number[], limit: number): boolean {
  const since = Date.now() - 60_000;
  while (times.length && times[0] < since) times.shift();
  if (times.length >= limit) return false;
  times.push(Date.now());
  return true;
}

export async function requestJson(req: http.IncomingMessage, limit = 16_384): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += piece.length;
    if (bytes > limit) throw new Error('Request is too large.');
    chunks.push(piece);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

async function servePair(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await requestJson(req, 1024);
  const code = typeof body?.code === 'string' ? body.code : '';
  if (!pairingCodeValid(code)) { json(res, 401, { error: 'That pairing code is invalid or expired.' }); return; }
  json(res, 200, { token: ensureMobileToken() });
}

registerApiRoute({
  path: '/api/pair',
  method: 'POST',
  scope: 'monitor',
  unauthenticated: true,
  handler: servePair,
});

async function dispatch(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (url.pathname === '/' || url.pathname === '/index.html') {
    if (req.method !== 'GET') { json(res, 405, { error: 'Method not allowed.' }, { allow: 'GET' }); return; }
    // The shell carries no fleet data and cannot authenticate a top-level
    // navigation: URL fragments are deliberately never sent over HTTP. The
    // bearer-protected API below is the authenticated dashboard boundary.
    const nonce = randomBytes(18).toString('base64');
    send(res, 200, 'text/html; charset=utf-8', dashboardHtml(nonce, theme(), controlScopeAllowed()), nonce);
    return;
  }

  if (url.pathname === '/manifest.webmanifest') {
    if (req.method !== 'GET') { json(res, 405, { error: 'Method not allowed.' }, { allow: 'GET' }); return; }
    send(res, 200, 'application/manifest+json; charset=utf-8', dashboardManifest(theme()));
    return;
  }
  if (url.pathname === '/icon.svg') {
    if (req.method !== 'GET') { json(res, 405, { error: 'Method not allowed.' }, { allow: 'GET' }); return; }
    send(res, 200, 'image/svg+xml; charset=utf-8', dashboardIcon());
    return;
  }

  const byMethod = routes.get(url.pathname);
  if (!byMethod) { json(res, 404, { error: 'Not found.' }); return; }
  const route = byMethod.get(req.method ?? '');
  if (!route) {
    json(res, 405, { error: 'Method not allowed.' }, { allow: [...byMethod.keys()].join(', ') });
    return;
  }

  if (!route.unauthenticated && !authorized(req)) {
    json(res, 401, { error: 'Missing or invalid mobile monitor token.' }, {
      'www-authenticate': 'Bearer realm="wanigan-mobile"',
    });
    return;
  }

  // The page tests this message with /disabled/ to tell a switched-off console
  // apart from a broken one, so the wording is part of the contract.
  if (route.scope === 'control' && !controlScopeAllowed()) {
    json(res, 403, { error: 'Remote control is disabled in Wanigan Settings.' });
    return;
  }

  // Deliberately POST-only. /api/terminal is polled every 1.5 seconds and
  // /api/control on every render, so charging reads to the write budget would
  // 429 a console that is working correctly within seconds.
  if (req.method === 'POST') {
    const credentialled = !route.unauthenticated;
    const allowed = credentialled
      ? windowAllows(actionTimes, 20)
      : windowAllows(pairingAttempts, 8);
    if (!allowed) {
      json(res, 429, {
        error: credentialled
          ? 'Too many remote actions. Wait a minute and try again.'
          : 'Too many pairing attempts. Wait a minute and try again.',
      });
      return;
    }
  }

  await route.handler(req, res, url);
}

export async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!isLoopback(req.socket.remoteAddress)) {
    req.socket.destroy();
    return;
  }
  try {
    await dispatch(req, res);
  } catch {
    // A handler failure can carry local paths or database details. The phone
    // needs to know the request failed, not which local byte made it fail.
    try { json(res, 500, { error: 'Wanigan could not answer the mobile monitor request.' }); }
    catch { /* socket already gone */ }
  }
}
