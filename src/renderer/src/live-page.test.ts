import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pairParts } from './live-page.ts';

test('a part holding the same content as a region gives that region its id', () => {
  const { byRegion, alone } = pairParts(
    [{ id: 'p-hero', key: 'k1', at: 3 }, { id: 'p-menu', key: 'k2', at: 9 }],
    [{ index: 0, key: 'k1', at: 4 }, { index: 1, key: 'k2', at: 10 }, { index: 2, key: 'k3', at: 12 }],
  );
  assert.deepEqual([...byRegion], [[0, 'p-hero'], [1, 'p-menu']]);
  assert.deepEqual(alone, []);
});

test('parts and regions around the same content pair outermost first', () => {
  // A block part around a menu part, both around exactly the menu: the block template and the menu template.
  const { byRegion } = pairParts(
    [{ id: 'p-menu', key: 'k', at: 5 }, { id: 'p-block', key: 'k', at: 1 }],
    [{ index: 7, key: 'k', at: 6 }, { index: 3, key: 'k', at: 2 }],
  );
  assert.deepEqual([...byRegion].sort(), [[3, 'p-block'], [7, 'p-menu']]);
});

test('a part nothing else found, or one around nothing, is a region of its own', () => {
  const { byRegion, alone } = pairParts(
    [{ id: 'p-hours', key: 'k9', at: 1 }, { id: 'p-empty', key: null, at: 2 }, { id: 'p-second', key: 'k1', at: 3 }],
    [{ index: 0, key: 'k1', at: 0 }, { index: 1, key: null, at: 4 }],
  );
  assert.deepEqual([...byRegion], [[0, 'p-second']]);
  assert.deepEqual(alone, ['p-hours', 'p-empty']);
});

test('more parts than regions around one content: the extra ones stand alone', () => {
  const { byRegion, alone } = pairParts(
    [{ id: 'a', key: 'k', at: 1 }, { id: 'b', key: 'k', at: 2 }],
    [{ index: 4, key: 'k', at: 3 }],
  );
  assert.deepEqual([...byRegion], [[4, 'a']]);
  assert.deepEqual(alone, ['b']);
});
