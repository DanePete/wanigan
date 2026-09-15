import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { db } from './db';
import { sessionEvents } from './hooks';
import { attentionOf, currentLimitReading } from './attention';
import { listCheckpoints } from './checkpoints';
import { exactTranscriptPath } from './transcripts';
import { codexRolloutFiles } from './codex-sessions';
import { createSession, listSessions, markUnread, popClosedTab } from './sessions';
import { halted } from './halt';
import { clearSnooze, snooze } from './snoozes';
import { recordOperatorAction } from './operator-actions';
import { buildAwaySummary, recapFromTranscriptText } from '../shared/away-summary';
import { limitResetFor, limitStopEvidence } from '../shared/attention-rules';
import { AWAY_MIN_MS, isSnoozePreset, outsideWriter } from '../shared/session-triage';
import type {
  AwaySummary, LaunchOptions, LimitResumeOffer, ProviderId, ResumeAtReset, ResumeAtResetState, ResumeCheck, Session,
} from '../shared/types';

/**
 * Triage: the operator's own decisions about which session to look at, and
 * what they left recorded while they were not looking.
 *
 * Nothing here decides anything on the operator's behalf. A snooze, a mark, a
 * scheduled resume and a fork are each one explicit click, and each one is
 * either reversible or recorded. Nothing here calls a model either: a summary
 * is counted from rows, and a recap is read from a file the CLI already wrote.
 */

type LogRow = {
  id: string;
  conversation_id: string | null;
  provider_id: string;
  harness_id: string | null;
  project_id: string | null;
  project_path: string;
  project_name: string;
  worktree: string | null;
  model: string | null;
  effort: string | null;
  permission_mode: string | null;
  title: string | null;
};

function logRow(sessionId: string): LogRow | null {
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 128) return null;
  return (db().prepare(`
    SELECT id, conversation_id, provider_id, harness_id, project_id, project_path, project_name,
           worktree, model, effort, permission_mode, title
      FROM session_log WHERE id = ?
  `).get(sessionId) as LogRow | undefined) ?? null;
}

function harnessOf(row: LogRow): string {
  if (row.harness_id?.trim()) return row.harness_id;
  return row.provider_id === 'codex' ? 'codex' : 'claude-code';
}

/* ── snooze and mark ─────────────────────────────────────────────────── */

export function snoozeSession(sessionId: unknown, preset: unknown): { untilAt: number } {
  if (typeof sessionId !== 'string' || !listSessions().some((s) => s.id === sessionId)) {
    throw new Error('That session is not open, so there is nothing to snooze.');
  }
  if (!isSnoozePreset(preset)) throw new Error('Snooze for 15 minutes, 1 hour, 3 hours, or until tomorrow at 9:00.');
  const s = snooze(sessionId, preset);
  recordOperatorAction(sessionId, 'session-snoozed', preset);
  return { untilAt: s.untilAt };
}

export function unsnoozeSession(sessionId: unknown): boolean {
  if (typeof sessionId !== 'string') return false;
  clearSnooze(sessionId);
  return true;
}

export function markSessionUnread(sessionId: unknown): boolean {
  return typeof sessionId === 'string' && markUnread(sessionId);
}

/* ── since you last looked ───────────────────────────────────────────── */

function lookedAt(sessionId: string): number | null {
  const row = db().prepare('SELECT looked_at FROM session_looks WHERE session_id = ?').get(sessionId) as { looked_at: number } | undefined;
  return row ? Number(row.looked_at) : null;
}

function noteLooked(sessionId: string, at: number): void {
  db().prepare(`INSERT INTO session_looks (session_id, looked_at) VALUES (?,?)
    ON CONFLICT(session_id) DO UPDATE SET looked_at = excluded.looked_at`).run(sessionId, at);
}

/**
 * The tab stopped being in front of the operator: switched away, or the
 * Sessions view closed. This is the moment "since you last looked" counts from.
 */
export function sessionLeft(sessionId: unknown, now: number = Date.now()): boolean {
  if (typeof sessionId !== 'string' || !listSessions().some((s) => s.id === sessionId)) return false;
  noteLooked(sessionId, now);
  return true;
}

/**
 * The tab came back into view. Returns what was recorded in between when the
 * absence was long enough to be worth a summary, and moves the mark to now
 * either way, so the next return counts from here.
 */
export function sessionReturned(sessionId: unknown, now: number = Date.now()): AwaySummary | null {
  if (typeof sessionId !== 'string') return null;
  const session = listSessions().find((s) => s.id === sessionId);
  if (!session) return null;
  const since = lookedAt(sessionId);
  noteLooked(sessionId, now);
  if (since === null || now - since < AWAY_MIN_MS) return null;
  return awaySummary(session, since, now);
}

export function awaySummary(session: Session, since: number, until: number): AwaySummary {
  const events = sessionEvents(session.id, 2000).filter((e) => e.at > since);
  let checkpoints: ReturnType<typeof listCheckpoints> = [];
  try { checkpoints = listCheckpoints(session.id); } catch { /* checkpoints are optional evidence */ }
  let verdict = null;
  try { const a = attentionOf(session); verdict = { kind: a.kind, label: a.label }; } catch { /* quit */ }
  return buildAwaySummary({
    sessionId: session.id, since, until, events, checkpoints,
    costDeltaUsd: costSince(session.id, since, until),
    verdict,
    recap: recapFor(session, since),
  });
}

/**
 * Reported cost inside the window, or null when this session has never
 * reported a cost at all — a Codex session on a ChatGPT plan reports tokens but
 * no invoice, and "$0.00 while you were away" would be a claim it never made.
 */
function costSince(sessionId: string, since: number, until: number): number | null {
  try {
    const ever = db().prepare('SELECT COUNT(*) n FROM session_api_events WHERE session_id = ? AND cost_usd > 0').get(sessionId) as { n: number };
    if (!ever.n) return null;
    const row = db().prepare('SELECT COALESCE(SUM(cost_usd), 0) s FROM session_api_events WHERE session_id = ? AND at > ? AND at <= ?')
      .get(sessionId, since, until) as { s: number };
    return Number(row.s);
  } catch {
    return null;
  }
}

/** How much of a transcript's tail is read for a recap. Recaps are recent by definition. */
const RECAP_TAIL_BYTES = 512 * 1024;

function recapFor(session: Session, since: number): { text: string; at: number } | null {
  if ((session.harnessId ?? 'claude-code') !== 'claude-code' || session.backendId !== 'anthropic') return null;
  const file = exactTranscriptPath(session.worktree ?? session.projectPath, session.conversationId ?? null);
  if (!file) return null;
  try { return recapFromTranscriptText(tail(file, RECAP_TAIL_BYTES), since); } catch { return null; }
}

function tail(file: string, bytes: number): string {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, bytes);
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, size - length);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/* ── the same conversation, twice ────────────────────────────────────── */

/**
 * What resuming this conversation now would collide with, and whether a fork
 * is available instead. Asked before a resume; the renderer warns on either
 * collision and offers the fork only when `fork.supported`.
 */
export function resumeCheck(sessionId: unknown, now: number = Date.now()): ResumeCheck {
  const row = typeof sessionId === 'string' ? logRow(sessionId) : null;
  if (!row) throw new Error('That conversation is not in Wanigan’s records.');
  const harness = harnessOf(row);
  const conversation = row.conversation_id?.trim() || null;
  const live = conversation
    ? listSessions().find((s) => s.status !== 'exited' && s.conversationId === conversation
      && (s.harnessId ?? 'claude-code') === harness) ?? null
    : null;

  let modifiedAt: number | null = null;
  try {
    const file = harness === 'codex'
      ? (conversation ? codexRolloutFiles([conversation]).get(conversation.toLowerCase()) ?? null : null)
      : exactTranscriptPath(row.worktree ?? row.project_path, conversation);
    if (file) modifiedAt = fs.statSync(file).mtimeMs;
  } catch { /* no transcript is no evidence of a second writer */ }

  const fork = harness === 'codex'
    ? { supported: !!conversation, how: 'codex fork', why: conversation
      ? '`codex fork <id>` starts a new thread from this one (Codex CLI 0.154.0).'
      : 'This conversation has no saved Codex thread id to fork from.' }
    : harness === 'claude-code'
      ? { supported: !!conversation, how: '--fork-session', why: conversation
        ? '`--resume <id> --fork-session` starts a new conversation from this one (Claude Code 2.1.271).'
        : 'This conversation has no saved id to fork from.' }
      : { supported: false, how: null, why: `The ${harness} harness has no fork Wanigan has verified.` };

  // A write made before one of Wanigan's own runs of this conversation ended
  // is that run's, not a stranger's: a tab that exited ten seconds ago leaves
  // its transcript ten seconds old, and warning about it would warn about
  // ourselves on every in-place resume.
  let ownUntil = 0;
  if (conversation) {
    try {
      const ended = db().prepare("SELECT MAX(COALESCE(ended_at, 0)) m FROM session_log WHERE conversation_id = ? AND origin = 'wanigan'")
        .get(conversation) as { m: number | null } | undefined;
      ownUntil = Number(ended?.m ?? 0);
    } catch { /* no record is no exemption */ }
    for (const s of listSessions()) {
      if (s.conversationId === conversation && s.endedAt) ownUntil = Math.max(ownUntil, s.endedAt);
    }
  }
  const ours = modifiedAt !== null && ownUntil > 0 && modifiedAt <= ownUntil + OWN_WRITE_SLACK_MS;

  return {
    liveInWanigan: live ? { sessionId: live.id, title: live.displayTitle || live.title } : null,
    outsideWriter: !ours && outsideWriter(modifiedAt, now, !!live) ? { modifiedAt: modifiedAt! } : null,
    fork,
  };
}

/** A transcript flush can land a moment after the process reports its exit. */
const OWN_WRITE_SLACK_MS = 5_000;

function launchOptionsFor(row: LogRow): LaunchOptions {
  if (!row.project_id) throw new Error('That conversation’s project is no longer registered in Wanigan.');
  if (!row.conversation_id?.trim()) throw new Error('That conversation has no saved id, so it cannot be resumed exactly.');
  return {
    providerId: row.provider_id as ProviderId,
    projectId: row.project_id,
    model: row.model ?? undefined,
    effort: row.effort ?? undefined,
    permissionMode: row.permission_mode ?? undefined,
    resumeFrom: { sessionId: row.id, conversationId: row.conversation_id },
  };
}

/** Resume as a fork: the explicit alternative the collision warning offers. */
export async function resumeAsFork(sessionId: unknown): Promise<Session> {
  const row = typeof sessionId === 'string' ? logRow(sessionId) : null;
  if (!row) throw new Error('That conversation is not in Wanigan’s records.');
  const created = await createSession({ ...launchOptionsFor(row), forkSession: true });
  recordOperatorAction(created.id, 'resume-forked', `from ${row.id}`);
  return created;
}

/* ── reopen the last closed tab ──────────────────────────────────────── */

/**
 * Reopen the newest tab closed this run. A closed tab's process is gone, so
 * this is a resume of its conversation through the same path Recent uses; a
 * conversation that is already open again is skipped rather than opened twice.
 */
export async function reopenClosedTab(): Promise<Session | null> {
  for (let id = popClosedTab(); id; id = popClosedTab()) {
    const row = logRow(id);
    if (!row?.conversation_id || !row.project_id) continue;
    const open = listSessions().some((s) => s.status !== 'exited' && s.conversationId === row.conversation_id);
    if (open) continue;
    const created = await createSession(launchOptionsFor(row));
    recordOperatorAction(created.id, 'tab-reopened', `from ${row.id}`);
    return created;
  }
  return null;
}

/* ── resume at reset ─────────────────────────────────────────────────── */

/** The wait after a predicted reset before resuming, so the launch is not the first request the reset refuses. */
const RESET_GRACE_MS = 60_000;
/** A resume that could not run for this long past its time is no longer the one the operator asked for. */
const STALE_AFTER_MS = 12 * 60 * 60_000;
/** The furthest ahead a reset may be scheduled: a week window plus a day. */
const HORIZON_MS = 8 * 24 * 60 * 60_000;
const TICK_MS = 20_000;

type ResetRow = {
  id: string; session_id: string; provider_id: string; project_name: string; fire_at: number; state: string;
  source: string; launched_session_id: string | null; detail: string | null; created_at: number;
};

function toResume(r: ResetRow): ResumeAtReset {
  return {
    id: r.id, sessionId: r.session_id, providerId: r.provider_id as ProviderId, projectName: r.project_name,
    fireAt: Number(r.fire_at), state: r.state as ResumeAtResetState, createdAt: Number(r.created_at),
    source: r.source, launchedSessionId: r.launched_session_id, detail: r.detail,
  };
}

export function resumesAtReset(): ResumeAtReset[] {
  return (db().prepare('SELECT * FROM resume_at_reset ORDER BY created_at DESC LIMIT 50').all() as ResetRow[]).map(toResume);
}

function armedFor(sessionId: string): ResumeAtReset | null {
  const r = db().prepare("SELECT * FROM resume_at_reset WHERE session_id = ? AND state = 'armed' ORDER BY created_at DESC LIMIT 1")
    .get(sessionId) as ResetRow | undefined;
  return r ? toResume(r) : null;
}

/**
 * What "Resume at reset" can offer for a session that has exited: the evidence
 * that it stopped on a limit (or that the operator said so), and the reset the
 * last limit reading predicts. Never probes for limits — a reading comes from a
 * previous read on the Usage page, and when there is none the offer says so.
 */
export function limitResumeOffer(sessionId: unknown, operatorSaysLimit = false, now: number = Date.now()): LimitResumeOffer {
  const row = typeof sessionId === 'string' ? logRow(sessionId) : null;
  if (!row) throw new Error('That conversation is not in Wanigan’s records.');
  const events = sessionEvents(row.id, 200).reverse();
  const evidence = limitStopEvidence(events);
  const said = evidence
    ? evidence.state === 'stopped'
      ? 'Claude Code reported it would not continue on its own after the usage limit.'
      : 'Its last turn ended with StopFailure rate_limit and nothing ran after it.'
    : operatorSaysLimit ? 'You marked this session as stopped on a usage limit.' : '';
  const read = currentLimitReading();
  const live = listSessions().find((s) => s.id === row.id);
  const reset = read ? limitResetFor(read.limits, live?.accountId ?? null, harnessOf(row), read.at, now) : null;
  return {
    sessionId: row.id,
    evidence: said,
    reset,
    note: reset ? null : read
      ? 'The last limit reading shows no full window for this account, so it predicts no reset time.'
      : 'No limit reading yet. Open Usage to read this account’s limits, then come back.',
    armed: armedFor(row.id),
  };
}

export function armResumeAtReset(sessionId: unknown, operatorSaysLimit = false, now: number = Date.now()): ResumeAtReset {
  const offer = limitResumeOffer(sessionId, operatorSaysLimit, now);
  if (!offer.evidence) throw new Error('Nothing recorded says this session stopped on a limit. Mark it as a limit stop first if it did.');
  if (!offer.reset) throw new Error(offer.note ?? 'No limit reading predicts a reset for this session.');
  if (offer.reset.resetsAt - now > HORIZON_MS) throw new Error('That reset is more than a week away; Wanigan will not hold a resume that long.');
  const row = logRow(offer.sessionId)!;
  launchOptionsFor(row); // refuses a conversation that could not be resumed exactly, now rather than at reset
  if (offer.armed) return offer.armed;
  const id = `rar_${randomUUID()}`;
  const scope = offer.reset.scope ? `${offer.reset.scope} ` : '';
  const source = `${offer.reset.accountLabel} ${scope}${offer.reset.kind} window, from the limit reading taken ${new Date(offer.reset.readAt).toISOString()}`;
  db().prepare(`INSERT INTO resume_at_reset (id, session_id, provider_id, project_name, fire_at, state, source, created_at, updated_at)
    VALUES (?,?,?,?,?,'armed',?,?,?)`).run(id, row.id, row.provider_id, row.project_name, offer.reset.resetsAt + RESET_GRACE_MS, source, now, now);
  recordOperatorAction(row.id, 'resume-at-reset-armed', source);
  return armedFor(row.id)!;
}

export function cancelResumeAtReset(id: unknown): boolean {
  if (typeof id !== 'string') return false;
  const res = db().prepare("UPDATE resume_at_reset SET state='cancelled', updated_at=? WHERE id = ? AND state = 'armed'").run(Date.now(), id);
  if (res.changes) {
    const r = db().prepare('SELECT session_id FROM resume_at_reset WHERE id = ?').get(id) as { session_id: string } | undefined;
    recordOperatorAction(r?.session_id ?? null, 'resume-at-reset-cancelled', id);
  }
  return res.changes > 0;
}

function settle(id: string, state: ResumeAtResetState | 'launching', detail: string | null, launched: string | null = null): boolean {
  const from = state === 'launching' ? 'armed' : 'launching';
  return db().prepare('UPDATE resume_at_reset SET state=?, detail=?, launched_session_id=COALESCE(?, launched_session_id), updated_at=? WHERE id=? AND state=?')
    .run(state, detail, launched, Date.now(), id, from).changes > 0;
}

/**
 * Resume every armed conversation whose time has come. The row is claimed
 * before the launch, so two Wanigan processes sharing this database — the app
 * and its scheduler — cannot both resume one conversation.
 */
export async function fireDueResumes(now: number = Date.now()): Promise<number> {
  const due = db().prepare("SELECT * FROM resume_at_reset WHERE state='armed' AND fire_at <= ? ORDER BY fire_at LIMIT 5").all(now) as ResetRow[];
  let launched = 0;
  for (const r of due) {
    if (now - Number(r.fire_at) > STALE_AFTER_MS) {
      if (settle(r.id, 'launching', null)) settle(r.id, 'expired', 'Wanigan was not running when this was due, and it is now more than 12 hours late. It was not resumed.');
      continue;
    }
    if (halted()) continue; // held, not failed: clearing the halt lets it run at the next tick
    if (!settle(r.id, 'launching', null)) continue;
    const row = logRow(r.session_id);
    try {
      if (!row) throw new Error('The conversation’s record is gone.');
      const created = await createSession(launchOptionsFor(row));
      settle(r.id, 'launched', `Resumed ${new Date().toISOString()}.`, created.id);
      recordOperatorAction(created.id, 'resume-at-reset-launched', `armed as ${r.id} for ${r.session_id}`);
      launched += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      settle(r.id, 'failed', message);
      recordOperatorAction(r.session_id, 'resume-at-reset-failed', message);
    }
  }
  return launched;
}

let resumeTimer: ReturnType<typeof setInterval> | null = null;

/** Started by the attended app only: a resume opens a terminal, and a windowless process has nowhere to put one. */
export function startResumeScheduler(onLaunched: () => void): void {
  if (resumeTimer) return;
  resumeTimer = setInterval(() => {
    void fireDueResumes().then((n) => { if (n) onLaunched(); }).catch(() => { /* the next tick asks again */ });
  }, TICK_MS);
  resumeTimer.unref?.();
}

export function stopResumeScheduler(): void {
  if (resumeTimer) clearInterval(resumeTimer);
  resumeTimer = null;
}
