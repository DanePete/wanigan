import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { detectProviders, shellPath } from '../providers';
import * as accounts from '../accounts';
import { usageAccountRevision, usageLoginWitnessed } from './usage-account-identity';
import type { AccountIdentity, AgentAccount } from '../../shared/types';
import { randomUUID } from 'node:crypto';
import { codexAccount, codexModelPage, codexRateLimits, codexResetCredits, codexResetOutcome, codexWindow } from '../../shared/codex-account';
import type { CodexLimitBucket, CodexLimitWindow, CodexModel, CodexResetCredits, CodexResetOutcome } from '../../shared/codex-account';

/**
 * The Codex app-server is the one supported local surface that can report the
 * account's actual rolling limit windows.  Terminal output and cumulative
 * token counters cannot answer "what is left": compaction, cached input and
 * plan-specific limits make every calculation from them a guess.
 *
 * We start a short-lived, stdio-only app-server for each cached read.  It uses
 * the person's existing Codex login, sends only the read methods below,
 * and exits straight afterwards.  No credentials leave the machine through
 * Wanigan.
 *
 * The one write here is `consumeResetCredit`: it redeems a banked limit reset
 * the backend itself reported, and it runs only on an explicit press behind a
 * confirmation. It is never on a poll, a refresh, or a launch path — a banked
 * reset is an asset the person holds, and spending one is their decision.
 */
export type { CodexLimitBucket, CodexLimitWindow, CodexModel } from '../../shared/codex-account';

export type CodexStatus = {
  fetchedAt: number;
  plan: string | null;
  primary: CodexLimitWindow | null;
  secondary: CodexLimitWindow | null;
  spendControlReached: boolean | null;
  identity?: AccountIdentity | null;
  authState?: 'signed-in' | 'signed-out' | 'unknown';
  /** Every metered limit the backend named, as reported. */
  buckets?: CodexLimitBucket[];
  /** Banked resets as the backend reported them; null when the reply carried no summary. */
  resetCredits?: CodexResetCredits | null;
  /** The backend's verdict; null is unavailable and is never read as allowed. */
  ordinaryUsageAllowed?: boolean | null;
  /** Ordinary account metadata. Stays in main; it is how a login change is
   * seen when credentials live in the OS keyring. */
  backendAccountId?: string | null;
  requiresOpenaiAuth?: boolean | null;
  /** false for an API-key login, which has no ChatGPT allowance to report.
   * That is not a fault and not zero usage. */
  quotaApplicable?: boolean;
  /** false when this account's credential store means a file stat cannot see
   * a login change, so the reading was not served from cache. */
  loginWitnessed?: boolean;
};

export type CodexModels = {
  fetchedAt: number; models: CodexModel[]; note: string | null;
  /** The catalog this client would offer. Never evidence that a login may run a model. */
  authState?: 'signed-in' | 'signed-out' | 'unknown';
};

const CACHE_MS = 45_000;
const MODELS_CACHE_MS = 10 * 60_000;
const REQUEST_TIMEOUT_MS = 12_000;
/** Keyed by account id (or '' for "whatever the environment chooses"): two logins are two answers. */
const cached = new Map<string, { revision: string; value: CodexStatus }>();
const pending = new Map<string, Promise<CodexStatus>>();
/** Keyed by account and login revision: one login's catalog is not another's. */
const modelsCached = new Map<string, CodexModels>();
const modelsPending = new Map<string, Promise<CodexModels>>();
/** The cursor is opaque and one page is the whole list today, so this bound is
 * only ever reached by a server that never ends its list. */
const MAX_MODEL_PAGES = 20;

function snapshot(result: unknown): CodexStatus {
  const limits = codexRateLimits(result);
  return {
    fetchedAt: Date.now(), plan: limits.plan, primary: limits.primary, secondary: limits.secondary,
    spendControlReached: limits.spendControlReached, buckets: limits.buckets,
    ordinaryUsageAllowed: limits.ordinaryUsageAllowed, backendAccountId: limits.backendAccountId,
    resetCredits: codexResetCredits(result),
  };
}

function accountIdentity(result: unknown): Pick<CodexStatus, 'identity' | 'authState' | 'requiresOpenaiAuth'> & { type: string | null } {
  const read = codexAccount(result);
  return {
    authState: read.authState, requiresOpenaiAuth: read.requiresOpenaiAuth, type: read.type,
    identity: read.authState === 'signed-in' ? { email: read.email, orgName: null, plan: read.plan, authMethod: read.type } : null,
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
function probeEnv(PATH: string): NodeJS.ProcessEnv {
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

type RpcMessage = { id?: number; result?: unknown; error?: { message?: unknown }; method?: string };
type Call = (method: string, params: unknown) => Promise<unknown>;
class RpcError extends Error {}

/**
 * One short-lived app-server, bound to the account exactly as a launch is.
 * The handshake stays on the stable surface: no `experimentalApi`, and the
 * `initialized` notification the protocol expects after `initialize`.
 */
async function session<T>(account: AgentAccount | null, label: string, purpose: string, run: (call: Call) => Promise<T>): Promise<T> {
  const bin = await codexAppServer(purpose);
  const PATH = await shellPath();
  return new Promise<T>((resolve, reject) => {
    const env = probeEnv(PATH);
    // Default means unset, not an empty object spread over ambient CODEX_HOME.
    accounts.applyLaunchEnv(env, account);
    const child = spawn(bin, ['app-server', '--stdio'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let settled = false; let buffer = ''; let stderr = ''; let next = 1;
    const waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
    const settle = (finish: () => void) => { if (settled) return; settled = true; clearTimeout(timer); stop(child); finish(); };
    const fail = (reason: string) => settle(() => reject(new Error(reason)));
    const timer = setTimeout(() => fail(`${label} did not respond within 12 seconds.`), REQUEST_TIMEOUT_MS);
    const write = (message: Record<string, unknown>) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
    const call: Call = (method, params) => new Promise((ok, no) => { const id = next++; waiting.set(id, { resolve: ok, reject: no }); write({ id, method, params }); });

    child.on('error', (e) => fail(`Could not start ${label}: ${e.message}`));
    // Kept only to explain an early exit; a warning from a child that goes on
    // to answer settles nothing, because the read has already settled by then.
    child.stderr.on('data', (chunk: Buffer) => { stderr = takeStderr(stderr, chunk); });
    child.on('close', (code) => fail(exitReason(label, code, stderr)));
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        const end = buffer.indexOf('\n');
        if (end < 0) break;
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let msg: RpcMessage;
        try { msg = JSON.parse(line) as RpcMessage; } catch { continue; }
        const pendingCall = typeof msg.id === 'number' ? waiting.get(msg.id) : undefined;
        if (!pendingCall) continue;
        waiting.delete(msg.id!);
        if (msg.error) pendingCall.reject(new RpcError(String(msg.error.message ?? 'unknown error')));
        else pendingCall.resolve(msg.result);
      }
    });
    // Reads, and the one confirmed write: consumeResetCredit. Nothing here
    // negotiates a login, refreshes a token or edits configuration.
    call('initialize', { clientInfo: { name: 'wanigan', version: '0.1.0' } })
      .catch((e: Error) => { throw new Error(`${label} could not initialize: ${e.message}`); })
      .then(() => { write({ method: 'initialized' }); return run(call); })
      .then((value) => settle(() => resolve(value)), (e: Error) => fail(e.message));
  });
}

function request(account: AgentAccount | null): Promise<CodexStatus> {
  return session(account, 'Codex status', 'Codex usage status', async (call) => {
    // Older readers can still report limits when account/read is absent.
    // No email is invented, and no token refresh or account mutation is requested.
    const { type, ...identity } = await call('account/read', { refreshToken: false }).then(accountIdentity,
      () => accountIdentity(undefined));
    if (identity.authState === 'signed-out') return { ...snapshot({}), ...identity };
    try {
      // Reset-credit detail is asked for: this read runs on a visit or a press,
      // never a poll, and the rows are what let a person see a banked reset
      // before its thirty-day clock runs out. The reserve fallback is never
      // asked for — that would record an experiment exposure.
      return { ...snapshot(await call('account/rateLimits/read', { excludeResetCreditDetails: false })), ...identity, quotaApplicable: true };
    } catch (e) {
      // An API-key login has no ChatGPT allowance. The backend says so by
      // refusing; that is "not applicable", neither a fault nor zero usage.
      if (type === 'apiKey') return { ...snapshot({}), ...identity, quotaApplicable: false };
      throw new Error(`Codex did not provide usage status: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
}

function requestModels(account: AgentAccount | null): Promise<CodexModels> {
  return session(account, 'Codex model catalog', 'the Codex model catalog', async (call) => {
    const { authState } = await call('account/read', { refreshToken: false }).then(accountIdentity, () => accountIdentity(undefined));
    const models: CodexModel[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_MODEL_PAGES; page++) {
      let result: unknown;
      try { result = await call('model/list', { includeHidden: false, limit: 200, ...(cursor ? { cursor } : {}) }); }
      catch (e) { throw new Error(`Codex did not provide its model catalog: ${e instanceof Error ? e.message : String(e)}`); }
      const read = codexModelPage(result);
      models.push(...read.models);
      cursor = read.nextCursor;
      if (!cursor) return { fetchedAt: Date.now(), models, authState, note: authState === 'signed-out'
        ? 'Codex reports no signed-in account. This is the catalog the CLI would offer, not models this login can run.' : null };
    }
    throw new Error(`Codex model catalog did not end within ${MAX_MODEL_PAGES} pages.`);
  });
}

/**
 * Which account's limits. An explicit id names one of Wanigan's Codex accounts;
 * omitted means the default account, which for an adopted ~/.codex sets no
 * variable and reads exactly what a by-hand `codex` would. An id Wanigan does
 * not know is refused rather than silently read as the default.
 */
function accountFor(accountId: string | null | undefined): AgentAccount | null {
  if (accountId) {
    const account = accounts.byId(accountId);
    if (!account || account.harness !== 'codex') throw new Error('That Codex account no longer exists in Wanigan.');
    return account;
  }
  return accounts.resolve({ harness: 'codex' }).account;
}

export async function readCodexStatus(force = false, accountId?: string | null): Promise<CodexStatus> {
  const account = accountFor(accountId);
  const key = account?.id ?? '';
  const revision = account ? usageAccountRevision(account) : process.env.CODEX_HOME ?? '';
  // With credentials in the OS keyring a login can change under an unchanged
  // file revision, so such a reading is never reused; the read itself is free.
  const loginWitnessed = account ? usageLoginWitnessed(account) : true;
  const hit = cached.get(key);
  if (!force && loginWitnessed && hit?.revision === revision && Date.now() - hit.value.fetchedAt < CACHE_MS) return hit.value;
  const pendingKey = `${key}:${revision}`;
  const inFlight = pending.get(pendingKey);
  if (!force && inFlight) return inFlight;
  const work = request(account).then((read) => {
    if (account && usageAccountRevision(account) !== revision) throw new Error('The account login changed while limits were being read. Refresh limits to try again.');
    const value = { ...read, loginWitnessed };
    cached.set(key, { revision, value }); return value;
  });
  pending.set(pendingKey, work);
  try { return await work; }
  finally { if (pending.get(pendingKey) === work) pending.delete(pendingKey); }
}

/**
 * Redeem one banked reset on this account, then re-read its limits.
 *
 * The backend picks the next available credit when none is named. The
 * idempotency key is fresh per press: a retry of the same logical attempt is
 * the person pressing again, and the backend answers `alreadyRedeemed` if the
 * first one landed. The cached reading is dropped before the re-read so the
 * answer is the backend's, not a forty-five-second-old snapshot.
 */
export async function consumeResetCredit(accountId: string, creditId?: string | null): Promise<{ outcome: CodexResetOutcome; status: CodexStatus }> {
  const account = accountFor(accountId);
  if (!account) throw new Error('A Codex account must be named to use a banked reset.');
  const outcome = await session(account, 'Codex reset', 'a banked reset', async (call) => {
    let result: unknown;
    try {
      result = await call('account/rateLimitResetCredit/consume', {
        idempotencyKey: randomUUID(), ...(creditId ? { creditId } : {}),
      });
    } catch (e) { throw new Error(`Codex did not use the reset: ${e instanceof Error ? e.message : String(e)}`); }
    const word = codexResetOutcome(result);
    if (!word) throw new Error('Codex answered the reset with a word this reader does not know. Refresh limits to see what changed.');
    return word;
  });
  cached.delete(account.id);
  return { outcome, status: await readCodexStatus(true, account.id) };
}

export async function readCodexModels(force = false, accountId?: string | null): Promise<CodexModels> {
  const account = accountFor(accountId);
  const key = `${account?.id ?? ''}:${account ? usageAccountRevision(account) : process.env.CODEX_HOME ?? ''}`;
  const hit = modelsCached.get(key);
  if (!force && hit && Date.now() - hit.fetchedAt < MODELS_CACHE_MS) return hit;
  const inFlight = modelsPending.get(key);
  if (!force && inFlight) return inFlight;
  const work = requestModels(account).then((value) => {
    // A login's superseded revisions are dropped with it, so the map stays one entry per account.
    for (const old of modelsCached.keys()) if (old.startsWith(`${account?.id ?? ''}:`)) modelsCached.delete(old);
    modelsCached.set(key, value); return value;
  });
  modelsPending.set(key, work);
  try { return await work; }
  finally { if (modelsPending.get(key) === work) modelsPending.delete(key); }
}

/**
 * The parse seam, exported the way claude-limits.ts exports its own.  Both
 * readers feed one Usage screen, and CLAUDE.md's rule — a format change
 * reported as "0% used" is worse than no screen at all — was enforced for
 * Claude and unenforced here.  `windowFrom` returning null for a renamed field,
 * rather than a zero-percent window, is the fact worth asserting.
 */
export const __test = { windowFrom: codexWindow, snapshot, exitReason };
