/**
 * The omitClaudeMd reader marks only what the 2.1.271 loader itself honours:
 * the boolean true or the string "true". Anything else is not guessed on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { omitClaudeMdOf, versionAtLeast } from './agent-frontmatter.ts';

test('omitClaudeMd is on only for true or "true" in the frontmatter', () => {
  assert.equal(omitClaudeMdOf('---\nname: a\nomitClaudeMd: true\n---\nbody'), true);
  assert.equal(omitClaudeMdOf('---\nomitClaudeMd: "true"\n---\n'), true);
  assert.equal(omitClaudeMdOf('---\nomitClaudeMd: false\n---\n'), false);
  assert.equal(omitClaudeMdOf('---\nomitClaudeMd: yes\n---\n'), 'unknown');
  assert.equal(omitClaudeMdOf('---\nname: a\n---\nomitClaudeMd: true'), false);
  assert.equal(omitClaudeMdOf('no frontmatter'), false);
});

test('the version gate reads the CLI’s own version line', () => {
  assert.equal(versionAtLeast('2.1.271 (Claude Code)', '2.1.271'), true);
  assert.equal(versionAtLeast('2.1.270', '2.1.271'), false);
  assert.equal(versionAtLeast('2.2.0', '2.1.271'), true);
  assert.equal(versionAtLeast(null, '2.1.271'), null);
});
