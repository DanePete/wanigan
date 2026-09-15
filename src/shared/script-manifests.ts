/**
 * The one reader for the files that name a project's scripts: `package.json`
 * and `composer.json` scripts, Makefile rules and justfile recipes.
 *
 * Two surfaces read these files for different reasons. The approval explainer
 * (script-explain.ts) resolves what `npm run x`, `make x` or `just x` will
 * actually run, so a person approving the alias sees the body. The script
 * launcher (project-scripts.ts) lists what a project declares so the operator
 * can run one. They used to carry a parser each, and two parsers of one file
 * disagree in exactly the cases nobody tests: the launcher offered a `make fake`
 * that lived inside a `define` block, while the explainer treated a
 * target-specific variable (`release: CFLAGS += -O2`) as a rule with three
 * prerequisites named `CFLAGS`, `+=` and `-O2`. A person who saw a target in the
 * launcher and then approved it in a session was reading two different answers
 * about the same line.
 *
 * So both now read through here, and each keeps only its own projection: the
 * explainer follows prerequisites and dependencies and labels what it cannot
 * confirm; the launcher leaves out what `make` or `just --list` would not offer
 * a person to type. Nothing here evaluates anything — no variable is expanded,
 * no include is read, no shell runs. A rule this module does not recognise is
 * absent from both surfaces rather than guessed at by one of them.
 */

/* ── JSON manifests ─────────────────────────────────────────────────── */

/**
 * Why a JSON manifest yielded no scripts, kept apart: a file that is not JSON,
 * a JSON value that is not an object, and an object whose `scripts` is not an
 * object are three different things to tell a person.
 */
export type JsonScriptsProblem = 'invalid-json' | 'not-an-object' | 'scripts-not-an-object';

export type PackageScriptsRead =
  | { ok: true; scripts: { name: string; body: string }[] }
  | { ok: false; problem: JsonScriptsProblem };

export type ComposerScriptsRead =
  | { ok: true; scripts: { name: string; lines: string[] }[] }
  | { ok: false; problem: JsonScriptsProblem };

function scriptsBlock(text: string): { ok: true; block: Record<string, unknown> | null } | { ok: false; problem: JsonScriptsProblem } {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return { ok: false, problem: 'invalid-json' }; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, problem: 'not-an-object' };
  const scripts = (value as { scripts?: unknown }).scripts;
  if (scripts === undefined) return { ok: true, block: null };
  // An array is an object to `typeof`, and reading one as a scripts table made
  // its indexes into script names ("0", "1"). Neither npm nor composer reads it.
  if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) return { ok: false, problem: 'scripts-not-an-object' };
  return { ok: true, block: scripts as Record<string, unknown> };
}

/** package.json `scripts`, in file order. An entry whose body is not a string is not a script. */
export function readPackageScripts(text: string): PackageScriptsRead {
  const read = scriptsBlock(text);
  if (!read.ok) return read;
  const scripts: { name: string; body: string }[] = [];
  for (const [name, body] of Object.entries(read.block ?? {})) {
    if (typeof body === 'string') scripts.push({ name, body });
  }
  return { ok: true, scripts };
}

/** composer.json `scripts`: a string, or a list of lines run in order. */
export function readComposerScripts(text: string): ComposerScriptsRead {
  const read = scriptsBlock(text);
  if (!read.ok) return read;
  const scripts: { name: string; lines: string[] }[] = [];
  for (const [name, body] of Object.entries(read.block ?? {})) {
    if (typeof body === 'string') scripts.push({ name, lines: [body] });
    else if (Array.isArray(body)) scripts.push({ name, lines: body.filter((x): x is string => typeof x === 'string') });
  }
  return { ok: true, scripts };
}

/* ── Makefile ───────────────────────────────────────────────────────── */

export type MakeRule = {
  targets: string[];
  prereqs: string[];
  /** Recipe lines without their leading tab; a `target: deps ; cmd` inline recipe comes first. */
  recipe: string[];
  /** 1-based line of the rule header. */
  line: number;
  /** A `## comment` on the line above, or after the prerequisites — the self-documenting convention. */
  doc: string | null;
};

export type Makefile = {
  rules: MakeRule[];
  vars: Record<string, string>;
  includes: boolean;
  defaultGoal: string | null;
  recipePrefix: boolean;
};

const MAKE_ASSIGN = /^(?:(?:export|override|private)\s+)*([A-Za-z_.][A-Za-z0-9_.-]*)\s*(:::=|::=|:=|\?=|\+=|!=|=)\s*(.*)$/;
// Followed by space, a parenthesis or the end: `\b` alone would also match a
// target named `override-config` or `endif-check`.
const MAKE_CONDITIONAL = /^(ifeq|ifneq|ifdef|ifndef|else|endif)(?=[\s(]|$)/;
const MAKE_DIRECTIVE = /^(export|unexport|override|vpath|undefine)(?=\s|$)/;
/** A header: targets, one colon or two, and not an assignment operator. */
const MAKE_RULE = /^([^:#=]+?)\s*::?(?!=)\s*(.*)$/;

/**
 * Explicit rules, variable assignments and the few directives that change how
 * the rest must be read. What is deliberately not a rule here:
 *
 * - a target-specific variable, `release: CFLAGS += -O2`, which defines no rule;
 * - anything inside `define … endef`, which is a variable's value;
 * - a conditional line, which neither starts nor ends a recipe — make reads
 *   recipe lines on both sides of an `ifeq`, so both are kept, and neither is
 *   claimed to be the one that runs.
 *
 * A comment or blank line between recipe lines does not end the recipe, as in
 * make. Special targets (`.PHONY`) and pattern rules (`%.o: %.c`) are kept: the
 * explainer needs `.PHONY` and follows `$(OUT)/app`; the launcher filters them.
 */
export function readMakefile(text: string): Makefile {
  const rules: MakeRule[] = [];
  const vars: Record<string, string> = {};
  let includes = false;
  let defaultGoal: string | null = null;
  let recipePrefix = false;
  let inDefine = false;
  let pendingDoc: string | null = null;
  let current: MakeRule | null = null;
  const physical = text.replace(/\r\n/g, '\n').split('\n');
  for (let n = 0; n < physical.length; n++) {
    const start = n;
    let line = physical[n];
    while (line.endsWith('\\') && n + 1 < physical.length) {
      n += 1;
      line = `${line.slice(0, -1)} ${physical[n].replace(/^\s+/, '')}`;
    }
    if (inDefine) { if (/^\s*endef\b/.test(line)) inDefine = false; continue; }
    if (line.startsWith('\t')) {
      if (current) current.recipe.push(line.slice(1));
      continue;
    }
    if (!line.trim()) { pendingDoc = null; continue; }
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) {
      const doc = /^##\s?(.*)$/.exec(trimmed);
      pendingDoc = doc ? doc[1].trim() || null : null;
      continue;
    }
    if (MAKE_CONDITIONAL.test(trimmed)) { pendingDoc = null; continue; }
    current = null;
    if (/^(?:(?:export|override)\s+)?define(?=\s|$)/.test(trimmed)) { inDefine = true; pendingDoc = null; continue; }
    if (/^-?(include|sinclude)\s/.test(trimmed)) { includes = true; pendingDoc = null; continue; }
    if (/^\.RECIPEPREFIX\s*[:?]?=/.test(trimmed)) { recipePrefix = true; pendingDoc = null; continue; }
    const assign = MAKE_ASSIGN.exec(trimmed);
    if (assign) {
      if (assign[1] === '.DEFAULT_GOAL') defaultGoal = assign[3].trim();
      else vars[assign[1]] = assign[2] === '+=' && vars[assign[1]] ? `${vars[assign[1]]} ${assign[3]}` : assign[3];
      pendingDoc = null;
      continue;
    }
    const rule = MAKE_RULE.exec(trimmed);
    if (!rule || MAKE_DIRECTIVE.test(rule[1])) { pendingDoc = null; continue; }
    // The recipe after `;` goes to the shell as written, so only the
    // prerequisite half loses its comment.
    const semi = rule[2].indexOf(';');
    const head = semi >= 0 ? rule[2].slice(0, semi) : rule[2];
    const inline = semi >= 0 ? rule[2].slice(semi + 1).trim() : '';
    const docInline = /(?:^|\s)##\s?(.*)$/.exec(head);
    const deps = head.replace(/(?:^|\s)#.*$/, '');
    if (deps.includes('=')) { pendingDoc = null; continue; }
    current = {
      targets: rule[1].trim().split(/\s+/),
      prereqs: deps.replace(/\|/g, ' ').trim().split(/\s+/).filter(Boolean),
      recipe: inline ? [inline] : [],
      line: start + 1,
      doc: (docInline?.[1].trim() || pendingDoc) ?? null,
    };
    rules.push(current);
    pendingDoc = null;
  }
  return { rules, vars, includes, defaultGoal, recipePrefix };
}

/* ── justfile ───────────────────────────────────────────────────────── */

export type JustRecipe = {
  name: string;
  /** The parameter list as written, e.g. `target="release" *args`; empty when there is none. */
  params: string;
  deps: string[];
  /** Body lines without their indentation. */
  body: string[];
  shebang: boolean;
  /** 1-based line of the recipe header. */
  line: number;
  /** A `# comment` directly above, or a `[doc("…")]` attribute. */
  doc: string | null;
  /** A leading underscore or a `[private]` attribute: runnable, but not listed by `just --list`. */
  private: boolean;
};

export type Justfile = { recipes: JustRecipe[]; vars: Record<string, string>; imports: boolean; shellSet: boolean };

/** A parameter token may carry a quoted default with spaces or a colon in it. */
const JUST_RECIPE = /^@?([A-Za-z_][A-Za-z0-9_-]*)((?:\s+(?:[^:"'\s]|"[^"]*"|'[^']*')+)*)\s*:(?!=)\s*(.*)$/;

/**
 * Recipes, variable assignments, and the settings that change how a body must
 * be read. A blank line inside a recipe does not end it; a line back at column
 * zero does. A comment or attribute describes the recipe directly below it and
 * nothing further down.
 */
export function readJustfile(text: string): Justfile {
  const recipes: JustRecipe[] = [];
  const vars: Record<string, string> = {};
  let imports = false;
  let shellSet = false;
  let current: JustRecipe | null = null;
  let doc: string | null = null;
  let privateNext = false;
  const reset = () => { doc = null; privateNext = false; };
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
    if (!line.trim()) { reset(); continue; }
    current = null;
    const comment = /^#\s?(.*)$/.exec(line);
    if (comment) { doc = line.startsWith('#!') ? null : comment[1].trim() || null; continue; }
    const attribute = /^\[([^\]]*)\]\s*$/.exec(line);
    if (attribute) {
      if (/(^|,)\s*private\s*(,|$)/.test(attribute[1])) privateNext = true;
      const described = /doc\(\s*["']([^"']*)["']\s*\)/.exec(attribute[1]);
      if (described) doc = described[1];
      continue;
    }
    if (/^(import|mod)\b/.test(line)) { imports = true; reset(); continue; }
    if (/^set\s+shell\b/.test(line)) { shellSet = true; reset(); continue; }
    const assign = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_-]*)\s*:=\s*(.*)$/.exec(line);
    if (assign) { vars[assign[1]] = assign[2]; reset(); continue; }
    if (/^(set|alias|export)\b/.test(line)) { reset(); continue; }
    const head = JUST_RECIPE.exec(line);
    if (!head) { reset(); continue; }
    // `build: (test "x") && notify` — a parenthesised dependency is its first
    // word plus arguments; `&&` separates the ones that run before from after.
    const deps = head[3].replace(/\s+#.*$/, '').replace(/\([^)]*\)/g, (m) => m.slice(1, -1).trim().split(/\s+/)[0] ?? '')
      .split(/\s+/).filter((d) => d && d !== '&&');
    current = {
      name: head[1], params: head[2].trim(), deps, body: [], shebang: false, line: n + 1,
      doc, private: head[1].startsWith('_') || privateNext,
    };
    recipes.push(current);
    reset();
  }
  return { recipes, vars, imports, shellSet };
}

/* ── recipe lines ───────────────────────────────────────────────────── */

/**
 * The command a recipe line hands the shell, without the prefixes that only
 * tell the runner how to run it: make's `@` (silent), `-` (ignore errors) and
 * `+` (run under -n); just's `@` and `-`.
 */
export function recipeCommand(line: string, runner: 'make' | 'just'): string {
  return line.replace(runner === 'make' ? /^[@+-]+/ : /^[@-]+/, '').trim();
}
