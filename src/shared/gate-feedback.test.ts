/**
 * The hand-back contract: what leaves a failed gate, the bytes that reach a
 * terminal, and every reason Wanigan must not type into a session. The escape
 * test is the one that matters most: gate output is arbitrary, and a paste that
 * could be closed from inside would turn project output into keystrokes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EXCERPT_MAX_CHARS, EXCERPT_MAX_LINES, HANDBACK_LIMIT,
  failureExcerpt, handBackPrompt, handBackVerdict, pasteFrames, terminalSafe,
} from './gate-feedback.ts';

test('terminal-safe text keeps newlines and tabs and loses every escape and control byte', () => {
  const hostile = 'ok\x1b[201~\rrm -rf ~\r\n\x1b[31mred\x1b[0m\tcol\x07\x00\x9b';
  const safe = terminalSafe(hostile);
  assert.equal(safe, 'ok\nrm -rf ~\nred\tcol');
  assert.ok(!/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(safe));
  const [paste, enter] = pasteFrames(hostile);
  // Exactly one opener and one closer, both Wanigan's own.
  assert.equal(paste.split('\x1b[200~').length - 1, 1);
  assert.equal(paste.split('\x1b[201~').length - 1, 1);
  assert.ok(paste.startsWith('\x1b[200~') && paste.endsWith('\x1b[201~'));
  assert.equal(enter, '\r');
});

test('an excerpt keeps error lines with their context and marks the gaps between them', () => {
  const output = [
    '> app@1.0.0 test', '> node --test', '', '✔ adds (1ms)', '✔ subtracts (0ms)',
    'not ok 3 - retries once', '  expected: 1', '  actual: 2', '  at test/retry.test.ts:14:5',
    '✔ formats', '✔ parses', '✔ rounds', '# pass 5', '# fail 1',
  ].join('\n');
  const excerpt = failureExcerpt(output);
  assert.equal(excerpt.from, 'signals');
  assert.match(excerpt.text, /not ok 3 - retries once/);
  assert.match(excerpt.text, /at test\/retry\.test\.ts:14:5/);
  assert.match(excerpt.text, /# fail 1/);
  assert.ok(!excerpt.text.includes('✔ adds'), 'passing lines far from a failure are left out');
  assert.ok(excerpt.text.split('\n').includes('…'), 'a gap between kept windows is marked');
  assert.equal(excerpt.cut, false);
});

test('output with no error-looking line hands back its end, and says it was cut', () => {
  const output = Array.from({ length: 100 }, (_, index) => `line ${index}`).join('\n');
  const excerpt = failureExcerpt(output);
  assert.equal(excerpt.from, 'tail');
  assert.equal(excerpt.shownLines, 40);
  assert.match(excerpt.text, /^line 60\n/);
  assert.equal(excerpt.cut, true);
});

test('an excerpt never exceeds its line or character limit', () => {
  const many = Array.from({ length: 500 }, (_, index) => `error: problem ${index} ${'x'.repeat(index % 7 === 0 ? 400 : 20)}`).join('\n');
  const excerpt = failureExcerpt(many);
  assert.ok(excerpt.shownLines <= EXCERPT_MAX_LINES);
  assert.ok(excerpt.text.length <= EXCERPT_MAX_CHARS);
  assert.equal(excerpt.cut, true);
  assert.equal(excerpt.totalLines, 500);
});

test('the prompt names the command and exit, says what was kept, counts the hand-back, and forbids loosening tests', () => {
  const excerpt = failureExcerpt('error TS2345: bad argument');
  const first = handBackPrompt({ command: 'npm\ttest\x1b[2J', exitCode: 1, excerpt, attempt: 1 });
  assert.match(first, /`npm test` exited with code 1\./);
  assert.match(first, /look like errors:/);
  assert.match(first, /Do not weaken, skip or delete a test/);
  assert.match(first, new RegExp(`hand-back 1 of ${HANDBACK_LIMIT}`));
  assert.ok(!first.includes('\x1b'));
  const last = handBackPrompt({ command: 'make check', exitCode: null, excerpt, attempt: HANDBACK_LIMIT });
  assert.match(last, /was stopped before it exited/);
  assert.match(last, /It is the last one/);
});

test('a hand-back is sent only when every condition holds, and each refusal says which one failed', () => {
  const base: Parameters<typeof handBackVerdict>[0] = {
    enabled: true, halted: false, returnsSoFar: 0, budgetUsd: 20, spendUsd: 3, spendStatus: 'reported',
    sessionStatus: 'running', attention: { kind: 'finished', transitionId: 'event:41' }, stopEventId: 41,
  };
  assert.deepEqual(handBackVerdict(base), { send: true, attempt: 1 });
  assert.deepEqual(handBackVerdict({ ...base, returnsSoFar: 1 }), { send: true, attempt: 2 });
  const reason = (overrides: Partial<typeof base>) => {
    const verdict = handBackVerdict({ ...base, ...overrides });
    return verdict.send ? 'sent' : verdict.reason;
  };
  assert.equal(reason({ enabled: false }), 'off');
  assert.equal(reason({ halted: true }), 'halted');
  assert.equal(reason({ returnsSoFar: HANDBACK_LIMIT }), 'limit');
  assert.equal(reason({ budgetUsd: null }), 'no-budget');
  assert.equal(reason({ spendUsd: 0, spendStatus: 'unreported' }), 'unknown-spend');
  assert.equal(reason({ spendUsd: 3, spendStatus: 'partial' }), 'unknown-spend');
  assert.deepEqual(handBackVerdict({ ...base, spendUsd: 0, spendStatus: 'reported' }), { send: true, attempt: 1 });
  assert.equal(reason({ spendUsd: 20 }), 'cap');
  assert.equal(reason({ sessionStatus: 'exited' }), 'session-gone');
  assert.equal(reason({ attention: null }), 'moved-on');
  // A newer event, a permission question, or the agent at work: all moved on.
  assert.equal(reason({ attention: { kind: 'finished', transitionId: 'event:42' } }), 'moved-on');
  assert.equal(reason({ attention: { kind: 'permission', transitionId: 'event:41' } }), 'moved-on');
  assert.equal(reason({ attention: { kind: 'working', transitionId: 'event:41' } }), 'moved-on');
});
