/**
 * Instruction files beside the pinned config: which files, the diff, and what a launch does.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describeFiles, diffInstructions, instructionDecision, instructionDigest, isInstructionPath, lineDiff } from './instruction-pins.ts';

const hash = (t: string) => createHash('sha256').update(t).digest('hex');

test('which files are instructions', () => {
  for (const p of ['CLAUDE.md', 'CLAUDE.local.md', '.claude/rules/testing.md', '.claude/rules/api/errors.md', 'AGENTS.md', 'AGENTS.override.md', 'packages/web/AGENTS.md', 'services/api/AGENTS.override.md']) {
    assert.ok(isInstructionPath(p), p);
  }
  for (const p of ['docs/CLAUDE.md', 'README.md', '.claude/settings.json', '.claude/rules/', 'AGENTS.md.bak', 'notAGENTS.md']) {
    assert.ok(!isInstructionPath(p), p);
  }
});

test('the digest is order-free and moves with content and with an unreadable file', () => {
  const a = describeFiles([{ path: 'AGENTS.md', text: 'one\n' }, { path: 'CLAUDE.md', text: '@AGENTS.md\n' }], hash);
  const b = describeFiles([{ path: 'CLAUDE.md', text: '@AGENTS.md\n' }, { path: 'AGENTS.md', text: 'one\n' }], hash);
  assert.equal(instructionDigest(a, [], hash), instructionDigest(b, [], hash));
  assert.notEqual(instructionDigest(a, [], hash), instructionDigest(a, ['.claude/rules/huge.md'], hash));
  assert.deepEqual(a.map((f) => [f.path, f.lines, f.bytes]), [['AGENTS.md', 1, 4], ['CLAUDE.md', 1, 11]]);
});

test('line diff with context, and a gap between distant changes', () => {
  const before = ['# Rules', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'end'].join('\n');
  const after = ['# Rules', 'a', 'B', 'c', 'd', 'e', 'f', 'g', 'h', 'end', 'Never push to main.'].join('\n');
  const d = lineDiff(before, after);
  assert.equal(d.added, 2);
  assert.equal(d.removed, 1);
  assert.deepEqual(d.lines.map((l) => l.kind), ['ctx', 'ctx', 'del', 'add', 'ctx', 'ctx', 'gap', 'ctx', 'ctx', 'add']);
  assert.equal(d.truncated, false);
});

test('diffing two sets names added, changed and removed files', () => {
  const out = diffInstructions(
    [{ path: 'AGENTS.md', text: 'x\n' }, { path: 'CLAUDE.local.md', text: 'mine\n' }],
    [{ path: 'AGENTS.md', text: 'y\n' }, { path: 'packages/api/AGENTS.md', text: 'api rules\n' }],
  );
  assert.deepEqual(out.map((f) => [f.path, f.status, f.added, f.removed]), [
    ['AGENTS.md', 'changed', 1, 1], ['CLAUDE.local.md', 'removed', 0, 1], ['packages/api/AGENTS.md', 'added', 1, 0],
  ]);
});

test('a launch: show-only by default, asks only where the project opted in, and never advances the baseline unattended', () => {
  const changed = { state: 'changed' as const, askOnChange: false, diff: diffInstructions([{ path: 'AGENTS.md', text: 'x' }], [{ path: 'AGENTS.md', text: 'y' }]), files: [] };
  assert.deepEqual(instructionDecision({ ...changed, state: 'same' }, true), { allowed: true, record: null, note: null });
  const shown = instructionDecision(changed, true);
  assert.ok(shown.allowed && shown.record === 'shown' && /instructions \(not executable\), changed since the last trusted launch: AGENTS.md/.test(shown.note ?? ''));
  const unattended = instructionDecision(changed, false);
  assert.ok(unattended.allowed && unattended.record === null);
  const asks = instructionDecision({ ...changed, askOnChange: true }, true);
  assert.ok(!asks.allowed && /accept it, then launch again/.test(asks.reason));
  const headless = instructionDecision({ ...changed, askOnChange: true }, false);
  assert.ok(!headless.allowed && /nobody to accept/.test(headless.reason));
  const first = instructionDecision({ ...changed, state: 'first-use', files: [{ path: 'AGENTS.md', sha256: 'x', bytes: 1, lines: 1 }] }, true);
  assert.ok(first.allowed && first.record === 'first-use');
});
