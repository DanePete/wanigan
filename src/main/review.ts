import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { db } from './db';
import { projectById } from './store';
import type { ReviewRecipe, ReviewRun } from '../shared/types';

const OUTPUT_LIMIT = 128 * 1024;
const COMMAND_TIMEOUT_MS = 10 * 60_000;

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

export function history(projectId: string, limit = 12): ReviewRun[] {
  return (db().prepare('SELECT * FROM review_runs WHERE project_id=? ORDER BY started_at DESC LIMIT ?').all(projectId, Math.max(1, Math.min(50, limit))) as Parameters<typeof map>[0][]).map(map);
}

async function runCommand(command: string, cwd: string): Promise<ReviewRun['results'][number]> {
  const started = Date.now();
  return new Promise((resolve) => {
    const shell = process.env.SHELL || '/bin/zsh';
    let out = ''; let timedOut = false;
    const child = spawn(shell, ['-lc', command], { cwd, env: { ...process.env, NO_COLOR: '1', TERM: 'dumb' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const add = (b: Buffer) => { if (out.length < OUTPUT_LIMIT) out += b.toString(); };
    child.stdout?.on('data', add); child.stderr?.on('data', add);
    const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGTERM'); } catch { /* already exited */ } }, COMMAND_TIMEOUT_MS);
    child.once('close', (code) => { clearTimeout(timer); resolve({ command, exitCode: timedOut ? null : code, output: timedOut ? `${out}\n[Wanigan stopped this command after 10 minutes.]` : out, durationMs: Date.now() - started }); });
    child.once('error', (e) => { clearTimeout(timer); resolve({ command, exitCode: null, output: e.message, durationMs: Date.now() - started }); });
  });
}

export async function run(projectId: string): Promise<ReviewRun> {
  const project = projectById(projectId);
  if (!project) throw new Error('Project not found.');
  const commands = recipe(projectId).commands;
  if (!commands.length) throw new Error('Add at least one review command before running a gate.');
  const id = `rev_${randomUUID().slice(0, 12)}`; const startedAt = Date.now();
  db().prepare('INSERT INTO review_runs (id, project_id, started_at, status, results_json) VALUES (?,?,?,?,?)').run(id, projectId, startedAt, 'running', '[]');
  const results: ReviewRun['results'] = [];
  for (const command of commands) {
    const result = await runCommand(command, project.path); results.push(result);
    if (result.exitCode !== 0) break;
  }
  const status: ReviewRun['status'] = results.length === commands.length && results.every((r) => r.exitCode === 0) ? 'passed' : 'failed';
  const endedAt = Date.now();
  db().prepare('UPDATE review_runs SET ended_at=?, status=?, results_json=? WHERE id=?').run(endedAt, status, JSON.stringify(results), id);
  return { id, projectId, startedAt, endedAt, status, results };
}
