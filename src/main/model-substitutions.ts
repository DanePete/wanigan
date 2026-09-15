import fs from 'node:fs';
import { db } from './db';
import { listSessions } from './sessions';
import { modelSwitchTarget } from './hooks';
import { transcriptPathFor } from './transcripts';
import { codexRolloutPaths } from './codex-sessions';
import { rolloutFormatOf } from './codex-rollout-health';
import {
  findSubstitutions, switchIsRequest, type ReportedModel, type RequestedModel, type Substitution,
} from '../shared/model-substitution';

/**
 * Asked for X, answered by Y — gathered for one session from what was recorded.
 *
 * Requested: the model the renderer launched with and each `/model` Wanigan
 * typed (model_requests), plus every PostModelSwitch whose source is a
 * person's. Reported: each OTel api_request's `model` with its cost; each
 * PostModelSwitch with source `auto`; and, only where no OTel request was
 * recorded, the Claude transcript's `message.model` per assistant turn or the
 * Codex rollout's `turn_context.model` — one source of per-turn truth, never
 * two counted over the same turns.
 *
 * Substitutions found are kept in model_substitutions so Insights and a later
 * read see them after the session and its files are gone. Cost is attributed to
 * the reported model: it is the sum of the reported cost of the requests that
 * model answered.
 */

const TAIL_BYTES = 2 * 1024 * 1024;

type SessionFacts = {
  id: string; harness: string | null; conversationId: string | null; cwd: string; createdAt: number; model: string | null;
};

function factsFor(sessionId: string): SessionFacts | null {
  const live = listSessions().find((s) => s.id === sessionId);
  if (live) {
    return {
      id: live.id, harness: live.harnessId ?? null, conversationId: live.conversationId ?? null,
      cwd: live.worktree ?? live.projectPath, createdAt: live.createdAt, model: live.model ?? null,
    };
  }
  const row = db().prepare('SELECT id, harness_id, conversation_id, worktree, project_path, started_at, model FROM session_log WHERE id=?')
    .get(sessionId) as { id: string; harness_id: string | null; conversation_id: string | null; worktree: string | null; project_path: string; started_at: number; model: string | null } | undefined;
  if (!row) return null;
  return { id: row.id, harness: row.harness_id, conversationId: row.conversation_id, cwd: row.worktree ?? row.project_path, createdAt: row.started_at, model: row.model };
}

/** Recorded by the renderer's launch and tuning handlers. */
export function recordModelRequest(sessionId: string, model: string | null | undefined, via: 'launch' | 'wanigan', at = Date.now()): void {
  try {
    db().prepare('INSERT INTO model_requests (session_id, at, model, via) VALUES (?,?,?,?)').run(sessionId, at, model?.trim() || null, via);
  } catch { /* evidence, never a dependency */ }
}

function requestedFor(facts: SessionFacts): { requested: RequestedModel[]; switches: ReportedModel[]; launchKnown: boolean } {
  const rows = db().prepare('SELECT at, model, via FROM model_requests WHERE session_id=? ORDER BY at, id')
    .all(facts.id) as { at: number; model: string | null; via: 'launch' | 'wanigan' }[];
  const requested: RequestedModel[] = rows.map((r) => ({ at: r.at, model: r.model, via: r.via }));
  const launchKnown = rows.some((r) => r.via === 'launch');
  const switches: ReportedModel[] = [];
  const events = db().prepare("SELECT at, summary FROM session_events WHERE session_id=? AND event='PostModelSwitch' ORDER BY at")
    .all(facts.id) as { at: number; summary: string | null }[];
  for (const e of events) {
    const to = modelSwitchTarget(e.summary);
    if (!to) continue;
    const source = e.summary?.includes(' · ') ? e.summary.slice(e.summary.lastIndexOf(' · ') + 3).trim() : null;
    if (switchIsRequest(source)) requested.push({ at: e.at, model: to, via: source as RequestedModel['via'] });
    else if (source === 'auto') switches.push({ at: e.at, model: to, via: 'auto-switch', costUsd: null });
  }
  return { requested, switches, launchKnown };
}

function tail(file: string): string {
  let fd: number | null = null;
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - TAIL_BYTES);
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size - start);
    const read = fs.readSync(fd, buf, 0, buf.length, start);
    return buf.subarray(0, read).toString('utf8');
  } catch { return ''; }
  finally { if (fd !== null) try { fs.closeSync(fd); } catch { /* closed */ } }
}

function transcriptModels(facts: SessionFacts): ReportedModel[] {
  const file = transcriptPathFor(facts.cwd, facts.conversationId);
  if (!file || !facts.conversationId || !file.includes(facts.conversationId)) return [];
  const out: ReportedModel[] = [];
  for (const line of tail(file).split('\n')) {
    if (!line.includes('"assistant"')) continue;
    try {
      const raw = JSON.parse(line) as { type?: string; timestamp?: string; message?: { model?: unknown } };
      if (raw.type !== 'assistant' || typeof raw.message?.model !== 'string') continue;
      const at = Date.parse(raw.timestamp ?? '');
      if (Number.isFinite(at)) out.push({ at, model: raw.message.model, via: 'transcript', costUsd: null });
    } catch { /* a torn line */ }
  }
  return out;
}

function rolloutModels(facts: SessionFacts): ReportedModel[] {
  if (!facts.conversationId) return [];
  const file = codexRolloutPaths([facts.conversationId]).get(facts.conversationId.toLowerCase());
  if (!file || rolloutFormatOf(file).kind !== 'jsonl') return [];
  const out: ReportedModel[] = [];
  for (const line of tail(file).split('\n')) {
    if (!line.includes('turn_context')) continue;
    try {
      const raw = JSON.parse(line) as { type?: string; timestamp?: string; payload?: { model?: unknown } };
      if (raw.type !== 'turn_context' || typeof raw.payload?.model !== 'string') continue;
      const at = Date.parse(raw.timestamp ?? '');
      if (Number.isFinite(at)) out.push({ at, model: raw.payload.model, via: 'codex-rollout', costUsd: null });
    } catch { /* a torn line */ }
  }
  return out;
}

export type SessionSubstitutions = { sessionId: string; substitutions: Substitution[]; note: string | null };

export function substitutionsFor(sessionId: unknown): SessionSubstitutions {
  if (typeof sessionId !== 'string' || !sessionId) throw new Error('A session id is required.');
  const facts = factsFor(sessionId);
  if (!facts) return { sessionId, substitutions: [], note: 'No record of this session.' };
  const { requested, switches, launchKnown } = requestedFor(facts);
  if (!launchKnown) {
    // Without the launch request the comparison would start from whatever the
    // record says now, which a later switch may already have rewritten.
    return { sessionId, substitutions: storedFor(sessionId), note: 'The model this session was launched with was not recorded, so Wanigan does not compare it.' };
  }
  const otel = (db().prepare("SELECT at, model, cost_usd FROM session_api_events WHERE session_id=? AND kind='request' AND model IS NOT NULL ORDER BY at")
    .all(sessionId) as { at: number; model: string; cost_usd: number }[])
    .map((r): ReportedModel => ({ at: r.at, model: r.model, via: 'otel', costUsd: r.cost_usd > 0 ? r.cost_usd : null }));
  const perTurn = otel.length ? otel
    : facts.harness === 'claude-code' ? transcriptModels(facts)
      : facts.harness === 'codex' ? rolloutModels(facts) : [];
  const found = findSubstitutions(requested, [...perTurn, ...switches]);
  const upsert = db().prepare(`
    INSERT INTO model_substitutions (session_id, requested, reported, first_at, last_at, count, cost_usd, via_json)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(session_id, requested, reported) DO UPDATE SET
      first_at=MIN(first_at, excluded.first_at), last_at=MAX(last_at, excluded.last_at),
      count=excluded.count, cost_usd=excluded.cost_usd, via_json=excluded.via_json
  `);
  for (const s of found) {
    try { upsert.run(sessionId, s.requested, s.reported, s.firstAt, s.lastAt, s.count, s.costUsd, JSON.stringify(s.via)); } catch { /* evidence */ }
  }
  return { sessionId, substitutions: found, note: null };
}

function storedFor(sessionId: string): Substitution[] {
  return (db().prepare('SELECT requested, reported, first_at, last_at, count, cost_usd, via_json FROM model_substitutions WHERE session_id=? ORDER BY first_at')
    .all(sessionId) as { requested: string; reported: string; first_at: number; last_at: number; count: number; cost_usd: number | null; via_json: string }[])
    .map((r) => {
      let via: Substitution['via'] = [];
      try { via = JSON.parse(r.via_json) as Substitution['via']; } catch { via = []; }
      return { requested: r.requested, reported: r.reported, firstAt: r.first_at, lastAt: r.last_at, count: r.count, costUsd: r.cost_usd, via };
    });
}
