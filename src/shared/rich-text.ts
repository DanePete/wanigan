// Words in formatted text: a string a site keeps as HTML (a schema property marked `contentMediaType: 'text/html'`: a
// WordPress block's rich text, a field a block binds to, a navigation label), changed without typed words ever being
// sent as markup. The edit sheet (live-schema.ts) and the design layer (src/main/live-layer.ts) share it.
//
// - Words alone (no tag inside): new words are sent escaped, as the WordPress helper's own save writes text
//   (WP_HTML_Processor::serialize(), class-wp-html-processor.php escape_text_for_serialization(), 7.1:
//   htmlspecialchars() with ENT_QUOTES | ENT_SUBSTITUTE | ENT_HTML5), so `&`, `<`, `>`, `"` and `'` go as `&amp;`,
//   `&lt;`, `&gt;`, `&quot;` and `&apos;`, and what is sent is what the site keeps (kses keeps `&apos;`: it is in
//   kses.php $allowedentitynames).
// - Words between tags: only a change inside one run of text between two tags is made, escaped there, every tag and
//   every other run kept byte for byte (retypeRich). New words take the formatting of the words they replace. A change
//   that crosses a tag, or words added where none are replaced right beside a tag (they could go inside the formatting
//   or outside it), is refused: which words keep which formatting would be a guess.

/** A tag or a comment: a value holding one is markup, and its words are only part of what it keeps. */
export const MARKUP = /<\/?[a-z][a-z0-9-]*(?:\s[^>]*)?\/?>|<!--[\s\S]*?-->/i;
const MARKUP_ALL = new RegExp(MARKUP.source, 'gi');

/**
 * The inline tags the WordPress helper keeps in new rich text (live-helper-wordpress.ts INLINE: the block editor's
 * own formats, wp-includes/js/dist/format-library.js, and a line break), besides tags the element already held. It
 * refuses any other tag; wp_kses_post() cleans what it keeps.
 */
export const WORDPRESS_INLINE_TAGS = ['strong', 'em', 'a', 'code', 's', 'span', 'mark', 'sub', 'sup', 'kbd', 'bdo', 'img', 'br'] as const;

/** The named character references read here: what a block editor, a title or a setting is commonly kept with. */
const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ',
  hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', copy: '©', reg: '®', trade: '™',
};
const REF = /&(?:#(\d{1,7})|#x([\da-f]{1,6})|([a-z][a-z0-9]{1,8}));/gi;

/** Text as kept in HTML, read: its character references decoded, with where each decoded unit came from. */
interface Decoded { text: string; from: number[]; to: number[]; complete: boolean }

function decodeMapped(raw: string): Decoded {
  let text = '';
  const from: number[] = [];
  const to: number[] = [];
  let complete = true;
  let at = 0;
  const keep = (s: string, a: number, b: number): void => { for (let i = 0; i < s.length; i++) { from.push(a); to.push(b); } text += s; };
  const plain = (end: number): void => { for (let i = at; i < end; i++) { text += raw[i]; from.push(i); to.push(i + 1); } };
  for (const m of raw.matchAll(REF)) {
    const i = m.index ?? 0;
    plain(i);
    const [ref, dec, hex, name] = m;
    const code = dec ? Number(dec) : hex ? Number.parseInt(hex, 16) : null;
    const read = code !== null ? (code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : null) : NAMED[(name ?? '').toLowerCase()] ?? null;
    if (read === null) { complete = false; keep(ref, i, i + ref.length); } else keep(read, i, i + ref.length);
    at = i + ref.length;
  }
  plain(raw.length);
  return { text, from, to, complete };
}

/** Text as kept in HTML, read: its character references decoded (those it knows; any other is left as written). */
export const decodeRefs = (raw: string): string => decodeMapped(raw).text;

/** Whether a value holds a tag or a comment. */
export const holdsMarkup = (html: string): boolean => MARKUP.test(html);

/**
 * The words a value of HTML holds when it is words alone: no tag, and every character reference one that is read here.
 * Null when it holds markup, or a reference this cannot read (it would be sent back changed).
 */
export function plainWords(html: string): string | null {
  if (holdsMarkup(html)) return null;
  const d = decodeMapped(html);
  return d.complete ? d.text : null;
}

/** Words as HTML text: `&`, `<`, `>`, `"` and `'` escaped as WordPress's HTML processor writes them. */
export function escapeText(words: string): string {
  return words.replace(/[&<>"']/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&apos;'));
}

/** The tag names a value of HTML holds, lowercased, each once, in the order first met. */
export function tagsIn(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<\/?([a-z][a-z0-9-]*)/gi)) {
    const name = (m[1] ?? '').toLowerCase();
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/* ── words compared as words ───────────────────────────────────────────── */

/**
 * Words compared as words: whitespace folded as the page script folds it, and the typography a site prints a value
 * with read as what it was typed as (WordPress's wptexturize curls quotes and turns `--` and `...` into a dash and an
 * ellipsis).
 */
export const asWords = (s: string): string => s
  .replace(/[‘’‚‛′]/g, '\'').replace(/[“”„‟″]/g, '"')
  .replace(/…/g, '...').replace(/---|--|[–—]/g, '-')
  .replace(/\s+/g, ' ').trim();

/** asWords(), with the place in the input each unit of the result came from (`from` inclusive, `to` exclusive). */
export function wordsMapped(s: string): { text: string; from: number[]; to: number[] } {
  const chars: string[] = [];
  const from: number[] = [];
  const to: number[] = [];
  const push = (c: string, a: number, b: number): void => { chars.push(c); from.push(a); to.push(b); };
  let i = 0;
  while (i < s.length) {
    const c = s[i] as string;
    if (/\s/.test(c)) {
      let j = i + 1;
      while (j < s.length && /\s/.test(s[j] as string)) j++;
      push(' ', i, j);
      i = j;
    } else if ('‘’‚‛′'.includes(c)) { push('\'', i, i + 1); i++; }
    else if ('“”„‟″'.includes(c)) { push('"', i, i + 1); i++; }
    else if (c === '…') { push('.', i, i + 1); push('.', i, i + 1); push('.', i, i + 1); i++; }
    else if (s.startsWith('---', i)) { push('-', i, i + 3); i += 3; }
    else if (s.startsWith('--', i)) { push('-', i, i + 2); i += 2; }
    else if (c === '–' || c === '—') { push('-', i, i + 1); i++; }
    else { push(c, i, i + 1); i++; }
  }
  let a = 0;
  let b = chars.length;
  if (b > 0 && chars[0] === ' ') a = 1;
  if (b > a && chars[b - 1] === ' ') b--;
  return { text: chars.slice(a, b).join(''), from: from.slice(a, b), to: to.slice(a, b) };
}

/* ── new words between tags ────────────────────────────────────────────── */

export type Retyped = { ok: true; html: string } | { ok: false; why: string };

interface Run { raw: string; d: Decoded; start: number; end: number }

/**
 * New words for an element whose HTML holds tags, written into the one run of text between two tags that the change
 * falls in, escaped there; every tag and every other run is kept byte for byte. The change is the one stretch where
 * the words differ (compared as words); a stretch that can slide (repeated letters) is placed at both ends of its
 * slide, and both must fall in the same run. New words take the formatting of the words they replace. `before` is
 * the element's words as the page showed them, `after` the new words. Refused, saying why, when the kept words are not
 * the words shown, when the change crosses a tag, or when words added where none are replaced sit right at a tag.
 * Words alone (no tag) are simply escaped: escapeText().
 */
export function retypeRich(html: string, before: string, after: string): Retyped {
  // Text runs between tags, tags kept as written: text, tag, text, …, text (a run may be empty).
  const runs: Run[] = [];
  const tags: string[] = [];
  let at = 0;
  let pos = 0;
  const run = (raw: string): void => { const d = decodeMapped(raw); runs.push({ raw, d, start: pos, end: pos + d.text.length }); pos += d.text.length; };
  for (const m of html.matchAll(MARKUP_ALL)) {
    run(html.slice(at, m.index ?? 0));
    tags.push(m[0]);
    at = (m.index ?? 0) + m[0].length;
  }
  run(html.slice(at));
  const kept = runs.map((r) => r.d.text).join('');
  const s = wordsMapped(kept);
  if (s.text !== asWords(before)) return { ok: false, why: 'the words it keeps are not exactly the words the page shows' };
  const v = wordsMapped(after);
  if (v.text === s.text) return { ok: true, html };
  if (!tags.length) return { ok: true, html: escapeText(after) };

  const n = Math.min(s.text.length, v.text.length);
  let prefix = 0;
  while (prefix < n && s.text[prefix] === v.text[prefix]) prefix++;
  let suffix = 0;
  while (suffix < n && s.text[s.text.length - 1 - suffix] === v.text[v.text.length - 1 - suffix]) suffix++;
  // The two extremes of where one change can sit: as late as it can (the longest same start), as early as it can (the
  // longest same end). Every place between lies between them, so both in one run means every place is in that run.
  const late = { p: prefix, s: Math.min(suffix, n - prefix) };
  const early = { p: Math.min(prefix, n - suffix), s: suffix };

  /** Where a change at (p, s) sits in the kept text and in the new words, or why it cannot be placed. */
  const place = (p: number, sfx: number): { a: number; b: number; c: number; d: number; k: number } | string => {
    const ls = s.text.length;
    const lv = v.text.length;
    // A boundary inside one character the folding wrote as several (an ellipsis read as three dots).
    const splits = (m: { from: number[] }, k: number, len: number): boolean => k > 0 && k < len && m.from[k - 1] === m.from[k];
    if (splits(s, p, ls) || splits(s, ls - sfx, ls) || splits(v, p, lv) || splits(v, lv - sfx, lv)) return 'it falls inside one character the page prints as several';
    const edge = (m: { from: number[]; to: number[] }, k: number, len: number): number => (k < len ? m.from[k] as number : len > 0 ? m.to[len - 1] as number : 0);
    const a = edge(s, p, ls);
    const b = ls - sfx > p ? s.to[ls - sfx - 1] as number : a;
    const c = edge(v, p, lv);
    const d = lv - sfx > p ? v.to[lv - sfx - 1] as number : c;
    let k = -1;
    if (b > a) k = runs.findIndex((r) => r.start <= a && b <= r.end);
    else {
      const inside = runs.findIndex((r) => r.start < a && a < r.end);
      const touching = runs.map((r, i) => (r.start === a || r.end === a ? i : -1)).filter((i) => i >= 0);
      k = inside >= 0 ? inside : touching.length === 1 ? touching[0] as number : -1;
      if (k < 0) return 'it adds words right beside a tag, where they could go inside the formatting or outside it';
    }
    if (k < 0) return 'it crosses its formatting (a link, bold or another inline tag)';
    return { a, b, c, d, k };
  };
  const one = place(late.p, late.s);
  const other = place(early.p, early.s);
  if (typeof one === 'string') return { ok: false, why: one };
  if (typeof other === 'string') return { ok: false, why: other };
  if (one.k !== other.k) return { ok: false, why: 'it could belong to the words on either side of a tag' };
  const r = runs[one.k] as Run;
  const ia = one.a - r.start;
  const ib = one.b - r.start;
  // A character reference is one unit of the raw text: a change never starts or stops inside one.
  if ((ia > 0 && ia < r.d.text.length && r.d.from[ia] === r.d.from[ia - 1]) || (ib > 0 && ib < r.d.text.length && r.d.from[ib] === r.d.from[ib - 1])) {
    return { ok: false, why: 'it falls inside one character the site keeps as a reference' };
  }
  const rawA = ia < r.d.text.length ? r.d.from[ia] as number : r.raw.length;
  const rawB = ib > ia ? r.d.to[ib - 1] as number : rawA;
  const raw = `${r.raw.slice(0, rawA)}${escapeText(after.slice(one.c, one.d))}${r.raw.slice(rawB)}`;
  return { ok: true, html: runs.map((x, i) => (i === one.k ? raw : x.raw) + (tags[i] ?? '')).join('') };
}
