import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { RecoveryAdapter } from './recovery-contract';
import type { RecoveryObservation } from '../shared/recovery';

type Owner = { cwd: string; run_id: string; owner_id: string; owner_pid: number | null; lease_expires_at: number; state: string };
type Claim = { id: string; cwd: string; kind: string; operation_id: string; owner_id: string; created_at: number };
type Completion = { run_id: string; owner_id: string; activity_id: string; activity_owner_id: string; observed_at: number; source: string; run_revision: string };
type Run = { status: string; evidence_json: string | null };
const liveRuns = new Set<string>();
export function reviewRecoveryStarted(id: string): void { liveRuns.add(id); }
export function reviewRecoveryFinished(id: string): void { liveRuns.delete(id); }
const revision = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function claims(d: Database.Database, id: string): Claim[] {
  return d.prepare("SELECT * FROM checkout_activity WHERE kind='review' AND operation_id=? ORDER BY id").all(id) as Claim[];
}

function prepared(run: Run, cwd: string): boolean {
  try {
    const evidence = JSON.parse(run.evidence_json ?? 'null') as { before?: { cwd?: unknown; fingerprint?: unknown; unavailableReason?: unknown } } | null;
    const before = evidence?.before;
    return before?.cwd === cwd && typeof before.fingerprint === 'string'
      && /^[a-f0-9]{64}$/.test(before.fingerprint) && before.unavailableReason === null;
  } catch { return false; }
}

/** Called only by the runtime after all preparation/finalization completed and
 * before relinquishing its active map entry. Attempting even one reviewed
 * command forbids this receipt. A completed fingerprint is also required:
 * unavailable preparation may have timed out while Git was still finishing. */
export function recordReviewNeverSpawned(d: Database.Database, id: string, ownerId: string): void {
  const owner = d.prepare("SELECT * FROM review_checkout_owners WHERE run_id=? AND owner_id=? AND state='unresolved'")
    .get(id, ownerId) as Owner | undefined;
  const run = d.prepare('SELECT * FROM review_runs WHERE id=?').get(id) as Run | undefined;
  const activity = claims(d, id);
  if (!owner || !run || run.status === 'running' || !prepared(run, owner.cwd)
    || activity.length !== 1 || activity[0].cwd !== owner.cwd) return;
  d.prepare(`INSERT OR IGNORE INTO review_recovery_evidence
    (run_id,owner_id,activity_id,activity_owner_id,observed_at,source,run_revision)
    VALUES (?,?,?,?,?,'owner-finalized-never-spawned',?)`)
    .run(id, ownerId, activity[0].id, activity[0].owner_id, Date.now(), revision(run));
}

function inspect(d: Database.Database): RecoveryObservation[] {
  const owners = d.prepare('SELECT * FROM review_checkout_owners ORDER BY run_id').all() as Owner[];
  const observations = owners.map((owner): RecoveryObservation => {
    const run = d.prepare('SELECT * FROM review_runs WHERE id=?').get(owner.run_id) as Run | undefined;
    const completion = d.prepare('SELECT * FROM review_recovery_evidence WHERE run_id=?').get(owner.run_id) as Completion | undefined;
    const activity = claims(d, owner.run_id);
    const live = liveRuns.has(owner.run_id);
    const confirmed = !live && owner.state === 'unresolved' && Boolean(run && run.status !== 'running' && prepared(run, owner.cwd)
      && completion?.source === 'owner-finalized-never-spawned' && completion.owner_id === owner.owner_id
      && completion.run_revision === revision(run) && activity.length === 1
      && activity[0].id === completion.activity_id && activity[0].owner_id === completion.activity_owner_id
      && activity[0].cwd === owner.cwd);
    return {
      key: `review:${owner.run_id}`, module: 'review', operationId: owner.run_id, cwd: owner.cwd,
      execution: live ? 'owned/live' : confirmed ? 'confirmed finished' : 'unknown', checkout: 'held', billing: 'independent',
      source: confirmed ? 'Owning Review runtime: checkout preparation completed; no reviewed command spawn attempted'
        : live ? 'This runtime retains the Review operation' : 'Persisted Review ownership; descendant state is unproven',
      observedAt: confirmed ? completion!.observed_at : null,
      reason: confirmed ? 'The owning runtime completed its checkout fingerprint and finalized without attempting a reviewed command spawn. The exact retained claims can be released; the failed review result and independent billing evidence remain.'
        : live ? 'The owning runtime is still preparing, running or finalizing this review. Wait for its completion.'
          : 'No matching never-spawned completion exists. A missing owner, expired lease, old PID or completed shell does not establish that descendants stopped.',
      revision: revision({ owner, run, completion, activity }), canReconcile: confirmed,
    };
  });
  const legacy = d.prepare(`SELECT r.id,r.started_at,COALESCE(p.path,'') AS cwd FROM review_runs r
    LEFT JOIN projects p ON p.id=r.project_id LEFT JOIN review_checkout_owners o ON o.run_id=r.id
    WHERE r.status='running' AND o.run_id IS NULL ORDER BY r.id`).all() as { id: string; started_at: number; cwd: string }[];
  for (const run of legacy) observations.push({
    key: `review:${run.id}`, module: 'review', operationId: run.id, cwd: run.cwd || null,
    execution: 'unknown', checkout: 'held', billing: 'independent', source: 'Legacy Review result without execution identity',
    observedAt: run.started_at, reason: 'This historical operation has no owner completion evidence. Its execution remains unknown.',
    revision: revision(run), canReconcile: false,
  });
  return observations;
}

export const reviewRecoveryAdapter: RecoveryAdapter = {
  inspect,
  reconcile(d, observation) {
    const current = inspect(d).find(row => row.key === observation.key);
    if (!current?.canReconcile || current.revision !== observation.revision) throw new Error('Review recovery evidence changed; inspect it again.');
    const completion = d.prepare('SELECT * FROM review_recovery_evidence WHERE run_id=?').get(observation.operationId) as Completion;
    const owner = d.prepare("DELETE FROM review_checkout_owners WHERE run_id=? AND owner_id=? AND state='unresolved'")
      .run(completion.run_id, completion.owner_id);
    const activity = d.prepare("DELETE FROM checkout_activity WHERE id=? AND owner_id=? AND kind='review' AND operation_id=?")
      .run(completion.activity_id, completion.activity_owner_id, completion.run_id);
    if (owner.changes !== 1 || activity.changes !== 1) throw new Error('Review recovery claims changed; no release was committed.');
  },
};
