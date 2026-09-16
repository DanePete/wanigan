import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export type BackupEntry = { name: string; bytes: number; sha256: string };

/** Relative manifest paths never select links, parents or device files. */
function checkedPath(root: string, name: string): string {
  if (!name || name.includes('\\') || name.includes('\0') || name.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error(`Invalid backup file path: ${name}`);
  }
  let current = root;
  if (!fs.lstatSync(current).isDirectory()) throw new Error(`Not a real backup directory: ${root}`);
  for (const part of name.split('/')) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
      throw new Error(`Backup cannot read a link or special file: ${current}`);
    }
  }
  return current;
}

function inventory(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  if (!fs.lstatSync(root).isDirectory()) throw new Error(`Not a real backup directory: ${root}`);
  const names: string[] = [];
  function visit(rel: string) {
    for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const name = rel ? `${rel}/${entry.name}` : entry.name;
      checkedPath(root, name);
      if (entry.isDirectory()) visit(name);
      else if (entry.isFile()) names.push(name);
      else throw new Error(`Backup cannot read a link or special file: ${name}`);
    }
  }
  visit('');
  return names.sort();
}

function readFile(root: string, name: string, destination?: string): BackupEntry {
  const file = checkedPath(root, name);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let out: number | undefined;
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile()) throw new Error(`Not a regular backup file: ${name}`);
    if (destination) {
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      out = fs.openSync(destination, 'wx', 0o600);
    }
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytes = 0;
    for (;;) {
      const size = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!size) break;
      hash.update(buffer.subarray(0, size));
      if (out !== undefined) {
        let written = 0;
        while (written < size) written += fs.writeSync(out, buffer, written, size - written);
      }
      bytes += size;
    }
    const after = fs.fstatSync(fd);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || bytes !== after.size) {
      throw new Error(`File changed during backup: ${name}. Retry after its writer stops.`);
    }
    return { name, bytes, sha256: hash.digest('hex') };
  } finally {
    fs.closeSync(fd);
    if (out !== undefined) fs.closeSync(out);
  }
}

export function snapshotBackupFiles(source: string, destination: string): BackupEntry[] {
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  const names = inventory(source);
  const entries = names.map(name => readFile(source, name, path.join(destination, name)));
  if (JSON.stringify(names) !== JSON.stringify(inventory(source))) {
    throw new Error('Files changed during backup. Retry after their writers stop.');
  }
  return entries;
}

/** Verify every named file and reject extra files, duplicate names and malformed entries. */
export function verifyBackupFiles(root: string, entries: BackupEntry[]): void {
  const names = new Set<string>();
  for (const entry of entries) {
    if (!entry || typeof entry.name !== 'string' || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0
        || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256) || names.has(entry.name)) {
      throw new Error('Invalid or duplicate backup file entry.');
    }
    names.add(entry.name);
    const actual = readFile(root, entry.name);
    if (actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256) throw new Error(`${entry.name} does not match its recorded digest.`);
  }
  if (JSON.stringify([...names].sort()) !== JSON.stringify(inventory(root))) {
    throw new Error('Backup file inventory does not match its manifest.');
  }
}

/** Stage only manifested files, verifying the copied bytes again before a live swap. */
export function copyVerifiedBackupFiles(source: string, destination: string, entries: BackupEntry[]): void {
  verifyBackupFiles(source, entries);
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const entry of entries) {
    const copied = readFile(source, entry.name, path.join(destination, entry.name));
    if (copied.bytes !== entry.bytes || copied.sha256 !== entry.sha256) throw new Error(`${entry.name} changed while restoring. Nothing was replaced.`);
  }
}
