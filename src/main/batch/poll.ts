import { db, logEvent } from '../db';
import { client, isMock } from './anthropic';
import { ingestResults, rollUp } from './results';
import { mockRetrieve } from './mock';
import type { BatchRow, Counts } from '../../shared/types';

/** Backoff: quick at first, then relax. Most batches land well inside an hour. */
const MIN_INTERVAL = 10_000;
const MAX_INTERVAL = 120_000;

export type PollSummary = { polled: number; ended: number; ingested: number };

export async function pollOnce(): Promise<PollSummary> {
  const d = db();
  const now = Date.now();

  const open = d.prepare(`
    SELECT b.* FROM batches b
    JOIN runs r ON r.id = b.run_id
    WHERE b.processing_status != 'ended' OR b.results_ingested_at IS NULL
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
        // Reset backoff whenever something moved; otherwise widen it.
        changed ? MIN_INTERVAL : Math.min(MAX_INTERVAL, Math.round(b.poll_interval_ms * 1.6)),
        b.id
      );

      if (remote.processing_status === 'ended' && !b.results_ingested_at) {
        ended++;
        const run = d.prepare('SELECT model FROM runs WHERE id = ?').get(b.run_id) as { model: string };
        const res = await ingestResults(b.run_id, b.id, run.model);
        ingested += res.ingested;
        finalizeIfComplete(b.run_id);
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

/** A run is done when every one of its batches has ended and been ingested. */
function finalizeIfComplete(runId: string) {
  const d = db();
  const pending = d.prepare(
    "SELECT COUNT(*) n FROM batches WHERE run_id=? AND (processing_status!='ended' OR results_ingested_at IS NULL)"
  ).get(runId) as { n: number };
  if (pending.n > 0) return;

  const run = d.prepare('SELECT model FROM runs WHERE id=?').get(runId) as { model: string };
  rollUp(runId, run.model);
  d.prepare("UPDATE runs SET status='ended', ended_at=? WHERE id=?").run(Date.now(), runId);

  const c = d.prepare(`
    SELECT status, COUNT(*) n FROM requests WHERE run_id=? GROUP BY status
  `).all(runId) as { status: string; n: number }[];
  logEvent(runId, 'info', 'Run complete — ' + c.map((x) => `${x.n} ${x.status}`).join(', '));
}

/**
 * Batches expire 24h after creation. If the API stops reporting one, mark its
 * still-pending requests expired so they land in the dead-letter queue rather
 * than sitting as 'pending' forever.
 */
function expireStale() {
  const d = db();
  const now = Date.now();
  const stale = d.prepare(
    "SELECT * FROM batches WHERE processing_status != 'ended' AND expires_at IS NOT NULL AND expires_at < ?"
  ).all(now - 60_000) as BatchRow[];

  for (const b of stale) {
    d.prepare("UPDATE requests SET status='expired' WHERE run_id=? AND batch_id=? AND status='pending'")
      .run(b.run_id, b.id);
    d.prepare("UPDATE batches SET processing_status='ended', ended_at=?, results_ingested_at=? WHERE id=?")
      .run(now, now, b.id);
    logEvent(b.run_id, 'warn', `Batch ${b.id} passed its 24-hour expiry — remaining requests marked expired.`);
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
