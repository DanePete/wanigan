// Search what agents said: each session's title and the newest part of its
// recorded terminal output, most recent sessions first, inside fixed bounds on
// bytes, sessions, matches and time. Reads only; every bound that cut the
// results is reported.
import { open } from 'node:fs/promises';
import { LIVE_STATES, type Provider, type SessionState } from '../shared/model.ts';
import { CoreError } from '../shared/protocol.ts';
import {
  SAID_CAPS, SAID_MAX_QUERY, SAID_MIN_QUERY, findSaid, plainText, saidPattern, snippetAt,
  type SaidCaps, type SaidCut, type SaidHit, type SaidSearch,
} from '../shared/said.ts';
import type { Ctx } from './context.ts';

export const SAID_LIMIT = 20;
const SAID_LIMIT_MAX = 50;

interface Row {
  id: string; project_id: string; title: string; provider: string; state: string;
  started_at: number; ended_at: number | null; key: string; name: string;
}

/** A query the core will search for, or a refusal that says why not. */
export function saidQuery(v: unknown): string {
  const q = typeof v === 'string' ? v.trim() : '';
  if (q.length < SAID_MIN_QUERY) throw new CoreError('invalid', `Search for at least ${SAID_MIN_QUERY} characters.`);
  if (q.length > SAID_MAX_QUERY) throw new CoreError('invalid', `Search for at most ${SAID_MAX_QUERY} characters.`);
  return q;
}

export const saidLimit = (v: unknown): number =>
  (typeof v === 'number' && Number.isFinite(v) ? Math.min(SAID_LIMIT_MAX, Math.max(1, Math.round(v))) : SAID_LIMIT);

export async function searchSaid(
  ctx: Ctx,
  params: { query: string; projectId?: string | null; limit?: number },
  /** Where a session's recorded output is, or null when it must not be read. */
  outputFile: (sessionId: string) => string | null,
  caps: SaidCaps = SAID_CAPS,
  clock: () => number = () => performance.now(),
): Promise<SaidSearch> {
  const pattern = saidPattern(params.query);
  if (!pattern) throw new CoreError('invalid', 'Search for something.');
  const limit = params.limit ?? SAID_LIMIT;
  const began = clock();
  const cut = new Set<SaidCut>();

  // Live sessions first, then the most recently ended; closed projects are left out.
  const rows = ctx.db.prepare(`
    SELECT s.id, s.project_id, s.title, s.provider, s.state, s.started_at, s.ended_at, p.key, p.name
    FROM sessions s JOIN projects p ON p.id = s.project_id
    WHERE p.archived_at IS NULL ${params.projectId ? 'AND s.project_id = ?' : ''}
    ORDER BY s.ended_at IS NULL DESC, COALESCE(s.ended_at, s.started_at) DESC
    LIMIT ?`).all(...(params.projectId ? [params.projectId] : []), caps.sessions + 1) as Row[];
  if (rows.length > caps.sessions) { cut.add('sessions'); rows.length = caps.sessions; }

  const hits: SaidHit[] = [];
  let bytesLeft = caps.totalBytes;
  let searched = 0;
  for (const row of rows) {
    if (hits.length > limit) break;
    if (clock() - began > caps.timeMs) { cut.add('time'); break; }
    searched++;
    const base = {
      sessionId: row.id, sessionTitle: row.title, provider: row.provider as Provider,
      state: row.state as SessionState, projectId: row.project_id, projectKey: row.key, projectName: row.name,
      startedAt: row.started_at, endedAt: LIVE_STATES.has(row.state as SessionState) ? null : row.ended_at,
    };
    pattern.lastIndex = 0;
    const title = pattern.exec(row.title);
    const file = outputFile(row.id);
    const output = file && bytesLeft > 0 ? await readTail(file, Math.min(caps.bytesPerFile, bytesLeft)) : null;
    if (file && bytesLeft <= 0) cut.add('bytes');
    if (output) {
      bytesLeft -= output.read;
      if (output.truncated) cut.add('bytes');
    }
    const lastOutputAt = output?.modifiedAt ?? null;
    if (title) hits.push({ ...base, in: 'title', snippet: snippetAt(row.title, title.index, title.index + title[0].length), lastOutputAt });
    for (const snippet of output ? findSaid(output.text, pattern, caps.perSession) : []) {
      hits.push({ ...base, in: 'output', snippet, lastOutputAt });
    }
  }
  if (hits.length > limit) { cut.add('results'); hits.length = limit; }
  return { hits, searched, cut: [...cut] };
}

/** The newest `limit` bytes of a file as plain text, starting on a whole line when it was cut. */
async function readTail(file: string, limit: number): Promise<{ text: string; read: number; truncated: boolean; modifiedAt: number } | null> {
  let handle;
  try {
    handle = await open(file, 'r');
  } catch {
    return null; // nothing recorded, or removed since
  }
  try {
    const { size, mtimeMs } = await handle.stat();
    const length = Math.min(size, limit);
    const buffer = Buffer.alloc(length);
    if (length) await handle.read(buffer, 0, length, size - length);
    let text = buffer.toString('utf8');
    const truncated = length < size;
    // A tail starts mid-line, maybe mid-sequence: begin at the first whole line.
    if (truncated) text = text.slice(text.indexOf('\n') + 1);
    return { text: plainText(text), read: length, truncated, modifiedAt: Math.round(mtimeMs) };
  } finally {
    await handle.close();
  }
}
