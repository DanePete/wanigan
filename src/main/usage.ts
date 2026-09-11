import { db } from './db';
import * as accounts from './accounts';
import { allAccountLimits } from './limits';
import { burnRate as claudeBurnRate, type BurnRate as ClaudeBurnRate } from './claude-usage';
import type { AccountLimits, ConsumptionPoint, ModelConsumption, UsageSnapshot } from '../shared/types';

/**
 * What was actually spent, per account and model.
 *
 * This is Wanigan's own record — the API events it already collects, joined to
 * the account each session launched under — so it needs no probe and is exact
 * about what happened. It is deliberately kept apart from the limit windows in
 * claude-limits.ts, because spent and remaining are different facts and neither
 * can be derived from the other: compaction and cached input mean a token
 * counter cannot tell you what a plan has left.
 */

const MAX_DAYS = 90;
const DEFAULT_DAYS = 14;

const clampDays = (raw: number | undefined) => {
  const value = Math.round(Number(raw ?? DEFAULT_DAYS));
  return Number.isFinite(value) ? Math.max(1, Math.min(MAX_DAYS, value)) : DEFAULT_DAYS;
};

/** A session with no recorded account predates accounts, or ran on a profile that has none. */
const labelFor = (accountId: string | null): string =>
  accountId ? accounts.byId(accountId)?.label ?? 'Removed account' : 'No account';

/**
 * Which agent an account signs into.
 *
 * Carried beside the label because the label is not unique: `accounts.seed`
 * names the first account of every harness 'Personal', so a machine with both
 * Claude Code and Codex has two accounts called 'Personal' by default. Null for
 * a session that predates accounts or a removed row — unknown, not a harness.
 */
const harnessFor = (accountId: string | null): string | null =>
  accountId ? accounts.byId(accountId)?.harness ?? null : null;

type Row = {
  account_id: string | null; model_name: string | null; requests: number;
  in_tokens: number; out_tokens: number; cache_read: number;
  cost_usd: number; priced: number;
};

export function consumption(days = DEFAULT_DAYS): ModelConsumption[] {
  const since = Date.now() - clampDays(days) * 86_400_000;
  const rows = db().prepare(`
    SELECT l.account_id AS account_id,
           COALESCE(e.model, 'unnamed model') AS model_name,
           COUNT(*) AS requests,
           SUM(e.in_tokens) AS in_tokens,
           SUM(e.out_tokens) AS out_tokens,
           SUM(e.cache_read) AS cache_read,
           SUM(e.cost_usd) AS cost_usd,
           SUM(CASE WHEN e.cost_usd > 0 THEN 1 ELSE 0 END) AS priced
    FROM session_api_events e
    JOIN session_log l ON l.id = e.session_id
    WHERE e.kind='request' AND e.at >= ?
    GROUP BY l.account_id, model_name
    ORDER BY out_tokens DESC
  `).all(since) as Row[];

  return rows.map((row) => ({
    accountId: row.account_id,
    accountLabel: labelFor(row.account_id),
    harness: harnessFor(row.account_id),
    model: row.model_name ?? 'unnamed model',
    requests: row.requests,
    inTokens: row.in_tokens ?? 0,
    outTokens: row.out_tokens ?? 0,
    cacheRead: row.cache_read ?? 0,
    costUsd: row.cost_usd ?? 0,
    // A provider that reports no cost is not free, and a total that silently
    // treats it as zero is a number pretending to be a bill.
    costStatus: row.priced === row.requests ? 'reported' : row.priced === 0 ? 'unreported' : 'partial',
  }));
}

export function daily(days = DEFAULT_DAYS): ConsumptionPoint[] {
  const window = clampDays(days);
  const since = Date.now() - window * 86_400_000;
  const rows = db().prepare(`
    SELECT date(e.at/1000, 'unixepoch', 'localtime') AS day,
           l.account_id AS account_id,
           COALESCE(e.model, 'unnamed model') AS model_name,
           SUM(e.in_tokens + e.out_tokens) AS tokens,
           SUM(e.cost_usd) AS cost_usd
    FROM session_api_events e
    JOIN session_log l ON l.id = e.session_id
    WHERE e.kind='request' AND e.at >= ?
    GROUP BY day, l.account_id, model_name
    ORDER BY day
  `).all(since) as { day: string; account_id: string | null; model_name: string; tokens: number; cost_usd: number }[];

  return rows.map((row) => ({
    day: row.day,
    accountId: row.account_id,
    accountLabel: labelFor(row.account_id),
    harness: harnessFor(row.account_id),
    model: row.model_name,
    tokens: row.tokens ?? 0,
    costUsd: row.cost_usd ?? 0,
  }));
}

/**
 * The whole screen in one read.
 *
 * `force` re-probes the providers; without it a reading younger than the
 * staleness bound is reused, because each probe starts a real CLI process.
 */
/**
 * The last limits a real read produced, for surfaces that must not cause one.
 *
 * `allAccountLimits` consults a 45-second cache and asks the agent when it is
 * cold, so anything on a poll would spend a probe every time — and "opening and
 * polling Mission Room never starts an account usage probe" is a rule this
 * suite already pins. A companion that wants to say something about usage may
 * therefore only repeat what somebody's own visit to Usage, or a deliberate
 * refresh, already established.
 *
 * Empty until that has happened, which is the honest state: Wanigan has not
 * asked, so it does not know, so it says nothing.
 */
let lastLimits: { at: number; limits: AccountLimits[] } | null = null;

export function knownLimits(): { at: number; limits: AccountLimits[] } | null {
  return lastLimits;
}

export async function snapshot(input?: { days?: number; force?: boolean }): Promise<UsageSnapshot> {
  const days = clampDays(input?.days);
  const limits = await allAccountLimits(input?.force === true);
  lastLimits = { at: Date.now(), limits };
  return { limits, consumption: consumption(days), daily: daily(days), days };
}

/* ── burn rate ────────────────────────────────────────────────────────── */

/**
 * How fast the current limit window is being spent, and where it lands.
 *
 * The window itself is never inferred. ccusage, which is where this idea comes
 * from, reconstructs a five-hour block by taking the first message it can find
 * and adding five hours; claude-limits.ts instead asks the account and is told
 * both the percentage used and the instant it resets, so the window here is the
 * provider's own and the start is derived backwards from its reset. Inferring
 * it would reintroduce exactly the guess that file exists to avoid.
 *
 * The rate is a TOKEN rate, from the transcripts. Two reasons it is not
 * dollars: the plan meters tokens, not money, so a dollar figure would be
 * answering a different question from the one the percentage answers; and the
 * transcripts carry no cost of their own, so any dollar rate would be Wanigan's
 * arithmetic wearing the provider's authority.
 *
 * `spansMultipleAccounts` is the caveat that makes the pair readable. The
 * percentage belongs to one account; the transcripts on this machine belong to
 * every account signed in on it. With two accounts the rate can legitimately
 * outrun the percentage, and a surface that did not say so would look broken.
 */
export type BurnWindow = {
  /** The provider's own name for the window — 'session', 'week'. */
  kind: string;
  /** null for an all-models window; a model name otherwise. */
  scope: string | null;
  accountLabel: string;
  usedPercent: number;
  resetsAtText: string | null;
  resetsAt: number;
  windowStartMs: number;
  burn: ClaudeBurnRate;
  spansMultipleAccounts: boolean;
};

/**
 * How long each window the provider names actually is.
 *
 * Only what Claude has been observed to report. An unrecognised kind gets no
 * entry and is skipped rather than guessed at: a burn rate over a window of the
 * wrong length is a wrong number that looks entirely plausible.
 */
const WINDOW_MS: Record<string, number> = {
  session: 5 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
};

/**
 * Every window with a known length, a known reset and something to measure.
 *
 * Empty is a normal answer, not a failure: an account that has not been probed,
 * a probe that could not read the reply, and a machine with no Claude account
 * all land here, and the surface says the window is unavailable rather than
 * drawing a zero.
 */
export async function burnWindows(force = false): Promise<BurnWindow[]> {
  const limits = await allAccountLimits(force);
  // Claude only: the transcripts this rate is measured from are Claude Code's,
  // and pairing them with another harness's window would be two unrelated
  // numbers sharing a card.
  const claudeAccounts = limits.filter((l) => l.harness === 'claude-code' && l.windows.length > 0);
  const spans = claudeAccounts.length > 1;

  const out: BurnWindow[] = [];
  for (const account of claudeAccounts) {
    for (const window of account.windows) {
      const length = WINDOW_MS[window.kind.toLowerCase()];
      if (!length || window.resetsAt === null) continue;
      const startMs = window.resetsAt - length;
      out.push({
        kind: window.kind,
        scope: window.scope,
        accountLabel: account.accountLabel,
        usedPercent: window.usedPercent,
        resetsAtText: window.resetsAtText,
        resetsAt: window.resetsAt,
        windowStartMs: startMs,
        burn: claudeBurnRate(startMs, window.resetsAt),
        spansMultipleAccounts: spans,
      });
    }
  }
  // Shortest window first: the five-hour one is the only one a person can still
  // do something about, and it is what a reader came to this card for.
  return out.sort((a, b) => (WINDOW_MS[a.kind.toLowerCase()] ?? 0) - (WINDOW_MS[b.kind.toLowerCase()] ?? 0));
}
