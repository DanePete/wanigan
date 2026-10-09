// Real-core cache outcomes: every provider root belongs to this fixture. Cache
// inspection is test-only; no diagnostics are added to the owner protocol.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import type { AccountProvider, HistoryItem } from '../shared/model.ts';
import { CoreError } from '../shared/protocol.ts';
import { claudeSlug } from './history.ts';
import { testCore } from './test-support.ts';

const SUMMARY_ENTRIES = 512;
const SUMMARY_BYTES = 2 * 1024 * 1024;
const THREAD_ENTRIES = 8;
const THREAD_ROWS = 4096;
const THREAD_BYTES = 8 * 1024 * 1024;
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

type Retained = { stamp: string; summary?: Record<string, unknown>; rows?: Record<string, unknown>[] };
type Cache = Map<string, Retained> | { entries: Map<string, { value: Retained }>; get(key: string): Retained | undefined; delete(key: string): void };
function entries(cache: Cache): [string, Retained][] {
  return cache instanceof Map ? [...cache] : [...cache.entries].map(([key, entry]) => [key, entry.value]);
}
function payload(values: unknown[]): number {
  return values.reduce<number>((sum, value) => sum + (typeof value === 'string' ? value.length * 2 : ArrayBuffer.isView(value) ? value.buffer.byteLength : 0), 0);
}
function measured(cache: Cache) {
  const all = entries(cache);
  return {
    entries: all.length,
    rows: all.reduce((n, [, value]) => n + (value.rows?.length ?? 0), 0),
    bytes: all.reduce((n, [key, value]) => n + payload([key, value.stamp, ...Object.values(value.summary ?? {}), ...(value.rows ?? []).flatMap((row) => Object.values(row))]), 0),
  };
}
function caches(t: Awaited<ReturnType<typeof testCore>>): { summaries: Cache; threads: Cache } {
  const history = t.core.history as unknown as { summaries: Cache; threads: Cache };
  return { summaries: history.summaries, threads: history.threads };
}
function cold(t: Awaited<ReturnType<typeof testCore>>): void {
  for (const cache of Object.values(caches(t))) for (const [key] of entries(cache)) cache.delete(key);
}
function snapshot(root: string): Record<string, { mode: number; mtime: number; bytes: Buffer | null }> {
  const out: Record<string, { mode: number; mtime: number; bytes: Buffer | null }> = {};
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name); const stat = statSync(file);
      out[relative(root, file)] = { mode: stat.mode, mtime: stat.mtimeMs, bytes: entry.isFile() ? readFileSync(file) : null };
      if (entry.isDirectory()) visit(file);
    }
  };
  visit(root); return out;
}
function transcript(home: string, cwd: string, n: number, options: { text?: string; lineage?: string; at?: number; branch?: string; filedAt?: string } = {}): string {
  const file = join(home, 'projects', claudeSlug(options.filedAt ?? cwd), `${id(n)}.jsonl`);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify({ type: 'user', uuid: options.lineage ?? id(n), cwd, timestamp: new Date(options.at ?? Date.UTC(2026, 9, 1, 0, 0, n)).toISOString(),
    gitBranch: options.branch, message: { content: options.text ?? `cache fixture ${n}` } }) + '\n');
  return file;
}
function index(home: string): Database.Database {
  const db = new Database(join(home, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT, cwd TEXT, thread_source TEXT, rollout_path TEXT, first_user_message TEXT, git_branch TEXT, created_at_ms INTEGER, updated_at_ms INTEGER)');
  return db;
}
function row(db: Database.Database, cwd: string, n: number, text = `codex fixture ${n}`, branch: unknown = null): void {
  db.prepare('INSERT INTO threads VALUES (?,?,?,?,?,?,?,?)').run(id(n), cwd, 'user', null, text, branch, n, n);
}
async function fixture(extras: { provider: AccountProvider; label: string }[] = []) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wg-history-cache-'))); const home = join(root, 'home');
  const homes = { claude: join(home, '.claude'), codex: join(home, '.codex') };
  for (const provider of ['claude', 'codex'] as const) { mkdirSync(homes[provider], { recursive: true }); writeFileSync(join(homes[provider], provider === 'claude' ? 'settings.json' : 'config.toml'), provider === 'claude' ? '{}' : ''); }
  for (const { provider, label } of extras) { const dir = join(home, `.${provider}_${label}`); mkdirSync(dir); writeFileSync(join(dir, provider === 'claude' ? 'settings.json' : 'config.toml'), provider === 'claude' ? '{}' : ''); }
  const t = await testCore({ accounts: { home } });
  try {
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    const accounts = await t.owner.call('accounts.list', {});
    for (const provider of ['claude', 'codex'] as const) {
      assert.deepEqual(accounts.filter((a) => a.provider === provider).map((a) => t.core.accounts.folderOf(a)).sort(),
        [homes[provider], ...extras.filter((a) => a.provider === provider).map((a) => join(home, `.${provider}_${a.label}`))].sort());
    }
    return { ...t, home, homes, project, async close() { await t.close(); rmSync(root, { recursive: true, force: true }); } };
  } catch (error) { await t.close(); rmSync(root, { recursive: true, force: true }); throw error; }
}

test('600 Claude transcripts keep complete cold/warm/evicted search with bounded retained entries', async (context) => {
  const t = await fixture();
  try {
    for (let n = 1; n <= 600; n++) transcript(t.homes.claude, t.projectDir, n, { text: n === 1 ? 'older needle beyond five hundred' : `cache fixture ${n}` });
    const before = snapshot(t.home);
    const all = await t.owner.call('history.list', { projectId: t.project.id, limit: 2000 });
    assert.equal(all.length, 600);
    assert.deepEqual(all.map((item) => item.id), Array.from({ length: 600 }, (_, i) => `claude:${id(600 - i)}`));
    const cache = caches(t).summaries; const originalGet = cache.get; let misses = 0; let hits = 0;
    cache.get = (key: string): Retained | undefined => { const value = originalGet.call(cache, key); if (value) hits++; else misses++; return value; };
    try { assert.deepEqual(await t.owner.call('history.list', { projectId: t.project.id, limit: 2000 }), all, 'warm result is identical'); }
    finally { cache.get = originalGet; }
    context.diagnostic(JSON.stringify({ repeatedSequentialScan: { misses, hits }, transcripts: 600 }));
    if (!(cache instanceof Map)) assert.equal(misses, 600, 'a complete sequential scan larger than LRU capacity rereads each summary');
    cold(t);
    assert.deepEqual(await t.owner.call('history.list', { projectId: t.project.id, limit: 2000 }), all, 'cold result is identical');
    assert.equal((await t.owner.call('history.list', { projectId: t.project.id })).length, 500);
    assert.deepEqual(await t.owner.call('history.list', { projectId: t.project.id, limit: 1 }), [all[0]]);
    // The first entry is outside the retained tail after a complete scan.
    if (!(caches(t).summaries instanceof Map)) assert.ok(!entries(caches(t).summaries).some(([file]) => file.endsWith(`${id(1)}.jsonl`)));
    assert.deepEqual((await t.owner.call('history.list', { projectId: t.project.id, query: 'older needle' })).map((item) => item.id), [`claude:${id(1)}`]);
    const retained = measured(caches(t).summaries);
    context.diagnostic(JSON.stringify({ discovered: 600, requestedLimit: 1, retained }));
    assert.ok(retained.entries <= SUMMARY_ENTRIES, 'result limit does not justify retaining every discovered summary');
    assert.ok(retained.bytes <= SUMMARY_BYTES);
    assert.deepEqual(snapshot(t.home), before);
  } finally { await t.close(); }
});

test('Codex row and index budgets retain complete search and the 2000-result maximum', async (context) => {
  const t = await fixture(Array.from({ length: 8 }, (_, i) => ({ provider: 'codex' as const, label: `work${i}` })));
  try {
    const db = index(t.homes.codex);
    try { db.transaction(() => { for (let n = 1; n <= 4097; n++) row(db, t.projectDir, n, n === 1 ? 'oversized index oldest needle' : `codex fixture ${n}`); })(); } finally { db.close(); }
    for (let i = 0; i < 8; i++) { const small = index(join(t.home, `.codex_work${i}`)); try { row(small, t.projectDir, 5000 + i); } finally { small.close(); } }
    const before = snapshot(t.home);
    const all = await t.owner.call('history.list', { projectId: t.project.id, limit: 9999 });
    assert.equal(all.length, 2000);
    assert.equal(all[0]!.id, `codex:${id(5007)}`);
    const needle = await t.owner.call('history.list', { projectId: t.project.id, query: 'oldest needle' });
    assert.deepEqual(needle.map((item) => item.id), [`codex:${id(1)}`]);
    assert.deepEqual(await t.owner.call('history.list', { projectId: t.project.id, limit: 9999 }), all);
    cold(t);
    assert.deepEqual(await t.owner.call('history.list', { projectId: t.project.id, query: 'oldest needle' }), needle);
    const retained = measured(caches(t).threads);
    context.diagnostic(JSON.stringify({ discoveredRows: 4105, discoveredIndexes: 9, retained }));
    assert.ok(retained.entries <= THREAD_ENTRIES);
    assert.ok(retained.rows <= THREAD_ROWS, 'a single oversized database must bypass retention');
    assert.ok(retained.bytes <= THREAD_BYTES);
    assert.ok(!entries(caches(t).threads).some(([key]) => key === join(t.homes.codex, 'state_5.sqlite')));
    assert.deepEqual(snapshot(t.home), before);
  } finally { await t.close(); }
});

test('nine individually small Codex indexes evict by index count without omitting results', async () => {
  const t = await fixture(Array.from({ length: 8 }, (_, i) => ({ provider: 'codex' as const, label: `work${i}` })));
  try {
    const homes = [t.homes.codex, ...Array.from({ length: 8 }, (_, i) => join(t.home, `.codex_work${i}`))];
    homes.forEach((home, i) => { const db = index(home); try { row(db, t.projectDir, i + 1); } finally { db.close(); } });
    const before = snapshot(t.home);
    const all = await t.owner.call('history.list', { projectId: t.project.id });
    assert.equal(all.length, 9); assert.equal(measured(caches(t).threads).entries, 8);
    assert.deepEqual(await t.owner.call('history.list', { projectId: t.project.id }), all);
    assert.deepEqual(snapshot(t.home), before);
  } finally { await t.close(); }
});

test('individually cacheable Codex indexes share one row and payload budget', async () => {
  const t = await fixture([{ provider: 'codex', label: 'work' }]);
  try {
    const homes = [t.homes.codex, join(t.home, '.codex_work')];
    for (let i = 0; i < homes.length; i++) {
      const db = index(homes[i]!);
      try { db.transaction(() => { for (let n = 1; n <= 2100; n++) row(db, t.projectDir, n + i * 3000); })(); } finally { db.close(); }
    }
    const before = snapshot(t.home);
    assert.equal((await t.owner.call('history.list', { projectId: t.project.id, limit: 2000 })).length, 2000);
    assert.equal(measured(caches(t).threads).rows, 2100, 'two individually fitting row sets cannot exceed their combined row budget');
    assert.equal((await t.owner.call('history.list', { projectId: t.project.id, query: 'fixture 1' })).length > 0, true);
    assert.deepEqual(snapshot(t.home), before);
    for (let i = 0; i < homes.length; i++) {
      const file = join(homes[i]!, 'state_5.sqlite'); const db = new Database(file);
      try { db.exec('DELETE FROM threads'); row(db, t.projectDir, i + 1, `long ${i} ` + 'x'.repeat(2_200_000)); } finally { db.close(); }
      utimesSync(file, new Date(1_900_000_000_000 + i * 1000), new Date(1_900_000_000_000 + i * 1000));
    }
    const edited = snapshot(t.home);
    const all = await t.owner.call('history.list', { projectId: t.project.id });
    assert.equal(all.length, 2); assert.equal(measured(caches(t).threads).entries, 1);
    assert.ok(measured(caches(t).threads).bytes <= THREAD_BYTES);
    assert.deepEqual(await t.owner.call('history.list', { projectId: t.project.id }), all);
    assert.deepEqual(snapshot(t.home), edited);
  } finally { await t.close(); }
});

test('retained summary payload is bounded without truncating searchable metadata', async (context) => {
  const t = await fixture();
  try {
    const branch = 'b'.repeat(120_000) + ' branch-needle';
    for (let n = 1; n <= 14; n++) transcript(t.homes.claude, t.projectDir, n, { branch });
    const before = snapshot(t.home);
    const all = await t.owner.call('history.list', { projectId: t.project.id, query: 'branch-needle' });
    assert.equal(all.length, 14); assert.ok(all.every((item) => item.branch === branch));
    const retained = measured(caches(t).summaries); context.diagnostic(JSON.stringify({ retained }));
    assert.ok(retained.bytes <= SUMMARY_BYTES);
    cold(t);
    assert.deepEqual(await t.owner.call('history.list', { projectId: t.project.id, query: 'branch-needle' }), all);
    assert.deepEqual(snapshot(t.home), before);
  } finally { await t.close(); }
});

test('oversized Codex string and binary metadata bypass retention while ordinary results remain usable', async (context) => {
  const t = await fixture([{ provider: 'codex', label: 'binary' }]);
  try {
    const db = index(t.homes.codex);
    try { row(db, t.projectDir, 1, 'visible needle ' + 'x'.repeat(4 * 1024 * 1024)); } finally { db.close(); }
    const binary = index(join(t.home, '.codex_binary'));
    // The binary value lives in an out-of-project row: it is retained by the old
    // raw-row cache but never passed to text matching or returned by this list.
    try { row(binary, '/fixture-not-this-project', 2, 'binary metadata', Buffer.alloc(THREAD_BYTES + 1, 7)); row(binary, t.projectDir, 3); } finally { binary.close(); }
    const before = snapshot(t.home);
    const all = await t.owner.call('history.list', { projectId: t.project.id });
    assert.deepEqual(all.map((item) => item.id), [`codex:${id(3)}`, `codex:${id(1)}`]);
    assert.deepEqual((await t.owner.call('history.list', { projectId: t.project.id, query: 'visible needle' })).map((item) => item.id), [`codex:${id(1)}`]);
    const retained = measured(caches(t).threads); context.diagnostic(JSON.stringify({ retained }));
    assert.equal(retained.entries, 0, 'neither oversized raw row set is retained');
    assert.deepEqual(await t.owner.call('history.list', { projectId: t.project.id }), all);
    assert.deepEqual(snapshot(t.home), before);
  } finally { await t.close(); }
});

test('removed, changed and unsupported cached sources are purged without hiding repair recovery', async () => {
  const t = await fixture();
  try {
    const source = transcript(t.homes.claude, t.projectDir, 1);
    const file = join(t.homes.codex, 'state_5.sqlite'); const db = index(t.homes.codex);
    try { row(db, t.projectDir, 2); } finally { db.close(); }
    await t.owner.call('history.list', { projectId: t.project.id });
    assert.equal(measured(caches(t).summaries).entries, 1); assert.equal(measured(caches(t).threads).entries, 1);
    rmSync(source); rmSync(file);
    const removed = snapshot(t.home);
    assert.deepEqual(await t.owner.call('history.list', { projectId: t.project.id }), []);
    assert.equal(measured(caches(t).summaries).entries, 0); assert.equal(measured(caches(t).threads).entries, 0);
    assert.deepEqual(snapshot(t.home), removed);
    const repair = index(t.homes.codex); try { row(repair, t.projectDir, 3); } finally { repair.close(); }
    await t.owner.call('history.list', { projectId: t.project.id });
    const breakSchema = new Database(file); try { breakSchema.exec('DROP TABLE threads; CREATE TABLE threads (id TEXT)'); } finally { breakSchema.close(); }
    utimesSync(file, new Date(1_900_000_000_000), new Date(1_900_000_000_000));
    const broken = snapshot(t.home);
    await assert.rejects(t.owner.call('history.list', { projectId: t.project.id }), /history index/i);
    assert.equal(measured(caches(t).threads).entries, 0);
    assert.deepEqual(snapshot(t.home), broken);
    const empty = new Database(file); try { empty.exec('DROP TABLE threads; CREATE TABLE threads (id TEXT, cwd TEXT, thread_source TEXT)'); } finally { empty.close(); }
    utimesSync(file, new Date(1_900_000_001_000), new Date(1_900_000_001_000));
    const repaired = snapshot(t.home);
    assert.deepEqual(await t.owner.call('history.list', { projectId: t.project.id }), []);
    assert.deepEqual(snapshot(t.home), repaired);
  } finally { await t.close(); }
});

test('fork selection, project filtering and equal-time order survive cold, warm and evicted caches', async () => {
  const t = await fixture([{ provider: 'claude', label: 'work' }]);
  try {
    const work = join(t.home, '.claude_work'); const churn = join(t.dir, 'churn'); mkdirSync(churn);
    const other = await t.owner.call('projects.add', { path: churn, key: 'CH' });
    transcript(t.homes.claude, t.projectDir, 1, { lineage: 'older-matches', text: 'hidden needle', at: 10_000 });
    transcript(work, t.projectDir, 2, { lineage: 'older-matches', text: 'newest plain', at: 20_000 });
    transcript(t.homes.claude, t.projectDir, 3, { lineage: 'newer-matches', text: 'old plain', at: 10_000 });
    transcript(work, t.projectDir, 4, { lineage: 'newer-matches', text: 'newest needle', at: 20_000 });
    transcript(t.homes.claude, t.projectDir, 5, { lineage: 'equal-time', text: 'first equal copy', at: 30_000 });
    transcript(work, t.projectDir, 6, { lineage: 'equal-time', text: 'second equal copy', at: 30_000 });
    transcript(t.homes.claude, t.projectDir, 7, { text: 'independent equal time', at: 30_000 });
    transcript(t.homes.claude, t.projectDir, 9, { lineage: 'project-filter', text: 'project needle', at: 10_000 });
    transcript(work, churn, 10, { lineage: 'project-filter', text: 'other project', at: 40_000, filedAt: t.projectDir });
    for (let n = 1000; n < 1520; n++) transcript(t.homes.claude, churn, n);
    const before = snapshot(t.home);
    const list = () => t.owner.call('history.list', { projectId: t.project.id });
    const expected = await list();
    assert.deepEqual(expected.map((item) => item.id), [5, 7, 2, 4, 9].map((n) => `claude:${id(n)}`));
    assert.deepEqual((await t.owner.call('history.list', { projectId: t.project.id, query: 'needle' })).map((item) => item.id), [4, 9].map((n) => `claude:${id(n)}`));
    assert.deepEqual(await list(), expected);
    cold(t); assert.deepEqual(await list(), expected);
    assert.equal((await t.owner.call('history.list', { projectId: other.id, limit: 2000 })).length, 520);
    if (!(caches(t).summaries instanceof Map)) assert.ok(!entries(caches(t).summaries).some(([file]) => file.endsWith(`${id(5)}.jsonl`)));
    assert.deepEqual(await list(), expected, 'eviction changes no fork, identity, field or ordering result');
    assert.deepEqual(snapshot(t.home), before);
  } finally { await t.close(); }
});

test('a live uncheckpointed Codex WAL invalidates retained rows and remains byte-exact', async () => {
  const t = await fixture(); let writer: Database.Database | null = null;
  try {
    writer = index(t.homes.codex); writer.pragma('journal_mode = WAL'); writer.pragma('wal_autocheckpoint = 0');
    row(writer, t.projectDir, 1, 'before WAL edit');
    const before = snapshot(t.home);
    assert.equal((await t.owner.call('history.list', { projectId: t.project.id }))[0]!.firstPrompt, 'before WAL edit');
    assert.deepEqual(snapshot(t.home), before);
    writer.prepare('UPDATE threads SET first_user_message = ? WHERE id = ?').run('after WAL edit needle', id(1));
    const edited = snapshot(t.home);
    const after = await t.owner.call('history.list', { projectId: t.project.id, query: 'needle' });
    assert.equal(after.length, 1); assert.equal(after[0]!.firstPrompt, 'after WAL edit needle');
    assert.deepEqual(snapshot(t.home), edited, 'the index, WAL and SHM are unchanged by invalidation and reread');
    assert.deepEqual(await t.owner.call('history.list', { projectId: t.project.id, query: 'needle' }), after);
    assert.deepEqual(snapshot(t.home), edited);
  } finally { writer?.close(); await t.close(); }
});

test('a later damaged account still refuses a limited query after an earlier cached match', async () => {
  const t = await fixture([{ provider: 'codex', label: 'work' }]);
  try {
    const first = index(t.homes.codex); try { row(first, t.projectDir, 1, 'first account needle'); } finally { first.close(); }
    const work = join(t.home, '.codex_work'); const later = index(work); later.close();
    const expected = await t.owner.call('history.list', { projectId: t.project.id, query: 'needle', limit: 1 });
    assert.deepEqual(expected.map((item) => item.id), [`codex:${id(1)}`]);
    assert.ok(entries(caches(t).threads).some(([file]) => file === join(t.homes.codex, 'state_5.sqlite')));
    const file = join(work, 'state_5.sqlite'); const broken = new Database(file);
    try { broken.exec('DROP TABLE threads; CREATE TABLE threads (id TEXT)'); } finally { broken.close(); }
    utimesSync(file, new Date(1_900_000_000_000), new Date(1_900_000_000_000));
    const before = snapshot(t.home);
    for (let i = 0; i < 2; i++) await assert.rejects(t.owner.call('history.list', { projectId: t.project.id, query: 'needle', limit: 1 }), /history index/i);
    assert.deepEqual(snapshot(t.home), before);
    const repair = new Database(file);
    try { repair.exec('DROP TABLE threads; CREATE TABLE threads (id TEXT, cwd TEXT, thread_source TEXT)'); } finally { repair.close(); }
    utimesSync(file, new Date(1_900_000_001_000), new Date(1_900_000_001_000));
    const repaired = snapshot(t.home);
    assert.deepEqual(await t.owner.call('history.list', { projectId: t.project.id, query: 'needle', limit: 1 }), expected);
    assert.deepEqual(await t.owner.call('sessions.list', {}), []);
    assert.deepEqual(snapshot(t.home), repaired);
  } finally { await t.close(); }
});

for (const provider of ['claude', 'codex'] as const) {
  test(`late ${provider} account duplicates refuse read/resume when one copy is retained and the other is not`, async () => {
    const t = await fixture([{ provider, label: 'work' }]);
    try {
      const work = join(t.home, `.${provider}_work`); const churn = join(t.dir, 'churn'); mkdirSync(churn);
      const other = await t.owner.call('projects.add', { path: churn, key: 'CH' });
      if (provider === 'claude') {
        transcript(t.homes.claude, t.projectDir, 1, { text: 'original account marker' });
        for (let n = 1000; n < 1520; n++) transcript(t.homes.claude, churn, n);
        assert.equal((await t.owner.call('history.list', { projectId: t.project.id }))[0]!.firstPrompt, 'original account marker');
        await t.owner.call('history.list', { projectId: other.id });
        if (!(caches(t).summaries instanceof Map)) assert.ok(!entries(caches(t).summaries).some(([file]) => file.endsWith(`${id(1)}.jsonl`)));
        transcript(work, churn, 1, { text: 'late account marker', lineage: 'distinct-lineage' });
        const selected = await t.owner.call('history.list', { projectId: other.id, query: 'late account marker' });
        assert.equal(selected.length, 1); assert.equal(t.core.accounts.folderOf(t.core.accounts.get(selected[0]!.accountId)), work);
      } else {
        const original = index(t.homes.codex); try { row(original, t.projectDir, 1, 'original account marker'); } finally { original.close(); }
        const initial = await t.owner.call('history.list', { projectId: t.project.id });
        assert.equal(initial[0]!.firstPrompt, 'original account marker');
        const late = index(work);
        try { late.transaction(() => { row(late, churn, 1, 'late account marker'); for (let n = 1000; n < 5096; n++) row(late, churn, n); })(); } finally { late.close(); }
        const selected = await t.owner.call('history.list', { projectId: other.id, query: 'late account marker' });
        assert.equal(selected.length, 1); assert.equal(t.core.accounts.folderOf(t.core.accounts.get(selected[0]!.accountId)), work);
        if (!(caches(t).threads instanceof Map)) {
          assert.ok(entries(caches(t).threads).some(([file]) => file === join(t.homes.codex, 'state_5.sqlite')));
          assert.ok(!entries(caches(t).threads).some(([file]) => file === join(work, 'state_5.sqlite')));
        }
      }
      const before = snapshot(t.home);
      await assert.rejects(t.owner.call('history.read', { id: `${provider}:${id(1)}` }), /more than one account|ambiguous/i);
      await assert.rejects(t.owner.call('history.resume', { id: `${provider}:${id(1)}` }), /more than one account|ambiguous/i);
      assert.deepEqual(await t.owner.call('sessions.list', {}), []);
      assert.deepEqual(snapshot(t.home), before);
    } finally { await t.close(); }
  });
}


// Paired owner-RPC observations: eviction changes only retained History data,
// using the same test-only cold() seam as the established cache tests above.
type HistoryOutcome = { kind: 'value'; items: HistoryItem[] } | { kind: 'error'; code: string; message: string };
function freshnessMetadata(file: string) {
  const s = statSync(file);
  return { dev: s.dev, ino: s.ino, size: s.size, mode: s.mode & 0o777, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs };
}
const freshnessDigest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

for (const provider of ['claude', 'codex'] as const) {
  for (const mutation of ['atomic replacement', 'in-place edit', 'read permission loss'] as const) {
    test(`History freshness: ${provider} ${mutation} keeps warm and cold owner reads equivalent`, async (context) => {
      // Permission observations must exercise the OS, never a mocked read error.
      if (mutation === 'read permission loss') assert.ok(process.getuid && process.getuid() !== 0, 'permission fixture requires a nonroot process');
      const t = await fixture(); let file: string | null = null; let originalMode: number | null = null;
      const oldText = 'old history fixture', newText = 'new history fixture';
      const fixedTime = new Date(Date.UTC(2026, 8, 1)), recoveredTime = new Date(Date.UTC(2026, 8, 1, 0, 0, 1));
      const list = () => t.owner.call('history.list', { projectId: t.project.id });
      const observe = async (): Promise<HistoryOutcome> => {
        try { return { kind: 'value', items: await list() }; }
        catch (error) {
          // An unexpected transport or fixture exception must fail this case.
          if (!(error instanceof CoreError)) throw error;
          return { kind: 'error', code: error.code, message: error.message };
        }
      };
      const assertSingle = (items: HistoryItem[], text: string): void => {
        assert.equal(items.length, 1);
        assert.equal(items[0]!.id, `${provider}:${id(1)}`);
        assert.equal(items[0]!.firstPrompt, text);
      };
      const noSidecars = (path: string): void => {
        if (provider === 'codex') for (const suffix of ['-wal', '-shm', '-journal']) assert.equal(existsSync(path + suffix), false, `closed DELETE-journal fixture has no ${suffix}`);
      };
      try {
        if (provider === 'claude') file = transcript(t.homes.claude, t.projectDir, 1, { text: oldText, at: 10_000 });
        else {
          file = join(t.homes.codex, 'state_5.sqlite'); const db = index(t.homes.codex);
          try { assert.equal(db.pragma('journal_mode = DELETE', { simple: true }), 'delete'); row(db, t.projectDir, 1, oldText); }
          finally { db.close(); }
        }
        noSidecars(file); utimesSync(file, fixedTime, fixedTime);
        const before = freshnessMetadata(file); originalMode = before.mode;
        const originalBytes = readFileSync(file), initialFiles = snapshot(t.home);
        const initial = await list(); assertSingle(initial, oldText);
        assert.deepEqual(await list(), initial, 'unchanged warm control');
        cold(t); assert.deepEqual(await list(), initial, 'unchanged cold control');
        assert.deepEqual(await list(), initial, 'warm immediately before mutation');
        assert.deepEqual(snapshot(t.home), initialFiles, 'read controls do not alter source bytes, modes or mtimes');

        if (mutation === 'read permission loss') {
          chmodSync(file, 0);
          assert.throws(() => readFileSync(file!), (error: unknown) => (error as NodeJS.ErrnoException).code === 'EACCES', 'owned leaf actually denies read access');
        } else {
          const target = mutation === 'atomic replacement' ? `${file}.replacement` : file;
          if (provider === 'claude') {
            const oldJson = originalBytes.toString('utf8'); assert.equal(oldJson.split(oldText).length, 2);
            const newJson = oldJson.replace(oldText, newText); assert.equal(Buffer.byteLength(newJson), originalBytes.length);
            writeFileSync(target, newJson, { flag: mutation === 'atomic replacement' ? 'wx' : 'w', mode: originalMode });
          } else {
            if (mutation === 'atomic replacement') writeFileSync(target, originalBytes, { flag: 'wx', mode: originalMode });
            const db = new Database(target, { fileMustExist: true });
            try {
              assert.equal(db.pragma('journal_mode = DELETE', { simple: true }), 'delete');
              assert.equal(db.prepare('UPDATE threads SET first_user_message = ? WHERE id = ?').run(newText, id(1)).changes, 1);
            } finally { db.close(); }
          }
          noSidecars(target); utimesSync(target, fixedTime, fixedTime);
          if (mutation === 'atomic replacement') renameSync(target, file);
        }
        const changed = freshnessMetadata(file); noSidecars(file);
        assert.equal(changed.size, before.size, 'mutation retains the observed file size');
        assert.equal(changed.mtimeMs, before.mtimeMs, 'mutation retains the observed modification time');
        assert.equal(changed.dev, before.dev);
        if (mutation === 'atomic replacement') assert.notEqual(changed.ino, before.ino, 'replacement has a different file identity');
        else assert.equal(changed.ino, before.ino, 'in-place mutation keeps file identity');
        assert.notEqual(changed.ctimeMs, before.ctimeMs, 'mutation has an observed change-time signal');
        const changedBytes = mutation === 'read permission loss' ? originalBytes : readFileSync(file);
        if (mutation !== 'read permission loss') assert.notDeepEqual(changedBytes, originalBytes);
        const expectedFiles = mutation === 'read permission loss' ? initialFiles : snapshot(t.home);
        let warm: HistoryOutcome, fresh: HistoryOutcome;
        try {
          warm = await observe(); cold(t); fresh = await observe();
          assert.deepEqual(freshnessMetadata(file), changed, 'the paired RPC reads leave file metadata unchanged');
          noSidecars(file);
          if (mutation === 'read permission loss') assert.throws(() => readFileSync(file!), (error: unknown) => (error as NodeJS.ErrnoException).code === 'EACCES');
        } finally {
          // Restore permissions before any semantic assertion or fixture removal.
          if (mutation === 'read permission loss') chmodSync(file, originalMode);
        }
        assert.deepEqual(readFileSync(file), changedBytes);
        assert.deepEqual(snapshot(t.home), expectedFiles, 'both reads preserve all owned provider source bytes, modes and mtimes');
        const recoveryText = mutation === 'read permission loss' ? oldText : newText;
        // A normal modification-time change remains a recovery control. No cache
        // deletion occurs between the failed/read observation and this first read.
        utimesSync(file, recoveredTime, recoveredTime); const recoveryFiles = snapshot(t.home);
        const recovered = await list(); assertSingle(recovered, recoveryText);
        assert.deepEqual(await list(), recovered, 'recovered warm read');
        cold(t); assert.deepEqual(await list(), recovered, 'recovered cold read');
        assert.deepEqual(snapshot(t.home), recoveryFiles);
        assert.deepEqual(await t.owner.call('sessions.list', {}), [], 'History discovery starts no session');
        context.diagnostic(JSON.stringify({ provider, mutation, before, changed,
          originalSha256: freshnessDigest(originalBytes), changedSha256: freshnessDigest(changedBytes),
          warm, fresh, recovered, ownedSourcesPreserved: true }));
        if (mutation === 'read permission loss') {
          if (provider === 'claude') assert.deepEqual(fresh, { kind: 'value', items: [] }, 'cold unreadable Claude source retains its omission behavior');
          else {
            assert.equal(fresh.kind, 'error');
            if (fresh.kind === 'error') { assert.equal(fresh.code, 'refused'); assert.match(fresh.message, /history index could not be read/i); }
          }
        } else {
          assert.equal(fresh.kind, 'value'); if (fresh.kind === 'value') assertSingle(fresh.items, newText);
        }
        // Last deliberately: actual paired outcomes and recovery are retained
        // even when the original warm cache disagrees with a fresh read.
        assert.deepEqual(warm, fresh, 'a retained History result must agree with a fresh read of the same source state');
      } finally {
        if (file && originalMode !== null && existsSync(file)) chmodSync(file, originalMode);
        const ownCoreDir = t.dir, ownHome = t.home, sockets = [t.core.paths.socket, t.core.paths.hookSocket];
        await t.close();
        assert.equal(existsSync(ownCoreDir), false); assert.equal(existsSync(ownHome), false);
        for (const socket of sockets) assert.equal(existsSync(socket), false);
        context.diagnostic(JSON.stringify({ provider, mutation, coreClosed: true, ownedCoreAndHomeRemoved: true, socketsRemoved: true }));
      }
    });
  }
}
