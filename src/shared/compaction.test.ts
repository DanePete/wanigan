/**
 * Compaction boundaries from the transcript and the hook bus.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boundaryOf, compactionMarks } from './compaction.ts';

test('a real compact_boundary line is read; anything else is not', () => {
  // The shape of a line from a local Claude Code 2.1.248 transcript, trimmed.
  const line = {
    parentUuid: null, logicalParentUuid: '0f511c16', isSidechain: false, type: 'system', subtype: 'compact_boundary',
    content: 'Conversation compacted', level: 'info',
    compactMetadata: { trigger: 'auto', preTokens: 1010282, postTokens: 17199, cumulativeDroppedTokens: 993083, durationMs: 109358 },
    uuid: '80cd47d2', timestamp: '2026-08-28T17:11:16.403Z', version: '2.1.248',
  };
  assert.deepEqual(boundaryOf(line), { at: Date.parse('2026-08-28T17:11:16.403Z'), trigger: 'auto', preTokens: 1010282, postTokens: 17199 });
  assert.deepEqual(boundaryOf({ ...line, compactMetadata: undefined }), { at: Date.parse('2026-08-28T17:11:16.403Z'), trigger: null, preTokens: null, postTokens: null });
  assert.equal(boundaryOf({ type: 'system', subtype: 'turn_duration', timestamp: '2026-08-28T17:11:16.403Z' }), null);
  assert.equal(boundaryOf({ type: 'user', message: {} }), null);
  assert.equal(boundaryOf({ ...line, timestamp: 'not a date' }), null);
});

test('marks: a hook pair takes the transcript’s token counts; each source alone still draws a divider', () => {
  const t0 = Date.parse('2026-09-14T10:00:00Z');
  const marks = compactionMarks([
    { id: 1, at: t0, event: 'PreCompact', summary: 'auto' },
    { id: 2, at: t0 + 90_000, event: 'PostCompact', summary: 'auto' },
    { id: 7, at: t0 + 3_600_000, event: 'PreCompact', summary: 'manual' },
  ], [
    { at: t0 + 88_000, trigger: 'auto', preTokens: 180_000, postTokens: 21_000 },
    { at: t0 + 7_200_000, trigger: 'manual', preTokens: 90_000, postTokens: 9_000 },
  ]);
  assert.deepEqual(marks.map((m) => [m.source, m.eventId, m.trigger, m.preTokens]), [
    ['transcript', null, 'manual', 90_000],
    ['hook', 7, 'manual', null],
    ['hook+transcript', 2, 'auto', 180_000],
  ]);
  assert.deepEqual(compactionMarks([], []), []);
});
