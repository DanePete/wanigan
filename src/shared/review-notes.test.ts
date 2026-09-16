/**
 * Review notes, the pure half. PATCH below is the exact output of `git diff
 * --cached` (git 2.50.1) on a scratch repository: a modified file with an added
 * line, a file with no trailing newline, a deleted file, and a new file whose
 * name has a space — for which git appends a tab after the `+++` path.
 *
 * The subject is the anchor. A note that names the wrong line, the wrong side
 * or the wrong file sends an agent to fix code nobody commented on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  commentable, formatReviewNotes, hunkRange, MAX_QUOTE_LINES, noteFromRows, noteLocation, parseUnifiedDiff,
  type ReviewNote,
} from './review-notes.ts';

const PATCH = [
  'diff --git a/a.txt b/a.txt',
  'index b2f931a..9642008 100644',
  '--- a/a.txt',
  '+++ b/a.txt',
  '@@ -1,5 +1,6 @@',
  ' one',
  '-two',
  '+TWO',
  ' three',
  ' four',
  ' five',
  '+six',
  'diff --git a/nonl.txt b/nonl.txt',
  'index c1b0730..e25f181 100644',
  '--- a/nonl.txt',
  '+++ b/nonl.txt',
  '@@ -1 +1 @@',
  '-x',
  '\\ No newline at end of file',
  '+y',
  '\\ No newline at end of file',
  'diff --git a/old.txt b/old.txt',
  'deleted file mode 100644',
  'index 286c5f5..0000000',
  '--- a/old.txt',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-gone',
  'diff --git a/sp ace.txt b/sp ace.txt',
  'new file mode 100644',
  'index 0000000..fa49b07',
  '--- /dev/null',
  '+++ b/sp ace.txt\t',
  '@@ -0,0 +1 @@',
  '+new file',
].join('\n');

const rows = parseUnifiedDiff(PATCH);
const at = (text: string, file: string) => rows.findIndex((r) => r.text === text && r.file === file);

test('every code row knows its file and both line numbers', () => {
  assert.deepEqual(rows[at(' one', 'a.txt')], { kind: 'ctx', text: ' one', file: 'a.txt', oldLine: 1, newLine: 1 });
  assert.deepEqual(rows[at('-two', 'a.txt')], { kind: 'del', text: '-two', file: 'a.txt', oldLine: 2, newLine: null });
  assert.deepEqual(rows[at('+TWO', 'a.txt')], { kind: 'add', text: '+TWO', file: 'a.txt', oldLine: null, newLine: 2 });
  assert.deepEqual(rows[at(' three', 'a.txt')], { kind: 'ctx', text: ' three', file: 'a.txt', oldLine: 3, newLine: 3 });
  assert.deepEqual(rows[at('+six', 'a.txt')], { kind: 'add', text: '+six', file: 'a.txt', oldLine: null, newLine: 6 });
});

test('"No newline at end of file" is not a line of code and does not advance the count', () => {
  const marker = rows.filter((r) => r.text.startsWith('\\'));
  assert.equal(marker.length, 2);
  assert(marker.every((r) => r.kind === 'meta' && !commentable(r)));
  assert.equal(rows[at('+y', 'nonl.txt')].newLine, 1);
});

test('a deleted file keeps its name even though +++ is /dev/null', () => {
  assert.deepEqual(rows[at('-gone', 'old.txt')], { kind: 'del', text: '-gone', file: 'old.txt', oldLine: 1, newLine: null });
});

test("a new file's name loses git's trailing tab", () => {
  assert.equal(rows[at('+new file', 'sp ace.txt')].newLine, 1);
});

test('the empty string a trailing newline leaves is not a line of code', () => {
  const withNewline = parseUnifiedDiff(`${PATCH}\n`);
  const last = withNewline[withNewline.length - 1];
  assert.deepEqual([last.kind, last.text, commentable(last)], ['meta', '', false]);
  // One hunk, ending in a newline, the way git hands a single-file diff over.
  const single = parseUnifiedDiff('@@ -1,2 +1,2 @@\n-a\n+b\n c\n', 'x.ts');
  assert.equal(single.filter(commentable).length, 3);
  const header = single.findIndex((r) => r.kind === 'hunk');
  assert.deepEqual(hunkRange(single, header), { from: 1, to: 3 });
});

test('a changed line that begins like a file header is still a changed line', () => {
  // Exact `git log -p -U0` output (git 2.50.1) for a commit appending `++ weird`
  // and `-- weird2` to f.txt, plus the `-- note` a SQL comment makes on the
  // removed side. Read by prefix, the first renamed the file to "weird" and
  // every line after it was numbered one short.
  const tricky = parseUnifiedDiff([
    'diff --git a/f.txt b/f.txt',
    'index d68dd40..ef62ba1 100644',
    '--- a/f.txt',
    '+++ b/f.txt',
    '@@ -4,1 +4,3 @@ d',
    '--- note',
    '+++ weird',
    '+-- weird2',
    '+after',
  ].join('\n'));
  assert.deepEqual(tricky.slice(5).map((r) => [r.kind, r.file, r.oldLine, r.newLine]), [
    ['del', 'f.txt', 4, null],
    ['add', 'f.txt', null, 4],
    ['add', 'f.txt', null, 5],
    ['add', 'f.txt', null, 6],
  ]);
});

test('a hunk header with no count means one line on that side', () => {
  const rowsOne = parseUnifiedDiff('@@ -5 +5 @@\n-old\n+new\n trailing', 'x.ts');
  assert.deepEqual(rowsOne.map((r) => [r.kind, r.oldLine, r.newLine]),
    [['hunk', null, null], ['del', 5, null], ['add', null, 5], ['meta', null, null]]);
});

test('headers and hunk lines are never commentable', () => {
  for (const r of rows.filter((x) => x.kind === 'meta' || x.kind === 'hunk')) assert.equal(commentable(r), false);
});

test('a single-file diff with its headers trimmed takes the fallback name', () => {
  const trimmed = parseUnifiedDiff('@@ -10,2 +10,3 @@\n keep\n+added\n keep2', 'src/x.ts');
  assert.deepEqual(trimmed[2], { kind: 'add', text: '+added', file: 'src/x.ts', oldLine: null, newLine: 11 });
});

test('a note over a replaced line anchors both sides, new side first', () => {
  const r = noteFromRows(rows, at('-two', 'a.txt'), at('+TWO', 'a.txt'), ' Why uppercase? ', 'n1');
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.note, { id: 'n1', file: 'a.txt', oldStart: 2, oldEnd: 2, newStart: 2, newEnd: 2,
    quote: ['-two', '+TWO'], quoteOmitted: 0, body: 'Why uppercase?' });
  assert.equal(noteLocation(r.note), 'line 2 (was line 2)');
});

test('a selection made bottom-up is the same note as top-down', () => {
  const down = noteFromRows(rows, at(' three', 'a.txt'), at('+six', 'a.txt'), 'c', 'x');
  const up = noteFromRows(rows, at('+six', 'a.txt'), at(' three', 'a.txt'), 'c', 'x');
  assert.deepEqual(down, up);
  assert.equal(down.ok && noteLocation(down.note), 'lines 3–6 (was lines 3–5)');
});

test('a removed-only selection says the lines were removed', () => {
  const r = noteFromRows(rows, at('-gone', 'old.txt'), at('-gone', 'old.txt'), 'Still imported by b.ts', 'x');
  assert.equal(r.ok && noteLocation(r.note), 'line 1, removed');
});

test('a note refuses to span two files, to hold no code, or to say nothing', () => {
  const spans = noteFromRows(rows, at('+six', 'a.txt'), at('+y', 'nonl.txt'), 'c', 'x');
  assert.deepEqual(spans, { ok: false, reason: 'A note covers lines in one file. Select lines from a single file.' });
  const header = rows.findIndex((r) => r.kind === 'hunk');
  assert.equal(noteFromRows(rows, header, header, 'c', 'x').ok, false);
  assert.equal(noteFromRows(rows, at('+TWO', 'a.txt'), at('+TWO', 'a.txt'), '   ', 'x').ok, false);
});

test('a hunk header selects exactly its own lines', () => {
  const header = rows.findIndex((r) => r.kind === 'hunk' && r.file === 'a.txt');
  assert.deepEqual(hunkRange(rows, header), { from: header + 1, to: at('+six', 'a.txt') });
  assert.equal(hunkRange(rows, at(' one', 'a.txt')), null);
});

test('a long selection quotes a bounded number of lines and counts the rest', () => {
  const big = parseUnifiedDiff(['@@ -1,0 +1,20 @@', ...Array.from({ length: 20 }, (_, i) => `+l${i}`)].join('\n'), 'big.ts');
  const r = noteFromRows(big, 1, 20, 'split this', 'x');
  assert.equal(r.ok && r.note.quote.length, MAX_QUOTE_LINES);
  assert.equal(r.ok && r.note.quoteOmitted, 20 - MAX_QUOTE_LINES);
});

test('the message names its diff, numbers the notes and quotes each anchor', () => {
  const one = noteFromRows(rows, at('-two', 'a.txt'), at('+TWO', 'a.txt'), 'Why uppercase?\nThe API expects lowercase.', 'n1');
  const two = noteFromRows(rows, at('-gone', 'old.txt'), at('-gone', 'old.txt'), 'Still imported by b.ts', 'n2');
  assert(one.ok && two.ok);
  const text = formatReviewNotes([one.note, two.note] as ReviewNote[], 'your uncommitted changes against 1a2b3c4d');
  assert.equal(text, [
    'Review notes on your uncommitted changes against 1a2b3c4d.',
    'Address each one, or reply saying why you are leaving it as it is.',
    '',
    '1. `a.txt`, line 2 (was line 2):',
    '   ```diff',
    '   -two',
    '   +TWO',
    '   ```',
    '   Why uppercase?',
    '   The API expects lowercase.',
    '',
    '2. `old.txt`, line 1, removed:',
    '   ```diff',
    '   -gone',
    '   ```',
    '   Still imported by b.ts',
  ].join('\n'));
});
