import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { db } from './db';
import { runGit } from './git';
import { addProject } from './store';
import * as control from './control';
import * as review from './review';
import * as queue from './queue';
import * as schedule from './schedule';
import type { DocketPlanNode } from '../shared/types';

type Check = (ok: boolean, label: string, detail?: unknown) => void;

/** Real SQLite and Git; no provider probes, agent sessions or network calls. */
export async function runAuditControlSmoke(check: Check, say: (text: string) => void): Promise<void> {
  say('── audit repairs · goal verification and durable dispatch ownership');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-control-fixes-'));
  const repo = path.join(dir, 'project'), treeA = path.join(dir, 'a'), treeB = path.join(dir, 'b');
  fs.mkdirSync(repo);
  const ownedNodes = new Set<string>(), ownedSchedules = new Set<string>(), ownedRuns = new Set<string>();
  let projectId: string | null = null;
  const git = async (cwd: string, ...args: string[]) => {
    const result = await runGit(cwd, args, { timeout: 15_000 });
    if (!result.ok) throw new Error(result.err);
  };
  const refused = async (run: () => unknown | Promise<unknown>): Promise<string> => {
    try { await run(); return ''; } catch (error) { return String(error); }
  };
  try {
    await git(repo, 'init'); fs.writeFileSync(path.join(repo, 'README.md'), 'fixture\n');
    await git(repo, 'add', '.');
    await git(repo, '-c', 'user.name=Smoke', '-c', 'user.email=smoke@localhost', 'commit', '-m', 'fixture');
    await git(repo, 'worktree', 'add', '-b', 'audit-a', treeA);
    await git(repo, 'worktree', 'add', '-b', 'audit-b', treeB);
    const project = await addProject(repo); projectId = project.id;
    const create = (title: string, plan?: DocketPlanNode[]) => {
      const goal = control.createDocket({ projectId: project.id, title, objective: title, acceptance: ['Observed checks pass.'], budgetUsd: 1, plan });
      goal.nodes.forEach(node => ownedNodes.add(node.id));
      return goal;
    };
    const fanPlan: DocketPlanNode[] = [
      { kind: 'implement', title: 'Branch A', instructions: 'A', dependsOn: [] },
      { kind: 'implement', title: 'Branch B', instructions: 'B', dependsOn: [] },
      { kind: 'verify', title: 'Shared verification', instructions: 'Verify both', dependsOn: [0, 1] },
      { kind: 'review', title: 'Review', instructions: 'Decide', dependsOn: [2] },
    ];
    const fan = create('Ambiguous shared verification', fanPlan);
    const [a, b, verifier, decision] = fan.nodes;
    db().prepare('UPDATE work_nodes SET worktree=? WHERE id=?').run(treeA, a.id);
    db().prepare('UPDATE work_nodes SET worktree=? WHERE id=?').run(treeB, b.id);
    await control.completeNode(a.id, {}); await control.completeNode(b.id, {});
    review.saveRecipe(project.id, ['test ! -f broken']);
    fs.writeFileSync(path.join(treeB, 'broken'), 'branch B fails\n');
    const beforeRuns = review.history(project.id).length;
    check(/multiple implementation checkouts/.test(await refused(() => control.runProof(verifier.id)))
      && review.history(project.id).length === beforeRuns,
    'a shared verifier refuses two implementation checkouts before executing any commands');
    check(/multiple implementation checkouts/.test(await refused(() => control.startNode(verifier.id, { providerId: 'audit-must-not-launch' }))),
      'an ambiguous verification agent is refused before a provider launch');
    const oldRun = await review.runAt(project.id, treeA);
    db().prepare(`INSERT INTO work_proofs (id,docket_id,node_id,kind,status,summary,detail_json,created_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(randomUUID(), fan.id, verifier.id, 'test', 'passed', 'Legacy first-branch proof',
      JSON.stringify({ reviewRunId: oldRun.id, cwd: treeA }), Date.now());
    db().prepare("UPDATE work_nodes SET status='completed' WHERE id=?").run(verifier.id);
    check(/multiple implementation checkouts/.test(await refused(() => control.completeNode(decision.id, {})))
      && control.docket(fan.id).status !== 'accepted',
    'final approval refuses a legacy first-branch proof even when that checkout is still current');

    db().prepare('UPDATE work_nodes SET depends_json=? WHERE id=?').run(JSON.stringify([a.id]), verifier.id);
    check(/every implementation checkout/.test(await refused(() => control.completeNode(decision.id, {}))),
      'a valid branch-A verifier cannot approve a separate branch-B checkout with no verification');

    const same = create('Same checkout through two branches', fanPlan);
    db().prepare('UPDATE work_nodes SET worktree=? WHERE id=?').run(treeA, same.nodes[0].id);
    db().prepare('UPDATE work_nodes SET worktree=? WHERE id=?').run(path.join(treeA, '.'), same.nodes[1].id);
    await control.completeNode(same.nodes[0].id, {}); await control.completeNode(same.nodes[1].id, {});
    check((await control.runProof(same.nodes[2].id)).status === 'passed',
      'multiple implementation nodes in the same canonical checkout remain verifiable');
    await control.completeNode(same.nodes[2].id, {});
    fs.appendFileSync(path.join(treeA, 'README.md'), 'changed after verification\n');
    check(!!await refused(() => control.completeNode(same.nodes[3].id, {})),
      'content changed after completing verification still prevents approval');
    const rerun = await control.runProof(same.nodes[2].id);
    await control.completeNode(same.nodes[3].id, {});
    check(rerun.status === 'passed' && control.docket(same.id).status === 'accepted',
      'deliberately rerunning a completed verifier refreshes its binding and permits current approval');

    queue.registerCancellationHandler('node', payload => {
      const nodeId = (payload as { nodeId?: unknown } | null)?.nodeId;
      if (typeof nodeId === 'string') control.cancelQueuedNode(nodeId);
    });
    const queued = create('Canceled queued task'); const task = queued.nodes[0];
    control.claimPath(task.id, 'claimed-before-launch');
    control.setAutopilot(queued.id, { enabled: true, providerId: 'audit-must-not-launch' });
    control.sweepAutopilot();
    const nodeItems = () => (db().prepare("SELECT id,state,payload_json FROM queue WHERE kind='node'")
      .all() as { id: string; state: string; payload_json: string }[])
      .filter(row => (JSON.parse(row.payload_json) as { nodeId?: string }).nodeId === task.id);
    const first = nodeItems().find(row => row.state === 'waiting')!;
    const canceled = queue.cancelQueued(first.id);
    const canceledNode = control.docket(queued.id).nodes[0];
    check(canceled && canceledNode.status === 'canceled' && !canceledNode.queued
      && control.mcpTasks(queued.id).find(row => row.nodeId === task.id)?.status === 'cancelled'
      && control.docket(queued.id).claims.every(claim => claim.releasedAt !== null),
    'queue cancellation closes its pending task, releases claims and leaves an explicit reopen action');
    control.setAutopilot(queued.id, { enabled: false });
    control.setAutopilot(queued.id, { enabled: true, providerId: 'audit-must-not-launch' });
    control.sweepAutopilot();
    check(!nodeItems().some(row => row.state === 'waiting'), 'rearming cannot silently recreate work the operator canceled');
    control.retryNode(task.id); control.sweepAutopilot();
    const retry = nodeItems().find(row => row.state === 'waiting')!;
    check(!!retry, 'deliberately reopening the canceled task permits a fresh dispatch');
    db().prepare("UPDATE queue SET state='running' WHERE id=?").run(retry.id);
    check(!queue.cancelQueued(retry.id) && control.docket(queued.id).nodes[0].queued,
      'a queue item already claimed by a dispatcher cannot cancel the task underneath it');
    db().prepare("UPDATE queue SET state='canceled' WHERE id=?").run(retry.id);
    control.reconcileRunningNodes();
    check(control.docket(queued.id).nodes[0].status === 'canceled' && !control.docket(queued.id).nodes[0].queued,
      'startup reconciliation repairs a canceled queue row left by an older build');
    control.retryNode(task.id); control.sweepAutopilot();
    const original = nodeItems().find(row => row.state === 'waiting')!;
    const duplicate = queue.enqueue('node', 'Duplicate ownership fixture', { nodeId: task.id });
    queue.cancelQueued(original.id);
    check(control.docket(queued.id).nodes[0].queued, 'canceling one duplicate queue row preserves another active owner');
    queue.cancelQueued(duplicate.id);
    check(control.docket(queued.id).nodes[0].status === 'canceled', 'canceling the final queued owner makes the task reopenable');
    control.setAutopilot(queued.id, { enabled: false });

    const createSchedule = (name: string) => {
      const saved = schedule.createSchedule({ name, cron: '* * * * *', kind: 'headless', projectId: project.id,
        payload: { prompt: 'same scheduled prompt', providerId: 'audit-must-not-launch', providerProfileFingerprint: 'fixture' } });
      ownedSchedules.add(saved.id); return saved;
    };
    const due = (id: string) => db().prepare('UPDATE schedules SET next_at=? WHERE id=?').run(Date.now() - 60_000, id);
    const fireItem = (id: string) => (db().prepare("SELECT id,state,payload_json FROM queue WHERE kind='headless'")
      .all() as { id: string; state: string; payload_json: string }[])
      .find(row => row.state === 'waiting' && (JSON.parse(row.payload_json) as { scheduleId?: string }).scheduleId === id)!;
    const scheduled = createSchedule('Long scheduled work'); due(scheduled.id); await schedule.tickSchedules();
    const parent = fireItem(scheduled.id);
    db().prepare("UPDATE queue SET state='running' WHERE id=?").run(parent.id);
    const fire = schedule.claimFireForRun({ prompt: 'same scheduled prompt', projectIds: [project.id],
      fire: schedule.fireFromQueue(JSON.parse(parent.payload_json)) })!;
    const runId = randomUUID(); ownedRuns.add(runId);
    db().prepare('INSERT INTO runs (id,name,model,status,config_json,created_at) VALUES (?,?,?,?,?,?)')
      .run(runId, 'Scheduled ownership fixture', 'fixture', 'in_progress', JSON.stringify({ scheduleFire: fire }), Date.now());
    db().prepare('INSERT INTO headless_rows (run_id,project_id,project_name,project_path,status) VALUES (?,?,?,?,?)')
      .run(runId, project.id, project.name, project.path, 'pending');
    const child = queue.enqueue('headless', 'Unlaunched repository fixture', { runId, projectId: project.id });
    db().prepare("UPDATE queue SET state='done' WHERE id=?").run(parent.id);
    due(scheduled.id); await schedule.tickSchedules();
    check(schedule.listSchedules().find(row => row.id === scheduled.id)?.runs === 1
      && schedule.scheduleHistory(scheduled.id).some(row => row.status === 'skipped'),
    'a scheduled run retains ownership after its parent hands off to repository queue rows');
    db().prepare('DELETE FROM queue WHERE id=?').run(parent.id);
    due(scheduled.id); await schedule.tickSchedules();
    check(schedule.listSchedules().find(row => row.id === scheduled.id)?.runs === 1,
      'durable linked work still prevents overlap when the parent queue row is gone');
    db().prepare("UPDATE headless_rows SET status='succeeded' WHERE run_id=?").run(runId);
    db().prepare("UPDATE runs SET status='ended' WHERE id=?").run(runId);
    db().prepare("UPDATE queue SET state='done' WHERE id=?").run(child.id);
    due(scheduled.id); await schedule.tickSchedules();
    check(schedule.listSchedules().find(row => row.id === scheduled.id)?.runs === 2
      && (db().prepare('SELECT status FROM schedule_runs WHERE id=?').get(fire.fireId) as { status: string }).status === 'ok',
    'a terminal run recovers a missed outcome callback and releases its schedule for the next fire');
    queue.cancelQueued(fireItem(scheduled.id).id);
    schedule.setScheduleEnabled(scheduled.id, false);

    const twinA = createSchedule('Same prompt schedule A'), twinB = createSchedule('Same prompt schedule B');
    due(twinA.id); due(twinB.id); await schedule.tickSchedules();
    const parents = [fireItem(twinA.id), fireItem(twinB.id)];
    parents.forEach(item => db().prepare("UPDATE queue SET state='running' WHERE id=?").run(item.id));
    const exact = parents.map(item => schedule.claimFireForRun({ prompt: 'same scheduled prompt', projectIds: [project.id],
      fire: schedule.fireFromQueue(JSON.parse(item.payload_json)) }));
    check(exact[0]?.scheduleId === twinA.id && exact[1]?.scheduleId === twinB.id,
      'identical prompts cannot erase or exchange the exact ownership of concurrent schedule fires');
    check(!!await refused(() => schedule.claimFireForRun({ prompt: 'same scheduled prompt', projectIds: [project.id], fire: exact[0]! })),
      'an already-claimed exact fire is refused rather than starting an unowned run');
  } catch (error) { check(false, 'Control audit repair smoke completed', String(error)); }
  finally {
    const rows = db().prepare('SELECT id,payload_json FROM queue').all() as { id: string; payload_json: string }[];
    for (const row of rows) {
      let value: { nodeId?: string; scheduleId?: string; runId?: string } | null = null;
      try { value = JSON.parse(row.payload_json) as { nodeId?: string; scheduleId?: string; runId?: string } | null; } catch { continue; }
      if (value && (ownedNodes.has(value.nodeId ?? '') || ownedSchedules.has(value.scheduleId ?? '') || ownedRuns.has(value.runId ?? ''))) {
        db().prepare('DELETE FROM queue WHERE id=?').run(row.id);
      }
    }
    for (const id of ownedSchedules) schedule.deleteSchedule(id);
    for (const id of ownedRuns) db().prepare('DELETE FROM runs WHERE id=?').run(id);
    if (projectId) db().prepare('DELETE FROM projects WHERE id=?').run(projectId);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
