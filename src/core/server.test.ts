import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { connect } from 'node:net';
import { test } from 'node:test';
import { testCore, waitFor } from './test-support.ts';

test('one connection cannot queue an unbounded number of active core requests', async () => {
  const t = await testCore();
  const hello = t.core.handlers['core.hello'];
  let entered = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  t.core.handlers['core.hello'] = async (params, caller) => { entered++; await held; return hello(params, caller); };
  const calls = Array.from({ length: 256 }, () => t.owner.call('core.hello', {}).then(() => null, (error: Error) => error.message));
  try {
    await waitFor('requests entering the core', () => entered >= 128);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(entered, 128, 'excess work is refused before its handler runs');
    release();
    const outcomes = await Promise.all(calls);
    assert.equal(outcomes.filter((result) => result === null).length, 128);
    assert.ok(outcomes.filter((result) => result !== null).every((result) => /too many.*requests/i.test(result)));
    await t.owner.call('core.hello', {});
  } finally { release(); await Promise.all(calls); await t.close(); }
});

test('the core closes an oversized unfinished authentication line promptly', async () => {
  const t = await testCore();
  const socket = connect(t.core.paths.socket);
  let timer: NodeJS.Timeout | undefined;
  try {
    const closed = new Promise<void>((resolve, reject) => {
      socket.once('close', () => resolve());
      socket.once('error', reject);
      timer = setTimeout(() => reject(new Error('An oversized handshake stayed connected.')), 500);
    });
    socket.write('x'.repeat(8_192));
    await closed;
  } finally { clearTimeout(timer); socket.destroy(); await t.close(); }
});

test('malformed wire requests from either role refuse without taking down the core', () => {
  // A method object with a broken toString used to throw again while logging
  // the first error, escaping the unawaited socket request callback.
  const script = `
    import assert from 'node:assert/strict';
    import { readFileSync } from 'node:fs';
    import { connect } from 'node:net';
    import { createInterface } from 'node:readline';
    import { testCore, tokenOf } from ${JSON.stringify(new URL('./test-support.ts', import.meta.url).href)};
    const t = await testCore();
    try {
      const project = await t.owner.call('projects.add', { path: t.projectDir });
      const session = await t.owner.call('sessions.start', { projectId: project.id, provider: 'claude' });
      for (const token of [readFileSync(t.core.paths.ownerToken, 'utf8'), await tokenOf(t.core, session.id)]) {
        const socket = connect(t.core.paths.socket);
        const lines = createInterface({ input: socket })[Symbol.asyncIterator]();
        try {
          socket.write(JSON.stringify({ token }) + '\\n');
          assert.equal(JSON.parse((await lines.next()).value).ready, true);
          for (const request of [
            { id: 1, method: { toString: 0 } },
            { id: {}, method: 'core.hello' },
            { id: 1.5, method: 'core.hello' },
            { id: 1, method: ['core.hello'] }, null, [],
          ]) {
            socket.write(JSON.stringify(request) + '\\n');
            const response = JSON.parse((await lines.next()).value);
            assert.equal(response.error?.code, 'invalid');
          }
          socket.write(JSON.stringify({ id: 2, method: 'core.hello' }) + '\\n');
          assert.equal(JSON.parse((await lines.next()).value).result.version, (await t.owner.call('core.hello', {})).version);
        } finally { socket.destroy(); }
      }
    } finally { await t.close(); }
  `;
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 10_000, stdio: 'pipe',
  }));
});
