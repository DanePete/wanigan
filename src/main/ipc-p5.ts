/**
 * helper sweep · P5 runtime — the IPC surface for runtime hygiene and honest
 * readers, registered from index.ts in one delimited call.
 *
 * Kept out of index.ts so the channels a package adds do not interleave with
 * everyone else's, and so each handler's validation sits next to the module it
 * guards. Every argument arriving here came from the renderer and is untrusted.
 */
import * as processWatch from './process-watch';
import { codexReaderHealth } from './codex-rollout-health';
import { detectProviders, providerById } from './providers';
import { recentRefusals } from './headless-guard';
import { headlessOutcomes } from './headless';
import { importIntoCodex, planCodexImport } from './codex-import';
import { runCodexDoctor } from './codex-doctor';
import { previewDiagnostics, saveDiagnostics } from './diagnostics';
import { BrowserWindow } from 'electron';
import { envNamesFor, launchProvenanceFor } from './launch-provenance';
import { goalReviewOnly, preparePrReview, setGoalReviewOnly } from './review-only';
import { substitutionsFor } from './model-substitutions';

type Handle = <T>(channel: string, fn: (...args: never[]) => T | Promise<T>) => void;

export function registerP5Ipc(handle: Handle): void {
  // ── what a session left running ─────────────────────────────────────
  handle('processes:forSession', (sessionId: unknown) => {
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200) {
      throw new Error('A session id is required.');
    }
    return processWatch.processesForSession(sessionId);
  });
  handle('processes:survivors', () => processWatch.allSurvivors());
  // Called by the two stop buttons just before they signal a session, so the
  // tree is recorded while the ppid chain still proves whose it is.
  handle('processes:capture', () => processWatch.captureBeforeStop().then(() => true));
  handle('processes:stop', (sessionId: unknown, pid: unknown) => processWatch.stopSurvivor(sessionId, pid));

  // ── honest Codex readers ────────────────────────────────────────────
  // The version is the installed Codex CLI Wanigan would launch now: the
  // readers read files that CLI writes, so a format change arrives with it.
  handle('codexReaders:health', async (force: unknown) => {
    let version: string | null = null;
    try {
      const codex = (await detectProviders()).find((p) => p.harnessId === 'codex' && p.path);
      version = codex?.version ?? null;
    } catch { /* detection failed: the stored version stands */ }
    return codexReaderHealth(version, force === true);
  });

  // ── headless runs that tell the truth ───────────────────────────────
  handle('headless:outcomes', (runId: unknown) => {
    if (typeof runId !== 'string' || !runId || runId.length > 200) throw new Error('A run id is required.');
    return headlessOutcomes(runId);
  });
  handle('headless:refusals', (limit: unknown) => recentRefusals(typeof limit === 'number' ? limit : 20));

  // ── continue a Claude conversation in Codex ─────────────────────────
  // The plan is what the consent dialog shows; the run re-plans and refuses
  // unless the transcript it would send is the one that was confirmed.
  handle('codexImport:plan', (sessionId: unknown, accountId: unknown) => planCodexImport(sessionId, accountId));
  handle('codexImport:run', (sessionId: unknown, accountId: unknown, confirmedPath: unknown) =>
    importIntoCodex(sessionId, accountId, confirmedPath));

  // ── per-account health and a diagnostics bundle ─────────────────────
  handle('codexDoctor:run', (accountId: unknown) => runCodexDoctor(accountId));
  handle('diagnostics:preview', () => previewDiagnostics());
  handle('diagnostics:save', (names: unknown) => saveDiagnostics(BrowserWindow.getFocusedWindow(), names));

  // ── where each launch value came from ───────────────────────────────
  handle('launchProvenance:forSession', (sessionId: unknown) => launchProvenanceFor(sessionId));

  // ── reviewer sessions with no command tools, and Review PR ──────────
  handle('review:preparePr', (projectId: unknown, prNumber: unknown) => preparePrReview(projectId, prNumber));
  handle('review:goalReviewOnly', (docketId: unknown) => {
    if (typeof docketId !== 'string' || !docketId) throw new Error('A goal is required.');
    return goalReviewOnly(docketId);
  });
  handle('review:setGoalReviewOnly', (docketId: unknown, enabled: unknown) => setGoalReviewOnly(docketId, enabled));

  // ── asked for X, answered by Y ──────────────────────────────────────
  handle('models:substitutions', (sessionId: unknown) => substitutionsFor(sessionId));
  // Names only: the dialog shows which variables a profile sets, never a value.
  handle('launchProvenance:envNames', (providerId: unknown) => {
    const def = typeof providerId === 'string' ? providerById(providerId) : null;
    return { env: envNamesFor(providerId), packSource: def?.source ?? null, packLabel: def?.packId ?? null };
  });
}
