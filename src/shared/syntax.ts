// Syntax colour for diff lines, with no dependency: a small tokenizer that reads
// one line at a time, for what the owner's projects hold (PHP, JavaScript and
// TypeScript with JSX, CSS and SCSS, YAML, JSON, Twig, HTML, Markdown, shell).
// It knows comments, strings, keywords, numbers, variables, types, tags,
// attributes and punctuation, and carries what spans lines (a block comment,
// a multi-line string, a tag whose attributes wrap, a YAML block) from one
// line to the next.
//
// Best effort by design. A wrong colour is acceptable; a crash or a hang is
// not. So every loop consumes at least one character per turn, nothing
// backtracks, and a line past MAX_LINE is left plain. Pure, so it is tested.

export type Lang = 'php' | 'jsx' | 'ts' | 'css' | 'scss' | 'yaml' | 'json' | 'twig' | 'html' | 'markdown' | 'shell';
export type TokenKind = 'comment' | 'string' | 'keyword' | 'number' | 'variable' | 'type' | 'tag' | 'attr' | 'punct';
/** A coloured stretch of a line, [start, end), and what it is. Gaps are plain text. */
export type Span = [start: number, end: number, kind: TokenKind];

/** What a line starts inside of, carried from the line before. */
export interface State {
  readonly in: 'code' | 'comment' | 'string' | 'tag' | 'twig' | 'value' | 'heredoc' | 'scalar' | 'fence';
  /** The closing delimiter: `*\/`, `-->`, a quote, `}}`, a heredoc's name, a fence. */
  readonly close: string;
  /** What else the mode needs: a YAML block's indent; 1 when a Twig expression or a string sits inside a tag. */
  readonly n: number;
}

export const START: State = Object.freeze({ in: 'code', close: '', n: 0 });
/** Longer lines (minified code, a lock file) are left plain. */
export const MAX_LINE = 1000;

type Add = (start: number, end: number, kind: TokenKind) => void;
type Tokenizer = (text: string, state: State, add: Add) => State;

const at = (mode: State['in'], close = '', n = 0): State => ({ in: mode, close, n });

const EXTENSIONS: Record<string, Lang> = {
  php: 'php', module: 'php', inc: 'php', install: 'php', theme: 'php', profile: 'php', engine: 'php',
  js: 'jsx', mjs: 'jsx', cjs: 'jsx', jsx: 'jsx', tsx: 'jsx', ts: 'ts', mts: 'ts', cts: 'ts',
  css: 'css', scss: 'scss', sass: 'scss', less: 'scss',
  yml: 'yaml', yaml: 'yaml', json: 'json', jsonc: 'json', lock: 'json',
  twig: 'twig', html: 'html', htm: 'html', xml: 'html', svg: 'html',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  sh: 'shell', bash: 'shell', zsh: 'shell',
};

/** The language to colour a file as, from its name; null for anything else, which stays plain. */
export function languageFor(path: string): Lang | null {
  const name = (path.split('/').pop() ?? '').toLowerCase();
  if (name === '.env' || name.startsWith('.env.') || name === '.bashrc' || name === '.zshrc') return 'shell';
  if (name.endsWith('.lock') && name !== 'composer.lock') return null; // yarn.lock and friends are not JSON
  const dot = name.lastIndexOf('.');
  return dot > 0 ? EXTENSIONS[name.slice(dot + 1)] ?? null : null;
}

/** One line's colours, and the state the next line starts in. */
export function tokenizeLine(lang: Lang, text: string, state: State = START): { spans: Span[]; state: State } {
  if (text.length > MAX_LINE) return { spans: [], state };
  const spans: Span[] = [];
  const add: Add = (start, end, kind) => {
    if (end <= start) return;
    const last = spans[spans.length - 1];
    if (last && last[1] === start && last[2] === kind) last[1] = end;
    else spans.push([start, end, kind]);
  };
  return { spans, state: TOKENIZERS[lang](text, state, add) };
}

/** How far into a hunk to look for where its first line stands. */
const HUNK_LOOKAHEAD = 30;

/**
 * A guess at where a diff hunk starts, from its opening lines: git shows three
 * lines of context, which often begin inside a doc comment. A comment's close
 * met before any opener means the hunk began inside one.
 */
export function hunkState(lang: Lang, lines: readonly string[]): State {
  const clike = lang === 'php' || lang === 'jsx' || lang === 'ts' || lang === 'css' || lang === 'scss';
  const markup = lang === 'html' || lang === 'twig' || lang === 'markdown';
  for (const line of lines.slice(0, HUNK_LOOKAHEAD)) {
    const t = line.trim();
    if (clike) {
      if (t.includes('/*')) return START;
      // " * text" or " */": the middle or end of a doc comment (in CSS, not `* { … }`).
      const selector = (lang === 'css' || lang === 'scss') && /[{};]/.test(t);
      if (t.includes('*/') || (t.startsWith('*') && !selector)) return at('comment', '*/');
    }
    if (markup) {
      if (t.includes('<!--') || (lang === 'twig' && t.includes('{#'))) return START;
      if (t.includes('-->')) return at('comment', '-->');
      if (lang === 'twig' && t.includes('#}')) return at('comment', '#}');
    }
  }
  return START;
}

/* ── shared pieces ─────────────────────────────────────────────────────── */

/** The index after the closing quote, or -1 when the line ends first. */
function closeQuote(text: string, from: number, quote: string, escapes = true): number {
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (escapes && c === '\\') i++;
    else if (c === quote) return i + 1;
  }
  return -1;
}

function sticky(re: RegExp, text: string, i: number): string | null {
  re.lastIndex = i;
  const m = re.exec(text);
  return m ? m[0] : null;
}

const SPACE = /[ \t\f\r]/;
const DIGIT = /[0-9]/;
const WORD = /[A-Za-z_À-￿][\wÀ-￿]*/y;
const JS_WORD = /[A-Za-z_$À-￿][\w$À-￿]*/y;
const NUMBER = /0[xXbBoO][\da-fA-F_]+n?|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?n?|\.\d[\d_]*(?:[eE][+-]?\d+)?/y;
const TYPE_NAME = /^[A-Z][A-Za-z0-9_]*[a-z][A-Za-z0-9_]*$/;
const CONSTANT_NAME = /^[A-Z][A-Z0-9_]+$/;

/** A block comment from `i` (its opener already counted), to its close or the line's end. */
function blockComment(text: string, i: number, close: string, add: Add, back: State): { i: number; st: State } {
  const end = text.indexOf(close, i);
  const stop = end < 0 ? text.length : end + close.length;
  add(i, stop, 'comment');
  return { i: stop, st: end < 0 ? at('comment', close, back.n) : back };
}

/**
 * The index of the `}` that closes the `{` just before `from`, on this line, or
 * -1. Strings are skipped, so a brace inside one does not count.
 */
function matchBrace(text: string, from: number): number {
  let depth = 1;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      const end = closeQuote(text, i + 1, c);
      if (end < 0) return -1;
      i = end - 1;
    } else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return -1;
}

const words = (s: string): ReadonlySet<string> => new Set(s.split(/\s+/).filter(Boolean));

/* ── C-like: JavaScript, TypeScript, JSX, PHP ──────────────────────────── */

interface CLike {
  keywords: ReadonlySet<string>;
  constants: ReadonlySet<string>;
  /** Keywords after which a value follows, as after a name: `/` divides and `<` compares. */
  values: ReadonlySet<string>;
  word: RegExp;
  /** Quotes that may run on to the next line. */
  multiline: string;
  php: boolean;
  jsx: boolean;
  regex: boolean;
  /** Keywords compared without case (PHP's TRUE, NULL, Array). */
  fold: boolean;
}

const JS_KEYWORDS = 'break case catch class const continue debugger default delete do else export extends finally for from function if import in instanceof let new of return static super switch this throw try typeof var void while with yield async await as';
const TS_KEYWORDS = 'interface enum implements namespace readonly private protected public abstract keyof satisfies override string number boolean any unknown never object symbol bigint';
const JS: CLike = {
  keywords: words(`${JS_KEYWORDS} ${TS_KEYWORDS}`), constants: words('true false null undefined NaN Infinity'), values: words('this super'),
  word: JS_WORD, multiline: '`', php: false, jsx: true, regex: true, fold: false,
};
/** TypeScript without JSX, where `<` opens a type argument, never a tag. */
const TS: CLike = { ...JS, jsx: false };
const PHP: CLike = {
  keywords: words(`abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty
    enddeclare endfor endforeach endif endswitch endwhile enum extends final finally fn for foreach function global goto if implements
    include include_once instanceof insteadof interface isset list match namespace new or print private protected public readonly
    require require_once return static switch throw trait try unset use var while xor yield self parent int float bool string void
    mixed never object iterable`),
  constants: words('true false null'), values: words('self parent static'),
  word: WORD, multiline: '\'"', php: true, jsx: false, regex: false, fold: true,
};

function clike(cfg: CLike, text: string, state: State, add: Add, depth = 0): State {
  const n = text.length;
  let i = 0;
  let st = state;
  let prev: 'value' | 'op' = 'op';
  let dot = false;
  // Code inside `{…}` or `${…}`, coloured as code with the same rules.
  const inner = (from: number, to: number): void => {
    if (depth > 3) { add(from, to, 'punct'); return; }
    clike(cfg, text.slice(from, to), START, (s, e, k) => add(s + from, e + from, k), depth + 1);
  };
  while (i < n) {
    const start = i;
    const c = text[i] as string;
    if (st.in === 'comment') {
      ({ i, st } = blockComment(text, i, st.close, add, START));
    } else if (st.in === 'heredoc') {
      const lead = n - text.trimStart().length;
      if (text.startsWith(st.close, lead) && !/\w/.test(text[lead + st.close.length] ?? '')) {
        add(0, lead + st.close.length, 'string');
        i = lead + st.close.length;
        st = START;
      } else {
        add(0, n, 'string');
        i = n;
      }
    } else if (st.in === 'string') {
      ({ i, st } = clikeString(cfg, text, i, st.close, add, inner));
      prev = 'value';
    } else if (st.in === 'tag') {
      // Inside a JSX tag: attributes, until > or />.
      if (SPACE.test(c)) i++;
      else if (text.startsWith('/>', i)) { add(i, i + 2, 'punct'); i += 2; st = START; prev = 'value'; }
      else if (c === '>') { add(i, i + 1, 'punct'); i++; st = START; prev = 'op'; }
      else if (c === '{') {
        const end = matchBrace(text, i + 1);
        add(i, i + 1, 'punct');
        if (end < 0) { i++; st = START; } // runs on past the line: carry on as code
        else { inner(i + 1, end); add(end, end + 1, 'punct'); i = end + 1; }
      } else if (c === '"' || c === "'") {
        const end = closeQuote(text, i + 1, c, false);
        add(i, end < 0 ? n : end, 'string');
        i = end < 0 ? n : end;
      } else {
        const name = sticky(/[A-Za-z_$][\w$:.-]*/y, text, i);
        if (name) { add(i, i + name.length, 'attr'); i += name.length; }
        else { add(i, i + 1, 'punct'); i++; }
      }
    } else if (SPACE.test(c)) {
      i++;
    } else if (c === '/' && text[i + 1] === '*') {
      add(i, i + 2, 'comment');
      ({ i, st } = blockComment(text, i + 2, '*/', add, START));
    } else if ((c === '/' && text[i + 1] === '/') || (cfg.php && c === '#' && text[i + 1] !== '[')) {
      add(i, n, 'comment');
      i = n;
    } else if (c === '"' || c === "'" || c === '`') {
      add(i, i + 1, 'string');
      ({ i, st } = clikeString(cfg, text, i + 1, c, add, inner));
      prev = 'value';
      dot = false;
    } else if (cfg.php && c === '$' && /[A-Za-z_$]/.test(text[i + 1] ?? '')) {
      const name = sticky(/\$+[A-Za-z_À-￿][\wÀ-￿]*/y, text, i) ?? '$';
      add(i, i + name.length, 'variable');
      i += name.length;
      prev = 'value';
      dot = false;
    } else if (cfg.php && text.startsWith('<<<', i)) {
      const m = /<<<\s*(['"]?)([A-Za-z_]\w*)\1/y;
      m.lastIndex = i;
      const found = m.exec(text);
      if (found) { add(i, n, 'string'); i = n; st = at('heredoc', found[2] as string); }
      else { add(i, i + 3, 'punct'); i += 3; }
    } else if (cfg.php && (text.startsWith('<?php', i) || text.startsWith('<?=', i) || text.startsWith('?>', i))) {
      const len = text.startsWith('<?php', i) ? 5 : 3 - Number(c === '?');
      add(i, i + len, 'tag');
      i += len;
    } else if (DIGIT.test(c) || (c === '.' && DIGIT.test(text[i + 1] ?? ''))) {
      const num = sticky(NUMBER, text, i) ?? c;
      add(i, i + num.length, 'number');
      i += num.length;
      prev = 'value';
    } else if (cfg.regex && c === '/' && prev === 'op') {
      const end = regexEnd(text, i + 1);
      if (end < 0) { add(i, i + 1, 'punct'); i++; }
      else {
        const flags = sticky(/[a-z]*/y, text, end) ?? '';
        add(i, end + flags.length, 'string');
        i = end + flags.length;
        prev = 'value';
      }
    } else if (cfg.jsx && c === '<' && prev === 'op' && /[A-Za-z>/]/.test(text[i + 1] ?? '')) {
      const open = text[i + 1] === '/' ? 2 : 1;
      const name = sticky(/[A-Za-z][\w.:-]*/y, text, i + open) ?? '';
      if (name || text[i + open] === '>') {
        add(i, i + open, 'punct');
        add(i + open, i + open + name.length, 'tag');
        i += open + name.length;
        st = at('tag');
      } else { add(i, i + 1, 'punct'); i++; }
    } else {
      const word = sticky(cfg.word, text, i);
      if (word) {
        const key = cfg.fold ? word.toLowerCase() : word;
        const kind: TokenKind | null = dot ? null
          : cfg.constants.has(key) ? 'number'
            : cfg.keywords.has(key) ? 'keyword'
              : !cfg.php && word === 'type' && /^\s+[A-Za-z_$]/.test(text.slice(i + 4, i + 6)) ? 'keyword'
                : CONSTANT_NAME.test(word) ? 'number'
                  : TYPE_NAME.test(word) ? 'type' : null;
        if (kind) add(i, i + word.length, kind);
        i += word.length;
        prev = kind === 'keyword' && !cfg.values.has(key) ? 'op' : 'value';
        dot = false;
      } else {
        const op = text.startsWith('->', i) || text.startsWith('?.', i) || text.startsWith('::', i) ? 2 : 1;
        add(i, i + op, 'punct');
        dot = op === 2 || c === '.';
        prev = c === ')' || c === ']' ? 'value' : 'op';
        i += op;
      }
    }
    if (i <= start) i = start + 1;
  }
  return st;
}

/** A string from `i` (after its opening quote): to the quote, or on to the next line if it may. */
function clikeString(cfg: CLike, text: string, i: number, quote: string, add: Add, inner: (from: number, to: number) => void): { i: number; st: State } {
  const n = text.length;
  if (quote === '`' && !cfg.php) {
    // A template: ${…} inside it is code.
    for (let j = i; j < n; j++) {
      const c = text[j];
      if (c === '\\') { j++; continue; }
      if (c === '`') { add(i, j + 1, 'string'); return { i: j + 1, st: START }; }
      if (c === '$' && text[j + 1] === '{') {
        add(i, j, 'string');
        add(j, j + 2, 'punct');
        const end = matchBrace(text, j + 2);
        if (end < 0) return { i: j + 2, st: START };
        inner(j + 2, end);
        add(end, end + 1, 'punct');
        i = end + 1;
        j = end;
      }
    }
    add(i, n, 'string');
    return { i: n, st: at('string', '`') };
  }
  const end = closeQuote(text, i, quote);
  if (end >= 0) { add(i, end, 'string'); return { i: end, st: START }; }
  add(i, n, 'string');
  // A line ending in a backslash continues a JavaScript string; PHP strings simply run on.
  return { i: n, st: cfg.multiline.includes(quote) || text.endsWith('\\') ? at('string', quote) : START };
}

/** Where a regular expression that starts after `from - 1` ends (after its closing slash), or -1. */
function regexEnd(text: string, from: number): number {
  if (text[from] === '/' || text[from] === '*' || SPACE.test(text[from] ?? ' ')) return -1;
  let klass = false;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') i++;
    else if (c === '[') klass = true;
    else if (c === ']') klass = false;
    else if (c === '/' && !klass) return i + 1;
  }
  return -1;
}

/* ── CSS and SCSS ──────────────────────────────────────────────────────── */

function css(scss: boolean, text: string, state: State, add: Add): State {
  const n = text.length;
  let i = 0;
  let st = state.in === 'value' ? START : state;
  // In a declaration's value (after `color:`), or an at-rule's prelude.
  let value = state.in === 'value';
  while (i < n) {
    const start = i;
    const c = text[i] as string;
    const next = text[i + 1] ?? '';
    if (st.in === 'comment') {
      ({ i, st } = blockComment(text, i, st.close, add, START));
    } else if (SPACE.test(c)) {
      i++;
    } else if (c === '/' && next === '*') {
      add(i, i + 2, 'comment');
      ({ i, st } = blockComment(text, i + 2, '*/', add, START));
    } else if (scss && c === '/' && next === '/') {
      add(i, n, 'comment');
      i = n;
    } else if (c === '"' || c === "'") {
      const end = closeQuote(text, i + 1, c);
      add(i, end < 0 ? n : end, 'string');
      i = end < 0 ? n : end;
    } else if (c === '{' || c === '}' || c === ';') {
      add(i, i + 1, 'punct');
      value = false;
      i++;
    } else if (c === '@') {
      const word = sticky(/@[\w-]+/y, text, i) ?? '@';
      add(i, i + word.length, 'keyword');
      i += word.length;
      value = true;
    } else if (c === '!') {
      const word = sticky(/![\w-]*/y, text, i) ?? '!';
      add(i, i + word.length, 'keyword');
      i += word.length;
    } else if ((scss && c === '$') || (c === '-' && next === '-')) {
      const name = sticky(/\$?[\w-]+/y, text, i) ?? c;
      add(i, i + name.length, 'variable');
      i += name.length;
      if (!value && /^\s*:/.test(text.slice(i, i + 8))) value = true;
    } else if (c === '#' && next === '{') {
      add(i, i + 2, 'punct');
      i += 2;
    } else if (c === '#') {
      const name = sticky(/#[\w-]+/y, text, i) ?? '#';
      add(i, i + name.length, value ? 'number' : 'tag');
      i += name.length;
    } else if (value && (DIGIT.test(c) || ((c === '.' || c === '-' || c === '+') && /[\d.]/.test(next)))) {
      const num = sticky(/[-+]?(?:\d*\.)?\d+(?:[a-zA-Z]+|%)?/y, text, i) ?? c;
      add(i, i + num.length, 'number');
      i += num.length;
    } else if (!value && (c === '.' || c === '%') && /[\w-]/.test(next)) {
      const name = sticky(/[.%][\w-]+/y, text, i) ?? c;
      add(i, i + name.length, 'tag');
      i += name.length;
    } else if (!value && c === ':') {
      const pseudo = sticky(/::?[\w-]+/y, text, i) ?? ':';
      add(i, i + pseudo.length, 'attr');
      i += pseudo.length;
    } else {
      const word = sticky(/[A-Za-z_À-￿][\wÀ-￿-]*/y, text, i);
      if (word) {
        const end = i + word.length;
        if (value) {
          if (word === 'url' && text[end] === '(') {
            const close = text.indexOf(')', end);
            add(end, end + 1, 'punct');
            add(end + 1, close < 0 ? n : close, 'string');
            i = close < 0 ? n : close;
          } else i = end;
        } else if (/^\s*:(?!:)/.test(text.slice(end, end + 8)) && !text.includes('{', end)) {
          add(i, end, 'attr'); // a property
          i = end;
          value = true;
        } else {
          add(i, end, 'tag'); // part of a selector
          i = end;
        }
      } else {
        add(i, i + 1, 'punct');
        i++;
      }
    }
    if (i <= start) i = start + 1;
  }
  return st.in === 'comment' ? st : value ? at('value') : START;
}

/* ── JSON ──────────────────────────────────────────────────────────────── */

function json(text: string, state: State, add: Add): State {
  const n = text.length;
  let i = 0;
  let st = state;
  while (i < n) {
    const start = i;
    const c = text[i] as string;
    if (st.in === 'comment') ({ i, st } = blockComment(text, i, st.close, add, START));
    else if (SPACE.test(c)) i++;
    else if (c === '/' && text[i + 1] === '/') { add(i, n, 'comment'); i = n; }
    else if (c === '/' && text[i + 1] === '*') { add(i, i + 2, 'comment'); ({ i, st } = blockComment(text, i + 2, '*/', add, START)); }
    else if (c === '"') {
      const end = closeQuote(text, i + 1, '"');
      const stop = end < 0 ? n : end;
      add(i, stop, /^\s*:/.test(text.slice(stop, stop + 8)) ? 'attr' : 'string');
      i = stop;
    } else if (c === '-' || DIGIT.test(c)) {
      const num = sticky(/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y, text, i) ?? c;
      add(i, i + num.length, num === '-' ? 'punct' : 'number');
      i += num.length;
    } else {
      const word = sticky(/[A-Za-z_]\w*/y, text, i);
      if (word) {
        if (word === 'true' || word === 'false' || word === 'null') add(i, i + word.length, 'number');
        i += word.length;
      } else { add(i, i + 1, 'punct'); i++; }
    }
    if (i <= start) i = start + 1;
  }
  return st;
}

/* ── YAML ──────────────────────────────────────────────────────────────── */

const YAML_CONSTANT = /^(?:true|false|yes|no|on|off|null|~|[-+]?(?:\d[\d_]*(?:\.\d*)?(?:[eE][-+]?\d+)?|\.inf|\.nan|0x[\da-fA-F]+|0o[0-7]+))$/i;

function yaml(text: string, state: State, add: Add): State {
  const n = text.length;
  const indent = n - text.trimStart().length;
  if (state.in === 'scalar') {
    // A block (`key: |`) goes on while lines are indented past its key.
    if (!text.trim()) return state;
    if (indent > state.n) { add(indent, n, 'string'); return state; }
  }
  let i = indent;
  if (/^(?:---|\.\.\.)(?:\s|$)/.test(text)) { add(0, 3, 'punct'); i = 3; }
  if (text[i] === '#') { add(i, n, 'comment'); return START; }
  while (text[i] === '-' && (i + 1 === n || SPACE.test(text[i + 1] as string))) {
    add(i, i + 1, 'punct');
    i++;
    while (SPACE.test(text[i] ?? '')) i++;
  }
  const colon = yamlKey(text, i);
  if (colon >= 0) {
    add(i, colon, 'attr');
    add(colon, colon + 1, 'punct');
    i = colon + 1;
  }
  return yamlValue(text, i, indent, add);
}

/** Where the colon after a mapping key starting at `i` is, or -1. */
function yamlKey(text: string, i: number): number {
  const c = text[i];
  if (!c || '{[&*!|>%@`#,?'.includes(c)) return -1;
  let j = i;
  if (c === '"' || c === "'") {
    j = closeQuote(text, i + 1, c, c === '"');
    if (j < 0) return -1;
    while (SPACE.test(text[j] ?? '')) j++;
  }
  for (; j < text.length; j++) {
    const d = text[j];
    if (d === ':' && (j + 1 === text.length || SPACE.test(text[j + 1] as string))) return j;
    if (d === '#' && SPACE.test(text[j - 1] ?? '')) return -1;
  }
  return -1;
}

function yamlValue(text: string, i: number, indent: number, add: Add): State {
  const n = text.length;
  let flow = 0;
  while (i < n) {
    const start = i;
    const c = text[i] as string;
    if (SPACE.test(c)) i++;
    else if (c === '#' && (i === 0 || SPACE.test(text[i - 1] as string))) { add(i, n, 'comment'); i = n; }
    else if (c === '"' || c === "'") {
      const end = closeQuote(text, i + 1, c, c === '"');
      add(i, end < 0 ? n : end, 'string');
      i = end < 0 ? n : end;
    } else if ('[]{},'.includes(c) && (flow > 0 || c === '[' || c === '{')) {
      add(i, i + 1, 'punct');
      flow += c === '[' || c === '{' ? 1 : c === ']' || c === '}' ? -1 : 0;
      i++;
    } else if ((c === '&' || c === '*') && /[\w-]/.test(text[i + 1] ?? '')) {
      const name = sticky(/[&*][\w-]+/y, text, i) ?? c;
      add(i, i + name.length, 'variable');
      i += name.length;
    } else if (c === '!') {
      const tag = sticky(/!+[\w/.:-]*/y, text, i) ?? c;
      add(i, i + tag.length, 'keyword');
      i += tag.length;
    } else if ((c === '|' || c === '>') && /^[|>][-+0-9]*\s*(?:#.*)?$/.test(text.slice(i))) {
      add(i, n, 'punct');
      return at('scalar', '', indent);
    } else {
      // A plain scalar: to a comment, or in [ ] or { } to the next separator or key's colon.
      let j = i;
      const key = (k: number): boolean => flow > 0 && text[k] === ':' && (k + 1 === n || SPACE.test(text[k + 1] as string));
      while (j < n && !(text[j] === '#' && SPACE.test(text[j - 1] ?? '')) && !(flow > 0 && ',[]{}'.includes(text[j] as string)) && !key(j)) j++;
      const word = text.slice(i, j).trimEnd();
      if (key(j)) { add(i, j, 'attr'); add(j, j + 1, 'punct'); i = j + 1; }
      else {
        add(i, i + word.length, YAML_CONSTANT.test(word) ? 'number' : 'string');
        i = i + Math.max(1, word.length);
      }
    }
    if (i <= start) i = start + 1;
  }
  return START;
}

/* ── HTML and Twig ─────────────────────────────────────────────────────── */

const TWIG_KEYWORDS = words('in is not and or b-and b-or b-xor matches starts ends with as only ignore missing defined empty same divisible by if else elseif endif for endfor');

function markup(twig: boolean, text: string, state: State, add: Add): State {
  const n = text.length;
  let i = 0;
  let st = state;
  const TAG = at('tag');
  while (i < n) {
    const start = i;
    const c = text[i] as string;
    if (st.in === 'comment') {
      ({ i, st } = blockComment(text, i, st.close, add, st.n ? TAG : START));
    } else if (st.in === 'twig') {
      const r = twigBody(text, i, st.close, false, add);
      i = r.i;
      if (r.closed) st = st.n ? TAG : START;
    } else if (st.in === 'string') {
      // An attribute value that runs over lines.
      const end = text.indexOf(st.close, i);
      add(i, end < 0 ? n : end + 1, 'string');
      i = end < 0 ? n : end + 1;
      if (end >= 0) st = TAG;
    } else if (twig && c === '{' && text[i + 1] === '#') {
      add(i, i + 2, 'comment');
      ({ i, st } = blockComment(text, i + 2, '#}', add, st.in === 'tag' ? TAG : START));
    } else if (twig && c === '{' && (text[i + 1] === '{' || text[i + 1] === '%')) {
      const close = text[i + 1] === '{' ? '}}' : '%}';
      const back = st.in === 'tag' ? 1 : 0;
      const r = twigBody(text, i, close, true, add);
      i = r.i;
      if (!r.closed) st = at('twig', close, back);
    } else if (st.in === 'tag') {
      if (SPACE.test(c)) i++;
      else if (text.startsWith('/>', i) || text.startsWith('?>', i)) { add(i, i + 2, 'punct'); i += 2; st = START; }
      else if (c === '>') { add(i, i + 1, 'punct'); i++; st = START; }
      else if (c === '"' || c === "'") {
        const end = text.indexOf(c, i + 1);
        const stop = end < 0 ? n : end + 1;
        if (twig) twigInString(text, i, stop, add);
        else add(i, stop, 'string');
        i = stop;
        if (end < 0) st = at('string', c, 1);
      } else if (c === '=') { add(i, i + 1, 'punct'); i++; }
      else {
        const name = sticky(/[^\s"'>/={]+/y, text, i);
        if (name) { add(i, i + name.length, 'attr'); i += name.length; }
        else { add(i, i + 1, 'punct'); i++; }
      }
    } else if (text.startsWith('<!--', i)) {
      add(i, i + 4, 'comment');
      ({ i, st } = blockComment(text, i + 4, '-->', add, START));
    } else if (c === '<' && /[A-Za-z!?/]/.test(text[i + 1] ?? '')) {
      const open = text[i + 1] === '/' ? 2 : 1;
      const name = sticky(/[!?]?[A-Za-z][\w:.-]*/y, text, i + open) ?? '';
      add(i, i + open, 'punct');
      add(i + open, i + open + name.length, 'tag');
      i += open + name.length;
      st = TAG;
    } else if (c === '&') {
      const entity = sticky(/&#?\w+;/y, text, i);
      if (entity) add(i, i + entity.length, 'number');
      i += entity ? entity.length : 1;
    } else {
      // Text: on to the next thing that could start something.
      i++;
      while (i < n && !'<&{'.includes(text[i] as string)) i++;
    }
    if (i <= start) i = start + 1;
  }
  return st;
}

/** A Twig expression or tag, from its opener (`opener`) or from the line's start, to `close` or the line's end. */
function twigBody(text: string, i: number, close: string, opener: boolean, add: Add): { i: number; closed: boolean } {
  const n = text.length;
  let first = false;
  if (opener) {
    const len = text[i + 2] === '-' || text[i + 2] === '~' ? 3 : 2;
    add(i, i + len, 'punct');
    first = close === '%}';
    i += len;
  }
  let prev = '';
  while (i < n) {
    const start = i;
    const c = text[i] as string;
    const trim = (c === '-' || c === '~') && text.startsWith(close, i + 1);
    if (text.startsWith(close, i) || trim) {
      const len = close.length + Number(trim);
      add(i, i + len, 'punct');
      return { i: i + len, closed: true };
    }
    if (SPACE.test(c)) i++;
    else if (c === '"' || c === "'") {
      const end = closeQuote(text, i + 1, c);
      add(i, end < 0 ? n : end, 'string');
      i = end < 0 ? n : end;
      prev = '';
    } else if (DIGIT.test(c)) {
      const num = sticky(/\d+(?:\.\d+)?/y, text, i) ?? c;
      add(i, i + num.length, 'number');
      i += num.length;
      prev = '';
    } else {
      const word = sticky(/[A-Za-z_]\w*/y, text, i);
      if (word) {
        const kind: TokenKind | null = first ? 'keyword'
          : word === 'true' || word === 'false' || word === 'null' || word === 'none' ? 'number'
            : prev === '.' ? null
              : prev === '|' || text[i + word.length] === '(' ? 'type'
                : TWIG_KEYWORDS.has(word) ? 'keyword' : 'variable';
        if (kind) add(i, i + word.length, kind);
        i += word.length;
        first = false;
        prev = '';
      } else {
        add(i, i + 1, 'punct');
        prev = c;
        i++;
      }
    }
    if (i <= start) i = start + 1;
  }
  return { i: n, closed: false };
}

/** An attribute value in a Twig template: a string, with any {{ … }} inside it coloured as Twig. */
function twigInString(text: string, from: number, to: number, add: Add): void {
  let i = from;
  while (i < to) {
    const open = text.indexOf('{{', i);
    if (open < 0 || open >= to) { add(i, to, 'string'); return; }
    add(i, open, 'string');
    const r = twigBody(text.slice(0, to), open, '}}', true, add);
    i = Math.max(r.i, open + 2);
  }
}

/* ── Markdown ──────────────────────────────────────────────────────────── */

function markdown(text: string, state: State, add: Add): State {
  const n = text.length;
  if (state.in === 'fence') {
    if (text.trimStart().startsWith(state.close)) { add(0, n, 'punct'); return START; }
    return state;
  }
  let i = 0;
  let st = state;
  if (st.in === 'comment') {
    ({ i, st } = blockComment(text, 0, st.close, add, START));
    if (st.in === 'comment') return st;
  } else {
    const fence = /^\s*(`{3,}|~{3,})/.exec(text);
    if (fence) {
      add(0, fence[0].length, 'punct');
      add(fence[0].length, n, 'keyword');
      return at('fence', fence[1] as string);
    }
    if (/^\s{0,3}#{1,6}(?:\s|$)/.test(text)) { add(0, n, 'keyword'); return START; }
    if (/^\s*>/.test(text)) { add(0, n, 'comment'); return START; }
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(text)) { add(0, n, 'punct'); return START; }
    const list = /^\s*(?:[-*+]|\d+[.)])(?=\s)/.exec(text);
    if (list) { add(0, list[0].length, 'punct'); i = list[0].length; }
  }
  while (i < n) {
    const start = i;
    const c = text[i];
    if (c === '`') {
      const ticks = sticky(/`+/y, text, i) ?? '`';
      const end = text.indexOf(ticks, i + ticks.length);
      add(i, end < 0 ? i + ticks.length : end + ticks.length, end < 0 ? 'punct' : 'string');
      i = end < 0 ? i + ticks.length : end + ticks.length;
    } else if (c === ']' && text[i + 1] === '(') {
      const end = text.indexOf(')', i + 2);
      add(i, i + 2, 'punct');
      if (end >= 0) { add(i + 2, end, 'attr'); add(end, end + 1, 'punct'); i = end + 1; }
      else i += 2;
    } else if (text.startsWith('<!--', i)) {
      add(i, i + 4, 'comment');
      ({ i, st } = blockComment(text, i + 4, '-->', add, START));
    } else if ((c === '*' || c === '_') && text[i + 1] === c) {
      add(i, i + 2, 'punct');
      i += 2;
    } else {
      i++;
      while (i < n && !'`]<*_'.includes(text[i] as string)) i++;
    }
    if (i <= start) i = start + 1;
  }
  return st;
}

/* ── Shell ─────────────────────────────────────────────────────────────── */

const SHELL_KEYWORDS = words('if then else elif fi for while until do done case esac in function select return local export readonly declare unset shift exit break continue source time');

function shell(text: string, state: State, add: Add): State {
  const n = text.length;
  let i = 0;
  let st = state;
  let heredoc = '';
  while (i < n) {
    const start = i;
    const c = text[i] as string;
    if (st.in === 'heredoc') {
      add(0, n, 'string');
      i = n;
      if (text.trim() === st.close) st = START;
    } else if (st.in === 'string') {
      ({ i, st } = shellString(text, i, st.close, add));
    } else if (SPACE.test(c)) {
      i++;
    } else if (c === '#' && (i === 0 || /[\s;(|&]/.test(text[i - 1] as string))) {
      add(i, n, 'comment');
      i = n;
    } else if (c === "'" || c === '"') {
      add(i, i + 1, 'string');
      ({ i, st } = shellString(text, i + 1, c, add));
    } else if (c === '$') {
      i = shellVariable(text, i, add);
    } else if (text.startsWith('<<', i) && !text.startsWith('<<<', i)) {
      const m = /<<-?\s*(['"]?)(\w+)\1/y;
      m.lastIndex = i;
      const found = m.exec(text);
      if (found) { add(i, i + found[0].length, 'punct'); heredoc = found[2] as string; i += found[0].length; }
      else { add(i, i + 2, 'punct'); i += 2; }
    } else if (c === '-' && (i === 0 || SPACE.test(text[i - 1] as string)) && /[\w-]/.test(text[i + 1] ?? '')) {
      const flag = sticky(/--?[\w-]+/y, text, i) ?? c;
      add(i, i + flag.length, 'attr');
      i += flag.length;
    } else if (DIGIT.test(c) && (i === 0 || !/[\w.]/.test(text[i - 1] as string))) {
      const num = sticky(/\d+(?:\.\d+)*/y, text, i) ?? c;
      if (!/[A-Za-z_]/.test(text[i + num.length] ?? '')) add(i, i + num.length, 'number');
      i += num.length;
    } else {
      const word = sticky(/[A-Za-z_][\w.-]*/y, text, i);
      if (word) {
        if (text[i + word.length] === '=' && /^[A-Za-z_]\w*$/.test(word)) add(i, i + word.length, 'variable');
        else if (SHELL_KEYWORDS.has(word)) add(i, i + word.length, 'keyword');
        i += word.length;
      } else {
        if ('|&;()<>[]{}=!'.includes(c)) add(i, i + 1, 'punct');
        i++;
      }
    }
    if (i <= start) i = start + 1;
  }
  return heredoc && st.in === 'code' ? at('heredoc', heredoc) : st;
}

/** A quoted string from `i` (after its quote); double quotes colour the variables inside. */
function shellString(text: string, i: number, quote: string, add: Add): { i: number; st: State } {
  const n = text.length;
  for (let j = i; j < n; j++) {
    const c = text[j];
    if (quote === '"' && c === '\\') { j++; continue; }
    if (c === quote) { add(i, j + 1, 'string'); return { i: j + 1, st: START }; }
    if (quote === '"' && c === '$' && /[\w{@?#*!$]/.test(text[j + 1] ?? '')) {
      add(i, j, 'string');
      j = shellVariable(text, j, add) - 1;
      i = j + 1;
    }
  }
  add(i, n, 'string');
  return { i: n, st: at('string', quote) };
}

function shellVariable(text: string, i: number, add: Add): number {
  if (text[i + 1] === '{') {
    const end = text.indexOf('}', i + 2);
    const stop = end < 0 ? text.length : end + 1;
    add(i, stop, 'variable');
    return stop;
  }
  if (text[i + 1] === '(') { add(i, i + 2, 'punct'); return i + 2; }
  const name = sticky(/\$(?:[A-Za-z_]\w*|[0-9@?#*!$-])/y, text, i) ?? '$';
  add(i, i + name.length, name.length > 1 ? 'variable' : 'punct');
  return i + name.length;
}

/* ── the table ─────────────────────────────────────────────────────────── */

const TOKENIZERS: Record<Lang, Tokenizer> = {
  php: (t, s, a) => clike(PHP, t, s, a),
  jsx: (t, s, a) => clike(JS, t, s, a),
  ts: (t, s, a) => clike(TS, t, s, a),
  css: (t, s, a) => css(false, t, s, a),
  scss: (t, s, a) => css(true, t, s, a),
  json,
  yaml,
  twig: (t, s, a) => markup(true, t, s, a),
  html: (t, s, a) => markup(false, t, s, a),
  markdown,
  shell,
};
