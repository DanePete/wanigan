import type { IPty } from 'node-pty';
import { BrowserWindow } from 'electron';
import type { LaunchOptions, Session, ProviderId } from '../shared/types';
import { EFFORT_LEVELS } from '../shared/types';
import {
  providerById, shellPath, detectProviders, refreshProviderPacks, runsClaudeCli, usesAnthropicAccount,
} from './providers';
import { projectById } from './store';
import { db } from './db';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { PastSession } from '../shared/types';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Baseline, BudgetState, TrustLevel } from '../shared/types';
import { otelEnv } from './otel';
import * as accounts from './accounts';
import { writeHookSettings, cleanupHookSettings, recordProviderEvent } from './hooks';
import { finalizeSessionCheckpoints, forgetSessionCheckpoints, registerSessionCheckpoints } from './checkpoints';
import { archiveSession } from './transcripts';
import { createWorktree, removeWorktree, repoRootFor } from './worktrees';
import { trustFor } from './policy';
import { slots } from './queue';
import { budgetBreached } from './spend';
import { cleanupMcpConfig, writeMcpConfig } from './mcp/registry';
import { noteOutput, forgetSession } from './attention';
import { flags, learningSettings } from './settings';
import { attachmentsDir, cleanupSessionAttachments, markSessionAttachmentsSent, prepareAttachmentDir } from './attachments';
import { redactCredentials } from './redact';
import { buildBriefing, recordSessionBriefing } from './learning';
import {
  assertCodexThreadWriterUnlocked, backfillCodexThreadIds, captureNewCodexThreadId,
  codexThreadIdForSession, discoverCodexThreadId, normalizeCodexThreadId, validateExactCodexThread,
} from './codex-sessions';

const exec = promisify(execFile);

/** Main owns notification policy; the PTY manager only reports the lifecycle fact. */
let exitObserver: ((session: Session) => void) | null = null;

export function setSessionExitObserver(observer: ((session: Session) => void) | null): void {
  exitObserver = observer;
}

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
 * How much of a launch prompt session_log keeps.
 *
 * The row exists to answer "what was this started to do", which is a sentence
 * or a paragraph. A pasted file is not that, and this column is read back into
 * history views and carried out of the app by every export and backup.
 */
const INITIAL_PROMPT_MAX = 4_096;
// PTY traffic is deliberately fire-and-forget, so bound it where it crosses
// into node-pty. A compromised renderer must not turn one IPC message into an
// unbounded write queue or an absurd terminal geometry allocation.
const MAX_SESSION_ID_CHARS = 200;
const MAX_PTY_INPUT_BYTES = 256 * 1024;
const MAX_PTY_COLUMNS = 1_000;
const MAX_PTY_ROWS = 500;

function acceptsPtyInput(sessionId: unknown, data: unknown): data is string {
  return typeof sessionId === 'string'
    && sessionId.length > 0
    && sessionId.length <= MAX_SESSION_ID_CHARS
    && typeof data === 'string'
    && Buffer.byteLength(data, 'utf8') <= MAX_PTY_INPUT_BYTES;
}

function acceptsPtyResize(sessionId: unknown, cols: unknown, rows: unknown): boolean {
  return typeof sessionId === 'string'
    && sessionId.length > 0
    && sessionId.length <= MAX_SESSION_ID_CHARS
    && typeof cols === 'number'
    && Number.isInteger(cols)
    && cols >= 1
    && cols <= MAX_PTY_COLUMNS
    && typeof rows === 'number'
    && Number.isInteger(rows)
    && rows >= 1
    && rows <= MAX_PTY_ROWS;
}

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
  // Wanigan is often launched from inside a Claude Code session. Inheriting
  // these makes every spawned agent believe it is a subprocess of that session,
  // which silently disables transcript saving — no history, no --resume.
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDECODE',
];
const STRIPPED_PREFIXES = ['VSCODE_', 'ELECTRON_IPC', 'npm_'];

/**
 * The only host an inherited Anthropic credential is allowed to reach.
 *
 * Everything in STRIPPED_ENV above is functional — editor plumbing and
 * parent-session markers — so nothing there is a security strip. The two
 * variables below are, and they are removed conditionally rather than always,
 * because a session pointed at Anthropic still needs them.
 */
const ANTHROPIC_API_HOST = 'api.anthropic.com';
/**
 * Credentials the operator exported for Anthropic itself. ANTHROPIC_ADMIN_KEY
 * is the sharper one: it reaches organisation membership, workspaces and API
 * keys, a far wider blast radius than any one session.
 */
const ANTHROPIC_AMBIENT_KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_ADMIN_KEY'];

/** True when the resolved provider environment aims the Anthropic API somewhere else. */
export function redirectsAnthropicApi(providerEnv: Record<string, string>): boolean {
  const base = providerEnv.ANTHROPIC_BASE_URL?.trim();
  if (!base) return false;
  try {
    const url = new URL(base);
    // A plaintext hop to the right hostname is still somewhere else: the
    // credential would cross the network readable.
    return url.protocol !== 'https:' || url.hostname.toLowerCase() !== ANTHROPIC_API_HOST;
  } catch {
    // An unparseable base URL is not evidence of the official endpoint, and the
    // only consequence of this answer is whether a key is withheld, so an
    // unreadable value fails towards withholding it.
    return true;
  }
}

/**
 * The same question asked about a profile rather than an already-built
 * environment, so the account surfaces can ask it without reproducing how a
 * provider's environment is assembled.
 */
export function redirectsAnthropicApiFor(def: { env?: () => Record<string, string> }): boolean {
  try { return redirectsAnthropicApi(def.env?.() ?? {}); } catch { return false; }
}

/**
 * Telemetry and hooks are how Wanigan knows anything about a running agent, and
 * both are set here rather than asked of the user, because Wanigan spawns the
 * CLI and therefore owns its environment. Content logging stays off: prompt and
 * response text are redacted by default and Wanigan does not opt in.
 */
function agentEnv(
  PATH: string, sessionId: string, providerEnv: Record<string, string> = {},
  accountEnv: Record<string, string> = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (STRIPPED_ENV.includes(k)) continue;
    // A Wanigan window can itself be launched from a Codex session (for
    // example, from the editor extension).  Those markers identify the
    // *parent* writer.  Passing them to a child makes Codex try to attach to
    // that writer instead of creating the session Wanigan asked for, and the
    // child exits immediately.  CODEX_HOME is intentionally retained: it is
    // the user's chosen location for credentials and durable conversations,
    // not a parent-session marker.
    if (k.startsWith('CODEX_') && k !== 'CODEX_HOME') continue;
    if (STRIPPED_PREFIXES.some((pre) => k.startsWith(pre))) continue;
    out[k] = v;
  }
  out.PATH = PATH;
  // Belt and braces: the marker above disables persistence, this re-asserts it.
  out.CLAUDE_CODE_FORCE_SESSION_PERSISTENCE = '1';
  out.TERM = 'xterm-256color';
  out.COLORTERM = 'truecolor';
  out.FORCE_COLOR = '1';
  if (flags().telemetry) Object.assign(out, otelEnv(sessionId));
  // Last, so a provider that redirects the API wins over anything inherited
  // from the shell — an ANTHROPIC_BASE_URL in your profile must not silently
  // point a GLM session back at Anthropic, or the other way round.
  Object.assign(out, providerEnv);
  // After the pack, deliberately. A manifest is untrusted data, and the config
  // directory is where a harness keeps its credential — a pack that could set
  // it could point this session's login at a directory it chose, or read the
  // operator's by naming theirs. Wanigan's account decision wins, and it also
  // beats an inherited CLAUDE_CONFIG_DIR from the operator's shell, so the
  // account shown at launch is the one the session actually uses.
  Object.assign(out, accountEnv);
  if (redirectsAnthropicApi(providerEnv)) {
    // A provider pack chooses this host, and a pack is untrusted data. Consent
    // is otherwise the only control on where it points, and a consent dialog
    // can be padded off-screen by a large manifest — so an ambient Anthropic
    // key must not be along for the ride when the operator scrolls past.
    //
    // Only the *inherited* value is dropped. GLM and DeepSeek supply their own
    // credential through this same providerEnv (as ANTHROPIC_AUTH_TOKEN), and a
    // profile that deliberately declares one of these names keeps it: that
    // value was declared and consented to, not borrowed from the shell.
    for (const key of ANTHROPIC_AMBIENT_KEYS) {
      if (!(key in providerEnv)) delete out[key];
    }
  }
  return out;
}

type Live = {
  meta: Session;
  proc: IPty;
  buffer: string;
  /** PTY output waiting for the next coalesced `session:data` send. */
  pending: string;
  pendingTimer: ReturnType<typeof setTimeout> | null;
  /** Most recent PTY output; used to avoid typing an initial Codex prompt into a redraw. */
  lastDataAt: number;
  /** Last moment this session's output was reported to the attention queue. */
  notedAt: number;
  /** Incomplete OSC 9 control sequence split across PTY chunks. */
  providerControl: string;
  providerAwaitingApproval: boolean;
  providerFinished: boolean;
  /** A first prompt is in flight; wait for Codex to create its durable UUID. */
  codexCapturingIdentity: boolean;
  /** A manually selected Codex thread gets no lasting Recent record if bootstrap fails. */
  exactRecovery?: {
    bootstrapConfirmed: boolean;
    bootstrapFailure: string | null;
    /** Kept false until the recovered Codex TUI has actually reached its prompt. */
    historyRecorded: boolean;
    settled: boolean;
    ready: Promise<void>;
    resolveReady: () => void;
    rejectReady: (error: Error) => void;
    timer: ReturnType<typeof setTimeout> | null;
  };
  /** Settles only after node-pty reports the child gone. */
  exited: Promise<void>;
  resolveExit: () => void;
};

const sessions = new Map<string, Live>();
/** Covers the synchronous spawn boundary before the new Live row is visible. */
const resumingConversations = new Set<string>();
let broadcast: (channel: string, payload: unknown) => void = () => {};

/** The only renderer input accepted by the explicit “recover exact UUID” flow. */
export type ExactCodexRecoveryInput = { threadId: unknown; projectId: unknown };

type ExactCodexRecovery = {
  conversationId: string;
  /** Canonical CWD validated before the slow normal-harness setup starts. */
  cwd: string;
  claimKey: string;
};

type CreateSessionInternal = { exactCodexRecovery?: ExactCodexRecovery };

function codexConversationKey(conversationId: string): string {
  return `codex:${conversationId}`;
}

/** Refuse to manufacture a second Wanigan record for a conversation it already knows. */
function assertExactCodexRecoveryUnclaimed(conversationId: string, ownClaimKey: string | null = null): void {
  const normalized = normalizeCodexThreadId(conversationId);
  if (!normalized) throw new Error('The Codex conversation UUID is invalid.');
  const key = codexConversationKey(normalized);
  if (resumingConversations.has(key) && ownClaimKey !== key) {
    throw new Error('That Codex conversation is already opening in Wanigan.');
  }
  const open = [...sessions.values()].find((value) =>
    value.meta.harnessId === 'codex'
    && normalizeCodexThreadId(value.meta.conversationId) === normalized,
  );
  if (open) {
    throw new Error('That Codex conversation is already open in Wanigan. Use its existing tab.');
  }
  const known = db().prepare(`
    SELECT id FROM session_log
     WHERE conversation_id=?
       AND (harness_id='codex' OR provider_id='codex')
     LIMIT 1
  `).get(normalized) as { id: string } | undefined;
  if (known) {
    throw new Error('Wanigan already has this exact Codex conversation in Recent. Resume that record instead of importing a duplicate.');
  }
}

function recoveryBootstrapFailure(data: string): string | null {
  const plain = data.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  if (!/(thread\/resume failed|failed to resume session|already has an active writer|tui bootstrap)/i.test(plain)) return null;
  return 'Codex could not bootstrap this selected conversation. Wanigan left Recent history unchanged.';
}

function recoveryBootstrapReady(data: string): boolean {
  const plain = data.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  return /(ask codex to do anything|type your message|press enter to send)/i.test(plain);
}

function settleExactRecovery(live: Live, error: Error | null = null): void {
  const recovery = live.exactRecovery;
  if (!recovery || recovery.settled) return;
  recovery.settled = true;
  if (recovery.timer) clearTimeout(recovery.timer);
  recovery.timer = null;
  if (error) recovery.rejectReady(error);
  else recovery.resolveReady();
}


/**
 * Codex only creates an on-disk thread once it receives the first prompt.
 * Poll briefly after that boundary, rather than treating a welcome screen as a
 * failed identity discovery. A UUID is committed only when there is exactly
 * one same-directory top-level CLI candidate in the prompt's time window.
 */
function captureCodexIdentityAfterPrompt(live: Live, cwd: string): void {
  if (live.meta.harnessId !== 'codex' || live.meta.conversationId || live.codexCapturingIdentity) return;
  live.codexCapturingIdentity = true;
  const promptAt = Date.now();
  const deadline = promptAt + 10_000;
  const tryCapture = () => {
    // Codex can write its durable thread record just after a short task exits.
    // The PTY is gone, but the row is still safely attributable by the narrow
    // same-CWD/time-window matcher, so keep this bounded poll alive.
    if (live.meta.conversationId) {
      live.codexCapturingIdentity = false;
      return;
    }
    try {
      const threadId = captureNewCodexThreadId(live.meta.id, cwd, promptAt, 10_000, live.meta.createdAt);
      if (threadId) {
        live.meta.conversationId = threadId;
        live.codexCapturingIdentity = false;
        broadcast('session:list', sessionListEntries());
        return;
      }
    } catch { /* the state database can be between its own migrations */ }
    if (Date.now() >= deadline) {
      live.codexCapturingIdentity = false;
      return;
    }
    setTimeout(tryCapture, 250);
  };
  setTimeout(tryCapture, 100);
}

/**
 * Codex redraws its welcome screen while its MCP servers are booting. Sending
 * text and Enter as one early PTY write can leave the text in the composer and
 * lose the submit key. Wait for its visible prompt to settle, then type and
 * submit in separate writes. Manual typing already crosses this boundary.
 */
function submitInitialCodexPrompt(live: Live, cwd: string, prompt: string): void {
  const deadline = Date.now() + 20_000;
  let sawPromptAt = 0;
  const trySubmit = () => {
    if (live.meta.status === 'exited') return;
    const now = Date.now();
    if (live.buffer.includes('Ask Codex to do anything')) {
      if (!sawPromptAt) sawPromptAt = now;
      if (now - sawPromptAt >= 750 && now - live.lastDataAt >= 400) {
        try {
          live.proc.write(prompt);
          setTimeout(() => {
            if (live.meta.status === 'exited') return;
            try {
              live.proc.write('\r');
              captureCodexIdentityAfterPrompt(live, cwd);
            } catch { /* exited between the paired writes */ }
          }, 150);
        } catch { /* exited already */ }
        return;
      }
    }
    if (now < deadline) {
      setTimeout(trySubmit, 150);
      return;
    }
    // A changed Codex welcome screen must not silently turn a requested agent
    // task into an empty terminal. Do not type blindly into an unknown redraw;
    // make the fallback explicit and leave the user in control of the prompt.
    const notice = '\r\n\x1b[38;5;214mWanigan could not confirm Codex\'s ready prompt, so it did not send the initial task automatically. Paste or type it here, then press Enter.\x1b[0m\r\n';
    live.buffer = (live.buffer + notice).slice(-SCROLLBACK_BYTES);
    // Queued rather than broadcast directly so it lands behind any output still
    // waiting on the flush timer, then sent at once: nothing further is coming
    // that would carry it out.
    queueSessionData(live, notice);
    flushSessionData(live);
  };
  setTimeout(trySubmit, 150);
}

export function initSessions(getWindow: () => BrowserWindow | null) {
  reconcileAbandonedSessions();
  try { backfillCodexThreadIds(); }
  catch (e) { console.warn('[wanigan] Codex session identity backfill skipped:', e); }
  broadcast = (channel, payload) => {
    const w = getWindow();
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
  };
}

export function listSessions(): Session[] {
  return [...sessions.values()].map((s) => s.meta).sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * The session list as it goes over IPC, with the launch snapshot reduced to a
 * count.
 *
 * `baseline.dirty` holds one string per file that was already modified when a
 * session started — 84 in this repository, thousands in a monorepo — and this
 * module pushes the whole list again on every launch, exit, close, rename,
 * unread change and Codex identity discovery. Nothing in the list renders a
 * path; the code panel asks `sessions:baseline` for one session's worth when
 * it actually needs them.
 *
 * Exported because index.ts answers the poll for the same list. Two
 * projections would eventually disagree about what a session row contains,
 * and the renderer reads both through one type.
 */
export function sessionListEntries(): Session[] {
  return listSessions().map((value) => {
    const { baseline, ...rest } = value;
    if (!baseline) return rest;
    return {
      ...rest,
      baselineSummary: { head: baseline.head, dirtyCount: baseline.dirty.length, at: baseline.at },
    };
  });
}

/**
 * How coarse the "still talking" stamp may be. The attention queue only ever
 * compares it against a ninety-second idle threshold, and onData fires per
 * chunk — hundreds of times a second while an answer streams — so a reading
 * per chunk buys nothing any reader can see.
 */
const OUTPUT_NOTE_MS = 1000;

/**
 * How long a PTY chunk may wait for company before it crosses to the renderer.
 *
 * A streaming TUI emits tens of chunks a second, and every one of them used to
 * be its own IPC message and its own renderer state update; a handful of live
 * sessions made this the busiest path in the app. Coalescing collapses a burst
 * into a few sends a second. The window stays far below the ~100ms at which a
 * person starts to feel a terminal lag, so local echo still reads as instant.
 */
const DATA_FLUSH_MS = 25;

/**
 * Send whatever is queued now. The payload shape is deliberately unchanged —
 * the renderer receives the same bytes in the same order, in fewer messages.
 */
function flushSessionData(live: Live): void {
  if (live.pendingTimer) {
    clearTimeout(live.pendingTimer);
    live.pendingTimer = null;
  }
  if (!live.pending) return;
  const data = live.pending;
  live.pending = '';
  broadcast('session:data', { sessionId: live.meta.id, data });
}

/** Queue PTY output behind the flush timer, starting one if none is running. */
function queueSessionData(live: Live, data: string): void {
  live.pending += data;
  if (live.pendingTimer) return;
  live.pendingTimer = setTimeout(() => {
    live.pendingTimer = null;
    flushSessionData(live);
  }, DATA_FLUSH_MS);
}

const OSC9_PREFIX = '\x1b]9;';
const MAX_PROVIDER_CONTROL = 2_048;
export type CodexLifecycleSignal = 'permission' | 'finished';

/**
 * Pull Codex's opt-in OSC 9 lifecycle messages out of arbitrary PTY chunks.
 * The sequence can split at any byte; only its short unfinished suffix is
 * retained. Ordinary terminal output is never inspected or stored here.
 */
export function scanCodexNotifications(
  pending: string,
  chunk: string,
): { pending: string; signals: CodexLifecycleSignal[] } {
  let input = `${pending}${chunk}`;
  const signals: CodexLifecycleSignal[] = [];

  for (;;) {
    const start = input.indexOf(OSC9_PREFIX);
    if (start < 0) {
      // Preserve only a possible split prefix (ESC, ESC], or ESC]9).
      let suffix = '';
      for (let n = Math.min(OSC9_PREFIX.length - 1, input.length); n > 0; n--) {
        const candidate = input.slice(-n);
        if (OSC9_PREFIX.startsWith(candidate)) { suffix = candidate; break; }
      }
      return { pending: suffix, signals };
    }

    const contentAt = start + OSC9_PREFIX.length;
    const bel = input.indexOf('\x07', contentAt);
    const st = input.indexOf('\x1b\\', contentAt);
    const end = bel < 0 ? st : st < 0 ? bel : Math.min(bel, st);
    if (end < 0) {
      return { pending: input.slice(start, start + MAX_PROVIDER_CONTROL), signals };
    }

    const payload = input.slice(contentAt, end)
      .replace(/[\x00-\x1f\x7f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (/^agent turn complete\b/i.test(payload)) signals.push('finished');
    // The per-invocation filter above permits exactly two notification event
    // types. Codex has changed the human approval phrase across releases
    // ("Approval requested", "Codex wants to edit…", and others), so every
    // other non-empty structured notification is the approval event.
    else if (payload) signals.push('permission');

    input = input.slice(end + (end === st ? 2 : 1));
  }
}

/**
 * Artifact directories named anywhere in the saved conversation. A resumed
 * thread gets a fresh staging directory for new uploads, but it must also be
 * allowed to read reports and images produced by its earlier launches.
 */
function priorArtifactDirs(sessionId: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let cursor: string | null = sessionId;
  for (let depth = 0; cursor && depth < 128 && !seen.has(cursor); depth++) {
    seen.add(cursor);
    try {
      const dir = attachmentsDir(cursor);
      if (fs.existsSync(dir)) out.push(dir);
    } catch { /* a malformed legacy id is not a filesystem grant */ }
    const row: { resumed_from: string | null } | undefined = db()
      .prepare('SELECT resumed_from FROM session_log WHERE id = ?')
      .get(cursor) as { resumed_from: string | null } | undefined;
    cursor = row?.resumed_from ?? null;
  }
  return out;
}

type ResumeRow = {
  provider_id: string;
  project_id: string | null;
  project_path: string;
  worktree: string | null;
};

/**
 * Resume ownership is verified in the main process, not taken from the
 * renderer's project picker. An isolated conversation must never silently
 * continue in the primary checkout: reuse its viable worktree, or create a
 * fresh isolated continuation when the clean old one has gone away.
 */
async function resumeWorktree(
  sessionId: string,
  providerId: ProviderId,
  project: { id: string; path: string },
): Promise<{ existing: string | null; needsFreshIsolation: boolean }> {
  const row = db().prepare(`
    SELECT provider_id, project_id, project_path, worktree
      FROM session_log
     WHERE id=? AND origin='wanigan'
  `).get(sessionId) as ResumeRow | undefined;
  if (!row) throw new Error('This saved conversation no longer exists. Refresh Recent and choose another one.');
  if (row.provider_id !== providerId) {
    throw new Error('A saved conversation must resume with the provider that created it.');
  }
  if (row.project_id !== project.id || path.resolve(row.project_path) !== path.resolve(project.path)) {
    throw new Error('This saved conversation belongs to a different project. Resume it from that project instead.');
  }

  const saved = row.worktree?.trim() || null;
  if (!saved) return { existing: null, needsFreshIsolation: false };
  if (!fs.existsSync(saved)) return { existing: null, needsFreshIsolation: true };

  // A path merely existing is not enough: it could have been recycled or
  // replaced since the session ended. Both roots must resolve to the same git
  // repository before a historical agent context is pointed at it again.
  const [projectRoot, worktreeRoot] = await Promise.all([repoRootFor(project.path), repoRootFor(saved)]);
  if (!projectRoot || !worktreeRoot || path.resolve(projectRoot) !== path.resolve(worktreeRoot)) {
    throw new Error(
      'The saved isolated checkout no longer belongs to this project. Wanigan will not resume this conversation in the main checkout.'
    );
  }
  return { existing: saved, needsFreshIsolation: false };
}

/**
 * Explicit recovery is intentionally a separate entry point from arbitrary
 * session creation. The renderer can supply exactly a UUID and a selected
 * project id — no model, effort, flags, prompt, worktree, or historical row
 * can be smuggled into `codex resume <uuid>`.
 */
export async function recoverExactCodexThread(input: ExactCodexRecoveryInput): Promise<Session> {
  const threadId = normalizeCodexThreadId(input?.threadId);
  if (!threadId) throw new Error('Paste the complete Codex conversation UUID; Wanigan will not guess a recent thread.');
  const projectId = typeof input?.projectId === 'string' ? input.projectId.trim() : '';
  const project = projectById(projectId);
  if (!project) throw new Error('Choose the project folder that this Codex conversation used.');

  // This is read-only against Codex state: state_5, rollout and session_meta
  // must all say the same UUID/CWD before this path reserves anything.
  const verified = validateExactCodexThread(threadId, project.path);
  const claimKey = codexConversationKey(verified.id);
  assertExactCodexRecoveryUnclaimed(verified.id);
  resumingConversations.add(claimKey);
  try {
    const session = await createSession(
      { providerId: 'codex', projectId: project.id },
      { exactCodexRecovery: { conversationId: verified.id, cwd: verified.cwd, claimKey } },
    );
    const recovery = sessions.get(session.id)?.exactRecovery;
    if (!recovery) throw new Error('Wanigan could not verify the recovered Codex bootstrap.');
    await recovery.ready;
    return session;
  } catch (error) {
    resumingConversations.delete(claimKey);
    throw error;
  }
}

/** Live means "still holds a PTY". An exited tab kept open for reading costs nothing. */
function liveSessionCount(): number {
  let n = 0;
  for (const value of sessions.values()) if (value.meta.status !== 'exited') n++;
  return n;
}

/**
 * Honour the dispatcher's `session` slot count for interactive launches too.
 *
 * Settings has always shown this control, a usage meter and a confirmation
 * reading "Wanigan will now start at most N sessions", but only queued work
 * ever consulted it — an interactive launch never goes through the queue, so
 * someone who lowered the number to protect their laptop was not protected.
 * Refusing is the honest reading of that promise: silently queueing a terminal
 * the operator is standing in front of would hide the limit rather than apply
 * it, and this codebase says no out loud.
 */
function assertSessionSlotAvailable(): void {
  // Read fresh, exactly like the dispatcher, so a Settings change takes effect
  // on the next launch without a restart. A hand-written 0 means here what it
  // means in queue.ts: hold this surface, do not start work on it.
  const limit = slots().session;
  const live = liveSessionCount();
  if (live < limit) return;
  throw new Error(
    limit === 0
      ? 'Interactive sessions are held at 0 in Settings › Dispatcher. Raise the "Interactive sessions" limit to start one.'
      : `${live} of ${limit} interactive ${limit === 1 ? 'session is' : 'sessions are'} already running. `
        + 'Stop one, or raise the "Interactive sessions" limit in Settings › Dispatcher, then start this one again.'
  );
}

function usd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

/**
 * Refuse to start new spend against a budget that is already over its cap.
 *
 * `budgetBreached()` had exactly one consumer — the IPC read that draws the
 * Insights banner — so a cap was a receipt rather than a budget: by the time it
 * spoke, the money was gone. The refusal belongs here, at the one place that
 * starts an interactive agent, which also keeps policy.ts's note true that no
 * budget figure was added to the trust path.
 *
 * Only a scope whose *recorded* month-to-date spend has reached its cap
 * refuses. The breach list also carries warning-threshold and run-rate entries;
 * those are a projection, and a projection is not a fact you can be stopped by
 * — on the 2nd of a month one expensive session projects over almost any cap,
 * and blocking the rest of the month on that would be a guess wearing a
 * refusal's clothes. Those keep drawing their banner and nothing more.
 */
function assertBudgetAllowsLaunch(projectId: string): void {
  let over: BudgetState[];
  try {
    over = budgetBreached().filter((state) =>
      // A cap on another project must never block this one.
      (state.scopeId === null || state.scopeId === projectId)
      && state.monthlyUsd > 0
      && state.spentUsd >= state.monthlyUsd);
  } catch {
    // Spend accounting is evidence about launches, never a gate on them: an
    // unreadable budgets table must not make the app unable to start work.
    return;
  }
  if (!over.length) return;
  const detail = over
    .map((state) => `${state.scopeName} has spent ${usd(state.spentUsd)} of its ${usd(state.monthlyUsd)} monthly budget`)
    .join('; ');
  throw new Error(
    `${detail}. Raise or clear that cap under Insights › Budgets — a cap of 0 keeps tracking spend without ` +
    'stopping work — then start this session again.'
  );
}

export async function createSession(opts: LaunchOptions, internal: CreateSessionInternal = {}): Promise<Session> {
  const exactRecovery = internal.exactCodexRecovery ?? null;
  if (exactRecovery && (
    opts.providerId !== 'codex' || opts.resumeFrom || opts.extraArgs || opts.initialPrompt || opts.isolate
    || opts.model || opts.effort || opts.permissionMode || opts.providerOptions
  )) {
    throw new Error('Exact Codex recovery only launches codex resume with the selected UUID.');
  }
  let def = providerById(opts.providerId);
  if (!def) throw new Error(`Unknown provider: ${opts.providerId}`);
  const project = projectById(opts.projectId);
  if (!project) throw new Error('Project not found — it may have been removed.');

  // Both refusals are local and cheap, so they answer before provider probing,
  // worktree creation or any injected file exists to roll back.
  assertSessionSlotAvailable();
  assertBudgetAllowsLaunch(project.id);

  const PATH = await shellPath();
  // Launch the exact binary detection found, not whatever PATH resolves to now.
  const detected = (await detectProviders()).find((p) => p.id === opts.providerId);
  const refreshedDef = providerById(opts.providerId);
  if (!refreshedDef || !detected?.path || detected.profileFingerprint !== refreshedDef.profileFingerprint) {
    throw new Error(
      `${def.label} is disabled, changed, or no longer installed. Refresh providers and try again.`
    );
  }
  def = refreshedDef;
  const resolvedBin = detected.path;
  const harnessProven = def.source === 'builtin' || detected.capabilities.probed;
  const extra = (opts.extraArgs ?? '').trim().split(/\s+/).filter(Boolean);

  // The claude CLI accepts a conversation id we choose, which is what makes a
  // specific session resumable later rather than just "the most recent one".
  // GLM runs that same CLI, so it gets one too — --session-id is local
  // bookkeeping and never reaches the API.
  const id0 = `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const id = id0;

  const savedResume = opts.resumeFrom;
  const isResuming = Boolean(savedResume || exactRecovery);
  const resumeTree = savedResume
    ? await resumeWorktree(savedResume.sessionId, opts.providerId, project)
    : { existing: null, needsFreshIsolation: false };
  let conversationId = exactRecovery?.conversationId ?? savedResume?.conversationId ?? null;
  let codexResumeNeedsPicker = false;
  if (exactRecovery) {
    // The UUID came through validateExactCodexThread above, never the renderer
    // launch form or a saved Wanigan row. It is revalidated immediately before
    // spawn after the normal harness has finished preparing its narrow files.
    conversationId = exactRecovery.conversationId;
  } else if (savedResume && def.harness === 'codex') {
    // Never let a stale renderer payload decide which Codex thread to open.
    // The durable row is backfilled from Codex's own index/rollout and becomes
    // the identity used for both duplicate-writer checks and argv.
    conversationId = codexThreadIdForSession(savedResume.sessionId);
    if (!conversationId || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(conversationId)) {
      // Some historical rows were created before Wanigan saved Codex's UUID,
      // or were produced by an earlier native resume. There is no safe way to
      // infer that UUID from a list row. Ask Codex to show its native picker
      // instead; specifically do not use --last, which could open unrelated
      // work without the operator choosing it.
      conversationId = null;
      codexResumeNeedsPicker = true;
    } else {
      const alreadyOpen = [...sessions.values()].find((value) =>
        value.meta.harnessId === 'codex'
        && value.meta.conversationId === conversationId
        && value.meta.status !== 'exited');
      if (alreadyOpen) {
        throw new Error(
          `That Codex conversation is already open in Wanigan as “${alreadyOpen.meta.title}”.`
        );
      }
    }
  } else if (!isResuming && def.supports.resume && runsClaudeCli(def)) {
    conversationId = randomUUID();
  }

  const idArgs = isResuming
    ? def.resumeArgs(conversationId)
    : conversationId ? ['--session-id', conversationId] : [];

  // Trust is resolved once, at launch, and travels with the session — a policy
  // that can change under a running agent is a policy nobody can reason about.
  const trust: TrustLevel = trustFor(project.id);

  // A worktree keeps parallel agents off each other's working tree. It lives
  // outside the repo so the agent never trips over it in its own file listings.
  let worktree: string | null = resumeTree.existing;
  let createdWorktree = false;
  if (!worktree && (opts.isolate || resumeTree.needsFreshIsolation)) {
    try {
      const wt = await createWorktree(project.path, project.name, id0);
      worktree = wt.path;
      createdWorktree = true;
    } catch (e) {
      throw new Error(
        `Could not create an isolated ${isResuming ? 'continuation ' : ''}worktree for ${project.name}: ` +
        `${e instanceof Error ? e.message : String(e)}`
      );
    }
  }
  const cwd = worktree ?? project.path;
  let mcpFile: string | null = null;

  // A launch has several filesystem side effects before the PTY exists. Keep
  // their rollback in one place so a provider change, duplicate-resume guard,
  // spawn failure or database failure cannot strand a clean worktree or a live
  // hook credential. A reused historical worktree is never removed here: it
  // may contain the only copy of prior work.
  const rollbackLaunch = async () => {
    try { cleanupMcpConfig(mcpFile, id); } catch { /* no MCP config was written */ }
    try { cleanupHookSettings(id); } catch { /* no hook file was written */ }
    try { cleanupSessionAttachments(id); } catch { /* no attachment dir was written */ }
    if (createdWorktree && worktree) {
      try { await removeWorktree(worktree, false); }
      catch { /* git refused a non-clean tree; preserve work over disk tidiness */ }
    }
  };

  // Attachments arrive after a session has started, so the directory must
  // exist and be granted to the CLI before its sandbox is created. Granting
  // this one session directory is deliberately narrower than granting all of
  // Wanigan's user-data directory.
  let attachmentDir: string;
  try {
    attachmentDir = prepareAttachmentDir(id);
  } catch (error) {
    await rollbackLaunch();
    throw error;
  }

  // Hook config and MCP servers are injected with --settings / --mcp-config,
  // which take a path. That is what keeps Wanigan out of the user's repository:
  // nothing is written into .claude/, and nothing the user shares in git changes.
  const injected: string[] = [];
  try {
    if (runsClaudeCli(def) && harnessProven) {
      if (flags().hooks && detected.capabilities.hooks) {
        // Learning is injected directly below. Keeping it out of SessionStart
        // avoids duplicate context while preserving trust/policy hook output.
        const settingsFile = writeHookSettings(id0, cwd);
        if (settingsFile) injected.push('--settings', settingsFile);
      }
      if (detected.capabilities.mcp) {
        mcpFile = writeMcpConfig(project.id, cwd, id0);
        if (mcpFile) injected.push('--mcp-config', mcpFile);
      }
    }
  } catch (error) {
    await rollbackLaunch();
    throw error;
  }

  // Attachment directory flags belong to harnesses, not provider ids. A
  // manifest-only generic CLI must never receive a guessed flag and exit before
  // its first prompt.
  const artifactDirs = [
    attachmentDir,
    ...(savedResume ? priorArtifactDirs(savedResume.sessionId) : []),
  ].filter((value, index, all) => all.indexOf(value) === index);
  const attachmentArgs = !harnessProven || (def.harness !== 'claude-code' && def.harness !== 'codex')
    ? []
    : def.harness === 'codex'
      // Codex treats every --add-dir as an additional writable root and
      // refuses it under read-only sandboxing. Wanigan creates this directory
      // before the terminal starts so an attachment added later can be read;
      // explicitly select the least Codex sandbox that permits that narrow
      // extra root instead of inheriting a read-only user default and exiting.
      ? ['--sandbox', 'workspace-write', ...artifactDirs.flatMap((dir) => ['--add-dir', dir])]
      : artifactDirs.flatMap((dir) => ['--add-dir', dir]);
  const learnedArgs: string[] = [];
  // Both built-in harnesses expose invocation-scoped additional instructions.
  // This works with Hooks disabled, avoids a fake first user turn, and leaves
  // AGENTS.md / CLAUDE.md / provider-owned generated memory untouched.
  if (harnessProven && (def.harness === 'codex' || def.harness === 'claude-code') && learningSettings().enabled) {
    try {
      const learned = await buildBriefing({
        query: opts.initialPrompt?.trim() ?? '',
        providerId: def.id,
        backendId: def.backendId,
        projectId: project.id,
        maxTokens: learningSettings().briefingMaxTokens,
        projectRoot: project.path, allowedEvidenceRoots: [project.path],
      });
      if (learned.text) {
        if (def.harness === 'codex') {
          learnedArgs.push('--config', `developer_instructions=${JSON.stringify(learned.text)}`);
        } else {
          learnedArgs.push('--append-system-prompt', learned.text);
        }
      }
      // Record what was actually delivered — entries, estimated tokens, and
      // what retrieval held back — so "this session received briefing X" is a
      // stored fact, not a guess. An empty result is recorded too: "retrieval
      // ran and matched nothing" must stay distinguishable from "no record".
      try {
        recordSessionBriefing({
          sessionId: id0, delivery: 'argv', providerId: def.id,
          projectId: project.id, briefing: learned,
          maxTokens: learningSettings().briefingMaxTokens,
        });
      } catch { /* the record is evidence, never a launch dependency */ }
    } catch { /* learned context is never a launch dependency */ }
  }
  // Codex does not post Claude-style hooks, but it can emit two structured TUI
  // lifecycle notifications. Force OSC 9 only for this Wanigan-owned terminal;
  // no user-level config is edited and no prompt/response content is included.
  const lifecycleArgs = harnessProven && def.harness === 'codex'
    ? [
        '--config', 'tui.notifications=["agent-turn-complete","approval-requested"]',
        '--config', 'tui.notification_condition="always"',
        '--config', 'tui.notification_method="osc9"',
    ]
    : [];
  // An exact Codex resume restores the model and reasoning settings embedded
  // in its saved thread. Replaying values from Wanigan's historical row is
  // both unnecessary and brittle: an older CLI recorded `ultra`, for example,
  // while a newer provider profile may no longer advertise that spelling and
  // rejects the launch before `resume <uuid>` can run. New sessions still pass
  // the values the operator selected; only a durable Codex conversation owns
  // its own resume-time settings.
  const resumeCodex = isResuming && def.harness === 'codex';
  let args: string[];
  try {
    args = [
      ...idArgs, ...injected, ...attachmentArgs, ...learnedArgs, ...lifecycleArgs,
      ...def.launchArgs(extra, {
        ...opts.providerOptions,
        model: resumeCodex ? undefined : opts.model || undefined,
        effort: resumeCodex ? undefined : def.supports.effort ? opts.effort || undefined : undefined,
        permissionMode: def.supports.permissionMode ? opts.permissionMode || undefined : undefined,
      }),
    ];
  } catch (error) {
    await rollbackLaunch();
    throw error;
  }
  const baseline = await captureBaseline(cwd);

  // No await occurs between this digest/trust revalidation and pty.spawn.
  // A provider disabled or modified while project/worktree setup was running
  // must never launch through the stale definition captured above.
  refreshProviderPacks();
  const finalDef = providerById(opts.providerId);
  if (!finalDef || finalDef.profileFingerprint !== def.profileFingerprint) {
    await rollbackLaunch();
    throw new Error(`${def.label} changed or was disabled before launch. Review the provider pack and try again.`);
  }

  // Re-checked here because the early refusal cannot see a launch that started
  // while this one was probing providers and preparing files: nothing joins the
  // live map until pty.spawn, and there is no await between this line and it.
  try {
    assertSessionSlotAvailable();
  } catch (error) {
    await rollbackLaunch();
    throw error;
  }

  const resumeKey = isResuming && conversationId
    ? `${def.harness}:${conversationId}`
    : null;
  if (resumeKey) {
    const alreadyOpen = [...sessions.values()].some((value) =>
      value.meta.harnessId === def.harness
      && value.meta.conversationId === conversationId
      && value.meta.status !== 'exited');
    // Exact recovery reserves its own key before normal harness preparation;
    // a second renderer request sees that reservation, while this owner may
    // proceed to the final lock check below.
    const ownsPreclaim = exactRecovery?.claimKey === resumeKey && resumingConversations.has(resumeKey);
    if (alreadyOpen || (resumingConversations.has(resumeKey) && !ownsPreclaim)) {
      await rollbackLaunch();
      throw new Error('That conversation is already opening or open in Wanigan. Use its existing tab.');
    }
    if (!ownsPreclaim) resumingConversations.add(resumeKey);
  }

  const meta: Session = {
    id,
    providerId: opts.providerId,
    projectId: project.id,
    projectPath: project.path,
    projectName: project.name,
    title: `${def.label} · ${project.name}`,
    worktree,
    trust,
    capabilities: detected?.capabilities,
    providerPackId: def.packId,
    providerPackVersion: def.packVersion,
    providerProfile: {
      id: def.id,
      packId: def.packId,
      packVersion: def.packVersion,
      label: def.label,
      harness: def.harness,
      backendId: def.backendId,
      bin: def.bin,
      enabled: true,
      supports: def.supports,
      capabilities: Object.fromEntries(Object.entries(def.declaredCapabilities)),
      launchFields: def.launchFields.map((field) => ({
        id: field.id,
        label: field.label,
        kind: field.kind,
        required: field.required,
        description: field.description,
        options: field.choices,
        defaultValue: field.defaultValue,
      })),
    },
    backendId: def.backendId,
    harnessId: def.harness,
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

  // Keep the strict checks adjacent to the actual spawn. Everything above can
  // take time (provider probing, worktree setup, attachment preparation); a
  // thread can acquire a writer in that interval. This block has no await, and
  // the very next operation is pty.spawn.
  if (exactRecovery) {
    try {
      if (def.harness !== 'codex' || !conversationId || JSON.stringify(idArgs) !== JSON.stringify(['resume', conversationId])) {
        throw new Error('The installed Codex profile cannot perform an exact UUID recovery. Wanigan did not use a fallback picker.');
      }
      const verified = validateExactCodexThread(conversationId, project.path);
      if (verified.cwd !== exactRecovery.cwd) {
        throw new Error('Codex’s saved directory changed while recovery was preparing. Wanigan did not resume it.');
      }
      assertExactCodexRecoveryUnclaimed(conversationId, exactRecovery.claimKey);
      assertCodexThreadWriterUnlocked(conversationId);
    } catch (error) {
      if (resumeKey) resumingConversations.delete(resumeKey);
      await rollbackLaunch();
      throw error;
    }
  }

  // Called once and reused: this is the value the account decision is made
  // against as well as the value the child receives, and a second call could
  // legitimately return something different.
  const providerEnvValues = def.env?.() ?? {};
  // Which account this session authenticates as. GLM and DeepSeek run the same
  // `claude-code` harness but point ANTHROPIC_BASE_URL at another vendor and
  // authenticate with that vendor's own credential, so naming a Claude account
  // for them would name a login the session never uses. Asking whether the
  // profile still talks to Anthropic is the provider-neutral form of that test.
  const account = accounts.resolve({
    harness: def.harness,
    projectId: project.id,
    explicitAccountId: opts.accountId ?? null,
    appliesToAnthropic: usesAnthropicAccount(def) && !redirectsAnthropicApi(providerEnvValues),
  }).account;
  // Frozen onto the live session. The project's default can change while this
  // runs, and a badge that re-resolved on every read would relabel a running
  // session as an account it never authenticated with.
  meta.accountId = account?.id ?? null;
  meta.accountLabel = account?.label ?? null;

  let proc: IPty;
  try {
    proc = pty.spawn(resolvedBin, args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 32,
      cwd,
      env: agentEnv(PATH, id, providerEnvValues, accounts.launchEnv(account)),
    });
  } catch (e) {
    if (resumeKey) resumingConversations.delete(resumeKey);
    await rollbackLaunch();
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Could not start "${def.bin}". Is it installed and on your PATH? (${msg})`
    );
  }

  meta.pid = proc.pid;
  meta.status = 'running';
  meta.baseline = baseline;
  meta.conversationId = conversationId;

  // `bin` is the binary that actually ran, resolved path and all. provider_id
  // cannot answer "which CLI produced this" on its own now that claude and glm
  // are the same program, and a reader six months from now has only this row.
  // Exact UUID recovery defers this write until Codex actually reaches its TUI
  // prompt. A writer-lock/bootstrap refusal therefore leaves Recent entirely
  // untouched rather than creating a failed duplicate record.
  // What the operator asked for at launch. Once the PTY is gone the scrollback
  // goes with it, and the row is then the only thing that can say what this
  // session was started to do — the first question anyone asks of a finished
  // one. Redacted before it is cut, never after: cutting first can slice a
  // pasted key in half and leave the visible half sitting in a row that
  // outlives the terminal it was typed into.
  const initialPrompt = opts.initialPrompt?.trim()
    ? redactCredentials(opts.initialPrompt.trim()).slice(0, INITIAL_PROMPT_MAX)
    : null;
  // Recent shows a conversation's newest row, so a resume must carry the name
  // forward or every rename dies at the next continuation.
  const inheritedTitle = savedResume
    ? ((db().prepare('SELECT title FROM session_log WHERE id = ?').get(savedResume.sessionId) as { title?: string | null } | undefined)?.title ?? null)
    : null;
  const derivedTitle = deriveSessionTitle(initialPrompt) ?? inheritedTitle;
  if (derivedTitle) meta.displayTitle = derivedTitle;

  const recordSessionHistory = () => {
    const d = db();
    d.transaction(() => {
      d.prepare(`
        INSERT INTO session_log (id, conversation_id, provider_id, project_id, project_path,
                                 project_name, model, effort, permission_mode, started_at,
                                 resumed_from, worktree, trust, bin, capabilities_json,
                                 provider_pack_id,provider_pack_version,provider_profile_json,
                                 backend_id,harness_id,baseline_head,baseline_dirty_json,
                                 initial_prompt,title,account_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(id, conversationId, opts.providerId, project.id, project.path, project.name,
             meta.model ?? null, meta.effort ?? null, meta.permissionMode ?? null,
             meta.createdAt, savedResume?.sessionId ?? null, worktree, trust, resolvedBin,
             detected?.capabilities ? JSON.stringify(detected.capabilities) : null,
             def.packId, def.packVersion, JSON.stringify(meta.providerProfile), def.backendId, def.harness,
             // The launch snapshot has to outlive the process that took it.
             // "Undo what this agent did" is asked most often after a restart,
             // and the dirty list is the half that keeps work the operator had
             // already done from being attributed to the agent, so it is stored
             // whole rather than capped.
             baseline.head, JSON.stringify(baseline.dirty),
             // Recorded because the transcript, observed-session and team
             // readers have to look in the directory this session actually
             // used. Resolving it again later from the default would send them
             // to the wrong account's files and honestly report nothing.
             initialPrompt, derivedTitle, account?.id ?? null);
      // A reused isolated checkout now belongs to this live continuation for
      // reconciliation purposes. Its historical session_log rows retain the
      // original path, so moving this liveness pointer loses no provenance.
      if (worktree && !createdWorktree) {
        d.prepare(
          'UPDATE worktrees SET session_id=?, removed_at=NULL WHERE path=? AND removed_at IS NULL'
        ).run(id, worktree);
      }
    })();
  };
  if (!exactRecovery) {
    try {
      recordSessionHistory();
    } catch (e) {
      if (resumeKey) resumingConversations.delete(resumeKey);
      try { proc.kill(); } catch { /* do not orphan an unrecorded writer */ }
      await rollbackLaunch();
      const detail = e instanceof Error ? e.message : String(e);
      throw new Error(`The agent started, but Wanigan could not record its session (${detail}). It was stopped.`);
    }
  }
  // The launch snapshot is taken before the agent's first action. Gated on
  // hooks actually being injected: without turn boundaries the chain would be
  // one orphan commit pretending to be a feature.
  registerSessionCheckpoints({
    sessionId: id,
    cwd,
    hooksCapable: injected.includes('--settings'),
    gitHead: baseline.head,
  });
  let resolveExit = () => {};
  const exited = new Promise<void>((resolve) => { resolveExit = resolve; });
  let resolveExactRecovery = () => {};
  let rejectExactRecovery = (_error: Error) => {};
  const exactRecoveryReady = exactRecovery
    ? new Promise<void>((resolve, reject) => {
        resolveExactRecovery = resolve;
        rejectExactRecovery = reject;
      })
    : null;
  // onData can arrive before recoverExactCodexThread reaches its await. Keep
  // the rejection handled during that tiny handoff; the caller still receives
  // the same rejection when it awaits the original promise.
  void exactRecoveryReady?.catch(() => {});
  const live: Live = {
    meta,
    proc,
    buffer: '',
    pending: '',
    pendingTimer: null,
    lastDataAt: Date.now(),
    notedAt: 0,
    providerControl: '',
    providerAwaitingApproval: false,
    providerFinished: false,
    codexCapturingIdentity: false,
    exactRecovery: exactRecovery ? {
      bootstrapConfirmed: false,
      bootstrapFailure: null,
      historyRecorded: false,
      settled: false,
      ready: exactRecoveryReady!,
      resolveReady: resolveExactRecovery,
      rejectReady: rejectExactRecovery,
      timer: null,
    } : undefined,
    exited,
    resolveExit,
  };
  sessions.set(id, live);
  if (resumeKey) resumingConversations.delete(resumeKey);
  if (live.exactRecovery) {
    live.exactRecovery.timer = setTimeout(() => {
      if (!live.exactRecovery || live.exactRecovery.historyRecorded || live.meta.status === 'exited') return;
      const message = 'Codex did not reach its ready prompt during recovery. Wanigan stopped the unrecorded writer and left Recent history unchanged.';
      live.exactRecovery.bootstrapFailure = message;
      settleExactRecovery(live, new Error(message));
      try { live.proc.kill(); } catch { /* already gone */ }
    }, 30_000);
  }

  if ((!isResuming || codexResumeNeedsPicker) && def.harness === 'codex') {
    void discoverCodexThreadId(id, cwd, meta.createdAt).then((threadId) => {
      if (!threadId) {
        console.warn(`[wanigan] exact Codex thread id was not discovered for session ${id}`);
        return;
      }
      const current = sessions.get(id);
      if (current) current.meta.conversationId = threadId;
      broadcast('session:list', sessionListEntries());
    }).catch((e) => {
      console.warn(`[wanigan] Codex thread discovery failed for session ${id}:`, e);
    });
  }

  proc.onData((data) => {
    live.buffer += data;
    live.lastDataAt = Date.now();
    if (live.buffer.length > SCROLLBACK_BYTES) {
      live.buffer = live.buffer.slice(-SCROLLBACK_BYTES);
    }
    // This is intentionally before provider-event recording. Exact recovery
    // owns no durable Wanigan row until the selected Codex TUI is demonstrably
    // ready, so a rejected bootstrap cannot leave a session/event history.
    if (live.exactRecovery && !live.exactRecovery.historyRecorded) {
      const failure = recoveryBootstrapFailure(data);
      if (failure) {
        live.exactRecovery.bootstrapFailure = failure;
        settleExactRecovery(live, new Error(failure));
        // A failed bootstrap must never be allowed to limp on as an
        // unrecorded, second writer.  Killing here also prevents trailing TUI
        // output from being mistaken for a successful prompt below.
        try { live.proc.kill(); } catch { /* process may already be exiting */ }
      } else if (!live.exactRecovery.bootstrapFailure && recoveryBootstrapReady(data)) {
        live.exactRecovery.bootstrapConfirmed = true;
        try {
          recordSessionHistory();
          live.exactRecovery.historyRecorded = true;
          settleExactRecovery(live);
        } catch (error) {
          live.exactRecovery.bootstrapFailure = 'Wanigan could not record this recovered session, so it stopped the unrecorded writer.';
          const notice = `\r\n\x1b[38;5;214m${live.exactRecovery.bootstrapFailure}\x1b[0m\r\n`;
          live.buffer = (live.buffer + notice).slice(-SCROLLBACK_BYTES);
          // Queued, not broadcast directly, so it stays behind any output still
          // waiting — then flushed at once, because the writer is killed below
          // and there may be no later chunk to ride out with.
          queueSessionData(live, notice);
          flushSessionData(live);
          settleExactRecovery(live, new Error(live.exactRecovery.bootstrapFailure));
          try { live.proc.kill(); } catch { /* process may already be exiting */ }
          void error;
        }
      }
    }
    // Idle means no hook event and no output. An agent streaming a long answer
    // fires no hooks at all, so without this the queue calls a session that is
    // visibly talking idle after ninety seconds — and sorts it above the one
    // that has genuinely been stuck. Throttled because this is the hot path.
    const now = Date.now();
    if (now - live.notedAt >= OUTPUT_NOTE_MS) {
      live.notedAt = now;
      noteOutput(id, now);
    }
    if (live.meta.harnessId === 'codex') {
      const scanned = scanCodexNotifications(live.providerControl, data);
      live.providerControl = scanned.pending;
      for (const signal of scanned.signals) {
        if (signal === 'permission') {
          live.providerAwaitingApproval = true;
          live.providerFinished = false;
          if (!live.exactRecovery || live.exactRecovery.historyRecorded) {
            recordProviderEvent(id, 'PermissionRequest', 'Waiting for your approval.', now);
          }
        } else {
          live.providerAwaitingApproval = false;
          live.providerFinished = true;
          if (!live.exactRecovery || live.exactRecovery.historyRecorded) {
            recordProviderEvent(id, 'Stop', 'Turn complete.', now);
          }
        }
      }
    }
    queueSessionData(live, data);
  });

  proc.onExit(({ exitCode, signal }) => {
    // The last chunk of an agent's answer is often the whole answer. Send what
    // is still queued before anything else runs, so a pending flush timer
    // cannot lose it to the teardown below.
    flushSessionData(live);
    // The OS process is gone at this point even if later archival/notification
    // bookkeeping throws, so shutdown must be allowed to finish.
    live.resolveExit();
    live.meta.status = 'exited';
    // node-pty reports exitCode 0 when a process dies by SIGNAL and carries the
    // number separately, so an agent that was killed or crashed was recorded —
    // and shown — as having "exited cleanly". 128+signal is the shell's own
    // convention for the same fact.
    live.meta.exitCode = typeof signal === 'number' && signal > 0 ? 128 + signal : exitCode;
    live.meta.endedAt = Date.now();
    const unrecordedRecovery = Boolean(live.exactRecovery && !live.exactRecovery.historyRecorded);
    if (unrecordedRecovery && !live.exactRecovery?.bootstrapFailure) {
      live.exactRecovery!.bootstrapFailure = 'Codex exited before recovery reached its ready prompt. Wanigan left Recent history unchanged.';
    }
    if (unrecordedRecovery) {
      settleExactRecovery(live, new Error(live.exactRecovery!.bootstrapFailure!));
    }
    if (!unrecordedRecovery) {
      try {
        db().prepare('UPDATE session_log SET ended_at = ?, exit_code = ? WHERE id = ?')
          .run(live.meta.endedAt, exitCode, id);
      } catch { /* db closing during quit */ }
    }
    // The final tree snapshot, queued before any teardown below can alter the
    // worktree. Kept as a promise so worktree removal can wait for it.
    const checkpointsSettled = finalizeSessionCheckpoints(id);

    // The startup discovery window can elapse before a slow TUI accepts its
    // first prompt. Give the durable Codex index one final bounded pass after
    // exit so a fast successful task still lands in exact Recent history.
    if (live.meta.harnessId === 'codex' && !live.meta.conversationId
        && (live.codexCapturingIdentity || Boolean(opts.initialPrompt?.trim()))) {
      captureCodexIdentityAfterPrompt(live, cwd);
      void discoverCodexThreadId(id, cwd, meta.createdAt).then((threadId) => {
        if (!threadId) return;
        live.meta.conversationId = threadId;
        broadcast('session:list', sessionListEntries());
      }).catch(() => {});
    }

    // Sessions are killed on quit by design; their transcripts should not die
    // with them. Archiving here is the only moment the file is guaranteed to
    // exist and be complete.
    if (!unrecordedRecovery && flags().archiveTranscripts) {
      try { archiveSession(id, live.meta.projectPath, live.meta.conversationId ?? null); }
      catch { /* an unreadable transcript must never fail a session exit */ }
    }
    // Keep the session directory. It starts as an attachment staging area but
    // is also the only writable non-project directory granted to the agent, so
    // agents legitimately place reports and generated assets there and link
    // them from their final answer. Deleting it on exit destroys those results
    // and turns an intact saved conversation into a page of dead links.
    try { cleanupHookSettings(id); } catch { /* nothing to remove */ }
    try { cleanupMcpConfig(mcpFile, id); } catch { /* nothing to remove */ }
    if (unrecordedRecovery) {
      // This directory is Wanigan's fresh staging area, not an artifact from
      // the selected historical Codex session. It is safe to remove because no
      // recovered writer reached a usable prompt.
      try { cleanupSessionAttachments(id); } catch { /* already absent */ }
    }
    // An exited session is classified from its exit code, never from output
    // recency, so this stamp is dead the moment the process is. Left behind it
    // is one map entry per session for as long as the app stays open.
    forgetSession(id);

    // Hook-capable providers normally announce Stop first. Providers without
    // hooks (and abrupt process failures) have no other main-process event that
    // can tell the notification layer they ended. The shared dedupe in
    // notify.ts makes the hook + exit pair one alert rather than two.
    if (!unrecordedRecovery) {
      try { exitObserver?.(live.meta); } catch { /* notification policy cannot fail PTY cleanup */ }
    }

    // An isolated worktree with no changes is disk cost and nothing else. The
    // session-end checkpoint is captured first — removal must never race the
    // snapshot that makes this session's last state recoverable.
    if (worktree) {
      checkpointsSettled.finally(() => {
        void removeWorktree(worktree, false).catch(() => {
          /* dirty worktrees are kept on purpose — the human reviews and merges */
        });
      });
    }

    broadcast('session:exit', { sessionId: id, exitCode });
    broadcast('session:list', sessionListEntries());
  });

  if (opts.initialPrompt?.trim()) {
    const prompt = opts.initialPrompt.trim();
    if (def.harness === 'codex') {
      submitInitialCodexPrompt(live, cwd, prompt);
    } else {
      // Non-Codex TUIs do not redraw their composer during startup.
      setTimeout(() => {
        try { proc.write(prompt + '\r'); } catch { /* exited already */ }
      }, 1500);
    }
  }

  broadcast('session:list', sessionListEntries());
  return meta;
}

type SessionLogRow = Record<string, string | number | null>;

function savedConversationId(row: SessionLogRow): string | null {
  const id = row.conversation_id;
  return typeof id === 'string' && id.trim() ? id : null;
}

/**
 * Conversation IDs belong to harnesses, not presentation profiles. This keeps
 * a thread from appearing twice after a provider-pack rename or migration.
 */
function conversationKey(row: SessionLogRow, conversationId: string): string {
  const stored = typeof row.harness_id === 'string' && row.harness_id.trim()
    ? row.harness_id
    : null;
  // `harness_id` was added after Wanigan had already saved Codex/Claude
  // records. Their built-in provider IDs are reliable migration aliases; a
  // generic/third-party profile remains scoped to its own opaque provider ID.
  const legacy = String(row.provider_id);
  const harness = stored
    ?? (legacy === 'codex' ? 'codex' : legacy === 'claude' || legacy === 'glm' ? 'claude-code' : `provider:${legacy}`);
  return `${harness}:conversation:${conversationId}`;
}

/**
 * A process cannot survive a deliberate Wanigan quit, but a hard app crash can
 * leave its execution row looking live forever. There is no live PTY map on a
 * new main-process boot, so close those old execution records before Recent is
 * calculated. A durable conversation ID remains resumable; only its last
 * execution receives the interrupted (-1) outcome.
 */
export function reconcileAbandonedSessions(now = Date.now()): number {
  try {
    return db().prepare(`
      UPDATE session_log
         SET ended_at = ?, exit_code = -1
       WHERE origin = 'wanigan' AND ended_at IS NULL
    `).run(now).changes;
  } catch {
    return 0;
  }
}

/**
 * One entry per durable, exact-resume conversation. Historical rows that never
 * received a conversation ID are kept for telemetry and archives, but are not
 * offered as Recent: opening Codex's broad picker cannot safely identify which
 * conversation the row meant and was the source of duplicate/wrong resumes.
 */
export function pastSessions(limit = 40): PastSession[] {
  try { backfillCodexThreadIds(); }
  catch (e) { console.warn('[wanigan] Codex session identity backfill skipped:', e); }
  // Exited tabs can remain open for inspection, but they have no writer. Hiding
  // them from Recent made a completed conversation disappear until the person
  // manually closed its tab, despite being perfectly safe to resume.
  const openIds = new Set(
    [...sessions.values()]
      .filter((value) => value.meta.status !== 'exited')
      .map((value) => value.meta.id)
  );
  const rows = db().prepare(
    "SELECT * FROM session_log WHERE origin = 'wanigan' ORDER BY started_at DESC"
  ).all() as SessionLogRow[];
  const newest = new Map<string, SessionLogRow>();
  const counts = new Map<string, number>();
  const openLineages = new Set<string>();
  for (const row of rows) {
    const conversationId = savedConversationId(row);
    if (!conversationId) continue;
    const key = conversationKey(row, conversationId);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (!newest.has(key)) newest.set(key, row); // query is newest first
    if (openIds.has(String(row.id))) openLineages.add(key);
  }

  // Lifecycle flags are presentation state; a broken read costs ordering,
  // never the list itself.
  const flags = new Map<string, { pinnedAt: number | null; settledAt: number | null }>();
  try {
    const flagRows = db().prepare('SELECT key, pinned_at, settled_at FROM conversation_flags')
      .all() as Array<{ key: string; pinned_at: number | null; settled_at: number | null }>;
    for (const f of flagRows) {
      flags.set(String(f.key), {
        pinnedAt: f.pinned_at == null ? null : Number(f.pinned_at),
        settledAt: f.settled_at == null ? null : Number(f.settled_at),
      });
    }
  } catch { /* pre-migration database during quit */ }
  const flagsOf = (key: string) => flags.get(key) ?? { pinnedAt: null, settledAt: null };

  const entries = [...newest.entries()]
    // A failed duplicate launch can be newer than the still-running writer.
    // Exclude a conversation whenever any execution of it is currently live.
    .filter(([key]) => !openLineages.has(key));
  // Pins survive the cap — a pinned conversation that ages past forty newer
  // ones is exactly the one the pin exists to keep. The other sections are
  // capped separately so the settled shelf cannot crowd out active rows.
  const pinned = entries.filter(([key]) => flagsOf(key).pinnedAt != null);
  const active = entries.filter(([key]) => flagsOf(key).pinnedAt == null && flagsOf(key).settledAt == null).slice(0, limit);
  const settled = entries.filter(([key]) => flagsOf(key).pinnedAt == null && flagsOf(key).settledAt != null).slice(0, limit);

  return [...pinned, ...active, ...settled]
    .map(([key, r]) => ({
      id: String(r.id),
      conversationId: savedConversationId(r),
      providerId: String(r.provider_id) as PastSession['providerId'],
      projectId: r.project_id ? String(r.project_id) : null,
      projectPath: String(r.project_path),
      projectName: String(r.project_name),
      worktree: r.worktree ? String(r.worktree) : null,
      model: r.model ? String(r.model) : null,
      effort: r.effort ? String(r.effort) : null,
      permissionMode: r.permission_mode ? String(r.permission_mode) : null,
      startedAt: Number(r.started_at),
      endedAt: r.ended_at ? Number(r.ended_at) : null,
      exitCode: r.exit_code === null ? null : Number(r.exit_code),
      continuationCount: counts.get(key) ?? 1,
      live: fs.existsSync(String(r.project_path)),
      pinnedAt: flagsOf(key).pinnedAt,
      settledAt: flagsOf(key).settledAt,
      title: r.title ? String(r.title) : null,
    }));
}

/**
 * The name a session wears, from the launch prompt it was started with. First
 * line only, whitespace collapsed — a sentence is a name, a pasted diff is
 * not. The prompt was redacted before it was stored, so the title is too.
 */
export function deriveSessionTitle(initialPrompt: string | null): string | null {
  if (!initialPrompt) return null;
  const line = initialPrompt.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const compact = line.replace(/\s+/g, ' ').trim();
  if (!compact) return null;
  return compact.length > 80 ? `${compact.slice(0, 79)}…` : compact;
}

/** Renaming is durable: it writes the row, not a per-machine label. */
export function renameSession(id: string, rawTitle: unknown): boolean {
  if (typeof rawTitle !== 'string') throw new Error('A session name must be text.');
  const title = rawTitle.replace(/\s+/g, ' ').trim().slice(0, 120) || null;
  const res = db().prepare("UPDATE session_log SET title = ? WHERE id = ? AND origin = 'wanigan'").run(title, id);
  const live = sessions.get(id);
  if (live) live.meta.displayTitle = title;
  if (!res.changes && !live) {
    throw new Error('That session is no longer recorded, so it cannot be renamed.');
  }
  if (live) broadcast('session:list', sessionListEntries());
  return true;
}

/**
 * Pin keeps a conversation above the fold; settle parks it in the shelf.
 * The two are exclusive by rule — "done" beats "keep on top" — so setting one
 * clears the other, and clearing both deletes the row rather than leaving a
 * flag that says nothing.
 */
export function setConversationFlag(id: string, flag: 'pin' | 'settle', on: boolean): PastSession[] {
  const row = db().prepare(`
    SELECT id, conversation_id, provider_id, harness_id
      FROM session_log
     WHERE id = ? AND origin = 'wanigan'
  `).get(id) as { conversation_id: string | null; provider_id: string; harness_id: string | null } | undefined;
  if (!row) throw new Error('That conversation is no longer recorded, so it cannot be pinned or settled.');
  const conversationId = typeof row.conversation_id === 'string' && row.conversation_id.trim()
    ? row.conversation_id
    : null;
  if (!conversationId) throw new Error('Only a resumable conversation can be pinned or settled.');
  const key = conversationKey(row, conversationId);

  const existing = db().prepare('SELECT pinned_at, settled_at FROM conversation_flags WHERE key = ?')
    .get(key) as { pinned_at: number | null; settled_at: number | null } | undefined;
  let pinnedAt = existing?.pinned_at ?? null;
  let settledAt = existing?.settled_at ?? null;
  const now = Date.now();
  if (flag === 'pin') {
    pinnedAt = on ? now : null;
    if (on) settledAt = null;
  } else {
    settledAt = on ? now : null;
    if (on) pinnedAt = null;
  }
  if (pinnedAt === null && settledAt === null) {
    db().prepare('DELETE FROM conversation_flags WHERE key = ?').run(key);
  } else {
    db().prepare(`
      INSERT INTO conversation_flags (key, pinned_at, settled_at) VALUES (?,?,?)
      ON CONFLICT(key) DO UPDATE SET pinned_at = excluded.pinned_at, settled_at = excluded.settled_at
    `).run(key, pinnedAt, settledAt);
  }
  return pastSessions();
}

export function forgetPastSession(id: string) {
  const row = db().prepare(`
    SELECT id, conversation_id, provider_id, harness_id
      FROM session_log
     WHERE id = ? AND origin = 'wanigan'
  `).get(id) as {
    conversation_id: string | null;
    provider_id: string;
    harness_id: string | null;
  } | undefined;
  if (!row) return;
  const conversationId = typeof row.conversation_id === 'string' && row.conversation_id.trim()
    ? row.conversation_id
    : null;
  if (!conversationId) {
    db().prepare('DELETE FROM session_log WHERE id = ?').run(id);
    forgetSessionCheckpoints(id);
    return;
  }
  // Reuse the exact grouping rule from Recent. In particular, an old Codex
  // root has no `harness_id` while its later continuations do; SQL predicates
  // that only inspect one spelling leave a ghost card behind after Forget.
  const key = conversationKey(row, conversationId);
  const candidates = db().prepare(`
    SELECT id, conversation_id, provider_id, harness_id
      FROM session_log
     WHERE origin = 'wanigan' AND conversation_id = ?
  `).all(conversationId) as SessionLogRow[];
  const ids = candidates
    .filter((candidate) => conversationKey(candidate, conversationId) === key)
    .map((candidate) => String(candidate.id));
  if (!ids.length) return;
  const remove = db().prepare('DELETE FROM session_log WHERE id = ?');
  db().transaction(() => {
    for (const candidateId of ids) remove.run(candidateId);
  })();
  // Forgetting a conversation forgets its evidence chain too: rows and the
  // hidden ref for every execution record that just left Recent — and its
  // lifecycle flag, which would otherwise sit keyed to nothing forever.
  for (const candidateId of ids) forgetSessionCheckpoints(candidateId);
  try { db().prepare('DELETE FROM conversation_flags WHERE key = ?').run(key); } catch { /* flag rows are advisory */ }
}

/**
 * The launch snapshot for a session, live or historical.
 *
 * The in-memory copy is the fast path, but a baseline that exists only in this
 * process answers "undo what this agent did" with "this session has no baseline
 * commit" after every restart — and loses the dirty list, which is what keeps
 * edits the operator had already made from being offered as the agent's work.
 */
export function sessionBaseline(sessionId: string): Baseline | null {
  const live = sessions.get(sessionId)?.meta.baseline;
  if (live) return live;
  let row: { baseline_head: string | null; baseline_dirty_json: string | null; started_at: number } | undefined;
  try {
    row = db().prepare(
      'SELECT baseline_head, baseline_dirty_json, started_at FROM session_log WHERE id = ?'
    ).get(sessionId) as typeof row;
  } catch { return null; /* the database is closing during quit */ }
  if (!row) return null;
  // A row written before these columns existed captured nothing. Answering it
  // with an empty dirty list would claim every pre-existing edit for the agent,
  // so an absent capture stays absent rather than becoming a confident zero.
  if (row.baseline_head === null && row.baseline_dirty_json === null) return null;
  let dirty: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.baseline_dirty_json ?? '[]');
    if (Array.isArray(parsed)) dirty = parsed.filter((value): value is string => typeof value === 'string');
  } catch { /* a corrupt list costs attribution, not the head commit a revert needs */ }
  // `started_at` is the launch stamp rather than the capture stamp; they are
  // milliseconds apart and no reader distinguishes them.
  return { head: row.baseline_head, dirty, at: row.started_at };
}

/** Scrollback for a pane that is being mounted or re-mounted. */
export function scrollback(sessionId: string): string {
  const s = sessions.get(sessionId);
  if (!s) return '';
  // The buffer is appended per chunk while sends are coalesced, so without this
  // it could hand a mounting pane bytes that no `session:data` message has
  // carried yet. Flushing first restores the invariant the pane relies on:
  // everything in the scrollback has already been broadcast.
  flushSessionData(s);
  return s.buffer;
}

export function writeSession(sessionId: string, data: string): boolean {
  if (!acceptsPtyInput(sessionId, data)) return false;
  const s = sessions.get(sessionId);
  if (!s || s.meta.status === 'exited') return false;
  s.proc.write(data);
  // A submitted line carries whatever was already typed, so any attachment
  // named in that prompt has now gone to the agent. Staged-but-unnamed files
  // are untouched: pressing Enter on an unrelated message does not send them.
  if (/[\r\n]/.test(data)) {
    try { markSessionAttachmentsSent(sessionId); }
    catch { /* the keystroke matters more than the bookkeeping */ }
  }
  if (s.meta.harnessId === 'codex' && /[\r\n]/.test(data)) {
    captureCodexIdentityAfterPrompt(s, s.meta.worktree ?? s.meta.projectPath);
  }
  // Codex's lifecycle channel announces the blocking/finished state but not the
  // operator's subsequent keystroke. Enter records only that the operator
  // responded; it must not invent a successful PostToolUse before the provider
  // has actually run anything. No typed content is retained.
  if (s.meta.harnessId === 'codex' && /[\r\n]/.test(data)) {
    if (s.providerAwaitingApproval) {
      s.providerAwaitingApproval = false;
      recordProviderEvent(sessionId, 'PermissionResponse');
    } else if (s.providerFinished) {
      s.providerFinished = false;
      recordProviderEvent(sessionId, 'UserPromptSubmit');
    }
  }
  return true;
}

/**
 * `/model` and `/effort` change the running CLI, but the CLI answers in its
 * own terminal — nothing flows back into this session's record. A remounted
 * control bar seeds from that record, so without this write-back it shows the
 * launch-time argv, not the level the session is actually running at. Record
 * the tuning only at the moment the command is really delivered to the PTY.
 */
export function setSessionTuning(sessionId: unknown, field: unknown, value: unknown): boolean {
  if (typeof sessionId !== 'string') return false;
  if (field !== 'model' && field !== 'effort') return false;
  if (typeof value !== 'string' || value.length === 0) return false;
  if (field === 'effort' && !(EFFORT_LEVELS as readonly string[]).includes(value)) return false;
  // A model id is one shell-safe token ('fable', 'glm-5.3', a full dotted id);
  // anything else does not belong in a slash command typed into a terminal.
  if (field === 'model' && !/^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,63}$/.test(value)) return false;
  const s = sessions.get(sessionId);
  if (!s || s.meta.status !== 'running' || s.meta.harnessId === 'codex') return false;
  if (!writeSession(sessionId, `/${field} ${value}\r`)) return false;
  s.meta[field] = value;
  // The command is already in the terminal; a history-row hiccup must not
  // roll back the live record the renderer will re-seed from on remount.
  try {
    db().prepare(`UPDATE session_log SET ${field === 'model' ? 'model' : 'effort'} = ? WHERE id = ?`)
      .run(value, sessionId);
  } catch { /* the row can be absent when the launch insert itself failed */ }
  broadcast('session:list', sessionListEntries());
  return true;
}

export function resizeSession(sessionId: string, cols: number, rows: number): boolean {
  if (!acceptsPtyResize(sessionId, cols, rows)) return false;
  const s = sessions.get(sessionId);
  if (!s || s.meta.status === 'exited') return false;
  try { s.proc.resize(cols, rows); } catch { return false; /* race with exit */ }
  return true;
}

export const __test = { acceptsPtyInput, acceptsPtyResize, agentEnv, redirectsAnthropicApi };

/**
 * Stop what the agent is doing without ending the session.
 *
 * Escape is what Claude Code itself listens for mid-turn, so this is the same
 * key a person would press — not a signal aimed at the process. Killing is a
 * different act with a different button, and conflating them loses the
 * conversation along with the runaway turn.
 */
export function interruptSession(sessionId: string, force = false) {
  const s = sessions.get(sessionId);
  if (!s || s.meta.status === 'exited') return false;
  try {
    // Ctrl+C is the escalation, and only on request: in Claude Code a second
    // one quits, so it is never what a single click should send.
    s.proc.write(force ? '\x03' : '\x1b');
    if (s.meta.harnessId === 'codex' && s.providerAwaitingApproval) {
      s.providerAwaitingApproval = false;
      recordProviderEvent(sessionId, 'PermissionResponse');
    }
    return true;
  } catch { return false; }
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
  broadcast('session:list', sessionListEntries());
}

export function markRead(sessionId: string) {
  const s = sessions.get(sessionId);
  if (s && s.meta.unread) { s.meta.unread = 0; broadcast('session:list', sessionListEntries()); }
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

/**
 * Stop every PTY and keep Electron alive until node-pty observes the exits.
 * A bounded SIGKILL escalation prevents a wedged CLI from making Quit hang
 * forever, while the ordinary path gives Codex time to release its writer lock
 * and flush the rollout before the parent process disappears.
 */
export async function shutdownAll(graceMs = 2000): Promise<void> {
  const active = [...sessions.values()].filter((value) => value.meta.status !== 'exited');
  if (!active.length) return;

  killAll();
  const settled = Promise.all(active.map((value) => value.exited));
  let timer: NodeJS.Timeout | null = null;
  const graceful = await Promise.race([
    settled.then(() => true),
    new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), graceMs); }),
  ]);
  if (timer) clearTimeout(timer);
  if (graceful) return;

  for (const value of active) {
    if (value.meta.status === 'exited') continue;
    try { value.proc.kill('SIGKILL'); } catch { /* already gone */ }
  }
  await Promise.race([
    settled,
    new Promise<void>((resolve) => setTimeout(resolve, 500)),
  ]);
}
