import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { app } from 'electron';

type Check = (ok: boolean, label: string, detail?: unknown) => void;
type Say = (s: string) => void;

const appSource = (rel: string) => fs.readFileSync(path.join(app.getAppPath(), rel), 'utf8');
/** Check details are printed with String(); an object would read as [object Object]. */
const show = (value: unknown) => (JSON.stringify(value) ?? String(value)).slice(0, 800);
const msg = (error: unknown) => (error instanceof Error ? error.message : String(error));
const near = (value: number | null | undefined, expected: number) => typeof value === 'number' && Math.abs(value - expected) < 1e-9;

/**
 * Attempts: one task run several times from one pinned commit, recorded,
 * gated and compared.
 *
 * Driven against real git repositories, real worktrees and the project's real
 * review gate, a shell command whose answer depends on what each attempt left
 * in its tree. No agent CLI is run. Starting a run goes through a stand-in for
 * the two headless calls that probe installed CLIs; it writes the run and row
 * the way startHeadlessRun does, and each attempt's run is then completed the
 * way runRow completes one: the worktree cut at the pin, the agent's files
 * written, the row closed with a cost, a token count and an exit code.
 */
export async function runAttemptsSmoke(check: Check, say: Say): Promise<void> {
  say('── attempts · one task from one pinned commit, recorded, gated and compared');
  const nonce = Date.now().toString(36);
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-attempts-'));
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-attempts-ungated-'));
  const unborn = fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-attempts-unborn-'));
  const { db } = await import('./db');
  const attempts = await import('./attempts');
  const headless = await import('./headless');
  const worktrees = await import('./worktrees');
  const review = await import('./review');
  const halt = await import('./halt');
  const policy = await import('./policy');
  const { addProject, removeProject } = await import('./store');
  const shared = await import('../shared/attempts');
  const runIds: string[] = [];
  const trees: string[] = [];
  const projectIds: string[] = [];
  let stopWatching: (() => void) | null = null;
  try {
    const gitIn = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' }).toString().trim();
    const initRepo = (dir: string) => {
      gitIn(dir, 'init', '-q', '-b', 'main');
      gitIn(dir, 'config', 'user.email', 'smoke@wanigan.test');
      gitIn(dir, 'config', 'user.name', 'Smoke');
    };
    initRepo(repo);
    fs.mkdirSync(path.join(repo, 'src'));
    fs.writeFileSync(path.join(repo, 'README.md'), '# attempts\n');
    fs.writeFileSync(path.join(repo, 'src/pay.ts'), 'export function pay() { return charge(); }\n');
    gitIn(repo, 'add', '-A'); gitIn(repo, 'commit', '-qm', 'base');
    initRepo(plain);
    fs.writeFileSync(path.join(plain, 'a.txt'), 'a\n');
    gitIn(plain, 'add', '-A'); gitIn(plain, 'commit', '-qm', 'base');
    initRepo(unborn);

    const project = await addProject(repo);
    const ungated = await addProject(plain);
    const empty = await addProject(unborn);
    projectIds.push(project.id, ungated.id, empty.id);
    // The gate is a real shell command: it passes only in a tree that holds solved.txt.
    review.saveRecipe(project.id, ['test -f solved.txt']);
    check(!halt.halted(), 'no halt is engaged, so the refusals below measure the attempt set and not the halt');
    stopWatching = attempts.watchAttemptRuns();

    /* ── the stand-in for the two calls that probe installed CLIs ─────── */
    const projectsById = new Map([project, ungated, empty].map((p) => [p.id, p]));
    const deps: import('./attempts').AttemptDeps = {
      checkArm: async (cfg) => {
        if (cfg.providerId === 'refused-provider') throw new Error('Refused Provider is disabled, changed, or no longer installed.');
        return { label: cfg.providerId === 'codex' ? 'Codex' : 'Claude Code', profileFingerprint: `fp-${cfg.providerId}`, budgetFlag: cfg.providerId !== 'codex' };
      },
      startRun: async (cfg, pin) => {
        if (cfg.providerId === 'flaky') throw new Error('Flaky changed or was disabled before the run could be queued.');
        const runId = `run_attempt_smoke_${nonce}_${runIds.length}`;
        const target = projectsById.get(cfg.projectIds[0])!;
        // What startHeadlessRun stores: the request, the frozen fingerprint last,
        // and the pin in place of anything the caller sent under that name.
        db().prepare(`INSERT INTO runs (id, name, preset, project_id, model, status, config_json, kind, total_requests, created_at)
                      VALUES (?, ?, NULL, NULL, ?, 'in_progress', ?, 'headless', 1, ?)`)
          .run(runId, cfg.name, cfg.model ?? cfg.providerId,
            JSON.stringify({ ...cfg, holdForApproval: cfg.holdForApproval === true, providerProfileFingerprint: `fp-${cfg.providerId}`, pinned: pin }), Date.now());
        db().prepare("INSERT INTO headless_rows (run_id, project_id, project_name, project_path, status) VALUES (?,?,?,?,'pending')")
          .run(runId, target.id, target.name, target.path);
        runIds.push(runId);
        return { runId };
      },
      cancelRun: (runId) => { headless.cancelHeadless(runId); },
    };

    /** Complete one attempt's run the way runRow does, with the agent's work given. */
    const runAttempt = async (runId: string, work: {
      files?: Record<string, string>; commit?: boolean; filesChanged: number; costUsd: number | null;
      tokens?: [number, number, number, number]; status?: 'succeeded' | 'errored' | 'timeout';
    }) => {
      const row = db().prepare('SELECT project_id, project_path FROM headless_rows WHERE run_id=?').get(runId) as { project_id: string; project_path: string };
      const config = JSON.parse((db().prepare('SELECT config_json FROM runs WHERE id=?').get(runId) as { config_json: string }).config_json) as { name: string; pinned: unknown };
      const pin = headless.pinnedOf(config.pinned)!;
      db().prepare("UPDATE headless_rows SET status='running', started_at=? WHERE run_id=?").run(Date.now(), runId);
      const created = await worktrees.createWorktree(row.project_path, config.name, `${runId}/${row.project_id}`, { startPoint: pin.commit });
      trees.push(created.path);
      db().prepare('UPDATE headless_rows SET worktree=?, base_head=? WHERE run_id=?').run(created.path, created.head, runId);
      const headAtStart = gitIn(created.path, 'rev-parse', 'HEAD');
      for (const [rel, body] of Object.entries(work.files ?? {})) {
        fs.mkdirSync(path.dirname(path.join(created.path, rel)), { recursive: true });
        fs.writeFileSync(path.join(created.path, rel), body);
      }
      if (work.commit) { gitIn(created.path, 'add', '-A'); gitIn(created.path, 'commit', '-qm', 'the agent committed its work'); }
      db().prepare(`UPDATE headless_rows SET status=?, cost_usd=?, cost_reported=?, duration_ms=?, exit_code=?, output=?, files_changed=?, ended_at=?
                     WHERE run_id=?`)
        .run(work.status ?? 'succeeded', work.costUsd ?? 0, work.costUsd === null ? 0 : 1, 42_000, work.status === 'errored' ? 1 : 0,
          '{"type":"result"}', work.filesChanged, Date.now(), runId);
      if (work.tokens) db().prepare('UPDATE runs SET in_tokens=?, out_tokens=?, cache_read=?, cache_write=? WHERE id=?').run(...work.tokens, runId);
      return { path: created.path, head: created.head, headAtStart };
    };
    const countSets = () => (db().prepare('SELECT COUNT(*) AS n FROM attempt_sets').get() as { n: number }).n;
    const base = {
      kind: 'best-of-n', projectId: project.id, prompt: 'Make checkout charge once, and leave solved.txt when the suite passes.',
      arms: [{ providerId: 'claude', model: 'opus', effort: null }], repeats: 3, budgetUsd: 0.5, timeoutMs: 15 * 60_000,
    };
    const refusal = async (over: Record<string, unknown>) => {
      try { await attempts.startAttemptSet({ ...base, ...over }, deps); return 'started'; } catch (error) { return msg(error); }
    };

    /* ── refusals, before anything is written ────────────────────────── */
    const setsBefore = countSets();
    const noBudget = await refusal({ budgetUsd: 0 });
    check(/3 attempts run with nobody at the keyboard/.test(noBudget) && /ceiling is 3 × that budget/.test(noBudget),
      'a set with no budget is refused, and the refusal names the ceiling a budget would set', noBudget);
    const bounds = [
      await refusal({ arms: [1, 2, 3, 4, 5].map((n) => ({ providerId: `p${n}` })) }),
      await refusal({ repeats: 11 }),
      await refusal({ arms: [{ providerId: 'claude' }, { providerId: 'codex' }], repeats: 7 }),
    ];
    check(/at most 4 arms; this one has 5/.test(bounds[0]) && /1 to 10/.test(bounds[1]) && /14 attempts; a set runs at most 12/.test(bounds[2]),
      'more than four arms, more than ten repeats and more than twelve attempts are each refused with the numbers', bounds);
    const notProject = await refusal({ projectId: 'p_not_registered' });
    policy.setTrust(project.id, 'readonly');
    const readOnly = await refusal({});
    policy.setTrust(project.id, 'project');
    const noCommits = await refusal({ projectId: empty.id });
    const armRefused = await refusal({ arms: [{ providerId: 'refused-provider' }] });
    check(/registered with Wanigan/.test(notProject) && /Read only, which runs agents in plan mode with no worktree/.test(readOnly)
      && /has no commits yet/.test(noCommits) && /Arm 1 cannot start, so no attempt was started: Refused Provider is disabled/.test(armRefused),
    'an unregistered project, a Read only project, a repository with no commit and an arm its provider refuses are each refused by name', { notProject, readOnly, noCommits, armRefused });
    await halt.pullHalt({ reason: 'attempts smoke' });
    const whileHalted = await refusal({});
    halt.clearHalt();
    check(/Wanigan is halted, so it will not start an attempt set/.test(whileHalted),
      'a halted Wanigan refuses to start an attempt set, by name', whileHalted);
    check(countSets() === setsBefore, 'no refused start wrote a set or an attempt, the halted one included', { before: setsBefore, after: countSets() });

    /* ── the pinned commit, and a checkout that moved ────────────────── */
    const baseCommit = gitIn(repo, 'rev-parse', 'HEAD');
    const started = await attempts.startAttemptSet(base, deps);
    check(started.baseCommit === baseCommit && started.rows.length === 3 && started.rows.every((row) => row.status === 'queued' && row.headlessRunId !== null)
      && started.arms[0].profileFingerprint === 'fp-claude' && started.status === 'running',
    'a valid set pins the commit its project is on, freezes its arm\'s profile, and queues one headless run per attempt', started.rows);
    fs.writeFileSync(path.join(repo, 'later.txt'), 'committed after the set started\n');
    gitIn(repo, 'add', '-A'); gitIn(repo, 'commit', '-qm', 'the branch moves on');
    const movedHead = gitIn(repo, 'rev-parse', 'HEAD');
    const [runA, runB, runC] = started.rows.map((row) => row.headlessRunId as string);
    const treeA = await runAttempt(runA, {
      files: {
        'solved.txt': 'yes\n',
        'src/pay.ts': 'export function pay() { return chargeOnce(); }\n',
        'test/pay.test.ts': 'import { pay } from \'../src/pay\';\npay();\n',
      },
      filesChanged: 3, costUsd: 0.42, tokens: [1200, 340, 5000, 100],
    });
    check(treeA.head === baseCommit && treeA.headAtStart === baseCommit && movedHead !== baseCommit && !fs.existsSync(path.join(treeA.path, 'later.txt')),
      'an attempt cut after the branch moved on starts at the pinned commit, without the commit that moved it', { treeA, baseCommit, movedHead });

    const badStarts: string[] = [];
    for (const startPoint of ['--output=/tmp/wanigan-smoke', 'f'.repeat(40)]) {
      try { trees.push((await worktrees.createWorktree(repo, 'bad start', `smoke-bad-${nonce}`, { startPoint })).path); badStarts.push('created'); }
      catch (error) { badStarts.push(msg(error)); }
    }
    check(/is not a commit id/.test(badStarts[0]) && /does not name a commit/.test(badStarts[1]),
      'a start point that is not an object name, or names no commit in the repository, is refused before git creates anything', badStarts);

    const hook = path.join(repo, '.git', 'hooks', 'post-checkout');
    fs.writeFileSync(hook, '#!/bin/sh\ngit commit --allow-empty -q -m "moved by a hook" >/dev/null 2>&1\nexit 0\n', { mode: 0o755 });
    let mismatch = '';
    try { trees.push((await worktrees.createWorktree(repo, 'hook moved', `smoke-mismatch-${nonce}`, { startPoint: baseCommit })).path); mismatch = 'created'; }
    catch (error) { mismatch = msg(error); }
    fs.rmSync(hook, { force: true });
    const listed = gitIn(repo, 'worktree', 'list', '--porcelain');
    check(new RegExp(`was cut from ${baseCommit.slice(0, 12)}, but its HEAD reads [0-9a-f]{12}`).test(mismatch) && /nothing was run in it/.test(mismatch)
      && /The worktree was removed\./.test(mismatch) && !/hook-moved/.test(listed),
    'a worktree whose HEAD reads back as anything but the pinned commit is refused, and the fresh checkout is removed', { mismatch, listed });

    /* ── cost, tokens, the gate, the tree and the oracle, per attempt ─── */
    await runAttempt(runB, { files: { 'src/pay.ts': 'export function pay() { return chargeOnce(); } // charge once\n' }, filesChanged: 1, costUsd: 0.3, tokens: [800, 200, 0, 0] });
    const treeC = await runAttempt(runC, { files: { 'solved.txt': 'yes\n' }, commit: true, filesChanged: 1, costUsd: null });
    const branchC = gitIn(treeC.path, 'rev-parse', '--abbrev-ref', 'HEAD');
    await Promise.all([attempts.recordAttemptRun(runA), attempts.recordAttemptRun(runB), attempts.recordAttemptRun(runC)]);
    const recorded = attempts.attemptSet(started.id);
    const [a, b, c] = recorded.rows;
    check(a.gate === 'passed' && b.gate === 'failed' && c.gate === 'passed' && !!a.reviewRunId && !!b.reviewRunId && a.reviewRunId !== b.reviewRunId
      && /Failed at `test -f solved\.txt` \(exit 1\)/.test(b.gateNote ?? ''),
    'the review gate runs in each attempt\'s own worktree: one recipe passes where the attempt left solved.txt and fails where it did not', recorded.rows.map((row) => [row.gate, row.gateNote]));
    check(/^[0-9a-f]{40}$/.test(a.tree ?? '') && a.tree !== b.tree
      && show(a.oracle?.reading?.flags.map((flag) => flag.kind)) === show(['tests-edited-with-code', 'test-without-assertion'])
      && b.oracle?.reading?.flags.length === 0 && b.oracle.reading.codeFiles === 1,
    'each attempt records the tree its gate ran on, and the oracle flags read from its diff against the pinned commit', { a: [a.tree, a.oracle], b: [b.tree, b.oracle] });
    check(near(a.costUsd, 0.42) && a.costReported === true && a.tokens?.input === 1200 && a.tokens.output === 340 && a.tokens.cacheRead === 5000
      && b.tokens?.input === 800 && near(b.costUsd, 0.3) && c.costUsd === null && c.costReported === false && c.tokens === null,
    'cost and tokens are recorded per attempt from its own run, and an unreported cost reads as null beside a false flag rather than $0.00', { a, c });
    check(a.baseHead === baseCommit && a.durationMs === 42_000 && a.exitCode === 0 && a.filesChanged === 3 && a.status === 'succeeded'
      && a.launch?.profileFingerprint === 'fp-claude' && a.launch.model === 'opus' && a.worktreeOnDisk,
    'the status, exit code, duration, files changed and the profile the run launched with are copied onto the attempt', a);

    /* ── the report, read back ───────────────────────────────────────── */
    const arm = recorded.report.arms[0];
    check(arm.trials === 3 && arm.passes === 2 && near(arm.passAt1.value, 2 / 3) && arm.passAtK.value === 1 && arm.passHatK.value === 0
      && arm.passAtK.form === 'estimator' && arm.passHatK.form === 'estimator'
      && near(arm.cost.usd, 0.36) && arm.cost.reported === 2 && arm.cost.trials === 3 && arm.cost.floor,
    'the report reads back per arm: 2 of 3 passed, pass@3 and pass^3 in the estimator form, and cost per solved task over the 2 of 3 attempts that reported', arm);
    const summary = attempts.attemptSets(20).find((set) => set.id === started.id);
    check(recorded.report.evidence.label === 'controlled' && recorded.status === 'finished' && recorded.report.open === 0
      && summary?.passes === 2 && summary.open === 0 && summary.attempts === 3 && summary.status === 'finished',
    'with every attempt at the pinned commit, under its arm\'s profile, and gated, the evidence reads controlled, and the set and its list entry read finished', { evidence: recorded.report.evidence, summary });

    /* ── keep, then clean up around it ───────────────────────────────── */
    check(!recorded.cleanup.allowed && /Keep an attempt first/.test(recorded.cleanup.reason ?? ''),
      'best of N will not remove any worktree before an attempt has been kept', recorded.cleanup);
    let badKeep = '';
    try { attempts.keepAttempt(started.id, 'att_0000000000000000'); } catch (error) { badKeep = msg(error); }
    const kept = attempts.keepAttempt(started.id, a.id);
    check(/not part of this set/.test(badKeep) && kept.keptAttemptId === a.id && typeof kept.decidedAt === 'number' && kept.cleanup.allowed
      && show(kept.cleanup.worktrees.map((w) => w.attemptId).sort()) === show([b.id, c.id].sort()),
    'keeping records the decision, and the cleanup lists the other attempts\' worktrees before anything is removed', { badKeep, cleanup: kept.cleanup });
    const cleaned = await attempts.removeOtherWorktrees(started.id);
    const outB = cleaned.results.find((result) => result.attemptId === b.id);
    const outC = cleaned.results.find((result) => result.attemptId === c.id);
    check(outB?.outcome === 'kept' && /1 uncommitted file/.test(outB.detail) && fs.existsSync(b.worktree!)
      && fs.readFileSync(path.join(b.worktree!, 'src/pay.ts'), 'utf8').includes('// charge once'),
    'cleanup keeps a worktree that holds uncommitted work, says so with the count, and leaves its files as they were', cleaned);
    check(outC?.outcome === 'removed' && !fs.existsSync(c.worktree!) && fs.existsSync(a.worktree!)
      && gitIn(repo, 'branch', '--list', branchC).includes(branchC) && gitIn(repo, 'rev-parse', 'main') === movedHead,
    'a clean worktree is removed without force, its branch is kept, the kept attempt is untouched, and nothing is merged', { cleaned, branchC });

    /* ── a paired bench, with an arm that never passes ───────────────── */
    const bench = await attempts.startAttemptSet({
      ...base, kind: 'bench', repeats: 2,
      arms: [{ providerId: 'claude', model: 'opus', effort: 'high' }, { providerId: 'codex', model: null, effort: null }],
    }, deps);
    for (const row of bench.rows) {
      const claude = row.armIndex === 0;
      await runAttempt(row.headlessRunId!, claude
        ? { files: { 'solved.txt': 'yes\n' }, filesChanged: 1, costUsd: 0.5, tokens: [900, 100, 0, 0] }
        : { files: { 'notes.md': 'tried\n' }, filesChanged: 1, costUsd: null, tokens: [700, 90, 0, 0] });
      await attempts.recordAttemptRun(row.headlessRunId!);
    }
    const benchRead = attempts.attemptSet(bench.id);
    const [claudeArm, codexArm] = benchRead.report.arms;
    check(show(bench.rows.map((row) => row.armIndex)) === show([0, 1, 0, 1]) && bench.arms[1].budgetFlag === false
      && /Codex takes no budget flag, so its 2 attempts are bounded by the 15-minute timeout/.test(shared.ceilingWords({ budgetUsd: 0.5, timeoutMs: bench.timeoutMs, repeats: 2, arms: bench.arms })),
    'a bench interleaves its arms in launch order, and its ceiling says an arm with no budget flag is bounded by the timeout, not by cost', bench.rows);
    check(claudeArm.trials === 2 && claudeArm.passes === 2 && claudeArm.passAtK.value === 1 && claudeArm.passHatK.value === 1 && near(claudeArm.cost.usd, 0.5)
      && codexArm.trials === 2 && codexArm.passes === 0 && codexArm.passAt1.value === 0 && codexArm.passAtK.value === 0 && codexArm.passHatK.value === 0
      && codexArm.cost.usd === null && /No trial reported a cost/.test(codexArm.cost.reason ?? ''),
    'an arm with no passes reads as measured zeros, and it has no cost per solved task because nothing it ran reported a cost', benchRead.report.arms);
    check(benchRead.report.lead.armIndex === 0 && /A lead of 2 over 2 paired trials is more than √2/.test(benchRead.report.lead.reason)
      && benchRead.report.evidence.label === 'controlled',
    'a two-of-two against zero-of-two split is named as a lead past √2, with its reason', benchRead.report.lead);

    /* ── an ungated project, a moved checkout, a tree that is gone ───── */
    const loose = await attempts.startAttemptSet({ ...base, projectId: ungated.id }, deps);
    const [u1, u2, u3] = loose.rows.map((row) => row.headlessRunId as string);
    await runAttempt(u1, { files: { 'b.txt': 'b\n' }, filesChanged: 1, costUsd: 0.2 });
    await attempts.recordAttemptRun(u1);
    const plainHook = path.join(plain, '.git', 'hooks', 'post-checkout');
    fs.writeFileSync(plainHook, '#!/bin/sh\ngit commit --allow-empty -q -m "moved by a hook" >/dev/null 2>&1\nexit 0\n', { mode: 0o755 });
    try {
      db().prepare("UPDATE headless_rows SET status='running', started_at=? WHERE run_id=?").run(Date.now(), u2);
      trees.push((await worktrees.createWorktree(plain, 'moved attempt', `${u2}/${ungated.id}`, { startPoint: loose.baseCommit })).path);
    } catch (error) {
      // runRow's own catch around the checkout, word for word.
      db().prepare("UPDATE headless_rows SET status='errored', error=?, ended_at=? WHERE run_id=? AND status IN ('pending','running')")
        .run(`Could not create a worktree in ${ungated.name}: ${msg(error)}`, Date.now(), u2);
    } finally {
      fs.rmSync(plainHook, { force: true });
    }
    await attempts.recordAttemptRun(u2);
    const gone = await runAttempt(u3, { files: { 'c.txt': 'c\n' }, filesChanged: 1, costUsd: 0.1 });
    fs.rmSync(gone.path, { recursive: true, force: true });
    await attempts.recordAttemptRun(u3);
    const looseRead = attempts.attemptSet(loose.id);
    const [l1, l2, l3] = looseRead.rows;
    check(l1.gate === 'not-run' && /no review commands/.test(l1.gateNote ?? '') && /^[0-9a-f]{40}$/.test(l1.tree ?? ''),
      'a project with no review commands records not-run with the reason, never a pass, and still records the tree', l1);
    check(l2.status === 'failed-to-start' && /Could not create a worktree .* but its HEAD reads/.test(l2.error ?? '') && l2.gate === 'not-run'
      && looseRead.report.arms[0].trials === 2 && show(looseRead.report.notTrials) === show([{ status: 'failed-to-start', count: 1 }]),
    'an attempt refused for a head mismatch is recorded as never started, with the refusal, and is not counted as a trial', l2);
    check(l3.gate === 'unavailable' && /no longer on disk/.test(l3.gateNote ?? '') && l3.status === 'succeeded'
      && looseRead.report.evidence.label === 'correlation'
      && looseRead.report.evidence.reasons.some((reason) => /1 trial was not gated/.test(reason))
      && looseRead.report.evidence.reasons.some((reason) => /The gate could not run for 1 trial/.test(reason)),
    'a gate that could not run is unavailable with its reason, and the set reads as correlation, saying why', { l3, evidence: looseRead.report.evidence });

    /* ── successful commands whose checkout changed while they ran ──── */
    review.saveRecipe(project.id, ["printf '\\nchanged by the review command\\n' >> README.md"]);
    const changing = await attempts.startAttemptSet({ ...base, repeats: 2 }, deps);
    for (const row of changing.rows) {
      await runAttempt(row.headlessRunId!, { files: { 'solved.txt': 'yes\n' }, filesChanged: 1, costUsd: 0.1 });
      await attempts.recordAttemptRun(row.headlessRunId!);
    }
    const changedRead = attempts.attemptSet(changing.id);
    const changedAttempt = changedRead.rows[0];
    const changedReceipt = review.history(project.id, 50).find(run => run.id === changedAttempt.reviewRunId);
    check(changedReceipt?.status === 'passed' && changedReceipt.results.every(result => result.exitCode === 0)
      && changedRead.rows.every(row => row.worktree !== null
        && fs.readFileSync(path.join(row.worktree, 'README.md'), 'utf8').includes('changed by the review command')
        && row.gate === 'unavailable')
      && changedAttempt.gate === 'unavailable' && /Checkout content changed while these checks ran/.test(changedAttempt.gateNote ?? '')
      && changedRead.status === 'finished' && changedRead.report.arms[0].trials === 2
      && changedRead.report.arms[0].passes === 0 && changedRead.report.evidence.label === 'correlation',
    'successful commands that mutate the checkout keep their receipt but cannot count as a verified attempt or controlled pass',
    { gate: changedAttempt.gate, note: changedAttempt.gateNote, receipt: changedReceipt?.status, report: changedRead.report.evidence });
    review.saveRecipe(project.id, ['test -f solved.txt']);

    /* ── a launch that cannot finish, closed through the run-ended listener */
    let launchError = '';
    try {
      await attempts.startAttemptSet({ ...base, repeats: 2, arms: [{ providerId: 'claude', model: 'sonnet' }, { providerId: 'flaky' }] }, deps);
    } catch (error) { launchError = msg(error); }
    const failedSet = attempts.attemptSets(50).find((set) => set.status === 'failed');
    // Read straight after the refusal: cancelHeadless closed the queued run, and
    // the listener recorded its attempt inside that call, with nothing awaited.
    const failedRead = failedSet ? attempts.attemptSet(failedSet.id) : null;
    check(/Attempt 2 of 4 could not start: Flaky changed/.test(launchError) && /The 1 attempt already queued was cancelled, and the set is recorded as failed/.test(launchError)
      && failedRead?.rows[0].status === 'canceled' && failedRead.rows[0].gate === 'not-run'
      && failedRead.rows[1].status === 'failed-to-start' && /could not be started: Flaky changed/.test(failedRead.rows[1].error ?? '')
      && failedRead.rows.slice(2).every((row) => row.status === 'failed-to-start' && /launched whole or not at all/.test(row.error ?? '')),
    'a run that cannot start mid-launch cancels the attempts already queued, which the run-ended listener records as canceled, and the set is recorded as failed', { launchError, rows: failedRead?.rows.map((row) => [row.status, row.gate, row.error]) });

    /* ── what a dead process leaves, and what the renderer cannot name ── */
    db().prepare(`INSERT INTO attempt_sets (id, project_id, kind, prompt, prompt_sha256, base_commit, arms_json, repeats, budget_usd, timeout_ms, status, created_at)
                  VALUES (?,?,?,?,?,?,?,?,?,?,'running',?)`)
      .run('aset_00000000000000ff', project.id, 'best-of-n', 'interrupted', 'x', baseCommit, JSON.stringify(started.arms), 2, 1, 60_000, 1);
    db().prepare(`INSERT INTO attempts (id, set_id, arm_index, repeat_index, status, gate_status, gate_started_at) VALUES (?,?,?,?,?,?,?)`)
      .run('att_00000000000000ff', 'aset_00000000000000ff', 0, 0, 'succeeded', 'running', 1);
    await attempts.sweepAttempts();
    const interrupted = attempts.attemptSet('aset_00000000000000ff').rows[0];
    check(interrupted.gate === 'unavailable' && /stopped while this attempt was being gated/.test(interrupted.gateNote ?? ''),
      'a gate left running by a process that died is closed as unavailable on the next sweep, not read as still in flight', interrupted);
    const badIds: string[] = [];
    for (const read of [() => attempts.attemptSet('../../etc/passwd'), () => attempts.keepAttempt('aset_zz', a.id)]) {
      try { read(); badIds.push('read'); } catch (error) { badIds.push(msg(error)); }
    }
    try { await attempts.removeOtherWorktrees({ id: started.id }); badIds.push('removed'); } catch (error) { badIds.push(msg(error)); }
    check(badIds.every((text) => /not an attempt set/.test(text)),
      'a set id that is not the shape main issues is refused before any read, keep or removal', badIds);

    /* ── the runner's own refusals for a pinned row ──────────────────── */
    // runRow refuses these before it resolves a binary, so the real function
    // runs here and nothing is spawned.
    let unpinnable = '';
    try {
      await headless.startHeadlessRun({ name: 'x', providerId: 'claude', projectIds: [project.id, ungated.id], prompt: 'x', maxBudgetUsd: 1, timeoutMs: 60_000, isolate: true },
        { commit: baseCommit, attemptId: 'att_00000000000000aa' });
    } catch (error) { unpinnable = msg(error); }
    check(/A pinned run names exactly one repository and a full commit id/.test(unpinnable),
      'a pin over more than one repository is refused before any provider is probed', unpinnable);
    const { providerById } = await import('./providers');
    const claude = providerById('claude');
    if (claude) {
      const seedPinned = (id: string, config: Record<string, unknown>) => {
        runIds.push(id);
        db().prepare(`INSERT INTO runs (id, name, preset, project_id, model, status, config_json, kind, total_requests, created_at)
                      VALUES (?, 'pinned', NULL, NULL, 'claude', 'in_progress', ?, 'headless', 1, ?)`)
          .run(id, JSON.stringify({ name: 'pinned', providerId: 'claude', projectIds: [project.id], prompt: 'x', maxBudgetUsd: 1, timeoutMs: 60_000,
            isolate: true, providerProfileFingerprint: claude.profileFingerprint, ...config }), Date.now());
        db().prepare("INSERT INTO headless_rows (run_id, project_id, project_name, project_path, status) VALUES (?,?,?,?,'pending')")
          .run(id, project.id, project.name, project.path);
      };
      const rowOf = (id: string) => db().prepare('SELECT status, error, worktree FROM headless_rows WHERE run_id=?').get(id) as { status: string; error: string | null; worktree: string | null };
      const readOnlyRun = `run_attempt_smoke_readonly_${nonce}`;
      seedPinned(readOnlyRun, { pinned: { commit: baseCommit, attemptId: 'att_00000000000000ab' } });
      policy.setTrust(project.id, 'readonly');
      try { await headless.runOneRepo(readOnlyRun, project.id); } finally { policy.setTrust(project.id, 'project'); }
      const unreadablePin = `run_attempt_smoke_badpin_${nonce}`;
      seedPinned(unreadablePin, { pinned: { commit: 'HEAD', attemptId: 'att_00000000000000ac' } });
      await headless.runOneRepo(unreadablePin, project.id);
      check(rowOf(readOnlyRun).status === 'blocked' && /runs agents without one, so it was not run/.test(rowOf(readOnlyRun).error ?? '')
        && rowOf(readOnlyRun).worktree === null
        && rowOf(unreadablePin).status === 'errored' && /pinned commit could not be read back/.test(rowOf(unreadablePin).error ?? ''),
      'the runner blocks a pinned row that would run without a worktree, and fails one whose pin does not read, before any worktree or binary', { readOnly: rowOf(readOnlyRun), badPin: rowOf(unreadablePin) });
    }

    /* ── the launcher's path, read from source ───────────────────────── */
    const attemptsSrc = appSource('src/main/attempts.ts');
    const headlessSrc = appSource('src/main/headless.ts');
    const indexSrc = appSource('src/main/index.ts');
    const gateSrc = appSource('src/main/budget-gate.ts');
    check(attemptsSrc.includes('startRun: (cfg, pin) => headless.startHeadlessRun(cfg, pin),')
      && attemptsSrc.includes('checkArm: (cfg) => headless.checkHeadlessStart(cfg),')
      && !/\bspawn\(|queue\.enqueue\(|from '\.\/queue'/.test(attemptsSrc)
      && indexSrc.includes("queue.enqueue('headless', `${name} · ${runId}`, { runId, projectId });")
      && /const HELD_KINDS[^\n]*'headless'/.test(gateSrc),
    'every attempt starts through startHeadlessRun, whose runner enqueues it as kind headless, the kind the monthly budget gate holds; the launcher has no spawn and no queue path of its own');
    check(headlessSrc.includes('pin ? { startPoint: pin.commit } : {}')
      && headlessSrc.includes('if (executionStopped && worktree && filesChanged === 0 && !heldNow && !pin) {')
      && headlessSrc.includes('pinned: pin ?? undefined,')
      && headlessSrc.includes('const scheduleFire = scheduledFire ? claimFireForRun(')
      && headlessSrc.includes('fire: scheduledFire')
      && headlessSrc.includes('if (pin !== null && scheduledFire) throw')
      && headlessSrc.includes("if (pin && baseHead !== pin.commit) {"),
    'a pinned run is cut at its commit and checked again before spawn, keeps its worktree for the gate, cannot take a schedule\'s fire, and a pin sent inside a renderer config is replaced');
    check(indexSrc.includes('attempts.watchAttemptRuns();')
      && ['attempts:sets', 'attempts:set', 'attempts:start', 'attempts:keep', 'attempts:removeOthers'].every((channel) => indexSrc.includes(`handle('${channel}'`)),
    'service startup records attempts as their runs end, and the five attempt channels are registered');
  } catch (error) {
    check(false, 'the attempts checks ran without throwing', msg(error));
  } finally {
    try {
      stopWatching?.();
      const d = db();
      for (const id of projectIds) d.prepare('DELETE FROM attempt_sets WHERE project_id = ?').run(id);
      for (const id of runIds) d.prepare('DELETE FROM runs WHERE id = ?').run(id);
      for (const id of projectIds) removeProject(id);
    } catch { /* the smoke database is thrown away */ }
    for (const dir of [...trees, repo, plain, unborn]) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ } }
  }
}
