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

/**
 * What later became known about a receipt. The receipt row is never updated;
 * this sibling row is the only thing that can account for it, and only three
 * outcomes do. Anything else, including no row at all, stays unresolved.
 *
 * - `not-charged-provider-stated`: an HTTP error response that carried the
 *   provider's request id. Anthropic's help centre states failed requests are
 *   not charged; the name records whose statement that is, not an observed zero.
 * - `metered`: the provider answered and the owning ledger recorded its meters.
 * - `reported-estimate`: a CLI reported a cost, which its vendor documents as a
 *   client-side estimate. Accounted for as that, never presented as a bill.
 *
 * `responded` alone accounts for nothing: a 2xx whose stream was cut, or whose
 * caller keeps no ledger, has an answer and no recorded meters. A transport
 * failure or timeout writes no row at all, and the provider states an abandoned
 * request is still charged, so it never ages out.
 */
export type PaidSettlementOutcome = 'responded' | 'not-charged-provider-stated' | 'metered' | 'reported-estimate';

export function migrateUsagePaidSettlements(d: Database.Database): void {
  d.exec(`CREATE TABLE IF NOT EXISTS usage_paid_settlements (
    receipt_id TEXT PRIMARY KEY,
    at INTEGER NOT NULL,
    outcome TEXT NOT NULL,
    http_status INTEGER,
    request_id TEXT,
    owner_table TEXT,
    owner_id TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_usage_paid_settlements_request ON usage_paid_settlements(request_id);`);
}

const REQUEST_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** The response's facts, written once when it arrives. Never throws into the
 * caller: a settlement that cannot be written leaves the receipt unresolved,
 * which is the conservative answer, and the response is still theirs. */
export function recordPaidResponse(receiptId: string, status: number, requestId: string | null, d: Database.Database = db()): void {
  const id = requestId && REQUEST_ID.test(requestId) ? requestId : null;
  const outcome: PaidSettlementOutcome = status >= 400 && id ? 'not-charged-provider-stated' : 'responded';
  try {
    d.prepare('INSERT OR IGNORE INTO usage_paid_settlements(receipt_id,at,outcome,http_status,request_id) VALUES (?,?,?,?,?)')
      .run(receiptId, Date.now(), outcome, status, id);
  } catch (error) {
    console.warn('[wanigan] paid response not recorded; its receipt stays unresolved:', error instanceof Error ? error.message : error);
  }
}

/** The owning ledger saying it recorded this request's meters. Matches by the
 * provider's request id for an SDK call, or by receipt for a spawned CLI, whose
 * receipt has no response row to find. Returns whether a receipt was accounted for. */
export function accountForPaidOperation(input: {
  requestId?: string | null; receiptId?: string | null;
  outcome: 'metered' | 'reported-estimate'; ownerTable: string; ownerId: string;
}, d: Database.Database = db()): boolean {
  try {
    if (input.receiptId) {
      return d.prepare(`INSERT OR IGNORE INTO usage_paid_settlements(receipt_id,at,outcome,owner_table,owner_id)
        SELECT id,?,?,?,? FROM usage_paid_operations WHERE id=?`)
        .run(Date.now(), input.outcome, input.ownerTable, input.ownerId, input.receiptId).changes > 0;
    }
    if (!input.requestId || !REQUEST_ID.test(input.requestId)) return false;
    // Only an answered, successful request: an error response was already
    // accounted for by the provider's statement and is not re-labelled.
    return d.prepare(`UPDATE usage_paid_settlements SET outcome=?, owner_table=?, owner_id=?
      WHERE request_id=? AND outcome='responded' AND http_status BETWEEN 200 AND 299`)
      .run(input.outcome, input.ownerTable, input.ownerId, input.requestId).changes > 0;
  } catch (error) {
    console.warn('[wanigan] paid operation not accounted for; its receipt stays unresolved:', error instanceof Error ? error.message : error);
    return false;
  }
}

type Fetch = typeof globalThis.fetch;
export function admittedFetch(
  send: Fetch = globalThis.fetch,
  admit: (source: PaidOperationSource) => string = admitPaidOperation,
  responded: (receiptId: string, status: number, requestId: string | null) => void = recordPaidResponse,
): Fetch {
  return async (input, init) => {
    const request = typeof input === 'string' || input instanceof URL ? null : input;
    const source = paidOperationSource(init?.method ?? request?.method ?? 'GET', new URL(request ? request.url : String(input)).pathname);
    if (!source) return send(input, init);
    const receiptId = admit(source);
    // A rejection here is a transport failure or timeout: no response, no
    // request id, nothing to record, and the receipt stays unresolved.
    const response = await send(input, init);
    responded(receiptId, response.status, response.headers?.get('request-id') ?? null);
    return response;
  };
}
