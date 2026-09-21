import assert from 'node:assert/strict';
import { test } from 'node:test';
import { automaticSpendVerdict, type AutomaticSpendInput } from './automatic-spend.ts';

const base: AutomaticSpendInput = { budgetUsd: 5, spendUsd: 0, spendStatus: 'none' };
const reason = (patch: Partial<AutomaticSpendInput>) => {
  const result = automaticSpendVerdict({ ...base, ...patch });
  return result.allowed ? 'allowed' : result.reason;
};

test('automatic spend distinguishes no prior attempt, explicit zero, missing and partial meters', () => {
  assert.equal(reason({}), 'allowed');
  assert.equal(reason({ spendStatus: 'reported' }), 'allowed');
  assert.equal(reason({ spendStatus: 'unreported' }), 'unknown-spend');
  assert.equal(reason({ spendStatus: 'partial', spendUsd: 2 }), 'unknown-spend');
  assert.equal(reason({ spendStatus: 'reported', spendUsd: 2 }), 'allowed');
  assert.equal(reason({ spendStatus: 'none', spendUsd: 2 }), 'unknown-spend');
});

test('automatic actions require a valid remaining allowance; reached partial subtotal already suffices to stop', () => {
  assert.equal(reason({ budgetUsd: null }), 'no-budget');
  assert.equal(reason({ budgetUsd: NaN }), 'no-budget');
  assert.equal(reason({ budgetUsd: Infinity }), 'no-budget');
  assert.equal(reason({ budgetUsd: -1 }), 'no-budget');
  assert.equal(reason({ budgetUsd: 0 }), 'cap');
  assert.equal(reason({ spendStatus: 'partial', spendUsd: 5 }), 'cap');
  assert.equal(reason({ spendStatus: 'reported', spendUsd: NaN }), 'unknown-spend');
  assert.equal(reason({ spendStatus: 'reported', spendUsd: -1 }), 'unknown-spend');
});
