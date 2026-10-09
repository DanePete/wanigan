// A PTY has one size. Watching says what it is; only fitting it changes it,
// and a change is announced so anything only watching can follow.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { testCore, waitFor } from './test-support.ts';

test('watching a session gives its PTY size, and a real resize is announced once', async () => {
  const t = await testCore();
  try {
    const { owner } = t;
    const project = await owner.call('projects.add', { path: t.projectDir });
    const session = await owner.call('sessions.start', { projectId: project.id, provider: 'shell', cols: 100, rows: 30 });
    const sizes: unknown[] = [];
    const off = owner.on((event, data) => { if (event === 'pty.size') sizes.push(data); });

    const watched = await owner.call('sessions.watch', { id: session.id });
    assert.deepEqual([watched.cols, watched.rows], [100, 30]);

    await owner.call('sessions.resize', { id: session.id, cols: 90, rows: 25 });
    await waitFor('the size event', () => sizes.length === 1);
    assert.deepEqual(sizes[0], { sessionId: session.id, cols: 90, rows: 25 });
    const again = await owner.call('sessions.watch', { id: session.id });
    assert.deepEqual([again.cols, again.rows], [90, 25]);

    // The same size again is not news.
    await owner.call('sessions.resize', { id: session.id, cols: 90, rows: 25 });
    await owner.call('sessions.unwatch', { id: session.id });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(sizes.length, 1);
    off();

    await owner.call('sessions.stop', { id: session.id });
    await waitFor('ended', async () => (await owner.call('sessions.get', { id: session.id })).session.endedAt !== null);
    const ended = await owner.call('sessions.watch', { id: session.id });
    assert.deepEqual([ended.cols, ended.rows], [null, null], 'an ended session has no PTY to measure');
  } finally {
    await t.close();
  }
});
