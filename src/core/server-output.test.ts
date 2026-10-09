// Real sockets with a minimal core: no database, model, session or provider data.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Socket } from 'node:net';
import { join } from 'node:path';
import { setImmediate, setTimeout } from 'node:timers/promises';
import { test } from 'node:test';
import { CoreClient } from '../client/client.ts';
import type { Hello } from '../shared/protocol.ts';
import { Bus } from './context.ts';
import type { Handlers } from './handlers.ts';
import { CoreServer } from './server.ts';
import type { Sessions } from './sessions.ts';

const MiB = 1024 * 1024;
const BUDGET = 64 * MiB;
const line = (data: unknown): string => `${JSON.stringify({ event: 'fixture.output', data })}\n`;

async function until(check: () => boolean): Promise<void> {
  const end = Date.now() + 3_000;
  while (!check()) {
    assert.ok(Date.now() < end, 'the isolated socket did not settle');
    await setTimeout(5);
  }
}

async function fixture() {
  const dir = mkdtempSync('/tmp/wg-server-output-');
  const socketPath = join(dir, 'core.sock');
  const bus = new Bus();
  const clients: CoreClient[] = [];
  let terminal: ((sessionId: string, seq: number, data: string) => void) | undefined;
  const hello: Hello = { version: 'fixture', role: 'owner', sessionId: null, projectId: null, dataDir: null, demo: true, build: null, pid: null };
  const server = new CoreServer({
    socketPath, hookSocketPath: join(dir, 'hooks.sock'), ownerToken: 'fixture-only', bus,
    handlers: { 'core.hello': () => hello, 'sessions.watch': () => ({ ok: true }) } as unknown as Handlers,
    sessions: {
      byToken: () => null,
      onData(listener: (sessionId: string, seq: number, data: string) => void) { terminal = listener; },
    } as unknown as Sessions,
    log: () => {}, onIdleStop: () => {},
  });
  await server.listen();
  const owners = Reflect.get(server, 'owners') as Set<Socket>;
  // No production seam: private transport state and helper are inspected only
  // to measure retained bytes and exercise callback/budget boundaries.
  const send = (Reflect.get(server, 'send') as (socket: Socket, line: string, after?: () => void) => void).bind(server);
  return {
    server, bus, hello, send,
    terminal(sessionId: string, seq: number, data: string) { assert.ok(terminal); terminal(sessionId, seq, data); },
    async owner() {
      const before = new Set(owners);
      const client = await CoreClient.connect(socketPath, 'fixture-only');
      clients.push(client);
      const socket = [...owners].find((owner) => !before.has(owner));
      assert.ok(socket);
      const transport = Reflect.get(client, 'socket') as Socket;
      return { client, socket, transport };
    },
    async close() {
      for (const client of clients) client.close();
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('broadcast output accounts for queued UTF-8 bytes while another owner stays responsive', async (t) => {
  const f = await fixture(); t.after(() => f.close());
  const stalled = await f.owner();
  const active = await f.owner();
  stalled.transport.pause();
  const data = { sessionId: 'fixture', seq: 1, data: '界'.repeat(MiB) };
  const expected = Buffer.byteLength(`${JSON.stringify({ event: 'pty.data', data })}\n`);
  let received = 0;
  stalled.client.on((event) => { if (event === 'pty.data') received++; });
  f.bus.emit('pty.data', data);
  assert.equal((await active.client.call('core.hello', {})).version, 'fixture');
  t.diagnostic(`queued counter ${stalled.socket.writableLength}; UTF-8 frame bytes ${expected}`);
  assert.equal(stalled.socket.writableLength, expected, 'a multibyte backlog must count bytes, not string length');
  assert.equal(stalled.socket.destroyed, false);
  stalled.transport.resume();
  await until(() => received === 1 && stalled.socket.writableLength === 0);
  assert.equal((await stalled.client.call('core.hello', {})).version, 'fixture');
  assert.equal(f.server.ownerConnections, 2);
});

test('watched terminal output uses the same byte accounting without blocking other owners', async (t) => {
  const f = await fixture(); t.after(() => f.close());
  const stalled = await f.owner();
  const active = await f.owner();
  await stalled.client.call('sessions.watch', { id: 'fixture' });
  stalled.transport.pause();
  const data = '漢'.repeat(MiB / 2);
  const expected = Buffer.byteLength(`${JSON.stringify({ event: 'pty.data', data: { sessionId: 'fixture', seq: 1, data } })}\n`);
  let received = 0;
  stalled.client.on((event) => { if (event === 'pty.data') received++; });
  f.terminal('fixture', 1, data);
  assert.equal((await active.client.call('core.hello', {})).version, 'fixture');
  assert.equal(stalled.socket.writableLength, expected);
  stalled.transport.resume();
  await until(() => received === 1 && stalled.socket.writableLength === 0);
  assert.equal((await stalled.client.call('core.hello', {})).version, 'fixture');
});

test('a queued multibyte RPC reply retains its byte count and resolves after the owner resumes', async (t) => {
  const f = await fixture(); t.after(() => f.close());
  const stalled = await f.owner();
  const active = await f.owner();
  f.hello.version = '語'.repeat(MiB / 2);
  stalled.transport.pause();
  const id = Reflect.get(stalled.client, 'nextId') as number;
  const result = stalled.client.call('core.hello', {});
  void result.catch(() => undefined);
  const expected = Buffer.byteLength(`${JSON.stringify({ id, result: f.hello })}\n`);
  await until(() => stalled.socket.writableLength > 0);
  assert.equal((await active.client.call('core.hello', {})).version.length, MiB / 2);
  assert.equal(stalled.socket.writableLength, expected);
  stalled.transport.resume();
  assert.equal((await result).version.length, MiB / 2);
  assert.equal(f.server.ownerConnections, 2);
});

test('the exact queued-byte cap is accepted and write callbacks finish after draining', async (t) => {
  const f = await fixture(); t.after(() => f.close());
  const stalled = await f.owner();
  const active = await f.owner();
  stalled.transport.pause();
  let completed = 0, received = 0;
  stalled.client.on((event) => { if (event === 'fixture.output') received++; });
  f.send(stalled.socket, line('x'.repeat(MiB)), () => completed++);
  assert.ok(stalled.socket.writableLength > 0, 'there must be real buffered output');
  const next = line('界'.repeat(32));
  // Only the budget edge is synthetic; sockets, frames, callbacks and drain are
  // real. No 64 MiB stalled fixture allocation is needed for an exact boundary.
  Object.defineProperty(stalled.socket, 'writableLength', { configurable: true, get: () => BUDGET - Buffer.byteLength(next) });
  try { f.send(stalled.socket, next, () => completed++); }
  finally { Reflect.deleteProperty(stalled.socket, 'writableLength'); }
  assert.equal(stalled.socket.destroyed, false, 'equality with the cap is allowed');
  assert.equal(completed, 0, 'queued completion is not reported before drain');
  assert.equal((await active.client.call('core.hello', {})).version, 'fixture');
  stalled.transport.resume();
  await until(() => received === 2 && completed === 2 && stalled.socket.writableLength === 0);
  assert.equal((await stalled.client.call('core.hello', {})).version, 'fixture');
});

test('one byte over the queue cap drops only the stalled owner and completes refusal callbacks', async (t) => {
  const f = await fixture(); t.after(() => f.close());
  const stalled = await f.owner();
  const active = await f.owner();
  stalled.transport.pause();
  let earlier = 0, refused = 0;
  f.send(stalled.socket, line('x'.repeat(MiB)), () => earlier++);
  assert.ok(stalled.socket.writableLength > 0);
  const next = line('界'.repeat(32));
  Object.defineProperty(stalled.socket, 'writableLength', { configurable: true, get: () => BUDGET - Buffer.byteLength(next) + 1 });
  try { f.send(stalled.socket, next, () => refused++); }
  finally { Reflect.deleteProperty(stalled.socket, 'writableLength'); }
  assert.equal(stalled.socket.destroyed, true, 'only an over-budget connection is dropped');
  assert.equal(refused, 1, 'completion runs even when output cannot be sent');
  await until(() => f.server.ownerConnections === 1 && earlier === 1);
  f.send(stalled.socket, next, () => refused++);
  assert.equal(refused, 2, 'an already destroyed socket also completes exactly once');
  assert.equal((await active.client.call('core.hello', {})).version, 'fixture');
  const replacement = await f.owner();
  assert.equal((await replacement.client.call('core.hello', {})).version, 'fixture');
  assert.equal(f.server.ownerConnections, 2);
  await setImmediate();
  assert.equal(refused, 2);
});
