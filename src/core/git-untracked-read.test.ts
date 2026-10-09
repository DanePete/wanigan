// Real owner requests over owned files: a failed or deliberately bounded read
// must not look like an empty untracked file. No provider or session is started.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { diffHash } from '../shared/diff.ts';
import { readUntracked } from './git.ts';
import { testCore } from './test-support.ts';

const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Tess Tester', GIT_AUTHOR_EMAIL: 'tess@example.com',
  GIT_COMMITTER_NAME: 'Tess Tester', GIT_COMMITTER_EMAIL: 'tess@example.com',
};

function git(cwd: string, ...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile('/usr/bin/git', args, { cwd, env: { ...process.env, ...GIT_ENV } },
    (error, stdout, stderr) => error ? reject(new Error(stderr)) : resolve(stdout)));
}

async function fixture() {
  const t = await testCore({ gitEnv: GIT_ENV });
  try {
    await git(t.projectDir, 'init', '-q', '-b', 'main');
    writeFileSync(join(t.projectDir, 'tracked.txt'), 'owned baseline\n');
    await git(t.projectDir, 'add', 'tracked.txt');
    await git(t.projectDir, 'commit', '-qm', 'Owned fixture');
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    return { ...t, id: project.id };
  } catch (error) { await t.close(); throw error; }
}

for (const method of ['git.diff', 'projects.diff'] as const) test(`${method} refuses an unreadable untracked file and reads it after permissions recover`, async () => {
  const t = await fixture();
  try {
    const file = join(t.projectDir, 'new.txt');
    writeFileSync(file, 'owned first line\nowned second line\n', { mode: 0o600 });
    const mode = statSync(file).mode & 0o777;
    const content = readFileSync(file), index = readFileSync(join(t.projectDir, '.git/index'));
    const where = { id: t.id, path: 'new.txt' };
    const read = () => method === 'git.diff' ? t.owner.call('git.diff', { ...where, area: 'untracked' }) : t.owner.call('projects.diff', where);
    const healthy = await read();
    assert.match(healthy.diff, /\+owned first line\n\+owned second line/);
    chmodSync(file, 0o000);
    try {
      assert.throws(() => readFileSync(file), { code: 'EACCES' }, 'the owned fixture must actually be unreadable');
      await assert.rejects(read(), { code: 'refused', message: /could not read.*file/i });
      if (method === 'git.diff') await assert.rejects(t.owner.call('git.applyPart', {
        ...where, area: 'untracked', action: 'stage', pick: { old: [], new: [1] }, digest: diffHash(healthy.diff),
      }), { code: 'refused', message: /could not read.*file/i });
      assert.deepEqual(readFileSync(join(t.projectDir, '.git/index')), index);
    } finally { chmodSync(file, mode); }
    assert.deepEqual(await read(), healthy);
    assert.deepEqual(readFileSync(file), content);
    assert.equal(statSync(file).mode & 0o777, mode);
  } finally { await t.close(); }
});

test('an oversized untracked file is reported as too large while the exact read limit remains readable', async () => {
  const t = await fixture();
  try {
    const file = join(t.projectDir, 'large.txt');
    const content = Buffer.alloc(200_001, 65);
    writeFileSync(file, content);
    const where = { id: t.id, path: 'large.txt', area: 'untracked' as const };
    const index = readFileSync(join(t.projectDir, '.git/index'));
    await assert.rejects(t.owner.call('git.diff', where), { code: 'refused', message: /too large to show/i });
    assert.deepEqual(readFileSync(file), content);
    assert.deepEqual(readFileSync(join(t.projectDir, '.git/index')), index);
    writeFileSync(file, content.subarray(0, 200_000));
    const readable = await t.owner.call('git.diff', where);
    assert.equal(readable.truncated, false);
    assert.ok(readable.diff.includes(`+${'A'.repeat(200_000)}\n`));
  } finally { await t.close(); }
});

test('the workbench describes an untracked link without following its target or treating target text as a patch', async () => {
  const t = await fixture();
  try {
    const marker = 'OWNED_OUTSIDE_BYTES_MUST_NOT_APPEAR\n';
    const target = join(t.dir, 'target\n@@ -0,0 +1,1 @@\n+invented-patch.txt');
    writeFileSync(target, marker);
    symlinkSync(target, join(t.projectDir, 'linked.txt'));
    const index = readFileSync(join(t.projectDir, '.git/index'));
    await assert.rejects(t.owner.call('git.diff', { id: t.id, path: 'linked.txt', area: 'untracked' }), (error: unknown) => {
      const e = error as { code?: string; message?: string };
      assert.equal(e.code, 'refused');
      assert.match(e.message ?? '', /Symbolic link to/);
      assert.equal(e.message?.includes(marker.trim()), false);
      return true;
    });
    assert.equal(readFileSync(target, 'utf8'), marker);
    assert.deepEqual(readFileSync(join(t.projectDir, '.git/index')), index);
  } finally { await t.close(); }
});

test('a binary untracked file keeps its binary marker and a genuinely empty file remains readable', async () => {
  const t = await fixture();
  try {
    writeFileSync(join(t.projectDir, 'binary.bin'), Buffer.from([1, 0, 2]));
    writeFileSync(join(t.projectDir, 'empty.txt'), '');
    const binary = await t.owner.call('git.diff', { id: t.id, path: 'binary.bin', area: 'untracked' });
    assert.match(binary.diff, /Binary files \/dev\/null and b\/binary\.bin differ/);
    assert.equal(binary.truncated, false);
    await assert.rejects(t.owner.call('git.applyPart', {
      id: t.id, path: 'binary.bin', area: 'untracked', action: 'stage', pick: { old: [], new: [1] }, digest: diffHash(binary.diff),
    }), /binary/i);
    const empty = await t.owner.call('git.diff', { id: t.id, path: 'empty.txt', area: 'untracked' });
    assert.equal(empty.truncated, false);
    assert.match(empty.diff, /new file mode 100644/);
    assert.doesNotMatch(empty.diff, /^@@/m);
    assert.deepEqual(readFileSync(join(t.projectDir, 'binary.bin')), Buffer.from([1, 0, 2]));
    assert.equal(readFileSync(join(t.projectDir, 'empty.txt'), 'utf8'), '');
  } finally { await t.close(); }
});

test('projects.diff keeps its existing oversized and symbolic-link notes and reads text at the size limit', async () => {
  const t = await fixture();
  try {
    const file = join(t.projectDir, 'large.txt');
    writeFileSync(file, Buffer.alloc(200_001, 65));
    assert.match((await t.owner.call('projects.diff', { id: t.id, path: 'large.txt' })).diff, /Too large to show/);
    writeFileSync(file, Buffer.alloc(200_000, 65));
    const readable = await t.owner.call('projects.diff', { id: t.id, path: 'large.txt' });
    assert.equal(readable.truncated, false);
    assert.ok(readable.diff.includes(`+${'A'.repeat(200_000)}`));
    const target = join(t.dir, 'outside.txt'); writeFileSync(target, 'OWNED_OUTSIDE_CONTROL\n');
    symlinkSync(target, join(t.projectDir, 'link'));
    const link = await t.owner.call('projects.diff', { id: t.id, path: 'link' });
    assert.match(link.diff, /Symbolic link to/);
    assert.doesNotMatch(link.diff, /OWNED_OUTSIDE_CONTROL/);
    writeFileSync(join(t.projectDir, 'binary.bin'), Buffer.from([1, 0, 2]));
    assert.equal((await t.owner.call('projects.diff', { id: t.id, path: 'binary.bin' })).diff, '');
    assert.equal((await t.owner.call('projects.changes', { id: t.id })).files.find((f) => f.path === 'binary.bin')?.binary, true);
  } finally { await t.close(); }
});

test('the bounded untracked reader does not open directories, FIFOs or a link to an external file', async () => {
  const t = await fixture();
  try {
    const directory = join(t.projectDir, 'directory'); mkdirSync(directory);
    assert.deepEqual(await readUntracked(directory), { note: 'Not a regular file.' });
    const fifo = join(t.dir, 'owned-fifo');
    await new Promise<void>((resolve, reject) => execFile('/usr/bin/mkfifo', [fifo], (error) => error ? reject(error) : resolve()));
    assert.deepEqual(await readUntracked(fifo), { note: 'Not a regular file.' });
    const target = join(t.dir, 'external.txt'); writeFileSync(target, 'OWNED_EXTERNAL_CONTENT\n');
    const link = join(t.projectDir, 'link'); symlinkSync(target, link);
    assert.deepEqual(await readUntracked(link), { note: `Symbolic link to ${target}` });
    assert.equal(readFileSync(target, 'utf8'), 'OWNED_EXTERNAL_CONTENT\n');
  } finally { await t.close(); }
});
