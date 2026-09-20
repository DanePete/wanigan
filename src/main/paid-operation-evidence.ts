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
        if (!Number.isInteger(row.http_status) || row.http_status! < 200 || row.http_status! > 299 || !row.owner_id) return null;
        // A submission is metered by its results and by nothing else; a Messages call never is.
        if ((row.source === 'anthropic:batches') !== (row.owner_table === 'batch_ingestions')) return null;
        if (row.owner_table === 'batch_ingestions') {
          // Recovery's own rule for a batch: ended, really ingested, and not the
          // expiry path that stamps ingestion while saying the results were lost.
          owner = d.prepare(`SELECT i.batch_id,i.at,i.results,i.input_tokens,i.output_tokens,i.cache_read_tokens,i.cache_creation_tokens,
            s.request_id AS submit_request_id,b.processing_status,b.results_ingested_at,
            EXISTS (SELECT 1 FROM events e WHERE e.run_id=b.run_id AND e.level='error'
              AND instr(e.message,'Batch ' || b.id || ' was never downloaded and its results are now past the 29-day window')=1) AS results_lost
            FROM batch_ingestions i JOIN batch_submissions s ON s.batch_id=i.batch_id JOIN batches b ON b.id=i.batch_id
            WHERE i.batch_id=?`).get(row.owner_id) as Record<string, unknown> | undefined;
          if (!owner || owner.submit_request_id !== row.request_id || owner.processing_status !== 'ended'
              || !count(owner.results_ingested_at) || owner.results_ingested_at === 0 || owner.results_lost !== 0
              || !count(owner.results) || !count(owner.input_tokens) || !count(owner.output_tokens)
              || !count(owner.cache_read_tokens) || !count(owner.cache_creation_tokens)) return null;
        } else if (row.owner_table === 'prompt_improve_usage') {
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
        } else if (row.owner_table === 'batch_dry_runs') {
          // A sample may carry cache_control, so its cache meters are part of the evidence.
          owner = d.prepare(`SELECT id,at,model,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens,cost_usd
            FROM batch_dry_runs WHERE id=?`).get(row.owner_id) as Record<string, unknown> | undefined;
          if (!owner || !count(owner.input_tokens) || !count(owner.output_tokens) || !count(owner.cache_read_tokens) || !count(owner.cache_creation_tokens)
              || typeof owner.model !== 'string' || !owner.model || (owner.cost_usd !== null && !amount(owner.cost_usd))) return null;
        } else if (row.owner_table === 'interview_calls') {
          // The interview sends no cache_control either; one row is one answered call.
          owner = d.prepare('SELECT id,interview_id,at,model,input_tokens,output_tokens,cost_usd FROM interview_calls WHERE id=?')
            .get(row.owner_id) as Record<string, unknown> | undefined;
          if (!owner || !count(owner.input_tokens) || !count(owner.output_tokens) || typeof owner.interview_id !== 'string' || !owner.interview_id
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
