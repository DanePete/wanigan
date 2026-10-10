// The site's own colours for Try a style (LiveBridge.siteColours; the contract is src/shared/site-colours.ts): the
// platform's declared palette, asked of the site's helper, and the theme's tokens and the colours the page uses, read
// by the page script. Read-only and free: nothing is written to the site, nothing is prompted.
//
// - The palette is asked on the site's own origin through the view's session, with the helper's token, which goes
//   nowhere else (GET /_wanigan/palette, WordPress helper 5). Only a WordPress page is asked, by its trace: Drupal core
//   has no palette registry, and a page with no trace yet has not said which platform it is.
// - What the helper and the page say is checked (parseSitePalette, siteColoursOf) and bounded: past the contract it
//   is dropped, never carried.
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { sameSite } from '../shared/live.ts';
import type { LiveTraceAnswer } from '../shared/live-lens.ts';
import { parseSitePalette, siteColoursOf, type SiteColours, type SitePaletteAnswer } from '../shared/site-colours.ts';
import type { LiveCurrent } from './live-view.ts';

/** A palette of a hundred colours with names is a few kilobytes: past this, it is not read. */
const MAX_BYTES = 512 * 1024;
const FETCH_MS = 15_000;

export type SiteFetch = (url: string, init: RequestInit) => Promise<Response>;

/** GET /_wanigan/palette on the site's origin, as the view's user, with the helper's token. */
export async function askSitePalette(fetch: SiteFetch, origin: string, token: string): Promise<SitePaletteAnswer> {
  let res: Response;
  try {
    res = await fetch(`${origin}/_wanigan/palette`, {
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
  if (Number(res.headers.get('content-length') ?? 0) > MAX_BYTES) return { state: 'unreadable' };
  let text = '';
  const reader = res.body?.getReader();
  if (reader) {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) { await reader.cancel().catch(() => {}); return { state: 'unreadable' }; }
      chunks.push(value);
    }
    text = Buffer.concat(chunks).toString('utf8');
  }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { state: 'outdated' }; }
  return parseSitePalette(raw) ?? { state: 'unreadable' };
}

/** The page script's call, as live-view.ts runs it in the page's isolated world. */
const LAYER_COLORS = 'window.__wl && window.__wl.layerColors ? window.__wl.layerColors() : null';

export interface SiteColoursOptions {
  ipc: Pick<IpcMain, 'handle'>;
  trusted: (event: IpcMainInvokeEvent) => boolean;
  enabled: () => boolean;
  current: () => LiveCurrent | null;
  run: <T>(code: string, fallback: T) => Promise<T>;
  /** The shown page's trace (live-inspect.ts): it says the platform. */
  trace: () => Promise<LiveTraceAnswer>;
  /** How a view's session fetches (Electron's session.fetch); a test seam. */
  fetchFor?: (cur: LiveCurrent) => SiteFetch;
}

/** The site's colours for the page the view shows now. */
export async function siteColoursNow(options: Omit<SiteColoursOptions, 'ipc' | 'trusted' | 'enabled'>): Promise<SiteColours> {
  const cur = options.current();
  const none: SiteColours = { palette: { state: 'no-helper' }, tokens: [], used: [] };
  const url = cur?.webContents.getURL();
  if (!cur || !url || !sameSite(cur.base, url)) return none;
  const [page, palette] = await Promise.all([options.run<unknown>(LAYER_COLORS, null), paletteOf(cur, url, options)]);
  return siteColoursOf(page, palette);
}

async function paletteOf(cur: LiveCurrent, url: string, options: Pick<SiteColoursOptions, 'trace' | 'fetchFor'>): Promise<SitePaletteAnswer> {
  // A hosted environment is never asked with the helper's token.
  if (!cur.token || cur.env) return { state: 'no-helper' };
  const answer = await options.trace().catch(() => null);
  if (answer?.state !== 'ok') return answer?.state === 'no-helper' ? { state: 'no-helper' } : { state: 'no-trace' };
  if (answer.trace.platform === 'drupal') return { state: 'none', platform: 'drupal' };
  const fetch = options.fetchFor?.(cur) ?? ((u: string, init: RequestInit) => cur.webContents.session.fetch(u, init));
  return askSitePalette(fetch, new URL(url).origin, cur.token);
}

export function wireSiteColours(options: SiteColoursOptions): void {
  options.ipc.handle('live:siteColours', async (event: IpcMainInvokeEvent): Promise<SiteColours> => {
    if (!options.trusted(event) || !options.enabled()) return { palette: { state: 'no-helper' }, tokens: [], used: [] };
    return siteColoursNow(options);
  });
}
