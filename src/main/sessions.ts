import type { IPty } from 'node-pty';
import { BrowserWindow } from 'electron';
import type { LaunchOptions, Session, ProviderId } from '../shared/types';
import { providerById, shellPath, detectProviders } from './providers';
import { projectById } from './store';

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
  const args = def.args(extra);

  const id = `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const meta: Session = {
    id,
    providerId: opts.providerId,
    projectId: project.id,
    projectPath: project.path,
    projectName: project.name,
    title: `${def.label} · ${project.name}`,
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
  for (const s of sessions.values()) {
    if (s.meta.status !== 'exited') { try { s.proc.kill(); } catch { /* noop */ } }
  }
}
