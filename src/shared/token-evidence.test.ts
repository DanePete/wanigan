import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codexTokenHistory, codexSessionTokenEvidence } from './token-evidence.ts';

const conversationId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const point = (at: number, input: number, cached: number, output: number) => JSON.stringify({
  timestamp: new Date(at).toISOString(), payload: { type: 'token_count', info: {
    total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output },
  } },
});
const meta = JSON.stringify({ type: 'session_meta', timestamp: new Date(100).toISOString(), payload: { id: conversationId } });
const log = [meta, point(200, 100, 60, 10), point(400, 300, 180, 30), point(600, 350, 210, 50)].join('\n');

test('resumed session counts are disjoint deltas and ended attempts do not inherit later conversation growth', () => {
  const history = codexTokenHistory(log, true, conversationId);
  const first = codexSessionTokenEvidence(history, { conversationId, startedAt: 50, endedAt: 250, asOf: 700, overlaps: false });
  const resumed = codexSessionTokenEvidence(history, { conversationId, startedAt: 300, endedAt: 450, asOf: 700, overlaps: false });
  assert.equal(first.scope, 'session-window-delta');
  assert.deepEqual(first.counts, { inputTokens: 40, cacheReadTokens: 60, outputTokens: 10, cacheWriteTokens: null, reasoningTokens: null });
  assert.equal(resumed.scope, 'session-window-delta');
  assert.deepEqual(resumed.counts, { inputTokens: 80, cacheReadTokens: 120, outputTokens: 20, cacheWriteTokens: null, reasoningTokens: null });
  assert.equal(resumed.conversationTotals?.cacheReadTokens, 180);
  assert.equal(resumed.baselineAt, 200);
});

test('missing baseline, truncated creation and overlapping sessions never claim conversation counters as attempt counts', () => {
  for (const [text, complete, overlaps] of [[point(400, 300, 180, 30), false, false], [log, false, false], [log, true, true]] as const) {
    const evidence = codexSessionTokenEvidence(codexTokenHistory(text, complete, conversationId), {
      conversationId, startedAt: 50, endedAt: 450, asOf: 700, overlaps,
    });
    assert.equal(evidence.scope, 'conversation-only');
    assert.equal(evidence.counts.inputTokens, null);
    assert.equal(evidence.conversationTotals?.cacheReadTokens, 180);
  }
});

test('unknown fields and counter resets are not converted to free usage', () => {
  const reset = [meta, point(200, 100, 60, 10), point(400, 50, 30, 3), point(600, 350, 210, 50)].join('\n');
  const evidence = codexSessionTokenEvidence(codexTokenHistory(reset, true, conversationId), {
    conversationId, startedAt: 300, endedAt: null, asOf: 700, overlaps: false,
  });
  assert.equal(evidence.counts.inputTokens, null);
  assert.equal(evidence.counts.outputTokens, null);
  assert.equal(evidence.counts.cacheReadTokens, null);
  assert.equal(evidence.counts.cacheWriteTokens, null);
  const missing = JSON.stringify({ timestamp: new Date(200).toISOString(), payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100 } } } });
  const parsed = codexTokenHistory(meta + '\n' + missing, true, conversationId);
  assert.equal(parsed.points[0].counts.inputTokens, null, 'unknown cached subset makes uncached input unknown');
  assert.equal(parsed.points[0].counts.outputTokens, null);
});
