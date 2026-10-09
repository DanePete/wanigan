// Local failures must not retain request promises or a stalled Unix socket.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { CoreClient } from './client.ts';

async function connected(mode: 'echo' | 'hold' | 'pause') {
  const dir = mkdtempSync(join(tmpdir(), 'wg-client-send-'));
  const path = join(dir, 'core.sock');
  let peer: Socket | null = null;
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    peer = socket;
    socket.on('error', () => {});
    socket.once('data', () => {
      if (mode === 'pause') socket.pause();
      if (mode === 'echo') {
        let buffered = '';
        socket.on('data', (chunk) => {
          buffered += String(chunk);
          let newline: number;
          while ((newline = buffered.indexOf('\n')) >= 0) {
            const request = JSON.parse(buffered.slice(0, newline)) as { id: number };
            buffered = buffered.slice(newline + 1);
            socket.write(`${JSON.stringify({ id: request.id, result: 'answered' })}\n`);
          }
        });
      }
      socket.write(`${JSON.stringify({ ready: true, role: 'owner' })}\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  const client = await CoreClient.connect(path, 'fixture-only');
  // These private fields are inspected only to prove resource cleanup, which
  // rejected promises alone cannot establish. No production seam is needed.
  const socket = Reflect.get(client, 'socket') as Socket;
  const pending = Reflect.get(client, 'pending') as Map<number, unknown>;
  return {
    client, socket, pending, peer: peer as unknown as Socket,
    async close() {
      client.close(); socket.destroy(); (peer as Socket | null)?.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('serialization failures retain no pending requests and a later valid call succeeds', async () => {
  const t = await connected('echo');
  try {
    const cyclic: { self?: unknown } = {}; cyclic.self = cyclic;
    for (let i = 0; i < 100; i++) await assert.rejects(t.client.callRaw('core.hello', cyclic), /circular/i);
    await assert.rejects(t.client.callRaw('core.hello', { toJSON() { throw new Error('fixture encoding failure'); } }), /fixture encoding failure/);
    assert.equal(t.pending.size, 0, 'failed serialization must not retain promise closures');
    assert.equal(t.client.isClosed, false, 'bad caller input does not break the transport');
    assert.equal(await t.client.callRaw('core.hello', {}), 'answered');
    assert.equal(t.pending.size, 0);
  } finally { await t.close(); }
});

for (const failure of ['throw', 'callback'] as const) {
  test(`a socket write ${failure} rejects all pending work and destroys the failed connection`, async (context) => {
    const t = await connected('hold');
    try {
      let closed = 0; t.client.onClose(() => { closed++; });
      const prior = t.client.callRaw('core.hello', {}).then(() => null, (error: Error) => error);
      const error = new Error('fixture socket write failure');
      context.mock.method(t.socket, 'write', (...args: unknown[]) => {
        if (failure === 'throw') throw error;
        const callback = args.at(-1);
        if (typeof callback === 'function') queueMicrotask(() => callback(error));
        return false;
      });
      const failed = t.client.callRaw('core.hello', {}).then(() => null, (error: Error) => error);
      await setImmediate();
      assert.equal(t.client.isClosed, true);
      assert.equal(t.socket.destroyed, true);
      assert.equal(t.pending.size, 0);
      assert.equal(await failed, error);
      assert.equal(await prior, error);
      assert.equal(closed, 1);
      await assert.rejects(t.client.callRaw('core.hello', {}), /not connected/i);
    } finally { await t.close(); }
  });
}

test('close destroys unread outgoing data instead of waiting for the peer to drain it', async () => {
  const t = await connected('pause');
  try {
    const result = t.client.callRaw('core.hello', { padding: 'x'.repeat(8 * 1024 * 1024) }).then(() => null, (error: Error) => error);
    assert.ok(t.socket.writableLength > 0, 'the fixture must have real buffered output');
    const closed = once(t.socket, 'close');
    t.client.close();
    assert.equal(t.socket.destroyed, true, 'close must release the transport immediately');
    await closed;
    assert.match((await result)?.message ?? '', /closed/i);
    assert.equal(t.pending.size, 0);
  } finally { await t.close(); }
});

test('peer EOF rejects pending work even while outgoing data cannot drain', async () => {
  const t = await connected('pause');
  try {
    const result = t.client.callRaw('core.hello', { padding: 'x'.repeat(8 * 1024 * 1024) }).then(() => null, (error: Error) => error);
    assert.ok(t.socket.writableLength > 0);
    const ended = once(t.socket, 'end');
    t.peer.end();
    await ended;
    assert.equal(t.client.isClosed, true, 'EOF means the peer can no longer answer');
    assert.equal(t.socket.destroyed, true);
    assert.equal(t.pending.size, 0);
    assert.match((await result)?.message ?? '', /closed/i);
    await assert.rejects(t.client.callRaw('core.hello', {}), /not connected/i);
  } finally { await t.close(); }
});
