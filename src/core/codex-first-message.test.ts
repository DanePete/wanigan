// Codex draws its folder-trust question before it reports any lifecycle event.
// Terminal output alone is never proof that Enter would submit a message.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { testCore, waitFor } from './test-support.ts';

test('the Codex composer refuses before lifecycle evidence, then delivers after a turn', async () => {
  const t = await testCore();
  try {
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    const s = await t.owner.call('sessions.start', { projectId: project.id, provider: 'codex' });
    await waitFor('the stand-in has drawn its first screen', () => t.core.sessions.replay(s.id).replay.includes('codex ready'));
    await assert.rejects(t.owner.call('sessions.queue', { id: s.id, text: 'Start working now.' }), /first message in the Codex terminal/);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.doesNotMatch(t.core.sessions.replay(s.id).replay, /Start working now/, 'nothing answers a startup question');
    assert.equal(t.core.sessions.pendingCount(s.id), 0, 'a refused message was not silently queued');

    // The owner handles startup in the terminal. The stand-in reports a turn
    // ending through the same OSC 9 path the actual Codex TUI uses.
    await t.owner.call('sessions.input', { id: s.id, data: 'done\r' });
    await waitFor('the turn completed', () => t.core.sessions.events(s.id).some((e) => e.event === 'Stop'));
    await t.owner.call('sessions.queue', { id: s.id, text: 'Now continue.' });
    await waitFor('the later message', () => t.core.sessions.replay(s.id).replay.includes('Now continue.'));
    assert.equal(t.core.sessions.pendingCount(s.id), 0);
  } finally {
    await t.close();
  }
});
