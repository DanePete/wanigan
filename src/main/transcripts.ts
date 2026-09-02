import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { db, dataDir, ensurePrivateDir, ensurePrivateFile } from './db';
import { runsClaudeCli } from './providers';
import type { ClaudeContextUsage, ProviderId, TranscriptHit, TranscriptTurn } from '../shared/types';

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
 * Claude Code slugs the working directory by replacing every non-alphanumeric
 * character with '-', so /Users/x/repo becomes -Users-x-repo. CLAUDE_CONFIG_DIR
 * is honoured because a user who has moved their config has no ~/.claude at all,
 * and the archive would otherwise silently find nothing and blame the session.
 */
function claudeProjectDir(projectPath: string): string {
  const root = process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), '.claude');
  return path.join(root, 'projects', path.resolve(projectPath).replace(/[^a-zA-Z0-9]/g, '-'));
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
  const dir = claudeProjectDir(projectPath);
  if (conversationId) {
    const exact = path.join(dir, `${conversationId}.jsonl`);
    if (isFile(exact)) return exact;
  }
  return newestJsonl(dir)?.path ?? null;
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

  const dir = claudeProjectDir(projectPath);
  if (conversationId) {
    const exact = path.join(dir, `${conversationId}.jsonl`);
    if (isFile(exact)) return { path: exact, exact: true, note: '' };
  }

  const from = row ? row.started_at - LIFETIME_GRACE_MS : 0;
  const to = (row?.ended_at ?? Date.now()) + LIFETIME_GRACE_MS;
  const guess = newestJsonl(dir, from, to);
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
 * The window Wanigan will claim for a Claude-family model — an assumption,
 * and every rendering of it says so. The 1M-token beta cannot be detected
 * from a transcript, so it is never guessed; an unrecognised model gets a
 * token count and no percentage at all.
 */
const CLAUDE_CONTEXT_WINDOW = 200_000;

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
  const dir = claudeProjectDir(cwd);
  let file: string | null = null;
  if (conversationId) {
    const exact = path.join(dir, `${conversationId}.jsonl`);
    if (isFile(exact)) file = exact;
  }
  if (!file) file = newestJsonl(dir, Math.max(0, sinceMs - LIFETIME_GRACE_MS))?.path ?? null;
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
  const window = hit.model && hit.model.startsWith('claude-') ? CLAUDE_CONTEXT_WINDOW : null;
  return {
    kind: 'ok',
    tokens: hit.tokens,
    window,
    percent: window ? Math.min(100, Math.round((hit.tokens / window) * 100)) : null,
    model: hit.model,
    at: hit.at,
  };
}
