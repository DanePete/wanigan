import { pruneAsks } from './ask-items';
import { pruneFileRefs } from './session-files';

/**
 * Retention for the review-depth evidence (helper sweep P7), on the same
 * window as the hook events it is read against. Called from the queue's
 * retention pass, which is the only retention timer the app runs.
 */
export function pruneDepthEvidence(olderThanMs: number): number {
  let removed = 0;
  try { removed += pruneAsks(olderThanMs); } catch { /* the next pass retries */ }
  try { removed += pruneFileRefs(olderThanMs); } catch { /* the next pass retries */ }
  return removed;
}
