/**
 * Review order and test alarms. The diffs below are shaped exactly as `git
 * diff` prints them. The subject is the alarm: each one names the line that
 * raised it, and a change that merely touches a test file raises nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileKind, orderForReview, splitPatchByFile, testAlarms } from './review-order.ts';

test('paths are classed as tests, schema or code across the common layouts', () => {
  for (const p of ['src/cart.test.ts', 'app/__tests__/cart.js', 'tests/test_cart.py', 'pkg/cart_test.go',
    'spec/models/cart_spec.rb', 'src/test/java/CartTest.java', 'src/__snapshots__/cart.test.ts.snap', 'cypress/e2e/buy.cy.ts']) {
    assert.equal(fileKind(p), 'test', p);
  }
  for (const p of ['db/migrate/20260101_add_tax.rb', 'migrations/0003_orders.sql', 'prisma/schema.prisma',
    'src/graphql/schema.graphql', 'alembic/versions/abc.py', 'database/migrations/2026_add.php']) {
    assert.equal(fileKind(p), 'schema', p);
  }
  for (const p of ['src/cart.ts', 'README.md', 'src/testing-utils.ts', 'contest/entry.ts', 'package.json']) {
    assert.equal(fileKind(p), 'other', p);
  }
});

test('review order puts tests first, then schema, then code, each in path order; path order ignores kind', () => {
  const files = [{ path: 'src/b.ts' }, { path: 'migrations/1.sql' }, { path: 'src/a.test.ts' }, { path: 'src/a.ts' }, { path: 'tests/z.py' }];
  assert.deepEqual(orderForReview(files).map((f) => f.path), ['src/a.test.ts', 'tests/z.py', 'migrations/1.sql', 'src/a.ts', 'src/b.ts']);
  assert.deepEqual(orderForReview(files, 'path').map((f) => f.path), ['migrations/1.sql', 'src/a.test.ts', 'src/a.ts', 'src/b.ts', 'tests/z.py']);
  assert.deepEqual(orderForReview([]), []);
});

const weakened = [
  'diff --git a/src/cart.test.ts b/src/cart.test.ts',
  'index 1111111..2222222 100644',
  '--- a/src/cart.test.ts',
  '+++ b/src/cart.test.ts',
  '@@ -10,5 +10,5 @@ describe(\'cart\', () => {',
  '   it(\'totals\', () => {',
  '-    expect(total(items)).toBe(42);',
  '-    expect(tax(items)).toBe(4.2);',
  '+    expect(total(items)).toBeGreaterThan(0);',
  '   });',
  '-  it(\'rounds\', () => {',
  '+  it.skip(\'rounds\', () => {',
  '+  it.only(\'discounts\', () => {',
  '',
].join('\n');

test('a test file that loses more assertion lines than it gains, and gains a skip and an only, raises each with its line', () => {
  const alarms = testAlarms('src/cart.test.ts', 'M', weakened);
  assert.deepEqual(alarms.map((a) => [a.kind, a.label, a.line]), [
    ['assertions-removed', '2 assertion lines removed, 1 added', 11],
    ['skip-added', 'test skipped', 13],
    ['only-added', 'test focused with .only', 14],
  ]);
  assert.equal(alarms[0].text, '-    expect(total(items)).toBe(42);');
});

test('the other runners\' skips are recognised: pytest, go and xit', () => {
  const patch = (file: string, line: string) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1,1 +1,2 @@\n context\n+${line}\n`;
  assert.equal(testAlarms('tests/test_a.py', 'M', patch('tests/test_a.py', '@pytest.mark.skip(reason="flaky")'))[0]?.kind, 'skip-added');
  assert.equal(testAlarms('a_test.go', 'M', patch('a_test.go', '\tt.Skip("later")'))[0]?.kind, 'skip-added');
  assert.equal(testAlarms('a.spec.js', 'M', patch('a.spec.js', "xit('works', () => {})"))[0]?.kind, 'skip-added');
});

test('an ordinary test change, a code file with expect-shaped text, and an empty patch raise nothing', () => {
  const ordinary = 'diff --git a/a.test.ts b/a.test.ts\n--- a/a.test.ts\n+++ b/a.test.ts\n@@ -1,2 +1,3 @@\n it(\'x\', () => {\n+  expect(y).toBe(2);\n });\n';
  assert.deepEqual(testAlarms('a.test.ts', 'M', ordinary), []);
  const code = 'diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-assert(ok);\n+it.only(\'no\');\n';
  assert.deepEqual(testAlarms('src/x.ts', 'M', code), [], 'alarms are about test files');
  assert.deepEqual(testAlarms('a.test.ts', 'M', ''), []);
});

test('a deleted test file and a rewritten snapshot are alarms; a new snapshot is not', () => {
  assert.deepEqual(testAlarms('tests/test_cart.py', 'D', '').map((a) => a.kind), ['test-deleted']);
  const snap = 'diff --git a/__snapshots__/c.snap b/__snapshots__/c.snap\n--- a/__snapshots__/c.snap\n+++ b/__snapshots__/c.snap\n@@ -1,2 +1,2 @@\n exports[`c`] = `\n-<div>old</div>\n+<div>new</div>\n';
  const rewritten = testAlarms('__snapshots__/c.snap', 'M', snap);
  assert.equal(rewritten[0]?.kind, 'snapshot-rewritten');
  assert.equal(rewritten[0]?.line, 2);
  assert.deepEqual(testAlarms('__snapshots__/c.snap', 'A', snap.replace('-<div>old</div>\n', '')), []);
  assert.equal(testAlarms('__snapshots__/c.snap', 'D', '')[0]?.label, 'snapshot deleted');
});

test('a multi-file patch splits by file, keeping a deleted file under its old name', () => {
  const patch = [
    'diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -1 +1 @@', '-x', '+y',
    'diff --git a/gone.ts b/gone.ts', 'deleted file mode 100644', '--- a/gone.ts', '+++ /dev/null', '@@ -1 +0,0 @@', '-z',
    '',
  ].join('\n');
  const parts = splitPatchByFile(patch);
  assert.deepEqual([...parts.keys()], ['a.ts', 'gone.ts']);
  assert.match(parts.get('gone.ts') ?? '', /deleted file mode/);
  assert.equal(splitPatchByFile('').size, 0);
});
