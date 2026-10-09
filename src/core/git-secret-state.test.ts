// The existing exact-state secret-check guards, with real Git outcomes in tiny
// owned repositories. A local wrapper injects one precise read fault or writer;
// every ordinary command delegates to /usr/bin/git. No real repo or remote.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { setGitEnvironment } from './git.ts';
import { testCore } from './test-support.ts';

const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0',
  GIT_AUTHOR_NAME: 'Audit Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Audit Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};
const git = (cwd: string, ...args: string[]): Promise<string> => new Promise((resolve, reject) =>
  execFile('/usr/bin/git', args, { cwd, env: { ...process.env, ...GIT_ENV } }, (error, out, err) => error ? reject(new Error(err)) : resolve(out.trim())));

async function fixture() {
  const t = await testCore({ gitEnv: GIT_ENV });
  const dir = t.projectDir;
  await git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'staged.txt'), 'initial staged file\n');
  writeFileSync(join(dir, 'later.txt'), 'initial later file\n');
  await git(dir, 'add', '.'); await git(dir, 'commit', '-qm', 'Initial fixture');
  writeFileSync(join(dir, 'staged.txt'), 'reviewed staged bytes\n');
  await git(dir, 'add', 'staged.txt');
  writeFileSync(join(dir, 'staged.txt'), 'independent unstaged bytes\n');
  writeFileSync(join(dir, 'untracked.txt'), 'independent untracked bytes\n');
  const project = await t.owner.call('projects.add', { path: dir });
  const where = { id: project.id };
  const snapshot = async () => ({
    head: await git(dir, 'rev-parse', 'HEAD'), symbolicHead: await git(dir, 'symbolic-ref', 'HEAD'), refs: await git(dir, 'show-ref'),
    index: readFileSync(join(dir, '.git', 'index')), stagedWork: readFileSync(join(dir, 'staged.txt')), laterWork: readFileSync(join(dir, 'later.txt')),
    untracked: readFileSync(join(dir, 'untracked.txt')),
  });
  const inject = (script: string) => {
    const bin = join(t.dir, 'git-fixture-bin'); mkdirSync(bin);
    writeFileSync(join(bin, 'git'), `#!/bin/sh\nset -eu\n${script}\nexec /usr/bin/git "$@"\n`, { mode: 0o755 });
    setGitEnvironment({ ...GIT_ENV, PATH: `${bin}:/usr/bin:/bin`,
      GIT_PROBE_TRACE: join(t.dir, 'trace'), GIT_PROBE_PATCH: join(t.dir, 'patch'), GIT_PROBE_USED: join(t.dir, 'used'), GIT_PROBE_INDEX: join(t.dir, 'external.index'),
    });
  };
  const preservedWorking = () => {
    assert.equal(readFileSync(join(dir, 'staged.txt'), 'utf8'), 'independent unstaged bytes\n');
    assert.equal(readFileSync(join(dir, 'untracked.txt'), 'utf8'), 'independent untracked bytes\n');
  };
  const committedCorrectly = async () => {
    assert.equal(await git(dir, 'show', 'HEAD:staged.txt'), 'reviewed staged bytes');
    assert.equal(await git(dir, 'ls-tree', '--name-only', 'HEAD'), 'later.txt\nstaged.txt', 'untracked sentinel was never committed');
    preservedWorking();
  };
  return { ...t, fixtureDir: t.dir, dir, where, snapshot, inject, preservedWorking, committedCorrectly, async close() { setGitEnvironment(GIT_ENV); await t.close(); } };
}

test('a failed staged fingerprint with partial stdout cannot authorize scan or commit, and leaves exact Git state intact', async () => {
  const t = await fixture();
  try {
    const first = await t.owner.call('git.scan', { ...t.where, action: 'commit' });
    assert.equal(first.needsAcknowledgement, false);
    const before = await t.snapshot();
    t.inject(`case " $* " in
      *" ls-files --stage -z "*)
        printf 'partial metadata\\000'
        printf 'fingerprint read fault\\n' >> "$GIT_PROBE_TRACE"
        printf 'fixture cannot finish staged fingerprint\\n' >&2
        exit 1 ;;
    esac`);
    await assert.rejects(t.owner.call('git.commit', { ...t.where, message: 'Refuse failed fingerprint', acknowledge: first.digest }), /could not identify the exact work/);
    await assert.rejects(t.owner.call('git.scan', { ...t.where, action: 'commit' }), /could not identify the exact work/);
    assert.deepEqual(await t.snapshot(), before, 'HEAD, symbolic HEAD, refs, index bytes and independent working bytes are exact');
    assert.equal(readFileSync(join(t.fixtureDir, 'trace'), 'utf8'), 'fingerprint read fault\nfingerprint read fault\n', 'both attempts reached the intended failing read');
    setGitEnvironment(GIT_ENV);
    const fresh = await t.owner.call('git.scan', { ...t.where, action: 'commit' });
    assert.equal(fresh.digest, first.digest, 'failed reads did not change the checked state');
    await t.owner.call('git.commit', { ...t.where, message: 'Healthy fingerprint retry' });
    await t.committedCorrectly();
  } finally { await t.close(); }
});

test('a staged mutation after patch read but before the second fingerprint refuses commit and preserves the external writer’s exact index', async () => {
  const t = await fixture();
  try {
    const first = await t.owner.call('git.scan', { ...t.where, action: 'commit' });
    assert.equal(first.needsAcknowledgement, false);
    const before = await t.snapshot();
    t.inject(`case " $* " in
      *" diff --cached --no-color "*)
        if [ ! -e "$GIT_PROBE_USED" ]; then
          /usr/bin/git "$@" > "$GIT_PROBE_PATCH"
          printf 'external writer during scan\\n' > later.txt
          /usr/bin/git add -- later.txt
          /bin/cp .git/index "$GIT_PROBE_INDEX"
          /usr/bin/touch "$GIT_PROBE_USED"
          printf 'patch read then external index changed\\n' >> "$GIT_PROBE_TRACE"
          /bin/cat "$GIT_PROBE_PATCH"
          exit 0
        fi ;;
    esac`);
    await assert.rejects(t.owner.call('git.commit', { ...t.where, message: 'Refuse changing work', acknowledge: first.digest }), /changed during its secret check/);
    const after = await t.snapshot();
    assert.equal(after.head, before.head); assert.equal(after.symbolicHead, before.symbolicHead); assert.equal(after.refs, before.refs);
    assert.deepEqual(after.index, readFileSync(join(t.fixtureDir, 'external.index')), 'refusal does not undo or rewrite the external writer’s index');
    assert.notDeepEqual(after.index, before.index);
    assert.equal(after.laterWork.toString(), 'external writer during scan\n');
    t.preservedWorking();
    assert.equal(readFileSync(join(t.fixtureDir, 'trace'), 'utf8'), 'patch read then external index changed\n');
    assert.ok(!readFileSync(join(t.fixtureDir, 'patch'), 'utf8').includes('external writer during scan'), 'the injected patch predates the new staged bytes');
    setGitEnvironment(GIT_ENV);
    const fresh = await t.owner.call('git.scan', { ...t.where, action: 'commit' });
    assert.notEqual(fresh.digest, first.digest, 'retry identifies the newly staged content');
    await t.owner.call('git.commit', { ...t.where, message: 'Review the current staged work', acknowledge: fresh.digest });
    await t.committedCorrectly();
    assert.equal(await git(t.dir, 'show', 'HEAD:later.txt'), 'external writer during scan');
  } finally { await t.close(); }
});
