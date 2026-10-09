import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dropSlot, finalIndex, pairParts } from './live-page.ts';

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

const stacked = [{ x: 0, y: 0, width: 200, height: 40 }, { x: 0, y: 50, width: 200, height: 40 }, { x: 0, y: 100, width: 200, height: 40 }];
const row = [{ x: 0, y: 0, width: 100, height: 40 }, { x: 120, y: 0, width: 100, height: 40 }, { x: 240, y: 0, width: 100, height: 40 }];

test('stacked items: the pointer’s height picks the slot, and the line sits between them', () => {
  assert.deepEqual(dropSlot({ x: 50, y: 10 }, stacked), { slot: 0, line: { x: 0, y: -2, width: 200, height: 0 }, across: false });
  assert.deepEqual(dropSlot({ x: 50, y: 30 }, stacked), { slot: 1, line: { x: 0, y: 45, width: 200, height: 0 }, across: false });
  assert.deepEqual(dropSlot({ x: 50, y: 135 }, stacked)?.slot, 3, 'below the last');
  assert.deepEqual(dropSlot({ x: 400, y: 72 }, stacked)?.slot, 2, 'beside the list, the nearest item decides');
});

test('items in a row: the pointer’s x picks the slot, and the line stands between them', () => {
  assert.deepEqual(dropSlot({ x: 170, y: 20 }, row), { slot: 1, line: { x: 110, y: 0, width: 0, height: 40 }, across: true });
  assert.deepEqual(dropSlot({ x: 200, y: 20 }, row), { slot: 2, line: { x: 230, y: 0, width: 0, height: 40 }, across: true });
  assert.equal(dropSlot({ x: 50, y: 20 }, []), null);
});

test('a slot among the items shown is an index among all of them', () => {
  // Others: a, (b hidden), c, d. Shown: a at 0, c at 2, d at 3.
  assert.equal(finalIndex([0, 2, 3], 0, 4), 0);
  assert.equal(finalIndex([0, 2, 3], 1, 4), 2, 'before c is after the hidden b');
  assert.equal(finalIndex([0, 2, 3], 3, 4), 4, 'after the last');
  assert.equal(finalIndex([], 0, 2), 2, 'none shown: at the end');
});
