import assert from 'node:assert/strict';
import { test } from 'node:test';
import { testCore } from './test-support.ts';

const invalid = (error: Error & { code?: string }) => error.code === 'invalid';

test('a project update refuses atomically, preserving settings and activity when one field is invalid', async () => {
  const t = await testCore();
  try {
    const project = await t.owner.call('projects.add', { path: t.projectDir, key: 'TST' });
    const before = t.core.db.prepare('SELECT * FROM projects WHERE id = ?').get(project.id);
    const activity = await t.owner.call('activity.list', { projectId: project.id });
    await assert.rejects(t.owner.call('projects.update', {
      id: project.id, name: 'Changed', jev: 'accept', isolate: true, setupCommand: 'echo changed', key: 'bad key',
    }), invalid);
    assert.deepEqual(t.core.db.prepare('SELECT * FROM projects WHERE id = ?').get(project.id), before);
    assert.deepEqual(await t.owner.call('activity.list', { projectId: project.id }), activity);
  } finally { await t.close(); }
});

test('malformed boolean input cannot change settings, tick criteria, or turn a preview into a write', async () => {
  const t = await testCore();
  try {
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    const card = await t.owner.call('cards.create', { projectId: project.id, type: 'task', title: 'Unticked' });
    await t.owner.call('criteria.add', { cardId: card.id, text: 'Verify it' });
    const criterion = (await t.owner.call('cards.get', { id: card.id })).criteria[0]!;
    await assert.rejects(t.owner.call('criteria.update', { id: criterion.id, done: 'false' as never }), invalid);
    await assert.rejects(t.owner.call('projects.update', { id: project.id, isolate: 'false' as never }), invalid);
    assert.equal((await t.owner.call('cards.get', { id: card.id })).criteria[0]?.done, false);
    assert.equal((await t.owner.call('projects.list', {})).find((p) => p.id === project.id)?.isolate, false);
  } finally { await t.close(); }
});

test('an invalid preview flag is refused before any writer is reached', async () => {
  const t = await testCore();
  try {
    const calls: string[] = [];
    // A malformed preview must be refused before reaching a writer, even with a valid id.
    t.core.mcp.remove = async () => { calls.push('remove'); throw new Error('writer reached'); };
    await assert.rejects(t.owner.call('mcp.remove', { id: 'known', preview: 'true' as never }), invalid);
    assert.deepEqual(calls, []);
  } finally { await t.close(); }
});

for (const operation of ['claim', 'heartbeat', 'release', 'submit', 'approve'] as const) {
  test(`${operation}: refusing an oversized note leaves the card and activity unchanged`, async () => {
    const t = await testCore();
    try {
      const project = await t.owner.call('projects.add', { path: t.projectDir });
      const card = await t.owner.call('cards.create', { projectId: project.id, type: 'task', title: 'Atomic note' });
      const session = await t.owner.call('sessions.start', { projectId: project.id, provider: 'shell' });
      if (operation !== 'claim' && operation !== 'approve') t.core.board.claim(session.id, card.id);
      if (operation === 'approve') {
        await t.owner.call('cards.evidence', { id: card.id, evidence: { kind: 'note', value: 'Verified' } });
        await t.owner.call('cards.move', { id: card.id, status: 'review' });
      }
      const before = await t.owner.call('cards.get', { id: card.id });
      const long = 'x'.repeat(20_001);
      assert.throws(() => {
        if (operation === 'claim') t.core.board.claim(session.id, card.id, long);
        if (operation === 'heartbeat') t.core.board.heartbeat(session.id, card.id, long);
        if (operation === 'release') t.core.board.release('owner', card.id, long);
        if (operation === 'submit') t.core.board.submit(session.id, card.id, [{ kind: 'note', value: 'Verified' }], long);
        if (operation === 'approve') t.core.board.approve(card.id, long);
      }, /at most|too long|characters/);
      assert.deepEqual(await t.owner.call('cards.get', { id: card.id }), before);
    } finally { await t.close(); }
  });
}
