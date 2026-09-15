import { spawn } from 'node:child_process';
import * as accounts from './accounts';
import { detectProviders, shellPath } from './providers';
import { probeEnv, takeStderr } from './codex-status';
import { redactCredentials } from './redact';
import { doctorFlagMissing, parseCodexDoctor, type DoctorReport } from '../shared/codex-doctor';

/**
 * `codex doctor` per configured Codex account, on demand.
 *
 * Run with that account's CODEX_HOME and the same credential-free probe
 * environment the limits read uses. Doctor reads local config and state, and
 * probes whether OpenAI's endpoints answer over HTTP and WebSocket; it sends no
 * prompt and starts no turn. It exits 1 when a check fails, which is a report,
 * so the exit code is not what decides readability — the JSON is.
 */

const DOCTOR_TIMEOUT_MS = 45_000;

export type AccountDoctor = {
  accountId: string;
  label: string;
  ranAt: number;
  durationMs: number;
  exitCode: number | null;
  report: DoctorReport;
};

function run(bin: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGTERM'); } catch { /* gone */ } }, DOCTOR_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => { if (stdout.length < 4 * 1024 * 1024) stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = takeStderr(stderr, chunk); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ stdout, stderr: e.message, code: null, timedOut }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ stdout, stderr, code, timedOut }); });
  });
}

export async function runCodexDoctor(accountId: unknown): Promise<AccountDoctor> {
  if (typeof accountId !== 'string' || !accountId) throw new Error('Choose a Codex account.');
  const account = accounts.byId(accountId);
  if (!account || account.harness !== 'codex') throw new Error('That Codex account no longer exists in Wanigan.');
  const codex = (await detectProviders()).find((p) => p.harnessId === 'codex' && p.path);
  if (!codex?.path) throw new Error('Codex is not installed, so there is no doctor to run.');
  const env = probeEnv(await shellPath(), accounts.launchEnv(account));
  return { accountId: account.id, label: account.label, ...(await doctorWithBinary(codex.path, env)) };
}

/**
 * The run and the read, for a given binary and environment. Exported for the
 * offline suite, which points it at a stand-in `codex` that prints a recorded
 * report — the real doctor probes OpenAI's endpoints, and the suite stays off
 * the network.
 */
export async function doctorWithBinary(bin: string, env: NodeJS.ProcessEnv): Promise<Omit<AccountDoctor, 'accountId' | 'label'>> {
  const started = Date.now();
  let result = await run(bin, ['doctor', '--json'], env);
  let report: DoctorReport;
  if (result.timedOut) {
    report = { state: 'unreadable', reason: `codex doctor did not finish within ${DOCTOR_TIMEOUT_MS / 1000} seconds.` };
  } else if (doctorFlagMissing(result.stderr)) {
    // An older Codex: its human summary is shown as text, labelled as such,
    // and not parsed into checks it did not state in a stable shape.
    result = await run(bin, ['doctor', '--summary', '--no-color'], env);
    report = result.stdout.trim()
      ? { state: 'summary-text', text: redactCredentials(result.stdout).slice(0, 8000), note: 'This Codex has no doctor --json, so its summary is shown as printed and not read into checks.' }
      : { state: 'unreadable', reason: result.stderr.trim().split('\n')[0] || 'codex doctor printed nothing.' };
  } else {
    report = parseCodexDoctor(result.stdout);
    if (report.state === 'unreadable' && result.stderr.trim()) {
      report = { state: 'unreadable', reason: `${report.reason} ${redactCredentials(result.stderr.trim().split('\n')[0]).slice(0, 300)}` };
    }
  }
  return { ranAt: started, durationMs: Date.now() - started, exitCode: result.code, report };
}
