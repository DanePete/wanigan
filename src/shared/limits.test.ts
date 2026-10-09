import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { activityFor, nextState } from './attention.ts';
import { continueTargets, geminiLimit, limitDetail, limitResetsAt, screenWords, usageLimitMessage, whyNotTarget } from './limits.ts';
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

// Gemini CLI 0.46's usage-limit dialog exactly as its terminal drew it (see the fixture's note).
const DIALOG = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'core', 'fixtures', 'gemini-0.46-limit-dialog.json'), 'utf8')) as { withReset: string; noReset: string };
/** How Gemini prints a reset (getResetTimeMessage), in this machine's zone, as the CLI on it would. */
const geminiTime = (at: number): string => new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(at);

test('Gemini: its limit dialog, word for word as drawn, says the limit and when it resets on this Mac’s clock', () => {
  const now = new Date(2026, 9, 9, 9, 9, 30).getTime();
  const reset = now + 2 * 3_600_000 - 30_000;
  const drawn = DIALOG.withReset.replace('11:09 AM CDT', geminiTime(reset));
  const found = geminiLimit(screenWords(drawn), now);
  assert.equal(found?.resetsAt, reset);
  assert.equal(found?.message, `Usage limit reached for all Pro models. Access resets at ${geminiTime(reset).replace(/\s+/g, ' ')}.`);
  // A time already past today is tomorrow's.
  const early = geminiLimit(screenWords(DIALOG.withReset.replace('11:09 AM CDT', geminiTime(now - 3_600_000))), now);
  assert.equal(early?.resetsAt, now - 3_600_000 + 86_400_000 - 30_000);
  // A daily quota prints no reset: the limit stands, and when it lifts is not known.
  const daily = geminiLimit(screenWords(DIALOG.noReset), now);
  assert.equal(daily?.message, 'Usage limit reached for all Pro models.');
  assert.equal(daily?.resetsAt, null);
});

test('Gemini: a reset in a zone that is not this Mac’s is not guessed at, and anything short of the whole dialog is not a limit', () => {
  const now = Date.now();
  const here = geminiTime(now).split(' ').pop();
  const elsewhere = here === 'GMT+13' ? 'GMT+12' : 'GMT+13';
  assert.equal(geminiLimit(screenWords(DIALOG.withReset.replace('CDT', elsewhere).replace(/CDT/g, elsewhere)), now)?.resetsAt, null);
  assert.equal(geminiLimit(screenWords(DIALOG.withReset.replace('AM CDT', `AM ${elsewhere}`)), now)?.resetsAt, null);
  for (const near of [
    'Usage limit reached for all Pro models.',
    'Usage limit reached for all Pro models. /model to switch models.',
    'The CLI says "Usage limit reached for all Pro models." then /stats model for usage details',
    'Usage limit reached for all Pro models. /stats model for usage details /model to switch model',
    'usage limit reached for all Pro models. /stats model for usage details /model to switch models.',
    'Usage limit reached for all Pro models. Access resets at soon. /stats model for usage details /model to switch models.',
  ]) assert.equal(geminiLimit(screenWords(near)), null, near);
  // Its own words for a model it names, and for Pro.
  assert.match(geminiLimit(screenWords('│ Usage limit reached for gemini-2.5-flash.   │\r\n│ /stats model for usage details │\r\n│ /model to switch models. │'))?.message ?? '', /gemini-2\.5-flash\.$/);
});

test('Gemini: a limit is a state of its own, with the dialog’s words as what it is doing', () => {
  assert.equal(nextState('working', 'UsageLimit', { message: 'Usage limit reached for all Pro models.' }), 'limited');
  assert.equal(activityFor('UsageLimit', { message: 'Usage limit reached for all Pro models.' }), 'Usage limit reached for all Pro models.');
  assert.equal(nextState('limited', 'UserPromptSubmit', {}), 'working', 'a new turn lifts it');
  assert.equal(nextState('limited', 'PreToolUse', {}), 'working', 'so does the turn going on, on another model');
});
