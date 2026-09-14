/**
 * The collision forecast, the part that needs no process: reading what
 * `git merge-tree --write-tree` said, and deciding what a pair of changes
 * amounts to. src/main/collisions.ts runs git and hands its output here.
 *
 * What a forecast is. Parallel sessions each work in their own worktree, and
 * the first time anyone learns two of them edited the same lines is at merge
 * time, after both have been reviewed. merge-tree performs the merge in the
 * object database without touching any working tree or index, so the question
 * "would these combine?" can be asked while the work is still in flight. The
 * answer is git's own — nothing here guesses at a conflict.
 *
 * What it is not. A clean forecast is not a clean landing: the base can move,
 * a third branch can land first, and two changes that merge textually can
 * still disagree about behaviour. That last case is why `overlap` exists as its
 * own outcome rather than being folded into `clean`.
 */

/** One side of a pair: a worktree's current state, or a branch tip. */
export type CollisionSide = {
  /** Null for the base branch as it stands in the repository. */
  worktree: string | null;
  branch: string | null;
  sessionId: string | null;
};

export type CollisionOutcome =
  /** git could not merge at least one path. */
  | 'conflicts'
  /** Both sides changed the same paths and git merged them without a conflict. */
  | 'overlap'
  /** No path was changed by both sides. */
  | 'clean'
  /** git did not answer — a missing ref, a timeout, a repository it could not read. */
  | 'unreadable';

export type CollisionPair = {
  kind: 'base' | 'peer';
  a: CollisionSide;
  b: CollisionSide;
  outcome: CollisionOutcome;
  /** Paths git reported as conflicted. Empty unless `conflicts`. */
  conflicted: string[];
  /** Paths both sides changed that git merged cleanly. */
  shared: string[];
  /** git's own last word when `unreadable`; null otherwise. */
  detail: string | null;
};

export type CollisionWorktree = CollisionSide & {
  worktree: string;
  /** The branch this worktree would merge into, or null when none can be named. */
  base: string | null;
  /** True when Wanigan recorded the base at creation; false when it is the repository's current branch. */
  baseRecorded: boolean;
  /** Paths changed against the base's merge point, including uncommitted work. Null when unreadable. */
  changed: number | null;
  /** Whether its working state, uncommitted files included, could be read into a snapshot. */
  snapshot: 'ok' | 'failed';
  detail: string | null;
};

export type CollisionForecast = {
  projectId: string;
  repoRoot: string | null;
  at: number;
  /** Null when merge-tree --write-tree is available; otherwise why no forecast could run. */
  unsupported: string | null;
  worktrees: CollisionWorktree[];
  pairs: CollisionPair[];
  /** Worktrees left out of the pairing because there were more than the limit. */
  omitted: number;
};

/** merge-tree --write-tree arrived in git 2.38. */
export const MERGE_TREE_MIN: readonly [number, number] = [2, 38];

/** Pairs grow quadratically; past this many worktrees the forecast stops pairing and says how many it left out. */
export const MAX_FORECAST_WORKTREES = 12;

export function gitVersionSupportsMergeTree(line: string | null | undefined): boolean {
  const m = typeof line === 'string' ? /git version (\d+)\.(\d+)/.exec(line) : null;
  if (!m) return false;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  return major > MERGE_TREE_MIN[0] || (major === MERGE_TREE_MIN[0] && minor >= MERGE_TREE_MIN[1]);
}

/** A `-z` name list: NUL-terminated paths, empty entries dropped. */
export function nulList(out: string): string[] {
  return out.split('\0').filter((entry) => entry.length > 0);
}

const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/**
 * Reads `git merge-tree --write-tree --name-only --no-messages -z A B`.
 *
 * Exit 0 prints the merged tree's id. Exit 1 is two different facts: a merge
 * with conflicts prints the tree id followed by each conflicted path, while a
 * ref git cannot resolve also exits 1 and prints nothing on stdout. Telling
 * them apart by the leading object id is the difference between "these two
 * sessions collide" and "Wanigan could not ask".
 */
export function parseMergeTree(stdout: string, code: number | null): { outcome: 'clean' | 'conflicts' | 'unreadable'; conflicted: string[] } {
  const entries = nulList(stdout);
  const tree = entries[0] ?? '';
  if (!OID.test(tree)) return { outcome: 'unreadable', conflicted: [] };
  if (code === 0) return { outcome: 'clean', conflicted: [] };
  if (code === 1) {
    const conflicted = [...new Set(entries.slice(1))];
    // A conflict exit with no path named is not a conflict anyone can act on.
    return conflicted.length ? { outcome: 'conflicts', conflicted } : { outcome: 'unreadable', conflicted: [] };
  }
  return { outcome: 'unreadable', conflicted: [] };
}

/** The paths both sides changed, sorted, excluding any already reported as conflicted. */
export function sharedPaths(changedA: readonly string[], changedB: readonly string[], conflicted: readonly string[] = []): string[] {
  const b = new Set(changedB);
  const skip = new Set(conflicted);
  return [...new Set(changedA)].filter((p) => b.has(p) && !skip.has(p)).sort();
}

/** What a pair amounts to once git has answered. */
export function classifyPair(
  merge: { outcome: 'clean' | 'conflicts' | 'unreadable'; conflicted: string[] },
  changedA: readonly string[] | null,
  changedB: readonly string[] | null,
): { outcome: CollisionOutcome; conflicted: string[]; shared: string[] } {
  if (merge.outcome === 'unreadable') return { outcome: 'unreadable', conflicted: [], shared: [] };
  const shared = changedA && changedB ? sharedPaths(changedA, changedB, merge.conflicted) : [];
  if (merge.outcome === 'conflicts') return { outcome: 'conflicts', conflicted: merge.conflicted, shared };
  return { outcome: shared.length ? 'overlap' : 'clean', conflicted: [], shared };
}

/** Every unordered pair of indexes below `n`, in a stable order. */
export function peerPairs(n: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) out.push([i, j]);
  return out;
}

/** Most severe first, so the pair a reader must act on is never below the fold. */
export function orderPairs(pairs: readonly CollisionPair[]): CollisionPair[] {
  const rank: Record<CollisionOutcome, number> = { conflicts: 0, unreadable: 1, overlap: 2, clean: 3 };
  return [...pairs].sort((x, y) => rank[x.outcome] - rank[y.outcome] || (x.kind === y.kind ? 0 : x.kind === 'base' ? -1 : 1));
}
