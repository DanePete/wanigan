import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codexAccount, codexLoginChanged, codexModelPage, codexRateLimits, codexWindow, codexWindowStale } from './codex-account.ts';

const window = (usedPercent: number, resetsAt: number | null = 1000) => ({ usedPercent, resetsAt, windowDurationMins: 300 });

test('every reported bucket is kept, keyed view first, and nothing is inferred from a label', () => {
  const read = codexRateLimits({
    ordinaryUsageAllowed: false, accountId: 'backend-account',
    rateLimits: { limitId: 'codex', planType: 'pro', primary: window(72), secondary: window(10), spendControlReached: false },
    rateLimitsByLimitId: {
      codex_other: { limitName: 'gpt-reserve', normalModelSlug: null, primary: window(4), credits: { hasCredits: false, unlimited: false, balance: '0' } },
      codex: { limitId: 'codex', normalModelSlug: 'gpt-fixture', primary: window(72), rateLimitReachedType: 'primary' },
    },
  });
  assert.deepEqual(read.buckets.map((row) => row.limitId), ['codex', 'codex_other']);
  assert.equal(read.buckets[0].normalModelSlug, 'gpt-fixture');
  assert.equal(read.buckets[1].normalModelSlug, null, 'a label is not a model');
  assert.deepEqual(read.buckets[1].credits, { hasCredits: false, unlimited: false, balance: '0' });
  assert.equal(read.primary?.usedPercent, 72);
  assert.equal(read.backendAccountId, 'backend-account');
  assert.equal(read.ordinaryUsageAllowed, false);
});

test('an older single-bucket reply is one bucket, and an absent verdict is unknown rather than allowed', () => {
  const read = codexRateLimits({ rateLimits: { planType: 'plus', primary: window(11) }, rateLimitsByLimitId: null });
  assert.equal(read.buckets.length, 1);
  assert.equal(read.ordinaryUsageAllowed, null);
  assert.equal(read.backendAccountId, null);
  assert.deepEqual(codexRateLimits(undefined).buckets, []);
});

test('percentages are kept as reported and a renamed field is no window, never zero percent', () => {
  assert.equal(codexWindow(window(37))?.usedPercent, 37);
  assert.equal(codexWindow(window(37))?.remainingPercent, 63);
  assert.equal(codexWindow(window(140))?.usedPercent, 100);
  assert.equal(codexWindow({ used_percent: 37 }), null);
  assert.equal(codexWindow(window(5, 2))?.resetsAt, 2000, 'resetsAt is absolute Unix seconds');
});

test('a passed reset is stale, and staleness is not recovery', () => {
  const read = codexRateLimits({ ordinaryUsageAllowed: false, rateLimits: { primary: window(100, 5) } });
  assert.equal(codexWindowStale(read.primary, 5000), true);
  assert.equal(codexWindowStale(read.primary, 4999), false);
  assert.equal(codexWindowStale(codexWindow(window(1, null)), 9e15), false, 'no reset time is unknown, not stale');
  assert.equal(read.ordinaryUsageAllowed, false, 'the verdict does not flip because a reset time passed');
});

test('signed out, no login required, and unreadable are three different answers', () => {
  assert.deepEqual(codexAccount({ account: null, requiresOpenaiAuth: true }),
    { authState: 'signed-out', requiresOpenaiAuth: true, type: null, email: null, plan: null });
  assert.equal(codexAccount({ account: null, requiresOpenaiAuth: false }).requiresOpenaiAuth, false);
  assert.equal(codexAccount({}).authState, 'unknown');
  assert.equal(codexAccount({ account: { email: 'a@example.invalid' } }).authState, 'unknown');
  assert.deepEqual(codexAccount({ account: { type: 'chatgpt', email: 'a@example.invalid', planType: 'pro' }, requiresOpenaiAuth: true }),
    { authState: 'signed-in', requiresOpenaiAuth: true, type: 'chatgpt', email: 'a@example.invalid', plan: 'pro' });
  assert.equal(codexAccount({ account: { type: 'apiKey' } }).email, null);
});

test('a model page carries its cursor, and both effort spellings are read', () => {
  const page = codexModelPage({ nextCursor: 'opaque', data: [
    { id: 'one', displayName: 'One', supportedReasoningEfforts: ['low', { reasoningEffort: 'high' }, 7], isDefault: true },
    { displayName: 'no id' }, null,
  ] });
  assert.equal(page.nextCursor, 'opaque');
  assert.deepEqual(page.models.map((model) => [model.id, model.reasoningEfforts, model.isDefault]), [['one', ['low', 'high'], true]]);
  assert.equal(codexModelPage({ data: [], nextCursor: null }).nextCursor, null);
});

test('a login change is any reported difference; an absent field proves nothing either way', () => {
  const base = { backendAccountId: 'a', email: 'a@example.invalid', plan: 'pro' };
  assert.equal(codexLoginChanged(base, { ...base }), false);
  assert.equal(codexLoginChanged(base, { ...base, backendAccountId: 'b' }), true);
  assert.equal(codexLoginChanged(base, { ...base, plan: 'plus' }), true);
  assert.equal(codexLoginChanged(base, { ...base, backendAccountId: null }), false);
});
