import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { db } from './db';
import { getSetting, setSetting } from './settings';
import { listSessions } from './sessions';
import type { ObservedSession, ObservedState } from '../shared/types';

const exec = promisify(execFile);

/**
 * Claude sessions this app did not start, seen from outside.
 *
 * VS Code 1.135 ships an agent host that is on by default, so the ordinary
 * state of this machine is nine Claude processes running and Wanigan aware of
 * none of them: a session_log row is written in exactly one place, createSession,
 * and everything downstream counts rows. So "how many agents are running" — the
 * one number the whole app is built around, because the operator is the
 * constraint — has been wrong by however many were launched somewhere else, and
 * wrong silently, which is the worse half.
 *
 * The registry that fixes it is already on disk and needs nothing installed:
 * every running Claude process writes ~/.claude/sessions/<pid>.json holding its
 * session id, its cwd, its version and how it was launched. Reading it costs the
 * observed session nothing and tells it nothing.
 *
 * ── read-only, and that is the design rather than a stage we have not reached ──
 *
 * Nothing here writes, and specifically:
 *
 * - Not ~/.claude/settings.json. The only route to *acting* on a session
 *   Wanigan did not launch is a hook installed there, and that file is
 *   machine-wide: it applies to every project, every session, and every tool
 *   Wanigan has never heard of. The callback also needs a bearer token sitting
 *   on disk with that same blast radius, rotating, readable by anything running
 *   as this user. That needs a threat model, not an afternoon.
 * - Not the messaging socket at /tmp/cc-socks/<pid>.sock. It is a door into a
 *   process we never launched; opening it is a write by any honest reading of
 *   the word, so its path is not even carried into a row — the only thing a
 *   renderer could do with it is use it.
 *
 * And these rows stay out of three places on purpose:
 *
 * - The policy gate. Wanigan was not consulted when the session launched and
 *   cannot be now, so a gate over these would be a gate that only appears to
 *   be one — a false green with a lock icon on it.
 * - The attention queue. It classifies on hook events, and there are none for a
 *   foreign session, so every one of them falls to the idle branch and stays
 *   there forever. Nine permanent "idle" rows at the top of a queue is how a
 *   person learns to stop reading the queue.
 * - Spend and budgets. The CLI's cost-state line appears in none of the
 *   claude-vscode transcripts on this machine, so there is no cost to recover;
 *   pricing them locally would mean applying rates held at half of list and
 *   falling back to Sonnet for any model id not in the table. That is inventing
 *   a number and printing it beside real ones.
 *
 * Before any of this could be persisted rather than merely displayed,
 * session_log needs an `origin` column, so a foreign row is excluded from
 * history, spend and resume by the shape of the query rather than by every
 * future reader remembering to. Nothing here writes a row today.
 */

/** The sentence the UI has to carry. One source of truth so it cannot drift. */
export const OBSERVE_ONLY_NOTICE =
  'Observed only. These sessions were started outside Wanigan, so it can see that ' +
  'they are running and nothing else — no permission gate, no attention queue, no ' +
  'cost. Wanigan cannot stop one or answer one: that would need a hook written into ' +
  'your ~/.claude, and it does not write there.';

/**
 * Off by default. Wanigan reading a registry of sessions it was never told
 * about is a reasonable thing to want and an unreasonable thing to assume, so
 * it is asked for rather than switched on and mentioned afterwards.
 */
const KEY = 'observed_sessions';

export function observedEnabled(): boolean {
  return getSetting(KEY, '0') === '1';
}

/**
 * The one write in this module, and it is Wanigan's own settings row rather
 * than anything under ~/.claude.
 */
export function setObservedEnabled(on: boolean): boolean {
  setSetting(KEY, on ? '1' : '0');
  return on;
}

/**
 * CLAUDE_CONFIG_DIR is honoured for the same reason transcripts.ts honours it:
 * a user who has moved their config has no ~/.claude at all, and an observer
 * that looked there would report "nothing running" on a machine with nine.
 */
function claudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), '.claude');
}

function registryDir(): string {
  return path.join(claudeHome(), 'sessions');
}

/* ── reading the registry ────────────────────────────────────────────── */

/**
 * A registry entry is a few hundred bytes. The cap is not paranoia about a
 * hostile file, it is that this runs on a timer in the main process, and the
 * observer must never be the reason the window stops painting.
 */
function readJson(p: string): Record<string, unknown> | null {
  try {
    const st = fs.statSync(p);
    if (!st.isFile() || st.size > 64 * 1024) return null;
    const v = JSON.parse(fs.readFileSync(p, 'utf8')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    // A file being rewritten as we read it parses as garbage exactly once, and
    // the next refresh gets it. Skipping beats logging a wall of noise.
    return null;
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function canon(p: string): string {
  const abs = path.resolve(p);
  try { return fs.realpathSync(abs); } catch { return abs; }
}

/** True when `child` is `parent` or sits underneath it. Never a bare prefix test:
 *  /Users/dane/work must not match /Users/dane/workshop. */
function within(parent: string, child: string): boolean {
  if (parent === child) return true;
  return child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

/* ── liveness ────────────────────────────────────────────────────────── */

/** ps reports whole seconds and a session writes its registry file a moment
 *  after the process starts — four seconds apart on this machine — so the two
 *  never agree exactly. A pid the kernel has recycled is out by hours. */
const START_SLACK_MS = 60_000;

/**
 * When each of these processes actually started, so a pid can be checked
 * against the session that claims it.
 *
 * A pid is not an identity. A registry file left behind by a SIGKILL keeps its
 * pid, and the kernel hands that number to something else eventually — at which
 * point kill(pid, 0) succeeds and the list shows a Claude session that ended
 * days ago, sitting beside eight that are real. The file records when its
 * process started, so the two can be compared and the recycled one dropped.
 *
 * `procStart` in the file is the obvious field to compare and the wrong one: it
 * is formatted in UTC while ps prints local time, so the two strings disagree by
 * the machine's offset — five hours here — on every machine that is not on UTC.
 * `startedAt` is epoch milliseconds and is what gets compared.
 */
async function processStarts(pids: number[]): Promise<Map<number, number> | null> {
  if (!pids.length) return new Map();
  try {
    const { stdout } = await exec('ps', ['-o', 'pid=,lstart=', '-p', pids.join(',')], { timeout: 5000 });
    const out = new Map<number, number>();
    for (const line of stdout.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(.+)$/);
      if (!m) continue;
      const at = Date.parse(m[2].replace(/\s+/g, ' ').trim());
      if (Number.isFinite(at)) out.set(Number(m[1]), at);
    }
    return out;
  } catch {
    // ps missing, or it refused the whole list because one pid had already
    // gone. Dropping every row over that would be worse than saying so: the
    // rows come back with verified false and the UI can be honest about it.
    return null;
  }
}

/** EPERM means the process exists and is not ours to signal, which is still alive. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as { code?: string }).code === 'EPERM';
  }
}

/* ── ours, or somebody else's ────────────────────────────────────────── */

/**
 * Wanigan's own sessions are in this registry too — it spawns the same binary —
 * and listing them here would show every session twice, once with a Stop button
 * and once with a note saying it cannot be stopped.
 *
 * Both halves are needed. The pid catches a session running right now. The
 * conversation id is what createSession passes as --session-id, which is the
 * same id the registry files under `sessionId`, and it catches one that outlived
 * a crash of the app that started it — the case where a duplicate row would be
 * most confusing, because the operator would swear they had started it here.
 */
function oursAlready(): { pids: Set<number>; ids: Set<string> } {
  const pids = new Set<number>();
  for (const s of listSessions()) if (s.pid) pids.add(s.pid);

  const ids = new Set<string>();
  try {
    const rows = db()
      .prepare('SELECT conversation_id FROM session_log WHERE conversation_id IS NOT NULL')
      .all() as { conversation_id: string }[];
    for (const r of rows) ids.add(r.conversation_id);
  } catch {
    // No database yet is a first-run state, not an error. Falling back to the
    // pid set alone over-reports at worst, and never hides a real session.
  }
  return { pids, ids };
}

/* ── which project this is ───────────────────────────────────────────── */

type Known = { id: string; name: string; path: string };

/**
 * The project list, read straight from the table.
 *
 * listProjects() is the obvious call and the wrong one here: it deletes rows
 * whose directory has gone. This module refreshes on a timer, and an observer
 * that quietly prunes the user's project list every few seconds is not an
 * observer. The same reasoning rules out worktreeStatus() below — a plain
 * SELECT says everything needed and touches nothing.
 */
function knownProjects(): Known[] {
  try {
    return (db().prepare('SELECT id, name, path FROM projects').all() as Known[])
      .map((p) => ({ ...p, path: canon(p.path) }));
  } catch { return []; }
}

/** repo root for a Wanigan worktree path, so a session running in one is still
 *  attributed to the project it came from rather than to a directory in userData. */
function worktreeRoots(): Map<string, string> {
  const out = new Map<string, string>();
  try {
    const rows = db()
      .prepare('SELECT path, repo_root FROM worktrees WHERE removed_at IS NULL')
      .all() as { path: string; repo_root: string }[];
    for (const r of rows) out.set(r.path, canon(r.repo_root));
  } catch { /* the table is created by migrate(); its absence is a first run */ }
  return out;
}

/** The deepest project containing this directory. Deepest, because a repo
 *  checked out inside another repo would otherwise answer with the outer one. */
function projectFor(cwd: string, projects: Known[], roots: Map<string, string>): Known | null {
  let dir = cwd;
  for (const [wt, root] of roots) {
    if (within(wt, cwd)) { dir = root; break; }
  }
  let best: Known | null = null;
  for (const p of projects) {
    if (!within(p.path, dir)) continue;
    if (!best || p.path.length > best.path.length) best = p;
  }
  return best;
}

/* ── which editor is holding it open ─────────────────────────────────── */

/**
 * The lock file is named for the websocket port, not for a pid, and the `pid`
 * inside it belongs to the editor: one VS Code serving five workspaces writes
 * five locks that all carry the same number, none of which is any session's pid.
 * Joining sessions to locks by pid therefore matches nothing at all. The
 * workspace folder list is the only field that actually relates the two.
 *
 * The lock also carries the auth token for that websocket. It is read into this
 * function and goes no further: a module that has decided not to open a channel
 * has no business handing its credential to a renderer.
 */
function editorFolders(): { folder: string; ide: string }[] {
  const dir = path.join(claudeHome(), 'ide');
  let names: string[];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.lock')); } catch { return []; }

  const out: { folder: string; ide: string }[] = [];
  for (const n of names) {
    const j = readJson(path.join(dir, n));
    if (!j) continue;
    const ide = str(j.ideName);
    const folders: unknown[] = Array.isArray(j.workspaceFolders) ? (j.workspaceFolders as unknown[]) : [];
    if (!ide) continue;
    for (const f of folders) {
      const s = str(f);
      if (s) out.push({ folder: canon(s), ide });
    }
  }
  return out;
}

function editorFor(cwd: string, folders: { folder: string; ide: string }[]): string | null {
  let best: { folder: string; ide: string } | null = null;
  for (const f of folders) {
    if (!within(f.folder, cwd)) continue;
    if (!best || f.folder.length > best.folder.length) best = f;
  }
  return best?.ide ?? null;
}

/* ── the lane ────────────────────────────────────────────────────────── */

type Candidate = {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number | null;
  name: string | null;
  entrypoint: string | null;
  kind: string | null;
  version: string | null;
};

function candidates(): Candidate[] {
  const dir = registryDir();
  let names: string[];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { return []; }

  const out: Candidate[] = [];
  for (const n of names) {
    const j = readJson(path.join(dir, n));
    if (!j) continue;

    // The filename is the pid, but the field inside is the one the process
    // wrote about itself; a renamed or copied file must not invent a session.
    const pid = num(j.pid);
    const fromName = Number(n.replace(/\.json$/, ''));
    if (!pid || !Number.isInteger(pid) || pid !== fromName) continue;

    const sessionId = str(j.sessionId);
    const cwd = str(j.cwd);
    if (!sessionId || !cwd) continue;

    // A pid from another kernel — a remote or container session — is not one
    // this process can test for liveness, and a row we cannot verify must not
    // be shown as running.
    const domain = str(j.pidDomain);
    if (domain && domain !== process.platform) continue;

    out.push({
      pid,
      sessionId,
      cwd: canon(cwd),
      startedAt: num(j.startedAt),
      name: str(j.name),
      entrypoint: str(j.entrypoint),
      kind: str(j.kind),
      version: str(j.version),
    });
  }
  return out;
}

/**
 * Every live Claude session on this machine that Wanigan did not start.
 *
 * Empty when the lane is switched off, which is also its default: this reads a
 * directory describing work the operator may not have meant to show anybody,
 * and that is an opt-in, not a discovery.
 */
export async function listObserved(): Promise<ObservedSession[]> {
  if (!observedEnabled()) return [];

  const found = candidates();
  if (!found.length) return [];

  const { pids, ids } = oursAlready();
  const foreign = found.filter((c) => !pids.has(c.pid) && !ids.has(c.sessionId));
  const alive = foreign.filter((c) => pidAlive(c.pid));
  if (!alive.length) return [];

  const starts = await processStarts(alive.map((c) => c.pid));
  const projects = knownProjects();
  const roots = worktreeRoots();
  const folders = editorFolders();
  const observedAt = Date.now();

  const out: ObservedSession[] = [];
  for (const c of alive) {
    let verified = false;
    if (starts) {
      const began = starts.get(c.pid);
      // Absent from ps output means it exited between the two reads.
      if (began === undefined) continue;
      if (c.startedAt !== null && Math.abs(began - c.startedAt) > START_SLACK_MS) continue;
      verified = c.startedAt !== null;
    }

    const project = projectFor(c.cwd, projects, roots);
    out.push({
      sessionId: c.sessionId,
      pid: c.pid,
      cwd: c.cwd,
      projectId: project?.id ?? null,
      projectName: project?.name ?? path.basename(c.cwd),
      name: c.name,
      entrypoint: c.entrypoint,
      kind: c.kind,
      version: c.version,
      editor: editorFor(c.cwd, folders),
      startedAt: c.startedAt,
      verified,
      observedAt,
    });
  }

  out.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  return out;
}

/**
 * What the surface needs to explain itself before it has a list: whether the
 * lane is on, whether there is anything on this machine to observe at all, and
 * the exact sentence to print beside the rows. "Off" and "none running" are
 * different answers and a UI that cannot tell them apart will say the wrong one.
 */
export function observedState(): ObservedState {
  const registry = registryDir();
  const available = fs.existsSync(registry);
  const enabled = observedEnabled();
  return {
    enabled,
    available,
    registry,
    notice: OBSERVE_ONLY_NOTICE,
    note: !enabled
      ? `Wanigan is not looking. Turn this on and it reads ${registry} — one file per running ` +
        'Claude process — to list the sessions started outside it. It reads, and does nothing else.'
      : !available
        ? `Nothing to read at ${registry}. That directory appears the first time a Claude session ` +
          'runs on this machine, so an older CLI, or none installed, looks exactly like this.'
        : null,
  };
}
