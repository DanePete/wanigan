// Stash previews must be independent of repository diff-prefix preferences.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runGit } from './git.ts';
import { testCore } from './test-support.ts';

const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Tess Tester', GIT_AUTHOR_EMAIL: 'tess@example.com', GIT_COMMITTER_NAME: 'Tess Tester', GIT_COMMITTER_EMAIL: 'tess@example.com',
};

test('a stash preview preserves file paths and changes under every diff-prefix preference', async () => {
  const t = await testCore({ gitEnv: GIT_ENV });
  try {
    const dir = t.projectDir;
    const git = async (...args: string[]): Promise<void> => {
      const result = await runGit(dir, args);
      assert.equal(result.ok, true, result.err);
    };
    await git('init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'README.md'), '# Site\n');
    await git('add', 'README.md');
    await git('-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', 'commit', '-qm', 'Initial');
    const project = await t.owner.call('projects.add', { path: dir });
    writeFileSync(join(dir, 'README.md'), '# Site\nchanged\n');
    writeFileSync(join(dir, 'draft.md'), 'draft\n');
    await t.owner.call('git.stashSave', { id: project.id, message: 'Preview' });
    const stash = (await t.owner.call('git.stashes', { id: project.id }))[0]!;
    for (const [setting, value] of [['diff.mnemonicPrefix', 'true'], ['diff.noprefix', 'true'], ['diff.srcPrefix', 'before/'], ['diff.dstPrefix', 'after/']]) {
      await git('config', setting!, value!);
      const shown = await t.owner.call('git.stashShow', { id: project.id, index: stash.index, sha: stash.sha });
      assert.deepEqual(shown.files.map((f) => [f.path, f.status, f.additions]), [['README.md', 'M', 1], ['draft.md', 'A', 1]], setting);
      assert.match(shown.files[0]!.diff, /^diff --git a\/README\.md b\/README\.md\n/);
      assert.match(shown.files[0]!.diff, /\n\+changed\n/);
      assert.equal(shown.cut, false);
    }
  } finally { await t.close(); }
});
