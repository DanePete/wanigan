import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ATTACH_MAX_BYTES } from '../shared/attachments.ts';
import { readPicked } from './picked.ts';

test('the Attach dialog’s files are read in main, within the same limits the core keeps', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wg-picked-'));
  try {
    writeFileSync(join(dir, 'notes.md'), '# Notes\n');
    mkdirSync(join(dir, 'folder'));
    writeFileSync(join(dir, 'huge.bin'), '');
    truncateSync(join(dir, 'huge.bin'), ATTACH_MAX_BYTES + 1);
    const picked = readPicked([join(dir, 'notes.md'), join(dir, 'folder'), join(dir, 'huge.bin'), join(dir, 'gone.png')]);
    assert.deepEqual(picked.files, [{ name: 'notes.md', data: Buffer.from('# Notes\n').toString('base64') }]);
    assert.deepEqual(picked.refused, ['folder is not a file.', 'huge.bin is 20.0 MB. A file can be at most 20 MB.', 'gone.png could not be read.']);
    const many = readPicked(Array.from({ length: 12 }, () => join(dir, 'notes.md')));
    assert.equal(many.files.length, 10);
    assert.match(many.refused.at(-1) ?? '', /10 files at most/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
