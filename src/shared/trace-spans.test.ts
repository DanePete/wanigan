/**
 * The trace waterfall's pure half. Every attribute key below is one the 2.1.270
 * binary's tracing module sets (read 2026-09-14) — the content ones included,
 * which is the point: the filter has to hold against the names the CLI really
 * uses when a content-logging switch is on, not against invented ones.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildInteractions, isContentAttribute, normalizeSpanId, sanitizeSpanAttributes, spansFromOtlp, tracesByTurn,
  type StoredSpan,
} from './trace-spans.ts';

const CONTENT_KEYS = [
  'user_prompt', 'new_context', 'new_context_truncated', 'new_context_original_length',
  'system_prompt_preview', 'system_prompt_hash', 'system_prompt_length', 'user_system_prompt',
  'tools', 'tool_input', 'tool_input_truncated', 'response.model_output', 'hook_definitions',
  'error', 'user_prompt_length', 'bash_argv0', 'command', 'response_body', 'message.content',
];

const FACT_KEYS = [
  'span.type', 'session.id', 'model', 'gen_ai.system', 'gen_ai.request.model', 'llm_request.context',
  'speed', 'query_source', 'query_source_safe', 'agent_id', 'parent_agent_id', 'duration_ms',
  'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens', 'success',
  'status_code', 'error_class', 'attempt', 'response.has_tool_call', 'request_id',
  'gen_ai.response.id', 'client_request_id', 'ttft_ms', 'first_content_ms', 'stop_reason',
  'tool_name', 'tool_name_safe', 'tool_use_id', 'gen_ai.tool.call.id', 'result_tokens',
  'decision', 'source', 'hook_event', 'hook_name', 'num_hooks', 'interaction.sequence',
  'interaction.duration_ms', 'parent.source', 'queued_sends', 'bash_command_class', 'prompt.id',
];

test('every content attribute the CLI can set is recognised as content', () => {
  const missed = CONTENT_KEYS.filter((k) => !isContentAttribute(k));
  assert.deepEqual(missed, []);
});

test('every fact a waterfall reads is kept, including the ones whose names contain a content word', () => {
  const lost = FACT_KEYS.filter((k) => isContentAttribute(k));
  assert.deepEqual(lost, []);
});

test('sanitising a span keeps facts, drops content, identity and anything too long to be a name', () => {
  const secret = 'please refactor the payment module and paste the API key sk-live-123';
  const kept = sanitizeSpanAttributes({
    user_prompt: secret, tool_input: secret, 'response.model_output': secret, error: secret,
    'user.email': 'someone@example.com', 'organization.id': 'org-1', 'terminal.type': 'xterm',
    tool_name: 'Bash', ttft_ms: 820, stop_reason: 'end_turn', decision: 'allow', success: true,
    note: 'x'.repeat(400), bad_number: Number.NaN, nested: { a: 1 },
  });
  assert.deepEqual(kept, { tool_name: 'Bash', ttft_ms: 820, stop_reason: 'end_turn', decision: 'allow', success: true });
  assert(!JSON.stringify(kept).includes('refactor'));
});

test('an OTLP/JSON export is read into spans with content, identity, events and status text left behind', () => {
  const secret = 'rm -rf build && paste the API key sk-live-123';
  const kv = (key: string, value: Record<string, unknown>) => ({ key, value });
  const exported = spansFromOtlp({
    resourceSpans: [{
      resource: { attributes: [kv('wanigan.session.id', { stringValue: 's_trace' }), kv('user.email', { stringValue: 'someone@example.com' })] },
      scopeSpans: [{ spans: [
        {
          traceId: '5b8efff798038103d269b633813fc60c', spanId: 'eee19b7ec3c1b174', parentSpanId: 'eee19b7ec3c1b173',
          name: 'claude_code.tool', startTimeUnixNano: '1788000000000000000', endTimeUnixNano: '1788000004000000000',
          status: { code: 2, message: secret },
          attributes: [kv('tool_name', { stringValue: 'Bash' }), kv('tool_input', { stringValue: secret }),
            kv('bash_argv0', { stringValue: 'rm' }), kv('result_tokens', { intValue: '40' }), kv('ttft_ms', { doubleValue: 812.5 }),
            kv('files', { arrayValue: { values: [{ stringValue: secret }] } })],
          events: [{ name: 'tool.output', attributes: [kv('output', { stringValue: secret })] }],
        },
        { traceId: '0'.repeat(32), spanId: 'eee19b7ec3c1b175', name: 'claude_code.tool', startTimeUnixNano: '1788000000000000000' },
        { traceId: '5b8efff798038103d269b633813fc60c', spanId: 'eee19b7ec3c1b176', name: 'claude_code.llm_request',
          startTimeUnixNano: '1788000005000000000', endTimeUnixNano: '1788000001000000000' },
      ] }],
    }],
  });
  assert.equal(exported.length, 2, 'an all-zero trace id is not a span');
  const [tool, backwards] = exported;
  assert.equal(tool.resourceSessionId, 's_trace');
  assert.deepEqual(tool.span.attrs, { tool_name: 'Bash', result_tokens: 40, ttft_ms: 812.5 });
  assert.equal(tool.span.status, 'error');
  assert.equal(tool.span.endAt! - tool.span.startAt, 4000);
  assert(!JSON.stringify(exported).includes('sk-live') && !JSON.stringify(exported).includes('someone@'));
  assert.equal(backwards.span.endAt, null, 'an end before the start is kept as incomplete, never drawn backwards');
  assert.equal(spansFromOtlp({ resourceSpans: [{ scopeSpans: [{ spans: new Array(5).fill(tool.span).map((_, i) => ({
    traceId: 'a'.repeat(32), spanId: `${i + 1}`.padStart(16, '0'), name: 'x', startTimeUnixNano: '1788000000000000000' })) }] }] }, 3).length, 3,
    'an export past the cap stores what fits');
});

test('span ids are hex, lowercase, never all zeros, and a base64 exporter is read rather than dropped', () => {
  assert.equal(normalizeSpanId('00F067AA0BA902B7', 8), '00f067aa0ba902b7');
  assert.equal(normalizeSpanId('0000000000000000', 8), null);
  assert.equal(normalizeSpanId('APBnqgupArc=', 8), '00f067aa0ba902b7');
  assert.equal(normalizeSpanId('not-an-id', 8), null);
  assert.equal(normalizeSpanId('00f067aa0ba902b7', 16), null, 'a span id is not a trace id');
});

const T = 1_788_000_000_000;
const span = (spanId: string, name: string, start: number, end: number | null, parent: string | null, attrs: StoredSpan['attrs'] = {}, traceId = 'a'.repeat(32)): StoredSpan =>
  ({ traceId, spanId, parentSpanId: parent, name, startAt: T + start, endAt: end === null ? null : T + end, status: 'unset', attrs });

test('a whole prompt lays out model, tool, wait and execution with offsets from the interaction', () => {
  const [turn] = buildInteractions([
    span('i1', 'claude_code.interaction', 0, 30_000, null, { 'interaction.sequence': 3 }),
    span('l1', 'claude_code.llm_request', 100, 4_100, 'i1', { model: 'claude-opus-5', ttft_ms: 820, input_tokens: 1200, output_tokens: 88, stop_reason: 'tool_use' }),
    span('t1', 'claude_code.tool', 4_200, 20_200, 'i1', { tool_name: 'Bash', result_tokens: 40 }),
    span('b1', 'claude_code.tool.blocked_on_user', 4_300, 16_300, 't1', { decision: 'allow', source: 'user_temporary' }),
    span('e1', 'claude_code.tool.execution', 16_400, 20_100, 't1', { success: true }),
    span('l2', 'claude_code.llm_request', 20_300, 29_000, 'i1', { model: 'claude-opus-5', attempt: 2, stop_reason: 'end_turn' }),
  ]);
  assert.equal(turn.rootMissing, false);
  assert.equal(turn.incomplete, false);
  assert.equal(turn.sequence, 3);
  assert.equal(turn.durationMs, 30_000);
  assert.deepEqual(turn.rows.map((r) => [r.kind, r.label, r.depth, r.offsetMs, r.durationMs]), [
    ['llm_request', 'claude-opus-5', 0, 100, 4_000],
    ['tool', 'Bash', 0, 4_200, 16_000],
    ['blocked', 'waiting on you', 1, 4_300, 12_000],
    ['execution', 'running', 1, 16_400, 3_700],
    ['llm_request', 'claude-opus-5', 0, 20_300, 8_700],
  ]);
  assert.deepEqual(turn.totals, { llmMs: 12_700, toolMs: 16_000, blockedMs: 12_000 });
  assert.deepEqual(turn.rows[0].facts, ['first token 820ms', 'stop tool_use', '1,200 in · 88 out']);
  assert(turn.rows[2].facts.includes('you chose allow (user_temporary)'));
  assert(turn.rows[4].facts.includes('attempt 2'));
});

test('a turn killed mid-flight says what is missing instead of drawing a whole trace', () => {
  const [turn] = buildInteractions([
    span('l1', 'claude_code.llm_request', 100, 2_000, 'i-never-exported', { model: 'claude-opus-5' }),
    span('t1', 'claude_code.tool', 2_100, null, 'i-never-exported', { tool_name: 'Edit' }),
  ]);
  assert.equal(turn.rootMissing, true);
  assert.equal(turn.incomplete, true);
  assert.equal(turn.durationMs, null);
  assert.equal(turn.rows[0].offsetMs, 0, 'offsets fall back to the earliest span that did arrive');
  assert.equal(turn.rows[0].incomplete, 'the prompt’s interaction span was not recorded');
  assert.equal(turn.rows[1].incomplete, 'no end time was exported');
  assert.equal(turn.rows[1].durationMs, null);
});

test('a child whose parent is missing inside a recorded interaction is marked on its own row', () => {
  const [turn] = buildInteractions([
    span('i1', 'claude_code.interaction', 0, 5_000, null),
    span('b1', 'claude_code.tool.blocked_on_user', 100, 900, 't-missing'),
  ]);
  assert.equal(turn.rootMissing, false);
  assert.equal(turn.incomplete, true);
  assert.equal(turn.rows[0].incomplete, 'its parent span was not recorded');
});

test('errors are marked from the status, the error class or an explicit failure', () => {
  const [turn] = buildInteractions([
    span('i1', 'claude_code.interaction', 0, 5_000, null),
    span('l1', 'claude_code.llm_request', 0, 900, 'i1', { error_class: 'rate_limit_error' }),
    span('e1', 'claude_code.tool.execution', 1_000, 1_100, 'i1', { success: false }),
    span('l2', 'claude_code.llm_request', 1_200, 1_300, 'i1', {}),
  ]);
  assert.deepEqual(turn.rows.map((r) => r.error), [true, true, false]);
});

test('interactions are attached to the latest turn that started before them, and never to a turn after', () => {
  const traces = buildInteractions([
    span('i1', 'claude_code.interaction', 1_000, 2_000, null, {}, '1'.repeat(32)),
    span('i2', 'claude_code.interaction', 61_000, 70_000, null, {}, '2'.repeat(32)),
    span('i0', 'claude_code.interaction', -120_000, -110_000, null, {}, '0'.repeat(32)),
  ]);
  const map = tracesByTurn([T + 60_000, T + 1_500], traces);
  assert.deepEqual(map.get(T + 1_500)?.map((t) => t.traceId), ['1'.repeat(32)], 'the hook may land just after the span opens');
  assert.deepEqual(map.get(T + 60_000)?.map((t) => t.traceId), ['2'.repeat(32)]);
  assert.equal([...map.values()].flat().some((t) => t.traceId === '0'.repeat(32)), false,
    'a trace older than every turn on screen is left out, not attached to the oldest');
});
