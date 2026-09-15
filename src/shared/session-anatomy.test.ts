/**
 * The anatomy calculator: each measure held to its definition, and to saying
 * "not recorded" instead of zero when the evidence was never collected.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionAnatomy, type AnatomyEvent } from './session-anatomy.ts';

const s = 1_000;
const ev = (at: number, event: string, tool: string | null = null, durationMs: number | null = null): AnatomyEvent => ({ at: s * at, event, tool, durationMs });
const base = { startedAt: 0, endedAt: 600 * s, now: 700 * s, requestContextTokens: [120, 90_000, 40_000], askedFor: { compaction: true, subagents: true } };

test('orientation runs to the first completed edit, and work sums measured edit and command time', () => {
  const a = sessionAnatomy({ ...base, events: [
    ev(10, 'PostToolUse', 'Read', 50), ev(95, 'PostToolUse', 'Edit', 400), ev(120, 'PostToolUse', 'Bash', 2_000), ev(130, 'PostToolUse', 'Write', null),
  ] });
  assert.deepEqual(a.orientationMs, { status: 'observed', value: 95_000, note: null });
  assert.equal(a.editsAndCommandsMs.value, 2_400);
  assert.match(a.editsAndCommandsMs.note ?? '', /1 calls carried no duration/);
});

test('waiting is permission time plus turn-end to next prompt, and is labelled inferred', () => {
  const a = sessionAnatomy({ ...base, events: [
    ev(10, 'PermissionRequest', 'Bash'), ev(40, 'PostToolUse', 'Bash', 10), ev(100, 'Stop'), ev(160, 'UserPromptSubmit'), ev(300, 'Stop'),
  ] });
  assert.equal(a.waitingMs.status, 'inferred');
  assert.equal(a.waitingMs.value, 30_000 + 60_000);
});

test('a question still open on a live session counts to now; a finished turn with no next prompt does not', () => {
  const a = sessionAnatomy({ ...base, endedAt: null, events: [ev(10, 'Stop'), ev(600, 'PermissionRequest', 'Bash')] });
  assert.equal(a.waitingMs.value, 100_000);
});

test('peak context, compactions and subagents are observed counts', () => {
  const a = sessionAnatomy({ ...base, events: [ev(1, 'PreCompact'), ev(2, 'PostCompact'), ev(3, 'SubagentStart'), ev(4, 'SubagentStart'), ev(5, 'SubagentStop')] });
  assert.equal(a.peakContextTokens.value, 90_000);
  assert.equal(a.compactions.value, 1);
  assert.equal(a.subagents.value, 2);
});

test('evidence never collected reads as not recorded, never as zero', () => {
  const a = sessionAnatomy({ ...base, events: [], requestContextTokens: [], askedFor: { compaction: false, subagents: false } });
  for (const m of [a.orientationMs, a.editsAndCommandsMs, a.waitingMs, a.peakContextTokens, a.compactions, a.subagents]) {
    assert.equal(m.status, 'not-recorded');
    assert.equal(m.value, null);
  }
});
