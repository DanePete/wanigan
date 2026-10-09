// Reading another program's SQLite database (Wanigan 1's, Codex's) without
// writing a byte into its folder. Even a read-only connection writes there: it
// creates a WAL database's -wal and -shm when they are missing, and it updates
// the -shm when they are not (measured on Codex homes and Wanigan 1's store).
// So only a private temporary copy is opened by SQLite. Copying from validated
// regular descriptors also prevents a replaced path or FIFO from blocking open.
import Database from 'better-sqlite3';
import { closeSync, constants, fstatSync, mkdtempSync, openSync, readSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

export type ReadOnlyDb = Database.Database;

/** Pin the source before checking its type, and never reopen its pathname. */
function copyRegularFile(file: string, copy: string, optional = false, admitBytes?: (bytes: number) => void): void {
  let source: number;
  try {
    // Follow ordinary symlinks as before, but a FIFO must not wait for a writer.
    source = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  try {
    const stat = fstatSync(source);
    if (!stat.isFile()) throw new Error('A foreign database must be a regular file.');
    if (!Number.isSafeInteger(stat.size) || stat.size < 0) throw new Error('The foreign database size cannot be read safely.');
    // A caller may refuse this descriptor's size before its bytes are copied.
    admitBytes?.(stat.size);
    const destination = openSync(copy, 'wx', 0o600);
    try {
      const buffer = Buffer.allocUnsafe(64 * 1024);
      // Copy only the size observed on this descriptor, so an appending writer
      // cannot prolong this loop. This is not an atomic database/WAL snapshot.
      for (let offset = 0; offset < stat.size;) {
        const read = readSync(source, buffer, 0, Math.min(buffer.length, stat.size - offset), offset);
        if (!read) throw new Error('The foreign database changed while being copied.');
        for (let written = 0; written < read;) {
          const count = writeSync(destination, buffer, written, read - written);
          if (!count) throw new Error('The private database copy could not be written.');
          written += count;
        }
        offset += read;
      }
    } finally { closeSync(destination); }
  } finally { closeSync(source); }
}

/** Run `read` against a clone of the database at `file`. Null when it is missing or unreadable. */
export function readForeignDb<T>(file: string, read: (db: ReadOnlyDb) => T, admitBytes?: (bytes: number) => void): T | null {
  const dir = mkdtempSync(join(tmpdir(), 'wanigan-read-'));
  try {
    const copy = join(dir, basename(file));
    // The WAL first: if a checkpoint lands between the two copies, the database
    // already holds what the older WAL says, rather than missing what a newer one
    // builds on. The -shm is not copied; SQLite rebuilds it from the WAL.
    copyRegularFile(`${file}-wal`, `${copy}-wal`, true, admitBytes);
    copyRegularFile(file, copy, false, admitBytes);
    const db = new Database(copy, { readonly: true, fileMustExist: true });
    try {
      return read(db);
    } finally {
      db.close();
    }
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The columns a table has, so a reader can cope with an older or newer schema. */
export function columns(db: ReadOnlyDb, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
}
