/**
 * Spend yield's pure half. The subject is whether it can overstate: a guessed
 * bucket, an unpriced session totalled as $0, or a cost-per-commit computed over
 * half the evidence would each read as a finding about the operator's money.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateYield, costPerMergedCommit, pickVcsAttributes, removalOutcome, revertCheckDue, revertGrepPattern,
  stripUserinfo, yieldBucket, REVERT_RECHECK_MS, type YieldInput, type YieldWorktree,
} from './spend-yield.ts';

const wt = (patch: Partial<YieldWorktree> = {}): YieldWorktree => ({
  outcome: null, removedAt: null, mergeSha: null, commits: null, revertedBy: null, ...patch,
});

const row = (patch: Partial<YieldInput> = {}): YieldInput => ({
  sessionId: 's1', source: 'session', projectId: 'prj_a', projectName: 'alpha', model: 'fable',
  costUsd: 1, priced: true, worktree: wt(), ...patch,
});

test('a worktree with no outcome is open while it exists and not recorded once it is gone', () => {
  assert.deepEqual(yieldBucket(wt()), { bucket: 'open', reason: null });
  assert.deepEqual(yieldBucket(wt({ removedAt: 5 })), { bucket: 'not-recorded', reason: 'historical' });
  assert.deepEqual(yieldBucket(null), { bucket: 'not-recorded', reason: 'no-worktree' });
});

test('recorded outcomes map to their own buckets', () => {
  assert.equal(yieldBucket(wt({ outcome: 'merged', removedAt: 9 })).bucket, 'merged');
  assert.equal(yieldBucket(wt({ outcome: 'discarded', removedAt: 9 })).bucket, 'discarded');
  assert.equal(yieldBucket(wt({ outcome: 'removed-clean', removedAt: 9 })).bucket, 'removed-clean');
});

test('unpriced sessions are counted beside the money, never summed into it as zero', () => {
  const [g] = aggregateYield([
    row({ sessionId: 'a', costUsd: 2, worktree: wt({ outcome: 'merged', commits: 2 }) }),
    row({ sessionId: 'b', costUsd: 0, priced: false, worktree: wt({ outcome: 'merged', commits: 1 }) }),
  ]);
  assert.equal(g.merged.sessions, 2);
  assert.equal(g.merged.costUsd, 2);
  assert.equal(g.merged.unpricedSessions, 1);
  assert.deepEqual(g.costPerMergedCommit, { status: 'withheld', reason: 'unpriced-merge' });
});

test('cost per merged commit needs both halves observed', () => {
  assert.deepEqual(costPerMergedCommit([]), { status: 'withheld', reason: 'no-merges' });
  assert.deepEqual(
    costPerMergedCommit([row({ worktree: wt({ outcome: 'merged', commits: null }) })]),
    { status: 'withheld', reason: 'commits-not-recorded' });
  assert.deepEqual(
    costPerMergedCommit([row({ worktree: wt({ outcome: 'merged', commits: 0 }) })]),
    { status: 'withheld', reason: 'zero-commits' });
  assert.deepEqual(
    costPerMergedCommit([
      row({ costUsd: 3, worktree: wt({ outcome: 'merged', commits: 2 }) }),
      row({ costUsd: 1, worktree: wt({ outcome: 'merged', commits: 2 }) }),
    ]),
    { status: 'observed', usdPerCommit: 1, commits: 4, costUsd: 4 });
});

test('reverted is a subset of merged, not a separate bucket', () => {
  const [g] = aggregateYield([
    row({ sessionId: 'a', worktree: wt({ outcome: 'merged', commits: 1, mergeSha: 'abc1234', revertedBy: 'def5678' }) }),
    row({ sessionId: 'b', worktree: wt({ outcome: 'merged', commits: 1, mergeSha: 'abc9999' }) }),
  ]);
  assert.equal(g.merged.sessions, 2);
  assert.equal(g.reverted.sessions, 1);
  assert.equal(g.sessions.find((s) => s.sessionId === 'a')?.reverted, true);
});

test('not recorded names its two reasons separately', () => {
  const [g] = aggregateYield([
    row({ sessionId: 'a', worktree: null }),
    row({ sessionId: 'b', worktree: wt({ removedAt: 3 }) }),
    row({ sessionId: 'c', worktree: wt({ removedAt: 3 }) }),
  ]);
  assert.equal(g.notRecorded.sessions, 3);
  assert.equal(g.notRecorded.noWorktree, 1);
  assert.equal(g.notRecorded.historical, 2);
});

test('groups split by project and model and sort dearest first, deterministically', () => {
  const groups = aggregateYield([
    row({ sessionId: 'a', model: 'fable', costUsd: 1 }),
    row({ sessionId: 'b', model: 'sol', costUsd: 5 }),
    row({ sessionId: 'c', projectId: 'prj_b', projectName: 'beta', model: 'fable', costUsd: 1 }),
    row({ sessionId: 'd', model: null, costUsd: 1 }),
  ]);
  assert.deepEqual(groups.map((g) => `${g.projectName}/${g.model ?? '-'}`), ['alpha/sol', 'alpha/-', 'alpha/fable', 'beta/fable']);
  assert.deepEqual(aggregateYield([...groups.flatMap(() => [])]), []);
});

test('a removal records clean only with positive evidence of nothing', () => {
  const base = { previous: null, dirty: 0, ahead: 0, tip: 'aaa', createdHead: 'aaa', forced: false } as const;
  assert.equal(removalOutcome(base), 'removed-clean');
  assert.equal(removalOutcome({ ...base, dirty: 2 }), 'discarded');
  assert.equal(removalOutcome({ ...base, ahead: 3 }), 'discarded');
  // The tip moved but nothing is ahead of base: every commit already landed.
  assert.equal(removalOutcome({ ...base, tip: 'bbb' }), 'merged');
  // git could not answer, or the creation head was never stored.
  assert.equal(removalOutcome({ ...base, dirty: null, forced: true }), null);
  assert.equal(removalOutcome({ ...base, ahead: null }), null);
  assert.equal(removalOutcome({ ...base, createdHead: null }), null);
  // A recorded merge survives the later clean-up.
  assert.equal(removalOutcome({ ...base, previous: 'merged', dirty: 5 }), 'merged');
});

test('the revert check greps only for a real sha and is cached', () => {
  assert.equal(revertGrepPattern('ABCDEF1'), 'This reverts commit abcdef1');
  assert.equal(revertGrepPattern('--all'), null);
  assert.equal(revertGrepPattern('abc'), null);
  const now = 10 * REVERT_RECHECK_MS;
  assert.equal(revertCheckDue({ mergeSha: 'abc1234', revertedBy: null, checkedAt: null }, now), true);
  assert.equal(revertCheckDue({ mergeSha: 'abc1234', revertedBy: null, checkedAt: now - 1000 }, now), false);
  assert.equal(revertCheckDue({ mergeSha: 'abc1234', revertedBy: null, checkedAt: now - REVERT_RECHECK_MS }, now), true);
  assert.equal(revertCheckDue({ mergeSha: 'abc1234', revertedBy: 'x', checkedAt: null }, now), false);
  assert.equal(revertCheckDue({ mergeSha: null, revertedBy: null, checkedAt: null }, now), false);
});

test('vcs attributes keep only the known keys and never store URL credentials', () => {
  const picked = pickVcsAttributes({
    'vcs.repository.url.full': 'https://x-access-token:ghp_secret@github.com/acme/app.git',
    'vcs.ref.head.name': 'main',
    'user.email': 'someone@example.com',
  });
  assert.deepEqual(picked, { 'vcs.repository.url.full': 'https://github.com/acme/app.git', 'vcs.ref.head.name': 'main' });
  assert.equal(stripUserinfo('git@github.com:acme/app.git'), 'git@github.com:acme/app.git');
});
