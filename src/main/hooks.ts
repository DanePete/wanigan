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
import type {
  HookEventName, HookInput, LoadedInstruction, PolicyDecision, SessionEvent,
} from '../shared/types';

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
/** Told when a PostModelSwitch says the session is running a different model. */
let modelSwitch: ((sessionId: string, model: string) => void) | null = null;
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
  /** The event names this session's settings file asked for. */
  events: HookEventName[];
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

/**
 * Events the CLI learned after the base set above. Each is asked for only from
 * a CLI whose reported version is at or past the release that introduced it —
 * the rejection rule above means an older binary must never see the name, and
 * "hooks silently off" is exactly the failure that rule exists to prevent.
 * `since` is the changelog entry; `probed` is the binary on which Wanigan
 * actually found the string, which is the fact the gate rests on. A launch
 * with no version reading gets the base set only.
 *
 * Every field name the summaries below read was taken off the payload schemas
 * carried in the 2.1.263 binary rather than out of the published docs (checked
 * 2026-09-07). That is not pedantry: the docs give DirectoryAdded a
 * `directory_path`, and the CLI sends `directory`. Following the docs there
 * would have written a row that named no directory at all.
 *
 * Deliberately still not asked for, so the absences are decisions rather than
 * oversights:
 *   · MessageDisplay — assistant message text. Wanigan does not put model
 *     output on disk, and this event is nothing else.
 *   · FileChanged — its matcher takes literal filenames, so it means "watch
 *     these files". Wanigan has no such list, and `*` is not that event.
 *   · Setup — fires only for --init / --init-only / --maintenance, which no
 *     launch path here passes.
 *   · PreModelSwitch, PostToolBatch, UserPromptExpansion — the first can block
 *     a switch the Post half already reports; the other two carry no changelog
 *     entry to gate on and no surface here that would read them.
 */
export const VERSION_GATED_EVENTS: readonly { event: HookEventName; since: string; probed: string }[] = [
  {
    // Changelog 2.1.69: "Added `InstructionsLoaded` hook event that fires when
    // CLAUDE.md or `.claude/rules/*.md` files are loaded into context". The
    // 2.1.261 binary installed here carries the name plus `file_path`,
    // `memory_type` and `load_reason` (checked 2026-09-05). Versions between
    // the two were not probed; the changelog is what admits them.
    event: 'InstructionsLoaded', since: '2.1.69', probed: '2.1.261',
  },
  {
    // Changelog 2.0.43: "Added the `SubagentStart` hook event". The pair is
    // gated together on that release rather than on SubagentStop's own, older
    // one, because 2.0.42 is what "Added `agent_id` and `agent_transcript_path`
    // fields to `SubagentStop` hooks" — and `agent_id` is the field `store`
    // pairs a start with its stop by. A CLI that sent SubagentStop without it
    // would report every subagent as still running.
    //
    // In the 2.1.263 binary installed here (checked 2026-09-07): the name sits
    // in the CLI's own event list beside InstructionsLoaded, it dispatches
    // through `executeSubagentStartHooks`, and `agent_id` and `agent_type` are
    // both present.
    event: 'SubagentStart', since: '2.0.43', probed: '2.1.263',
  },
  {
    // Same binary carries "Converting Stop hook to SubagentStop for … (subagents
    // trigger SubagentStop)", so this half runs through the Stop dispatcher
    // rather than one of its own — which is why looking for an
    // `executeSubagentStopHooks` finds nothing and proves nothing.
    event: 'SubagentStop', since: '2.0.43', probed: '2.1.263',
  },
  {
    // Changelog 2.1.251: "Added `PreModelSwitch` and `PostModelSwitch` hook
    // events (block, confirm, or annotate a model switch)". Only the Post half
    // is asked for. PreModelSwitch can block a switch, and a recorder that can
    // block is a recorder that can wedge a session when this listener is busy.
    //
    // The 2.1.263 binary carries the string "PostModelSwitch hooks failed: " —
    // the CLI reporting on hooks it ran — and `from_model` / `to_model` next to
    // "model switch blocked by a PreModelSwitch hook". What is NOT verified
    // end to end is a live session posting one of these to this listener; the
    // shape below is read off the binary and the changelog, not off a run.
    event: 'PostModelSwitch', since: '2.1.251', probed: '2.1.263',
  },

  // Where the session may reach, changing under Wanigan. These are the events
  // the trust model was always implicitly about: `roots` decides what a session
  // is allowed to touch at launch, and until now nothing told Wanigan when the
  // session moved. Schemas in the 2.1.263 binary: CwdChanged {old_cwd,new_cwd},
  // DirectoryAdded {directory,source}, ConfigChange {source,file_path?}.
  { event: 'ConfigChange', since: '2.1.49', probed: '2.1.263' },
  { event: 'CwdChanged', since: '2.1.83', probed: '2.1.263' },
  { event: 'DirectoryAdded', since: '2.1.219', probed: '2.1.263' },

  // An MCP server asking the operator a question. Schemas:
  // Elicitation {mcp_server_name,message,mode?,url?,elicitation_id?} and
  // ElicitationResult {mcp_server_name,action,elicitation_id?,mode?,content?}.
  // `content` is the operator's typed answer and is never read here.
  { event: 'Elicitation', since: '2.1.76', probed: '2.1.263' },
  { event: 'ElicitationResult', since: '2.1.76', probed: '2.1.263' },

  // Agent teams. TaskCompleted and TeammateIdle arrived together in 2.1.33;
  // TaskCreated is a separate, much later release and is gated on its own, or a
  // 2.1.33 CLI would be handed a name it does not know and drop the whole file.
  { event: 'TaskCompleted', since: '2.1.33', probed: '2.1.263' },
  { event: 'TeammateIdle', since: '2.1.33', probed: '2.1.263' },
  { event: 'TaskCreated', since: '2.1.84', probed: '2.1.263' },

  // Worktrees the CLI makes for itself under --worktree or background sessions,
  // which are not the ones worktrees.ts owns. WorktreeCreate carries {name} and
  // WorktreeRemove carries {worktree_path} — a name on one side and a path on
  // the other, so they are summarised apart rather than through one field.
  { event: 'WorktreeCreate', since: '2.1.50', probed: '2.1.263' },
  { event: 'WorktreeRemove', since: '2.1.50', probed: '2.1.263' },
];

export type HookSettingsOptions = {
  /**
   * The CLI's `--version` line as probed at launch, e.g. "2.1.261 (Claude
   * Code)". Null or absent means the probe failed or the caller does not know,
   * and unknown earns the base event set only.
   */
  cliVersion?: string | null;
};

/** The leading dotted triple of a `--version` line; null when there is none. */
export function parseCliVersion(line: string | null | undefined): [number, number, number] | null {
  const m = typeof line === 'string' ? /(\d+)\.(\d+)\.(\d+)/.exec(line) : null;
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function versionAtLeast(have: [number, number, number], want: [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) {
    if (have[i] !== want[i]) return have[i] > want[i];
  }
  return true;
}

/** Exactly the event names a settings file written for this CLI version asks for. */
export function hookEventsFor(cliVersion: string | null | undefined): HookEventName[] {
  const out = [...SETTINGS_EVENTS];
  const have = parseCliVersion(cliVersion);
  if (!have) return out;
  for (const gated of VERSION_GATED_EVENTS) {
    const want = parseCliVersion(gated.since);
    if (want && versionAtLeast(have, want)) out.push(gated.event);
  }
  return out;
}

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
  options: HookSettingsOptions = {},
): string | null {
  if (!hooksEnabled()) return null;
  const live = info;
  if (!live) return null;

  let capability = randomBytes(32).toString('base64url');
  while (capabilitySessions.has(capability)) capability = randomBytes(32).toString('base64url');
  const url = `http://127.0.0.1:${live.port}/hook`;
  const handler = { type: 'http', url, headers: { Authorization: `Bearer ${capability}` } };

  const events = hookEventsFor(options.cliVersion);
  const hooks: Record<string, unknown[]> = {};
  for (const ev of events) {
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
  registered.set(waniganSessionId, { file, projectPath, capability, learningContext, events });
  capabilitySessions.set(capability, waniganSessionId);
  return file;
}

/**
 * Which events a LIVE session's settings file asked for, or null once its
 * registration is gone. Process-local on purpose: the answer for a finished
 * session is not recorded anywhere, and "not wired for InstructionsLoaded" and
 * "wired, and nothing loaded" must not be told apart by guessing.
 */
export function registeredHookEvents(waniganSessionId: string): HookEventName[] | null {
  const reg = registered.get(waniganSessionId);
  return reg ? [...reg.events] : null;
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

/**
 * SessionEnd does not always mean the CLI is finished. `/clear` and an
 * in-session resume end the *conversation* and keep the same process running —
 * claude 2.1.252 posts SessionEnd with reason `clear` from its /clear handler
 * and `resume` from its in-place session swap, then carries on. Tearing the
 * registration down there revokes a live session's capability with nothing left
 * to re-register it: every later hook from that run arrives unauthenticated and
 * is dropped, for the rest of the run.
 */
const SESSION_CONTINUES = new Set(['clear', 'resume']);

/**
 * Why SessionEnd fired. HookInput does not model the field and the body is
 * agent-supplied, so it is read defensively; an absent or unrecognised reason
 * is treated as a real end, which is what the CLI's other four reasons
 * (logout, prompt_input_exit, other, and anything a future version adds) are.
 */
function endReason(input: HookInput): string | null {
  return str((input as { reason?: unknown }).reason);
}

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
            // Signed, so an agent (or its operator) reading the verdict knows
            // which layer produced it instead of hunting through CLI hooks,
            // plugins and permission modes for a rule that lives in none of them.
            permissionDecisionReason: `Wanigan: ${decision.reason}`,
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
  // Claude Code's own lifecycle signal is an additional cleanup path, never the
  // authoritative one: the session/headless owners call cleanup when the process
  // exits, and stopHookServer sweeps the rest. So a SessionEnd the process
  // outlives is left registered — the credential it keeps for another few
  // seconds is bounded, and dropping it costs the session its whole timeline.
  if (event === 'SessionEnd' && !SESSION_CONTINUES.has(endReason(input) ?? '')) {
    cleanupHookSettings(sessionId);
  }
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

/**
 * Registers the sink that learns a session's model changed under it.
 *
 * A callback rather than a direct call because sessions.ts already imports this
 * module, and the record it owns is the one that has to be corrected. The
 * argument is the model the CLI says it is running now — an observation, not an
 * instruction: nothing is written to the PTY on the strength of it.
 */
export function setModelSwitchHook(fn: ((sessionId: string, model: string) => void) | null): void {
  modelSwitch = fn;
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
  // A subagent pairs on its own id in its own namespace. It has to: a
  // SubagentStart carries neither tool_use_id nor tool_name, so the tool key
  // below collapses every one of them onto `<session>|`, and with three
  // subagents in flight — routine now — the first stop to arrive would close
  // the wrong span and the other two would never close at all.
  const subagentPair = event === 'SubagentStart' || event === 'SubagentStop';
  // No id, no pairing. Writing an unkeyed subagent into the shared tool slot is
  // how it would start reporting durations for Bash.
  const agentKey = subagentPair ? str(input.agent_id) : null;
  const key = agentKey
    ? `${sessionId}|agent:${agentKey}`
    : `${sessionId}|${str(input.tool_use_id) ?? toolName ?? ''}`;

  let durationMs = typeof input.duration_ms === 'number' && Number.isFinite(input.duration_ms)
    ? Math.round(input.duration_ms)
    : null;

  if (event === 'PreToolUse' || (event === 'SubagentStart' && agentKey)) {
    if (pending.size >= MAX_PENDING) {
      const oldest = pending.keys().next();
      if (!oldest.done) pending.delete(oldest.value);
    }
    pending.set(key, { at });
  } else if (event === 'PostToolUse' || event === 'PostToolUseFailure'
    || (event === 'SubagentStop' && agentKey)) {
    const started = pending.get(key);
    pending.delete(key);
    if (durationMs === null && started) durationMs = at - started.at;
  } else if (event === 'SessionEnd') {
    for (const k of pending.keys()) if (k.startsWith(`${sessionId}|`)) pending.delete(k);
  }

  const summary = summarise(event, input);
  // An InstructionsLoaded body names its file at the top level, not under a
  // tool_input, and the path is the whole record: it is what the Context view
  // reconciles its prediction against. Four lifecycle events since do the same.
  const paths = eventPaths(event, input);
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
    bumpRevision(sessionId);
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
    if (event === 'PostModelSwitch') {
      // The row above is the evidence; this is the correction it implies. Kept
      // inside its own try because a stale model field is a smaller wrong than
      // an agent whose turn died on Wanigan's bookkeeping.
      const to = modelSwitchTarget(summary);
      if (to) { try { modelSwitch?.(sessionId, to); } catch { /* recorded either way */ } }
    }
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
  if (event === 'InstructionsLoaded') return loadedSummary(input);
  // UserPromptSubmit carries the prompt and nothing else worth keeping. That the
  // turn happened, and when, is the whole record.
  if (event === 'UserPromptSubmit') return null;
  // Which kind of subagent, never what it was asked or what it answered. A
  // SubagentStop body carries `last_assistant_message`, which is model output;
  // reading `agent_type` and nothing else is what keeps this row a fact about
  // the run rather than a copy of the work.
  if (event === 'SubagentStart' || event === 'SubagentStop') {
    return clip(str(input.agent_type), MAX_SUMMARY);
  }
  if (event === 'PostModelSwitch') return modelSwitchSummary(input);
  switch (event) {
    // Both ends, because "moved to /tmp" and "moved from the project root to
    // /tmp" are different facts and only the second one is worth an alarm.
    case 'CwdChanged':
      return pair(tail(str(input.old_cwd)), tail(str(input.new_cwd)));
    // How it was added is the half that matters: /add-dir is a person, and
    // register_repo_root is the SDK doing it without one.
    case 'DirectoryAdded':
      return pair(clip(str(input.source), 32), tail(str(input.directory)));
    // Which settings layer moved. The file path rides in `paths` below.
    case 'ConfigChange':
      return pair(clip(str(input.source), 32), tail(str(input.file_path)));
    // The server's own question to the operator. Not model output and not a
    // prompt — the same kind of text a Notification already carries.
    case 'Elicitation':
      return pair(clip(str(input.mcp_server_name), 40), clip(str(input.message), MAX_SUMMARY));
    // The verdict only. `content` is what the operator typed and is not read.
    case 'ElicitationResult':
      return pair(clip(str(input.mcp_server_name), 40), clip(str(input.action), 16));
    case 'TeammateIdle':
      return clip(str(input.teammate_name), MAX_SUMMARY);
    case 'TaskCreated':
    case 'TaskCompleted':
      return pair(clip(str(input.teammate_name), 40), clip(str(input.task_subject), MAX_SUMMARY));
    // A name on one side and a path on the other; the CLI sends exactly that.
    case 'WorktreeCreate':
      return clip(str(input.name), MAX_SUMMARY);
    case 'WorktreeRemove':
      return tail(str(input.worktree_path));
  }

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

/**
 * `<memory_type> · <load_reason> — <path tail>`, encoded here and decoded by
 * parseLoadedSummary, so which slot a file filled and why it loaded survive in
 * the row without a schema change. paths_json stays the authoritative path;
 * the summary is what the Timeline prints and what the decoder reads back.
 */
const LOADED_SEP = ' — ';
const LOADED_UNKNOWN = '?';

function loadedSummary(input: HookInput): string {
  const why = `${clip(str(input.memory_type), 24) ?? LOADED_UNKNOWN} · ${clip(str(input.load_reason), 24) ?? LOADED_UNKNOWN}`;
  const file = tail(str(input.file_path), MAX_SUMMARY - why.length - LOADED_SEP.length) ?? '(no path)';
  return `${why}${LOADED_SEP}${file}`;
}

function parseLoadedSummary(summary: string | null): { memoryType: string | null; loadReason: string | null } {
  const m = summary ? /^([^·]*) · ([^—]*)(?: — |$)/.exec(summary) : null;
  const value = (v: string | undefined): string | null => {
    const t = (v ?? '').trim();
    return !t || t === LOADED_UNKNOWN ? null : t;
  };
  return m ? { memoryType: value(m[1]), loadReason: value(m[2]) } : { memoryType: null, loadReason: null };
}

function instructionPaths(input: HookInput): string[] {
  const p = str(input.file_path);
  return p ? [p.slice(0, MAX_PATH)] : [];
}

/**
 * The paths an event is about, which for most of them means the paths its tool
 * call named.
 *
 * The lifecycle events below name theirs at the top level instead, each under
 * its own key, and the path is the whole point of the row: a session that
 * changed directory or was handed a new root has moved outside what `roots`
 * decided at launch, and a row that recorded only *that* it moved would leave
 * the one fact worth reconciling in a summary string. `paths_json` is where
 * every other surface already looks for a path.
 */
function eventPaths(event: string, input: HookInput): string[] {
  const one = (v: string | null | undefined) => (v && v.trim() ? [v.trim().slice(0, MAX_PATH)] : []);
  switch (event) {
    case 'InstructionsLoaded': return instructionPaths(input);
    // Where it landed. The place it left is in the summary; this column is for
    // the path a later read would have to check.
    case 'CwdChanged': return one(input.new_cwd);
    case 'DirectoryAdded': return one(input.directory);
    case 'ConfigChange': return one(input.file_path);
    case 'WorktreeRemove': return one(input.worktree_path);
    default: return pathsOf(input.tool_input);
  }
}

/**
 * `<from> → <to>`, or just the new model when the CLI did not name the old one.
 *
 * Encoded here and decoded by `modelSwitchTarget` for the same reason
 * loadedSummary is: the row keeps both halves without a schema change, and the
 * side that writes the string is the side that reads it back.
 */
const SWITCH_SEP = ' → ';
/**
 * Separates the models from why they changed. Safe as a delimiter because a
 * model id cannot contain a space — sessions.ts's MODEL_ID is the same rule the
 * write-back validates against, so the target below can never swallow a source.
 */
const SWITCH_WHY = ' · ';
const MAX_MODEL = 64;

/**
 * `<from> → <to> · <source>`.
 *
 * The source is the half worth having. The CLI's own wording for it is
 * "automatic fallback or other programmatic change" for `auto` and
 * "model restored while resuming a session" for `resume` — neither of which any
 * operator typed, and both of which used to leave the record naming the model
 * from the launch argv.
 */
function modelSwitchSummary(input: HookInput): string | null {
  const to = clip(str(input.to_model), MAX_MODEL);
  if (!to) return null;
  const from = clip(str(input.from_model), MAX_MODEL);
  const why = clip(str(input.source), 24);
  const models = from ? `${from}${SWITCH_SEP}${to}` : to;
  return why ? `${models}${SWITCH_WHY}${why}` : models;
}

/** The model a PostModelSwitch row says the session ended up on. */
export function modelSwitchTarget(summary: string | null): string | null {
  if (!summary) return null;
  const i = summary.lastIndexOf(SWITCH_SEP);
  const after = i === -1 ? summary : summary.slice(i + SWITCH_SEP.length);
  const j = after.indexOf(SWITCH_WHY);
  const to = (j === -1 ? after : after.slice(0, j)).trim();
  return to || null;
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
    // The only new event with a verdict in it. Declining or cancelling an MCP
    // server's request is not a failure of the session, but it is the answer
    // being no, and a timeline that drew it the same green as an accept would
    // be hiding the more interesting of the two.
    case 'ElicitationResult': {
      const action = str(input.action);
      if (action === 'accept') return 1;
      if (action === 'decline' || action === 'cancel') return 0;
      return null;
    }
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
function tail(v: string | null, max: number = MAX_SUMMARY): string | null {
  if (!v) return null;
  return v.length > max ? `…${v.slice(-(max - 1))}` : v;
}

/**
 * `<a> — <b>`, or whichever half exists, or null when neither does.
 *
 * Every new event summarised above is two facts — a server and its question, a
 * layer and its file, where the session was and where it went. Joining them
 * here rather than per case means one of them going missing degrades to the
 * other rather than to the string "null — /tmp".
 */
function pair(a: string | null, b: string | null): string | null {
  if (a && b) return clip(`${a}${LOADED_SEP}${b}`, MAX_SUMMARY);
  return a || b || null;
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

/* ── change tracking ─────────────────────────────────────────────────── */

/**
 * A stamp that changes whenever a session's event rows change.
 *
 * The attention queue reads about four hundred rows to classify one session —
 * a two-hundred-event tail plus the live-state window — and it classifies on
 * every hook event and every poll. Most of those reads answer a question whose
 * inputs have not moved since the last one. Values only ever increase, so a
 * stamp a caller still holds is proof the rows behind it are the same rows.
 */
let revisionClock = 0;
/** What a session with no entry of its own reads. */
let revisionFloor = 0;
const revisions = new Map<string, number>();
/** One small number per session id seen this run; flushed rather than grown. */
const MAX_REVISIONS = 1000;

function bumpRevision(sessionId: string): void {
  if (revisions.size >= MAX_REVISIONS) resetRevisions();
  revisions.set(sessionId, ++revisionClock);
}

/**
 * Retire every stamp at once. The floor is taken from the same clock, so each
 * session reads a value it has never read before and no cache built on an
 * older one can survive — which is what a delete across all sessions needs.
 */
function resetRevisions(): void {
  revisions.clear();
  revisionFloor = ++revisionClock;
}

export function eventsRevision(sessionId: string): number {
  return revisions.get(sessionId) ?? revisionFloor;
}

/**
 * The instruction files one session's CLI reported loading, oldest first so
 * the order is the order they entered context. Only sessions launched with a
 * CLI past the VERSION_GATED_EVENTS threshold ever have rows here; for the
 * rest this is empty, which is not the same as "nothing loaded".
 */
export function instructionsLoaded(sessionId: string, limit = 500): LoadedInstruction[] {
  const n = Math.min(Math.max(Math.trunc(limit) || 1, 1), 5000);
  const rows = db().prepare(`
    SELECT at, summary, paths_json FROM session_events
    WHERE session_id = ? AND event = 'InstructionsLoaded' ORDER BY at ASC, id ASC LIMIT ?
  `).all(sessionId, n) as { at: number; summary: string | null; paths_json: string | null }[];
  const out: LoadedInstruction[] = [];
  for (const r of rows) {
    const p = parsePaths(r.paths_json)[0];
    if (!p) continue;
    out.push({ sessionId, at: r.at, path: p, ...parseLoadedSummary(r.summary) });
  }
  return out;
}

/**
 * Sessions of one project that recorded at least one InstructionsLoaded row,
 * newest first. The join is on session_log, which the session owner writes
 * under the same id the hook settings were registered with.
 */
export function instructionsLoadedSessions(projectId: string, limit = 5): { sessionId: string; at: number }[] {
  const n = Math.min(Math.max(Math.trunc(limit) || 1, 1), 50);
  return db().prepare(`
    SELECT e.session_id AS sessionId, MAX(e.at) AS at
    FROM session_events e JOIN session_log s ON s.id = e.session_id
    WHERE s.project_id = ? AND e.event = 'InstructionsLoaded'
    GROUP BY e.session_id ORDER BY at DESC LIMIT ?
  `).all(projectId, n) as { sessionId: string; at: number }[];
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
 *
 * Ordered by `at`, not by `id`, so idx_session_events(session_id, at DESC)
 * serves the read. `ORDER BY id DESC` cannot use that index: SQLite sorted the
 * session's whole history into a temporary b-tree to answer a question about
 * its newest two hundred rows, on every hook event and every poll, at a cost
 * that grew for as long as the session lived. `id DESC` stays as the tie-break,
 * so rows sharing a millisecond keep insertion order and this reads in the same
 * order as sessionEvents().
 */
export function liveState(sessionId: string): {
  tool: string | null; since: number; blocked: boolean; lastAt: number | null;
} {
  const rows = db().prepare(`
    SELECT event, tool_name, summary, at FROM session_events
    WHERE session_id = ? ORDER BY at DESC, id DESC LIMIT ?
  `).all(sessionId, LIVE_WINDOW) as {
    event: string; tool_name: string | null; summary: string | null; at: number;
  }[];

  if (!rows.length) return { tool: null, since: 0, blocked: false, lastAt: null };

  const latest = rows[0];
  // An outstanding question, not "the newest row is a question". A blocked
  // session keeps receiving events — a second notification, a lifecycle ping —
  // and reading rows[0] alone let the first of them clear the asking state while
  // the prompt was still on the human's screen. That is the one state this queue
  // exists to make impossible to miss, so it stands until something answers it,
  // and `since` is when the human was asked rather than when we noticed.
  let askedAt: number | null = null;
  for (const r of rows) {
    if (ANSWERED.has(r.event)) break;
    // Not every CLI version emits PermissionRequest; the ones that don't send a
    // Notification instead. An Elicitation is the third spelling of the same
    // state: an MCP server has put a question on the operator's screen and the
    // run is standing still until it is answered. It was invisible here, so a
    // session blocked that way ranked as a session quietly working.
    if (r.event === 'PermissionRequest' || r.event === 'Elicitation'
      || (r.event === 'Notification' && WAITING.test(r.summary ?? ''))) {
      askedAt = r.at;
      break;
    }
  }
  const blocked = askedAt !== null;

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
    since: askedAt ?? toolAt ?? latest.at,
    blocked,
    lastAt: latest.at,
  };
}

const WAITING = /permission|waiting for your input|needs your|approve|confirm/i;

/**
 * Events that settle an outstanding permission request. The human's verdict is
 * the obvious one; the rest are the run moving on without needing it — the call
 * completing, the next call starting, the turn ending. PreToolUse belongs here
 * because a request is raised for a call the CLI has already announced, so a
 * PreToolUse *newer* than the request is the next call rather than the one being
 * asked about. Anything not named here — another notification, an event a future
 * CLI adds — leaves the question standing, which is the safe direction to err in.
 */
const ANSWERED = new Set<string>([
  'PermissionResponse', 'PermissionDenied', 'PreToolUse', 'PostToolUse',
  'PostToolUseFailure', 'UserPromptSubmit', 'Stop', 'StopFailure',
  'SessionStart', 'SessionEnd', 'PreCompact', 'PostCompact',
  // The operator answering an MCP server settles that question and no other,
  // but it settles it the same way a permission answer does.
  'ElicitationResult',
]);

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

/** How many rows one statement may delete before the caller gets its tick back. */
const PRUNE_CHUNK = 20_000;
/** And how long the whole pass may spend. The main process is pumping PTYs. */
const PRUNE_BUDGET_MS = 250;

/**
 * Retention. Returns how many rows went.
 *
 * Deleted in bounded slices rather than one statement. This table has never
 * been pruned, so the first pass on an existing install can meet a year of
 * history at four thousand rows a day, and a multi-second DELETE on the main
 * process stalls every terminal it is pumping. Whatever a pass does not reach
 * is deleted by the next one, and steady state is one small slice.
 *
 * The subquery names the timestamp one slice in, so each statement is served by
 * idx_session_events_at and stops there; with less than a slice left it falls
 * back to the cutoff and finishes the job.
 */
export function pruneEvents(olderThanMs: number, budgetMs: number = PRUNE_BUDGET_MS): number {
  const age = Number.isFinite(olderThanMs) ? Math.max(0, olderThanMs) : 0;
  const cutoff = Date.now() - age;
  const budget = Number.isFinite(budgetMs) ? Math.max(0, budgetMs) : PRUNE_BUDGET_MS;
  const until = Date.now() + budget;
  const d = db();
  const slice = d.prepare(`
    DELETE FROM session_events
    WHERE at < COALESCE(
      (SELECT at FROM session_events WHERE at < ? ORDER BY at LIMIT 1 OFFSET ?), ?)
  `);
  const rest = d.prepare('DELETE FROM session_events WHERE at < ?');

  let total = 0;
  for (;;) {
    const res = slice.run(cutoff, PRUNE_CHUNK, cutoff);
    total += res.changes;
    if (res.changes === 0) {
      // Nothing to slice, or every remaining row shares one timestamp and the
      // slice boundary cannot advance past it. Either way this finishes it.
      total += rest.run(cutoff).changes;
      break;
    }
    if (Date.now() >= until) break;
  }
  // Deleted rows are a change no per-session bump describes, so every cached
  // read of this table is retired at once.
  if (total) resetRevisions();
  return total;
}
