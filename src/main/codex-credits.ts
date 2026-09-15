import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { db } from './db';
import * as accounts from './accounts';
import { codexThreadTotals } from './codex-usage';
import { CODEX_CREDIT_RATE_CARD, estimateCredits, scanRolloutSettings, tierRecord } from '../shared/codex-credits';
import type { CodexCreditsReport } from '../shared/cost-types';

/**
 * Codex sessions that Insights counts as unpriced, given a credits estimate
 * from OpenAI's published rate card where their token counts are recorded.
 *
 * Inputs, all local and all read-only:
 *  - the cumulative token counters in each thread's rollout (codex-usage.ts);
 *  - the model and service tier Codex wrote into that rollout's turn_context
 *    and thread_settings_applied lines — never the config file's current
 *    setting, which says what the next session will use, not what this one did;
 *  - the account's sign-in mode, `auth_mode` in its auth.json. Only that one
 *    string is read out of the file; nothing else in it is kept or returned.
 *    An API-key account is billed in dollars at API rates, so it gets no
 *    credits figure at all.
 */

const SCAN_CAP_BYTES = 64 * 1024 * 1024;
const CHUNK = 1024 * 1024;
const settingsCache = new Map<string, { size: number; mtimeMs: number; value: { tiers: string[]; models: string[] } }>();

export function rolloutSettings(file: string): { tiers: string[]; models: string[] } {
  let st: fs.Stats;
  try { st = fs.statSync(file); } catch { return { tiers: [], models: [] }; }
  const hit = settingsCache.get(file);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.value;
  const tiers = new Set<string>();
  const models = new Set<string>();
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(CHUNK);
    let carry = '';
    for (let pos = 0; pos < Math.min(st.size, SCAN_CAP_BYTES);) {
      const n = fs.readSync(fd, buf, 0, CHUNK, pos);
      if (n <= 0) break;
      pos += n;
      const text = carry + buf.subarray(0, n).toString('utf8');
      const cut = text.lastIndexOf('\n');
      const whole = cut >= 0 ? text.slice(0, cut) : '';
      carry = cut >= 0 ? text.slice(cut + 1) : text;
      if (carry.length > CHUNK * 4) carry = '';
      const found = scanRolloutSettings(whole);
      found.tiers.forEach((t) => tiers.add(t));
      found.models.forEach((m) => models.add(m));
    }
    const found = scanRolloutSettings(carry);
    found.tiers.forEach((t) => tiers.add(t));
    found.models.forEach((m) => models.add(m));
  } catch { /* unreadable: nothing recorded */ } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch { /* closed */ }
  }
  const value = { tiers: [...tiers].sort(), models: [...models].sort() };
  settingsCache.set(file, { size: st.size, mtimeMs: st.mtimeMs, value });
  return value;
}

function authModeOf(home: string): string | null {
  try {
    const file = path.join(home, 'auth.json');
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > 256 * 1024) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { auth_mode?: unknown };
    return typeof parsed.auth_mode === 'string' ? parsed.auth_mode : null;
  } catch { return null; }
}

export function codexCredits(days?: number): CodexCreditsReport {
  const n = Math.max(1, Math.min(365, Math.floor(Number(days ?? 30)) || 30));
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (n - 1));
  const since = start.getTime();

  const rows = db().prepare(`
    SELECT s.id, s.conversation_id, s.model, s.account_id, s.started_at, s.title,
           COALESCE(p.name, s.project_name) AS project_name
    FROM session_log s LEFT JOIN projects p ON p.id = s.project_id
    WHERE s.origin = 'wanigan' AND (s.harness_id = 'codex' OR s.provider_id = 'codex') AND s.started_at >= ?
    ORDER BY s.started_at DESC
  `).all(since) as { id: string; conversation_id: string | null; model: string | null; account_id: string | null; started_at: number; title: string | null; project_name: string | null }[];

  const totals = codexThreadTotals(rows.map((r) => r.conversation_id ?? '').filter(Boolean));
  const modeCache = new Map<string, string | null>();
  const ambient = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex');

  const sessions: CodexCreditsReport['sessions'] = [];
  for (const row of rows) {
    const thread = totals.get((row.conversation_id ?? '').toLowerCase());
    const home = (row.account_id && accounts.byId(row.account_id)?.configDir) || ambient;
    if (!modeCache.has(home)) modeCache.set(home, authModeOf(home));
    const authMode = modeCache.get(home) ?? null;
    if (!thread) {
      sessions.push({ sessionId: row.id, title: row.title, projectName: row.project_name, startedAt: row.started_at, authMode,
        tokens: null, estimate: { status: 'no-rate', model: row.model, reason: 'No token counts are recorded for this session’s thread.' } });
      continue;
    }
    const settings = rolloutSettings(thread.file);
    const model = settings.models.length === 1 ? settings.models[0] : settings.models.length > 1 ? null : row.model;
    const tokens = { input: thread.inTokens + thread.cacheRead, cached: thread.cacheRead, output: thread.outTokens };
    const estimate = authMode === 'apikey'
      ? { status: 'no-rate' as const, model, reason: 'This account signs in with an API key, which is billed in dollars at API rates, not plan credits.' }
      : settings.models.length > 1
        ? { status: 'no-rate' as const, model: null, reason: `The model changed during the session (${settings.models.join(', ')}), and the counters are not split by model.` }
        : estimateCredits({ model, inputTokens: tokens.input, cachedInputTokens: tokens.cached, outputTokens: tokens.output, tiers: tierRecord(settings.tiers) });
    sessions.push({ sessionId: row.id, title: row.title, projectName: row.project_name, startedAt: row.started_at, authMode, tokens, estimate });
  }

  const estimated = sessions.filter((s) => s.estimate.status === 'estimated');
  return {
    days: n,
    rateCard: { source: CODEX_CREDIT_RATE_CARD.source, readOn: CODEX_CREDIT_RATE_CARD.readOn, fastMultiplier: CODEX_CREDIT_RATE_CARD.fastMultiplier, models: CODEX_CREDIT_RATE_CARD.models },
    sessions,
    totalCredits: estimated.reduce((sum, s) => sum + (s.estimate.status === 'estimated' ? s.estimate.credits : 0), 0),
    upperCredits: estimated.reduce((sum, s) => sum + (s.estimate.status === 'estimated' ? (s.estimate.range?.[1] ?? s.estimate.credits) : 0), 0),
    estimatedSessions: estimated.length,
    tierNotRecorded: estimated.filter((s) => s.estimate.status === 'estimated' && s.estimate.tierNote === 'tier not recorded').length,
    unestimated: sessions.length - estimated.length,
  };
}
