// Claude sessions started on a card carry its key and title as their name.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { testCore, waitFor } from './test-support.ts';

test('a Claude session on a card is named after it; a one-off is not', async () => {
  const t = await testCore();
  try {
    const { owner, core } = t;
    const project = await owner.call('projects.add', { path: t.projectDir });
    const args = (id: string) => waitFor('args', () => core.sessions.replay(id).replay.match(/ARGS=(.*)/)?.[1]);

    const card = await owner.call('cards.create', { projectId: project.id, type: 'bug', title: 'Coupon field accepts expired codes' });
    const named = await owner.call('sessions.start', { projectId: project.id, provider: 'claude', cardId: card.id });
    assert.match(await args(named.id), new RegExp(`--name ${card.key} Coupon field accepts expired codes\\s*$`));
    await owner.call('sessions.stop', { id: named.id });

    const long = await owner.call('cards.create', { projectId: project.id, type: 'task', title: 'Move every product image, thumbnail and zoom tile to the CDN, then purge the old bucket' });
    const clipped = await owner.call('sessions.start', { projectId: project.id, provider: 'claude', cardId: long.id });
    const name = (await args(clipped.id)).split('--name ')[1]?.trim() ?? '';
    assert.equal(name.length, 60, 'clipped to read in a picker');
    assert.ok(name.startsWith(`${long.key} Move every product image`) && name.endsWith('…'));
    await owner.call('sessions.stop', { id: clipped.id });

    const oneOff = await owner.call('sessions.start', { projectId: project.id, provider: 'claude' });
    assert.doesNotMatch(await args(oneOff.id), /--name/);
    await owner.call('sessions.stop', { id: oneOff.id });
  } finally {
    await t.close();
  }
});
