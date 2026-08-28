import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Carry the old Foreman userData directory across to Wanigan.
 *
 * Electron derives userData from the app name, so renaming the product and
 * changing appId to io.deadnorth.wanigan points the app at a new, empty
 * folder. Everything the old one held — the database, the encrypted API key,
 * transcripts, worktree bookkeeping, the policy ledger — is still on disk
 * under the previous name, and without this the app looks like a fresh
 * install to the one person who has been using it.
 *
 * This runs BEFORE anything opens the database or Electron writes its own
 * Preferences file, because a half-populated destination is the case that
 * turns a rename into a merge.
 *
 * THE GUARD IS THE IMPORTANT PART. `--user-data-dir` points userData
 * somewhere deliberate — a test harness, a second profile, a throwaway. Left
 * unguarded, this would empty the real directory into that location and the
 * caller would delete it as scratch. scripts/smoke.sh does exactly that, with
 * a mktemp -d it removes on exit. So the migration only ever runs when
 * userData is where Electron would have put it by default.
 *
 * Delete this at 1.0. Nobody outside this machine ever ran the old bundle id,
 * so the migration is dead code the moment the first public build ships.
 */

/** The old directory names. macOS APFS is case-insensitive by default, so
 *  these are usually one directory — but a case-sensitive volume is a
 *  supported thing to have, and then they are genuinely two. */
export const OLD_NAMES = ['Foreman', 'foreman'];

/** Files that carried the product name and have to be renamed with it. */
const RENAMES: [string, string][] = [
  ['foreman.db', 'wanigan.db'],
  ['foreman.db-wal', 'wanigan.db-wal'],
  ['foreman.db-shm', 'wanigan.db-shm'],
  ['foreman.json', 'wanigan.json'],
];

export type MigrationResult = {
  moved: boolean;
  from?: string;
  /** Why nothing happened, when that is worth saying out loud. */
  note?: string;
};

function exists(p: string): boolean {
  try { fs.accessSync(p); return true; } catch { return false; }
}

function sameDir(a: string, b: string): boolean {
  try {
    const x = fs.statSync(a), y = fs.statSync(b);
    return x.ino === y.ino && x.dev === y.dev;
  } catch { return false; }
}

/**
 * The old directory to carry across, or null. Identified by the database
 * inside it rather than by the directory existing: an empty `Foreman/` left
 * behind by something else is not a migration source.
 */
export function findOldDir(appData: string, newDir: string): string | null {
  return OLD_NAMES
    .map((n) => path.join(appData, n))
    .find((p) => exists(path.join(p, 'foreman.db')) && !sameDir(p, newDir)) ?? null;
}

/**
 * Move `oldDir` to `newDir` and rename the files that carried the product
 * name. Separated from Electron so it can be tested against temp directories
 * instead of against somebody's real data.
 */
export function moveUserData(oldDir: string, newDir: string): MigrationResult {
  if (!exists(newDir)) {
    // The clean case: one atomic rename on the same volume.
    fs.renameSync(oldDir, newDir);
  } else {
    // Electron got there first. Move entry by entry and never overwrite —
    // anything already in the destination was written by the new build and is
    // newer than what we are carrying over.
    for (const entry of fs.readdirSync(oldDir)) {
      const to = path.join(newDir, entry);
      if (exists(to)) continue;
      fs.renameSync(path.join(oldDir, entry), to);
    }
    try { fs.rmdirSync(oldDir); } catch { /* not empty; leave it for the user */ }
  }

  // All three sqlite files move together: SQLite pairs a -wal with its
  // database by filename, and separating them discards every committed
  // transaction still sitting in the log.
  for (const [from, to] of RENAMES) {
    const src = path.join(newDir, from);
    if (exists(src) && !exists(path.join(newDir, to))) {
      fs.renameSync(src, path.join(newDir, to));
    }
  }

  return { moved: true, from: oldDir };
}

export function migrateUserData(): MigrationResult {
  try {
    const appData = app.getPath('appData');
    const newDir = app.getPath('userData');

    // See the header: an explicit --user-data-dir is a deliberate destination,
    // never a migration target.
    const defaultDir = path.join(appData, app.getName());
    if (path.resolve(newDir) !== path.resolve(defaultDir)) {
      return { moved: false, note: 'userData was set explicitly; leaving the old directory alone' };
    }

    // Already migrated. The database is the marker rather than the directory,
    // because Electron may have created the directory before we ran.
    if (exists(path.join(newDir, 'wanigan.db'))) return { moved: false };

    const oldDir = findOldDir(appData, newDir);
    if (!oldDir) return { moved: false };

    return moveUserData(oldDir, newDir);
  } catch (e) {
    // A failed migration must never stop the app from starting. The old
    // directory is untouched on any error, so the fix is to retry, not to
    // recover data.
    return { moved: false, note: e instanceof Error ? e.message : String(e) };
  }
}
