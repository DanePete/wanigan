import { onHookInput } from './hooks';
import { approvalDetailFor, attachApprovalExplanation } from './approval-explain';
import { ledgerTrace } from './policy';
import { latestGateSelfTest, runAndRecordGateSelfTest } from './policy-selftest-run';
import { forgetTaint, observeForTaint } from './tripwire';

/**
 * The wiring for the policy evidence built around the gate: what a script alias
 * runs, and the observations that follow from recorded hook events. One start
 * function and one IPC registrar, so `index.ts` carries two calls rather than a
 * block per feature.
 */

let started = false;

export function startPolicyEvidence(): void {
  if (started) return;
  started = true;
  // The gate checks itself before the first session can reach it.
  try {
    const run = runAndRecordGateSelfTest();
    if (run.passed < run.rules) console.warn(`[wanigan] gate self-test: ${run.passed}/${run.rules} rules behaved as specified`);
  } catch (e) { console.warn('[wanigan] gate self-test could not run:', e); }
  onHookInput((stored, input, cwd) => {
    attachApprovalExplanation(stored, input, cwd);
    observeForTaint(stored, input, cwd);
    if (stored.event === 'SessionEnd') forgetTaint(stored.sessionId);
  });
}

type Handle = (channel: string, fn: (...args: never[]) => unknown) => void;

function sessionIdArg(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 200) throw new Error('That is not a session id Wanigan knows.');
  return value;
}

function timeArg(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

export function registerPolicyEvidenceIpc(handle: Handle): void {
  handle('policyEvidence:approval', (sessionId: unknown, sinceAt: unknown) =>
    approvalDetailFor(sessionIdArg(sessionId), timeArg(sinceAt)));
  handle('policyEvidence:selfTest', () => latestGateSelfTest());
  handle('policyEvidence:runSelfTest', () => runAndRecordGateSelfTest());
  handle('policyEvidence:trace', (id: unknown) =>
    ledgerTrace(typeof id === 'number' && Number.isInteger(id) ? id : -1));
}
