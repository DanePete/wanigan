// Saving one `via: 'schema'` edit target through the site's helper (`POST /_wanigan/edit/<id>`, the contract in
// src/shared/live-trace.ts), as the user logged in in the live view. The window's live:editSave (live-inspect.ts,
// which finds the target in the trace the view holds) and the design layer's implement (live-layer.ts, through that
// same live:editSave path) both save through saveSchemaEdit(). It imports nothing of Electron: the request goes out
// through the post the caller passes (the view's session), so tests drive it with a stand-in site.
import { parseSaveAi } from '../shared/live-ai.ts';
import type { LiveEditSaved } from '../shared/live-lens.ts';
import { checkValue } from '../shared/live-schema.ts';
import type { EditTarget } from '../shared/live-trace.ts';

/** Past this, a helper's answer to a write is not read: it is a line. */
export const MAX_ANSWER_BYTES = 64 * 1024;
const MAX_VALUE_BYTES = 64 * 1024;

export class TooLarge extends Error {}

/** A response's body as text, refused past `max` bytes rather than read whole. */
export async function readBounded(res: Response, max: number): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > max) throw new TooLarge();
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel().catch(() => {}); throw new TooLarge(); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** One schema save: the target as the trace of the page shown offered it, and how to reach the site that rendered it. */
export interface SchemaSaveAt {
  /** The id of the trace the target is in: sent with the value, so the helper saves only what that render offered. */
  trace: string;
  target: EditTarget;
  /** POST a JSON body to a path of the helper on the page's own origin, as the view's user with the token. */
  post: (path: string, body: string) => Promise<Response>;
  /** The site saved it: the page is shown again with what the site now has. */
  reload: () => void;
}

/**
 * Save a value to a schema target: checked against the target's schema here first (the helper checks it again with
 * rest_validate_value_from_schema and is the authority), the request and its answer bounded, the page reloaded when
 * the site says it saved. `extra` is what else the body carries (the owner's noSiteAi choice, from the window).
 */
export async function saveSchemaEdit(at: SchemaSaveAt, rawValue: unknown, extra: Record<string, unknown> = {}): Promise<LiveEditSaved> {
  let body: string;
  try { body = JSON.stringify({ trace: at.trace, value: rawValue ?? null, ...extra }); } catch { return { ok: false, error: 'That value cannot be sent.', revision: null }; }
  if (body.length > MAX_VALUE_BYTES) return { ok: false, error: 'That value is too large to save here.', revision: null };
  const wrong = checkValue(at.target.schema, rawValue);
  if (wrong.length) return { ok: false, error: wrong.join(' '), revision: null };
  type Answer = { ok?: unknown; error?: unknown; revision?: unknown; ai?: unknown };
  let answer: Answer | null = null;
  let status = 0;
  try {
    const res = await at.post(`/_wanigan/edit/${encodeURIComponent(at.target.id)}`, body);
    status = res.status;
    answer = JSON.parse(await readBounded(res, MAX_ANSWER_BYTES)) as Answer | null;
  } catch (error) {
    if (!status) return { ok: false, error: `The site did not answer: ${(error as Error).message || 'no answer'}.`, revision: null };
  }
  const said: Answer | null = answer && typeof answer === 'object' ? answer : null;
  if (said?.ok === true) {
    at.reload();
    return { ok: true, error: null, revision: typeof said.revision === 'string' ? said.revision.slice(0, 100) : null, ai: parseSaveAi(said.ai) };
  }
  const why = typeof said?.error === 'string' ? said.error.slice(0, 500)
    : status === 403 ? 'The site refused: the user logged in in the live view may not edit this.'
      : status === 404 ? 'The site no longer offers this edit. Reload the page, then try again.'
        : `The site did not save it (it answered ${status}).`;
  return { ok: false, error: why, revision: null, ai: parseSaveAi(said?.ai) };
}
