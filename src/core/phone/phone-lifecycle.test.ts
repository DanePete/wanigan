// Real owner RPCs, HTTP listeners and core restarts, with only an injected
// Tailscale command runner. No installed Tailscale, push service or model runs.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Server, request } from 'node:http';
import { test } from 'node:test';
import { CoreClient } from '../../client/client.ts';
import { Core } from '../core.ts';
import { launcher, testCore, waitFor, type TestCore } from '../test-support.ts';
import { Tailscale } from './tailscale.ts';

function gate() {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  return { pending, release };
}

async function within<T>(pending: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([pending, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Owned Phone operation did not settle')), 2000); })]); }
  finally { clearTimeout(timer); }
}

function observe<T>(pending: Promise<T>) {
  return pending.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, message: (error as Error).message }));
}

function fakeTailscale(before: (args: string[]) => Promise<void> = async () => {}) {
  let serving = false;
  const mutations: string[] = [];
  const tailscale = new Tailscale({ bin: 'never-executed-lifecycle-fixture', run: async (_bin, args) => {
    await before(args);
    if (args[0] === 'status') return { code: 0, stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'owned.tail.test.' }, CertDomains: ['owned.tail.test'] }), stderr: '' };
    if (args[1] === 'status') return { code: 0, stdout: JSON.stringify({ Web: serving ? { 'owned.tail.test:443': { Handlers: { '/wanigan': { Proxy: 'http://127.0.0.1:0' } } } } : {} }), stderr: '' };
    const action = args.at(-1) === 'off' ? 'off' : 'on';
    mutations.push(action); serving = action === 'on';
    return { code: 0, stdout: '', stderr: '' };
  } });
  return { tailscale, mutations, serving: () => serving };
}

function http(port: number, host?: string): Promise<number | null> {
  // Fetch can replace Host; node:http sends the explicit authority under test.
  return new Promise(resolve => {
    const req = request({ host: '127.0.0.1', port, path: '/api/events', headers: { Host: host ?? `127.0.0.1:${port}` }, signal: AbortSignal.timeout(1000) }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode ?? null));
      res.on('error', () => resolve(null));
    });
    req.on('error', () => resolve(null)); req.end();
  });
}

async function restart(t: TestCore, tailscale: Tailscale) {
  t.owner.close(); await t.core.stop();
  const core = new Core({ dataDir: t.core.paths.dataDir, launcher, codexHookProbe: null, codexModels: async () => [],
    jev: { envKey: null }, local: { lmsBin: null, ollamaUrl: 'http://127.0.0.1:9' },
    phone: { port: 0, tailscale, rendererDir: join(t.dir, 'renderer') },
    accounts: { home: join(t.dir, 'home'), prober: async () => ({ signedIn: 'unknown', identity: null, plan: null }),
      usageReader: async () => ({ state: 'unreadable', windows: [], checkedAt: 0, note: 'owned lifecycle fixture' }) },
  });
  try {
    await core.start();
    const owner = await CoreClient.connect(core.paths.socket, readFileSync(core.paths.ownerToken, 'utf8'));
    return { core, owner, close: async () => { owner.close(); await core.stop(); } };
  } catch (error) { await core.stop(); throw error; }
}

test('completed Off survives a held older On, including a real core restart on the same database', async () => {
  const entered = gate(); const held = gate(); let statuses = 0;
  const fake = fakeTailscale(async args => {
    if (args[0] === 'status' && ++statuses === 1) { entered.release(); await held.pending; }
  });
  const t = await testCore({ phone: { port: 0, tailscale: fake.tailscale } });
  let first: ReturnType<typeof observe> | undefined;
  let again: Awaited<ReturnType<typeof restart>> | undefined;
  try {
    first = observe(t.owner.call('phone.enable', {}));
    await within(entered.pending);
    const port = t.core.phone.listeningPort!;
    assert.equal(await http(port), 401, 'the owned listener actually opened');
    const off = await within(t.owner.call('phone.disable', {}));
    assert.deepEqual([off.enabled, off.listening], [false, false]);
    assert.equal(await http(port), null, 'Off closed actual HTTP while the old status was held');
    held.release(); const stale = await within(first);
    const current = await t.owner.call('phone.status', {});
    assert.deepEqual([current.enabled, current.listening, fake.serving()], [false, false, false]);
    assert.deepEqual(t.core.db.prepare("SELECT value FROM meta WHERE key = 'phone_enabled'").all(), []);
    assert.equal(stale.ok, false, 'superseded On is explicitly refused');
    assert.deepEqual(await t.owner.call('sessions.list', {}), []);
    again = await restart(t, fake.tailscale);
    const restored = await again.owner.call('phone.status', {});
    assert.deepEqual([restored.enabled, restored.listening], [false, false], 'restart must not undo the completed Off');
    await again.owner.call('core.hello', {});
  } finally { held.release(); await first; await again?.close(); await t.close(); }
});

test('Off closes HTTP immediately and removes a previously dispatched mount after that mount finishes', async () => {
  const entered = gate(); const held = gate();
  const fake = fakeTailscale(async args => {
    if (args[0] === 'serve' && args[1] !== 'status' && args.at(-1) !== 'off') { entered.release(); await held.pending; }
  });
  const t = await testCore({ phone: { port: 0, tailscale: fake.tailscale } });
  let on: ReturnType<typeof observe> | undefined;
  let off: ReturnType<typeof observe> | undefined;
  try {
    on = observe(t.owner.call('phone.enable', {})); await within(entered.pending);
    const port = t.core.phone.listeningPort!; assert.equal(await http(port), 401);
    off = observe(t.owner.call('phone.disable', {}));
    await waitFor('Off to close the owned listener before serve resolves', () => t.core.phone.listeningPort === null, 1000);
    assert.equal(await http(port), null); assert.equal(t.core.phone.enabled, false);
    await t.owner.call('core.hello', {});
    held.release();
    assert.equal((await within(on)).ok, false);
    assert.equal((await within(off)).ok, true);
    assert.deepEqual(fake.mutations, ['on', 'off']);
    const current = await t.owner.call('phone.status', {});
    assert.deepEqual([current.enabled, current.listening, fake.serving()], [false, false, false]);
    assert.deepEqual(await t.owner.call('sessions.list', {}), []);
  } finally { held.release(); await on; await off; await t.close(); }
});

test('a newer On waits for an in-flight Off mount cleanup and then restores its own ready mount', async () => {
  const entered = gate(); const held = gate();
  const fake = fakeTailscale(async args => { if (args.at(-1) === 'off') { entered.release(); await held.pending; } });
  const t = await testCore({ phone: { port: 0, tailscale: fake.tailscale } });
  let off: ReturnType<typeof observe> | undefined;
  let on: ReturnType<typeof observe> | undefined;
  try {
    await t.owner.call('phone.enable', {});
    off = observe(t.owner.call('phone.disable', {})); await within(entered.pending);
    assert.equal(t.core.phone.listeningPort, null);
    on = observe(t.owner.call('phone.enable', {}));
    await waitFor('the newer owned listener to open independently of external cleanup', () => t.core.phone.listeningPort, 1000);
    const port = t.core.phone.listeningPort!; assert.equal(await http(port), 401);
    held.release();
    assert.equal((await within(off)).ok, false, 'old Off cannot report success for the newer intent');
    assert.equal((await within(on)).ok, true);
    assert.deepEqual(fake.mutations, ['on', 'off', 'on']);
    const current = await t.owner.call('phone.status', {});
    assert.deepEqual([current.enabled, current.listening, fake.serving()], [true, true, true]);
    assert.equal(await http(port), 401, 'old cleanup must not close the newer listener');
    assert.equal(current.url, 'https://owned.tail.test/wanigan/');
  } finally { held.release(); await off; await on; await t.close(); }
});

test('shutdown invalidates a held enable without clearing saved On, which a new core restores', async () => {
  const entered = gate(); const held = gate(); let hold = false;
  const fake = fakeTailscale(async args => { if (hold && args[0] === 'status') { hold = false; entered.release(); await held.pending; } });
  const t = await testCore({ phone: { port: 0, tailscale: fake.tailscale } });
  let pending: ReturnType<typeof observe> | undefined;
  let again: Awaited<ReturnType<typeof restart>> | undefined;
  try {
    await t.owner.call('phone.enable', {});
    const port = t.core.phone.listeningPort!;
    hold = true; pending = observe(t.core.phone.enable()); await within(entered.pending);
    await within(t.core.stop());
    assert.equal(await http(port), null, 'shutdown does not wait on held read-only status');
    held.release(); const stopped = await within(pending);
    assert.equal(stopped.ok, false);
    if (!stopped.ok) assert.match(stopped.message, /shutting down/, 'stale work refuses before touching the closed database');
    await assert.rejects(t.core.phone.enable(), /shutting down/);
    again = await restart(t, fake.tailscale);
    const restored = await again.owner.call('phone.status', {});
    assert.deepEqual([restored.enabled, restored.listening], [true, true], 'plain shutdown preserves the saved On');
    assert.equal(await http(again.core.phone.listeningPort!), 401);
    assert.deepEqual(await again.owner.call('sessions.list', {}), []);
  } finally { held.release(); await pending; await again?.close(); await t.close(); }
});

test('Off then a newer On safely orders an actual listener whose native bind was delayed', async () => {
  const entered = gate(); const held = gate();
  const original = Server.prototype.listen;
  const owned: Server[] = [];
  let delay = true;
  // Hold only the first owned HTTP bind, before invoking the real native call.
  // Other core servers are net.Server instances and never enter this seam.
  Server.prototype.listen = function (this: Server, ...args: unknown[]): Server {
    owned.push(this);
    if (delay) {
      delay = false; entered.release();
      void held.pending.then(() => { Reflect.apply(original, this, args); });
      return this;
    }
    return Reflect.apply(original, this, args) as Server;
  } as typeof original;
  const fake = fakeTailscale();
  const t = await testCore({ phone: { port: 0, tailscale: fake.tailscale } });
  const pending: ReturnType<typeof observe>[] = [];
  try {
    pending.push(observe(t.owner.call('phone.enable', {}))); await within(entered.pending);
    pending.push(observe(t.owner.call('phone.disable', {})));
    await waitFor('Off intent to reach the real core', () => t.core.phone.enabled === false, 1000);
    // An owner round trip establishes that both earlier messages were admitted.
    await t.owner.call('core.hello', {});
    pending.push(observe(t.owner.call('phone.enable', {})));
    await t.owner.call('core.hello', {});
    held.release();
    const results = await within(Promise.all(pending));
    assert.deepEqual(results.map(r => r.ok), [false, false, true]);
    assert.equal(owned.length, 2);
    assert.equal(owned[0]!.listening, false, 'the stale bind is actually closed');
    assert.equal(owned[1]!.listening, true);
    assert.equal(await http(t.core.phone.listeningPort!), 401);
    const current = await t.owner.call('phone.status', {});
    assert.deepEqual([current.enabled, current.listening, fake.serving()], [true, true, true]);
  } finally {
    held.release(); await Promise.all(pending); Server.prototype.listen = original;
    await t.close();
    for (const server of owned) { server.closeAllConnections(); if (server.listening) await new Promise<void>(resolve => server.close(() => resolve())); }
  }
});

test('a delayed native close callback cannot close or emit a stale Off for the next listener', async () => {
  const entered = gate(); const held = gate();
  const fake = fakeTailscale();
  const t = await testCore({ phone: { port: 0, tailscale: fake.tailscale } });
  const original = Server.prototype.close;
  let delay = true;
  Server.prototype.close = function (this: Server, callback?: (error?: Error) => void): Server {
    if (!delay) return original.call(this, callback);
    delay = false;
    return original.call(this, error => {
      entered.release(); void held.pending.then(() => callback?.(error));
    });
  };
  let off: ReturnType<typeof observe> | undefined;
  let on: ReturnType<typeof observe> | undefined;
  let offEvent = (): void => {};
  let events = 0;
  try {
    await t.owner.call('phone.enable', {});
    const firstPort = t.core.phone.listeningPort!;
    offEvent = t.core.bus.on(event => { if (event === 'phone') events++; });
    off = observe(t.owner.call('phone.disable', {})); await within(entered.pending);
    assert.equal(await http(firstPort), null, 'the owned native listener really closed');
    on = observe(t.owner.call('phone.enable', {})); await t.owner.call('core.hello', {});
    assert.equal(t.core.phone.listeningPort, null, 'a new listen waits for the earlier native close completion');
    held.release();
    assert.equal((await within(off)).ok, false);
    assert.equal((await within(on)).ok, true);
    assert.equal(events, 1, 'only the current On emits after the old close completes');
    assert.equal(await http(t.core.phone.listeningPort!), 401);
    assert.deepEqual(fake.mutations, ['on'], 'superseded cleanup does not unmount the current On');
    const current = await t.owner.call('phone.status', {});
    assert.deepEqual([current.enabled, current.listening, fake.serving()], [true, true, true]);
  } finally { held.release(); await off; await on; offEvent(); Server.prototype.close = original; await t.close(); }
});

test('a refused external mount remains observable and does not poison a later Off or On', async () => {
  let refuse = true;
  const fake = fakeTailscale(async args => {
    if (refuse && args[0] === 'serve' && args[1] !== 'status' && args.at(-1) !== 'off') {
      refuse = false; throw new Error('owned mount rejection');
    }
  });
  const t = await testCore({ phone: { port: 0, tailscale: fake.tailscale } });
  try {
    await assert.rejects(t.owner.call('phone.enable', {}), /owned mount rejection/);
    assert.equal(fake.serving(), false);
    const off = await t.owner.call('phone.disable', {});
    assert.deepEqual([off.enabled, off.listening], [false, false]);
    const on = await t.owner.call('phone.enable', {});
    assert.deepEqual([on.enabled, on.listening, fake.serving()], [true, true, true]);
    assert.equal(await http(t.core.phone.listeningPort!), 401);
    assert.deepEqual(await t.owner.call('sessions.list', {}), []);
  } finally { await t.close(); }
});

test('a stale final On status cannot replace the newer listener Host after Off and another On', async () => {
  const entered = gate(); const held = gate(); let queries = 0;
  let name = 'old.tail.test'; let serving = false;
  const tailscale = new Tailscale({ bin: 'never-executed-host-fixture', run: async (_bin, args) => {
    if (args[0] === 'status') {
      const stdout = JSON.stringify({ BackendState: 'Running', Self: { DNSName: `${name}.` }, CertDomains: [name] });
      if (++queries === 3) { entered.release(); await held.pending; }
      return { code: 0, stdout, stderr: '' };
    }
    if (args[1] === 'status') return { code: 0, stdout: JSON.stringify({ Web: serving ? { [`${name}:443`]: { Handlers: { '/wanigan': { Proxy: 'http://127.0.0.1:0' } } } } : {} }), stderr: '' };
    serving = args.at(-1) !== 'off'; return { code: 0, stdout: '', stderr: '' };
  } });
  const t = await testCore({ phone: { port: 0, tailscale } });
  let old: ReturnType<typeof observe> | undefined;
  try {
    old = observe(t.owner.call('phone.enable', {})); await within(entered.pending);
    await within(t.owner.call('phone.disable', {}));
    name = 'new.tail.test';
    const on = await within(t.owner.call('phone.enable', {}));
    assert.equal(on.url, 'https://new.tail.test/wanigan/');
    const port = t.core.phone.listeningPort!;
    assert.equal(await http(port, 'new.tail.test'), 401);
    held.release(); assert.equal((await within(old)).ok, false);
    // Do not refresh status here: it would repair an erroneous stale Host and
    // conceal whether the delayed response overwrote the current authority.
    assert.equal(await http(port, 'new.tail.test'), 401);
    assert.equal(await http(port, 'old.tail.test'), 403);
  } finally { held.release(); await old; await t.close(); }
});
