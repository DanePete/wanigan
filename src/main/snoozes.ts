import { db } from './db';
import { snoozeUntil } from '../shared/session-triage';
import type { SnoozePreset } from '../shared/types';

/**
 * Sessions the operator said "not now" to.
 *
 * Read on every classification — every hook event and every two-second poll of
 * the queue — so the table is held in memory and written through, rather than
 * queried once per session per poll. The table is still the record: a snooze
 * set before a restart is loaded again after it.
 */

type Snooze = { untilAt: number; snoozedAt: number; preset: string };

let cache: Map<string, Snooze> | null = null;

function load(): Map<string, Snooze> {
  if (cache) return cache;
  const next = new Map<string, Snooze>();
  try {
    const rows = db().prepare('SELECT session_id, until_at, snoozed_at, preset FROM session_snoozes')
      .all() as { session_id: string; until_at: number; snoozed_at: number; preset: string }[];
    for (const r of rows) next.set(r.session_id, { untilAt: Number(r.until_at), snoozedAt: Number(r.snoozed_at), preset: r.preset });
  } catch {
    // A database closed during quit is a queue with no snoozes for one poll,
    // not a queue that stops ranking. Not cached, so the next read tries again.
    return next;
  }
  cache = next;
  return next;
}

/** The snooze standing on a session now, or null. An expired one is removed as it is found. */
export function activeSnooze(sessionId: string, now: number = Date.now()): Snooze | null {
  const s = load().get(sessionId);
  if (!s) return null;
  if (s.untilAt > now) return s;
  clearSnooze(sessionId);
  return null;
}

export function snooze(sessionId: string, preset: SnoozePreset, now: number = Date.now()): Snooze {
  const value: Snooze = { untilAt: snoozeUntil(preset, now), snoozedAt: now, preset };
  db().prepare(`INSERT INTO session_snoozes (session_id, until_at, snoozed_at, preset) VALUES (?,?,?,?)
    ON CONFLICT(session_id) DO UPDATE SET until_at=excluded.until_at, snoozed_at=excluded.snoozed_at, preset=excluded.preset`)
    .run(sessionId, value.untilAt, value.snoozedAt, preset);
  load().set(sessionId, value);
  return value;
}

export function clearSnooze(sessionId: string): void {
  load().delete(sessionId);
  try { db().prepare('DELETE FROM session_snoozes WHERE session_id = ?').run(sessionId); }
  catch { /* the in-memory answer already changed; a closed database is quit */ }
}
