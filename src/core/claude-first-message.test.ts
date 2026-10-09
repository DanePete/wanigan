// A message for a Claude session waits until Claude says it is at its prompt.
// Found in the real-app scenario run, and reported by the owner watching it
// ("it just sits at an empty terminal", "it shouldn't require a second
// message"): a message sent right after starting was typed in while Claude was
// still starting, so its text sat in Claude's input with the Enter lost; sent
// while Claude asked whether to trust the folder, its Enter chose "No, exit"
// and Claude quit. Both while the composer said "Queue".
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { testCore, waitFor } from './test-support.ts';

test('a message sent before Claude reports its prompt waits for it, then goes once', async () => {
  const t = await testCore();
  try {
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    const s = await t.owner.call('sessions.start', { projectId: project.id, provider: 'claude' });
    await waitFor('the stand-in up', () => t.core.sessions.replay(s.id).replay.includes('TOKEN='));

    // Starting, or asking whether to trust the folder: nothing reported yet.
    const { queued } = await t.owner.call('sessions.queue', { id: s.id, text: 'Reply with just the word ok.' });
    assert.equal(queued, 1, 'it waits, and the composer says so');
    await new Promise((r) => setTimeout(r, 400));
    assert.doesNotMatch(t.core.sessions.replay(s.id).replay, /Reply with just the word ok/, 'nothing is typed into a Claude that has not started');

    // Claude reports it is at its prompt: the message goes, once.
    t.core.sessions.hook(s.id, 'SessionStart', {});
    await waitFor('the message typed in', () => t.core.sessions.replay(s.id).replay.includes('Reply with just the word ok.'));
    assert.equal(t.core.sessions.pendingCount(s.id), 0);
    assert.equal((t.core.sessions.replay(s.id).replay.match(/Reply with just the word ok/g) ?? []).length, 1);
  } finally {
    await t.close();
  }
});

test('the wait does not end when the no-hooks fallback gives up on Claude reporting', async () => {
  const t = await testCore();
  try {
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    const s = await t.owner.call('sessions.start', { projectId: project.id, provider: 'claude' });
    await waitFor('the stand-in up', () => t.core.sessions.replay(s.id).replay.includes('TOKEN='));
    // As if Claude sat at its trust question past the fallback: state "running", still no hook.
    t.core.db.prepare("UPDATE sessions SET state = 'running', activity = 'No hook events received; live state unknown' WHERE id = ?").run(s.id);
    const { queued } = await t.owner.call('sessions.queue', { id: s.id, text: 'Start on the card.' });
    assert.equal(queued, 1);
    await new Promise((r) => setTimeout(r, 400));
    assert.doesNotMatch(t.core.sessions.replay(s.id).replay, /Start on the card/, 'an Enter would answer whatever question is on screen');
  } finally {
    await t.close();
  }
});
