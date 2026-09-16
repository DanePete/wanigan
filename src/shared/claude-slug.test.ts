/**
 * The folder-name rule is only worth anything if it names the folder the CLI
 * actually wrote. The short-path expectations below are directory names that
 * exist on the machine this was written on, created by Claude Code itself; the
 * hash vectors are Java's published String.hashCode values, which is the
 * function the CLI's minified `k5` computes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLAUDE_SLUG_MAX, claudeProjectSlug, javaStringHash } from './claude-slug.ts';

test('a short path becomes every non-alphanumeric character as a dash, case kept', () => {
  assert.equal(claudeProjectSlug('/Users/dane/Projects/drupal/wanigan'), '-Users-dane-Projects-drupal-wanigan');
  // A physical tmp path, as the CLI filed it: underscores and slashes alike.
  assert.equal(
    claudeProjectSlug('/private/var/folders/bd/1_x2yqfn371f_twb7w493zjh0000gn/T/wanigan-limits'),
    '-private-var-folders-bd-1-x2yqfn371f-twb7w493zjh0000gn-T-wanigan-limits',
  );
  // A worktree under Application Support is its own folder, space and all.
  assert.equal(
    claudeProjectSlug('/Users/dane/Library/Application Support/wanigan/worktrees/wanigan-4ouv7q'),
    '-Users-dane-Library-Application-Support-wanigan-worktrees-wanigan-4ouv7q',
  );
});

test('the hash is Java String.hashCode with 32-bit wraparound', () => {
  assert.equal(javaStringHash(''), 0);
  assert.equal(javaStringHash('hello'), 99162322);
  assert.equal(javaStringHash('Aa'), javaStringHash('BB'));
  // The one string whose hash is the minimum int. Java's Math.abs would leave
  // it negative; JavaScript's does not, and the CLI is JavaScript.
  assert.equal(javaStringHash('polygenelubricants'), -2147483648);
});

test('a path past 200 characters keeps its first 200 and gains a base-36 hash of the whole path', () => {
  const deep = `/Users/dane/${'nested-directory/'.repeat(14)}repo`;
  const plain = deep.replace(/[^a-zA-Z0-9]/g, '-');
  assert.ok(plain.length > CLAUDE_SLUG_MAX);
  const slug = claudeProjectSlug(deep);
  assert.equal(slug.slice(0, CLAUDE_SLUG_MAX), plain.slice(0, CLAUDE_SLUG_MAX));
  assert.equal(slug, `${plain.slice(0, CLAUDE_SLUG_MAX)}-${Math.abs(javaStringHash(deep)).toString(36)}`);
  // Two deep paths sharing a 200-character prefix still get different folders.
  assert.notEqual(slug, claudeProjectSlug(`${deep}-two`));
  // Exactly 200 is still the plain rule.
  const edge = `/${'a'.repeat(CLAUDE_SLUG_MAX - 1)}`;
  assert.equal(claudeProjectSlug(edge), `-${'a'.repeat(CLAUDE_SLUG_MAX - 1)}`);
});

test('a decomposed accent is slugged as the composed character the CLI stores', () => {
  const decomposed = '/Users/dane/Projects/café';
  const composed = '/Users/dane/Projects/café';
  assert.equal(claudeProjectSlug(decomposed), claudeProjectSlug(composed));
  assert.equal(claudeProjectSlug(composed), '-Users-dane-Projects-caf-');
});
