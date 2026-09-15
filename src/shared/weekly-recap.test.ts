/**
 * The weekly recap counts rows inside the week and nothing else, never prints
 * a zero where nothing was recorded, and states its merge rule in the export.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRecap, recapMarkdown, weekBounds, type RecapInput } from './weekly-recap.ts';

// Wednesday 16 Sep 2026, 15:00 UTC.
const NOW = Date.UTC(2026, 8, 16, 15);
const { start, end } = weekBounds(NOW, 0, 0);
const H = 3_600_000;

const base = (over: Partial<RecapInput> = {}): RecapInput => ({
  projectName: 'storefront', start, end, sessions: [], outcomeMethod: 'git', worktrees: [],
  goalsAccepted: [], gateRuns: [], cost: null, operatorRuns: 0, ...over,
});

test('the week runs Monday to Monday in local time', () => {
  assert.equal(new Date(start).toISOString(), '2026-09-14T00:00:00.000Z');
  assert.equal(end - start, 7 * 24 * H);
  const last = weekBounds(NOW, 1, 0);
  assert.equal(new Date(last.start).toISOString(), '2026-09-07T00:00:00.000Z');
  // Chicago is UTC−5 in September: getTimezoneOffset() reports +300.
  const chicago = weekBounds(NOW, 0, 300);
  assert.equal(new Date(chicago.start).toISOString(), '2026-09-14T05:00:00.000Z');
  // A Sunday night still belongs to the week that started six days earlier.
  const sunday = weekBounds(Date.UTC(2026, 8, 20, 23), 0, 0);
  assert.equal(new Date(sunday.start).toISOString(), '2026-09-14T00:00:00.000Z');
});

test('sessions, conversations, merges and half-finished work are counted from the week alone', () => {
  const r = buildRecap(base({
    sessions: [
      { id: 's1', conversationId: 'c1', title: 'Fix rounding', providerId: 'claude', startedAt: start + 2 * H, endedAt: start + 3 * H, exitCode: 0, worktree: '/wt/a' },
      { id: 's2', conversationId: 'c1', title: 'Fix rounding', providerId: 'claude', startedAt: start + 4 * H, endedAt: start + 5 * H, exitCode: 0, worktree: '/wt/a' },
      { id: 's3', conversationId: 'c2', title: 'Search endpoint', providerId: 'codex', startedAt: start + 6 * H, endedAt: start + 9 * H, exitCode: 1, worktree: '/wt/b' },
      { id: 's4', conversationId: 'c3', title: 'Merged work', providerId: 'claude', startedAt: start + 10 * H, endedAt: start + 11 * H, exitCode: 0, worktree: '/wt/c' },
      { id: 'old', conversationId: 'c0', title: 'Last week', providerId: 'claude', startedAt: start - 30 * H, endedAt: start - 29 * H, exitCode: 0, worktree: '/wt/old' },
    ],
    worktrees: [
      { path: '/wt/a', branch: 'wanigan/a', sessionId: 's1', createdAt: start + H, removedAt: null, outcome: 'open' },
      { path: '/wt/b', branch: 'wanigan/b', sessionId: 's3', createdAt: start + H, removedAt: start + 10 * H, outcome: 'discarded' },
      { path: '/wt/c', branch: 'wanigan/c', sessionId: 's4', createdAt: start + H, removedAt: null, outcome: 'merged' },
      { path: '/wt/old', branch: 'wanigan/old', sessionId: 'old', createdAt: start - 40 * H, removedAt: null, outcome: 'no-commits' },
    ],
    goalsAccepted: [{ title: 'Checkout', at: start + 20 * H }, { title: 'Old goal', at: start - H }],
    gateRuns: [
      { startedAt: start + H, status: 'failed', failedCommands: ['npm test'] },
      { startedAt: start + 2 * H, status: 'passed', failedCommands: [] },
      { startedAt: start - H, status: 'failed', failedCommands: ['old'] },
    ],
    cost: { usd: 3.456, sessionsReporting: 2 },
    operatorRuns: 2,
  }));
  assert.equal(r.sessionsRun, 4);
  assert.equal(r.conversations, 3, 'a resumed conversation is one conversation');
  assert.equal(r.merged, 1);
  assert.equal(r.discarded, 1);
  assert.deepEqual(r.goalsAccepted.map((g) => g.title), ['Checkout']);
  assert.equal(r.gatesFailed, 1);
  assert.equal(r.gatesRun, 2);
  assert.deepEqual(r.failedCommands, ['npm test']);
  assert.deepEqual(r.halfFinished.map((h) => h.sessionId), ['s2', 's1'], 'both exits of the open conversation; the merged and the removed ones are not half-finished');
  assert.deepEqual(r.worktreesOpen.map((w) => w.path), ['/wt/a', '/wt/old'], 'open worktrees are a standing fact, not bound to the week; a merged one is not open work');
  assert.equal(r.nothingRecorded, false);
});

test('with no outcome record, merges read "not recorded" rather than zero', () => {
  const r = buildRecap(base({
    outcomeMethod: 'not-recorded',
    sessions: [{ id: 's1', conversationId: null, title: null, providerId: 'claude', startedAt: start + H, endedAt: start + 2 * H, exitCode: 0, worktree: '/wt/a' }],
    worktrees: [{ path: '/wt/a', branch: 'wanigan/a', sessionId: 's1', createdAt: start, removedAt: null, outcome: 'unknown' }],
  }));
  assert.equal(r.merged, null);
  assert.equal(r.discarded, null);
  assert.equal(r.halfFinished.length, 1);
  const md = recapMarkdown(r, NOW);
  assert.match(md, /\| Work merged \| not recorded \|/);
  assert.match(md, /Merge outcomes: not recorded\./);
  assert.match(md, /Cost \| not observed/);
});

test('an empty week says so, and the Markdown states its rules and escapes titles', () => {
  const empty = buildRecap(base());
  assert.equal(empty.nothingRecorded, true);
  assert.match(recapMarkdown(empty, NOW), /Nothing was recorded for this project in this week\./);
  const r = buildRecap(base({
    sessions: [{ id: 's1', conversationId: null, title: 'Fix *all* the | pipes <script>', providerId: 'claude', startedAt: start + H, endedAt: start + 2 * H, exitCode: 0, worktree: '/wt/a' }],
    worktrees: [{ path: '/wt/a', branch: 'wanigan/a', sessionId: 's1', createdAt: start, removedAt: null, outcome: 'open' }],
    cost: { usd: 1.5, sessionsReporting: 1 },
  }));
  const md = recapMarkdown(r, NOW);
  assert.match(md, /^# storefront — week of 2026-09-14/);
  assert.match(md, /No model wrote any of this\./);
  assert.match(md, /read from git: merged means the branch tip is contained/);
  assert.match(md, /Fix \\\*all\\\* the \\\| pipes \\<script\\>/);
  assert.match(md, /\$1\.50 reported by 1 session \|/);
});
