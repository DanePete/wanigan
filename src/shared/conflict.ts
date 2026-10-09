// A conflicted file, read into the parts a person resolves: the text both sides
// agree on, and each conflict with its two sides (and the base they came from,
// in diff3 style). Then the file again, from the choices made: a side, both
// sides in either order, the base, or text written by hand. Pure, so every
// rule is tested without a repository.
//
// A marker is a whole line, at the start of the line, of seven or more of its
// character (git uses more for a conflict inside a conflict), and a conflict is
// only a run of them in order: open, optionally base, split, close. A line in
// a string or a comment that merely contains "<<<<<<<" is text, and so is an
// opening marker with no split and close after it.

/** How a file came to conflict, as `git status` letters it. */
export type ConflictCode = 'UU' | 'AA' | 'DU' | 'UD' | 'AU' | 'UA' | 'DD';

export interface ConflictHunk {
  index: number;
  ours: string[];
  /** What both sides came from; null when git did not write it (merge style rather than diff3). */
  base: string[] | null;
  theirs: string[];
  oursLabel: string;
  baseLabel: string | null;
  theirsLabel: string;
  /** Where its opening marker is, 1-based, in the file as written. */
  line: number;
}

export type ConflictSegment = { kind: 'text'; lines: string[] } | { kind: 'conflict'; hunk: ConflictHunk };

export interface ParsedConflicts {
  segments: ConflictSegment[];
  hunks: ConflictHunk[];
  eol: '\n' | '\r\n';
  /** The file ends with a newline. */
  finalNewline: boolean;
}

export type HunkChoice = 'ours' | 'theirs' | 'ours-then-theirs' | 'theirs-then-ours' | 'base' | { text: string };

const marker = (line: string, char: string, size: number, label: boolean): string | null => {
  const run = char.repeat(size);
  if (!line.startsWith(run)) return null;
  const rest = line.slice(size);
  if (rest === '') return '';
  if (rest.startsWith(char)) return null;
  return label && rest.startsWith(' ') ? rest.slice(1) : null;
};

/** Every conflict in a file's text, and the text around them. */
export function parseConflicts(text: string): ParsedConflicts {
  const crlf = /\r\n/.test(text) && !/(^|[^\r])\n/.test(text);
  const eol = crlf ? '\r\n' : '\n';
  const finalNewline = text.endsWith('\n');
  const lines = (finalNewline ? text.slice(0, text.endsWith('\r\n') ? -2 : -1) : text).split(/\r?\n/);
  if (text === '') lines.length = 0;
  const segments: ConflictSegment[] = [];
  const hunks: ConflictHunk[] = [];
  let plain: string[] = [];
  const flush = (): void => { if (plain.length) segments.push({ kind: 'text', lines: plain }); plain = []; };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    const open = /^(<{7,})(?: |$)/.exec(line);
    const found = open ? read(lines, i, (open[1] as string).length) : null;
    if (!found) { plain.push(line); i++; continue; }
    flush();
    const hunk: ConflictHunk = { ...found.hunk, index: hunks.length, line: i + 1 };
    hunks.push(hunk);
    segments.push({ kind: 'conflict', hunk });
    i = found.next;
  }
  flush();
  return { segments, hunks, eol, finalNewline };
}

/** One conflict starting at `at`, if the markers after it are all there, in order. */
function read(lines: readonly string[], at: number, size: number): { hunk: Omit<ConflictHunk, 'index' | 'line'>; next: number } | null {
  const oursLabel = marker(lines[at] as string, '<', size, true);
  if (oursLabel === null) return null;
  const ours: string[] = [];
  let base: string[] | null = null;
  let baseLabel: string | null = null;
  const theirs: string[] = [];
  let part: 'ours' | 'base' | 'theirs' = 'ours';
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i] as string;
    if (part === 'ours' && marker(line, '|', size, true) !== null) { part = 'base'; base = []; baseLabel = marker(line, '|', size, true); continue; }
    if ((part === 'ours' || part === 'base') && marker(line, '=', size, false) === '') { part = 'theirs'; continue; }
    if (part === 'theirs') {
      const close = marker(line, '>', size, true);
      if (close !== null) return { hunk: { ours, base, theirs, oursLabel, baseLabel, theirsLabel: close }, next: i + 1 };
      theirs.push(line);
      continue;
    }
    // A second opening of the same size before this one closed: this one was not a conflict.
    if (marker(line, '<', size, true) !== null) return null;
    (part === 'ours' ? ours : base as string[]).push(line);
  }
  return null;
}

/** The lines a choice puts in place of a hunk. */
export function chosenLines(hunk: ConflictHunk, choice: HunkChoice): string[] {
  if (typeof choice === 'object') {
    const t = choice.text.replace(/\r\n/g, '\n');
    return t === '' ? [] : (t.endsWith('\n') ? t.slice(0, -1) : t).split('\n');
  }
  switch (choice) {
    case 'ours': return hunk.ours;
    case 'theirs': return hunk.theirs;
    case 'ours-then-theirs': return [...hunk.ours, ...hunk.theirs];
    case 'theirs-then-ours': return [...hunk.theirs, ...hunk.ours];
    case 'base': return hunk.base ?? [];
  }
}

/** A hunk not yet resolved, written back as git wrote it. */
function markers(hunk: ConflictHunk): string[] {
  const label = (char: string, text: string | null): string => `${char.repeat(7)}${text ? ` ${text}` : ''}`;
  return [
    label('<', hunk.oursLabel), ...hunk.ours,
    ...(hunk.base ? [label('|', hunk.baseLabel), ...hunk.base] : []),
    '=======', ...hunk.theirs, label('>', hunk.theirsLabel),
  ];
}

/** The file from the choices made; a hunk with no choice keeps its markers, and is counted in `left`. */
export function resolveConflicts(parsed: ParsedConflicts, choices: ReadonlyMap<number, HunkChoice>): { text: string; left: number } {
  const out: string[] = [];
  let left = 0;
  for (const s of parsed.segments) {
    if (s.kind === 'text') { out.push(...s.lines); continue; }
    const choice = choices.get(s.hunk.index);
    if (choice === undefined) { left++; out.push(...markers(s.hunk)); } else out.push(...chosenLines(s.hunk, choice));
  }
  const body = out.join(parsed.eol);
  return { text: out.length && parsed.finalNewline ? `${body}${parsed.eol}` : body, left };
}

/** How many whole conflicts a text still holds. */
export const conflictCount = (text: string): number => parseConflicts(text).hunks.length;

/** What each unmerged state means, and what can be done about it, in words. */
export const CONFLICT_STATES: Record<ConflictCode, { what: string; ours: string; theirs: string }> = {
  UU: { what: 'Both sides changed it', ours: 'Keep ours', theirs: 'Keep theirs' },
  AA: { what: 'Both sides added a file here', ours: 'Keep ours', theirs: 'Keep theirs' },
  DU: { what: 'We deleted it; they changed it', ours: 'Delete it', theirs: 'Keep their version' },
  UD: { what: 'We changed it; they deleted it', ours: 'Keep our version', theirs: 'Delete it' },
  AU: { what: 'Only we added it', ours: 'Keep it', theirs: 'Delete it' },
  UA: { what: 'Only they added it', ours: 'Delete it', theirs: 'Keep it' },
  DD: { what: 'Both sides deleted it', ours: 'Delete it', theirs: 'Delete it' },
};
