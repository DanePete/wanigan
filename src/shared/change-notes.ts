/**
 * Agent change notes: a session explaining its own diff, one hunk at a time.
 *
 * The direction is the reverse of review notes. A review note is the operator's
 * comment on a line, handed back to the session; a change note is the session's
 * own account of why a line reads the way it does, anchored to a hunk of its
 * diff against the commit it started from and shown beside the code in the rail.
 *
 * The authorship boundary is the design, not a detail. An agent writes, lists
 * and withdraws its own notes and nothing else: it cannot create, edit or
 * delete an operator's note, and the operator's copy of an agent note is a new
 * note under the operator's name that says where its words came from. The
 * mechanism follows hunk (github.com/modem-dev/hunk), whose agents anchor notes
 * to a hunk, an old line or a new line; hunk lets an agent remove a human note,
 * and this deliberately does not.
 *
 * Everything here is pure: the argument rules, the path rules, whether a range
 * sits inside one hunk, whether the lines a note was about have moved since,
 * the order a walk visits notes in, and the one-line hint a launch carries. The
 * main process supplies the diff and the stored rows.
 */
import { MAX_NOTE_CHARS, MAX_QUOTE_LINES, type DiffRow, type ReviewNote } from './review-notes.ts';

export const CHANGE_NOTE_SIDES = ['new', 'old'] as const;
export type ChangeNoteSide = (typeof CHANGE_NOTE_SIDES)[number];

export const MAX_CHANGE_NOTE_CHARS = 2_000;
/** Notes one session may write, withdrawn ones included, so withdrawing never frees a slot. */
export const MAX_CHANGE_NOTES_PER_SESSION = 60;
export const MAX_NOTE_PATH_CHARS = 1_000;
/** Characters of one quoted line kept with a note; the diff itself is always a click away. */
export const MAX_QUOTE_LINE_CHARS = 400;
/** Lines of the anchored range kept with a note: the same cap a review note's quote has. */
export const MAX_ANCHOR_QUOTE_LINES = MAX_QUOTE_LINES;

export const CHANGE_NOTE_TOOL = 'wanigan_annotate_change';
export const CHANGE_NOTE_TOOLS = [CHANGE_NOTE_TOOL, 'wanigan_list_change_notes', 'wanigan_withdraw_change_note'] as const;

export const NOTE_ID = /^cn_[0-9a-f]{16}$/;

/* ── arguments ───────────────────────────────────────────────────────── */

export type ChangeNoteInput = { path: string; side: ChangeNoteSide; startLine: number; endLine: number; note: string };

type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string };

const ANNOTATE_KEYS = new Set(['path', 'side', 'startLine', 'endLine', 'note']);

/**
 * A path as an agent may name it: relative to the session's checkout, spelled
 * the way git names it, and inside the checkout by construction. Symlinks are
 * the main process's half, because only it can read the disk.
 */
export function normalizeNotePath(raw: unknown): Parsed<string> {
  if (typeof raw !== 'string') return { ok: false, reason: 'path must be a string: the file relative to this session\'s checkout, as `git diff` names it (for example src/app.ts).' };
  const text = raw.trim();
  if (!text) return { ok: false, reason: 'path is required: the file relative to this session\'s checkout, as `git diff` names it.' };
  if (text.length > MAX_NOTE_PATH_CHARS) return { ok: false, reason: `path is longer than ${MAX_NOTE_PATH_CHARS.toLocaleString('en-US')} characters.` };
  if ([...text].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f)) return { ok: false, reason: 'path contains a control character.' };
  if (text.includes('\\')) return { ok: false, reason: `\`${text}\` uses backslashes. Use forward slashes, the way git names paths.` };
  if (text.startsWith('/') || text.startsWith('~') || /^[A-Za-z]:/.test(text)) {
    return { ok: false, reason: `\`${text}\` is absolute. Give the path relative to this session's checkout, the way \`git diff\` names it.` };
  }
  const parts = text.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.includes('..')) return { ok: false, reason: `\`${text}\` climbs out with "..". A note anchors only to a file inside this session's checkout.` };
  if (!parts.length) return { ok: false, reason: 'path names the checkout itself, not a file in it.' };
  if (parts[0] === '.git') return { ok: false, reason: `\`${text}\` is inside .git, which is never part of a diff.` };
  return { ok: true, value: parts.join('/') };
}

/**
 * The annotate tool's arguments, every one checked with a sentence the model
 * can act on. There is no session id among them, and one supplied is refused
 * by name: the per-launch capability already says which session is calling.
 */
export function parseChangeNoteArgs(args: Record<string, unknown>): Parsed<ChangeNoteInput> {
  if ('sessionId' in args || 'session_id' in args || 'session' in args) {
    return { ok: false, reason: 'This tool takes no session id. A note is always stored against the session that calls it.' };
  }
  const unknown = Object.keys(args).filter((key) => !ANNOTATE_KEYS.has(key));
  if (unknown.length) return { ok: false, reason: `Unknown argument${unknown.length === 1 ? '' : 's'}: ${unknown.slice(0, 5).join(', ')}. The tool takes path, side, startLine, endLine and note.` };
  const path = normalizeNotePath(args.path);
  if (!path.ok) return path;
  if (args.side !== 'new' && args.side !== 'old') {
    return { ok: false, reason: 'side must be "new" (lines as they are now) or "old" (lines as they were at the base commit, such as removed ones).' };
  }
  const line = (value: unknown, label: string): Parsed<number> =>
    typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 10_000_000
      ? { ok: true, value }
      : { ok: false, reason: `${label} must be a whole line number, 1 or more.` };
  const start = line(args.startLine, 'startLine');
  if (!start.ok) return start;
  const end = line(args.endLine ?? args.startLine, 'endLine');
  if (!end.ok) return end;
  if (end.value < start.value) return { ok: false, reason: `endLine (${end.value}) is before startLine (${start.value}).` };
  if (typeof args.note !== 'string' || !args.note.trim()) {
    return { ok: false, reason: 'note is required: say why this change reads the way it does.' };
  }
  const note = args.note.trim();
  if (note.length > MAX_CHANGE_NOTE_CHARS) {
    return { ok: false, reason: `note is ${note.length.toLocaleString('en-US')} characters; keep it to ${MAX_CHANGE_NOTE_CHARS.toLocaleString('en-US')}.` };
  }
  return { ok: true, value: { path: path.value, side: args.side, startLine: start.value, endLine: end.value, note } };
}

/* ── hunks ───────────────────────────────────────────────────────────── */

export type DiffHunk = { header: string; oldStart: number; oldCount: number; newStart: number; newCount: number };

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** The hunk headers of one file's diff, in order, with the line ranges each covers. */
export function diffHunks(rows: readonly DiffRow[]): DiffHunk[] {
  const out: DiffHunk[] = [];
  for (const row of rows) {
    if (row.kind !== 'hunk') continue;
    const m = HUNK_HEADER.exec(row.text);
    if (!m) continue;
    out.push({
      header: row.text,
      oldStart: Number(m[1]), oldCount: m[2] === undefined ? 1 : Number(m[2]),
      newStart: Number(m[3]), newCount: m[4] === undefined ? 1 : Number(m[4]),
    });
  }
  return out;
}

function sideRange(hunk: DiffHunk, side: ChangeNoteSide): { start: number; end: number } | null {
  const start = side === 'new' ? hunk.newStart : hunk.oldStart;
  const count = side === 'new' ? hunk.newCount : hunk.oldCount;
  return count > 0 ? { start, end: start + count - 1 } : null;
}

function span(start: number, end: number): string {
  return start === end ? `${start}` : `${start}–${end}`;
}

export type AnchoredLines = { hunk: DiffHunk; lines: string[] };

/**
 * The lines a range names, when the whole range sits inside one hunk on the
 * side it names. A range that runs across two hunks, or past one into
 * unchanged code, is refused with the ranges the hunks do cover, so the model
 * can correct itself in one step rather than guessing.
 */
export function anchorLines(rows: readonly DiffRow[], path: string, side: ChangeNoteSide, start: number, end: number): Parsed<AnchoredLines> {
  const hunks = diffHunks(rows);
  const covered = hunks.map((h) => sideRange(h, side)).filter((r): r is { start: number; end: number } => r !== null);
  if (!hunks.length) return { ok: false, reason: `\`${path}\` has no hunks with lines in this session's diff (a binary file, or a change of mode only).` };
  if (!covered.length) {
    return {
      ok: false,
      reason: side === 'old'
        ? `\`${path}\` is new in this session's diff, so it has no old side. Use side "new".`
        : `\`${path}\` is deleted in this session's diff, so it has no new side. Use side "old".`,
    };
  }
  let hunkIndex = -1;
  const lines: string[] = [];
  for (const row of rows) {
    if (row.kind === 'hunk') {
      hunkIndex += HUNK_HEADER.test(row.text) ? 1 : 0;
      continue;
    }
    if (hunkIndex < 0) continue;
    const hunk = hunks[hunkIndex];
    const range = hunk ? sideRange(hunk, side) : null;
    if (!range || start < range.start || end > range.end) continue;
    const n = side === 'new' ? row.newLine : row.oldLine;
    if (n === null || n < start || n > end) continue;
    if (row.kind !== 'add' && row.kind !== 'del' && row.kind !== 'ctx') continue;
    lines.push(row.text);
  }
  const within = hunks.find((h) => { const r = sideRange(h, side); return r !== null && start >= r.start && end <= r.end; });
  if (!within || lines.length !== end - start + 1) {
    const listed = covered.slice(0, 8).map((r) => span(r.start, r.end)).join(', ') + (covered.length > 8 ? `, and ${covered.length - 8} more` : '');
    return {
      ok: false,
      reason: `${start === end ? `Line ${start}` : `Lines ${start}–${end}`} on the ${side} side of \`${path}\` ${start === end ? 'is' : 'are'} not inside one hunk of this session's diff. `
        + `Its hunks cover ${side} line${covered.length === 1 && covered[0].start === covered[0].end ? '' : 's'} ${listed}.`,
    };
  }
  return { ok: true, value: { hunk: within, lines } };
}

/**
 * A short, stable fingerprint of the anchored lines, prefix included. It only
 * has to tell "the same lines" from "different lines" for one note, so a
 * 53-bit string hash (cyrb53) is enough and keeps this module free of Node.
 */
export function anchorKey(lines: readonly string[]): string {
  const text = lines.join('\n');
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const value = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return `${lines.length}:${value.toString(16)}`;
}

/* ── staleness ───────────────────────────────────────────────────────── */

/** Why a note does or does not still describe the code: a reason code with its sentence, never a score. */
export type ChangeNoteStaleState = 'current' | 'lines-changed' | 'outside-hunk' | 'file-left-diff' | 'unreadable';
export type ChangeNoteStaleness = { state: ChangeNoteStaleState; stale: boolean; because: string };

/** The words the rail shows on any stale note. */
export const STALE_LABEL = 'the code changed since this note';

/**
 * Whether the lines a note was written about are still the lines at its range.
 * The same rule as a review mark, one level finer: a mark goes stale when its
 * file's bytes move, and a note goes stale when its own lines do, because an
 * agent's explanation of line 40 is still true after line 90 is edited.
 * Lines that merely moved (an insertion above them) read as changed: the note
 * names line numbers, and those now point at different code.
 */
export function changeNoteStaleness(
  note: { path: string; side: ChangeNoteSide; startLine: number; endLine: number; anchorKey: string },
  current: { inDiff: boolean; rows: readonly DiffRow[] | null; unreadable?: string | null },
): ChangeNoteStaleness {
  if (current.unreadable) return { state: 'unreadable', stale: false, because: `git could not read this session's diff, so nothing is claimed either way: ${current.unreadable}` };
  if (!current.inDiff) {
    return { state: 'file-left-diff', stale: true, because: `\`${note.path}\` is no longer changed against the commit this session started from.` };
  }
  if (!current.rows) return { state: 'unreadable', stale: false, because: 'The file\'s diff could not be read, so nothing is claimed either way.' };
  const anchored = anchorLines(current.rows, note.path, note.side, note.startLine, note.endLine);
  if (!anchored.ok) {
    return { state: 'outside-hunk', stale: true, because: `The ${note.side} ${note.startLine === note.endLine ? `line ${note.startLine} is` : `lines ${note.startLine}–${note.endLine} are`} no longer inside one hunk of the diff.` };
  }
  if (anchorKey(anchored.value.lines) !== note.anchorKey) {
    return { state: 'lines-changed', stale: true, because: `The ${note.side} ${note.startLine === note.endLine ? `line ${note.startLine} reads` : `lines ${note.startLine}–${note.endLine} read`} differently from when the note was written.` };
  }
  return { state: 'current', stale: false, because: 'The lines still read as they did when the note was written.' };
}

/* ── records and views ───────────────────────────────────────────────── */

export type ChangeNoteRecord = {
  id: string;
  path: string;
  side: ChangeNoteSide;
  startLine: number;
  endLine: number;
  body: string;
  /** The anchored lines as the diff showed them, prefix included, redacted and capped. */
  quote: string[];
  quoteOmitted: number;
  hunkHeader: string;
  createdAt: number;
  dismissedAt: number | null;
  quotedAt: number | null;
};

export type ChangeNoteView = ChangeNoteRecord & { staleness: ChangeNoteStaleness };

/** What the code rail reads for one session. */
export type ChangeNotesForReview = {
  sessionId: string;
  /** The session that wrote them, in the words the session list uses. */
  sessionTitle: string;
  base: string | null;
  /** Notes not withdrawn by the agent, dismissed ones included and flagged, in walk order. */
  notes: ChangeNoteView[];
  /** Notes the agent withdrew; counted, not shown. */
  withdrawn: number;
  /** Notes written, withdrawn included, against the per-session limit. */
  written: number;
  limit: number;
  /** Whether this session's provider profile is granted the annotate tool right now. */
  toolGranted: boolean;
  unreadable: string | null;
};

/** The order "Walk the agent's notes" visits them in: file, then line, new side before old at the same line. */
export function walkOrder<T extends Pick<ChangeNoteRecord, 'path' | 'side' | 'startLine' | 'endLine' | 'createdAt'>>(notes: readonly T[]): T[] {
  return [...notes].sort((a, b) =>
    (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    || a.startLine - b.startLine
    || (a.side === b.side ? 0 : a.side === 'new' ? -1 : 1)
    || a.endLine - b.endLine
    || a.createdAt - b.createdAt);
}

/** "new lines 3–5" / "old line 7": where a note points, in words. */
export function changeNoteLocation(note: Pick<ChangeNoteRecord, 'side' | 'startLine' | 'endLine'>): string {
  return note.startLine === note.endLine
    ? `${note.side} line ${note.startLine}`
    : `${note.side} lines ${note.startLine}–${note.endLine}`;
}

/** Whether a diff row falls inside a note's range, on the note's side. */
export function rowInNote(row: Pick<DiffRow, 'file' | 'oldLine' | 'newLine'>, note: Pick<ChangeNoteRecord, 'path' | 'side' | 'startLine' | 'endLine'>): boolean {
  if (row.file !== note.path) return false;
  const n = note.side === 'new' ? row.newLine : row.oldLine;
  return n !== null && n >= note.startLine && n <= note.endLine;
}

/* ── the operator's copy ─────────────────────────────────────────────── */

const QUOTED_PREFIX = 'Quoted from the agent\'s own note on this change';

/**
 * The review note an operator gets from "Make it my review note": a new note
 * under the operator's name, anchored to the same lines, whose text says in so
 * many words that it quotes the agent. The agent note is left as it was.
 */
export function reviewNoteFromChangeNote(note: ChangeNoteRecord, sessionTitle: string, id: string): ReviewNote {
  const head = `${QUOTED_PREFIX} (${sessionTitle}):`;
  const room = MAX_NOTE_CHARS - head.length - 16;
  const words = note.body.length > room ? `${note.body.slice(0, Math.max(0, room)).trimEnd()} … (shortened)` : note.body;
  return {
    id,
    file: note.path,
    oldStart: note.side === 'old' ? note.startLine : null,
    oldEnd: note.side === 'old' ? note.endLine : null,
    newStart: note.side === 'new' ? note.startLine : null,
    newEnd: note.side === 'new' ? note.endLine : null,
    quote: note.quote.slice(0, MAX_QUOTE_LINES),
    quoteOmitted: note.quoteOmitted + Math.max(0, note.quote.length - MAX_QUOTE_LINES),
    body: [head, ...words.split('\n').map((line) => `> ${line}`)].join('\n'),
  };
}

export function quotesAgent(note: Pick<ReviewNote, 'body'>): boolean {
  return note.body.startsWith(QUOTED_PREFIX);
}

/* ── the launch hint ─────────────────────────────────────────────────── */

export const CHANGE_NOTE_HINT =
  'Wanigan: to explain a non-obvious choice in your own change, call wanigan_annotate_change on its hunk. Notes are for the reviewer, not a changelog.';

/** The one line a launch carries, or nothing when the tool was not granted to the session. */
export function changeNoteHint(granted: boolean): string | null {
  return granted ? CHANGE_NOTE_HINT : null;
}

/**
 * The instruction text a launch passes, in order: the goal capsule, the hint,
 * the learned briefing. The hint rides only on text Wanigan was injecting
 * anyway — it never becomes the reason a session gets a system-prompt addition
 * it would not otherwise have had — and only when the tool was granted.
 */
export function launchInstructionParts(capsuleText: string, learnedText: string, noteToolGranted: boolean): string[] {
  const hint = capsuleText || learnedText ? changeNoteHint(noteToolGranted) : null;
  return [capsuleText, hint, learnedText].filter((part): part is string => !!part);
}
