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
import { getCandidate, getKnowledgeItem } from './repository';
import { listSignals } from './signals';
import type {
  CandidateExplanation, CandidateStatus, ConsolidationRun, KnowledgeBriefing,
  KnowledgeKind, KnowledgeStatus, LearningPipelineStats, SessionBriefingRecord,
  SessionLearningLedger, SkillToolCalls, TranscriptCitationSummary,
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
    // Per entry: how many citations were actually re-hashed and how many were
    // carried with nothing checkable. Stored as numbers here; rows written
    // before this existed read back as null, never as 0.
    checked: entry.checked,
    skipped: entry.skipped,
  }));
  db().prepare(`
    INSERT OR REPLACE INTO session_briefings
      (session_id,at,delivery,provider_id,project_id,entries_json,
       estimated_tokens,max_tokens,omitted_stale,omitted_budget,
       omitted_unsynthesized,omitted_unverified)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    sessionId, at, input.delivery, optionalText(input.providerId, 200),
    optionalText(input.projectId, 300), JSON.stringify(entries),
    input.briefing.estimatedTokens, input.maxTokens,
    input.briefing.omittedStale, input.briefing.omittedBudget,
    input.briefing.omittedUnsynthesized, input.briefing.omittedUnverified,
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
    omittedUnsynthesized: input.briefing.omittedUnsynthesized,
    omittedUnverified: input.briefing.omittedUnverified,
    sessionStartAt: null,
  };
}

/**
 * Derived knowledge expires; human teaching does not. Consolidation stamps a
 * machine-authored claim with an expiry so a pattern nothing uses any more
 * ages out of the canonical store instead of being briefed forever.
 */
export const MACHINE_KNOWLEDGE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Push that expiry forward for the derived items a launch actually delivered.
 * Without this the clock was set once at promotion and never moved, so a claim
 * that earned its place in every briefing still self-quarantined on the same
 * ninety-day schedule as one nothing had loaded since the day it was written.
 *
 * Three rules, each a guard in the statement. It only extends, so a machine
 * whose clock ran backwards cannot shorten a life. It only touches rows that
 * already carry an expiry, so human teaching never acquires one here. And it
 * takes the entries a briefing shipped, never the candidates it ranked: an
 * item retrieval held back — stale citation, over budget, never synthesized
 * into a claim — was considered and not used, and being considered has never
 * earned anything. Never throws; a launch that reached the agent is not a
 * failure because one bookkeeping update did not land.
 */
export function refreshDeliveredKnowledgeTtl(entries: { itemId: string }[], at = Date.now()): void {
  if (!entries.length) return;
  const next = at + MACHINE_KNOWLEDGE_TTL_MS;
  try {
    const statement = db().prepare(
      "UPDATE knowledge_items SET expires_at=? WHERE id=? AND expires_at IS NOT NULL AND expires_at < ? AND status='active'",
    );
    db().transaction(() => {
      for (const entry of entries) statement.run(next, entry.itemId, next);
    })();
  } catch (error) {
    console.warn('[wanigan] delivered knowledge TTL not refreshed:', error);
  }
}

type BriefingRow = {
  session_id: string; at: number; delivery: string; provider_id: string | null;
  project_id: string | null; entries_json: string; estimated_tokens: number;
  max_tokens: number; omitted_stale: number; omitted_budget: number;
  omitted_unsynthesized: number | null; omitted_unverified: number | null;
};

const storedCount = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

function briefingFromRow(row: BriefingRow): SessionBriefingRecord {
  let entries: SessionBriefingRecord['entries'] = [];
  try {
    const parsed = JSON.parse(row.entries_json) as unknown;
    if (Array.isArray(parsed)) {
      // Older rows carry no per-entry citation counts; they read as null so
      // the renderer says "not recorded" instead of "0 re-hashed".
      entries = (parsed as Record<string, unknown>[]).map((entry) => ({
        itemId: String(entry.itemId ?? ''),
        versionId: typeof entry.versionId === 'string' ? entry.versionId : null,
        kind: entry.kind as KnowledgeKind,
        title: typeof entry.title === 'string' ? entry.title : '',
        estimatedTokens: storedCount(entry.estimatedTokens) ?? 0,
        checked: storedCount(entry.checked),
        skipped: storedCount(entry.skipped),
      }));
    }
  } catch { /* keep the row; a broken entries list is not fabricated as empty text */ }
  return {
    sessionId: row.session_id, at: row.at,
    delivery: row.delivery === 'hook' ? 'hook' : 'argv',
    providerId: row.provider_id, projectId: row.project_id, entries,
    estimatedTokens: row.estimated_tokens, maxTokens: row.max_tokens,
    omittedStale: row.omitted_stale, omittedBudget: row.omitted_budget,
    omittedUnsynthesized: storedCount(row.omitted_unsynthesized),
    omittedUnverified: storedCount(row.omitted_unverified),
    sessionStartAt: null,
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

/** A hook delivery answers one SessionStart; pair them within this window. */
const SESSION_START_PAIRING_MS = 120_000;

/**
 * Hook-delivered capsules answer a SessionStart hook, so the record is paired
 * to the nearest SessionStart row by time. Argv deliveries reach the agent as
 * launch arguments and have no SessionStart of their own; they stay null.
 */
function pairSessionStarts(sessionId: string, briefings: SessionBriefingRecord[]): SessionBriefingRecord[] {
  if (!briefings.some((record) => record.delivery === 'hook')) return briefings;
  const starts = (db().prepare(
    "SELECT at FROM session_events WHERE session_id=? AND event='SessionStart' ORDER BY at ASC LIMIT 200",
  ).all(sessionId) as { at: number }[]).map((row) => row.at);
  if (!starts.length) return briefings;
  return briefings.map((record) => {
    if (record.delivery !== 'hook') return record;
    let nearest: number | null = null;
    for (const at of starts) {
      if (Math.abs(at - record.at) > SESSION_START_PAIRING_MS) continue;
      if (nearest === null || Math.abs(at - record.at) < Math.abs(nearest - record.at)) nearest = at;
    }
    return { ...record, sessionStartAt: nearest };
  });
}

/**
 * Hook-observed `Skill` tool calls. The identifier comes from the stored
 * summary, which the hook recorder fills with the skill name only; rows
 * recorded before it did carry null and are counted as unrecorded rather
 * than dropped. This counts tool calls the hook saw: a `/name` typed into
 * the terminal never produces one, and a harness without hooks reports zero.
 */
function skillToolCallsOf(sessionId: string): SkillToolCalls {
  const rows = db().prepare(`
    SELECT summary, COUNT(*) AS n FROM session_events
    WHERE session_id=? AND event='PostToolUse' AND tool_name='Skill'
    GROUP BY summary ORDER BY n DESC
  `).all(sessionId) as { summary: string | null; n: number }[];
  let observed = 0;
  let unrecorded = 0;
  const identifiers: string[] = [];
  for (const row of rows) {
    observed += row.n;
    if (!row.summary) { unrecorded += row.n; continue; }
    if (identifiers.length < 20) identifiers.push(row.summary.slice(0, 200));
  }
  return { observed, identifiers, unrecorded };
}

/** The frozen harness of a session, from the immutable launch row; null when the row predates the column. */
function frozenHarnessOf(sessionId: string): string | null {
  const row = db().prepare('SELECT harness_id FROM session_log WHERE id=?').get(sessionId) as { harness_id: string | null } | undefined;
  return row?.harness_id?.trim() || null;
}

/** Read-only: what a recorded transcript scan said, or why there is none. */
export function transcriptCitationSummary(sessionId: string): TranscriptCitationSummary {
  const scan = db().prepare(`
    SELECT value, attrs_json FROM artifact_metrics
    WHERE session_id=? AND metric='transcript_scan' ORDER BY at DESC LIMIT 1
  `).get(sessionId) as { value: number; attrs_json: string } | undefined;
  if (!scan) {
    const harness = frozenHarnessOf(sessionId);
    if (harness && harness !== 'claude-code') {
      return { status: 'unsupported', reason: 'No transcript archive for this harness.', total: 0, truncated: false, items: [] };
    }
    return { status: 'not-scanned', reason: 'No transcript scan has been recorded for this session.', total: 0, truncated: false, items: [] };
  }
  let truncated = false;
  try { truncated = (JSON.parse(scan.attrs_json) as { truncated?: unknown }).truncated === true; } catch { /* attrs are advisory */ }
  const items = (db().prepare(`
    SELECT m.item_id, ki.title, SUM(m.value) AS n FROM artifact_metrics m
    JOIN knowledge_items ki ON ki.id = m.item_id
    WHERE m.session_id=? AND m.metric='cited' GROUP BY m.item_id ORDER BY n DESC LIMIT 50
  `).all(sessionId) as { item_id: string; title: string; n: number }[])
    .map((row) => ({ itemId: row.item_id, title: row.title, n: row.n }));
  return { status: 'scanned', reason: null, total: scan.value, truncated, items };
}

/** A `wanigan:<id>` tag as the briefing prints it; learningId('know') is `know_` plus 20 hex characters. */
const CITATION_TAG = /wanigan:(know_[0-9a-f]{20})/g;
/** Bounds on one scan: the transcript is the agent's, and it can be very large. */
const MAX_CITED_TURNS = 2_000;
const MAX_DISTINCT_CITED_IDS = 500;

/**
 * Count `wanigan:<id>` tags in a session's archived assistant turns and write
 * them as `cited` metrics (one per item) plus one `transcript_scan` row that
 * records the scan itself, so "scanned and found none" and "never scanned"
 * stay distinguishable. Claude-harness sessions only: that is the only
 * transcript archive Wanigan has. Evidence level is 'correlation' — a quoted
 * id shows the fact was in front of the agent, not that it changed anything —
 * and counts are a lower bound whenever the archive or the scan was bounded.
 * Re-running replaces the previous scan for the session; nothing is appended
 * twice. Never throws: it runs on the session-exit path.
 */
export function recordTranscriptCitations(sessionId: string, at = Date.now()): TranscriptCitationSummary {
  const clean = optionalText(sessionId, 300);
  if (!clean) return { status: 'not-scanned', reason: 'Invalid session id.', total: 0, truncated: false, items: [] };
  try {
    const harness = frozenHarnessOf(clean);
    if (harness !== 'claude-code') {
      return {
        status: 'unsupported', total: 0, truncated: false, items: [],
        reason: harness ? 'No transcript archive for this harness.' : 'The harness at launch is unknown; only Claude-harness archives are scanned.',
      };
    }
    const archive = db().prepare('SELECT parsed, note FROM transcripts WHERE session_id=?').get(clean) as { parsed: number; note: string | null } | undefined;
    if (!archive || !archive.parsed) {
      return { status: 'not-scanned', reason: 'No parsed transcript archive for this session.', total: 0, truncated: false, items: [] };
    }
    const rows = db().prepare(`
      SELECT text FROM transcript_fts WHERE session_id=? AND role='assistant' AND text LIKE '%wanigan:know_%' LIMIT ?
    `).all(clean, MAX_CITED_TURNS + 1) as { text: string }[];
    let truncated = /only the last/.test(archive.note ?? '') || rows.length > MAX_CITED_TURNS;
    const counts = new Map<string, number>();
    for (const row of rows.slice(0, MAX_CITED_TURNS)) {
      for (const match of row.text.matchAll(CITATION_TAG)) {
        const id = match[1];
        if (!counts.has(id) && counts.size >= MAX_DISTINCT_CITED_IDS) { truncated = true; continue; }
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
    }
    const items: TranscriptCitationSummary['items'] = [];
    let unknownIds = 0;
    for (const [itemId, n] of counts) {
      const item = getKnowledgeItem(itemId);
      if (!item) { unknownIds++; continue; }
      items.push({ itemId, title: item.title, n });
    }
    items.sort((a, b) => b.n - a.n);
    const total = items.reduce((sum, entry) => sum + entry.n, 0);
    const providerId = (db().prepare('SELECT provider_id FROM session_log WHERE id=?').get(clean) as { provider_id: string | null } | undefined)?.provider_id ?? null;
    db().transaction(() => {
      db().prepare("DELETE FROM artifact_metrics WHERE session_id=? AND metric IN ('cited','transcript_scan')").run(clean);
      for (const entry of items) {
        recordMetric({
          itemId: entry.itemId, sessionId: clean, providerId, metric: 'cited', value: entry.n,
          evidenceLevel: 'correlation', attrs: { source: 'transcript', truncated, harness }, at,
        });
      }
      recordMetric({
        sessionId: clean, providerId, metric: 'transcript_scan', value: total, evidenceLevel: 'correlation',
        attrs: { source: 'transcript', truncated, turnsMatched: Math.min(rows.length, MAX_CITED_TURNS), distinctIds: items.length, unknownIds, harness },
        at,
      });
    })();
    return { status: 'scanned', reason: null, total, truncated, items: items.slice(0, 50) };
  } catch (error) {
    return {
      status: 'not-scanned', total: 0, truncated: false, items: [],
      reason: `The transcript scan failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

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
    briefings: pairSessionStarts(sessionId, listSessionBriefings(sessionId)),
    signals,
    contributions,
    candidates,
    skillToolCalls: skillToolCallsOf(sessionId),
    transcriptCitations: transcriptCitationSummary(sessionId),
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
    // Counted directly, because the Inbox figure this feeds used to be
    // candidatesCreated - autoPromoted and that arithmetic was wrong twice
    // over: autoPromoted is a COUNT(DISTINCT item_id) over knowledge_versions,
    // so it counts knowledge items rather than candidates and the two terms
    // were different units; and no term in it ever fell for a candidate a
    // person approved or rejected, so an Inbox emptied by review still claimed
    // a backlog. 'pending' and 'snoozed' are the two statuses that carry no
    // recorded decision — a snooze defers the decision, it does not make one.
    awaitingDecision: one(
      `SELECT COUNT(*) n FROM knowledge_candidates
       WHERE created_at >= ? AND status IN ('pending','snoozed')${artifactWhere}`,
      [since, ...artifactArgs],
    ),
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
      label: 'Never snoozed by a person',
      ok: candidate.snoozedAt == null,
      actual: candidate.snoozedAt == null ? 'never' : `snoozed ${new Date(candidate.snoozedAt).toISOString()}`,
      required: 'never',
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
