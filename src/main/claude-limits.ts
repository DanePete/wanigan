import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { detectProviders, providerById, shellPath } from './providers';
import * as accounts from './accounts';
import type { AccountIdentity, AccountLimits, AgentAccount, LimitWindow, UsageFactors } from '../shared/types';

/**
 * What is left on a Claude account, read live.
 *
 * The same shape as codex-status.ts and for the same reason its header gives:
 * cumulative token counters on this machine cannot answer "what is left",
 * because compaction, cached input and plan-specific limits make every such
 * calculation a guess. Only the provider knows, and it will say if asked.
 *
 * `claude -p "/usage"` is the one non-interactive way to ask. It runs with the
 * account's own configuration directory, so the answer is that account's — this
 * is what makes work and personal separable. It uses the person's existing
 * login; no credential passes through Wanigan.
 *
 * The reply is human text, not JSON, so this parser is deliberately strict and
 * fails loudly. A format change must surface as "could not read this" rather
 * than as a number that looks fine and is wrong.
 */

/** Bounds the probe. A limits read must never be why the window stops painting. */
const TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 256 * 1024;

/**
 * How long a reading stays presentable.
 *
 * Past this the surface says the figure is stale rather than showing an hour-old
 * percentage as current. Chosen against the shortest window Claude reports: a
 * five-hour session limit moves fast enough that ten minutes is already a
 * visible drift, and slower than that is a lie of omission.
 */
export const STALE_AFTER_MS = 10 * 60_000;

/**
 * How long a reading that did not answer is held.
 *
 * Short on purpose. A failed probe is not a fact about the account, it is a
 * fact about one attempt, and the card's own advice ("run /login", "press
 * Refresh") is answerable in less than a minute. Long enough that a page that
 * mounts three times in a row spawns one probe, not three.
 */
export const FAILURE_CACHE_MS = 30_000;

type Cached = { at: number; value: AccountLimits };
const cache = new Map<string, Cached>();

/**
 * `Current session: 5% used · resets Sep 4 at 1:29pm (America/Chicago)`
 * `Current week (all models): 79% used · resets Sep 6 at 8:59pm (America/Chicago)`
 * `Current week (Fable): 100% used · resets Sep 6 at 8:59pm (America/Chicago)`
 * `Current session: 0% used`
 *
 * The reset clause is optional, and that is not a tolerance — it is a shape the
 * agent actually prints. A window with nothing used yet has no reset to
 * announce, so every line comes back bare. Requiring the clause made a second,
 * unused account read as "Wanigan could not read a limit window out of the
 * agent's reply", which is a false report of a broken format and points at
 * exactly the wrong thing: the account was fine, and the answer was 0%.
 */
const WINDOW_LINE = /^Current\s+(\w+)(?:\s*\(([^)]+)\))?:\s*(\d+(?:\.\d+)?)%\s+used(?:\s*·\s*resets\s+(.+?))?\s*$/;
const PERIOD_LINE = /^Last\s+(\S+)\s*·\s*([\d,]+)\s+requests?\s*·\s*([\d,]+)\s+sessions?\s*$/;
const SIGNED_OUT = /(not logged in|please run \/login|login expired|invalid api key)/i;

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * "Sep 6 at 8:59pm (America/Chicago)" to an epoch, or null.
 *
 * Null is a perfectly good answer here and the surface handles it: the verbatim
 * text is always kept, so a countdown is a bonus rather than a dependency. The
 * year is inferred because the provider omits it — a date that lands far in the
 * past is read as next year, which is the only reading that makes sense for a
 * reset time.
 */
export function parseResetAt(text: string, now = Date.now()): number | null {
  // Minutes are optional: the agent prints "9pm" on the hour and "1:29pm"
  // otherwise, and an on-the-hour reset was silently unparseable without this.
  const match = /^([A-Za-z]{3})\w*\s+(\d{1,2})\s+at\s+(\d{1,2})(?::(\d{2}))?\s*([ap]m)/i.exec(text.trim());
  if (!match) return null;
  const month = MONTHS.indexOf(match[1].toLowerCase());
  if (month < 0) return null;
  const day = Number(match[2]);
  let hour = Number(match[3]) % 12;
  if (match[5].toLowerCase() === 'pm') hour += 12;
  const minute = match[4] === undefined ? 0 : Number(match[4]);
  if (!Number.isFinite(day) || !Number.isFinite(minute)) return null;
  const year = new Date(now).getFullYear();
  // Built in local time deliberately: the provider prints its zone name, and
  // resolving an IANA zone by hand is more ways to be wrong than it is worth.
  // A machine in the zone it printed reads exactly right; one elsewhere is off
  // by its offset, which is why the verbatim text stays the primary display.
  let at = new Date(year, month, day, hour, minute, 0, 0).getTime();
  if (at < now - 45 * 86_400_000) at = new Date(year + 1, month, day, hour, minute, 0, 0).getTime();
  return Number.isFinite(at) ? at : null;
}

const num = (raw: string): number | null => {
  const value = Number(raw.replace(/,/g, ''));
  return Number.isFinite(value) ? value : null;
};

/** Parse the CLI's reply. Exported so the shape can be tested without spawning. */
export function parseUsage(text: string, now = Date.now()): { windows: LimitWindow[]; factors: UsageFactors[]; plan: string | null } {
  const windows: LimitWindow[] = [];
  const factors: UsageFactors[] = [];
  let plan: string | null = null;
  let current: UsageFactors | null = null;

  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    const trimmed = line.trim();

    const windowMatch = WINDOW_LINE.exec(trimmed);
    if (windowMatch) {
      current = null;
      const scope = windowMatch[2]?.trim() ?? null;
      windows.push({
        kind: windowMatch[1].toLowerCase(),
        // "all models" is the absence of a model scope, not a model named that.
        scope: !scope || /^all models$/i.test(scope) ? null : scope,
        usedPercent: Math.max(0, Math.min(100, Number(windowMatch[3]))),
        resetsAtText: windowMatch[4] ?? null,
        resetsAt: windowMatch[4] ? parseResetAt(windowMatch[4], now) : null,
      });
      continue;
    }

    const periodMatch = PERIOD_LINE.exec(trimmed);
    if (periodMatch) {
      current = { label: `Last ${periodMatch[1]}`, requests: num(periodMatch[2]), sessions: num(periodMatch[3]), lines: [] };
      factors.push(current);
      continue;
    }

    // Only indented lines belong to a period block; a flush line ends it.
    if (current && trimmed && /^\s/.test(line)) { current.lines.push(trimmed); continue; }
    if (trimmed === '') continue;
    if (current) current = null;

    if (!plan) {
      const planMatch = /using your (\w+(?:\s+\w+)?) to power/i.exec(trimmed);
      if (planMatch) plan = planMatch[1];
    }
  }
  return { windows, factors, plan };
}

/**
 * The binary that speaks this harness, not the profile that happens to be
 * spelled 'claude'.
 *
 * Accounts are routed by harness everywhere else (`accounts.list('claude-code')`),
 * so resolving the binary by profile id meant a Claude-harness account shipped
 * by a pack was probed with whatever `claude` was on PATH — possibly a
 * different install from the one its sessions actually run.
 */
async function claudeBin(): Promise<string> {
  const installed = (await detectProviders()).find((p) => p.harnessId === 'claude-code' && p.path);
  return installed?.path ?? providerById('claude')?.bin ?? 'claude';
}

/**
 * Run the probe in a directory with no project configuration.
 *
 * A repository's own settings and trust state have nothing to do with an
 * account's limits, and loading them only adds ways for the read to prompt,
 * warn, or fail on a repo the operator was not even asking about.
 */
function neutralCwd(): string {
  const dir = path.join(os.tmpdir(), 'wanigan-limits');
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { /* fall through to tmp */ }
  return fs.existsSync(dir) ? dir : os.tmpdir();
}

/**
 * Ask the agent who this directory is signed in as.
 *
 * Definitive where the file heuristic in accounts.ts is only evidence: on macOS
 * the credential is in the Keychain and cannot be read from disk at all, so the
 * only honest way to answer "is this signed in, and as whom" is to ask. It also
 * returns the plan and organisation, which is what actually distinguishes a
 * work account from a personal one on screen.
 */
async function runAuthStatus(
  account: AgentAccount,
): Promise<{ identity: AccountIdentity | null; failure: string | null }> {
  const { text, failure } = await run(account, ['auth', 'status', '--json']);
  if (failure) return { identity: null, failure };
  // Warnings from the account's own settings file are printed before the JSON,
  // so parse from the first brace rather than the first byte.
  const start = text.indexOf('{');
  // No JSON at all is a reply this reader does not understand, not a logged-out
  // account: only `loggedIn: false` says that.
  if (start < 0) {
    return { identity: null, failure: 'The agent answered `auth status --json` with something this reader could not parse.' };
  }
  try {
    const raw = JSON.parse(text.slice(start)) as Record<string, unknown>;
    if (raw.loggedIn !== true) return { identity: null, failure: null };
    const str = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null);
    return {
      identity: {
        email: str(raw.email), orgName: str(raw.orgName),
        plan: str(raw.subscriptionType), authMethod: str(raw.authMethod),
      },
      failure: null,
    };
  } catch (e) {
    return { identity: null, failure: `The agent’s sign-in reply was not valid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
}

async function runProbe(account: AgentAccount): Promise<ProbeResult> {
  return await run(account, ['-p', '/usage']);
}

/**
 * What a read-only limits probe needs, and nothing else.
 *
 * Handing the child the whole of process.env passes every unrelated credential
 * the launching shell exported to a process that only reads a few percentages,
 * which is the opposite of the stripping every other spawn in the main process
 * does — and CLAUDECODE / CLAUDE_CODE_SESSION_ID / CLAUDE_CODE_ENTRYPOINT make
 * the probe believe it is a subprocess of the session that launched Wanigan,
 * which is exactly why sessions.ts and headless.ts strip them. CLAUDE_CONFIG_DIR
 * is applied from the account below, never inherited: the ambient one is only
 * right for the account that adopted it.
 */
function probeEnv(PATH: string, accountEnv: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH };
  for (const name of [
    'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'SHELL',
    'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy',
    'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy',
    'SSL_CERT_FILE', 'SSL_CERT_DIR',
  ]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  Object.assign(env, accountEnv);
  return env;
}

/**
 * The outcome of one probe.
 *
 * `failure` is set when the process never answered — it could not be spawned,
 * it was killed at the timeout, or it exited non-zero with nothing usable on
 * stdout. Collapsing those into an empty string made every one of them read as
 * "Not signed in", which sent the operator to run /login on an account that was
 * signed in the whole time.
 */
type ProbeResult = { text: string; code: number | null; failure: string | null };

async function run(account: AgentAccount, args: string[]): Promise<ProbeResult> {
  const PATH = await shellPath();
  const bin = await claudeBin();
  const env = probeEnv(PATH, accounts.launchEnv(account));

  return await new Promise((resolve) => {
    let out = ''; let err = ''; let done = false;
    const child = spawn(bin, args, { cwd: neutralCwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
    const settle = (code: number | null, failure: string | null) => {
      if (done) return;
      done = true; clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch { /* gone */ }
      resolve({ text: out, code, failure });
    };
    const timer = setTimeout(
      () => settle(null, `${bin} did not answer within ${Math.round(TIMEOUT_MS / 1000)} seconds.`),
      TIMEOUT_MS,
    );
    const take = (chunk: Buffer) => { if (out.length < MAX_OUTPUT_BYTES) out += chunk.toString('utf8'); };
    child.stdout.on('data', take);
    child.stderr.on('data', (chunk: Buffer) => { take(chunk); if (err.length < 4096) err += chunk.toString('utf8'); });
    child.on('error', (e) => settle(null, `${bin} could not be started: ${e instanceof Error ? e.message : String(e)}`));
    child.on('close', (code) => {
      const said = err.split('\n').map((line) => line.trim()).find((line) => line.length > 0);
      // A non-zero exit with nothing on stdout answered nothing. A non-zero
      // exit that still printed the reply is left to the parser, which is
      // stricter than an exit code.
      const bad = code !== 0 && !out.trim();
      settle(code, bad
        ? `${bin} exited with code ${code}${said ? `: ${said.slice(0, 200)}` : '.'}`
        : null);
    });
  });
}

/** Read one account's limits, using a cached reading when it is still fresh. */
export async function limitsFor(account: AgentAccount, force = false): Promise<AccountLimits> {
  const base: AccountLimits = {
    accountId: account.id, accountLabel: account.label, harness: account.harness,
    identity: null, state: 'ok', detail: null, fetchedAt: null, plan: null, windows: [], factors: [],
  };
  if (account.harness !== 'claude-code') {
    return { ...base, state: 'unsupported', detail: 'Wanigan has no limits reader for this harness.' };
  }
  if (!account.present) {
    return { ...base, state: 'unreadable', detail: 'This account’s configuration directory is missing.' };
  }
  const hit = cache.get(account.id);
  if (!force && hit && Date.now() - hit.at < STALE_AFTER_MS) return hit.value;

  // Identity first, and it decides the signed-out case. A directory that is not
  // signed in returns a usage reply with no windows in it — indistinguishable,
  // from the text alone, from a reply whose format changed. Asking who is
  // signed in tells those two apart, so a work account waiting for /login is
  // never reported as a parser failure.
  const auth = await runAuthStatus(account);
  // A reading that answered is presentable for STALE_AFTER_MS. One that did not
  // is held only long enough to keep a burst of reads from spawning a burst of
  // probes: cache a "not signed in" for ten minutes and the operator who
  // follows its own instruction and runs /login is told they are still signed
  // out for ten more.
  const remember = (value: AccountLimits) => {
    const at = value.state === 'ok' ? Date.now() : Date.now() - (STALE_AFTER_MS - FAILURE_CACHE_MS);
    cache.set(account.id, { at, value });
    return value;
  };
  if (auth.failure) {
    return remember({ ...base, state: 'unreadable', fetchedAt: Date.now(),
      detail: `${auth.failure} Press Refresh limits to try again.` });
  }
  const identity = auth.identity;
  if (!identity) {
    return remember({ ...base, state: 'signed-out', fetchedAt: Date.now(),
      detail: 'Not signed in. Start a session on this account, run /login once, then press Refresh limits.' });
  }

  const probe = await runProbe(account);
  if (probe.failure) {
    return remember({ ...base, identity, state: 'unreadable', fetchedAt: Date.now(),
      detail: `${probe.failure} Press Refresh limits to try again.` });
  }
  const text = probe.text;
  if (SIGNED_OUT.test(text)) {
    return remember({ ...base, identity, state: 'signed-out', fetchedAt: Date.now(),
      detail: 'The stored sign-in was rejected. Start a session on this account, run /login again, then press Refresh limits.' });
  }
  const parsed = parseUsage(text);
  if (!parsed.windows.length) {
    // Loudly, on purpose. A changed output format must not be reported as
    // "0% used"; an unreadable answer is the honest one.
    return remember({ ...base, identity, state: 'unreadable', fetchedAt: Date.now(),
      detail: 'Wanigan could not read a limit window out of the agent’s reply. The output format may have changed.' });
  }
  // The agent's own word for the tier beats the phrase in the usage preamble:
  // "max" is a plan, "subscription" is a category.
  return remember({ ...base, identity, state: 'ok', fetchedAt: Date.now(),
    plan: identity.plan ?? parsed.plan, windows: parsed.windows, factors: parsed.factors });
}

/** Every Claude account, probed in parallel. */
export async function allLimits(force = false, rows?: AgentAccount[]): Promise<AccountLimits[]> {
  // The caller may hand in the accounts it decided to read. limits.ts does,
  // because `accounts.list` seeds a row for an agent that may not be installed
  // and deciding that is its job, not this reader's.
  const list = rows ?? accounts.list('claude-code');
  return await Promise.all(list.map((account) => limitsFor(account, force)));
}

export const __test = { parseUsage, parseResetAt };
