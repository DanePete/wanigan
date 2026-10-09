import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Need } from './model.ts';
import {
  alertKeys, markDismissed, markNative, markWindow, nativeBatch, needKey, needRoute, nothingAnnounced, notificationFor, onScreen, plan,
  type Announced,
} from './notifications.ts';

const need = (over: Partial<Need>): Need => ({
  kind: 'permission', projectId: 'p', projectName: 'Northstar', projectKey: 'NS', cardId: 'c1', cardKey: 'NS-6',
  sessionId: 's1', provider: 'claude', title: 'Checkout button', detail: 'Asking: Bash pnpm test', since: 100, ...over,
});

/** A state after the first look at nothing: primed, nothing open. */
const primed = (): Announced => plan(nothingAnnounced(), [], false).state;

test('the first look primes without announcing, in front or not', () => {
  const open = [need({})];
  for (const focused of [true, false]) {
    const first = plan(nothingAnnounced(), open, focused);
    assert.deepEqual([first.native, first.window], [[], []]);
    const again = plan(first.state, open, !focused);
    assert.deepEqual([again.native, again.window], [[], []], 'what was open at start is not news later either');
  }
});

test('only needs not announced before are announced', () => {
  const a = need({});
  const b = need({ kind: 'review', sessionId: null, since: 200 });
  const state = markNative(primed(), [a]);
  assert.deepEqual(plan(state, [a, b], false).native, [b]);
});

test('a second permission request from the same session is a new need', () => {
  const first = need({ since: 100 });
  const again = need({ since: 900 });
  assert.deepEqual(plan(markNative(primed(), [first]), [again], false).native, [again]);
});

test('in front, a new alert goes to the window, not to macOS', () => {
  const ask = need({});
  const p = plan(primed(), [ask], true);
  assert.deepEqual(p.native, []);
  assert.deepEqual(p.window, [ask]);
  // Until the window says it showed it, it is offered again.
  assert.deepEqual(plan(p.state, [ask], true).window, [ask]);
  const shown = markWindow(p.state, [needKey(ask)]);
  assert.deepEqual(plan(shown, [ask], true).window, [], 'shown once in the window');
});

test('a need that arrived while you looked is announced when you leave, if still open', () => {
  const ask = need({});
  const seen = markWindow(plan(primed(), [ask], true).state, [needKey(ask)]);
  const away = plan(seen, [ask], false);
  assert.deepEqual(away.native, [ask], 're-announced on leaving');
  const after = markNative(away.state, away.native);
  assert.deepEqual(plan(after, [ask], false).native, [], 'once');
  assert.deepEqual(plan(after, [ask], true).window, [], 'and not again in the window on return');
  assert.deepEqual(plan(after, [], false).native, [], 'a handled need is gone');
});

test('a dismissed alert is never announced again', () => {
  const ask = need({});
  const state = markDismissed(markWindow(plan(primed(), [ask], true).state, [needKey(ask)]), [needKey(ask)]);
  assert.deepEqual(plan(state, [ask], false).native, []);
  assert.deepEqual(plan(state, [ask], true).window, []);
});

test('a finished turn seen in the window is not announced on leaving; one that came while away is', () => {
  const done = need({ kind: 'waiting', since: 300 });
  const looked = plan(primed(), [done], true);
  assert.deepEqual(looked.window, [], 'a finished turn is not an alert card');
  assert.deepEqual(plan(looked.state, [done], false).native, []);
  const later = need({ kind: 'waiting', since: 400 });
  assert.deepEqual(plan(looked.state, [done, later], false).native, [later]);
});

test('closed needs are forgotten, so the state does not grow', () => {
  const ask = need({});
  const state = markDismissed(markNative(markWindow(primed(), [needKey(ask)]), [ask]), [needKey(ask)]);
  const next = plan(state, [], false).state;
  assert.deepEqual([next.native?.size, next.window.size, next.dismissed.size], [0, 0, 0]);
});

test('a burst becomes the two most urgent and one line for the rest', () => {
  const three = [need({ since: 1 }), need({ since: 2 }), need({ since: 3 })];
  assert.deepEqual(nativeBatch(three), { single: three, rest: null });
  const five = [...three, need({ since: 4, projectName: 'Orbit API' }), need({ since: 5, projectName: 'Fieldnotes' })];
  const batch = nativeBatch(five);
  assert.deepEqual(batch.single, five.slice(0, 2));
  assert.deepEqual(batch.rest, { title: '3 more need you', body: 'In Northstar, Orbit API, Fieldnotes' });
});

test('what is on screen is not an alert', () => {
  const ask = need({});
  assert.equal(onScreen(ask, { route: 'needs', projectKey: null, sessionId: null, cardKey: null }), true);
  assert.equal(onScreen(ask, { route: 'session', projectKey: 'NS', sessionId: 's1', cardKey: null }), true);
  assert.equal(onScreen(ask, { route: 'session', projectKey: 'NS', sessionId: 's2', cardKey: null }), false, 'another session in the same project');
  assert.equal(onScreen(ask, { route: 'project', projectKey: 'NS', sessionId: null, cardKey: null }), true);
  assert.equal(onScreen(ask, { route: 'project', projectKey: 'OA', sessionId: null, cardKey: null }), false);
  assert.equal(onScreen(ask, { route: 'project', projectKey: 'OA', sessionId: null, cardKey: 'NS-6' }), true, 'its card is open');
  assert.equal(onScreen(ask, { route: 'other', projectKey: null, sessionId: null, cardKey: null }), false);
});

test('keys from the window are checked before they are believed', () => {
  assert.deepEqual(alertKeys('permission:s1::1'), []);
  assert.deepEqual(alertKeys(['a', 3, null, '', 'x'.repeat(401), 'b']), ['a', 'b']);
  assert.equal(alertKeys(Array.from({ length: 900 }, (_, i) => `k${i}`)).length, 500);
});

test('a notification opens where the need is answered', () => {
  assert.equal(needRoute(need({})), '#/p/NS/s/s1');
  assert.equal(needRoute(need({ kind: 'review', sessionId: null })), '#/p/NS/board?card=NS-6');
  assert.equal(needRoute(need({ kind: 'question' })), '#/p/NS/board?card=NS-6');
});

test('notifications say what and where in plain words', () => {
  assert.deepEqual(notificationFor(need({})), { title: 'NS-6 needs permission', body: 'Asking: Bash pnpm test' });
  assert.equal(notificationFor(need({ kind: 'review' })).title, 'NS-6 is ready for review');
  assert.equal(notificationFor(need({ kind: 'failed', cardKey: null, title: 'Shell · Orbit API' })).title, 'Shell · Orbit API: session failed');
});

test('only permission and failures, or nothing, as the owner chose', () => {
  const ask = need({});
  const review = need({ kind: 'review', sessionId: null, since: 200 });
  const failed = need({ kind: 'failed', since: 300 });
  const done = need({ kind: 'waiting', since: 400 });
  const open = [ask, review, failed, done];
  assert.deepEqual(plan(primed(), open, false, 'urgent').native, [ask, failed]);
  assert.deepEqual(plan(primed(), open, true, 'urgent').window, [ask, failed]);
  assert.deepEqual(plan(primed(), open, false, 'off').native, []);
  assert.deepEqual(plan(primed(), open, true, 'off').window, []);
  assert.deepEqual(plan(primed(), open, false, 'all').native, open);
  // Turning notifications back on does not replay what was already open.
  const quiet = plan(primed(), open, false, 'off').state;
  assert.deepEqual(plan(quiet, open, false, 'all').native, []);
  const later = need({ since: 900 });
  assert.deepEqual(plan(quiet, [...open, later], false, 'all').native, [later]);
});
