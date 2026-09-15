/**
 * Trust levels compiled into auto-mode classifier rules.
 *
 * The two things that must never happen: a list written without "$defaults"
 * first, which would replace the classifier's built-in force-push and
 * exfiltration rules with Wanigan's shorter list; and a key handed to a CLI
 * older than the release that introduced it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileAutoMode } from './auto-mode.ts';

test('every list written starts with "$defaults"', () => {
  for (const trust of ['readonly', 'project'] as const) {
    const c = compileAutoMode(trust, '2.1.271 (Claude Code)');
    assert.equal(c.status, 'injected');
    for (const [key, list] of Object.entries(c.block ?? {})) {
      if (Array.isArray(list)) assert.equal(list[0], '$defaults', `${trust}.${key}`);
    }
    assert.equal(c.block?.allow, undefined, 'no trust level adds allow rules');
  }
});

test('Read only classifies all shell and soft-denies writes; Project soft-denies pushes, deploys and credential reads', () => {
  const ro = compileAutoMode('readonly', '2.1.271');
  assert.equal(ro.block?.classifyAllShell, true);
  assert.ok(ro.block?.soft_deny?.some((r) => /Creating, editing, moving or deleting any file/.test(r)));
  const pr = compileAutoMode('project', '2.1.271');
  assert.equal(pr.block?.classifyAllShell, undefined);
  const soft = pr.block?.soft_deny?.join('\n') ?? '';
  assert.match(soft, /Pushing to any git remote/);
  assert.match(soft, /Deploying, publishing or releasing/);
  assert.match(soft, /Reading credential files/);
});

test('Trusted writes nothing and says the built-in rules apply', () => {
  const t = compileAutoMode('trusted', '2.1.271');
  assert.equal(t.status, 'defaults');
  assert.equal(t.block, null);
});

test('version gates: nothing before 2.1.118, no classifyAllShell before 2.1.193, nothing without a version', () => {
  assert.equal(compileAutoMode('project', '2.1.117 (Claude Code)').block, null);
  assert.match(compileAutoMode('project', '2.1.117 (Claude Code)').note, /Not verified on CLI 2\.1\.117/);
  assert.equal(compileAutoMode('project', '2.1.118').status, 'injected');
  assert.equal(compileAutoMode('readonly', '2.1.192').block?.classifyAllShell, undefined);
  assert.match(compileAutoMode('readonly', '2.1.192').note, /classifyAllShell arrived in 2\.1\.193/);
  assert.equal(compileAutoMode('readonly', '2.1.193').block?.classifyAllShell, true);
  assert.equal(compileAutoMode('readonly', null).status, 'not-verified');
  assert.equal(compileAutoMode('readonly', 'garbage').block, null);
});
