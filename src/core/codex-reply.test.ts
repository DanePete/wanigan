// Replying to Codex from Needs you, end to end through the real hook relay and
// the stand-in Codex: offered once Codex's own hooks report, because its
// UserPromptSubmit then says the message started a turn; refused, with the
// reason, while only its OSC 9 notifications report. Payloads are shaped as
// codex-cli 0.155.1 sent them to a hook (seen against the real binary with a
// stand-in model provider; no model was called).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CoreClient } from '../client/client.ts';
import { CODEX_NOTIFICATIONS_ONLY, replyRoute } from '../shared/attention.ts';
import { LIVE_STATES, type Need, type Session } from '../shared/model.ts';
import { codexWithToken, relay, stubProbe, testCore, tokenOf, waitFor } from './test-support.ts';

const THREAD = '01a120fa-e685-78f1-8daa-555ddf8d9231';
const route = (need: Need | undefined, s: Session) => replyRoute(need ?? { kind: 'waiting', sessionId: null },
  { provider: s.provider, state: s.state, live: LIVE_STATES.has(s.state), relayed: s.relayed });

test('Needs you replies to a Codex whose hooks report, and the row clears on its own UserPromptSubmit', async () => {
  const t = await testCore({ codexHookProbe: stubProbe(), launcher: codexWithToken });
  try {
    const { owner, core } = t;
    const project = await owner.call('projects.add', { path: t.projectDir });
    const s = await owner.call('sessions.start', { projectId: project.id, provider: 'codex' });
    const token = await tokenOf(core, s.id);
    const get = async () => (await owner.call('sessions.get', { id: s.id })).session;
    const waiting = async () => (await owner.call('needs.list', {})).find((n) => n.sessionId === s.id && n.kind === 'waiting');
    await waitFor('at its prompt', async () => (await get()).state === 'waiting');
    assert.equal((await get()).relayed, false, 'nothing has come through the relay yet');

    const base = { session_id: THREAD, transcript_path: null, cwd: t.projectDir, model: 'gpt-5.5', permission_mode: 'default' };
    let turn = 0;
    const prompt = (text: string) => relay(core, token, 'UserPromptSubmit', { ...base, hook_event_name: 'UserPromptSubmit', turn_id: `01a120fa-ec5d-7fd2-9591-00000000000${++turn}`, prompt: text });
    const stop = () => relay(core, token, 'Stop', { ...base, hook_event_name: 'Stop', turn_id: `01a120fa-ec5d-7fd2-9591-00000000000${turn}`, stop_hook_active: false, last_assistant_message: 'Done.' });
    await relay(core, token, 'SessionStart', { ...base, hook_event_name: 'SessionStart', source: 'startup' });
    await prompt('Fix the coupon field');
    await stop();
    const finished = await get();
    assert.equal(finished.relayed, true, 'its own hooks report: the window can see it');
    const need = await waiting();
    assert.ok(need, 'a finished turn needs you');
    assert.deepEqual(route(need, finished), { ok: true }, 'Reply is offered');

    // Sent at once (it is idle), through the composer's queue, typed in as a paste.
    const { queued } = await owner.call('sessions.queue', { id: s.id, text: 'Also cover the empty cart' });
    assert.equal(queued, 0);
    await waitFor('delivery', () => core.sessions.replay(s.id).replay.includes('Also cover the empty cart'));
    assert.equal(core.sessions.pendingCount(s.id), 0);
    assert.ok(await waiting(), 'sent is not started: the row stands until Codex says so');
    assert.equal((await get()).state, 'waiting', 'nothing is assumed from the keystrokes');

    await prompt('Also cover the empty cart');
    assert.equal(await waiting(), undefined, 'Codex said the message started its turn');
    assert.equal((await get()).state, 'working');

    // While it works, a reply waits for the turn to end, then goes.
    assert.equal((await owner.call('sessions.queue', { id: s.id, text: 'and the README' })).queued, 1);
    await new Promise((r) => setTimeout(r, 150));
    assert.doesNotMatch(core.sessions.replay(s.id).replay, /and the README/, 'not typed into a working turn');
    await stop();
    await waitFor('held reply delivered', () => core.sessions.replay(s.id).replay.includes('and the README'));
    await owner.call('sessions.stop', { id: s.id });
  } finally {
    await t.close();
  }
});

test('a question a Codex with hooks asked is answered from Needs you: on its card, and to Codex when it is idle', async () => {
  const t = await testCore({ codexHookProbe: stubProbe(), launcher: codexWithToken });
  try {
    const { owner, core } = t;
    const project = await owner.call('projects.add', { path: t.projectDir });
    const card = await owner.call('cards.create', { projectId: project.id, type: 'task', title: 'Free shipping banner' });
    const s = await owner.call('sessions.start', { projectId: project.id, provider: 'codex', cardId: card.id });
    const token = await tokenOf(core, s.id);
    const base = { session_id: THREAD, transcript_path: null, cwd: t.projectDir, model: 'gpt-5.5', permission_mode: 'default' };
    await relay(core, token, 'SessionStart', { ...base, hook_event_name: 'SessionStart', source: 'startup' });
    await relay(core, token, 'UserPromptSubmit', { ...base, hook_event_name: 'UserPromptSubmit', turn_id: 't1', prompt: 'go' });

    // The agent asks through the `wanigan` command (its session token), as Claude does.
    const agent = await CoreClient.connect(core.paths.socket, token);
    await agent.call('cards.ask', { id: card.id, question: 'Cart drawer too, or only the cart page?' });
    agent.close();
    const question = (await owner.call('needs.list', {})).find((n) => n.kind === 'question' && n.cardId === card.id);
    assert.equal(question?.sessionId, s.id);
    assert.deepEqual(route(question, (await owner.call('sessions.get', { id: s.id })).session), { ok: true });

    // What Needs you does with the answer: on the card (which settles it), then to Codex.
    await owner.call('cards.comment', { id: card.id, body: 'Both.' });
    assert.ok(!(await owner.call('needs.list', {})).some((n) => n.kind === 'question'), 'the answer on the card settles it');
    assert.equal((await owner.call('sessions.queue', { id: s.id, text: `The owner answered your question on ${card.key}: Both.` })).queued, 1, 'Codex is mid-turn: it waits');
    await relay(core, token, 'Stop', { ...base, hook_event_name: 'Stop', turn_id: 't1', stop_hook_active: false, last_assistant_message: 'Waiting on the owner.' });
    await waitFor('the answer reaches Codex at its prompt', () => core.sessions.replay(s.id).replay.includes('answered your question'));
    await owner.call('sessions.stop', { id: s.id });
  } finally {
    await t.close();
  }
});

test('a Codex read only from its notifications offers no Reply, and says why', async () => {
  const t = await testCore();
  try {
    const { owner, core } = t;
    const project = await owner.call('projects.add', { path: t.projectDir });
    const s = await owner.call('sessions.start', { projectId: project.id, provider: 'codex' });
    await waitFor('drawn', () => core.sessions.replay(s.id).replay.includes('codex ready'));
    // The owner's first message, in the terminal; the stand-in ends the turn with OSC 9.
    await owner.call('sessions.input', { id: s.id, data: 'done\r' });
    await waitFor('the turn ended', () => core.sessions.events(s.id).some((e) => e.event === 'Stop'));
    const session = (await owner.call('sessions.get', { id: s.id })).session;
    const need = (await owner.call('needs.list', {})).find((n) => n.sessionId === s.id && n.kind === 'waiting');
    assert.ok(need);
    assert.equal(session.relayed, false);
    assert.deepEqual(route(need, session), { ok: false, why: CODEX_NOTIFICATIONS_ONLY });
    await owner.call('sessions.stop', { id: s.id });
  } finally {
    await t.close();
  }
});
