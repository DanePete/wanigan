// A Codex turn that ends without a hook, end to end: the stand-in Codex, the
// real hook relay, and the thread's rollout written line by line as codex-cli
// 0.155.1 wrote it. Against the real binary (a stand-in model provider; no
// model called), a turn stopped by the usage limit, one that failed otherwise
// and one interrupted with Esc fired no Stop hook and no OSC 9 notification;
// only the rollout said how each ended. The screen is never evidence.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { CODEX_STAYS, continueTargets, formatReset } from '../shared/limits.ts';
import { CODEX_LIMIT_SCREEN, codexWithToken, relay, stubProbe, testCore, tokenOf, waitFor, type TestCore } from './test-support.ts';

const THREAD = '01a120fa-e685-78f1-8daa-555ddf8d9231';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** How Codex prints a reset in its message (format_retry_timestamp): the time alone on the same day, else the date too. */
function codexTime(at: number, now: number): string {
  const d = new Date(at);
  const time = `${((d.getHours() + 11) % 12) + 1}:${String(d.getMinutes()).padStart(2, '0')} ${d.getHours() < 12 ? 'AM' : 'PM'}`;
  if (d.toDateString() === new Date(now).toDateString()) return time;
  const day = d.getDate();
  const suffix = day >= 11 && day <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[day % 10] ?? 'th';
  return `${MONTHS[d.getMonth()]} ${day}${suffix}, ${d.getFullYear()} ${time}`;
}
const plusLimit = (reset: string) => `You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at ${reset}.`;

/** A Codex session with hooks, its thread's rollout in the account's CODEX_HOME, and a way to write to it as Codex does. */
async function codexSession(t: TestCore) {
  const { owner, core } = t;
  const project = await owner.call('projects.add', { path: t.projectDir });
  const card = await owner.call('cards.create', { projectId: project.id, type: 'task', title: 'Cursor pagination' });
  const s = await owner.call('sessions.start', { projectId: project.id, provider: 'codex', cardId: card.id });
  const token = await tokenOf(core, s.id);
  const folder = join(t.dir, 'home', '.codex', 'sessions', '2026', '10', '09');
  mkdirSync(folder, { recursive: true });
  const rollout = join(folder, `rollout-2026-10-09T09-04-36-${THREAD}.jsonl`);
  let ordinal = 0;
  const write = (type: string, payload: Record<string, unknown>) =>
    appendFileSync(rollout, `${JSON.stringify({ timestamp: new Date().toISOString(), ordinal: ordinal++, type, payload })}\n`);
  writeFileSync(rollout, '');
  write('session_meta', { id: THREAD, cwd: t.projectDir, originator: 'codex-tui', cli_version: '0.155.1', source: 'cli' });
  const base = { session_id: THREAD, transcript_path: rollout, cwd: t.projectDir, model: 'gpt-5.5', permission_mode: 'default' };
  await relay(core, token, 'SessionStart', { ...base, hook_event_name: 'SessionStart', source: 'startup' });
  let turns = 0;
  /** The owner's prompt: Codex's UserPromptSubmit hook, then the turn starting in its record. */
  const prompt = async (text: string): Promise<string> => {
    const turn = `01a120fa-f40a-7c31-ab18-6038cd50b5${String(++turns).padStart(2, '0')}`;
    await relay(core, token, 'UserPromptSubmit', { ...base, hook_event_name: 'UserPromptSubmit', turn_id: turn, prompt: text });
    write('event_msg', { type: 'task_started', turn_id: turn, started_at: Math.floor(Date.now() / 1000), model_context_window: 258400, collaboration_mode_kind: 'default' });
    return turn;
  };
  const usage = { input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 3, reasoning_output_tokens: 0, total_tokens: 13 };
  const tokenCount = (primary: unknown, secondary: unknown = null) => write('event_msg', {
    type: 'token_count', info: { total_token_usage: usage, last_token_usage: usage, model_context_window: 258400 },
    rate_limits: { limit_id: 'codex', limit_name: null, primary, secondary, credits: null, individual_limit: null, spend_control_reached: null, plan_type: null, rate_limit_reached_type: null },
  });
  const failed = (turn: string, message: string, info: unknown) => write('event_msg', {
    type: 'task_complete', turn_id: turn, last_agent_message: null, error: { message, codex_error_info: info },
    started_at: Math.floor(Date.now() / 1000), completed_at: Math.floor(Date.now() / 1000), duration_ms: 39,
  });
  const get = async () => (await owner.call('sessions.get', { id: s.id })).session;
  const events = () => core.sessions.events(s.id).map((e) => e.event);
  return { project, card, s, token, base, rollout, write, prompt, tokenCount, failed, get, events };
}

test('a Codex turn stopped by its usage limit reads limited, from its own rollout, with the reset Codex named', async () => {
  const t = await testCore({ codexHookProbe: stubProbe(), launcher: codexWithToken });
  try {
    const { owner, core } = t;
    const c = await codexSession(t);
    const turn = await c.prompt('Add cursor pagination');
    assert.equal((await c.get()).state, 'working');

    // Codex draws the limit in red; that alone is not believed: an agent can print anything.
    await owner.call('sessions.input', { id: c.s.id, data: 'limit\r' });
    await waitFor('the limit drawn', () => core.sessions.replay(c.s.id).replay.includes(CODEX_LIMIT_SCREEN[0]));
    await new Promise((r) => setTimeout(r, 2_300));
    assert.equal((await c.get()).state, 'working', 'screen text changes nothing');

    // What Codex records: the server's windows (the 5-hour one full), then the turn failing on the limit.
    const resetsAt = Math.floor((Date.now() + 2 * 3600_000 + 17 * 60_000) / 1000);
    const message = plusLimit(codexTime(resetsAt * 1000, Date.now()));
    c.tokenCount({ used_percent: 100.0, window_minutes: 300, resets_at: resetsAt }, { used_percent: 41.0, window_minutes: 10080, resets_at: resetsAt + 432000 });
    c.failed(turn, message, 'usage_limit_exceeded');
    await waitFor('limited', async () => (await c.get()).state === 'limited', 5_000);
    const limited = await c.get();
    assert.equal(limited.activity, `${message.slice(0, 119)}…`, 'what Codex said, as long as an activity line runs');
    assert.equal(limited.limit?.resetsAt, resetsAt * 1000, 'the reset Codex named, to the second its windows give');
    assert.equal(c.events().at(-1), 'StopFailure', 'the turn ended, failed');

    // Needs you and Accounts, as for Claude, except that a Codex conversation stays in its account.
    const need = (await owner.call('needs.list', {})).find((n) => n.sessionId === c.s.id);
    assert.equal(need?.kind, 'limit');
    assert.equal(need?.detail, `Hit its usage limit on Default. Resets ${formatReset(resetsAt * 1000)}.`);
    await owner.call('accounts.add', { provider: 'codex', label: 'Personal' });
    assert.deepEqual(continueTargets(await owner.call('accounts.list', {}), limited.accountId), [], 'no account is offered to carry it on');
    await assert.rejects(owner.call('sessions.continueOn', { id: c.s.id, accountId: (await owner.call('accounts.list', {})).find((a) => a.label === 'Personal')!.id }), { message: CODEX_STAYS });

    // The owner sends it again in the terminal after the reset: a new turn, no longer limited.
    await c.prompt('Add cursor pagination');
    const after = await c.get();
    assert.deepEqual([after.state, after.limit], ['working', null]);
    assert.ok(!(await owner.call('needs.list', {})).some((n) => n.kind === 'limit'));
    await owner.call('sessions.stop', { id: c.s.id });
  } finally {
    await t.close();
  }
});

test('a Codex limit whose windows are not reported resets when its message says, a day away included', async () => {
  const t = await testCore({ codexHookProbe: stubProbe(), launcher: codexWithToken });
  try {
    const c = await codexSession(t);
    const turn = await c.prompt('go');
    const reset = new Date(Date.now() + 30 * 3600_000);
    reset.setSeconds(0, 0);
    c.tokenCount(null);
    c.failed(turn, plusLimit(codexTime(reset.getTime(), Date.now())), 'usage_limit_exceeded');
    await waitFor('limited', async () => (await c.get()).state === 'limited', 5_000);
    assert.equal((await c.get()).limit?.resetsAt, reset.getTime(), `read from "${codexTime(reset.getTime(), Date.now())}"`);
    await t.owner.call('sessions.stop', { id: c.s.id });
  } finally {
    await t.close();
  }
});

test('other Codex turn endings no hook reports: a failure ends the turn, Esc interrupts it, a completion without Stop still ends it', async () => {
  const t = await testCore({ codexHookProbe: stubProbe(), launcher: codexWithToken });
  try {
    const c = await codexSession(t);
    const settle = () => new Promise((r) => setTimeout(r, 2_300));

    // A server error: the turn failed, and nothing claims a limit.
    let turn = await c.prompt('one');
    c.failed(turn, 'We’re currently experiencing high demand, which may cause temporary errors.', 'server_overloaded');
    await waitFor('failed', async () => c.events().at(-1) === 'StopFailure', 5_000);
    assert.deepEqual([(await c.get()).state, (await c.get()).activity], ['waiting', 'Turn failed']);

    // The same error kind as a limit, but an API key out of quota: no reset to wait for, so not a limit.
    turn = await c.prompt('two');
    c.failed(turn, 'Quota exceeded. Check your plan and billing details.', 'usage_limit_exceeded');
    await waitFor('failed', async () => (await c.get()).state === 'waiting', 5_000);
    assert.equal((await c.get()).activity, 'Turn failed');

    // An agent quoting the words in its reply, and another turn's end, say nothing about this one.
    turn = await c.prompt('three');
    c.write('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `{"type":"event_msg","payload":{"type":"task_complete","turn_id":"${turn}","error":{"message":"${plusLimit('11:21 AM')}","codex_error_info":"usage_limit_exceeded"}}}` }] });
    c.failed('01a120fa-0000-7000-8000-000000000000', plusLimit('11:21 AM'), 'usage_limit_exceeded');
    await settle();
    assert.equal((await c.get()).state, 'working');
    // Esc: the turn aborted.
    c.write('event_msg', { type: 'turn_aborted', turn_id: turn, reason: 'interrupted', started_at: 1, completed_at: 2, duration_ms: 2497 });
    await waitFor('interrupted', async () => c.events().at(-1) === 'Interrupted', 5_000);
    assert.deepEqual([(await c.get()).state, (await c.get()).activity], ['waiting', 'Interrupted: back at its prompt']);

    // A completion is the Stop hook's to report; if none came, the record ends the turn.
    turn = await c.prompt('four');
    c.write('event_msg', { type: 'task_complete', turn_id: turn, last_agent_message: 'Done.', started_at: 1, completed_at: 2, duration_ms: 416 });
    await waitFor('ended', async () => c.events().at(-1) === 'Stop', 6_000);
    assert.equal((await c.get()).state, 'waiting');
    // With its Stop hook, a completion ends the turn once.
    turn = await c.prompt('five');
    await relay(t.core, c.token, 'Stop', { ...c.base, hook_event_name: 'Stop', turn_id: turn, stop_hook_active: false, last_assistant_message: 'Done.' });
    c.write('event_msg', { type: 'task_complete', turn_id: turn, last_agent_message: 'Done.', started_at: 1, completed_at: 2, duration_ms: 416 });
    await settle();
    assert.deepEqual(c.events().slice(-2), ['UserPromptSubmit', 'Stop']);
    await t.owner.call('sessions.stop', { id: c.s.id });
  } finally {
    await t.close();
  }
});

test('a Codex turn whose rollout is not inside its account is not followed', async () => {
  const t = await testCore({ codexHookProbe: stubProbe(), launcher: codexWithToken });
  try {
    const c = await codexSession(t);
    // /new moved it to another thread, whose rollout the hook placed outside the account's CODEX_HOME.
    const other = '01a120fd-e4f2-7291-a094-0abf83a4d6c8';
    const elsewhere = join(t.dir, `rollout-2026-10-09T09-07-52-${other}.jsonl`);
    writeFileSync(elsewhere, '');
    const turn = '01a120fa-f40a-7c31-ab18-6038cd50b599';
    await relay(t.core, c.token, 'UserPromptSubmit', { ...c.base, session_id: other, transcript_path: elsewhere, hook_event_name: 'UserPromptSubmit', turn_id: turn, prompt: 'go' });
    assert.deepEqual([(await c.get()).conversationId, (await c.get()).transcriptPath], [other, null]);
    appendFileSync(elsewhere, `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: turn, error: { message: plusLimit('11:21 AM'), codex_error_info: 'usage_limit_exceeded' } } })}\n`);
    await new Promise((r) => setTimeout(r, 2_300));
    assert.equal((await c.get()).state, 'working', 'a file Codex’s hook pointed outside its account is never read');
    await t.owner.call('sessions.stop', { id: c.s.id });
  } finally {
    await t.close();
  }
});

test('a Codex rollout replaced by a FIFO holds no reader, and one rewritten is read again from its start', async () => {
  const t = await testCore({ codexHookProbe: stubProbe(), launcher: codexWithToken });
  try {
    const c = await codexSession(t);
    const turn = await c.prompt('go');
    rmSync(c.rollout);
    execFileSync('/usr/bin/mkfifo', [c.rollout]);
    await new Promise((r) => setTimeout(r, 2_300));
    assert.equal((await t.owner.call('core.hello', {})).role, 'owner', 'the core still answers');
    assert.equal((await c.get()).state, 'working');
    // Back as a regular file, shorter than what was read: read again from the start, and only this turn's end counts.
    rmSync(c.rollout);
    writeFileSync(c.rollout, '');
    c.failed(turn, 'We’re currently experiencing high demand, which may cause temporary errors.', 'server_overloaded');
    await waitFor('the turn failed', async () => c.events().at(-1) === 'StopFailure', 5_000);
    assert.equal((await c.get()).state, 'waiting');
    await t.owner.call('sessions.stop', { id: c.s.id });
  } finally {
    await t.close();
  }
});
