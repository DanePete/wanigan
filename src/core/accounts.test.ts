// Accounts the owner manages: renamed, made the default, removed without
// touching the folder, and two folders on one login flagged as one.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { testCore, waitFor } from './test-support.ts';

test('an account is renamed, made the default, and removed without touching its folder; two folders on one login are flagged', async () => {
  const t = await testCore({
    accounts: {
      prober: async (_provider, dir) => dir?.endsWith('_alt') || dir?.endsWith('_work')
        ? { signedIn: 'yes', identity: 'Me@Example.com', plan: 'max' }
        : { signedIn: 'yes', identity: 'other@example.com', plan: 'pro' },
      usageReader: async () => ({ state: 'unreadable', windows: [], checkedAt: 0, note: 'test' }),
    },
  });
  try {
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    const work = await t.owner.call('accounts.add', { provider: 'claude', label: 'Work' });
    const alt = await t.owner.call('accounts.add', { provider: 'claude', label: 'Alt' });
    await t.owner.call('accounts.refresh', {});
    const byId = async () => new Map((await t.owner.call('accounts.list', {})).map((a) => [a.id, a]));
    let accounts = await byId();
    assert.equal(accounts.get(work.id)?.sameLoginAs, 'Alt', 'one login in two folders, whatever its case');
    assert.equal(accounts.get(alt.id)?.sameLoginAs, 'Work');
    const original = [...accounts.values()].find((a) => a.provider === 'claude' && a.isDefault)!;
    assert.equal(original.sameLoginAs, null);

    await t.owner.call('accounts.rename', { id: work.id, label: '  Client work ' });
    accounts = await byId();
    assert.equal(accounts.get(work.id)?.label, 'Client work');
    assert.equal(accounts.get(alt.id)?.sameLoginAs, 'Client work', 'the flag names it by its new name');
    await assert.rejects(t.owner.call('accounts.rename', { id: work.id, label: ' ' }), /1–60 characters/);

    // The default is what a project with no account of its own runs as.
    await t.owner.call('accounts.makeDefault', { id: alt.id });
    accounts = await byId();
    assert.deepEqual([accounts.get(alt.id)?.isDefault, accounts.get(original.id)?.isDefault], [true, false]);
    const session = await t.owner.call('sessions.start', { projectId: project.id, provider: 'claude' });
    assert.equal(session.accountId, alt.id);
    assert.equal(await waitFor('config', () => t.core.sessions.replay(session.id).replay.match(/CFG=(\S+)/)?.[1]), alt.configDir);
    await t.owner.call('sessions.stop', { id: session.id });
    await assert.rejects(t.owner.call('accounts.remove', { id: alt.id }), /Make another account the default first/);

    // Removing stops offering it; its folder and login stay exactly where they are.
    await t.owner.call('projects.setAccount', { id: project.id, provider: 'claude', accountId: work.id });
    await t.owner.call('accounts.makeDefault', { id: original.id });
    await t.owner.call('accounts.remove', { id: work.id });
    assert.ok(!(await byId()).has(work.id));
    assert.ok(existsSync(work.configDir as string), 'the folder is left alone');
    assert.deepEqual((await t.owner.call('projects.list', {})).find((p) => p.id === project.id)?.accounts, {}, 'a project that used it falls back');
    const after = await t.owner.call('sessions.start', { projectId: project.id, provider: 'claude' });
    assert.equal(after.accountId, original.id);
    await t.owner.call('sessions.stop', { id: after.id });
  } finally {
    await t.close();
  }
});
