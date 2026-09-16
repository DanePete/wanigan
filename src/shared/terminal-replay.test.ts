import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TerminalReplay } from './terminal-replay.ts';

test('snapshot broadcasts appear once, and post-snapshot bytes survive asynchronous parsing', () => {
  const writes: string[] = [];
  let finish: (() => void) | undefined;
  const replay = new TerminalReplay((text, parsed) => { writes.push(text); if (parsed) finish = parsed; });
  replay.feed('already in snapshot');
  replay.local('session exited');
  replay.snapshot('snapshot contains earlier broadcasts');
  replay.feed('arrived after snapshot');
  assert.deepEqual(writes, ['snapshot contains earlier broadcasts', 'arrived after snapshot']);
  assert.equal(replay.suppressInput, true, 'device replies remain suppressed while the snapshot parses');
  assert.ok(finish);
  finish();
  assert.equal(replay.suppressInput, false);
  replay.feed('later live output');
  assert.deepEqual(writes, ['snapshot contains earlier broadcasts', 'arrived after snapshot', 'session exited', 'later live output']);
});

test('empty and failed snapshots release both live output and local exit notices', () => {
  for (const fail of [false, true]) {
    const writes: string[] = [];
    const replay = new TerminalReplay(text => writes.push(text));
    replay.local('exit');
    if (fail) replay.failed(); else replay.snapshot('');
    replay.feed('live');
    assert.equal(replay.suppressInput, false);
    assert.deepEqual(writes, ['exit', 'live']);
  }
});
