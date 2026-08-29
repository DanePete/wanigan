import type { IPty } from 'node-pty';
import { BrowserWindow } from 'electron';
import type { LaunchOptions, Session, ProviderId } from '../shared/types';
import {
  providerById, shellPath, detectProviders, refreshProviderPacks, runsClaudeCli,
} from './providers';
import { projectById } from './store';
import { db } from './db';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import type { PastSession } from '../shared/types';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Baseline, TrustLevel } from '../shared/types';
import { otelEnv } from './otel';
import { writeHookSettings, cleanupHookSettings, recordProviderEvent } from './hooks';
import { archiveSession } from './transcripts';
import { createWorktree, removeWorktree } from './worktrees';
import { trustFor } from './policy';
import { writeMcpConfig } from './mcp/registry';
import { noteOutput, forgetSession } from './attention';
import { flags, learningSettings } from './settings';
import { attachmentsDir, cleanupSessionAttachments, prepareAttachmentDir } from './attachments';
import { buildBriefing } from './learning';
import {
  backfillCodexThreadIds, captureNewCodexThreadId, codexThreadIdForSession, discoverCodexThreadId,
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
 * Telemetry and hooks are how Wanigan knows anything about a running agent, and
 * both are set here rather than asked of the user, because Wanigan spawns the
 * CLI and therefore owns its environment. Content logging stays off: prompt and
 * response text are redacted by default and Wanigan does not opt in.
 */
function agentEnv(PATH: string, sessionId: string, providerEnv: Record<string, string> = {}): Record<string, string> {
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
  return out;
}

type Live = {
  meta: Session;
  proc: IPty;
  buffer: string;
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
  /** Settles only after node-pty reports the child gone. */
  exited: Promise<void>;
  resolveExit: () => void;
};

const sessions = new Map<string, Live>();
/** Covers the synchronous spawn boundary before the new Live row is visible. */
const resumingConversations = new Set<string>();
let broadcast: (channel: string, payload: unknown) => void = () => {};

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
    if (live.meta.status === 'exited' || live.meta.conversationId) {
      live.codexCapturingIdentity = false;
      return;
    }
    try {
      const threadId = captureNewCodexThreadId(live.meta.id, cwd, promptAt, 10_000, live.meta.createdAt);
      if (threadId) {
        live.meta.conversationId = threadId;
        live.codexCapturingIdentity = false;
        broadcast('session:list', listSessions());
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
    if (now < deadline) setTimeout(trySubmit, 150);
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
 * How coarse the "still talking" stamp may be. The attention queue only ever
 * compares it against a ninety-second idle threshold, and onData fires per
 * chunk — hundreds of times a second while an answer streams — so a reading
 * per chunk buys nothing any reader can see.
 */
const OUTPUT_NOTE_MS = 1000;

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

export async function createSession(opts: LaunchOptions): Promise<Session> {
  let def = providerById(opts.providerId);
  if (!def) throw new Error(`Unknown provider: ${opts.providerId}`);
  const project = projectById(opts.projectId);
  if (!project) throw new Error('Project not found — it may have been removed.');

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

  const resuming = opts.resumeFrom;
  let conversationId = resuming?.conversationId ?? null;
  let codexResumeNeedsPicker = false;
  if (resuming && def.harness === 'codex') {
    // Never let a stale renderer payload decide which Codex thread to open.
    // The durable row is backfilled from Codex's own index/rollout and becomes
    // the identity used for both duplicate-writer checks and argv.
    conversationId = codexThreadIdForSession(resuming.sessionId);
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
  } else if (!resuming && def.supports.resume && runsClaudeCli(def)) {
    conversationId = randomUUID();
  }

  const idArgs = resuming
    ? def.resumeArgs(conversationId)
    : conversationId ? ['--session-id', conversationId] : [];

  // Trust is resolved once, at launch, and travels with the session — a policy
  // that can change under a running agent is a policy nobody can reason about.
  const trust: TrustLevel = trustFor(project.id);

  // A worktree keeps parallel agents off each other's working tree. It lives
  // outside the repo so the agent never trips over it in its own file listings.
  let worktree: string | null = null;
  if (opts.isolate) {
    try {
      const wt = await createWorktree(project.path, project.name, id0);
      worktree = wt.path;
    } catch (e) {
      throw new Error(
        `Could not create an isolated worktree for ${project.name}: ` +
        `${e instanceof Error ? e.message : String(e)}`
      );
    }
  }
  const cwd = worktree ?? project.path;

  // Attachments arrive after a session has started, so the directory must
  // exist and be granted to the CLI before its sandbox is created. Granting
  // this one session directory is deliberately narrower than granting all of
  // Wanigan's user-data directory.
  const attachmentDir = prepareAttachmentDir(id);

  // Hook config and MCP servers are injected with --settings / --mcp-config,
  // which take a path. That is what keeps Wanigan out of the user's repository:
  // nothing is written into .claude/, and nothing the user shares in git changes.
  const injected: string[] = [];
  if (runsClaudeCli(def) && harnessProven) {
    if (flags().hooks && detected.capabilities.hooks) {
      // Learning is injected directly below. Keeping it out of SessionStart
      // avoids duplicate context while preserving trust/policy hook output.
      const settingsFile = writeHookSettings(id0, cwd);
      if (settingsFile) injected.push('--settings', settingsFile);
    }
    if (detected.capabilities.mcp) {
      const mcpFile = writeMcpConfig(project.id, cwd);
      if (mcpFile) injected.push('--mcp-config', mcpFile);
    }
  }

  // Attachment directory flags belong to harnesses, not provider ids. A
  // manifest-only generic CLI must never receive a guessed flag and exit before
  // its first prompt.
  const artifactDirs = [
    attachmentDir,
    ...(resuming ? priorArtifactDirs(resuming.sessionId) : []),
  ].filter((value, index, all) => all.indexOf(value) === index);
  const attachmentArgs = harnessProven && (def.harness === 'claude-code' || def.harness === 'codex')
    ? artifactDirs.flatMap((dir) => ['--add-dir', dir])
    : [];
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
  const resumeCodex = !!resuming && def.harness === 'codex';
  const args = [
    ...idArgs, ...injected, ...attachmentArgs, ...learnedArgs, ...lifecycleArgs,
    ...def.launchArgs(extra, {
    ...opts.providerOptions,
    model: resumeCodex ? undefined : opts.model || undefined,
    effort: resumeCodex ? undefined : def.supports.effort ? opts.effort || undefined : undefined,
    permissionMode: def.supports.permissionMode ? opts.permissionMode || undefined : undefined,
    }),
  ];
  const baseline = await captureBaseline(cwd);

  // No await occurs between this digest/trust revalidation and pty.spawn.
  // A provider disabled or modified while project/worktree setup was running
  // must never launch through the stale definition captured above.
  refreshProviderPacks();
  const finalDef = providerById(opts.providerId);
  if (!finalDef || finalDef.profileFingerprint !== def.profileFingerprint) {
    try { cleanupSessionAttachments(id); } catch { /* launch never started */ }
    throw new Error(`${def.label} changed or was disabled before launch. Review the provider pack and try again.`);
  }

  const resumeKey = resuming && conversationId
    ? `${def.harness}:${conversationId}`
    : null;
  if (resumeKey) {
    const alreadyOpen = [...sessions.values()].some((value) =>
      value.meta.harnessId === def.harness
      && value.meta.conversationId === conversationId
      && value.meta.status !== 'exited');
    if (alreadyOpen || resumingConversations.has(resumeKey)) {
      try { cleanupSessionAttachments(id); } catch { /* launch never started */ }
      throw new Error('That conversation is already opening or open in Wanigan. Use its existing tab.');
    }
    resumingConversations.add(resumeKey);
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

  let proc: IPty;
  try {
    proc = pty.spawn(resolvedBin, args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 32,
      cwd,
      env: agentEnv(PATH, id, def.env?.() ?? {}),
    });
  } catch (e) {
    if (resumeKey) resumingConversations.delete(resumeKey);
    try { cleanupSessionAttachments(id); } catch { /* launch never started */ }
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
  try {
    db().prepare(`
      INSERT INTO session_log (id, conversation_id, provider_id, project_id, project_path,
                               project_name, model, effort, permission_mode, started_at,
                               resumed_from, worktree, trust, bin, capabilities_json,
                               provider_pack_id,provider_pack_version,provider_profile_json,
                               backend_id,harness_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(id, conversationId, opts.providerId, project.id, project.path, project.name,
           meta.model ?? null, meta.effort ?? null, meta.permissionMode ?? null,
           meta.createdAt, resuming?.sessionId ?? null, worktree, trust, resolvedBin,
           detected?.capabilities ? JSON.stringify(detected.capabilities) : null,
           def.packId, def.packVersion, JSON.stringify(meta.providerProfile), def.backendId, def.harness);
  } catch (e) {
    if (resumeKey) resumingConversations.delete(resumeKey);
    try { proc.kill(); } catch { /* do not orphan an unrecorded writer */ }
    try { cleanupSessionAttachments(id); } catch { /* launch was not recorded */ }
    const detail = e instanceof Error ? e.message : String(e);
    throw new Error(`The agent started, but Wanigan could not record its session (${detail}). It was stopped.`);
  }
  let resolveExit = () => {};
  const exited = new Promise<void>((resolve) => { resolveExit = resolve; });
  const live: Live = {
    meta,
    proc,
    buffer: '',
    lastDataAt: Date.now(),
    notedAt: 0,
    providerControl: '',
    providerAwaitingApproval: false,
    providerFinished: false,
    codexCapturingIdentity: false,
    exited,
    resolveExit,
  };
  sessions.set(id, live);
  if (resumeKey) resumingConversations.delete(resumeKey);

  if ((!resuming || codexResumeNeedsPicker) && def.harness === 'codex') {
    void discoverCodexThreadId(id, cwd, meta.createdAt).then((threadId) => {
      if (!threadId) {
        console.warn(`[wanigan] exact Codex thread id was not discovered for session ${id}`);
        return;
      }
      const current = sessions.get(id);
      if (current) current.meta.conversationId = threadId;
      broadcast('session:list', listSessions());
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
          recordProviderEvent(id, 'PermissionRequest', 'Waiting for your approval.', now);
        } else {
          live.providerAwaitingApproval = false;
          live.providerFinished = true;
          recordProviderEvent(id, 'Stop', 'Turn complete.', now);
        }
      }
    }
    broadcast('session:data', { sessionId: id, data });
  });

  proc.onExit(({ exitCode }) => {
    // The OS process is gone at this point even if later archival/notification
    // bookkeeping throws, so shutdown must be allowed to finish.
    live.resolveExit();
    live.meta.status = 'exited';
    live.meta.exitCode = exitCode;
    live.meta.endedAt = Date.now();
    try {
      db().prepare('UPDATE session_log SET ended_at = ?, exit_code = ? WHERE id = ?')
        .run(live.meta.endedAt, exitCode, id);
    } catch { /* db closing during quit */ }

    // Sessions are killed on quit by design; their transcripts should not die
    // with them. Archiving here is the only moment the file is guaranteed to
    // exist and be complete.
    if (flags().archiveTranscripts) {
      try { archiveSession(id, live.meta.projectPath, live.meta.conversationId ?? null); }
      catch { /* an unreadable transcript must never fail a session exit */ }
    }
    // Keep the session directory. It starts as an attachment staging area but
    // is also the only writable non-project directory granted to the agent, so
    // agents legitimately place reports and generated assets there and link
    // them from their final answer. Deleting it on exit destroys those results
    // and turns an intact saved conversation into a page of dead links.
    try { cleanupHookSettings(id); } catch { /* nothing to remove */ }
    // An exited session is classified from its exit code, never from output
    // recency, so this stamp is dead the moment the process is. Left behind it
    // is one map entry per session for as long as the app stays open.
    forgetSession(id);

    // Hook-capable providers normally announce Stop first. Providers without
    // hooks (and abrupt process failures) have no other main-process event that
    // can tell the notification layer they ended. The shared dedupe in
    // notify.ts makes the hook + exit pair one alert rather than two.
    try { exitObserver?.(live.meta); } catch { /* notification policy cannot fail PTY cleanup */ }

    // An isolated worktree with no changes is disk cost and nothing else.
    if (worktree) {
      void removeWorktree(worktree, false).catch(() => {
        /* dirty worktrees are kept on purpose — the human reviews and merges */
      });
    }

    broadcast('session:exit', { sessionId: id, exitCode });
    broadcast('session:list', listSessions());
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

  broadcast('session:list', listSessions());
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
  const openIds = new Set(sessions.keys());
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

  return [...newest.entries()]
    // A failed duplicate launch can be newer than the still-running writer.
    // Exclude a conversation whenever any execution of it is currently live.
    .filter(([key]) => !openLineages.has(key))
    .slice(0, limit)
    .map(([key, r]) => ({
      id: String(r.id),
      conversationId: savedConversationId(r),
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
      continuationCount: counts.get(key) ?? 1,
      live: fs.existsSync(String(r.project_path)),
    }));
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
}

export function resizeSession(sessionId: string, cols: number, rows: number) {
  const s = sessions.get(sessionId);
  if (!s || s.meta.status === 'exited') return;
  if (cols > 0 && rows > 0) {
    try { s.proc.resize(cols, rows); } catch { /* race with exit */ }
  }
}

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
