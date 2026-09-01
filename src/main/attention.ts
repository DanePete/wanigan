import type { Attention, AttentionKind, Session, SessionEvent } from '../shared/types';
import { ATTENTION_ORDER } from '../shared/types';
import { eventsRevision, liveState, sessionEvents } from './hooks';
import { getSetting } from './settings';

/**
 * Which of nine running agents needs a human, and which has needed one longest.
 *
 * Wanigan's previous answer was the unread byte counter, which measures how much
 * an agent has said rather than whether it is stuck: a session streaming a long
 * file read outranks one that has sat on a permission prompt for four minutes.
 * Every classification here is a statement about the session's state, and every
 * `since` is the moment it entered that state — never the moment it was asked —
 * so the queue can be sorted by how long somebody has actually been waiting.
 */

/** No hook event and no terminal output for this long, and a running session is idle. */
export const IDLE_MS = 90_000;

/**
 * How long a failure keeps a session at the top of the queue. A StopFailure
 * matters while you can still do something about it; past this the session falls
 * back to idle or working, so an hour-old blip stops outranking a live
 * permission prompt.
 */
export const ERROR_WINDOW_MS = 5 * 60_000;

/**
 * How long a running agent may go without finishing anything before the queue
 * says so, unless the user has chosen otherwise. 0 turns the check off.
 *
 * The only time-based signal Wanigan had was IDLE_MS against terminal output,
 * and every agent here is a TUI: a spinner is output, a redraw is output, a
 * retry banner is output. So an agent in a network-retry loop, or looping on
 * the same failing command, read as "Working" for as long as it kept painting,
 * and "Idle" only ever meant "this TUI stopped repainting". Progress is a thing
 * the agent *finished* — a completed tool call — and hook events are where that
 * is recorded, so that is what this is measured against.
 */
const DEFAULT_STALL_MS = 10 * 60_000;
/** Read no more often than this: classification runs on every hook event. */
const STALL_SETTING_TTL_MS = 60_000;

/**
 * Identical failures in a row before this is called a loop rather than a retry.
 * Restricted to failures on purpose — the same call succeeding repeatedly is
 * ordinary work, and calling that stuck would be a guess worn as an observation.
 */
const REPEAT_LIMIT = 6;

/** A completed call: the one event that proves the agent moved forward. */
const PROGRESS_EVENTS = new Set(['PostToolUse', 'PostToolUseFailure']);
/** The turn is over, so nothing is in flight and nothing can be stalled. */
const TURN_ENDED = new Set(['Stop', 'StopFailure', 'SessionEnd']);

/**
 * How much event history the classifier reads. Generous on purpose: only the
 * newest event decides the state, but `working since` is the last prompt the
 * human submitted, and one prompt can be forty tool calls deep by the time you
 * look at it. A short window would silently fall back to the session start and
 * report a two-minute turn as a two-hour one.
 */
const TAIL = 200;

/** A hook summary can be a whole shell command; the queue shows one line of it. */
const MAX_DETAIL = 140;

const FAILURE_EVENTS = new Set(['StopFailure', 'PostToolUseFailure']);

/**
 * Events whose summary is the human's own prompt text. The queue is a navigation
 * surface, not a transcript: it says a session is working, never what it was
 * asked to do, so prompt content never reaches the renderer by this route.
 */
const PRIVATE_SUMMARY = new Set(['UserPromptSubmit']);

/**
 * Every Attention carries a word, and that is the whole reason `label` exists
 * rather than a colour enum.
 *
 * Insights settled this for its outcome marks: green against red measures ΔE 4.1
 * under deuteranopia, so for roughly one man in twelve a failed session and a
 * working one are the same dot. The word and the glyph carry the meaning; hue is
 * decoration laid over them, never the thing being read. One word each, distinct
 * in the first letter, so a narrow rail can truncate without two states
 * collapsing into one.
 */
export const ATTENTION_LABEL: Record<AttentionKind, string> = {
  permission: 'Asking',
  error: 'Failed',
  finished: 'Done',
  idle: 'Idle',
  working: 'Working',
};

/**
 * The word for an agent that is not getting anywhere.
 *
 * Deliberately not a sixth AttentionKind: that type is shared with the
 * renderer's two exhaustive glyph tables, and the label is what both the queue
 * and the fleet already render in preference to their own per-kind word. So the
 * kind keeps saying what was observed — an error where failures were seen, idle
 * where only an absence was — and the word says what it amounts to. Glyph plus
 * word still reads without colour, and each detail states its evidence rather
 * than a diagnosis.
 */
const STALLED_LABEL = 'Stalled';

/* ── reading the hook bus ────────────────────────────────────────────── */

type Live = ReturnType<typeof liveState>;
const NO_LIVE: Live = { tool: null, since: 0, blocked: false, lastAt: null };

/** Events oldest last; sessionEvents returns newest-first, like every log here. */
type Snapshot = { revision: number; events: SessionEvent[]; live: Live };

/**
 * One classification reads about four hundred rows, and the fleet is classified
 * on every hook event and on every poll of the queue — so the same rows were
 * read again and again for a session whose timeline had not moved. hooks.ts
 * stamps each session's rows; a stamp that still matches is proof they are the
 * same rows, and the read is skipped.
 *
 * The Attention itself is deliberately not cached. Idle and stalled are
 * statements about elapsed time, and a session crosses into both while its rows
 * sit perfectly still — a cached verdict would be a stopped clock. Only the
 * reads are held; the judgement is made against a fresh `now` every time.
 */
const snapshots = new Map<string, Snapshot>();
/** Nine live sessions is the design centre; the cap is for a long-lived app. */
const MAX_SNAPSHOTS = 64;

function snapshotOf(sessionId: string): Snapshot {
  const revision = eventsRevision(sessionId);
  const cached = snapshots.get(sessionId);
  if (cached && cached.revision === revision) return cached;

  try {
    const fresh: Snapshot = {
      revision,
      events: sessionEvents(sessionId, TAIL).reverse(),
      live: liveState(sessionId),
    };
    if (snapshots.size >= MAX_SNAPSHOTS) snapshots.clear();
    snapshots.set(sessionId, fresh);
    return fresh;
  } catch {
    // Both reads hit SQLite, and the queue is recomputed on session:exit — which
    // also fires during a quit, after the database has been closed. Sessions.ts
    // swallows the same race on its own writes; a dead database is not a reason
    // to stop ranking, because Session alone still separates exited from
    // running. Not stored: a read that failed is not this revision's answer, and
    // caching it would hold an empty timeline until the next event arrived.
    return { revision, events: [], live: NO_LIVE };
  }
}

/* ── terminal output recency ─────────────────────────────────────────── */

const lastOutput = new Map<string, number>();

/**
 * Tell the queue that a session produced terminal output.
 *
 * Idle means no hook event *and* no output. An agent streaming a long answer
 * fires no hooks at all, so without this it drops into the idle bucket while it
 * is visibly working. Called from the PTY data path in sessions.ts, which
 * throttles it to roughly one call a second: the stamp is only ever read
 * against the 90-second threshold below, so finer resolution buys nothing.
 */
export function noteOutput(sessionId: string, at: number = Date.now()) {
  lastOutput.set(sessionId, at);
}

/**
 * Drop a closed session, so the output map does not grow for the life of the
 * app. Called from the PTY exit path; an exited session is classified from its
 * exit code well before this map is consulted, so nothing is lost by it.
 */
export function forgetSession(sessionId: string) {
  lastOutput.delete(sessionId);
  snapshots.delete(sessionId);
}

/* ── phrasing ────────────────────────────────────────────────────────── */

/** One line, bounded, and never the raw prompt. */
function clip(s: string | null): string | null {
  if (!s) return null;
  const flat = s.replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  return flat.length > MAX_DETAIL ? `${flat.slice(0, MAX_DETAIL - 1)}…` : flat;
}

function join(tool: string | null, summary: string | null): string | null {
  const t = tool?.trim() || null;
  const s = summary?.trim() || null;
  if (t && s) return `${t} · ${s}`;
  return t ?? s;
}

function describe(ev: SessionEvent | null): string | null {
  if (!ev) return null;
  const summary = PRIVATE_SUMMARY.has(ev.event) ? null : ev.summary;
  return join(ev.toolName ?? ev.event, summary);
}

/** What it was last seen doing, in words a human uses rather than hook names. */
function lastSeen(ev: SessionEvent | null): string | null {
  if (!ev) return null;
  if (ev.event === 'UserPromptSubmit') return 'your prompt';
  if (ev.event === 'SessionStart') return 'it started';
  return describe(ev);
}

/** The PreToolUse that opened the call still in flight, for its summary. */
function callInFlight(events: SessionEvent[], tool: string): SessionEvent | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.event === 'PreToolUse' && e.toolName === tool) return e;
  }
  return null;
}

/**
 * When this stretch of work began: the last prompt the human submitted, or the
 * session start. Deliberately not the last event — a session that has run forty
 * tools against one prompt has been working for all forty, and a `since` that
 * advanced with each tool would sort it as the newest arrival every time the
 * queue refreshed.
 */
function workingSince(session: Session, events: SessionEvent[]): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.event === 'UserPromptSubmit' || e.event === 'SessionStart') return e.at;
  }
  return session.createdAt;
}

/* ── stalled: progress, measured in hook events ──────────────────────── */

let stallMs = DEFAULT_STALL_MS;
let stallReadAt = 0;

/** Re-read on a coarse interval, so a settings change lands without a restart. */
function stallThresholdMs(now: number): number {
  if (stallReadAt && now - stallReadAt < STALL_SETTING_TTL_MS) return stallMs;
  stallReadAt = now;
  try {
    const minutes = Number(getSetting('stall_minutes', String(DEFAULT_STALL_MS / 60_000)));
    stallMs = Number.isFinite(minutes) && minutes >= 0
      // A day is the ceiling; past that the check has stopped being a check.
      ? Math.min(24 * 60, Math.round(minutes)) * 60_000
      : DEFAULT_STALL_MS;
  } catch {
    // A closed database during quit must not stop the fleet being ranked, and
    // the default is the answer this setting gives until somebody changes it.
    stallMs = DEFAULT_STALL_MS;
  }
  return stallMs;
}

/**
 * The moment the current stretch of unfinished work began, or null when there is
 * nothing to measure against.
 *
 * Null is the important half. A provider that posts no PostToolUse, or a run
 * with hooks switched off, has never given Wanigan evidence of progress — and
 * without evidence the honest answer is to say nothing, not to call every such
 * session stalled for the rest of its life.
 */
function stallBaseline(events: SessionEvent[]): SessionEvent | null {
  let turnStart: SessionEvent | null = null;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (TURN_ENDED.has(e.event)) return null;
    // A prompt newer than the last completed call means this turn has finished
    // nothing yet, and the wait belongs to the turn rather than to the call
    // before it — the human was still typing in between.
    if (e.event === 'UserPromptSubmit' || e.event === 'SessionStart') turnStart = e;
    else if (PROGRESS_EVENTS.has(e.event)) return turnStart ?? e;
  }
  return null;
}

/**
 * The same call failing over and over: a retry loop, or an agent circling its
 * own error. Reported only while the loop is still going round — a streak that
 * stopped an hour ago is history, and the time rule below is what covers a
 * session that went quiet on one.
 */
function repeatedFailure(events: SessionEvent[], now: number): {
  since: number; transitionId: string; detail: string; tool: string | null;
} | null {
  let key: string | null = null;
  let count = 0;
  let latest: SessionEvent | null = null;
  let first: SessionEvent | null = null;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (TURN_ENDED.has(e.event) || e.event === 'UserPromptSubmit') break;
    if (!PROGRESS_EVENTS.has(e.event)) continue;
    // A call that came back clean is progress, whatever it repeated.
    if (e.ok !== false) break;
    const k = `${e.toolName ?? e.event}\u0000${e.summary ?? ''}`;
    if (key === null) { key = k; latest = e; }
    else if (k !== key) break;
    count++;
    first = e;
  }
  if (!first || !latest || count < REPEAT_LIMIT) return null;
  if (now - latest.at > ERROR_WINDOW_MS) return null;
  return {
    since: first.at,
    // One identity for the whole loop, so a notification is sent when it starts
    // rather than once per lap — which is what a per-failure transition did.
    transitionId: `stalled:repeat:${first.at}`,
    detail: `${describe(first) ?? 'The same call'} failed ${count} times in a row.`,
    tool: first.toolName,
  };
}

/**
 * Still active — something is arriving from the session — but nothing it started
 * has finished for longer than the threshold. An absence, reported as one: the
 * detail names the last thing that did finish and claims nothing about why.
 */
function stalled(events: SessionEvent[], now: number): {
  since: number; transitionId: string; detail: string;
} | null {
  const threshold = stallThresholdMs(now);
  if (!threshold) return null;
  const baseline = stallBaseline(events);
  if (!baseline || now - baseline.at <= threshold) return null;
  // `since` is the instant it became stalled, like the idle branch below, so
  // "who has been stuck longest" stays answerable across refreshes.
  const at = baseline.at + threshold;
  return {
    since: at,
    transitionId: `stalled:${at}`,
    detail: `Still active, but nothing has finished since ${lastSeen(baseline) ?? 'its last step'}.`,
  };
}

/* ── classification ──────────────────────────────────────────────────── */

function mk(
  session: Session,
  kind: AttentionKind,
  since: number,
  transitionId: string,
  detail: string | null,
  tool: string | null,
  now: number,
  label: string = ATTENTION_LABEL[kind]
): Attention {
  return {
    sessionId: session.id,
    kind,
    transitionId,
    // Clamped: an event stamped in the future would sort ahead of a real
    // four-minute wait and pin itself to the top of the queue.
    since: Math.min(since, now),
    label,
    detail: clip(detail),
    tool: tool?.trim() || null,
  };
}

function classify(session: Session, now: number): Attention {
  const { events, live } = snapshotOf(session.id);
  const last = events[events.length - 1] ?? null;
  const exited = session.status === 'exited';

  // A permission prompt on an exited session is a question nobody can answer:
  // the process that asked it is gone. Honouring it would pin a dead session to
  // the top of the queue for as long as the app stayed open.
  if (!exited && live.blocked) {
    const tool = last?.toolName ?? live.tool;
    return mk(
      session,
      'permission',
      live.since || last?.at || now,
      last ? `event:${last.id}` : `permission:${live.since || now}`,
      join(tool, last?.summary ?? null) ?? 'Waiting for your approval.',
      tool,
      now
    );
  }

  if (exited && session.exitCode !== null && session.exitCode !== 0) {
    const ended = session.endedAt ?? now;
    return mk(session, 'error', ended, `exit:${ended}:${session.exitCode}`, `Exited with code ${session.exitCode}.`, null, now);
  }

  // A loop says more than its newest lap does, so it is read before the single
  // failure below. It stays an error kind because the failures were observed
  // rather than inferred — the word is what says the agent is not getting
  // anywhere, and `since` is when the loop began rather than when it last went
  // round, so it sorts by how long it has really been stuck.
  const loop = exited ? null : repeatedFailure(events, now);
  if (loop) {
    return mk(session, 'error', loop.since, loop.transitionId, loop.detail, loop.tool, now, STALLED_LABEL);
  }

  if (last && FAILURE_EVENTS.has(last.event) && now - last.at <= ERROR_WINDOW_MS) {
    return mk(session, 'error', last.at, `event:${last.id}`, describe(last) ?? 'The last step failed.', last.toolName, now);
  }

  if (exited) {
    // A null exit code means the PTY never reported one — closed out on quit.
    // That is not evidence of a failure, so it is not claimed as one.
    const ended = session.endedAt ?? now;
    // A clean PTY exit after Stop is the same completed turn, even if the user
    // leaves the finished prompt sitting for a while before closing it. Only a
    // later event, not elapsed wall time, proves that another turn intervened.
    let transitionId = `exit:${ended}:${session.exitCode ?? 'unknown'}`;
    if (session.exitCode === 0) {
      for (let i = events.length - 1; i >= 0; i--) {
        const candidate = events[i];
        if (candidate.event !== 'Stop') continue;
        const after = events.slice(i + 1);
        if (ended - candidate.at >= 0
          && after.every((value) => value.event === 'SessionEnd')) {
          transitionId = `event:${candidate.id}`;
        }
        break;
      }
    }
    return mk(
      session,
      'finished',
      ended,
      transitionId,
      session.exitCode === 0 ? 'Exited cleanly.' : 'Exited.',
      null,
      now
    );
  }

  if (last?.event === 'Stop') {
    return mk(session, 'finished', last.at, `event:${last.id}`, last.summary ?? 'Finished its turn.', null, now);
  }

  const activeAt = Math.max(session.createdAt, live.lastAt ?? 0, lastOutput.get(session.id) ?? 0);
  if (now - activeAt > IDLE_MS) {
    // `since` is when it went quiet plus the threshold — the instant it became
    // idle — and not `now`. A `since` recomputed as now on every refresh makes
    // "who has waited longest" unanswerable, which is the whole question.
    return mk(
      session,
      'idle',
      activeAt + IDLE_MS,
      `idle:${activeAt + IDLE_MS}`,
      last ? `Quiet since ${lastSeen(last)}.` : 'No hook events yet.',
      live.tool,
      now
    );
  }

  // Below the idle threshold something is still arriving, so this is an agent
  // that looks busy. Whether it is getting anywhere is a different question, and
  // the answer comes from what it has finished rather than from what it printed.
  const stall = stalled(events, now);
  if (stall) {
    return mk(session, 'idle', stall.since, stall.transitionId, stall.detail, live.tool, now, STALLED_LABEL);
  }

  let detail: string | null = null;
  if (live.tool) {
    // The opening call carries the half worth reading: "Edit · src/main/db.ts",
    // not the bare word "Edit".
    detail = join(live.tool, callInFlight(events, live.tool)?.summary ?? null);
  } else if (last && !PRIVATE_SUMMARY.has(last.event)) {
    detail = describe(last);
  }
  const began = workingSince(session, events);
  return mk(
    session,
    'working',
    began,
    last ? `event:${last.id}` : `working:${began}`,
    detail,
    live.tool,
    now,
  );
}

/* ── the queue ───────────────────────────────────────────────────────── */

export function attentionOf(session: Session): Attention {
  return classify(session, Date.now());
}

export function attentionFor(sessions: Session[]): Attention[] {
  // One clock for the whole fleet. Reading Date.now() per session lets two
  // sessions be measured against different instants, and the idle threshold sits
  // close enough to it that the pair can rank inconsistently on the same tick.
  const now = Date.now();
  return sessions.map((s) => classify(s, now)).sort(rank);
}

/**
 * Queue order: worst state first, then longest wait first. Exported so the
 * renderer can re-sort a list it already holds without drifting from the order
 * the main process produced.
 */
export function rank(a: Attention, b: Attention): number {
  const byKind = ATTENTION_ORDER.indexOf(a.kind) - ATTENTION_ORDER.indexOf(b.kind);
  if (byKind !== 0) return byKind;
  if (a.since !== b.since) return a.since - b.since;
  // Ties broken on session id. Array#sort is only stable with respect to its
  // input order, and main and renderer do not always hold the same input order —
  // without this the two sides disagree about two sessions that arrived in the
  // same millisecond, and the row under the cursor moves as the queue refreshes.
  return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0;
}
