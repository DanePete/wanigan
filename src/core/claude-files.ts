// Claude Code's own files, read only. Where each lives was read out of the
// shipped binary (2.1.292) and checked against a throwaway CLAUDE_CONFIG_DIR:
// - the config folder is CLAUDE_CONFIG_DIR, or ~/.claude;
// - its state file (user MCP servers, per-project local servers, the claude.ai
//   login) is `<config>/.config.json` if that legacy file exists, otherwise
//   `.claude.json` inside CLAUDE_CONFIG_DIR, or beside ~/.claude in the home;
// - installed plugins are listed in `<config>/plugins/installed_plugins.json`,
//   and switched on or off in `<config>/settings.json` under enabledPlugins.
import { lstatSync, realpathSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { within } from './safe-fs.ts';
import { readBoundedFile } from './bounded-file.ts';
import { ConfigReadRefused, type ConfigReadBudget } from './config-read.ts';

export function claudeConfigFile(configDir: string | null, home: string): string {
  const folder = configDir ?? join(home, '.claude');
  const legacy = join(folder, '.config.json');
  // Failed lookups and broken links do not establish absence of the preferred file.
  return isMissingFile(legacy) ? join(configDir ?? home, '.claude.json') : legacy;
}

export function readClaudeConfig(configDir: string | null, home: string, budget?: ConfigReadBudget): Record<string, unknown> | null {
  return readJson(claudeConfigFile(configDir, home), 64 * 1024 * 1024, budget);
}

/** A JSON object from a regular file under a size limit, or null. */
export function readJson(file: string, max = 4 * 1024 * 1024, budget?: ConfigReadBudget): Record<string, unknown> | null {
  try {
    let text: string;
    if (budget) text = budget.read(file, max, true).toString('utf8');
    else {
      const st = statSync(file);
      if (!st.isFile() || st.size > max) return null;
      text = readFileSync(file, 'utf8');
    }
    const parsed: unknown = JSON.parse(text);
    const value = budget ? budget.value(parsed) : parsed;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch (error) {
    if (error instanceof ConfigReadRefused) throw error;
    return null;
  }
}

/** Absence needs an existing resolvable ancestor, contained when a root is given. */
export function isMissingFile(file: string, root?: string): boolean {
  let current = file;
  for (;;) {
    try { lstatSync(current); } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return false;
      const parent = dirname(current);
      if (parent === current) return false;
      current = parent;
      continue;
    }
    if (current === file) return false;
    try {
      const real = realpathSync(current);
      return !root || within(root, real);
    } catch { return false; }
  }
}

/** A plugin file may link within its installed root, never outside it. */
export function readPluginJson(root: string, file: string, budget?: ConfigReadBudget): { json: Record<string, unknown> | null; error: string | null } {
  if (!within(root, file)) return { json: null, error: 'the declared file is outside its plugin' };
  if (isMissingFile(file, root)) return { json: null, error: null };
  let text: string;
  try {
    const realRoot = realpathSync(root), realFile = realpathSync(file);
    if (realRoot !== root || !within(realRoot, realFile)) return { json: null, error: 'the file leads outside its plugin' };
    // Open the checked canonical leaf without following another link. These
    // pre/post path checks do not exclude arbitrary concurrent ancestor swaps.
    text = (budget ? budget.read(realFile, 4 * 1024 * 1024) : readBoundedFile(realFile, 4 * 1024 * 1024)).toString('utf8');
    if (realpathSync(root) !== realRoot || realpathSync(file) !== realFile) return { json: null, error: 'the plugin file changed while being read' };
  } catch (e) {
    if (e instanceof ConfigReadRefused) throw e;
    const code = (e as NodeJS.ErrnoException).code;
    return { json: null, error: code === 'EACCES' || code === 'EPERM' ? 'permission was denied' : 'the plugin file could not be read' };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    const json = budget ? budget.value(parsed) : parsed;
    if (json && typeof json === 'object' && !Array.isArray(json)) return { json: json as Record<string, unknown>, error: null };
  } catch (error) { if (error instanceof ConfigReadRefused) throw error; /* Parser messages can quote configuration contents. */ }
  return { json: null, error: 'invalid JSON object' };
}

/** The synced-skills folder for the signed-in claude.ai login: `<organization>_<account>`. */
export function syncedBucket(config: Record<string, unknown> | null): string | null {
  const o = config?.oauthAccount as { organizationUuid?: unknown; accountUuid?: unknown } | undefined;
  if (typeof o?.organizationUuid !== 'string' || typeof o.accountUuid !== 'string') return null;
  const bucket = `${o.organizationUuid}_${o.accountUuid}`.toLowerCase();
  return /^[0-9a-f-]+_[0-9a-f-]+$/.test(bucket) ? bucket : null;
}

export interface InstalledPlugin {
  /** `name@marketplace`. */
  key: string;
  name: string;
  /** The installed version's folder (real path, inside `<config>/plugins`). */
  root: string;
  /** Skill folders it declares: `skills/`, plus any its manifest lists. */
  skillDirs: string[];
  manifest: Record<string, unknown> | null;
  /** A failed manifest read is not an absent declaration. */
  manifestError: string | null;
  /** Its switch in settings.json; null when not set. */
  enabled: boolean | null;
}

/**
 * Plugins Claude Code installed for an account. Only the installed version is
 * read, never the stale copies in the cache beside it, and nothing a plugin
 * declares may lead out of its own folder.
 */
export function installedPlugins(config: string, budget?: ConfigReadBudget): InstalledPlugin[] {
  const installed = readJson(join(config, 'plugins', 'installed_plugins.json'), 4 * 1024 * 1024, budget);
  const settings = readJson(join(config, 'settings.json'), 4 * 1024 * 1024, budget);
  const switches = (settings?.enabledPlugins && typeof settings.enabledPlugins === 'object' ? settings.enabledPlugins : {}) as Record<string, unknown>;
  const plugins = (installed?.plugins && typeof installed.plugins === 'object' ? installed.plugins : {}) as Record<string, unknown>;
  const pluginRoot = join(config, 'plugins');
  let realPluginRoot = pluginRoot;
  try { realPluginRoot = realpathSync(pluginRoot); } catch { /* none installed */ }
  const out: InstalledPlugin[] = [];
  for (const [key, value] of Object.entries(plugins).sort(([a], [b]) => a.localeCompare(b))) {
    const entries = Array.isArray(value) ? value : [value];
    const entry = entries.find((e) => e && typeof e === 'object' && typeof (e as { installPath?: unknown }).installPath === 'string') as { installPath: string } | undefined;
    if (!entry || !within(pluginRoot, entry.installPath)) continue;
    let root: string;
    try { root = realpathSync(entry.installPath); } catch { continue; }
    if (!within(realPluginRoot, root)) continue;
    const { json: manifest, error: manifestError } = readPluginJson(root, join(root, '.claude-plugin', 'plugin.json'), budget);
    const declared = manifest?.skills;
    const extra = (Array.isArray(declared) ? declared : typeof declared === 'string' ? [declared] : []).filter((s): s is string => typeof s === 'string');
    const dirs = [join(root, 'skills'), ...extra.map((s) => join(root, s))].filter((d) => within(root, d));
    const flag = switches[key];
    out.push({
      key, name: key.split('@')[0] ?? key, root, skillDirs: [...new Set(dirs)], manifest, manifestError,
      enabled: flag === true ? true : flag === false ? false : null,
    });
  }
  return out;
}
