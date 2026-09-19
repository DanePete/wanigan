import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

/** Bounded evidence only, never request bodies, replies or credentials. Usage
 * writes this binding; Recovery verifies it again before dropping a blocker. */
export type PaidOperationEvidence = {
  id: string; source: string; at: number; outcome: string | null;
  http_status: number | null; request_id: string | null;
  owner_table: string | null; owner_id: string | null; evidence_hash: string | null;
};
export const PAID_REQUEST_ID = /^[A-Za-z0-9_-]{1,128}$/;
const count = (value: unknown): boolean => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const amount = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value) && value >= 0;

export function paidSettlementEvidenceHash(d: Database.Database, row: PaidOperationEvidence): string | null {
  try {
    if (!row.id || !count(row.at)) return null;
    let owner: Record<string, unknown> | undefined;
    if (row.outcome === 'reported-estimate') {
      if (row.source !== 'learning:cli' || row.owner_table !== 'learning_model_runs' || !row.owner_id || row.http_status !== null || row.request_id !== null) return null;
      owner = d.prepare('SELECT id,at,status,cost_reported,cost_usd FROM learning_model_runs WHERE id=?').get(row.owner_id) as Record<string, unknown> | undefined;
      if (!owner || !['ok', 'failed'].includes(String(owner.status)) || owner.cost_reported !== 1 || !amount(owner.cost_usd)) return null;
    } else {
      if (!['anthropic:messages', 'anthropic:batches'].includes(row.source) || !row.request_id || !PAID_REQUEST_ID.test(row.request_id)) return null;
      if (row.outcome === 'not-charged-provider-stated') {
        if (!Number.isInteger(row.http_status) || row.http_status! < 400 || row.http_status! > 599 || row.owner_table !== null || row.owner_id !== null) return null;
      } else if (row.outcome === 'metered') {
        if (row.source !== 'anthropic:messages' || !Number.isInteger(row.http_status) || row.http_status! < 200 || row.http_status! > 299
            || !row.owner_id) return null;
        if (row.owner_table === 'prompt_improve_usage') {
          owner = d.prepare(`SELECT request_id,at,model,input_tokens,output_tokens,cache_read_tokens,estimated_cost_usd
            FROM prompt_improve_usage WHERE request_id=?`).get(row.owner_id) as Record<string, unknown> | undefined;
          if (!owner || !count(owner.input_tokens) || !count(owner.output_tokens) || !count(owner.cache_read_tokens)
              || typeof owner.model !== 'string' || !owner.model || (owner.estimated_cost_usd !== null && !amount(owner.estimated_cost_usd))) return null;
        } else if (row.owner_table === 'companion_turns') {
          // Companion sends no cache_control, so input and output are its whole meter.
          owner = d.prepare('SELECT id,at,model,input_tokens,output_tokens,cost_usd FROM companion_turns WHERE id=?')
            .get(row.owner_id) as Record<string, unknown> | undefined;
          if (!owner || !count(owner.input_tokens) || !count(owner.output_tokens)
              || typeof owner.model !== 'string' || !owner.model || (owner.cost_usd !== null && !amount(owner.cost_usd))) return null;
        } else return null;
      } else return null;
    }
    return createHash('sha256').update(JSON.stringify([
      row.id, row.source, row.at, row.outcome, row.http_status, row.request_id, row.owner_table, row.owner_id, owner ?? null,
    ])).digest('hex');
  } catch { return null; } // Missing or unreadable owner evidence is unresolved.
}

export function paidOperationAccountedFor(d: Database.Database, row: PaidOperationEvidence): boolean {
  if (!row.evidence_hash || paidSettlementEvidenceHash(d, row) !== row.evidence_hash) return false;
  if (row.request_id) {
    const matches = d.prepare('SELECT COUNT(*) AS n FROM usage_paid_settlements WHERE request_id=?').get(row.request_id) as { n: number };
    if (matches.n !== 1) return false; // One response cannot account for two attempts.
  }
  return true;
}
