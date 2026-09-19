import type Database from 'better-sqlite3';
import { db } from './db';
import type { ConsumptionPoint, ModelConsumption } from '../shared/types';

/** One row per successful HTTP call, never one per question or relay stage. */
export function migrateSuggestUsage(d: Database.Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS suggest_usage (
      id INTEGER PRIMARY KEY,
      at INTEGER NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER,
      output_tokens INTEGER,
      estimated_cost_usd REAL
    );
    CREATE INDEX IF NOT EXISTS idx_suggest_usage_at ON suggest_usage(at);
  `);
}

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

/** Only bounded model identity and metering survive; no request or response content. */
export function recordSuggestUsage(input: {
  at: number; requestedModel: string; body: unknown; inputPerMTok: number;
}): { inputTokens: number | null; outputTokens: number | null } {
  const body = object(input.body);
  const usage = object(body?.usage);
  const inputTokens = count(usage?.input_tokens);
  const outputTokens = count(usage?.output_tokens);
  const reportedModel = body?.model;
  const model = typeof reportedModel === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(reportedModel)
    ? reportedModel : input.requestedModel;
  // Freeze the arithmetic when the call is made. Editing the current rate must
  // never rewrite old estimates, and an absent meter must never look free.
  const estimatedCost = inputTokens === null ? null : (inputTokens / 1_000_000) * input.inputPerMTok;
  db().prepare(`INSERT INTO suggest_usage (at,model,input_tokens,output_tokens,estimated_cost_usd)
    VALUES (?,?,?,?,?)`).run(input.at, model, inputTokens, outputTokens, estimatedCost);
  return { inputTokens, outputTokens };
}

export function suggestConsumption(since: number): ModelConsumption[] {
  const rows = db().prepare(`
    SELECT model, COUNT(*) AS requests, SUM(input_tokens) AS input_tokens,
           SUM(output_tokens) AS output_tokens, SUM(estimated_cost_usd) AS estimated_cost_usd,
           SUM(CASE WHEN input_tokens IS NULL OR output_tokens IS NULL THEN 1 ELSE 0 END) AS unmetered
    FROM suggest_usage WHERE at >= ? GROUP BY model
  `).all(since) as {
    model: string; requests: number; input_tokens: number | null; output_tokens: number | null;
    estimated_cost_usd: number | null; unmetered: number;
  }[];
  return rows.map((row) => ({
    accountId: null,
    accountLabel: 'TypeSafe',
    harness: null,
    source: 'service',
    model: row.model,
    requests: row.requests,
    inTokens: row.input_tokens ?? 0,
    outTokens: row.output_tokens ?? 0,
    cacheRead: 0,
    costUsd: 0,
    costStatus: 'unreported',
    ...(row.estimated_cost_usd === null ? {} : { estimatedCostUsd: row.estimated_cost_usd }),
    unmeteredRequests: row.unmetered,
  }));
}

export function suggestDaily(since: number): ConsumptionPoint[] {
  const rows = db().prepare(`
    SELECT date(at/1000, 'unixepoch', 'localtime') AS day, model,
           SUM(COALESCE(input_tokens,0) + COALESCE(output_tokens,0)) AS tokens
    FROM suggest_usage WHERE at >= ? AND (input_tokens IS NOT NULL OR output_tokens IS NOT NULL)
    GROUP BY day, model ORDER BY day
  `).all(since) as { day: string; model: string; tokens: number }[];
  return rows.map((row) => ({
    day: row.day,
    accountId: null,
    accountLabel: 'TypeSafe',
    harness: null,
    source: 'service',
    model: row.model,
    tokens: row.tokens,
    costUsd: 0,
  }));
}
