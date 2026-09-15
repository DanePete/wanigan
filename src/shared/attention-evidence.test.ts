/**
 * Policy signals and review state, as the attention queue applies them.
 *
 * Mostly the negative space again: a prompt on screen is never replaced by a
 * tripwire, a signal the operator already answered stops being news, an old
 * signal expires, and review state never relabels a session that is still
 * doing something.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SIGNAL_WINDOW_MS, standingSignal, withReviewState, withSignal, type RecordedSignal } from './attention-evidence.ts';
import type { Attention } from './types.ts';

const NOW = 1_800_000_000_000;
const verdict = (over: Partial<Attention> = {}): Attention => ({
  sessionId: 's', kind: 'working', transitionId: 't', since: NOW - 60_000, label: 'Working', detail: null, tool: null,
  reason: { rule: 'working', event: { name: 'PostToolUse', at: NOW - 5_000 }, because: 'Hook events are still arriving.' },
  ...over,
});
const sig = (over: Partial<RecordedSignal> = {}): RecordedSignal => ({
  id: 7, at: NOW - 60_000, kind: 'tripwire', rule: 'tripwire.downloaded-exec', summary: 'python decode.py inside a directory curl created', ...over,
});

test('a recent tripwire takes over a working verdict, with its own reason and a transition of its own', () => {
  const s = standingSignal(verdict(), [sig()], NOW, null);
  assert.equal(s?.id, 7);
  const v = withSignal(verdict(), s!, (x) => x);
  assert.equal(v.kind, 'error');
  assert.equal(v.label, 'Tripwire');
  assert.equal(v.transitionId, 'signal:7');
  assert.equal(v.since, NOW - 60_000);
  assert.equal(v.reason?.rule, 'policy-signal');
  assert.match(v.reason!.because, /lead, not containment/);
  assert.equal(v.detail, 'python decode.py inside a directory curl created');
});

test('a history rewrite is worded as pinned evidence', () => {
  const v = withSignal(verdict({ kind: 'finished' }), sig({ kind: 'git-rewrite', rule: 'git.force-push' }), (x) => x);
  assert.equal(v.label, 'History rewritten');
  assert.match(v.reason!.because, /refs\/wanigan\/evidence/);
});

test('a permission prompt is never replaced: a person is already being asked', () => {
  assert.equal(standingSignal(verdict({ kind: 'permission' }), [sig()], NOW, null), null);
});

test('a signal the operator answered with a later prompt, an expired one, and a kind that asks nothing are all ignored', () => {
  assert.equal(standingSignal(verdict(), [sig()], NOW, NOW - 30_000), null, 'answered');
  assert.equal(standingSignal(verdict(), [sig({ at: NOW - SIGNAL_WINDOW_MS - 1 })], NOW, null), null, 'expired');
  assert.equal(standingSignal(verdict(), [sig({ kind: 'fatigue' }), sig({ kind: 'git-rewrite-command' })], NOW, null), null, 'not about asking');
  assert.equal(standingSignal(verdict(), [sig({ at: NOW + 5_000 })], NOW, null), null, 'stamped in the future');
});

test('the newest standing signal wins', () => {
  const s = standingSignal(verdict(), [sig({ id: 1, at: NOW - 120_000 }), sig({ id: 2, at: NOW - 10_000, kind: 'git-rewrite' })], NOW, null);
  assert.equal(s?.id, 2);
});

test('a finished session whose diff needs review carries the review label and both reasons; its kind and transition stay', () => {
  const finished = verdict({ kind: 'finished', label: 'Finished', transitionId: 'event:9',
    reason: { rule: 'turn-ended', event: { name: 'Stop', at: NOW - 1_000 }, because: 'The agent reported the end of its turn.' } });
  const v = withReviewState(finished, { needsReview: true, label: 'Needs review · 1 of 4 files', because: '3 changed files have no approval.' });
  assert.equal(v.kind, 'finished');
  assert.equal(v.transitionId, 'event:9');
  assert.equal(v.label, 'Needs review · 1 of 4 files');
  assert.equal(v.reason?.rule, 'needs-review');
  assert.equal(v.reason?.because, 'The agent reported the end of its turn. 3 changed files have no approval.');
  assert.deepEqual(v.reason?.event, { name: 'Stop', at: NOW - 1_000 });
});

test('review state never relabels a session that is not finished, or one with nothing to review', () => {
  const review = { needsReview: true, label: 'Needs review · 0 of 1 file', because: 'x' };
  for (const kind of ['permission', 'error', 'idle', 'working'] as const) {
    assert.equal(withReviewState(verdict({ kind }), review).label, 'Working');
  }
  const finished = verdict({ kind: 'finished', label: 'Finished' });
  assert.equal(withReviewState(finished, { ...review, needsReview: false }).label, 'Finished');
  assert.equal(withReviewState(finished, null).label, 'Finished');
});
