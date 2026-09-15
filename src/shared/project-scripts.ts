/**
 * A project's runnable scripts — package.json scripts, Makefile targets and
 * justfile recipes — read from the files themselves, and the one command line
 * that runs each.
 *
 * Pure, so the parsers can be held to real-world shapes in a tenth of a second.
 * No parser here executes anything or evaluates a Makefile: a target list read
 * by pattern is an honest list of what the file declares, and `make -pn` would
 * be running the project's build system just to draw a menu.
 */

export type ScriptSource = 'package.json' | 'Makefile' | 'justfile';
export const SCRIPT_SOURCES: readonly ScriptSource[] = ['package.json', 'Makefile', 'justfile'];

export type ProjectScript = {
  source: ScriptSource;
  name: string;
  /** What the file says the script does: the package.json value, or the recipe's first lines. */
  body: string;
  /** A `## comment` above a Makefile target or a `# comment` above a just recipe. */
  doc: string | null;
};

/** Names that can be passed as one shell word without quoting. Anything else is listed but not runnable. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,120}$/;
const MAX_BODY = 400;

function clip(text: string): string {
  const t = text.trim();
  return t.length > MAX_BODY ? `${t.slice(0, MAX_BODY - 1)}…` : t;
}

export function runnableName(name: string): boolean {
  return SAFE_NAME.test(name);
}

/** package.json `scripts`. A file that does not parse yields nothing and says so. */
export function packageScripts(text: string): { scripts: ProjectScript[]; problem: string | null } {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { scripts: [], problem: 'package.json is not valid JSON, so its scripts could not be read.' }; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { scripts: [], problem: 'package.json is not a JSON object.' };
  const scripts = (raw as { scripts?: unknown }).scripts;
  if (scripts === undefined) return { scripts: [], problem: null };
  if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) return { scripts: [], problem: 'package.json "scripts" is not an object.' };
  const out: ProjectScript[] = [];
  for (const [name, body] of Object.entries(scripts as Record<string, unknown>)) {
    if (typeof body !== 'string') continue;
    out.push({ source: 'package.json', name, body: clip(body), doc: null });
  }
  return { scripts: out, problem: null };
}

/**
 * Makefile targets a person would type: explicit rules at column zero.
 *
 * Left out, deliberately: special targets (`.PHONY`, `.DEFAULT`), pattern rules
 * (`%.o: %.c`), variable assignments (`CC := clang`, `X ?= y`, `A::=b`), target-
 * specific variables (`build: CFLAGS += -O2`), and anything inside a `define`
 * block. A `##` comment on the line above, or after the prerequisites, is kept
 * as the target's description — the common self-documenting convention.
 */
export function makeTargets(text: string): ProjectScript[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: ProjectScript[] = [];
  const seen = new Set<string>();
  let inDefine = false;
  let pendingDoc: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*define\b/.test(line)) { inDefine = true; continue; }
    if (inDefine) { if (/^\s*endef\b/.test(line)) inDefine = false; continue; }
    const doc = /^##\s?(.*)$/.exec(line);
    if (doc) { pendingDoc = doc[1].trim() || null; continue; }
    if (!line || line.startsWith('\t') || line.startsWith(' ') || line.startsWith('#')) {
      if (!line.startsWith('\t')) pendingDoc = null;
      continue;
    }
    // A rule line: targets, one colon (or two for double-colon rules), not an assignment.
    const rule = /^([^:=#]+?)\s*::?(?!=)\s*([^=]*)$/.exec(line);
    if (!rule) { pendingDoc = null; continue; }
    const [, targets, rest] = rule;
    if (/(^|\s)(\+|\?|!)?=/.test(rest)) { pendingDoc = null; continue; }
    if (/^\s*(export|override|unexport|include|-include|sinclude|ifeq|ifneq|ifdef|ifndef|else|endif|vpath)\b/.test(targets)) { pendingDoc = null; continue; }
    const inline = /##\s?(.*)$/.exec(rest);
    const recipe: string[] = [];
    for (let j = i + 1; j < lines.length && lines[j].startsWith('\t') && recipe.length < 3; j++) recipe.push(lines[j].trim());
    for (const target of targets.trim().split(/\s+/)) {
      if (!target || target.startsWith('.') || target.includes('%') || target.includes('$') || seen.has(target)) continue;
      seen.add(target);
      out.push({ source: 'Makefile', name: target, body: clip(recipe.join('\n')), doc: (inline?.[1].trim() || pendingDoc) ?? null });
    }
    pendingDoc = null;
  }
  return out;
}

/**
 * justfile recipes, the ones `just --list` shows: private recipes (a leading
 * underscore, or a `[private]` attribute) are left out, as are settings,
 * aliases, variable assignments, imports and modules.
 */
export function justRecipes(text: string): ProjectScript[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: ProjectScript[] = [];
  const seen = new Set<string>();
  let doc: string | null = null;
  let privateNext = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) { doc = null; privateNext = false; continue; }
    if (/^\s/.test(line)) continue;
    const comment = /^#\s?(.*)$/.exec(line);
    if (comment) { if (!line.startsWith('#!')) doc = comment[1].trim() || null; continue; }
    const attribute = /^\[([^\]]*)\]\s*$/.exec(line);
    if (attribute) {
      if (/(^|,)\s*private\s*(,|$)/.test(attribute[1])) privateNext = true;
      const described = /doc\(\s*["']([^"']*)["']\s*\)/.exec(attribute[1]);
      if (described) doc = described[1];
      continue;
    }
    if (/^(set|alias|export|import|mod)\b/.test(line)) { doc = null; privateNext = false; continue; }
    if (/^[A-Za-z_][A-Za-z0-9_-]*\s*:=/.test(line)) { doc = null; privateNext = false; continue; }
    const recipe = /^@?([A-Za-z_][A-Za-z0-9_-]*)((?:\s+[^:]*?)?)\s*:(?!=)(.*)$/.exec(line);
    if (!recipe) { doc = null; privateNext = false; continue; }
    const name = recipe[1];
    const body: string[] = [];
    for (let j = i + 1; j < lines.length && /^\s+\S/.test(lines[j]) && body.length < 3; j++) body.push(lines[j].trim());
    if (!name.startsWith('_') && !privateNext && !seen.has(name)) {
      seen.add(name);
      const params = recipe[2].trim();
      out.push({ source: 'justfile', name, body: clip([params ? `(parameters: ${params})` : '', ...body].filter(Boolean).join('\n')), doc });
    }
    doc = null;
    privateNext = false;
  }
  return out;
}

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

/** Which runner a package.json script belongs to, from the lockfile beside it. npm when there is none. */
export function packageManagerFor(files: readonly string[]): PackageManager {
  const has = (name: string) => files.includes(name);
  if (has('pnpm-lock.yaml')) return 'pnpm';
  if (has('yarn.lock')) return 'yarn';
  if (has('bun.lockb') || has('bun.lock')) return 'bun';
  return 'npm';
}

/** The command line an operator's terminal is given, or null when the name is not one safe shell word. */
export function commandFor(script: Pick<ProjectScript, 'source' | 'name'>, manager: PackageManager): string | null {
  if (!runnableName(script.name)) return null;
  switch (script.source) {
    case 'package.json': return `${manager} run ${script.name}`;
    case 'Makefile': return `make ${script.name}`;
    case 'justfile': return `just ${script.name}`;
  }
}

/** Which file names each source is read from, first match wins. */
export const SCRIPT_FILES: Record<ScriptSource, readonly string[]> = {
  'package.json': ['package.json'],
  Makefile: ['GNUmakefile', 'makefile', 'Makefile'],
  justfile: ['justfile', '.justfile', 'Justfile'],
};

export type FavouriteKey = { source: ScriptSource; name: string };

/** Favourites first, in the order they were starred; the rest in file order. */
export function orderScripts<T extends FavouriteKey>(scripts: readonly T[], favourites: readonly FavouriteKey[]): (T & { favourite: boolean })[] {
  const rank = new Map(favourites.map((f, i) => [`${f.source} ${f.name}`, i] as const));
  return scripts
    .map((s, i) => ({ s, i, fav: rank.get(`${s.source} ${s.name}`) }))
    .sort((a, b) => (a.fav ?? Infinity) - (b.fav ?? Infinity) || a.i - b.i)
    .map(({ s, fav }) => ({ ...s, favourite: fav !== undefined }));
}

/* ── what crosses to the renderer ────────────────────────────────────── */

/** A directory a script can run in: the project checkout or one of its Wanigan worktrees. */
export type ScriptTarget = { kind: 'project' | 'worktree'; path: string; label: string; branch: string | null };

export type ScriptListing = {
  target: ScriptTarget;
  targets: ScriptTarget[];
  packageManager: PackageManager;
  /** `command` is null when the name is not safe to pass to a shell; such a script is shown but cannot be run. */
  scripts: (ProjectScript & { favourite: boolean; command: string | null })[];
  notes: string[];
};

/** One of the operator's own terminals. Never an agent session, and never in the session list. */
export type OperatorTerminal = {
  id: string;
  projectId: string;
  cwd: string;
  targetLabel: string;
  /** The script name, or "shell" for a terminal opened with nothing to run. */
  label: string;
  pid: number;
  command: string | null;
  startedAt: number;
  /** The shell's own exit code once it exits — not the script's, which runs inside it. */
  exitCode: number | null;
  endedAt: number | null;
};

export function isScriptSource(value: unknown): value is ScriptSource {
  return typeof value === 'string' && (SCRIPT_SOURCES as readonly string[]).includes(value);
}
