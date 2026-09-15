import { db } from './db';
import { VERSION_GATED_EVENTS } from './hooks';
import { providerById } from './providers';
import { sessionAnatomy, type AnatomyEvent, type SessionAnatomy } from '../shared/session-anatomy';

/**
 * A session's anatomy from what is already recorded: its hook events, its
 * requests' usage, and its launch row. Read-only and local.
 *
 * Whether the session's CLI was asked for subagent events cannot be read back
 * per session — the hook file is gone with the process — so the evidence used
 * is whether it recorded any version-gated event at all. A session that did
 * was launched with a version-aware hook file, so an absence of SubagentStart
 * there is a real zero; one that did not says "not recorded".
 */

const MAX_EVENTS = 20_000;
const GATED = new Set<string>(VERSION_GATED_EVENTS.map((e) => e.event));

export function anatomyFor(sessionId: string, now = Date.now()): SessionAnatomy & { harness: string | null } {
  const row = db().prepare('SELECT started_at, ended_at, conversation_id, harness_id, provider_id FROM session_log WHERE id = ?').get(sessionId) as
    { started_at: number; ended_at: number | null; conversation_id: string | null; harness_id: string | null; provider_id: string } | undefined;
  const events = (db().prepare(`SELECT at, event, tool_name, duration_ms FROM session_events WHERE session_id = ? ORDER BY at ASC, id ASC LIMIT ${MAX_EVENTS}`)
    .all(sessionId) as { at: number; event: string; tool_name: string | null; duration_ms: number | null }[])
    .map((e): AnatomyEvent => ({ at: e.at, event: e.event, tool: e.tool_name, durationMs: e.duration_ms }));
  const harness = row?.harness_id ?? (row ? providerById(row.provider_id)?.harness ?? null : null);

  let tokens = (db().prepare("SELECT in_tokens + cache_read + cache_write AS t FROM session_api_events WHERE session_id = ? AND kind = 'request'")
    .all(sessionId) as { t: number }[]).map((r) => r.t).filter((t) => t > 0);
  if (!tokens.length && row?.conversation_id) {
    tokens = (db().prepare('SELECT in_tokens + cache_read + cache_write_5m + cache_write_1h AS t FROM claude_usage_events WHERE session_id = ? AND sidechain = 0')
      .all(row.conversation_id) as { t: number }[]).map((r) => r.t).filter((t) => t > 0);
  }

  const claude = harness === 'claude-code';
  const anatomy = sessionAnatomy({
    startedAt: row?.started_at ?? events[0]?.at ?? now,
    endedAt: row?.ended_at ?? null,
    now,
    events,
    requestContextTokens: tokens,
    askedFor: { compaction: claude, subagents: claude && events.some((e) => GATED.has(e.event)) },
  });
  return { ...anatomy, harness };
}
