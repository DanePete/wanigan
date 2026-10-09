// What needs the owner, across every project, most urgent first. Every entry is
// derived from recorded state; nothing here is a guess.
import { rankNeeds } from '../shared/attention.ts';
import { limitDetail } from '../shared/limits.ts';
import type { Need, Provider } from '../shared/model.ts';
import type { Ctx } from './context.ts';
import { LIVE_SQL, toAsks } from './records.ts';

/** Failed and interrupted sessions older than this stop asking for attention. */
const RECENT_MS = 3 * 24 * 60 * 60_000;
/** Edits to one file this close together, by different live sessions, are an overlap. */
const OVERLAP_WINDOW_MS = 60 * 60_000;
/** A working Claude session with no hook events this long has gone quiet. */
export const QUIET_MS = 20 * 60_000;
/** An agent that has not reported starting this long after launch is waiting on something in its terminal. */
export const STARTUP_MS = 10_000;

export function computeNeeds(ctx: Ctx): Need[] {
  const { db } = ctx;
  const since = ctx.now() - RECENT_MS;
  const needs: Need[] = [];

  const sessions = db.prepare(`
    SELECT s.id, s.project_id, s.card_id, s.provider, coalesce(c.title, s.title) AS title, s.state, s.activity, s.asking_since, s.asking, s.last_event_at,
           s.ended_at, s.seen_at, s.started_at, s.conversation_id, s.ephemeral, p.name AS project_name, p.key AS project_key, c.key AS card_key,
           s.account_id, s.limit_since, s.limit_resets_at, (SELECT label FROM accounts a WHERE a.id = s.account_id) AS account_label,
           (SELECT event FROM session_events e WHERE e.session_id = s.id ORDER BY e.id DESC LIMIT 1) AS last_event
    FROM sessions s
    JOIN projects p ON p.id = s.project_id AND p.archived_at IS NULL
    LEFT JOIN cards c ON c.id = s.card_id
    WHERE s.state IN ('starting', 'running', 'permission', 'waiting', 'failed', 'interrupted', 'working', 'limited')
  `).all() as {
    id: string; project_id: string; card_id: string | null; provider: Provider; title: string; state: string; activity: string | null;
    asking_since: number | null; asking: string | null; last_event_at: number | null; ended_at: number | null; seen_at: number | null;
    started_at: number; project_name: string; project_key: string; card_key: string | null; last_event: string | null;
    account_id: string | null; limit_since: number | null; limit_resets_at: number | null; account_label: string | null;
    conversation_id: string | null; ephemeral: number;
  }[];

  // A conversation carried on (resumed) in a later session: its earlier failure is dealt with.
  const carriedOn = db.prepare('SELECT 1 FROM sessions WHERE conversation_id = ? AND id != ? AND started_at >= ? LIMIT 1');

  for (const s of sessions) {
    const base ={ projectId: s.project_id, projectName: s.project_name, projectKey: s.project_key, cardId: s.card_id, cardKey: s.card_key, sessionId: s.id, provider: s.provider, title: s.title };
    const seen = s.seen_at ?? 0;
    if (s.state === 'permission') {
      const asks = toAsks(s.asking);
      needs.push({ ...base, kind: 'permission', detail: s.activity, since: s.asking_since ?? s.last_event_at ?? s.started_at, ...(asks.length ? { asks } : {}) });
    } else if ((s.state === 'starting' || s.state === 'running') && s.provider !== 'shell' && !s.ephemeral && s.last_event_at === null
      && ctx.now() - s.started_at > STARTUP_MS && seen < s.started_at + STARTUP_MS) {
      // An agent reports starting through its hooks. Until it reports anything, a
      // question in its terminal is invisible from here and the session hangs:
      // Claude Code and Codex ask whether to trust a new folder, and Claude's
      // answer defaults to No. Still true once "starting" has given way to "running".
      needs.push({ ...base, kind: 'starting', detail: 'Has not reported starting. It may be asking something in its terminal, such as whether to trust this folder.', since: s.started_at + STARTUP_MS });
    } else if (s.state === 'limited') {
      // Stands until the session moves on or the owner chooses to wait. The
      // reset coming and going is news again: limit_since moves.
      const at = s.limit_since ?? s.last_event_at ?? s.started_at;
      if (at > seen) needs.push({ ...base, kind: 'limit', detail: limitDetail(s.limit_resets_at, ctx.now(), s.account_label, s.provider), since: at, accountId: s.account_id });
    } else if (s.state === 'waiting' && s.last_event === 'Stop' && (s.last_event_at ?? 0) > seen) {
      // Only after a finished turn: an agent idle at a fresh prompt has not asked for anything.
      needs.push({ ...base, kind: 'waiting', detail: 'Finished its turn', since: s.last_event_at ?? s.started_at });
    } else if (s.state === 'working' && s.provider === 'claude' && s.last_event_at !== null && ctx.now() - s.last_event_at > QUIET_MS
      && seen < s.last_event_at + QUIET_MS) {
      // Claude reports every tool call, so silence while working is evidence. Codex
      // does not report while it works, so its silence is not, and is never raised.
      const minutes = Math.round((ctx.now() - s.last_event_at) / 60_000);
      needs.push({ ...base, kind: 'quiet', detail: `No activity for ${minutes} minutes while working. It may be on a long command, or stuck.`, since: s.last_event_at + QUIET_MS });
    } else if ((s.state === 'failed' || s.state === 'interrupted') && (s.ended_at ?? 0) > Math.max(seen, since)
      && !(s.conversation_id && carriedOn.get(s.conversation_id, s.id, s.ended_at ?? 0))) {
      // Resumable when Wanigan knows the agent's own conversation (Claude from launch, Codex from its hooks).
      const resumable = s.provider !== 'shell' && s.conversation_id !== null;
      needs.push({ ...base, kind: s.state, detail: s.activity, since: s.ended_at ?? s.started_at, ...(resumable ? { resumable } : {}) });
    }
  }

  // Two live sessions in one checkout edited the same file within the hour:
  // Claude's, Gemini's and Grok's edit tools, and every file a Codex patch names.
  const overlaps = db.prepare(`
    SELECT e.path, p.id AS project_id, p.name AS project_name, p.key AS project_key,
           group_concat(DISTINCT s.id) AS sessions, max(e.at) AS last_at
    FROM session_edits e
    JOIN sessions s ON s.id = e.session_id AND s.state IN (${LIVE_SQL})
    JOIN projects p ON p.id = s.project_id AND p.archived_at IS NULL
    WHERE e.at > ?
    GROUP BY e.path, coalesce(s.cwd, p.path), p.id
    HAVING count(DISTINCT s.id) > 1
  `).all(ctx.now() - OVERLAP_WINDOW_MS) as { path: string; project_id: string; project_name: string; project_key: string; sessions: string; last_at: number }[];
  for (const o of overlaps) {
    const ids = o.sessions.split(',');
    const who = ids.map((id) => db.prepare('SELECT title, provider, (SELECT key FROM cards c WHERE c.id = sessions.card_id) AS card_key FROM sessions WHERE id = ?')
      .get(id) as { title: string; provider: string; card_key: string | null });
    const names = who.map((s) => s.card_key ?? s.title);
    needs.push({
      kind: 'overlap', projectId: o.project_id, projectName: o.project_name, projectKey: o.project_key,
      cardId: null, cardKey: null, sessionId: ids[0] ?? null, provider: (who[0]?.provider ?? 'claude') as Need['provider'],
      title: o.path.split('/').slice(-2).join('/'), detail: `Edited by ${names.join(' and ')} in the same folder`, since: o.last_at,
    });
  }

  const reviews = db.prepare(`
    SELECT c.id, c.key, c.title, c.project_id, c.updated_at, p.name AS project_name, p.key AS project_key,
           (SELECT count(*) FROM evidence e WHERE e.card_id = c.id) AS evidence
    FROM cards c JOIN projects p ON p.id = c.project_id AND p.archived_at IS NULL
    WHERE c.status = 'review'
  `).all() as { id: string; key: string; title: string; project_id: string; updated_at: number; project_name: string; project_key: string; evidence: number }[];
  for (const c of reviews) {
    needs.push({
      kind: 'review', projectId: c.project_id, projectName: c.project_name, projectKey: c.project_key, cardId: c.id, cardKey: c.key, sessionId: null, provider: null,
      title: c.title, detail: `${c.evidence} evidence`, since: c.updated_at,
    });
  }

  const questions = db.prepare(`
    SELECT q.card_id, q.body, q.author, q.created_at, c.key, c.title, c.project_id, p.name AS project_name, p.key AS project_key
    FROM comments q JOIN cards c ON c.id = q.card_id JOIN projects p ON p.id = c.project_id AND p.archived_at IS NULL
    WHERE q.kind = 'question' AND q.resolved_at IS NULL AND c.status NOT IN ('done', 'archived')
  `).all() as { card_id: string; body: string; author: string; created_at: number; key: string; title: string; project_id: string; project_name: string; project_key: string }[];
  for (const q of questions) {
    needs.push({
      kind: 'question', projectId: q.project_id, projectName: q.project_name, projectKey: q.project_key, cardId: q.card_id, cardKey: q.key,
      sessionId: q.author.startsWith('session:') ? q.author.slice(8) : null, provider: null, title: q.title, detail: q.body, since: q.created_at,
    });
  }

  return rankNeeds(needs);
}

export function needsByProject(needs: Need[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const n of needs) counts.set(n.projectId, (counts.get(n.projectId) ?? 0) + 1);
  return counts;
}
