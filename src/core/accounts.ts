// Agent accounts. An account is a labelled configuration folder — CLAUDE_CONFIG_DIR
// for Claude Code, CODEX_HOME for Codex — because that folder is where each CLI
// keeps its login (Claude also keys its Keychain entry to it). Wanigan never
// holds, reads or copies a credential; it asks the CLI itself who it is.
//
// Carried over from Wanigan 1, where each was verified against the real CLIs:
// - The account that *is* the CLI's default folder sets no variable at all.
//   Setting CLAUDE_CONFIG_DIR to ~/.claude makes Claude read ~/.claude/.claude.json
//   instead of ~/.claude.json and report a signed-in owner as logged out.
// - An inherited CLAUDE_CONFIG_DIR is removed for that account, or the session
//   silently runs under whatever folder the shell that started Wanigan exported.
// - A missing credential file is not "signed out": on macOS the login is in the
//   Keychain. Only the CLI's own answer can say "no".
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, normalize } from 'node:path';
import { ACCOUNT_PROVIDERS, type Account, type AccountProvider, type Provider } from '../shared/model.ts';
import { parseUsage, type AccountUsage } from '../shared/usage.ts';
import { readCodexAccount } from './codex-server.ts';
import { CoreError } from '../shared/protocol.ts';
import type { Ctx } from './context.ts';
import { cleanEnv, isDir, loginPath, requireCli, which } from './environment.ts';

export const CONFIG_ENV: Record<AccountProvider, string> = { claude: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME' };
const DEFAULT_FOLDER: Record<AccountProvider, string> = { claude: '.claude', codex: '.codex' };
const LOOKS_LIKE: Record<AccountProvider, string[]> = {
  claude: ['.claude.json', 'settings.json', 'projects', '.credentials.json', 'statsig', 'todos'],
  codex: ['auth.json', 'config.toml', 'sessions', 'history.jsonl'],
};
const PROBE_TIMEOUT_MS = 15_000;

export interface Probe {
  signedIn: 'yes' | 'no' | 'unknown'; identity: string | null; plan: string | null;
  /** False when the CLI is not on the login shell's PATH. A stand-in that does not say counts as installed. */
  installed?: boolean;
}
export type Prober = (provider: AccountProvider, configDir: string | null) => Promise<Probe>;
/** What an account has left: `claude -p "/usage"` for Claude, Codex's app-server for Codex. */
export type UsageReader = (provider: AccountProvider, configDir: string | null) => Promise<AccountUsage>;

/** A limits reading this old is read again rather than shown as current. */
export const USAGE_STALE_MS = 10 * 60_000;

interface Row {
  id: string; provider: string; label: string; config_dir: string | null; is_default: number; discovered: number;
  signed_in: string; identity: string | null; plan: string | null; checked_at: number | null; created_at: number; archived_at: number | null;
  /** Null until the account is first checked. */
  installed: number | null;
}

export class Accounts {
  private readonly ctx: Ctx;
  private readonly home: string;
  private readonly probe: Prober;
  private readonly readUsage: UsageReader;
  private readonly usage = new Map<string, AccountUsage>();
  private checking: Promise<void> | null = null;
  private reading: Promise<void> | null = null;
  private stopped = false;

  constructor(ctx: Ctx, options: { home?: string; prober?: Prober; usageReader?: UsageReader; neutralDir?: string } = {}) {
    this.ctx = ctx;
    this.home = options.home ?? homedir();
    this.probe = options.prober ?? probeCli;
    this.readUsage = options.usageReader ?? ((provider, dir) => provider === 'claude'
      ? readClaudeUsage(dir, options.neutralDir ?? this.home).then((text) => parseUsage(text, this.ctx.now()))
      : readCodexUsage(dir, this.ctx.now));
  }

  /**
   * Read what each signed-in account has left, two at a time. A failed read is
   * kept as unreadable with its reason, never as a number.
   */
  refreshUsage(force = false): Promise<void> {
    if (this.stopped) return Promise.resolve();
    // "Check again" while a routine read is going waits for it, then reads again.
    if (force && this.reading) return this.reading.then(() => this.refreshUsage(true));
    if (this.reading) return this.reading;
    // Cleared once settled, never before it is set: a read with nothing due
    // finishes at once, and must not stand in for every read after it.
    const reading = this.readDue(force).finally(() => { if (this.reading === reading) this.reading = null; });
    this.reading = reading;
    return reading;
  }

  private async readDue(force: boolean): Promise<void> {
    const due = this.list().filter((a) => a.signedIn !== 'no' && a.folderOk && a.installed
      && (force || !a.usage || this.ctx.now() - a.usage.checkedAt > USAGE_STALE_MS));
    for (let i = 0; i < due.length && !this.stopped; i += 2) {
      await Promise.all(due.slice(i, i + 2).map(async (a) => {
        let reading: AccountUsage;
        try { reading = await this.readUsage(a.provider, a.configDir); } catch (e) {
          reading = { state: 'unreadable', windows: [], checkedAt: this.ctx.now(), note: (e as Error).message };
        }
        if (this.stopped) return;
        this.usage.set(a.id, reading);
        this.ctx.emit('accounts', {});
      }));
    }
  }

  /** Find account folders already on disk, so existing logins work with no new sign-in. */
  discover(): void {
    const { db } = this.ctx;
    const now = this.ctx.now();
    const insert = db.prepare(`INSERT OR IGNORE INTO accounts (id, provider, label, config_dir, is_default, discovered, created_at)
                               VALUES (?, ?, ?, ?, ?, 1, ?)`);
    for (const provider of ACCOUNT_PROVIDERS) {
      const hasDefault = db.prepare('SELECT 1 FROM accounts WHERE provider = ? AND is_default = 1 AND archived_at IS NULL').get(provider);
      insert.run(randomUUID(), provider, 'Default', null, hasDefault ? 0 : 1, now);
      const prefix = new RegExp(`^${DEFAULT_FOLDER[provider].replace('.', '\\.')}[-_](.+)$`);
      let names: string[] = [];
      try { names = readdirSync(this.home); } catch { names = []; }
      for (const name of names) {
        const match = name.match(prefix);
        if (!match?.[1]) continue;
        const dir = join(this.home, name);
        if (!isDir(dir) || !LOOKS_LIKE[provider].some((f) => exists(join(dir, f)))) continue;
        insert.run(randomUUID(), provider, labelFrom(match[1]), dir, 0, now);
      }
    }
    this.ctx.emit('accounts', {});
  }

  list(): Account[] {
    const rows = this.ctx.db.prepare('SELECT * FROM accounts WHERE archived_at IS NULL ORDER BY provider, is_default DESC, label COLLATE NOCASE').all() as Row[];
    const accounts = rows.map((r) => this.map(r));
    // Only a reported email identifies a login; "ChatGPT" or a plan name does not.
    const login = (a: Account): string | null => (a.signedIn === 'yes' && a.identity?.includes('@') ? `${a.provider}:${a.identity.toLowerCase()}` : null);
    return accounts.map((a) => {
      const mine = login(a);
      const twin = mine ? accounts.find((b) => b.id !== a.id && login(b) === mine) : undefined;
      return twin ? { ...a, sameLoginAs: twin.label } : a;
    });
  }

  get(id: string): Account {
    const row = this.ctx.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as Row | undefined;
    if (!row) throw new CoreError('not_found', 'No such account.');
    return this.map(row);
  }

  /** The folder an account's CLI keeps its state in. The default account's is the CLI's own. */
  folderOf(account: Account): string {
    return account.configDir ?? join(this.home, DEFAULT_FOLDER[account.provider]);
  }

  /** Ask every CLI who it is signed in as. One check at a time; callers share it. */
  refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.checking ??= (async () => {
      try {
        await Promise.all(this.list().map((a) => this.check(a)));
      } finally {
        this.checking = null;
      }
    })();
    return this.checking;
  }

  /** Pending probes may settle after the core closes its store; their results then have no recipient. */
  stop(): void { this.stopped = true; }

  async check(account: Account): Promise<void> {
    if (this.stopped) return;
    let result: Probe;
    try { result = await this.probe(account.provider, account.configDir); } catch { result = { signedIn: 'unknown', identity: null, plan: null }; }
    if (this.stopped) return;
    this.ctx.db.prepare('UPDATE accounts SET signed_in = ?, identity = coalesce(?, identity), plan = coalesce(?, plan), checked_at = ?, installed = ? WHERE id = ?')
      .run(result.signedIn, result.identity, result.plan, this.ctx.now(), result.installed === false ? 0 : 1, account.id);
    this.ctx.emit('accounts', {});
  }

  /** A new, empty account folder in the owner's home, named like the ones already there. */
  add(provider: AccountProvider, label: string): Account {
    const clean = label.trim();
    if (!clean || clean.length > 60) throw new CoreError('invalid', 'An account name is 1–60 characters.');
    const slug = clean.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'account';
    let dir = join(this.home, `${DEFAULT_FOLDER[provider]}_${slug}`);
    for (let n = 2; exists(dir); n++) dir = join(this.home, `${DEFAULT_FOLDER[provider]}_${slug}_${n}`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const id = randomUUID();
    this.ctx.db.prepare('INSERT INTO accounts (id, provider, label, config_dir, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, provider, clean, dir, this.ctx.now());
    this.ctx.emit('accounts', {});
    return this.get(id);
  }

  rename(id: string, label: string): Account {
    const clean = label.trim();
    if (!clean || clean.length > 60) throw new CoreError('invalid', 'An account name is 1–60 characters.');
    this.get(id);
    this.ctx.db.prepare('UPDATE accounts SET label = ? WHERE id = ?').run(clean, id);
    this.ctx.emit('accounts', {});
    return this.get(id);
  }

  makeDefault(id: string): Account {
    const account = this.get(id);
    this.ctx.db.transaction(() => {
      this.ctx.db.prepare('UPDATE accounts SET is_default = 0 WHERE provider = ?').run(account.provider);
      this.ctx.db.prepare('UPDATE accounts SET is_default = 1 WHERE id = ?').run(id);
    })();
    this.ctx.emit('accounts', {});
    this.ctx.emit('projects', {});
    return this.get(id);
  }

  /** Stop offering an account. The folder and its login are left exactly as they are. */
  remove(id: string): void {
    const account = this.get(id);
    if (account.isDefault) throw new CoreError('refused', 'Make another account the default first.');
    this.ctx.db.transaction(() => {
      this.ctx.db.prepare('UPDATE accounts SET archived_at = ? WHERE id = ?').run(this.ctx.now(), id);
      this.ctx.db.prepare('DELETE FROM project_accounts WHERE account_id = ?').run(id);
    })();
    this.ctx.emit('accounts', {});
    this.ctx.emit('projects', {});
  }

  /** The folder an account's CLI really uses: its own, or the CLI's default in the owner's home. */
  folder(provider: AccountProvider, account: Account | null): string {
    return account?.configDir ?? join(this.home, DEFAULT_FOLDER[provider]);
  }

  /**
   * When an account's limit lifts, from its last limits reading: the latest
   * reset among the windows that are full. Null when no reading says so.
   */
  limitResetFor(accountId: string | null, now: number): number | null {
    const usage = accountId ? this.usage.get(accountId) : undefined;
    if (usage?.state !== 'ok') return null;
    const full = usage.windows.filter((w) => w.usedPercent >= 100 && w.resetsAt !== null && w.resetsAt > now).map((w) => w.resetsAt as number);
    return full.length ? Math.max(...full) : null;
  }

  /** Which account each agent uses in a project, by default. */
  projectAccounts(projectId: string): Partial<Record<AccountProvider, string>> {
    const rows = this.ctx.db.prepare('SELECT provider, account_id FROM project_accounts WHERE project_id = ?').all(projectId) as { provider: AccountProvider; account_id: string }[];
    return Object.fromEntries(rows.map((r) => [r.provider, r.account_id]));
  }

  setProjectAccount(projectId: string, provider: AccountProvider, accountId: string | null): void {
    if (accountId === null) {
      this.ctx.db.prepare('DELETE FROM project_accounts WHERE project_id = ? AND provider = ?').run(projectId, provider);
    } else {
      const account = this.get(accountId);
      if (account.provider !== provider) throw new CoreError('invalid', `That is a ${account.provider} account.`);
      this.ctx.db.prepare(`INSERT INTO project_accounts (project_id, provider, account_id) VALUES (?, ?, ?)
                           ON CONFLICT(project_id, provider) DO UPDATE SET account_id = excluded.account_id`).run(projectId, provider, accountId);
    }
    this.ctx.emit('projects', {});
  }

  /** The account a session should use: the one asked for, else the project's, else the default. */
  resolve(projectId: string, provider: Provider, requested?: string | null): Account | null {
    // A shell has no account; Gemini CLI runs as its own login, in Wanigan's Gemini home.
    if (provider !== 'claude' && provider !== 'codex') return null;
    if (requested) {
      const a = this.get(requested);
      if (a.provider !== provider) throw new CoreError('invalid', `That is a ${a.provider} account.`);
      return a;
    }
    const chosen = this.projectAccounts(projectId)[provider];
    if (chosen) {
      const row = this.ctx.db.prepare('SELECT * FROM accounts WHERE id = ? AND archived_at IS NULL').get(chosen) as Row | undefined;
      if (row) return this.map(row);
    }
    const fallback = this.ctx.db.prepare('SELECT * FROM accounts WHERE provider = ? AND is_default = 1 AND archived_at IS NULL').get(provider) as Row | undefined;
    return fallback ? this.map(fallback) : null;
  }

  private map(r: Row): Account {
    const provider = r.provider as AccountProvider;
    const shown = r.config_dir ?? join(this.home, DEFAULT_FOLDER[provider]);
    return {
      id: r.id,
      provider,
      label: r.label,
      configDir: r.config_dir,
      displayDir: shown.startsWith(this.home) ? `~${shown.slice(this.home.length)}` : shown,
      isDefault: r.is_default === 1,
      discovered: r.discovered === 1,
      signedIn: r.signed_in === 'yes' || r.signed_in === 'no' ? r.signed_in : 'unknown',
      identity: r.identity,
      plan: r.plan,
      checkedAt: r.checked_at,
      // Not checked yet is not "missing": nothing says so until the CLI is looked for.
      installed: r.installed !== 0,
      folderOk: r.config_dir === null || isDir(r.config_dir),
      usage: this.usage.get(r.id) ?? null,
      sameLoginAs: null,
    };
  }
}

/**
 * Put an account onto a session's environment, or take an inherited one off.
 * "No account" for a shell leaves the environment alone.
 */
export function applyAccount(env: Record<string, string>, provider: Provider, account: Account | null): void {
  if (provider === 'shell' || !account) return;
  const key = CONFIG_ENV[account.provider];
  if (account.configDir) env[key] = account.configDir;
  else delete env[key];
}

/**
 * Where Claude Code saved a conversation: `<config>/projects/<cwd with every
 * character that is not a letter or digit as "-">/<id>.jsonl` (2.1.292). A
 * name past 200 characters ends in a hash Wanigan does not compute, so then
 * the folder holding this id is looked for instead. Null when it is not there.
 */
export function transcriptPath(configFolder: string, cwd: string, conversationId: string): string | null {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(conversationId)) return null;
  const projects = join(configFolder, 'projects');
  const file = `${conversationId}.jsonl`;
  const direct = join(projects, cwd.replace(/[^a-zA-Z0-9]/g, '-'), file);
  if (isFile(direct)) return direct;
  let folders: string[] = [];
  try { folders = readdirSync(projects); } catch { return null; }
  for (const folder of folders) {
    const candidate = join(projects, folder, file);
    if (isFile(candidate)) return candidate;
  }
  return null;
}

/**
 * A Codex rollout path a hook reported, kept only if it is that thread's own
 * file (`rollout-<time>-<thread id>.jsonl`, codex-cli 0.155.1) inside the
 * account's CODEX_HOME. Anything else is not followed.
 */
export function rolloutIn(codexHome: string, threadId: string, path: unknown): string | null {
  if (typeof path !== 'string' || !isAbsolute(path) || normalize(path) !== path) return null;
  if (!path.endsWith('.jsonl') || !basename(path).includes(threadId)) return null;
  const homes = new Set([codexHome, realOr(codexHome)]);
  return [...homes].some((home) => path.startsWith(`${home.replace(/\/+$/, '')}/`)) ? path : null;
}

function realOr(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}

/** The environment a status check runs in: the owner's, with only this account's folder applied. */
function probeEnv(provider: AccountProvider, configDir: string | null, path: string): Record<string, string> {
  const env: Record<string, string> = { ...cleanEnv(process.env), PATH: path };
  if (configDir) env[CONFIG_ENV[provider]] = configDir;
  else delete env[CONFIG_ENV[provider]];
  return env;
}

/** Ask the real CLI. No model call is made; both commands read local state. */
async function probeCli(provider: AccountProvider, configDir: string | null): Promise<Probe> {
  const path = await loginPath();
  const bin = which(provider, path);
  if (!bin) return { signedIn: 'unknown', identity: null, plan: null, installed: false };
  const args = provider === 'claude' ? ['auth', 'status', '--json'] : ['login', 'status'];
  const { stdout, ok } = await run(bin, args, probeEnv(provider, configDir, path));
  if (provider === 'claude') {
    try {
      const status = JSON.parse(stdout) as { loggedIn?: boolean; email?: string; subscriptionType?: string; authMethod?: string };
      if (status.loggedIn === true) return { signedIn: 'yes', identity: status.email ?? status.authMethod ?? null, plan: status.subscriptionType ?? null };
      if (status.loggedIn === false) return { signedIn: 'no', identity: null, plan: null };
    } catch { /* not JSON: an older CLI or an error */ }
    return { signedIn: 'unknown', identity: null, plan: null };
  }
  const text = stdout.trim();
  // Who it is, by email, comes from the app-server; `codex login status` only says how.
  try {
    const reading = await readCodexAccount(bin, configDir, path, Date.now);
    if (reading.probe.signedIn !== 'unknown') return reading.probe;
  } catch { /* fall back to the status line */ }
  const using = text.match(/Logged in using (.+)/i);
  if (using?.[1]) return { signedIn: 'yes', identity: using[1].trim(), plan: null };
  if (ok && /not logged in/i.test(text)) return { signedIn: 'no', identity: null, plan: null };
  if (/not logged in/i.test(text)) return { signedIn: 'no', identity: null, plan: null };
  return { signedIn: 'unknown', identity: null, plan: null };
}

/**
 * `claude -p "/usage"` as one account: a built-in command that reports the
 * account's limits, not a model turn. Run in a folder with no project, so no
 * repository's settings are loaded into a question about an account.
 */
async function readClaudeUsage(configDir: string | null, cwd: string): Promise<string> {
  const { bin, path } = await requireCli('claude');
  const { stdout } = await run(bin, ['-p', '/usage'], probeEnv('claude', configDir, path), cwd, 60_000);
  return stdout;
}

async function readCodexUsage(configDir: string | null, now: () => number): Promise<AccountUsage> {
  const { bin, path } = await requireCli('codex');
  return (await readCodexAccount(bin, configDir, path, now)).usage;
}

function run(file: string, args: string[], env: Record<string, string>, cwd?: string, timeout = PROBE_TIMEOUT_MS): Promise<{ stdout: string; ok: boolean }> {
  return new Promise((resolve) => {
    execFile(file, args, { env, timeout, maxBuffer: 256 * 1024, ...(cwd ? { cwd } : {}) }, (error, stdout, stderr) => {
      resolve({ stdout: `${String(stdout ?? '')}${String(stderr ?? '')}`, ok: !error });
    });
  });
}

/** "max5_you_example_com" → "max5 you example com"; the owner can rename it. */
function labelFrom(suffix: string): string {
  return suffix.replace(/[_-]+/g, ' ').trim().slice(0, 60) || 'Account';
}

function isFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

function exists(path: string): boolean {
  try { statSync(path); return true; } catch { return false; }
}
