/**
 * Approval timing, inferred from the events around a prompt.
 *
 * The claims under test are the honest ones: a request is paired with the next
 * event for its own tool in its own session and nothing else, an unanswered
 * request is counted as unanswered rather than as slow, and a streak needs the
 * configured number of fast answers in a row with nothing slower in between.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fastStreaks, hourlyCounts, inferDecisions, sessionCounts, type FatigueEvent } from './fatigue.ts';

const ev = (at: number, event: string, toolName: string | null = 'Bash', sessionId = 's1'): FatigueEvent => ({ at, event, toolName, sessionId });

test('a request pairs with the next event for the same tool in the same session', () => {
  const d = inferDecisions([
    ev(1000, 'PermissionRequest', 'Bash'),
    ev(1200, 'PostToolUse', 'Read'),
    ev(1300, 'PostToolUse', 'Bash', 's2'),
    ev(2500, 'PostToolUse', 'Bash'),
  ]);
  assert.equal(d.length, 1);
  assert.equal(d[0].inferredMs, 1500);
  assert.equal(d[0].closedBy, 'PostToolUse');
});

test('denials, failures, abandoned and repeated requests are told apart', () => {
  const d = inferDecisions([
    ev(0, 'PermissionRequest'), ev(400, 'PermissionDenied'),
    ev(1000, 'PermissionRequest', 'Write'), ev(1500, 'PostToolUseFailure', 'Write'),
    ev(2000, 'PermissionRequest', 'Edit'), ev(2100, 'Stop', null),
    ev(3000, 'PermissionRequest', 'Bash'), ev(3100, 'PermissionRequest', 'Bash'), ev(3300, 'PostToolUse', 'Bash'),
  ]);
  assert.deepEqual(d.map((x) => [x.toolName, x.closedBy, x.inferredMs]), [
    ['Bash', 'PermissionDenied', 400],
    ['Write', 'PostToolUseFailure', 500],
    ['Edit', null, null],
    ['Bash', null, null],
    ['Bash', 'PostToolUse', 200],
  ]);
});

test('a request older than the wait window is not paired with a late event', () => {
  const d = inferDecisions([ev(0, 'PermissionRequest'), ev(40 * 60_000, 'PostToolUse')]);
  assert.equal(d[0].inferredMs, null);
});

test('a fast streak needs the run length in a row, and a slow answer resets it', () => {
  const events: FatigueEvent[] = [];
  let t = 0;
  const answer = (ms: number) => { events.push(ev(t, 'PermissionRequest')); events.push(ev(t + ms, 'PostToolUse')); t += 10_000; };
  [500, 800, 900, 700].forEach(answer);
  answer(4000);
  [300, 300, 300, 300, 300, 300].forEach(answer);
  const streaks = fastStreaks(inferDecisions(events));
  assert.equal(streaks.length, 1);
  assert.equal(streaks[0].count, 6);
  assert.deepEqual(fastStreaks(inferDecisions(events), 2000, 7), []);
});

test('per-session and per-hour counts are observed counts, with unanswered kept separate', () => {
  const HOUR = 3_600_000;
  const now = 10 * HOUR + 5;
  const d = inferDecisions([
    ev(9 * HOUR + 1, 'PermissionRequest'), ev(9 * HOUR + 501, 'PostToolUse'),
    ev(10 * HOUR + 1, 'PermissionRequest', 'Write'), ev(10 * HOUR + 3, 'Stop', null),
    ev(10 * HOUR + 2, 'PermissionRequest', 'Bash', 's2'), ev(10 * HOUR + 5002, 'PostToolUse', 'Bash', 's2'),
  ]);
  const hours = hourlyCounts(d, now, 3);
  assert.deepEqual(hours.map((h) => [h.asked, h.answered, h.fast]), [[0, 0, 0], [1, 1, 1], [2, 1, 0]]);
  const sessions = sessionCounts(d);
  assert.deepEqual(sessions.find((s) => s.sessionId === 's1'), { sessionId: 's1', asked: 2, answered: 1, fast: 1, unanswered: 1 });
});
