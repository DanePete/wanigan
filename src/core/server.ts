// The core's two sockets. `core.sock` speaks newline-delimited JSON to the app
// and the CLI; `hooks.sock` takes one hook event per connection from the relay.
import { timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, unlinkSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import type { HookInput } from '../shared/attention.ts';
import { LIVE_STATES } from '../shared/model.ts';
import { CoreError, type WireRequest } from '../shared/protocol.ts';
import { LineReader } from '../shared/line-reader.ts';
import { HookReader, type HookRead } from '../shared/hook-reader.ts';
import type { Bus } from './context.ts';
import { dispatch, type Caller, type Handlers } from './handlers.ts';
import type { Sessions } from './sessions.ts';

const MAX_LINE = 4 * 1024 * 1024;
/** The owner may send a file to attach: 20 MB, as base64, in one line. */
const MAX_OWNER_LINE = 32 * 1024 * 1024;
/** What a session may still do once it has ended. */
const READ_ONLY = new Set(['core.hello', 'cards.list', 'cards.get', 'decisions.list', 'agent.status']);
const MAX_HOOK_BODY = 1024 * 1024;
const MAX_REQUESTS_PER_CONNECTION = 128;
const MAX_REQUESTS = 512;
const MAX_CONNECTIONS = 256;
const MAX_QUEUED_BYTES = 64 * 1024 * 1024;

export interface ServerOptions {
  socketPath: string;
  hookSocketPath: string;
  ownerToken: string;
  handlers: Handlers;
  bus: Bus;
  sessions: Sessions;
  log: (line: string) => void;
  onIdleStop: () => void;
  /** Trusted embedding/test limit; may only lower the 64 MiB hook-output cap. */
  hookReplyLimit?: number;
}

export class CoreServer {
  private main: Server | null = null;
  private hooks: Server | null = null;
  private readonly owners = new Set<Socket>();
  /** Which owner connections are watching which session's terminal. */
  private readonly watchers = new Map<string, Set<Socket>>();
  private lastOwnerSeen = Date.now();
  private active = 0;
  private readonly requests = new WeakMap<Socket, number>();
  private stopping = false;
  private binding: Promise<void> | null = null;
  private closing: Promise<void> | null = null;

  get inFlight(): number { return this.active; }

  /** Called synchronously with the idle check, before another request can enter. */
  stopAfterReply(): void { this.stopping = true; }

  private readonly options: ServerOptions;
  private readonly hookReplyLimit: number;

  constructor(options: ServerOptions) {
    const limit = options.hookReplyLimit ?? MAX_QUEUED_BYTES;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_QUEUED_BYTES) {
      throw new CoreError('invalid', 'Hook reply limit must be a positive integer no greater than 64 MiB.');
    }
    this.hookReplyLimit = limit;
    this.options = options;
  }

  get ownerConnections(): number {
    return this.owners.size;
  }

  get idleSince(): number {
    return this.owners.size ? Date.now() : this.lastOwnerSeen;
  }

  async listen(): Promise<void> {
    this.checkStartup();
    await (this.binding ??= this.bind());
  }

  private async bind(): Promise<void> {
    this.main = await listenOn(this.options.socketPath, (socket) => { if (this.track(socket)) this.connection(socket); });
    this.checkStartup();
    this.hooks = await listenOn(this.options.hookSocketPath, (socket) => { if (this.track(socket)) this.hookConnection(socket); });
    this.checkStartup();
    this.options.sessions.onData((sessionId, seq, data) => {
      const set = this.watchers.get(sessionId);
      if (!set) return;
      const line = `${JSON.stringify({ event: 'pty.data', data: { sessionId, seq, data } })}\n`;
      for (const socket of set) this.send(socket, line);
    });
  }

  private checkStartup(): void {
    if (this.stopping) throw new CoreError('refused', 'Wanigan’s core is stopping. Start a new core instead.');
  }

  /** Every open connection, so stopping never waits on a client that stays connected (an agent's, a window's). */
  private readonly open = new Set<Socket>();

  private track(socket: Socket): boolean {
    if (this.stopping || this.open.size >= MAX_CONNECTIONS) { socket.destroy(); return false; }
    this.open.add(socket);
    socket.once('close', () => this.open.delete(socket));
    return true;
  }

  /** A stalled window must not accumulate terminal output or replies indefinitely. */
  private send(socket: Socket, line: string, after?: () => void): void {
    if (socket.destroyed) { after?.(); return; }
    if (socket.writableLength + Buffer.byteLength(line) > MAX_QUEUED_BYTES) {
      socket.destroy();
      after?.();
      return;
    }
    // Socket string queues count code units. Buffers keep writableLength in
    // bytes, including any earlier multibyte output still waiting to drain.
    socket.write(Buffer.from(line, 'utf8'), () => after?.());
  }

  close(): Promise<void> {
    this.stopping = true;
    return this.closing ??= this.shutdown();
  }

  private async shutdown(): Promise<void> {
    for (const socket of this.open) socket.destroy();
    // A native bind can finish after close was requested. Keep ownership until
    // that short transition settles, then close the actual server it created.
    // This does not wait for Phone startup or another external command.
    await this.binding?.catch(() => {});
    await Promise.all([closeServer(this.main), closeServer(this.hooks)]);
    for (const path of [this.options.socketPath, this.options.hookSocketPath]) {
      try { unlinkSync(path); } catch { /* gone */ }
    }
  }

  private connection(socket: Socket): void {
    let caller: Caller | null = null;
    const reader = new LineReader();
    let unsubscribe: (() => void) | null = null;
    socket.setEncoding('utf8');
    const authenticateBy = setTimeout(() => socket.destroy(), 5_000);
    socket.once('close', () => clearTimeout(authenticateBy));

    const send = (value: unknown, after?: () => void): void => {
      this.send(socket, `${JSON.stringify(value)}\n`, after);
    };

    socket.on('data', (chunk: string) => {
      const withinLimit = reader.read(chunk, () => caller ? caller.role === 'owner' ? MAX_OWNER_LINE : MAX_LINE : 4_096, (line) => {
        if (!line.trim()) return true;
        let message: unknown;
        try { message = JSON.parse(line); } catch { send({ error: { code: 'invalid', message: 'Not JSON.' } }); return true; }

        if (!caller) {
          caller = this.authenticate(socket, message);
          if (!caller) { send({ error: { code: 'unauthorized', message: 'Unknown token.' } }); socket.end(); return false; }
          clearTimeout(authenticateBy);
          send({ ready: true, role: caller.role });
          if (caller.role === 'owner') {
            this.owners.add(socket);
            unsubscribe = this.options.bus.on((event, data) => send({ event, data }));
          }
          return true;
        }
        void this.request(socket, caller, message, send);
        return !socket.destroyed;
      });
      if (!withinLimit) socket.destroy();
    });

    const cleanup = (): void => {
      unsubscribe?.();
      if (this.owners.delete(socket)) this.lastOwnerSeen = Date.now();
      for (const set of this.watchers.values()) set.delete(socket);
    };
    socket.on('close', cleanup);
    socket.on('error', cleanup);
  }

  private async request(socket: Socket, caller: Caller, message: unknown, send: (v: unknown, after?: () => void) => void): Promise<void> {
    const req = message && typeof message === 'object' && !Array.isArray(message) ? message as Partial<WireRequest> : {};
    const id = typeof req.id === 'number' && Number.isSafeInteger(req.id) && req.id > 0 ? req.id : 0;
    const method = typeof req.method === 'string' ? req.method : '';
    const pending = this.requests.get(socket) ?? 0;
    if (pending >= MAX_REQUESTS_PER_CONNECTION || this.active >= MAX_REQUESTS) {
      send({ id, error: { code: 'refused', message: 'Too many simultaneous requests. Wait for some to finish.' } });
      return;
    }
    this.requests.set(socket, pending + 1);
    this.active++;
    try {
      if (!id || !method || method.length > 128) throw new CoreError('invalid', 'A request needs a positive integer id and a method name.');
      if (this.stopping) throw new CoreError('refused', 'Wanigan’s core is stopping for an update. Try again once it reconnects.');
      // A session's identity is re-read on every request: a session that has
      // ended keeps its token, but not the right to change the board.
      let who: Caller = caller;
      if (caller.role === 'session') {
        const current = this.options.sessions.byToken(this.tokenOf(socket));
        if (!current) throw new CoreError('unauthorized', 'This session no longer exists.');
        if (!LIVE_STATES.has(current.state) && !READ_ONLY.has(method)) {
          throw new CoreError('forbidden', 'This session has ended; it can read the board but not change it.');
        }
        who = { role: 'session', session: current };
      }
      const result = await dispatch(this.options.handlers, method, req.params, who);
      if (method === 'sessions.watch' || method === 'sessions.unwatch') {
        const sessionId = String((req.params as { id?: unknown })?.id);
        const set = this.watchers.get(sessionId) ?? new Set<Socket>();
        if (method === 'sessions.watch') set.add(socket); else set.delete(socket);
        this.watchers.set(sessionId, set);
      }
      // The core owns its shutdown once accepted, even if the window goes away.
      const after = method === 'core.stopIfIdle' && this.stopping ? this.options.onIdleStop : undefined;
      send({ id, result }, after);
    } catch (error) {
      const e = error instanceof CoreError ? error : new CoreError('internal', (error as Error)?.message ?? String(error));
      if (e.code === 'internal') this.options.log(`internal error in ${method}: ${(error as Error)?.stack ?? error}`);
      send({ id, error: { code: e.code, message: e.message } });
    } finally {
      this.active--;
      this.requests.set(socket, (this.requests.get(socket) ?? 1) - 1);
    }
  }

  private readonly tokens = new WeakMap<Socket, string>();

  private tokenOf(socket: Socket): string {
    return this.tokens.get(socket) ?? '';
  }

  private authenticate(socket: Socket, message: unknown): Caller | null {
    const token = (message as { token?: unknown })?.token;
    if (typeof token !== 'string' || !token) return null;
    if (safeEqual(token, this.options.ownerToken)) return { role: 'owner' };
    const session = this.options.sessions.byToken(token);
    if (!session) return null;
    this.tokens.set(socket, token);
    return { role: 'session', session };
  }

  private hookConnection(socket: Socket): void {
    const reader = new HookReader(MAX_HOOK_BODY);
    let done = false;
    let received = 0;
    const expires = setTimeout(() => socket.destroy(), 5_000);
    socket.once('close', () => clearTimeout(expires));

    const finish = (read: HookRead): void => {
      if (done) return;
      if (read.kind === 'too-large') { done = true; socket.destroy(); return; }
      if (read.kind !== 'frame') return;
      const [token = '', event = ''] = read.frame.header.trim().split(/\s+/);
      const input = read.frame.input as HookInput;
      done = true;
      let reply = '';
      try {
        const session = this.options.sessions.byToken(token);
        if (session && /^[A-Za-z]{1,40}$/.test(event)) reply = this.options.sessions.hook(session.id, event, input);
      } catch (error) {
        this.options.log(`hook ${event} failed: ${(error as Error).message}`);
      }
      // The reply is already serialized. This bounds bytes admitted to this
      // socket, not the earlier string allocation or briefing construction.
      if (Buffer.byteLength(reply, 'utf8') > this.hookReplyLimit) { socket.destroy(); return; }
      socket.end(reply);
    };

    socket.on('data', (chunk: Buffer) => {
      // Keep the whole-connection quota even after replying to its one frame,
      // without retaining or parsing bytes from a peer that keeps writing.
      if (chunk.byteLength > MAX_HOOK_BODY - received) { socket.destroy(); return; }
      received += chunk.byteLength;
      if (!done) finish(reader.read(chunk));
    });
    socket.on('end', () => { finish(reader.end()); if (!done) socket.end(); });
    socket.on('error', () => socket.destroy());
  }
}

function listenOn(path: string, onConnection: (socket: Socket) => void): Promise<Server> {
  if (existsSync(path)) unlinkSync(path);
  return new Promise((resolve, reject) => {
    const server = createServer(onConnection);
    server.once('error', reject);
    server.listen(path, () => {
      chmodSync(path, 0o600);
      resolve(server);
    });
  });
}

function closeServer(server: Server | null): Promise<void> {
  return new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()));
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
