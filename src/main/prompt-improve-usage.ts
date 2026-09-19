import type Database from 'better-sqlite3';
import { db } from './db';
import { isPricedModel, syncCostOf } from './modules/batch/pricing';
import type { ConsumptionPoint, ModelConsumption } from '../shared/types';
import type { PromptImproveResult } from '../shared/prompt-improve';

/** A pending row precedes every request. Drafts, replies and provider errors are never stored. */
export function migratePromptImproveUsage(d: Database.Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS prompt_improve_usage (
      request_id TEXT PRIMARY KEY,
      at INTEGER NOT NULL,
      requested_model TEXT NOT NULL,
      model TEXT,
      status TEXT NOT NULL,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_read_tokens INTEGER,
      estimated_cost_usd REAL
    );
    CREATE INDEX IF NOT EXISTS idx_prompt_improve_usage_at ON prompt_improve_usage(at);
  `);
}

type Meters = Pick<PromptImproveResult, 'model' | 'inputTokens' | 'outputTokens' | 'estimatedCostUsd'>;
const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

/** Meter before parsing, including cancelled and malformed replies. Unknown is never zero spend. */
export function recordPromptImproveMeters(d: Database.Database, requestId: string, at: number, result: {
  model: unknown; input: unknown; output: unknown; cacheRead?: unknown; cacheCreation?: unknown;
}): Meters {
  const model = typeof result.model === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(result.model)
    ? result.model : null;
  const inputTokens = count(result.input);
  const outputTokens = count(result.output);
  const cacheRead = result.cacheRead === undefined ? 0 : count(result.cacheRead);
  const cacheCreation = result.cacheCreation === undefined ? 0 : count(result.cacheCreation);
  const estimatedCostUsd = model && isPricedModel(model, at) && inputTokens !== null && outputTokens !== null
    && cacheRead !== null && cacheCreation !== null
    ? syncCostOf(model, { input_tokens: inputTokens, output_tokens: outputTokens,
      cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheCreation }, at) : null;
  d.prepare(`UPDATE prompt_improve_usage SET model=?, input_tokens=?, output_tokens=?,
    cache_read_tokens=?, estimated_cost_usd=? WHERE request_id=?`)
    .run(model, inputTokens, outputTokens, cacheRead, estimatedCostUsd, requestId);
  return { model: model ?? 'unknown', inputTokens, outputTokens, estimatedCostUsd };
}

export function promptImproveConsumption(since: number, d: Database.Database = db()): ModelConsumption[] {
  const rows = d.prepare(`
    SELECT COALESCE(model, requested_model) AS model, COUNT(*) AS requests,
      SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
      SUM(cache_read_tokens) AS cache_read_tokens, SUM(estimated_cost_usd) AS estimated_cost_usd,
      SUM(CASE WHEN input_tokens IS NULL OR output_tokens IS NULL THEN 1 ELSE 0 END) AS unmetered
    FROM prompt_improve_usage WHERE at >= ? GROUP BY COALESCE(model, requested_model)
  `).all(since) as {
    model: string; requests: number; input_tokens: number | null; output_tokens: number | null;
    cache_read_tokens: number | null; estimated_cost_usd: number | null; unmetered: number;
  }[];
  return rows.map(row => ({
    accountId: null, accountLabel: 'Claude Platform · Improve prompt', harness: null, source: 'service',
    model: row.model, requests: row.requests, inTokens: row.input_tokens ?? 0, outTokens: row.output_tokens ?? 0,
    cacheRead: row.cache_read_tokens ?? 0, costUsd: 0, costStatus: 'unreported',
    ...(row.estimated_cost_usd === null ? {} : { estimatedCostUsd: row.estimated_cost_usd }),
    unmeteredRequests: row.unmetered,
  }));
}

export function promptImproveDaily(since: number, d: Database.Database = db()): ConsumptionPoint[] {
  const rows = d.prepare(`
    SELECT date(at/1000, 'unixepoch', 'localtime') AS day, COALESCE(model, requested_model) AS model,
      SUM(COALESCE(input_tokens,0) + COALESCE(output_tokens,0) + COALESCE(cache_read_tokens,0)) AS tokens
    FROM prompt_improve_usage WHERE at >= ? AND (input_tokens IS NOT NULL OR output_tokens IS NOT NULL)
    GROUP BY day, COALESCE(model, requested_model) ORDER BY day
  `).all(since) as { day: string; model: string; tokens: number }[];
  return rows.map(row => ({
    day: row.day, accountId: null, accountLabel: 'Claude Platform · Improve prompt', harness: null,
    source: 'service', model: row.model, tokens: row.tokens, costUsd: 0,
  }));
}
