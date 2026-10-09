// A session's terminal output: a bounded in-memory tail for instant replay, and
// a capped file so a session that has ended can still be read after a restart.
import { closeSync, existsSync, openSync, readSync, statSync, writeSync, renameSync, unlinkSync } from 'node:fs';

const MEMORY_LIMIT = 2 * 1024 * 1024;
const FILE_LIMIT = 8 * 1024 * 1024;

export class Scrollback {
  private chunks: string[] = [];
  private size = 0;
  private fd: number | null;
  private fileSize: number;
  seq = 0;

  private readonly file: string | null;

  /** Null keeps sensitive terminal output in memory only, even if the core crashes. */
  constructor(file: string | null) {
    this.file = file;
    this.fd = file === null ? null : openSync(file, 'a');
    this.fileSize = file !== null && existsSync(file) ? statSync(file).size : 0;
  }

  append(data: string): number {
    const memory = data.length > MEMORY_LIMIT ? data.slice(-MEMORY_LIMIT) : data;
    this.chunks.push(memory);
    this.size += memory.length;
    while (this.size > MEMORY_LIMIT && this.chunks.length > 1) this.size -= (this.chunks.shift() as string).length;
    if (this.fd !== null) {
      const bytes = Buffer.from(data, 'utf8');
      writeSync(this.fd, bytes);
      this.fileSize += bytes.length;
      if (this.fileSize > FILE_LIMIT) this.compact();
    }
    return ++this.seq;
  }

  text(): string {
    return this.chunks.join('');
  }

  close(): void {
    if (this.fd !== null) closeSync(this.fd);
    this.fd = null;
  }

  /** Keep the newest half of the file when it outgrows its cap. */
  private compact(): void {
    if (this.fd === null || this.file === null) return;
    closeSync(this.fd);
    const tail = readTail(this.file, FILE_LIMIT / 2);
    const tmp = `${this.file}.tmp`;
    const fd = openSync(tmp, 'w');
    writeSync(fd, tail);
    closeSync(fd);
    renameSync(tmp, this.file);
    this.fd = openSync(this.file, 'a');
    this.fileSize = tail.length;
  }

  /** The newest output of a session that is no longer in memory. */
  static read(file: string, limit = MEMORY_LIMIT): string {
    if (!existsSync(file)) return '';
    return readTail(file, limit).toString('utf8');
  }

  static remove(file: string): void {
    try { unlinkSync(file); } catch { /* already gone */ }
  }
}

function readTail(file: string, limit: number): Buffer {
  const size = statSync(file).size;
  const length = Math.min(size, limit);
  const buffer = Buffer.alloc(length);
  const fd = openSync(file, 'r');
  try {
    readSync(fd, buffer, 0, length, size - length);
  } finally {
    closeSync(fd);
  }
  return buffer;
}
