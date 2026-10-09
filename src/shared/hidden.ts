// What a command really says. A permission request is approved by reading it,
// so anything that makes the text read differently from what would run is
// spelled out as a visible escape, ⟨U+202E⟩: control characters and terminal
// escapes, invisible characters, bidirectional controls that reorder what is
// shown, spaces that are not plain spaces, and, in a command that is otherwise
// plain ASCII, characters that only look like ASCII. Pure: no I/O.

export type HiddenKind = 'control' | 'escape' | 'invisible' | 'bidi' | 'space' | 'lookalike';

export interface Shown {
  /** What to show: the text itself, or an escape such as ⟨U+202E⟩. */
  text: string;
  /** Set when `text` is an escape: what was there, and in plain words why it was spelled out. */
  flag?: { kind: HiddenKind; code: string; note: string };
}

export interface Revealed {
  parts: Shown[];
  /** Characters that were spelled out. */
  count: number;
  /** Something hidden: a control, terminal escape, invisible or bidi character. */
  hidden: boolean;
  /** Something that only looks like what it seems: a lookalike letter or an unusual space. */
  lookalike: boolean;
}

const NAMES: Record<number, string> = {
  0x00: 'NUL', 0x07: 'BEL', 0x08: 'BS', 0x0b: 'VT', 0x0c: 'FF', 0x0d: 'CR', 0x1b: 'ESC', 0x7f: 'DEL',
};

const BIDI: Record<number, string> = {
  0x061c: 'Arabic letter mark', 0x200e: 'left-to-right mark', 0x200f: 'right-to-left mark',
  0x202a: 'left-to-right embedding', 0x202b: 'right-to-left embedding', 0x202c: 'pop directional formatting',
  0x202d: 'left-to-right override', 0x202e: 'right-to-left override',
  0x2066: 'left-to-right isolate', 0x2067: 'right-to-left isolate', 0x2068: 'first strong isolate', 0x2069: 'pop directional isolate',
};

const INVISIBLE: Record<number, string> = {
  0x00ad: 'soft hyphen', 0x034f: 'combining grapheme joiner', 0x180e: 'Mongolian vowel separator',
  0x200b: 'zero-width space', 0x200c: 'zero-width non-joiner', 0x200d: 'zero-width joiner', 0x2060: 'word joiner', 0xfeff: 'zero-width no-break space',
};

/**
 * Letters and marks from other scripts, and punctuation, that pass for ASCII
 * and that NFKC normalisation does not already map to it. Each maps to what it
 * imitates.
 */
const HOMOGLYPHS = table(`
  Cyrillic  0410 A  0412 B  0415 E  041A K  041C M  041D H  041E O  0420 P  0421 C  0422 T  0425 X  0405 S  0406 I  0408 J  04AE Y
            0500 d  051A Q  051C W  04C0 l  0430 a  0441 c  0435 e  04BB h  0456 i  0458 j  043E o  0440 p  0455 s  0501 d  051B q
            051D w  0445 x  0443 y  04AF y  04CF l  0475 v
  Greek     0391 A  0392 B  0395 E  0396 Z  0397 H  0399 I  039A K  039C M  039D N  039F O  03A1 P  03A4 T  03A5 Y  03A7 X  03BF o
            03BD v  03B9 i  03BA k  03C1 p  03C5 u  03C7 x  03B1 a
  Armenian  0585 o  057D u  0570 h  0578 n  0581 g
  Latin     0131 i  0251 a  0261 g  028F y  01C0 |  01C3 !
  Dashes    2010 -  2011 -  2012 -  2212 -  2043 -
  Quotes    2032 '  2033 "  02B9 '  02BA "  02BC '  00B4 '
  Slashes   2215 /  2044 /  29F8 /  2223 |
  Other     05C3 :  0589 :  2236 :  A789 :  2039 <  203A >  02C2 <  02C3 >  30FB .  2027 .  2217 *  204E *  066D *
`);

/**
 * Typography an agent writes in prose (a commit message's dash, apostrophe or
 * ellipsis): en and em dashes, the horizontal bar, curly quotes, the ellipsis.
 * It hides nothing, so it is shown as it is: a warning on every well-punctuated
 * commit message would teach the owner to ignore the warning.
 */
const PROSE = new Set([0x2013, 0x2014, 0x2015, 0x2018, 0x2019, 0x201a, 0x201b, 0x201c, 0x201d, 0x201e, 0x201f, 0x2026]);

const ASCII_PRINTABLE = /^[\x20-\x7e]+$/;
const ASCII_LETTER = /[A-Za-z]/;
const WORD = /[\p{L}\p{N}\p{M}_]/u;
const PICTO = /\p{Extended_Pictographic}/u;
const IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;
const FORMAT = /\p{Cf}/u;
const SPACE = /[\p{Zs}\u{2028}\u{2029}]/u;
const MARK = /\p{M}/u;
const LETTER = /\p{L}/u;
/** Scripts a lookalike is drawn from, and that genuine text is written in. */
const SCRIPTS = ['Latin', 'Cyrillic', 'Greek', 'Armenian', 'Cherokee', 'Han', 'Hiragana', 'Katakana', 'Hangul', 'Arabic', 'Hebrew', 'Thai', 'Devanagari']
  .map((name) => [name, new RegExp(`\\p{Script=${name}}`, 'u')] as const);
/** A letter's script, or 'Common' for punctuation, symbols and marks that belong to none. */
function scriptOf(ch: string): string {
  return SCRIPTS.find(([, re]) => re.test(ch))?.[0] ?? (LETTER.test(ch) ? 'Other' : 'Common');
}

const hex = (cp: number): string => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;

/** `HEX letter` pairs, each group led by a label word, as a map from the character to what it imitates. */
function table(spec: string): Map<number, string> {
  const map = new Map<number, string>();
  const words = spec.split(/\s+/).filter(Boolean);
  for (let i = 0; i < words.length - 1; i++) {
    if (/^[0-9A-F]{4,5}$/.test(words[i] as string)) map.set(parseInt(words[i] as string, 16), words[++i] as string);
  }
  return map;
}

/** What a lookalike imitates, or null when it is not one. */
function imitates(ch: string, cp: number): string | null {
  const known = HOMOGLYPHS.get(cp);
  if (known) return known;
  const folded = ch.normalize('NFKC');
  return folded !== ch && ASCII_PRINTABLE.test(folded) ? folded : null;
}

interface Char { ch: string; cp: number; flag: Shown['flag'] | null; candidate: string | null }

/** Spell out every hidden or deceptive character in `text`. Plain text comes back as one part. */
export function reveal(text: string): Revealed {
  const chars: Char[] = [];
  for (const ch of text) chars.push({ ch, cp: ch.codePointAt(0) as number, flag: null, candidate: null });

  // The scripts genuine (not lookalike) letters are written in: an ü says the
  // text is partly German, and nothing about whether a Cyrillic с is genuine.
  const scripts = new Set<string>();
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i] as Char;
    const { ch, cp } = c;
    if (cp === 0x0a || cp === 0x09 || (cp >= 0x20 && cp < 0x7f)) continue;
    const prev = chars[i - 1];
    const next = chars[i + 1];
    if (cp < 0x20 || cp === 0x7f || (cp >= 0x80 && cp < 0xa0)) {
      c.flag = cp === 0x1b
        ? { kind: 'escape', code: hex(cp), note: 'Escape: starts a terminal control sequence' }
        : { kind: 'control', code: hex(cp), note: `Control character${NAMES[cp] ? ` (${NAMES[cp]})` : ''}` };
    } else if (BIDI[cp]) {
      c.flag = { kind: 'bidi', code: hex(cp), note: `Bidirectional control: ${BIDI[cp]}. It changes the order text is shown in.` };
    } else if (cp >= 0xd800 && cp <= 0xdfff) {
      c.flag = { kind: 'control', code: hex(cp), note: 'A broken character (an unpaired surrogate)' };
    } else if (SPACE.test(ch)) {
      c.flag = { kind: 'space', code: hex(cp), note: 'A space that is not a plain space' };
    } else if (FORMAT.test(ch) || IGNORABLE.test(ch)) {
      // An emoji's own joiners and presentation selectors are part of the picture, not hidden.
      const emoji = (cp === 0x200d && prev && next && PICTO.test(prev.ch) && PICTO.test(next.ch))
        || ((cp === 0xfe0f || cp === 0xfe0e) && prev && PICTO.test(prev.ch));
      if (!emoji) c.flag = { kind: 'invisible', code: hex(cp), note: `Invisible character${INVISIBLE[cp] ? `: ${INVISIBLE[cp]}` : ''}` };
    } else if (MARK.test(ch)) {
      // A combining mark that composes into one ordinary letter (e + ◌́ = é) is that
      // letter; one that does not (a slash laid over a dash) is disguise.
      const base = prev && !prev.flag ? prev.ch : '';
      if (base && (base + ch).normalize('NFC').length === 1) scripts.add(scriptOf(base));
      else c.candidate = '';
    } else if (!PROSE.has(cp)) {
      // An emoji says nothing about the script a command is written in.
      const looks = imitates(ch, cp);
      if (looks !== null) c.candidate = looks;
      else if (!PICTO.test(ch)) scripts.add(scriptOf(ch));
    }
  }

  // Lookalikes count in an otherwise-ASCII command. In text that is really in
  // the lookalike's own script (a Russian commit message), only those mixed
  // into a word with ASCII letters, or into a host name or path, do. A
  // lookalike's script must be genuinely there: an ü elsewhere excuses no с.
  const mixed = mixedWords(chars);
  const address = addresses(chars);
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i] as Char;
    if (c.candidate === null) continue;
    const own = scriptOf(c.ch);
    const excused = own === 'Common' || own === 'Other' ? scripts.size > 0 : scripts.has(own);
    if (excused && !mixed(i) && !address[i]) continue;
    c.flag = {
      kind: 'lookalike', code: hex(c.cp),
      note: c.candidate ? `Looks like “${c.candidate}” but is ${hex(c.cp)}` : `A mark laid over the character before it (${hex(c.cp)})`,
    };
  }

  const parts: Shown[] = [];
  let run = '';
  let count = 0;
  let hidden = false;
  let lookalike = false;
  for (const c of chars) {
    if (!c.flag) { run += c.ch; continue; }
    if (run) { parts.push({ text: run }); run = ''; }
    count++;
    if (c.flag.kind === 'space' || c.flag.kind === 'lookalike') lookalike = true;
    else hidden = true;
    parts.push({ text: `⟨${NAMES[c.cp] && c.cp < 0x80 ? NAMES[c.cp] : c.flag.code}⟩`, flag: c.flag });
  }
  if (run) parts.push({ text: run });
  return { parts, count, hidden, lookalike };
}

/** The text with every flagged character replaced by its escape. */
export function revealText(text: string): string {
  return reveal(text).parts.map((p) => p.text).join('');
}

/** The one-line warning for a revealed text, naming what it is ("command", "path"); null when there is nothing to say. */
export function revealWarning(r: Revealed, noun: string): string | null {
  if (r.hidden) return `This ${noun} contains hidden characters`;
  if (r.lookalike) return `This ${noun} contains lookalike characters`;
  return null;
}

/**
 * The first lines of a revealed text, for a clamped view: at most `maxLines`
 * lines and about `maxChars` characters. An escape is never cut in half.
 */
export function clampParts(parts: readonly Shown[], maxChars: number, maxLines: number): { parts: Shown[]; cut: boolean } {
  const out: Shown[] = [];
  let chars = 0;
  let lines = 1;
  for (const part of parts) {
    if (part.flag) {
      if (chars + part.text.length > maxChars) return { parts: out, cut: true };
      out.push(part);
      chars += part.text.length;
      continue;
    }
    let take = '';
    for (const ch of part.text) {
      if (ch === '\n' && lines >= maxLines) { if (take) out.push({ text: take }); return { parts: out, cut: true }; }
      if (chars >= maxChars) { if (take) out.push({ text: take }); return { parts: out, cut: true }; }
      if (ch === '\n') lines++;
      take += ch;
      chars++;
    }
    if (take) out.push({ text: take });
  }
  return { parts: out, cut: false };
}

/** Whether the lookalike at `i` sits in a word that also has ASCII letters. */
/** Whether character `i` is in a token that reads as a host name, URL or path: ASCII letters with a dot, slash or colon. */
/**
 * For each character, whether the whitespace-free token it sits in reads as a
 * host name or path. One pass: a token is read once, however many lookalikes
 * it holds, so a long one cannot stall the window.
 */
function addresses(chars: readonly Char[]): boolean[] {
  const out = new Array<boolean>(chars.length).fill(false);
  let start = 0;
  for (let i = 0; i <= chars.length; i++) {
    if (i < chars.length && !/\s/.test((chars[i] as Char).ch)) continue;
    if (i > start) {
      const token = chars.slice(start, i).map((c) => c.ch).join('');
      if (/[./:]/.test(token) && ASCII_LETTER.test(token)) out.fill(true, start, i);
    }
    start = i + 1;
  }
  return out;
}

/**
 * Whether the word around a character holds an ASCII letter: the word it is in,
 * or, for a character that is not itself part of a word, the words on either side.
 */
function mixedWords(chars: readonly Char[]): (i: number) => boolean {
  const word = chars.map((c) => WORD.test(c.ch));
  const ascii = new Array<boolean>(chars.length).fill(false);
  for (let s = 0; s < chars.length;) {
    if (!word[s]) { s++; continue; }
    let e = s;
    let any = false;
    while (e < chars.length && word[e]) { if (ASCII_LETTER.test((chars[e] as Char).ch)) any = true; e++; }
    if (any) ascii.fill(true, s, e);
    s = e;
  }
  return (i) => (word[i] ? ascii[i] === true : (i > 0 && ascii[i - 1] === true) || ascii[i + 1] === true);
}
