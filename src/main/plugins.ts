import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { detectProviders, shellPath } from './providers';

const exec = promisify(execFile);

/**
 * Installed plugins, from disk.
 *
 * The distinction that matters, and the one that is easy to get wrong: the
 * `marketplaces/` directory is a CATALOG. It holds every plugin a marketplace
 * offers — 54 of them here — and none of that is installed. What is installed
 * lives in `cache/<marketplace>/<plugin>/<version>/` and is listed in
 * `installed_plugins.json`.
 *
 * Scanning the marketplace and calling the result "your plugins" would report
 * fifty-four when the true answer is four, and it would look completely
 * plausible. So the catalog is read separately and labelled as available.
 */

const ROOT = path.join(os.homedir(), '.claude', 'plugins');
const CACHE = path.join(ROOT, 'cache');
const MARKETPLACES = path.join(ROOT, 'marketplaces');

export type PluginComponent = { kind: 'skill' | 'command' | 'agent'; name: string; path: string };

export type InstalledPlugin = {
  /** The key Claude Code uses: `<name>@<marketplace>`. */
  id: string;
  name: string;
  marketplace: string;
  version: string;
  scope: string;
  installedAt: number | null;
  lastUpdated: number | null;
  path: string;
  /** Null when the plugin ships no manifest — php-lsp does not, and that is legal. */
  description: string | null;
  author: string | null;
  homepage: string | null;
  skills: PluginComponent[];
  commands: PluginComponent[];
  agents: PluginComponent[];
  /** Hook events this plugin registers, which is the part worth seeing before you trust it. */
  hookEvents: string[];
  mcpServers: string[];
  hasReadme: boolean;
  /** False when installed_plugins.json points somewhere that no longer exists. */
  present: boolean;
  bytes: number;
};

export type AvailablePlugin = {
  id: string; name: string; marketplace: string;
  description: string | null; installed: boolean; path: string;
};

export type MarketplaceInfo = {
  name: string; source: string; installLocation: string; lastUpdated: number | null; present: boolean;
};

export type PluginState = {
  installed: InstalledPlugin[];
  available: AvailablePlugin[];
  marketplaces: MarketplaceInfo[];
  roots: { label: string; path: string; exists: boolean }[];
  notes: string[];
  scannedAt: number;
};

/* ── small readers ───────────────────────────────────────────────────── */

function readJson(p: string): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(p, 'utf8');
    if (raw.length > 4 * 1024 * 1024) return null;
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch { return null; }
}

function ts(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const n = Date.parse(v);
  return Number.isFinite(n) ? n : null;
}

function dirSize(dir: string, budget = 4000): number {
  let total = 0, seen = 0;
  const walk = (d: string) => {
    if (seen > budget) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (++seen > budget) return;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else { try { total += fs.statSync(full).size; } catch { /* vanished */ } }
    }
  };
  walk(dir);
  return total;
}

/** Frontmatter `name:` if present, else the filename. Enough for a listing. */
function titleOf(file: string): string {
  try {
    const head = fs.readFileSync(file, 'utf8').slice(0, 2048);
    const m = /^---[\s\S]*?\nname:\s*(.+?)\s*$/m.exec(head);
    if (m) return m[1].replace(/^["']|["']$/g, '');
  } catch { /* unreadable is not fatal for a name */ }
  return path.basename(file, '.md');
}

function listSkills(dir: string): PluginComponent[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out: PluginComponent[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const md = path.join(dir, e.name, 'SKILL.md');
    if (fs.existsSync(md)) out.push({ kind: 'skill', name: titleOf(md), path: md });
  }
  return out;
}

function listMarkdown(dir: string, kind: 'command' | 'agent'): PluginComponent[] {
  let entries: string[];
  try { entries = fs.readdirSync(dir); } catch { return []; }
  return entries
    .filter((f) => f.endsWith('.md'))
    .map((f) => ({ kind, name: titleOf(path.join(dir, f)), path: path.join(dir, f) }));
}

function hookEventsOf(dir: string): string[] {
  const j = readJson(path.join(dir, 'hooks', 'hooks.json'));
  const hooks = j?.hooks;
  if (!hooks || typeof hooks !== 'object') return [];
  return Object.keys(hooks as Record<string, unknown>);
}

function mcpServersOf(dir: string): string[] {
  for (const f of ['.mcp.json', 'mcp.json']) {
    const j = readJson(path.join(dir, f));
    const s = j?.mcpServers;
    if (s && typeof s === 'object') return Object.keys(s as Record<string, unknown>);
  }
  return [];
}

function manifestOf(dir: string): { description: string | null; author: string | null; homepage: string | null } {
  const j = readJson(path.join(dir, '.claude-plugin', 'plugin.json'));
  if (!j) return { description: null, author: null, homepage: null };
  const a = j.author;
  const author = typeof a === 'string' ? a
    : a && typeof a === 'object' && typeof (a as { name?: unknown }).name === 'string'
      ? (a as { name: string }).name : null;
  return {
    description: typeof j.description === 'string' ? j.description : null,
    author,
    homepage: typeof j.homepage === 'string' ? j.homepage : null,
  };
}

/* ── the scan ────────────────────────────────────────────────────────── */

let cache: { at: number; value: PluginState } | null = null;
const TTL_MS = 15_000;

export function readPlugins(): PluginState {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;

  const notes: string[] = [];
  const installed: InstalledPlugin[] = [];

  const reg = readJson(path.join(ROOT, 'installed_plugins.json'));
  const entries = (reg?.plugins ?? {}) as Record<string, unknown>;

  for (const [id, raw] of Object.entries(entries)) {
    const list = Array.isArray(raw) ? raw : [raw];
    const e = (list[0] ?? {}) as Record<string, unknown>;
    const [name, marketplace = 'unknown'] = id.split('@');
    const dir = typeof e.installPath === 'string' ? e.installPath : '';
    const present = Boolean(dir) && fs.existsSync(dir);
    if (!present && dir) {
      notes.push(`${id} is registered as installed but ${dir} is gone. Reinstall it, or Claude Code will skip it silently.`);
    }
    const man = present ? manifestOf(dir) : { description: null, author: null, homepage: null };
    installed.push({
      id, name, marketplace,
      version: typeof e.version === 'string' ? e.version : '—',
      scope: typeof e.scope === 'string' ? e.scope : 'user',
      installedAt: ts(e.installedAt), lastUpdated: ts(e.lastUpdated),
      path: dir, present,
      ...man,
      skills: present ? listSkills(path.join(dir, 'skills')) : [],
      commands: present ? listMarkdown(path.join(dir, 'commands'), 'command') : [],
      agents: present ? listMarkdown(path.join(dir, 'agents'), 'agent') : [],
      hookEvents: present ? hookEventsOf(dir) : [],
      mcpServers: present ? mcpServersOf(dir) : [],
      hasReadme: present && fs.existsSync(path.join(dir, 'README.md')),
      bytes: present ? dirSize(dir) : 0,
    });
  }
  installed.sort((a, b) => a.name.localeCompare(b.name));

  // The catalog, kept separate on purpose.
  const installedIds = new Set(installed.map((p) => p.id));
  const available: AvailablePlugin[] = [];
  let markets: string[] = [];
  try { markets = fs.readdirSync(MARKETPLACES); } catch { /* none yet */ }
  for (const mkt of markets) {
    for (const bucket of ['plugins', 'external_plugins']) {
      const base = path.join(MARKETPLACES, mkt, bucket);
      let names: string[];
      try { names = fs.readdirSync(base); } catch { continue; }
      for (const n of names) {
        const dir = path.join(base, n);
        if (!fs.statSync(dir).isDirectory()) continue;
        const id = `${n}@${mkt}`;
        available.push({
          id, name: n, marketplace: mkt, path: dir,
          description: manifestOf(dir).description,
          installed: installedIds.has(id),
        });
      }
    }
  }
  available.sort((a, b) => a.name.localeCompare(b.name));

  const known = readJson(path.join(ROOT, 'known_marketplaces.json')) ?? {};
  const marketplaces: MarketplaceInfo[] = Object.entries(known).map(([name, v]) => {
    const o = (v ?? {}) as Record<string, unknown>;
    const src = (o.source ?? {}) as Record<string, unknown>;
    const loc = typeof o.installLocation === 'string' ? o.installLocation : '';
    return {
      name,
      source: typeof src.repo === 'string' ? String(src.repo)
        : typeof src.url === 'string' ? String(src.url)
        : typeof src.source === 'string' ? String(src.source) : '—',
      installLocation: loc,
      lastUpdated: ts(o.lastUpdated),
      present: Boolean(loc) && fs.existsSync(loc),
    };
  });

  if (installed.length && available.length) {
    notes.push(
      `${installed.length} installed of ${available.length} in the catalog. The marketplace directory holds ` +
      `everything on offer, not what you have — only the installed list runs.`
    );
  }

  const value: PluginState = {
    installed, available, marketplaces,
    roots: [
      { label: 'Installed', path: CACHE, exists: fs.existsSync(CACHE) },
      { label: 'Catalog', path: MARKETPLACES, exists: fs.existsSync(MARKETPLACES) },
      { label: 'Registry', path: path.join(ROOT, 'installed_plugins.json'), exists: fs.existsSync(path.join(ROOT, 'installed_plugins.json')) },
    ],
    notes,
    scannedAt: Date.now(),
  };
  cache = { at: Date.now(), value };
  return value;
}

export function refreshPlugins(): void { cache = null; }

const MAX_PLUGIN_FILE_BYTES = 200 * 1024;

function inside(base: string, candidate: string): boolean {
  return candidate === base || candidate.startsWith(`${base}${path.sep}`);
}

/**
 * Read one displayed plugin document without turning the renderer API into a
 * general file reader. Lexical containment stops `..`; canonical containment
 * stops a plugin document symlinked to a private file outside the plugin
 * store. Read only the preview budget so a malicious or corrupt markdown file
 * cannot be materialised in the main process.
 */
export function readPluginFile(p: unknown, root = ROOT): { text: string; truncated: boolean; bytes: number } {
  if (typeof p !== 'string' || p.length === 0 || p.length > 32_768 || p.includes('\0')) {
    throw new Error('Choose a valid plugin document to open.');
  }

  const rootPath = path.resolve(root);
  const abs = path.resolve(p);
  if (!inside(rootPath, abs)) {
    throw new Error(`${abs} is not inside the plugins directory, so Wanigan will not open it.`);
  }

  let canonicalRoot: string;
  let canonicalFile: string;
  try {
    canonicalRoot = fs.realpathSync(rootPath);
    canonicalFile = fs.realpathSync(abs);
  } catch {
    throw new Error('That plugin document is no longer available.');
  }
  if (!inside(canonicalRoot, canonicalFile)) {
    throw new Error('Wanigan will not follow a plugin document outside the plugins directory.');
  }

  let fd: number | null = null;
  try {
    // Use the canonical path and then fstat the open descriptor. This avoids
    // loading a whole file after a check and refuses a final symlink on hosts
    // that support O_NOFOLLOW (including supported macOS releases).
    const noFollow = fs.constants.O_NOFOLLOW ?? 0;
    fd = fs.openSync(canonicalFile, fs.constants.O_RDONLY | noFollow);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error('Wanigan can open plugin documents, not directories or devices.');
    const bytesToRead = Math.min(stat.size, MAX_PLUGIN_FILE_BYTES);
    const buffer = Buffer.allocUnsafe(bytesToRead);
    const bytesRead = bytesToRead === 0 ? 0 : fs.readSync(fd, buffer, 0, bytesToRead, 0);
    return {
      text: buffer.subarray(0, bytesRead).toString('utf8'),
      truncated: stat.size > bytesRead,
      bytes: stat.size,
    };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Wanigan ')) throw error;
    throw new Error('Wanigan could not safely open that plugin document.');
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* descriptor was already closed by the OS */ }
    }
  }
}

/** A component's own markdown, for the reading pane. */
export function pluginFile(p: string): { text: string; truncated: boolean; bytes: number } {
  return readPluginFile(p);
}


/* ── the CLI is the source of truth ──────────────────────────────────────
   The disk scan above works offline and needs nothing installed, which is why
   it stays. But `claude plugin list --json` knows two things the filesystem
   does not: whether a plugin is ENABLED, and the full marketplace catalog —
   285 plugins here, against the 54 that happen to be cloned into
   marketplaces/. Reporting the disk count as "what is available" would
   understate it by a factor of five.
   ──────────────────────────────────────────────────────────────────────── */

export type CatalogPlugin = {
  id: string; name: string; marketplace: string; description: string;
  installed: boolean; enabled: boolean; source: string | null;
};

export type PluginAction = { ok: boolean; output: string; error: string | null };

/**
 * `claude plugin` is a subcommand of the Claude Code CLI, so what this needs is
 * a provider running that harness — not the profile that happens to be spelled
 * 'claude'. GLM and DeepSeek resolve the same binary, and a rename or a removal
 * of the built-in id would have left the whole Plugins view reporting that
 * Claude Code was not installed on a machine where it plainly is.
 *
 * Nothing provider-specific rides along: this is the binary only, launched with
 * the shell PATH and no profile environment, so which claude-code profile the
 * path came from cannot change what the catalog says.
 */
async function claudeBin(): Promise<string | null> {
  const found = (await detectProviders()).find((p) => p.harnessId === 'claude-code' && p.path);
  return found?.path ?? null;
}

async function runPlugin(args: string[], timeoutMs = 120_000): Promise<PluginAction> {
  const bin = await claudeBin();
  if (!bin) {
    return {
      ok: false, output: '',
      error: 'Claude Code was not found. Wanigan resolves your login shell PATH and scans editor ' +
             'extension directories — if `claude` runs in your terminal, restart Wanigan.',
    };
  }
  try {
    const { stdout, stderr } = await exec(bin, ['plugin', ...args], {
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, PATH: await shellPath() },
    });
    return { ok: true, output: (stdout || stderr || '').trim(), error: null };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      output: (err.stdout ?? '').trim(),
      error: (err.stderr || err.message || 'The plugin command failed.').trim(),
    };
  }
}

/** Everything the marketplaces offer, with installed/enabled folded in. */
export async function catalog(): Promise<{ plugins: CatalogPlugin[]; note: string | null }> {
  const avail = await runPlugin(['list', '--json', '--available'], 60_000);
  const inst = await runPlugin(['list', '--json'], 30_000);
  if (!avail.ok) {
    return { plugins: [], note: avail.error };
  }
  const installedById = new Map<string, { enabled: boolean }>();
  try {
    for (const r of JSON.parse(inst.output || '[]') as Record<string, unknown>[]) {
      if (typeof r.id === 'string') installedById.set(r.id, { enabled: r.enabled !== false });
    }
  } catch { /* an unreadable installed list just means nothing is marked */ }

  let rows: Record<string, unknown>[] = [];
  try { rows = JSON.parse(avail.output) as Record<string, unknown>[]; } catch { return { plugins: [], note: 'The catalog did not come back as JSON.' }; }

  const plugins = rows.map((r) => {
    const id = String(r.pluginId ?? r.id ?? '');
    const hit = installedById.get(id);
    const src = r.source;
    return {
      id,
      name: String(r.name ?? id.split('@')[0]),
      marketplace: String(r.marketplaceName ?? id.split('@')[1] ?? ''),
      description: String(r.description ?? ''),
      installed: Boolean(hit),
      enabled: hit?.enabled ?? false,
      source: typeof src === 'string' ? src
        : src && typeof src === 'object' && typeof (src as { repo?: unknown }).repo === 'string'
          ? String((src as { repo: string }).repo) : null,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));

  return { plugins, note: null };
}

/**
 * A plugin's inventory and, more usefully, what it costs.
 * `always-on` tokens are added to EVERY session for as long as it is enabled —
 * the number that decides whether a plugin is worth keeping.
 */
export async function details(name: string): Promise<{ text: string; alwaysOnTokens: number | null; error: string | null }> {
  const r = await runPlugin(['details', name], 45_000);
  if (!r.ok) return { text: '', alwaysOnTokens: null, error: r.error };
  const m = /Always-on:\s*~?([\d,]+)\s*tok/i.exec(r.output);
  return {
    text: r.output,
    alwaysOnTokens: m ? Number(m[1].replace(/,/g, '')) : null,
    error: null,
  };
}

/**
 * Installing runs code on this machine: a plugin may ship hooks, an MCP server
 * or an LSP, and the CLI's `-y` accepts a marketplace-declared install command
 * without its confirmation prompt. Wanigan passes -y because it has no TTY, so
 * the UI has to be the place that asks — and it says exactly this before it does.
 */
export async function install(id: string, scope: 'user' | 'project' | 'local' = 'user'): Promise<PluginAction> {
  const r = await runPlugin(['install', id, '-s', scope, '-y'], 180_000);
  refreshPlugins();
  return r;
}

export async function setEnabled(id: string, on: boolean): Promise<PluginAction> {
  const r = await runPlugin([on ? 'enable' : 'disable', id], 60_000);
  refreshPlugins();
  return r;
}

export async function updateMarketplaces(name?: string): Promise<PluginAction> {
  const r = await runPlugin(name ? ['marketplace', 'update', name] : ['marketplace', 'update'], 180_000);
  refreshPlugins();
  return r;
}

export async function addMarketplace(source: string): Promise<PluginAction> {
  const r = await runPlugin(['marketplace', 'add', source], 180_000);
  refreshPlugins();
  return r;
}

export async function removeMarketplace(name: string): Promise<PluginAction> {
  const r = await runPlugin(['marketplace', 'remove', name], 60_000);
  refreshPlugins();
  return r;
}
