// A checkout mutation's quiet check and write must also exclude new PTYs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withGitMutation } from './git-lock.ts';
import { loginPath } from './environment.ts';
import { launcher, sh, testCore, waitFor } from './test-support.ts';

test('an agent launch waits until a pending checkout mutation finishes', async () => {
  let launched = false;
  const t = await testCore({ launcher: (provider) => { launched = true; return launcher(provider); } });
  let release = (): void => {};
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let mutation: Promise<void> | null = null;
  let launch: Promise<unknown> | null = null;
  try {
    await loginPath();
    await sh('git init -q -b main', t.projectDir);
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    let entered = false;
    mutation = withGitMutation(t.projectDir, async () => { entered = true; await blocked; });
    await waitFor('mutation admitted', () => entered);
    launch = t.owner.call('sessions.start', { projectId: project.id, provider: 'claude' });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(launched, false, 'an owner operation already passed its no-agent check');
    release();
    await launch;
    assert.equal(launched, true);
  } finally {
    release();
    await mutation;
    await launch;
    await t.close();
  }
});

for (const change of ['pause', 'close', 'archive card'] as const) {
  test(`a queued launch rechecks an owner’s ${change} before spawning`, async () => {
    let launched = false;
    const t = await testCore({ launcher: (provider) => { launched = true; return launcher(provider); } });
    let release = (): void => {};
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let mutation: Promise<void> | null = null;
    let launch: Promise<unknown> | null = null;
    try {
      await loginPath();
      await sh('git init -q -b main', t.projectDir);
      const project = await t.owner.call('projects.add', { path: t.projectDir });
      const card = await t.owner.call('cards.create', { projectId: project.id, type: 'task', title: 'Queued launch' });
      let entered = false;
      mutation = withGitMutation(t.projectDir, async () => { entered = true; await blocked; });
      await waitFor('mutation admitted', () => entered);
      launch = t.owner.call('sessions.start', { projectId: project.id, provider: 'claude', cardId: card.id });
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (change === 'pause') await t.owner.call('projects.pause', { id: project.id });
      else if (change === 'close') await t.owner.call('projects.archive', { id: project.id });
      else await t.owner.call('cards.move', { id: card.id, status: 'archived' });
      release();
      await assert.rejects(launch, /paused|closed|archived/);
      assert.equal(launched, false);
      assert.deepEqual(await t.owner.call('sessions.list', { projectId: project.id }), []);
    } finally {
      release();
      await mutation;
      await launch?.catch(() => {});
      await t.close();
    }
  });
}
