import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { db } from '../db';
import { assertStorageAdmission } from '../storage-maintenance';
import { PAID_REQUEST_ID, paidSettlementEvidenceHash, type PaidOperationEvidence } from '../paid-operation-evidence';

/** Transports with no owner ledger of their own that precedes the send. The
 * label is the whole record: no prompt, body, URL, credential or argv. */
export type PaidOperationSource = 'anthropic:messages' | 'anthropic:batches' | 'learning:cli';

/** A prospective receipt, written before the request can exist. Only a
 * separately bound accounting outcome can remove its recovery blocker. */
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
  const columns = d.prepare('PRAGMA table_info(usage_paid_settlements)').all() as { name: string }[];
  if (!columns.some(column => column.name === 'evidence_hash')) d.exec('ALTER TABLE usage_paid_settlements ADD COLUMN evidence_hash TEXT');
}

const settlementSelect = `SELECT o.id,o.source,o.at,s.outcome,s.http_status,s.request_id,s.owner_table,s.owner_id,s.evidence_hash
  FROM usage_paid_operations o LEFT JOIN usage_paid_settlements s ON s.receipt_id=o.id`;

/** The response's facts, written once when it arrives. Never throws into the
 * caller: a settlement that cannot be written leaves the receipt unresolved,
 * which is the conservative answer, and the response is still theirs. */
export function recordPaidResponse(receiptId: string, status: number, requestId: string | null, d?: Database.Database, directProvider = false): void {
  try {
    const database = d ?? db();
    const id = requestId && PAID_REQUEST_ID.test(requestId) ? requestId : null;
    const outcome: PaidSettlementOutcome = directProvider && Number.isInteger(status) && status >= 400 && status <= 599 && id
      ? 'not-charged-provider-stated' : 'responded';
    const receipt = database.prepare('SELECT id,source,at FROM usage_paid_operations WHERE id=?').get(receiptId) as Pick<PaidOperationEvidence, 'id' | 'source' | 'at'> | undefined;
    if (!receipt) return;
    const evidence = { ...receipt, outcome, http_status: status, request_id: id, owner_table: null, owner_id: null, evidence_hash: null };
    database.prepare('INSERT OR IGNORE INTO usage_paid_settlements(receipt_id,at,outcome,http_status,request_id,evidence_hash) VALUES (?,?,?,?,?,?)')
      .run(receiptId, Date.now(), outcome, status, id, paidSettlementEvidenceHash(database, evidence));
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
}, d?: Database.Database): boolean {
  try {
    const database = d ?? db();
    if (!input.receiptId && (!input.requestId || !PAID_REQUEST_ID.test(input.requestId))) return false;
    const rows = database.prepare(`${settlementSelect} WHERE ${input.receiptId ? 'o.id' : 's.request_id'}=?`)
      .all(input.receiptId ?? input.requestId) as PaidOperationEvidence[];
    if (rows.length !== 1) return false;
    const row = rows[0];
    if (input.receiptId ? row.outcome !== null : row.outcome !== 'responded') return false;
    const evidenceHash = paidSettlementEvidenceHash(database, { ...row, outcome: input.outcome, owner_table: input.ownerTable, owner_id: input.ownerId });
    if (!evidenceHash) return false;
    if (input.receiptId) return database.prepare(`INSERT OR IGNORE INTO usage_paid_settlements(receipt_id,at,outcome,owner_table,owner_id,evidence_hash)
      VALUES (?,?,?,?,?,?)`).run(row.id, Date.now(), input.outcome, input.ownerTable, input.ownerId, evidenceHash).changes === 1;
    return database.prepare(`UPDATE usage_paid_settlements SET outcome=?,owner_table=?,owner_id=?,evidence_hash=?
      WHERE receipt_id=? AND outcome='responded'`).run(input.outcome, input.ownerTable, input.ownerId, evidenceHash, row.id).changes === 1;
  } catch (error) {
    console.warn('[wanigan] paid operation not accounted for; its receipt stays unresolved:', error instanceof Error ? error.message : error);
    return false;
  }
}

/**
 * The ledger for a paid request whose caller keeps none of its own. A feature
 * with a ledger links that instead; this exists so "has no ledger" is never
 * the reason a metered request stays unaccounted for. Bounded to a closed
 * source label, the model and the token counts the provider reported: no
 * prompt, reply, row content or price. A price is arithmetic a reader can redo.
 */
export type DirectRequestSource = 'batch:dry-run';

export function migrateUsageDirectRequests(d: Database.Database): void {
  d.exec(`CREATE TABLE IF NOT EXISTS usage_direct_requests (
    id TEXT PRIMARY KEY,
    at INTEGER NOT NULL,
    source TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    request_id TEXT
  )`);
}

/** Records the meters, then lets them account for the request's receipt. A
 * reply with no usable meters records nothing and leaves the receipt open.
 * Never throws: the caller already has its answer. */
export function recordDirectRequestMeters(input: {
  source: DirectRequestSource; model: unknown; inputTokens: unknown; outputTokens: unknown; requestId: string | null | undefined;
}, d?: Database.Database): boolean {
  try {
    const tokens = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
    const model = typeof input.model === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(input.model) ? input.model : null;
    if (!model || !tokens(input.inputTokens) || !tokens(input.outputTokens)) return false;
    const database = d ?? db();
    const id = randomUUID();
    const requestId = input.requestId && PAID_REQUEST_ID.test(input.requestId) ? input.requestId : null;
    database.prepare('INSERT INTO usage_direct_requests(id,at,source,model,input_tokens,output_tokens,request_id) VALUES (?,?,?,?,?,?,?)')
      .run(id, Date.now(), input.source, model, input.inputTokens, input.outputTokens, requestId);
    return accountForPaidOperation({ requestId, outcome: 'metered', ownerTable: 'usage_direct_requests', ownerId: id }, database);
  } catch (error) {
    console.warn('[wanigan] direct request meters not recorded; its receipt stays unresolved:', error instanceof Error ? error.message : error);
    return false;
  }
}

type Fetch = typeof globalThis.fetch;
export function admittedFetch(
  send: Fetch = globalThis.fetch,
  admit: (source: PaidOperationSource) => string = admitPaidOperation,
  responded: (receiptId: string, status: number, requestId: string | null, directProvider: boolean) => void
    = (receipt, status, request, direct) => recordPaidResponse(receipt, status, request, undefined, direct),
): Fetch {
  return async (input, init) => {
    const request = typeof input === 'string' || input instanceof URL ? null : input;
    const source = paidOperationSource(init?.method ?? request?.method ?? 'GET', new URL(request ? request.url : String(input)).pathname);
    if (!source) return send(input, init);
    const receiptId = admit(source);
    // A rejection here is a transport failure or timeout: no response, no
    // request id, nothing to record, and the receipt stays unresolved.
    const response = await send(input, init);
    try {
      const direct = new URL(request ? request.url : String(input)).origin === 'https://api.anthropic.com'
        && !response.redirected && (!response.url || new URL(response.url).origin === 'https://api.anthropic.com');
      responded(receiptId, response.status, response.headers?.get('request-id') ?? null, direct);
    } catch { console.warn('[wanigan] paid response evidence unavailable; receipt remains unresolved.'); }
    return response;
  };
}
