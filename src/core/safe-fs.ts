// The few rules every write outside Wanigan's own folder obeys. A path the
// owner did not name is never written; a known root is never left through
// `..` or a link; and nothing is deleted outright: it is moved to Wanigan's
// trash, where the owner can take it back.
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { CoreError } from '../shared/protocol.ts';

/** Whether `path` is `root` or inside it, compared as plain resolved paths. */
export function within(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (!!rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** The real path of the nearest part of `path` that exists. */
function realOfExisting(path: string): string {
  let current = resolve(path);
  for (;;) {
    try { return join(realpathSync(current), relative(current, resolve(path))); } catch { /* not there yet */ }
    const parent = dirname(current);
    if (parent === current) return resolve(path);
    current = parent;
  }
}

/**
 * Refuse a path that leaves `anchor`, whether by `..` or by a link somewhere
 * along it that points elsewhere. Parts that do not exist yet are fine: they
 * will be created as real folders.
 */
export function assertInside(anchor: string, path: string, what: string): void {
  if (!within(anchor, path)) throw new CoreError('refused', `${what} is outside ${display(anchor)}.`);
  let realAnchor: string;
  try { realAnchor = realpathSync(anchor); } catch { realAnchor = resolve(anchor); }
  if (!within(realAnchor, realOfExisting(path))) {
    throw new CoreError('refused', `${what} leads outside ${display(anchor)} through a link. Wanigan will not write there.`);
  }
}

/** Make `dir` (and any missing parents below `anchor`) as real folders, after checking where it lands. */
export function ensureDir(anchor: string, dir: string, what: string): void {
  assertInside(anchor, dir, what);
  mkdirSync(dir, { recursive: true });
  assertInside(anchor, dir, what);
}

/**
 * Move a folder (or a link) into Wanigan's trash and return where it went. A
 * link is moved as a link: what it points to is never touched.
 */
export function moveToTrash(path: string, trashDir: string, now: number): string {
  mkdirSync(trashDir, { recursive: true, mode: 0o700 });
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  let dest = join(trashDir, `${stamp}-${basename(path)}`);
  for (let n = 2; existsSync(dest); n++) dest = join(trashDir, `${stamp}-${basename(path)}-${n}`);
  try {
    renameSync(path, dest);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    // Another volume: copy, then remove the original only once the copy exists.
    cpSync(path, dest, { recursive: true, verbatimSymlinks: true, errorOnExist: true });
    rmSync(path, { recursive: true, force: true });
  }
  return dest;
}

/** A path as the owner would type it: `~/...` inside their home. */
export function display(path: string, home = homedir()): string {
  return path === home ? '~' : path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}

/** Whether a path is a link, without following it. */
export function isLink(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
}

/** Names in a folder, or none when it cannot be read. */
export function names(dir: string): string[] {
  try { return readdirSync(dir).sort(); } catch { return []; }
}
