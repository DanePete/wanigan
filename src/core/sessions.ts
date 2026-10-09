// Every terminal Wanigan starts is owned here, in the core, so closing or
// crashing the window never ends one. State comes from evidence: hook events for
// Claude Code and (when its version takes them trusted) Codex, Codex's OSC 9
// notifications otherwise, the process itself for everything.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as pty from 'node-pty';
import { ASKS_MAX, activityFor, nextState, permissionAsk, type HookInput } from '../shared/attention.ts';
import { CHATTER_TOOL, chatterAgent, chatterOf, encodeChatter } from '../shared/chatter.ts';
import { checkClaim } from '../shared/board.ts';
import { normalizeHook } from '../shared/agent-hooks.ts';
import { parseLocalModel, type LocalAgent } from '../shared/local-models.ts';
import type { LocalModels } from './local-models.ts';
import { modelArgs } from '../shared/models.ts';
import { delivery, type Delivery } from '../shared/attachments.ts';
import { CODEX_LIFECYCLE_ARGS, EMPTY_LINE, scanCodex, typeInto, type TypedLine } from '../shared/codex.ts';
import { limitResetsAt, usageLimitMessage, whyNotTarget } from '../shared/limits.ts';
import {
  LIVE_STATES, OWNER, PROVIDERS, SYSTEM, sessionActor,
  type Account, type CardSummary, type CardType, type Project, type Provider, type Session, type SessionEvent, type SessionState,
} from '../shared/model.ts';
import { CoreError } from '../shared/protocol.ts';
import { editedPaths } from '../shared/edits.ts';
import { applyAccount, rolloutIn, transcriptPath, type Accounts } from './accounts.ts';
import type { Board } from './board.ts';
import { BRIEFING_REFUSAL, BriefingRefused, briefingLimits, codexBriefing, hookBriefing, type BriefingFormat, type BriefingLimits } from './briefing.ts';
import type { Checkpoints } from './checkpoints.ts';
import type { Ctx } from './context.ts';
import { cleanEnv, folderMissing, isDir, loginPath, notInstalled, requireCli, which } from './environment.ts';
import type { CodexHooks } from './codex-hooks.ts';
import { claudeSettings, geminiChatSaved, type HookFiles } from './hooks.ts';
import { ensureWorktree, restoreWorktree, type EnsuredWorktree } from './worktrees.ts';
import { STARTUP_MS } from './needs.ts';
import { LIVE_SQL, SESSION_COLUMNS, toAsks, toSession, toSessionEvent, type SessionEventRow, type SessionRow } from './records.ts';
import { Scrollback } from './scrollback.ts';
import { Attachments } from './attachments.ts';
import { interruptedAt } from './claude-interrupt.ts';
import { withGitMutation } from './git-lock.ts';

const FLUSH_MS = 12;
const NO_HOOKS_AFTER_MS = 25_000;
const STOP_GRACE_MS = 4_000;
const MAX_EVENTS_PER_SESSION = 2_000;
/** How long a Codex launched with hooks has, after a prompt, to report it through them. */
const CODEX_HOOKS_WAIT_MS = 30_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A Claude session's display name: the card's key and as much of its title as reads in a picker. */
const NAME_MAX = 60;
/** How long to wait for Claude Code to show the images it was pasted before typing on regardless. */
const IMAGE_WAIT_MS = 8_000;
/** What Claude Code shows in its prompt for each image it attached (2.1.292: `[Image #${id}]`). */
/** How Claude Code shows an image it attached from a pasted path: `[Image #3]`. */
const IMAGE_MARKS = /\[Image #(\d+)\]/g;
/**
 * After the owner types into a Claude session mid-turn, when to look in its
 * transcript for a No or an Esc (no hook fires for either), and how far its
 * clock may differ from ours.
 */
const INTERRUPT_CHECKS_MS = [700, 2_500];
const CLOCK_SLACK_MS = 1_000;

interface Live {
  id: string;
  provider: Provider | null;
  /** An unfinished OSC 9 sequence carried between Codex output chunks. */
  osc: string;
  /** What the owner has typed into Codex since the last Enter. */
  typed: TypedLine;
  /** A sign-in terminal: not a session, has no row, belongs to no project. */
  utility: { onExit: (exitCode: number) => void } | null;
  /** Its record is deleted when it closes: a key may have been typed into it. */
  ephemeral?: boolean;
  process: pty.IPty;
  scrollback: Scrollback;
  pending: string;
  flush: NodeJS.Timeout | null;
  stopping: boolean;
  /** Why it was stopped, when there is more to say than "Stopped". */
  endNote: string | null;
  /** The project's setup command, when this shell is running it in a new worktree. */
  setup: string | null;
  /** Some lifecycle evidence has arrived: a hook, or for Codex an OSC 9 notification. */
  hooks: boolean;
  noHooksTimer: NodeJS.Timeout | null;
  /** A message is being typed in; the next waits for it. */
  delivering: boolean;
  /** The agent went idle while a message was being typed in: the next goes when typing ends. */
  idleWhileDelivering: boolean;
  /** The turn that just ended is being checkpointed; the next message waits for it. */
  recording: Promise<void> | null;
  /** Output being watched for a mark (Claude showing pasted images), and what to do when it shows. */
  watch: { want: number; seen: Set<string>; tail: string; done: () => void } | null;
  /** Codex was launched with Wanigan's hooks, trusted for this launch. */
  codexHooks: boolean;
  /** A hook event has come from the agent itself, through the relay. */
  relayed: boolean;
  /** Waiting for a Codex launched with hooks to report a prompt it was sent. */
  hookWait: NodeJS.Timeout | null;
  /** Gemini has started a turn: past its first screen (sign-in, folder trust), so the composer may type into it. */
  turned?: boolean;
  /** Looks in a Claude transcript for an interrupt, after the owner typed mid-turn. */
  interruptChecks?: NodeJS.Timeout[];
}

export interface SessionsOptions {
  /** Trusted test seam: lower complete briefing limits only. */
  briefingLimits?: Partial<BriefingLimits>;
  dataDir: string;
  accounts: Accounts;
  hookFiles: HookFiles;
  /** Directory put first on every session's PATH; holds the `wanigan` CLI shim. */
  binDir: string;
  socketPath: string;
  hookSocketPath: string;
  /** Files the owner attaches to messages. */
  attachments: Attachments;
  /** Models on this Mac: makes a local model ready and says how to launch an agent on it. */
  localModels?: Pick<LocalModels, 'prepare'>;
  /** Wanigan's Gemini home, its hooks written fresh: what GEMINI_CLI_HOME points at. */
  geminiHome?: () => string;
  /** Test seam: replace how a provider is launched. */
  launcher?: (provider: Provider, path: string) => { file: string; args: string[] } | null;
  /** Test seam: how long to wait for Claude Code to show pasted images. */
  imageWaitMs?: number;
  /** How a Codex launch gets Wanigan's hooks trusted; null launches Codex without them and says nothing (tests, the demo). */
  codexHooks?: CodexHooks | null;
  /** Records each agent session's folder when it starts and when each turn ends. */
  checkpoints?: Checkpoints;
}

export type DataListener = (sessionId: string, seq: number, data: string) => void;

export class Sessions {
  private readonly live = new Map<string, Live>();
  /** Cards whose session is being started right now: one start per card at a time. */
  private readonly starting = new Set<string>();
  /** Conversations being resumed or forked right now: each one starts once. */
  private readonly carrying = new Set<string>();
  /** Set once the core is shutting down; late process callbacks are ignored. */
  private closed = false;
  /** Refuse launches as soon as shutdown starts, while exits can still be recorded. */
  private stopping = false;
  private readonly dataListeners = new Set<DataListener>();
  private readonly scrollbackDir: string;

  private readonly ctx: Ctx;
  private readonly board: Board;
  private readonly options: SessionsOptions;
  private readonly briefingLimits: Readonly<BriefingLimits>;

  constructor(ctx: Ctx, board: Board, options: SessionsOptions) {
    this.ctx = ctx;
    this.board = board;
    this.options = options;
    this.briefingLimits = briefingLimits(options.briefingLimits);
    this.scrollbackDir = join(options.dataDir, 'scrollback');
    mkdirSync(this.scrollbackDir, { recursive: true });
  }

  /** On startup, nothing from a previous core is still attached. Say so plainly. */
  recover(): void {
    const { db } = this.ctx;
    // Older cores persisted sign-in terminals but gave them no session row.
    // Such utility output must not survive a crash either.
    for (const file of readdirSync(this.scrollbackDir)) {
      if (/^signin-[0-9a-f-]+\.log(?:\.tmp)?$/i.test(file)) Scrollback.remove(join(this.scrollbackDir, file));
    }
    const orphans = db.prepare(
      `SELECT * FROM sessions WHERE state IN (${LIVE_SQL})`,
    ).all() as SessionRow[];
    for (const row of orphans) {
      db.prepare("UPDATE sessions SET state = 'interrupted', ended_at = ?, activity = ? WHERE id = ?")
        .run(this.ctx.now(), 'Wanigan’s core restarted and this process was lost', row.id);
      this.board.releaseAllHeldBy(row.id, 'interrupted');
      this.options.attachments.dropUnsent(Attachments.session(row.id));
      // A terminal a key may have been typed into keeps no record, even when the core died before it closed.
      if (row.ephemeral) Scrollback.remove(this.scrollbackFile(row.id));
      this.board.log({ projectId: row.project_id, cardId: row.card_id, sessionId: row.id, actor: SYSTEM, verb: 'marked a session interrupted', detail: row.title });
    }
    if (orphans.length) this.ctx.emit('needs', {});
  }

  onData(listener: DataListener): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  /** All PTYs, including account sign-in terminals without a board session. */
  get terminalCount(): number { return this.live.size; }

  /** Live agent sessions (sign-in terminals are not sessions). */
  liveIds(): Set<string> {
    return new Set([...this.live.values()].filter((l) => !l.utility).map((l) => l.id));
  }

  list(params: { projectId?: string; live?: boolean }): Session[] {
    const where: string[] = [];
    const values: unknown[] = [];
    if (params.projectId) { where.push('project_id = ?'); values.push(params.projectId); }
    if (params.live) where.push(`state IN (${LIVE_SQL})`);
    const sql = `SELECT ${SESSION_COLUMNS} FROM sessions s ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY started_at DESC LIMIT 300`;
    return (this.ctx.db.prepare(sql).all(...values) as SessionRow[]).map(toSession);
  }

  get(id: string): Session {
    return toSession(this.row(id));
  }

  events(id: string, limit = 400): SessionEvent[] {
    return (this.ctx.db.prepare('SELECT * FROM session_events WHERE session_id = ? ORDER BY id DESC LIMIT ?')
      .all(id, limit) as SessionEventRow[]).map(toSessionEvent).reverse();
  }

  /**
   * A terminal for signing an account in: the agent CLI with that account's
   * folder, in the owner's home, belonging to no project. When it exits the
   * account is checked again.
   */
  async startSignIn(accountId: string, cols?: number, rows?: number): Promise<{ terminalId: string }> {
    this.assertOpen();
    const account = this.options.accounts.get(accountId);
    const { bin: file, path } = await requireCli(account.provider);
    this.assertOpen();
    const env: Record<string, string> = { ...cleanEnv(process.env), PATH: path, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
    applyAccount(env, account.provider, account);
    const args = account.provider === 'codex' ? ['login'] : [];
    const id = `signin-${randomUUID()}`;
    const child = pty.spawn(file, args, {
      name: 'xterm-256color', cols: clampInt(cols, 20, 500, 100), rows: clampInt(rows, 5, 300, 28), cwd: homedir(), env,
    });
    const live: Live = {
      id, provider: null, osc: '', typed: EMPTY_LINE, utility: { onExit: () => { void this.options.accounts.check(this.options.accounts.get(accountId)); } },
      process: child, scrollback: new Scrollback(null), pending: '', flush: null, stopping: false, endNote: null, setup: null, hooks: false, noHooksTimer: null,
      delivering: false, idleWhileDelivering: false, recording: null, watch: null,
      codexHooks: false, relayed: false, hookWait: null,
    };
    this.live.set(id, live);
    child.onData((data) => this.output(live, data));
    child.onExit(({ exitCode, signal }) => this.exited(live, exitCode, signal));
    return { terminalId: id };
  }

  /** Who a token belongs to. Only the hash is stored. */
  byToken(token: string): Session | null {
    const row = this.ctx.db.prepare(`SELECT ${SESSION_COLUMNS} FROM sessions s WHERE token_hash = ?`).get(hashToken(token)) as SessionRow | undefined;
    return row ? toSession(row) : null;
  }

  async start(params: {
    projectId: string; provider: Provider; cardId?: string | null; accountId?: string | null; title?: string; cols?: number; rows?: number;
    /** What is typed here may be a secret: keep no record of it once the terminal closes. */
    ephemeral?: boolean;
    /** The model and effort to run, or the CLI's own default. Validated by the handler. */
    model?: string | null;
    effort?: string | null;
    /** Continue this Claude conversation or Codex thread, by id, in the account it lives in. */
    resume?: string;
    /** The rollout of the Codex thread being resumed, when it is known. */
    transcript?: string;
    /** Continue a Claude transcript from another account's folder as a fork with a new id. */
    fork?: string;
    /** Run here rather than in the project folder: the project folder or one of its card worktrees. */
    cwd?: string;
    /** The live session this one takes over from; it inherits that session's claim on the card. */
    handoff?: string;
    /** Give the card its own branch and worktree (default: the project's setting). */
    isolate?: boolean;
    /** Claude Code only: start it with Remote Control. Validated by the handler. */
    remote?: boolean;
  }): Promise<Session> {
    if (!PROVIDERS.includes(params.provider)) throw new CoreError('invalid', `Provider must be one of ${PROVIDERS.join(', ')}.`);
    const { project, card } = this.checkStart(params.projectId, params.cardId ?? null, params.handoff);
    if (params.cwd && params.cwd !== project.path && !params.cwd.startsWith(`${join(this.options.dataDir, 'worktrees', project.id)}/`)) {
      throw new CoreError('invalid', 'A session runs in its project folder or one of its card worktrees.');
    }
    const account = this.options.accounts.resolve(project.id, params.provider, params.accountId);
    // A conversation carried on runs once: checked and reserved before anything
    // is awaited, so a double click on Resume cannot start two agents on it.
    const conversation = params.resume ?? params.fork ?? null;
    if (conversation) {
      const running = this.list({ projectId: project.id, live: true }).some((s) => s.conversationId === conversation);
      if (running || this.carrying.has(conversation)) throw new CoreError('refused', 'That conversation is already running, or starting, in another session.');
    }
    if (card) {
      if (this.starting.has(card.id)) throw new CoreError('refused', `A session is already starting on ${card.key}.`);
      this.starting.add(card.id);
    }
    if (conversation) this.carrying.add(conversation);
    try {
      // A git operation that already checked this checkout is quiet completes
      // before a new PTY can start reading it. Worktrees share the same queue.
      return await withGitMutation(project.path, () => {
        const current = this.checkStart(project.id, card?.id ?? null, params.handoff);
        return this.spawnSession(params, current.project, current.card, account);
      });
    } finally {
      if (card) this.starting.delete(card.id);
      if (conversation) this.carrying.delete(conversation);
    }
  }

  private assertOpen(): void {
    if (this.stopping || this.closed) throw new CoreError('refused', 'Wanigan’s core is shutting down. Start the session after it restarts.');
  }

  /** Recheck after waiting: pause, close and card ownership can change meanwhile. */
  private checkStart(projectId: string, cardId: string | null, handoff?: string): { project: Project; card: CardSummary | null } {
    this.assertOpen();
    const project = this.board.project(projectId);
    if (project.archivedAt !== null) throw new CoreError('refused', `${project.name} is closed. Open its folder again to start sessions.`);
    if (this.board.pausedAt(project.id) !== null) throw new CoreError('refused', `${project.name} is paused. Resume it to start sessions.`);
    const card = cardId ? this.board.card(cardId) : null;
    if (card && card.projectId !== project.id) throw new CoreError('invalid', 'That card belongs to another project.');
    if (card?.live && card.live.sessionId !== handoff) throw new CoreError('refused', `${card.key} already has a live session. Open it instead.`);
    if (card && card.status !== 'review' && card.status !== 'done') {
      const refusal = checkClaim(card, handoff ?? '', this.ctx.now(), true);
      if (refusal) throw new CoreError('refused', refusal.message);
    }
    return { project, card };
  }

  /**
   * Where an earlier session ran, so carrying its conversation on runs there
   * too: its transcript is filed by folder, and a card's branch is where its
   * work is. A missing worktree may be restored through its current card;
   * otherwise the conversation must not silently move to another checkout.
   */
  private whereItRan(old: Session, project: Project, cardId: string | null): { cwd?: string; isolate?: boolean } {
    if (!old.cwd) return {};
    if (old.cwd === project.path) return { isolate: false };
    const worktrees = `${join(this.options.dataDir, 'worktrees', project.id)}/`;
    if (old.cwd.startsWith(worktrees)) {
      if (existsSync(old.cwd)) return { cwd: old.cwd };
      if (cardId && this.board.card(cardId).worktree?.path === old.cwd) return {};
    }
    throw new CoreError('refused', `This conversation’s folder is missing or no longer belongs to this project: ${old.cwd}. Restore its original folder before continuing.`);
  }

  private async spawnSession(
    params: {
      provider: Provider; title?: string; cols?: number; rows?: number; resume?: string; fork?: string; cwd?: string; handoff?: string; isolate?: boolean;
      model?: string | null; effort?: string | null; ephemeral?: boolean; remote?: boolean; transcript?: string;
      /** A shell that runs this one command (the project's worktree setup) and ends. */
      setup?: string;
    },
    project: Project, card: CardSummary | null, account: Account | null,
  ): Promise<Session> {
    this.assertOpen();
    const { db } = this.ctx;
    const briefed = !params.setup && params.provider !== 'shell';
    const briefingFormat = params.provider === 'codex' ? 'codex' : 'hook';
    // Refuse before worktree creation, hook probing, model preparation or a PTY.
    // It is checked again after awaits, using the final card/worktree contents.
    if (briefed) this.briefingText(project.id, card?.id ?? null, briefingFormat);
    // The folder first: a command started in a missing one fails as if the
    // command were missing.
    const folder = params.cwd ?? project.path;
    if (!isDir(folder)) throw folderMissing(folder, params.provider);
    // Then the CLI, before any branch or worktree is made for it to work in.
    const path = await loginPath();
    this.assertOpen();
    const launch = (this.options.launcher ?? defaultLauncher)(params.provider, path);
    if (!launch) throw params.provider === 'shell' ? new CoreError('refused', 'No shell was found to start.') : notInstalled(params.provider);
    // A card that has its own branch always works there; one that is asked to
    // (or whose project says so) gets it now.
    let worktree = card?.worktree ?? null;
    let fresh: EnsuredWorktree | null = null;
    if (card && worktree && !existsSync(worktree.path)) {
      fresh = await restoreWorktree(project.path, worktree, card.key);
      this.assertOpen();
      worktree = { path: fresh.path, branch: fresh.branch, base: fresh.base };
      this.board.setWorktree(card.id, worktree);
    }
    if (card && !worktree && (params.isolate ?? this.board.isolates(project.id))) {
      fresh = await ensureWorktree(project.path, join(this.options.dataDir, 'worktrees', project.id, card.key), card.key);
      this.assertOpen();
      worktree = { path: fresh.path, branch: fresh.branch, base: fresh.base };
      this.board.setWorktree(card.id, worktree);
    }
    if (card && fresh?.included.length) {
      this.board.log({
        projectId: project.id, cardId: card.id, actor: SYSTEM, verb: `copied ${fresh.included.length === 1 ? 'a file' : `${fresh.included.length} files`} named in .worktreeinclude`,
        detail: clip(fresh.included.join(', ')),
      });
    }
    const cwd = worktree?.path ?? params.cwd ?? project.path;

    // Codex reports through Wanigan's hooks when this version is known to take
    // them trusted; otherwise it starts exactly as before, on notifications.
    const hooked = params.provider === 'codex' && !params.setup && this.options.codexHooks
      ? await this.options.codexHooks.prepare(launch.file, path) : null;

    // A local model is made ready (its runtime running, the model loaded) before
    // the agent starts, so its first turn is not spent waiting on a load. A model
    // that is not there refuses here, never falls back to a cloud model.
    const localValue = !params.setup && (params.provider === 'claude' || params.provider === 'codex') && parseLocalModel(params.model) ? params.model as string : null;
    if (localValue && !this.options.localModels) throw new CoreError('refused', 'Local models are not available here.');
    const local = localValue ? await this.options.localModels!.prepare(localValue, params.provider as LocalAgent) : null;

    this.assertOpen();
    if (!params.setup) this.checkStart(project.id, card?.id ?? null, params.handoff);
    const briefing = briefed ? this.briefingText(project.id, card?.id ?? null, briefingFormat) : null;
    const id = randomUUID();
    const token = randomBytes(32).toString('base64url');
    // A new Claude conversation, or a fork, gets an id Wanigan chose, so it can be
    // resumed later. A resumed one keeps its id: same account, same transcript.
    const conversationId = params.provider === 'claude' ? (params.fork ? randomUUID() : params.resume ?? randomUUID())
      : params.provider === 'codex' || params.provider === 'gemini' ? params.resume ?? null : null;
    const title = (params.setup ? `Setup: ${params.setup}` : params.title?.trim() || (card ? card.title : `${providerName(params.provider)} · ${project.name}`)).slice(0, 120);
    const remote = params.provider === 'claude' && !params.setup && params.remote === true;
    // A login shell, so the owner's PATH and version managers apply to the setup command.
    const args = params.setup ? ['-l', '-c', params.setup] : [...launch.args];
    if (params.provider === 'codex') {
      // Codex is briefed at launch: its SessionStart hook, when it has one,
      // fires only as the first turn begins.
      if (params.resume) args.push('resume');
      args.push(...CODEX_LIFECYCLE_ARGS, ...(hooked?.args ?? []), '--config', codexBriefing(briefing ?? this.briefingText(project.id, card?.id ?? null, 'codex')));
      if (params.resume) args.push(params.resume);
    }
    // Gemini restarts itself with the same arguments when the owner trusts a new
    // folder, and refuses a --session-id it has already used: so its id is learnt
    // from its own hooks, as Codex's is, and only a resume names one.
    if (params.provider === 'gemini' && params.resume) args.push('--resume', params.resume);
    if (params.provider === 'claude') {
      // A new conversation gets an id Wanigan chose, so it can be resumed later.
      // A resumed one keeps its id: same account, same transcript. A fork reads
      // another account's transcript where it lies and writes its own under a
      // new id (the CLI allows --session-id beside --resume only with a fork).
      const conversation = params.resume ? ['--resume', params.resume]
        : params.fork ? ['--resume', params.fork, '--fork-session', '--session-id', conversationId as string]
          : ['--session-id', conversationId as string];
      args.push('--settings', claudeSettings(this.options.hookFiles), ...conversation);
      // Named after its card, so Claude's own /resume picker, prompt box and
      // terminal title say what it works on (`-n, --name`, in 2.1.292's --help).
      if (card) args.push('--name', clip(`${card.key} ${card.title}`, NAME_MAX));
      // Reachable from claude.ai and the Claude app, only because the owner asked
      // (`--remote-control [name]`, in 2.1.292's --help). Anthropic relays it.
      if (remote) args.push('--remote-control', ...remoteName(title));
    }
    if (!params.setup) args.push(...(local ? local.args : modelArgs(params.provider, params.model ?? null, params.effort ?? null)));
    const env: Record<string, string> = {
      ...cleanEnv(process.env),
      PATH: `${this.options.binDir}:${path}`,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      WANIGAN_SOCKET: this.options.socketPath,
      WANIGAN_HOOK_SOCKET: this.options.hookSocketPath,
      WANIGAN_TOKEN: token,
      WANIGAN_SESSION: id,
      WANIGAN_PROJECT: project.key,
      ...(card ? { WANIGAN_CARD: card.key } : {}),
    };
    applyAccount(env, params.provider, account);
    // Gemini reads Wanigan's hooks from Wanigan's own Gemini home; the login stays in the Keychain.
    if (params.provider === 'gemini' && this.options.geminiHome) env.GEMINI_CLI_HOME = this.options.geminiHome();
    if (local) {
      for (const name of local.unset) delete env[name];
      Object.assign(env, local.env);
    }

    const now = this.ctx.now();
    // A shell has no lifecycle to report; agents start, then say where they are.
    const initial: SessionState = params.provider === 'shell' ? 'running' : 'starting';
    const model = params.provider === 'shell' || params.setup ? null : params.model ?? null;
    const effort = params.provider === 'shell' || params.setup ? null : params.effort ?? null;
    const transcript = params.provider === 'codex' && params.resume ? params.transcript ?? null : null;
    db.prepare(`INSERT INTO sessions (id, project_id, card_id, provider, account_id, title, state, activity, conversation_id, token_hash, started_at, cwd, model, effort, remote, transcript_path, ephemeral)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, project.id, card?.id ?? null, params.provider, account?.id ?? null, title, initial, params.provider === 'shell' ? null : 'Starting', conversationId, hashToken(token), now, cwd, model, effort, remote ? 1 : 0, transcript, params.ephemeral ? 1 : 0);
    if (hooked?.why) this.note(id, `Hooks not used: ${hooked.why} Its state comes from Codex’s notifications instead.`);

    let child: pty.IPty | null = null;
    let scrollback: Scrollback | null = null;
    try {
      scrollback = new Scrollback(params.ephemeral ? null : this.scrollbackFile(id));
      child = pty.spawn(launch.file, args, {
        name: 'xterm-256color',
        cols: clampInt(params.cols, 20, 500, 120),
        rows: clampInt(params.rows, 5, 300, 32),
        cwd,
        env,
      });
      db.prepare('UPDATE sessions SET pid = ? WHERE id = ?').run(child.pid, id);
    } catch (error) {
      try { child?.kill('SIGKILL'); } catch { /* already gone */ }
      scrollback?.close();
      db.prepare("UPDATE sessions SET state = 'failed', pid = NULL, ended_at = ?, activity = ? WHERE id = ?")
        .run(this.ctx.now(), `Could not start: ${(error as Error).message}`, id);
      this.ctx.emit('sessions', { projectId: project.id, sessionId: id });
      throw new CoreError('internal', `Could not start ${providerName(params.provider)}: ${(error as Error).message}`);
    }

    const live: Live = {
      id, provider: params.provider, osc: '', typed: EMPTY_LINE, utility: null, ephemeral: params.ephemeral ?? false, process: child, scrollback, pending: '', flush: null,
      stopping: false, endNote: null, setup: params.setup ?? null, hooks: false, noHooksTimer: null, delivering: false, idleWhileDelivering: false, recording: null, watch: null,
      codexHooks: !!hooked?.args, relayed: false, hookWait: null,
    };
    this.live.set(id, live);
    child.onData((data) => this.output(live, data));
    child.onExit(({ exitCode, signal }) => this.exited(live, exitCode, signal));
    if (params.provider === 'claude' || params.provider === 'gemini') {
      // If no hook event ever arrives, say that the state is unknown rather than
      // leaving "starting" up forever.
      live.noHooksTimer = setTimeout(() => {
        if (!live.hooks && this.live.has(id)) this.update(id, { state: 'running', activity: 'No hook events received; live state unknown' });
      }, NO_HOOKS_AFTER_MS);
      live.noHooksTimer.unref();
    }
    if (params.provider !== 'shell' && !params.ephemeral && !params.setup) {
      // Needs you raises an agent that has not reported starting; say so on time, not at the next sweep.
      setTimeout(() => { if (this.live.has(id)) this.ctx.emit('needs', {}); }, STARTUP_MS + 100).unref();
    }

    this.board.log({ projectId: project.id, cardId: card?.id ?? null, sessionId: id, actor: OWNER, verb: params.setup ? 'started the worktree setup' : `started ${providerName(params.provider)}`, detail: title });
    // An agent's folder as it was before its first turn, so that turn's changes can be shown.
    if (params.provider !== 'shell' && !params.setup) this.options.checkpoints?.started(id);
    // The setup shell sits beside the card's worker; it never takes the claim.
    if (card && !params.setup && card.status !== 'review' && card.status !== 'done') {
      // A session started on a card is that card's worker: it takes the claim.
      // If that is refused now, the terminal is stopped rather than left running
      // on a card it does not hold.
      try {
        if (params.handoff && card.claim?.sessionId === params.handoff) this.board.handOver(card.id, params.handoff, id);
        else this.board.claim(id, card.id, undefined, true);
      } catch (error) {
        live.stopping = true;
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        db.prepare("UPDATE sessions SET state = 'failed', activity = ?, card_id = NULL WHERE id = ?").run(`Not started: ${(error as Error).message}`, id);
        throw error;
      }
    }
    // A new worktree has no node_modules or running services: the project's
    // setup command runs there now, beside the agent, where the owner sees it.
    if (card && fresh?.made && !params.setup) await this.startSetup(project, card.id, params);
    this.assertOpen();
    this.ctx.emit('sessions', { projectId: project.id, sessionId: id });
    this.ctx.emit('projects', {});
    return this.get(id);
  }

  /** The project's setup command as a shell session on the card, in its worktree. A failure to start it never stops the agent. */
  private async startSetup(project: Project, cardId: string, size: { cols?: number; rows?: number }): Promise<void> {
    const command = this.board.setupCommand(project.id);
    if (!command) return;
    try {
      await this.spawnSession({ provider: 'shell', setup: command, cols: size.cols, rows: size.rows }, project, this.board.card(cardId), null);
    } catch (error) {
      if (this.stopping || this.closed) return;
      this.board.log({ projectId: project.id, cardId, actor: SYSTEM, verb: 'could not start the worktree setup', detail: (error as Error).message });
    }
  }

  input(id: string, data: string): void {
    const live = this.mustLive(id);
    if (typeof data !== 'string' || data.length > 1_000_000) throw new CoreError('invalid', 'Input must be text under 1 MB.');
    live.process.write(data);
    if (live.provider === 'claude' && live.hooks) this.watchInterrupt(live);
    // Enter on an empty line or a /command is not a prompt.
    if (live.provider === 'codex') {
      const typed = typeInto(live.typed, data);
      live.typed = typed.line;
      if (typed.submitted) this.codexPrompted(live);
    }
  }

  /**
   * A PTY has one size, set by whoever shows it to fit (the session's own
   * view). A change is announced, so a terminal that only watches can follow.
   */
  resize(id: string, cols: number, rows: number): void {
    const live = this.mustLive(id);
    const c = clampInt(cols, 20, 500, 120);
    const r = clampInt(rows, 5, 300, 32);
    const changed = live.process.cols !== c || live.process.rows !== r;
    live.process.resize(c, r);
    if (changed && !live.utility) this.ctx.emit('pty.size', { sessionId: id, cols: c, rows: r });
  }

  /**
   * Everything shown so far, the sequence number later output continues from,
   * and the PTY's size (null once it has ended: there is no PTY to measure).
   */
  replay(id: string): { replay: string; seq: number; cols: number | null; rows: number | null } {
    const live = this.live.get(id);
    if (live) {
      this.drain(live);
      return { replay: live.scrollback.text(), seq: live.scrollback.seq, cols: live.process.cols, rows: live.process.rows };
    }
    if (id.startsWith('signin-')) return { replay: '', seq: 0, cols: null, rows: null };
    this.row(id);
    return { replay: Scrollback.read(this.scrollbackFile(id)), seq: 0, cols: null, rows: null };
  }

  /**
   * Where a session's recorded output is kept, for searching it; null while it
   * is a terminal a key may have been typed into (its record is removed when it closes).
   */
  outputFile(id: string): string | null {
    if (this.live.get(id)?.ephemeral) return null;
    const row = this.ctx.db.prepare('SELECT ephemeral FROM sessions WHERE id = ?').get(id) as { ephemeral: number } | undefined;
    return row?.ephemeral ? null : this.scrollbackFile(id);
  }

  stop(id: string, note?: string): void {
    const live = this.mustLive(id);
    live.stopping = true;
    live.endNote = note ?? null;
    live.process.kill('SIGHUP');
    setTimeout(() => {
      if (this.live.has(id)) {
        try { live.process.kill('SIGKILL'); } catch { /* already gone */ }
      }
    }, STOP_GRACE_MS).unref();
  }

  rename(id: string, title: string): Session {
    const t = title.trim();
    if (!t || t.length > 120) throw new CoreError('invalid', 'A session title is 1–120 characters.');
    this.update(id, { title: t });
    return this.get(id);
  }

  attach(id: string, cardId: string): Session {
    const session = this.get(id);
    const card = this.board.card(cardId);
    if (card.projectId !== session.projectId) throw new CoreError('invalid', 'That card belongs to another project.');
    const running = LIVE_STATES.has(session.state);
    if (running && card.live && card.live.sessionId !== id) {
      throw new CoreError('refused', `${card.key} already has a live session. Stop it first, or attach this one to another card.`);
    }
    const claims = running && this.board.pausedAt(card.projectId) === null && (card.status === 'inbox' || card.status === 'ready');
    if (claims) {
      const refusal = checkClaim(card, id, this.ctx.now(), true);
      if (refusal) throw new CoreError('refused', refusal.message);
    }
    this.ctx.db.prepare('UPDATE sessions SET card_id = ? WHERE id = ?').run(card.id, id);
    this.board.log({ projectId: card.projectId, cardId: card.id, sessionId: id, actor: OWNER, verb: 'attached a session', detail: session.title });
    if (claims) this.board.claim(id, card.id, undefined, true);
    this.ctx.emit('sessions', { projectId: session.projectId, sessionId: id });
    this.ctx.emit('board', { projectId: card.projectId, cardId: card.id });
    return this.get(id);
  }

  /**
   * Continue an ended Claude conversation or Codex thread in a new session:
   * same project, same account, same card. Re-sending the history is what a
   * resume costs, so this only ever happens when the owner asks.
   */
  async resume(id: string, size?: { cols?: number; rows?: number }): Promise<Session> {
    const old = this.get(id);
    if (old.provider === 'shell') throw new CoreError('refused', 'A shell has no conversation to resume.');
    if (!old.conversationId) throw new CoreError('refused', `${providerName(old.provider)} didn’t say which conversation this session was, so it can’t be resumed here.`);
    if (LIVE_STATES.has(old.state)) throw new CoreError('refused', 'This session is still running.');
    const resumedLive = this.list({ projectId: old.projectId, live: true }).find((s) => s.conversationId === old.conversationId);
    if (resumedLive) throw new CoreError('refused', 'That conversation is already running in another session.');
    if (old.provider === 'claude') {
      // Claude Code saves a conversation at its first prompt. Without one, --resume
      // would quietly open a new, empty conversation and call it this one.
      const { accounts } = this.options;
      const account = accounts.list().find((a) => a.id === old.accountId) ?? null;
      if (!transcriptPath(accounts.folder('claude', account), old.cwd ?? this.board.project(old.projectId).path, old.conversationId)) {
        throw new CoreError('refused', 'Claude Code saved nothing for this conversation, because it never got a prompt. Start a new session instead.');
      }
    }
    if (old.provider === 'gemini' && this.options.geminiHome && !geminiChatSaved(this.options.geminiHome(), old.conversationId)) {
      throw new CoreError('refused', 'Gemini saved nothing for this conversation, because it never got a prompt. Start a new session instead.');
    }
    let cardId = old.cardId;
    if (cardId) {
      const card = this.board.card(cardId);
      if (card.status === 'done' || card.status === 'archived' || card.live) cardId = null;
    }
    const session = await this.start({
      projectId: old.projectId, provider: old.provider, cardId, accountId: old.accountId, title: old.title, resume: old.conversationId, ...size,
      // Carry on as it was: the same model and effort, in the same folder, and
      // with Remote Control only if the owner chose it for this conversation.
      model: old.model, effort: old.effort, remote: old.remote, ...this.whereItRan(old, this.board.project(old.projectId), cardId),
      ...(old.transcriptPath ? { transcript: old.transcriptPath } : {}),
    });
    this.board.log({ projectId: old.projectId, cardId, sessionId: session.id, actor: OWNER, verb: 'resumed a conversation', detail: old.title });
    return session;
  }

  /**
   * Carry a Claude conversation on under another account: the CLI forks the
   * transcript where it lies (nothing is copied), the new session takes over
   * the card's claim, and the old one is stopped. Re-sending the conversation
   * is what this costs, on the new account, so only the owner asks for it.
   */
  async continueOn(id: string, accountId: string, size?: { cols?: number; rows?: number }): Promise<Session> {
    const old = this.get(id);
    if (old.provider !== 'claude' || !old.conversationId) throw new CoreError('refused', 'Only a Claude Code conversation can continue on another account.');
    const { accounts } = this.options;
    const all = accounts.list();
    const target = all.find((a) => a.id === accountId) ?? accounts.get(accountId);
    const from = all.find((a) => a.id === old.accountId) ?? null;
    const refusal = whyNotTarget(target, from);
    if (refusal) throw new CoreError('refused', refusal);
    const project = this.board.project(old.projectId);
    const cwd = old.cwd ?? project.path;
    const transcript = transcriptPath(accounts.folder('claude', from), cwd, old.conversationId);
    if (!transcript) throw new CoreError('refused', 'Claude Code has not saved this conversation yet, so there is nothing to continue.');
    const live = LIVE_STATES.has(old.state);
    let cardId = old.cardId;
    if (cardId) {
      const card = this.board.card(cardId);
      if (card.status === 'done' || card.status === 'archived' || (card.live && card.live.sessionId !== old.id)) cardId = null;
    }
    const session = await this.start({
      projectId: project.id, provider: 'claude', cardId, accountId: target.id, title: old.title, fork: transcript,
      // Run where the conversation ran: its transcript is filed by folder, and
      // a card's branch is where its work is. Same model and effort.
      ...this.whereItRan(old, project, cardId), model: old.model, effort: old.effort, remote: old.remote,
      ...(live ? { handoff: old.id } : {}), ...size,
    });
    this.board.log({
      projectId: project.id, cardId, sessionId: session.id, actor: OWNER, verb: 'continued the conversation on another account',
      detail: `${from?.label ?? 'Default'} → ${target.label}`,
    });
    if (live) this.stop(old.id, `Continued on ${target.label}`);
    return session;
  }

  /** Turn a one-off session into a card. Its history comes with it. */
  promote(id: string, type: CardType, title: string): CardSummary {
    const session = this.get(id);
    if (session.cardId) throw new CoreError('refused', 'This session already belongs to a card.');
    const card = this.board.createCard(OWNER, { projectId: session.projectId, type, title });
    this.attach(id, card.id);
    return this.board.card(card.id);
  }

  /** Mark a session's current state as seen by the owner, settling "waiting" and "failed" needs. */
  seen(id: string): void {
    this.row(id);
    this.ctx.db.prepare('UPDATE sessions SET seen_at = ? WHERE id = ?').run(this.ctx.now(), id);
    this.ctx.emit('needs', {});
    this.ctx.emit('projects', {});
  }

  /**
   * Queue a message for the agent, with any files waiting in its composer.
   * Agent sessions receive it when idle, after lifecycle evidence confirms
   * startup is past. A shell receives it immediately.
   */
  async queue(id: string, text: string, attachments: readonly string[] = []): Promise<number> {
    const session = this.get(id);
    const live = this.mustLive(id);
    if (session.provider === 'gemini' && !live.turned) {
      throw new CoreError('refused', 'Send your first message in the Gemini terminal: its first screen may ask you to sign in or to trust the folder. The composer works from the next message.');
    }
    if (session.provider === 'codex' && !live.hooks) {
      throw new CoreError('refused', 'Answer any startup questions and send your first message in the Codex terminal. Codex has not reported that it is ready for the composer yet.');
    }
    const message = text.replace(/\r\n/g, '\n').trim();
    if (!message && !attachments.length) throw new CoreError('invalid', 'Nothing to send.');
    if (attachments.length && session.provider === 'shell') throw new CoreError('refused', 'A shell takes no attachments.');
    this.ctx.db.transaction(() => {
      const queued = this.ctx.db.prepare('INSERT INTO queued_input (session_id, text, created_at) VALUES (?, ?, ?)').run(id, message, this.ctx.now());
      this.options.attachments.take(Attachments.session(id), attachments, { queuedId: Number(queued.lastInsertRowid) });
    })();
    // Agents that report their lifecycle get the message when they are next
    // idle; anything else gets it now. An idle agent's last turn is
    // checkpointed first (time-limited), so the message goes right after.
    // Claude always reports, through the hooks Wanigan gives it: until its
    // first one, it is starting (keys typed now are dropped, so the Enter is
    // lost) or asking whether to trust the folder (where Enter chooses "No,
    // exit"). Its message waits for that hook, even past the no-hooks fallback.
    const claudeNotReady = session.provider === 'claude' && !live.hooks;
    if (session.provider === 'shell' || session.state === 'waiting' || (!live.hooks && !claudeNotReady)) {
      if (live.recording) await live.recording;
      this.deliverNext(id);
    }
    this.ctx.emit('sessions', { projectId: session.projectId, sessionId: id });
    return this.pendingCount(id);
  }

  pendingCount(id: string): number {
    return (this.ctx.db.prepare('SELECT count(*) AS n FROM queued_input WHERE session_id = ? AND delivered_at IS NULL').get(id) as { n: number }).n;
  }

  /**
   * One hook event the agent itself sent through the relay. Returns what the
   * hook should print back to the agent (only Claude Code's SessionStart says
   * anything; Codex was briefed at launch).
   */
  hook(sessionId: string, event: string, input: HookInput): string {
    const live = this.live.get(sessionId);
    const provider = live?.provider ?? this.row(sessionId).provider;
    const n = normalizeHook(provider ?? '', event, input);
    if (!n) return '';
    if (live && provider === 'gemini' && n.event === 'UserPromptSubmit') live.turned = true;
    return this.apply(sessionId, n.event, n.input, true);
  }

  /** A lifecycle event, relayed by the agent's hook or read from its terminal. */
  private apply(sessionId: string, event: string, input: HookInput, relayed: boolean): string {
    const live = this.live.get(sessionId);
    let row = this.row(sessionId);
    if (live) {
      live.hooks = true;
      if (live.noHooksTimer) { clearTimeout(live.noHooksTimer); live.noHooksTimer = null; }
      if (relayed) {
        live.relayed = true;
        if (live.hookWait) { clearTimeout(live.hookWait); live.hookWait = null; }
      }
    }
    // Kept, so the window can tell an agent that says when a message starts a
    // turn from a Codex read only from its notifications (attention.ts replyRoute).
    if (relayed && live && !row.relayed) {
      this.ctx.db.prepare('UPDATE sessions SET relayed = 1 WHERE id = ?').run(sessionId);
      row = this.row(sessionId);
    }
    if (relayed && row.provider === 'codex' && this.learnThread(row, event, input)) row = this.row(sessionId);
    if (relayed && row.provider === 'gemini' && this.learnGemini(row, event, input)) row = this.row(sessionId);
    const prev = row.state as SessionState;
    // Codex starts its session as the first turn begins, not when it opens, so
    // its SessionStart says nothing about where it is.
    const codexStart = row.provider === 'codex' && event === 'SessionStart';
    const state = !live ? prev
      : codexStart ? (prev === 'running' || prev === 'starting' ? 'waiting' : prev)
        : nextState(prev === 'running' || prev === 'starting' ? 'waiting' : prev, event, input);
    const activity = codexStart ? null : activityFor(event, input);
    const now = this.ctx.now();
    const tool = typeof input.tool_name === 'string' ? input.tool_name : null;
    // One agent messaging another: PreToolUse is the moment it was sent (the
    // Post row would count it twice). The row keeps `to · label`, never the message.
    const chatter = event === 'PreToolUse' && tool === CHATTER_TOOL ? chatterOf(input.tool_input) : null;
    const edited = editedPaths(event, tool, input.tool_input, row.cwd);
    const eventId = Number(this.ctx.db.prepare('INSERT INTO session_events (session_id, at, event, tool, summary, path) VALUES (?, ?, ?, ?, ?, ?)')
      .run(sessionId, now, event, tool, chatter ? encodeChatter(chatter) : activity, edited[0] ?? null).lastInsertRowid);
    if (edited.length) {
      const insert = this.ctx.db.prepare('INSERT INTO session_edits (session_id, event_id, at, path) VALUES (?, ?, ?, ?)');
      for (const path of edited) insert.run(sessionId, eventId, now, path);
    }
    // The live view follows edits, and screenshots a card's page around its turns.
    const liveKind = edited.length ? 'edit' : event === 'UserPromptSubmit' ? 'turn-start'
      : event === 'Stop' || event === 'StopFailure' || event === 'Interrupted' ? 'turn-end'
        : event === 'SessionStart' && !codexStart ? 'session-start' : null;
    if (liveKind && live) this.ctx.emit('live', { projectId: row.project_id, sessionId, cardId: row.card_id, paths: edited, kind: liveKind, at: now });
    this.trimEvents(sessionId);
    // A hook that lands after the session ended is history, not news: it must
    // not rewrite why the session ended.
    if (!live) return '';
    // What the turn changed is recorded after this hook is answered, never before.
    if ((event === 'Stop' || event === 'StopFailure' || event === 'Interrupted') && this.options.checkpoints) {
      // The next message waits until this turn is recorded, so its edits never land in this turn's checkpoint.
      const recording: Promise<void> = this.options.checkpoints.turnEnded(sessionId, eventId)
        .finally(() => { if (live.recording === recording) live.recording = null; });
      live.recording = recording;
    }
    if (chatter) this.ctx.emit('chatter', { projectId: row.project_id, sessionId, from: row.title, agent: chatterAgent(input), to: chatter.to, label: chatter.label, at: now });

    const asking = state === 'permission' ? (prev === 'permission' ? row.asking_since : now) : null;
    const limitNews = this.noteLimit(row, prev, state, event, input, now);
    this.update(sessionId, { state, activity: activity ?? row.activity, lastEventAt: now, askingSince: asking, asks: this.asks(row, prev, state, event, input) });
    if (limitNews || (state !== prev && (state === 'permission' || prev === 'permission' || state === 'waiting' || prev === 'limited'))) this.ctx.emit('needs', {});
    if (state === 'waiting' && prev !== 'waiting') this.deliverNext(sessionId, true);
    if (event === 'SessionStart' && row.provider === 'claude') return this.briefing(sessionId);
    // Gemini shows a hook's plain output in its window; context goes back as JSON.
    if (event === 'SessionStart' && row.provider === 'gemini') {
      return this.briefing(sessionId);
    }
    return '';
  }

  /**
   * Which Codex thread a session is on, from its own hook: the thread it
   * started, or the one /new or /clear moved it to. The owner's prompt and the
   * session starting name the current thread; SessionEnd also fires for threads
   * the session left, so it only fills a gap. Returns whether anything changed.
   */
  private learnThread(row: SessionRow, event: string, input: HookInput): boolean {
    const id = typeof input.session_id === 'string' && UUID.test(input.session_id) ? input.session_id : null;
    const current = event === 'SessionStart' || event === 'UserPromptSubmit' || (event === 'SessionEnd' && !row.conversation_id);
    if (!id || !current) return false;
    const rollout = rolloutIn(this.codexHome(row.account_id), id, input.transcript_path);
    const transcript = rollout ?? (id === row.conversation_id ? row.transcript_path : null);
    if (id === row.conversation_id && transcript === row.transcript_path) return false;
    this.ctx.db.prepare('UPDATE sessions SET conversation_id = ?, transcript_path = ? WHERE id = ?').run(id, transcript, row.id);
    this.ctx.emit('sessions', { projectId: row.project_id, sessionId: row.id });
    return true;
  }

  /**
   * Which Gemini conversation a session is on, from its own hook: the one it
   * started, resumed, or /clear moved it to. On a resume, SessionStart names a
   * new, near-empty file; the prompt's hook names the real one.
   */
  private learnGemini(row: SessionRow, event: string, input: HookInput): boolean {
    const id = typeof input.session_id === 'string' && UUID.test(input.session_id) ? input.session_id : null;
    if (!id || (event !== 'SessionStart' && event !== 'UserPromptSubmit')) return false;
    const named = event === 'UserPromptSubmit' && typeof input.transcript_path === 'string' && input.transcript_path.endsWith('.jsonl') ? input.transcript_path : null;
    const transcript = named ?? (id === row.conversation_id ? row.transcript_path : null);
    if (id === row.conversation_id && transcript === row.transcript_path) return false;
    this.ctx.db.prepare('UPDATE sessions SET conversation_id = ?, transcript_path = ? WHERE id = ?').run(id, transcript, row.id);
    this.ctx.emit('sessions', { projectId: row.project_id, sessionId: row.id });
    return true;
  }

  /** The CODEX_HOME a session's account runs in. */
  private codexHome(accountId: string | null): string {
    let account: Account | null = null;
    if (accountId) { try { account = this.options.accounts.get(accountId); } catch { account = null; } }
    return this.options.accounts.folder('codex', account);
  }

  /**
   * The owner sent Codex a prompt. Hooks report that themselves. Without them,
   * Codex reports when a turn ends but not when one starts, so the prompt is
   * that start — once this Codex has shown it reports at all, so an older one
   * is never left "working" forever. Launched with hooks that have not yet
   * reported, a prompt is when they should: if none comes, the session goes on
   * notifications alone and its timeline says so.
   */
  private codexPrompted(live: Live): void {
    if (live.relayed) return;
    if (live.codexHooks) {
      if (live.hookWait) return;
      live.hookWait = setTimeout(() => {
        live.hookWait = null;
        if (live.relayed || !this.live.has(live.id)) return;
        live.codexHooks = false;
        this.note(live.id, 'Codex’s hooks did not report a prompt it was sent, so its state comes from its notifications from here on.');
      }, CODEX_HOOKS_WAIT_MS);
      live.hookWait.unref();
      return;
    }
    const state = live.hooks ? this.row(live.id).state : null;
    if (state === 'waiting' || state === 'permission') this.apply(live.id, 'UserPromptSubmit', {}, false);
  }

  /** A line in a session's timeline from Wanigan itself, not from the agent. */
  private note(id: string, text: string): void {
    this.ctx.db.prepare('INSERT INTO session_events (session_id, at, event, tool, summary, path) VALUES (?, ?, ?, NULL, ?, NULL)').run(id, this.ctx.now(), 'Wanigan', text);
    this.trimEvents(id);
    this.ctx.emit('sessions', { projectId: this.row(id).project_id, sessionId: id });
  }

  /**
   * Refuse new and finishing launches before shutdown awaits another service.
   * Existing children are still recorded and drained by stopAll.
   */
  beginStop(): void {
    this.stopping = true;
  }

  /**
   * Stop everything and wait until each process has actually exited and been
   * recorded, so nothing writes to the database after the core closes it.
   */
  async stopAll(timeoutMs = STOP_GRACE_MS + 2_000): Promise<void> {
    this.beginStop();
    const ids = [...this.live.keys()];
    for (const id of ids) {
      try { this.stop(id); } catch { /* already exiting */ }
    }
    const deadline = Date.now() + timeoutMs;
    while (this.live.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    this.closed = true;
  }

  /* ── internals ────────────────────────────────────────────────────────── */

  /**
   * Record when a session hit its usage limit and when that limit resets:
   * Claude's own message first, else the account's last limits reading.
   * Returns whether there is news for Needs you.
   */
  private noteLimit(row: SessionRow, prev: SessionState, state: SessionState, event: string, input: HookInput, now: number): boolean {
    const { db } = this.ctx;
    if (state !== 'limited') {
      if (prev === 'limited') db.prepare('UPDATE sessions SET limit_since = NULL, limit_resets_at = NULL WHERE id = ?').run(row.id);
      return false;
    }
    const message = usageLimitMessage(event, input);
    // Claude saying the reset came and it waits for Enter is news worth raising again.
    const reset = event === 'Notification' && input.notification_type === 'quota_auto_resume_stale';
    if (!message && !reset) return false;
    const resetsAt = message
      ? limitResetsAt(message, now) ?? this.options.accounts.limitResetFor(row.account_id, now)
      : Math.min(row.limit_resets_at ?? now, now);
    db.prepare('UPDATE sessions SET limit_since = ?, limit_resets_at = ? WHERE id = ?').run(now, resetsAt, row.id);
    return true;
  }

  /**
   * What the open permission requests ask, exactly, as the column keeps them.
   * Each PermissionRequest adds its own; anything that settles the request
   * clears them; a notification while asking leaves them as they are.
   */
  private asks(row: SessionRow, prev: SessionState, state: SessionState, event: string, input: HookInput): string | null {
    if (state !== 'permission') return null;
    const open = prev === 'permission' ? toAsks(row.asking) : [];
    const ask = event === 'PermissionRequest' ? permissionAsk(input.tool_name, input.tool_input) : null;
    const list = ask ? [...open, ask].slice(-ASKS_MAX) : open;
    return list.length ? JSON.stringify(list) : null;
  }

  private briefing(sessionId: string): string {
    const session = this.get(sessionId);
    try {
      return hookBriefing(this.briefingText(session.projectId, session.cardId, 'hook'));
    } catch (error) {
      if (!(error instanceof BriefingRefused)) throw error;
      // SessionStart already happened and the process is still live. Say that
      // its briefing was refused, without pretending a hook notice stops it.
      this.note(sessionId, BRIEFING_REFUSAL);
      this.board.log({ projectId: session.projectId, cardId: session.cardId, sessionId, actor: SYSTEM,
        verb: 'could not provide the session briefing', detail: BRIEFING_REFUSAL });
      return hookBriefing(BRIEFING_REFUSAL);
    }
  }

  /** Every instruction is admitted together; no partial board context is sent. */
  private briefingText(projectId: string, cardId: string | null, format: BriefingFormat): string {
    return this.board.briefing(projectId, cardId, this.briefingLimits, format);
  }

  private deliverNext(id: string, idle = false): void {
    const live = this.live.get(id);
    if (!live) return;
    if (live.recording) {
      void live.recording.then(() => this.deliverNext(id, idle));
      return;
    }
    if (live.delivering) {
      // Typing a message in takes a moment; an idle that arrives meanwhile is
      // kept, or the next message would wait for an idle that already passed.
      if (idle) live.idleWhileDelivering = true;
      return;
    }
    const next = this.ctx.db.prepare('SELECT * FROM queued_input WHERE session_id = ? AND delivered_at IS NULL ORDER BY id LIMIT 1')
      .get(id) as { id: number; text: string } | undefined;
    if (!next) return;
    const files = this.options.attachments.ofMessage(next.id);
    live.delivering = true;
    void this.typeIn(live, delivery(live.provider ?? 'shell', next.text, files)).finally(() => {
      live.delivering = false;
      const idled = live.idleWhileDelivering;
      live.idleWhileDelivering = false;
      // Without lifecycle events there is no idle to wait for: the next goes now.
      if (this.live.has(id) && (idled || live.provider === 'shell' || !live.hooks)) this.deliverNext(id);
    });
    this.ctx.db.prepare('UPDATE queued_input SET delivered_at = ? WHERE id = ?').run(this.ctx.now(), next.id);
    if (live.provider === 'codex') this.codexPrompted(live);
    const row = this.row(id);
    const sent = files.length ? ` (with ${files.map((f) => f.name).join(', ')})` : '';
    this.board.log({ projectId: row.project_id, cardId: row.card_id, sessionId: id, actor: OWNER, verb: 'sent a message', detail: clip(`${next.text || 'Files only'}${sent}`) });
    this.ctx.emit('sessions', { projectId: row.project_id, sessionId: id });
  }

  /**
   * Type one message in, as the owner would: each bracketed paste keeps a
   * multi-line message one message, and Enter submits it. Images go first, as
   * the agent takes a pasted image path; Claude Code reads them in the
   * background and drops an Enter pressed meanwhile, so the rest waits until it
   * shows them (or a while, if it never does: then the paths stay as text).
   */
  private async typeIn(live: Live, plan: Delivery): Promise<void> {
    // A paste is text, never keys: an escape inside it (a stray ESC[201~ copied
    // from a web page) would end the paste early and type the rest as keystrokes.
    const paste = (text: string): void => { if (this.live.has(live.id)) live.process.write(`\x1b[200~${text.replace(/[\x1b\x9b]/g, '')}\x1b[201~`); };
    if (plan.images.length) {
      const shown = plan.waitForImages ? this.shown(live, plan.waitForImages) : null;
      for (const images of plan.images) paste(images);
      if (shown) await shown;
    }
    if (plan.text) paste(plan.text);
    await new Promise((r) => setTimeout(r, 60).unref());
    if (this.live.has(live.id)) live.process.write('\r');
  }

  /**
   * Resolves when the terminal has shown `want` different `[Image #n]` marks
   * (one per image: Claude reads each in the background), or after the wait
   * runs out, or when it exits. A redraw of the same mark counts once.
   */
  private shown(live: Live, want: number): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => { clearTimeout(timer); if (live.watch?.done === done) live.watch = null; resolve(); };
      const timer = setTimeout(done, this.options.imageWaitMs ?? IMAGE_WAIT_MS);
      timer.unref();
      live.watch = { want, seen: new Set(), tail: '', done };
    });
  }

  private output(live: Live, data: string): void {
    if (this.closed) return;
    if (live.watch) {
      const text = live.watch.tail + data;
      for (const m of text.matchAll(IMAGE_MARKS)) live.watch.seen.add(m[1] as string);
      if (live.watch.seen.size >= live.watch.want) live.watch.done();
      else live.watch.tail = text.slice(-16);
    }
    if (live.provider === 'codex') this.codexLifecycle(live, data);
    if (live.provider === 'gemini') this.geminiTitle(live, data);
    live.pending += data;
    live.flush ??= setTimeout(() => this.drain(live), FLUSH_MS);
  }

  /**
   * The owner typed into a Claude session mid-turn: it may have been a No at a
   * permission prompt, or Esc. Claude Code fires no hook for either, so look
   * in its transcript shortly after for an interrupt newer than the keystroke.
   */
  private watchInterrupt(live: Live): void {
    const state = this.row(live.id).state;
    if (state !== 'working' && state !== 'permission') return;
    const keyed = Date.now();
    for (const timer of live.interruptChecks ?? []) clearTimeout(timer);
    live.interruptChecks = INTERRUPT_CHECKS_MS.map((ms) => {
      const timer = setTimeout(() => this.checkInterrupted(live, keyed), ms);
      timer.unref();
      return timer;
    });
  }

  private checkInterrupted(live: Live, keyed: number): void {
    if (this.closed || this.live.get(live.id) !== live) return;
    const row = this.row(live.id);
    if ((row.state !== 'working' && row.state !== 'permission') || !row.conversation_id) return;
    let account: Account | null = null;
    if (row.account_id) { try { account = this.options.accounts.get(row.account_id); } catch { account = null; } }
    const transcript = transcriptPath(this.options.accounts.folder('claude', account), row.cwd ?? this.board.project(row.project_id).path, row.conversation_id);
    const at = transcript ? interruptedAt(transcript) : null;
    if (at === null || at < keyed - CLOCK_SLACK_MS) return;
    for (const timer of live.interruptChecks ?? []) clearTimeout(timer);
    live.interruptChecks = [];
    this.apply(live.id, 'Interrupted', {}, false);
  }

  /**
   * Gemini's window title says Ready, Working or Action Required. No hook says
   * a permission was refused or a turn cancelled; the title going back to Ready
   * does, so a session asking or working that shows Ready is at its prompt.
   */
  private geminiTitle(live: Live, data: string): void {
    const text = live.osc + data;
    const re = /\x1b\][02];([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
    let last: string | null = null;
    let m: RegExpExecArray | null;
    let end = 0;
    while ((m = re.exec(text))) { last = m[1] ?? null; end = re.lastIndex; }
    const open = text.lastIndexOf('\x1b]');
    live.osc = open >= end && text.length - open < 400 ? text.slice(open) : '';
    if (last === null || !live.relayed) return;
    const state = this.row(live.id).state as SessionState;
    if (/^\s*◇/.test(last) && (state === 'working' || state === 'permission')) this.apply(live.id, 'Interrupted', {}, false);
  }

  private codexLifecycle(live: Live, data: string): void {
    if (!live.hooks && this.row(live.id).state === 'starting') {
      // Codex is up and at its prompt once it draws anything.
      this.update(live.id, { state: 'waiting', activity: 'At its prompt' });
    }
    const { pending, signals } = scanCodex(live.osc, data);
    live.osc = pending;
    for (const signal of signals) {
      // Once Codex's own hooks report, its Stop hook ends a turn. The approval
      // notification still marks a question, as Claude's Notification does.
      if (signal.kind === 'finished') { if (!live.relayed) this.apply(live.id, 'Stop', {}, false); }
      else this.apply(live.id, 'Notification', { notification_type: 'permission_prompt', message: signal.text }, false);
    }
  }

  private drain(live: Live): void {
    if (live.flush) { clearTimeout(live.flush); live.flush = null; }
    if (!live.pending) return;
    const data = live.pending;
    live.pending = '';
    const seq = live.scrollback.append(data);
    for (const listener of this.dataListeners) listener(live.id, seq, data);
  }

  private exited(live: Live, exitCode: number, signal?: number): void {
    if (this.closed) return;
    this.drain(live);
    live.scrollback.close();
    if (live.noHooksTimer) clearTimeout(live.noHooksTimer);
    if (live.hookWait) clearTimeout(live.hookWait);
    this.live.delete(live.id);
    live.watch?.done();
    if (live.utility) {
      Scrollback.remove(this.scrollbackFile(live.id));
      live.utility.onExit(exitCode);
      return;
    }
    if (live.ephemeral) Scrollback.remove(this.scrollbackFile(live.id));
    const row = this.row(live.id);
    // A process ended by a signal Wanigan did not send (a crash, the system
    // killing it) exits with code 0 and that signal: it failed all the same.
    const failed = !live.stopping && (exitCode !== 0 || Boolean(signal));
    const state: SessionState = failed ? 'failed' : 'ended';
    const how = live.endNote ?? (live.stopping ? 'Stopped'
      : live.setup ? `Setup “${clip(live.setup, 60)}” ${failed ? (signal ? `ended by signal ${signal}` : `failed with code ${exitCode}`) : 'finished'}`
        : failed ? (signal ? `Ended by signal ${signal}` : `Exited with code ${exitCode}`) : 'Exited');
    this.ctx.db.prepare('UPDATE sessions SET state = ?, exit_code = ?, ended_at = ?, activity = ?, asking_since = NULL, asking = NULL, limit_since = NULL, limit_resets_at = NULL WHERE id = ?')
      .run(state, exitCode, this.ctx.now(), how, live.id);
    this.board.releaseAllHeldBy(live.id, state);
    // Files still waiting in its composer can never be sent now.
    this.options.attachments.dropUnsent(Attachments.session(live.id));
    this.board.log({ projectId: row.project_id, cardId: row.card_id, sessionId: live.id, actor: sessionActor(live.id), verb: state === 'failed' ? 'failed' : 'ended', detail: how });
    this.ctx.emit('sessions', { projectId: row.project_id, sessionId: live.id });
    this.ctx.emit('needs', {});
    this.ctx.emit('projects', {});
    if (row.card_id) this.ctx.emit('board', { projectId: row.project_id, cardId: row.card_id });
  }

  private update(id: string, fields: {
    state?: SessionState; activity?: string | null; title?: string; lastEventAt?: number; askingSince?: number | null; asks?: string | null;
  }): void {
    const sets: string[] = [];
    const values: unknown[] = [];
    if (fields.state !== undefined) { sets.push('state = ?'); values.push(fields.state); }
    if (fields.activity !== undefined) { sets.push('activity = ?'); values.push(fields.activity); }
    if (fields.title !== undefined) { sets.push('title = ?'); values.push(fields.title); }
    if (fields.lastEventAt !== undefined) { sets.push('last_event_at = ?'); values.push(fields.lastEventAt); }
    if (fields.askingSince !== undefined) { sets.push('asking_since = ?'); values.push(fields.askingSince); }
    if (fields.asks !== undefined) { sets.push('asking = ?'); values.push(fields.asks); }
    if (!sets.length) return;
    this.ctx.db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
    const row = this.row(id);
    this.ctx.emit('sessions', { projectId: row.project_id, sessionId: id });
    if (row.card_id) this.ctx.emit('board', { projectId: row.project_id, cardId: row.card_id });
  }

  /**
   * Keep a session's newest events. Prompts are always kept: turns are numbered
   * by counting them, in the timeline and in each turn's checkpoint, so losing
   * old ones would renumber every turn after.
   */
  private trimEvents(id: string): void {
    const trimmed = this.ctx.db.prepare(`DELETE FROM session_events WHERE session_id = ? AND event != 'UserPromptSubmit' AND id <= (
      SELECT id FROM session_events WHERE session_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?)`).run(id, id, MAX_EVENTS_PER_SESSION);
    // The files an event recorded go with it.
    if (trimmed.changes) {
      this.ctx.db.prepare('DELETE FROM session_edits WHERE session_id = ? AND event_id NOT IN (SELECT id FROM session_events WHERE session_id = ?)').run(id, id);
    }
  }

  private row(id: string): SessionRow {
    const row = this.ctx.db.prepare(`SELECT ${SESSION_COLUMNS} FROM sessions s WHERE id = ?`).get(id) as SessionRow | undefined;
    if (!row) throw new CoreError('not_found', 'No such session.');
    return row;
  }

  private mustLive(id: string): Live {
    const live = this.live.get(id);
    if (!live) {
      if (id.startsWith('signin-')) throw new CoreError('refused', 'That sign-in has finished.');
      this.row(id);
      throw new CoreError('refused', 'This session has ended.');
    }
    return live;
  }

  private scrollbackFile(id: string): string {
    return join(this.scrollbackDir, `${id}.log`);
  }
}

function defaultLauncher(provider: Provider, path: string): { file: string; args: string[] } | null {
  if (provider === 'shell') {
    const shell = process.env.SHELL || '/bin/zsh';
    return { file: shell, args: ['-l'] };
  }
  const file = which(provider, path);
  return file ? { file, args: [] } : null;
}

export const providerName = (p: Provider): string => ({ claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', shell: 'Shell' })[p];

export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback;
}

const clip = (s: string, max = 140): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/**
 * The name Remote Control shows: the session's title. A name that began with a
 * dash would be read as the next flag, so leading dashes go; none left, no name.
 */
export function remoteName(title: string): string[] {
  const name = clip(title.replace(/^[\s-]+/, '').trim(), NAME_MAX);
  return name ? [name] : [];
}
