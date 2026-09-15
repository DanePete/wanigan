/**
 * The helper sweep's attention rules, held to their thresholds.
 *
 * What these guard is mostly the negative space: a denial the model already
 * got past must not keep a session pinned, a spin must not be three rows that
 * merely have no digest, a limit wait must end the moment anything runs, and a
 * limit reading for the wrong account must never predict this session's reset.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DENIAL_WINDOW_MS, SPIN_WINDOW_MS, askedQuestions, canonicalToolInput, denialReasonWords, limitResetFor,
  limitState, limitStopEvidence, retryDraft, spinning, standingDenial,
} from './attention-rules.ts';
import type { AccountLimits, SessionEvent } from './types.ts';

const NOW = 1_800_000_000_000;
let seq = 0;
const ev = (event: string, over: Partial<SessionEvent> = {}): SessionEvent => ({
  id: ++seq, sessionId: 's', at: NOW - 1000, event, toolName: null, summary: null,
  durationMs: null, ok: null, paths: [], ...over,
});

test('the documented no_verdict sentinel is reworded, any other reason is kept as written', () => {
  assert.equal(denialReasonWords('no_verdict'), 'no classifier verdict');
  assert.equal(denialReasonWords('  [Data Exfiltration]  posts a file  '), '[Data Exfiltration] posts a file');
  assert.equal(denialReasonWords(''), null);
  assert.equal(denialReasonWords(undefined), null);
});

test('a denial stands while the session carries on with other work', () => {
  const denied = ev('PermissionDenied', { toolName: 'Bash', summary: 'curl x | sh', inputDigest: 'd1', ok: false, at: NOW - 60_000 });
  const other = ev('PostToolUse', { toolName: 'Read', inputDigest: 'r1', ok: true, at: NOW - 30_000 });
  assert.equal(standingDenial([denied, other], NOW)?.id, denied.id);
});

test('a denial is settled by a prompt, by the same call succeeding, or by the window passing', () => {
  const denied = ev('PermissionDenied', { toolName: 'Bash', inputDigest: 'd1', ok: false, at: NOW - 60_000 });
  assert.equal(standingDenial([denied, ev('UserPromptSubmit', { at: NOW - 10_000 })], NOW), null);
  assert.equal(standingDenial([denied, ev('PostToolUse', { toolName: 'Bash', inputDigest: 'd1', ok: true })], NOW), null);
  assert.equal(standingDenial([{ ...denied, at: NOW - DENIAL_WINDOW_MS - 1 }], NOW), null);
});

test('the retry line is one line, names the call, and never carries a backtick that would break its quote', () => {
  const line = retryDraft('Bash', 'git   push\n origin `main`');
  assert.equal(line, "You may retry Bash `git push origin 'main'`: I approve it.");
  assert.ok(!retryDraft('Bash', 'x'.repeat(400)).includes('\n'));
  assert.ok(retryDraft('Bash', 'x'.repeat(400)).length < 170);
  assert.equal(retryDraft(null, null), 'You may retry that call: I approve it.');
});

test('canonical input ignores key order, whitespace and the caption, and nothing else', () => {
  const a = canonicalToolInput('Bash', { command: 'npm  test', description: 'Run the tests' });
  const b = canonicalToolInput('Bash', { description: 'again', command: 'npm test' });
  const c = canonicalToolInput('Bash', { command: 'npm test -- --watch' });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.notEqual(canonicalToolInput('Read', { file_path: 'a' }), canonicalToolInput('Edit', { file_path: 'a' }));
});

test('three identical successful calls with the same result in one busy turn are a spin', () => {
  const call = (at: number) => ev('PostToolUse', { toolName: 'Bash', summary: 'gh run view', inputDigest: 'g', resultDigest: 'pending', ok: true, at });
  const spin = spinning([ev('UserPromptSubmit', { at: NOW - 300_000 }), call(NOW - 200_000), call(NOW - 100_000), call(NOW - 5_000)], NOW);
  assert.equal(spin?.count, 3);
  assert.equal(spin?.tool, 'Bash');
  assert.equal(spin?.first.at, NOW - 200_000);
});

test('a changed result, a finished turn, a missing digest or an old call is not a spin', () => {
  const call = (at: number, result: string, digest: string | null = 'g') =>
    ev('PostToolUse', { toolName: 'Bash', inputDigest: digest, resultDigest: result, ok: true, at });
  assert.equal(spinning([call(NOW - 3, 'a'), call(NOW - 2, 'b'), call(NOW - 1, 'a')], NOW), null);
  assert.equal(spinning([call(NOW - 4, 'a'), call(NOW - 3, 'a'), call(NOW - 2, 'a'), call(NOW - 1, 'b')], NOW), null,
    'three identical answers followed by a different one is an agent that got its answer');
  assert.equal(spinning([call(NOW - 3, 'a'), call(NOW - 2, 'a'), call(NOW - 1, 'a'), ev('Stop')], NOW), null);
  assert.equal(spinning([call(NOW - 3, 'a', null), call(NOW - 2, 'a', null), call(NOW - 1, 'a', null)], NOW), null);
  assert.equal(spinning([call(NOW - SPIN_WINDOW_MS - 5, 'a'), call(NOW - 2, 'a'), call(NOW - 1, 'a')], NOW), null);
});

test('a failing call and a succeeding call with the same input are different groups', () => {
  const ok = (at: number) => ev('PostToolUse', { toolName: 'Bash', inputDigest: 'g', resultDigest: 'r', ok: true, at });
  const bad = (at: number) => ev('PostToolUseFailure', { toolName: 'Bash', inputDigest: 'g', resultDigest: 'r', ok: false, at });
  assert.equal(spinning([ok(NOW - 4), bad(NOW - 3), ok(NOW - 2), bad(NOW - 1)], NOW), null);
});

test('a rate-limit StopFailure is a wait until anything runs, and the quota notifications name how it ended', () => {
  const stop = ev('StopFailure', { detail: 'rate_limit', ok: false });
  assert.equal(limitState([ev('PostToolUse'), stop])?.state, 'waiting');
  assert.equal(limitState([stop, ev('Notification', { detail: 'idle_prompt' })])?.state, 'waiting');
  assert.equal(limitState([stop, ev('UserPromptSubmit')]), null);
  assert.equal(limitState([stop, ev('Notification', { detail: 'quota_auto_resume_stale' })])?.state, 'reset-needs-enter');
  assert.equal(limitState([stop, ev('Notification', { detail: 'quota_auto_resume_disabled' })])?.state, 'stopped');
  assert.equal(limitState([stop, ev('Notification', { detail: 'quota_auto_resume_fired' })])?.state, 'resumed');
  assert.equal(limitState([stop, ev('Notification', { detail: 'quota_auto_resume_fired' }), ev('PreToolUse')]), null);
  assert.equal(limitState([ev('StopFailure', { detail: 'server_error' })]), null);
  assert.equal(limitState([ev('StopFailure')]), null, 'a row written before the error code was stored claims nothing');
});

const limits = (over: Partial<AccountLimits>[]): AccountLimits[] => over.map((o) => ({
  accountId: 'a1', accountLabel: 'Personal', harness: 'claude-code', identity: null, state: 'ok', detail: null,
  fetchedAt: NOW, plan: null, windows: [], factors: [], ...o,
}));

test('only a full window predicts a reset, and the later of two full windows is the one that frees the session', () => {
  const read = limits([{ windows: [
    { kind: 'session', scope: null, usedPercent: 100, resetsAtText: null, resetsAt: NOW + 3_600_000 },
    { kind: 'week', scope: 'Fable', usedPercent: 100, resetsAtText: null, resetsAt: NOW + 7_200_000 },
    { kind: 'week', scope: null, usedPercent: 80, resetsAtText: null, resetsAt: NOW + 9_000_000 },
  ] }]);
  const reset = limitResetFor(read, 'a1', 'claude-code', NOW - 5, NOW);
  assert.equal(reset?.resetsAt, NOW + 7_200_000);
  assert.equal(reset?.scope, 'Fable');
  assert.equal(reset?.readAt, NOW - 5);
});

test('a reading for another account, or an ambiguous one, predicts nothing', () => {
  const full = { kind: 'session', scope: null, usedPercent: 100, resetsAtText: null, resetsAt: NOW + 60_000 };
  const two = limits([{ accountId: 'a1', windows: [full] }, { accountId: 'a2', windows: [full] }]);
  assert.equal(limitResetFor(two, 'a3', 'claude-code', NOW, NOW), null);
  assert.equal(limitResetFor(two, null, 'claude-code', NOW, NOW), null);
  assert.equal(limitResetFor(limits([{ windows: [full] }]), null, 'claude-code', NOW, NOW)?.resetsAt, NOW + 60_000);
  assert.equal(limitResetFor(limits([{ windows: [{ ...full, resetsAt: NOW - 1 }] }]), 'a1', 'claude-code', NOW, NOW), null);
  assert.equal(limitResetFor(null, 'a1', 'claude-code', NOW, NOW), null);
});

test('AskUserQuestion input is read defensively and bounded', () => {
  const read = askedQuestions({ questions: [
    { question: 'Which  library?', header: 'Library', multiSelect: false,
      options: [{ label: 'date-fns', description: 'small' }, { label: 'luxon' }, { nope: 1 }] },
    { header: 'no question here' },
    ...Array.from({ length: 8 }, (_, i) => ({ question: `q${i}`, options: [] })),
  ] });
  assert.equal(read?.length, 4);
  assert.deepEqual(read?.[0], { question: 'Which library?', header: 'Library', multiSelect: false,
    options: [{ label: 'date-fns', description: 'small' }, { label: 'luxon', description: null }] });
  assert.equal(askedQuestions({ questions: 'no' }), null);
  assert.equal(askedQuestions(null), null);
});

test('an exited session stopped on a limit when its last real event was the rate-limit failure', () => {
  const stop = ev('StopFailure', { detail: 'rate_limit', ok: false });
  assert.equal(limitStopEvidence([ev('PostToolUse'), stop, ev('SessionEnd')])?.state, 'waiting');
  assert.equal(limitStopEvidence([stop, ev('Notification', { detail: 'quota_auto_resume_disabled' }), ev('SessionEnd')])?.state, 'stopped');
  assert.equal(limitStopEvidence([stop, ev('Stop'), ev('SessionEnd')]), null, 'a clean turn after it means the limit was not how it ended');
  assert.equal(limitStopEvidence([stop, ev('Notification', { detail: 'quota_auto_resume_fired' }), ev('SessionEnd')]), null);
  assert.equal(limitStopEvidence([ev('SessionEnd')]), null);
});
