import assert from 'node:assert/strict';
import { test } from 'node:test';
import { within } from './safe-fs.ts';

test('within allows a filename beginning with two dots without permitting traversal', () => {
  assert.equal(within('/tmp/project', '/tmp/project/..notes'), true);
  assert.equal(within('/tmp/project', '/tmp/project/../notes'), false);
});
