// Stored words, the main process's side (the contract is src/shared/live-stored-words.ts): the site helper's
// POST /_wanigan/words and its undo, asked of the view's own site through the view's session (so as the user logged in
// there) with the helper's token, never following a redirect and reading a bounded answer, as every other helper call
// (live-inspect.ts). The design layer's implement() is what asks (live-layer.ts).
//
// It also reads, for a page builder's adapter in the WordPress helper, what the page says around the words: Elementor
// marks each document it renders with data-elementor-id and each element with data-id, which name the document and the
// element the words are in (a header template, a section of the page) better than any search can guess. Read in the
// page script's world, never written, and only passed on as hints the helper checks again.
import type { WebContents } from 'electron';
import { sameSite } from '../shared/live.ts';
import { undoToken } from '../shared/live-arrange.ts';
import { checkStoredAsk, parseStoredAnswer, parseStoredUndone, type StoredHint, type StoredUndone, type StoredWordsAnswer, type StoredWordsAsk } from '../shared/live-stored-words.ts';
import { MAX_ANSWER_BYTES, readBounded } from './live-edit-save.ts';
import type { LiveCurrent } from './live-view.ts';

/** A builder's save can take a while (it re-renders its own CSS); longer than the other helper calls. */
const STORED_MS = 45_000;
/** How long a reload may take before the words on it are read back. */
export const RELOAD_MS = 20_000;

/** Post JSON to the view's own site's helper and read its answer: [status, JSON or null], status 0 when nothing answered. */
async function post(cur: LiveCurrent | null, path: string, payload: unknown): Promise<[number, unknown, string | null]> {
  if (!cur || !cur.token || cur.env) return [0, null, 'The live view has no helper for this site.'];
  const page = cur.webContents.isDestroyed() ? '' : cur.webContents.getURL();
  const origin = (() => { try { return new URL(page && sameSite(cur.base, page) ? page : cur.base).origin; } catch { return null; } })();
  if (!origin || !sameSite(cur.base, origin)) return [0, null, 'The live view shows no page of this site.'];
  let status = 0;
  try {
    const res = await cur.webContents.session.fetch(`${origin}${path}`, {
      method: 'POST', credentials: 'include',
      // A helper never redirects these; following one could take the token somewhere else.
      redirect: 'error',
      signal: AbortSignal.timeout(STORED_MS),
      headers: { 'X-Wanigan-Live': cur.token, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    status = res.status;
    return [status, JSON.parse(await readBounded(res, MAX_ANSWER_BYTES)) as unknown, null];
  } catch (error) {
    return [status, null, (error as Error).message || 'no answer'];
  }
}

/** Ask the helper to find or save words where the content keeps them; the request is checked before it leaves. */
export async function askStoredWords(cur: LiveCurrent | null, raw: StoredWordsAsk): Promise<StoredWordsAnswer> {
  const ask = checkStoredAsk(raw);
  if (typeof ask === 'string') return { ok: false, error: ask, reason: 'refused', status: 0 };
  const [status, answer, error] = await post(cur, '/_wanigan/words', ask);
  if (answer === null && error) return { ok: false, error: status ? `The site did not answer in a way Wanigan reads (${status}).` : `The site did not answer: ${error}.`, reason: 'refused', status };
  return parseStoredAnswer(answer, status);
}

/** Put a stored-words save back, by the token the site gave for it. */
export async function undoStoredWords(cur: LiveCurrent | null, raw: string): Promise<StoredUndone> {
  const token = undoToken(raw);
  if (!token) return { ok: false, error: 'That can no longer be undone here.' };
  const [status, answer, error] = await post(cur, '/_wanigan/undo', { undo: token });
  if (answer === null && error) return { ok: false, error: status ? `The site did not answer in a way Wanigan reads (${status}).` : `The site did not answer: ${error}.` };
  return parseStoredUndone(answer, status);
}

/**
 * Elementor's marks around an edit's element, read in the page script's world: the documents it sits in (each
 * `data-elementor-id`, innermost first) and the element's own `data-id`. Code run in the page; the id is an edit's,
 * already checked.
 */
export const elementorHints = (edit: string): string => `(() => {
  const el = document.querySelector('[data-wl-edit~="${edit}"]');
  if (!el) return null;
  const documents = [];
  for (let n = el.closest('[data-elementor-id]'); n && documents.length < 8; n = n.parentElement && n.parentElement.closest('[data-elementor-id]')) documents.push(n.getAttribute('data-elementor-id'));
  const widget = el.closest('.elementor-element[data-id]');
  return { documents, element: widget ? widget.getAttribute('data-id') : null };
})()`;

/** What the page said around an edit's words, checked: by builder, its hint; undefined when it said nothing. */
export async function builderHints(run: <T>(code: string, fallback: T) => Promise<T>, edit: string): Promise<Record<string, StoredHint> | undefined> {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(edit)) return undefined;
  const raw = await run<unknown>(elementorHints(edit), null).catch(() => null);
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as { documents?: unknown; element?: unknown };
  const documents = Array.isArray(r.documents) ? r.documents.filter((d): d is string => typeof d === 'string' && /^\d{1,20}$/.test(d)).slice(0, 8) : [];
  const element = typeof r.element === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(r.element) ? r.element : null;
  return documents.length || element ? { elementor: { documents, element } } : undefined;
}

/** Reload the view's page past the cache and wait until it has loaded (true), failed or taken too long (false). */
export function reloadAndWait(wc: WebContents, ms = RELOAD_MS): Promise<boolean> {
  return new Promise((resolve) => {
    if (wc.isDestroyed()) { resolve(false); return; }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const done = (ok: boolean): void => {
      if (timer) clearTimeout(timer);
      timer = null;
      wc.removeListener('did-finish-load', loaded);
      wc.removeListener('did-fail-load', failed);
      resolve(ok);
    };
    const loaded = (): void => done(true);
    const failed = (_e: unknown, code: number, _d: string, _u: string, main: boolean): void => { if (main && code !== -3) done(false); };
    wc.on('did-finish-load', loaded);
    wc.on('did-fail-load', failed);
    timer = setTimeout(() => done(false), ms);
    wc.reloadIgnoringCache();
  });
}
