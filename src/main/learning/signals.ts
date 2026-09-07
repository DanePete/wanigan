import { db } from '../db';
import type {
  JsonObject, LearningSignal, LearningSignalKind, RecordSignalInput,
  SemanticEligibility, SemanticEligibilityInput,
} from './types';
import { learningId, nonEmpty, optionalText, parseObject, sha256, stableJson, uniqueStrings } from './util';

type SignalRow = {
  id: string; kind: string; provider_id: string | null; backend_id: string | null;
  session_id: string | null; task_hash: string | null; project_id: string | null;
  project_path: string | null; path_scope: string | null; summary: string;
  detail_json: string; content_hash: string; semantic_eligible: number;
  created_at: number; processed_at: number | null;
};

function fromRow(row: SignalRow): LearningSignal {
  return {
    id: row.id,
    kind: row.kind,
    providerId: row.provider_id,
    backendId: row.backend_id,
    sessionId: row.session_id,
    taskHash: row.task_hash,
    projectId: row.project_id,
    projectPath: row.project_path,
    pathScope: row.path_scope,
    summary: row.summary,
    detail: parseObject(row.detail_json),
    contentHash: row.content_hash,
    semanticEligible: row.semantic_eligible === 1,
    createdAt: row.created_at,
    processedAt: row.processed_at,
  };
}

/**
 * The ceiling on one signal's structured evidence. It is exported alongside its
 * measurer because a caller that assembles a detail from what a user typed has
 * to be able to refuse an oversized one in that box's own words: a caller which
 * advertises its own, larger limit accepts a teaching that this rule then
 * rejects deeper down, naming an object the user has never seen.
 */
export const SIGNAL_DETAIL_MAX_BYTES = 32 * 1024;

/**
 * Weighs the serialised detail, which is what the row actually stores. JSON
 * escaping expands a string after any check on its raw byte length — every
 * newline and quote in a pasted procedure becomes two bytes — so a caller that
 * measured the raw text would under-count by however much of it needs escaping.
 */
export function signalDetailBytes(detail: JsonObject | null | undefined): number {
  return Buffer.byteLength(stableJson(detail ?? {}), 'utf8');
}

/**
 * Records a bounded summary and structured evidence, never a transcript. The
 * caller must opt semantic content in; operational signals default to false.
 */
export function recordSignal(input: RecordSignalInput): LearningSignal {
  const kind = nonEmpty(String(input.kind), 'Signal kind', 100);
  const summary = nonEmpty(input.summary, 'Signal summary', 4 * 1024);
  const detailJson = stableJson(input.detail ?? {});
  // Measured through the shared helper rather than re-spelling the arithmetic,
  // so this gate and a caller's own pre-flight check cannot drift apart.
  if (signalDetailBytes(input.detail) > SIGNAL_DETAIL_MAX_BYTES) {
    throw new Error(`Signal detail is too large (maximum ${SIGNAL_DETAIL_MAX_BYTES / 1024} KB). Store a citation instead of raw content.`);
  }

  const providerId = optionalText(input.providerId, 200);
  const backendId = optionalText(input.backendId, 200);
  const sessionId = optionalText(input.sessionId, 300);
  const taskHash = optionalText(input.taskHash, 300);
  const projectId = optionalText(input.projectId, 300);
  const projectPath = optionalText(input.projectPath, 4 * 1024);
  const pathScope = optionalText(input.pathScope, 4 * 1024);
  const createdAt = input.createdAt ?? Date.now();
  const contentHash = sha256(stableJson({
    kind, providerId, backendId, sessionId, taskHash, projectId, projectPath,
    pathScope, summary, detail: input.detail ?? {},
  }));

  const id = learningId('sig');
  db().prepare(`
    INSERT OR IGNORE INTO learning_signals
      (id,kind,provider_id,backend_id,session_id,task_hash,project_id,project_path,path_scope,
       summary,detail_json,content_hash,semantic_eligible,created_at,processed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)
  `).run(
    id, kind, providerId, backendId, sessionId, taskHash, projectId, projectPath, pathScope,
    summary, detailJson, contentHash, input.semanticEligible === true ? 1 : 0, createdAt,
  );

  const row = db().prepare('SELECT * FROM learning_signals WHERE content_hash=?').get(contentHash) as SignalRow | undefined;
  if (!row) throw new Error('Wanigan could not persist the learning signal.');
  return fromRow(row);
}

export interface SignalFilter {
  projectId?: string | null;
  providerId?: string | null;
  sessionId?: string | null;
  kinds?: LearningSignalKind[];
  processed?: boolean;
  limit?: number;
  order?: 'asc' | 'desc';
}

export function listSignals(filter: SignalFilter = {}): LearningSignal[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.projectId !== undefined) { where.push('project_id IS ?'); args.push(filter.projectId); }
  if (filter.providerId !== undefined) { where.push('provider_id IS ?'); args.push(filter.providerId); }
  if (filter.sessionId !== undefined) { where.push('session_id IS ?'); args.push(filter.sessionId); }
  if (filter.processed !== undefined) where.push(filter.processed ? 'processed_at IS NOT NULL' : 'processed_at IS NULL');
  const kinds = filter.kinds ? uniqueStrings(filter.kinds, 50) : [];
  if (kinds.length) {
    where.push(`kind IN (${kinds.map(() => '?').join(',')})`);
    args.push(...kinds);
  }
  const limit = Math.max(1, Math.min(1_000, filter.limit ?? 200));
  const direction = filter.order === 'asc' ? 'ASC' : 'DESC';
  const sql = `SELECT * FROM learning_signals ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at ${direction} LIMIT ?`;
  args.push(limit);
  return (db().prepare(sql).all(...args) as SignalRow[]).map(fromRow);
}

/**
 * The five stored columns a consolidation cluster key opens with. Two signals
 * can only ever land in the same cluster when all five agree -- the rest of the
 * key is derived from detail the database cannot group on -- so a partition
 * boundary never splits a cluster. That is what lets a pass bound itself by
 * whole partitions instead of by a row window: a row cursor would cut a
 * slow-forming pattern in half and neither half would ever reach the
 * two-observation threshold.
 */
export interface SignalPartition {
  kind: string;
  providerId: string | null;
  backendId: string | null;
  projectId: string | null;
  pathScope: string | null;
  /** Unprocessed rows in this partition at the moment it was counted. */
  pending: number;
  /** Stable ring position, and the cursor a later pass resumes after. */
  key: string;
}

type PartitionRow = {
  kind: string; provider_id: string | null; backend_id: string | null;
  project_id: string | null; path_scope: string | null; pending: number;
};

const partitionKey = (row: PartitionRow): string => JSON.stringify(
  [row.kind, row.provider_id, row.backend_id, row.project_id, row.path_scope],
);

/**
 * Every partition that still holds an unprocessed signal, in a stable order.
 * One aggregate row per distinct tuple, so the result stays small even when the
 * queue does not: a measured database with 2,864 unprocessed signals had 30
 * partitions. The cost is the grouped scan, which
 * idx_learning_signals_unprocessed_partition serves index-only.
 */
export function listUnprocessedPartitions(projectId?: string | null): SignalPartition[] {
  const scoped = projectId !== undefined;
  const rows = db().prepare(`
    SELECT kind, provider_id, backend_id, project_id, path_scope, COUNT(*) AS pending
      FROM learning_signals
     WHERE processed_at IS NULL${scoped ? ' AND project_id IS ?' : ''}
     GROUP BY kind, provider_id, backend_id, project_id, path_scope
  `).all(...(scoped ? [projectId] : [])) as PartitionRow[];
  return rows
    .map((row) => ({
      kind: row.kind,
      providerId: row.provider_id,
      backendId: row.backend_id,
      projectId: row.project_id,
      pathScope: row.path_scope,
      pending: row.pending,
      key: partitionKey(row),
    }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * Every unprocessed signal in one partition, oldest first. `limit` is a memory
 * ceiling and not a page: a partition read short has had a cluster cut in half,
 * so the caller is expected to notice and say so rather than report a clean
 * pass.
 */
/**
 * Every unprocessed signal in one cluster partition, whole.
 *
 * Deliberately unbounded. A partition is the atomic unit of consolidation
 * because the partition tuple is a true prefix of the cluster key, so two
 * signals that could cluster are always in the same partition -- and a short
 * read would cut a cluster in half. Worse, the read is oldest-first, so it
 * would cut at the undrainable head, which is precisely how the fixed
 * 1,000-row window made newer signals unreachable in the first place. The
 * caller's memory budget decides how many partitions a pass takes; it never
 * decides how much of one.
 */
export function listUnprocessedSignalsInPartition(
  partition: SignalPartition,
): LearningSignal[] {
  const rows = db().prepare(`
    SELECT * FROM learning_signals
     WHERE processed_at IS NULL
       AND kind IS ? AND provider_id IS ? AND backend_id IS ?
       AND project_id IS ? AND path_scope IS ?
     ORDER BY created_at ASC
  `).all(
    partition.kind, partition.providerId, partition.backendId,
    partition.projectId, partition.pathScope,
  ) as SignalRow[];
  return rows.map(fromRow);
}

export function getSignal(id: string): LearningSignal | null {
  const row = db().prepare('SELECT * FROM learning_signals WHERE id=?').get(id) as SignalRow | undefined;
  return row ? fromRow(row) : null;
}

export function markSignalsProcessed(ids: string[], at = Date.now()): number {
  const clean = uniqueStrings(ids);
  if (!clean.length) return 0;
  const statement = db().prepare('UPDATE learning_signals SET processed_at=? WHERE id=?');
  let changed = 0;
  db().transaction(() => {
    for (const id of clean) changed += statement.run(at, id).changes;
  })();
  return changed;
}

/**
 * Semantic extraction is allowed only through the backend which originally
 * processed the content. Harness/profile equality is the fallback for older
 * signals that predate backend ids. Local deterministic classification does
 * not call this gate and remains available for every signal.
 */
export function semanticExtractionEligibility(
  signal: LearningSignal,
  input: SemanticEligibilityInput,
): SemanticEligibility {
  if (!input.allowModelAssistance) return { eligible: false, reason: 'Model-assisted learning is disabled.' };
  if (input.excludedContent) return { eligible: false, reason: 'The source includes excluded external content.' };
  if (!signal.semanticEligible) return { eligible: false, reason: 'The signal was not opted into semantic learning.' };

  if (signal.backendId) {
    if (!input.extractionBackendId) return { eligible: false, reason: 'The extraction backend is unknown.' };
    return signal.backendId === input.extractionBackendId
      ? { eligible: true, reason: 'The source and extraction backend are identical.' }
      : { eligible: false, reason: 'Cross-backend content sharing is disabled.' };
  }
  if (signal.providerId) {
    return signal.providerId === input.extractionProviderId
      ? { eligible: true, reason: 'The legacy source and extraction provider are identical.' }
      : { eligible: false, reason: 'Cross-provider content sharing is disabled.' };
  }
  return { eligible: false, reason: 'The signal has no attributable provider/backend.' };
}
