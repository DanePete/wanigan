/**
 * The gate's self-test corpus, run the way the app runs it at start.
 *
 * A rule added to POLICY_RULES without a pair of fixtures fails here, before it
 * ships, and so does a fixture that no longer makes its rule fire.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { POLICY_RULES } from './policy-rules.ts';
import { runGateSelfTest, SELFTEST_FIXTURES } from './policy-selftest.ts';

test('every registered rule behaves as specified on both arms', () => {
  const result = runGateSelfTest();
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.uncovered, []);
  assert.equal(result.passed, result.rules);
  assert.equal(result.rules, POLICY_RULES.length);
});

test('every rule has one refusing arm and one allowing arm, and fires in one of them', () => {
  for (const rule of POLICY_RULES) {
    const f = SELFTEST_FIXTURES.find((x) => x.rule === rule.id);
    assert.ok(f, `${rule.id} has fixtures`);
    assert.ok(f.refuse.expect === 'ask' || f.refuse.expect === 'deny', `${rule.id}: the refusing arm refuses or asks`);
    assert.equal(f.allow.expect, 'allow', `${rule.id}: the other arm is allowed`);
    assert.ok(f.refuse.rule === rule.id || f.allow.rule === rule.id, `${rule.id} decides one of its own arms`);
  }
});

test('a broken rule is reported by name, not hidden', () => {
  // A resolver that throws is the cheapest way to break every path rule at once.
  const broken = runGateSelfTest(() => { throw new Error('resolver down'); });
  assert.ok(broken.passed < broken.rules);
  assert.ok(broken.failures.some((f) => f.rule === 'project.write-inside' && /threw: resolver down/.test(f.got)));
});
