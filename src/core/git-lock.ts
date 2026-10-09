// A mutation's checks and its git commands are one operation within this core.
// Git locks individual writes, not a read-then-write sequence such as checking
// stash@{0} before dropping it. Worktrees share refs and stashes, so they share
// the queue keyed by the repository's real common git directory. Reads run freely.
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { runGit } from './git.ts';

const tails = new Map<string, Promise<void>>();

export async function withGitMutation<T>(cwd: string, action: () => T | Promise<T>): Promise<T> {
  const common = await runGit(cwd, ['rev-parse', '--git-common-dir']);
  let key = common.ok ? resolve(cwd, common.out.trim()) : resolve(cwd);
  try { key = realpathSync(key); } catch { /* the operation itself explains a missing checkout */ }
  const result = (tails.get(key) ?? Promise.resolve()).then(action);
  const tail = result.then(() => {}, () => {});
  tails.set(key, tail);
  try {
    return await result;
  } finally {
    if (tails.get(key) === tail) tails.delete(key);
  }
}
