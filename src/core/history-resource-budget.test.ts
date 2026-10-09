// Resource refusal is a complete-query outcome, never a partial History list.
// Every input lives in testCore's fake home; no provider or session is launched.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { test } from 'node:test';
import { claudeSlug } from './history.ts';
import { testCore } from './test-support.ts';

const REFUSAL = { code: 'refused', message: 'History is too large to inspect safely' };
type Limits = Partial<Record<'accounts' | 'entries' | 'rows' | 'cellBytes' | 'metadataBytes' | 'databaseBytes' | 'summaryBytes', number>>;
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function snapshot(root: string): unknown[] {
  return readdirSync(root).sort().flatMap((name) => {
    const file = join(root, name); const s = lstatSync(file);
    return [{ file, mode: s.mode, size: s.size, mtimeMs: s.mtimeMs,
      sha256: s.isFile() ? createHash('sha256').update(readFileSync(file)).digest('hex') : null },
    ...(s.isDirectory() ? snapshot(file) : [])];
  });
}
async function fixture(limits: Limits) {
  // This trusted constructor-only option is deliberately absent from RPC/settings.
  // The cast also lets the same final test bytes run against pristine CoreOptions.
  const options = { historyLimits: limits, launcher: () => { throw new Error('History budget fixture must not launch a session'); } };
  const t = await testCore(options as Parameters<typeof testCore>[0]);
  try {
  const project = await t.owner.call('projects.add', { path: t.projectDir, key: 'HB' });
  const home = join(t.dir, 'home');
  const directory = join(home, '.claude', 'projects', claudeSlug(t.projectDir));
  mkdirSync(directory, { recursive: true });
  const list = (query?: string, limit = 2000) => t.owner.call('history.list', { projectId: project.id, ...(query ? { query } : {}), limit });
  const transcript = (n: number, marker = `fixture ${n}`): string => {
    const file = join(directory, `${id(n)}.jsonl`);
    writeFileSync(file, JSON.stringify({ type: 'user', cwd: t.projectDir, uuid: `lineage-${n}`, timestamp: n,
      message: { role: 'user', content: marker } }) + '\n');
    return file;
  };
  const index = (folder = join(home, '.codex')) => {
    mkdirSync(folder, { recursive: true }); const file = join(folder, 'state_5.sqlite');
    const db = new Database(file);
    db.exec('PRAGMA page_size = 4096; CREATE TABLE threads (id TEXT, cwd TEXT, thread_source TEXT, first_user_message TEXT, git_branch BLOB)');
    return { file, db, add(n: number, prompt = `thread ${n}`, branch: string | Buffer | null = null, cwd = t.projectDir) {
      db.prepare('INSERT INTO threads VALUES (?,?,?,?,?)').run(id(n), cwd, 'user', prompt, branch);
    } };
  };
  const refused = async () => {
    const before = snapshot(home);
    const sessions = await t.owner.call('sessions.list', {});
    await assert.rejects(list(undefined, 1), REFUSAL);
    assert.deepEqual(snapshot(home), before, 'refusal never changes any account entry or bytes');
    assert.equal((await t.owner.call('core.hello', {})).role, 'owner');
    assert.deepEqual(await t.owner.call('sessions.list', {}), sessions, 'refusal creates or changes no sessions');
  };
  return { ...t, home, directory, project, list, transcript, index, refused };
  } catch (error) { await t.close(); throw error; }
}

test('History admits exactly two accounts, refuses the third before choosing a partial result, and recovers', async () => {
  const t = await fixture({ accounts: 2 });
  try {
    t.transcript(1, 'oldest needle');
    assert.equal((await t.list('needle', 1)).length, 1);
    const extra = await t.owner.call('accounts.add', { provider: 'codex', label: 'extra' });
    await t.refused();
    await t.owner.call('accounts.remove', { id: extra.id });
    assert.equal((await t.list('needle', 1)).length, 1);
  } finally { await t.close(); }
});

test('filesystem entry budget counts unrelated names, closes its traversal, and admits its exact boundary', async () => {
  const t = await fixture({ entries: 4 });
  try {
    t.transcript(1, 'older needle'); t.transcript(2); // one project directory + two files
    const ignored = join(t.directory, 'unrelated.txt'); writeFileSync(ignored, 'not a conversation');
    assert.equal((await t.list('needle', 1)).length, 1, 'four visited entries still permit complete oldest-item search');
    const excess = join(t.directory, 'another-unrelated.txt'); writeFileSync(excess, 'also ignored');
    await t.refused(); rmSync(excess);
    assert.equal((await t.list('needle', 1)).length, 1);
  } finally { await t.close(); }
});

test('row admission includes the selected project and every eligible Codex row before response filtering', async () => {
  const t = await fixture({ rows: 4 });
  try {
    const x = t.index(); try { x.add(1, 'oldest needle'); x.add(2); x.add(3); } finally { x.db.close(); }
    assert.deepEqual((await t.list('needle', 1)).map((r) => r.id), [`codex:${id(1)}`]);
    const edit = new Database(x.file);
    try { edit.prepare('INSERT INTO threads VALUES (?,?,?,?,?)').run(id(4), '/not-this-project', 'user', 'outside', null); } finally { edit.close(); }
    await t.refused();
    const repair = new Database(x.file); try { repair.prepare('DELETE FROM threads WHERE id = ?').run(id(4)); } finally { repair.close(); }
    assert.equal((await t.list('needle', 1)).length, 1);
  } finally { await t.close(); }
});

test('one binary cell fits its exact 512-byte limit and cap plus one refuses even outside this project', async () => {
  const t = await fixture({ cellBytes: 512 });
  try {
    const x = t.index(); try { x.add(1); x.add(2, 'outside', Buffer.alloc(512, 7), '/not-this-project'); } finally { x.db.close(); }
    assert.deepEqual((await t.list()).map((r) => r.id), [`codex:${id(1)}`]);
    const edit = new Database(x.file); try { edit.prepare('UPDATE threads SET git_branch = ? WHERE id = ?').run(Buffer.alloc(513, 7), id(2)); } finally { edit.close(); }
    await t.refused();
    const repair = new Database(x.file); try { repair.prepare('UPDATE threads SET git_branch = ? WHERE id = ?').run(Buffer.alloc(512, 7), id(2)); } finally { repair.close(); }
    assert.equal((await t.list()).length, 1);
  } finally { await t.close(); }
});

test('aggregate metadata refuses many individually fitting cells and permits repair on the same core', async () => {
  const t = await fixture({ metadataBytes: 16 * 1024, cellBytes: 8 * 1024 });
  try {
    const x = t.index(); try { x.add(1, 'needle'); } finally { x.db.close(); }
    assert.equal((await t.list()).length, 1);
    const edit = new Database(x.file);
    try { for (let n = 2; n <= 5; n++) edit.prepare('INSERT INTO threads VALUES (?,?,?,?,?)').run(id(n), t.projectDir, 'user', 'large', Buffer.alloc(4096, n)); } finally { edit.close(); }
    await t.refused();
    const repair = new Database(x.file); try { repair.prepare('DELETE FROM threads WHERE id <> ?').run(id(1)); } finally { repair.close(); }
    assert.equal((await t.list('needle')).length, 1);
  } finally { await t.close(); }
});

test('summary input budget is charged on cold and cached reads, and refusal does not poison recovery', async () => {
  const t = await fixture({ summaryBytes: 1024 });
  try {
    const a = t.transcript(1, 'needle'); const original = readFileSync(a);
    // Whitespace is valid after the one JSONL record and makes an exact input size.
    assert.ok(original.length < 1024); writeFileSync(a, Buffer.concat([original, Buffer.alloc(1024 - original.length, 32)]));
    assert.equal((await t.list('needle')).length, 1);
    assert.equal((await t.list('needle')).length, 1, 'cached admission has the same 1024-byte cost');
    appendFileSync(a, ' '); await t.refused();
    writeFileSync(a, original); assert.equal((await t.list('needle')).length, 1);
  } finally { await t.close(); }
});

test('database bytes fit an exact 8192-byte image and cap plus one refuses before copying oversized input', async () => {
  const t = await fixture({ databaseBytes: 8192 });
  try {
    const x = t.index(); try { x.add(1, 'needle'); } finally { x.db.close(); }
    assert.equal(statSync(x.file).size, 8192, 'fixed page size and one small table are two pages');
    const original = readFileSync(x.file);
    assert.equal((await t.list('needle')).length, 1);
    assert.equal((await t.list('needle')).length, 1, 'a cached index reserves its source size too');
    appendFileSync(x.file, Buffer.from([0])); await t.refused();
    writeFileSync(x.file, original); assert.equal((await t.list('needle')).length, 1);
  } finally { await t.close(); }
});

test('an over-budget later account cannot authorize reading or resuming an earlier matching conversation', async () => {
  const t = await fixture({ rows: 3 });
  try {
    const first = t.index();
    const rollout = join(t.home, '.codex', 'owned-rollout.jsonl');
    writeFileSync(rollout, JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ text: 'owned readable earlier conversation' }] } } }) + '\n');
    try {
      first.add(1, 'first match');
      first.db.exec('ALTER TABLE threads ADD COLUMN rollout_path TEXT');
      first.db.prepare('UPDATE threads SET rollout_path = ? WHERE id = ?').run(rollout, id(1));
    } finally { first.db.close(); }
    assert.equal((await t.list()).length, 1);
    const readable = await t.owner.call('history.read', { id: `codex:${id(1)}` });
    assert.ok(readable.turns.some((turn) => turn.text === 'owned readable earlier conversation'), 'the earlier conversation must really be readable before the later account is added');
    const extra = await t.owner.call('accounts.add', { provider: 'codex', label: 'later' });
    const late = t.index(t.core.accounts.folderOf(extra));
    try { late.add(2); late.add(3); late.add(4); } finally { late.db.close(); }
    const before = snapshot(t.home);
    await assert.rejects(t.owner.call('history.read', { id: `codex:${id(1)}` }), REFUSAL);
    await assert.rejects(t.owner.call('history.resume', { id: `codex:${id(1)}` }), REFUSAL);
    assert.deepEqual(await t.owner.call('sessions.list', {}), []);
    assert.deepEqual(snapshot(t.home), before);
  } finally { await t.close(); }
});

test('ordinary late corruption and duplicate refusal retain their existing meaning below every budget', async () => {
  const t = await fixture({ accounts: 3, rows: 20 });
  try {
    const first = t.index(); try { first.add(1, 'earlier needle'); } finally { first.db.close(); }
    assert.equal((await t.list('needle', 1)).length, 1);
    const extra = await t.owner.call('accounts.add', { provider: 'codex', label: 'later' });
    const late = t.index(t.core.accounts.folderOf(extra));
    try { late.add(1, 'duplicate'); } finally { late.db.close(); }
    await assert.rejects(t.owner.call('history.read', { id: `codex:${id(1)}` }), /more than one account/i);
    await assert.rejects(t.owner.call('history.resume', { id: `codex:${id(1)}` }), /more than one account/i);
    const bad = new Database(late.file); try { bad.exec('DROP TABLE threads; CREATE TABLE threads (id TEXT)'); } finally { bad.close(); }
    await assert.rejects(t.list('needle', 1), /history index/i);
    assert.deepEqual(await t.owner.call('sessions.list', {}), []);
  } finally { await t.close(); }
});


test('project session references share the request row budget before their eager result mapping', async () => {
  const t = await fixture({ rows: 3 });
  try {
    t.transcript(1, 'needle'); // selected project + one transcript leave one row
    const insert = t.core.db.prepare(`INSERT INTO sessions (id, project_id, provider, title, state, started_at, conversation_id, token_hash)
      VALUES (?, ?, 'shell', 'owned reference', 'exited', ?, ?, ?)`);
    insert.run('owned-reference-one', t.project.id, 1, id(1), 'owned-reference-hash-one');
    assert.equal((await t.list('needle')).length, 1);
    insert.run('owned-reference-two', t.project.id, 2, id(2), 'owned-reference-hash-two');
    await t.refused();
    t.core.db.prepare('DELETE FROM sessions WHERE id = ?').run('owned-reference-two');
    assert.equal((await t.list('needle')).length, 1);
  } finally { await t.close(); }
});


test('a VIEW named threads is unsupported instead of passing a two-pass cell admission', async () => {
  const t = await fixture({});
  try {
    const x = t.index();
    try { x.add(1, 'view marker'); x.db.exec('ALTER TABLE threads RENAME TO backing; CREATE VIEW threads AS SELECT * FROM backing'); }
    finally { x.db.close(); }
    const before = snapshot(t.home);
    await assert.rejects(t.list(), { code: 'refused', message: /history index/i });
    await assert.rejects(t.owner.call('history.read', { id: `codex:${id(1)}` }), { code: 'refused', message: /history index/i });
    assert.deepEqual(snapshot(t.home), before);
    assert.deepEqual(await t.owner.call('sessions.list', {}), []);
    const repair = new Database(x.file);
    try { repair.exec('DROP VIEW threads; ALTER TABLE backing RENAME TO threads'); } finally { repair.close(); }
    assert.equal((await t.list('view marker')).length, 1);
  } finally { await t.close(); }
});

test('ordinary and WITHOUT ROWID Codex tables both remain complete supported indexes', async () => {
  const t = await fixture({});
  try {
    const ordinary = t.index(); try { ordinary.add(1, 'ordinary marker'); } finally { ordinary.db.close(); }
    const extra = await t.owner.call('accounts.add', { provider: 'codex', label: 'without-rowid' });
    const other = t.index(t.core.accounts.folderOf(extra));
    try {
      other.db.exec('DROP TABLE threads; CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT, thread_source TEXT, first_user_message TEXT, git_branch BLOB) WITHOUT ROWID');
      other.add(2, 'without-rowid marker');
    } finally { other.db.close(); }
    const before = snapshot(t.home);
    assert.deepEqual((await t.list('marker')).map((x) => x.id).sort(), [`codex:${id(1)}`, `codex:${id(2)}`]);
    assert.deepEqual((await t.list('marker')).map((x) => x.id).sort(), [`codex:${id(1)}`, `codex:${id(2)}`]);
    assert.deepEqual(snapshot(t.home), before);
  } finally { await t.close(); }
});
