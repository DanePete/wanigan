// "It survives a quit": the app starts the core detached, a session runs in it,
// the app goes away, and a new app instance finds the same core, the same live
// session and its output. CoreConnection is exactly what the Electron main
// process uses; nothing here is simulated except the app window itself.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { corePaths } from '../core/paths.ts';
import type { CoreProblem } from '../shared/bridge.ts';
import { LIVE_STATES } from '../shared/model.ts';
import { CoreConnection, errorIn, stopCore } from './core-process.ts';

const SRC = resolve(import.meta.dirname, '..');

async function waitFor<T>(what: string, probe: () => Promise<T> | T, timeoutMs = 20_000): Promise<NonNullable<T>> {
  const start = Date.now();
  for (;;) {
    const v = await probe();
    if (v) return v as NonNullable<T>;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

test('a session outlives the app that started it', { timeout: 90_000 }, async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'wg-quit-')));
  const dataDir = join(dir, 'data');
  const project = join(dir, 'site');
  mkdirSync(project);
  mkdirSync(join(dir, 'home'));
  process.env.WANIGAN_TEST_ACCOUNTS_HOME = join(dir, 'home');
  const options = {
    dataDir,
    coreEntry: join(SRC, 'core/index.ts'),
    cliEntry: join(SRC, 'cli/index.ts'),
    socketPath: corePaths(dataDir).socket,
    runtime: process.execPath,
  };
  let corePid = 0;
  try {
    // The first app instance starts the core and a session.
    const first = new CoreConnection(options);
    const app1 = await first.get();
    corePid = JSON.parse(readFileSync(join(dataDir, 'core.json'), 'utf8')).pid as number;
    assert.ok(alive(corePid));
    const p = await app1.call('projects.add', { path: project });
    const session = await app1.call('sessions.start', { projectId: p.id, provider: 'shell' });
    await app1.call('sessions.input', { id: session.id, data: 'echo before-quit-$((6*7))\n' });
    await waitFor('output', async () => (await app1.call('sessions.watch', { id: session.id })).replay.includes('before-quit-42'));

    // The app quits.
    first.close();
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(alive(corePid), 'the core is still running after the app has gone');

    // A new app instance reconnects to the same core, not a new one.
    const second = new CoreConnection(options);
    const app2 = await second.get();
    assert.equal(JSON.parse(readFileSync(join(dataDir, 'core.json'), 'utf8')).pid, corePid, 'no second core was started');
    const live = await app2.call('sessions.list', { live: true });
    assert.deepEqual(live.map((s) => [s.id, s.state]), [[session.id, 'running']], 'the session is still live');
    const { replay } = await app2.call('sessions.watch', { id: session.id });
    assert.match(replay, /before-quit-42/, 'its output is replayed');
    await app2.call('sessions.input', { id: session.id, data: 'echo after-reopen-$((6*7))\n' });
    await waitFor('new output', async () => (await app2.call('sessions.watch', { id: session.id })).replay.includes('after-reopen-42'));

    await app2.call('sessions.stop', { id: session.id });
    second.close();
  } finally {
    if (corePid && alive(corePid)) {
      process.kill(corePid, 'SIGTERM');
      await waitFor('core exit', () => !alive(corePid), 15_000).catch(() => process.kill(corePid, 'SIGKILL'));
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a core that dies is started again, and says plainly which sessions it lost', { timeout: 90_000 }, async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'wg-crash-')));
  const dataDir = join(dir, 'data');
  const project = join(dir, 'site');
  mkdirSync(project);
  mkdirSync(join(dir, 'home'));
  process.env.WANIGAN_TEST_ACCOUNTS_HOME = join(dir, 'home');
  const connection = new CoreConnection({
    dataDir, coreEntry: join(SRC, 'core/index.ts'), cliEntry: join(SRC, 'cli/index.ts'), socketPath: corePaths(dataDir).socket, runtime: process.execPath,
  });
  const pidOf = (): number => { try { return JSON.parse(readFileSync(join(dataDir, 'core.json'), 'utf8')).pid as number; } catch { return 0; } };
  const pids: number[] = [];
  try {
    const app = await connection.get();
    const first = pidOf();
    pids.push(first);
    const p = await app.call('projects.add', { path: project });
    const card = await app.call('cards.create', { projectId: p.id, type: 'task', title: 'Lost in the crash' });
    const session = await app.call('sessions.start', { projectId: p.id, provider: 'shell', cardId: card.id });
    pids.push((await app.call('sessions.get', { id: session.id })).session.pid as number);
    assert.equal((await app.call('cards.get', { id: card.id })).claim?.sessionId, session.id);

    process.kill(first, 'SIGKILL');
    // The app's connection notices, starts a new core on the same data and reconnects.
    pids.push(await waitFor('a new core', () => { const pid = pidOf(); return pid !== first && alive(pid) ? pid : 0; }, 30_000));
    const again = await waitFor('reconnected', async () => {
      try { const c = await connection.get(); await c.call('core.hello', {}); return c; } catch { return null; }
    }, 30_000);

    const lost = (await again.call('sessions.get', { id: session.id })).session;
    assert.deepEqual([lost.state, lost.activity], ['interrupted', 'Wanigan’s core restarted and this process was lost']);
    const now = await again.call('cards.get', { id: card.id });
    assert.deepEqual([now.status, now.claim], ['ready', null], 'its card is free for the next session');
    assert.ok(now.activity.some((a) => a.verb === 'released the claim' && a.detail === 'the session interrupted without submitting'));
    const need = (await again.call('needs.list', {})).find((n) => n.sessionId === session.id);
    assert.equal(need?.kind, 'interrupted');
    assert.equal(need?.resumable, undefined, 'a shell has no conversation to resume');
    await again.call('sessions.seen', { id: session.id });
    assert.ok(!(await again.call('needs.list', {})).some((n) => n.sessionId === session.id), 'seeing it settles it');
    connection.close();
  } finally {
    for (const pid of pids.reverse()) {
      if (!pid || !alive(pid)) continue;
      process.kill(pid, 'SIGTERM');
      await waitFor('exit', () => !alive(pid), 15_000).catch(() => process.kill(pid, 'SIGKILL'));
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A data folder, a project folder and a fake home, and the options the app would use for them. */
function place(prefix: string, coreEntry = join(SRC, 'core/index.ts')) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const dataDir = join(dir, 'data');
  mkdirSync(join(dir, 'site'));
  mkdirSync(join(dir, 'home'));
  process.env.WANIGAN_TEST_ACCOUNTS_HOME = join(dir, 'home');
  return {
    dir, project: join(dir, 'site'),
    options: { dataDir, coreEntry, cliEntry: join(SRC, 'cli/index.ts'), socketPath: corePaths(dataDir).socket, runtime: process.execPath },
  };
}

async function kill(pid: number): Promise<void> {
  if (!pid || !alive(pid)) return;
  process.kill(pid, 'SIGTERM');
  await waitFor('core exit', () => !alive(pid), 15_000).catch(() => process.kill(pid, 'SIGKILL'));
}

test('a core that cannot start says why at once, and is started again only when asked', { timeout: 90_000 }, async () => {
  const { dir, options } = place('wg-refused-');
  const { dataDir } = options;
  mkdirSync(dataDir);
  // Another app's database where Wanigan's would be: the core must refuse it.
  const foreign = new Database(join(dataDir, 'wanigan.db'));
  foreign.exec('CREATE TABLE notes (body TEXT)');
  foreign.close();
  const reason = 'This database was not created by Wanigan 2. Refusing to open it.';
  const connection = new CoreConnection(options);
  const told: (CoreProblem | null)[] = [];
  connection.onProblem((p) => told.push(p));
  let corePid = 0;
  try {
    const started = Date.now();
    await assert.rejects(connection.get(), { name: 'CoreStartError', message: reason });
    assert.ok(Date.now() - started < 10_000, 'said when the core gave up, not after waiting out the start timeout');
    assert.equal(connection.current, 'unavailable');
    assert.deepEqual({ ...connection.problem, at: 0 }, { kind: 'failed', reason, log: join(dataDir, 'core.log'), at: 0 });
    assert.deepEqual(told, [connection.problem], 'the window is told once');
    assert.equal(JSON.parse(readFileSync(join(dataDir, 'core.failed.json'), 'utf8')).reason, reason, 'the core wrote down why');
    const attempts = (): number => readFileSync(join(dataDir, 'core.log'), 'utf8').split('could not start: Error: This database').length - 1;
    assert.equal(attempts(), 1);

    // Every later call is refused at once, with the same reason, and starts nothing.
    const again = Date.now();
    await assert.rejects(connection.get(), { message: reason });
    assert.ok(Date.now() - again < 200, 'not another fifteen-second wait');
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(attempts(), 1, 'no second core was started');

    // The owner moves the other database away and presses Try again.
    rmSync(join(dataDir, 'wanigan.db'));
    const client = await connection.retry();
    corePid = (await client.call('core.hello', {})).pid ?? 0;
    assert.ok(corePid && alive(corePid));
    assert.equal(connection.current, 'connected');
    assert.equal(connection.problem, null);
    assert.equal(told.at(-1), null, 'the window is told it is over');
    assert.equal(existsSync(join(dataDir, 'core.failed.json')), false, 'a core that started removes the old reason');
    connection.close();
  } finally {
    await kill(corePid);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a core left by another build is replaced when nothing runs in it, and asked about when something does', { timeout: 150_000 }, async () => {
  // The entry the app would start. Rewriting it is a new build, as a pull or an upgrade is.
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'wg-entry-')));
  const entry = join(scratch, 'core-entry.mjs');
  const build = (n: number): void => writeFileSync(entry, `// build ${n}\nimport ${JSON.stringify(pathToFileURL(join(SRC, 'core/index.ts')).href)};\n`);
  build(1);
  const { dir, project, options } = place('wg-build-', entry);
  const pids: number[] = [];
  try {
    const first = new CoreConnection(options);
    const one = await (await first.get()).call('core.hello', {});
    pids.push(one.pid ?? 0);
    assert.ok(one.build && one.build === first.build, 'the core reports the build it was started from');
    first.close();

    // A new build opens while the old core is quiet: it is replaced, and nobody is asked.
    build(2);
    const second = new CoreConnection(options);
    assert.notEqual(second.build, first.build);
    const app2 = await second.get();
    const two = await app2.call('core.hello', {});
    pids.push(two.pid ?? 0);
    assert.notEqual(two.pid, one.pid, 'a new core');
    assert.equal(alive(one.pid ?? 0), false, 'the old one was stopped');
    assert.equal(two.build, second.build);
    assert.equal(second.problem, null);

    // A session runs in build 2's core when build 3 opens.
    const p = await app2.call('projects.add', { path: project });
    const session = await app2.call('sessions.start', { projectId: p.id, provider: 'shell' });
    second.close();
    build(3);
    const third = new CoreConnection(options);
    const app3 = await third.get();
    assert.equal((await app3.call('core.hello', {})).pid, two.pid, 'still the core the session runs in');
    assert.deepEqual(third.problem, { kind: 'other-build', pid: two.pid, live: 1 });
    assert.equal((await app3.call('sessions.get', { id: session.id })).session.state, 'running', 'nothing was interrupted to ask');

    // Keep using it: not asked again by this app. The next launch asks again.
    third.keep();
    assert.equal(third.problem, null);
    third.close();
    const fourth = new CoreConnection(options);
    await fourth.get();
    assert.equal(fourth.problem?.kind, 'other-build');

    // Restart: the old core and its session end; this build's core takes over.
    const app4 = await fourth.restart();
    const four = await app4.call('core.hello', {});
    pids.push(four.pid ?? 0);
    assert.notEqual(four.pid, two.pid);
    assert.equal(alive(two.pid ?? 0), false, 'the old core was stopped');
    assert.equal(four.build, fourth.build);
    assert.equal(fourth.problem, null);
    assert.equal(fourth.current, 'connected');
    const ended = (await app4.call('sessions.get', { id: session.id })).session.state;
    assert.ok(!LIVE_STATES.has(ended), `the session says it ended (${ended}), not that it lived on`);
    fourth.close();

    // `npm run core:stop` stops it cleanly.
    assert.equal(await stopCore(options.dataDir), four.pid);
    assert.equal(alive(four.pid ?? 0), false);
    assert.equal(await stopCore(options.dataDir), null, 'nothing left to stop');
  } finally {
    for (const pid of pids) await kill(pid);
    rmSync(dir, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('what a crashed core printed is read for its error, not its stack', () => {
  const crash = [
    '/app/node_modules/node-pty/lib/utils.js:31',
    '        throw outerError;',
    '        ^',
    '',
    'Error: The module \'/app/node_modules/node-pty/build/Release/pty.node\'',
    'was compiled against a different Node.js version using',
    'NODE_MODULE_VERSION 127. This version of Node.js requires',
    'NODE_MODULE_VERSION 140.',
    '    at Module._extensions..node (node:internal/modules/cjs/loader:1921:18)',
    'Node.js v24.11.0',
  ].join('\n');
  assert.equal(errorIn(crash), 'Error: The module \'/app/node_modules/node-pty/build/Release/pty.node\' was compiled against a different Node.js version using NODE_MODULE_VERSION 127. This version of Node.js requires NODE_MODULE_VERSION 140.');
  assert.equal(errorIn('starting\nKilled: 9\n'), 'Killed: 9');
  assert.equal(errorIn(''), null);
});

test('a core without atomic idle shutdown is kept until the owner explicitly restarts it', { timeout: 90_000 }, async () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'wg-old-entry-')));
  const entry = join(scratch, 'old-core.mjs');
  const build = (n: number): void => writeFileSync(entry, `// old build ${n}
    const { Core } = await import(${JSON.stringify(pathToFileURL(join(SRC, 'core/core.ts')).href)});
    const { CoreError } = await import(${JSON.stringify(pathToFileURL(join(SRC, 'shared/protocol.ts')).href)});
    const original = Core.prototype.start;
    Core.prototype.start = function () {
      this.handlers['core.stopIfIdle'] = () => { throw new CoreError('not_found', 'No method core.stopIfIdle.'); };
      return original.call(this);
    };
    await import(${JSON.stringify(pathToFileURL(join(SRC, 'core/index.ts')).href)});
  `);
  build(1);
  const { dir, options } = place('wg-old-build-', entry);
  const pids: number[] = [];
  let second: CoreConnection | null = null;
  try {
    const first = new CoreConnection(options);
    const before = (await (await first.get()).call('core.hello', {})).pid!;
    pids.push(before);
    first.close();
    build(2);
    second = new CoreConnection(options);
    const after = (await (await second.get()).call('core.hello', {})).pid!;
    pids.push(after);
    assert.equal(after, before, 'an empty PTY list cannot authorize killing an older core');
    assert.deepEqual(second.problem, { kind: 'other-build', pid: before, live: 0 });
  } finally {
    second?.close();
    for (const pid of pids) await kill(pid);
    rmSync(dir, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
});
