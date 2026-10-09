import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CodexTally, UsageTally, mergeUsage, shortTokens, tokensUsed } from './tokens.ts';

const reply = (id: string, usage: Record<string, number>, extra: Record<string, unknown> = {}) => JSON.stringify({
  type: 'assistant', uuid: `u-${id}-${Math.random()}`, message: { id, model: 'claude-opus-5-5', role: 'assistant', content: [], usage }, ...extra,
});

test('a reply is counted once, however many lines repeat it', () => {
  const t = new UsageTally();
  const usage = { input_tokens: 10, output_tokens: 200, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 3000 };
  t.addLine(reply('msg_1', usage));
  t.addLine(reply('msg_1', usage)); // the same reply's second content block
  t.addLine(reply('msg_2', { input_tokens: 5, output_tokens: 40, cache_read_input_tokens: 53_000, cache_creation_input_tokens: 100 }));
  const u = t.total();
  assert.deepEqual({ ...u }, {
    input: 15, output: 240, cacheRead: 103_000, cacheWrite: 3100, requests: 2, context: 53_105, contextWindow: null, model: 'claude-opus-5-5', subagents: 0, source: 'claude',
  });
  assert.equal(tokensUsed(u), 106_355);
});

test('context is the latest main-thread request; subagents count toward the total only', () => {
  const t = new UsageTally();
  t.addLine(reply('main_1', { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 20_000 }));
  t.addLine(reply('side_1', { input_tokens: 9000, output_tokens: 10 }), false);
  t.addLine(reply('side_2', { input_tokens: 8000, output_tokens: 10 }, { isSidechain: true }));
  const u = t.total();
  assert.equal(u.context, 20_001);
  assert.equal(u.requests, 3);
  assert.equal(u.input, 17_001);
});

test('lines without usage, synthetic replies, user lines and broken JSON are skipped', () => {
  const t = new UsageTally();
  t.addLine('{"type":"user","message":{"role":"user","content":"hi"}}');
  t.addLine('{"type":"assistant","message":{"id":"x","model":"<synthetic>","usage":{"input_tokens":5}}}');
  t.addLine('{"type":"assistant","usage" ');
  t.addLine(reply('ok', { input_tokens: -4, output_tokens: Number.NaN as number, cache_read_input_tokens: 7 }));
  const u = t.total();
  assert.equal(u.requests, 1);
  assert.equal(tokensUsed(u), 7, 'negative and non-finite counts are zero');
  assert.equal(new UsageTally().total().context, null, 'nothing yet is unknown, not zero');
});

test('a forked transcript that copied earlier replies merges without double counting', () => {
  const t = new UsageTally();
  const a = { input_tokens: 100, output_tokens: 100 };
  for (const line of [reply('m1', a), reply('m2', a)]) t.addLine(line); // the original
  for (const line of [reply('m1', a), reply('m2', a), reply('m3', a)]) t.addLine(line); // the fork
  assert.equal(t.total().requests, 3);
});

// Codex rollout lines as codex-cli 0.155.1 writes them (field names from the binary and its app-server schema).
const T = '01a114d3-47f0-7272-8e4b-a8c6b201a02c';
const meta = (extra: Record<string, unknown> = {}) => JSON.stringify({ timestamp: '2026-10-07T05:26:02.049Z', type: 'session_meta', payload: { id: T, session_id: T, cwd: '/site', ...extra } });
const usage = (input: number, cached: number, output: number, cacheWrite = 0) => ({
  input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: cacheWrite, output_tokens: output, reasoning_output_tokens: Math.floor(output / 2), total_tokens: input + output,
});
const count = (total: ReturnType<typeof usage> | null, last: ReturnType<typeof usage> | null = total, window = 272_000) => JSON.stringify({
  timestamp: '2026-10-07T05:27:00.000Z', type: 'event_msg',
  payload: { type: 'token_count', info: total ? { total_token_usage: total, last_token_usage: last, model_context_window: window } : null, rate_limits: null },
});
const turnStarted = (turn: string) => JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: turn } });
const turnContext = (model: string) => JSON.stringify({ type: 'turn_context', payload: { cwd: '/site', model, effort: 'high' } });

test('Codex: a thread’s tokens are how much its running total grew, request by request', () => {
  const t = new CodexTally();
  for (const line of [
    meta(), turnContext('gpt-5.5'), turnStarted('01a114d4-0000-7000-8000-000000000001'),
    count(null), // a rate-limit update carries no usage
    count(usage(10_000, 8_000, 300), usage(10_000, 8_000, 300)),
    count(usage(10_000, 8_000, 300), usage(10_000, 8_000, 300)), // the same total again is not another request
    '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"token_count"}]}}',
    count(usage(22_500, 18_000, 500, 1_000), usage(12_500, 10_000, 200, 1_000)),
  ]) t.addLine(line);
  const u = t.total();
  assert.deepEqual({ ...u }, {
    input: 3_500, cacheRead: 18_000, cacheWrite: 1_000, output: 500, requests: 2,
    context: 12_500, contextWindow: 272_000, model: 'gpt-5.5', subagents: 0, source: 'codex',
  });
  assert.equal(tokensUsed(u), 23_000, 'everything Codex counted: its input (cached included) and output (reasoning included)');
  assert.equal(new CodexTally().total().context, null, 'nothing yet is unknown, not zero');
});

test('Codex: a total that went down was restarted, and counts from zero', () => {
  const t = new CodexTally();
  for (const line of [meta(), count(usage(5_000, 0, 100)), count(usage(1_000, 0, 50)), count(usage(1_500, 0, 60))]) t.addLine(line);
  const u = t.total();
  assert.equal(u.requests, 3);
  assert.equal(tokensUsed(u), 5_100 + 1_050 + 510);
});

test('Codex: a fork does not count the totals it copied from its parent', () => {
  const t = new CodexTally();
  for (const line of [
    meta({ forked_from_id: '01a114d0-0000-7000-8000-000000000000' }),
    turnStarted('01a114d0-0000-7000-8000-0000000000aa'), // the parent's turn, copied
    count(usage(40_000, 30_000, 900)),
    turnStarted('01a114d5-0000-7000-8000-000000000001'), // the fork's own first turn
    count(usage(52_000, 41_000, 1_000), usage(12_000, 11_000, 100)),
  ]) t.addLine(line);
  const u = t.total();
  assert.equal(u.requests, 1);
  assert.equal(tokensUsed(u), 12_000 + 100);
  assert.equal(u.context, 12_000);
});

test('Codex: malformed usage is skipped, never guessed', () => {
  const t = new CodexTally();
  t.addLine(meta());
  t.addLine(count({ ...usage(100, 90, 10), cached_input_tokens: 500 })); // more cached than sent
  t.addLine(count({ ...usage(100, 0, 10), input_tokens: -1 }));
  t.addLine('{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":');
  assert.equal(t.total().requests, 0);
});

test('a card’s Claude and Codex conversations add up as one count', () => {
  const claude = new UsageTally();
  claude.addLine(reply('m1', { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 1_000 }));
  const codex = new CodexTally();
  for (const line of [meta(), count(usage(2_000, 1_500, 30))]) codex.addLine(line);
  const both = mergeUsage(claude.total(), codex.total());
  assert.equal(both?.source, 'mixed');
  assert.equal(both?.requests, 2);
  assert.equal(tokensUsed(both!), 1_030 + 2_030);
  assert.equal(mergeUsage(null, codex.total())?.source, 'codex');
  assert.equal(mergeUsage(null, null), null);
});

test('short counts', () => {
  assert.deepEqual([0, 999, 1000, 1250, 12_345, 999_499, 1_000_000, 1_234_567, 250_000_000].map(shortTokens),
    ['0', '999', '1k', '1.3k', '12.3k', '999k', '1M', '1.2M', '250M']);
});
