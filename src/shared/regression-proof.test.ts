/**
 * Regression proofs. The subject is the overstatement: "proved" is said only
 * when the command ran at the base commit, failed there on its own terms, and
 * passed at head. Everything else is named for what it is.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyProof, couldNotRun, outputTail, PROOF_VERDICT_LABEL, validateProofCommand, type ProofRun } from './regression-proof.ts';

const run = (exitCode: number | null, over: Partial<ProofRun> = {}): ProofRun =>
  ({ commit: 'abc', exitCode, durationMs: 10, outputTail: '', notRun: null, ...over });

test('fails before and passes after is proved', () => {
  const r = classifyProof(run(1, { outputTail: 'AssertionError: expected 3 to equal 4' }), run(0));
  assert.equal(r.verdict, 'proved');
  assert.equal(r.because, 'The command exited 1 at the base commit and 0 at head.');
});

test('passing before is not a regression proof, and failing after is still failing', () => {
  assert.equal(classifyProof(run(0), run(0)).verdict, 'not-a-regression-proof');
  assert.equal(classifyProof(run(0), run(1)).verdict, 'not-a-regression-proof', 'passing before already disqualifies it');
  const still = classifyProof(run(1), run(2));
  assert.equal(still.verdict, 'still-failing');
  assert.equal(still.because, 'The command exited 1 at the base commit and 2 at head.');
});

test('a run before that never reached the code is a proof gap, said in words', () => {
  assert.equal(classifyProof(run(null, { notRun: 'the scratch worktree could not be created: bad revision' }), run(0)).verdict, 'could-not-run-before');
  assert.equal(classifyProof(run(null), run(0)).because, 'At the base commit the command did not exit on its own (it was killed or timed out).');
  assert.equal(classifyProof(run(127), run(0)).verdict, 'could-not-run-before');
  assert.equal(couldNotRun(run(1, { outputTail: "Error: Cannot find module 'vitest'" })), 'the output says a Node module was missing');
  assert.equal(couldNotRun(run(1, { outputTail: 'ModuleNotFoundError: No module named "app"' })), 'the output says a Python module was missing');
  assert.equal(couldNotRun(run(1, { outputTail: 'npm error Missing script: "test:cart"' })), 'the output says the npm script does not exist at that commit');
  assert.equal(couldNotRun(run(1, { outputTail: 'zsh: no such file or directory: ./scripts/check.sh' })), 'the output says the shell could not find a command or script');
});

test('a test that fails on a missing file of its own is a real failure, not a gap', () => {
  assert.equal(couldNotRun(run(1, { outputTail: "Error: ENOENT: no such file or directory, open 'out/receipt.json'" })), null);
  assert.equal(classifyProof(run(1, { outputTail: 'FAIL receipt: No such file or directory' }), run(0)).verdict, 'proved');
});

test('a run after that could not run is its own gap, never a pass', () => {
  assert.equal(classifyProof(run(1), run(null)).verdict, 'could-not-run-after');
  assert.equal(classifyProof(run(1), run(1, { outputTail: 'bash: vitest: command not found' })).verdict, 'could-not-run-after');
});

test('labels, tails and command validation', () => {
  assert.equal(PROOF_VERDICT_LABEL['could-not-run-before'], 'could not run before');
  assert.equal(outputTail('short'), 'short');
  const long = Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n');
  const tail = outputTail(long, 100);
  assert.ok(tail.length <= 100);
  assert.ok(tail.startsWith('line '), 'cut at a line start');
  assert.deepEqual(validateProofCommand('  npm test -- cart  '), { ok: true, command: 'npm test -- cart' });
  assert.equal(validateProofCommand('').ok, false);
  assert.equal(validateProofCommand(42).ok, false);
  assert.equal(validateProofCommand('npm test\nrm -rf x').ok, false);
  assert.equal(validateProofCommand('x'.repeat(2001)).ok, false);
});
