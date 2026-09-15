/**
 * Agent change notes, the pure half. The patches below are exact `git diff
 * HEAD` output (git 2.50.1) from a scratch repository: a modified file with two
 * hunks, a deleted file, and a new file added with `git add -N`.
 *
 * The subject is the anchor and the boundary. A note that claims a range
 * outside the hunk it names explains code the agent did not change; a path
 * that climbs out of the checkout names a file the session does not own.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUnifiedDiff, MAX_NOTE_CHARS } from './review-notes.ts';
import {
  CHANGE_NOTE_HINT, MAX_CHANGE_NOTE_CHARS, STALE_LABEL, anchorKey, anchorLines, changeNoteHint, changeNoteLocation, changeNoteStaleness,
  diffHunks, launchInstructionParts, normalizeNotePath, parseChangeNoteArgs, quotesAgent, reviewNoteFromChangeNote, rowInNote, walkOrder,
  type ChangeNoteRecord,
} from './change-notes.ts';

const MODIFIED = [
  'diff --git a/a.txt b/a.txt',
  'index ac9837c..5667b92 100644',
  '--- a/a.txt',
  '+++ b/a.txt',
  '@@ -1,6 +1,6 @@',
  ' line 1',
  ' line 2',
  '-line 3',
  '+LINE THREE',
  ' line 4',
  ' line 5',
  ' line 6',
  '@@ -22,9 +22,10 @@ line 21',
  ' line 22',
  ' line 23',
  ' line 24',
  '-line 25',
  '+line twenty-five',
  ' line 26',
  ' line 27',
  '+added after 27',
  ' line 28',
  ' line 29',
  ' line 30',
  '',
].join('\n');

const DELETED = [
  'diff --git a/old.txt b/old.txt',
  'deleted file mode 100644',
  'index a85183a..0000000',
  '--- a/old.txt',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  '-gone 1',
  '-gone 2',
  '',
].join('\n');

const ADDED = [
  'diff --git a/new.txt b/new.txt',
  'new file mode 100644',
  'index 0000000..cef4f6c',
  '--- /dev/null',
  '+++ b/new.txt',
  '@@ -0,0 +1,3 @@',
  '+fresh 1',
  '+fresh 2',
  '+fresh 3',
  '',
].join('\n');

const rowsOf = (patch: string, file: string) => parseUnifiedDiff(patch, file);

/* ── paths ───────────────────────────────────────────────────────────── */

test('a relative path is normalised the way git names it', () => {
  assert.deepEqual(normalizeNotePath('src/app.ts'), { ok: true, value: 'src/app.ts' });
  assert.deepEqual(normalizeNotePath('./src//app.ts'), { ok: true, value: 'src/app.ts' });
  assert.deepEqual(normalizeNotePath('  a.txt '), { ok: true, value: 'a.txt' });
});

test('a path outside the checkout, absolute, or inside .git is refused with the reason', () => {
  const refused = (raw: unknown, pattern: RegExp) => {
    const r = normalizeNotePath(raw);
    assert.equal(r.ok, false, `refused: ${String(raw)}`);
    if (!r.ok) assert.match(r.reason, pattern);
  };
  refused('../etc/passwd', /climbs out/);
  refused('src/../../x', /climbs out/);
  refused('/etc/passwd', /is absolute/);
  refused('~/secrets', /is absolute/);
  refused('C:/Windows/x', /is absolute/);
  refused('src\\app.ts', /backslashes/);
  refused('.git/config', /inside \.git/);
  refused('a\u0000b', /control character/);
  refused('', /required/);
  refused('.', /checkout itself/);
  refused(42, /must be a string/);
  refused('x'.repeat(1001), /longer than/);
});

/* ── arguments ───────────────────────────────────────────────────────── */

test('the annotate arguments parse, and endLine defaults to startLine', () => {
  const r = parseChangeNoteArgs({ path: 'a.txt', side: 'new', startLine: 3, note: '  Upper-cased because the parser keys on it.  ' });
  assert.deepEqual(r, { ok: true, value: { path: 'a.txt', side: 'new', startLine: 3, endLine: 3, note: 'Upper-cased because the parser keys on it.' } });
});

test('a session id offered by the caller is refused by name', () => {
  for (const key of ['sessionId', 'session_id', 'session']) {
    const r = parseChangeNoteArgs({ path: 'a.txt', side: 'new', startLine: 1, endLine: 1, note: 'x', [key]: 'someone-else' });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /takes no session id/);
  }
});

test('bad sides, lines, notes and unknown arguments are refused with a sentence', () => {
  const reason = (args: Record<string, unknown>) => { const r = parseChangeNoteArgs(args); assert.equal(r.ok, false); return r.ok ? '' : r.reason; };
  const base = { path: 'a.txt', side: 'new', startLine: 3, endLine: 4, note: 'why' };
  assert.match(reason({ ...base, side: 'both' }), /side must be "new"/);
  assert.match(reason({ ...base, startLine: 0 }), /startLine must be a whole line number/);
  assert.match(reason({ ...base, startLine: 2.5 }), /startLine must be a whole line number/);
  assert.match(reason({ ...base, startLine: 5, endLine: 4 }), /endLine \(4\) is before startLine \(5\)/);
  assert.match(reason({ ...base, note: '   ' }), /note is required/);
  assert.match(reason({ ...base, note: 'x'.repeat(MAX_CHANGE_NOTE_CHARS + 1) }), /keep it to 2,000/);
  assert.equal(parseChangeNoteArgs({ ...base, note: 'x'.repeat(MAX_CHANGE_NOTE_CHARS) }).ok, true, 'exactly the limit is allowed');
  assert.match(reason({ ...base, reviewNoteId: 'r1' }), /Unknown argument: reviewNoteId/);
});

/* ── hunk containment ───────────────────────────────────────────────── */

test('hunk headers are read with the line ranges each covers, an omitted count meaning one', () => {
  assert.deepEqual(diffHunks(rowsOf(MODIFIED, 'a.txt')).map((h) => [h.oldStart, h.oldCount, h.newStart, h.newCount]), [[1, 6, 1, 6], [22, 9, 22, 10]]);
  assert.deepEqual(diffHunks(parseUnifiedDiff('@@ -4 +4 @@\n-a\n+b\n', 'x')).map((h) => [h.oldCount, h.newCount]), [[1, 1]]);
});

test('a range inside one hunk anchors to exactly its lines, on the side it names', () => {
  const rows = rowsOf(MODIFIED, 'a.txt');
  const now = anchorLines(rows, 'a.txt', 'new', 25, 28);
  assert.equal(now.ok, true);
  if (now.ok) assert.deepEqual(now.value.lines, ['+line twenty-five', ' line 26', ' line 27', '+added after 27']);
  const was = anchorLines(rows, 'a.txt', 'old', 3, 3);
  assert.equal(was.ok, true);
  if (was.ok) {
    assert.deepEqual(was.value.lines, ['-line 3']);
    assert.equal(was.value.hunk.header, '@@ -1,6 +1,6 @@');
  }
  // Context lines inside the hunk header's range are part of the hunk.
  assert.equal(anchorLines(rows, 'a.txt', 'new', 1, 6).ok, true);
  assert.equal(anchorLines(rows, 'a.txt', 'new', 31, 31).ok, true, 'the hunk grew by one line on the new side');
});

test('a range outside every hunk, or across two, is refused with the ranges the hunks cover', () => {
  const rows = rowsOf(MODIFIED, 'a.txt');
  const outside = anchorLines(rows, 'a.txt', 'new', 10, 12);
  assert.equal(outside.ok, false);
  if (!outside.ok) assert.equal(outside.reason, 'Lines 10–12 on the new side of `a.txt` are not inside one hunk of this session\'s diff. Its hunks cover new lines 1–6, 22–31.');
  const across = anchorLines(rows, 'a.txt', 'new', 5, 23);
  assert.equal(across.ok, false, 'a range spanning both hunks and the unchanged code between them is refused');
  const past = anchorLines(rows, 'a.txt', 'old', 30, 31);
  assert.equal(past.ok, false, 'old line 31 does not exist in the hunk');
  if (!past.ok) assert.match(past.reason, /old lines 1–6, 22–30/);
});

test('a new file has no old side and a deleted file has no new side, and each says so', () => {
  const added = anchorLines(rowsOf(ADDED, 'new.txt'), 'new.txt', 'old', 1, 1);
  assert.equal(added.ok, false);
  if (!added.ok) assert.match(added.reason, /is new in this session's diff, so it has no old side\. Use side "new"\./);
  assert.equal(anchorLines(rowsOf(ADDED, 'new.txt'), 'new.txt', 'new', 1, 3).ok, true);
  const deleted = anchorLines(rowsOf(DELETED, 'old.txt'), 'old.txt', 'new', 1, 1);
  assert.equal(deleted.ok, false);
  if (!deleted.ok) assert.match(deleted.reason, /is deleted .* no new side\. Use side "old"\./);
  const gone = anchorLines(rowsOf(DELETED, 'old.txt'), 'old.txt', 'old', 2, 2);
  assert.equal(gone.ok, true);
  if (gone.ok) assert.deepEqual(gone.value.lines, ['-gone 2']);
  const binary = anchorLines(parseUnifiedDiff('diff --git a/x.png b/x.png\nBinary files a/x.png and b/x.png differ\n', 'x.png'), 'x.png', 'new', 1, 1);
  assert.equal(binary.ok, false);
  if (!binary.ok) assert.match(binary.reason, /no hunks with lines/);
});

/* ── staleness ───────────────────────────────────────────────────────── */

test('a note stays current while its own lines read the same, even when the file changed elsewhere', () => {
  const rows = rowsOf(MODIFIED, 'a.txt');
  const anchored = anchorLines(rows, 'a.txt', 'new', 3, 3);
  assert.equal(anchored.ok, true);
  const note = { path: 'a.txt', side: 'new' as const, startLine: 3, endLine: 3, anchorKey: anchored.ok ? anchorKey(anchored.value.lines) : '' };
  assert.equal(changeNoteStaleness(note, { inDiff: true, rows }).state, 'current');
  const editedElsewhere = rowsOf(MODIFIED.replace('+added after 27', '+added after 27, then edited'), 'a.txt');
  assert.deepEqual(changeNoteStaleness(note, { inDiff: true, rows: editedElsewhere }), { state: 'current', stale: false, because: 'The lines still read as they did when the note was written.' });
});

test('a note whose lines changed, left the hunk, or whose file left the diff is stale, each with its reason', () => {
  const rows = rowsOf(MODIFIED, 'a.txt');
  const anchored = anchorLines(rows, 'a.txt', 'new', 3, 3);
  const note = { path: 'a.txt', side: 'new' as const, startLine: 3, endLine: 3, anchorKey: anchored.ok ? anchorKey(anchored.value.lines) : '' };
  const rewritten = changeNoteStaleness(note, { inDiff: true, rows: rowsOf(MODIFIED.replace('+LINE THREE', '+Line Three'), 'a.txt') });
  assert.equal(rewritten.state, 'lines-changed');
  assert.equal(rewritten.stale, true);
  assert.match(rewritten.because, /new line 3 reads differently/);
  // The agent put line 3 back as it was: only the second hunk is left.
  const onlySecondHunk = MODIFIED.slice(0, MODIFIED.indexOf('@@ -1,6')) + MODIFIED.slice(MODIFIED.indexOf('@@ -22'));
  const outside = changeNoteStaleness(note, { inDiff: true, rows: rowsOf(onlySecondHunk, 'a.txt') });
  assert.equal(outside.state, 'outside-hunk');
  assert.equal(outside.stale, true);
  const left = changeNoteStaleness(note, { inDiff: false, rows: null });
  assert.equal(left.state, 'file-left-diff');
  assert.equal(left.stale, true);
  const unreadable = changeNoteStaleness(note, { inDiff: true, rows: null, unreadable: 'fatal: bad object' });
  assert.equal(unreadable.state, 'unreadable');
  assert.equal(unreadable.stale, false, 'a diff git could not read claims nothing either way');
  assert.equal(STALE_LABEL, 'the code changed since this note');
});

test('lines pushed down by an insertion above them read as changed, because the note names line numbers', () => {
  const before = rowsOf(ADDED, 'new.txt');
  const anchored = anchorLines(before, 'new.txt', 'new', 2, 2);
  const note = { path: 'new.txt', side: 'new' as const, startLine: 2, endLine: 2, anchorKey: anchored.ok ? anchorKey(anchored.value.lines) : '' };
  const shifted = rowsOf(ADDED.replace('@@ -0,0 +1,3 @@\n+fresh 1', '@@ -0,0 +1,4 @@\n+inserted\n+fresh 1'), 'new.txt');
  assert.equal(changeNoteStaleness(note, { inDiff: true, rows: shifted }).state, 'lines-changed');
});

test('anchor keys tell lines apart and are stable', () => {
  assert.equal(anchorKey(['+a', ' b']), anchorKey(['+a', ' b']));
  assert.notEqual(anchorKey(['+a', ' b']), anchorKey(['+a', ' c']));
  assert.notEqual(anchorKey(['+a']), anchorKey(['-a']), 'the side prefix is part of the key');
  assert.match(anchorKey(['x']), /^1:[0-9a-f]+$/);
});

/* ── walk order, location, rows ─────────────────────────────────────── */

const record = (over: Partial<ChangeNoteRecord>): ChangeNoteRecord => ({
  id: 'cn_0000000000000000', path: 'a.txt', side: 'new', startLine: 1, endLine: 1, body: 'why', quote: ['+x'], quoteOmitted: 0,
  hunkHeader: '@@ -1 +1 @@', createdAt: 1, dismissedAt: null, quotedAt: null, ...over,
});

test('the walk visits notes by file, then line, new side before old at the same line', () => {
  const notes = [
    record({ id: 'c', path: 'src/z.ts', startLine: 1 }),
    record({ id: 'b', path: 'src/a.ts', startLine: 40 }),
    record({ id: 'd', path: 'src/a.ts', startLine: 7, side: 'old' }),
    record({ id: 'a', path: 'src/a.ts', startLine: 7, side: 'new' }),
    record({ id: 'e', path: 'README.md', startLine: 99 }),
  ];
  assert.deepEqual(walkOrder(notes).map((n) => n.id), ['e', 'a', 'd', 'b', 'c']);
});

test('a note says where it points, and which diff rows it covers', () => {
  assert.equal(changeNoteLocation(record({ startLine: 3, endLine: 5 })), 'new lines 3–5');
  assert.equal(changeNoteLocation(record({ side: 'old', startLine: 7, endLine: 7 })), 'old line 7');
  const note = record({ side: 'old', startLine: 3, endLine: 3 });
  const rows = rowsOf(MODIFIED, 'a.txt');
  assert.deepEqual(rows.filter((row) => rowInNote(row, note)).map((row) => row.text), ['-line 3']);
  assert.equal(rows.filter((row) => rowInNote(row, record({ path: 'b.txt', startLine: 3, endLine: 3 }))).length, 0, 'another file\'s rows are never covered');
});

/* ── the operator's copy ─────────────────────────────────────────────── */

test('making it my review note copies the text under the operator, anchored to the same lines, and says it quotes the agent', () => {
  const note = record({ path: 'src/cart.ts', side: 'new', startLine: 12, endLine: 14, body: 'Retries reuse the key.\nThe gateway dedupes on it.', quote: ['+a', '+b', ' c'] });
  const copy = reviewNoteFromChangeNote(note, 'claude · storefront', 'r1');
  assert.equal(copy.id, 'r1');
  assert.equal(copy.file, 'src/cart.ts');
  assert.deepEqual([copy.newStart, copy.newEnd, copy.oldStart, copy.oldEnd], [12, 14, null, null]);
  assert.deepEqual(copy.quote, ['+a', '+b', ' c']);
  assert.equal(copy.body, 'Quoted from the agent\'s own note on this change (claude · storefront):\n> Retries reuse the key.\n> The gateway dedupes on it.');
  assert.equal(quotesAgent(copy), true);
  assert.equal(quotesAgent({ body: 'My own words.' }), false);
  const old = reviewNoteFromChangeNote(record({ side: 'old', startLine: 3, endLine: 3 }), 't', 'r2');
  assert.deepEqual([old.newStart, old.oldStart, old.oldEnd], [null, 3, 3]);
  const long = reviewNoteFromChangeNote(record({ body: 'x'.repeat(MAX_CHANGE_NOTE_CHARS) }), 'a long session title', 'r3');
  assert(long.body.length <= MAX_NOTE_CHARS + 4, `the copy stays within a review note's limit: ${long.body.length}`);
  assert.match(long.body, /… \(shortened\)$/);
});

/* ── the launch hint ─────────────────────────────────────────────────── */

test('the hint is one line under 200 characters, and absent when the tool is not granted', () => {
  assert(CHANGE_NOTE_HINT.length < 200, `${CHANGE_NOTE_HINT.length} characters`);
  assert(!CHANGE_NOTE_HINT.includes('\n'));
  assert.match(CHANGE_NOTE_HINT, /wanigan_annotate_change/);
  assert.match(CHANGE_NOTE_HINT, /non-obvious choice in your own change/);
  assert.equal(changeNoteHint(true), CHANGE_NOTE_HINT);
  assert.equal(changeNoteHint(false), null);
});

test('the hint rides only on instruction text a launch was injecting anyway, after the capsule and before the briefing', () => {
  assert.deepEqual(launchInstructionParts('CAPSULE', 'BRIEF', true), ['CAPSULE', CHANGE_NOTE_HINT, 'BRIEF']);
  assert.deepEqual(launchInstructionParts('', 'BRIEF', true), [CHANGE_NOTE_HINT, 'BRIEF']);
  assert.deepEqual(launchInstructionParts('CAPSULE', '', false), ['CAPSULE'], 'not granted: no hint');
  assert.deepEqual(launchInstructionParts('', '', true), [], 'nothing injected: the hint never becomes the reason for a system-prompt addition');
});
