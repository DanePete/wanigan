import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RAIL_FOLDS_BELOW, railChoice, railCollapsed, toggledRail } from './rail.ts';

test('a narrow window folds the rail on its own; a wide one keeps it open', () => {
  assert.equal(railCollapsed(null, RAIL_FOLDS_BELOW - 1), true);
  assert.equal(railCollapsed(null, 1024), true);
  assert.equal(railCollapsed(null, RAIL_FOLDS_BELOW), false);
  assert.equal(railCollapsed(null, 1440), false);
});

test('a choice made by hand wins at any width', () => {
  assert.equal(railCollapsed('expanded', 1024), false, 'opened by hand stays open when narrow');
  assert.equal(railCollapsed('collapsed', 1440), true, 'folded by hand stays folded when wide');
});

test('a toggle chooses the opposite of what is on screen, and only two choices are read back', () => {
  assert.equal(toggledRail(railCollapsed(null, 1024)), 'expanded');
  assert.equal(toggledRail(railCollapsed(null, 1440)), 'collapsed');
  assert.equal(railChoice('collapsed'), 'collapsed');
  assert.equal(railChoice('expanded'), 'expanded');
  for (const v of [null, undefined, '', 'open', 1]) assert.equal(railChoice(v), null);
});
