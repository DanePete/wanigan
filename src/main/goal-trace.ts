import { randomUUID } from 'node:crypto';
import { db } from './db';
import type { GoalTraceEvent } from '../shared/types';

type TraceInput = Omit<GoalTraceEvent, 'id' | 'docketId' | 'nodeId' | 'createdAt'> & { createdAt?: number };

/**
 * Project Goal trace entries from existing operational signals. This module is
 * intentionally independent of sessions, hooks and telemetry: no event source
 * needs permission to mutate Goal state, and trace loss never interrupts an
 * agent or an exporter.
 */
export function recordGoalTrace(input: TraceInput): GoalTraceEvent | null {
  const node = db().prepare('SELECT id,docket_id FROM work_nodes WHERE session_id=?').get(input.sessionId) as {
    id: string; docket_id: string;
  } | undefined;
  if (!node) return null;
  const event: GoalTraceEvent = {
    id: `trace_${randomUUID().slice(0, 12)}`,
    docketId: node.docket_id,
    nodeId: node.id,
    sessionId: input.sessionId,
    source: input.source,
    kind: input.kind.slice(0, 100),
    status: input.status,
    toolName: input.toolName?.slice(0, 128) ?? null,
    summary: input.summary?.slice(0, 1_000) ?? null,
    durationMs: input.durationMs === null ? null : Math.max(0, Math.round(input.durationMs)),
    costUsd: Number.isFinite(input.costUsd) ? Math.max(0, input.costUsd) : 0,
    inTokens: Number.isFinite(input.inTokens) ? Math.max(0, Math.round(input.inTokens)) : 0,
    outTokens: Number.isFinite(input.outTokens) ? Math.max(0, Math.round(input.outTokens)) : 0,
    createdAt: input.createdAt ?? Date.now(),
  };
  try {
    db().prepare(`INSERT INTO work_trace_events
      (id,docket_id,node_id,session_id,source,kind,status,tool_name,summary,duration_ms,cost_usd,in_tokens,out_tokens,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      event.id, event.docketId, event.nodeId, event.sessionId, event.source, event.kind, event.status,
      event.toolName, event.summary, event.durationMs, event.costUsd, event.inTokens, event.outTokens, event.createdAt,
    );
    return event;
  } catch {
    return null;
  }
}

export function listGoalTrace(docketId: string, limit = 120): GoalTraceEvent[] {
  const rows = db().prepare(`SELECT * FROM work_trace_events WHERE docket_id=? ORDER BY created_at DESC LIMIT ?`)
    .all(docketId, Math.max(1, Math.min(500, Math.round(limit)))) as Array<{
      id: string; docket_id: string; node_id: string; session_id: string; source: GoalTraceEvent['source']; kind: string;
      status: GoalTraceEvent['status']; tool_name: string | null; summary: string | null; duration_ms: number | null;
      cost_usd: number; in_tokens: number; out_tokens: number; created_at: number;
    }>;
  return rows.map((row) => ({
    id: row.id, docketId: row.docket_id, nodeId: row.node_id, sessionId: row.session_id, source: row.source,
    kind: row.kind, status: row.status, toolName: row.tool_name, summary: row.summary, durationMs: row.duration_ms,
    costUsd: row.cost_usd, inTokens: row.in_tokens, outTokens: row.out_tokens, createdAt: row.created_at,
  }));
}
