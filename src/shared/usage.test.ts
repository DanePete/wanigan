import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseResetAt, parseUsage } from './usage.ts';

const REAL = `Permission allow rule (/Users/x/.claude/settings.json): Bash(grep …) has a wildcard before the rest of the command.
You are currently using your subscription to power your Claude Code usage

Current session: 89% used · resets Oct 6 at 11:50pm (America/Chicago)
Current week (all models): 35% used · resets Oct 12 at 2pm (America/Chicago)
Current week (Fable): 0% used · resets Oct 12 at 2pm (America/Chicago)

Last 24h · 753 requests · 1 session
  100% of your usage came from subagent-heavy sessions`;

test('a real /usage reply reads as three windows, with resets in the zone it named', () => {
  const now = Date.UTC(2026, 9, 7, 2, 0); // 9pm in Chicago on Oct 6
  const u = parseUsage(REAL, now);
  assert.equal(u.state, 'ok');
  assert.deepEqual(u.windows.map((w) => [w.kind, w.scope, w.usedPercent]), [['session', null, 89], ['week', null, 35], ['week', 'Fable', 0]]);
  assert.equal(new Date(u.windows[0]!.resetsAt!).toISOString(), '2026-10-07T04:50:00.000Z', '11:50pm Chicago is 04:50 UTC');
  assert.equal(new Date(u.windows[1]!.resetsAt!).toISOString(), '2026-10-12T19:00:00.000Z', 'on the hour, without minutes');
});

test('a window with nothing used has no reset clause and still reads', () => {
  const u = parseUsage('Current session: 0% used\nCurrent week (all models): 0% used', 0);
  assert.equal(u.state, 'ok');
  assert.deepEqual(u.windows.map((w) => [w.usedPercent, w.resetsAt]), [[0, null], [0, null]]);
});

test('signed out and unreadable are said, never turned into numbers', () => {
  assert.equal(parseUsage('Not logged in · Please run /login').state, 'signed-out');
  const odd = parseUsage('Something completely different');
  assert.equal(odd.state, 'unreadable');
  assert.match(odd.note ?? '', /Something completely different/);
});

test('a reset with no zone has no honest instant', () => {
  assert.equal(parseResetAt('Oct 6 at 11:50pm'), null);
});
