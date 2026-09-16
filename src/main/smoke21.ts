import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';

type Check = (ok: boolean, label: string, detail?: unknown) => void;
type Say = (s: string) => void;

const appSource = (rel: string) => fs.readFileSync(path.join(app.getAppPath(), rel), 'utf8');

/**
 * A headless run can hold a call for a person instead of refusing it.
 *
 * No agent is spawned here. The policy answers, the result parsing, the resume
 * argv and the row's answer state are each exercised against the real modules
 * and a real SQLite database; the one step not run is a live `claude -p`.
 */
export async function runDeferredApprovalSmoke(check: Check, say: Say): Promise<void> {
  say('── headless · a call that needs approval can be held for a person, and answered once');
  const { db } = await import('./db');
  const policy = await import('./policy');
  const headless = await import('./headless');
  const { providerById } = await import('./providers');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-held-'));
  const nonce = Date.now().toString(36);
  const outside = path.join(os.tmpdir(), `wanigan-held-outside-${nonce}.txt`);
  const runIds: string[] = [];
  const sessionIds = [`held-on-${nonce}`, `held-off-${nonce}`, `held-attended-${nonce}`];
  try {
    const write = (toolUseId: string) => ({
      hook_event_name: 'PreToolUse', tool_name: 'Write', tool_use_id: toolUseId,
      tool_input: { file_path: outside, content: 'hello' },
    });
    const holding = { sessionId: sessionIds[0], projectId: null, projectPath: root, trust: 'project' as const, attended: false, holdAsks: true };
    const refusing = { ...holding, sessionId: sessionIds[1], holdAsks: false };
    const attended = { ...holding, sessionId: sessionIds[2], attended: true };

    const held = policy.answerFor(holding, write('toolu_held_1'));
    check(held?.decision === 'defer' && held.rule === 'project.write-outside.held' && /Held for the operator/.test(held.reason),
      'an unattended run that opted in holds a call its trust level would ask about, instead of denying it', held);
    check(policy.answerFor(refusing, write('toolu_held_2'))?.decision === 'deny',
      'the same call on a run that did not opt in is still denied, which is the default');
    check(policy.answerFor(attended, write('toolu_held_3'))?.decision === 'ask',
      'an attended session is asked as before; holding never applies where a person is present');
    const ledgerRow = policy.ledger(50).find((entry) => entry.sessionId === sessionIds[0] && entry.rule === 'project.write-outside.held');
    check(ledgerRow?.decision === 'defer',
      'the ledger reads a held call back as held, not as the allow an unrecognised decision used to become', ledgerRow?.decision);

    policy.answerHeldCall(sessionIds[0], 'toolu_held_1', { decision: 'allow', note: 'the release script writes there' });
    const approved = policy.answerFor(holding, write('toolu_held_1'));
    const again = policy.answerFor(holding, write('toolu_held_1'));
    check(approved?.decision === 'allow' && approved.rule === 'unattended.held.approved' && /release script/.test(approved.reason)
      && again?.decision === 'defer',
    'a person\'s answer applies to that exact re-emitted call once, and the next identical call is held again', { approved, again });
    check(policy.ledger(50).some((entry) => entry.sessionId === sessionIds[0] && entry.rule === 'unattended.held.approved' && entry.decision === 'allow'),
      'an approved held call is written to the ledger, allow or not');
    policy.answerHeldCall(sessionIds[0], 'toolu_held_4', { decision: 'deny', note: 'write it inside the repo' });
    const declined = policy.answerFor(holding, write('toolu_held_4'));
    check(declined?.decision === 'deny' && /write it inside the repo/.test(declined.reason),
      'a declined held call is refused with the note the person wrote');
    check(/call that needs approval ends the run with the call held/.test(policy.trustBriefing(holding))
      && !/call held for the operator/.test(policy.trustBriefing(refusing)),
    'the agent is told at SessionStart that calls are held on this run, and only on this run');

    const result = headless.parseCliOutput(JSON.stringify({
      type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.03, terminal_reason: 'tool_deferred',
      session_id: `cli-session-${nonce}`, deferred_tool_use: { id: 'toolu_resume', name: 'Bash', input: { command: 'npm publish' } },
    }));
    check(result.outcome.terminalReason === 'tool_deferred' && result.outcome.deferred?.id === 'toolu_resume'
      && result.outcome.sessionId === `cli-session-${nonce}` && result.costUsd === 0.03,
    'a held run\'s result yields the call, the conversation to resume and the cost it already spent', result.outcome);

    const claude = providerById('claude');
    if (claude) {
      const cfg = { name: 'held', providerId: 'claude', projectIds: [], prompt: 'do the release', maxBudgetUsd: 1, timeoutMs: 60_000, isolate: false };
      const resumeArgs = headless.headlessArgs(claude, cfg, { mode: 'acceptEdits', clampArgs: [] }, null, null, { cliSessionId: `cli-session-${nonce}` });
      check(resumeArgs[0] === '-p' && resumeArgs[1] === '--resume' && resumeArgs[2] === `cli-session-${nonce}`
        && !resumeArgs.includes('do the release') && resumeArgs.join(' ').includes('acceptEdits'),
      'a resume continues the held conversation with no new prompt and passes the permission mode again', resumeArgs);
    }

    // ── the row's answer, with a runner that records instead of spawning
    const dispatched: string[] = [];
    headless.registerHeadlessRunner((runId, projectId) => { dispatched.push(`${runId}:${projectId}`); });
    const seedRun = (id: string, config: Record<string, unknown>) => {
      runIds.push(id);
      db().prepare(`INSERT INTO runs (id, name, preset, project_id, model, status, config_json, kind, total_requests, created_at)
        VALUES (?, 'held run', NULL, NULL, 'claude', 'in_progress', ?, 'headless', 2, ?)`).run(id, JSON.stringify(config), Date.now());
    };
    const heldRecord = (toolUseId: string, permissionMode = 'acceptEdits') => JSON.stringify({
      toolUseId, toolName: 'Bash', summary: 'npm publish', cliSessionId: `cli-session-${nonce}`, permissionMode,
      heldAt: Date.now() - 60_000, answer: null, resumedAt: null, baseHead: null, baseDirty: [],
    });
    const seedRow = (runId: string, projectId: string, status: string, heldJson: string | null) => {
      db().prepare(`INSERT INTO headless_rows (run_id, project_id, project_name, project_path, status, held_json)
        VALUES (?, ?, ?, ?, ?, ?)`).run(runId, projectId, projectId, root, status, heldJson);
    };
    const rowOf = (runId: string, projectId: string) => db().prepare('SELECT status, error, held_json FROM headless_rows WHERE run_id=? AND project_id=?')
      .get(runId, projectId) as { status: string; error: string | null; held_json: string | null };

    const runA = `held-run-a-${nonce}`;
    seedRun(runA, { providerId: 'claude', holdForApproval: true, providerProfileFingerprint: 'unused' });
    seedRow(runA, 'repo-one', 'awaiting', heldRecord('toolu_row_1'));
    seedRow(runA, 'repo-two', 'awaiting', heldRecord('toolu_row_2'));
    const listed = headless.headlessRuns(200).find((run) => run.id === runA);
    check(listed?.awaiting === 2 && listed.open === 0, 'the run list counts rows waiting for a person apart from open ones', listed);

    const fake = ['sk', 'ant', 'api03', 'Q'.repeat(40)].join('-');
    const answered = headless.answerHeld(runA, 'repo-one', 'allow', `go ahead, key ${fake}`);
    const one = rowOf(runA, 'repo-one');
    const oneHeld = JSON.parse(one.held_json ?? '{}') as { answer?: { decision: string; note: string } };
    check(one.status === 'pending' && oneHeld.answer?.decision === 'allow' && !oneHeld.answer.note.includes(fake)
      && dispatched.includes(`${runA}:repo-one`) && answered.status === 'pending',
    'approving puts the row back in line for the dispatcher to resume, with the note\'s credential redacted', { one, dispatched });
    let twice = '';
    try { headless.answerHeld(runA, 'repo-one', 'deny', null); } catch (error) { twice = String(error); }
    check(/not waiting for an answer any more/.test(twice), 'a second answer to the same call is refused', twice);
    let nonsense = '';
    try { headless.answerHeld(runA, 'repo-two', 'maybe', null); } catch (error) { nonsense = String(error); }
    check(/approved, declined or stopped/.test(nonsense), 'an answer that is not allow, deny or stop is refused', nonsense);

    headless.answerHeld(runA, 'repo-two', 'stop', 'not today');
    const two = rowOf(runA, 'repo-two');
    check(two.status === 'blocked' && /Stopped by the operator at a held Bash call: not today/.test(two.error ?? '')
      && dispatched.filter((entry) => entry.endsWith(':repo-two')).length === 0,
    'stopping ends the row where it held, says why, and resumes nothing', two);
    const runAState = db().prepare('SELECT status FROM runs WHERE id=?').get(runA) as { status: string };
    check(runAState.status === 'in_progress',
      'the run stays open while any of its rows is still in line to resume', runAState);

    const runB = `held-run-b-${nonce}`;
    seedRun(runB, { providerId: 'claude', holdForApproval: true, providerProfileFingerprint: 'unused' });
    seedRow(runB, 'repo-three', 'awaiting', heldRecord('toolu_row_3'));
    headless.cancelHeadless(runB);
    check(rowOf(runB, 'repo-three').status === 'canceled', 'cancelling a run also cancels a row waiting on a held call');

    if (claude) {
      const runC = `held-run-c-${nonce}`;
      seedRun(runC, { providerId: 'claude', name: 'held', projectIds: ['repo-four'], prompt: 'x', maxBudgetUsd: 1, timeoutMs: 60_000, isolate: false,
        holdForApproval: true, providerProfileFingerprint: claude.profileFingerprint });
      // 'default' is a real CLI mode that no trust level here launches under, so
      // whatever the smoke database's default trust is, this refuses before a
      // binary is resolved and nothing is spawned.
      const answeredUnderOtherMode = JSON.stringify({ ...JSON.parse(heldRecord('toolu_row_4', 'default')), answer: { decision: 'allow', note: null, answeredAt: Date.now() } });
      seedRow(runC, 'repo-four', 'pending', answeredUnderOtherMode);
      await headless.runOneRepo(runC, 'repo-four');
      const four = rowOf(runC, 'repo-four');
      check(four.status === 'errored' && /trust level changed after the call was held \(held under default, now/.test(four.error ?? ''),
        'a held call is not resumed under a different permission mode than it was held under', four);
    }

    const index = appSource('src/main/index.ts');
    const view = appSource('src/renderer/src/views/HeadlessRuns.tsx');
    check(index.includes("handle('headless:answerHeld'") && view.includes('window.wanigan.headless.answerHeld(')
      && view.includes('holdForApproval,') && view.includes('<HeldCall held={row.held}'),
    'Runs offers the opt-in when a run starts and the three answers on a held row, through the typed preload');
  } catch (error) {
    check(false, 'the deferred approval checks ran without throwing', String(error));
  } finally {
    try {
      headless.registerHeadlessRunner(null);
      for (const id of sessionIds) policy.releasePolicyContext(id);
      for (const id of runIds) {
        db().prepare('DELETE FROM headless_rows WHERE run_id = ?').run(id);
        db().prepare('DELETE FROM runs WHERE id = ?').run(id);
      }
      db().prepare('DELETE FROM policy_ledger WHERE session_id IN (?, ?, ?)').run(...sessionIds);
    } catch { /* the smoke database is thrown away */ }
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* temp */ }
  }
}
