/**
 * Codex credits are an estimate from a dated rate card. The tests hold the
 * arithmetic to the card and the labelling to what was recorded: no borrowed
 * rate for an unknown model, Fast only where the tier was recorded.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CODEX_CREDIT_RATE_CARD, estimateCredits, scanRolloutSettings, tierRecord } from './codex-credits.ts';

test('the rate card carries the published figures, its source and its date', () => {
  assert.deepEqual(CODEX_CREDIT_RATE_CARD.models['gpt-6-astra'], { input: 250, cached: 25, output: 1250 });
  assert.deepEqual(CODEX_CREDIT_RATE_CARD.models['gpt-5.6-sol'], { input: 100, cached: 10, output: 500 });
  assert.deepEqual(CODEX_CREDIT_RATE_CARD.models['gpt-5.6-terra'], { input: 50, cached: 5, output: 300 });
  assert.deepEqual(CODEX_CREDIT_RATE_CARD.models['gpt-5.6-luna'], { input: 5, cached: 0.5, output: 30 });
  assert.equal(CODEX_CREDIT_RATE_CARD.fastMultiplier, 2.5);
  assert.equal(CODEX_CREDIT_RATE_CARD.readOn, '14 Sep 2026');
});

test('cached input is priced at the cached rate and subtracted from input', () => {
  const e = estimateCredits({ model: 'gpt-6-astra', inputTokens: 1_000_000, cachedInputTokens: 600_000, outputTokens: 100_000, tiers: { kind: 'single', tier: 'default' } });
  assert.equal(e.status, 'estimated');
  if (e.status === 'estimated') {
    assert.equal(e.credits, 400_000 * 250 / 1e6 + 600_000 * 25 / 1e6 + 100_000 * 1250 / 1e6);
    assert.equal(e.tierNote, 'standard');
  }
});

test('Fast applies only when the recorded tier is priority or fast', () => {
  const args = { model: 'gpt-5.6-sol', inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0 };
  const fast = estimateCredits({ ...args, tiers: tierRecord(['priority']) });
  const unknown = estimateCredits({ ...args, tiers: tierRecord([]) });
  const mixed = estimateCredits({ ...args, tiers: tierRecord(['priority', 'default']) });
  assert.ok(fast.status === 'estimated' && fast.credits === 250 && fast.fast === true);
  assert.ok(unknown.status === 'estimated' && unknown.credits === 100 && unknown.tierNote === 'tier not recorded');
  assert.ok(mixed.status === 'estimated' && mixed.range?.[0] === 100 && mixed.range?.[1] === 250);
});

test('a model off the card has no estimate, never a borrowed one', () => {
  assert.equal(estimateCredits({ model: 'gpt-reserve', inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, tiers: tierRecord([]) }).status, 'no-rate');
  assert.equal(estimateCredits({ model: null, inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, tiers: tierRecord([]) }).status, 'no-rate');
});

test('rollout settings are read from turn_context and thread_settings_applied lines', () => {
  const text = [
    '{"type":"turn_context","payload":{"cwd":"/x","model":"gpt-6-astra","effort":"high"}}',
    '{"type":"event_msg","payload":{"type":"thread_settings_applied","thread_settings":{"model":"gpt-6-astra","service_tier":"priority"}}}',
    '{"type":"event_msg","payload":{"type":"token_count","info":{"model":"not-this-one"}}}',
  ].join('\n');
  assert.deepEqual(scanRolloutSettings(text), { tiers: ['priority'], models: ['gpt-6-astra'] });
});
