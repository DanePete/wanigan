// Preview limits are observable text/metadata, not merely a constant in source.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { testCore } from './test-support.ts';

test('skill preview accepts the exact byte limit and marks a larger source as truncated without changing it', async () => {
  const t = await testCore();
  try {
    await t.owner.call('projects.add', { path: t.projectDir });
    const dir = join(t.projectDir, '.agents', 'skills', 'preview-boundary');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'SKILL.md');
    const prefix = '---\nname: preview-boundary\ndescription: Preview boundary fixture.\n---\n\n';
    const limit = 512 * 1024;
    for (const size of [limit - 1, limit, limit + 1]) {
      const source = prefix + 'x'.repeat(size - prefix.length);
      writeFileSync(file, source);
      const list = await t.owner.call('skills.list', {});
      const skill = list.groups.flatMap(group => group.skills).find(skill => skill.dir === dir);
      assert.ok(skill);
      const preview = await t.owner.call('skills.read', { id: skill.id });
      assert.equal(Buffer.byteLength(preview.text), Math.min(size, limit), `the preview byte length for ${size} bytes`);
      assert.equal(preview.text, source.slice(0, limit), `the exact prefix for ${size} bytes`);
      assert.equal(preview.truncated, size > limit);
      assert.equal(preview.skill.bytes, size);
      assert.equal(readFileSync(file, 'utf8'), source, 'reading does not trim or rewrite the source');
    }
  } finally { await t.close(); }
});
