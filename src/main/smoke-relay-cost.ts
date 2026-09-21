import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import * as accounts from './accounts';
import { dataDir, db } from './db';
import { usageFor, usageForMany } from './otel';
import { forecastPhase } from '../shared/relay-forecast';
import { codexTokenEvidenceForSessions } from './codex-usage';

type Check = (ok: boolean, label: string, detail?: unknown) => void;

/** Recorded SQLite and rollout fixtures through the public usage reader; no agent or paid call. */
export function runRelayCostSmoke(check: Check, say: (text: string) => void): void {
  say('── relay cost evidence · an absent meter is unknown, an explicit zero is reported');
  const root = fs.mkdtempSync(path.join(dataDir(), 'relay-cost-'));
  const prefix = `cost_${randomUUID()}`;
  const ids = ['missing', 'tokens', 'events', 'zero', 'paid', 'unknown', 'codex-empty', 'codex-rollout', 'codex-resume']
    .map(name => `${prefix}_${name}`);
  const [missing, tokens, events, zero, paid, unknown, codexEmpty, codexRollout, codexResume] = ids;
  const threadId = randomUUID();
  const at = Date.now();
  const d = db();
  let accountId: string | null = null;
  try {
    const session = d.prepare(`INSERT INTO session_log
      (id,provider_id,backend_id,harness_id,conversation_id,project_path,project_name,started_at)
      VALUES (?,?,?,?,?,?,?,?)`);
    for (const id of ids) {
      const codex = id === codexEmpty || id === codexRollout || id === codexResume;
      session.run(id, codex ? 'codex' : 'claude',
        id === unknown ? 'removed-pack:unknown-backend' : codex ? 'openai' : 'anthropic',
        codex ? 'codex' : 'claude-code', id === codexRollout || id === codexResume ? threadId : null,
        root, 'Cost evidence fixture', at);
    }
    const metric = d.prepare('INSERT INTO session_metrics (session_id,metric,attrs,value,last_at) VALUES (?,?,?,?,?)');
    metric.run(tokens, 'claude_code.token.usage', '{"type":"input"}', 420, at);
    metric.run(zero, 'claude_code.cost.usage', '', 0, at);
    metric.run(paid, 'claude_code.cost.usage', '{"model":"first"}', 0.25, at);
    metric.run(paid, 'claude_code.cost.usage', '{"model":"second"}', 0.5, at);
    metric.run(unknown, 'claude_code.cost.usage', '', 7, at);
    // Event cost defaults to zero in this schema: a request row alone cannot
    // establish that a dollar meter reported an explicit zero.
    d.prepare('INSERT INTO session_api_events (session_id,at,kind,model) VALUES (?,?,?,?)')
      .run(events, at, 'request', 'fixture-model');

    const usage = usageForMany(ids);
    check(usage[missing].costStatus === 'unavailable' && usage[missing].lastAt === null,
      'a recorded session with no telemetry does not become a reported free session', usage[missing]);
    check(usage[tokens].costStatus === 'unavailable' && usage[tokens].inTokens === 420,
      'token telemetry preserves its counters without inventing a dollar meter', usage[tokens]);
    check(usage[events].costStatus === 'unavailable' && usage[events].requests === 1
      && usage[events].models[0] === 'fixture-model',
    'a request event preserves activity without treating the schema default as reported cost', usage[events]);
    check(usage[zero].costStatus === 'reported' && usage[zero].costUsd === 0,
      'an explicit zero dollar meter remains a reported zero', usage[zero]);
    check(usage[paid].costStatus === 'reported' && usage[paid].costUsd === 0.75,
      'reported model cost rows still accumulate into the session total', usage[paid]);
    check(usage[unknown].costStatus === 'unavailable' && usage[unknown].costUsd === 7,
      'an unresolved backend retains the meter value without presenting it as verified spend', usage[unknown]);
    check(usageFor(`${prefix}_unlogged`).costStatus === 'unavailable'
      && usage[codexEmpty].costStatus === 'unavailable',
    'unknown sessions and Codex sessions without rollouts remain unmetered');

    const route = { providerId: 'claude', model: 'fixture-model', effort: 'high' };
    const sample = (id: string) => ({ ...route, durationMs: 1000,
      costUsd: usage[id].costStatus === 'reported' ? usage[id].costUsd : null });
    const unmetered = forecastPhase(route, [sample(missing), sample(tokens), sample(events)]);
    const meteredZero = forecastPhase(route, [sample(zero), sample(zero), sample(zero)]);
    check(unmetered.nPriced === 0 && unmetered.medianUsd === null
      && meteredZero.nPriced === 3 && meteredZero.medianUsd === 0,
    'forecast samples distinguish missing cost evidence from explicitly reported zero', { unmetered, meteredZero });

    const account = accounts.create({ harness: 'codex', label: 'Cost evidence fixture', configDir: root });
    accountId = account.id;
    const rolloutPath = path.join(root, 'rollout.jsonl');
    fs.writeFileSync(rolloutPath, JSON.stringify({ timestamp: new Date(at).toISOString(),
      payload: { type: 'token_count', info: { total_token_usage: {
        input_tokens: 100, cached_input_tokens: 40, output_tokens: 12,
      } } },
    }) + '\n');
    const state = new Database(path.join(root, 'state_5.sqlite'));
    try {
      state.exec('CREATE TABLE threads (id TEXT,cwd TEXT,created_at_ms INTEGER,source TEXT,rollout_path TEXT)');
      state.prepare('INSERT INTO threads VALUES (?,?,?,?,?)').run(threadId, root, at, 'cli', rolloutPath);
    } finally { state.close(); }
    const reconciled = usageFor(codexRollout);
    check(reconciled.inTokens === 60 && reconciled.cacheRead === 40 && reconciled.outTokens === 12
      && reconciled.lastAt === at && reconciled.costStatus === 'unavailable',
    'Codex rollout reconciliation keeps exact uncached/cached/output counters without invented dollars', reconciled);

    const start = at - 1000;
    const point = (offset: number, input: number, cache: number, output: number) => JSON.stringify({
      timestamp: new Date(start + offset).toISOString(), payload: { type: 'token_count', info: {
        total_token_usage: { input_tokens: input, cached_input_tokens: cache, output_tokens: output },
      } },
    });
    fs.writeFileSync(rolloutPath, [JSON.stringify({ type: 'session_meta', timestamp: new Date(start + 100).toISOString(),
      payload: { id: threadId } }), point(200, 100, 60, 10), point(400, 300, 180, 30), point(600, 350, 210, 50)].join('\n'));
    d.prepare('UPDATE session_log SET started_at=?,ended_at=? WHERE id=?').run(start + 50, start + 250, codexRollout);
    d.prepare('UPDATE session_log SET started_at=?,ended_at=? WHERE id=?').run(start + 300, start + 450, codexResume);
    const scoped = codexTokenEvidenceForSessions([codexRollout, codexResume], at);
    check(scoped[codexRollout].counts.inputTokens === 40 && scoped[codexRollout].counts.cacheReadTokens === 60
      && scoped[codexResume].counts.inputTokens === 80 && scoped[codexResume].counts.cacheReadTokens === 120
      && scoped[codexResume].counts.outputTokens === 20 && scoped[codexResume].counts.cacheWriteTokens === null,
    'real session intervals and bounded rollout reads attribute resume deltas without repeating prior or later tokens', scoped);
    d.prepare('UPDATE session_log SET ended_at=NULL WHERE id=?').run(codexRollout);
    const overlap = codexTokenEvidenceForSessions([codexResume], at)[codexResume];
    check(overlap.scope === 'conversation-only' && overlap.counts.inputTokens === null
      && overlap.conversationTotals?.inputTokens === 120,
    'an overlapping recorded session makes thread counters conversation-only instead of claiming per-attempt usage', overlap);
  } finally {
    for (const id of ids) {
      d.prepare('DELETE FROM session_api_events WHERE session_id=?').run(id);
      d.prepare('DELETE FROM session_metrics WHERE session_id=?').run(id);
      d.prepare('DELETE FROM session_log WHERE id=?').run(id);
    }
    if (accountId) accounts.remove(accountId);
    fs.rmSync(root, { recursive: true, force: true });
  }
}
