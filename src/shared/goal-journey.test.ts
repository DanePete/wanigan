import { test } from 'node:test';
import assert from 'node:assert/strict';
import { goalGuidance, goalLocation } from './goal-journey.ts';
import { companionPresence, presenceChanges } from './companion-presence.ts';
import type { DocketNode, Attention } from './types';

const node = (id: string, status: DocketNode['status'], over: Partial<DocketNode> = {}): DocketNode => ({
  id, status, docketId: 'goal', kind: 'implement', title: id, instructions: '', dependsOn: [], claimPath: null,
  providerId: null, model: null, sessionId: null, worktree: null, startedAt: null, endedAt: null, detail: null, deferUntil: null, queued: false, ...over,
});

test('goal navigation round-trips opaque IDs without turning their characters into route fields', () => {
  const goal = 'goal &task=wrong/#雪', task = 'task?&goal=other';
  const query = new URLSearchParams(goalLocation(goal, task).slice(1));
  assert.equal(query.get('goal'), goal); assert.equal(query.get('task'), task); assert.equal([...query].length, 2);
  assert.equal(new URLSearchParams(goalLocation(goal).slice(1)).has('task'), false);
});

test('only the recorded goal outcome produces acceptance, and rejection remains closed', () => {
  const nodes = [node('implement', 'completed'), node('review', 'completed', { kind: 'review' })];
  assert.equal(goalGuidance({ status: 'executing', nodes }).phase, 'waiting');
  for (const status of ['accepted', 'rejected'] as const) {
    const advice = goalGuidance({ status, nodes });
    assert.equal(advice.phase, status); assert.equal(advice.action, undefined);
  }
});

test('failed prerequisites outrank a ready review or another running task', () => {
  const advice = goalGuidance({ status: 'blocked', nodes: [node('running', 'running', { sessionId: 's1' }), node('review', 'ready', { kind: 'review' }), node('failed', 'failed')] });
  assert.equal(advice.nodeId, 'failed'); assert.equal(advice.sessionId, undefined);
});

test('a ready human review is a decision; running work follows only its recorded session', () => {
  assert.equal(goalGuidance({ status: 'review', nodes: [node('review', 'ready', { kind: 'review' })] }).action, 'Review the decision');
  for (const sessionId of ['exact-session', null]) {
    const advice = goalGuidance({ status: 'executing', nodes: [node('work', 'running', { sessionId })] });
    assert.equal(advice.sessionId, sessionId ?? undefined);
    assert.equal(advice.action, sessionId ? 'Follow the session' : 'Inspect the task');
  }
});

test('queued and deferred tasks never read as ready to launch', () => {
  const advice = goalGuidance({ status: 'executing', nodes: [node('queued', 'ready', { queued: true })] });
  assert.equal(advice.phase, 'waiting'); assert.equal(advice.action, 'Inspect the queued task');
  for (const status of ['blocked', 'pending'] as const) {
    const waiting = goalGuidance({ status: 'draft', nodes: [node('wait', status, { deferUntil: Date.now() + 60_000 })] });
    assert.equal(waiting.phase, 'waiting'); assert.equal(waiting.action, undefined);
  }
});

const attention = (sessionId: string, kind: Attention['kind'], transitionId = '1'): Attention => ({ sessionId, kind, transitionId, label: kind, since: 1, tool: null, detail: null });
test('a finished turn still gets its own reaction while another session needs permission', () => {
  const sessions = [{ id: 'a', status: 'running' as const }, { id: 'b', status: 'running' as const }];
  const first = companionPresence(sessions, [attention('a', 'permission')], 'ready');
  const second = companionPresence(sessions, [attention('a', 'permission'), attention('b', 'finished')], 'ready');
  assert.equal(second.signal, 'permission');
  assert.deepEqual(presenceChanges(first, second), { attention: false, completion: true, failure: false });
  assert.deepEqual(presenceChanges(second, second), { attention: false, completion: false, failure: false });
});

test('initial, unavailable and recovered snapshots do not replay reactions; new failures do', () => {
  const sessions = [{ id: 'a', status: 'running' as const }];
  const first = companionPresence(sessions, [], 'ready');
  const failed = companionPresence(sessions, [attention('a', 'error')], 'ready');
  const unavailable = companionPresence(sessions, [], 'unavailable');
  for (const previous of [null, unavailable]) assert.deepEqual(presenceChanges(previous, failed), { attention: false, completion: false, failure: false });
  assert.deepEqual(presenceChanges(first, failed), { attention: true, completion: false, failure: true });
  assert.deepEqual(presenceChanges(failed, unavailable), { attention: false, completion: false, failure: false });
});
