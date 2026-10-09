// Ask a Codex account who it is and what it has left, through Codex's own
// app-server (JSON-RPC over stdio). Read-only: account/read without a token
// refresh, account/rateLimits/read, model/list and hooks/list. No model call is
// made, and no thread is started. Ported from
// Wanigan 1 (src/main/modules/usage-codex-status.ts), with its lessons:
// - The child gets a minimal environment. Other CODEX_* variables identify a
//   parent session and make app-server attach to that writer instead of
//   answering; CODEX_HOME alone says which account.
// - Settle on `close`, not `exit`, so the last reply is not lost; an early exit
//   reports what the child said on stderr instead of waiting out the timeout.
import { spawn } from 'node:child_process';
import type { LimitWindow, AccountUsage } from '../shared/usage.ts';
import type { Probe } from './accounts.ts';
import { codexModels, type ModelChoice } from '../shared/models.ts';

const TIMEOUT_MS = 12_000;
const KEEP = ['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'SHELL',
  'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR'];

export interface CodexReading { probe: Probe; usage: AccountUsage }

type Call = (method: string, params: unknown) => Promise<unknown>;

/**
 * One app-server conversation: start it with a minimal environment (and any
 * `--config` flags in `args`), run `work` against it, and stop it however that
 * ends. Settles on `close`, not `exit`, so the last reply is not lost.
 */
function withCodexServer<T>(
  bin: string, configDir: string | null, path: string, what: string, work: (call: Call, notify: (method: string) => void) => Promise<T>, args: readonly string[] = [],
): Promise<T> {
  const env: Record<string, string> = { PATH: path };
  for (const k of KEEP) { const v = process.env[k]; if (v !== undefined) env[k] = v; }
  if (configDir) env.CODEX_HOME = configDir;

  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['app-server', ...args, '--stdio'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '';
    let stderr = '';
    let next = 1;
    let settled = false;
    const waiting = new Map<number, { ok: (v: unknown) => void; no: (e: Error) => void }>();
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGTERM'); } catch { /* gone */ }
      fn();
    };
    const fail = (why: string): void => finish(() => reject(new Error(why)));
    const timer = setTimeout(() => fail(`Codex did not answer ${what} within 12 seconds.`), TIMEOUT_MS);
    const send = (msg: Record<string, unknown>): void => { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`); };
    const call: Call = (method, params) => new Promise((ok, no) => {
      const id = next++;
      waiting.set(id, { ok, no });
      send({ id, method, params });
    });

    child.on('error', (e) => fail(`Could not start Codex: ${e.message}`));
    child.stderr.on('data', (d: Buffer) => { if (stderr.length < 4000) stderr += d.toString('utf8'); });
    child.on('close', (code) => {
      const said = stderr.split('\n').map((l) => l.trim()).find(Boolean);
      fail(`Codex ${code ? `exited with code ${code}` : 'stopped'} before answering${said ? `: ${said.slice(0, 200)}` : '.'}`);
    });
    child.stdout.on('data', (d: Buffer) => {
      buffer += d.toString('utf8');
      let at: number;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        let msg: { id?: number; result?: unknown; error?: { message?: unknown } };
        try { msg = JSON.parse(line); } catch { continue; }
        const w = typeof msg.id === 'number' ? waiting.get(msg.id) : undefined;
        if (!w) continue;
        waiting.delete(msg.id as number);
        if (msg.error) w.no(new Error(String(msg.error.message ?? 'unknown error'))); else w.ok(msg.result);
      }
    });

    void (async () => {
      await call('initialize', { clientInfo: { name: 'wanigan', version: '2.0.0' } });
      send({ method: 'initialized' });
      return work(call, (method) => send({ method }));
    })().then((value) => finish(() => resolve(value)), (e: Error) => fail(e.message));
  });
}

export function readCodexAccount(bin: string, configDir: string | null, path: string, now: () => number): Promise<CodexReading> {
  return withCodexServer(bin, configDir, path, 'about its account', async (call) => {
    const account = await call('account/read', { refreshToken: false }).catch(() => undefined);
    const probe = toProbe(account);
    if (probe.signedIn === 'no') return { probe, usage: { state: 'signed-out', windows: [], checkedAt: now(), note: null } satisfies AccountUsage };
    const limits = await call('account/rateLimits/read', { excludeResetCreditDetails: true }).catch((e: Error) => e);
    return { probe, usage: toUsage(limits, now()) };
  });
}

/** The models this Codex offers, with the reasoning efforts each accepts. Reading it costs nothing. */
export function readCodexModels(bin: string, configDir: string | null, path: string): Promise<ModelChoice[]> {
  return withCodexServer(bin, configDir, path, 'with its models', async (call) => {
    const models: ModelChoice[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const read = codexModels(await call('model/list', { includeHidden: false, limit: 200, ...(cursor ? { cursor } : {}) }));
      models.push(...read.models);
      cursor = read.nextCursor;
      if (!cursor) return models;
    }
    return models;
  });
}

/** One hook as Codex's `hooks/list` reports it (codex-cli 0.155.1). */
export interface ListedHook {
  key: string;
  /** camelCase: `sessionStart`, `preToolUse`, … */
  eventName: string;
  /** Where it was defined: `sessionFlags` for `--config` on the command line. */
  source: string;
  command: string | null;
  trustStatus: string;
  currentHash: string;
}

/**
 * The hooks Codex would run in `cwd` with these `--config` flags, as `configDir`.
 * Starting the app-server writes state into its CODEX_HOME, so callers pass a
 * throwaway folder, never an account's own.
 */
export function listCodexHooks(bin: string, configDir: string, path: string, args: readonly string[], cwd: string): Promise<ListedHook[]> {
  return withCodexServer(bin, configDir, path, 'about its hooks', async (call) => {
    const result = await call('hooks/list', { cwds: [cwd] }) as { data?: { hooks?: unknown[] }[] } | null;
    return (result?.data ?? []).flatMap((entry) => entry.hooks ?? []).map(toListedHook).filter((h): h is ListedHook => h !== null);
  }, args);
}

function toListedHook(value: unknown): ListedHook | null {
  const h = value && typeof value === 'object' ? value as Record<string, unknown> : null;
  if (!h || typeof h.key !== 'string' || typeof h.eventName !== 'string' || typeof h.currentHash !== 'string') return null;
  return {
    key: h.key, eventName: h.eventName, source: String(h.source ?? ''), command: typeof h.command === 'string' ? h.command : null,
    trustStatus: String(h.trustStatus ?? ''), currentHash: h.currentHash,
  };
}

function toProbe(result: unknown): Probe {
  const raw = result && typeof result === 'object' ? result as { account?: unknown } : null;
  if (!raw || !('account' in raw)) return { signedIn: 'unknown', identity: null, plan: null };
  if (raw.account === null) return { signedIn: 'no', identity: null, plan: null };
  const a = raw.account as { type?: unknown; email?: unknown; planType?: unknown };
  return {
    signedIn: 'yes',
    identity: typeof a.email === 'string' ? a.email : typeof a.type === 'string' ? a.type : null,
    plan: typeof a.planType === 'string' ? a.planType : null,
  };
}

function toUsage(result: unknown, now: number): AccountUsage {
  if (result instanceof Error) return { state: 'unreadable', windows: [], checkedAt: now, note: result.message.slice(0, 200) };
  const raw = result && typeof result === 'object' ? result as { rateLimits?: unknown; ordinaryUsageAllowed?: unknown } : null;
  const limits = raw?.rateLimits && typeof raw.rateLimits === 'object' ? raw.rateLimits as { primary?: unknown; secondary?: unknown } : null;
  const windows = [limits?.primary, limits?.secondary].map(toWindow).filter((w): w is LimitWindow => w !== null)
    .sort((a, b) => (a.kind === 'session' ? 0 : 1) - (b.kind === 'session' ? 0 : 1));
  if (!windows.length) return { state: 'unreadable', windows: [], checkedAt: now, note: 'Codex reported no limit windows.' };
  return {
    state: 'ok', windows, checkedAt: now,
    note: raw?.ordinaryUsageAllowed === false ? 'Codex says this account cannot be used for ordinary work until a limit resets.' : null,
  };
}

function toWindow(value: unknown): LimitWindow | null {
  const w = value && typeof value === 'object' ? value as { usedPercent?: unknown; windowDurationMins?: unknown; resetsAt?: unknown } : null;
  if (!w || typeof w.usedPercent !== 'number' || !Number.isFinite(w.usedPercent)) return null;
  const minutes = typeof w.windowDurationMins === 'number' ? w.windowDurationMins : null;
  return {
    kind: minutes !== null && minutes > 24 * 60 ? 'week' : 'session',
    scope: null,
    usedPercent: Math.max(0, Math.min(100, w.usedPercent)),
    resetsAtText: null,
    resetsAt: typeof w.resetsAt === 'number' ? w.resetsAt * 1000 : null,
  };
}
