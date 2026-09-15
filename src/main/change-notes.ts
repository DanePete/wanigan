import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { db } from './db';
import { redactCredentials } from './redact';
import { changeNotesDiff, type ChangeNotesDiff } from './review-work';
import { listSessions } from './sessions';
import { changeNoteToolGranted } from './mcp/tool-grants';
import { parseUnifiedDiff, type DiffRow } from '../shared/review-notes';
import {
  MAX_ANCHOR_QUOTE_LINES, MAX_CHANGE_NOTES_PER_SESSION, MAX_QUOTE_LINE_CHARS, NOTE_ID, anchorKey, anchorLines, changeNoteStaleness,
  parseChangeNoteArgs, walkOrder, type ChangeNoteSide, type ChangeNoteView, type ChangeNotesForReview,
} from '../shared/change-notes';

/**
 * Agent change notes, stored and read (helper sweep · P10).
 *
 * Two callers with two different reaches. A session calls through Wanigan's
 * MCP server, identified only by its per-launch capability, and can write, list
 * and withdraw its own notes — nothing that takes a session id, and nothing
 * that reads or writes the operator's review marks. The operator calls over IPC
 * from the code rail and can read a session's notes, dismiss one, and record
 * that one was quoted into their own review note; the quoted copy itself is the
 * operator's, built in the renderer's review tray, and never stored here.
 *
 * Every anchor is checked against the session's real branch diff at the moment
 * of writing: the file must be one this session changed, and the range must
 * sit inside one hunk on the side it names. Bodies and quoted lines pass
 * through the shared credential redactor before they reach the database.
 */

type NoteRow = {
  id: string; session_id: string; worktree: string; base_commit: string; path: string; side: string;
  start_line: number; end_line: number; body: string; quote_json: string; quote_omitted: number;
  hunk_header: string; anchor_key: string; content_hash: string; created_at: number;
  withdrawn_at: number | null; dismissed_at: number | null; quoted_at: number | null;
};

const SESSION_ID = /^[A-Za-z0-9_:.-]{1,200}$/;

function sessionArg(value: unknown): string {
  if (typeof value !== 'string' || !SESSION_ID.test(value)) throw new Error('That is not a session Wanigan knows.');
  return value;
}

function noteArg(value: unknown): string {
  if (typeof value !== 'string' || !NOTE_ID.test(value)) throw new Error('id must be a change note id, as wanigan_annotate_change or wanigan_list_change_notes returned it (cn_ and 16 hex digits).');
  return value;
}

function recordEvent(noteId: string, sessionId: string, actor: 'agent' | 'operator', action: string, at: number): void {
  db().prepare('INSERT INTO agent_change_note_events (note_id, session_id, actor, action, at) VALUES (?,?,?,?,?)').run(noteId, sessionId, actor, action, at);
}

function writtenCount(sessionId: string): number {
  return (db().prepare('SELECT COUNT(*) AS n FROM agent_change_notes WHERE session_id = ?').get(sessionId) as { n: number }).n;
}

/**
 * A path that is inside the checkout on disk as well as in spelling: the
 * nearest directory that exists is resolved through its symlinks and must still
 * be under the checkout's real path. A deleted file has no directory entry of
 * its own, so its parent answers for it.
 */
function insideCheckout(root: string, rel: string): boolean {
  try {
    const base = fs.realpathSync(root);
    const lexical = path.resolve(root, rel);
    if (!lexical.startsWith(path.resolve(root) + path.sep)) return false;
    let dir = path.dirname(lexical);
    while (!fs.existsSync(dir)) {
      const up = path.dirname(dir);
      if (up === dir) return false;
      dir = up;
    }
    const real = fs.realpathSync(dir);
    return real === base || real.startsWith(base + path.sep);
  } catch { return false; }
}

function sessionTitle(sessionId: string): string {
  const live = listSessions().find((s) => s.id === sessionId);
  if (live) return live.displayTitle || live.title;
  const row = db().prepare('SELECT title, provider_id, project_name FROM session_log WHERE id = ?').get(sessionId) as
    { title: string | null; provider_id: string; project_name: string } | undefined;
  if (!row) return 'this session';
  return row.title?.trim() || `${row.provider_id} · ${row.project_name}`;
}

function profileOf(sessionId: string): string | null {
  const row = db().prepare('SELECT provider_id FROM session_log WHERE id = ?').get(sessionId) as { provider_id: string | null } | undefined;
  return row?.provider_id ?? null;
}

/* ── the agent's half ───────────────────────────────────────────────── */

export type AnnotateResult = {
  stored: { id: string; path: string; side: ChangeNoteSide; startLine: number; endLine: number; hunk: string };
  written: number;
  limit: number;
  message: string;
};

export async function annotateChange(sessionId: string, args: Record<string, unknown>): Promise<AnnotateResult> {
  const id = sessionArg(sessionId);
  const parsed = parseChangeNoteArgs(args);
  if (!parsed.ok) throw new Error(parsed.reason);
  const input = parsed.value;
  if (writtenCount(id) >= MAX_CHANGE_NOTES_PER_SESSION) {
    throw new Error(`This session has written ${MAX_CHANGE_NOTES_PER_SESSION} change notes, the most one session may write. Withdrawn notes count, so withdrawing does not free a slot.`);
  }

  const diff = await changeNotesDiff(id);
  if (!diff.base) throw new Error('This session recorded no base commit at launch, so it has no diff to anchor a note to.');
  if (diff.unreadable) throw new Error(`git could not read this session's diff, so no note can be anchored to it: ${diff.unreadable}`);
  if (!insideCheckout(diff.root, input.path)) {
    throw new Error(`\`${input.path}\` does not resolve inside this session's checkout (${diff.root}). A note anchors only to a file inside it.`);
  }
  const file = diff.files.find((f) => f.path === input.path);
  if (!file) {
    const renamed = diff.files.find((f) => f.oldPath === input.path);
    throw new Error(renamed
      ? `\`${input.path}\` was renamed to \`${renamed.path}\` in this session's diff. Anchor the note to \`${renamed.path}\`; side "old" covers its lines as they were.`
      : `\`${input.path}\` is not changed in this session's diff against ${diff.base.slice(0, 8)}, the commit it started from. A note explains this session's own change, so it anchors only to a file the session changed.`);
  }
  if (file.preexisting) {
    throw new Error(`\`${file.path}\` was already changed before this session launched, so its diff is the operator's work as well as this session's. Notes anchor only to files this session changed from a clean start.`);
  }
  if (file.scratch) throw new Error(`\`${file.path}\` is a scratch file, which is left out of the review, so a note on it would never be read.`);
  if (file.binary) throw new Error(`\`${file.path}\` is binary: git shows no lines for a note to anchor to.`);

  const patch = await diff.patchOf(file);
  if (patch === null) throw new Error(`git could not produce the diff of \`${file.path}\` just now, so the note was not stored. Try again.`);
  const anchored = anchorLines(parseUnifiedDiff(patch, file.path), file.path, input.side, input.startLine, input.endLine);
  if (!anchored.ok) throw new Error(anchored.reason);

  const noteId = `cn_${randomBytes(8).toString('hex')}`;
  const now = Date.now();
  const lines = anchored.value.lines;
  const quote = lines.slice(0, MAX_ANCHOR_QUOTE_LINES).map((line) => redactCredentials(line.slice(0, MAX_QUOTE_LINE_CHARS)));
  const d = db();
  const written = d.transaction(() => {
    // Counted again inside the write, so two calls racing at 59 cannot both land.
    const before = writtenCount(id);
    if (before >= MAX_CHANGE_NOTES_PER_SESSION) {
      throw new Error(`This session has written ${MAX_CHANGE_NOTES_PER_SESSION} change notes, the most one session may write. Withdrawn notes count, so withdrawing does not free a slot.`);
    }
    d.prepare(`INSERT INTO agent_change_notes (id, session_id, worktree, base_commit, path, side, start_line, end_line, body, quote_json, quote_omitted,
      hunk_header, anchor_key, content_hash, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(noteId, id, diff.root, diff.base, file.path, input.side, input.startLine, input.endLine, redactCredentials(input.note),
        JSON.stringify(quote), Math.max(0, lines.length - quote.length), redactCredentials(anchored.value.hunk.header), anchorKey(lines), file.contentHash, now);
    recordEvent(noteId, id, 'agent', 'written', now);
    return before + 1;
  })();
  return {
    stored: { id: noteId, path: file.path, side: input.side, startLine: input.startLine, endLine: input.endLine, hunk: redactCredentials(anchored.value.hunk.header) },
    written,
    limit: MAX_CHANGE_NOTES_PER_SESSION,
    message: 'Stored against this session. The operator sees it beside the diff, marked as written by the agent; if these lines change, it is shown as out of date.',
  };
}

/** The notes of one session on its current diff, with staleness, in walk order. Withdrawn notes are left out. */
async function currentNotes(sessionId: string): Promise<{ diff: ChangeNotesDiff; views: ChangeNoteView[]; withdrawn: number }> {
  const diff = await changeNotesDiff(sessionId);
  const rows = diff.base
    ? db().prepare('SELECT * FROM agent_change_notes WHERE session_id = ? AND worktree = ? AND base_commit = ? ORDER BY created_at').all(sessionId, diff.root, diff.base) as NoteRow[]
    : [];
  const live = rows.filter((r) => r.withdrawn_at === null && (r.side === 'new' || r.side === 'old'));
  const parsedByPath = new Map<string, { inDiff: boolean; rows: DiffRow[] | null }>();
  for (const p of new Set(live.map((r) => r.path))) {
    const file = diff.files.find((f) => f.path === p);
    const patch = file && !diff.unreadable ? await diff.patchOf(file) : null;
    parsedByPath.set(p, { inDiff: !!file, rows: patch === null ? null : parseUnifiedDiff(patch, p) });
  }
  const views: ChangeNoteView[] = live.map((r) => {
    let quote: string[] = [];
    try { const parsed: unknown = JSON.parse(r.quote_json); if (Array.isArray(parsed)) quote = parsed.filter((q): q is string => typeof q === 'string'); } catch { /* shown without its quote */ }
    const side = r.side as ChangeNoteSide;
    return {
      id: r.id, path: r.path, side, startLine: r.start_line, endLine: r.end_line, body: r.body, quote, quoteOmitted: r.quote_omitted,
      hunkHeader: r.hunk_header, createdAt: r.created_at, dismissedAt: r.dismissed_at, quotedAt: r.quoted_at,
      staleness: changeNoteStaleness({ path: r.path, side, startLine: r.start_line, endLine: r.end_line, anchorKey: r.anchor_key },
        { ...(parsedByPath.get(r.path) ?? { inDiff: false, rows: null }), unreadable: diff.unreadable }),
    };
  });
  return { diff, views: walkOrder(views), withdrawn: rows.length - live.length };
}

/** What wanigan_list_change_notes answers: the calling session's own notes, and nothing of anyone else's. */
export async function listOwnChangeNotes(sessionId: string): Promise<Record<string, unknown>> {
  const id = sessionArg(sessionId);
  const { diff, views, withdrawn } = await currentNotes(id);
  return {
    notes: views.map((v) => ({
      id: v.id, path: v.path, side: v.side, startLine: v.startLine, endLine: v.endLine, note: v.body, createdAt: v.createdAt,
      dismissedByOperator: v.dismissedAt !== null, codeChangedSince: v.staleness.stale, because: v.staleness.because,
    })),
    withdrawn,
    written: writtenCount(id),
    limit: MAX_CHANGE_NOTES_PER_SESSION,
    base: diff.base,
  };
}

/** wanigan_withdraw_change_note: one of the calling session's own notes, and only its own. */
export function withdrawOwnChangeNote(sessionId: string, rawId: unknown): Record<string, unknown> {
  const id = sessionArg(sessionId);
  const noteId = noteArg(rawId);
  const now = Date.now();
  const d = db();
  const changed = d.transaction(() => {
    const res = d.prepare('UPDATE agent_change_notes SET withdrawn_at = ? WHERE id = ? AND session_id = ? AND withdrawn_at IS NULL').run(now, noteId, id);
    if (res.changes) recordEvent(noteId, id, 'agent', 'withdrawn', now);
    return res.changes;
  })();
  if (!changed) {
    const own = d.prepare('SELECT withdrawn_at FROM agent_change_notes WHERE id = ? AND session_id = ?').get(noteId, id) as { withdrawn_at: number | null } | undefined;
    // Another session's id reads exactly like an id that does not exist: a
    // session learns nothing about notes it did not write.
    throw new Error(own ? 'That note was already withdrawn.' : 'No change note with that id was written by this session.');
  }
  return { withdrawn: noteId, message: 'Withdrawn. The operator no longer sees it; that it was written and withdrawn stays on record.' };
}

/* ── the operator's half ─────────────────────────────────────────────── */

export async function changeNotesForReview(rawSessionId: unknown): Promise<ChangeNotesForReview> {
  const id = sessionArg(rawSessionId);
  const { diff, views, withdrawn } = await currentNotes(id);
  return {
    sessionId: id,
    sessionTitle: sessionTitle(id),
    base: diff.base,
    notes: views,
    withdrawn,
    written: writtenCount(id),
    limit: MAX_CHANGE_NOTES_PER_SESSION,
    toolGranted: changeNoteToolGranted(profileOf(id)),
    unreadable: diff.unreadable,
  };
}

function operatorAct(rawSessionId: unknown, rawId: unknown, column: 'dismissed_at' | 'quoted_at', action: 'dismissed' | 'quoted'): { id: string; at: number } {
  const id = sessionArg(rawSessionId);
  const noteId = noteArg(rawId);
  const now = Date.now();
  const d = db();
  const changed = d.transaction(() => {
    const res = d.prepare(`UPDATE agent_change_notes SET ${column} = COALESCE(${column}, ?) WHERE id = ? AND session_id = ? AND withdrawn_at IS NULL`).run(now, noteId, id);
    if (res.changes) recordEvent(noteId, id, 'operator', action, now);
    return res.changes;
  })();
  if (!changed) throw new Error('That note is no longer there: the agent may have withdrawn it.');
  const row = d.prepare(`SELECT ${column} AS at FROM agent_change_notes WHERE id = ?`).get(noteId) as { at: number };
  return { id: noteId, at: row.at };
}

/** The operator set a note aside. Recorded with when, and the note stays on record. */
export function dismissChangeNote(sessionId: unknown, noteId: unknown): { id: string; at: number } {
  return operatorAct(sessionId, noteId, 'dismissed_at', 'dismissed');
}

/** The operator quoted a note into their own review note. The copy lives in the review tray, under their name; this records only that it happened. */
export function recordChangeNoteQuoted(sessionId: unknown, noteId: unknown): { id: string; at: number } {
  return operatorAct(sessionId, noteId, 'quoted_at', 'quoted');
}

type Handle = <T>(channel: string, fn: (...args: never[]) => T | Promise<T>) => void;

export function registerChangeNotesIpc(handle: Handle): void {
  handle('changeNotes:list', (sessionId: unknown) => changeNotesForReview(sessionId));
  handle('changeNotes:dismiss', (sessionId: unknown, noteId: unknown) => dismissChangeNote(sessionId, noteId));
  handle('changeNotes:quote', (sessionId: unknown, noteId: unknown) => recordChangeNoteQuoted(sessionId, noteId));
}
