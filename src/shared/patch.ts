// Patches for part of a file: one hunk, or the lines the owner picked, built
// from git's own diff of that file so `git apply` can stage, unstage or discard
// exactly that much. Pure, so every edge (a file with no last newline, a hunk
// after a dropped one, a new file) is tested without a repository.
//
// The rule, for a diff whose old side is what the target holds now:
//   forward (stage: apply --cached)       picked lines stay; an unpicked added
//                                         line is dropped; an unpicked removed
//                                         line stays as context.
//   reverse (unstage: apply --cached -R,  picked lines stay; an unpicked removed
//            discard: apply -R)           line is dropped; an unpicked added
//                                         line stays as context.
// So the side the target holds is kept whole, and only the picked lines change.

export type PatchMode = 'forward' | 'reverse';

/** Lines picked in a diff: removed lines by their old number, added lines by their new number. */
export interface LinePick {
  old: number[];
  new: number[];
}

interface HunkLine {
  sign: '+' | '-' | ' ';
  text: string;
  old: number | null;
  new: number | null;
  /** Followed by git's "\ No newline at end of file". */
  noNewline: boolean;
}

interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  /** What git printed after the second @@: the enclosing function, usually. */
  section: string;
  lines: HunkLine[];
}

export interface FilePatch {
  /** Everything before the first hunk: `diff --git`, modes, `---` and `+++`. */
  header: string[];
  hunks: Hunk[];
  binary: boolean;
  /** Created, deleted or renamed: header lines that a partial patch must change or cannot keep. */
  created: boolean;
  deleted: boolean;
  renamed: boolean;
}

const NO_NEWLINE = '\\ No newline at end of file';

/** One file's unified diff (`git diff -- <path>`), read into its header and hunks. */
export function parseFilePatch(diff: string): FilePatch {
  const out: FilePatch = { header: [], hunks: [], binary: false, created: false, deleted: false, renamed: false };
  const raw = diff.split('\n');
  // The empty string after a final newline is not a line.
  if (raw.at(-1) === '') raw.pop();
  let hunk: Hunk | null = null;
  let oldLeft = 0;
  let newLeft = 0;
  let oldNo = 0;
  let newNo = 0;
  for (const line of raw) {
    if (hunk && (oldLeft > 0 || newLeft > 0)) {
      const sign = line[0];
      const text = line.slice(1);
      if (sign === '+') { hunk.lines.push({ sign: '+', text, old: null, new: newNo++, noNewline: false }); newLeft--; continue; }
      if (sign === '-') { hunk.lines.push({ sign: '-', text, old: oldNo++, new: null, noNewline: false }); oldLeft--; continue; }
      if (sign === '\\') { const last = hunk.lines.at(-1); if (last) last.noNewline = true; continue; }
      hunk.lines.push({ sign: ' ', text, old: oldNo++, new: newNo++, noNewline: false });
      oldLeft--;
      newLeft--;
      continue;
    }
    if (line.startsWith('\\') && hunk) {
      // The marker after the last line of a hunk.
      const last = hunk.lines.at(-1);
      if (last) last.noNewline = true;
      continue;
    }
    const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/);
    if (m) {
      hunk = {
        oldStart: Number(m[1]), oldCount: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]), newCount: m[4] === undefined ? 1 : Number(m[4]),
        section: m[5] ?? '', lines: [],
      };
      out.hunks.push(hunk);
      oldLeft = hunk.oldCount;
      newLeft = hunk.newCount;
      oldNo = hunk.oldStart;
      newNo = hunk.newStart;
      continue;
    }
    if (out.hunks.length) continue; // nothing git prints follows the hunks of one file
    out.header.push(line);
    if (/^new file mode /.test(line) || line === '--- /dev/null') out.created = true;
    if (/^deleted file mode /.test(line) || line === '+++ /dev/null') out.deleted = true;
    if (/^rename (?:from|to) |^copy (?:from|to) /.test(line)) out.renamed = true;
    if (/^Binary files |^GIT binary patch/.test(line)) out.binary = true;
  }
  return out;
}

/** Every changed line of one hunk, as a pick. */
export function hunkPick(diff: string, index: number): LinePick {
  const hunk = parseFilePatch(diff).hunks[index];
  if (!hunk) return { old: [], new: [] };
  return {
    old: hunk.lines.flatMap((l) => (l.sign === '-' && l.old !== null ? [l.old] : [])),
    new: hunk.lines.flatMap((l) => (l.sign === '+' && l.new !== null ? [l.new] : [])),
  };
}

/** How many changed lines a pick names that the diff has. */
export function pickedCount(diff: string, pick: LinePick): number {
  const olds = new Set(pick.old);
  const news = new Set(pick.new);
  let n = 0;
  for (const h of parseFilePatch(diff).hunks) {
    for (const l of h.lines) if ((l.sign === '-' && olds.has(l.old as number)) || (l.sign === '+' && news.has(l.new as number))) n++;
  }
  return n;
}

/**
 * Why a part of this diff cannot be applied on its own, or null when it can.
 * Binary files have no lines; a rename's header names two files, which a part
 * of it cannot honestly keep.
 */
export function partProblem(diff: string): string | null {
  const p = parseFilePatch(diff);
  if (p.binary) return 'A binary file has no lines to pick; stage or discard it whole.';
  if (p.renamed) return 'A renamed file is staged or unstaged whole, so its rename stays one change.';
  if (!p.hunks.length) return 'This file has no changed lines (only its mode changed, say); stage or discard it whole.';
  return null;
}

/**
 * The patch that applies only the picked lines of `diff`, for `mode`, or null
 * when the pick names no line of it. At the end of a file with no last
 * newline, a pick grows just enough for git to apply it (see endOfFile).
 */
export function buildPatch(diff: string, pick: LinePick, mode: PatchMode): string | null {
  const file = parseFilePatch(diff);
  if (file.binary || file.renamed) return null;
  const olds = new Set(pick.old);
  const news = new Set(pick.new);
  const picked = (l: HunkLine): boolean => (l.sign === '-' ? olds.has(l.old as number) : l.sign === '+' ? news.has(l.new as number) : false);

  const hunks: string[] = [];
  let partial = false;
  let delta = 0;
  for (const h of file.hunks) {
    const take = h.lines.map(picked);
    for (let i = 0; i < h.lines.length;) {
      if (h.lines[i]?.sign === ' ') { i++; continue; }
      let j = i;
      while (j < h.lines.length && h.lines[j]?.sign !== ' ') j++;
      if (h.lines.slice(i, j).some((l) => l.noNewline)) endOfFile(h.lines, take, i, j, mode);
      i = j;
    }
    if (!take.some(Boolean)) {
      if (h.lines.some((l) => l.sign !== ' ')) partial = true;
      continue;
    }
    const body: string[] = [];
    let oldCount = 0;
    let newCount = 0;
    h.lines.forEach((l, i) => {
      let sign: '+' | '-' | ' ' | null = l.sign;
      if (l.sign !== ' ' && !take[i]) {
        partial = true;
        const kept = mode === 'forward' ? '-' : '+';
        sign = l.sign === kept ? ' ' : null;
      }
      if (sign === null) return;
      body.push(`${sign}${l.text}`);
      if (l.noNewline) body.push(NO_NEWLINE);
      if (sign !== '+') oldCount++;
      if (sign !== '-') newCount++;
    });
    // The side the target holds keeps its place; the other side follows the changes made so far.
    let oldStart: number;
    let newStart: number;
    if (mode === 'forward') {
      oldStart = h.oldStart;
      const at = (h.oldCount > 0 ? h.oldStart : h.oldStart + 1) + delta;
      newStart = newCount > 0 ? at : at - 1;
      delta += newCount - oldCount;
    } else {
      newStart = h.newStart;
      const at = (h.newCount > 0 ? h.newStart : h.newStart + 1) + delta;
      oldStart = oldCount > 0 ? at : at - 1;
      delta += oldCount - newCount;
    }
    hunks.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${h.section ? ` ${h.section}` : ''}`, ...body);
  }
  if (!hunks.length) return null;
  return [...partHeader(file, partial, mode), ...hunks].join('\n') + '\n';
}

/**
 * A run of changes at the end of a file whose last line has no newline. Git
 * cannot apply a line that lacks its newline followed by another line, so a
 * pick there grows just enough to stay applicable:
 *   - a line whose only change is its ending ("-b" and "+b") is one change:
 *     picking either side picks both;
 *   - staging, a removed last line kept as context cannot have added lines
 *     after it, so it is picked with them;
 *   - unstaging or discarding, a removed last line brought back cannot have
 *     added lines kept after it, so they are picked with it.
 */
function endOfFile(lines: readonly HunkLine[], take: boolean[], from: number, to: number, mode: PatchMode): void {
  const twins = (): void => {
    for (let i = from; i < to; i++) {
      if (!take[i]) continue;
      const l = lines[i] as HunkLine;
      for (let k = from; k < to; k++) {
        const o = lines[k] as HunkLine;
        if (k !== i && o.sign !== l.sign && o.text === l.text && (o.noNewline || l.noNewline)) take[k] = true;
      }
    }
  };
  twins();
  for (let i = from; i < to; i++) {
    const l = lines[i] as HunkLine;
    if (l.sign !== '-' || !l.noNewline) continue;
    const laterAdds = Array.from({ length: to - i - 1 }, (_, k) => i + 1 + k).filter((k) => lines[k]?.sign === '+');
    if (mode === 'forward' && !take[i] && laterAdds.some((k) => take[k])) take[i] = true;
    if (mode === 'reverse' && take[i]) for (const k of laterAdds) take[k] = true;
  }
  twins();
}

/**
 * The header a patch of part of a file needs. The side the target holds is
 * kept as it is; the other side is what a part changes. So a part of a new file
 * is still a creation when staged (the index has no file yet), but not when
 * unstaged (the index keeps the file, with fewer lines); a part of a deletion
 * is not a deletion when staged (the file stays, with fewer lines), but is when
 * unstaged (applied in reverse it brings back only the picked lines). The
 * `index` and mode lines name blobs and modes a part does not produce.
 */
function partHeader(file: FilePatch, partial: boolean, mode: PatchMode): string[] {
  if (!partial) return file.header;
  const path = targetPath(file);
  const forward = mode === 'forward';
  const out: string[] = [];
  for (const line of file.header) {
    if (/^index /.test(line) || /^(?:old|new) mode /.test(line)) continue;
    if (/^new file mode /.test(line)) { if (forward) out.push(line); continue; }
    if (/^deleted file mode /.test(line)) { if (!forward) out.push(line); continue; }
    if (line === '--- /dev/null' && !forward) { out.push(`--- a/${path}`); continue; }
    if (line === '+++ /dev/null' && forward) { out.push(`+++ b/${path}`); continue; }
    out.push(line);
  }
  return out;
}

function targetPath(file: FilePatch): string {
  for (const line of file.header) {
    const m = line.match(/^(?:\+\+\+ b|--- a)\/(.+)$/);
    if (m?.[1]) return m[1];
  }
  const git = file.header.find((l) => l.startsWith('diff --git a/'));
  return git ? git.slice('diff --git a/'.length).split(' b/')[0] ?? '' : '';
}

export interface PatchFile {
  path: string;
  from?: string;
  status: 'M' | 'A' | 'D' | 'R';
  additions: number;
  deletions: number;
  binary: boolean;
  diff: string;
}

/** A patch of many files (`git stash show -p`), cut into one diff per file with its counts. */
export function splitPatch(patch: string): PatchFile[] {
  const out: PatchFile[] = [];
  const starts: number[] = [];
  const lines = patch.split('\n');
  lines.forEach((l, i) => { if (l.startsWith('diff --git ')) starts.push(i); });
  starts.forEach((start, k) => {
    const chunk = lines.slice(start, starts[k + 1] ?? lines.length);
    while (chunk.length && chunk.at(-1) === '') chunk.pop();
    const diff = `${chunk.join('\n')}\n`;
    const parsed = parseFilePatch(diff);
    const head = chunk[0] as string;
    const named = (prefix: string): string | null => {
      const line = parsed.header.find((l) => l.startsWith(prefix));
      return line ? line.slice(prefix.length) : null;
    };
    const plus = named('+++ b/');
    const minus = named('--- a/');
    const renamedTo = named('rename to ');
    const renamedFrom = named('rename from ');
    // Without ---/+++ (a binary or a mode change), the header line is all there is: "diff --git a/x b/x".
    const fallback = head.slice('diff --git a/'.length).split(' b/').at(-1) ?? '';
    const path = renamedTo ?? plus ?? minus ?? fallback;
    let additions = 0;
    let deletions = 0;
    for (const h of parsed.hunks) for (const l of h.lines) { if (l.sign === '+') additions++; else if (l.sign === '-') deletions++; }
    out.push({
      path, ...(renamedFrom ? { from: renamedFrom } : {}),
      status: parsed.renamed ? 'R' : parsed.created ? 'A' : parsed.deleted ? 'D' : 'M',
      additions, deletions, binary: parsed.binary, diff,
    });
  });
  return out;
}

/** A path git prints without quoting: no quote, backslash or control character. A patch can only name such a file plainly. */
export const plainPath = (path: string): boolean => !/["\\\u0000-\u001f\u007f]/.test(path) && !path.startsWith('/') && !path.split('/').includes('..');

/**
 * A new file's text as git's own diff of it: every line added, and the missing
 * last newline said, so a patch built from it recreates the file exactly.
 */
export function newFileDiff(path: string, text: string, executable = false): string {
  const header = [`diff --git a/${path} b/${path}`, `new file mode ${executable ? '100755' : '100644'}`, '--- /dev/null', `+++ b/${path}`];
  if (!text) return `${header.join('\n')}\n`;
  const ends = text.endsWith('\n');
  const lines = (ends ? text.slice(0, -1) : text).split('\n');
  return [...header, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`), ...(ends ? [] : [NO_NEWLINE])].join('\n') + '\n';
}
