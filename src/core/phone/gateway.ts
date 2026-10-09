// The phone page and its API, on loopback only. Tailscale carries it to the
// owner's phone over their private network; nothing here listens on Wi-Fi.
//
//   GET  /                 the page (phone.html) and its files
//   POST /api/pair         a pairing code for a device token
//   POST /api/rpc          one core method, as the paired phone
//   GET  /api/events       the core's events, and the terminals it watches
//
// Every path may carry Tailscale's mount (/wanigan) or not. A request must name
// this Mac (loopback or its Tailscale name), and a POST must come from the page.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { PHONE_PATH, type PhoneDevice } from '../../shared/phone.ts';
import { CoreError } from '../../shared/protocol.ts';

/**
 * Events a phone never needs: terminal output arrives only for terminals it
 * watches, and the live view's edits and site settings (paths on this Mac,
 * many a second while an agent works) have nothing on the phone to follow them.
 */
const NOT_FOR_PHONES = new Set(['pty.data', 'live', 'liveSite', 'liveEdits', 'liveShots', 'liveRun']);

const MAX_RPC_BODY = 256 * 1024;
const MAX_PAIR_BODY = 4 * 1024;
const MAX_WATCHED = 4;
const MAX_DEVICE_STREAMS = 4;
const MAX_STREAMS = 32;
const MAX_STREAM_BYTES = 2 * 1024 * 1024;
const HEARTBEAT_MS = 25_000;
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
};
const SECURITY: Record<string, string> = {
  // The desktop page's policy, plus the manifest, and never framed.
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; manifest-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

export interface GatewayOptions {
  /** The built renderer folder holding phone.html, its assets, the manifest and the service worker; null where there is none. */
  rendererDir: string | null;
  /** The device a token belongs to, or null. */
  device: (token: string) => PhoneDevice | null;
  pair: (code: unknown, name: unknown) => { device: PhoneDevice; token: string };
  call: (device: PhoneDevice, method: string, params: unknown) => Promise<unknown>;
  /** Every core event; returns how to stop listening. */
  onEvent: (listener: (event: string, data: unknown) => void) => () => void;
  /** Terminal output; returns how to stop listening. */
  onData: (listener: (sessionId: string, seq: number, data: string) => void) => () => void;
  /** This Mac's Tailscale name, when known: a request may name it. */
  hostName: () => string | null;
}

export class Gateway {
  private server: Server | null = null;
  private readonly options: GatewayOptions;
  /** Open event streams, by the phone that opened them. */
  private readonly streams = new Map<ServerResponse, string>();

  constructor(options: GatewayOptions) {
    this.options = options;
  }

  get listening(): boolean {
    return !!this.server?.listening;
  }

  /** The port it listens on (a test asks for any free one). */
  get port(): number | null {
    const address = this.server?.address();
    return address && typeof address === 'object' ? address.port : null;
  }

  listen(port: number): Promise<void> {
    if (this.server) return Promise.resolve();
    const server = createServer((req, res) => { void this.handle(req, res); });
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once('error', (error) => { this.server = null; reject(error); });
      server.listen(port, '127.0.0.1', () => resolve());
    });
  }

  /** A forgotten phone hears nothing more: its open streams end now, not at its next reconnect. */
  drop(deviceId: string): void {
    for (const [res, id] of this.streams) if (id === deviceId) res.end();
  }

  /** Off means off: every phone's connection ends now, not when it next goes quiet. */
  async close(): Promise<void> {
    const streams = [...this.streams.keys()];
    const streamCloses = streams.map((res) => new Promise<void>((resolve) => res.once('close', () => resolve())));
    for (const res of streams) res.end();
    const server = this.server;
    this.server = null;
    if (!server) { await Promise.all(streamCloses); return; }
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    // Server close can precede a queued response's close callback. Keep its
    // slot charged, and wait for listener/timer cleanup before reporting Off.
    await Promise.all([closed, ...streamCloses]);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    for (const [k, v] of Object.entries(SECURITY)) res.setHeader(k, v);
    try {
      if (!this.allowedHost(req.headers.host)) throw new CoreError('forbidden', 'Not this Mac.');
      let url: URL;
      try { url = new URL(req.url ?? '/', 'http://phone'); }
      catch { throw new CoreError('invalid', 'Not a valid request address.'); }
      const path = url.pathname.startsWith(`${PHONE_PATH}/`) || url.pathname === PHONE_PATH ? url.pathname.slice(PHONE_PATH.length) || '/' : url.pathname;
      if (path.startsWith('/api/')) await this.api(req, res, path, url);
      else this.file(res, path);
    } catch (error) {
      const e = error instanceof CoreError ? error : new CoreError('internal', (error as Error)?.message ?? String(error));
      if (!res.headersSent) json(res, STATUS[e.code] ?? 500, { ok: false, error: { code: e.code, message: e.message } });
      else res.end();
    }
  }

  private async api(req: IncomingMessage, res: ServerResponse, path: string, url: URL): Promise<void> {
    if (req.method === 'POST') this.sameOrigin(req);
    if (path === '/api/pair' && req.method === 'POST') {
      const body = await readJson(req, MAX_PAIR_BODY);
      const { device, token } = this.options.pair(body.code, body.name);
      json(res, 200, { ok: true, result: { device, token } });
      return;
    }
    const token = bearer(req);
    const device = this.options.device(token);
    if (!device) throw new CoreError('unauthorized', 'This phone is not paired, or was forgotten. Scan the code in Settings › Phone on your Mac.');
    if (path === '/api/rpc' && req.method === 'POST') {
      const body = await readJson(req, MAX_RPC_BODY);
      const method = typeof body.method === 'string' ? body.method : '';
      // The body may arrive after the owner revoked control or forgot this
      // phone. Check current authority at dispatch, not just at admission.
      const current = this.options.device(token);
      if (!current) throw new CoreError('unauthorized', 'This phone is not paired, or was forgotten. Scan the code in Settings › Phone on your Mac.');
      json(res, 200, { ok: true, result: await this.options.call(current, method, body.params) });
      return;
    }
    if (path === '/api/events' && req.method === 'GET') {
      this.events(res, device.id, (url.searchParams.get('watch') ?? '').split(',').filter(Boolean).slice(0, MAX_WATCHED));
      return;
    }
    throw new CoreError('not_found', 'No such address.');
  }

  /** Server-sent events: everything the core says, and the output of the terminals asked for. */
  private events(res: ServerResponse, deviceId: string, watched: string[]): void {
    const deviceStreams = [...this.streams.values()].filter((id) => id === deviceId).length;
    if (this.streams.size >= MAX_STREAMS || deviceStreams >= MAX_DEVICE_STREAMS) {
      json(res, 429, { ok: false, error: { code: 'refused', message: 'Too many open phone streams. Close another view and reconnect.' } });
      return;
    }
    let stopped = false;
    let beat: NodeJS.Timeout | null = null;
    let offEvent = (): void => {};
    let offData = (): void => {};
    const cleanup = (): void => {
      if (stopped) return;
      stopped = true;
      if (beat) clearInterval(beat);
      offEvent(); offData();
    };
    const stop = (): void => { cleanup(); res.destroy(); };
    // Listeners stop immediately, but the admission slot remains charged until
    // the native response actually closes (including on a queue overflow).
    res.once('close', () => { cleanup(); this.streams.delete(res); });
    res.once('error', stop);
    this.streams.set(res, deviceId);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.flushHeaders(); // Include any queued ASCII headers in writableLength.
    const write = (frame: string): void => {
      if (stopped) return;
      if (res.destroyed || res.writableEnded) { cleanup(); return; }
      const bytes = Buffer.byteLength(frame);
      // HTTP/1 chunk framing is a hex length and two CRLFs. Reserving it is
      // conservative for a non-chunked response; all frames here are nonempty.
      const framing = bytes.toString(16).length + 4;
      const terminator = 5; // Reserve the final 0\r\n\r\n if drop/close ends it.
      if (res.writableLength + bytes + framing + terminator > MAX_STREAM_BYTES) { stop(); return; }
      // net.Socket counts queued strings in code units. Buffer writes keep
      // every event and heartbeat in bytes, including multibyte terminal text.
      res.write(Buffer.from(frame));
    };
    const send = (event: string, data: unknown): void => { write(`data: ${JSON.stringify({ event, data })}\n\n`); };
    write(': connected\n\n');
    if (stopped) return;
    offEvent = this.options.onEvent((event, data) => { if (!NOT_FOR_PHONES.has(event)) send(event, data); });
    if (stopped) { offEvent(); return; }
    const watching = new Set(watched);
    offData = this.options.onData((sessionId, seq, data) => { if (watching.has(sessionId)) send('pty.data', { sessionId, seq, data }); });
    if (stopped) { offData(); return; }
    beat = setInterval(() => write(': still here\n\n'), HEARTBEAT_MS);
  }

  private file(res: ServerResponse, path: string): void {
    const name = path === '/' || path === '/index.html' ? 'phone.html' : path.slice(1);
    const root = this.options.rendererDir;
    if (!root) throw new CoreError('not_found', 'This Wanigan was not built with its phone page.');
    const full = normalize(join(root, name));
    // Only the phone page's own files and the built assets; never the Mac window's page or anything beside it.
    if (!PAGE_FILE.test(name) || !full.startsWith(`${root}${sep}`) || !existsSync(full) || !statSync(full).isFile()) throw new CoreError('not_found', 'No such page.');
    const hashed = name.startsWith('assets/');
    // Read whole: small files, and inside the packaged app they live in its archive.
    const body = readFileSync(full);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(full)] ?? 'application/octet-stream',
      // The page and the worker are fetched fresh; built assets carry their hash in their names.
      'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    res.end(body);
  }

  /** Loopback, or this Mac's Tailscale name: never a name a page elsewhere could point here. */
  private allowedHost(host: string | undefined): boolean {
    const name = (host ?? '').replace(/:\d+$/, '').toLowerCase();
    return name === '127.0.0.1' || name === 'localhost' || (!!name && name === this.options.hostName()?.toLowerCase());
  }

  private sameOrigin(req: IncomingMessage): void {
    const origin = req.headers.origin;
    if (!origin) return;
    let from: string;
    try { from = new URL(origin).host; } catch { throw new CoreError('forbidden', 'Not from this page.'); }
    if (from !== req.headers.host) throw new CoreError('forbidden', 'Not from this page.');
  }
}

/** phone.html, phone-sw.js, phone.webmanifest, its icons, and hashed build output: no encoded or nested names. */
const PAGE_FILE = /^(phone[\w.-]*|assets\/[\w.-]+)$/;

const STATUS: Partial<Record<string, number>> = { unauthorized: 401, forbidden: 403, not_found: 404, invalid: 400, refused: 409, conflict: 409 };

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

function bearer(req: IncomingMessage): string {
  const header = req.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

function readJson(req: IncomingMessage, max: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) { reject(new CoreError('invalid', 'Too much sent at once.')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown;
        resolve(v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
      } catch {
        reject(new CoreError('invalid', 'Not JSON.'));
      }
    });
    req.on('error', reject);
  });
}
