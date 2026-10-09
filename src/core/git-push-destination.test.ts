// The destination shown in a push plan remains part of the owner's consent.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { testCore } from './test-support.ts';

const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Tess Tester', GIT_AUTHOR_EMAIL: 'tess@example.com',
  GIT_COMMITTER_NAME: 'Tess Tester', GIT_COMMITTER_EMAIL: 'tess@example.com',
};
function git(cwd: string, ...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile('/usr/bin/git', args, { cwd, env: { ...process.env, ...GIT_ENV } },
    (error, stdout, stderr) => error ? reject(new Error(stderr)) : resolve(stdout.trim())));
}

for (const change of ['push URL', 'remote branch', 'tracking history'] as const) {
  test(`a changed ${change} refuses an earlier clean push plan and preserves both remotes`, async () => {
    const t = await testCore({ gitEnv: GIT_ENV });
    try {
      const dir = t.projectDir;
      await git(dir, 'init', '-q', '-b', 'main');
      await git(dir, 'commit', '--allow-empty', '-qm', 'Initial work');
      const original = await git(dir, 'rev-parse', 'HEAD');
      const first = join(t.dir, 'first.git');
      const second = join(t.dir, 'second.git');
      for (const remote of [first, second]) {
        await git(dir, 'init', '-q', '--bare', '-b', 'main', remote);
        await git(dir, 'push', '-q', remote, 'HEAD:refs/heads/main');
      }
      await git(dir, 'remote', 'add', 'origin', first);
      await git(dir, 'push', '-q', '-u', 'origin', 'main');
      if (change === 'tracking history') {
        writeFileSync(join(dir, 'earlier.txt'), 'previously published work\n');
        await git(dir, 'add', 'earlier.txt');
        await git(dir, 'commit', '-qm', 'Earlier work');
        await git(dir, 'push', '-q');
      }
      writeFileSync(join(dir, 'work.txt'), 'reviewed work\n');
      await git(dir, 'add', 'work.txt');
      await git(dir, 'commit', '-qm', 'Review me');
      const project = await t.owner.call('projects.add', { path: dir });
      const where = { id: project.id };
      const plan = await t.owner.call('git.pushPlan', where);
      if (change === 'push URL') await git(dir, 'remote', 'set-url', '--push', 'origin', second);
      else if (change === 'remote branch') await git(dir, 'config', 'branch.main.merge', 'refs/heads/elsewhere');
      else {
        await git(first, 'update-ref', 'refs/heads/main', original);
        await git(dir, 'fetch', '-q', 'origin');
      }
      const attempted = { ...where, head: plan.head!, planDigest: plan.digest };
      await assert.rejects(t.owner.call('git.push', attempted), /destination.*changed|push plan.*changed/i);
      assert.equal(await git(first, 'rev-parse', 'refs/heads/main'), original);
      assert.equal(await git(second, 'rev-parse', 'refs/heads/main'), original);
      assert.equal(await git(first, 'for-each-ref', '--format=%(refname)', 'refs/heads/elsewhere'), '');
      const fresh = await t.owner.call('git.pushPlan', where);
      const approved = { ...where, head: fresh.head!, planDigest: fresh.digest };
      await t.owner.call('git.push', approved);
      assert.equal(await git(change === 'push URL' ? second : first, 'rev-parse', change === 'remote branch' ? 'refs/heads/elsewhere' : 'refs/heads/main'), fresh.head);
    } finally { await t.close(); }
  });
}
