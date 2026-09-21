import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { Attention, AttentionKind, Session } from '../shared/types';

type Check = (ok: boolean, label: string, detail?: unknown) => void;

/** Real SQLite, plans, completion guards and review commands; only the live PTY/attention boundary is a fixture. */
export async function runRelayAutomationSmoke(check: Check, say: (text: string) => void): Promise<void> {
  say('── relay automation · accepted plans, current gates, free verification and human review');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-relay-automation-'));
  const { db } = await import('./db');
  const { addProject } = await import('./store');
  const control = await import('./control');
  const relay = await import('./relay');
  const automation = await import('./relay-automation');
  const plans = await import('./goal-plans');
  const review = await import('./review');
  const sessions: Session[] = [];
  let projectId: string | null = null;
  const realFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = (async () => { networkCalls++; throw new Error('Automation smoke refuses network access'); }) as typeof realFetch;
  try {
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
    git('init', '-q', '-b', 'main'); git('config', 'user.email', 'smoke@wanigan.test'); git('config', 'user.name', 'Smoke');
    fs.writeFileSync(path.join(repo, 'README.md'), '# Automatic progression fixture\n');
    git('add', '-A'); git('commit', '-qm', 'base');
    const project = await addProject(repo); projectId = project.id;
    const recipe = 'if [ -f .verification-fails ]; then echo "error: fixture gate failed"; exit 1; fi; echo "fixture gate passed"';
    review.saveRecipe(project.id, [recipe]);
    const create = (intent: string, automatic: boolean) => relay.createRelay({
      projectId: project.id, intent, providerId: 'claude', delivery: false,
      routing: { mode: 'manual', preference: 'cost' }, ...(automatic ? { automation: { budgetUsd: 5 } } : {}),
    });
    const manual = await create('Manual progress remains a deliberate choice.', false);
    check(!manual.automaticProgress && !manual.docket.autopilot.enabled,
      'a relay without explicit automation stays manual');
    for (const invalid of [{}, { budgetUsd: 0 }, { budgetUsd: -1 }, { budgetUsd: NaN }, { budgetUsd: Infinity }, { budgetUsd: 1, extra: true }]) {
      let refused = false;
      try { automation.readAutomation(invalid, project.id); } catch { refused = true; }
      check(refused, 'automatic progress refuses an invalid or implicit spending allowance');
    }
    const created = await create('Progress through proved local work.', true);
    const goalId = created.docket.id;
    const node = (kind: string) => control.docket(goalId).nodes.find(value => value.kind === kind)!;
    check(created.automaticProgress && created.docket.autopilot.enabled && created.docket.budgetUsd === 5
      && created.docket.gate.onStop && created.docket.gate.returnFailures,
    'explicit automation records its allowance and enables the existing stop gate and bounded hand-back');
    const seedSession = (nodeId: string): Session => {
      const at = Date.now(); const id = `s_auto_fixture_${randomUUID()}`;
      db().prepare(`INSERT INTO session_log (id,provider_id,backend_id,harness_id,project_id,project_path,project_name,started_at)
        VALUES (?,'claude','anthropic','claude-code',?,?,?,?)`).run(id, project.id, repo, project.name, at);
      db().prepare("UPDATE work_nodes SET status='running',session_id=?,started_at=? WHERE id=?").run(id, at, nodeId);
      const value: Session = { id, providerId: 'claude', projectId: project.id, projectPath: repo,
        projectName: project.name, title: 'Offline fixture', status: 'running', pid: null, exitCode: null,
        createdAt: at, endedAt: null, unread: 0 };
      sessions.push(value); return value;
    };
    let kind: AttentionKind = 'finished'; let transition = 'event:91000'; let reads = 0; let moveOnAtCommit = false;
    const attention = (session: Session): Attention => ({
      sessionId: session.id, kind: moveOnAtCommit && ++reads > 1 ? 'working' : kind,
      transitionId: transition, since: Date.now(), label: 'Offline fixture', detail: null, tool: null,
    });
    const deps = { sessions: () => sessions, attention };
    const advance = () => automation.advanceAutomaticRelays(deps);
    const plan = node('plan'); const planningSession = seedSession(plan.id);
    const capture = (state: 'proposed' | 'accepted', at: number, text: string) => plans.recordGoalPlan(planningSession.id,
      { source: state, plan: text, planFilePath: null, edited: false }, at);
    capture('proposed', planningSession.createdAt, 'Proposed fixture plan.');
    await advance();
    check(node('plan').status === 'running', 'a stopped planner with only a proposal is not advanced');
    capture('accepted', planningSession.createdAt - 1000, 'An accepted plan from a previous attempt.');
    await advance();
    check(node('plan').status === 'running', 'an old accepted plan on a retried node cannot authorize its new session');
    capture('accepted', planningSession.createdAt + 1, 'Accepted plan for this fixture attempt.');
    kind = 'permission'; await advance();
    check(node('plan').status === 'running', 'an accepted plan cannot advance while the CLI is asking permission');
    kind = 'finished'; transition = 'exit:fixture'; await advance();
    check(node('plan').status === 'running', 'a finished label without a recorded stop transition is not enough');
    transition = 'event:91001'; moveOnAtCommit = true; reads = 0;
    await advance();
    check(node('plan').status === 'running', 'an agent beginning another turn during validation prevents automatic completion at commit');
    moveOnAtCommit = false; transition = 'event:91002';
    await advance();
    check(node('plan').status === 'completed' && node('estimate').status === 'completed' && node('implement').status === 'ready',
      'an accepted current plan and recorded stop advance through the deterministic estimate to implementation');

    const implementingSession = seedSession(node('implement').id);
    transition = 'event:91003'; await advance();
    check(node('implement').status === 'running', 'a stopped implementer cannot advance without a passed gate');
    fs.writeFileSync(path.join(repo, '.verification-fails'), '');
    const failing = await control.runProof(node('implement').id);
    await advance();
    check(failing.status === 'failed' && node('implement').status === 'running', 'failed review commands keep implementation visible for repair');
    fs.rmSync(path.join(repo, '.verification-fails'));
    const passed = await control.runProof(node('implement').id);
    fs.appendFileSync(path.join(repo, 'README.md'), 'Changed after verification.\n');
    await advance();
    check(passed.status === 'passed' && node('implement').status === 'running',
      'a historical pass for changed checkout bytes cannot advance implementation');
    await control.runProof(node('implement').id);
    transition = 'event:91004';
    await advance();
    check(node('implement').status === 'completed' && node('verify').status === 'ready',
      'a current passed gate advances implementation without weakening its verification requirement');
    const sessionCount = () => (db().prepare('SELECT COUNT(*) AS n FROM session_log').get() as { n: number }).n;
    const beforeVerification = sessionCount();
    await control.startQueuedNode(node('verify').id, 'relay-verification');
    check(node('verify').status === 'completed' && node('review').status === 'ready'
      && sessionCount() === beforeVerification && control.docket(goalId).autopilot.spendStatus === 'unreported',
    'deterministic verification uses the actual review commands with unknown prior dollar usage and starts no model session');
    await advance();
    check(node('review').status === 'ready' && control.docket(goalId).status !== 'accepted'
      && !control.docket(goalId).proofs.some(proof => proof.nodeId === node('review').id && proof.kind === 'decision'),
    'automatic progress stops at human review without inventing an approval');
    automation.setAutomation(goalId, null);
    const disarmed = relay.readRelay(goalId);
    check(!disarmed.automaticProgress && !disarmed.docket.autopilot.enabled && !disarmed.docket.gate.returnFailures,
      'turning automatic progress off also disables paid failure hand-backs');

    const failedVerification = await create('A failed free verifier stops once.', true);
    const failedGoal = failedVerification.docket.id;
    db().prepare("UPDATE work_nodes SET status='completed' WHERE docket_id=? AND kind IN ('plan','estimate','implement')").run(failedGoal);
    const verifyId = failedVerification.docket.nodes.find(value => value.kind === 'verify')!.id;
    fs.writeFileSync(path.join(repo, '.verification-fails'), '');
    await control.startQueuedNode(verifyId, 'relay-verification');
    const failedRead = control.docket(failedGoal);
    check(failedRead.nodes.find(value => value.id === verifyId)?.status === 'failed' && !failedRead.autopilot.enabled
      && sessionCount() === beforeVerification,
    'a failed deterministic verifier records failure and disarms instead of retrying forever or starting a paid verifier');
    check(networkCalls === 0 && sessions.length === 2 && implementingSession.id !== planningSession.id,
      'progression fixtures made no network requests and used only the two explicitly seeded session records');
  } catch (error) {
    check(false, 'automatic Relay progression smoke ran without throwing', String(error));
  } finally {
    globalThis.fetch = realFetch;
    if (projectId) db().prepare('DELETE FROM projects WHERE id=?').run(projectId);
    for (const session of sessions) db().prepare('DELETE FROM session_log WHERE id=?').run(session.id);
    fs.rmSync(repo, { recursive: true, force: true });
  }
}
