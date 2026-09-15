/**
 * The result shapes below are the fields the 2.1.271 binary's result schema
 * declares (`terminal_reason`, `stop_reason`, `session_id`,
 * `deferred_tool_use: { id, name, input }`). The question each test asks is
 * whether Wanigan could hold a run on something the CLI did not say.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFER_SINCE, HELD_INPUT_MAX, cliSupportsDefer, heldCallSummary, readDeferredOutcome } from './deferred-approvals.ts';

test('defer is offered only to a CLI at or past the release it was verified in', () => {
  assert.equal(cliSupportsDefer(`${DEFER_SINCE} (Claude Code)`), true);
  assert.equal(cliSupportsDefer('2.1.272 (Claude Code)'), true);
  assert.equal(cliSupportsDefer('2.2.0'), true);
  assert.equal(cliSupportsDefer('2.1.270 (Claude Code)'), false);
  assert.equal(cliSupportsDefer('1.9.999'), false);
  // An unprobed or unreadable version keeps today's denial.
  assert.equal(cliSupportsDefer(null), false);
  assert.equal(cliSupportsDefer('claude dev build'), false);
});

test('a deferred result is read from exactly the fields the CLI writes', () => {
  const held = readDeferredOutcome({
    type: 'result', subtype: 'success', is_error: false, stop_reason: 'tool_deferred', terminal_reason: 'tool_deferred',
    session_id: '0b1c9a4e-7d7a-4f7e-9d0e-2f1c4a5b6c7d',
    deferred_tool_use: { id: 'toolu_01AbC', name: 'Bash', input: { command: 'npm publish --access public' } },
  });
  assert.deepEqual(held, {
    terminalReason: 'tool_deferred', sessionId: '0b1c9a4e-7d7a-4f7e-9d0e-2f1c4a5b6c7d',
    deferred: { id: 'toolu_01AbC', name: 'Bash', input: { command: 'npm publish --access public' } },
  });
});

test('nothing is held on a shape the CLI did not write', () => {
  assert.deepEqual(readDeferredOutcome({ type: 'result', terminal_reason: 'completed', session_id: 's' }),
    { terminalReason: 'completed', sessionId: 's', deferred: null });
  // A marker with no id cannot be resumed, so it is not a held call.
  assert.equal(readDeferredOutcome({ terminal_reason: 'tool_deferred', deferred_tool_use: { name: 'Bash', input: {} } }).deferred, null);
  // The one case the CLI refuses outright is named, not mistaken for a hold.
  assert.equal(readDeferredOutcome({ is_error: true, terminal_reason: 'tool_deferred_unavailable' }).terminalReason, 'tool_deferred_unavailable');
  assert.deepEqual(readDeferredOutcome('not json'), { terminalReason: null, sessionId: null, deferred: null });
  assert.deepEqual(readDeferredOutcome(null), { terminalReason: null, sessionId: null, deferred: null });
});

test('a held call is summarised as the part a person decides on, and bounded', () => {
  assert.equal(heldCallSummary('Bash', { command: 'git push   origin\nmain', description: 'push' }), 'git push origin main');
  assert.equal(heldCallSummary('Write', { file_path: '/Users/x/.ssh/config', content: 'Host *' }), '/Users/x/.ssh/config');
  assert.equal(heldCallSummary('WebFetch', { url: 'https://example.com/a', prompt: 'read it' }), 'https://example.com/a');
  assert.equal(heldCallSummary('mcp__github__create_issue', { title: 'Bug' }), '{"title":"Bug"}');
  const long = heldCallSummary('Bash', { command: 'x'.repeat(2000) });
  assert.equal(long.length, HELD_INPUT_MAX);
  assert.ok(long.endsWith('…'));
});
