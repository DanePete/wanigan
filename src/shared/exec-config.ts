/**
 * A repository's executable configuration, as items that can be pinned.
 *
 * An agent CLI started in a repository runs some of that repository's own
 * configuration before the agent does anything: hooks, MCP server commands,
 * helper commands, environment overrides, permission defaults, git hooks and
 * git config drivers. Every one of those can be changed by a commit, a pull, or
 * an agent working in that repository. The 2025–26 record for agent CLIs is
 * largely this class — repository settings that ran hooks or MCP entries before
 * the trust prompt (CVE-2025-59536), a repo-set ANTHROPIC_BASE_URL that sent the
 * key elsewhere (CVE-2026-21852), a committed `defaultMode: bypassPermissions`
 * (CVE-2026-33068), an approved MCP config swapped without a re-prompt
 * (Cursor's MCPoison), one harness running another harness's hook config
 * (CVE-2026-48124), a git fsmonitor used to escape a sandbox (CVE-2026-55607).
 *
 * This module turns what was read into items with a stable identity and a
 * fingerprint of the full value. The fingerprint is taken over the value before
 * anything is redacted for display, so a change hidden behind a redaction —
 * a new API host behind "…redacted", a different env value never shown — still
 * changes the digest. What the operator is shown is `shown`, which never carries
 * an environment value or a credential.
 *
 * Only what the repository controls is here. The user's own ~/.claude settings
 * are the user's decision, not something a clone can change under them.
 *
 * Pure: the caller supplies the hash function, so the renderer can import the
 * types and the diff, and the test runs without Electron.
 */

export type ExecItemKind =
  | 'hook' | 'mcp' | 'env' | 'permission' | 'helper' | 'sandbox' | 'plugin'
  | 'codex' | 'git-hook' | 'git-config' | 'dotenv';

export type ExecItem = {
  /** Stable identity: the same setting in the same place keeps the same id across edits to its value. */
  id: string;
  kind: ExecItemKind;
  /** Where it lives, relative to the repository root, or "git config". */
  file: string;
  /** What it is, in a few words. */
  label: string;
  /** What it runs or sets, redacted and bounded. Never an environment value. */
  shown: string;
  /** Hash of the full, unredacted value. */
  fingerprint: string;
};

export type ExecSnapshot = {
  items: ExecItem[];
  /** Files that exist but could not be read or parsed; they count toward the digest so an unreadable file cannot hide a change. */
  unreadable: string[];
  digest: string;
};

export type ExecDiff = { added: ExecItem[]; removed: ExecItem[]; changed: { before: ExecItem; after: ExecItem }[] };

/** none: nothing executable · accepted: matches a pin · first-use: no pin yet · changed: matches no pin. */
export type ConfigPinState = 'none' | 'accepted' | 'first-use' | 'changed';

export type ConfigPinCheck = {
  state: ConfigPinState;
  snapshot: ExecSnapshot;
  summary: string;
  /** Against the newest accepted pin; null when there is none to compare with. */
  diff: ExecDiff | null;
  lastAccepted: { how: 'first-use' | 'reviewed'; at: number; root: string } | null;
};

export type Hash = (text: string) => string;

const SHOWN_MAX = 240;

function clip(text: string, max = SHOWN_MAX): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** JSON with keys sorted at every depth, so formatting and key order never change a fingerprint. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

const SECRET_WORD = /(?:key|token|secret|password|passwd|auth|credential|bearer|session|cookie)/i;

/** A command line with anything that looks like a credential hidden. */
function redactCommand(text: string): string {
  return text
    .replace(/(--?[\w-]*(?:key|token|secret|password|auth)[\w-]*[= ])\S+/gi, '$1…')
    .replace(/\b(sk-[\w-]{6})[\w-]+/g, '$1…')
    .replace(/\b(gh[pousr]_)\w+/g, '$1…')
    .replace(/(https?:\/\/)[^@/\s]+@/g, '$1…@');
}

/** A URL reduced to scheme, host and path — no userinfo, query or fragment. */
function urlShown(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}${url.pathname === '/' ? '' : url.pathname}`;
  } catch {
    return 'an unparseable URL';
  }
}

function envShown(name: string, value: unknown): string {
  const text = typeof value === 'string' ? value : canonicalJson(value);
  // A base URL is where requests — and the key that authorises them — are sent,
  // so its host is the one environment value the operator must be able to see.
  if (/(?:_BASE_URL|_API_URL|_ENDPOINT|_HOST|PROXY)$/i.test(name) && /^https?:\/\//i.test(text)) return `${name} → ${urlShown(text)}`;
  return `${name} is set (value not shown)`;
}

function handlerShown(handler: Record<string, unknown>): string {
  const type = typeof handler.type === 'string' ? handler.type : 'command';
  if (type === 'http' && typeof handler.url === 'string') return `POST ${urlShown(handler.url)}`;
  if (type === 'command' && typeof handler.command === 'string') return redactCommand(handler.command);
  if (type === 'command' && Array.isArray(handler.args)) return redactCommand(handler.args.filter((a) => typeof a === 'string').join(' '));
  if (type === 'mcp_tool') return `MCP tool ${String(handler.server ?? '?')}/${String(handler.tool ?? '?')}`;
  if (type === 'prompt' || type === 'agent') return `${type} hook (asks a model)`;
  return `${type} hook`;
}

const HELPER_KEYS = ['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'otelHeadersHelper', 'gcpAuthRefresh'] as const;
const POLICY_KEYS = ['enableAllProjectMcpServers', 'enabledMcpjsonServers', 'disabledMcpjsonServers', 'forceLoginMethod', 'disableAllHooks'] as const;

/** One Claude Code settings file the repository controls (`.claude/settings.json`, `.claude/settings.local.json`). */
export function claudeSettingsItems(file: string, json: unknown, hash: Hash): ExecItem[] {
  if (!isRecord(json)) return [];
  const out: ExecItem[] = [];
  const item = (kind: ExecItemKind, key: string, label: string, shown: string, value: unknown) =>
    out.push({ id: `${kind}:${file}:${key}`, kind, file, label, shown: clip(shown), fingerprint: hash(canonicalJson(value)) });

  if (isRecord(json.hooks)) {
    for (const [event, groupsRaw] of Object.entries(json.hooks)) {
      const groups = Array.isArray(groupsRaw) ? groupsRaw : [groupsRaw];
      groups.forEach((group, g) => {
        if (!isRecord(group)) return;
        const matcher = typeof group.matcher === 'string' && group.matcher ? ` (${group.matcher})` : '';
        const handlers = Array.isArray(group.hooks) ? group.hooks : [];
        handlers.forEach((handler, h) => {
          if (!isRecord(handler)) return;
          item('hook', `hooks.${event}.${g}.${h}`, `${event} hook${matcher}`, handlerShown(handler), { matcher: group.matcher ?? null, handler });
        });
      });
    }
  }
  if (isRecord(json.env)) {
    for (const [name, value] of Object.entries(json.env)) item('env', `env.${name}`, `Environment ${name}`, envShown(name, value), value);
  }
  const permissions = isRecord(json.permissions) ? json.permissions : null;
  if (permissions) {
    if (permissions.defaultMode !== undefined) item('permission', 'permissions.defaultMode', 'Default permission mode', String(permissions.defaultMode), permissions.defaultMode);
    if (Array.isArray(permissions.allow)) {
      for (const rule of permissions.allow) {
        if (typeof rule === 'string') item('permission', `permissions.allow.${rule}`, 'Allowed without asking', rule, rule);
      }
    }
    if (Array.isArray(permissions.additionalDirectories)) {
      item('permission', 'permissions.additionalDirectories', 'Additional directories', permissions.additionalDirectories.map(String).join(', '), permissions.additionalDirectories);
    }
  }
  for (const key of HELPER_KEYS) {
    if (typeof json[key] === 'string') item('helper', key, `${key} command`, redactCommand(json[key] as string), json[key]);
  }
  if (isRecord(json.statusLine)) {
    const command = typeof json.statusLine.command === 'string' ? redactCommand(json.statusLine.command) : 'status line';
    item('helper', 'statusLine', 'Status line command', command, json.statusLine);
  }
  for (const key of POLICY_KEYS) {
    if (json[key] !== undefined) item('permission', key, key, clip(canonicalJson(json[key])), json[key]);
  }
  if (json.sandbox !== undefined) item('sandbox', 'sandbox', 'Sandbox settings', clip(canonicalJson(json.sandbox)), json.sandbox);
  for (const key of ['enabledPlugins', 'extraKnownMarketplaces'] as const) {
    if (json[key] !== undefined) item('plugin', key, key === 'enabledPlugins' ? 'Enabled plugins (plugins can carry hooks)' : 'Extra plugin marketplaces', clip(canonicalJson(json[key])), json[key]);
  }
  return out;
}

/** `.mcp.json`: every server is a command or an endpoint the CLI may start or connect to. */
export function mcpJsonItems(file: string, json: unknown, hash: Hash): ExecItem[] {
  const servers = isRecord(json) && isRecord(json.mcpServers) ? json.mcpServers : null;
  if (!servers) return [];
  return Object.entries(servers).map(([name, cfg]) => {
    const record = isRecord(cfg) ? cfg : {};
    const args = Array.isArray(record.args) ? record.args.filter((a): a is string => typeof a === 'string') : [];
    const shown = typeof record.url === 'string'
      ? urlShown(record.url)
      : typeof record.command === 'string' ? redactCommand([record.command, ...args].join(' ')) : '(nothing to run)';
    const envNames = isRecord(record.env) ? Object.keys(record.env) : [];
    return {
      id: `mcp:${file}:${name}`, kind: 'mcp' as const, file,
      label: `MCP server “${name}”`,
      shown: clip(envNames.length ? `${shown} · env ${envNames.join(', ')}` : shown),
      fingerprint: hash(canonicalJson(cfg)),
    };
  });
}

/**
 * `.codex/config.toml`. Not parsed as TOML: each table is an item keyed by its
 * header and fingerprinted over its own text, which is enough to say "the
 * [mcp_servers.docs] table changed" without a TOML parser in the fast lane.
 */
export function codexConfigItems(file: string, text: string, hash: Hash): ExecItem[] {
  const out: ExecItem[] = [];
  let header = '(top level)';
  let body: string[] = [];
  const flush = () => {
    const meaningful = body.filter((line) => line.trim() && !line.trim().startsWith('#'));
    if (!meaningful.length) return;
    const shown = meaningful.map((line) => {
      const m = /^\s*([\w.-]+)\s*=\s*(.*)$/.exec(line);
      if (!m) return line.trim();
      return SECRET_WORD.test(m[1]) ? `${m[1]} = …` : `${m[1]} = ${redactCommand(m[2].trim())}`;
    }).join('; ');
    out.push({ id: `codex:${file}:${header}`, kind: 'codex', file, label: `Codex config ${header}`, shown: clip(shown), fingerprint: hash(meaningful.join('\n')) });
  };
  for (const line of text.split('\n')) {
    const table = /^\s*\[\[?([^\]]+)\]\]?\s*$/.exec(line);
    if (table) { flush(); header = `[${table[1].trim()}]`; body = []; continue; }
    body.push(line);
  }
  flush();
  return out;
}

/** Git config keys that make git run a program, or send traffic somewhere. */
const RISKY_GIT_KEY = /^(?:core\.(?:fsmonitor|hookspath|sshcommand|askpass|editor|pager|gitproxy|attributesfile)|filter\..+\.(?:clean|smudge|process)|diff\..+\.(?:textconv|command)|merge\..+\.driver|credential\..*|include\.path|includeif\..+\.path|http\..*proxy|uploadpack\.packobjectshook|sequence\.editor)$/i;

export function gitConfigItems(pairs: readonly [string, string][], hash: Hash): ExecItem[] {
  return pairs
    .filter(([key]) => RISKY_GIT_KEY.test(key))
    .map(([key, value]) => ({
      id: `git-config:${key.toLowerCase()}`, kind: 'git-config' as const, file: 'git config',
      label: `git ${key}`,
      shown: clip(/credential|proxy/i.test(key) ? `${key} is set (value not shown)` : redactCommand(value)),
      fingerprint: hash(`${key.toLowerCase()}=${value}`),
    }));
}

/** Executable hooks in the repository's hooks directory. */
export function gitHookItems(hooks: readonly { name: string; sha256: string }[]): ExecItem[] {
  return hooks.map((hook) => ({
    id: `git-hook:${hook.name}`, kind: 'git-hook' as const, file: '.git/hooks',
    label: `git ${hook.name} hook`, shown: `${hook.name} (sha256 ${hook.sha256.slice(0, 12)}…)`, fingerprint: hook.sha256,
  }));
}

/** `.env` entries that redirect where a CLI sends requests. Values are never shown. */
export function dotenvItems(file: string, text: string, hash: Hash): ExecItem[] {
  const out: ExecItem[] = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, name, rawValue] = m;
    if (!/(?:_BASE_URL|_API_URL|_ENDPOINT|PROXY|^ANTHROPIC_|^OPENAI_|^CODEX_|^CLAUDE_)/i.test(name)) continue;
    const value = rawValue.trim().replace(/^(['"])(.*)\1$/, '$2');
    out.push({ id: `dotenv:${file}:${name}`, kind: 'dotenv', file, label: `${file} ${name}`, shown: clip(envShown(name, value)), fingerprint: hash(value) });
  }
  return out;
}

/** The digest the pin compares: order-free, and changed by an unreadable file as surely as by an edit. */
export function snapshotOf(items: ExecItem[], unreadable: string[], hash: Hash): ExecSnapshot {
  const sorted = [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const basis = [
    ...sorted.map((item) => `${item.id} ${item.fingerprint}`),
    ...[...unreadable].sort().map((file) => `unreadable ${file}`),
  ].join('\n');
  return { items: sorted, unreadable: [...unreadable].sort(), digest: hash(basis) };
}

export function diffSnapshots(before: readonly ExecItem[], after: readonly ExecItem[]): ExecDiff {
  const old = new Map(before.map((item) => [item.id, item]));
  const now = new Map(after.map((item) => [item.id, item]));
  return {
    added: after.filter((item) => !old.has(item.id)),
    removed: before.filter((item) => !now.has(item.id)),
    changed: after.filter((item) => old.has(item.id) && old.get(item.id)!.fingerprint !== item.fingerprint)
      .map((item) => ({ before: old.get(item.id)!, after: item })),
  };
}

/** A count by kind, for a one-line summary. */
export function summarizeItems(items: readonly ExecItem[]): string {
  if (!items.length) return 'nothing that runs or loosens policy';
  const words: Record<ExecItemKind, [string, string]> = {
    hook: ['hook', 'hooks'], mcp: ['MCP server', 'MCP servers'], env: ['environment override', 'environment overrides'],
    permission: ['permission setting', 'permission settings'], helper: ['helper command', 'helper commands'],
    sandbox: ['sandbox setting', 'sandbox settings'], plugin: ['plugin setting', 'plugin settings'],
    codex: ['Codex config table', 'Codex config tables'], 'git-hook': ['git hook', 'git hooks'],
    'git-config': ['git config driver', 'git config drivers'], dotenv: ['.env redirect', '.env redirects'],
  };
  const counts = new Map<ExecItemKind, number>();
  for (const item of items) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  return [...counts.entries()].map(([kind, n]) => `${n} ${words[kind][n === 1 ? 0 : 1]}`).join(', ');
}
