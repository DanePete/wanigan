/**
 * Review notes: the operator's comments on specific diff lines, handed back to
 * the session that wrote them.
 *
 * The note carries its anchor with it — which diff it was made on, the file,
 * the line range and which side of the change — and quotes the lines, because
 * an agent given "line 40 looks wrong" has to guess which version of line 40,
 * and a comment made on one snapshot's diff means nothing against another's.
 * The shape follows what products that ship this converged on: a header naming
 * the diff, then per note the path, the range and side, the quoted lines and
 * the comment.
 *
 * Nothing here sends anything. The formatted text goes into the session's
 * message box, where the operator reads it and presses Send or Queue like any
 * other message — so the composer's own rule, never typing into a permission
 * prompt, still holds.
 */

export type DiffRowKind = 'meta' | 'hunk' | 'add' | 'del' | 'ctx';

export type DiffRow = {
  kind: DiffRowKind;
  text: string;
  /** The file this row belongs to, from the diff's own headers; null before the first one. */
  file: string | null;
  /** Line number on the old side, for context and removed lines. */
  oldLine: number | null;
  /** Line number on the new side, for context and added lines. */
  newLine: number | null;
};

export type ReviewNote = {
  id: string;
  file: string;
  /** First and last line numbers on each side the selection touches; null when it touches only the other side. */
  oldStart: number | null;
  oldEnd: number | null;
  newStart: number | null;
  newEnd: number | null;
  /** The selected lines as they appear in the diff, prefix included, capped. */
  quote: string[];
  /** How many selected lines the quote left out. */
  quoteOmitted: number;
  body: string;
};

export const MAX_QUOTE_LINES = 12;
export const MAX_REVIEW_NOTES = 30;
export const MAX_NOTE_CHARS = 2_000;

function stripPrefix(path: string): string {
  return path.replace(/^"?(?:a|b)\//, '').replace(/"$/, '');
}

/**
 * A unified diff, row by row, with the file and line numbers each row belongs
 * to. `fallbackFile` names the file when the patch carries no header of its
 * own (a single-file diff whose headers were trimmed).
 */
export function parseUnifiedDiff(patch: string, fallbackFile: string | null = null): DiffRow[] {
  const rows: DiffRow[] = [];
  let file: string | null = fallbackFile;
  let oldLine: number | null = null;
  let newLine: number | null = null;
  // What the hunk header said is left on each side. A line after both run
  // out is not code: the empty string a trailing newline splits into used to
  // be read as one more context line, and a note could anchor to it.
  let oldLeft = 0;
  let newLeft = 0;
  for (const text of patch.split('\n')) {
    if (text.startsWith('diff --git ')) {
      const m = / b\/(.+)$/.exec(text);
      file = m ? stripPrefix(`b/${m[1]}`) : file;
      oldLine = null; newLine = null; oldLeft = 0; newLeft = 0;
      rows.push({ kind: 'meta', text, file, oldLine: null, newLine: null });
      continue;
    }
    // Inside a hunk the header's counts decide what a line is, not its first
    // characters. An added line whose content begins `++ ` arrives as `+++ `,
    // and a removed `-- ` comment as `--- `: read as file headers, the first
    // renamed the file for every row after it and neither advanced the line
    // count, so a note — or a secret finding — landed on the wrong file at the
    // wrong line. git never prints a file header before the counts run out.
    const inHunk = oldLine !== null && newLine !== null && (oldLeft > 0 || newLeft > 0);
    if (!inHunk && text.startsWith('+++ ')) {
      const target = text.slice(4).trim();
      if (target !== '/dev/null') file = stripPrefix(target);
      rows.push({ kind: 'meta', text, file, oldLine: null, newLine: null });
      continue;
    }
    if (!inHunk && text.startsWith('--- ')) {
      const source = text.slice(4).trim();
      // A deleted file's name only appears here.
      if (source !== '/dev/null' && file === fallbackFile) file = stripPrefix(source);
      rows.push({ kind: 'meta', text, file, oldLine: null, newLine: null });
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(text);
    if (hunk) {
      oldLine = Number(hunk[1]); newLine = Number(hunk[3]);
      // An omitted count means one line.
      oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
      newLeft = hunk[4] === undefined ? 1 : Number(hunk[4]);
      rows.push({ kind: 'hunk', text, file, oldLine: null, newLine: null });
      continue;
    }
    if (oldLine === null || newLine === null || (oldLeft <= 0 && newLeft <= 0)) {
      rows.push({ kind: 'meta', text, file, oldLine: null, newLine: null });
      continue;
    }
    if (text.startsWith('+')) {
      rows.push({ kind: 'add', text, file, oldLine: null, newLine: newLine++ });
      newLeft -= 1;
    } else if (text.startsWith('-')) {
      rows.push({ kind: 'del', text, file, oldLine: oldLine++, newLine: null });
      oldLeft -= 1;
    } else if (text.startsWith('\\')) {
      // "\ No newline at end of file" belongs to the line before it.
      rows.push({ kind: 'meta', text, file, oldLine: null, newLine: null });
    } else {
      rows.push({ kind: 'ctx', text, file, oldLine: oldLine++, newLine: newLine++ });
      oldLeft -= 1; newLeft -= 1;
    }
  }
  return rows;
}

/** Whether a row is a line of code a note can be anchored to. */
export function commentable(row: DiffRow | undefined): row is DiffRow & { file: string } {
  return !!row && row.file !== null && (row.kind === 'add' || row.kind === 'del' || row.kind === 'ctx');
}

/** The rows of the hunk a hunk header opens, by the header's row index. */
export function hunkRange(rows: readonly DiffRow[], headerIndex: number): { from: number; to: number } | null {
  if (rows[headerIndex]?.kind !== 'hunk') return null;
  let to = headerIndex;
  for (let i = headerIndex + 1; i < rows.length && commentable(rows[i]) && rows[i].file === rows[headerIndex].file; i++) to = i;
  return to > headerIndex ? { from: headerIndex + 1, to } : null;
}

/**
 * A note over rows `from`..`to` inclusive. Refuses a selection that spans two
 * files or holds no line of code, and an empty comment, rather than producing
 * a note whose anchor is a guess.
 */
export function noteFromRows(
  rows: readonly DiffRow[], from: number, to: number, body: string, id: string,
): { ok: true; note: ReviewNote } | { ok: false; reason: string } {
  const [lo, hi] = from <= to ? [from, to] : [to, from];
  const picked = rows.slice(lo, hi + 1).filter(commentable);
  if (!picked.length) return { ok: false, reason: 'Select at least one changed or context line.' };
  const files = new Set(picked.map((r) => r.file));
  if (files.size > 1) return { ok: false, reason: 'A note covers lines in one file. Select lines from a single file.' };
  const text = body.trim();
  if (!text) return { ok: false, reason: 'Write the comment first.' };
  if (text.length > MAX_NOTE_CHARS) return { ok: false, reason: `Keep a note under ${MAX_NOTE_CHARS.toLocaleString('en-US')} characters.` };
  const olds = picked.map((r) => r.oldLine).filter((n): n is number => n !== null);
  const news = picked.map((r) => r.newLine).filter((n): n is number => n !== null);
  return {
    ok: true,
    note: {
      id,
      file: picked[0].file,
      oldStart: olds.length ? Math.min(...olds) : null,
      oldEnd: olds.length ? Math.max(...olds) : null,
      newStart: news.length ? Math.min(...news) : null,
      newEnd: news.length ? Math.max(...news) : null,
      quote: picked.slice(0, MAX_QUOTE_LINES).map((r) => r.text),
      quoteOmitted: Math.max(0, picked.length - MAX_QUOTE_LINES),
      body: text,
    },
  };
}

function span(start: number | null, end: number | null): string | null {
  if (start === null || end === null) return null;
  return start === end ? `line ${start}` : `lines ${start}–${end}`;
}

/** Where a note points, in words: the new side first, because that is the code as it stands. */
export function noteLocation(note: ReviewNote): string {
  const now = span(note.newStart, note.newEnd);
  const was = span(note.oldStart, note.oldEnd);
  if (now && was) return `${now} (was ${was})`;
  if (now) return now;
  return `${was ?? 'an unnumbered line'}, removed`;
}

/**
 * The message the operator will read and send. `anchor` names the diff the
 * notes were made on, so the agent can tell whether its tree has moved since.
 */
export function formatReviewNotes(notes: readonly ReviewNote[], anchor: string): string {
  const lines: string[] = [
    `Review notes on ${anchor}.`,
    'Address each one, or reply saying why you are leaving it as it is.',
  ];
  notes.forEach((note, i) => {
    lines.push('', `${i + 1}. \`${note.file}\`, ${noteLocation(note)}:`);
    lines.push('   ```diff');
    for (const q of note.quote) lines.push(`   ${q}`);
    if (note.quoteOmitted > 0) lines.push(`   … ${note.quoteOmitted} more selected line${note.quoteOmitted === 1 ? '' : 's'}`);
    lines.push('   ```');
    for (const para of note.body.split('\n')) lines.push(`   ${para}`);
  });
  return lines.join('\n');
}
