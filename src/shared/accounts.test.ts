/**
 * Naming an account directory, without a settings panel or a filesystem.
 *
 * The panel that uses this is the one place a person adds a second Claude or
 * Codex login, and the whole point of the change was that they should never
 * have to type a path. Everything below is a way that could go wrong quietly:
 * a name that is legal to a person and illegal in a path, a name that collides
 * with a directory already spoken for, a name that reduces to nothing at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountSlug, harnessLabel, proposeAccountDir, signInCommand } from './accounts.ts';

test('a label becomes a directory-safe suffix', () => {
  assert.equal(accountSlug('Personal'), 'personal');
  assert.equal(accountSlug('Work Account'), 'work_account');
  assert.equal(accountSlug('Client / ACME'), 'client_acme');
  assert.equal(accountSlug('  spaced  '), 'spaced');
});

test('a label that would put a separator or an accent in a path cannot', () => {
  // These reach CODEX_HOME, which a shell and a harness both read.
  for (const label of ['a/b', 'a\\b', 'a b', 'Työ', 'café', 'x..y', '~root']) {
    const slug = accountSlug(label);
    assert.doesNotMatch(slug, /[^a-z0-9_]/, `${label} -> ${slug}`);
    assert.doesNotMatch(slug, /^_|_$/, `${label} -> ${slug}`);
  }
  assert.equal(accountSlug('Työ'), 'tyo');
});

test('a label with nothing usable in it yields no proposal rather than a bare underscore', () => {
  assert.equal(accountSlug('---'), '');
  assert.equal(accountSlug('   '), '');
  assert.equal(proposeAccountDir('/Users/x/.codex', '---', []), '',
    'the caller shows nothing rather than proposing /Users/x/.codex_');
});

test('a new account is a sibling of the existing one, never a child', () => {
  // A directory inside ~/.codex would be read by the harness as part of its
  // own configuration.
  assert.equal(proposeAccountDir('/Users/x/.codex', 'Personal', []), '/Users/x/.codex_personal');
  assert.equal(proposeAccountDir('/Users/x/.claude', 'Work', []), '/Users/x/.claude_work');
  assert.equal(proposeAccountDir('/Users/x/.codex/', 'Personal', []), '/Users/x/.codex_personal',
    'a trailing separator must not produce a child path');
});

test('a directory already spoken for is not proposed twice', () => {
  // Two accounts sharing one directory share one login; main refuses it, and
  // proposing it anyway would make the refusal look like a bug.
  const taken = ['/Users/x/.codex_personal'];
  assert.equal(proposeAccountDir('/Users/x/.codex', 'Personal', taken), '/Users/x/.codex_personal_2');
  assert.equal(
    proposeAccountDir('/Users/x/.codex', 'Personal', [...taken, '/Users/x/.codex_personal_2']),
    '/Users/x/.codex_personal_3',
  );
  assert.equal(proposeAccountDir('/Users/x/.codex', 'Personal', ['/Users/x/.codex_personal/']),
    '/Users/x/.codex_personal_2', 'a stored path with a trailing separator still counts as taken');
});

test('the sign-in command follows the harness, and is absent when unknown', () => {
  assert.equal(signInCommand('codex'), 'codex login');
  assert.equal(signInCommand('claude-code'), '/login');
  assert.equal(signInCommand('generic-cli'), null,
    'a harness with no known login offers no command rather than a guessed one');
  assert.equal(signInCommand('pack.local.thing'), null);
});

test('a harness groups under a name, falling back to what runs on it', () => {
  assert.equal(harnessLabel('codex'), 'Codex');
  assert.equal(harnessLabel('claude-code'), 'Claude Code');
  assert.equal(harnessLabel('acme-harness', ['ACME Agent']), 'ACME Agent');
  assert.equal(harnessLabel('acme-harness', []), 'acme-harness');
});
