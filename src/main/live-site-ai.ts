// Asking a site's helper for the AI the site runs (GET /_wanigan/ai), for the
// live view's Inspector and for agents' live_site_ai. Asked on the site's own
// origin through a view session (so as the user logged in there, though the
// answer does not depend on it), with the helper's token, which goes nowhere
// else. Read bounded and checked by parseSiteAi: what a helper sends past the
// contract is dropped, never carried.
import { parseSiteAi, type LiveSiteAiAnswer } from '../shared/live-ai.ts';

/** An inventory of 500 abilities and a hundred connectors is well under this. */
const MAX_BYTES = 2 * 1024 * 1024;
const FETCH_MS = 15_000;

/** What can fetch on a view's session: Electron's session.fetch, or a stand-in in tests. */
export type SiteFetch = (url: string, init: RequestInit) => Promise<Response>;

export async function askSiteAi(fetch: SiteFetch, origin: string, token: string): Promise<LiveSiteAiAnswer> {
  let res: Response;
  try {
    res = await fetch(`${origin}/_wanigan/ai`, {
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
  const reader = res.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) { await reader.cancel().catch(() => {}); return { state: 'unreadable' }; }
      chunks.push(value);
    }
  }
  let raw: unknown;
  try { raw = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return { state: 'outdated' }; }
  const ai = parseSiteAi(raw);
  return ai ? { state: 'ok', ai } : { state: 'unreadable' };
}
