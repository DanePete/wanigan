import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MODELS, DEFAULT_MODEL, modelFor } from '../batch/pricing';

/**
 * Everything a project injects into an agent *besides* its CLAUDE.md: the
 * settings that actually won, the hooks that will run, the MCP servers that
 * will connect, the subagents and slash commands on offer — and what carrying
 * all of it at the top of every session costs.
 *
 * The one thing this file refuses to produce is a merged blob. Four settings
 * layers stack up, and the only question anyone ever brings to a settings
 * panel is "why is this value what it is". So every key names the layer that
 * won and the layers it beat; a panel that shows only the winner cannot answer
 * the one question it exists to answer.
 *
 * Everything is read from disk. Nothing here talks to the network and nothing
 * here writes — Wanigan never edits the user's .claude directory or the repo.
 */

/* ── shape ───────────────────────────────────────────────────────────── */

export type SettingsLayer = 'user' | 'project' | 'local' | 'managed';

export type ResolvedSetting = {
  key: string;
  value: unknown;
  from: SettingsLayer;
  shadowed: { from: SettingsLayer; value: unknown }[];
};

export type HookEntry = {
  event: string;
  matcher: string | null;
  type: string;
  summary: string;
  from: SettingsLayer | 'plugin';
  source: string;
};

export type McpEntry = {
  name: string;
  transport: string;
  target: string;
  from: 'project' | 'user';
  source: string;
};

export type AgentEntry = {
  name: string;
  description: string;
  path: string;
  scope: 'user' | 'project';
  tools: string[];
  model: string | null;
};

export type CommandEntry = {
  name: string;
  description: string;
  path: string;
  scope: 'user' | 'project';
  invoke: string;
};

export type ContextBudget = {
  files: { path: string; label: string; bytes: number; estTokens: number }[];
  totalBytes: number;
  /**
   * Bytes found on disk that do NOT load — files past the 4 MiB skip. Kept out
   * of totalBytes so totalBytes and estTokens always measure the same thing.
   */
  skippedBytes: number;
  estTokens: number;
  /** Cost of carrying this at the start of every single session. */
  usdPerSession: number | null;
  model: string | null;
  note: string;
};

export type ProjectConfig = {
  settings: ResolvedSetting[];
  layers: { layer: SettingsLayer; path: string; exists: boolean; keys: number }[];
  hooks: HookEntry[];
  mcp: McpEntry[];
  agents: AgentEntry[];
  commands: CommandEntry[];
  permissions: { allow: string[]; deny: string[]; ask: string[]; from: SettingsLayer }[];
  notes: string[];
};

/* ── constants ───────────────────────────────────────────────────────── */

const HOME = os.homedir();

/**
 * Settings precedence, LOWEST first. Managed policy is last because it is the
 * layer an operator sets and a user cannot override — reversing this list is
 * the one bug that would make every answer in the panel wrong.
 */
const LAYER_ORDER: SettingsLayer[] = ['user', 'project', 'local', 'managed'];

/** Where each layer lives. Read through LAYER_ORDER so the order stays the constant above. */
const LAYER_PATHS: Record<SettingsLayer, (projectPath: string) => string> = {
  user: () => path.join(HOME, '.claude', 'settings.json'),
  project: (p) => path.join(p, '.claude', 'settings.json'),
  local: (p) => path.join(p, '.claude', 'settings.local.json'),
  managed: () => managedSettingsPath(),
};

/** Managed policy lives outside the user's home, per platform. */
function managedSettingsPath(): string {
  if (process.platform === 'darwin') return '/Library/Application Support/ClaudeCode/managed-settings.json';
  if (process.platform === 'win32') {
    return path.join(process.env.ProgramData || 'C:\\ProgramData', 'ClaudeCode', 'managed-settings.json');
  }
  return '/etc/claude-code/managed-settings.json';
}

/**
 * `claudeMdExcludes` is documented as MERGING across layers rather than being
 * overridden by the highest one. Reporting it as a plain override would tell a
 * user their project's excludes replaced their user-level ones, when in fact
 * both are in force.
 */
const MERGED_ARRAY_KEYS = new Set(['claudeMdExcludes']);

/** These get their own fields; repeating them in `settings` would be noise. */
const OWN_FIELD_KEYS = new Set(['hooks', 'permissions']);

/** A settings file is a config, not a dataset. Anything bigger is not read. */
const MAX_JSON_BYTES = 2 * 1024 * 1024;
/**
 * ~/.claude.json is not a settings file despite the name: Claude Code keeps
 * per-project prompt history in it, so it grows without bound with normal use
 * and routinely passes 2 MiB. Under the settings cap it simply went unread, and
 * readMcp then reported every long-approved MCP server as pending approval.
 */
const MAX_USER_CONFIG_BYTES = 64 * 1024 * 1024;
/** A CLAUDE.md up to 4 MiB is loaded in full; larger is SKIPPED ENTIRELY. */
const CLAUDE_MD_MAX_BYTES = 4 * 1024 * 1024;
/** Frontmatter plus a first paragraph. No agent definition needs more. */
const MAX_MD_BYTES = 256 * 1024;
/** Depth and breadth caps so a symlinked or generated tree cannot hang a scan. */
const MAX_WALK_DEPTH = 4;
const MAX_WALK_ENTRIES = 400;
/** A permission list this long is already unreadable; the rest is summarised. */
const MAX_LIST = 1000;

/* ── small readers ───────────────────────────────────────────────────── */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

type JsonRead = { exists: boolean; value: Record<string, unknown> | null; error: string | null };

/**
 * Reads one JSON config. A parse failure is reported rather than swallowed:
 * Claude Code ignores a settings file it cannot parse, so a stray trailing
 * comma silently turns off every hook and permission in it, and the user's
 * only symptom is that nothing they configured happens.
 */
function readJsonFile(file: string, maxBytes = MAX_JSON_BYTES): JsonRead {
  let st: fs.Stats;
  try { st = fs.statSync(file); } catch { return { exists: false, value: null, error: null }; }
  if (!st.isFile()) return { exists: false, value: null, error: null };
  if (st.size > maxBytes) {
    return {
      exists: true, value: null,
      error: `${file} is ${(st.size / 1_048_576).toFixed(1)} MB, past the ${(maxBytes / 1_048_576).toFixed(0)} MB Wanigan will parse, so nothing it declares is reflected here. Check what wrote it.`,
    };
  }
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!isRecord(parsed)) {
      return { exists: true, value: null, error: `${file} is valid JSON but not an object, so Claude Code ignores it. It should be a single { … } map.` };
    }
    return { exists: true, value: parsed, error: null };
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return {
      exists: true, value: null,
      error: `${file} is not valid JSON (${why}). Claude Code ignores the whole file when it cannot parse it, so nothing in it is in effect — fix the syntax.`,
    };
  }
}

/**
 * Secrets in configs are routine — an MCP server with a bearer token in its
 * args, a hook with an API key on its command line — and this panel gets
 * screenshotted. Values that look like credentials never leave this module.
 */
const SECRET_ARG = /^(--?[A-Za-z0-9_-]*(?:key|token|secret|password|auth)[A-Za-z0-9_-]*)=(.+)$/i;
const SECRET_INLINE = /\b(sk-[A-Za-z0-9_-]{8,}|dop_v1_[A-Za-z0-9]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|xox[baprs]-[A-Za-z0-9-]{8,})/g;
/** A credential passed inline. Seeing that a hook sends a token is the point; its value is not. */
const SECRET_KV = /\b([A-Za-z0-9_-]*(?:key|token|secret|password|passwd)[A-Za-z0-9_-]*)([=:])(\S+)/gi;

function redactSecrets(s: string): string {
  return s.replace(SECRET_INLINE, (m) => m.slice(0, 6) + '…redacted').replace(SECRET_KV, '$1$2…redacted');
}

function redactArg(a: string): string {
  const m = SECRET_ARG.exec(a);
  return m ? `${m[1]}=…redacted` : redactSecrets(a);
}

/** URLs keep origin and path; a query string is where tokens hide. */
function safeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return u.search || u.hash ? `${u.origin}${u.pathname}?…` : `${u.origin}${u.pathname}`;
  } catch { return redactSecrets(clip(raw, 200)); }
}

/* ── frontmatter ─────────────────────────────────────────────────────────
   A deliberately small YAML reader, the same one src/main/skills.ts uses, so
   the skills panel and this one agree about what a frontmatter block says. It
   is copied rather than shared because skills.ts does not export it and this
   phase does not own that file.
   ──────────────────────────────────────────────────────────────────────── */

function parseFrontmatter(text: string): Record<string, string> {
  if (!text.startsWith('---')) return {};
  const end = text.indexOf('\n---', 3);
  if (end === -1) return {};
  const block = text.slice(text.indexOf('\n', 3) + 1, end);

  const out: Record<string, string> = {};
  let key: string | null = null;
  for (const raw of block.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;

    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (m && !/^\s/.test(line)) { key = m[1]; out[key] = unquote(m[2]); continue; }
    // A wrapped description or a YAML block list belongs to the key above it;
    // dropping the tail truncates the description mid-sentence.
    if (key && /^\s+\S/.test(line)) out[key] = (out[key] ? out[key] + ' ' : '') + unquote(line.trim());
  }
  return out;
}

function unquote(v: string): string {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
}

/** `tools` appears as a JSON array, a comma list or a folded block list. */
function toList(raw: string): string[] {
  const t = raw.trim();
  if (!t) return [];
  if (t.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(t);
      if (Array.isArray(parsed)) return parsed.map((x) => String(x).trim()).filter(Boolean);
    } catch { /* not strict JSON; fall through to splitting */ }
    return t.replace(/^\[|\]$/g, '').split(',').map((s) => s.replace(/["']/g, '').trim()).filter(Boolean);
  }
  return t.split(/,|(?:^|\s)-\s+/).map((s) => s.replace(/^["']|["']$/g, '').trim()).filter(Boolean);
}

/** Fallback description: the first real sentence of prose. */
function firstProse(text: string): string {
  const body = text.replace(/^---[\s\S]*?\n---\n/, '');
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#') || t.startsWith('```') || t.startsWith('>')) continue;
    return clip(t, 240);
  }
  return '';
}

/* ── layers ──────────────────────────────────────────────────────────── */

type LayerFile = { layer: SettingsLayer; path: string; read: JsonRead };

function layerFiles(projectPath: string): LayerFile[] {
  return LAYER_ORDER.map((layer) => {
    const file = LAYER_PATHS[layer](projectPath);
    return { layer, path: file, read: readJsonFile(file) };
  });
}

/**
 * Long arrays are truncated for transport, but never silently: the caller is
 * told the real count so nobody reads "42 allow rules" off a list of 1,116.
 */
function clipValue(key: string, value: unknown, notes: string[]): unknown {
  if (Array.isArray(value) && value.length > MAX_LIST) {
    notes.push(`${key} has ${value.length} entries; the first ${MAX_LIST} are shown.`);
    return value.slice(0, MAX_LIST);
  }
  return value;
}

function resolveSettings(layers: LayerFile[], notes: string[]): ResolvedSetting[] {
  // Highest precedence first, so the first layer holding a key is the winner.
  const ranked = [...layers].reverse();

  const keys = new Set<string>();
  for (const l of layers) for (const k of Object.keys(l.read.value ?? {})) if (!OWN_FIELD_KEYS.has(k)) keys.add(k);

  const out: ResolvedSetting[] = [];
  for (const key of [...keys].sort()) {
    const holders = ranked.filter((l) => l.read.value && key in l.read.value);
    if (!holders.length) continue;

    if (MERGED_ARRAY_KEYS.has(key)) {
      // Documented merge, not override: every layer's globs are in force at
      // once, and the union is the only value that is actually true.
      const union: unknown[] = [];
      for (const l of layers) for (const v of strList(l.read.value?.[key])) if (!union.includes(v)) union.push(v);
      out.push({
        key,
        value: clipValue(key, union, notes),
        from: holders[0].layer,
        shadowed: holders.slice(1).map((l) => ({ from: l.layer, value: l.read.value?.[key] })),
      });
      notes.push(`${key} merges across settings layers instead of overriding, so the value shown is the union of all ${holders.length} of them.`);
      continue;
    }

    out.push({
      key,
      value: clipValue(key, holders[0].read.value?.[key], notes),
      from: holders[0].layer,
      shadowed: holders.slice(1).map((l) => ({ from: l.layer, value: clipValue(key, l.read.value?.[key], notes) })),
    });
  }
  return out;
}

function readPermissions(layers: LayerFile[], notes: string[]): ProjectConfig['permissions'] {
  const out: ProjectConfig['permissions'] = [];
  for (const l of layers) {
    const p = l.read.value?.permissions;
    if (!isRecord(p)) continue;
    const allow = strList(p.allow), deny = strList(p.deny), ask = strList(p.ask);
    if (!allow.length && !deny.length && !ask.length) continue;
    // Truncation here of all places must not be silent: nobody should read
    // "1,000 allow rules" off a list that actually has 1,116.
    for (const [name, list] of [['allow', allow], ['deny', deny], ['ask', ask]] as [string, string[]][]) {
      if (list.length > MAX_LIST) notes.push(`${l.layer} settings hold ${list.length} permissions.${name} rules; the first ${MAX_LIST} are shown.`);
    }
    out.push({
      allow: allow.slice(0, MAX_LIST),
      deny: deny.slice(0, MAX_LIST),
      ask: ask.slice(0, MAX_LIST),
      from: l.layer,
    });
    const extra = strList(p.additionalDirectories);
    if (extra.length) {
      notes.push(`${l.layer} settings grant access to ${extra.length} director${extra.length === 1 ? 'y' : 'ies'} outside the project (permissions.additionalDirectories in ${l.path}).`);
    }
  }
  return out;
}

/* ── hooks ───────────────────────────────────────────────────────────── */

function hookSummary(event: string, matcher: string | null, h: Record<string, unknown>): string {
  const type = str(h.type) ?? 'command';
  const when = matcher && matcher !== '*' ? `On ${event} matching ${matcher}` : `On every ${event}`;
  if (type === 'command') return `${when}: runs ${clip(redactSecrets(str(h.command) ?? '(no command set)'), 200)}`;
  if (type === 'http') return `${when}: posts to ${safeUrl(str(h.url) ?? '(no url set)')}`;
  return `${when}: ${type} handler`;
}

/** One `hooks` block → flat entries. Shape: { Event: [{ matcher?, hooks: [] }] }. */
function readHookBlock(block: unknown, from: HookEntry['from'], source: string): HookEntry[] {
  if (!isRecord(block)) return [];
  const out: HookEntry[] = [];
  for (const [event, groupsRaw] of Object.entries(block)) {
    const groups = Array.isArray(groupsRaw) ? groupsRaw : [groupsRaw];
    for (const g of groups) {
      if (!isRecord(g)) continue;
      const matcher = str(g.matcher);
      const handlers = Array.isArray(g.hooks) ? g.hooks : [];
      for (const h of handlers) {
        if (!isRecord(h)) continue;
        out.push({ event, matcher, type: str(h.type) ?? 'command', summary: hookSummary(event, matcher, h), from, source });
      }
    }
  }
  return out;
}

/**
 * Enabled plugins, unioned across every layer. For hook discovery the union is
 * the safe direction: a hook that is listed but disabled is a moment's
 * confusion, a hook that runs and was never listed is the thing this panel
 * exists to catch.
 */
function enabledPlugins(layers: LayerFile[]): string[] {
  const on = new Set<string>();
  for (const l of layers) {
    const ep = l.read.value?.enabledPlugins;
    if (!isRecord(ep)) continue;
    for (const [k, v] of Object.entries(ep)) if (v === true) on.add(k);
  }
  return [...on];
}

/**
 * `<plugin>@<marketplace>` → the directory the CLI actually loads. The
 * installed copy under plugins/cache is authoritative; the marketplace clone is
 * a fallback for a plugin recorded nowhere else.
 */
function pluginDir(key: string, table: Record<string, unknown>): string | null {
  const entry = table[key];
  if (Array.isArray(entry)) {
    for (const e of entry) {
      const p = isRecord(e) ? str(e.installPath) : null;
      if (p && fs.existsSync(p)) return p;
    }
  }
  const at = key.lastIndexOf('@');
  if (at <= 0) return null;
  const name = key.slice(0, at), market = key.slice(at + 1);
  for (const bucket of ['plugins', 'external_plugins']) {
    const guess = path.join(HOME, '.claude', 'plugins', 'marketplaces', market, bucket, name);
    if (fs.existsSync(guess)) return guess;
  }
  return null;
}

function pluginHooks(layers: LayerFile[], notes: string[]): HookEntry[] {
  const out: HookEntry[] = [];
  let extras = 0;
  const installed = readJsonFile(path.join(HOME, '.claude', 'plugins', 'installed_plugins.json'));
  const table = isRecord(installed.value?.plugins) ? (installed.value.plugins as Record<string, unknown>) : {};

  const declaring = layers.filter((l) => isRecord(l.read.value?.enabledPlugins));
  if (declaring.length > 1) {
    notes.push(`enabledPlugins is set in ${declaring.length} settings layers. The key below shows the winning layer's value, but hook discovery used the union of all of them — a hook that runs and is not listed is the failure worth avoiding.`);
  }

  for (const key of enabledPlugins(layers)) {
    const dir = pluginDir(key, table);
    if (!dir) { notes.push(`Plugin ${key} is enabled in settings but its files are not on disk, so nothing it provides is loaded.`); continue; }
    const file = path.join(dir, 'hooks', 'hooks.json');
    const read = readJsonFile(file);
    if (read.error) notes.push(read.error);
    out.push(...readHookBlock(read.value?.hooks, 'plugin', file));
    for (const sub of ['agents', 'commands']) {
      try { extras += fs.readdirSync(path.join(dir, sub)).filter((n) => n.endsWith('.md')).length; } catch { /* plugin ships none */ }
    }
  }
  if (extras) {
    notes.push(`Enabled plugins also provide ${extras} agent/command file(s). They are namespaced under the plugin and are not listed below, which lists only user- and project-scope definitions.`);
  }
  return out;
}

/* ── MCP ─────────────────────────────────────────────────────────────── */

function mcpFrom(block: unknown, from: McpEntry['from'], source: string): McpEntry[] {
  if (!isRecord(block)) return [];
  const out: McpEntry[] = [];
  for (const [name, cfg] of Object.entries(block)) {
    if (!isRecord(cfg)) continue;
    const url = str(cfg.url);
    const command = str(cfg.command);
    // `type` is authoritative when present; otherwise url vs command decides.
    const transport = str(cfg.type) ?? (url ? 'http' : command ? 'stdio' : 'unknown');
    const args = Array.isArray(cfg.args) ? cfg.args.filter((a): a is string => typeof a === 'string') : [];
    const target = url
      ? safeUrl(url)
      : command
        ? clip([redactArg(command), ...args.map(redactArg)].join(' '), 240)
        : '(nothing to run)';
    out.push({ name, transport, target, from, source });
  }
  return out;
}

/**
 * Three places declare MCP servers and they are not interchangeable: the repo's
 * own .mcp.json (shared with everyone who clones it), the user's global list,
 * and the per-project list inside ~/.claude.json. Headers and env are never
 * reported — that is where the API keys live.
 */
function readMcp(projectPath: string, notes: string[]): McpEntry[] {
  const out: McpEntry[] = [];

  const dotMcp = path.join(projectPath, '.mcp.json');
  const projectRead = readJsonFile(dotMcp);
  if (projectRead.error) notes.push(projectRead.error);
  const fromRepo = mcpFrom(projectRead.value?.mcpServers, 'project', dotMcp);
  out.push(...fromRepo);

  const userConfig = path.join(HOME, '.claude.json');
  const userRead = readJsonFile(userConfig, MAX_USER_CONFIG_BYTES);
  if (userRead.error) notes.push(userRead.error);

  // Approval state lives ONLY in this file. Treating an unread one as an empty
  // one makes every server below look unapproved and drops the user-scope
  // servers silently — a panel whose purpose is to show what will connect would
  // report the exact opposite, with nothing saying it could not tell.
  if (userRead.exists && !userRead.value) {
    notes.push(`${userConfig} could not be read, so Wanigan cannot tell which .mcp.json servers are already approved for this project, and any user-scope servers it declares are missing from the list below. What is shown is what this repository declares, not what will connect.`);
    return out;
  }

  out.push(...mcpFrom(userRead.value?.mcpServers, 'user', userConfig));

  const projects = isRecord(userRead.value?.projects) ? (userRead.value.projects as Record<string, unknown>) : {};
  const mine = projects[path.resolve(projectPath)];
  const enabled = isRecord(mine) ? strList(mine.enabledMcpjsonServers) : [];
  const disabled = isRecord(mine) ? strList(mine.disabledMcpjsonServers) : [];
  if (isRecord(mine)) out.push(...mcpFrom(mine.mcpServers, 'project', userConfig));

  // A server in .mcp.json does not connect until it is approved for this
  // project, so "configured" and "running" are different questions. A project
  // absent from ~/.claude.json has approved nothing at all — checking this only
  // for known projects would silently clear every repo nobody has opened yet.
  if (disabled.length) notes.push(`Configured in .mcp.json but disabled for this project, so it will not connect: ${disabled.join(', ')}.`);
  const unapproved = fromRepo.filter((s) => !enabled.includes(s.name) && !disabled.includes(s.name)).map((s) => s.name);
  if (unapproved.length) notes.push(`Declared in this repository's .mcp.json but not yet approved here, so Claude Code will ask before connecting: ${unapproved.join(', ')}.`);
  return out;
}

/* ── agents & commands ───────────────────────────────────────────────── */

/** Markdown definitions under a root, depth- and count-capped. */
function walkMarkdown(root: string, projectPath: string, notes: string[]): { file: string; rel: string }[] {
  const found: { file: string; rel: string }[] = [];
  const seenDirs = new Set<string>();

  const walk = (dir: string, depth: number) => {
    if (depth > MAX_WALK_DEPTH || found.length >= MAX_WALK_ENTRIES) return;
    // A symlink loop would otherwise walk forever; realpath makes the visit set
    // meaningful even when two names point at one directory.
    let real: string;
    try { real = fs.realpathSync(dir); } catch { return; }
    if (seenDirs.has(real)) return;
    seenDirs.add(real);

    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || found.length >= MAX_WALK_ENTRIES) continue;
      const full = path.join(dir, e.name);
      let isDir = e.isDirectory();
      if (e.isSymbolicLink()) {
        let target: string;
        try { target = fs.realpathSync(full); } catch { continue; }
        // Following a link out of the project is allowed but never silent: the
        // file that runs is not the file the repo appears to contain.
        if (projectPath && !target.startsWith(path.resolve(projectPath) + path.sep) && !target.startsWith(HOME + path.sep)) {
          notes.push(`${full} is a symlink to ${target}, outside both the project and your home directory.`);
        }
        try { isDir = fs.statSync(full).isDirectory(); } catch { continue; }
      }
      if (isDir) walk(full, depth + 1);
      else if (e.name.endsWith('.md')) found.push({ file: full, rel: path.relative(root, full) });
    }
  };

  walk(root, 0);
  if (found.length >= MAX_WALK_ENTRIES) {
    notes.push(`${root} holds more than ${MAX_WALK_ENTRIES} definitions; the list is capped there.`);
  }
  return found;
}

function readMarkdownHead(file: string): { fm: Record<string, string>; text: string } | null {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_MD_BYTES) return null;
    const text = fs.readFileSync(file, 'utf8');
    return { fm: parseFrontmatter(text), text };
  } catch { return null; }
}

function readAgents(root: string, scope: 'user' | 'project', projectPath: string, notes: string[]): AgentEntry[] {
  const out: AgentEntry[] = [];
  for (const { file } of walkMarkdown(root, projectPath, notes)) {
    const md = readMarkdownHead(file);
    if (!md) continue;
    const name = md.fm.name || path.basename(file, '.md');
    out.push({
      name,
      description: md.fm.description || firstProse(md.text) || 'No description.',
      path: file,
      scope,
      tools: toList(md.fm.tools || md.fm['allowed-tools'] || ''),
      // 'inherit' is a real, meaningful value: the subagent runs on whatever the
      // parent session is using, so it must not be flattened to null.
      model: str(md.fm.model),
    });
  }
  return out;
}

function readCommands(root: string, scope: 'user' | 'project', projectPath: string, notes: string[]): CommandEntry[] {
  const out: CommandEntry[] = [];
  for (const { file, rel } of walkMarkdown(root, projectPath, notes)) {
    const md = readMarkdownHead(file);
    if (!md) continue;
    const name = md.fm.name || path.basename(file, '.md');
    // A command in a subdirectory is namespaced: commands/git/sync.md → /git:sync.
    const dirs = path.dirname(rel).split(path.sep).filter((d) => d && d !== '.');
    out.push({
      name,
      description: md.fm.description || firstProse(md.text) || 'No description.',
      path: file,
      scope,
      invoke: `/${[...dirs, name].join(':')}`,
    });
  }
  return out;
}

/* ── the config ──────────────────────────────────────────────────────── */

let cache: { key: string; at: number; value: ProjectConfig } | null = null;
const TTL_MS = 20_000;

export function refreshProjectConfig(): void {
  cache = null;
}

export function readProjectConfig(projectPath: string): ProjectConfig {
  const root = path.resolve(projectPath || '.');
  let st: fs.Stats;
  try { st = fs.statSync(root); } catch {
    throw new Error(`No such project directory: ${root}. Re-add the project in Wanigan, or pick another one.`);
  }
  if (!st.isDirectory()) {
    throw new Error(`${root} is a file, not a project directory. Pick the repository folder instead.`);
  }

  if (cache && cache.key === root && Date.now() - cache.at < TTL_MS) return cache.value;

  const notes: string[] = [];
  const layers = layerFiles(root);
  for (const l of layers) if (l.read.error) notes.push(l.read.error);

  const hooks: HookEntry[] = [];
  for (const l of layers) hooks.push(...readHookBlock(l.read.value?.hooks, l.layer, l.path));
  hooks.push(...pluginHooks(layers, notes));

  // A hook committed to a shared repo runs on this machine the moment a session
  // starts here. That is a supply-chain surface, and it deserves to be seen
  // rather than inferred from a merged blob.
  const fromRepo = hooks.filter((h) => h.from === 'project');
  if (fromRepo.length) {
    notes.push(`${fromRepo.length} hook(s) come from this repository's own .claude/settings.json and run on your machine when a session starts here. Read them before trusting the repo.`);
  }

  const agents = [
    ...readAgents(path.join(HOME, '.claude', 'agents'), 'user', root, notes),
    ...readAgents(path.join(root, '.claude', 'agents'), 'project', root, notes),
  ];
  const commands = [
    ...readCommands(path.join(HOME, '.claude', 'commands'), 'user', root, notes),
    ...readCommands(path.join(root, '.claude', 'commands'), 'project', root, notes),
  ];

  // A project definition shadows a user one of the same name. Listing both
  // would misreport which file actually runs — the same rule skills.ts uses.
  const dedupe = <T extends { scope: 'user' | 'project' }>(items: T[], keyOf: (t: T) => string): T[] => {
    const byKey = new Map<string, T>();
    for (const it of [...items].sort((a, b) => (a.scope === b.scope ? 0 : a.scope === 'project' ? -1 : 1))) {
      const k = keyOf(it);
      if (!byKey.has(k)) byKey.set(k, it);
      else notes.push(`${keyOf(it)} is defined at both user and project scope; the project one wins.`);
    }
    return [...byKey.values()].sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
  };

  const userLocal = path.join(HOME, '.claude', 'settings.local.json');
  if (fs.existsSync(userLocal)) {
    notes.push(`${userLocal} exists but is not one of the four documented settings layers, so Wanigan does not merge it here.`);
  }
  if (layers.some((l) => [...OWN_FIELD_KEYS].some((k) => l.read.value && k in l.read.value))) {
    notes.push('hooks and permissions are listed in their own sections rather than as settings keys.');
  }

  const value: ProjectConfig = {
    settings: resolveSettings(layers, notes),
    layers: layers.map((l) => ({
      layer: l.layer,
      path: l.path,
      exists: l.read.exists,
      keys: Object.keys(l.read.value ?? {}).length,
    })),
    hooks,
    mcp: readMcp(root, notes),
    agents: dedupe(agents, (a) => a.name),
    commands: dedupe(commands, (c) => c.invoke),
    permissions: readPermissions(layers, notes),
    // Several readers can reach the same conclusion about the same file; a
    // panel that prints one warning twice reads like two problems.
    notes: notes.filter((n, i) => notes.indexOf(n) === i),
  };

  cache = { key: root, at: Date.now(), value };
  return value;
}

/* ── token budget ────────────────────────────────────────────────────── */

/**
 * Rough chars-per-token for English prose and for punctuation-dense code. A
 * flat chars/4 undercounts a CLAUDE.md that is mostly fenced code by roughly a
 * third, which is exactly the file most likely to be too big.
 */
const PROSE_CHARS_PER_TOKEN = 4.0;
const CODE_CHARS_PER_TOKEN = 2.8;
/** Punctuation share at which text is treated as fully code-dense. */
const CODE_SYMBOL_RATIO = 0.25;
/** CJK and similar wide scripts run near one token per character. */
const WIDE_CHARS_PER_TOKEN = 1.2;

/**
 * A LOCAL estimate, never a measurement. This runs on every project open, so it
 * must work offline and with no API key — spending a network round trip to
 * label a panel would be absurd — and it carries the same honesty
 * src/main/batch/pricing.ts carries about pricing not being in the API.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let alnum = 0, symbols = 0, wide = 0, space = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0x2e80) { wide++; continue; }
    if (c === 32 || c === 9 || c === 10 || c === 13) { space++; continue; }
    const isAlnum = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
    if (isAlnum) alnum++; else symbols++;
  }
  const narrow = alnum + symbols + space;
  if (!narrow) return Math.ceil(wide / WIDE_CHARS_PER_TOKEN);

  const ratio = symbols / Math.max(1, alnum + symbols);
  const density = Math.min(1, ratio / CODE_SYMBOL_RATIO);
  const perToken = PROSE_CHARS_PER_TOKEN - density * (PROSE_CHARS_PER_TOKEN - CODE_CHARS_PER_TOKEN);
  return Math.ceil(narrow / perToken + wide / WIDE_CHARS_PER_TOKEN);
}

/**
 * Interactive sessions pay LIST price. Everything in pricing.ts is the batch
 * rate, already discounted 50%, so an interactive token costs double what that
 * table says. Getting this multiplier backwards would halve every number here.
 */
const INTERACTIVE_MULTIPLIER = 2;

/** Common CLI aliases, so a `model: "opus"` in settings still prices. */
const MODEL_ALIASES: Record<string, string> = {
  opus: 'claude-opus-5',
  sonnet: 'claude-sonnet-5',
  haiku: 'claude-haiku-4-5-20251001',
  fable: 'claude-fable-5',
};

function resolveModel(modelId: string | undefined): { id: string; known: boolean } {
  if (!modelId || !modelId.trim()) return { id: DEFAULT_MODEL, known: true };
  // A trailing context-window suffix like `[1m]` names the same priced model.
  const bare = modelId.trim().replace(/\[[^\]]*\]$/, '');
  const alias = MODEL_ALIASES[bare.toLowerCase()];
  const id = alias ?? bare;
  return { id, known: MODELS.some((m) => m.id === id) };
}

export function contextBudget(
  projectPath: string,
  files: { path: string; label: string }[],
  modelId?: string
): ContextBudget {
  const root = projectPath ? path.resolve(projectPath) : '';
  const rows: ContextBudget['files'] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  let totalBytes = 0, skippedBytes = 0, estTokens = 0;

  for (const f of files) {
    if (!f?.path) continue;
    const abs = path.resolve(f.path);

    // A symlink out of the project means the file in context is not the file
    // the repo appears to contain. Say so rather than reporting the link.
    let target = abs;
    try {
      const ls = fs.lstatSync(abs);
      if (ls.isSymbolicLink()) {
        target = fs.realpathSync(abs);
        if (root && !target.startsWith(root + path.sep) && target !== root) {
          warnings.push(`${f.label} is a symlink to ${target}, outside the project.`);
        }
      }
    } catch { continue; }
    if (seen.has(target)) continue;
    seen.add(target);

    let st: fs.Stats;
    try { st = fs.statSync(target); } catch { continue; }
    if (!st.isFile()) continue;

    if (st.size > CLAUDE_MD_MAX_BYTES) {
      // Verified: a file up to 4 MiB is loaded in full and a larger one is
      // skipped ENTIRELY — so an oversized file costs nothing and does nothing.
      // Its bytes go to skippedBytes, never totalBytes: counted in totalBytes
      // they pair with estTokens 0 and a $0.00 cost, which a panel reads as
      // "5.0 MB of context, free" when 0 bytes of it load.
      skippedBytes += st.size;
      rows.push({ path: target, label: f.label, bytes: st.size, estTokens: 0 });
      warnings.push(`${f.label} is ${(st.size / 1_048_576).toFixed(1)} MB. Claude Code loads instruction files up to 4 MiB and skips anything larger outright, so none of it reaches the model — split it.`);
      continue;
    }

    let tokens = 0;
    try { tokens = estimateTokens(fs.readFileSync(target, 'utf8')); } catch { continue; }
    rows.push({ path: target, label: f.label, bytes: st.size, estTokens: tokens });
    totalBytes += st.size;
    estTokens += tokens;
  }

  const { id, known } = resolveModel(modelId);
  const priced = known ? modelFor(id) : null;
  const usdPerSession = priced ? (estTokens / 1_000_000) * priced.batchInput * INTERACTIVE_MULTIPLIER : null;

  const parts = [
    `About ${estTokens.toLocaleString('en-US')} tokens, estimated locally from character counts (~4 per token for prose, ~2.8 for code) — an estimate, not a measurement, so treat it as ±15%.`,
  ];
  if (priced) {
    parts.push(`Priced at ${priced.label}'s interactive input rate of $${(priced.batchInput * INTERACTIVE_MULTIPLIER).toFixed(2)}/MTok — double the batch rate in Wanigan's pricing table — for one full read at the start of each session. A prompt-cache hit on later turns costs a tenth of that.`);
  } else {
    parts.push(`No cost shown: "${modelId}" is not in Wanigan's pricing table, and a wrong number is worse than none.`);
  }
  if (!modelId && priced) parts.push(`No model was given, so the default (${priced.label}) was used.`);
  // Reconcile the two meters in words as well as in fields, so nobody derives a
  // bytes-per-token or cost-per-MB figure from numbers measuring different things.
  if (skippedBytes > 0) {
    parts.push(`totalBytes counts only what loads: a further ${(skippedBytes / 1_048_576).toFixed(1)} MB was found on disk but skipped for being over 4 MiB, and is reported separately as skippedBytes.`);
  }
  parts.push(...warnings);

  return {
    files: rows,
    totalBytes,
    skippedBytes,
    estTokens,
    usdPerSession,
    model: priced ? priced.id : null,
    note: parts.join(' '),
  };
}
