import { db } from '../db';
import { loadSource } from './sources';
import { buildRequests } from './build';
import { estimate, dryRun } from './estimate';
import { createAndSubmitRun, retryFailed } from './submit';
import { pollOnce, cancelRun } from './poll';
import { render, slotsIn, missingSlots } from './template';
import { PRESETS } from './presets';
import { cachedModels, refreshModels } from './models';
import { MODELS, DEFAULT_MODEL } from './pricing';
import { isMock } from './anthropic';
import { projectById } from '../store';
import type { RunConfig, RunRow, SourceConfig } from '../../shared/types';

/**
 * Presets carry a {{PROJECT_PATH}} placeholder rather than a hardcoded path, so
 * picking a project in the UI is what makes a preset concrete.
 */
export function presetsFor(projectId?: string) {
  const project = projectId ? projectById(projectId) : undefined;
  const root = project?.path ?? '';
  const json = JSON.stringify(PRESETS).split('{{PROJECT_PATH}}').join(root);
  const cat = cachedModels();
  return {
    presets: JSON.parse(json),
    models: cat.models,
    modelsFetchedAt: cat.fetchedAt,
    modelsStale: cat.stale,
    defaultModel: DEFAULT_MODEL,
    mock: isMock(),
  };
}

export { refreshModels };

/** Aggregates for the Insights view — computed in SQL, not in the renderer. */
export function insights() {
  const d = db();
  const perRun = d.prepare(`
    SELECT r.id, r.name, r.model, r.status, r.created_at, r.ended_at, r.submitted_at,
           r.cost_usd, r.in_tokens, r.out_tokens, r.cache_read, r.cache_write,
           r.total_requests,
           (SELECT COUNT(*) FROM requests q WHERE q.run_id=r.id AND q.status='succeeded') succeeded,
           (SELECT COUNT(*) FROM requests q WHERE q.run_id=r.id AND q.status='errored')   errored,
           (SELECT COUNT(*) FROM requests q WHERE q.run_id=r.id AND q.status='expired')   expired,
           (SELECT COUNT(*) FROM requests q WHERE q.run_id=r.id AND q.status='refused')   refused,
           (SELECT COUNT(*) FROM requests q WHERE q.run_id=r.id AND q.status='canceled')  canceled
    FROM runs r WHERE r.submitted_at IS NOT NULL ORDER BY r.created_at
  `).all() as Record<string, number | string>[];

  const byModel = d.prepare(`
    SELECT model,
           COUNT(*) runs,
           COALESCE(SUM(cost_usd),0)   cost,
           COALESCE(SUM(in_tokens),0)  in_tokens,
           COALESCE(SUM(out_tokens),0) out_tokens,
           COALESCE(SUM(cache_read),0) cache_read,
           COALESCE(SUM(cache_write),0) cache_write,
           COALESCE(SUM(total_requests),0) requests
    FROM runs WHERE submitted_at IS NOT NULL GROUP BY model ORDER BY cost DESC
  `).all() as Record<string, number | string>[];

  const totals = d.prepare(`
    SELECT COALESCE(SUM(cost_usd),0) cost, COALESCE(SUM(in_tokens),0) in_tokens,
           COALESCE(SUM(out_tokens),0) out_tokens, COALESCE(SUM(cache_read),0) cache_read,
           COALESCE(SUM(cache_write),0) cache_write, COALESCE(SUM(total_requests),0) requests,
           COUNT(*) runs
    FROM runs WHERE submitted_at IS NOT NULL
  `).get() as Record<string, number>;

  const outcomes = d.prepare(`
    SELECT status, COUNT(*) n FROM requests GROUP BY status
  `).all() as { status: string; n: number }[];

  return { perRun, byModel, totals, outcomes };
}

export async function previewSource(source: SourceConfig, userTemplate = '') {
  const ds = await loadSource(source);
  const rows = ds.rows.slice(0, 25);
  return {
    columns: ds.columns,
    rowCount: ds.rows.length,
    note: ds.note,
    rows,
    slots: slotsIn(userTemplate),
    missingSlots: missingSlots(userTemplate, ds.columns),
    rendered: rows.slice(0, 3).map((r) => render(userTemplate, r)),
  };
}

export async function estimateRun(config: RunConfig, observedOutputTokens?: number) {
  const ds = await loadSource(config.source);
  const built = buildRequests(config, ds.rows, ds.columns);
  if (!built.requests.length) {
    return { estimate: null, warnings: built.warnings, errors: built.errors.length ? built.errors : ['Dataset produced zero requests.'] };
  }
  const est = await estimate(config, built.requests, observedOutputTokens);
  return { estimate: est, warnings: built.warnings, errors: built.errors, chunks: built.chunks.length };
}

export async function dryRunOne(config: RunConfig, rowIndex = 0) {
  const ds = await loadSource(config.source);
  const built = buildRequests(config, ds.rows, ds.columns);
  if (built.errors.length) return { result: null, errors: built.errors };
  const target = built.requests[rowIndex] ?? built.requests[0];
  if (!target) throw new Error('Dataset is empty.');
  return { result: await dryRun(config, target), rowIndex: target.rowIndex, prompt: target.rendered, errors: [] };
}

export function listRuns() {
  return db().prepare(`
    SELECT r.*,
      (SELECT COUNT(*) FROM requests q WHERE q.run_id = r.id AND q.status = 'succeeded') succeeded,
      (SELECT COUNT(*) FROM requests q WHERE q.run_id = r.id AND q.status IN ('errored','expired','canceled','refused')) failed,
      (SELECT COUNT(*) FROM requests q WHERE q.run_id = r.id AND q.status = 'pending') pending,
      (SELECT MIN(expires_at) FROM batches b WHERE b.run_id = r.id AND b.processing_status != 'ended') expires_at,
      (SELECT name FROM projects p WHERE p.id = r.project_id) project_name
    FROM runs r ORDER BY r.created_at DESC LIMIT 200
  `).all();
}

/**
 * The statuses in which a run's remote work may still be spending: submitted
 * and not yet finished, or cancelled locally and not yet stopped remotely.
 * deleteRun() refuses these and runsInFlight() counts them, off one list so
 * the two cannot drift apart. (Batches.tsx repeats the same three strings for
 * its "Active" tile; it is counting this same set.)
 */
const IN_FLIGHT = ['in_progress', 'submitting', 'canceling'] as const;

/**
 * What the sidebar's Batches badge prints, and what its bar advances on.
 *
 * `runs` counts runs — not requests, not results, not messages. The badge is a
 * bare integer beside a word, which is read as "things waiting for me", so the
 * field, the function and the tooltip all have to be the same noun. It counts
 * every run the Batches screen lists, batch and headless and eval alike,
 * because listRuns() and the "Active" tile the badge points at are not scoped
 * by kind either: a badge reading 1 beside a tile reading 2 would be a worse
 * lie than a badge whose noun is one word too broad. Narrowing the badge and
 * narrowing that screen have to happen together, and this is not that change.
 */
export type RunsInFlight = {
  /**
   * Epoch ms of the read that produced these counts. It is on the wire so a
   * caller that keeps only the integers can still tell an observed zero from a
   * read that has not happened yet. It is not a freshness clock: a caller that
   * holds its previous value while the counts are unchanged is holding an
   * older readAt with it, deliberately.
   */
  readAt: number;
  /** Runs whose remote work may still be spending. The badge's integer. */
  runs: number;
  /** Requests in those runs that have come back, succeeded or failed. */
  requestsReturned: number;
  /** Requests in those runs the API has not answered yet. */
  requestsOutstanding: number;
};

/**
 * The badge's own read: one row of three integers, for a poll that fires every
 * six seconds from whichever view is open.
 *
 * It exists because the shell used to answer this out of listRuns() — 200 whole
 * `runs` rows, `config_json` and all, plus a thousand correlated counts and a
 * per-run expiry subquery — to render one integer and one progress bar. The
 * counts here are the same counts, over the same statuses, so nothing on screen
 * moves; only the read shrinks. `runs` still has no index on `status` (db.ts
 * indexes created_at, project_id and (kind, created_at)), so this remains a
 * scan of `runs` — the saving is the row payload and the discarded subqueries,
 * not a seek, and on a fresh install with no runs it costs nothing either way.
 */
export function runsInFlight(): RunsInFlight {
  const statuses: string[] = [...IN_FLIGHT];
  const row = db().prepare(`
    SELECT COUNT(*) runs,
      COALESCE(SUM((SELECT COUNT(*) FROM requests q WHERE q.run_id = r.id
                      AND q.status IN ('succeeded','errored','expired','canceled','refused'))), 0) returned,
      COALESCE(SUM((SELECT COUNT(*) FROM requests q WHERE q.run_id = r.id
                      AND q.status = 'pending')), 0) outstanding
    FROM runs r WHERE r.status IN (${statuses.map(() => '?').join(',')})
  `).get(...statuses) as { runs: number; returned: number; outstanding: number };
  return {
    readAt: Date.now(),
    runs: row.runs,
    requestsReturned: row.returned,
    requestsOutstanding: row.outstanding,
  };
}

export function runDetail(id: string) {
  const d = db();
  const run = d.prepare('SELECT * FROM runs WHERE id = ?').get(id) as
    (RunRow & { project_id: string | null }) | undefined;
  if (!run) throw new Error(`Run ${id} not found.`);
  return {
    run,
    batches: d.prepare('SELECT * FROM batches WHERE run_id = ? ORDER BY chunk_index').all(id),
    counts: Object.fromEntries(
      (d.prepare('SELECT status, COUNT(*) n FROM requests WHERE run_id = ? GROUP BY status').all(id) as { status: string; n: number }[])
        .map((c) => [c.status, c.n])
    ),
    events: d.prepare('SELECT at, level, message FROM events WHERE run_id = ? ORDER BY at DESC LIMIT 100').all(id),
    children: d.prepare('SELECT id, name, status FROM runs WHERE parent_run_id = ? ORDER BY created_at').all(id),
    config: JSON.parse(run.config_json),
  };
}

export function runResults(id: string, status = 'all', q = '', offset = 0, pageSize = 50) {
  const where = ['run_id = ?'];
  const args: unknown[] = [id];
  if (status === 'failed') where.push("status IN ('errored','expired','canceled','refused')");
  else if (status !== 'all') { where.push('status = ?'); args.push(status); }
  if (q) {
    where.push('(custom_id LIKE ? OR rendered LIKE ? OR output_text LIKE ? OR error_message LIKE ?)');
    const like = `%${q}%`;
    args.push(like, like, like, like);
  }
  const clause = where.join(' AND ');
  const total = (db().prepare(`SELECT COUNT(*) n FROM requests WHERE ${clause}`).get(...args) as { n: number }).n;
  const rows = db().prepare(`
    SELECT custom_id, batch_id, row_index, row_json, rendered, status, output_text,
           stop_reason, error_type, error_message, in_tokens, out_tokens, cache_read, cache_write
    FROM requests WHERE ${clause} ORDER BY row_index LIMIT ? OFFSET ?
  `).all(...args, pageSize, offset);
  return { rows, total, offset, pageSize };
}

/**
 * Statuses where the remote batch may still be spending. Deleting the local row
 * does not reach the API, so it would drop the only record of a run that is
 * still costing money.
 *
 * 'canceling' belongs here and was missing: cancelRun sets it while the remote
 * batches wind down, so a run in that state is exactly the case the error
 * sentence below describes — cancelled locally, not yet stopped remotely.
 */
const UNDELETABLE = new Set<string>(IN_FLIGHT);

export function deleteRun(id: string) {
  const run = db().prepare('SELECT status FROM runs WHERE id = ?').get(id) as { status: string } | undefined;
  if (!run) throw new Error(`Run ${id} not found.`);
  if (UNDELETABLE.has(run.status)) {
    throw new Error('Cancel the run and let it finish stopping before deleting it — deleting locally would not stop the batch or its spend.');
  }
  db().prepare('DELETE FROM runs WHERE id = ?').run(id);
}

export { createAndSubmitRun, retryFailed, pollOnce, cancelRun };
