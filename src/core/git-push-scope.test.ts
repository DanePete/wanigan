// Git configuration cannot expand a single-branch publication into other refs
// or other repositories. All remotes here are temporary local bare repositories.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { push, pushPlan } from './git-client.ts';
import { setGitEnvironment } from './git.ts';
import { scanFor } from './git-secrets.ts';
import { openPullRequest } from './pulls.ts';
import { testCore } from './test-support.ts';

const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Review Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Review Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};
function git(cwd: string, ...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile('/usr/bin/git', args, { cwd, env: { ...process.env, ...GIT_ENV } },
    (error, stdout, stderr) => error ? reject(new Error(stderr)) : resolve(stdout.trim())));
}

for (const publisher of ['workbench', 'card pull request'] as const) {
  for (const addition of ['annotated tag', 'submodule commit'] as const) {
    test(`${publisher} publishes only its branch despite configured ${addition} publication`, async () => {
      const t = await testCore({ gitEnv: GIT_ENV });
      try {
        const repo = t.projectDir;
        await git(repo, 'init', '-q', '-b', 'main');
        writeFileSync(join(repo, 'work.txt'), 'original\n');
        await git(repo, 'add', 'work.txt');
        await git(repo, 'commit', '-qm', 'Initial work');
        const origin = join(t.dir, 'origin.git');
        await git(repo, 'init', '-q', '--bare', '-b', 'main', origin);
        await git(repo, 'remote', 'add', 'origin', origin);
        await git(repo, 'push', '-qu', 'origin', 'main');
        await git(repo, '-c', 'tag.gpgSign=false', 'tag', '-a', 'existing-tag', '-m', 'Already published');
        await git(repo, 'push', '-q', 'origin', 'refs/tags/existing-tag');
        const existingTag = await git(origin, 'rev-parse', 'refs/tags/existing-tag');
        const branch = publisher === 'workbench' ? 'main' : 'card-work';
        if (branch !== 'main') await git(repo, 'switch', '-qc', branch);
        let subOrigin: string | null = null;
        let subBefore: string | null = null;
        let subHead: string | null = null;
        if (addition === 'submodule commit') {
          const source = join(t.dir, 'dependency-source'); mkdirSync(source);
          subOrigin = join(t.dir, 'dependency.git');
          await git(source, 'init', '-q', '-b', branch);
          writeFileSync(join(source, 'dependency.txt'), 'published dependency\n');
          await git(source, 'add', 'dependency.txt');
          await git(source, 'commit', '-qm', 'Initial dependency');
          await git(source, 'init', '-q', '--bare', '-b', branch, subOrigin);
          await git(source, 'remote', 'add', 'origin', subOrigin);
          await git(source, 'push', '-qu', 'origin', branch);
          subBefore = await git(source, 'rev-parse', 'HEAD');
          await git(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', subOrigin, 'dependency');
          const sub = join(repo, 'dependency');
          writeFileSync(join(sub, 'dependency.txt'), 'private dependency work\n');
          await git(sub, 'commit', '-qam', 'Unreviewed dependency change');
          subHead = await git(sub, 'rev-parse', 'HEAD');
          await git(repo, 'add', '.gitmodules', 'dependency');
        }
        writeFileSync(join(repo, 'work.txt'), 'reviewed branch work\n');
        await git(repo, 'add', 'work.txt');
        await git(repo, 'commit', '-qm', 'Reviewed branch work');
        const head = await git(repo, 'rev-parse', 'HEAD');
        const project = await t.owner.call('projects.add', { path: repo });
        const plan = await pushPlan(repo);
        if (addition === 'annotated tag') {
          await git(repo, '-c', 'tag.gpgSign=false', 'tag', '-a', 'private-tag', '-m', 'Unreviewed annotation');
          await git(repo, 'config', 'push.followTags', 'true');
        } else await git(repo, 'config', 'push.recurseSubmodules', 'on-demand');
        assert.equal((await scanFor(repo, { action: 'push' })).needsAcknowledgement, false);
        if (publisher === 'workbench') await push(repo, head, plan.digest);
        else {
          const created = await t.owner.call('cards.create', { projectId: project.id, type: 'task', title: 'Publish only this branch' });
          const card = await t.owner.call('cards.get', { id: created.id });
          const gh = join(t.dir, 'gh');
          const log = join(t.dir, 'gh.log');
          writeFileSync(gh, '#!/bin/sh\nprintf "%s\\n" "$1" >> "$WG_TEST_GH_LOG"\ncase "$1" in auth) exit 0;; pr) echo "https://github.com/example/project/pull/7";; esac\n', { mode: 0o755 });
          // Only this test's stand-in sees the log path; no real gh is called.
          setGitEnvironment({ ...GIT_ENV, WG_TEST_GH_LOG: log });
          assert.equal((await openPullRequest(repo, { path: repo, branch, base: 'main' }, card, repo, gh)).url, 'https://github.com/example/project/pull/7');
          assert.equal(readFileSync(log, 'utf8'), 'auth\npr\n');
        }
        assert.equal(await git(origin, 'rev-parse', `refs/heads/${branch}`), head, 'the approved branch reaches exactly its reviewed head');
        assert.equal(await git(origin, 'rev-parse', 'refs/tags/existing-tag'), existingTag, 'preexisting remote tags remain unchanged');
        assert.equal(await git(origin, 'for-each-ref', '--format=%(refname)', 'refs/tags/private-tag'), '', 'an unapproved tag must stay local');
        if (addition === 'annotated tag') assert.equal(await git(repo, 'rev-parse', 'private-tag^{commit}'), head, 'the local tag is preserved');
        if (subOrigin) {
          assert.equal(await git(subOrigin, 'rev-parse', `refs/heads/${branch}`), subBefore, 'the dependency remote must receive no unapproved work');
          assert.equal(await git(join(repo, 'dependency'), 'rev-parse', 'HEAD'), subHead, 'the local dependency work is preserved');
        }
      } finally { await t.close(); }
    });
  }
}
