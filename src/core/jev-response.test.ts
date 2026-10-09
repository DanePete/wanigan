import assert from 'node:assert/strict';
import { test } from 'node:test';
import { testCore } from './test-support.ts';

for (const status of [200, 401, 429]) {
  test(`Jev refuses and cancels an oversized chunked ${status} answer before buffering it`, async (t) => {
    const body = new TextEncoder().encode(JSON.stringify({ answers: {}, padding: 'x'.repeat(3 * 1024 * 1024) }));
    const received: { bytes: number; cancelled: boolean }[] = [];
    t.mock.method(globalThis, 'fetch', async () => {
      const seen = { bytes: 0, cancelled: false };
      received.push(seen);
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          if (seen.bytes === body.length) { controller.close(); return; }
          const end = Math.min(seen.bytes + 64 * 1024, body.length);
          controller.enqueue(body.subarray(seen.bytes, end));
          seen.bytes = end;
        },
        cancel() { seen.cancelled = true; },
      }), { status });
    });
    const core = await testCore({ jev: { envKey: 'fixture-key', backoffMs: 1 } });
    try {
      await assert.rejects(core.core.jev.ask('fixture', {}, 'test'), /too large/i);
      assert.ok(received.length > 0);
      for (const reply of received) {
        assert.equal(reply.cancelled, true, 'stop reading the rejected reply');
        assert.ok(reply.bytes <= 1024 * 1024 + 128 * 1024, 'the byte bound applies while streaming');
      }
      const result = await core.core.jev.status();
      assert.equal(result.online, false);
      assert.equal(result.calls, received.length, 'each attempted request remains counted');
      assert.equal(result.errors, received.length);
    } finally { await core.close(); }
  });
}

test('Jev refuses an oversized declared body without pulling its stream', async (t) => {
  let cancelled = 0;
  let pulled = 0;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) { pulled++; controller.enqueue(new TextEncoder().encode('{"answers":{}}')); controller.close(); },
    cancel() { cancelled++; },
  }, { highWaterMark: 0 }), { headers: { 'content-length': String(2 * 1024 * 1024) } }));
  const core = await testCore({ jev: { envKey: 'fixture-key', backoffMs: 1 } });
  try {
    await assert.rejects(core.core.jev.ask('fixture', {}, 'test'), /too large/i);
    assert.equal(pulled, 0);
    assert.ok(cancelled > 0);
  } finally { await core.close(); }
});
