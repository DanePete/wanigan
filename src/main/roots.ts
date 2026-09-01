import fs from 'node:fs';
import path from 'node:path';
import { db } from './db';
import { listProjects } from './store';
import { isServablePath } from './context/instructions';

/**
 * Which directories the renderer is allowed to name.
 *
 * Several IPC handlers take a `root` and then carefully confine a relative
 * path inside it — which proves nothing while the root itself is whatever the
 * renderer said. `confine('/Users/me/.ssh', 'id_rsa')` is happily "inside the
 * project". The relative path was never the untrusted part; the base was.
 *
 * A managed root is a registered project or a worktree Wanigan created. Both
 * come from this process's own records, never from the caller.
 */

/**
 * A path this walk gives up on is refused, not guessed at, so the bound only
 * needs to be past any real tree: it exists so a pathological name cannot spin,
 * not to decide what counts as too deep.
 */
const MAX_MISSING_SEGMENTS = 64;

/**
 * The canonical location of a path, or `null` when this process cannot
 * establish one.
 *
 * `realpathSync` can only answer for something that already exists, and on
 * macOS the interesting parents are symlinks: /var, /tmp and /etc all are. So
 * resolving only what exists puts a project and a file about to be created
 * inside it in two different namespaces — /private/var/… for the parent,
 * /var/… for the child — and the root stops containing its own child. The git,
 * context and worktree channels are all handed paths that do not exist yet: a
 * file being written, a worktree being added. That is the ordinary case here,
 * not an edge one.
 *
 * Hence resolving the nearest ancestor that does exist and re-attaching the
 * names below it. A symlink can only be where something exists, so every one
 * on the way is still followed: a leaf that points out of the project resolves
 * out of the project and is still refused. Only the not-yet-created leaf, which
 * can hide nothing, is treated as living under its parent.
 *
 * Nothing here falls back to the string it was handed. A lexical path fed into
 * a containment check is the confusion this function exists to prevent, and a
 * path that will not resolve — a walk past its bound, a root that will not
 * stat, a symlink loop, a directory this process may not traverse — is the case
 * where that comparison is least trustworthy. Those return `null`, and the
 * callers below refuse rather than compare.
 */
function canonical(value: string): string | null {
  let current = path.resolve(value);
  const missing: string[] = [];
  for (let step = 0; step <= MAX_MISSING_SEGMENTS; step++) {
    try {
      const real = fs.realpathSync(current);
      return missing.length ? path.join(real, ...missing.reverse()) : real;
    } catch (error) {
      // Only "there is nothing here yet" earns a step up the tree. Any other
      // refusal (EACCES, ELOOP, ENAMETOOLONG) means the filesystem declined to
      // tell us what this path really is, which is not permission to assume.
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return null;
      const parent = path.dirname(current);
      if (parent === current) return null;
      missing.push(path.basename(current));
      current = parent;
    }
  }
  return null;
}

export function managedRoots(): string[] {
  const projects = listProjects().map((project) => project.path);
  const worktrees = (db().prepare('SELECT path FROM worktrees WHERE removed_at IS NULL').all() as { path: string }[])
    .map((row) => row.path);
  const sessions = (db().prepare('SELECT DISTINCT worktree FROM session_log WHERE worktree IS NOT NULL').all() as { worktree: string }[])
    .map((row) => row.worktree);
  return [...new Set([...projects, ...worktrees, ...sessions])].filter(Boolean);
}

function inside(base: string, candidate: string): boolean {
  return candidate === base || candidate.startsWith(base + path.sep);
}

/** True when `candidate` is a known root or sits under one, both canonicalised. */
function underAnyManagedRoot(candidate: string): boolean {
  for (const known of managedRoots()) {
    const base = canonical(known);
    if (base && inside(base, candidate)) return true;
  }
  return false;
}

/**
 * Returns the canonical root, or throws. A subdirectory of a managed root is
 * itself managed — browsing into `src/` is not an escape — but a path outside
 * every project and worktree is refused before anything reads or writes.
 */
export function assertManagedRoot(root: unknown, label = 'That folder'): string {
  if (typeof root !== 'string' || !root.trim()) {
    throw new Error(`${label} is not a folder Wanigan can act on.`);
  }
  const candidate = canonical(root);
  if (candidate && underAnyManagedRoot(candidate)) return candidate;
  throw new Error(
    `${label} is outside every project and worktree Wanigan manages, so it will not be read or changed. Add the folder as a project first.`,
  );
}

/** Non-throwing form for callers that degrade instead of erroring. */
export function isManagedRoot(root: unknown): boolean {
  try { assertManagedRoot(root); return true; } catch { return false; }
}

/**
 * Handing a path to the OS ("open this") is not a read — LaunchServices decides
 * what happens to it. So the target must be something this process already
 * knows about: inside a managed project or worktree, or a file the instruction
 * scanner itself surfaced (a user-scope CLAUDE.md legitimately sits outside
 * every project).
 */
export function assertOpenablePath(target: string): string {
  const candidate = canonical(target);
  if (candidate) {
    if (underAnyManagedRoot(candidate)) return candidate;
    if (isServablePath(target) || isServablePath(candidate)) return candidate;
  }
  throw new Error(
    `${target} is not inside a project Wanigan manages and was not listed by a context scan, so it will not be opened.`,
  );
}
