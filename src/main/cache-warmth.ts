import { db } from './db';
import { knownLimits } from './usage';
import { backendCostBasis, providerById } from './providers';
import { readProjectConfig } from './context/config';
import { inferCacheTtl, type CacheTtl } from '../shared/cache-warmth';
import type { CacheWarmthFacts } from '../shared/cost-types';

/**
 * The facts the composer needs to say "this send will likely re-read the
 * conversation without cache": when the last turn ended, how much context the
 * last request carried, and the cache lifetime with the evidence behind it.
 * Every read is local and cheap — no CLI is spawned, no account is probed; the
 * account's sign-in method is used only if a visit to Usage already asked.
 */

function lifetimeFor(row: { account_id: string | null; conversation_id: string | null; project_path: string; worktree: string | null }): CacheTtl {
  let settingTtl: unknown;
  try {
    settingTtl = readProjectConfig(row.worktree ?? row.project_path).settings.find((s) => s.key === 'promptCacheTtl')?.value;
  } catch { /* an unreadable project config pins nothing */ }
  let recentWrite: { fiveMinute: number; oneHour: number } | null = null;
  if (row.conversation_id) {
    const w = db().prepare(`
      SELECT cache_write_5m AS five, cache_write_1h AS hour FROM claude_usage_events
      WHERE session_id = ? AND (cache_write_5m > 0 OR cache_write_1h > 0) ORDER BY at DESC LIMIT 1
    `).get(row.conversation_id) as { five: number; hour: number } | undefined;
    if (w) recentWrite = { fiveMinute: w.five ?? 0, oneHour: w.hour ?? 0 };
  }
  const identity = row.account_id ? knownLimits()?.limits.find((l) => l.accountId === row.account_id)?.identity ?? null : null;
  return inferCacheTtl({
    envTtl: process.env.CLAUDE_CODE_PROMPT_CACHE_TTL ?? null,
    settingTtl,
    recentWrite,
    authMethod: identity?.authMethod ?? null,
    apiKeyInEnvironment: Boolean(process.env.ANTHROPIC_API_KEY?.trim() || process.env.ANTHROPIC_AUTH_TOKEN?.trim()),
  });
}

export function cacheWarmth(sessionId: string): CacheWarmthFacts {
  const row = db().prepare(`
    SELECT id, harness_id, provider_id, backend_id, account_id, conversation_id, project_path, worktree
    FROM session_log WHERE id = ? AND origin = 'wanigan'
  `).get(sessionId) as { id: string; harness_id: string | null; provider_id: string; backend_id: string | null; account_id: string | null; conversation_id: string | null; project_path: string; worktree: string | null } | undefined;
  if (!row) return { supported: false, reason: 'This session has no launch record.', lastTurnEndedAt: null, contextTokens: null, ttl: { minutes: null, basis: 'unknown' } };
  const harness = row.harness_id ?? providerById(row.provider_id)?.harness ?? null;
  const backend = row.backend_id || providerById(row.provider_id)?.backendId;
  if (harness !== 'claude-code' || backendCostBasis(backend) !== 'reconcilable') {
    return { supported: false, reason: 'Cache lifetimes are known only for Claude Code on Anthropic’s API.', lastTurnEndedAt: null, contextTokens: null, ttl: { minutes: null, basis: 'unknown' } };
  }
  const stop = db().prepare(`SELECT MAX(at) AS at FROM session_events WHERE session_id = ? AND event IN ('Stop', 'StopFailure')`).get(sessionId) as { at: number | null };
  const lastRequest = db().prepare(`
    SELECT at, in_tokens + cache_read + cache_write AS tokens FROM session_api_events
    WHERE session_id = ? AND kind = 'request' ORDER BY at DESC LIMIT 1
  `).get(sessionId) as { at: number; tokens: number } | undefined;
  let contextTokens = lastRequest && lastRequest.tokens > 0 ? lastRequest.tokens : null;
  let transcriptAt: number | null = null;
  if (contextTokens === null && row.conversation_id) {
    const t = db().prepare(`
      SELECT at, in_tokens + cache_read + cache_write_5m + cache_write_1h AS tokens FROM claude_usage_events
      WHERE session_id = ? AND sidechain = 0 ORDER BY at DESC LIMIT 1
    `).get(row.conversation_id) as { at: number; tokens: number } | undefined;
    if (t && t.tokens > 0) { contextTokens = t.tokens; transcriptAt = t.at; }
  }
  return {
    supported: true,
    reason: null,
    lastTurnEndedAt: stop.at ?? lastRequest?.at ?? transcriptAt,
    contextTokens,
    ttl: lifetimeFor(row),
  };
}
