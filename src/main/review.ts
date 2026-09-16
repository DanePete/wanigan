import { dialog, type BrowserWindow } from 'electron';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { db } from './db';
import { projectById } from './store';
import { checkoutSnapshot } from './review-checkout';
import { repoRootFor } from './worktrees';
import type { ReviewCheckoutSnapshot, ReviewEvidence, ReviewFreshness, ReviewRecipe, ReviewRun } from '../shared/types';

const OUTPUT_LIMIT = 128 * 1024;
const COMMAND_TIMEOUT_MS = 10 * 60_000;
/** Time a command gets to exit on SIGTERM before the group is killed outright. */
const KILL_GRACE_MS = 5_000;

function asCommands(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean).slice(0, 20);
}

export function recipe(projectId: string): ReviewRecipe {
  const row = db().prepare('SELECT commands_json, updated_at FROM review_recipes WHERE project_id=?').get(projectId) as { commands_json: string; updated_at: number } | undefined;
  try { return { projectId, commands: asCommands(row ? JSON.parse(row.commands_json) : []), updatedAt: row?.updated_at ?? null }; }
  catch { return { projectId, commands: [], updatedAt: row?.updated_at ?? null }; }
}

/**
 * Stores the command text with no question asked. IPC must not reach this
 * directly — review:saveRecipe goes through saveRecipeWithConsent below. Its
 * callers are that wrapper, once the question has been answered, and the smoke
 * suite, which writes a recipe as a module call and has no window to answer a
 * dialog.
 */
export function saveRecipe(projectId: string, commands: string[]): ReviewRecipe {
  if (!projectById(projectId)) throw new Error('Project not found.');
  const safe = asCommands(commands);
  if (safe.some((c) => c.length > 2_000)) throw new Error('A review command is too long (maximum 2,000 characters).');
  db().prepare(`INSERT INTO review_recipes (project_id, commands_json, updated_at) VALUES (?,?,?)
    ON CONFLICT(project_id) DO UPDATE SET commands_json=excluded.commands_json, updated_at=excluded.updated_at`)
    .run(projectId, JSON.stringify(safe), Date.now());
  return recipe(projectId);
}

/**
 * The same save, with the human in the loop. This is the entry point IPC uses.
 *
 * The question is on the save rather than on the run. runCommand hands each
 * stored string to `$SHELL -lc`, and a recipe is written once and executed many
 * times from more than one surface: review:run for the project,
 * control.runProof for a goal's verify task, which runs the same stored text in
 * that task's worktree when it has one, a goal that gates on stop, which runs it
 * in an implementation or verification task's tree each time that task's agent
 * stops, and an attempt set, which runs it in each attempt's worktree when that
 * attempt's agent finishes. Consent belongs where the capability is created.
 * Re-asking at each run would ask again about text already approved, which is
 * how a person learns to click a dialog away. runAt is also a plain module call
 * — the gate on stop and the attempts gate both run it with nobody pressing
 * anything, after a person turned them on — so gating the store is what keeps
 * the text approved whatever calls the runner.
 *
 * Only commands the stored recipe does not already contain are put in the
 * dialog. Dropping a command, or reordering the same set, asks for nothing the
 * recipe could not already run.
 */
export async function saveRecipeWithConsent(
  win: BrowserWindow | null,
  projectId: string,
  commands: string[]
): Promise<ReviewRecipe> {
  const project = projectById(projectId);
  if (!project) throw new Error('Project not found.');
  const safe = asCommands(commands);
  if (safe.some((c) => c.length > 2_000)) throw new Error('A review command is too long (maximum 2,000 characters).');

  const stored = recipe(projectId).commands;
  const added = safe.filter((c) => !stored.includes(c));
  if (!added.length) return saveRecipe(projectId, safe);

  if (!win || win.isDestroyed()) {
    throw new Error('Saving a new review command needs the Wanigan window open to confirm it.');
  }
  const one = added.length === 1;
  const answer = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Cancel', one ? 'Save this command' : `Save these ${added.length} commands`],
    defaultId: 0,
    cancelId: 0,
    title: one ? 'Save a new review command?' : 'Save new review commands?',
    message: one
      ? `Add a review command to ${project.name}?`
      : `Add ${added.length} review commands to ${project.name}?`,
    detail:
      `Wanigan runs a review gate through your login shell in ${project.path} or the recorded session or task checkout you select. ` +
      `${one ? 'This is the line' : 'These are the lines'} being added:\n\n` +
      added.map((c) => `    ${c}`).join('\n') +
      '\n\nThis is stored, not run once: the Review panel runs it for the project or selected session, a goal\'s ' +
      'verification task runs it again in that task\'s worktree when it has one, a goal that gates on ' +
      'stop runs it in a task\'s tree each time that task\'s agent stops, and an attempt set runs it in ' +
      'each attempt\'s worktree when that attempt finishes. None of them asks again. ' +
      'Save only what you would type here yourself.',
  });
  if (answer.response !== 1) {
    throw new Error('Cancelled. The review commands were not saved, so nothing new can be run by a gate.');
  }
  return saveRecipe(projectId, safe);
}

type RunRow = { id: string; project_id: string; started_at: number; ended_at: number | null; status: string; results_json: string; evidence_json: string | null };

function readEvidence(raw: string | null): ReviewEvidence | null {
  try {
    const value = JSON.parse(raw ?? 'null') as ReviewEvidence | null;
    if (value?.version === 1 && value.before && typeof value.recipeHash === 'string'
      && Array.isArray(value.commands) && value.commands.every(command => typeof command === 'string')) return value;
  } catch { /* old or unreadable evidence has no content identity */ }
  return null;
}

function map(row: RunRow): ReviewRun {
  let results: ReviewRun['results'] = [];
  try { results = JSON.parse(row.results_json) as ReviewRun['results']; } catch { /* preserve row with no fabricated evidence */ }
  const evidence = readEvidence(row.evidence_json);
  return { id: row.id, projectId: row.project_id, startedAt: row.started_at, endedAt: row.ended_at, status: row.status as ReviewRun['status'], results,
    evidence, freshness: { state: row.status === 'running' ? 'running' : 'unavailable', reason: 'Current checkout has not been compared.', checkedAt: Date.now() } };
}

const recipeHash = (commands: string[]) => createHash('sha256').update(JSON.stringify(commands)).digest('hex');

export function compareCheckoutEvidence(run: ReviewRun, current: ReviewCheckoutSnapshot, commands: string[]): ReviewFreshness {
  const answer = (state: ReviewFreshness['state'], reason: string): ReviewFreshness => ({ state, reason, checkedAt: Date.now() });
  if (run.status === 'running') return answer('running', 'Checks are still running.');
  const evidence = run.evidence;
  if (!evidence) return answer('unavailable', 'This historical run has no recorded checkout or recipe identity. Run checks again.');
  if (!evidence.before.fingerprint || !evidence.after?.fingerprint) {
    return answer('unavailable', evidence.before.unavailableReason ?? evidence.after?.unavailableReason ?? 'A complete checkout comparison was not recorded.');
  }
  if (evidence.before.fingerprint !== evidence.after.fingerprint) return answer('stale', 'Checkout content changed while these checks ran. Run checks again.');
  if (evidence.recipeHash !== recipeHash(commands)) return answer('stale', 'The saved commands have changed since this run. Run checks again.');
  if (!current.fingerprint) return answer('unavailable', current.unavailableReason ?? 'The current checkout could not be compared.');
  if (evidence.before.cwd !== current.cwd) return answer('stale', 'These checks ran in a different checkout.');
  if (evidence.before.fingerprint !== current.fingerprint) return answer('stale', 'Checkout content has changed since this run. Run checks again.');
  return answer('current', 'Git-visible content and saved commands match this run.');
}

/** Resolve only persisted session identity; the renderer never supplies a cwd. */
function targetRoot(projectId: string, sessionId?: string): string {
  if (typeof projectId !== 'string' || !projectId) throw new Error('Choose a recorded project.');
  const project = projectById(projectId);
  if (!project) throw new Error('Project not found.');
  if (sessionId === undefined) return project.path;
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200) throw new Error('Choose a recorded session.');
  const row = db().prepare("SELECT project_id, project_path, worktree FROM session_log WHERE id=? AND origin='wanigan'")
    .get(sessionId) as { project_id: string | null; project_path: string; worktree: string | null } | undefined;
  if (!row || row.project_id !== projectId || path.resolve(row.project_path) !== path.resolve(project.path)) {
    throw new Error('This session does not belong to the selected project checkout.');
  }
  return row.worktree ?? row.project_path;
}

async function sessionRoot(projectId: string, sessionId: string): Promise<string> {
  const root = targetRoot(projectId, sessionId);
  let canonical: string;
  try {
    canonical = await fs.realpath(root);
    if (!(await fs.stat(canonical)).isDirectory()) throw new Error('Not a directory.');
  } catch { throw new Error('The session checkout is missing or unreadable. Restore it before running checks.'); }
  const project = projectById(projectId)!;
  if (path.resolve(root) !== path.resolve(project.path)) {
    const [projectRepo, sessionRepo] = await Promise.all([repoRootFor(project.path), repoRootFor(canonical)]);
    if (!projectRepo || projectRepo !== sessionRepo) throw new Error('The session checkout no longer belongs to this project.');
  }
  return canonical;
}

const PROCESS_START = Date.now();
let swept = false;

/**
 * Runs left 'running' by a process that died mid-gate.
 *
 * Nothing outside this module writes review_runs.status, and the row is only
 * flipped by the UPDATE at the end of runAt — so a crash, a force quit or an
 * update strands the row for ever and history() keeps reporting an in-flight
 * gate that is not running anywhere. They are closed as failed rather than
 * re-run: nobody watched the crash, and silently re-executing a project's
 * build commands is not a recovery anyone asked for. 'failed' is the honest
 * status the stored shape has; the appended note says what actually happened.
 *
 * started_at, not a process-local set: a row this process marked 'running'
 * moments ago must not be mistaken for an orphan. A second Wanigan process
 * that began a gate before this one started is the one case this closes early,
 * which is the same trade the headless sweep makes.
 */
export function sweepInterruptedRuns(): number {
  if (swept) return 0;
  swept = true;

  const d = db();
  const rows = d.prepare("SELECT id, results_json FROM review_runs WHERE status='running' AND started_at < ?")
    .all(PROCESS_START) as { id: string; results_json: string }[];
  if (!rows.length) return 0;

  const stmt = d.prepare("UPDATE review_runs SET ended_at=?, status='failed', results_json=? WHERE id=? AND status='running'");
  const now = Date.now();
  let closed = 0;
  for (const row of rows) {
    let results: ReviewRun['results'] = [];
    try { results = JSON.parse(row.results_json) as ReviewRun['results']; } catch { results = []; }
    if (!Array.isArray(results)) results = [];
    results.push({
      command: '[Wanigan review gate]',
      exitCode: null,
      output: 'Wanigan stopped while this gate was running, so the commands went with it. Whatever had already finished is recorded above; a command still in flight left no output, and nothing after it ran. Run the gate again for a complete result.',
      durationMs: 0,
    });
    closed += stmt.run(now, JSON.stringify(results), row.id).changes;
  }
  return closed;
}

export function history(projectId: string, limit = 12, sessionId?: string): ReviewRun[] {
  // Before the read, so the panel never shows a gate as in flight when the
  // process that was running it is gone.
  sweepInterruptedRuns();
  const cap = Number.isFinite(limit) ? Math.max(1, Math.min(50, Math.trunc(limit))) : 12;
  return (db().prepare('SELECT * FROM review_runs WHERE project_id=? AND session_id IS ? ORDER BY started_at DESC, rowid DESC LIMIT ?')
    .all(projectId, sessionId ?? null, cap) as RunRow[]).map(map);
}

export async function historyWithFreshness(projectId: string, limit = 12, sessionId?: string): Promise<ReviewRun[]> {
  const root = targetRoot(projectId, sessionId);
  const runs = history(projectId, limit, sessionId);
  if (!runs.length) return runs;
  let current: ReviewCheckoutSnapshot = { cwd: root, head: null, fingerprint: null, unavailableReason: 'Current checkout has not been compared.' };
  if (runs.some(run => run.status !== 'running' && run.evidence?.before.fingerprint)) {
    try { current = await checkoutSnapshot(sessionId === undefined ? root : await sessionRoot(projectId, sessionId)); }
    catch (error) { current.unavailableReason = error instanceof Error ? error.message : 'The session checkout is unavailable.'; }
  }
  const commands = recipe(projectId).commands;
  // Re-read after filesystem work so a completed run is not returned as running.
  return history(projectId, limit, sessionId).map(run => ({ ...run, freshness: compareCheckoutEvidence(run, current, commands) }));
}

/** A decision always rechecks the filesystem; no renderer freshness flag is trusted. */
export async function isCurrentPass(runId: string, projectId: string, cwd: string): Promise<boolean> {
  const row = db().prepare('SELECT * FROM review_runs WHERE id=? AND project_id=?').get(runId, projectId) as RunRow | undefined;
  if (!row || row.status !== 'passed') return false;
  const run = map(row);
  const current = await checkoutSnapshot(cwd);
  try { assertPassNotSuperseded(runId, projectId, current.cwd); } catch { return false; }
  return compareCheckoutEvidence(run, current, recipe(projectId).commands).state === 'current';
}

/** Synchronous final decision guard, also called inside Control's transaction. */
export function assertPassNotSuperseded(runId: string, projectId: string, cwd: string): void {
  let canonical: string;
  try { canonical = realpathSync(cwd); }
  catch { throw new Error('The verification checkout is unavailable. Restore it and rerun the checks.'); }
  if (activeRoots.has(canonical)) throw new Error('Checks are running in a verification checkout. Wait for the new result before deciding.');
  type IdentityRow = { ordinal: number; status: string; evidence_json: string | null };
  const recorded = db().prepare('SELECT rowid AS ordinal,status,evidence_json FROM review_runs WHERE id=? AND project_id=?')
    .get(runId, projectId) as IdentityRow | undefined;
  const base = recorded ? readEvidence(recorded.evidence_json) : null;
  if (!recorded || recorded.status !== 'passed' || !base?.before.fingerprint) throw new Error('Run the review gate to record a current verification proof.');
  if (canonical !== base.before.cwd || canonical !== base.after?.cwd || base.before.fingerprint !== base.after.fingerprint) {
    throw new Error('The verification checkout identity changed. Run the review gate again before deciding.');
  }
  const newer = db().prepare('SELECT rowid AS ordinal,status,evidence_json FROM review_runs WHERE project_id=? AND rowid>? ORDER BY rowid DESC')
    .iterate(projectId, recorded.ordinal) as Iterable<IdentityRow>;
  for (const row of newer) {
    const evidence = readEvidence(row.evidence_json);
    if (!evidence || evidence.before.cwd !== canonical || evidence.recipeHash !== base.recipeHash) continue;
    // The latest relevant run decides, including runs started from Session
    // Review or Changes rather than the goal. Never let an older green result
    // overrule a newer failure, incomplete run or changed-content result.
    if (row.status !== 'passed' || evidence.before.fingerprint !== base.before.fingerprint
      || evidence.after?.fingerprint !== base.before.fingerprint) {
      throw new Error('A newer run superseded this verification result. Run and pass the review gate again before deciding.');
    }
    break;
  }
}

async function runCommand(command: string, cwd: string): Promise<ReviewRun['results'][number]> {
  const started = Date.now();
  return new Promise((resolve) => {
    const shell = process.env.SHELL || '/bin/zsh';
    let out = ''; let timedOut = false;
    // Its own process group: the spawned thing is a shell, and signalling the
    // shell alone leaves the `npm test` underneath it running after the gate
    // has given up on it.
    const child = spawn(shell, ['-lc', command], { cwd, env: { ...process.env, NO_COLOR: '1', TERM: 'dumb' }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    // Stored evidence that stops mid-sentence has to say so. A 128KB cap is
    // fine; a capped record that reads as the whole run is a false record.
    let truncated = false;
    const add = (b: Buffer) => {
      const room = OUTPUT_LIMIT - out.length;
      if (room <= 0) { truncated = true; return; }
      const text = b.toString();
      if (text.length > room) { out += text.slice(0, room); truncated = true; }
      else out += text;
    };
    child.stdout?.on('data', add); child.stderr?.on('data', add);
    const stop = (signal: NodeJS.Signals) => {
      try { if (child.pid) process.kill(-child.pid, signal); }
      catch { try { child.kill(signal); } catch { /* already exited */ } }
    };
    let killer: NodeJS.Timeout | null = null;
    const timer = setTimeout(() => {
      timedOut = true;
      stop('SIGTERM');
      // A command that blocks or ignores SIGTERM would otherwise never close,
      // leaving this promise unresolved and its run row 'running' forever.
      killer = setTimeout(() => stop('SIGKILL'), KILL_GRACE_MS);
    }, COMMAND_TIMEOUT_MS);
    const done = (result: ReviewRun['results'][number]) => {
      clearTimeout(timer); if (killer) clearTimeout(killer);
      resolve(result);
    };
    child.once('close', (code) => {
      const notes = [
        truncated ? `[Wanigan kept the first ${Math.round(OUTPUT_LIMIT / 1024)}KB of this command's output; the rest was discarded, not produced empty.]` : null,
        timedOut ? '[Wanigan stopped this command after 10 minutes.]' : null,
      ].filter(Boolean);
      done({
        command,
        exitCode: timedOut ? null : code,
        output: notes.length ? `${out}\n${notes.join('\n')}` : out,
        durationMs: Date.now() - started,
      });
    });
    child.once('error', (e) => done({ command, exitCode: null, output: e.message, durationMs: Date.now() - started }));
  });
}

/**
 * The control plane may point a gate at a worktree created by Wanigan. Keeping
 * this internal argument out of the IPC surface means no renderer names the
 * directory: review:run resolves only a persisted session id or the registered
 * project, control's gate runs, pressed or triggered
 * by an agent stopping, pass the worktree Wanigan recorded for the task, or the
 * project path, and the attempts gate passes the worktree recorded on the
 * attempt's own run. It does not
 * confine the command text, which is whatever the recipe holds and reaches
 * `$SHELL -lc` verbatim; that is what saveRecipeWithConsent puts a person in
 * front of.
 */
const activeRoots = new Set<string>();

export async function runAt(projectId: string, cwd?: string, sessionId?: string): Promise<ReviewRun> {
  const project = projectById(projectId);
  if (!project) throw new Error('Project not found.');
  const root = cwd ?? project.path;
  const commands = recipe(projectId).commands;
  if (!commands.length) throw new Error('Add at least one review command before running a gate.');
  // Resolve aliases before claiming the checkout, without deferring the running
  // receipt. The async reader below still records missing/unreadable directories.
  let activeKey: string;
  try { activeKey = realpathSync(root); } catch { activeKey = path.resolve(root); }
  if (activeRoots.has(activeKey)) throw new Error('Checks are already running in this checkout.');
  // Also here, not only in history(): a gate started right after a crash would
  // otherwise leave the earlier row reading 'running' until something asks for
  // the history.
  sweepInterruptedRuns();
  const id = `rev_${randomUUID().slice(0, 12)}`; const startedAt = Date.now();
  // The phone reads this receipt immediately after starting a run. Insert it
  // before any asynchronous snapshot, and always close it even on read failure.
  let evidence: ReviewEvidence = { version: 1, sessionId: sessionId ?? null, recipeHash: recipeHash(commands), commands,
    before: { cwd: activeKey, head: null, fingerprint: null, unavailableReason: 'The initial checkout comparison did not finish.' }, after: null };
  db().prepare('INSERT INTO review_runs (id, project_id, session_id, started_at, status, results_json, evidence_json) VALUES (?,?,?,?,?,?,?)')
    .run(id, projectId, sessionId ?? null, startedAt, 'running', '[]', JSON.stringify(evidence));
  activeRoots.add(activeKey);
  const results: ReviewRun['results'] = [];
  const record = db().prepare('UPDATE review_runs SET results_json=? WHERE id=?');
  try {
    const canonical = await fs.realpath(root);
    if (canonical !== activeKey) throw new Error('The checkout location changed while checks were starting. Refresh and run them again.');
    if (!(await fs.stat(canonical)).isDirectory()) throw new Error('The review checkout is not a directory.');
    evidence = { version: 1, sessionId: sessionId ?? null, recipeHash: recipeHash(commands), commands,
      before: await checkoutSnapshot(canonical), after: null };
    db().prepare('UPDATE review_runs SET evidence_json=? WHERE id=?').run(JSON.stringify(evidence), id);
    for (const command of commands) {
      const result = await runCommand(command, canonical); results.push(result);
      // Persist each completed command, even if the process later stops.
      record.run(JSON.stringify(results), id);
      if (result.exitCode !== 0) break;
    }
    evidence.after = await checkoutSnapshot(canonical);
  } catch (error) {
    results.push({ command: '[Wanigan review gate]', exitCode: null,
      output: error instanceof Error ? error.message : String(error), durationMs: 0 });
  } finally {
    activeRoots.delete(activeKey);
  }
  const status: ReviewRun['status'] = results.length === commands.length && results.every((r) => r.exitCode === 0) ? 'passed' : 'failed';
  const endedAt = Date.now();
  db().prepare('UPDATE review_runs SET ended_at=?, status=?, results_json=?, evidence_json=? WHERE id=?')
    .run(endedAt, status, JSON.stringify(results), JSON.stringify(evidence), id);
  const run: ReviewRun = { id, projectId, startedAt, endedAt, status, results, evidence,
    freshness: { state: 'unavailable', reason: 'Checkout comparison unavailable.', checkedAt: endedAt } };
  if (evidence?.after) run.freshness = compareCheckoutEvidence(run, evidence.after, recipe(projectId).commands);
  return run;
}

export async function run(projectId: string, sessionId?: string): Promise<ReviewRun> {
  targetRoot(projectId, sessionId);
  if (sessionId === undefined) return runAt(projectId);
  return runAt(projectId, await sessionRoot(projectId, sessionId), sessionId);
}
