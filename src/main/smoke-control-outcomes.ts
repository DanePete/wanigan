import { randomUUID } from 'node:crypto';
import { recordOutcomeReview } from './control-outcomes';
import { db } from './db';

type Check = (ok: boolean, label: string, detail?: unknown) => void;
type ReviewRow = { accepted: number; tests_passed: number; cost_usd: number | null; attempts_json: string };
type Attempt = { sessionId: string; providerId: string | null; model: string | null; effort: string | null;
  backendId: string | null; harnessId: string | null; profileFingerprint: string | null; costUsd: number | null };

/** Review writer with actual SQLite/telemetry fixtures; no agent process or billed inference. */
export function runControlOutcomesSmoke(check: Check, say: (text: string) => void): void {
  say('── control outcomes · every review and every attempt retain their identities and costs');
  const d = db();
  const prefix = `outcome_fixture_${randomUUID()}`;
  const projectId = `${prefix}_project`;
  const docketId = `${prefix}_docket`;
  const sessionIds: string[] = [];
  const at = Date.now();
  d.prepare('INSERT INTO projects (id,path,name,added_at) VALUES (?,?,?,?)')
    .run(projectId, `/fixture/${prefix}`, 'Outcome fixture', at);
  try {
    d.prepare('INSERT INTO work_dockets (id,project_id,title,objective,created_at,updated_at) VALUES (?,?,?,?,?,?)')
      .run(docketId, projectId, 'Outcome fixture', 'Preserve reviewed attempt evidence', at, at);
    const node = (suffix: string, kind = 'implement') => {
      const value = { id: `${prefix}_${suffix}`, docket_id: docketId, kind };
      d.prepare(`INSERT INTO work_nodes (id,docket_id,kind,title,instructions,provider_id,model)
        VALUES (?,?,?,?,?,'never-launched-profile','never-launched-model')`)
        .run(value.id, docketId, kind, suffix, 'Synthetic completed work');
      return value;
    };
    const attempt = (target: ReturnType<typeof node>, suffix: string, provider: string, model: string,
      effort: string, cost: number | null) => {
      const id = `${prefix}_${suffix}`;
      sessionIds.push(id);
      d.prepare(`INSERT INTO session_log
        (id,provider_id,model,effort,backend_id,harness_id,provider_profile_json,project_path,project_name,started_at)
        VALUES (?,?,?,?,'anthropic','claude-code',?,?,?,?)`)
        .run(id, provider, model, effort, JSON.stringify({ profileFingerprint: `frozen:${provider}` }),
          `/fixture/${prefix}`, 'Outcome fixture', at + sessionIds.length);
      d.prepare('INSERT INTO work_node_sessions (node_id,docket_id,session_id,at) VALUES (?,?,?,?)')
        .run(target.id, docketId, id, at);
      d.prepare('UPDATE work_nodes SET session_id=? WHERE id=?').run(id, target.id);
      if (cost !== null) d.prepare(`INSERT INTO session_metrics (session_id,metric,attrs,value,last_at)
        VALUES (?,'claude_code.cost.usage','',?,?)`).run(id, cost, at);
      return id;
    };
    const review = (target: ReturnType<typeof node>, suffix: string, accepted: boolean, testsPassed: boolean) => {
      const decisionId = `${prefix}_${suffix}`;
      d.transaction(() => {
        d.prepare(`INSERT INTO work_proofs (id,docket_id,node_id,kind,status,summary,created_at)
          VALUES (?,?,?,'decision','recorded','Fixture review',?)`).run(decisionId, docketId, target.id, at);
        recordOutcomeReview(target, decisionId, accepted, testsPassed);
      })();
      return d.prepare('SELECT accepted,tests_passed,cost_usd,attempts_json FROM work_outcome_reviews WHERE decision_id=?')
        .get(decisionId) as ReviewRow | undefined;
    };

    const retry = node('retry');
    const firstSession = attempt(retry, 'attempt_first', 'profile-first', 'small', 'low', 7);
    const rejected = review(retry, 'request_changes', false, false)!;
    const firstAttempts = JSON.parse(rejected.attempts_json) as Attempt[];
    check(rejected.accepted === 0 && rejected.tests_passed === 0 && rejected.cost_usd === 7
      && firstAttempts.length === 1 && firstAttempts[0].sessionId === firstSession,
    'a rejected attempt retains its $7 cost and is counted once even when also the current session', rejected);
    check(firstAttempts[0].providerId === 'profile-first' && firstAttempts[0].model === 'small'
      && firstAttempts[0].effort === 'low' && firstAttempts[0].backendId === 'anthropic'
      && firstAttempts[0].harnessId === 'claude-code' && firstAttempts[0].profileFingerprint === 'frozen:profile-first',
    'outcome identity comes from the launched session snapshot, not the task’s current route pin', firstAttempts[0]);

    attempt(retry, 'attempt_second', 'profile-second', 'large', 'high', 2);
    const approved = review(retry, 'approve', true, true)!;
    check(approved.accepted === 1 && approved.tests_passed === 1 && approved.cost_usd === 9
      && (JSON.parse(approved.attempts_json) as Attempt[]).length === 2,
    'approval after repair includes both the failed $7 attempt and final $2 attempt', approved);
    const reviews = d.prepare('SELECT accepted,cost_usd FROM work_outcome_reviews WHERE node_id=? ORDER BY rowid')
      .all(retry.id) as { accepted: number; cost_usd: number | null }[];
    check(reviews.length === 2 && reviews[0].accepted === 0 && reviews[0].cost_usd === 7
      && reviews[1].accepted === 1 && reviews[1].cost_usd === 9,
    'later approval does not overwrite the earlier failed review', reviews);
    const mixed = d.prepare('SELECT provider_id,model,effort,cost_usd,cost_reported FROM work_model_outcomes WHERE node_id=?')
      .get(retry.id) as { provider_id: string; model: string; effort: string | null; cost_usd: number; cost_reported: number };
    check(mixed.provider_id === 'mixed-profiles' && mixed.model === 'mixed routes' && mixed.effort === null
      && mixed.cost_usd === 9 && mixed.cost_reported === 1,
    'a repaired result spanning different routes is not credited to the final model alone', mixed);

    const unlaunched = node('unlaunched', 'verify');
    check(review(unlaunched, 'human_only', true, true) === undefined
      && !d.prepare('SELECT id FROM work_model_outcomes WHERE node_id=?').get(unlaunched.id),
    'a pinned model on a stage with no launched session earns no model evidence');

    const incomplete = node('incomplete');
    attempt(incomplete, 'metered', 'profile-first', 'small', 'low', 7);
    attempt(incomplete, 'unmetered', 'profile-first', 'small', 'low', null);
    const missingCost = review(incomplete, 'unknown_cost', true, true)!;
    const costs = (JSON.parse(missingCost.attempts_json) as Attempt[]).map(value => value.costUsd);
    check(missingCost.cost_usd === null && costs[0] === 7 && costs[1] === null,
      'one unmetered attempt makes total cost unknown while preserving the known subtotal per attempt', missingCost);
    const unknown = d.prepare('SELECT cost_reported FROM work_model_outcomes WHERE node_id=?')
      .get(incomplete.id) as { cost_reported: number };
    check(unknown.cost_reported === 0, 'the compatibility projection does not turn a partial subtotal into complete spend');

    const changedBackend = node('changed_backend');
    attempt(changedBackend, 'original_backend', 'reused-profile', 'same-model', 'low', 1);
    const changedSession = attempt(changedBackend, 'new_backend', 'reused-profile', 'same-model', 'low', 2);
    d.prepare('UPDATE session_log SET backend_id=? WHERE id=?').run('changed-backend', changedSession);
    const changedReview = review(changedBackend, 'backend_approval', true, true)!;
    const changedAttempts = JSON.parse(changedReview.attempts_json) as Attempt[];
    const changedProjection = d.prepare('SELECT provider_id,model FROM work_model_outcomes WHERE node_id=?')
      .get(changedBackend.id) as { provider_id: string; model: string };
    check(changedAttempts[0].backendId === 'anthropic' && changedAttempts[1].backendId === 'changed-backend'
      && changedProjection.provider_id === 'reused-profile' && changedProjection.model === 'mixed routes',
    'reusing a profile and model across different frozen backends is explicitly mixed route evidence', changedProjection);
  } finally {
    d.prepare('DELETE FROM projects WHERE id=?').run(projectId);
    for (const id of sessionIds) {
      d.prepare('DELETE FROM session_metrics WHERE session_id=?').run(id);
      d.prepare('DELETE FROM session_log WHERE id=?').run(id);
    }
  }
}
