/**
 * Which one thing the companion says, and when it says nothing.
 *
 * Two failure modes are worth more than the happy path. Saying several things
 * at once turns a face into a notification tray, so exactly one candidate may
 * ever win. And quoting a number Wanigan did not measure — an account state
 * that is an apology rather than a reading, or a percentage from an hour ago —
 * is the same error the orb has refused to make since it was written.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LIMITS_FRESH_FOR_MS, LIMIT_AT, companionSays, roomierAccount,
} from './companion-says.ts';
import type { ContextReading } from './orb-story.ts';
import type { AccountLimits } from './types.ts';

const now = 1_800_000_000_000;

const account = (over: Partial<AccountLimits> = {}): AccountLimits => ({
  accountId: 'a_work', accountLabel: 'Work', harness: 'codex', identity: null,
  state: 'ok', detail: null, fetchedAt: now, plan: 'Pro',
  windows: [{ kind: 'week', scope: null, usedPercent: 95, resetsAtText: 'Friday 4:15pm', resetsAt: now + 3600_000 }],
  factors: [], ...over,
});

const roomy = () => account({
  accountId: 'a_personal', accountLabel: 'Personal',
  windows: [{ kind: 'week', scope: null, usedPercent: 12, resetsAtText: null, resetsAt: null }],
});

const reading = (over: Partial<ContextReading> = {}): ContextReading => ({
  sessionId: 's1', label: 'Refactor', ratio: 0.92, estimated: false, at: now - 1_000, note: 'Reported', ...over,
});

const say = (over: Partial<Parameters<typeof companionSays>[0]> = {}) => companionSays({
  reading: undefined, limits: [account(), roomy()], limitsAt: now - 1_000,
  sessionAccountId: 'a_work', now, showingContext: false, ...over,
});

test('a reached limit outranks a filling context window', () => {
  // Both are true here. Only one may be said, and it is the one that blocks
  // work rather than the one that invites a choice.
  const said = say({ reading: reading() });
  assert.equal(said?.kind, 'limit');
  assert.match(said!.said, /Work is at 95% of its week limit/);
  assert.match(said!.said, /resets Friday 4:15pm/);
});

test('with no limit pressure the context message is free to speak', () => {
  const said = say({ limits: [account({ windows: [{ kind: 'week', scope: null, usedPercent: 10, resetsAtText: null, resetsAt: null }] })], reading: reading() });
  assert.equal(said?.kind, 'context');
  assert.match(said!.said, /92% of its window/);
});

test('an account state that is an apology is never quoted as a percentage', () => {
  // Each of these carries a reason in `detail`; a reason is not a reading.
  for (const state of ['stale', 'unreadable', 'signed-out', 'unsupported'] as const) {
    const said = say({ limits: [account({ state }), roomy()], reading: undefined });
    assert.equal(said, null, `state ${state} must produce no message`);
  }
});

test('limits older than the freshness window are not repeated as current', () => {
  // Limits are only read when somebody visits Usage, so what is in hand can be
  // arbitrarily old; quoting it as though it were now is the assumed-window
  // mistake in another costume.
  assert.equal(say({ limitsAt: now - LIMITS_FRESH_FOR_MS - 1 })?.kind, undefined);
  assert.equal(say({ limitsAt: now - LIMITS_FRESH_FOR_MS + 1_000 })?.kind, 'limit');
  assert.equal(say({ limitsAt: null }), null);
  assert.equal(say({ limits: null }), null);
});

test('the threshold is a floor, and a session with no account says nothing', () => {
  const at = (percent: number) => say({
    limits: [account({ windows: [{ kind: 'week', scope: null, usedPercent: percent, resetsAtText: null, resetsAt: null }] })],
  });
  assert.equal(at(LIMIT_AT)?.kind, 'limit');
  assert.equal(at(LIMIT_AT - 1), null);
  assert.equal(say({ sessionAccountId: null }), null);
  assert.equal(say({ sessionAccountId: 'a_unknown' }), null);
});

test('it offers another account only when that one has real room', () => {
  const pressed = account();
  assert.equal(roomierAccount([pressed, roomy()], pressed, 95)?.accountId, 'a_personal');
  // A lateral move into an account nearly as full is not worth proposing.
  const alsoFull = account({ accountId: 'a_other', accountLabel: 'Other',
    windows: [{ kind: 'week', scope: null, usedPercent: 88, resetsAtText: null, resetsAt: null }] });
  assert.equal(roomierAccount([pressed, alsoFull], pressed, 95), null);
  // Nor is an account belonging to a different agent.
  const otherHarness = roomy();
  assert.equal(roomierAccount([pressed, { ...otherHarness, harness: 'claude-code' }], pressed, 95), null);
  // Nor one whose own numbers are unreadable.
  assert.equal(roomierAccount([pressed, { ...roomy(), state: 'unreadable' }], pressed, 95), null);
});

test('with nowhere roomier to go it reports without proposing', () => {
  const said = say({ limits: [account()] });
  assert.equal(said?.kind, 'limit');
  assert.equal(said!.ask, null, 'no invitation when there is nowhere to accept it');
  assert.equal(said!.accountId, undefined);
});

test('a scoped window names its scope', () => {
  const said = say({ limits: [account({
    windows: [{ kind: 'session', scope: 'Opus', usedPercent: 96, resetsAtText: null, resetsAt: null }] })] });
  assert.match(said!.said, /96% of its Opus session limit\./);
});
