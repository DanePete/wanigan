/**
 * The cold-cache note: which lifetime applies and on what evidence, and when a
 * note appears at all. A pinned value is a fact; the rest must say "inferred".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coldCacheNote, inferCacheTtl, parseTtl } from './cache-warmth.ts';

const none = { envTtl: null, settingTtl: undefined, recentWrite: null, authMethod: null, apiKeyInEnvironment: false };

test('the environment variable outranks the setting, which outranks every inference', () => {
  assert.deepEqual(inferCacheTtl({ ...none, envTtl: '5m', settingTtl: '1h', authMethod: 'claude.ai' }), { minutes: 5, basis: 'pinned-env' });
  assert.deepEqual(inferCacheTtl({ ...none, settingTtl: '1h', apiKeyInEnvironment: true }), { minutes: 60, basis: 'pinned-setting' });
  assert.equal(parseTtl('2h'), null);
});

test('a session’s own cache writes decide before the account type does', () => {
  assert.deepEqual(inferCacheTtl({ ...none, recentWrite: { fiveMinute: 0, oneHour: 900 }, apiKeyInEnvironment: true }), { minutes: 60, basis: 'observed-writes' });
  assert.deepEqual(inferCacheTtl({ ...none, recentWrite: { fiveMinute: 900, oneHour: 0 }, authMethod: 'claude.ai' }), { minutes: 5, basis: 'observed-writes' });
});

test('subscription is 1 h and an API key is 5 min, both inferred; nothing known is unknown', () => {
  assert.deepEqual(inferCacheTtl({ ...none, authMethod: 'claude.ai' }), { minutes: 60, basis: 'account-subscription' });
  assert.deepEqual(inferCacheTtl({ ...none, apiKeyInEnvironment: true }), { minutes: 5, basis: 'account-api-key' });
  assert.deepEqual(inferCacheTtl(none), { minutes: null, basis: 'unknown' });
});

test('the note appears only past the lifetime and carries the size and the basis', () => {
  const now = 10_000_000;
  const ttl = { minutes: 60, basis: 'account-subscription' as const };
  assert.equal(coldCacheNote({ now, lastTurnEndedAt: now - 59 * 60_000, ttl, contextTokens: 120_000 }), null);
  const note = coldCacheNote({ now, lastTurnEndedAt: now - 68 * 60_000, ttl, contextTokens: 120_000 });
  assert.equal(note?.text, 'Idle 68 min: this message likely re-reads ~120,000 tokens without cache (estimate; cache lifetime 1 h, inferred: subscription account).');
});

test('an unknown lifetime waits past both, and no recorded turn means no note', () => {
  const now = 10_000_000;
  const unknown = { minutes: null, basis: 'unknown' as const };
  assert.equal(coldCacheNote({ now, lastTurnEndedAt: now - 30 * 60_000, ttl: unknown, contextTokens: 5 }), null);
  assert.match(coldCacheNote({ now, lastTurnEndedAt: now - 61 * 60_000, ttl: unknown, contextTokens: null })?.text ?? '', /past either cache lifetime/);
  assert.equal(coldCacheNote({ now, lastTurnEndedAt: null, ttl: unknown, contextTokens: 5 }), null);
});
