import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { dataDir, db } from './db';
import { usesAnthropicAccount } from './providers';
import type { AccountResolution, AgentAccount, NativeMemoryWrites } from '../shared/types';

/**
 * One operator, several agent accounts.
 *
 * An account is a labelled config directory, not a credential. Claude Code
 * keys its stored login — including the macOS Keychain entry — to
 * `CLAUDE_CONFIG_DIR`, so a session launched with a different directory reads a
 * different login. Wanigan never holds the token, never sees it, and cannot
 * perform the browser sign-in: it creates the directory and points a session at
 * it, and the operator runs `/login` there once.
 *
 * Everything here is harness-scoped rather than Claude-specific. Codex keeps
 * its login (`auth.json`), config, skills, sessions and state index under
 * `CODEX_HOME`, so the same labelled-directory shape maps onto it; a harness
 * with no mapping simply has no accounts.
 *
 * What a Codex account is not: a shadow home. A directory Wanigan creates for
 * Codex starts with no `config.toml` (and therefore no MCP servers or model
 * defaults), no skills and no login until the operator signs in there; see
 * `startsWithout()` for the sentence the UI shows.
 */

/** The environment variable each harness reads for its config directory. */
const HARNESS_CONFIG_ENV: Record<string, string> = {
  'claude-code': 'CLAUDE_CONFIG_DIR',
  codex: 'CODEX_HOME',
};

/**
 * Credentials that outrank an account's stored login.
 *
 * Claude Code's documented precedence puts both of these above the `/login`
 * credential, so with either exported every account would quietly resolve to
 * the same organisation. Wanigan does not strip them — an operator who exported
 * a key meant it — but a picker that showed a choice the session ignores would
 * be lying, so the resolution reports the override instead.
 */
const OVERRIDING_ENV = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'];

const MAX_LABEL = 60;

type Row = {
  id: string; harness: string; label: string; config_dir: string;
  adopted: number; is_default: number; created_at: number; updated_at: number;
};

const uid = () => `acct_${randomUUID().slice(0, 12)}`;
const now = () => Date.now();

export function configEnvVar(harness: string): string | null {
  return HARNESS_CONFIG_ENV[harness] ?? null;
}

/** Where a harness keeps its configuration when the variable is not set. */
function platformDefaultDir(harness: string): string | null {
  if (harness === 'claude-code') return path.join(os.homedir(), '.claude');
  if (harness === 'codex') return path.join(os.homedir(), '.codex');
  return null;
}

/** True when this harness has a config directory Wanigan knows how to point. */
export function supportsAccounts(harness: string): boolean {
  return configEnvVar(harness) !== null;
}

function exists(dir: string): boolean {
  try { return fs.statSync(dir).isDirectory(); } catch { return false; }
}

/**
 * Evidence that a login has been stored for this directory.
 *
 * Three places, because the credential moves depending on the platform and how
 * the directory was reached, and a runtime probe caught an earlier version
 * reporting 'unknown' for a directory that was plainly signed in:
 *
 *  - `<dir>/.credentials.json` — Linux, and macOS when the Keychain refused
 *    the write.
 *  - `<dir>.json` — the sibling state file, which is what `~/.claude.json` is
 *    next to `~/.claude`. It is a sibling, not a child.
 *  - `<dir>/.claude.json` — the same file for a relocated config directory.
 *
 * 'unknown' never means "not signed in". On macOS the credential itself lives
 * in the Keychain, keyed to this directory, and Wanigan neither holds it nor
 * reads it — so absence here is absence of evidence and the surface has to say
 * so rather than report a logged-in account as logged out. Existence is not
 * proof of a *valid* login either: expiry is inside the credential.
 */
function signedIn(harness: string, dir: string): AgentAccount['signedIn'] {
  const candidates = harness === 'codex'
    // Codex writes its login to `<dir>/auth.json`. It can also be told to use
    // the OS credential store instead (`cli_auth_credentials_store`), in which
    // case nothing is on disk here — so absence is again absence of evidence.
    ? [path.join(dir, 'auth.json')]
    : [
      path.join(dir, '.credentials.json'),
      `${dir}.json`,
      path.join(dir, '.claude.json'),
    ];
  for (const candidate of candidates) {
    try { if (fs.statSync(candidate).size > 0) return 'yes'; } catch { /* absent */ }
  }
  return 'unknown';
}

function map(row: Row): AgentAccount {
  const present = exists(row.config_dir);
  return {
    id: row.id, harness: row.harness, label: row.label, configDir: row.config_dir,
    adopted: row.adopted === 1, isDefault: row.is_default === 1,
    present, signedIn: present ? signedIn(row.harness, row.config_dir) : 'unknown',
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

/**
 * The operator's existing config directory, adopted rather than replaced.
 *
 * Seeded on first read so an install keeps its login, plugins, history and
 * memory working with no migration and no second sign-in. It is adopted, so
 * removing the account never offers to delete the directory.
 *
 * The ambient variable is read here, not just defaulted past: an operator who
 * moved their configuration has an exported CLAUDE_CONFIG_DIR and no ~/.claude
 * at all. Adopting the path they actually use makes "Personal" their real
 * account; adopting ~/.claude would create an empty one beside it and point
 * every reader at a directory their own CLI never touches.
 *
 * The same rule seeds Codex from `CODEX_HOME` or `~/.codex`: sessions.ts and
 * headless.ts already retain that variable through their environment scrub for
 * exactly this reason, so adopting it changes nothing about what a session
 * launched before accounts existed would have used.
 */
function seed(harness: string): void {
  const fallback = platformDefaultDir(harness);
  if (!supportsAccounts(harness) || !fallback) return;
  const count = db().prepare('SELECT COUNT(*) n FROM agent_accounts WHERE harness=?').get(harness) as { n: number };
  if (count.n > 0) return;
  const ambientVar = configEnvVar(harness);
  const ambient = ambientVar ? process.env[ambientVar]?.trim() : '';
  const dir = ambient ? path.resolve(ambient) : fallback;
  const at = now();
  db().prepare(`INSERT OR IGNORE INTO agent_accounts (id,harness,label,config_dir,adopted,is_default,created_at,updated_at)
    VALUES (?,?,?,?,1,1,?,?)`).run(uid(), harness, 'Personal', dir, at, at);
}

export function list(harness: string): AgentAccount[] {
  seed(harness);
  const rows = db().prepare('SELECT * FROM agent_accounts WHERE harness=? ORDER BY is_default DESC, created_at')
    .all(harness) as Row[];
  return rows.map(map);
}

/**
 * Every account across every harness, grouped by harness.
 *
 * No seeding: this is the reader for surfaces that ask "who is signed in
 * anywhere", and seeding a harness the operator has never used would invent a
 * Personal account for an agent that is not installed. `list(harness)` is still
 * the call for a surface that is about one agent.
 */
export function listAll(): AgentAccount[] {
  const rows = db().prepare('SELECT * FROM agent_accounts ORDER BY harness, is_default DESC, created_at')
    .all() as Row[];
  return rows.map(map);
}

export function byId(id: string): AgentAccount | null {
  const row = db().prepare('SELECT * FROM agent_accounts WHERE id=?').get(id) as Row | undefined;
  return row ? map(row) : null;
}

function cleanLabel(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('Give the account a label — it is how you tell the two apart at launch.');
  const label = raw.trim();
  if (label.length > MAX_LABEL) throw new Error(`An account label is at most ${MAX_LABEL} characters.`);
  return label;
}

/**
 * Validate a directory the renderer proposed.
 *
 * Credentials land here, so the path is checked in the main process rather than
 * trusted from the window: absolute, no traversal, and inside the operator's
 * home directory. Home is not a security boundary against the operator — it is
 * the boundary that stops a typo or a crafted IPC message from pointing a
 * credential directory at a system path.
 */
function cleanDir(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('Choose a directory for this account.');
  const expanded = raw.trim().startsWith('~/') ? path.join(os.homedir(), raw.trim().slice(2)) : raw.trim();
  if (!path.isAbsolute(expanded)) throw new Error('An account directory must be an absolute path.');
  const dir = path.resolve(expanded);
  if (dir.split(path.sep).includes('..')) throw new Error('An account directory cannot contain "..".');
  const home = path.resolve(os.homedir());
  // Wanigan's own data directory counts too: it is where Wanigan-created
  // account directories belong, and under a custom --user-data-dir it is not
  // necessarily under home.
  const owned = [home, path.resolve(dataDir())];
  if (dir === home) throw new Error('Your home directory itself cannot be an account directory.');
  if (!owned.some((root) => dir === root || dir.startsWith(root + path.sep))) {
    throw new Error('An account directory must live inside your home directory or Wanigan’s own data directory. That is where a harness keeps its configuration.');
  }
  try {
    if (fs.statSync(dir).isFile()) throw new Error('That path is a file, not a directory.');
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('That path is')) throw error;
  }
  return dir;
}

/**
 * What a new account directory may be seeded with, and what it never may be.
 *
 * A directory created from nothing has no settings, skills, commands or
 * subagents, which is the complaint every multi-account write-up ends on. These
 * four are authored configuration: copying them is a convenience, and copying
 * them wrongly costs a re-edit.
 *
 * Two things are deliberately absent. Credentials, because copying a login into
 * a second directory defeats the entire point of separating them — and because
 * on macOS the credential is in the Keychain and is not Wanigan's to move.
 * And `projects/`, the conversation history: the community guides symlink it
 * for convenience, but it is the transcript of everything said, and moving a
 * work account's across into a personal directory is not a convenience Wanigan
 * should make one click deep.
 *
 * Copied rather than linked, so deleting one account cannot follow a link into
 * the other, and editing one account's skills cannot silently edit the other's.
 *
 * Codex is narrower still. `config.toml` is authored configuration too, but its
 * `[mcp_servers.*.env]` blocks are where people put API keys, so copying it is
 * copying a credential by another name; a new Codex directory therefore starts
 * without MCP servers or model defaults, and the UI says so. `sessions/`,
 * `history.jsonl` and `state_5.sqlite` are the conversation record and stay
 * out for the same reason `projects/` does above.
 */
const SEEDABLE: Record<string, string[]> = {
  'claude-code': ['settings.json', 'skills', 'commands', 'agents'],
  codex: ['skills', 'AGENTS.md'],
};

/**
 * What a directory Wanigan creates for this harness will not have until the
 * operator puts it there. Shown at creation so nobody discovers it mid-session.
 */
export function startsWithout(harness: string): string[] {
  if (harness === 'codex') {
    return ['a login (run `codex login` in a session started under it)', 'config.toml — model defaults, approval policy and MCP servers', 'skills, unless copied from another account'];
  }
  if (harness === 'claude-code') {
    return ['a login (run /login in a session started under it)', 'plugins and MCP servers', 'settings, skills, commands and subagents, unless copied from another account'];
  }
  return [];
}

function seedFrom(harness: string, source: string, target: string): string[] {
  const copied: string[] = [];
  for (const name of SEEDABLE[harness] ?? []) {
    const from = path.join(source, name);
    const to = path.join(target, name);
    try {
      if (!fs.existsSync(from) || fs.existsSync(to)) continue;
      fs.cpSync(from, to, { recursive: true, errorOnExist: true, dereference: false });
      copied.push(name);
    } catch {
      // One unreadable item must not abort the rest; the caller reports what
      // actually landed rather than what was attempted.
    }
  }
  return copied;
}

export function create(input: { harness: string; label: string; configDir: string; seedFromAccountId?: string | null }): AgentAccount {
  const harness = typeof input.harness === 'string' ? input.harness.trim() : '';
  if (!supportsAccounts(harness)) {
    throw new Error(`Wanigan does not know where the ${harness || 'selected'} harness keeps its configuration, so it cannot switch accounts for it.`);
  }
  seed(harness);
  const label = cleanLabel(input.label);
  const dir = cleanDir(input.configDir);
  const clash = db().prepare('SELECT label FROM agent_accounts WHERE harness=? AND config_dir=?')
    .get(harness, dir) as { label: string } | undefined;
  if (clash) throw new Error(`"${clash.label}" already uses that directory. Two accounts sharing one directory would share one login.`);
  // 0700: the harness stores a credential file here on Linux, and on macOS
  // whenever the Keychain write is refused.
  const adopted = exists(dir);
  if (!adopted) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Only into a directory Wanigan just made. Seeding an adopted directory could
  // overwrite configuration the operator already has there.
  if (!adopted && input.seedFromAccountId) {
    const source = byId(input.seedFromAccountId);
    if (!source) throw new Error('The account to copy configuration from no longer exists.');
    if (source.harness !== harness) throw new Error('Configuration can only be copied from an account for the same harness.');
    seedFrom(harness, source.configDir, dir);
  }
  const at = now();
  const id = uid();
  db().prepare(`INSERT INTO agent_accounts (id,harness,label,config_dir,adopted,is_default,created_at,updated_at)
    VALUES (?,?,?,?,?,0,?,?)`).run(id, harness, label, dir, adopted ? 1 : 0, at, at);
  return byId(id)!;
}

export function rename(id: string, label: string): AgentAccount {
  const account = byId(id);
  if (!account) throw new Error('Account not found.');
  db().prepare('UPDATE agent_accounts SET label=?,updated_at=? WHERE id=?').run(cleanLabel(label), now(), id);
  return byId(id)!;
}

/** Exactly one default per harness, decided in one transaction. */
export function setDefault(id: string): AgentAccount {
  const account = byId(id);
  if (!account) throw new Error('Account not found.');
  db().transaction(() => {
    db().prepare('UPDATE agent_accounts SET is_default=0,updated_at=? WHERE harness=?').run(now(), account.harness);
    db().prepare('UPDATE agent_accounts SET is_default=1,updated_at=? WHERE id=?').run(now(), id);
  })();
  return byId(id)!;
}

/**
 * Forget an account. The directory is left on disk.
 *
 * Deleting it would destroy a login, a history and any plugins installed there,
 * and Wanigan has no way to put those back. Removing the row stops Wanigan
 * pointing sessions at the directory; removing the directory stays the
 * operator's own deliberate act.
 */
export function remove(id: string): { removed: boolean; configDir: string } {
  const account = byId(id);
  if (!account) throw new Error('Account not found.');
  if (account.isDefault) {
    const siblings = list(account.harness).filter((other) => other.id !== id);
    if (siblings.length) throw new Error(`Make another account the default first; "${account.label}" is what new sessions use.`);
  }
  db().prepare('DELETE FROM agent_accounts WHERE id=?').run(id);
  return { removed: true, configDir: account.configDir };
}

export function projectAccount(projectId: string, harness: string): AgentAccount | null {
  const row = db().prepare('SELECT account_id FROM project_accounts WHERE project_id=? AND harness=?')
    .get(projectId, harness) as { account_id: string } | undefined;
  return row ? byId(row.account_id) : null;
}

/** Passing null clears the project's saved choice, falling back to the default. */
export function setProjectAccount(projectId: string, harness: string, accountId: string | null): AgentAccount | null {
  if (accountId === null) {
    db().prepare('DELETE FROM project_accounts WHERE project_id=? AND harness=?').run(projectId, harness);
    return null;
  }
  const account = byId(accountId);
  if (!account) throw new Error('Account not found.');
  if (account.harness !== harness) throw new Error('That account belongs to a different harness.');
  db().prepare(`INSERT INTO project_accounts (project_id,harness,account_id) VALUES (?,?,?)
    ON CONFLICT(project_id,harness) DO UPDATE SET account_id=excluded.account_id`).run(projectId, harness, accountId);
  return account;
}

/**
 * Decide which account a launch will use, and say where the answer came from.
 *
 * `appliesToAnthropic` is the caller's answer to a question this module cannot
 * ask: a GLM or DeepSeek profile runs the same `claude-code` harness but points
 * `ANTHROPIC_BASE_URL` at another vendor and authenticates with that vendor's
 * credential. Offering a Claude account there would name a login the session
 * never uses.
 */
export function resolve(input: {
  harness: string; projectId?: string | null; explicitAccountId?: string | null; appliesToAnthropic?: boolean;
}): AccountResolution {
  const none = (reason: string): AccountResolution => ({ account: null, source: 'none', override: null, reason });
  if (!supportsAccounts(input.harness)) return none('This harness has no configuration directory Wanigan can switch.');
  if (input.appliesToAnthropic === false) {
    return none('This profile authenticates against another vendor, so a Claude account would not be the credential it uses.');
  }
  const override = OVERRIDING_ENV.find((key) => process.env[key]?.trim()) ?? null;
  const pick = (account: AgentAccount | null, source: AccountResolution['source']): AccountResolution | null =>
    account ? { account, source, override, reason: null } : null;

  if (input.explicitAccountId) {
    const chosen = byId(input.explicitAccountId);
    if (!chosen) throw new Error('The chosen account no longer exists.');
    if (chosen.harness !== input.harness) throw new Error('That account belongs to a different harness.');
    return pick(chosen, 'explicit')!;
  }
  const accounts = list(input.harness);
  if (!accounts.length) return none('No accounts are configured for this harness.');
  if (input.projectId) {
    const saved = pick(projectAccount(input.projectId, input.harness), 'project');
    if (saved) return saved;
  }
  return pick(accounts.find((account) => account.isDefault) ?? accounts[0], 'default')
    ?? none('No default account is set.');
}

/**
 * The environment a session needs to use this account, or nothing.
 *
 * Returned separately from the resolution so the caller decides where it lands
 * in the environment it builds — a provider pack must never be able to redirect
 * a credential directory, so this has to be applied after pack values, not
 * merged in among them.
 */
export function launchEnv(account: AgentAccount | null): Record<string, string> {
  if (!account) return {};
  const key = configEnvVar(account.harness);
  if (!key) return {};
  // Setting the variable to the platform default is NOT a no-op, which is the
  // trap this guard exists for. With CLAUDE_CONFIG_DIR unset, Claude Code reads
  // its state from ~/.claude.json, beside the directory. Set it to ~/.claude —
  // the very same directory — and it reads ~/.claude/.claude.json, inside it,
  // finds nothing, and reports a signed-in operator as logged out.
  //
  // Verified against `claude auth status --json`: unset reports loggedIn true
  // with the account's email and plan; set to ~/.claude reports loggedIn false.
  // So the account that *is* the default contributes no variable at all, which
  // reproduces exactly what running the CLI by hand does.
  //
  // Codex has not been probed for the same quirk (no Codex binary was on the
  // machine that wrote this). The guard is kept for it anyway because setting
  // nothing is the one choice that cannot differ from the by-hand CLI; probe
  // `CODEX_HOME=~/.codex codex login status` before relaxing it.
  if (account.configDir === platformDefaultDir(account.harness)) return {};
  return { [key]: account.configDir };
}

/**
 * Whether an account decision applies to this profile at all, or nothing when
 * the harness has no vendor-specific test and `supportsAccounts` alone decides.
 *
 * The Claude harness needs the test: GLM and DeepSeek run the same binary but
 * authenticate with another vendor's credential, so a Claude account would name
 * a login the session never uses. `redirected` is the caller's answer to
 * whether the resolved provider environment aims the Anthropic API elsewhere —
 * sessions.ts owns how that environment is built, so it is passed in rather
 * than reproduced here. Codex profiles have no such split today: the directory
 * is where the login, config and history live whatever the model backend.
 */
export function appliesTo(def: { harness: string; backendId?: string | null }, redirected: boolean): boolean | undefined {
  if (def.harness === 'claude-code') return usesAnthropicAccount({ harness: def.harness, backendId: def.backendId ?? '' }) && !redirected;
  return undefined;
}

/** The account recorded for a directory, when Wanigan knows it as one. */
export function byConfigDir(harness: string, dir: string): AgentAccount | null {
  const wanted = path.resolve(dir);
  return list(harness).find((account) => path.resolve(account.configDir) === wanted) ?? null;
}

/** The directory a recorded session used, for the readers that follow it. */
export function configDirForSession(sessionId: string): string | null {
  const row = db().prepare('SELECT account_id FROM session_log WHERE id=?').get(sessionId) as { account_id: string | null } | undefined;
  if (!row?.account_id) return null;
  return byId(row.account_id)?.configDir ?? null;
}

/** Every known directory for a harness, for readers that must scan them all. */
export function configDirs(harness: string): string[] {
  return list(harness).filter((account) => account.present).map((account) => account.configDir);
}

/**
 * Every directory a reader should look in for this harness.
 *
 * A superset of the accounts, deliberately. Launching is a decision — Wanigan's
 * chosen account must beat an inherited CLAUDE_CONFIG_DIR, or the picker would
 * be describing a session that ignored it. Reading is not a decision: an
 * operator who moved their config by hand has an exported CLAUDE_CONFIG_DIR and
 * no ~/.claude at all, and a reader that consulted only the accounts would
 * report their running sessions and transcripts as absent.
 *
 * Scanning a directory that holds nothing costs one failed readdir, so the
 * union is cheap; missing a directory that holds the answer is not.
 */
export function readRoots(harness: string): string[] {
  const roots = configDirs(harness);
  // The ambient value is still added: it is what the operator's own hand-run
  // CLI uses, and the observed lane exists to see sessions Wanigan did not
  // start. It is normally already the adopted account, so this is a no-op —
  // it matters when the variable changed after the account was seeded.
  const ambientVar = configEnvVar(harness);
  const ambient = ambientVar ? process.env[ambientVar]?.trim() : '';
  if (ambient) roots.push(path.resolve(ambient));
  return [...new Set(roots)];
}

/* ── native auto-memory, per session ─────────────────────────────────── */

/** Claude Code's slug for a working directory: every non-alphanumeric to '-'. */
function claudeProjectSlug(cwd: string): string {
  return path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Hook-observed writes into Claude Code's own auto-memory directory for one
 * recorded session — paths only, never a byte of what was written.
 *
 * The directory is `<config dir>/projects/<slug of cwd>/memory`, and the
 * config dir is the session's frozen account, not the default: a second
 * account's saves land under its own directory, and resolving from ~/.claude
 * would report an honest-looking zero for every one of them. When the row
 * predates account recording, every known directory for the harness is
 * checked and the answer says the account was unknown.
 *
 * Probed on this machine before writing this (CLI 2.1.261, 2026-09-05): 38
 * PostToolUse Write/Edit rows carried paths inside `.../projects/<slug>/memory/`,
 * so the saves are hook-visible. The same probe also matched a repository's
 * `vendor/.../memory/` files with a loose substring, which is why the count
 * below is a prefix match on the exact resolved directory and nothing wider.
 *
 * Both the worktree and the project path are slugged: which one Claude Code
 * keys the memory to for a linked worktree has not been verified, so both
 * candidate directories are reported and either counts.
 */
export function nativeMemoryWrites(sessionId: string): NativeMemoryWrites | null {
  const row = db().prepare(`
    SELECT harness_id, provider_id, account_id, project_path, worktree FROM session_log WHERE id = ?
  `).get(sessionId) as {
    harness_id: string | null; provider_id: string; account_id: string | null;
    project_path: string; worktree: string | null;
  } | undefined;
  if (!row) return null;
  const harness = row.harness_id ?? (row.provider_id === 'claude' || row.provider_id === 'glm' ? 'claude-code' : null);
  if (harness !== 'claude-code') {
    return { harness, memoryDirs: [], accountKnown: false, count: 0, files: [], note: 'Only the claude-code harness has a hook-visible auto-memory directory Wanigan knows how to locate.' };
  }
  const account = row.account_id ? byId(row.account_id) : null;
  const roots = account ? [account.configDir] : readRoots(harness);
  const cwds = [...new Set([row.worktree, row.project_path].filter((value): value is string => Boolean(value)))];
  const memoryDirs = [...new Set(roots.flatMap((root) =>
    cwds.map((cwd) => path.join(root, 'projects', claudeProjectSlug(cwd), 'memory'))))];
  const events = db().prepare(`
    SELECT paths_json FROM session_events
    WHERE session_id = ? AND event = 'PostToolUse' AND paths_json IS NOT NULL
      AND tool_name IN ('Write','Edit','MultiEdit','NotebookEdit')
  `).all(sessionId) as { paths_json: string }[];
  const files = new Set<string>();
  let count = 0;
  for (const event of events) {
    let paths: unknown;
    try { paths = JSON.parse(event.paths_json); } catch { continue; }
    if (!Array.isArray(paths)) continue;
    const hit = paths.find((candidate): candidate is string => typeof candidate === 'string'
      && memoryDirs.some((dir) => candidate === dir || candidate.startsWith(dir + path.sep)));
    if (!hit) continue;
    count++;
    if (files.size < 50) files.add(path.basename(hit));
  }
  return {
    harness,
    memoryDirs,
    accountKnown: account !== null,
    count,
    files: [...files],
    note: account
      ? null
      : row.account_id
        ? 'The account this session launched under has since been removed; every known directory was checked.'
        : 'Account at launch unknown (recorded before Wanigan tracked accounts); every known directory was checked.',
  };
}
