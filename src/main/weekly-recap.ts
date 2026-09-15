import fs from 'node:fs';
import { dialog, type BrowserWindow } from 'electron';
import { db } from './db';
import { runGit } from './git';
import { projectById } from './store';
import { repoRootFor } from './worktrees';
import {
  buildRecap, recapMarkdown, weekBounds,
  type RecapInput, type RecapWorktree, type WeeklyRecap, type WorktreeOutcome,
} from '../shared/weekly-recap';

/**
 * The weekly recap's reads: session_log, worktrees, work_dockets, review_runs,
 * session_api_events and operator_runs, plus git's own answer to "is this
 * branch contained in the branch it was cut from". Deterministic and local;
 * see shared/weekly-recap.ts for every rule.
 */

type WorktreeRow = { path: string; branch: string | null; session_id: string | null; created_at: number; removed_at: number | null; outcome?: string | null };

function columns(table: string): Set<string> {
  return new Set((db().prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
}

/**
 * Whether worktree outcomes are recorded (spend-yield's \`outcome\` column,
 * written when Wanigan merges or removes a worktree). Read when present and
 * never assumed: a database from an older build has no such column.
 */
function recordedOutcomeColumn(): boolean {
  return columns('worktrees').has('outcome');
}

async function gitOutcome(root: string, row: WorktreeRow, startHead: string | null): Promise<WorktreeOutcome> {
  if (!row.branch) return row.removed_at !== null ? 'discarded' : 'unknown';
  const tip = await runGit(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${row.branch}`], { timeout: 8_000 });
  if (!tip.ok) return row.removed_at !== null ? 'discarded' : 'unknown';
  const head = tip.out.trim();
  const base = (await runGit(root, ['config', '--get', `branch.${row.branch}.waniganbase`], { timeout: 8_000 })).out.trim();
  const moved = !startHead || head !== startHead;
  if (moved && base) {
    const contained = await runGit(root, ['merge-base', '--is-ancestor', head, base], { timeout: 15_000 });
    if (contained.ok) return 'merged';
    if (contained.code !== 1) return row.removed_at !== null ? 'discarded' : 'unknown';
  }
  if (row.removed_at !== null) return 'discarded';
  return moved ? 'open' : 'no-commits';
}

export async function weeklyRecap(projectId: unknown, back: unknown = 0, now = Date.now()): Promise<WeeklyRecap> {
  const project = typeof projectId === 'string' ? projectById(projectId) : undefined;
  if (!project) throw new Error('Choose a project for the recap.');
  const weeksBack = typeof back === 'number' && Number.isInteger(back) && back >= 0 && back <= 52 ? back : 0;
  const { start, end } = weekBounds(now, weeksBack);
  const d = db();

  const sessionRows = d.prepare(`
    SELECT id, conversation_id, title, provider_id, started_at, ended_at, exit_code, worktree, baseline_head
      FROM session_log
     WHERE project_id = ? AND origin = 'wanigan'
       AND ((started_at >= ? AND started_at < ?) OR (ended_at >= ? AND ended_at < ?))
     ORDER BY started_at
  `).all(project.id, start, end, start, end) as {
    id: string; conversation_id: string | null; title: string | null; provider_id: string; started_at: number;
    ended_at: number | null; exit_code: number | null; worktree: string | null; baseline_head: string | null;
  }[];

  const root = await repoRootFor(project.path).catch(() => null);
  const recorded = recordedOutcomeColumn();
  const wtRows = root
    ? d.prepare(`SELECT path, branch, session_id, created_at, removed_at${recorded ? ', outcome' : ''} FROM worktrees WHERE repo_root = ? ORDER BY created_at DESC LIMIT 200`).all(root) as WorktreeRow[]
    : [];
  const startHeads = new Map(sessionRows.map((s) => [s.id, s.baseline_head] as const));
  const touched = new Set(sessionRows.map((s) => s.worktree).filter(Boolean));
  const worktrees: RecapWorktree[] = [];
  let readRecorded = 0;
  let readFromGit = 0;
  for (const row of wtRows) {
    // Only what the recap reads: worktrees this week's sessions ran in, and
    // worktrees still open. A removed worktree from months ago is not asked about.
    if (!touched.has(row.path) && row.removed_at !== null) continue;
    let outcome: WorktreeOutcome;
    // A recorded outcome wins, row by row. The column existing is not the same
    // as this row having one: a branch merged by hand in a terminal, or a
    // worktree removed before outcomes were written, has none, and treating
    // that null as "still open" would call merged work half-finished.
    if (recorded && (row.outcome === 'merged' || row.outcome === 'discarded' || row.outcome === 'removed-clean')) {
      outcome = row.outcome === 'removed-clean' ? 'no-commits' : row.outcome;
      readRecorded++;
    } else if (root) {
      const head = row.session_id ? startHeads.get(row.session_id) ?? (d.prepare('SELECT baseline_head FROM session_log WHERE id = ?').get(row.session_id) as { baseline_head: string | null } | undefined)?.baseline_head ?? null : null;
      outcome = await gitOutcome(root, row, head);
      readFromGit++;
    } else {
      outcome = 'unknown';
    }
    worktrees.push({ path: row.path, branch: row.branch, sessionId: row.session_id, createdAt: row.created_at, removedAt: row.removed_at, outcome });
  }
  const outcomeMethod: RecapInput['outcomeMethod'] = readRecorded && readFromGit ? 'mixed'
    : readRecorded ? 'recorded' : root ? 'git' : 'not-recorded';

  const goals = d.prepare(`
    SELECT w.title, COALESCE((SELECT MAX(n.ended_at) FROM work_nodes n WHERE n.docket_id = w.id AND n.kind = 'review'), w.updated_at) AS at
      FROM work_dockets w WHERE w.project_id = ? AND w.status = 'accepted'
  `).all(project.id) as { title: string; at: number }[];

  const gates = (d.prepare('SELECT started_at, status, results_json FROM review_runs WHERE project_id = ? AND started_at >= ? AND started_at < ?')
    .all(project.id, start, end) as { started_at: number; status: string; results_json: string }[]).map((g) => {
    let failedCommands: string[] = [];
    try {
      failedCommands = (JSON.parse(g.results_json) as { command?: unknown; exitCode?: unknown }[])
        .filter((r) => typeof r.command === 'string' && r.exitCode !== 0)
        .map((r) => String(r.command).slice(0, 200));
    } catch { /* an unreadable result names no command */ }
    return { startedAt: g.started_at, status: (g.status === 'passed' || g.status === 'failed' ? g.status : 'running') as 'running' | 'passed' | 'failed', failedCommands };
  });

  const started = sessionRows.filter((s) => s.started_at >= start && s.started_at < end).map((s) => s.id);
  let cost: RecapInput['cost'] = null;
  if (started.length) {
    const placeholders = started.map(() => '?').join(',');
    const row = d.prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS usd, COUNT(DISTINCT session_id) AS n FROM session_api_events WHERE cost_usd > 0 AND session_id IN (${placeholders})`)
      .get(...started) as { usd: number; n: number };
    if (row.n > 0) cost = { usd: row.usd, sessionsReporting: row.n };
  }
  const operatorRuns = (d.prepare('SELECT COUNT(*) AS n FROM operator_runs WHERE project_id = ? AND at >= ? AND at < ?').get(project.id, start, end) as { n: number }).n;

  return buildRecap({
    projectName: project.name, start, end,
    sessions: sessionRows.map((s) => ({
      id: s.id, conversationId: s.conversation_id, title: s.title, providerId: s.provider_id,
      startedAt: s.started_at, endedAt: s.ended_at, exitCode: s.exit_code, worktree: s.worktree,
    })),
    outcomeMethod,
    worktrees, goalsAccepted: goals, gateRuns: gates, cost, operatorRuns,
  });
}

/** Export through a save dialog the operator answers. Returns the path written, or null when they cancelled. */
export async function exportWeeklyRecap(win: BrowserWindow | null, projectId: unknown, back: unknown = 0): Promise<string | null> {
  const recap = await weeklyRecap(projectId, back);
  const safeName = recap.projectName.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
  const options = {
    title: 'Export this week as Markdown',
    defaultPath: `wanigan-${safeName}-week-of-${new Date(recap.start).toISOString().slice(0, 10)}.md`,
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  };
  const answer = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
  if (answer.canceled || !answer.filePath) return null;
  fs.writeFileSync(answer.filePath, recapMarkdown(recap, Date.now()), { encoding: 'utf8' });
  return answer.filePath;
}
