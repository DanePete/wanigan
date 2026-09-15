/**
 * Which hunks of a file the session's own turns produced, for "Stage only the
 * session's hunks".
 *
 * The per-turn checkpoints divide a file's history into intervals: the session's
 * turns (turn-start snapshot to turn-end snapshot) and everything else (launch
 * to the first turn, the gaps between turns, and the last turn to the working
 * tree now). A change in a turn interval was made while the agent held the
 * turn; a change in any other interval was not. Staging the turn intervals'
 * patches and nothing else leaves the operator's own edits unstaged.
 *
 * That is exact only while the two kinds of change stay apart in the file. When
 * an edit outside the turns lands on or next to lines a turn changed, the
 * patches share context and the split is a guess — so the file is refused, with
 * the reason, rather than staged half right. Refusing is also the answer when a
 * file was edited outside the turns more than once, because the line numbers of
 * the intervals no longer line up and overlap cannot be decided honestly.
 *
 * Git applies the patches afterwards; this decides which ones, and whether to
 * try at all.
 */

export type Interval = {
  kind: 'turn' | 'outside';
  /** The turn number for a turn interval; null outside. */
  turn: number | null;
  /** This file's patch across the interval; empty when the file did not change in it. */
  patch: string;
  /** Words for a refusal: "between turn 2 and turn 3", "after the last turn". */
  label: string;
};

export type StagingDecision =
  | { action: 'none' }
  | { action: 'stage'; turns: number[]; mixed: boolean }
  | { action: 'refuse'; reason: string };

/** git apply's default context; an outside edit this close to a turn's change shares its context. */
export const CONTEXT_SLACK = 3;

type Range = [number, number];

/**
 * The lines a patch changed on each side, as inclusive ranges. A pure insertion
 * has no old lines; it is placed at the line it follows so an edit touching that
 * spot still counts as adjacent.
 */
export function hunkRanges(patch: string): { old: Range[]; new: Range[] } {
  const out = { old: [] as Range[], new: [] as Range[] };
  let oldLine = 0, newLine = 0, oldLeft = 0, newLeft = 0;
  let oldRun: number | null = null, newRun: number | null = null;
  // Where a block of changed lines began on each side, so a block that only
  // added (or only removed) still marks its place on the other side.
  let oldAt = 0, newAt = 0;
  const flush = () => {
    if (oldRun === null && newRun === null) return;
    out.old.push(oldRun !== null ? [oldRun, Math.max(oldRun, oldLine - 1)] : [Math.max(1, oldAt - 1), Math.max(1, oldAt - 1)]);
    out.new.push(newRun !== null ? [newRun, Math.max(newRun, newLine - 1)] : [Math.max(1, newAt - 1), Math.max(1, newAt - 1)]);
    oldRun = null; newRun = null;
  };
  for (const text of patch.split('\n')) {
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(text);
    if (h) {
      flush();
      oldLine = Number(h[1]); newLine = Number(h[3]);
      oldLeft = h[2] === undefined ? 1 : Number(h[2]);
      newLeft = h[4] === undefined ? 1 : Number(h[4]);
      // A zero count names the line before the change.
      if (oldLeft === 0) oldLine += 1;
      if (newLeft === 0) newLine += 1;
      continue;
    }
    if (oldLeft <= 0 && newLeft <= 0) continue;
    const adding = text.startsWith('+') && !text.startsWith('+++');
    const removing = text.startsWith('-') && !text.startsWith('---');
    if ((adding || removing) && oldRun === null && newRun === null) { oldAt = oldLine; newAt = newLine; }
    if (adding) {
      if (newRun === null) newRun = newLine;
      newLine += 1; newLeft -= 1;
    } else if (removing) {
      if (oldRun === null) oldRun = oldLine;
      oldLine += 1; oldLeft -= 1;
    } else if (text.startsWith(' ')) {
      flush();
      oldLine += 1; newLine += 1; oldLeft -= 1; newLeft -= 1;
    }
  }
  flush();
  return out;
}

export function rangesTouch(a: readonly Range[], b: readonly Range[], slack = CONTEXT_SLACK): boolean {
  return a.some(([s1, e1]) => b.some(([s2, e2]) => s1 <= e2 + slack && s2 <= e1 + slack));
}

/** A binary patch has no line ranges to compare, so a mixed binary file is always refused. */
function isBinary(patch: string): boolean {
  return /^GIT binary patch$|^Binary files /m.test(patch);
}

/**
 * The decision for one file, from its intervals in chronological order.
 *
 * `stretches` carries the file's patch across all the turns on each side of an
 * outside edit — launch to where the edit began, and where it ended to the last
 * turn's snapshot. With only one outside edit, every interval in a stretch is a
 * turn, so a stretch is exactly the session's cumulative change there and its
 * line numbers meet the outside edit's: the before stretch ends where the edit
 * begins, the after stretch begins where it ends. Main asks git for them only
 * when a file turns out to be mixed.
 */
export function decideFileStaging(
  path: string,
  intervals: readonly Interval[],
  stretches?: { before: string; after: string },
): StagingDecision {
  const changed = intervals.map((iv, i) => ({ ...iv, i })).filter((iv) => iv.patch.trim() !== '');
  const turns = changed.filter((iv) => iv.kind === 'turn');
  const outside = changed.filter((iv) => iv.kind === 'outside');
  if (!turns.length) return { action: 'none' };
  if (!outside.length) return { action: 'stage', turns: turns.map((t) => t.turn ?? 0), mixed: false };
  if (outside.length > 1) {
    return { action: 'refuse', reason: `\`${path}\` was also changed outside the session's turns ${outside.length} times (${outside.map((o) => o.label).join(', ')}), so which hunk is whose cannot be told apart reliably.` };
  }
  const other = outside[0];
  if (isBinary(other.patch) || turns.some((t) => isBinary(t.patch))) {
    return { action: 'refuse', reason: `\`${path}\` is a binary file changed both inside and outside the session's turns; it has no hunks to separate.` };
  }
  if (!stretches) {
    return { action: 'refuse', reason: `\`${path}\` was changed both inside and outside the session's turns, and the turns' combined change could not be read to separate them.` };
  }
  const otherRanges = hunkRanges(other.patch);
  if (stretches.before.trim() && rangesTouch(hunkRanges(stretches.before).new, otherRanges.old)) {
    return { action: 'refuse', reason: `An edit to \`${path}\` ${other.label} touches lines the session's earlier turns changed, so the two cannot be staged apart.` };
  }
  if (stretches.after.trim() && rangesTouch(hunkRanges(stretches.after).old, otherRanges.new)) {
    return { action: 'refuse', reason: `The session's later turns changed lines of \`${path}\` that were edited ${other.label}, so the two cannot be staged apart.` };
  }
  return { action: 'stage', turns: turns.map((t) => t.turn ?? 0), mixed: true };
}
