import { db } from './db';
import { getSetting } from './settings';
import { FATIGUE_DEFAULTS, hourlyCounts, inferDecisions, sessionCounts, type FatigueEvent } from '../shared/fatigue';
import type { FatigueReport, SessionEvent } from '../shared/types';

/**
 * Approval-fatigue evidence: observed counts, and a `fatigue` policy signal when
 * several approvals in a row are answered faster than the threshold.
 *
 * The signal is a data row, not a notification. The attention queue is the
 * surface that decides what interrupts an operator; this records the fact it
 * would decide on, with the inferred times that make it up, and nothing else.
 * Nothing here suggests auto-approving anything.
 */

type Live = { open: Map<string, number>; streak: number[]; streakFrom: number | null };
const live = new Map<string, Live>();
const MAX_LIVE = 300;

function thresholds(): { fastMs: number; run: number } {
  const n = (key: string, fallback: number, min: number, max: number) => {
    const v = Number(getSetting(key, String(fallback)));
    return Number.isFinite(v) && v >= min && v <= max ? Math.trunc(v) : fallback;
  };
  try {
    return { fastMs: n('policy_fatigue_fast_ms', FATIGUE_DEFAULTS.fastMs, 200, 60_000), run: n('policy_fatigue_run', FATIGUE_DEFAULTS.run, 2, 50) };
  } catch {
    return { fastMs: FATIGUE_DEFAULTS.fastMs, run: FATIGUE_DEFAULTS.run };
  }
}

function stateFor(sessionId: string): Live {
  let s = live.get(sessionId);
  if (!s) {
    if (live.size >= MAX_LIVE) {
      const oldest = live.keys().next();
      if (!oldest.done) live.delete(oldest.value);
    }
    s = { open: new Map(), streak: [], streakFrom: null };
    live.set(sessionId, s);
  }
  return s;
}

/** Fed every stored hook event, in arrival order. */
export function observeFatigue(e: SessionEvent): void {
  if (e.event === 'SessionEnd') { live.delete(e.sessionId); return; }
  const tool = e.toolName ?? '';
  if (e.event === 'PermissionRequest') {
    stateFor(e.sessionId).open.set(tool, e.at);
    return;
  }
  const s = live.get(e.sessionId);
  if (!s) return;
  if (e.event === 'Stop' || e.event === 'StopFailure' || e.event === 'UserPromptSubmit') {
    if (s.open.size) { s.open.clear(); s.streak = []; s.streakFrom = null; }
    return;
  }
  if (e.event !== 'PostToolUse' && e.event !== 'PostToolUseFailure' && e.event !== 'PermissionDenied') return;
  const askedAt = s.open.get(tool);
  if (askedAt === undefined) return;
  s.open.delete(tool);
  const ms = Math.max(0, e.at - askedAt);
  const { fastMs, run } = thresholds();
  if (ms >= fastMs) { s.streak = []; s.streakFrom = null; return; }
  if (!s.streak.length) s.streakFrom = askedAt;
  s.streak.push(ms);
  if (s.streak.length < run) return;
  const summary = `${s.streak.length} approvals in a row were answered in under ${(fastMs / 1000).toFixed(fastMs % 1000 ? 1 : 0)} s each (inferred).`;
  try {
    db().prepare('INSERT INTO policy_signals (at, session_id, project_id, kind, rule, summary, detail_json) VALUES (?,?,?,?,?,?,?)')
      .run(e.at, e.sessionId, projectIdOf(e.sessionId), 'fatigue', 'fatigue.fast-streak', summary,
        JSON.stringify({ inferredMs: s.streak, fastMs, run, from: s.streakFrom, to: e.at, inferred: true }));
  } catch { /* the counts are still derivable from the events */ }
  s.streak = [];
  s.streakFrom = null;
}

function projectIdOf(sessionId: string): string | null {
  try {
    const row = db().prepare('SELECT project_id FROM session_log WHERE id = ?').get(sessionId) as { project_id: string | null } | undefined;
    return row?.project_id ?? null;
  } catch { return null; }
}

const DAY = 24 * 3_600_000;

/** Counts over the last day, recomputed from the stored events so they match the timeline. */
export function fatigueReport(now = Date.now()): FatigueReport {
  const { fastMs, run } = thresholds();
  const rows = db().prepare(`
    SELECT session_id AS sessionId, at, event, tool_name AS toolName FROM session_events
     WHERE at >= ? AND event IN ('PermissionRequest','PostToolUse','PostToolUseFailure','PermissionDenied','Stop','StopFailure','SessionEnd','UserPromptSubmit')
     ORDER BY at ASC, id ASC LIMIT 50000
  `).all(now - DAY - 30 * 60_000) as FatigueEvent[];
  const decisions = inferDecisions(rows).filter((d) => d.askedAt >= now - DAY);
  const sessions = sessionCounts(decisions, fastMs).slice(0, 8);
  const names = new Map<string, string | null>();
  for (const s of sessions) {
    try {
      const r = db().prepare('SELECT project_name FROM session_log WHERE id = ?').get(s.sessionId) as { project_name: string } | undefined;
      names.set(s.sessionId, r?.project_name ?? null);
    } catch { names.set(s.sessionId, null); }
  }
  const signals = db().prepare("SELECT at, session_id AS sessionId, summary FROM policy_signals WHERE kind = 'fatigue' AND at >= ? ORDER BY at DESC LIMIT 10")
    .all(now - 7 * DAY) as FatigueReport['signals'];
  return {
    generatedAt: now,
    fastMs,
    run,
    totals: {
      asked: decisions.length,
      answered: decisions.filter((d) => d.inferredMs !== null).length,
      fast: decisions.filter((d) => d.inferredMs !== null && d.inferredMs < fastMs).length,
      unanswered: decisions.filter((d) => d.inferredMs === null).length,
    },
    hours: hourlyCounts(decisions, now, 24, fastMs),
    sessions: sessions.map((s) => ({ ...s, projectName: names.get(s.sessionId) ?? null })),
    signals,
  };
}
