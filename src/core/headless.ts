// One headless Claude Code run with read-only tools and a JSON schema. Used by
// AI review and card drafting; both run only when the owner asks.
import { spawn, type ChildProcess } from 'node:child_process';
import type { Account } from '../shared/model.ts';
import { applyAccount } from './accounts.ts';
import { cleanEnv, folderMissing, isDir, requireCli } from './environment.ts';

/** Agent-written settings, skills and hooks are executable customizations, not reading tools. */
export const NO_CUSTOMIZATIONS_ARGS: readonly string[] = ['--safe-mode', '--setting-sources', ''];

export const READ_ONLY_ARGS: readonly string[] = [
  ...NO_CUSTOMIZATIONS_ARGS,
  // Only the three reading tools exist in the run, and no MCP server from the
  // account's own configuration is loaded: a review reads agent-written text.
  '--tools', 'Read,Grep,Glob', '--strict-mcp-config',
  '--allowedTools', 'Read', 'Grep', 'Glob',
  '--disallowedTools', 'Edit', 'Write', 'NotebookEdit', 'Bash', 'WebFetch', 'WebSearch',
  '--no-session-persistence',
];

export interface HeadlessResult {
  /** The structured answer, or null when there was none. */
  answer: Record<string, unknown> | null;
  /** What the CLI reported it cost, or null when it reported nothing. */
  costUsd: number | null;
  error: string | null;
}

/** Every headless run still going, so a stopping core takes them with it: an orphan would keep spending. */
const running = new Set<ChildProcess>();

/** SIGTERM, then SIGKILL if it has not gone in 3 seconds. */
export function killChild(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const hard = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 3_000);
  hard.unref();
}

/** Stop every headless run: the core is stopping. */
export function stopHeadless(): void {
  for (const child of running) killChild(child);
}

export interface HeadlessRun {
  child: ChildProcess;
  done: Promise<HeadlessResult>;
}

export async function runHeadless(options: {
  binary: string | null;
  prompt: string;
  schema: object;
  cwd: string;
  account: Account | null;
  timeoutMs: number;
}): Promise<HeadlessRun> {
  // A missing folder (a removed worktree) would fail the spawn as if Claude Code were missing.
  if (!isDir(options.cwd)) throw folderMissing(options.cwd, 'claude');
  const { bin, path } = await requireCli('claude', options.binary);
  const env: Record<string, string> = { ...cleanEnv(process.env), PATH: path };
  applyAccount(env, 'claude', options.account);
  const args = ['-p', options.prompt, '--output-format', 'json', '--json-schema', JSON.stringify(options.schema), ...READ_ONLY_ARGS];
  const child = spawn(bin, args, { cwd: options.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  running.add(child);
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (d: Buffer) => { if (stdout.length < 4_000_000) stdout += d.toString('utf8'); });
  child.stderr?.on('data', (d: Buffer) => { if (stderr.length < 20_000) stderr += d.toString('utf8'); });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; killChild(child); }, options.timeoutMs);
  timer.unref();
  const done = new Promise<HeadlessResult>((resolve) => {
    let settled = false;
    const settle = (r: HeadlessResult): void => { if (!settled) { settled = true; clearTimeout(timer); running.delete(child); resolve(r); } };
    child.on('error', (error) => settle({ answer: null, costUsd: null, error: `Could not start Claude Code: ${error.message}` }));
    child.on('close', (code) => {
      if (timedOut) {
        settle({ answer: null, costUsd: null, error: `Claude Code took longer than ${Math.round(options.timeoutMs / 1000)} seconds and was stopped.` });
        return;
      }
      if (code !== 0 && !stdout.trim()) {
        settle({ answer: null, costUsd: null, error: `Claude Code exited with code ${code}${stderr.trim() ? `: ${stderr.trim().split('\n').pop()}` : ''}` });
        return;
      }
      settle(parse(stdout));
    });
  });
  return { child, done };
}

function parse(stdout: string): HeadlessResult {
  try {
    const envelope = JSON.parse(stdout) as { is_error?: boolean; result?: unknown; structured_output?: unknown; total_cost_usd?: unknown };
    const costUsd = typeof envelope.total_cost_usd === 'number' ? envelope.total_cost_usd : null;
    const raw = envelope.structured_output ?? (typeof envelope.result === 'string' ? JSON.parse(envelope.result) : null);
    if (envelope.is_error || !raw || typeof raw !== 'object') {
      return { answer: null, costUsd, error: typeof envelope.result === 'string' ? envelope.result.slice(0, 300) : 'No structured answer.' };
    }
    return { answer: raw as Record<string, unknown>, costUsd, error: null };
  } catch (e) {
    return { answer: null, costUsd: null, error: `Claude Code’s answer could not be read: ${(e as Error).message}` };
  }
}
