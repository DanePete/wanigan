import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Need, Session, SessionState } from './model.ts';
import { pickWatched, topNeeds } from './watch.ts';

const session = (id: string, startedAt: number, extra: Partial<Session> = {}): Session => ({
  id, projectId: 'p', cardId: null, cardKey: null, provider: 'claude', accountId: null, title: id, state: 'working' as SessionState,
  activity: null, pid: 1, exitCode: null, conversationId: null, model: null, effort: null, cwd: null, startedAt, endedAt: null,
  lastEventAt: null, limit: null, remote: false, transcriptPath: null, ...extra,
});
const need = (kind: Need['kind'], sessionId: string | null, since = 1): Need => ({
  kind, since, sessionId, projectId: 'p', projectName: 'P', projectKey: 'P', cardId: null, cardKey: null, provider: null, title: kind, detail: null,
});
const ids = (list: Session[]): string[] => list.map((s) => s.id);

test('with nothing pinned, the sessions that need you most are watched, then the most recently active', () => {
  const sessions = [
    session('a', 1, { lastEventAt: 900 }), session('b', 2, { lastEventAt: 100 }), session('c', 3), session('d', 4, { lastEventAt: 50 }),
    session('e', 5, { lastEventAt: 800 }), session('f', 6, { lastEventAt: 10 }),
  ];
  const needs = [need('waiting', 'b'), need('permission', 'd'), need('review', null), need('limit', 'f')];
  const pick = pickWatched(sessions, needs, []);
  // d (permission), f (limit), b (finished a turn), then a, the most recently active of the rest.
  assert.deepEqual(ids(pick.shown), ['a', 'b', 'd', 'f'], 'shown in the order they started');
  assert.equal(pick.more, 2);
  assert.equal(pick.pinned, false);
});

test('a session with no events counts as active when it started', () => {
  const pick = pickWatched([session('old', 1, { lastEventAt: 5 }), session('fresh', 10)], [], [], null, 1);
  assert.deepEqual(ids(pick.shown), ['fresh']);
  assert.equal(pick.more, 1);
});

test('pins choose what is watched, in pin order, and only while they are live', () => {
  const sessions = [session('a', 1), session('b', 2), session('c', 3), session('gone', 4, { state: 'ended', endedAt: 9 })];
  const pick = pickWatched(sessions, [need('permission', 'a')], ['c', 'gone', 'b', 'c']);
  assert.deepEqual(ids(pick.shown), ['c', 'b']);
  assert.equal(pick.more, 1, 'a is running and not shown, even though it needs you');
  assert.equal(pick.pinned, true);

  const allGone = pickWatched(sessions, [], ['gone']);
  assert.equal(allGone.pinned, false, 'pins that ended fall back to the ranking');
  assert.deepEqual(ids(allGone.shown), ['a', 'b', 'c']);
  assert.equal(allGone.more, 0);
});

test('never more than four, pinned or not', () => {
  const sessions = ['a', 'b', 'c', 'd', 'e'].map((id, i) => session(id, i));
  assert.equal(pickWatched(sessions, [], ['a', 'b', 'c', 'd', 'e']).shown.length, 4);
  assert.equal(pickWatched(sessions, [], []).shown.length, 4);
  assert.equal(pickWatched(sessions, [], []).more, 1);
});

test('the session being typed into stays on screen when others outrank it', () => {
  const sessions = ['a', 'b', 'c', 'd', 'e'].map((id, i) => session(id, i, { lastEventAt: 100 - i }));
  assert.deepEqual(ids(pickWatched(sessions, [], []).shown), ['a', 'b', 'c', 'd']);
  const needs = [need('permission', 'e')];
  assert.deepEqual(ids(pickWatched(sessions, needs, []).shown), ['a', 'b', 'c', 'e'], 'e needs you, so d makes way');
  assert.deepEqual(ids(pickWatched(sessions, needs, [], 'd').shown), ['a', 'b', 'd', 'e'], 'unless d is being typed into');
  assert.deepEqual(ids(pickWatched(sessions, needs, [], 'zz').shown), ['a', 'b', 'c', 'e'], 'a session that is not running is not kept');
});

test('each session is marked with its most urgent need', () => {
  const top = topNeeds([need('waiting', 'a', 1), need('question', 'a', 2), need('permission', 'b', 3), need('review', null, 1)]);
  assert.deepEqual([...top], [['b', 'permission'], ['a', 'question']]);
});
