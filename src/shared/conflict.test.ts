import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chosenLines, conflictCount, parseConflicts, resolveConflicts, type HunkChoice } from './conflict.ts';

const MERGE = [
  'const a = 1;',
  '<<<<<<< main',
  'const b = 22;',
  '=======',
  'const b = 222;',
  '>>>>>>> side',
  'const c = 3;',
  '<<<<<<< main',
  '=======',
  'const d = 4;',
  '>>>>>>> side',
  '',
].join('\n');

test('merge-style conflicts: the agreed text, and each conflict’s two sides with their labels and place', () => {
  const p = parseConflicts(MERGE);
  assert.equal(p.hunks.length, 2);
  assert.deepEqual(p.hunks.map((h) => [h.ours, h.theirs, h.base, h.oursLabel, h.theirsLabel, h.line]), [
    [['const b = 22;'], ['const b = 222;'], null, 'main', 'side', 2],
    [[], ['const d = 4;'], null, 'main', 'side', 8],
  ]);
  assert.deepEqual(p.segments.map((s) => (s.kind === 'text' ? s.lines.join('|') : `#${s.hunk.index}`)), ['const a = 1;', '#0', 'const c = 3;', '#1']);
  assert.equal(p.finalNewline, true);
});

test('diff3 style: the base between the sides, labelled', () => {
  const text = ['<<<<<<< ours', 'x = 2', '||||||| base', 'x = 1', '=======', 'x = 3', '>>>>>>> theirs', ''].join('\n');
  const [h] = parseConflicts(text).hunks;
  assert.deepEqual([h?.ours, h?.base, h?.theirs, h?.baseLabel], [['x = 2'], ['x = 1'], ['x = 3'], 'base']);
  assert.deepEqual(chosenLines(h!, 'base'), ['x = 1']);
});

test('markers inside strings, comments or code, and an opening with no close, are text', () => {
  const text = [
    'const s = "<<<<<<< HEAD";',
    '  <<<<<<< indented is not a marker',
    '// ======= a divider in a comment',
    '<<<<<<<< eight is a different size, and never closes',
    '<<<<<<< opens but never splits or closes',
    'end',
    '',
  ].join('\n');
  const p = parseConflicts(text);
  assert.equal(p.hunks.length, 0);
  assert.equal(resolveConflicts(p, new Map()).text, text, 'read and written back unchanged');
  // A Markdown heading's underline outside a conflict is text too.
  assert.equal(conflictCount('Title\n=======\n\nBody\n'), 0);
});

test('a conflict inside a conflict uses longer markers, and stays content of the outer one', () => {
  const text = [
    '<<<<<<< ours', 'outer ours', '=======',
    '<<<<<<<<< inner', 'a', '=========', 'b', '>>>>>>>>> inner',
    '>>>>>>> theirs', '',
  ].join('\n');
  const [h, ...rest] = parseConflicts(text).hunks;
  assert.equal(rest.length, 0);
  assert.deepEqual(h?.theirs, ['<<<<<<<<< inner', 'a', '=========', 'b', '>>>>>>>>> inner']);
});

test('choices: a side, both in either order, the base, or text written by hand; what is not chosen keeps its markers', () => {
  const p = parseConflicts(MERGE);
  const resolve = (choices: [number, HunkChoice][]) => resolveConflicts(p, new Map(choices));
  assert.deepEqual(resolve([[0, 'ours'], [1, 'theirs']]), { text: 'const a = 1;\nconst b = 22;\nconst c = 3;\nconst d = 4;\n', left: 0 });
  assert.equal(resolve([[0, 'ours-then-theirs'], [1, 'ours']]).text, 'const a = 1;\nconst b = 22;\nconst b = 222;\nconst c = 3;\n');
  assert.equal(resolve([[0, 'theirs-then-ours'], [1, 'ours']]).text, 'const a = 1;\nconst b = 222;\nconst b = 22;\nconst c = 3;\n');
  assert.equal(resolve([[0, { text: 'const b = 2222;\n' }], [1, 'ours']]).text, 'const a = 1;\nconst b = 2222;\nconst c = 3;\n');
  const half = resolve([[1, 'theirs']]);
  assert.equal(half.left, 1);
  assert.equal(half.text, 'const a = 1;\n<<<<<<< main\nconst b = 22;\n=======\nconst b = 222;\n>>>>>>> side\nconst c = 3;\nconst d = 4;\n');
  assert.equal(conflictCount(half.text), 1);
  assert.equal(resolve([]).text, MERGE, 'nothing chosen is the file as git wrote it');
});

test('many hunks in one file are numbered in order and resolved independently', () => {
  const text = Array.from({ length: 12 }, (_, i) => [`line ${i}`, '<<<<<<< a', `ours ${i}`, '=======', `theirs ${i}`, '>>>>>>> b']).flat().join('\n');
  const p = parseConflicts(text);
  assert.equal(p.hunks.length, 12);
  const choices = new Map<number, HunkChoice>(p.hunks.map((h) => [h.index, h.index % 2 ? 'theirs' : 'ours']));
  const out = resolveConflicts(p, choices);
  assert.equal(out.left, 0);
  assert.equal(out.text.split('\n').filter((l) => l.startsWith('ours')).length, 6);
  assert.equal(out.text.endsWith('theirs 11'), true, 'no final newline when the file had none');
});

test('Windows line endings are kept, and an empty file is empty', () => {
  const text = 'a\r\n<<<<<<< x\r\nb\r\n=======\r\nc\r\n>>>>>>> y\r\n';
  const p = parseConflicts(text);
  assert.equal(p.eol, '\r\n');
  assert.equal(resolveConflicts(p, new Map([[0, 'theirs']])).text, 'a\r\nc\r\n');
  assert.deepEqual(parseConflicts(''), { segments: [], hunks: [], eol: '\n', finalNewline: false });
  // Taking an empty side at the end of a file leaves the file ending as it did.
  assert.equal(resolveConflicts(parseConflicts('a\n<<<<<<< x\n=======\nb\n>>>>>>> y\n'), new Map([[0, 'ours']])).text, 'a\n');
});
