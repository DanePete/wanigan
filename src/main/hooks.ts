import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { Socket } from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { app } from 'electron';
import { db } from './db';
import { recordGoalTrace } from './goal-trace';
import { getSetting } from './settings';
import { answerFor, contextForSession, trustBriefing } from './policy';
import type { HookEventName, HookInput, PolicyDecision, SessionEvent } from '../shared/types';

/**
 * The hook bus. Metrics say how much a session spent; hooks say what it did,
 * when, and whether it is stuck waiting on a human.
 *
 * Claude Code posts each hook event to an http endpoint we hand it at launch.
 * The listener is bound to 127.0.0.1 and each generated settings file carries
 * its own opaque bearer capability. A process-wide bearer plus a caller-owned
 * session id would let one agent forge events for another pane; the capability
 * is the server-side binding between this request and its Wanigan session.
 */

/** Anything longer than this is a paste, not a summary. */
const MAX_SUMMARY = 160;
const MAX_PATH = 300;
/**
 * A PostToolUse body can carry a whole file in tool_response. We never store it,
 * but we must not buffer it either — an agent reading a 200MB log would take the
 * main process down with it.
 */
const MAX_BODY = 1024 * 1024;
/** The agent is blocked on this request. Never spend longer than this on one. */
const REQUEST_BUDGET_MS = 2000;
/** How far back liveState looks to pair PreToolUse with its PostToolUse. */
const LIVE_WINDOW = 200;

type Listener = (e: SessionEvent) => void;

let server: http.Server | null = null;
let info: { port: number } | null = null;
/**
 * Returns null for "no answer", which is not the same as an allow: the CLI falls
 * back to its own permission prompt, and a human decides. Only ever a safe thing
 * to return when there is a human.
 */
let policy: ((input: HookInput) => PolicyDecision | null) | null = null;
/** Optional, bounded project briefing supplied by the learning engine. */
export type LearningBriefingContext = {
  providerId: string;
  backendId?: string | null;
  projectId: string | null;
  projectPath: string | null;
  /** The current task, when known, so retrieval is relevant rather than a project dump. */
  query?: string;
  path?: string | null;
};
let learningBriefing: ((
  sessionId: string,
  context?: LearningBriefingContext,
) => string | null | Promise<string | null>) | null = null;
const listeners = new Set<Listener>();
const sockets = new Set<Socket>();
/** sessionId → the settings file and opaque capability written for it. */
const registered = new Map<string, {
  file: string;
  projectPath: string;
  capability: string;
  learningContext?: LearningBriefingContext;
}>();
/** Capability → session id. This is intentionally process-local and revocable. */
const capabilitySessions = new Map<string, string>();
const CAPABILITY_RE = /^[A-Za-z0-9_-]{43}$/;

/* ── server ──────────────────────────────────────────────────────────── */

export async function startHookServer(): Promise<{ port: number }> {
  if (info && server) return info;

  const srv = http.createServer((req, res) => { void onRequest(req, res); });

  // Keep-alive sockets outlive their request. Without these two the app waits
  // on an idle agent connection at quit instead of closing.
  srv.keepAliveTimeout = 2000;
  srv.headersTimeout = 5000;
  srv.on('connection', (s: Socket) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });

  await new Promise<void>((resolve, reject) => {
    const fail = (e: Error) => reject(new Error(
      `Wanigan could not open its hook listener on 127.0.0.1: ${e.message}. ` +
      'Sessions still run; turn Hooks off in Settings to stop trying.'
    ));
    srv.once('error', fail);
    // Port 0 means "any free port" and the address is loopback only — a hook
    // listener on 0.0.0.0 would be a writable endpoint on every network the
    // laptop joins.
    srv.listen(0, '127.0.0.1', () => { srv.off('error', fail); resolve(); });
  });

  const addr = srv.address();
  if (typeof addr !== 'object' || addr === null) {
    srv.close();
    throw new Error('The hook listener started without a port. Restart Wanigan.');
  }
  // A socket error after startup (an agent killed mid-post) must not reach the
  // process-level 'error' handler and take the app down.
  srv.on('error', () => {});

  server = srv;
  info = { port: addr.port };
  sweepStaleSettings();
  return info;
}

export function stopHookServer(): void {
  const srv = server;
  server = null;
  info = null;
  pending.clear();
  // A stopped listener cannot honour any of these capabilities. Drop their
  // credentials from disk too: retaining a live session's settings file after
  // its endpoint disappeared is both misleading and an unnecessary secret.
  for (const sessionId of [...registered.keys()]) cleanupHookSettings(sessionId);
  capabilitySessions.clear();
  if (!srv) return;
  srv.close();
  // close() only stops new connections; an established one keeps the loop alive.
  for (const s of sockets) { try { s.destroy(); } catch { /* already gone */ } }
  sockets.clear();
}

export function hookServerInfo(): { port: number } | null {
  return info ? { ...info } : null;
}

/* ── settings file ───────────────────────────────────────────────────── */

/**
 * The events we ask for. Deliberately not every name in HOOK_EVENTS: the CLI
 * rejects the whole settings file if it does not know an event name, and a
 * rejected file means a session launches with no hooks at all and no warning.
 * Unknown events are still accepted when posted — the listener stores whatever
 * arrives.
 */
const SETTINGS_EVENTS: HookEventName[] = [
  'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
  'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied', 'Notification',
  'Stop', 'StopFailure', 'PreCompact', 'PostCompact',
];

/** Only these carry a tool name for a matcher to match against. */
const TOOL_MATCHED = new Set<HookEventName>([
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied',
]);

function hooksDir(): string {
  return path.join(app.getPath('userData'), 'hooks');
}

/**
 * Writes the hook config for one session and returns its absolute path, or null
 * when hooks are off or the listener never came up.
 *
 * The file lives in Wanigan's OWN userData directory and is passed to the CLI by
 * path. Wanigan never writes into the user's repository — not .claude/settings
 * .json, not .claude/settings.local.json. A tool that edits tracked files to
 * instrument itself shows up in the user's next diff, and in their next commit.
 *
 * Attribution is not taken from the URL or hook payload: both are agent-owned
 * input. The generated bearer is a random, per-session capability and the
 * listener resolves it back to the session id it registered here.
 */
export function writeHookSettings(
  waniganSessionId: string,
  projectPath: string,
  learningContext?: LearningBriefingContext,
): string | null {
  if (!hooksEnabled()) return null;
  const live = info;
  if (!live) return null;

  let capability = randomBytes(32).toString('base64url');
  while (capabilitySessions.has(capability)) capability = randomBytes(32).toString('base64url');
  const url = `http://127.0.0.1:${live.port}/hook`;
  const handler = { type: 'http', url, headers: { Authorization: `Bearer ${capability}` } };

  const hooks: Record<string, unknown[]> = {};
  for (const ev of SETTINGS_EVENTS) {
    hooks[ev] = [TOOL_MATCHED.has(ev) ? { matcher: '*', hooks: [handler] } : { hooks: [handler] }];
  }

  const dir = hooksDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* best effort on odd filesystems */ }
  const file = path.join(dir, `${safeName(waniganSessionId)}.json`);
  fs.writeFileSync(file, JSON.stringify({ hooks }, null, 2), { mode: 0o600 });
  // writeFileSync honours mode only when it creates the file; an overwrite keeps
  // whatever the old one had. This file is a bearer credential.
  try { fs.chmodSync(file, 0o600); } catch { /* best effort on odd filesystems */ }

  const previous = registered.get(waniganSessionId);
  if (previous) capabilitySessions.delete(previous.capability);
  registered.set(waniganSessionId, { file, projectPath, capability, learningContext });
  capabilitySessions.set(capability, waniganSessionId);
  return file;
}

export function cleanupHookSettings(waniganSessionId: string): void {
  const reg = registered.get(waniganSessionId);
  registered.delete(waniganSessionId);
  if (reg) capabilitySessions.delete(reg.capability);
  const file = reg?.file ?? path.join(hooksDir(), `${safeName(waniganSessionId)}.json`);
  try { fs.rmSync(file, { force: true }); } catch { /* already gone */ }
}

/** The id becomes a filename, so it must not be able to name a path. */
function safeName(id: string): string {
  const clean = id.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 96);
  return clean || 'session';
}

/**
 * Every file left in the hooks directory by a previous run is dead: the token in
 * it was thrown away when that process exited, and the port belongs to nobody.
 * Sweeping on start keeps stale credentials off disk and stops the directory
 * growing one file per session forever.
 */
function sweepStaleSettings() {
  const dir = hooksDir();
  const bornAt = Date.now() - process.uptime() * 1000;
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    try {
      // Only files older than this process, so a second Wanigan instance does
      // not pull the settings out from under the first one's live sessions.
      if (fs.statSync(file).mtimeMs < bornAt) fs.rmSync(file, { force: true });
    } catch { /* raced with another sweep */ }
  }
}

function hooksEnabled(): boolean {
  try {
    const v = getSetting('hooks', '1');
    return v !== '0' && v !== 'false';
  } catch {
    return true;
  }
}

/* ── request handling ────────────────────────────────────────────────── */

async function onRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  // Nagle would add up to 40ms to every answer, and on PreToolUse the agent is
  // sitting on its hands for exactly that long.
  try { req.socket.setNoDelay(true); } catch { /* socket already closed */ }

  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (req.method !== 'POST' || url.pathname !== '/hook') return reply(res, 404, {});
  const sessionId = sessionForCapability(req.headers.authorization);
  if (!sessionId) return reply(res, 401, {});

  const body = await readBody(req);
  if (!body.ok) return reply(res, body.status, {});
  const input = asHookInput(body.text);
  if (!input) return reply(res, 400, {});

  const at = Date.now();
  const event = clip(str(input.hook_event_name), 64) ?? 'Unknown';

  // Answer first, bookkeep after: a tool call must never wait on a SQLite write.
  if (event === 'PreToolUse') {
    const decision = decide({ ...input, wanigan_session_id: sessionId }, sessionId);
    reply(res, 200, decision
      ? {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: decision.decision,
            permissionDecisionReason: decision.reason,
          },
        }
      : {});
  } else if (event === 'SessionStart') {
    reply(res, 200, await briefing(sessionId));
  } else {
    // A hook that returns nothing is a hook that stays out of the way.
    reply(res, 200, {});
  }

  const stored = store(sessionId, event, input, at);
  if (stored) emit(stored);
  // Claude Code's own lifecycle signal is an additional cleanup path. The
  // session/headless owners call cleanup too, so either a graceful hook end or
  // a process exit revokes the capability and removes the on-disk credential.
  if (event === 'SessionEnd') cleanupHookSettings(sessionId);
}

function reply(res: http.ServerResponse, status: number, body: unknown) {
  if (res.writableEnded) return;
  const json = JSON.stringify(body);
  try {
    res.writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(json),
      // One request per connection: an agent that dies mid-session leaves no
      // half-open socket for the app to wait on at quit.
      connection: 'close',
    });
    res.end(json);
  } catch { /* client hung up first */ }
}

function sessionForCapability(header: string | undefined): string | null {
  const match = typeof header === 'string' ? /^Bearer\s+([A-Za-z0-9_-]{43})$/i.exec(header.trim()) : null;
  if (!match || !CAPABILITY_RE.test(match[1])) return null;

  // All minted capabilities are exactly 32 random bytes in base64url form, so
  // every candidate has the same length and can be compared without a
  // length-or-content short circuit. A map scan is tiny (one entry per live
  // hook-enabled session) and keeps the bearer comparison timing-safe.
  const given = Buffer.from(match[1]);
  let sessionId: string | null = null;
  for (const [capability, candidate] of capabilitySessions) {
    if (timingSafeEqual(given, Buffer.from(capability))) sessionId = candidate;
  }
  if (!sessionId) return null;

  // Deleting/replacing a settings file revokes its old token immediately. Check
  // both indexes so a stale map entry can never be treated as authority.
  const reg = registered.get(sessionId);
  return reg?.capability === match[1] ? sessionId : null;
}

type Body = { ok: true; text: string } | { ok: false; status: number };

function readBody(req: http.IncomingMessage): Promise<Body> {
  return new Promise<Body>((resolve) => {
    let chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (r: Body) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      req.destroy();
      finish({ ok: false, status: 408 });
    }, REQUEST_BUDGET_MS);

    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        // Paused, not destroyed: destroying resets the connection before the
        // 413 can be written, so reply()'s writeHead throws into a swallowing
        // catch and the agent sees a hook transport error instead of a status
        // — for something as ordinary as a PostToolUse carrying a 2MB file.
        // `connection: close` on the reply takes the socket down afterwards.
        req.pause();
        chunks = [];
        finish({ ok: false, status: 413 });
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => finish({ ok: true, text: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', () => finish({ ok: false, status: 400 }));
  });
}

function asHookInput(raw: string): HookInput | null {
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    return v as HookInput;
  } catch {
    return null;
  }
}

/* ── policy ──────────────────────────────────────────────────────────── */

export function setPolicyHook(fn: ((input: HookInput) => PolicyDecision | null) | null): void {
  policy = fn;
}

/**
 * Registers the provider-neutral briefing source without coupling the hook bus
 * to the learning store. A broken or disabled learner is equivalent to no
 * extra context; it can never prevent a session from starting.
 */
export function setLearningBriefingHook(
  fn: ((sessionId: string, context?: LearningBriefingContext) => string | null | Promise<string | null>) | null,
): void {
  learningBriefing = fn;
}

function decide(input: HookInput, sessionId: string): PolicyDecision | null {
  // A run Wanigan launched and owns the lifetime of carries its own context. The
  // headless fan-out has no pane in the live session list for the app's resolver
  // to find, so handing its calls to that resolver would judge a Trusted
  // repository at whatever the default trust level happens to be. It is also the
  // only route that can fail closed, because it is the only one that knows there
  // is nobody there.
  const own = contextForSession(sessionId);
  if (own) return answerFor(own, input);

  const fn = policy;
  if (!fn) return null;
  try {
    return fn(input);
  } catch {
    // A broken rule must not wedge the tool call. No answer hands the decision
    // back to the agent's own permission prompt — which is only a safe default
    // because somebody is sitting in front of it, ready to be annoyed by it. An
    // unattended run never arrives here: it goes through answerFor above, which
    // denies rather than letting the call through unexamined.
    return null;
  }
}

/**
 * SessionStart is the one moment the agent is listening and has nothing to
 * unlearn, so it is where the trust level belongs. The difference is between an
 * agent that works within the constraint and one that finds it by having a Write
 * denied, retrying it, and having it denied again.
 *
 * Nothing is said when no context is registered for the session: naming a trust
 * level would mean guessing which one, and a guessed constraint stated as fact
 * is worse for the agent than silence. That is also why only SessionStart gets
 * an output here — nothing rewrites a tool's input on the way past, because a
 * change nobody can see afterwards is the one kind this app does not make.
 */
async function briefing(sessionId: string): Promise<Record<string, unknown>> {
  try {
    const ctx = contextForSession(sessionId);
    const parts: string[] = [];
    if (ctx) parts.push(trustBriefing(ctx));
    try {
      const learned = (await learningBriefing?.(sessionId, registered.get(sessionId)?.learningContext))?.trim();
      if (learned) parts.push(learned);
    } catch {
      // Learning context is an optimization, never a session dependency.
    }
    if (!parts.length) return {};
    return {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: parts.join('\n\n'),
      },
    };
  } catch {
    // A session that starts without its briefing is a session missing one
    // sentence; one that fails to start is a session missing entirely.
    return {};
  }
}

/* ── storing ─────────────────────────────────────────────────────────── */

type Pending = { at: number };
/**
 * PreToolUse timings, waiting for their PostToolUse. Most CLI versions report
 * duration_ms themselves; when they do not, this is the only way toolStats has
 * a number in it.
 */
const pending = new Map<string, Pending>();
/** A killed agent never sends its PostToolUse. The map cannot grow forever. */
const MAX_PENDING = 500;

let insertStmt: import('better-sqlite3').Statement | null = null;

function store(sessionId: string, event: string, input: HookInput, at: number): SessionEvent | null {
  const toolName = clip(str(input.tool_name), 64);
  const key = `${sessionId}|${str(input.tool_use_id) ?? toolName ?? ''}`;

  let durationMs = typeof input.duration_ms === 'number' && Number.isFinite(input.duration_ms)
    ? Math.round(input.duration_ms)
    : null;

  if (event === 'PreToolUse') {
    if (pending.size >= MAX_PENDING) {
      const oldest = pending.keys().next();
      if (!oldest.done) pending.delete(oldest.value);
    }
    pending.set(key, { at });
  } else if (event === 'PostToolUse' || event === 'PostToolUseFailure') {
    const started = pending.get(key);
    pending.delete(key);
    if (durationMs === null && started) durationMs = at - started.at;
  } else if (event === 'SessionEnd') {
    for (const k of pending.keys()) if (k.startsWith(`${sessionId}|`)) pending.delete(k);
  }

  const summary = summarise(event, input);
  const paths = pathsOf(input.tool_input);
  const ok = okOf(event, input);

  try {
    if (!insertStmt) {
      // One insert per tool call on a hot path; prepare it once.
      insertStmt = db().prepare(`
        INSERT INTO session_events (session_id, at, event, tool_name, summary, duration_ms, ok, paths_json)
        VALUES (?,?,?,?,?,?,?,?)
      `);
    }
    const res = insertStmt.run(
      sessionId, at, event, toolName, summary, durationMs, ok,
      paths.length ? JSON.stringify(paths) : null,
    );
    const stored: SessionEvent = {
      id: Number(res.lastInsertRowid),
      sessionId,
      at,
      event,
      toolName,
      summary,
      durationMs,
      ok: ok === null ? null : ok === 1,
      paths,
    };
    recordGoalTrace({ sessionId, source: 'hook', kind: event, status: ok === 0 ? 'failed' : 'recorded',
      toolName, summary, durationMs, costUsd: 0, inTokens: 0, outTokens: 0, createdAt: at });
    return stored;
  } catch {
    // The timeline losing a row is not worth failing the agent's tool call over.
    return null;
  }
}

function emit(e: SessionEvent) {
  for (const cb of listeners) {
    try { cb(e); } catch { /* one bad subscriber must not stop the rest */ }
  }
}

/**
 * Record a lifecycle fact learned directly from a provider's terminal
 * protocol. Codex exposes completion/approval notifications as OSC 9 rather
 * than posting the HTTP hook envelope used by Claude-compatible harnesses.
 * Feeding both through this store keeps attention, timelines and listeners
 * provider-neutral without retaining prompt or response content.
 */
export function recordProviderEvent(
  sessionId: string,
  event: HookEventName,
  message: string | null = null,
  at: number = Date.now(),
): SessionEvent | null {
  const input: HookInput = {
    hook_event_name: event,
    wanigan_session_id: sessionId,
    ...(message ? { message } : {}),
  };
  const stored = store(sessionId, event, input, at);
  if (stored) emit(stored);
  return stored;
}

export function onHookEvent(cb: (e: SessionEvent) => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/**
 * A short human line for the timeline, built per tool — "the file", "the
 * command", never a blob.
 *
 * What is deliberately absent: the submitted prompt, the subagent's prompt, and
 * tool_response. Wanigan does not put prompt content or model output on disk,
 * and a single tool_response can be an entire source file.
 */
function summarise(event: string, input: HookInput): string | null {
  if (event === 'Notification') return clip(str(input.message), MAX_SUMMARY);
  // UserPromptSubmit carries the prompt and nothing else worth keeping. That the
  // turn happened, and when, is the whole record.
  if (event === 'UserPromptSubmit') return null;

  const ti = input.tool_input ?? {};
  switch (input.tool_name) {
    case 'Bash':
    case 'BashOutput':
      return clip(str(ti.command) ?? str(ti.description), MAX_SUMMARY);
    case 'Task':
      return clip(str(ti.subagent_type) ?? str(input.agent_type) ?? str(ti.description), MAX_SUMMARY);
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return tail(firstPath(ti));
    case 'Grep':
    case 'Glob':
      return clip(str(ti.pattern), MAX_SUMMARY);
    case 'WebFetch':
    case 'WebSearch':
      return clip(str(ti.url) ?? str(ti.query), MAX_SUMMARY);
  }

  const p = firstPath(ti);
  if (p) return tail(p);
  return clip(str(ti.command) ?? str(ti.description) ?? str(input.message), MAX_SUMMARY);
}

const PATH_KEYS = ['file_path', 'path', 'notebook_path'] as const;

function pathsOf(ti: Record<string, unknown> | undefined): string[] {
  if (!ti) return [];
  const out: string[] = [];
  for (const k of PATH_KEYS) {
    const v = str(ti[k]);
    if (v && !out.includes(v)) out.push(v.slice(0, MAX_PATH));
  }
  return out;
}

function firstPath(ti: Record<string, unknown>): string | null {
  for (const k of PATH_KEYS) {
    const v = str(ti[k]);
    if (v) return v;
  }
  return null;
}

function okOf(event: string, input: HookInput): 0 | 1 | null {
  switch (event) {
    case 'PostToolUseFailure':
    case 'PermissionDenied':
    case 'StopFailure':
      return 0;
    case 'PostToolUse': {
      // A tool can fail and still report PostToolUse; the envelope says so
      // without us reading a byte of the response body.
      const r = input.tool_response;
      if (r && typeof r === 'object' && !Array.isArray(r)) {
        const isError = (r as Record<string, unknown>).is_error;
        if (isError === true) return 0;
      }
      return 1;
    }
    case 'Stop':
    case 'PostCompact':
    case 'SubagentStop':
      return 1;
    default:
      return null;
  }
}

function str(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t : null;
}

function clip(v: string | null, max: number): string | null {
  if (!v) return null;
  const flat = v.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Paths are identified by their end, so a long one keeps its tail. */
function tail(v: string | null): string | null {
  if (!v) return null;
  return v.length > MAX_SUMMARY ? `…${v.slice(-(MAX_SUMMARY - 1))}` : v;
}

/* ── reading ─────────────────────────────────────────────────────────── */

type Row = {
  id: number;
  session_id: string;
  at: number;
  event: string;
  tool_name: string | null;
  summary: string | null;
  duration_ms: number | null;
  ok: number | null;
  paths_json: string | null;
};

function toEvent(r: Row): SessionEvent {
  return {
    id: r.id,
    sessionId: r.session_id,
    at: r.at,
    event: r.event,
    toolName: r.tool_name,
    summary: r.summary,
    durationMs: r.duration_ms,
    ok: r.ok === null ? null : r.ok === 1,
    paths: parsePaths(r.paths_json),
  };
}

function parsePaths(json: string | null): string[] {
  if (!json) return [];
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

/** Newest first, matching every other event log in the app. */
export function sessionEvents(sessionId: string, limit = 200): SessionEvent[] {
  const n = Math.min(Math.max(Math.trunc(limit) || 1, 1), 2000);
  const rows = db().prepare(`
    SELECT id, session_id, at, event, tool_name, summary, duration_ms, ok, paths_json
    FROM session_events WHERE session_id = ? ORDER BY at DESC, id DESC LIMIT ?
  `).all(sessionId, n) as Row[];
  return rows.map(toEvent);
}

/**
 * What the session is doing right now, for the attention queue.
 *
 * The tool in flight is the most recent PreToolUse with no PostToolUse after it.
 * Pairing is by tool name rather than tool_use_id because the id is not on every
 * event, and a Stop closes the scan: a hook lost to a killed agent would
 * otherwise leave a tool "in flight" for the rest of the session.
 */
export function liveState(sessionId: string): {
  tool: string | null; since: number; blocked: boolean; lastAt: number | null;
} {
  const rows = db().prepare(`
    SELECT event, tool_name, summary, at FROM session_events
    WHERE session_id = ? ORDER BY id DESC LIMIT ?
  `).all(sessionId, LIVE_WINDOW) as {
    event: string; tool_name: string | null; summary: string | null; at: number;
  }[];

  if (!rows.length) return { tool: null, since: 0, blocked: false, lastAt: null };

  const latest = rows[0];
  // Not every CLI version emits PermissionRequest; the ones that don't send a
  // Notification instead, and a session waiting on a human is exactly the state
  // the queue exists to surface.
  const blocked = latest.event === 'PermissionRequest'
    || (latest.event === 'Notification' && WAITING.test(latest.summary ?? ''));

  const closed = new Map<string, number>();
  let tool: string | null = null;
  let toolAt: number | null = null;

  for (const r of rows) {
    if (r.event === 'PostToolUse' || r.event === 'PostToolUseFailure') {
      const k = r.tool_name ?? '';
      closed.set(k, (closed.get(k) ?? 0) + 1);
    } else if (r.event === 'PreToolUse') {
      const k = r.tool_name ?? '';
      const n = closed.get(k) ?? 0;
      if (n > 0) { closed.set(k, n - 1); continue; }
      tool = r.tool_name;
      toolAt = r.at;
      break;
    } else if (r.event === 'Stop' || r.event === 'SessionEnd') {
      break;
    }
  }

  return {
    tool,
    since: blocked ? latest.at : (toolAt ?? latest.at),
    blocked,
    lastAt: latest.at,
  };
}

const WAITING = /permission|waiting for your input|needs your|approve|confirm/i;

/**
 * Completed calls only — a tool still in flight has no duration to report.
 * Ordered by time spent: that is the question a tool table gets asked.
 */
export function toolStats(sessionId: string): {
  toolName: string; calls: number; totalMs: number; failures: number;
}[] {
  const rows = db().prepare(`
    SELECT tool_name,
           COUNT(*)                                  AS calls,
           COALESCE(SUM(duration_ms), 0)             AS total_ms,
           SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END)   AS failures
    FROM session_events
    WHERE session_id = ? AND tool_name IS NOT NULL
      AND event IN ('PostToolUse', 'PostToolUseFailure')
    GROUP BY tool_name
    ORDER BY total_ms DESC, calls DESC
  `).all(sessionId) as {
    tool_name: string; calls: number; total_ms: number; failures: number | null;
  }[];

  return rows.map((r) => ({
    toolName: r.tool_name,
    calls: Number(r.calls),
    totalMs: Number(r.total_ms),
    failures: Number(r.failures ?? 0),
  }));
}

/** Retention. Returns how many rows went. */
export function pruneEvents(olderThanMs: number): number {
  const age = Number.isFinite(olderThanMs) ? Math.max(0, olderThanMs) : 0;
  const res = db().prepare('DELETE FROM session_events WHERE at < ?').run(Date.now() - age);
  return res.changes;
}
