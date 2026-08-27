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

export function deleteRun(id: string) {
  const run = db().prepare('SELECT status FROM runs WHERE id = ?').get(id) as { status: string } | undefined;
  if (!run) throw new Error(`Run ${id} not found.`);
  if (run.status === 'in_progress' || run.status === 'submitting') {
    throw new Error('Cancel the run before deleting it — deleting locally would not stop the batch or its spend.');
  }
  db().prepare('DELETE FROM runs WHERE id = ?').run(id);
}

export { createAndSubmitRun, retryFailed, pollOnce, cancelRun };
