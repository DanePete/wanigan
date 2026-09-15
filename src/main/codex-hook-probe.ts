import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CodexHookExchange } from '../shared/codex-hooks';

/**
 * One run of Codex's app-server, asked one question: how would you treat these
 * hooks? The decision about the answer is shared/codex-hooks.ts; this file owns
 * only the process, and imports nothing that needs Electron, so
 * scripts/probe-codex-hook-trust.mjs runs this exact code against the real CLI.
 *
 * What it sends is the whole contract, and there are three messages:
 * `initialize`, `initialized` and `hooks/list`. Nothing that starts a thread or
 * a turn is ever sent. Starting a thread was observed to open a connection to
 * the model provider, and nothing a trust probe needs is on the far side of one.
 *
 * What it runs with:
 *  - a fresh CODEX_HOME, because app-server writes SQLite state into its home
 *    on start, and a probe must neither read the operator's home nor leave
 *    files in it. The directory is deleted once the process is gone;
 *  - a fresh, empty working directory, so no repository's hooks are listed;
 *  - the caller's environment, which is the credential-free probe environment
 *    providers.ts builds, plus that CODEX_HOME;
 *  - a hard deadline, after which its process group is killed.
 */

export type HooksListExchangeOptions = {
  bin: string;
  configArgs: string[];
  /** Must already be minimal and credential-free: CODEX_HOME is the only thing added. */
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  clientVersion: string;
};

/** The run's own record, for the script that prints it; the app keeps only `exchange`. */
export type HooksListRun = {
  exchange: CodexHookExchange;
  initialize: unknown;
  argv: string[];
  codexHome: string;
};

/** A hooks/list answer is a few kilobytes per hook. Anything past this is not one. */
const MAX_STDOUT = 1024 * 1024;
const MAX_STDERR = 4096;
/** Grace between SIGTERM and SIGKILL, and twice it bounds the wait for the exit. */
const KILL_GRACE_MS = 1000;

export function exchangeHooksList(opts: HooksListExchangeOptions): Promise<HooksListRun> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-codex-hooks-'));
  const home = path.join(root, 'home');
  const work = path.join(root, 'work');
  fs.mkdirSync(home, { mode: 0o700 });
  fs.mkdirSync(work, { mode: 0o700 });
  const cwd = fs.realpathSync.native(work);
  // Config overrides go before the subcommand: a root option there is read
  // whether or not the subcommand also accepts it after its own name.
  const argv = [...opts.configArgs, 'app-server', '--listen', 'stdio://'];

  return new Promise<HooksListRun>((resolve) => {
    let initialize: unknown = null;
    let stdout = '';
    let stderr = '';
    let answer: CodexHookExchange | null = null;
    /** The process is gone: its pid may belong to something else now. */
    let exited = false;
    /** Its stdio has ended too, so every byte it wrote has been read. */
    let closed = false;
    let done = false;
    /** hooks/list has been sent; a second answer to initialize must not send it again. */
    let listed = false;

    const child = spawn(opts.bin, argv, {
      cwd,
      env: { ...opts.env, CODEX_HOME: home },
      stdio: ['pipe', 'pipe', 'pipe'],
      // Its own process group, so the kill reaches anything app-server started.
      detached: true,
    });

    const signal = (name: NodeJS.Signals) => {
      if (exited || child.pid === undefined) return;
      try { process.kill(-child.pid, name); }
      catch { try { child.kill(name); } catch { /* already gone */ } }
    };

    const cleanup = (result: CodexHookExchange) => {
      if (done) return;
      done = true;
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* the temp sweep takes it */ }
      resolve({ exchange: result, initialize, argv, codexHome: home });
    };

    const finish = (result: CodexHookExchange) => {
      if (answer) return;
      answer = result;
      clearTimeout(deadline);
      if (closed) { cleanup(result); return; }
      signal('SIGTERM');
      const hard = setTimeout(() => signal('SIGKILL'), KILL_GRACE_MS);
      // The home is removed once the process is gone, and never later than
      // this: a process that outlives SIGKILL must not hold the caller.
      const bound = setTimeout(() => cleanup(result), KILL_GRACE_MS * 2);
      child.once('close', () => { clearTimeout(hard); clearTimeout(bound); cleanup(result); });
    };

    const deadline = setTimeout(() => finish({
      outcome: 'timeout',
      detail: `Codex's app-server did not answer hooks/list within ${Math.round(opts.timeoutMs / 1000)} s.`,
    }), opts.timeoutMs);

    const send = (message: unknown) => {
      try { child.stdin.write(`${JSON.stringify(message)}\n`); } catch { /* the close handler reports it */ }
    };

    const onLine = (line: string) => {
      let message: unknown;
      try { message = JSON.parse(line); } catch { return; }
      if (typeof message !== 'object' || message === null) return;
      const reply = message as { id?: unknown; method?: unknown; result?: unknown; error?: unknown };
      // A message with a method is the server's own request or notification.
      // Its ids are the server's, and one numbered 1 or 2 is not an answer.
      if (reply.method !== undefined) return;
      if (reply.id === 1 && !listed) {
        listed = true;
        if (reply.error !== undefined) {
          finish({ outcome: 'no-answer', detail: `Codex's app-server refused initialize: ${JSON.stringify(reply.error).slice(0, 300)}` });
          return;
        }
        initialize = reply.result ?? null;
        send({ method: 'initialized' });
        send({ id: 2, method: 'hooks/list', params: { cwds: [cwd] } });
      } else if (reply.id === 2) {
        finish({ outcome: 'answered', response: message });
      }
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (answer) return;
      stdout += chunk;
      if (stdout.length > MAX_STDOUT) {
        finish({ outcome: 'no-answer', detail: 'Codex\'s app-server wrote more than a megabyte without answering hooks/list.' });
        return;
      }
      for (let newline = stdout.indexOf('\n'); newline >= 0; newline = stdout.indexOf('\n')) {
        const line = stdout.slice(0, newline);
        stdout = stdout.slice(newline + 1);
        if (line.trim()) onLine(line);
        // onLine settles the run when hooks/list is answered; nothing after it is read.
        if (answer) break;
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-MAX_STDERR); });
    child.stdin.on('error', () => { /* EPIPE when it exits first; the close handler reports it */ });
    child.on('exit', () => { exited = true; });
    child.on('error', (error) => {
      exited = true;
      closed = true;
      finish({ outcome: 'no-answer', detail: `Codex's app-server could not be started: ${error.message}` });
    });
    // 'close', not 'exit': a process that answers and exits at once can exit
    // before its last line has been read, and that must not read as silence.
    child.on('close', (code, sig) => {
      exited = true;
      closed = true;
      const last = stderr.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(-300);
      finish({
        outcome: 'no-answer',
        detail: `Codex's app-server exited (${sig ?? `code ${code}`}) before it answered hooks/list${last ? `: ${last}` : '.'}`,
      });
    });

    send({
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'wanigan', version: opts.clientVersion }, capabilities: { experimentalApi: true } },
    });
  });
}
