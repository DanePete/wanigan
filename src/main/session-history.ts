/**
 * Recent, and everything it is made of: the durable record of every execution
 * Wanigan has ever started, read back as conversations a person can name, pin,
 * settle, resume or forget.
 *
 * This is the other half of a session. `sessions.ts` owns the launch and the
 * PTY — the trust kernel, where a process is spawned and an environment is
 * decided — and it stayed 2587 lines long partly because this half was inside
 * it. Nothing here spawns anything, reads a credential or touches a terminal:
 * it is SQL over `session_log` and `conversation_flags`, plus the transcript
 * reads that give a conversation its name.
 *
 * The two halves meet at exactly three questions, which is what made the split
 * worth doing: which conversations have a live writer, what a live pane should
 * now be called, and whether a session's launch snapshot is still in memory.
 * They arrive through `setLiveSessions` rather than by importing the map,
 * because `sessions.ts` already imports `deriveSessionTitle` from here and a
 * cycle between the two would be paid for at every future edit. Injection is
 * the pattern this module already uses for `setSessionExitObserver`.
 *
 * Without a reader registered, every conversation reads as having no live
 * writer. That is the honest answer for a process that has not started a
 * session manager, and it keeps this module usable — and testable — alone.
 */
import fs from 'node:fs';
import { db } from './db';
import { flags } from './settings';
import { forgetSessionCheckpoints } from './checkpoints';
import { archiveSession, conversationTitle, titleFromTranscript, type ReadTitle } from './transcripts';
import { backfillCodexThreadIds, codexRolloutFiles, normalizeCodexThreadId } from './codex-sessions';
import type { Baseline, PastSession } from '../shared/types';

/**
 * What this module needs to know about sessions that are still running.
 *
 * Three questions and no more. `setDisplayTitle` answers whether a live pane
 * was renamed and performs the rename itself, so the broadcast that follows it
 * stays on the side of the boundary that owns the window.
 */
export type LiveSessions = {
  /** Ids of every session that has not exited. */
  ids(): ReadonlySet<string>;
  /** Rename a live pane; false when no live session has that id. */
  setDisplayTitle(id: string, title: string | null): boolean;
  /** The launch snapshot still held in memory, if this session is live. */
  baseline(id: string): Baseline | null;
};

const NO_LIVE_SESSIONS: LiveSessions = {
  ids: () => new Set<string>(),
  setDisplayTitle: () => false,
  baseline: () => null,
};

let liveReader: LiveSessions = NO_LIVE_SESSIONS;

/** Registered by sessions.ts as it loads; see the note at the top of this file. */
export function setLiveSessions(reader: LiveSessions | null): void {
  liveReader = reader ?? NO_LIVE_SESSIONS;
}

function liveSessions(): LiveSessions {
  return liveReader;
}

type SessionLogRow = Record<string, string | number | null>;

function savedConversationId(row: SessionLogRow): string | null {
  const id = row.conversation_id;
  return typeof id === 'string' && id.trim() ? id : null;
}

/**
 * Conversation IDs belong to harnesses, not presentation profiles. This keeps
 * a thread from appearing twice after a provider-pack rename or migration.
 */
function harnessOf(row: SessionLogRow): string {
  const stored = typeof row.harness_id === 'string' && row.harness_id.trim()
    ? row.harness_id
    : null;
  // `harness_id` was added after Wanigan had already saved Codex/Claude
  // records. Their built-in provider IDs are reliable migration aliases; a
  // generic/third-party profile remains scoped to its own opaque provider ID.
  const legacy = String(row.provider_id);
  return stored
    ?? (legacy === 'codex' ? 'codex' : legacy === 'claude' || legacy === 'glm' ? 'claude-code' : `provider:${legacy}`);
}

function conversationKey(row: SessionLogRow, conversationId: string): string {
  return `${harnessOf(row)}:conversation:${conversationId}`;
}

/**
 * A process cannot survive a deliberate Wanigan quit, but a hard app crash can
 * leave its execution row looking live forever. There is no live PTY map on a
 * new main-process boot, so close those old execution records before Recent is
 * calculated. A durable conversation ID remains resumable; only its last
 * execution receives the interrupted (-1) outcome.
 */
export function reconcileAbandonedSessions(now = Date.now()): number {
  try {
    return db().prepare(`
      UPDATE session_log
         SET ended_at = ?, exit_code = -1
       WHERE origin = 'wanigan' AND ended_at IS NULL
    `).run(now).changes;
  } catch {
    return 0;
  }
}

/** How far back an interrupted execution is still looked at on launch. */
const INTERRUPTED_ARCHIVE_WINDOW_MS = 30 * 24 * 60 * 60_000;
/** Archive attempts per launch: each is a file copy and a parse. */
const INTERRUPTED_ARCHIVE_MAX = 25;

/**
 * Transcripts of executions that ended without Wanigan seeing them end.
 *
 * Archiving runs in the PTY's exit handler, and three endings never reach it:
 * an app crash, a force quit, and a quit whose SIGKILL escalation outran
 * node-pty. The row is closed with -1 (reconcileAbandonedSessions, or killAll),
 * and the conversation's only copy stays in Claude Code's folder, where an
 * upgrade or a cleanup can remove it. A session that crashed was never
 * archived, so the one conversation most worth reading afterwards was the one
 * most likely to be lost.
 *
 * Exact files only. An interrupted row's ended_at is when Wanigan noticed, not
 * when the agent stopped — possibly days later — so the lifetime window the
 * exit path guesses inside could reach a transcript someone else wrote since.
 * And only the newest execution of a conversation: a later resume's archive
 * already holds everything an earlier one would copy, and copying the file now
 * would file the later turns under the earlier session.
 */
export function archiveInterruptedTranscripts(now = Date.now()): { archived: number; notFound: number } {
  const result = { archived: 0, notFound: 0 };
  if (!flags().archiveTranscripts) return result;
  let rows: Array<{ id: string; project_path: string; conversation_id: string }>;
  try {
    rows = db().prepare(`
      SELECT s.id, s.project_path, s.conversation_id
        FROM session_log s
       WHERE s.origin = 'wanigan' AND s.exit_code = -1 AND s.conversation_id IS NOT NULL
         AND s.started_at >= ?
         AND NOT EXISTS (SELECT 1 FROM transcripts t WHERE t.session_id = s.id)
         AND NOT EXISTS (SELECT 1 FROM session_log later
                          WHERE later.conversation_id = s.conversation_id AND later.started_at > s.started_at)
       ORDER BY s.started_at DESC
    `).all(now - INTERRUPTED_ARCHIVE_WINDOW_MS) as typeof rows;
  } catch {
    return result;
  }
  let attempts = 0;
  for (const row of rows) {
    if (attempts >= INTERRUPTED_ARCHIVE_MAX) break;
    let outcome: ReturnType<typeof archiveSession>;
    try { outcome = archiveSession(row.id, row.project_path, row.conversation_id, { exactOnly: true }); }
    catch { continue; }
    // A harness that writes no transcript costs a row read and no attempt, so a
    // run of Codex sessions cannot use up the Claude ones' turn.
    if (outcome.unsupported) continue;
    attempts++;
    if (outcome.ok) result.archived++;
    else result.notFound++;
  }
  return result;
}

/**
 * Is there a Codex execution whose identity the repair pass could still fix?
 *
 * The repair used to run on every Recent read, and Recent is read on mount and
 * after every start, close, rename and forget. Each run opened Codex's own
 * state_5.sqlite read-only per Codex home and rebuilt the lineage graph, even
 * when every row already carried its UUID and the pass could not change a
 * single one. This asks the cheap question first, over one column: a row the
 * repair would treat as unidentified is one whose stored id is not already the
 * normalized form, so an absent, malformed or unnormalized id still runs the
 * full pass and nothing repairable is skipped.
 */
function codexIdentityRepairPending(): boolean {
  const rows = db().prepare(`
    SELECT conversation_id FROM session_log
     WHERE origin = 'wanigan' AND (harness_id = 'codex' OR provider_id = 'codex')
  `).all() as Array<{ conversation_id: string | null }>;
  return rows.some((row) => normalizeCodexThreadId(row.conversation_id) !== row.conversation_id);
}

/**
 * One entry per durable, exact-resume conversation. Historical rows that never
 * received a conversation ID are kept for telemetry and archives, but are not
 * offered as Recent: opening Codex's broad picker cannot safely identify which
 * conversation the row meant and was the source of duplicate/wrong resumes.
 */
export function pastSessions(limit = 40, projectId?: string | null): PastSession[] {
  try { if (codexIdentityRepairPending()) backfillCodexThreadIds(); }
  catch (e) { console.warn('[wanigan] Codex session identity backfill skipped:', e); }
  // Exited tabs can remain open for inspection, but they have no writer. Hiding
  // them from Recent made a completed conversation disappear until the person
  // manually closed its tab, despite being perfectly safe to resume.
  const openIds = liveSessions().ids();
  // The fifteen columns Recent reads, not `SELECT *`: a row also carries the
  // initial prompt and three JSON blobs (capabilities, baseline dirty set,
  // provider profile) that nothing below touches, and this reads every
  // execution ever recorded.
  //
  // The row set stays unbounded on purpose. The cap further down is per
  // section and pins deliberately survive it, and `continuationCount` is the
  // number the Forget tooltip promises to delete — a SQL LIMIT or a date
  // window would drop the pinned conversation the pin exists for and turn a
  // stated count into an estimate.
  const rows = db().prepare(`
    SELECT id, conversation_id, provider_id, harness_id, project_id, project_path, project_name,
           worktree, model, effort, permission_mode, started_at, ended_at, exit_code, title
      FROM session_log
     WHERE origin = 'wanigan'
     ORDER BY started_at DESC
  `).all() as SessionLogRow[];
  const newest = new Map<string, SessionLogRow>();
  const counts = new Map<string, number>();
  const openLineages = new Set<string>();
  for (const row of rows) {
    const conversationId = savedConversationId(row);
    if (!conversationId) continue;
    const key = conversationKey(row, conversationId);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (!newest.has(key)) newest.set(key, row); // query is newest first
    if (openIds.has(String(row.id))) openLineages.add(key);
  }

  // Lifecycle flags are presentation state; a broken read costs ordering,
  // never the list itself.
  const flags = new Map<string, { pinnedAt: number | null; settledAt: number | null }>();
  try {
    const flagRows = db().prepare('SELECT key, pinned_at, settled_at FROM conversation_flags')
      .all() as Array<{ key: string; pinned_at: number | null; settled_at: number | null }>;
    for (const f of flagRows) {
      flags.set(String(f.key), {
        pinnedAt: f.pinned_at == null ? null : Number(f.pinned_at),
        settledAt: f.settled_at == null ? null : Number(f.settled_at),
      });
    }
  } catch { /* pre-migration database during quit */ }
  const flagsOf = (key: string) => flags.get(key) ?? { pinnedAt: null, settledAt: null };

  const entries = [...newest.entries()]
    // A failed duplicate launch can be newer than the still-running writer.
    // Exclude a conversation whenever any execution of it is currently live.
    .filter(([key, row]) => !openLineages.has(key) && (projectId == null || row.project_id === projectId));
  // Pins survive the cap — a pinned conversation that ages past forty newer
  // ones is exactly the one the pin exists to keep. The other sections are
  // capped separately so the settled shelf cannot crowd out active rows.
  const pinned = entries.filter(([key]) => flagsOf(key).pinnedAt != null);
  const active = entries.filter(([key]) => flagsOf(key).pinnedAt == null && flagsOf(key).settledAt == null).slice(0, limit);
  const settled = entries.filter(([key]) => flagsOf(key).pinnedAt == null && flagsOf(key).settledAt != null).slice(0, limit);

  const shown = [...pinned, ...active, ...settled];
  // Deliberately after the cap: this is the only part of Recent that touches
  // the filesystem per row, and reading a name for all 154 conversations ever
  // recorded to show forty of them would be work nobody sees.
  const read = readTitles(shown);

  return shown
    .map(([key, r]) => ({
      id: String(r.id),
      conversationId: savedConversationId(r),
      providerId: String(r.provider_id) as PastSession['providerId'],
      projectId: r.project_id ? String(r.project_id) : null,
      projectPath: String(r.project_path),
      projectName: String(r.project_name),
      worktree: r.worktree ? String(r.worktree) : null,
      model: r.model ? String(r.model) : null,
      effort: r.effort ? String(r.effort) : null,
      permissionMode: r.permission_mode ? String(r.permission_mode) : null,
      startedAt: Number(r.started_at),
      endedAt: r.ended_at ? Number(r.ended_at) : null,
      exitCode: r.exit_code === null ? null : Number(r.exit_code),
      continuationCount: counts.get(key) ?? 1,
      live: fs.existsSync(String(r.project_path)),
      pinnedAt: flagsOf(key).pinnedAt,
      settledAt: flagsOf(key).settledAt,
      title: r.title ? String(r.title) : read.get(String(r.id))?.title ?? null,
      titleSource: r.title ? 'named' : read.get(String(r.id))?.source ?? null,
    }));
}

/**
 * A name for each conversation about to be shown, from the agent's own record.
 *
 * Neither harness is asked for anything and no model is paid: Claude Code
 * already writes an `ai-title` into its transcript, and both record the prompt
 * the person typed. This only reads what is there, so a conversation that kept
 * no such record keeps its null and renders exactly as it did before.
 *
 * Codex ids are resolved in one batch, because the fallback when Codex's state
 * index cannot answer is a walk of its sessions tree, and asking once per row
 * would walk that same tree once per row. A row already renamed by hand is
 * skipped entirely — that name wins, so reading a second one is wasted work.
 *
 * Every read is guarded. A name is presentation; a transcript that has been
 * deleted, truncated or is being written to right now costs this row its title
 * and never the list.
 */
function readTitles(shown: Array<[string, SessionLogRow]>): Map<string, NonNullable<ReadTitle>> {
  const out = new Map<string, NonNullable<ReadTitle>>();
  const codex = new Map<string, string>(); // thread id → session_log row id
  for (const [, r] of shown) {
    if (r.title) continue;
    const conversationId = savedConversationId(r);
    if (!conversationId) continue;
    if (harnessOf(r) === 'codex') {
      codex.set(conversationId.toLowerCase(), String(r.id));
      continue;
    }
    try {
      const found = conversationTitle(String(r.project_path), conversationId,
        typeof r.worktree === 'string' && r.worktree ? r.worktree : null);
      if (found) out.set(String(r.id), found);
    } catch { /* unnamed is the honest fallback */ }
  }
  if (codex.size) {
    try {
      const paths = codexRolloutFiles([...codex.keys()]);
      for (const [threadId, rowId] of codex) {
        const file = paths.get(threadId);
        const found = file ? titleFromTranscript(file) : null;
        if (found) out.set(rowId, found);
      }
    } catch { /* Codex's index is optional, and so is a name */ }
  }
  return out;
}

/**
 * The name a session wears, from the launch prompt it was started with. First
 * line only, whitespace collapsed — a sentence is a name, a pasted diff is
 * not. The prompt was redacted before it was stored, so the title is too.
 */
export function deriveSessionTitle(initialPrompt: string | null): string | null {
  if (!initialPrompt) return null;
  const line = initialPrompt.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const compact = line.replace(/\s+/g, ' ').trim();
  if (!compact) return null;
  return compact.length > 80 ? `${compact.slice(0, 79)}…` : compact;
}

/** Renaming is durable: it writes the row, not a per-machine label. */
export function renameSession(id: string, rawTitle: unknown): boolean {
  if (typeof rawTitle !== 'string') throw new Error('A session name must be text.');
  const title = rawTitle.replace(/\s+/g, ' ').trim().slice(0, 120) || null;
  const res = db().prepare("UPDATE session_log SET title = ? WHERE id = ? AND origin = 'wanigan'").run(title, id);
  const renamed = liveSessions().setDisplayTitle(id, title);
  if (!res.changes && !renamed) {
    throw new Error('That session is no longer recorded, so it cannot be renamed.');
  }
  return true;
}

/**
 * Pin keeps a conversation above the fold; settle parks it in the shelf.
 * The two are exclusive by rule — "done" beats "keep on top" — so setting one
 * clears the other, and clearing both deletes the row rather than leaving a
 * flag that says nothing.
 */
export function setConversationFlag(id: string, flag: 'pin' | 'settle', on: boolean): PastSession[] {
  const row = db().prepare(`
    SELECT id, conversation_id, provider_id, harness_id
      FROM session_log
     WHERE id = ? AND origin = 'wanigan'
  `).get(id) as { conversation_id: string | null; provider_id: string; harness_id: string | null } | undefined;
  if (!row) throw new Error('That conversation is no longer recorded, so it cannot be pinned or settled.');
  const conversationId = typeof row.conversation_id === 'string' && row.conversation_id.trim()
    ? row.conversation_id
    : null;
  if (!conversationId) throw new Error('Only a resumable conversation can be pinned or settled.');
  const key = conversationKey(row, conversationId);

  const existing = db().prepare('SELECT pinned_at, settled_at FROM conversation_flags WHERE key = ?')
    .get(key) as { pinned_at: number | null; settled_at: number | null } | undefined;
  let pinnedAt = existing?.pinned_at ?? null;
  let settledAt = existing?.settled_at ?? null;
  const now = Date.now();
  if (flag === 'pin') {
    pinnedAt = on ? now : null;
    if (on) settledAt = null;
  } else {
    settledAt = on ? now : null;
    if (on) pinnedAt = null;
  }
  if (pinnedAt === null && settledAt === null) {
    db().prepare('DELETE FROM conversation_flags WHERE key = ?').run(key);
  } else {
    db().prepare(`
      INSERT INTO conversation_flags (key, pinned_at, settled_at) VALUES (?,?,?)
      ON CONFLICT(key) DO UPDATE SET pinned_at = excluded.pinned_at, settled_at = excluded.settled_at
    `).run(key, pinnedAt, settledAt);
  }
  return pastSessions();
}

export function forgetPastSession(id: string) {
  const row = db().prepare(`
    SELECT id, conversation_id, provider_id, harness_id
      FROM session_log
     WHERE id = ? AND origin = 'wanigan'
  `).get(id) as {
    conversation_id: string | null;
    provider_id: string;
    harness_id: string | null;
  } | undefined;
  if (!row) return;
  const conversationId = typeof row.conversation_id === 'string' && row.conversation_id.trim()
    ? row.conversation_id
    : null;
  if (!conversationId) {
    db().prepare('DELETE FROM session_log WHERE id = ?').run(id);
    forgetSessionCheckpoints(id);
    return;
  }
  // Reuse the exact grouping rule from Recent. In particular, an old Codex
  // root has no `harness_id` while its later continuations do; SQL predicates
  // that only inspect one spelling leave a ghost card behind after Forget.
  const key = conversationKey(row, conversationId);
  const candidates = db().prepare(`
    SELECT id, conversation_id, provider_id, harness_id
      FROM session_log
     WHERE origin = 'wanigan' AND conversation_id = ?
  `).all(conversationId) as SessionLogRow[];
  const ids = candidates
    .filter((candidate) => conversationKey(candidate, conversationId) === key)
    .map((candidate) => String(candidate.id));
  if (!ids.length) return;
  const remove = db().prepare('DELETE FROM session_log WHERE id = ?');
  db().transaction(() => {
    for (const candidateId of ids) remove.run(candidateId);
  })();
  // Forgetting a conversation forgets its evidence chain too: rows and the
  // hidden ref for every execution record that just left Recent — and its
  // lifecycle flag, which would otherwise sit keyed to nothing forever.
  for (const candidateId of ids) forgetSessionCheckpoints(candidateId);
  try { db().prepare('DELETE FROM conversation_flags WHERE key = ?').run(key); } catch { /* flag rows are advisory */ }
}

/**
 * The launch snapshot for a session, live or historical.
 *
 * The in-memory copy is the fast path, but a baseline that exists only in this
 * process answers "undo what this agent did" with "this session has no baseline
 * commit" after every restart — and loses the dirty list, which is what keeps
 * edits the operator had already made from being offered as the agent's work.
 */
export function sessionBaseline(sessionId: string): Baseline | null {
  const live = liveSessions().baseline(sessionId);
  if (live) return live;
  let row: { baseline_head: string | null; baseline_dirty_json: string | null; started_at: number } | undefined;
  try {
    row = db().prepare(
      'SELECT baseline_head, baseline_dirty_json, started_at FROM session_log WHERE id = ?'
    ).get(sessionId) as typeof row;
  } catch { return null; /* the database is closing during quit */ }
  if (!row) return null;
  // A row written before these columns existed captured nothing. Answering it
  // with an empty dirty list would claim every pre-existing edit for the agent,
  // so an absent capture stays absent rather than becoming a confident zero.
  if (row.baseline_head === null && row.baseline_dirty_json === null) return null;
  let dirty: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.baseline_dirty_json ?? '[]');
    if (Array.isArray(parsed)) dirty = parsed.filter((value): value is string => typeof value === 'string');
  } catch { /* a corrupt list costs attribution, not the head commit a revert needs */ }
  // `started_at` is the launch stamp rather than the capture stamp; they are
  // milliseconds apart and no reader distinguishes them.
  return { head: row.baseline_head, dirty, at: row.started_at };
}
