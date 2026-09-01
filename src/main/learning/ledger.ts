/**
 * The legibility layer: recorded facts about what the learning engine did,
 * per session and over time. Nothing here computes new knowledge — every
 * function is either one small write at a moment that used to be silent
 * (a briefing injection, a consolidation pass) or a read-only query over
 * rows other modules already store. Numbers that are estimates stay labeled
 * estimates all the way to the caller.
 */
import { db } from '../db';
import { DEFAULT_AUTOMATION_POLICY, automationDecision } from './classifier';
import { recordMetric } from './experiments';
import { getCandidate } from './repository';
import { listSignals } from './signals';
import type {
  CandidateExplanation, CandidateStatus, ConsolidationRun, KnowledgeBriefing,
  KnowledgeKind, KnowledgeStatus, LearningPipelineStats, SessionBriefingRecord,
  SessionLearningLedger,
} from './types';
import { learningId, optionalText } from './util';

/* ── briefing deliveries ─────────────────────────────────────────────── */

export interface RecordSessionBriefingInput {
  sessionId: string;
  delivery: 'argv' | 'hook';
  providerId?: string | null;
  projectId?: string | null;
  briefing: KnowledgeBriefing;
  maxTokens: number;
  at?: number;
}

/**
 * Persist what a launch actually injected. An empty briefing is still recorded:
 * "retrieval ran and matched nothing" and "no record exists" must stay
 * distinguishable, or a broken store looks identical to an empty one.
 */
export function recordSessionBriefing(input: RecordSessionBriefingInput): SessionBriefingRecord {
  const sessionId = optionalText(input.sessionId, 300);
  if (!sessionId) throw new Error('A briefing record needs its session id.');
  const at = input.at ?? Date.now();
  const entries = input.briefing.entries.map((entry) => ({
    itemId: entry.itemId,
    versionId: entry.versionId,
    kind: entry.kind,
    title: entry.title.slice(0, 500),
    estimatedTokens: entry.estimatedTokens,
  }));
  db().prepare(`
    INSERT OR REPLACE INTO session_briefings
      (session_id,at,delivery,provider_id,project_id,entries_json,
       estimated_tokens,max_tokens,omitted_stale,omitted_budget)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(
    sessionId, at, input.delivery, optionalText(input.providerId, 200),
    optionalText(input.projectId, 300), JSON.stringify(entries),
    input.briefing.estimatedTokens, input.maxTokens,
    input.briefing.omittedStale, input.briefing.omittedBudget,
  );
  // First production writer of artifact_metrics: one tokens_loaded row per
  // served item. The value comes from estimateTokens, so the level is and
  // stays 'estimate' — the ROI rollup inherits the weakest included label.
  for (const entry of entries) {
    try {
      recordMetric({
        itemId: entry.itemId,
        versionId: entry.versionId,
        sessionId,
        providerId: input.providerId ?? null,
        metric: 'tokens_loaded',
        value: entry.estimatedTokens,
        evidenceLevel: 'estimate',
        attrs: { delivery: input.delivery, source: 'briefing' },
        at,
      });
    } catch { /* a metric row is never worth failing a launch over */ }
  }
  return {
    sessionId, at, delivery: input.delivery,
    providerId: input.providerId ?? null, projectId: input.projectId ?? null,
    entries, estimatedTokens: input.briefing.estimatedTokens, maxTokens: input.maxTokens,
    omittedStale: input.briefing.omittedStale, omittedBudget: input.briefing.omittedBudget,
  };
}

type BriefingRow = {
  session_id: string; at: number; delivery: string; provider_id: string | null;
  project_id: string | null; entries_json: string; estimated_tokens: number;
  max_tokens: number; omitted_stale: number; omitted_budget: number;
};

function briefingFromRow(row: BriefingRow): SessionBriefingRecord {
  let entries: SessionBriefingRecord['entries'] = [];
  try { entries = JSON.parse(row.entries_json) as SessionBriefingRecord['entries']; }
  catch { /* keep the row; a broken entries list is not fabricated as empty text */ }
  return {
    sessionId: row.session_id, at: row.at,
    delivery: row.delivery === 'hook' ? 'hook' : 'argv',
    providerId: row.provider_id, projectId: row.project_id, entries,
    estimatedTokens: row.estimated_tokens, maxTokens: row.max_tokens,
    omittedStale: row.omitted_stale, omittedBudget: row.omitted_budget,
  };
}

export function listSessionBriefings(sessionId: string, limit = 20): SessionBriefingRecord[] {
  return (db().prepare(
    'SELECT * FROM session_briefings WHERE session_id=? ORDER BY at DESC LIMIT ?',
  ).all(sessionId, Math.max(1, Math.min(100, limit))) as BriefingRow[]).map(briefingFromRow);
}

/* ── consolidation heartbeat ─────────────────────────────────────────── */

export function recordConsolidationRun(input: {
  trigger: 'timer' | 'manual';
  processed: number;
  candidates: number;
  autoApplied: number;
  durationMs: number;
  at?: number;
}): ConsolidationRun {
  const run: ConsolidationRun = {
    id: learningId('conr'),
    at: input.at ?? Date.now(),
    trigger: input.trigger,
    processed: input.processed,
    candidates: input.candidates,
    autoApplied: input.autoApplied,
    durationMs: Math.max(0, Math.round(input.durationMs)),
  };
  db().prepare(`
    INSERT INTO consolidation_runs (id,at,trigger,processed,candidates,auto_applied,duration_ms)
    VALUES (?,?,?,?,?,?,?)
  `).run(run.id, run.at, run.trigger, run.processed, run.candidates, run.autoApplied, run.durationMs);
  // The heartbeat is bounded: a 5-minute timer writes ~288 rows a day, and the
  // UI needs recency, not archaeology.
  db().prepare(`
    DELETE FROM consolidation_runs
    WHERE id NOT IN (SELECT id FROM consolidation_runs ORDER BY at DESC LIMIT 2000)
  `).run();
  return run;
}

type ConsolidationRow = {
  id: string; at: number; trigger: string; processed: number;
  candidates: number; auto_applied: number; duration_ms: number;
};

export function listConsolidationRuns(limit = 50): ConsolidationRun[] {
  return (db().prepare('SELECT * FROM consolidation_runs ORDER BY at DESC LIMIT ?')
    .all(Math.max(1, Math.min(500, limit))) as ConsolidationRow[])
    .map((row) => ({
      id: row.id, at: row.at,
      trigger: row.trigger === 'manual' ? 'manual' as const : 'timer' as const,
      processed: row.processed, candidates: row.candidates,
      autoApplied: row.auto_applied, durationMs: row.duration_ms,
    }));
}

/* ── the per-session ledger ──────────────────────────────────────────── */

export function sessionLearningLedger(sessionId: string): SessionLearningLedger {
  const signals = listSignals({ sessionId, limit: 300 });
  const contributions = (db().prepare(`
    SELECT ki.id AS item_id, ki.title, ki.kind, ki.status, COUNT(ke.id) AS n
    FROM learning_signals ls
    JOIN knowledge_evidence ke ON ke.signal_id = ls.id AND ke.item_id IS NOT NULL
    JOIN knowledge_items ki ON ki.id = ke.item_id
    WHERE ls.session_id = ?
    GROUP BY ki.id ORDER BY n DESC, ki.updated_at DESC LIMIT 50
  `).all(sessionId) as { item_id: string; title: string; kind: string; status: string; n: number }[])
    .map((row) => ({
      itemId: row.item_id, title: row.title,
      kind: row.kind as KnowledgeKind, status: row.status as KnowledgeStatus,
      evidenceCount: row.n,
    }));
  // Candidate lineage lives in signal_ids_json (evidence rows appear only at
  // promotion), so the join runs through json_each over that column. A
  // candidate is always created after its lineage signals, so the created_at
  // bound prunes the unindexable json_each scan to this session's era without
  // changing which rows qualify.
  const candidates = (db().prepare(`
    SELECT DISTINCT kc.id, kc.title, kc.status, kc.target_kind
    FROM knowledge_candidates kc, json_each(kc.signal_ids_json) sig
    WHERE kc.created_at >= (SELECT MIN(created_at) FROM learning_signals WHERE session_id = ?)
      AND sig.value IN (SELECT id FROM learning_signals WHERE session_id = ?)
    ORDER BY kc.updated_at DESC LIMIT 50
  `).all(sessionId, sessionId) as { id: string; title: string; status: string; target_kind: string }[])
    .map((row) => ({
      candidateId: row.id, title: row.title,
      status: row.status as CandidateStatus, targetKind: row.target_kind as KnowledgeKind,
    }));
  return {
    sessionId,
    briefings: listSessionBriefings(sessionId),
    signals,
    contributions,
    candidates,
  };
}

/* ── pipeline throughput ─────────────────────────────────────────────── */

/**
 * Calendar-day stepping, not millisecond arithmetic: a 23-hour DST day would
 * otherwise shift every earlier label and silently drop one calendar day from
 * the series while SQLite's localtime bucketing still produced it.
 */
function localDaySeries(windowDays: number): { days: string[]; since: number } {
  const pad = (n: number) => String(n).padStart(2, '0');
  const label = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const cursor = new Date();
  cursor.setHours(0, 0, 0, 0);
  const days: string[] = [label(cursor)];
  for (let i = 1; i < windowDays; i++) {
    cursor.setDate(cursor.getDate() - 1);
    days.unshift(label(cursor));
  }
  // The oldest label's local midnight is the window cutoff for every scalar
  // count too, so each row in a headline number lands on a day the series has.
  return { days, since: cursor.getTime() };
}

/**
 * Every stage is a COUNT over stored rows for the window; nothing is modeled.
 * Project scoping mirrors overview(): signals filter on their own project id,
 * artifacts include personal-scope rows alongside the project's.
 */
export function pipelineStats(input: { projectId?: string | null; windowDays?: number } = {}): LearningPipelineStats {
  const windowDays = Math.max(1, Math.min(365, input.windowDays ?? 30));
  const { days, since } = localDaySeries(windowDays);
  const projectId = input.projectId;
  const one = (sql: string, args: unknown[] = []) => (db().prepare(sql).get(...args) as { n: number }).n;

  const signalWhere = projectId === undefined ? '' : ' AND project_id IS ?';
  const signalArgs = projectId === undefined ? [] : [projectId];
  const artifactWhere = projectId === undefined ? '' : projectId === null
    ? ' AND project_id IS NULL' : " AND (scope='personal' OR project_id=?)";
  const artifactArgs = projectId !== undefined && projectId !== null ? [projectId] : [];
  const plainWhere = projectId === undefined ? '' : ' AND project_id IS ?';
  const plainArgs = projectId === undefined ? [] : [projectId];

  const byDayRows = db().prepare(`
    SELECT date(created_at/1000,'unixepoch','localtime') AS day,
      COUNT(*) AS total,
      SUM(CASE WHEN kind IN ('tool-failure','session-failure','gate-failed','permission-denied') THEN 1 ELSE 0 END) AS failures,
      SUM(CASE WHEN kind IN ('explicit-teach','correction') THEN 1 ELSE 0 END) AS teachings
    FROM learning_signals WHERE created_at >= ?${signalWhere}
    GROUP BY day
  `).all(since, ...signalArgs) as { day: string; total: number; failures: number; teachings: number }[];
  const byDay = new Map(byDayRows.map((row) => [row.day, row]));

  return {
    windowDays,
    signals: one(`SELECT COUNT(*) n FROM learning_signals WHERE created_at >= ?${signalWhere}`, [since, ...signalArgs]),
    signalsAllTime: one(`SELECT COUNT(*) n FROM learning_signals WHERE 1=1${signalWhere}`, signalArgs),
    eligibleSignals: one(
      `SELECT COUNT(*) n FROM learning_signals
       WHERE created_at >= ?${signalWhere}
         AND COALESCE(json_extract(detail_json,'$.learningCandidateEligible'), 1) != 0`,
      [since, ...signalArgs],
    ),
    candidatesCreated: one(`SELECT COUNT(*) n FROM knowledge_candidates WHERE created_at >= ?${artifactWhere}`, [since, ...artifactArgs]),
    autoPromoted: one(
      `SELECT COUNT(DISTINCT kv.item_id) n FROM knowledge_versions kv
       JOIN knowledge_items ki ON ki.id = kv.item_id
       WHERE kv.created_at >= ? AND kv.created_by = 'automation'${projectId === undefined ? '' : projectId === null ? ' AND ki.project_id IS NULL' : " AND (ki.scope='personal' OR ki.project_id=?)"}`,
      [since, ...artifactArgs],
    ),
    reviewed: one(`SELECT COUNT(*) n FROM knowledge_candidates WHERE reviewed_at IS NOT NULL AND reviewed_at >= ?${artifactWhere}`, [since, ...artifactArgs]),
    itemsPromoted: one(`SELECT COUNT(*) n FROM knowledge_items WHERE created_at >= ?${artifactWhere}`, [since, ...artifactArgs]),
    projectionsApplied: one(`SELECT COUNT(*) n FROM knowledge_projections WHERE applied_at IS NOT NULL AND applied_at >= ?${plainWhere}`, [since, ...plainArgs]),
    briefingsServed: one(`SELECT COUNT(*) n FROM session_briefings WHERE at >= ?${plainWhere}`, [since, ...plainArgs]),
    signalsByDay: days.map((day) => {
      const row = byDay.get(day);
      return {
        day,
        total: row?.total ?? 0,
        failures: row?.failures ?? 0,
        teachings: row?.teachings ?? 0,
      };
    }),
    consolidationRuns: listConsolidationRuns(20),
  };
}

/* ── the automation gate, decomposed ─────────────────────────────────── */

/**
 * The same deterministic checks automationDecision runs, returned one by one
 * so the Inbox can show why an item waits instead of presenting a verdict as
 * magic. No new policy lives here — drift between this and the gate would be
 * a lie, so both read DEFAULT_AUTOMATION_POLICY and the explanation ends with
 * the gate's own decision.
 */
export function explainCandidate(id: string): CandidateExplanation {
  const candidate = getCandidate(id);
  if (!candidate) throw new Error('Learning candidate not found.');
  const p = DEFAULT_AUTOMATION_POLICY;
  const verdict = automationDecision(candidate);
  const checks: CandidateExplanation['checks'] = [
    {
      label: 'Reversible personal memory',
      ok: candidate.scope === 'personal' && candidate.targetKind === 'memory',
      actual: `${candidate.scope} ${candidate.targetKind}`,
      required: 'personal memory',
    },
    {
      label: 'No conflicts with existing knowledge',
      ok: candidate.conflicts.length === 0,
      actual: `${candidate.conflicts.length} conflict${candidate.conflicts.length === 1 ? '' : 's'}`,
      required: '0',
    },
    {
      label: 'Confidence',
      ok: candidate.confidence >= p.minConfidence,
      actual: candidate.confidence.toFixed(2),
      required: `at least ${p.minConfidence.toFixed(2)}`,
    },
    {
      label: 'Distinct observations',
      ok: candidate.evidenceCount >= p.minEvidence,
      actual: String(candidate.evidenceCount),
      required: `at least ${p.minEvidence}`,
    },
    {
      label: 'Independent tasks',
      ok: candidate.taskCount >= p.minIndependentTasks,
      actual: String(candidate.taskCount),
      required: `at least ${p.minIndependentTasks}`,
    },
  ];
  return { candidateId: id, decision: verdict.decision, reason: verdict.reason, checks };
}
