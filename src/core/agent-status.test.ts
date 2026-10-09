// `wanigan status` tells an agent what the owner asked of a card sent back or
// reopened. Found in the real-app scenario run: a Claude session told to read
// the note with `wanigan status` saw only "(sent back, reopened)" and asked the
// owner to paste the note, which lived only in the card's comments.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { testCore, waitFor } from './test-support.ts';

test('wanigan status carries the owner’s send-back note, then what is still wrong after a reopen', async () => {
  const t = await testCore();
  try {
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    const card = await t.owner.call('cards.create', { projectId: project.id, type: 'bug', title: 'Cart subtotal ignores quantity', status: 'ready' });
    const s = await t.owner.call('sessions.start', { projectId: project.id, provider: 'shell', cardId: card.id });
    const screen = () => t.core.sessions.replay(s.id).replay;
    const type = (line: string) => t.owner.call('sessions.input', { id: s.id, data: `${line}\n` });
    const runs = (marker: string) => waitFor(marker, () => {
      const after = screen().split(marker).length > 2 ? screen().slice(screen().lastIndexOf(marker)) : '';
      return /Ready is empty|Top of Ready/.test(after) ? after : null;
    });

    await type(`wanigan claim ${card.key} && wanigan review ${card.key} --evidence "npm test: 4 pass" --note "fixed"`);
    await waitFor('in review', async () => (await t.owner.call('cards.get', { id: card.id })).status === 'review');
    await t.owner.call('cards.sendBack', { id: card.id, note: 'Also test a negative quantity.' });
    await type('echo ==one==; wanigan status');
    const sentBack = await runs('==one==');
    assert.match(sentBack, /Sent back to you[\s\S]*The owner: “Also test a negative quantity\.”/);

    await type(`wanigan claim ${card.key} && wanigan review ${card.key} --evidence "npm test: 5 pass" --note "negative tested"`);
    await waitFor('in review again', async () => (await t.owner.call('cards.get', { id: card.id })).status === 'review');
    await t.owner.call('cards.approve', { id: card.id });
    await t.owner.call('cards.reopen', { id: card.id, stillWrong: 'addItem(cart, product, 0) still adds a line' });
    await type('echo ==two==; wanigan status');
    const reopened = await runs('==two==');
    assert.match(reopened, /Your card:[\s\S]*Still wrong: “addItem\(cart, product, 0\) still adds a line”/);
    assert.doesNotMatch(reopened, /The owner: “Also test/, 'a note already dealt with is not repeated');
  } finally {
    await t.close();
  }
});
