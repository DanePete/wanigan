// What the core's tests share: a real core in a temporary folder, stand-in
// agents, and the real hook relay. Nothing here reads the real home folder,
// real accounts or Wanigan 1's database.
import { Tailscale } from './phone/tailscale.ts';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CoreClient } from '../client/client.ts';
import type { Provider, Session } from '../shared/model.ts';
import { Core, type CoreOptions } from './core.ts';

export const CLI = resolve(import.meta.dirname, '../cli/index.ts');

/** A stand-in Codex: shows its arguments, then answers lines with real OSC 9 notifications. */
export const FAKE_CODEX = [
  'echo "codex ready HOME=${CODEX_HOME-unset} ARGS=$*"',
  'while IFS= read -r line; do',
  '  case "$line" in',
  '    *ask*) printf "\\033]9;Approval requested: run the tests\\007" ;;',
  '    *done*) printf "\\033]9;Agent turn complete\\007" ;;',
  '    *) echo "got: $line" ;;',
  '  esac',
  'done',
].join('\n');

/** Agents are stand-ins: an interactive sh, and a "claude" that prints its token and waits. */
export function launcher(provider: Provider): { file: string; args: string[] } {
  if (provider === 'claude') return { file: '/bin/sh', args: ['-c', 'echo "TOKEN=$WANIGAN_TOKEN CFG=${CLAUDE_CONFIG_DIR-unset} ARGS=$*"; exec cat', 'fake-claude'] };
  if (provider === 'codex') return { file: '/bin/sh', args: ['-c', FAKE_CODEX, 'fake-codex'] };
  return { file: '/bin/sh', args: ['-i'] };
}

export async function waitFor<T>(what: string, probe: () => T | Promise<T>, timeoutMs = 15_000): Promise<NonNullable<T>> {
  const start = Date.now();
  for (;;) {
    const value = await probe();
    if (value) return value as NonNullable<T>;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** The real relay.sh, run as Claude Code runs it: the event as $1, the JSON on stdin (optionally late). */
export function relay(core: Core, token: string, event: string, payload: unknown, stdinDelayMs = 0): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = execFile('/bin/sh', [join(core.paths.dataDir, 'hooks', 'relay.sh'), event], {
      env: { PATH: '/usr/bin:/bin', WANIGAN_HOOK_SOCKET: core.paths.hookSocket, WANIGAN_TOKEN: token },
      timeout: 10_000,
    }, (error, stdout) => (error ? reject(error) : resolvePromise(stdout)));
    const write = (): void => { child.stdin?.end(JSON.stringify(payload)); };
    if (stdinDelayMs) setTimeout(write, stdinDelayMs); else write();
  });
}

export function sh(command: string, cwd: string): Promise<string> {
  return new Promise((ok, fail) => execFile('/bin/sh', ['-c', command], { cwd }, (error, stdout, stderr) =>
    (error ? fail(new Error(`${command}: ${stderr}`)) : ok(String(stdout)))));
}

/**
 * What Claude Code writes at a conversation's first prompt: its transcript, in
 * the default account's folder under `home`. A stand-in never prompts, so a test
 * that resumes its conversation saves one first, as the real CLI would have.
 */
export function savedConversation(home: string, session: Pick<Session, 'cwd' | 'conversationId'>): void {
  const dir = join(home, '.claude', 'projects', (session.cwd ?? '').replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${session.conversationId}.jsonl`), `${JSON.stringify({ type: 'user', sessionId: session.conversationId })}\n`);
}

export interface TestCore {
  dir: string;
  projectDir: string;
  core: Core;
  owner: CoreClient;
  close(): Promise<void>;
}

/** A started core with one empty project folder and no accounts that answer. */
export async function testCore(options: Partial<CoreOptions> = {}): Promise<TestCore> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'wg-')));
  const projectDir = join(dir, 'site');
  mkdirSync(projectDir);
  const home = join(dir, 'home');
  mkdirSync(join(home, '.claude'), { recursive: true });
  const { accounts, codexModels = async () => [], ...rest } = options;
  const core = new Core({
    dataDir: join(dir, 'data'),
    launcher,
    cli: { runtime: process.execPath, entry: CLI },
    // The real Codex is never asked; a test that wants hooks passes a stand-in probe.
    codexHookProbe: null,
    // Model discovery has its own app-server path; only an explicit fixture reader may answer it.
    codexModels,
    // Jev never looks for the owner's key in the login shell: a test that wants Jev passes its own.
    jev: { envKey: null },
    // No LM Studio and nothing at Ollama's address: the owner's own models are never read.
    // A test about local models passes a stand-in `lms` and server.
    local: { lmsBin: null, ollamaUrl: 'http://127.0.0.1:9' },
    // No Tailscale and any free port: the owner's own tailnet is never touched. A phone test passes its own.
    phone: { port: 0, tailscale: new Tailscale({ bin: null }), rendererDir: join(dir, 'renderer') },
    // ddev is looked for only in the test's own bin folder (empty unless a test puts a stand-in there), so the
    // owner's ddev is never asked about, or starts, any of the owner's sites.
    live: { path: [join(dir, 'bin'), '/usr/bin', '/bin'].join(':') },
    ...rest,
    // A test that replaces how accounts are probed still looks for them in its own home, never the real one.
    accounts: {
      home,
      prober: async () => ({ signedIn: 'unknown', identity: null, plan: null }),
      usageReader: async () => ({ state: 'unreadable', windows: [], checkedAt: 0, note: 'test' }),
      ...accounts,
    },
  });
  await core.start();
  const owner = await CoreClient.connect(core.paths.socket, readFileSync(core.paths.ownerToken, 'utf8'));
  return {
    dir, projectDir, core, owner,
    async close() {
      owner.close();
      await core.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The token a stand-in Claude printed when it started. */
export const tokenOf = (core: Core, sessionId: string): Promise<string> =>
  waitFor('token', () => core.sessions.replay(sessionId).replay.match(/TOKEN=([A-Za-z0-9_-]{20,})/)?.[1]);
