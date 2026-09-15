import { BrowserWindow, clipboard, shell, type WebContents, type WebFrameMain } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { db } from './db';
import * as hooks from './hooks';
import { isManagedRoot } from './roots';
import { conversationKeyForSession, listSessions } from './sessions';
import * as organise from './session-organize';
import { archivedTurnsForExport, exactTranscriptPath } from './transcripts';
import { codexRolloutFiles, codexThreadIdForSession } from './codex-sessions';
import { redactCredentials } from './redact';
import { hasControlCharacter } from '../shared/session-organize';
import { splitLineColumn } from '../shared/terminal-links';
import { lastResponseFromClaudeJsonl, lastResponseFromCodexRollout, transcriptToMarkdown } from '../shared/copy-helpers';
import { codeRailMayCall, codeRailQuery } from '../shared/code-rail-window';

/**
 * The helper sweep's everyday conveniences in the session surface, wired once.
 *
 * index.ts calls three things: register the channels, let a code rail window
 * through the sender check for its own channels, and start and stop the one
 * listener. Every channel validates what the renderer sends; a session id is
 * resolved against main's own records, and a path is resolved against that
 * session's own folder and then against every managed root.
 */

type Handle = <T>(channel: string, fn: (...args: never[]) => T | Promise<T>) => void;

export type HelperUxDeps = {
  rendererEntryPath: () => string;
  developmentRendererUrl: () => string | null;
  trustedRendererUrl: (raw: string) => boolean;
  openSafeExternal: (raw: string) => boolean;
  /** The main window, whatever its state. Rail windows close when it does. */
  mainWindow: () => BrowserWindow | null;
};

let deps: HelperUxDeps | null = null;

/* ── the session a request names ─────────────────────────────────────── */

type SessionPlace = {
  id: string;
  /** Where the agent runs: its worktree when it has one, else the project. */
  cwd: string;
  projectPath: string;
  projectName: string;
  title: string | null;
  conversationId: string | null;
  harness: string;
  live: boolean;
  checkpointsSupported: boolean;
};

function legacyHarness(providerId: string): string {
  return providerId === 'codex' ? 'codex' : providerId === 'claude' || providerId === 'glm' ? 'claude-code' : `provider:${providerId}`;
}

function sessionPlace(sessionId: unknown): SessionPlace | null {
  if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 200) return null;
  const live = listSessions().find((s) => s.id === sessionId);
  if (live) {
    return {
      id: live.id, cwd: live.worktree ?? live.projectPath, projectPath: live.projectPath, projectName: live.projectName,
      title: live.displayTitle ?? null, conversationId: live.conversationId ?? null,
      harness: live.harnessId ?? live.providerProfile?.harness ?? legacyHarness(live.providerId),
      live: true, checkpointsSupported: live.capabilities?.hooks === true,
    };
  }
  let row: { id: string; worktree: string | null; project_path: string; project_name: string; title: string | null;
    conversation_id: string | null; harness_id: string | null; provider_id: string } | undefined;
  try {
    row = db().prepare(`SELECT id, worktree, project_path, project_name, title, conversation_id, harness_id, provider_id
      FROM session_log WHERE id = ?`).get(sessionId) as typeof row;
  } catch { return null; }
  if (!row) return null;
  return {
    id: row.id, cwd: row.worktree ?? row.project_path, projectPath: row.project_path, projectName: row.project_name,
    title: row.title, conversationId: row.conversation_id, harness: row.harness_id ?? legacyHarness(row.provider_id),
    live: false, checkpointsSupported: false,
  };
}

/* ── paths printed in a terminal ─────────────────────────────────────── */

export type ResolvedSessionPath =
  | { ok: true; absolute: string; rel: string | null; line: number | null; column: number | null; directory: boolean }
  | { ok: false; reason: string };

/**
 * A path an agent printed, resolved the way that agent meant it: relative to
 * the folder it runs in, `~/` to the home directory, with `:line[:col]` split
 * off. It must exist, and its real location (symlinks followed) must be inside
 * a project or worktree Wanigan manages — the same rule every file channel
 * uses, because a path in terminal output is text an agent, a tool or a file's
 * contents put there, and none of those is the operator naming a file.
 *
 * `rel` is set only when the file is inside this session's own folder, which
 * is the only place the session's code rail can open it.
 */
export function resolveSessionPath(sessionId: unknown, raw: unknown): ResolvedSessionPath {
  const place = sessionPlace(sessionId);
  if (!place) return { ok: false, reason: 'That session is not recorded, so there is no folder to resolve the path against.' };
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 1024 || hasControlCharacter(raw)) {
    return { ok: false, reason: 'That is not a path Wanigan will resolve.' };
  }
  const parts = splitLineColumn(raw.trim());
  let target = parts.path;
  if (target === '~' || target.startsWith('~/')) target = path.join(os.homedir(), target.slice(1));
  const candidate = path.isAbsolute(target) ? path.normalize(target) : path.resolve(place.cwd, target);
  let real: string;
  let stat: fs.Stats;
  try {
    real = fs.realpathSync(candidate);
    stat = fs.statSync(real);
  } catch {
    return { ok: false, reason: 'No such file or folder.' };
  }
  if (!isManagedRoot(real)) {
    return { ok: false, reason: 'It is outside every project and worktree Wanigan manages, so it will not be opened or revealed.' };
  }
  let rel: string | null = null;
  try {
    const root = fs.realpathSync(place.cwd);
    if (real === root || real.startsWith(root + path.sep)) rel = path.relative(root, real);
  } catch { /* a session folder that is gone can still reveal a file elsewhere */ }
  return { ok: true, absolute: real, rel, line: parts.line, column: parts.column, directory: stat.isDirectory() };
}

function revealSessionPath(sessionId: unknown, raw: unknown): boolean {
  const resolved = resolveSessionPath(sessionId, raw);
  if (!resolved.ok) throw new Error(resolved.reason);
  shell.showItemInFolder(resolved.absolute);
  return true;
}

/* ── the clipboard ───────────────────────────────────────────────────── */

const COPY_MAX_CHARS = 2_000_000;

/**
 * Electron's Clipboard is the W3C-shaped one: writeText returns a promise. It
 * is awaited so a refused write reaches the renderer as a failure instead of a
 * "Copied" nobody's clipboard holds.
 */
async function copyText(text: unknown): Promise<{ chars: number }> {
  if (typeof text !== 'string') throw new Error('There is nothing to copy.');
  if (text.length > COPY_MAX_CHARS) throw new Error('That is too long to put on the clipboard from here.');
  await clipboard.writeText(text);
  return { chars: text.length };
}

/** How much of a transcript's tail is read for its last response. */
const TAIL_BYTES = 8 * 1024 * 1024;

function readTail(file: string): string {
  const size = fs.statSync(file).size;
  if (size <= TAIL_BYTES) return fs.readFileSync(file, 'utf8');
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(TAIL_BYTES);
    const read = fs.readSync(fd, buffer, 0, TAIL_BYTES, size - TAIL_BYTES);
    const text = buffer.subarray(0, read).toString('utf8');
    return text.slice(text.indexOf('\n') + 1);
  } finally {
    fs.closeSync(fd);
  }
}

type ResponseSource = { ok: true; file: string; read: (text: string) => string | null; from: string } | { ok: false; reason: string };

/**
 * Where a session's last response can be read, without reading it. Exact
 * conversation files only: the newest-file fallback other readers use would
 * copy another conversation's words and call them this one's.
 */
function responseSource(sessionId: unknown): ResponseSource {
  const place = sessionPlace(sessionId);
  if (!place) return { ok: false, reason: 'That session is not recorded.' };
  if (place.harness === 'claude-code') {
    const file = exactTranscriptPath(place.cwd, place.conversationId);
    if (!file) {
      return { ok: false, reason: place.conversationId
        ? 'No Claude Code transcript file for this exact conversation was found.'
        : 'This session has no conversation id, so its transcript cannot be found exactly.' };
    }
    return { ok: true, file, read: lastResponseFromClaudeJsonl, from: 'the Claude Code transcript' };
  }
  if (place.harness === 'codex') {
    const thread = place.conversationId ?? codexThreadIdForSession(place.id);
    if (!thread) return { ok: false, reason: 'Codex has not reported a thread id for this session yet, so its rollout cannot be found.' };
    const file = codexRolloutFiles([thread]).get(thread.toLowerCase()) ?? null;
    if (!file) return { ok: false, reason: 'Codex’s rollout file for this thread was not found or is not readable.' };
    return { ok: true, file, read: lastResponseFromCodexRollout, from: 'the Codex rollout' };
  }
  return { ok: false, reason: 'Wanigan reads a last response only from Claude Code transcripts and Codex rollouts.' };
}

export type CopyAvailability = {
  lastResponse: { ok: true; from: string } | { ok: false; reason: string };
  conversationId: string | null;
};

export function copyAvailability(sessionId: unknown): CopyAvailability {
  const place = sessionPlace(sessionId);
  const source = responseSource(sessionId);
  return {
    lastResponse: source.ok ? { ok: true, from: source.from } : { ok: false, reason: source.reason },
    conversationId: place?.conversationId ?? null,
  };
}

async function copyLastResponse(sessionId: unknown): Promise<{ chars: number; from: string }> {
  const source = responseSource(sessionId);
  if (!source.ok) throw new Error(source.reason);
  let text: string | null;
  try { text = source.read(readTail(source.file)); }
  catch (e) { throw new Error(`The file could not be read: ${e instanceof Error ? e.message : String(e)}`); }
  if (!text) throw new Error(`There is no response text in ${source.from} yet.`);
  await clipboard.writeText(text);
  return { chars: text.length, from: source.from };
}

async function copyConversationId(sessionId: unknown): Promise<{ chars: number }> {
  const place = sessionPlace(sessionId);
  if (!place?.conversationId) throw new Error('This session has no conversation id yet.');
  await clipboard.writeText(place.conversationId);
  return { chars: place.conversationId.length };
}

/**
 * An archived transcript as Markdown on the clipboard, with every credential
 * shape redact.ts knows removed from the whole document — prose, tool names and
 * the title alike. Whether anything was redacted is reported, never what.
 */
export function transcriptMarkdown(sessionId: unknown): { markdown: string; turns: number; redacted: boolean; note: string | null } {
  if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 200) throw new Error('Choose a transcript first.');
  const { turns, note, archived } = archivedTurnsForExport(sessionId);
  if (!archived) throw new Error(note ?? 'No transcript was archived for this session.');
  if (!turns.length) throw new Error('The archive holds no readable turns for this session.');
  const place = sessionPlace(sessionId);
  const title = place ? `${place.projectName}${place.title ? ` — ${place.title}` : ''}` : `Archived conversation ${sessionId}`;
  const raw = transcriptToMarkdown(turns, { title, note });
  const markdown = redactCredentials(raw);
  return { markdown, turns: turns.length, redacted: markdown !== raw, note };
}

async function copyTranscriptMarkdown(sessionId: unknown): Promise<{ chars: number; turns: number; redacted: boolean; note: string | null }> {
  const out = transcriptMarkdown(sessionId);
  await clipboard.writeText(out.markdown);
  return { chars: out.markdown.length, turns: out.turns, redacted: out.redacted, note: out.note };
}

/**
 * The open session a quote from an archived transcript should land in: the
 * same session when its tab is still open, else a running session that
 * continues the same conversation. Null when none is open — a draft written
 * under a session id no composer will ever mount is a draft nobody reads.
 */
function liveSessionFor(sessionId: unknown): { sessionId: string; title: string } | null {
  if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 200) return null;
  const open = listSessions().filter((s) => s.status !== 'exited');
  const same = open.find((s) => s.id === sessionId);
  if (same) return { sessionId: same.id, title: same.displayTitle ?? same.projectName };
  const key = conversationKeyForSession(sessionId);
  if (!key) return null;
  const continued = open.find((s) => conversationKeyForSession(s.id) === key);
  return continued ? { sessionId: continued.id, title: continued.displayTitle ?? continued.projectName } : null;
}

/* ── the code rail in its own window ─────────────────────────────────── */

type Rail = { win: BrowserWindow; sessionId: string; cwd: string };
const rails = new Map<number, Rail>();
let watchTimer: NodeJS.Timeout | null = null;
let stopEventForward: (() => void) | null = null;

function railFor(sender: WebContents): Rail | null {
  const rail = rails.get(sender.id);
  return rail && !rail.win.isDestroyed() ? rail : null;
}

/** The session a rail window's first argument must name, per channel. */
const SESSION_ARG = new Set(['ux:railSession', 'sessions:baseline', 'checkpoints:list', 'checkpoints:diff', 'checkpoints:revertPlan', 'checkpoints:revert']);
const ROOT_ARG = new Set(['code:changes', 'code:diff', 'code:list', 'code:read', 'revert:plan', 'revert:file', 'revert:all']);

function sameFolder(a: unknown, b: string): boolean {
  if (typeof a !== 'string') return false;
  try { return fs.realpathSync(a) === fs.realpathSync(b); } catch { return path.resolve(a) === path.resolve(b); }
}

function insideFolder(target: unknown, root: string): boolean {
  if (typeof target !== 'string') return false;
  try {
    const real = fs.realpathSync(target);
    const base = fs.realpathSync(root);
    return real === base || real.startsWith(base + path.sep);
  } catch { return false; }
}

/**
 * Whether a code rail window may make this call. It is the same renderer
 * behind the same preload, so the channel name alone is not enough: the window
 * must be one main opened, its frame the entry document, the channel on the
 * rail's list, and every argument that names a session or a folder must name
 * the one session this window was opened for. A rail window for one project
 * cannot read, diff or revert another.
 */
export function codeRailSenderAllowed(sender: WebContents, frame: WebFrameMain | null, channel: string, args: readonly unknown[]): boolean {
  const rail = railFor(sender);
  if (!rail || !deps || frame === null || frame !== sender.mainFrame || !deps.trustedRendererUrl(frame.url)) return false;
  if (!codeRailMayCall(channel)) return false;
  if (SESSION_ARG.has(channel)) return args[0] === rail.sessionId;
  if (ROOT_ARG.has(channel)) return sameFolder(args[0], rail.cwd);
  if (channel === 'code:open') return insideFolder(args[1], rail.cwd);
  return true;
}

function railSession(sessionId: unknown): { id: string; projectName: string; root: string; title: string | null; live: boolean; checkpointsSupported: boolean } {
  const place = sessionPlace(sessionId);
  if (!place) throw new Error('That session is not recorded any more.');
  return { id: place.id, projectName: place.projectName, root: place.cwd, title: place.title, live: place.live, checkpointsSupported: place.checkpointsSupported };
}

/**
 * Open (or bring forward) a window holding one session's code rail.
 *
 * Every webPreferences value is the main window's, and so are the navigation
 * guards: no navigation away from the bundled renderer, no webviews, no child
 * windows, links only through the same http/https check. The window list is
 * not restored on relaunch — a session id belongs to one run, and the process
 * it named is gone after a quit.
 */
function openCodeRailWindow(sessionId: unknown): { opened: boolean } {
  if (!deps) throw new Error('Wanigan is still starting.');
  const place = sessionPlace(sessionId);
  if (!place) throw new Error('That session is not recorded any more.');
  for (const rail of rails.values()) {
    if (rail.sessionId === place.id && !rail.win.isDestroyed()) {
      if (rail.win.isMinimized()) rail.win.restore();
      rail.win.show();
      rail.win.focus();
      return { opened: false };
    }
  }
  const win = new BrowserWindow({
    width: 1040,
    height: 780,
    minWidth: 560,
    minHeight: 420,
    show: false,
    title: `Code — ${place.title ?? place.projectName}`,
    backgroundColor: '#0c0e12',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
    },
  });
  const contentsId = win.webContents.id;
  rails.set(contentsId, { win, sessionId: place.id, cwd: place.cwd });
  win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  win.webContents.session.setPermissionCheckHandler(() => false);
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());
  const open = deps.openSafeExternal;
  win.webContents.setWindowOpenHandler(({ url }) => { open(url); return { action: 'deny' }; });
  win.once('ready-to-show', () => { if (!win.isDestroyed()) win.show(); });
  win.on('closed', () => { rails.delete(contentsId); });

  const query = codeRailQuery(place.id);
  const dev = deps.developmentRendererUrl();
  const loaded = dev ? win.loadURL(`${dev.replace(/\?.*$/, '')}?${query}`) : win.loadFile(deps.rendererEntryPath(), { search: query });
  loaded.catch((error: unknown) => {
    console.error('[wanigan] the code rail window could not load its renderer:', error);
    if (!win.isDestroyed()) win.close();
  });
  startRailWatch();
  return { opened: true };
}

/**
 * A rail window closes when its session is forgotten — no longer open in
 * Wanigan and no longer in the record — and when the main window goes, so a
 * rail never outlives the window it was opened from.
 */
function startRailWatch(): void {
  if (watchTimer) return;
  watchTimer = setInterval(() => {
    if (!rails.size) { if (watchTimer) clearInterval(watchTimer); watchTimer = null; return; }
    const main = deps?.mainWindow() ?? null;
    const mainGone = !main || main.isDestroyed();
    for (const rail of [...rails.values()]) {
      if (rail.win.isDestroyed()) continue;
      if (mainGone || !sessionPlace(rail.sessionId)) rail.win.close();
    }
  }, 2_000);
  watchTimer.unref?.();
}

export function closeCodeRailWindows(): void {
  for (const rail of [...rails.values()]) if (!rail.win.isDestroyed()) rail.win.close();
  rails.clear();
}

/** Test seam for the smoke suite: how many rail windows are registered. */
export function codeRailWindowCount(): number {
  return [...rails.values()].filter((r) => !r.win.isDestroyed()).length;
}

/* ── registration ────────────────────────────────────────────────────── */

export function registerHelperUxIpc(handle: Handle, dependencies: HelperUxDeps): void {
  deps = dependencies;
  handle('ux:organise', (ids: unknown) => organise.organiseSnapshot(ids));
  handle('ux:addTags', (sessionId: unknown, raw: unknown) => organise.addTags(sessionId, raw));
  handle('ux:removeTag', (sessionId: unknown, tag: unknown) => organise.removeTag(sessionId, tag));
  handle('ux:setTagColor', (tag: unknown, color: unknown) => organise.setTagColor(tag, color));
  handle('ux:createSection', (name: unknown) => organise.createSection(name));
  handle('ux:renameSection', (id: unknown, name: unknown) => organise.renameSection(id, name));
  handle('ux:moveSection', (id: unknown, delta: unknown) => organise.moveSection(id, delta));
  handle('ux:deleteSection', (id: unknown) => organise.deleteSection(id));
  handle('ux:placeInSection', (sessionId: unknown, sectionId: unknown) => organise.placeInSection(sessionId, sectionId));
  handle('ux:moveInSection', (sessionId: unknown, delta: unknown) => organise.moveInSection(sessionId, delta));

  handle('ux:resolvePath', (sessionId: unknown, raw: unknown) => resolveSessionPath(sessionId, raw));
  handle('ux:revealPath', (sessionId: unknown, raw: unknown) => revealSessionPath(sessionId, raw));

  handle('ux:copyText', (text: unknown) => copyText(text));
  handle('ux:copyAvailability', (sessionId: unknown) => copyAvailability(sessionId));
  handle('ux:copyLastResponse', (sessionId: unknown) => copyLastResponse(sessionId));
  handle('ux:copyConversationId', (sessionId: unknown) => copyConversationId(sessionId));
  handle('ux:copyTranscriptMarkdown', (sessionId: unknown) => copyTranscriptMarkdown(sessionId));
  handle('ux:liveSessionFor', (sessionId: unknown) => liveSessionFor(sessionId));

  handle('ux:openCodeRail', (sessionId: unknown) => openCodeRailWindow(sessionId));
  handle('ux:railSession', (sessionId: unknown) => railSession(sessionId));
}

/**
 * The code panel follows an agent's edits through `session:event`. The main
 * window already receives every event; a rail window receives only its own
 * session's, on the same channel, so the panel needs no second code path.
 */
export function startHelperUxServices(): void {
  stopEventForward?.();
  stopEventForward = hooks.onHookEvent((e) => {
    for (const rail of rails.values()) {
      if (rail.sessionId !== e.sessionId || rail.win.isDestroyed() || rail.win.webContents.isDestroyed()) continue;
      rail.win.webContents.send('session:event', e);
    }
  });
}

export function stopHelperUxServices(): void {
  stopEventForward?.();
  stopEventForward = null;
  if (watchTimer) clearInterval(watchTimer);
  watchTimer = null;
}
