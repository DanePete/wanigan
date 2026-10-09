// A card's branch merges back only when git can do it cleanly, from where it
// forked. Every refusal leaves the repository exactly as it was.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { sh, testCore, waitFor } from './test-support.ts';

const id = '-c user.email=a@b -c user.name=a';

test('a merge that conflicts is undone and changes nothing; one into a folder on another branch is refused', async () => {
  const t = await testCore();
  try {
    writeFileSync(join(t.projectDir, 'price.txt'), 'one\n');
    await sh(`git init -q -b main && git ${id} add -A && git ${id} commit -qm init`, t.projectDir);
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    const card = await t.owner.call('cards.create', { projectId: project.id, type: 'task', title: 'Change the price' });
    const s = await t.owner.call('sessions.start', { projectId: project.id, provider: 'shell', cardId: card.id, isolate: true });
    const wt = (await t.owner.call('cards.get', { id: card.id })).worktree!;
    writeFileSync(join(wt.path, 'price.txt'), 'two\n');
    await sh(`git ${id} commit -qam "card: two"`, wt.path);
    await t.owner.call('sessions.stop', { id: s.id });
    await waitFor('ended', async () => !(await t.owner.call('cards.get', { id: card.id })).live);

    // Meanwhile the same line changed on main.
    writeFileSync(join(t.projectDir, 'price.txt'), 'three\n');
    await sh(`git ${id} commit -qam "main: three"`, t.projectDir);
    const head = (await sh('git rev-parse HEAD', t.projectDir)).trim();

    await assert.rejects(t.owner.call('cards.merge', { id: card.id }), /The merge conflicted: .+ It was undone, and nothing changed\. .+ It conflicted in price\.txt\.$/);
    assert.equal((await sh('git rev-parse HEAD', t.projectDir)).trim(), head, 'main did not move');
    assert.equal((await sh('git status --porcelain', t.projectDir)).trim(), '', 'no conflict left in the folder');
    assert.ok(!existsSync(join(t.projectDir, '.git', 'MERGE_HEAD')), 'no merge left half done');
    assert.equal(readFileSync(join(t.projectDir, 'price.txt'), 'utf8'), 'three\n');
    assert.deepEqual((await t.owner.call('cards.get', { id: card.id })).worktree, wt, 'the card keeps its branch');
    assert.equal(readFileSync(join(wt.path, 'price.txt'), 'utf8'), 'two\n');

    await sh('git checkout -q -b elsewhere', t.projectDir);
    await assert.rejects(t.owner.call('cards.merge', { id: card.id }), /The project folder is on elsewhere, not main/);
    assert.equal((await sh('git rev-parse HEAD', t.projectDir)).trim(), head);
    await assert.rejects(t.owner.call('cards.removeWorktree', { id: card.id }), /not in main, so nothing was removed/, 'unmerged work is never thrown away');
    assert.ok(existsSync(wt.path));
  } finally {
    await t.close();
  }
});
