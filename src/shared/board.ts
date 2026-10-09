// Board rules. Pure functions; the core enforces them, the UI uses them to decide
// what to offer, and the tests pin them.
import type { Card, CardStatus, Priority } from './model.ts';

/** A claim lasts this long unless its session is still alive and reporting. */
export const LEASE_MS = 30 * 60_000;

/** A short project key from its name: "Northstar Storefront" → "NS", "orbit-api" → "OA". */
export function projectKeyFrom(name: string, taken: ReadonlySet<string>): string {
  const words = name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  let base = words.length >= 2
    ? words.slice(0, 3).map((w) => w[0]).join('')
    : (words[0] ?? 'P').slice(0, 3);
  base = base.toUpperCase().replace(/[^A-Z0-9]/g, '') || 'P';
  if (/^[0-9]/.test(base)) base = `P${base}`;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export const isValidProjectKey = (key: string): boolean => /^[A-Z][A-Z0-9]{0,5}$/.test(key);

export const cardKey = (projectKey: string, seq: number): string => `${projectKey}-${seq}`;

/** Rank for a card dropped between two neighbours (either may be missing). */
export function rankBetween(before: number | null, after: number | null): number {
  if (before === null && after === null) return 1_000;
  if (before === null) return (after as number) - 1_000;
  if (after === null) return before + 1_000;
  return (before + after) / 2;
}

export type MoveRefusal = { code: 'refused'; message: string };

/**
 * Whether the owner may drag a card to a column. Two moves are deliberately not
 * plain drags: putting work into Working without a session to do it (that is
 * "start a session"), and pulling a card out of Done (that is "reopen", which
 * asks what is still wrong).
 */
export function checkOwnerMove(card: Pick<Card, 'status'>, to: CardStatus, evidenceCount = 0): MoveRefusal | null {
  if (card.status === to) return null;
  // There is no restore: archiving is final, so the refusal offers nothing else.
  if (card.status === 'archived') return refused('This card is archived, and archiving is final. File a new card instead.');
  if (to === 'working') return refused('Work starts when a session takes the card. Start a session on it instead.');
  if (card.status === 'done' && to !== 'archived') return refused('Reopen it and say what is still wrong.');
  if (to === 'review' && evidenceCount < 1) {
    return refused('Review needs evidence: add a file, a link or a note that shows the work is done. Or move it to Done if you have checked it yourself.');
  }
  return null;
}

/** Ranks closer than this can no longer be split; the column is renumbered first. */
export const RANK_EPSILON = 1e-6;

/** Whether a session may claim a card. */
export function checkClaim(card: Pick<Card, 'status' | 'claim'>, sessionId: string, now: number, byOwner = false): MoveRefusal | null {
  if (card.status === 'done' || card.status === 'archived') return refused(`This card is ${card.status}.`);
  // The Inbox is the owner's to triage: an agent works only what was accepted.
  // A session the owner starts on an Inbox card is the owner accepting it.
  if (card.status === 'inbox' && !byOwner) return refused('This card is in the Inbox. The owner accepts it to Ready before anyone works on it.');
  if (card.status === 'review') return refused('This card is in review. Wait for the owner, or ask them to send it back.');
  if (card.claim && card.claim.sessionId !== sessionId && card.claim.expiresAt > now) {
    return refused('Another session holds this card.');
  }
  return null;
}

/** Whether a session may submit a card for review. */
export function checkSubmit(
  card: Pick<Card, 'status' | 'claim'>, sessionId: string, evidenceCount: number, now: number,
): MoveRefusal | null {
  if (card.status !== 'working') return refused(`Only a card in Working can go to review; this one is ${card.status}.`);
  if (!card.claim || card.claim.sessionId !== sessionId || card.claim.expiresAt <= now) {
    return refused('Claim the card before submitting it.');
  }
  if (evidenceCount < 1) return refused('Review needs evidence: a file, a link or a note that shows the work is done.');
  return null;
}

export const PRIORITY_LABEL: Record<Priority, string> = { 0: 'P0', 1: 'P1', 2: 'P2', 3: 'P3' };

function refused(message: string): MoveRefusal {
  return { code: 'refused', message };
}
