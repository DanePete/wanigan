/**
 * Finer headless outcomes. The Claude fixtures follow the result schema in the
 * Claude Code 2.1.271 binary; the Codex fixtures follow the `codex exec --json`
 * event names in 0.154.0. The network case is the reported one: a CLI inside a
 * sandbox with no network says it cannot resolve a host, and the agent reports
 * a bad token.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyHeadlessOutcome, claudeResult, codexTerminal, endsOnQuestion, networkBeforeCredentials,
} from './headless-outcome.ts';

const claude = (over: Record<string, unknown>) => JSON.stringify({
  type: 'result', subtype: 'success', is_error: false, result: 'Done. Tests pass.', stop_reason: 'end_turn',
  total_cost_usd: 0.01, usage: {}, modelUsage: {}, permission_denials: [], ...over,
});
const base = { stderr: '', spawnFailed: false };

test('a clean Claude result is succeeded', () => {
  assert.equal(classifyHeadlessOutcome({ ...base, harness: 'claude-code', status: 'succeeded', stdout: claude({}) }).kind, 'succeeded');
});

test('permission denials mean the run was waiting on a person, not done', () => {
  const out = classifyHeadlessOutcome({
    ...base, harness: 'claude-code', status: 'succeeded',
    stdout: claude({ permission_denials: [{ tool_name: 'Bash', tool_use_id: 't1', tool_input: {} }, { tool_name: 'Bash', tool_use_id: 't2', tool_input: {} }] }),
  });
  assert.equal(out.kind, 'waiting_on_input');
  assert.equal(out.reason, 'permission-denials');
  assert.match(out.detail, /2 times \(Bash\)/);
});

test('a deferred tool call and a closing question are both waiting on input', () => {
  assert.equal(classifyHeadlessOutcome({ ...base, harness: 'claude-code', status: 'succeeded', stdout: claude({ stop_reason: 'tool_deferred', result: '' }) }).reason, 'tool-deferred');
  assert.equal(classifyHeadlessOutcome({ ...base, harness: 'claude-code', status: 'succeeded', stdout: claude({ result: 'I found two configs.\nWhich one should I change?' }) }).reason, 'ended-on-question');
  assert.equal(endsOnQuestion('Should I proceed?**'), true);
  assert.equal(endsOnQuestion('What? No. Done.'), false);
  assert.equal(endsOnQuestion(''), false);
});

test('no result object is ended-without-result whatever the exit code said', () => {
  const out = classifyHeadlessOutcome({ ...base, harness: 'claude-code', status: 'succeeded', stdout: 'Some text\n{"type":"assistant"}' });
  assert.equal(out.kind, 'ended_without_result');
  assert.equal(classifyHeadlessOutcome({ ...base, harness: 'claude-code', status: 'errored', stdout: '' }).kind, 'ended_without_result');
  assert.equal(claudeResult(''), null);
});

test('a timeout keeps its partial output and says how much', () => {
  const out = classifyHeadlessOutcome({ ...base, harness: 'claude-code', status: 'timeout', stdout: 'x'.repeat(4096) });
  assert.equal(out.kind, 'timed_out');
  assert.match(out.detail, /partial output kept \(4 KB\)/);
  assert.match(classifyHeadlessOutcome({ ...base, harness: 'codex', status: 'timeout', stdout: '' }).detail, /printed nothing/);
});

const codex = (...events: Record<string, unknown>[]) => events.map((e) => JSON.stringify(e)).join('\n');

test('the last Codex terminal event is authoritative', () => {
  const stdout = codex(
    { type: 'thread.started', thread_id: 'x' },
    { type: 'turn.started' },
    { type: 'item.completed', item: { type: 'agent_message', text: 'All green.' } },
    { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } },
  );
  assert.deepEqual(codexTerminal(stdout), { type: 'turn.completed', message: null, lastAgentText: 'All green.' });
  assert.equal(classifyHeadlessOutcome({ ...base, harness: 'codex', status: 'succeeded', stdout }).kind, 'succeeded');
});

test('a Codex stream with no terminal event ended without a result', () => {
  const stdout = codex({ type: 'thread.started' }, { type: 'turn.started' }, { type: 'item.started', item: { type: 'command_execution' } });
  assert.equal(classifyHeadlessOutcome({ ...base, harness: 'codex', status: 'succeeded', stdout }).kind, 'ended_without_result');
});

test('turn.failed naming an approval is waiting on input; any other failure is an error', () => {
  const approval = codex({ type: 'turn.started' }, { type: 'turn.failed', error: { message: 'command requires approval but approval policy is never' } });
  assert.equal(classifyHeadlessOutcome({ ...base, harness: 'codex', status: 'errored', stdout: approval }).kind, 'waiting_on_input');
  const other = codex({ type: 'turn.failed', error: { message: 'model overloaded' } });
  const out = classifyHeadlessOutcome({ ...base, harness: 'codex', status: 'errored', stdout: other });
  assert.equal(out.kind, 'errored');
  assert.match(out.detail, /overloaded/);
});

test('a DNS failure beside an auth complaint is labelled network, and names the sandbox setting', () => {
  const stdout = codex(
    { type: 'item.completed', item: { type: 'command_execution', aggregated_output: 'curl: (6) Could not resolve host: api.github.com' } },
    { type: 'item.completed', item: { type: 'agent_message', text: 'gh says the token is invalid; authentication failed.' } },
    { type: 'turn.completed' },
  );
  const out = classifyHeadlessOutcome({ ...base, harness: 'codex', status: 'succeeded', stdout });
  assert.equal(out.kind, 'network_unreachable');
  assert.match(out.detail, /not an auth failure/);
  assert.match(out.detail, /sandbox_workspace_write\.network_access/);
});

test('a network error with no auth complaint near it is not relabelled, and neither is a lone auth error', () => {
  assert.equal(networkBeforeCredentials('getaddrinfo ENOTFOUND registry.npmjs.org'), null);
  assert.equal(networkBeforeCredentials('401 Unauthorized: bad credentials'), null);
  const far = `Could not resolve host: x${' '.repeat(2000)}authentication failed`;
  assert.equal(networkBeforeCredentials(far), null);
  // The same pairing on a Claude row is left alone: the sandbox diagnosis is Codex's.
  const claudeRow = classifyHeadlessOutcome({ ...base, harness: 'claude-code', status: 'errored', stdout: claude({ is_error: true, subtype: 'error_during_execution' }), stderr: 'Could not resolve host; auth failed' });
  assert.equal(claudeRow.kind, 'errored');
});

test('a cancel and a spawn failure keep their plain meaning', () => {
  assert.equal(classifyHeadlessOutcome({ ...base, harness: 'codex', status: 'canceled', stdout: '' }).kind, 'canceled');
  assert.equal(classifyHeadlessOutcome({ harness: 'codex', status: 'errored', stdout: '', stderr: '', spawnFailed: true }).reason, 'spawn-failed');
});
