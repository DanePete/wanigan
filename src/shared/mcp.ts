// MCP servers: what each account has configured, a small store of well-known
// servers, and the pure rules for showing them safely. The core reads the files
// and runs the CLIs; nothing here does I/O.
//
// Where each agent keeps them, as verified on October 6, 2026 against a
// throwaway config folder (never the owner's):
// - Claude Code 2.1.292: user scope in `mcpServers` of its state file
//   (`.claude.json` beside ~/.claude, or inside CLAUDE_CONFIG_DIR), local scope
//   under `projects[<folder>].mcpServers` in that same file, project scope in
//   `<project>/.mcp.json`. `claude mcp list` health-checks every server it lists
//   (it launches stdio servers), so it runs only when the owner asks.
// - Codex 0.155.1: `[mcp_servers.<name>]` in `$CODEX_HOME/config.toml`, plus a
//   project's `.codex/config.toml` only when that project is trusted.
//   `codex mcp add|remove` change only the global file; `remove` exits 0 even
//   when nothing was removed, and `add --url` starts a browser sign-in at once.
// - Gemini CLI 0.46 (read from its bundle and run against a throwaway home, no
//   network, on October 9, 2026): `mcpServers` in `~/.gemini/settings.json`
//   (user) and `<project>/.gemini/settings.json` (project; JSON with comments).
//   It loads no MCP server at all, user ones included, in a folder it does not
//   trust. `url` is Streamable HTTP unless `type` says "sse"; `httpUrl` is the
//   older spelling. `gemini mcp add|remove --scope user|project` (default
//   project): `add` overwrites a server of the same name and exits 0, `remove`
//   exits 0 when there was nothing to remove, and in a folder it does not trust
//   `add --scope project` writes the file back with only its MCP servers and
//   `remove` finds nothing, so a project change runs with
//   GEMINI_CLI_TRUST_WORKSPACE=true (that one command, no trust written).
//   `gemini mcp enable|disable` cannot find any server in 0.46; `/mcp disable`
//   in a session writes `~/.gemini/mcp-server-enablement.json`. OAuth servers
//   sign in from a session with `/mcp auth <name>`.
import type { AccountProvider } from './model.ts';

export type McpAgent = AccountProvider | 'gemini';
export type McpTransport = 'stdio' | 'http' | 'sse' | 'ws' | 'unknown';
export type McpScope = 'user' | 'local' | 'project' | 'plugin';

export interface McpPair {
  key: string;
  /** The value, or `•••` when it looks secret. */
  value: string;
  redacted: boolean;
}

export interface McpServer {
  /** Opaque; the core maps it back to the file it read. */
  id: string;
  name: string;
  agent: McpAgent;
  transport: McpTransport;
  /** The URL, or the command and its arguments, with anything secret-looking shown as •••. */
  target: string;
  env: McpPair[];
  headers: McpPair[];
  scope: McpScope;
  /** The account whose configuration holds it (null for a project's own file). */
  accountId: string | null;
  projectId: string | null;
  /** For local scope: the folder it belongs to, as the owner would type it. */
  folder: string | null;
  /** The file it is defined in, as the owner would type it. */
  definedIn: string;
  /** Wanigan can remove it through the agent's own CLI. */
  removable: boolean;
  enabled: boolean;
  note: string | null;
  /** The store entry it matches, if any. */
  catalogId: string | null;
  /** Gemini CLI only: why Wanigan's Gemini sessions do not get this server (it holds a value that could be a secret), or null when they do. */
  notInWanigan?: string | null;
}

export interface McpGroup {
  id: string;
  agent: McpAgent;
  title: string;
  account: string | null;
  projectId: string | null;
  where: string;
  note: string | null;
  servers: McpServer[];
  /** What "Check connections" runs as, and where; null when the agent has no check. */
  check: { accountId: string; projectId: string | null } | null;
}

export type McpTone = 'ok' | 'fail' | 'auth' | 'pending' | 'off' | 'unknown';

export interface McpCheckResult {
  name: string;
  /** The CLI's own words, e.g. "Connected", "Failed to connect", "Needs authentication". */
  status: string;
  tone: McpTone;
  issue: string | null;
}

export interface McpCheck {
  accountId: string;
  projectId: string | null;
  at: number;
  results: McpCheckResult[];
  error: string | null;
}

export interface McpListing {
  groups: McpGroup[];
  /** Accounts and files looked in that hold no servers. */
  empty: { agent: McpAgent; where: string }[];
  checks: McpCheck[];
  notes: string[];
}

/* ── the store ─────────────────────────────────────────────────────────── */

export interface McpCatalogEntry {
  id: string;
  name: string;
  /** The name it is added under. */
  server: string;
  publisher: string;
  purpose: string;
  /** The publisher's own page the install details were checked against. */
  source: string;
  transport: 'http' | 'stdio';
  auth: 'none' | 'oauth' | 'key';
  /** A key the command needs. Wanigan never takes it: the owner types it in a terminal. */
  key: { placeholder: string; what: string } | null;
  /** Arguments after `claude mcp add` (Wanigan adds `--scope`). */
  claude: { args: string[]; documented: boolean; note?: string } | null;
  /** Arguments after `codex mcp add`. */
  codex: { args: string[]; documented: boolean; note?: string } | null;
  /** Arguments after `gemini mcp add` (Wanigan adds `--scope`). */
  gemini: { args: string[]; documented: boolean; note?: string } | null;
  /** What has to be installed for it to start. */
  needs: string | null;
  note: string | null;
  /** How an installed server is recognised as this one: URL prefixes or package names. */
  match: string[];
}

/**
 * Twelve well-known servers, each checked on October 6, 2026 against the
 * publisher's own documentation. `documented: false` marks a command Wanigan
 * translated from the publisher's JSON or TOML. Every Gemini CLI command is
 * Wanigan's translation, run against Gemini CLI 0.46 with a throwaway home to
 * see what it writes; none was checked against a publisher's Gemini page. Left out on purpose: the MCP
 * Filesystem server (agents already have file tools; Codex needs a folder
 * argument), the reference Postgres server (archived and deprecated on npm; its
 * connection string carries a password), and Slack (its Codex instructions do
 * not match Codex 0.155.1, and its Claude route is a plugin with a fixed app id).
 */
export const MCP_CATALOG: readonly McpCatalogEntry[] = [
  {
    id: 'github', name: 'GitHub', server: 'github', publisher: 'GitHub',
    purpose: 'Repositories, issues, pull requests, Actions and code search.',
    source: 'https://github.com/github/github-mcp-server',
    transport: 'http', auth: 'key', key: { placeholder: 'YOUR_GITHUB_PAT', what: 'a GitHub personal access token' },
    claude: { args: ['--transport', 'http', 'github', 'https://api.githubcopilot.com/mcp/', '--header', 'Authorization: Bearer YOUR_GITHUB_PAT'], documented: true },
    codex: {
      args: ['github', '--url', 'https://api.githubcopilot.com/mcp/', '--bearer-token-env-var', 'GITHUB_PAT_TOKEN'], documented: true,
      note: 'Codex reads the token from GITHUB_PAT_TOKEN in the environment it runs in.',
    },
    gemini: { args: ['--transport', 'http', 'github', 'https://api.githubcopilot.com/mcp/', '--header', 'Authorization: Bearer YOUR_GITHUB_PAT'], documented: false },
    needs: null, note: 'GitHub’s remote server takes a personal access token; it has no browser sign-in for these CLIs.',
    match: ['https://api.githubcopilot.com/mcp'],
  },
  {
    id: 'playwright', name: 'Playwright', server: 'playwright', publisher: 'Microsoft',
    purpose: 'Drive a real browser through accessibility snapshots.',
    source: 'https://github.com/microsoft/playwright-mcp',
    transport: 'stdio', auth: 'none', key: null,
    claude: { args: ['playwright', 'npx', '@playwright/mcp@latest'], documented: true },
    codex: { args: ['playwright', '--', 'npx', '@playwright/mcp@latest'], documented: true },
    gemini: { args: ['playwright', 'npx', '@playwright/mcp@latest'], documented: false },
    needs: 'Node.js 18 or later', note: null,
    match: ['@playwright/mcp'],
  },
  {
    id: 'figma', name: 'Figma', server: 'figma', publisher: 'Figma',
    purpose: 'Read Figma designs into code, and write designs back.',
    source: 'https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/',
    transport: 'http', auth: 'oauth', key: null,
    claude: { args: ['--transport', 'http', 'figma', 'https://mcp.figma.com/mcp'], documented: true },
    codex: { args: ['figma', '--url', 'https://mcp.figma.com/mcp'], documented: true },
    gemini: { args: ['--transport', 'http', 'figma', 'https://mcp.figma.com/mcp'], documented: false },
    needs: null, note: 'How many calls you get depends on your Figma plan and seat.',
    match: ['https://mcp.figma.com/mcp'],
  },
  {
    id: 'linear', name: 'Linear', server: 'linear', publisher: 'Linear',
    purpose: 'Find, create and update issues, projects and comments.',
    source: 'https://linear.app/docs/mcp',
    transport: 'http', auth: 'oauth', key: null,
    claude: { args: ['--transport', 'http', 'linear', 'https://mcp.linear.app/mcp'], documented: true },
    codex: { args: ['linear', '--url', 'https://mcp.linear.app/mcp'], documented: true },
    gemini: { args: ['--transport', 'http', 'linear', 'https://mcp.linear.app/mcp'], documented: false },
    needs: null, note: null,
    match: ['https://mcp.linear.app/'],
  },
  {
    id: 'sentry', name: 'Sentry', server: 'sentry', publisher: 'Sentry',
    purpose: 'Search errors, traces and issues, and triage them.',
    source: 'https://mcp.sentry.dev/',
    transport: 'http', auth: 'oauth', key: null,
    claude: { args: ['--transport', 'http', 'sentry', 'https://mcp.sentry.dev/mcp'], documented: true },
    codex: { args: ['sentry', '--url', 'https://mcp.sentry.dev/mcp'], documented: false },
    gemini: { args: ['--transport', 'http', 'sentry', 'https://mcp.sentry.dev/mcp'], documented: false },
    needs: null, note: null,
    match: ['https://mcp.sentry.dev/'],
  },
  {
    id: 'context7', name: 'Context7', server: 'context7', publisher: 'Upstash',
    purpose: 'Current, version-specific library docs, fetched into the prompt.',
    source: 'https://github.com/upstash/context7',
    transport: 'http', auth: 'none', key: null,
    claude: { args: ['--transport', 'http', 'context7', 'https://mcp.context7.com/mcp'], documented: false },
    codex: { args: ['context7', '--', 'npx', '-y', '@upstash/context7-mcp'], documented: true },
    gemini: { args: ['--transport', 'http', 'context7', 'https://mcp.context7.com/mcp'], documented: false },
    needs: 'Node.js, for Codex', note: 'Works without a key at a lower rate limit.',
    match: ['https://mcp.context7.com/', '@upstash/context7-mcp'],
  },
  {
    id: 'notion', name: 'Notion', server: 'notion', publisher: 'Notion',
    purpose: 'Search, read and edit pages and databases.',
    source: 'https://developers.notion.com/docs/get-started-with-mcp',
    transport: 'http', auth: 'oauth', key: null,
    claude: { args: ['--transport', 'http', 'notion', 'https://mcp.notion.com/mcp'], documented: true },
    codex: { args: ['notion', '--url', 'https://mcp.notion.com/mcp'], documented: false },
    gemini: { args: ['--transport', 'http', 'notion', 'https://mcp.notion.com/mcp'], documented: false },
    needs: null, note: null,
    match: ['https://mcp.notion.com/'],
  },
  {
    id: 'cloudflare', name: 'Cloudflare', server: 'cloudflare-api', publisher: 'Cloudflare',
    purpose: 'The whole Cloudflare API through a small set of tools.',
    source: 'https://github.com/cloudflare/mcp',
    transport: 'http', auth: 'oauth', key: null,
    claude: { args: ['--transport', 'http', 'cloudflare-api', 'https://mcp.cloudflare.com/mcp'], documented: false },
    codex: { args: ['cloudflare-api', '--url', 'https://mcp.cloudflare.com/mcp'], documented: false },
    gemini: { args: ['--transport', 'http', 'cloudflare-api', 'https://mcp.cloudflare.com/mcp'], documented: false },
    needs: null, note: 'You choose its permissions when you sign in.',
    match: ['https://mcp.cloudflare.com/'],
  },
  {
    id: 'stripe', name: 'Stripe', server: 'stripe', publisher: 'Stripe',
    purpose: 'Customers, payments and Stripe’s docs.',
    source: 'https://docs.stripe.com/mcp',
    transport: 'http', auth: 'oauth', key: null,
    claude: { args: ['--transport', 'http', 'stripe', 'https://mcp.stripe.com/'], documented: true },
    codex: { args: ['stripe', '--url', 'https://mcp.stripe.com'], documented: true },
    gemini: { args: ['--transport', 'http', 'stripe', 'https://mcp.stripe.com'], documented: false },
    needs: null, note: null,
    match: ['https://mcp.stripe.com'],
  },
  {
    id: 'vercel', name: 'Vercel', server: 'vercel', publisher: 'Vercel',
    purpose: 'Projects, deployments, logs and Vercel’s docs.',
    source: 'https://vercel.com/docs/agent-resources/vercel-mcp',
    transport: 'http', auth: 'oauth', key: null,
    claude: { args: ['--transport', 'http', 'vercel', 'https://mcp.vercel.com'], documented: true },
    codex: { args: ['vercel', '--url', 'https://mcp.vercel.com'], documented: true },
    gemini: { args: ['--transport', 'http', 'vercel', 'https://mcp.vercel.com'], documented: false },
    needs: null, note: null,
    match: ['https://mcp.vercel.com'],
  },
  {
    id: 'supabase', name: 'Supabase', server: 'supabase', publisher: 'Supabase',
    purpose: 'Manage Supabase projects and query their databases.',
    source: 'https://supabase.com/docs/guides/getting-started/mcp',
    transport: 'http', auth: 'oauth', key: null,
    claude: { args: ['--transport', 'http', 'supabase', 'https://mcp.supabase.com/mcp'], documented: false },
    codex: { args: ['supabase', '--url', 'https://mcp.supabase.com/mcp'], documented: false },
    gemini: { args: ['--transport', 'http', 'supabase', 'https://mcp.supabase.com/mcp'], documented: false },
    needs: null, note: 'Without a project_ref in the URL it can reach every project in your organisation.',
    match: ['https://mcp.supabase.com/'],
  },
  {
    id: 'fetch', name: 'Fetch', server: 'fetch', publisher: 'MCP steering group',
    purpose: 'Fetch a web page and hand it back as Markdown.',
    source: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch',
    transport: 'stdio', auth: 'none', key: null,
    claude: { args: ['fetch', '--', 'uvx', 'mcp-server-fetch'], documented: false },
    codex: { args: ['fetch', '--', 'uvx', 'mcp-server-fetch'], documented: false },
    gemini: { args: ['fetch', 'uvx', 'mcp-server-fetch'], documented: false },
    needs: 'uv (Python)', note: 'It can reach local and internal addresses.',
    match: ['mcp-server-fetch'],
  },
];

/** Which store entry an installed server is, by its URL or command. */
export function catalogMatch(target: { url?: string | null; command?: string | null; args?: string[] }): string | null {
  const url = target.url?.toLowerCase() ?? '';
  const command = [target.command ?? '', ...(target.args ?? [])].join(' ');
  for (const entry of MCP_CATALOG) {
    if (entry.match.some((m) => (m.startsWith('https://') ? url.startsWith(m.toLowerCase()) : command.includes(m)))) return entry.id;
  }
  return null;
}

/* ── secrets ───────────────────────────────────────────────────────────── */

export const HIDDEN = '•••';

const SECRET_NAME = /(token|secret|passw|pwd|api[-_]?key|apikey|auth|credential|private|session|cookie|bearer|signature|access[-_]?key|client[-_]?id|dsn|conn)/i;
const SECRET_PREFIX = [
  /^(sk|pk|rk)[-_][A-Za-z0-9_-]{8,}/, /^gh[pousr]_[A-Za-z0-9]{16,}/, /^github_pat_/, /^xox[abposr]-/, /^glpat-/, /^AKIA[0-9A-Z]{12,}/,
  /^eyJ[A-Za-z0-9_-]{8,}\./, /^lin_(api|oauth)_/, /^ntn_/, /^secret_/, /^sntrys_/, /^sbp_/, /^re_[A-Za-z0-9]{12,}/, /^(Bearer|Basic|Token)\s+\S/i,
];
const REFERENCE = /\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$[A-Za-z_][A-Za-z0-9_]*/g;

/** Defaults can contain credentials, even under an ordinary key. Hide the whole
 * value without interpreting shell syntax. Decode one layer of ASCII percent
 * escapes for URL displays; unrelated malformed escapes must not bypass this. */
function hasFallback(value: string): boolean {
  const decoded = value.replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  return /\$\{[A-Za-z_][A-Za-z0-9_]*:-/.test(decoded);
}

/** Whether a value reads like a credential: a known token shape, or a long opaque string. */
export function looksSecret(value: string): boolean {
  const v = value.trim();
  if (!v) return false;
  if (SECRET_PREFIX.some((re) => re.test(v))) return true;
  if (v.length >= 20 && /^[A-Za-z0-9_\-+/=.:]+$/.test(v) && /[0-9]/.test(v) && /[A-Za-z]/.test(v)
    && !v.startsWith('/') && !v.startsWith('@') && !v.includes('://') && !/^[\w.-]+\/[\w.-]+(@[\w.-]+)?$/.test(v)) return true;
  return false;
}

/** A value that only names environment variables (`${GITHUB_TOKEN}`, `Bearer $TOKEN`) holds no secret itself. */
export function onlyReferences(value: string): boolean {
  if (!value.match(REFERENCE)) return false;
  const rest = value.replace(REFERENCE, '').trim();
  return !rest || /^(Bearer|Basic|Token)$/i.test(rest);
}

/** An environment variable or header, shown or hidden. */
export function pair(key: string, raw: unknown): McpPair {
  const value = typeof raw === 'string' ? raw : raw === undefined || raw === null ? '' : JSON.stringify(raw);
  if (hasFallback(value)) return { key, value: HIDDEN, redacted: true };
  if (onlyReferences(value)) return { key, value, redacted: false };
  const secret = SECRET_NAME.test(key) || looksSecret(value) || (value.length > 40 && !/\s/.test(value));
  return secret ? { key, value: HIDDEN, redacted: true } : { key, value: redactText(value), redacted: false };
}

/** A URL with its password, secret-looking query values and token-like path parts hidden. */
export function redactUrl(raw: string): string {
  if (hasFallback(raw)) return HIDDEN;
  let url: URL;
  try { url = new URL(raw); } catch { return looksSecret(raw) ? HIDDEN : raw; }
  const mark = 'WANIGANHIDDEN';
  if (url.password) url.password = mark;
  for (const [k, v] of [...url.searchParams]) if (SECRET_NAME.test(k) || looksSecret(v)) url.searchParams.set(k, mark);
  url.pathname = url.pathname.split('/').map((p) => (looksSecret(safeDecode(p)) ? mark : p)).join('/');
  return url.toString().replaceAll(mark, HIDDEN);
}

/** Command-line arguments with secrets hidden: after a secret flag, in `--flag=value`, `KEY=value`, URLs and token shapes. */
export function redactArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  let hideNext = false;
  for (const raw of args) {
    const arg = String(raw);
    if (hideNext) { out.push(onlyReferences(arg) ? arg : HIDDEN); hideNext = false; continue; }
    const flag = /^(--?[A-Za-z][\w-]*)(=(.*))?$/.exec(arg);
    if (flag) {
      if (flag[2] !== undefined) {
        out.push(SECRET_NAME.test(flag[1] as string) && !onlyReferences(flag[3] ?? '') ? `${flag[1]}=${HIDDEN}` : `${flag[1]}=${redactValue(flag[3] ?? '')}`);
      } else {
        out.push(arg);
        if (SECRET_NAME.test(arg) || arg === '-k' || arg === '-p') hideNext = true;
      }
      continue;
    }
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(arg);
    if (assignment) {
      const p = pair(assignment[1] as string, assignment[2]);
      out.push(`${assignment[1]}=${p.value}`);
      continue;
    }
    out.push(redactValue(arg));
  }
  return out;
}

function safeDecode(v: string): string {
  try { return decodeURIComponent(v); } catch { return v; }
}

function redactValue(v: string): string {
  if (hasFallback(v)) return HIDDEN;
  if (onlyReferences(v)) return v;
  // A header passed as an argument: `Authorization: Bearer …`.
  const header = /^([A-Za-z][\w-]*):\s+(.+)$/.exec(v);
  if (header && !/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) {
    const p = pair(header[1] as string, header[2]);
    return `${header[1]}: ${p.value}`;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return redactUrl(v);
  return looksSecret(v) ? HIDDEN : v;
}

/** Free text from a CLI (an error, an issue) with URLs and token shapes hidden. */
export function redactText(text: string): string {
  if (hasFallback(text)) return HIDDEN;
  return text
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)]+/gi, (u) => redactUrl(u))
    .split(/(\s+)/).map((w) => (/\s/.test(w) || !looksSecret(w.replace(/[.,;:]+$/, '')) ? w : HIDDEN)).join('');
}

/* ── what Wanigan's Gemini sessions may be given ───────────────────────── */

/** A setting's name that says its value is a credential. */
const CREDENTIAL_KEY = /(token|secret|passw|pwd|api[-_]?key|apikey|key$|auth|credential|cookie|bearer|signature|session|private)/i;
/** Settings of a Gemini server that hold no credential by what they are (names, numbers, choices). */
const PLAIN_FIELDS = new Set(['type', 'timeout', 'trust', 'description', 'includeTools', 'excludeTools', 'cwd', 'tcp', 'authProviderType', 'targetAudience', 'targetServiceAccount']);

/**
 * A value Gemini CLI fills in from the environment, holding nothing itself:
 * empty, or only `$NAME` / `${NAME}` references (optionally after Bearer,
 * Basic or Token). Gemini 0.46 expands those in every string of its settings
 * (resolveEnvVarsInString, seen run); `${NAME:-default}` is refused here,
 * because its default is a literal written into the file.
 */
function fromEnvironment(value: unknown): boolean {
  return typeof value === 'string' && (value === '' || (!hasFallback(value) && onlyReferences(value)));
}

/** Whether an address carries something that could be a credential: a password or name in it, a credential-named or token-like query value, a token-like path part. */
function addressHoldsSecret(raw: string): boolean {
  if (hasFallback(raw)) return true;
  let url: URL;
  try { url = new URL(raw.replace(REFERENCE, 'wanigan-ref')); } catch { return true; }
  if ((url.username && url.username !== 'wanigan-ref') || (url.password && url.password !== 'wanigan-ref')) return true;
  for (const [k, v] of url.searchParams) if (v !== 'wanigan-ref' && (CREDENTIAL_KEY.test(k) || looksSecret(v))) return true;
  return url.pathname.split('/').some((part) => looksSecret(safeDecode(part)));
}

/**
 * Why a Gemini MCP server is not copied into Wanigan's Gemini home, in plain
 * words, or null when it may be. Wanigan reads, copies and stores no
 * credential, so a server goes in only when nothing in it could be one: its
 * env and headers come from the environment, its command line and address
 * hold nothing token-like, and no other setting does. When in doubt it stays
 * out. The value is never repeated.
 */
export function geminiNotCopied(raw: unknown): string | null {
  const out = (what: string, fix = 'move it into an environment variable and write $NAME in its place') =>
    `Not in Wanigan’s Gemini sessions: ${what}, and Wanigan copies nothing that could be a secret. To use it there, ${fix}.`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out('Wanigan could not read its entry', 'check the entry in settings.json');
  const r = raw as Record<string, unknown>;
  for (const field of ['env', 'headers'] as const) {
    const values = r[field];
    if (values === undefined) continue;
    if (!values || typeof values !== 'object' || Array.isArray(values)) return out(`its ${field} is not a list of names and values`, 'check the entry in settings.json');
    for (const [name, value] of Object.entries(values)) {
      if (fromEnvironment(value)) continue;
      return field === 'env'
        ? out(`its environment variable ${name} is written into the file`, `set ${name} in your environment and write "$${name}" in settings.json instead`)
        : out(`its ${name} header is written into the file`, `put the value in an environment variable and write it as a reference, such as "Bearer $TOKEN"`);
    }
  }
  const args = r.args ?? [];
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) return out('its arguments are not a list of words', 'check the entry in settings.json');
  if (r.command !== undefined && typeof r.command !== 'string') return out('its command is not a word', 'check the entry in settings.json');
  const line = [...(typeof r.command === 'string' ? [r.command] : []), ...(args as string[])];
  if (redactArgs(line).some((a, i) => a !== line[i])) return out('its command line holds what looks like a key, token or password');
  for (const key of ['url', 'httpUrl']) {
    if (r[key] === undefined) continue;
    if (typeof r[key] !== 'string' || addressHoldsSecret(r[key] as string)) return out('its address holds what looks like a key, token or password');
  }
  const handled = new Set(['env', 'headers', 'args', 'command', 'url', 'httpUrl']);
  const visit = (value: unknown, path: string[]): string | null => {
    if (typeof value === 'string') {
      const key = path[path.length - 1] ?? '';
      const named = !PLAIN_FIELDS.has(path[0] ?? '') && CREDENTIAL_KEY.test(key);
      // An OAuth tokenUrl or authorizationUrl is an address, judged as one.
      const address = /^https?:\/\//i.test(value);
      const secret = address ? addressHoldsSecret(value)
        : (named && !fromEnvironment(value)) || (looksSecret(value) && !onlyReferences(value));
      return secret ? path.join('.') : null;
    }
    if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) {
        const found = visit(v, [...path, k]);
        if (found) return found;
      }
    }
    return null;
  };
  for (const [key, value] of Object.entries(r)) {
    if (handled.has(key)) continue;
    const found = visit(value, [key]);
    if (found) return out(`its ${found} setting holds what looks like a credential`);
  }
  return null;
}

/** A shell-ready rendering of an argument list, for showing and for typing into a terminal. */
export function shellJoin(args: readonly string[]): string {
  // `•••` is shown, never typed, so it needs no quoting.
  return args.map((a) => (/^[A-Za-z0-9_@%+=:,./•-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ');
}

/* ── `claude mcp list` ─────────────────────────────────────────────────── */

const STATUS = /^(?:[✓✔✘✗!⏸⊘⚠△]|-) /u;

/**
 * Read `claude mcp list` output: `<name>: <url or command> - <status>`. Only
 * the name and the status are kept; the middle can hold arguments, and those
 * are never passed through. Names Wanigan already knows are matched first, since
 * a claude.ai connector or plugin server can have colons and spaces in its name.
 */
export function parseClaudeMcpList(output: string, known: readonly string[]): McpCheckResult[] {
  const results: McpCheckResult[] = [];
  const names = [...known].sort((a, b) => b.length - a.length);
  // eslint-disable-next-line no-control-regex
  for (const raw of output.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').split('\n')) {
    const line = raw.trim();
    if (!line || /^Checking MCP server health/.test(line)) continue;
    let at = -1;
    for (let i = line.indexOf(' - '); i !== -1; i = line.indexOf(' - ', i + 1)) {
      if (STATUS.test(line.slice(i + 3))) { at = i; break; }
    }
    if (at === -1) continue;
    const head = line.slice(0, at);
    const name = names.find((n) => head.startsWith(`${n}: `) || head === n) ?? head.slice(0, Math.max(0, head.indexOf(': '))) ?? '';
    if (!name) continue;
    const said = line.slice(at + 3);
    const [statusPart, ...issueParts] = said.split(' — ');
    const status = (statusPart ?? '').replace(STATUS, '').trim();
    const glyph = (statusPart ?? '').trim()[0] ?? '';
    const tone: McpTone = /needs auth/i.test(status) ? 'auth'
      : glyph === '✓' || glyph === '✔' ? 'ok'
        : glyph === '✘' || glyph === '✗' ? 'fail'
          : glyph === '⏸' ? 'pending'
            : glyph === '⊘' ? 'off'
              : glyph === '!' || glyph === '⚠' || glyph === '△' ? 'auth' : 'unknown';
    results.push({ name, status: status.replace(/\s*\(.*\)$/, ''), tone, issue: issueParts.length ? redactText(issueParts.join(' — ')).slice(0, 300) : null });
  }
  return results;
}

/* ── adding and removing ───────────────────────────────────────────────── */

export interface McpPlan {
  agent: McpAgent;
  /** The CLI and its arguments, exactly as they will run (or be typed). */
  argv: string[];
  /** The account's folder variable, when the account is not the CLI's default. */
  env: { name: string; value: string } | null;
  /** Where it runs. */
  cwd: string;
  /** The same thing as one line for a terminal. */
  command: string;
  effect: string;
  /** The file the CLI changes, as the owner would type it. */
  file: string;
  /** `run`: Wanigan runs it now. `terminal`: it needs the owner (a key, or a browser sign-in). */
  mode: 'run' | 'terminal';
  why: string | null;
  /** A server of that name is already there; adding is refused. */
  exists: boolean;
  /** What to do afterwards, if anything. */
  after: string | null;
}

export interface McpAddParams {
  catalogId: string;
  /** The account it is added for. Gemini CLI has no accounts: leave it out and name the agent. */
  accountId?: string | null;
  /** Gemini CLI, which has one sign-in rather than accounts. */
  agent?: 'gemini';
  scope: Exclude<McpScope, 'plugin'>;
  projectId?: string | null;
}
