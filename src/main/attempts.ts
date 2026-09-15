import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { db } from './db';
import { head, repoState } from './git';
import * as headless from './headless';
import { refuseIfHalted } from './halt';
import { notify } from './notify';
import { trustFor } from './policy';
import * as review from './review';
import { projectById } from './store';
import { forgetTreeSnapshot, snapshotTree } from './tree-snapshot';
import { removeWorktree, worktreeStatus } from './worktrees';
import {
  attemptReport, attemptStatusOf, isTrialStatus, planAttempts,
  type AttemptArm, type AttemptCleanupPlan, type AttemptCleanupResult, type AttemptForReport, type AttemptGate,
  type AttemptLaunch, type AttemptOracle, type AttemptPlan, type AttemptRow, type AttemptSetDetail, type AttemptSetKind,
  type AttemptSetStatus, type AttemptSetSummary, type AttemptStatus,
} from '../shared/attempts';

/**
 * Attempts: one task run several times from one pinned commit, compared by
 * what each run recorded. The arithmetic and the words live in
 * src/shared/attempts.ts; this file launches, records and cleans up.
 *
 * There is no second spawner here, on purpose. Each attempt is an ordinary
 * single-repository headless run started through startHeadlessRun, which
 * enqueues it as queue kind 'headless'. So the slot limits, the leases, the
 * halt, the trust gate, held approvals and the monthly budget gate are the ones
 * every headless run already passes, and a set cannot become the way around
 * any of them. What the run carries that an ordinary one does not is its pin
 * (headless.ts, HeadlessPin): the commit its worktree must be cut at, and the
 * attempt it answers for.
 *
 * When a run ends, its attempt copies the facts off it — status, exit code,
 * duration, reported cost, the run's tokens, files changed — and then its tree
 * is recorded and gated in that worktree. Gates run one at a time in this
 * process. Two test suites in sibling worktrees can share a port, a database
 * or a cache, and a pass that depended on which other attempt finished first
 * would corrupt exactly the comparison the set exists to make.
 */

const msg = (error: unknown) => (error instanceof Error ? error.message : String(error));
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

const SET_ID = /^aset_[0-9a-f]{16}$/;
const ATTEMPT_ID = /^att_[0-9a-f]{16}$/;
const FULL_COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

/** Attempts marked gating before this belong to a process that is no longer here. */
const PROCESS_START = Date.now();

/* ── launch ────────────────────────────────────────────────────────────── */

/**
 * The three things a set needs from the headless runner, as a seam.
 *
 * The smoke suite replaces them with stand-ins that write the run rows the
 * runner would, because a real start probes installed CLIs and the suite must
 * never run one. Everything else a set does is the live code.
 */
export type AttemptDeps = {
  /** Every refusal a run for this arm would meet, with nothing started. */
  checkArm: (cfg: headless.HeadlessStart) => Promise<{ label: string; profileFingerprint: string; budgetFlag: boolean }>;
  /** One pinned single-repository headless run, queued like any other. */
  startRun: (cfg: headless.HeadlessStart, pin: headless.HeadlessPin) => Promise<{ runId: string }>;
  cancelRun: (runId: string) => void;
};

const LIVE: AttemptDeps = {
  checkArm: (cfg) => headless.checkHeadlessStart(cfg),
  startRun: (cfg, pin) => headless.startHeadlessRun(cfg, pin),
  cancelRun: (runId) => { headless.cancelHeadless(runId); },
};

function runConfig(plan: AttemptPlan, projectId: string, arm: AttemptPlan['arms'][number], holdForApproval: boolean, name: string): headless.HeadlessStart {
  return {
    name,
    providerId: arm.providerId,
    projectIds: [projectId],
    prompt: plan.prompt,
    model: arm.model ?? undefined,
    effort: arm.effort ?? undefined,
    maxBudgetUsd: plan.budgetUsd,
    timeoutMs: plan.timeoutMs,
    // Always isolated: an attempt is only comparable because it ran in a tree
    // of its own, and runRow refuses a pinned row that would not.
    isolate: true,
    holdForApproval,
  };
}

/**
 * Validate a set, freeze its commit and arms, and queue one run per attempt.
 *
 * Refusals come before anything is written, in the order a person can act on
 * them: the halt, the request itself, the project, its commit, then each arm's
 * provider. Only when every arm would be accepted is the first run started, so
 * a set is launched whole or not at all; a run that fails to start in the
 * moment between cancels the ones already queued and records why.
 */
export async function startAttemptSet(input: unknown, deps: AttemptDeps = LIVE): Promise<AttemptSetDetail> {
  refuseIfHalted('start an attempt set');
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const planned = planAttempts({
    kind: raw.kind, prompt: raw.prompt, arms: raw.arms, repeats: raw.repeats, budgetUsd: raw.budgetUsd, timeoutMs: raw.timeoutMs,
  });
  if (!planned.ok) throw new Error(planned.reason);
  const plan = planned.plan;

  const project = typeof raw.projectId === 'string' ? projectById(raw.projectId) : undefined;
  if (!project) throw new Error('Choose a project that is registered with Wanigan.');
  // Refused here with the reason, rather than queued to be blocked row by row:
  // a Read only project runs agents in plan mode in the checkout itself, and an
  // attempt with no worktree of its own has nothing to compare.
  if (trustFor(project.id) === 'readonly') {
    throw new Error(`${project.name} is Read only, which runs agents in plan mode with no worktree, so no attempt could run in a tree of its own. Set it to Project or Trusted first.`);
  }

  const state = await repoState(project.path);
  if (state.kind === 'absent') throw new Error(`${project.name} is not a git repository, so there is no commit to pin the attempts to.`);
  if (state.kind === 'unborn') throw new Error(`${project.name} has no commits yet, so there is no commit to pin the attempts to. Make one commit first.`);
  if (state.kind === 'unreadable') throw new Error(`Wanigan could not read ${project.name} to pin a commit: ${state.reason}`);
  const baseCommit = await head(project.path);
  if (!baseCommit || !FULL_COMMIT.test(baseCommit)) {
    throw new Error(`Wanigan could not resolve HEAD in ${project.name}, so it will not guess which commit the attempts start from.`);
  }
  const holdForApproval = raw.holdForApproval === true;

  const arms: AttemptArm[] = [];
  for (const [index, arm] of plan.arms.entries()) {
    try {
      const checked = await deps.checkArm(runConfig(plan, project.id, arm, holdForApproval, 'attempt check'));
      arms.push({ ...arm, label: checked.label, profileFingerprint: checked.profileFingerprint, budgetFlag: checked.budgetFlag });
    } catch (error) {
      throw new Error(`Arm ${index + 1} cannot start, so no attempt was started: ${msg(error)}`);
    }
  }

  const d = db();
  const setId = newId('aset');
  const createdAt = Date.now();
  const attemptIds = plan.slots.map(() => newId('att'));
  d.transaction(() => {
    d.prepare(`INSERT INTO attempt_sets (id, project_id, kind, prompt, prompt_sha256, base_commit, arms_json, repeats, budget_usd, timeout_ms,
                                         status, hold_for_approval, created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,'running',?,?)`)
      .run(setId, project.id, plan.kind, plan.prompt, sha256(plan.prompt), baseCommit, JSON.stringify(arms), plan.repeats,
        plan.budgetUsd, plan.timeoutMs, holdForApproval ? 1 : 0, createdAt);
    const insert = d.prepare("INSERT INTO attempts (id, set_id, arm_index, repeat_index, status) VALUES (?,?,?,?,'queued')");
    plan.slots.forEach((slot, i) => insert.run(attemptIds[i], setId, slot.armIndex, slot.repeatIndex));
  })();

  const started: string[] = [];
  for (const [i, slot] of plan.slots.entries()) {
    const arm = arms[slot.armIndex];
    const name = `Attempt ${i + 1} of ${plan.slots.length} · ${[arm.label, arm.model, arm.effort].filter(Boolean).join(' · ')} · ${project.name}`;
    try {
      const { runId } = await deps.startRun(runConfig(plan, project.id, arm, holdForApproval, name), { commit: baseCommit, attemptId: attemptIds[i] });
      started.push(runId);
      // COALESCE: a run that ended before this line has already been found by
      // its pin and written its own id here.
      d.prepare('UPDATE attempts SET headless_run_id=COALESCE(headless_run_id, ?) WHERE id=?').run(runId, attemptIds[i]);
    } catch (error) {
      const why = msg(error);
      d.prepare("UPDATE attempts SET status='failed-to-start', gate_status='not-run', error=? WHERE id=? AND status='queued' AND headless_run_id IS NULL")
        .run(`This attempt could not be started: ${why}`, attemptIds[i]);
      d.prepare("UPDATE attempts SET status='failed-to-start', gate_status='not-run', error=? WHERE set_id=? AND status='queued' AND headless_run_id IS NULL")
        .run(`Not started: attempt ${i + 1} of this set could not start, and a set is launched whole or not at all.`, setId);
      d.prepare("UPDATE attempt_sets SET status='failed' WHERE id=?").run(setId);
      for (const runId of started) {
        try { deps.cancelRun(runId); } catch { /* recorded on its row; the refusal below still stands */ }
      }
      throw new Error(`Attempt ${i + 1} of ${plan.slots.length} could not start: ${why}. ${started.length ? `The ${plural(started.length, 'attempt')} already queued ${started.length === 1 ? 'was' : 'were'} cancelled, and the` : 'The'} set is recorded as failed.`);
    }
  }
  return attemptSet(setId);
}

/* ── recording what a run left ─────────────────────────────────────────── */

type RunRecord = { config_json: string; in_tokens: number; out_tokens: number; cache_read: number; cache_write: number };
type RowRecord = {
  status: string; ran: number; error: string | null; exit_code: number | null; duration_ms: number | null;
  cost_usd: number; cost_reported: number | null; files_changed: number; worktree: string | null; base_head: string | null;
  started_at: number | null; ended_at: number | null;
};
type AttemptRecord = { id: string; set_id: string; status: string; headless_run_id: string | null };
type SetRecord = {
  id: string; project_id: string; kind: string; prompt: string; prompt_sha256: string; base_commit: string; arms_json: string;
  repeats: number; budget_usd: number; timeout_ms: number; status: string; kept_attempt_id: string | null;
  decided_at: number | null; created_at: number; hold_for_approval: number; project_name: string | null;
};

const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null);

/** What a run was stored with, as the evidence label compares it. Null when the record does not say. */
function launchOf(config: Record<string, unknown> | null): AttemptLaunch | null {
  if (!config) return null;
  const providerId = text(config.providerId);
  const profileFingerprint = text(config.providerProfileFingerprint);
  if (!providerId || !profileFingerprint || typeof config.prompt !== 'string') return null;
  return { providerId, profileFingerprint, model: text(config.model), effort: text(config.effort), promptSha256: sha256(config.prompt) };
}

/** Why an attempt that is not a trial was not gated, in words. */
function notTrialNote(status: AttemptStatus, row: RowRecord | undefined): string {
  switch (status) {
    case 'blocked': return `Not gated: the run was blocked before it could finish${row?.error ? ` (${row.error.split('\n')[0].slice(0, 200)})` : ''}.`;
    case 'canceled': return 'Not gated: the run was cancelled, and a trial someone stopped is not a measurement.';
    case 'failed-to-start': return 'Not gated: the agent never started, so there is no work of its own to test.';
    default: return 'Not gated: this run\'s outcome could not be read.';
  }
}

/** The gates waiting in this process, one after another. */
let gates: Promise<void> = Promise.resolve();

type Claimed = { attemptId: string; setId: string; projectId: string; baseCommit: string; worktree: string | null };

/**
 * Record the attempt a finished run answers for, if it answers for one.
 *
 * The facts are copied the moment the run ends, synchronously, so a run that
 * finished reads as finished straight away; only its gate waits its turn,
 * because gates never overlap (see the top of this file). Safe to call for any
 * run and any number of times: the attempt is claimed with a conditional
 * write, so a listener and a startup sweep, or two Wanigan processes, record it
 * once between them. The promise settles when that attempt's gate has.
 */
export function recordAttemptRun(runId: string): Promise<void> {
  let claimed: Claimed | null;
  try {
    claimed = claim(runId);
  } catch (error) {
    // Left 'queued', so the next start's sweep records it.
    console.warn('[wanigan] could not record the attempt for run', runId, error);
    return Promise.resolve();
  }
  if (!claimed) return Promise.resolve();
  const work = claimed;
  const next = gates.then(() => gateAndClose(work));
  gates = next;
  return next;
}

function claim(runId: string): Claimed | null {
  const d = db();
  const run = d.prepare('SELECT config_json, in_tokens, out_tokens, cache_read, cache_write FROM runs WHERE id=?').get(runId) as RunRecord | undefined;
  let config: Record<string, unknown> | null = null;
  try { config = run ? JSON.parse(run.config_json) as Record<string, unknown> : null; } catch { config = null; }
  const pin = headless.pinnedOf(config?.pinned);
  const select = 'SELECT id, set_id, status, headless_run_id FROM attempts';
  // By the pin first: a run can end inside startHeadlessRun, before the
  // launcher has written its id onto the attempt.
  const attempt = (pin ? d.prepare(`${select} WHERE id=?`).get(pin.attemptId) as AttemptRecord | undefined : undefined)
    ?? d.prepare(`${select} WHERE headless_run_id=?`).get(runId) as AttemptRecord | undefined;
  if (!attempt || attempt.status !== 'queued') return null;
  if (attempt.headless_run_id && attempt.headless_run_id !== runId) return null;
  const set = d.prepare('SELECT project_id, base_commit FROM attempt_sets WHERE id=?').get(attempt.set_id) as { project_id: string; base_commit: string } | undefined;
  if (!set) return null;

  const row = d.prepare(`
    SELECT status, (output IS NOT NULL) AS ran, error, exit_code, duration_ms, cost_usd, cost_reported, files_changed, worktree, base_head,
           started_at, ended_at
      FROM headless_rows WHERE run_id=? LIMIT 1
  `).get(runId) as RowRecord | undefined;
  // `output` is written only by the row's own finish, after its agent exited;
  // every failure before a spawn leaves it null.
  const ran = row ? Number(row.ran) === 1 : false;
  const status = row ? attemptStatusOf({ status: row.status, agentRan: ran }) : 'unrecorded';
  if (status === null) return null;
  const trial = isTrialStatus(status);

  const changed = d.prepare(`
    UPDATE attempts
       SET status=?, headless_run_id=?, worktree=?, base_head=?, exit_code=?, duration_ms=?, cost_usd=?, cost_reported=?,
           in_tokens=?, out_tokens=?, cache_read=?, cache_write=?, files_changed=?, started_at=?, ended_at=?, error=?, launch_json=?,
           gate_status=?, gate_note=?, gate_started_at=?
     WHERE id=? AND status='queued'
  `).run(
    status, runId, row?.worktree ?? null, row?.base_head ?? null, row?.exit_code ?? null, row?.duration_ms ?? null,
    row ? row.cost_usd : null, row ? row.cost_reported : null,
    run ? run.in_tokens : null, run ? run.out_tokens : null, run ? run.cache_read : null, run ? run.cache_write : null,
    ran ? row!.files_changed : null, row?.started_at ?? null, row?.ended_at ?? null,
    row ? row.error : 'The headless run this attempt started is gone, so its outcome could not be read.',
    JSON.stringify(launchOf(config)),
    trial ? 'running' : status === 'unrecorded' ? 'unavailable' : 'not-run',
    trial ? null : notTrialNote(status, row),
    trial ? Date.now() : null,
    attempt.id,
  );
  if (changed.changes !== 1) return null;
  if (!trial) {
    finishSetIfDone(attempt.set_id);
    return null;
  }
  return { attemptId: attempt.id, setId: attempt.set_id, projectId: set.project_id, baseCommit: set.base_commit, worktree: row?.worktree ?? null };
}

async function gateAndClose(work: Claimed): Promise<void> {
  let graded: Graded;
  try {
    graded = await grade(work.attemptId, work.projectId, work.baseCommit, work.worktree);
  } catch (error) {
    graded = { gate: 'unavailable', note: `The gate could not run: ${msg(error)}`, reviewRunId: null, tree: null, oracle: null };
  }
  try {
    db().prepare("UPDATE attempts SET gate_status=?, gate_note=?, review_run_id=?, tree=?, oracle_json=? WHERE id=? AND gate_status='running'")
      .run(graded.gate, graded.note, graded.reviewRunId, graded.tree, graded.oracle ? JSON.stringify(graded.oracle) : null, work.attemptId);
    finishSetIfDone(work.setId);
  } catch (error) {
    // Still 'running' on disk, which the next start's sweep closes as unavailable.
    console.warn('[wanigan] could not write the gate result for attempt', work.attemptId, error);
  }
}

type Graded = { gate: Exclude<AttemptGate, 'running'>; note: string | null; reviewRunId: string | null; tree: string | null; oracle: AttemptOracle | null };

/**
 * The tree first, then the gate, in the attempt's own worktree.
 *
 * The tree is read before the commands run so "passed" names the bytes it
 * passed on, not whatever a build left behind. Every way this can fail is
 * written down as 'unavailable' with its reason, and none of them is a pass.
 */
async function grade(attemptId: string, projectId: string, baseCommit: string, worktree: string | null): Promise<Graded> {
  const unavailable = (note: string, partial: Partial<Graded> = {}): Graded => ({ gate: 'unavailable', note, reviewRunId: null, tree: null, oracle: null, ...partial });
  if (!worktree) return unavailable('This attempt recorded no worktree, so there is no tree of its own to gate.');
  if (!fs.existsSync(worktree)) return unavailable(`This attempt's worktree is no longer on disk (${worktree}), so there is no tree to gate.`);
  try {
    const snapshot = await snapshotTree(worktree, baseCommit, attemptId);
    const oracle: AttemptOracle = { reading: snapshot.oracle, note: snapshot.oracle ? null : snapshot.note };
    const commands = review.recipe(projectId).commands;
    if (!snapshot.tree) {
      return unavailable(`${snapshot.note ?? 'The tree could not be recorded.'}${commands.length ? '' : ' This project also has no review commands.'}`, { oracle });
    }
    if (!commands.length) {
      return { gate: 'not-run', note: 'This project has no review commands, so nothing tested this tree. Add them under Git › Review gate.', reviewRunId: null, tree: snapshot.tree, oracle };
    }
    const run = await review.runAt(projectId, worktree);
    const last = run.results[run.results.length - 1];
    return {
      gate: run.status === 'passed' ? 'passed' : 'failed',
      note: run.status === 'passed'
        ? `${plural(run.results.length, 'review command')} passed in this attempt's worktree.`
        : last
          ? `Failed at \`${last.command}\` (${last.exitCode === null ? 'stopped, or could not start' : `exit ${last.exitCode}`}) after ${run.results.length} of ${commands.length}.`
          : 'The gate recorded no command result.',
      reviewRunId: run.id,
      tree: snapshot.tree,
      oracle,
    };
  } catch (error) {
    return unavailable(`The gate could not run: ${msg(error)}`);
  } finally {
    forgetTreeSnapshot(attemptId);
  }
}

/** Closes a set once nothing in it is queued or being gated, and says so once. */
function finishSetIfDone(setId: string): void {
  const d = db();
  const closed = d.prepare(`
    UPDATE attempt_sets SET status='finished'
     WHERE id=? AND status='running'
       AND NOT EXISTS (SELECT 1 FROM attempts WHERE set_id=? AND (status='queued' OR gate_status='running'))
  `).run(setId, setId);
  if (!closed.changes) return;
  try {
    const set = d.prepare('SELECT s.kind, p.name AS project_name FROM attempt_sets s LEFT JOIN projects p ON p.id=s.project_id WHERE s.id=?')
      .get(setId) as { kind: string; project_name: string | null } | undefined;
    const rows = d.prepare('SELECT status, gate_status, cost_usd, cost_reported FROM attempts WHERE set_id=?')
      .all(setId) as { status: AttemptStatus; gate_status: string | null; cost_usd: number | null; cost_reported: number | null }[];
    const trials = rows.filter((r) => isTrialStatus(r.status));
    const priced = trials.filter((r) => r.cost_reported === 1);
    const spent = priced.reduce((sum, r) => sum + (Number(r.cost_usd) || 0), 0);
    const passed = rows.filter((r) => r.gate_status === 'passed').length;
    notify({
      title: `${set?.kind === 'bench' ? 'Paired bench' : 'Best of N'} finished${set?.project_name ? ` · ${set.project_name}` : ''}`,
      // Counts and a cost the CLIs reported — nothing an agent wrote.
      body: `${plural(rows.length, 'attempt')} · ${passed} passed the gate · ${priced.length === 0 ? 'no cost reported'
        : `$${spent.toFixed(2)} reported${priced.length < trials.length ? ` by ${priced.length} of ${trials.length}` : ''}`}`,
      hold: true,
    });
  } catch (error) {
    console.warn('[wanigan] could not announce the finished attempt set', setId, error);
  }
}

/**
 * What the last process left undone. A gate it was running is closed as
 * unavailable, not re-run: nobody watched it stop, and silently running a
 * project's commands again is not a recovery anyone asked for. A run that
 * ended while nothing was listening is recorded now.
 *
 * gate_started_at, not a process-local set, so a gate this process began a
 * moment ago is never taken for an orphan. A launchd scheduler that began a
 * gate before this process started is the one case closed early — its result
 * then finds the attempt already closed and is not written — which is the same
 * trade the headless and review sweeps make.
 */
export async function sweepAttempts(): Promise<void> {
  const d = db();
  d.prepare(`
    UPDATE attempts SET gate_status='unavailable',
           gate_note='Wanigan stopped while this attempt was being gated, so its gate has no result. The worktree is untouched.'
     WHERE gate_status='running' AND COALESCE(gate_started_at, 0) < ?
  `).run(PROCESS_START);
  const ended = d.prepare(`
    SELECT a.headless_run_id AS run_id FROM attempts a
     WHERE a.status='queued' AND a.headless_run_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM headless_rows h WHERE h.run_id=a.headless_run_id AND h.status IN ('pending','running','awaiting'))
  `).all() as { run_id: string }[];
  // A set this process did not create, with attempts that never got a run,
  // was interrupted while it was being launched.
  d.prepare(`
    UPDATE attempts SET status='failed-to-start', gate_status='not-run',
           error='Wanigan stopped while this set was being launched, before this attempt was started.'
     WHERE status='queued' AND headless_run_id IS NULL
       AND set_id IN (SELECT id FROM attempt_sets WHERE created_at < ?)
  `).run(PROCESS_START);
  for (const { run_id } of ended) await recordAttemptRun(run_id);
  const sets = d.prepare("SELECT id FROM attempt_sets WHERE status='running'").all() as { id: string }[];
  for (const { id } of sets) finishSetIfDone(id);
}

/**
 * Record attempts as their runs end, in whichever process ends them. Called
 * from service startup, which the attended app and the launchd scheduler share.
 */
export function watchAttemptRuns(): () => void {
  const stop = headless.onHeadlessRunEnded((runId) => { void recordAttemptRun(runId); });
  void sweepAttempts().catch((error: unknown) => console.warn('[wanigan] the attempts sweep failed:', error));
  return stop;
}

/* ── reads ─────────────────────────────────────────────────────────────── */

const STATUSES: ReadonlySet<string> = new Set<AttemptStatus>(['queued', 'succeeded', 'errored', 'timeout', 'blocked', 'canceled', 'failed-to-start', 'unrecorded']);
const GATES: ReadonlySet<string> = new Set<AttemptGate>(['running', 'passed', 'failed', 'not-run', 'unavailable']);
const SET_STATUSES: ReadonlySet<string> = new Set<AttemptSetStatus>(['running', 'finished', 'failed']);

function armsOf(set: SetRecord): AttemptArm[] {
  let parsed: unknown;
  try { parsed = JSON.parse(set.arms_json); } catch { parsed = null; }
  const arms = Array.isArray(parsed) ? parsed as AttemptArm[] : null;
  if (!arms || !arms.length || arms.some((arm) => !arm || typeof arm.providerId !== 'string' || typeof arm.profileFingerprint !== 'string')) {
    // An unreadable arm list is a failed read, not a set with no arms: every
    // figure in its report would be computed over nothing and look measured.
    throw new Error(`The arms of attempt set ${set.id} could not be read back, so its report cannot be computed.`);
  }
  return arms.map((arm) => ({
    providerId: arm.providerId, model: text(arm.model), effort: text(arm.effort),
    label: typeof arm.label === 'string' ? arm.label : arm.providerId, profileFingerprint: arm.profileFingerprint, budgetFlag: arm.budgetFlag === true,
  }));
}

const SET_COLUMNS = `s.id, s.project_id, s.kind, s.prompt, s.prompt_sha256, s.base_commit, s.arms_json, s.repeats, s.budget_usd, s.timeout_ms,
  s.status, s.kept_attempt_id, s.decided_at, s.created_at, s.hold_for_approval, p.name AS project_name`;

function summaryOf(set: SetRecord, counts: { attempts: number; open: number; passes: number }): AttemptSetSummary {
  const title = set.prompt.split('\n').map((line) => line.trim()).find(Boolean) ?? '';
  return {
    id: set.id,
    projectId: set.project_id,
    projectName: set.project_name,
    kind: (set.kind === 'bench' ? 'bench' : 'best-of-n') as AttemptSetKind,
    title: title.length > 140 ? `${title.slice(0, 139)}…` : title,
    baseCommit: set.base_commit,
    arms: armsOf(set),
    repeats: Number(set.repeats),
    budgetUsd: Number(set.budget_usd),
    timeoutMs: Number(set.timeout_ms),
    status: (SET_STATUSES.has(set.status) ? set.status : 'failed') as AttemptSetStatus,
    attempts: Number(counts.attempts) || 0,
    open: Number(counts.open) || 0,
    passes: Number(counts.passes) || 0,
    keptAttemptId: set.kept_attempt_id,
    decidedAt: set.decided_at,
    createdAt: Number(set.created_at),
  };
}

export function attemptSets(limit = 50): AttemptSetSummary[] {
  const rows = db().prepare(`
    SELECT ${SET_COLUMNS},
           (SELECT COUNT(*) FROM attempts a WHERE a.set_id=s.id) AS attempts,
           (SELECT COUNT(*) FROM attempts a WHERE a.set_id=s.id AND (a.status='queued' OR a.gate_status='running')) AS open,
           (SELECT COUNT(*) FROM attempts a WHERE a.set_id=s.id AND a.gate_status='passed') AS passes
      FROM attempt_sets s LEFT JOIN projects p ON p.id=s.project_id
     ORDER BY s.created_at DESC LIMIT ?
  `).all(Math.max(1, Math.min(200, Math.round(Number(limit) || 50)))) as (SetRecord & { attempts: number; open: number; passes: number })[];
  return rows.map((row) => summaryOf(row, row));
}

type AttemptDbRow = {
  id: string; set_id: string; arm_index: number; repeat_index: number; headless_run_id: string | null; worktree: string | null;
  base_head: string | null; status: string; exit_code: number | null; duration_ms: number | null; cost_usd: number | null;
  cost_reported: number | null; in_tokens: number | null; out_tokens: number | null; cache_read: number | null; cache_write: number | null;
  files_changed: number | null; gate_status: string | null; gate_note: string | null; review_run_id: string | null; tree: string | null;
  oracle_json: string | null; started_at: number | null; ended_at: number | null; error: string | null; launch_json: string | null;
  live_status: string | null;
};

function rowOf(r: AttemptDbRow): AttemptRow {
  const status = (STATUSES.has(r.status) ? r.status : 'unrecorded') as AttemptStatus;
  let gate: AttemptGate | null = r.gate_status === null ? null : GATES.has(r.gate_status) ? r.gate_status as AttemptGate : 'unavailable';
  let gateNote = r.gate_status !== null && !GATES.has(r.gate_status) ? `The recorded gate result "${r.gate_status}" is not one this build can read.` : r.gate_note;
  if (status === 'queued' && gate !== null) { gate = null; gateNote = null; }
  let oracle: AttemptOracle | null = null;
  if (r.oracle_json !== null) {
    try {
      const parsed = JSON.parse(r.oracle_json) as AttemptOracle;
      oracle = { reading: parsed.reading ?? null, note: typeof parsed.note === 'string' ? parsed.note : null };
    } catch {
      oracle = { reading: null, note: 'The recorded oracle reading could not be read back.' };
    }
  }
  let launch: AttemptLaunch | null = null;
  try { launch = r.launch_json ? JSON.parse(r.launch_json) as AttemptLaunch | null : null; } catch { launch = null; }
  const tokens = [r.in_tokens, r.out_tokens, r.cache_read, r.cache_write].map((n) => Number(n) || 0);
  return {
    id: r.id,
    setId: r.set_id,
    armIndex: Number(r.arm_index),
    repeatIndex: Number(r.repeat_index),
    headlessRunId: r.headless_run_id,
    status,
    liveStatus: status === 'queued' ? r.live_status ?? 'pending' : null,
    worktree: r.worktree,
    worktreeOnDisk: r.worktree !== null && fs.existsSync(r.worktree),
    baseHead: r.base_head,
    exitCode: r.exit_code,
    durationMs: r.duration_ms,
    // Null unless the CLI named a figure, so nothing downstream can print the
    // stored zero of an unreported run as $0.00.
    costUsd: r.cost_reported === 1 && r.cost_usd !== null ? Number(r.cost_usd) : null,
    costReported: r.cost_reported === null ? null : Number(r.cost_reported) === 1,
    // A run that reports usage reports input tokens; all zeros is a run that
    // reported none, which is not the same as a run that used none.
    tokens: tokens.some((n) => n > 0) ? { input: tokens[0], output: tokens[1], cacheRead: tokens[2], cacheWrite: tokens[3] } : null,
    filesChanged: r.files_changed,
    gate,
    gateNote,
    reviewRunId: r.review_run_id,
    tree: r.tree,
    oracle,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    error: r.error,
    launch,
  };
}

function cleanupOf(set: SetRecord, rows: AttemptRow[]): AttemptCleanupPlan {
  const worktrees = rows
    .filter((row) => row.id !== set.kept_attempt_id && row.worktree !== null && row.worktreeOnDisk)
    .map((row) => ({ attemptId: row.id, path: row.worktree as string }));
  const open = rows.filter((row) => row.status === 'queued' || row.gate === 'running').length;
  if (open) {
    return { allowed: false, worktrees, reason: `${plural(open, 'attempt')} ${open === 1 ? 'is' : 'are'} still running or being gated, and a worktree in use is never removed.` };
  }
  if (set.kind === 'best-of-n' && !set.kept_attempt_id) {
    return { allowed: false, worktrees, reason: 'Keep an attempt first. Removing worktrees before choosing would remove every candidate.' };
  }
  if (!worktrees.length) return { allowed: false, worktrees, reason: 'No other attempt has a worktree left on disk.' };
  return { allowed: true, worktrees, reason: null };
}

function setRecord(setId: unknown): SetRecord {
  if (typeof setId !== 'string' || !SET_ID.test(setId)) throw new Error('That is not an attempt set.');
  const set = db().prepare(`SELECT ${SET_COLUMNS} FROM attempt_sets s LEFT JOIN projects p ON p.id=s.project_id WHERE s.id=?`)
    .get(setId) as SetRecord | undefined;
  if (!set) throw new Error('That attempt set is no longer recorded.');
  return set;
}

export function attemptSet(setId: unknown): AttemptSetDetail {
  const set = setRecord(setId);
  const rows = (db().prepare(`
    SELECT a.id, a.set_id, a.arm_index, a.repeat_index, a.headless_run_id, a.worktree, a.base_head, a.status, a.exit_code, a.duration_ms,
           a.cost_usd, a.cost_reported, a.in_tokens, a.out_tokens, a.cache_read, a.cache_write, a.files_changed, a.gate_status, a.gate_note,
           a.review_run_id, a.tree, a.oracle_json, a.started_at, a.ended_at, a.error, a.launch_json,
           (SELECT h.status FROM headless_rows h WHERE h.run_id=a.headless_run_id LIMIT 1) AS live_status
      FROM attempts a WHERE a.set_id=? ORDER BY a.repeat_index, a.arm_index
  `).all(set.id) as AttemptDbRow[]).map(rowOf);
  const arms = armsOf(set);
  const forReport: AttemptForReport[] = rows.map((row) => ({
    armIndex: row.armIndex, status: row.status, gate: row.gate, baseHead: row.baseHead, launch: row.launch,
    costUsd: row.costUsd, costReported: row.costReported, filesChanged: row.filesChanged,
  }));
  const report = attemptReport({ baseCommit: set.base_commit, promptSha256: set.prompt_sha256, arms, repeats: Number(set.repeats) }, forReport);
  return {
    ...summaryOf(set, {
      attempts: rows.length,
      open: report.open,
      passes: rows.filter((row) => row.gate === 'passed').length,
    }),
    prompt: set.prompt,
    promptSha256: set.prompt_sha256,
    holdForApproval: Number(set.hold_for_approval) === 1,
    rows,
    report,
    cleanup: cleanupOf(set, rows),
  };
}

/* ── decisions ─────────────────────────────────────────────────────────── */

/**
 * Record which attempt the operator keeps. Nothing is merged and nothing is
 * removed: keeping is a decision on the record, and removing the others is its
 * own action. It can be changed until the chosen attempt's worktree is gone.
 */
export function keepAttempt(setId: unknown, attemptId: unknown): AttemptSetDetail {
  const set = setRecord(setId);
  if (typeof attemptId !== 'string' || !ATTEMPT_ID.test(attemptId)) throw new Error('Choose an attempt to keep.');
  const detail = attemptSet(set.id);
  const row = detail.rows.find((candidate) => candidate.id === attemptId);
  if (!row) throw new Error('That attempt is not part of this set.');
  if (!isTrialStatus(row.status)) {
    throw new Error(`Attempt ${row.repeatIndex + 1} of arm ${row.armIndex + 1} did not run to an end (${row.status}), so there is no work of its own to keep.`);
  }
  if (row.gate === 'running') throw new Error('That attempt is still being gated. Keep it once its gate has answered.');
  if (!row.worktreeOnDisk) throw new Error('That attempt\'s worktree is no longer on disk, so there is nothing left to keep.');
  db().prepare('UPDATE attempt_sets SET kept_attempt_id=?, decided_at=? WHERE id=?').run(attemptId, Date.now(), set.id);
  return attemptSet(set.id);
}

/**
 * Remove the worktrees of every attempt but the kept one.
 *
 * The paths come from the attempts' own records, never from the caller, and
 * each goes through removeWorktree without force. A worktree git refuses to
 * remove because it holds uncommitted work is reported as kept, with its count,
 * and is left exactly as it was. Branches are always kept.
 */
export async function removeOtherWorktrees(setId: unknown): Promise<AttemptCleanupResult> {
  const detail = attemptSet(setRecord(setId).id);
  if (!detail.cleanup.allowed) throw new Error(detail.cleanup.reason ?? 'There is nothing to remove.');
  const results: AttemptCleanupResult['results'] = [];
  for (const { attemptId, path } of detail.cleanup.worktrees) {
    if (!fs.existsSync(path)) {
      results.push({ attemptId, path, outcome: 'gone', detail: 'Already gone from disk.' });
      continue;
    }
    try {
      const removal = await removeWorktree(path, false);
      if (removal.removed) {
        results.push({ attemptId, path, outcome: 'removed', detail: removal.detail });
        continue;
      }
      const info = await worktreeStatus(path).catch(() => null);
      results.push(info && typeof info.dirty === 'number' && info.dirty > 0
        ? { attemptId, path, outcome: 'kept', detail: `Kept: ${plural(info.dirty, 'uncommitted file')} in it would have been deleted, and they exist nowhere else.` }
        : { attemptId, path, outcome: 'refused', detail: removal.detail });
    } catch (error) {
      results.push({ attemptId, path, outcome: 'refused', detail: msg(error) });
    }
  }
  return { setId: detail.id, results };
}
