/**
 * Claims in the final message. The subject is the grade: a claim the record
 * contradicts is unsupported, a claim the record confirms is verified, and
 * everything in between — including every sentence with nothing specific in it
 * — needs review. Nothing vague is ever marked unsupported.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addedTextOf, extractClaims, gradeClaims, isTestCommand, MAX_CLAIMS, type ClaimEvidence } from './claims.ts';

const SUMMARY = [
  'I fixed the retry bug in checkout.',
  '',
  '## Summary',
  '- Updated `src/checkout.ts` to reuse the stored payment.',
  '- Created `src/idempotency.ts` with a new `idempotencyKey()` helper.',
  '- Deleted `src/legacy/retry.ts`.',
  '- Added the `p-retry` dependency.',
  '',
  'Files changed:',
  '',
  '- README.md',
  '',
  'All tests pass. It should work now.',
  '',
  '```ts',
  "import { fake } from 'src/never.ts';",
  '```',
].join('\n');

test('claims are pulled from bullets, sentences and a files heading; fenced code is not a claim', () => {
  const claims = extractClaims(SUMMARY);
  assert.deepEqual(claims.map((c) => [c.kind, c.subject]), [
    ['vague', null],
    ['file-changed', 'src/checkout.ts'],
    ['file-added', 'src/idempotency.ts'],
    ['symbol-added', 'idempotencyKey'],
    ['file-removed', 'src/legacy/retry.ts'],
    ['dependency-added', 'p-retry'],
    ['file-changed', 'README.md'],
    ['tests-pass', null],
    ['vague', null],
  ]);
  assert.equal(claims[1].quote, 'Updated `src/checkout.ts` to reuse the stored payment.');
});

const evidence: ClaimEvidence = {
  files: [
    { path: 'src/checkout.ts', oldPath: null, status: 'M' },
    { path: 'src/idempotency.ts', oldPath: null, status: 'M' },
    { path: 'docs/README.md', oldPath: null, status: 'M' },
  ],
  addedText: addedTextOf('+++ b/src/idempotency.ts\n+export function idempotencyKey(order) {\n-old\n'),
  dependencies: [],
  commands: [
    { command: 'npm test', ok: false, exitCode: 1 },
    { command: 'git status', ok: true, exitCode: null },
    { command: 'npm test -- checkout', ok: true, exitCode: null },
  ],
  hooksRecorded: true,
};

test('each claim is graded against the diff, the dependencies and the recorded commands', () => {
  const graded = gradeClaims(extractClaims(SUMMARY), evidence);
  assert.deepEqual(graded.map((g) => [g.kind, g.grade]), [
    ['vague', 'needs-review'],
    ['file-changed', 'verified'],
    ['file-added', 'needs-review'],
    ['symbol-added', 'verified'],
    ['file-removed', 'unsupported'],
    ['dependency-added', 'unsupported'],
    ['file-changed', 'verified'],
    ['tests-pass', 'verified'],
    ['vague', 'needs-review'],
  ]);
  assert.equal(graded[2].because, '`src/idempotency.ts` is in the diff, but git reports it as modified, not added.');
  assert.equal(graded[6].because, '`docs/README.md` is in the diff (modified).', 'a bare file name matches its path by suffix');
  assert.equal(graded[7].because, 'The last recorded test command, `npm test -- checkout`, succeeded.');
});

test('a test claim is unsupported when the last test failed or none ran, and needs review without a hook record', () => {
  const [pass] = extractClaims('All tests pass.');
  const failedLast = { ...evidence, commands: [{ command: 'pytest -q', ok: false, exitCode: 2 }] };
  assert.equal(gradeClaims([pass], failedLast)[0].because, 'The last recorded test command, `pytest -q`, exited 2.');
  assert.equal(gradeClaims([pass], failedLast)[0].grade, 'unsupported');
  assert.equal(gradeClaims([pass], { ...evidence, commands: [] })[0].grade, 'unsupported');
  assert.equal(gradeClaims([pass], { ...evidence, commands: [], hooksRecorded: false })[0].grade, 'needs-review');
  const [ran] = extractClaims('I ran the tests locally.');
  assert.equal(ran.kind, 'tests-ran');
  assert.equal(gradeClaims([ran], evidence)[0].grade, 'verified');
});

test('negated and questioning sentences make no pass claim; a claim naming two files needs review', () => {
  assert.deepEqual(extractClaims('Two tests still fail on CI.').map((c) => c.kind), []);
  assert.deepEqual(extractClaims('The tests do not pass yet.').map((c) => c.kind), []);
  const [amb] = extractClaims('Updated `index.ts`.');
  const two = { ...evidence, files: [{ path: 'a/index.ts', oldPath: null, status: 'M' }, { path: 'b/index.ts', oldPath: null, status: 'M' }] };
  assert.equal(gradeClaims([amb], two)[0].grade, 'needs-review');
});

test('a dependency that was upgraded rather than added needs review; an added one is verified', () => {
  const [dep] = extractClaims('Installed the `zod` package for validation.');
  assert.equal(dep.kind, 'dependency-added');
  assert.equal(gradeClaims([dep], { ...evidence, dependencies: [{ name: 'zod', change: 'added' }] })[0].grade, 'verified');
  assert.equal(gradeClaims([dep], { ...evidence, dependencies: [{ name: 'zod', change: 'upgraded' }] })[0].grade, 'needs-review');
});

test('an empty message makes no claims, versions and URLs are not paths, and the list is capped', () => {
  assert.deepEqual(extractClaims(''), []);
  assert.deepEqual(extractClaims('Bumped to 1.2.3, see https://example.com/a/b.html').map((c) => c.kind), []);
  const many = Array.from({ length: 40 }, (_, i) => `- Updated \`src/f${i}.ts\``).join('\n');
  assert.equal(extractClaims(many).length, MAX_CLAIMS);
});

test('test commands are recognised by shape across runners', () => {
  for (const c of ['npm test', 'pnpm run test:unit', 'npx vitest run', 'pytest -q tests', 'go test ./...', 'cargo test', 'vendor/bin/phpunit', 'bundle exec rspec', 'node --test src/a.test.ts', 'make check']) {
    assert.equal(isTestCommand(c), true, c);
  }
  for (const c of ['npm run build', 'git status', 'cat test.txt', 'ls tests']) {
    assert.equal(isTestCommand(c), false, c);
  }
});
