/**
 * Goal loop budgets: when a dispatch is held, and for which reason.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatchVerdict, isHoldReason, numstatTotals, parseLoopBudgets } from './goal-budgets.ts';

const none = { maxRounds: null, maxChangedLines: null };

test('no limits never hold', () => {
  assert.deepEqual(dispatchVerdict('implement', none, { implementRounds: 40, changedLines: 90_000 }), { hold: null });
});

test('rounds hold the next implementation dispatch once the limit is reached, and only implementation', () => {
  const b = { maxRounds: 3, maxChangedLines: null };
  assert.equal(dispatchVerdict('implement', b, { implementRounds: 2, changedLines: null }).hold, null);
  const held = dispatchVerdict('implement', b, { implementRounds: 3, changedLines: null });
  assert.equal(held.hold, 'needs-human: attempts');
  assert.match(held.hold ? held.detail : '', /3 implementation rounds have run and this goal allows 3/);
  assert.equal(dispatchVerdict('verify', b, { implementRounds: 9, changedLines: null }).hold, null);
  assert.match((dispatchVerdict('implement', { maxRounds: 1, maxChangedLines: null }, { implementRounds: 1, changedLines: null }) as { detail: string }).detail, /1 implementation round has run/);
});

test('diff size holds any dispatch over the limit, and an unmeasured tree holds nothing', () => {
  const b = { maxRounds: null, maxChangedLines: 500 };
  assert.equal(dispatchVerdict('verify', b, { implementRounds: 1, changedLines: 500 }).hold, null);
  const held = dispatchVerdict('verify', b, { implementRounds: 1, changedLines: 501, binaryFiles: 2 });
  assert.equal(held.hold, 'needs-human: diff size');
  assert.match(held.hold ? held.detail : '', /501 changed lines .* limit of 500\. 2 binary files are not counted/);
  assert.equal(dispatchVerdict('implement', b, { implementRounds: 1, changedLines: null }).hold, null);
});

test('attempts are named before diff size when both are over', () => {
  assert.equal(dispatchVerdict('implement', { maxRounds: 2, maxChangedLines: 10 }, { implementRounds: 2, changedLines: 99 }).hold, 'needs-human: attempts');
});

test('budgets from untrusted input: whole numbers in range or no limit, never clamped', () => {
  assert.deepEqual(parseLoopBudgets({ maxRounds: 3, maxChangedLines: 500 }), { maxRounds: 3, maxChangedLines: 500 });
  assert.deepEqual(parseLoopBudgets({}), none);
  assert.deepEqual(parseLoopBudgets(null), none);
  for (const bad of [{ maxRounds: 0 }, { maxRounds: 2.5 }, { maxRounds: '3' }, { maxChangedLines: -1 }, { maxRounds: 51 }]) {
    assert.throws(() => parseLoopBudgets(bad), /whole number/);
  }
});

test('numstat totals count lines and set binary files apart', () => {
  const out = '10\t2\tsrc/a.ts\u0000-\t-\tdocs/flow.png\u00003\t0\tREADME.md\u0000';
  assert.deepEqual(numstatTotals(out), { lines: 15, files: 3, binary: 1 });
  assert.deepEqual(numstatTotals(''), { lines: 0, files: 0, binary: 0 });
});

test('hold reasons are a closed list', () => {
  assert.ok(isHoldReason('needs-human: attempts'));
  assert.ok(!isHoldReason('needs-human'));
});
