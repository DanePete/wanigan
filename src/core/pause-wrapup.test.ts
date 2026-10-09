// Pausing asks each live agent to wrap up. Found in the real-app scenario run:
// every agent was told to record where things stand with `wanigan note
// <card>`, and one holding no card could not (the note is refused, "Claim it
// first") nor claim one (the pause blocks claims). An agent is now asked only
// what it can do: a note on the card it holds, or else just to stop.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { testCore, waitFor } from './test-support.ts';

test('the wrap-up names the card an agent holds, and asks no note of one that holds none', async () => {
  const t = await testCore();
  try {
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    const card = await t.owner.call('cards.create', { projectId: project.id, type: 'feature', title: 'Free shipping hint', status: 'ready' });
    const holder = await t.owner.call('sessions.start', { projectId: project.id, provider: 'claude', cardId: card.id });
    const loose = await t.owner.call('sessions.start', { projectId: project.id, provider: 'claude' });
    for (const s of [holder, loose]) {
      t.core.sessions.hook(s.id, 'SessionStart', {});
      t.core.sessions.hook(s.id, 'UserPromptSubmit', {});
    }
    assert.equal((await t.owner.call('cards.get', { id: card.id })).claim?.sessionId, holder.id);

    const { asked } = await t.owner.call('projects.pause', { id: project.id });
    assert.equal(asked, 2);
    for (const s of [holder, loose]) t.core.sessions.hook(s.id, 'Stop', {});
    const told = (id: string) => waitFor('the wrap-up typed in', () => {
      const replay = t.core.sessions.replay(id).replay;
      return replay.includes('The owner has paused this project') ? replay.slice(replay.indexOf('The owner has paused')) : null;
    });
    assert.match(await told(holder.id), new RegExp(`wanigan note ${card.key} `), 'the holder notes its own card');
    const looseTold = await told(loose.id);
    assert.doesNotMatch(looseTold, /wanigan note/, 'an agent with no card is not asked for a note it cannot write');
    assert.match(looseTold, /Finish the step you are on and stop/);
  } finally {
    await t.close();
  }
});
