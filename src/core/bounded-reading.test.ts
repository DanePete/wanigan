// Files can change after they were attached or after a size check. None of
// these tests opens user data or launches a model.
import assert from 'node:assert/strict';
import fs, { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import { readPicked } from '../main/picked.ts';
import { ATTACH_MAX_BYTES, PREVIEW_MAX_BYTES } from '../shared/attachments.ts';
import { streamMessage } from './chat.ts';
import { testCore } from './test-support.ts';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test('attachment previews refuse a file that grew past the preview limit after being saved', async () => {
  const t = await testCore();
  try {
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    const session = await t.owner.call('sessions.start', { projectId: project.id, provider: 'claude' });
    const file = await t.owner.call('attachments.save', { to: { session: session.id }, name: 'image.png', data: PNG.toString('base64') });
    truncateSync(file.path, PREVIEW_MAX_BYTES + 1);
    assert.ok(t.core.attachments.preview(file.id) === null, 'stored metadata is not a bound on current bytes');
  } finally { await t.close(); }
});

test('chat attachments that grew since they were saved are refused before building model input', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wg-chat-bounds-'));
  try {
    const path = join(dir, 'image.png');
    writeFileSync(path, PNG);
    truncateSync(path, ATTACH_MAX_BYTES + 1);
    assert.throws(() => streamMessage('inspect this', [{ id: 'image', name: 'image.png', path, size: PNG.length, kind: 'image', mime: 'image/png', createdAt: 0, sentAt: null }]), /too large|changed|could not be read/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the Attach dialog bounds the actual read when a file grows after its initial size check', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wg-picked-growth-'));
  const path = join(dir, 'growing.txt');
  writeFileSync(path, 'small');
  const stat = fs.statSync;
  const patch = mock.method(fs, 'statSync', (...args: Parameters<typeof stat>) => {
    const before = stat(...args);
    if (args[0] === path) truncateSync(path, ATTACH_MAX_BYTES + 1);
    return before;
  });
  syncBuiltinESMExports();
  try {
    const result = readPicked([path]);
    assert.equal(result.files.length, 0, 'the initial small size must not authorize an unbounded read');
    assert.equal(result.refused.length, 1);
  } finally { patch.mock.restore(); syncBuiltinESMExports(); rmSync(dir, { recursive: true, force: true }); }
});

test('an untracked file growing after lstat cannot bypass the Git preview read limit', async () => {
  const { default: promises } = await import('node:fs/promises');
  const { readUntracked } = await import('./git.ts');
  const dir = mkdtempSync(join(tmpdir(), 'wg-untracked-growth-'));
  const path = join(dir, 'growing.txt');
  writeFileSync(path, 'small');
  const stat = promises.lstat;
  const patch = mock.method(promises, 'lstat', async (...args: Parameters<typeof stat>) => {
    const before = await stat(...args);
    if (args[0] === path) writeFileSync(path, 'x'.repeat(300_000));
    return before;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(readUntracked(path), /too large|changed/);
  } finally { patch.mock.restore(); syncBuiltinESMExports(); rmSync(dir, { recursive: true, force: true }); }
});
