/**
 * When to say a conversation is filling up, and what may be said about it.
 *
 * The orb already crowds as context fills, from about seventy percent, and
 * `contextPressure` in orb-story.ts decides that. Crowding is ambient and free.
 * A sentence is not: it asks somebody mid-turn to read it, so it comes later,
 * once, and only when every number in it is one Wanigan actually measured.
 *
 * Every refusal `contextPressure` makes is inherited here rather than restated,
 * because the two must never disagree — an orb performing pressure while the
 * sentence stays silent is a bug a reader would have to run the app to find,
 * and the reverse is a claim about somebody's machine with no measurement
 * behind it.
 */
import { contextPressure, type ContextReading } from './orb-story.ts';

/**
 * Suggest at this much of the window, and stop suggesting below the lower one.
 *
 * Two numbers, not one. A single threshold sits exactly where a streaming turn
 * crosses back and forth, so the message would appear and vanish while
 * somebody was reading it. The band is wide enough that a compaction, or simply
 * a shorter turn, genuinely clears it.
 */
export const SUGGEST_AT = 0.85;
export const SETTLE_BELOW = 0.78;

export type HandoverState = 'none' | 'suggest';

/**
 * Whether to offer a handover, given what is on screen now.
 *
 * `showing` is what the surface is already displaying, which is what makes the
 * band hysteresis rather than two thresholds: once suggested, it keeps
 * suggesting until the conversation drops clear, not until it dips.
 */
export function handoverState(
  reading: ContextReading | undefined,
  now: number,
  showing: boolean,
): HandoverState {
  // Inherited wholesale: an estimated window, a stale reading and a reading
  // from the future each produce no pressure, and so may produce no sentence.
  if (contextPressure(reading, now) <= 0) return 'none';
  const ratio = reading?.ratio ?? null;
  if (ratio === null) return 'none';
  if (showing) return ratio >= SETTLE_BELOW ? 'suggest' : 'none';
  return ratio >= SUGGEST_AT ? 'suggest' : 'none';
}

/**
 * What the bubble says.
 *
 * The percentage is the one that was read, rounded for a person and never
 * rounded up into a cleaner number. When the transcript could not be matched to
 * this exact conversation the sentence says so in the same breath: a percentage
 * attributed to the wrong conversation is worse than no percentage, and
 * `useContextStory` already knows the difference.
 */
export function handoverMessage(reading: ContextReading, matched = true): string {
  const percent = Math.floor((reading.ratio ?? 0) * 100);
  const caveat = matched ? '' : ' — though Wanigan could not confirm this reading belongs to this conversation';
  return `This conversation is at ${percent}% of its window${caveat}.`;
}

/** The invitation, kept separate so a surface can show it without the number. */
export const HANDOVER_INVITATION = 'Want me to carry the work into a fresh one?';

/**
 * The prompt sent to the agent, asking for something the next session can use.
 *
 * Deliberately asks for the work rather than the conversation: a summary of
 * what was said is of little use to a session that cannot see what was said,
 * while the state of the task, the decisions and what is next are exactly what
 * a new conversation needs to keep going.
 */
export const HANDOVER_PROMPT =
  'Write a handover note for a fresh session that cannot see this conversation. '
  + 'Cover what we are working on, what has been decided and why, what is done, '
  + 'and what the next step is. Be specific about files and names. '
  + 'Write only the note.';

/** What a new session is opened with, once the agent has answered. */
export function handoverSeed(note: string): string {
  return `Continuing earlier work. Handover note from the previous session:\n\n${note.trim()}`;
}
