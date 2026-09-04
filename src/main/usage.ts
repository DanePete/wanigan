import { db } from './db';
import * as accounts from './accounts';
import { allLimits } from './claude-limits';
import type { ConsumptionPoint, ModelConsumption, UsageSnapshot } from '../shared/types';

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
    accountLabel: labelFor(row.account_id),
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
export async function snapshot(input?: { days?: number; force?: boolean }): Promise<UsageSnapshot> {
  const days = clampDays(input?.days);
  const limits = await allLimits(input?.force === true);
  return { limits, consumption: consumption(days), daily: daily(days), days };
}
