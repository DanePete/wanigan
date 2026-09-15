/**
 * Copy and quote helpers, the pure half. The JSONL fixtures are cut down from
 * the shapes on this machine: a Claude Code 2.1.271 transcript (one line per
 * content block, blocks of one message sharing `message.id`, thinking and
 * tool_use blocks between the text) and a Codex 0.153.4 rollout
 * (`response_item` messages and `event_msg` task_complete).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  lastResponseFromClaudeJsonl, lastResponseFromCodexRollout, QUOTE_MAX_CHARS, quoteAsMarkdown, splitMermaid,
  transcriptToMarkdown,
} from './copy-helpers.ts';

const j = (v: unknown) => JSON.stringify(v);

test('the last Claude response is the newest assistant message with text, all of its text blocks, nothing earlier', () => {
  const lines = [
    j({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'fix the bug' }] } }),
    j({ type: 'assistant', message: { id: 'msg_1', role: 'assistant', content: [{ type: 'text', text: 'Let me check the tests.' }] } }),
    j({ type: 'assistant', message: { id: 'msg_1', role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } }),
    j({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } }),
    j({ type: 'assistant', message: { id: 'msg_2', role: 'assistant', content: [{ type: 'thinking', thinking: '' }] } }),
    j({ type: 'assistant', message: { id: 'msg_2', role: 'assistant', content: [{ type: 'text', text: 'Fixed it.' }] } }),
    j({ type: 'assistant', message: { id: 'msg_2', role: 'assistant', content: [{ type: 'text', text: 'The rounding was off by one.' }] } }),
    j({ type: 'assistant', isSidechain: true, message: { id: 'msg_sub', role: 'assistant', content: [{ type: 'text', text: 'subagent chatter' }] } }),
    j({ type: 'ai-title', title: 'x' }),
    '{"type":"assistant","message":{"id":"msg_3",', // a line cut mid-write
  ];
  assert.equal(lastResponseFromClaudeJsonl(lines.join('\n')), 'Fixed it.\n\nThe rounding was off by one.');
});

test('a transcript with no assistant text answers null, not an empty string', () => {
  const lines = [
    j({ type: 'user', message: { role: 'user', content: 'hello' } }),
    j({ type: 'assistant', message: { id: 'm', role: 'assistant', content: [{ type: 'tool_use', name: 'Read' }] } }),
  ];
  assert.equal(lastResponseFromClaudeJsonl(lines.join('\n')), null);
  assert.equal(lastResponseFromClaudeJsonl(''), null);
});

test('the last Codex response is the newest assistant message or task_complete, whichever is later', () => {
  const rollout = [
    j({ type: 'session_meta', payload: { id: 't1', cli_version: '0.153.4' } }),
    j({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] } }),
    j({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'First answer.' }] } }),
    j({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'First answer.' } }),
    j({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Second answer.' }] } }),
    j({ type: 'event_msg', payload: { type: 'token_count', info: {} } }),
  ];
  assert.equal(lastResponseFromCodexRollout(rollout.join('\n')), 'Second answer.');
  const onlyComplete = [j({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'Done.' } })];
  assert.equal(lastResponseFromCodexRollout(onlyComplete.join('\n')), 'Done.');
  assert.equal(lastResponseFromCodexRollout(j({ type: 'event_msg', payload: { type: 'task_started' } })), null);
});

test('a transcript becomes Markdown with tool steps on one line each and tool output counted, not pasted', () => {
  const md = transcriptToMarkdown([
    { at: Date.UTC(2026, 8, 14, 10, 5), role: 'user', text: 'Why is checkout slow?' },
    { at: 0, role: 'tool', text: '', toolName: 'Bash' },
    { at: 0, role: 'tool', text: 'x'.repeat(5000) },
    { at: 0, role: 'tool', text: '', toolName: 'Read' },
    { at: Date.UTC(2026, 8, 14, 10, 6), role: 'assistant', text: 'An N+1 query.\n\n```mermaid\ngraph TD; A-->B\n```' },
  ], { title: 'storefront — Checkout bug', note: 'Archived 12,000 bytes.' });
  assert.match(md, /^# storefront — Checkout bug\n\n> Archived 12,000 bytes\.\n\n## You · 2026-09-14 10:05 UTC\n\nWhy is checkout slow\?\n\n- Tool call: `Bash`\n- Tool result: 5,000 characters, omitted\n- Tool call: `Read`\n\n## Agent/);
  assert.ok(!md.includes('xxxxxxxxxx'));
  assert.ok(md.includes('```mermaid\ngraph TD; A-->B\n```'), 'fenced blocks survive untouched');
  assert.ok(md.endsWith('\n') && !md.includes('\n\n\n'));
});

test('a selection becomes a blockquote without cell padding, escapes or blank edges', () => {
  const q = quoteAsMarkdown('\n\n  first line      \r\n\x1b[31msecond\x1b[0m   \n\n third\x07\n\n');
  assert.deepEqual(q, { text: '>   first line\n> second\n>\n>  third', truncated: false });
  assert.equal(quoteAsMarkdown('   \n  \n'), null);
  const long = quoteAsMarkdown('y'.repeat(QUOTE_MAX_CHARS + 50));
  assert.equal(long?.truncated, true);
  assert.ok(long!.text.endsWith('…'));
});

test('mermaid fences are pulled out in order and every other fence stays prose', () => {
  const text = 'Here:\n```mermaid\ngraph TD\n  A --> B\n```\nand code:\n```ts\nconst x = 1;\n```\n~~~ Mermaid\nsequenceDiagram\n~~~\ntail';
  const segs = splitMermaid(text);
  assert.deepEqual(segs.map((s) => s.kind), ['text', 'mermaid', 'text', 'mermaid', 'text']);
  assert.deepEqual(segs[1], { kind: 'mermaid', source: 'graph TD\n  A --> B', closed: true });
  assert.equal(segs[2].kind === 'text' && segs[2].text, 'and code:\n```ts\nconst x = 1;\n```');
  const cut = splitMermaid('```mermaid\ngraph LR\nA-->');
  assert.deepEqual(cut, [{ kind: 'mermaid', source: 'graph LR\nA-->', closed: false }]);
  assert.deepEqual(splitMermaid('no diagrams'), [{ kind: 'text', text: 'no diagrams' }]);
});
