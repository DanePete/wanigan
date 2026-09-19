import type Database from 'better-sqlite3';
import { db } from '../db';
import { isPricedModel, syncCostOf } from '../batch/pricing';
import type { ConsumptionPoint, ModelConsumption } from '../../shared/types';

/** What the Usage screen shows for `usage_direct_requests`. The ledger stores
 * no price, so the estimate is worked out here from the recorded tokens at the
 * rate in force when each request was made, and is labelled an estimate. An
 * unpriced model contributes tokens and no figure. Local reads only. An
 * interview's own running total prices the same tokens at the same rates. */
const LABELS: Record<string, string> = { 'batch:dry-run': 'Claude Platform · Dry run', interview: 'Claude Platform · Interview' };
// A source this build does not name is still shown, under its own label, rather than dropped or folded into another.
const labelOf = (source: string) => LABELS[source] ?? `Claude Platform · ${source.slice(0, 40)}`;
type Row = { at: number; source: string; model: string; input_tokens: number; output_tokens: number };

function rows(since: number, d: Database.Database): Row[] {
  return d.prepare('SELECT at,source,model,input_tokens,output_tokens FROM usage_direct_requests WHERE at >= ? ORDER BY at').all(since) as Row[];
}

export function directRequestConsumption(since: number, d: Database.Database = db()): ModelConsumption[] {
  const byModel = new Map<string, { source: string; model: string; requests: number; inTokens: number; outTokens: number; estimate: number | null }>();
  for (const row of rows(since, d)) {
    const key = `${row.source}\n${row.model}`;
    const total = byModel.get(key) ?? { source: row.source, model: row.model, requests: 0, inTokens: 0, outTokens: 0, estimate: 0 };
    total.requests += 1; total.inTokens += row.input_tokens; total.outTokens += row.output_tokens;
    // One unpriced request makes the model's total unknown, not smaller.
    total.estimate = total.estimate === null || !isPricedModel(row.model, row.at) ? null
      : total.estimate + syncCostOf(row.model, { input_tokens: row.input_tokens, output_tokens: row.output_tokens }, row.at);
    byModel.set(key, total);
  }
  return [...byModel.values()].map((total) => ({
    accountId: null, accountLabel: labelOf(total.source), harness: null, source: 'service' as const, model: total.model,
    requests: total.requests, inTokens: total.inTokens, outTokens: total.outTokens, cacheRead: 0,
    costUsd: 0, costStatus: 'unreported' as const, ...(total.estimate === null ? {} : { estimatedCostUsd: total.estimate }),
    unmeteredRequests: 0,
  }));
}

export function directRequestDaily(since: number, d: Database.Database = db()): ConsumptionPoint[] {
  return (d.prepare(`SELECT date(at/1000,'unixepoch','localtime') AS day, source, model, SUM(input_tokens + output_tokens) AS tokens
    FROM usage_direct_requests WHERE at >= ? GROUP BY day, source, model ORDER BY day`).all(since) as { day: string; source: string; model: string; tokens: number }[])
    .map(row => ({ day: row.day, accountId: null, accountLabel: labelOf(row.source), harness: null, source: 'service' as const, model: row.model, tokens: row.tokens, costUsd: 0 }));
}
