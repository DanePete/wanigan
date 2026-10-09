// A typed connection to the core over its Unix socket. Used by the Electron main
// process, the CLI and the tests.
import { connect, type Socket } from 'node:net';
import { CoreError, type ErrorCode, type Method, type Params, type Result, type Role, type WireError } from '../shared/protocol.ts';
import { LineReader } from '../shared/line-reader.ts';

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

// Match the server's per-connection admission and role-specific framing limits.
// Its LineReader counts UTF-16 code units, excluding the terminating newline.
const MAX_PENDING = 128;
const MAX_OWNER_LINE_CHARS = 32 * 1024 * 1024;
const MAX_SESSION_LINE_CHARS = 4 * 1024 * 1024;
const MAX_QUEUED_BYTES = 64 * 1024 * 1024;

const ERROR_CODES: Record<ErrorCode, true> = { unauthorized: true, forbidden: true, not_found: true, invalid: true, refused: true, conflict: true, internal: true };

function wireError(value: unknown): value is WireError {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const error = value as Record<string, unknown>;
  return typeof error.code === 'string' && Object.hasOwn(ERROR_CODES, error.code) && typeof error.message === 'string';
}

export class CoreClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(event: string, data: unknown) => void>();
  private readonly closeListeners = new Set<() => void>();
  private closed = false;

  private readonly socket: Socket;
  readonly role: Role;

  private constructor(socket: Socket, role: Role) {
    this.socket = socket;
    this.role = role;
  }

  static connect(socketPath: string, token: string, timeoutMs = 5_000): Promise<CoreClient> {
    return new Promise((resolve, reject) => {
      const socket = connect(socketPath);
      socket.setEncoding('utf8');
      const reader = new LineReader();
      let client: CoreClient | null = null;
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('Timed out connecting to Wanigan’s core.')); }, timeoutMs);

      socket.on('data', (chunk: string) => {
        const withinLimit = reader.read(chunk, () => client ? 32 * 1024 * 1024 : 4_096, (line) => {
          if (!line) return true;
          let message: Record<string, unknown>;
          try {
            const value: unknown = JSON.parse(line);
            if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Not an object.');
            message = value as Record<string, unknown>;
            if ('error' in message && !wireError(message.error)) throw new Error('Not a protocol error.');
            if (!client && 'ready' in message && (message.ready !== true || (message.role !== 'owner' && message.role !== 'session'))) {
              throw new Error('Not a core handshake.');
            }
          } catch {
            // Not the core's protocol: give up on this connection rather than throw out of the socket.
            const error = new Error('Wanigan’s core sent something unreadable.');
            clearTimeout(timer);
            if (client) client.fail(error); else reject(error);
            socket.destroy();
            return false;
          }
          if (!client) {
            clearTimeout(timer);
            if (message.ready) {
              client = new CoreClient(socket, message.role as Role);
              resolve(client);
            } else {
              const error = message.error as WireError | undefined;
              reject(new CoreError(error?.code ?? 'unauthorized', error?.message ?? 'Refused.'));
              socket.destroy();
              return false;
            }
            return true;
          }
          client.receive(message);
          return !socket.destroyed;
        });
        if (!withinLimit) {
          const error = new Error('Wanigan’s core sent a reply that is too large.');
          clearTimeout(timer);
          if (client) client.fail(error); else reject(error);
          socket.destroy();
        }
      });
      socket.on('error', (error) => { clearTimeout(timer); if (client) client.fail(error); else reject(error); });
      const disconnected = (): void => {
        clearTimeout(timer);
        const error = new Error('The connection to Wanigan’s core closed.');
        if (client) client.fail(error); else reject(error);
      };
      socket.on('end', disconnected);
      socket.on('close', disconnected);
      socket.on('connect', () => socket.write(Buffer.from(`${JSON.stringify({ token })}\n`, 'utf8')));
    });
  }

  call<M extends Method>(method: M, params: Params<M>): Promise<Result<M>> {
    if (this.closed) return Promise.reject(new Error('Not connected to Wanigan’s core.'));
    if (this.pending.size >= MAX_PENDING) return Promise.reject(new CoreError('refused', 'Too many simultaneous requests. Wait for some to finish.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      // Encoding can throw (cyclic input, for example), before any request exists.
      const body = JSON.stringify({ id, method, params });
      if (this.closed) { reject(new Error('Not connected to Wanigan’s core.')); return; }
      // Caller-defined toJSON can reenter this client while encoding the body.
      if (this.pending.size >= MAX_PENDING) { reject(new CoreError('refused', 'Too many simultaneous requests. Wait for some to finish.')); return; }
      const max = this.role === 'owner' ? MAX_OWNER_LINE_CHARS : MAX_SESSION_LINE_CHARS;
      if (body.length > max) { reject(new CoreError('refused', 'This request is too large to send to Wanigan’s core.')); return; }
      const line = `${body}\n`;
      if (this.socket.writableLength + Buffer.byteLength(line) > MAX_QUEUED_BYTES) {
        reject(new CoreError('refused', 'Too much data is waiting to reach Wanigan’s core. Wait for the connection to catch up.'));
        return;
      }
      // Socket string queues count code units. Buffers make writableLength a
      // byte count, including earlier multibyte requests waiting to drain.
      const bytes = Buffer.from(line, 'utf8');
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      try {
        this.socket.write(bytes, (error) => { if (error) this.fail(error); });
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error('Could not write to Wanigan’s core.'));
      }
    });
  }

  /** Untyped call, for bridges that forward a method name they have already allowlisted. */
  callRaw(method: string, params: unknown): Promise<unknown> {
    return this.call(method as Method, params as never);
  }

  on(listener: (event: string, data: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  close(): void {
    this.fail(new Error('Closed.'));
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private receive(message: Record<string, unknown>): void {
    if (typeof message.event === 'string') {
      for (const l of this.listeners) l(message.event, message.data);
      return;
    }
    const pending = this.pending.get(message.id as number);
    if (!pending) return;
    this.pending.delete(message.id as number);
    if (message.error) {
      const e = message.error as WireError;
      pending.reject(new CoreError(e.code, e.message));
    } else {
      pending.resolve(message.result);
    }
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    // Rejected work must not keep a socket alive waiting for an unread write queue.
    this.socket.destroy();
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear();
    for (const l of this.closeListeners) l();
  }
}
