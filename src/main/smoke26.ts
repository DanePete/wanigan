import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { app } from 'electron';
import type { Session, SessionEvent } from '../shared/types';

type Check = (ok: boolean, label: string, detail?: unknown) => void;
type Say = (s: string) => void;

const appSource = (rel: string) => fs.readFileSync(path.join(app.getAppPath(), rel), 'utf8');
/** Check details are printed with String(); an object would read as [object Object]. */
const show = (value: unknown) => (JSON.stringify(value) ?? String(value)).slice(0, 800);

/**
 * Verified done: the review gate runs when a goal's agent stops, a failure can
 * be typed back into that session under a cap, and an implementation task is
 * held until a gate passes.
 *
 * Driven against a real git repository and the project's real review gate, a
 * shell command whose result is chosen by a file in the tree. No agent is
 * launched: the session is a row, and the terminal is a recorder standing in
 * for the PTY, so the bytes a hand-back would type are checked exactly.
 */
export async function runVerifiedDoneSmoke(check: Check, say: Say): Promise<void> {
  say('── goals · verified done: the gate on stop, hand-back, and the hold on completion');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-verified-'));
  const session = `s_verified_${Date.now().toString(36)}`;
  const { db } = await import('./db');
  try {
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' }).toString();
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'smoke@wanigan.test');
    git('config', 'user.name', 'Smoke');
    fs.mkdirSync(path.join(repo, 'src'));
    fs.writeFileSync(path.join(repo, 'README.md'), '# verified\n');
    fs.writeFileSync(path.join(repo, 'src/pay.ts'), 'export function pay() { return charge(); }\n');
    git('add', '-A'); git('commit', '-qm', 'base');

    const { addProject } = await import('./store');
    const review = await import('./review');
    const control = await import('./control');
    const goalGate = await import('./goal-gate');
    const { halted } = await import('./halt');
    const project = await addProject(repo);
    const goal = control.createDocket({ projectId: project.id, title: 'Charge once',
      objective: 'Retries must not charge twice.', acceptance: ['One charge per key.'], risk: 'low' });
    const planNode = goal.nodes.find((node) => node.kind === 'plan')!;
    const implement = goal.nodes.find((node) => node.kind === 'implement')!;
    check(!halted(), 'no halt is engaged, so the gate checks below measure the gate and not the halt');

    const writes: string[] = [];
    let transition = '';
    const deps = {
      session: (id: string) => id === session ? ({ id: session, status: 'running' } as Session) : null,
      attention: () => ({ kind: 'finished' as const, transitionId: transition }),
      write: (_id: string, data: string) => { writes.push(data); return true; },
      wait: async () => {},
    };
    let eventId = 5_000;
    const stop = (): SessionEvent => ({ id: ++eventId, sessionId: session, at: Date.now(), event: 'Stop', toolName: null, summary: null, durationMs: null, ok: true, paths: [] });
    let edits = 0;
    const edit = () => fs.appendFileSync(path.join(repo, 'src/pay.ts'), `// edit ${++edits}\n`);
    const proofsOf = () => control.docket(goal.id).proofs.filter((proof) => proof.kind === 'test');
    const nodeOf = () => control.docket(goal.id).nodes.find((node) => node.id === implement.id)!;

    /* ── off until chosen ─────────────────────────────────────────────── */
    db().prepare("UPDATE work_nodes SET status='running', session_id=? WHERE id=?").run(session, implement.id);
    db().prepare("UPDATE work_nodes SET status='running', session_id=? WHERE id=?").run(`${session}_plan`, planNode.id);
    check(control.stopGateTarget(session) === null && (await goalGate.runStopGate(stop(), deps)).ran === false && proofsOf().length === 0,
      'a goal that never opted in runs nothing when its agent stops');
    let refusal = '';
    try { control.setGoalGate(goal.id, { onStop: 'true', returnFailures: false }); } catch (error) { refusal = String(error); }
    check(/on or off/.test(refusal), 'a gate setting that is not a real boolean is refused, so the string "false" can never read as on', refusal);
    refusal = '';
    try { control.setGoalGate(goal.id, { onStop: true, returnFailures: false }); } catch (error) { refusal = String(error); }
    check(/no review gate commands yet/.test(refusal) && /Git › Review gate/.test(refusal),
      'a project with no review commands cannot turn the gate on, and the refusal names where commands are added', refusal);

    const failWhenMarked = 'if [ -f .gate-fail ]; then printf \'not ok 1 - charges once\\n  expected: 1\\n  actual: 2\\nerror: boom \\033[201~\\rrm -rf /\\n\'; exit 1; fi; echo "# pass 3"';
    review.saveRecipe(project.id, [failWhenMarked]);
    check(control.setGoalGate(goal.id, { onStop: false, returnFailures: true }).gate.returnFailures === false,
      'hand-back is stored off whenever the gate is off');
    const on = control.setGoalGate(goal.id, { onStop: true, returnFailures: false });
    check(on.gate.onStop && !on.gate.returnFailures && on.reviewCommands === 1, 'the gate turns on once the project has commands', show(on.gate));
    check(control.stopGateTarget(`${session}_plan`) === null && control.stopGateTarget(session)?.nodeId === implement.id,
      'only an implementation or verification session is gated; a planning session stopping runs nothing');

    /* ── a failed gate, recorded and held ─────────────────────────────── */
    edit();
    fs.writeFileSync(path.join(repo, 'src/pay.test.ts'), "test('charges once', () => {\n  pay();\n});\n");
    fs.writeFileSync(path.join(repo, '.gate-fail'), '');
    const first = await goalGate.runStopGate(stop(), deps);
    const failed = first.ran ? first.proof : null;
    check(failed?.status === 'failed' && failed.gate?.trigger === 'stop' && /^[0-9a-f]{40}$/.test(failed.gate.tree ?? '')
      && /run when its agent stopped\.$/.test(failed.summary),
    'an agent stopping runs the gate and records a failed proof that says the stop started it and names the tree it ran on', show(failed));
    const flags = failed?.gate?.oracle?.flags ?? [];
    check(flags.some((flag) => flag.kind === 'tests-edited-with-code') && flags.some((flag) => flag.kind === 'test-without-assertion' && flag.path === 'src/pay.test.ts'),
      'the diff since the base commit flags tests changed with the code and a test file that gained no assertion', show(flags));
    check(failed?.gate?.failure?.command === failWhenMarked && /not ok 1 - charges once/.test(failed.gate.failure.excerpt)
      && failed.gate.handBack?.sent === false && /off for this goal/.test(failed.gate.handBack.sentence),
    'the failing command and its error lines are kept, and with hand-back off the failure waits and says so', show(failed?.gate));
    const shown = control.docket(goal.id).proofs.find((proof) => proof.id === failed?.id);
    check(!!shown?.gate && !('cwd' in shown.gate) && !JSON.stringify(shown).includes(repo),
      'the proof the renderer reads carries the gate detail and never the working-copy path', show(shown));
    let held = '';
    try { await control.completeNode(implement.id, {}); } catch (error) { held = String(error); }
    check(/holds implementation tasks until the review gate passes/.test(held) && nodeOf().status === 'running',
      'an implementation task on a gated goal cannot be completed while its latest gate failed', held);

    const again = await goalGate.runStopGate(stop(), deps);
    check(!again.ran && again.reason === 'unchanged' && proofsOf().length === 1,
      'a second stop on the same tree is skipped and writes nothing, so a question from the agent does not rerun the suite', show(again));

    /* ── hand-back ───────────────────────────────────────────────────── */
    control.setGoalGate(goal.id, { onStop: true, returnFailures: true });
    edit();
    let event = stop(); transition = `event:${event.id}`;
    const uncapped = await goalGate.runStopGate(event, deps);
    check(uncapped.ran && uncapped.handBack?.sent === false && /Set a budget/.test(uncapped.handBack.sentence)
      && writes.length === 0 && nodeOf().gateReturns === 0,
    'opted-in automatic hand-back cannot launch another agent turn without a budget', show(uncapped));
    control.setDocketBudget(goal.id, 20);
    edit(); event = stop(); transition = `event:${event.id}`;
    const unmetered = await goalGate.runStopGate(event, deps);
    check(unmetered.ran && unmetered.handBack?.sent === false && /no reported cost/.test(unmetered.handBack.sentence)
      && writes.length === 0 && control.stopGateTarget(session)?.spendStatus === 'unreported',
    'zero numeric spend with no dollar meter refuses the automatic failure prompt', show(unmetered));
    for (const id of [session, `${session}_plan`]) db().prepare(`INSERT INTO session_log
      (id,provider_id,backend_id,harness_id,project_path,project_name,started_at)
      VALUES (?,'claude','anthropic','claude-code',?,'Verified done fixture',?)`).run(id, repo, Date.now());
    db().prepare(`INSERT INTO session_metrics (session_id,metric,attrs,value,last_at)
      VALUES (?,'claude_code.cost.usage','',0,?)`).run(session, Date.now());
    edit(); event = stop(); transition = `event:${event.id}`;
    const partial = await goalGate.runStopGate(event, deps);
    check(partial.ran && partial.handBack?.sent === false && /no reported cost/.test(partial.handBack.sentence)
      && writes.length === 0 && control.stopGateTarget(session)?.spendStatus === 'partial',
    'an explicitly metered zero does not hide an unmetered earlier task', show(partial));
    db().prepare(`INSERT INTO session_metrics (session_id,metric,attrs,value,last_at)
      VALUES (?,'claude_code.cost.usage','',0,?)`).run(`${session}_plan`, Date.now());
    edit(); event = stop(); transition = `event:${event.id}`;
    const handed = await goalGate.runStopGate(event, deps);
    const paste = writes[0] ?? '';
    check(handed.ran && handed.handBack?.sent === true && handed.handBack.attempt === 1 && writes.length === 2 && writes[1] === '\r',
      'a failed gate on a session still waiting where it stopped is typed back as one paste followed by Enter', show({ handBack: handed.ran ? handed.handBack : handed, writes: writes.length }));
    check(paste.startsWith('\x1b[200~') && paste.endsWith('\x1b[201~') && paste.split('\x1b[201~').length === 2
      && !paste.slice(6, -6).includes('\x1b') && !paste.includes('\r') && /not ok 1 - charges once/.test(paste),
    'the paste holds the error lines, and the escape the gate output tried to smuggle in cannot close it early', JSON.stringify(paste.slice(0, 400)));
    check(nodeOf().gateReturns === 1 && proofsOf()[0]?.gate?.handBack?.attempt === 1,
      'the hand-back is counted on the task and written into the proof');
    check(control.traces(goal.id, 20).some((trace) => trace.source === 'gate' && trace.kind === 'gate_hand_back'),
      'typing into the session is recorded in the goal\'s activity');

    db().prepare(`INSERT OR REPLACE INTO session_metrics (session_id,metric,attrs,value,last_at)
      VALUES (?, 'claude_code.cost.usage', '', 9.5, ?)`).run(session, Date.now());
    control.setDocketBudget(goal.id, 5);
    edit(); event = stop(); transition = `event:${event.id}`;
    const capped = await goalGate.runStopGate(event, deps);
    check(capped.ran && capped.handBack?.sent === false && /reached.*budget/.test(capped.handBack.sentence) && writes.length === 2,
      'no hand-back is sent once the goal\'s reported spend reaches its cap', show(capped.ran ? capped.handBack : capped));
    control.setDocketBudget(goal.id, 20);

    edit(); event = stop(); transition = 'event:1';
    const movedOn = await goalGate.runStopGate(event, deps);
    check(movedOn.ran && movedOn.handBack?.sent === false && /moved on/.test(movedOn.handBack.sentence) && writes.length === 2,
      'nothing is typed over a session that moved on while the gate ran', show(movedOn.ran ? movedOn.handBack : movedOn));

    edit(); event = stop(); transition = `event:${event.id}`;
    const second = await goalGate.runStopGate(event, deps);
    check(second.ran && second.handBack?.attempt === 2 && writes.length === 4 && /It is the last one/.test(writes[2] ?? ''),
      'the second hand-back says it is the last one', show(second.ran ? second.handBack : second));
    edit(); event = stop(); transition = `event:${event.id}`;
    const limited = await goalGate.runStopGate(event, deps);
    check(limited.ran && limited.handBack?.sent === false && /already had 2 failures handed back/.test(limited.handBack.sentence) && writes.length === 4,
      'past the limit a failure waits for the operator, and nothing more is typed', show(limited.ran ? limited.handBack : limited));

    /* ── a pasted failure is not permission to submit later ──────────── */
    for (const change of ['permission', 'new-stop', 'session-exit', 'opt-out', 'cap', 'unmetered', 'gate-off'] as const) {
      db().prepare('UPDATE work_nodes SET gate_returns=0 WHERE id=?').run(implement.id);
      edit(); event = stop(); transition = `event:${event.id}`;
      let delayed = false;
      const before = writes.length;
      const raced = await goalGate.runStopGate(event, {
        ...deps,
        session: (id) => delayed && change === 'session-exit' ? null : deps.session(id),
        attention: () => ({ kind: delayed && change === 'permission' ? 'permission' : 'finished', transitionId: transition }),
        wait: async () => {
          delayed = true;
          if (change === 'new-stop') transition = 'event:newer';
          if (change === 'opt-out') control.setGoalGate(goal.id, { onStop: true, returnFailures: false });
          if (change === 'cap') control.setDocketBudget(goal.id, 5);
          if (change === 'unmetered') db().prepare('DELETE FROM session_metrics WHERE session_id=?').run(session);
          if (change === 'gate-off') control.setGoalGate(goal.id, { onStop: false, returnFailures: false });
        },
      });
      check(raced.ran && raced.handBack?.sent === false && raced.handBack.attempt === 1
        && /pasted but not submitted/.test(raced.handBack.sentence) && nodeOf().gateReturns === 1
        && writes.length === before + 1 && writes[before]?.startsWith('\x1b[200~'),
      `a ${change} change during the paste delay withholds Enter and keeps the counted attempt`, show(raced));
      control.setGoalGate(goal.id, { onStop: true, returnFailures: true });
      control.setDocketBudget(goal.id, 20);
      db().prepare(`INSERT OR REPLACE INTO session_metrics (session_id,metric,attrs,value,last_at)
        VALUES (?, 'claude_code.cost.usage', '', 9.5, ?)`).run(session, Date.now());
    }
    db().prepare('UPDATE work_nodes SET gate_returns=0 WHERE id=?').run(implement.id);
    edit(); event = stop(); transition = `event:${event.id}`;
    const beforeRefusedEnter = writes.length;
    const tracesBeforeRefusedEnter = control.traces(goal.id, 200).filter((trace) => trace.kind === 'gate_hand_back').length;
    const enterRefused = await goalGate.runStopGate(event, {
      ...deps, write: (id, data) => data === '\r' ? false : deps.write(id, data),
    });
    check(enterRefused.ran && enterRefused.handBack?.sent === false && enterRefused.handBack.attempt === 1
      && /refused Enter/.test(enterRefused.handBack.sentence) && nodeOf().gateReturns === 1
      && writes.length === beforeRefusedEnter + 1
      && control.traces(goal.id, 200).filter((trace) => trace.kind === 'gate_hand_back').length === tracesBeforeRefusedEnter,
    'a refused Enter is recorded as unsubmitted and never writes a successful hand-back trace', show(enterRefused));

    /* ── refusals and the operator's own run ─────────────────────────── */
    db().prepare('UPDATE work_nodes SET worktree=? WHERE id=?').run(path.join(repo, 'gone-worktree'), implement.id);
    edit();
    const refused = await goalGate.runStopGate(stop(), deps);
    check(!refused.ran && refused.reason === 'refused'
      && control.traces(goal.id, 20).some((trace) => trace.kind === 'gate_on_stop' && trace.status === 'failed' && /no longer on disk/.test(trace.summary ?? '')),
    'a gate that cannot run after a stop leaves a failed activity row saying why, instead of silence', show(refused));
    db().prepare('UPDATE work_nodes SET worktree=NULL WHERE id=?').run(implement.id);

    const operatorRun = control.runProof(implement.id);
    const runningSince = nodeOf().gateRunningSince;
    let busy = '';
    try { await control.runProof(implement.id); } catch (error) { busy = String(error); }
    const operatorProof = await operatorRun;
    check(runningSince !== null && /already running/.test(busy) && operatorProof.gate?.trigger === 'operator' && nodeOf().gateRunningSince === null,
      'a gate in flight shows on the task, a second run of the same tree is refused, and a button press is recorded as the operator\'s', show({ runningSince, busy }));

    /* ── a successful command is not a pass for a changed checkout ──── */
    review.saveRecipe(project.id, ["printf '\\nchanged by the review command\\n' >> README.md"]);
    db().prepare('UPDATE work_nodes SET gate_returns=0 WHERE id=?').run(implement.id);
    edit(); event = stop(); transition = `event:${event.id}`;
    const writesBeforeStale = writes.length;
    const stale = await goalGate.runStopGate(event, deps);
    let staleHeld = '';
    try { await control.completeNode(implement.id, {}); } catch (error) { staleHeld = String(error); }
    check(stale.ran && stale.proof.status === 'recorded' && /Current checkout not verified/.test(stale.proof.summary)
      && stale.handBack === null && stale.proof.gate?.failure === null && writes.length === writesBeforeStale
      && nodeOf().gateReturns === 0 && nodeOf().status === 'running' && /current checkout and commands/.test(staleHeld),
    'a zero-exit stop gate that changes checkout bytes neither verifies completion nor spends a failure hand-back',
    show({ stale, staleHeld, writes: writes.length - writesBeforeStale }));
    review.saveRecipe(project.id, [failWhenMarked]);

    /* ── reopen, pass, complete ──────────────────────────────────────── */
    control.onSessionExit(session);
    control.retryNode(implement.id);
    check(nodeOf().gateReturns === 0, 'reopening a task gives its next run a fresh hand-back allowance');
    db().prepare("UPDATE work_nodes SET status='running', session_id=? WHERE id=?").run(session, implement.id);
    fs.rmSync(path.join(repo, '.gate-fail'));
    fs.writeFileSync(path.join(repo, 'src/pay.test.ts'), "test('charges once', () => {\n  assert.equal(pay(), 1);\n});\n");
    const passed = await goalGate.runStopGate(stop(), deps);
    const passedFlags = passed.ran ? passed.proof.gate?.oracle?.flags ?? [] : [];
    check(passed.ran && passed.proof.status === 'passed' && passed.handBack === null
      && passedFlags.length === 1 && passedFlags[0].kind === 'tests-edited-with-code',
    'once the change passes, the gate records a pass, and an asserting test clears its flag while tests changed with code stay flagged', show(passed));
    const done = await control.completeNode(implement.id, {});
    const scratch = path.join(app.getPath('userData'), 'gate-index', `${implement.id}.index`);
    check(done.status === 'completed' && !fs.existsSync(scratch) && control.stopGateTarget(session) === null,
      'a passed gate lets the task complete, its scratch index is removed, and a completed task is no longer gated');

    const index = appSource('src/main/index.ts');
    const preload = appSource('src/preload/index.ts');
    const view = appSource('src/renderer/src/views/Control.tsx');
    check(index.includes('goalGate.initGoalGate(') && appSource('src/main/modules/control.ts').includes("handle('control:setGate'")
      && preload.includes("call<DocketDetail>('control:setGate'") && view.includes('window.wanigan.control.setGate(goal') === false
      && view.includes('window.wanigan.control.setGate(docket.id'),
    'the stop listener starts with the app and the Control view can reach the setting, so the gate is reachable and not only callable');
  } catch (error) {
    check(false, 'the verified-done checks ran without throwing', String(error));
  } finally {
    for (const id of [session, `${session}_plan`]) {
      try { db().prepare('DELETE FROM session_metrics WHERE session_id=?').run(id); } catch { /* fixture row */ }
      try { db().prepare('DELETE FROM session_log WHERE id=?').run(id); } catch { /* fixture row */ }
    }
    try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* temp */ }
  }
}
