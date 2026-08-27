import type { IPty } from 'node-pty';
import { BrowserWindow } from 'electron';
import type { LaunchOptions, Session, ProviderId } from '../shared/types';
import { providerById, shellPath, detectProviders } from './providers';
import { projectById } from './store';
import { db } from './db';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import type { PastSession } from '../shared/types';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Baseline } from '../shared/types';

const exec = promisify(execFile);

/**
 * A snapshot of the repo at launch. Without it the code panel can only show
 * "changes in this repo", which is wrong the moment two sessions share one —
 * or when you had uncommitted work before the agent started.
 */
async function captureBaseline(cwd: string): Promise<Baseline> {
  const at = Date.now();
  try {
    const [{ stdout: head }, { stdout: st }] = await Promise.all([
      exec('git', ['-C', cwd, 'rev-parse', 'HEAD'], { timeout: 5000 }),
      exec('git', ['-C', cwd, 'status', '--porcelain=v1', '-z'], { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 }),
    ]);
    const dirty: string[] = [];
    const parts = st.split('\0').filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      const e = parts[i];
      const idx = e[0] ?? ' ';
      let f = e.slice(3);
      if (idx === 'R' || idx === 'C') { i++; f = parts[i] ?? f; }
      dirty.push(f);
    }
    return { head: head.trim(), dirty, at };
  } catch {
    return { head: null, dirty: [], at };
  }
}

// Required at runtime rather than imported, so the bundler leaves the native
// addon alone.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pty = require('node-pty') as typeof import('node-pty');

/** Bytes of scrollback kept per session so a pane can be re-attached with history. */
const SCROLLBACK_BYTES = 512 * 1024;

/**
 * Variables that must never reach a spawned agent.
 *
 * ELECTRON_RUN_AS_NODE is the sharp one: VS Code sets it for its extension
 * host, and any process launched from that environment inherits it. A child
 * Electron app then sees require('electron') return a path string instead of
 * the API and dies on startup. The VSCODE_* and CHROME_* families are the same
 * class of problem — editor plumbing that means nothing to an agent CLI.
 */
const STRIPPED_ENV = [
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_NO_ATTACH_CONSOLE',
  'ORIGINAL_XDG_CURRENT_DESKTOP',
  'GDK_PIXBUF_MODULE_FILE',
  'CHROME_DESKTOP',
  // Foreman is often launched from inside a Claude Code session. Inheriting
  // these makes every spawned agent believe it is a subprocess of that session,
  // which silently disables transcript saving — no history, no --resume.
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDECODE',
];
const STRIPPED_PREFIXES = ['VSCODE_', 'ELECTRON_IPC', 'npm_'];

function agentEnv(PATH: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (STRIPPED_ENV.includes(k)) continue;
    if (STRIPPED_PREFIXES.some((pre) => k.startsWith(pre))) continue;
    out[k] = v;
  }
  out.PATH = PATH;
  // Belt and braces: the marker above disables persistence, this re-asserts it.
  out.CLAUDE_CODE_FORCE_SESSION_PERSISTENCE = '1';
  out.TERM = 'xterm-256color';
  out.COLORTERM = 'truecolor';
  out.FORCE_COLOR = '1';
  return out;
}

type Live = {
  meta: Session;
  proc: IPty;
  buffer: string;
};

const sessions = new Map<string, Live>();
let broadcast: (channel: string, payload: unknown) => void = () => {};

export function initSessions(getWindow: () => BrowserWindow | null) {
  broadcast = (channel, payload) => {
    const w = getWindow();
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
  };
}

export function listSessions(): Session[] {
  return [...sessions.values()].map((s) => s.meta).sort((a, b) => a.createdAt - b.createdAt);
}

export async function createSession(opts: LaunchOptions): Promise<Session> {
  const def = providerById(opts.providerId);
  if (!def) throw new Error(`Unknown provider: ${opts.providerId}`);
  const project = projectById(opts.projectId);
  if (!project) throw new Error('Project not found — it may have been removed.');

  const PATH = await shellPath();
  // Launch the exact binary detection found, not whatever PATH resolves to now.
  const detected = (await detectProviders()).find((p) => p.id === opts.providerId);
  const resolvedBin = detected?.path ?? def.bin;
  const extra = (opts.extraArgs ?? '').trim().split(/\s+/).filter(Boolean);

  // Claude accepts a conversation id we choose, which is what makes a specific
  // session resumable later rather than just "the most recent one".
  const resuming = opts.resumeFrom;
  const conversationId = resuming
    ? resuming.conversationId
    : def.supports.resume && def.id === 'claude'
      ? randomUUID()
      : null;

  const idArgs = resuming
    ? def.resumeArgs(resuming.conversationId)
    : conversationId ? ['--session-id', conversationId] : [];

  const args = [...idArgs, ...def.args(extra, {
    model: opts.model || undefined,
    effort: def.supports.effort ? opts.effort || undefined : undefined,
    permissionMode: def.supports.permissionMode ? opts.permissionMode || undefined : undefined,
  })];
  const baseline = await captureBaseline(project.path);

  const id = `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const meta: Session = {
    id,
    providerId: opts.providerId,
    projectId: project.id,
    projectPath: project.path,
    projectName: project.name,
    title: `${def.label} · ${project.name}`,
    model: opts.model || undefined,
    effort: def.supports.effort ? (opts.effort || undefined) : undefined,
    permissionMode: def.supports.permissionMode ? (opts.permissionMode || undefined) : undefined,
    status: 'starting',
    pid: null,
    exitCode: null,
    createdAt: Date.now(),
    endedAt: null,
    unread: 0,
  };

  let proc: IPty;
  try {
    proc = pty.spawn(resolvedBin, args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 32,
      cwd: project.path,
      env: agentEnv(PATH),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Could not start "${def.bin}". Is it installed and on your PATH? (${msg})`
    );
  }

  meta.pid = proc.pid;
  meta.status = 'running';
  meta.baseline = baseline;
  meta.conversationId = conversationId;

  db().prepare(`
    INSERT INTO session_log (id, conversation_id, provider_id, project_id, project_path,
                             project_name, model, effort, permission_mode, started_at, resumed_from)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(id, conversationId, opts.providerId, project.id, project.path, project.name,
         meta.model ?? null, meta.effort ?? null, meta.permissionMode ?? null,
         meta.createdAt, resuming?.sessionId ?? null);
  const live: Live = { meta, proc, buffer: '' };
  sessions.set(id, live);

  proc.onData((data) => {
    live.buffer += data;
    if (live.buffer.length > SCROLLBACK_BYTES) {
      live.buffer = live.buffer.slice(-SCROLLBACK_BYTES);
    }
    broadcast('session:data', { sessionId: id, data });
  });

  proc.onExit(({ exitCode }) => {
    live.meta.status = 'exited';
    live.meta.exitCode = exitCode;
    live.meta.endedAt = Date.now();
    try {
      db().prepare('UPDATE session_log SET ended_at = ?, exit_code = ? WHERE id = ?')
        .run(live.meta.endedAt, exitCode, id);
    } catch { /* db closing during quit */ }
    broadcast('session:exit', { sessionId: id, exitCode });
    broadcast('session:list', listSessions());
  });

  if (opts.initialPrompt?.trim()) {
    // Give the TUI a moment to draw before typing into it.
    setTimeout(() => {
      try { proc.write(opts.initialPrompt!.trim() + '\r'); } catch { /* exited already */ }
    }, 1500);
  }

  broadcast('session:list', listSessions());
  return meta;
}

/**
 * Sessions from previous runs of the app. Anything still marked open was killed
 * by a quit rather than exiting on its own, so it is closed out on read.
 */
export function pastSessions(limit = 40): PastSession[] {
  const openIds = new Set(sessions.keys());
  const rows = db().prepare(
    'SELECT * FROM session_log ORDER BY started_at DESC LIMIT ?'
  ).all(limit) as Record<string, string | number | null>[];

  return rows
    .filter((r) => !openIds.has(String(r.id)))
    .map((r) => ({
      id: String(r.id),
      conversationId: r.conversation_id ? String(r.conversation_id) : null,
      providerId: String(r.provider_id) as PastSession['providerId'],
      projectId: r.project_id ? String(r.project_id) : null,
      projectPath: String(r.project_path),
      projectName: String(r.project_name),
      model: r.model ? String(r.model) : null,
      effort: r.effort ? String(r.effort) : null,
      permissionMode: r.permission_mode ? String(r.permission_mode) : null,
      startedAt: Number(r.started_at),
      endedAt: r.ended_at ? Number(r.ended_at) : null,
      exitCode: r.exit_code === null ? null : Number(r.exit_code),
      live: fs.existsSync(String(r.project_path)),
    }));
}

export function forgetPastSession(id: string) {
  db().prepare('DELETE FROM session_log WHERE id = ?').run(id);
}

export function sessionBaseline(sessionId: string): Baseline | null {
  return sessions.get(sessionId)?.meta.baseline ?? null;
}

/** Scrollback for a pane that is being mounted or re-mounted. */
export function scrollback(sessionId: string): string {
  return sessions.get(sessionId)?.buffer ?? '';
}

export function writeSession(sessionId: string, data: string) {
  const s = sessions.get(sessionId);
  if (!s || s.meta.status === 'exited') return;
  s.proc.write(data);
}

export function resizeSession(sessionId: string, cols: number, rows: number) {
  const s = sessions.get(sessionId);
  if (!s || s.meta.status === 'exited') return;
  if (cols > 0 && rows > 0) {
    try { s.proc.resize(cols, rows); } catch { /* race with exit */ }
  }
}

export function killSession(sessionId: string) {
  const s = sessions.get(sessionId);
  if (!s) return;
  if (s.meta.status !== 'exited') {
    try { s.proc.kill(); } catch { /* already gone */ }
  }
}

/** Removes an exited session from the list. Refuses while it is still running. */
export function closeSession(sessionId: string) {
  const s = sessions.get(sessionId);
  if (!s) return;
  if (s.meta.status !== 'exited') {
    throw new Error('Session is still running — stop it before closing.');
  }
  sessions.delete(sessionId);
  broadcast('session:list', listSessions());
}

export function markRead(sessionId: string) {
  const s = sessions.get(sessionId);
  if (s && s.meta.unread) { s.meta.unread = 0; broadcast('session:list', listSessions()); }
}

export function bumpUnread(sessionId: string) {
  const s = sessions.get(sessionId);
  if (s) s.meta.unread++;
}

/** Kill everything on quit so no orphaned agent keeps running headless. */
export function killAll() {
  const now = Date.now();
  for (const s of sessions.values()) {
    if (s.meta.status !== 'exited') {
      try { s.proc.kill(); } catch { /* noop */ }
      try {
        db().prepare('UPDATE session_log SET ended_at = ?, exit_code = ? WHERE id = ? AND ended_at IS NULL')
          .run(now, -1, s.meta.id);
      } catch { /* db already closed */ }
    }
  }
}
