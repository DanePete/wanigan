// Jev when TypeSafe cannot be reached: the board never waits for it, the card
// says it was not read, and Jev shows as offline. And a test core never finds
// the owner's own key.
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { testCore, waitFor } from './test-support.ts';

/** A local port with nothing listening on it. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

test('with TypeSafe out of reach, a card is filed at once, says Jev could not read it, and Jev shows offline', async () => {
  const t = await testCore({ jev: { url: `http://127.0.0.1:${await closedPort()}/v1/systemone`, envKey: 'test-key', backoffMs: 1 } });
  try {
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    const card = await t.owner.call('cards.create', { projectId: project.id, type: 'bug', title: 'Checkout times out', status: 'inbox' });
    assert.equal(card.status, 'inbox', 'filed without waiting for Jev');
    const read = await waitFor('Jev gave up', async () => (await t.owner.call('cards.get', { id: card.id })).jev);
    assert.equal(read.outcome, 'failed');
    assert.match(read.error ?? '', /Could not reach TypeSafe/);
    const now = await t.owner.call('cards.get', { id: card.id });
    assert.deepEqual([now.status, now.priority], ['inbox', 2], 'nothing about the card was decided for it');
    const status = await t.owner.call('jev.status', {});
    assert.deepEqual([status.configured, status.online], ['env', false]);
    assert.match(status.lastError ?? '', /Could not reach TypeSafe/);
    assert.equal(status.costUsd, 0, 'nothing answered, nothing counted');
  } finally {
    await t.close();
  }
});

test('a test core never finds the owner’s Jev key', async () => {
  const inherited = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = 'what-the-owner-has';
  const t = await testCore();
  try {
    assert.equal((await t.owner.call('jev.status', {})).configured, null);
  } finally {
    if (inherited === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = inherited;
    await t.close();
  }
});
