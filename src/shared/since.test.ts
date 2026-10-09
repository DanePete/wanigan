import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Activity } from './model.ts';
import { sinceSummary } from './since.ts';

let nextId = 1;
const act = (verb: string, at: number, more: Partial<Activity> = {}): Activity =>
  ({ id: nextId++, projectId: 'p', cardId: null, sessionId: null, actor: 'session:s1', verb, detail: null, at, ...more });

test('what agents did after a moment, counted by card, by session, or by question', () => {
  const activity = [
    act('submitted for review', 50, { cardId: 'c1' }),
    act('submitted for review', 40, { cardId: 'c1' }),
    act('submitted for review', 30, { cardId: 'c2' }),
    act('asked', 29, { cardId: 'c1' }),
    act('asked', 28, { cardId: 'c1' }),
    act('failed', 27, { sessionId: 's1', cardId: 'c3' }),
    act('failed', 26, { sessionId: 's1', cardId: 'c3' }),
    act('created', 25, { cardId: 'c4', actor: 'owner' }),
    act('claimed', 5, { cardId: 'c5' }),
  ].sort((a, b) => b.at - a.at);
  const s = sinceSummary(activity, 10, 300);
  assert.equal(s.partial, false);
  assert.deepEqual(s.groups.map((g) => [g.short, g.long]), [
    ['2 to review', '2 cards went to review'],
    ['2 questions', '2 questions for you'],
    ['1 failed', '1 session failed'],
  ], 'a card sent twice is one card; the owner’s own work and older things are left out');
  assert.deepEqual(s.groups[0]?.cardIds, ['c1', 'c2']);
});

test('when the activity read was cut short, counts are floors and say so', () => {
  const activity = [act('claimed', 30, { cardId: 'a' }), act('claimed', 20, { cardId: 'b' })];
  const cut = sinceSummary(activity, 10, 2);
  assert.equal(cut.partial, true);
  assert.deepEqual(cut.groups.map((g) => [g.short, g.long]), [['2+ claimed', 'At least 2 cards claimed']]);
  // Full but reaching back past the moment: nothing is missing.
  assert.equal(sinceSummary([...activity, act('claimed', 5, { cardId: 'c' })], 10, 3).partial, false);
});

test('nothing new is nothing to show', () => {
  assert.deepEqual(sinceSummary([act('claimed', 5, { cardId: 'a' })], 10, 300).groups, []);
  assert.deepEqual(sinceSummary([], 10, 300), { groups: [], partial: false });
});
