import { db, logEvent, newRunId } from '../db';
import { client, isMock, EXTENDED_OUTPUT_BETA, stripForbidden } from './anthropic';
import { buildRequests, type BuiltRequest } from './build';
import { estimate } from './estimate';
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

  /* ── the money gate ──────────────────────────────────────────────────
     A missing estimate used to read as $0, so `projected > cap` could never
     fire for any caller that had not priced its own run first. That is not a
     theoretical hole: retryFailed and anything the queue dispatches — a
     schedule firing at 03:00 with nobody at the machine — both arrive here
     with no estimate, on the one operation this file says cannot be undone.
     A number nobody worked out must never mean "free".

     There is no "unattended" flag to key off, because a caller that wanted to
     skip the cap would simply not set it. So the cap holds for every path: if
     it is armed and nobody handed us a price, we work one out before anything
     leaves the machine.

     Priced from `built.requests` rather than by re-reading the source, which
     matters for a glob or a command: those re-read the world, so a second read
     can return a different — larger — dataset than the one about to be sent,
     and the cap would then have passed on rows nobody submitted. This prices
     exactly the array that becomes the batches below.
     ──────────────────────────────────────────────────────────────────── */
  const cap = spendCap();
  let est = opts.estimate;
  let pricedHere = false;
  // Price here whenever the cap is armed, even when a caller supplied a figure.
  // The estimate can arrive from the renderer, which this process does not
  // trust to have chosen the ceiling — and a gate that accepts the number it
  // is gating is not a gate. The higher of the two is what gets tested.
  if (cap > 0) {
    let priced: Awaited<ReturnType<typeof estimate>>;
    try {
      priced = await estimate(cfg, built.requests);
    } catch (e) {
      if (est) throw new Error(
        `This run could not be re-priced to check your $${cap.toFixed(2)} per-run spend cap: ` +
        `${e instanceof Error ? e.message : String(e)} Nothing was submitted.`
      );
      throw new Error(
        `This run could not be priced, so your $${cap.toFixed(2)} per-run spend cap cannot be checked against it: ` +
        `${e instanceof Error ? e.message : String(e)} Nothing was submitted. Estimate the run in Batches to see ` +
        `what is wrong, or set the cap to 0 in Settings if you accept submitting without a price.`
      );
    }
    // An unrecognised model has no published rate, so the figure above is a
    // stand-in borrowed from another model. Checking a spend cap against it
    // would gate the run on a number nobody can stand behind as its price.
    if (priced.unpricedModel) {
      throw new Error(
        `Wanigan has no published price for ${priced.unpricedModel}, so your $${cap.toFixed(2)} per-run spend cap ` +
        `cannot be checked against this run. Nothing was submitted. Pick a model with known rates, or set the cap ` +
        `to 0 in Settings if you accept submitting without a price.`
      );
    }
    // The ceiling, not the optimistic band — the same number the MCP path asks
    // a human to approve. A run that only fits under the cap if every response
    // comes back short has not been shown to fit under the cap.
    const local = { input: priced.totalInputTokens, output: priced.worstCaseOutputTokens, cost: priced.costHighUsd };
    if (!est) { est = local; pricedHere = true; }
    else if (local.cost > est.cost) { est = { ...est, cost: local.cost }; pricedHere = true; }
  }

  const projected = est?.cost ?? 0;
  if (cap > 0 && projected > cap) {
    throw new Error(
      `Estimated cost $${projected.toFixed(2)} exceeds your $${cap.toFixed(2)} per-run spend cap. ` +
      (pricedHere ? 'Nothing had priced this run, so it was priced here before anything was sent. ' : '') +
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
    // Whatever the cap was checked against is what the run records, so the
    // estimate-versus-actual columns describe the same number that gated it.
    ei: est?.input ?? 0, eo: est?.output ?? 0, ec: est?.cost ?? 0,
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
  // A run that priced itself came from a queue or a retry, not from the
  // estimate screen — without this line there is no record anywhere of the
  // number the cap was actually checked against.
  if (pricedHere && est) {
    logEvent(runId, 'info',
      `Nobody had priced this run, so it was priced here before submitting: ceiling $${est.cost.toFixed(2)} ` +
      `against a $${cap.toFixed(2)} per-run spend cap.`);
  }

  /* ── the beta flags the create call must carry ───────────────────────
     build.ts decides these, because it is what knows whether any row ended up
     referencing an uploaded file by id. Branching on cfg.extendedOutput alone
     dropped the files beta on the floor, and a batch created without it does
     not fail fast: every uploaded row is accepted, billed, and reported as
     failed when the batch ends a day later.

     Unioned rather than chosen between — a run can want extended output *and*
     carry attachments, and one create call takes both.
     ──────────────────────────────────────────────────────────────────── */
  const betas = [...new Set([...built.betas, ...(cfg.extendedOutput ? [EXTENDED_OUTPUT_BETA] : [])])];
  if (betas.length) logEvent(runId, 'info', `Batches created with beta flag(s): ${betas.join(', ')}.`);

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
        : betas.length
          ? await client().beta.messages.batches.create({ betas, requests: chunkReqs as never })
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

      linkRequestsToBatch(runId, batch.id, chunkReqs.map((r) => r.custom_id));

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
 * Ceiling on how many custom_ids one UPDATE may name.
 *
 * SQLite refuses a statement with more than 32,766 host parameters, and a chunk
 * is allowed 100,000 requests — so the single statement this replaces threw
 * "too many SQL variables" on any batch over ~32,764 rows. It threw *after* the
 * create call: the batch was accepted, is billing, and expires in 24 hours,
 * while its rows carry no batch_id and nothing can poll or ingest them. There
 * is no size of slice worth optimising here; there is only a size that cannot
 * hit the cap.
 */
const LINK_SLICE = 500;

function linkRequestsToBatch(runId: string, batchId: string, customIds: string[]): void {
  const d = db();
  const stmtFor = (n: number) => d.prepare(
    `UPDATE requests SET batch_id = ? WHERE run_id = ? AND custom_id IN (${Array(n).fill('?').join(',')})`
  );
  const fullSlice = customIds.length >= LINK_SLICE ? stmtFor(LINK_SLICE) : null;

  d.transaction(() => {
    for (let i = 0; i < customIds.length; i += LINK_SLICE) {
      const slice = customIds.slice(i, i + LINK_SLICE);
      const stmt = slice.length === LINK_SLICE && fullSlice ? fullSlice : stmtFor(slice.length);
      stmt.run(batchId, runId, ...slice);
    }
  })();
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
