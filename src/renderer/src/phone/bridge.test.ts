// The real Phone bridge and owned HTTP gateway/core, with fake homes and an
// owned shell. A controlled transport delay reproduces independent key requests
// overtaking each other; no installed provider, browser or Tailscale is used.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { testCore, waitFor } from '../../../core/test-support.ts';
import { PhoneLink } from './bridge.ts';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function fixture() {
  const t = await testCore();
  const originalFetch = globalThis.fetch;
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  await t.owner.call('phone.enable', {});
  const base = `http://127.0.0.1:${t.core.phone.listeningPort}/`;
  const { code } = await t.owner.call('phone.pairCode', {});
  const paired = await originalFetch(`${base}api/pair`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, name: 'Input fixture' }),
  }).then((r) => r.json()) as { result: { token: string } };
  let token: string | null = paired.result.token;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: () => token, setItem: (_key: string, value: string) => { token = value; }, removeItem: () => { token = null; },
  } });
  const actualFetch: typeof fetch = (url, init) => originalFetch(new URL(String(url), base), init);
  globalThis.fetch = actualFetch;
  const link = new PhoneLink();
  return { ...t, base, link, actualFetch, token: paired.result.token, async close() {
    globalThis.fetch = originalFetch;
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
    await t.close();
  } };
}

function inputBody(init?: RequestInit): { method: string; params: { id: string; data: string } } {
  return JSON.parse(String(init?.body)) as { method: string; params: { id: string; data: string } };
}

test('phone keyboard characters and the extra Enter key reach an owned shell in callback order', async () => {
  const t = await fixture();
  const releaseFirst = deferred();
  const firstStarted = deferred();
  const laterFinished: Promise<unknown>[] = [];
  let delivered = Promise.resolve();
  try {
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    const session = await t.owner.call('sessions.start', { projectId: project.id, provider: 'shell' });
    await waitFor('the owned shell prompt', async () => /sh-[^\r\n]*[$#] /.test((await t.owner.call('sessions.watch', { id: session.id })).replay), 2_000);
    let inputs = 0;
    globalThis.fetch = async (url, init) => {
      if (String(url) !== 'api/rpc' || inputBody(init).method !== 'sessions.input') return t.actualFetch(url, init);
      if (++inputs === 1) { firstStarted.resolve(); await releaseFirst.promise; return t.actualFetch(url, init); }
      const sent = delivered.then(() => t.actualFetch(url, init));
      delivered = sent.then(async (response) => { await response.clone().json(); });
      laterFinished.push(delivered);
      return sent;
    };
    // Use separate calls exactly as xterm onData and the extra Enter button do.
    // The output file proves what the shell executed, not just what a mock saw.
    const command = "printf '%s' 'phone-ordered' > phone-input-result";
    const pending = [...command, '\r'].map((data) => t.link.rpc('sessions.input', { id: session.id, data }));
    await firstStarted.promise;
    // All already-dispatched later requests finish before releasing the first.
    // A correct FIFO has dispatched no later request, so this is an empty wait.
    await Promise.all(laterFinished);
    releaseFirst.resolve();
    await Promise.all(pending);
    const resultPath = join(t.projectDir, 'phone-input-result');
    await waitFor('the shell output file', () => existsSync(resultPath), 2_000).catch(() => {});
    const replay = (await t.owner.call('sessions.watch', { id: session.id })).replay;
    let result = '';
    try { result = readFileSync(resultPath, 'utf8'); } catch { /* assertion includes actual terminal */ }
    assert.equal(result, 'phone-ordered', replay);
    assert.equal(inputs, command.length + 1, 'each key sent once, including Enter');
  } finally { releaseFirst.resolve(); await t.close(); }
});

const settled = (promise: Promise<unknown>) => promise.then((value) => ({ ok: true, value }), (error: Error) => ({ ok: false, error }));
const success = () => new Response(JSON.stringify({ ok: true, result: { ok: true } }), { status: 200 });
const paused = (outcome: Awaited<ReturnType<typeof settled>>) => {
  assert.equal(outcome.ok, false);
  assert.ok('error' in outcome);
  assert.match(outcome.error.message, /input is paused.*may already have reached.*review.*reload/i);
};

test('a lost response after applied input cancels pending Enter, never retries, and requires deliberate reload', async () => {
  const t = await fixture();
  const release = deferred();
  const applied = deferred();
  try {
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    const session = await t.owner.call('sessions.start', { projectId: project.id, provider: 'shell' });
    await waitFor('the owned shell prompt', async () => /sh-[^\r\n]*[$#] /.test((await t.owner.call('sessions.watch', { id: session.id })).replay), 2_000);
    const sent: string[] = [];
    globalThis.fetch = async (url, init) => {
      const body = inputBody(init);
      if (body.method !== 'sessions.input') return t.actualFetch(url, init);
      sent.push(body.params.data);
      const response = await t.actualFetch(url, init);
      await response.clone().json();
      applied.resolve();
      await release.promise;
      throw new TypeError('fixture lost the reply after dispatch');
    };
    const command = "printf '%s' 'must-not-run' > truncated-command";
    const first = settled(t.link.rpc('sessions.input', { id: session.id, data: command }));
    const enter = settled(t.link.rpc('sessions.input', { id: session.id, data: '\r' }));
    await applied.promise;
    assert.deepEqual(sent, [command]);
    assert.equal((await t.link.rpc('projects.list', {}) as unknown[]).length, 1, 'reads remain independent');
    release.resolve();
    paused(await first); paused(await enter);
    paused(await settled(t.link.rpc('sessions.input', { id: session.id, data: '\r' })));
    assert.deepEqual(sent, [command], 'no suffix or retry after uncertain delivery');
    assert.equal(existsSync(join(t.projectDir, 'truncated-command')), false, 'pending Enter did not execute the prefix');
    // The input reply acknowledges the PTY write; its echo arrives separately.
    await waitFor('the applied prefix in the owned terminal replay', async () =>
      (await t.owner.call('sessions.watch', { id: session.id })).replay.includes('must-not-run'), 2_000);
    // A fresh bridge models an explicit page reload after reviewing the terminal.
    // Clear the observed unfinished line before deliberately typing a command.
    globalThis.fetch = t.actualFetch;
    const reloaded = new PhoneLink();
    await reloaded.rpc('sessions.input', { id: session.id, data: '\x15' });
    await reloaded.rpc('sessions.input', { id: session.id, data: "printf '%s' 'recovered' > recovered-input\r" });
    await waitFor('a deliberately reloaded phone to finish writing', () => {
      try { return readFileSync(join(t.projectDir, 'recovered-input'), 'utf8') === 'recovered'; } catch { return false; }
    }, 2_000);
    assert.equal(readFileSync(join(t.projectDir, 'recovered-input'), 'utf8'), 'recovered');
    assert.equal(existsSync(join(t.projectDir, 'truncated-command')), false);
  } finally { release.resolve(); await t.close(); }
});

test('a server input refusal also stops queued suffixes while unrelated RPCs still work', async () => {
  const t = await fixture();
  const release = deferred();
  const sent: string[] = [];
  try {
    globalThis.fetch = async (url, init) => {
      const body = inputBody(init);
      if (body.method !== 'sessions.input') return t.actualFetch(url, init);
      sent.push(body.params.data);
      await release.promise;
      return new Response(JSON.stringify({ ok: false, error: { code: 'forbidden', message: 'fixture is read-only' } }), { status: 403 });
    };
    const first = settled(t.link.rpc('sessions.input', { id: 'owned-session', data: 'x' }));
    const enter = settled(t.link.rpc('sessions.input', { id: 'owned-session', data: '\r' }));
    release.resolve();
    const result = await first;
    paused(result); paused(await enter);
    assert.ok('error' in result && /fixture is read-only/.test(result.error.message));
    assert.deepEqual(sent, ['x']);
    assert.ok(Array.isArray(await t.link.rpc('projects.list', {})));
  } finally { release.resolve(); await t.close(); }
});

test('128 queued and active key calls fit; the next stops the unsent batch without dispatching Enter', async () => {
  const t = await fixture();
  const release = deferred();
  let sent = 0;
  try {
    globalThis.fetch = async () => { sent++; await release.promise; return success(); };
    const pending = Array.from({ length: 128 }, () => settled(t.link.rpc('sessions.input', { id: 'owned-session', data: 'a' })));
    assert.equal(sent, 1);
    let settledEarly = false;
    void pending[127]!.then(() => { settledEarly = true; });
    await Promise.resolve(); await Promise.resolve();
    assert.equal(settledEarly, false, 'the 128th call is admitted');
    const overflow = settled(t.link.rpc('sessions.input', { id: 'owned-session', data: '\r' }));
    paused(await overflow);
    for (const result of await Promise.all(pending)) paused(result);
    release.resolve();
    paused(await settled(t.link.rpc('sessions.input', { id: 'owned-session', data: 'z' })));
    assert.equal(sent, 1, 'accepted unsent suffixes were cancelled');
    const state = t.link as unknown as { inputQueue: unknown[]; inputBytes: number; activeInput: unknown };
    assert.equal(state.inputQueue.length, 0); assert.equal(state.inputBytes, 0); assert.equal(state.activeInput, null);
  } finally { release.resolve(); await t.close(); }
});

test('the exact total UTF-8 input-body budget includes active data and refuses the next request', async () => {
  const t = await fixture();
  const release = deferred();
  const id = 'owned-session';
  const body = (data: string) => JSON.stringify({ method: 'sessions.input', params: { id, data } });
  const emptyBytes = Buffer.byteLength(body(''));
  const firstData = '界'.repeat(100);
  const secondData = 'x'.repeat(256 * 1024 - Buffer.byteLength(body(firstData)) - emptyBytes);
  assert.equal(Buffer.byteLength(body(firstData)) + Buffer.byteLength(body(secondData)), 256 * 1024);
  let sent = 0;
  try {
    globalThis.fetch = async () => { sent++; await release.promise; return success(); };
    const first = settled(t.link.rpc('sessions.input', { id, data: firstData }));
    const second = settled(t.link.rpc('sessions.input', { id, data: secondData }));
    let settledEarly = false;
    void second.then(() => { settledEarly = true; });
    await Promise.resolve(); await Promise.resolve();
    assert.equal(settledEarly, false, 'the exact combined byte limit is admitted');
    const overflow = settled(t.link.rpc('sessions.input', { id, data: '' }));
    paused(await overflow); paused(await first); paused(await second);
    assert.equal(sent, 1);
  } finally { release.resolve(); await t.close(); }
});

test('128 accepted calls drain once in order and byte capacity is recovered for later keys', async () => {
  const t = await fixture();
  const release = deferred();
  const sent: string[] = [];
  try {
    globalThis.fetch = async (_url, init) => {
      sent.push(inputBody(init).params.data);
      if (sent.length === 1) await release.promise;
      return success();
    };
    const keys = Array.from({ length: 128 }, (_, i) => String(i));
    const pending = keys.map((data) => t.link.rpc('sessions.input', { id: 'owned-session', data }));
    release.resolve();
    await Promise.all(pending);
    await t.link.rpc('sessions.input', { id: 'owned-session', data: 'later' });
    assert.deepEqual(sent, [...keys, 'later']);
  } finally { release.resolve(); await t.close(); }
});

test('unpair aborts the active send and refuses waiting input without reusing a later token', async () => {
  const t = await fixture();
  const release = deferred();
  const sent: { authorization: string | null; data: string }[] = [];
  let activeSignal: AbortSignal | null | undefined;
  try {
    globalThis.fetch = async (_url, init) => {
      activeSignal = init?.signal;
      sent.push({ authorization: new Headers(init?.headers).get('Authorization'), data: inputBody(init).params.data });
      await release.promise;
      return success();
    };
    const first = settled(t.link.rpc('sessions.input', { id: 'owned-session', data: 'a' }));
    const enter = settled(t.link.rpc('sessions.input', { id: 'owned-session', data: '\r' }));
    t.link.unpair();
    paused(await first); paused(await enter);
    assert.equal(activeSignal?.aborted, true);
    localStorage.setItem('wanigan.phone.token', 'different-fixture-token');
    release.resolve();
    paused(await settled(t.link.rpc('sessions.input', { id: 'owned-session', data: 'later' })));
    assert.deepEqual(sent, [{ authorization: `Bearer ${t.token}`, data: 'a' }]);
  } finally { release.resolve(); await t.close(); }
});

test('queued inputs snapshot their serialized bytes and preserve Unicode, paste and control keys', async () => {
  const t = await fixture();
  const release = deferred();
  const sent: string[] = [];
  try {
    globalThis.fetch = async (_url, init) => {
      sent.push(inputBody(init).params.data);
      if (sent.length === 1) await release.promise;
      return success();
    };
    const first = t.link.rpc('sessions.input', { id: 'one-session', data: 'prefix' });
    const params = { id: 'one-session', data: 'paste 界🙂\nnext line' };
    const paste = t.link.rpc('sessions.input', params);
    params.data = 'changed after admission';
    const ctrl = t.link.rpc('sessions.input', { id: 'one-session', data: '\x03' });
    release.resolve();
    await Promise.all([first, paste, ctrl]);
    assert.deepEqual(sent, ['prefix', 'paste 界🙂\nnext line', '\x03']);
  } finally { release.resolve(); await t.close(); }
});

test('one byte over the total UTF-8 budget stops the input batch before sending the second body', async () => {
  const t = await fixture();
  const release = deferred();
  const id = 'owned-session';
  const firstData = '界'.repeat(100);
  const body = (data: string) => JSON.stringify({ method: 'sessions.input', params: { id, data } });
  const secondData = 'x'.repeat(256 * 1024 - Buffer.byteLength(body(firstData)) - Buffer.byteLength(body('')) + 1);
  assert.equal(Buffer.byteLength(body(firstData)) + Buffer.byteLength(body(secondData)), 256 * 1024 + 1);
  let sent = 0;
  try {
    globalThis.fetch = async () => { sent++; await release.promise; return success(); };
    const first = settled(t.link.rpc('sessions.input', { id, data: firstData }));
    const over = settled(t.link.rpc('sessions.input', { id, data: secondData }));
    paused(await over); paused(await first);
    assert.equal(sent, 1);
  } finally { release.resolve(); await t.close(); }
});

test('a completed request releases its full byte budget before its caller sends another key', async () => {
  const t = await fixture();
  const id = 'owned-session';
  const overhead = Buffer.byteLength(JSON.stringify({ method: 'sessions.input', params: { id, data: '' } }));
  const data = 'x'.repeat(256 * 1024 - overhead);
  const sent: number[] = [];
  try {
    globalThis.fetch = async (_url, init) => { sent.push(Buffer.byteLength(String(init?.body))); return success(); };
    await t.link.rpc('sessions.input', { id, data });
    await t.link.rpc('sessions.input', { id, data: '\r' });
    assert.deepEqual(sent, [256 * 1024, overhead + 2]);
  } finally { await t.close(); }
});

test('a decoded unwatch refusal still releases its watched stream, while a lost reply preserves it', async () => {
  const t = await fixture();
  const followed: [string, number][] = [];
  // Observe follow without creating a live reconnecting stream in this transport fixture.
  const follow = t.link as unknown as { follow: (id: string, change: number) => Promise<void> };
  follow.follow = async (id, change) => { followed.push([id, change]); };
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ ok: false, error: { code: 'not_found', message: 'ended' } }), { status: 404 });
    await assert.rejects(t.link.rpc('sessions.unwatch', { id: 'ended-session' }), /ended/);
    assert.deepEqual(followed, [['ended-session', -1]]);
    globalThis.fetch = async () => { throw new Error('lost before decoding'); };
    await assert.rejects(t.link.rpc('sessions.unwatch', { id: 'other-session' }), /lost before decoding/);
    assert.deepEqual(followed, [['ended-session', -1]], 'network failure keeps its original unwatch behavior');
  } finally { await t.close(); }
});
