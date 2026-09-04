import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { providerById, shellPath } from './providers';
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

type Cached = { at: number; value: AccountLimits };
const cache = new Map<string, Cached>();

/**
 * `Current session: 5% used · resets Sep 4 at 1:29pm (America/Chicago)`
 * `Current week (all models): 79% used · resets Sep 6 at 8:59pm (America/Chicago)`
 * `Current week (Fable): 100% used · resets Sep 6 at 8:59pm (America/Chicago)`
 */
const WINDOW_LINE = /^Current\s+(\w+)(?:\s*\(([^)]+)\))?:\s*(\d+(?:\.\d+)?)%\s+used\s*·\s*resets\s+(.+?)\s*$/;
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
        resetsAtText: windowMatch[4],
        resetsAt: parseResetAt(windowMatch[4], now),
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

function claudeBin(): string | null {
  const def = providerById('claude');
  return def?.bin ?? 'claude';
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
async function runAuthStatus(account: AgentAccount): Promise<AccountIdentity | null> {
  const { text } = await run(account, ['auth', 'status', '--json']);
  // Warnings from the account's own settings file are printed before the JSON,
  // so parse from the first brace rather than the first byte.
  const start = text.indexOf('{');
  if (start < 0) return null;
  try {
    const raw = JSON.parse(text.slice(start)) as Record<string, unknown>;
    if (raw.loggedIn !== true) return null;
    const str = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null);
    return {
      email: str(raw.email), orgName: str(raw.orgName),
      plan: str(raw.subscriptionType), authMethod: str(raw.authMethod),
    };
  } catch { return null; }
}

async function runProbe(account: AgentAccount): Promise<{ text: string; code: number | null }> {
  return await run(account, ['-p', '/usage']);
}

async function run(account: AgentAccount, args: string[]): Promise<{ text: string; code: number | null }> {
  const PATH = await shellPath();
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  env.PATH = PATH;
  // The account decides which login answers, exactly as at launch — including
  // the rule that the default account sets nothing at all.
  const accountEnv = accounts.launchEnv(account);
  if (Object.keys(accountEnv).length === 0) delete env.CLAUDE_CONFIG_DIR;
  Object.assign(env, accountEnv);

  return await new Promise((resolve) => {
    let out = ''; let done = false;
    const child = spawn(claudeBin() ?? 'claude', args, { cwd: neutralCwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
    const finish = (code: number | null) => { if (done) return; done = true; clearTimeout(timer); try { child.kill('SIGKILL'); } catch { /* gone */ } resolve({ text: out, code }); };
    const timer = setTimeout(() => finish(null), TIMEOUT_MS);
    const take = (chunk: Buffer) => { if (out.length < MAX_OUTPUT_BYTES) out += chunk.toString('utf8'); };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code));
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
  const identity = await runAuthStatus(account);
  const remember = (value: AccountLimits) => { cache.set(account.id, { at: Date.now(), value }); return value; };
  if (!identity) {
    return remember({ ...base, state: 'signed-out', fetchedAt: Date.now(),
      detail: 'Not signed in. Start a session on this account and run /login once.' });
  }

  const { text } = await runProbe(account);
  if (SIGNED_OUT.test(text)) {
    return remember({ ...base, identity, state: 'signed-out', fetchedAt: Date.now(),
      detail: 'The stored sign-in was rejected. Start a session on this account and run /login again.' });
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
export async function allLimits(force = false): Promise<AccountLimits[]> {
  const rows = accounts.list('claude-code');
  return await Promise.all(rows.map((account) => limitsFor(account, force)));
}

export const __test = { parseUsage, parseResetAt };
