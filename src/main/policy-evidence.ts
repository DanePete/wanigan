import { onHookInput } from './hooks';
import { approvalDetailFor, attachApprovalExplanation } from './approval-explain';
import { ledgerTrace, setGrantLookup, trustFor } from './policy';
import { detectProviders } from './providers';
import { compileAutoMode } from '../shared/auto-mode';
import type { AutoModeView, ProviderInfo } from '../shared/types';
import { latestGateSelfTest, runAndRecordGateSelfTest } from './policy-selftest-run';
import { forgetTaint, observeForTaint } from './tripwire';
import { fatigueReport, observeFatigue } from './fatigue';
import { observeForRewrites } from './rewrite-evidence';
import { sessionSignals } from './policy-signals';
import { grantFor, grantSettings, observeForGrants, setGrantSetting } from './grants';
import { listProjects } from './store';
import { approveSkillSurface, skillSurface } from './skill-surface';

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
  setGrantLookup((projectId, projectPath, input) => {
    const match = grantFor(projectId, projectPath, input);
    if (!match) return null;
    return match.grant
      ? { grant: { id: match.grant.id, at: match.grant.at, summary: match.grant.summary }, days: match.days }
      : { grant: null, because: match.because, days: match.days };
  });
  // The gate checks itself before the first session can reach it.
  try {
    const run = runAndRecordGateSelfTest();
    if (run.passed < run.rules) console.warn(`[wanigan] gate self-test: ${run.passed}/${run.rules} rules behaved as specified`);
  } catch (e) { console.warn('[wanigan] gate self-test could not run:', e); }
  onHookInput((stored, input, cwd) => {
    attachApprovalExplanation(stored, input, cwd);
    observeForTaint(stored, input, cwd);
    observeFatigue(stored);
    observeForRewrites(stored, input, cwd);
    observeForGrants(stored, input);
    if (stored.event === 'SessionEnd') forgetTaint(stored.sessionId);
  });
}

type Handle = (channel: string, fn: (...args: never[]) => unknown) => void;

/**
 * The block a session launched now would carry, for the Context view. The
 * version comes from the same detection the launch path uses; a machine with
 * no Claude Code harness gets the "not verified" answer rather than a guess.
 */
async function autoModeFor(projectId: string | null): Promise<AutoModeView> {
  const trust = trustFor(projectId);
  let provider: ProviderInfo | undefined;
  try {
    const all = await detectProviders();
    provider = all.find((p) => p.id === 'claude' && p.version) ?? all.find((p) => p.harnessId === 'claude-code' && p.version);
  } catch { provider = undefined; }
  return { ...compileAutoMode(trust, provider?.version ?? null), providerLabel: provider?.label ?? null };
}

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
  handle('policyEvidence:fatigue', () => fatigueReport());
  handle('policyEvidence:skillSurface', (skillPath: unknown) => {
    if (typeof skillPath !== 'string' || !skillPath || skillPath.length > 4096) throw new Error('That is not a skill Wanigan knows.');
    return skillSurface(skillPath);
  });
  handle('policyEvidence:approveSkillSurface', (skillPath: unknown, digest: unknown) => {
    if (typeof skillPath !== 'string' || !skillPath || skillPath.length > 4096 || typeof digest !== 'string') throw new Error('That is not a skill surface Wanigan can approve.');
    return approveSkillSurface(skillPath, digest);
  });
  handle('policyEvidence:grantSettings', () => grantSettings(listProjects().map((p) => p.id)));
  handle('policyEvidence:setGrantSetting', (projectId: unknown, enabled: unknown, days: unknown) => {
    if (typeof projectId !== 'string' || typeof enabled !== 'boolean' || typeof days !== 'number') throw new Error('That grant setting is not one Wanigan accepts.');
    setGrantSetting(projectId, enabled, days);
    return grantSettings([projectId])[0];
  });
  handle('policyEvidence:session', (sessionId: unknown) => ({ signals: sessionSignals(sessionIdArg(sessionId)) }));
  handle('policyEvidence:autoMode', (projectId: unknown) => autoModeFor(typeof projectId === 'string' && projectId.length <= 200 ? projectId : null));
  handle('policyEvidence:selfTest', () => latestGateSelfTest());
  handle('policyEvidence:runSelfTest', () => runAndRecordGateSelfTest());
  handle('policyEvidence:trace', (id: unknown) =>
    ledgerTrace(typeof id === 'number' && Number.isInteger(id) ? id : -1));
}
