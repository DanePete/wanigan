import { db } from './db';
import type { GateRejection } from '../shared/rejections';

/**
 * A session's policy-gate denials, for the Timeline's "Rejected" rows. Read from
 * the ledger, which is append-only and redacted at write; nothing new is stored.
 */
export function gateRejections(sessionIdIn: unknown, limit = 500): GateRejection[] {
  if (typeof sessionIdIn !== 'string' || !sessionIdIn.trim() || sessionIdIn.length > 200) throw new Error('That is not a session id Wanigan knows.');
  const rows = db().prepare(`SELECT at, tool_name, summary, rule, reason FROM policy_ledger
    WHERE session_id = ? AND decision = 'deny' ORDER BY at DESC, id DESC LIMIT ?`).all(sessionIdIn, Math.max(1, Math.min(2_000, limit))) as
    { at: number; tool_name: string; summary: string; rule: string; reason: string }[];
  return rows.map((r) => ({ at: r.at, toolName: r.tool_name, summary: r.summary, rule: r.rule, reason: r.reason }));
}
