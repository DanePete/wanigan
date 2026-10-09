// Where a data directory keeps its files and sockets. No dependencies, so the
// Electron main process can import it without pulling in the core.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface CorePaths {
  dataDir: string;
  database: string;
  socket: string;
  hookSocket: string;
  ownerToken: string;
  info: string;
  bin: string;
  /** What the core writes as it runs. */
  log: string;
  /** Its stdout and stderr: what a core that dies before it can write its log leaves. */
  outLog: string;
  /** Why the last core could not start, written by that core; gone once one starts. */
  failed: string;
}

/**
 * Unix socket paths are limited to ~104 bytes on macOS. A long data directory
 * gets its sockets in a short directory keyed by that path instead, in the
 * user's own temporary folder: in a shared /tmp another user could make it
 * first. The core makes it owner-only, and refuses one it does not own.
 */
export function corePaths(dataDir: string): CorePaths {
  let socketDir = dataDir;
  if (join(dataDir, 'hooks.sock').length > 100) {
    const name = `wanigan-${createHash('sha256').update(dataDir).digest('hex').slice(0, 12)}`;
    const own = join(tmpdir(), name);
    socketDir = join(own, 'hooks.sock').length <= 100 ? own : join('/tmp', `wanigan-${process.getuid?.() ?? 0}-${name.slice(8)}`);
  }
  return {
    dataDir,
    database: join(dataDir, 'wanigan.db'),
    socket: join(socketDir, 'core.sock'),
    hookSocket: join(socketDir, 'hooks.sock'),
    ownerToken: join(dataDir, 'owner.token'),
    info: join(dataDir, 'core.json'),
    bin: join(dataDir, 'bin'),
    log: join(dataDir, 'core.log'),
    outLog: join(dataDir, 'core.out.log'),
    failed: join(dataDir, 'core.failed.json'),
  };
}

/**
 * Which build of the core an entry script is: a hash of the file. A bundled
 * entry names the chunks it loads by their content hash, so any change to the
 * core changes it. The core takes it of itself as it starts; the app takes it
 * of the entry it would start, and the two are compared. Null when unreadable.
 */
export function buildOf(entry: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(entry)).digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}
