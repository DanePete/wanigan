import { test } from 'node:test';
import assert from 'node:assert/strict';
import { confirmsLogin, eligibilityVerdict, type EligibilityReading } from './account-eligibility.ts';

const ok: EligibilityReading = { authState: 'signed-in', requiresLogin: true, ordinaryUsageAllowed: true, loginDigest: 'a', failure: null };
const verdict = (reading: Partial<EligibilityReading>, attended: boolean, prior: string | null = 'a') =>
  eligibilityVerdict({ reading: { ...ok, ...reading }, priorLoginDigest: prior, attended, accountLabel: 'Work' });

test('a verified login with a usable allowance launches without comment', () => {
  assert.deepEqual(verdict({}, false), { refusal: null, notes: [] });
  assert.deepEqual(verdict({}, true), { refusal: null, notes: [] });
});

test('unknown quota never refuses: it is the normal state where no free quota read exists', () => {
  assert.equal(verdict({ ordinaryUsageAllowed: null }, false).refusal, null);
  assert.deepEqual(verdict({ ordinaryUsageAllowed: null }, false).notes, []);
});

test('unattended work is refused on evidence, and never re-routed', () => {
  for (const reading of [{ authState: 'signed-out' as const }, { ordinaryUsageAllowed: false }, { loginDigest: 'b' }]) {
    const refused = verdict(reading, false);
    assert.match(refused.refusal ?? '', /Unattended work was not started, and no other account was tried\.$/);
  }
  assert.match(verdict({ loginDigest: 'b' }, false).refusal ?? '', /different login than the one last confirmed/);
});

test('an attended launch is never refused, because a session is how a signed-out account signs in', () => {
  const told = verdict({ authState: 'signed-out', ordinaryUsageAllowed: false, loginDigest: 'b' }, true);
  assert.equal(told.refusal, null);
  assert.equal(told.notes.length, 3);
});

test('a login that could not be asked about is said, not refused: an old CLI cannot answer either', () => {
  const failed = verdict({ authState: 'unknown', loginDigest: null, failure: 'did not respond within 12 seconds.' }, false);
  assert.equal(failed.refusal, null);
  assert.match(failed.notes[0], /could not be checked before launch: did not respond/);
  assert.match(verdict({ authState: 'unknown', loginDigest: null }, false).notes[0], /did not say who is signed in/);
});

test('no login required is not signed out, and a first or unreported login is not a change', () => {
  assert.equal(verdict({ authState: 'signed-out', requiresLogin: false }, false).refusal, null);
  assert.equal(verdict({ loginDigest: 'b' }, false, null).refusal, null);
  assert.equal(verdict({ loginDigest: null }, false).refusal, null);
});

test('only an attended launch by a signed-in, identified login confirms it', () => {
  assert.equal(confirmsLogin({ attended: true, reading: ok }), true);
  assert.equal(confirmsLogin({ attended: false, reading: ok }), false);
  assert.equal(confirmsLogin({ attended: true, reading: { ...ok, authState: 'signed-out' } }), false);
  assert.equal(confirmsLogin({ attended: true, reading: { ...ok, loginDigest: null } }), false);
});
