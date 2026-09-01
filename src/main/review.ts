import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { db } from './db';
import { projectById } from './store';
import type { ReviewRecipe, ReviewRun } from '../shared/types';

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

export function saveRecipe(projectId: string, commands: string[]): ReviewRecipe {
  if (!projectById(projectId)) throw new Error('Project not found.');
  const safe = asCommands(commands);
  if (safe.some((c) => c.length > 2_000)) throw new Error('A review command is too long (maximum 2,000 characters).');
  db().prepare(`INSERT INTO review_recipes (project_id, commands_json, updated_at) VALUES (?,?,?)
    ON CONFLICT(project_id) DO UPDATE SET commands_json=excluded.commands_json, updated_at=excluded.updated_at`)
    .run(projectId, JSON.stringify(safe), Date.now());
  return recipe(projectId);
}

function map(row: { id: string; project_id: string; started_at: number; ended_at: number | null; status: string; results_json: string }): ReviewRun {
  let results: ReviewRun['results'] = [];
  try { results = JSON.parse(row.results_json) as ReviewRun['results']; } catch { /* preserve row with no fabricated evidence */ }
  return { id: row.id, projectId: row.project_id, startedAt: row.started_at, endedAt: row.ended_at, status: row.status as ReviewRun['status'], results };
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

export function history(projectId: string, limit = 12): ReviewRun[] {
  // Before the read, so the panel never shows a gate as in flight when the
  // process that was running it is gone.
  sweepInterruptedRuns();
  return (db().prepare('SELECT * FROM review_runs WHERE project_id=? ORDER BY started_at DESC LIMIT ?').all(projectId, Math.max(1, Math.min(50, limit))) as Parameters<typeof map>[0][]).map(map);
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
 * this internal argument out of the IPC surface means a renderer can never
 * turn a saved review recipe into arbitrary-shell execution elsewhere.
 */
export async function runAt(projectId: string, cwd?: string): Promise<ReviewRun> {
  const project = projectById(projectId);
  if (!project) throw new Error('Project not found.');
  const root = cwd ?? project.path;
  const commands = recipe(projectId).commands;
  if (!commands.length) throw new Error('Add at least one review command before running a gate.');
  // Also here, not only in history(): a gate started right after a crash would
  // otherwise leave the earlier row reading 'running' until something asks for
  // the history.
  sweepInterruptedRuns();
  const id = `rev_${randomUUID().slice(0, 12)}`; const startedAt = Date.now();
  db().prepare('INSERT INTO review_runs (id, project_id, started_at, status, results_json) VALUES (?,?,?,?,?)').run(id, projectId, startedAt, 'running', '[]');
  const results: ReviewRun['results'] = [];
  const record = db().prepare('UPDATE review_runs SET results_json=? WHERE id=?');
  for (const command of commands) {
    const result = await runCommand(command, root); results.push(result);
    // Written as each command finishes: a gate can run for minutes, and a crash
    // three commands in should leave those three as evidence rather than an
    // empty array the sweep can say nothing about.
    record.run(JSON.stringify(results), id);
    if (result.exitCode !== 0) break;
  }
  const status: ReviewRun['status'] = results.length === commands.length && results.every((r) => r.exitCode === 0) ? 'passed' : 'failed';
  const endedAt = Date.now();
  db().prepare('UPDATE review_runs SET ended_at=?, status=?, results_json=? WHERE id=?').run(endedAt, status, JSON.stringify(results), id);
  return { id, projectId, startedAt, endedAt, status, results };
}

export async function run(projectId: string): Promise<ReviewRun> {
  return runAt(projectId);
}
