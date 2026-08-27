import { db, logEvent, newRunId } from '../db';
import { client, isMock, EXTENDED_OUTPUT_BETA, stripForbidden } from './anthropic';
import { buildRequests, type BuiltRequest } from './build';
import { loadSource } from './sources';
import type { RunConfig } from '../../shared/types';
import { mockCreate } from './mock';
import { spendCap } from '../settings';

export type SubmitResult = { runId: string; batchIds: string[]; requests: number };

export async function createAndSubmitRun(
  cfg: RunConfig,
  opts: { parentRunId?: string; estimate?: { input: number; output: number; cost: number } } = {}
): Promise<SubmitResult> {
  const ds = await loadSource(cfg.source);
  const built = buildRequests(cfg, ds.rows, ds.columns);
  if (built.errors.length) throw new Error(built.errors.join(' '));
  if (!built.requests.length) throw new Error('Nothing to submit — the dataset produced zero requests.');

  const cap = spendCap();
  const projected = opts.estimate?.cost ?? 0;
  if (cap > 0 && projected > cap) {
    throw new Error(
      `Estimated cost $${projected.toFixed(2)} exceeds your $${cap.toFixed(2)} per-run spend cap. ` +
      `A batch cannot be un-submitted, so this is blocked here. Raise the cap in Settings if this is intended.`
    );
  }

  const runId = newRunId();
  const now = Date.now();
  const d = db();

  d.prepare(`
    INSERT INTO runs (id, name, preset, project_id, model, status, config_json, total_requests,
                      est_input_tokens, est_output_tokens, est_cost_usd, parent_run_id, created_at)
    VALUES (@id,@name,@preset,@project,@model,'submitting',@config,@total,@ei,@eo,@ec,@parent,@created)
  `).run({
    id: runId, name: cfg.name, preset: cfg.preset ?? null, project: cfg.projectId ?? null, model: cfg.model,
    config: JSON.stringify(cfg), total: built.requests.length,
    ei: opts.estimate?.input ?? 0, eo: opts.estimate?.output ?? 0, ec: opts.estimate?.cost ?? 0,
    parent: opts.parentRunId ?? null, created: now,
  });

  const insertReq = d.prepare(`
    INSERT INTO requests (run_id, custom_id, row_index, row_json, rendered, status)
    VALUES (?,?,?,?,?,'pending')
  `);
  d.transaction((rs: BuiltRequest[]) => {
    for (const r of rs) insertReq.run(runId, r.custom_id, r.rowIndex, JSON.stringify(r.row), r.rendered);
  })(built.requests);

  for (const w of built.warnings) logEvent(runId, 'warn', w);
  if (ds.note) logEvent(runId, 'info', `Source: ${ds.note}`);
  logEvent(runId, 'info', `Built ${built.requests.length.toLocaleString()} requests across ${built.chunks.length} batch(es).`);

  const batchIds: string[] = [];
  try {
    for (let i = 0; i < built.chunks.length; i++) {
      const chunkReqs = built.chunks[i].map((r) => {
        const { params, stripped } = stripForbidden(r.params);
        if (stripped.length && i === 0) {
          logEvent(runId, 'warn', `Stripped params the Batches API rejects: ${stripped.join(', ')}`);
        }
        return { custom_id: r.custom_id, params };
      });

      const batch = isMock()
        ? mockCreate(chunkReqs)
        : cfg.extendedOutput
          ? await client().beta.messages.batches.create({ betas: [EXTENDED_OUTPUT_BETA], requests: chunkReqs as never })
          : await client().messages.batches.create({ requests: chunkReqs as never });

      d.prepare(`
        INSERT INTO batches (id, run_id, chunk_index, processing_status, request_count,
                             counts_json, created_at, expires_at)
        VALUES (?,?,?,?,?,?,?,?)
      `).run(
        batch.id, runId, i, batch.processing_status, chunkReqs.length,
        JSON.stringify(batch.request_counts),
        Date.parse(batch.created_at as string) || now,
        Date.parse(batch.expires_at as string) || now + 24 * 3600_000
      );

      d.prepare('UPDATE requests SET batch_id = ? WHERE run_id = ? AND custom_id IN (' +
        chunkReqs.map(() => '?').join(',') + ')')
        .run(batch.id, runId, ...chunkReqs.map((r) => r.custom_id));

      batchIds.push(batch.id);
      logEvent(runId, 'info', `Submitted batch ${batch.id} (${chunkReqs.length.toLocaleString()} requests).`);
    }

    d.prepare("UPDATE runs SET status='in_progress', submitted_at=? WHERE id=?").run(Date.now(), runId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    d.prepare("UPDATE runs SET status='failed', error=? WHERE id=?").run(msg, runId);
    logEvent(runId, 'error', `Submission failed: ${msg}`);
    throw e;
  }

  return { runId, batchIds, requests: built.requests.length };
}

/**
 * Dead-letter retry: take every non-succeeded request from a finished run and
 * resubmit just those rows as a new child run, preserving the original config.
 */
export async function retryFailed(parentRunId: string): Promise<SubmitResult> {
  const d = db();
  const parent = d.prepare('SELECT * FROM runs WHERE id = ?').get(parentRunId) as { config_json: string; name: string } | undefined;
  if (!parent) throw new Error(`Run ${parentRunId} not found.`);

  const failed = d.prepare(
    "SELECT row_json FROM requests WHERE run_id = ? AND status IN ('errored','expired','canceled','pending')"
  ).all(parentRunId) as { row_json: string }[];
  if (!failed.length) throw new Error('No failed, expired or unsent requests to retry.');

  const cfg = JSON.parse(parent.config_json) as RunConfig;
  const rows = failed.map((r) => JSON.parse(r.row_json));

  const retryCfg: RunConfig = {
    ...cfg,
    name: `${parent.name} — retry`,
    source: { kind: 'jsonl', text: rows.map((r) => JSON.stringify(r)).join('\n') },
  };
  return createAndSubmitRun(retryCfg, { parentRunId });
}
