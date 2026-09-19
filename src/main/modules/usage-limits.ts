import * as accounts from '../accounts';
import { detectProviders } from '../providers';
import { allLimits as claudeLimits } from './usage-claude-limits';
import { readCodexStatus, type CodexLimitWindow, type CodexStatus } from './usage-codex-status';
import { codexWindowStale } from '../../shared/codex-account';
import type { AccountLimits, AgentAccount, LimitWindow } from '../../shared/types';
import { withUsageIdentityEvidence } from './usage-account-identity';

/**
 * What is left, for every account on this machine, whatever agent it belongs to.
 *
 * The Usage screen said "Limits are read live from each account" and read only
 * the Claude ones. A Codex account added in Settings simply did not appear:
 * `AccountLimits` already carried a `harness` field, `codex-status.ts` already
 * read Codex's rolling windows per account, and nothing joined the two — so a
 * page whose whole subject is "what is left" was silently answering for one
 * provider out of however many are signed in.
 *
 * Routing is by declared harness, per CLAUDE.md, not by a profile id that
 * happens to be spelled 'codex': a pack may ship a second Codex-harness profile
 * with a different login, and it reads through the same app-server.
 *
 * A harness with no reader is reported as such. That is the honest answer and
 * it is visible: an account that Wanigan cannot ask should say so on the page
 * rather than be quietly left off it, because "not shown" and "nothing left"
 * look identical to someone deciding where to run the next agent.
 */

/** Harnesses this build can ask. Anything else gets a stated 'unsupported'. */
const READABLE = new Set(['claude-code', 'codex']);

/**
 * Codex names its windows by duration, not by word. Claude says "session" and
 * "week"; Codex hands back a minute count. Where the two mean the same span,
 * use the same word so one page does not call one span two things — and where
 * they do not, print the duration Codex actually reported rather than inventing
 * a category for it.
 */
function windowKind(minutes: number | null): string {
  if (minutes === null) return 'limit window';
  if (minutes === 10_080) return 'week';
  if (minutes === 1_440) return 'day';
  if (minutes % 1_440 === 0) return `${minutes / 1_440}d window`;
  if (minutes % 60 === 0) return `${minutes / 60}h window`;
  return `${minutes}m window`;
}

function codexWindow(window: CodexLimitWindow | null, bucket?: { label: string | null; model: string | null }): LimitWindow | null {
  if (!window) return null;
  return {
    // A further bucket is printed under the name the backend gave it. That name
    // is a label, never a model: only `normalModelSlug` is a provider-stated
    // link to one, and it alone becomes the scope.
    kind: bucket?.label ? `${bucket.label} · ${windowKind(window.windowMinutes)}` : windowKind(window.windowMinutes),
    scope: bucket?.model ?? null,
    usedPercent: Math.max(0, Math.min(100, window.usedPercent)),
    // Codex gives an epoch and no words, so there is nothing verbatim to keep.
    // The renderer prints the countdown it can compute and nothing else.
    resetsAtText: null,
    resetsAt: window.resetsAt,
  };
}

function fromCodexStatus(account: AgentAccount, status: CodexStatus, now = Date.now()): AccountLimits {
  const same = (a: CodexLimitWindow | null, b: CodexLimitWindow | null) => JSON.stringify(a) === JSON.stringify(b);
  // The single view mirrors one of the buckets. Print that one once, unlabelled,
  // and every other bucket as reported, so nothing the backend named is dropped.
  const further = (status.buckets ?? []).filter((row) => !(same(row.primary, status.primary) && same(row.secondary, status.secondary)));
  const reported = [status.primary, status.secondary, ...further.flatMap((row) => [row.primary, row.secondary])];
  const windows = [
    codexWindow(status.primary), codexWindow(status.secondary),
    ...further.flatMap((row) => {
      const bucket = { label: row.limitName ?? row.limitId, model: row.normalModelSlug };
      return [codexWindow(row.primary, bucket), codexWindow(row.secondary, bucket)];
    }),
  ].filter((w): w is LimitWindow => w !== null);
  const base = {
    accountId: account.id, accountLabel: account.label, harness: account.harness,
    identity: status.identity ?? null, plan: status.plan ?? status.identity?.plan ?? null, factors: [],
  };
  if (status.authState === 'signed-out') return {
    ...base, state: 'signed-out', fetchedAt: status.fetchedAt, windows: [],
    detail: status.requiresOpenaiAuth === false
      ? 'Codex reports no OpenAI account, and that this configuration does not require one. There is no ChatGPT allowance to read.'
      : 'Codex reports no signed-in account. Start a session on this account and run codex login, then refresh limits.',
  };
  if (status.quotaApplicable === false) return {
    ...base, state: 'unsupported', fetchedAt: status.fetchedAt, windows: [],
    detail: 'This Codex account signs in with an API key, which has no ChatGPT allowance to report. That is not a reading of zero.',
  };
  if (windows.length === 0) {
    return {
      ...base, state: 'unreadable' as const, fetchedAt: status.fetchedAt, windows: [],
      detail: 'Codex answered but reported no limit windows. That is what its app-server returned, not a reading of zero.',
    };
  }
  const detail = [
    // The backend's own verdict outranks every percentage on the row.
    status.ordinaryUsageAllowed === false ? 'Codex reports that ordinary included usage is not currently allowed for this account.' : null,
    // A spend control is a different fact from a full window, and it is the one
    // that explains why a run was refused while the percentages still look fine.
    status.spendControlReached === true ? 'Codex reports a spend control has been reached for this account.' : null,
    reported.some((window) => codexWindowStale(window, now))
      ? 'A reported reset time has passed, so this reading is out of date. A passed reset does not show the allowance recovered; refresh limits.' : null,
    status.loginWitnessed === false
      ? 'This account keeps its credentials outside auth.json, so Wanigan cannot see a login change from files and re-reads it every time.' : null,
  ].filter(Boolean).join(' ');
  return { ...base, state: 'ok' as const, fetchedAt: status.fetchedAt, windows, detail: detail || null };
}

async function codexLimitsFor(account: AgentAccount, force: boolean): Promise<AccountLimits> {
  const base = {
    accountId: account.id, accountLabel: account.label, harness: account.harness,
    identity: null, plan: null, windows: [], factors: [],
  };
  try {
    return fromCodexStatus(account, await readCodexStatus(force, account.id));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // "No Codex-harness provider is installed" is not a failure to read; it is
    // an accurate statement that there is nothing here to ask.
    const missing = /no codex-harness provider is installed/i.test(detail);
    return {
      ...base,
      state: missing ? ('unsupported' as const) : ('unreadable' as const),
      fetchedAt: null,
      detail,
    };
  }
}

function unsupported(account: AgentAccount): AccountLimits {
  return {
    accountId: account.id, accountLabel: account.label, harness: account.harness,
    identity: null, state: 'unsupported', fetchedAt: null, plan: null, windows: [], factors: [],
    detail: `Wanigan has no way to ask a ${account.harness} account what it has left. `
      + 'Its consumption below is still recorded from the sessions Wanigan started.',
  };
}

/**
 * Every account, probed in parallel, in a stable order: Claude first because it
 * is the harness most installs have, then the rest grouped by harness so two
 * logins for one agent sit together.
 */
export async function allAccountLimits(force = false): Promise<AccountLimits[]> {
  // `accounts.list(harness)` seeds a 'Personal' row for any harness that
  // supports accounts, whether or not that agent is installed. Reading it here
  // for every readable harness wrote a durable row for an agent the operator
  // has never had and then drew a card explaining that Wanigan cannot read it.
  // So: seed only what is installed, and show already-created rows for the
  // rest — an account someone made and later uninstalled the CLI for is a fact,
  // an account nobody made is not.
  const installed = new Set(
    (await detectProviders()).filter((p) => p.path).map((p) => p.harnessId),
  );
  const forHarness = (harness: string): AgentAccount[] => (
    installed.has(harness)
      ? accounts.list(harness)
      : accounts.listAll().filter((a) => a.harness === harness)
  );

  const claudeAccounts = forHarness('claude-code');
  const codexAccounts = forHarness('codex');
  const others = accounts.listAll().filter((a) => !READABLE.has(a.harness));
  const [claudeRows, codexRows] = await Promise.all([
    claudeLimits(force, claudeAccounts),
    Promise.all(codexAccounts.map((account) => codexLimitsFor(account, force))),
  ]);
  return withUsageIdentityEvidence(
    [...claudeRows, ...codexRows, ...others.map(unsupported)],
    [...claudeAccounts, ...codexAccounts, ...others],
  );
}

export const __test = { windowKind, codexWindow, fromCodexStatus };
