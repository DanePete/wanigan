import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blankedEnv, mergeUnknownKeys, parseStateText, runtimeAlteringNames } from './state-file.ts';

test('a state file that does not parse is an error with the parser’s words, never an empty state', () => {
  assert.deepEqual(parseStateText('{"schemaVersion":1,"servers":{}}'), { ok: true, value: { schemaVersion: 1, servers: {} } });
  const broken = parseStateText('{"schemaVersion":1,');
  assert.equal(broken.ok, false);
  assert.match(broken.ok ? '' : broken.error, /JSON|Unexpected|end/i);
  assert.deepEqual(parseStateText('[]'), { ok: false, error: 'The file is JSON, but not an object.' });
  assert.equal(parseStateText('').ok, false);
});

test('unknown keys survive a rewrite, at the top and inside surviving entries', () => {
  const existing = {
    schemaVersion: 1, writtenBy: 'wanigan 0.2', servers: {
      a: { sha256: 'old', approved: {}, reviewNote: 'kept by hand' },
      b: { sha256: 'b', approved: {} },
    },
  };
  const next = { schemaVersion: 1, servers: { a: { sha256: 'new', approved: {} } } };
  assert.deepEqual(mergeUnknownKeys(existing, next, 'servers'), {
    schemaVersion: 1, writtenBy: 'wanigan 0.2',
    servers: { a: { reviewNote: 'kept by hand', sha256: 'new', approved: {} } },
  });
});

test('a key the new state sets wins over the old value', () => {
  assert.deepEqual(mergeUnknownKeys({ schemaVersion: 1, packs: {} }, { schemaVersion: 1, packs: { x: { enabled: false } } }, 'packs'),
    { schemaVersion: 1, packs: { x: { enabled: false } } });
});

test('runtime-altering variables are found by name, DYLD_* included, and blanked without copying a value', () => {
  const env = { PATH: '/bin', NODE_OPTIONS: '--require /tmp/x.js', DYLD_INSERT_LIBRARIES: '/tmp/x.dylib', PYTHONPATH: '/p', HOME: '/h', RUBYOPT: undefined };
  assert.deepEqual(runtimeAlteringNames(env), ['DYLD_INSERT_LIBRARIES', 'NODE_OPTIONS', 'PYTHONPATH']);
  assert.deepEqual(blankedEnv(runtimeAlteringNames(env)), { DYLD_INSERT_LIBRARIES: '', NODE_OPTIONS: '', PYTHONPATH: '' });
  assert.deepEqual(runtimeAlteringNames({ PATH: '/bin' }), []);
});
