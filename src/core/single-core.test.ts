// A stale socket probe cannot let two supervisors recover or own one store.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Core } from './core.ts';
import { MIGRATIONS } from './db.ts';
import { launcher, testCore } from './test-support.ts';

test('a second core for the same store cannot recover the first core’s live sessions or take its socket', async () => {
  const t = await testCore();
  let second: Core | null = null;
  try {
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    const session = await t.owner.call('sessions.start', { projectId: project.id, provider: 'shell' });
    const checkpoint = join(t.core.paths.dataDir, 'checkpoints', 'active.index');
    writeFileSync(checkpoint, 'a live checkpoint index');
    await assert.rejects(async () => { second = new Core({
      dataDir: t.core.paths.dataDir, launcher, codexHookProbe: null, jev: { envKey: null },
      accounts: { home: join(t.dir, 'home'), prober: async () => ({ signedIn: 'unknown', identity: null, plan: null }), usageReader: async () => ({ state: 'unreadable', windows: [], checkedAt: 0, note: 'test' }) },
    }); await second.start(); }, /Another Wanigan core owns this store/);
    assert.equal(readFileSync(checkpoint, 'utf8'), 'a live checkpoint index', 'refusal precedes checkpoint cleanup');
    assert.equal((await t.owner.call('sessions.get', { id: session.id })).session.state, 'running');
    assert.equal((await t.owner.call('core.hello', {})).role, 'owner');
  } finally {
    await (second as Core | null)?.stop();
    await t.close();
  }
});


test('a refused second core cannot apply a newer schema before ownership admission', async () => {
  const t = await testCore();
  const migrations = MIGRATIONS as string[];
  const before = t.core.db.prepare("SELECT value FROM meta WHERE key = 'schema'").get();
  migrations.push('CREATE TABLE next_build_only (id TEXT PRIMARY KEY)');
  try {
    assert.throws(() => new Core({ dataDir: t.core.paths.dataDir }), /Another Wanigan core owns this store/);
    assert.equal(t.core.db.prepare("SELECT name FROM sqlite_master WHERE name = 'next_build_only'").get(), undefined);
    assert.deepEqual(t.core.db.prepare("SELECT value FROM meta WHERE key = 'schema'").get(), before);
    assert.equal((await t.owner.call('core.hello', {})).role, 'owner');
  } finally {
    migrations.pop();
    await t.close();
  }
});

test('constructor failure releases its store so the same process can retry', async () => {
  const t = await testCore();
  let reopened: Core | null = null;
  const options = {
    dataDir: t.core.paths.dataDir, launcher, codexHookProbe: null, jev: { envKey: null },
    accounts: { home: join(t.dir, 'home'), prober: async () => ({ signedIn: 'unknown' as const, identity: null, plan: null }) },
  };
  try {
    await t.core.stop();
    rmSync(t.core.paths.ownerToken);
    mkdirSync(t.core.paths.ownerToken);
    assert.throws(() => new Core(options), /EISDIR/);
    rmSync(t.core.paths.ownerToken, { recursive: true });
    reopened = new Core(options);
    await reopened.start();
  } finally { await reopened?.stop(); await t.close(); }
});

test('the core handshake and discovery file report the packaged application version', async () => {
  const expected = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
  const t = await testCore();
  try {
    assert.equal((await t.owner.call('core.hello', {})).version, expected);
    assert.equal(JSON.parse(readFileSync(t.core.paths.info, 'utf8')).version, expected);
  } finally { await t.close(); }
});

test('a startup failure closes its sockets and releases the store before retrying', async () => {
  const t = await testCore();
  let failed: Core | null = null;
  let retry: Core | null = null;
  const options = {
    dataDir: t.core.paths.dataDir, launcher, codexHookProbe: null, jev: { envKey: null },
    accounts: { home: join(t.dir, 'home'), prober: async () => ({ signedIn: 'unknown' as const, identity: null, plan: null }) },
  };
  try {
    await t.core.stop();
    rmSync(t.core.paths.info);
    mkdirSync(t.core.paths.info);
    failed = new Core(options);
    await assert.rejects(failed.start(), /EISDIR/);
    assert.equal(failed.db.open, false, 'failed startup must release the database without needing another stop call');
    rmSync(t.core.paths.info, { recursive: true });
    retry = new Core(options);
    await retry.start();
  } finally { await failed?.stop(); await retry?.stop(); await t.close(); }
});

test('account probes completing after shutdown cannot write into the closed database', async () => {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const t = await testCore({ accounts: { prober: async () => {
    await waiting;
    return { signedIn: 'unknown', identity: null, plan: null };
  } } });
  const result = t.core.accounts.refresh().then(() => null, (error: Error) => error);
  try {
    await t.core.stop();
    release();
    assert.equal(await result, null);
  } finally { release(); await t.close(); }
});
