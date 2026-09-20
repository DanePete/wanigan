import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountReadingNote } from './account-reading-note.ts';
import type { AccountLimits } from './types.ts';

const now = 10 * 3_600_000;
const reading = (extra: Partial<AccountLimits>): AccountLimits => ({
  accountId: 'a', accountLabel: 'Work', harness: 'codex', identity: null, state: 'ok', detail: null,
  fetchedAt: now - 4 * 60_000, plan: null, windows: [], factors: [], ...extra,
});

test('no reading, or nothing reported against the login, says nothing', () => {
  assert.equal(accountReadingNote(undefined, now), null);
  assert.equal(accountReadingNote(reading({}), now), null);
  assert.equal(accountReadingNote(reading({ ordinaryUsageAllowed: true }), now), null);
  assert.equal(accountReadingNote(reading({ ordinaryUsageAllowed: null, detail: 'A reported reset time has passed.' }), now), null,
    'an unavailable verdict and an unrelated sentence are not evidence against the login');
  assert.equal(accountReadingNote(reading({ state: 'unreadable', detail: 'timed out' }), now), null, 'could not read is not evidence either');
  assert.equal(accountReadingNote(reading({ state: 'signed-out', fetchedAt: null }), now), null, 'a reading with no time cannot state its age');
});

test('evidence is stated with its age, as a warning about automatic phases and never as the decision', () => {
  const blocked = accountReadingNote(reading({ ordinaryUsageAllowed: false }), now);
  assert.equal(blocked?.tone, 'warn');
  assert.match(blocked!.text, /^Work’s provider reported that ordinary included usage is not currently allowed when Usage last read it, 4m ago\./);
  assert.match(blocked!.text, /automatic phases on this account are refused rather than moved to another account/);
  assert.match(blocked!.text, /a phase you start yourself still launches/);
  assert.match(blocked!.text, /read again at each launch/);
  assert.match(accountReadingNote(reading({ state: 'signed-out' }), now)!.text, /^Work had no signed-in account when Usage last read it/);
  // A verdict only counts on a reading that was actually read.
  assert.equal(accountReadingNote(reading({ state: 'unreadable', ordinaryUsageAllowed: false }), now), null);
});

test('age is said plainly at every scale', () => {
  const at = (ms: number) => accountReadingNote(reading({ state: 'signed-out', fetchedAt: now - ms }), now)!.text;
  assert.match(at(20_000), /just now/); assert.match(at(59 * 60_000), /59m ago/);
  assert.match(at(5 * 3_600_000), /5h ago/); assert.match(at(3 * 86_400_000), /3d ago/);
  assert.match(at(-5_000), /just now/, 'a clock that moved backwards is not a negative age');
});
