/**
 * Maintainability drift per checkpoint — heuristic, and labelled as such.
 *
 * Tests say whether the change works this afternoon. What they do not say is
 * whether the code got harder to change, which is the cost a reviewer across
 * many repositories otherwise meets months later ("there is no penalty for
 * eroding codebase maintainability", a-claude-articles.md §1.12; SlopCodeBench
 * measures the same three things with deterministic tools and no model).
 *
 * Three separate observed numbers for the files a session changed, and no
 * score, grade or roll-up of them:
 *   · lines of code added and removed, excluding blank and comment-only lines;
 *   · the longest function before and after, by a brace heuristic for
 *     JS/TS/Go/Java/C#/Rust/PHP and by indentation for Python;
 *   · duplicated blocks: the same normalised six-line window appearing twice or
 *     more across the changed files after the change, when it did not before.
 *
 * Every one of these is a heuristic and the surface says so. The tokenizer
 * knows strings, line comments and block comments, not templates, regex
 * literals or heredocs; a function is a header line followed by a balanced
 * brace block, not a parse tree. The numbers are good enough to notice "this
 * turn made a 300-line function" and not good enough to argue about one line.
 */

export type LangFamily = 'brace' | 'python';

export type LangSpec = {
  id: string;
  family: LangFamily;
  line: string[];
  block: [string, string] | null;
  quotes: string[];
};

const JS: LangSpec = { id: 'js', family: 'brace', line: ['//'], block: ['/*', '*/'], quotes: ['"', "'", '`'] };
const C_LIKE = (id: string, quotes: string[] = ['"', "'"]): LangSpec => ({ id, family: 'brace', line: ['//'], block: ['/*', '*/'], quotes });
const PHP: LangSpec = { id: 'php', family: 'brace', line: ['//', '#'], block: ['/*', '*/'], quotes: ['"', "'"] };
const PY: LangSpec = { id: 'python', family: 'python', line: ['#'], block: null, quotes: ['"', "'"] };

const BY_EXTENSION: Record<string, LangSpec> = {
  js: JS, jsx: JS, mjs: JS, cjs: JS, ts: JS, tsx: JS, mts: JS, cts: JS,
  go: C_LIKE('go', ['"', "'", '`']), java: C_LIKE('java'), cs: C_LIKE('csharp'), rs: C_LIKE('rust', ['"']),
  php: PHP, module: PHP, inc: PHP, install: PHP, theme: PHP,
  py: PY,
};

/** The language rules for a path, or null when none of the heuristics apply to it. */
export function languageOf(path: string): LangSpec | null {
  const m = /\.([A-Za-z0-9]+)$/.exec(path);
  return m ? BY_EXTENSION[m[1].toLowerCase()] ?? null : null;
}

export type LineKind = 'blank' | 'comment' | 'code';

/**
 * Classify every line, and return each line with strings and comments blanked
 * out, so the function finder counts only braces that are code. A string is
 * replaced by empty quotes rather than removed, so a line holding only a
 * string literal still reads as code.
 */
export function scanLines(text: string, lang: LangSpec): { kinds: LineKind[]; code: string[] } {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const kinds: LineKind[] = [];
  const code: string[] = [];
  let inBlock = false;
  let inString: string | null = null;
  for (const line of lines) {
    let out = '';
    let sawCode = false;
    let sawComment = inBlock;
    const startedInString = inString !== null;
    let i = 0;
    while (i < line.length) {
      if (inBlock) {
        const end = lang.block ? line.indexOf(lang.block[1], i) : -1;
        if (end < 0) { i = line.length; break; }
        inBlock = false;
        i = end + (lang.block ? lang.block[1].length : 0);
        continue;
      }
      if (inString) {
        const ch = line[i];
        if (ch === '\\') { i += 2; continue; }
        if (line.startsWith(inString, i)) { out += inString; i += inString.length; inString = null; continue; }
        i++;
        continue;
      }
      if (lang.block && line.startsWith(lang.block[0], i)) { sawComment = true; inBlock = true; i += lang.block[0].length; continue; }
      if (lang.line.some((mark) => line.startsWith(mark, i))) { sawComment = true; break; }
      const triple = lang.family === 'python' && (line.startsWith('"""', i) || line.startsWith("'''", i)) ? line.slice(i, i + 3) : null;
      if (triple) { sawCode = true; out += triple; inString = triple; i += 3; continue; }
      const ch = line[i];
      if (lang.quotes.includes(ch)) {
        // A Rust lifetime ('a) and a Go rune are not strings that run to the
        // end of the line; a single quote only opens one when it closes nearby.
        if (ch === "'" && lang.id === 'rust' && !/^'(?:\\.|[^'\\])'/.test(line.slice(i))) { out += ch; sawCode = true; i++; continue; }
        sawCode = true;
        out += ch;
        inString = ch;
        i++;
        continue;
      }
      if (!/\s/.test(ch)) sawCode = true;
      out += ch;
      i++;
    }
    // A plain quote does not carry over a line end in these languages; a
    // template literal, a Go raw string and a Python triple quote do.
    if (inString && inString !== '`' && inString.length !== 3) inString = null;
    code.push(out);
    // The inside of a multi-line string is code: it is part of a statement.
    kinds.push(sawCode || (startedInString && line.trim()) ? 'code' : sawComment ? 'comment' : 'blank');
  }
  return { kinds, code };
}

/* ── lines of code ───────────────────────────────────────────────────── */

export type Hunk = { oldStart: number; oldLines: number; newStart: number; newLines: number };

/** Hunk headers out of `git diff -U0` for one file. Context-free, so the ranges are exactly the changed lines. */
export function parseHunks(patch: string): Hunk[] {
  const out: Hunk[] = [];
  for (const m of patch.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    out.push({ oldStart: Number(m[1]), oldLines: m[2] === undefined ? 1 : Number(m[2]), newStart: Number(m[3]), newLines: m[4] === undefined ? 1 : Number(m[4]) });
  }
  return out;
}

/** Code lines added and removed by a file's hunks, read against the full text on each side. */
export function codeLineDelta(hunks: readonly Hunk[], before: readonly LineKind[], after: readonly LineKind[]): { added: number; removed: number } {
  let added = 0; let removed = 0;
  for (const h of hunks) {
    for (let n = 0; n < h.oldLines; n++) if (before[h.oldStart - 1 + n] === 'code') removed++;
    for (let n = 0; n < h.newLines; n++) if (after[h.newStart - 1 + n] === 'code') added++;
  }
  return { added, removed };
}

/* ── the longest function ────────────────────────────────────────────── */

export type FunctionSpan = { name: string; line: number; lines: number };

const NOT_A_FUNCTION = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'return', 'foreach', 'elseif', 'using', 'lock', 'fixed', 'match', 'loop', 'unsafe', 'sizeof', 'typeof', 'new', 'else', 'do', 'try', 'finally', 'synchronized', 'select', 'defer', 'go']);
const TYPE_OPENER = /^\s*(?:export\s+)?(?:default\s+)?(?:public\s+|private\s+|protected\s+|internal\s+|abstract\s+|final\s+|static\s+|sealed\s+|partial\s+|readonly\s+)*(?:class|interface|enum|struct|impl|trait|namespace|module|object|record|type)\b/;

/** The name a brace-language header line declares a function under, or null when it declares none. */
function braceHeader(code: string): string | null {
  if (TYPE_OPENER.test(code)) return null;
  const fn = /\b(?:function\s*\*?\s*([A-Za-z_$][\w$]*)?|func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)|fn\s+([A-Za-z_]\w*))/.exec(code);
  if (fn) return fn[1] ?? fn[2] ?? fn[3] ?? '(anonymous)';
  const arrow = /(?:\b(?:const|let|var)\s+|^\s*)([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::\s*[^=]+)?=>\s*\{?\s*$/.exec(code);
  if (arrow) return arrow[1];
  const method = /([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^;]*\)\s*(?::\s*[^{;=]+|->\s*[^{;]+|throws\s+[\w.,\s]+)?\s*\{?\s*$/.exec(code);
  if (method && !NOT_A_FUNCTION.has(method[1].toLowerCase())) {
    const before = code.slice(0, method.index).trim();
    // `foo(bar)` on its own line is a call; a declaration has something in
    // front of the name (a modifier, a return type) or ends by opening a block.
    if (/[=.(,]$/.test(before) || /\bnew$/.test(before)) return null;
    if (!before && !/\{\s*$/.test(code)) return null;
    return method[1];
  }
  return null;
}

function longestBrace(code: readonly string[], kinds: readonly LineKind[]): FunctionSpan | null {
  let best: FunctionSpan | null = null;
  for (let i = 0; i < code.length; i++) {
    if (kinds[i] !== 'code') continue;
    const name = braceHeader(code[i]);
    if (!name) continue;
    // The block must open on the header line or within the next two code lines.
    let open = -1;
    for (let j = i; j < Math.min(code.length, i + 3); j++) {
      const at = code[j].indexOf('{', j === i ? Math.max(0, code[i].search(/\)|=>|\bfunction\b|\bfunc\b|\bfn\b/)) : 0);
      if (at >= 0) { open = j; break; }
      if (j > i && /[;}]\s*$/.test(code[j])) break;
    }
    if (open < 0) continue;
    let depth = 0;
    let started = false;
    let end = -1;
    for (let j = open; j < code.length && end < 0; j++) {
      for (const ch of code[j]) {
        if (ch === '{') { depth++; started = true; }
        else if (ch === '}') {
          depth--;
          if (started && depth === 0) { end = j; break; }
        }
      }
    }
    if (end < 0) continue;
    const span = { name, line: i + 1, lines: end - i + 1 };
    if (!best || span.lines > best.lines) best = span;
  }
  return best;
}

function longestPython(text: string, kinds: readonly LineKind[]): FunctionSpan | null {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const indent = (s: string) => (/^[ \t]*/.exec(s)?.[0] ?? '').replace(/\t/g, '    ').length;
  let best: FunctionSpan | null = null;
  for (let i = 0; i < lines.length; i++) {
    const m = /^([ \t]*)(?:async\s+)?def\s+([A-Za-z_]\w*)/.exec(lines[i]);
    if (!m || kinds[i] !== 'code') continue;
    const own = indent(lines[i]);
    let last = i;
    for (let j = i + 1; j < lines.length; j++) {
      if (kinds[j] === 'blank' || !lines[j].trim()) continue;
      // A comment at the def's own indent or less still sits inside a body
      // that continues after it; only code decides where the body ends.
      if (kinds[j] === 'comment') continue;
      if (indent(lines[j]) <= own) break;
      last = j;
    }
    const span = { name: m[2], line: i + 1, lines: last - i + 1 };
    if (!best || span.lines > best.lines) best = span;
  }
  return best;
}

export function longestFunction(text: string, lang: LangSpec): FunctionSpan | null {
  const { kinds, code } = scanLines(text, lang);
  return lang.family === 'python' ? longestPython(text, kinds) : longestBrace(code, kinds);
}

/* ── duplicated blocks ───────────────────────────────────────────────── */

export const WINDOW = 6;
/** A window of closing braces and `return;` is not duplication worth naming. */
const MIN_WINDOW_WORD_CHARS = 24;

type Occurrence = { path: string; line: number };

function windowsOf(path: string, text: string, lang: LangSpec): { key: string; at: Occurrence; ordinal: number }[] {
  const raw = text.replace(/\r\n?/g, '\n').split('\n');
  const { kinds } = scanLines(text, lang);
  const lines: { text: string; line: number }[] = [];
  raw.forEach((line, i) => { if (kinds[i] === 'code') lines.push({ text: line.trim().replace(/\s+/g, ' '), line: i + 1 }); });
  const out: { key: string; at: Occurrence; ordinal: number }[] = [];
  for (let i = 0; i + WINDOW <= lines.length; i++) {
    const slice = lines.slice(i, i + WINDOW);
    const key = slice.map((l) => l.text).join('\n');
    if ((key.match(/\w/g) ?? []).length < MIN_WINDOW_WORD_CHARS) continue;
    out.push({ key, at: { path, line: slice[0].line }, ordinal: i });
  }
  return out;
}

export type DuplicateBlock = { lines: number; occurrences: Occurrence[]; preview: string };

/**
 * Blocks that became duplicated: windows present twice or more across the
 * after-texts and fewer than twice across the before-texts of the same files.
 * Overlapping windows in one run are one block, so a twelve-line copy is one
 * block of twelve lines rather than seven windows.
 */
export function newDuplicates(files: readonly { path: string; before: string | null; after: string | null }[]): DuplicateBlock[] {
  const beforeCount = new Map<string, number>();
  const afterHits = new Map<string, { at: Occurrence; ordinal: number }[]>();
  for (const f of files) {
    const lang = languageOf(f.path);
    if (!lang) continue;
    if (f.before) for (const w of windowsOf(f.path, f.before, lang)) beforeCount.set(w.key, (beforeCount.get(w.key) ?? 0) + 1);
    if (f.after) for (const w of windowsOf(f.path, f.after, lang)) {
      const list = afterHits.get(w.key) ?? [];
      list.push({ at: w.at, ordinal: w.ordinal });
      afterHits.set(w.key, list);
    }
  }
  const fresh = [...afterHits.entries()].filter(([key, hits]) => hits.length >= 2 && (beforeCount.get(key) ?? 0) < 2);
  // Merge runs: a window whose first occurrence directly follows the previous
  // fresh window's first occurrence (same file, next ordinal) extends it.
  const byFirst = fresh.map(([key, hits]) => ({ key, hits, first: hits[0] }))
    .sort((a, b) => (a.first.at.path === b.first.at.path ? a.first.ordinal - b.first.ordinal : a.first.at.path < b.first.at.path ? -1 : 1));
  const blocks: DuplicateBlock[] = [];
  let current: { path: string; ordinal: number; block: DuplicateBlock } | null = null;
  for (const w of byFirst) {
    if (current && current.path === w.first.at.path && current.ordinal + 1 === w.first.ordinal) {
      current.block.lines++;
      current.ordinal = w.first.ordinal;
      continue;
    }
    const block: DuplicateBlock = { lines: WINDOW, occurrences: w.hits.map((h) => h.at), preview: w.key.split('\n')[0].slice(0, 120) };
    blocks.push(block);
    current = { path: w.first.at.path, ordinal: w.first.ordinal, block };
  }
  return blocks;
}

/* ── the report ──────────────────────────────────────────────────────── */

export type DriftFile = { path: string; before: string | null; after: string | null; hunks: Hunk[] };

export type DriftReport = {
  analysed: number;
  skipped: { path: string; reason: string }[];
  codeAdded: number;
  codeRemoved: number;
  longestBefore: (FunctionSpan & { path: string }) | null;
  longestAfter: (FunctionSpan & { path: string }) | null;
  duplicatedBlocks: DuplicateBlock[];
};

export function driftFor(files: readonly DriftFile[], skipped: { path: string; reason: string }[] = []): DriftReport {
  const out: DriftReport = { analysed: 0, skipped: [...skipped], codeAdded: 0, codeRemoved: 0, longestBefore: null, longestAfter: null, duplicatedBlocks: [] };
  const analysed: DriftFile[] = [];
  for (const f of files) {
    const lang = languageOf(f.path);
    if (!lang) { out.skipped.push({ path: f.path, reason: 'no heuristic for this language' }); continue; }
    analysed.push(f);
    const before = f.before ? scanLines(f.before, lang).kinds : [];
    const after = f.after ? scanLines(f.after, lang).kinds : [];
    const delta = codeLineDelta(f.hunks, before, after);
    out.codeAdded += delta.added;
    out.codeRemoved += delta.removed;
    const lb = f.before ? longestFunction(f.before, lang) : null;
    const la = f.after ? longestFunction(f.after, lang) : null;
    if (lb && (!out.longestBefore || lb.lines > out.longestBefore.lines)) out.longestBefore = { ...lb, path: f.path };
    if (la && (!out.longestAfter || la.lines > out.longestAfter.lines)) out.longestAfter = { ...la, path: f.path };
  }
  out.analysed = analysed.length;
  out.duplicatedBlocks = newDuplicates(analysed);
  return out;
}

/** One session's drift, as the review area reads it. */
export type MaintainabilityView = {
  state: 'ready' | 'no-checkpoints' | 'unchanged' | 'unreadable';
  detail: string | null;
  base: string | null;
  latest: string | null;
  latestTurn: number | null;
  latestAt: number | null;
  changedFiles: number;
  report: DriftReport | null;
};
