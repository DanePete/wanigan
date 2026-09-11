import fs from 'node:fs';
import path from 'node:path';
import { db, dataDir, ensurePrivateDir, ensurePrivateFile } from './db';
import * as accounts from './accounts';
import { runsClaudeCli } from './providers';
import { getSetting, setSetting } from './settings';
import { redactCredentials } from './redact';
import { titleFromTranscriptText, type ReadTitle } from '../shared/session-title';
import type { ClaudeContextUsage, ProviderId, TranscriptHit, TranscriptRecall, TranscriptTurn } from '../shared/types';

/* ── where Claude Code keeps its transcripts ─────────────────────────── */

/** Longest text indexed or handed back per turn. Two failure modes at once: a
 *  200KB tool_result makes every FTS snippet noise, and shipping the whole of
 *  one over IPC stalls the renderer. The raw file stays complete on disk. */
const TURN_TEXT_CAP = 4000;

/** How much of a transcript is read for parsing. The copy is byte-exact
 *  regardless — this only bounds what the main process holds in memory, so a
 *  multi-hundred-MB conversation cannot freeze the UI mid-archive. */
const MAX_PARSE_BYTES = 32 * 1024 * 1024;

/** Turns handed back for reading, newest kept. A long session parses to tens of
 *  thousands of turns; sending them all over IPC at once stalls the renderer for
 *  seconds. Search still covers every indexed turn, and the file is complete. */
const MAX_READ_TURNS = 2000;

/** Clock skew and buffered writes put a file's mtime slightly outside the
 *  session's wall-clock lifetime; without slack the fallback finds nothing. */
const LIFETIME_GRACE_MS = 5 * 60_000;

/** Markers wrapped around the matched term in a hit snippet. Chosen because
 *  they practically never occur in source code, so the renderer can swap them
 *  for markup without corrupting a snippet that quotes a bracket or a tag. */
export const HIT_OPEN = '«';
export const HIT_CLOSE = '»';

/**
 * Every directory a transcript for this project could be in.
 *
 * Claude Code slugs the working directory by replacing every non-alphanumeric
 * character with '-', so /Users/x/repo becomes -Users-x-repo. There is one such
 * directory per account: Claude Code keys its whole state, credential included,
 * to CLAUDE_CONFIG_DIR, so a session run under a second account writes its
 * transcript somewhere the default root cannot see. Looking in one root would
 * make that session honestly report "no transcript" forever.
 *
 * The ambient value is the fallback for an install with no accounts recorded
 * yet — someone who moved their config by hand has no ~/.claude at all, and the
 * archive would otherwise find nothing and blame the session.
 */
function claudeProjectDirs(projectPath: string): string[] {
  const slug = path.resolve(projectPath).replace(/[^a-zA-Z0-9]/g, '-');
  return accounts.readRoots('claude-code').map((root) => path.join(root, 'projects', slug));
}

/**
 * A conversation id is unique to the session that produced it, so finding the
 * file named after one is exact no matter which account's directory holds it.
 */
function exactIn(dirs: string[], conversationId: string): string | null {
  for (const dir of dirs) {
    const candidate = path.join(dir, `${conversationId}.jsonl`);
    if (isFile(candidate)) return candidate;
  }
  return null;
}

/**
 * The newest transcript in the window, across accounts.
 *
 * Unlike the exact lookup this stays a guess — with two accounts active in one
 * repo the newest file may belong to the other one. Callers already mark this
 * result inexact and say so; that label is now carrying slightly more weight.
 */
function newestIn(dirs: string[], from = 0, to = Infinity): { path: string; mtimeMs: number } | null {
  let best: { path: string; mtimeMs: number } | null = null;
  for (const dir of dirs) {
    const found = newestJsonl(dir, from, to);
    if (found && (!best || found.mtimeMs > best.mtimeMs)) best = found;
  }
  return best;
}

/** Wanigan's own copy of every archived transcript. */
export function transcriptsDir(): string {
  return path.join(dataDir(), 'transcripts');
}

function isFile(p: string): boolean {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function newestJsonl(dir: string, from = 0, to = Infinity): { path: string; mtimeMs: number } | null {
  let names: string[];
  // A missing directory is the normal case for a repo no agent has run in.
  try { names = fs.readdirSync(dir); } catch { return null; }
  let best: { path: string; mtimeMs: number } | null = null;
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const full = path.join(dir, name);
    let st: fs.Stats;
    try { st = fs.statSync(full); } catch { continue; }
    if (!st.isFile() || st.mtimeMs < from || st.mtimeMs > to) continue;
    if (!best || st.mtimeMs > best.mtimeMs) best = { path: full, mtimeMs: st.mtimeMs };
  }
  return best;
}

/**
 * The transcript file for a conversation, or the newest one in that project
 * when the exact id is gone. Returns null rather than throwing: Codex writes no
 * such file, and neither does a repo no Claude session has ever run in. That is
 * normal, not an error.
 */
export function transcriptPathFor(projectPath: string, conversationId: string | null): string | null {
  const dirs = claudeProjectDirs(projectPath);
  if (conversationId) {
    const exact = exactIn(dirs, conversationId);
    if (exact) return exact;
  }
  return newestIn(dirs)?.path ?? null;
}

/* ── defensive parsing ───────────────────────────────────────────────── */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function cap(s: string): string {
  const t = s.trim();
  return t.length > TURN_TEXT_CAP ? t.slice(0, TURN_TEXT_CAP) + '…' : t;
}

const ROLES = ['user', 'assistant', 'system', 'tool'] as const;

function roleOf(raw: Record<string, unknown>, msg: Record<string, unknown>): TranscriptTurn['role'] | null {
  const candidates = [msg.role, raw.type, raw.role];
  for (const c of candidates) {
    if (typeof c === 'string' && (ROLES as readonly string[]).includes(c)) {
      return c as TranscriptTurn['role'];
    }
  }
  return null;
}

function timeOf(raw: Record<string, unknown>, fallback: number): number {
  const t = raw.timestamp ?? raw.at;
  if (typeof t === 'number' && Number.isFinite(t)) return t;
  if (typeof t === 'string') {
    const ms = Date.parse(t);
    if (Number.isFinite(ms)) return ms;
  }
  return fallback;
}

type Part = { text: string; toolName?: string; tool: boolean };

/**
 * Block types we recognise and deliberately do not turn into text. Listed for
 * one reason only: so a message made entirely of them is not reported as a
 * damaged line. Without this, a normal assistant turn that only thought before
 * calling a tool counts as shape damage, and every healthy transcript archives
 * with dozens of skipped lines — which makes the count useless as the signal it
 * exists to be.
 *
 * thinking is dropped because it is the model reasoning towards an answer, not
 * a record of what was said; indexing it makes every search return the same
 * handful of long deliberations.
 */
const DROPPED_BLOCKS = new Set(['thinking', 'redacted_thinking', 'image', 'document']);

type Content = { parts: Part[]; legible: boolean };

/**
 * content is a string on older lines and an array of blocks on newer ones.
 * An unrecognised block type is ignored rather than counted as damage — new
 * block types are the expected result of a CLI upgrade, not a broken file — but
 * a non-empty content array in which we recognised *nothing* is exactly the
 * format drift this module is built to survive, so that is reported.
 */
function contentOf(content: unknown): Content {
  if (typeof content === 'string') {
    return { parts: content.trim() ? [{ text: content, tool: false }] : [], legible: true };
  }
  if (!Array.isArray(content)) return { parts: [], legible: false };

  const parts: Part[] = [];
  let recognised = 0;
  for (const block of content) {
    if (!isRecord(block)) continue;
    const type = typeof block.type === 'string' ? block.type : '';
    if (type === 'text' && typeof block.text === 'string') {
      recognised++;
      if (block.text.trim()) parts.push({ text: block.text, tool: false });
    } else if (type === 'tool_use') {
      recognised++;
      parts.push({ text: '', toolName: typeof block.name === 'string' ? block.name : 'tool', tool: true });
    } else if (type === 'tool_result') {
      recognised++;
      parts.push({ text: flattenResult(block.content), tool: true });
    } else if (DROPPED_BLOCKS.has(type)) {
      recognised++;
    }
  }
  return { parts, legible: content.length === 0 || recognised > 0 };
}

function flattenResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (isRecord(b) && b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
    .filter(Boolean)
    .join('\n');
}

type Parsed = { turns: TranscriptTurn[]; lines: number; skipped: number };

/**
 * skipped counts only real damage: a line that is not JSON, and a line that
 * carries a `message` object — so it claims to be a turn — whose role or
 * content we cannot read. Metadata records (bridge-session, queue-operation and
 * whatever the next release adds) carry no message and are silently passed
 * over, because counting them would report a healthy file as half-broken. So is
 * a message we understood but had no text to take from it — see DROPPED_BLOCKS.
 */
function parseTranscript(text: string, fallbackAt: number): Parsed {
  const turns: TranscriptTurn[] = [];
  let lines = 0;
  let skipped = 0;
  let at = fallbackAt;

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    lines++;
    let raw: unknown;
    try { raw = JSON.parse(line); } catch { skipped++; continue; }
    if (!isRecord(raw)) { skipped++; continue; }

    const msg = raw.message;
    if (!isRecord(msg)) continue;
    at = timeOf(raw, at);

    const role = roleOf(raw, msg);
    const { parts, legible } = contentOf(msg.content);
    if (!role || !legible) { skipped++; continue; }
    if (!parts.length) continue;

    // One turn per message for the spoken text, plus a turn per tool step, so a
    // long assistant reply is a single search hit rather than one per block.
    const spoken = parts.filter((p) => !p.tool).map((p) => p.text).join('\n\n');
    if (spoken.trim()) turns.push({ at, role, text: cap(spoken) });
    for (const p of parts) {
      if (!p.tool) continue;
      turns.push({ at, role: 'tool', text: cap(p.text), ...(p.toolName ? { toolName: p.toolName } : {}) });
    }
  }
  return { turns, lines, skipped };
}

/** Reads at most MAX_PARSE_BYTES from the end of a file, dropping the partial
 *  first line so a mid-line cut never looks like a corrupt record. */
function readForParse(file: string): { text: string; truncated: boolean } {
  const size = fs.statSync(file).size;
  if (size <= MAX_PARSE_BYTES) return { text: fs.readFileSync(file, 'utf8'), truncated: false };
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(MAX_PARSE_BYTES);
    const read = fs.readSync(fd, buf, 0, MAX_PARSE_BYTES, size - MAX_PARSE_BYTES);
    const text = buf.subarray(0, read).toString('utf8');
    const nl = text.indexOf('\n');
    return { text: nl >= 0 ? text.slice(nl + 1) : text, truncated: true };
  } finally {
    fs.closeSync(fd);
  }
}

/* ── archiving ───────────────────────────────────────────────────────── */

type Located = { path: string; exact: boolean; note: string };

type SessionRouting = {
  provider_id: string;
  started_at: number;
  ended_at: number | null;
  harness_id: string | null;
  provider_profile_json: string | null;
};

/**
 * History is routed by the launch snapshot, never by whichever packs happen to
 * be enabled now. `harness_id` is authoritative when present; the serialized
 * profile covers rows written during the short migration window before that
 * dedicated column existed. Only genuinely legacy rows consult today's
 * registry as a compatibility fallback.
 */
function frozenHarness(row: SessionRouting): string | null {
  if (row.harness_id?.trim()) return row.harness_id.trim();
  if (row.provider_profile_json) {
    try {
      const profile = JSON.parse(row.provider_profile_json) as unknown;
      if (isRecord(profile) && typeof profile.harness === 'string' && profile.harness.trim()) {
        return profile.harness.trim();
      }
    } catch { /* malformed old snapshot; fall through to the legacy provider id */ }
  }
  return null;
}

function locate(sessionId: string, projectPath: string, conversationId: string | null): Located | { note: string } {
  const row = db().prepare(
    `SELECT provider_id, started_at, ended_at, harness_id, provider_profile_json
       FROM session_log WHERE id = ?`
  ).get(sessionId) as SessionRouting | undefined;

  // Only the Claude Code CLI writes these files — but more than one provider
  // runs it. GLM is that same binary with its base URL redirected, so it fills
  // ~/.claude/projects exactly as Claude does; testing the provider id here
  // left every GLM session with telemetry, a queue entry, and no archive of
  // the conversation that produced them. The test has to be the CLI.
  //
  // It still refuses Codex, which is the reason the check exists: Codex writes
  // no such file, so without this a Codex session run in a repo Claude has also
  // worked in would adopt Claude's transcript and present another agent's
  // conversation as its own.
  const harness = row ? frozenHarness(row) : null;
  const writesClaudeTranscript = row
    ? harness !== null ? harness === 'claude-code' : runsClaudeCli(row.provider_id)
    : true;
  if (row && !writesClaudeTranscript) {
    return { note: `${row.provider_id} sessions do not write a transcript file — nothing to archive.` };
  }

  const dirs = claudeProjectDirs(projectPath);
  if (conversationId) {
    const exact = exactIn(dirs, conversationId);
    if (exact) return { path: exact, exact: true, note: '' };
  }

  const from = row ? row.started_at - LIFETIME_GRACE_MS : 0;
  const to = (row?.ended_at ?? Date.now()) + LIFETIME_GRACE_MS;
  const guess = newestIn(dirs, from, to);
  if (!guess) {
    return {
      note: conversationId
        ? 'No transcript file for this conversation, and no other file in the project written during the session. Claude Code may not have saved one.'
        : 'This session has no conversation id, and the project has no transcript written during its lifetime.',
    };
  }
  return {
    path: guess.path,
    exact: false,
    note: `Exact conversation file was missing; archived the newest transcript written during this session (${path.basename(guess.path)}) instead.`,
  };
}

/**
 * Sessions are killed on quit by design, and Claude Code's transcript lives
 * outside Wanigan's data directory where an upgrade or a cleanup can remove it.
 * Archiving is what lets a finished session still be read.
 *
 * The order of the three steps is the whole point of this function:
 *
 *   1. Copy the raw .jsonl verbatim into Wanigan's own transcripts directory
 *      and record it. The copy is the record of truth — this format is internal
 *      to Claude Code and documented as changing between releases, so the bytes
 *      are the only part guaranteed to still mean something after an upgrade.
 *   2. Only then parse the copy into transcript_fts. Search is an index over
 *      the archive, never a substitute for it.
 *   3. A line that does not match the expected shape is skipped and counted,
 *      never thrown, and the count lands in transcripts.note.
 *
 * So a format change costs search quality and nothing else: the copy is already
 * on disk and already in the table before the parser is allowed to run, and a
 * parse that fails outright leaves parsed = 0 and a readable archive.
 *
 * Nothing here throws. This runs on session exit and on the quit path, where a
 * raised error would take down something far more important than an index.
 */
export function archiveSession(
  sessionId: string,
  projectPath: string,
  conversationId: string | null,
): { ok: boolean; note: string } {
  const found = locate(sessionId, projectPath, conversationId);
  if (!('path' in found)) return { ok: false, note: found.note };

  const dest = path.join(transcriptsDir(), `${sessionId}.jsonl`);
  let bytes = 0;
  let mtimeMs = Date.now();
  try {
    // Read the source mtime before copying: copyFileSync stamps the destination
    // with "now", and that timestamp is what dates any turn whose own line
    // carries none.
    mtimeMs = fs.statSync(found.path).mtimeMs;
    ensurePrivateDir(transcriptsDir());
    fs.copyFileSync(found.path, dest);
    ensurePrivateFile(dest);
    bytes = fs.statSync(dest).size;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      note: `Could not copy the transcript into ${transcriptsDir()} — check the folder is writable and the disk is not full. (${msg})`,
    };
  }

  const d = db();
  const archivedAt = Date.now();
  const record = d.prepare(`
    INSERT INTO transcripts (session_id, source_path, stored_path, bytes, turns, parsed, archived_at, note)
    VALUES (@sid, @src, @dst, @bytes, @turns, @parsed, @at, @note)
    ON CONFLICT(session_id) DO UPDATE SET
      source_path = excluded.source_path, stored_path = excluded.stored_path,
      bytes = excluded.bytes, turns = excluded.turns, parsed = excluded.parsed,
      archived_at = excluded.archived_at, note = excluded.note
  `);

  let note = found.exact ? `Archived ${bytes.toLocaleString()} bytes.` : found.note;
  // Recorded before the parse so a crash inside it still leaves the archive
  // findable in archivedSessions(), flagged as unindexed.
  record.run({ sid: sessionId, src: found.path, dst: dest, bytes, turns: 0, parsed: 0, at: archivedAt, note });

  try {
    const { text, truncated } = readForParse(dest);
    const parsed = parseTranscript(text, mtimeMs);
    const indexed = parsed.turns.filter((t) => (t.role === 'user' || t.role === 'assistant') && t.text);

    const del = d.prepare('DELETE FROM transcript_fts WHERE session_id = ?');
    const ins = d.prepare('INSERT INTO transcript_fts (session_id, role, at, text) VALUES (?,?,?,?)');
    d.transaction(() => {
      del.run(sessionId);
      for (const t of indexed) ins.run(sessionId, t.role, t.at, t.text);
    })();

    const parts = [found.exact ? `Archived ${bytes.toLocaleString()} bytes` : found.note.replace(/\.$/, '')];
    parts.push(`${indexed.length} searchable turn${indexed.length === 1 ? '' : 's'} from ${parsed.lines} line${parsed.lines === 1 ? '' : 's'}`);
    if (parsed.skipped) parts.push(`${parsed.skipped} line${parsed.skipped === 1 ? '' : 's'} did not match the expected shape and were skipped`);
    if (truncated) parts.push(`only the last ${Math.round(MAX_PARSE_BYTES / 1024 / 1024)}MB was indexed`);
    // The canary for a format change: a file full of lines and no turns in it.
    if (parsed.lines > 0 && !indexed.length) {
      parts.push('no turns were recognised — the transcript format has probably changed, but the archive itself is intact');
    }
    note = parts.join('; ') + '.';
    record.run({ sid: sessionId, src: found.path, dst: dest, bytes, turns: indexed.length, parsed: 1, at: archivedAt, note });
    return { ok: true, note };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    note = `Archived ${bytes.toLocaleString()} bytes, but indexing failed so this session will not appear in search: ${msg}`;
    try {
      record.run({ sid: sessionId, src: found.path, dst: dest, bytes, turns: 0, parsed: 0, at: archivedAt, note });
    } catch { /* the archive on disk is what matters */ }
    return { ok: true, note };
  }
}

/* ── search ──────────────────────────────────────────────────────────── */

/**
 * FTS5 reads bare input as a query language: a lone '*' or an unbalanced quote
 * is a syntax error that surfaces as a crash on every keystroke. Wrapping the
 * whole query as one double-quoted phrase (with "" as the escape for a quote)
 * makes every character literal; the trailing '*' makes the last word a prefix
 * so a search matches while it is still being typed.
 */
function ftsQuery(q: string): string {
  return `"${q.replace(/"/g, '""')}"*`;
}

type HitRow = {
  session_id: string;
  role: string;
  at: number | null;
  snip: string | null;
  project_name: string | null;
  project_path: string | null;
  provider_id: string | null;
  started_at: number | null;
  archived_at: number | null;
};

// LEFT JOIN, not JOIN: forgetting a past session deletes its session_log row
// while the archive survives, and those hits must not vanish from search.
const HIT_COLUMNS = `
    transcript_fts.session_id AS session_id,
    transcript_fts.role       AS role,
    transcript_fts.at         AS at,
    s.project_name, s.project_path, s.provider_id, s.started_at, t.archived_at
  FROM transcript_fts
  LEFT JOIN session_log s ON s.id = transcript_fts.session_id
  LEFT JOIN transcripts t ON t.session_id = transcript_fts.session_id`;

function toHit(r: HitRow, fallbackSnippet: string): TranscriptHit {
  // The id the session was logged with, whatever it was. This used to name
  // Claude, Codex and GLM and default everything else to 'claude', which badged
  // a fourth provider's conversation — a local pack's, a built-in a later
  // release adds — with Claude's identity in every search result. That is a
  // wrong attribution of somebody's words, not a colour choice. ProviderId is a
  // string precisely so history can carry an id this build no longer compiles.
  //
  // Empty means the session_log row is gone (a forgotten session, the reason
  // for the LEFT JOIN above). Naming no provider is the only honest answer
  // there; inventing one is what this function is being fixed for.
  const provider: ProviderId = r.provider_id?.trim() || '';
  return {
    sessionId: r.session_id,
    projectName: r.project_name ?? '(forgotten session)',
    projectPath: r.project_path ?? '',
    providerId: provider,
    startedAt: Number(r.started_at ?? r.archived_at ?? r.at ?? 0),
    snippet: (r.snip ?? fallbackSnippet).replace(/\s+/g, ' ').trim(),
    role: r.role === 'assistant' ? 'assistant' : 'user',
    at: Number(r.at ?? 0),
  };
}

/** Window around the first match, for the LIKE fallback where there is no
 *  snippet() to lean on. */
function windowAround(text: string, needle: string): string {
  const i = needle ? text.toLowerCase().indexOf(needle.toLowerCase()) : -1;
  if (i < 0) return text.slice(0, 180);
  const start = Math.max(0, i - 60);
  const end = Math.min(text.length, i + needle.length + 120);
  return (start > 0 ? '…' : '')
    + text.slice(start, i) + HIT_OPEN + text.slice(i, i + needle.length) + HIT_CLOSE
    + text.slice(i + needle.length, end)
    + (end < text.length ? '…' : '');
}

export function searchTranscripts(q: string, limit = 50): TranscriptHit[] {
  const query = q.trim();
  if (!query) return [];
  const d = db();
  // The renderer supplies this. SQLite reads a negative LIMIT as "no limit", so
  // an unclamped value turns a search box into a request for every archived
  // turn on the machine — clamped here the way the other read paths do it.
  const n = Math.min(Math.max(Math.trunc(limit) || 1, 1), 200);

  try {
    const rows = d.prepare(`
      SELECT snippet(transcript_fts, 3, '${HIT_OPEN}', '${HIT_CLOSE}', '…', 14) AS snip,
      ${HIT_COLUMNS}
      WHERE transcript_fts MATCH ? AND transcript_fts.role IN ('user','assistant')
      ORDER BY rank
      LIMIT ?
    `).all(ftsQuery(query), n) as HitRow[];
    return rows.map((r) => toHit(r, ''));
  } catch {
    // MATCH still rejects some inputs outright (an unpaired surrogate, a future
    // syntax rule). A substring scan is slower and dumber but always answers.
    const like = `%${query.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
    const rows = d.prepare(`
      SELECT NULL AS snip, transcript_fts.text AS text,
      ${HIT_COLUMNS}
      WHERE transcript_fts.text LIKE ? ESCAPE '\\' AND transcript_fts.role IN ('user','assistant')
      ORDER BY transcript_fts.at DESC
      LIMIT ?
    `).all(like, n) as (HitRow & { text: string })[];
    return rows.map((r) => toHit(r, windowAround(r.text, query)));
  }
}

/* ── reading ─────────────────────────────────────────────────────────── */

/**
 * Re-parses the archived copy rather than reading back the index: the index
 * holds only what is worth searching, while reading a session means seeing the
 * tool steps too. The copy on disk is the record of truth in both directions.
 */
/**
 * The newest assistant turn in a conversation that is still running.
 *
 * transcriptFor below reads the `transcripts` table, which archiveSession fills
 * when a session *exits* — so for a live conversation it correctly answers that
 * nothing was archived. The handover needs the opposite case: a conversation
 * that is still going, whose text is in the CLI's own transcript on disk. That
 * is the same file the context reader measures, resolved the same way.
 *
 * Returns null for "there is no such turn" and throws for "the transcript could
 * not be read", because a caller about to seed a new session with this needs to
 * tell an empty answer apart from a failed one.
 */
/**
 * A conversation's own name, read from the transcript the agent already keeps.
 *
 * Everything decidable from text is decided in `shared/session-title.ts`, which
 * documents why this exists and what it refuses to invent. What is here is the
 * part that touches a disk: which file belongs to a conversation, how much of
 * it to read, and not reading it twice.
 *
 * Exact matches only. `transcriptPathFor` falls back to the newest transcript
 * in the project when an id is gone, and the context reader can afford that
 * because it labels the result "match unconfirmed" in the same breath. A list
 * of names cannot: the fallback would quietly caption an old conversation with
 * a newer one's title, which is worse than the project name it replaced.
 *
 * Bounded and cached: the head of the file, keyed on its size and mtime, so a
 * list of forty costs forty small reads once and nothing on any later render.
 * 256 KiB reaches well past the opening turns of a conversation without ever
 * pulling a multi-megabyte transcript into memory to read one line of it.
 */
const TITLE_HEAD_BYTES = 256 * 1024;

const titleCache = new Map<string, { stamp: string; read: ReadTitle }>();

export type { ReadTitle, TitleSource } from '../shared/session-title';

function headOf(file: string, bytes: number): string {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const buffer = Buffer.allocUnsafe(bytes);
    const read = fs.readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, read).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* already closed */ } }
  }
}

/** A name for one transcript file, read from its head and remembered. */
export function titleFromTranscript(file: string): ReadTitle {
  let stamp: string;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return null;
    stamp = `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return null;
  }
  const hit = titleCache.get(file);
  if (hit && hit.stamp === stamp) return hit.read;

  const read = titleFromTranscriptText(headOf(file, TITLE_HEAD_BYTES));
  titleCache.set(file, { stamp, read });
  return read;
}

/** The Claude conversation's own name, by exact id only. */
export function conversationTitle(projectPath: string, conversationId: string | null): ReadTitle {
  if (!conversationId) return null;
  const file = exactIn(claudeProjectDirs(projectPath), conversationId);
  return file ? titleFromTranscript(file) : null;
}

export function lastAssistantTurn(projectPath: string, conversationId: string | null): string | null {
  const file = transcriptPathFor(projectPath, conversationId);
  if (!file) return null;
  const { text } = readForParse(file);
  const parsed = parseTranscript(text, Date.now());
  for (let i = parsed.turns.length - 1; i >= 0; i -= 1) {
    const turn = parsed.turns[i];
    if (turn.role === 'assistant' && turn.text.trim()) return turn.text.trim();
  }
  return null;
}

export function transcriptFor(sessionId: string): { turns: TranscriptTurn[]; note: string | null; bytes: number } {
  const row = db().prepare(
    'SELECT stored_path, bytes, note FROM transcripts WHERE session_id = ?'
  ).get(sessionId) as { stored_path: string; bytes: number; note: string | null } | undefined;

  if (!row) {
    return { turns: [], bytes: 0, note: 'No transcript was archived for this session.' };
  }
  if (!isFile(row.stored_path)) {
    return {
      turns: [], bytes: 0,
      note: `The archived copy is missing from ${path.dirname(row.stored_path)} — it was moved or deleted outside Wanigan.`,
    };
  }

  try {
    const { text, truncated } = readForParse(row.stored_path);
    const parsed = parseTranscript(text, Date.now());
    const turns = parsed.turns.slice(-MAX_READ_TURNS);
    const notes = [
      row.note,
      truncated ? `Showing the last ${Math.round(MAX_PARSE_BYTES / 1024 / 1024)}MB of a larger transcript.` : null,
      turns.length < parsed.turns.length
        ? `Showing the most recent ${MAX_READ_TURNS.toLocaleString()} of ${parsed.turns.length.toLocaleString()} turns.`
        : null,
    ].filter(Boolean);
    return { turns, bytes: row.bytes, note: notes.length ? notes.join(' ') : null };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { turns: [], bytes: row.bytes, note: `The archived copy could not be read: ${msg}` };
  }
}

export function archivedSessions(): { sessionId: string; bytes: number; turns: number; archivedAt: number }[] {
  const rows = db().prepare(
    'SELECT session_id, bytes, turns, archived_at FROM transcripts ORDER BY archived_at DESC'
  ).all() as { session_id: string; bytes: number; turns: number; archived_at: number }[];
  return rows.map((r) => ({
    sessionId: r.session_id,
    bytes: Number(r.bytes),
    turns: Number(r.turns),
    archivedAt: Number(r.archived_at),
  }));
}

/** Forgets a transcript everywhere: index, record, and the copy on disk. Anything
 *  less leaves a conversation on the user's disk after they asked for it gone. */
export function forgetTranscript(sessionId: string): void {
  const d = db();
  const row = d.prepare('SELECT stored_path FROM transcripts WHERE session_id = ?')
    .get(sessionId) as { stored_path: string } | undefined;
  d.transaction(() => {
    d.prepare('DELETE FROM transcript_fts WHERE session_id = ?').run(sessionId);
    d.prepare('DELETE FROM transcripts WHERE session_id = ?').run(sessionId);
  })();
  if (row) {
    try { fs.rmSync(row.stored_path, { force: true }); } catch { /* already gone */ }
  }
}

/* ── context occupancy, from the transcript's own usage records ─────── */

/**
 * Only the tail is read. The newest usage record is by construction near the
 * end of the file, and a long session's transcript runs to hundreds of
 * megabytes — reading all of it to answer a badge would be the exact stall
 * MAX_PARSE_BYTES exists to prevent. A usage record older than the last
 * 256 KiB of writes describes a context that no longer exists anyway.
 */
const CONTEXT_TAIL_BYTES = 256 * 1024;

/**
 * The windows Wanigan will claim for a Claude-family model — assumptions,
 * and every rendering of them says so. An unrecognised model gets a token
 * count and no percentage at all.
 *
 * The 1M-token context *can* be told from a transcript, which an earlier
 * version of this comment denied: Claude Code spells such a session's model
 * with a `[1m]` suffix in the usage records themselves (`"model":
 * "claude-opus-5[1m]"` — 1,905 records on the machine that wrote this, CLI
 * 2.1.261, 2026-09-05). The suffix is the one observable that separates the
 * two windows, so it decides; the launch model is only a fallback for a record
 * that names no model. Neither is a measurement.
 */
const CLAUDE_CONTEXT_WINDOW = 200_000;
const CLAUDE_CONTEXT_WINDOW_1M = 1_000_000;
const ONE_MILLION_SUFFIX = '[1m]';
/** Aliases the CLI accepts at launch; they name a Claude model without the `claude-` prefix. */
const CLAUDE_ALIASES = new Set(['opus', 'sonnet', 'haiku', 'fable']);

function hasMillionSuffix(model: string): boolean {
  return model.endsWith(ONE_MILLION_SUFFIX);
}

function baseModelId(model: string): string {
  return hasMillionSuffix(model) ? model.slice(0, -ONE_MILLION_SUFFIX.length) : model;
}

function isClaudeId(model: string): boolean {
  return baseModelId(model).startsWith('claude-');
}

type AssumedWindow = {
  window: number | null;
  source: 'assumed-200k' | 'assumed-1m' | null;
  note: string | null;
};

/**
 * Which window to assume, from the newest usage record's model and, failing
 * that, the model the session was launched with.
 *
 * A full launch id whose base differs from the newest record's base means the
 * model changed mid-session (`/model`); which window applies is then not
 * something Wanigan can know from two ids, so no percentage is claimed. Aliases
 * cannot be compared to a full id and do not trigger that rule.
 */
export function assumedClaudeWindow(usageModel: string | null, launchModel: string | null): AssumedWindow {
  const usage = usageModel?.trim() || null;
  const launch = launchModel?.trim() || null;
  if (usage) {
    if (!isClaudeId(usage)) {
      return { window: null, source: null, note: `No window is assumed for ${usage}; only the measured tokens are shown.` };
    }
    if (hasMillionSuffix(usage)) {
      return { window: CLAUDE_CONTEXT_WINDOW_1M, source: 'assumed-1m', note: 'Assumed 1M window from the [1m] suffix on the model in the transcript.' };
    }
    if (launch && isClaudeId(launch) && baseModelId(launch) !== baseModelId(usage)) {
      return {
        window: null, source: null,
        note: `The model changed mid-session (launched as ${launch}, newest turn ${usage}); no window is assumed.`,
      };
    }
    return { window: CLAUDE_CONTEXT_WINDOW, source: 'assumed-200k', note: 'Assumed 200k window; the model in the transcript carries no [1m] suffix.' };
  }
  if (launch) {
    if (hasMillionSuffix(launch)) {
      return { window: CLAUDE_CONTEXT_WINDOW_1M, source: 'assumed-1m', note: 'Assumed 1M window from the [1m] suffix on the launch model; the transcript names no model.' };
    }
    if (isClaudeId(launch) || CLAUDE_ALIASES.has(launch)) {
      return { window: CLAUDE_CONTEXT_WINDOW, source: 'assumed-200k', note: 'Assumed 200k window from the launch model; the transcript names no model.' };
    }
  }
  return { window: null, source: null, note: null };
}

/* ── windows the Claude CLI itself reported ──────────────────────────── */

/**
 * A headless `--output-format json` result carries `modelUsage[model]
 * .contextWindow` (present in the 2.1.261 result schema). The binary computes
 * that figure from the model and its settings — it is what the CLI believes the
 * window to be, reported, not measured — and it is the best available answer
 * for an interactive session using the same model under the same backend and
 * account. Any of the three differing means a different answer might apply,
 * so a match requires all three.
 *
 * Kept as a small bounded record in the settings table rather than a new
 * schema: it is a cache of reported facts, and the newest report per key wins.
 */
const REPORTED_WINDOWS_KEY = 'context.cliReportedWindows';
const REPORTED_WINDOWS_MAX = 64;

type ReportedWindow = { model: string; contextWindow: number; backendId: string | null; accountId: string | null; at: number };

function readReportedWindows(): ReportedWindow[] {
  try {
    const raw = JSON.parse(getSetting(REPORTED_WINDOWS_KEY, '[]')) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter((row): row is ReportedWindow => isRecord(row)
      && typeof row.model === 'string' && typeof row.contextWindow === 'number' && row.contextWindow > 0
      && typeof row.at === 'number');
  } catch {
    return [];
  }
}

export function rememberReportedContextWindows(
  entries: { model: string; contextWindow: number }[],
  scope: { backendId: string | null; accountId: string | null; at: number },
): number {
  const clean = entries.filter((entry) => typeof entry.model === 'string' && entry.model.trim()
    && Number.isFinite(entry.contextWindow) && entry.contextWindow > 0);
  if (!clean.length) return 0;
  const sameKey = (a: ReportedWindow, b: ReportedWindow) => a.model === b.model
    && (a.backendId ?? null) === (b.backendId ?? null) && (a.accountId ?? null) === (b.accountId ?? null);
  let rows = readReportedWindows();
  for (const entry of clean) {
    const next: ReportedWindow = {
      model: entry.model.trim(), contextWindow: Math.round(entry.contextWindow),
      backendId: scope.backendId ?? null, accountId: scope.accountId ?? null, at: scope.at,
    };
    rows = [next, ...rows.filter((row) => !sameKey(row, next))];
  }
  setSetting(REPORTED_WINDOWS_KEY, JSON.stringify(rows.slice(0, REPORTED_WINDOWS_MAX)));
  return clean.length;
}

/** Exact spelling only: `claude-opus-5` and `claude-opus-5[1m]` are different windows. */
export function reportedContextWindow(
  model: string, backendId: string | null, accountId: string | null,
): { contextWindow: number; at: number } | null {
  const wanted = model.trim();
  const hit = readReportedWindows().find((row) => row.model === wanted
    && (row.backendId ?? null) === (backendId ?? null) && (row.accountId ?? null) === (accountId ?? null));
  return hit ? { contextWindow: hit.contextWindow, at: hit.at } : null;
}

/**
 * The launch facts recorded for a conversation: the model asked for and the
 * backend and account the session was frozen to. Absent for a conversation
 * Wanigan did not start (fixtures, observed sessions).
 */
function launchRowFor(conversationId: string | null): { model: string | null; backendId: string | null; accountId: string | null } | null {
  if (!conversationId) return null;
  const row = db().prepare(`
    SELECT model, backend_id, account_id FROM session_log
    WHERE conversation_id = ? ORDER BY started_at DESC LIMIT 1
  `).get(conversationId) as { model: string | null; backend_id: string | null; account_id: string | null } | undefined;
  return row ? { model: row.model, backendId: row.backend_id, accountId: row.account_id } : null;
}

/**
 * The newest context measurement in a chunk of transcript text — the last
 * non-sidechain line whose message carries a usage record. Sidechains are
 * subagents running in their own context; counting them would report someone
 * else's window. A record that sums to zero is a synthetic error line, not a
 * measurement, and is skipped for the same reason.
 */
export function contextUsageFromTail(text: string): { tokens: number; model: string | null; at: number | null } | null {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let raw: unknown;
    try { raw = JSON.parse(line); } catch { continue; }
    if (!isRecord(raw) || raw.isSidechain === true) continue;
    const msg = isRecord(raw.message) ? raw.message : null;
    if (!msg || !isRecord(msg.usage) || typeof msg.usage.input_tokens !== 'number') continue;
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
    const usage = msg.usage;
    const tokens = n(usage.input_tokens) + n(usage.cache_read_input_tokens)
      + n(usage.cache_creation_input_tokens) + n(usage.output_tokens);
    if (tokens === 0) continue;
    const at = timeOf(raw, 0);
    return {
      tokens,
      model: typeof msg.model === 'string' && msg.model.trim() ? msg.model : null,
      at: at > 0 ? at : null,
    };
  }
  return null;
}

/**
 * Context occupancy for one conversation, measured from its transcript.
 *
 * The exact conversation file is preferred. Claude Code forks a new file id
 * when a conversation is resumed, so when the exact id is gone the newest
 * transcript written since this session started stands in — bounded by the
 * session's own lifetime rather than "whatever this repo saw last", which
 * could be a different conversation entirely.
 */
export function claudeContextUsage(cwd: string, conversationId: string | null, sinceMs: number): ClaudeContextUsage {
  const dirs = claudeProjectDirs(cwd);
  let file: string | null = conversationId ? exactIn(dirs, conversationId) : null;
  const conversationMatch = file ? 'exact' : 'lifetime-fallback';
  if (!file) file = newestIn(dirs, Math.max(0, sinceMs - LIFETIME_GRACE_MS))?.path ?? null;
  if (!file) return { kind: 'no-transcript' };

  let text: string;
  let start = 0;
  try {
    const size = fs.statSync(file).size;
    start = Math.max(0, size - CONTEXT_TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buffer, 0, buffer.length, start); } finally { fs.closeSync(fd); }
    text = buffer.toString('utf8');
  } catch {
    return { kind: 'no-transcript' };
  }
  // A cut that landed mid-line must not hand half a JSON record to the parser.
  if (start > 0) text = text.slice(text.indexOf('\n') + 1);

  const hit = contextUsageFromTail(text);
  if (!hit) {
    return { kind: 'no-usage', detail: 'The transcript has no usage records yet — the agent has not completed a turn.' };
  }
  // A CLI-reported window for this exact model under this session's frozen
  // backend and account beats the assumption; otherwise the assumption stands,
  // labelled as one.
  const launch = launchRowFor(conversationId);
  const reported = hit.model ? reportedContextWindow(hit.model, launch?.backendId ?? null, launch?.accountId ?? null) : null;
  const assumed = reported ? null : assumedClaudeWindow(hit.model, launch?.model ?? null);
  const window = reported ? reported.contextWindow : assumed?.window ?? null;
  return {
    kind: 'ok',
    tokens: hit.tokens,
    window,
    percent: window ? Math.min(100, Math.round((hit.tokens / window) * 100)) : null,
    model: hit.model,
    at: hit.at,
    conversationMatch,
    windowSource: reported ? 'cli-reported' : assumed?.source ?? null,
    windowNote: reported
      ? `Window reported by the Claude CLI for this model, backend and account (headless run on ${new Date(reported.at).toISOString().slice(0, 10)}); reported, not measured.`
      : assumed?.note ?? null,
  };
}

/* ── recall for a running session: the opt-in MCP tool ───────────────── */

/**
 * Off by default, per project, and only ever switched on by the operator. A
 * session that can read past conversations is a session that can quote them,
 * so the tool is listed to an agent only after that choice was made — there is
 * no silent injection path and no global switch.
 */
const RECALL_KEY_PREFIX = 'transcripts.recall.';
const RECALL_MAX_HITS = 20;
const RECALL_MAX_QUERY = 500;
const RECALL_SNIPPET_MAX = 600;
/** Sessions searched per call; the newest archived ones, well under SQLite's parameter cap. */
const RECALL_MAX_SESSIONS = 400;

export function recallEnabled(projectId: string): boolean {
  if (typeof projectId !== 'string' || !projectId.trim()) return false;
  return getSetting(RECALL_KEY_PREFIX + projectId.trim(), '0') === '1';
}

export function setRecallEnabled(projectId: unknown, enabled: unknown): boolean {
  if (typeof projectId !== 'string' || !projectId.trim()) throw new Error('Choose a project first.');
  const on = enabled === true;
  setSetting(RECALL_KEY_PREFIX + projectId.trim(), on ? '1' : '0');
  return on;
}

export type RecallScope = {
  projectId: string;
  harnessId: string | null;
  providerId: string | null;
  backendId: string | null;
  accountId: string | null;
};

/**
 * Search the archived transcripts a running session is allowed to see: the
 * same project, the same frozen backend and the same frozen account. `IS`
 * rather than `=` so a null account matches only other null-account rows.
 *
 * Only the claude-code harness has an archive at all — archiveSession() copies
 * Claude Code's transcript file and refuses everything else — so a Codex or
 * generic session gets that fact, not an empty list that looks like "nothing
 * relevant". Snippets pass through the same credential redaction the launch
 * prompt does, because indexed text is whatever the conversation contained.
 */
export function recallTranscripts(scope: RecallScope, rawQuery: unknown, rawLimit?: unknown): TranscriptRecall {
  if (!recallEnabled(scope.projectId)) {
    return { kind: 'disabled', note: 'Transcript recall is off for this project. It is an operator choice made in Wanigan, never a default.' };
  }
  const harness = scope.harnessId
    ?? (scope.providerId && runsClaudeCli(scope.providerId) ? 'claude-code' : null);
  if (harness !== 'claude-code') {
    return {
      kind: 'unsupported', harnessId: harness,
      note: `Wanigan archives transcripts only for the claude-code harness; there is no archive for ${harness ?? 'this harness'} to recall from.`,
    };
  }
  const query = typeof rawQuery === 'string' ? rawQuery.trim() : '';
  if (!query) throw new Error('query is required.');
  if (query.length > RECALL_MAX_QUERY) throw new Error(`query is at most ${RECALL_MAX_QUERY} characters.`);
  const limit = typeof rawLimit === 'number' && Number.isFinite(rawLimit)
    ? Math.min(Math.max(Math.trunc(rawLimit), 1), RECALL_MAX_HITS)
    : 10;

  const d = db();
  const sessions = d.prepare(`
    SELECT s.id, s.title FROM session_log s
    JOIN transcripts t ON t.session_id = s.id
    WHERE s.project_id = ?
      AND (s.harness_id = 'claude-code' OR (s.harness_id IS NULL AND s.provider_id IN ('claude', 'glm')))
      AND s.backend_id IS ? AND s.account_id IS ?
    ORDER BY s.started_at DESC LIMIT ?
  `).all(scope.projectId, scope.backendId ?? null, scope.accountId ?? null, RECALL_MAX_SESSIONS) as { id: string; title: string | null }[];
  const scopeOut = { projectId: scope.projectId, harnessId: harness, backendId: scope.backendId ?? null, accountId: scope.accountId ?? null };
  if (!sessions.length) {
    return { kind: 'ok', scope: scopeOut, archivedSessions: 0, hits: [], note: 'No archived transcript is in scope for this project, backend and account.' };
  }
  const titles = new Map(sessions.map((row) => [row.id, row.title]));
  const marks = sessions.map(() => '?').join(',');
  const ids = sessions.map((row) => row.id);
  type Row = { session_id: string; role: string; at: number | null; snip: string | null; text?: string; started_at: number | null };
  const columns = `
    transcript_fts.session_id AS session_id, transcript_fts.role AS role, transcript_fts.at AS at, s.started_at
    FROM transcript_fts LEFT JOIN session_log s ON s.id = transcript_fts.session_id
    WHERE transcript_fts.session_id IN (${marks}) AND transcript_fts.role IN ('user','assistant')`;
  let rows: Row[];
  let fallbackNeedle = '';
  try {
    rows = d.prepare(`
      SELECT snippet(transcript_fts, 3, '${HIT_OPEN}', '${HIT_CLOSE}', '…', 14) AS snip, ${columns}
        AND transcript_fts MATCH ? ORDER BY rank LIMIT ?
    `).all(...ids, ftsQuery(query), limit) as Row[];
  } catch {
    // The same fallback searchTranscripts() uses when MATCH rejects the input.
    fallbackNeedle = query;
    const like = `%${query.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
    rows = d.prepare(`
      SELECT NULL AS snip, transcript_fts.text AS text, ${columns}
        AND transcript_fts.text LIKE ? ESCAPE '\\' ORDER BY transcript_fts.at DESC LIMIT ?
    `).all(...ids, like, limit) as Row[];
  }
  const hits = rows.map((row) => {
    const raw = (row.snip ?? windowAround(row.text ?? '', fallbackNeedle)).replace(/\s+/g, ' ').trim();
    const redacted = redactCredentials(raw);
    return {
      sessionId: row.session_id,
      title: titles.get(row.session_id) ?? null,
      startedAt: Number(row.started_at ?? row.at ?? 0),
      role: row.role === 'assistant' ? 'assistant' as const : 'user' as const,
      at: Number(row.at ?? 0),
      snippet: redacted.length > RECALL_SNIPPET_MAX ? `${redacted.slice(0, RECALL_SNIPPET_MAX - 1)}…` : redacted,
    };
  });
  return {
    kind: 'ok', scope: scopeOut, archivedSessions: sessions.length, hits,
    note: hits.length ? null : `No archived turn in scope matched “${query}”.`,
  };
}
