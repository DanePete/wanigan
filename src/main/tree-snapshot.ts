import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { runGit } from './git';
import { assertManagedRoot } from './roots';
import { changedFilesFromDiff, readOracles } from '../shared/test-oracles';
import type { OracleReading } from '../shared/types';

/**
 * What a review gate is about to run against: a content hash of the working
 * copy, and a heuristic reading of how the tests in it changed.
 *
 * The hash is `git write-tree` over a scratch index that `git add -A .` has
 * filled from the directory, the same technique per-turn checkpoints use. It
 * covers untracked files and skips ignored ones, and it never touches the
 * user's index, HEAD or branches. The blobs it writes land in the repository's
 * object store with nothing referencing them, which git's own garbage
 * collection removes. The scratch index is kept per task so the next snapshot
 * reuses git's stat cache instead of hashing every file again.
 *
 * Two uses. A gate triggered by an agent stopping is skipped when the tree is
 * the one the last gate for that task already ran against, so an agent that
 * stops to ask a question does not rerun a ten-minute suite. And every gate
 * proof records the tree, so "passed" names what it passed on. An attempt set
 * records the same two facts for each attempt's worktree, against the set's
 * pinned commit, which is why the notes below name no goal.
 */

const TIMEOUT_MS = 30_000;
const DIFF_MAX_BYTES = 8 * 1024 * 1024;

export type TreeSnapshot = {
  tree: string | null;
  oracle: OracleReading | null;
  /** Why the tree or the reading is missing, in words a proof can carry. */
  note: string | null;
};

function indexFileFor(key: string): string {
  const dir = path.join(app.getPath('userData'), 'gate-index');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${key.replace(/[^A-Za-z0-9_.-]/g, '_')}.index`);
}

function clip(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export async function snapshotTree(cwd: string, base: string | null, key: string): Promise<TreeSnapshot> {
  try { assertManagedRoot(cwd, 'This working copy'); } catch (error) {
    return { tree: null, oracle: null, note: error instanceof Error ? error.message : String(error) };
  }
  const inside = await runGit(cwd, ['rev-parse', '--is-inside-work-tree'], { timeout: 8_000, maxBuffer: 1024 * 1024 });
  if (!inside.ok || inside.out.trim() !== 'true') {
    return { tree: null, oracle: null, note: 'This working copy is not a git work tree, so the gate could not record which tree it ran on.' };
  }
  const index = indexFileFor(key);
  const opts = { timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, env: { GIT_INDEX_FILE: index } };
  let add = await runGit(cwd, ['add', '-A', '.'], opts);
  if (!add.ok) {
    // A lock or a corrupt scratch index left by a crash is Wanigan's own file,
    // so it is thrown away and built once more before this gives up.
    for (const file of [index, `${index}.lock`]) { try { fs.rmSync(file, { force: true }); } catch { /* scratch file */ } }
    add = await runGit(cwd, ['add', '-A', '.'], opts);
  }
  if (!add.ok) return { tree: null, oracle: null, note: `git add could not read the working copy: ${clip(add.err)}` };
  const written = await runGit(cwd, ['write-tree'], opts);
  const tree = written.ok ? written.out.trim() || null : null;
  if (!tree) return { tree: null, oracle: null, note: `git write-tree failed: ${clip(written.err)}` };
  if (!base) return { tree, oracle: null, note: 'No base commit is recorded for this work, so how its tests changed could not be read.' };
  // `-- .` matters: the scratch index holds only this directory, so without the
  // pathspec everything outside it would read as deleted.
  const diff = await runGit(cwd, [
    '-c', 'core.quotePath=false', 'diff', '--cached', '--unified=0', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', base, '--', '.',
  ], { ...opts, maxBuffer: DIFF_MAX_BYTES });
  if (!diff.ok) {
    return {
      tree, oracle: null,
      note: diff.killed || /maxBuffer/i.test(diff.err)
        ? 'The change since the base commit is too large to read, so how its tests changed was not checked.'
        : `The base commit could not be compared here, so how its tests changed was not checked: ${clip(diff.err)}`,
    };
  }
  return { tree, oracle: readOracles(changedFilesFromDiff(diff.out)), note: null };
}

/** The scratch index for a task that no longer needs one. */
export function forgetTreeSnapshot(key: string): void {
  try { fs.rmSync(indexFileFor(key), { force: true }); } catch { /* scratch file */ }
}
