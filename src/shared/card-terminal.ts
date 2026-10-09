// Which terminal a card's drawer offers: the live session on it, or a new one.
// A card goes back to Ready (sent back, reopened) while its agent may still be
// running; the core refuses a second session on it, so the drawer opens the
// one that is there.
import { LIVE_STATES, type CardSummary } from './model.ts';

export type CardTerminal = { kind: 'open'; sessionId: string } | { kind: 'start' } | { kind: 'none' };

export function cardTerminal(card: Pick<CardSummary, 'status' | 'live' | 'holder'>): CardTerminal {
  if (card.status !== 'inbox' && card.status !== 'ready' && card.status !== 'working') return { kind: 'none' };
  // The session holding the claim may be one attached to another card (an
  // agent can claim a second card): follow the claim, then what is attached.
  const holder = card.holder && LIVE_STATES.has(card.holder.state) ? card.holder.sessionId : null;
  const sessionId = holder ?? card.live?.sessionId ?? null;
  if (sessionId) return { kind: 'open', sessionId };
  return card.status === 'working' ? { kind: 'none' } : { kind: 'start' };
}
