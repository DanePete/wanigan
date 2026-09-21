import { db } from './db';
import * as control from './control';
import { recipe } from './review';
import { halted } from './halt';
import { attentionOf } from './attention';
import { listSessions } from './sessions';
import { providerById } from './providers';

export function assertAutomaticProfile(providerId: string): void {
  const profile = providerById(providerId);
  if (!profile || profile.harness === 'generic-cli') {
    throw new Error('This coding connection has not verified the session evidence needed for automatic progress. Use manual stages until that integration is verified.');
  }
}

/** No default allowance: choosing automatic progress must also choose its spending limit. */
export function readAutomation(raw: unknown, projectId: string): { budgetUsd: number } | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => key !== 'budgetUsd')) {
    throw new Error('Automatic progress needs a spending limit.');
  }
  const budgetUsd = (raw as { budgetUsd?: unknown }).budgetUsd;
  if (typeof budgetUsd !== 'number' || !Number.isFinite(budgetUsd) || budgetUsd <= 0 || budgetUsd > 100_000) {
    throw new Error('Choose an agent spending limit above $0 and at most $100,000.');
  }
  if (!recipe(projectId).commands.length) throw new Error('Add this project’s review commands under Git › Review gate before enabling automatic progress.');
  return { budgetUsd };
}

export function setAutomation(docketId: unknown, raw: unknown): void {
  if (typeof docketId !== 'string' || docketId.length > 200) throw new Error('A relay is required.');
  const goal = control.docket(docketId);
  const row = db().prepare('SELECT relay FROM work_dockets WHERE id=?').get(docketId) as { relay: number };
  if (row.relay !== 1) throw new Error('Automatic relay progress belongs to a relay.');
  const config = readAutomation(raw, goal.projectId);
  if (!config) {
    db().transaction(() => {
      control.setAutopilot(docketId, { enabled: false });
      control.setGoalGate(docketId, { onStop: goal.gate.onStop, returnFailures: false });
      db().prepare('UPDATE work_dockets SET relay_automatic_progress=0 WHERE id=?').run(docketId);
    })();
    return;
  }
  if (halted()) throw new Error('Wanigan is halted. Resume it before enabling automatic progress.');
  const providerId = goal.nodes.find(node => node.kind === 'implement')?.providerId;
  if (!providerId) throw new Error('Choose an implementation coding assistant before enabling automatic progress.');
  for (const node of goal.nodes) if (['plan', 'implement'].includes(node.kind) && node.providerId) assertAutomaticProfile(node.providerId);
  db().transaction(() => {
    control.setDocketBudget(docketId, config.budgetUsd);
    control.setGoalGate(docketId, { onStop: true, returnFailures: true });
    db().prepare('UPDATE work_dockets SET relay_automatic_progress=1 WHERE id=?').run(docketId);
    control.setAutopilot(docketId, { enabled: true, providerId });
  })();
}

function optedIn(id: string): boolean {
  const row = db().prepare('SELECT relay_automatic_progress FROM work_dockets WHERE id=?').get(id) as
    { relay_automatic_progress: number } | undefined;
  return row?.relay_automatic_progress === 1;
}

/** The existing dispatcher retains leases, halt checks and the atomic task claim. */
control.registerAutomaticNodeRunner({
  id: 'relay-verification',
  matches: ({ node, docket }) => docket.relay && node.kind === 'verify' && optedIn(docket.id),
  async run(nodeId) {
    const proof = await control.runProof(nodeId);
    if (proof.status !== 'passed') throw new Error(proof.summary || 'Verification needs attention.');
    await control.completeNode(nodeId, { detail: 'Automatic verification passed the project’s recorded review commands. No verification model was called.' });
  },
});

const attempted = new Map<string, { evidence: string; retryAt: number }>();
let progressing = false;

/** Local evidence only. Never approves final review or starts a model itself. */
export async function advanceAutomaticRelays(deps = { sessions: listSessions, attention: attentionOf }): Promise<void> {
  if (progressing || halted()) return;
  progressing = true;
  try {
    const rows = db().prepare(`SELECT n.id,n.docket_id,n.session_id FROM work_nodes n JOIN work_dockets d ON d.id=n.docket_id
      WHERE d.relay=1 AND d.relay_automatic_progress=1 AND d.autopilot=1
      AND d.status NOT IN ('accepted','rejected') AND n.status='running' AND n.kind IN ('plan','implement')
      ORDER BY d.updated_at LIMIT 100`).all() as { id: string; docket_id: string; session_id: string | null }[];
    const live = new Map(deps.sessions().map(session => [session.id, session]));
    for (const row of rows) {
      if (halted()) break;
      const session = row.session_id ? live.get(row.session_id) : null;
      if (!session || session.status !== 'running') continue;
      const attention = deps.attention(session);
      if (attention.kind !== 'finished' || !attention.transitionId.startsWith('event:') || control.gateRunning(row.id)) continue;
      const goal = control.docket(row.docket_id);
      const node = goal.nodes.find(item => item.id === row.id);
      if (!node || node.status !== 'running' || !goal.autopilot.enabled || !optedIn(goal.id)) continue;
      const plan = node.kind === 'plan' ? control.goalPlan(goal.id) : null;
      if (node.kind === 'plan' && (plan?.state !== 'accepted' || plan.nodeId !== node.id
        || node.startedAt === null || plan.capturedAt < node.startedAt)) continue;
      const proof = goal.proofs.find(item => item.nodeId === node.id && item.kind === 'test');
      if (node.kind === 'implement' && (!goal.gate.onStop || proof?.status !== 'passed')) continue;
      const evidence = `${node.sessionId}:${attention.transitionId}:${plan?.capturedAt ?? proof?.id}:${goal.updatedAt}`;
      const previous = attempted.get(node.id);
      if (previous?.evidence === evidence && previous.retryAt > Date.now()) continue;
      // Re-check transient failures after a bounded pause. Changing the
      // allowance/automation setting makes new evidence immediately eligible.
      attempted.delete(node.id); attempted.set(node.id, { evidence, retryAt: Date.now() + 30_000 });
      if (attempted.size > 256) attempted.delete(attempted.keys().next().value!);
      try {
        await control.completeNode(node.id, { detail: node.kind === 'plan'
          ? 'Advanced automatically after the accepted plan and the agent’s recorded stop.'
          : 'Advanced automatically after the agent stopped and the current checkout passed the review gate.' }, () => {
          const currentSession = deps.sessions().find(item => item.id === node.sessionId);
          const currentAttention = currentSession ? deps.attention(currentSession) : null;
          if (halted() || !optedIn(goal.id) || !control.docket(goal.id).autopilot.enabled
            || currentSession?.status !== 'running' || currentAttention?.kind !== 'finished'
            || currentAttention.transitionId !== attention.transitionId
            || (node.kind === 'plan' && control.goalPlan(goal.id)?.capturedAt !== plan?.capturedAt)) {
            throw new Error('The agent or automatic progress changed during verification. This stage remains open.');
          }
        });
      } catch (error) {
        // Current-tree validation inside Control is authoritative. A stale pass
        // leaves the stage visible for review; it never triggers a paid retry.
        console.warn('[wanigan] automatic relay progression needs attention:', error instanceof Error ? error.message : String(error));
      }
    }
  } finally { progressing = false; }
}
