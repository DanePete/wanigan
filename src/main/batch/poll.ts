import { db, logEvent } from '../db';
import { client, isMock } from './anthropic';
import { ingestResults, rollUp } from './results';
import { mockRetrieve } from './mock';
import { pollIntervalFor, RESULTS_TTL_MS } from '../notify';
import type { BatchRow, CacheTtl, Counts } from '../../shared/types';

/**
 * Backoff lives in notify.ts (phase 14), which keys off quiet time rather than
 * age and tightens again inside the last half hour before the 24-hour expiry —
 * precisely when the difference between 'ended' and 'expired' is decided.
 * MAX_INTERVAL is kept only for the error path, where there is no fresh
 * batch record to schedule from.
 */
const MAX_INTERVAL = 120_000;

/**
 * Stamped into results_ingested_at for the duration of a download so a second
 * poller cannot start a second one onto the same archive file. Negative rather
 * than a plausible timestamp on purpose: every query that asks "has this been
 * ingested?" treats it as *not* ingested, so a process that dies mid-ingest
 * leaves the batch openly unfinished instead of sealed with a truncated
 * results/<id>.jsonl that notify.ts would count as a good local copy.
 */
const INGEST_IN_FLIGHT = -1;

/** SQL predicate for "this batch still has results owed to it". */
const NOT_INGESTED = '(b.results_ingested_at IS NULL OR b.results_ingested_at < 0)';

export type PollSummary = { polled: number; ended: number; ingested: number };

/**
 * pollOnce is called from four places with nothing between them — the 10s timer,
 * the batch:poll IPC handler, the fire-and-forget call right after submit, and
 * the MCP server. Two overlapping calls would both see the same ended batch as
 * un-ingested and open two write streams onto results/<batchId>.jsonl, leaving
 * an interleaved, unparseable archive that still looks complete by file size.
 * Overlapping callers share the run that is already in flight.
 */
let inFlight: Promise<PollSummary> | null = null;

export function pollOnce(): Promise<PollSummary> {
  if (inFlight) return inFlight;
  inFlight = runPoll().finally(() => { inFlight = null; });
  return inFlight;
}

async function runPoll(): Promise<PollSummary> {
  const d = db();
  const now = Date.now();

  const open = d.prepare(`
    SELECT b.* FROM batches b
    JOIN runs r ON r.id = b.run_id
    WHERE b.processing_status != 'ended' OR ${NOT_INGESTED}
  `).all() as BatchRow[];

  const due = open.filter((b) => !b.last_polled_at || now - b.last_polled_at >= b.poll_interval_ms);
  let ended = 0, ingested = 0;

  for (const b of due) {
    try {
      const remote = isMock()
        ? mockRetrieve(b.id)
        : await client().messages.batches.retrieve(b.id);

      const counts = remote.request_counts as Counts;
      const changed = remote.processing_status !== b.processing_status ||
        JSON.stringify(counts) !== b.counts_json;

      d.prepare(`
        UPDATE batches SET processing_status=?, counts_json=?, results_url=?,
          ended_at=?, cancel_initiated_at=?, last_polled_at=?, poll_interval_ms=?
        WHERE id=?
      `).run(
        remote.processing_status,
        JSON.stringify(counts),
        (remote as { results_url?: string | null }).results_url ?? null,
        remote.ended_at ? Date.parse(remote.ended_at as string) : null,
        remote.cancel_initiated_at ? Date.parse(remote.cancel_initiated_at as string) : null,
        now,
        pollIntervalFor(b.created_at, changed ? now : b.last_polled_at, now),
        b.id
      );

      if (remote.processing_status === 'ended' && notIngested(b)) {
        // `b` is a snapshot taken before the first await, so it cannot be trusted
        // to still be true here. Claim the batch in the database instead: whoever
        // wins the conditional UPDATE downloads, everyone else skips.
        const claimed = d.prepare(
          'UPDATE batches SET results_ingested_at=? WHERE id=? AND (results_ingested_at IS NULL OR results_ingested_at < 0)'
        ).run(INGEST_IN_FLIGHT, b.id);
        if (claimed.changes === 1) {
          ended++;
          const run = d.prepare('SELECT model FROM runs WHERE id = ?').get(b.run_id) as { model: string };
          try {
            const res = await ingestResults(b.run_id, b.id, run.model);
            ingested += res.ingested;
          } catch (e) {
            // Release the claim, or a download that dies halfway would leave the
            // batch marked ingested and its half-written archive unreachable.
            d.prepare('UPDATE batches SET results_ingested_at=NULL WHERE id=? AND results_ingested_at=?')
              .run(b.id, INGEST_IN_FLIGHT);
            throw e;
          }
          finalizeIfComplete(b.run_id);
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logEvent(b.run_id, 'error', `Poll failed for ${b.id}: ${msg}`);
      d.prepare('UPDATE batches SET last_polled_at=?, poll_interval_ms=? WHERE id=?')
        .run(now, Math.min(MAX_INTERVAL, Math.round(b.poll_interval_ms * 2)), b.id);
    }
  }

  expireStale();
  return { polled: due.length, ended, ingested };
}

function notIngested(b: BatchRow): boolean {
  return b.results_ingested_at === null || b.results_ingested_at < 0;
}

/** A run is done when every one of its batches has ended and been ingested. */
function finalizeIfComplete(runId: string) {
  const d = db();
  const pending = d.prepare(
    `SELECT COUNT(*) n FROM batches b WHERE b.run_id=? AND (b.processing_status!='ended' OR ${NOT_INGESTED})`
  ).get(runId) as { n: number };
  if (pending.n > 0) return;

  const run = d.prepare('SELECT model, config_json FROM runs WHERE id=?')
    .get(runId) as { model: string; config_json: string };
  rollUp(runId, run.model, cacheTtlOf(run.config_json));
  d.prepare("UPDATE runs SET status='ended', ended_at=? WHERE id=?").run(Date.now(), runId);

  const c = d.prepare(`
    SELECT status, COUNT(*) n FROM requests WHERE run_id=? GROUP BY status
  `).all(runId) as { status: string; n: number }[];
  logEvent(runId, 'info', 'Run complete — ' + c.map((x) => `${x.n} ${x.status}`).join(', '));
}

/**
 * A 1-hour cache write costs 2.0x the base input rate, a 5-minute one 1.25x.
 * costOf defaults to the 5-minute multiplier when it is not told the TTL, so a
 * 1h run finalized without this reports a cache-write line 37.5% under what was
 * actually billed — and disagrees with the figure evals.ts prices the same rows
 * at, with neither screen labelled an estimate.
 */
function cacheTtlOf(configJson: string): CacheTtl | undefined {
  try {
    const cfg = JSON.parse(configJson) as { cacheTtl?: unknown };
    return cfg.cacheTtl === '1h' || cfg.cacheTtl === '5m' ? cfg.cacheTtl : undefined;
  } catch {
    // A config we cannot parse is not a reason to abandon the roll-up; the cost
    // just falls back to the 5-minute multiplier, as it did before.
    return undefined;
  }
}

/**
 * Batches stop accepting work 24h after creation, but the API holds whatever
 * they finished for 29 days. So a batch past its window is *not* sealed here:
 * it is marked 'expired', which keeps it matching the `open` query above so
 * later ticks keep trying retrieve + ingest.
 *
 * This used to stamp results_ingested_at and flip every pending request to
 * 'expired' outright. One failed poll across the 24-hour boundary — a 429, a
 * sleeping laptop — was then enough to put a batch's 4,800 succeeded rows
 * permanently out of reach of the only code path that can download them, while
 * Retry resubmitted and re-paid for rows the API had already answered and
 * billed. Only the downloaded results say which custom_ids really expired.
 */
function expireStale() {
  const d = db();
  const now = Date.now();
  const stale = d.prepare(
    "SELECT * FROM batches WHERE processing_status NOT IN ('ended','expired') AND expires_at IS NOT NULL AND expires_at < ?"
  ).all(now - 60_000) as BatchRow[];

  for (const b of stale) {
    d.prepare("UPDATE batches SET processing_status='expired', ended_at=COALESCE(ended_at,?) WHERE id=?")
      .run(now, b.id);
    const until = new Date(b.created_at + RESULTS_TTL_MS).toISOString().slice(0, 10);
    logEvent(b.run_id, 'warn',
      `Batch ${b.id} passed its 24-hour window without a successful poll. Whatever it finished stays downloadable until ${until}; ` +
      `polling continues until the results are fetched, so do not retry this run yet — you would pay twice for rows already answered.`);
  }

  abandonUnfetchable();
}

/**
 * The 29-day results window is the deadline that actually costs something. Past
 * it the API has nothing left to hand over, so a batch never downloaded is
 * genuinely lost and its rows belong in the dead-letter queue rather than
 * sitting as 'pending' forever. This is the one place a request is marked
 * expired without a result line saying so, and it is logged as an error so the
 * loss is visible rather than inferred from a count.
 */
function abandonUnfetchable() {
  const d = db();
  const now = Date.now();
  // Any batch older than the window with nothing on disk, not just the ones
  // expireStale() marked: an ended batch whose download has failed every tick
  // for 29 days is just as lost, and would otherwise be polled forever.
  const lost = d.prepare(
    `SELECT * FROM batches b WHERE b.created_at < ? AND ${NOT_INGESTED}`
  ).all(now - RESULTS_TTL_MS) as BatchRow[];

  for (const b of lost) {
    const marked = d.prepare("UPDATE requests SET status='expired' WHERE run_id=? AND batch_id=? AND status='pending'")
      .run(b.run_id, b.id);
    d.prepare("UPDATE batches SET processing_status='ended', ended_at=COALESCE(ended_at,?), results_ingested_at=? WHERE id=?")
      .run(now, now, b.id);
    logEvent(b.run_id, 'error',
      `Batch ${b.id} was never downloaded and its results are now past the 29-day window — ${marked.changes} request(s) marked expired. ` +
      `They are gone from the API; Retry will resubmit and re-pay for them.`);
    finalizeIfComplete(b.run_id);
  }
}

export async function cancelRun(runId: string) {
  const d = db();
  const batches = d.prepare("SELECT id FROM batches WHERE run_id=? AND processing_status='in_progress'")
    .all(runId) as { id: string }[];
  for (const b of batches) {
    if (isMock()) { const { mockCancel } = await import('./mock'); mockCancel(b.id); }
    else await client().messages.batches.cancel(b.id);
    logEvent(runId, 'warn', `Cancellation requested for ${b.id}.`);
  }
  d.prepare("UPDATE runs SET status='canceling' WHERE id=?").run(runId);
  return { canceling: batches.length };
}
