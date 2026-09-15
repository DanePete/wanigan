import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { dialog, type BrowserWindow } from 'electron';
import { dataDir, db } from './db';
import { createSession, listSessions, writeSession } from './sessions';
import { attentionOf } from './attention';
import { halted } from './halt';
import { projectById } from './store';
import { trustFor } from './policy';
import { macSettings } from './p8-settings';
import {
  MAX_LINE_BYTES, decideSend, parseAutomationLine, peerFromLsof, ptyPayload,
  type AutomationLedgerRow, type AutomationRequest, type AutomationStatus,
} from '../shared/automation-protocol';
import { splitTerminalInput } from '../shared/terminal-input';
import { automationPathsUnder as pathsUnder, type AutomationPaths } from './automation-client';
import type { AttentionKind, ProviderId, Session } from '../shared/types';

/**
 * A local automation socket: other programs on this Mac drive Wanigan through
 * a Unix domain socket, owner-only, and every call is written down.
 *
 * The door exists so a plain script — "when CI goes red, draft a note into
 * that session" — can reach an agent without a hosted relay and without the
 * MCP server, which is scoped to one session talking about itself. It is off
 * until the operator turns it on, and it is built to be exactly as wide as a
 * process running as this user already is, and no wider:
 *
 *  - The socket lives in its own directory under Wanigan's user-data directory,
 *    created 0700 and checked on every start to be a real directory owned by
 *    this user with no group or world bits. The socket file itself is 0600.
 *    Filesystem permission is the first lock.
 *  - Every request carries a bearer token read from a 0600 file beside the
 *    socket, regenerated each time the socket starts. The token is the second
 *    lock, and it means a process that can connect but cannot read that
 *    directory gets nothing.
 *  - Every call writes a ledger row naming the peer process — its pid and its
 *    executable, never its arguments, because `socket draft <id> <text>` puts
 *    the text in argv — or "unknown peer" when the pid cannot be read.
 *
 * What a caller can do is deliberately less than what the operator can do. A
 * draft lands in the composer and waits for Send. A send is refused unless a
 * second switch allows it, and even then reaches the prompt only when the
 * composer's own readiness rule says the agent is listening; otherwise it
 * waits in a queue here. A new session opens a native approval dialog, the
 * same shape as the MCP server's `wanigan_start_session`, and is refused if
 * nobody answers within five minutes.
 */

export const APPROVAL_TIMEOUT_MS = 5 * 60_000;
/** Shortened only by the offline suite, which cannot wait five minutes to prove the refusal. */
let approvalTimeoutMs = APPROVAL_TIMEOUT_MS;
/** A queued send that has waited this long is dropped and recorded, never sent late into a different conversation state. */
const QUEUE_TTL_MS = 60 * 60_000;
const QUEUE_POLL_MS = 2_000;
const QUEUE_MAX_PER_SESSION = 10;
const MAX_CONNECTIONS = 8;
/** The Unix socket path limit on macOS is 104 bytes including the terminator. */
const MAX_SOCKET_PATH_BYTES = 103;
const SUBMIT_DELAY_MS = 120;
const HELD_DRAFTS_MAX = 20;

export { type AutomationPaths };

export function automationPaths(base: string = dataDir()): AutomationPaths {
  return pathsUnder(base);
}

export type { AutomationStatus };
export type LedgerRow = AutomationLedgerRow;

type Approver = (input: { projectName: string; projectPath: string; provider: string; trust: string; prompt: string; peer: string }, signal: AbortSignal) => Promise<boolean>;

type Deps = {
  liveWindow: () => BrowserWindow | null;
};

let deps: Deps | null = null;
let server: net.Server | null = null;
let token: string | null = null;
let lastError: string | null = null;
let paths: AutomationPaths | null = null;
const connections = new Set<net.Socket>();
let approver: Approver | null = null;

type QueuedSend = { sessionId: string; text: string; queuedAt: number; peer: Peer };
const queue: QueuedSend[] = [];
let queueTimer: NodeJS.Timeout | null = null;

type HeldDraft = { sessionId: string; text: string; at: number };
const heldDrafts: HeldDraft[] = [];

type Peer = { pid: number | null; command: string };

/**
 * Where live sessions come from and where a send is written. The real session
 * manager in the app; the offline suite substitutes its own, because it cannot
 * start an agent, and drives everything else — the socket, the token, the
 * parser, the ledger and the readiness rule — for real.
 */
type Sources = {
  sessions: () => Session[];
  write: (sessionId: string, data: string) => boolean;
  attention: (session: Session) => { label: string; kind: AttentionKind; since: number };
};
const REAL_SOURCES: Sources = { sessions: listSessions, write: writeSession, attention: attentionOf };
let sources: Sources = REAL_SOURCES;

export const __automationTest = {
  setSources(next: Partial<Sources> | null): void { sources = next ? { ...REAL_SOURCES, ...next } : REAL_SOURCES; },
  drainQueue: () => drainQueue(),
  setApprovalTimeout(ms: number | null): void { approvalTimeoutMs = ms ?? APPROVAL_TIMEOUT_MS; },
};

/* ── the ledger ──────────────────────────────────────────────────────── */

function record(verb: string, peer: Peer, outcome: string, fields: { sessionId?: string | null; projectId?: string | null; detail?: string | null } = {}): void {
  try {
    db().prepare(`INSERT INTO automation_ledger (at, verb, session_id, project_id, peer_pid, peer_command, outcome, detail)
                  VALUES (?,?,?,?,?,?,?,?)`)
      .run(Date.now(), verb.slice(0, 40), fields.sessionId ?? null, fields.projectId ?? null, peer.pid, peer.command.slice(0, 400),
        outcome.slice(0, 80), fields.detail ? fields.detail.slice(0, 400) : null);
  } catch {
    // A closed database is a quit in progress. The call itself was already
    // answered or refused; losing its row is reported nowhere else.
  }
}

export function automationLedger(limit = 50): LedgerRow[] {
  const n = Math.max(1, Math.min(500, Math.trunc(limit) || 50));
  return (db().prepare(`SELECT id, at, verb, session_id, project_id, peer_pid, peer_command, outcome, detail
                          FROM automation_ledger ORDER BY at DESC, id DESC LIMIT ?`).all(n) as {
    id: number; at: number; verb: string; session_id: string | null; project_id: string | null;
    peer_pid: number | null; peer_command: string; outcome: string; detail: string | null;
  }[]).map((r) => ({
    id: r.id, at: r.at, verb: r.verb, sessionId: r.session_id, projectId: r.project_id,
    peerPid: r.peer_pid, peerCommand: r.peer_command, outcome: r.outcome, detail: r.detail,
  }));
}

/* ── naming the peer ─────────────────────────────────────────────────── */

function run(cmd: string, args: string[], timeout = 3_000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (error, stdout) => {
      resolve(error && !stdout ? null : stdout);
    });
  });
}

/**
 * The other end of an accepted connection. Node has no binding for
 * getsockopt(LOCAL_PEERPID), so this reads the same fact out of lsof; see
 * peerFromLsof for the verification. The command is the executable path from
 * `ps -o comm=`, not argv, because argv is where a draft's text sits.
 */
async function peerOf(socket: net.Socket): Promise<Peer> {
  const fd = (socket as unknown as { _handle?: { fd?: number } })._handle?.fd;
  if (process.platform !== 'darwin' || typeof fd !== 'number' || fd < 0) return { pid: null, command: 'unknown peer' };
  const own = await run('lsof', ['-a', '-p', String(process.pid), '-d', String(fd), '-U', '-F', 'fdn']);
  const all = own ? await run('lsof', ['-U', '-F', 'pn']) : null;
  const pid = own && all ? peerFromLsof(own, all, process.pid) : null;
  if (!pid) return { pid: null, command: 'unknown peer' };
  const comm = (await run('ps', ['-o', 'comm=', '-p', String(pid)]))?.trim();
  return { pid, command: comm || 'unknown peer' };
}

/* ── directory and token ─────────────────────────────────────────────── */

/**
 * The socket's directory, made and then proven owner-only. A directory that
 * already exists with wider permissions is tightened; one that cannot be — a
 * symlink, another user's directory — is refused rather than trusted.
 */
export function ensureOwnerOnlyDir(dir: string): void {
  const parent = path.dirname(dir);
  const ps = fs.statSync(parent);
  const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
  if (uid >= 0 && ps.uid !== uid) throw new Error(`${parent} is not owned by this user, so Wanigan will not open an automation socket inside it.`);
  if (ps.mode & 0o022) throw new Error(`${parent} is writable by other users, so the automation socket's directory could be replaced. Tighten it with chmod go-w first.`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const ls = fs.lstatSync(dir);
  if (ls.isSymbolicLink() || !ls.isDirectory()) throw new Error(`${dir} is not a plain directory, so Wanigan will not put a socket in it.`);
  if (uid >= 0 && ls.uid !== uid) throw new Error(`${dir} is not owned by this user.`);
  if (ls.mode & 0o077) fs.chmodSync(dir, 0o700);
  const again = fs.lstatSync(dir);
  if (again.mode & 0o077) throw new Error(`${dir} could not be made owner-only (mode ${(again.mode & 0o777).toString(8)}).`);
}

function removeIfSocket(file: string): void {
  try {
    const st = fs.lstatSync(file);
    if (st.isSocket()) fs.unlinkSync(file);
    else throw new Error(`${file} exists and is not a socket, so Wanigan will not remove or replace it.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function writeToken(file: string): string {
  const value = randomBytes(32).toString('base64url');
  try { fs.unlinkSync(file); } catch { /* none yet */ }
  fs.writeFileSync(file, `${value}\n`, { mode: 0o600, flag: 'wx' });
  fs.chmodSync(file, 0o600);
  return value;
}

function tokenMatches(given: string): boolean {
  if (!token) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/* ── verbs ───────────────────────────────────────────────────────────── */

type Answer = { ok: true; data: unknown } | { ok: false; error: string };

function sessionFor(id: string): Session | null {
  return sources.sessions().find((s) => s.id === id) ?? null;
}

function stateOf(s: Session): { word: string; kind: AttentionKind | null; since: number | null } {
  try {
    const a = sources.attention(s);
    return { word: a.label, kind: a.kind, since: a.since };
  } catch {
    return { word: s.status === 'exited' ? 'Exited' : 'No signal yet', kind: null, since: null };
  }
}

function describe(s: Session): Record<string, unknown> {
  const st = stateOf(s);
  return { id: s.id, title: s.displayTitle || s.title, project: s.projectName, projectId: s.projectId, state: st.word, status: s.status };
}

function deliverDraft(sessionId: string, text: string): 'window' | 'held' {
  const w = deps?.liveWindow();
  if (w && !w.isDestroyed()) {
    w.webContents.send('automation:draft', { sessionId, text });
    return 'window';
  }
  heldDrafts.push({ sessionId, text, at: Date.now() });
  if (heldDrafts.length > HELD_DRAFTS_MAX) heldDrafts.shift();
  return 'held';
}

/** Drafts that arrived while no window was open, collected once one mounts. */
export function takeAutomationDrafts(): HeldDraft[] {
  return heldDrafts.splice(0, heldDrafts.length);
}

async function writeText(sessionId: string, text: string): Promise<boolean> {
  const payload = ptyPayload(text);
  for (let i = 0; i < payload.length; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, SUBMIT_DELAY_MS));
    for (const chunk of splitTerminalInput(payload[i])) {
      if (!sources.write(sessionId, chunk)) return false;
    }
  }
  return true;
}

function drainQueue(): void {
  const now = Date.now();
  const allowed = macSettings().automationSend;
  const isHalted = halted();
  // Only the oldest queued send per session is considered each tick: the
  // first send makes the agent busy, and the next must wait for it to come
  // back to its prompt, which a later tick will see.
  const heads = new Map<string, QueuedSend>();
  for (const item of queue) if (!heads.has(item.sessionId)) heads.set(item.sessionId, item);
  for (const item of heads.values()) {
    const s = sessionFor(item.sessionId);
    const remove = () => { const i = queue.indexOf(item); if (i >= 0) queue.splice(i, 1); };
    const projectId = s?.projectId ?? null;
    if (now - item.queuedAt > QUEUE_TTL_MS) {
      remove();
      record('send', item.peer, 'queue-expired', { sessionId: item.sessionId, projectId, detail: `${item.text.length} characters, unsent after an hour` });
      continue;
    }
    const decision = decideSend({ allowed, halted: isHalted, status: s?.status ?? null, attention: s ? stateOf(s).kind : null });
    if (decision.action === 'queue') continue;
    remove();
    if (decision.action === 'refuse') {
      record('send', item.peer, 'queue-dropped', { sessionId: item.sessionId, projectId, detail: `${item.text.length} characters: ${decision.reason}`.slice(0, 300) });
      continue;
    }
    void writeText(item.sessionId, item.text).then((ok) => {
      record('send', item.peer, ok ? 'sent-from-queue' : 'write-failed', { sessionId: item.sessionId, projectId, detail: `${item.text.length} characters` });
    });
  }
  if (!queue.length && queueTimer) { clearInterval(queueTimer); queueTimer = null; }
}

async function approveNew(input: Parameters<Approver>[0]): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), approvalTimeoutMs);
  try {
    const fn = approver ?? defaultApprover;
    return (await Promise.race([
      fn(input, controller.signal),
      new Promise<boolean>((resolve) => controller.signal.addEventListener('abort', () => resolve(false), { once: true })),
    ])) === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

const defaultApprover: Approver = async (input, signal) => {
  const w = deps?.liveWindow();
  if (!w || w.isDestroyed()) return false;
  const shown = input.prompt.length > 600 ? `${input.prompt.slice(0, 599)}…` : input.prompt;
  const r = await dialog.showMessageBox(w, {
    type: 'question',
    buttons: ['Cancel', 'Start session'],
    defaultId: 0,
    cancelId: 0,
    title: 'A script wants to start an agent session',
    message: `${input.peer} asks to start a ${input.provider} session in ${input.projectName} (${input.projectPath}) at ${input.trust} trust.`,
    detail: `It will be asked:\n\n${shown}\n\nThis came through Wanigan's automation socket and is recorded in its ledger. It is refused if nobody answers within five minutes.`,
    signal,
  });
  return r.response === 1;
};

/** For the offline suite, which cannot click a dialog. Null restores the real one. */
export function setAutomationApprover(fn: Approver | null): void {
  approver = fn;
}

async function answer(request: AutomationRequest, peer: Peer): Promise<Answer> {
  const peerName = peer.pid ? `${peer.command} (pid ${peer.pid})` : 'An unknown process';
  switch (request.verb) {
    case 'list': {
      const rows = sources.sessions().filter((s) => s.status !== 'exited').map(describe);
      record('list', peer, 'answered', { detail: `${rows.length} sessions` });
      return { ok: true, data: { sessions: rows } };
    }
    case 'status': {
      const s = sessionFor(request.session);
      if (!s) { record('status', peer, 'refused', { sessionId: request.session, detail: 'no such session' }); return { ok: false, error: 'No such session. Call list for the live ones.' }; }
      const st = stateOf(s);
      record('status', peer, 'answered', { sessionId: s.id, projectId: s.projectId });
      return { ok: true, data: { ...describe(s), since: st.since, exitCode: s.exitCode } };
    }
    case 'draft': {
      const s = sessionFor(request.session);
      if (!s || s.status === 'exited') {
        record('draft', peer, 'refused', { sessionId: request.session, detail: s ? 'session has exited' : 'no such session' });
        return { ok: false, error: s ? 'This session has exited, so there is no composer to draft into.' : 'No such session. Call list for the live ones.' };
      }
      const where = deliverDraft(s.id, request.text);
      record('draft', peer, where === 'window' ? 'drafted' : 'drafted-held', { sessionId: s.id, projectId: s.projectId, detail: `${request.text.length} characters` });
      return { ok: true, data: { drafted: true, delivered: where === 'window' ? 'composer' : 'held until a Wanigan window opens', sent: false } };
    }
    case 'send': {
      const s = sessionFor(request.session);
      const decision = decideSend({
        allowed: macSettings().automationSend, halted: halted(),
        status: s?.status ?? null, attention: s ? stateOf(s).kind : null,
      });
      if (decision.action === 'refuse') {
        record('send', peer, 'refused', { sessionId: request.session, projectId: s?.projectId ?? null, detail: decision.reason.slice(0, 200) });
        return { ok: false, error: decision.reason };
      }
      if (decision.action === 'queue' || queue.some((q) => q.sessionId === request.session)) {
        if (queue.filter((q) => q.sessionId === request.session).length >= QUEUE_MAX_PER_SESSION) {
          record('send', peer, 'refused', { sessionId: request.session, projectId: s?.projectId ?? null, detail: 'queue full' });
          return { ok: false, error: `This session already has ${QUEUE_MAX_PER_SESSION} queued sends.` };
        }
        queue.push({ sessionId: request.session, text: request.text, queuedAt: Date.now(), peer });
        if (!queueTimer) queueTimer = setInterval(drainQueue, QUEUE_POLL_MS);
        const reason = decision.action === 'queue' ? decision.reason : 'Earlier sends to this session are still queued; this one waits behind them.';
        record('send', peer, 'queued', { sessionId: request.session, projectId: s?.projectId ?? null, detail: `${request.text.length} characters` });
        return { ok: true, data: { sent: false, queued: true, reason } };
      }
      const ok = await writeText(request.session, request.text);
      record('send', peer, ok ? 'sent' : 'write-failed', { sessionId: request.session, projectId: s?.projectId ?? null, detail: `${request.text.length} characters` });
      return ok ? { ok: true, data: { sent: true, queued: false } } : { ok: false, error: 'The terminal did not accept the text.' };
    }
    case 'new': {
      const project = projectById(request.project);
      if (!project) { record('new', peer, 'refused', { projectId: request.project, detail: 'no such project' }); return { ok: false, error: 'No such project.' }; }
      if (halted()) { record('new', peer, 'refused', { projectId: project.id, detail: 'halted' }); return { ok: false, error: 'Wanigan is halted, so it will not start a session.' }; }
      const provider = (request.provider ?? 'claude') as ProviderId;
      const trust = trustFor(project.id);
      record('new', peer, 'asked', { projectId: project.id, detail: `${provider}, prompt of ${request.prompt.length} characters` });
      const approved = await approveNew({ projectName: project.name, projectPath: project.path, provider, trust, prompt: request.prompt, peer: peerName });
      if (!approved) {
        record('new', peer, 'declined', { projectId: project.id, detail: 'declined, unanswered within five minutes, or no window to ask in' });
        return { ok: false, error: 'Not approved: the operator declined, did not answer within five minutes, or no Wanigan window was open to ask in. Nothing was started.' };
      }
      try {
        const s = await createSession({ providerId: provider, projectId: project.id, initialPrompt: request.prompt });
        record('new', peer, 'started', { sessionId: s.id, projectId: project.id });
        return { ok: true, data: { started: true, session: describe(s) } };
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        record('new', peer, 'launch-failed', { projectId: project.id, detail: why.slice(0, 200) });
        return { ok: false, error: why };
      }
    }
  }
}

/* ── transport ───────────────────────────────────────────────────────── */

function reply(socket: net.Socket, id: string | number | null, body: Answer): void {
  if (socket.destroyed) return;
  socket.write(`${JSON.stringify({ ...(id !== null ? { id } : {}), ...body })}\n`);
}

function onConnection(socket: net.Socket): void {
  if (connections.size >= MAX_CONNECTIONS) { socket.end(`${JSON.stringify({ ok: false, error: 'Too many open connections.' })}\n`); return; }
  connections.add(socket);
  socket.setEncoding('utf8');
  const peerRead = peerOf(socket);
  let buffer = '';
  let chain = Promise.resolve();
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > MAX_LINE_BYTES + 1 && !buffer.includes('\n')) {
      void peerRead.then((peer) => record('unknown', peer, 'refused', { detail: 'line too long' }));
      socket.end(`${JSON.stringify({ ok: false, error: `A request line may be at most ${MAX_LINE_BYTES} bytes.` })}\n`);
      buffer = '';
      return;
    }
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, '');
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      chain = chain.then(async () => {
        const peer = await peerRead;
        const parsed = parseAutomationLine(line);
        if (!parsed.ok) {
          record(parsed.verb ?? 'unknown', peer, 'refused', { detail: parsed.error.slice(0, 200) });
          reply(socket, parsed.id, { ok: false, error: parsed.error });
          return;
        }
        if (!tokenMatches(parsed.request.token)) {
          record(parsed.request.verb, peer, 'refused', { detail: 'wrong token' });
          reply(socket, parsed.request.id, { ok: false, error: 'Wrong token. It changes every time the socket starts; read it again from the token file.' });
          return;
        }
        if (!macSettings().automationSocket) {
          reply(socket, parsed.request.id, { ok: false, error: 'The automation socket was turned off.' });
          return;
        }
        try {
          reply(socket, parsed.request.id, await answer(parsed.request, peer));
        } catch (e) {
          reply(socket, parsed.request.id, { ok: false, error: e instanceof Error ? e.message : String(e) });
        }
      });
    }
  });
  socket.on('error', () => { /* a client that hung up mid-answer */ });
  socket.on('close', () => connections.delete(socket));
}

export async function startAutomationSocket(next: Deps, base: string = dataDir()): Promise<AutomationStatus> {
  deps = next;
  if (server) return automationStatus();
  lastError = null;
  const p = automationPaths(base);
  paths = p;
  try {
    if (Buffer.byteLength(p.socket) > MAX_SOCKET_PATH_BYTES) {
      throw new Error(`The socket path ${p.socket} is longer than macOS allows for a Unix socket (104 bytes).`);
    }
    ensureOwnerOnlyDir(p.dir);
    removeIfSocket(p.socket);
    token = writeToken(p.token);
    const s = net.createServer(onConnection);
    await new Promise<void>((resolve, reject) => {
      s.once('error', reject);
      s.listen(p.socket, () => { s.off('error', reject); resolve(); });
    });
    fs.chmodSync(p.socket, 0o600);
    s.on('error', (e) => { console.warn('[wanigan] automation socket error (ignored):', e); });
    server = s;
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e);
    token = null;
    try { if (fs.existsSync(p.token)) fs.unlinkSync(p.token); } catch { /* nothing to tidy */ }
  }
  return automationStatus();
}

export function stopAutomationSocket(): void {
  for (const c of connections) c.destroy();
  connections.clear();
  server?.close();
  server = null;
  token = null;
  if (queueTimer) { clearInterval(queueTimer); queueTimer = null; }
  for (const item of queue.splice(0, queue.length)) {
    record('send', item.peer, 'queue-dropped', { sessionId: item.sessionId, detail: `${item.text.length} characters: the socket was stopped` });
  }
  if (paths) {
    try { removeIfSocket(paths.socket); } catch { /* leave a non-socket alone */ }
    try { fs.unlinkSync(paths.token); } catch { /* already gone */ }
  }
}

export function automationStatus(): AutomationStatus {
  const settings = macSettings();
  const p = paths ?? automationPaths();
  return {
    enabled: settings.automationSocket,
    listening: server !== null,
    sendAllowed: settings.automationSend,
    socketPath: p.socket,
    tokenPath: p.token,
    error: lastError,
    queued: queue.length,
  };
}
