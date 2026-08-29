import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { ProviderCapabilities } from '../shared/types';
import type {
  ProviderProfile,
  TrustedProviderProcessAdapter,
} from './provider-packs';

const PROTOCOL_VERSION = 1 as const;
const REQUEST_ID = 'probe';
const TIMEOUT_MS = 5_000;
const MAX_STDOUT_BYTES = 256 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_EXECUTABLE_BYTES = 128 * 1024 * 1024;

export type ProviderAdapterProbe = {
  capabilities: Partial<Omit<ProviderCapabilities, 'probed' | 'note'>>;
  note: string | null;
};

function stageVerifiedAdapter(adapter: TrustedProviderProcessAdapter): { executable: string; cleanup: () => void } {
  const source = path.resolve(adapter.executable);
  let fd: number | null = null;
  let stagingDir: string | null = null;
  try {
    const linked = fs.lstatSync(source);
    if (!linked.isFile() || linked.isSymbolicLink()) {
      throw new Error('The trusted provider adapter is no longer a regular file.');
    }
    const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
    fd = fs.openSync(source, fs.constants.O_RDONLY | noFollow);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error('The trusted provider adapter is no longer a regular file.');
    if ((stat.mode & 0o111) === 0) throw new Error('The trusted provider adapter is no longer executable.');
    if (stat.size > MAX_EXECUTABLE_BYTES) throw new Error('The trusted provider adapter exceeds 128 MB.');
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) throw new Error('The trusted provider adapter changed while it was being read.');
      offset += count;
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== adapter.sha256) {
      throw new Error('Provider adapter bytes changed after approval; trust was revoked for this probe.');
    }

    stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-provider-adapter-'));
    fs.chmodSync(stagingDir, 0o700);
    const executable = path.join(stagingDir, 'adapter');
    fs.writeFileSync(executable, bytes, { flag: 'wx', mode: 0o700 });
    fs.chmodSync(executable, 0o700);
    if (createHash('sha256').update(fs.readFileSync(executable)).digest('hex') !== adapter.sha256) {
      throw new Error('The staged provider adapter failed its digest check.');
    }
    let removed = false;
    return {
      executable,
      cleanup: () => {
        if (removed) return;
        removed = true;
        if (stagingDir) fs.rmSync(stagingDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (stagingDir) fs.rmSync(stagingDir, { recursive: true, force: true });
    throw error;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

function boundedText(value: unknown, max = 1_000): string | null {
  return typeof value === 'string' && value.trim()
    ? value.trim().replace(/[\r\n]+/g, ' ').slice(0, max)
    : null;
}

function safeEnvironment(): NodeJS.ProcessEnv {
  // Capability probes do not receive API keys, cloud credentials, or the
  // complete Electron environment. A separately trusted process is still not
  // a reason to hand it every secret inherited by Wanigan.
  const names = ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'SHELL'];
  const env: NodeJS.ProcessEnv = {};
  for (const name of names) if (process.env[name] !== undefined) env[name] = process.env[name];
  env.WANIGAN_PROVIDER_ADAPTER_PROTOCOL = String(PROTOCOL_VERSION);
  return env;
}

function integrationAllows(
  profile: Pick<ProviderProfile, 'harness' | 'headless' | 'resume'>,
  key: keyof ProviderAdapterProbe['capabilities'],
): boolean {
  // A probe can prove the provider side of a contract, but cannot manufacture
  // Wanigan wiring that does not exist. Claude-only hooks/transcripts remain
  // Claude-only even if a generic adapter asserts otherwise.
  if (key === 'hooks' || key === 'mcp' || key === 'policy' || key === 'transcript') {
    return profile.harness === 'claude-code';
  }
  if (key === 'headlessJson') {
    return profile.headless !== undefined && profile.headless !== 'none' &&
      (profile.harness === 'claude-code' || profile.harness === 'codex');
  }
  if (key === 'namedResume') return !!profile.resume;
  return true;
}

function parseResponse(
  line: string,
  profile: Pick<ProviderProfile, 'harness' | 'headless' | 'resume'>,
): ProviderAdapterProbe {
  let raw: unknown;
  try { raw = JSON.parse(line); }
  catch { throw new Error('Provider adapter returned invalid JSON.'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Provider adapter returned an invalid response.');
  const response = raw as Record<string, unknown>;
  if (response.protocolVersion !== PROTOCOL_VERSION || response.id !== REQUEST_ID || response.ok !== true) {
    const detail = boundedText(response.error);
    throw new Error(detail ? `Provider adapter refused the probe: ${detail}` : 'Provider adapter protocol mismatch.');
  }
  const result = response.result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('Provider adapter probe result is missing.');
  }
  const resultObject = result as Record<string, unknown>;
  const declared = resultObject.capabilities;
  if (!declared || typeof declared !== 'object' || Array.isArray(declared)) {
    throw new Error('Provider adapter probe did not return capabilities.');
  }
  const keys: Array<keyof ProviderAdapterProbe['capabilities']> = [
    'hooks', 'telemetry', 'mcp', 'policy', 'transcript', 'namedResume', 'headlessJson',
  ];
  const capabilities: ProviderAdapterProbe['capabilities'] = {};
  for (const key of keys) {
    const value = (declared as Record<string, unknown>)[key];
    if (typeof value === 'boolean' && integrationAllows(profile, key)) capabilities[key] = value;
  }
  return { capabilities, note: boundedText(resultObject.note) };
}

/**
 * Executes one bounded v1 NDJSON probe. The trusted digest is recomputed on
 * the final synchronous line before spawn; no shell is involved. A probe has
 * no session-control authority and cannot add unsupported harness wiring.
 */
export async function probeProviderAdapter(
  adapter: TrustedProviderProcessAdapter,
  profile: Pick<ProviderProfile, 'id' | 'packId' | 'harness' | 'backend' | 'command' | 'headless' | 'resume'>,
): Promise<ProviderAdapterProbe> {
  const staged = stageVerifiedAdapter(adapter);

  const request = JSON.stringify({
    protocolVersion: PROTOCOL_VERSION,
    id: REQUEST_ID,
    method: 'probe',
    params: {
      profileId: profile.id,
      packId: profile.packId,
      harness: profile.harness,
      backendId: profile.backend.id,
      command: profile.command.bin,
    },
  }) + '\n';

  return new Promise<ProviderAdapterProbe>((resolve, reject) => {
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    let child: ReturnType<typeof spawn> | null = null;
    let timer: NodeJS.Timeout | null = null;
    const terminate = () => {
      if (!child || child.exitCode !== null || child.signalCode !== null) return;
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
    };
    const finish = (error?: Error, value?: ProviderAdapterProbe) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) terminate();
      staged.cleanup();
      if (error) reject(error); else resolve(value!);
    };
    try {
      child = spawn(staged.executable, adapter.args, {
        cwd: adapter.cwd,
        env: safeEnvironment(),
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
    } catch (error) {
      finish(new Error(`Provider adapter could not start: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    const running = child;
    timer = setTimeout(() => {
      finish(new Error(`Provider adapter probe exceeded ${TIMEOUT_MS}ms.`));
    }, TIMEOUT_MS);
    timer.unref?.();
    running.stdout!.on('data', (chunk: Buffer) => {
      stdout = Buffer.concat([stdout, chunk]);
      if (stdout.length > MAX_STDOUT_BYTES) {
        finish(new Error('Provider adapter probe exceeded its output limit.'));
      }
    });
    running.stderr!.on('data', (chunk: Buffer) => {
      if (stderr.length <= MAX_STDERR_BYTES) stderr = Buffer.concat([stderr, chunk]).subarray(0, MAX_STDERR_BYTES);
    });
    running.stdout!.once('error', (error) => finish(new Error(`Provider adapter output failed: ${error.message}`)));
    running.stderr!.once('error', (error) => finish(new Error(`Provider adapter error output failed: ${error.message}`)));
    running.once('error', (error) => finish(new Error(`Provider adapter could not start: ${error.message}`)));
    running.once('close', (code, signal) => {
      if (settled) return;
      if (code !== 0) {
        const detail = boundedText(stderr.toString('utf8'));
        finish(new Error(`Provider adapter probe failed (${signal ?? code ?? 'unknown'}).${detail ? ` ${detail}` : ''}`));
        return;
      }
      const lines = stdout.toString('utf8').split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
      if (lines.length !== 1) {
        finish(new Error('Provider adapter must return exactly one NDJSON response.'));
        return;
      }
      try { finish(undefined, parseResponse(lines[0], profile)); }
      catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    });
    running.stdin!.once('error', (error) => finish(new Error(`Provider adapter input failed: ${error.message}`)));
    running.stdin!.end(request);
  });
}
