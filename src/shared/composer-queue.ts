import type { AttentionKind, SessionStatus } from './types';

/**
 * The composer queue's pure half, shared so the main-process smoke suite can
 * hold it to account: when a send is safe, and when the timer that drains a
 * queue still has something to wait for. The renderer keeps everything with a
 * closure, a timer or a PTY write in it — the same split shared/palette.ts uses.
 */

export type ComposerSendState = {
  mode: 'send' | 'queue' | 'blocked';
  /** The sentence behind the button label; null when mode is plain send. */
  reason: string | null;
};

/**
 * When a send is safe. Idle and finished mean the TUI is at its own prompt.
 * A permission prompt must never be answered by queued text, an errored
 * session should hear from a human first, and an unknown state fails closed —
 * queueing costs seconds, a mis-send costs a wrong approval.
 */
export function deriveSendState(input: {
  status: SessionStatus | null;
  attention: AttentionKind | null;
}): ComposerSendState {
  if (input.status !== 'running') {
    return { mode: 'blocked', reason: 'This session has exited, so there is no prompt to type into.' };
  }
  switch (input.attention) {
    case 'idle':
    case 'finished':
      return { mode: 'send', reason: null };
    case 'permission':
      return { mode: 'queue', reason: 'The agent is waiting on a permission prompt — queued text must not answer it.' };
    case 'error':
      return { mode: 'queue', reason: 'The agent stopped on an error; queued messages hold until it is idle again.' };
    case 'working':
      return { mode: 'queue', reason: 'The agent is mid-turn; this sends when it goes idle.' };
    default:
      return { mode: 'queue', reason: 'The agent’s state is not known yet; queued until it reads idle.' };
  }
}

/* ── whether the drain timer still has anything to wait for ──────────────── */

/**
 * What the last trustworthy session list said about a session a queue is
 * aimed at.
 *
 *   live    — listed, and not exited. The queue may still drain.
 *   exited  — listed as exited. The PTY is gone; nothing will ever drain.
 *   gone    — a completed read did not list it at all. `sessionListEntries()`
 *             maps the whole session map, exited entries included, so an id is
 *             absent only after `closeSession()` deliberately removed it.
 *   unknown — nothing has been observed yet, or every read since has failed.
 */
export type QueueTargetState = 'live' | 'exited' | 'gone' | 'unknown';

/**
 * One poll's answer. `ok: false` is a read that threw — an IPC round trip that
 * never landed is not evidence about any session, and reading it as one would
 * strand a live queue behind a stopped timer.
 */
export type SessionListReading =
  | { ok: true; sessions: readonly { id: string; status: SessionStatus }[] }
  | { ok: false };

/**
 * Fold one list read into what is known about the sessions with queues.
 *
 * The naive guard — "the id is missing, so stop" — is wrong twice over. It
 * never fires for the case that prompted this, because an exited session stays
 * in the list until it is closed; and when it does fire, on a closed session,
 * it fires off a read that may simply have failed. Both are separate states
 * here, and a failed read carries the previous verdict forward untouched
 * rather than inventing one.
 */
export function observeQueueTargets(
  queuedIds: readonly string[],
  reading: SessionListReading,
  previous: ReadonlyMap<string, QueueTargetState>,
): Map<string, QueueTargetState> {
  const next = new Map<string, QueueTargetState>();
  const statusOf = reading.ok
    ? new Map(reading.sessions.map((s) => [s.id, s.status] as const))
    : null;
  for (const id of queuedIds) {
    if (!statusOf) { next.set(id, previous.get(id) ?? 'unknown'); continue; }
    const status = statusOf.get(id);
    if (status === undefined) next.set(id, 'gone');
    else next.set(id, status === 'exited' ? 'exited' : 'live');
  }
  return next;
}

/**
 * Whether the two-second attention + session poll is still earning its keep.
 *
 * A queue whose sessions have all exited or been closed will never drain, and
 * the timer that keeps asking is pure cost. Stopping it does not touch the
 * queued text: the messages stay on screen, labelled as not sent, which is the
 * true thing to say about them.
 *
 * `unknown` counts as wanted. Losing a poll is recoverable; a message that
 * silently stops being watched because one IPC call failed is not.
 */
export function queueWatcherWanted(
  queuedIds: readonly string[],
  observed: ReadonlyMap<string, QueueTargetState>,
): boolean {
  return queuedIds.some((id) => {
    const seen = observed.get(id) ?? 'unknown';
    return seen === 'live' || seen === 'unknown';
  });
}
