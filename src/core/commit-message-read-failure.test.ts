// A failed Git read must not spend a model turn or masquerade as an empty index.
// The only Claude executable here is a temporary stand-in that records its argv.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { writeCommitMessage } from './commit-message.ts';
import { runGit, setGitEnvironment } from './git.ts';

// Resolve before the fixture replaces PATH with its fault wrapper. Setup and
// delegation must use the same runner-selected Git, without assuming /usr/bin/git matches it.
const actualGit = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim();
const gitVersion = execFileSync(actualGit, ['--version'], { encoding: 'utf8' }).trim();

function fixture(context: TestContext, large = false) {
  context.diagnostic(`Staged-read fixture Git: ${actualGit} (${gitVersion})`);
  const root = mkdtempSync(join(tmpdir(), 'wg-draft-read-'));
  const repo = join(root, 'repo'), bin = join(root, 'bin'), home = join(root, 'home'), asked = join(root, 'asked');
  for (const dir of [repo, bin, home]) mkdirSync(dir);
  const previousEnv = process.env;
  process.env = {
    HOME: home, SHELL: '/bin/sh', PATH: '/usr/bin:/bin',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture', GIT_COMMITTER_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    WG_DRAFT_LOG: asked, WG_DRAFT_GIT: actualGit,
  };
  const env = { ...process.env } as Record<string, string>;
  const git = (...args: string[]): string => execFileSync(actualGit, args, { cwd: repo, env, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'work.txt'), 'original work\n');
  writeFileSync(join(repo, 'other.txt'), 'other original work\n');
  git('add', 'work.txt', 'other.txt'); git('commit', '-qm', 'Initial work');
  const staged = 'STAGED_DRAFT_SENTINEL\n' + (large ? 'x'.repeat(300_000) + '\n' : 'reviewed change\n');
  writeFileSync(join(repo, 'work.txt'), staged); git('add', 'work.txt');
  writeFileSync(join(repo, 'work.txt'), staged + 'UNSTAGED_SAME_FILE_SENTINEL\n');
  writeFileSync(join(repo, 'other.txt'), 'UNSTAGED_OTHER_FILE_SENTINEL\n');
  writeFileSync(join(repo, 'private.txt'), 'UNTRACKED_FILE_SENTINEL\n');
  const claude = join(bin, 'fake-claude');
  writeFileSync(claude, '#!/bin/sh\nprintf "%s\\n" "$@" > "$WG_DRAFT_LOG"\nprintf \'%s\\n\' \'{"type":"result","is_error":false,"total_cost_usd":0.02,"structured_output":{"subject":"Describe the staged fixture","body":""}}\'\n', { mode: 0o755 });
  writeFileSync(join(bin, 'git'), [
    '#!/bin/sh', 'case "$WG_GIT_FAULT:$*" in',
    'patch:*--stat=120*) echo "injected staged patch read failure" >&2; exit 1;;',
    'partial-patch:*--stat=120*) printf "diff --git a/work.txt b/work.txt\\n+partial staged output\\n"; echo "injected partial patch failure" >&2; exit 1;;',
    'names:*--name-only*) echo "injected staged names read failure" >&2; exit 1;;',
    'partial-names:*--name-only*) printf "work.txt\\000"; echo "injected partial names failure" >&2; exit 1;;',
    'stderr:*--stat=120*) /usr/bin/head -c 250000 /dev/zero | /usr/bin/tr "\\000" x >&2; exit 1;;',
    'terminated:*--stat=120*) printf "partial output before termination\\n"; kill -TERM "$$";;',
    'deadline:*--stat=120*) exec /bin/sleep 5;;',
    'esac', 'exec "$WG_DRAFT_GIT" "$@"', '',
  ].join('\n'), { mode: 0o755 });
  const fault = (mode: string): void => setGitEnvironment({ ...env, PATH: `${bin}:/usr/bin:/bin`, WG_GIT_FAULT: mode });
  fault('none');
  const snapshot = () => ({
    head: git('rev-parse', 'HEAD'), refs: git('show-ref'),
    index: readFileSync(join(repo, '.git', 'index')),
    work: readFileSync(join(repo, 'work.txt')), other: readFileSync(join(repo, 'other.txt')), untracked: readFileSync(join(repo, 'private.txt')),
  });
  return {
    repo, asked, staged, fault, snapshot,
    write: () => writeCommitMessage({ cwd: repo, account: null, binary: claude }),
    close() { setGitEnvironment({}); process.env = previousEnv; rmSync(root, { recursive: true, force: true }); },
  };
}

for (const mode of ['patch', 'partial-patch', 'names', 'partial-names', 'stderr', 'terminated']) {
  test(`a ${mode} staged read failure refuses before starting Claude and preserves the checkout`, async (context) => {
    const t = fixture(context);
    try {
      const before = t.snapshot();
      t.fault(mode);
      let error: Error | null = null;
      try { await t.write(); } catch (caught) { error = caught as Error; }
      assert.equal(existsSync(t.asked), false, 'a failed staged read must not start even the stand-in model');
      assert.ok(error, 'the read failure must refuse');
      assert.doesNotMatch(error.message, /nothing is staged/i, 'failure is not an empty staged area');
      assert.deepEqual(t.snapshot(), before, 'HEAD, refs, index and every working sentinel stay unchanged');
      t.fault('none');
      const retry = await t.write();
      assert.deepEqual([retry.subject, retry.costUsd, retry.cut], ['Describe the staged fixture', 0.02, false]);
      const prompt = readFileSync(t.asked, 'utf8');
      assert.match(prompt, /STAGED_DRAFT_SENTINEL/);
      assert.doesNotMatch(prompt, /UNSTAGED_SAME_FILE_SENTINEL|UNSTAGED_OTHER_FILE_SENTINEL|UNTRACKED_FILE_SENTINEL/);
      assert.deepEqual(t.snapshot(), before, 'the successful read-only retry also preserves every byte');
    } finally { t.close(); }
  });
}

test('Git distinguishes stderr overflow and a real deadline from an allowed stdout prefix', async (context) => {
  const t = fixture(context);
  try {
    t.fault('stderr');
    const overflow = await runGit(t.repo, ['diff', '--cached', '--stat=120', '-p'], { maxBuffer: 240_000 });
    assert.equal(overflow.ok, false);
    assert.equal(overflow.truncated, true);
    assert.equal(overflow.stdoutTruncated, false);
    t.fault('deadline');
    const deadline = await runGit(t.repo, ['diff', '--cached', '--stat=120', '-p'], { timeout: 20 });
    assert.equal(deadline.ok, false);
    assert.equal(deadline.killed, true);
    assert.equal(deadline.truncated, false);
    assert.equal(deadline.stdoutTruncated, false);
    assert.equal(existsSync(t.asked), false);
  } finally { t.close(); }
});

test('an intentionally stdout-limited staged diff still drafts with an explicit cut notice', async (context) => {
  const t = fixture(context, true);
  try {
    const before = t.snapshot();
    const raw = await runGit(t.repo, ['diff', '--cached', '-p'], { maxBuffer: 240_000 });
    assert.equal(raw.ok, false);
    assert.equal(raw.truncated, true, 'this fixture must exercise execFile stdout maxBuffer, not just string slicing');
    assert.equal(raw.stdoutTruncated, true);
    assert.ok(Buffer.byteLength(raw.out) >= 240_000);
    const result = await t.write();
    assert.equal(result.cut, true);
    assert.equal(result.costUsd, 0.02);
    const prompt = readFileSync(t.asked, 'utf8');
    assert.match(prompt, /The staged diff \(cut: it is longer than shown\)/);
    assert.match(prompt, /STAGED_DRAFT_SENTINEL/);
    assert.doesNotMatch(prompt, /UNSTAGED_SAME_FILE_SENTINEL|UNSTAGED_OTHER_FILE_SENTINEL|UNTRACKED_FILE_SENTINEL/);
    assert.ok(prompt.length < 65_000, 'the model sees the documented bounded prefix');
    assert.deepEqual(t.snapshot(), before);
  } finally { t.close(); }
});
