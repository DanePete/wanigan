import fs from 'node:fs';
import path from 'node:path';
import { db } from '../db';
import { automationDecision } from './classifier';
import { getCandidate, getKnowledgeItem, getKnowledgeVersion } from './repository';
import type {
  ArtifactScope, KnowledgeProjection, ProjectionPreviewInput, ProjectionSafety,
  ProjectionStatus, ProjectionValidation,
} from './types';
import { learningId, nonEmpty, sha256 } from './util';

export const MISSING_FILE_HASH = 'missing';
const DEFAULT_MAX_BYTES = 512 * 1024;

type ProjectionRow = {
  id: string; candidate_id: string; item_id: string | null; version_id: string | null;
  provider_id: string; adapter_id: string; scope: string; project_id: string | null;
  target_path: string; target_format: string; proposed_content: string; base_hash: string;
  applied_hash: string | null; previous_content: string | null; status: string; error: string | null;
  created_at: number; applied_at: number | null; undone_at: number | null;
  allowed_roots_json: string | null;
};

function parseAllowedRoots(json: string | null): string[] {
  if (!json) return [];
  try {
    const value = JSON.parse(json);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  } catch { return []; }
}

const fromRow = (row: ProjectionRow): KnowledgeProjection => ({
  id: row.id,
  candidateId: row.candidate_id,
  itemId: row.item_id,
  versionId: row.version_id,
  providerId: row.provider_id,
  adapterId: row.adapter_id,
  scope: row.scope as ArtifactScope,
  projectId: row.project_id,
  targetPath: row.target_path,
  targetFormat: row.target_format,
  proposedContent: row.proposed_content,
  baseHash: row.base_hash,
  appliedHash: row.applied_hash,
  previousContent: row.previous_content,
  status: row.status as ProjectionStatus,
  error: row.error,
  createdAt: row.created_at,
  appliedAt: row.applied_at,
  undoneAt: row.undone_at,
  allowedRoots: parseAllowedRoots(row.allowed_roots_json),
});

function readTarget(file: string, maxBytes: number): { hash: string; content: string | null; mode: number | null } {
  let st: fs.Stats;
  try { st = fs.lstatSync(file); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { hash: MISSING_FILE_HASH, content: null, mode: null };
    throw error;
  }
  if (st.isSymbolicLink()) throw new Error('Wanigan will not replace a symlink projection target.');
  if (!st.isFile()) throw new Error('Projection target is not a regular file.');
  if (st.size > maxBytes) throw new Error(`Projection target is over the ${Math.ceil(maxBytes / 1024)} KB safety limit.`);
  const bytes = fs.readFileSync(file);
  if (bytes.includes(0)) throw new Error('Projection target appears to be binary.');
  return { hash: sha256(bytes), content: bytes.toString('utf8'), mode: st.mode & 0o777 };
}

/** Resolve through the nearest existing ancestor, including intermediate symlinks. */
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

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function assertAllowed(targetPath: string, safety: ProjectionSafety): string {
  if (!path.isAbsolute(targetPath)) throw new Error('Projection target must be an absolute path.');
  if (!safety.allowedRoots.length) throw new Error('No projection write root was granted.');
  const target = canonicalMissingAware(targetPath);
  const allowed = safety.allowedRoots.some((root) => {
    if (!path.isAbsolute(root)) return false;
    return isInside(canonicalMissingAware(root), target);
  });
  if (!allowed) throw new Error('Projection target resolves outside its explicitly allowed roots.');
  return target;
}

/** Best-effort cleanup of directories a created-file projection introduced. */
function removeEmptyParents(target: string, safety: ProjectionSafety): void {
  try {
    const roots = safety.allowedRoots.filter((root) => path.isAbsolute(root)).map(canonicalMissingAware);
    let dir = path.dirname(target);
    // Stop at the first non-empty directory or the granted-root boundary; the
    // root itself is never removed. Cleanup must never fail the undo.
    while (roots.some((root) => dir !== root && isInside(root, dir))) {
      if (fs.readdirSync(dir).length) return;
      fs.rmdirSync(dir);
      dir = path.dirname(dir);
    }
  } catch { /* a leftover empty directory is cosmetic */ }
}

function atomicWrite(file: string, content: string, mode: number | null): void {
  const parent = path.dirname(file);
  fs.mkdirSync(parent, { recursive: true });
  const temp = path.join(parent, `.${path.basename(file)}.wanigan-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(temp, content, { encoding: 'utf8', flag: 'wx', mode: mode ?? 0o644 });
    fs.renameSync(temp, file);
  } finally {
    try { fs.rmSync(temp, { force: true }); } catch { /* rename already removed it */ }
  }
}

export function getProjection(id: string): KnowledgeProjection | null {
  const row = db().prepare('SELECT * FROM knowledge_projections WHERE id=?').get(id) as ProjectionRow | undefined;
  return row ? fromRow(row) : null;
}

export function listProjections(filter: {
  candidateId?: string; itemId?: string; status?: ProjectionStatus; limit?: number;
} = {}): KnowledgeProjection[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.candidateId) { where.push('candidate_id=?'); args.push(filter.candidateId); }
  if (filter.itemId) { where.push('item_id=?'); args.push(filter.itemId); }
  if (filter.status) { where.push('status=?'); args.push(filter.status); }
  args.push(Math.max(1, Math.min(500, filter.limit ?? 100)));
  return (db().prepare(`SELECT * FROM knowledge_projections ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`)
    .all(...args) as ProjectionRow[]).map(fromRow);
}

/**
 * Creates a read-only preview. Passing safety is recommended and mandatory at
 * apply time; adapters may preview before the operator selects a write root.
 */
export function createProjectionPreview(
  input: ProjectionPreviewInput,
  safety?: Omit<ProjectionSafety, 'actor'>,
): KnowledgeProjection {
  const candidate = getCandidate(input.candidateId);
  if (!candidate) throw new Error('Learning candidate not found.');
  if (candidate.status === 'rejected' || candidate.status === 'superseded') {
    throw new Error(`A ${candidate.status} candidate cannot produce a projection.`);
  }
  if (input.itemId && !getKnowledgeItem(input.itemId)) throw new Error('Knowledge item not found.');
  if (input.versionId && !getKnowledgeVersion(input.versionId)) throw new Error('Knowledge version not found.');
  const rawTargetPath = nonEmpty(input.targetPath, 'Projection target', 8 * 1024);
  if (!path.isAbsolute(rawTargetPath)) throw new Error('Projection target must be an absolute path.');
  const targetPath = path.resolve(rawTargetPath);
  if (safety) assertAllowed(targetPath, { ...safety, actor: 'user' });
  const maxBytes = safety?.maxBytes ?? DEFAULT_MAX_BYTES;
  if (Buffer.byteLength(input.proposedContent, 'utf8') > maxBytes) {
    throw new Error(`Proposed projection is over the ${Math.ceil(maxBytes / 1024)} KB safety limit.`);
  }
  const current = readTarget(targetPath, maxBytes);
  const id = learningId('proj');
  db().prepare(`
    INSERT INTO knowledge_projections
      (id,candidate_id,item_id,version_id,provider_id,adapter_id,scope,project_id,target_path,
       target_format,proposed_content,base_hash,applied_hash,previous_content,status,error,
       created_at,applied_at,undone_at,allowed_roots_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,'preview',NULL,?,NULL,NULL,?)
  `).run(
    id, input.candidateId, input.itemId ?? candidate.itemId, input.versionId ?? null,
    nonEmpty(input.providerId, 'Projection provider', 200), nonEmpty(input.adapterId, 'Projection adapter', 200),
    input.scope, input.projectId ?? candidate.projectId, targetPath,
    nonEmpty(input.targetFormat, 'Projection format', 100), input.proposedContent, current.hash, Date.now(),
    safety ? JSON.stringify(safety.allowedRoots) : null,
  );
  return getProjection(id)!;
}

export function validateProjection(id: string, safety: ProjectionSafety): ProjectionValidation {
  const projection = getProjection(id);
  if (!projection) throw new Error('Knowledge projection not found.');
  try {
    assertAllowed(projection.targetPath, safety);
    const current = readTarget(projection.targetPath, safety.maxBytes ?? DEFAULT_MAX_BYTES);
    const expected = projection.status === 'applied' ? projection.appliedHash : projection.baseHash;
    const stale = !expected || current.hash !== expected;
    return {
      safe: true,
      currentHash: current.hash,
      stale,
      reason: stale ? 'The target changed after this projection snapshot.' : null,
    };
  } catch (error) {
    return {
      safe: false,
      currentHash: '',
      stale: true,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export function applyProjection(id: string, safety: ProjectionSafety): KnowledgeProjection {
  const projection = getProjection(id);
  if (!projection) throw new Error('Knowledge projection not found.');
  if (projection.status !== 'preview' && projection.status !== 'stale' && projection.status !== 'failed') {
    throw new Error(`A ${projection.status} projection cannot be applied.`);
  }
  const candidate = getCandidate(projection.candidateId);
  if (!candidate) throw new Error('The projection candidate no longer exists.');
  if (safety.actor === 'automation') {
    const decision = automationDecision(candidate);
    if (decision.decision !== 'auto-apply') throw new Error(`Automatic apply refused: ${decision.reason}`);
  } else if (candidate.status !== 'approved' && candidate.status !== 'promoted' && candidate.status !== 'applied') {
    throw new Error('The candidate must be approved and promoted before its file projection is applied.');
  }

  const target = assertAllowed(projection.targetPath, safety);
  const maxBytes = safety.maxBytes ?? DEFAULT_MAX_BYTES;
  if (Buffer.byteLength(projection.proposedContent, 'utf8') > maxBytes) throw new Error('Projection exceeds its write safety limit.');
  const current = readTarget(target, maxBytes);
  if (current.hash !== projection.baseHash) {
    const error = 'Target changed after preview. Recompile against the current file before applying.';
    db().prepare("UPDATE knowledge_projections SET status='stale',error=? WHERE id=?").run(error, id);
    throw new Error(error);
  }

  // Persist the pre-image and the granted roots before the destructive write:
  // a failure after atomicWrite must leave the replaced bytes recoverable from
  // the row ('failed' rows keep previous_content for manual recovery).
  db().prepare('UPDATE knowledge_projections SET previous_content=?,allowed_roots_json=? WHERE id=?')
    .run(current.content, JSON.stringify(safety.allowedRoots), id);
  try {
    atomicWrite(target, projection.proposedContent, current.mode);
    // Re-resolve after mkdir/write: an ancestor cannot silently move us out of
    // the granted root between preview and commit.
    assertAllowed(target, safety);
    const applied = readTarget(target, maxBytes);
    const now = Date.now();
    db().transaction(() => {
      db().prepare(`
        UPDATE knowledge_projections SET status='applied',applied_hash=?,previous_content=?,
          error=NULL,applied_at=?,undone_at=NULL WHERE id=?
      `).run(applied.hash, current.content, now, id);
      db().prepare("UPDATE knowledge_candidates SET status='applied',updated_at=? WHERE id=?")
        .run(now, candidate.id);
    })();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    db().prepare("UPDATE knowledge_projections SET status='failed',error=? WHERE id=?").run(message, id);
    throw error;
  }
  return getProjection(id)!;
}

/** Undo only if the file is still byte-for-byte what Wanigan applied. */
export function undoProjection(id: string, safety: ProjectionSafety): KnowledgeProjection {
  const projection = getProjection(id);
  if (!projection) throw new Error('Knowledge projection not found.');
  if (projection.status !== 'applied' || !projection.appliedHash) throw new Error('Only an applied projection can be undone.');
  const target = assertAllowed(projection.targetPath, safety);
  const maxBytes = safety.maxBytes ?? DEFAULT_MAX_BYTES;
  const current = readTarget(target, maxBytes);
  if (current.hash !== projection.appliedHash) {
    const error = 'Wanigan will not undo because the projected file changed after apply.';
    db().prepare("UPDATE knowledge_projections SET status='stale',error=? WHERE id=?").run(error, id);
    throw new Error(error);
  }

  if (projection.baseHash === MISSING_FILE_HASH) {
    fs.unlinkSync(target);
    removeEmptyParents(target, safety);
  } else {
    if (projection.previousContent == null) throw new Error('The prior file snapshot is unavailable; undo was refused.');
    atomicWrite(target, projection.previousContent, current.mode);
  }
  const now = Date.now();
  db().transaction(() => {
    db().prepare("UPDATE knowledge_projections SET status='undone',error=NULL,undone_at=? WHERE id=?")
      .run(now, id);
    const stillApplied = (db().prepare("SELECT COUNT(*) AS n FROM knowledge_projections WHERE candidate_id=? AND status='applied'")
      .get(projection.candidateId) as { n: number }).n > 0;
    db().prepare('UPDATE knowledge_candidates SET status=?,updated_at=? WHERE id=? AND status=\'applied\'')
      .run(stillApplied ? 'applied' : 'promoted', now, projection.candidateId);
  })();
  return getProjection(id)!;
}
