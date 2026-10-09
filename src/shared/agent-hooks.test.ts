import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextState } from './attention.ts';
import { normalizeHook } from './agent-hooks.ts';

test('Claude Code and Codex pass through unchanged', () => {
  const input = { tool_name: 'Read', tool_input: { file_path: 'a' } };
  assert.deepEqual(normalizeHook('claude', 'PreToolUse', input), { event: 'PreToolUse', input });
  assert.deepEqual(normalizeHook('codex', 'Stop', {}), { event: 'Stop', input: {} });
});

test('Grok’s camelCase fields become the names the state machine reads', () => {
  const n = normalizeHook('grok', 'PreToolUse', { hookEventName: 'pre_tool_use', toolName: 'read_file', toolInput: { path: 'README.md' }, sessionId: 's1', cwd: '/x' });
  assert.deepEqual(n, { event: 'PreToolUse', input: { hookEventName: 'pre_tool_use', tool_name: 'read_file', tool_input: { path: 'README.md' }, session_id: 's1', cwd: '/x' } });
});

test('Grok: a permission ask is a notification, and it raises the session as asking', () => {
  const n = normalizeHook('grok', 'Notification', { notificationType: 'permission_prompt', message: 'Grok needs your permission to use run_terminal_cmd' })!;
  assert.equal(nextState('working', n.event, n.input), 'permission');
});

test('Grok: only a turn that ended ends it; teardown and subagents say nothing; a cancel waits at the prompt', () => {
  assert.equal(nextState('working', ...Object.values(normalizeHook('grok', 'Stop', { reason: 'end_turn' })!) as [string, Record<string, unknown>]), 'waiting');
  assert.equal(normalizeHook('grok', 'Stop', { reason: 'channel_closed' }), null);
  assert.equal(normalizeHook('grok', 'Stop', { reason: 'shutdown' }), null);
  assert.equal(normalizeHook('grok', 'PreToolUse', { toolName: 'x', subagentType: 'explore' }), null);
  assert.deepEqual(normalizeHook('grok', 'StopCancelled', { reason: 'user_interrupt' })?.event, 'Stop');
});

test('Gemini: a turn starts and ends, its tools read as the tools they are, and a permission ask raises the session', () => {
  assert.deepEqual(normalizeHook('gemini', 'BeforeAgent', { prompt: 'hi' })?.event, 'UserPromptSubmit');
  assert.equal(nextState('waiting', 'UserPromptSubmit', {}), 'working');
  const read = normalizeHook('gemini', 'BeforeTool', { tool_name: 'read_file', tool_input: { file_path: 'README.md' } })!;
  assert.deepEqual(read, { event: 'PreToolUse', input: { tool_name: 'Read', gemini_tool: 'read_file', tool_input: { file_path: 'README.md' } } });
  assert.equal(normalizeHook('gemini', 'AfterTool', { tool_name: 'replace' })?.input.tool_name, 'Edit');
  assert.equal(normalizeHook('gemini', 'AfterTool', { tool_name: 'some_mcp_tool' })?.input.tool_name, 'some_mcp_tool', 'an unknown tool keeps its name');
  const ask = normalizeHook('gemini', 'Notification', { notification_type: 'ToolPermission', message: 'Allow?', details: { type: 'exec', title: 'Shell', command: 'npm test', rootCommand: 'npm' } })!;
  assert.deepEqual([ask.event, ask.input.tool_name, ask.input.tool_input], ['PermissionRequest', 'Bash', { command: 'npm test' }]);
  assert.equal(nextState('working', ask.event, ask.input), 'permission');
  const edit = normalizeHook('gemini', 'Notification', { notification_type: 'ToolPermission', details: { type: 'edit', fileName: 'a.ts', filePath: '/p/a.ts', fileDiff: 'x'.repeat(10) } })!;
  assert.deepEqual([edit.input.tool_name, edit.input.tool_input], ['Edit', { file_path: '/p/a.ts' }]);
  assert.equal(normalizeHook('gemini', 'AfterAgent', { prompt_response: 'done' })?.event, 'Stop');
  assert.equal(nextState('working', 'Stop', {}), 'waiting');
});

test('Gemini: the model events, compression and other notifications say nothing', () => {
  for (const e of ['BeforeModel', 'AfterModel', 'BeforeToolSelection', 'PreCompress']) assert.equal(normalizeHook('gemini', e, {}), null, e);
  assert.equal(normalizeHook('gemini', 'Notification', { notification_type: 'Something' }), null);
});
