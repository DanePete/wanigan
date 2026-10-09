import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs, { mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import { readBoundedFile } from './bounded-file.ts';

test('bounded reads accept the exact limit and refuse larger, special and linked files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wg-bounded-file-'));
  try {
    const file = join(dir, 'text');
    writeFileSync(file, 'four');
    assert.equal(readBoundedFile(file, 4).toString(), 'four');
    assert.throws(() => readBoundedFile(file, 3), /too large/);
    assert.throws(() => readBoundedFile(dir, 4), /regular file/);
    const link = join(dir, 'link');
    symlinkSync(file, link);
    assert.throws(() => readBoundedFile(link, 4));
    assert.equal(readBoundedFile(link, 4, true).toString(), 'four', 'only a deliberate picked-file read follows links');
    const fifo = join(dir, 'fifo');
    execFileSync('/usr/bin/mkfifo', [fifo]);
    assert.throws(() => readBoundedFile(fifo, 4), /regular file/, 'a FIFO is refused without waiting for a writer');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a descriptor that grows after inspection is read only to its original size plus one byte', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wg-bounded-growth-'));
  const path = join(dir, 'text');
  writeFileSync(path, 'four');
  const stat = fs.fstatSync;
  const read = fs.readSync;
  let inspected = false;
  let requested = 0;
  const inspect = mock.method(fs, 'fstatSync', (...args: Parameters<typeof stat>) => {
    const before = stat(...args);
    if (!inspected) { inspected = true; truncateSync(path, 8_000_000); }
    return before;
  });
  const reading = mock.method(fs, 'readSync', (fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: number | null) => {
    requested += length;
    return read(fd, buffer, offset, length, position);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => readBoundedFile(path, 100), /changed/);
    assert.equal(requested, 5);
  } finally {
    inspect.mock.restore(); reading.mock.restore(); syncBuiltinESMExports();
    rmSync(dir, { recursive: true, force: true });
  }
});
