import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { db } from './db';

const MATCH_WINDOW_MS = 5_000;
const FIRST_LINE_CAP = 2 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const rolloutDirCache = new Map<string, {
  mtimeMs: number;
  readAt: number;
  threads: CodexThreadCandidate[];
}>();

export type CodexThreadCandidate = {
  id: string;
  cwd: string;
  createdAt: number;
  rolloutPath: string | null;
};

export type CodexSessionCandidate = {
  id: string;
  cwd: string;
  startedAt: number;
};

/**
 * A durable Codex thread that was verified against both of Codex's local
 * records.  This is deliberately narrower than a Recent row: an explicit
 * recovery must prove the exact UUID and its directory before a new writer is
 * ever started.
 */
export type ExactCodexThread = {
  id: string;
  /** Canonical directory from both state_5.sqlite and session_meta. */
  cwd: string;
  rolloutPath: string;
};

type SessionRow = {
  id: string;
  conversation_id: string | null;
  provider_id: string;
  project_path: string;
  worktree: string | null;
  started_at: number;
  resumed_from: string | null;
  harness_id: string | null;
};

function codexHome(): string {
  return process.env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex');
}

/** A recovery id is data, never a CLI fragment. */
export function normalizeCodexThreadId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const id = value.trim().toLowerCase();
  return UUID.test(id) ? id : null;
}

/** Exact recovery requires an existing path; resolving a missing spelling is not proof of ownership. */
function canonicalExistingPath(value: string): string | null {
  try { return fs.realpathSync.native(value); }
  catch { return null; }
}

function sameCwd(a: string, b: string): boolean {
  const canonical = (value: string): string => {
    try { return fs.realpathSync.native(value); }
    catch {
      try { return path.resolve(value); }
      catch { return value; }
    }
  };
  return canonical(a) === canonical(b);
}

function isInside(root: string, child: string): boolean {
  const relative = path.relative(root, child);
  return Boolean(relative) && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

/** Read exactly the trusted identity record, never an arbitrary later rollout event. */
function rolloutSessionMeta(file: string): { id: string; cwd: string } | null {
  const line = firstLine(file);
  if (!line) return null;
  try {
    const raw = JSON.parse(line) as {
      type?: string;
      payload?: {
        id?: string; session_id?: string; cwd?: string;
        source?: string; thread_source?: string;
      };
    };
    if (raw.type !== 'session_meta' || !raw.payload?.source?.trim()) return null;
    if (raw.payload.thread_source && raw.payload.thread_source !== 'user') return null;
    const id = normalizeCodexThreadId(raw.payload.id ?? raw.payload.session_id);
    const cwd = raw.payload.cwd ? canonicalExistingPath(raw.payload.cwd) : null;
    return id && cwd ? { id, cwd } : null;
  } catch {
    return null;
  }
}

/**
 * Validate a user-selected Codex UUID without modifying Codex state or Wanigan
 * history.  State_5 is the local durable index; its rollout must then contain
 * a matching session_meta record in the exact same canonical directory.
 */
export function validateExactCodexThread(threadId: unknown, selectedProjectPath: string): ExactCodexThread {
  const id = normalizeCodexThreadId(threadId);
  if (!id) throw new Error('Paste the complete Codex conversation UUID; Wanigan will not guess a recent thread.');
  const projectCwd = canonicalExistingPath(selectedProjectPath);
  if (!projectCwd) throw new Error('The selected project folder no longer exists. Choose its current folder first.');

  const candidate = stateThreadByExactId(id);
  if (!candidate?.rolloutPath) {
    throw new Error('Codex did not confirm that UUID in its local state index. Wanigan did not open a different conversation.');
  }
  const stateCwd = canonicalExistingPath(candidate.cwd);
  if (!stateCwd) {
    throw new Error('Codex recorded a folder for that conversation which is no longer available. Wanigan did not resume it elsewhere.');
  }
  const sessionsRoot = canonicalExistingPath(path.join(codexHome(), 'sessions'));
  const rolloutPath = canonicalExistingPath(candidate.rolloutPath);
  if (!sessionsRoot || !rolloutPath || !isInside(sessionsRoot, rolloutPath)) {
    throw new Error('Codex provided an invalid local rollout for that conversation. Wanigan left it untouched.');
  }
  try {
    if (!fs.statSync(rolloutPath).isFile()) throw new Error('not a file');
  } catch {
    throw new Error('Codex’s saved rollout for that conversation is unavailable. Wanigan left it untouched.');
  }
  const meta = rolloutSessionMeta(rolloutPath);
  if (!meta || meta.id !== id || meta.cwd !== stateCwd) {
    throw new Error('Codex’s state index and saved session metadata disagree for that UUID. Wanigan will not resume it.');
  }
  if (stateCwd !== projectCwd) {
    throw new Error('That Codex conversation belongs to a different folder. Select its exact project folder before recovering it.');
  }
  return { id, cwd: stateCwd, rolloutPath };
}

/**
 * Codex leaves zero-byte lock files behind after a writer exits, so existence
 * alone is meaningless.  lsof lets us distinguish a stale file from a file
 * held open by a live Codex writer.  If that check cannot run, fail closed:
 * launching a second writer is worse than asking the operator to retry.
 */
export function assertCodexThreadWriterUnlocked(threadId: unknown): void {
  const id = normalizeCodexThreadId(threadId);
  if (!id) throw new Error('The Codex conversation UUID is invalid.');
  const lock = path.join(codexHome(), 'thread-writer-locks', `${id}.lock`);
  if (!fs.existsSync(lock)) return;
  const lsof = process.platform === 'darwin' ? '/usr/sbin/lsof' : '/usr/bin/lsof';
  if (!fs.existsSync(lsof)) {
    throw new Error('Wanigan could not verify Codex’s writer lock, so it did not start a second writer.');
  }
  try {
    const output = execFileSync(lsof, ['-n', '-F', 'p', '--', lock], {
      encoding: 'utf8', timeout: 2_000, maxBuffer: 64 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const pids = output.split(/\r?\n/)
      .map((line) => /^p(\d+)$/.exec(line)?.[1] ?? null)
      .filter((pid): pid is string => pid !== null);
    if (pids.length) {
      throw new Error('That Codex conversation already has an active writer. Keep using its existing session; Wanigan did not open a duplicate.');
    }
  } catch (error) {
    const status = (error as { status?: number } | null)?.status;
    // lsof exits 1 when no process has the path open. A stale lock file is safe.
    if (status === 1) return;
    if (error instanceof Error && error.message.includes('already has an active writer')) throw error;
    throw new Error('Wanigan could not verify Codex’s writer lock, so it did not start a second writer.');
  }
}

/**
 * One-to-one nearest-time matching. Equal best deltas are ambiguous and stay
 * unresolved; choosing one would be another spelling of `resume --last`.
 */
export function matchCodexThreads(
  sessions: CodexSessionCandidate[],
  threads: CodexThreadCandidate[],
  alreadyClaimed: ReadonlySet<string> = new Set(),
  windowMs = MATCH_WINDOW_MS,
): Map<string, string> {
  const out = new Map<string, string>();
  let remainingSessions = [...sessions]
    .sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
  let remainingThreads = threads
    .filter((thread) => !alreadyClaimed.has(thread.id))
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));

  // Accept only mutual unique-nearest pairs. Remove accepted pairs and repeat,
  // allowing two close launches to disentangle without letting the earlier
  // Wanigan row greedily steal the later row's only plausible Codex thread.
  for (;;) {
    const nearestThread = new Map<string, string>();
    for (const session of remainingSessions) {
      const choices = remainingThreads
        .filter((thread) => sameCwd(thread.cwd, session.cwd)
          && Math.abs(thread.createdAt - session.startedAt) <= windowMs)
        .map((thread) => ({ id: thread.id, delta: Math.abs(thread.createdAt - session.startedAt) }))
        .sort((a, b) => a.delta - b.delta || a.id.localeCompare(b.id));
      if (choices[0] && (!choices[1] || choices[0].delta !== choices[1].delta)) {
        nearestThread.set(session.id, choices[0].id);
      }
    }

    const nearestSession = new Map<string, string>();
    for (const thread of remainingThreads) {
      const choices = remainingSessions
        .filter((session) => sameCwd(thread.cwd, session.cwd)
          && Math.abs(thread.createdAt - session.startedAt) <= windowMs)
        .map((session) => ({ id: session.id, delta: Math.abs(thread.createdAt - session.startedAt) }))
        .sort((a, b) => a.delta - b.delta || a.id.localeCompare(b.id));
      if (choices[0] && (!choices[1] || choices[0].delta !== choices[1].delta)) {
        nearestSession.set(thread.id, choices[0].id);
      }
    }

    const pairs = remainingSessions.flatMap((session) => {
      const threadId = nearestThread.get(session.id);
      return threadId && nearestSession.get(threadId) === session.id
        ? [{ sessionId: session.id, threadId }]
        : [];
    });
    if (!pairs.length) break;
    const matchedSessions = new Set(pairs.map((pair) => pair.sessionId));
    const matchedThreads = new Set(pairs.map((pair) => pair.threadId));
    for (const pair of pairs) out.set(pair.sessionId, pair.threadId);
    remainingSessions = remainingSessions.filter((session) => !matchedSessions.has(session.id));
    remainingThreads = remainingThreads.filter((thread) => !matchedThreads.has(thread.id));
  }
  return out;
}

function stateThreads(): CodexThreadCandidate[] | null {
  const file = path.join(codexHome(), 'state_5.sqlite');
  let state: Database.Database | null = null;
  try {
    state = new Database(file, { readonly: true, fileMustExist: true, timeout: 1000 });
    const columns = new Set((state.prepare('PRAGMA table_info(threads)').all() as { name: string }[])
      .map((column) => column.name));
    if (!['id', 'cwd', 'source'].every((name) => columns.has(name))) return null;
    const at = columns.has('created_at_ms') && columns.has('created_at')
      ? 'COALESCE(NULLIF(created_at_ms, 0), created_at * 1000)'
      : columns.has('created_at_ms')
        ? 'created_at_ms'
        : columns.has('created_at') ? 'created_at * 1000' : null;
    if (!at) return null;
    const rollout = columns.has('rollout_path') ? 'rollout_path' : 'NULL';
    const topLevel = columns.has('thread_source') ? "AND thread_source = 'user'" : '';
    const rows = state.prepare(`
      SELECT id, cwd, ${at} AS created_at_ms, ${rollout} AS rollout_path
      FROM threads WHERE source = 'cli' ${topLevel}
    `).all() as Array<{
      id: string; cwd: string; created_at_ms: number; rollout_path: string | null;
    }>;
    return rows
      .filter((row) => UUID.test(row.id) && row.cwd && Number.isFinite(Number(row.created_at_ms)))
      .map((row) => ({
        id: row.id,
        cwd: row.cwd,
        createdAt: Number(row.created_at_ms),
        rolloutPath: row.rollout_path || null,
      }));
  } catch {
    return null;
  } finally {
    try { state?.close(); } catch { /* read-only compatibility fallback */ }
  }
}

/**
 * Exact recovery is user-directed, so it may legitimately target a conversation
 * first opened by the VS Code extension rather than a CLI-rooted Wanigan row.
 * Unlike historical backfill, it does not infer anything by time: it reads one
 * requested id from state_5, requires a top-level user thread, and then makes
 * the rollout session_meta prove the same id and CWD below.
 */
function stateThreadByExactId(id: string): CodexThreadCandidate | null {
  const file = path.join(codexHome(), 'state_5.sqlite');
  let state: Database.Database | null = null;
  try {
    state = new Database(file, { readonly: true, fileMustExist: true, timeout: 1000 });
    const columns = new Set((state.prepare('PRAGMA table_info(threads)').all() as { name: string }[])
      .map((column) => column.name));
    if (!['id', 'cwd', 'rollout_path', 'source'].every((name) => columns.has(name))) return null;
    const topLevel = columns.has('thread_source') ? "AND thread_source = 'user'" : '';
    const row = state.prepare(`
      SELECT id, cwd, rollout_path, source
        FROM threads
       WHERE id = ? COLLATE NOCASE ${topLevel}
    `).get(id) as {
      id: string; cwd: string; rollout_path: string | null; source: string | null;
    } | undefined;
    if (!row || !UUID.test(row.id) || !row.cwd || !row.rollout_path || !row.source?.trim()) return null;
    return { id: row.id, cwd: row.cwd, createdAt: 0, rolloutPath: row.rollout_path };
  } catch {
    return null;
  } finally {
    try { state?.close(); } catch { /* read-only compatibility fallback */ }
  }
}

/**
 * Resolve an exact Codex thread id to its local rollout.  The Codex state
 * database is its own durable index and is safer and faster than guessing a
 * date-shaped filename.  A partial or unavailable state database simply
 * leaves that thread unmetered; it never guesses another conversation.
 */
export function codexRolloutPaths(ids: readonly string[]): Map<string, string> {
  const wanted = new Set(ids.map((id) => id.toLowerCase()).filter((id) => UUID.test(id)));
  const out = new Map<string, string>();
  if (!wanted.size) return out;
  for (const thread of stateThreads() ?? []) {
    const id = thread.id.toLowerCase();
    if (wanted.has(id) && thread.rolloutPath && fs.existsSync(thread.rolloutPath)) {
      out.set(id, thread.rolloutPath);
    }
  }
  return out;
}

function localDateDir(at: number): string {
  const d = new Date(at);
  const y = String(d.getFullYear());
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return path.join(codexHome(), 'sessions', y, m, day);
}

function firstLine(file: string): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const parts: Buffer[] = [];
    let total = 0;
    while (total < FIRST_LINE_CAP) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, FIRST_LINE_CAP - total));
      const read = fs.readSync(fd, chunk, 0, chunk.length, total);
      if (!read) break;
      const used = chunk.subarray(0, read);
      const nl = used.indexOf(0x0a);
      parts.push(nl >= 0 ? used.subarray(0, nl) : used);
      total += nl >= 0 ? nl : read;
      if (nl >= 0) break;
    }
    return Buffer.concat(parts).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch { /* already closed */ }
  }
}

function rolloutThreads(around: number[]): CodexThreadCandidate[] {
  const dirs = new Set<string>();
  for (const at of around) {
    dirs.add(localDateDir(at - 86_400_000));
    dirs.add(localDateDir(at));
    dirs.add(localDateDir(at + 86_400_000));
  }
  const out = new Map<string, CodexThreadCandidate>();
  for (const dir of dirs) {
    let mtimeMs: number;
    try { mtimeMs = fs.statSync(dir).mtimeMs; } catch { continue; }
    const cached = rolloutDirCache.get(dir);
    if (cached && cached.mtimeMs === mtimeMs && Date.now() - cached.readAt < 1000) {
      for (const thread of cached.threads) out.set(thread.id, thread);
      continue;
    }
    let names: string[];
    try { names = fs.readdirSync(dir); } catch { continue; }
    const inDir: CodexThreadCandidate[] = [];
    for (const name of names) {
      if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue;
      const file = path.join(dir, name);
      const line = firstLine(file);
      if (!line) continue;
      try {
        const raw = JSON.parse(line) as {
          type?: string;
          payload?: {
            id?: string; session_id?: string; cwd?: string; timestamp?: string;
            source?: string; thread_source?: string;
          };
        };
        if (raw.type !== 'session_meta' || raw.payload?.source !== 'cli') continue;
        if (raw.payload.thread_source && raw.payload.thread_source !== 'user') continue;
        const id = raw.payload.id ?? raw.payload.session_id ?? '';
        const createdAt = Date.parse(raw.payload.timestamp ?? '');
        if (!UUID.test(id) || !raw.payload.cwd || !Number.isFinite(createdAt)) continue;
        const thread = { id, cwd: raw.payload.cwd, createdAt, rolloutPath: file };
        out.set(id, thread);
        inDir.push(thread);
      } catch { /* malformed/partial rollout is not a resumable identity */ }
    }
    rolloutDirCache.set(dir, { mtimeMs, readAt: Date.now(), threads: inDir });
  }
  return [...out.values()];
}

function codexRows(): SessionRow[] {
  return db().prepare(`
    SELECT id, conversation_id, provider_id, project_path, worktree, started_at,
           resumed_from, harness_id
    FROM session_log
    WHERE origin = 'wanigan' AND (harness_id = 'codex' OR provider_id = 'codex')
    ORDER BY started_at ASC
  `).all() as SessionRow[];
}

function validConversationId(value: string | null): string | null {
  return value && UUID.test(value) ? value.toLowerCase() : null;
}

function lineageComponents(rows: SessionRow[]): SessionRow[][] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const links = new Map(rows.map((row) => [row.id, new Set<string>()]));
  for (const row of rows) {
    if (!row.resumed_from || !byId.has(row.resumed_from)) continue;
    links.get(row.id)?.add(row.resumed_from);
    links.get(row.resumed_from)?.add(row.id);
  }
  const seen = new Set<string>();
  const out: SessionRow[][] = [];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    const component: SessionRow[] = [];
    const pending = [row.id];
    seen.add(row.id);
    while (pending.length) {
      const id = pending.pop()!;
      const found = byId.get(id);
      if (found) component.push(found);
      for (const neighbor of links.get(id) ?? []) {
        if (seen.has(neighbor)) continue;
        seen.add(neighbor);
        pending.push(neighbor);
      }
    }
    out.push(component);
  }
  return out;
}

/** A resume lineage has one identity or none; conflicting IDs are not guessed. */
function propagateUniqueLineageIds(rows: SessionRow[]): Set<string> {
  const conflicted = new Set<string>();
  for (const component of lineageComponents(rows)) {
    const ids = new Set(component.flatMap((row) => {
      const id = validConversationId(row.conversation_id);
      return id ? [id] : [];
    }));
    if (ids.size > 1) {
      for (const row of component) conflicted.add(row.id);
      continue;
    }
    if (ids.size !== 1) continue;
    const id = [...ids][0];
    for (const row of component) {
      if (!validConversationId(row.conversation_id)) row.conversation_id = id;
    }
  }
  return conflicted;
}

/** Backfill legacy rows and propagate the exact UUID through resume lineages. */
export function backfillCodexThreadIds(): number {
  const rows = codexRows();
  if (!rows.length) return 0;
  const original = new Map(rows.map((row) => [row.id, row.conversation_id]));
  const conflicted = propagateUniqueLineageIds(rows);

  const claimed = new Set(rows.flatMap((row) => {
    const id = validConversationId(row.conversation_id);
    return id ? [id] : [];
  }));
  let roots = rows.filter((row) => !conflicted.has(row.id)
    && !validConversationId(row.conversation_id) && !row.resumed_from);
  const applyMatches = (threads: CodexThreadCandidate[]): void => {
    if (!roots.length || !threads.length) return;
    const matches = matchCodexThreads(
      roots.map((row) => ({ id: row.id, cwd: row.worktree ?? row.project_path, startedAt: row.started_at })),
      threads,
      claimed,
    );
    for (const row of roots) {
      const id = matches.get(row.id);
      if (!id) continue;
      row.conversation_id = id;
      claimed.add(id);
    }
    roots = roots.filter((row) => !validConversationId(row.conversation_id));
  };

  // Codex's read-only SQLite projection is cheap and current. Only fall back
  // to adjacent-date rollout metadata for roots the projection did not match.
  applyMatches(stateThreads() ?? []);
  if (roots.length) {
    applyMatches(rolloutThreads(roots.map((row) => row.started_at)));
  }
  propagateUniqueLineageIds(rows);

  const updates = rows.filter((row) => {
    const repaired = validConversationId(row.conversation_id);
    return repaired && repaired !== validConversationId(original.get(row.id) ?? null);
  });
  if (!updates.length) return 0;
  const statement = db().prepare('UPDATE session_log SET conversation_id = ? WHERE id = ?');
  const apply = db().transaction(() => {
    let count = 0;
    for (const row of updates) count += statement.run(row.conversation_id, row.id).changes;
    return count;
  });
  return apply();
}

export function codexThreadIdForSession(sessionId: string): string | null {
  try { backfillCodexThreadIds(); } catch { /* caller gives the actionable failure */ }
  return storedCodexThreadId(sessionId);
}

function storedCodexThreadId(sessionId: string): string | null {
  const row = db().prepare(`
    SELECT conversation_id FROM session_log
    WHERE id = ? AND origin = 'wanigan' AND (harness_id = 'codex' OR provider_id = 'codex')
  `).get(sessionId) as
    { conversation_id: string | null } | undefined;
  return validConversationId(row?.conversation_id ?? null);
}

/**
 * Persist a newly-created thread as soon as Codex has actually made it.
 *
 * Interactive Codex defers creating its rollout and state-index entry until
 * the first submitted prompt.  A terminal can therefore sit at its welcome
 * screen for minutes with no UUID to discover.  `backfillCodexThreadIds()`
 * intentionally matches launch time, which is right for historical imports
 * but cannot see a thread born well after the terminal.  This narrow matcher
 * is called at the prompt boundary instead: it accepts only one same-directory
 * top-level CLI thread created right then, and otherwise leaves the row
 * unresolved rather than associating unrelated work.
 */
export function captureNewCodexThreadId(
  sessionId: string,
  cwd: string,
  promptAt: number,
  windowMs = MATCH_WINDOW_MS,
  sessionStartedAt = promptAt,
): string | null {
  const existing = storedCodexThreadId(sessionId);
  if (existing) return existing;
  // Codex can reserve its durable thread while it draws the welcome screen,
  // then mark it as a user thread only after Enter. In that case its created
  // timestamp belongs to session startup, not the later prompt. Bound the
  // interval to this one terminal's lifetime; we still accept only one same-CWD
  // candidate, so concurrent launches never get guessed across each other.
  const start = Math.min(sessionStartedAt, promptAt) - Math.max(0, windowMs);
  const end = Math.max(sessionStartedAt, promptAt) + Math.max(0, windowMs);
  const candidates = (stateThreads() ?? rolloutThreads([sessionStartedAt, promptAt]))
    .filter((thread) => sameCwd(thread.cwd, cwd)
      && thread.createdAt >= start && thread.createdAt <= end);
  if (candidates.length !== 1) return null;
  const threadId = candidates[0].id;
  db().prepare('UPDATE session_log SET conversation_id = ? WHERE id = ? AND conversation_id IS NULL')
    .run(threadId, sessionId);
  return storedCodexThreadId(sessionId);
}

let discoveryQueue: Promise<void> = Promise.resolve();

/** Poll Codex's durable index until a just-launched root receives its UUID. */
export function discoverCodexThreadId(
  sessionId: string,
  _cwd: string,
  _startedAt: number,
  timeoutMs = 8_000,
): Promise<string | null> {
  let answer: string | null = null;
  const run = discoveryQueue.then(async () => {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    do {
      try { backfillCodexThreadIds(); } catch { /* state DB may be between migrations */ }
      answer = storedCodexThreadId(sessionId);
      if (answer) return;
      if (Date.now() >= deadline) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (!answer);
  });
  discoveryQueue = run.then(() => {}, () => {});
  return run.then(() => answer);
}
