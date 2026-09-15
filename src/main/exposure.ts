import os from 'node:os';
import { db } from './db';
import { exposureLeads, type ExposureEvent } from '../shared/exposure';
import type { ExposureLeadView } from '../shared/types';

/**
 * Exposure leads from the stored hook timeline: a sensitive read, then a way
 * out, in the same session. Reads only PostToolUse rows — the call ran — and
 * reads each command from the stored summary, which is clipped at 160
 * characters, so a long command can hide the half of itself that matters. The
 * panels that show a lead say it is a lead, not proof.
 */

type Row = { id: number; session_id: string; at: number; event: string; tool_name: string | null; summary: string | null; paths_json: string | null };

function toEvent(r: Row): ExposureEvent {
  let paths: string[] = [];
  try { const v: unknown = r.paths_json ? JSON.parse(r.paths_json) : []; if (Array.isArray(v)) paths = v.filter((p): p is string => typeof p === 'string'); } catch { /* none */ }
  return { id: r.id, sessionId: r.session_id, at: r.at, event: r.event, toolName: r.tool_name, summary: r.summary, paths };
}

const LOOPBACK = /^(?:127\.\d+\.\d+\.\d+|localhost|\[?::1\]?)$/i;

/** Where an MCP server named in a tool call runs, from Wanigan's own registry. Unregistered is unknown. */
function mcpLocality(server: string): 'local' | 'remote' | 'unknown' {
  if (server === 'wanigan') return 'local';
  try {
    const row = db().prepare('SELECT transport, url FROM mcp_servers WHERE name = ? LIMIT 1').get(server) as { transport: string; url: string | null } | undefined;
    if (!row) return 'unknown';
    if (row.transport === 'stdio') return 'local';
    try { return LOOPBACK.test(new URL(row.url ?? '').hostname) ? 'local' : 'remote'; } catch { return 'unknown'; }
  } catch { return 'unknown'; }
}

function withNames(leads: ReturnType<typeof exposureLeads>): ExposureLeadView[] {
  const names = new Map<string, string | null>();
  return leads.map((l) => {
    if (!names.has(l.sessionId)) {
      try {
        const r = db().prepare('SELECT project_name FROM session_log WHERE id = ?').get(l.sessionId) as { project_name: string } | undefined;
        names.set(l.sessionId, r?.project_name ?? null);
      } catch { names.set(l.sessionId, null); }
    }
    return { ...l, projectName: names.get(l.sessionId) ?? null };
  });
}

export function sessionExposureLeads(sessionId: string): ExposureLeadView[] {
  const rows = db().prepare(`
    SELECT id, session_id, at, event, tool_name, summary, paths_json FROM session_events
     WHERE session_id = ? AND event = 'PostToolUse' ORDER BY at ASC, id ASC LIMIT 5000
  `).all(sessionId) as Row[];
  return withNames(exposureLeads(rows.map(toEvent), os.homedir(), mcpLocality));
}

/** Leads across every session in the last `days` days, for the egress report. */
export function recentExposureLeads(days = 7, now = Date.now()): ExposureLeadView[] {
  const rows = db().prepare(`
    SELECT id, session_id, at, event, tool_name, summary, paths_json FROM session_events
     WHERE at >= ? AND event = 'PostToolUse'
       AND (tool_name IN ('Read','Grep','Glob','NotebookRead','WebFetch','WebSearch','Bash') OR tool_name GLOB 'mcp__*')
     ORDER BY at ASC, id ASC LIMIT 50000
  `).all(now - days * 86_400_000) as Row[];
  return withNames(exposureLeads(rows.map(toEvent), os.homedir(), mcpLocality, 100)).reverse();
}
