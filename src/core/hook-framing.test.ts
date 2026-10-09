// Real temporary sockets and the actual relay; no database, agent, or owner home.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { connect, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { writeHookFiles } from './hooks.ts';
import { CoreServer, type ServerOptions } from './server.ts';

const TOKEN = 'fixture-hook-fragments-token';
const HEADER = `${TOKEN} PreToolUse\n`;

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'wg-hook-frame-'));
  const home = join(dir, 'home');
  mkdirSync(home);
  const events: { event: string; input: unknown }[] = [];
  const path = join(dir, 'hooks.sock');
  let received = 0;
  const accepted: Socket[] = [];
  const server = new CoreServer({
    socketPath: join(dir, 'core.sock'), hookSocketPath: path, ownerToken: 'fixture-owner',
    handlers: {} as ServerOptions['handlers'], bus: {} as ServerOptions['bus'],
    sessions: {
      onData() {},
      byToken(token: string) { return token === TOKEN ? { id: 'fixture' } : null; },
      hook(_id: string, event: string, input: unknown) { events.push({ event, input }); return 'fixture-reply'; },
    } as unknown as ServerOptions['sessions'],
    log(line) { assert.fail(line); }, onIdleStop() {},
  });
  await server.listen();
  // Observe delivery at the socket boundary so fragments cannot coalesce and
  // accidentally turn this into a single-buffer test. No timing sleep is used.
  (server as unknown as { hooks: Server }).hooks.on('connection', socket => {
    accepted.push(socket);
    socket.on('data', (chunk: Buffer) => { received += chunk.byteLength; });
  });
  return {
    dir, home, path, events,
    get serverPeer() { return accepted.at(-1) as Socket; },
    async write(socket: Socket, chunk: Buffer | string) {
      const expected = received + Buffer.byteLength(chunk);
      socket.write(chunk);
      while (received < expected) await new Promise<void>(resolve => setImmediate(resolve));
    },
    async close() { await server.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

async function peer(path: string, allowHalfOpen = false) {
  const socket = connect({ path, allowHalfOpen });
  const reply = new Promise<string>((resolve, reject) => {
    let text = '';
    socket.on('data', chunk => { text += chunk; });
    socket.once('end', () => resolve(text));
    socket.once('error', reject);
  });
  await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  return { socket, reply };
}

test('fragmented hook input is copied linearly and JSON-parsed once, with a reply before client EOF', async (test) => {
  const t = await fixture();
  const concat = Buffer.concat;
  const parse = JSON.parse;
  const set = Uint8Array.prototype.set;
  const iterate = Uint8Array.prototype[Symbol.iterator];
  let copied = 0;
  let parsed = 0;
  let parses = 0;
  let scanned = 0;
  try {
    const body = JSON.stringify({ fixtureHookMarker: true, tool_name: 'Bash', tool_input: { command: 'x'.repeat(16 * 1024) } });
    const wire = Buffer.from(HEADER + body);
    Buffer.concat = (parts, length) => {
      if (parts.length === 2 && (!parts[0]?.length || Buffer.from(parts[0]).toString('utf8', 0, TOKEN.length) === TOKEN)) {
        copied += parts.reduce((n, part) => n + part.length, 0);
      }
      return concat(parts, length);
    };
    JSON.parse = (text, reviver) => {
      if (typeof text === 'string' && text.startsWith('{"fixtureHookMarker"')) { parses++; parsed += text.length; }
      return parse(text, reviver);
    };
    Uint8Array.prototype.set = function (source, offset) { copied += source.length; set.call(this, source, offset); };
    Uint8Array.prototype[Symbol.iterator] = function* () {
      const iterator = iterate.call(this);
      for (let step = iterator.next(); !step.done; step = iterator.next()) { scanned++; yield step.value; }
      return undefined;
    };
    const { socket, reply } = await peer(t.path);
    for (let i = 0; i < wire.length; i += 64) await t.write(socket, wire.subarray(i, i + 64));
    assert.equal(await reply, 'fixture-reply', 'the sender has not ended its write side');
    assert.deepEqual(t.events, [{ event: 'PreToolUse', input: parse(body) }]);
    assert.equal(parses, 1, `a ${wire.length}-byte frame invoked JSON.parse ${parses} times`);
    assert.equal(parsed, body.length);
    assert.ok(copied <= 3 * wire.length, `a ${wire.length}-byte frame copied ${copied} bytes, including buffer growth`);
    assert.equal(scanned, wire.length, 'completion detection visits each incoming byte exactly once');
    test.diagnostic(JSON.stringify({ wireBytes: wire.length, copied, scanned, parses, parsed }));
  } finally {
    Buffer.concat = concat; JSON.parse = parse; Uint8Array.prototype.set = set; Uint8Array.prototype[Symbol.iterator] = iterate;
    await t.close();
  }
});

test('hook header authorization and the total connection byte cap are unchanged', async () => {
  const t = await fixture();
  try {
    for (const [header, accepted] of [
      ['wrong-token PreToolUse', false], [`${TOKEN} PreToolUse1`, false], [`${TOKEN} `, false],
      [` \t${TOKEN}\tPreToolUse ignored`, true],
    ] as const) {
      const before = t.events.length;
      const { socket, reply } = await peer(t.path);
      socket.end(`${header}\n{}`);
      assert.equal(await reply, accepted ? 'fixture-reply' : '');
      assert.equal(t.events.length, before + Number(accepted));
    }
    const before = t.events.length;
    const { socket, reply } = await peer(t.path);
    socket.end(HEADER + JSON.stringify({ text: 'x'.repeat(1024 * 1024) }));
    const text = await reply.catch((error: NodeJS.ErrnoException) => { assert.equal(error.code, 'ECONNRESET'); return ''; });
    assert.equal(text, '');
    assert.equal(t.events.length, before, 'an over-budget frame never reaches the handler');
  } finally { await t.close(); }
});

test('a hook peer cannot exceed the byte cap by continuing to write after its reply', async () => {
  const t = await fixture();
  const { socket, reply } = await peer(t.path, true);
  try {
    const wire = HEADER + '{}';
    await t.write(socket, wire);
    assert.equal(await reply, 'fixture-reply');
    for (let left = 1024 * 1024 - Buffer.byteLength(wire); left > 0;) {
      const size = Math.min(left, 4096);
      await t.write(socket, Buffer.alloc(size, 32));
      left -= size;
    }
    assert.equal(t.serverPeer.destroyed, false, 'the exact total connection budget remains allowed');
    await t.write(socket, ' ');
    assert.equal(t.serverPeer.destroyed, true, 'the first excess byte closes a peer even after its reply');
    assert.equal(t.events.length, 1);
  } finally { socket.destroy(); await t.close(); }
});

test('hook framing preserves objects, arrays, primitives and the existing EOF fallback', async () => {
  const t = await fixture();
  try {
    for (const value of [
      { text: '雪 { braces } [ array ] \\" \\ /', nested: [{ a: '\u2028' }] },
      [1, true, null, { text: '}' }], '雪\\"{}[]', true, false, null, 0, -12.5e4,
    ]) {
      const { socket, reply } = await peer(t.path);
      await t.write(socket, HEADER + JSON.stringify(value) + ' \r\n\t');
      assert.equal(await reply, 'fixture-reply');
      assert.deepEqual(t.events.at(-1), { event: 'PreToolUse', input: value });
    }
    for (const body of ['', ' \t\r\n', '{} trailing', '{}{}', '[}', '{"unfinished":', '1e+']) {
      const before = t.events.length;
      const { socket, reply } = await peer(t.path);
      await t.write(socket, HEADER + body);
      assert.equal(t.events.length, before, 'incomplete or malformed input does not dispatch before EOF');
      socket.end();
      assert.equal(await reply, 'fixture-reply');
      assert.deepEqual(t.events.at(-1), { event: 'PreToolUse', input: {} }, 'retain the prior empty-input fallback at EOF');
    }
    const before = t.events.length;
    const { socket, reply } = await peer(t.path);
    socket.end('header without a newline');
    assert.equal(await reply, '');
    assert.equal(t.events.length, before);
  } finally { await t.close(); }
});

test('a split hook header waits for its body and the actual relay gets its reply without EOF', async () => {
  const t = await fixture();
  try {
    const { socket, reply } = await peer(t.path);
    for (const part of [TOKEN, ' Pre', 'ToolUse\n']) await t.write(socket, part);
    assert.equal(t.events.length, 0);
    const body = Buffer.from(JSON.stringify({ text: '雪\\"{}[]', nested: [{ text: '\\/' }] }));
    for (const byte of body) await t.write(socket, Buffer.from([byte]));
    assert.equal(await reply, 'fixture-reply');
    assert.deepEqual(t.events[0]?.input, JSON.parse(body.toString('utf8')));
    const files = writeHookFiles(t.dir);
    const relayed = await new Promise<string>((resolve, reject) => {
      const child = execFile('/bin/sh', [files.relay, 'PostToolUse'], {
        env: { HOME: t.home, PATH: '/usr/bin:/bin', WANIGAN_HOOK_SOCKET: t.path, WANIGAN_TOKEN: TOKEN }, timeout: 5_000,
      }, (error, stdout) => error ? reject(error) : resolve(stdout));
      child.stdin?.end(JSON.stringify({ tool_name: 'Write', tool_input: { file_path: '/fixture/a.ts' } }));
    });
    assert.equal(relayed, 'fixture-reply');
    assert.deepEqual(t.events.at(-1), { event: 'PostToolUse', input: { tool_name: 'Write', tool_input: { file_path: '/fixture/a.ts' } } });
  } finally { await t.close(); }
});
