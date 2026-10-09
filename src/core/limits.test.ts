// A session stopped by its account's usage limit, end to end: the real hook
// relay, Needs you, and carrying the conversation on under another account.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { relay, testCore, tokenOf, waitFor } from './test-support.ts';

const HIT = 'You\'ve hit your session limit · resets 4:10pm (America/Chicago)';

test('a usage limit is its own need, and the conversation carries on under another account with its card', async () => {
  let clock = Date.UTC(2026, 9, 6, 18, 0); // 1:00 pm in Chicago
  const t = await testCore({ now: () => clock });
  try {
    const { owner, core } = t;
    const project = await owner.call('projects.add', { path: t.projectDir });
    const card = await owner.call('cards.create', { projectId: project.id, type: 'task', title: 'Checkout accessibility' });
    const work = await owner.call('accounts.add', { provider: 'claude', label: 'Work' });
    const old = await owner.call('sessions.start', { projectId: project.id, provider: 'claude', cardId: card.id });
    const token = await tokenOf(core, old.id);
    const state = async (id: string) => (await owner.call('sessions.get', { id })).session;

    await relay(core, token, 'SessionStart', {});
    await relay(core, token, 'UserPromptSubmit', { prompt: 'go' });
    await relay(core, token, 'StopFailure', { hook_event_name: 'StopFailure', error: 'rate_limit', last_assistant_message: HIT });
    const limited = await state(old.id);
    assert.equal(limited.state, 'limited', 'not a finished turn');
    assert.equal(limited.activity, HIT);
    assert.equal(limited.limit?.resetsAt, Date.UTC(2026, 9, 6, 21, 10), 'the reset Claude named, in its zone');
    let need = (await owner.call('needs.list', {})).find((n) => n.sessionId === old.id);
    assert.equal(need?.kind, 'limit');
    assert.equal(need?.accountId, old.accountId);
    assert.match(need?.detail ?? '', /^Hit its usage limit on Default\. Resets \d{1,2}:\d{2} [ap]m\.$/);

    await relay(core, token, 'Notification', { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' });
    assert.equal((await state(old.id)).state, 'limited', 'sitting idle does not lift a limit');

    // Waiting for the reset settles the need, until Claude says the reset came.
    await owner.call('sessions.seen', { id: old.id });
    assert.ok(!(await owner.call('needs.list', {})).some((n) => n.sessionId === old.id));
    clock += 4 * 3600_000;
    await relay(core, token, 'Notification', { notification_type: 'quota_auto_resume_stale', message: 'Usage limit reset — press enter to continue' });
    need = (await owner.call('needs.list', {})).find((n) => n.sessionId === old.id);
    assert.match(need?.detail ?? '', /The limit has reset: press Enter/);

    // Continuing needs the transcript Claude saved under the old account's folder.
    await assert.rejects(owner.call('sessions.continueOn', { id: old.id, accountId: work.id }), /not saved this conversation/);
    const folder = join(t.dir, 'home', '.claude', 'projects', t.projectDir.replace(/[^a-zA-Z0-9]/g, '-'));
    mkdirSync(folder, { recursive: true });
    const transcript = join(folder, `${old.conversationId}.jsonl`);
    writeFileSync(transcript, '{"type":"user"}\n');
    await assert.rejects(owner.call('sessions.continueOn', { id: old.id, accountId: old.accountId as string }), /already on Default/);

    const next = await owner.call('sessions.continueOn', { id: old.id, accountId: work.id });
    assert.equal(next.accountId, work.id);
    assert.equal(next.cardId, card.id);
    assert.notEqual(next.conversationId, old.conversationId, 'a fork gets its own id');
    const shown = await waitFor('new args', () => core.sessions.replay(next.id).replay.match(/CFG=(\S+) ARGS=(.*)/));
    assert.equal(shown[1], work.configDir, 'it runs as the other account');
    assert.match(shown[2] ?? '', new RegExp(`--resume ${transcript.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} --fork-session --session-id ${next.conversationId}`));

    await waitFor('old stopped', async () => (await state(old.id)).state === 'ended');
    assert.equal((await state(old.id)).activity, 'Continued on Work');
    const after = await owner.call('cards.get', { id: card.id });
    assert.equal(after.claim?.sessionId, next.id, 'the claim moved to the new session');
    assert.equal(after.status, 'working');
    const verbs = after.activity.map((a) => a.verb);
    assert.ok(verbs.includes('handed the claim to the session that continues the work'));
    assert.ok(verbs.includes('continued the conversation on another account'));
    assert.ok(!verbs.includes('released the claim'), 'the card was never free in between');
    assert.ok(!(await owner.call('needs.list', {})).some((n) => n.kind === 'limit'), 'nothing is limited any more');
    await owner.call('sessions.stop', { id: next.id });
  } finally {
    await t.close();
  }
});
