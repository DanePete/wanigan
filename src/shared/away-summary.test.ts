/**
 * "Since you last looked" counts rows, and only rows inside the window.
 *
 * The guards are the ways a digest like this quietly lies: counting the edit
 * made just before you left, calling a failed write a changed file, showing a
 * recap Claude wrote last week as if it were about this absence, and printing
 * "$0.00" for a session that reports no cost at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAwaySummary, recapFromTranscriptText } from './away-summary.ts';
import { AWAY_MIN_MS, nextNeedingYou, outsideWriter, snoozeUntil, wakesSnooze } from './session-triage.ts';
import type { Attention, SessionEvent } from './types.ts';

const SINCE = 1_800_000_000_000;
const UNTIL = SINCE + 20 * 60_000;
let id = 0;
const ev = (event: string, at: number, over: Partial<SessionEvent> = {}): SessionEvent => ({
  id: ++id, sessionId: 's', at, event, toolName: null, summary: null, durationMs: null, ok: null, paths: [], ...over,
});

const base = { sessionId: 's', since: SINCE, until: UNTIL, checkpoints: [], costDeltaUsd: null, verdict: null, recap: null };

test('only events inside the window are counted, and only successful writes are changed files', () => {
  const summary = buildAwaySummary({ ...base, events: [
    ev('PostToolUse', SINCE - 1, { toolName: 'Edit', ok: true, paths: ['/r/before.ts'] }),
    ev('PostToolUse', SINCE + 1000, { toolName: 'Edit', ok: true, paths: ['/r/a.ts'] }),
    ev('PostToolUse', SINCE + 2000, { toolName: 'Write', ok: true, paths: ['/r/a.ts', '/r/b.ts'] }),
    ev('PostToolUse', SINCE + 2500, { toolName: 'Edit', ok: false, paths: ['/r/refused.ts'] }),
    ev('PostToolUse', SINCE + 2600, { toolName: 'Read', ok: true, paths: ['/r/read.ts'] }),
    ev('Stop', SINCE + 3000),
    ev('Stop', UNTIL + 1),
  ] });
  assert.equal(summary.turnsCompleted, 1);
  assert.deepEqual(summary.filesChanged, { count: 2, paths: ['/r/a.ts', '/r/b.ts'], source: 'hooks' });
  assert.equal(summary.nothingRecorded, false);
});

test('failed commands are the newest three Bash failures, with the total counted', () => {
  const fails = [1, 2, 3, 4].map((n) => ev('PostToolUseFailure', SINCE + n * 1000, { toolName: 'Bash', summary: `cmd ${n}`, ok: false }));
  const summary = buildAwaySummary({ ...base, events: [...fails, ev('PostToolUseFailure', SINCE + 9000, { toolName: 'Read', ok: false })] });
  assert.equal(summary.failedTotal, 4);
  assert.deepEqual(summary.failedCommands.map((c) => c.summary), ['cmd 4', 'cmd 3', 'cmd 2']);
});

test('checkpoints stand in only when no hook named a file, and say so', () => {
  const summary = buildAwaySummary({ ...base, events: [], checkpoints: [
    { id: 1, sessionId: 's', turn: 1, kind: 'turn-end', at: SINCE + 5000, repoRoot: '/r', commitHash: 'x', treeHash: 'y', filesChanged: 3, status: 'ok', detail: null },
    { id: 2, sessionId: 's', turn: 0, kind: 'session-start', at: SINCE - 5000, repoRoot: '/r', commitHash: 'x', treeHash: 'y', filesChanged: 9, status: 'ok', detail: null },
  ] });
  assert.deepEqual(summary.filesChanged, { count: 3, paths: [], source: 'checkpoints' });
});

test('an empty absence says nothing was recorded, and an unreported cost stays null rather than zero', () => {
  const summary = buildAwaySummary({ ...base, events: [], verdict: { kind: 'idle', label: 'Idle' } });
  assert.equal(summary.nothingRecorded, true);
  assert.equal(summary.costDeltaUsd, null);
  assert.deepEqual(summary.verdict, { kind: 'idle', label: 'Idle' });
});

test("Claude's recap is read from the transcript only when it was written during this absence", () => {
  const line = (at: number, content: string) => JSON.stringify({ type: 'system', subtype: 'away_summary', content, timestamp: new Date(at).toISOString() });
  const text = ['{"cut mid-record', line(SINCE - 60_000, 'old recap'), line(SINCE + 60_000, 'Goal: fix the  checkout'), '{"type":"user"}'].join('\n');
  assert.deepEqual(recapFromTranscriptText(text, SINCE), { text: 'Goal: fix the checkout', at: SINCE + 60_000 });
  assert.equal(recapFromTranscriptText(line(SINCE - 1, 'x'), SINCE), null);
  const summary = buildAwaySummary({ ...base, events: [], recap: { text: 'late', at: UNTIL + 5 } });
  assert.equal(summary.recap, null);
});

test('snoozes end at the preset, and tomorrow means the next morning at nine rather than a day later', () => {
  const now = new Date(2026, 8, 14, 23, 50).getTime();
  assert.equal(snoozeUntil('15m', now), now + 15 * 60_000);
  assert.equal(snoozeUntil('3h', now), now + 3 * 3_600_000);
  const tomorrow = new Date(snoozeUntil('tomorrow', now));
  assert.deepEqual([tomorrow.getDate(), tomorrow.getHours(), tomorrow.getMinutes()], [15, 9, 0]);
});

test('only a new prompt, failure or denial wakes a snooze; one that was already there does not', () => {
  assert.equal(wakesSnooze({ kind: 'permission', since: 200 }, 100), true);
  assert.equal(wakesSnooze({ kind: 'error', since: 50 }, 100), false);
  assert.equal(wakesSnooze({ kind: 'finished', since: 200 }, 100), false);
  assert.equal(wakesSnooze({ kind: 'idle', since: 200 }, 100), false);
});

const a = (sessionId: string, kind: Attention['kind'], snoozed = false): Attention => ({
  sessionId, kind, transitionId: sessionId, since: 0, label: kind, detail: null, tool: null,
  ...(snoozed ? { helper: { snoozedUntil: 9 } } : {}),
});

test('the jump chord walks the ranked queue, skips snoozed and working sessions, and wraps', () => {
  const queue = [a('s1', 'permission'), a('s2', 'error', true), a('s3', 'finished'), a('s4', 'working')];
  assert.equal(nextNeedingYou(queue, null), 's1');
  assert.equal(nextNeedingYou(queue, 's1'), 's3');
  assert.equal(nextNeedingYou(queue, 's3'), 's1');
  assert.equal(nextNeedingYou(queue, 's4'), 's1');
  assert.equal(nextNeedingYou([a('s4', 'working'), a('s2', 'error', true)], 's4'), null);
});

test('a transcript written moments ago by nobody Wanigan runs is an outside writer; its own writes are not', () => {
  const now = 1_000_000;
  assert.equal(outsideWriter(now - 5_000, now, false), true);
  assert.equal(outsideWriter(now - 5_000, now, true), false);
  assert.equal(outsideWriter(now - 60_000, now, false), false);
  assert.equal(outsideWriter(null, now, false), false);
  assert.equal(AWAY_MIN_MS, 120_000);
});
