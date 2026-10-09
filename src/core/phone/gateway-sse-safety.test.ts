// Real authenticated, owned HTTP streams with bounded injected terminal data.
// No real provider, PTY throughput, Tailscale or stress/exhaustion experiment.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { request, type ClientRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { createConnection } from 'node:net';
import { setImmediate as turn } from 'node:timers/promises';
import { test } from 'node:test';
import { CoreClient } from '../../client/client.ts';
import { Core } from '../core.ts';
import { launcher, testCore, waitFor, type TestCore } from '../test-support.ts';
import { Tailscale } from './tailscale.ts';

interface Peer { req: ClientRequest; res: IncomingMessage; status: number; text: string; bytes: number }
interface GatewayState {
  streams: Map<ServerResponse, string>;
  options: {
    onEvent: (listener: (event: string, data: unknown) => void) => () => void;
    onData: (listener: (id: string, seq: number, data: string) => void) => () => void;
  };
}
async function fixture(restarted?: TestCore) {
  const t = restarted ?? await testCore();
  const peers: Peer[] = [];
  if (!restarted) await t.owner.call('phone.enable', {});
  const port = t.core.phone.listeningPort!;
  const gateway = (t.core.phone as unknown as { gateway: GatewayState }).gateway;
  const events = new Set<(event: string, data: unknown) => void>();
  const data = new Set<(id: string, seq: number, data: string) => void>();
  const onEvent = gateway.options.onEvent;
  const onData = gateway.options.onData;
  gateway.options.onEvent = (listener) => { events.add(listener); const off = onEvent(listener); return () => { events.delete(listener); off(); }; };
  gateway.options.onData = (listener) => { data.add(listener); const off = onData(listener); return () => { data.delete(listener); off(); }; };
  const pair = async (name: string) => {
    const { code } = await t.owner.call('phone.pairCode', {});
    const response = await fetch(`http://127.0.0.1:${port}/api/pair`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, name }),
    });
    const result = (await response.json() as { result: { token: string; device: { id: string } } }).result;
    await t.owner.call('phone.setControl', { id: result.device.id, control: false });
    return result;
  };
  const open = (token: string, paused = false, watched = 'one') => new Promise<Peer>((resolve, reject) => {
    const currentPort = t.core.phone.listeningPort ?? port;
    const req = request({ hostname: '127.0.0.1', port: currentPort, path: `/api/events?watch=${watched}`, agent: false,
      headers: { Host: `127.0.0.1:${currentPort}`,  Authorization: `Bearer ${token}` },
    }, (res) => {
      const peer: Peer = { req, res, status: res.statusCode!, text: '', bytes: 0 }; peers.push(peer);
      res.on('data', (chunk: Buffer) => { peer.bytes += chunk.length; if (peer.text.length < 4096) peer.text += chunk.toString('utf8'); });
      res.on('error', () => {});
      if (paused) { res.pause(); res.socket!.pause(); }
      resolve(peer);
    });
    req.on('error', reject); req.end();
  });
  const closePeer = (peer: Peer) => { peer.res.destroy(); peer.req.destroy(); };
  const emit = (value: string, seq = 1, id = 'one') => { for (const listener of data) listener(id, seq, value); };
  const counts = () => ({ streams: gateway.streams.size, events: events.size, data: data.size });
  return { ...t, port, gateway, pair, open, closePeer, emit, counts, events, data, async close() {
    for (const peer of peers) closePeer(peer); await t.close();
  } };
}

async function expectCounts(t: Awaited<ReturnType<typeof fixture>>, streams: number) {
  await waitFor('stream/listener counts to settle', () => {
    const got = t.counts(); return got.streams === streams && got.events === streams && got.data === streams;
  }, 2_000);
}

function nativeCloseCharges(t: Awaited<ReturnType<typeof fixture>>) {
  const charges: boolean[] = [];
  for (const response of t.gateway.streams.keys()) {
    // Observe native close before the gateway's own close listener releases
    // this response. The queued Phone transition alone cannot prove that.
    response.prependOnceListener('close', () => { charges.push(t.gateway.streams.has(response)); });
  }
  return charges;
}

test('four read-only device streams fit, the fifth is explicitly refused, and a closed slot recovers', async () => {
  const t = await fixture();
  try {
    const { token } = await t.pair('Four-view fixture');
    const accepted: Peer[] = [];
    for (let i = 0; i < 4; i++) { const p = await t.open(token); assert.equal(p.status, 200); accepted.push(p); }
    assert.deepEqual(t.counts(), { streams: 4, events: 4, data: 4 });
    const refused = await t.open(token);
    assert.equal(refused.status, 429);
    await waitFor('admission explanation', () => refused.text.includes('Too many'), 2_000);
    assert.equal(JSON.parse(refused.text).error.code, 'refused');
    assert.deepEqual(t.counts(), { streams: 4, events: 4, data: 4 });
    t.emit('accepted stream still receives');
    await waitFor('existing streams survive refusal', () => accepted.every((p) => p.text.includes('accepted stream still receives')), 2_000);
    t.closePeer(accepted[0]!); await expectCounts(t, 3);
    assert.equal((await t.open(token)).status, 200); await expectCounts(t, 4);
    assert.ok(Array.isArray(await t.owner.call('projects.list', {})));
  } finally { await t.close(); }
  assert.deepEqual(t.counts(), { streams: 0, events: 0, data: 0 });
});

test('32 global streams fit across devices, extra admission changes no listeners and recovers after native close', async () => {
  const t = await fixture();
  try {
    const peers: Peer[] = [];
    for (let d = 0; d < 8; d++) {
      const { token } = await t.pair(`Global fixture ${d}`);
      for (let i = 0; i < 4; i++) { const peer = await t.open(token); assert.equal(peer.status, 200); peers.push(peer); }
    }
    const other = await t.pair('Extra device');
    assert.equal((await t.open(other.token)).status, 429);
    assert.deepEqual(t.counts(), { streams: 32, events: 32, data: 32 });
    t.closePeer(peers[0]!); await expectCounts(t, 31);
    assert.equal((await t.open(other.token)).status, 200); await expectCounts(t, 32);
    assert.ok(Array.isArray(await t.owner.call('projects.list', {})));
  } finally { await t.close(); }
  assert.deepEqual(t.counts(), { streams: 0, events: 0, data: 0 });
});

test('a paused Unicode stream stays within the byte budget, then only that consumer closes and healthy access recovers', async () => {
  const t = await fixture();
  try {
    const { token } = await t.pair('Paused Unicode fixture');
    const peer = await t.open(token, true);
    const response = [...t.gateway.streams.keys()][0]!;
    const write = response.write;
    let nonBuffers = 0;
    response.write = function (this: ServerResponse, chunk: unknown, ...args: unknown[]) {
      if (!Buffer.isBuffer(chunk)) nonBuffers++;
      return Reflect.apply(write, this, [chunk, ...args]) as boolean;
    } as typeof response.write;
    const payload = '界'.repeat(16_384); //48 KiB/frame; at most96 frames, under5 MiB total.
    let maxQueued = 0;
    let measuredBufferBytes = 0;
    for (let seq = 1; seq <= 96 && !response.destroyed; seq++) {
      t.emit(payload, seq);
      maxQueued = Math.max(maxQueued, response.writableLength);
      const entries = (response.socket as unknown as { _writableState: { getBuffer: () => { chunk: string | Buffer }[] } } | null)?._writableState.getBuffer() ?? [];
      let nativeBytes = 0;
      for (const { chunk } of entries) {
        if (typeof chunk === 'string') assert.ok(/^[\x00-\x7f]*$/.test(chunk), 'only native ASCII framing may remain a string');
        else measuredBufferBytes = Math.max(measuredBufferBytes, chunk.byteLength);
        nativeBytes += Buffer.byteLength(chunk);
      }
      assert.ok(nativeBytes <= response.writableLength, 'real queued UTF-8 entries fit the native byte accounting');
      await turn();
    }
    assert.equal(nonBuffers, 0, 'native socket accounting must use UTF-8 bytes, not string code units');
    assert.ok(maxQueued > 0 && measuredBufferBytes > 0, 'an actual paused peer produced queued Buffer bodies');
    assert.ok(maxQueued <= 2 * 1024 * 1024, `queued ${maxQueued} bytes`);
    assert.equal(response.destroyed, true, 'stalled consumer is disconnected at finite budget');
    await expectCounts(t, 0);
    assert.ok(Array.isArray(await t.owner.call('projects.list', {})));
    peer.res.destroy();
    const healthy = await t.open(token);
    assert.equal(healthy.status, 200);
    t.emit('healthy after overflow');
    await waitFor('fresh reader gets output', () => healthy.text.includes('healthy after overflow'), 2_000);
    await expectCounts(t, 1);
  } finally { await t.close(); }
  assert.deepEqual(t.counts(), { streams: 0, events: 0, data: 0 });
});

const frame = (event: string, data: unknown) => `data: ${JSON.stringify({ event, data })}\n\n`;
const cost = (value: string) => { const bytes = Buffer.byteLength(value); return bytes + bytes.toString(16).length + 4 + 5; };

test('normal paused output drains exactly, two streams may overlap, and only the first four terminals are watched', async () => {
  const t = await fixture();
  try {
    const { token } = await t.pair('Drain and overlap fixture');
    const paused = await t.open(token, true, 'one,two,three,four,five');
    const response = [...t.gateway.streams.keys()][0]!;
    const healthy = await t.open(token, false, 'two');
    assert.equal(paused.status, 200); assert.equal(healthy.status, 200); await expectCounts(t, 2);
    let expected = Buffer.byteLength(': connected\n\n');
    t.emit('fourth watched marker', 1, 'four');
    expected += Buffer.byteLength(frame('pty.data', { sessionId: 'four', seq: 1, data: 'fourth watched marker' }));
    t.emit('fifth must be absent', 1, 'five');
    for (const listener of t.events) listener('board', { marker: 'core event marker' });
    expected += Buffer.byteLength(frame('board', { marker: 'core event marker' }));
    const payload = '界'.repeat(16_384);
    let peak = 0;
    for (let seq = 1; seq <= 32; seq++) {
      t.emit(payload, seq); expected += Buffer.byteLength(frame('pty.data', { sessionId: 'one', seq, data: payload }));
      peak = Math.max(peak, response.writableLength); await turn();
    }
    assert.ok(peak > 0 && peak <= 2 * 1024 * 1024, `measured native queue ${peak}`);
    assert.equal(response.destroyed, false, 'temporary backpressure alone does not disconnect');
    await waitFor('overlapping stream stays responsive', () => healthy.text.includes('core event marker'), 2_000);
    assert.equal(healthy.text.includes('fourth watched marker'), false, 'each stream keeps its own watch list');
    paused.res.socket!.resume(); paused.res.resume();
    await waitFor('all UTF-8 frame bytes drain', () => paused.bytes === expected && response.writableLength === 0, 3_000);
    assert.ok(paused.text.includes('fourth watched marker'));
    assert.equal(paused.text.includes('fifth must be absent'), false);
    assert.equal(response.destroyed, false); await expectCounts(t, 2);
    t.closePeer(paused); await expectCounts(t, 1);
    const replacement = await t.open(token); assert.equal(replacement.status, 200); await expectCounts(t, 2);
  } finally { await t.close(); }
  assert.deepEqual(t.counts(), { streams: 0, events: 0, data: 0 });
});

test('UTF-8 body plus HTTP framing fits at the exact edge; one byte over ends only that stream and holds its slot until close', async () => {
  const t = await fixture();
  let response: ServerResponse | undefined;
  try {
    const { token } = await t.pair('Exact queue edge fixture');
    const peer = await t.open(token);
    const other = await t.open(token);
    response = [...t.gateway.streams.keys()][0]!;
    await waitFor('initial output drains', () => response!.writableLength === 0, 2_000);
    const message = frame('pty.data', { sessionId: 'one', seq: 1, data: 'edge 界🙂' });
    const originalWrite = response.write;
    let writes = 0;
    response.write = function (this: ServerResponse, ...args: unknown[]) { writes++; return Reflect.apply(originalWrite, this, args) as boolean; } as typeof response.write;
    // Transparent edge seam: the actual response writes/destroys and its peers
    // are real; only the already-buffered length is supplied to avoid2MiB edge allocations.
    Object.defineProperty(response, 'writableLength', { configurable: true, get: () => 2 * 1024 * 1024 - cost(message) });
    t.emit('edge 界🙂');
    assert.equal(writes, 1); assert.equal(response.destroyed, false);
    Reflect.deleteProperty(response, 'writableLength');
    await waitFor('exact-edge Unicode arrives', () => peer.text.includes('edge 界🙂'), 2_000);
    Object.defineProperty(response, 'writableLength', { configurable: true, get: () => 2 * 1024 * 1024 - cost(message) + 1 });
    t.emit('edge 界🙂');
    assert.equal(response.destroyed, true); assert.equal(writes, 1, 'the overflow frame was never written');
    assert.deepEqual(t.counts(), { streams: 2, events: 1, data: 1 }, 'listener cleanup is immediate; native closing slot is still charged');
    Reflect.deleteProperty(response, 'writableLength');
    await expectCounts(t, 1);
    t.emit('other stream remains healthy');
    await waitFor('other stream survives', () => other.text.includes('other stream remains healthy'), 2_000);
    assert.ok(Array.isArray(await t.owner.call('projects.list', {})));
  } finally { if (response) Reflect.deleteProperty(response, 'writableLength'); await t.close(); }
  assert.deepEqual(t.counts(), { streams: 0, events: 0, data: 0 });
});

test('idle heartbeats use the same bounded Buffer path, do not close a draining reader, and stop after close', async (context) => {
  const t = await fixture();
  try {
    const { token } = await t.pair('Heartbeat fixture');
    context.mock.timers.enable({ apis: ['setInterval'] });
    const peer = await t.open(token);
    const response = [...t.gateway.streams.keys()][0]!;
    const originalWrite = response.write;
    let writes = 0;
    response.write = function (this: ServerResponse, chunk: unknown, ...args: unknown[]) {
      assert.ok(Buffer.isBuffer(chunk)); writes++; return Reflect.apply(originalWrite, this, [chunk, ...args]) as boolean;
    } as typeof response.write;
    for (let i = 0; i < 3; i++) { context.mock.timers.tick(25_000); await turn(); }
    await waitFor('three idle heartbeat comments', () => peer.text.split(': still here').length === 4, 2_000);
    assert.equal(writes, 3); assert.equal(response.destroyed, false);
    t.closePeer(peer); await expectCounts(t, 0);
    context.mock.timers.tick(100_000); await turn();
    assert.equal(writes, 3, 'closed stream has no retained heartbeat callback');
  } finally { await t.close(); }
  assert.deepEqual(t.counts(), { streams: 0, events: 0, data: 0 });
});

test('a queued HTTP pipeline stream can overflow independently, stays charged, and all slots disappear on native peer close', async () => {
  const t = await fixture();
  const socket = createConnection({ host: '127.0.0.1', port: t.port });
  let heard = '';
  socket.setEncoding('utf8'); socket.on('data', (chunk: string) => { heard += chunk; }); socket.on('error', () => {});
  try {
    const { token } = await t.pair('Pipeline fixture');
    const get = (watch: string) => `GET /api/events?watch=${watch} HTTP/1.1\r\nHost: 127.0.0.1:${t.port}\r\nAuthorization: Bearer ${token}\r\n\r\n`;
    socket.write(get('one') + get('two'));
    await expectCounts(t, 2);
    const [active, queued] = [...t.gateway.streams.keys()];
    assert.ok(active!.socket); assert.equal(queued!.socket, null, 'the second response waits behind the first');
    const payload = '界'.repeat(16_384);
    let peak = 0;
    for (let seq = 1; seq <= 48 && !queued!.destroyed; seq++) {
      t.emit(payload, seq, 'two'); peak = Math.max(peak, queued!.writableLength);
    }
    assert.ok(peak > 0 && peak <= 2 * 1024 * 1024);
    assert.equal(queued!.destroyed, true); assert.equal(active!.destroyed, false);
    assert.deepEqual(t.counts(), { streams: 2, events: 1, data: 1 }, 'queued native response keeps its slot while listeners stop');
    t.emit('first pipeline stream still works');
    await waitFor('first response remains usable', () => heard.includes('first pipeline stream still works'), 2_000);
    socket.destroy(); await expectCounts(t, 0);
    assert.equal((await t.open(token)).status, 200); await expectCounts(t, 1);
  } finally { socket.destroy(); await t.close(); }
  assert.deepEqual(t.counts(), { streams: 0, events: 0, data: 0 });
});

test('Off holds admission slots until native close, awaits complete cleanup, and permits streams after re-enable', async () => {
  const t = await fixture();
  try {
    const { token } = await t.pair('Off fixture');
    assert.equal((await t.open(token)).status, 200);
    assert.equal((await t.open(token)).status, 200);
    const charges = nativeCloseCharges(t);
    const closing = t.core.phone.disable();
    assert.equal(t.counts().streams, 2, 'Off does not synchronously erase native-open slots');
    const off = await closing;
    assert.deepEqual(charges, [true, true], 'both responses remain charged until their own native close');
    assert.deepEqual([off.enabled, off.listening], [false, false]);
    assert.deepEqual(t.counts(), { streams: 0, events: 0, data: 0 }, 'awaited Off includes response cleanup');
    const on = await t.owner.call('phone.enable', {});
    assert.deepEqual([on.enabled, on.listening], [true, true]);
    const reopened = await t.open(token);
    assert.equal(reopened.status, 200); await expectCounts(t, 1);
    t.emit('after re-enable');
    await waitFor('reopened stream receives', () => reopened.text.includes('after re-enable'), 2_000);
    assert.ok(Array.isArray(await t.owner.call('projects.list', {})));
  } finally { await t.close(); }
  assert.deepEqual(t.counts(), { streams: 0, events: 0, data: 0 });
});

test('terminal shutdown awaits native stream cleanup, preserves On, and a new core restores the paired reader', async () => {
  const t = await fixture();
  let again: Awaited<ReturnType<typeof fixture>> | undefined;
  let restarted: Core | undefined;
  let owner: CoreClient | undefined;
  try {
    const { token, device } = await t.pair('Core restart fixture');
    assert.equal((await t.open(token)).status, 200);
    assert.equal((await t.open(token)).status, 200);
    const charges = nativeCloseCharges(t);
    const closing = t.core.phone.stop();
    assert.equal(t.counts().streams, 2, 'shutdown does not synchronously erase native-open slots');
    await closing;
    assert.deepEqual(charges, [true, true], 'both responses remain charged until their own native close');
    assert.deepEqual(t.counts(), { streams: 0, events: 0, data: 0 }, 'awaited shutdown includes response cleanup');
    assert.equal(t.core.phone.enabled, true, 'terminal shutdown preserves the saved On intent');
    await assert.rejects(t.core.phone.enable(), /shutting down/);
    assert.ok(Array.isArray(await t.owner.call('projects.list', {})));
    t.owner.close(); await t.core.stop();

    // Restart the real core on the same owned DB, with every machine/provider
    // seam still explicitly fake. Do not call enable: startup must restore On.
    const core = new Core({ dataDir: t.core.paths.dataDir, launcher, codexHookProbe: null, codexModels: async () => [],
      jev: { envKey: null }, local: { lmsBin: null, ollamaUrl: 'http://127.0.0.1:9' },
      phone: { port: 0, tailscale: new Tailscale({ bin: null }), rendererDir: join(t.dir, 'renderer') },
      accounts: { home: join(t.dir, 'home'), prober: async () => ({ signedIn: 'unknown', identity: null, plan: null }),
        usageReader: async () => ({ state: 'unreadable', windows: [], checkedAt: 0, note: 'owned SSE restart fixture' }) },
    });
    restarted = core;
    await core.start();
    owner = await CoreClient.connect(core.paths.socket, readFileSync(core.paths.ownerToken, 'utf8'));
    const connected = owner;
    const status = await connected.call('phone.status', {});
    assert.deepEqual([status.enabled, status.listening], [true, true]);
    assert.deepEqual(status.devices.map(row => row.id), [device.id], 'the saved pairing survives restart');
    again = await fixture({ ...t, core, owner: connected, close: async () => { connected.close(); await core.stop(); } });
    const reopened = await again.open(token);
    assert.equal(reopened.status, 200); await expectCounts(again, 1);
    again.emit('after full core restart');
    await waitFor('restarted paired stream receives', () => reopened.text.includes('after full core restart'), 2_000);
    assert.ok(Array.isArray(await connected.call('projects.list', {})));
    assert.deepEqual(await connected.call('sessions.list', {}), []);
  } finally {
    await again?.close(); owner?.close(); await restarted?.stop(); await t.close();
  }
  assert.deepEqual(t.counts(), { streams: 0, events: 0, data: 0 });
  assert.deepEqual(again?.counts(), { streams: 0, events: 0, data: 0 });
});

test('the real exact-cap queue leaves five bytes for HTTP termination when a stream ends', async () => {
  const t = await fixture();
  try {
    const { token, device } = await t.pair('Terminator fixture');
    const peer = await t.open(token, true);
    const response = [...t.gateway.streams.keys()][0]!;
    await waitFor('initial comment drains', () => response.writableLength === 0, 2_000);
    const empty = frame('pty.data', { sessionId: 'one', seq: 1, data: '' });
    const payload = 'x'.repeat(2 * 1024 * 1024 - 15 - Buffer.byteLength(empty));
    const output = frame('pty.data', { sessionId: 'one', seq: 1, data: payload });
    assert.equal(cost(output), 2 * 1024 * 1024);
    // One2MiB boundary frame is bounded and intentional; this is actual native
    // queue accounting, not the synthetic already-buffered edge used above.
    t.emit(payload);
    assert.equal(response.writableLength, 2 * 1024 * 1024 - 5);
    (t.gateway as unknown as { drop: (id: string) => void }).drop(device.id);
    assert.equal(response.writableLength, 2 * 1024 * 1024, 'native final chunk fits the reserved bytes');
    assert.equal(response.writableEnded, true);
    peer.res.socket!.resume(); peer.res.resume();
    await expectCounts(t, 0);
    assert.equal(peer.bytes, 13 + Buffer.byteLength(output), 'all accepted SSE body bytes arrive once');
  } finally { await t.close(); }
  assert.deepEqual(t.counts(), { streams: 0, events: 0, data: 0 });
});
