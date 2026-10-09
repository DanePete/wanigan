import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { testCore, waitFor, type TestCore } from './test-support.ts';

const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
function invented(version: string): Buffer {
  const bytes = Buffer.alloc(16 * 1024);
  for (let at = 0; at < bytes.length; at += 32) createHash('sha256').update(`owned-assessment-${version}-${at}`).digest().copy(bytes, at);
  return bytes;
}
function tree(root: string): unknown[] {
  const rows: unknown[] = [];
  const walk = (path: string): void => {
    const st = lstatSync(path);
    assert.ok(!st.isSymbolicLink(), 'owned fixture inventories do not follow links');
    if (st.isDirectory()) {
      rows.push({ path: relative(root, path), mode: st.mode & 0o777, directory: true });
      for (const child of readdirSync(path).sort()) walk(join(path, child));
    } else {
      assert.ok(st.isFile());
      rows.push({ path: relative(root, path), mode: st.mode & 0o777, bytes: st.size, hash: digest(readFileSync(path)) });
    }
  };
  walk(root);
  return rows;
}
function git(t: TestCore, cwd: string, args: string[], extra: Record<string, string> = {}): Promise<string> {
  assert.ok(realpathSync(cwd).startsWith(t.dir + sep));
  return new Promise((ok, fail) => execFile('/usr/bin/git', ['-c', 'core.quotepath=false', ...args], {
    cwd, timeout: 5_000, maxBuffer: 2 * 1024 * 1024,
    env: { PATH: '/usr/bin:/bin', HOME: join(t.dir, 'home'), LANG: 'C', LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', ...extra },
  }, (error, stdout, stderr) => error ? fail(new Error(`owned git ${args[0]} failed: ${String(stderr)}`)) : ok(String(stdout))));
}
async function fixture(): Promise<{ t: TestCore; projectId: string }> {
  const t = await testCore({ launcher: (provider) => {
    assert.equal(provider, 'claude');
    return { file: '/bin/sh', args: ['-c', 'exec /bin/cat', 'owned-assessment-stand-in'] };
  } });
  try {
    writeFileSync(join(t.projectDir, 'owned.bin'), invented('baseline'), { mode: 0o600 });
    await git(t, t.projectDir, ['init', '-q', '-b', 'main']);
    await git(t, t.projectDir, ['add', '--all']);
    await git(t, t.projectDir, ['-c', 'user.email=owned@example.invalid', '-c', 'user.name=Owned fixture', 'commit', '-qm', 'Owned baseline']);
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    return { t, projectId: project.id };
  } catch (error) { await t.close(); throw error; }
}
async function stoppedCard(t: TestCore, projectId: string, label: string): Promise<{ id: string; wt: string; file: string; captured: Buffer }> {
  const card = await t.owner.call('cards.create', { projectId, type: 'task', title: `Owned ${label}` });
  const session = await t.owner.call('sessions.start', { projectId, provider: 'claude', cardId: card.id, isolate: true });
  const wt = (await t.owner.call('cards.get', { id: card.id })).worktree!.path;
  const file = join(wt, 'owned.bin'), captured = invented(`turn-${label}`);
  t.core.sessions.hook(session.id, 'SessionStart', {});
  await t.core.checkpoints.settled();
  t.core.sessions.hook(session.id, 'UserPromptSubmit', {});
  writeFileSync(file, captured);
  t.core.sessions.hook(session.id, 'Stop', {});
  await t.core.checkpoints.settled();
  await t.owner.call('sessions.stop', { id: session.id });
  await waitFor('owned stand-in stopped', async () => ['ended', 'failed', 'interrupted'].includes((await t.owner.call('sessions.get', { id: session.id })).session.state));
  await t.core.checkpoints.settled();
  return { id: session.id, wt, file, captured };
}
interface LedgerRow { id: number; kind: string; commit_sha: string | null; tree_sha: string | null; before_sha: string | null }
const ledger = (t: TestCore): LedgerRow[] => t.core.db.prepare('SELECT * FROM checkpoints ORDER BY id').all() as LedgerRow[];
const storeRoot = (t: TestCore): string => join(t.dir, 'data', 'checkpoint-objects');
const temporaryRoot = (t: TestCore): string => join(t.dir, 'data', 'checkpoints');
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
async function observeGit<T>(t: TestCore, failWriteTree: boolean, work: (log: string) => Promise<T>): Promise<T> {
  const bin = join(t.dir, 'owned-git-bin'), log = join(t.dir, 'owned-write-tree-paths');
  mkdirSync(bin);
  writeFileSync(join(bin, 'git'), `#!/bin/sh\nfor arg do\n  if [ "$arg" = write-tree ]; then\n    printf '%s\\n' "$GIT_OBJECT_DIRECTORY" >> ${quote(log)}\n${failWriteTree ? "    printf 'owned write-tree failure\\n' >&2\n    exit 73\n" : ''}  fi\ndone\nexec /usr/bin/git "$@"\n`, { mode: 0o700 });
  const prior = process.env.PATH;
  process.env.PATH = `${bin}:/usr/bin:/bin`;
  try { return await work(log); }
  finally { if (prior === undefined) delete process.env.PATH; else process.env.PATH = prior; }
}
const recordedPaths = (log: string): string[] => readFileSync(log, 'utf8').trim().split('\n');

test('availability reads of successive owner edits retain no objects and preserve captured evidence', async () => {
  const { t, projectId } = await fixture();
  try {
    const card = await stoppedCard(t, projectId, 'successive');
    // A sibling artifact must survive cleanup of only the new assessment directory.
    writeFileSync(join(temporaryRoot(t), 'owned-sentinel'), 'preserve this sibling', { mode: 0o600 });
    const before = { ledger: ledger(t), objects: tree(storeRoot(t)), repository: tree(join(t.projectDir, '.git')), temporary: tree(temporaryRoot(t)) };
    const unchanged = await t.owner.call('sessions.checkpoints', { id: card.id });
    assert.equal(unchanged.last?.refusal, null);
    for (let version = 1; version <= 3; version++) {
      const next = invented(`owner-${version}`);
      writeFileSync(card.file, next);
      const actual = await t.owner.call('sessions.checkpoints', { id: card.id });
      assert.match(actual.last?.refusal ?? '', /folder has changed/);
      assert.deepEqual(readFileSync(card.file), next);
      assert.deepEqual(ledger(t), before.ledger);
      assert.deepEqual(tree(join(t.projectDir, '.git')), before.repository);
      assert.deepEqual(tree(storeRoot(t)), before.objects, 'an availability read must not retain uncaptured object bytes');
      assert.deepEqual(tree(temporaryRoot(t)), before.temporary);
    }
    writeFileSync(card.file, card.captured);
    assert.equal((await t.owner.call('sessions.checkpoints', { id: card.id })).last?.refusal, null);
    assert.deepEqual(tree(storeRoot(t)), before.objects);
    assert.deepEqual(tree(temporaryRoot(t)), before.temporary);
  } finally { await t.close(); }
});

test('a failed assessment discards its own temporary objects while preserving ledger and repository', async () => {
  const { t, projectId } = await fixture();
  try {
    const card = await stoppedCard(t, projectId, 'failed');
    writeFileSync(card.file, invented('failure-owner-edit'));
    const before = { ledger: ledger(t), objects: tree(storeRoot(t)), repository: tree(join(t.projectDir, '.git')), temporary: tree(temporaryRoot(t)), working: readFileSync(card.file) };
    await observeGit(t, true, async (log) => {
      const actual = await t.owner.call('sessions.checkpoints', { id: card.id });
      assert.match(actual.last?.refusal ?? '', /could not check the folder.*owned write-tree failure/);
      const paths = recordedPaths(log);
      assert.equal(paths.length, 1, 'the controlled Git failure occurred after add wrote the current blob');
      assert.deepEqual(ledger(t), before.ledger);
      assert.deepEqual(tree(join(t.projectDir, '.git')), before.repository);
      assert.deepEqual(readFileSync(card.file), before.working);
      assert.deepEqual(tree(storeRoot(t)), before.objects, 'even a failed availability read must not retain its new blob');
      assert.ok(paths[0]!.startsWith(temporaryRoot(t) + sep));
      assert.equal(existsSync(paths[0]!), false);
      assert.deepEqual(tree(temporaryRoot(t)), before.temporary);
    });
  } finally { await t.close(); }
});

test('concurrent stopped-card assessments have distinct temporary stores and leave neither behind', async () => {
  const { t, projectId } = await fixture();
  try {
    const cards = [await stoppedCard(t, projectId, 'one'), await stoppedCard(t, projectId, 'two')];
    for (const [index, card] of cards.entries()) writeFileSync(card.file, invented(`concurrent-${index}`));
    const before = { ledger: ledger(t), objects: tree(storeRoot(t)), repository: tree(join(t.projectDir, '.git')), temporary: tree(temporaryRoot(t)) };
    await observeGit(t, false, async (log) => {
      const replies = await Promise.all(cards.map((card) => t.owner.call('sessions.checkpoints', { id: card.id })));
      assert.ok(replies.every((reply) => /folder has changed/.test(reply.last?.refusal ?? '')));
      const paths = recordedPaths(log);
      assert.equal(paths.length, 2);
      assert.equal(new Set(paths).size, 2, 'the two sessions must not share an assessment object directory');
      assert.ok(paths.every((path) => path.startsWith(temporaryRoot(t) + sep) && !existsSync(path)));
      assert.deepEqual(ledger(t), before.ledger);
      assert.deepEqual(tree(storeRoot(t)), before.objects);
      assert.deepEqual(tree(join(t.projectDir, '.git')), before.repository);
      assert.deepEqual(tree(temporaryRoot(t)), before.temporary);
    });
  } finally { await t.close(); }
});

test('actual undo and redo retain inspectable checkpoint objects after availability cleanup', async () => {
  const { t, projectId } = await fixture();
  try {
    const card = await stoppedCard(t, projectId, 'undo-redo');
    const offer = await t.owner.call('sessions.checkpoints', { id: card.id });
    assert.equal(offer.last?.refusal, null);
    await t.owner.call('sessions.undoTurn', { id: card.id, checkpoint: offer.last!.checkpointId });
    assert.deepEqual(readFileSync(card.file), invented('baseline'));
    const redo = await t.owner.call('sessions.checkpoints', { id: card.id });
    assert.equal(redo.last?.refusal, null);
    assert.equal(redo.last?.action, 'redo');
    await t.owner.call('sessions.redoTurn', { id: card.id, checkpoint: redo.last!.checkpointId });
    assert.deepEqual(readFileSync(card.file), card.captured);
    const rows = ledger(t);
    assert.deepEqual(rows.map((row) => row.kind), ['start', 'turn', 'undo', 'redo']);
    const objects = tree(storeRoot(t));
    assert.equal((await t.owner.call('sessions.checkpoints', { id: card.id })).last?.refusal, null);
    assert.deepEqual(tree(storeRoot(t)), objects);
    assert.deepEqual(ledger(t), rows);
    const stores = readdirSync(storeRoot(t));
    assert.equal(stores.length, 1);
    const common = resolve(card.wt, (await git(t, card.wt, ['rev-parse', '--git-common-dir'])).trim());
    const env = { GIT_OBJECT_DIRECTORY: join(storeRoot(t), stores[0]!), GIT_ALTERNATE_OBJECT_DIRECTORIES: join(common, 'objects') };
    for (const row of rows) {
      assert.ok(row.commit_sha && row.tree_sha);
      assert.equal((await git(t, card.wt, ['cat-file', '-t', row.commit_sha], env)).trim(), 'commit');
      assert.equal((await git(t, card.wt, ['cat-file', '-t', row.tree_sha], env)).trim(), 'tree');
    }
    assert.deepEqual(readdirSync(temporaryRoot(t)), []);
  } finally { await t.close(); }
});
