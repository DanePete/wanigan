import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { guardStorageDatabase, registerStorageParticipant } from '../storage-maintenance';

let _db: Database.Database | null = null;

/** App data holds prompts, transcript indexes, result payloads, and credentials.
 * Keep every Wanigan-owned directory private even when it already existed with a
 * permissive umask or was carried forward from an older install. */
export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

export function ensurePrivateDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  // mkdir's mode applies only to a new leaf and is filtered by umask. Existing
  // directories retain their previous mode, so correct both cases explicitly.
  fs.chmodSync(dir, PRIVATE_DIR_MODE);
  return dir;
}

export function ensurePrivateFile(file: string): string {
  // writeFile/createWriteStream's mode only applies when creating a file. A
  // rerun must not leave an older, wider file readable by another local user.
  fs.chmodSync(file, PRIVATE_FILE_MODE);
  return file;
}

export function dataDir(): string {
  return app.getPath('userData');
}
export function resultsDir(): string {
  return path.join(dataDir(), 'results');
}

/**
 * One database for the whole app. Projects are shared between the Sessions and
 * Batches views — an agent session and a batch run target the same repo, so
 * there is exactly one project list, not two.
 */
export function openStorageConnection(migrateSchema: (d: Database.Database) => void): Database.Database {
  if (_db) return _db;
  const root = ensurePrivateDir(dataDir());
  ensurePrivateDir(resultsDir());
  const file = path.join(root, 'wanigan.db');
  // Registration and open admission share the external coordinator lock. A
  // registered participant cannot be ignored merely because it has no rows.
  const owner = registerStorageParticipant(root);
  return owner.initialize(() => {
    let d: Database.Database;
    try {
      d = new Database(file);
      ensurePrivateFile(file);
      owner.attach(d);
    } catch (e) {
      if ((e as { code?: string }).code === 'ERR_DLOPEN_FAILED') {
        throw new Error(
          'better-sqlite3 was built for a different Node/Electron ABI. Run "npm run rebuild".'
        );
      }
      throw e;
    }
    // Wanigan's attended app, launchd scheduler and CLI can open the same file
    // at the same time. Let a short schema/write lock settle instead of failing
    // a whole process with SQLITE_BUSY on startup.
    d.pragma('busy_timeout = 10000');
    d.pragma('journal_mode = WAL');
    d.pragma('foreign_keys = ON');
    migrateSchema(d);
    // SQLite's journal files carry the same rows as the primary database. The
    // private userData root is the durable boundary; tightening sidecars too
    // avoids relying on it if an older install had inherited broad permissions.
    for (const suffix of ['', '-wal', '-shm']) {
      const candidate = `${file}${suffix}`;
      if (fs.existsSync(candidate)) ensurePrivateFile(candidate);
    }
    _db = guardStorageDatabase(d, owner);
    return _db;
  });
}

