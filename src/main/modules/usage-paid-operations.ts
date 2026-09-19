import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { db } from '../db';
import { assertStorageAdmission } from '../storage-maintenance';

/** Transports with no owner ledger of their own that precedes the send. The
 * label is the whole record: no prompt, body, URL, credential or argv. */
export type PaidOperationSource = 'anthropic:messages' | 'anthropic:batches' | 'learning:cli';

/** A prospective receipt, written before the request can exist. Nothing here
 * settles it: a finished fetch or an exited child says the call returned, not
 * what it cost, and the ledgers that do record cost belong to other modules
 * and cover only some callers. So a receipt stays unresolved, and any recorded
 * paid operation refuses a later restore. That is the stated price of having
 * no settlement contract yet, not an oversight to clear on completion. */
export function migrateUsagePaidOperations(d: Database.Database): void {
  d.exec(`CREATE TABLE IF NOT EXISTS usage_paid_operations (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    at INTEGER NOT NULL
  )`);
}

/** Synchronous on purpose: call it immediately before the send or spawn, after
 * every await, so a maintenance hold that appeared meanwhile is seen. A failed
 * write throws and the request is never made. */
export function admitPaidOperation(source: PaidOperationSource, d: Database.Database = db()): string {
  assertStorageAdmission({ paid: true });
  const id = randomUUID();
  d.prepare('INSERT INTO usage_paid_operations(id,source,at) VALUES (?,?,?)').run(id, source, Date.now());
  return id;
}

/** The SDK calls its fetch once per actual attempt, so its own retries are
 * re-admitted and each leaves a receipt. Reads, polls, cancels and token
 * counting are not billable submissions and pass through unrecorded. */
export function paidOperationSource(method: string, pathname: string): PaidOperationSource | null {
  if (method.toUpperCase() !== 'POST') return null;
  const route = pathname.replace(/\/+$/, '');
  if (route.endsWith('/v1/messages')) return 'anthropic:messages';
  if (route.endsWith('/v1/messages/batches')) return 'anthropic:batches';
  return null;
}

type Fetch = typeof globalThis.fetch;
export function admittedFetch(send: Fetch = globalThis.fetch, admit: (source: PaidOperationSource) => unknown = admitPaidOperation): Fetch {
  return (input, init) => {
    const request = typeof input === 'string' || input instanceof URL ? null : input;
    const source = paidOperationSource(init?.method ?? request?.method ?? 'GET', new URL(request ? request.url : String(input)).pathname);
    if (source) admit(source);
    return send(input, init);
  };
}
