import { db } from '../db';
import { getCandidate, getKnowledgeItem, getKnowledgeVersion } from './repository';
import type {
  ArtifactMetric, ArtifactRoiSummary, CreateExperimentInput, EvidenceLevel,
  ExperimentStatus, JsonObject, LearningExperiment, RecordMetricInput,
} from './types';
import { learningId, nonEmpty, parseObject, stableJson, uniqueStrings } from './util';

type ExperimentRow = {
  id: string; name: string; project_id: string | null; item_id: string | null;
  candidate_id: string | null; baseline_version_id: string | null; candidate_version_id: string | null;
  provider_id: string; model: string; effort: string | null; commit_hash: string;
  config_json: string; status: string; outcome_json: string | null; created_at: number;
  started_at: number | null; ended_at: number | null;
};
type MetricRow = {
  id: string; item_id: string | null; version_id: string | null; projection_id: string | null;
  session_id: string | null; provider_id: string | null; metric: string; value: number;
  evidence_level: string; attrs_json: string; at: number;
};

const experimentFromRow = (row: ExperimentRow): LearningExperiment => ({
  id: row.id,
  name: row.name,
  projectId: row.project_id,
  itemId: row.item_id,
  candidateId: row.candidate_id,
  baselineVersionId: row.baseline_version_id,
  candidateVersionId: row.candidate_version_id,
  providerId: row.provider_id,
  model: row.model,
  effort: row.effort,
  commitHash: row.commit_hash,
  config: parseObject(row.config_json),
  status: row.status as ExperimentStatus,
  outcome: row.outcome_json ? parseObject(row.outcome_json) : null,
  createdAt: row.created_at,
  startedAt: row.started_at,
  endedAt: row.ended_at,
});

const metricFromRow = (row: MetricRow): ArtifactMetric => ({
  id: row.id,
  itemId: row.item_id,
  versionId: row.version_id,
  projectionId: row.projection_id,
  sessionId: row.session_id,
  providerId: row.provider_id,
  metric: row.metric,
  value: row.value,
  evidenceLevel: row.evidence_level as EvidenceLevel,
  attrs: parseObject(row.attrs_json),
  at: row.at,
});

function assertFixedControls(input: CreateExperimentInput): void {
  const config = input.config ?? {};
  const variants = [config.baseline, config.candidate].filter((v): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v));
  for (const variant of variants) {
    for (const [field, expected] of [
      ['providerId', input.providerId], ['model', input.model],
      ['effort', input.effort ?? null], ['commitHash', input.commitHash],
    ] as const) {
      if (field in variant && variant[field] !== expected) {
        throw new Error(`Experiment ${field} must remain fixed between baseline and candidate.`);
      }
    }
  }
}

export function createExperiment(input: CreateExperimentInput): LearningExperiment {
  if (!input.candidateId && !input.candidateVersionId) throw new Error('An experiment needs a candidate or candidate version.');
  if (input.itemId && !getKnowledgeItem(input.itemId)) throw new Error('Experiment knowledge item not found.');
  if (input.candidateId && !getCandidate(input.candidateId)) throw new Error('Experiment candidate not found.');
  const baselineVersion = input.baselineVersionId ? getKnowledgeVersion(input.baselineVersionId) : null;
  const candidateVersion = input.candidateVersionId ? getKnowledgeVersion(input.candidateVersionId) : null;
  if (input.baselineVersionId && !baselineVersion) throw new Error('Baseline knowledge version not found.');
  if (input.candidateVersionId && !candidateVersion) throw new Error('Candidate knowledge version not found.');
  if (baselineVersion && candidateVersion && baselineVersion.itemId !== candidateVersion.itemId) {
    throw new Error('Baseline and candidate versions must belong to the same knowledge item.');
  }
  if (input.itemId && [baselineVersion, candidateVersion].some((version) => version && version.itemId !== input.itemId)) {
    throw new Error('Experiment versions do not belong to the selected knowledge item.');
  }
  if (input.baselineVersionId && input.baselineVersionId === input.candidateVersionId) {
    throw new Error('Baseline and candidate versions must differ.');
  }
  assertFixedControls(input);
  const configJson = stableJson(input.config ?? {});
  if (Buffer.byteLength(configJson, 'utf8') > 128 * 1024) throw new Error('Experiment config is too large.');
  const id = learningId('exp');
  db().prepare(`
    INSERT INTO learning_experiments
      (id,name,project_id,item_id,candidate_id,baseline_version_id,candidate_version_id,provider_id,
       model,effort,commit_hash,config_json,status,outcome_json,created_at,started_at,ended_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'draft',NULL,?,NULL,NULL)
  `).run(
    id, nonEmpty(input.name, 'Experiment name', 500), input.projectId ?? null, input.itemId ?? null,
    input.candidateId ?? null, input.baselineVersionId ?? null, input.candidateVersionId ?? null,
    nonEmpty(input.providerId, 'Experiment provider', 200), nonEmpty(input.model, 'Experiment model', 300),
    input.effort ?? null, nonEmpty(input.commitHash, 'Experiment commit', 300), configJson, Date.now(),
  );
  return getExperiment(id)!;
}

export function getExperiment(id: string): LearningExperiment | null {
  const row = db().prepare('SELECT * FROM learning_experiments WHERE id=?').get(id) as ExperimentRow | undefined;
  return row ? experimentFromRow(row) : null;
}

export function listExperiments(filter: { projectId?: string | null; statuses?: ExperimentStatus[]; limit?: number } = {}): LearningExperiment[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.projectId !== undefined) { where.push('project_id IS ?'); args.push(filter.projectId); }
  const statuses = uniqueStrings(filter.statuses ?? [], 10);
  if (statuses.length) { where.push(`status IN (${statuses.map(() => '?').join(',')})`); args.push(...statuses); }
  args.push(Math.max(1, Math.min(500, filter.limit ?? 100)));
  return (db().prepare(`SELECT * FROM learning_experiments ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`)
    .all(...args) as ExperimentRow[]).map(experimentFromRow);
}

export function startExperiment(id: string): LearningExperiment {
  const current = getExperiment(id);
  if (!current) throw new Error('Learning experiment not found.');
  if (current.status !== 'draft') throw new Error(`A ${current.status} experiment cannot be started.`);
  db().prepare("UPDATE learning_experiments SET status='running',started_at=? WHERE id=?").run(Date.now(), id);
  return getExperiment(id)!;
}

export function completeExperiment(id: string, outcome: JsonObject): LearningExperiment {
  const current = getExperiment(id);
  if (!current) throw new Error('Learning experiment not found.');
  if (current.status !== 'running') throw new Error(`A ${current.status} experiment cannot be completed.`);
  const outcomeJson = stableJson(outcome);
  if (Buffer.byteLength(outcomeJson, 'utf8') > 128 * 1024) throw new Error('Experiment outcome is too large.');
  db().prepare("UPDATE learning_experiments SET status='completed',outcome_json=?,ended_at=? WHERE id=?")
    .run(outcomeJson, Date.now(), id);
  return getExperiment(id)!;
}

export function endExperiment(id: string, status: 'cancelled' | 'failed', detail?: string): LearningExperiment {
  const current = getExperiment(id);
  if (!current) throw new Error('Learning experiment not found.');
  if (current.status !== 'draft' && current.status !== 'running') throw new Error(`A ${current.status} experiment cannot be ended.`);
  db().prepare('UPDATE learning_experiments SET status=?,outcome_json=?,ended_at=? WHERE id=?')
    .run(status, stableJson(detail ? { detail } : {}), Date.now(), id);
  return getExperiment(id)!;
}

export function recordMetric(input: RecordMetricInput): ArtifactMetric {
  if (!input.itemId && !input.versionId && !input.projectionId && !input.sessionId) {
    throw new Error('A metric must identify an artifact, projection, version, or session.');
  }
  if (!Number.isFinite(input.value)) throw new Error('Metric value must be finite.');
  const attrsJson = stableJson(input.attrs ?? {});
  if (Buffer.byteLength(attrsJson, 'utf8') > 32 * 1024) throw new Error('Metric attributes are too large.');
  const id = learningId('met');
  db().prepare(`
    INSERT INTO artifact_metrics
      (id,item_id,version_id,projection_id,session_id,provider_id,metric,value,evidence_level,attrs_json,at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    id, input.itemId ?? null, input.versionId ?? null, input.projectionId ?? null,
    input.sessionId ?? null, input.providerId ?? null, nonEmpty(input.metric, 'Metric name', 100),
    input.value, input.evidenceLevel, attrsJson, input.at ?? Date.now(),
  );
  const row = db().prepare('SELECT * FROM artifact_metrics WHERE id=?').get(id) as MetricRow;
  return metricFromRow(row);
}

export function listMetrics(filter: {
  itemId?: string; versionId?: string; projectionId?: string; sessionId?: string;
  metric?: string; providerId?: string; since?: number; limit?: number;
} = {}): ArtifactMetric[] {
  const where: string[] = [];
  const args: unknown[] = [];
  for (const [column, value] of [
    ['item_id', filter.itemId], ['version_id', filter.versionId], ['projection_id', filter.projectionId],
    ['session_id', filter.sessionId], ['metric', filter.metric], ['provider_id', filter.providerId],
  ] as const) {
    if (value) { where.push(`${column}=?`); args.push(value); }
  }
  if (filter.since != null) { where.push('at>=?'); args.push(filter.since); }
  args.push(Math.max(1, Math.min(5_000, filter.limit ?? 1_000)));
  return (db().prepare(`SELECT * FROM artifact_metrics ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY at DESC LIMIT ?`)
    .all(...args) as MetricRow[]).map(metricFromRow);
}

const LEVELS: Record<EvidenceLevel, number> = { estimate: 0, correlation: 1, causal: 2 };

/**
 * Metric names are intentionally small and stable. Unknown metrics remain in
 * the ledger but do not get silently folded into ROI.
 */
export function summarizeArtifactRoi(itemId: string): ArtifactRoiSummary {
  if (!getKnowledgeItem(itemId)) throw new Error('Knowledge item not found.');
  const metrics = listMetrics({ itemId, limit: 5_000 });
  let evidenceLevel: EvidenceLevel = metrics.length ? 'causal' : 'estimate';
  const total = (name: string) => metrics.filter((metric) => metric.metric === name).reduce((sum, metric) => sum + metric.value, 0);
  // A rollup is only as strong as its weakest included measurement. One A/B
  // result must not turn unrelated estimated cost figures into causal proof.
  for (const metric of metrics) if (LEVELS[metric.evidenceLevel] < LEVELS[evidenceLevel]) evidenceLevel = metric.evidenceLevel;
  return {
    itemId,
    evidenceLevel,
    samples: metrics.length,
    tokensLoaded: total('tokens_loaded'),
    tokensSaved: total('tokens_saved'),
    costUsd: total('cost_usd'),
    successfulUses: total('use_success'),
    failedUses: total('use_failure'),
    repairDelta: total('repair_delta'),
  };
}
