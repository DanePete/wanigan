/**
 * Matching gate denials and classifier denials to the timeline rows they rejected.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rejectedRows } from './rejections.ts';

test('a gate denial marks its PreToolUse, once, by tool, time and command', () => {
  const t = 1_789_000_000_000;
  const rows = rejectedRows([
    { id: 1, at: t, event: 'PreToolUse', toolName: 'Bash', summary: 'rm -rf ~' },
    { id: 2, at: t + 5, event: 'PreToolUse', toolName: 'Bash', summary: 'npm test' },
    { id: 3, at: t + 10, event: 'PostToolUse', toolName: 'Bash', summary: 'npm test' },
    { id: 4, at: t + 20_000, event: 'PreToolUse', toolName: 'Bash', summary: 'rm -rf ~' },
  ], [
    { at: t + 4, toolName: 'Bash', summary: 'rm -rf ~', rule: 'bash.destructive-root', reason: 'This runs rm against /home/me.' },
  ]);
  assert.deepEqual([...rows.keys()], [1]);
  assert.deepEqual(rows.get(1), { source: 'gate', rule: 'bash.destructive-root', reason: 'This runs rm against /home/me.' });
});

test('clipped and redacted summaries still match; a different tool or a late row does not', () => {
  const t = 1_789_000_000_000;
  const long = `curl -H "Authorization: Bearer sk-abcdef" https://example.com/${'x'.repeat(200)}`;
  const rows = rejectedRows([
    { id: 1, at: t, event: 'PreToolUse', toolName: 'Bash', summary: `${long.slice(0, 159)}…` },
    { id: 2, at: t, event: 'PreToolUse', toolName: 'Write', summary: '/etc/hosts' },
  ], [
    { at: t + 30, toolName: 'Bash', summary: `curl -H "Authorization: Bearer sk-abc…" https://example.com/${'x'.repeat(200)}`, rule: 'readonly.shell', reason: 'r' },
    { at: t + 9_000, toolName: 'Write', summary: '/etc/hosts', rule: 'project.write-outside', reason: 'r' },
  ]);
  assert.equal(rows.get(1)?.rule, 'readonly.shell');
  assert.equal(rows.has(2), false);
});

test('a PermissionDenied row is rejected with the classifier’s reason', () => {
  const rows = rejectedRows([{ id: 9, at: 1, event: 'PermissionDenied', toolName: 'Bash', summary: 'git push -f', detail: 'Force push to main is blocked by the soft-deny list' }], []);
  assert.deepEqual(rows.get(9), { source: 'classifier', rule: null, reason: 'Force push to main is blocked by the soft-deny list' });
});
