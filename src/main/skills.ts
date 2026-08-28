import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { listProjects, projectById } from './store';

/**
 * Skill discovery, from disk.
 *
 * Three of the four sources are real directories Foreman can read and keep
 * honest: the user's own skills, a project's checked-in skills, and whatever
 * plugins have installed. The fourth — the skills bundled inside Claude Code
 * itself — deliberately is not, and pretending otherwise would be the whole
 * bug: the CLI extracts a bundled skill to a temp directory only once it has
 * been used, so scanning that directory reports "the skills you happened to
 * invoke recently" while looking exactly like a complete inventory.
 *
 * So built-ins are reported as seen-or-not, labelled as such, and never
 * presented as the full set.
 */

export type SkillSource = 'user' | 'project' | 'plugin' | 'builtin';

export type SkillInfo = {
  name: string;
  description: string;
  source: SkillSource;
  /** Absolute path to SKILL.md. */
  path: string;
  dir: string;
  /** What you type to invoke it. Plugin skills are namespaced. */
  invoke: string;
  plugin: string | null;
  marketplace: string | null;
  projectId: string | null;
  allowedTools: string[];
  /** Helper files shipped alongside the skill, which is a rough proxy for depth. */
  extras: number;
  bytes: number;
  modified: number;
};

const HOME = os.homedir();
const USER_SKILLS = path.join(HOME, '.claude', 'skills');
const PLUGIN_ROOT = path.join(HOME, '.claude', 'plugins');
/** Where the CLI extracts bundled skills, per version. Incomplete by design. */
const BUNDLED_ROOT = `/private/tmp/claude-${process.getuid?.() ?? 501}/bundled-skills`;

/* ── frontmatter ─────────────────────────────────────────────────────── */

/**
 * A deliberately small YAML reader. Skill frontmatter is a flat map of
 * scalars, and a real parser would be a dependency bought to read four keys.
 * Anything it does not understand is skipped rather than guessed at.
 */
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
    if (m && !/^\s/.test(line)) {
      key = m[1];
      out[key] = unquote(m[2]);
      continue;
    }
    // A folded or indented continuation belongs to the key above it. Long
    // descriptions wrap, and dropping the tail truncates them mid-sentence.
    if (key && /^\s+\S/.test(line)) {
      out[key] = (out[key] ? out[key] + ' ' : '') + unquote(line.trim());
    }
  }
  return out;
}

function unquote(v: string): string {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
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

function readSkill(skillMd: string, source: SkillSource, extra: Partial<SkillInfo> = {}): SkillInfo | null {
  // A SKILL.md is prose with frontmatter; anything enormous is not one — and
  // the cap has to bound the READ, since discoverSkills runs this over every
  // skill directory on the machine on each cache miss.
  const head = readHead(skillMd, 64 * 1024);
  if (!head) return null;
  const { text, st } = head;

  const fm = parseFrontmatter(text);
  const dir = path.dirname(skillMd);
  const name = fm.name || path.basename(dir);
  if (!name) return null;

  const plugin = extra.plugin ?? null;
  return {
    name,
    description: fm.description || firstProse(text) || 'No description.',
    source,
    path: skillMd,
    dir,
    invoke: plugin ? `/${plugin}:${name}` : `/${name}`,
    plugin,
    marketplace: extra.marketplace ?? null,
    projectId: extra.projectId ?? null,
    allowedTools: (fm['allowed-tools'] || fm.allowedTools || '')
      .split(',').map((s) => s.trim()).filter(Boolean),
    extras: countExtras(dir),
    bytes: st.size,
    modified: st.mtimeMs,
  };
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

function scanSkillDir(root: string, source: SkillSource, extra: Partial<SkillInfo> = {}): SkillInfo[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  const out: SkillInfo[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const s = readSkill(path.join(root, e.name, 'SKILL.md'), source, extra);
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
function scanPlugins(): SkillInfo[] {
  const out: SkillInfo[] = [];
  const marketplaces = path.join(PLUGIN_ROOT, 'marketplaces');
  let mkts: string[];
  try { mkts = fs.readdirSync(marketplaces); } catch { return []; }

  for (const mkt of mkts) {
    for (const bucket of ['plugins', 'external_plugins']) {
      const base = path.join(marketplaces, mkt, bucket);
      let plugins: string[];
      try { plugins = fs.readdirSync(base); } catch { continue; }
      for (const plugin of plugins) {
        out.push(...scanSkillDir(
          path.join(base, plugin, 'skills'), 'plugin', { plugin, marketplace: mkt }
        ));
      }
    }
  }
  return out;
}

/** Built-ins the CLI has extracted so far. Never a complete list — see above. */
function scanBundledSeen(): SkillInfo[] {
  let versions: string[];
  try { versions = fs.readdirSync(BUNDLED_ROOT); } catch { return []; }
  const newest = versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  const seen = new Map<string, SkillInfo>();
  for (const v of newest) {
    let hashes: string[];
    try { hashes = fs.readdirSync(path.join(BUNDLED_ROOT, v)); } catch { continue; }
    for (const h of hashes) {
      for (const s of scanSkillDir(path.join(BUNDLED_ROOT, v, h), 'builtin')) {
        if (!seen.has(s.name)) seen.set(s.name, s);
      }
    }
  }
  return [...seen.values()];
}

/* ── the catalogue ───────────────────────────────────────────────────── */

export type SkillCatalogue = {
  skills: SkillInfo[];
  counts: Record<SkillSource, number>;
  /** Where each source was read from, so an empty section is explicable. */
  roots: { source: SkillSource; path: string; exists: boolean; note: string | null }[];
  scannedAt: number;
};

let cache: { key: string; at: number; value: SkillCatalogue } | null = null;
const TTL_MS = 20_000;

export function discoverSkills(projectId?: string): SkillCatalogue {
  const project = projectId ? projectById(projectId) : undefined;
  const key = project?.path ?? '';
  if (cache && cache.key === key && Date.now() - cache.at < TTL_MS) return cache.value;

  const projectSkills = project
    ? scanSkillDir(path.join(project.path, '.claude', 'skills'), 'project', { projectId: project.id })
    : [];

  const skills = [
    ...scanSkillDir(USER_SKILLS, 'user'),
    ...projectSkills,
    ...scanPlugins(),
    ...scanBundledSeen(),
  ];

  // A project skill shadows a user skill of the same name, which shadows a
  // plugin one. Showing both would misreport which file actually runs.
  const rank: Record<SkillSource, number> = { project: 0, user: 1, plugin: 2, builtin: 3 };
  const byName = new Map<string, SkillInfo>();
  for (const s of skills.sort((a, b) => rank[a.source] - rank[b.source])) {
    if (!byName.has(s.name)) byName.set(s.name, s);
  }

  const final = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  const counts: Record<SkillSource, number> = { user: 0, project: 0, plugin: 0, builtin: 0 };
  for (const s of final) counts[s.source]++;

  const value: SkillCatalogue = {
    skills: final,
    counts,
    roots: [
      { source: 'user', path: USER_SKILLS, exists: fs.existsSync(USER_SKILLS), note: null },
      {
        source: 'project',
        path: project ? path.join(project.path, '.claude', 'skills') : '—',
        exists: Boolean(project && fs.existsSync(path.join(project.path, '.claude', 'skills'))),
        note: project ? null : 'Pick a project to see its checked-in skills.',
      },
      { source: 'plugin', path: path.join(PLUGIN_ROOT, 'marketplaces'), exists: fs.existsSync(PLUGIN_ROOT), note: null },
      {
        source: 'builtin',
        path: BUNDLED_ROOT,
        exists: fs.existsSync(BUNDLED_ROOT),
        note: 'Claude Code extracts a bundled skill only once it has been used, so this shows the ones seen so far — not every built-in.',
      },
    ],
    scannedAt: Date.now(),
  };

  cache = { key, at: Date.now(), value };
  return value;
}

export function refreshSkills(): void {
  cache = null;
}

/** Every directory a skill is allowed to be read from. */
function skillRoots(): string[] {
  const roots = [USER_SKILLS, PLUGIN_ROOT, BUNDLED_ROOT];
  try {
    for (const p of listProjects()) roots.push(path.join(p.path, '.claude', 'skills'));
  } catch {
    // A closed database costs us the project roots only; the rest still apply.
  }
  return roots;
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
    throw new Error(`Foreman could not open ${skillPath}. Refresh the skill list — the file has probably moved or been deleted.`);
  }
  if (!skillRoots().some((root) => isInside(root, real))) {
    throw new Error(`${skillPath} is not inside a skills directory Foreman knows about, so it will not be read. Open a skill listed in the Skills view instead.`);
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
