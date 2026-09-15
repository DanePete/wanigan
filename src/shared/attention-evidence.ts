/**
 * Two kinds of evidence the attention queue reads from other packages of the
 * helper sweep, and the rules for when each one changes a verdict.
 *
 * The policy gate records observations beside its ledger (policy_signals): a
 * tripwire, a history rewrite it pinned as evidence. Those were visible on the
 * session's timeline and in Settings, and nowhere a person triaging the fleet
 * would look. The review surface decides whether a finished session's diff
 * still needs review. That reached the Fleet chip, the Git view and the Dock
 * badge, but the queue itself still said only "Finished".
 *
 * Both are applied as decorations of a verdict the classifier already reached,
 * so the classifier's own rules and their reasons are left as they were.
 */
import type { Attention, AttentionReason } from './types';

/** How long a recorded signal can still take over a verdict. */
export const SIGNAL_WINDOW_MS = 15 * 60_000;

/** The signal kinds that are about this session and ask a person to look. */
const SIGNAL_WORDS: Record<string, { label: string; because: (rule: string) => string }> = {
  tripwire: {
    label: 'Tripwire',
    because: (rule) => `Wanigan's policy gate recorded a tripwire (${rule}). It is a lead, not containment: at Trusted the call ran, and at Project trust the gate asked first.`,
  },
  'git-rewrite': {
    label: 'History rewritten',
    because: (rule) => `A history rewrite moved or deleted refs (${rule}). Wanigan pinned the commits it would otherwise have lost under refs/wanigan/evidence.`,
  },
};

export type RecordedSignal = { id: number; at: number; kind: string; rule: string; summary: string };

/**
 * The signal that should take over this verdict, or null.
 *
 * Newest first. A permission prompt is left alone, because a person is already
 * being asked and the prompt is the more urgent thing on screen. A signal the
 * operator has already answered, by sending the session a prompt after it, is
 * no longer news.
 */
export function standingSignal(
  verdict: Pick<Attention, 'kind'>,
  signals: readonly RecordedSignal[],
  now: number,
  lastPromptAt: number | null,
): RecordedSignal | null {
  if (verdict.kind === 'permission') return null;
  const sorted = [...signals].sort((a, b) => b.at - a.at || b.id - a.id);
  for (const s of sorted) {
    if (!(s.kind in SIGNAL_WORDS)) continue;
    if (now - s.at > SIGNAL_WINDOW_MS || s.at > now) continue;
    if (lastPromptAt !== null && lastPromptAt > s.at) continue;
    return s;
  }
  return null;
}

/** The verdict a standing signal turns this one into. The original reason is kept in the sentence. */
export function withSignal(verdict: Attention, signal: RecordedSignal, clip: (s: string) => string): Attention {
  const words = SIGNAL_WORDS[signal.kind];
  const reason: AttentionReason = {
    rule: 'policy-signal',
    event: verdict.reason?.event ?? null,
    because: words.because(signal.rule),
  };
  return {
    ...verdict,
    kind: 'error',
    label: words.label,
    since: signal.at,
    transitionId: `signal:${signal.id}`,
    detail: clip(signal.summary),
    reason,
  };
}

export type ReviewState = { needsReview: boolean; label: string; because: string };

/**
 * A finished session whose diff still needs review says so. The kind stays
 * `finished`, so the queue order and notifications are unchanged; the label
 * and reason are what differ. Anything other than a finished verdict is left
 * alone: a session that is asking, failing or still working has a more
 * pressing word than its diff.
 */
export function withReviewState(verdict: Attention, review: ReviewState | null): Attention {
  if (verdict.kind !== 'finished' || !review?.needsReview) return verdict;
  return {
    ...verdict,
    label: review.label,
    reason: {
      rule: 'needs-review',
      event: verdict.reason?.event ?? null,
      because: `${verdict.reason?.because ?? ''} ${review.because}`.trim(),
    },
  };
}
