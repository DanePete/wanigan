// Reported usage is evidence, not a value to coerce or invent when it is absent.
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Board } from './board.ts';
import { MIGRATIONS, openDatabase, STORE_MARK } from './db.ts';
import { Jev } from './jev.ts';

function at(root: string, now = () => Date.now()) {
  const db = openDatabase(join(root, 'test.sqlite'));
  const ctx = { db, now, emit: () => {} };
  const jev = new Jev(ctx, new Board(ctx), { dataDir: root, envKey: 'fixture-only', backoffMs: 1 });
  return { db, jev };
}

const reply = (usage: unknown): Response => new Response(JSON.stringify({ answers: { ok: { noul: 1 } }, model: 'fixture', usage }));

for (const [label, usage] of [
  ['negative', { input_tokens: -1_000_000 }],
  ['string', { input_tokens: '1000000' }],
  ['fraction', { input_tokens: 0.5 }],
  ['missing usage', undefined],
  ['missing tokens', {}],
  ['null tokens', { input_tokens: null }],
  ['boolean tokens', { input_tokens: true }],
  ['extreme', { input_tokens: 1e300 }],
  ['unsafe integer', { input_tokens: Number.MAX_SAFE_INTEGER + 1 }],
] as const) {
  test(`Jev leaves ${label} usage unknown without retrying a successful answer`, async (t) => {
    const fetched = t.mock.method(globalThis, 'fetch', async () => reply(usage));
    const root = mkdtempSync(join(tmpdir(), 'wg-jev-usage-'));
    const { db, jev } = at(root);
    try {
      const answer = await jev.ask('fixture', {}, 'test');
      assert.deepEqual(answer.answers, { ok: { noul: 1 } });
      const status = await jev.status();
      assert.deepEqual([status.online, status.calls, status.errors], [true, 1, 0]);
      assert.equal(status.costUsd, null, 'an unknown token count cannot become a zero or negative cost estimate');
      assert.equal(status.knownCostUsd, 0);
      assert.equal(status.unknownUsageCalls, 1);
      assert.equal(fetched.mock.callCount(), 1, 'bad usage does not spend another HTTP attempt');
      assert.deepEqual(db.prepare('SELECT input_tokens AS tokens, usage_known AS known FROM jev_calls').get(), { tokens: 0, known: 0 });
    } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
  });
}

for (const tokens of [0, 1_000_000, Number.MAX_SAFE_INTEGER]) {
  test(`Jev accepts a numeric safe input-token count of ${tokens}`, async (t) => {
    t.mock.method(globalThis, 'fetch', async () => reply({ input_tokens: tokens }));
    const root = mkdtempSync(join(tmpdir(), 'wg-jev-known-'));
    const { db, jev } = at(root);
    try {
      await jev.ask('fixture', {}, 'test');
      const status = await jev.status();
      assert.equal(status.unknownUsageCalls, 0);
      assert.equal(status.costUsd, status.knownCostUsd);
      assert.ok(status.costUsd !== null && Number.isFinite(status.costUsd));
      if (tokens === 0) assert.equal(status.costUsd, 0, 'an explicitly reported zero remains a known zero');
      if (tokens === 1_000_000) assert.equal(status.costUsd, 0.042);
      assert.deepEqual(db.prepare('SELECT input_tokens AS tokens, usage_known AS known FROM jev_calls').get(), { tokens, known: 1 });
    } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
  });
}

test('the local demo records a deliberate known zero without making an HTTP request', async (t) => {
  const fetched = t.mock.method(globalThis, 'fetch', async () => { throw new Error('The demo must stay local.'); });
  const root = mkdtempSync(join(tmpdir(), 'wg-jev-demo-'));
  const { db } = at(root);
  try {
    const ctx = { db, now: Date.now, emit: () => {} };
    const jev = new Jev(ctx, new Board(ctx), { dataDir: root, envKey: 'fixture-only', answer: () => ({ ok: true }) });
    assert.deepEqual((await jev.ask('fixture', {}, 'test')).answers, { ok: true });
    const status = await jev.status();
    assert.deepEqual([status.costUsd, status.knownCostUsd, status.unknownUsageCalls], [0, 0, 0]);
    assert.equal(fetched.mock.callCount(), 0);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('known subtotal and unknown calls survive pruning, reopening and a new day', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => reply({ input_tokens: 1_000_000 }));
  const root = mkdtempSync(join(tmpdir(), 'wg-jev-prune-'));
  let now = Date.now();
  let service = at(root, () => now);
  try {
    const add = service.db.prepare('INSERT INTO jev_calls (at, ok, input_tokens, usage_known, purpose) VALUES (?, ?, ?, ?, ?)');
    service.db.transaction(() => {
      add.run(now, 1, 0, 0, 'unknown');
      add.run(now, 0, 0, 1, 'failed');
      for (let i = 0; i < 4_998; i++) add.run(now, 1, 1_000_000, 1, 'known');
    })();
    await service.jev.ask('fixture', {}, 'test');
    const first = await service.jev.status();
    assert.deepEqual([first.calls, first.callsToday, first.errors], [5_001, 5_001, 1]);
    assert.deepEqual([first.costUsd, first.knownCostUsd, first.unknownUsageCalls], [null, 209.958, 1]);
    assert.equal((service.db.prepare('SELECT count(*) AS n FROM jev_calls').get() as { n: number }).n, 5_000);
    assert.equal((service.db.prepare('SELECT count(*) AS n FROM jev_calls WHERE usage_known = 0').get() as { n: number }).n, 0,
      'the unknown call is now represented by the retained aggregate');
    service.db.close();
    now += 24 * 3_600_000;
    service = at(root, () => now);
    await service.jev.ask('fixture', {}, 'test');
    const after = await service.jev.status();
    assert.deepEqual([after.calls, after.callsToday, after.errors], [5_002, 1, 1]);
    assert.deepEqual([after.costUsd, after.knownCostUsd, after.unknownUsageCalls], [null, 210, 1]);
  } finally { service.db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('many individually safe token counts cannot overflow SQLite integer SUM', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wg-jev-large-sum-'));
  const { db, jev } = at(root);
  try {
    const add = db.prepare('INSERT INTO jev_calls (at, ok, input_tokens, usage_known, purpose) VALUES (1, 1, ?, 1, ?)');
    db.transaction(() => { for (let i = 0; i < 5_000; i++) add.run(Number.MAX_SAFE_INTEGER, 'fixture'); })();
    const status = await jev.status();
    assert.equal(status.calls, 5_000);
    assert.equal(status.unknownUsageCalls, 0);
    assert.ok(status.costUsd !== null && Number.isFinite(status.costUsd) && status.costUsd > 0);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('upgrading preserves legacy usage, local-model settings and paired phones without validating old usage', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => reply({ input_tokens: 1_000_000 }));
  const root = mkdtempSync(join(tmpdir(), 'wg-jev-legacy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'test.sqlite');
  const before = new Database(file);
  const now = Date.now();
  const legacy = JSON.stringify({ calls: 500, errors: 5, tokens: -1e300, today: 9, day: new Date(now).setHours(0, 0, 0, 0) });
  let projectBefore: unknown;
  let phoneBefore: unknown;
  try {
    const version = MIGRATIONS.findIndex(sql => sql.includes('ADD COLUMN usage_known'));
    assert.ok(version >= 0, 'usage provenance is an additive migration');
    before.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    for (const sql of MIGRATIONS.slice(0, version)) before.exec(sql);
    const meta = before.prepare('INSERT INTO meta VALUES (?, ?)');
    meta.run('store', STORE_MARK);
    meta.run('schema', String(version));
    meta.run('jev.pruned', legacy);
    meta.run('fixture-marker', 'preserve me');
    const add = before.prepare('INSERT INTO jev_calls (at, ok, input_tokens, purpose) VALUES (?, 1, ?, ?)');
    for (const tokens of [1_000_000, 0, -1]) add.run(now, tokens, 'legacy');
    // These records shipped in alpha.9 before the usage-provenance migration.
    // Their existing schema and every saved field must survive the upgrade.
    before.prepare('INSERT INTO projects (id, key, name, path, created_at, local_model) VALUES (?, ?, ?, ?, ?, ?)')
      .run('existing-project', 'KEEP', 'Keep local model', root, now, 'local/lmstudio/migration-fixture');
    before.prepare(`INSERT INTO phone_devices
      (id, name, token_hash, control, paired_at, last_seen_at, push_endpoint, push_p256dh, push_auth)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('existing-phone', 'Keep paired phone', 'fixture-hash-only', 0, now - 1000, now,
        'https://push.invalid/fixture', 'fixture-public-key', 'fixture-auth');
    projectBefore = before.prepare('SELECT * FROM projects WHERE id = ?').get('existing-project');
    phoneBefore = before.prepare('SELECT * FROM phone_devices WHERE id = ?').get('existing-phone');
  } finally { before.close(); }
  const { db, jev } = at(root, () => now);
  try {
    assert.deepEqual(db.prepare('SELECT * FROM projects WHERE id = ?').get('existing-project'), projectBefore);
    assert.deepEqual(db.prepare('SELECT * FROM phone_devices WHERE id = ?').get('existing-phone'), phoneBefore);
    assert.equal((db.prepare("SELECT value FROM meta WHERE key = 'schema'").get() as { value: string }).value, String(MIGRATIONS.length));
    assert.deepEqual(db.prepare('SELECT input_tokens AS tokens, usage_known AS known FROM jev_calls ORDER BY id').all(),
      [{ tokens: 1_000_000, known: 0 }, { tokens: 0, known: 0 }, { tokens: -1, known: 0 }]);
    await jev.ask('fixture', {}, 'test');
    const status = await jev.status();
    assert.deepEqual([status.calls, status.callsToday, status.errors], [504, 13, 5]);
    assert.deepEqual([status.costUsd, status.knownCostUsd, status.unknownUsageCalls], [null, 0.042, 498]);
    const add = db.prepare('INSERT INTO jev_calls (at, ok, input_tokens, usage_known, purpose) VALUES (?, 1, 1000000, 1, ?)');
    db.transaction(() => { for (let i = 0; i < 5_000; i++) add.run(now, 'known'); })();
    await jev.ask('fixture', {}, 'test');
    const pruned = await jev.status();
    assert.deepEqual([pruned.calls, pruned.callsToday, pruned.errors], [5_505, 5_014, 5]);
    assert.deepEqual([pruned.costUsd, pruned.knownCostUsd, pruned.unknownUsageCalls], [null, 210.084, 498]);
    assert.equal((db.prepare('SELECT count(*) AS n FROM jev_calls').get() as { n: number }).n, 5_000);
    assert.equal((db.prepare("SELECT value FROM meta WHERE key = 'jev.pruned'").get() as { value: string }).value, legacy);
    assert.equal((db.prepare("SELECT value FROM meta WHERE key = 'fixture-marker'").get() as { value: string }).value, 'preserve me');
    assert.deepEqual(db.prepare('SELECT * FROM projects WHERE id = ?').get('existing-project'), projectBefore);
    assert.deepEqual(db.prepare('SELECT * FROM phone_devices WHERE id = ?').get('existing-phone'), phoneBefore);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
