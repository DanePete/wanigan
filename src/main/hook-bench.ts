import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { dialog, type BrowserWindow } from 'electron';
import { assertManagedRoot } from './roots';
import { readProjectConfig } from './context/config';
import { shellPath } from './providers';
import { interpretHookResult, sampleFor, type HookBenchResult } from '../shared/hook-bench';

/**
 * Run one configured hook command against a representative input, without a
 * session, and say what Claude Code would make of what it printed.
 *
 * The command is a program somebody else may have written — whoever committed
 * the repository's .claude/settings.json, or a plugin's author — so it runs
 * only after a native dialog names it in full and says so. What it is given is
 * deliberately thin: the sample input on stdin, the project as its working
 * directory, and an environment of PATH, HOME and TMPDIR plus the one or two
 * path variables Claude Code itself sets for every hook (CLAUDE_PROJECT_DIR,
 * and CLAUDE_PLUGIN_ROOT for a plugin's hook). No API key, no token, no
 * provider credential, no Wanigan variable. It is stopped at ten seconds, and
 * each stream is cut at 64 KB. Nothing it prints is stored.
 *
 * The renderer never sends the command. It names the settings file, the event
 * and the hook's position among that file's hooks for that event, exactly as
 * the Context view lists them; main re-reads the file and finds the command
 * itself.
 */

export const BENCH_TIMEOUT_MS = 10_000;
export const BENCH_OUTPUT_CAP = 64 * 1024;
const MAX_SETTINGS_BYTES = 1024 * 1024;

type Target = { projectPath: string; source: string; event: string; ordinal: number };
type Confirm = (input: { command: string; event: string; from: string; projectPath: string; envNames: string[] }) => Promise<boolean>;

let confirmOverride: Confirm | null = null;
let windowFor: () => BrowserWindow | null = () => null;

export function setHookBenchWindow(fn: () => BrowserWindow | null): void {
  windowFor = fn;
}

/** For the offline suite, which cannot click a dialog. Null restores the real one. */
export function setHookBenchConfirm(fn: Confirm | null): void {
  confirmOverride = fn;
}

/** Shortened only by the offline suite, which proves the kill without waiting ten seconds. */
let timeoutMs = BENCH_TIMEOUT_MS;
export function setHookBenchTimeout(ms: number | null): void {
  timeoutMs = ms ?? BENCH_TIMEOUT_MS;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The raw handler, read from the file itself in the same order config.ts lists it. */
function handlerAt(source: string, event: string, ordinal: number): Record<string, unknown> | null {
  const st = fs.statSync(source);
  if (!st.isFile() || st.size > MAX_SETTINGS_BYTES) return null;
  const parsed = JSON.parse(fs.readFileSync(source, 'utf8')) as unknown;
  const block = isRecord(parsed) ? parsed.hooks : undefined;
  if (!isRecord(block)) return null;
  const groupsRaw = block[event];
  const groups = Array.isArray(groupsRaw) ? groupsRaw : [groupsRaw];
  const handlers: Record<string, unknown>[] = [];
  for (const g of groups) {
    if (!isRecord(g) || !Array.isArray(g.hooks)) continue;
    for (const h of g.hooks) if (isRecord(h)) handlers.push(h);
  }
  return handlers[ordinal] ?? null;
}

function resolve(input: unknown): Target & { command: string; from: string } {
  if (!isRecord(input)) throw new Error('Name the hook to test.');
  const projectPath = assertManagedRoot(input.projectPath, 'That project folder');
  const { source, event, ordinal } = input;
  if (typeof source !== 'string' || typeof event !== 'string' || typeof ordinal !== 'number' || !Number.isInteger(ordinal) || ordinal < 0) {
    throw new Error('Name the hook to test by its settings file, event and position.');
  }
  // Only a file the Context view itself lists for this project can be read here.
  const real = (p: string) => { try { return fs.realpathSync(p); } catch { return p; } };
  const wanted = real(source);
  const listed = readProjectConfig(projectPath).hooks.filter((h) => real(h.source) === wanted && h.event === event);
  const entry = listed[ordinal];
  if (!entry) throw new Error('That hook is no longer in the project’s configuration. Refresh the Context view.');
  if (entry.type !== 'command') throw new Error(`This is a ${entry.type} hook. The bench runs command hooks only; it will not send a sample to a URL on your behalf.`);
  const handler = handlerAt(entry.source, event, ordinal);
  const command = handler && typeof handler.command === 'string' ? handler.command : null;
  if (!command || (handler!.type ?? 'command') !== 'command') throw new Error('The settings file changed while the view was open. Refresh the Context view and try again.');
  const from = entry.from === 'project' ? 'this repository’s committed settings'
    : entry.from === 'local' ? 'this repository’s local settings'
      : entry.from === 'plugin' ? 'a plugin'
        : entry.from === 'managed' ? 'managed (organisation) settings' : 'your user settings';
  return { projectPath, source: entry.source, event, ordinal, command, from };
}

async function defaultConfirm(input: Parameters<Confirm>[0]): Promise<boolean> {
  const w = windowFor();
  const shown = input.command.length > 1_000 ? `${input.command.slice(0, 999)}…` : input.command;
  const options = {
    type: 'warning' as const,
    buttons: ['Cancel', 'Run it'],
    defaultId: 0,
    cancelId: 0,
    title: 'Run this hook with sample input?',
    message: `Run the ${input.event} hook command from ${input.from}?`,
    detail: `${shown}\n\nThis runs a program defined by ${input.from}, with your user’s permissions, in ${input.projectPath}. `
      + `It gets a sample ${input.event} input on stdin and only these environment variables: ${input.envNames.join(', ')} — no credentials. `
      + 'It is stopped after 10 seconds. Nothing it prints is saved.',
  };
  const r = w ? await dialog.showMessageBox(w, options) : await dialog.showMessageBox(options);
  return r.response === 1;
}

function capped(): { push: (chunk: Buffer) => void; text: () => string; truncated: () => boolean } {
  const parts: Buffer[] = [];
  let size = 0;
  let cut = false;
  return {
    push: (chunk) => {
      if (size >= BENCH_OUTPUT_CAP) { cut = true; return; }
      const room = BENCH_OUTPUT_CAP - size;
      if (chunk.length > room) { parts.push(chunk.subarray(0, room)); size += room; cut = true; } else { parts.push(chunk); size += chunk.length; }
    },
    text: () => Buffer.concat(parts).toString('utf8'),
    truncated: () => cut,
  };
}

export async function runHookBench(input: unknown): Promise<HookBenchResult | { cancelled: true }> {
  const target = resolve(input);
  const sample = sampleFor(target.event, target.projectPath);
  if (!sample) throw new Error(`The bench has no sample input for ${target.event} yet, so it will not run that hook with a made-up one.`);

  const env: Record<string, string> = {
    PATH: await shellPath().catch(() => process.env.PATH ?? '/usr/bin:/bin'),
    HOME: os.homedir(),
    TMPDIR: os.tmpdir(),
    CLAUDE_PROJECT_DIR: target.projectPath,
  };
  if (target.source.endsWith(`${path.sep}hooks${path.sep}hooks.json`)) env.CLAUDE_PLUGIN_ROOT = path.dirname(path.dirname(target.source));
  const envNames = Object.keys(env);

  const approved = await (confirmOverride ?? defaultConfirm)({ command: target.command, event: target.event, from: target.from, projectPath: target.projectPath, envNames });
  if (!approved) return { cancelled: true };

  const started = Date.now();
  const out = capped();
  const err = capped();
  const result = await new Promise<{ code: number | null; signal: string | null; timedOut: boolean }>((done) => {
    // A process group of its own, so the timeout ends whatever the hook started too.
    const child = spawn('/bin/sh', ['-c', target.command], { cwd: target.projectPath, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
    }, timeoutMs);
    child.stdout.on('data', out.push);
    child.stderr.on('data', err.push);
    child.stdin.on('error', () => { /* a hook that never reads stdin closes it early */ });
    child.stdin.end(`${JSON.stringify(sample)}\n`);
    child.on('error', () => { clearTimeout(timer); done({ code: null, signal: null, timedOut }); });
    child.on('close', (code, signal) => { clearTimeout(timer); done({ code, signal, timedOut }); });
  });
  const stdout = out.text();
  const stderr = err.text();
  return {
    event: target.event,
    exitCode: result.code,
    signal: result.signal,
    timedOut: result.timedOut,
    durationMs: Date.now() - started,
    stdout, stderr,
    stdoutTruncated: out.truncated(),
    stderrTruncated: err.truncated(),
    input: sample,
    verdict: interpretHookResult({ event: target.event, exitCode: result.code, stdout, stderr, timedOut: result.timedOut }),
    envNames,
  };
}
