// A card worktree that can run: the repository's own .worktreeinclude brings
// ignored files such as .env along, and the project's setup command runs there
// as a shell session the owner can watch.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { sh, testCore, waitFor } from './test-support.ts';

const ID = '-c user.email=t@t -c user.name=t';

test('a new card worktree gets the ignored files .worktreeinclude names, and runs the setup command beside the agent', async () => {
  const t = await testCore();
  try {
    const { owner } = t;
    const repo = t.projectDir;
    const outside = join(t.dir, 'outside.env');
    writeFileSync(outside, 'SECRET=outside the repository\n');
    writeFileSync(join(repo, '.gitignore'), '.env\n.env.*\n*.env\nnode_modules/\nsecrets/\n');
    writeFileSync(join(repo, '.worktreeinclude'), '# what a worktree needs to run\n.env\n.env.local\nsecrets/\nnode_modules/.bin/tool\ntracked.txt\nlink.env\n');
    writeFileSync(join(repo, 'tracked.txt'), 'in git\n');
    await sh(`git init -q -b main && git ${ID} add -A && git ${ID} commit -qm init`, repo);
    writeFileSync(join(repo, '.env'), 'DB=local\n');
    writeFileSync(join(repo, '.env.local'), 'DEBUG=1\n');
    writeFileSync(join(repo, '.env.prod'), 'not listed\n');
    mkdirSync(join(repo, 'secrets'));
    writeFileSync(join(repo, 'secrets', 'key.pem'), 'key\n');
    mkdirSync(join(repo, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(repo, 'node_modules', '.bin', 'tool'), '#!/bin/sh\n');
    writeFileSync(join(repo, 'node_modules', 'left.js'), 'not listed\n');
    symlinkSync(outside, join(repo, 'link.env'));
    const before = await sh('git status --porcelain --ignored', repo);

    const project = await owner.call('projects.add', { path: repo });
    await assert.rejects(owner.call('projects.update', { id: project.id, setupCommand: 'npm install\nrm -rf ~' }), /one line/);
    await owner.call('projects.update', { id: project.id, setupCommand: '  echo "setup in $PWD"; test -f .env && echo has-env  ' });
    assert.equal((await owner.call('projects.list', {})).find((p) => p.id === project.id)?.setupCommand, 'echo "setup in $PWD"; test -f .env && echo has-env');

    const card = await owner.call('cards.create', { projectId: project.id, type: 'task', title: 'Runs in its worktree' });
    const agent = await owner.call('sessions.start', { projectId: project.id, provider: 'claude', cardId: card.id, isolate: true });
    const wt = (await owner.call('cards.get', { id: card.id })).worktree!.path;
    assert.equal(agent.cwd, wt);

    assert.equal(readFileSync(join(wt, '.env'), 'utf8'), 'DB=local\n');
    assert.equal(readFileSync(join(wt, '.env.local'), 'utf8'), 'DEBUG=1\n');
    assert.equal(readFileSync(join(wt, 'secrets', 'key.pem'), 'utf8'), 'key\n', 'a folder pattern brings its files');
    assert.ok(existsSync(join(wt, 'node_modules', '.bin', 'tool')));
    assert.ok(!existsSync(join(wt, '.env.prod')), 'ignored but not listed stays behind');
    assert.ok(!existsSync(join(wt, 'node_modules', 'left.js')));
    assert.ok(!existsSync(join(wt, 'link.env')), 'a symbolic link is never followed out of the repository');

    // The setup runs as its own shell session on the card, in the worktree, and never takes the claim.
    const setup = await waitFor('setup session', async () =>
      (await owner.call('sessions.list', { projectId: project.id })).find((s) => s.title.startsWith('Setup: ')));
    assert.equal(setup.title, 'Setup: echo "setup in $PWD"; test -f .env && echo has-env');
    assert.equal(setup.provider, 'shell');
    assert.equal(setup.cardId, card.id);
    assert.equal(setup.cwd, wt);
    const ended = await waitFor('setup ended', async () => {
      const s = (await owner.call('sessions.get', { id: setup.id })).session;
      return s.state === 'ended' ? s : null;
    });
    assert.equal(ended.activity, 'Setup “echo "setup in $PWD"; test -f .env && echo has-env” finished');
    const output = t.core.sessions.replay(setup.id).replay;
    assert.match(output, new RegExp(`setup in ${wt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(output, /has-env/, 'the copied .env was there before setup ran');
    const after = await owner.call('cards.get', { id: card.id });
    assert.equal(after.claim?.sessionId, agent.id, 'the agent holds the card');
    assert.ok(after.activity.some((a) => a.verb === 'copied 4 files named in .worktreeinclude'));

    assert.equal(await sh('git status --porcelain --ignored', repo), before, 'nothing was written into the repository');
    await owner.call('sessions.stop', { id: agent.id });
    await waitFor('agent stopped', async () => !(await owner.call('cards.get', { id: card.id })).live);

    // A worktree that is already there is reused, not set up again.
    const again = await owner.call('sessions.start', { projectId: project.id, provider: 'shell', cardId: card.id });
    assert.equal(again.cwd, wt);
    const setups = (await owner.call('sessions.list', { projectId: project.id })).filter((s) => s.cardId === card.id && s.title.startsWith('Setup: '));
    assert.equal(setups.length, 1);
    await owner.call('sessions.stop', { id: again.id });

    // A setup that fails lands in Needs you, saying it was the setup.
    await owner.call('projects.update', { id: project.id, setupCommand: 'exit 3' });
    const second = await owner.call('cards.create', { projectId: project.id, type: 'task', title: 'Setup fails' });
    const other = await owner.call('sessions.start', { projectId: project.id, provider: 'shell', cardId: second.id, isolate: true });
    const failed = await waitFor('failed setup', async () => (await owner.call('needs.list', {})).find((n) => n.kind === 'failed' && n.cardId === second.id));
    assert.equal(failed.detail, 'Setup “exit 3” failed with code 3');
    await owner.call('sessions.stop', { id: other.id });

    // Clearing the command turns it off.
    await owner.call('projects.update', { id: project.id, setupCommand: '' });
    assert.equal((await owner.call('projects.list', {})).find((p) => p.id === project.id)?.setupCommand, null);
  } finally {
    await t.close();
  }
});
