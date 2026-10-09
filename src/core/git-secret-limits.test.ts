// Incomplete checks acknowledge the exact staged work, not a reusable warning.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { testCore } from './test-support.ts';
import { SCAN_LIMITS } from './git-secrets.ts';

const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Tess Tester', GIT_AUTHOR_EMAIL: 'tess@example.com',
  GIT_COMMITTER_NAME: 'Tess Tester', GIT_COMMITTER_EMAIL: 'tess@example.com',
};

function git(cwd: string, ...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile('/usr/bin/git', args, { cwd, env: { ...process.env, ...GIT_ENV } },
    (error, stdout, stderr) => error ? reject(new Error(stderr)) : resolve(stdout.trim())));
}

test('a byte-limited secret check refuses a stale acknowledgement after unseen staged work changes', async () => {
  const t = await testCore({ gitEnv: GIT_ENV });
  try {
    const dir = t.projectDir;
    await git(dir, 'init', '-q', '-b', 'main');
    await git(dir, 'commit', '--allow-empty', '-qm', 'Initial work');
    const project = await t.owner.call('projects.add', { path: dir });
    const where = { id: project.id };
    writeFileSync(join(dir, 'a-large.txt'), 'x'.repeat(SCAN_LIMITS.bytes + 1024) + '\n');
    await git(dir, 'add', 'a-large.txt');
    const first = await t.owner.call('git.scan', { ...where, action: 'commit' });
    assert.ok(first.partial);
    assert.equal(first.needsAcknowledgement, true);
    assert.deepEqual(first.findings, []);
    const head = await git(dir, 'rev-parse', 'HEAD');
    await assert.rejects(t.owner.call('git.commit', { ...where, message: 'Large work' }), /not read all|not scanned|nothing was committed/);
    assert.equal(await git(dir, 'rev-parse', 'HEAD'), head);
    writeFileSync(join(dir, 'z-later.txt'), 'work staged after the incomplete check\n');
    await git(dir, 'add', 'z-later.txt');
    const index = readFileSync(join(dir, '.git', 'index'));
    await assert.rejects(t.owner.call('git.commit', { ...where, message: 'Large work', acknowledge: first.digest }), /changed after it was shown/);
    assert.equal(await git(dir, 'rev-parse', 'HEAD'), head);
    assert.deepEqual(readFileSync(join(dir, '.git', 'index')), index);
    assert.equal(readFileSync(join(dir, 'z-later.txt'), 'utf8'), 'work staged after the incomplete check\n');
    const fresh = await t.owner.call('git.scan', { ...where, action: 'commit' });
    assert.notEqual(fresh.digest, first.digest);
    await t.owner.call('git.commit', { ...where, message: 'Large work', acknowledge: fresh.digest });
    assert.equal(await git(dir, 'show', 'HEAD:z-later.txt'), 'work staged after the incomplete check');
  } finally { await t.close(); }
});

test('a commit-limited secret check refuses a stale push acknowledgement and preserves the remote', async () => {
  const t = await testCore({ gitEnv: GIT_ENV });
  try {
    const dir = t.projectDir;
    await git(dir, 'init', '-q', '-b', 'main');
    await git(dir, 'commit', '--allow-empty', '-qm', 'Initial work');
    const origin = join(t.dir, 'origin.git');
    await git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
    await git(dir, 'remote', 'add', 'origin', origin);
    await git(dir, 'push', '-q', '-u', 'origin', 'main');
    const original = await git(origin, 'rev-parse', 'refs/heads/main');
    const tree = await git(dir, 'rev-parse', 'HEAD^{tree}');
    let head = original;
    let parent = original;
    for (let i = 0; i <= SCAN_LIMITS.commits; i++) {
      parent = head;
      head = await git(dir, 'commit-tree', tree, '-p', head, '-m', `Fixture ${i}`);
    }
    await git(dir, 'update-ref', 'refs/heads/main', head);
    const project = await t.owner.call('projects.add', { path: dir });
    const where = { id: project.id };
    const push = async (acknowledge?: string): Promise<unknown> => {
      const plan = await t.owner.call('git.pushPlan', where);
      return t.owner.call('git.push', { ...where, head, planDigest: plan.digest, acknowledge });
    };
    const first = await t.owner.call('git.scan', { ...where, action: 'push' });
    assert.match(first.partial ?? '', /newest 200.*201.*1 older commit/);
    assert.equal(first.needsAcknowledgement, true);
    assert.deepEqual(first.findings, []);
    await assert.rejects(push(), /not scanned|nothing was pushed/);
    assert.equal(await git(origin, 'rev-parse', 'refs/heads/main'), original);
    // Replace the last commit while retaining the same total and warning text.
    head = await git(dir, 'commit-tree', tree, '-p', parent, '-m', 'Replacement after review');
    await git(dir, 'update-ref', 'refs/heads/main', head);
    await assert.rejects(push(first.digest), /changed after it was shown/);
    assert.equal(await git(origin, 'rev-parse', 'refs/heads/main'), original);
    const fresh = await t.owner.call('git.scan', { ...where, action: 'push' });
    assert.notEqual(fresh.digest, first.digest);
    await push(fresh.digest);
    assert.equal(await git(origin, 'rev-parse', 'refs/heads/main'), head);
  } finally { await t.close(); }
});
