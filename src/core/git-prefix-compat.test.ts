// Owner diff reads must use stable prefixes without changing the repository.
// Git comes from the test runner PATH; providers and repositories are stand-ins.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runGit } from './git.ts';
import { testCore } from './test-support.ts';

async function observe<T>(work: () => Promise<T>) {
  try { return { ok: true as const, result: await work() }; }
  catch (error) { return { ok: false as const, error: (error as Error).message }; }
}

test('owner diff, draft, history and tracked/untracked stash preserve content and Git write safeguards', async context => {
  const tools = mkdtempSync(join(tmpdir(), 'wg-git-prefix-'));
  const home = join(tools, 'home'), templates = join(tools, 'templates');
  for (const dir of [home, join(templates, 'hooks')]) mkdirSync(dir, { recursive: true });
  const asked = join(tools, 'asked.txt'), claude = join(tools, 'owned-claude');
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  writeFileSync(claude, `#!/bin/sh\nprintf '%s\\n' "$@" > ${quote(asked)}\nprintf '%s\\n' '{"type":"result","is_error":false,"total_cost_usd":0.02,"structured_output":{"subject":"Describe the staged compatibility fixture","body":""}}'\n`, { mode: 0o755 });
  const env = { HOME: home, ZDOTDIR: home, PATH: process.env.PATH ?? '/usr/bin:/bin',
    ...(process.env.GIT_EXEC_PATH ? { GIT_EXEC_PATH: process.env.GIT_EXEC_PATH } : {}),
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_TEMPLATE_DIR: templates, GIT_OPTIONAL_LOCKS: '0', GIT_AUTHOR_NAME: 'Owned fixture',
    GIT_COMMITTER_NAME: 'Owned fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  const t = await testCore({ gitEnv: env, claudeBinary: claude });
  try {
    const dir = t.projectDir;
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8', timeout: 8000 }).trim();
    const version = git('--version'); assert.match(version, /^git version /);
    const actual = await runGit(dir, ['--version']);
    assert.equal(actual.ok, true); assert.equal(actual.out.trim(), version);
    git('init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'work.txt'), 'base work\n'); writeFileSync(join(dir, 'other.txt'), 'base other\n');
    git('add', 'work.txt', 'other.txt'); git('commit', '-qm', 'Initial owned work');
    writeFileSync(join(dir, 'history.txt'), 'HISTORY_SENTINEL\n'); git('add', 'history.txt'); git('commit', '-qm', 'Record history fixture');
    const project = await t.owner.call('projects.add', { path: dir });
    writeFileSync(join(dir, 'work.txt'), 'base work\nSTASH_TRACKED_SENTINEL\n');
    writeFileSync(join(dir, 'draft.txt'), 'STASH_UNTRACKED_SENTINEL\n');
    await t.owner.call('git.stashSave', { id: project.id, message: 'Owned compatibility stash', untracked: true });
    const stash = (await t.owner.call('git.stashes', { id: project.id }))[0]!;
    assert.ok(stash.sha);
    writeFileSync(join(dir, 'work.txt'), 'base work\nSTAGED_SENTINEL\n'); git('add', 'work.txt');
    writeFileSync(join(dir, 'work.txt'), 'base work\nSTAGED_SENTINEL\nUNSTAGED_SENTINEL\n');
    writeFileSync(join(dir, 'other.txt'), 'OTHER_UNSTAGED_SENTINEL\n');
    writeFileSync(join(dir, 'private.txt'), 'PRIVATE_UNTRACKED_SENTINEL\n');
    const snapshot = () => ({ head: git('rev-parse', 'HEAD'), refs: git('show-ref'), index: readFileSync(join(dir, '.git/index')).toString('hex'), config: readFileSync(join(dir, '.git/config'), 'utf8'), files: readdirSync(dir).filter(name => name !== '.git').sort().map(name => [name, readFileSync(join(dir, name)).toString('hex')]) });
    for (const [key, value] of [['diff.mnemonicPrefix', 'true'], ['diff.noprefix', 'true'], ['diff.srcPrefix', 'before/'], ['diff.dstPrefix', 'after/']]) git('config', key!, value!);
    const before = snapshot();
    const status = await t.owner.call('git.status', { id: project.id });
    const diff = await observe(() => t.owner.call('git.diff', { id: project.id, path: 'work.txt', area: 'staged' }));
    const shown = await observe(() => t.owner.call('git.show', { id: project.id, hash: before.head }));
    const draft = await observe(() => t.owner.call('git.writeMessage', { id: project.id }));
    const stashShown = await observe(() => t.owner.call('git.stashShow', { id: project.id, index: stash.index, sha: stash.sha }));
    assert.deepEqual(snapshot(), before, 'all owner reads preserve HEAD, refs, exact index/config and working bytes');
    const observation = { version, staged: status.staged.map(row => ({ path: row.path, additions: row.additions, deletions: row.deletions })), diff, shown, draft, stashShown, modelStandInCalled: existsSync(asked), preserved: true };
    context.diagnostic(JSON.stringify(observation));
    const reportRoot = process.env.WG_GIT_COMPAT_EVIDENCE;
    if (reportRoot) writeFileSync(join(reportRoot, 'owner-read-outcomes.json'), JSON.stringify(observation, null, 2) + '\n');
    assert.deepEqual(observation.staged, [{ path: 'work.txt', additions: 1, deletions: 0 }]);
    assert.equal(diff.ok, true, JSON.stringify(diff));
    if (diff.ok) { assert.match(diff.result.diff, /^diff --git a\/work.txt b\/work.txt\n/); assert.match(diff.result.diff, /\n\+STAGED_SENTINEL\n/); assert.doesNotMatch(diff.result.diff, /UNSTAGED_SENTINEL/); }
    assert.equal(shown.ok, true, JSON.stringify(shown));
    if (shown.ok) assert.deepEqual(shown.result.files.map(row => [row.path, row.additions]), [['history.txt', 1]]);
    assert.equal(draft.ok, true, JSON.stringify(draft));
    if (draft.ok) assert.deepEqual([draft.result.subject, draft.result.costUsd, draft.result.cut], ['Describe the staged compatibility fixture', 0.02, false]);
    const prompt = readFileSync(asked, 'utf8'); assert.match(prompt, /STAGED_SENTINEL/); assert.doesNotMatch(prompt, /UNSTAGED_SENTINEL|PRIVATE_UNTRACKED_SENTINEL/);
    assert.equal(stashShown.ok, true, JSON.stringify(stashShown));
    if (stashShown.ok) {
      assert.deepEqual(stashShown.result.files.map(row => [row.path, row.status, row.additions]), [['draft.txt', 'A', 1], ['work.txt', 'M', 1]]);
      assert.match(stashShown.result.files[0]!.diff, /^diff --git a\/draft.txt b\/draft.txt\n/);
      assert.match(stashShown.result.files[1]!.diff, /\n\+STASH_TRACKED_SENTINEL\n/); assert.equal(stashShown.result.cut, false);
    }
    // Read-option compatibility must not weaken secret consent or normal hooks.
    const fakeKey = ['sk', '_live_', 'Q7v2LmX9pR4tW8yZ1bN6cD3fG5hJ0kAs'].join('');
    writeFileSync(join(dir, 'secret-fixture.ts'), `export const value = "${fakeKey}";\n`); git('add', 'secret-fixture.ts');
    const secretBefore = snapshot();
    const scan = await t.owner.call('git.scan', { id: project.id, action: 'commit' });
    assert.equal(scan.needsAcknowledgement, true); assert.equal(JSON.stringify(scan).includes(fakeKey), false);
    await assert.rejects(t.owner.call('git.commit', { id: project.id, message: 'Must refuse secret' }), /possible secret/);
    assert.deepEqual(snapshot(), secretBefore);
    git('restore', '--staged', 'secret-fixture.ts'); rmSync(join(dir, 'secret-fixture.ts'));
    const hook = join(dir, '.git/hooks/pre-commit'), hookLog = join(tools, 'hook.log');
    writeFileSync(hook, `#!/bin/sh\nprintf 'blocked\\n' >> '${hookLog}'\necho 'owned hook refusal' >&2\nexit 1\n`, { mode: 0o755 });
    const { index: hookIndexBefore, ...hookBefore } = snapshot();
    const stagedBeforeHook = git('ls-files', '--stage', '-z');
    await assert.rejects(t.owner.call('git.commit', { id: project.id, message: 'Must obey hook' }), /hook.*owned hook refusal/i);
    assert.equal(readFileSync(hookLog, 'utf8'), 'blocked\n');
    // A deliberate git commit may refresh its index TREE cache even if the
    // user's hook refuses it. Keep staged entries and all user state exact.
    const { index: hookIndexAfter, ...hookAfter } = snapshot();
    assert.deepEqual(hookAfter, hookBefore); assert.equal(git('ls-files', '--stage', '-z'), stagedBeforeHook);
    writeFileSync(hook, `#!/bin/sh\nprintf 'accepted\\n' >> '${hookLog}'\n`, { mode: 0o755 });
    const committed = await t.owner.call('git.commit', { id: project.id, message: 'Commit only the staged fixture' });
    assert.equal(git('rev-parse', 'HEAD'), committed.hash); assert.equal(git('show', 'HEAD:work.txt'), 'base work\nSTAGED_SENTINEL');
    assert.equal(git('show', 'HEAD:other.txt'), 'base other'); assert.equal(git('ls-tree', '--name-only', 'HEAD', '--', 'private.txt'), '');
    assert.deepEqual(snapshot().files, before.files, 'intentional commit preserves all unstaged/untracked bytes');
    assert.equal(readFileSync(hookLog, 'utf8'), 'blocked\naccepted\n');
    if (reportRoot) writeFileSync(join(reportRoot, 'owner-write-neighbors.json'), JSON.stringify({ secretRefused: true, refusalStatePreserved: true, normalHookRefused: true, hookRefusalStageEntriesPreserved: true, hookIndexCacheChanged: hookIndexAfter !== hookIndexBefore, normalHookAccepted: true, stagedOnlyCommitted: true, unstagedAndUntrackedPreserved: true }, null, 2) + '\n');
  } finally { await t.close(); rmSync(tools, { recursive: true, force: true }); }
});
