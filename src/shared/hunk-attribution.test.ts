/**
 * Hunk attribution for staging only the session's hunks. The subject is the
 * refusal: a file is staged apart only when the edits outside the session's
 * turns keep their distance from the lines the turns changed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideFileStaging, hunkRanges, rangesTouch, type Interval } from './hunk-attribution.ts';

const patch = (header: string, ...body: string[]) => ['diff --git a/f.ts b/f.ts', '--- a/f.ts', '+++ b/f.ts', header, ...body, ''].join('\n');
const turn = (n: number, p: string): Interval => ({ kind: 'turn', turn: n, patch: p, label: `turn ${n}` });
const outside = (label: string, p: string): Interval => ({ kind: 'outside', turn: null, patch: p, label });

test('hunk ranges: a replacement, a pure insertion and a pure deletion each mark a place on both sides', () => {
  assert.deepEqual(hunkRanges(patch('@@ -10,3 +10,3 @@', ' a', '-b', '+B', ' c')), { old: [[11, 11]], new: [[11, 11]] });
  const inserted = hunkRanges(patch('@@ -5,0 +6,2 @@', '+x', '+y'));
  assert.deepEqual(inserted.new, [[6, 7]]);
  assert.deepEqual(inserted.old, [[5, 5]]);
  const deleted = hunkRanges(patch('@@ -20,2 +19,0 @@', '-p', '-q'));
  assert.deepEqual(deleted.old, [[20, 21]]);
  assert.deepEqual(deleted.new, [[19, 19]]);
  assert.deepEqual(hunkRanges(''), { old: [], new: [] });
});

test('ranges touch within git apply\'s three lines of context, and not beyond', () => {
  assert.equal(rangesTouch([[10, 12]], [[15, 15]]), true);
  assert.equal(rangesTouch([[10, 12]], [[16, 16]]), false);
  assert.equal(rangesTouch([[40, 40]], [[37, 37]]), true);
  assert.equal(rangesTouch([], [[1, 1]]), false);
});

test('a file only the turns changed is staged whole; a file no turn changed is not the session\'s', () => {
  const t1 = patch('@@ -1,1 +1,1 @@', '-a', '+b');
  assert.deepEqual(decideFileStaging('f.ts', [outside('before the first turn', ''), turn(1, t1), outside('after the last turn', '')]),
    { action: 'stage', turns: [1], mixed: false });
  assert.deepEqual(decideFileStaging('f.ts', [outside('after the last turn', t1)]), { action: 'none' });
});

test('an outside edit far from the turns\' lines is separable; one next to them is refused with the reason', () => {
  const t1 = patch('@@ -10,3 +10,3 @@', ' a', '-b', '+B', ' c');
  const far = patch('@@ -80,3 +80,3 @@', ' x', '-y', '+Y', ' z');
  const near = patch('@@ -12,3 +12,3 @@', ' c', '-d', '+D', ' e');
  const intervals = (o: string) => [outside('before the first turn', ''), turn(1, t1), outside('after the last turn', o)];
  assert.deepEqual(decideFileStaging('f.ts', intervals(far), { before: t1, after: '' }), { action: 'stage', turns: [1], mixed: true });
  const refused = decideFileStaging('f.ts', intervals(near), { before: t1, after: '' });
  assert.equal(refused.action, 'refuse');
  if (refused.action === 'refuse') assert.equal(refused.reason, 'An edit to `f.ts` after the last turn touches lines the session\'s earlier turns changed, so the two cannot be staged apart.');
});

test('an edit before a turn that the turn then builds on is refused from the after stretch', () => {
  const op = patch('@@ -5,1 +5,1 @@', '-old', '+mine');
  const t1 = patch('@@ -4,3 +4,3 @@', ' a', '-mine', '+theirs', ' b');
  const d = decideFileStaging('f.ts', [outside('before the first turn', op), turn(1, t1)], { before: '', after: t1 });
  assert.equal(d.action, 'refuse');
});

test('two outside edits, a mixed binary file, and a mixed file without stretches are refused', () => {
  const t = patch('@@ -1 +1 @@', '-a', '+b');
  const o = patch('@@ -50 +50 @@', '-c', '+d');
  assert.equal(decideFileStaging('f.ts', [outside('before the first turn', o), turn(1, t), outside('after the last turn', o)], { before: t, after: '' }).action, 'refuse');
  const bin = 'diff --git a/i.png b/i.png\nGIT binary patch\nliteral 3\n';
  assert.equal(decideFileStaging('i.png', [turn(1, bin), outside('after the last turn', bin)], { before: bin, after: '' }).action, 'refuse');
  assert.equal(decideFileStaging('f.ts', [turn(1, t), outside('after the last turn', o)]).action, 'refuse');
});
