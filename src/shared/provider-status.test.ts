import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ClaudeContextUsage } from './types.ts';
import { claudeContextStatus } from './provider-status.ts';

const now = Date.parse('2026-09-15T12:00:00Z');
const exact: ClaudeContextUsage = {
  kind: 'ok', tokens: 190_000, window: 200_000, percent: 95, model: 'claude-sonnet-4-5',
  at: now, conversationMatch: 'exact', windowSource: 'assumed-200k', windowNote: null,
};

test('an unconfirmed fallback cannot claim the selected conversation is nearly full', () => {
  const result = claudeContextStatus({ ...exact, conversationMatch: 'lifetime-fallback' }, now);
  assert.equal(result.label, 'ctx unconfirmed');
  assert.equal(result.nearFull, false);
  assert.match(result.title!, /fallback transcript.*not attributed/);
  assert.equal(claudeContextStatus({ ...exact, conversationMatch: undefined }, now).nearFull, false);
});

test('exact context identifies reading time and distinguishes reported from assumed windows', () => {
  const assumed = claudeContextStatus(exact, now);
  assert.equal(assumed.label, 'ctx 95% · 190k/200k');
  assert.equal(assumed.nearFull, true);
  assert.match(assumed.title!, /2026-09-15T12:00:00.000Z/);
  assert.match(assumed.title!, /assumed, not measured/);
  const reported = claudeContextStatus({ ...exact, windowSource: 'cli-reported' }, now);
  assert.match(reported.title!, /CLI-reported, not measured/);
  assert.doesNotMatch(reported.title!, /assumed/);
});

test('old or undated readings stay historical without current pressure, and absent usage invents no percentage', () => {
  assert.equal(claudeContextStatus({ ...exact, at: now - 130_000 }, now).nearFull, false);
  assert.match(claudeContextStatus({ ...exact, at: now - 130_000 }, now).title!, /older than two minutes/);
  assert.equal(claudeContextStatus({ ...exact, at: null }, now).nearFull, false);
  assert.equal(claudeContextStatus({ ...exact, window: null, percent: null }, now).label, 'ctx 190k');
  assert.equal(claudeContextStatus({ kind: 'no-transcript' }, now).label, null);
});
