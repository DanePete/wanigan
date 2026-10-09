// Patches for part of a file. Each case is checked as text here; the core's
// git tests apply the same patches to real repositories.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPatch, hunkPick, newFileDiff, parseFilePatch, partProblem, pickedCount, plainPath, splitPatch } from './patch.ts';

const HEAD = ['diff --git a/f.txt b/f.txt', 'index 1111111..2222222 100644', '--- a/f.txt', '+++ b/f.txt'];
const diff = (...lines: string[]): string => `${[...HEAD, ...lines].join('\n')}\n`;
const body = (patch: string | null): string[] => (patch ?? '').trimEnd().split('\n').filter((l) => !/^(?:diff|index|---|\+\+\+|new file mode|deleted file mode) /.test(l));

// Two hunks: line 2 edited, and two lines added after line 9.
const TWO = diff(
  '@@ -1,3 +1,3 @@', ' a', '-b', '+B', ' c',
  '@@ -8,2 +8,4 @@ function tail()', ' h', ' i', '+j', '+k',
);

test('one whole hunk is the hunk as git wrote it, under the file’s header without its blob line', () => {
  const second = buildPatch(TWO, hunkPick(TWO, 1), 'forward');
  assert.equal(second, ['diff --git a/f.txt b/f.txt', '--- a/f.txt', '+++ b/f.txt', '@@ -8,2 +8,4 @@ function tail()', ' h', ' i', '+j', '+k', ''].join('\n'));
  // Every hunk picked is the file's whole diff: git's own patch.
  assert.equal(buildPatch(TWO, { old: [2], new: [2, 10, 11] }, 'forward'), TWO);
  assert.deepEqual(hunkPick(TWO, 0), { old: [2], new: [2] });
  assert.deepEqual(hunkPick(TWO, 9), { old: [], new: [] });
});

test('staging: an unpicked added line is dropped, an unpicked removed line stays as context', () => {
  assert.deepEqual(body(buildPatch(TWO, { old: [], new: [2] }, 'forward')), ['@@ -1,3 +1,4 @@', ' a', ' b', '+B', ' c']);
  assert.deepEqual(body(buildPatch(TWO, { old: [2], new: [] }, 'forward')), ['@@ -1,3 +1,2 @@', ' a', '-b', ' c']);
});

test('unstaging and discarding: an unpicked removed line is dropped, an unpicked added line stays as context', () => {
  assert.deepEqual(body(buildPatch(TWO, { old: [2], new: [] }, 'reverse')), ['@@ -1,4 +1,3 @@', ' a', '-b', ' B', ' c']);
  assert.deepEqual(body(buildPatch(TWO, { old: [], new: [11] }, 'reverse')), ['@@ -8,3 +8,4 @@ function tail()', ' h', ' i', ' j', '+k']);
});

test('a later hunk’s new start follows the lines an earlier hunk added or left out', () => {
  // Hunk one picked whole (+0), hunk two picked one of two added lines.
  const p = body(buildPatch(TWO, { old: [2], new: [2, 10] }, 'forward'));
  assert.deepEqual(p, ['@@ -1,3 +1,3 @@', ' a', '-b', '+B', ' c', '@@ -8,2 +8,3 @@ function tail()', ' h', ' i', '+j']);
  const grow = diff('@@ -1,1 +1,3 @@', ' a', '+x', '+y', '@@ -5,1 +7,2 @@', ' e', '+f');
  // Only one of the first hunk's lines is staged, so the second hunk lands one line earlier than git said.
  assert.deepEqual(body(buildPatch(grow, { old: [], new: [2, 8] }, 'forward')), ['@@ -1,1 +1,2 @@', ' a', '+x', '@@ -5,1 +6,2 @@', ' e', '+f']);
  // In reverse the target is the new side; the old side's start moves instead.
  assert.deepEqual(body(buildPatch(grow, { old: [], new: [3, 8] }, 'reverse')), ['@@ -1,2 +1,3 @@', ' a', ' x', '+y', '@@ -6,1 +7,2 @@', ' e', '+f']);
});

test('a hunk with nothing picked is left out, and a pick of nothing is no patch', () => {
  assert.deepEqual(body(buildPatch(TWO, { old: [], new: [10] }, 'forward')), ['@@ -8,2 +8,3 @@ function tail()', ' h', ' i', '+j']);
  assert.equal(buildPatch(TWO, { old: [], new: [9] }, 'forward'), null, 'line 9 is context: nothing to pick');
  assert.equal(buildPatch(TWO, { old: [], new: [] }, 'forward'), null);
  assert.equal(buildPatch(TWO, { old: [99], new: [99] }, 'forward'), null);
  assert.equal(pickedCount(TWO, { old: [2, 99], new: [10] }), 2);
});

test('insertions at the top and removals to nothing keep git’s empty-range numbering', () => {
  const top = diff('@@ -0,0 +1,2 @@', '+first', '+second');
  assert.deepEqual(body(buildPatch(top, { old: [], new: [2] }, 'forward')), ['@@ -0,0 +1,1 @@', '+second']);
  const cut = diff('@@ -3,2 +2,0 @@', '-x', '-y');
  assert.deepEqual(body(buildPatch(cut, { old: [4], new: [] }, 'forward')), ['@@ -3,2 +3,1 @@', ' x', '-y']);
  assert.deepEqual(body(buildPatch(cut, { old: [3, 4], new: [] }, 'forward')), ['@@ -3,2 +2,0 @@', '-x', '-y']);
});

test('at a missing last newline, a pick grows just enough for git to apply it', () => {
  // A new file with no last newline: picking the first and last lines keeps exactly those.
  const fresh = newFileDiff('l.txt', 'one\ntwo\nthree');
  assert.deepEqual(body(buildPatch(fresh, { old: [], new: [1, 3] }, 'forward')), ['@@ -0,0 +1,2 @@', '+one', '+three', '\\ No newline at end of file']);
  // A removed last line brought back while unstaging takes the added lines after it along.
  const swap = diff('@@ -1,2 +1,3 @@', ' a', '-b', '\\ No newline at end of file', '+B', '+c', '\\ No newline at end of file');
  assert.deepEqual(body(buildPatch(swap, { old: [2], new: [] }, 'reverse')), ['@@ -1,2 +1,3 @@', ' a', '-b', '\\ No newline at end of file', '+B', '+c', '\\ No newline at end of file']);
  // Staging only B: the old last line cannot stay as context before it, so it goes; c stays out.
  assert.deepEqual(body(buildPatch(swap, { old: [], new: [2] }, 'forward')), ['@@ -1,2 +1,2 @@', ' a', '-b', '\\ No newline at end of file', '+B']);
});

test('a line whose only change is its ending is one change, picked from either side', () => {
  // "a\nb" (no newline) became "a\nb\nc" (no newline): git shows b replaced.
  const eof = diff('@@ -1,2 +1,3 @@', ' a', '-b', '\\ No newline at end of file', '+b', '+c', '\\ No newline at end of file');
  const staged = body(buildPatch(eof, { old: [], new: [3] }, 'forward'));
  assert.deepEqual(staged, ['@@ -1,2 +1,3 @@', ' a', '-b', '\\ No newline at end of file', '+b', '+c', '\\ No newline at end of file']);
  // Nothing picked there: the old last line stays as context, marker and all, and nothing follows it.
  const other = diff('@@ -1,2 +1,2 @@', '-a', '+A', ' b', '\\ No newline at end of file');
  assert.deepEqual(body(buildPatch(other, { old: [1], new: [] }, 'forward')), ['@@ -1,2 +1,1 @@', '-a', ' b', '\\ No newline at end of file']);
  const ends = diff('@@ -1,1 +1,1 @@', '-a', '\\ No newline at end of file', '+a');
  assert.deepEqual(body(buildPatch(ends, { old: [], new: [1] }, 'reverse')), ['@@ -1,1 +1,1 @@', '-a', '\\ No newline at end of file', '+a']);
});

test('part of a new file: staged it is still a creation; unstaged the file stays with fewer lines', () => {
  const created = ['diff --git a/n.ts b/n.ts', 'new file mode 100644', 'index 0000000..3333333', '--- /dev/null', '+++ b/n.ts', '@@ -0,0 +1,3 @@', '+one', '+two', '+three'].join('\n');
  assert.equal(buildPatch(created, { old: [], new: [1, 3] }, 'forward'),
    ['diff --git a/n.ts b/n.ts', 'new file mode 100644', '--- /dev/null', '+++ b/n.ts', '@@ -0,0 +1,2 @@', '+one', '+three', ''].join('\n'));
  assert.equal(buildPatch(created, { old: [], new: [2] }, 'reverse'),
    ['diff --git a/n.ts b/n.ts', '--- a/n.ts', '+++ b/n.ts', '@@ -1,2 +1,3 @@', ' one', '+two', ' three', ''].join('\n'));
  // All of it: git's own header, index line and all.
  assert.equal(buildPatch(created, { old: [], new: [1, 2, 3] }, 'forward'), `${created}\n`);
});

test('part of a deletion: staged the file stays with fewer lines; unstaged only the picked lines come back', () => {
  const gone = ['diff --git a/d.ts b/d.ts', 'deleted file mode 100644', 'index 4444444..0000000', '--- a/d.ts', '+++ /dev/null', '@@ -1,2 +0,0 @@', '-x', '-y'].join('\n');
  assert.equal(buildPatch(gone, { old: [1], new: [] }, 'forward'),
    ['diff --git a/d.ts b/d.ts', '--- a/d.ts', '+++ b/d.ts', '@@ -1,2 +1,1 @@', '-x', ' y', ''].join('\n'));
  assert.equal(buildPatch(gone, { old: [2], new: [] }, 'reverse'),
    ['diff --git a/d.ts b/d.ts', 'deleted file mode 100644', '--- a/d.ts', '+++ /dev/null', '@@ -1,1 +0,0 @@', '-y', ''].join('\n'));
});

test('binary files, renames and mode-only changes are whole-file only, and say why', () => {
  assert.match(partProblem('diff --git a/i.png b/i.png\nindex 1..2 100644\nBinary files a/i.png and b/i.png differ\n') ?? '', /binary/);
  assert.match(partProblem('diff --git a/a b/b\nsimilarity index 90%\nrename from a\nrename to b\n@@ -1 +1 @@\n-x\n+y\n') ?? '', /renamed/);
  assert.match(partProblem('diff --git a/s b/s\nold mode 100644\nnew mode 100755\n') ?? '', /no changed lines/);
  assert.equal(partProblem(TWO), null);
  assert.equal(buildPatch('diff --git a/a b/b\nrename from a\nrename to b\n@@ -1 +1 @@\n-x\n+y\n', { old: [1], new: [1] }, 'forward'), null);
});

test('a new file’s diff says when its last line has no newline, and lines starting like headers stay lines', () => {
  assert.equal(newFileDiff('a.txt', 'one\ntwo\n'), 'diff --git a/a.txt b/a.txt\nnew file mode 100644\n--- /dev/null\n+++ b/a.txt\n@@ -0,0 +1,2 @@\n+one\n+two\n');
  assert.equal(newFileDiff('run.sh', 'echo', true), 'diff --git a/run.sh b/run.sh\nnew file mode 100755\n--- /dev/null\n+++ b/run.sh\n@@ -0,0 +1,1 @@\n+echo\n\\ No newline at end of file\n');
  assert.equal(newFileDiff('e.txt', ''), 'diff --git a/e.txt b/e.txt\nnew file mode 100644\n--- /dev/null\n+++ b/e.txt\n');
  const tricky = newFileDiff('t.md', '--- not a header\n+++ nor this\n@@ or this\n');
  const parsed = parseFilePatch(tricky);
  assert.deepEqual(parsed.hunks[0]?.lines.map((l) => l.text), ['--- not a header', '+++ nor this', '@@ or this']);
  assert.equal(buildPatch(tricky, { old: [], new: [2] }, 'forward')?.split('\n').at(-2), '++++ nor this');
});

test('a many-file patch is cut into one diff per file, each counted', () => {
  const patch = [
    'diff --git a/src/a.ts b/src/a.ts', 'index 1..2 100644', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,2 +1,2 @@', '-x', '+y', ' z',
    'diff --git a/new file.md b/new file.md', 'new file mode 100644', 'index 0..3', '--- /dev/null', '+++ b/new file.md', '@@ -0,0 +1 @@', '+hello',
    'diff --git a/gone.txt b/gone.txt', 'deleted file mode 100644', 'index 4..0', '--- a/gone.txt', '+++ /dev/null', '@@ -1 +0,0 @@', '-bye',
    'diff --git a/logo.png b/logo.png', 'index 5..6 100644', 'Binary files a/logo.png and b/logo.png differ',
    'diff --git a/old.ts b/renamed.ts', 'similarity index 100%', 'rename from old.ts', 'rename to renamed.ts', '',
  ].join('\n');
  const files = splitPatch(patch);
  assert.deepEqual(files.map((f) => [f.path, f.status, f.additions, f.deletions, f.binary, f.from ?? null]), [
    ['src/a.ts', 'M', 1, 1, false, null], ['new file.md', 'A', 1, 0, false, null], ['gone.txt', 'D', 0, 1, false, null],
    ['logo.png', 'M', 0, 0, true, null], ['renamed.ts', 'R', 0, 0, false, 'old.ts'],
  ]);
  assert.equal(files[0]?.diff, 'diff --git a/src/a.ts b/src/a.ts\nindex 1..2 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n-x\n+y\n z\n');
  assert.deepEqual(splitPatch(''), []);
});

test('only plain paths can be named in a patch built here', () => {
  assert.equal(plainPath('src/a file.ts'), true);
  for (const bad of ['a"b', 'a\\b', 'a\tb', '/abs', '../up', 'a/../b']) assert.equal(plainPath(bad), false, bad);
});
