import assert from 'node:assert/strict';
import { test } from 'node:test';
import { duplicateCandidates, jevAccepts, jevDuplicate, jevQuestions, readAnswers, severityLabel } from './jev.ts';

const meta = { at: 1, model: 'jev-1.13', latencyMs: 300 };

test('questions: severity always; action and one yes/no per candidate only while triaging', () => {
  const candidates = [{ key: 'NS-4', title: 'Coupon rejected', status: 'ready' }];
  assert.deepEqual(Object.keys(jevQuestions(false, candidates)), ['severity']);
  assert.deepEqual(Object.keys(jevQuestions(true, candidates)), ['severity', 'action', 'dup_NS_4']);
  assert.equal(jevQuestions(true, candidates).dup_NS_4?.type, 'noul');
});

test('answers: malformed parts are left out, never guessed', () => {
  const read = readAnswers({
    action: { choice: 'teleport', confidence: 0.99 },
    severity: { score: 7 },
    dup_NS_4: { noul: 'yes' },
  }, [{ key: 'NS-4', title: 'x', status: 'ready' }], meta);
  assert.equal(read.action, null, 'an action Wanigan does not know is ignored');
  assert.equal(read.confidence, null);
  assert.equal(read.severity, 3, 'clamped to the scale');
  assert.equal(read.duplicateOf, null);

  const good = readAnswers({
    action: { choice: 'merge', confidence: 0.82, probabilities: { merge: 0.82, ready: 0.1, bogus: 1 } },
    dup_NS_4: { noul: 0.4 }, dup_NS_9: { noul: 0.93 },
  }, [{ key: 'NS-4', title: 'a', status: 'ready' }, { key: 'NS-9', title: 'b', status: 'inbox' }], meta);
  assert.equal(good.action, 'merge');
  assert.deepEqual(good.probabilities, { ready: 0.1, merge: 0.82 });
  assert.equal(good.duplicateOf, 'NS-9');
  assert.equal(jevDuplicate(good), 'NS-9');
  assert.equal(jevDuplicate({ duplicateOf: 'NS-4', duplicateP: 0.4 }), null);
});

test('Accept moves only a confident ready that already says what done means', () => {
  assert.equal(jevAccepts({ action: 'ready', confidence: 0.85 }, 1), true);
  assert.equal(jevAccepts({ action: 'ready', confidence: 0.85 }, 0), false);
  assert.equal(jevAccepts({ action: 'ready', confidence: 0.79 }, 2), false);
  assert.equal(jevAccepts({ action: 'close', confidence: 0.99 }, 2), false);
});

test('duplicate candidates are chosen by shared words, not by key', () => {
  const others = [
    { key: 'NS-1', title: 'Checkout coupon field rejects valid codes', status: 'ready' },
    { key: 'NS-2', title: 'Update the footer links', status: 'ready' },
    { key: 'NS-3', title: 'Coupon codes at checkout are refused', status: 'inbox' },
  ];
  const found = duplicateCandidates({ key: 'NS-9', title: 'Valid coupon codes rejected at checkout' }, others);
  assert.deepEqual(found.map((c) => c.key), ['NS-1', 'NS-3']);
  assert.deepEqual(duplicateCandidates({ key: 'NS-9', title: 'a b' }, others), []);
});

test('severity labels round to the nearest step', () => {
  assert.match(severityLabel(0.4), /cosmetic/);
  assert.match(severityLabel(2.6), /breaks something important/);
});

test('an answer naming an object\'s own machinery is no action at all', () => {
  for (const choice of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    const read = readAnswers({ action: { choice } }, [], { at: 0, model: null, latencyMs: null });
    assert.equal(read.action, null, choice);
  }
});
