import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

type Check = (ok: boolean, label: string, detail?: unknown) => void;
type Say = (s: string) => void;

/**
 * Review decisions that reach the work they are about.
 *
 * "Request changes" used to record a note nobody was given and mark the review
 * failed; reopening it put the same, unchanged implementation back in front of
 * the reviewer, because a completed implementation task could not run again.
 * These checks walk a real goal through that decision against a real
 * repository and the real review gate.
 */
export async function runReviewDecisionSmoke(check: Check, say: Say): Promise<void> {
  say('── goals · a requested change reaches the implementation');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-changes-'));
  try {
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' }).toString();
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'smoke@wanigan.test');
    git('config', 'user.name', 'Smoke');
    fs.writeFileSync(path.join(repo, 'README.md'), '# changes\n');
    git('add', '-A'); git('commit', '-qm', 'base');

    const { addProject, removeProject } = await import('./store');
    const control = await import('./control');
    const review = await import('./review');
    const { goalCapsuleText } = await import('./sessions');
    const phoneGoals = await import('./mobile/goals');
    const project = await addProject(repo);

    const goal = control.createDocket({ projectId: project.id, title: 'Requested change',
      objective: 'Carry a reviewer’s note back to the implementation.', acceptance: ['The note reaches the agent.'], risk: 'low' });
    const byKind = (kind: string) => goal.nodes.find((node) => node.kind === kind)!;
    const [plan, implement, verify, reviewTask] = ['plan', 'implement', 'verify', 'review'].map(byKind);
    const read = () => control.docket(goal.id);
    const statusOf = (id: string) => read().nodes.find((node) => node.id === id)!.status;

    control.completeNode(plan.id, { detail: 'Planned.' });
    control.completeNode(implement.id, { detail: 'Implemented.' });
    review.saveRecipe(project.id, ['true']);
    await control.runProof(verify.id);
    control.completeNode(verify.id, { detail: 'Gate passed.' });
    const note = 'Keep the retry idempotent: return the stored payment when the key matches, and add a regression test.';
    control.completeNode(reviewTask.id, { decision: 'request_changes', detail: note });

    check(statusOf(reviewTask.id) === 'failed' && statusOf(implement.id) === 'completed',
      'recording "Request changes" marks the review failed and leaves the work alone until someone reopens it');
    const decisionProof = read().proofs.find((proof) => proof.kind === 'decision' && proof.nodeId === reviewTask.id);
    check(!!decisionProof && !decisionProof.summary.includes('idempotent'),
      'the note is kept off the decision summary, which crosses to a paired phone', decisionProof?.summary);

    control.retryNode(reviewTask.id);
    check(statusOf(implement.id) === 'ready' && statusOf(verify.id) === 'blocked'
      && statusOf(reviewTask.id) === 'blocked' && statusOf(plan.id) === 'completed',
    'reopening a review that asked for changes sends the implementation and verification back, and leaves the plan standing',
    read().nodes.map((node) => `${node.kind}:${node.status}`));

    const capsule = control.goalCapsuleFor(implement.id);
    check(capsule.changesRequested.length === 1 && capsule.changesRequested[0].note === note,
      'the reopened implementation task’s goal capsule carries the reviewer’s note', capsule.changesRequested);
    const text = goalCapsuleText(capsule);
    check(text.includes('A human reviewer requested changes') && text.includes(note),
      'and the capsule text an agent reads at launch states the requested change', text);

    control.completeNode(implement.id, { detail: 'Revised.' });
    let refused = '';
    try { control.completeNode(verify.id, { detail: 'Gate passed.' }); }
    catch (error) { refused = error instanceof Error ? error.message : String(error); }
    check(/Run and pass the review gate/.test(refused),
      'the pass recorded before the reopen no longer completes verification: the revised tree needs its own run', refused);
    const phoneBefore = phoneGoals.mobileGoalGate(read());
    check(phoneBefore.state === 'not-run',
      'and the phone’s gate reading agrees: the old pass is not shown as a pass for the revised work', phoneBefore.state);

    await control.runProof(verify.id);
    control.completeNode(verify.id, { detail: 'Gate passed on the revision.' });
    check(statusOf(verify.id) === 'completed' && phoneGoals.mobileGoalGate(read()).state === 'passed',
      'a gate run after the reopen completes verification, and the phone reads it as passed');

    // A review that failed without asking for changes sends nothing back.
    const second = control.createDocket({ projectId: project.id, title: 'Plain reopen', objective: 'Reopen without a decision.',
      acceptance: ['Only the reopened task moves.'], risk: 'low' });
    const sPlan = second.nodes.find((node) => node.kind === 'plan')!;
    control.completeNode(sPlan.id, { decision: 'request_changes', detail: 'Plan again.' });
    control.retryNode(sPlan.id);
    const sRead = control.docket(second.id);
    check(sRead.nodes.every((node) => node.kind === 'plan' ? node.status === 'ready' : node.status !== 'completed'),
      'reopening a task that is not a review reopens only that task');

    removeProject(project.id);
  } catch (error) {
    check(false, 'the requested-change checks ran without throwing', String(error));
  } finally {
    try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* temp */ }
  }
}
