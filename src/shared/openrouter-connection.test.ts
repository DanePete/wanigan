import assert from 'node:assert/strict';
import test from 'node:test';
import { readOpenRouterKey } from './openrouter-connection.ts';

test('OpenRouter key shape preserves a bounded supplied key without pretending to authenticate it', () => {
  assert.equal(readOpenRouterKey('  sk-or-fixture-only-not-a-key  '), 'sk-or-fixture-only-not-a-key');
  // Do not freeze a third party's versioned prefix into our credential store.
  assert.equal(readOpenRouterKey('future-format-fixture'), 'future-format-fixture');
});

test('OpenRouter key validation rejects malformed input without echoing it', () => {
  for (const value of [null, {}, 3, '', 'short', 'x'.repeat(4_097), 'fixture-key-with\nnewline', 'fixture-key-with\0null', 'fixture-key-with space']) {
    assert.throws(() => readOpenRouterKey(value));
  }
  const secret = 'sensitive-secret-with space';
  assert.throws(() => readOpenRouterKey(secret), error => error instanceof Error && !error.message.includes(secret));
});
