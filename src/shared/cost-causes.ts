/**
 * Cost by cause: four deterministic readings of where tokens went for reasons
 * an operator can change. Each is its own number with its own label, and none
 * of them is summed with another or turned into a score.
 *
 *  (a) Idle-gap cache rewrites. A request that follows a gap of five minutes or
 *      more and writes to the prompt cache is rebuilding a prefix that was
 *      likely warm before the gap. The attributable amount is capped at what
 *      the previous request had cached (read plus written) — a rewrite cannot
 *      rebuild more than existed — and the uncapped write is shown beside it as
 *      the upper bound. The capped figure is an estimate; the writes are
 *      observed.
 *  (b) Repeated reads. The same file read more than twice in one session with
 *      no Edit or Write to it in between. A count of observed tool calls.
 *  (c) Configured MCP servers never called in the window. Observed from the
 *      hook bus's tool names; a server whose calls never reach the hook bus
 *      (a harness without hooks) reads as uncalled, and the surface says so.
 *  (d) The cache-miss reasons Claude Code itself recorded in the transcript
 *      (message.diagnostics.cache_miss_reason.type), counted by type — the
 *      harness's own claim, labelled as such.
 */

export const IDLE_GAP_MS = 5 * 60_000;

export type UsageRequest = { conversation: string; at: number; cacheRead: number; cacheWrite: number; sidechain: boolean };

export type IdleGapRewrite = {
  conversation: string;
  gaps: number;
  /** Cache writes after gaps, each capped at the previous request's cached footprint. */
  cappedTokens: number;
  /** The same writes uncapped: the upper bound. */
  uncappedTokens: number;
  longestGapMs: number;
};

export function idleGapRewrites(requests: readonly UsageRequest[], gapMs = IDLE_GAP_MS): IdleGapRewrite[] {
  const byConversation = new Map<string, UsageRequest[]>();
  for (const r of requests) {
    // A subagent's requests run their own cache, interleaved in time with the
    // main thread's; mixing them would invent gaps and hide real ones.
    if (r.sidechain) continue;
    const list = byConversation.get(r.conversation) ?? [];
    list.push(r);
    byConversation.set(r.conversation, list);
  }
  const out: IdleGapRewrite[] = [];
  for (const [conversation, list] of byConversation) {
    list.sort((a, b) => a.at - b.at);
    const row: IdleGapRewrite = { conversation, gaps: 0, cappedTokens: 0, uncappedTokens: 0, longestGapMs: 0 };
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1];
      const cur = list[i];
      const gap = cur.at - prev.at;
      if (gap < gapMs || cur.cacheWrite <= 0) continue;
      row.gaps += 1;
      row.uncappedTokens += cur.cacheWrite;
      row.cappedTokens += Math.min(cur.cacheWrite, Math.max(0, prev.cacheRead + prev.cacheWrite));
      row.longestGapMs = Math.max(row.longestGapMs, gap);
    }
    if (row.gaps > 0) out.push(row);
  }
  return out.sort((a, b) => b.cappedTokens - a.cappedTokens || a.conversation.localeCompare(b.conversation));
}

export type ToolEvent = { sessionId: string; at: number; tool: string; paths: string[] };
export type RepeatedRead = { sessionId: string; path: string; reads: number };

const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** Longest run of reads per file per session with no write to it in between, where that run exceeds two. */
export function repeatedReads(events: readonly ToolEvent[]): RepeatedRead[] {
  const sorted = [...events].sort((a, b) => a.sessionId.localeCompare(b.sessionId) || a.at - b.at);
  const runs = new Map<string, { sessionId: string; path: string; current: number; longest: number }>();
  for (const e of sorted) {
    for (const p of e.paths) {
      const key = `${e.sessionId}\n${p}`;
      const run = runs.get(key) ?? { sessionId: e.sessionId, path: p, current: 0, longest: 0 };
      if (e.tool === 'Read') {
        run.current += 1;
        run.longest = Math.max(run.longest, run.current);
      } else if (WRITE_TOOLS.has(e.tool)) {
        run.current = 0;
      }
      runs.set(key, run);
    }
  }
  return [...runs.values()]
    .filter((r) => r.longest > 2)
    .map((r) => ({ sessionId: r.sessionId, path: r.path, reads: r.longest }))
    .sort((a, b) => b.reads - a.reads || a.sessionId.localeCompare(b.sessionId) || a.path.localeCompare(b.path));
}

/** The server segment of an MCP tool name, `mcp__<server>__<tool>`. */
export function mcpServerOf(toolName: string): string | null {
  if (!toolName.startsWith('mcp__')) return null;
  const rest = toolName.slice(5);
  const end = rest.indexOf('__');
  const server = end < 0 ? rest : rest.slice(0, end);
  return server || null;
}

export type McpServerUse = {
  id: string;
  name: string;
  enabled: boolean;
  createdAt: number;
  callsInWindow: number;
  lastCalledAt: number | null;
};

export function unusedMcpServers(
  servers: readonly { id: string; name: string; enabled: boolean; createdAt: number }[],
  calls: readonly { tool: string; at: number }[],
  sinceMs: number,
): McpServerUse[] {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const byServer = new Map<string, { inWindow: number; last: number | null }>();
  for (const c of calls) {
    const server = mcpServerOf(c.tool);
    if (!server) continue;
    const key = norm(server);
    const entry = byServer.get(key) ?? { inWindow: 0, last: null };
    if (c.at >= sinceMs) entry.inWindow += 1;
    entry.last = entry.last === null ? c.at : Math.max(entry.last, c.at);
    byServer.set(key, entry);
  }
  return servers
    .map((s) => {
      const use = byServer.get(norm(s.name));
      return { id: s.id, name: s.name, enabled: s.enabled, createdAt: s.createdAt, callsInWindow: use?.inWindow ?? 0, lastCalledAt: use?.last ?? null };
    })
    .filter((s) => s.enabled && s.callsInWindow === 0)
    .sort((a, b) => (a.lastCalledAt ?? 0) - (b.lastCalledAt ?? 0) || a.name.localeCompare(b.name));
}

/** Cache-miss reason type from one transcript line, or null. Cheap prefilter first: most lines carry none. */
export function cacheMissReasonOf(line: string): { type: string; missedTokens: number | null } | null {
  if (!line.includes('cache_miss_reason')) return null;
  try {
    const raw = JSON.parse(line) as { message?: { diagnostics?: { cache_miss_reason?: { type?: unknown; cache_missed_input_tokens?: unknown } } } };
    const reason = raw.message?.diagnostics?.cache_miss_reason;
    if (!reason || typeof reason.type !== 'string' || !reason.type) return null;
    const missed = typeof reason.cache_missed_input_tokens === 'number' && Number.isFinite(reason.cache_missed_input_tokens) ? reason.cache_missed_input_tokens : null;
    return { type: reason.type.slice(0, 60), missedTokens: missed };
  } catch { return null; }
}
