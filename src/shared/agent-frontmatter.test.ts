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

test('disable-model-invocation is set in place, added before the closing fence, or given a frontmatter', async () => {
  const { withDisableModelInvocation } = await import('./agent-frontmatter.ts');
  assert.equal(withDisableModelInvocation('---\nname: a\ndisable-model-invocation: false\n---\nbody', true),
    '---\nname: a\ndisable-model-invocation: true\n---\nbody');
  assert.equal(withDisableModelInvocation('---\nname: a\n---\nbody', true), '---\nname: a\ndisable-model-invocation: true\n---\nbody');
  assert.equal(withDisableModelInvocation('body only', false), '---\ndisable-model-invocation: false\n---\nbody only');
  assert.equal(withDisableModelInvocation('---\r\nname: a\r\n---\r\nbody', true), '---\r\nname: a\r\ndisable-model-invocation: true\r\n---\r\nbody');
  assert.throws(() => withDisableModelInvocation('---\nname: a\nbody', true), /never closes/);
});
