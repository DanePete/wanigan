import type { Attention, AttentionKind, Session, SessionEvent } from '../shared/types';
import { ATTENTION_ORDER } from '../shared/types';
import { liveState, sessionEvents } from './hooks';

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

/* ── reading the hook bus ────────────────────────────────────────────── */

type Live = ReturnType<typeof liveState>;
const NO_LIVE: Live = { tool: null, since: 0, blocked: false, lastAt: null };

/**
 * Both reads hit SQLite, and the queue is recomputed on session:exit — which
 * also fires during a quit, after the database has been closed. Sessions.ts
 * swallows the same race on its own writes; a dead database is not a reason to
 * stop ranking, because Session alone still separates exited from running.
 */
function readLive(sessionId: string): Live {
  try {
    return liveState(sessionId);
  } catch {
    return NO_LIVE;
  }
}

/** Oldest last. sessionEvents returns newest-first, like every event log in the app. */
function tailFor(sessionId: string): SessionEvent[] {
  try {
    return sessionEvents(sessionId, TAIL).reverse();
  } catch {
    return [];
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

/* ── classification ──────────────────────────────────────────────────── */

function mk(
  session: Session,
  kind: AttentionKind,
  since: number,
  transitionId: string,
  detail: string | null,
  tool: string | null,
  now: number
): Attention {
  return {
    sessionId: session.id,
    kind,
    transitionId,
    // Clamped: an event stamped in the future would sort ahead of a real
    // four-minute wait and pin itself to the top of the queue.
    since: Math.min(since, now),
    label: ATTENTION_LABEL[kind],
    detail: clip(detail),
    tool: tool?.trim() || null,
  };
}

function classify(session: Session, now: number): Attention {
  const events = tailFor(session.id);
  const last = events[events.length - 1] ?? null;
  const live = readLive(session.id);
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
