/**
 * The Dock badge and the menu-bar list, held to two promises: the badge is a
 * count of sessions that need a person, and nothing a session was asked ever
 * reaches a surface that opens over whatever else is on screen.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { badgeCount, badgeText, timeInState, trayGlyphAlpha, trayGlyphBgra, trayModel, trayRows } from './mac-presence.ts';
import type { Attention, AttentionKind, Session } from './types.ts';

const NOW = 1_800_000_000_000;

const session = (id: string, over: Partial<Session> = {}): Session => ({
  id, providerId: 'claude', projectId: 'p1', projectPath: '/Users/someone/secret-client/repo', projectName: 'storefront',
  title: 'Claude Code · storefront', status: 'running', pid: 1, exitCode: null, createdAt: NOW - 3_600_000, endedAt: null, unread: 0,
  ...over,
});

const attention = (sessionId: string, kind: AttentionKind, over: Partial<Attention> = {}): Attention => ({
  sessionId, kind, transitionId: `${sessionId}:${kind}`, since: NOW - 240_000,
  label: { permission: 'Asking', error: 'Failed', finished: 'Done', idle: 'Idle', working: 'Working' }[kind],
  detail: null, tool: null, ...over,
});

test('the badge counts sessions asking or failed, once each, and nothing else', () => {
  const list = [attention('a', 'permission'), attention('b', 'error'), attention('c', 'working'), attention('d', 'finished'), attention('e', 'idle')];
  assert.equal(badgeCount(list, new Set(), NOW), 2);
  // A session that is both asking and waiting on review is one session.
  assert.equal(badgeCount(list, new Set(['a', 'd']), NOW), 3);
  assert.equal(badgeText(0), '', 'nothing needs you, so the Dock shows nothing at all');
  assert.equal(badgeText(3), '3');
  assert.equal(badgeText(250), '99');
});

test('a snoozed session leaves the badge until its snooze runs out', () => {
  const snoozed = attention('a', 'permission', { helper: { snoozedUntil: NOW + 60_000 } });
  assert.equal(badgeCount([snoozed], new Set(), NOW), 0);
  assert.equal(badgeCount([snoozed], new Set(), NOW + 120_000), 1);
});

test('the menu bar lists live sessions worst first with a state word, how long, and the project', () => {
  const sessions = [
    session('w', { createdAt: NOW - 50_000 }),
    session('p', { projectName: 'billing' }),
    session('x', { status: 'exited', exitCode: 1, endedAt: NOW - 1000 }),
    session('s', { status: 'starting', createdAt: NOW - 5_000 }),
  ];
  const rows = trayRows(sessions, [attention('w', 'working'), attention('p', 'permission'), attention('x', 'error')], new Set(), NOW);
  assert.deepEqual(rows.map((r) => r.sessionId), ['p', 'w', 's'], 'exited sessions are not live; unclassified rows sort last');
  assert.equal(rows[0].state, 'Asking');
  assert.equal(rows[2].state, 'Starting');
  const model = trayModel(rows, badgeCount([attention('p', 'permission')], new Set(), NOW), NOW);
  const labels = model.items.flatMap((i) => ('label' in i ? [i.label] : []));
  assert.ok(labels.includes('● Asking — billing · 4m'), labels.join('\n'));
  assert.equal(model.title, '1');
  assert.equal(model.quiet, false);
  assert.deepEqual(model.items.slice(-2).map((i) => i.kind), ['open', 'halt']);
  const last = model.items.at(-1);
  assert.equal(last?.kind === 'halt' ? last.label : null, 'Halt all agents…');
});

test('the tray sits quiet when nothing needs you: no title and a hollow glyph', () => {
  const rows = trayRows([session('w')], [attention('w', 'working')], new Set(), NOW);
  const model = trayModel(rows, 0, NOW);
  assert.equal(model.quiet, true);
  assert.equal(model.title, '');
  assert.match(model.items[0].kind === 'heading' ? model.items[0].label : '', /nothing needs you/);
  const hollow = trayGlyphAlpha(18, false);
  const filled = trayGlyphAlpha(18, true);
  const centre = 9 * 18 + 9;
  assert.equal(hollow[centre], 0, 'the quiet glyph is a ring with nothing in the middle');
  assert.ok(filled[centre] > 200, 'the attention glyph fills its centre');
  assert.ok(hollow.some((v) => v === 255), 'the ring has solid pixels');
  const bgra = trayGlyphBgra(18, true);
  assert.equal(bgra.length, 18 * 18 * 4);
  assert.ok([...bgra].every((v, i) => i % 4 === 3 || v === 0), 'a template image is black; only alpha carries the shape');
});

test('prompt text, paths and attention details never reach the menu bar', () => {
  const secret = 'DEPLOY-THE-SECRET-TOKEN sk-ant-api03-zzz please rewrite billing';
  const sessions = [session('a', {
    displayTitle: secret, title: secret, projectPath: `/tmp/${secret}`,
    model: secret, conversationId: secret, worktree: `/tmp/${secret}`,
  })];
  const list = [attention('a', 'permission', {
    detail: secret, tool: secret,
    reason: { rule: 'permission-request', event: { name: 'PermissionRequest', at: NOW }, because: secret },
    helper: { denial: { tool: secret, summary: secret, reason: secret, at: NOW, retryDraft: secret } },
  })];
  const model = trayModel(trayRows(sessions, list, new Set(['a']), NOW), badgeCount(list, new Set(['a']), NOW), NOW);
  const wire = JSON.stringify(model);
  assert.ok(!wire.includes('SECRET'), wire);
  assert.ok(!wire.includes('/tmp/'), wire);
  // A label is the one free-text field that does reach it; it is clipped to a word's length.
  const long = attention('a', 'permission', { label: 'x'.repeat(200) });
  const row = trayRows(sessions, [long], new Set(), NOW)[0];
  assert.ok(row.state.length <= 24);
});

test('time in state reads the way a menu is scanned', () => {
  assert.equal(timeInState(12_000), '12s');
  assert.equal(timeInState(240_000), '4m');
  assert.equal(timeInState(3_600_000), '1h');
  assert.equal(timeInState(3_900_000), '1h 5m');
  assert.equal(timeInState(3 * 86_400_000), '3d');
  assert.equal(timeInState(-5), '0s');
});
