import { createHash, randomUUID } from 'node:crypto';
import { db } from './db';
import { usageForMany } from './otel';

type AttemptRow = {
  id: string; provider_id: string | null; model: string | null; effort: string | null;
  backend_id: string | null; harness_id: string | null; provider_profile_json: string | null;
};

/** A human decision describes the result; its cost includes every attempt, including failed ones. */
export function recordOutcomeReview(node: { id: string; docket_id: string; kind: string },
  decisionId: string, accepted: boolean, testsPassed: boolean): void {
  const d = db();
  const sessions = d.prepare(`SELECT attempts.id,s.provider_id,s.model,s.effort,s.backend_id,s.harness_id,s.provider_profile_json
    FROM (SELECT session_id AS id FROM work_node_sessions WHERE node_id=?
      UNION SELECT session_id AS id FROM work_nodes WHERE id=? AND session_id IS NOT NULL) attempts
    LEFT JOIN session_log s ON s.id=attempts.id ORDER BY s.started_at,attempts.id`).all(node.id, node.id) as AttemptRow[];
  // A pinned route without a launched session is not model evidence. This
  // excludes human review and deterministic verification from model credit.
  if (!sessions.length) return;
  const usages = usageForMany(sessions.map(row => row.id));
  const attempts = sessions.map(row => {
    const usage = usages[row.id];
    let fingerprint: string | null = null;
    try {
      const profile = JSON.parse(row.provider_profile_json ?? 'null') as { profileFingerprint?: unknown } | null;
      if (typeof profile?.profileFingerprint === 'string') fingerprint = profile.profileFingerprint;
    } catch { /* old session metadata may not contain a profile snapshot */ }
    return {
      sessionId: row.id, providerId: row.provider_id, backendId: row.backend_id,
      harnessId: row.harness_id, profileFingerprint: fingerprint,
      profileSnapshotHash: row.provider_profile_json
        ? createHash('sha256').update(row.provider_profile_json).digest('hex') : null,
      model: (usage?.models.length ?? 0) > 1 ? 'mixed models'
        : row.model ?? (usage?.models.length === 1 ? usage.models[0] : null),
      requestedModel: row.model, observedModels: usage?.models ?? [], effort: row.effort,
      costUsd: row.provider_id && usage?.costStatus === 'reported' ? usage.costUsd : null,
      inputTokens: usage?.inTokens ?? null, outputTokens: usage?.outTokens ?? null,
    };
  });
  const reported = attempts.every(attempt => attempt.costUsd !== null);
  const cost = reported ? attempts.reduce((sum, attempt) => sum + attempt.costUsd!, 0) : null;
  const at = Date.now();
  d.prepare(`INSERT INTO work_outcome_reviews
    (id,decision_id,docket_id,node_id,accepted,tests_passed,cost_usd,attempts_json,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(`outcome_review_${randomUUID()}`, decisionId, node.docket_id, node.id,
    accepted ? 1 : 0, testsPassed ? 1 : 0, cost, JSON.stringify(attempts), at);

  // Keep the existing Model evidence API compatible. A mixed-route result is
  // named as such, never credited to whichever model happened to run last.
  const first = attempts[0];
  const same = (key: 'providerId' | 'model' | 'effort' | 'backendId' | 'harnessId' | 'profileFingerprint' | 'profileSnapshotHash') =>
    attempts.every(row => row[key] === first[key]);
  const provider = same('providerId') ? first.providerId ?? 'unknown-profile' : 'mixed-profiles';
  const sameProfile = same('backendId') && same('harnessId') && same('profileFingerprint') && same('profileSnapshotHash');
  const model = !sameProfile ? 'mixed routes' : same('model') ? first.model ?? 'unrecorded-model' : 'mixed models';
  d.prepare(`INSERT INTO work_model_outcomes
    (id,docket_id,node_id,provider_id,model,task_kind,accepted,tests_passed,cost_usd,cost_reported,effort,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(node_id) DO UPDATE SET
    provider_id=excluded.provider_id,model=excluded.model,accepted=excluded.accepted,tests_passed=excluded.tests_passed,
    cost_usd=excluded.cost_usd,cost_reported=excluded.cost_reported,effort=excluded.effort,created_at=excluded.created_at`)
    .run(`outcome_${randomUUID()}`, node.docket_id, node.id, provider, model, node.kind,
      accepted ? 1 : 0, testsPassed ? 1 : 0, cost ?? 0, reported ? 1 : 0, same('effort') ? first.effort : null, at);
}
