// A conversation resumed from History that ran on a card's branch carries on
// on that card, as Resume in the session view does. Found in the real-app
// scenario run: History resumed CS-1's conversation in CS-1's worktree as a
// one-off, so the card showed no session and the agent held no claim.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { claudeSlug } from './history.ts';
import { savedConversation, sh, testCore, waitFor } from './test-support.ts';

test('History resumes a card’s conversation on its card, unless the card is finished', async () => {
  const t = await testCore();
  try {
    await sh('git init -q -b main && git -c user.email=a@b -c user.name=a commit -q --allow-empty -m init', t.projectDir);
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    const card = await t.owner.call('cards.create', { projectId: project.id, type: 'bug', title: 'Cart subtotal ignores quantity', status: 'ready' });
    const first = await t.owner.call('sessions.start', { projectId: project.id, provider: 'claude', cardId: card.id, isolate: true });
    // What Claude Code saves at the first prompt, in the card's worktree.
    savedConversation(join(t.dir, 'home'), first);
    writeFileSync(join(t.dir, 'home', '.claude', 'projects', claudeSlug(first.cwd ?? ''), `${first.conversationId}.jsonl`), `${JSON.stringify({
      type: 'user', uuid: 'u1', isSidechain: false, sessionId: first.conversationId, cwd: first.cwd, gitBranch: 'wanigan/sit-1', entrypoint: 'cli',
      timestamp: new Date().toISOString(), message: { role: 'user', content: 'fix the subtotal' },
    })}\n`);
    await t.owner.call('sessions.stop', { id: first.id });
    await waitFor('ended', async () => (await t.owner.call('sessions.get', { id: first.id })).session.endedAt);

    const [item] = await t.owner.call('history.list', { projectId: project.id });
    assert.equal(item?.cardKey, card.key);
    const resumed = await t.owner.call('history.resume', { id: item!.id });
    assert.equal(resumed.cardId, card.id, 'it is back on its card');
    assert.equal(resumed.cwd, first.cwd, 'on the card’s branch');
    const now = await t.owner.call('cards.get', { id: card.id });
    assert.equal(now.live?.sessionId, resumed.id);
    await t.owner.call('sessions.stop', { id: resumed.id });
    await waitFor('ended', async () => (await t.owner.call('sessions.get', { id: resumed.id })).session.endedAt);

    // A finished card is not reopened by carrying its conversation on.
    await t.owner.call('cards.move', { id: card.id, status: 'archived' });
    const again = await t.owner.call('history.resume', { id: item!.id });
    assert.equal(again.cardId, null);
    assert.equal((await t.owner.call('cards.get', { id: card.id })).status, 'archived');
    await t.owner.call('sessions.stop', { id: again.id });
  } finally {
    await t.close();
  }
});
