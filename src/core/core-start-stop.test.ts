// Actual owned Core instances, native Unix sockets and persisted-store restarts.
// Providers, account catalogues and Tailscale are explicit stand-ins. No process
// exit/crash claim: these exercise the in-process Core lifecycle contract.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { Server } from 'node:net';
import { join } from 'node:path';
import { setImmediate as turn } from 'node:timers/promises';
import { test } from 'node:test';
import { CoreClient } from '../client/client.ts';
import { Core } from './core.ts';
import { Tailscale } from './phone/tailscale.ts';
import { launcher, testCore, type TestCore } from './test-support.ts';

function gate() {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  return { pending, release };
}

function observe(pending: Promise<void>) {
  return pending.then(() => ({ ok: true, code: '', message: '' }), error =>
    ({ ok: false, code: (error as { code?: string }).code, message: (error as Error).message }));
}

function fresh(t: TestCore, tailscale = new Tailscale({ bin: null })) {
  return new Core({ dataDir: t.core.paths.dataDir, launcher, codexHookProbe: null, codexModels: async () => [],
    jev: { envKey: null }, local: { lmsBin: null, ollamaUrl: 'http://127.0.0.1:9' },
    phone: { port: 0, tailscale, rendererDir: join(t.dir, 'renderer') },
    accounts: { home: join(t.dir, 'home'), prober: async () => ({ signedIn: 'unknown', identity: null, plan: null }),
      usageReader: async () => ({ state: 'unreadable', windows: [], checkedAt: 0, note: 'owned startup fixture' }) },
  });
}

async function seed(phone = false) {
  const t = await testCore();
  if (phone) await t.owner.call('phone.enable', {});
  t.owner.close(); await t.core.stop();
  // Only this fixture's previous info is removed, so late recreation is visible.
  rmSync(t.core.paths.info, { force: true });
  return t;
}

function intervals() {
  const set = globalThis.setInterval, clear = globalThis.clearInterval;
  const active = new Set<ReturnType<typeof setInterval>>();
  const created: number[] = [];
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    const handle = Reflect.apply(set, globalThis, args) as ReturnType<typeof setInterval>;
    active.add(handle); created.push(args[1] ?? 0); return handle;
  }) as typeof setInterval;
  globalThis.clearInterval = ((handle: Parameters<typeof clearInterval>[0]) => {
    active.delete(handle as ReturnType<typeof setInterval>); clear(handle);
  }) as typeof clearInterval;
  return { active, created, restore() {
    globalThis.setInterval = set; globalThis.clearInterval = clear;
    for (const handle of active) clear(handle); active.clear();
  } };
}

function stopped(core: Core, timers: ReturnType<typeof intervals>) {
  assert.throws(() => core.db.prepare('SELECT 1').get(), /not open|closed/i);
  assert.equal(existsSync(core.paths.socket), false);
  assert.equal(existsSync(core.paths.hookSocket), false);
  assert.equal(existsSync(core.paths.info), false, 'stopped startup never announces readiness');
  assert.equal(core.phone.listeningPort, null);
  assert.equal(timers.active.size, 0, 'shutdown leaves no owned interval');
  assert.equal(timers.created.includes(30_000), false, 'cancelled startup never creates a sweep interval');
}

async function healthyRestart(t: TestCore, old: Core) {
  // Constructing on the same DB also proves that the old ownership lease ended.
  const core = fresh(t);
  let owner: CoreClient | undefined;
  try {
    await core.start();
    owner = await CoreClient.connect(core.paths.socket, readFileSync(core.paths.ownerToken, 'utf8'));
    assert.ok(await owner.call('core.hello', {}));
    assert.deepEqual(await owner.call('sessions.list', {}), []);
    const info = readFileSync(core.paths.info);
    await old.stop(); await old.server.close();
    assert.equal(existsSync(core.paths.socket), true, 'repeated old close cannot unlink the replacement listener');
    assert.equal(existsSync(core.paths.hookSocket), true);
    assert.deepEqual(readFileSync(core.paths.info), info);
    assert.ok(await owner.call('core.hello', {}), 'the replacement owner remains connected and responsive');
  } finally { owner?.close(); await core.stop(); }
}

test('stop during a held Phone startup refuses late readiness and timers, then a new Core owns the store', async () => {
  const t = await seed(true), entered = gate(), held = gate();
  const tailscale = new Tailscale({ bin: 'never-executed-core-startup', run: async (_bin, args) => {
    assert.deepEqual(args, ['status', '--json']); entered.release(); await held.pending;
    return { code: 0, stdout: JSON.stringify({ BackendState: 'NeedsLogin' }), stderr: '' };
  } });
  const core = fresh(t, tailscale), timers = intervals();
  let starting: ReturnType<typeof observe> | undefined;
  try {
    starting = observe(core.start()); await entered.pending;
    assert.equal(existsSync(core.paths.socket), true); assert.ok(core.phone.listeningPort);
    await core.stop();
    stopped(core, timers);
    held.release();
    const result = await starting;
    assert.equal(result.ok, false, 'startup cannot report success after completed shutdown');
    assert.equal(result.code, 'refused');
    stopped(core, timers);
    timers.restore(); await healthyRestart(t, core);
  } finally { held.release(); await starting; await core.stop(); timers.restore(); await t.close(); }
});

test('stop before start refuses without recovering a closed DB or opening sockets, then a new Core starts', async () => {
  const t = await seed(), core = fresh(t), timers = intervals();
  try {
    await core.stop();
    const result = await observe(core.start());
    assert.equal(result.ok, false); assert.equal(result.code, 'refused');
    assert.match(result.message, /stopping|shutting down/);
    stopped(core, timers);
    timers.restore(); await healthyRestart(t, core);
  } finally { await core.stop(); timers.restore(); await t.close(); }
});

for (const phase of ['before native bind', 'after native bind'] as const) {
  test(`stop ${phase} waits for its owned listener cleanup before releasing the store`, async () => {
    const t = await seed(), core = fresh(t), timers = intervals();
    const entered = gate(), held = gate(), closeEntered = gate();
    const listen = Server.prototype.listen, close = core.server.close.bind(core.server);
    const owned: Server[] = [], callbackErrors: string[] = [];
    let first = true, completed = false;
    let starting: ReturnType<typeof observe> | undefined, stopping: Promise<void> | undefined;
    core.server.close = () => { closeEntered.release(); return close(); };
    Server.prototype.listen = function (this: Server, ...args: unknown[]): Server {
      if (args[0] !== core.paths.socket && args[0] !== core.paths.hookSocket) return Reflect.apply(listen, this, args) as Server;
      owned.push(this);
      if (!first) return Reflect.apply(listen, this, args) as Server;
      first = false;
      if (phase === 'before native bind') {
        entered.release(); void held.pending.then(() => { Reflect.apply(listen, this, args); });
        return this;
      }
      const callback = args.at(-1) as () => void;
      args[args.length - 1] = () => {
        entered.release(); void held.pending.then(() => {
          // Preserve/record a native callback failure, but settle its existing
          // error path so this isolated fixture can close every owned server.
          try { callback(); }
          catch (error) { callbackErrors.push((error as Error).message); this.emit('error', error); }
        });
      };
      return Reflect.apply(listen, this, args) as Server;
    } as typeof listen;
    try {
      starting = observe(core.start()); await entered.pending;
      assert.equal(owned.length, 1);
      assert.equal(owned[0]!.listening, phase === 'after native bind');
      stopping = core.stop().then(() => { completed = true; }); await closeEntered.pending;
      await turn(); const completedBeforeRelease = completed;
      held.release(); const result = await starting; await stopping;
      const outcome = { completedBeforeRelease, nativeListening: owned.map(server => server.listening), callbackErrors,
        socket: existsSync(core.paths.socket), hookSocket: existsSync(core.paths.hookSocket) };
      assert.deepEqual(outcome, { completedBeforeRelease: false, nativeListening: [false], callbackErrors: [], socket: false, hookSocket: false });
      assert.equal(result.ok, false); assert.equal(result.code, 'refused');
      stopped(core, timers);
      Server.prototype.listen = listen; timers.restore(); await healthyRestart(t, core);
    } finally {
      held.release(); await starting; await stopping; Server.prototype.listen = listen;
      await core.stop();
      for (const server of owned) if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
      timers.restore(); await t.close();
    }
  });
}
