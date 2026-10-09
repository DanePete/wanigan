import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SessionEvent } from './model.ts';
import { groupTurns, turnLength } from './turns.ts';

let id = 0;
const ev = (at: number, event: string, extra: Partial<SessionEvent> = {}): SessionEvent =>
  ({ id: ++id, sessionId: 's', at, event, tool: null, summary: null, path: null, ...extra });

test('events become turns: prompt to stop, with tools, files and permission asks', () => {
  const turns = groupTurns([
    ev(0, 'SessionStart'),
    ev(1000, 'UserPromptSubmit'),
    ev(2000, 'PreToolUse', { tool: 'Read', path: null }),
    ev(3000, 'PreToolUse', { tool: 'Edit', path: '/p/a.ts' }),
    ev(3500, 'PostToolUse', { tool: 'Edit', path: '/p/a.ts' }),
    ev(4000, 'PermissionRequest', { tool: 'Bash' }),
    ev(5000, 'PreToolUse', { tool: 'Write', path: '/p/b.ts' }),
    ev(73_000, 'Stop'),
    ev(80_000, 'UserPromptSubmit'),
    ev(81_000, 'StopFailure'),
    ev(90_000, 'UserPromptSubmit'),
    ev(91_000, 'PreToolUse', { tool: 'Grep' }),
  ]);
  assert.deepEqual(turns.map((t) => [t.n, t.tools, t.files, t.asked, t.endedAt, t.failed]), [
    [0, 0, [], false, 1000, false],
    [1, 3, ['/p/a.ts', '/p/b.ts'], true, 73_000, false],
    [2, 0, [], false, 81_000, true],
    [3, 1, [], false, null, false],
  ]);
  assert.equal(turnLength(turns[1]!.startedAt, turns[1]!.endedAt!), '1m 12s');
});

test('lengths read naturally', () => {
  assert.equal(turnLength(0, 40_000), '40s');
  assert.equal(turnLength(0, 120_000), '2m');
  assert.equal(turnLength(0, 7_500_000), '2h 5m');
});

test('what follows a finished turn, before the next prompt, stays with that turn', () => {
  const turns = groupTurns([
    ev(0, 'SessionStart'),
    ev(1000, 'UserPromptSubmit'),
    ev(2000, 'Stop'),
    ev(62_000, 'Notification', { summary: 'Claude is waiting for your input' }),
    ev(70_000, 'Undo', { summary: 'You undid turn 1: 2 files' }),
    ev(80_000, 'UserPromptSubmit'),
  ]);
  assert.deepEqual(turns.map((t) => [t.n, t.events.map((e) => e.event), t.endedAt]), [
    [0, ['SessionStart'], 1000],
    [1, ['UserPromptSubmit', 'Stop', 'Notification', 'Undo'], 2000],
    [2, ['UserPromptSubmit'], null],
  ]);
});
