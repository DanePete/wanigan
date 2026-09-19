import { dialog, type BrowserWindow } from 'electron';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db } from './db';
import { listProjects, projectById } from './store';
import type { Project } from '../shared/types';
import { shellCommand } from '../shared/platform';
import { hostPlatform, killProcessTree } from './platform';
import {
  DEFAULT_DEPS_MODE, WORKTREE_PHASE_BUDGET_MS, asDepsMode, durationText, newCommands, parseCommandInput,
  type DepsMode, type WorktreeCommandEnv, type WorktreeCommandLists, type WorktreeCommandResult,
  type WorktreeCommandRun, type WorktreePhase,
} from '../shared/worktree-bootstrap';

/**
 * Setup and teardown commands for the worktrees Wanigan makes, and the
 * per-project choice of how dependency folders reach them.
 *
 * The commands keep the review recipe's contract (review.ts) because they are
 * the same kind of thing: command text the operator writes once, approves in a
 * native dialog once, and Wanigan runs many times through `$SHELL -lc`. They
 * differ in when they run — setup in each new worktree right after it is made,
 * teardown in a worktree just before it is removed — and in what a failure
 * means. A failed gate is a verdict. A failed setup must not delete the
 * worktree it ran in, because that worktree is where its output makes sense,
 * and must not stop the launch, because whether a half-set-up checkout is
 * still worth an agent is the operator's call; the run is recorded and shown
 * beside the worktree instead.
 *
 * Nothing here is written into the repository. Conductor and Superset read
 * their scripts from a file in the checkout, which hands them to every clone
 * and to every agent able to edit that file; these live in Wanigan's database.
 */

function canon(p: string): string {
  const abs = path.resolve(p);
  try { return fs.realpathSync(abs); } catch { return abs; }
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The project a directory belongs to, looked up by path.
 *
 * createWorktree is handed a directory rather than a project — sessions.ts and
 * headless.ts both pass the project's path — so the per-project choices are
 * found from it. Compared after realpath, for the reason worktrees.ts gives: on
 * macOS one directory is /var/… to git and /private/var/… to Node. The
 * directory the caller named is tried before the repository root, so a project
 * registered at a subdirectory, from before projects had to be whole
 * repositories, still finds its own settings.
 */
export function projectForDirectory(dir: string, repoRoot: string): Project | null {
  const projects = listProjects();
  const at = (target: string) => projects.find((p) => canon(p.path) === target);
  return at(canon(dir)) ?? at(canon(repoRoot)) ?? null;
}

/* ── dependency folders ──────────────────────────────────────────────── */

export function depsModeFor(projectId: string): DepsMode {
  const row = db().prepare('SELECT mode FROM project_worktree_deps WHERE project_id = ?').get(projectId) as
    { mode: string } | undefined;
  return asDepsMode(row?.mode) ?? DEFAULT_DEPS_MODE;
}

/**
 * Stored with no dialog, unlike the commands below. Link, clone or skip grants
 * nothing that can run: it decides how folders that already exist on this
 * machine appear in a worktree, costs at most a clone's time, and is undone by
 * choosing again.
 */
export function setDepsMode(projectId: unknown, mode: unknown): DepsMode {
  if (typeof projectId !== 'string' || !projectById(projectId)) throw new Error('Project not found.');
  const next = asDepsMode(mode);
  if (!next) {
    throw new Error(`${typeof mode === 'string' ? `"${mode}"` : 'That'} is not a dependency folder choice. Use link, clone or skip.`);
  }
  db().prepare(`INSERT INTO project_worktree_deps (project_id, mode, set_at) VALUES (?,?,?)
    ON CONFLICT(project_id) DO UPDATE SET mode = excluded.mode, set_at = excluded.set_at`).run(projectId, next, Date.now());
  return next;
}

/* ── the stored commands ─────────────────────────────────────────────── */

export type StoredWorktreeCommands = WorktreeCommandLists & { projectId: string; updatedAt: number | null };

/**
 * The stored lists. A row that cannot be parsed throws rather than reading as
 * empty: an empty setup list means "run nothing", and a damaged row read that
 * way would skip a setup the operator approved without a word to anyone.
 */
export function worktreeCommands(projectId: string): StoredWorktreeCommands {
  const row = db().prepare('SELECT setup_json, teardown_json, updated_at FROM worktree_commands WHERE project_id = ?')
    .get(projectId) as { setup_json: string; teardown_json: string; updated_at: number } | undefined;
  if (!row) return { projectId, setup: [], teardown: [], updatedAt: null };
  let parsed: ReturnType<typeof parseCommandInput>;
  try {
    parsed = parseCommandInput({ setup: JSON.parse(row.setup_json), teardown: JSON.parse(row.teardown_json) });
  } catch (e) {
    throw new Error(`Wanigan could not read the stored worktree commands: ${message(e)}`);
  }
  if ('problem' in parsed) throw new Error(`Wanigan could not read the stored worktree commands: ${parsed.problem}`);
  return { projectId, ...parsed, updatedAt: row.updated_at };
}

/**
 * Stores the command text with no question asked. IPC must not reach this
 * directly — worktrees:saveCommands goes through the consent wrapper below. Its
 * callers are that wrapper, once the question has been answered, and the smoke
 * suite, which has no window to answer a dialog.
 */
export function saveWorktreeCommands(projectId: unknown, input: unknown): StoredWorktreeCommands {
  if (typeof projectId !== 'string' || !projectById(projectId)) throw new Error('Project not found.');
  const parsed = parseCommandInput(input);
  if ('problem' in parsed) throw new Error(parsed.problem);
  db().prepare(`INSERT INTO worktree_commands (project_id, setup_json, teardown_json, updated_at) VALUES (?,?,?,?)
    ON CONFLICT(project_id) DO UPDATE SET setup_json = excluded.setup_json, teardown_json = excluded.teardown_json,
      updated_at = excluded.updated_at`)
    .run(projectId, JSON.stringify(parsed.setup), JSON.stringify(parsed.teardown), Date.now());
  return worktreeCommands(projectId);
}

/**
 * The same save with a person in the loop, and the only one IPC reaches.
 *
 * The question is on the save, not the run, for review.ts's reason: a command
 * is written once and run by every isolated session and headless run that
 * makes a worktree for the project, and re-asking on each would ask again about
 * text already approved — which is how a person learns to click a dialog away.
 * Asked in main, where a compromised renderer cannot decline to show it.
 *
 * Only lines the stored lists do not already hold, phase by phase, go in the
 * dialog. A stored row that cannot be read counts as empty here, so a damaged
 * row asks about every line rather than trapping the operator behind it.
 */
export async function saveWorktreeCommandsWithConsent(
  win: BrowserWindow | null,
  projectId: unknown,
  input: unknown,
): Promise<StoredWorktreeCommands> {
  const project = typeof projectId === 'string' ? projectById(projectId) : undefined;
  if (!project) throw new Error('Project not found.');
  const parsed = parseCommandInput(input);
  if ('problem' in parsed) throw new Error(parsed.problem);

  let stored: WorktreeCommandLists = { setup: [], teardown: [] };
  try { stored = worktreeCommands(project.id); } catch { /* ask about every line, per the comment above */ }
  const added = newCommands(stored, parsed);
  const count = added.setup.length + added.teardown.length;
  if (!count) return saveWorktreeCommands(project.id, parsed);

  if (!win || win.isDestroyed()) {
    throw new Error('Saving a new worktree command needs the Wanigan window open to confirm it.');
  }
  const one = count === 1;
  const block = (heading: string, list: string[]) =>
    list.length ? `${heading}:\n${list.map((c) => `    ${c}`).join('\n')}\n\n` : '';
  const answer = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Cancel', one ? 'Save this command' : `Save these ${count} commands`],
    defaultId: 0,
    cancelId: 0,
    title: one ? 'Save a new worktree command?' : 'Save new worktree commands?',
    message: one ? `Add a worktree command to ${project.name}?` : `Add ${count} worktree commands to ${project.name}?`,
    detail:
      `Wanigan runs these through your login shell. Setup runs in every new worktree Wanigan makes for ${project.name}, ` +
      'right after creating it and before the agent starts; teardown runs in a worktree just before Wanigan removes it.\n\n' +
      block('Setup, being added', added.setup) +
      block('Teardown, being added', added.teardown) +
      'This is stored, not run once: every isolated session and every headless run that makes a worktree for this ' +
      'project runs it, and none of them asks again. Save only what you would type there yourself.',
  });
  if (answer.response !== 1) {
    throw new Error('Cancelled. The worktree commands were not saved, so nothing new will run in a worktree.');
  }
  return saveWorktreeCommands(project.id, parsed);
}

/* ── running ─────────────────────────────────────────────────────────── */

/** Per command. Half a review gate's allowance: this output is re-read beside every worktree. */
const OUTPUT_LIMIT = 64 * 1024;
/** Time a command gets to exit on SIGTERM before its process group is killed outright. */
const KILL_GRACE_MS = 5_000;
/**
 * How long output is still read after the shell itself has exited. Output
 * written just before exit arrives within milliseconds; anything still holding
 * the pipe after this is a process the command left running.
 */
const LINGER_MS = 1_500;

type RunRow = {
  id: string; project_id: string; worktree: string; phase: string; started_at: number; ended_at: number | null;
  status: string; planned: number; results_json: string; env_json: string | null; note: string | null;
};

function toRun(row: RunRow): WorktreeCommandRun {
  let results: WorktreeCommandResult[] = [];
  try {
    const parsed = JSON.parse(row.results_json) as unknown;
    if (Array.isArray(parsed)) results = parsed as WorktreeCommandResult[];
  } catch { /* the row stands with no fabricated results */ }
  let env: WorktreeCommandEnv | null = null;
  try { env = row.env_json ? JSON.parse(row.env_json) as WorktreeCommandEnv : null; } catch { env = null; }
  return {
    id: row.id, projectId: row.project_id, worktree: row.worktree, phase: row.phase === 'teardown' ? 'teardown' : 'setup',
    startedAt: row.started_at, endedAt: row.ended_at,
    status: row.status === 'passed' || row.status === 'running' ? row.status : 'failed',
    planned: row.planned, results, env, note: row.note,
  };
}

function limitText(ms: number): string {
  return ms % 60_000 === 0 ? `${ms / 60_000}-minute` : durationText(ms);
}

/**
 * One command, in its own process group, bounded in time and output.
 *
 * The process group is review.ts's lesson: the child is a shell, and
 * signalling the shell alone leaves the `npm ci` underneath it running after
 * Wanigan has given up on it. The environment is Wanigan's own plus the four
 * variables, as a review gate's is: the command is text the operator approved
 * to run as them, through their own login shell, which reads the same profile.
 *
 * The result is decided when the shell exits, not when its output closes.
 * review.ts waits for `close`, which is right for a gate and wrong here: a
 * setup line that starts a dev server in the background (`npm run dev &`)
 * hands that server the output pipe, `close` then waits for the server, and the
 * launch would sit for the whole ten minutes before the server was killed and
 * the record said a command that had exited 0 never finished. So after `exit`
 * the output gets LINGER_MS to drain, the run moves on, and whatever the
 * command started keeps running — its later output is read and dropped, so a
 * full pipe never blocks it.
 */
function runOne(command: string, cwd: string, env: WorktreeCommandEnv, timeoutMs: number, stopNote: string): Promise<WorktreeCommandResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const { file: shell, args: shellArgs } = shellCommand(command, hostPlatform(), process.env);
    let out = '';
    let truncated = false;
    let timedOut = false;
    let settled = false;
    let killer: NodeJS.Timeout | null = null;
    let linger: NodeJS.Timeout | null = null;
    const child = spawn(shell, shellArgs, {
      cwd,
      env: { ...process.env, NO_COLOR: '1', TERM: 'dumb', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      // On Windows detaching gives the child its own console window, which
      // would flash over whatever the operator is doing on every command.
      windowsHide: true,
    });
    // Recorded output that stops mid-sentence has to say so: a capped record
    // that reads as the whole run is a false record.
    const add = (b: Buffer) => {
      if (settled) return;
      const room = OUTPUT_LIMIT - out.length;
      if (room <= 0) { truncated = true; return; }
      const text = b.toString();
      if (text.length > room) { out += text.slice(0, room); truncated = true; } else out += text;
    };
    child.stdout?.on('data', add);
    child.stderr?.on('data', add);
    const stop = (signal: NodeJS.Signals) => { killProcessTree(child, signal); };
    const timer = setTimeout(() => {
      timedOut = true;
      stop('SIGTERM');
      // A command that ignores SIGTERM would otherwise never close, leaving
      // its run row 'running' and a launch waiting on it for good.
      killer = setTimeout(() => stop('SIGKILL'), KILL_GRACE_MS);
    }, Math.max(1, timeoutMs));
    const done = (result: WorktreeCommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killer) clearTimeout(killer);
      if (linger) clearTimeout(linger);
      resolve(result);
    };
    const conclude = (code: number | null, lingered: boolean) => {
      const notes = [
        truncated ? `[Wanigan kept the first ${Math.round(OUTPUT_LIMIT / 1024)}KB of this command's output; the rest was discarded, not produced empty.]` : null,
        timedOut ? stopNote : null,
        lingered && !timedOut
          ? '[The command exited, but something it started still holds its output open. Wanigan recorded what arrived by then, moved on, and left that process running.]'
          : null,
      ].filter(Boolean);
      done({
        command,
        exitCode: timedOut ? null : code,
        output: notes.length ? `${out}\n${notes.join('\n')}` : out,
        durationMs: Date.now() - started,
      });
    };
    child.once('exit', (code) => {
      linger = setTimeout(() => conclude(code, true), LINGER_MS);
    });
    child.once('close', (code) => conclude(code, false));
    child.once('error', (e) => done({ command, exitCode: null, output: e.message, durationMs: Date.now() - started }));
  });
}

/**
 * Runs one phase's stored commands in a worktree and records the run.
 *
 * Returns null when the project has no commands for the phase, and writes no
 * row: "no setup ran" and "a setup ran and did nothing" are different facts.
 * Commands run in order and stop at the first that does not exit 0. The
 * allowance is for the whole phase, not per command — setup stands between a
 * launch and its agent, and twenty commands at ten minutes each would be a
 * launch that waits three hours. The row is written before the first command
 * starts and after each one finishes, so a crash part-way leaves the finished
 * commands as evidence; sweepInterruptedWorktreeRuns closes it out afterwards.
 *
 * `budgetMs` exists for the smoke suite, which cannot wait ten minutes to see
 * the limit enforced.
 */
export async function runWorktreePhase(
  phase: WorktreePhase,
  ctx: { projectId: string; worktree: string; env: WorktreeCommandEnv },
  opts: { budgetMs?: number } = {},
): Promise<WorktreeCommandRun | null> {
  sweepInterruptedWorktreeRuns();
  let commands: string[] = [];
  let note: string | null = null;
  try { commands = worktreeCommands(ctx.projectId)[phase]; } catch (e) { note = message(e); }
  if (!note && !commands.length) return null;
  if (!note && !fs.existsSync(ctx.worktree)) note = 'The worktree directory is gone, so there was nowhere to run the commands.';

  const budget = opts.budgetMs ?? WORKTREE_PHASE_BUDGET_MS;
  const id = `wtr_${randomUUID().slice(0, 12)}`;
  const startedAt = Date.now();
  const d = db();
  d.prepare(`INSERT INTO worktree_command_runs (id, project_id, worktree, phase, started_at, status, planned, results_json, env_json)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(id, ctx.projectId, ctx.worktree, phase, startedAt, 'running', commands.length, '[]', JSON.stringify(ctx.env));
  const finish = (status: WorktreeCommandRun['status'], results: WorktreeCommandResult[], why: string | null): WorktreeCommandRun => {
    const endedAt = Date.now();
    d.prepare('UPDATE worktree_command_runs SET ended_at = ?, status = ?, results_json = ?, note = ? WHERE id = ?')
      .run(endedAt, status, JSON.stringify(results), why, id);
    return { id, projectId: ctx.projectId, worktree: ctx.worktree, phase, startedAt, endedAt, status, planned: commands.length, results, env: ctx.env, note: why };
  };
  if (note) return finish('failed', [], note);

  const results: WorktreeCommandResult[] = [];
  const record = d.prepare('UPDATE worktree_command_runs SET results_json = ? WHERE id = ?');
  const stopNote = `[Wanigan stopped this command when the ${phase}'s ${limitText(budget)} limit ran out.]`;
  let why: string | null = null;
  for (const command of commands) {
    const remaining = budget - (Date.now() - startedAt);
    if (remaining <= 0) {
      why = `The ${phase}'s ${limitText(budget)} limit ran out before the next command could start.`;
      break;
    }
    const result = await runOne(command, ctx.worktree, ctx.env, remaining, stopNote);
    results.push(result);
    record.run(JSON.stringify(results), id);
    if (result.exitCode !== 0) break;
  }
  const passed = !why && results.length === commands.length && results.every((r) => r.exitCode === 0);
  return finish(passed ? 'passed' : 'failed', results, why);
}

export function worktreeCommandRuns(projectId: unknown, limit?: unknown): WorktreeCommandRun[] {
  if (typeof projectId !== 'string' || !projectById(projectId)) throw new Error('Project not found.');
  // Before the read, so the panel never shows a run as in flight when the
  // process that was running it is gone.
  sweepInterruptedWorktreeRuns();
  const n = typeof limit === 'number' && Number.isFinite(limit) ? Math.max(1, Math.min(50, Math.floor(limit))) : 12;
  return (db().prepare('SELECT * FROM worktree_command_runs WHERE project_id = ? ORDER BY started_at DESC LIMIT ?')
    .all(projectId, n) as RunRow[]).map(toRun);
}

/** The newest run of one phase in one worktree, or null when none ran. */
export function latestWorktreeRun(worktree: string, phase: WorktreePhase): WorktreeCommandRun | null {
  sweepInterruptedWorktreeRuns();
  const row = db().prepare('SELECT * FROM worktree_command_runs WHERE worktree = ? AND phase = ? ORDER BY started_at DESC LIMIT 1')
    .get(worktree, phase) as RunRow | undefined;
  return row ? toRun(row) : null;
}

const PROCESS_START = Date.now();
let swept = false;

/**
 * Runs left 'running' by a process that died part-way through, closed as
 * failed with a note saying so. Not re-run: nobody watched the crash, and
 * silently re-executing a project's setup is not a recovery anyone asked for.
 *
 * ended_at stays empty. review.ts stamps the sweep's own time there, which a
 * duration then reads as a setup that ran for as long as Wanigan was closed;
 * nobody knows when this one stopped, and the row says only what is known.
 * started_at rather than a process-local set, so a row this process began a
 * moment ago is never mistaken for an orphan.
 */
export function sweepInterruptedWorktreeRuns(): number {
  if (swept) return 0;
  swept = true;
  return db().prepare(`UPDATE worktree_command_runs SET status = 'failed', note = ?
    WHERE status = 'running' AND started_at < ?`)
    .run('Wanigan stopped while this was running. Commands that finished are recorded; one still in flight left no result, and nothing after it ran.', PROCESS_START)
    .changes;
}
