import fs from 'node:fs';
import path from 'node:path';
import { db } from './db';
import { listServers } from './mcp/registry';
import { transcriptPathFor } from './transcripts';
import {
  cacheMissReasonOf, idleGapRewrites, repeatedReads, unusedMcpServers, type ToolEvent,
} from '../shared/cost-causes';
import type { CostCausesReport } from '../shared/cost-types';

/**
 * Cost by cause, read from what is already on disk: Claude Code's usage rows
 * (claude_usage_events, folded from transcripts), the hook bus
 * (session_events), Wanigan's MCP registry, and — for cache-miss reasons — the
 * transcripts of Wanigan's own Claude sessions in the window. Nothing is sent
 * anywhere and no model is asked.
 *
 * Bounded on purpose: the transcript scan reads at most MAX_TRANSCRIPTS files
 * and the last TAIL_BYTES of each, and says how many it read, so a long history
 * costs a note rather than a hitch.
 */

const MAX_TRANSCRIPTS = 120;
const TAIL_BYTES = 32 * 1024 * 1024;
const MAX_ROWS = 200_000;
const missCache = new Map<string, { size: number; mtimeMs: number; types: Record<string, number>; missed: number; lines: number; versions: string[] }>();

function windowStart(days: number): number {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  return start.getTime();
}

function scanTranscript(file: string) {
  let st: fs.Stats;
  try { st = fs.statSync(file); } catch { return null; }
  const hit = missCache.get(file);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit;
  const types: Record<string, number> = {};
  let missed = 0;
  let lines = 0;
  const versions = new Set<string>();
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const start = Math.max(0, st.size - TAIL_BYTES);
    const buf = Buffer.alloc(st.size - start);
    const n = fs.readSync(fd, buf, 0, buf.length, start);
    for (const line of buf.subarray(0, n).toString('utf8').split('\n')) {
      if (!line) continue;
      lines += 1;
      const v = /"version":"(\d+\.\d+\.\d+)"/.exec(line.slice(-400));
      if (v) versions.add(v[1]);
      const reason = cacheMissReasonOf(line);
      if (!reason) continue;
      types[reason.type] = (types[reason.type] ?? 0) + 1;
      missed += reason.missedTokens ?? 0;
    }
  } catch { return null; } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch { /* closed */ }
  }
  const value = { size: st.size, mtimeMs: st.mtimeMs, types, missed, lines, versions: [...versions].sort() };
  missCache.set(file, value);
  return value;
}

export function costCauses(days?: number, mcpDays?: number, liveIds: ReadonlySet<string> = new Set()): CostCausesReport {
  const n = Math.max(1, Math.min(365, Math.floor(Number(days ?? 30)) || 30));
  const mcpWindow = Math.max(1, Math.min(365, Math.floor(Number(mcpDays ?? 14)) || 14));
  const since = windowStart(n);
  const d = db();

  // Wanigan's sessions in the window, for naming conversations and drilling through.
  const sessions = d.prepare(`
    SELECT id, conversation_id, title, project_name, project_path, worktree, started_at, harness_id, provider_id
    FROM session_log WHERE origin = 'wanigan' AND started_at >= ? ORDER BY started_at DESC
  `).all(since) as { id: string; conversation_id: string | null; title: string | null; project_name: string; project_path: string; worktree: string | null; started_at: number; harness_id: string | null; provider_id: string }[];
  const byConversation = new Map(sessions.filter((s) => s.conversation_id).map((s) => [s.conversation_id!.toLowerCase(), s] as const));

  /* (a) idle-gap cache rewrites */
  const usage = d.prepare(`
    SELECT session_id AS conversation, at, cache_read, cache_write_5m + cache_write_1h AS cache_write, sidechain, cwd
    FROM claude_usage_events WHERE at >= ? AND session_id IS NOT NULL ORDER BY at ASC LIMIT ${MAX_ROWS}
  `).all(since) as { conversation: string; at: number; cache_read: number; cache_write: number; sidechain: number | null; cwd: string | null }[];
  const cwdOf = new Map<string, string | null>();
  for (const u of usage) if (!cwdOf.has(u.conversation)) cwdOf.set(u.conversation, u.cwd);
  const rewrites = idleGapRewrites(usage.map((u) => ({ conversation: u.conversation, at: u.at, cacheRead: u.cache_read ?? 0, cacheWrite: u.cache_write ?? 0, sidechain: u.sidechain === 1 })));
  const idle = {
    conversations: rewrites.slice(0, 50).map((r) => {
      const s = byConversation.get(r.conversation.toLowerCase());
      return { ...r, sessionId: s?.id ?? null, live: s ? liveIds.has(s.id) : false, title: s?.title ?? null, where: s?.project_name ?? cwdOf.get(r.conversation) ?? null };
    }),
    gaps: rewrites.reduce((sum, r) => sum + r.gaps, 0),
    cappedTokens: rewrites.reduce((sum, r) => sum + r.cappedTokens, 0),
    uncappedTokens: rewrites.reduce((sum, r) => sum + r.uncappedTokens, 0),
    requestsRead: usage.length,
    truncated: usage.length >= MAX_ROWS,
  };

  /* (b) repeated reads */
  const toolRows = d.prepare(`
    SELECT e.session_id, e.at, e.tool_name, e.paths_json FROM session_events e
    WHERE e.at >= ? AND e.event = 'PostToolUse' AND e.tool_name IN ('Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit')
      AND e.paths_json IS NOT NULL
    ORDER BY e.at ASC LIMIT ${MAX_ROWS}
  `).all(since) as { session_id: string; at: number; tool_name: string; paths_json: string }[];
  const events: ToolEvent[] = toolRows.map((r) => {
    let paths: string[] = [];
    try { const parsed = JSON.parse(r.paths_json) as unknown; if (Array.isArray(parsed)) paths = parsed.filter((p): p is string => typeof p === 'string'); } catch { /* unreadable paths carry nothing */ }
    return { sessionId: r.session_id, at: r.at, tool: r.tool_name, paths };
  });
  const repeats = repeatedReads(events);
  const sessionById = new Map(sessions.map((s) => [s.id, s] as const));
  const reads = {
    rows: repeats.slice(0, 50).map((r) => ({ ...r, live: liveIds.has(r.sessionId), title: sessionById.get(r.sessionId)?.title ?? null, where: sessionById.get(r.sessionId)?.project_name ?? null })),
    files: repeats.length,
    sessions: new Set(repeats.map((r) => r.sessionId)).size,
    extraReads: repeats.reduce((sum, r) => sum + (r.reads - 2), 0),
  };

  /* (c) configured MCP servers never called */
  const mcpSince = Date.now() - mcpWindow * 24 * 60 * 60_000;
  const servers = listServers().map((s) => {
    const row = d.prepare('SELECT created_at FROM mcp_servers WHERE id = ?').get(s.id) as { created_at: number } | undefined;
    return { id: s.id, name: s.name, enabled: s.enabled, createdAt: row?.created_at ?? 0 };
  });
  const mcpCalls = d.prepare(`
    SELECT tool_name AS tool, MAX(at) AS at FROM session_events
    WHERE event IN ('PostToolUse', 'PostToolUseFailure') AND tool_name GLOB 'mcp__*'
    GROUP BY tool_name
  `).all() as { tool: string; at: number }[];
  const recent = d.prepare(`
    SELECT tool_name AS tool, at FROM session_events
    WHERE event IN ('PostToolUse', 'PostToolUseFailure') AND tool_name GLOB 'mcp__*' AND at >= ? LIMIT ${MAX_ROWS}
  `).all(mcpSince) as { tool: string; at: number }[];
  const unused = unusedMcpServers(servers, [...mcpCalls, ...recent], mcpSince);

  /* (d) cache-miss reasons Claude Code recorded */
  const claudeSessions = sessions.filter((s) => s.conversation_id && (s.harness_id ?? s.provider_id) !== 'codex').slice(0, MAX_TRANSCRIPTS);
  const types: Record<string, number> = {};
  const perSession: { sessionId: string; live: boolean; title: string | null; where: string; types: Record<string, number> }[] = [];
  let missedTokens = 0;
  let scanned = 0;
  const versions = new Set<string>();
  for (const s of claudeSessions) {
    const archived = d.prepare('SELECT stored_path FROM transcripts WHERE session_id = ?').get(s.id) as { stored_path: string } | undefined;
    let file = archived?.stored_path && fs.existsSync(archived.stored_path) ? archived.stored_path : null;
    if (!file) {
      for (const dir of [s.worktree, s.project_path].filter((p): p is string => !!p)) {
        const candidate = transcriptPathFor(dir, s.conversation_id);
        // transcriptPathFor falls back to the newest file in the project; only the exact conversation counts here.
        if (candidate && path.basename(candidate).toLowerCase() === `${s.conversation_id!.toLowerCase()}.jsonl`) { file = candidate; break; }
      }
    }
    if (!file) continue;
    const scan = scanTranscript(file);
    if (!scan) continue;
    scanned += 1;
    scan.versions.forEach((v) => versions.add(v));
    missedTokens += scan.missed;
    if (Object.keys(scan.types).length) {
      for (const [type, count] of Object.entries(scan.types)) types[type] = (types[type] ?? 0) + count;
      perSession.push({ sessionId: s.id, live: liveIds.has(s.id), title: s.title, where: s.project_name, types: scan.types });
    }
  }
  const recorded = Object.keys(types).length > 0;

  return {
    days: n,
    idle,
    reads,
    mcp: { days: mcpWindow, configured: servers.length, unused, hooklessNote: 'Calls from a harness without Wanigan’s hooks never reach this count.' },
    cacheMiss: {
      recorded,
      types: Object.entries(types).map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count || a.type.localeCompare(b.type)),
      missedTokens: missedTokens > 0 ? missedTokens : null,
      transcriptsScanned: scanned,
      sessionsConsidered: claudeSessions.length,
      cliVersions: [...versions].sort(),
      sessions: perSession.slice(0, 50),
      note: recorded
        ? 'Reasons as Claude Code recorded them in message.diagnostics.cache_miss_reason; this is the harness’s own claim.'
        : scanned === 0
          ? 'No transcripts of Wanigan’s Claude sessions in this window could be read.'
          : 'Not recorded by this CLI version: none of the scanned transcripts carries a cache_miss_reason.',
    },
  };
}
