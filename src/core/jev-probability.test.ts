// A real card outcome from a local synthetic HTTP answer, never a model/key.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { testCore, waitFor } from './test-support.ts';

const cases: readonly [string, unknown, boolean][] = [
  ['confidence 1.01', 1.01, false], ['confidence 2', 2, false], ['negative confidence', -0.01, false],
  ['numeric string confidence', '0.99', false], ['missing confidence', undefined, false],
  ['zero confidence', 0, false], ['just below the accept threshold', 0.8 - Number.EPSILON, false],
  ['the accept threshold', 0.8, true], ['confidence one', 1, true],
];

for (const [name, confidence, accepted] of cases) {
  test(`${name} preserves the correct real Inbox outcome with one accounted HTTP call`, async (context) => {
    let requests = 0;
    const server = createServer((req, res) => {
      assert.equal(req.headers.authorization, 'Bearer fixture-only-key');
      req.resume();
      req.on('end', () => {
        requests++;
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
          model: 'fixture', usage: { input_tokens: 1_000_000 }, answers: {
            action: { choice: 'ready', confidence, probabilities: { ready: confidence, later: 0.1 } },
            severity: { score: 4 },
          },
        }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const t = await testCore({ jev: { url: `http://127.0.0.1:${port}`, envKey: 'fixture-only-key', backoffMs: 1 } });
    try {
      const p = await t.owner.call('projects.add', { path: t.projectDir });
      await t.owner.call('projects.update', { id: p.id, jev: 'off' });
      const card = await t.owner.call('cards.create', { projectId: p.id, type: 'task', title: 'Check the checkout coupon', status: 'inbox' });
      await t.owner.call('criteria.add', { cardId: card.id, text: 'A valid coupon applies its documented discount' });
      await t.owner.call('projects.update', { id: p.id, jev: 'accept' });
      await t.owner.call('jev.read', { cardId: card.id });
      await waitFor('synthetic answer recorded', async () => (await t.owner.call('cards.get', { id: card.id })).jev);
      await waitFor('synthetic call settled', () => !t.core.jev.busy);
      const after = await t.owner.call('cards.get', { id: card.id });
      context.diagnostic(`${name}: card ${after.status}, Jev outcome ${after.jev?.outcome}, confidence ${String(after.jev?.confidence)}`);
      assert.equal(after.status, accepted ? 'ready' : 'inbox');
      assert.equal(after.jev?.outcome, accepted ? 'accepted' : 'read');
      const valid = typeof confidence === 'number' && confidence >= 0 && confidence <= 1;
      assert.equal(after.jev?.confidence, valid ? confidence : null);
      assert.deepEqual(after.jev?.probabilities, valid ? { ready: confidence, later: 0.1 } : { later: 0.1 });
      assert.equal(after.jev?.severity, 3, 'severity still clamps to its separate scale');
      assert.equal(after.activity.some((a) => a.actor === 'jev' && a.verb === 'accepted it to Ready'), accepted);
      assert.equal(requests, 1, 'an invalid probability never causes a retry or another billable attempt');
      const status = await t.owner.call('jev.status', {});
      assert.equal(status.calls, 1);
      assert.equal(status.errors, 0);
      assert.equal(status.online, true);
      assert.equal(status.unknownUsageCalls, 0);
      assert.equal(status.costUsd, 0.042);
      const stored = t.core.db.prepare('SELECT ok, input_tokens, usage_known FROM jev_calls').all();
      assert.deepEqual(stored, [{ ok: 1, input_tokens: 1_000_000, usage_known: 1 }]);
    } finally {
      await t.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}
