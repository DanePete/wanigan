/**
 * "Since you last looked", built only from what was recorded.
 *
 * There is no model call here and nothing is inferred. Each figure is a count
 * of rows Wanigan already keeps — hook events, checkpoints, reported cost — and
 * each one says which rows it counted, so a summary that reads "2 files
 * changed" can be checked against the timeline it came from. Claude Code's own
 * recap is carried separately and labelled as Claude's, because it is model
 * output about the work rather than a record of it.
 */
import type { Attention, AwaySummary, SessionCheckpoint, SessionEvent } from './types';

/** How many failed commands the summary names; the rest are counted. */
export const AWAY_FAILED_SHOWN = 3;
/** How many changed paths the summary carries for a tooltip. */
const AWAY_PATHS_SHOWN = 12;

/** The tools whose completion means a file on disk was written. */
const WRITERS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

export type AwayInput = {
  sessionId: string;
  since: number;
  until: number;
  /** Events in any order; only those inside the window are read. */
  events: readonly SessionEvent[];
  checkpoints: readonly SessionCheckpoint[];
  /** Summed reported cost inside the window, or null when the session reports none. */
  costDeltaUsd: number | null;
  verdict: Pick<Attention, 'kind' | 'label'> | null;
  recap: { text: string; at: number } | null;
};

export function buildAwaySummary(input: AwayInput): AwaySummary {
  const inWindow = (at: number) => at > input.since && at <= input.until;
  const events = input.events.filter((e) => inWindow(e.at)).sort((a, b) => a.at - b.at || a.id - b.id);

  const turnsCompleted = events.filter((e) => e.event === 'Stop').length;

  // Paths from completed writes are exact and nameable; checkpoints count
  // changes the hooks cannot see (a formatter a Bash call ran), but only as a
  // number. The hook set is preferred whenever it has anything, and the source
  // is said either way.
  const written = new Set<string>();
  for (const e of events) {
    if (e.event === 'PostToolUse' && e.ok !== false && e.toolName && WRITERS.has(e.toolName)) {
      for (const p of e.paths) written.add(p);
    }
  }
  const checkpointCount = input.checkpoints
    .filter((c) => inWindow(c.at) && c.status === 'ok' && typeof c.filesChanged === 'number')
    .reduce((n, c) => n + (c.filesChanged ?? 0), 0);
  const filesChanged: AwaySummary['filesChanged'] = written.size
    ? { count: written.size, paths: [...written].slice(0, AWAY_PATHS_SHOWN), source: 'hooks' }
    : checkpointCount
      ? { count: checkpointCount, paths: [], source: 'checkpoints' }
      : { count: 0, paths: [], source: 'none' };

  const failures = events.filter((e) =>
    (e.event === 'PostToolUseFailure' || (e.event === 'PostToolUse' && e.ok === false)) && e.toolName === 'Bash');
  const failedCommands = failures.slice(-AWAY_FAILED_SHOWN).reverse()
    .map((e) => ({ tool: e.toolName, summary: e.summary, at: e.at }));

  const recap = input.recap && inWindow(input.recap.at) ? input.recap : null;
  const cost = input.costDeltaUsd !== null && Number.isFinite(input.costDeltaUsd) ? input.costDeltaUsd : null;

  return {
    sessionId: input.sessionId,
    since: input.since,
    until: input.until,
    turnsCompleted,
    filesChanged,
    failedCommands,
    failedTotal: failures.length,
    costDeltaUsd: cost,
    verdict: input.verdict ? { kind: input.verdict.kind, label: input.verdict.label } : null,
    recap,
    nothingRecorded: events.length === 0 && filesChanged.count === 0 && !recap && !(cost && cost > 0),
  };
}

/**
 * The newest Claude recap in a transcript's text, or null.
 *
 * Claude Code writes `{"type":"system","subtype":"away_summary","content":…,
 * "timestamp":…}` when its terminal has been unfocused for a while (found in
 * the 2.1.271 binary and in real transcripts on this machine). Read line by
 * line from whatever tail the caller hands in; a line that is not JSON — the
 * first one of a tail cut mid-record — is skipped.
 */
export function recapFromTranscriptText(text: string, after: number): { text: string; at: number } | null {
  let best: { text: string; at: number } | null = null;
  for (const line of text.split('\n')) {
    if (!line.includes('away_summary')) continue;
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    if (r.type !== 'system' || r.subtype !== 'away_summary' || typeof r.content !== 'string') continue;
    const at = typeof r.timestamp === 'string' ? Date.parse(r.timestamp) : NaN;
    if (!Number.isFinite(at) || at <= after) continue;
    const flat = r.content.replace(/\s+/g, ' ').trim();
    if (!flat) continue;
    if (!best || at > best.at) best = { text: flat.length > 400 ? `${flat.slice(0, 399)}…` : flat, at };
  }
  return best;
}
