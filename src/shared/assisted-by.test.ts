/**
 * Assisted-by trailers, the pure half. The subject is "does a commit claim help
 * nobody observed": a trailer for a session that ran somewhere else, or ended
 * before the last commit, is attribution invented after the fact.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODEL_NOT_RECORDED, assistedByLine, assistedByTrailers, ranInWindow, sameTrailers, type AssistedSessionRow } from './assisted-by.ts';

const LAST_COMMIT = 1_757_000_000_000;
const NOW = LAST_COMMIT + 3_600_000;
const window = { since: LAST_COMMIT, until: NOW };

function row(over: Partial<AssistedSessionRow>): AssistedSessionRow {
  return {
    harnessId: 'claude-code', providerId: 'claude', model: 'claude-opus-5', origin: 'wanigan', inRepository: true,
    startedAt: LAST_COMMIT + 60_000, endedAt: LAST_COMMIT + 120_000, ...over,
  };
}

test('one line per distinct agent and model, sorted, from sessions that ran here since the last commit', () => {
  const out = assistedByTrailers([
    row({}),
    row({ startedAt: LAST_COMMIT + 200_000, endedAt: null }),                   // same agent and model, still running
    row({ harnessId: 'codex', providerId: 'codex', model: 'gpt-5-codex' }),
    row({ model: 'claude-sonnet-5', startedAt: LAST_COMMIT - 900_000, endedAt: LAST_COMMIT + 1 }), // started before, ended after
  ], window);
  assert.deepEqual(out, {
    trailers: ['Assisted-by: Claude Code (claude-opus-5)', 'Assisted-by: Claude Code (claude-sonnet-5)', 'Assisted-by: Codex (gpt-5-codex)'],
    sessions: 4,
  });
});

test('sessions elsewhere, before the window, after it, or not started by Wanigan are not counted', () => {
  const out = assistedByTrailers([
    row({ inRepository: false }),
    row({ startedAt: LAST_COMMIT - 900_000, endedAt: LAST_COMMIT - 1 }),
    row({ startedAt: NOW + 1, endedAt: null }),
    row({ origin: 'observed' }),
  ], window);
  assert.deepEqual(out, { trailers: [], sessions: 0 });
});

test('a branch with no commits counts every recorded session that started before now', () => {
  assert.equal(ranInWindow({ startedAt: 1, endedAt: 2 }, { since: null, until: NOW }), true);
  assert.equal(ranInWindow({ startedAt: NOW + 5, endedAt: null }, { since: null, until: NOW }), false);
});

test('an unrecorded model says so rather than guessing, and an older row falls back to its provider id', () => {
  assert.deepEqual(assistedByTrailers([row({ model: null, harnessId: null, providerId: 'glm' })], window).trailers,
    [`Assisted-by: glm (${MODEL_NOT_RECORDED})`]);
});

test('nothing in a row can add a line, a parenthesis or a second trailer to the message', () => {
  const line = assistedByLine('Claude Code\nSigned-off-by: someone', 'opus)\n\nCo-authored-by: x (y');
  assert.equal(line.includes('\n'), false);
  assert.equal(line.split('(').length, 2);
  assert.equal(line, 'Assisted-by: Claude CodeSigned-off-by someone (opusCo-authored-by:xy)');
  assert.equal(assistedByLine('', ''), `Assisted-by: unknown agent (${MODEL_NOT_RECORDED})`);
  assert.equal(assistedByLine('Codex', 'claude-opus-5[1m]'), 'Assisted-by: Codex (claude-opus-5[1m])');
});

test('trailer lists compare by content and order', () => {
  assert.equal(sameTrailers(['a', 'b'], ['a', 'b']), true);
  assert.equal(sameTrailers(['a', 'b'], ['b', 'a']), false);
  assert.equal(sameTrailers([], ['a']), false);
});
