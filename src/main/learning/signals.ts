import { db } from '../db';
import type {
  LearningSignal, LearningSignalKind, RecordSignalInput,
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
 * Records a bounded summary and structured evidence, never a transcript. The
 * caller must opt semantic content in; operational signals default to false.
 */
export function recordSignal(input: RecordSignalInput): LearningSignal {
  const kind = nonEmpty(String(input.kind), 'Signal kind', 100);
  const summary = nonEmpty(input.summary, 'Signal summary', 4 * 1024);
  const detailJson = stableJson(input.detail ?? {});
  if (Buffer.byteLength(detailJson, 'utf8') > 32 * 1024) {
    throw new Error('Signal detail is too large (maximum 32 KB). Store a citation instead of raw content.');
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
