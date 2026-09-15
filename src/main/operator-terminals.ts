import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { IPty } from 'node-pty';
import type { BrowserWindow } from 'electron';
import { db } from './db';
import { projectById } from './store';
import { repoRootFor } from './worktrees';
import {
  SCRIPT_FILES, commandFor, isScriptSource, justRecipes, makeTargets, orderScripts, packageManagerFor, packageScripts,
  type FavouriteKey, type OperatorTerminal, type ProjectScript, type ScriptListing, type ScriptSource, type ScriptTarget,
} from '../shared/project-scripts';
import { splitTerminalInput } from '../shared/terminal-input';

/**
 * The script launcher and the operator's own terminal.
 *
 * A project's package.json scripts, Makefile targets and justfile recipes, one
 * click from running — in a plain shell PTY that belongs to the operator, not
 * to an agent. That distinction is the whole design:
 *
 *  - The terminal is spawned here, apart from the session manager. It has no
 *    hook settings, no MCP config, no trust level and no attention verdict, and
 *    nothing it runs passes through the policy gate, because the policy gate
 *    decides what an *agent* may do and this is a person at their own keyboard.
 *    Recording it as though an agent had asked would put the operator's own
 *    `make deploy` into the agent ledger as a tool call nobody made.
 *  - What it runs is recorded as operator-run, in its own table, with the
 *    project, the directory, the script and the exact command line, and the
 *    exit code when the shell reports one.
 *  - The command line is rebuilt here from the file on disk every time. The
 *    renderer names a project, a source and a script name; it never sends the
 *    text that reaches the shell.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const pty = require('node-pty') as typeof import('node-pty');

const MAX_TERMINALS = 6;
const SCROLLBACK_BYTES = 256 * 1024;
const MAX_INPUT_BYTES = 256 * 1024;

type Live = {
  meta: OperatorTerminal;
  proc: IPty;
  buffer: string;
  runId: string | null;
};

const terminals = new Map<string, Live>();
let windowFor: () => BrowserWindow | null = () => null;

export function setOperatorTerminalWindow(fn: () => BrowserWindow | null): void {
  windowFor = fn;
}

function send(channel: string, payload: unknown): void {
  const w = windowFor();
  if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
}

/* ── where scripts run ───────────────────────────────────────────────── */

/**
 * The project checkout, and every live Wanigan worktree cut from its
 * repository. Read from Wanigan's own records, so a renderer can only choose
 * among directories this process already manages.
 */
export async function scriptTargets(projectId: unknown): Promise<ScriptTarget[]> {
  const project = typeof projectId === 'string' ? projectById(projectId) : undefined;
  if (!project) throw new Error('Choose a project first.');
  const out: ScriptTarget[] = [{ kind: 'project', path: project.path, label: project.name, branch: project.branch }];
  const root = await repoRootFor(project.path).catch(() => null);
  if (!root) return out;
  const rows = db().prepare('SELECT path, branch, session_id FROM worktrees WHERE repo_root = ? AND removed_at IS NULL ORDER BY created_at DESC LIMIT 40')
    .all(root) as { path: string; branch: string | null; session_id: string | null }[];
  for (const row of rows) {
    if (!fs.existsSync(row.path)) continue;
    // A worktree of a monorepo subdirectory project runs from the same
    // subdirectory inside the worktree, the way the agent's session does.
    const sub = path.relative(root, project.path);
    const dir = sub && !sub.startsWith('..') ? path.join(row.path, sub) : row.path;
    out.push({ kind: 'worktree', path: dir, label: row.branch ?? path.basename(row.path), branch: row.branch });
  }
  return out;
}

async function resolveTarget(projectId: unknown, targetPath: unknown): Promise<{ projectId: string; target: ScriptTarget }> {
  const targets = await scriptTargets(projectId);
  const wanted = typeof targetPath === 'string' && targetPath ? targetPath : targets[0].path;
  // A session names its worktree root; for a project that is a subdirectory
  // of its repository the target is that subdirectory inside the worktree.
  const target = targets.find((t) => t.path === wanted)
    ?? targets.find((t) => t.kind === 'worktree' && t.path.startsWith(wanted + path.sep));
  if (!target) throw new Error('That directory is not this project or one of its Wanigan worktrees.');
  return { projectId: projectId as string, target };
}

/* ── reading scripts ─────────────────────────────────────────────────── */

function readFirst(dir: string, names: readonly string[]): { file: string; text: string } | null {
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const st = fs.statSync(file);
      if (!st.isFile() || st.size > 512 * 1024) continue;
      return { file: name, text: fs.readFileSync(file, 'utf8') };
    } catch { /* not this one */ }
  }
  return null;
}

function favouritesOf(projectId: string): FavouriteKey[] {
  return (db().prepare('SELECT source, name FROM script_favourites WHERE project_id = ? ORDER BY added_at, name').all(projectId) as { source: string; name: string }[])
    .filter((r): r is FavouriteKey => isScriptSource(r.source));
}

function readScripts(dir: string): { scripts: ProjectScript[]; notes: string[]; manager: ReturnType<typeof packageManagerFor> } {
  const notes: string[] = [];
  const scripts: ProjectScript[] = [];
  let entries: string[] = [];
  try { entries = fs.readdirSync(dir); } catch { notes.push(`${dir} could not be read.`); }
  const manager = packageManagerFor(entries);
  const pkg = readFirst(dir, SCRIPT_FILES['package.json']);
  if (pkg) {
    const r = packageScripts(pkg.text);
    scripts.push(...r.scripts);
    if (r.problem) notes.push(r.problem);
  }
  const make = readFirst(dir, SCRIPT_FILES.Makefile);
  if (make) scripts.push(...makeTargets(make.text));
  const just = readFirst(dir, SCRIPT_FILES.justfile);
  if (just) scripts.push(...justRecipes(just.text));
  return { scripts, notes, manager };
}

export async function listScripts(projectId: unknown, targetPath?: unknown): Promise<ScriptListing> {
  const { target } = await resolveTarget(projectId, targetPath);
  const { scripts, notes, manager } = readScripts(target.path);
  const ordered = orderScripts(scripts, favouritesOf(projectId as string));
  return {
    target,
    targets: await scriptTargets(projectId),
    packageManager: manager,
    scripts: ordered.map((s) => ({ ...s, command: commandFor(s, manager) })),
    notes,
  };
}

export function setScriptFavourite(projectId: unknown, source: unknown, name: unknown, on: unknown): FavouriteKey[] {
  if (typeof projectId !== 'string' || !projectById(projectId)) throw new Error('Choose a project first.');
  if (!isScriptSource(source)) throw new Error('A script comes from package.json, a Makefile or a justfile.');
  if (typeof name !== 'string' || !name || name.length > 200) throw new Error('Name the script to star.');
  if (typeof on !== 'boolean') throw new Error('A favourite is either on or off.');
  if (on) {
    db().prepare('INSERT OR IGNORE INTO script_favourites (project_id, source, name, added_at) VALUES (?,?,?,?)').run(projectId, source, name, Date.now());
  } else {
    db().prepare('DELETE FROM script_favourites WHERE project_id = ? AND source = ? AND name = ?').run(projectId, source, name);
  }
  return favouritesOf(projectId);
}

/* ── the terminal ────────────────────────────────────────────────────── */

/** The operator's own environment, less the variables that would make a child act as part of Wanigan. */
function operatorEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v !== 'string') continue;
    if (k.startsWith('ELECTRON_') || k.startsWith('WANIGAN_') || k === 'NODE_OPTIONS') continue;
    env[k] = v;
  }
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  return env;
}

function spawnTerminal(projectId: string, target: ScriptTarget, label: string, run: { source: ScriptSource; name: string; command: string } | null): OperatorTerminal {
  if (terminals.size >= MAX_TERMINALS) throw new Error(`${MAX_TERMINALS} of your terminals are already open. Close one first.`);
  const shell = process.env.SHELL && path.isAbsolute(process.env.SHELL) ? process.env.SHELL : '/bin/zsh';
  const id = `opt_${randomUUID().slice(0, 12)}`;
  const proc = pty.spawn(shell, ['-l'], { name: 'xterm-256color', cols: 120, rows: 24, cwd: target.path, env: operatorEnv() });
  const meta: OperatorTerminal = {
    id, projectId, cwd: target.path, targetLabel: target.label, label, pid: proc.pid,
    command: run?.command ?? null, startedAt: Date.now(), exitCode: null, endedAt: null,
  };
  let runId: string | null = null;
  if (run) {
    runId = randomUUID();
    db().prepare('INSERT INTO operator_runs (id, at, project_id, cwd, source, name, command) VALUES (?,?,?,?,?,?,?)')
      .run(runId, meta.startedAt, projectId, target.path, run.source, run.name, run.command);
  }
  const live: Live = { meta, proc, buffer: '', runId };
  terminals.set(id, live);
  proc.onData((data) => {
    live.buffer = (live.buffer + data).slice(-SCROLLBACK_BYTES);
    send('opterm:data', { id, data });
  });
  proc.onExit(({ exitCode }) => {
    live.meta.exitCode = exitCode;
    live.meta.endedAt = Date.now();
    if (live.runId) {
      try { db().prepare('UPDATE operator_runs SET exit_code = ?, ended_at = ? WHERE id = ?').run(exitCode, live.meta.endedAt, live.runId); } catch { /* quitting */ }
    }
    send('opterm:exit', { id, exitCode });
    send('opterm:list', listOperatorTerminals());
  });
  if (run) {
    // Typed into the shell rather than passed as `-c`, so the terminal stays
    // open afterwards with the output on screen and a prompt to run it again.
    proc.write(`${run.command}\r`);
  }
  send('opterm:list', listOperatorTerminals());
  return { ...meta };
}

export async function runScript(projectId: unknown, source: unknown, name: unknown, targetPath?: unknown): Promise<OperatorTerminal> {
  if (!isScriptSource(source)) throw new Error('A script comes from package.json, a Makefile or a justfile.');
  if (typeof name !== 'string' || !name) throw new Error('Choose a script to run.');
  const { target } = await resolveTarget(projectId, targetPath);
  const { scripts, manager } = readScripts(target.path);
  const script = scripts.find((s) => s.source === source && s.name === name);
  if (!script) throw new Error(`${source} in ${target.label} no longer declares “${name}”.`);
  const command = commandFor(script, manager);
  if (!command) throw new Error(`“${name}” is not a plain name Wanigan can pass to a shell safely. Run it in a terminal yourself.`);
  return spawnTerminal(projectId as string, target, name, { source, name, command });
}

export async function openOperatorTerminal(projectId: unknown, targetPath?: unknown): Promise<OperatorTerminal> {
  const { target } = await resolveTarget(projectId, targetPath);
  return spawnTerminal(projectId as string, target, 'shell', null);
}

export function listOperatorTerminals(): OperatorTerminal[] {
  return [...terminals.values()].map((t) => ({ ...t.meta })).sort((a, b) => a.startedAt - b.startedAt);
}

export function writeOperatorTerminal(id: unknown, data: unknown): boolean {
  if (typeof id !== 'string' || typeof data !== 'string' || Buffer.byteLength(data) > MAX_INPUT_BYTES) return false;
  const t = terminals.get(id);
  if (!t || t.meta.endedAt) return false;
  for (const chunk of splitTerminalInput(data)) t.proc.write(chunk);
  return true;
}

export function resizeOperatorTerminal(id: unknown, cols: unknown, rows: unknown): boolean {
  if (typeof id !== 'string' || !Number.isInteger(cols) || !Number.isInteger(rows)) return false;
  const c = cols as number; const r = rows as number;
  if (c < 1 || c > 1000 || r < 1 || r > 500) return false;
  const t = terminals.get(id);
  if (!t || t.meta.endedAt) return false;
  try { t.proc.resize(c, r); } catch { return false; }
  return true;
}

export function operatorTerminalScrollback(id: unknown): string {
  return typeof id === 'string' ? terminals.get(id)?.buffer ?? '' : '';
}

/** Ends the shell if it is still running, and forgets the tab. */
export function closeOperatorTerminal(id: unknown): OperatorTerminal[] {
  if (typeof id !== 'string') return listOperatorTerminals();
  const t = terminals.get(id);
  if (t) {
    if (!t.meta.endedAt) { try { t.proc.kill(); } catch { /* already gone */ } }
    terminals.delete(id);
  }
  const list = listOperatorTerminals();
  send('opterm:list', list);
  return list;
}

export function closeAllOperatorTerminals(): number {
  let n = 0;
  for (const t of terminals.values()) {
    if (!t.meta.endedAt) { try { t.proc.kill(); n++; } catch { /* already gone */ } }
  }
  terminals.clear();
  return n;
}

export function recentOperatorRuns(projectId: unknown, limit = 20): { at: number; cwd: string; source: string; name: string; command: string; exitCode: number | null }[] {
  if (typeof projectId !== 'string') return [];
  return (db().prepare('SELECT at, cwd, source, name, command, exit_code FROM operator_runs WHERE project_id = ? ORDER BY at DESC LIMIT ?')
    .all(projectId, Math.max(1, Math.min(100, limit))) as { at: number; cwd: string; source: string; name: string; command: string; exit_code: number | null }[])
    .map((r) => ({ at: r.at, cwd: r.cwd, source: r.source, name: r.name, command: r.command, exitCode: r.exit_code }));
}
