// The alert cards remember which needs they have dealt with; over a day of
// sessions that memory must not grow without end.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { forgetStale } from './forget.ts';

test('what is no longer open, and was noted long enough ago, is forgotten; the rest is kept', () => {
  const noted = new Map([['old-closed', 1_000], ['old-open', 1_000], ['new-closed', 9_000]]);
  forgetStale(noted, (key) => key === 'old-open', 5_000);
  assert.deepEqual([...noted.keys()].sort(), ['new-closed', 'old-open']);
});

test('a thousand needs come and go, and the memory stays the size of what is open', () => {
  const noted = new Map<string, number>();
  for (let i = 0; i < 1_000; i++) {
    noted.set(`need-${i}`, i * 1_000);
    const open = new Set([`need-${i}`, `need-${i - 1}`]);
    forgetStale(noted, (key) => open.has(key), i * 1_000 - 60_000);
  }
  assert.ok(noted.size <= 62, `remembers ${noted.size}`);
});
