/**
 * The Resume dialog's pure rules: the band a conversation is filed under, what
 * a typed filter matches, and how a transcript hit's «markers» become runs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HIT_CLOSE, HIT_OPEN, bandConversations, hitParts, lastActive, matchesConversation } from './resume-history.ts';

const noon = new Date(2026, 8, 16, 12, 0, 0).getTime();
const HOUR = 3_600_000;
const row = (id: string, at: number, extra: Partial<{ endedAt: number | null; pinnedAt: number | null; settledAt: number | null }> = {}) =>
  ({ id, startedAt: at, endedAt: null, pinnedAt: null, settledAt: null, ...extra });

test('conversations are banded by calendar day of their last activity, newest first', () => {
  const rows = [
    row('earlier', noon - 30 * 24 * HOUR),
    row('week', noon - 3 * 24 * HOUR),
    row('yesterday-late', noon - 13 * HOUR),
    row('today-old', noon - 11 * HOUR),
    row('today-new', noon - HOUR),
    row('ended-today', noon - 40 * HOUR, { endedAt: noon - 2 * HOUR }),
  ];
  const bands = bandConversations(rows, noon);
  assert.deepEqual(bands.map((b) => [b.band, b.rows.map((r) => r.id)]), [
    ['today', ['today-new', 'ended-today', 'today-old']],
    ['yesterday', ['yesterday-late']],
    ['week', ['week']],
    ['earlier', ['earlier']],
  ]);
});

test('a pin floats above every day and a settle sinks below them; empty bands are omitted', () => {
  const bands = bandConversations([
    row('recent', noon - HOUR),
    row('old-pinned', noon - 90 * 24 * HOUR, { pinnedAt: noon - HOUR }),
    row('settled-today', noon - HOUR, { settledAt: noon }),
  ], noon);
  assert.deepEqual(bands.map((b) => b.band), ['pinned', 'today', 'settled']);
  assert.equal(bands[0].rows[0].id, 'old-pinned');
});

test('last activity is the end when one was recorded, the start otherwise', () => {
  assert.equal(lastActive({ startedAt: 1, endedAt: null }), 1);
  assert.equal(lastActive({ startedAt: 1, endedAt: 5 }), 5);
});

test('every typed word must match somewhere in name, project, agent, model, effort or path', () => {
  const past = { title: 'Repair checkout validation', projectName: 'storefront', projectPath: '/example/storefront', model: 'opus', effort: 'high' };
  assert.equal(matchesConversation(past, 'Claude Code', ''), true);
  assert.equal(matchesConversation(past, 'Claude Code', '  checkout   claude '), true);
  assert.equal(matchesConversation(past, 'Claude Code', 'CHECKOUT opus'), true);
  assert.equal(matchesConversation(past, 'Claude Code', 'checkout codex'), false);
  assert.equal(matchesConversation({ ...past, title: 'Café migration' }, 'Codex', 'cafe'), true);
  assert.equal(matchesConversation({ ...past, title: null, model: null, effort: null }, 'Codex', 'example'), true);
});

test('hit markers split into runs, and unpaired markers stay as the characters they are', () => {
  assert.deepEqual(hitParts(`before ${HIT_OPEN}term${HIT_CLOSE} after ${HIT_OPEN}two${HIT_CLOSE}`), [
    { text: 'before ', hit: false }, { text: 'term', hit: true }, { text: ' after ', hit: false }, { text: 'two', hit: true },
  ]);
  assert.deepEqual(hitParts('no markers'), [{ text: 'no markers', hit: false }]);
  assert.deepEqual(hitParts(`dangling ${HIT_OPEN}open`), [{ text: `dangling ${HIT_OPEN}open`, hit: false }]);
  assert.deepEqual(hitParts(''), []);
});
