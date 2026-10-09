import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { corePaths } from './paths.ts';

test('a short data folder keeps its sockets; a long one gets a short folder in the user’s own temp, never a shared /tmp', () => {
  const short = corePaths('/Users/x/Library/Application Support/Wanigan 2');
  assert.equal(short.socket, '/Users/x/Library/Application Support/Wanigan 2/core.sock');

  const long = corePaths(join('/Users/someone', 'a'.repeat(120)));
  assert.ok(long.socket.startsWith(`${tmpdir()}/wanigan-`) || long.socket.startsWith('/tmp/wanigan-'), long.socket);
  if (join(tmpdir(), 'wanigan-000000000000', 'hooks.sock').length <= 100) assert.ok(long.socket.startsWith(tmpdir()), 'the per-user temp folder when it fits');
  assert.ok(long.hookSocket.length <= 104);
  assert.equal(corePaths(join('/Users/someone', 'a'.repeat(120))).socket, long.socket, 'the same folder every time');
});
