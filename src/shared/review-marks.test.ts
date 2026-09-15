/**
 * Review marks, the pure half. The subject is the verdict: a session reads as
 * needing review only when its turn is over, it changed something, and not
 * every changed file carries an approval of the bytes it has now. An approval
 * that survived an edit would approve code nobody read.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DELETED_HASH, branchAnchor, diffStatLabel, fileReview, formatReviewSubmission, highTierUnapproved,
  marksFromReviews, needsReviewLabel, needsReviewVerdict, reviewCounts, validMarkState,
  type ReviewFile, type ReviewMark,
} from './review-marks.ts';
import type { ReviewNote } from './review-notes.ts';

const file = (path: string, over: Partial<ReviewFile> = {}): ReviewFile => ({
  path, oldPath: null, status: 'M', added: 3, removed: 1, binary: false, contentHash: `h-${path}`, ...over,
});
const mark = (path: string, state: ReviewMark['state'], over: Partial<ReviewMark> = {}): ReviewMark => ({
  path, state, note: null, contentHash: `h-${path}`, worktree: '/w', baseCommit: 'abc12345def', markedAt: 1, ...over,
});

test('a mark on the current bytes stands; a mark on older bytes is stale and reads as unreviewed', () => {
  const f = file('a.ts');
  assert.deepEqual(fileReview(f, [mark('a.ts', 'approved')]), { state: 'approved', stale: false, marked: 'approved', note: null, markedAt: 1 });
  const moved = fileReview(file('a.ts', { contentHash: 'h-new' }), [mark('a.ts', 'approved', { note: 'looks right' })]);
  assert.equal(moved.state, 'unreviewed');
  assert.equal(moved.stale, true);
  assert.equal(moved.note, 'looks right', 'the note on the earlier version is kept for the reader');
});

test('a deleted file is marked against the deleted hash and stays approved while it stays deleted', () => {
  const gone = file('old.ts', { status: 'D', contentHash: DELETED_HASH, added: 0, removed: 9 });
  assert.equal(fileReview(gone, [mark('old.ts', 'approved', { contentHash: DELETED_HASH })]).state, 'approved');
  assert.equal(fileReview({ ...gone, contentHash: 'h-back' }, [mark('old.ts', 'approved', { contentHash: DELETED_HASH })]).stale, true);
});

test('counts leave the operator\'s pre-existing files out and sum only the lines git counted', () => {
  const files = [file('a.ts'), file('b.png', { binary: true, added: null, removed: null }), file('mine.ts', { preexisting: true })];
  const counts = reviewCounts(files, [mark('a.ts', 'rejected')]);
  assert.deepEqual(counts, { files: 2, approved: 0, rejected: 1, commented: 0, stale: 0, unreviewed: 1, added: 3, removed: 1, binary: 1 });
});

test('the verdict: working, no base, unreadable and an empty diff never need review', () => {
  const files = [file('a.ts')];
  assert.equal(needsReviewVerdict({ turn: 'working', base: 'abc', unreadable: null, files, marks: [] }).reason, 'working');
  assert.equal(needsReviewVerdict({ turn: 'exited', base: null, unreadable: null, files, marks: [] }).reason, 'no-base');
  assert.equal(needsReviewVerdict({ turn: 'exited', base: 'abc', unreadable: 'timed out', files, marks: [] }).reason, 'unreadable');
  const empty = needsReviewVerdict({ turn: 'turn-ended', base: 'abc', unreadable: null, files: [], marks: [] });
  assert.equal(empty.needsReview, false);
  assert.equal(empty.reason, 'no-diff');
  const onlyMine = needsReviewVerdict({ turn: 'exited', base: 'abc', unreadable: null, files: [file('x', { preexisting: true })], marks: [] });
  assert.equal(onlyMine.reason, 'no-diff', 'pre-existing edits are the operator\'s, not a diff to review');
});

test('the verdict: an ended turn with an unapproved file needs review, and approving every file clears it', () => {
  const files = [file('a.ts'), file('b.ts'), file('c.ts')];
  const open = needsReviewVerdict({ turn: 'turn-ended', base: 'abc', unreadable: null, files, marks: [mark('a.ts', 'approved')] });
  assert.equal(open.needsReview, true);
  assert.equal(open.reason, 'unapproved-files');
  assert.equal(open.because, 'Its turn ended with 3 changed files, and 2 are not approved.');
  assert.equal(needsReviewLabel(open), 'Needs review · 1 of 3 files');
  const done = needsReviewVerdict({ turn: 'exited', base: 'abc', unreadable: null, files, marks: files.map((f) => mark(f.path, 'approved')) });
  assert.equal(done.needsReview, false);
  assert.equal(done.reason, 'all-approved');
  const edited = needsReviewVerdict({ turn: 'exited', base: 'abc', unreadable: null,
    files: [file('a.ts', { contentHash: 'h-2' })], marks: [mark('a.ts', 'approved')] });
  assert.equal(edited.needsReview, true, 'an approval of older bytes does not clear the verdict');
  assert.equal(edited.counts.stale, 1);
});

test('high-tier files without a current approval are named, including a rename out of a high-tier path', () => {
  const tier = (p: string) => (p.startsWith('.github/workflows/') ? 'high' as const : null);
  const files = [
    file('.github/workflows/ci.yml'),
    file('src/a.ts'),
    file('ci/moved.yml', { status: 'R', oldPath: '.github/workflows/old.yml' }),
    file('.github/workflows/ok.yml'),
  ];
  const left = highTierUnapproved(files, [mark('.github/workflows/ok.yml', 'approved')], tier).map((f) => f.path);
  assert.deepEqual(left, ['.github/workflows/ci.yml', 'ci/moved.yml']);
});

test('the review message lists rejections, comments and line notes in the review-notes register, and counts approvals', () => {
  const files = [file('src/pay.ts'), file('src/cart.ts'), file('README.md'), file('src/old.ts', { contentHash: 'h-2' })];
  const note: ReviewNote = { id: 'n1', file: 'src/cart.ts', oldStart: null, oldEnd: null, newStart: 4, newEnd: 4, quote: ['+  total += tax;'], quoteOmitted: 0, body: 'Tax is added twice.' };
  const result = formatReviewSubmission({
    anchor: branchAnchor('1a2b3c4d5e6f'),
    files,
    marks: [
      mark('src/pay.ts', 'rejected', { note: 'Do not swallow the error.' }),
      mark('src/cart.ts', 'commented', { note: 'Name the constant.' }),
      mark('README.md', 'approved'),
      mark('src/old.ts', 'rejected'),
    ],
    lineNotes: [note],
    dependencies: [{ text: 'added `left-pad` 1.3.0 (package.json dependencies)' }],
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.items, 4);
  assert.equal(result.text, [
    "Review of this session's changes against 1a2b3c4d, the commit it started from.",
    'Address each one, or reply saying why you are leaving it as it is.',
    '',
    '1. `src/pay.ts` — rejected:',
    '   Do not swallow the error.',
    '',
    '2. `src/cart.ts` — comment:',
    '   Name the constant.',
    '',
    '3. `src/old.ts` — rejected, made on an earlier version of this file:',
    '   Rejected without a note.',
    '',
    '4. `src/cart.ts`, line 4:',
    '   ```diff',
    '   +  total += tax;',
    '   ```',
    '   Tax is added twice.',
    '',
    'Dependencies this diff adds, changes or removes — say why each one is needed:',
    '- added `left-pad` 1.3.0 (package.json dependencies)',
    '',
    '1 other file is approved as it stands.',
  ].join('\n'));
});

test('a review with nothing to say is refused rather than sent as an empty message', () => {
  const result = formatReviewSubmission({ anchor: 'x', files: [file('a.ts')], marks: [mark('a.ts', 'approved')] });
  assert.equal(result.ok, false);
});

test('marks rebuilt from reviewed files keep a stale mark stale', () => {
  const files = [file('a.ts'), file('b.ts', { contentHash: 'h-new' })];
  const marks = [mark('a.ts', 'approved'), mark('b.ts', 'rejected', { note: 'no' })];
  const reviewed = files.map((f) => ({ ...f, review: fileReview(f, marks) }));
  const rebuilt = marksFromReviews(reviewed, '/w', 'abc');
  assert.deepEqual(rebuilt.map((m) => [m.path, m.state]), [['a.ts', 'approved'], ['b.ts', 'rejected']]);
  assert.equal(fileReview(files[1], rebuilt).stale, true);
  assert.equal(fileReview(files[0], rebuilt).state, 'approved');
});

test('small words: the state guard and the diff-stat label', () => {
  assert.equal(validMarkState('approved'), true);
  assert.equal(validMarkState('lgtm'), false);
  assert.equal(validMarkState(undefined), false);
  assert.equal(diffStatLabel(1200, 30), '+1,200 −30');
});
