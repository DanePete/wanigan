// Synthetic historical fixtures preserve shipped SQL independently of the current
// migration list. These tests never inspect or copy an owner's database.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { MIGRATIONS, SCHEMA_VERSION, openDatabase } from './db.ts';

test('a database at schema 11, with data, opens and gains everything since', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wg-upgrade-'));
  try {
    const file = join(dir, 'wanigan.db');
    const old = new Database(file);
    const fixture = readFileSync(new URL('./fixtures/schema-11-alpha15.sql', import.meta.url));
    assert.equal(createHash('sha256').update(fixture).digest('hex'), '4a43cebcb0a920e001ee64187691eaae54a06f6f229a453e9d5b86138f124375', 'frozen schema 11 fixture');
    old.exec(fixture.toString('utf8'));
    old.prepare("INSERT INTO projects (id, key, name, path, created_at) VALUES ('p1', 'NS', 'Northstar', '/tmp/ns', 1)").run();
    old.close();

    const db = openDatabase(file);
    const columns = (db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).map((c) => c.name);
    for (const c of ['model', 'effort', 'asking', 'remote', 'transcript_path', 'ephemeral']) assert.ok(columns.includes(c), `sessions.${c}`);
    for (const t of ['attachments', 'checkpoints']) assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(t), t);
    assert.equal(Number((db.prepare("SELECT value FROM meta WHERE key = 'schema'").get() as { value: string }).value), SCHEMA_VERSION);
    assert.equal((db.prepare("SELECT name FROM projects WHERE id = 'p1'").get() as { name: string }).name, 'Northstar', 'its data is kept');
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('edits recorded before session_edits existed are carried into it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wg-upgrade-'));
  try {
    const file = join(dir, 'wanigan.db');
    // The database as it stood just before session_edits arrived.
    const before = MIGRATIONS.findIndex((m) => /CREATE TABLE session_edits/.test(m));
    assert.ok(before > 0, 'the migration under test exists');
    const old = new Database(file);
    old.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    for (const m of MIGRATIONS.slice(0, before)) old.exec(m);
    old.prepare("INSERT INTO meta VALUES ('schema', ?), ('store', 'wanigan-2')").run(String(before));
    old.prepare("INSERT INTO projects (id, key, name, path, created_at) VALUES ('p1', 'NS', 'Northstar', '/tmp/ns', 1)").run();
    old.prepare("INSERT INTO sessions (id, project_id, provider, title, state, token_hash, started_at) VALUES ('s1', 'p1', 'claude', 'A', 'exited', 'h', 1)").run();
    const add = old.prepare('INSERT INTO session_events (session_id, at, event, tool, summary, path) VALUES (?, ?, ?, ?, NULL, ?)');
    add.run('s1', 10, 'PostToolUse', 'Edit', '/tmp/ns/a.ts');
    add.run('s1', 11, 'PostToolUse', 'Bash', null);
    add.run('s1', 12, 'PostToolUse', 'Write', '/tmp/ns/b.ts');
    old.close();

    const db = openDatabase(file);
    assert.deepEqual(db.prepare('SELECT session_id, at, path FROM session_edits ORDER BY at').all(), [
      { session_id: 's1', at: 10, path: '/tmp/ns/a.ts' },
      { session_id: 's1', at: 12, path: '/tmp/ns/b.ts' },
    ]);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a database from a newer Wanigan, or marked as another store, is refused and left untouched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wg-upgrade-'));
  try {
    const newer = join(dir, 'newer.db');
    openDatabase(newer).close();
    const raw = new Database(newer);
    raw.prepare("UPDATE meta SET value = ? WHERE key = 'schema'").run(String(SCHEMA_VERSION + 1));
    raw.close();
    assert.throws(() => openDatabase(newer), new RegExp(`from a newer Wanigan \\(schema ${SCHEMA_VERSION + 1}; this build knows ${SCHEMA_VERSION}\\)`));

    const other = join(dir, 'other.db');
    const foreign = new Database(other);
    foreign.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO meta VALUES ('store', 'wanigan-1')");
    foreign.close();
    assert.throws(() => openDatabase(other), /Unrecognised store "wanigan-1"/);
    const after = new Database(other, { readonly: true });
    assert.deepEqual((after.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name), ['meta'], 'no schema was written into it');
    after.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Published alpha.15, commit 8c1b7ad145780d92d99c6ef00d476c962ccf96ce, shipped the first 21 entries.
// Later versions may append entries; changing this digest is not a migration.
test('published migration entries remain byte-for-byte unchanged', () => {
  assert.ok(MIGRATIONS.length >= 21, 'all shipped entries remain present');
  const shipped = JSON.stringify(MIGRATIONS.slice(0, 21));
  assert.equal(createHash('sha256').update(shipped).digest('hex'), '28cd7e25be8c0885536a4dffbec33b1f9e47584038afa4b1308a6911d2f8d90c');
});

test('every migration adds: none drops or renames what an earlier one made', () => {
  for (const [i, sql] of MIGRATIONS.entries()) assert.doesNotMatch(sql, /\b(DROP|RENAME)\b/i, `migration ${i + 1}`);
});


test('a database with an invalid schema marker is refused without changing its schema or data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wg-schema-'));
  try {
    for (const value of ['not a number', '-1', '1.5', '']) {
      const file = join(dir, `invalid-${encodeURIComponent(value)}.db`);
      openDatabase(file).close();
      const before = new Database(file);
      before.prepare("UPDATE meta SET value = ? WHERE key = 'schema'").run(value);
      const schema = before.prepare('SELECT sql FROM sqlite_master ORDER BY name').all();
      before.close();
      assert.throws(() => openDatabase(file), /schema.*invalid|invalid.*schema/i, value);
      const after = new Database(file, { readonly: true });
      assert.deepEqual(after.prepare('SELECT sql FROM sqlite_master ORDER BY name').all(), schema);
      assert.deepEqual(after.prepare("SELECT value FROM meta WHERE key = 'schema'").get(), { value });
      after.close();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('refusing an unmarked foreign database creates no metadata and does not change its journal mode', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wg-foreign-'));
  const file = join(dir, 'other.db');
  try {
    const before = new Database(file);
    before.exec("CREATE TABLE private_notes (value TEXT); INSERT INTO private_notes VALUES ('keep me')");
    const journal = before.pragma('journal_mode', { simple: true });
    before.close();
    assert.throws(() => openDatabase(file), /not created by Wanigan 2/);
    const after = new Database(file, { readonly: true });
    assert.deepEqual(after.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all(), [{ name: 'private_notes' }]);
    assert.equal(after.pragma('journal_mode', { simple: true }), journal);
    assert.deepEqual(after.prepare('SELECT value FROM private_notes').all(), [{ value: 'keep me' }]);
    after.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
