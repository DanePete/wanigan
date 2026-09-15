import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { app } from 'electron';

type Check = (ok: boolean, label: string, detail?: unknown) => void;
type Say = (s: string) => void;

const appSource = (rel: string) => fs.readFileSync(path.join(app.getAppPath(), rel), 'utf8');

/**
 * A goal's plan is captured from its planning session and reaches the tasks
 * after it.
 *
 * The plan task ran in plan mode and its plan went nowhere; the implementation
 * task was launched with titles and statuses only. These checks drive the
 * capture with ExitPlanMode hook bodies shaped as the 2.1.271 binary's schema
 * declares, against a real goal.
 */
export async function runGoalPlanSmoke(check: Check, say: Say): Promise<void> {
  say('── goals · the accepted plan is kept as evidence and handed to the next task');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-plan-'));
  try {
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' }).toString();
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'smoke@wanigan.test');
    git('config', 'user.name', 'Smoke');
    fs.writeFileSync(path.join(repo, 'README.md'), '# plan\n');
    git('add', '-A'); git('commit', '-qm', 'base');

    const { db } = await import('./db');
    const { addProject } = await import('./store');
    const control = await import('./control');
    const plans = await import('./goal-plans');
    const { goalCapsuleText } = await import('./sessions');
    const project = await addProject(repo);
    const goal = control.createDocket({ projectId: project.id, title: 'Idempotent retries',
      objective: 'Stop duplicate charges.', acceptance: ['One charge per key.'], risk: 'low' });
    const planNode = goal.nodes.find((node) => node.kind === 'plan')!;
    const implement = goal.nodes.find((node) => node.kind === 'implement')!;
    const planSession = `s_plan_${Date.now().toString(36)}`;
    db().prepare('UPDATE work_nodes SET session_id=? WHERE id=?').run(planSession, planNode.id);

    const fake = ['sk', 'ant', 'api03', 'Z'.repeat(40)].join('-');
    const proposal = `1. Add an idempotency key column.\n2. Reuse the stored payment when the key matches.\n3. Test with key ${fake}.`;
    const proposed = plans.planFromHook('PermissionRequest', 'ExitPlanMode', {
      hook_event_name: 'PermissionRequest', tool_name: 'ExitPlanMode',
      tool_input: { plan: proposal, planFilePath: '/Users/x/.claude/plans/retries.md' }, permission_suggestions: [],
    });
    check(proposed?.source === 'proposed' && proposed.plan === proposal,
      'the plan in an ExitPlanMode permission request is read as a proposal', proposed);
    check(plans.planFromHook('PermissionRequest', 'Bash', { tool_input: { plan: 'not a plan' } }) === null,
      'no other tool\'s input is ever read as a plan');
    check(plans.recordGoalPlan(planSession, proposed!) && !plans.recordGoalPlan(planSession, proposed!),
      'a proposal is recorded once, however many times the permission request repeats');
    check(plans.recordGoalPlan('s_not_goal_work', proposed!) === false,
      'a session that is not goal work records nothing');
    const firstRead = plans.latestGoalPlan(goal.id);
    check(firstRead?.state === 'proposed' && !firstRead.text.includes(fake),
      'the stored plan is the proposal, with a credential in it redacted', firstRead?.state);

    const accepted = plans.planFromHook('PostToolUse', 'ExitPlanMode', {
      hook_event_name: 'PostToolUse', tool_name: 'ExitPlanMode', tool_input: { plan: proposal },
      tool_response: { plan: `${proposal}\n4. Log the duplicate.`, isAgent: false, filePath: '/Users/x/.claude/plans/retries.md', planWasEdited: true },
    });
    plans.recordGoalPlan(planSession, accepted!);
    const latest = plans.latestGoalPlan(goal.id);
    check(latest?.state === 'accepted' && latest.edited && latest.text.endsWith('4. Log the duplicate.'),
      'the plan as accepted, edits included, replaces the proposal as the goal\'s plan', latest);

    const capsule = control.goalCapsuleFor(implement.id);
    const text = goalCapsuleText(capsule);
    check(capsule.plan?.state === 'accepted' && new RegExp(`The plan accepted in "${planNode.title}" .*edited by the person before accepting.*written by the planning agent`, 's').test(text)
      && text.includes('  4. Log the duplicate.'),
    'the implementation task\'s launch capsule carries the accepted plan, labelled as the planning agent\'s words', text.slice(-400));
    check(control.goalCapsuleFor(planNode.id).plan === null, 'the planning task itself is not handed its own plan');

    const long = plans.planFromHook('PostToolUse', 'ExitPlanMode', { tool_response: { plan: 'step\n'.repeat(20_000) } });
    plans.recordGoalPlan(planSession, long!);
    const longText = goalCapsuleText(control.goalCapsuleFor(implement.id));
    check((plans.latestGoalPlan(goal.id)?.text.length ?? 0) <= plans.PLAN_MAX_CHARS && /The plan is cut short here/.test(longText),
      'a plan past the bound is kept to its first part, and the capsule says it was cut');
    check(control.docket(goal.id).proofs.some((proof) => proof.kind === 'plan' && /written by the agent\.$/.test(proof.summary) && !proof.summary.includes('idempotency')),
      'the proof row says whose words the plan is, and its summary carries no plan text to the phone');

    const hooks = appSource('src/main/hooks.ts');
    const evidence = appSource('src/renderer/src/components/ReviewEvidence.tsx');
    check(hooks.includes('planFromHook(event, toolName, input as Record<string, unknown>)') && hooks.includes('recordGoalPlan(sessionId, plan, at)')
      && evidence.includes('window.wanigan.control.plan(docket.id)'),
    'the hook bus captures the plan on every stored event, and the goal\'s evidence shows it, so capture is reachable and not only callable');
  } catch (error) {
    check(false, 'the goal plan checks ran without throwing', String(error));
  } finally {
    try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* temp */ }
  }
}
