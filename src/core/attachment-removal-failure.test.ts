// Real owner attachment calls and owned filesystem refusals. No agent or model
// runs. dropUnsent is exercised directly; this does not test session-exit policy.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import type { Attachment } from '../shared/attachments.ts';
import { testCore, type TestCore } from './test-support.ts';

const to = { chat: null };
const save = (t: TestCore, name: string, text: string): Promise<Attachment> =>
  t.owner.call('attachments.save', { to, name, data: Buffer.from(text).toString('base64') });
const listed = (t: TestCore): Promise<Attachment[]> => t.owner.call('attachments.list', { to });
const rows = (t: TestCore): unknown[] => t.core.db.prepare('SELECT * FROM attachments ORDER BY n, id').all();
const bytesAndMode = (path: string): { bytes: Buffer; mode: number } =>
  ({ bytes: readFileSync(path), mode: lstatSync(path).mode & 0o777 });

async function withCore(body: (t: TestCore) => Promise<void>): Promise<void> {
  let launches = 0;
  const t = await testCore({
    launcher: () => { launches++; throw new Error('Agent launch is forbidden in attachment-removal tests.'); },
  });
  try {
    await body(t);
  } finally {
    try { assert.equal(launches, 0); }
    finally { await t.close(); }
  }
}

/** Verify the OS really refuses unlink, then always restore the exact mode. */
async function withoutDirectoryWrites(dir: string, body: () => Promise<void>): Promise<void> {
  const mode = lstatSync(dir).mode & 0o777;
  const canary = join(dir, 'owned-unlink-control');
  writeFileSync(canary, 'invented permission control\n', { flag: 'wx', mode: 0o600 });
  try {
    chmodSync(dir, 0o500);
    assert.throws(() => rmSync(canary, { force: true }), (e: NodeJS.ErrnoException) =>
      e.code === 'EACCES' || e.code === 'EPERM', 'the real filesystem must refuse unlink; no skipped or simulated permission proof');
    await body();
  } finally {
    chmodSync(dir, mode);
    assert.equal(lstatSync(dir).mode & 0o777, mode);
    rmSync(canary, { force: true });
  }
}

test('a refused owner removal keeps the attachment listed and retries after permissions recover', async () => {
  await withCore(async (t) => {
    const control = await save(t, 'control.txt', 'normal removal control\n');
    const sibling = await save(t, 'sibling.txt', 'pending sibling stays\n');
    const file = await save(t, 'retry.txt', 'failed removal stays recoverable\n');
    await t.owner.call('attachments.remove', { id: control.id });
    assert.equal(existsSync(control.path), false);
    const before = rows(t), fileBefore = bytesAndMode(file.path), siblingBefore = bytesAndMode(sibling.path);
    await withoutDirectoryWrites(dirname(file.path), async () => {
      await assert.rejects(t.owner.call('attachments.remove', { id: file.id }), /EACCES|EPERM/);
      assert.deepEqual(rows(t), before, 'a refused unlink must retain the exact row, including its sequence and holder');
      assert.deepEqual((await listed(t)).map((a) => a.id), [sibling.id, file.id]);
      assert.deepEqual(bytesAndMode(file.path), fileBefore);
    });
    await t.owner.call('attachments.remove', { id: file.id });
    assert.equal(existsSync(file.path), false);
    assert.deepEqual((await listed(t)).map((a) => a.id), [sibling.id]);
    const replacement = await save(t, file.name, 'new same-name contents\n');
    assert.equal(replacement.path, file.path, 'the reused sequence/path is free after the successful retry');
    assert.equal(readFileSync(replacement.path, 'utf8'), 'new same-name contents\n');
    assert.deepEqual(bytesAndMode(sibling.path), siblingBefore);
  });
});

test('dropUnsent retains every waiting attachment when its first unlink is permission-refused', async () => {
  await withCore(async (t) => {
    const files = [await save(t, 'one.txt', 'first pending\n'), await save(t, 'two.txt', 'second pending\n')];
    const holder = t.core.chat.holder(null, false);
    assert.ok(holder);
    const before = rows(t), contents = files.map((a) => bytesAndMode(a.path));
    await withoutDirectoryWrites(dirname(files[0]!.path), async () => {
      assert.throws(() => t.core.attachments.dropUnsent(holder), /EACCES|EPERM/);
      assert.deepEqual(rows(t), before);
      assert.deepEqual((await listed(t)).map((a) => a.id), files.map((a) => a.id));
      assert.deepEqual(files.map((a) => bytesAndMode(a.path)), contents);
    });
    t.core.attachments.dropUnsent(holder);
    assert.deepEqual(await listed(t), []);
    for (const file of files) assert.equal(existsSync(file.path), false);
  });
});

test('dropUnsent forgets only successfully unlinked files before a later nonrecursive removal refusal', async () => {
  await withCore(async (t) => {
    const files = [
      await save(t, 'first.txt', 'first normal pending file\n'),
      await save(t, 'middle.txt', 'middle normal pending file\n'),
      await save(t, 'last.txt', 'last normal pending file\n'),
    ];
    const holder = t.core.chat.holder(null, false);
    assert.ok(holder);
    // Observe this holder's actual traversal order without fabricating row paths.
    const traversal = t.core.db.prepare('SELECT * FROM attachments WHERE thread_id = ? AND queued_id IS NULL AND turn_id IS NULL')
      .all(holder.id) as { id: string }[];
    const ordered = traversal.map((row) => files.find((a) => a.id === row.id)!);
    assert.equal(ordered.length, 3);
    const [first, blocked, unvisited] = ordered as [Attachment, Attachment, Attachment];
    const before = rows(t), blockedBefore = bytesAndMode(blocked.path), unvisitedBefore = bytesAndMode(unvisited.path);
    const aside = join(t.dir, 'owned-middle-file-aside');
    renameSync(blocked.path, aside);
    try {
      // An actual owned empty directory makes rmSync(force) refuse without recursive removal.
      mkdirSync(blocked.path, { mode: 0o700 });
      assert.throws(() => t.core.attachments.dropUnsent(holder), /EISDIR|directory/i);
      assert.equal(existsSync(first.path), false, 'the preceding file was actually removed');
      assert.deepEqual(rows(t), before.filter((row) => (row as { id: string }).id !== first.id),
        'the failed and unvisited rows remain; only completed file removal releases its row');
      assert.deepEqual(new Set((await listed(t)).map((a) => a.id)), new Set([blocked.id, unvisited.id]));
      assert.deepEqual(bytesAndMode(aside), blockedBefore);
      assert.deepEqual(bytesAndMode(unvisited.path), unvisitedBefore);
    } finally {
      if (existsSync(blocked.path)) rmdirSync(blocked.path);
      renameSync(aside, blocked.path);
    }
    t.core.attachments.dropUnsent(holder);
    assert.deepEqual(await listed(t), []);
    for (const file of files) assert.equal(existsSync(file.path), false);
  });
});

test('missing pending files can be forgotten while files taken by a message remain intact', async () => {
  await withCore(async (t) => {
    const sent = await save(t, 'sent.txt', 'owned sent-file control\n');
    const missing = await save(t, 'missing.txt', 'already absent owner file\n');
    const dropped = await save(t, 'drop-missing.txt', 'already absent cleanup file\n');
    const holder = t.core.chat.holder(null, false);
    assert.ok(holder);
    // An owned completed-turn fixture exercises the real take/refusal contract without a provider.
    const turnId = 'owned-sent-turn';
    t.core.db.prepare('INSERT INTO chat_turns (id, thread_id, question, state, asked_at) VALUES (?, ?, ?, ?, ?)')
      .run(turnId, holder.id, 'invented attachment control', 'done', 1);
    t.core.attachments.take(holder, [sent.id], { turnId });
    const sentBefore = bytesAndMode(sent.path);
    const sentRow = t.core.db.prepare('SELECT * FROM attachments WHERE id = ?').get(sent.id);
    await assert.rejects(t.owner.call('attachments.remove', { id: sent.id }), /stays with it/);
    rmSync(missing.path);
    await t.owner.call('attachments.remove', { id: missing.id });
    rmSync(dropped.path);
    t.core.attachments.dropUnsent(holder);
    assert.deepEqual(await listed(t), []);
    assert.deepEqual(rows(t), [sentRow]);
    assert.deepEqual(bytesAndMode(sent.path), sentBefore);
    assert.deepEqual(t.core.attachments.ofTurns([turnId]).get(turnId)?.map((a) => a.id), [sent.id]);
  });
});
