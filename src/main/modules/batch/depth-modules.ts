import type { WaniganModule } from '../../module-registry';
import type { RunConfig } from '../../../shared/types';
import * as refusal from './refusal';
import * as cachediag from './cachediag';
import * as evals from './evals';
import * as uploads from './files';

/**
 * Batch depth: four channel families that grew beside batch and were wired into
 * index.ts one handler at a time. Each namespace is its own module record,
 * because a module owns exactly the channels under its id and these channels
 * are already published to the preload. Their tables stay where they are.
 */

export const uploadsModule = {
  id: 'uploads', label: 'Uploaded files',
  // Disabling removes the list of files uploaded for batch runs; runs already submitted are unaffected.
  required: null,
  ipc(handle) {
    handle('uploads:list', () => uploads.listUploads());
    handle('uploads:delete', (hash: string) => uploads.deleteUpload(hash));
    handle('uploads:prune', () => uploads.pruneOrphans());
  },
} satisfies WaniganModule;

export const refusalModule = {
  id: 'refusal', label: 'Refusal rescue',
  // A rescue submits a paid run, so it waits for the stop handlers exactly as batch:submit does.
  requiresStartedServices: ['rescue'],
  // Disabling removes re-running refused rows on another model; the original results are unaffected.
  required: null,
  ipc(handle) {
    handle('refusal:rows', (runId: string) => refusal.refusedRows(runId));
    handle('refusal:summary', (runId: string) => refusal.refusalSummary(runId));
    // Priced before it is submitted, and the price is shown. The copy under the
    // Rescue button already promised this ("the rescue is priced before it is
    // submitted, so it goes through the per-run spend cap rather than around
    // it") while the figure existed only inside main and never reached a screen.
    handle('refusal:estimate', (runId: string, model: string) => refusal.estimateRescue(runId, model));
    handle('refusal:rescue', (runId: string, model: string) => refusal.rescueRefusals(runId, model));
    handle('refusal:merge', (childRunId: string) => refusal.mergeRescue(childRunId));
    handle('refusal:children', (runId: string) => refusal.rescueChildren(runId));
  },
} satisfies WaniganModule;

export const cacheModule = {
  id: 'cache', label: 'Cache diagnostics',
  // Disabling removes cache hit-rate and TTL advice; runs are priced and submitted the same.
  required: null,
  ipc(handle) {
    handle('cache:hitRate', (runId: string) => cachediag.observedHitRate(runId));
    handle('cache:minimum', (modelId: string) => cachediag.minimumCacheablePrefix(modelId));
    handle('cache:ttl', (cfg: RunConfig, requests: number) => cachediag.recommendedTtl(cfg, requests));
  },
} satisfies WaniganModule;

export const evalsModule = {
  id: 'evals', label: 'Evals',
  // A variant and a judge each submit a paid run, so they wait for the stop handlers exactly as batch:submit does.
  requiresStartedServices: ['variant', 'judge'],
  // Disabling removes paired comparisons and golden sets; ordinary batch runs are unaffected.
  required: null,
  ipc(handle) {
    handle('evals:pairs', () => evals.listPairs());
    handle('evals:createPair', (name: string, a: string, b: string) => evals.createPair(name, a, b));
    /*
     * The two calls the Evals tab has always told the operator to make.
     *
     * `runVariant` and `judgePair` were written, exported and never registered,
     * so the tab's own copy — "copy this run in the builder, change exactly one
     * field, and submit it", "paste the id of a judge run created for this pair"
     * — instructed work no control could do, and `ingestJudgement` refuses any
     * run whose kind is not 'eval', which nothing could produce.
     *
     * Both spend money, so both are validated here before they reach main's own
     * guards: the change set is narrowed to the fields a pair may vary, and every
     * value is shape-checked rather than passed through from the renderer.
     */
    handle('evals:variant', (baseRunId: unknown, change: unknown, name: unknown) => {
      if (typeof baseRunId !== 'string' || !baseRunId.trim()) throw new Error('Choose the run this variant is based on.');
      if (typeof name !== 'string' || !name.trim()) throw new Error('Give the variant a name.');
      if (!change || typeof change !== 'object' || Array.isArray(change)) throw new Error('A variant changes one field.');
      // Only the fields a pair is allowed to vary. Anything else would submit a
      // run the pairing rule then refuses, after it had already been paid for.
      const allowed = new Set(['model', 'effort', 'maxTokens', 'temperature', 'userTemplate', 'schemaJson']);
      const patch: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(change as Record<string, unknown>)) {
        if (!allowed.has(key)) throw new Error(`A variant cannot change ${key}.`);
        if (typeof value === 'string') { if (value.length > 100_000) throw new Error(`${key} is too long.`); patch[key] = value; }
        else if (typeof value === 'number' && Number.isFinite(value)) patch[key] = value;
        else throw new Error(`${key} must be text or a number.`);
      }
      if (Object.keys(patch).length !== 1) throw new Error('A variant changes exactly one field, so the pair has one variable.');
      return evals.runVariant(baseRunId, patch as Partial<RunConfig>, name.trim().slice(0, 200));
    });
    handle('evals:judge', (pairId: unknown, opts: unknown) => {
      if (typeof pairId !== 'string' || !pairId.trim()) throw new Error('Choose the pair to judge.');
      const raw = (opts ?? {}) as Record<string, unknown>;
      const model = typeof raw.model === 'string' ? raw.model.trim() : '';
      const rubric = typeof raw.rubric === 'string' ? raw.rubric.trim() : '';
      const effort = typeof raw.effort === 'string' ? raw.effort.trim() : undefined;
      if (!model) throw new Error('Choose the model that will judge.');
      if (!rubric) throw new Error('A judge needs a rubric. Say what “better” means for this task.');
      if (rubric.length > 20_000) throw new Error('That rubric is too long.');
      return evals.judgePair(pairId, { model, rubric, effort });
    });
    handle('evals:diff', (pairId: string) => evals.pairDiff(pairId));
    handle('evals:summary', (pairId: string) => evals.regressionSummary(pairId));
    handle('evals:ingest', (judgeRunId: string) => evals.ingestJudgement(judgeRunId));
    handle('evals:golden', () => evals.listGoldenSets());
    handle('evals:saveGolden', (name: string, runId: string) => evals.saveGoldenSet(name, runId));
    handle('evals:goldenSource', (id: string) => evals.goldenSetSource(id));
  },
} satisfies WaniganModule;
