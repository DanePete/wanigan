/**
 * Triage decisions that are pure arithmetic over state the operator already
 * made: when a snooze ends, whether a new verdict is allowed to cut one short,
 * which session "next one that needs you" lands on, and whether a resume is
 * about to become a second writer on one conversation.
 *
 * Main and renderer both import this, so the queue main ranks and the chord
 * the renderer presses cannot disagree about which session is next.
 */
import type { Attention, AttentionKind, SnoozePreset } from './types';

export const SNOOZE_PRESETS: readonly { id: SnoozePreset; word: string }[] = [
  { id: '15m', word: '15 minutes' },
  { id: '1h', word: '1 hour' },
  { id: '3h', word: '3 hours' },
  { id: 'tomorrow', word: 'Until tomorrow 9:00' },
];

export function isSnoozePreset(value: unknown): value is SnoozePreset {
  return value === '15m' || value === '1h' || value === '3h' || value === 'tomorrow';
}

/**
 * When a snooze taken at `now` ends, in local time.
 *
 * "Tomorrow" is the next calendar day at nine, not twenty-four hours: a snooze
 * taken at 23:50 that ended at 23:50 the next night would have skipped the
 * working morning it was meant for.
 */
export function snoozeUntil(preset: SnoozePreset, now: number): number {
  switch (preset) {
    case '15m': return now + 15 * 60_000;
    case '1h': return now + 60 * 60_000;
    case '3h': return now + 3 * 60 * 60_000;
    case 'tomorrow': {
      const d = new Date(now);
      d.setDate(d.getDate() + 1);
      d.setHours(9, 0, 0, 0);
      return d.getTime();
    }
  }
}

/**
 * The kinds that wake a snoozed session early. A snooze is "not now unless it
 * raises its hand": a permission prompt, a failure or an auto-mode denial is a
 * hand, and a turn finishing or going quiet is not.
 */
const WAKES: ReadonlySet<AttentionKind> = new Set(['permission', 'error']);

/**
 * Whether this verdict cuts a snooze short. Only a state that *began after* the
 * snooze counts: snoozing a session that is already failing is a decision
 * about that failure, and waking on it one poll later would undo the click.
 */
export function wakesSnooze(verdict: Pick<Attention, 'kind' | 'since'>, snoozedAt: number): boolean {
  return WAKES.has(verdict.kind) && verdict.since >= snoozedAt;
}

/** Kinds a person is being asked to act on; the jump chord visits only these. */
export const NEEDS_YOU: readonly AttentionKind[] = ['permission', 'error', 'finished'];

/**
 * The session "jump to the next one that needs you" should land on.
 *
 * Walks the queue in the order main ranked it, skipping snoozed sessions and
 * anything not asking for a person. From the session already on screen it
 * moves to the one after it, wrapping, so pressing the chord again works
 * through the queue rather than landing on the same row every time. Null when
 * nothing needs anyone, which the caller says rather than doing nothing.
 */
export function nextNeedingYou(queue: readonly Attention[], currentId: string | null): string | null {
  const eligible = queue.filter((a) => NEEDS_YOU.includes(a.kind) && !a.helper?.snoozedUntil);
  if (!eligible.length) return null;
  const at = currentId ? eligible.findIndex((a) => a.sessionId === currentId) : -1;
  if (at < 0) return eligible[0].sessionId;
  if (eligible.length === 1) return eligible[0].sessionId;
  return eligible[(at + 1) % eligible.length].sessionId;
}

/** How recently a transcript must have been written to count as someone still writing it. */
export const OUTSIDE_WRITER_MS = 30_000;

/**
 * Whether a transcript's last write looks like another process still holding
 * the conversation. A write inside the window by a session Wanigan is running
 * is Wanigan's own and not a warning; one with no live Wanigan writer is.
 */
export function outsideWriter(modifiedAt: number | null, now: number, liveInWanigan: boolean): boolean {
  if (modifiedAt === null || liveInWanigan) return false;
  return now - modifiedAt >= -2_000 && now - modifiedAt <= OUTSIDE_WRITER_MS;
}

/** How long a tab must have been out of sight before returning to it earns a summary. */
export const AWAY_MIN_MS = 2 * 60_000;
