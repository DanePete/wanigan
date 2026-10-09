// Resolving merge conflicts in the workbench, on real repositories with real
// conflicts: content in many hunks, a hand edit, add/add, modify/delete both
// ways, a binary file. Each outcome is read back from git: the index's
// conflict stages gone, the file's content, MERGE_HEAD gone once the merge is
// committed. Nothing here reads the owner's git config or home.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Params } from '../shared/protocol.ts';
import { parseConflicts, resolveConflicts, type HunkChoice } from '../shared/conflict.ts';
import { testCore, waitFor, type TestCore } from './test-support.ts';

const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Tess Tester', GIT_AUTHOR_EMAIL: 'tess@example.com', GIT_COMMITTER_NAME: 'Tess Tester', GIT_COMMITTER_EMAIL: 'tess@example.com',
};

const sh = (command: string, cwd: string): Promise<string> => new Promise((ok, fail) => execFile('/bin/sh', ['-c', command], { cwd, env: { ...process.env, ...GIT_ENV } },
  (error, stdout, stderr) => (error ? fail(new Error(`${command}: ${stderr}`)) : ok(String(stdout)))));
const out = async (command: string, cwd: string): Promise<string> => (await sh(command, cwd)).trim();

/** Resolving from a freshly opened panel carries the exact version it showed. */
async function resolveFile(t: TestCore, params: Params<'git.resolve'>): Promise<{ left: number }> {
  const shown = await t.owner.call('git.conflict', params);
  return t.owner.call('git.resolve', { ...params, digest: shown.digest });
}

const lines = (n: number, f: (i: number) => string): string => `${Array.from({ length: n }, (_, i) => f(i)).join('\n')}\n`;

/**
 * main and side, both changed from one base: app.ts in three far-apart places
 * (three conflicts), new.ts added by both, gone.ts deleted on main and changed
 * on side, kept.ts changed on main and deleted on side, logo.bin changed by both.
 */
async function conflicted(): Promise<TestCore & { id: string; dir: string }> {
  const t = await testCore({ gitEnv: GIT_ENV });
  const dir = t.projectDir;
  writeFileSync(join(dir, 'app.ts'), lines(40, (i) => `export const v${i} = ${i};`));
  writeFileSync(join(dir, 'gone.ts'), 'export const gone = 1;\n');
  writeFileSync(join(dir, 'kept.ts'), 'export const kept = 1;\n');
  writeFileSync(join(dir, 'logo.bin'), Buffer.from([0, 1, 2, 3]));
  await sh('git init -q -b main && git add -A && git commit -qm base && git switch -q -c side', dir);
  writeFileSync(join(dir, 'app.ts'), lines(40, (i) => `export const v${i} = ${[2, 20, 35].includes(i) ? `${i} * 100` : i};`));
  writeFileSync(join(dir, 'new.ts'), 'export const fresh = "side";\n');
  writeFileSync(join(dir, 'gone.ts'), 'export const gone = 2;\n');
  writeFileSync(join(dir, 'logo.bin'), Buffer.from([0, 9, 9, 9]));
  await sh('git rm -q kept.ts && git add -A && git commit -qm side && git switch -q main', dir);
  writeFileSync(join(dir, 'app.ts'), lines(40, (i) => `export const v${i} = ${[2, 20, 35].includes(i) ? `-${i}` : i};`));
  writeFileSync(join(dir, 'new.ts'), 'export const fresh = "main";\n');
  writeFileSync(join(dir, 'kept.ts'), 'export const kept = 2;\n');
  writeFileSync(join(dir, 'logo.bin'), Buffer.from([0, 7, 7, 7]));
  await sh('git rm -q gone.ts && git add -A && git commit -qm main', dir);
  const project = await t.owner.call('projects.add', { path: dir });
  return Object.assign(t, { id: project.id, dir });
}

test('a merge that conflicts lists each unmerged state, and reads each file’s three versions for the resolver', async () => {
  const t = await conflicted();
  try {
    const where = { id: t.id };
    const r = await t.owner.call('git.merge', { ...where, branch: 'side' });
    assert.equal(r.outcome, 'conflict');
    const s = await t.owner.call('git.status', where);
    assert.deepEqual(s.conflicted.map((f) => [f.path, f.code, f.hunks]), [
      ['app.ts', 'UU', 3], ['gone.ts', 'DU', 0], ['kept.ts', 'UD', 0], ['logo.bin', 'UU', null], ['new.ts', 'AA', 1],
    ]);
    const app = await t.owner.call('git.conflict', { ...where, path: 'app.ts' });
    assert.deepEqual([app.code, app.stages, app.oursLabel, app.theirsLabel, app.binary, app.inFile, app.edited], ['UU', { base: true, ours: true, theirs: true }, 'main', 'side', false, 3, false]);
    const hunks = parseConflicts(app.merged ?? '').hunks;
    assert.deepEqual(hunks.map((h) => [h.ours, h.base, h.theirs]), [
      [['export const v2 = -2;'], ['export const v2 = 2;'], ['export const v2 = 2 * 100;']],
      [['export const v20 = -20;'], ['export const v20 = 20;'], ['export const v20 = 20 * 100;']],
      [['export const v35 = -35;'], ['export const v35 = 35;'], ['export const v35 = 35 * 100;']],
    ], 'diff3: the base sits between the sides');
    assert.match(readFileSync(join(t.dir, 'app.ts'), 'utf8'), /<<<<<<< HEAD/, 'reading it changed nothing in the file');
    const gone = await t.owner.call('git.conflict', { ...where, path: 'gone.ts' });
    assert.deepEqual([gone.stages, gone.merged], [{ base: true, ours: false, theirs: true }, null]);
    const added = await t.owner.call('git.conflict', { ...where, path: 'new.ts' });
    assert.deepEqual([added.stages.base, parseConflicts(added.merged ?? '').hunks[0]?.ours], [false, ['export const fresh = "main";']]);
    assert.equal((await t.owner.call('git.conflict', { ...where, path: 'logo.bin' })).binary, true);
    await assert.rejects(t.owner.call('git.conflict', { ...where, path: 'README.md' }), /not conflicted/);
  } finally {
    await t.close();
  }
});

test('git’s own grouping of conflicts, or its diff3 style, is not taken for an edit, and the count is the resolver’s', async () => {
  const t = await testCore({ gitEnv: GIT_ENV });
  try {
    const dir = t.projectDir;
    const copy = (top: string, shipping: string, last: string): string =>
      `${top ? `${top}\n\n` : ''}export const COPY = {\n  browse: 'Browse',\n  shipping: ${shipping},\n  remove: 'Remove',\n  undo: 'Undo',\n${last ? `  ${last}\n` : ''}};\n`;
    writeFileSync(join(dir, 'copy.ts'), copy('', "'Free over $75'", ''));
    await sh('git init -q -b main && git add -A && git commit -qm base && git switch -q -c side', dir);
    writeFileSync(join(dir, 'copy.ts'), copy("import { money } from './money';", 'money(75)', "total: 'Total',"));
    await sh('git commit -qam side && git switch -q main', dir);
    writeFileSync(join(dir, 'copy.ts'), copy("import { OVER } from './settings';", '`Free over ${OVER}`', "checkout: 'Check out',"));
    await sh('git commit -qam main', dir);
    const project = await t.owner.call('projects.add', { path: dir });
    const where = { id: project.id };
    await t.owner.call('git.merge', { ...where, branch: 'side' });
    // git's merge style runs the second and third conflicts together (only "remove" and "undo" sit between); the resolver shows three.
    const written = readFileSync(join(dir, 'copy.ts'), 'utf8');
    const c = await t.owner.call('git.conflict', { ...where, path: 'copy.ts' });
    assert.deepEqual([c.inFile, parseConflicts(c.merged ?? '').hunks.length, c.edited], [parseConflicts(written).hunks.length, 3, false]);
    assert.ok(c.inFile! < 3, 'git grouped them');
    assert.equal((await t.owner.call('git.status', where)).conflicted[0]?.hunks, 3);
    // Written again in diff3 style (merge.conflictStyle), still git's own work: not an edit.
    await sh('git -c merge.conflictStyle=diff3 checkout -m -- copy.ts', dir);
    assert.match(readFileSync(join(dir, 'copy.ts'), 'utf8'), /^\|{7}/m);
    assert.equal((await t.owner.call('git.conflict', { ...where, path: 'copy.ts' })).edited, false);
    // One conflict resolved in an editor: now it is, and the count is what is left in the file.
    writeFileSync(join(dir, 'copy.ts'), resolveConflicts(parseConflicts(written), new Map([[0, 'ours']])).text);
    const edited = await t.owner.call('git.conflict', { ...where, path: 'copy.ts' });
    assert.deepEqual([edited.edited, (await t.owner.call('git.status', where)).conflicted[0]?.hunks], [true, edited.inFile]);
  } finally {
    await t.close();
  }
});

test('resolving: hunk choices written and staged, markers refused unless kept on purpose, sides and removals, then the merge committed', async () => {
  const t = await conflicted();
  try {
    const where = { id: t.id };
    await t.owner.call('git.merge', { ...where, branch: 'side' });
    const stages = (path: string): Promise<string> => out(`git ls-files -u -- ${path}`, t.dir);

    // Three hunks: ours, both (theirs first), and a hand edit.
    const app = parseConflicts((await t.owner.call('git.conflict', { ...where, path: 'app.ts' })).merged ?? '');
    const half = resolveConflicts(app, new Map([[0, 'ours']]));
    await assert.rejects(resolveFile(t, { ...where, path: 'app.ts', content: half.text }), /still has 2 conflicts with their markers in/);
    assert.notEqual(await stages('app.ts'), '', 'refused: still conflicted');
    const done = resolveConflicts(app, new Map<number, HunkChoice>([[0, 'ours'], [1, 'theirs-then-ours'], [2, { text: 'export const v35 = 3500; // agreed\n' }]]));
    let r = await resolveFile(t, { ...where, path: 'app.ts', content: done.text });
    assert.equal(r.left, 4);
    assert.equal(await stages('app.ts'), '', 'its conflict stages are gone');
    const app2 = readFileSync(join(t.dir, 'app.ts'), 'utf8');
    assert.match(app2, /^export const v2 = -2;$/m);
    assert.match(app2, /export const v20 = 20 \* 100;\nexport const v20 = -20;/);
    assert.match(app2, /^export const v35 = 3500; \/\/ agreed$/m);
    assert.equal(app2.split('\n').length, 42, 'one line more than it had: the hunk where both were kept');
    assert.equal(await out('git show :app.ts', t.dir), app2.trimEnd(), 'and that is what is staged');

    // Added by both: kept with its markers, because the owner said so.
    const fresh = (await t.owner.call('git.conflict', { ...where, path: 'new.ts' })).merged ?? '';
    await resolveFile(t, { ...where, path: 'new.ts', content: fresh, keepMarkers: true });
    assert.match(await out('git show :new.ts', t.dir), /<<<<<<< main/);

    // Deleted by us, changed by them: theirs keeps it. Changed by us, deleted by them: theirs removes it.
    await resolveFile(t, { ...where, path: 'gone.ts', side: 'theirs' });
    assert.equal(readFileSync(join(t.dir, 'gone.ts'), 'utf8'), 'export const gone = 2;\n');
    await resolveFile(t, { ...where, path: 'kept.ts', side: 'theirs' });
    assert.equal(existsSync(join(t.dir, 'kept.ts')), false);
    assert.equal(await out('git ls-files -- kept.ts', t.dir), '');

    // A binary file: one side whole.
    r = await resolveFile(t, { ...where, path: 'logo.bin', side: 'ours' });
    assert.equal(r.left, 0);
    assert.deepEqual([...readFileSync(join(t.dir, 'logo.bin'))], [0, 7, 7, 7]);

    // Nothing conflicts: the commit finishes the merge with git's message, and MERGE_HEAD goes.
    const s = await t.owner.call('git.status', where);
    assert.deepEqual([s.operation, s.conflicted.length], ['merge', 0]);
    assert.match(s.operationMessage ?? '', /^Merge branch 'side'/);
    await assert.rejects(t.owner.call('git.continue', where), /finished by committing it/);
    await t.owner.call('git.commit', { ...where, message: "Merge branch 'side'" });
    assert.equal(existsSync(join(t.dir, '.git', 'MERGE_HEAD')), false);
    assert.equal((await out('git log -1 --format=%P', t.dir)).split(' ').length, 2);
    assert.equal((await t.owner.call('git.status', where)).operation, null);
    await assert.rejects(t.owner.call('git.resolve', { ...where, path: 'app.ts', side: 'ours' }), /not conflicted any more/);
  } finally {
    await t.close();
  }
});

test('a whole file taken from one side, a hand edit noticed, and resolving refused while an agent works there', async () => {
  const t = await conflicted();
  try {
    const where = { id: t.id };
    await t.owner.call('git.merge', { ...where, branch: 'side' });
    // Two of the three conflicts resolved by hand in an editor: the resolver says the file was edited.
    const text = readFileSync(join(t.dir, 'app.ts'), 'utf8');
    const edited = resolveConflicts(parseConflicts(text), new Map([[0, 'ours'], [1, 'ours']])).text;
    writeFileSync(join(t.dir, 'app.ts'), edited);
    const app = await t.owner.call('git.conflict', { ...where, path: 'app.ts' });
    assert.deepEqual([app.inFile, app.edited], [1, true]);
    assert.equal((await t.owner.call('git.status', where)).conflicted.find((f) => f.path === 'app.ts')?.hunks, 1);

    const agent = await t.owner.call('sessions.start', { projectId: t.id, provider: 'claude', title: 'Resolver' });
    await assert.rejects(resolveFile(t, { ...where, path: 'app.ts', side: 'theirs' }), /running in the project folder, so Wanigan will not resolve conflicts there/);
    await assert.rejects(t.owner.call('git.abort', where), /will not abort it there/);
    await t.owner.call('sessions.stop', { id: agent.id });
    await waitFor('ended', async () => !(await t.owner.call('git.status', where)).agents.length);

    // Ticked off as it is on disk: refused while a conflict's markers are still in it, staged as written once they are gone.
    await assert.rejects(t.owner.call('git.resolve', { ...where, path: 'app.ts', asIs: true }), /app\.ts still has 1 conflict with its markers in/);
    assert.equal(await out('git ls-files -u -- app.ts | wc -l', t.dir), '3');
    writeFileSync(join(t.dir, 'new.ts'), 'export const fresh = "both";\n');
    assert.deepEqual(await t.owner.call('git.resolve', { ...where, path: 'new.ts', asIs: true }), { left: 4 });
    assert.equal(await out('git ls-files -u -- new.ts', t.dir), '');
    assert.equal(await out('git show :new.ts', t.dir), 'export const fresh = "both";');

    await resolveFile(t, { ...where, path: 'app.ts', side: 'theirs' });
    assert.match(readFileSync(join(t.dir, 'app.ts'), 'utf8'), /^export const v2 = 2 \* 100;$/m);
    assert.equal(await out('git ls-files -u -- app.ts', t.dir), '');
    // And the whole merge abandoned: back to main as it was.
    await t.owner.call('git.abort', where);
    assert.equal(existsSync(join(t.dir, '.git', 'MERGE_HEAD')), false);
    assert.match(readFileSync(join(t.dir, 'app.ts'), 'utf8'), /^export const v2 = -2;$/m);
  } finally {
    await t.close();
  }
});

test('a pull that cannot fast-forward merges only when asked, and its conflict is left to resolve', async () => {
  const t = await testCore({ gitEnv: GIT_ENV });
  try {
    const dir = t.projectDir;
    const origin = join(t.dir, 'origin.git');
    const other = join(t.dir, 'other');
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    await sh(`git init -q -b main && git add -A && git commit -qm one && git init -q --bare -b main "${origin}" && git remote add origin "${origin}" && git push -q -u origin main`, dir);
    await sh(`git clone -q "${origin}" "${other}" && cd "${other}" && echo theirs > a.txt && git commit -qam theirs && git push -q`, t.dir);
    writeFileSync(join(dir, 'a.txt'), 'ours\n');
    await sh('git commit -qam ours', dir);
    const project = await t.owner.call('projects.add', { path: dir });
    const where = { id: project.id };
    await assert.rejects(t.owner.call('git.pull', where), /have diverged.+Merge origin\/main into main instead/);
    assert.equal(existsSync(join(dir, '.git', 'MERGE_HEAD')), false, 'refused: nothing started');
    const r = await t.owner.call('git.pull', { ...where, merge: true });
    assert.deepEqual([r.outcome, r.conflicts, r.from], ['conflict', ['a.txt'], 'origin/main']);
    const s = await t.owner.call('git.status', where);
    assert.deepEqual([s.operation, s.operationOf], ['merge', 'origin/main']);
    await resolveFile(t, { ...where, path: 'a.txt', content: 'ours and theirs\n' });
    await t.owner.call('git.commit', { ...where, message: "Merge remote-tracking branch 'origin/main'" });
    assert.equal((await t.owner.call('git.status', where)).ahead, 2);
  } finally {
    await t.close();
  }
});

test('a card’s merge that conflicts is undone, or left in the project folder to resolve when asked', async () => {
  const t = await testCore({ gitEnv: GIT_ENV });
  try {
    const dir = t.projectDir;
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    await sh('git init -q -b main && git add -A && git commit -qm one', dir);
    const project = await t.owner.call('projects.add', { path: dir });
    const card = await t.owner.call('cards.create', { projectId: project.id, type: 'task', title: 'Change a' });
    const session = await t.owner.call('sessions.start', { projectId: project.id, provider: 'shell', cardId: card.id, isolate: true });
    const wt = (await t.owner.call('cards.get', { id: card.id })).worktree!;
    await sh('echo card > a.txt && git commit -qam card', wt.path);
    await t.owner.call('sessions.stop', { id: session.id });
    await waitFor('stopped', async () => !(await t.owner.call('cards.get', { id: card.id })).live);
    await sh('echo main > a.txt && git commit -qam main', dir);
    // Not while an agent works in the folder the merge would change.
    const agent = await t.owner.call('sessions.start', { projectId: project.id, provider: 'claude', title: 'Elsewhere' });
    await assert.rejects(t.owner.call('cards.merge', { id: card.id }), /is running in the project folder, so Wanigan will not merge wanigan\/.+ there/);
    await t.owner.call('sessions.stop', { id: agent.id });
    await waitFor('ended', async () => !(await t.owner.call('git.status', { id: project.id })).agents.length);
    await assert.rejects(t.owner.call('cards.merge', { id: card.id }), (e: Error & { code?: string }) => {
      assert.equal(e.code, 'conflict');
      assert.match(e.message, /conflicted.+undone.+Resolve it in the project folder.+ It conflicted in a\.txt\.$/);
      return true;
    });
    assert.equal(existsSync(join(dir, '.git', 'MERGE_HEAD')), false);
    const r = await t.owner.call('cards.merge', { id: card.id, resolve: true });
    assert.deepEqual(r, { commit: null, conflicts: ['a.txt'] });
    const s = await t.owner.call('git.status', { id: project.id });
    assert.deepEqual([s.operation, s.operationOf, s.conflicted.map((f) => f.path)], ['merge', wt.branch, ['a.txt']]);
    await resolveFile(t, { id: project.id, path: 'a.txt', side: 'theirs' });
    await t.owner.call('git.commit', { id: project.id, message: `Merge ${wt.branch}` });
    assert.equal(await out('git show HEAD:a.txt', dir), 'card');
    assert.equal(await out(`git merge-base --is-ancestor ${wt.branch} HEAD && echo merged`, dir), 'merged');
  } finally {
    await t.close();
  }
});

test('a cherry-pick that conflicts is named, resolved, and continued with git’s message', async () => {
  const t = await testCore({ gitEnv: GIT_ENV });
  try {
    const dir = t.projectDir;
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    await sh('git init -q -b main && git add -A && git commit -qm one && git switch -q -c side && echo side > a.txt && git commit -qam "Side change" && git switch -q main && echo main > a.txt && git commit -qam main', dir);
    await sh('git cherry-pick side || true', dir);
    const project = await t.owner.call('projects.add', { path: dir });
    const where = { id: project.id };
    const s = await t.owner.call('git.status', where);
    assert.deepEqual([s.operation, s.conflicted.map((f) => f.path)], ['cherry-pick', ['a.txt']]);
    await assert.rejects(t.owner.call('git.continue', where), /still conflicts/);
    await resolveFile(t, { ...where, path: 'a.txt', side: 'theirs' });
    await t.owner.call('git.continue', where);
    assert.equal((await t.owner.call('git.status', where)).operation, null);
    assert.equal(await out('git log -1 --format=%s', dir), 'Side change');
  } finally {
    await t.close();
  }
});

test('a stale resolver never overwrites edits made after the conflict was shown', async () => {
  const t = await conflicted();
  try {
    const where = { id: t.id, path: 'app.ts' };
    await t.owner.call('git.merge', { id: t.id, branch: 'side' });
    const shown = await t.owner.call('git.conflict', where);
    const digest = shown.digest;
    const edited = 'The owner resolved this in an editor while the panel was open.\n';
    writeFileSync(join(t.dir, where.path), edited);
    for (const how of [{ content: 'stale panel result\n' }, { side: 'theirs' as const }, { remove: true }]) {
      await assert.rejects(t.owner.call('git.resolve', { ...where, ...how, digest }), /changed since.*shown/);
      assert.equal(readFileSync(join(t.dir, where.path), 'utf8'), edited);
      assert.notEqual(await out('git ls-files -u -- app.ts', t.dir), '', 'still unresolved in the index');
    }
    await t.owner.call('git.resolve', { ...where, asIs: true });
    assert.equal(await sh('git show :app.ts', t.dir), edited, 'mark as edited stages the owner’s current work');
  } finally {
    await t.close();
  }
});


test('marking a conflict resolved as edited preserves a dangling symbolic link', async () => {
  const t = await conflicted();
  try {
    await t.owner.call('git.merge', { id: t.id, branch: 'side' });
    const file = join(t.dir, 'app.ts');
    rmSync(file);
    symlinkSync('generated-later.ts', file);
    await t.owner.call('git.resolve', { id: t.id, path: 'app.ts', asIs: true });
    assert.equal(lstatSync(file).isSymbolicLink(), true);
    assert.equal(readlinkSync(file), 'generated-later.ts');
    assert.equal(await sh('git show :app.ts', t.dir), 'generated-later.ts');
    assert.match(await out('git ls-files -s -- app.ts', t.dir), /^120000 /);
  } finally {
    await t.close();
  }
});

test('a rename on both branches can be resolved without leaving either renamed copy behind', async () => {
  const t = await testCore({ gitEnv: GIT_ENV });
  try {
    const dir = t.projectDir;
    writeFileSync(join(dir, 'original.txt'), 'the original file\n');
    await sh('git init -q -b main && git add -A && git commit -qm base && git switch -qc side && git mv original.txt theirs.txt && git commit -qm theirs && git switch -q main && git mv original.txt ours.txt && git commit -qm ours', dir);
    const project = await t.owner.call('projects.add', { path: dir });
    const where = { id: project.id };
    assert.equal((await t.owner.call('git.merge', { ...where, branch: 'side' })).outcome, 'conflict');
    const files = (await t.owner.call('git.status', where)).conflicted;
    assert.deepEqual(files.map((f) => [f.path, f.code]), [['original.txt', 'DD'], ['ours.txt', 'AU'], ['theirs.txt', 'UA']]);
    for (const file of files) await resolveFile(t, { ...where, path: file.path, side: 'theirs' });
    assert.equal(existsSync(join(dir, 'original.txt')), false);
    assert.equal(existsSync(join(dir, 'ours.txt')), false);
    assert.equal(readFileSync(join(dir, 'theirs.txt'), 'utf8'), 'the original file\n');
    assert.equal(await out('git ls-files -u', dir), '');
    await t.owner.call('git.commit', { ...where, message: 'Resolve both renames' });
    assert.equal(await out('git ls-tree --name-only HEAD', dir), 'theirs.txt');
  } finally {
    await t.close();
  }
});

test('marking a large hand-edited conflict resolved refuses an unreadable marker check', async () => {
  const t = await conflicted();
  try {
    const where = { id: t.id };
    await t.owner.call('git.merge', { ...where, branch: 'side' });
    const file = join(t.dir, 'app.ts');
    const unresolved = `${'// padding\n'.repeat(30_000)}${readFileSync(file, 'utf8')}`;
    writeFileSync(file, unresolved);
    await assert.rejects(t.owner.call('git.resolve', { ...where, path: 'app.ts', asIs: true }), /could not check.*markers/i);
    assert.notEqual(await out('git ls-files -u -- app.ts', t.dir), '', 'a failed check leaves the index conflicted');
    assert.equal(readFileSync(file, 'utf8'), unresolved, 'the hand edit is untouched');
    await t.owner.call('git.resolve', { ...where, path: 'app.ts', asIs: true, keepMarkers: true });
    assert.equal(await out('git ls-files -u -- app.ts', t.dir), '', 'the owner can explicitly keep unchecked markers');
  } finally {
    await t.close();
  }
});
