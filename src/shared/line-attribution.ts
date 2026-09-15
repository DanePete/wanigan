/**
 * Line-level attribution, computed locally from git: which session, and which
 * of its turns, added a line — and whether that line is still there.
 *
 * The pure half. It reads unified diffs and `git blame --porcelain`, keeps
 * ranges, and writes the Git AI authorship-log text a note carries. Everything
 * that runs git lives in main/line-attribution.ts.
 *
 * The rules, stated once:
 *
 *  - A line added by a commit made on the session's branch during the session's
 *    lifetime is the session's. Its turn is the last turn that had started when
 *    the commit was made, when checkpoints recorded turns.
 *  - A line added between a turn's start and end checkpoints is that turn's.
 *    Lines that appeared between turns (after one turn ended and before the
 *    next began) belong to nobody the record can name, and are not counted as
 *    the agent's.
 *  - "Who wrote this" is `git blame` on the file as it is now: a line blamed to
 *    a commit Wanigan attributed carries that session and turn; an uncommitted
 *    line is blamed again against the session's last checkpoint, and carries
 *    the turn whose checkpoint introduced it. Anything else is left unmarked —
 *    untracked, never guessed.
 */

export type Range = [start: number, end: number];

/** Sort, then merge overlapping and adjacent ranges. */
export function mergeRanges(ranges: readonly Range[]): Range[] {
  const sorted = ranges.filter(([s, e]) => Number.isInteger(s) && Number.isInteger(e) && s >= 1 && e >= s).map(([s, e]) => [s, e] as Range).sort((a, b) => a[0] - b[0]);
  const out: Range[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

export function rangeLines(ranges: readonly Range[]): number {
  return mergeRanges(ranges).reduce((n, [s, e]) => n + e - s + 1, 0);
}

/** "1-4,9,12-14", the Git AI line-range format. */
export function rangeSpec(ranges: readonly Range[]): string {
  return mergeRanges(ranges).map(([s, e]) => (s === e ? String(s) : `${s}-${e}`)).join(',');
}

/** git quotes a path with unusual bytes as a C string: "a\tb.txt". */
function unquote(p: string): string {
  if (!p.startsWith('"')) return p;
  try { return JSON.parse(p.replace(/\\([0-7]{3})/g, (_m, o: string) => `\\u00${parseInt(o, 8).toString(16).padStart(2, '0')}`)) as string; } catch { return p.slice(1, -1); }
}

/**
 * Added line ranges per file, in the new file's line numbers, from a unified
 * diff — `git diff -U0` or any context width. Deleted files contribute nothing;
 * a binary file has no hunks and contributes nothing.
 */
export function addedRangesFromDiff(diff: string): Map<string, Range[]> {
  const out = new Map<string, Range[]>();
  let file: string | null = null;
  let newLine = 0;
  // Lines still owed to the current hunk, from its header. Counting them is
  // what keeps an added line whose text starts "++ " from being read as the
  // next file's header.
  let oldLeft = 0;
  let newLeft = 0;
  let run: Range | null = null;
  const flush = () => {
    if (run && file) out.set(file, [...(out.get(file) ?? []), run]);
    run = null;
  };
  for (const line of diff.split('\n')) {
    if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith('+')) {
        if (run && run[1] === newLine - 1) run[1] = newLine;
        else { flush(); run = [newLine, newLine]; }
        newLine++; newLeft--;
      } else if (line.startsWith('-')) {
        flush(); oldLeft--;
      } else if (line.startsWith(' ') || line === '') {
        flush(); newLine++; oldLeft--; newLeft--;
      }
      // "\ No newline at end of file" belongs to the line before it and counts for nothing.
      continue;
    }
    if (line.startsWith('diff --git ')) { flush(); file = null; continue; }
    if (line.startsWith('+++ ')) {
      flush();
      const target = line.slice(4).trim();
      file = target === '/dev/null' ? null : unquote(target).replace(/^b\//, '');
      continue;
    }
    const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      flush();
      oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
      newLine = Number(hunk[2]);
      newLeft = hunk[3] === undefined ? 1 : Number(hunk[3]);
      if (!file) { oldLeft = 0; newLeft = 0; }
    }
  }
  flush();
  for (const [f, ranges] of out) out.set(f, mergeRanges(ranges));
  return out;
}

export type BlameLine = { finalLine: number; commit: string; origLine: number; file: string };

const UNCOMMITTED = /^0{40}$/;
export function isUncommitted(commit: string): boolean {
  return UNCOMMITTED.test(commit);
}

/**
 * `git blame --porcelain` into one record per line of the final file. Each
 * group starts with "<sha> <orig> <final> [<count>]"; header lines follow the
 * first occurrence of a commit only; every line ends with a tab and its text.
 */
export function parseBlamePorcelain(text: string): BlameLine[] {
  const out: BlameLine[] = [];
  const fileOf = new Map<string, string>();
  let current: { commit: string; orig: number; final: number } | null = null;
  for (const line of text.split('\n')) {
    const head = /^([0-9a-f]{40}) (\d+) (\d+)(?: \d+)?$/.exec(line);
    if (head) { current = { commit: head[1], orig: Number(head[2]), final: Number(head[3]) }; continue; }
    if (!current) continue;
    if (line.startsWith('filename ')) { fileOf.set(current.commit, line.slice(9)); continue; }
    if (line.startsWith('\t')) {
      out.push({ finalLine: current.final, commit: current.commit, origLine: current.orig, file: fileOf.get(current.commit) ?? '' });
      current = null;
    }
  }
  return out;
}

export type Author = { sessionId: string; title: string; turn: number | null; origin: 'commit' | 'checkpoint' };
export type AnnotatedRange = { start: number; end: number } & Author;

/**
 * Consecutive lines with the same author become one range. `authorOf` decides
 * per blamed line; null leaves the line unmarked.
 */
export function annotate(lines: readonly BlameLine[], authorOf: (line: BlameLine) => Author | null): AnnotatedRange[] {
  const out: AnnotatedRange[] = [];
  const sorted = [...lines].sort((a, b) => a.finalLine - b.finalLine);
  for (const line of sorted) {
    const author = authorOf(line);
    if (!author) continue;
    const last = out[out.length - 1];
    if (last && last.end === line.finalLine - 1 && last.sessionId === author.sessionId && last.turn === author.turn && last.origin === author.origin) {
      last.end = line.finalLine;
    } else {
      out.push({ start: line.finalLine, end: line.finalLine, ...author });
    }
  }
  return out;
}

/** Whether a line blamed to `origLine` of a commit falls in the ranges that commit added. */
export function inRanges(ranges: readonly Range[] | undefined, line: number): boolean {
  return !!ranges && ranges.some(([s, e]) => line >= s && line <= e);
}

/** The turn a commit belongs to: the last turn that had started by the time it was made. */
export function turnAt(turnStarts: readonly { turn: number; at: number }[], at: number): number | null {
  let found: number | null = null;
  for (const t of [...turnStarts].sort((a, b) => a.at - b.at)) {
    if (t.at <= at) found = t.turn;
    else break;
  }
  return found;
}

/**
 * The turn a commit was made in.
 *
 * git keeps commit time in whole seconds and checkpoints are stamped in
 * milliseconds, so "the last turn that had started" is ambiguous when the next
 * turn began within the same second as the commit. An agent commits during a
 * turn, before that turn ends, so the commit belongs to the earliest turn that
 * had started by the end of the commit's second and had not ended before that
 * second began. A turn with no recorded end is still running.
 */
export function turnForCommit(turns: readonly { turn: number; startAt: number; endAt: number | null }[], commitSecondMs: number): number | null {
  const candidates = [...turns]
    .filter((t) => t.startAt <= commitSecondMs + 999 && (t.endAt === null || t.endAt >= commitSecondMs))
    .sort((a, b) => a.startAt - b.startAt);
  return candidates[0]?.turn ?? turnAt(turns.map((t) => ({ turn: t.turn, at: t.startAt })), commitSecondMs);
}

/* ── the Git AI authorship log ───────────────────────────────────────── */

export type NoteEntry = { file: string; key: string; ranges: Range[] };
export type NoteSession = { key: string; tool: string; id: string; model: string | null };

function notePath(file: string): string {
  return /[\s"]/.test(file) ? `"${file.replace(/"/g, '')}"` : file;
}

/**
 * An authorship log in the Git AI Standard v3.0.0 shape: attestation lines per
 * file, `---`, then metadata JSON. Prompts are never included — the standard
 * keeps them outside git, and Wanigan keeps them out of notes altogether.
 */
export function authorshipNote(input: { baseCommit: string; entries: NoteEntry[]; sessions: NoteSession[]; generator: string }): string {
  const byFile = new Map<string, NoteEntry[]>();
  for (const e of input.entries) {
    const spec = rangeSpec(e.ranges);
    if (!spec) continue;
    byFile.set(e.file, [...(byFile.get(e.file) ?? []), { ...e, ranges: mergeRanges(e.ranges) }]);
  }
  const lines: string[] = [];
  for (const file of [...byFile.keys()].sort()) {
    lines.push(notePath(file));
    for (const e of byFile.get(file)!) lines.push(`  ${e.key} ${rangeSpec(e.ranges)}`);
  }
  const sessions: Record<string, { agent_id: { tool: string; id: string; model?: string } }> = {};
  for (const s of input.sessions) {
    const id = s.key.split('::')[0];
    sessions[id] = { agent_id: { tool: s.tool, id: s.id, ...(s.model ? { model: s.model } : {}) } };
  }
  const metadata = {
    schema_version: 'authorship/3.0.0',
    git_ai_version: input.generator,
    base_commit_sha: input.baseCommit,
    prompts: {},
    sessions,
  };
  return `${lines.join('\n')}\n---\n${JSON.stringify(metadata, null, 2)}\n`;
}

/* ── what the renderer shows per session ─────────────────────────────── */

export type AttributionSummary = {
  sessionId: string;
  computedAt: number | null;
  /** Lines added inside the agent's turns (turn-start to turn-end checkpoints); null when no checkpoints were recorded. */
  addedByTurns: number | null;
  /** Lines added by commits made on the session's branch during its lifetime. */
  addedInCommits: number;
  commits: number;
  /** Of the commits' added lines, how many git blame still finds there, and where it looked. */
  stillPresent: { lines: number; target: string; merged: boolean } | null;
  note: string | null;
};
