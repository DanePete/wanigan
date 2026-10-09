// Finding, starting and staying connected to the core. The core is started
// detached, so it outlives this process: quitting Wanigan never ends a session.
//
// Two things stop the app from just using whatever answers. A core that could
// not start says why, and is not started again until the owner asks. And a
// core left running by another build (a pull, an upgrade, dev and the packaged
// app on one data folder) is replaced when nothing runs in it, and otherwise
// the owner is asked: its live sessions would end with it.
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync } from 'node:fs';
import { connect } from 'node:net';
import { CoreClient } from '../client/client.ts';
import { buildOf, corePaths, type CorePaths } from '../core/paths.ts';
import type { CoreProblem, CoreStatus } from '../shared/bridge.ts';
import type { Hello } from '../shared/protocol.ts';

export interface CoreProcessOptions {
  dataDir: string;
  coreEntry: string;
  cliEntry: string;
  socketPath: string;
  runtime: string;
  /** Extra arguments for the core, such as `--demo`. */
  coreArgs?: string[];
  /** How long a new core has to answer. */
  startTimeoutMs?: number;
}

/** A core that was started and did not come up, with what it said. */
export class CoreStartError extends Error {
  readonly log: string;
  constructor(reason: string, log: string) {
    super(reason);
    this.name = 'CoreStartError';
    this.log = log;
  }
}

export class CoreConnection {
  private client: CoreClient | null = null;
  private status: CoreStatus = 'connecting';
  private trouble: CoreProblem | null = null;
  private readonly statusListeners = new Set<(s: CoreStatus) => void>();
  private readonly problemListeners = new Set<(p: CoreProblem | null) => void>();
  private readonly eventListeners = new Set<(event: string, data: unknown) => void>();
  private connecting: Promise<CoreClient> | null = null;
  /** Set by a deliberate close (the app quitting), which must not reconnect. */
  private closing = false;
  /** A core from another build the owner chose to keep using, by pid: not asked about again. */
  private kept: number | null = null;
  private readonly options: CoreProcessOptions;
  private readonly paths: CorePaths;
  /** The build of the core this app would start; null when its entry cannot be read. */
  readonly build: string | null;

  constructor(options: CoreProcessOptions) {
    this.options = options;
    this.paths = corePaths(options.dataDir);
    this.build = buildOf(options.coreEntry);
  }

  get current(): CoreStatus {
    return this.status;
  }

  get problem(): CoreProblem | null {
    return this.trouble;
  }

  onStatus(listener: (s: CoreStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  onProblem(listener: (p: CoreProblem | null) => void): () => void {
    this.problemListeners.add(listener);
    return () => this.problemListeners.delete(listener);
  }

  onEvent(listener: (event: string, data: unknown) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /** A connected client, starting the core first if nothing is answering. */
  async get(): Promise<CoreClient> {
    if (this.closing) throw new Error('Closed.');
    // A core that could not start is not started again, and waited for again,
    // on every call: only when the owner asks.
    if (this.trouble?.kind === 'failed') throw new CoreStartError(this.trouble.reason, this.trouble.log);
    if (this.client && !this.client.isClosed) return this.client;
    this.connecting ??= this.establish().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  /** "Try again", after the core could not start. */
  retry(): Promise<CoreClient> {
    if (this.trouble?.kind === 'failed') this.report(null);
    return this.get();
  }

  /** "Keep using it": a core from another build stays, and is not asked about again while it runs. */
  keep(): void {
    if (this.trouble?.kind !== 'other-build') return;
    this.kept = this.trouble.pid;
    this.report(null);
  }

  /** "Restart": stop a core from another build, ending its live sessions, and start this build's. */
  restart(): Promise<CoreClient> {
    const trouble = this.trouble;
    if (trouble?.kind !== 'other-build') return this.get();
    this.report(null);
    const old = this.client;
    this.client = null;
    old?.close();
    const before = this.connecting;
    // Held as the connection in progress, so no call reaches the old core meanwhile.
    this.connecting = (async () => {
      await before?.catch(() => null);
      this.setStatus('connecting');
      await stopCoreProcess(trouble.pid, this.options.socketPath);
      return this.establish();
    })().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  /** Disconnect for good. The core and its sessions keep running. */
  close(): void {
    this.closing = true;
    this.client?.close();
  }

  private async establish(): Promise<CoreClient> {
    this.setStatus('connecting');
    try {
      let client = await this.connectOrStart();
      const hello = await client.call('core.hello', {});
      const pid = hello.pid ?? pidOf(this.paths);
      if (this.otherBuild(hello) && pid && pid !== this.kept) {
        // Only the old core can atomically decide it is idle and exclude a
        // racing start. Older builds cannot promise that, so ask the owner.
        const idle = await client.call('core.stopIfIdle', {}).catch((error: unknown) => {
          if ((error as { code?: string }).code === 'not_found') return null;
          throw error;
        });
        if (idle?.stopping) {
          client.close();
          await waitForCoreExit(pid, this.options.socketPath);
          client = await this.connectOrStart();
        } else {
          const live = idle?.live ?? (await client.call('sessions.list', { live: true })).length;
          this.report({ kind: 'other-build', pid, live });
        }
      }
      this.wire(client);
      return client;
    } catch (error) {
      this.setStatus('unavailable');
      if (error instanceof CoreStartError) this.report({ kind: 'failed', reason: error.message, log: error.log, at: Date.now() });
      throw error;
    }
  }

  /** A core from before builds were reported says nothing; one that could not read its own entry says null. */
  private otherBuild(hello: Hello): boolean {
    return this.build !== null && hello.build !== null && hello.build !== this.build;
  }

  private async connectOrStart(): Promise<CoreClient> {
    if (!(await answering(this.options.socketPath))) await this.startCore();
    const token = readFileSync(this.paths.ownerToken, 'utf8').trim();
    return CoreClient.connect(this.options.socketPath, token);
  }

  private wire(client: CoreClient): void {
    client.on((event, data) => { for (const l of this.eventListeners) l(event, data); });
    client.onClose(() => {
      // Replaced or closed on purpose: nothing to reconnect.
      if (this.client !== client) return;
      this.client = null;
      if (this.closing) return;
      this.setStatus('connecting');
      // Reconnect (and restart the core if it died) after a short pause.
      setTimeout(() => { void this.get().catch(() => this.setStatus('unavailable')); }, 600);
    });
    this.client = client;
    this.setStatus('connected');
  }

  /** Start a core and wait until it answers, or say why it did not. */
  private async startCore(): Promise<void> {
    const { dataDir, socketPath } = this.options;
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    // What an earlier core said is not about this one.
    rmSync(this.paths.failed, { force: true });
    const out = openSync(this.paths.outLog, 'a');
    const from = statSync(this.paths.outLog).size;
    const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
    const child = spawn(this.options.runtime, [this.options.coreEntry, '--data-dir', dataDir, '--cli-entry', this.options.cliEntry, ...(this.options.coreArgs ?? [])], {
      detached: true,
      stdio: ['ignore', out, out],
      env,
    });
    closeSync(out);
    child.unref();
    let ended: string | null = null;
    child.once('exit', (code, signal) => { ended = signal ? `It was stopped by ${signal}.` : `It exited with code ${code}.`; });
    child.once('error', (error) => { ended = `It could not be run: ${error.message}`; });

    const timeoutMs = this.options.startTimeoutMs ?? 15_000;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await answering(socketPath)) return;
      // It left: a core that lost a race to another one has left it answering.
      if (ended !== null) {
        if (await answering(socketPath)) return;
        throw this.whyNot(ended, from);
      }
      if (Date.now() > deadline) throw this.whyNot(`It did not answer within ${Math.round(timeoutMs / 1000)} seconds.`, from);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /** What the core said as it failed, else the end of what it printed, else what is known. */
  private whyNot(fallback: string, outFrom: number): CoreStartError {
    try {
      const { reason } = JSON.parse(readFileSync(this.paths.failed, 'utf8')) as { reason?: unknown };
      if (typeof reason === 'string' && reason) return new CoreStartError(reason, this.paths.log);
    } catch { /* it wrote nothing */ }
    const printed = errorIn(readFrom(this.paths.outLog, outFrom));
    return new CoreStartError(printed ? `${printed} ${fallback}` : fallback, this.paths.outLog);
  }

  private report(problem: CoreProblem | null): void {
    if (JSON.stringify(problem) === JSON.stringify(this.trouble)) return;
    this.trouble = problem;
    for (const l of this.problemListeners) l(problem);
  }

  private setStatus(status: CoreStatus): void {
    if (this.status === status) return;
    this.status = status;
    for (const l of this.statusListeners) l(status);
  }
}

/**
 * Stop the core serving a data folder, as `npm run core:stop` does: its live
 * sessions end. The pid it was, or null when none was running.
 */
export async function stopCore(dataDir: string): Promise<number | null> {
  const paths = corePaths(dataDir);
  if (!(await answering(paths.socket))) return null;
  const client = await CoreClient.connect(paths.socket, readFileSync(paths.ownerToken, 'utf8').trim());
  let pid: number | null;
  try {
    pid = (await client.call('core.hello', {})).pid ?? pidOf(paths);
  } finally {
    client.close();
  }
  if (!pid) throw new Error(`A core answers at ${paths.socket}, but Wanigan cannot tell which process it is.`);
  await stopCoreProcess(pid, paths.socket);
  return pid;
}

/** Ask a core to stop (it ends its sessions and closes its socket), and wait until it has. */
async function stopCoreProcess(pid: number, socketPath: string, timeoutMs = 20_000): Promise<void> {
  try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  await waitForCoreExit(pid, socketPath, timeoutMs);
}

/** Wait for a core that already accepted an atomic idle stop; do not signal it. */
async function waitForCoreExit(pid: number, socketPath: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (alive(pid) || await answering(socketPath)) {
    if (Date.now() > deadline) throw new Error(`Wanigan’s core (pid ${pid}) did not stop within ${timeoutMs / 1000} seconds.`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** The pid a core wrote when it started: for one too old to say in `core.hello`. */
function pidOf(paths: CorePaths): number | null {
  try {
    const info = JSON.parse(readFileSync(paths.info, 'utf8')) as { pid?: unknown; socket?: unknown };
    return typeof info.pid === 'number' && info.socket === paths.socket ? info.pid : null;
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function answering(socketPath: string): Promise<boolean> {
  if (!existsSync(socketPath)) return Promise.resolve(false);
  return new Promise((resolve) => {
    const socket = connect(socketPath);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

/** What a file gained after `from`, at most its last 64 KB. */
function readFrom(file: string, from: number): string {
  try {
    const size = statSync(file).size;
    const start = Math.max(from, size - 65_536);
    if (size <= start) return '';
    const buffer = Buffer.alloc(size - start);
    const fd = openSync(file, 'r');
    try { readSync(fd, buffer, 0, buffer.length, start); } finally { closeSync(fd); }
    return buffer.toString('utf8');
  } catch {
    return '';
  }
}

/** The error a crashed Node process printed ("Error: …" up to its stack), else its last line. */
export function errorIn(output: string): string | null {
  const lines = output.split('\n').map((l) => l.trimEnd()).filter(Boolean);
  const first = lines.findIndex((l) => /^\w*Error\b/.test(l));
  if (first < 0) return lines.at(-1)?.trim() || null;
  const rest = lines.slice(first);
  const stack = rest.findIndex((l) => /^\s+at\s/.test(l));
  return rest.slice(0, stack < 0 ? 3 : stack).map((l) => l.trim()).join(' ').slice(0, 600);
}
