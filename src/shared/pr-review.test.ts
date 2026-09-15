import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forgeOf, parsePrNumber, prFetchSpec, prRefs, reviewPromptStub, versionAtLeast } from './pr-review.ts';

test('a PR number is digits, optionally after # or !, and nothing else', () => {
  assert.equal(parsePrNumber('12'), 12);
  assert.equal(parsePrNumber(' #1234 '), 1234);
  assert.equal(parsePrNumber('!7'), 7);
  assert.equal(parsePrNumber(42), 42);
  for (const bad of ['', '0', '-1', '12a', '1.5', '12; rm -rf /', 'pull/12/head', '99999999', 1.5, null, undefined]) {
    assert.equal(parsePrNumber(bad), null, String(bad));
  }
});

test('the forge is read from the origin host, in https and scp forms', () => {
  assert.equal(forgeOf('https://github.com/acme/app.git'), 'github');
  assert.equal(forgeOf('git@github.com:acme/app.git'), 'github');
  assert.equal(forgeOf('https://gitlab.com/acme/app.git'), 'gitlab');
  assert.equal(forgeOf('git@gitlab.example.org:acme/app.git'), 'gitlab');
  assert.equal(forgeOf('ssh://git@code.internal/acme/app.git'), 'other');
  assert.equal(forgeOf('/Users/d/repos/app'), 'other');
  assert.equal(forgeOf('https://evil.com/github.com/x'), 'other', 'the host decides, not a path segment');
});

test('GitLab refs only for a GitLab origin', () => {
  assert.deepEqual(prRefs('github', 5), ['pull/5/head']);
  assert.deepEqual(prRefs('other', 5), ['pull/5/head']);
  assert.deepEqual(prRefs('gitlab', 5), ['merge-requests/5/head']);
  assert.equal(prFetchSpec('pull/5/head', 5), '+refs/pull/5/head:refs/wanigan/review/5');
});

test('the prompt stub names the change and says the session has no command tools', () => {
  const stub = reviewPromptStub(12, 'github', 'wanigan/review-pr-12-ab12');
  assert.match(stub, /pull request #12/);
  assert.match(stub, /no command tools/);
  assert.match(reviewPromptStub(3, 'gitlab', 'b'), /merge request !3/);
});

test('version floors compare numerically and never pass an unknown version', () => {
  assert.equal(versionAtLeast('2.1.271 (Claude Code)', '2.1.248'), true);
  assert.equal(versionAtLeast('2.1.248', '2.1.248'), true);
  assert.equal(versionAtLeast('2.1.99', '2.1.248'), false);
  assert.equal(versionAtLeast('2.10.0', '2.9.999'), true);
  assert.equal(versionAtLeast(null, '2.1.248'), false);
  assert.equal(versionAtLeast('dev', '2.1.248'), false);
});
