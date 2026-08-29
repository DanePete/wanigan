import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { detectProviders, shellPath } from './providers';

/**
 * The Codex app-server is the one supported local surface that can report the
 * account's actual rolling limit windows.  Terminal output and cumulative
 * token counters cannot answer "what is left": compaction, cached input and
 * plan-specific limits make every calculation from them a guess.
 *
 * We start a short-lived, stdio-only app-server for each cached read.  It uses
 * the person's existing Codex login, sends only the two read methods below,
 * and exits straight afterwards.  No credentials leave the machine through
 * Wanigan and this module deliberately has no reset/consume operation.
 */
export type CodexLimitWindow = {
  usedPercent: number;
  remainingPercent: number;
  /** Unix milliseconds, or null when Codex did not provide a reset time. */
  resetsAt: number | null;
  windowMinutes: number | null;
};

export type CodexStatus = {
  fetchedAt: number;
  plan: string | null;
  primary: CodexLimitWindow | null;
  secondary: CodexLimitWindow | null;
  spendControlReached: boolean | null;
};

export type CodexModel = {
  id: string;
  label: string;
  description: string | null;
  reasoningEfforts: string[];
  defaultReasoningEffort: string | null;
  isDefault: boolean;
};

export type CodexModels = { fetchedAt: number; models: CodexModel[]; note: string | null };

const CACHE_MS = 45_000;
const MODELS_CACHE_MS = 10 * 60_000;
const REQUEST_TIMEOUT_MS = 12_000;
let cached: CodexStatus | null = null;
let pending: Promise<CodexStatus> | null = null;
let modelsCached: CodexModels | null = null;
let modelsPending: Promise<CodexModels> | null = null;

type RpcMessage = { id?: number; result?: unknown; error?: { message?: unknown }; method?: string };
type RawWindow = { usedPercent?: unknown; resetsAt?: unknown; windowDurationMins?: unknown };
type RawLimits = {
  planType?: unknown; primary?: RawWindow | null; secondary?: RawWindow | null;
  spendControlReached?: unknown;
};

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function windowFrom(raw: RawWindow | null | undefined): CodexLimitWindow | null {
  if (!raw) return null;
  const used = numberOrNull(raw.usedPercent);
  if (used === null) return null;
  const seconds = numberOrNull(raw.resetsAt);
  return {
    usedPercent: Math.max(0, Math.min(100, Math.round(used))),
    remainingPercent: Math.max(0, Math.min(100, 100 - Math.round(used))),
    resetsAt: seconds === null ? null : seconds * 1000,
    windowMinutes: numberOrNull(raw.windowDurationMins),
  };
}

function snapshot(result: unknown): CodexStatus {
  const r = (result && typeof result === 'object' ? result : {}) as { rateLimits?: RawLimits | null };
  const limits = r.rateLimits ?? {};
  return {
    fetchedAt: Date.now(),
    plan: typeof limits.planType === 'string' ? limits.planType : null,
    primary: windowFrom(limits.primary),
    secondary: windowFrom(limits.secondary),
    spendControlReached: typeof limits.spendControlReached === 'boolean' ? limits.spendControlReached : null,
  };
}

function stop(child: ChildProcessWithoutNullStreams): void {
  if (!child.killed) { try { child.kill('SIGTERM'); } catch { /* already gone */ } }
}

async function request(): Promise<CodexStatus> {
  const provider = (await detectProviders()).find((p) => p.id === 'codex');
  if (!provider?.path) throw new Error('Codex is not installed, so Wanigan cannot read its usage status.');
  const PATH = await shellPath();

  return new Promise<CodexStatus>((resolve, reject) => {
    const child = spawn(provider.path!, ['app-server', '--stdio'], {
      env: { ...process.env, PATH }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let settled = false;
    let buffer = '';
    const fail = (reason: string) => {
      if (settled) return;
      settled = true; clearTimeout(timer); stop(child); reject(new Error(reason));
    };
    const done = (value: CodexStatus) => {
      if (settled) return;
      settled = true; clearTimeout(timer); stop(child); resolve(value);
    };
    const send = (id: number, method: string, params: unknown) => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    };
    const timer = setTimeout(() => fail('Codex status did not respond within 12 seconds.'), REQUEST_TIMEOUT_MS);

    child.on('error', (e) => fail(`Could not start Codex status: ${e.message}`));
    child.stderr.on('data', () => { /* CLI warnings never alter an otherwise valid response. */ });
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        const end = buffer.indexOf('\n');
        if (end < 0) break;
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let msg: RpcMessage;
        try { msg = JSON.parse(line) as RpcMessage; } catch { continue; }
        if (msg.id === 1) {
          if (msg.error) { fail(`Codex status could not initialize: ${String(msg.error.message ?? 'unknown error')}`); return; }
          send(2, 'account/rateLimits/read', null);
        } else if (msg.id === 2) {
          if (msg.error) { fail(`Codex did not provide usage status: ${String(msg.error.message ?? 'unknown error')}`); return; }
          done(snapshot(msg.result));
        }
      }
    });
    // App-server's versioned protocol begins with initialize.  The declared
    // capability only permits its documented read notifications; no account
    // mutation is negotiated or sent.
    send(1, 'initialize', {
      clientInfo: { name: 'wanigan', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
  });
}

async function requestModels(): Promise<CodexModels> {
  const provider = (await detectProviders()).find((p) => p.id === 'codex');
  if (!provider?.path) throw new Error('Codex is not installed, so Wanigan cannot read its model catalog.');
  const PATH = await shellPath();
  return new Promise<CodexModels>((resolve, reject) => {
    const child = spawn(provider.path!, ['app-server', '--stdio'], { env: { ...process.env, PATH }, stdio: ['pipe', 'pipe', 'pipe'] });
    let settled = false; let buffer = '';
    const fail = (reason: string) => { if (settled) return; settled = true; clearTimeout(timer); stop(child); reject(new Error(reason)); };
    const done = (value: CodexModels) => { if (settled) return; settled = true; clearTimeout(timer); stop(child); resolve(value); };
    const send = (id: number, method: string, params: unknown) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    const timer = setTimeout(() => fail('Codex model catalog did not respond within 12 seconds.'), REQUEST_TIMEOUT_MS);
    child.on('error', (e) => fail(`Could not start Codex model catalog: ${e.message}`));
    child.stderr.on('data', () => {});
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        const end = buffer.indexOf('\n'); if (end < 0) break;
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let msg: RpcMessage; try { msg = JSON.parse(line) as RpcMessage; } catch { continue; }
        if (msg.id === 1) {
          if (msg.error) { fail(`Codex model catalog could not initialize: ${String(msg.error.message ?? 'unknown error')}`); return; }
          send(2, 'model/list', { includeHidden: false, limit: 200 });
        } else if (msg.id === 2) {
          if (msg.error) { fail(`Codex did not provide its model catalog: ${String(msg.error.message ?? 'unknown error')}`); return; }
          const raw = (msg.result && typeof msg.result === 'object' ? msg.result : {}) as { data?: unknown[] };
          const models = (raw.data ?? []).filter((m): m is Record<string, unknown> => !!m && typeof m === 'object').map((m) => ({
            id: typeof m.id === 'string' ? m.id : '',
            label: typeof m.displayName === 'string' ? m.displayName : (typeof m.id === 'string' ? m.id : ''),
            description: typeof m.description === 'string' ? m.description : null,
            reasoningEfforts: Array.isArray(m.supportedReasoningEfforts) ? m.supportedReasoningEfforts.map((x) => {
              if (typeof x === 'string') return x;
              if (x && typeof x === 'object' && typeof (x as { reasoningEffort?: unknown }).reasoningEffort === 'string') {
                return String((x as { reasoningEffort: string }).reasoningEffort);
              }
              return '';
            }).filter(Boolean) : [],
            defaultReasoningEffort: typeof m.defaultReasoningEffort === 'string' ? m.defaultReasoningEffort : null,
            isDefault: m.isDefault === true,
          })).filter((m) => m.id);
          done({ fetchedAt: Date.now(), models, note: null });
        }
      }
    });
    send(1, 'initialize', { clientInfo: { name: 'wanigan', version: '0.1.0' }, capabilities: { experimentalApi: true } });
  });
}

export async function readCodexStatus(force = false): Promise<CodexStatus> {
  if (!force && cached && Date.now() - cached.fetchedAt < CACHE_MS) return cached;
  if (!force && pending) return pending;
  const work = request().then((value) => { cached = value; return value; });
  pending = work;
  try { return await work; }
  finally { if (pending === work) pending = null; }
}

export async function readCodexModels(force = false): Promise<CodexModels> {
  if (!force && modelsCached && Date.now() - modelsCached.fetchedAt < MODELS_CACHE_MS) return modelsCached;
  if (!force && modelsPending) return modelsPending;
  const work = requestModels().then((value) => { modelsCached = value; return value; });
  modelsPending = work;
  try { return await work; }
  finally { if (modelsPending === work) modelsPending = null; }
}
