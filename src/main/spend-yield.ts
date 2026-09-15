import { db } from './db';
import { usageForMany } from './otel';
import { checkReverts } from './worktrees';
import { vcsAttributesFor } from './vcs-telemetry';
import { aggregateYield, type SpendYieldReport, type WorktreeOutcome, type YieldInput } from '../shared/spend-yield';

/**
 * "Where the money went": the rows spend-yield.ts aggregates, read from the
 * session log, the worktree outcomes and each session's own usage record.
 *
 * Two surfaces contribute. An interactive session is one row per session_log
 * entry. Its dollars are the sum of its api_request events — the figure the
 * Spend by repository card beside this one sums, so the two cards cannot
 * disagree about a session — and whether those dollars are a bill is taken
 * from usageForMany()'s costStatus, which already downgrades a flat-rate
 * backend's arithmetic to unpriced and is not re-judged here. A headless fan-out row is one row per repository it ran
 * in, priced by the `cost_reported` flag the runner wrote beside its number.
 *
 * The window is by start time. A session that began inside the window and is
 * still open counts; one that began before it does not, even if it merged
 * today. That is the same boundary the rest of Insights draws.
 */

type SessionRow = {
  id: string; project_id: string | null; pname: string | null; model: string | null; event_model: string | null;
  started_at: number; ended_at: number | null; title: string | null; event_cost: number;
  w_path: string | null; branch: string | null; outcome: WorktreeOutcome | null; removed_at: number | null;
  merge_sha: string | null; outcome_commits: number | null; reverted_by: string | null;
};

type HeadlessRow = {
  run_id: string; project_id: string; pname: string; model: string | null; name: string | null;
  cost_usd: number; cost_reported: number | null; started_at: number | null; ended_at: number | null;
  w_path: string | null; branch: string | null; outcome: WorktreeOutcome | null; removed_at: number | null;
  merge_sha: string | null; outcome_commits: number | null; reverted_by: string | null;
};

function windowDays(days?: number): number {
  const n = Math.floor(Number(days ?? 30));
  return Number.isFinite(n) ? Math.max(1, Math.min(365, n)) : 30;
}

export async function spendYield(days?: number, liveIds: ReadonlySet<string> = new Set()): Promise<SpendYieldReport> {
  const n = windowDays(days);
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (n - 1));
  const since = start.getTime();

  // Ask git about merges before reading, so a revert found now shows now.
  let revertChecks = 0;
  try { revertChecks = await checkReverts(); } catch { /* the answer stays unchecked, never "not reverted" */ }

  const d = db();
  // The worktree a session ran in is session_log.worktree when the launch
  // recorded one (a resume reuses its predecessor's tree), else the newest row
  // whose session_id is this session.
  const sessions = d.prepare(`
    SELECT s.id, s.project_id, COALESCE(p.name, s.project_name) AS pname, s.model, s.started_at, s.ended_at, s.title,
      (SELECT e.model FROM session_api_events e WHERE e.session_id = s.id AND e.kind = 'request' AND e.model IS NOT NULL
        GROUP BY e.model ORDER BY COUNT(*) DESC, e.model ASC LIMIT 1) AS event_model,
      (SELECT COALESCE(SUM(e.cost_usd), 0) FROM session_api_events e WHERE e.session_id = s.id AND e.kind = 'request') AS event_cost,
      w.path AS w_path, w.branch, w.outcome, w.removed_at, w.merge_sha, w.outcome_commits, w.reverted_by
    FROM session_log s
    LEFT JOIN projects p ON p.id = s.project_id
    LEFT JOIN worktrees w ON w.path = COALESCE(s.worktree,
      (SELECT path FROM worktrees x WHERE x.session_id = s.id ORDER BY x.created_at DESC LIMIT 1))
    WHERE s.origin = 'wanigan' AND s.started_at >= ?
    ORDER BY s.started_at ASC
  `).all(since) as SessionRow[];

  const usage: ReturnType<typeof usageForMany> = {};
  for (let i = 0; i < sessions.length; i += 400) {
    Object.assign(usage, usageForMany(sessions.slice(i, i + 400).map((row) => row.id)));
  }

  const headless = d.prepare(`
    SELECT h.run_id, h.project_id, COALESCE(p.name, h.project_name) AS pname, r.model, r.name,
      h.cost_usd, h.cost_reported, h.started_at, h.ended_at,
      w.path AS w_path, w.branch, w.outcome, w.removed_at, w.merge_sha, w.outcome_commits, w.reverted_by
    FROM headless_rows h
    JOIN runs r ON r.id = h.run_id
    LEFT JOIN projects p ON p.id = h.project_id
    LEFT JOIN worktrees w ON w.path = h.worktree
    WHERE COALESCE(h.started_at, r.created_at) >= ? AND h.status NOT IN ('pending', 'blocked')
  `).all(since) as HeadlessRow[];

  const inputs: YieldInput[] = [];
  const detail: SpendYieldReport['detail'] = {};
  const repositories = new Map<string, Set<string>>();
  const vcs = vcsAttributesFor(sessions.map((row) => row.id));

  for (const row of sessions) {
    const u = usage[row.id];
    const cost = row.event_cost ?? 0;
    const input: YieldInput = {
      sessionId: row.id,
      source: 'session',
      projectId: row.project_id,
      projectName: row.pname || 'Unattributed',
      model: row.event_model ?? row.model ?? null,
      costUsd: cost,
      priced: Boolean(u) && u.costStatus === 'reported' && cost > 0,
      worktree: row.w_path ? {
        outcome: row.outcome, removedAt: row.removed_at, mergeSha: row.merge_sha,
        commits: row.outcome_commits, revertedBy: row.reverted_by,
      } : null,
    };
    inputs.push(input);
    detail[row.id] = {
      title: row.title, startedAt: row.started_at, live: liveIds.has(row.id), worktree: row.w_path, branch: row.branch,
      mergeSha: row.merge_sha, revertedBy: row.reverted_by, commits: row.outcome_commits,
    };
    const repo = vcs.get(row.id)?.['vcs.repository.url.full'] ?? vcs.get(row.id)?.['vcs.repository.name'];
    if (repo) {
      const key = `${input.projectId ?? `name:${input.projectName}`}\u0000${input.model ?? ''}`;
      if (!repositories.has(key)) repositories.set(key, new Set());
      repositories.get(key)!.add(repo);
    }
  }

  for (const row of headless) {
    const id = `${row.run_id}:${row.project_id}`;
    const reported = row.cost_reported === 1;
    inputs.push({
      sessionId: id,
      source: 'headless',
      projectId: row.project_id,
      projectName: row.pname,
      model: row.model ?? null,
      costUsd: row.cost_usd ?? 0,
      priced: reported && (row.cost_usd ?? 0) > 0,
      worktree: row.w_path ? {
        outcome: row.outcome, removedAt: row.removed_at, mergeSha: row.merge_sha,
        commits: row.outcome_commits, revertedBy: row.reverted_by,
      } : null,
    });
    detail[id] = {
      title: row.name ? `Headless · ${row.name}` : 'Headless run', startedAt: row.started_at ?? 0, live: false,
      worktree: row.w_path, branch: row.branch, mergeSha: row.merge_sha, revertedBy: row.reverted_by, commits: row.outcome_commits,
    };
  }

  const groups = aggregateYield(inputs).map((group) => {
    const key = `${group.projectId ?? `name:${group.projectName}`}\u0000${group.model ?? ''}`;
    return { ...group, repositories: [...(repositories.get(key) ?? [])].sort() };
  });

  return {
    days: n,
    since,
    groups,
    detail,
    revertChecks,
    note:
      'Outcomes are recorded when Wanigan merges or removes a worktree. Removals before that record existed, ' +
      'and sessions that ran without a worktree, are not recorded rather than guessed. Dollars are the CLI’s own ' +
      'reported cost; sessions without a reported cost are counted beside the money, never added as $0. ' +
      '"Reverted" means a later commit on the target branch says "This reverts commit" for the merge itself.',
  };
}
