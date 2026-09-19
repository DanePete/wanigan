import type { HeadlessRowDetail, HeadlessRowSummary, HeadlessStartRequest } from '../../shared/types';
import type { WaniganModule } from '../module-registry';
import * as headless from '../headless';
import { migrateHeadless } from './execution-storage';

/** Headless execution owns unattended launches and their durable per-repository evidence. */
export const headlessModule: WaniganModule = {
  id: 'headless',
  label: 'Headless runs',
  required: {
    reason: 'Headless owns unattended agent launches, process shutdown and durable per-repository execution evidence.',
  },
  migrate: migrateHeadless,
  requiresStartedServices: ['start'],
  ipc(handle, context) {
    handle('headless:start', async (cfg: HeadlessStartRequest) => {
      const started = await headless.startHeadlessRun(cfg);
      // startHeadlessRun returns once the children are spawned, not when the
      // fan-out finishes, so this reconcile happens with the run genuinely live.
      // Its completion has no IPC boundary at all — the poller releases it.
      context.onAgentLaunched?.();
      return started;
    });
    // Status without the transcript. The run view refires this every three
    // seconds and renders none of the agent's stdout in the list, so the text
    // stays in SQLite until a row is expanded — see HeadlessRowSummary.
    handle('headless:rows', (runId: string): HeadlessRowSummary[] =>
      headless.headlessRows(runId).map((row) => {
        const { output, error, ...rest } = row;
        return {
          ...rest,
          output: null,
          error: null,
          hasOutput: typeof output === 'string' && output.length > 0,
          hasError: typeof error === 'string' && error.length > 0,
        };
      }));
    handle('headless:rowDetail', (runId: string, projectId: string): HeadlessRowDetail => {
      const row = headless.headlessRows(runId).find((value) => value.projectId === projectId);
      if (!row) throw new Error('That repository is no longer part of this run.');
      return { runId: row.runId, projectId: row.projectId, output: row.output, error: row.error };
    });
    handle('headless:runs', (limit?: number) => headless.headlessRuns(limit));
    handle('headless:cancel', (runId: string) => headless.cancelHeadless(runId));
    handle('headless:answerHeld', (runId: unknown, projectId: unknown, decision: unknown, note: unknown) =>
      headless.answerHeld(runId, projectId, decision, note));

  },
};
