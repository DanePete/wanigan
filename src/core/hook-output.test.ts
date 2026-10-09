// Real owned sockets; the hook producer is a stand-in, with no database or agent.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { CoreClient } from '../client/client.ts';
import type { Hello } from '../shared/protocol.ts';
import { Bus } from './context.ts';
import { CoreServer, type ServerOptions } from './server.ts';

const TOKEN = 'fixture-hook-output-token';
const MAX_REPLY = 64 * 1024 * 1024;
// This intersection lets the same tests run on the pristine server, which ignores
// the proposed trusted option. Red must be a wire outcome, not a type error.
type Options = ServerOptions & { hookReplyLimit?: number };
const hello: Hello = { version: 'fixture', role: 'owner', sessionId: null, projectId: null, dataDir: null, demo: true, build: null, pid: null };

function options(dir: string, limit: number | undefined, hook: () => string, logs: string[]): Options {
  return {
    socketPath: join(dir, 'core.sock'), hookSocketPath: join(dir, 'hooks.sock'), ownerToken: 'fixture-owner',
    bus: new Bus(), handlers: { 'core.hello': () => hello } as unknown as ServerOptions['handlers'],
    sessions: {
      onData() {}, byToken: (token: string) => token === TOKEN ? { id: 'fixture' } : null,
      hook,
    } as unknown as ServerOptions['sessions'],
    hookReplyLimit: limit, log: (message) => logs.push(message), onIdleStop() {},
  };
}

async function fixture(limit: number) {
  const dir = mkdtempSync(join(tmpdir(), 'wg-hook-output-'));
  const logs: string[] = [];
  const peers: Socket[] = [];
  const clients: CoreClient[] = [];
  let reply = '', processed = 0, throws = false;
  const configuration = options(dir, limit, () => {
    processed++;
    if (throws) throw new Error('owned-hook-failure');
    return reply;
  }, logs);
  const server = new CoreServer(configuration);
  try { await server.listen(); }
  catch (error) { await server.close(); rmSync(dir, { recursive: true, force: true }); throw error; }
  return {
    logs, configuration,
    get processed() { return processed; },
    setReply(value: string) { reply = value; throws = false; },
    throwReply() { throws = true; },
    async owner() {
      const client = await CoreClient.connect(configuration.socketPath, 'fixture-owner');
      clients.push(client); return client;
    },
    async hook() {
      const socket = connect(configuration.hookSocketPath); peers.push(socket);
      const chunks: Buffer[] = [];
      const result = new Promise<Buffer>((resolve, reject) => {
        socket.on('data', (chunk: Buffer) => chunks.push(chunk));
        socket.on('error', (error: NodeJS.ErrnoException) => { if (error.code !== 'ECONNRESET') reject(error); });
        socket.once('close', () => resolve(Buffer.concat(chunks)));
      });
      socket.once('connect', () => socket.end(`${TOKEN} SessionStart\n{}`));
      return result;
    },
    async close() {
      for (const socket of peers) socket.destroy();
      for (const client of clients) client.close();
      await server.close(); rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('the exact UTF-8 hook reply cap, empty replies and synchronous hook failures retain their outcomes', { timeout: 5_000 }, async (t) => {
  const f = await fixture(26); t.after(() => f.close());
  const reply = '{"text":"界界界界界"}'; // 26 UTF-8 bytes, 16 code units.
  f.setReply(reply);
  assert.deepEqual(await f.hook(), Buffer.from(reply, 'utf8'));
  f.setReply('');
  assert.equal((await f.hook()).length, 0);
  f.throwReply();
  assert.equal((await f.hook()).length, 0);
  assert.equal(f.processed, 3, 'each event is processed once even for an empty or throwing producer');
  assert.deepEqual(f.logs, ['hook SessionStart failed: owned-hook-failure']);
});

test('one UTF-8 byte over the hook cap sends no prefix while another owner and later hook remain usable', { timeout: 5_000 }, async (t) => {
  const f = await fixture(25); t.after(() => f.close());
  const owner = await f.owner();
  f.setReply('{"text":"界界界界界"}');
  // Caller mutation cannot raise the validated per-server budget after construction.
  f.configuration.hookReplyLimit = MAX_REPLY;
  assert.equal((await f.hook()).length, 0, 'the 26-byte reply must be refused whole');
  assert.equal(f.processed, 1, 'reply refusal must not skip the hook event');
  assert.equal((await owner.call('core.hello', {})).version, 'fixture');
  f.setReply('ok');
  assert.equal((await f.hook()).toString('utf8'), 'ok');
  assert.equal(f.processed, 2);
  assert.equal((await owner.call('core.hello', {})).version, 'fixture');
  assert.deepEqual(f.logs, []);
});

test('the hook cap includes JSON escaping in the already serialized reply', { timeout: 5_000 }, async (t) => {
  const f = await fixture(34); t.after(() => f.close());
  f.setReply('{"text":"\\u0000\\u0000\\u0000\\u0000"}'); // 35 wire bytes; four decoded characters.
  assert.equal((await f.hook()).length, 0, 'wire bytes must fit, not only the decoded context');
  assert.equal(f.processed, 1);
  f.setReply('{"text":""}');
  assert.equal((await f.hook()).toString('utf8'), '{"text":""}');
});

test('trusted hook limits cannot disable or raise the default cap', () => {
  for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_REPLY + 1]) {
    assert.throws(() => new CoreServer(options('/owned-not-opened', limit, () => '', [])), /Hook reply limit/, String(limit));
  }
  for (const limit of [undefined, 1, MAX_REPLY]) {
    assert.doesNotThrow(() => new CoreServer(options('/owned-not-opened', limit, () => '', [])));
  }
});
