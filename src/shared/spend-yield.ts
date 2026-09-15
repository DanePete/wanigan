/**
 * Spend yield: what the money bought, sorted by what happened to the work.
 *
 * Every Wanigan session that ran in its own worktree ends one of a few ways:
 * the branch was merged from Wanigan, the worktree was thrown away with work in
 * it, it was removed with nothing in it, or it is still there. Wanigan records
 * which, at the moment it happens (worktrees.ts). This module is the pure half:
 * it takes rows the main process read and decides which bucket each belongs in
 * and what the buckets add up to.
 *
 * The rules it will not bend:
 *
 *  - A row with no recorded outcome is "not recorded", never guessed into a
 *    bucket. Historical worktrees removed before outcomes were written, and
 *    sessions that never had a worktree, have no answer to give, and they are
 *    split by which of those two reasons applies so the gap names itself.
 *  - Money is only summed from priced sessions. A session whose cost was not
 *    reported (a Codex plan, a flat-rate backend) is counted, not totalled as
 *    zero — the bucket says "at least" and how many sessions it cannot price.
 *  - Cost per merged commit appears only where BOTH halves are observed: every
 *    merged session in the group is priced, and every merge recorded how many
 *    commits it carried. One missing half and the ratio is withheld with the
 *    reason, rather than computed over whatever happened to be known.
 *  - "Reverted" is a subset of merged, not a fifth bucket. A merge that was
 *    later reverted still shipped; that it came back out is the extra fact.
 */

export type WorktreeOutcome = 'merged' | 'discarded' | 'removed-clean';

export type YieldBucket = 'merged' | 'discarded' | 'removed-clean' | 'open' | 'not-recorded';

/** Why a row sits in not-recorded. */
export type NotRecordedReason = 'no-worktree' | 'historical';

export type YieldWorktree = {
  outcome: WorktreeOutcome | null;
  removedAt: number | null;
  mergeSha: string | null;
  /** Commits the branch carried when the outcome was recorded. Null when git could not say. */
  commits: number | null;
  /** The commit that reverted the merge, when the lazy check found one. */
  revertedBy: string | null;
};

export type YieldInput = {
  sessionId: string;
  source: 'session' | 'headless';
  projectId: string | null;
  projectName: string;
  /** Null when neither the launch nor the telemetry named a model. */
  model: string | null;
  /** Reported spend. Meaningful only when `priced` is true. */
  costUsd: number;
  /** False when the CLI reported no cost, or the backend's dollars are not a bill. */
  priced: boolean;
  worktree: YieldWorktree | null;
};

export type BucketTotals = {
  sessions: number;
  /** Sum over priced sessions only. */
  costUsd: number;
  /** Sessions in this bucket whose cost is not in costUsd. */
  unpricedSessions: number;
};

export type CostPerCommit =
  | { status: 'observed'; usdPerCommit: number; commits: number; costUsd: number }
  | { status: 'withheld'; reason: 'no-merges' | 'unpriced-merge' | 'commits-not-recorded' | 'zero-commits' };

export type YieldGroup = {
  projectId: string | null;
  projectName: string;
  model: string | null;
  merged: BucketTotals;
  /** A subset of merged: merges a later commit reverted. */
  reverted: BucketTotals;
  discarded: BucketTotals;
  removedClean: BucketTotals;
  open: BucketTotals;
  notRecorded: BucketTotals & { noWorktree: number; historical: number };
  costPerMergedCommit: CostPerCommit;
  /** Every session in the group, with its bucket, for drill-through. */
  sessions: { sessionId: string; source: 'session' | 'headless'; bucket: YieldBucket; reverted: boolean; costUsd: number; priced: boolean }[];
};

/** What the main process hands the Insights section. */
export type SpendYieldReport = {
  days: number;
  since: number;
  groups: (YieldGroup & { repositories: string[] })[];
  /** Per-session detail for drill-through, keyed by the id in each group's `sessions`. */
  detail: Record<string, { title: string | null; startedAt: number; live: boolean; worktree: string | null; branch: string | null; mergeSha: string | null; revertedBy: string | null; commits: number | null }>;
  /** How many merged SHAs git was asked about on this read. */
  revertChecks: number;
  note: string;
};

export function yieldBucket(worktree: YieldWorktree | null): { bucket: YieldBucket; reason: NotRecordedReason | null } {
  if (!worktree) return { bucket: 'not-recorded', reason: 'no-worktree' };
  switch (worktree.outcome) {
    case 'merged': return { bucket: 'merged', reason: null };
    case 'discarded': return { bucket: 'discarded', reason: null };
    case 'removed-clean': return { bucket: 'removed-clean', reason: null };
    default:
      // No outcome and still on disk is work nobody has decided about yet. No
      // outcome and gone is a removal Wanigan did not see or predates the
      // column — it is not assumed to be either a merge or a discard.
      return worktree.removedAt === null
        ? { bucket: 'open', reason: null }
        : { bucket: 'not-recorded', reason: 'historical' };
  }
}

const blank = (): BucketTotals => ({ sessions: 0, costUsd: 0, unpricedSessions: 0 });

function add(t: BucketTotals, row: YieldInput): void {
  t.sessions += 1;
  if (row.priced) t.costUsd += row.costUsd;
  else t.unpricedSessions += 1;
}

/**
 * The ratio, or the reason there is none. Worked over the merged sessions of
 * one group: a group mixing a priced merge with an unpriced one cannot divide
 * the priced half's dollars by all of the commits.
 */
export function costPerMergedCommit(merged: YieldInput[]): CostPerCommit {
  if (!merged.length) return { status: 'withheld', reason: 'no-merges' };
  if (merged.some((row) => !row.priced)) return { status: 'withheld', reason: 'unpriced-merge' };
  if (merged.some((row) => row.worktree?.commits === null || row.worktree?.commits === undefined)) {
    return { status: 'withheld', reason: 'commits-not-recorded' };
  }
  const commits = merged.reduce((sum, row) => sum + (row.worktree?.commits ?? 0), 0);
  if (commits <= 0) return { status: 'withheld', reason: 'zero-commits' };
  const costUsd = merged.reduce((sum, row) => sum + row.costUsd, 0);
  return { status: 'observed', usdPerCommit: costUsd / commits, commits, costUsd };
}

function groupKey(row: YieldInput): string {
  return `${row.projectId ?? `name:${row.projectName}`}\u0000${row.model ?? ''}`;
}

/**
 * Groups by project and model, dearest first. Deterministic: ties break on the
 * project name and then the model, so the same rows always render in the same
 * order and a snapshot test can hold it.
 */
export function aggregateYield(rows: YieldInput[]): YieldGroup[] {
  const groups = new Map<string, { head: YieldInput; rows: YieldInput[] }>();
  for (const row of rows) {
    const key = groupKey(row);
    const found = groups.get(key);
    if (found) found.rows.push(row);
    else groups.set(key, { head: row, rows: [row] });
  }

  const out: YieldGroup[] = [];
  for (const { head, rows: members } of groups.values()) {
    const g: YieldGroup = {
      projectId: head.projectId,
      projectName: head.projectName,
      model: head.model,
      merged: blank(),
      reverted: blank(),
      discarded: blank(),
      removedClean: blank(),
      open: blank(),
      notRecorded: { ...blank(), noWorktree: 0, historical: 0 },
      costPerMergedCommit: { status: 'withheld', reason: 'no-merges' },
      sessions: [],
    };
    const mergedRows: YieldInput[] = [];
    for (const row of members) {
      const { bucket, reason } = yieldBucket(row.worktree);
      const reverted = bucket === 'merged' && Boolean(row.worktree?.revertedBy);
      switch (bucket) {
        case 'merged':
          add(g.merged, row);
          mergedRows.push(row);
          if (reverted) add(g.reverted, row);
          break;
        case 'discarded': add(g.discarded, row); break;
        case 'removed-clean': add(g.removedClean, row); break;
        case 'open': add(g.open, row); break;
        case 'not-recorded':
          add(g.notRecorded, row);
          if (reason === 'no-worktree') g.notRecorded.noWorktree += 1;
          else g.notRecorded.historical += 1;
          break;
      }
      g.sessions.push({ sessionId: row.sessionId, source: row.source, bucket, reverted, costUsd: row.costUsd, priced: row.priced });
    }
    g.costPerMergedCommit = costPerMergedCommit(mergedRows);
    g.sessions.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
    out.push(g);
  }

  const total = (g: YieldGroup) =>
    g.merged.costUsd + g.discarded.costUsd + g.removedClean.costUsd + g.open.costUsd + g.notRecorded.costUsd;
  return out.sort((a, b) =>
    total(b) - total(a)
    || a.projectName.localeCompare(b.projectName)
    || (a.model ?? '').localeCompare(b.model ?? ''));
}

/**
 * The outcome a removal records, decided from what git said at that moment.
 *
 * `removed-clean` needs positive evidence of nothing: no uncommitted files, no
 * commits past the base, AND a branch tip still at the commit the worktree was
 * cut from. Without that last check a branch someone merged by hand outside
 * Wanigan (ahead 0, tip moved) would read as "removed with no changes". That
 * case is a merge whose commit Wanigan never saw, so it records `merged` with
 * no SHA. Anything git could not answer leaves the outcome unrecorded.
 */
export function removalOutcome(input: {
  previous: WorktreeOutcome | null;
  dirty: number | null;
  ahead: number | null;
  tip: string | null;
  createdHead: string | null;
  forced: boolean;
}): WorktreeOutcome | null {
  // A merge already recorded is the fact about this work; removing the tree
  // afterwards is housekeeping, not a second outcome.
  if (input.previous === 'merged') return 'merged';
  if ((input.dirty ?? 0) > 0 || (input.ahead ?? 0) > 0) return 'discarded';
  // A forced removal git could not inspect deleted something unknown. Say it
  // was discarded only when there is a count; otherwise leave it unrecorded.
  if (input.dirty === null || input.ahead === null) return null;
  if (!input.tip || !input.createdHead) return null;
  return input.tip === input.createdHead ? 'removed-clean' : 'merged';
}

/** The subject line git writes for `git revert <sha>`, which the lazy check greps for. */
export function revertGrepPattern(sha: string): string | null {
  return /^[0-9a-f]{7,64}$/i.test(sha) ? `This reverts commit ${sha.toLowerCase()}` : null;
}

/** How long a "not reverted" answer is trusted before git is asked again. */
export const REVERT_RECHECK_MS = 6 * 60 * 60 * 1000;

export function revertCheckDue(input: { mergeSha: string | null; revertedBy: string | null; checkedAt: number | null }, now: number): boolean {
  if (!input.mergeSha || input.revertedBy) return false;
  return input.checkedAt === null || now - input.checkedAt >= REVERT_RECHECK_MS;
}

/**
 * vcs.* attributes Claude Code attaches under OTEL_METRICS_INCLUDE_REPOSITORY.
 * The names were read out of the 2.1.271 binary. A repository URL can carry
 * credentials in its userinfo (https://token@host/…); those are stripped
 * before anything is stored.
 */
export const VCS_ATTRIBUTE_KEYS = [
  'vcs.repository.url.full', 'vcs.repository.name', 'vcs.owner.name', 'vcs.provider.name',
  'vcs.ref.head.revision', 'vcs.ref.head.name', 'vcs.ref.head.type',
] as const;

export function pickVcsAttributes(attrs: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of VCS_ATTRIBUTE_KEYS) {
    const raw = attrs[key];
    if (typeof raw !== 'string') continue;
    const value = key === 'vcs.repository.url.full' ? stripUserinfo(raw.trim()) : raw.trim();
    if (value && value.length <= 512) out[key] = value;
  }
  return out;
}

export function stripUserinfo(url: string): string {
  // scheme://user:secret@host/... → scheme://host/...; scp-style git@host:path is left alone.
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/i, '$1');
}
