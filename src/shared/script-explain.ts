/**
 * What `npm run analyze` actually runs, said before anyone approves it.
 *
 * An approval card that shows `npm run analyze` shows the alias, and the alias
 * is exactly what an attack hides behind. In a study of 409,000 approve/deny
 * decisions the three `npm run` threats were missed 52.5% of the time against
 * 28.4% for other exfiltration attacks, and `npm run analyze` was approved
 * 64.7% of the time (scalex, "Humans missed 1 in 3 threats approving AI agent
 * commands", 5 Aug 2026). The body of the script is one file read away.
 *
 * Everything here is deterministic and runs no model. It reads manifests the
 * caller has already loaded — `package.json`, a Makefile, a justfile,
 * `composer.json`, both as they are now and as they were at the session's
 * launch commit — and says three things: what the alias runs, which paths and
 * hosts those commands name, and whether running it is something git can take
 * back. Anything it cannot determine it says it cannot confirm. It never
 * expands a variable: `$(CC)` in a Makefile is shown as `$(CC)` and labelled,
 * because the value make will use can come from the command line or the
 * environment, and a confident expansion would be a guess.
 */

import { parseShell, programOf, type ShellSegment } from './shell-parse.ts';
import { expandHome, resolve } from './posix-path.ts';

export type RunnerKind = 'npm' | 'pnpm' | 'yarn' | 'bun' | 'make' | 'just' | 'composer';

export type RunnerCall = {
  kind: RunnerKind;
  /** The script, target or recipe named; null means the runner's default (make's first target). */
  script: string | null;
  /** The directory the runner reads its manifest from. */
  dir: string;
  /** The manifest file this call resolves against. */
  manifest: string;
  /** Workspace, filter or recursive flags, as written. */
  scope: string[];
  /** Command-line variable overrides (`make CC=clang`). */
  overrides: string[];
  notes: string[];
};

export type ExplainStep = {
  /** 0 for the alias's own body, 1 for what that body calls, and so on. */
  depth: number;
  /** Where the line came from: `package.json › scripts.build`, `Makefile › build`. */
  from: string;
  command: string;
  /** `hook` is a pre/post script; `callback` is code the manifest names but Wanigan cannot read. */
  kind: 'body' | 'hook' | 'reference' | 'callback' | 'interpreter-script';
};

export type Reversibility = {
  verdict: 'reversible' | 'not reversible' | 'cannot confirm';
  because: string[];
};

export type ManifestChange = 'changed' | 'unchanged' | 'new since launch' | 'cannot confirm';

export type ScriptExplanation = {
  runner: RunnerKind;
  /** The alias as the agent wrote it, e.g. `npm run analyze`. */
  alias: string;
  script: string | null;
  manifest: string;
  found: boolean;
  steps: ExplainStep[];
  paths: string[];
  hosts: string[];
  reversible: Reversibility;
  /** Whether any manifest entry this resolution read differs from the launch commit. */
  change: ManifestChange;
  changeDetail: string;
  /** Variables left unexpanded, each with what the manifest says about it. */
  unexpanded: { name: string; label: string }[];
  notes: string[];
};

export type ApprovalExplanation = {
  /** Schema version of this record, so a later reader can tell old rows apart. */
  v: 1;
  command: string;
  scripts: ScriptExplanation[];
  launchCommit: string | null;
};

/** Manifest text keyed by absolute path; null means the file does not exist there. */
export type ManifestFiles = {
  now: Record<string, string | null>;
  /** Null when the session has no launch commit to compare against. */
  launch: Record<string, string | null> | null;
  launchCommit: string | null;
};

const MAX_NEST = 4;
const MAX_STEPS = 60;
const MAX_LIST = 20;

/* ── recognising a runner ────────────────────────────────────────────── */

const NPM_RUN = new Set(['run', 'run-script', 'rum', 'urn']);
const NPM_LIFECYCLE: Record<string, string> = { test: 'test', t: 'test', tst: 'test', start: 'start', stop: 'stop', restart: 'restart' };

/** pnpm and yarn run a script named as the first word when it is not one of their own commands. */
const PNPM_BUILTINS = new Set(['add', 'install', 'i', 'update', 'up', 'remove', 'rm', 'uninstall', 'link', 'ln', 'unlink', 'import', 'rebuild', 'rb', 'prune', 'fetch', 'patch', 'patch-commit', 'exec', 'dlx', 'create', 'publish', 'pack', 'audit', 'list', 'ls', 'outdated', 'why', 'store', 'env', 'config', 'init', 'setup', 'server', 'root', 'bin', 'deploy', 'licenses', 'dedupe', 'doctor', 'self-update', 'approve-builds', 'cat-file', 'cat-index', 'find-hash']);
const YARN_BUILTINS = new Set(['add', 'install', 'remove', 'upgrade', 'up', 'info', 'init', 'dlx', 'exec', 'node', 'why', 'pack', 'publish', 'config', 'cache', 'set', 'plugin', 'version', 'bin', 'link', 'unlink', 'constraints', 'dedupe', 'explain', 'npm', 'patch', 'patch-commit', 'rebuild', 'search', 'stage', 'unplug', 'global', 'list', 'outdated', 'audit', 'login', 'logout', 'owner', 'tag', 'team', 'licenses', 'import', 'generate-lock-entry', 'check', 'autoclean', 'create', 'policies', 'help', 'upgrade-interactive']);
const BUN_BUILTINS = new Set(['test', 'x', 'repl', 'exec', 'install', 'i', 'add', 'a', 'remove', 'rm', 'update', 'link', 'unlink', 'pm', 'build', 'init', 'create', 'upgrade', 'publish', 'outdated', 'patch', 'audit', 'info', 'why', 'completions', 'discord', 'help']);
const COMPOSER_BUILTINS = new Set(['install', 'i', 'update', 'u', 'upgrade', 'require', 'r', 'remove', 'rm', 'dump-autoload', 'dumpautoload', 'show', 'info', 'outdated', 'validate', 'status', 'config', 'create-project', 'global', 'diagnose', 'self-update', 'selfupdate', 'search', 'depends', 'why', 'prohibits', 'why-not', 'licenses', 'archive', 'audit', 'bump', 'check-platform-reqs', 'clear-cache', 'exec', 'fund', 'init', 'list', 'reinstall', 'suggests', 'browse', 'home', 'help', 'about']);

/** Options that consume the following word, per runner. */
const TAKES_ARG: Record<RunnerKind, Set<string>> = {
  npm: new Set(['-w', '--workspace', '--prefix', '--userconfig', '--registry', '--loglevel', '--script-shell']),
  pnpm: new Set(['-C', '--dir', '-F', '--filter', '--filter-prod', '--workspace-dir', '--reporter', '--loglevel']),
  yarn: new Set(['--cwd', '--mutex', '--network-timeout', '--modules-folder', '--cache-folder']),
  bun: new Set(['--cwd', '-F', '--filter', '--bun-config', '--elide-lines']),
  make: new Set(['-C', '--directory', '-f', '--file', '--makefile', '-I', '--include-dir', '-o', '-W', '-j', '--jobs', '-l']),
  just: new Set(['-f', '--justfile', '-d', '--working-directory', '--set', '--shell', '--shell-arg', '--dotenv-filename', '--dotenv-path', '--color', '--command']),
  composer: new Set(['-d', '--working-dir', '--timeout']),
};

type Parsed = { positionals: string[]; options: { flag: string; value: string | null }[] };

function splitArgs(kind: RunnerKind, words: string[]): Parsed {
  const positionals: string[] = [];
  const options: { flag: string; value: string | null }[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w === '--') { positionals.push(...words.slice(i + 1)); break; }
    if (w.startsWith('-') && w.length > 1) {
      const eq = w.indexOf('=');
      if (eq > 0) { options.push({ flag: w.slice(0, eq), value: w.slice(eq + 1) }); continue; }
      if (TAKES_ARG[kind].has(w)) { options.push({ flag: w, value: words[i + 1] ?? null }); i += 1; continue; }
      options.push({ flag: w, value: null });
      continue;
    }
    positionals.push(w);
  }
  return { positionals, options };
}

function optionValue(p: Parsed, ...flags: string[]): string | null {
  for (let i = p.options.length - 1; i >= 0; i--) {
    if (flags.includes(p.options[i].flag)) return p.options[i].value;
  }
  return null;
}

/**
 * The runner a segment invokes, or null when it is not one this module reads.
 * `cwd` is where the segment runs — after any `cd` earlier on the line.
 */
export function detectRunner(segment: ShellSegment, cwd: string, home = ''): RunnerCall | null {
  const program = programOf(segment);
  const words = segment.argv.slice(1).map((w) => w.text);
  const at = (p: string | null) => (p ? resolve(cwd, expandHome(p, home || '~')) : cwd);
  const kind: RunnerKind | null = program === 'npm' ? 'npm' : program === 'pnpm' ? 'pnpm' : program === 'yarn' ? 'yarn'
    : program === 'bun' ? 'bun' : program === 'make' || program === 'gmake' ? 'make' : program === 'just' ? 'just'
      : program === 'composer' || program === 'composer.phar' ? 'composer' : null;
  if (!kind) return null;
  const parsed = splitArgs(kind, words);
  const [first, second, third] = parsed.positionals;
  const notes: string[] = [];
  const scope = parsed.options
    .filter((o) => ['-w', '--workspace', '--workspaces', '-ws', '-F', '--filter', '-r', '--recursive', '--if-present', '--include-workspace-root'].includes(o.flag))
    .map((o) => (o.value === null ? o.flag : `${o.flag} ${o.value}`));

  if (kind === 'npm') {
    const dir = at(optionValue(parsed, '--prefix'));
    let script: string | null = null;
    if (first && NPM_RUN.has(first)) script = second ?? null;
    else if (first && first in NPM_LIFECYCLE) script = NPM_LIFECYCLE[first];
    else return null;
    if (script === null) return null;
    return { kind, script, dir, manifest: `${dir}/package.json`, scope, overrides: [], notes };
  }
  if (kind === 'pnpm' || kind === 'yarn' || kind === 'bun') {
    const dir = at(optionValue(parsed, '-C', '--dir', '--cwd'));
    let script: string | null = null;
    let wsDir: string | null = null;
    if (kind === 'yarn' && first === 'workspace') {
      notes.push(`Yarn runs this in the workspace named ${second ?? '(none)'}; Wanigan reads a workspace only when it is named by path.`);
      if (second && second.includes('/')) wsDir = resolve(dir, second);
      script = third === 'run' ? parsed.positionals[3] ?? null : third ?? null;
      if (!wsDir) return { kind, script, dir, manifest: `${dir}/package.json`, scope: [...scope, `workspace ${second ?? ''}`.trim()], overrides: [], notes };
    } else if (first === 'run' || first === 'run-script') {
      script = second ?? null;
    } else if (kind === 'bun' && first === 'test') {
      return null; // bun's own test runner, not the package script — see BUN_BUILTINS.
    } else if (first && (first === 'test' || first === 'start' || first === 'stop' || first === 'restart') && kind !== 'bun') {
      script = first;
    } else if (first && !(kind === 'pnpm' ? PNPM_BUILTINS : kind === 'yarn' ? YARN_BUILTINS : BUN_BUILTINS).has(first) && !first.includes('/') && !first.includes('.')) {
      script = first;
      notes.push(`${kind} runs "${first}" as a script only when the manifest defines one; otherwise it looks for a binary of that name.`);
    } else {
      return null;
    }
    if (script === null) return null;
    const home = wsDir ?? dir;
    return { kind, script, dir: home, manifest: `${home}/package.json`, scope, overrides: [], notes };
  }
  if (kind === 'composer') {
    const dir = at(optionValue(parsed, '-d', '--working-dir'));
    let script: string | null = null;
    if (first === 'run' || first === 'run-script') script = second ?? null;
    else if (first && !COMPOSER_BUILTINS.has(first)) script = first;
    else return null;
    if (script === null) return null;
    return { kind, script, dir, manifest: `${dir}/composer.json`, scope, overrides: [], notes };
  }
  if (kind === 'make') {
    const dir = at(optionValue(parsed, '-C', '--directory'));
    const file = optionValue(parsed, '-f', '--file', '--makefile');
    const overrides = parsed.positionals.filter((w) => /^[A-Za-z_][A-Za-z0-9_]*[:+?]?=/.test(w));
    const targets = parsed.positionals.filter((w) => !overrides.includes(w));
    if (targets.length > 1) notes.push(`make was given ${targets.length} targets; only the first, ${targets[0]}, is explained.`);
    if (!file) notes.push('make reads GNUmakefile, makefile or Makefile, in that order; Wanigan read Makefile.');
    return { kind, script: targets[0] ?? null, dir, manifest: file ? resolve(dir, file) : `${dir}/Makefile`, scope, overrides, notes };
  }
  // just
  const dir = at(optionValue(parsed, '-d', '--working-directory'));
  const file = optionValue(parsed, '-f', '--justfile');
  if (parsed.options.some((o) => ['--list', '-l', '--summary', '--show', '-s', '--dump', '--evaluate', '--variables', '--help', '-h', '--version', '-V', '--init', '--edit', '-e', '--fmt', '--choose'].includes(o.flag))) return null;
  if (!file) notes.push('just searches upward for justfile or .justfile; Wanigan read justfile in the working directory.');
  return { kind, script: first ?? null, dir, manifest: file ? resolve(dir, file) : `${dir}/justfile`, scope, overrides: [], notes };
}

/**
 * Every manifest an explanation of this command could read, so the caller can
 * load them — from disk, and from the launch commit — before calling
 * `explainCommand`. Nested scripts in other directories are not followed.
 */
export function manifestsFor(command: string, cwd: string, home = ''): string[] {
  const out = new Set<string>();
  for (const { runner } of runnersIn(command, cwd, home)) out.add(runner.manifest);
  return [...out];
}

function runnersIn(command: string, cwd: string, home: string): { runner: RunnerCall; segment: ShellSegment }[] {
  const parsed = parseShell(command);
  const found: { runner: RunnerCall; segment: ShellSegment }[] = [];
  let here = cwd;
  for (const segment of parsed.segments) {
    const program = programOf(segment);
    if (program === 'cd' && segment.origin === 'command') {
      const target = segment.argv[1];
      if (target && !target.dynamic && target.text !== '-') here = resolve(here, expandHome(target.text, home || '~'));
      continue;
    }
    const runner = detectRunner(segment, here, home);
    if (runner) found.push({ runner, segment });
  }
  return found;
}

/* ── reading manifests ───────────────────────────────────────────────── */

type Entry = { from: string; lines: { command: string; kind: ExplainStep['kind'] }[]; refs: { kind: RunnerKind; name: string }[]; raw: string };

function parsePackage(text: string | null | undefined): Record<string, string> | null {
  if (typeof text !== 'string') return null;
  try {
    const v: unknown = JSON.parse(text);
    if (!v || typeof v !== 'object') return null;
    const scripts = (v as { scripts?: unknown }).scripts;
    if (!scripts || typeof scripts !== 'object') return {};
    const out: Record<string, string> = {};
    for (const [k, body] of Object.entries(scripts as Record<string, unknown>)) {
      if (typeof body === 'string') out[k] = body;
    }
    return out;
  } catch {
    return null;
  }
}

function parseComposer(text: string | null | undefined): Record<string, string[]> | null {
  if (typeof text !== 'string') return null;
  try {
    const v: unknown = JSON.parse(text);
    if (!v || typeof v !== 'object') return null;
    const scripts = (v as { scripts?: unknown }).scripts;
    if (!scripts || typeof scripts !== 'object') return {};
    const out: Record<string, string[]> = {};
    for (const [k, body] of Object.entries(scripts as Record<string, unknown>)) {
      if (typeof body === 'string') out[k] = [body];
      else if (Array.isArray(body)) out[k] = body.filter((x): x is string => typeof x === 'string');
    }
    return out;
  } catch {
    return null;
  }
}

type MakeRule = { targets: string[]; prereqs: string[]; recipe: string[]; line: number };
type Makefile = { rules: MakeRule[]; vars: Record<string, string>; includes: boolean; defaultGoal: string | null; recipePrefix: boolean };

export function parseMakefile(text: string): Makefile {
  const rules: MakeRule[] = [];
  const vars: Record<string, string> = {};
  let includes = false;
  let defaultGoal: string | null = null;
  let recipePrefix = false;
  const physical = text.replace(/\r\n/g, '\n').split('\n');
  let current: MakeRule | null = null;
  for (let n = 0; n < physical.length; n++) {
    let line = physical[n];
    while (line.endsWith('\\') && n + 1 < physical.length) {
      n += 1;
      line = `${line.slice(0, -1)} ${physical[n].replace(/^\s+/, '')}`;
    }
    if (line.startsWith('\t')) {
      if (current) current.recipe.push(line.slice(1));
      continue;
    }
    if (!line.trim() || /^\s*#/.test(line)) continue;
    current = null;
    const trimmed = line.trim();
    if (/^-?(include|sinclude)\s/.test(trimmed)) { includes = true; continue; }
    if (/^\.RECIPEPREFIX\s*[:?]?=/.test(trimmed)) { recipePrefix = true; continue; }
    const assign = /^(?:export\s+|override\s+)?([A-Za-z_.][A-Za-z0-9_.-]*)\s*(::?=|\?=|\+=|!=|=)\s*(.*)$/.exec(trimmed);
    if (assign) {
      if (assign[1] === '.DEFAULT_GOAL') defaultGoal = assign[3].trim();
      else vars[assign[1]] = assign[2] === '+=' && vars[assign[1]] ? `${vars[assign[1]]} ${assign[3]}` : assign[3];
      continue;
    }
    const rule = /^([^:#=]+?)\s*(::?)\s*([^=].*)?$/.exec(trimmed);
    if (rule) {
      const [deps, inline] = (rule[3] ?? '').split(/;(.*)/s);
      current = {
        targets: rule[1].trim().split(/\s+/),
        prereqs: (deps ?? '').replace(/\|/g, ' ').trim().split(/\s+/).filter(Boolean),
        recipe: inline && inline.trim() ? [inline.trim()] : [],
        line: n + 1,
      };
      rules.push(current);
    }
  }
  return { rules, vars, includes, defaultGoal, recipePrefix };
}

type Recipe = { name: string; deps: string[]; body: string[]; shebang: boolean; line: number };
type Justfile = { recipes: Recipe[]; vars: Record<string, string>; imports: boolean; shellSet: boolean };

export function parseJustfile(text: string): Justfile {
  const recipes: Recipe[] = [];
  const vars: Record<string, string> = {};
  let imports = false;
  let shellSet = false;
  let current: Recipe | null = null;
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    if (/^[ \t]+\S/.test(line)) {
      if (current) {
        const body = line.replace(/^[ \t]+/, '');
        if (!current.body.length && body.startsWith('#!')) current.shebang = true;
        current.body.push(body);
      }
      continue;
    }
    if (!line.trim()) continue;
    current = null;
    if (/^\s*#/.test(line) || /^\[.*\]\s*$/.test(line)) continue;
    if (/^(import|mod)\b/.test(line)) { imports = true; continue; }
    if (/^set\s+shell\b/.test(line)) { shellSet = true; continue; }
    if (/^set\s/.test(line) || /^alias\s/.test(line)) continue;
    const assign = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_-]*)\s*:=\s*(.*)$/.exec(line);
    if (assign) { vars[assign[1]] = assign[2]; continue; }
    const head = /^@?([A-Za-z_][A-Za-z0-9_-]*)([^:]*?):(?!=)\s*(.*)$/.exec(line);
    if (head) {
      const deps = (head[3] ?? '').replace(/\([^)]*\)/g, (m) => m.slice(1, -1).split(/\s+/)[0] ?? '').split(/\s+/).filter((d) => d && d !== '&&');
      current = { name: head[1], deps, body: [], shebang: false, line: n + 1 };
      recipes.push(current);
    }
  }
  return { recipes, vars, imports, shellSet };
}

/* ── resolving ───────────────────────────────────────────────────────── */

function pkgEntry(scripts: Record<string, string>, name: string, manifestName: string): Entry | null {
  const body = scripts[name];
  if (body === undefined) return null;
  return { from: `${manifestName} › scripts.${name}`, lines: [{ command: body, kind: 'body' }], refs: [], raw: body };
}

/** Script names a package-script body invokes through a runner, in order. */
function nestedPackageRefs(body: string): string[] {
  const out: string[] = [];
  for (const seg of parseShell(body).segments) {
    const program = programOf(seg);
    const words = seg.argv.slice(1).filter((w) => !w.dynamic).map((w) => w.text);
    if (program === 'npm-run-all' || program === 'run-s' || program === 'run-p' || program === 'npm-run-all2') {
      out.push(...words.filter((w) => !w.startsWith('-')));
      continue;
    }
    const runner = detectRunner(seg, '/');
    if (runner && (runner.kind === 'npm' || runner.kind === 'pnpm' || runner.kind === 'yarn' || runner.kind === 'bun') && runner.script) {
      out.push(runner.script);
    }
  }
  return out;
}

function hookNote(kind: RunnerKind, name: string): string | null {
  if (kind === 'npm') return null;
  if (kind === 'pnpm') return `pnpm 7 and later do not run pre${name}/post${name} unless enable-pre-post-scripts is set; Wanigan cannot confirm which pnpm or setting runs here.`;
  if (kind === 'yarn') return `Yarn 1 runs pre${name}/post${name}; Yarn 2 and later do not. Wanigan cannot confirm which Yarn runs here.`;
  if (kind === 'bun') return `Wanigan cannot confirm whether bun runs pre${name}/post${name} here.`;
  return null;
}

function resolvePackage(call: RunnerCall, files: ManifestFiles, steps: ExplainStep[], entries: { now: string; launch: string | null | undefined; label: string }[], notes: string[]): boolean {
  const text = files.now[call.manifest];
  const scripts = parsePackage(text);
  const name = call.script ?? '';
  if (scripts === null) {
    notes.push(text === null || text === undefined
      ? `There is no package.json at ${call.manifest}, so Wanigan cannot say what "${name}" runs.`
      : `${call.manifest} is not valid JSON, so Wanigan cannot say what "${name}" runs.`);
    return false;
  }
  // Three answers, kept apart: not asked (no launch commit), absent at launch
  // (null — every entry is new), and present (compare entry by entry).
  const launchText = files.launch ? files.launch[call.manifest] : undefined;
  const launchScripts = typeof launchText === 'string' ? parsePackage(launchText) : null;
  const launchOf = (key: string): string | null | undefined =>
    launchText === null ? null : launchScripts ? launchScripts[key] ?? null : undefined;
  const seen = new Set<string>();
  let found = false;

  const visit = (script: string, depth: number) => {
    if (steps.length >= MAX_STEPS) return;
    if (depth > MAX_NEST) { notes.push(`Scripts nested deeper than ${MAX_NEST} levels were not followed.`); return; }
    if (seen.has(script)) { notes.push(`"${script}" calls itself through a chain of scripts; the loop was not followed.`); return; }
    seen.add(script);
    const order: { key: string; kind: ExplainStep['kind'] }[] = [
      { key: `pre${script}`, kind: 'hook' }, { key: script, kind: 'body' }, { key: `post${script}`, kind: 'hook' },
    ];
    for (const { key, kind } of order) {
      const entry = pkgEntry(scripts, key, 'package.json');
      if (!entry) continue;
      if (kind === 'hook') {
        const note = hookNote(call.kind, script);
        if (note && depth === 0) notes.push(note);
      }
      if (key === script && depth === 0) found = true;
      steps.push({ depth, from: entry.from, command: entry.raw, kind });
      entries.push({ now: entry.raw, launch: launchOf(key), label: entry.from });
      for (const ref of nestedPackageRefs(entry.raw)) visit(ref, depth + 1);
    }
    if (scripts[script] === undefined) {
      if (depth === 0) {
        if (call.kind === 'npm' && script === 'start') {
          notes.push('package.json has no "start" script; npm then runs `node server.js` when a server.js exists, and fails otherwise.');
        } else if (call.kind === 'npm' && script === 'restart') {
          notes.push('package.json has no "restart" script; npm then runs "stop" and "start" in turn.');
          for (const k of ['stop', 'start']) if (scripts[k] !== undefined) visit(k, depth + 1);
        } else {
          notes.push(`package.json has no "${script}" script. ${call.kind === 'npm' ? 'npm fails with "Missing script".' : `${call.kind} may run a binary of that name instead, which Wanigan cannot confirm.`}`);
        }
      } else {
        notes.push(`A script calls "${script}", which package.json does not define.`);
      }
    }
  };
  visit(name, 0);
  if (call.scope.length) {
    notes.push(`Run with ${call.scope.join(', ')}: other workspaces' own "${name}" scripts may run too, and Wanigan read only ${call.manifest}.`);
  }
  return found;
}

function resolveComposer(call: RunnerCall, files: ManifestFiles, steps: ExplainStep[], entries: { now: string; launch: string | null | undefined; label: string }[], notes: string[]): boolean {
  const text = files.now[call.manifest];
  const scripts = parseComposer(text);
  const name = call.script ?? '';
  if (scripts === null) {
    notes.push(text === null || text === undefined ? `There is no composer.json at ${call.manifest}.` : `${call.manifest} is not valid JSON.`);
    return false;
  }
  const launchText = files.launch ? files.launch[call.manifest] : undefined;
  const launchScripts = typeof launchText === 'string' ? parseComposer(launchText) : null;
  const seen = new Set<string>();
  const visit = (script: string, depth: number): boolean => {
    if (depth > MAX_NEST || steps.length >= MAX_STEPS) return false;
    if (seen.has(script)) { notes.push(`"${script}" refers back to itself; the loop was not followed.`); return false; }
    seen.add(script);
    const body = scripts[script];
    if (!body) {
      notes.push(depth === 0 ? `composer.json has no "${script}" script.` : `A script refers to "@${script}", which composer.json does not define.`);
      return false;
    }
    const before = launchText === null ? null : launchScripts ? (launchScripts[script] ? JSON.stringify(launchScripts[script]) : null) : undefined;
    entries.push({ now: JSON.stringify(body), launch: before, label: `composer.json › scripts.${script}` });
    for (const line of body) {
      const from = `composer.json › scripts.${script}`;
      if (line.startsWith('@php ') || line.startsWith('@composer ') || line.startsWith('@putenv ')) {
        steps.push({ depth, from, command: line.slice(1), kind: 'body' });
        continue;
      }
      if (line.startsWith('@')) {
        steps.push({ depth, from, command: line, kind: 'reference' });
        visit(line.slice(1).split(/\s+/)[0], depth + 1);
        continue;
      }
      if (/^[A-Za-z_\\][A-Za-z0-9_\\]*::[A-Za-z_][A-Za-z0-9_]*$/.test(line)) {
        steps.push({ depth, from, command: line, kind: 'callback' });
        notes.push(`${line} is a PHP callback; Wanigan cannot confirm what it does without reading the class.`);
        continue;
      }
      steps.push({ depth, from, command: line, kind: 'body' });
    }
    return true;
  };
  return visit(name, 0);
}

function makeVarLabel(name: string, mk: Makefile, overrides: string[]): string {
  if (['@', '<', '^', '?', '*', '+', '|', '%'].includes(name)) return 'automatic variable, set by make for each rule';
  const override = overrides.find((o) => o.startsWith(`${name}=`) || o.startsWith(`${name}:=`));
  if (override) return `set on the command line: ${override}`;
  if (name in mk.vars) return `the Makefile assigns ${name} = ${mk.vars[name].trim() || '(empty)'}, but the command line or the environment can override it`;
  return 'not assigned in this Makefile; it comes from the environment or make’s built-in defaults';
}

function makeVarsIn(line: string): string[] {
  const out: string[] = [];
  for (const m of line.replace(/\$\$/g, '').matchAll(/\$(?:\(([^)\s:]+)[^)]*\)|\{([^}\s:]+)[^}]*\}|([@<^?*+|%]))/g)) {
    out.push(m[1] ?? m[2] ?? m[3]);
  }
  return out;
}

function resolveMake(call: RunnerCall, files: ManifestFiles, steps: ExplainStep[], entries: { now: string; launch: string | null | undefined; label: string }[], notes: string[], unexpanded: Map<string, string>): boolean {
  const text = files.now[call.manifest];
  if (typeof text !== 'string') {
    notes.push(`There is no Makefile at ${call.manifest}, so Wanigan cannot say what make runs.`);
    return false;
  }
  const mk = parseMakefile(text);
  const launchMk = files.launch && typeof files.launch[call.manifest] === 'string' ? parseMakefile(files.launch[call.manifest] as string) : null;
  if (mk.includes) notes.push('This Makefile includes other files, which Wanigan did not read; a target defined there cannot be confirmed.');
  if (mk.recipePrefix) notes.push('This Makefile changes .RECIPEPREFIX, so Wanigan cannot confirm where its recipes begin.');
  const goal = call.script ?? mk.defaultGoal ?? mk.rules.find((r) => r.targets.some((t) => !t.startsWith('.') && !t.includes('%')))?.targets.find((t) => !t.startsWith('.')) ?? null;
  if (!goal) { notes.push('The Makefile defines no target Wanigan could find.'); return false; }
  if (!call.script) notes.push(`No target was named, so make runs the default goal, ${goal}.`);
  const seen = new Set<string>();
  const phony = new Set(mk.rules.filter((r) => r.targets.includes('.PHONY')).flatMap((r) => r.prereqs));

  const visit = (target: string, depth: number): boolean => {
    if (depth > MAX_NEST || steps.length >= MAX_STEPS || seen.has(target)) return false;
    seen.add(target);
    const rules = mk.rules.filter((r) => r.targets.includes(target));
    if (!rules.length) {
      if (depth === 0) notes.push(`The Makefile has no explicit rule for ${target}; make may use a pattern or built-in rule, which Wanigan cannot confirm.`);
      return false;
    }
    for (const rule of rules) {
      for (const dep of rule.prereqs) {
        if (mk.rules.some((r) => r.targets.includes(dep))) {
          visit(dep, depth + 1);
        }
      }
      const from = `Makefile › ${target}`;
      for (const line of rule.recipe) {
        const cmd = line.replace(/^[@+-]+/, '').trim();
        if (!cmd) continue;
        steps.push({ depth, from, command: cmd, kind: 'body' });
        for (const v of makeVarsIn(cmd)) {
          const shown = v.length === 1 && !/[A-Za-z0-9_]/.test(v) ? `$${v}` : `$(${v})`;
          if (!unexpanded.has(shown)) unexpanded.set(shown, makeVarLabel(v, mk, call.overrides));
        }
      }
      const launchRules = launchMk?.rules.filter((r) => r.targets.includes(target));
      entries.push({
        now: JSON.stringify([rule.prereqs, rule.recipe]),
        launch: !files.launch ? undefined : launchMk && launchRules?.length ? JSON.stringify([launchRules[0].prereqs, launchRules[0].recipe]) : null,
        label: from,
      });
    }
    const prereqTargets = rules.flatMap((r) => r.prereqs).filter((d) => mk.rules.some((r) => r.targets.includes(d)));
    if (depth === 0 && prereqTargets.length && !phony.has(target)) {
      notes.push('make runs a prerequisite’s recipe only when it is out of date, so some of these lines may not run; Wanigan cannot confirm which.');
    }
    return true;
  };
  return visit(goal, 0);
}

function resolveJust(call: RunnerCall, files: ManifestFiles, steps: ExplainStep[], entries: { now: string; launch: string | null | undefined; label: string }[], notes: string[], unexpanded: Map<string, string>): boolean {
  const text = files.now[call.manifest];
  if (typeof text !== 'string') {
    notes.push(`There is no justfile at ${call.manifest}, so Wanigan cannot say what just runs.`);
    return false;
  }
  const jf = parseJustfile(text);
  const launchJf = files.launch && typeof files.launch[call.manifest] === 'string' ? parseJustfile(files.launch[call.manifest] as string) : null;
  if (jf.imports) notes.push('This justfile imports other files, which Wanigan did not read.');
  if (jf.shellSet) notes.push('This justfile sets its own shell, so its lines may not be shell commands.');
  const goal = call.script ?? jf.recipes[0]?.name ?? null;
  if (!goal) { notes.push('The justfile defines no recipe Wanigan could find.'); return false; }
  if (!call.script) notes.push(`No recipe was named, so just runs the first one, ${goal}.`);
  const seen = new Set<string>();
  const visit = (name: string, depth: number): boolean => {
    if (depth > MAX_NEST || steps.length >= MAX_STEPS || seen.has(name)) return false;
    seen.add(name);
    const recipe = jf.recipes.find((r) => r.name === name);
    if (!recipe) {
      notes.push(depth === 0 ? `The justfile has no recipe named ${name}.` : `A recipe depends on ${name}, which the justfile does not define.`);
      return false;
    }
    for (const dep of recipe.deps) visit(dep, depth + 1);
    const from = `justfile › ${name}`;
    if (recipe.shebang) notes.push(`${name} is a script for ${recipe.body[0].slice(2).trim()}, not shell lines; Wanigan shows it but cannot read what it does.`);
    for (const line of recipe.body) {
      const cmd = line.replace(/^[@-]+/, '').trim();
      if (!cmd || cmd.startsWith('#!')) continue;
      steps.push({ depth, from, command: cmd, kind: recipe.shebang ? 'interpreter-script' : 'body' });
      for (const m of cmd.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)) {
        const v = m[1];
        unexpanded.set(`{{${v}}}`, v in jf.vars ? `the justfile assigns ${v} := ${jf.vars[v]}` : 'a recipe parameter or expression Wanigan does not evaluate');
      }
    }
    const before = launchJf?.recipes.find((r) => r.name === name);
    entries.push({ now: JSON.stringify([recipe.deps, recipe.body]), launch: !files.launch ? undefined : before ? JSON.stringify([before.deps, before.body]) : null, label: from });
    return true;
  };
  return visit(goal, 0);
}

/* ── what the lines name, and whether it can be undone ─────────────── */

const URL_RE = /\b([a-z][a-z0-9+.-]*):\/\/([^/\s'"`:@]+@)?([^/\s'"`:]+)/gi;

function namesIn(commands: string[], home: string): { paths: string[]; hosts: string[] } {
  const paths = new Set<string>();
  const hosts = new Set<string>();
  for (const command of commands) {
    for (const m of command.matchAll(URL_RE)) hosts.add(m[3].toLowerCase());
    for (const seg of parseShell(command).segments) {
      const program = programOf(seg);
      const words = [...seg.argv.slice(1), ...seg.redirects.map((r) => r.target)];
      for (const w of words) {
        const t = w.text;
        if (!t || /^[a-z][a-z0-9+.-]*:\/\//i.test(t)) continue;
        const scp = /^(?:[A-Za-z0-9._-]+@)?([A-Za-z0-9.-]+\.[A-Za-z]{2,}|[A-Za-z0-9-]+):(?!\/\/)/.exec(t);
        if (scp && ['scp', 'rsync', 'git', 'ssh', 'sftp'].includes(program)) { hosts.add(scp[1].toLowerCase()); continue; }
        if (program === 'ssh' && /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+$/.test(t)) { hosts.add(t.split('@')[1].toLowerCase()); continue; }
        if (t.startsWith('-')) {
          const eq = t.indexOf('=');
          if (eq > 0 && /[/.]/.test(t.slice(eq + 1)) && !/^\d/.test(t.slice(eq + 1))) paths.add(t.slice(eq + 1));
          continue;
        }
        if (t.includes('/') || t.startsWith('~') || t.startsWith('.') || /\.(?:sh|bash|js|mjs|cjs|ts|py|rb|pl|php|json|ya?ml|toml|env|pem|key|zip|tar|gz|tgz|sql|db|sqlite|lock)$/i.test(t)) {
          paths.add(home && t.startsWith('~') ? expandHome(t, home) : t);
        }
      }
    }
  }
  return { paths: [...paths].slice(0, MAX_LIST), hosts: [...hosts].slice(0, MAX_LIST) };
}

/** Programs whose ordinary use changes nothing git cannot put back, and sends nothing anywhere. */
const LOCAL_PROGRAMS = new Set([
  'echo', 'printf', 'true', 'false', 'test', '[', 'cat', 'ls', 'pwd', 'which', 'env', 'exit', 'set', 'cd', 'mkdir', 'cp', 'touch', 'sleep', 'grep', 'rg', 'sed', 'awk', 'sort', 'head', 'tail', 'wc', 'find', 'xargs', 'date', 'basename', 'dirname',
  'tsc', 'eslint', 'prettier', 'stylelint', 'biome', 'knip', 'jest', 'vitest', 'mocha', 'ava', 'tap', 'c8', 'nyc', 'playwright', 'cypress',
  'vite', 'webpack', 'rollup', 'esbuild', 'tsup', 'swc', 'babel', 'parcel', 'turbo', 'nx', 'lerna', 'electron-vite', 'electron-builder', 'electron-rebuild', 'next', 'nuxt', 'astro', 'svelte-kit', 'remix', 'storybook', 'concurrently', 'cross-env', 'rimraf', 'shx', 'tsx', 'ts-node', 'nodemon',
  'npm-run-all', 'run-s', 'run-p', 'npm', 'pnpm', 'yarn', 'bun', 'npx', 'make', 'just', 'composer',
  'cargo', 'go', 'gofmt', 'rustfmt', 'clippy-driver', 'pytest', 'python', 'python3', 'ruff', 'black', 'mypy', 'flake8', 'isort', 'tox', 'phpunit', 'phpcs', 'phpcbf', 'phpstan', 'psalm', 'rector', 'php-cs-fixer', 'drush', 'gcc', 'cc', 'clang', 'ld', 'ar', 'cmake', 'ninja', 'swift', 'xcodebuild', 'javac', 'java', 'mvn', 'gradle', 'dotnet',
  'git', 'node', 'deno', 'php', 'ruby', 'perl', 'bash', 'sh', 'zsh',
]);

/** Programs that can run arbitrary code named by their arguments: local, but not confirmable. */
const OPAQUE_RUNNERS = new Set(['node', 'deno', 'python', 'python3', 'php', 'ruby', 'perl', 'bash', 'sh', 'zsh', 'tsx', 'ts-node', 'npx', 'java', 'dotnet', 'drush', 'nodemon']);

function irreversible(seg: ShellSegment): string | null {
  const program = programOf(seg);
  const w = seg.argv.slice(1).map((x) => x.text);
  const has = (...xs: string[]) => xs.some((x) => w.includes(x));
  const sub = w[0] ?? '';
  if (program === 'rm' || program === 'rmdir' || program === 'shred' || program === 'unlink') return `${program} deletes files, and git cannot restore one it never tracked`;
  if (program === 'git') {
    const verb = w.find((x) => !x.startsWith('-')) ?? '';
    if (verb === 'push') return 'git push sends commits to a remote';
    if (verb === 'reset' && has('--hard')) return 'git reset --hard discards uncommitted work';
    if (verb === 'clean') return 'git clean deletes untracked files';
    if (verb === 'checkout' && has('--', '.')) return 'git checkout over paths discards uncommitted edits';
    if (verb === 'stash' && has('drop', 'clear')) return 'git stash drop discards stashed work';
    if (verb === 'branch' && has('-D')) return 'git branch -D deletes a branch';
    if (verb === 'tag' && has('-d')) return 'git tag -d deletes a tag';
    return null;
  }
  if (['npm', 'pnpm', 'yarn', 'bun', 'cargo', 'gem', 'twine', 'poetry', 'dotnet', 'vsce', 'ovsx'].includes(program) && (sub === 'publish' || sub === 'upload' || sub === 'deprecate' || sub === 'unpublish' || sub === 'push')) return `${program} ${sub} publishes to a registry`;
  if (program === 'docker' || program === 'podman') {
    if (sub === 'push') return `${program} push uploads an image`;
    if (['rm', 'rmi', 'prune', 'system'].includes(sub) || has('prune')) return `${program} ${sub} deletes containers or images`;
    return null;
  }
  if (program === 'curl') {
    if (w.some((x) => /^(-d|--data.*|-F|--form.*|-T|--upload-file|--json)$/.test(x) || /^--data/.test(x))) return 'curl sends data to a server';
    const xi = w.findIndex((x) => x === '-X' || x === '--request');
    if (xi >= 0 && /^(POST|PUT|PATCH|DELETE)$/i.test(w[xi + 1] ?? '')) return `curl makes a ${w[xi + 1].toUpperCase()} request`;
    return null;
  }
  if (program === 'wget' && w.some((x) => /^--(post|method|body)/.test(x))) return 'wget sends data to a server';
  if (['scp', 'sftp', 'ssh', 'nc', 'ncat', 'netcat', 'telnet', 'ftp'].includes(program)) return `${program} reaches another machine`;
  if (program === 'rsync' && w.some((x) => /^[^/-][^:]*:/.test(x))) return 'rsync copies to or from another machine';
  if (program === 'rsync' && has('--delete')) return 'rsync --delete removes files at the destination';
  if (program === 'terraform' || program === 'tofu' || program === 'pulumi') return ['apply', 'destroy', 'import', 'up'].includes(sub) ? `${program} ${sub} changes real infrastructure` : null;
  if (program === 'kubectl' || program === 'helm') return ['apply', 'delete', 'create', 'replace', 'patch', 'rollout', 'scale', 'install', 'upgrade', 'uninstall'].includes(sub) ? `${program} ${sub} changes a cluster` : null;
  if (program === 'aws' || program === 'gcloud' || program === 'az' || program === 'gsutil') return `${program} acts on a cloud account`;
  if (['gh', 'glab'].includes(program) && ['release', 'pr', 'issue', 'repo', 'api', 'secret', 'workflow'].includes(sub) && w.some((x) => ['create', 'merge', 'close', 'delete', 'edit', 'set', 'run', '-X', '--method'].includes(x))) return `${program} ${sub} changes a hosted repository`;
  if (['vercel', 'netlify', 'fly', 'flyctl', 'firebase', 'wrangler', 'heroku', 'serverless', 'sls', 'eb', 'cdk'].includes(program)) return `${program} deploys or changes a hosted service`;
  if (program === 'sudo' || seg.via.includes('sudo')) return 'it runs as root';
  if (['dropdb', 'mysqladmin'].includes(program) || w.some((x) => /\b(DROP|TRUNCATE)\s+(TABLE|DATABASE|SCHEMA)\b/i.test(x))) return 'it drops database objects';
  if (program === 'drush' && ['sql-drop', 'sql:drop', 'site-install', 'si', 'site:install', 'sql-sync', 'sql:sync', 'deploy', 'updb', 'updatedb', 'cim', 'config:import'].includes(sub)) return `drush ${sub} changes a site's database`;
  if (/deploy|publish|release/i.test(program) || w.some((x) => /^(deploy|publish|release)$/i.test(x))) return 'it names a deploy, publish or release step';
  if (['mkfs', 'dd', 'diskutil', 'chmod', 'chown'].includes(program) && (program !== 'chmod' || has('-R')) && (program !== 'chown' || has('-R'))) return `${program} changes the system outside the repository`;
  return null;
}

function reversibility(steps: ExplainStep[], notes: string[], found: boolean): Reversibility {
  if (!found && !steps.length) return { verdict: 'cannot confirm', because: ['Wanigan could not find what this alias runs.'] };
  const irreversibleBecause: string[] = [];
  const opaque: string[] = [];
  const unknown: string[] = [];
  for (const step of steps) {
    if (step.kind === 'reference') continue;
    if (step.kind === 'callback' || step.kind === 'interpreter-script') { opaque.push(step.command.slice(0, 60)); continue; }
    for (const seg of parseShell(step.command).segments) {
      const why = irreversible(seg);
      if (why) { irreversibleBecause.push(`${why} (${seg.text.slice(0, 80)})`); continue; }
      const program = programOf(seg);
      if (!program) { if (seg.argv.length) unknown.push(seg.argv[0].text.slice(0, 40)); continue; }
      if (OPAQUE_RUNNERS.has(program)) {
        const target = seg.argv.slice(1).find((w) => !w.text.startsWith('-'));
        opaque.push(target ? `${program} ${target.text}` : program);
        continue;
      }
      if (!LOCAL_PROGRAMS.has(program)) unknown.push(program);
      for (const r of seg.redirects) {
        if ((r.op === '>' || r.op === '>|') && !r.target.text.startsWith('/dev/')) unknown.push(`overwrite of ${r.target.text}`);
      }
    }
  }
  if (irreversibleBecause.length) return { verdict: 'not reversible', because: [...new Set(irreversibleBecause)].slice(0, 6) };
  if (opaque.length || unknown.length || notes.some((n) => /cannot confirm/i.test(n))) {
    const because: string[] = [];
    if (opaque.length) because.push(`It runs code Wanigan does not read: ${[...new Set(opaque)].slice(0, 5).join(', ')}.`);
    if (unknown.length) because.push(`Wanigan has no rule for: ${[...new Set(unknown)].slice(0, 6).join(', ')}.`);
    if (!because.length) because.push('Part of what runs could not be confirmed; see the notes.');
    return { verdict: 'cannot confirm', because };
  }
  return { verdict: 'reversible', because: ['Every line is a local build, test or file tool with no network or delete step Wanigan recognises; git can restore what it changes in tracked files.'] };
}

/* ── the explanation ─────────────────────────────────────────────────── */

function relative(from: string, abs: string): string {
  return abs.startsWith(`${from}/`) ? abs.slice(from.length + 1) : abs;
}

/**
 * The explanation for every runner call in a command line, or null when the
 * line calls none. `files` must already hold every path `manifestsFor`
 * returned; a path missing from it reads as a missing file.
 */
export function explainCommand(command: string, cwd: string, files: ManifestFiles, home = ''): ApprovalExplanation | null {
  const calls = runnersIn(command, cwd, home);
  if (!calls.length) return null;
  const scripts: ScriptExplanation[] = [];
  for (const { runner, segment } of calls.slice(0, 4)) {
    const steps: ExplainStep[] = [];
    const notes: string[] = [...runner.notes];
    const entries: { now: string; launch: string | null | undefined; label: string }[] = [];
    const unexpanded = new Map<string, string>();
    let found = false;
    if (segment.argv.some((w) => w.dynamic)) notes.push('Part of this command depends on a variable or substitution, which Wanigan does not expand; the script name may not be what runs.');
    if (runner.kind === 'npm' || runner.kind === 'pnpm' || runner.kind === 'yarn' || runner.kind === 'bun') found = resolvePackage(runner, files, steps, entries, notes);
    else if (runner.kind === 'composer') found = resolveComposer(runner, files, steps, entries, notes);
    else if (runner.kind === 'make') found = resolveMake(runner, files, steps, entries, notes, unexpanded);
    else found = resolveJust(runner, files, steps, entries, notes, unexpanded);
    if (runner.overrides.length) notes.push(`Variables set on the command line override the Makefile: ${runner.overrides.join(', ')}.`);

    let change: ManifestChange = 'cannot confirm';
    let changeDetail: string;
    if (!files.launch || !files.launchCommit) {
      changeDetail = 'This session recorded no launch commit, so Wanigan cannot say whether the manifest changed since it started.';
    } else if (!entries.length) {
      changeDetail = 'Nothing was resolved, so there is nothing to compare with the launch commit.';
    } else if (files.launch[runner.manifest] === undefined) {
      changeDetail = `Wanigan could not read ${relative(cwd, runner.manifest)} at the launch commit.`;
    } else {
      const changed = entries.filter((e) => e.launch !== undefined && e.launch !== e.now);
      const added = changed.filter((e) => e.launch === null);
      if (added.length && added.length === changed.length) {
        change = 'new since launch';
        changeDetail = `${added.map((e) => e.label).join(', ')} did not exist at launch commit ${files.launchCommit.slice(0, 10)}.`;
      } else if (changed.length) {
        change = 'changed';
        changeDetail = `${changed.map((e) => e.label).join(', ')} differs from launch commit ${files.launchCommit.slice(0, 10)}.`;
      } else {
        change = 'unchanged';
        changeDetail = `Every entry read matches launch commit ${files.launchCommit.slice(0, 10)}.`;
      }
    }
    const names = namesIn(steps.map((s) => s.command), home);
    scripts.push({
      runner: runner.kind,
      alias: segment.text.slice(0, 200),
      script: runner.script,
      manifest: relative(cwd, runner.manifest),
      found,
      steps: steps.slice(0, MAX_STEPS),
      paths: names.paths,
      hosts: names.hosts,
      reversible: reversibility(steps, notes, found),
      change,
      changeDetail,
      unexpanded: [...unexpanded].map(([name, label]) => ({ name, label })).slice(0, MAX_LIST),
      notes: [...new Set(notes)],
    });
  }
  return { v: 1, command: command.slice(0, 400), scripts, launchCommit: files.launchCommit };
}
