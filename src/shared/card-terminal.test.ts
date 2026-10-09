import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cardTerminal } from './card-terminal.ts';
import type { CardSummary } from './model.ts';

const card = (over: Partial<Pick<CardSummary, 'status' | 'live' | 'holder'>>): Pick<CardSummary, 'status' | 'live' | 'holder'> =>
  ({ status: 'ready', live: null, holder: null, ...over });
const live = { sessionId: 's1', state: 'waiting' as const, provider: 'claude' as const };

test('a card with no session on it offers to start one while it is open for work', () => {
  assert.deepEqual(cardTerminal(card({ status: 'inbox' })), { kind: 'start' });
  assert.deepEqual(cardTerminal(card({ status: 'ready' })), { kind: 'start' });
});

test('a card sent back or reopened while its agent still runs opens that terminal, never a second start', () => {
  // Found in the real-app scenario run: Reopen moved the card to Ready while its
  // Claude session was live, and the drawer offered "Start a session", which the
  // core refuses ("already has a live session") behind a dialog with a blank card.
  assert.deepEqual(cardTerminal(card({ status: 'ready', live })), { kind: 'open', sessionId: 's1' });
  assert.deepEqual(cardTerminal(card({ status: 'inbox', live })), { kind: 'open', sessionId: 's1' });
});

test('a Working card follows its claim, then whatever is live on it', () => {
  const holder = { sessionId: 'h1', title: 'Other card', provider: 'codex' as const, state: 'working' as const };
  assert.deepEqual(cardTerminal(card({ status: 'working', live, holder })), { kind: 'open', sessionId: 'h1' });
  assert.deepEqual(cardTerminal(card({ status: 'working', live, holder: { ...holder, state: 'ended' } })), { kind: 'open', sessionId: 's1' });
  assert.deepEqual(cardTerminal(card({ status: 'working', holder: { ...holder, state: 'ended' } })), { kind: 'none' });
});

test('review and done offer no terminal of their own', () => {
  assert.deepEqual(cardTerminal(card({ status: 'review', live })), { kind: 'none' });
  assert.deepEqual(cardTerminal(card({ status: 'done' })), { kind: 'none' });
});
