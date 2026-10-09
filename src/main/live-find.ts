// The live view's "Go to" launcher, the main process's side: the site
// helper's index of destinations and its search (the contract is
// src/shared/live-find.ts), the pages the view knows without a helper, what the
// page shown is, Shift+Space from inside the page, and opening a path of the
// site in the default browser.
//
// - The helper is asked on the site's own origin, through the project's view
//   session (so as the user logged in there), with the helper's token, which
//   goes nowhere else. Answers are read bounded and checked by parseFind.
// - The index is kept per project and site, and asked for again when the
//   helper's change counter moves, when it is older than a few minutes, or on
//   the owner's Refresh.
// - The project's address, platform, helper and token are read from the core
//   (`live.site`), never taken from the window.
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent, Session } from 'electron';
import { FIND_LIMIT, parseFind, samePath, type FindResult } from '../shared/live-find.ts';
import { idsFromClasses, idsFromPath, type KnownPage, type LiveFindAnswer, type LiveHere } from '../shared/live-goto.ts';
import { sameSite, type LivePlatform, type LiveSite } from '../shared/live.ts';
import type { Method } from '../shared/protocol.ts';
import { liveFor, type AppSettings } from '../shared/settings.ts';
import type { LiveCurrent } from './live-view.ts';

interface Client { callRaw(method: Method, params: unknown): Promise<unknown> }

/** Past these, an answer is not read: an index of 5,000 destinations is well under the first. */
const MAX_INDEX_BYTES = 8 * 1024 * 1024;
const MAX_SEARCH_BYTES = 1024 * 1024;
const INDEX_MS = 10_000;
const SEARCH_MS = 6_000;
const CHANGED_MS = 3_000;
/** An index asked for again this soon is the one already held (opening twice in a row). */
const FRESH_MS = 2_000;
/** Configuration changes do not move the content counter: past this, the index is asked for again anyway. */
const STALE_MS = 3 * 60_000;
const MAX_KNOWN = 40;

/** The helper's index for one project's site, as last read. */
interface Held { origin: string; result: FindResult; changed: number | null; at: number }

/** A response's body as text, refused past `max` bytes rather than read whole. */
async function readBounded(res: Response, max: number): Promise<string | null> {
  if (Number(res.headers.get('content-length') ?? 0) > max) return null;
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** A site that is not there, in Chromium's words (Electron's fetch) or Node's. */
const DOWN = /ERR_(CONNECTION_REFUSED|NAME_NOT_RESOLVED|ADDRESS_UNREACHABLE|CONNECTION_FAILED|CONNECTION_RESET|CONNECTION_CLOSED|TIMED_OUT|CONNECTION_TIMED_OUT|INTERNET_DISCONNECTED|EMPTY_RESPONSE)|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ECONNRESET|TimeoutError|aborted/i;

const answer = (state: LiveFindAnswer['state'], over: Partial<LiveFindAnswer> = {}): LiveFindAnswer => ({
  state, result: null, known: [], origin: null, platform: null, message: null, ...over,
});

/** A same-site address (or path) as a path of the site, or null. */
function pathOf(base: string, raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw || raw.length > 2000) return null;
  if (raw.startsWith('/')) return samePath(raw);
  if (!/^https?:\/\//i.test(raw) || !sameSite(base, raw)) return null;
  try { const u = new URL(raw); return samePath(`${u.pathname}${u.search}`); } catch { return null; }
}

const clip = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** A session that can ask the site: Electron's, or a stand-in in tests. */
type Asker = Pick<Session, 'fetch'>;

export function wireLiveFind(options: {
  /** Electron's ipcMain (a stand-in in tests: everything here is reached through it). */
  ipc: Pick<IpcMain, 'handle'>;
  /** Electron's shell.openExternal. */
  openExternal: (url: string) => Promise<void>;
  window: () => BrowserWindow | null;
  trusted: (event: IpcMainInvokeEvent) => boolean;
  /** Whether the owner has the live view switched on. */
  enabled: () => boolean;
  settings: () => AppSettings | null;
  client: () => Promise<Client>;
  /** The live view as it is now (live-view.ts). */
  current: () => LiveCurrent | null;
  /** Run code in the page script's isolated world (live-view.ts). */
  run: <T>(code: string, fallback: T) => Promise<T>;
  /** A project's view session, prepared (live-view.ts). */
  sessionFor: (projectId: string, url: string) => Asker | null;
  now?: () => number;
}): void {
  const { ipc } = options;
  const clock = options.now ?? Date.now;
  const held = new Map<string, Held>();
  /** The renderer's wait for Shift+Space that a newer one replaces. */
  let supersede: (() => void) | null = null;

  const ok = (event: IpcMainInvokeEvent): boolean => options.trusted(event) && options.enabled();
  const project = (raw: unknown): string | null => (typeof raw === 'string' && raw.length > 0 && raw.length <= 200 ? raw : null);
  /** The view's page, when it shows this project. */
  const shown = (projectId: string): LiveCurrent | null => {
    const cur = options.current();
    return cur && cur.projectId === projectId && !cur.webContents.isDestroyed() ? cur : null;
  };

  const siteOf = async (projectId: string): Promise<LiveSite> => (await options.client()).callRaw('live.site', { projectId }) as Promise<LiveSite>;

  /** The pages the view has been to on this site, newest first; and, when asked, the links on the page it shows. */
  const knownPages = async (projectId: string, base: string, links: boolean): Promise<KnownPage[]> => {
    const cur = shown(projectId);
    if (!cur) return [];
    const out: KnownPage[] = [];
    const seen = new Set<string>();
    const add = (url: string | null, label: string, from: KnownPage['from']): void => {
      if (!url || seen.has(url) || url.startsWith('/_wanigan/') || out.length >= MAX_KNOWN * 2) return;
      seen.add(url);
      out.push({ url, label: clip(label, 200) || url, from });
    };
    try {
      const entries = cur.webContents.navigationHistory.getAllEntries();
      for (const e of [...entries].reverse().slice(0, MAX_KNOWN)) add(pathOf(base, e.url), e.title, 'history');
    } catch { /* no history to read */ }
    if (links) {
      const found = await options.run<unknown>('window.__wl && window.__wl.gotoLinks ? window.__wl.gotoLinks() : []', []);
      for (const l of Array.isArray(found) ? found.slice(0, 300) : []) {
        if (l && typeof l === 'object') add(pathOf(base, (l as { url?: unknown }).url), clip((l as { label?: unknown }).label, 120), 'link');
      }
    }
    return out;
  };

  /** Ask the helper; the status is 0 when nothing answered, with Chromium's reason. */
  const ask = async (ses: Asker, origin: string, path: string, token: string, max: number, ms: number): Promise<{ status: number; body: unknown; reason: string | null }> => {
    try {
      const res = await ses.fetch(`${origin}${path}`, {
        credentials: 'include',
        // A helper never redirects these; following one could take the token somewhere else.
        redirect: 'error',
        signal: AbortSignal.timeout(ms),
        headers: { 'X-Wanigan-Live': token, Accept: 'application/json' },
      });
      if (!res.ok) { await res.body?.cancel().catch(() => {}); return { status: res.status, body: null, reason: null }; }
      const text = await readBounded(res, max);
      if (text === null) return { status: res.status, body: null, reason: 'The answer was too large to read.' };
      try { return { status: res.status, body: JSON.parse(text) as unknown, reason: null }; } catch { return { status: res.status, body: null, reason: 'The answer was not JSON.' }; }
    } catch (error) {
      const e = error as Error & { cause?: { message?: string } };
      return { status: 0, body: null, reason: `${e.name}: ${e.message}${e.cause?.message ? ` (${e.cause.message})` : ''}` };
    }
  };

  /** Why the helper's answer is not one to use, as a state and the owner's words. */
  const trouble = (r: { status: number; reason: string | null }, host: string): Pick<LiveFindAnswer, 'state' | 'message'> => {
    if (r.status === 0 && r.reason && DOWN.test(r.reason)) return { state: 'down', message: `Nothing answered at ${host}.` };
    if (r.status === 0) return { state: 'failed', message: `The site did not answer the helper (${r.reason ?? 'no reason given'}).` };
    if (r.status === 404) return { state: 'outdated', message: 'The helper in this site is older than this Wanigan and cannot list its pages.' };
    if (r.status === 401 || r.status === 403) return { state: 'refused', message: 'The site refused the helper’s token: set the helper up again.' };
    if (r.status >= 200 && r.status < 300) return { state: 'failed', message: r.reason ?? 'The helper’s answer is not one Wanigan can read.' };
    return { state: 'failed', message: `The helper answered ${r.status}.` };
  };

  ipc.handle('live:find', async (event, rawProject: unknown, rawQuery: unknown, rawOptions: unknown): Promise<LiveFindAnswer> => {
    if (!options.trusted(event)) return answer('failed', { message: 'Untrusted sender.' });
    if (!options.enabled()) return answer('off', { message: 'The live view is off.' });
    const projectId = project(rawProject);
    if (!projectId) return answer('failed', { message: 'No project.' });
    const query = typeof rawQuery === 'string' ? rawQuery.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
    const refresh = !!rawOptions && typeof rawOptions === 'object' && (rawOptions as { refresh?: unknown }).refresh === true;
    let site: LiveSite;
    try { site = await siteOf(projectId); } catch (error) { return answer('failed', { message: (error as Error).message }); }
    if (!site.url) return answer('no-site', { message: 'This project has no site in the live view yet.' });
    const settings = options.settings();
    if (settings && !liveFor(settings, site.platform)) return answer('off', { message: 'The live view is off for this kind of site.' });
    const base = site.url;
    const origin = new URL(base).origin;
    const host = new URL(base).host;
    const platform: LivePlatform | null = site.platform;
    const without = async (state: LiveFindAnswer['state'], message: string): Promise<LiveFindAnswer> =>
      answer(state, { origin, platform, message, known: await knownPages(projectId, base, true) });
    if (!site.helper || !site.token || platform === 'site') {
      return without('no-helper', platform === 'site' ? 'Sites other than Drupal and WordPress have no helper to list their pages.' : 'Wanigan’s helper is not in this site.');
    }
    const ses = shown(projectId)?.webContents.session ?? options.sessionFor(projectId, base);
    if (!ses) return without('failed', 'That is not an address Wanigan can open.');
    const token = site.token;

    if (query) {
      const r = await ask(ses, origin, `/_wanigan/find?q=${encodeURIComponent(query)}&limit=${FIND_LIMIT}`, token, MAX_SEARCH_BYTES, SEARCH_MS);
      const result = r.status === 200 ? parseFind(r.body) : null;
      if (!result) { const t = trouble(r, host); return without(t.state, t.message ?? ''); }
      return answer('ready', { origin, platform, result, known: await knownPages(projectId, base, false) });
    }

    const changedNow = async (): Promise<number | null> => {
      const r = await ask(ses, origin, '/_wanigan/changed', token, 4096, CHANGED_MS);
      const n = r.body && typeof r.body === 'object' ? (r.body as { changed?: unknown }).changed : null;
      return typeof n === 'number' && Number.isFinite(n) ? n : null;
    };
    const kept = held.get(projectId);
    const now = clock();
    let changed: number | null = null;
    if (kept && kept.origin === origin && !refresh) {
      if (now - kept.at < FRESH_MS) return answer('ready', { origin, platform, result: kept.result, known: await knownPages(projectId, base, false) });
      changed = await changedNow();
      if (changed !== null && changed === kept.changed && now - kept.at < STALE_MS) {
        return answer('ready', { origin, platform, result: kept.result, known: await knownPages(projectId, base, false) });
      }
    } else {
      changed = await changedNow();
    }
    const r = await ask(ses, origin, '/_wanigan/find', token, MAX_INDEX_BYTES, INDEX_MS);
    const result = r.status === 200 ? parseFind(r.body) : null;
    if (!result) {
      held.delete(projectId);
      const t = trouble(r, host);
      return without(t.state, t.message ?? '');
    }
    held.set(projectId, { origin, result, changed, at: now });
    return answer('ready', { origin, platform, result, known: await knownPages(projectId, base, false) });
  });

  ipc.handle('live:findHere', async (event, rawProject: unknown): Promise<LiveHere | null> => {
    const projectId = project(rawProject);
    const cur = ok(event) && projectId ? shown(projectId) : null;
    if (!cur) return null;
    const raw = await options.run<unknown>('window.__wl && window.__wl.gotoHere ? window.__wl.gotoHere() : null', null);
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const path = pathOf(cur.base, r.url);
    if (!path) return null;
    const paths = [pathOf(cur.base, r.canonical), pathOf(cur.base, r.shortlink)].filter((p): p is string => !!p && p !== path);
    const classes = Array.isArray(r.classes) ? r.classes.filter((c): c is string => typeof c === 'string').slice(0, 4) : [];
    const ids = [...new Set([path, ...paths].flatMap(idsFromPath).concat(idsFromClasses(classes)))];
    return { path, title: clip(r.title, 300), heading: clip(r.heading, 200) || null, ids, paths: [...new Set(paths)] };
  });

  // Shift+Space in the page, the way a pick is answered: the window waits, the page script answers.
  ipc.handle('live:awaitGoto', async (event): Promise<'goto' | null> => {
    if (!ok(event)) return null;
    supersede?.();
    const replaced = new Promise<null>((resolve) => { supersede = () => resolve(null); });
    const got = await Promise.race([options.run<unknown>('window.__wl && window.__wl.awaitGoto ? window.__wl.awaitGoto() : null', null), replaced]);
    if (got !== 'goto') return null;
    // The launcher opens in the window: it takes the keyboard from the page.
    const w = options.window();
    if (w && !w.isDestroyed()) w.webContents.focus();
    return 'goto';
  });

  // The launcher takes the keyboard (from the page, when a menu chord opened it there) and gives it back.
  ipc.handle('live:gotoFocus', (event): boolean => {
    if (!options.trusted(event)) return false;
    const had = options.current()?.webContents.isFocused() ?? false;
    const w = options.window();
    if (w && !w.isDestroyed()) w.webContents.focus();
    return had;
  });
  ipc.handle('live:gotoReturn', (event): void => {
    const cur = options.trusted(event) ? options.current() : null;
    if (cur && !cur.webContents.isDestroyed()) cur.webContents.focus();
  });

  // A path of the project's site in the default browser: never the token, never another site.
  ipc.handle('live:openInBrowser', async (event, rawProject: unknown, rawPath: unknown): Promise<boolean> => {
    const projectId = project(rawProject);
    const path = samePath(rawPath);
    if (!ok(event) || !projectId || !path) return false;
    let site: LiveSite;
    try { site = await siteOf(projectId); } catch { return false; }
    if (!site.url) return false;
    const url = new URL(path, site.url);
    if (!sameSite(site.url, url.toString()) || !/^https?:$/.test(url.protocol)) return false;
    await options.openExternal(url.toString());
    return true;
  });
}
