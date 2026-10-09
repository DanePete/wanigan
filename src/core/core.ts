// The composition root: one database, one board, one terminal supervisor, two sockets.
import packageJson from '../../package.json' with { type: 'json' };
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Provider } from '../shared/model.ts';
import { CoreError } from '../shared/protocol.ts';
import { Accounts, type Prober, type UsageReader } from './accounts.ts';
import { AgentFolders, type AgentFolderLimits } from './agent-folders.ts';
import { Board } from './board.ts';
import type { BriefingLimits } from './briefing.ts';
import { configReadLimits, type ConfigReadLimits } from './config-read.ts';
import { Checkpoints } from './checkpoints.ts';
import { History, type HistoryLimits } from './history.ts';
import { Reviews } from './review.ts';
import { Phone, type PhoneOptions } from './phone/phone.ts';
import { Live, type LiveOptions } from './live.ts';
import { LocalModels, type LocalModelsOptions } from './local-models.ts';
import { Models, type CodexModelReader } from './models.ts';
import { Tokens } from './tokens.ts';
import { Jev, type JevOptions } from './jev.ts';
import { Chat } from './chat.ts';
import { Attachments } from './attachments.ts';
import { CodexHooks, type CodexHookProbe } from './codex-hooks.ts';
import { Bus, type Ctx } from './context.ts';
import { openDatabase, type DB } from './db.ts';
import { createHandlers, dispatch, type Handlers } from './handlers.ts';
import { computeNeeds } from './needs.ts';
import { setGitEnvironment } from './git.ts';
import { writeGeminiHome, writeHookFiles } from './hooks.ts';
import { CoreServer } from './server.ts';
import { Sessions } from './sessions.ts';
import { Skills } from './skills.ts';
import { Mcp } from './mcp.ts';
import type { McpAgent } from '../shared/mcp.ts';
import { shellQuote } from './hooks.ts';
import { corePaths, type CorePaths } from './paths.ts';
import { stopHeadless } from './headless.ts';

export { corePaths, type CorePaths } from './paths.ts';

export const CORE_VERSION = packageJson.version;
const LEASE_SWEEP_MS = 30_000;

export interface CoreOptions {
  dataDir: string;
  now?: () => number;
  /** How the `wanigan` shim runs the CLI: the runtime and the entry script. */
  cli?: { runtime: string; entry: string };
  launcher?: (provider: Provider, path: string) => { file: string; args: string[] } | null;
  log?: (line: string) => void;
  /** Test seams: where account folders are looked for, and how a CLI is asked who it is. */
  accounts?: { home?: string; prober?: Prober; usageReader?: UsageReader };
  /** Test seam: what Codex says its models are, in place of asking the installed CLI. */
  codexModels?: CodexModelReader;
  /** Test seam: the claude and codex executables MCP changes and checks run. */
  mcpBinaries?: Partial<Record<McpAgent, string>>;
  /** Test seam: the claude executable that AI review, drafting and Talk to Wanigan run. */
  claudeBinary?: string;
  /** This core runs the demo: sample projects and stand-in agents. */
  demo?: boolean;
  /** Test seam: the gh executable a pull request is opened with (null: not installed). Left out, it is found on the login PATH. */
  ghBinary?: string | null;
  /** Test seams and the demo: a stand-in System One, and the key the environment provides. */
  jev?: Omit<JevOptions, 'dataDir'>;
  /** Test seam: the caps on reading where the agents have worked. */
  agentFolders?: Partial<AgentFolderLimits>;
  /** Test seam: lower History discovery limits; never exposed through settings or RPC. */
  historyLimits?: Partial<HistoryLimits>;
  /** Test seam: lower complete session-briefing limits; never settings or RPC. */
  briefingLimits?: Partial<BriefingLimits>;
  /** Test seam: lower aggregate Skills/MCP read limits; never settings or RPC. */
  configReadLimits?: Partial<ConfigReadLimits>;
  /** Test seams for models on this Mac: a stand-in `lms` (or null for none) and Ollama's address. */
  local?: Omit<LocalModelsOptions, 'home'>;
  /** Test seam and the demo: the PATH the live view looks for ddev on (and runs it with). Left out, the login shell's. */
  live?: LiveOptions;
  /** Phone access: where the page is built, and test seams (a stand-in Tailscale, a port, a push service). */
  phone?: Partial<Pick<PhoneOptions, 'rendererDir' | 'port' | 'tailscale' | 'pushFetch'>>;
  /** Test seam: how long a message waits for Claude Code to show the images pasted before it. */
  imageWaitMs?: number;
  /** Test seam: how Codex is asked about Wanigan's hooks. Null launches Codex without hooks and says nothing (tests, the demo). */
  codexHookProbe?: CodexHookProbe | null;
  /**
   * Variables every git the core runs gets (the demo's and the tests': no
   * global config, their own identity). Left out, git reads the owner's own
   * config, so their commits carry their name and signature.
   */
  gitEnv?: Record<string, string>;
  /** Which build this core is (paths.ts buildOf), as `core.hello` reports it. */
  build?: string | null;
  /** The daemon exits after an idle replacement has shut its core down. */
  onIdleStop?: () => void;
}

export class Core {
  readonly paths: CorePaths;
  readonly db: DB;
  readonly bus = new Bus();
  readonly board: Board;
  readonly accounts: Accounts;
  readonly sessions: Sessions;
  readonly checkpoints: Checkpoints;
  readonly reviews: Reviews;
  readonly history: History;
  readonly jev: Jev;
  readonly chat: Chat;
  readonly attachments: Attachments;
  readonly skills: Skills;
  readonly mcp: Mcp;
  readonly local: LocalModels;
  readonly phone: Phone;
  readonly live: Live;
  private readonly demo: boolean;
  readonly handlers: Handlers;
  readonly server: CoreServer;
  private sweep: NodeJS.Timeout | null = null;
  private stopping: Promise<void> | null = null;
  private readonly lease = JSON.stringify({ pid: process.pid, instance: randomBytes(16).toString('hex'), started: processStarted(process.pid) });
  private readonly build: string | null;

  constructor(options: CoreOptions) {
    const readLimits = configReadLimits(options.configReadLimits);
    this.demo = options.demo ?? false;
    this.paths = corePaths(options.dataDir);
    this.build = options.build ?? null;
    for (const dir of [options.dataDir, this.paths.bin, join(this.paths.socket, '..')]) mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(join(this.paths.socket, '..'), 0o700);

    this.db = openDatabase(this.paths.database, (db) => this.claimStore(db));
    try {
      // Only the admitted core can change the process's git environment.
      setGitEnvironment(options.gitEnv ?? {});
      const ctx: Ctx = { db: this.db, now: options.now ?? Date.now, emit: this.bus.emit };
      this.board = new Board(ctx);
      this.accounts = new Accounts(ctx, { neutralDir: join(options.dataDir, 'probe'), ...options.accounts });
      mkdirSync(join(options.dataDir, 'probe'), { recursive: true });
      this.attachments = new Attachments(ctx, options.dataDir);
      const hookFiles = writeHookFiles(options.dataDir);
      this.checkpoints = new Checkpoints(ctx, this.board, { dataDir: options.dataDir });
      this.local = new LocalModels(ctx, { home: options.accounts?.home ?? homedir(), ...options.local });
      this.sessions = new Sessions(ctx, this.board, {
        checkpoints: this.checkpoints,
        localModels: this.local,
        geminiHome: () => writeGeminiHome(options.dataDir, hookFiles.relay, options.accounts?.home ?? homedir()),
        dataDir: options.dataDir,
        briefingLimits: options.briefingLimits,
        accounts: this.accounts,
        attachments: this.attachments,
        ...(options.imageWaitMs !== undefined ? { imageWaitMs: options.imageWaitMs } : {}),
        hookFiles,
        codexHooks: options.codexHookProbe === null ? null : new CodexHooks(hookFiles.relay, options.codexHookProbe),
        binDir: this.paths.bin,
        socketPath: this.paths.socket,
        hookSocketPath: this.paths.hookSocket,
        ...(options.launcher ? { launcher: options.launcher } : {}),
      });
      this.reviews = new Reviews(ctx, this.board, this.accounts, { claudeBinary: options.claudeBinary ?? null });
      this.jev = new Jev(ctx, this.board, { dataDir: options.dataDir, ...options.jev });
      this.history = new History(ctx, this.board, this.accounts, this.sessions, { dataDir: options.dataDir, limits: options.historyLimits });
      this.chat = new Chat(ctx, this.board, this.accounts, this.attachments, { dataDir: options.dataDir, claudeBinary: options.claudeBinary ?? null });
      const home = options.accounts?.home ?? homedir();
      this.skills = new Skills(ctx, this.accounts, this.board, { home, dataDir: options.dataDir, limits: readLimits });
      this.mcp = new Mcp(ctx, this.accounts, this.board, this.sessions, {
        home, neutralDir: join(options.dataDir, 'probe'), limits: readLimits, ...(options.mcpBinaries ? { binaries: options.mcpBinaries } : {}),
      });
      this.live = new Live(ctx, this.board, options.dataDir, options.live);
      this.phone = new Phone(ctx, {
        dataDir: options.dataDir,
        rendererDir: options.phone?.rendererDir ?? null,
        ...options.phone,
        call: (device, method, params) => dispatch(this.handlers, method, params, { role: 'phone', device }),
        onEvent: (listener) => this.bus.on(listener),
        onData: (listener) => this.sessions.onData(listener),
        needs: () => computeNeeds(ctx),
        ...(options.log ? { log: options.log } : {}),
      });
      this.handlers = createHandlers(ctx, this.board, this.sessions, this.accounts, this.reviews, this.jev, this.history, {
        version: CORE_VERSION, build: options.build ?? null, dataDir: options.dataDir, claudeBinary: options.claudeBinary ?? null, ghBinary: options.ghBinary,
        demo: options.demo ?? false,
        stopIfIdle: () => {
          const live = this.sessions.liveIds().size;
          const busy = this.sessions.terminalCount > live || this.server.inFlight > 1 || this.reviews.busy || this.chat.busy || this.jev.busy || this.local.busy;
          if (live || busy) return { stopping: false, live, busy };
          this.server.stopAfterReply();
          return { stopping: true, live: 0, busy: false };
        },
      }, this.chat, {
        skills: this.skills, mcp: this.mcp, models: new Models(this.accounts, options.codexModels, this.local), tokens: new Tokens(this.accounts),
        folders: new AgentFolders(ctx, this.accounts, { home, dataDir: options.dataDir, limits: options.agentFolders }),
        attachments: this.attachments, checkpoints: this.checkpoints, local: this.local, phone: this.phone, live: this.live,
      });
      this.server = new CoreServer({
        socketPath: this.paths.socket,
        hookSocketPath: this.paths.hookSocket,
        ownerToken: ownerToken(this.paths.ownerToken),
        handlers: this.handlers,
        bus: this.bus,
        sessions: this.sessions,
        log: options.log ?? (() => {}),
        onIdleStop: () => { void this.stop().then(() => options.onIdleStop?.()); },
      });
      if (options.cli) writeCliShim(this.paths.bin, options.cli.runtime, options.cli.entry);
    } catch (error) {
      // Construction can fail after admission (for example an unreadable token).
      // Leave no live-process lease behind when no core was actually created.
      this.db.prepare("DELETE FROM meta WHERE key = 'core-owner' AND value = ?").run(this.lease);
      this.db.close();
      throw error;
    }
  }

  private claimStore(db: DB): void {
    // openDatabase holds the write transaction before any migration or recovery.
    const row = db.prepare("SELECT value FROM meta WHERE key = 'core-owner'").get() as { value: string } | undefined;
    if (row) {
      let pid: unknown;
      let started: unknown;
      try { ({ pid, started } = JSON.parse(row.value) as { pid?: unknown; started?: unknown }); } catch { /* refuse below */ }
      if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) throw new CoreError('refused', 'The core ownership record is unreadable. Refusing to open a second core.');
      let exists = true;
      try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') exists = false; }
      const currentStart = exists && typeof started === 'string' ? processStarted(pid) : null;
      if (currentStart && currentStart !== started) exists = false; // pid reused after an exit or reboot
      if (exists) throw new CoreError('refused', `Another Wanigan core owns this store (pid ${pid}).`);
    }
    db.prepare("INSERT INTO meta (key, value) VALUES ('core-owner', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(this.lease);
  }

  async start(): Promise<void> {
    try {
      this.checkStartup();
      this.sessions.recover();
      this.reviews.recover();
      this.chat.recover();
      this.accounts.discover();
      // Who each account is signed in as is asked in the background; the UI shows
      // "checking" until the CLIs answer.
      void this.accounts.refresh();
      await this.server.listen();
      this.checkStartup();
      // The demo serves nothing to phones.
      if (!this.demo) await this.phone.start();
      this.checkStartup();
      this.sweep = setInterval(() => {
        this.board.sweepLeases(this.sessions.liveIds());
        // Some needs come from time passing (a session gone quiet), not from an event.
        if (this.sessions.liveIds().size) this.bus.emit('needs', {});
      }, LEASE_SWEEP_MS);
      this.sweep.unref();
      writeFileSync(this.paths.info, `${JSON.stringify({
        pid: process.pid, version: CORE_VERSION, build: this.build, socket: this.paths.socket, startedAt: Date.now(),
      }, null, 2)}\n`, { mode: 0o600 });
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  private checkStartup(): void {
    if (this.stopping) throw new CoreError('refused', 'Wanigan’s core is stopping. Start a new core instead.');
  }

  /** Live sessions keep the core alive; this is only for a deliberate shutdown. */
  stop(): Promise<void> {
    return this.stopping ??= this.shutdown();
  }

  private async shutdown(): Promise<void> {
    this.sessions.beginStop();
    this.accounts.stop();
    if (this.sweep) clearInterval(this.sweep);
    this.reviews.stopAll();
    this.chat.stopAll();
    this.local.stopAll();
    await this.phone.stop();
    stopHeadless();
    await this.sessions.stopAll();
    await this.server.close();
    await this.checkpoints.close();
    this.db.prepare("DELETE FROM meta WHERE key = 'core-owner' AND value = ?").run(this.lease);
    this.db.close();
  }
}

/** The owner's token: created once, readable only by this user. */
export function ownerToken(file: string): string {
  if (existsSync(file)) {
    const token = readFileSync(file, 'utf8').trim();
    if (token) return token;
  }
  const token = randomBytes(32).toString('base64url');
  writeFileSync(file, token, { mode: 0o600 });
  return token;
}

/** `wanigan` on every session's PATH. Nothing is installed globally or written into a repository. */
function writeCliShim(binDir: string, runtime: string, entry: string): void {
  const shim = `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${shellQuote(runtime)} ${shellQuote(entry)} "$@"\n`;
  writeFileSync(join(binDir, 'wanigan'), shim, { mode: 0o755 });
}

/** A pid may belong to another process after a crash or reboot. Only the start time is read. */
function processStarted(pid: number): string | null {
  try {
    return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 1_000, env: { ...process.env, LC_ALL: 'C', LANG: 'C' }, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null; // without proof that the owner exited, fail closed
  }
}
