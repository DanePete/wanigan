// A terminal's record: a bounded tail in memory for an instant replay, and a
// capped file that keeps the newest output, readable once the session is gone.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Scrollback } from './scrollback.ts';

test('memory keeps the newest 2 MB, the file the newest 8 MB at most, and both end with the latest output', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wg-scroll-'));
  try {
    const file = join(dir, 's.log');
    const log = new Scrollback(file);
    const chunk = (i: number): string => `${String(i).padStart(6, '0')}${'x'.repeat(64 * 1024 - 7)}\n`;
    let seq = 0;
    for (let i = 0; i < 200; i++) seq = log.append(chunk(i)); // 12.5 MB in all
    assert.equal(seq, 200, 'each chunk is numbered, so a watcher knows where it is');

    const memory = log.text();
    assert.ok(memory.length <= 2 * 1024 * 1024, `memory holds ${memory.length}`);
    assert.ok(memory.endsWith(chunk(199)));
    assert.ok(memory.startsWith('000'), 'whole chunks, never half of one');

    log.close();
    const size = statSync(file).size;
    assert.ok(size <= 8 * 1024 * 1024 && size >= 4 * 1024 * 1024, `the file is ${size} bytes`);
    const after = Scrollback.read(file);
    assert.ok(after.endsWith(chunk(199)), 'what a reopened window replays is the newest');
    assert.equal(after.length, 2 * 1024 * 1024);

    // A record removed (a terminal a key may have been typed into) reads as nothing.
    Scrollback.remove(file);
    assert.equal(Scrollback.read(file), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test('one oversized terminal chunk still keeps only the newest 2 MB in memory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wg-scroll-large-'));
  try {
    const log = new Scrollback(join(dir, 's.log'));
    const chunk = 'x'.repeat(4 * 1024 * 1024) + 'latest output';
    log.append(chunk);
    assert.equal(log.text().length, 2 * 1024 * 1024);
    assert.equal(log.text(), chunk.slice(-2 * 1024 * 1024));
    log.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
