import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * The CLAUDE.md chain, resolved the way Claude Code resolves it — before a
 * session launches rather than after it has already been told something.
 *
 * A session opens with a pile of instructions nobody chose all at once: a
 * managed policy file, the user's own memory, one CLAUDE.md per directory
 * between the filesystem root and the repo, the project's own, everything
 * those import, and the rules directory. In a monorepo the ancestor files are
 * exactly the ones people forget are loaded, a path-scoped rule that matches
 * nothing looks identical to one that works, and a CLAUDE.md of 4 MiB plus one
 * byte is dropped in silence. So this module reads disk and says, in order,
 * what the agent is about to be handed.
 *
 * It is a prediction and it says so. The InstructionsLoaded hook is the only
 * ground truth about what a particular launch loaded; Wanigan reconciles the
 * two once a session has run. Where the documented behaviour is genuinely
 * ambiguous — which project file wins when both ./CLAUDE.md and
 * ./.claude/CLAUDE.md exist, where rules interleave with memory — the
 * ambiguity is reported rather than guessed at.
 */

/* ── the documented facts, as constants ──────────────────────────────── */

/**
 * Managed policy sits outside the user's control on purpose, and its CLAUDE.md
 * can never be excluded. macOS, Windows (%ProgramData%) and Linux/WSL each have
 * a documented location; anything else falls back to the Linux path rather than
 * inventing a fourth. Exported so the memory and config modules resolve the
 * SAME directory — three panels reading three managed layers would contradict
 * each other about one policy.
 */
export function managedPolicyDir(): string {
  if (process.platform === 'darwin') return '/Library/Application Support/ClaudeCode';
  if (process.platform === 'win32') {
    return path.join(process.env.ProgramData || 'C:\\ProgramData', 'ClaudeCode');
  }
  return '/etc/claude-code';
}
const MANAGED_DIR = managedPolicyDir();
const MANAGED_CLAUDE_MD = path.join(MANAGED_DIR, 'CLAUDE.md');
const MANAGED_SETTINGS = path.join(MANAGED_DIR, 'managed-settings.json');

const HOME = os.homedir();
const USER_CLAUDE_MD = path.join(HOME, '.claude', 'CLAUDE.md');
const USER_RULES = path.join(HOME, '.claude', 'rules');
const USER_SETTINGS = path.join(HOME, '.claude', 'settings.json');

/** A CLAUDE.md up to 4 MiB is loaded in full. One byte over and it is skipped entirely — not truncated. */
const MAX_LOADED_BYTES = 4 * 1024 * 1024;
/** The documented target, not a ceiling: past it a file dilutes itself. */
const TARGET_LINES = 200;
/** `@path` imports are recursive to at most 4 hops. */
const MAX_IMPORT_DEPTH = 4;
/** Brace expansion in a rule glob is budgeted; over budget the pattern is used unexpanded and matches nothing. */
const BRACE_PATTERN_BUDGET = 1000;
const BRACE_BYTE_BUDGET = 4 * 1024 * 1024;

/**
 * How much of any one file Wanigan itself pulls into memory. Claude Code will
 * happily load 4 MiB; the main process holding several of those while the user
 * clicks around is a different matter, so the scan is capped and every file it
 * had to cut is told so in its own warnings.
 */
const SCAN_BYTES = 1024 * 1024;
/** Ceiling on the project walk that backs "how many files match this rule". */
const MAX_WALK_FILES = 20_000;
const MAX_WALK_DEPTH = 12;
/** Build output and dependencies are not what a path-scoped rule is aimed at. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', 'vendor', 'dist', 'build', '.cache', 'out',
  'coverage', '.venv', 'venv', '__pycache__', '.turbo', 'target',
]);

/* ── types ───────────────────────────────────────────────────────────── */

export type InstructionScope = 'managed' | 'user' | 'ancestor' | 'project' | 'local' | 'rule' | 'import';

export type InstructionFile = {
  path: string;
  scope: InstructionScope;
  exists: boolean;
  bytes: number;
  lines: number;
  /** Load order index; lower appears earlier in the agent's context. */
  order: number;
  /** Depth for imports, 0 for a directly-loaded file. */
  depth: number;
  /** The file that imported this one, when it was reached by an import. */
  importedBy: string | null;
  /** True when a project-scope import resolves outside the working directory. */
  external: boolean;
  /**
   * Populated when the file loads conditionally rather than at launch. An
   * imported file inherits its importer's trigger: the import is only read when
   * the file that imports it is.
   */
  conditional: { kind: 'paths'; globs: string[]; matchingFiles: number } | null;
  /**
   * A second reference to content that is already counted once — an import
   * reached from two files, or the losing half of the ./CLAUDE.md vs
   * ./.claude/CLAUDE.md pair. It stays listed with its warning, but adding its
   * bytes again would overstate the launch budget by a whole file.
   */
  duplicate: boolean;
  /** Warnings that change behaviour: over 4 MiB, over 200 lines, excluded, missing, cyclic. */
  warnings: string[];
  excludedBy: string | null;
};

export type InstructionChain = {
  files: InstructionFile[];
  /**
   * Size of what loads at launch — the answer to "how much is every session in
   * this repo told before the user types anything". On-demand files are not
   * counted, because they are not paid for until something touches them.
   */
  totalBytes: number;
  totalLines: number;
  /** Files that would load at launch, in the order they enter context. */
  atLaunch: InstructionFile[];
  /** Files that only load when Claude touches matching paths. */
  onDemand: InstructionFile[];
  notes: string[];
  /** The git repository root when there is one, otherwise the project path itself. */
  root: string;
  isGitRepo: boolean;
};

/* ── small filesystem helpers ────────────────────────────────────────── */

function within(root: string, p: string): boolean {
  const a = path.resolve(root);
  const b = path.resolve(p);
  return b === a || b.startsWith(a + path.sep);
}

/** realpath where possible, so two names for one file are recognised as one file. */
function real(p: string): string {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MiB`;
}

function countLines(text: string): number {
  if (!text) return 0;
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return text.endsWith('\n') ? n : n + 1;
}

/**
 * Line count without holding the file in memory. Only used for the handful of
 * files bigger than the scan cap; anything past the 4 MiB ceiling is not
 * counted at all, because it is skipped by the loader and the I/O would buy
 * nothing.
 */
function countLinesOnDisk(p: string, size: number): number {
  if (size > MAX_LOADED_BYTES) return 0;
  let fd: number;
  try { fd = fs.openSync(p, 'r'); } catch { return 0; }
  try {
    const buf = Buffer.allocUnsafe(64 * 1024);
    let n = 0, off = 0, last = 0;
    for (;;) {
      const read = fs.readSync(fd, buf, 0, buf.length, off);
      if (read <= 0) break;
      for (let i = 0; i < read; i++) if (buf[i] === 10) n++;
      last = buf[read - 1];
      off += read;
    }
    if (off === 0) return 0;
    return last === 10 ? n : n + 1;
  } catch { return 0; } finally { fs.closeSync(fd); }
}

/** First `cap` bytes only. Returns null rather than throwing — a scan must not die on one unreadable file. */
function readCapped(p: string, cap: number): { text: string; truncated: boolean; bytes: number } | null {
  let st: fs.Stats;
  try { st = fs.statSync(p); } catch { return null; }
  if (!st.isFile()) return null;
  let fd: number;
  try { fd = fs.openSync(p, 'r'); } catch { return null; }
  try {
    const len = Math.min(st.size, cap);
    const buf = Buffer.allocUnsafe(len);
    let off = 0;
    while (off < len) {
      const read = fs.readSync(fd, buf, off, len - off, off);
      if (read <= 0) break;
      off += read;
    }
    // A cut at a byte boundary can split a multi-byte character. That is one
    // mangled glyph at the very end of an already-truncated read, and the
    // alternative is decoding megabytes to find a safe boundary.
    return { text: buf.subarray(0, off).toString('utf8'), truncated: st.size > len, bytes: st.size };
  } catch { return null; } finally { fs.closeSync(fd); }
}

/** The file itself, for a reading pane. Throws with a sentence, because a click asked for this one file. */
export function readInstruction(p: string): { text: string; truncated: boolean; bytes: number } {
  if (!servable.has(p)) {
    // The renderer asked for a path no scan produced. A legitimate open always
    // follows a scan of the chain that listed the file; anything else is not
    // this process's file to hand over.
    throw new Error(
      `${p} is not part of a scanned instruction chain. Re-scan the project, then open the file from its row.`
    );
  }
  let st: fs.Stats;
  try {
    st = fs.statSync(p);
  } catch {
    throw new Error(
      `There is no readable file at ${p}. It was renamed or deleted since Wanigan scanned the project — refresh the instruction chain.`
    );
  }
  if (!st.isFile()) throw new Error(`${p} is a directory, not an instruction file, so there is nothing to show.`);
  const out = readCapped(p, SCAN_BYTES);
  if (!out) throw new Error(`Wanigan could not read ${p}. Check the file's permissions.`);
  return out;
}

/* ── markdown: comments, code, imports ───────────────────────────────── */

const blank = (s: string) => ' '.repeat(s.length);

/**
 * Claude Code strips block-level HTML comments before injecting a memory file,
 * so a commented-out instruction is genuinely gone rather than merely invisible
 * in a preview. "Block-level" is read here as "the comment owns whole lines":
 * an inline `<!-- note -->` in the middle of a sentence is left alone, and
 * fenced code is left alone too, matching how the import scanner treats fences.
 */
export function stripHtmlComments(md: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  let inComment = false;

  for (const line of md.split('\n')) {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (!inComment && fence === null && f) { fence = f[1]; out.push(line); continue; }
    if (fence !== null) {
      out.push(line);
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
      continue;
    }
    if (inComment) {
      const end = line.indexOf('-->');
      if (end === -1) continue;
      inComment = false;
      const rest = line.slice(end + 3);
      if (rest.trim() !== '') out.push(rest);
      continue;
    }
    const trimmed = line.trimStart();
    if (!trimmed.startsWith('<!--')) { out.push(line); continue; }
    const end = line.indexOf('-->', line.indexOf('<!--') + 4);
    if (end === -1) { inComment = true; continue; }
    const rest = line.slice(end + 3);
    if (rest.trim() !== '') out.push(rest);
  }
  return out.join('\n');
}

/** Backtick runs pair with the next run of the same length — the CommonMark rule, scanned rather than regexed. */
function maskInlineCode(line: string): string {
  const chars = line.split('');
  let i = 0;
  while (i < chars.length) {
    if (chars[i] !== '`') { i++; continue; }
    let n = 0;
    while (chars[i + n] === '`') n++;
    let j = i + n;
    let closed = false;
    while (j < chars.length) {
      if (chars[j] !== '`') { j++; continue; }
      let k = 0;
      while (chars[j + k] === '`') k++;
      if (k === n) { closed = true; break; }
      j += k;
    }
    if (!closed) { i += n; continue; }
    for (let x = i; x < j + n; x++) chars[x] = ' ';
    i = j + n;
  }
  return chars.join('');
}

/**
 * Blanks out fenced blocks and inline code spans, keeping every offset intact.
 * Import parsing skips them, which is why a README that documents `@AGENTS.md`
 * inside backticks does not silently acquire an import.
 */
function maskCodeRegions(text: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of text.split('\n')) {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence === null) {
      if (f) { fence = f[1]; out.push(blank(line)); continue; }
      out.push(maskInlineCode(line));
      continue;
    }
    out.push(blank(line));
    if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
  }
  return out.join('\n');
}

/**
 * An `@` only opens an import at the start of a line or after whitespace or an
 * opening bracket — otherwise every email address in a memory file would look
 * like a broken import.
 */
const IMPORT_RE = /(^|[\s(<['"])@([^\s`'"<>()[\],;]+)/g;

/**
 * Heuristic, and worth naming as one: a bare `@team` is treated as prose, while
 * anything with a slash, a leading ~ . or /, or a file extension is treated as
 * an import. Claude Code would look for a file called `team` and quietly find
 * nothing; reporting that as a broken import would cry wolf on every @mention.
 */
function looksLikePath(p: string): boolean {
  if (p.startsWith('~') || p.startsWith('/') || p.startsWith('./') || p.startsWith('../')) return true;
  if (p.includes('/')) return true;
  return /\.[A-Za-z0-9]{1,8}$/.test(p);
}

function resolveImportPath(spec: string, fromFile: string): string {
  if (spec === '~') return HOME;
  if (spec.startsWith('~/')) return path.join(HOME, spec.slice(2));
  if (path.isAbsolute(spec)) return path.normalize(spec);
  // Relative imports resolve against the directory of the FILE CONTAINING THE
  // IMPORT, not the working directory. This is the rule people get wrong when
  // they move a memory file into .claude/ and every @doc/… breaks.
  return path.resolve(path.dirname(fromFile), spec);
}

/**
 * The `@path` imports in one file. `raw` is the token exactly as written, so it
 * can be grepped for; `resolved` is the absolute path Claude Code would open.
 * Deduplicated by resolved path: a file imported twice is loaded once.
 */
export function parseImports(text: string, fromFile: string): { raw: string; resolved: string }[] {
  const masked = maskCodeRegions(stripHtmlComments(text));
  const seen = new Set<string>();
  const out: { raw: string; resolved: string }[] = [];

  for (const m of masked.matchAll(IMPORT_RE)) {
    // Trailing sentence punctuation is not part of the path; a real path
    // ending in "." does not exist in practice, and "see @docs/x.md." is common.
    const spec = m[2].replace(/[.,;:!?)\]}>]+$/, '');
    if (!spec || !looksLikePath(spec)) continue;
    const resolved = resolveImportPath(spec, fromFile);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push({ raw: '@' + spec, resolved });
  }
  return out;
}

/* ── globs ───────────────────────────────────────────────────────────── */

/** A regex that matches nothing, which is exactly what an invalid pattern does. */
const NEVER = /(?!)/;

function bracketExpression(pattern: string, start: number): { source: string; end: number } | null {
  let i = start + 1;
  let negate = false;
  if (pattern[i] === '!' || pattern[i] === '^') { negate = true; i++; }
  let body = '';
  // A ']' straight after the opener is a literal ']'.
  if (pattern[i] === ']') { body += '\\]'; i++; }
  for (; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === ']') {
      if (!body) return null;
      return { source: `[${negate ? '^' : ''}${body}]`, end: i };
    }
    // A class never spans a path separator.
    if (c === '/') return null;
    body += (c === '\\' || c === '^' || c === ']') ? '\\' + c : c;
  }
  return null;
}

/**
 * Minimal glob — **, *, ?, and bracket expressions. Same approach as
 * batch/sources.ts, extended only where the rules loader documents behaviour:
 * a '[' that is not a valid bracket expression matches nothing at all, rather
 * than falling back to a literal bracket and appearing to work.
 */
function globToRegExp(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') { out += '.*'; i++; if (pattern[i + 1] === '/') i++; }
      else out += '[^/]*';
    } else if (c === '?') {
      out += '[^/]';
    } else if (c === '[') {
      const cls = bracketExpression(pattern, i);
      if (!cls) return NEVER;
      out += cls.source;
      i = cls.end;
    } else if ('\\^$.|+()[]{}'.includes(c)) {
      out += '\\' + c;
    } else {
      out += c;
    }
  }
  return new RegExp('^' + out + '$');
}

function firstBraceGroup(p: string): { start: number; end: number; alts: string[] } | null {
  const start = p.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  const alts: string[] = [];
  let cur = '';
  for (let i = start; i < p.length; i++) {
    const c = p[i];
    if (c === '{') { depth++; if (depth === 1) continue; }
    else if (c === '}') {
      depth--;
      if (depth === 0) { alts.push(cur); return { start, end: i, alts }; }
    } else if (c === ',' && depth === 1) { alts.push(cur); cur = ''; continue; }
    cur += c;
  }
  return null; // unmatched '{' — literal, not an expansion
}

/**
 * Brace expansion, budgeted exactly as documented: 1,000 expanded patterns or
 * 4 MiB per rule. Over budget the pattern is used UNEXPANDED, which means it
 * matches nothing — a silent no-op that looks like a working rule, so callers
 * surface `overBudget` as a warning.
 */
function expandBraces(pattern: string): { patterns: string[]; overBudget: boolean } {
  if (!pattern.includes('{')) return { patterns: [pattern], overBudget: false };
  let work = [pattern];
  for (let pass = 0; pass < 32; pass++) {
    const next: string[] = [];
    let expanded = false;
    for (const p of work) {
      const g = firstBraceGroup(p);
      if (!g) { next.push(p); continue; }
      expanded = true;
      for (const alt of g.alts) next.push(p.slice(0, g.start) + alt + p.slice(g.end + 1));
      if (next.length > BRACE_PATTERN_BUDGET) return { patterns: [pattern], overBudget: true };
    }
    if (next.reduce((n, s) => n + s.length, 0) > BRACE_BYTE_BUDGET) return { patterns: [pattern], overBudget: true };
    work = next;
    if (!expanded) break;
  }
  return { patterns: work, overBudget: false };
}

function globMatcher(pattern: string): { test: (s: string) => boolean; overBudget: boolean; invalid: boolean } {
  const { patterns, overBudget } = expandBraces(pattern);
  const res = patterns.map((p) => globToRegExp(p.startsWith('./') ? p.slice(2) : p));
  // `invalid` is how a malformed bracket expression is told apart from a glob
  // that is simply too specific. Both match nothing, and only one is a typo.
  return { test: (s: string) => res.some((r) => r.test(s)), overBudget, invalid: res.some((r) => r === NEVER) };
}

/** A brace expansion can run to hundreds of characters; a warning still has to be readable. */
function shortGlob(g: string): string {
  return `"${g.length > 72 ? g.slice(0, 71) + '\u2026' : g}"`;
}

/* ── settings layers: claudeMdExcludes ───────────────────────────────── */

type ExcludeRule = { pattern: string; layer: string; test: (p: string) => boolean };

function readJson(file: string, notes: string[], label: string): Record<string, unknown> | null {
  const read = readCapped(file, SCAN_BYTES);
  if (!read) return null;
  try {
    const parsed: unknown = JSON.parse(read.text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    // A settings file with a trailing comma silently stops applying. Saying so
    // is the difference between "my excludes do nothing" and a two-second fix.
    notes.push(`${label} is not valid JSON, so Claude Code ignores it — and so does this view. Fix the syntax.`);
    return null;
  }
}

/**
 * claudeMdExcludes is settable at every settings layer and the ARRAYS MERGE —
 * a project file does not replace the user's list, it adds to it. Patterns are
 * matched against absolute paths.
 */
function readExcludes(projectPath: string, notes: string[]): ExcludeRule[] {
  const layers = [
    { file: USER_SETTINGS, label: '~/.claude/settings.json' },
    { file: path.join(projectPath, '.claude', 'settings.json'), label: '.claude/settings.json' },
    { file: path.join(projectPath, '.claude', 'settings.local.json'), label: '.claude/settings.local.json' },
    { file: MANAGED_SETTINGS, label: 'managed policy' },
  ];

  const out: ExcludeRule[] = [];
  for (const l of layers) {
    const json = readJson(l.file, notes, l.label);
    const raw = json?.claudeMdExcludes;
    if (!Array.isArray(raw)) continue;
    for (const entry of raw) {
      if (typeof entry !== 'string' || !entry.trim()) continue;
      const spec = entry.startsWith('~/') ? path.join(HOME, entry.slice(2)) : entry;
      const m = globMatcher(spec);
      if (m.overBudget) {
        notes.push(`claudeMdExcludes pattern "${entry}" (${l.label}) expands past the 1,000-pattern budget, so it is used unexpanded and excludes nothing.`);
      }
      if (m.invalid) {
        notes.push(`claudeMdExcludes pattern "${entry}" (${l.label}) has a "[" that is not a valid bracket expression, so it matches nothing and excludes nothing.`);
      }
      if (!spec.startsWith('/') && !spec.startsWith('*')) {
        notes.push(`claudeMdExcludes pattern "${entry}" (${l.label}) is matched against absolute paths but starts with neither "/" nor "*", so it can never match. Prefix it with "**/".`);
      }
      out.push({ pattern: entry, layer: l.label, test: m.test });
    }
  }
  return out;
}

/* ── the project walk ────────────────────────────────────────────────── */

/**
 * One bounded walk, reused for every "how many files match this glob" answer
 * and for finding subdirectory memory files. Symlinked directories are not
 * followed: withFileTypes reports a symlink as neither file nor directory, so a
 * loop cannot happen here, and a repo that symlinks half of itself does not
 * turn a UI refresh into a stall.
 */
function walkProject(root: string): { files: string[]; truncated: boolean } {
  const files: string[] = [];
  let truncated = false;

  (function walk(dir: string, depth: number) {
    if (truncated || depth > MAX_WALK_DEPTH) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (files.length >= MAX_WALK_FILES) { truncated = true; return; }
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        if (e.name.startsWith('.') && e.name !== '.claude') continue;
        walk(full, depth + 1);
      } else if (e.isFile()) {
        files.push(path.relative(root, full));
      }
    }
  })(root, 0);

  return { files, truncated };
}

/* ── rules ───────────────────────────────────────────────────────────── */

/**
 * .claude/rules/**\/*.md, recursively, with symlinks resolved — a rules
 * directory that is a symlink into a dotfiles repo is normal. Visited realpaths
 * are remembered so a circular symlink ends the walk instead of the process.
 */
function scanRuleFiles(root: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();

  (function walk(dir: string, depth: number) {
    if (depth > 8) return;
    let realDir: string;
    try { realDir = fs.realpathSync(dir); } catch { return; }
    if (seen.has(realDir)) return;
    seen.add(realDir);
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      let st: fs.Stats;
      // statSync follows the symlink; that is the documented behaviour here.
      try { st = fs.statSync(full); } catch { continue; }
      if (st.isDirectory()) walk(full, depth + 1);
      else if (st.isFile() && e.name.toLowerCase().endsWith('.md')) found.push(full);
    }
  })(root, 0);

  return found.sort();
}

function unquote(v: string): string {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
}

/**
 * Split a YAML flow list's contents on commas — but only commas outside quotes
 * and outside braces. A naive split turns ["*.{ts,tsx}"] into two broken
 * globs, each of which matches nothing, and the rule is then reported as one
 * that never loads when it works fine.
 */
function splitFlowList(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let depth = 0;
  for (const c of s) {
    if (quote) {
      if (c === quote) quote = null;
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === '{') depth++;
    else if (c === '}' && depth > 0) depth--;
    else if (c === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

/**
 * The one frontmatter key that decides when a rule loads. Deliberately small,
 * like skills.ts: a YAML parser bought to read one key would be a dependency,
 * and the three shapes people actually write are a block list, a flow list and
 * a bare scalar.
 */
function rulePaths(text: string): { globs: string[]; hasPaths: boolean } {
  if (!text.startsWith('---')) return { globs: [], hasPaths: false };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { globs: [], hasPaths: false };
  const block = text.slice(text.indexOf('\n', 3) + 1, end);

  const globs: string[] = [];
  let hasPaths = false;
  let inList = false;
  for (const raw of block.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    const m = /^paths:\s*(.*)$/.exec(line);
    if (m) {
      hasPaths = true;
      const rest = m[1].trim();
      if (rest.startsWith('[')) {
        for (const part of splitFlowList(rest.replace(/^\[|\]$/g, ''))) {
          const v = unquote(part);
          if (v) globs.push(v);
        }
      } else if (rest && !rest.startsWith('#')) {
        globs.push(unquote(rest));
      } else {
        inList = true;
      }
      continue;
    }
    if (!inList) continue;
    const item = /^\s*-\s*(.+)$/.exec(line);
    if (item) { const v = unquote(item[1]); if (v) globs.push(v); continue; }
    if (/^\S/.test(line)) inList = false;
  }
  return { globs, hasPaths };
}

/* ── chain assembly ──────────────────────────────────────────────────── */

type Ctx = {
  projectPath: string;
  files: InstructionFile[];
  notes: string[];
  excludes: ExcludeRule[];
  /** Realpaths already pulled in by an import, so a diamond is not expanded twice. */
  imported: Set<string>;
};

type RecordOpts = {
  depth?: number;
  importedBy?: string | null;
  external?: boolean;
  conditional?: InstructionFile['conditional'];
  warnings?: string[];
  /** Content that is not on disk — the managed policy's inline claudeMd key. */
  inline?: string;
  /** Scope of the file that started this import chain; user and managed chains are trusted. */
  chainScope?: InstructionScope;
  /** Realpaths of the importers above this file, for cycle detection. */
  stack?: string[];
  /** Skip import expansion — used for a file that is listed but does not load. */
  inert?: boolean;
  /** This entry repeats content counted elsewhere; keep it out of the totals. */
  duplicate?: boolean;
};

function record(ctx: Ctx, p: string, scope: InstructionScope, opts: RecordOpts = {}): InstructionFile {
  const warnings = [...(opts.warnings ?? [])];
  let exists = false;
  let bytes = 0;
  let lines = 0;
  let text: string | null = null;
  let oversize = false;

  if (opts.inline !== undefined) {
    exists = true;
    bytes = Buffer.byteLength(opts.inline);
    lines = countLines(opts.inline);
    text = opts.inline;
  } else {
    let st: fs.Stats | null = null;
    try { st = fs.statSync(p); } catch { st = null; }

    if (st && !st.isFile()) {
      warnings.push('This path is a directory, not a file, so nothing loads from it.');
    } else if (st) {
      exists = true;
      bytes = st.size;

      // Never follow a link out of the project without saying where it went.
      try {
        const link = fs.lstatSync(p);
        if (link.isSymbolicLink()) {
          const target = real(p);
          warnings.push(within(ctx.projectPath, target)
            ? `Symlink to ${target}.`
            : `Symlink to ${target}, outside the project — that file's contents are what loads.`);
        }
      } catch { /* raced with a delete; the stat above is the authority */ }

      if (bytes > MAX_LOADED_BYTES) {
        oversize = true;
        warnings.push(`${fmtBytes(bytes)} — over the 4 MiB ceiling, so Claude Code skips this file ENTIRELY. It is not truncated; none of it is loaded.`);
      } else {
        const read = readCapped(p, SCAN_BYTES);
        if (read) {
          text = read.text;
          lines = read.truncated ? countLinesOnDisk(p, bytes) : countLines(read.text);
          if (read.truncated) {
            warnings.push(`Wanigan read only the first ${fmtBytes(SCAN_BYTES)} of this file, so imports below that point are not listed here.`);
          }
        } else {
          warnings.push('Wanigan could not read this file. Check its permissions — Claude Code will hit the same wall.');
        }
      }
    }
  }

  // Managed policy is exempt from claudeMdExcludes by design; excluding it is
  // the one thing the mechanism must not be able to do.
  let excludedBy: string | null = null;
  if (exists && opts.inline === undefined) {
    const hit = ctx.excludes.find((e) => e.test(p));
    if (hit && scope === 'managed') {
      ctx.notes.push(`A claudeMdExcludes pattern ("${hit.pattern}") matches the managed policy CLAUDE.md, but managed policy cannot be excluded — it loads anyway.`);
    } else if (hit) {
      excludedBy = `${hit.pattern} (${hit.layer})`;
      warnings.push(`Excluded by claudeMdExcludes, so none of it reaches the agent.`);
    }
  }

  if (!exists && opts.inline === undefined) {
    warnings.push('There is no file at this path, so nothing loads from it.');
  }
  if (exists && !oversize && lines > TARGET_LINES) {
    warnings.push(`${lines} lines — past the documented 200-line target. Long instruction files dilute themselves; split the detail into an imported file.`);
  }

  const entry: InstructionFile = {
    path: p,
    scope,
    exists,
    bytes,
    lines,
    order: ctx.files.length,
    depth: opts.depth ?? 0,
    importedBy: opts.importedBy ?? null,
    external: opts.external ?? false,
    conditional: opts.conditional ?? null,
    duplicate: opts.duplicate ?? false,
    warnings,
    excludedBy,
  };
  ctx.files.push(entry);

  // An excluded or oversize file is never read by the loader, so its imports
  // are never followed either — listing them would invent context.
  if (text !== null && exists && !excludedBy && !oversize && !opts.inert) {
    expandImports(ctx, entry, text, opts.chainScope ?? scope, opts.stack ?? []);
  }
  return entry;
}

function expandImports(ctx: Ctx, parent: InstructionFile, text: string, chainScope: InstructionScope, stack: string[]) {
  const imports = parseImports(text, parent.path);
  if (!imports.length) return;

  if (parent.depth >= MAX_IMPORT_DEPTH) {
    parent.warnings.push(`${imports.length} import(s) here sit at hop ${parent.depth} and are NOT followed — Claude Code stops after 4 hops.`);
    return;
  }

  const here = [...stack, real(parent.path)];
  for (const imp of imports) {
    const key = real(imp.resolved);

    if (here.includes(key)) {
      parent.warnings.push(`Circular import: ${imp.raw} is already open further up this chain, so it is not followed again.`);
      continue;
    }

    // User- and managed-scope files are trusted. An import inside a project
    // file that lands outside the working directory is the case that stops the
    // launch with an approval dialog the first time.
    const external = chainScope !== 'user' && chainScope !== 'managed' && !within(ctx.projectPath, imp.resolved);
    const warnings: string[] = [];
    if (external) {
      warnings.push('External import: it resolves outside the working directory, so Claude Code asks for approval once before loading it.');
    }

    const repeat = ctx.imported.has(key);
    if (repeat) {
      warnings.push('Already imported earlier in this chain; its own imports are listed there. It is loaded once, so it is counted once — these bytes are not in the launch total a second time.');
    }
    ctx.imported.add(key);

    record(ctx, imp.resolved, 'import', {
      depth: parent.depth + 1,
      importedBy: parent.path,
      external,
      // An import is read only when the file importing it is read, so a file
      // pulled in by an on-demand memory file is on-demand too. Without this it
      // lands in atLaunch and its bytes inflate "what every session starts
      // with" — in a monorepo, by every package's imported docs tree.
      conditional: parent.conditional,
      // Counted once, at its first reference. A standards file imported from
      // two memory files loads once; adding it twice overstates the budget.
      duplicate: repeat,
      warnings,
      chainScope,
      stack: here,
      inert: repeat,
    });
  }
}

function recordIfPresent(ctx: Ctx, p: string, scope: InstructionScope, opts: RecordOpts = {}): InstructionFile | null {
  let st: fs.Stats | null = null;
  try { st = fs.statSync(p); } catch { return null; }
  if (!st.isFile()) return null;
  return record(ctx, p, scope, opts);
}

/**
 * Which memory filename a directory entry fills, if any. On macOS and Windows
 * the default filesystems are case-insensitive, so a mis-cased Claude.md loads
 * in real sessions — the CLI's open of CLAUDE.md finds it — and a walk that
 * compares exactly would list a file the agent reads as if it did not exist.
 * Linux stays exact: there the CLI itself would not load it.
 */
const CASE_INSENSITIVE_FS = process.platform === 'darwin' || process.platform === 'win32';

function memoryBasename(name: string): 'CLAUDE.md' | 'CLAUDE.local.md' | null {
  if (name === 'CLAUDE.md' || name === 'CLAUDE.local.md') return name;
  if (!CASE_INSENSITIVE_FS) return null;
  const lower = name.toLowerCase();
  if (lower === 'claude.md') return 'CLAUDE.md';
  if (lower === 'claude.local.md') return 'CLAUDE.local.md';
  return null;
}

/** Every directory between the filesystem root and the project, root first. */
function ancestorsOf(dir: string): string[] {
  const out: string[] = [];
  let cur = path.dirname(path.resolve(dir));
  for (;;) {
    out.push(cur);
    const next = path.dirname(cur);
    if (next === cur) break;
    cur = next;
  }
  return out.reverse();
}

function gitRootOf(dir: string): string | null {
  let cur = path.resolve(dir);
  for (;;) {
    try {
      // A worktree's .git is a FILE pointing at the real gitdir; both count.
      const st = fs.statSync(path.join(cur, '.git'));
      if (st.isDirectory() || st.isFile()) return cur;
    } catch { /* keep climbing */ }
    const next = path.dirname(cur);
    if (next === cur) return null;
    cur = next;
  }
}

/* ── AGENTS.md ───────────────────────────────────────────────────────── */

/**
 * The single most common false assumption in this area: Claude Code DOES NOT
 * READ AGENTS.md. It reaches context only if a CLAUDE.md imports it or
 * CLAUDE.md is a symlink to it. A repo can carry a beautifully maintained
 * AGENTS.md that no session has ever seen, and nothing on screen says so.
 */
export function agentsMdStatus(projectPath: string): { present: boolean; imported: boolean; symlinked: boolean; note: string } {
  const abs = path.resolve(projectPath);
  const agents = path.join(abs, 'AGENTS.md');

  let present = false;
  try { present = fs.statSync(agents).isFile(); } catch { present = false; }
  if (!present) {
    return { present: false, imported: false, symlinked: false, note: 'This project has no AGENTS.md.' };
  }
  const agentsReal = real(agents);

  const candidates = [
    path.join(abs, 'CLAUDE.md'),
    path.join(abs, '.claude', 'CLAUDE.md'),
    path.join(abs, 'CLAUDE.local.md'),
  ];

  let symlinked = false;
  let symlinkSource = '';
  for (const c of candidates) {
    try {
      if (fs.lstatSync(c).isSymbolicLink() && real(c) === agentsReal) {
        symlinked = true;
        symlinkSource = path.relative(abs, c);
        break;
      }
    } catch { /* not there */ }
  }

  // Follow the import graph the same 4 hops the loader would, so an
  // @AGENTS.md two files down still counts as reaching context.
  let imported = false;
  let importSource = '';
  const seen = new Set<string>();
  const queue: { file: string; depth: number }[] = candidates.map((f) => ({ file: f, depth: 0 }));
  while (queue.length && !imported) {
    const item = queue.shift();
    if (!item || item.depth > MAX_IMPORT_DEPTH) continue;
    const key = real(item.file);
    if (seen.has(key)) continue;
    seen.add(key);
    const read = readCapped(item.file, SCAN_BYTES);
    if (!read) continue;
    for (const imp of parseImports(read.text, item.file)) {
      if (real(imp.resolved) === agentsReal) {
        imported = true;
        importSource = path.relative(abs, item.file);
        break;
      }
      queue.push({ file: imp.resolved, depth: item.depth + 1 });
    }
  }

  if (symlinked) {
    return { present, imported, symlinked, note: `AGENTS.md is loaded, because ${symlinkSource} is a symlink to it.` };
  }
  if (imported) {
    return { present, imported, symlinked, note: `AGENTS.md is loaded, because ${importSource} imports it with @AGENTS.md.` };
  }
  return {
    present,
    imported: false,
    symlinked: false,
    note:
      'Claude Code will NOT read AGENTS.md. No CLAUDE.md in this project imports it and no CLAUDE.md is a symlink to it, ' +
      'so not one line of it reaches the agent. Two fixes: add a line reading @AGENTS.md to CLAUDE.md, or replace CLAUDE.md ' +
      'with a symlink to it (ln -s AGENTS.md CLAUDE.md).',
  };
}

/* ── the resolver ────────────────────────────────────────────────────── */

/** Short TTL, like the skills catalogue: a panel that re-renders must not re-walk a monorepo each time. */
const TTL_MS = 15_000;
const cache = new Map<string, { at: number; value: InstructionChain }>();

/**
 * Every path a scan has handed to the renderer. context:read serves ONLY
 * these: the renderer names a file, but the scanner decides which files exist
 * to be named. Without this, one IPC call reads any path on disk — ~/.ssh
 * included — from a renderer whose input this process must treat as untrusted.
 * Exact string membership, deliberately: the scanner emitted these strings,
 * so a path that differs by one byte was not produced by a scan.
 */
const servable = new Set<string>();

function markServable(paths: string[]): void {
  // Bounded like the chain cache; a clear only means "re-scan before reading",
  // which the read error already tells the user to do.
  if (servable.size > 8_192) servable.clear();
  for (const p of paths) servable.add(p);
}

/**
 * Whether a scan has handed this exact path to the renderer — the same
 * membership context:read enforces, exported so context:budget can confine
 * itself to the files a scan actually produced.
 */
export function isServablePath(p: string): boolean {
  return servable.has(p);
}

export function refreshInstructions(): void {
  cache.clear();
}

export function resolveInstructions(projectPath: string): InstructionChain {
  const abs = path.resolve(projectPath);
  let st: fs.Stats | null = null;
  try { st = fs.statSync(abs); } catch { st = null; }
  if (!st?.isDirectory()) {
    throw new Error(`There is no directory at ${abs}, so Wanigan cannot resolve its CLAUDE.md chain. Re-add the project, or pick the folder you actually launch sessions in.`);
  }

  const hit = cache.get(abs);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  const notes: string[] = [];
  const ctx: Ctx = { projectPath: abs, files: [], notes, excludes: readExcludes(abs, notes), imported: new Set() };

  let walked: { files: string[]; truncated: boolean } | null = null;
  const projectFiles = () => (walked ??= walkProject(abs));

  /* 1 · managed policy — first into context, and unexcludable. */
  const managed = recordIfPresent(ctx, MANAGED_CLAUDE_MD, 'managed', { chainScope: 'managed' });
  const managedSettings = readJson(MANAGED_SETTINGS, notes, 'managed policy');
  const inlineManaged = managedSettings?.claudeMd;
  if (typeof inlineManaged === 'string' && inlineManaged.trim()) {
    record(ctx, MANAGED_SETTINGS, 'managed', {
      inline: inlineManaged,
      warnings: ['Instruction text set by the "claudeMd" key inside managed-settings.json rather than a file. It cannot be excluded or edited from here.'],
    });
  }
  if (!managed && typeof inlineManaged !== 'string') {
    notes.push('No managed policy CLAUDE.md on this machine, so nothing is prepended before your own memory.');
  }

  /* 2 · user memory, then user rules. Both are trusted: their imports never prompt. */
  recordIfPresent(ctx, USER_CLAUDE_MD, 'user', { chainScope: 'user' });

  // A user-level rule stays user-scope even when it is path-scoped: its
  // imports are trusted, and flagging them as external would invent a prompt.
  const conditionalRules: { file: string; globs: string[]; chainScope: InstructionScope }[] = [];
  const addRules = (dir: string, chainScope: InstructionScope) => {
    for (const file of scanRuleFiles(dir)) {
      const read = readCapped(file, SCAN_BYTES);
      const { globs, hasPaths } = read ? rulePaths(read.text) : { globs: [], hasPaths: false };
      if (!hasPaths || !globs.length) {
        // No paths: frontmatter means it loads at launch, at the same priority
        // as .claude/CLAUDE.md — which is why a rules directory quietly becomes
        // part of every prompt.
        const warnings = hasPaths ? ['A paths: key with no globs under it loads at launch, like a rule with no paths: at all.'] : [];
        record(ctx, file, 'rule', { chainScope, warnings });
      } else {
        conditionalRules.push({ file, globs, chainScope });
      }
    }
  };
  addRules(USER_RULES, 'user');

  /* 3 · the directory walk: root down to the project, ancestors first. */
  let ancestorCount = 0;
  for (const dir of ancestorsOf(abs)) {
    // Within one directory, CLAUDE.local.md is appended after CLAUDE.md.
    if (recordIfPresent(ctx, path.join(dir, 'CLAUDE.md'), 'ancestor', { chainScope: 'ancestor' })) ancestorCount++;
    if (recordIfPresent(ctx, path.join(dir, 'CLAUDE.local.md'), 'ancestor', { chainScope: 'ancestor' })) ancestorCount++;
  }

  /* 4 · the project's own memory. */
  const projectMd = path.join(abs, 'CLAUDE.md');
  const dotClaudeMd = path.join(abs, '.claude', 'CLAUDE.md');
  const hasProjectMd = fs.existsSync(projectMd);
  const hasDotClaudeMd = fs.existsSync(dotClaudeMd);
  const both = hasProjectMd && hasDotClaudeMd;
  const bothWarning = both
    ? ['Both ./CLAUDE.md and ./.claude/CLAUDE.md exist. Only one of them fills the project slot and the docs do not say which — delete one, or check the InstructionsLoaded hook after a launch to see which actually loaded.']
    : [];
  // Exactly one of the pair loads, so exactly one may be counted; summing both
  // would report a launch budget no session ever pays. Which one wins is not
  // documented, so the larger is the one counted — the headline is then an
  // upper bound rather than a number that can be too low. The loser stays
  // listed, but is inert: expanding its imports would count them too.
  const sizeOf = (p: string): number => { try { return fs.statSync(p).size; } catch { return 0; } };
  const loser = both ? (sizeOf(dotClaudeMd) >= sizeOf(projectMd) ? projectMd : dotClaudeMd) : null;
  const uncounted = (p: string): string[] => p === loser
    ? [...bothWarning, `Not counted in the launch totals: at most one of the pair loads, and the larger one (${path.relative(abs, loser === projectMd ? dotClaudeMd : projectMd)}) is the one counted, so the total is not overstated. Its imports are not listed here either.`]
    : bothWarning;
  recordIfPresent(ctx, projectMd, 'project', {
    chainScope: 'project',
    warnings: uncounted(projectMd),
    duplicate: loser === projectMd,
    inert: loser === projectMd,
  });
  recordIfPresent(ctx, dotClaudeMd, 'project', {
    chainScope: 'project',
    warnings: uncounted(dotClaudeMd),
    duplicate: loser === dotClaudeMd,
    inert: loser === dotClaudeMd,
  });

  addRules(path.join(abs, '.claude', 'rules'), 'project');

  recordIfPresent(ctx, path.join(abs, 'CLAUDE.local.md'), 'local', { chainScope: 'local' });

  if (!hasProjectMd && !hasDotClaudeMd) {
    notes.push('This project has no CLAUDE.md of its own. Sessions launch with whatever is above it and nothing project-specific.');
  }

  /* 5 · on-demand: path-scoped rules, then subdirectory memory files. */
  for (const rule of conditionalRules) {
    const matchers = rule.globs.map((g) => ({ glob: g, ...globMatcher(g) }));
    const files = projectFiles();
    let matching = 0;
    for (const rel of files.files) {
      const absFile = path.join(abs, rel);
      if (matchers.some((m) => m.test(rel) || m.test(absFile))) matching++;
    }
    const warnings: string[] = [];
    for (const m of matchers) {
      if (m.overBudget) {
        warnings.push(`Glob ${shortGlob(m.glob)} expands past the 1,000-pattern brace budget, so it is used unexpanded and matches nothing.`);
      }
      if (m.invalid) {
        warnings.push(`Glob ${shortGlob(m.glob)} has a "[" that never closes, so it is not a valid bracket expression and matches nothing at all.`);
      }
    }
    if (matching === 0) {
      warnings.push(`No file in this project matches ${rule.globs.map(shortGlob).join(', ')}, so this rule never loads. Check the glob against the paths that actually exist.`);
    }
    record(ctx, rule.file, 'rule', {
      chainScope: rule.chainScope,
      conditional: { kind: 'paths', globs: rule.globs, matchingFiles: matching },
      warnings,
    });
  }

  const walkResult = projectFiles();
  for (const rel of walkResult.files) {
    // The entry keeps its on-disk name; only the comparison is case-relaxed.
    const base = memoryBasename(path.basename(rel));
    if (!base) continue;
    const dir = path.dirname(rel);
    // The project's own files are already placed; only subdirectories are new.
    if (dir === '.' || dir === '' || dir === '.claude' || dir.startsWith('.claude' + path.sep)) continue;
    const prefix = dir + path.sep;
    const matching = walkResult.files.filter((f) => f !== rel && f.startsWith(prefix)).length;
    record(ctx, path.join(abs, rel), base === 'CLAUDE.local.md' ? 'local' : 'project', {
      chainScope: 'project',
      conditional: { kind: 'paths', globs: [`${dir}/**`], matchingFiles: matching },
      warnings: [`In a subdirectory, so it does not load at launch — it loads the first time Claude reads a file under ${dir}/.`],
    });
  }

  if (walkResult.truncated) {
    notes.push(`The project walk stopped at ${MAX_WALK_FILES.toLocaleString()} files, so "matching files" counts are a floor, not a total.`);
  }

  /* 6 · totals and the honest notes. */
  // `duplicate` is what keeps a file that is referenced twice — or the losing
  // half of the ./CLAUDE.md pair — from contributing its bytes twice to totals
  // the headline note presents as "what every session is handed".
  const loads = (f: InstructionFile) => f.exists && !f.excludedBy && !f.duplicate && f.bytes <= MAX_LOADED_BYTES;
  const atLaunch = ctx.files.filter((f) => loads(f) && !f.conditional);
  const onDemand = ctx.files.filter((f) => loads(f) && f.conditional);
  const totalBytes = atLaunch.reduce((n, f) => n + f.bytes, 0);
  const totalLines = atLaunch.reduce((n, f) => n + f.lines, 0);

  if (ancestorCount) {
    notes.push(`${ancestorCount} memory file(s) in directories ABOVE this project load before its own, oldest ancestor first. If that is not what you want, exclude them with claudeMdExcludes.`);
  }
  const excluded = ctx.files.filter((f) => f.excludedBy).length;
  if (excluded) notes.push(`${excluded} file(s) are removed by claudeMdExcludes and never reach the agent.`);
  const oversize = ctx.files.filter((f) => f.exists && f.bytes > MAX_LOADED_BYTES).length;
  if (oversize) notes.push(`${oversize} file(s) are over the 4 MiB ceiling and are skipped whole — not truncated.`);

  const agents = agentsMdStatus(abs);
  if (agents.present) notes.push(agents.note);

  notes.push(`Every session in this project starts with ${atLaunch.length} instruction file(s), ${fmtBytes(totalBytes)} and ${totalLines.toLocaleString()} lines, before anyone types a word.`);
  notes.push('Where rules interleave with memory files is not documented precisely; the order here puts user rules after user memory and project rules at the project memory position.');
  notes.push('This is a static prediction from disk. The InstructionsLoaded hook reports what a launch actually loaded — that is the ground truth to reconcile against.');

  const gitRoot = gitRootOf(abs);
  const value: InstructionChain = {
    files: ctx.files,
    totalBytes,
    totalLines,
    atLaunch,
    onDemand,
    // A layer read twice (managed settings supply both excludes and inline
    // instruction text) must not say the same thing twice.
    notes: [...new Set(notes)],
    root: gitRoot ?? abs,
    isGitRepo: gitRoot !== null,
  };

  // Bounded, so switching between many projects cannot grow this without end.
  if (cache.size > 24) cache.clear();
  cache.set(abs, { at: Date.now(), value });
  markServable(ctx.files.map((f) => f.path));
  return value;
}
