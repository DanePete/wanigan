/**
 * Which changed files are scratch, and what promotion does.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyScratch, scratchReason } from './scratch-files.ts';
import { needsReviewVerdict, reviewCounts, reviewableFiles, formatReviewSubmission, type ReviewFile } from './review-marks.ts';

test('reasons: temp roots, .claude/worktrees, scratch/ and tmp/ directories, and ignored paths', () => {
  assert.equal(scratchReason('/private/tmp/probe.sh'), 'os-temp');
  assert.equal(scratchReason('/var/folders/x1/T/out.json'), 'os-temp');
  assert.equal(scratchReason('/Users/me/repo/src/a.ts'), null);
  assert.equal(scratchReason('.claude/worktrees/agent-a/src/a.ts'), 'claude-worktree');
  assert.equal(scratchReason('scratch/try.py'), 'scratch-dir');
  assert.equal(scratchReason('packages/web/tmp/dump.json'), 'tmp-dir');
  assert.equal(scratchReason('src/scratch.ts'), null, 'a file named scratch is not a scratch directory');
  assert.equal(scratchReason('src/tmp'), null);
  assert.equal(scratchReason('build/out.log', { ignored: true }), 'gitignored');
  assert.equal(scratchReason('src/a.ts', { tempRoots: ['/custom'] }), null);
});

test('classification: a promoted path is counted whatever it matched', () => {
  const out = classifyScratch([{ path: 'scratch/keep.md' }, { path: 'scratch/drop.md' }, { path: 'src/a.ts' }], new Set(), new Set(['scratch/keep.md']));
  assert.deepEqual(out.map((f) => [f.path, f.scratch]), [['scratch/keep.md', null], ['scratch/drop.md', 'scratch-dir'], ['src/a.ts', null]]);
});

test('scratch files leave the review counts, the verdict and the review message', () => {
  const file = (path: string, over: Partial<ReviewFile> = {}): ReviewFile => ({ path, oldPath: null, status: 'M', added: 3, removed: 1, binary: false, contentHash: `h-${path}`, ...over });
  const files = [file('src/a.ts'), file('tmp/probe.json', { scratch: 'tmp-dir', added: 900 })];
  assert.deepEqual(reviewableFiles(files).map((f) => f.path), ['src/a.ts']);
  const counts = reviewCounts(files, []);
  assert.equal(counts.files, 1);
  assert.equal(counts.added, 3);
  const approved = [{ path: 'src/a.ts', state: 'approved' as const, note: null, contentHash: 'h-src/a.ts', worktree: '/r', baseCommit: 'b', markedAt: 1 }];
  assert.equal(needsReviewVerdict({ turn: 'turn-ended', base: 'b', unreadable: null, files, marks: approved }).reason, 'all-approved');
  const rejectedScratch = [{ path: 'tmp/probe.json', state: 'rejected' as const, note: 'no', contentHash: 'h-tmp/probe.json', worktree: '/r', baseCommit: 'b', markedAt: 1 }];
  assert.equal(formatReviewSubmission({ anchor: 'x', files, marks: rejectedScratch }).ok, false, 'a mark on a scratch file sends nothing');
});
