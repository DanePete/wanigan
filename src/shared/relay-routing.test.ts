import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readRelayRouting } from './relay-routing.ts';

test('Relay keeps the operator routing mode and preference together', () => {
  assert.deepEqual(readRelayRouting(undefined), { mode: 'auto', preference: 'cost' });
  for (const mode of ['auto', 'manual']) {
    for (const preference of ['cost', 'balanced', 'quality']) {
      assert.deepEqual(readRelayRouting({ mode, preference }), { mode, preference });
    }
  }
});

test('invalid routing controls are refused instead of silently spending on Auto', () => {
  for (const raw of [null, false, [], 'manual', {}, { mode: 'manual' },
    { mode: 'automatic', preference: 'cost' }, { mode: 'auto', preference: 'free' },
    { mode: 'auto', preference: 'cost', skipReview: true }]) {
    assert.throws(() => readRelayRouting(raw));
  }
});
