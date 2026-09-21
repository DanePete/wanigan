import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DecisionReceipts } from './decision-receipts.ts';

test('a preview reuses only the main-owned decision for unchanged inputs', () => {
  const receipts = new DecisionReceipts<{ model: string }>();
  const original = { model: 'economy' };
  receipts.put('a', 'input+profile+policy', original, 0);
  original.model = 'tampered';
  const result = receipts.read('a', 'input+profile+policy', 1);
  assert.equal(result.model, 'economy');
  result.model = 'tampered';
  assert.equal(receipts.read('a', 'input+profile+policy', 2).model, 'economy');
  assert.throws(() => receipts.read('a', 'different profile', 2), /changed/);
  assert.throws(() => receipts.read({ model: 'tampered' }, 'input+profile+policy', 2), /Preview/);
  receipts.remove('a');
  assert.throws(() => receipts.read('a', 'input+profile+policy', 2), /already used/);
});

test('expiry and bounded eviction require another deliberate preview', () => {
  const receipts = new DecisionReceipts<number>(100, 2);
  assert.equal(receipts.put('a', 'same', 1, 0), 100);
  receipts.put('b', 'same', 2, 10);
  receipts.put('c', 'same', 3, 20);
  assert.throws(() => receipts.read('a', 'same', 20), /expired/);
  assert.equal(receipts.read('b', 'same', 109), 2);
  assert.throws(() => receipts.read('b', 'same', 110), /expired/);
  assert.equal(receipts.read('c', 'same', 119), 3);
});
