import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { db } from '../db';
import { getKnowledgeItem, linkRelation, listEvidence, setKnowledgeStatus } from './repository';
import type { FreshnessIssue, FreshnessResult, KnowledgeRelation } from './types';

const FILE_EVIDENCE = new Set(['file', 'instruction', 'skill', 'commit-file', 'test-file']);

function canonicalMissingAware(input: string): string {
  let current = path.resolve(input);
  const suffix: string[] = [];
  for (;;) {
    try { return path.join(fs.realpathSync(current), ...suffix.reverse()); }
    catch {
      const parent = path.dirname(current);
      if (parent === current) return path.join(current, ...suffix.reverse());
      suffix.push(path.basename(current));
      current = parent;
    }
  }
}

function inside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`));
}

function evidencePath(sourceId: string, projectRoot: string | null | undefined): string | null {
  if (path.isAbsolute(sourceId)) return path.resolve(sourceId);
  return projectRoot ? path.resolve(projectRoot, sourceId) : null;
}

async function hashFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolve(hash.digest('hex')));
  });
}

export interface FreshnessOptions {
  projectRoot?: string | null;
  allowedRoots?: string[];
  quarantine?: boolean;
}

/**
 * Verify file citations against the current checkout before retrieval.
 *
 * Quarantine fires only on provable staleness — a cited file changed or went
 * missing, or the item expired ('changed'/'missing' issues). 'outside-root'
 * and 'unverifiable' mean the citation cannot be checked from this launch's
 * roots, not that it is wrong: the item is still withheld from the briefing
 * (fresh=false) but stays active.
 */
export async function checkItemFreshness(itemId: string, options: FreshnessOptions = {}): Promise<FreshnessResult> {
  const item = getKnowledgeItem(itemId);
  if (!item) throw new Error('Knowledge item not found.');
  const checkedAt = Date.now();
  const issues: FreshnessIssue[] = [];
  // Only file-backed citations can be re-hashed. The caller must be able to
  // say "N verified, M not checkable" instead of letting a clean pass over
  // zero checkable rows read as "everything was verified".
  let checked = 0;
  let skipped = 0;
  const roots = (options.allowedRoots?.length ? options.allowedRoots : options.projectRoot ? [options.projectRoot] : [])
    .map(canonicalMissingAware);

  if (item.expiresAt != null && item.expiresAt <= checkedAt) {
    issues.push({ evidenceId: '', sourceId: item.id, kind: 'changed', detail: 'The knowledge item has expired.' });
  }

  for (const evidence of listEvidence({ itemId })) {
    if (!FILE_EVIDENCE.has(evidence.sourceType)) { skipped++; continue; }
    checked++;
    const file = evidencePath(evidence.sourceId, options.projectRoot);
    if (!file) {
      issues.push({ evidenceId: evidence.id, sourceId: evidence.sourceId, kind: 'unverifiable', detail: 'Relative evidence has no project root.' });
      continue;
    }
    const canonical = canonicalMissingAware(file);
    if (!roots.length || !roots.some((root) => inside(root, canonical))) {
      issues.push({ evidenceId: evidence.id, sourceId: evidence.sourceId, kind: 'outside-root', detail: 'Evidence resolves outside the allowed project roots.' });
      continue;
    }
    let st: fs.Stats;
    try { st = fs.statSync(canonical); }
    catch {
      issues.push({ evidenceId: evidence.id, sourceId: evidence.sourceId, kind: 'missing', detail: 'Cited file no longer exists.' });
      continue;
    }
    if (!st.isFile() || !evidence.contentHash) {
      issues.push({ evidenceId: evidence.id, sourceId: evidence.sourceId, kind: 'unverifiable', detail: 'Cited evidence is not a hashed regular file.' });
      continue;
    }
    try {
      const current = await hashFile(canonical);
      if (current !== evidence.contentHash) {
        issues.push({ evidenceId: evidence.id, sourceId: evidence.sourceId, kind: 'changed', detail: 'Cited file content changed.' });
      }
    } catch (error) {
      issues.push({
        evidenceId: evidence.id, sourceId: evidence.sourceId, kind: 'unverifiable',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (!issues.length) {
    db().prepare('UPDATE knowledge_items SET last_validated_at=? WHERE id=?').run(checkedAt, itemId);
  } else if (
    options.quarantine === true && item.status === 'active'
    && issues.some((issue) => issue.kind === 'changed' || issue.kind === 'missing')
  ) {
    setKnowledgeStatus(itemId, 'quarantined');
  }
  return { itemId, fresh: issues.length === 0, checkedAt, checked, skipped, issues };
}

/** Contradictions are explicit evidence, never guessed from lexical difference. */
export function recordContradiction(
  firstItemId: string,
  secondItemId: string,
  reason: string,
  confidence = 1,
  quarantine = true,
): KnowledgeRelation {
  const relation = linkRelation(firstItemId, secondItemId, 'contradicts', confidence, { reason });
  if (quarantine) {
    setKnowledgeStatus(firstItemId, 'quarantined');
    setKnowledgeStatus(secondItemId, 'quarantined');
  }
  return relation;
}

/** Records exact duplicates; unlike contradiction detection this is lossless. */
export function indexExactDuplicates(projectId?: string | null): number {
  const rows = db().prepare(`
    SELECT content_hash,GROUP_CONCAT(id) AS ids,COUNT(*) AS n FROM knowledge_items
    WHERE status='active' ${projectId !== undefined ? 'AND project_id IS ?' : ''}
    GROUP BY content_hash HAVING COUNT(*) > 1
  `).all(...(projectId !== undefined ? [projectId] : [])) as { content_hash: string; ids: string; n: number }[];
  let created = 0;
  for (const row of rows) {
    const ids = row.ids.split(',').filter(Boolean);
    for (let i = 1; i < ids.length; i++) {
      linkRelation(ids[0], ids[i], 'duplicates', 1, { contentHash: row.content_hash });
      created++;
    }
  }
  return created;
}
