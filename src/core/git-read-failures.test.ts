// Failed safety reads must not be presented as zero commits or an empty history.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { setGitEnvironment } from './git.ts';
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

for (const kind of ['pull count', 'invalid count', 'delete count', 'published history', 'stash list'] as const) {
  test(`an unreadable ${kind} refuses instead of reporting an empty or healthy result`, async () => {
    const t = await testCore({ gitEnv: GIT_ENV });
    try {
      const dir = t.projectDir;
      await git(dir, 'init', '-q', '-b', 'main');
      writeFileSync(join(dir, 'work.txt'), 'original work\n');
      await git(dir, 'add', 'work.txt');
      await git(dir, 'commit', '-qm', 'Initial work');
      const origin = join(t.dir, 'origin.git');
      await git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
      await git(dir, 'remote', 'add', 'origin', origin);
      await git(dir, 'push', '-q', '-u', 'origin', 'main');
      if (kind === 'delete count') await git(dir, 'switch', '-qc', 'keep-me');
      if (kind === 'pull count' || kind === 'invalid count' || kind === 'delete count') {
        writeFileSync(join(dir, 'work.txt'), 'later work\n');
        await git(dir, 'commit', '-qam', 'Later work');
        if (kind === 'pull count' || kind === 'invalid count') {
          await git(dir, 'push', '-q');
          await git(dir, 'reset', '-q', '--hard', 'HEAD~1');
        } else await git(dir, 'switch', '-q', 'main');
      }
      if (kind === 'stash list') {
        writeFileSync(join(dir, 'work.txt'), 'stashed work\n');
        await git(dir, 'stash', 'push', '-qm', 'Keep this work');
      }
      const project = await t.owner.call('projects.add', { path: dir });
      // Fetch may discover origin/HEAD; seed it before comparing the safety refusal.
      await git(dir, 'remote', 'set-head', 'origin', 'main');
      const beforeRefs = await git(dir, 'show-ref');
      const beforeIndex = readFileSync(join(dir, '.git', 'index'));
      const beforeFile = readFileSync(join(dir, 'work.txt'));
      const bin = join(t.dir, 'git-fault');
      mkdirSync(bin);
      const pattern = kind.endsWith('count') ? '*" rev-list "*' : kind === 'published history' ? '*" --contains "*' : '*" stash list "*';
      const fault = kind === 'invalid count' ? "echo 'not a count'; exit 0" : "echo 'injected git read failure' >&2; exit 1";
      writeFileSync(join(bin, 'git'), `#!/bin/sh\ncase " $* " in ${pattern}) ${fault};; esac\nexec /usr/bin/git "$@"\n`, { mode: 0o755 });
      setGitEnvironment({ ...GIT_ENV, PATH: `${bin}:${process.env.PATH}` });
      const where = { id: project.id };
      const call = kind === 'pull count' || kind === 'invalid count' ? () => t.owner.call('git.pull', where)
        : kind === 'delete count' ? () => t.owner.call('git.deleteBranch', { ...where, name: 'keep-me', force: true })
          : kind === 'published history' ? () => t.owner.call('git.lastCommit', where)
            : () => t.owner.call('git.stashes', where);
      await assert.rejects(call(), kind === 'invalid count' ? /unreadable commit count/ : /injected git read failure/);
      assert.equal(await git(dir, 'show-ref'), beforeRefs, 'no branch, tracking ref or stash was changed');
      assert.deepEqual(readFileSync(join(dir, '.git', 'index')), beforeIndex);
      assert.deepEqual(readFileSync(join(dir, 'work.txt')), beforeFile);
      setGitEnvironment(GIT_ENV);
      if (kind === 'pull count' || kind === 'invalid count') assert.equal((await t.owner.call('git.pull', where)).pulled, 1, 'retry observes and pulls the real incoming commit');
      if (kind === 'published history') assert.deepEqual((await t.owner.call('git.lastCommit', where))?.pushedTo, ['origin/main']);
      if (kind === 'stash list') assert.equal((await t.owner.call('git.stashes', where)).length, 1);
    } finally {
      setGitEnvironment(GIT_ENV);
      await t.close();
    }
  });
}
