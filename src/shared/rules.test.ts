import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activityFor, describeTool, nextState, rankNeeds } from './attention.ts';
import { chatterAgent, chatterOf, decodeChatter, encodeChatter } from './chatter.ts';
import { checkClaim, checkOwnerMove, checkSubmit, projectKeyFrom, rankBetween } from './board.ts';
import { NEED_KINDS, type Need } from './model.ts';

test('project keys come from the name and never collide', () => {
  assert.equal(projectKeyFrom('Northstar Storefront', new Set()), 'NS');
  assert.equal(projectKeyFrom('orbit-api', new Set()), 'OA');
  assert.equal(projectKeyFrom('fieldnotes', new Set()), 'FIE');
  assert.equal(projectKeyFrom('SummerOutdoorTrips', new Set()), 'SOT');
  assert.equal(projectKeyFrom('Northstar Storefront', new Set(['NS'])), 'NS2');
  assert.equal(projectKeyFrom('2048 clone', new Set()), 'P2C');
});

test('ranks fall between their neighbours', () => {
  assert.equal(rankBetween(null, null), 1000);
  assert.equal(rankBetween(1000, 2000), 1500);
  assert.ok(rankBetween(null, 1000) < 1000);
  assert.ok(rankBetween(1000, null) > 1000);
});

test('the owner cannot drag work into Working or out of Done', () => {
  assert.equal(checkOwnerMove({ status: 'ready' }, 'review', 1), null);
  assert.match(checkOwnerMove({ status: 'ready' }, 'review')?.message ?? '', /evidence/);
  assert.match(checkOwnerMove({ status: 'ready' }, 'working')?.message ?? '', /session/);
  assert.match(checkOwnerMove({ status: 'done' }, 'ready')?.message ?? '', /Reopen/);
  assert.equal(checkOwnerMove({ status: 'done' }, 'archived'), null);
});

test('a claim held by someone else blocks, an expired one does not', () => {
  const now = 1_000_000;
  const held = { status: 'working' as const, claim: { sessionId: 'a', expiresAt: now + 1, note: null } };
  assert.match(checkClaim(held, 'b', now)?.message ?? '', /Another session/);
  assert.equal(checkClaim(held, 'a', now), null);
  assert.equal(checkClaim({ ...held, claim: { ...held.claim, expiresAt: now - 1 } }, 'b', now), null);
  assert.match(checkClaim({ status: 'review', claim: null }, 'b', now)?.message ?? '', /review/);
});

test('review needs a live claim and evidence', () => {
  const now = 1_000_000;
  const card = { status: 'working' as const, claim: { sessionId: 'a', expiresAt: now + 1, note: null } };
  assert.match(checkSubmit(card, 'a', 0, now)?.message ?? '', /evidence/);
  assert.equal(checkSubmit(card, 'a', 1, now), null);
  assert.match(checkSubmit(card, 'b', 1, now)?.message ?? '', /Claim/);
  assert.match(checkSubmit({ status: 'ready', claim: null }, 'a', 1, now)?.message ?? '', /Working/);
});

test('hook events move a session between states', () => {
  assert.equal(nextState('waiting', 'UserPromptSubmit', {}), 'working');
  assert.equal(nextState('working', 'PermissionRequest', {}), 'permission');
  assert.equal(nextState('working', 'Stop', {}), 'waiting');
  assert.equal(nextState('working', 'Notification', { notification_type: 'permission_prompt' }), 'permission');
  assert.equal(nextState('working', 'Notification', { notification_type: 'idle_prompt' }), 'waiting');
  // Older binaries without notification_type: fall back to the message text.
  assert.equal(nextState('working', 'Notification', { message: 'Claude needs your permission to use Bash' }), 'permission');
});

test('a permission request stands until something answers it', () => {
  assert.equal(nextState('permission', 'Notification', { notification_type: 'idle_prompt' }), 'permission');
  assert.equal(nextState('permission', 'Notification', { notification_type: 'auth_success' }), 'permission');
  assert.equal(nextState('permission', 'SessionEnd', { reason: 'clear' }), 'permission');
  assert.equal(nextState('permission', 'PostToolUse', {}), 'working');
  assert.equal(nextState('permission', 'PermissionDenied', {}), 'working');
});

test('an ended session does not come back to life from a late event', () => {
  assert.equal(nextState('ended', 'UserPromptSubmit', {}), 'ended');
  assert.equal(nextState('interrupted', 'Stop', {}), 'interrupted');
});

test('tool calls read as short human lines', () => {
  assert.equal(describeTool('Edit', { file_path: '/repo/src/app.ts' }), 'Edit app.ts');
  assert.equal(describeTool('Bash', { command: 'npm   test' }), 'Bash npm test');
  assert.equal(describeTool('Grep', { pattern: 'TODO' }), 'Grep TODO');
  assert.equal(describeTool(undefined, {}), null);
  assert.equal(activityFor('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'rm -rf build' } }), 'Asking: Bash rm -rf build');
});

test('needs are ranked by kind, then oldest first', () => {
  const need = (kind: Need['kind'], since: number): Need => ({
    kind, since, projectId: 'p', projectName: 'P', projectKey: 'P', cardId: null, cardKey: null, sessionId: null, provider: null, title: kind, detail: null,
  });
  const ranked = rankNeeds([need('waiting', 1), need('review', 5), need('permission', 9), need('review', 2)]);
  assert.deepEqual(ranked.map((n) => `${n.kind}:${n.since}`), ['permission:9', 'review:2', 'review:5', 'waiting:1']);
});

test('every kind of need has its place: a permission prompt first, then reviews, then failures, a finished turn last', () => {
  const need = (kind: Need['kind']): Need => ({
    kind, since: 0, projectId: 'p', projectName: 'P', projectKey: 'P', cardId: null, cardKey: null, sessionId: null, provider: null, title: kind, detail: null,
  });
  const order = rankNeeds([...NEED_KINDS].reverse().map(need)).map((n) => n.kind);
  assert.deepEqual(order, ['permission', 'starting', 'overlap', 'limit', 'review', 'failed', 'interrupted', 'quiet', 'question', 'waiting']);
});

test('a message between agents reads as who and label, never the message', () => {
  assert.equal(describeTool('SendMessage', { to: 'researcher', summary: 'Found the flaky test', message: 'SECRET' }), 'Messaging researcher: Found the flaky test');
  assert.equal(describeTool('SendMessage', { to: 'main', message: 'SECRET' }), 'Messaging main');
  assert.equal(describeTool('SendMessage', { message: 'SECRET' }), 'Messaging another agent');
  assert.equal(activityFor('PreToolUse', { tool_name: 'SendMessage', tool_input: { to: 'qa', summary: 'Ready for you' } }), 'Messaging qa: Ready for you');
});

test('the chatter encoding round-trips, separator and all', () => {
  const c = chatterOf({ to: 'lead · two', summary: '  Found   it · in checkout ', message: 'never read' });
  assert.deepEqual(c, { to: 'lead - two', label: 'Found it · in checkout' }, 'the recipient cannot carry the separator');
  assert.deepEqual(decodeChatter(encodeChatter(c)), c);
  assert.deepEqual(decodeChatter(encodeChatter({ to: 'main', label: null })), { to: 'main', label: null });
  assert.deepEqual(decodeChatter(encodeChatter({ to: null, label: 'just a label' })), { to: null, label: 'just a label' });
  assert.deepEqual(decodeChatter(null), { to: null, label: null });
  assert.equal(chatterOf({ to: 'x'.repeat(99) }).to?.length, 40);
  assert.equal(chatterOf({ to: 'x', summary: 'y'.repeat(999) }).label?.length, 160);
});

test('a message from a subagent names the subagent, and the main thread names nobody', () => {
  assert.equal(chatterAgent({}), null);
  assert.equal(chatterAgent({ agent_type: 'reviewer' }), null, 'an --agent session’s main thread is still the session');
  assert.equal(chatterAgent({ agent_id: 'a1', agent_type: 'researcher' }), 'researcher');
  assert.equal(chatterAgent({ agent_id: 'a1' }), 'a subagent');
});
