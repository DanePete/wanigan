import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refusalOf } from './live-refusal.ts';

test('a 409 with the order as it is now is the collection having changed: said with what was not done', () => {
  const r = refusalOf({ status: 409, answer: { ok: false, items: ['p2', 'p1'], error: 'x' }, error: null }, 'added');
  assert.equal(r.conflict, true);
  assert.deepEqual(r.items, ['p2', 'p1']);
  assert.match(r.error, /nothing was added\./);
});

test('a 409 without an order is the helper refusing for its own reason, said in its words', () => {
  const r = refusalOf({ status: 409, answer: { ok: false, error: 'The page this came from is more than ten minutes old. Reload it, and try again.' }, error: null }, 'added');
  assert.equal(r.conflict, false);
  assert.equal(r.items, null);
  assert.equal(r.error, 'The page this came from is more than ten minutes old. Reload it, and try again.');
});

test('other refusals: the helper words first, then what the status says', () => {
  assert.equal(refusalOf({ status: 403, answer: null, error: null }).error, 'The site refused: the user logged in in the live view may not change this.');
  assert.equal(refusalOf({ status: 0, answer: null, error: 'timeout' }).error, 'The site did not answer: timeout.');
  assert.equal(refusalOf({ status: 422, answer: { error: 'That cannot go there.' }, error: null }).error, 'That cannot go there.');
});
