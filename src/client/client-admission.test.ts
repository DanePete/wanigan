// Capacity refusals leave accepted requests and the connection usable.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { setImmediate, setTimeout } from 'node:timers/promises';
import { test } from 'node:test';
import { ATTACH_MAX_BYTES } from '../shared/attachments.ts';
import { CoreError, type Role } from '../shared/protocol.ts';
import { CoreClient } from './client.ts';

const MiB = 1024 * 1024;

async function until(check: () => boolean): Promise<void> {
  const end = Date.now() + 3_000;
  while (!check()) {
    assert.ok(Date.now() < end, 'the isolated peer did not settle');
    await setTimeout(5);
  }
}

async function connected(options: { role?: Role; paused?: boolean; echo?: boolean } = {}) {
  const dir = mkdtempSync('/tmp/wg-client-admit-');
  const path = join(dir, 'core.sock');
  const received: { id: number; characters: number }[] = [];
  let peer: Socket | null = null;
  let echo = options.echo ?? false;
  const answered = new Set<number>();
  const reply = (id: number): void => {
    if (!answered.has(id)) { answered.add(id); peer?.write(`${JSON.stringify({ id, result: id })}\n`); }
  };
  const server = createServer((socket) => {
    peer = socket;
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    socket.once('data', () => {
      // Stream fixture frames without retaining their large payloads. Only an ID
      // prefix and exact line length are needed to observe what was sent.
      let prefix = '', characters = 0;
      socket.on('data', (chunk: string) => {
        let start = 0;
        while (start < chunk.length) {
          const newline = chunk.indexOf('\n', start);
          const end = newline < 0 ? chunk.length : newline;
          if (prefix.length < 96) prefix += chunk.slice(start, Math.min(end, start + 96 - prefix.length));
          characters += end - start;
          if (newline < 0) break;
          const match = /^\{"id":(\d+),/.exec(prefix);
          assert.ok(match, 'fixture request must start with its ID');
          const id = Number(match[1]);
          received.push({ id, characters });
          prefix = ''; characters = 0;
          if (echo) reply(id);
          start = newline + 1;
        }
      });
      if (options.paused) socket.pause();
      socket.write(`${JSON.stringify({ ready: true, role: options.role ?? 'owner' })}\n`);
    });
  });
  server.listen(path);
  await once(server, 'listening');
  const client = await CoreClient.connect(path, 'fixture-only');
  // Resource inspection is confined to tests; production exposes no test seam.
  const socket = Reflect.get(client, 'socket') as Socket;
  const pending = Reflect.get(client, 'pending') as Map<number, unknown>;
  const calls: Promise<unknown>[] = [];
  return {
    client, socket, pending, received,
    call(params: unknown = {}) {
      const result = client.callRaw('core.hello', params);
      calls.push(result.catch(() => undefined));
      return result;
    },
    nextId(): number { return Reflect.get(client, 'nextId') as number; },
    release() { echo = true; for (const { id } of received) reply(id); peer?.resume(); },
    async close() {
      client.close(); peer?.destroy();
      await Promise.all(calls);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function refused(call: Promise<unknown>): Promise<void> {
  let outcome: { value?: unknown; error?: unknown } | undefined;
  void call.then((value) => { outcome = { value }; }, (error: unknown) => { outcome = { error }; });
  await setImmediate();
  assert.ok(outcome, 'capacity refusal must settle locally without waiting for the peer');
  assert.ok(outcome.error instanceof CoreError, 'the unsent call must fail explicitly');
  assert.equal(outcome.error.code, 'refused');
}

test('128 pending calls survive local refusal and later calls recover on the same connection', async (t) => {
  const f = await connected(); t.after(() => f.close());
  const calls = Array.from({ length: 128 }, () => f.call());
  await until(() => f.received.length === 128);
  for (let i = 0; i < 10; i++) await refused(f.call());
  assert.equal(f.pending.size, 128);
  assert.equal(f.received.length, 128, 'refused calls must never reach the peer');
  assert.equal(f.client.isClosed, false);
  f.release();
  assert.deepEqual(await Promise.all(calls), Array.from({ length: 128 }, (_, i) => i + 1));
  assert.equal(f.pending.size, 0);
  const id = f.nextId();
  assert.equal(await f.call(), id);
  assert.equal(f.received.length, 129, 'there is no retry of refused calls');
});

test('a full pending map refuses before invoking caller serialization', async (t) => {
  const f = await connected(); t.after(() => f.close());
  for (let i = 0; i < 128; i++) void f.call();
  let encoded = 0;
  await refused(f.call({ toJSON() { encoded++; throw new Error('must not encode while full'); } }));
  assert.equal(encoded, 0);
  assert.equal(f.pending.size, 128);
});

test('serialization reentry can fill the last slot without admitting the outer request', async (t) => {
  const f = await connected(); t.after(() => f.close());
  const earlier = Array.from({ length: 127 }, () => f.call());
  let inner: Promise<unknown> | undefined;
  let innerId = 0;
  await refused(f.call({ toJSON() { innerId = f.nextId(); inner = f.call(); return {}; } }));
  assert.equal(f.pending.size, 128);
  assert.equal(f.client.isClosed, false);
  f.release();
  await Promise.all(earlier);
  assert.equal(await inner, innerId);
  assert.equal(f.received.length, 128);
  assert.equal(f.pending.size, 0);
  assert.equal(await f.call(), f.nextId() - 1);
});

test('closing during serialization sends no request and preserves explicit disconnection', async (t) => {
  const f = await connected(); t.after(() => f.close());
  await assert.rejects(f.call({ toJSON() { f.client.close(); return {}; } }), /not connected/i);
  assert.equal(f.pending.size, 0);
  assert.equal(f.received.length, 0);
  assert.equal(f.socket.destroyed, true);
});

for (const [role, limit] of [['session', 4 * MiB], ['owner', 32 * MiB]] as const) {
  test(`${role} frame limit includes the JSON body but excludes its terminating newline`, async (t) => {
    const f = await connected({ role, echo: true }); t.after(() => f.close());
    const paddingFor = (characters: number): string => {
      const envelope = JSON.stringify({ id: f.nextId(), method: 'core.hello', params: { padding: '' } }).length;
      // The session case exceeds 4 MiB on the wire while fitting its character
      // limit, so accidentally changing framing to byte units would fail.
      return (role === 'session' ? '界' : 'x').repeat(characters - envelope);
    };
    await refused(f.call({ padding: paddingFor(limit + 1) }));
    assert.equal(f.pending.size, 0);
    assert.equal(f.received.length, 0);
    assert.equal(f.client.isClosed, false);
    const acceptedId = f.nextId();
    assert.equal(await f.call({ padding: paddingFor(limit) }), acceptedId);
    assert.deepEqual(f.received, [{ id: acceptedId, characters: limit }]);
    assert.equal(f.pending.size, 0);
    assert.equal(await f.call(), f.nextId() - 1);
  });
}

test('owner framing has room for a maximum attachment encoded as base64', () => {
  // Arithmetic avoids allocating repeated 20 MiB raw files and 27 MiB copies.
  assert.equal(ATTACH_MAX_BYTES, 20 * MiB);
  const base64Characters = 4 * Math.ceil(ATTACH_MAX_BYTES / 3);
  const envelope = JSON.stringify({ id: Number.MAX_SAFE_INTEGER, method: 'attachments.save', params: {
    to: { chat: 'fixture-chat' }, name: 'x'.repeat(120), data: '',
  } });
  assert.ok(base64Characters + envelope.length < 32 * MiB);
  assert.ok(base64Characters + Buffer.byteLength(envelope) + 1 < 64 * MiB);
});

test('a paused peer retains UTF-8 bytes rather than counting queued characters as bytes', async (t) => {
  const f = await connected({ paused: true }); t.after(() => f.close());
  const params = { padding: '界'.repeat(MiB) };
  const id = f.nextId();
  const wireBytes = Buffer.byteLength(`${JSON.stringify({ id, method: 'core.hello', params })}\n`);
  const call = f.call(params);
  await setImmediate();
  assert.equal(f.socket.writableLength, wireBytes, 'all buffered payload must be counted in bytes');
  assert.equal(f.pending.size, 1);
  f.release();
  assert.equal(await call, id);
  assert.equal(f.pending.size, 0);
});

test('queue-byte refusal preserves prior calls, admits the exact boundary and recovers after drain', async (t) => {
  const f = await connected({ paused: true }); t.after(() => f.close());
  const firstId = f.nextId();
  const first = f.call({ padding: 'x'.repeat(MiB) });
  assert.ok(f.socket.writableLength >= MiB, 'the fixture must have real queued output');
  const params = { padding: '界'.repeat(32) };
  const bytes = (): number => Buffer.byteLength(`${JSON.stringify({ id: f.nextId(), method: 'core.hello', params })}\n`);
  let occupied = 64 * MiB - bytes() + 1;
  // Only the budget edge is synthetic: the paused socket, requests, replies and
  // recovery are real. This avoids accumulating a 64 MiB fixture queue.
  Object.defineProperty(f.socket, 'writableLength', { configurable: true, get: () => occupied });
  t.after(() => { Reflect.deleteProperty(f.socket, 'writableLength'); });
  await refused(f.call(params));
  assert.equal(f.pending.size, 1);
  assert.equal(f.client.isClosed, false);
  assert.equal(f.socket.destroyed, false);
  occupied = 64 * MiB - bytes();
  const acceptedId = f.nextId();
  const accepted = f.call(params);
  assert.equal(f.pending.size, 2, 'the exact queued-byte boundary is admissible');
  Reflect.deleteProperty(f.socket, 'writableLength');
  f.release();
  assert.deepEqual(await Promise.all([first, accepted]), [firstId, acceptedId]);
  assert.deepEqual(f.received.map(({ id }) => id), [firstId, acceptedId], 'no refused request is written or retried');
  assert.equal(f.pending.size, 0);
  assert.equal(await f.call(), f.nextId() - 1);
});
