import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { CODEX_UNCOUNTED } from './tokens.ts';
import { testCore, waitFor } from './test-support.ts';

const reply = (id: string, input: number, output: number, extra: object = {}) => `${JSON.stringify({
  type: 'assistant', message: { id, model: 'claude-opus-5-5', content: [{ type: 'text', text: 'ça marche ✓' }], usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 1000 } }, ...extra,
})}\n`;

test('a session’s tokens come from its own transcript, read as it grows', async () => {
  const t = await testCore();
  try {
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    const card = await t.owner.call('cards.create', { projectId: project.id, type: 'task', title: 'Count me' });
    const s = await t.owner.call('sessions.start', { projectId: project.id, provider: 'claude', cardId: card.id });
    assert.deepEqual(await t.owner.call('sessions.tokens', { id: s.id }), { usage: null, note: null });

    const folder = join(t.dir, 'home', '.claude', 'projects', t.projectDir.replace(/[^a-zA-Z0-9]/g, '-'));
    mkdirSync(folder, { recursive: true });
    const transcript = join(folder, `${s.conversationId}.jsonl`);
    writeFileSync(transcript, '{"type":"user","message":{"role":"user","content":"go"}}\n' + reply('m1', 10, 100) + reply('m1', 10, 100));
    let tokens = await t.owner.call('sessions.tokens', { id: s.id });
    assert.equal(tokens.usage?.requests, 1, 'two lines of one reply count once');
    assert.equal(tokens.usage?.context, 1010);

    // A line still being written is not counted until it is whole.
    const next = reply('m2', 20, 5);
    appendFileSync(transcript, next.slice(0, 40));
    assert.equal((await t.owner.call('sessions.tokens', { id: s.id })).usage?.requests, 1);
    appendFileSync(transcript, next.slice(40));
    tokens = await t.owner.call('sessions.tokens', { id: s.id });
    assert.equal(tokens.usage?.requests, 2);
    assert.equal(tokens.usage?.context, 1020, 'context is the latest request');

    // Subagents add to the total, never to context.
    const subagents = join(folder, s.conversationId as string, 'subagents');
    mkdirSync(subagents, { recursive: true });
    writeFileSync(join(subagents, 'agent-a1.jsonl'), reply('sub1', 5000, 50, { isSidechain: true }));
    tokens = await t.owner.call('sessions.tokens', { id: s.id });
    assert.equal(tokens.usage?.subagents, 1);
    assert.equal(tokens.usage?.input, 5030);
    assert.equal(tokens.usage?.context, 1020);

    // The card counts the conversation once, though two sessions ran it, and says what it could not count.
    await t.owner.call('sessions.stop', { id: s.id });
    await waitFor('ended', async () => (await t.owner.call('sessions.get', { id: s.id })).session.endedAt);
    const resumed = await t.owner.call('sessions.resume', { id: s.id });
    await t.owner.call('sessions.stop', { id: resumed.id });
    await waitFor('ended', async () => (await t.owner.call('sessions.get', { id: resumed.id })).session.endedAt);
    const codex = await t.owner.call('sessions.start', { projectId: project.id, provider: 'codex', cardId: card.id });
    assert.deepEqual(await t.owner.call('sessions.tokens', { id: codex.id }), { usage: null, note: CODEX_UNCOUNTED });
    const onCard = await t.owner.call('cards.tokens', { id: card.id });
    assert.equal(onCard.usage?.requests, 3);
    assert.equal(onCard.sessions, 2);
    assert.equal(onCard.uncounted, 1);
    await t.owner.call('sessions.stop', { id: codex.id });

    // A rewritten transcript is read again from the start.
    writeFileSync(transcript, reply('m9', 1, 1));
    assert.equal((await t.owner.call('sessions.tokens', { id: s.id })).usage?.requests, 2, 'm9 plus the subagent');
  } finally {
    await t.close();
  }
});
