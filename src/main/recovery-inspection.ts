import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { RecoveryObservation } from '../shared/recovery';
import { markIncompleteCost, type AccountingMetric } from './telemetry-accounting';
import type { SessionUsage } from '../shared/types';

type Owner = 'sessions' | 'queue' | 'headless' | 'worktrees' | 'suggest' | 'usage';
type Read = { table: string; sql: string; source: string; billing?: boolean };
/** Read projections only. Each adapter is declared by the module owning these tables. */
const READS: Record<Owner, Read[]> = {
  sessions: [
    { table: 'checkout_activity', sql: 'SELECT id,operation_id,cwd,kind,owner_id,created_at AS at FROM checkout_activity', source: 'checkout ownership receipt' },
    { table: 'session_log', sql: 'SELECT id,id AS operation_id,COALESCE(worktree,project_path) AS cwd,started_at AS at FROM session_log WHERE ended_at IS NULL', source: 'session without terminal completion' },
  ],
  queue: [{ table: 'queue', sql: "SELECT id,id AS operation_id,state,lease_owner,lease_expires_at,recovery_unresolved,started_at AS at,attempts FROM queue WHERE state='running' OR recovery_unresolved=1", source: 'durable dispatcher claim' }],
  headless: [
    { table: 'headless_rows', sql: "SELECT run_id || ':' || project_id AS id,run_id AS operation_id,COALESCE(worktree,project_path) AS cwd,status,owner_id,owner_pid,recovery_unresolved,started_at AS at,ended_at FROM headless_rows WHERE status='running' OR recovery_unresolved=1", source: 'headless execution owner' },
    { table: 'headless_rows', sql: "SELECT run_id || ':' || project_id || ':unmetered' AS id,run_id AS operation_id,status,cost_reported,started_at AS at,ended_at FROM headless_rows WHERE started_at IS NOT NULL AND COALESCE(cost_reported,0)!=1", source: 'Headless run without reported cost', billing: true },
  ],
  worktrees: [{ table: 'worktree_command_runs', sql: "SELECT id,id AS operation_id,worktree AS cwd,status,owner_id,owner_pid,recovery_unresolved,started_at AS at,ended_at FROM worktree_command_runs WHERE status='running' OR recovery_unresolved=1", source: 'worktree command owner' }],
  suggest: [{ table: 'suggest_usage', sql: "SELECT CAST(id AS TEXT) AS id,COALESCE(request_id,CAST(id AS TEXT)) AS operation_id,at,attempt_status,finished_at FROM suggest_usage WHERE attempt_status IN ('pending','unresolved') OR (attempt_status='legacy' AND input_tokens IS NULL)", source: 'TypeSafe request liability', billing: true }],
  usage: [],
};

export function evidenceHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function hasTable(d: Database.Database, table: string): boolean {
  return Boolean(d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

export function inspectRecoveryOwner(d: Database.Database, owner: Owner): RecoveryObservation[] {
  if (owner === 'usage') return inspectUsageLiability(d);
  return READS[owner].flatMap(read => {
    if (!hasTable(d, read.table)) return [];
    const rows = d.prepare(read.sql).all() as Record<string, unknown>[];
    return rows.map(row => ({
      key: `${owner}:${read.table}:${String(row.id)}`, module: owner,
      operationId: String(row.operation_id), cwd: typeof row.cwd === 'string' ? row.cwd : null,
      execution: 'unknown' as const, checkout: typeof row.cwd === 'string' ? 'held' as const : 'not claimed' as const,
      billing: read.billing ? 'unresolved' as const : 'independent' as const,
      source: read.source, observedAt: typeof row.at === 'number' ? row.at : null,
      reason: read.billing
        ? 'The recorded operation has unresolved financial exposure; these records do not establish that no request was submitted. Local process completion cannot settle its bill.'
        : 'This durable claim has no supported completion proof. An expired lease, missing parent or reused PID cannot release it.',
      revision: evidenceHash(row), canReconcile: false,
    }));
  });
}

function inspectUsageLiability(d: Database.Database): RecoveryObservation[] {
  if (!hasTable(d, 'session_telemetry_issues')) return [];
  const rows = d.prepare(`SELECT session_id,MAX(at) AS at FROM (
    SELECT session_id,last_at AS at FROM session_metrics
    UNION ALL SELECT session_id,at FROM session_api_events
    UNION ALL SELECT session_id,last_at AS at FROM session_telemetry_issues
    UNION ALL SELECT session_id,CAST(MAX(COALESCE(activity_at_ns,'0'),COALESCE(cost_at_ns,'0')) AS REAL)/1000000 AS at
      FROM session_telemetry_coverage
  ) GROUP BY session_id ORDER BY session_id`).all() as { session_id: string; at: number }[];
  const usage = new Map<string, Pick<SessionUsage, 'costStatus'>>(rows.map(row => [row.session_id, { costStatus: 'reported' }]));
  const metrics = d.prepare('SELECT session_id,metric,attrs,value,last_at,last_at_ns FROM session_metrics').all() as AccountingMetric[];
  // The same coverage predicate used by spending admission, not a second
  // interpretation which a more recent meter could accidentally satisfy.
  markIncompleteCost(d, usage, metrics);
  return rows.filter(row => usage.get(row.session_id)?.costStatus === 'unavailable').map(row => ({
    key: `usage:${row.session_id}`, module: 'usage', operationId: row.session_id, cwd: null,
    execution: 'unsupported', checkout: 'not claimed', billing: 'unresolved',
    source: 'Recorded telemetry coverage', observedAt: row.at,
    reason: 'Observed activity has incomplete cost coverage. Restoring cannot erase this financial uncertainty.',
    revision: usageRevision(d, row, metrics.filter(metric => metric.session_id === row.session_id)), canReconcile: false,
  }));
}

/** A MAX timestamp is disclosure, not a revision. A late API event, corrected
 * source ledger or added issue at the same time must invalidate the preview.
 * Hash only accounting columns and stream them; no raw event detail is copied
 * into the bounded resolution receipt. */
function usageRevision(d: Database.Database, row: { session_id: string; at: number }, metrics: AccountingMetric[]): string {
  const hash = createHash('sha256').update(evidenceHash([row, metrics]));
  for (const sql of [
    `SELECT id,at,at_ns,kind,model,cost_usd,coverage_attrs FROM session_api_events WHERE session_id=? ORDER BY id`,
    `SELECT stream_key,attrs_json,cost_usd,cost_at_ns,activity_at_ns FROM session_telemetry_coverage WHERE session_id=? ORDER BY stream_key`,
    `SELECT reason,last_at FROM session_telemetry_issues WHERE session_id=? ORDER BY reason`,
  ]) {
    hash.update(sql);
    for (const evidence of d.prepare(sql).iterate(row.session_id)) hash.update(JSON.stringify(evidence));
  }
  return hash.digest('hex');
}

/** Legacy remote submission has no module adapter yet. Read it without changing ownership. */
export function inspectLegacyRemoteLiability(d: Database.Database): RecoveryObservation[] {
  // abandonUnfetchable deliberately stops polling after the result-retention
  // window and stamps ingestion, but its error receipt explicitly says the
  // results were lost. That stamp cannot become proof of known billing.
  const lostResults = `EXISTS (SELECT 1 FROM events e WHERE e.run_id=b.run_id AND e.level='error'
    AND instr(e.message,'Batch ' || b.id || ' was never downloaded and its results are now past the 29-day window')=1)`;
  const reads = [
    { table: 'batches', sql: `SELECT b.id,b.run_id AS operation_id,b.created_at AS at,b.processing_status,
      b.results_ingested_at,${lostResults} AS results_lost FROM batches b WHERE b.processing_status != 'ended'
      OR b.results_ingested_at IS NULL OR b.results_ingested_at < 0 OR ${lostResults}`, source: 'batch provider submission or unaccounted results' },
    { table: 'runs', sql: "SELECT id,id AS operation_id,created_at AS at,status FROM runs WHERE kind != 'headless' AND (status IN ('submitting','in_progress','canceling') OR (status='failed' AND total_requests>0))", source: 'unfinished or failed remote submission' },
    { table: 'learning_model_runs', sql: `SELECT id,id AS operation_id,at,status,cost_reported,cost_usd
      FROM learning_model_runs WHERE status NOT IN ('ok','failed','refused')
      OR (status IN ('ok','failed') AND COALESCE(cost_reported,0)!=1)`, source: 'learning-model request with unresolved metering' },
    { table: 'companion_turns', sql: 'SELECT id,id AS operation_id,at,status,input_tokens,output_tokens,cost_usd FROM companion_turns WHERE cost_usd IS NULL', source: 'companion turn without accounted cost' },
    // Interview totals do not preserve a reservation or a result for every
    // attempted call. A later successful answer can replace an earlier error.
    // Even a committed/abandoned interview cannot prove that history settled.
    { table: 'interviews', sql: 'SELECT id,id AS operation_id,updated_at AS at,status,calls,spend_usd FROM interviews', source: 'legacy interview without a complete per-request liability ledger' },
  ];
  return reads.flatMap(read => {
    if (!hasTable(d, read.table)) return [];
    return (d.prepare(read.sql).all() as Record<string, unknown>[]).map(row => ({
      key: `legacy:${read.table}:${String(row.id)}`, module: `legacy-${read.table}`, operationId: String(row.operation_id), cwd: null,
      execution: 'unsupported' as const, checkout: 'not claimed' as const, billing: 'unresolved' as const,
      source: read.source, observedAt: typeof row.at === 'number' ? row.at : null,
      reason: 'Remote submission may still be executing or billable. This phase cannot reconcile it.',
      revision: evidenceHash(row), canReconcile: false,
    }));
  });
}
