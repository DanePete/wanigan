// The component library, the main process's side: the site helper's list of
// what a site can place (GET /_wanigan/components; the contract is
// src/shared/live-library.ts), and a picture of each entry, rendered alone on
// the helper's piece route in a hidden window and kept in Wanigan's data
// folder by the library's hash. Design: docs/design/2026-10-09-design-layer.md.
//
// - The helper is asked on the site's own origin, through the project's view
//   session (so as the user logged in there), with the helper's token, which
//   goes nowhere else. Answers are read bounded and checked by parseLibrary.
//   The site's address and token come from the core (`live.site`), never from
//   the window.
// - A picture follows the design's rules for a render that can be compared:
//   the view's own session, never throttled (backgroundThrottling off), one
//   device pixel per CSS pixel, web fonts loaded, animations, transitions and
//   the caret switched off and reduced motion asked for, lazy images loaded
//   and decoded, the page settled; the whole piece captured through the
//   DevTools protocol (Page.captureScreenshot beyond the viewport), never
//   capturePage, which takes only the viewport. Only the site's own pages load.
// - Pictures are kept at <data>/live-library/<project>/<hash>/, one PNG for
//   each entry and width. A new hash means the definitions or their files
//   changed: the folders of older hashes are removed when the next picture is
//   kept.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IpcMain, IpcMainInvokeEvent, Session } from 'electron';
import { sameSite, type LiveSite } from '../shared/live.ts';
import {
  LIBRARY_HASH, parseLibrary, pictureRequest,
  type ComponentLibrary, type LibraryPicturesAnswer, type LibraryShot, type LiveLibraryAnswer,
} from '../shared/live-library.ts';
import type { Method } from '../shared/protocol.ts';

interface Client { callRaw(method: Method, params: unknown): Promise<unknown> }

/** A library of 2,000 entries with their schemas is well under this. */
const MAX_BYTES = 8 * 1024 * 1024;
const FETCH_MS = 20_000;
/** A library read this recently is the one used: pictures asked for one after another share it. */
const FRESH_MS = 60_000;
/** The first helper version with the library and its pieces. */
export const LIBRARY_HELPER = 4;

/** What can fetch on a view's session: Electron's session.fetch, or a stand-in in tests. */
export type SiteFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Ask a site's helper for its library: bounded, checked, and each way it can fail said. */
export async function askLibrary(fetch: SiteFetch, origin: string, token: string): Promise<LiveLibraryAnswer> {
  let res: Response;
  try {
    res = await fetch(`${origin}/_wanigan/components`, {
      method: 'GET',
      credentials: 'include',
      // A helper never redirects this; following one could take the token somewhere else.
      redirect: 'error',
      signal: AbortSignal.timeout(FETCH_MS),
      headers: { 'X-Wanigan-Live': token, Accept: 'application/json' },
    });
  } catch (error) {
    return { state: 'down', error: (error as Error).message || 'no answer' };
  }
  // An older helper has no such route: the site answers with its own 404 page.
  if (res.status === 404) return { state: 'outdated' };
  if (res.status === 401 || res.status === 403) return { state: 'refused', status: res.status };
  if (!res.ok) return { state: 'down', error: `it answered ${res.status}` };
  if (Number(res.headers.get('content-length') ?? 0) > MAX_BYTES) return { state: 'too-large' };
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body?.getReader();
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) { await reader.cancel().catch(() => {}); return { state: 'too-large' }; }
      chunks.push(value);
    }
  }
  let raw: unknown;
  try { raw = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return { state: 'outdated' }; }
  const library = parseLibrary(raw);
  return library ? { state: 'ok', library } : { state: 'unreadable' };
}

/** Why there is no library, in the owner's words. */
export function libraryWhy(answer: Exclude<LiveLibraryAnswer, { state: 'ok' }>): string {
  switch (answer.state) {
    case 'off': return 'The live view is off: switch it on in Settings › Live view.';
    case 'no-site': return 'This project has no local site set: choose it in the project’s Live tab.';
    case 'no-helper': return 'The site helper is not installed, and the library is read through it. Install it from the project’s Live tab.';
    case 'outdated': return 'The site helper is older than this Wanigan and has no component library. Update it from the project’s Live tab.';
    case 'refused': return `The site refused to list its components (it answered ${answer.status}).`;
    case 'down': return `The site did not answer: ${answer.error}.`;
    case 'too-large': return 'The site’s library is larger than Wanigan reads.';
    case 'unreadable': return 'The site helper’s library could not be read.';
  }
}

/* ── pictures ──────────────────────────────────────────────────────────── */

/** One rendered piece, as a PNG at one device pixel per CSS pixel. */
export interface PieceShot { png: Buffer; height: number; cut: boolean }
export type PieceCapture = (o: { partition: string; url: string; width: number; base: string }) => Promise<PieceShot | { error: string }>;

/** A picture keeps at most this many CSS pixels of a piece's height; below it is cut, and said. */
export const PICTURE_MAX_HEIGHT = 4_000;
const LOAD_MS = 30_000;
/** A piece says when it is drawn; a static WordPress block is serialized by its editor script and posted back first. */
const DRAWN_MS = 25_000;
/** The isolated world the capture reads the page from: the page's own scripts cannot reach it. */
const WORLD = 4243;
const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));
const originOf = (url: string): string => { try { return new URL(url).origin; } catch { return 'another address'; } };

/** Everything moving stopped, so a picture is the same each time it is taken. */
const STILL_CSS = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important}';

/** Read in the page once it is drawn: images loaded and decoded, fonts loaded, two frames, then what the piece shows. */
const SETTLE = `(async () => {
  const images = Array.from(document.images);
  for (const img of images) if (img.loading === 'lazy') img.loading = 'eager';
  const decode = (img) => (img.decode ? img.decode().catch(() => {}) : null);
  await Promise.race([
    Promise.all(images.map((img) => (img.complete ? decode(img) : new Promise((done) => {
      img.addEventListener('load', done, { once: true });
      img.addEventListener('error', done, { once: true });
    }).then(() => decode(img))))),
    new Promise((done) => setTimeout(done, 8000)),
  ]);
  if (document.fonts && document.fonts.ready) await Promise.race([document.fonts.ready, new Promise((done) => setTimeout(done, 5000))]);
  await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  const piece = document.querySelector('[data-wanigan-piece]');
  const doc = Math.ceil(Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0));
  if (!piece) return { doc, bottom: null, inner: 0, shows: false };
  const box = piece.getBoundingClientRect();
  const style = getComputedStyle(piece);
  const inner = box.height - parseFloat(style.paddingTop || '0') - parseFloat(style.paddingBottom || '0');
  const shows = piece.innerText.trim().length > 0 || piece.querySelector('img,svg,video,canvas,iframe,picture,input,button,select,textarea,hr') !== null;
  return { doc, bottom: Math.ceil(box.bottom + window.scrollY), inner, shows };
})()`;

/** The piece's state, as it says it: ready, failed (and why), still serializing, or no piece at all. */
const STATE = `(() => {
  const piece = document.querySelector('[data-wanigan-piece]');
  const why = document.querySelector('.wanigan-live-why');
  return { state: piece ? piece.getAttribute('data-wanigan-piece') : null, why: why ? why.textContent.trim().slice(0, 500) : '', complete: document.readyState === 'complete' };
})()`;

/**
 * Render one piece in a hidden window in the project's view session and take it whole, as the design's verification
 * takes a render: see the header of this file.
 */
export const captureInWindow: PieceCapture = async (o) => {
  // Loaded here, not at the top: the rest of this file runs, and is tested, without Electron's windows.
  const { BrowserWindow } = await import('electron');
  const screen = o.width < 600 ? 844 : 900;
  const w = new BrowserWindow({
    show: false, width: o.width, height: screen, useContentSize: true, enableLargerThanScreen: true, paintWhenInitiallyHidden: true,
    webPreferences: { partition: o.partition, sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false, backgroundThrottling: false },
  });
  const wc = w.webContents;
  let left: string | null = null;
  const stay = (event: { preventDefault(): void }, next: string): void => { if (!sameSite(o.base, next)) { event.preventDefault(); left ??= next; } };
  wc.on('will-navigate', stay);
  wc.on('will-redirect', stay);
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.setAudioMuted(true);
  wc.setBackgroundThrottling(false);
  const read = async <T>(code: string, fallback: T): Promise<T> => {
    try { return (await wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code }], true)) as T; } catch { return fallback; }
  };
  const cdp = wc.debugger;
  try {
    cdp.attach('1.3');
    await cdp.sendCommand('Emulation.setDeviceMetricsOverride', { width: o.width, height: screen, deviceScaleFactor: 1, mobile: o.width < 600 });
    await cdp.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await cdp.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    // Never the browser's cached copy: the piece is drawn as the site's files are now.
    const fresh = { extraHeaders: 'Cache-Control: no-cache\nPragma: no-cache\n' };
    const loaded = await Promise.race([wc.loadURL(o.url, fresh).then(() => true, () => false), pause(LOAD_MS).then(() => false)]);
    if (left) return { error: `The piece sent the browser off the site, to ${originOf(left)}; Wanigan does not follow it.` };
    if (!loaded) return { error: `The piece did not load within ${LOAD_MS / 1000} seconds.` };
    let said: { state: string | null; why: string; complete: boolean } = { state: null, why: '', complete: false };
    const until = Date.now() + DRAWN_MS;
    while (Date.now() < until) {
      said = await read(STATE, { state: null, why: '', complete: false });
      if (said.state === 'ready' || said.state === 'failed' || (said.state === null && said.complete && !wc.isLoading())) break;
      await pause(250);
    }
    if (left) return { error: `The piece sent the browser off the site, to ${originOf(left)}; Wanigan does not follow it.` };
    if (!sameSite(o.base, wc.getURL())) return { error: 'The piece left the site; Wanigan does not follow it.' };
    if (said.state === 'failed') return { error: said.why || 'The site could not render it alone.' };
    if (said.state !== 'ready') {
      return { error: said.state === null ? 'The site did not answer with a piece: its helper may be older than this Wanigan.' : 'The piece was not drawn within 25 seconds.' };
    }
    await wc.insertCSS(STILL_CSS);
    const measured = await read<{ doc: number; bottom: number | null; inner: number; shows: boolean } | null>(SETTLE, null);
    if (!measured) return { error: 'The piece could not be read.' };
    if (!measured.shows && measured.inner < 2) return { error: 'It rendered nothing on its own: it takes what it shows from the page it is placed on.' };
    await pause(300);
    const tall = Math.max(1, measured.bottom ?? measured.doc);
    const height = Math.min(PICTURE_MAX_HEIGHT, tall);
    const shot = await cdp.sendCommand('Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: true, fromSurface: true, clip: { x: 0, y: 0, width: o.width, height, scale: 1 },
    }) as { data?: string };
    if (!shot.data) return { error: 'The piece could not be pictured.' };
    return { png: Buffer.from(shot.data, 'base64'), height, cut: tall > height };
  } catch (error) {
    return { error: `The piece could not be pictured: ${(error as Error).message}` };
  } finally {
    try { if (cdp.isAttached()) cdp.detach(); } catch { /* the window is going anyway */ }
    w.destroy();
  }
};

/** A project id as a folder name: ids are opaque, so only safe characters are kept, and a hash keeps them apart. */
function folderOf(projectId: string): string {
  const safe = projectId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
  return `${safe}-${createHash('sha256').update(projectId).digest('hex').slice(0, 8)}`;
}

/** An entry's picture file at one width: entry ids hold ':' and '/', so the file is named by a hash of the id. */
export function pictureFile(entry: string, width: number): string {
  return `${createHash('sha256').update(entry).digest('hex').slice(0, 24)}-${width}.png`;
}

/** A session that can ask the site: Electron's, or a stand-in in tests. */
type Asker = Pick<Session, 'fetch'>;

export function wireLiveLibrary(options: {
  /** Electron's ipcMain (a stand-in in tests: everything here is reached through it). */
  ipc: Pick<IpcMain, 'handle'>;
  trusted: (event: IpcMainInvokeEvent) => boolean;
  /** Whether the owner has the live view switched on. */
  enabled: () => boolean;
  client: () => Promise<Client>;
  /** A project's view session, prepared (live-view.ts). */
  sessionFor: (projectId: string, url: string) => Asker | null;
  /** The partition a capture of a project's page runs in, prepared with its trust and the helper's token (live-view.ts). */
  partition: (projectId: string, url: string, token: string | null) => string;
  /** Wanigan's data folder: pictures go under live-library/ in it. */
  dataDir: string;
  /** Test seam: what renders and takes a piece. */
  capture?: PieceCapture;
  now?: () => number;
}): { library(projectId: string, refresh?: boolean): Promise<LiveLibraryAnswer> } {
  const { ipc } = options;
  const clock = options.now ?? Date.now;
  const capture = options.capture ?? captureInWindow;
  const held = new Map<string, { origin: string; library: ComponentLibrary; at: number }>();
  /** One render at a time: each loads a whole page in a hidden window. */
  let queue: Promise<unknown> = Promise.resolve();
  const root = join(options.dataDir, 'live-library');

  const ok = (event: IpcMainInvokeEvent): boolean => options.trusted(event) && options.enabled();
  const project = (raw: unknown): string | null => (typeof raw === 'string' && raw.length > 0 && raw.length <= 200 ? raw : null);
  const siteOf = async (projectId: string): Promise<LiveSite> => (await options.client()).callRaw('live.site', { projectId }) as Promise<LiveSite>;

  const library = async (projectId: string, refresh = false): Promise<LiveLibraryAnswer> => {
    if (!options.enabled()) return { state: 'off' };
    const site = await siteOf(projectId);
    if (!site.url) return { state: 'no-site' };
    if (!site.helper || !site.token) return { state: 'no-helper' };
    if (site.helper.version < LIBRARY_HELPER) return { state: 'outdated' };
    const origin = new URL(site.url).origin;
    const kept = held.get(projectId);
    if (!refresh && kept && kept.origin === origin && clock() - kept.at < FRESH_MS) return { state: 'ok', library: kept.library };
    const ses = options.sessionFor(projectId, site.url);
    if (!ses) return { state: 'no-helper' };
    const answer = await askLibrary((url, init) => ses.fetch(url, init), origin, site.token);
    if (answer.state === 'ok') held.set(projectId, { origin, library: answer.library, at: clock() });
    return answer;
  };

  const dirOf = (projectId: string, hash: string): string => join(root, folderOf(projectId), hash);

  /** A picture kept for this hash, with what was said of it when it was taken. */
  const keptShot = (dir: string, entry: string, width: number): LibraryShot | null => {
    const file = join(dir, pictureFile(entry, width));
    if (!existsSync(file)) return null;
    let meta: { height?: unknown; cut?: unknown } = {};
    try { meta = JSON.parse(readFileSync(`${file}.json`, 'utf8')) as typeof meta; } catch { /* the PNG is what counts */ }
    return { entry, width, path: file, height: typeof meta.height === 'number' ? meta.height : null, cached: true, cut: meta.cut === true, error: null };
  };

  /** Keep a picture (written whole, then renamed into place), and let go of older hashes' folders. */
  const keep = (projectId: string, hash: string, entry: string, width: number, shot: PieceShot): string => {
    const dir = dirOf(projectId, hash);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, pictureFile(entry, width));
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, shot.png, { mode: 0o600 });
    renameSync(tmp, file);
    writeFileSync(`${file}.json`, `${JSON.stringify({ entry, width, height: shot.height, cut: shot.cut, at: clock() })}\n`, { mode: 0o600 });
    const parent = join(root, folderOf(projectId));
    for (const name of readdirSync(parent)) {
      if (name !== hash && LIBRARY_HASH.test(name)) rmSync(join(parent, name), { recursive: true, force: true });
    }
    return file;
  };

  ipc.handle('live:library', async (event, rawProject: unknown, rawOptions: unknown): Promise<LiveLibraryAnswer> => {
    const projectId = project(rawProject);
    if (!options.trusted(event) || !projectId) return { state: 'off' };
    const refresh = !!rawOptions && typeof rawOptions === 'object' && (rawOptions as { refresh?: unknown }).refresh === true;
    return library(projectId, refresh);
  });

  ipc.handle('live:libraryPictures', async (event, rawProject: unknown, rawEntries: unknown, rawOptions: unknown): Promise<LibraryPicturesAnswer> => {
    const projectId = project(rawProject);
    if (!ok(event) || !projectId) return { ok: false, error: 'The live view is off.' };
    const opts = rawOptions && typeof rawOptions === 'object' ? rawOptions as { widths?: unknown; refresh?: unknown } : {};
    const asked = pictureRequest(rawEntries, opts.widths);
    if (typeof asked === 'string') return { ok: false, error: asked };
    const answer = await library(projectId);
    if (answer.state !== 'ok') return { ok: false, error: libraryWhy(answer) };
    const lib = answer.library;
    const site = await siteOf(projectId);
    if (!site.url || !site.token) return { ok: false, error: libraryWhy({ state: 'no-helper' }) };
    const base = site.url;
    const origin = new URL(base).origin;
    const dir = dirOf(projectId, lib.hash);
    const shots: LibraryShot[] = [];
    for (const id of asked.entries) {
      const entry = lib.entries.find((e) => e.id === id);
      for (const width of asked.widths) {
        const none = (error: string): LibraryShot => ({ entry: id, width, path: null, height: null, cached: false, cut: false, error });
        if (!entry) { shots.push(none('There is no such entry in the site’s library now.')); continue; }
        if (entry.picture.from === 'none') { shots.push(none(entry.picture.why)); continue; }
        const cached = opts.refresh === true ? null : keptShot(dir, id, width);
        if (cached) { shots.push(cached); continue; }
        const url = `${origin}${entry.picture.piece}`;
        // The helper named the route; it is checked again here, against the site, before anything loads it.
        if (!sameSite(base, url)) { shots.push(none('That piece is not on this site.')); continue; }
        const partition = options.partition(projectId, base, site.token);
        const run = queue.then(() => capture({ partition, url, width, base }));
        queue = run.catch(() => {});
        const shot = await run.catch((error: Error) => ({ error: error.message || 'The piece could not be pictured.' }));
        if ('error' in shot) { shots.push(none(shot.error)); continue; }
        shots.push({ entry: id, width, path: keep(projectId, lib.hash, id, width, shot), height: shot.height, cached: false, cut: shot.cut, error: null });
      }
    }
    return { ok: true, hash: lib.hash, shots };
  });

  // A kept picture as base64 PNG, for a window that cannot read the data folder itself.
  ipc.handle('live:libraryPicture', async (event, rawProject: unknown, rawEntry: unknown, rawWidth: unknown): Promise<string | null> => {
    const projectId = project(rawProject);
    if (!options.trusted(event) || !projectId || typeof rawEntry !== 'string' || typeof rawWidth !== 'number') return null;
    const kept = held.get(projectId);
    if (!kept) return null;
    const file = join(dirOf(projectId, kept.library.hash), pictureFile(rawEntry, rawWidth));
    try { return readFileSync(file).toString('base64'); } catch { return null; }
  });

  return { library };
}
