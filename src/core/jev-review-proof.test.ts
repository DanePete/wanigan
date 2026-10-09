// Outcome evidence for stale reads, candidate selection and a refused waiting queue.
// Every answer comes from a held local HTTP fixture, never a model or real key.
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { test } from 'node:test';
import type { JevCardState } from '../shared/jev.ts';
import type { CardSummary } from '../shared/model.ts';
import { testCore, waitFor } from './test-support.ts';

async function heldJev() {
  const requests: { state: JevCardState; questions: Record<string, unknown> }[] = [];
  const responses: ServerResponse[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => { body += chunk; });
    req.on('end', () => { requests.push(JSON.parse(body)); responses.push(res); });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const t = await testCore({ jev: { url: `http://127.0.0.1:${port}`, envKey: 'local-test-key', backoffMs: 1 } });
  const answer = (index: number, status = 200): void => {
    responses[index]!.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify({
      model: 'test', usage: { input_tokens: 100 },
      answers: { action: { choice: 'ready', confidence: 0.99 }, severity: { score: 1 } },
    }));
  };
  return { ...t, requests, responses, answer, async close() {
    const settle = setInterval(() => {
      for (const [i, res] of responses.entries()) if (!res.writableEnded) answer(i);
    }, 10);
    try { await waitFor('held Jev settled', () => !t.core.jev.busy); } finally {
      clearInterval(settle);
      await t.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } };
}

for (const field of ['title', 'body', 'type', 'priority', 'criterion text'] as const) {
  test(`a held Jev acceptance preserves an owner's changed ${field} and leaves the card in Inbox`, async () => {
    const t = await heldJev();
    try {
      const p = await t.owner.call('projects.add', { path: t.projectDir });
      await t.owner.call('projects.update', { id: p.id, jev: 'off' });
      const c = await t.owner.call('cards.create', { projectId: p.id, type: 'task', title: 'Check the cart', body: 'Original description', priority: 2, status: 'inbox' });
      await t.owner.call('criteria.add', { cardId: c.id, text: 'The original cart works' });
      const before = await t.owner.call('cards.get', { id: c.id });
      await t.owner.call('projects.update', { id: p.id, jev: 'accept' });
      await t.owner.call('jev.read', { cardId: c.id });
      await waitFor('held request', () => t.requests.length === 1);
      assert.equal(t.requests[0]!.state.card.title, before.title);
      assert.equal(t.requests[0]!.state.card.description, before.body);
      assert.deepEqual(t.requests[0]!.state.card.criteria, before.criteria.map((x) => x.text));
      if (field === 'criterion text') await t.owner.call('criteria.update', { id: before.criteria[0]!.id, text: 'The replacement cart works' });
      else if (field === 'title') await t.owner.call('cards.update', { id: c.id, title: 'Check another cart' });
      else if (field === 'body') await t.owner.call('cards.update', { id: c.id, body: 'Replacement description' });
      else if (field === 'type') await t.owner.call('cards.update', { id: c.id, type: 'bug' });
      else await t.owner.call('cards.update', { id: c.id, priority: 0 });
      const changed = await t.owner.call('cards.get', { id: c.id });
      t.answer(0);
      await waitFor('held answer recorded', () => !t.core.jev.busy);
      const after = await t.owner.call('cards.get', { id: c.id });
      assert.equal(after.status, 'inbox');
      assert.equal(after.jev?.outcome, 'read');
      for (const key of ['title', 'body', 'type', 'priority', 'criteria'] as const) assert.deepEqual(after[key], changed[key], key);
      assert.equal(t.requests.length, 1, 'the proof uses the original held answer, not a fresh model read');
    } finally { await t.close(); }
  });
}

test('Jev sends exactly the five highest-overlap candidates from a larger real board', async () => {
  const t = await heldJev();
  try {
    const p = await t.owner.call('projects.add', { path: t.projectDir });
    await t.owner.call('projects.update', { id: p.id, jev: 'off' });
    const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'];
    const candidates: CardSummary[] = [];
    for (let n = 6; n >= 0; n--) candidates.push(await t.owner.call('cards.create', {
      projectId: p.id, type: 'task', title: n ? words.slice(0, n).join(' ') : 'unrelated zebra', body: 'PRIVATE_CANDIDATE_DESCRIPTION', status: 'ready',
    }));
    const c = await t.owner.call('cards.create', { projectId: p.id, type: 'task', title: words.join(' '), status: 'inbox' });
    await t.owner.call('projects.update', { id: p.id, jev: 'read' });
    await t.owner.call('jev.read', { cardId: c.id });
    await waitFor('candidate request', () => t.requests.length === 1);
    const sent = t.requests[0]!;
    assert.deepEqual(sent.state.candidates?.map((x) => x.key), candidates.slice(0, 5).map((x) => x.key));
    assert.equal(Object.keys(sent.questions).filter((key) => key.startsWith('dup_')).length, 5);
    assert.equal(JSON.stringify(sent).includes('PRIVATE_CANDIDATE_DESCRIPTION'), false);
    t.answer(0);
    await waitFor('candidate answer', () => !t.core.jev.busy);
    assert.equal((await t.owner.call('cards.get', { id: c.id })).jev?.outcome, 'read');
  } finally { await t.close(); }
});

test('a refused key drops three waiting reads while an admitted read settles and explicit retry recovers', async () => {
  const t = await heldJev();
  try {
    const p = await t.owner.call('projects.add', { path: t.projectDir });
    await t.owner.call('projects.update', { id: p.id, jev: 'off' });
    const cards: CardSummary[] = [];
    for (let i = 0; i < 5; i++) cards.push(await t.owner.call('cards.create', { projectId: p.id, type: 'task', title: `Held ${i}`, status: 'inbox' }));
    await t.owner.call('projects.update', { id: p.id, jev: 'read' });
    for (const card of cards) await t.owner.call('jev.read', { cardId: card.id });
    await waitFor('two admitted requests', () => t.responses.length === 2);
    t.answer(0, 401);
    await waitFor('refusal recorded', async () => (await t.owner.call('cards.get', { id: cards[0]!.id })).jev?.outcome === 'failed');
    t.answer(1);
    await waitFor('refused queue drained or unexpectedly sent', () => !t.core.jev.busy || t.requests.length > 2);
    assert.equal(t.requests.length, 2, 'none of the three waiting cards may be sent after the refusal');
    assert.equal(t.core.jev.busy, false);
    for (const card of cards.slice(2)) {
      const after = await t.owner.call('cards.get', { id: card.id });
      assert.equal(after.jev, null);
      assert.equal(after.status, 'inbox');
    }
    assert.equal((await t.owner.call('cards.get', { id: cards[1]!.id })).jev?.outcome, 'read');
    await t.owner.call('jev.read', { cardId: cards[2]!.id });
    await waitFor('explicit retry admitted', () => t.requests.length === 3);
    assert.equal(t.requests[2]!.state.card.key, cards[2]!.key);
    t.answer(2);
    await waitFor('explicit retry settled', () => !t.core.jev.busy);
    assert.equal((await t.owner.call('cards.get', { id: cards[2]!.id })).jev?.outcome, 'read');
    assert.equal(t.requests.length, 3, 'cleared waiting reads are not silently retried');
  } finally { await t.close(); }
});
