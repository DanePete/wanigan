import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconciliationRefusal, recoveryReceiptCurrent, type RecoveryObservation } from './recovery.ts';

const observation: RecoveryObservation = {
  key: 'review:one', module: 'review', operationId: 'one', cwd: '/checkout',
  execution: 'confirmed finished', checkout: 'held', billing: 'independent',
  source: 'owner never attempted spawn; finalizer complete', observedAt: 1,
  reason: 'prospective evidence', revision: 'one', canReconcile: true,
};
test('only a supported owner completion authorizes reconciliation', () => {
  assert.equal(reconciliationRefusal(observation), null);
  for (const execution of ['unknown', 'unsupported', 'owned/live'] as const) {
    assert.ok(reconciliationRefusal({ ...observation, execution }));
  }
  assert.ok(reconciliationRefusal({ ...observation, canReconcile: false }));
});
test('execution reconciliation does not require or manufacture a settled bill', () => {
  const remote = { ...observation, billing: 'unresolved' as const };
  assert.equal(reconciliationRefusal(remote), null);
  assert.equal(remote.billing, 'unresolved');
});
test('receipts expire and bind both generation and exact observed revision', () => {
  const current = { now: 1, expiresAt: 2, expectedGeneration: 'a', generation: 'a', expectedRevision: 'r', revision: 'r' };
  assert.ok(recoveryReceiptCurrent(current));
  assert.equal(recoveryReceiptCurrent({ ...current, now: 2 }), false);
  assert.equal(recoveryReceiptCurrent({ ...current, generation: 'b' }), false);
  for (const revision of ['new claim', 'late completion', 'different checkout']) {
    assert.equal(recoveryReceiptCurrent({ ...current, revision }), false);
  }
});
