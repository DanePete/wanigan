/**
 * Scratch files: what an agent wrote for itself, kept out of what a person
 * reviews.
 *
 * An agent writes probes, dumps and throwaway scripts on its way to a change.
 * Counted as the change, they inflate "12 files changed" and bury the four that
 * matter (e-google.md §C11, after Antigravity 2.13's collapsible Scratch Files
 * section). A file is scratch when it sits under an OS temporary directory, is
 * ignored by the repository, or lives under a `scratch/` or `tmp/` directory or
 * `.claude/worktrees/`. It stays in the evidence; it leaves diff counts, the
 * needs-review totals, review marks and the PR body's file list, and it is
 * listed apart with a "Count this file" that holds until taken back.
 */

export type ScratchReason = 'os-temp' | 'gitignored' | 'scratch-dir' | 'tmp-dir' | 'claude-worktree';

export const SCRATCH_WORDS: Record<ScratchReason, string> = {
  'os-temp': 'under a system temporary directory',
  gitignored: 'ignored by the repository',
  'scratch-dir': 'under a scratch/ directory',
  'tmp-dir': 'under a tmp/ directory',
  'claude-worktree': 'under .claude/worktrees/',
};

/** The directories macOS and Linux hand out as temporary. */
export const DEFAULT_TEMP_ROOTS = ['/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp', '/var/folders', '/private/var/folders'];

/**
 * Why a path is scratch, or null. A repository-relative path is judged by its
 * segments; an absolute path is judged against the temporary roots first.
 * `ignored` is git's answer for the path and is supplied by the caller.
 */
export function scratchReason(p: string, opts: { ignored?: boolean; tempRoots?: readonly string[] } = {}): ScratchReason | null {
  if (typeof p !== 'string' || !p) return null;
  const path = p.replace(/\\/g, '/');
  if (path.startsWith('/')) {
    for (const root of opts.tempRoots ?? DEFAULT_TEMP_ROOTS) {
      const r = root.replace(/\/+$/, '');
      if (path === r || path.startsWith(`${r}/`)) return 'os-temp';
    }
  }
  if (/(^|\/)\.claude\/worktrees\//.test(path)) return 'claude-worktree';
  const dirs = path.split('/').slice(0, -1);
  if (dirs.includes('scratch')) return 'scratch-dir';
  if (dirs.includes('tmp')) return 'tmp-dir';
  if (opts.ignored) return 'gitignored';
  return null;
}

/**
 * Classify a diff's files. A promoted path is counted whatever it matched;
 * ignored paths come from `git check-ignore`.
 */
export function classifyScratch<T extends { path: string }>(files: readonly T[], ignored: ReadonlySet<string>, promoted: ReadonlySet<string>): (T & { scratch: ScratchReason | null })[] {
  return files.map((f) => ({ ...f, scratch: promoted.has(f.path) ? null : scratchReason(f.path, { ignored: ignored.has(f.path) }) }));
}
