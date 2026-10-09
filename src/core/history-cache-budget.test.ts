import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HistoryCache, historyPayloadBytes } from './history-cache.ts';

test('entry eviction respects the most recently read value', () => {
  const cache = new HistoryCache<string>({ entries: 2, units: 9, bytes: 100 });
  cache.set('a', 'first', 1, 10); cache.set('b', 'second', 1, 12);
  assert.equal(cache.get('a'), 'first');
  cache.set('c', 'third', 1, 10);
  assert.equal(cache.get('a'), 'first'); assert.equal(cache.get('b'), undefined); assert.equal(cache.get('c'), 'third');
});

test('exact unit and payload budgets fit, and the next admission evicts enough old values', () => {
  const units = new HistoryCache<string>({ entries: 3, units: 4, bytes: 100 });
  units.set('a', 'first', 2, 10); units.set('b', 'second', 2, 12);
  assert.equal(units.get('a'), 'first'); assert.equal(units.get('b'), 'second');
  units.set('c', 'third', 1, 10); assert.equal(units.get('a'), undefined); assert.equal(units.get('b'), 'second');
  const bytes = new HistoryCache<string>({ entries: 3, units: 9, bytes: 10 });
  bytes.set('a', 'x', 1, 3); bytes.set('b', 'y', 1, 3); // Each key adds two bytes: exactly ten.
  assert.equal(bytes.get('a'), 'x'); assert.equal(bytes.get('b'), 'y');
  bytes.set('c', 'z', 1, 1); assert.equal(bytes.get('a'), undefined); assert.equal(bytes.get('b'), 'y'); assert.equal(bytes.get('c'), 'z');
});

test('oversized replacements remove stale values without evicting unrelated valid entries', () => {
  const cache = new HistoryCache<string>({ entries: 2, units: 2, bytes: 10 });
  cache.set('a', 'x', 1, 2); cache.set('b', 'y', 1, 2);
  cache.set('a', 'too large', 1, 9);
  assert.equal(cache.get('a'), undefined); assert.equal(cache.get('b'), 'y');
  cache.set('a', 'too many rows', 3, 1); assert.equal(cache.get('a'), undefined); assert.equal(cache.get('b'), 'y');
  cache.set('a', 'unknown weight', 1, Infinity); assert.equal(cache.get('a'), undefined);
  cache.set('a', 'valid again', 1, 2); assert.equal(cache.get('a'), 'valid again');
});

test('deletion and stale pruning release all associated admission capacity', () => {
  const cache = new HistoryCache<string>({ entries: 2, units: 2, bytes: 8 });
  cache.set('a', 'x', 1, 2); cache.set('b', 'y', 1, 2);
  cache.delete('a'); cache.delete('a'); cache.prune((_key, value) => value !== 'y');
  cache.set('c', 'z', 2, 6);
  assert.equal(cache.get('a'), undefined); assert.equal(cache.get('b'), undefined); assert.equal(cache.get('c'), 'z');
});

test('payload measurement charges Unicode code units and complete binary backing stores', () => {
  const backing = new ArrayBuffer(100); const view = new Uint8Array(backing, 20, 2);
  assert.equal(historyPayloadBytes(['界', '😀', view, 3, null]), 106);
  assert.equal(historyPayloadBytes([Buffer.alloc(12)]), 12);
  assert.equal(historyPayloadBytes([{}]), Infinity, 'an unsupported value cannot silently carry uncounted retained payload');
});
