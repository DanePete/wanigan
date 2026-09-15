import fs from 'node:fs';
import path from 'node:path';
import { db } from './db';
import { runGit, scopeOf } from './git';
import { assistedByTrailers as trailersSwitchedOn } from './settings';
import {
  assistedByTrailers, sameTrailers,
  type AssistedByPreview, type AssistedSessionRow,
} from '../shared/assisted-by';

/**
 * Assisted-by trailers for commits Wanigan itself makes, drawn from the sessions
 * it recorded. Off unless the operator turns it on: a line in a commit message
 * is published history, and which agents helped is theirs to publish.
 *
 * The window is "since the commit this one will follow" — HEAD, or HEAD's parent
 * for an amend — because a session that ended before that commit had its work
 * committed already, and one still running when this commit is made may have
 * written what it records. It is stated beside the trailers, with the date, so
 * nobody has to guess what "recent" meant.
 *
 * The commit handler recomputes the trailers and refuses when they differ from
 * the list the renderer shows. The preview is not advice: what the commit box
 * displayed is exactly what the commit carries, or nothing is committed.
 */

/** Rows read for one preview. More sessions than this since one commit is not a review anyone did. */
const MAX_ROWS = 2_000;

function real(p: string): string {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

/**
 * Whether `dir` belongs to the checkout rooted at `root`: at it, or below it
 * with no other checkout in between. A linked worktree or a submodule nested
 * under the root has its own `.git`, and work done there is not in this index.
 */
export function inCheckout(root: string, dir: string): boolean {
  const top = real(root);
  let cur = real(dir);
  if (cur !== top && !cur.startsWith(top + path.sep)) return false;
  while (cur !== top) {
    if (fs.existsSync(path.join(cur, '.git'))) return false;
    const parent = path.dirname(cur);
    if (parent === cur) return false;
    cur = parent;
  }
  return true;
}

/**
 * When the commit being made follows, in ms, or null when there is nothing to
 * follow. "No such commit" and "git did not answer" are different facts: the
 * first widens the window to every session, and the second must never be read
 * as the first.
 */
async function followsAt(repoRoot: string, amend: boolean): Promise<number | null> {
  const rev = amend ? 'HEAD^' : 'HEAD';
  const exists = await runGit(repoRoot, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], { timeout: 8_000 });
  if (!exists.ok) {
    if (exists.code === 1 && !exists.out.trim()) return null;
    throw new Error(`git could not say when the previous commit was made, so the Assisted-by window is unknown: ${exists.err || 'no answer'}`);
  }
  const shown = await runGit(repoRoot, ['show', '-s', '--format=%ct', exists.out.trim()], { timeout: 8_000 });
  const seconds = Number(shown.out.trim());
  if (!shown.ok || !Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`git could not say when the previous commit was made, so the Assisted-by window is unknown: ${shown.err || 'no answer'}`);
  }
  return seconds * 1000;
}

type LogRow = {
  harness_id: string | null; provider_id: string; model: string | null;
  started_at: number; ended_at: number | null; origin: string;
  project_path: string; worktree: string | null;
};

export async function assistedByPreview(dir: string, opts: { amend?: boolean } = {}): Promise<AssistedByPreview> {
  const until = Date.now();
  if (!trailersSwitchedOn()) return { enabled: false, trailers: [], sessions: 0, since: null, until };
  const scope = await scopeOf(dir);
  if (!scope) throw new Error('This folder is not a git repository, so there is no commit to attribute.');
  const since = await followsAt(scope.repoRoot, opts.amend === true);
  const rows = db().prepare(`
    SELECT harness_id, provider_id, model, started_at, ended_at, origin, project_path, worktree
      FROM session_log
     WHERE origin = 'wanigan' AND started_at <= ? AND (ended_at IS NULL OR ended_at >= ?)
     ORDER BY started_at DESC
     LIMIT ?
  `).all(until, since ?? 0, MAX_ROWS) as LogRow[];
  const sessions: AssistedSessionRow[] = rows.map((r) => ({
    harnessId: r.harness_id, providerId: r.provider_id, model: r.model,
    startedAt: r.started_at, endedAt: r.ended_at, origin: r.origin,
    // Where the session worked: its own worktree when it had one. A session
    // whose project is this repository but which ran in a worktree wrote to a
    // different checkout.
    inRepository: inCheckout(scope.repoRoot, r.worktree ?? r.project_path),
  }));
  const derived = assistedByTrailers(sessions, { since, until });
  return { enabled: true, trailers: derived.trailers, sessions: derived.sessions, since, until };
}

/**
 * The trailers a commit carries, or a refusal. `shown` is the list the commit
 * box displayed; it must equal what main derives now.
 */
export async function trailersForCommit(dir: string, opts: { amend: boolean }, shown: unknown): Promise<string[]> {
  const given = shown === undefined || shown === null ? [] : shown;
  if (!Array.isArray(given) || !given.every((line) => typeof line === 'string')) {
    throw new Error('Assisted-by trailers arrive as a list of lines.');
  }
  const preview = await assistedByPreview(dir, opts);
  if (sameTrailers(preview.trailers, given)) return preview.trailers;
  if (!preview.enabled) {
    throw new Error('Assisted-by trailers are switched off, so the lines this commit asked for were not added and nothing was committed. Commit again.');
  }
  const now = preview.trailers.length ? preview.trailers.join('; ') : 'none';
  throw new Error(`The Assisted-by trailers changed after they were shown — they would now be: ${now} — so nothing was committed. Check them in the commit box and commit again.`);
}
