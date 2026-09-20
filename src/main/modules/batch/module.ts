import fs from 'node:fs';
import { dialog } from 'electron';
import type Database from 'better-sqlite3';
import { db } from '../../db';
import type { WaniganModule } from '../../module-registry';
import type { EgressHost, RunConfig, SourceConfig } from '../../../shared/types';
import { getKey } from '../../keys';
import {
  cancelRun, createAndSubmitRun, deleteRun, dryRunOne, estimateRun, insights, listRuns, pollOnce, presetsFor,
  previewSource, refreshModels, retryFailed, runDetail, runResults, runsInFlight,
} from './index';
import { migrateBatchDryRuns } from './dry-run-ledger';
import { migrateBatchSubmissionLedger } from './submission-ledger';

/** Streams a run's results to disk without materialising them in memory. */
export function writeExport(runId: string, format: 'jsonl' | 'csv', filePath: string): string {
  // Static imports, not a lazy require: the bundler leaves a relative require
  // as written, and the built app has no db.js beside it to find.

  const stmt = db().prepare(`
    SELECT custom_id, row_index, row_json, rendered, status, output_text,
           error_type, error_message, in_tokens, out_tokens
    FROM requests WHERE run_id = ? ORDER BY row_index
  `);
  const out = fs.createWriteStream(filePath, { flags: 'w' });
  const cell = (v: unknown) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  if (format === 'csv') {
    out.write('custom_id,row_index,status,output_text,error_type,error_message,in_tokens,out_tokens\n');
  }
  for (const r of stmt.iterate(runId) as Iterable<Record<string, unknown>>) {
    out.write(format === 'jsonl'
      ? JSON.stringify({ ...r, row: JSON.parse(String(r.row_json)) }) + '\n'
      : [r.custom_id, r.row_index, r.status, r.output_text, r.error_type, r.error_message, r.in_tokens, r.out_tokens].map(cell).join(',') + '\n');
  }
  out.end();
  return filePath;
}

function anthropicHost(baseUrl = process.env.ANTHROPIC_BASE_URL): string {
  try { return new URL(baseUrl?.trim() || 'https://api.anthropic.com').hostname; } catch { return 'api.anthropic.com'; }
}
const keyReachable = (): boolean => { try { return Boolean(getKey()); } catch { return false; } };

/** The batch submission and file rows stay in egress.ts. The dry-run sample goes
 * to a different path, and was on no row of the privacy panel. */
export function batchDryRunEgress(available: boolean, baseUrl?: string): EgressHost[] {
  return [{
    host: anthropicHost(baseUrl), paths: ['/v1/messages'], by: 'wanigan',
    purpose: 'Sending exactly one request of a batch you are building, synchronously, so a malformed run fails before the whole batch is submitted. It carries that row and the run\u2019s prompts.',
    when: 'When you press Dry run in the batch builder, or when an agent calls the wanigan_dry_run tool, with a Claude Platform API key connected. Each makes one request that may be billed.',
    activeNow: available, overrideEnv: 'ANTHROPIC_BASE_URL',
  }];
}

export const batchModule = {
  id: 'batch', label: 'Batches',
  // Disabling removes batch runs over a dataset; sessions and every other view still work.
  required: null,
  // This module's own schema is the dry-run and submission ledgers. runs, batches, requests and events stay in db.ts: Recovery requires them as
  // evidence and `runs` is shared with headless work. The poller, its halt
  // stopper and the queue runner stay in index.ts, where the halt order is pinned.
  migrate: (d: Database.Database) => { migrateBatchDryRuns(d); migrateBatchSubmissionLedger(d); },
  requiresStartedServices: ['submit', 'dryRun', 'retry'],
  egress: () => batchDryRunEgress(keyReachable()),
  ipc(handle, context) {
    handle('batch:presets', (projectId?: string) => presetsFor(projectId));
    // Rethrown, not swallowed. Returning an 'unavailable' shape resolved the
    // renderer's await, so its catch never ran, its "Model refresh failed" Note
    // could never fire, and the button went back to rest above a capability table
    // the page then described as freshly read. The renderer already has the
    // failure path; this is what reaches it.
    handle('batch:refreshModels', () => refreshModels());
    handle('batch:insights', () => insights());
    handle('batch:preview', (source: SourceConfig, userTemplate: string) => previewSource(source, userTemplate));
    handle('batch:estimate', (config: RunConfig, observedOut?: number) => estimateRun(config, observedOut));
    handle('batch:dryRun', (config: RunConfig, rowIndex?: number) => dryRunOne(config, rowIndex));
    handle('batch:runs', () => listRuns());
    handle('batch:runsInFlight', () => runsInFlight());
    handle('batch:run', (id: string) => runDetail(id));
    handle('batch:results', (id: string, status: string, q: string, offset: number) =>
      runResults(id, status, q, offset));
    handle('batch:submit', async (config: RunConfig, est?: { input: number; output: number; cost: number }) => {
      const r = await createAndSubmitRun(config, { estimate: est });
      void pollOnce().catch(() => {});
      return r;
    });
    handle('batch:cancel', (id: string) => cancelRun(id));
    handle('batch:retry', (id: string) => retryFailed(id));
    handle('batch:delete', (id: string) => { deleteRun(id); return true; });
    handle('batch:poll', () => pollOnce());
    handle('batch:export', async (id: string, format: 'jsonl' | 'csv') => {
      const win = context.getWindow();
      if (!win) return null;
      const res = await dialog.showSaveDialog(win, {
        title: 'Export results',
        defaultPath: `${id}.${format}`,
        filters: [{ name: format.toUpperCase(), extensions: [format] }],
      });
      if (res.canceled || !res.filePath) return null;
      return writeExport(id, format, res.filePath);
    });
  },
} satisfies WaniganModule;
