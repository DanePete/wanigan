import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JEV_DUPLICATE_MIN, JEV_READY_MIN, jevAccepts, jevDuplicate, readAnswers } from './jev.ts';

const meta = { at: 1, model: 'fixture', latencyMs: 1 };
const candidate = { key: 'FX-1', title: 'Checkout coupon', status: 'ready' };
const invalid: readonly [string, unknown][] = [
  ['negative', -0.01], ['negative neighbor', -Number.MIN_VALUE], ['above one', 1.01], ['two', 2],
  ['upper neighbor', 1 + Number.EPSILON], ['extreme', Number.MAX_VALUE],
  ['NaN', NaN], ['infinity', Infinity], ['negative infinity', -Infinity],
  ['numeric string', '0.99'], ['boolean', true], ['null', null], ['missing', undefined], ['object', { value: 1 }],
];

for (const [name, value] of invalid) {
  test(`a ${name} probability is omitted without altering valid answer fields`, () => {
    const read = readAnswers({
      action: { choice: 'ready', confidence: value, probabilities: { ready: value, later: 0.25, close: 0 } },
      severity: { score: 2.7 }, dup_FX_1: { noul: value },
    }, [candidate], meta);
    assert.equal(read.action, 'ready');
    assert.equal(read.confidence, null);
    assert.deepEqual(read.probabilities, { later: 0.25, close: 0 });
    assert.equal(read.duplicateOf, null);
    assert.equal(read.duplicateP, null);
    assert.equal(read.severity, 2.7);
    assert.equal(read.outcome, 'read');
    assert.equal(read.error, null);
    assert.equal(jevAccepts(read, 1), false);
  });
}

test('probability endpoints and legitimate decision thresholds are preserved exactly', () => {
  for (const confidence of [0, 1, JEV_READY_MIN - Number.EPSILON, JEV_READY_MIN, JEV_READY_MIN + Number.EPSILON]) {
    const read = readAnswers({ action: { choice: 'ready', confidence, probabilities: { ready: confidence, close: 0, later: 1 } } }, [], meta);
    assert.equal(read.confidence, confidence);
    assert.deepEqual(read.probabilities, { ready: confidence, later: 1, close: 0 }, 'valid values are not renormalized');
    assert.equal(jevAccepts(read, 1), confidence >= JEV_READY_MIN);
    assert.equal(jevAccepts(read, 0), false);
    assert.equal(jevAccepts({ ...read, action: 'later' }, 1), false);
  }
  for (const duplicateP of [0, 1, JEV_DUPLICATE_MIN - Number.EPSILON, JEV_DUPLICATE_MIN, JEV_DUPLICATE_MIN + Number.EPSILON]) {
    const read = readAnswers({ dup_FX_1: { noul: duplicateP } }, [candidate], meta);
    assert.equal(read.duplicateP, duplicateP);
    assert.equal(read.duplicateOf, candidate.key);
    assert.equal(jevDuplicate(read), duplicateP >= JEV_DUPLICATE_MIN ? candidate.key : null);
  }
});

test('invalid duplicate scores cannot mask a valid candidate or be clamped into a match', () => {
  const next = { key: 'FX-2', title: 'Coupon checkout', status: 'ready' };
  const read = readAnswers({ dup_FX_1: { noul: 2 }, dup_FX_2: { noul: 0.95 } }, [candidate, next], meta);
  assert.equal(read.duplicateOf, next.key);
  assert.equal(read.duplicateP, 0.95);
  assert.equal(jevDuplicate(read), next.key);
});

test('decision helpers defend against invalid legacy values without rewriting persisted evidence', () => {
  for (const [name, value] of invalid) {
    // Old JSON records and direct JavaScript callers can violate static types.
    const legacy = { action: 'ready' as const, confidence: value as number | null, duplicateOf: candidate.key, duplicateP: value as number | null };
    assert.equal(jevAccepts(legacy, 1), false, name);
    assert.equal(jevDuplicate(legacy), null, name);
    assert.equal(legacy.confidence, value, 'the original value is not mutated');
    assert.equal(legacy.duplicateP, value);
  }
});

test('severity keeps its intentional finite zero-to-three clamp independently of probabilities', () => {
  for (const [score, expected] of [[-100, 0], [0, 0], [1.01, 1.01], [2, 2], [2.7, 2.7], [3, 3], [100, 3]] as const) {
    assert.equal(readAnswers({ severity: { score } }, [], meta).severity, expected);
  }
  for (const score of [NaN, Infinity, -Infinity, '2', undefined]) assert.equal(readAnswers({ severity: { score } }, [], meta).severity, null);
});
