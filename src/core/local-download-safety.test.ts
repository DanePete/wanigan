// Real owner RPCs and owned /bin/cat download stand-ins. No installed LM Studio,
// model, network download, real account or user data is touched.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { test } from 'node:test';
import { LOCAL_MODULES } from '../shared/local-models.ts';
import { testCore, waitFor } from './test-support.ts';

const MODULE = LOCAL_MODULES[0]!;
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

async function fixture() {
  const preflight = deferred();
  let lists = 0;
  const children: ChildProcess[] = [];
  const commands: string[][] = [];
  const pending: Promise<unknown>[] = [];
  const faults: { spawn: 'normal' | 'throw' | 'error'; preflight: boolean } = { spawn: 'normal', preflight: false };
  const t = await testCore({ local: {
    lmsBin: '/owned/stand-in/lms', freeBytes: () => 1e12,
    fetchJson: async () => ({ models: [] }),
    runLms: async (_bin, args) => {
      if (args[0] === 'ls' && ++lists === 1) await preflight.promise;
      if (args[0] === 'ls' && faults.preflight) throw new Error('Owned preflight failure');
      return { code: 0, stderr: '', stdout: args[0] === 'server' ? '{}' : '[]' };
    },
    spawnLms: (_bin, args) => {
      commands.push(args);
      if (faults.spawn === 'throw') throw new Error('Owned synchronous spawn failure');
      const child = spawn(faults.spawn === 'error' ? join(process.env.TMPDIR!, 'no-such-owned-executable') : '/bin/cat', [], { stdio: ['pipe', 'pipe', 'pipe'], env: {
        PATH: '/usr/bin:/bin', HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
      } });
      children.push(child);
      child.on('error', () => {}); // Observed through the service's failed state.
      return child;
    },
  } });
  const settled = <T>(promise: Promise<T>) => {
    const result = promise.then((value) => ({ ok: true as const, value }), (error: Error) => ({ ok: false as const, error }));
    pending.push(result);
    return result;
  };
  return { ...t, preflight, children, commands, settled, faults,
    admitted: () => waitFor('download preflight entered', () => lists > 0),
    async cleanup() {
      preflight.resolve();
      await Promise.all(pending);
      for (const child of children) if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, 'close'); child.kill('SIGTERM'); await closed;
      }
      await t.close();
    },
  };
}

test('simultaneous owner downloads reserve one module before preflight and keep its child cancellable', async () => {
  const t = await fixture();
  try {
    const first = t.settled(t.owner.call('local.download', { module: MODULE.id }));
    await t.admitted();
    const second = await t.settled(t.owner.call('local.download', { module: MODULE.id }));
    assert.equal(second.ok, false, 'another owner request must not start the same download');
    if (!second.ok) assert.match(second.error.message, /already downloading/);
    assert.equal(t.children.length, 0, 'admission did not run the download during held preflight');
    assert.equal(t.core.local.busy, true, 'preflight is accepted work');
    t.preflight.resolve();
    assert.equal((await first).ok, true);
    assert.equal(t.children.length, 1);
    assert.deepEqual(t.commands, [['get', MODULE.key, '--mlx', '--yes']]);
    const child = t.children[0]!;
    const closed = once(child, 'close');
    await t.owner.call('local.cancel', { module: MODULE.id });
    await closed;
    assert.equal(child.signalCode, 'SIGTERM');
    assert.equal(t.core.local.busy, false);
    const status = await t.owner.call('local.status', {});
    assert.equal(status.modules[0]?.download?.state, 'failed');
    assert.match(status.modules[0]?.download?.error ?? '', /Stopped/);
  } finally { await t.cleanup(); }
});

test('Stop during preflight refuses the pending download, preserves a stopped status, and allows a later retry', async () => {
  const t = await fixture();
  try {
    const first = t.settled(t.owner.call('local.download', { module: MODULE.id }));
    await t.admitted();
    await t.owner.call('local.cancel', { module: MODULE.id });
    const status = await t.owner.call('local.status', {});
    assert.equal(status.modules[0]?.download?.state, 'failed');
    assert.match(status.modules[0]?.download?.error ?? '', /Stopped before downloading/);
    assert.equal(t.children.length, 0);
    await assert.rejects(t.owner.call('local.download', { module: MODULE.id }), /stopping/);
    t.preflight.resolve();
    const refused = await first;
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.match(refused.error.message, /stopped before downloading/);
    assert.equal(t.children.length, 0, 'cancelled preflight must never become a download');
    assert.equal(t.core.local.busy, false);
    await t.owner.call('local.download', { module: MODULE.id });
    assert.equal(t.children.length, 1, 'deliberate retry starts only a fresh attempt');
    const closed = once(t.children[0]!, 'close');
    await t.owner.call('local.cancel', { module: MODULE.id }); await closed;
    assert.equal(t.children[0]!.signalCode, 'SIGTERM');
    assert.equal(t.core.local.busy, false);
  } finally { await t.cleanup(); }
});

test('core shutdown invalidates a held preflight and the stopped service cannot start another download', async () => {
  const t = await fixture();
  try {
    // Await the service result directly because actual core shutdown closes
    // its owner socket before the held preflight is allowed to finish.
    const first = t.settled(t.core.local.download(MODULE.id));
    await t.admitted();
    await t.core.stop();
    t.preflight.resolve();
    const result = await first;
    assert.equal(result.ok, false, 'shutdown must invalidate accepted work before it can spawn');
    if (!result.ok) assert.match(result.error.message, /stopping/);
    assert.equal(t.children.length, 0);
    assert.equal(t.core.local.busy, false);
    await assert.rejects(t.core.local.download(MODULE.id), /stopping/);
    assert.equal(t.children.length, 0, 'shutdown is terminal for this service instance');
  } finally { await t.cleanup(); }
});

test('a synchronous spawn failure leaves an honest failed status, frees the reservation, and permits a fresh child', async () => {
  const t = await fixture();
  try {
    t.preflight.resolve(); t.faults.spawn = 'throw';
    await assert.rejects(t.owner.call('local.download', { module: MODULE.id }), /Owned synchronous spawn failure/);
    assert.equal(t.children.length, 0);
    assert.equal(t.core.local.busy, false);
    const status = await t.owner.call('local.status', {});
    assert.equal(status.modules[0]?.download?.state, 'failed');
    assert.match(status.modules[0]?.download?.error ?? '', /Owned synchronous spawn failure/);
    t.faults.spawn = 'normal';
    await t.owner.call('local.download', { module: MODULE.id });
    assert.equal(t.children.length, 1);
    const child = t.children[0]!; const closed = once(child, 'close');
    t.core.local.cancel(MODULE.id);
    assert.equal(t.core.local.busy, true, 'a killed child remains tracked until native close');
    await closed;
    assert.equal(child.signalCode, 'SIGTERM'); assert.equal(t.core.local.busy, false);
  } finally { await t.cleanup(); }
});

test('a failed preflight launches nothing and releases admission for a successful retry', async () => {
  const t = await fixture();
  try {
    t.preflight.resolve(); t.faults.preflight = true;
    await assert.rejects(t.owner.call('local.download', { module: MODULE.id }), /Owned preflight failure/);
    assert.equal(t.children.length, 0); assert.equal(t.core.local.busy, false);
    t.faults.preflight = false;
    await t.owner.call('local.download', { module: MODULE.id });
    assert.equal(t.children.length, 1);
    const child = t.children[0]!; const closed = once(child, 'close');
    await t.owner.call('local.cancel', { module: MODULE.id }); await closed;
    assert.equal(child.signalCode, 'SIGTERM'); assert.equal(t.core.local.busy, false);
  } finally { await t.cleanup(); }
});

test('an actual missing executable reports its asynchronous spawn failure and allows a later cancellable child', async () => {
  const t = await fixture();
  try {
    t.preflight.resolve(); t.faults.spawn = 'error';
    await t.owner.call('local.download', { module: MODULE.id });
    await waitFor('failed child native close', () => !t.core.local.busy);
    assert.equal(t.children.length, 1); assert.equal(t.children[0]!.pid, undefined);
    assert.notEqual(t.children[0]!.exitCode, null);
    const status = await t.owner.call('local.status', {});
    assert.equal(status.modules[0]?.download?.state, 'failed');
    assert.match(status.modules[0]?.download?.error ?? '', /ENOENT/);
    t.faults.spawn = 'normal';
    await t.owner.call('local.download', { module: MODULE.id });
    assert.equal(t.children.length, 2);
    const child = t.children[1]!; const closed = once(child, 'close');
    await t.owner.call('local.cancel', { module: MODULE.id }); await closed;
    assert.equal(child.signalCode, 'SIGTERM'); assert.equal(t.core.local.busy, false);
  } finally { await t.cleanup(); }
});
