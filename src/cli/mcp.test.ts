// `wanigan mcp` as an MCP client sees it: JSON-RPC 2.0 a line at a time, the
// protocol version negotiated, the tools and what they return, and errors in
// true words. The core is a stand-in here; src/core/live-agent.test.ts runs
// the real shim against a real core.
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { MCP_VERSIONS, TOOLS, negotiate, serveMcp, type McpCore } from './mcp.ts';

interface Reply { id?: unknown; result?: Record<string, unknown>; error?: { code: number; message: string } }

function server(core: Partial<McpCore> & { call?: McpCore['call'] } = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const calls: [string, unknown][] = [];
  const replies: Reply[] = [];
  let buffer = '';
  output.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let at: number;
    while ((at = buffer.indexOf('\n')) >= 0) { replies.push(JSON.parse(buffer.slice(0, at)) as Reply); buffer = buffer.slice(at + 1); }
  });
  let connects = 0;
  const done = serveMcp({
    input, output, version: '2.0.0-test', log: () => {},
    connect: async () => {
      connects++;
      return {
        call: core.call ?? (async (method, params) => { calls.push([method, params]); return { text: `read ${method}`, structured: { method }, image: null }; }),
        close: () => {},
      };
    },
  });
  const send = (message: unknown): void => { input.write(`${typeof message === 'string' ? message : JSON.stringify(message)}\n`); };
  const ask = async (id: number, method: string, params?: unknown): Promise<Reply> => {
    send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
    for (let i = 0; i < 200; i++) {
      const r = replies.find((x) => x.id === id);
      if (r) return r;
      await new Promise((ok) => setTimeout(ok, 5));
    }
    throw new Error(`no reply to ${method}`);
  };
  return { send, ask, replies, calls, done, end: () => input.end(), connects: () => connects };
}

test('the protocol version a client asks for is answered when this server speaks it, else the newest', async () => {
  assert.equal(negotiate('2025-06-18'), '2025-06-18');
  assert.equal(negotiate('2024-11-05'), '2024-11-05');
  assert.equal(negotiate('2026-07-28'), MCP_VERSIONS[0], 'a revision it does not speak gets the newest it does');
  assert.equal(negotiate(undefined), '2025-11-25');
  const s = server();
  const init = await s.ask(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.1.293' } });
  assert.equal(init.result?.protocolVersion, '2025-06-18');
  assert.deepEqual(init.result?.capabilities, { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false } });
  assert.deepEqual(init.result?.serverInfo, { name: 'wanigan', title: 'Wanigan live view', version: '2.0.0-test' });
  assert.match(String(init.result?.instructions), /live_status says what is on/);
  s.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.deepEqual((await s.ask(2, 'ping')).result, {});
  const old = await s.ask(3, 'initialize', { protocolVersion: '2024-11-05' });
  assert.equal(old.result?.protocolVersion, '2024-11-05');
  assert.equal(old.result?.instructions, undefined, 'instructions only from the revision that has them');
  assert.equal(s.replies.filter((r) => r.id === undefined).length, 0, 'a notification is never answered');
  s.end();
  await s.done;
});

test('tools/list gives six read-only tools whose schemas name only what each takes', async () => {
  const s = server();
  const list = await s.ask(1, 'tools/list');
  const tools = list.result?.tools as { name: string; description: string; inputSchema: { properties: Record<string, unknown>; required?: string[] }; annotations: Record<string, unknown> }[];
  assert.deepEqual(tools.map((t) => t.name), ['live_status', 'live_look', 'live_find', 'live_part', 'live_problems', 'live_diff']);
  for (const t of tools) {
    assert.equal(t.annotations.readOnlyHint, true, t.name);
    assert.equal(t.annotations.destructiveHint, false, t.name);
    assert.equal(t.annotations.openWorldHint, false, t.name);
    assert.ok(t.description.length > 120, `${t.name} says enough for a model to choose it`);
  }
  assert.deepEqual(Object.keys(tools[1]!.inputSchema.properties), ['path', 'width', 'image', 'full_page', 'part', 'all']);
  assert.deepEqual(tools[2]!.inputSchema.required, ['query']);
  assert.deepEqual(tools[3]!.inputSchema.required, ['id']);
  s.end();
  await s.done;
});

test('a tool call reaches the core as its method, with only the arguments given, and comes back as content', async () => {
  const s = server();
  const look = await s.ask(1, 'tools/call', { name: 'live_look', arguments: { path: '/about', width: 375, full_page: true, ignored: 'x' } });
  assert.deepEqual(s.calls[0], ['live.look', { path: '/about', width: 375, fullPage: true }]);
  assert.deepEqual(look.result, { content: [{ type: 'text', text: 'read live.look' }], structuredContent: { method: 'live.look' }, isError: false });
  await s.ask(2, 'tools/call', { name: 'live_problems', arguments: { since_turn: true } });
  assert.deepEqual(s.calls[1], ['live.problems', { sinceTurn: true }]);
  await s.ask(3, 'tools/call', { name: 'live_status' });
  assert.deepEqual(s.calls[2], ['live.status', {}]);
  assert.equal(s.connects(), 1, 'one connection to the core, kept');
  const unknown = await s.ask(4, 'tools/call', { name: 'live_edit', arguments: {} });
  assert.equal(unknown.error?.code, -32602);
  assert.match(unknown.error!.message, /Unknown tool: live_edit\. The tools are live_status, live_look/);
  s.end();
  await s.done;
});

test('a picture comes as an image block; a refusal is an error result in the core’s own words', async () => {
  const s = server({
    call: async (method) => {
      if (method === 'live.diff') throw Object.assign(new Error('Screenshots are off in Settings › Live view, so there is no before to compare with.'), { code: 'refused' });
      return { text: 'the page', structured: {}, image: { data: 'aGVsbG8=', mimeType: 'image/jpeg', width: 10, height: 10, rect: { x: 0, y: 0, width: 10, height: 10 }, cut: false } };
    },
  });
  const look = await s.ask(1, 'tools/call', { name: 'live_look', arguments: { image: true } });
  assert.deepEqual((look.result?.content as unknown[])[1], { type: 'image', data: 'aGVsbG8=', mimeType: 'image/jpeg' });
  const diff = await s.ask(2, 'tools/call', { name: 'live_diff', arguments: {} });
  assert.deepEqual(diff.result, { content: [{ type: 'text', text: 'Screenshots are off in Settings › Live view, so there is no before to compare with.' }], isError: true });
  s.end();
  await s.done;
});

test('outside a session it still lists its tools, and says plainly why a call cannot work', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines: string[] = [];
  output.on('data', (c: Buffer) => lines.push(...c.toString().split('\n').filter(Boolean)));
  const done = serveMcp({ input, output, version: 'x', log: () => {}, connect: async () => { throw new Error('The live view’s tools work only inside a session Wanigan started.'); } });
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`);
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'live_status' } })}\n`);
  input.end();
  await done;
  const replies = lines.map((l) => JSON.parse(l) as Reply);
  assert.equal((replies.find((r) => r.id === 1)!.result!.tools as unknown[]).length, 6);
  assert.deepEqual(replies.find((r) => r.id === 2)!.result, { content: [{ type: 'text', text: 'The live view’s tools work only inside a session Wanigan started.' }], isError: true });
});

test('resources read the same as the tools; bad input gets JSON-RPC errors, not silence', async () => {
  const s = server();
  const list = await s.ask(1, 'resources/list');
  assert.deepEqual((list.result?.resources as { uri: string }[]).map((r) => r.uri), ['wanigan://live/status', 'wanigan://live/page', 'wanigan://live/problems']);
  const read = await s.ask(2, 'resources/read', { uri: 'wanigan://live/page' });
  assert.deepEqual(read.result, { contents: [{ uri: 'wanigan://live/page', mimeType: 'text/plain', text: 'read live.look' }] });
  assert.equal((await s.ask(3, 'resources/read', { uri: 'file:///etc/passwd' })).error?.code, -32002);
  assert.deepEqual((await s.ask(4, 'resources/templates/list')).result, { resourceTemplates: [] });
  assert.equal((await s.ask(5, 'prompts/list')).error?.code, -32601);
  s.send('{not json');
  s.send('[1,2]');
  await new Promise((ok) => setTimeout(ok, 30));
  assert.deepEqual(s.replies.filter((r) => r.id === null).map((r) => r.error?.code), [-32700, -32600]);
  assert.equal(TOOLS.length, 6);
  s.end();
  await s.done;
});
