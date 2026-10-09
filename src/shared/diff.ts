// A unified diff, read into lines a review can show: line numbers on both
// sides, the changed words in an edited line, syntax colour, and the rows of a
// side-by-side view. Pure, so each rule is tested.
import { START, hunkState, languageFor, tokenizeLine, type Span, type State } from './syntax.ts';

export interface DiffLine {
  kind: 'add' | 'del' | 'ctx' | 'hunk' | 'meta';
  text: string;
  old: number | null;
  new: number | null;
  /** The changed part of a line paired with its counterpart, as [start, end). */
  changed?: [number, number];
  /** Unchanged lines git left out before this hunk. */
  skipped?: number;
  /** Syntax colour over `text`, when the file's language is known and the file is not too big. */
  syntax?: Span[];
}

const HEADER = /^(?:diff --git|index |--- |\+\+\+ |new file|deleted file|similarity|rename |old mode|new mode)/;

export function parseDiff(diff: string): DiffLine[] {
  const out: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  // Lines still to come in the current hunk, from its header. Inside a hunk every
  // line is content, so a removed "-- comment" or an added "++ x" is never taken
  // for a file header and dropped.
  let oldLeft = 0;
  let newLeft = 0;
  for (const raw of diff.split('\n')) {
    // Content never starts with these, so a hunk shorter than its header ends here.
    if (raw.startsWith('@@') || raw.startsWith('diff --git ')) oldLeft = newLeft = 0;
    if (oldLeft > 0 || newLeft > 0) {
      if (raw.startsWith('+')) {
        out.push({ kind: 'add', text: raw.slice(1), old: null, new: newNo++ });
        newLeft--;
      } else if (raw.startsWith('-')) {
        out.push({ kind: 'del', text: raw.slice(1), old: oldNo++, new: null });
        oldLeft--;
      } else if (raw.startsWith('\\')) {
        out.push({ kind: 'meta', text: raw.slice(2), old: null, new: null });
      } else {
        out.push({ kind: 'ctx', text: raw.slice(1), old: oldNo++, new: newNo++ });
        oldLeft--;
        newLeft--;
      }
    } else if (raw.startsWith('@@')) {
      const m = raw.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)/);
      const start = Number(m?.[3] ?? 0);
      // The lines between the last hunk and this one are unchanged; say how many.
      const skipped = Math.max(0, start - (newNo || 1));
      oldNo = Number(m?.[1] ?? 0);
      newNo = start;
      oldLeft = Number(m?.[2] ?? 1);
      newLeft = Number(m?.[4] ?? 1);
      out.push({ kind: 'hunk', text: m?.[5]?.trim() ?? '', old: null, new: null, skipped });
    } else if (HEADER.test(raw)) {
      continue;
    } else if (raw.startsWith('+')) {
      out.push({ kind: 'add', text: raw.slice(1), old: null, new: newNo++ });
    } else if (raw.startsWith('-')) {
      out.push({ kind: 'del', text: raw.slice(1), old: oldNo++, new: null });
    } else if (raw.startsWith('\\')) {
      out.push({ kind: 'meta', text: raw.slice(2), old: null, new: null });
    } else if (raw.length || out.length) {
      out.push({ kind: 'ctx', text: raw.slice(1), old: oldNo++, new: newNo++ });
    }
  }
  while (out.length && out[out.length - 1]?.kind === 'ctx' && !out[out.length - 1]?.text) out.pop();
  pairWords(out);
  return out;
}

/**
 * A run of removed lines followed by as many added ones is usually the same
 * lines edited: mark the part of each that changed, so a one-word edit reads
 * as one word rather than two whole lines.
 */
function pairWords(lines: DiffLine[]): void {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]?.kind !== 'del') continue;
    let d = i;
    while (lines[d]?.kind === 'del') d++;
    let a = d;
    while (lines[a]?.kind === 'add') a++;
    if (a - d === d - i) {
      for (let k = 0; k < d - i; k++) {
        const del = lines[i + k] as DiffLine;
        const add = lines[d + k] as DiffLine;
        let pre = 0;
        while (pre < del.text.length && pre < add.text.length && del.text[pre] === add.text[pre]) pre++;
        let suf = 0;
        while (suf < del.text.length - pre && suf < add.text.length - pre
          && del.text[del.text.length - 1 - suf] === add.text[add.text.length - 1 - suf]) suf++;
        // Only worth marking when most of the line stayed the same.
        if (pre + suf >= Math.min(del.text.length, add.text.length) * 0.4) {
          del.changed = [pre, del.text.length - suf];
          add.changed = [pre, add.text.length - suf];
        }
      }
    }
    i = a - 1;
  }
}

/** Past these, a file's diff is shown plain: colour would cost more than it gives. */
export const MAX_COLOUR_LINES = 5000;
export const MAX_COLOUR_CHARS = 200_000;

/**
 * Syntax colour for each line, in place. The old file and the new one each
 * keep their own state (a comment opened on a removed line does not colour
 * the added ones), context lines advance both, and each hunk starts afresh
 * from a guess at its first line, since what came before it is not shown.
 */
export function highlightDiff(lines: DiffLine[], path: string): DiffLine[] {
  const lang = languageFor(path);
  if (!lang || lines.length > MAX_COLOUR_LINES) return lines;
  let chars = 0;
  for (const l of lines) chars += l.text.length;
  if (chars > MAX_COLOUR_CHARS) return lines;
  let before: State = START;
  let after: State = START;
  lines.forEach((l, i) => {
    if (l.kind === 'hunk') {
      // Each side's opening lines, as that file reads.
      const side = (kind: 'del' | 'add'): string[] => {
        const out: string[] = [];
        for (let j = i + 1; j < lines.length && lines[j]?.kind !== 'hunk' && out.length < 30; j++) {
          const k = lines[j]?.kind;
          if (k === 'ctx' || k === kind) out.push(lines[j]?.text ?? '');
        }
        return out;
      };
      before = hunkState(lang, side('del'));
      after = hunkState(lang, side('add'));
    } else if (l.kind === 'del') {
      ({ spans: l.syntax, state: before } = tokenizeLine(lang, l.text, before));
    } else if (l.kind === 'add') {
      ({ spans: l.syntax, state: after } = tokenizeLine(lang, l.text, after));
    } else if (l.kind === 'ctx') {
      const same = before.in === after.in && before.close === after.close && before.n === after.n;
      ({ spans: l.syntax, state: after } = tokenizeLine(lang, l.text, after));
      before = same ? after : tokenizeLine(lang, l.text, before).state;
    }
  });
  return lines;
}

/** A stretch of a line to draw: its text and its colour (null is plain). */
export interface Piece { text: string; kind: Span[2] | null }

/** The stretch [from, to) of a line, cut into coloured pieces. */
export function pieces(text: string, spans: readonly Span[] | undefined, from = 0, to = text.length): Piece[] {
  const out: Piece[] = [];
  let at = from;
  for (const [s, e, kind] of spans ?? []) {
    if (e <= at) continue;
    if (s >= to) break;
    if (s > at) out.push({ text: text.slice(at, s), kind: null });
    const end = Math.min(e, to);
    out.push({ text: text.slice(Math.max(s, at), end), kind });
    at = end;
  }
  if (at < to) out.push({ text: text.slice(at, to), kind: null });
  return out;
}

/** A row of the side-by-side view: the old line on the left, the new on the right. */
export type SplitRow =
  | { kind: 'pair'; left: DiffLine | null; right: DiffLine | null }
  | { kind: 'hunk' | 'meta'; line: DiffLine };

/**
 * Old and new side by side, aligned. A context line sits on both sides; a run
 * of removed lines and the added lines after it pair up row by row (the first
 * removed with the first added), and the longer run's extra lines face blanks.
 */
export function splitRows(lines: readonly DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i] as DiffLine;
    if (l.kind === 'ctx') { rows.push({ kind: 'pair', left: l, right: l }); i++; continue; }
    if (l.kind === 'hunk' || l.kind === 'meta') { rows.push({ kind: l.kind, line: l }); i++; continue; }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    const notes: DiffLine[] = [];
    while (lines[i]?.kind === 'del' || (lines[i]?.kind === 'meta' && dels.length && !adds.length)) {
      (lines[i]?.kind === 'del' ? dels : notes).push(lines[i] as DiffLine);
      i++;
    }
    while (lines[i]?.kind === 'add' || (lines[i]?.kind === 'meta' && adds.length)) {
      (lines[i]?.kind === 'add' ? adds : notes).push(lines[i] as DiffLine);
      i++;
    }
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) rows.push({ kind: 'pair', left: dels[k] ?? null, right: adds[k] ?? null });
    for (const note of notes) rows.push({ kind: 'meta', line: note });
  }
  return rows;
}

/**
 * Where a review note on this line attaches: a removed line by its number in
 * the old file, an added or unchanged line by its number in the new one, as
 * `reviewMessage` expects. Null for a line that is not code.
 */
export function noteTarget(l: DiffLine): { line: number; side: 'new' | 'old' } | null {
  if (l.kind === 'hunk' || l.kind === 'meta') return null;
  if (l.new !== null) return { line: l.new, side: 'new' };
  if (l.old !== null) return { line: l.old, side: 'old' };
  return null;
}

/**
 * A short fingerprint of a file's diff, so a "viewed" mark is kept only while
 * the diff it was given to stays the same (cyrb53: fast, and plenty for this).
 */
export function diffHash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
