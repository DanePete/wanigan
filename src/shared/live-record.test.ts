import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  KEY_FRAMES_MAX, RECORD_MAX_MS, chooseKeyFrames, cleanStep, clock, isErrorStep, pathOnly, recordContext, requestWorthKeeping, stepLogText,
  type LiveStep,
} from './live-record.ts';

const T0 = 1_760_000_000_000;
const SITE = 'acme.example.test';

test('a password field’s keys and words are never kept, only that a key was pressed in one', () => {
  // As the page script would send them, and as a page that tried to smuggle the words through would.
  const key = cleanStep({ type: 'key', time: T0 + 1200, key: 'h', secret: true, target: 'input “Password”' }, T0, SITE);
  assert.deepEqual(key, { type: 'key', at: 1200, key: null, secret: true, target: 'input “Password”' });
  const enter = cleanStep({ type: 'key', time: T0 + 1300, key: 'Enter', secret: true, target: 'input “Password”' }, T0, SITE);
  assert.equal(enter?.type === 'key' && enter.key, null, 'not even which named key');
  const typed = cleanStep({ type: 'typed', time: T0 + 1250, text: 'hunter2', secret: true, target: 'input “Password”', value: 'hunter2' }, T0, SITE);
  assert.deepEqual(typed, { type: 'typed', at: 1250, text: null, secret: true, target: 'input “Password”' });
  assert.ok(!JSON.stringify([key, enter, typed]).includes('hunter2'));
  assert.ok(!JSON.stringify([key, enter, typed]).includes('"h"'));
  // A plain field keeps what was typed; a named key is kept; any other key is only "a key".
  assert.deepEqual(cleanStep({ type: 'typed', time: T0 + 10, text: 'flour', secret: false, target: 'input “Search”' }, T0, SITE),
    { type: 'typed', at: 10, text: 'flour', secret: false, target: 'input “Search”' });
  assert.equal((cleanStep({ type: 'key', time: T0, key: 'Enter', secret: false }, T0, SITE) as Extract<LiveStep, { type: 'key' }>).key, 'Enter');
  assert.equal((cleanStep({ type: 'key', time: T0, key: 'F13', secret: false }, T0, SITE) as Extract<LiveStep, { type: 'key' }>).key, 'a key');
  // The log says so in words.
  assert.equal(stepLogText([key as LiveStep, typed as LiveStep]),
    '0:01.2  Pressed a key in a password field (input “Password”); the key is not kept\n0:01.3  Typed in a password field (input “Password”); the keys are not kept');
});

test('a request keeps its method, path, status and time: never its body, headers, cookies, query or credentials', () => {
  const raw = {
    type: 'request', time: T0 + 5000, method: 'POST', url: 'https://user:secret@acme.example.test/cart/add?token=abc123#x', status: 500, ms: 312,
    body: '{"card":"4111"}', requestHeaders: { Cookie: 'SESS=1' }, responseHeaders: { 'Set-Cookie': 'SESS=2' }, cookies: ['SESS=3'], response: 'Error',
  };
  const step = cleanStep(raw, T0, SITE);
  assert.deepEqual(step, { type: 'request', at: 5000, method: 'POST', path: '/cart/add', status: 500, error: null, ms: 312 });
  for (const leak of ['4111', 'SESS', 'abc123', 'secret', 'user', 'Error']) assert.ok(!JSON.stringify(step).includes(leak), leak);
  // Another host is named; a network error is Chromium's code alone.
  assert.equal(pathOnly('https://cdn.example.test/a.js?v=2', SITE), 'cdn.example.test/a.js');
  const failed = cleanStep({ type: 'request', time: T0, method: 'GET', url: 'https://acme.example.test/api', error: 'net::ERR_CONNECTION_REFUSED at somewhere' }, T0, SITE);
  assert.equal(failed?.type === 'request' && failed.error, 'net::ERR_CONNECTION_REFUSED');
  // A navigation keeps the path and drops the query.
  assert.deepEqual(cleanStep({ type: 'navigate', time: T0 + 1, url: 'https://acme.example.test/events?session=xyz', status: 200 }, T0, SITE),
    { type: 'navigate', at: 1, path: '/events', status: 200, inPage: false });
  // Only failures and slow ones are worth keeping.
  assert.equal(requestWorthKeeping(200, null, 80), false);
  assert.equal(requestWorthKeeping(200, null, 1500), true);
  assert.equal(requestWorthKeeping(404, null, 10), true);
  assert.equal(requestWorthKeeping(null, 'net::ERR_ABORTED', 10), false, 'a load another replaced is not a failure');
});

test('steps are checked: an unknown kind is dropped, times are from the start and inside the limit, narration is kept', () => {
  assert.equal(cleanStep({ type: 'eval', code: 'x' }, T0, SITE), null);
  assert.equal(cleanStep(null, T0, SITE), null);
  assert.equal(cleanStep({ type: 'click', time: T0 }, T0, SITE), null, 'a click needs where');
  assert.equal(cleanStep({ type: 'console', time: T0 - 500, text: 'x' }, T0, SITE)?.at, 0);
  assert.equal(cleanStep({ type: 'console', time: T0 + 10 * RECORD_MAX_MS, text: 'x' }, T0, SITE)?.at, RECORD_MAX_MS);
  assert.deepEqual(cleanStep({ type: 'said', at: 4200, text: 'This button should be blue.' }, T0, SITE), { type: 'said', at: 4200, text: 'This button should be blue.' });
  const click = cleanStep({ type: 'click', time: T0 + 900, x: 412.4, y: 220, target: 'button “Add to cart”', part: 'p-hours', made: 'template block--hours.html.twig', style: { color: 'red' } }, T0, SITE);
  assert.deepEqual(click, { type: 'click', at: 900, x: 412, y: 220, target: 'button “Add to cart”', selector: null, part: 'p-hours', made: 'template block--hours.html.twig' });
  // The trace's own name for the part, when the window has it.
  assert.equal(stepLogText([click as LiveStep], (id) => (id === 'p-hours' ? { label: 'Opening hours', kind: 'block' } : null)),
    '0:00.9  Clicked button “Add to cart” (in Opening hours, block; template block--hours.html.twig) at 412, 220');
  assert.equal(clock(61_250), '1:01.3');
});

const frames = (n: number, every = 200): { at: number }[] => Array.from({ length: n }, (_, i) => ({ at: i * every }));
const click = (at: number, target = 'link'): LiveStep => ({ type: 'click', at, x: 1, y: 1, target, selector: null, part: null, made: null });

test('key frames: the frame clicked on, the page once it came, an error as it happened', () => {
  const steps: LiveStep[] = [
    click(1_050, 'link “Events”'),
    { type: 'navigate', at: 1_200, path: '/events', status: 200, inPage: false },
    { type: 'scroll', at: 3_000, y: 400, height: 2000 },
    { type: 'console', at: 4_010, text: 'TypeError: x is undefined' },
    { type: 'request', at: 4_500, method: 'GET', path: '/slow', status: 200, error: null, ms: 1800 },
  ];
  const chosen = chooseKeyFrames(steps, frames(40));
  assert.deepEqual(chosen.map((c) => [c.frame, c.step, c.why]), [
    [5, 0, 'clicked link “Events”'], // the last frame at or before 1050 ms
    [10, 1, 'went to /events'], // the first at or after 1200 + 800 ms
    [21, 3, 'a console error'], // the first at or after 4010 ms
  ]);
  // A scroll and a slow request that worked choose nothing.
  assert.ok(!chosen.some((c) => c.step === 2 || c.step === 4));
  // Nothing happened: the first frame and the last.
  assert.deepEqual(chooseKeyFrames([], frames(10)).map((c) => [c.frame, c.why]), [[0, 'as it began'], [9, 'as it ended']]);
  assert.deepEqual(chooseKeyFrames(steps, []), []);
});

test('key frames: never more than eight; errors first, then navigations, then clicks spread over the recording', () => {
  const steps: LiveStep[] = [];
  for (let i = 0; i < 20; i++) steps.push(click(i * 3_000 + 100, `button ${i}`));
  steps.push({ type: 'navigate', at: 10_000, path: '/a', status: 200, inPage: false });
  steps.push({ type: 'request', at: 30_000, method: 'POST', path: '/cart', status: 500, error: null, ms: 40 });
  steps.push({ type: 'console', at: 50_000, text: 'Uncaught' });
  steps.sort((a, b) => a.at - b.at);
  const chosen = chooseKeyFrames(steps, frames(400, 150));
  assert.equal(chosen.length, KEY_FRAMES_MAX);
  const kinds = chosen.map((c) => steps[c.step as number]?.type);
  assert.equal(kinds.filter((k) => k === 'request' || k === 'console').length, 2, 'both errors');
  assert.equal(kinds.filter((k) => k === 'navigate').length, 1);
  assert.equal(kinds.filter((k) => k === 'click').length, 5);
  // In time order, the clicks from the first to the last.
  assert.deepEqual([...chosen].sort((a, b) => a.frame - b.frame), chosen);
  const clicks = chosen.filter((c) => steps[c.step as number]?.type === 'click').map((c) => (steps[c.step as number] as { target: string }).target);
  assert.equal(clicks[0], 'button 0');
  assert.equal(clicks[clicks.length - 1], 'button 19');
  // Two moments on one frame are one key frame, named by the more telling one.
  const same = chooseKeyFrames([click(100), { type: 'console', at: 100, text: 'x' }], [{ at: 0 }, { at: 5_000 }]);
  assert.equal(same.length, 2);
  assert.ok(isErrorStep({ type: 'request', at: 0, method: 'GET', path: '/', status: null, error: 'net::ERR_FAILED', ms: null }));
});

test('the composer’s words for a recording: where, how long, the frames attached in order, no video, and the log', () => {
  const steps: LiveStep[] = [
    click(1_000, 'button “Book”'),
    { type: 'typed', at: 2_000, text: null, secret: true, target: 'input “Password”' },
    { type: 'said', at: 2_500, text: 'Now it hangs.' },
  ];
  const text = recordContext({
    url: 'https://acme.example.test/book', viewWidth: 1180, ms: 42_400, steps,
    keyFrames: [{ at: 1_000, why: 'clicked button “Book”' }], cut: false,
  });
  assert.equal(text, [
    'Recorded in the live view of https://acme.example.test/book (the view 1180 px wide), 0:42 long.',
    'Key frames attached, in order: 1 at 0:01.0 (clicked button “Book”).',
    'The video stays with the owner: an agent gets these pictures and this log, not the video.',
    '',
    'Steps, from the start:',
    '0:01.0  Clicked button “Book” at 1, 1',
    '0:02.0  Typed in a password field (input “Password”); the keys are not kept',
    '0:02.5  Said: “Now it hangs.”',
  ].join('\n'));
});
