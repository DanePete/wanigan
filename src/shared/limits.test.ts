import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activityFor, nextState } from './attention.ts';
import { continueTargets, limitDetail, limitResetsAt, usageLimitMessage, whyNotTarget } from './limits.ts';
import type { Account } from './model.ts';
import { parseUsage } from './usage.ts';

// Claude Code 2.1.292's own words (read from the binary), as StopFailure carries them.
const HIT = 'You\'ve hit your session limit · resets 4:10pm (America/Chicago)';
const limitStop = { error: 'rate_limit', last_assistant_message: HIT };

test('only Claude’s "you’ve hit your limit" is a usage limit; other 429s are not', () => {
  assert.equal(usageLimitMessage('StopFailure', limitStop), HIT);
  assert.equal(usageLimitMessage('StopFailure', { error: 'rate_limit', last_assistant_message: 'API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited' }), null);
  assert.equal(usageLimitMessage('StopFailure', { error: 'rate_limit', last_assistant_message: 'Opus is experiencing high load. Switch to Sonnet.' }), null);
  assert.equal(usageLimitMessage('StopFailure', { error: 'server_error', last_assistant_message: HIT }), null);
  assert.equal(usageLimitMessage('Stop', limitStop), null);
  assert.equal(usageLimitMessage('StopFailure', { error: 'rate_limit' }), null, 'no message, no claim');
});

test('a limit is its own state, which idling does not clear and a new turn does', () => {
  assert.equal(nextState('working', 'StopFailure', limitStop), 'limited');
  assert.equal(nextState('working', 'StopFailure', { error: 'server_error' }), 'waiting', 'other failures still end the turn');
  assert.equal(nextState('limited', 'Notification', { notification_type: 'idle_prompt' }), 'limited');
  assert.equal(nextState('limited', 'Notification', { notification_type: 'quota_auto_resume_stale', message: 'Usage limit reset — press enter to continue' }), 'limited');
  assert.equal(nextState('limited', 'Notification', { notification_type: 'quota_auto_resume_disabled' }), 'limited');
  assert.equal(nextState('limited', 'Notification', { notification_type: 'quota_auto_resume_fired' }), 'working', 'Claude carrying on by itself');
  assert.equal(nextState('limited', 'UserPromptSubmit', {}), 'working');
  assert.equal(nextState('limited', 'Stop', {}), 'waiting');
  assert.equal(activityFor('StopFailure', limitStop), HIT, 'the activity is what Claude said');
  assert.equal(activityFor('StopFailure', { error: 'server_error' }), 'Turn failed');
  assert.equal(activityFor('Notification', { notification_type: 'quota_auto_resume_stale', message: 'Usage limit reset — press enter to continue' }), 'Usage limit reset — press enter to continue');
});

test('the reset is read in the zone Claude named: a time alone is today or tomorrow', () => {
  const now = Date.UTC(2026, 9, 6, 18, 0); // 1:00 pm in Chicago (CDT, UTC-5)
  assert.equal(limitResetsAt(HIT, now), Date.UTC(2026, 9, 6, 21, 10), '4:10 pm today');
  assert.equal(limitResetsAt('You\'ve hit your session limit · resets 9am (America/Chicago)', now), Date.UTC(2026, 9, 7, 14, 0), '9 am has passed today, so tomorrow');
  assert.equal(limitResetsAt('You\'ve hit your weekly limit · resets Oct 9, 4pm (America/Chicago) · progress saved', now), Date.UTC(2026, 9, 9, 21, 0));
  assert.equal(limitResetsAt('You\'ve hit your weekly limit · resets Oct 9, 4:30pm (Europe/London)', now), Date.UTC(2026, 9, 9, 15, 30));
  assert.equal(limitResetsAt('You\'ve hit your session limit · resets 4:10pm', now), null, 'no zone, no honest instant');
  assert.equal(limitResetsAt('You\'ve hit your session limit', now), null);
});

test('a limit says when it resets, or that it is not known, or that it has', () => {
  const now = Date.UTC(2026, 9, 6, 18, 0);
  assert.equal(limitDetail(null, now, 'Work'), 'Hit its usage limit on Work. When it resets is not known.');
  assert.match(limitDetail(now + 3 * 3600_000, now), /^Hit its usage limit\. Resets \d{1,2}:\d{2} [ap]m\.$/);
  assert.match(limitDetail(now + 3 * 86_400_000, now), /^Hit its usage limit\. Resets [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} [ap]m\.$/);
  assert.equal(limitDetail(now - 1, now), 'Hit its usage limit. The limit has reset: press Enter in its terminal to continue.');
});

const account = (id: string, over: Partial<Account> = {}): Account => ({
  id, provider: 'claude', label: id, configDir: `/h/.claude_${id}`, displayDir: `~/.claude_${id}`, isDefault: false, discovered: true,
  signedIn: 'yes', identity: `${id}@example.com`, plan: 'max', checkedAt: 0, installed: true, folderOk: true, usage: null, sameLoginAs: null, ...over,
});
const used = (session: number, week = 10) => parseUsage(`Current session: ${session}% used · resets Oct 7 at 3:10am (America/Chicago)\nCurrent week (all models): ${week}% used`, Date.UTC(2026, 9, 6));

test('a conversation moves only to an account with room, never to the same login', () => {
  const personal = account('personal', { usage: used(100) });
  const accounts = [
    personal,
    account('work', { usage: used(40) }),
    account('twin', { identity: 'PERSONAL@example.com', usage: used(5) }),
    account('full', { usage: used(20, 95) }),
    account('out', { signedIn: 'no', identity: null }),
    account('unread', { signedIn: 'unknown', identity: null }),
    account('quick', { usage: used(10) }),
    account('codex', { provider: 'codex' }),
    account('gone', { folderOk: false }),
  ];
  const targets = continueTargets(accounts, 'personal');
  assert.deepEqual(targets.map((t) => [t.account.id, t.room]), [
    ['quick', 'session 10% used'], ['work', 'session 40% used'], ['unread', 'limits not read yet'],
  ], 'most room first; unknown room is offered and says so');
  assert.match(whyNotTarget(accounts[2] as Account, personal) ?? '', /same login as personal/);
  assert.match(whyNotTarget(accounts[3] as Account, personal) ?? '', /used 95% of its week limit/);
  assert.match(whyNotTarget(personal, personal) ?? '', /already on personal/);
  assert.match(whyNotTarget(accounts[4] as Account, personal) ?? '', /signed out/);
  assert.match(whyNotTarget(accounts[7] as Account, personal) ?? '', /codex account/);
});
