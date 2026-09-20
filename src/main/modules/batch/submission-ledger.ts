import type Database from 'better-sqlite3';
import { db } from '../../db';
import { accountForPaidOperation } from '../usage-paid-operations';

/**
 * A batch submission is answered long before anything is metered: the answer
 * carries a batch id, and the meters arrive with the results, possibly after a
 * restart. So its paid receipt is accounted for in two steps, each an insert
 * and neither an update. The submission's request id is kept when the batch is
 * created. When the results are ingested, what that ingestion metered is
 * snapshotted once, and that snapshot is the owner evidence. A snapshot rather
 * than a sum over `requests`, because a later retry or rescue merge moves
 * request rows between batches and would change a sum that was true when taken.
 */
export function migrateBatchSubmissionLedger(d: Database.Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS batch_submissions (
      batch_id TEXT PRIMARY KEY, at INTEGER NOT NULL, request_id TEXT
    );
    CREATE TABLE IF NOT EXISTS batch_ingestions (
      batch_id TEXT PRIMARY KEY, at INTEGER NOT NULL, results INTEGER NOT NULL,
      input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER NOT NULL, cache_creation_tokens INTEGER NOT NULL
    );
  `);
}

/** Never throws: the batch already exists at the provider, and failing the
 * submission here would orphan it. Without this row the receipt stays unresolved. */
export function recordBatchSubmission(batchId: string, requestId: string | null | undefined, d: Database.Database = db()): void {
  try {
    d.prepare('INSERT OR IGNORE INTO batch_submissions(batch_id,at,request_id) VALUES (?,?,?)')
      .run(batchId, Date.now(), typeof requestId === 'string' && requestId ? requestId : null);
  } catch (error) {
    console.warn('[wanigan] batch submission not recorded; its receipt stays unresolved:', error instanceof Error ? error.message : error);
  }
}

/** Call after results_ingested_at is stamped by a real download. The first
 * snapshot wins; a repeated ingestion does not rewrite what was accounted. */
export function recordBatchIngestion(batchId: string, results: number, d: Database.Database = db()): boolean {
  try {
    const sums = d.prepare(`SELECT COALESCE(SUM(in_tokens),0) AS i, COALESCE(SUM(out_tokens),0) AS o,
      COALESCE(SUM(cache_read),0) AS r, COALESCE(SUM(cache_write),0) AS w FROM requests WHERE batch_id=?`).get(batchId) as { i: number; o: number; r: number; w: number };
    d.prepare(`INSERT OR IGNORE INTO batch_ingestions(batch_id,at,results,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens)
      VALUES (?,?,?,?,?,?,?)`).run(batchId, Date.now(), results, sums.i, sums.o, sums.r, sums.w);
    const submission = d.prepare('SELECT request_id FROM batch_submissions WHERE batch_id=?').get(batchId) as { request_id: string | null } | undefined;
    if (!submission?.request_id) return false;
    return accountForPaidOperation({ requestId: submission.request_id, outcome: 'metered', ownerTable: 'batch_ingestions', ownerId: batchId }, d);
  } catch (error) {
    console.warn('[wanigan] batch ingestion not recorded; its receipt stays unresolved:', error instanceof Error ? error.message : error);
    return false;
  }
}
