import { db } from './db';
import { runGit } from './git';
import { classifyScratch } from '../shared/scratch-files';
import type { ReviewFile } from '../shared/review-marks';

/**
 * The process half of scratch files: git's answer on which paths the
 * repository ignores, and the operator's "Count this file" choices. The rules
 * themselves are shared/scratch-files.ts.
 *
 * `git check-ignore --no-index` is asked rather than trusting the untracked
 * listing, because the review diff lists untracked files with the standard
 * excludes already applied and never shows an ignored untracked file — while a
 * tracked file under an ignored pattern still appears, and is exactly the
 * build output or dump this exists to set aside.
 */

const MAX_CHECK = 5_000;
const BATCH = 200;

export async function ignoredPaths(root: string, paths: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>();
  const list = paths.slice(0, MAX_CHECK);
  for (let i = 0; i < list.length; i += BATCH) {
    // `-z` is accepted only with --stdin, and git.ts's runner has no stdin; with
    // quotePath off the names come back one per line as given. Exit 1 means
    // "none of these are ignored", which is an answer, not a failure.
    const r = await runGit(root, ['-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false', 'check-ignore', '--no-index', '--', ...list.slice(i, i + BATCH).filter((p) => !p.includes('\n'))], { timeout: 15_000 });
    for (const p of r.out.split('\n')) if (p) out.add(p);
  }
  return out;
}

export function promotedPaths(projectId: string | null): Set<string> {
  if (!projectId) return new Set();
  const rows = db().prepare('SELECT path FROM scratch_promotions WHERE project_id = ?').all(projectId) as { path: string }[];
  return new Set(rows.map((r) => r.path));
}

/** Set each file's `scratch` reason in place, so every count that reads `reviewableFiles` leaves scratch out. */
export async function markScratch(root: string, projectId: string | null, files: ReviewFile[]): Promise<void> {
  if (!files.length) return;
  let ignored = new Set<string>();
  try { ignored = await ignoredPaths(root, files.map((f) => f.path)); } catch { ignored = new Set(); }
  const classified = classifyScratch(files, ignored, promotedPaths(projectId));
  files.forEach((f, i) => { f.scratch = classified[i].scratch; });
}

/** "Count this file": kept per project and repository-relative path until taken back. */
export function setScratchPromotion(projectId: string | null, rel: unknown, on: unknown): boolean {
  if (!projectId) throw new Error('This session has no project, so a promotion has nowhere to be kept.');
  if (typeof rel !== 'string' || !rel || rel.length > 4_096 || rel.startsWith('/') || rel.split('/').includes('..')) throw new Error('Choose a changed file in this repository.');
  if (on === true) db().prepare('INSERT OR REPLACE INTO scratch_promotions (project_id, path, promoted_at) VALUES (?,?,?)').run(projectId, rel, Date.now());
  else db().prepare('DELETE FROM scratch_promotions WHERE project_id = ? AND path = ?').run(projectId, rel);
  return on === true;
}
