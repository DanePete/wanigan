import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { db } from './db';
import { listProjects, projectById } from './store';
import { skillOverrides } from './context/config';
import type {
  ProjectionStatus, Session, ShadowedSkill, SkillInvocability, SkillOverrideEntry,
  SkillProjectionLink, SkillSendDecision, SkillSource,
} from '../shared/types';

/**
 * Skill discovery, from disk.
 *
 * Three of Claude Code's four sources are real directories Wanigan can read
 * and keep honest: the user's own skills, a project's checked-in skills, and
 * whatever plugins have installed. The fourth — the skills bundled inside
 * Claude Code itself — deliberately is not, and pretending otherwise would be
 * the whole bug: the CLI extracts a bundled skill to a temp directory only
 * once it has been used, so scanning that directory reports "the skills you
 * happened to invoke recently" while looking exactly like a complete inventory.
 *
 * So built-ins are reported as seen-or-not, labelled as such, and never
 * presented as the full set.
 *
 * The `.agents/skills` family is catalogued too, as the directories the Codex
 * harness reads and Wanigan's own Codex compiler writes into. Codex's loader
 * was not consulted: those rows say a file exists, not that a Codex session
 * would load it, and they carry no invocation because Wanigan has not verified
 * one. They live in their own list so nothing reads them as Claude commands.
 */

export type { SkillSource } from '../shared/types';

export type SkillInfo = {
  /**
   * What the command is keyed by. For personal and project skills that is the
   * DIRECTORY name: the docs say a frontmatter `name` there "sets only the
   * display label shown in skill listings, and the command still comes from
   * the directory name" (docs/en/skills, read 2026-09-05 against CLI 2.1.261).
   * For plugin skills it is the frontmatter name, directory as fallback, and
   * the plugin prefix stays in place.
   */
  name: string;
  /** The display label: frontmatter `name` when present, else `name`. */
  label: string;
  description: string;
  source: SkillSource;
  /** Whose loader reads the root this came from. */
  harness: 'claude-code' | 'codex';
  /** Absolute path to SKILL.md. */
  path: string;
  dir: string;
  /**
   * What you type to invoke it. Plugin skills are namespaced. Empty for the
   * `.agents` family: Wanigan has not verified how Codex invokes one.
   */
  invoke: string;
  plugin: string | null;
  marketplace: string | null;
  projectId: string | null;
  allowedTools: string[];
  /** Helper files shipped alongside the skill, which is a rough proxy for depth. */
  extras: number;
  bytes: number;
  modified: number;
  /** Predicted from SKILL.md frontmatter and skillOverrides; never a runtime fact. */
  invocable: SkillInvocability;
  /** Set when Wanigan's own compiler wrote this file — an applied or stale projection. */
  projection: SkillProjectionLink | null;
};

const HOME = os.homedir();
/** Where the CLI extracts bundled skills, per version. Incomplete by design. */
const BUNDLED_ROOT = `/private/tmp/claude-${process.getuid?.() ?? 501}/bundled-skills`;
const BUNDLED_NOTE = 'Claude Code extracts a bundled skill only once it has been used, so this shows the ones seen so far — not every built-in.';
const AGENTS_NOTE = 'Read by the Codex harness. Wanigan lists what is on disk and did not consult Codex’s loader, so a row here is not proof that a Codex session loads it.';

/* ── roots, per harness ──────────────────────────────────────────────── */

export type SkillRootSpec = { source: SkillSource; path: string; note: string | null };

export type SkillRoots = {
  harness: string;
  /** Directories the harness reads skills from. */
  read: SkillRootSpec[];
  /** Where a compiler may put a new skill directory; null when the harness has no verified location. */
  write: { personal: string | null; project: string | null };
};

/**
 * The one place a harness's skill directories are spelled out. Discovery,
 * body containment and the artifact compilers used to each carry their own
 * copy of these paths; three copies is how one of them drifts. Keyed by
 * harness, never by profile id: GLM runs the Claude Code harness and reads
 * Claude's roots, and an unknown harness gets NO roots, because reporting
 * Claude's would present another CLI's directory as this one's.
 *
 * `configDir` is CLAUDE_CONFIG_DIR: an account launched under one keeps its
 * personal skills and plugins under that directory, not ~/.claude.
 */
export function skillRootsFor(
  harness: string,
  ctx: { homeDir: string; projectRoot?: string | null; configDir?: string | null },
): SkillRoots {
  const root = ctx.projectRoot ?? null;
  if (harness === 'claude-code') {
    const base = ctx.configDir || path.join(ctx.homeDir, '.claude');
    const personal = path.join(base, 'skills');
    const read: SkillRootSpec[] = [{ source: 'user', path: personal, note: null }];
    if (root) read.push({ source: 'project', path: path.join(root, '.claude', 'skills'), note: null });
    read.push({ source: 'plugin', path: path.join(base, 'plugins'), note: null });
    read.push({ source: 'builtin', path: BUNDLED_ROOT, note: BUNDLED_NOTE });
    return { harness, read, write: { personal, project: root ? path.join(root, '.claude', 'skills') : null } };
  }
  if (harness === 'codex') {
    // Only the two directories Wanigan's Codex compiler writes to and the
    // agentskills.io layout names. If the CLI also reads ~/.codex/skills, that
    // is unverified here and so not catalogued.
    const personal = path.join(ctx.homeDir, '.agents', 'skills');
    const read: SkillRootSpec[] = [{ source: 'agents-user', path: personal, note: AGENTS_NOTE }];
    if (root) read.push({ source: 'agents-project', path: path.join(root, '.agents', 'skills'), note: AGENTS_NOTE });
    return { harness, read, write: { personal, project: root ? path.join(root, '.agents', 'skills') : null } };
  }
  return { harness, read: [], write: { personal: null, project: null } };
}

/* ── frontmatter ─────────────────────────────────────────────────────── */

/**
 * A frontmatter value: a scalar, or the items of a YAML sequence. Two shapes
 * because frontmatter has two, and collapsing them is how a list of tools
 * became one fake tool — see parseFrontmatter.
 */
type Frontmatter = Record<string, string | string[] | undefined>;

/**
 * A deliberately small YAML reader. Skill frontmatter is a flat map of scalars
 * and short sequences, and a real parser would be a dependency bought to read
 * five keys. Anything it does not understand is skipped rather than guessed at.
 */
function parseFrontmatter(text: string): Frontmatter {
  if (!text.startsWith('---')) return {};
  const end = text.indexOf('\n---', 3);
  if (end === -1) return {};
  const block = text.slice(text.indexOf('\n', 3) + 1, end);

  const out: Frontmatter = {};
  let key: string | null = null;
  for (const raw of block.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;

    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (m && !/^\s/.test(line)) {
      key = m[1];
      out[key] = unquote(m[2]);
      continue;
    }
    if (!key) continue;

    // An indented `- item` opens or continues a block sequence under the key
    // above it. It used to be folded into the scalar like any other wrapped
    // line, which turned claude-security's seven-entry allowed-tools list into
    // one 129-character "tool" starting "- Read - Write - Glob" and a second
    // 609-character one holding every Bash rule at once: the Skills view then
    // rendered those as chips, stating tool names no skill has. Collected as
    // items instead, so nothing downstream has to guess where one ends.
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item) {
      const prev = out[key];
      const items = Array.isArray(prev) ? prev : [];
      // `key:` on its own leaves an empty scalar, which is the sequence's real
      // opening. Anything else there was text, and is kept rather than dropped.
      if (!Array.isArray(prev) && prev) items.push(prev);
      items.push(unquote(item[1]));
      out[key] = items;
      continue;
    }
    // A folded or indented continuation belongs to the key above it. Long
    // descriptions wrap, and dropping the tail truncates them mid-sentence.
    if (/^\s+\S/.test(line)) {
      const prev = out[key];
      if (Array.isArray(prev)) prev[prev.length - 1] += ' ' + unquote(line.trim());
      else out[key] = (prev ? prev + ' ' : '') + unquote(line.trim());
    }
  }
  return out;
}

/**
 * The scalar reading of a key. A key written as a sequence has none: handing
 * its items back as one joined string is the fold this parser stopped doing.
 */
function fmText(fm: Frontmatter, key: string): string | undefined {
  const v = fm[key];
  return typeof v === 'string' ? v : undefined;
}

/**
 * A key's items, from whichever of the three forms the file used: a block
 * sequence (already items), the flow form `[a, b]`, or the single line `a, b`.
 * The two comma forms split at top-level commas only — the comma in
 * `Agent(one, two)` or `Bash(git diff, git log)` is part of one rule, not the
 * boundary between two, and splitting on it named tools that do not exist.
 */
function fmList(fm: Frontmatter, key: string): string[] {
  const v = fm[key];
  if (Array.isArray(v)) return v.map((s) => s.trim()).filter(Boolean);
  if (typeof v !== 'string') return [];

  const flow = /^\[[\s\S]*\]$/.test(v.trim()) ? v.trim().slice(1, -1) : v;
  const items: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of flow) {
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) { items.push(cur); cur = ''; continue; }
    cur += ch;
  }
  items.push(cur);
  return items.map(unquote).filter(Boolean);
}

function unquote(v: string): string {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * YAML 1.1 booleans, which is what the CLI's frontmatter reader accepts:
 * true/false, yes/no, on/off, y/n in any case. Absent is null; a value that is
 * none of these is 'unknown', because guessing which way an unparseable flag
 * falls is how a hidden skill gets a Send button.
 */
function yamlBool(v: string | undefined): boolean | 'unknown' | null {
  if (v === undefined) return null;
  const t = v.trim().toLowerCase();
  if (!t) return null;
  if (['true', 'yes', 'on', 'y'].includes(t)) return true;
  if (['false', 'no', 'off', 'n'].includes(t)) return false;
  return 'unknown';
}

function countExtras(dir: string): number {
  let n = 0;
  const walk = (d: string, depth: number) => {
    if (depth > 3) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      if (e.isDirectory()) walk(path.join(d, e.name), depth + 1);
      else if (e.name !== 'SKILL.md') n++;
    }
  };
  walk(dir, 0);
  return n;
}

/**
 * The first `max` bytes of a regular file, and its stat. Null if it is neither.
 *
 * Reading the whole file and slicing afterwards is the version that looks the
 * same and is not: this runs synchronously on the main process — the one
 * serving IPC, the PTY session list and the batch poller — so a SKILL.md that
 * is a generated file, or a symlink to a big log, freezes every window for as
 * long as the read takes, and past V8's ~512 MB string limit throws
 * ERR_STRING_TOO_LONG instead. The isFile() test is part of the bound, not a
 * tidiness check: a SKILL.md symlinked to a character device such as
 * /dev/urandom never reaches EOF, so an unbounded read never returns at all.
 */
function readHead(file: string, max: number): { text: string; st: fs.Stats } | null {
  let st: fs.Stats;
  try { st = fs.statSync(file); } catch { return null; }
  if (!st.isFile()) return null;

  let fd: number;
  try { fd = fs.openSync(file, 'r'); } catch { return null; }
  try {
    const buf = Buffer.alloc(Math.min(st.size, max));
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return { text: buf.subarray(0, n).toString('utf8'), st };
  } catch {
    return null;
  } finally {
    try { fs.closeSync(fd); } catch { /* already gone */ }
  }
}

/** Which of the two names on a skill is its command: see SkillInfo.name. */
type Identity = 'directory' | 'frontmatter';

/** A scanned skill plus the frontmatter it was read from, kept for the invocability pass. */
type Scanned = { skill: SkillInfo; fm: Frontmatter };

function harnessOf(source: SkillSource): SkillInfo['harness'] {
  return source === 'agents-user' || source === 'agents-project' ? 'codex' : 'claude-code';
}

function readSkill(
  skillMd: string, source: SkillSource, identity: Identity, extra: Partial<SkillInfo> = {},
): Scanned | null {
  // A SKILL.md is prose with frontmatter; anything enormous is not one — and
  // the cap has to bound the READ, since discoverSkills runs this over every
  // skill directory on the machine on each cache miss.
  const head = readHead(skillMd, 64 * 1024);
  if (!head) return null;
  const { text, st } = head;

  const fm = parseFrontmatter(text);
  const dir = path.dirname(skillMd);
  const dirName = path.basename(dir);
  const name = identity === 'directory' ? dirName : (fmText(fm, 'name') || dirName);
  if (!name) return null;

  // `allowed-tools` is the documented spelling; `allowedTools` is what a few
  // skills on disk write instead. Whichever one carried items wins.
  const allowed = fmList(fm, 'allowed-tools');

  const plugin = extra.plugin ?? null;
  const harness = harnessOf(source);
  const skill: SkillInfo = {
    name,
    label: fmText(fm, 'name') || name,
    description: fmText(fm, 'description') || firstProse(text) || 'No description.',
    source,
    harness,
    path: skillMd,
    dir,
    invoke: harness === 'codex' ? '' : plugin ? `/${plugin}:${name}` : `/${name}`,
    plugin,
    marketplace: extra.marketplace ?? null,
    projectId: extra.projectId ?? null,
    allowedTools: allowed.length > 0 ? allowed : fmList(fm, 'allowedTools'),
    extras: countExtras(dir),
    bytes: st.size,
    modified: st.mtimeMs,
    // Frontmatter alone for now; the override pass runs once the project's
    // settings layers have been read.
    invocable: { user: true, model: true, override: null, decidedBy: null, ambiguous: false },
    projection: null,
  };
  return { skill, fm };
}

/** Fallback for a skill with no description: the first real sentence of prose. */
function firstProse(text: string): string {
  const body = text.replace(/^---[\s\S]*?\n---\n/, '');
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#') || t.startsWith('```') || t.startsWith('>')) continue;
    return t.length > 240 ? t.slice(0, 237) + '…' : t;
  }
  return '';
}

/* ── sources ─────────────────────────────────────────────────────────── */

function scanSkillDir(root: string, source: SkillSource, identity: Identity, extra: Partial<SkillInfo> = {}): Scanned[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  const out: Scanned[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const s = readSkill(path.join(root, e.name, 'SKILL.md'), source, identity, extra);
    if (s) out.push(s);
  }
  return out;
}

/**
 * Plugin layout is `<marketplace>/plugins/<plugin>/skills/<skill>/SKILL.md`,
 * with `external_plugins` alongside `plugins`. Both are walked, and the plugin
 * and marketplace names are recovered from the path rather than guessed, since
 * they are what makes the invocation namespaced.
 */
function scanPlugins(pluginRoot: string): Scanned[] {
  const out: Scanned[] = [];
  const marketplaces = path.join(pluginRoot, 'marketplaces');
  let mkts: string[];
  try { mkts = fs.readdirSync(marketplaces); } catch { return []; }

  for (const mkt of mkts) {
    for (const bucket of ['plugins', 'external_plugins']) {
      const base = path.join(marketplaces, mkt, bucket);
      let plugins: string[];
      try { plugins = fs.readdirSync(base); } catch { continue; }
      for (const plugin of plugins) {
        out.push(...scanSkillDir(
          path.join(base, plugin, 'skills'), 'plugin', 'frontmatter', { plugin, marketplace: mkt }
        ));
      }
    }
  }
  return out;
}

/** Built-ins the CLI has extracted so far. Never a complete list — see above. */
function scanBundledSeen(): Scanned[] {
  let versions: string[];
  try { versions = fs.readdirSync(BUNDLED_ROOT); } catch { return []; }
  const newest = versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  const seen = new Map<string, Scanned>();
  for (const v of newest) {
    let hashes: string[];
    try { hashes = fs.readdirSync(path.join(BUNDLED_ROOT, v)); } catch { continue; }
    for (const h of hashes) {
      for (const s of scanSkillDir(path.join(BUNDLED_ROOT, v, h), 'builtin', 'frontmatter')) {
        if (!seen.has(s.skill.name)) seen.set(s.skill.name, s);
      }
    }
  }
  return [...seen.values()];
}

/* ── invocability ────────────────────────────────────────────────────── */

const OVERRIDE_VALUES = new Set(['on', 'name-only', 'user-invocable-only', 'off']);

/**
 * What the frontmatter and the resolved skillOverrides say about who may
 * invoke this skill. Predicted from disk and labelled so; the CLI is the only
 * thing that knows at runtime.
 *
 * Only personal and project skills take a skillOverrides entry by name — the
 * docs say plugin skills are managed through /plugin instead. A bundled skill
 * can be named by name or alias (changelog 2.1.260) and Wanigan has not
 * verified that form, so an entry that matches one is reported and its effect
 * left 'unknown' rather than applied. The `.agents` family is Codex's, whose
 * loader was not consulted: 'unknown' on both counts.
 */
function invocabilityFor(skill: SkillInfo, fm: Frontmatter, overrides: SkillOverrideEntry[]): SkillInvocability {
  if (skill.harness === 'codex') {
    return { user: 'unknown', model: 'unknown', override: null, decidedBy: null, ambiguous: false };
  }

  let user: SkillInvocability['user'] = true;
  let model: SkillInvocability['model'] = true;
  let decidedBy: string | null = null;

  const u = yamlBool(fmText(fm, 'user-invocable'));
  if (u === false || u === 'unknown') { user = u === false ? false : 'unknown'; decidedBy = skill.path; }
  const m = yamlBool(fmText(fm, 'disable-model-invocation'));
  if (m === true || m === 'unknown') { model = m === true ? false : 'unknown'; decidedBy ??= skill.path; }

  const entry = skill.source === 'plugin' ? undefined : overrides.find((o) => o.skill === skill.name);
  if (!entry) return { user, model, override: null, decidedBy, ambiguous: false };

  const ambiguous = entry.shadowed.length > 0;
  const known = OVERRIDE_VALUES.has(entry.value) ? entry.value as NonNullable<SkillInvocability['override']> : null;
  if (skill.source === 'builtin') {
    return { user: 'unknown', model: 'unknown', override: known, decidedBy: entry.path, ambiguous };
  }
  switch (known) {
    case 'off':
      return { user: false, model: false, override: known, decidedBy: entry.path, ambiguous };
    case 'user-invocable-only':
      return { user, model: false, override: known, decidedBy: entry.path, ambiguous };
    case 'name-only':
    case 'on':
      // Listed either way; name-only hides the description from the model but
      // neither value changes who may invoke, so the frontmatter's answer stands.
      return { user, model, override: known, decidedBy, ambiguous };
    default:
      // A value the docs do not list. Not "on" by default: the CLI's reading of
      // it is exactly what is unknown.
      return { user: 'unknown', model: 'unknown', override: null, decidedBy: entry.path, ambiguous };
  }
}

/** Settings are read best-effort: a malformed settings file costs the override column, not the catalogue. */
function safeOverrides(projectPath: string | null): SkillOverrideEntry[] {
  try { return skillOverrides(projectPath); } catch { return []; }
}

/* ── projections ─────────────────────────────────────────────────────── */

/**
 * Which of these files Wanigan's own compilers wrote, by exact target path.
 * Applied and stale only: an undone projection took its file away, so a file
 * still at that path is the user's own. A closed database costs the join and
 * nothing else.
 */
function projectionLinks(paths: string[]): Map<string, SkillProjectionLink> {
  const out = new Map<string, SkillProjectionLink>();
  if (!paths.length) return out;
  let rows: { id: string; item_id: string | null; status: string; provider_id: string; applied_at: number | null; target_path: string }[];
  try {
    rows = db().prepare(`
      SELECT id, item_id, status, provider_id, applied_at, target_path
      FROM knowledge_projections
      WHERE target_format IN ('claude-skill', 'agent-skill') AND status IN ('applied', 'stale')
      ORDER BY created_at DESC
    `).all() as typeof rows;
  } catch {
    return out;
  }
  const wanted = new Set(paths);
  for (const r of rows) {
    if (!wanted.has(r.target_path) || out.has(r.target_path)) continue;
    out.set(r.target_path, {
      projectionId: r.id, itemId: r.item_id, status: r.status as ProjectionStatus,
      providerId: r.provider_id, appliedAt: r.applied_at,
    });
  }
  return out;
}

/* ── the catalogue ───────────────────────────────────────────────────── */

export type SkillRootStatus = { source: SkillSource; path: string; exists: boolean; note: string | null };

export type SkillCatalogue = {
  /** Claude Code's loader: what `/name` runs, one row per command. */
  skills: SkillInfo[];
  counts: Record<SkillSource, number>;
  /** Where each Claude source was read from, so an empty section is explicable. */
  roots: SkillRootStatus[];
  /** Files present but not the one that runs for their command, and which file shadows them. */
  shadowed: ShadowedSkill[];
  /**
   * The `.agents/skills` family, harness-labelled. Listed as found, in no
   * precedence order: Codex's loader was not consulted, so which of two
   * same-named directories it would prefer is not claimed.
   */
  agentSkills: SkillInfo[];
  agentRoots: SkillRootStatus[];
  scannedAt: number;
};

export type DiscoverOptions = {
  /** Test seam: the home the personal and plugin roots hang off. Production callers omit it. */
  homeDir?: string;
};

let cache: { key: string; at: number; value: SkillCatalogue } | null = null;
const TTL_MS = 20_000;

export function discoverSkills(projectId?: string, options: DiscoverOptions = {}): SkillCatalogue {
  const project = projectId ? projectById(projectId) : undefined;
  const home = options.homeDir ?? HOME;
  const key = `${home}|${project?.path ?? ''}`;
  if (cache && cache.key === key && Date.now() - cache.at < TTL_MS) return cache.value;

  const claude = skillRootsFor('claude-code', { homeDir: home, projectRoot: project?.path ?? null });
  const codex = skillRootsFor('codex', { homeDir: home, projectRoot: project?.path ?? null });
  const rootOf = (roots: SkillRoots, source: SkillSource) => roots.read.find((r) => r.source === source) ?? null;

  const scanned: Scanned[] = [];
  const userRoot = rootOf(claude, 'user');
  if (userRoot) scanned.push(...scanSkillDir(userRoot.path, 'user', 'directory'));
  const projectRoot = rootOf(claude, 'project');
  if (projectRoot && project) scanned.push(...scanSkillDir(projectRoot.path, 'project', 'directory', { projectId: project.id }));
  const pluginRoot = rootOf(claude, 'plugin');
  if (pluginRoot) scanned.push(...scanPlugins(pluginRoot.path));
  scanned.push(...scanBundledSeen());
  const agentsUser = rootOf(codex, 'agents-user');
  if (agentsUser) scanned.push(...scanSkillDir(agentsUser.path, 'agents-user', 'directory'));
  const agentsProject = rootOf(codex, 'agents-project');
  if (agentsProject && project) scanned.push(...scanSkillDir(agentsProject.path, 'agents-project', 'directory', { projectId: project.id }));

  // Collision order, from the docs (docs/en/skills, read 2026-09-05, CLI
  // 2.1.261): "enterprise overrides personal, and personal overrides project";
  // a custom skill at any level overrides a bundled one of the same name; and
  // plugin skills cannot collide because their command is namespaced. Keyed by
  // the command, not the bare name, for exactly that last reason — two plugins
  // may each ship a `review`, and both run. Showing both halves of a real
  // collision would misreport which file runs, so the loser is listed under
  // `shadowed` with the winner's path. Enterprise skills are not scanned: the
  // docs do not say where they live.
  const rank: Record<SkillSource, number> = {
    user: 0, project: 1, plugin: 2, builtin: 3, 'agents-user': 4, 'agents-project': 5,
  };
  const byInvoke = new Map<string, Scanned>();
  const shadowed: ShadowedSkill[] = [];
  const claudeRows = scanned.filter((s) => s.skill.harness === 'claude-code')
    .sort((a, b) => rank[a.skill.source] - rank[b.skill.source]);
  for (const s of claudeRows) {
    const winner = byInvoke.get(s.skill.invoke);
    if (!winner) { byInvoke.set(s.skill.invoke, s); continue; }
    shadowed.push({
      invoke: s.skill.invoke, source: s.skill.source, path: s.skill.path,
      shadowedBy: { source: winner.skill.source, path: winner.skill.path },
    });
  }
  const agentRows = scanned.filter((s) => s.skill.harness === 'codex');

  const overrides = safeOverrides(project?.path ?? null);
  const byName = (a: Scanned, b: Scanned) => a.skill.name.localeCompare(b.skill.name);
  const finish = (rows: Scanned[]): SkillInfo[] => rows.sort(byName).map(({ skill, fm }) => ({
    ...skill, invocable: invocabilityFor(skill, fm, overrides),
  }));
  const skills = finish([...byInvoke.values()]);
  const agentSkills = finish(agentRows);

  const links = projectionLinks([...skills, ...agentSkills].map((s) => s.path));
  for (const s of skills) s.projection = links.get(s.path) ?? null;
  for (const s of agentSkills) s.projection = links.get(s.path) ?? null;

  const counts: Record<SkillSource, number> = {
    user: 0, project: 0, plugin: 0, builtin: 0, 'agents-user': 0, 'agents-project': 0,
  };
  for (const s of skills) counts[s.source]++;
  for (const s of agentSkills) counts[s.source]++;

  const status = (spec: SkillRootSpec): SkillRootStatus => ({
    source: spec.source, path: spec.path, exists: fs.existsSync(spec.path), note: spec.note,
  });
  const noProject = (source: SkillSource): SkillRootStatus => ({
    source, path: '—', exists: false, note: 'Pick a project to see its checked-in skills.',
  });
  const roots: SkillRootStatus[] = [
    status(userRoot!),
    projectRoot ? status(projectRoot) : noProject('project'),
    status(rootOf(claude, 'plugin')!),
    status(rootOf(claude, 'builtin')!),
  ];
  const agentRoots: SkillRootStatus[] = [
    status(agentsUser!),
    agentsProject ? status(agentsProject) : noProject('agents-project'),
  ];

  const value: SkillCatalogue = { skills, counts, roots, shadowed, agentSkills, agentRoots, scannedAt: Date.now() };
  cache = { key, at: Date.now(), value };
  return value;
}

export function refreshSkills(): void {
  cache = null;
}

/* ── sending ─────────────────────────────────────────────────────────── */


/**
 * Claude Code commands Wanigan may type that are not skills.
 *
 * Closed on purpose. Everything else routed through `skills:send` must name a
 * skill this project actually has, so this channel cannot become a way to send
 * arbitrary text to an agent. `/init` writes a CLAUDE.md from the repository
 * and the operator reviews the diff before it lands, which is why it is the
 * one entry here.
 */
const CLAUDE_BUILTIN_COMMANDS = new Set(['/init']);

/**
 * Whether typing this skill into that session is something Wanigan has
 * verified. Routed by the session's FROZEN harness, never its profile id: GLM
 * runs the Claude Code harness and takes the same `/name `, while a Codex or
 * generic-terminal session gets an honest refusal with the reason — the form
 * those CLIs expect has not been checked end to end, and typing a guess into a
 * live terminal is not a small mistake. The invocation typed is the
 * catalogue's own string for that command, so the renderer's text is a lookup
 * key and never the bytes.
 */
export function skillSendDecision(session: Session | null | undefined, invoke: string): SkillSendDecision {
  if (!session) {
    return { ok: false, code: 'no-session', reason: 'There is no live session to type into — open one in Sessions first.' };
  }
  if (session.status === 'exited') {
    return { ok: false, code: 'session-exited', reason: 'That session has exited. Resume it from Recent, then send again.' };
  }
  const harness = session.harnessId ?? null;
  if (harness !== 'claude-code') {
    const reason = harness === 'codex'
      ? 'Codex’s skill invocation form is not verified by Wanigan, so nothing is typed into a Codex session. Copy the name and invoke it the way that CLI expects.'
      : `Wanigan has verified the /name form only for the Claude Code harness, not for ${harness ?? 'a session with no recorded harness'}.`;
    return { ok: false, code: 'unsupported-harness', reason };
  }
  const wanted = typeof invoke === 'string' ? invoke.trim() : '';
  // Claude Code's own built-ins are not SKILL.md files and never appear in the
  // catalogue, so gating on the catalogue alone refused them. The list is
  // closed and spelled out here rather than pattern-matched: a caller must not
  // be able to type an arbitrary slash command into a session through this
  // channel, which is the whole reason the gate exists. `/init` is the one the
  // Context view's setup card offers, and it was refused with a message about
  // a skill catalogue that has nothing to do with it.
  if (CLAUDE_BUILTIN_COMMANDS.has(wanted)) return { ok: true, invoke: wanted };
  const catalogue = discoverSkills(session.projectId);
  const skill = wanted ? catalogue.skills.find((s) => s.invoke === wanted) : undefined;
  if (!skill) {
    if (wanted && catalogue.agentSkills.some((s) => s.path === wanted || s.name === wanted.replace(/^\//, ''))) {
      return { ok: false, code: 'no-invocation-form', reason: 'That is a .agents/skills file for the Codex harness; Wanigan has no verified way to invoke it from a session.' };
    }
    return { ok: false, code: 'unknown-skill', reason: `${wanted || 'That'} is not a command in this project’s skill catalogue. Refresh the list and pick a skill from it.` };
  }
  if (skill.invocable.user === false) {
    const where = skill.invocable.decidedBy ? ` (${skill.invocable.override ? `skillOverrides in ${skill.invocable.decidedBy}` : `user-invocable: false in ${skill.invocable.decidedBy}`})` : '';
    return { ok: false, code: 'not-user-invocable', reason: `${skill.invoke} cannot be invoked by you${where}; Claude Code would refuse it too.` };
  }
  return { ok: true, invoke: skill.invoke };
}

/* ── reading ─────────────────────────────────────────────────────────── */

/** Every directory a skill is allowed to be read from, for every harness and every registered project. */
function skillRoots(): string[] {
  const roots = new Set<string>();
  const add = (r: SkillRoots) => { for (const spec of r.read) roots.add(spec.path); };
  add(skillRootsFor('claude-code', { homeDir: HOME }));
  add(skillRootsFor('codex', { homeDir: HOME }));
  try {
    for (const p of listProjects()) {
      add(skillRootsFor('claude-code', { homeDir: HOME, projectRoot: p.path }));
      add(skillRootsFor('codex', { homeDir: HOME, projectRoot: p.path }));
    }
  } catch {
    // A closed database costs us the project roots only; the rest still apply.
  }
  return [...roots];
}

/** Containment after realpath on both sides, so a symlink out of a root is out. */
function isInside(root: string, realFile: string): boolean {
  let realRoot: string;
  try { realRoot = fs.realpathSync(root); } catch { return false; }
  return realFile === realRoot || realFile.startsWith(realRoot + path.sep);
}

/** The SKILL.md itself, for the reading pane. */
export function skillBody(skillPath: string): { text: string; truncated: boolean; bytes: number } {
  const MAX = 200 * 1024;

  // The path arrives from the renderer over IPC, so it is a request and not a
  // fact. Without the containment check `skills:body` will read any file the
  // user can read — an .env, a private key — and paint it into the reading
  // pane; realpath first so a SKILL.md symlinked out of a skills directory
  // cannot be used to walk past it.
  let real: string;
  try {
    real = fs.realpathSync(skillPath);
  } catch {
    throw new Error(`Wanigan could not open ${skillPath}. Refresh the skill list — the file has probably moved or been deleted.`);
  }
  if (!skillRoots().some((root) => isInside(root, real))) {
    throw new Error(`${skillPath} is not inside a skills directory Wanigan knows about, so it will not be read. Open a skill listed in the Skills view instead.`);
  }

  // Read only the cap. readFileSync would load every byte before the slice
  // threw them away, which on a 1.5 GB file hangs the main process — and every
  // window with it — or throws ERR_STRING_TOO_LONG out of the IPC handler.
  const head = readHead(real, MAX);
  if (!head) {
    throw new Error(`${skillPath} is not a readable file, so there is nothing to show. Check that the SKILL.md still exists and is a regular file.`);
  }
  // From the size on disk, not from the length of a string that was already
  // capped — that comparison can never be true once the read is bounded.
  return { text: head.text, truncated: head.st.size > MAX, bytes: head.st.size };
}
