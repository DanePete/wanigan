// The git workbench end to end: a real core, real repositories in a temporary
// folder, a bare repository as origin, and stand-ins for claude and gh. Every
// outcome is checked in git's own state afterwards, and every refusal leaves it
// as it was. Nothing here reads the owner's git config, home or accounts.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { diffHash, parseDiff } from '../shared/diff.ts';
import { hunkPick } from '../shared/patch.ts';
import { repoProblem, setGitEnvironment } from './git.ts';
import { testCore, waitFor, type TestCore } from './test-support.ts';

/** No global or system config, one identity: the owner's signing keys and hooks never reach a test. */
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Tess Tester', GIT_AUTHOR_EMAIL: 'tess@example.com', GIT_COMMITTER_NAME: 'Tess Tester', GIT_COMMITTER_EMAIL: 'tess@example.com',
};

function sh(command: string, cwd: string): Promise<string> {
  return new Promise((ok, fail) => execFile('/bin/sh', ['-c', command], { cwd, env: { ...process.env, ...GIT_ENV } },
    (error, stdout, stderr) => (error ? fail(new Error(`${command}: ${stderr}`)) : ok(String(stdout)))));
}
const out = async (command: string, cwd: string): Promise<string> => (await sh(command, cwd)).trim();

/** A core over a repository with two commits on main and a bare origin it has been pushed to. */
async function repo(extra: Parameters<typeof testCore>[0] = {}): Promise<TestCore & { id: string; origin: string }> {
  const t = await testCore({ gitEnv: GIT_ENV, ...extra });
  const dir = t.projectDir;
  writeFileSync(join(dir, 'app.ts'), ['export const a = 1;', 'export const b = 2;', 'export const c = 3;', 'export const d = 4;', 'export const e = 5;', ''].join('\n'));
  writeFileSync(join(dir, 'README.md'), '# Site\n');
  await sh('git init -q -b main && git add -A && git commit -qm "First commit" && echo "two" >> README.md && git commit -qam "Second commit"', dir);
  const origin = join(t.dir, 'origin.git');
  // Its HEAD names main, so a clone of it is on main as the owner's teammates' would be.
  await sh(`git init -q --bare -b main "${origin}" && git remote add origin "${origin}" && git push -q -u origin main`, dir);
  const project = await t.owner.call('projects.add', { path: dir });
  return Object.assign(t, { id: project.id, origin });
}

test('status: branch, upstream, ahead and behind, and the four lists; a folder that is not a repository, and no git at all, are told apart', async () => {
  const t = await repo();
  try {
    const dir = t.projectDir;
    writeFileSync(join(dir, 'app.ts'), readFileSync(join(dir, 'app.ts'), 'utf8').replace('b = 2', 'b = 20'));
    await sh('git add app.ts', dir);
    writeFileSync(join(dir, 'app.ts'), readFileSync(join(dir, 'app.ts'), 'utf8').replace('e = 5', 'e = 50'));
    writeFileSync(join(dir, 'notes.md'), 'one\ntwo\n');
    await sh('git rm -q README.md', dir);
    let s = await t.owner.call('git.status', { id: t.id });
    assert.equal(s.problem, null);
    assert.deepEqual([s.branch, s.upstream, s.ahead, s.behind, s.detached, s.unborn], ['main', 'origin/main', 0, 0, false, false]);
    assert.deepEqual(s.staged.map((f) => [f.path, f.status, f.additions, f.deletions]), [['app.ts', 'M', 1, 1], ['README.md', 'D', 0, 2]]);
    assert.deepEqual(s.changed.map((f) => [f.path, f.status, f.additions, f.deletions]), [['app.ts', 'M', 1, 1]]);
    assert.deepEqual(s.untracked.map((f) => [f.path, f.status, f.additions]), [['notes.md', '?', 2]]);
    assert.deepEqual(s.remotes, ['origin']);

    await sh('git commit -qm "Third" && git reset -q --hard', dir);
    rmSync(join(dir, 'notes.md'));
    // Someone else pushed to origin: behind by one after a fetch.
    const other = join(t.dir, 'other');
    await sh(`git clone -q "${t.origin}" "${other}" && cd "${other}" && echo x > x.txt && git add x.txt && git commit -qm "From elsewhere" && git push -q`, t.dir);
    await t.owner.call('git.fetch', { id: t.id });
    s = await t.owner.call('git.status', { id: t.id });
    assert.deepEqual([s.ahead, s.behind], [1, 1]);

    const plain = join(t.dir, 'plain');
    mkdirSync(plain);
    const p2 = await t.owner.call('projects.add', { path: plain });
    assert.deepEqual((await t.owner.call('git.status', { id: p2.id })).problem, { kind: 'not-repo' });
    await assert.rejects(t.owner.call('git.log', { id: p2.id }), /is not a git repository/);
    // git that cannot be found is its own answer, not "not a repository".
    setGitEnvironment({ ...GIT_ENV, PATH: join(t.dir, 'empty-bin') });
    try {
      assert.deepEqual(await repoProblem(dir), { kind: 'no-git' });
    } finally {
      setGitEnvironment(GIT_ENV);
    }
  } finally {
    await t.close();
  }
});

test('staging: files, all, a hunk, picked lines, unstaging lines, and discarding a hunk; a stale diff is refused', async () => {
  const t = await repo();
  try {
    const dir = t.projectDir;
    const file = join(dir, 'app.ts');
    // Two hunks: line 1 and line 5 edited, far enough apart with no context between them... make them separate.
    writeFileSync(file, ['export const a = 10;', 'export const b = 2;', 'export const c = 3;', 'export const d = 4;', 'export const e = 5;', '', '', '', '', '', 'export const z = 26;', ''].join('\n'));
    await sh('git add app.ts && git commit -qm "Grow" && git push -q', dir);
    writeFileSync(file, ['export const a = 11;', 'export const b = 2;', 'export const c = 3;', 'export const d = 4;', 'export const e = 5;', '', '', '', '', '', 'export const z = 27;', 'export const y = 25;', ''].join('\n'));
    const where = { id: t.id };
    const diffOf = async (area: 'changed' | 'staged') => (await t.owner.call('git.diff', { ...where, path: 'app.ts', area })).diff;
    let diff = await diffOf('changed');
    assert.equal(parseDiff(diff).filter((l) => l.kind === 'hunk').length, 2);

    // The second hunk only.
    await t.owner.call('git.applyPart', { ...where, path: 'app.ts', area: 'changed', action: 'stage', pick: hunkPick(diff, 1), digest: diffHash(diff) });
    assert.equal(await out('git show :app.ts', dir), ['export const a = 10;', 'export const b = 2;', 'export const c = 3;', 'export const d = 4;', 'export const e = 5;', '', '', '', '', '', 'export const z = 27;', 'export const y = 25;'].join('\n'));
    assert.match(readFileSync(file, 'utf8'), /a = 11/, 'the working tree is untouched');

    // Unstage one of those lines: y goes back out of the index, z stays.
    let staged = await diffOf('staged');
    await t.owner.call('git.applyPart', { ...where, path: 'app.ts', area: 'staged', action: 'unstage', pick: { old: [], new: [12] }, digest: diffHash(staged) });
    assert.doesNotMatch(await out('git show :app.ts', dir), /y = 25/);
    assert.match(await out('git show :app.ts', dir), /z = 27/);

    // Discard the first hunk from the working tree: a goes back to 10; nothing else moves.
    diff = await diffOf('changed');
    await t.owner.call('git.applyPart', { ...where, path: 'app.ts', area: 'changed', action: 'discard', pick: hunkPick(diff, 0), digest: diffHash(diff) });
    const now = readFileSync(file, 'utf8');
    assert.match(now, /a = 10;/);
    assert.match(now, /y = 25/, 'the other hunk stays');

    // A diff that changed since it was shown refuses, and nothing changes.
    diff = await diffOf('changed');
    writeFileSync(file, `${now}// edited meanwhile\n`);
    await assert.rejects(t.owner.call('git.applyPart', { ...where, path: 'app.ts', area: 'changed', action: 'stage', pick: hunkPick(diff, 0), digest: diffHash(diff) }), /changed since its diff was shown/);

    // Picked lines of an untracked file: the index gets a new file holding just them.
    writeFileSync(join(dir, 'list.txt'), 'one\ntwo\nthree');
    const untracked = (await t.owner.call('git.diff', { ...where, path: 'list.txt', area: 'untracked' })).diff;
    await t.owner.call('git.applyPart', { ...where, path: 'list.txt', area: 'untracked', action: 'stage', pick: { old: [], new: [1, 3] }, digest: diffHash(untracked) });
    assert.equal(await sh('git show :list.txt', dir), 'one\nthree', 'the last line keeps its missing newline');

    // Whole files: stage all, unstage one; discard a tracked file and delete an untracked one.
    writeFileSync(join(dir, 'scratch.log'), 'tmp\n');
    await t.owner.call('git.stage', { ...where, paths: ['app.ts', 'list.txt'] });
    assert.deepEqual((await t.owner.call('git.status', where)).changed, []);
    await t.owner.call('git.unstage', { ...where, paths: ['list.txt'] });
    let s = await t.owner.call('git.status', where);
    assert.deepEqual(s.staged.map((f) => f.path), ['app.ts']);
    assert.deepEqual(s.untracked.map((f) => f.path).sort(), ['list.txt', 'scratch.log']);
    await t.owner.call('git.unstage', { ...where, paths: ['app.ts'] });
    await t.owner.call('git.discard', { ...where, paths: ['app.ts'], untracked: ['scratch.log'] });
    s = await t.owner.call('git.status', where);
    assert.deepEqual([s.staged.length, s.changed.length, s.untracked.map((f) => f.path)], [0, 0, ['list.txt']]);
    assert.equal(existsSync(join(dir, 'scratch.log')), false);

    // Paths outside the checkout and parts of a binary are refused.
    await assert.rejects(t.owner.call('git.stage', { ...where, paths: ['../escape'] }), /outside the project/);
    writeFileSync(join(dir, 'logo.bin'), Buffer.from([0, 1, 2, 3]));
    const bin = (await t.owner.call('git.diff', { ...where, path: 'logo.bin', area: 'untracked' })).diff;
    await assert.rejects(t.owner.call('git.applyPart', { ...where, path: 'logo.bin', area: 'untracked', action: 'stage', pick: { old: [], new: [1] }, digest: diffHash(bin) }), /binary/);
  } finally {
    await t.close();
  }
});

test('parts of a file with no last newline apply in real git, staged and unstaged', async () => {
  const t = await repo();
  try {
    const dir = t.projectDir;
    const where = { id: t.id };
    writeFileSync(join(dir, 'eof.txt'), 'a\nb');
    await sh('git add eof.txt && git commit -qm "No newline"', dir);
    writeFileSync(join(dir, 'eof.txt'), 'a\nb\nc');
    const changed = (await t.owner.call('git.diff', { ...where, path: 'eof.txt', area: 'changed' })).diff;
    // Picking only the added line takes b's new ending with it: git cannot add after a line with none.
    await t.owner.call('git.applyPart', { ...where, path: 'eof.txt', area: 'changed', action: 'stage', pick: { old: [], new: [3] }, digest: diffHash(changed) });
    assert.equal(await sh('git show :eof.txt', dir), 'a\nb\nc');
    const staged = (await t.owner.call('git.diff', { ...where, path: 'eof.txt', area: 'staged' })).diff;
    await t.owner.call('git.applyPart', { ...where, path: 'eof.txt', area: 'staged', action: 'unstage', pick: { old: [], new: [3] }, digest: diffHash(staged) });
    // Unstaging only c: c leaves the index, and b keeps the ending it gained, which needs nothing after it.
    assert.equal(await sh('git show :eof.txt', dir), 'a\nb\n');
    // Discarding in the working tree, the same way.
    await sh('git reset -q -- eof.txt', dir);
    const again = (await t.owner.call('git.diff', { ...where, path: 'eof.txt', area: 'changed' })).diff;
    await t.owner.call('git.applyPart', { ...where, path: 'eof.txt', area: 'changed', action: 'discard', pick: { old: [2], new: [] }, digest: diffHash(again) });
    assert.equal(readFileSync(join(dir, 'eof.txt'), 'utf8'), 'a\nb');
  } finally {
    await t.close();
  }
});

test('commit: a summary and description, nothing staged refused, a secret found and acknowledged, amend, and why a commit failed', async () => {
  const t = await repo();
  try {
    const dir = t.projectDir;
    const where = { id: t.id };
    await assert.rejects(t.owner.call('git.commit', { ...where, message: 'Empty' }), /Nothing is staged/);
    // A key-shaped value, assembled here so no scanner reads one in this file.
    const key = ['sk', '_live_', 'Q7v2LmX9pR4tW8yZ1bN6cD3fG5hJ0kAs'].join('');
    writeFileSync(join(dir, 'pay.ts'), `export const stripe = connect("${key}");\n`);
    await t.owner.call('git.stage', { ...where, paths: ['pay.ts'] });
    const stagedPay = readFileSync(join(dir, 'pay.ts'), 'utf8');
    const unstagedPay = stagedPay + '// not approved for this commit\n';
    const originalApp = await sh('git show HEAD:app.ts', dir);
    writeFileSync(join(dir, 'pay.ts'), unstagedPay);
    writeFileSync(join(dir, 'app.ts'), originalApp + '// separate unstaged work\n');
    writeFileSync(join(dir, 'untracked-note.txt'), 'untracked work stays here\n');
    const scan = await t.owner.call('git.scan', { ...where, action: 'commit' });
    assert.equal(scan.needsAcknowledgement, true);
    assert.deepEqual(scan.findings.map((f) => [f.file, f.line, f.rule]), [['pay.ts', 1, 'stripe-live-key']]);
    assert.equal(JSON.stringify(scan).includes(key.slice(8)), false, 'the secret never leaves the core');
    await assert.rejects(t.owner.call('git.commit', { ...where, message: 'Pay' }), /found 1 possible secret in the staged changes, so nothing was committed/);
    await assert.rejects(t.owner.call('git.commit', { ...where, message: 'Pay', acknowledge: 'not-the-digest' }), /changed after it was shown/);
    assert.equal(await out('git rev-list --count HEAD', dir), '2', 'nothing was committed');
    const made = await t.owner.call('git.commit', { ...where, message: 'Connect the payment client\n\nThe key moves to the vault next.', acknowledge: scan.digest });
    assert.equal(await out('git log -1 --format=%s%n%n%b', dir), 'Connect the payment client\n\nThe key moves to the vault next.');
    assert.equal(made.subject, 'Connect the payment client');
    assert.equal(await sh('git show HEAD:pay.ts', dir), stagedPay, 'only the staged version is committed');
    assert.equal(await sh('git show HEAD:app.ts', dir), originalApp, 'another tracked file stays out of the commit');
    assert.equal(await out('git ls-tree --name-only HEAD -- untracked-note.txt', dir), '', 'untracked work stays out of the commit');
    assert.equal(readFileSync(join(dir, 'pay.ts'), 'utf8'), unstagedPay, 'unstaged edits in the committed file survive');
    assert.equal(readFileSync(join(dir, 'app.ts'), 'utf8'), originalApp + '// separate unstaged work\n');
    assert.equal(readFileSync(join(dir, 'untracked-note.txt'), 'utf8'), 'untracked work stays here\n');

    // Amend: the last commit says whether it was pushed; an empty message keeps it.
    let last = await t.owner.call('git.lastCommit', where);
    assert.deepEqual([last?.subject, last?.pushedTo], ['Connect the payment client', []]);
    writeFileSync(join(dir, 'pay.ts'), 'export const stripe = connect(process.env.STRIPE_KEY);\n');
    await t.owner.call('git.stage', { ...where, paths: ['pay.ts'] });
    await t.owner.call('git.commit', { ...where, message: '', amend: true });
    assert.equal(await out('git rev-list --count HEAD', dir), '3');
    assert.equal(await out('git log -1 --format=%s', dir), 'Connect the payment client');
    assert.match(await out('git show HEAD:pay.ts', dir), /process\.env/);
    last = await t.owner.call('git.lastCommit', where);
    await sh('git push -q', dir);
    assert.deepEqual((await t.owner.call('git.lastCommit', where))?.pushedTo, ['origin/main']);

    // A pre-commit hook that says no: the hook's words, called a hook.
    writeFileSync(join(dir, 'b.ts'), 'export const b = 1;\n');
    await t.owner.call('git.stage', { ...where, paths: ['b.ts'] });
    writeFileSync(join(dir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho "lint: 3 problems in b.ts" >&2\nexit 1\n');
    chmodSync(join(dir, '.git', 'hooks', 'pre-commit'), 0o755);
    await assert.rejects(t.owner.call('git.commit', { ...where, message: 'B' }), /A git hook in this repository stopped the commit\. Git said: lint: 3 problems in b\.ts/);
    rmSync(join(dir, '.git', 'hooks', 'pre-commit'));

    // Signing asked for and failing, then no identity: each said as itself.
    await sh('git config commit.gpgsign true && git config gpg.program false', dir);
    await assert.rejects(t.owner.call('git.commit', { ...where, message: 'B' }), /could not sign the commit/);
    await sh('git config --unset commit.gpgsign', dir);
    setGitEnvironment({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.useConfigOnly', GIT_CONFIG_VALUE_0: 'true' });
    try {
      await assert.rejects(t.owner.call('git.commit', { ...where, message: 'B' }), /Git does not know who you are/);
    } finally {
      setGitEnvironment(GIT_ENV);
    }
    assert.equal(await out('git rev-list --count HEAD', dir), '3', 'no failed commit left one behind');
  } finally {
    await t.close();
  }
});

test('Write with Claude reads the staged diff, read-only, and only what is staged', async () => {
  const tools = join(process.env.TMPDIR ?? '/tmp', `wg-claude-${process.pid}`);
  mkdirSync(tools, { recursive: true });
  const claude = join(tools, 'claude');
  const asked = join(tools, 'asked');
  writeFileSync(claude, [
    '#!/bin/sh',
    `printf '%s\\n' "$@" > '${asked}'`,
    `cat <<'JSON'\n${JSON.stringify({ type: 'result', is_error: false, total_cost_usd: 0.02, structured_output: { subject: 'Add the free shipping threshold.', body: 'Orders of $75 or more ship free.' } })}\nJSON`,
  ].join('\n'), { mode: 0o755 });
  const t = await repo({ claudeBinary: claude });
  try {
    await assert.rejects(t.owner.call('git.writeMessage', { id: t.id }), /Nothing is staged/);
    writeFileSync(join(t.projectDir, 'ship.ts'), 'export const FREE_SHIPPING = 75;\n');
    await t.owner.call('git.stage', { id: t.id, paths: ['ship.ts'] });
    const unstaged = 'DRAFT_MUST_NOT_SEE_UNSTAGED_SAME_FILE';
    const separate = 'DRAFT_MUST_NOT_SEE_OTHER_TRACKED_FILE';
    const untracked = 'DRAFT_MUST_NOT_SEE_UNTRACKED_FILE';
    writeFileSync(join(t.projectDir, 'ship.ts'), `export const FREE_SHIPPING = 75;\n// ${unstaged}\n`);
    writeFileSync(join(t.projectDir, 'app.ts'), `${separate}\n`);
    writeFileSync(join(t.projectDir, 'private-note.txt'), `${untracked}\n`);
    const index = readFileSync(join(t.projectDir, '.git', 'index'));
    const head = await out('git rev-parse HEAD', t.projectDir);
    const refs = await out('git show-ref', t.projectDir);
    const written = await t.owner.call('git.writeMessage', { id: t.id });
    assert.deepEqual([written.subject, written.body, written.costUsd], ['Add the free shipping threshold', 'Orders of $75 or more ship free.', 0.02]);
    const args = readFileSync(asked, 'utf8');
    assert.match(args, /FREE_SHIPPING = 75/, 'the staged diff is in the prompt');
    for (const sentinel of [unstaged, separate, untracked]) assert.equal(args.includes(sentinel), false, `${sentinel} must not reach the drafting prompt`);
    assert.match(args, /--disallowedTools\nEdit\nWrite\nNotebookEdit\nBash/, 'with read-only tools');
    assert.deepEqual(readFileSync(join(t.projectDir, '.git', 'index')), index, 'drafting does not alter the index');
    assert.equal(await out('git rev-parse HEAD', t.projectDir), head);
    assert.equal(await out('git show-ref', t.projectDir), refs);
    assert.equal(readFileSync(join(t.projectDir, 'ship.ts'), 'utf8'), `export const FREE_SHIPPING = 75;\n// ${unstaged}\n`);
    assert.equal(readFileSync(join(t.projectDir, 'app.ts'), 'utf8'), `${separate}\n`);
    assert.equal(readFileSync(join(t.projectDir, 'private-note.txt'), 'utf8'), `${untracked}\n`);
    assert.equal(await out('git rev-list --count HEAD', t.projectDir), '2', 'nothing was committed');
  } finally {
    await t.close();
    rmSync(tools, { recursive: true, force: true });
  }
});

test('history: a graph across branches, a filter by message or author, a card’s commits named by its key, and a commit’s detail', async () => {
  const t = await repo();
  try {
    const dir = t.projectDir;
    const where = { id: t.id };
    const card = await t.owner.call('cards.create', { projectId: t.id, type: 'feature', title: 'Order history' });
    const session = await t.owner.call('sessions.start', { projectId: t.id, provider: 'shell', cardId: card.id, isolate: true });
    const wt = (await t.owner.call('cards.get', { id: card.id })).worktree!;
    await sh('echo "orders" > orders.ts && git add -A && git commit -qm "Order history page"', wt.path);
    await t.owner.call('sessions.stop', { id: session.id });
    await waitFor('stopped', async () => !(await t.owner.call('cards.get', { id: card.id })).live);
    await sh('echo three >> README.md && git commit -qam "Third on main" --author="Bob Builder <bob@example.com>"', dir);

    let log = await t.owner.call('git.log', where);
    assert.deepEqual(log.commits.map((c) => c.subject), ['Third on main', 'Second commit', 'First commit']);
    assert.equal(log.commits[0]?.refs.some((r) => r.kind === 'branch' && r.name === 'main' && r.current), true);
    assert.equal(log.commits[1]?.refs.some((r) => r.kind === 'remote' && r.name === 'origin/main'), true);

    log = await t.owner.call('git.log', { ...where, all: true });
    const order = log.commits.find((c) => c.subject === 'Order history page');
    assert.equal(order?.cardKey, card.key, 'a commit on the card’s branch carries its key');
    assert.equal(log.commits.length, 4);

    // Merged: the merge and what it brought in still carry the key after the branch is gone.
    await t.owner.call('cards.move', { id: card.id, status: 'done' });
    await t.owner.call('cards.merge', { id: card.id });
    await t.owner.call('cards.removeWorktree', { id: card.id });
    log = await t.owner.call('git.log', where);
    assert.deepEqual(log.commits.filter((c) => c.cardKey === card.key).map((c) => c.subject), [`Merge ${wt.branch}`, 'Order history page']);

    assert.deepEqual((await t.owner.call('git.log', { ...where, query: 'bob' })).commits.map((c) => c.subject), ['Third on main']);
    assert.deepEqual((await t.owner.call('git.log', { ...where, query: 'ORDER' })).commits.map((c) => c.subject), ['Order history page']);
    assert.deepEqual((await t.owner.call('git.log', { ...where, query: 'ORDER' })).searched, { read: 5, all: true });
    assert.equal((await t.owner.call('git.log', { ...where, limit: 2 })).more, true);

    const detail = await t.owner.call('git.show', { ...where, hash: order!.hash });
    assert.deepEqual([detail.subject, detail.author, detail.cardKey, detail.files.map((f) => [f.path, f.status, f.additions])], ['Order history page', 'Tess Tester', card.key, [['orders.ts', 'A', 1]]]);
    assert.match(detail.files[0]?.diff ?? '', /\+orders/);
    await assert.rejects(t.owner.call('git.show', { ...where, hash: '--output=/tmp/x' }), /not a commit/);
  } finally {
    await t.close();
  }
});

test('branches: make, switch, merge clean and conflicted, abort, delete merged and unmerged; a ref like an option is refused', async () => {
  const t = await repo();
  try {
    const dir = t.projectDir;
    const where = { id: t.id };
    await assert.rejects(t.owner.call('git.createBranch', { ...where, name: 'bad..name' }), /cannot contain/);
    await assert.rejects(t.owner.call('git.switch', { ...where, branch: '-f' }), /begins with a dash/);
    await t.owner.call('git.createBranch', { ...where, name: 'feature/banner' });
    assert.equal(await out('git branch --show-current', dir), 'feature/banner');
    await sh('echo banner > banner.ts && git add banner.ts && git commit -qm "Banner"', dir);
    await t.owner.call('git.switch', { ...where, branch: 'main' });
    const preview = await t.owner.call('git.mergePreview', { ...where, branch: 'feature/banner' });
    assert.deepEqual([preview.incoming, preview.outgoing, preview.commits.map((c) => c.subject)], [1, 0, ['Banner']]);
    let merged = await t.owner.call('git.merge', { ...where, branch: 'feature/banner' });
    assert.equal(merged.outcome, 'fast-forward');
    let branches = await t.owner.call('git.branches', where);
    assert.deepEqual(branches.local.map((b) => [b.name, b.current, b.merged]), [['main', true, true], ['feature/banner', false, true]]);
    assert.deepEqual(branches.remote.map((b) => b.name), ['origin/main']);
    await t.owner.call('git.deleteBranch', { ...where, name: 'feature/banner' });
    assert.equal(await out('git branch --list feature/banner', dir), '');

    // Two branches that change the same line: a conflict, left for the owner, then aborted.
    await sh('git switch -q -c side && sed -i.bak "s/b = 2/b = 22/" app.ts && rm app.ts.bak && git commit -qam "Side" && git switch -q main && sed -i.bak "s/b = 2/b = 222/" app.ts && rm app.ts.bak && git commit -qam "Main"', dir);
    merged = await t.owner.call('git.merge', { ...where, branch: 'side' });
    assert.deepEqual([merged.outcome, merged.conflicts], ['conflict', ['app.ts']]);
    let s = await t.owner.call('git.status', where);
    assert.deepEqual([s.operation, s.operationOf, s.conflicted.map((f) => [f.path, f.conflict])], ['merge', 'side', [['app.ts', 'both modified']]]);
    assert.match((await t.owner.call('git.diff', { ...where, path: 'app.ts', area: 'conflicted' })).diff, /\+<<<<<<< HEAD/);
    await assert.rejects(t.owner.call('git.commit', { ...where, message: 'Merge side' }), /still conflicts/);
    await t.owner.call('git.abort', where);
    s = await t.owner.call('git.status', where);
    assert.deepEqual([s.operation, s.conflicted.length], [null, 0]);
    assert.match(readFileSync(join(dir, 'app.ts'), 'utf8'), /b = 222/);

    // Resolved by hand, marked resolved, committed: the merge finishes.
    await t.owner.call('git.merge', { ...where, branch: 'side' });
    writeFileSync(join(dir, 'app.ts'), readFileSync(join(dir, 'app.ts'), 'utf8').replace(/<<<<<<< HEAD\n(.*)\n=======\n.*\n>>>>>>> side\n/, '$1\n'));
    await t.owner.call('git.stage', { ...where, paths: ['app.ts'] });
    s = await t.owner.call('git.status', where);
    assert.match(s.operationMessage ?? '', /^Merge branch 'side'/);
    await t.owner.call('git.commit', { ...where, message: "Merge branch 'side'" });
    assert.equal(await out('git log -1 --format=%P', dir).then((p) => p.split(' ').length), 2);

    // A branch with work nowhere else: kept unless forced.
    await sh('git switch -q -c spike && echo s > s.ts && git add s.ts && git commit -qm "Spike" && git switch -q main', dir);
    await assert.rejects(t.owner.call('git.deleteBranch', { ...where, name: 'spike' }), /not merged/);
    const forced = await t.owner.call('git.deleteBranch', { ...where, name: 'spike', force: true });
    assert.equal(forced.lost, 1);
    await assert.rejects(t.owner.call('git.deleteBranch', { ...where, name: 'main' }), /checked out here/);

    // A remote branch checks out as a local one that follows it.
    const other = join(t.dir, 'other');
    await sh(`git clone -q "${t.origin}" "${other}" && cd "${other}" && git switch -q -c review && echo r > r.ts && git add r.ts && git commit -qm "Review me" && git push -q -u origin review`, t.dir);
    await t.owner.call('git.fetch', where);
    await t.owner.call('git.switch', { ...where, branch: 'origin/review', remote: true });
    assert.equal(await out('git rev-parse --abbrev-ref review@{upstream}', dir), 'origin/review');
  } finally {
    await t.close();
  }
});

test('a live agent in the checkout: anything that changes its files or branch is refused with the reason; staging and pushing are not', async () => {
  const t = await repo();
  try {
    const dir = t.projectDir;
    const where = { id: t.id };
    await sh('git branch other', dir);
    writeFileSync(join(dir, 'app.ts'), 'changed\n');
    const agent = await t.owner.call('sessions.start', { projectId: t.id, provider: 'claude', title: 'Pay button' });
    for (const [method, params] of [
      ['git.switch', { branch: 'other' }], ['git.createBranch', { name: 'x' }], ['git.merge', { branch: 'other' }],
      ['git.discard', { paths: ['app.ts'], untracked: [] }], ['git.stashSave', {}], ['git.pull', {}],
    ] as const) {
      await assert.rejects(t.owner.call(method, { ...where, ...params } as never), /Claude Code \(Pay button\) is running in the project folder, so Wanigan will not .+ there/, method);
    }
    assert.equal(await out('git branch --show-current', dir), 'main');
    assert.equal(readFileSync(join(dir, 'app.ts'), 'utf8'), 'changed\n');
    const s = await t.owner.call('git.status', where);
    assert.deepEqual(s.agents.map((a) => a.title), ['Pay button']);
    await t.owner.call('git.stage', { ...where, paths: ['app.ts'] });
    await assert.rejects(t.owner.call('git.commit', { ...where, message: 'Mid-edit' }), /is working in the project folder/);
    await t.owner.call('git.commit', { ...where, message: 'Mid-edit', agentsAcknowledged: true });
    const plan = await t.owner.call('git.pushPlan', where);
    await t.owner.call('git.push', { ...where, head: plan.head!, planDigest: plan.digest });
    assert.equal(await out(`git --git-dir="${t.origin}" log -1 --format=%s main`, t.dir), 'Mid-edit');
    await t.owner.call('git.createBranch', { ...where, name: 'later', checkout: false });
    await t.owner.call('sessions.stop', { id: agent.id });
    await waitFor('ended', async () => !(await t.owner.call('git.status', where)).agents.length);
    await t.owner.call('git.switch', { ...where, branch: 'later' });
  } finally {
    await t.close();
  }
});

test('stash: save with untracked files and a message, show, apply, pop and drop; a list that moved is refused', async () => {
  const t = await repo();
  try {
    const dir = t.projectDir;
    const where = { id: t.id };
    await assert.rejects(t.owner.call('git.stashSave', { ...where }), /no changes to put aside/);
    writeFileSync(join(dir, 'README.md'), '# Site\ntwo\nwip\n');
    writeFileSync(join(dir, 'draft.md'), 'draft\n');
    await t.owner.call('git.stashSave', { ...where, message: 'Half a banner' });
    assert.equal((await t.owner.call('git.status', where)).untracked.length, 0, 'untracked files went too');
    let list = await t.owner.call('git.stashes', where);
    assert.deepEqual(list.map((s) => [s.index, s.message, s.branch]), [[0, 'Half a banner', 'main']]);
    const shown = await t.owner.call('git.stashShow', { ...where, index: 0, sha: list[0]!.sha });
    assert.deepEqual(shown.files.map((f) => [f.path, f.status, f.additions]), [['README.md', 'M', 1], ['draft.md', 'A', 1]]);

    await t.owner.call('git.stashApply', { ...where, index: 0, sha: list[0]!.sha });
    assert.equal(existsSync(join(dir, 'draft.md')), true);
    assert.equal((await t.owner.call('git.stashes', where)).length, 1, 'apply keeps the stash');
    await sh('git checkout -q -- README.md && rm draft.md && echo other > other.md && git stash push -q -u -m "Another"', dir);
    await assert.rejects(t.owner.call('git.stashApply', { ...where, index: 0, sha: list[0]!.sha, pop: true }), /stash list changed/);
    list = await t.owner.call('git.stashes', where);
    const half = list.find((s) => s.message === 'Half a banner')!;
    const r = await t.owner.call('git.stashApply', { ...where, index: half.index, sha: half.sha, pop: true });
    assert.deepEqual(r, { conflicts: [], kept: false });
    assert.deepEqual((await t.owner.call('git.stashes', where)).map((s) => s.message), ['Another']);
    const another = (await t.owner.call('git.stashes', where))[0]!;
    await t.owner.call('git.stashDrop', { ...where, index: another.index, sha: another.sha });
    assert.deepEqual(await t.owner.call('git.stashes', where), []);
  } finally {
    await t.close();
  }
});

test('remote: fetch, push with a plan and a scan, set an upstream, never force; pull fast-forwards or says exactly why not', async () => {
  const t = await repo();
  try {
    const dir = t.projectDir;
    const where = { id: t.id };
    let plan = await t.owner.call('git.pushPlan', where);
    assert.match(plan.refusal ?? '', /Nothing to push: main matches origin\/main/);
    await sh('echo a >> README.md && git commit -qam "Local one" && echo b >> README.md && git commit -qam "Local two"', dir);
    plan = await t.owner.call('git.pushPlan', where);
    assert.deepEqual([plan.branch, plan.remote, plan.remoteBranch, plan.upstream, plan.setUpstream, plan.total, plan.refusal], ['main', 'origin', 'main', 'origin/main', false, 2, null]);
    assert.deepEqual(plan.commits.map((c) => c.subject), ['Local two', 'Local one']);
    assert.equal(plan.url, t.origin);
    await assert.rejects(t.owner.call('git.push', { ...where, head: 'deadbeef', planDigest: plan.digest }), /moved since the push was shown/);
    const pushed = await t.owner.call('git.push', { ...where, head: plan.head!, planDigest: plan.digest });
    assert.deepEqual(pushed, { pushed: 2, to: 'origin/main' });
    assert.equal(await out(`git --git-dir="${t.origin}" rev-parse main`, t.dir), await out('git rev-parse HEAD', dir));

    // A new branch: the plan sets its upstream; a secret in one of its commits needs acknowledging, though a later commit removed it.
    await t.owner.call('git.createBranch', { ...where, name: 'feature/keys' });
    const token = ['gh', 'p_', 'R8sK2mQ9vX4wL7zT1nB5cY3dF6hJ0gAeP2uM'].join('');
    await sh(`echo 'const t = "${token}";' > t.ts && git add t.ts && git commit -qm "Add" && git rm -q t.ts && git commit -qm "Remove"`, dir);
    plan = await t.owner.call('git.pushPlan', where);
    assert.deepEqual([plan.setUpstream, plan.upstream, plan.total], [true, null, 2]);
    const scan = await t.owner.call('git.scan', { ...where, action: 'push' });
    assert.deepEqual(scan.findings.map((f) => [f.file, f.rule]), [['t.ts', 'github-token']]);
    await assert.rejects(t.owner.call('git.push', { ...where, head: plan.head!, planDigest: plan.digest }), /possible secret/);
    await t.owner.call('git.push', { ...where, head: plan.head!, planDigest: plan.digest, acknowledge: scan.digest });
    assert.equal(await out('git rev-parse --abbrev-ref feature/keys@{upstream}', dir), 'origin/feature/keys');

    // Behind: push refuses before anything is sent; pull fast-forwards.
    await t.owner.call('git.switch', { ...where, branch: 'main' });
    const other = join(t.dir, 'other');
    await sh(`git clone -q "${t.origin}" "${other}" && cd "${other}" && echo x > x.txt && git add x.txt && git commit -qm "From elsewhere" && git push -q`, t.dir);
    await t.owner.call('git.fetch', where);
    await sh('echo c >> README.md && git commit -qam "Local three"', dir);
    plan = await t.owner.call('git.pushPlan', where);
    assert.match(plan.refusal ?? '', /origin\/main has 1 commit main does not\. Pull first; Wanigan never force-pushes/);
    await assert.rejects(t.owner.call('git.pull', where), /main and origin\/main have diverged: 1 commit here is not on origin\/main, and 1 there is not here/);
    await sh('git reset -q --hard HEAD~1', dir);
    assert.deepEqual(await t.owner.call('git.pull', where), { pulled: 1, from: 'origin/main', outcome: 'fast-forward', conflicts: [] });
    assert.equal(await out('git log -1 --format=%s', dir), 'From elsewhere');
    assert.deepEqual(await t.owner.call('git.pull', where), { pulled: 0, from: 'origin/main', outcome: 'up-to-date', conflicts: [] });

    // A non-fast-forward the remote itself refuses: said, never forced.
    await sh(`cd "${other}" && git pull -q && echo y > y.txt && git add y.txt && git commit -qm "Elsewhere again" && git push -q`, t.dir);
    await sh('echo d >> README.md && git commit -qam "Local four"', dir);
    plan = await t.owner.call('git.pushPlan', where);
    assert.equal(plan.refusal, null, 'not fetched yet, so the plan does not know');
    await assert.rejects(t.owner.call('git.push', { ...where, head: plan.head!, planDigest: plan.digest }), /The remote has commits this branch does not, so the push was refused/);
  } finally {
    await t.close();
  }
});

test('the branch’s pull request through gh: status with checks and review, a draft refused until pushed, and creating one', async () => {
  const tools = join(process.env.TMPDIR ?? '/tmp', `wg-gh-${process.pid}`);
  mkdirSync(tools, { recursive: true });
  const gh = join(tools, 'gh');
  const log = join(tools, 'calls');
  const view = JSON.stringify({
    number: 7, title: 'Banner', url: 'https://github.com/example/site/pull/7', state: 'OPEN', isDraft: false, reviewDecision: 'REVIEW_REQUIRED', baseRefName: 'main',
    statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { status: 'IN_PROGRESS', conclusion: '' }],
  });
  writeFileSync(gh, [
    '#!/bin/sh',
    `printf '%s ' "$@" >> '${log}'; echo >> '${log}'`,
    'case "$1 $2" in',
    '  "auth status") exit 0 ;;',
    `  "pr view") if [ -f '${tools}/opened' ]; then echo '${view}'; else echo 'no pull requests found for branch "feature/banner"' >&2; exit 1; fi ;;`,
    `  "pr create") touch '${tools}/opened'; echo 'https://github.com/example/site/pull/7' ;;`,
    'esac',
  ].join('\n'), { mode: 0o755 });
  const t = await repo({ ghBinary: gh });
  try {
    const where = { id: t.id };
    await t.owner.call('git.createBranch', { ...where, name: 'feature/banner' });
    await sh('echo banner > banner.ts && git add banner.ts && git commit -qm "Show the free shipping banner"', t.projectDir);
    assert.equal((await t.owner.call('git.pullRequest', where)).state, 'none');
    let draft = await t.owner.call('git.pullRequestDraft', where);
    assert.deepEqual([draft.branch, draft.base, draft.title], ['feature/banner', 'main', 'Show the free shipping banner']);
    assert.match(draft.refusal ?? '', /not on origin yet\. Push it first/);
    await assert.rejects(t.owner.call('git.openPullRequest', { ...where, title: 'Banner', body: '', base: 'main' }), /Push it first/);
    const plan = await t.owner.call('git.pushPlan', where);
    await t.owner.call('git.push', { ...where, head: plan.head!, planDigest: plan.digest });
    draft = await t.owner.call('git.pullRequestDraft', where);
    assert.equal(draft.refusal, null);
    const { url } = await t.owner.call('git.openPullRequest', { ...where, title: 'Banner', body: 'Over $75.', base: 'main' });
    assert.equal(url, 'https://github.com/example/site/pull/7');
    assert.match(readFileSync(log, 'utf8'), /pr create --head feature\/banner --base main --title Banner --body Over \$75\./);
    const pr = await t.owner.call('git.pullRequest', where);
    assert.deepEqual([pr.state, pr.number, pr.review, pr.checks], ['open', 7, 'required', { passed: 1, failed: 0, pending: 1, other: 0 }]);
  } finally {
    await t.close();
    rmSync(tools, { recursive: true, force: true });
  }
});

test('merging a card says what really stopped it: a conflict, or a hook', async () => {
  const t = await repo();
  try {
    const dir = t.projectDir;
    const card = await t.owner.call('cards.create', { projectId: t.id, type: 'task', title: 'Edit b' });
    const session = await t.owner.call('sessions.start', { projectId: t.id, provider: 'shell', cardId: card.id, isolate: true });
    const wt = (await t.owner.call('cards.get', { id: card.id })).worktree!;
    await sh('sed -i.bak "s/b = 2/b = 3/" app.ts && rm app.ts.bak && git commit -qam "Card edit"', wt.path);
    await t.owner.call('sessions.stop', { id: session.id });
    await waitFor('stopped', async () => !(await t.owner.call('cards.get', { id: card.id })).live);
    await sh('sed -i.bak "s/b = 2/b = 4/" app.ts && rm app.ts.bak && git commit -qam "Main edit"', dir);
    const before = await out('git rev-parse HEAD', dir);
    await assert.rejects(t.owner.call('cards.merge', { id: card.id }), /The merge conflicted: both sides changed the same lines\. It was undone, and nothing changed\. Resolve it in the project folder, or bring main into the card’s branch/);
    assert.equal(await out('git rev-parse HEAD', dir), before);
    await sh('git reset -q --hard HEAD~1', dir);
    writeFileSync(join(dir, '.git', 'hooks', 'commit-msg'), '#!/bin/sh\necho "commit messages need a ticket number" >&2\nexit 1\n');
    chmodSync(join(dir, '.git', 'hooks', 'commit-msg'), 0o755);
    await assert.rejects(t.owner.call('cards.merge', { id: card.id }), /A git hook in this repository stopped the merge\. Git said: commit messages need a ticket number It was undone/);
    assert.equal(existsSync(join(dir, '.git', 'MERGE_HEAD')), false);
  } finally {
    await t.close();
  }
});

test('a push scans secrets introduced only by a merge resolution', async () => {
  const t = await repo();
  try {
    const dir = t.projectDir;
    const where = { id: t.id };
    await sh('git switch -qc side && echo side > side.txt && git add side.txt && git commit -qm side && git switch -q main && echo main > main.txt && git add main.txt && git commit -qm main && git merge --no-ff --no-commit side', dir);
    const key = ['sk', 'live', 'A1b2C3d4E5f6G7h8J9k0L1m2'].join('_');
    writeFileSync(join(dir, 'merged.ts'), `export const paymentKey = '${key}';\n`);
    await sh('git add merged.ts && git commit -qm "Merge side with a resolution"', dir);
    const scan = await t.owner.call('git.scan', { ...where, action: 'push' });
    assert.deepEqual(scan.findings.map((f) => [f.file, f.rule]), [['merged.ts', 'stripe-live-key']]);
    const plan = await t.owner.call('git.pushPlan', where);
    const before = await out(`git --git-dir="${t.origin}" rev-parse main`, t.dir);
    await assert.rejects(t.owner.call('git.push', { ...where, head: plan.head!, planDigest: plan.digest }), /possible secret/);
    assert.equal(await out(`git --git-dir="${t.origin}" rev-parse main`, t.dir), before);
  } finally {
    await t.close();
  }
});


test('an untracked diff refreshed after whole-file or partial staging is empty, without hiding staged work', async () => {
  const t = await repo();
  try {
    const where = { id: t.id, path: 'new.txt' };
    writeFileSync(join(t.projectDir, 'new.txt'), 'one\ntwo\n');
    const first = await t.owner.call('git.diff', { ...where, area: 'untracked' });
    assert.match(first.diff, /\+one\n\+two/);
    await t.owner.call('git.stage', { id: t.id, paths: ['new.txt'] });
    // The git event reaches the old diff before the refreshed status removes it.
    assert.deepEqual(await t.owner.call('git.diff', { ...where, area: 'untracked' }), { path: 'new.txt', diff: '', truncated: false });
    assert.match((await t.owner.call('git.diff', { ...where, area: 'staged' })).diff, /\+one\n\+two/);
    assert.equal(await sh('git show :new.txt', t.projectDir), 'one\ntwo\n');

    await t.owner.call('git.unstage', { id: t.id, paths: ['new.txt'] });
    const again = await t.owner.call('git.diff', { ...where, area: 'untracked' });
    assert.equal(again.diff, first.diff);
    await t.owner.call('git.applyPart', { ...where, area: 'untracked', action: 'stage', pick: { old: [], new: [1] }, digest: diffHash(again.diff) });
    assert.deepEqual(await t.owner.call('git.diff', { ...where, area: 'untracked' }), { path: 'new.txt', diff: '', truncated: false });
    assert.equal(await sh('git show :new.txt', t.projectDir), 'one\n');
    assert.match((await t.owner.call('git.diff', { ...where, area: 'changed' })).diff, /\+two/);
    assert.equal(readFileSync(join(t.projectDir, 'new.txt'), 'utf8'), 'one\ntwo\n');
  } finally {
    await t.close();
  }
});

test('an untracked diff cannot read through a directory link outside the checkout', async () => {
  const t = await repo();
  try {
    const outside = join(t.dir, 'private');
    mkdirSync(outside);
    writeFileSync(join(outside, 'note.txt'), 'outside private contents\n');
    symlinkSync(outside, join(t.projectDir, 'linked'));
    await assert.rejects(t.owner.call('git.diff', { id: t.id, path: 'linked/note.txt', area: 'untracked' }), /outside the project|not an untracked file/);
    await assert.rejects(t.owner.call('git.diff', { id: t.id, path: '.git/config', area: 'untracked' }), /not an untracked file/);
    writeFileSync(join(t.projectDir, 'new.txt'), 'inside new contents\n');
    assert.match((await t.owner.call('git.diff', { id: t.id, path: 'new.txt', area: 'untracked' })).diff, /inside new contents/);
  } finally {
    await t.close();
  }
});

test('push previews show every push URL, including a destination different from the fetch URL', async () => {
  const t = await repo();
  try {
    const first = join(t.dir, 'published.git');
    const second = join(t.dir, 'mirror.git');
    await sh(`git remote set-url --push origin "${first}" && git remote set-url --add --push origin "${second}"`, t.projectDir);
    const plan = await t.owner.call('git.pushPlan', { id: t.id });
    assert.equal(plan.url, `${first}\n${second}`);
    const { planPullRequest } = await import('./pulls.ts');
    const cardPlan = await planPullRequest(t.projectDir, { path: t.projectDir, branch: 'main', base: 'main' }, 'Preview', null);
    assert.equal(cardPlan.remote, `${first}\n${second}`);
  } finally {
    await t.close();
  }
});

test('an agent in a checkout opened as another project still blocks changes to that checkout', async () => {
  const t = await repo();
  try {
    const card = await t.owner.call('cards.create', { projectId: t.id, type: 'task', title: 'Isolated work' });
    const initial = await t.owner.call('sessions.start', { projectId: t.id, provider: 'shell', cardId: card.id, isolate: true });
    const wt = (await t.owner.call('cards.get', { id: card.id })).worktree!;
    await t.owner.call('sessions.stop', { id: initial.id });
    await waitFor('card session ended', async () => !(await t.owner.call('cards.get', { id: card.id })).live);
    const alias = await t.owner.call('projects.add', { path: wt.path });
    const agent = await t.owner.call('sessions.start', { projectId: alias.id, provider: 'claude' });
    await assert.rejects(t.owner.call('git.createBranch', { id: t.id, cardId: card.id, name: 'must-not-switch' }), /running.*will not switch branches/);
    await assert.rejects(t.owner.call('cards.removeWorktree', { id: card.id }), /running.*will not remove/);
    assert.equal(await out('git branch --show-current', wt.path), wt.branch);
    assert.equal(existsSync(wt.path), true);
    await t.owner.call('sessions.stop', { id: agent.id });

    const nested = join(t.projectDir, 'nested');
    mkdirSync(nested);
    const subproject = await t.owner.call('projects.add', { path: nested });
    await t.owner.call('sessions.start', { projectId: subproject.id, provider: 'claude' });
    await assert.rejects(t.owner.call('git.createBranch', { id: t.id, name: 'must-not-switch-parent' }), /running.*will not switch branches/);
  } finally {
    await t.close();
  }
});

test('simultaneous stash drops cannot delete the next stash after both validated the same one', async () => {
  const t = await repo();
  try {
    const dir = t.projectDir;
    await sh('echo first > first.txt && git stash push -qu -m first && echo second > second.txt && git stash push -qu -m second', dir);
    const original = await t.owner.call('git.stashes', { id: t.id });
    assert.equal(original.length, 2);
    const otherPath = join(t.dir, 'other-worktree');
    await sh(`git worktree add -qb other-worktree "${otherPath}"`, dir);
    const otherProject = await t.owner.call('projects.add', { path: otherPath });
    const bin = join(t.dir, 'bin');
    mkdirSync(bin);
    const actualGit = await out('command -v git', dir);
    const first = join(t.dir, 'first-drop');
    const finished = join(t.dir, 'drop-finished');
    // Give the other request time to validate the same ordinal, then order its
    // git command after the first completed. The wrapper forwards every other call.
    writeFileSync(join(bin, 'git'), `#!/bin/sh\nif [ "$3" = stash ] && [ "$4" = drop ]; then\n  if mkdir '${first}' 2>/dev/null; then\n    sleep 0.4\n    '${actualGit}' "$@"\n    code=$?\n    touch '${finished}'\n    exit "$code"\n  fi\n  while [ ! -f '${finished}' ]; do sleep 0.01; done\nfi\nexec '${actualGit}' "$@"\n`, { mode: 0o755 });
    setGitEnvironment({ ...GIT_ENV, PATH: `${bin}:${process.env.PATH}` });
    try {
      const params = { id: t.id, index: original[0]!.index, sha: original[0]!.sha };
      const results = await Promise.allSettled([t.owner.call('git.stashDrop', params), t.owner.call('git.stashDrop', { ...params, id: otherProject.id })]);
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
      assert.deepEqual((await t.owner.call('git.stashes', { id: t.id })).map((s) => s.sha), [original[1]!.sha], 'the other stash is preserved');
    } finally {
      setGitEnvironment(GIT_ENV);
    }
  } finally {
    await t.close();
  }
});

test('a different push destination scans history already present on the fetch remote', async () => {
  const t = await repo();
  try {
    const dir = t.projectDir;
    const key = ['sk', 'live', 'A1b2C3d4E5f6G7h8J9k0L1m2'].join('_');
    writeFileSync(join(dir, 'private.ts'), `export const key = '${key}';\n`);
    await sh('git add private.ts && git commit -qm private && git push -q && git rm -q private.ts && git commit -qm clean', dir);
    const destination = join(t.dir, 'public.git');
    await sh(`git init -q --bare "${destination}" && git remote set-url --push origin "${destination}"`, dir);
    const scan = await t.owner.call('git.scan', { id: t.id, action: 'push' });
    assert.equal(scan.findings.some((f) => f.file === 'private.ts' && f.rule === 'stripe-live-key'), true);
    const plan = await t.owner.call('git.pushPlan', { id: t.id });
    await assert.rejects(t.owner.call('git.push', { id: t.id, head: plan.head!, planDigest: plan.digest }), /possible secret/);
    assert.equal(await out(`git --git-dir="${destination}" for-each-ref`, t.dir), '', 'the new destination receives no history');
  } finally {
    await t.close();
  }
});
