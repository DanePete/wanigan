// Regressions for what the second independent review found (7 October 2026),
// each the review's reproduction turned around to assert the fix.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { READ_ONLY_ARGS } from './headless.ts';
import { savedConversation, sh, testCore, waitFor } from './test-support.ts';

const git = 'git init -q -b main && git -c user.email=a@b -c user.name=a commit -q --allow-empty -m init';

test('the demo signs nothing in and opens no terminal in the owner’s home', async () => {
  const t = await testCore({ demo: true });
  try {
    const [account] = await t.owner.call('accounts.list', {});
    await assert.rejects(t.owner.call('accounts.signIn', { id: account!.id }), /demo signs nothing in/);
    await assert.rejects(t.owner.call('mcp.terminal', { catalogId: 'github', accountId: account!.id, scope: 'user' }), /demo opens no terminal/);
  } finally {
    await t.close();
  }
});

test('a terminal a key may be typed into keeps no record once it closes', async () => {
  const t = await testCore();
  try {
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    const s = await t.core.sessions.start({ projectId: project.id, provider: 'shell', ephemeral: true });
    t.core.sessions.input(s.id, 'echo ghp_not_a_real_token_123\n');
    await waitFor('echo', () => t.core.sessions.replay(s.id).replay.includes('ghp_not_a_real_token_123'));
    await t.owner.call('sessions.stop', { id: s.id });
    await waitFor('ended', async () => (await t.owner.call('sessions.get', { id: s.id })).session.endedAt);
    assert.ok(!existsSync(join(t.core.paths.dataDir, 'scrollback', `${s.id}.log`)), 'the record is gone');
    assert.equal(t.core.sessions.replay(s.id).replay, '');
  } finally {
    await t.close();
  }
});

test('a conversation carried on runs where it ran, and starts once', async () => {
  const t = await testCore();
  try {
    await sh(git, t.projectDir);
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    const card = await t.owner.call('cards.create', { projectId: project.id, type: 'task', title: 'On a branch' });
    const first = await t.owner.call('sessions.start', { projectId: project.id, provider: 'claude', cardId: card.id, isolate: true });
    const branchDir = (await t.owner.call('cards.get', { id: card.id })).worktree!.path;
    await t.owner.call('sessions.stop', { id: first.id });
    await waitFor('ended', async () => (await t.owner.call('sessions.get', { id: first.id })).session.endedAt);
    await t.owner.call('cards.move', { id: card.id, status: 'archived' });

    // Its card no longer carries it, but its branch is still where its work is.
    savedConversation(join(t.dir, 'home'), first);
    const resumed = await t.owner.call('sessions.resume', { id: first.id });
    assert.equal(resumed.cwd, branchDir);
    await t.owner.call('sessions.stop', { id: resumed.id });
    await waitFor('ended', async () => (await t.owner.call('sessions.get', { id: resumed.id })).session.endedAt);

    // A conversation that ran in the project folder stays there when branches are turned on.
    const plain = await t.owner.call('cards.create', { projectId: project.id, type: 'task', title: 'In the folder' });
    const s = await t.owner.call('sessions.start', { projectId: project.id, provider: 'claude', cardId: plain.id, isolate: false });
    await t.owner.call('sessions.stop', { id: s.id });
    await waitFor('ended', async () => (await t.owner.call('sessions.get', { id: s.id })).session.endedAt);
    await t.owner.call('projects.update', { id: project.id, isolate: true });
    savedConversation(join(t.dir, 'home'), s);
    const again = await t.owner.call('sessions.resume', { id: s.id });
    assert.equal(again.cwd, t.projectDir);
    assert.equal((await t.owner.call('cards.get', { id: plain.id })).worktree, null, 'no branch was made for it');
    await t.owner.call('sessions.stop', { id: again.id });
    await waitFor('ended', async () => (await t.owner.call('sessions.get', { id: again.id })).session.endedAt);

    // Two clicks on Resume: one session.
    const results = await Promise.allSettled([t.owner.call('sessions.resume', { id: s.id }), t.owner.call('sessions.resume', { id: s.id })]);
    assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
    for (const x of await t.owner.call('sessions.list', { live: true })) await t.owner.call('sessions.stop', { id: x.id });
  } finally {
    await t.close();
  }
});

test('own branches are refused for a project inside a larger repository, and kept across a key change', async () => {
  const t = await testCore();
  try {
    await sh(git, t.projectDir);
    const sub = join(t.projectDir, 'packages', 'app');
    mkdirSync(sub, { recursive: true });
    const inner = await t.owner.call('projects.add', { path: sub });
    const card = await t.owner.call('cards.create', { projectId: inner.id, type: 'task', title: 'Inside' });
    await assert.rejects(t.owner.call('sessions.start', { projectId: inner.id, provider: 'shell', cardId: card.id, isolate: true }), /inside a larger repository/);

    const root = await t.owner.call('projects.add', { path: t.projectDir, key: 'OLD' });
    const work = await t.owner.call('cards.create', { projectId: root.id, type: 'task', title: 'Work' });
    const s = await t.owner.call('sessions.start', { projectId: root.id, provider: 'shell', cardId: work.id, isolate: true });
    const wt = (await t.owner.call('cards.get', { id: work.id })).worktree!;
    await sh('echo done > work.txt && git add work.txt && git -c user.email=a@b -c user.name=a commit -q -m work', wt.path);
    await t.owner.call('sessions.stop', { id: s.id });
    await waitFor('ended', async () => !(await t.owner.call('cards.get', { id: work.id })).live);
    await t.owner.call('projects.update', { id: root.id, key: 'NEW' });
    rmSync(wt.path, { recursive: true, force: true });
    const again = await t.owner.call('sessions.start', { projectId: root.id, provider: 'shell', cardId: work.id });
    const restored = (await t.owner.call('cards.get', { id: work.id })).worktree!;
    assert.equal(restored.branch, wt.branch, 'still the card’s own branch');
    assert.ok(existsSync(join(restored.path, 'work.txt')), 'with its work in it');
    await t.owner.call('sessions.stop', { id: again.id });
  } finally {
    await t.close();
  }
});

test('AI review and drafting run with only the reading tools, and none of the account’s MCP servers', () => {
  const tools = READ_ONLY_ARGS.indexOf('--tools');
  assert.ok(tools >= 0);
  assert.equal(READ_ONLY_ARGS[tools + 1], 'Read,Grep,Glob');
  assert.ok(READ_ONLY_ARGS.includes('--strict-mcp-config'));
});
