// A project's History: every earlier Claude Code and Codex conversation in its
// folder and its card worktrees, read from where the CLIs keep them. Claude Code
// writes one transcript per conversation into the account folder it ran under;
// Codex indexes its threads in each home's state database. Wanigan's own
// sessions say which ran here. All of it is read; none of it is written.
//
// Measured on the owner's machine (Claude Code 2.1.292, Codex 0.155.1):
// - A transcript is filed under the folder the CLI started in, by `claudeSlug`.
//   The name is lossy, so the transcript's own cwd decides whose it is.
// - A fork (`--fork-session`) is a full copy with a new id. Copies share their
//   first user line's uuid, so they are one conversation; the newest is shown.
// - Codex Desktop imports Claude transcripts as threads, and subagents are
//   threads too. Only `thread_source = 'user'` threads are the owner's own.
// - Resuming re-sends the whole conversation and costs part of a plan, so it
//   happens only when the owner asks.
import { opendirSync, realpathSync, statSync, type Stats } from 'node:fs';
import { join } from 'node:path';
import { matchesHistory } from '../shared/history.ts';
import {
  LIVE_STATES, OWNER,
  type Account, type AccountProvider, type HistoryItem, type HistorySource, type HistoryTranscript, type Project, type Session, type SessionState,
} from '../shared/model.ts';
import { CoreError } from '../shared/protocol.ts';
import type { Accounts } from './accounts.ts';
import type { Board } from './board.ts';
import type { Ctx } from './context.ts';
import { readForeignDb, type ReadOnlyDb } from './readonly-db.ts';
import { LIVE_SQL } from './records.ts';
import type { Sessions } from './sessions.ts';
import { within } from './safe-fs.ts';
import { historyText, readTranscript, transcriptSummary, type Summary } from './history-transcript.ts';
import { HistoryCache, historyPayloadBytes } from './history-cache.ts';

const TITLE_CHARS = 90;
const PROMPT_CHARS = 280;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The folder name Claude Code files a directory's transcripts under, as Wanigan 1
 * read it out of the CLI: NFC, everything outside [a-zA-Z0-9] becomes '-', and a
 * name over 200 characters is cut and given a hash of the whole path.
 */
export function claudeSlug(path: string): string {
  const normalized = path.normalize('NFC');
  const slug = normalized.replace(/[^a-zA-Z0-9]/g, '-');
  if (slug.length <= 200) return slug;
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) hash = ((hash << 5) - hash + normalized.charCodeAt(i)) | 0;
  return `${slug.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
}

/** The folders a project's conversations ran in: the folder itself, and anything under its worktrees. */
interface Where { exact: Set<string>; worktrees: string[] }

/** A conversation where it lies on disk. */
interface Found extends Summary {
  provider: AccountProvider;
  conversationId: string;
  account: Account;
  /** The Claude transcript or Codex rollout. */
  file: string | null;
}

/** Logical discovery limits, not a wall-clock or total VM heap guarantee. */
export interface HistoryLimits {
  accounts: number; entries: number; rows: number; cellBytes: number; metadataBytes: number; databaseBytes: number; summaryBytes: number;
}
const HISTORY_LIMITS: Readonly<HistoryLimits> = {
  accounts: 128, entries: 65_536, rows: 32_768, cellBytes: 16 * 1024 * 1024,
  metadataBytes: 64 * 1024 * 1024, databaseBytes: 256 * 1024 * 1024, summaryBytes: 256 * 1024 * 1024,
};
interface DiscoveryCost { rows: number; metadataBytes: number; cellBytes: number }

/** One request owns its counters. Exhaustion never means a missing source. */
class HistoryBudget {
  private readonly used = { accounts: 0, entries: 0, rows: 0, metadataBytes: 0, databaseBytes: 0, summaryBytes: 0 };
  private failed = false;
  readonly limits: Readonly<HistoryLimits>;
  constructor(limits: Readonly<HistoryLimits>) { this.limits = limits; }
  assert(): void { if (this.failed) throw new CoreError('refused', 'History is too large to inspect safely'); }
  private refuse(): never { this.failed = true; throw new CoreError('refused', 'History is too large to inspect safely'); }
  add(kind: keyof HistoryBudget['used'], amount: number): void {
    if (!Number.isSafeInteger(amount) || amount < 0 || amount > this.limits[kind] - this.used[kind]) this.refuse();
    this.used[kind] += amount;
  }
  remaining(kind: 'accounts' | 'rows'): number { return this.limits[kind] - this.used[kind]; }
  admit(cost: DiscoveryCost, kind: 'accounts' | 'rows' = 'rows'): void {
    if (!Number.isSafeInteger(cost.cellBytes) || cost.cellBytes < 0 || cost.cellBytes > this.limits.cellBytes) this.refuse();
    this.add(kind, cost.rows); this.add('metadataBytes', cost.metadataBytes);
  }
  values(values: unknown[]): void {
    const sizes = values.map((v) => typeof v === 'string' ? Buffer.byteLength(v) * 2
      : ArrayBuffer.isView(v) ? v.buffer.byteLength : v === null || v === undefined ? 0 : 8);
    this.admit({ rows: 0, metadataBytes: sizes.reduce((a, b) => a + b, 0), cellBytes: Math.max(0, ...sizes) });
  }
}

/** Inspect scalar lengths before SQLite hands a potentially large cell to JS.
 * The private foreign DB is immutable during both passes. Own-store admission
 * runs synchronously; it does not exclude arbitrary external database writers. */
function admitQuery(db: ReadOnlyDb, sql: string, names: string[], params: unknown[], budget: HistoryBudget, kind: 'accounts' | 'rows' = 'rows'): DiscoveryCost {
  const quoted = (name: string): string => `"${name.replaceAll('"', '""')}"`;
  const measures = names.flatMap((name, i) => [`typeof(${quoted(name)}) AS t${i}`, `length(CAST(${quoted(name)} AS BLOB)) AS n${i}`]);
  const cost: DiscoveryCost = { rows: 0, metadataBytes: 0, cellBytes: 0 };
  const query = db.prepare(`SELECT ${measures.join(', ')} FROM (${sql}) LIMIT ?`);
  for (const raw of query.iterate(...params, budget.remaining(kind) + 1)) {
    const row = raw as Record<string, string | number | null>;
    let bytes = 0; let cell = 0;
    for (let i = 0; i < names.length; i++) {
      const type = row[`t${i}`]; const n = row[`n${i}`];
      const size = type === 'null' ? 0 : type === 'integer' || type === 'real' ? 8
        : typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n * (type === 'text' ? 2 : 1) : Infinity;
      bytes += size; cell = Math.max(cell, size);
    }
    budget.admit({ rows: 1, metadataBytes: bytes, cellBytes: cell }, kind);
    cost.rows++; cost.metadataBytes += bytes; cost.cellBytes = Math.max(cost.cellBytes, cell);
  }
  return cost;
}

/** Read only admitted schema names, never arbitrary PRAGMA default/type text. */
function schemaNames(db: ReadOnlyDb, table: string, budget: HistoryBudget): { names: Set<string>; cost: DiscoveryCost } {
  const cost: DiscoveryCost = { rows: 0, metadataBytes: 0, cellBytes: 0 };
  let count = 0;
  for (const raw of db.prepare('SELECT length(CAST(name AS BLOB)) AS bytes FROM pragma_table_info(?) LIMIT 2001').iterate(table)) {
    if (++count > 2000) budget.add('rows', budget.remaining('rows') + 1);
    const bytes = (raw as { bytes: number }).bytes * 2;
    budget.admit({ rows: 0, metadataBytes: bytes, cellBytes: bytes });
    cost.metadataBytes += bytes; cost.cellBytes = Math.max(cost.cellBytes, bytes);
  }
  const names = new Set<string>();
  for (const raw of db.prepare('SELECT name FROM pragma_table_info(?) LIMIT 2000').iterate(table)) names.add((raw as { name: string }).name);
  return { names, cost };
}

interface ThreadRow {
  id: string; cwd: string | null; rolloutPath: string | null; name: string | null; title: string | null; firstMessage: string | null;
  createdAt: number | null; updatedAt: number | null; branch: string | null; model: string | null; source: string | null; originator: string | null;
}

export class History {
  private readonly ctx: Ctx;
  private readonly board: Board;
  private readonly accounts: Accounts;
  private readonly sessions: Sessions;
  private readonly dataDir: string;
  private readonly limits: Readonly<HistoryLimits>;
  /** Retention limits never limit discovery, search or duplicate detection. */
  private readonly summaries = new HistoryCache<{ stamp: string; summary: Summary; readBytes: number }>({ entries: 512, units: 512, bytes: 2 * 1024 * 1024 });
  private readonly threads = new HistoryCache<{ stamp: string; rows: ThreadRow[]; cost: DiscoveryCost }>({ entries: 8, units: 4096, bytes: 8 * 1024 * 1024 });

  constructor(ctx: Ctx, board: Board, accounts: Accounts, sessions: Sessions, options: { dataDir: string; limits?: Partial<HistoryLimits> }) {
    this.ctx = ctx;
    this.board = board;
    this.accounts = accounts;
    this.sessions = sessions;
    this.dataDir = options.dataDir;
    this.limits = { ...HISTORY_LIMITS, ...options.limits };
    for (const key of Object.keys(HISTORY_LIMITS) as (keyof HistoryLimits)[]) {
      if (!Number.isSafeInteger(this.limits[key]) || this.limits[key] < 1 || this.limits[key] > HISTORY_LIMITS[key]) {
        throw new Error('History limits must be positive integers no larger than the defaults.');
      }
    }
  }

  list(projectId: string, options: { query?: string; limit?: number } = {}): HistoryItem[] {
    const budget = new HistoryBudget(this.limits);
    this.admitProjects('id = ?', [projectId], budget);
    const project = this.board.project(projectId);
    const accounts = this.historyAccounts(budget);
    const where = this.where(project);
    const slugs = new Set([...where.exact].map(claudeSlug));
    const prefixes = where.worktrees.map((w) => `${claudeSlug(w)}-`);
    const claude = this.claude(accounts, budget, (dir) => slugs.has(dir) || prefixes.some((p) => dir.startsWith(p)))
      .filter((f) => (f.title || f.firstPrompt) && (!f.cwd || inside(where, f.cwd)));
    const codex = this.codex(accounts, budget).filter((f) => f.cwd && inside(where, f.cwd));
    const runs = this.runs(project.id, budget);
    const limit = typeof options.limit === 'number' && options.limit > 0 ? Math.min(Math.round(options.limit), 2000) : 500;
    return [...newestCopies(claude), ...codex]
      .map((f) => this.item(f, where, runs.get(f.conversationId)))
      .filter((item) => !options.query || matchesHistory(item, options.query))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit);
  }

  read(id: string): HistoryTranscript {
    const budget = new HistoryBudget(this.limits);
    const found = this.locate(id, budget);
    if (!found.file) throw new CoreError('not_found', 'The record of this conversation is gone.');
    return readTranscript(found.file, found.provider);
  }

  /**
   * Continue a conversation in a new session, in the folder it ran in. In its
   * own account it is the same conversation. A Claude conversation continued as
   * another account is a fork: a copy with a new id, written under that account,
   * leaving the original as it was. Codex can only continue in its own home.
   */
  async resume(id: string, options: { accountId?: string | null; cols?: number; rows?: number } = {}): Promise<Session> {
    const budget = new HistoryBudget(this.limits);
    const found = this.locate(id, budget);
    if (options.accountId) admitQuery(this.ctx.db, 'SELECT * FROM accounts WHERE id = ?', [...schemaNames(this.ctx.db, 'accounts', budget).names], [options.accountId], budget);
    const target = options.accountId ? this.accounts.get(options.accountId) : found.account;
    if (target.provider !== found.provider) throw new CoreError('invalid', `That is a ${target.provider} account.`);
    const same = target.id === found.account.id;
    if (!same && found.provider === 'codex') {
      throw new CoreError('refused', `Codex continues a conversation only in the account it lives in, ${found.account.label}.`);
    }
    if (!same && !found.file) throw new CoreError('not_found', 'The record of this conversation is gone.');
    const at = this.projectAt(found.cwd, budget);
    if (!at) throw new CoreError('refused', 'This conversation ran in a folder that is gone or is not an open project.');
    if (this.ctx.db.prepare(`SELECT 1 FROM (SELECT conversation_id FROM sessions WHERE state IN (${LIVE_SQL}) ORDER BY started_at DESC LIMIT 300) WHERE conversation_id = ? LIMIT 1`).get(found.conversationId)) {
      throw new CoreError('refused', 'That conversation is already running in a session. Open it instead.');
    }
    const title = historyText(found.title ?? found.firstPrompt ?? 'Earlier conversation', 120) as string;
    const cardId = this.cardOf(at.project, at.cwd);
    const session = await this.sessions.start({
      projectId: at.project.id, provider: found.provider, accountId: target.id, title, cwd: at.cwd, cols: options.cols, rows: options.rows, cardId,
      ...(same ? { resume: found.conversationId, ...(found.provider === 'codex' && found.file ? { transcript: found.file } : {}) } : { fork: found.file as string }),
    });
    this.board.log({
      projectId: at.project.id, cardId, sessionId: session.id, actor: OWNER,
      verb: same ? 'resumed a conversation from History' : `continued a conversation as ${target.label}`, detail: title,
    });
    return session;
  }

  /**
   * The card whose worktree a conversation ran in, when carrying it on should
   * take that card again: as Resume in the session does, not a finished card,
   * nor one another session is live on.
   */
  private cardOf(project: Project, cwd: string): string | null {
    const root = join(this.dataDir, 'worktrees', project.id);
    if (!cwd.startsWith(`${root}/`)) return null;
    try {
      const card = this.board.card(cwd.slice(root.length + 1).split('/')[0] ?? '');
      if (card.projectId !== project.id || card.worktree?.path !== cwd) return null;
      return card.status === 'done' || card.status === 'archived' || card.live ? null : card.id;
    } catch {
      return null;
    }
  }

  /* ── where conversations are ──────────────────────────────────────────── */

  private where(project: Project): Where {
    const root = join(this.dataDir, 'worktrees', project.id);
    return { exact: new Set([project.path, real(project.path)]), worktrees: [...new Set([root, real(root)])] };
  }

  /** The open project a conversation's folder belongs to, and that folder as the project names it. */
  private projectAt(cwd: string | null, budget: HistoryBudget): { project: Project; cwd: string } | null {
    if (!cwd || !isDir(cwd)) return null;
    this.admitProjects('archived_at IS NULL', [], budget);
    const ids = this.ctx.db.prepare('SELECT id FROM projects WHERE archived_at IS NULL').all() as { id: string }[];
    for (const { id } of ids) {
      const project = this.board.project(id);
      const where = this.where(project);
      for (const path of new Set([cwd, real(cwd)])) {
        if (where.exact.has(path)) return { project, cwd: project.path };
        const root = where.worktrees.find((w) => path.startsWith(`${w}/`));
        if (root) return { project, cwd: join(this.dataDir, 'worktrees', project.id, path.slice(root.length + 1)) };
      }
    }
    return null;
  }

  private locate(id: string, budget: HistoryBudget): Found {
    const [provider, conversationId = ''] = typeof id === 'string' ? id.split(':') : [];
    if ((provider !== 'claude' && provider !== 'codex') || !UUID.test(conversationId)) throw new CoreError('invalid', 'That is not a conversation in History.');
    const accounts = this.historyAccounts(budget);
    const copies = provider === 'claude'
      ? this.claude(accounts, budget, () => true, `${conversationId}.jsonl`)
      : this.codex(accounts, budget).filter((f) => f.conversationId.toLowerCase() === conversationId.toLowerCase());
    if (copies.length > 1) throw new CoreError('refused', 'More than one account or folder has this conversation id. Wanigan cannot safely choose which copy to read or resume.');
    const found = copies[0];
    if (!found) throw new CoreError('not_found', 'Wanigan can’t find that conversation any more.');
    return found;
  }

  /** Claude transcripts in every Claude account, in project folders `dirOk` accepts. */
  private claude(accounts: Account[], budget: HistoryBudget, dirOk: (dir: string) => boolean, only?: string): Found[] {
    this.summaries.prune((file, cached) => {
      try { const stat = statSync(file); return stat.isFile() && metadataStamp(stat) === cached.stamp; }
      catch { return false; }
    });
    const out: Found[] = [];
    for (const account of accounts) {
      if (account.provider !== 'claude') continue;
      const home = this.accounts.folderOf(account);
      const projects = join(home, 'projects');
      for (const dir of entries(projects, budget)) {
        if (!dirOk(dir)) continue;
        for (const name of only ? [only] : entries(join(projects, dir), budget)) {
          if (!name.endsWith('.jsonl') || !UUID.test(name.slice(0, -6))) continue;
          const file = transcriptIn(home, join(projects, dir, name));
          if (!file) continue;
          budget.add('rows', 1);
          const summary = this.summary(file, budget);
          if (summary) out.push({ ...summary, provider: 'claude', conversationId: name.slice(0, -6), account, file });
        }
      }
    }
    return out;
  }

  private summary(file: string, budget: HistoryBudget): Summary | null {
    let stat;
    try { stat = statSync(file); } catch { this.summaries.delete(file); return null; }
    if (!stat.isFile()) { this.summaries.delete(file); return null; }
    const stamp = metadataStamp(stat);
    const cached = this.summaries.get(file);
    if (cached?.stamp === stamp) {
      budget.add('summaryBytes', cached.readBytes); budget.values(Object.values(cached.summary));
      return cached.summary;
    }
    try {
      let readBytes = 0;
      const summary = transcriptSummary(file, stat.size, stat.mtimeMs, (bytes) => { budget.add('summaryBytes', bytes); readBytes += bytes; });
      budget.values(Object.values(summary));
      this.summaries.set(file, { stamp, summary, readBytes }, 1, historyPayloadBytes([stamp, ...Object.values(summary)]));
      return summary;
    } catch {
      this.summaries.delete(file);
      budget.assert();
      return null;
    }
  }

  /** The owner's own Codex threads, in every Codex account. */
  private codex(accounts: Account[], budget: HistoryBudget): Found[] {
    this.threads.prune((file, cached) => {
      try { return stampOf(file) === cached.stamp; } catch { return false; }
    });
    const out: Found[] = [];
    for (const account of accounts) {
      if (account.provider !== 'codex') continue;
      const home = this.accounts.folderOf(account);
      for (const t of this.codexThreads(join(home, 'state_5.sqlite'), budget)) {
        const prompt = historyText(t.firstMessage, PROMPT_CHARS, true);
        out.push({
          provider: 'codex', conversationId: t.id, account,
          // The index is Codex's; a rollout path outside its home is not followed.
          file: transcriptIn(home, t.rolloutPath),
          title: historyText(t.name, TITLE_CHARS) ?? (t.title && t.title !== t.firstMessage ? historyText(t.title, TITLE_CHARS) : null),
          firstPrompt: prompt, startedAt: t.createdAt, updatedAt: t.updatedAt ?? t.createdAt ?? 0, cwd: t.cwd, branch: t.branch, model: t.model,
          via: t.source === 'vscode' ? 'VS Code' : t.source === 'exec' ? 'Headless' : /desktop/i.test(t.originator ?? '') ? 'Desktop' : null,
          lineage: t.id,
        });
      }
    }
    return out;
  }

  private codexThreads(file: string, budget: HistoryBudget): ThreadRow[] {
    let state;
    try { state = indexState(file); } catch (error) { this.threads.delete(file); throw error; }
    if (!state) { this.threads.delete(file); return []; }
    const { stamp, bytes } = state;
    budget.add('databaseBytes', bytes);
    const cached = this.threads.get(file);
    if (cached?.stamp === stamp) { budget.admit(cached.cost); return cached.rows; }
    this.threads.delete(file);
    let cost: DiscoveryCost = { rows: 0, metadataBytes: 0, cellBytes: 0 };
    let copied = 0;
    const rows = readForeignDb(file, (db) => {
      // Length admission and materialization are two passes over a stable table.
      // A view/virtual table can compute different or much larger values per pass.
      const table = db.prepare("SELECT type, rootpage FROM sqlite_schema WHERE name = 'threads' COLLATE NOCASE").get() as { type: string; rootpage: number } | undefined;
      if (table?.type !== 'table' || !Number.isSafeInteger(table.rootpage) || table.rootpage < 1) throw new Error('Unsupported Codex history index.');
      const schema = schemaNames(db, 'threads', budget);
      const cols = schema.names;
      if (!['id', 'cwd', 'thread_source'].every((c) => cols.has(c))) throw new Error('Unsupported Codex history index.');
      const col = (name: string, sql = name): string => (cols.has(name) ? sql : 'NULL');
      const sql = `SELECT id, cwd, ${col('rollout_path')} AS rolloutPath, ${col('name')} AS name, ${col('title')} AS title,
          ${col('first_user_message')} AS firstMessage, ${col('git_branch')} AS branch, ${col('model')} AS model,
          ${col('source')} AS source, ${col('originator')} AS originator,
          coalesce(${col('created_at_ms')}, ${col('created_at', 'created_at * 1000')}) AS createdAt,
          coalesce(${col('updated_at_ms')}, ${col('updated_at', 'updated_at * 1000')}) AS updatedAt
        FROM threads WHERE thread_source = 'user'${cols.has('archived') ? ' AND coalesce(archived, 0) = 0' : ''}`;
      const admitted = admitQuery(db, sql, ['id', 'cwd', 'rolloutPath', 'name', 'title', 'firstMessage', 'branch', 'model', 'source', 'originator', 'createdAt', 'updatedAt'], [], budget);
      cost = { rows: admitted.rows, metadataBytes: admitted.metadataBytes + schema.cost.metadataBytes, cellBytes: Math.max(admitted.cellBytes, schema.cost.cellBytes) };
      return [...db.prepare(sql).iterate()] as ThreadRow[];
    }, (size) => {
      const before = Math.max(0, copied - bytes); copied += size;
      budget.add('databaseBytes', Math.max(0, copied - bytes) - before);
    });
    // readForeignDb intentionally maps ordinary I/O/schema failures to null.
    // Its caller-owned budget distinguishes an exhausted request from absence.
    budget.assert();
    if (!rows) throw new CoreError('refused', 'The Codex history index could not be read. It may be unavailable, damaged or use an unsupported format.');
    const retained = rows.reduce((sum, row) => sum + historyPayloadBytes(Object.values(row)), historyPayloadBytes([stamp]));
    this.threads.set(file, { stamp, rows, cost }, rows.length, retained);
    return rows;
  }

  private historyAccounts(budget: HistoryBudget): Account[] {
    admitQuery(this.ctx.db, 'SELECT * FROM accounts WHERE archived_at IS NULL', [...schemaNames(this.ctx.db, 'accounts', budget).names], [], budget, 'accounts');
    return this.accounts.list();
  }

  private admitProjects(where: string, params: unknown[], budget: HistoryBudget): void {
    admitQuery(this.ctx.db, `SELECT * FROM projects WHERE ${where}`, [...schemaNames(this.ctx.db, 'projects', budget).names], params, budget);
  }

  /** Which Wanigan 2 session ran each conversation here, newest last, and whether one runs it now. */
  private runs(projectId: string, budget: HistoryBudget): Map<string, { sessionId: string; live: boolean }> {
    admitQuery(this.ctx.db, 'SELECT id, conversation_id, state FROM sessions WHERE project_id = ? AND conversation_id IS NOT NULL', ['id', 'conversation_id', 'state'], [projectId], budget);
    const rows = this.ctx.db.prepare('SELECT id, conversation_id, state FROM sessions WHERE project_id = ? AND conversation_id IS NOT NULL ORDER BY started_at')
      .all(projectId) as { id: string; conversation_id: string; state: SessionState }[];
    const runs = new Map<string, { sessionId: string; live: boolean }>();
    for (const r of rows) runs.set(r.conversation_id, { sessionId: r.id, live: LIVE_STATES.has(r.state) || !!runs.get(r.conversation_id)?.live });
    return runs;
  }

  private item(f: Found, where: Where, run: { sessionId: string; live: boolean } | undefined): HistoryItem {
    const sources: HistorySource[] = [f.provider];
    if (run) sources.push('wanigan2');
    const root = f.cwd ? where.worktrees.find((w) => f.cwd?.startsWith(`${w}/`)) : undefined;
    return {
      id: `${f.provider}:${f.conversationId}`, provider: f.provider, conversationId: f.conversationId,
      title: f.title, firstPrompt: f.firstPrompt, description: null,
      startedAt: f.startedAt, updatedAt: f.updatedAt, branch: f.branch, cwd: f.cwd,
      cardKey: root && f.cwd ? f.cwd.slice(root.length + 1).split('/')[0] ?? null : null,
      model: f.model, accountId: f.account.id, accountLabel: f.account.label, via: f.via, sources,
      sessionId: run?.sessionId ?? null, live: run?.live ?? false,
    };
  }
}

/* ── small helpers ─────────────────────────────────────────────────────── */

// Identity and content/permission metadata invalidate observed changes even
// when size and mtime are preserved. This is not an atomic snapshot or a
// guarantee for writes/access changes that leave every observed field equal.
function metadataStamp(stat: Stats): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.mode}`;
}

/** A database and its WAL, by observed metadata; null when the database is missing. */
function indexState(file: string): { stamp: string; bytes: number } | null {
  let bytes = 0;
  const parts = [file, `${file}-wal`].map((f) => {
    try {
      const s = statSync(f);
      if (!Number.isSafeInteger(s.size) || s.size < 0) throw new Error('Invalid history index size');
      bytes += s.size;
      return metadataStamp(s);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '-';
      throw new CoreError('refused', 'The Codex history index could not be read. Check access to its account folder.');
    }
  });
  return parts[0] === '-' ? null : { stamp: parts.join('|'), bytes };
}
const stampOf = (file: string): string | null => indexState(file)?.stamp ?? null;

/** Group copies of one conversation (forks) and keep the newest. */
function newestCopies(found: Found[]): Found[] {
  const newest = new Map<string, Found>();
  for (const f of found) {
    const key = f.lineage || f.conversationId;
    const kept = newest.get(key);
    if (!kept || f.updatedAt > kept.updatedAt) newest.set(key, f);
  }
  return [...newest.values()];
}

const inside = (where: Where, cwd: string): boolean => where.exact.has(cwd) || where.worktrees.some((w) => cwd.startsWith(`${w}/`));

/** Follow only an existing transcript whose lexical and canonical paths stay in its account. */
function transcriptIn(home: string, file: string | null): string | null {
  if (!file?.endsWith('.jsonl') || !within(home, file)) return null;
  try {
    const path = realpathSync(file);
    return within(realpathSync(home), path) ? path : null;
  } catch { return null; }
}

function* entries(dir: string, budget: HistoryBudget): Generator<string> {
  let opened;
  try { opened = opendirSync(dir); } catch { return; }
  const names: string[] = [];
  try {
    for (let entry = opened.readSync(); entry !== null; entry = opened.readSync()) {
      budget.add('entries', 1); budget.values([entry.name]);
      names.push(entry.name);
    }
  } finally { opened.closeSync(); }
  // Valid project slugs and conversation ids are ASCII. Preserve their existing
  // sorted traversal rather than making equal-time choices depend on readdir order.
  yield* names.sort();
}

function real(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}

function isDir(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}
