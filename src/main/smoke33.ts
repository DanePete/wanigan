import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

type Check = (ok: boolean, label: string, detail?: unknown) => void;
type Say = (s: string) => void;

/**
 * Cost, quota and context — the checks that need a real process: SQLite, real
 * git, the real telemetry receiver. The pure halves are in src/shared/*.test.ts.
 */

function scratchRepo(prefix: string) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' }).toString().trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'smoke@wanigan.test');
  git('config', 'user.name', 'Smoke');
  fs.writeFileSync(path.join(repo, 'README.md'), '# yield\n');
  git('add', '-A'); git('commit', '-qm', 'base');
  return { repo, git };
}

export async function runSpendYieldSmoke(check: Check, say: Say): Promise<void> {
  say('── cost · spend yield: merged, discarded, still open, not recorded');
  const { repo, git } = scratchRepo('wanigan-yield-');
  const { db } = await import('./db');
  const { addProject, removeProject } = await import('./store');
  const worktrees = await import('./worktrees');
  const { spendYield } = await import('./spend-yield');
  const project = await addProject(repo);
  const made: string[] = [];
  try {
    const commitIn = (dir: string, file: string) => {
      fs.writeFileSync(path.join(dir, file), `${file}\n`);
      execFileSync('git', ['-C', dir, 'add', '-A'], { stdio: 'pipe' });
      execFileSync('git', ['-C', dir, 'commit', '-qm', `add ${file}`], { stdio: 'pipe' });
    };
    const now = Date.now();
    const logSession = (id: string, worktree: string | null, cost: number, model = 'claude-fable-5') => {
      db().prepare(`INSERT INTO session_log (id, provider_id, project_id, project_path, project_name, model, started_at, worktree, title)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(id, 'claude', project.id, repo, project.name, model, now - 1000, worktree, `yield ${id}`);
      if (cost > 0) {
        db().prepare(`INSERT INTO session_api_events (session_id, at, kind, model, cost_usd, in_tokens, out_tokens)
          VALUES (?,?,?,?,?,?,?)`).run(id, now - 500, 'request', model, cost, 100, 10);
      }
    };

    // 1. Merged from Wanigan, then reverted on the base branch.
    const a = await worktrees.createWorktree(repo, 'merged work', 'yield-merge');
    made.push(a.path);
    commitIn(a.path, 'a.txt');
    commitIn(a.path, 'b.txt');
    const merged = await worktrees.mergeWorktree(a.path);
    const rowA = db().prepare('SELECT outcome, merge_sha, merge_target, outcome_commits, created_head FROM worktrees WHERE path = ?').get(a.path) as
      { outcome: string | null; merge_sha: string | null; merge_target: string | null; outcome_commits: number | null; created_head: string | null };
    check(merged.merged && rowA.outcome === 'merged' && rowA.merge_target === 'main' && rowA.outcome_commits === 2,
      'a merge from Wanigan records outcome merged, its target and the two commits it carried', rowA);
    check(rowA.merge_sha === git('rev-parse', 'main'), 'the recorded merge SHA is the commit the merge made on main', rowA.merge_sha);
    logSession('yield-merge', a.path, 2);

    await worktrees.removeWorktree(a.path, false);
    const afterRemove = db().prepare('SELECT outcome FROM worktrees WHERE path = ?').get(a.path) as { outcome: string };
    check(afterRemove.outcome === 'merged', 'removing a merged worktree afterwards does not overwrite the merge', afterRemove);

    let reverts = await worktrees.checkReverts();
    const notYet = db().prepare('SELECT reverted_by, revert_checked_at FROM worktrees WHERE path = ?').get(a.path) as { reverted_by: string | null; revert_checked_at: number | null };
    check(reverts === 1 && notYet.reverted_by === null && notYet.revert_checked_at !== null,
      'the lazy revert check asks git once and caches "not reverted" with a timestamp', { reverts, notYet });
    git('revert', '--no-edit', '-m', '1', rowA.merge_sha!);
    reverts = await worktrees.checkReverts();
    check(reverts === 0, 'a cached answer is not re-asked inside the recheck interval', reverts);
    db().prepare('UPDATE worktrees SET revert_checked_at = 0 WHERE path = ?').run(a.path);
    await worktrees.checkReverts();
    const reverted = db().prepare('SELECT reverted_by FROM worktrees WHERE path = ?').get(a.path) as { reverted_by: string | null };
    check(reverted.reverted_by === git('rev-parse', 'main'), 'once due again, the check finds the revert of the merge commit on main', reverted);

    // 2. Removed with nothing in it.
    const b = await worktrees.createWorktree(repo, 'nothing', 'yield-clean');
    made.push(b.path);
    await worktrees.removeWorktree(b.path, false);
    const rowB = db().prepare('SELECT outcome FROM worktrees WHERE path = ?').get(b.path) as { outcome: string | null };
    check(rowB.outcome === 'removed-clean', 'a worktree removed with no commits and no edits records removed-clean', rowB);
    logSession('yield-clean', b.path, 0.5);

    // 3. Removed with unmerged commits: discarded, branch kept.
    const c = await worktrees.createWorktree(repo, 'thrown away', 'yield-discard');
    made.push(c.path);
    commitIn(c.path, 'c.txt');
    await worktrees.removeWorktree(c.path, false);
    const rowC = db().prepare('SELECT outcome, outcome_commits FROM worktrees WHERE path = ?').get(c.path) as { outcome: string | null; outcome_commits: number | null };
    check(rowC.outcome === 'discarded' && rowC.outcome_commits === 1,
      'a worktree removed with an unmerged commit records discarded and the commit count', rowC);
    logSession('yield-discard', c.path, 1.25);

    // 4. Still open, and 5. a historical removal with no outcome, and 6. no worktree at all.
    const e = await worktrees.createWorktree(repo, 'in flight', 'yield-open');
    made.push(e.path);
    logSession('yield-open', e.path, 0.75);
    const f = await worktrees.createWorktree(repo, 'old', 'yield-historic');
    made.push(f.path);
    await worktrees.removeWorktree(f.path, false);
    db().prepare('UPDATE worktrees SET outcome = NULL WHERE path = ?').run(f.path);
    logSession('yield-historic', f.path, 0.1);
    logSession('yield-bare', null, 0.2);
    logSession('yield-unpriced', e.path, 0);

    const report = await spendYield(7, new Set(['yield-open']));
    const group = report.groups.find((g) => g.projectId === project.id && g.model === 'claude-fable-5');
    check(!!group, 'spend yield groups the scratch project by project and model', report.groups.map((g) => [g.projectName, g.model]));
    if (group) {
      check(group.merged.sessions === 1 && Math.abs(group.merged.costUsd - 2) < 1e-9 && group.reverted.sessions === 1,
        'the merged bucket carries the merged session’s cost and marks it reverted', JSON.stringify(group.merged));
      check(group.discarded.sessions === 1 && group.removedClean.sessions === 1,
        'discarded and removed-clean are separate buckets', { discarded: group.discarded, clean: group.removedClean });
      check(group.open.sessions === 2 && group.open.unpricedSessions === 1 && Math.abs(group.open.costUsd - 0.75) < 1e-9,
        'an unpriced session is counted in its bucket and never summed in as $0', JSON.stringify(group.open));
      check(group.notRecorded.historical === 1 && group.notRecorded.noWorktree === 1,
        'not recorded names a historical removal and a session with no worktree separately', group.notRecorded);
      check(group.costPerMergedCommit.status === 'observed' && Math.abs((group.costPerMergedCommit as { usdPerCommit: number }).usdPerCommit - 1) < 1e-9,
        'cost per merged commit is shown when the merged session is priced and the merge recorded its commits', JSON.stringify(group.costPerMergedCommit));
      check(report.detail['yield-open']?.live === true && report.detail['yield-merge']?.mergeSha === rowA.merge_sha,
        'drill-through detail carries liveness and the merge SHA per session', report.detail['yield-open']);
    }

    say('── cost · repository attributes from Claude Code telemetry');
    const otel = await import('./otel');
    await otel.startCollector();
    const env = otel.otelEnv('yield-merge');
    check(env.OTEL_METRICS_INCLUDE_REPOSITORY === '1', 'Claude sessions launch with OTEL_METRICS_INCLUDE_REPOSITORY=1', env.OTEL_METRICS_INCLUDE_REPOSITORY);
    const { recordVcsAttributes, vcsAttributesFor } = await import('./vcs-telemetry');
    recordVcsAttributes({
      resourceMetrics: [{
        resource: { attributes: [{ key: 'wanigan.session.id', value: { stringValue: 'yield-merge' } }] },
        scopeMetrics: [{ metrics: [{ name: 'claude_code.cost.usage', sum: { dataPoints: [{ asDouble: 0.1, attributes: [
          { key: 'vcs.repository.url.full', value: { stringValue: 'https://oauth2:tok@example.com/acme/app.git' } },
          { key: 'vcs.provider.name', value: { stringValue: 'github' } },
          { key: 'user.email', value: { stringValue: 'nobody@example.com' } },
        ] }] } }] }],
      }],
    });
    const attrs = vcsAttributesFor(['yield-merge']).get('yield-merge') ?? {};
    check(attrs['vcs.repository.url.full'] === 'https://example.com/acme/app.git' && attrs['vcs.provider.name'] === 'github' && !('user.email' in attrs),
      'vcs.* attributes are banked per session with URL credentials stripped and nothing else kept', attrs);
    const again = await spendYield(7, new Set());
    const withRepo = again.groups.find((g) => g.projectId === project.id && g.model === 'claude-fable-5');
    check(withRepo?.repositories.includes('https://example.com/acme/app.git') === true,
      'spend yield shows the repository the CLI itself reported beside the project', withRepo?.repositories);
  } finally {
    for (const p of made) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* scratch */ } }
    try { removeProject(project.id); } catch { /* scratch */ }
    fs.rmSync(repo, { recursive: true, force: true });
  }
}
