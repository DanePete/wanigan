// What Needs you raises and what settles each kind, on a real core: looking
// settles what only needed seeing, never what needs an answer; an idle agent at
// a fresh prompt asks nothing; old failures stop asking; and Codex's silence is
// never read as stuck.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CoreClient } from '../client/client.ts';
import { relay, testCore, tokenOf, waitFor } from './test-support.ts';

test('looking settles a finished turn; a permission request, a review and a question wait for their answer', async () => {
  let clock = Date.now();
  const t = await testCore({ now: () => clock });
  try {
    const { owner, core } = t;
    const project = await owner.call('projects.add', { path: t.projectDir });
    const needsOf = async (sessionId: string) => (await owner.call('needs.list', {})).filter((n) => n.sessionId === sessionId).map((n) => n.kind);

    // At a fresh prompt an agent has asked for nothing.
    const asking = await owner.call('sessions.start', { projectId: project.id, provider: 'claude' });
    const token = await tokenOf(core, asking.id);
    await relay(core, token, 'SessionStart', {});
    assert.equal((await owner.call('sessions.get', { id: asking.id })).session.state, 'waiting');
    assert.deepEqual(await needsOf(asking.id), [], 'idle is not a need until a turn has finished');

    await relay(core, token, 'UserPromptSubmit', {});
    await relay(core, token, 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'rm -rf dist' } });
    await owner.call('sessions.seen', { id: asking.id });
    assert.deepEqual(await needsOf(asking.id), ['permission'], 'looking does not answer it');

    const card = await owner.call('cards.create', { projectId: project.id, type: 'task', title: 'Review me' });
    await owner.call('cards.evidence', { id: card.id, evidence: { kind: 'note', value: 'done' } });
    await owner.call('cards.move', { id: card.id, status: 'review' });
    const cardNeeds = async () => (await owner.call('needs.list', {})).filter((n) => n.cardId === card.id).map((n) => n.kind);
    const worker = await owner.call('sessions.start', { projectId: project.id, provider: 'claude', cardId: card.id });
    const workerToken = await tokenOf(core, worker.id);
    await owner.call('sessions.seen', { id: worker.id });
    assert.deepEqual(await cardNeeds(), ['review'], 'a review is settled by approving or sending back, not by looking');
    await owner.call('cards.sendBack', { id: card.id, note: 'Add the empty state' });
    assert.deepEqual(await cardNeeds(), []);

    // A question, from the agent through its own token, stands until the owner answers on the card.
    await relay(core, workerToken, 'SessionStart', {});
    const agent = await CoreClient.connect(core.paths.socket, workerToken);
    await agent.call('cards.ask', { id: card.id, question: 'Which empty state?' });
    await owner.call('sessions.seen', { id: worker.id });
    assert.deepEqual(await cardNeeds(), ['question']);
    await owner.call('cards.comment', { id: card.id, body: 'The one on the cart page.' });
    assert.deepEqual(await cardNeeds(), []);
    agent.close();

    // A finished turn is news until seen; the next one is news again.
    clock += 1_000;
    await relay(core, workerToken, 'UserPromptSubmit', {});
    await relay(core, workerToken, 'Stop', {});
    assert.deepEqual(await needsOf(worker.id), ['waiting']);
    clock += 1_000;
    await owner.call('sessions.seen', { id: worker.id });
    assert.deepEqual(await needsOf(worker.id), []);
    clock += 1_000;
    await relay(core, workerToken, 'UserPromptSubmit', {});
    await relay(core, workerToken, 'Stop', {});
    assert.deepEqual(await needsOf(worker.id), ['waiting'], 'the next finished turn is news again');

    for (const s of [asking, worker]) await owner.call('sessions.stop', { id: s.id });
  } finally {
    await t.close();
  }
});

test('a failure stops asking after three days; Codex going quiet while it works is never raised', async () => {
  let clock = Date.now();
  const t = await testCore({ now: () => clock });
  try {
    const { owner, core } = t;
    const project = await owner.call('projects.add', { path: t.projectDir });
    const shell = await owner.call('sessions.start', { projectId: project.id, provider: 'shell' });
    await owner.call('sessions.input', { id: shell.id, data: 'exit 3\n' });
    await waitFor('failed', async () => (await owner.call('sessions.get', { id: shell.id })).session.state === 'failed');
    const failed = async () => (await owner.call('needs.list', {})).find((n) => n.sessionId === shell.id);
    assert.equal((await failed())?.detail, 'Exited with code 3');
    clock += 3 * 24 * 60 * 60_000 + 60_000;
    assert.equal(await failed(), undefined, 'an old failure is history, not news');

    const codex = await owner.call('sessions.start', { projectId: project.id, provider: 'codex' });
    await waitFor('ready', () => core.sessions.replay(codex.id).replay.includes('codex ready'));
    await owner.call('sessions.input', { id: codex.id, data: 'done\r' });
    // Its own report, not the "waiting" its first drawing implied: until Codex has said
    // something itself, a typed line is not taken for a prompt (it could be a trust answer).
    await waitFor('waiting, by Codex’s own report', async () => {
      const { session, events } = await owner.call('sessions.get', { id: codex.id });
      return session.state === 'waiting' && events.some((e) => e.event === 'Stop');
    });
    await owner.call('sessions.input', { id: codex.id, data: 'refactor the search\r' });
    await waitFor('working', async () => (await owner.call('sessions.get', { id: codex.id })).session.state === 'working');
    clock += 45 * 60_000;
    assert.ok(!(await owner.call('needs.list', {})).some((n) => n.sessionId === codex.id && n.kind === 'quiet'),
      'Codex does not report while it works, so its silence is not evidence');
    await owner.call('sessions.stop', { id: codex.id });
  } finally {
    await t.close();
  }
});
