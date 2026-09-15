import fs from 'node:fs';
import { db } from './db';
import { runGit, repoState, scopeOf } from './git';
import { resolvedCount, reviewEvidence } from './review-work';
import { fileReview, reviewCounts } from '../shared/review-marks';
import { buildPrBody, type PrEvidence } from '../shared/pr-body';
import type { PrDraft } from '../shared/review-work';
/* ── helper sweep · P7 depth ── */
import { ignoredPaths, promotedPaths } from './scratch';
import { classifyScratch } from '../shared/scratch-files';
/* ── end helper sweep · P7 depth ── */

/**
 * The create-PR dialog's body, from what Wanigan recorded about the branch.
 *
 * A branch "belongs" to a session when Wanigan created a worktree on it for
 * that session — the worktrees table says so exactly. A branch nobody launched
 * a session on gets no body and a sentence saying why, rather than one assembled
 * from whichever session happened to run in the same repository.
 */

type WorktreeRow = { path: string; session_id: string | null; created_at: number };

function canonical(p: string): string {
  try { return fs.realpathSync(p); } catch { return p; }
}

export async function prDraft(root: string): Promise<PrDraft> {
  const scope = await scopeOf(root);
  if (!scope) return { kind: 'none', reason: 'This is not a git repository.' };
  const state = await repoState(scope.repoRoot);
  if (state.kind !== 'branch') return { kind: 'none', reason: 'HEAD is not on a branch.' };
  const branch = state.branch;
  const repo = canonical(scope.repoRoot);
  const rows = db().prepare(`SELECT path, repo_root, session_id, created_at FROM worktrees WHERE branch = ? AND session_id IS NOT NULL
    ORDER BY created_at DESC LIMIT 20`).all(branch) as (WorktreeRow & { repo_root: string })[];
  // A worktree's own top level is its checkout, not the repository it belongs
  // to, so a row matches by either: the repository, or the worktree itself.
  const row = rows.find((r) => canonical(r.repo_root) === repo || canonical(r.path) === repo);
  if (!row?.session_id) {
    return { kind: 'none', reason: `No Wanigan session was launched on ${branch}, so there is no recorded evidence to write a body from.` };
  }
  const sessionId = row.session_id;

  const node = db().prepare(`SELECT n.docket_id FROM work_nodes n WHERE n.session_id = ?
    UNION SELECT s.docket_id FROM work_node_sessions s WHERE s.session_id = ? LIMIT 1`).get(sessionId, sessionId) as { docket_id: string } | undefined;
  const docket = node ? db().prepare('SELECT id, title, acceptance_json, project_id FROM work_dockets WHERE id = ?').get(node.docket_id) as
    { id: string; title: string; acceptance_json: string; project_id: string } | undefined : undefined;
  let acceptance: string[] = [];
  try { const a: unknown = JSON.parse(docket?.acceptance_json ?? '[]'); if (Array.isArray(a)) acceptance = a.filter((v): v is string => typeof v === 'string'); } catch { /* none */ }

  const turnRow = db().prepare('SELECT MAX(turn) AS t FROM session_checkpoints WHERE session_id = ?').get(sessionId) as { t: number | null } | undefined;
  const prompts = db().prepare("SELECT COUNT(*) AS n FROM session_events WHERE session_id = ? AND event = 'UserPromptSubmit'").get(sessionId) as { n: number };
  const turns = turnRow?.t ?? (prompts.n > 0 ? prompts.n : null);

  // The files a pull request proposes are the branch's commits against the
  // branch it was cut from, which is what the recorded base names.
  const baseRef = await runGit(scope.repoRoot, ['config', '--get', `branch.${branch}.waniganbase`], { timeout: 8_000, maxBuffer: 1024 * 1024 });
  const base = baseRef.ok ? baseRef.out.trim() : '';
  const files: { path: string; added: number | null; removed: number | null }[] = [];
  if (base) {
    const num = await runGit(scope.repoRoot, ['diff', '--numstat', '-z', '-M', `${base}...${branch}`, '--'], { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
    if (num.ok) {
      const parts = num.out.split('\0');
      for (let i = 0; i < parts.length; i++) {
        const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(parts[i]);
        if (!m) continue;
        const p = m[3] === '' ? parts[i + 2] ?? '' : m[3];
        if (m[3] === '') i += 2;
        files.push({ path: p, added: m[1] === '-' ? null : Number(m[1]), removed: m[2] === '-' ? null : Number(m[2]) });
      }
    }
  }

  const checks: PrEvidence['checks'][number][] = [];
  if (docket) {
    const proofs = db().prepare("SELECT kind, detail_json FROM work_proofs WHERE docket_id = ? AND kind IN ('test','regression') ORDER BY created_at").all(docket.id) as { kind: string; detail_json: string }[];
    for (const p of proofs) {
      try {
        const d = JSON.parse(p.detail_json) as { results?: { command: string; exitCode: number | null; durationMs: number }[]; command?: string; after?: { exitCode: number | null; durationMs: number }; verdict?: string };
        if (p.kind === 'test') for (const r of d.results ?? []) checks.push({ command: r.command, exitCode: r.exitCode, durationMs: r.durationMs, where: 'goal verification' });
        else if (d.command && d.after) checks.push({ command: d.command, exitCode: d.after.exitCode, durationMs: d.after.durationMs, where: `regression proof, ${d.verdict ?? 'recorded'}` });
      } catch { /* a corrupt proof row adds nothing */ }
    }
  } else {
    const project = db().prepare('SELECT project_id, started_at FROM session_log WHERE id = ?').get(sessionId) as { project_id: string | null; started_at: number } | undefined;
    if (project?.project_id) {
      const runs = db().prepare('SELECT results_json FROM review_runs WHERE project_id = ? AND started_at >= ? ORDER BY started_at').all(project.project_id, project.started_at) as { results_json: string }[];
      for (const r of runs) {
        try {
          for (const c of JSON.parse(r.results_json) as { command: string; exitCode: number | null; durationMs: number }[]) {
            checks.push({ command: c.command, exitCode: c.exitCode, durationMs: c.durationMs, where: 'project review gate' });
          }
        } catch { /* nothing */ }
      }
    }
  }

  const evidence = await reviewEvidence(sessionId);
  let review: PrEvidence['review'] = null;
  let dependencies: string[] = [];
  if (evidence) {
    const counts = reviewCounts(evidence.files, evidence.marks);
    const anyMark = evidence.files.some((f) => fileReview(f, evidence.marks).markedAt !== null);
    if (anyMark) review = { approved: counts.approved, rejected: counts.rejected, commented: counts.commented, resolved: resolvedCount(sessionId, evidence.files, evidence.marks), files: counts.files };
    dependencies = evidence.dependencies.manifests.flatMap((m) => m.lines);
  }

  /* ── helper sweep · P7 depth ── scratch files are neither listed nor counted. */
  const sessionProject = db().prepare('SELECT project_id FROM session_log WHERE id = ?').get(sessionId) as { project_id: string | null } | undefined;
  const classified = classifyScratch(files, await ignoredPaths(scope.repoRoot, files.map((f) => f.path)).catch(() => new Set<string>()), promotedPaths(sessionProject?.project_id ?? null));
  const counted = classified.filter((f) => !f.scratch).map(({ path, added, removed }) => ({ path, added, removed }));
  const body = buildPrBody({
    goal: docket ? { title: docket.title, acceptance } : null,
    turns,
    files: counted,
    scratchFiles: classified.length - counted.length,
    checks,
    review,
    dependencies,
  });
  return { kind: 'draft', body, sessionId, goalTitle: docket?.title ?? null };
}
