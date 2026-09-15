import { db } from './db';
import type { PolicySignal } from '../shared/types';

/**
 * Reading the observations recorded beside the ledger: tripwires, fast
 * approval runs, history rewrites and the commands that performed them. Rows
 * are append-only; this only reads.
 */
export function sessionSignals(sessionId: string, limit = 100): PolicySignal[] {
  const n = Math.min(Math.max(Math.trunc(limit) || 1, 1), 500);
  return db().prepare(`
    SELECT id, at, session_id AS sessionId, kind, rule, summary FROM policy_signals
     WHERE session_id = ? ORDER BY at DESC, id DESC LIMIT ?
  `).all(sessionId, n) as PolicySignal[];
}
