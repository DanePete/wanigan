// Folders worth offering when the owner opens a project: where their agents have
// worked lately, read from the CLIs' own records in every account Wanigan knows.
// Read-only and bounded: recent records are chosen by their modification time,
// only the first few KB of each are read, and the look stops at a file cap and
// a time cap, saying so when it does. The reads are asynchronous, so a slow
// disk never holds up the core's terminals or other requests.
//
// Where each CLI records the folder, read from the shipped binaries' strings
// (Claude Code 2.1.292, Codex 0.155.1), never from the owner's own files:
// - Claude Code writes one transcript per conversation at
//   <config>/projects/<folder slug>/<conversation id>.jsonl. Every entry carries
//   `cwd`, and Claude's own resume picker takes a conversation's folder from its
//   first entry (`projectPath: first.cwd`). The slug is lossy; `cwd` decides.
// - Codex writes <CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl. Its first line
//   is the session meta, `{"type":"session_meta","payload":{…,"cwd":…}}` ("staged
//   rollout head is not session metadata"; its ConversationSummary carries
//   `cwd`). A subagent's rollout names itself in `payload.source` and is not
//   one of the owner's conversations.
import type { Dirent } from 'node:fs';
import { open, readdir, realpath, stat } from 'node:fs/promises';
import { basename, join, sep } from 'node:path';
import type { AccountProvider, AgentFolder, AgentFolders as Result } from '../shared/model.ts';
import type { Accounts } from './accounts.ts';
import type { Ctx } from './context.ts';
import { claudeSlug } from './history.ts';

export const AGENT_FOLDER_DAYS = 30;
const DAY_MS = 86_400_000;
/** Enough of a record's start to hold its folder: Claude's first entries, Codex's session meta up to its instructions. */
const HEAD_BYTES = 16 * 1024;
const CLAUDE_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;
const CODEX_FILE = /^rollout-.+\.jsonl$/;
const CWD = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/;
const PARALLEL = 32;

export interface AgentFolderLimits {
  /** Records whose modification time is looked at. */
  maxFiles: number;
  /** Records whose first few KB are read, newest first. */
  maxReads: number;
  /** How long one look may take. */
  budgetMs: number;
  /** How long a look is reused. Adding a project needs no new look: open folders are left out on every ask. */
  freshMs: number;
}

const LIMITS: AgentFolderLimits = { maxFiles: 20_000, maxReads: 800, budgetMs: 2_500, freshMs: 30_000 };

interface Seen { file: string; at: number; provider: AccountProvider; dir: string }
interface Found { path: string; name: string; conversations: number; lastAt: number; git: boolean; agents: Set<AccountProvider> }

export class AgentFolders {
  private readonly ctx: Ctx;
  private readonly accounts: Accounts;
  private readonly home: string;
  private readonly dataDir: string;
  private readonly limits: AgentFolderLimits;
  /** A record's folder never changes once written, so it is read once. */
  private readonly folders = new Map<string, string>();
  private last: { at: number; folders: AgentFolder[]; cut: string | null } | null = null;
  private looking: Promise<{ folders: AgentFolder[]; cut: string | null }> | null = null;

  constructor(ctx: Ctx, accounts: Accounts, options: { home: string; dataDir: string; limits?: Partial<AgentFolderLimits> }) {
    this.ctx = ctx;
    this.accounts = accounts;
    this.home = options.home;
    this.dataDir = options.dataDir;
    this.limits = { ...LIMITS, ...options.limits };
  }

  /** Folders the agents worked in during the last 30 days that are not open here. */
  async list(): Promise<Result> {
    const fresh = this.last && Date.now() - this.last.at < this.limits.freshMs ? this.last : null;
    const found = fresh ?? await (this.looking ??= this.look().finally(() => { this.looking = null; }));
    const open = new Set((this.ctx.db.prepare('SELECT path FROM projects WHERE archived_at IS NULL').all() as { path: string }[]).map((r) => r.path));
    return { folders: found.folders.filter((f) => !open.has(f.path)), days: AGENT_FOLDER_DAYS, cut: found.cut };
  }

  private async look(): Promise<{ folders: AgentFolder[]; cut: string | null }> {
    const started = Date.now();
    const since = this.ctx.now() - AGENT_FOLDER_DAYS * DAY_MS;
    let cut: string | null = null;
    let looked = 0;
    const over = (): boolean => {
      if (cut) return true;
      if (looked >= this.limits.maxFiles) cut = `Looked at ${this.limits.maxFiles.toLocaleString('en-US')} records and stopped; some conversations were not counted.`;
      else if (Date.now() - started > this.limits.budgetMs) cut = 'Stopped after a few seconds; some conversations were not counted.';
      return cut !== null;
    };

    // Which records were written in the window, by their modification time alone.
    const records: Seen[] = [];
    const take = async (dir: string, names: string[], provider: AccountProvider, group: string): Promise<void> => {
      for (let i = 0; i < names.length && !over(); i += PARALLEL) {
        const batch = names.slice(i, i + Math.min(PARALLEL, this.limits.maxFiles - looked));
        looked += batch.length;
        const stats = await Promise.all(batch.map((n) => stat(join(dir, n)).catch(() => null)));
        stats.forEach((s, j) => {
          if (s?.isFile() && s.mtimeMs >= since) records.push({ file: join(dir, batch[j] as string), at: s.mtimeMs, provider, dir: group });
        });
      }
    };
    for (const account of this.accounts.list()) {
      if (over()) break;
      const root = this.accounts.folderOf(account);
      if (account.provider === 'claude') {
        const projects = join(root, 'projects');
        for (const dir of (await entries(projects)).filter((e) => e.isDirectory()).map((e) => e.name)) {
          if (over()) break;
          const names = (await entries(join(projects, dir))).filter((e) => e.isFile() && CLAUDE_FILE.test(e.name)).map((e) => e.name);
          await take(join(projects, dir), names, 'claude', `${account.id}/${dir}`);
        }
      } else {
        // Newest folders first (sessions/2026/10/07), so a cut leaves out the oldest.
        const walk = async (dir: string, depth: number): Promise<void> => {
          const list = (await entries(dir)).sort((a, b) => b.name.localeCompare(a.name));
          await take(dir, list.filter((e) => e.isFile() && CODEX_FILE.test(e.name)).map((e) => e.name), 'codex', '');
          if (depth > 0) for (const sub of list.filter((e) => e.isDirectory() && !e.name.startsWith('.'))) if (!over()) await walk(join(dir, sub.name), depth - 1);
        };
        await walk(join(root, 'sessions'), 3);
      }
    }

    records.sort((a, b) => b.at - a.at);
    if (records.length > this.limits.maxReads) {
      cut ??= `Counted the newest ${this.limits.maxReads} conversations of the last ${AGENT_FOLDER_DAYS} days.`;
      records.length = this.limits.maxReads;
    }

    // Each record's folder, from its first few KB.
    const where = new Map<Seen, string | null>();
    for (let i = 0; i < records.length; i += PARALLEL) {
      const batch = records.slice(i, i + PARALLEL);
      const folders = await Promise.all(batch.map((r) => this.folderOf(r)));
      batch.forEach((r, j) => where.set(r, folders[j] ?? null));
    }
    // A Claude transcript whose first entries are too long to hold its folder
    // belongs to the folder its siblings name, when they all name one and its
    // slug is the folder Claude filed them under.
    const byDir = new Map<string, Set<string>>();
    for (const [r, path] of where) if (path && r.provider === 'claude') byDir.set(r.dir, (byDir.get(r.dir) ?? new Set()).add(path));
    for (const [r, path] of where) {
      if (path || r.provider !== 'claude') continue;
      const named = [...(byDir.get(r.dir) ?? [])];
      if (named.length === 1 && claudeSlug(named[0] as string) === r.dir.split('/').pop()) where.set(r, named[0] as string);
    }

    const tally = new Map<string, { conversations: number; lastAt: number; agents: Set<AccountProvider> }>();
    for (const [r, path] of where) {
      if (!path) continue;
      const t = tally.get(path) ?? { conversations: 0, lastAt: 0, agents: new Set<AccountProvider>() };
      t.conversations++;
      t.lastAt = Math.max(t.lastAt, r.at);
      t.agents.add(r.provider);
      tally.set(path, t);
    }

    // Folders that still exist, as the disk names them (two spellings of one
    // folder are one folder), and not the home folder or Wanigan's own.
    const home = await realpath(this.home).catch(() => this.home);
    const data = await realpath(this.dataDir).catch(() => this.dataDir);
    const found = new Map<string, Found>();
    for (const [path, t] of tally) {
      const real = await realpath(path).catch(() => null);
      if (!real || !(await stat(real).then((s) => s.isDirectory(), () => false))) continue;
      if (real === home || real === sep || real === data || real.startsWith(data + sep)) continue;
      const f = found.get(real) ?? { path: real, name: basename(real), conversations: 0, lastAt: 0, git: false, agents: new Set<AccountProvider>() };
      f.conversations += t.conversations;
      f.lastAt = Math.max(f.lastAt, t.lastAt);
      for (const a of t.agents) f.agents.add(a);
      found.set(real, f);
    }
    for (const f of found.values()) f.git = await stat(join(f.path, '.git')).then(() => true, () => false);

    const folders = [...found.values()]
      .sort((a, b) => b.conversations - a.conversations || b.lastAt - a.lastAt || a.path.localeCompare(b.path))
      .map((f) => ({ ...f, agents: [...f.agents].sort() }));
    this.last = { at: Date.now(), folders, cut };
    return { folders, cut };
  }

  /** The folder a record says its conversation ran in, or null when its first few KB do not say. */
  private async folderOf(r: Seen): Promise<string | null> {
    const known = this.folders.get(r.file);
    if (known) return known;
    const head = await readHead(r.file);
    const path = r.provider === 'claude' ? claudeFolder(head) : codexFolder(head);
    if (path) {
      if (this.folders.size > 50_000) this.folders.clear();
      this.folders.set(r.file, path);
    }
    return path;
  }
}

/** The first `cwd` in a Claude transcript's opening entries. A cut entry still counts: the field is whole or absent. */
export function claudeFolder(head: string): string | null {
  return absolute(CWD.exec(head)?.[1]);
}

/** The `cwd` of a Codex rollout's session meta, unless it is a subagent's. */
export function codexFolder(head: string): string | null {
  const end = head.indexOf('\n');
  const first = end < 0 ? head : head.slice(0, end);
  if (end >= 0) {
    try {
      const line = JSON.parse(first) as { type?: unknown; payload?: { cwd?: unknown; source?: unknown } };
      if (line.type !== 'session_meta') return null;
      const source = line.payload?.source;
      if (source && typeof source === 'object' && 'subagent' in source) return null;
      return typeof line.payload?.cwd === 'string' && usable(line.payload.cwd) ? line.payload.cwd : null;
    } catch {
      return null;
    }
  }
  // The meta line runs past what was read (long instructions): its start still says what it is.
  if (!/^\{[^\n]*?"type"\s*:\s*"session_meta"/.test(first)) return null;
  if (/"source"\s*:\s*\{\s*"subagent"/.test(first)) return null;
  const payload = first.indexOf('"payload"');
  return payload < 0 ? null : absolute(CWD.exec(first.slice(payload))?.[1]);
}

/** A JSON string body as an absolute path, or null. */
function absolute(escaped: string | undefined): string | null {
  if (escaped === undefined) return null;
  try {
    const path: unknown = JSON.parse(`"${escaped}"`);
    return typeof path === 'string' && usable(path) ? path : null;
  } catch {
    return null;
  }
}

const usable = (path: string): boolean => path.startsWith('/') && !path.includes('\0');

async function readHead(file: string): Promise<string> {
  const handle = await open(file, 'r').catch(() => null);
  if (!handle) return '';
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    return buffer.toString('utf8', 0, bytesRead);
  } catch {
    return '';
  } finally {
    await handle.close().catch(() => {});
  }
}

async function entries(dir: string): Promise<Dirent[]> {
  try { return await readdir(dir, { withFileTypes: true }); } catch { return []; }
}
