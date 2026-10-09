// Consent and card contents can change while Jev is waiting for a response.
// A local HTTP stand-in holds each answer until the owner has made that change.
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { test } from 'node:test';
import { testCore, waitFor } from './test-support.ts';

async function pendingJev(now: () => number = Date.now) {
  const responses: ServerResponse[] = [];
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => responses.push(res));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const t = await testCore({ now, jev: { url: `http://127.0.0.1:${port}`, envKey: 'local-test-key', backoffMs: 1 } });
  const answer = (index: number, status = 200): void => {
    responses[index]!.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify({
      model: 'test', usage: { input_tokens: 1_000_000 },
      answers: { action: { choice: 'ready', confidence: 0.99 }, severity: { score: 1 } },
    }));
  };
  return { ...t, responses, answer, async close() {
    // Settle any unexpected request too, so a failing regression leaves no busy task behind.
    const closing = setInterval(() => {
      for (const [i, res] of responses.entries()) if (!res.writableEnded) answer(i);
    }, 10);
    try { await waitFor('Jev settled', () => !t.core.jev.busy); } finally {
      clearInterval(closing);
      await t.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } };
}

test('turning Jev off while two reads are in flight prevents queued cards being sent', async () => {
  const t = await pendingJev();
  try {
    const p = await t.owner.call('projects.add', { path: t.projectDir });
    for (let i = 0; i < 3; i++) await t.owner.call('cards.create', { projectId: p.id, type: 'task', title: `Queued ${i}`, status: 'inbox' });
    await waitFor('two in-flight requests', () => t.responses.length === 2);
    await t.owner.call('projects.update', { id: p.id, jev: 'off' });
    t.answer(0); t.answer(1);
    await waitFor('queue drained or another request sent', () => !t.core.jev.busy || t.responses.length > 2);
    assert.equal(t.responses.length, 2, 'Off stops sending cards that were still queued');
    assert.equal(t.core.jev.busy, false);
  } finally { await t.close(); }
});

test('Jev never accepts a card whose criteria were removed while its answer was in flight', async () => {
  const t = await pendingJev();
  try {
    const p = await t.owner.call('projects.add', { path: t.projectDir });
    await t.owner.call('projects.update', { id: p.id, jev: 'off' });
    const c = await t.owner.call('cards.create', { projectId: p.id, type: 'task', title: 'Check the cart', status: 'inbox' });
    await t.owner.call('criteria.add', { cardId: c.id, text: 'The cart works' });
    const before = await t.owner.call('cards.get', { id: c.id });
    await t.owner.call('projects.update', { id: p.id, jev: 'accept' });
    await t.owner.call('jev.read', { cardId: c.id });
    await waitFor('request', () => t.responses.length === 1);
    await t.owner.call('criteria.remove', { id: before.criteria[0]!.id });
    t.answer(0);
    await waitFor('read completed', () => !t.core.jev.busy);
    const after = await t.owner.call('cards.get', { id: c.id });
    assert.equal(after.criteria.length, 0);
    assert.equal(after.status, 'inbox', 'a response about old criteria cannot accept the current card');
    assert.equal(after.jev?.outcome, 'read');
  } finally { await t.close(); }
});

test('every HTTP attempt is recorded, including busy replies before a successful retry', async () => {
  const t = await pendingJev();
  try {
    const p = await t.owner.call('projects.add', { path: t.projectDir });
    await t.owner.call('cards.create', { projectId: p.id, type: 'task', title: 'Retry accounting', status: 'inbox' });
    for (const [i, status] of [429, 529, 200].entries()) {
      await waitFor(`attempt ${i + 1}`, () => t.responses.length === i + 1);
      t.answer(i, status);
    }
    await waitFor('read completed', () => !t.core.jev.busy);
    const status = await t.owner.call('jev.status', {});
    assert.equal(status.calls, 3);
    assert.equal(status.errors, 2);
    assert.equal(status.costUsd, 0.042, 'only the successful answer’s reported tokens contribute');
    const calls = t.core.db.prepare('SELECT ok FROM jev_calls ORDER BY id').all();
    assert.deepEqual(calls, [{ ok: 0 }, { ok: 0 }, { ok: 1 }]);
  } finally { await t.close(); }
});


test('Jev totals survive pruning old calls, and still include calls pruned earlier today', async () => {
  let now = Date.now();
  const t = await pendingJev(() => now);
  try {
    const add = t.core.db.prepare('INSERT INTO jev_calls (at, ok, latency_ms, input_tokens, usage_known, model, error, purpose) VALUES (?, 1, 1, 1000000, 1, ?, NULL, ?)');
    t.core.db.transaction(() => {
      for (let i = 0; i < 5_000; i++) add.run(now, 'test', 'test');
    })();
    const reading = t.owner.call('jev.test', {});
    await waitFor('request', () => t.responses.length === 1);
    t.answer(0);
    const status = await reading;
    assert.equal(status.calls, 5_001);
    assert.equal(status.callsToday, 5_001);
    assert.equal(status.costUsd, 210.042);
    assert.equal((t.core.db.prepare('SELECT count(*) AS n FROM jev_calls').get() as { n: number }).n, 5_000, 'detailed records stay bounded');
    now += 24 * 3600_000;
    const next = t.owner.call('jev.test', {});
    await waitFor('next day request', () => t.responses.length === 2);
    t.answer(1);
    const tomorrow = await next;
    assert.equal(tomorrow.calls, 5_002);
    assert.equal(tomorrow.callsToday, 1, 'yesterday’s pruned calls never count toward today');
    assert.equal(tomorrow.costUsd, 210.084);
  } finally { await t.close(); }
});

test('a failed Jev call is offline even when its successful predecessor has the same timestamp', async () => {
  const t = await pendingJev(() => 1_700_000_000_000);
  try {
    const first = t.owner.call('jev.test', {});
    await waitFor('first request', () => t.responses.length === 1);
    t.answer(0);
    assert.equal((await first).online, true);
    const second = t.owner.call('jev.test', {});
    await waitFor('second request', () => t.responses.length === 2);
    t.answer(1, 401);
    const failed = await second;
    assert.equal(failed.online, false);
    assert.match(failed.lastError ?? '', /401/);
  } finally { await t.close(); }
});

test('turning Jev off prevents a busy response from being retried', async () => {
  const t = await pendingJev();
  try {
    const p = await t.owner.call('projects.add', { path: t.projectDir });
    await t.owner.call('cards.create', { projectId: p.id, type: 'task', title: 'Do not retry', status: 'inbox' });
    await waitFor('request', () => t.responses.length === 1);
    await t.owner.call('projects.update', { id: p.id, jev: 'off' });
    t.answer(0, 429);
    await waitFor('retry stopped or sent', () => !t.core.jev.busy || t.responses.length > 1);
    assert.equal(t.responses.length, 1);
    assert.equal(t.core.jev.busy, false);
  } finally { await t.close(); }
});

test('turning Jev off in one project leaves another project’s queued reads intact', async () => {
  const t = await pendingJev();
  try {
    const a = await t.owner.call('projects.add', { path: t.projectDir });
    const b = await t.owner.call('projects.add', { path: t.dir });
    const first = await t.owner.call('cards.create', { projectId: a.id, type: 'task', title: 'Turning off', status: 'inbox' });
    await t.owner.call('cards.create', { projectId: b.id, type: 'task', title: 'Still reading', status: 'inbox' });
    await t.owner.call('cards.create', { projectId: b.id, type: 'task', title: 'Still queued', status: 'inbox' });
    await waitFor('two requests', () => t.responses.length === 2);
    await t.owner.call('projects.update', { id: a.id, jev: 'off' });
    t.answer(0, 429);
    await waitFor('other project queued request or cancellation', async () => t.responses.length > 2
      || (await t.owner.call('cards.get', { id: first.id })).jev?.outcome === 'failed');
    assert.equal(t.responses.length, 3, 'a project switching Off must not drain another project’s queue');
  } finally { await t.close(); }
});

test('a Jev read is busy while its key is being checked, and clears when no key exists', async () => {
  const t = await testCore();
  try {
    const p = await t.owner.call('projects.add', { path: t.projectDir });
    const c = await t.owner.call('cards.create', { projectId: p.id, type: 'task', title: 'Pending key' });
    const pending = t.core.jev.read(c.id);
    assert.equal(t.core.jev.busy, true, 'idle core replacement must see a read before its key lookup finishes');
    await pending;
    assert.equal(t.core.jev.busy, false);
  } finally { await t.close(); }
});
