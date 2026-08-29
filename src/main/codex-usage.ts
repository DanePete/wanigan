import fs from 'node:fs';
import { db } from './db';
import { codexRolloutPaths } from './codex-sessions';
import type { SessionUsage } from '../shared/types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TAIL_BYTES = 4 * 1024 * 1024;

export type CodexUsageSummary = {
  conversations: number;
  inTokens: number;
  outTokens: number;
  cacheRead: number;
  totalTokens: number;
  lastAt: number | null;
};

type Snapshot = Omit<CodexUsageSummary, 'conversations'>;
type Cache = { size: number; mtimeMs: number; value: Snapshot | null };
const files = new Map<string, Cache>();

function finite(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * The last token_count event holds Codex's cumulative thread counters.  Read
 * only a bounded tail: rollout files can grow for days and no accounting read
 * should make the UI hitch.  Scanning backwards also tolerates a line being
 * written while we read it.
 */
function readSnapshot(file: string): Snapshot | null {
  let stat: fs.Stats;
  try { stat = fs.statSync(file); } catch { return null; }
  const cached = files.get(file);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.value;

  let fd: number | null = null;
  let text = '';
  try {
    fd = fs.openSync(file, 'r');
    const start = Math.max(0, stat.size - TAIL_BYTES);
    const bytes = Buffer.alloc(stat.size - start);
    const read = fs.readSync(fd, bytes, 0, bytes.length, start);
    text = bytes.subarray(0, read).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch { /* already closed */ }
  }

  let value: Snapshot | null = null;
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const raw = JSON.parse(lines[i]) as {
        timestamp?: unknown;
        payload?: { type?: unknown; info?: { total_token_usage?: Record<string, unknown> } };
      };
      if (raw.payload?.type !== 'token_count') continue;
      const usage = raw.payload.info?.total_token_usage;
      if (!usage) continue;
      const input = finite(usage.input_tokens);
      const cachedInput = Math.min(input, finite(usage.cached_input_tokens));
      const output = finite(usage.output_tokens);
      const at = typeof raw.timestamp === 'string' ? Date.parse(raw.timestamp) : NaN;
      value = {
        // Codex's input count includes its cached subset.  Store the uncached
        // portion in `inTokens`, matching Wanigan's OTEL contract.
        inTokens: Math.round(input - cachedInput),
        cacheRead: Math.round(cachedInput),
        outTokens: Math.round(output),
        totalTokens: Math.round(input + output),
        lastAt: Number.isFinite(at) ? at : null,
      };
      break;
    } catch { /* incomplete line or a non-rollout line */ }
  }
  files.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, value });
  return value;
}

type SessionRow = { id: string; conversation_id: string | null };

/** Merge exact Codex transcript counters into the live session view. */
export function mergeCodexUsage(usage: Record<string, SessionUsage>): void {
  const ids = Object.keys(usage);
  if (!ids.length) return;
  const marks = ids.map(() => '?').join(',');
  const rows = db().prepare(`
    SELECT id, conversation_id FROM session_log
    WHERE id IN (${marks})
      AND (harness_id = 'codex' OR provider_id = 'codex')
  `).all(...ids) as SessionRow[];
  const conversations = [...new Set(rows
    .map((row) => row.conversation_id?.toLowerCase() ?? '')
    .filter((id) => UUID.test(id)))];
  const paths = codexRolloutPaths(conversations);
  const byConversation = new Map<string, Snapshot>();
  for (const id of conversations) {
    const file = paths.get(id);
    const snapshot = file ? readSnapshot(file) : null;
    if (snapshot) byConversation.set(id, snapshot);
  }
  for (const row of rows) {
    const thread = row.conversation_id?.toLowerCase() ?? '';
    const snapshot = byConversation.get(thread);
    const target = usage[row.id];
    if (!target || !snapshot) continue;
    // Codex has no per-thread dollar amount on this account surface.  The
    // counters below are exact; the unavailable status prevents zero from
    // being mistaken for a free session.
    if (target.costUsd === 0) target.costStatus = 'unavailable';
    target.inTokens = Math.max(target.inTokens, snapshot.inTokens);
    target.outTokens = Math.max(target.outTokens, snapshot.outTokens);
    target.cacheRead = Math.max(target.cacheRead, snapshot.cacheRead);
    if ((target.lastAt ?? 0) < (snapshot.lastAt ?? 0)) target.lastAt = snapshot.lastAt;
  }
}

/** Durable, de-duplicated Codex activity for Insights. */
export function codexUsageSummary(): CodexUsageSummary {
  const rows = db().prepare(`
    SELECT DISTINCT lower(conversation_id) AS conversation_id
    FROM session_log
    WHERE conversation_id IS NOT NULL
      AND (harness_id = 'codex' OR provider_id = 'codex')
  `).all() as Array<{ conversation_id: string }>;
  const ids = rows.map((row) => row.conversation_id).filter((id) => UUID.test(id));
  const paths = codexRolloutPaths(ids);
  const total: CodexUsageSummary = {
    conversations: 0, inTokens: 0, outTokens: 0, cacheRead: 0, totalTokens: 0, lastAt: null,
  };
  for (const id of ids) {
    const file = paths.get(id);
    const snapshot = file ? readSnapshot(file) : null;
    if (!snapshot) continue;
    total.conversations += 1;
    total.inTokens += snapshot.inTokens;
    total.outTokens += snapshot.outTokens;
    total.cacheRead += snapshot.cacheRead;
    total.totalTokens += snapshot.totalTokens;
    if ((snapshot.lastAt ?? 0) > (total.lastAt ?? 0)) total.lastAt = snapshot.lastAt;
  }
  return total;
}

export const __test = { readSnapshot };
