import { db, logEvent } from '../db';
import { loadSource } from './sources';
import { buildRequests, type BuiltRequest } from './build';
import { estimate } from './estimate';
import { createAndSubmitRun } from './submit';
import { rollUp } from './results';
import { explainApiError } from './anthropic';
import { MODELS, modelFor } from './pricing';
import { modelInfo } from './models';
import type { ModelInfo, RunConfig } from '../../shared/types';

/**
 * The refusal lane.
 *
 * `fallbacks` — the server-side parameter that re-runs a refused request on a
 * second model — is rejected by the Batches API, so a batch that trips a safety
 * classifier just ends with rows nobody answered. Wanigan already gives those
 * rows their own outcome (results.ts turns stop_reason "refusal" into status
 * 'refused' rather than an empty success), which makes it the only component
 * that can do the rescue itself: pull exactly the refused rows out, re-run them
 * as a child run on another model, and fold the answers back onto the parent.
 */

/**
 * Carried inside each rescued row so the child's answers can be keyed back onto
 * the parent. The child is built from a rewritten jsonl source, so its
 * custom_ids are renumbered from zero — parent row `r7-acme` becomes child row
 * `r0-acme`. Merging on position, or on the child's own id, would write an
 * answer onto the wrong row the moment the refused rows are not the first rows.
 */
export const RESCUE_KEY_COLUMN = '__rescueOf';

/** Marker on the child's config: parent_run_id alone cannot tell a rescue from a dead-letter retry. */
type RescueMark = { parentRunId: string; fromModel: string };
type RescueConfig = RunConfig & { rescueOf?: RescueMark };

/** results.ts writes `refusal:<category>`, using this when the API named none. */
const UNSPECIFIED = 'unspecified';

export type RefusedRow = {
  customId: string;
  rowIndex: number;
  row: unknown;
  category: string | null;
  explanation: string | null;
};

export function refusedRows(runId: string): RefusedRow[] {
  const rows = db().prepare(`
    SELECT custom_id, row_index, row_json, error_type, error_message
    FROM requests WHERE run_id = ? AND status = 'refused' ORDER BY row_index
  `).all(runId) as {
    custom_id: string; row_index: number; row_json: string;
    error_type: string | null; error_message: string | null;
  }[];

  return rows.map((r) => ({
    customId: r.custom_id,
    rowIndex: r.row_index,
    row: parseRow(r.row_json),
    category: categoryOf(r.error_type),
    explanation: r.error_message,
  }));
}

export function refusalSummary(runId: string): { total: number; byCategory: { category: string; n: number }[] } {
  const rows = db().prepare(`
    SELECT error_type, COUNT(*) n FROM requests
    WHERE run_id = ? AND status = 'refused' GROUP BY error_type
  `).all(runId) as { error_type: string | null; n: number }[];

  const tally = new Map<string, number>();
  for (const r of rows) {
    // A bucket still needs a label to be drawn, so the null category gets the
    // word back here rather than being dropped out of the summary.
    const key = categoryOf(r.error_type) ?? UNSPECIFIED;
    tally.set(key, (tally.get(key) ?? 0) + r.n);
  }

  const byCategory = [...tally]
    .map(([category, n]) => ({ category, n }))
    .sort((a, b) => b.n - a.n || a.category.localeCompare(b.category));

  return { total: byCategory.reduce((sum, c) => sum + c.n, 0), byCategory };
}

export async function estimateRescue(
  runId: string,
  fallbackModel: string
): Promise<{ rows: number; costLowUsd: number; costHighUsd: number; cacheWarning: string | null }> {
  const plan = await planRescue(runId, fallbackModel);
  const est = await estimate(plan.cfg, plan.requests);
  return {
    rows: plan.requests.length,
    costLowUsd: est.costLowUsd,
    costHighUsd: est.costHighUsd,
    cacheWarning: cacheWarning(plan.parentCfg, fallbackModel, est.cachedPrefixTokens, plan.requests.length),
  };
}

/**
 * Build a child run from exactly the refused rows, on another model, and submit
 * it. Same shape as retryFailed: the source is rewritten to a jsonl source made
 * from the stored row_json, so the child never re-reads a glob or a command
 * whose output has moved on since the parent ran.
 */
export async function rescueRefusals(runId: string, fallbackModel: string): Promise<{ runId: string; rows: number }> {
  const plan = await planRescue(runId, fallbackModel);

  // A rescue spends a second time on rows already paid for once, so it goes
  // through the per-run spend cap rather than around it — which means pricing
  // it first. retryFailed skips this and is unguarded; that is not a reason to
  // repeat it here.
  let est: Awaited<ReturnType<typeof estimate>>;
  try {
    est = await estimate(plan.cfg, plan.requests);
  } catch (e) {
    throw new Error(
      `Could not price the rescue before submitting it — ${explainApiError(e)}\n\n` +
      `Nothing was submitted. Fix the above and try again.`
    );
  }

  const res = await createAndSubmitRun(plan.cfg, {
    parentRunId: runId,
    estimate: { input: est.totalInputTokens, output: est.worstCaseOutputTokens, cost: est.costHighUsd },
  });

  logEvent(runId, 'info',
    `Rescuing ${plan.requests.length.toLocaleString()} refused row(s) on ${labelFor(fallbackModel)} as run ${res.runId}.`);
  for (const note of plan.notes) logEvent(res.runId, 'warn', note);
  const warning = cacheWarning(plan.parentCfg, fallbackModel, est.cachedPrefixTokens, plan.requests.length);
  if (warning) logEvent(res.runId, 'warn', warning);

  return { runId: res.runId, rows: res.requests };
}

/**
 * Fold a finished rescue back onto its parent.
 *
 * Usage columns are deliberately NOT copied: the parent was billed for the
 * refusal it received, the child is billed for the answer, and each run's totals
 * must keep naming only its own spend. rollUp then re-derives the parent's
 * totals from its own rows, so a merge can never inflate them.
 */
export function mergeRescue(childRunId: string): { merged: number; parentRunId: string } {
  const d = db();
  const child = d.prepare('SELECT id, model, parent_run_id, config_json FROM runs WHERE id = ?').get(childRunId) as
    { id: string; model: string; parent_run_id: string | null; config_json: string } | undefined;
  if (!child) throw new Error(`Run ${childRunId} not found.`);
  if (!child.parent_run_id) {
    throw new Error(`Run ${childRunId} has no parent run, so there is nothing to merge it into. Merge a rescue run, not the run it came from.`);
  }
  if (!markOf(child.config_json)) {
    throw new Error(
      `Run ${childRunId} was not created by the refusal rescue lane — its rows carry no link back to the parent's ` +
      `custom_ids, and merging them by position would put answers on the wrong rows. Read its results directly instead.`
    );
  }

  const parentRunId = child.parent_run_id;
  const parent = d.prepare('SELECT id, model FROM runs WHERE id = ?').get(parentRunId) as
    { id: string; model: string } | undefined;
  if (!parent) throw new Error(`The parent run ${parentRunId} no longer exists, so there is nothing to merge into.`);

  const answers = d.prepare(`
    SELECT custom_id, row_json, output_text, output_json
    FROM requests WHERE run_id = ? AND status = 'succeeded'
  `).all(childRunId) as { custom_id: string; row_json: string; output_text: string | null; output_json: string | null }[];

  const refusedAgain = (d.prepare(
    "SELECT COUNT(*) n FROM requests WHERE run_id = ? AND status = 'refused'"
  ).get(childRunId) as { n: number }).n;

  if (!answers.length) {
    throw new Error(
      refusedAgain
        ? `${labelFor(child.model)} refused all ${refusedAgain.toLocaleString()} row(s) too, so there is nothing to merge. Try a different model.`
        : `Run ${childRunId} has no succeeded rows yet. Wait for it to finish, then merge.`
    );
  }

  // The refusal category is read before the update because the update clears it:
  // once the row reads as succeeded, an error_message saying the model declined
  // is a lie. The category survives in stop_reason instead.
  const wasRefused = new Map<string, string | null>(
    (d.prepare("SELECT custom_id, error_type FROM requests WHERE run_id = ? AND status = 'refused'")
      .all(parentRunId) as { custom_id: string; error_type: string | null }[])
      .map((r) => [r.custom_id, categoryOf(r.error_type)])
  );

  const update = d.prepare(`
    UPDATE requests SET status='succeeded', output_text=?, output_json=?, stop_reason=?,
      error_type=NULL, error_message=NULL
    WHERE run_id=? AND custom_id=? AND status='refused'
  `);

  let merged = 0;
  let unmatched = 0;
  d.transaction(() => {
    for (const a of answers) {
      const target = parentCustomIdOf(a.row_json);
      // Guarded on status='refused' so a re-merge cannot overwrite a row the
      // parent answered itself, and so merging a still-running child twice is
      // safe — the second pass simply changes nothing.
      const info = target
        ? update.run(a.output_text, a.output_json, provenance(child.model, wasRefused.get(target) ?? null), parentRunId, target)
        : { changes: 0 };
      if (info.changes) merged++;
      else unmatched++;
    }
  })();

  rollUp(parentRunId, parent.model);

  logEvent(parentRunId, 'info',
    `Merged ${merged.toLocaleString()} rescued row(s) from ${childRunId} on ${labelFor(child.model)}. ` +
    `Costs stay on ${childRunId} — this run's totals are unchanged.`);
  if (refusedAgain) {
    logEvent(parentRunId, 'warn', `${refusedAgain.toLocaleString()} row(s) were refused again on ${labelFor(child.model)} and are still refused here.`);
  }
  if (unmatched) {
    logEvent(parentRunId, 'warn', `${unmatched.toLocaleString()} rescued row(s) had no still-refused parent row and were left in ${childRunId}.`);
  }

  return { merged, parentRunId };
}

/** Rescue children only — a dead-letter retry shares the parent_run_id column but not the marker. */
export function rescueChildren(runId: string): { id: string; name: string; status: string; model: string }[] {
  const children = db().prepare(
    'SELECT id, name, status, model, config_json FROM runs WHERE parent_run_id = ? ORDER BY created_at'
  ).all(runId) as { id: string; name: string; status: string; model: string; config_json: string }[];

  return children
    .filter((c) => markOf(c.config_json)?.parentRunId === runId)
    .map(({ id, name, status, model }) => ({ id, name, status, model }));
}

/* ── internals ──────────────────────────────────────────────────────── */

type Plan = {
  parentCfg: RunConfig;
  cfg: RescueConfig;
  requests: BuiltRequest[];
  notes: string[];
};

async function planRescue(runId: string, fallbackModel: string): Promise<Plan> {
  const d = db();
  const parent = d.prepare('SELECT id, name, model, config_json FROM runs WHERE id = ?').get(runId) as
    { id: string; name: string; model: string; config_json: string } | undefined;
  if (!parent) throw new Error(`Run ${runId} not found.`);

  const refused = d.prepare(
    "SELECT custom_id, row_json FROM requests WHERE run_id = ? AND status = 'refused' ORDER BY row_index"
  ).all(runId) as { custom_id: string; row_json: string }[];
  if (!refused.length) {
    throw new Error(`Run "${parent.name}" has no refused rows. Use retry for rows that errored or expired.`);
  }

  const parentCfg = JSON.parse(parent.config_json) as RunConfig;
  if (fallbackModel === parentCfg.model) {
    throw new Error(
      `${labelFor(fallbackModel)} is the model that refused these rows. Pick a different one — ` +
      `a refusal is a decision that model already made, and re-asking it costs money to get the same answer.`
    );
  }
  const info = modelInfo(fallbackModel);
  if (info && !info.supportsBatch) {
    throw new Error(`${info.label} cannot run in a Message Batch. Pick a model that supports batch processing.`);
  }

  const notes: string[] = [];
  const rows = refused.map((r) => withRescueKey(r.row_json, r.custom_id));
  const unkeyed = rows.filter((r) => !isPlainObject(r)).length;
  if (unkeyed) {
    throw new Error(
      `${unkeyed.toLocaleString()} refused row(s) are not objects, so a rescue could not be keyed back onto them. ` +
      `Re-run this dataset as CSV or JSONL rows.`
    );
  }

  const cfg: RescueConfig = {
    ...parentCfg,
    name: `${parent.name} — rescue on ${labelFor(fallbackModel)}`,
    model: fallbackModel,
    source: { kind: 'jsonl', text: rows.map((r) => JSON.stringify(r)).join('\n') },
    rescueOf: { parentRunId: parent.id, fromModel: parentCfg.model },
    ...ceilingsFor(parentCfg, fallbackModel, info, notes),
  };

  if (!MODELS.some((m) => m.id === fallbackModel)) {
    notes.push(`No local pricing for ${fallbackModel} — the cost shown for this rescue uses default rates and may be wrong.`);
  }

  const ds = await loadSource(cfg.source);
  const built = buildRequests(cfg, ds.rows, ds.columns);
  if (built.errors.length) throw new Error(built.errors.join(' '));
  if (!built.requests.length) throw new Error('The refused rows produced zero requests — nothing to rescue.');
  notes.push(...built.warnings);

  return { parentCfg, cfg, requests: built.requests, notes };
}

/**
 * A fallback model can have a lower output ceiling than the model that refused.
 * Left alone, the rescue dies in buildRequests with a max_tokens complaint that
 * reads like the user typed something wrong, when all they did was pick a
 * smaller model — so clamp, and say so in the run's event log.
 *
 * The ceiling is never taken from modelFor(): it answers for an id it has never
 * heard of by silently returning DEFAULT_MODEL's row, so a model missing from
 * MODELS would be "clamped" against Sonnet 5's 128k and keep the extended-output
 * beta. Nothing downstream catches that — build.ts re-derives the same wrong cap
 * from the same table — so the rescue is created and every row comes back with an
 * invalid max_tokens 24 hours later, which is the failure this function exists to
 * prevent, only slower. The catalog from /v1/models is asked first because it
 * carries the real max_tokens; when neither table knows the id, the clamp goes to
 * the most conservative ceiling Wanigan knows and says out loud that it guessed.
 */
function ceilingsFor(
  cfg: RunConfig,
  fallbackModel: string,
  info: ModelInfo | undefined,
  notes: string[]
): Partial<RunConfig> {
  const priced = MODELS.find((m) => m.id === fallbackModel);
  const label = labelFor(fallbackModel);
  const out: Partial<RunConfig> = {};

  // Every ceiling there is evidence for, and the lowest of them wins. buildRequests
  // re-derives its own cap from modelFor(), which hands back DEFAULT_MODEL for an
  // unlisted id, so the clamp is also held under that — clamping above it would
  // simply move the max_tokens complaint into buildRequests naming the wrong model.
  const known = [info?.maxTokens, priced?.maxTokens].filter((n): n is number => typeof n === 'number' && n > 0);
  const ceiling = Math.min(
    known.length ? Math.min(...known) : Math.min(...MODELS.map((m) => m.maxTokens)),
    modelFor(fallbackModel).maxTokens
  );
  const supportsExtended = info?.extendedOutput ?? priced?.extendedOutput ?? false;

  let extended = cfg.extendedOutput === true;
  if (extended && !supportsExtended) {
    extended = false;
    out.extendedOutput = false;
    notes.push(`${label} is not known to carry the extended-output beta, so the rescue runs without it.`);
  }

  if (!info && !priced) {
    notes.push(
      `Wanigan has no output ceiling for ${fallbackModel} — neither the model catalog nor the local pricing table ` +
      `lists it — so max_tokens is held at ${ceiling.toLocaleString()}, the most conservative ceiling it knows. ` +
      `Raise it only if you know that model's real limit; guessing high means the rescue errors on every row a day from now.`
    );
  }

  const cap = extended ? 300_000 : ceiling;
  if (cfg.maxTokens > cap) {
    out.maxTokens = cap;
    notes.push(`max_tokens lowered from ${cfg.maxTokens.toLocaleString()} to ${cap.toLocaleString()} — the ceiling for ${label}.`);
  }
  return out;
}

/**
 * Prompt caches are scoped to one model. The prefix the parent had warm is cold
 * on the fallback, so the rescue pays the full write price for it again and then
 * reads it back across only the handful of rows that were refused — the per-row
 * cost of a rescue is routinely far above the parent's. Surfaced before
 * submission so the rescue is a decision rather than a surprise on the invoice.
 */
function cacheWarning(cfg: RunConfig, fallbackModel: string, prefixTokens: number, rows: number): string | null {
  if (!cfg.system.some((b) => b.cache)) return null;
  const size = prefixTokens > 0 ? ` (~${prefixTokens.toLocaleString()} tokens)` : '';
  return (
    `The cached system prompt${size} does not carry over: prompt caches belong to one model, so this rescue ` +
    `writes that prefix again at full price on ${labelFor(fallbackModel)} and reads it back across only ` +
    `${rows.toLocaleString()} request${rows === 1 ? '' : 's'}. Expect the cost per row to be well above the ` +
    `original run's.`
  );
}

function provenance(model: string, category: string | null): string {
  return category
    ? `rescued on ${model} after refusal: ${category}`
    : `rescued on ${model}`;
}

function withRescueKey(rowJson: string, customId: string): unknown {
  const row = parseRow(rowJson);
  if (!isPlainObject(row)) return row;
  return { ...row, [RESCUE_KEY_COLUMN]: customId };
}

function parentCustomIdOf(rowJson: string): string | null {
  const row = parseRow(rowJson);
  if (!isPlainObject(row)) return null;
  const v = row[RESCUE_KEY_COLUMN];
  return typeof v === 'string' && v ? v : null;
}

function markOf(configJson: string): RescueMark | null {
  try {
    const mark = (JSON.parse(configJson) as RescueConfig).rescueOf;
    return mark && typeof mark.parentRunId === 'string' ? mark : null;
  } catch {
    return null;
  }
}

function categoryOf(errorType: string | null): string | null {
  if (!errorType?.startsWith('refusal:')) return null;
  const c = errorType.slice('refusal:'.length).trim();
  return c && c !== UNSPECIFIED ? c : null;
}

function labelFor(modelId: string): string {
  return modelInfo(modelId)?.label ?? MODELS.find((m) => m.id === modelId)?.label ?? modelId;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A row that will not parse is still worth showing; the caller only reads it. */
function parseRow(rowJson: string): unknown {
  try {
    return JSON.parse(rowJson);
  } catch {
    return rowJson;
  }
}
