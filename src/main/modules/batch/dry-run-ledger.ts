import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { db } from '../../db';
import { accountForPaidOperation } from '../usage-paid-operations';
import { isPricedModel, syncCostOf } from './pricing';

/**
 * The dry-run sample is one synchronous Messages request, paid like any other,
 * and it was the one paid path here with no record at all: its answer went to
 * the screen and nowhere else. One row per answered sample, so its receipt has
 * an owner to be accounted for by. The mock path spends nothing and writes none.
 */
export function migrateBatchDryRuns(d: Database.Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS batch_dry_runs (
      id TEXT PRIMARY KEY, at INTEGER NOT NULL, model TEXT NOT NULL,
      input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_creation_tokens INTEGER,
      cost_usd REAL
    );
  `);
}

type Answered = {
  model?: string | null; _request_id?: string | null;
  usage?: { input_tokens?: number | null; output_tokens?: number | null;
    cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null } | null;
};
const meter = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Never throws: a bookkeeping failure must not turn an answered sample into a
 * failed one and invite a second paid request. The receipt stays unresolved. */
export function recordDryRun(message: Answered, requestedModel: string, d: Database.Database = db()): string | null {
  try {
    const usage = message.usage ?? {};
    const metered = meter(usage.input_tokens) && meter(usage.output_tokens);
    // A sample request may carry cache_control, so the cache meters are part of
    // what it cost. The API omits them when caching was not in play: that is zero.
    const cacheRead = usage.cache_read_input_tokens ?? 0, cacheCreation = usage.cache_creation_input_tokens ?? 0;
    const complete = metered && meter(cacheRead) && meter(cacheCreation);
    const model = (typeof message.model === 'string' && message.model ? message.model : requestedModel).slice(0, 200);
    const cost = complete && isPricedModel(model)
      ? syncCostOf(model, { input_tokens: usage.input_tokens!, output_tokens: usage.output_tokens!,
        cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheCreation })
      : null;
    const id = randomUUID();
    d.prepare(`INSERT INTO batch_dry_runs(id,at,model,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens,cost_usd)
      VALUES (?,?,?,?,?,?,?,?)`).run(id, Date.now(), model, complete ? usage.input_tokens : null, complete ? usage.output_tokens : null,
      complete ? cacheRead : null, complete ? cacheCreation : null, cost);
    if (complete && message._request_id) {
      accountForPaidOperation({ requestId: message._request_id, outcome: 'metered', ownerTable: 'batch_dry_runs', ownerId: id }, d);
    }
    return id;
  } catch (error) {
    console.warn('[wanigan] dry-run sample not recorded; its receipt stays unresolved:', error instanceof Error ? error.message : error);
    return null;
  }
}
