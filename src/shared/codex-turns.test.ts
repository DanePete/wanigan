import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codexRolloutLine } from './codex-turns.ts';

// Lines shaped exactly as codex-cli 0.155.1 wrote them to a rollout, against a
// stand-in model provider that answered one turn and refused the next with the
// 429 `usage_limit_reached` the ChatGPT backend sends; the third was interrupted.
const TURN = '01a120fd-f2f2-7ba2-9cb6-a6f7b58df8e1';
const line = (ordinal: number, payload: Record<string, unknown>): string =>
  JSON.stringify({ timestamp: '2026-10-09T14:07:56.188Z', ordinal, type: 'event_msg', payload });
const LIMIT = 'You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 11:24 AM.';
const usage = { input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 3, reasoning_output_tokens: 0, total_tokens: 13 };
const tokenCount = (primary: unknown, secondary: unknown = null) => line(18, {
  type: 'token_count', info: { total_token_usage: usage, last_token_usage: usage, model_context_window: 258400 },
  rate_limits: { limit_id: 'codex', limit_name: null, primary, secondary, credits: null, individual_limit: null, spend_control_reached: null, plan_type: null, rate_limit_reached_type: null },
});
const limited = line(19, {
  type: 'task_complete', turn_id: TURN, last_agent_message: null,
  error: { message: LIMIT, codex_error_info: 'usage_limit_exceeded' }, started_at: 1791554876, completed_at: 1791554876, duration_ms: 39,
});

test('a failed Codex turn is read from its own rollout, with Codex’s words and error kind', () => {
  assert.deepEqual(codexRolloutLine(limited, TURN), {
    end: { kind: 'failed', info: 'usage_limit_exceeded', message: LIMIT, at: 1791554876_000 },
  });
  // An error with fields is keyed by its name.
  const dropped = line(30, { type: 'task_complete', turn_id: TURN, last_agent_message: null,
    error: { message: 'stream disconnected before completion', codex_error_info: { response_stream_disconnected: { http_status_code: null } } }, completed_at: 1791554900 });
  assert.deepEqual(codexRolloutLine(dropped, TURN), { end: { kind: 'failed', info: 'response_stream_disconnected', message: 'stream disconnected before completion', at: 1791554900_000 } });
});

test('a completed or interrupted Codex turn is read too; another turn’s end is not this one’s', () => {
  const done = line(12, { type: 'task_complete', turn_id: TURN, last_agent_message: 'Mock reply one.', started_at: 1791554874, completed_at: 1791554874, duration_ms: 416, time_to_first_token_ms: 395 });
  assert.deepEqual(codexRolloutLine(done, TURN), { end: { kind: 'completed' } });
  const aborted = line(26, { type: 'turn_aborted', turn_id: TURN, reason: 'interrupted', started_at: 1791554880, completed_at: 1791554882, duration_ms: 2497 });
  assert.deepEqual(codexRolloutLine(aborted, TURN), { end: { kind: 'aborted', reason: 'interrupted' } });
  assert.equal(codexRolloutLine(limited, '01a120fd-eadd-7320-af4b-ff518e0f72df'), null, 'the previous turn’s end');
  assert.equal(codexRolloutLine(line(5, { type: 'task_started', turn_id: TURN, started_at: 1791554876 }), TURN), null);
});

test('a token count says until when its full windows stay full, and nothing else is read', () => {
  const resets = 1791563091;
  assert.deepEqual(codexRolloutLine(tokenCount({ used_percent: 100.0, window_minutes: 300, resets_at: resets }, { used_percent: 41.0, window_minutes: 10080, resets_at: resets + 432000 }), TURN),
    { fullUntil: resets * 1000 }, 'only the full window counts');
  assert.deepEqual(codexRolloutLine(tokenCount({ used_percent: 100, window_minutes: 300, resets_at: resets }, { used_percent: 100, window_minutes: 10080, resets_at: resets + 432000 }), TURN),
    { fullUntil: (resets + 432000) * 1000 }, 'both full: the later reset');
  assert.deepEqual(codexRolloutLine(tokenCount(null), TURN), { fullUntil: null }, 'no windows reported (a turn that went through)');
  assert.deepEqual(codexRolloutLine(tokenCount({ used_percent: 99.5, window_minutes: 300, resets_at: resets }), TURN), { fullUntil: null });
});

test('anything else in a rollout, or a line that is not one, says nothing', () => {
  const agentSaid = JSON.stringify({ timestamp: 't', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `"event_msg" "task_complete" ${TURN} ${LIMIT}` }] } });
  assert.equal(codexRolloutLine(agentSaid, TURN), null, 'the agent quoting the words is not Codex recording them');
  assert.equal(codexRolloutLine(limited.slice(0, -5), TURN), null, 'a line still being written');
  assert.equal(codexRolloutLine('', TURN), null);
  assert.equal(codexRolloutLine(`${limited.slice(0, -2)}, "pad": "${'x'.repeat(1024 * 1024)}"}}`, TURN), null, 'too long to be a turn’s end');
});
