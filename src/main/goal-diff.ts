import fs from 'node:fs';
import path from 'node:path';
import { runGit } from './git';
import { numstatTotals } from '../shared/goal-budgets';

/**
 * Changed lines in a goal's implementation worktree, for the diff-size budget.
 *
 * Tracked changes come from `git diff --numstat` against the commit the goal
 * was created on, which covers committed and uncommitted work alike. Untracked
 * files are counted by their line count, because an agent's new file is as much
 * a change as an edited one and `git diff` does not see it. Ignored files are
 * not counted: `--exclude-standard` leaves out what the repository ignores.
 *
 * Null means "not measured" — no base commit recorded, no worktree, or git
 * could not answer — and a budget never holds on a number nobody measured.
 */

const MAX_UNTRACKED_FILES = 2_000;
const MAX_UNTRACKED_BYTES = 2 * 1024 * 1024;

export async function implementationChangedLines(worktree: string | null, base: string | null): Promise<{ lines: number; binary: number } | null> {
  if (!worktree || !base || !/^[0-9a-f]{7,64}$/i.test(base)) return null;
  try { if (!fs.statSync(worktree).isDirectory()) return null; } catch { return null; }
  const diff = await runGit(worktree, ['-c', 'core.fsmonitor=false', 'diff', '--numstat', '-z', '--no-renames', '--no-ext-diff', base, '--'], { timeout: 20_000 });
  if (!diff.ok) return null;
  const totals = numstatTotals(diff.out);
  let lines = totals.lines;
  let binary = totals.binary;
  const untracked = await runGit(worktree, ['-c', 'core.fsmonitor=false', 'ls-files', '--others', '--exclude-standard', '-z'], { timeout: 20_000 });
  if (untracked.ok) {
    for (const rel of untracked.out.split('\0').filter(Boolean).slice(0, MAX_UNTRACKED_FILES)) {
      try {
        const file = path.join(worktree, rel);
        const stat = fs.statSync(file);
        if (!stat.isFile() || stat.size > MAX_UNTRACKED_BYTES) continue;
        const buf = fs.readFileSync(file);
        if (buf.includes(0)) { binary++; continue; }
        const text = buf.toString('utf8');
        lines += text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0;
      } catch { /* a file gone mid-read is not a change to count */ }
    }
  }
  return { lines, binary };
}
