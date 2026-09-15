/**
 * Links an agent prints into a terminal, found in one line of text.
 *
 * Agents print file paths constantly — "Edited src/Checkout.php:42", "see
 * /Users/me/repo/README.md" — and URLs almost as often. This file only finds
 * candidates in text. It decides nothing about whether a path exists or may be
 * opened: that is main's question, asked with the session's own root, and a
 * candidate this parser finds is underlined only after main has said yes.
 *
 * Offsets are UTF-16 indices into the string handed in. The terminal maps them
 * to cells, because a wide character is one index and two cells.
 */

export type LinkCandidate =
  | { kind: 'url'; start: number; end: number; text: string; url: string }
  | { kind: 'path'; start: number; end: number; text: string; path: string; line: number | null; column: number | null };

/**
 * Real escape sequences, and the remnants a copy through a pipe leaves behind
 * once the ESC byte is gone ("[0m", "[1;31m"). Only the SGR remnant is stripped
 * bare, and only where it abuts the text it was colouring — a bracketed digit
 * elsewhere in prose is left alone.
 */
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

/** SGR remnants anywhere in a line: the `[1;31m` a pipe leaves once ESC is gone. */
const SGR_REMNANT = /\[[0-9;]*m/g;

/**
 * Escapes and their remnants replaced by spaces of the same length, so a
 * colour code can never become the first characters of a path while every
 * offset still points at the same place in the original line.
 */
function blankEscapes(line: string): string {
  return line.replace(ANSI, (m) => ' '.repeat(m.length)).replace(SGR_REMNANT, (m) => ' '.repeat(m.length));
}

/** An SGR remnant glued to the end of a token, e.g. `src/a.ts[0m`. */
const SGR_REMNANT_TAIL = /\[[0-9;]*m$/;
/** An SGR remnant glued to the start of a token, e.g. `[1msrc/a.ts`. */
const SGR_REMNANT_HEAD = /^\[[0-9;]*m/;

const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/g;

/**
 * A path token: an absolute path, a home-relative one, an explicitly relative
 * one, or a bare relative path that either contains a slash or ends in a file
 * extension. The last rule is what keeps ordinary words out: "the", "npm" and
 * "v2.1" are not paths, "README.md" and "src/app" are. A trailing `:line` or
 * `:line:col` is part of the token.
 */
const PATH_RE = /(?:~?\/|\.{1,2}\/)?[A-Za-z0-9_@+.-][A-Za-z0-9_@+.\-/]*(?::\d+(?::\d+)?)?/g;

const TRAILING_PUNCTUATION = /[.,;:!?]+$/;
const PAIRS: Record<string, string> = { ')': '(', ']': '[', '}': '{', '>': '<' };
const QUOTES = new Set(['"', "'", '`']);

function count(text: string, ch: string): number {
  let n = 0;
  for (const c of text) if (c === ch) n++;
  return n;
}

/**
 * Trim what surrounds a link in prose: a sentence's full stop, a closing
 * bracket that belongs to the sentence rather than the link, quotes. A closing
 * bracket is kept when the link itself opened one — `https://en.wikipedia.org/wiki/Foo_(bar)`.
 */
function trimEdges(raw: string, start: number): { text: string; start: number } {
  let text = raw;
  let begin = start;
  for (;;) {
    const before = text;
    if (SGR_REMNANT_HEAD.test(text)) {
      const m = SGR_REMNANT_HEAD.exec(text)!;
      text = text.slice(m[0].length);
      begin += m[0].length;
    }
    text = text.replace(SGR_REMNANT_TAIL, '');
    if (QUOTES.has(text[0])) { text = text.slice(1); begin += 1; }
    if (text && QUOTES.has(text[text.length - 1])) text = text.slice(0, -1);
    text = text.replace(TRAILING_PUNCTUATION, '');
    const last = text[text.length - 1];
    if (last && PAIRS[last] && count(text, last) > count(text, PAIRS[last])) text = text.slice(0, -1);
    const first = text[0];
    if (first && Object.values(PAIRS).includes(first)) {
      const close = Object.keys(PAIRS).find((k) => PAIRS[k] === first)!;
      if (count(text, first) > count(text, close)) { text = text.slice(1); begin += 1; }
    }
    if (text === before) break;
  }
  return { text, start: begin };
}

/** `path:12:3` into its parts. A `:0` line is not a line. */
export function splitLineColumn(token: string): { path: string; line: number | null; column: number | null } {
  const m = /^(.*?):(\d+)(?::(\d+))?$/.exec(token);
  if (!m || !m[1]) return { path: token, line: null, column: null };
  const line = Number(m[2]);
  const column = m[3] !== undefined ? Number(m[3]) : null;
  if (!Number.isSafeInteger(line) || line < 1) return { path: m[1], line: null, column: null };
  return { path: m[1], line, column: column !== null && Number.isSafeInteger(column) && column >= 1 ? column : null };
}

function looksLikePath(path: string): boolean {
  if (!path || path.length > 1024) return false;
  if (/^[.\-/~]+$/.test(path)) return false;
  if (path.startsWith('/') || path.startsWith('~/') || path.startsWith('./') || path.startsWith('../')) return path.length > 1;
  if (path.includes('//')) return false;
  // A version string or a number is not a file.
  if (/^v?\d+(\.\d+)*$/.test(path)) return false;
  if (path.includes('/')) return /[A-Za-z]/.test(path);
  // A bare name needs an extension of letters, like "README.md" or "Makefile.am" —
  // "e.g" and "i.e" are excluded by requiring a name part of two characters.
  return /^[A-Za-z0-9_@+-][A-Za-z0-9_@+.-]+\.[A-Za-z][A-Za-z0-9]{0,9}$/.test(path) && !/^(e\.g|i\.e|etc)$/i.test(path);
}

/**
 * Every link candidate in one line, left to right, never overlapping. URLs are
 * found first and a path is never looked for inside one.
 */
export function findLinks(line: string): LinkCandidate[] {
  const text = blankEscapes(line);
  const out: LinkCandidate[] = [];
  const taken: [number, number][] = [];
  for (const m of text.matchAll(URL_RE)) {
    const trimmed = trimEdges(m[0], m.index ?? 0);
    if (!/^https?:\/\/[^/\s]+/.test(trimmed.text)) continue;
    const end = trimmed.start + trimmed.text.length;
    out.push({ kind: 'url', start: trimmed.start, end, text: trimmed.text, url: trimmed.text });
    taken.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
  }
  for (const m of text.matchAll(PATH_RE)) {
    const at = m.index ?? 0;
    if (taken.some(([a, b]) => at < b && at + m[0].length > a)) continue;
    // A path starts a token: the character before it must not be a word
    // character, or "abc/def" inside "xabc/def" would be half a word.
    const prev = at > 0 ? text[at - 1] : '';
    if (prev && /[A-Za-z0-9_]/.test(prev)) continue;
    const trimmed = trimEdges(m[0], at);
    if (!trimmed.text) continue;
    const parts = splitLineColumn(trimmed.text);
    if (!looksLikePath(parts.path)) continue;
    out.push({
      kind: 'path', start: trimmed.start, end: trimmed.start + trimmed.text.length, text: trimmed.text,
      path: parts.path, line: parts.line, column: parts.column,
    });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** The candidate under a string offset, if any. */
export function linkAt(links: readonly LinkCandidate[], offset: number): LinkCandidate | null {
  return links.find((l) => offset >= l.start && offset < l.end) ?? null;
}
