/**
 * The two weak-oracle shapes, read from diff bytes git 2.50.1 prints for
 * `diff --unified=0`. The question each test asks is whether a flag could be
 * raised on work that does not have the shape, or missed on work that does.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changedFilesFromDiff, isCodePath, isTestPath, oracleSentence, readOracles } from './test-oracles.ts';

test('test paths are recognised across the common layouts, and code paths exclude them', () => {
  for (const path of ['src/checkout.test.ts', 'tests/test_retry.py', 'pkg/retry_test.go', 'spec/models/order_spec.rb', 'app/__tests__/cart.jsx', 'Sources/RetryTests.swift']) {
    assert.equal(isTestPath(path), true, path);
  }
  for (const path of ['src/checkout.ts', 'pkg/retry.go', 'README.md', 'src/contest.ts']) assert.equal(isTestPath(path), false, path);
  assert.equal(isCodePath('src/checkout.ts'), true);
  assert.equal(isCodePath('src/checkout.test.ts'), false);
  assert.equal(isCodePath('docs/retry.md'), false);
});

test('a diff splits into each file and only its added lines', () => {
  const diff = [
    'diff --git a/src/retry.ts b/src/retry.ts',
    'index 1111111..2222222 100644',
    '--- a/src/retry.ts',
    '+++ b/src/retry.ts',
    '@@ -3 +3,2 @@ export function retry() {',
    '-  return charge();',
    '+  const existing = find(key);',
    '+  return existing ?? charge();',
    'diff --git a/src/retry.test.ts b/src/retry.test.ts',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/src/retry.test.ts',
    '@@ -0,0 +1,3 @@',
    "+test('retries', () => {",
    '+  retry();',
    '+});',
    '',
  ].join('\n');
  const files = changedFilesFromDiff(diff);
  assert.deepEqual(files.map((file) => file.path), ['src/retry.ts', 'src/retry.test.ts']);
  assert.deepEqual(files[0].addedLines, ['  const existing = find(key);', '  return existing ?? charge();']);
  assert.equal(files[1].addedLines.length, 3);
});

test('tests changed with the code, and a test with no assertion, are both flagged', () => {
  const reading = readOracles([
    { path: 'src/retry.ts', addedLines: ['return existing ?? charge();'] },
    { path: 'src/retry.test.ts', addedLines: ["test('retries', () => {", '  retry();', '});'] },
  ]);
  assert.equal(reading.testFiles, 1);
  assert.equal(reading.codeFiles, 1);
  assert.deepEqual(reading.flags, [
    { kind: 'tests-edited-with-code', testFiles: 1, codeFiles: 1 },
    { kind: 'test-without-assertion', path: 'src/retry.test.ts' },
  ]);
  assert.match(oracleSentence(reading.flags[0]), /same change as the code \(1 test file, 1 code file\)/);
  assert.match(oracleSentence(reading.flags[1]), /^src\/retry\.test\.ts gained test lines with no assertion/);
});

test('a test with an assertion, or tests changed on their own, raise no flag', () => {
  assert.deepEqual(readOracles([
    { path: 'src/retry.ts', addedLines: ['return existing ?? charge();'] },
  ]).flags, []);
  assert.deepEqual(readOracles([
    { path: 'tests/test_retry.py', addedLines: ['def test_retry():', '    assert retry() == 1'] },
  ]).flags, []);
  assert.deepEqual(readOracles([
    { path: 'pkg/retry_test.go', addedLines: ['if got != want {', '\tt.Errorf("got %v", got)', '}'] },
  ]).flags, []);
  // Comment-only additions are not a test without an assertion.
  assert.deepEqual(readOracles([{ path: 'src/a.test.ts', addedLines: ['// TODO: cover the timeout path'] }]).flags, []);
});
