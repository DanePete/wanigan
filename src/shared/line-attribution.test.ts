/**
 * Line attribution's pure half: diffs into added ranges, blame into per-line
 * origins, consecutive lines into annotated ranges, and the Git AI note text.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addedRangesFromDiff, annotate, authorshipNote, inRanges, mergeRanges, parseBlamePorcelain, rangeLines, rangeSpec, turnAt, turnForCommit, isUncommitted,
} from './line-attribution.ts';

test('ranges merge, count and print in the Git AI format', () => {
  assert.deepEqual(mergeRanges([[9, 9], [1, 3], [4, 4], [12, 14], [13, 20], [0, 2], [5, 4]]), [[1, 4], [9, 9], [12, 20]]);
  assert.equal(rangeLines([[1, 4], [9, 9], [3, 5]]), 6);
  assert.equal(rangeSpec([[12, 14], [1, 4], [9, 9]]), '1-4,9,12-14');
  assert.equal(inRanges([[3, 5]], 4), true);
  assert.equal(inRanges([[3, 5]], 6), false);
  assert.equal(inRanges(undefined, 1), false);
});

test('a -U0 diff gives added lines in the new file\'s numbers, per file', () => {
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 111..222 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -2,0 +3,2 @@ export const a = 1;',
    '+export const b = 2;',
    '+export const c = 3;',
    '@@ -10 +12 @@',
    '-old',
    '+new',
    '@@ -20,2 +22,0 @@',
    '-gone',
    '-gone too',
    'diff --git a/new.txt b/new.txt',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/new.txt',
    '@@ -0,0 +1,3 @@',
    '+one',
    '+two',
    '+three',
    '\\ No newline at end of file',
    'diff --git a/removed.txt b/removed.txt',
    'deleted file mode 100644',
    '--- a/removed.txt',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-bye',
    'diff --git a/img.png b/img.png',
    'Binary files /dev/null and b/img.png differ',
    'diff --git "a/with space.md" "b/with space.md"',
    '--- "a/with space.md"',
    '+++ "b/with space.md"',
    '@@ -0,0 +1 @@',
    '+hi',
  ].join('\n');
  const r = addedRangesFromDiff(diff);
  assert.deepEqual(Object.fromEntries(r), { 'src/a.ts': [[3, 4], [12, 12]], 'new.txt': [[1, 3]], 'with space.md': [[1, 1]] });
});

test('a diff with context lines still counts only the added ones', () => {
  const diff = ['--- a/f', '+++ b/f', '@@ -1,4 +1,5 @@', ' one', '+two', ' three', '+four', '+five', '-six', '-seven'].join('\n');
  assert.deepEqual(addedRangesFromDiff(diff).get('f'), [[2, 2], [4, 5]]);
  // Added text that itself looks like a header is still body, because the hunk still owes lines.
  const tricky = ['--- a/g', '+++ b/g', '@@ -0,0 +1,3 @@', '+++ not a header', '+--- nor this', '+@@ -1 +1 @@'].join('\n');
  assert.deepEqual(Object.fromEntries(addedRangesFromDiff(tricky)), { g: [[1, 3]] });
});

test('blame porcelain gives each final line its commit and original line', () => {
  const a = 'a'.repeat(40);
  const z = '0'.repeat(40);
  const text = [
    `${a} 1 1 2`, 'author Smoke', 'author-mail <s@x>', 'summary first', 'filename src/a.ts', '\tline one',
    `${a} 2 2`, '\tline two',
    `${z} 3 3 1`, 'author Not Committed Yet', 'filename src/a.ts', '\tfresh',
  ].join('\n');
  const lines = parseBlamePorcelain(text);
  assert.deepEqual(lines.map((l) => [l.finalLine, l.commit.slice(0, 1), l.origLine, l.file]), [[1, 'a', 1, 'src/a.ts'], [2, 'a', 2, 'src/a.ts'], [3, '0', 3, 'src/a.ts']]);
  assert.equal(isUncommitted(lines[2].commit), true);
  assert.equal(isUncommitted(lines[0].commit), false);
});

test('consecutive lines from the same session and turn become one range; unknown lines stay unmarked', () => {
  const lines = [1, 2, 3, 4, 5, 6].map((n) => ({ finalLine: n, commit: n <= 3 ? 'c1' : n === 4 ? 'c0' : 'c2', origLine: n, file: 'f' }));
  const authors: Record<string, { sessionId: string; title: string; turn: number | null; origin: 'commit' }> = {
    c1: { sessionId: 's1', title: 'Fix rounding', turn: 2, origin: 'commit' },
    c2: { sessionId: 's1', title: 'Fix rounding', turn: 3, origin: 'commit' },
  };
  const ranges = annotate(lines, (l) => authors[l.commit] ?? null);
  assert.deepEqual(ranges.map((r) => [r.start, r.end, r.turn]), [[1, 3, 2], [5, 6, 3]]);
});

test('a commit belongs to the last turn that had started when it was made', () => {
  const starts = [{ turn: 1, at: 100 }, { turn: 3, at: 300 }, { turn: 2, at: 200 }];
  assert.equal(turnAt(starts, 50), null);
  assert.equal(turnAt(starts, 250), 2);
  assert.equal(turnAt(starts, 999), 3);
});

test('a commit made in the same second the next turn started still belongs to the turn it was made in', () => {
  const turns = [{ turn: 1, startAt: 10_100, endAt: 10_400 }, { turn: 2, startAt: 10_600, endAt: 10_900 }, { turn: 3, startAt: 20_000, endAt: null }];
  assert.equal(turnForCommit(turns, 10_000), 1, 'committed during turn 1, in the second turn 2 also began');
  assert.equal(turnForCommit(turns, 15_000), 2, 'between turns, after turn 2 ended: the last turn that had started');
  assert.equal(turnForCommit(turns, 25_000), 3, 'during a turn still running');
  assert.equal(turnForCommit(turns, 1_000), null, 'before any turn');
});

test('the authorship note follows the Git AI v3 shape and carries no prompt', () => {
  const note = authorshipNote({
    baseCommit: 'b'.repeat(40),
    generator: 'wanigan',
    entries: [
      { file: 'src/main.rs', key: 's_c9883b05a2487d::t_9f8e7d6c5b4a32', ranges: [[15, 20], [1, 10]] },
      { file: 'my file.rs', key: 's_c9883b05a2487d::t_a1b2c3d4e5f678', ranges: [[2, 2]] },
      { file: 'empty.rs', key: 's_c9883b05a2487d::t_000000000000000', ranges: [] },
    ],
    sessions: [{ key: 's_c9883b05a2487d::t_9f8e7d6c5b4a32', tool: 'claude', id: 'conv-1', model: 'claude-opus-5' }],
  });
  const [attest, meta] = note.split('\n---\n');
  assert.equal(attest, '"my file.rs"\n  s_c9883b05a2487d::t_a1b2c3d4e5f678 2\nsrc/main.rs\n  s_c9883b05a2487d::t_9f8e7d6c5b4a32 1-10,15-20');
  const json = JSON.parse(meta) as Record<string, unknown>;
  assert.equal(json.schema_version, 'authorship/3.0.0');
  assert.equal(json.base_commit_sha, 'b'.repeat(40));
  assert.deepEqual(json.prompts, {});
  assert.deepEqual(json.sessions, { s_c9883b05a2487d: { agent_id: { tool: 'claude', id: 'conv-1', model: 'claude-opus-5' } } });
  assert.ok(!note.includes('empty.rs'), 'a file with no attested lines is left out');
});
