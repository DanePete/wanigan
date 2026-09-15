/**
 * The hook bench's samples carry the field names Wanigan's own hook listener
 * reads for each event — the binary's names, not the docs' — and its decision
 * table matches the 2.1.271 classifier clause by clause.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOOK_SAMPLES, interpretHookResult, sampleFor } from './hook-bench.ts';
import { HOOK_EVENTS, type HookInput } from './types.ts';

/**
 * What main/hooks.ts reads out of each event's body (summaries, paths, models,
 * digests). A sample missing one of these would exercise a hook with an input
 * Wanigan itself would have recorded as naming nothing.
 */
const WANIGAN_READS: Record<string, (keyof HookInput)[]> = {
  PreToolUse: ['tool_name', 'tool_input', 'tool_use_id'],
  PermissionRequest: ['tool_name', 'tool_input'],
  PostToolUse: ['tool_name', 'tool_input', 'tool_response', 'tool_use_id', 'duration_ms'],
  PostToolUseFailure: ['tool_name', 'tool_input', 'tool_use_id', 'duration_ms'],
  Notification: ['message'],
  SubagentStart: ['agent_id', 'agent_type'],
  SubagentStop: ['agent_id', 'agent_type'],
  InstructionsLoaded: ['file_path', 'memory_type', 'load_reason'],
  PostModelSwitch: ['from_model', 'to_model', 'source'],
  CwdChanged: ['old_cwd', 'new_cwd'],
  DirectoryAdded: ['directory', 'source'],
  ConfigChange: ['source', 'file_path'],
};

/** Fields the binary's schemas carry that Wanigan's listener has no use for. */
const BINARY_ONLY = new Set(['prompt', 'stop_hook_active', 'last_assistant_message', 'agent_transcript_path', 'error', 'error_details',
  'is_interrupt', 'notification_type', 'reason', 'trigger', 'custom_instructions', 'compact_summary']);

const HOOK_INPUT_FIELDS = new Set<string>(['session_id', 'transcript_path', 'cwd', 'permission_mode', 'hook_event_name', 'tool_name', 'tool_use_id',
  'tool_input', 'tool_response', 'duration_ms', 'agent_id', 'agent_type', 'message', 'file_path', 'memory_type', 'load_reason', 'from_model',
  'to_model', 'source', 'old_cwd', 'new_cwd', 'directory', 'mcp_server_name', 'action', 'teammate_name', 'task_id', 'task_subject', 'name',
  'worktree_path', 'wanigan_session_id'] satisfies (keyof HookInput)[]);

test('every sample names a real event and carries every field Wanigan reads for it', () => {
  for (const [event, sample] of Object.entries(HOOK_SAMPLES)) {
    assert.ok((HOOK_EVENTS as readonly string[]).includes(event), `${event} is a hook event Wanigan knows`);
    assert.equal(sample.hook_event_name, event);
    for (const field of WANIGAN_READS[event] ?? []) assert.ok(field in sample, `${event} sample carries ${field}`);
    for (const key of Object.keys(sample)) {
      assert.ok(HOOK_INPUT_FIELDS.has(key) || BINARY_ONLY.has(key), `${event}.${key} is either a field Wanigan reads or one the binary's schema names`);
    }
  }
  assert.ok(!('directory_path' in HOOK_SAMPLES.DirectoryAdded), 'DirectoryAdded carries `directory`, as the CLI sends it, not the docs\' `directory_path`');
});

test('a sample is anchored in the project and carries the common fields', () => {
  const s = sampleFor('InstructionsLoaded', '/work/app')!;
  assert.equal(s.cwd, '/work/app');
  assert.equal(s.file_path, '/work/app/CLAUDE.md');
  assert.equal(s.session_id, 'wanigan-hook-bench');
  assert.equal(typeof s.transcript_path, 'string');
  assert.equal(sampleFor('CwdChanged', '/work/app/')!.old_cwd, '/work/app/');
  assert.equal(sampleFor('NoSuchEvent', '/x'), null);
});

const run = (event: string, exitCode: number | null, stdout = '', stderr = '', timedOut = false) => interpretHookResult({ event, exitCode, stdout, stderr, timedOut });

test('exit codes without JSON: 0 has no effect, 2 blocks with stderr, anything else is a non-blocking error', () => {
  assert.equal(run('PreToolUse', 0).effect, 'ignored');
  assert.equal(run('PreToolUse', 0, 'plain text').effect, 'ignored', 'plain stdout is not used for PreToolUse');
  assert.deepEqual(run('UserPromptSubmit', 0, 'Remember the style guide'), { effect: 'context', because: run('UserPromptSubmit', 0, 'Remember the style guide').because, feedback: 'Remember the style guide' });
  const blocked = run('PreToolUse', 2, '', 'rm is not allowed here');
  assert.equal(blocked.effect, 'block');
  assert.equal(blocked.feedback, 'rm is not allowed here');
  assert.equal(run('PreToolUse', 2).feedback, 'No stderr output');
  assert.equal(run('PostToolUse', 1, '', 'lint failed').effect, 'ignored');
  assert.match(run('PostToolUse', 1).because, /non-blocking error/);
  assert.equal(run('Stop', 2, '', 'sh: hooks/stop.sh: No such file or directory').effect, 'ignored', 'a missing Stop script is a warning');
  assert.equal(run('PreToolUse', 2, '', 'No such file or directory').effect, 'block', 'the missing-script exception is only for the stop-shaped events');
});

test('JSON output decides, and exit 2 still blocks when the JSON does not', () => {
  assert.equal(run('PreToolUse', 0, '{"decision":"block","reason":"no"}').effect, 'block');
  assert.equal(run('PreToolUse', 0, '{"decision":"block","reason":"no"}').feedback, 'no');
  assert.equal(run('Stop', 0, '{"continue":false,"stopReason":"done"}').effect, 'block');
  assert.equal(run('PreToolUse', 0, '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"prod"}}').effect, 'block');
  assert.equal(run('PreToolUse', 0, '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask"}}').effect, 'ask');
  assert.equal(run('PreToolUse', 0, '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}').effect, 'allow');
  assert.equal(run('PreToolUse', 0, '{"decision":"approve"}').effect, 'allow');
  assert.equal(run('SessionStart', 0, '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"on-call: Ana"}}').effect, 'context');
  assert.equal(run('PreToolUse', 0, '{"suppressOutput":true}').effect, 'ignored');
  assert.equal(run('PreToolUse', 2, '{"suppressOutput":true}', 'blocked by policy').effect, 'block');
  assert.equal(run('PreToolUse', 0, '{not json').effect, 'ignored', 'JSON-looking stdout that does not parse is ignored with a warning');
  assert.equal(run('PreToolUse', 2, '{not json', 'nope').effect, 'block', 'unless the exit code is 2');
  assert.equal(run('PreToolUse', 0, '{"async":true}').effect, 'background');
  assert.equal(run('PreToolUse', 2, '{"async":true}', 'x').effect, 'block');
  assert.equal(run('Stop', 2, '{"async":true}', 'x').effect, 'ignored', 'on the stop events an async hook that exits 2 is only a warning');
});

test('a timeout or a signal is reported as itself, never as a decision', () => {
  assert.equal(run('PreToolUse', null, '', '', true).effect, 'ignored');
  assert.match(run('PreToolUse', null, '', '', true).because, /did not finish within/);
  assert.match(run('PreToolUse', null).because, /signal/);
});
