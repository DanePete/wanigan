// A failed or interrupted session stops asking for attention once its
// conversation is carried on. Found in the real-app scenario run: after
// Resume in Needs you, the old row stayed, offering a Resume the core then
// refuses ("already running in another session").
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { savedConversation, testCore, waitFor } from './test-support.ts';

const standIn = (provider: string) => provider === 'claude'
  ? { file: '/bin/sh', args: ['-c', 'echo ready; while IFS= read -r line; do case "$line" in *die*) exit 3 ;; esac; done', 'fake-claude'] }
  : { file: '/bin/sh', args: ['-i'] };

test('a failed session leaves Needs you once its conversation is resumed', async () => {
  const t = await testCore({ launcher: standIn });
  try {
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    const first = await t.owner.call('sessions.start', { projectId: project.id, provider: 'claude' });
    await waitFor('ready', () => t.core.sessions.replay(first.id).replay.includes('ready'));
    savedConversation(join(t.dir, 'home'), first);
    await t.owner.call('sessions.input', { id: first.id, data: 'die\r' });
    await waitFor('failed', async () => (await t.owner.call('sessions.get', { id: first.id })).session.state === 'failed');
    const before = (await t.owner.call('needs.list', {})).filter((n) => n.sessionId === first.id);
    assert.deepEqual(before.map((n) => [n.kind, n.resumable]), [['failed', true]]);

    const resumed = await t.owner.call('sessions.resume', { id: first.id });
    assert.equal(resumed.conversationId, first.conversationId);
    const after = (await t.owner.call('needs.list', {})).filter((n) => n.sessionId === first.id);
    assert.deepEqual(after, [], 'the old row is gone: its conversation runs on in the new session');

    // And when the resumed one fails in turn, it is that one Needs you raises, once.
    await t.owner.call('sessions.input', { id: resumed.id, data: 'die\r' });
    await waitFor('the resumed one failed', async () => (await t.owner.call('sessions.get', { id: resumed.id })).session.state === 'failed');
    const now = (await t.owner.call('needs.list', {})).filter((n) => n.kind === 'failed');
    assert.deepEqual(now.map((n) => n.sessionId), [resumed.id]);
  } finally {
    await t.close();
  }
});
