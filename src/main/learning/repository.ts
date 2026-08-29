import { db } from '../db';
import { automationDecision } from './classifier';
import type {
  AddEvidenceInput, ArtifactScope, CandidateConflict, CandidateStatus, CreateCandidateInput,
  JsonObject, KnowledgeCandidate, KnowledgeEvidence, KnowledgeItem, KnowledgeKind,
  KnowledgeRelation, KnowledgeSearchInput, KnowledgeSearchResult, KnowledgeStatus,
  KnowledgeVersion, RelationKind,
} from './types';
import {
  clamp, estimateTokens, ftsExpression, learningId, nonEmpty, optionalText,
  parseObject, parseStringArray, scopeMatches, sha256, stableJson, uniqueStrings,
} from './util';

type ItemRow = {
  id: string; kind: string; scope: string; project_id: string | null; path_scope: string | null;
  title: string; canonical_text: string; status: string; confidence: number; source_count: number;
  current_version: number; content_hash: string; created_at: number; updated_at: number;
  last_validated_at: number | null; expires_at: number | null; superseded_by: string | null;
};
type VersionRow = {
  id: string; item_id: string; version: number; canonical_text: string; metadata_json: string;
  content_hash: string; created_by: string; previous_version_id: string | null; created_at: number;
};
type CandidateRow = {
  id: string; item_id: string | null; target_kind: string; scope: string; provider_id: string | null;
  project_id: string | null; path_scope: string | null; title: string; proposed_text: string;
  rationale: string; confidence: number; status: string; evidence_count: number; task_count: number;
  estimated_token_delta: number; conflicts_json: string; signal_ids_json: string; created_at: number;
  updated_at: number; reviewed_at: number | null; reviewer_note: string | null;
};
type EvidenceRow = {
  id: string; item_id: string | null; version_id: string | null; candidate_id: string | null;
  signal_id: string | null; source_type: string; source_id: string; citation: string;
  content_hash: string | null; weight: number; observed_at: number;
};
type RelationRow = {
  from_item_id: string; to_item_id: string; relation: string; confidence: number;
  evidence_json: string; created_at: number; resolved_at: number | null;
};

const itemFromRow = (row: ItemRow): KnowledgeItem => ({
  id: row.id,
  kind: row.kind as KnowledgeKind,
  scope: row.scope as ArtifactScope,
  projectId: row.project_id,
  pathScope: row.path_scope,
  title: row.title,
  canonicalText: row.canonical_text,
  status: row.status as KnowledgeStatus,
  confidence: row.confidence,
  sourceCount: row.source_count,
  currentVersion: row.current_version,
  contentHash: row.content_hash,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  lastValidatedAt: row.last_validated_at,
  expiresAt: row.expires_at,
  supersededBy: row.superseded_by,
});

const versionFromRow = (row: VersionRow): KnowledgeVersion => ({
  id: row.id,
  itemId: row.item_id,
  version: row.version,
  canonicalText: row.canonical_text,
  metadata: parseObject(row.metadata_json),
  contentHash: row.content_hash,
  createdBy: row.created_by,
  previousVersionId: row.previous_version_id,
  createdAt: row.created_at,
});

const candidateFromRow = (row: CandidateRow): KnowledgeCandidate => ({
  id: row.id,
  itemId: row.item_id,
  targetKind: row.target_kind as KnowledgeKind,
  scope: row.scope as ArtifactScope,
  providerId: row.provider_id,
  projectId: row.project_id,
  pathScope: row.path_scope,
  title: row.title,
  proposedText: row.proposed_text,
  rationale: row.rationale,
  confidence: row.confidence,
  status: row.status as CandidateStatus,
  evidenceCount: row.evidence_count,
  taskCount: row.task_count,
  estimatedTokenDelta: row.estimated_token_delta,
  conflicts: safeConflicts(row.conflicts_json),
  signalIds: parseStringArray(row.signal_ids_json),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  reviewedAt: row.reviewed_at,
  reviewerNote: row.reviewer_note,
});

const evidenceFromRow = (row: EvidenceRow): KnowledgeEvidence => ({
  id: row.id,
  itemId: row.item_id,
  versionId: row.version_id,
  candidateId: row.candidate_id,
  signalId: row.signal_id,
  sourceType: row.source_type,
  sourceId: row.source_id,
  citation: row.citation,
  contentHash: row.content_hash,
  weight: row.weight,
  observedAt: row.observed_at,
});

function safeConflicts(value: string): CandidateConflict[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is CandidateConflict => {
      if (!v || typeof v !== 'object') return false;
      const c = v as Partial<CandidateConflict>;
      return typeof c.itemId === 'string' && typeof c.title === 'string'
        && (c.relation === 'duplicate' || c.relation === 'possible-conflict')
        && typeof c.reason === 'string';
    });
  } catch { return []; }
}

export function getCandidate(id: string): KnowledgeCandidate | null {
  const row = db().prepare('SELECT * FROM knowledge_candidates WHERE id=?').get(id) as CandidateRow | undefined;
  return row ? candidateFromRow(row) : null;
}

export interface CandidateFilter {
  status?: CandidateStatus | CandidateStatus[];
  projectId?: string | null;
  providerId?: string | null;
  limit?: number;
}

export function listCandidates(filter: CandidateFilter = {}): KnowledgeCandidate[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.status) {
    const statuses = uniqueStrings(Array.isArray(filter.status) ? filter.status : [filter.status], 20);
    where.push(`status IN (${statuses.map(() => '?').join(',')})`); args.push(...statuses);
  }
  if (filter.projectId !== undefined) { where.push('project_id IS ?'); args.push(filter.projectId); }
  if (filter.providerId !== undefined) { where.push('provider_id IS ?'); args.push(filter.providerId); }
  args.push(Math.max(1, Math.min(500, filter.limit ?? 100)));
  return (db().prepare(`SELECT * FROM knowledge_candidates ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC LIMIT ?`)
    .all(...args) as CandidateRow[]).map(candidateFromRow);
}

export function findCandidateConflicts(input: Pick<CreateCandidateInput, 'itemId' | 'targetKind' | 'scope' | 'projectId' | 'pathScope' | 'title' | 'proposedText'>): CandidateConflict[] {
  const hash = sha256(input.proposedText.trim());
  const rows = db().prepare(`
    SELECT id,title,content_hash,canonical_text FROM knowledge_items
    WHERE status='active' AND kind=? AND scope=? AND project_id IS ? AND path_scope IS ?
      AND (? IS NULL OR id != ?)
      AND (content_hash=? OR LOWER(title)=LOWER(?))
    ORDER BY updated_at DESC LIMIT 30
  `).all(
    input.targetKind, input.scope, input.projectId ?? null, input.pathScope ?? null,
    input.itemId ?? null, input.itemId ?? null, hash, input.title,
  ) as { id: string; title: string; content_hash: string; canonical_text: string }[];
  return rows.map((row) => row.content_hash === hash
    ? { itemId: row.id, title: row.title, relation: 'duplicate' as const, reason: 'Canonical text is identical.' }
    : {
        itemId: row.id, title: row.title, relation: 'possible-conflict' as const,
        reason: 'Another active artifact occupies the same kind and scope; compare their claims before promotion.',
      });
}

export function createCandidate(input: CreateCandidateInput): KnowledgeCandidate {
  const title = nonEmpty(input.title, 'Candidate title', 500);
  const proposedText = nonEmpty(input.proposedText, 'Proposed knowledge', 128 * 1024);
  const rationale = nonEmpty(input.rationale, 'Candidate rationale', 8 * 1024);
  if (input.scope !== 'personal' && !input.projectId) throw new Error('Project and path-scoped candidates need a project id.');
  if (input.scope === 'path' && !input.pathScope) throw new Error('A path-scoped candidate needs a path selector.');
  const signalIds = uniqueStrings(input.signalIds);
  if (!signalIds.length) throw new Error('A candidate needs at least one learning signal.');

  const placeholders = signalIds.map(() => '?').join(',');
  const counts = db().prepare(`
    SELECT COUNT(*) AS evidence_count,
      COUNT(DISTINCT COALESCE(task_hash,session_id)) AS task_count
    FROM learning_signals WHERE id IN (${placeholders})
  `).get(...signalIds) as { evidence_count: number; task_count: number };
  if (counts.evidence_count !== signalIds.length) throw new Error('One or more learning signals no longer exist.');

  const normalized = {
    ...input,
    itemId: input.itemId ?? null,
    projectId: input.projectId ?? null,
    pathScope: input.pathScope ?? null,
    proposedText,
  };
  const conflicts = findCandidateConflicts(normalized);
  const now = Date.now();
  const id = learningId('cand');
  db().prepare(`
    INSERT INTO knowledge_candidates
      (id,item_id,target_kind,scope,provider_id,project_id,path_scope,title,proposed_text,rationale,
       confidence,status,evidence_count,task_count,estimated_token_delta,conflicts_json,signal_ids_json,
       created_at,updated_at,reviewed_at,reviewer_note)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,'pending',?,?,?,?,?,?,?,NULL,NULL)
  `).run(
    id, input.itemId ?? null, input.targetKind, input.scope, input.providerId ?? null,
    input.projectId ?? null, input.pathScope ?? null, title, proposedText, rationale,
    clamp(input.confidence), counts.evidence_count, counts.task_count,
    Math.trunc(input.estimatedTokenDelta ?? estimateTokens(proposedText)),
    stableJson(conflicts), stableJson(signalIds), now, now,
  );
  return getCandidate(id)!;
}

export type UpdateCandidatePatch = Partial<Pick<
  CreateCandidateInput,
  'title' | 'proposedText' | 'targetKind' | 'scope' | 'providerId' | 'projectId' | 'pathScope'
>>;

/** Edit the proposed artifact before approval without rewriting its evidence. */
export function updateCandidate(id: string, patch: UpdateCandidatePatch): KnowledgeCandidate {
  const current = getCandidate(id);
  if (!current) throw new Error('Learning candidate not found.');
  if (current.status !== 'pending' && current.status !== 'snoozed') {
    throw new Error(`A ${current.status} candidate is immutable. Reopen or create a replacement.`);
  }
  const next = {
    itemId: current.itemId,
    targetKind: patch.targetKind ?? current.targetKind,
    scope: patch.scope ?? current.scope,
    providerId: patch.providerId !== undefined ? patch.providerId : current.providerId,
    projectId: patch.projectId !== undefined ? patch.projectId : current.projectId,
    pathScope: patch.pathScope !== undefined ? patch.pathScope : current.pathScope,
    title: patch.title !== undefined ? nonEmpty(patch.title, 'Candidate title', 500) : current.title,
    proposedText: patch.proposedText !== undefined
      ? nonEmpty(patch.proposedText, 'Proposed knowledge', 128 * 1024)
      : current.proposedText,
  };
  if (next.scope !== 'personal' && !next.projectId) throw new Error('Project and path-scoped candidates need a project id.');
  if (next.scope === 'path' && !next.pathScope) throw new Error('A path-scoped candidate needs a path selector.');
  if (next.scope !== 'path') next.pathScope = null;
  const conflicts = findCandidateConflicts(next);
  db().prepare(`
    UPDATE knowledge_candidates SET target_kind=?,scope=?,provider_id=?,project_id=?,path_scope=?,
      title=?,proposed_text=?,estimated_token_delta=?,conflicts_json=?,updated_at=? WHERE id=?
  `).run(
    next.targetKind, next.scope, next.providerId, next.projectId, next.pathScope, next.title,
    next.proposedText, estimateTokens(next.proposedText), stableJson(conflicts), Date.now(), id,
  );
  return getCandidate(id)!;
}

export type ReviewAction = 'approve' | 'reject' | 'snooze' | 'reopen';

export function reviewCandidate(id: string, action: ReviewAction, note?: string | null): KnowledgeCandidate {
  const candidate = getCandidate(id);
  if (!candidate) throw new Error('Learning candidate not found.');
  const transitions: Record<ReviewAction, CandidateStatus[]> = {
    approve: ['pending', 'snoozed'],
    reject: ['pending', 'snoozed', 'approved'],
    snooze: ['pending'],
    reopen: ['rejected', 'snoozed'],
  };
  if (!transitions[action].includes(candidate.status)) {
    throw new Error(`A ${candidate.status} candidate cannot be ${action}d.`);
  }
  const status: CandidateStatus = action === 'approve' ? 'approved'
    : action === 'reject' ? 'rejected'
      : action === 'snooze' ? 'snoozed' : 'pending';
  const reviewerNote = optionalText(note, 8 * 1024);
  const now = Date.now();
  db().prepare('UPDATE knowledge_candidates SET status=?,reviewed_at=?,reviewer_note=?,updated_at=? WHERE id=?')
    .run(status, action === 'reopen' ? null : now, reviewerNote, now, id);
  return getCandidate(id)!;
}

export function getKnowledgeItem(id: string): KnowledgeItem | null {
  const row = db().prepare('SELECT * FROM knowledge_items WHERE id=?').get(id) as ItemRow | undefined;
  return row ? itemFromRow(row) : null;
}

export interface ItemFilter {
  projectId?: string | null;
  scope?: ArtifactScope;
  kinds?: KnowledgeKind[];
  statuses?: KnowledgeStatus[];
  limit?: number;
}

export function listKnowledgeItems(filter: ItemFilter = {}): KnowledgeItem[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.projectId !== undefined) { where.push('project_id IS ?'); args.push(filter.projectId); }
  if (filter.scope) { where.push('scope=?'); args.push(filter.scope); }
  for (const [column, values] of [['kind', filter.kinds], ['status', filter.statuses]] as const) {
    const clean = values ? uniqueStrings(values, 20) : [];
    if (clean.length) { where.push(`${column} IN (${clean.map(() => '?').join(',')})`); args.push(...clean); }
  }
  args.push(Math.max(1, Math.min(1_000, filter.limit ?? 250)));
  return (db().prepare(`SELECT * FROM knowledge_items ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC LIMIT ?`)
    .all(...args) as ItemRow[]).map(itemFromRow);
}

export function getKnowledgeVersion(id: string): KnowledgeVersion | null {
  const row = db().prepare('SELECT * FROM knowledge_versions WHERE id=?').get(id) as VersionRow | undefined;
  return row ? versionFromRow(row) : null;
}

export function currentKnowledgeVersion(itemId: string): KnowledgeVersion | null {
  const row = db().prepare(`
    SELECT v.* FROM knowledge_versions v JOIN knowledge_items i ON i.id=v.item_id
    WHERE i.id=? AND v.version=i.current_version
  `).get(itemId) as VersionRow | undefined;
  return row ? versionFromRow(row) : null;
}

export function listKnowledgeVersions(itemId: string): KnowledgeVersion[] {
  return (db().prepare('SELECT * FROM knowledge_versions WHERE item_id=? ORDER BY version DESC')
    .all(itemId) as VersionRow[]).map(versionFromRow);
}

function refreshFts(item: KnowledgeItem): void {
  db().prepare('DELETE FROM knowledge_fts WHERE item_id=?').run(item.id);
  if (item.status === 'active') {
    db().prepare('INSERT INTO knowledge_fts (item_id,title,canonical_text,path_scope) VALUES (?,?,?,?)')
      .run(item.id, item.title, item.canonicalText, item.pathScope ?? '');
  }
}

export interface PromoteCandidateOptions {
  createdBy: 'user' | 'automation' | string;
  allowAutomatic?: boolean;
  metadata?: JsonObject;
  expiresAt?: number | null;
}

export function promoteCandidate(
  candidateId: string,
  options: PromoteCandidateOptions,
): { item: KnowledgeItem; version: KnowledgeVersion } {
  const candidate = getCandidate(candidateId);
  if (!candidate) throw new Error('Learning candidate not found.');
  if (candidate.status !== 'approved') {
    const automatic = options.allowAutomatic === true && candidate.status === 'pending'
      && automationDecision(candidate).decision === 'auto-apply';
    if (!automatic) throw new Error('Candidate must be approved before it can become canonical knowledge.');
  }
  if (candidate.conflicts.length) throw new Error('Resolve candidate conflicts before promotion.');

  const createdBy = nonEmpty(options.createdBy, 'Created by', 200);
  const metadataJson = stableJson(options.metadata ?? {});
  if (Buffer.byteLength(metadataJson, 'utf8') > 64 * 1024) throw new Error('Knowledge metadata is too large.');
  const now = Date.now();
  const result = db().transaction(() => {
    let item = candidate.itemId ? getKnowledgeItem(candidate.itemId) : null;
    if (candidate.itemId && !item) throw new Error('The candidate target no longer exists.');
    if (item && (item.kind !== candidate.targetKind || item.scope !== candidate.scope)) {
      throw new Error('A candidate cannot change an artifact kind or scope in place. Create a replacement instead.');
    }

    const contentHash = sha256(candidate.proposedText.trim());
    const itemId = item?.id ?? learningId('know');
    const previous = item ? currentKnowledgeVersion(item.id) : null;
    const versionNumber = (item?.currentVersion ?? 0) + 1;
    const versionId = learningId('kv');

    if (!item) {
      db().prepare(`
        INSERT INTO knowledge_items
          (id,kind,scope,project_id,path_scope,title,canonical_text,status,confidence,source_count,
           current_version,content_hash,created_at,updated_at,last_validated_at,expires_at,superseded_by)
        VALUES (?,?,?,?,?,?,?,'active',?,0,?,?,?, ?,NULL,?,NULL)
      `).run(
        itemId, candidate.targetKind, candidate.scope, candidate.projectId, candidate.pathScope,
        candidate.title, candidate.proposedText, candidate.confidence, versionNumber, contentHash,
        now, now, options.expiresAt ?? null,
      );
    } else {
      db().prepare(`
        UPDATE knowledge_items SET title=?,canonical_text=?,confidence=?,current_version=?,content_hash=?,
          status='active',updated_at=?,expires_at=?,superseded_by=NULL WHERE id=?
      `).run(candidate.title, candidate.proposedText, candidate.confidence, versionNumber,
        contentHash, now, options.expiresAt ?? item.expiresAt, item.id);
    }

    db().prepare(`
      INSERT INTO knowledge_versions
        (id,item_id,version,canonical_text,metadata_json,content_hash,created_by,previous_version_id,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(versionId, itemId, versionNumber, candidate.proposedText, metadataJson, contentHash,
      createdBy, previous?.id ?? null, now);

    const signalRows = candidate.signalIds.length
      ? db().prepare(`SELECT id,session_id,task_hash,summary,content_hash,created_at FROM learning_signals WHERE id IN (${candidate.signalIds.map(() => '?').join(',')})`)
        .all(...candidate.signalIds) as { id: string; session_id: string | null; task_hash: string | null; summary: string; content_hash: string; created_at: number }[]
      : [];
    const evidenceInsert = db().prepare(`
      INSERT INTO knowledge_evidence
        (id,item_id,version_id,candidate_id,signal_id,source_type,source_id,citation,content_hash,weight,observed_at)
      VALUES (?,?,?,?,?,'learning-signal',?,?,?,?,?)
    `);
    for (const signal of signalRows) {
      const sourceId = signal.task_hash ?? signal.session_id ?? signal.id;
      evidenceInsert.run(
        learningId('ev'), itemId, versionId, candidate.id, signal.id, sourceId,
        signal.session_id ? `Session ${signal.session_id}: ${signal.summary}` : signal.summary,
        signal.content_hash, 1, signal.created_at,
      );
    }
    const sourceCount = (db().prepare('SELECT COUNT(DISTINCT source_id) AS n FROM knowledge_evidence WHERE item_id=?')
      .get(itemId) as { n: number }).n;
    db().prepare('UPDATE knowledge_items SET source_count=? WHERE id=?').run(sourceCount, itemId);
    db().prepare("UPDATE knowledge_candidates SET status='promoted',item_id=?,updated_at=? WHERE id=?")
      .run(itemId, now, candidate.id);
    db().prepare('UPDATE knowledge_projections SET item_id=?,version_id=? WHERE candidate_id=? AND status=\'preview\'')
      .run(itemId, versionId, candidate.id);
    if (candidate.signalIds.length) {
      const mark = db().prepare('UPDATE learning_signals SET processed_at=COALESCE(processed_at,?) WHERE id=?');
      for (const id of candidate.signalIds) mark.run(now, id);
    }

    item = getKnowledgeItem(itemId)!;
    refreshFts(item);
    return { item, version: getKnowledgeVersion(versionId)! };
  })();
  return result;
}

export function setKnowledgeStatus(id: string, status: KnowledgeStatus, supersededBy?: string | null): KnowledgeItem {
  const item = getKnowledgeItem(id);
  if (!item) throw new Error('Knowledge item not found.');
  if (supersededBy && !getKnowledgeItem(supersededBy)) throw new Error('Superseding knowledge item not found.');
  if (supersededBy === id) throw new Error('An item cannot supersede itself.');
  db().prepare('UPDATE knowledge_items SET status=?,superseded_by=?,updated_at=? WHERE id=?')
    .run(status, supersededBy ?? null, Date.now(), id);
  const updated = getKnowledgeItem(id)!;
  refreshFts(updated);
  return updated;
}

export function addEvidence(input: AddEvidenceInput): KnowledgeEvidence {
  if (!input.itemId && !input.candidateId) throw new Error('Evidence must belong to an item or candidate.');
  if (input.itemId && !getKnowledgeItem(input.itemId)) throw new Error('Knowledge item not found.');
  if (input.candidateId && !getCandidate(input.candidateId)) throw new Error('Knowledge candidate not found.');
  if (input.versionId && !getKnowledgeVersion(input.versionId)) throw new Error('Knowledge version not found.');
  const id = learningId('ev');
  db().prepare(`
    INSERT INTO knowledge_evidence
      (id,item_id,version_id,candidate_id,signal_id,source_type,source_id,citation,content_hash,weight,observed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    id, input.itemId ?? null, input.versionId ?? null, input.candidateId ?? null, input.signalId ?? null,
    nonEmpty(input.sourceType, 'Evidence source type', 100), nonEmpty(input.sourceId, 'Evidence source', 4 * 1024),
    optionalText(input.citation, 8 * 1024) ?? '', input.contentHash ?? null,
    clamp(input.weight ?? 1), input.observedAt ?? Date.now(),
  );
  const row = db().prepare('SELECT * FROM knowledge_evidence WHERE id=?').get(id) as EvidenceRow;
  if (input.itemId) {
    const n = (db().prepare('SELECT COUNT(DISTINCT source_id) AS n FROM knowledge_evidence WHERE item_id=?')
      .get(input.itemId) as { n: number }).n;
    db().prepare('UPDATE knowledge_items SET source_count=?,updated_at=? WHERE id=?').run(n, Date.now(), input.itemId);
  }
  return evidenceFromRow(row);
}

export function listEvidence(filter: { itemId?: string; candidateId?: string; signalId?: string } = {}): KnowledgeEvidence[] {
  const where: string[] = [];
  const args: string[] = [];
  if (filter.itemId) { where.push('item_id=?'); args.push(filter.itemId); }
  if (filter.candidateId) { where.push('candidate_id=?'); args.push(filter.candidateId); }
  if (filter.signalId) { where.push('signal_id=?'); args.push(filter.signalId); }
  return (db().prepare(`SELECT * FROM knowledge_evidence ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY observed_at DESC LIMIT 1000`)
    .all(...args) as EvidenceRow[]).map(evidenceFromRow);
}

export function linkRelation(
  fromItemId: string,
  toItemId: string,
  relation: RelationKind,
  confidence: number,
  evidence: JsonObject = {},
): KnowledgeRelation {
  if (fromItemId === toItemId) throw new Error('A knowledge relation needs two different items.');
  if (!getKnowledgeItem(fromItemId) || !getKnowledgeItem(toItemId)) throw new Error('Knowledge relation target not found.');
  const evidenceJson = stableJson(evidence);
  if (Buffer.byteLength(evidenceJson, 'utf8') > 32 * 1024) throw new Error('Relation evidence is too large.');
  const now = Date.now();
  db().prepare(`
    INSERT INTO knowledge_relations
      (from_item_id,to_item_id,relation,confidence,evidence_json,created_at,resolved_at)
    VALUES (?,?,?,?,?,?,NULL)
    ON CONFLICT(from_item_id,to_item_id,relation) DO UPDATE SET
      confidence=excluded.confidence,evidence_json=excluded.evidence_json,created_at=excluded.created_at,resolved_at=NULL
  `).run(fromItemId, toItemId, relation, clamp(confidence), evidenceJson, now);
  return getRelation(fromItemId, toItemId, relation)!;
}

export function getRelation(fromItemId: string, toItemId: string, relation: RelationKind): KnowledgeRelation | null {
  const row = db().prepare('SELECT * FROM knowledge_relations WHERE from_item_id=? AND to_item_id=? AND relation=?')
    .get(fromItemId, toItemId, relation) as RelationRow | undefined;
  return row ? {
    fromItemId: row.from_item_id, toItemId: row.to_item_id, relation: row.relation as RelationKind,
    confidence: row.confidence, evidence: parseObject(row.evidence_json), createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  } : null;
}

export function listRelations(itemId?: string, unresolvedOnly = false): KnowledgeRelation[] {
  const where: string[] = [];
  const args: string[] = [];
  if (itemId) { where.push('(from_item_id=? OR to_item_id=?)'); args.push(itemId, itemId); }
  if (unresolvedOnly) where.push('resolved_at IS NULL');
  return (db().prepare(`SELECT * FROM knowledge_relations ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC`)
    .all(...args) as RelationRow[]).map((row) => ({
      fromItemId: row.from_item_id, toItemId: row.to_item_id, relation: row.relation as RelationKind,
      confidence: row.confidence, evidence: parseObject(row.evidence_json), createdAt: row.created_at,
      resolvedAt: row.resolved_at,
    }));
}

export function resolveRelation(fromItemId: string, toItemId: string, relation: RelationKind): boolean {
  return db().prepare('UPDATE knowledge_relations SET resolved_at=? WHERE from_item_id=? AND to_item_id=? AND relation=? AND resolved_at IS NULL')
    .run(Date.now(), fromItemId, toItemId, relation).changes > 0;
}

export function searchKnowledge(input: KnowledgeSearchInput): KnowledgeSearchResult[] {
  const limit = Math.max(1, Math.min(100, input.limit ?? 20));
  const expression = ftsExpression(input.query, input.match ?? 'all');
  const args: unknown[] = [];
  const where: string[] = [];
  if (input.projectId !== undefined) {
    where.push('(i.scope=\'personal\' OR i.project_id IS ?)'); args.push(input.projectId);
  }
  const kinds = input.kinds ? uniqueStrings(input.kinds, 20) : [];
  const statuses = uniqueStrings(input.statuses ?? ['active'], 10);
  if (kinds.length) { where.push(`i.kind IN (${kinds.map(() => '?').join(',')})`); args.push(...kinds); }
  if (statuses.length) { where.push(`i.status IN (${statuses.map(() => '?').join(',')})`); args.push(...statuses); }

  let rows: (ItemRow & { rank: number })[];
  if (expression) {
    rows = db().prepare(`
      SELECT i.*,bm25(knowledge_fts) AS rank
      FROM knowledge_fts JOIN knowledge_items i ON i.id=knowledge_fts.item_id
      WHERE knowledge_fts MATCH ? ${where.length ? `AND ${where.join(' AND ')}` : ''}
      ORDER BY rank,i.confidence DESC,i.updated_at DESC LIMIT ?
    `).all(expression, ...args, Math.min(500, limit * 5)) as (ItemRow & { rank: number })[];
  } else {
    rows = db().prepare(`
      SELECT i.*,0 AS rank FROM knowledge_items i
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY i.confidence DESC,i.updated_at DESC LIMIT ?
    `).all(...args, Math.min(500, limit * 5)) as (ItemRow & { rank: number })[];
  }
  let scopedPath = input.path;
  if (scopedPath && pathIsAbsolute(scopedPath) && input.projectId) {
    const project = db().prepare('SELECT path FROM projects WHERE id=?').get(input.projectId) as { path: string } | undefined;
    if (project) {
      const relative = relativeProjectPath(project.path, scopedPath);
      scopedPath = relative ?? scopedPath;
    }
  }
  return rows
    .filter((row) => scopeMatches(row.path_scope, scopedPath))
    .slice(0, limit)
    .map((row) => {
      const item = itemFromRow(row);
      return { item, rank: row.rank, version: currentKnowledgeVersion(item.id) };
    });
}

function pathIsAbsolute(value: string): boolean {
  return /^(?:\/|[A-Za-z]:[\\/])/.test(value);
}

function relativeProjectPath(root: string, candidate: string): string | null {
  const normalizedRoot = root.replaceAll('\\', '/').replace(/\/$/, '');
  const normalizedCandidate = candidate.replaceAll('\\', '/');
  if (normalizedCandidate === normalizedRoot) return '';
  return normalizedCandidate.startsWith(`${normalizedRoot}/`)
    ? normalizedCandidate.slice(normalizedRoot.length + 1)
    : null;
}

/** Repairs FTS after an import or migration without changing canonical rows. */
export function rebuildKnowledgeFts(): number {
  const items = (db().prepare("SELECT * FROM knowledge_items WHERE status='active' ORDER BY updated_at DESC")
    .all() as ItemRow[]).map(itemFromRow);
  db().transaction(() => {
    db().prepare('DELETE FROM knowledge_fts').run();
    const insert = db().prepare('INSERT INTO knowledge_fts (item_id,title,canonical_text,path_scope) VALUES (?,?,?,?)');
    for (const item of items) insert.run(item.id, item.title, item.canonicalText, item.pathScope ?? '');
  })();
  return items.length;
}
