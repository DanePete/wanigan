import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_COLOUR_LINES, diffHash, highlightDiff, noteTarget, parseDiff, pieces, splitRows, type DiffLine } from './diff.ts';
import { reviewMessage } from './review-notes.ts';

const DIFF = [
  'diff --git a/src/Pay.php b/src/Pay.php',
  'index 1111111..2222222 100644',
  '--- a/src/Pay.php',
  '+++ b/src/Pay.php',
  '@@ -10,6 +10,7 @@ final class Pay {',
  '   public function build() {',
  '-    $label = "Pay";',
  '-    return $label;',
  '+    $label = "Pay now";',
  '+    $label .= "!";',
  '+    return $label;',
  '   }',
  '@@ -40,2 +41,2 @@ final class Pay {',
  '-  // old',
  '+  // new',
  '\\ No newline at end of file',
].join('\n');

test('a unified diff becomes numbered lines, with the edited part of a paired line marked', () => {
  const lines = parseDiff(DIFF);
  assert.deepEqual(lines.map((l) => [l.kind, l.old, l.new]), [
    ['hunk', null, null], ['ctx', 10, 10], ['del', 11, null], ['del', 12, null], ['add', null, 11], ['add', null, 12], ['add', null, 13], ['ctx', 13, 14],
    ['hunk', null, null], ['del', 40, null], ['add', null, 41], ['meta', null, null],
  ]);
  assert.equal(lines[0]?.text, 'final class Pay {');
  assert.equal(lines[8]?.skipped, 26, 'the unchanged lines between hunks are counted');
  assert.equal(lines[2]?.changed, undefined, 'two removed against three added are not paired word by word');
  assert.deepEqual(lines[9]?.changed, [5, 8]);
  assert.deepEqual(lines[10]?.changed, [5, 8]);
});

test('syntax colour keeps the old file and the new apart, and starts each hunk afresh', () => {
  const lines = highlightDiff(parseDiff([
    '@@ -1,4 +1,4 @@',
    ' $a = 1;',
    '-/* removed, and never closed',
    '+$b = 2;',
    ' $c = 3;',
    '@@ -20,2 +20,2 @@',
    '  * @param string $x',
    '  */',
    '+$d = 4;',
  ].join('\n')), 'src/Pay.php');
  const kinds = (l: DiffLine | undefined): string[] => (l?.syntax ?? []).map(([s, e, k]) => `${l?.text.slice(s, e)}:${k}`);
  assert.deepEqual(kinds(lines[1]), ['$a:variable', '=:punct', '1:number', ';:punct']);
  assert.deepEqual(kinds(lines[2]), ['/* removed, and never closed:comment']);
  assert.deepEqual(kinds(lines[3]), ['$b:variable', '=:punct', '2:number', ';:punct'], 'a comment opened on a removed line does not colour an added one');
  assert.deepEqual(kinds(lines[4]), ['$c:variable', '=:punct', '3:number', ';:punct'], 'context is shown as the new file reads');
  assert.deepEqual(kinds(lines[6]), [' * @param string $x:comment'], 'a hunk that starts inside a doc comment is read as one');
  assert.deepEqual(kinds(lines[8]), ['$d:variable', '=:punct', '4:number', ';:punct']);
});

test('unknown files and very large ones stay plain', () => {
  assert.equal(highlightDiff(parseDiff('@@ -1 +1 @@\n-a\n+b'), 'LICENSE')[1]?.syntax, undefined);
  const big = ['@@ -1 +1 @@', ...Array.from({ length: MAX_COLOUR_LINES + 1 }, (_, i) => `+$x${i} = 1;`)].join('\n');
  assert.ok(highlightDiff(parseDiff(big), 'big.php').every((l) => !l.syntax));
  assert.ok(highlightDiff(parseDiff('@@ -1 +1 @@\n+$x = 1;'), 'small.php')[1]?.syntax?.length);
});

test('a line is cut into coloured pieces, inside any range, with gaps left plain', () => {
  const text = 'let a = 1;';
  const spans = [[0, 3, 'keyword'], [6, 7, 'punct'], [8, 9, 'number']] as [number, number, 'keyword' | 'punct' | 'number'][];
  assert.deepEqual(pieces(text, spans), [
    { text: 'let', kind: 'keyword' }, { text: ' a ', kind: null }, { text: '=', kind: 'punct' }, { text: ' ', kind: null }, { text: '1', kind: 'number' }, { text: ';', kind: null },
  ]);
  assert.deepEqual(pieces(text, spans, 1, 7), [{ text: 'et', kind: 'keyword' }, { text: ' a ', kind: null }, { text: '=', kind: 'punct' }]);
  assert.deepEqual(pieces(text, undefined), [{ text, kind: null }]);
  assert.deepEqual(pieces(text, spans, 4, 4), []);
});

test('side by side: context on both sides, edits paired row by row, the longer run facing blanks', () => {
  const rows = splitRows(parseDiff(DIFF));
  const show = rows.map((r) => (r.kind === 'pair' ? `${r.left ? `${r.left.kind}${r.left.old}` : '·'} | ${r.right ? `${r.right.kind}${r.right.new}` : '·'}` : r.kind));
  assert.deepEqual(show, [
    'hunk',
    'ctx10 | ctx10',
    'del11 | add11',
    'del12 | add12',
    '· | add13',
    'ctx13 | ctx14',
    'hunk',
    'del40 | add41',
    'meta',
  ]);
  const removedOnly = splitRows(parseDiff('@@ -1,3 +1,1 @@\n-a\n-b\n c'));
  assert.deepEqual(removedOnly.map((r) => (r.kind === 'pair' ? [r.left?.text ?? null, r.right?.text ?? null] : r.kind)), ['hunk', ['a', null], ['b', null], ['c', 'c']]);
  const addedOnly = splitRows(parseDiff('@@ -0,0 +1,2 @@\n+a\n+b'));
  assert.deepEqual(addedOnly.map((r) => (r.kind === 'pair' ? [r.left, r.right?.text] : r.kind)), ['hunk', [null, 'a'], [null, 'b']]);
});

test('side by side shows every line once, each side in its own order', () => {
  let seed = 3;
  const random = (): number => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let round = 0; round < 200; round++) {
    const body = Array.from({ length: Math.floor(random() * 30) }, (_, i) => `${[' ', '-', '+', '\\'][Math.floor(random() * 4)]}line ${i}`);
    const lines = parseDiff(['@@ -1,40 +1,40 @@', ...body].join('\n'));
    const rows = splitRows(lines);
    const left = rows.flatMap((r) => (r.kind === 'pair' && r.left ? [r.left] : []));
    const right = rows.flatMap((r) => (r.kind === 'pair' && r.right ? [r.right] : []));
    const others = rows.flatMap((r) => (r.kind !== 'pair' ? [r.line] : []));
    assert.deepEqual(left, lines.filter((l) => l.kind === 'del' || l.kind === 'ctx'));
    assert.deepEqual(right, lines.filter((l) => l.kind === 'add' || l.kind === 'ctx'));
    assert.deepEqual(new Set(others), new Set(lines.filter((l) => l.kind === 'hunk' || l.kind === 'meta')));
    for (const r of rows) if (r.kind === 'pair') assert.ok(r.left?.kind !== 'add' && r.right?.kind !== 'del');
  }
});

test('a note on a removed line attaches to the old file; on an added or unchanged line, to the new', () => {
  const lines = parseDiff(DIFF);
  const at = (i: number) => noteTarget(lines[i] as DiffLine);
  assert.deepEqual(at(2), { line: 11, side: 'old' });
  assert.deepEqual(at(4), { line: 11, side: 'new' });
  assert.deepEqual(at(1), { line: 10, side: 'new' });
  assert.equal(at(0), null);
  assert.equal(at(11), null);
  // In the side-by-side view a context row's two halves are one line, so a note from either goes to the new file.
  const row = splitRows(lines)[1];
  assert.ok(row?.kind === 'pair' && row.left === row.right);
  const message = reviewMessage([{ file: 'src/Pay.php', ...at(2)!, quote: lines[2]!.text, text: 'Why?' }], 'the folder');
  assert.match(message, /src\/Pay\.php:11 \(a removed line\)/);
});

test('a diff’s fingerprint is stable and changes with any edit', () => {
  assert.equal(diffHash(DIFF), diffHash(`${DIFF}`));
  assert.notEqual(diffHash(DIFF), diffHash(DIFF.replace('Pay now', 'Pay now.')));
  assert.notEqual(diffHash(''), diffHash(' '));
  assert.match(diffHash(DIFF), /^[0-9a-z]+$/);
});

test('inside a hunk, a line that looks like a file header is still a changed line', () => {
  const diff = [
    'diff --git a/q.sql b/q.sql',
    'index 1111111..2222222 100644',
    '--- a/q.sql',
    '+++ b/q.sql',
    '@@ -1,3 +1,3 @@',
    ' SELECT 1;',
    '--- drop the old table',
    '+++ counter',
    ' SELECT 2;',
    'diff --git a/b.txt b/b.txt',
    '--- a/b.txt',
    '+++ b/b.txt',
    '@@ -1 +1 @@',
    '-old',
    '+new',
    '\\ No newline at end of file',
    '',
  ].join('\n');
  const lines = parseDiff(diff).map((l) => [l.kind, l.text, l.old, l.new]);
  assert.deepEqual(lines, [
    ['hunk', '', null, null],
    ['ctx', 'SELECT 1;', 1, 1],
    ['del', '-- drop the old table', 2, null],
    ['add', '++ counter', null, 2],
    ['ctx', 'SELECT 2;', 3, 3],
    ['hunk', '', null, null],
    ['del', 'old', 1, null],
    ['add', 'new', null, 1],
    ['meta', 'No newline at end of file', null, null],
  ]);
});
