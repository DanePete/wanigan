import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { detectProviders, shellPath } from './providers';
import * as accounts from './accounts';

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
/** Keyed by account id (or '' for "whatever the environment chooses"): two logins are two answers. */
const cached = new Map<string, CodexStatus>();
const pending = new Map<string, Promise<CodexStatus>>();
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

/**
 * How much of the child's stderr is worth keeping, and why any is kept.
 *
 * stderr used to be read and thrown away, on the reasoning that a CLI warning
 * never alters an otherwise valid response.  That reasoning holds for a child
 * that answers; it cost us the one case where the child does not.  A codex
 * build with no `app-server` subcommand, or one that cannot parse its own
 * config.toml, prints the reason on stderr and exits immediately — and with no
 * exit handler the read sat for the full twelve seconds and then blamed the
 * timeout, paying that again on every refresh while the actual reason was
 * discarded.  Bounded because this is a diagnostic, not a log.
 */
const STDERR_CAP = 4_000;
const REASON_CAP = 200;

function takeStderr(text: string, chunk: Buffer): string {
  return text.length >= STDERR_CAP ? text : text + chunk.toString('utf8');
}

/**
 * `close`, never `exit`: `exit` can fire before the last stdout chunk is
 * delivered, which would turn a successful final reply into a spurious "exited
 * before answering".  `close` fires once the streams are drained, which is why
 * claude-limits.ts and provider-adapter.ts both settle on it too.
 */
function exitReason(label: string, code: number | null, stderr: string): string {
  const said = stderr.split('\n').map((line) => line.trim()).find((line) => line.length > 0);
  const how = code === null ? 'stopped' : code === 0 ? 'exited' : `exited with code ${code}`;
  return said
    ? `${label} ${how} before answering: ${said.slice(0, REASON_CAP)}`
    : `${label} ${how} before answering.`;
}

/**
 * What a read-only status probe needs, and nothing else.
 *
 * Handing the child the whole of process.env passes on every unrelated
 * credential the launching shell exported to a process that only reads two
 * numbers, which is the opposite of the stripping every other spawn in the
 * main process does. CODEX_HOME is kept deliberately — it is where the
 * person's own Codex login lives — while every other CODEX_* variable
 * identifies the *parent* session and makes app-server attach to that writer
 * instead of answering. Proxy and CA settings stay because the read is an
 * HTTPS call and a managed network cannot make it without them.
 */
function probeEnv(PATH: string, accountEnv: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH };
  for (const name of [
    'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'SHELL', 'CODEX_HOME',
    'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy',
    'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy',
    'SSL_CERT_FILE', 'SSL_CERT_DIR',
  ]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  // The account's CODEX_HOME last, the same way a launch applies it: the
  // status read has to describe the login the picked account actually uses,
  // and the ambient variable is only right for the account that adopted it.
  Object.assign(env, accountEnv);
  return env;
}

/**
 * The app-server surface belongs to the Codex harness, not to the profile id
 * that happens to be spelled 'codex'. A pack may ship a second Codex profile —
 * a different sign-in, a different model backend — and it speaks this same
 * protocol; an id test would have refused it while claiming Codex was not
 * installed. Harness is the declared fact, so it is what routes.
 *
 * The claim is not free: provider-packs.ts refuses a local pack that declares
 * the Codex harness without a separately trusted capability-probe adapter, so
 * a manifest alone cannot volunteer an arbitrary binary for `app-server`.
 */
async function codexAppServer(purpose: string): Promise<string> {
  const provider = (await detectProviders()).find((p) => p.harnessId === 'codex' && p.path);
  if (!provider?.path) {
    throw new Error(`No Codex-harness provider is installed, so Wanigan cannot read ${purpose}.`);
  }
  return provider.path;
}

async function request(accountEnv: Record<string, string>): Promise<CodexStatus> {
  const bin = await codexAppServer('Codex usage status');
  const PATH = await shellPath();

  return new Promise<CodexStatus>((resolve, reject) => {
    const child = spawn(bin, ['app-server', '--stdio'], {
      env: probeEnv(PATH, accountEnv), stdio: ['pipe', 'pipe', 'pipe'],
    });
    let settled = false;
    let buffer = '';
    let stderr = '';
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
    // Kept only to explain an early exit; a warning from a child that goes on
    // to answer settles nothing, because `done` has already run by then.
    child.stderr.on('data', (chunk: Buffer) => { stderr = takeStderr(stderr, chunk); });
    child.on('close', (code) => fail(exitReason('Codex status', code, stderr)));
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
  const bin = await codexAppServer('the Codex model catalog');
  const PATH = await shellPath();
  return new Promise<CodexModels>((resolve, reject) => {
    const child = spawn(bin, ['app-server', '--stdio'], { env: probeEnv(PATH), stdio: ['pipe', 'pipe', 'pipe'] });
    let settled = false; let buffer = ''; let stderr = '';
    const fail = (reason: string) => { if (settled) return; settled = true; clearTimeout(timer); stop(child); reject(new Error(reason)); };
    const done = (value: CodexModels) => { if (settled) return; settled = true; clearTimeout(timer); stop(child); resolve(value); };
    const send = (id: number, method: string, params: unknown) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    const timer = setTimeout(() => fail('Codex model catalog did not respond within 12 seconds.'), REQUEST_TIMEOUT_MS);
    child.on('error', (e) => fail(`Could not start Codex model catalog: ${e.message}`));
    child.stderr.on('data', (chunk: Buffer) => { stderr = takeStderr(stderr, chunk); });
    child.on('close', (code) => fail(exitReason('Codex model catalog', code, stderr)));
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

/**
 * Which account's limits. An explicit id names one of Wanigan's Codex accounts;
 * omitted means the default account, which for an adopted ~/.codex sets no
 * variable and reads exactly what a by-hand `codex` would. An id Wanigan does
 * not know is refused rather than silently read as the default.
 */
function accountEnvFor(accountId: string | null | undefined): { key: string; env: Record<string, string> } {
  if (accountId) {
    const account = accounts.byId(accountId);
    if (!account || account.harness !== 'codex') throw new Error('That Codex account no longer exists in Wanigan.');
    return { key: account.id, env: accounts.launchEnv(account) };
  }
  const account = accounts.resolve({ harness: 'codex' }).account;
  return { key: account?.id ?? '', env: accounts.launchEnv(account) };
}

export async function readCodexStatus(force = false, accountId?: string | null): Promise<CodexStatus> {
  const { key, env } = accountEnvFor(accountId);
  const hit = cached.get(key);
  if (!force && hit && Date.now() - hit.fetchedAt < CACHE_MS) return hit;
  const inFlight = pending.get(key);
  if (!force && inFlight) return inFlight;
  const work = request(env).then((value) => { cached.set(key, value); return value; });
  pending.set(key, work);
  try { return await work; }
  finally { if (pending.get(key) === work) pending.delete(key); }
}

export async function readCodexModels(force = false): Promise<CodexModels> {
  if (!force && modelsCached && Date.now() - modelsCached.fetchedAt < MODELS_CACHE_MS) return modelsCached;
  if (!force && modelsPending) return modelsPending;
  const work = requestModels().then((value) => { modelsCached = value; return value; });
  modelsPending = work;
  try { return await work; }
  finally { if (modelsPending === work) modelsPending = null; }
}

/**
 * The parse seam, exported the way claude-limits.ts exports its own.  Both
 * readers feed one Usage screen, and CLAUDE.md's rule — a format change
 * reported as "0% used" is worse than no screen at all — was enforced for
 * Claude and unenforced here.  `windowFrom` returning null for a renamed field,
 * rather than a zero-percent window, is the fact worth asserting.
 */
export const __test = { windowFrom, snapshot, exitReason };
