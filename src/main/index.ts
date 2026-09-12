import { app, BrowserWindow, ipcMain, dialog, shell, session, clipboard } from 'electron';
import type { WebContents, WebFrameMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  detectProviders, effectiveProviderBackendId, launchFieldsFor, missingCredentialIds, providerById, providerPackRegistry, refreshProviderPacks,
  runsClaudeCli, usesAnthropicAccount,
} from './providers';
import {
  initSessions, listSessions, createSession, writeSession, resizeSession,
  killSession, closeSession, scrollback, markRead, shutdownAll, sessionBaseline, interruptSession,
  pastSessions, forgetPastSession, recoverExactCodexThread, setSessionExitObserver,
  setSessionTuning, setConversationFlag, renameSession, redirectsAnthropicApiFor,
  setFocusedSession, recordObservedModel, killAll,
} from './sessions';
import { clearHalt, haltState, halted, pullHalt, registerHaltStopper } from './halt';
import { agentsChain } from './codex-sessions';
import { listProjects, addProject, removeProject, refreshBranches, projectById } from './store';
import * as batch from './batch';
import * as code from './code';
import { setSetting, setTheme, setUserPreference, spendCap } from './settings';
import { hasKey, setKey, clearKey, keyFingerprint, verifyKey, encryptionAvailable, getWorkspaceId,
         hasProviderKey, setProviderKey, clearProviderKey, providerKeyFingerprint } from './keys';
import type {
  AwakeState,
  BackupCheck, BackupRestoreSummary, BackupSummary, DocketPlanNode,
  HeadlessRowDetail, HeadlessRowSummary, HeadlessStartRequest, HookInput,
  InteractiveSessionLoad, LaunchOptions, McpServerConfig, PluginScope,
  ProviderManifestInspection, QueueSlots, RunConfig, Session,
  SourceConfig, ThemeSetting, TrustLevel,
} from '../shared/types';
import { assertManagedRoot, assertOpenablePath } from './roots';
import { installApplicationMenu } from './menu';
import { automationRun } from './automation';
import { adapterTrustPrompt, manifestTrustPrompt } from './pack-consent';

// ── phases 1-24 ────────────────────────────────────────────────────────
import * as otel from './otel';
import { codexUsageSummary } from './codex-usage';
import * as claudeUsage from './claude-usage';
import * as hooks from './hooks';
import * as checkpoints from './checkpoints';
import * as attention from './attention';
import * as transcripts from './transcripts';
import * as worktrees from './worktrees';
import * as queue from './queue';
import * as policy from './policy';
import * as headless from './headless';
import * as spend from './spend';
import * as notify from './notify';
import * as mobile from './mobile';
import { mobileFleetSnapshot } from './fleet-snapshot';
import * as tailnet from './tailnet';
import { configureMobileLaunchPinSource, mobileLaunchProviders } from './mobile/launch-options';
import * as awake from './awake';
import { qrSvg } from '../shared/qr';
import * as skills from './skills';
import * as plugins from './plugins';
import { glmModels, verifyGlmKey } from './glm';
import { providerModelCatalogue } from './launch-choices';
import { deepseekModels, verifyDeepSeekKey } from './deepseek';
import { xaiModels, verifyXaiKey } from './xai';
import * as gitOps from './git';
import * as gh from './gh';
import { demoOn, setDemo, demoState } from './demo';
import { readPreflight } from './preflight';
import { discoverProjects, wasDiscovered } from './discovery';
import { handoffConversation, handoffPlan } from './handoff';
import { beginHandover, finishHandover } from './handover';
import { createDemoWorkspace, type DemoWorkspace } from './demo-workspace';
import { DEMO_PROMPTS, DEMO_UNAVAILABLE } from '../shared/demo';
import * as schedule from './schedule';
import * as observed from './observed';
import { egressReport } from './egress';
import * as teams from './teams';
import * as revert from './revert';
import { isCliInvocation, runCli } from './cli';
import * as ctxInstructions from './context/instructions';
import * as ctxMemory from './context/memory';
import * as ctxConfig from './context/config';
import * as browse from './browse';
import * as attachments from './attachments';
import * as mcpRegistry from './mcp/registry';
import * as mcpServer from './mcp/server';
import { mcpTrustPrompt } from './mcp/consent';
import * as refusal from './batch/refusal';
import * as cachediag from './batch/cachediag';
import * as evals from './batch/evals';
import * as uploads from './batch/files';
import { allSettings, flags, slotsSetting } from './settings';
import { migrateUserData } from './migrate';
import { isDaemonInvocation, daemonStatus, installDaemon, uninstallDaemon } from './daemon';
import * as review from './review';
import * as codexStatus from './codex-status';
import * as backup from './backup';
import * as learning from './learning-service';
// The canonical knowledge record, not a second copy of it: learning-service
// wraps consolidation and briefing, and has no retirement path of its own.
import { retireKnowledgeItem } from './learning';
import * as control from './control';
import * as interview from './interview';
import { companion } from './companion';
import * as accounts from './accounts';
import * as usage from './usage';
import * as scout from './improvement-scout';

// The smoke suite deliberately has no window. A rejected startup promise in
// that path otherwise leaves an idle Electron main process behind, with
// neither a renderer nor the suite's normal log to explain what happened.
// Keep this entirely test-only: production startup retains its recovery flow.
const smokeMode = process.env.WANIGAN_SMOKE === '1';
const smokeLog = process.env.WANIGAN_SMOKE_LOG;
let smokeBootstrapWatchdog: NodeJS.Timeout | null = null;

function traceSmokeBootstrap(message: string): void {
  if (!smokeMode) return;
  const line = `[wanigan smoke bootstrap] ${message}`;
  console.error(line);
  if (smokeLog) {
    try { fs.appendFileSync(smokeLog, line + '\n'); } catch { /* diagnostic only */ }
  }
}

function clearSmokeBootstrapWatchdog(): void {
  if (!smokeBootstrapWatchdog) return;
  clearTimeout(smokeBootstrapWatchdog);
  smokeBootstrapWatchdog = null;
}

function failSmokeBootstrap(stage: string, error: unknown): void {
  clearSmokeBootstrapWatchdog();
  const detail = error instanceof Error
    ? `${error.name}: ${error.message}${error.stack ? `\n${error.stack}` : ''}`
    : String(error);
  traceSmokeBootstrap(`FATAL at ${stage}: ${detail.slice(0, 4000)}`);
  // `app.exit()` runs the normal quit interceptor, which may itself touch
  // SQLite and turn a failed headless test back into a live GUI process.
  // This is an isolated disposable profile, so force only this test process
  // out after the diagnostic has been synchronously recorded.
  process.exit(1);
}

if (smokeMode) {
  traceSmokeBootstrap('main module loaded; waiting for Electron ready');
  // Electron normally reaches ready in well under a second. Thirty seconds
  // leaves room for a busy CI/macOS host while still bounding a bad bootstrap.
  smokeBootstrapWatchdog = setTimeout(() => {
    failSmokeBootstrap('Electron ready', new Error('Timed out after 30 seconds before the smoke suite began.'));
  }, 30_000);
}

// Before any other statement in this file, and before anything opens the
// database: the rename moved userData, and everything that was in the old
// directory has to arrive before the first reader looks for it. Every db
// access in src/main is lazy, so module scope here is the earliest safe point.
const migration = migrateUserData();

// CLI, daemon and smoke invocations are intentionally separate processes.
// The attended UI is not: two main processes would each consider the same
// persisted Codex thread resumable and race for its single writer lock.
const attendedUiInvocation = !isCliInvocation()
  && !isDaemonInvocation()
  && process.env.WANIGAN_SMOKE !== '1';
const ownsUiInstance = !attendedUiInvocation || app.requestSingleInstanceLock();
if (!ownsUiInstance) app.quit();

/**
 * Batches advance in the main process on a timer. BatchStudio needed a separate
 * poller process because its server could be stopped independently; here the
 * app IS the process, so a batch keeps moving as long as Wanigan is open.
 */
let pollTimer: NodeJS.Timeout | null = null;
let quitConfirmed = false;
let quitDraining = false;
let quitReady = false;
let stopHookEventListener: (() => void) | null = null;

/** Every session that has not exited — what reconcileWorktrees calls an owner. */
function liveSessionIds(): ReadonlySet<string> {
  return new Set(listSessions().filter((s) => s.status !== 'exited').map((s) => s.id));
}

/**
 * Tell awake.ts what is running, so it can hold or release the Mac.
 *
 * Both facts are read here rather than in awake.ts because both already live
 * here: index.ts is the one module that sees the session list, the headless
 * children and the phone monitor's configuration at once. Giving the power
 * module its own opinion about what counts as a live agent would create a
 * second answer that could disagree with the quit dialog's.
 *
 * Headless runs count. A detached overnight fan-out is precisely the work that
 * "I left the laptop at home" is about, and a machine that suspends through it
 * loses the run without reporting anything.
 */
function syncAwake(): AwakeState {
  const live = listSessions().filter((s) => s.status === 'starting' || s.status === 'running').length;
  let dashboard = false;
  try {
    dashboard = mobile.mobileConfig().dashboardEnabled;
  } catch {
    // Reading the setting opens the database, which is exactly what is broken
    // in recovery mode. An unreadable dashboard flag is not a reason to keep a
    // Mac awake, so it reads as off and the live-agent half still decides.
  }
  return awake.reconcileAwake({ sessions: live + headless.liveHeadlessCount(), dashboard });
}

/**
 * Tell every surface the fleet was stopped, and by whom.
 *
 * Urgent, and on all three sinks. This is the one notification in the app that
 * is not about an agent needing something: it is about the operator's own fleet
 * having been stopped, possibly from a phone in another room, and the person
 * sitting at the Mac watching sessions disappear deserves a sentence rather
 * than a guess.
 */
function announceHalt(state: ReturnType<typeof haltState>): void {
  const counts = state.stopped
    .filter((entry) => entry.stopped > 0 && entry.name !== 'batch polling')
    .map((entry) => `${entry.stopped} ${entry.name}`)
    .join(', ');
  notify.notify({
    title: state.source === 'phone' ? 'Halted from your phone' : 'Wanigan is halted',
    body: `${counts || 'Nothing was running'}. Nothing will start until you clear it.`
      + (state.reason ? ` — ${state.reason}` : ''),
    urgent: true,
    mobileTag: 'wanigan-halt',
  });
}

/**
 * Restart the loops the stop pass stopped.
 *
 * Autopilots are deliberately absent: the halt disarmed them and said so, and
 * re-arming unattended, budgeted dispatch is a decision that belongs to whoever
 * reads that list — not to the act of clearing an unrelated emergency.
 */
function queueChanged(): void {
  const w = liveWindow();
  if (w && !w.isDestroyed()) w.webContents.send('queue:changed');
}

function resumeAfterHalt(): void {
  // Each in its own try. The scheduler re-arming and the dispatcher waking are
  // independent, and one of them failing must not leave the other stopped —
  // which would be a fleet that looks cleared and quietly never runs a schedule
  // again.
  try { startPoller(); } catch (error) { console.warn('[wanigan] batch polling did not resume after the halt:', error); }
  try { schedule.startScheduler(queueChanged); } catch (error) { console.warn('[wanigan] the scheduler did not resume after the halt:', error); }
  try { queue.startDispatcher(queueChanged); } catch (error) { console.warn('[wanigan] the queue did not resume after the halt:', error); }
  try { learning.startConsolidator(); } catch (error) { console.warn('[wanigan] learning did not resume after the halt:', error); }
}

function startPoller() {
  if (pollTimer) return;
  // The queue and the scheduler refuse their own ticks while halted; this loop
  // has no such guard because polling a batch is a read. It is still stopped,
  // because it is also what announces attention and holds the Mac awake — and a
  // halted fleet should not be keeping a laptop up to watch work it stopped.
  if (halted()) return;
  const tick = async () => {
    try {
      const s = await batch.pollOnce();
      if (s.ended || s.ingested) {
        const w = liveWindow();
        if (w && !w.isDestroyed()) w.webContents.send('batch:changed', s);
      }
    } catch { /* transient; the next tick retries */ }
    // Persistent attention is also the retry source for a transient ntfy
    // failure. Transition-aware dedupe makes this cheap/noiseless when delivery
    // already succeeded, while a failed phone alert retries after its backoff.
    // On macOS the last window can close while Wanigan, its PTYs and the phone
    // monitor keep running. Phone delivery/retry cannot depend on a renderer.
    announceCurrentAttention();
    try { finalizeProviderRemovals(); } catch { /* an active profile is expected */ }
    // The backstop for every lifecycle this file cannot see the end of. A
    // headless row finishing writes no IPC message and a PTY that dies with the
    // exit observer detached reports to nobody, so a reconcile that is cheap
    // when nothing changed is what stops a released hold from being missed —
    // and what starts one in the daemon, which has no window and no handlers.
    try { syncAwake(); } catch { /* power management is never worth a dead poll */ }
  };
  pollTimer = setInterval(tick, 10_000);
  void tick();
}

function activeProviderProfileIds(): string[] {
  return listSessions()
    .filter((value) => value.status === 'starting' || value.status === 'running')
    .map((value) => value.providerId);
}

/** Finish a deferred pack removal only after its frozen live sessions exit. */
function finalizeProviderRemovals(): void {
  const before = providerPackRegistry.snapshot();
  if (!before.packs.some((pack) => pack.status === 'pending-removal')) return;
  providerPackRegistry.finalizePendingRemovals(activeProviderProfileIds());
  refreshProviderPacks();
}

function publicProviderPacks(includeRemoved = false) {
  return providerPackRegistry.listPacks({ includeRemoved }).map((pack) => ({
    ...pack,
    name: pack.label,
    description: pack.manifest?.description,
    builtIn: pack.source === 'builtin',
    state: pack.status,
    adapter: pack.adapterSha256 ? {
      path: pack.manifest?.adapter?.executable ?? '',
      sha256: pack.adapterSha256,
      trusted: pack.adapterSha256 === pack.trustedAdapterSha256,
      executable: true,
    } : null,
  }));
}

/**
 * What a scheduled headless run is capped at.
 *
 * A schedule fires with nobody at the keyboard, so these are the only two
 * numbers standing between a bad prompt and a run that spends all night. The
 * Schedules form collects a prompt and nothing else — deliberately, because a
 * form with a budget box is a form people fill in once and never revisit — so
 * the ceiling lives here where it can be read. Not the Settings spend cap:
 * that one is the per-batch-run cap and is checked in dollars against an
 * estimate, whereas this is handed to the CLI's own --max-budget-usd.
 */
const SCHEDULED_BUDGET_USD = 2;
const SCHEDULED_TIMEOUT_MS = 15 * 60_000;

let win: BrowserWindow | null = null;
const demoWindows = new WeakMap<WebContents, DemoWorkspace>();
let demoWindowSequence = 0;
let changingDemoWindow = false;

/** All operational event producers receive no window during a demo. */
function liveWindow(): BrowserWindow | null {
  return win && !win.isDestroyed() && !demoWindows.has(win.webContents) && !changingDemoWindow ? win : null;
}

function storedDemoMode(): boolean {
  if (process.argv.includes('--wanigan-demo')) return true;
  try { return demoOn(); }
  catch { return true; } // Unknown privacy preference must never expose data.
}
/** Slower than the dispatcher: a goal becomes eligible when work finishes. */
const AUTOPILOT_SWEEP_MS = 10_000;
let autopilotTimer: NodeJS.Timeout | null = null;

/**
 * How often the transcript reader is offered a slice of time.
 *
 * Thirty seconds is a compromise between two costs that pull opposite ways: a
 * first pass over a multi-gigabyte corpus wants to be handed budget often, and
 * a caught-up store wants to be left alone. The ingest itself is what resolves
 * it — it returns `done` and the timer drops to a quarter-second budget after.
 */
const TRANSCRIPT_INGEST_MS = 30_000;
let transcriptTimer: NodeJS.Timeout | null = null;
let uiInitialized = false;

/**
 * The database is deliberately opened lazily. That keeps a bad or half-updated
 * legacy database from being able to prevent Electron from constructing a
 * window at all: the shell can explain the problem and offer a retry instead
 * of macOS making the launch look like it did nothing.
 */
type StartupState = {
  phase: 'starting' | 'ready' | 'recovery';
  stage: string | null;
  message: string | null;
};

let startupState: StartupState = { phase: 'starting', stage: null, message: null };
let attendedServicesStarted = false;
let startupAttempt: Promise<StartupState> | null = null;

function startupSnapshot(): StartupState {
  return { ...startupState };
}

function publishStartupState(next: StartupState): StartupState {
  startupState = next;
  const w = liveWindow();
  if (w && !w.isDestroyed()) w.webContents.send('startup:changed', startupSnapshot());
  return startupSnapshot();
}

function startupErrorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.trim().slice(0, 1200) || 'Unknown startup error.';
}

function enterStartupRecovery(stage: string, error: unknown): StartupState {
  // A partial service boot can leave timers/listeners behind. Stop only those
  // ephemeral pieces; the database is left untouched for the migration repair
  // path and the user can inspect it without Wanigan changing more rows.
  attendedServicesStarted = false;
  stopServices();
  const message = startupErrorMessage(error);
  console.error(`[wanigan] opening the UI in recovery mode after ${stage}:`, error);
  return publishStartupState({ phase: 'recovery', stage, message });
}

function showStartupRecoveryNotice(state: StartupState = startupSnapshot()): void {
  if (state.phase !== 'recovery') return;
  const show = () => {
    const w = liveWindow();
    if (!w || w.isDestroyed()) return;
    void dialog.showMessageBox(w, {
      type: 'warning',
      buttons: ['Keep Wanigan open'],
      defaultId: 0,
      title: 'Wanigan opened in recovery mode',
      message: 'Local services are paused, but the Wanigan window is open.',
      detail: `${state.stage ?? 'Startup'}: ${state.message ?? 'Unknown error.'}\n\nNo data was changed by this recovery screen. Fix the reported local-data problem, then use Retry in the banner or restart Wanigan.`,
    }).catch((error) => console.warn('[wanigan] could not show startup recovery notice:', error));
  };
  const w = liveWindow();
  if (!w || w.isDestroyed()) return;
  if (w.isVisible()) show();
  else w.once('ready-to-show', show);
}

/** Re-check persistent attention when the operator changes what is visible. */
function announceCurrentAttention(): void {
  if (quitDraining || quitConfirmed) return;
  try {
    for (const value of attention.attentionFor(listSessions())) {
      notify.announceAttention(value);
    }
  } catch {
    // Window transitions also happen while startup/quit is opening or closing
    // the database. Missing that re-check must not interfere with the window.
  }
}

/**
 * There is one trusted renderer in Wanigan.  Every IPC channel changes local
 * state, reads a repository, or starts a process, so a child frame must never
 * be able to invoke it merely because it knows a channel name. The WebContents
 * id alone is not enough: a renderer navigation keeps that id, so a packaged
 * app must also prove the sender is the expected local entry document.
 */
function rendererEntryPath(): string {
  return path.join(__dirname, '../renderer/index.html');
}

/** Electron Vite supplies this only for an unpackaged developer shell. Never
 * let an environment variable turn an installed app into a remote privileged
 * renderer. Invalid development URLs also fail closed to the bundled UI. */
function developmentRendererUrl(): string | null {
  if (app.isPackaged) return null;
  const raw = process.env.ELECTRON_RENDERER_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function trustedRendererUrl(raw: string): boolean {
  const dev = developmentRendererUrl();
  if (dev) {
    try { return new URL(raw).origin === new URL(dev).origin; }
    catch { return false; }
  }
  try {
    const url = new URL(raw);
    return url.protocol === 'file:'
      && path.resolve(fileURLToPath(url)) === path.resolve(rendererEntryPath());
  } catch {
    return false;
  }
}

function trustedSender(sender: WebContents, frame: WebFrameMain | null): boolean {
  return !!win && !win.isDestroyed()
    && sender.id === win.webContents.id
    && frame !== null
    && frame === sender.mainFrame
    && trustedRendererUrl(frame.url);
}

type ManagedProviderCredentialId = 'glm' | 'deepseek' | 'xai';

/** Provider keys are stored under predictable names in the OS keychain. Do
 * not let a renderer choose an arbitrary key identifier and turn this into a
 * secret-presence oracle for the process environment or credential store. */
function managedProviderCredentialId(value: unknown): ManagedProviderCredentialId {
  if (value === 'glm' || value === 'deepseek' || value === 'xai') return value;
  throw new Error('Wanigan manages provider credentials only for GLM, DeepSeek and xAI.');
}

/* ── renderer text that becomes a `claude plugin` argv entry ───────────
   The scope was a TypeScript union and nothing else, which a running process
   cannot read: any string at all reached `-s <scope>`. And an id or a source
   beginning with '-' is not a value — it is a second flag to a CLI that
   installs and executes code, in an argv position Wanigan chose. None of this
   is about shell quoting; nothing here reaches a shell. Argv is exactly where
   option injection lives when it cannot be a shell injection.
   ─────────────────────────────────────────────────────────────────────── */

const PLUGIN_SCOPES: readonly PluginScope[] = ['user', 'project', 'local'];

function pluginScope(value: unknown): PluginScope {
  if (value === undefined || value === null) return 'user';
  const found = PLUGIN_SCOPES.find((scope) => scope === value);
  if (!found) {
    throw new Error(`A plugin installs for the user, for the project, or locally — not "${String(value)}".`);
  }
  return found;
}

/** A plugin id is `name` or `name@marketplace`, and both come from the catalog. */
function pluginId(value: unknown): string {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!id || id.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._-]*(@[A-Za-z0-9][A-Za-z0-9._-]*)?$/.test(id)) {
    throw new Error(
      `"${String(value)}" is not a plugin name Wanigan will hand to the Claude CLI. Install from a row in the catalog.`
    );
  }
  return id;
}

/** A marketplace name as `claude plugin marketplace list` prints it. */
function marketplaceName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    throw new Error(`"${String(value)}" is not a marketplace Wanigan knows. Pick one from the marketplace list.`);
  }
  return name;
}

/** A marketplace source: a git URL, an owner/repo shorthand, or a local path. */
function marketplaceSource(value: unknown): string {
  const source = typeof value === 'string' ? value.trim() : '';
  if (!source) throw new Error('Type the marketplace to add — a git URL, an owner/repo, or a folder on this Mac.');
  if (source.length > 512) throw new Error('That marketplace source is too long to be one.');
  if (source.startsWith('-')) {
    throw new Error('A marketplace source cannot begin with "-"; the CLI would read it as another flag, not a source.');
  }
  if (/\s/.test(source) || /[\u0000-\u001f\u007f]/.test(source)) {
    throw new Error('A marketplace source cannot contain spaces or control characters.');
  }
  return source;
}


/**
 * Which provider an unattended run uses when the request did not name one.
 *
 * This read the literal 'claude' for every scheduled and queued headless run,
 * so a renamed profile, a disabled pack or an uninstalled CLI turned a schedule
 * that had been firing for months into `Unknown provider: claude`. A headless
 * run needs a profile that declares a headless protocol and whose installed CLI
 * has proven it; take the first in registry order, which is Wanigan's own
 * preference order, and say plainly when there is none.
 */
async function defaultHeadlessProviderId(): Promise<string> {
  const usable = (await detectProviders())
    .find((provider) => provider.path && provider.capabilities.headlessJson);
  if (usable) return usable.id;
  throw new Error(
    'No installed provider has proven a headless protocol, so there is nothing to run this unattended. '
    + 'Install or enable a provider that declares one, refresh providers, then let the schedule fire again.'
  );
}

/**
 * The session list as the renderer receives it.
 *
 * Identical to listSessions() except that the launch snapshot is reduced to a
 * count. `baseline.dirty` is one string per file already modified when the
 * session started — 84 in this repository, thousands in a monorepo — and three
 * independent pollers re-serialise the whole list every few seconds to render a
 * row of status text that never shows a path. The paths still exist; the code
 * panel asks for one session's worth through `sessions:baseline`.
 */
function sessionListEntries(): Session[] {
  return listSessions().map((value) => {
    const { baseline, ...rest } = value;
    if (!baseline) return rest;
    return {
      ...rest,
      baselineSummary: { head: baseline.head, dirtyCount: baseline.dirty.length, at: baseline.at },
    };
  });
}

/** Where the backup save dialog opens. Documents is only a starting point — the
 *  user picks the folder, and backup.ts refuses one inside the data directory. */
function defaultBackupParent(): string {
  try { return app.getPath('documents'); }
  catch { return app.getPath('home'); }
}

/** Sortable and unambiguous in a folder listing, which is where this is read. */
function backupStamp(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

/**
 * The repository a git channel is allowed to act in.
 *
 * Every git:* handler takes a root from the renderer and hands it straight to
 * `git -C <root>`, and roots.ts exists for exactly this: the relative path was
 * never the untrusted part, the base was. `discard` deletes untracked files,
 * `checkout` overwrites them, `deleteBranch --force` and `stashDrop` throw work
 * away and `push` publishes it — with an unconfined root those are a
 * delete-anywhere primitive that only needs a channel name to reach.
 *
 * A managed root is a registered project or a worktree Wanigan created, read
 * from this process's own records. Subdirectories are managed too, so acting in
 * a package inside a monorepo is unaffected.
 */
function gitRoot(root: unknown): string {
  return assertManagedRoot(root, 'That repository');
}

/** Open only ordinary web links outside Wanigan; never hand arbitrary schemes
 * from a renderer or agent-produced text to the operating system. */
function openSafeExternal(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol === 'https:' || url.protocol === 'http:') {
      void shell.openExternal(url.toString());
      return true;
    }
  } catch { /* malformed links are not an operating-system action */ }
  return false;
}

function createWindow(demo = storedDemoMode()) {
  notify.setDesktopPrivacy(demo);
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 560,
    show: false,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0c0e12',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      additionalArguments: demo ? ['--wanigan-demo-window'] : [],
      ...(demo ? { partition: `wanigan-demo-${++demoWindowSequence}` } : {}),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
    },
  });

  const window=win;
  if (demo) demoWindows.set(window.webContents, createDemoWorkspace());
  window.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.on('ready-to-show', () => { if (!window.isDestroyed()) window.show(); });
  const publishVisibility=()=>{
    if(!window.isDestroyed()&&!window.webContents.isDestroyed())
      window.webContents.send('window:visibility',window.isVisible()&&!window.isMinimized());
  };
  window.on('show',publishVisibility);window.on('hide',publishVisibility);
  window.on('minimize',publishVisibility);window.on('restore',publishVisibility);
  window.webContents.on('did-finish-load',publishVisibility);
  // The renderer's watched id does not change when the whole app loses focus.
  // Re-checking here lets a Mac banner that was intentionally quiet while the
  // session was visible fire once the operator moves to another app.
  win.on('blur', announceCurrentAttention);
  win.on('closed', () => { if (win === window) win = null; });

  // External links open in the real browser, never inside the app shell.
  // This shell never navigates away from its bundled renderer.  Links belong
  // in the system browser, after scheme validation, and child web contents are
  // not part of Wanigan's privilege boundary.
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!demo) openSafeExternal(url);
    return { action: 'deny' };
  });

  // Built after the window exists so every item has something to send to. It
  // is set once for the application rather than per window: macOS shows one
  // menu bar, and rebuilding it on each window would be a second source of the
  // route table.
  installApplicationMenu(() => win, demo ? false : undefined);

  const devRenderer = developmentRendererUrl();
  // Both of these reject — a dev server that is not up yet, a packaged bundle
  // whose renderer entry is missing or unreadable. Unhandled, that rejection
  // is the one startup failure in this file that reports nothing: the window
  // is already on screen, so the operator watches an empty frame while every
  // neighbouring failure gets showErrorBox or recovery mode.
  const loaded = devRenderer ? win.loadURL(devRenderer) : win.loadFile(rendererEntryPath());
  loaded.catch((error: unknown) => {
    console.error('[wanigan] the window could not load its renderer:', error);
    dialog.showErrorBox('Wanigan could not open its window', startupErrorMessage(error));
  });
}

// A rejection here is the whole bootstrap failing, and with no handler it was
// an unhandled rejection: the app sat half-started with nothing said. Reported
// rather than swallowed, and not in smoke, where a modal would hang the run.
void app.whenReady().then(async () => {
  if (smokeMode) {
    clearSmokeBootstrapWatchdog();
    traceSmokeBootstrap('Electron ready');
  }
  if (!ownsUiInstance) return;
  // Wanigan does not use camera, microphone, notifications from web content,
  // or any other Chromium permission. OS notifications are created only by
  // the main process, never granted to a renderer.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  if (migration.moved) console.log(`[wanigan] carried userData across from ${migration.from}`);
  else if (migration.note) console.warn(`[wanigan] userData migration skipped: ${migration.note}`);

  // Headless command path: same database, same Electron ABI, no window. This
  // has to come first — reaching createWindow() would open a window nobody
  // asked for and never exit, which is what a CLI hanging looks like.
  if (isCliInvocation()) {
    const code = await runCli(process.argv);
    app.exit(code);
    return;
  }

  // A launchd-owned scheduler is the same app, minus the window. It keeps the
  // local database, queue and safety limits; it is not a cloud worker and it
  // never starts an attended PTY.
  if (isDaemonInvocation()) {
    initSessions(() => null);
    await startServices();
    startPoller();
    return;
  }

  // Headless verification path: exercise the real main process, then exit.
  if (smokeMode) {
    try {
      traceSmokeBootstrap('loading smoke suite');
      const { runSmoke } = await import('./smoke');
      traceSmokeBootstrap('smoke suite loaded');
      await runSmoke();
    } catch (error) {
      failSmokeBootstrap('smoke suite startup', error);
    }
    return;
  }

  // IPC registration never opens the database. Do it before service startup
  // so a recovery window still has a truthful status endpoint when a legacy
  // database cannot finish its first migration.
  try {
    registerIpc();
  } catch (error) {
    enterStartupRecovery('the renderer bridge', error);
  }

  // Construct the attended window before any path that can touch SQLite.
  // `startAttendedServices()` may need to wait on another writer or report a
  // corrupt/partial schema; neither outcome should look like an app that
  // simply did not launch.
  try {
    createWindow();
    uiInitialized = true;
  } catch (error) {
    console.error('[wanigan] could not create the attended window:', error);
    dialog.showErrorBox('Wanigan could not open', startupErrorMessage(error));
    return;
  }

  if (demoWindows.has(win!.webContents)) {
    // A demo-only launch needs no account discovery, collectors, or pollers.
  } else if (startupState.phase !== 'recovery') {
    const state = await startAttendedServices();
    if (state.phase === 'recovery') showStartupRecoveryNotice(state);
  } else {
    showStartupRecoveryNotice();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch((error: unknown) => {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error('[wanigan] startup failed:', detail);
  // No modal in smoke: there is nobody there to dismiss it, and the run would
  // hang on a box rather than report the failure it is meant to catch.
  if (!smokeMode) dialog.showErrorBox('Wanigan could not finish starting', detail);
});

if (attendedUiInvocation && ownsUiInstance) {
  app.on('second-instance', () => {
    if (!uiInitialized) return;
    if (!win || win.isDestroyed()) createWindow();
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// An agent left running with no window is an agent burning tokens unseen.
app.on('before-quit', (event) => {
  if (quitReady) return;
  event.preventDefault();
  if (quitDraining) return;

  // A macOS window close is not a quit, but ⌘Q is. Make the irreversible
  // boundary explicit when Wanigan still owns live work: saved history
  // survives, but neither interactive PTYs nor detached headless agents do.
  if (!quitConfirmed) {
    const live = listSessions().filter((s) => s.status === 'starting' || s.status === 'running');
    const headlessLive = headless.liveHeadlessCount();
    if (live.length || headlessLive) {
      const named = live.slice(0, 3).map((s) => s.title).join(', ');
      const remainder = live.length > 3 ? ` and ${live.length - 3} more` : '';
      const interactive = live.length
        ? `${live.length} interactive agent${live.length === 1 ? '' : 's'} (${named}${remainder})`
        : '';
      const background = headlessLive
        ? `${headlessLive} headless agent${headlessLive === 1 ? '' : 's'}`
        : '';
      const summary = [interactive, background].filter(Boolean).join(' and ');
      const choice = dialog.showMessageBoxSync({
        type: 'warning',
        buttons: ['Keep Wanigan open', 'Stop agents and quit'],
        defaultId: 0,
        cancelId: 0,
        title: 'Stop live agents?',
        message: win && demoWindows.has(win.webContents)
          ? 'Live work in your private workspace will be stopped.' : `${summary} will be stopped.`,
        detail: 'Projects, settings and saved transcripts remain, but a live agent cannot survive a full app quit.',
      });
      if (choice !== 1) return;
      quitConfirmed = true;
    }
  }
  quitDraining = true;
  if (pollTimer) clearInterval(pollTimer);
  // A deliberate quit must not report every PTY Wanigan is about to terminate
  // as a fresh failure on the user's phone.
  setSessionExitObserver(null);
  stopServices();
  void Promise.allSettled([shutdownAll(), headless.shutdownHeadless()]).finally(() => {
    quitReady = true;
    // Released here rather than at the top of the drain: the machine should
    // stay up long enough for Codex to flush its rollout and node-pty to
    // observe the exits. This is the one path every quit passes through, and a
    // blocker is process-scoped, so leaving without giving it back is the
    // difference between a Mac that sleeps tonight and one that does not.
    try { awake.reconcileAwake(null); } catch { /* nothing may block the quit */ }
    app.quit();
  });
});

/**
 * The three loopback listeners and the dispatcher, started before the first
 * window so no session can ever spawn pointing at a collector that is not up
 * yet — a session launched into a dead endpoint reports nothing and looks,
 * indistinguishably, like a session doing nothing.
 */
async function startServices() {
  const f = flags();

  // The hook server owns delivery; the learning service owns retrieval and its
  // privacy/token boundary. Registering before the listener opens means the
  // first SessionStart cannot race an empty context source.
  // Attended sessions receive their capsule directly through the harness's
  // invocation-scoped instruction flag. Hook delivery is reserved for
  // headless Claude-compatible runs, which register a frozen task context.
  hooks.setLearningBriefingHook((sessionId, context) => context
    // Hook deliveries are recorded like argv deliveries: the ledger must show
    // every path a briefing can take, or a headless run looks unbriefed.
    ? learning.briefingForContext(context, { sessionId, delivery: 'hook' })
    : null);

  // A model switch the operator typed into the terminal, or the CLI made on its
  // own, is still a fact about this session. Registered here so the record is
  // corrected by the same bus that recorded the switch.
  hooks.setModelSwitchHook((sessionId, model) => { recordObservedModel(sessionId, model); });

  // Background learning activity (a signal from a live session, a timer
  // consolidation pass) pushes one debounced event so the Learning view can
  // refresh without polling. User-initiated mutations reload via their own
  // IPC round trip and do not need it.
  learning.setLearningChangedNotifier(() => {
    const w = liveWindow();
    if (w && !w.isDestroyed()) w.webContents.send('learning:changed');
  });

  if (f.telemetry) {
    try { await otel.startCollector(); }
    catch (e) { console.warn('[wanigan] telemetry collector did not start:', e); }
  }

  // SessionEvent is provider-neutral. Codex creates the same events from its
  // structured terminal lifecycle channel even when the optional Claude HTTP
  // hook transport is disabled or failed to bind, so consumers must exist
  // independently of that listener.
  stopHookEventListener?.();
  stopHookEventListener = hooks.onHookEvent((e) => {
    const w = liveWindow();
    if (w && !w.isDestroyed()) w.webContents.send('session:event', e);
    const s = listSessions().find((x) => x.id === e.sessionId);
    try { learning.observeSessionEvent(e, s); }
    catch (error) { console.warn('[wanigan] learning signal skipped:', error); }
    if (s && !quitDraining) notify.announceAttention(attention.attentionOf(s));
  });
  // Turn boundaries feed the checkpoint queue. Idempotent; the subscription
  // outlives window recreation on purpose — captures are per-session facts.
  checkpoints.initCheckpoints();

  if (f.hooks) {
    try {
      await hooks.startHookServer();
      // Phase 19 decides; phase 2 carries the decision back to the agent.
      hooks.setPolicyHook((input: HookInput) => {
        const s = listSessions().find((x) => x.id === input.wanigan_session_id);
        const ctx: policy.PolicyContext = {
          sessionId: s?.id ?? null,
          projectId: s?.projectId ?? null,
          // The worktree, not the repository root. An isolated session runs in
          // a tree deliberately created *outside* the repo, so judging it
          // against projectPath denied every write it made as
          // 'project.write-outside' — an agent that could do nothing, at the
          // trust level most people actually leave switched on.
          projectPath: s?.worktree ?? s?.projectPath ?? null,
          trust: (s?.trust ?? policy.defaultTrust()) as TrustLevel,
          // A pane has a person in front of it: an 'ask' is a real question
          // somebody will answer, and a rule that throws can safely fall back
          // to the CLI's own prompt. The headless fan-out sets this false and
          // gets the opposite treatment on both counts.
          attended: true,
        };
        // decideFor + recordDecision + fail in the direction this run can
        // survive, in one call, so a decision nobody wrote down is not a shape
        // this file can accidentally produce.
        return policy.answerFor(ctx, input);
      });
    } catch (e) { console.warn('[wanigan] hook bus did not start:', e); }
  }

  // Both directions, or neither works: headless hands each repo to the queue,
  // and the queue hands it back one slot at a time. Wiring only the second half
  // leaves headless silently falling back to its own internal limit, which is
  // the kind of bug that looks like "the slots setting does nothing".
  queue.registerRunner('headless', async (payload) => {
    const p = payload as {
      runId?: unknown; projectId?: unknown; prompt?: unknown; scheduleId?: unknown;
      providerId?: unknown; allProjects?: unknown;
    };
    if (typeof p.runId === 'string' && p.runId) {
      if (typeof p.projectId !== 'string' || !p.projectId) {
        throw new Error(`Queue row for run ${p.runId} names no repository, so there is nothing to run it in.`);
      }
      await headless.runOneRepo(p.runId, p.projectId);
      return;
    }
    // A schedule fired. Its payload is a prompt, because a prompt is the only
    // thing the Schedules form collects — the provider, the budget and the
    // timeout belong on this side, where the defaults live. This turns it into
    // a real headless run, which enqueues one row per repo back through this
    // same runner and arrives at the branch above.
    const prompt = typeof p.prompt === 'string' ? p.prompt.trim() : '';
    if (!prompt) {
      throw new Error(
        'This schedule carries no prompt, so there is nothing to run. Delete it and create it again from Schedules.'
      );
    }
    const projectId = typeof p.projectId === 'string' ? p.projectId : '';
    const ids = projectId ? [projectId] : listProjects().map((x) => x.id);
    if (!ids.length) {
      throw new Error(
        'This schedule fans out across every project and there are none in the list. Add a project, or pin the schedule to one.'
      );
    }
    // An omitted repository is not the same statement as "every repository",
    // and by the time the ids are expanded the two are the same array. Carry
    // the schedule's own declaration through instead of manufacturing consent
    // here; headless.ts refuses a whole-project-list run that does not have it.
    const allProjects = !projectId && p.allProjects === true;
    // Named after the schedule that fired it. "scheduled · <date>" tells you
    // nothing once there are four of them, and this run id is what Insights and
    // the run list will show it as for as long as the row exists.
    const from = typeof p.scheduleId === 'string'
      ? schedule.listSchedules().find((x) => x.id === p.scheduleId)?.name ?? null
      : null;
    await headless.startHeadlessRun({
      name: `${from ?? 'scheduled'} · ${new Date().toLocaleString()}`,
      providerId: typeof p.providerId === 'string' && p.providerId
        ? p.providerId
        : await defaultHeadlessProviderId(),
      projectIds: ids,
      allProjects,
      prompt,
      maxBudgetUsd: SCHEDULED_BUDGET_USD,
      timeoutMs: SCHEDULED_TIMEOUT_MS,
      // An unattended run must not fight the working tree the operator is
      // typing in. A schedule fires at 03:00 or while you are mid-edit, and
      // those are the same case as far as the repo is concerned.
      isolate: true,
    });
  });

  // Schedules have offered a Batch option since phase 25 and nothing has ever
  // been registered for the kind, so every batch schedule ever created sat in
  // the queue with blocked_by 'no runner registered' — armed, visible, and
  // firing nothing. The payload names a run rather than carrying a config: a
  // batch is a dataset, a model and a template, so re-reading the run at fire
  // time means editing the run changes what fires, and a glob or command source
  // re-reads the world instead of replaying a frozen copy of it.
  queue.registerRunner('batch', async (payload) => {
    const p = payload as { runId?: unknown };
    if (typeof p.runId !== 'string' || !p.runId) {
      throw new Error(
        'Nothing here names a run to submit. A batch is a dataset, a model and a template, so the payload has to carry {"runId":"<run>"}. ' +
        'A schedule showing this was created before the form could store one — delete it and create it again from Schedules.'
      );
    }
    // runDetail throws `Run <id> not found.` when the run has been deleted,
    // which is the right answer: the schedule points at nothing and the history
    // row says so by name.
    const cfg = batch.runDetail(p.runId).config as RunConfig;
    const stamp = new Date().toLocaleDateString();
    // No estimate on purpose. submit.ts prices an unpriced run itself and holds
    // the per-run spend cap against the ceiling, so passing nothing here is what
    // puts a schedule firing with nobody watching behind the same gate as a
    // human pressing Submit.
    await batch.createAndSubmitRun(
      { ...cfg, name: `${cfg.name} — scheduled ${stamp}` },
      { parentRunId: p.runId }
    );
    void batch.pollOnce().catch(() => {});
  });
  // The Scout is a fourth dispatcher lane rather than a loose timer. That
  // gives its weekly schedule the same durable lease and attended/launchd
  // cross-process behavior as every other scheduled task. The runner only
  // accepts Wanigan's fixed schedule payload; renderer text cannot name a URL.
  queue.registerRunner('scout', async (payload) => {
    const value = payload as { scout?: unknown; version?: unknown };
    if (value.scout !== true || value.version !== 1) {
      throw new Error('This Scout queue item is not a Wanigan weekly-research schedule. Remove it and re-enable the Scout schedule from its dashboard.');
    }
    // A queue item may have been claimed just before the operator disabled
    // weekly/network research. Do not make it fail/retry; it has no authority
    // to override the newer persisted preference.
    if (!scout.scheduledResearchAllowed()) return;
    await scout.runScheduled();
  });
  // Upsert a stable schedule id on both the attended app and launchd. It is
  // disabled by default and only arms after the operator permits unattended
  // allow-listed source requests in Scout settings.
  scout.syncWeeklySchedule();
  headless.registerHeadlessRunner((runId, projectId) => {
    const name = projectById(projectId)?.name ?? projectId;
    queue.enqueue('headless', `${name} · ${runId}`, { runId, projectId });
  });
  queue.setSlots(slotsSetting());
  // Schedules feed the dispatcher; the dispatcher decides when there is a slot.
  schedule.startScheduler(queueChanged);
  queue.registerRunner('node', async (payload) => {
    const nodeId = (payload as { nodeId?: unknown } | null)?.nodeId;
    if (typeof nodeId !== 'string' || !nodeId) {
      throw new Error('This autopilot queue item names no Goal task. Remove it and re-enable autopilot on the goal.');
    }
    await control.startQueuedNode(nodeId);
  });
  queue.startDispatcher(queueChanged);
  // The sweep only writes queue rows; the dispatcher above still decides when
  // one may start. It runs on its own slower interval because a goal becomes
  // eligible through work finishing, not through the queue moving.
  //
  // Guarded against smoke as defence in depth. The suite returns before
  // service startup today, so this line is unreachable there — but a sweep
  // firing inside the suite's own process would start real paid sessions
  // against its fixtures, and that is not a hazard to leave resting on the
  // order of two early returns. The suite calls sweepAutopilot() directly.
  if (!smokeMode) autopilotTimer = setInterval(() => {
    try {
      if (control.sweepAutopilot() > 0) {
        const w = liveWindow();
        if (w && !w.isDestroyed()) w.webContents.send('queue:changed');
      }
    } catch (e) {
      // Same reasoning as the dispatcher's own guarded tick: a throw here has
      // no handler and would take Electron down with every live PTY.
      console.warn('[wanigan] autopilot sweep failed; skipping this pass:', e);
    }
  }, AUTOPILOT_SWEEP_MS);

  // Claude Code's transcripts are the one meter that can report on work
  // Wanigan never launched, and the first pass over them is measured in
  // gigabytes. It runs here rather than on the Insights load so a person who
  // opens that page gets a warm store instead of a spinner, and it is
  // deliberately paced: a bounded budget, a gap between passes, and no work at
  // all once the store has caught up.
  //
  // Guarded against smoke for the same reason the sweep above is — smoke11
  // drives ingest() directly against fixtures, and a timer racing it inside the
  // same process would ingest the operator's real corpus into the suite's
  // temporary database mid-assertion.
  if (!smokeMode) {
    let transcriptCaughtUp = false;
    transcriptTimer = setInterval(() => {
      try {
        // A caught-up store still costs one stat per file, which is cheap but
        // not free over five thousand of them. Once done, back off to the slow
        // beat that only exists to notice newly written turns.
        const result = claudeUsage.ingest({ budgetMs: transcriptCaughtUp ? 250 : 1_500 });
        transcriptCaughtUp = result.done;
      } catch (e) {
        console.warn('[wanigan] transcript ingest failed; retrying next pass:', e);
      }
    }, TRANSCRIPT_INGEST_MS);
  }

  if (f.mcpServerEnabled) {
    try {
      await mcpServer.startMcpServer();
      // An agent that can spend money with no human in the loop is a budget
      // incident waiting for a bad prompt, so submission always asks.
      mcpServer.setConfirmHandler(async (req) => {
        const w = liveWindow();
        if (!w || w.isDestroyed()) return false;
        const r = await dialog.showMessageBox(w, {
          type: 'question',
          buttons: ['Cancel', 'Submit run'],
          defaultId: 0,
          cancelId: 0,
          title: 'An agent wants to submit a batch',
          message: req.summary,
          detail: `Estimated cost $${req.costUsd.toFixed(2)}. This cannot be un-submitted.`,
        });
        return r.response === 1;
      });
    } catch (e) { console.warn('[wanigan] MCP server did not start:', e); }
  }

  // Worktrees survive a crash; a stale one costs disk forever, so surface them.
  void worktrees.reconcileWorktrees(liveSessionIds()).catch(() => {});
  // A goal task left 'running' by a crash describes an agent that no longer
  // exists — and holds path claims nobody can release until it is reopened.
  try {
    const reopened = control.reconcileRunningNodes();
    if (reopened) console.warn(`[wanigan] reopened ${reopened} goal task(s) whose session did not survive the last run`);
  } catch (e) { console.warn('[wanigan] goal reconciliation skipped:', e); }
  // Deterministic consolidation runs only while the app or its launchd daemon
  // is alive. The service checks the visible controls on every pass.
  learning.startConsolidator();
}

/** The mobile endpoint is configured independently of whether it is enabled.
 * Replacing these callbacks on a recovery retry is safe and does not reopen a
 * listener or mutate the database by itself. */
function configureMobileSources(): void {
  mobile.configureSnapshotSource(() => {
    const sessions = listSessions();
    return mobileFleetSnapshot(
      sessions,
      attention.attentionFor(sessions),
      otel.usageForMany(sessions.map((value) => value.id)),
    );
  });
  // Which projects have an agent running, and nothing else about them. The pin
  // screen states in the past tense how many sessions were already running when
  // a repository's login changed, and that number has to be counted at the
  // moment of the write rather than read off a cached page. sessions.ts cannot
  // be imported from ./mobile — it reaches notify.ts, which imports the mobile
  // facade — so the answer is handed in, and an unwired seam answers null
  // rather than an honest-looking zero.
  configureMobileLaunchPinSource({
    liveProjectIds: () => listSessions()
      .filter((session) => session.status !== 'exited')
      .map((session) => session.projectId),
  });
  // Conversations a paired device may pick back up. Rebuilt here rather than
  // handed over whole: a past-session row carries the project's absolute path,
  // its worktree and the agent's conversation id, and the phone monitor's
  // boundary excludes all three by name.
  mobile.configureMobileRecentSource(() => pastSessions(60)
    // Settled conversations are parked on purpose. They stay in the record and
    // out of a list whose whole job is "what would I pick up now".
    .filter((row) => row.settledAt === null)
    .map((row) => ({
      id: row.id,
      title: row.title ?? row.projectName,
      projectName: row.projectName,
      providerId: row.providerId,
      model: row.model,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      exitCode: row.exitCode,
      turns: row.continuationCount,
      // Both halves matter: a conversation whose project Wanigan no longer
      // knows, or whose directory is gone, cannot be resumed — and a Resume
      // button for one would fail in a way nobody can fix from a phone.
      live: row.live && row.projectId !== null,
      pinned: row.pinnedAt !== null,
    })));

  mobile.configureMobileControlSource({
    projects: async () => listProjects().map((project) => ({ id: project.id, name: project.name, branch: project.branch })),
    providers: async () => mobileLaunchProviders(await detectProviders()),
    launch: async ({ projectId, providerId, model, effort, accountId, prompt }) => {
      // Which login the phone chose, already checked against the real account
      // list in mobile/control.ts. null is the absence of a choice and resolves
      // exactly as a desktop launch with no account picked: the project's pin
      // first, then the default.
      const session = await createSession({ providerId, projectId, model, effort, accountId, initialPrompt: prompt });
      return { id: session.id, title: session.title };
    },
    /**
     * Pick a recorded conversation back up, named only by Wanigan's session id.
     *
     * Everything else is resolved here: the conversation id the CLI needs, the
     * project it ran in, and whether that project still exists. None of the
     * three ever crosses to a paired device — the phone is offered a list of
     * ids it may resume and nothing it could use to construct one.
     *
     * The row is looked up against pastSessions() rather than against whatever
     * the phone sent, which is the same rule the account resolution above
     * follows: an id naming no recorded conversation ends the call here.
     */
    resume: async (sessionId) => {
      const past = pastSessions(200).find((row) => row.id === sessionId);
      if (!past) throw new Error('That conversation is not in this Mac’s recent list.');
      if (!past.projectId) throw new Error('The project this conversation ran in has been removed from Wanigan.');
      if (!past.live) throw new Error('The project directory this conversation ran in is no longer on disk.');
      const session = await createSession({
        providerId: past.providerId,
        projectId: past.projectId,
        model: past.model ?? undefined,
        effort: past.effort ?? undefined,
        resumeFrom: { sessionId: past.id, conversationId: past.conversationId },
      });
      return { id: session.id, title: session.title };
    },
    prompt: async (sessionId, prompt) => {
      const session = listSessions().find((value) => value.id === sessionId && value.status !== 'exited');
      if (!session) throw new Error('That session is no longer running.');
      writeSession(sessionId, `${prompt}\r`);
    },
    key: async (sessionId, sequence) => {
      // The sequence came out of mobile/control.ts's closed list, so it is not
      // rechecked here; what is left is the same liveness question `prompt`
      // asks, for the same reason. A key written into an exited session is a
      // keystroke into nothing that the phone would see reported as sent.
      const session = listSessions().find((value) => value.id === sessionId && value.status !== 'exited');
      if (!session) throw new Error('That session is no longer running.');
      writeSession(sessionId, sequence);
    },
    interrupt: async (sessionId) => interruptSession(sessionId),
    terminal: async (sessionId) => {
      const session = listSessions().find((value) => value.id === sessionId);
      if (!session) throw new Error('That session is no longer available.');
      return { title: session.title, running: session.status !== 'exited', text: scrollback(sessionId) };
    },
  });

  // Firing an installed skill into a live session. Three narrow capabilities and
  // no more: read the catalogue for the project a session is open on, ask
  // ../skills whether typing into that session is something Wanigan has actually
  // verified, and write already-decided text. The phone holds an opaque id and
  // never the command, and no directory crosses the HTTP boundary.
  mobile.configureMobileSkillsSource({
    read: async (sessionId) => {
      const live = listSessions().find((value) => value.id === sessionId) ?? null;
      const catalogue = skills.discoverSkills(live?.projectId ?? undefined);
      // Asked of ../skills rather than answered here. An empty command can never
      // match a row, so what comes back is the part of the decision that is about
      // the SESSION — none chosen, exited, or a harness whose invocation form
      // Wanigan has not verified — and 'unknown-skill' is that check having
      // passed. If the order inside skillSendDecision ever changes, this reports
      // no banner rather than a wrong one, and the tap still refuses with the
      // real reason.
      const gate = skills.skillSendDecision(live, '');
      return {
        skills: catalogue.skills,
        agentSkillCount: catalogue.agentSkills.length,
        builtinNote: catalogue.roots.find((root) => root.source === 'builtin')?.note ?? null,
        blocked: gate.ok || gate.code === 'unknown-skill' ? null : gate.reason,
      };
    },
    decide: async (sessionId, invoke) =>
      skills.skillSendDecision(listSessions().find((value) => value.id === sessionId) ?? null, invoke),
    type: async (sessionId, text) => {
      // The same liveness question ./mobile/control.ts's prompt and key ask, for
      // the same reason: text written into an exited session is typing into
      // nothing that the phone would see reported as typed.
      const session = listSessions().find((value) => value.id === sessionId && value.status !== 'exited');
      if (!session) throw new Error('That session is no longer running.');
      writeSession(sessionId, text);
    },
  });

  // The Explore seam: what each account has left, what the fleet spent, and
  // which lines either of those has crossed. Never forced — usage.snapshot()
  // without `force` reuses the reading the Mac already had, because a phone
  // polled while it is open must not be a second, silent trigger for a real
  // CLI probe. The budgets are a second call because they are a second
  // question, and mobile/explore.ts holds a failure of that one apart from a
  // budget that is fine.
  mobile.configureMobileExploreSource({
    spend: ({ days }) => usage.snapshot({ days }),
    budgets: () => ({
      breached: spend.budgetBreached(),
      // A budget of 0 tracks spend without capping it and cannot be breached,
      // so it is not counted. The count is what stops the phone printing "no
      // budget is over" at an operator who has never set one.
      capped: spend.budgets().filter((row) => row.monthlyUsd > 0).length,
    }),
  });
}

/**
 * Start only the attended-window services behind a failure boundary. SQLite
 * migration, session reconciliation and service wiring all reach the same
 * durable store; if any one sees a partially migrated legacy file, stop the
 * partial service set and leave the already-created window usable for the
 * recovery explanation instead of rejecting Electron's startup promise.
 */
async function startAttendedServices(): Promise<StartupState> {
  if (attendedServicesStarted) return startupSnapshot();
  if (startupAttempt) return startupAttempt;

  publishStartupState({ phase: 'starting', stage: null, message: null });
  let stage = 'session recovery';
  const attempt = (async () => {
    try {
      initSessions(liveWindow);
      setSessionExitObserver((value) => {
        // A session ending is the one event that changes the Recent list, and
        // it is the moment somebody is most likely to be looking at that list —
        // so drop the cache here rather than making them wait it out.
        try { mobile.forgetRecentCache(); } catch { /* the phone listener may not be up */ }
        notify.announceAttention(attention.attentionOf(value));
        // The last agent exiting is the moment the Mac should be allowed to
        // sleep again, and waiting up to a poll interval for that is ten
        // seconds of battery spent on nothing.
        syncAwake();
        // A goal task whose agent has exited is not running any more, and its
        // file claims are not held any more. Reconciling only at start-up left
        // the board reading 'running' — and blocking every sibling claim —
        // until the app was restarted.
        try {
          if (control.onSessionExit(value.id)) {
            const w = liveWindow();
            if (w && !w.isDestroyed()) w.webContents.send('queue:changed');
          }
        } catch (error) {
          console.warn('[wanigan] could not reconcile a goal task after its session exited:', error);
        }
      });
      // Clicking a banner already raises the window; this is the half that was
      // missing. Without a route the operator lands on whichever tab happened
      // to be open and still has to hunt for the agent they were told about.
      notify.setNotificationOpener((target) => {
        const w = liveWindow();
        if (!w || w.isDestroyed()) return;
        w.webContents.send('notify:open', target);
      });
      // The card inside the window. Sent to the renderer rather than drawn by
      // main, because it has to be dismissible, stackable and clickable, and
      // because the window is the one place a notification cannot be silently
      // swallowed by a Focus mode nobody remembers switching on.
      notify.setInAppAlertSink((alert) => {
        const w = liveWindow();
        if (!w || w.isDestroyed()) return;
        w.webContents.send('notify:alert', alert);
      });

      // ── the emergency stop ─────────────────────────────────────────
      //
      // Registered in stop order, and the order is the design. Everything that
      // *starts* work goes first — a dispatcher, a scheduler, an autopilot — so
      // that by the time the sessions are killed there is nothing left that
      // would notice them dying and launch a replacement. Killing first and
      // disarming after leaves exactly the window an autopilot sweep needs to
      // put the fleet back, which is how an emergency stop earns a reputation
      // for not working.
      //
      // Each stopper reports a count and a noun. halt.ts knows neither what a
      // docket is nor what a PTY is; it collects sentences and shows them.
      registerHaltStopper({ name: 'companion', stop: () => ({ name: 'companion', stopped: companion.cancel() ? 1 : 0, note: 'pending answer stopped; provider billing may still apply' }) });
      registerHaltStopper({
        name: 'schedules',
        stop: () => { schedule.stopScheduler(); return { name: 'schedules', stopped: 1, note: 'the scheduler is stopped; no schedule was deleted or moved forward' }; },
      });
      registerHaltStopper({
        name: 'queue',
        stop: () => { queue.stopDispatcher(); return { name: 'queue', stopped: 1, note: 'the dispatcher is stopped; queued rows keep their place' }; },
      });
      registerHaltStopper({
        name: 'autopilots',
        stop: () => ({ name: 'autopilots', stopped: control.disarmAllAutopilots(), note: 'disarmed, not paused — arm them again yourself' }),
      });
      registerHaltStopper({
        name: 'batch polling',
        stop: () => {
          if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
          // Said plainly rather than counted. A batch the API has accepted runs
          // on Anthropic's machines and no switch here reaches it; claiming a
          // stop Wanigan did not perform is the one thing this panel must not
          // do. What stopping the poller costs is stated too, because it is the
          // clock that keeps a batch from expiring unwatched.
          return { name: 'batch polling', stopped: 1, note: 'batches already accepted keep running at the API and are no longer being watched' };
        },
      });
      registerHaltStopper({
        name: 'learning',
        stop: () => { learning.stopConsolidator(); return { name: 'learning', stopped: 1, note: 'the background consolidator is stopped' }; },
      });
      // Last, once nothing is left that would replace them.
      registerHaltStopper({
        name: 'sessions',
        stop: () => ({ name: 'sessions', stopped: killAll(), note: 'every live agent was signalled; working trees are untouched' }),
      });

      stage = 'mobile control setup';
      configureMobileSources();

      stage = 'background services';
      await startServices();

      try { await mobile.startMobileMonitor(); }
      catch (error) { console.warn('[wanigan] phone monitor did not start:', error); }

      attendedServicesStarted = true;
      startPoller();
      return publishStartupState({ phase: 'ready', stage: null, message: null });
    } catch (error) {
      return enterStartupRecovery(stage, error);
    }
  })();
  startupAttempt = attempt;
  try {
    return await attempt;
  } finally {
    if (startupAttempt === attempt) startupAttempt = null;
  }
}

function stopServices() {
  setSessionExitObserver(null);
  // A held banner can still be clicked after the renderer is gone. Dropping the
  // route leaves notify.ts's own degraded behaviour — raise the window — rather
  // than sending into a destroyed WebContents.
  notify.setNotificationOpener(null);
  notify.setInAppAlertSink(null);
  stopHookEventListener?.();
  stopHookEventListener = null;
  try { mobile.stopMobileMonitor(); } catch { /* already down */ }
  learning.stopConsolidator();
  learning.setLearningChangedNotifier(null);
  hooks.setLearningBriefingHook(null);
  hooks.setModelSwitchHook(null);
  try { schedule.stopScheduler(); } catch { /* already down */ }
  try { queue.stopDispatcher(); } catch { /* already down */ }
  if (autopilotTimer) { clearInterval(autopilotTimer); autopilotTimer = null; }
  if (transcriptTimer) { clearInterval(transcriptTimer); transcriptTimer = null; }
  try { hooks.stopHookServer(); } catch { /* already down */ }
  try { otel.stopCollector(); } catch { /* already down */ }
  try { mcpServer.stopMcpServer(); } catch { /* already down */ }
}

/** Switch storage partitions by replacing only the window. The live sessions
 * stay in main; their event sink is suspended before the old window is hidden.
 * A demo's storage is in memory and never shares drafts with the live profile. */
function switchDemoWindow(on: unknown) {
  if (typeof on !== 'boolean') throw new Error('Demo mode is either on or off.');
  if (changingDemoWindow) throw new Error('The workspace is already changing.');
  if (win && demoWindows.has(win.webContents) === on) return demoState(on);
  changingDemoWindow = true;
  const previous = win;
  try {
    // Construct the replacement before retiring the only usable window. A
    // failed construction is a refused switch, never an uncaught timer error
    // that takes down the main process and its running agents.
    createWindow(on);
    if (previous && !previous.isDestroyed()) win!.setBounds(previous.getBounds());
    setDemo(on);
  } catch {
    const failed = win;
    win = previous;
    if (failed && failed !== previous && !failed.isDestroyed()) failed.destroy();
    notify.setDesktopPrivacy(!!previous && demoWindows.has(previous.webContents));
    changingDemoWindow = false;
    throw new Error('The workspace could not be opened. Your current workspace is unchanged. Try again.');
  }
  previous?.hide();
  // The old sender must live long enough to receive its IPC acknowledgement.
  setTimeout(() => {
    if (previous && !previous.isDestroyed()) previous.destroy();
    changingDemoWindow = false;
    if (!on && !attendedServicesStarted) void startAttendedServices();
  }, 0);
  return demoState(on);
}

/**
 * Which port a tailnet action is allowed to touch: the one the phone monitor is
 * configured to listen on, read here in main. The renderer may send its number
 * along, but it is only ever checked against this one — a mismatch is a screen
 * working from stale configuration, and publishing the port it asked for would
 * put a proxy in front of something Wanigan is not listening on.
 */
function servedPort(requested?: number): number {
  const port = mobile.mobileConfig().port;
  if (requested !== undefined && requested !== port) {
    throw new Error(`Wanigan can only serve the port its phone monitor listens on (${port}).`);
  }
  return port;
}

/** Same URL, ignoring the trailing slash the settings normaliser strips. */
function sameUrl(a: string, b: string): boolean {
  return a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
}

/** This explicit copy action can write only authored text, in either workspace. */
async function copyDemoPrompt(id: unknown): Promise<void> {
  const prompt = DEMO_PROMPTS.find(item => item.id === id);
  if (!prompt) throw new Error('Choose a demo prompt from the list.');
  // Electron's Clipboard is the async W3C-shaped one: writeText returns a
  // promise. Discarded, a refused write left the renderer told it had copied.
  await clipboard.writeText(prompt.text);
}

function registerIpc() {
  const handle = <T>(channel: string, fn: (...args: never[]) => T | Promise<T>) => {
    ipcMain.handle(channel, async (event, ...args) => {
      if (!trustedSender(event.sender, event.senderFrame)) {
        return { ok: false, error: 'Untrusted IPC sender.' };
      }
      const demo = demoWindows.get(event.sender);
      try {
        // A window's source is frozen for its lifetime, including requests
        // finishing after a toggle. No fake value is translated into a real
        // path, and unknown demo channels never invoke a production handler.
        if (channel === 'demo:state') return { ok: true, data: demoState(!!demo) };
        if (channel === 'demo:set') return { ok: true, data: switchDemoWindow(args[0]) };
        if (channel === 'demo:copyPrompt') return { ok: true, data: await copyDemoPrompt(args[0]) };
        if (channel === 'window:visible') return { ok: true, data: !!win?.isVisible() && !win?.isMinimized() };
        const data = demo ? demo.read(channel, args) : await fn(...args as never[]);
        if (demo && channel === 'settings:set' && args[0] === 'nav_sidebar') installApplicationMenu(() => win, args[1] === 'open');
        return { ok: true, data };
      } catch (e) {
        return { ok: false, error: demo ? DEMO_UNAVAILABLE : e instanceof Error ? e.message : String(e) };
      }
    });
  };

  // This handler is intentionally database-free. It remains available when a
  // failed migration has put the attended UI in recovery mode, so the renderer
  // can explain why normal controls are paused and offer one bounded retry.
  handle('companion:snapshot', (projectId: unknown) => companion.snapshot(projectId));
  handle('companion:history', (projectId: unknown) => companion.history(projectId));
  handle('companion:ask', (input: unknown) => companion.ask(input));
  handle('companion:cancel', () => companion.cancel());

  handle('startup:status', () => startupSnapshot());
  handle('window:visible', () => !!win&&!win.isDestroyed()&&win.isVisible()&&!win.isMinimized());
  handle('startup:retry', () => startAttendedServices());

  handle('demo:state', () => demoState());
  handle('demo:set', (on: boolean) => switchDemoWindow(on));
  handle('demo:copyPrompt', (id: unknown) => copyDemoPrompt(id));

  handle('providers:list', () => detectProviders());
  /*
   * The first-run checklist's one read. Read-only and side-effect free, and
   * deliberately a single channel: resolution re-scans the filesystem on every
   * call and the version cache is keyed on the resolved path plus its size and
   * mtime, so a CLI installed after launch resolves to a key that has never
   * been cached. A separate "recheck" would have had nothing to invalidate.
   */
  handle('preflight:read', () => readPreflight());
  /*
   * Candidate projects read out of Claude and Codex history. Read-only: it
   * registers nothing and widens no root. Importing still goes through
   * projects:add, which validates each path in main, so this only ever
   * proposes — the renderer cannot turn a scan result into a managed root on
   * its own.
   */
  handle('discovery:scan', () => discoverProjects());
  /*
   * Register several discovered projects at once.
   *
   * projects:add refuses a path the interface names, and that rule stands: the
   * renderer still cannot widen the managed-root set by naming a directory.
   * What it may do here is choose from a set *main itself* produced — every
   * path is re-checked against this process's own most recent scan, so a path
   * the renderer invented is refused — and a person then confirms the whole
   * list in a main-process dialog before anything is registered. Main decides,
   * with the operator, exactly as the folder picker arranges today.
   */
  /*
   * Continuing one conversation on another Codex account, for when the one it
   * started on runs out of usage. Read-only: it reports what could be done and
   * why not, so a surface never draws a control that cannot work.
   */
  /*
   * Carrying a filling conversation into a fresh one. Two calls because the
   * wait between them is the renderer's — Stop already arrives there. The
   * renderer never supplies the note: it names a session, and main reads the
   * text from that session's own transcript.
   */
  handle('handover:begin', (sessionId: unknown) => {
    if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('No session was named.');
    return beginHandover(sessionId.trim());
  });
  handle('handover:finish', (sessionId: unknown) => {
    if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('No session was named.');
    return finishHandover(sessionId.trim());
  });
  handle('handoff:plan', (sessionId: unknown) =>
    (typeof sessionId === 'string' && sessionId.trim() ? handoffPlan(sessionId.trim()) : {
      threadId: null, fromAccountId: null, targets: [], unavailable: 'No session was named.',
    }));
  /*
   * The write half. main decides: the account must be one of the targets this
   * conversation actually has, the source is never moved or removed, and the
   * account it started on can still continue it afterwards.
   */
  handle('handoff:move', (sessionId: unknown, accountId: unknown) => {
    if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('No session was named.');
    if (typeof accountId !== 'string' || !accountId.trim()) throw new Error('No account was chosen.');
    return handoffConversation(sessionId.trim(), accountId.trim());
  });
  handle('discovery:import', async (raw: unknown) => {
    if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== 'string')) {
      throw new Error('Choose projects from the discovered list.');
    }
    const wanted = [...new Set((raw as string[]).map((entry) => path.resolve(entry)))];
    const refused = wanted.filter((dir) => !wasDiscovered(dir));
    if (refused.length) {
      throw new Error('Wanigan only imports directories it found in your agent history. Run the scan again and choose from that list.');
    }
    if (!wanted.length || !win) return listProjects();

    const shown = wanted.slice(0, 12).map((dir) => `· ${dir}`).join('\n');
    const more = wanted.length > 12 ? `\n· …and ${wanted.length - 12} more` : '';
    const answer = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['Add projects', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      title: 'Add projects',
      message: `Add ${wanted.length} ${wanted.length === 1 ? 'project' : 'projects'} to Wanigan?`,
      detail: `Wanigan will be able to run agents in ${wanted.length === 1 ? 'this directory' : 'these directories'}.\n\n${shown}${more}`,
    });
    if (answer.response !== 0) return listProjects();

    for (const dir of wanted) {
      // Re-check at the moment of writing: a directory can vanish between the
      // scan and the confirmation, and addProject validates again besides.
      try { await addProject(dir); } catch { /* skip one bad path, keep the rest */ }
    }
    return listProjects();
  });
  /*
   * The catalogue for one profile's model field.
   *
   * providerById reads the frozen pack SNAPSHOT. detectProviders() would call
   * refreshProviderPacks() and re-probe the version and capabilities of every
   * installed CLI, which is far too much work to hang off a picker opening.
   */
  handle('providers:modelCatalogue', async (providerId: unknown) => {
    const def = providerById(String(providerId));
    if (!def) throw new Error('That provider profile is not loaded.');
    return providerModelCatalogue({
      backendId: def.backendId,
      supports: def.supports,
      launchFields: launchFieldsFor(def),
    });
  });
  handle('providerPacks:list', (includeRemoved?: boolean) =>
    publicProviderPacks(includeRemoved === true));
  handle('providerPacks:inspectManifest', (packId: string): ProviderManifestInspection => {
    const pack = providerPackRegistry.listPacks({ includeRemoved: true }).find((value) => value.id === packId);
    if (!pack?.manifest) throw new Error(`Provider pack "${packId}" has no inspectable manifest.`);
    return {
      packId: pack.id,
      label: pack.label,
      version: pack.version,
      sha256: pack.manifestSha256,
      publisher: pack.manifest.publisher
        ? `${pack.manifest.publisher.name} (${pack.manifest.publisher.id})`
        : null,
      adapter: pack.manifest.adapter ? {
        executable: pack.manifest.adapter.executable,
        args: [...(pack.manifest.adapter.args ?? [])],
        sha256: pack.adapterSha256,
      } : null,
      commands: pack.manifest.profiles.map((profile) => ({
        profileId: profile.id,
        profileLabel: profile.label,
        harness: profile.harness,
        headless: profile.headless ?? 'none',
        declaredBackendId: profile.backend.id,
        backendId: effectiveProviderBackendId({
          source: pack.source,
          packId: pack.id,
          backend: profile.backend,
        }),
        bin: profile.command.bin,
        baseArgs: [...(profile.command.baseArgs ?? [])],
        versionArgs: [...(profile.command.versionArgs ?? ['--version'])],
        helpArgs: [...(profile.command.helpArgs ?? ['--help'])],
        launchFields: (profile.launchFields ?? []).map((field) => ({
          id: field.id,
          label: field.label,
          kind: field.kind,
          argv: [...(field.argv ?? [])],
          trueArgv: [...(field.trueArgv ?? [])],
          falseArgv: [...(field.falseArgv ?? [])],
        })),
        resume: profile.resume ? {
          conversationArgs: [...profile.resume.conversationArgs],
          continueArgs: [...profile.resume.continueArgs],
        } : null,
        fallbackPaths: [...(profile.command.fallbackPaths ?? [])],
        editorExtensions: (profile.command.editorExtensions ?? []).map((entry) => ({
          prefix: entry.prefix,
          executablePaths: [...entry.executablePaths],
        })),
        environment: Object.entries(profile.environment ?? {}).map(([name, value]) => ({
          name,
          source: value.source,
          value: value.source === 'literal' ? value.value : null,
          processName: value.source === 'process' ? value.name : null,
          fallback: value.source === 'process' ? value.fallback ?? null : null,
          credentialId: value.source === 'credential' ? value.id ?? profile.id : null,
        })),
        credentialIds: Object.values(profile.environment ?? {})
          .filter((value) => value.source === 'credential')
          .map((value) => value.id ?? profile.id),
      })),
      warning: pack.source === 'local'
        ? 'Approval authorizes Wanigan to execute these installed command names with every displayed argv and environment mapping. Literal values and process-variable sources/fallbacks are shown; stored credential values remain redacted. HOME/PATH and similar mappings can redirect config or subprocess discovery. Version and help probes run automatically with a minimal credential-free environment; session commands still have normal filesystem access and are not OS-sandboxed. Runtime loader/preload variables, Wanigan/telemetry overrides, known shells/interpreters, and escaping fallback paths are refused as defense in depth, not as proof that a command is safe. Local backend identity is namespaced to this pack and cannot inherit another provider\'s semantic memory. Executable adapters require a separate exact-digest approval.'
        : 'This provider pack is built into Wanigan.',
    };
  });
  handle('providerPacks:profiles', (includeDisabled?: boolean) =>
    providerPackRegistry.listProfiles({ includeDisabled: includeDisabled === true }).map((profile) => ({
      id: profile.id,
      packId: profile.packId,
      packVersion: profile.packVersion,
      label: profile.label,
      description: profile.description,
      harness: profile.harness,
      backendId: effectiveProviderBackendId(profile),
      bin: profile.command.bin,
      enabled: profile.enabled,
      supports: {
        model: !!profile.launchFields?.some((field) => field.id === 'model'),
        effort: !!profile.launchFields?.some((field) => field.id === 'effort'),
        permissionMode: !!profile.launchFields?.some((field) => field.id === 'permissionMode'),
        resume: !!profile.resume,
      },
      capabilities: profile.capabilities,
      launchFields: (profile.launchFields ?? []).map((field) => ({
        id: field.id, label: field.label, kind: field.kind, required: field.required,
        description: field.description, options: field.choices, defaultValue: field.defaultValue,
      })),
    })));
  handle('providerPacks:refresh', () => { refreshProviderPacks(); return publicProviderPacks(); });
  handle('providerPacks:setEnabled', (packId: string, enabled: boolean) => {
    providerPackRegistry.setEnabled(packId, enabled);
    refreshProviderPacks(); return publicProviderPacks();
  });
  // Recording a trusted digest is the durable, on-disk grant that lets a local
  // pack choose the argv and the entire environment of an already-installed CLI,
  // and agentEnv assigns a pack's environment after it sets PATH, so a pack that
  // names PATH wins. It was a bare pass-through, and the only place a human was
  // asked was a page the renderer draws — which is not a trust boundary, because
  // a compromised renderer can decline to draw it. plugins:marketAdd states the
  // rule for the smaller of the two grants; this is the larger one.
  //
  // The registry's own refusals are re-checked before the dialog rather than
  // after it, so the operator is never asked to approve something trustManifest
  // would reject a moment later. The manifest and the adapter stay two separate
  // questions: trusting one must not trust the other.
  handle('providerPacks:trustManifest', async (packId: unknown, sha256: unknown) => {
    if (typeof packId !== 'string' || !packId.trim()) throw new Error('That provider pack is not installed.');
    if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) throw new Error('A digest to trust is required.');
    const pack = providerPackRegistry.listPacks({ includeRemoved: true })
      .find((entry) => entry.id === packId && entry.source === 'local');
    if (!pack) throw new Error('That provider pack is not installed.');
    if (!pack.manifest || !pack.manifestSha256) throw new Error('That provider pack has no inspectable manifest.');
    if (pack.manifestSha256 !== sha256) {
      throw new Error('The provider manifest changed after inspection. Review the new digest before trusting it.');
    }
    const w = liveWindow();
    if (!w || w.isDestroyed()) {
      throw new Error('Trusting a provider pack needs the Wanigan window open to confirm it.');
    }
    const answer = await dialog.showMessageBox(w, {
      type: 'warning',
      buttons: ['Cancel', 'Trust this manifest digest'],
      defaultId: 0,
      cancelId: 0,
      ...manifestTrustPrompt(pack),
    });
    if (answer.response !== 1) throw new Error('Cancelled. Nothing was trusted and nothing was enabled.');
    providerPackRegistry.trustManifest(packId, sha256);
    refreshProviderPacks(); return publicProviderPacks();
  });
  handle('providerPacks:inspectAdapter', (packId: string) => {
    const inspected = providerPackRegistry.inspectAdapter(packId);
    const pack = providerPackRegistry.listPacks({ includeRemoved: true }).find((value) => value.id === packId);
    return {
      packId,
      path: inspected?.executable ?? null,
      sha256: inspected?.sha256 ?? null,
      trusted: !!inspected && pack?.trustedAdapterSha256 === inspected.sha256,
      executable: !!inspected,
      args: [...(pack?.manifest?.adapter?.args ?? [])],
      warning: inspected
        ? 'Trust authorizes this exact executable digest to run as a separate process. It is not an OS sandbox.'
        : 'This provider pack has no executable adapter to inspect.',
    };
  });
  handle('providerPacks:trustAdapter', async (packId: unknown, sha256: unknown) => {
    if (typeof packId !== 'string' || !packId.trim()) throw new Error('That provider pack is not installed.');
    if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) throw new Error('A digest to trust is required.');
    const pack = providerPackRegistry.listPacks({ includeRemoved: true })
      .find((entry) => entry.id === packId && entry.source === 'local');
    if (!pack) throw new Error('That provider pack is not installed.');
    // inspectAdapter hashes the file on disk, so the digest in the dialog is the
    // main process's own reading and not a number the caller supplied.
    const inspected = providerPackRegistry.inspectAdapter(packId);
    if (!inspected) throw new Error('That provider pack has no executable adapter to trust.');
    if (inspected.sha256 !== sha256) {
      throw new Error('The adapter changed after it was inspected. Review the new digest before trusting it.');
    }
    const w = liveWindow();
    if (!w || w.isDestroyed()) {
      throw new Error('Trusting a provider pack needs the Wanigan window open to confirm it.');
    }
    const answer = await dialog.showMessageBox(w, {
      type: 'warning',
      buttons: ['Cancel', 'Trust this adapter digest'],
      defaultId: 0,
      cancelId: 0,
      ...adapterTrustPrompt(pack, inspected),
    });
    if (answer.response !== 1) throw new Error('Cancelled. The adapter was not trusted.');
    providerPackRegistry.trustAdapter(packId, sha256);
    refreshProviderPacks(); return publicProviderPacks();
  });
  handle('providerPacks:revokeAdapterTrust', (packId: unknown) => {
    if (typeof packId !== 'string' || !packId.trim()) throw new Error('That provider pack is not installed.');
    providerPackRegistry.revokeAdapterTrust(packId);
    refreshProviderPacks(); return publicProviderPacks();
  });
  handle('providerPacks:remove', (packId: string) => {
    providerPackRegistry.requestUninstall(packId, activeProviderProfileIds());
    refreshProviderPacks(); return publicProviderPacks(true);
  });
  handle('providerPacks:restore', (packId: string) => {
    providerPackRegistry.restore(packId);
    refreshProviderPacks(); return publicProviderPacks(true);
  });

  handle('projects:list', () => listProjects());
  handle('projects:refresh', () => refreshBranches());
  /*
   * A registered project is the seed of the allowlist every other guard leans
   * on: roots.ts builds managedRoots() from exactly this table, and its header
   * states the premise — "Both come from this process's own records, never from
   * the caller." This channel broke that. It took a bare path from the renderer
   * and inserted it, and addProject's only refusal is assertWholeRepo, which
   * rejects a *subdirectory* of a repo and passes any other directory. One call
   * naming a home directory registered a root, and from then on assertManagedRoot
   * succeeded for everything under it: code:read on ~/.ssh, browse:open handing
   * a file to LaunchServices, and — if the directory happened to be a repo —
   * git:discard and git:checkout writing to it.
   *
   * The path now has to be confirmed in the main process, naming the exact
   * directory, the way plugins:marketAdd already confirms a marketplace. That
   * keeps the drag-and-drop and scripted routes working while making the one
   * thing that matters — "the operator saw this path and agreed to it" — true
   * again. projects:pick, which sources its path from a main-process dialog,
   * needs no second confirmation and does not get one.
   */
   /*
   * A registered project is the seed of the allowlist every other guard leans
   * on: roots.ts builds managedRoots() from exactly this table, and its header
   * states the premise — "Both come from this process's own records, never from
   * the caller." This channel broke that. It took a bare path from the renderer
   * and inserted it, and addProject's only refusal is assertWholeRepo, which
   * rejects a *subdirectory* of a repo and passes any other directory. One call
   * naming a home directory registered a root, and from then on assertManagedRoot
   * succeeded for everything under it: code:read on ~/.ssh, browse:open handing
   * a file to LaunchServices, and — if the directory happened to be a repo —
   * git:discard and git:checkout writing to it.
   *
   * The renderer no longer decides. It may ask; this process decides, and the
   * decision needs a person: projects:pick opens the main-process folder
   * picker, which names the exact directory before a row is written, and is
   * the only route in a normal run. Because its path comes from that dialog it
   * needs no second confirmation and does not get one.
   *
   * The raw-path form survives for one caller. scripts/shots.mjs drives the
   * built app headlessly to capture every view, and it cannot click a native
   * picker — a window-modal sheet with nobody to dismiss it hangs the run
   * rather than failing it. So this channel answers only an automation run:
   * see src/main/automation.ts, which also refuses the marker outright in a
   * packaged build. A page cannot put a flag on argv.
   */
  handle('projects:add', (dir: unknown) => {
    if (!automationRun()) {
      throw new Error('Wanigan registers a project from its own folder picker, not from a path the interface names. Use Add project.');
    }
    if (typeof dir !== 'string' || !dir.trim()) throw new Error('A project path is required.');
    return addProject(path.resolve(dir));
  });
  handle('projects:remove', (id: string) => { removeProject(id); return listProjects(); });
  handle('projects:pick', async () => {
    if (!win) return null;
    const res = await dialog.showOpenDialog(win, {
      title: 'Add a project',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Add project',
    });
    if (res.canceled || !res.filePaths[0]) return null;
    return addProject(res.filePaths[0]);
  });

  handle('sessions:list', () => sessionListEntries());
  // The dispatcher meter's missing half. Every other surface is a queue row and
  // can be counted from the queue; an interactive session never creates one, so
  // the limit sessions.ts now enforces read "0 of N" on the page that sets it.
  // sessions.ts keeps its own live count module-private, so this derives the
  // same thing from the session list rather than reaching into that module.
  handle('sessions:liveCount', (): InteractiveSessionLoad => ({
    live: listSessions().filter((value) => value.status !== 'exited').length,
    limit: queue.slots().session,
  }));
  handle('sessions:create', async (opts: LaunchOptions) => {
    const created = await createSession(opts);
    // The first live agent is what takes the power-save blocker. Doing it here
    // rather than waiting for the poller means the Mac is already held before
    // the operator has finished closing the lid.
    syncAwake();
    return created;
  });
  // Separate from sessions:create: only the exact UUID + selected project
  // cross this boundary, so arbitrary launch flags cannot turn recovery into a
  // broad Codex picker or a second writer.
  handle('sessions:recoverExactCodex', (input: { threadId: unknown; projectId: unknown }) =>
    recoverExactCodexThread(input));
  handle('sessions:scrollback', (id: string) => scrollback(id));
  handle('sessions:interrupt', (id: string, force?: boolean) => interruptSession(id, force === true));
  handle('sessions:kill', (id: string) => killSession(id));
  handle('sessions:close', (id: string) => { closeSession(id); return true; });
  handle('sessions:markRead', (id: string) => { markRead(id); return true; });
  // 'sessions:write' is fire-and-forget; this typed variant exists so a tuning
  // slash command and its session-record update cannot drift apart.
  handle('sessions:setTuning', (id: string, field: unknown, value: unknown) => setSessionTuning(id, field, value));
  // The status bar may reveal only the folder of a live Wanigan session. A
  // generic renderer-controlled shell.openPath bridge would let a compromised
  // renderer invoke arbitrary file handlers on this Mac.
  handle('sessions:reveal', async (id: string) => {
    if (typeof id !== 'string' || !id.trim() || id.length > 200) {
      throw new Error('Choose a live session to reveal its folder.');
    }
    const value = listSessions().find((candidate) => candidate.id === id);
    if (!value) throw new Error('That session is no longer open in Wanigan.');
    const target = value.worktree ?? value.projectPath;
    const error = await shell.openPath(target);
    if (error) throw new Error(`Wanigan could not open this session folder: ${error}`);
    return true;
  });
  handle('sessions:baseline', (id: string) => sessionBaseline(id));
  handle('sessions:past', () => pastSessions());
  handle('sessions:forget', (id: string) => { forgetPastSession(id); return pastSessions(); });
  handle('sessions:setConversationFlag', (id: string, flag: unknown, on: unknown) => {
    if (flag !== 'pin' && flag !== 'settle') throw new Error('That is not a lifecycle flag Wanigan knows.');
    return setConversationFlag(String(id), flag, on === true);
  });
  handle('sessions:rename', (id: string, title: unknown) => renameSession(String(id), title));

  handle('checkpoints:list', (sessionId: string) => checkpoints.listCheckpoints(String(sessionId)));
  handle('checkpoints:diff', (sessionId: string, fromId: number, toId: number) => {
    if (!Number.isInteger(fromId) || !Number.isInteger(toId)) throw new Error('Those checkpoint ids are not valid.');
    return checkpoints.checkpointDiff(String(sessionId), fromId, toId);
  });
  handle('checkpoints:revertPlan', (sessionId: string, checkpointId: number) => {
    if (!Number.isInteger(checkpointId)) throw new Error('That checkpoint id is not valid.');
    return checkpoints.checkpointRevertPlan(String(sessionId), checkpointId);
  });
  handle('checkpoints:revert', (sessionId: string, checkpointId: number) => {
    if (!Number.isInteger(checkpointId)) throw new Error('That checkpoint id is not valid.');
    return checkpoints.applyCheckpointRevert(String(sessionId), checkpointId);
  });
  handle('checkpoints:removeRepo', (projectPath: string, apply: boolean) =>
    checkpoints.removeRepoCheckpoints(String(projectPath), apply === true));

  // ── batches ──────────────────────────────────────────────────────────
  handle('batch:presets', (projectId?: string) => batch.presetsFor(projectId));
  // Rethrown, not swallowed. Returning an 'unavailable' shape resolved the
  // renderer's await, so its catch never ran, its "Model refresh failed" Note
  // could never fire, and the button went back to rest above a capability table
  // the page then described as freshly read. The renderer already has the
  // failure path; this is what reaches it.
  handle('batch:refreshModels', () => batch.refreshModels());
  handle('batch:insights', () => batch.insights());
  handle('batch:preview', (source: SourceConfig, userTemplate: string) => batch.previewSource(source, userTemplate));
  handle('batch:estimate', (config: RunConfig, observedOut?: number) => batch.estimateRun(config, observedOut));
  handle('batch:dryRun', (config: RunConfig, rowIndex?: number) => batch.dryRunOne(config, rowIndex));
  handle('batch:runs', () => batch.listRuns());
  handle('batch:runsInFlight', () => batch.runsInFlight());
  handle('batch:run', (id: string) => batch.runDetail(id));
  handle('batch:results', (id: string, status: string, q: string, offset: number) =>
    batch.runResults(id, status, q, offset));
  handle('batch:submit', async (config: RunConfig, est?: { input: number; output: number; cost: number }) => {
    const r = await batch.createAndSubmitRun(config, { estimate: est });
    void batch.pollOnce().catch(() => {});
    return r;
  });
  handle('batch:cancel', (id: string) => batch.cancelRun(id));
  handle('batch:retry', (id: string) => batch.retryFailed(id));
  handle('batch:delete', (id: string) => { batch.deleteRun(id); return true; });
  handle('batch:poll', () => batch.pollOnce());
  handle('batch:export', async (id: string, format: 'jsonl' | 'csv') => {
    if (!win) return null;
    const res = await dialog.showSaveDialog(win, {
      title: 'Export results',
      defaultPath: `${id}.${format}`,
      filters: [{ name: format.toUpperCase(), extensions: [format] }],
    });
    if (res.canceled || !res.filePath) return null;
    return writeExport(id, format, res.filePath);
  });

  // ── api key ──────────────────────────────────────────────────────────
  handle('key:status', async () => ({
    present: hasKey() || Boolean(process.env.ANTHROPIC_API_KEY),
    fingerprint: keyFingerprint(),
    encryptionAvailable: encryptionAvailable(),
    fromEnv: Boolean(process.env.ANTHROPIC_API_KEY),
    workspaceId: getWorkspaceId(),
  }));
  handle('key:set', async (key: string, workspaceId?: string) => {
    const check = await verifyKey(key, workspaceId);
    if (!check.ok) {
      const err = new Error(check.detail) as Error & { needsWorkspaceId?: boolean };
      err.needsWorkspaceId = check.needsWorkspaceId;
      throw err;
    }
    setKey(key, workspaceId);
    return { detail: check.detail, batches: check.batches, fingerprint: keyFingerprint() };
  });
  handle('key:verify', () => verifyKey());

  // A provider credential is a different secret with a different blast radius:
  // the Z.ai token GLM runs on is not the Anthropic key and must never be
  // substituted for it, so it gets its own slot and its own UI.
  handle('key:provider', (rawId: string) => {
    const id = managedProviderCredentialId(rawId);
    // Effective presence, not stored presence. getProviderKey lets
    // WANIGAN_<ID>_KEY win (keys.ts) and docs/provider-packs.md documents that
    // precedence, so answering from the file alone made this handler disagree
    // with the same process: sessions authenticated while the panel said no key
    // was stored, and the fingerprint beside that sentence was the env key's,
    // because providerKeyFingerprint resolves through getProviderKey. key:status
    // has reported its Anthropic equivalent this way all along.
    const fromEnv = Boolean(process.env[`WANIGAN_${id.toUpperCase()}_KEY`]);
    return {
      present: hasProviderKey(id) || fromEnv,
      fingerprint: providerKeyFingerprint(id),
      fromEnv,
      /** Whether Remove has anything to remove: it clears the file only. */
      stored: hasProviderKey(id),
    };
  });
  /*
   * Which credentials a profile declares and does not have, so the new-session
   * dialog can ask for the right one in place instead of sending the operator
   * to Settings to guess. Read-only, and it names ids the operator already sees
   * — never a key, a fingerprint or a path. The id is validated here because it
   * arrives from the renderer.
   */
  handle('key:missingFor', (rawId: unknown) =>
    (typeof rawId === 'string' && rawId.trim() ? missingCredentialIds(rawId.trim()) : []));
  handle('key:setProvider', async (rawId: string, key: string) => {
    const id = managedProviderCredentialId(rawId);
    if (id === 'glm') {
      const verified = await verifyGlmKey(key);
      if (!verified.ok) throw new Error(verified.detail);
    }
    if (id === 'deepseek') {
      const verified = await verifyDeepSeekKey(key);
      if (!verified.ok) throw new Error(verified.detail);
    }
    if (id === 'xai') {
      const verified = await verifyXaiKey(key);
      if (!verified.ok) throw new Error(verified.detail);
    }
    setProviderKey(id, key);
    return { present: true, fingerprint: providerKeyFingerprint(id) };
  });
  handle('key:clearProvider', (rawId: string) => { clearProviderKey(managedProviderCredentialId(rawId)); return true; });
  handle('glm:models', (force?: boolean) => glmModels(force === true));
  handle('glm:verify', () => verifyGlmKey());
  handle('deepseek:models', (force?: boolean) => deepseekModels(force === true));
  handle('deepseek:verify', () => verifyDeepSeekKey());
  handle('xai:models', (force?: boolean) => xaiModels(force === true));
  handle('xai:verify', () => verifyXaiKey());
  handle('settings:get', () => ({ spendCapUsd: spendCap() }));

  // ── code panel ───────────────────────────────────────────────────────
  handle('code:editors', () => code.detectEditors());
  handle('code:open', (editorPath: string | null, target: string, line?: number) =>
    code.openInEditor(editorPath, target, line));
  handle('code:changes', (root: string, sessionId?: string) =>
    code.gitChanges(root, sessionId ? sessionBaseline(sessionId) : null));
  handle('code:diff', (root: string, file: string) => code.gitDiff(root, file));
  handle('code:list', (root: string, rel: string) => code.listDir(root, rel));
  handle('code:read', (root: string, rel: string) => code.readProjectFile(root, rel));
  // Account limits come from Codex's authenticated local app-server, not a
  // token estimate. This endpoint is intentionally read-only.
  handle('codex:status', (force?: boolean) => codexStatus.readCodexStatus(force === true));
  handle('codex:models', (force?: boolean) => codexStatus.readCodexModels(force === true));
  handle('codex:usageSummary', () => codexUsageSummary());
  // The cap is the one control that stands between a mistyped row count and a
  // runaway batch, and it was written to the settings table exactly as the
  // renderer sent it: NaN, Infinity, a negative, or a string. spendCap() reads
  // it back through Number() and falls back to 1.00 on a non-finite value, so a
  // bad write did not crash — it silently reinstated a cap the operator thought
  // they had changed.
  handle('settings:setSpendCap', (v: unknown) => {
    const cap = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(cap) || cap < 0) throw new Error('A spend cap must be a number of dollars, zero or more.');
    if (cap > 100_000) throw new Error('A spend cap above $100,000 is refused as a typo.');
    setSetting('spend_cap_usd', String(Math.round(cap * 100) / 100));
    return spendCap();
  });
  handle('key:clear', () => { clearKey(); return true; });


  // ══ phase 1 · telemetry ═════════════════════════════════════════════
  /*
   * Limits somebody's own visit to Usage already established. Never probes:
   * a surface on a poll must not spend an account probe, which is why this
   * exists rather than a cheaper-looking usage:snapshot call.
   */
  handle('usage:known', () => usage.knownLimits());
  handle('usage:session', (id: string) => otel.usageFor(id));
  handle('usage:many', (ids: string[]) => otel.usageForMany(ids));
  handle('usage:events', (id: string, limit?: number) => otel.apiEvents(id, limit));
  handle('usage:throughput', (id: string, buckets?: number) => otel.throughput(id, buckets));
  handle('usage:collector', () => ({ port: otel.collectorPort() }));

  // ══ phase 2/3/8 · hook bus, attention, timeline ═════════════════════
  handle('events:session', (id: string, limit?: number) => hooks.sessionEvents(id, limit));
  handle('events:live', (id: string) => hooks.liveState(id));
  handle('events:tools', (id: string) => hooks.toolStats(id));
  handle('attention:list', () => attention.attentionFor(listSessions()));

  // ══ phase 4 · transcripts ═══════════════════════════════════════════
  handle('transcripts:search', (q: string, limit?: number) => transcripts.searchTranscripts(q, limit));
  handle('transcripts:get', (id: string) => transcripts.transcriptFor(id));
  handle('transcripts:list', () => transcripts.archivedSessions());
  handle('transcripts:forget', (id: string) => { transcripts.forgetTranscript(id); return true; });
  // Context occupancy for the selected session. Resolved from this process's
  // own session record — the renderer names a session, never a path — and
  // gated on the harness that actually writes a transcript.
  handle('transcripts:context', (sessionId: string) => {
    const s = listSessions().find((x) => x.id === String(sessionId));
    if (!s) return { kind: 'no-transcript' } as const;
    const claude = s.harnessId ? s.harnessId === 'claude-code' : runsClaudeCli(s.providerId);
    if (!claude) return { kind: 'unsupported' } as const;
    return transcripts.claudeContextUsage(s.worktree ?? s.projectPath, s.conversationId ?? null, s.createdAt);
  });

  // ══ phase 9 · worktrees ═════════════════════════════════════════════
  // Read paths are confined too. Every other handler in this block passes its
  // root through assertManagedRoot; these two took whatever the renderer named
  // and ran git in it, which is the one rule this file states most often —
  // renderer input is untrusted until main has validated it. Reading is a
  // smaller grant than removing a tree, and it is still a grant.
  //
  // No String() on the way in: assertManagedRoot is typed (root: unknown) and
  // answers a non-string with "That repository is not a folder Wanigan can act
  // on", whereas String(Symbol()) throws a TypeError that names nothing and
  // String(undefined) manufactures the path "undefined" for it to refuse.
  //
  // One honest caveat: listWorktrees returns paths straight from `git worktree
  // list --porcelain`, which can name a worktree outside every managed root, so
  // a future UI that lists those and then asks about one gets a refusal from
  // worktrees:status rather than a status.
  handle('worktrees:list', (repoRoot: unknown) =>
    worktrees.listWorktrees(assertManagedRoot(repoRoot, 'That repository')));
  handle('worktrees:status', (p: unknown) =>
    worktrees.worktreeStatus(assertManagedRoot(p, 'That worktree')));
  // removeWorktree already refuses a directory git does not call a worktree,
  // but that leaves every worktree on the machine in range of a channel name.
  // Confining the base first means Wanigan only deletes trees inside the
  // projects and worktrees it has a record of.
  handle('worktrees:remove', (p: string, force: boolean) =>
    worktrees.removeWorktree(assertManagedRoot(p, 'That worktree'), force));
  // Without this a fleet run ends with N worktrees holding the only copy of the
  // work and no way to land any of them from inside the app. Every refusal
  // comes back as { merged: false, detail }; it only throws when there is no
  // worktree at the path at all, so ok:false here is the rare case.
  handle('worktrees:merge', (p: string, opts?: { squash?: boolean; message?: string }) =>
    worktrees.mergeWorktree(assertManagedRoot(p, 'That worktree'), opts));
  handle('worktrees:orphans', () => worktrees.reconcileWorktrees(liveSessionIds()));
  handle('worktrees:relink', (p: string) => worktrees.relinkWorktree(assertManagedRoot(p, 'That worktree')));
  handle('worktrees:forSession', (id: string) => worktrees.worktreeForSession(id));

  // ══ phase 10 · headless fan-out ═════════════════════════════════════
  handle('headless:start', async (cfg: HeadlessStartRequest) => {
    const started = await headless.startHeadlessRun(cfg);
    // startHeadlessRun returns once the children are spawned, not when the
    // fan-out finishes, so this reconcile happens with the run genuinely live.
    // Its completion has no IPC boundary at all — the poller releases it.
    syncAwake();
    return started;
  });
  // Status without the transcript. The run view refires this every three
  // seconds and renders none of the agent's stdout in the list, so the text
  // stays in SQLite until a row is expanded — see HeadlessRowSummary.
  handle('headless:rows', (runId: string): HeadlessRowSummary[] =>
    headless.headlessRows(runId).map((row) => {
      const { output, error, ...rest } = row;
      return {
        ...rest,
        output: null,
        error: null,
        hasOutput: typeof output === 'string' && output.length > 0,
        hasError: typeof error === 'string' && error.length > 0,
      };
    }));
  handle('headless:rowDetail', (runId: string, projectId: string): HeadlessRowDetail => {
    const row = headless.headlessRows(runId).find((value) => value.projectId === projectId);
    if (!row) throw new Error('That repository is no longer part of this run.');
    return { runId: row.runId, projectId: row.projectId, output: row.output, error: row.error };
  });
  handle('headless:runs', (limit?: number) => headless.headlessRuns(limit));
  handle('headless:cancel', (runId: string) => headless.cancelHeadless(runId));

  // ══ phase 11 · dispatcher ═══════════════════════════════════════════
  handle('queue:list', (limit?: number) => queue.listQueue(limit));
  handle('queue:counts', () => queue.queueCounts());
  handle('queue:cancel', (id: string) => queue.cancelQueued(id));
  handle('queue:slots', () => queue.slots());
  handle('queue:setSlots', (next: Partial<QueueSlots>) => {
    const v = queue.setSlots(next);
    setSetting('slots', JSON.stringify(v));
    return v;
  });

  // ══ phase 12 · MCP ══════════════════════════════════════════════════
  handle('mcp:servers', (projectId?: string | null) => mcpRegistry.listServers(projectId));
  handle('mcp:upsert', (cfg: Omit<McpServerConfig, 'id'> & { id?: string }) => mcpRegistry.upsertServer(cfg));
  handle('mcp:remove', (id: string) => { mcpRegistry.removeServer(id); return true; });
  handle('mcp:status', () => mcpRegistry.serverStatuses());
  // Everything the Settings page needs to tell an enabled server from an
  // enabled server that is being withheld: the trust state, the digest, and
  // what was approved if anything ever was. mcp:servers cannot carry it —
  // McpServerConfig has no trust field — which is why an untrusted row read as
  // plainly "on" while writeMcpConfig left it out of every session.
  handle('mcp:review', (projectId?: string | null) => mcpRegistry.reviewServers(projectId));
  // The narrow toggle. Enabling still refuses without an approval; the point of
  // having it is that it cannot rewrite the command on the way through, which
  // round-tripping the whole row through mcp:upsert could.
  handle('mcp:setEnabled', (id: unknown, enabled: unknown) => {
    if (typeof id !== 'string' || !id.trim()) throw new Error('That MCP server is not registered.');
    if (typeof enabled !== 'boolean') throw new Error('Enable or disable is required.');
    return mcpRegistry.setServerEnabled(id, enabled);
  });
  // Recording a trusted digest is the durable, on-disk grant that lets the
  // agent's CLI spawn a local command at every launch in this scope, unattended,
  // for as long as the row exists. It is the same class of grant as
  // providerPacks:trustManifest above, and it is asked the same way: the
  // question is raised here, so it is not a step a compromised renderer can
  // decline to render, and the digest in the dialog is re-derived from the row
  // rather than taken from the caller. trustServer re-checks it a third time and
  // deliberately leaves the server switched off — approving and enabling are two
  // acts, and a single click that does both is the thing this gate exists for.
  handle('mcp:trust', async (id: unknown, sha256: unknown) => {
    if (typeof id !== 'string' || !id.trim()) throw new Error('That MCP server is not registered.');
    if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) throw new Error('A digest to trust is required.');
    const review = mcpRegistry.reviewServer(id);
    if (!review) throw new Error('That MCP server is not registered.');
    if (review.transport !== 'stdio') {
      throw new Error(`"${review.name}" is an HTTP server: it runs no local command, so there is nothing to trust.`);
    }
    if (review.sha256 !== sha256) {
      throw new Error('This server changed after it was reviewed. Read the new command, arguments and scope before trusting them.');
    }
    const w = liveWindow();
    if (!w || w.isDestroyed()) {
      throw new Error('Trusting an MCP server command needs the Wanigan window open to confirm it.');
    }
    const answer = await dialog.showMessageBox(w, {
      type: 'warning',
      buttons: ['Cancel', 'Trust this command'],
      defaultId: 0,
      cancelId: 0,
      ...mcpTrustPrompt(review),
    });
    if (answer.response !== 1) throw new Error('Cancelled. Nothing was trusted and nothing was enabled.');
    return mcpRegistry.trustServer(id, sha256);
  });
  handle('mcp:revokeTrust', (id: unknown) => {
    if (typeof id !== 'string' || !id.trim()) throw new Error('That MCP server is not registered.');
    return mcpRegistry.revokeServerTrust(id);
  });
  handle('mcp:server', () => mcpServer.mcpServerInfo());
  handle('mcp:pending', () => mcpServer.pendingConfirmations());

  // ══ phases 5/18 · spend, budgets, reconciliation ════════════════════
  handle('spend:byProject', (days?: number) => spend.spendByProject(days));
  handle('spend:cache', () => spend.unifiedCacheRate());
  handle('spend:sync', (days?: number) => spend.syncComparison(days));
  // The three surfaces as three series, windowed, with the priced/unpriced
  // request counts beside them. Insights used to rebuild this by subtracting a
  // correctly-windowed session series from an always-30-day sync series, which
  // painted interactive spend as headless for every day the two did not cover
  // alike. One read, one authority.
  handle('spend:unified', (days?: number) => spend.unifiedSpend(days));
  handle('spend:effort', () => otel.effortBreakdown());
  handle('spend:byDay', (days: number) => otel.spendByDay(days));
  handle('budgets:list', () => spend.budgets());
  handle('budgets:set', (scopeId: string | null, monthly: number, warnAt?: number) => {
    spend.setBudget(scopeId, monthly, warnAt); return spend.budgets();
  });
  handle('budgets:breached', () => spend.budgetBreached());
  handle('budgets:reconcile', (from: string, to: string) => spend.reconcile(from, to));
  handle('budgets:accuracy', () => spend.estimateAccuracy());
  handle('spend:transcripts', (days?: number) => spend.transcriptMeter(days));
  // The renderer may ask for a slice of ingest so a person who opens Insights
  // on a cold store sees it fill rather than waiting for the background beat.
  // The budget is clamped in claude-usage.ts, so a renderer cannot ask the main
  // process to spend a minute here.
  handle('spend:ingestTranscripts', (budgetMs?: number) => claudeUsage.ingest({ budgetMs }));

  // ══ phase 14 · notifications ════════════════════════════════════════
  handle('notify:expiring', () => notify.expiringSoon());
  handle('notify:resultsExpiring', () => notify.resultsExpiring());
  handle('notify:enabled', () => notify.notificationsEnabled());
  handle('notify:setEnabled', (on: boolean) => { notify.setNotificationsEnabled(on); return on; });
  // Only the renderer knows which session is on screen. Without this the main
  // process believes none of them is, and the operator gets pinged about the
  // very session they are already staring at — which is how a person learns to
  // switch notifications off.
  handle('notify:setWatchedSession', (sessionId: string | null) => {
    notify.setWatchedSession(sessionId);
    // The same fact answers a second question. "Which session is on screen" is
    // what decides whether output should raise an unread badge, and the
    // renderer already reports it here on every tab and selection change —
    // null whenever the operator is anywhere but Sessions, which is exactly
    // when the badge is the only way to learn an agent said something.
    setFocusedSession(sessionId);
    // Switching tabs/sessions can reveal that an alert previously suppressed
    // on the Mac is no longer on screen. Run after this IPC answer rather than
    // making renderer navigation wait on database reads and notification APIs.
    queueMicrotask(announceCurrentAttention);
    return true;
  });
  // ── halt and catch fire ──────────────────────────────────────────────
  //
  // Three calls and no arguments worth guessing at. The renderer polls the
  // state because a halt can be pulled from the phone, and a window that only
  // learned about it on its own click would show a running fleet that is not.
  handle('halt:state', () => haltState());
  handle('halt:pull', async (reason?: string) => {
    const state = await pullHalt({ reason, source: 'desktop' });
    announceHalt(state);
    return state;
  });
  // Clearing restarts what the stop pass stopped — with the deliberate
  // exception of the autopilots, which were disarmed rather than paused. Wanigan
  // does not decide on an operator's behalf that unattended dispatch should
  // resume because a separate emergency is over.
  handle('halt:clear', () => {
    const state = clearHalt();
    resumeAfterHalt();
    return state;
  });

  handle('mobile:status', () => mobile.mobileStatus());
  handle('mobile:configure', async (patch: Parameters<typeof mobile.setMobileConfig>[0]) => {
    const before = mobile.mobileConfig();
    const status = await mobile.setMobileConfig(patch);
    const deliveryChanged = before.pushEnabled !== status.config.pushEnabled
      || before.pushServer !== status.config.pushServer
      || before.pushTopic !== status.config.pushTopic
      || before.webPushEnabled !== status.config.webPushEnabled;
    // Enabling alerts while a session is already waiting should not require
    // another lifecycle transition (or up to one poll interval) to be useful.
    if (deliveryChanged) notify.resetMobileAttentionDelivery();
    if (deliveryChanged && (status.config.pushEnabled || status.config.webPushEnabled)) {
      queueMicrotask(announceCurrentAttention);
    }
    // Switching the phone dashboard on is a promise that this Mac will answer a
    // device that is not in the room, which it cannot keep while suspended;
    // switching it off is one of the two ways the hold is released.
    if (before.dashboardEnabled !== status.config.dashboardEnabled) syncAwake();
    return status;
  });
  handle('mobile:regenerateToken', () => mobile.regenerateMobileToken());
  handle('mobile:regenerateTopic', async () => {
    const status = await mobile.regenerateMobilePushTopic();
    notify.resetMobileAttentionDelivery();
    if (status.config.pushEnabled) queueMicrotask(announceCurrentAttention);
    return status;
  });
  // Both channels, reported separately. A merged verdict is the one answer a
  // test cannot usefully give: "one of your two channels works" is exactly what
  // the operator pressed the button to stop wondering about.
  // Every surface, not just the phone. Until this fired the desktop pair too,
  // the only way to find out whether a macOS banner or the in-window card
  // worked was to wait for an agent to block on something — so a fresh install
  // had no way at all to tell "nothing is configured" from "nothing happened".
  handle('mobile:testPush', async () => {
    const phone = await mobile.testMobileAlerts();
    // Through notify(), deliberately, rather than by constructing a banner
    // here: this is the same call an attention transition makes, so a test that
    // passes is evidence about the real path rather than about a second one
    // written to look like it. `mobile: false` because the phone half already
    // went, and reporting per channel is what makes the result readable.
    notify.notify({
      title: 'Wanigan test notification',
      body: 'If you can see this, the desktop banner and the in-window card both work.',
      urgent: false,
      mobile: false,
      mobileTag: 'wanigan-test',
    });
    return [
      ...phone,
      {
        channel: 'desktop' as const,
        ok: notify.notificationsEnabled(),
        detail: notify.notificationsEnabled()
          ? 'A banner and an in-window card were raised. macOS may still suppress the banner under a Focus mode; the card is not suppressible.'
          : 'Notifications are switched off in Settings, so neither the banner nor the card was raised.',
      },
    ];
  });
  handle('mobile:alertChannels', () => mobile.alertChannelReadiness());
  // Forgetting a device is local and immediate, and it is the weaker of the two
  // revocations on purpose: the browser on that device still holds a
  // subscription, so it re-registers the next time the app is opened. Rotating
  // the key below is the one that cannot be undone from the device.
  handle('mobile:forgetPushDevice', (id: string) => {
    if (typeof id !== 'string' || !id) throw new Error('A device id is required.');
    const status = mobile.forgetMobilePushDevice(id);
    notify.resetMobileAttentionDelivery();
    return status;
  });
  handle('mobile:forgetPushDevices', () => {
    const status = mobile.forgetAllMobilePushDevices();
    notify.resetMobileAttentionDelivery();
    return status;
  });
  handle('mobile:regeneratePushKeys', () => {
    const status = mobile.regenerateMobilePushKeys();
    notify.resetMobileAttentionDelivery();
    return status;
  });

  // ── the private transport in front of that loopback listener ─────────
  //
  // Settings used to print a `tailscale serve` command to copy into a terminal
  // and then ask for the URL back. These three drive the CLI instead, so the
  // panel reports a transport it can observe rather than describing one it
  // cannot.
  handle('tailnet:status', (port?: number) => tailnet.tailnetStatus(servedPort(port)));
  handle('tailnet:serve', async (port?: number) => {
    const status = await tailnet.tailnetServe(servedPort(port));
    if (status.state !== 'serving') return status;
    if (sameUrl(mobile.mobileConfig().dashboardUrl, status.url)) return status;
    try {
      // The other half of removing the paste step: deep links in phone alerts
      // read this setting, so a URL Wanigan just watched Tailscale print is a
      // fact it should record rather than ask for.
      await mobile.setMobileConfig({ dashboardUrl: status.url });
    } catch (e) {
      // Serving succeeded and only the bookkeeping failed. Reporting a bare
      // failure would deny what the operator just watched happen, so the reply
      // carries both facts and names the one that still needs a hand.
      throw new Error(`Tailscale is serving ${status.url}, but Wanigan could not save it as the dashboard URL: `
        + `${e instanceof Error ? e.message : String(e)}`);
    }
    return status;
  });
  /**
   * The pairing QR, rendered in main from main's own pairing URL.
   *
   * The renderer never supplies the text. It could — the URL is on screen
   * beside the code — but then an SVG built from renderer input would be
   * injected into the settings panel, and the one thing that makes that
   * injection safe is that nothing outside this process chose what it encodes.
   * The renderer asks for "the QR for pairing"; it does not get to say what
   * the camera will read.
   */
  handle('tailnet:qr', () => {
    const status = mobile.mobileStatus();
    if (!status.config.dashboardEnabled) {
      throw new Error('The phone dashboard is off, so there is no address to pair against yet.');
    }
    return qrSvg(status.pairingUrl);
  });

  handle('tailnet:unserve', async (port?: number) => {
    const wanted = servedPort(port);
    // Read first: after the mapping is gone there is no URL left to compare the
    // stored dashboard URL against, and clearing one Wanigan did not publish
    // would throw away an operator's own proxy.
    const before = await tailnet.tailnetStatus(wanted);
    const status = await tailnet.tailnetUnserve(wanted);
    if (status.state !== 'ready' || before.state !== 'serving') return status;
    if (!sameUrl(mobile.mobileConfig().dashboardUrl, before.url)) return status;
    try {
      await mobile.setMobileConfig({ dashboardUrl: '' });
    } catch (e) {
      throw new Error(`Tailscale is no longer serving ${before.url}, but Wanigan could not clear the dashboard URL: `
        + `${e instanceof Error ? e.message : String(e)}`);
    }
    return status;
  });

  /**
   * Whether Wanigan is keeping this Mac awake, and why.
   *
   * A read, not a switch: there is no channel here for the renderer to demand a
   * hold, because the only things allowed to cause one are a live agent and the
   * dashboard toggle, and both of those are already observed in main. Reading
   * reconciles rather than returning a remembered answer, so the panel cannot
   * show a hold that was released between polls.
   */
  handle('awake:state', () => syncAwake());

  // ══ phase 19 · trust and the ledger ═════════════════════════════════
  handle('policy:trust', (projectId: string | null) => policy.trustFor(projectId));
  handle('policy:setTrust', (projectId: string, level: TrustLevel) => { policy.setTrust(projectId, level); return level; });
  handle('policy:defaultTrust', () => policy.defaultTrust());
  handle('policy:setDefaultTrust', (level: TrustLevel) => { policy.setDefaultTrust(level); return level; });
  handle('policy:ledger', (limit?: number, deniedOnly?: boolean) => policy.ledger(limit, { deniedOnly }));
  handle('policy:summary', () => policy.ledgerSummary());
  handle('policy:export', async () => {
    if (!win) return null;
    const res = await dialog.showSaveDialog(win, {
      title: 'Export the policy ledger', defaultPath: 'wanigan-ledger.jsonl',
      filters: [{ name: 'JSONL', extensions: ['jsonl'] }],
    });
    if (res.canceled || !res.filePath) return null;
    return { path: res.filePath, rows: policy.exportLedger(res.filePath) };
  });

  // ══ phase 22 · skills ═══════════════════════════════════════════════
  handle('skills:list', (projectId?: string) => skills.discoverSkills(projectId));
  handle('skills:refresh', () => { skills.refreshSkills(); return true; });
  handle('skills:body', (p: string) => skills.skillBody(p));
  // A catalogue you can fire into a running agent, rather than one you read.
  // Typed only into the harness whose `/name ` form Wanigan has verified, and
  // only for a skill the catalogue says the user may invoke; the decision
  // carries the reason so the renderer can say why a button is off.
  handle('skills:send', (sessionId: string, invoke: string) => {
    const live = listSessions().find((s) => s.id === sessionId) ?? null;
    const decision = skills.skillSendDecision(live, invoke);
    // Thrown rather than returned for now: the preload still types this
    // channel as a boolean, and an object would read as success to the current
    // renderer. Once Skills.tsx reads SkillSendDecision this becomes
    // `return decision`.
    if (!decision.ok) throw new Error(decision.reason);
    writeSession(sessionId, decision.invoke + ' ');
    return true;
  });

  // ══ phase 28 · git ══════════════════════════════════════════════════
  // Every root here goes through gitRoot(); see its comment for why the reads
  // are confined as well as the writes.
  handle('git:status', (root: string) => gitOps.status(gitRoot(root)));
  handle('git:log', async (root: string, opts?: { limit?: number; all?: boolean }) => {
    const cs = await gitOps.log(gitRoot(root), opts);
    return cs;
  });
  handle('git:branches', (root: string) => gitOps.branches(gitRoot(root)));
  handle('git:stashes', (root: string) => gitOps.stashes(gitRoot(root)));
  handle('git:commitDiff', (root: string, hash: string) => gitOps.commitDiff(gitRoot(root), hash));
  handle('git:fileDiff', (root: string, file: string, staged: boolean) => gitOps.fileDiff(gitRoot(root), file, staged));
  handle('git:stage', (root: string, files: string[]) => gitOps.stage(gitRoot(root), files));
  handle('git:unstage', (root: string, files: string[]) => gitOps.unstage(gitRoot(root), files));
  handle('git:discard', (root: string, tracked: string[], untracked: string[]) => gitOps.discard(gitRoot(root), tracked, untracked));
  handle('git:commit', (root: string, msg: string, opts?: { amend?: boolean; all?: boolean }) => gitOps.commit(gitRoot(root), msg, opts));
  handle('git:checkout', (root: string, ref: string, create?: boolean) => gitOps.checkout(gitRoot(root), ref, create === true));
  handle('git:deleteBranch', (root: string, name: string, force?: boolean) => gitOps.deleteBranch(gitRoot(root), name, force === true));
  handle('git:merge', (root: string, ref: string) => gitOps.merge(gitRoot(root), ref));
  handle('git:fetch', (root: string) => gitOps.fetchAll(gitRoot(root)));
  handle('git:pull', (root: string) => gitOps.pull(gitRoot(root)));
  handle('git:push', (root: string, opts?: { setUpstream?: boolean; branch?: string }) => gitOps.push(gitRoot(root), opts));
  handle('git:stashSave', (root: string, msg: string) => gitOps.stashSave(gitRoot(root), msg));
  handle('git:stashApply', (root: string, i: number, drop: boolean) => gitOps.stashApply(gitRoot(root), i, drop));
  handle('git:stashDrop', (root: string, i: number) => gitOps.stashDrop(gitRoot(root), i));

  // ── pull requests via the operator's own gh CLI ─────────────────────
  // Same confinement as git:*; auth and hosts stay inside gh itself.
  handle('gh:prStatus', (root: string, force?: boolean) => gh.prStatusReport(gitRoot(root), force === true));
  handle('gh:createPr', (root: string, input: unknown) => gh.createPr(gitRoot(root), input));

  // ══ phase 25 · schedules ════════════════════════════════════════════
  handle('schedule:list', () => schedule.listSchedules());
  handle('schedule:create', (input: { name: string; cron: string; kind: schedule.ScheduleKind; payload: unknown; projectId?: string | null }) =>
    schedule.createSchedule(input));
  handle('schedule:setEnabled', (id: string, on: boolean) => schedule.setScheduleEnabled(id, on));
  handle('schedule:update', (id: string, patch: Record<string, unknown>) =>
    schedule.updateSchedule(String(id), patch && typeof patch === 'object' ? patch : {}));
  handle('schedule:delete', (id: string) => schedule.deleteSchedule(id));
  handle('schedule:history', (id: string, limit?: number) => schedule.scheduleHistory(id, limit));
  handle('schedule:preview', (cron: string) => {
    const out: number[] = [];
    let t = Date.now();
    for (let i = 0; i < 5; i++) { const n = schedule.nextFire(cron, t); if (n === null) break; out.push(n); t = n; }
    return { fires: out, describe: schedule.describeCron(cron) };
  });
  handle('schedule:tick', () => schedule.tickSchedules());
  handle('schedule:daemon', () => daemonStatus());
  handle('schedule:installDaemon', () => installDaemon());
  handle('schedule:uninstallDaemon', () => uninstallDaemon());

  // ── AI Improvement Scout ──────────────────────────────────────────
  handle('scout:overview', () => scout.overview());
  handle('scout:settings', () => scout.settings());
  handle('scout:setSettings', (patch: Partial<import('../shared/types').ImprovementScoutSettings>) =>
    scout.updateSettings(patch));
  handle('scout:sources', () => scout.listSources());
  handle('scout:setSourceEnabled', (id: string, enabled: boolean) => scout.setSourceEnabled(id, enabled === true));
  handle('scout:runs', (limit?: number) => scout.listRuns(limit));
  handle('scout:suggestions', (filter?: Parameters<typeof scout.listSuggestions>[0]) => scout.listSuggestions(filter));
  handle('scout:suggestion', (id: string) => scout.suggestion(id));
  handle('scout:updateSuggestion', (id: string, patch: Parameters<typeof scout.updateSuggestion>[1]) =>
    scout.updateSuggestion(id, patch));
  // Scheduled mode belongs only to the durable queue runner above. A renderer
  // can explicitly ask for a visible manual pass or a hard local-only preview,
  // but cannot borrow the stored unattended-network permission by forging a
  // `scheduled` IPC payload.
  handle('scout:run', (input?: { mode?: 'manual' | 'preview'; allowNetwork?: boolean }) => {
    if (input?.mode !== undefined && input.mode !== 'manual' && input.mode !== 'preview') {
      throw new Error('Scout IPC supports manual research or a local preview. Weekly research runs only through its durable schedule.');
    }
    return scout.run({ mode: input?.mode ?? 'manual', allowNetwork: input?.allowNetwork === true });
  });
  handle('scout:createGoal', (id: string, input: { projectId: string }) => scout.createGoal(id, input));

  // ── reproducible review gates ──────────────────────────────────────
  handle('review:recipe', (projectId: string) => review.recipe(projectId));
  // A saved recipe is command text runCommand hands to `$SHELL -lc`, written once
  // and executed many times from two surfaces: this channel, and control.runProof
  // for a goal's verify task, which runs the same stored text in that task's
  // worktree when it has one. So the question goes on the save, where the
  // capability is created, rather than on each run, where it would re-ask about
  // text already approved. Asked here, where a compromised renderer cannot decline
  // to render it. Only commands the stored recipe does not already hold are shown.
  handle('review:saveRecipe', (projectId: string, commands: string[]) =>
    review.saveRecipeWithConsent(win, projectId, commands));
  handle('review:history', (projectId: string, limit?: number) => review.history(projectId, limit));
  handle('review:run', async (projectId: string) => {
    const result = await review.run(projectId);
    try { learning.observeReviewResult(result); }
    catch (error) { console.warn('[wanigan] review learning signal skipped:', error); }
    return result;
  });

  // ══ P30 · durable agent control plane ═══════════════════════════════
  handle('usage:snapshot', (input?: { days?: number; force?: boolean }) => usage.snapshot(input));
  handle('usage:burn', (force?: boolean) => usage.burnWindows(force === true));
  handle('accounts:list', (harness: string) => accounts.list(harness));
  handle('accounts:create', (input: { harness: string; label: string; configDir: string; seedFromAccountId?: string | null }) =>
    accounts.create(input));
  handle('accounts:rename', (id: string, label: string) => accounts.rename(id, label));
  handle('accounts:setDefault', (id: string) => accounts.setDefault(id));
  handle('accounts:remove', (id: string) => accounts.remove(id));
  handle('accounts:forProject', (projectId: string, harness: string) => accounts.projectAccount(projectId, harness));
  handle('accounts:setForProject', (projectId: string, harness: string, accountId: string | null) =>
    accounts.setProjectAccount(projectId, harness, accountId));
  // Takes a provider id, not a harness: whether a Claude account even applies
  // depends on the profile's resolved environment, and that is a main-process
  // fact. A renderer that answered it would be guessing on the trust boundary's
  // wrong side, and guessing wrong shows an account picker for a profile that
  // authenticates against another vendor entirely.
  handle('accounts:resolveForLaunch', (providerId: string, projectId?: string | null, explicitAccountId?: string | null) => {
    const def = providerById(providerId);
    if (!def) return { account: null, source: 'none', override: null, reason: 'That provider is not installed.' };
    return accounts.resolve({
      harness: def.harness,
      projectId: projectId ?? null,
      explicitAccountId: explicitAccountId ?? null,
      appliesToAnthropic: usesAnthropicAccount(def) && !redirectsAnthropicApiFor(def),
    });
  });
  handle('accounts:listForProvider', (providerId: string) => {
    const def = providerById(providerId);
    if (!def || !usesAnthropicAccount(def) || redirectsAnthropicApiFor(def)) return [];
    return accounts.list(def.harness);
  });
  handle('control:list', (projectId?: string | null, limit?: number) => control.listDockets(projectId, limit));
  handle('control:get', (id: string) => control.docket(id));
  handle('control:sessionGoal', (id: string) => control.sessionGoal(id));
  handle('control:create', (input: {
    projectId: string; title: string; objective: string; acceptance?: string[];
    risk?: 'low' | 'elevated' | 'high'; budgetUsd?: number | null; plan?: DocketPlanNode[];
  }) => control.createDocket(input));
  handle('control:claim', (nodeId: string, relPath: string) => control.claimPath(nodeId, relPath));
  handle('control:releaseClaim', (id: string) => control.releaseClaim(id));
  handle('control:start', (nodeId: string, input: { providerId: string; model?: string; effort?: string; permissionMode?: string }) =>
    control.startNode(nodeId, input));
  handle('control:retry', (nodeId: string) => control.retryNode(nodeId));
  handle('control:checkpoint', (nodeId: string, note: string) => control.checkpointNode(nodeId, note));
  handle('control:runProof', (nodeId: string) => control.runProof(nodeId));
  handle('control:complete', (nodeId: string, input?: { detail?: string; decision?: 'approve' | 'request_changes' | 'reject' }) =>
    control.completeNode(nodeId, input ?? {}));
  handle('control:setAutopilot', (docketId: string, input: { enabled: boolean; providerId?: string; model?: string | null }) =>
    control.setAutopilot(docketId, input));
  // Budget is a separate call rather than a field on setAutopilot: arming and
  // capping are two decisions, and a goal created without a cap needs a way to
  // get one before it can ever be armed. The value stays untrusted until
  // setDocketBudget bounds it in the main process.
  handle('control:setBudget', (docketId: string, budgetUsd: number | null) =>
    control.setDocketBudget(docketId, budgetUsd));
  // The board reads the same rows the goal graph does, a second way. There is
  // no ticket table behind it — see control.boardCards.
  // ── the interview ────────────────────────────────────────────────────
  //
  // Every call spends money, so every call is one the operator took: there is
  // no timer and no background pass here. `start` is the consent, and the
  // budget it carries is checked before each question rather than after.
  handle('interview:start', (input: {
    projectId: string; seed: string; model?: string; budgetUsd?: number; maxQuestions?: number;
  }) => interview.startInterview(input));
  // Platform API models only, with what each costs a question. Codex and GLM
  // are agent harnesses Wanigan launches as CLIs; this path is a direct
  // Messages API call, and offering a model it cannot reach would fail later
  // rather than on the screen where the choice is made.
  handle('interview:models', () => interview.interviewModels());
  handle('interview:answer', (id: string, answer: string) => interview.answerInterview(id, answer));
  handle('interview:conclude', (id: string) => interview.concludeInterview(id));
  handle('interview:commit', (id: string, edits?: Parameters<typeof interview.commitInterview>[1]) =>
    interview.commitInterview(id, edits));
  handle('interview:abandon', (id: string) => interview.abandonInterview(id));
  handle('interview:get', (id: string) => interview.interview(id));
  handle('interview:list', (projectId?: string | null, limit?: number) =>
    interview.listInterviews(projectId, limit));

  handle('control:board', (projectId?: string | null, limit?: number) =>
    control.boardCards({ projectId, limit }));
  handle('control:defer', (nodeId: string, until: number | null) => control.deferNode(nodeId, until));
  handle('control:outcomes', (projectId?: string | null) => control.outcomes(projectId));
  handle('control:events', (status?: 'new' | 'triaged' | 'dismissed' | 'all', limit?: number) => control.listEvents(status ?? 'all', limit));
  handle('control:addEvent', (input: { projectId?: string | null; source: string; kind: string; summary: string }) => control.addEvent(input));
  handle('control:triageEvent', (id: string, input?: { title?: string; acceptance?: string[]; risk?: 'low' | 'elevated' | 'high' }) =>
    control.triageEvent(id, input ?? {}));
  handle('control:dismissEvent', (id: string) => control.dismissEvent(id));
  handle('control:mcpTasks', (docketId?: string) => control.mcpTasks(docketId));
  handle('control:cancelMcpTask', (id: string) => control.cancelMcpTask(id));
  handle('control:resumeReceipts', (docketId: string) => control.resumeReceipts(docketId));
  handle('control:traces', (docketId: string, limit?: number) => control.traces(docketId, limit));

  // ══ phase 26 · agent teams ══════════════════════════════════════════
  handle('teams:read', () => teams.readTeams());

  // ══ phase 27 · revert ═══════════════════════════════════════════════
  handle('revert:plan', (root: string, file: string, head: string | null, pre: boolean) =>
    revert.planRevert(root, file, head, pre));
  handle('revert:file', (root: string, file: string, head: string | null, pre: boolean) =>
    revert.revertFile(root, file, head, pre));
  handle('revert:all', (root: string, files: { path: string; preexisting?: boolean }[], head: string | null) =>
    revert.revertAll(root, files, head));

  // ══ plugins ═════════════════════════════════════════════════════════
  handle('plugins:list', () => plugins.readPlugins());
  handle('plugins:refresh', () => { plugins.refreshPlugins(); return plugins.readPlugins(); });
  handle('plugins:file', (p: string) => plugins.pluginFile(p));
  handle('plugins:catalog', () => plugins.catalog());
  // Through pluginId like every sibling. A plugin name becomes an argv entry
  // for the CLI that installs and executes code, and pluginId exists to refuse
  // a leading dash — a value that is really a second flag in a position Wanigan
  // chose. This was the one channel in the block that took the renderer's word.
  handle('plugins:details', (name: unknown) => plugins.details(pluginId(name)));
  // Every argument below becomes an argv entry for a CLI that installs and runs
  // code. See pluginScope/pluginId/marketplaceSource for why a type is not a check.
  handle('plugins:install', (id: unknown, scope?: unknown) =>
    plugins.install(pluginId(id), pluginScope(scope)));
  handle('plugins:setEnabled', (id: unknown, on: boolean) => plugins.setEnabled(pluginId(id), on === true));
  handle('plugins:marketUpdate', (name?: unknown) =>
    plugins.updateMarketplaces(name === undefined || name === null ? undefined : marketplaceName(name)));
  // Installing one plugin asks in the Plugins view; adding a marketplace asked
  // nowhere, and it is the larger grant of the two — a catalogue of installable
  // code rather than one named package, and the thing every later install is
  // chosen from. The question is asked here rather than in the renderer so it
  // is not a step a compromised renderer can decline to render.
  handle('plugins:marketAdd', async (source: unknown): Promise<plugins.PluginAction> => {
    const value = marketplaceSource(source);
    const w = liveWindow();
    if (!w || w.isDestroyed()) {
      throw new Error('Adding a marketplace needs the Wanigan window open to confirm it.');
    }
    const answer = await dialog.showMessageBox(w, {
      type: 'warning',
      buttons: ['Cancel', 'Add this marketplace'],
      defaultId: 0,
      cancelId: 0,
      title: 'Add a plugin marketplace?',
      message: `Wanigan will run: claude plugin marketplace add ${value}`,
      detail: 'A marketplace is a catalogue every later install is chosen from, and its plugins can ship hooks, '
        + 'MCP servers and install commands that run on this Mac. Add it only if you trust whoever publishes it.',
    });
    if (answer.response !== 1) {
      return { ok: false, output: '', error: 'Cancelled. No marketplace was added.' };
    }
    return plugins.addMarketplace(value);
  });
  handle('plugins:marketRemove', (name: unknown) => plugins.removeMarketplace(marketplaceName(name)));

  // ══ file explorer ═══════════════════════════════════════════════════
  handle('browse:pick', (multi?: boolean, startIn?: string) => browse.pickFiles(win, { multi, startIn }));
  handle('browse:pickDir', (title?: string) => browse.pickDirectory(win, title));
  handle('browse:list', (dir: string, showHidden?: boolean) => browse.browse(dir, { showHidden }));
  handle('browse:places', () => browse.places());
  // The same wrapper browse:open uses, for the same reason: this hands a path
  // to the Finder, and assertOpenablePath was written for exactly this call.
  // It was the one browse channel without it.
  handle('browse:reveal', (p: unknown) => browse.revealInFinder(assertOpenablePath(String(p))));
  // sessions:reveal above says a generic renderer-controlled shell.openPath
  // bridge must not exist, and this was one: browse.openExternally resolves the
  // path, checks that it exists, and hands it to LaunchServices, which decides
  // what to run. assertOpenablePath was written for this exact call — the
  // target has to be inside a managed project or worktree, or a file a context
  // scan itself surfaced.
  handle('browse:open', (p: string) => browse.openExternally(assertOpenablePath(String(p))));
  // A link in the terminal cannot travel through window.open: setWindowOpenHandler
  // denies every child window, so the link addon's opener comes back null and the
  // click does nothing at all. The renderer therefore asks for the open directly,
  // and the same http/https check the window handler uses still decides it.
  handle('shell:openExternal', (url: string) => openSafeExternal(url));

  // ══ phase 21 · attachments ══════════════════════════════════════════
  handle('attach:inspect', (p: string) => attachments.inspect(p));
  // attachToSession refuses any path no native file dialog in this app returned.
  // The check lives there, not here, so it holds for every caller rather than only
  // this channel — the staged copy lands in a directory sessions.ts passes to the
  // CLI as --add-dir, so an unchecked path here is a file the renderer chose and
  // the agent may read.
  handle('attach:add', (sessionId: string, p: string) => attachments.attachToSession(sessionId, p));
  handle('attach:paste', (sessionId: string, data: ArrayBuffer, name: string) =>
    attachments.attachBufferToSession(sessionId, Buffer.from(data), name));
  handle('attach:list', (sessionId: string) => attachments.sessionAttachments(sessionId));
  handle('attach:remove', (id: string) => attachments.removeAttachment(id));
  // Deliberately no trailing return: the human decides when to send.
  handle('attach:type', (sessionId: string, onlyUnreferenced?: boolean) => {
    const list = attachments.promptableSessionAttachments(sessionId)
      .filter((a) => (onlyUnreferenced === true ? a.referencedAt === null : true));
    if (!list.length) return false;
    // writeSession refuses an exited or unknown session. A reference that never
    // reached the PTY is not one the agent can act on, so it is neither
    // recorded nor reported as done — the strip would otherwise show a file as
    // named in a prompt that never received it.
    if (!writeSession(sessionId, attachments.promptReferenceFor(list))) return false;
    attachments.markAttachmentsReferenced(list.map((a) => a.id));
    return true;
  });

  // ══ phases 13/15/16/17 · batch depth ════════════════════════════════
  handle('uploads:list', () => uploads.listUploads());
  handle('uploads:delete', (hash: string) => uploads.deleteUpload(hash));
  handle('uploads:prune', () => uploads.pruneOrphans());
  handle('refusal:rows', (runId: string) => refusal.refusedRows(runId));
  handle('refusal:summary', (runId: string) => refusal.refusalSummary(runId));
  // Priced before it is submitted, and the price is shown. The copy under the
  // Rescue button already promised this ("the rescue is priced before it is
  // submitted, so it goes through the per-run spend cap rather than around
  // it") while the figure existed only inside main and never reached a screen.
  handle('refusal:estimate', (runId: string, model: string) => refusal.estimateRescue(runId, model));
  handle('refusal:rescue', (runId: string, model: string) => refusal.rescueRefusals(runId, model));
  handle('refusal:merge', (childRunId: string) => refusal.mergeRescue(childRunId));
  handle('refusal:children', (runId: string) => refusal.rescueChildren(runId));
  handle('cache:hitRate', (runId: string) => cachediag.observedHitRate(runId));
  handle('cache:minimum', (modelId: string) => cachediag.minimumCacheablePrefix(modelId));
  handle('cache:ttl', (cfg: RunConfig, requests: number) => cachediag.recommendedTtl(cfg, requests));
  handle('evals:pairs', () => evals.listPairs());
  handle('evals:createPair', (name: string, a: string, b: string) => evals.createPair(name, a, b));
  /*
   * The two calls the Evals tab has always told the operator to make.
   *
   * `runVariant` and `judgePair` were written, exported and never registered,
   * so the tab's own copy — "copy this run in the builder, change exactly one
   * field, and submit it", "paste the id of a judge run created for this pair"
   * — instructed work no control could do, and `ingestJudgement` refuses any
   * run whose kind is not 'eval', which nothing could produce.
   *
   * Both spend money, so both are validated here before they reach main's own
   * guards: the change set is narrowed to the fields a pair may vary, and every
   * value is shape-checked rather than passed through from the renderer.
   */
  handle('evals:variant', (baseRunId: unknown, change: unknown, name: unknown) => {
    if (typeof baseRunId !== 'string' || !baseRunId.trim()) throw new Error('Choose the run this variant is based on.');
    if (typeof name !== 'string' || !name.trim()) throw new Error('Give the variant a name.');
    if (!change || typeof change !== 'object' || Array.isArray(change)) throw new Error('A variant changes one field.');
    // Only the fields a pair is allowed to vary. Anything else would submit a
    // run the pairing rule then refuses, after it had already been paid for.
    const allowed = new Set(['model', 'effort', 'maxTokens', 'temperature', 'userTemplate', 'schemaJson']);
    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(change as Record<string, unknown>)) {
      if (!allowed.has(key)) throw new Error(`A variant cannot change ${key}.`);
      if (typeof value === 'string') { if (value.length > 100_000) throw new Error(`${key} is too long.`); patch[key] = value; }
      else if (typeof value === 'number' && Number.isFinite(value)) patch[key] = value;
      else throw new Error(`${key} must be text or a number.`);
    }
    if (Object.keys(patch).length !== 1) throw new Error('A variant changes exactly one field, so the pair has one variable.');
    return evals.runVariant(baseRunId, patch as Partial<RunConfig>, name.trim().slice(0, 200));
  });
  handle('evals:judge', (pairId: unknown, opts: unknown) => {
    if (typeof pairId !== 'string' || !pairId.trim()) throw new Error('Choose the pair to judge.');
    const raw = (opts ?? {}) as Record<string, unknown>;
    const model = typeof raw.model === 'string' ? raw.model.trim() : '';
    const rubric = typeof raw.rubric === 'string' ? raw.rubric.trim() : '';
    const effort = typeof raw.effort === 'string' ? raw.effort.trim() : undefined;
    if (!model) throw new Error('Choose the model that will judge.');
    if (!rubric) throw new Error('A judge needs a rubric. Say what “better” means for this task.');
    if (rubric.length > 20_000) throw new Error('That rubric is too long.');
    return evals.judgePair(pairId, { model, rubric, effort });
  });
  handle('evals:diff', (pairId: string) => evals.pairDiff(pairId));
  handle('evals:summary', (pairId: string) => evals.regressionSummary(pairId));
  handle('evals:ingest', (judgeRunId: string) => evals.ingestJudgement(judgeRunId));
  handle('evals:golden', () => evals.listGoldenSets());
  handle('evals:saveGolden', (name: string, runId: string) => evals.saveGoldenSet(name, runId));
  handle('evals:goldenSource', (id: string) => evals.goldenSetSource(id));

  // ══ phase 23 · project context ══════════════════════════════════════
  // Everything a project injects into an agent before it has done anything.
  //
  // These walk a directory tree, read settings files and add every result to
  // the servable set that context:read then honours, so an unconfined
  // projectPath turns "scan a project" into "enumerate and serve any folder on
  // this Mac". The project path is the base, so it is the part confined here.
  //
  // context:read and context:memoryBody are deliberately NOT wrapped: they
  // already enforce a tighter and different membership — a path some scan
  // actually produced, and a markdown file under a known memory directory — and
  // a user-scope CLAUDE.md or ~/.claude memory legitimately sits outside every
  // project. assertManagedRoot there would refuse the files the views exist for.
  handle('context:instructions', (projectPath: string) =>
    ctxInstructions.resolveInstructions(assertManagedRoot(projectPath, 'That project folder')));
  handle('context:memory', (projectPath: string) =>
    ctxMemory.readMemory(assertManagedRoot(projectPath, 'That project folder')));
  handle('context:config', (projectPath: string) =>
    ctxConfig.readProjectConfig(assertManagedRoot(projectPath, 'That project folder')));
  handle('context:budget', (projectPath: string, files: { path: string; label: string }[], model?: string) =>
    ctxConfig.contextBudget(assertManagedRoot(projectPath, 'That project folder'), files, model));
  handle('context:read', (p: string) => ctxInstructions.readInstruction(p));
  handle('context:memoryBody', (p: string) => ctxMemory.memoryBody(p));
  // The other half of the AGENTS.md story, and the reason this handler exists
  // at all: agentsChain() was written, documented down to the heading the UI
  // would give it, and never called. It computes one thing nobody could see —
  // that the Codex compiler writes personal instructions to a directory this
  // account's Codex home does not read — which is a silent misconfiguration a
  // user would otherwise only find by noticing an agent ignoring a rule.
  handle('context:codexAgents', (projectId: string | null, projectPath: string) =>
    agentsChain(projectId, projectPath));
  handle('context:agentsMd', (projectPath: string) =>
    ctxInstructions.agentsMdStatus(assertManagedRoot(projectPath, 'That project folder')));
  handle('context:refresh', (projectPath: string) => {
    const root = assertManagedRoot(projectPath, 'That project folder');
    ctxInstructions.refreshInstructions();
    ctxConfig.refreshProjectConfig();
    return ctxInstructions.resolveInstructions(root);
  });

  // ══ Wanigan Compound · provider-neutral learning ═══════════════════
  handle('learning:overview', (projectId?: string | null) => learning.overview(projectId));
  handle('learning:settings', () => learning.settings());
  handle('learning:setSettings', (patch: Parameters<typeof learning.updateSettings>[0]) =>
    learning.updateSettings(patch));
  handle('learning:teach', (input: Parameters<typeof learning.teach>[0]) => learning.teach(input));
  // Coerced like every sibling below. consolidate() derives a settings
  // primary key from this value to store its ring position, so an
  // unvalidated renderer string would grow that table without bound.
  handle('learning:consolidate', (projectId?: string | null) =>
    learning.consolidate(projectId == null ? projectId : String(projectId).slice(0, 300)));
  // Model-assisted phrasing. Every one of these is a main-process decision:
  // the renderer may ask for a preview and record an approval, but it never
  // decides whether a call is allowed — assessRouting does, on every path.
  handle('learning:modelAssistStatus', () => learning.modelAssistStatus());
  handle('learning:modelAssistPreview', (providerId: string, model?: string | null) =>
    learning.modelAssistConsentPreview(String(providerId), model == null ? null : String(model)));
  handle('learning:modelAssistAccept', (providerId: string, model?: string | null) =>
    learning.acceptModelAssistConsent(String(providerId), model == null ? null : String(model)));
  handle('learning:modelAssistWithdraw', () => learning.withdrawModelAssistConsent());
  handle('learning:phrase', (projectId?: string | null, limit?: number) =>
    learning.phrasePendingNominations({ projectId, limit }));
  handle('learning:unactionableCount', (projectId?: string | null) =>
    learning.unactionableCount(projectId));
  handle('learning:sweepUnactionable', (projectId?: string | null) =>
    learning.sweepUnactionable(projectId));
  handle('learning:signals', (filter?: Parameters<typeof learning.listSignals>[0]) =>
    learning.listSignals(filter));
  handle('learning:candidates', (filter?: Parameters<typeof learning.candidates>[0]) =>
    learning.candidates(filter));
  handle('learning:updateCandidate', (id: string, patch: Parameters<typeof learning.updateCandidate>[1]) =>
    learning.updateCandidate(id, patch));
  handle('learning:reviewCandidate', (id: string, action: learning.ReviewAction, note?: string) =>
    learning.reviewCandidate(id, action, note));
  handle('learning:promoteCandidate', (id: string) => learning.promote(id));
  handle('learning:applyCandidate', (id: string, providerId: string) =>
    learning.applyCandidateToProvider(id, providerId));
  handle('learning:knowledge', (filter?: Parameters<typeof learning.knowledge>[0]) =>
    learning.knowledge(filter));
  handle('learning:search', (query: string, options?: {
    projectId?: string | null; path?: string | null; kinds?: string[]; limit?: number;
  }) => learning.searchKnowledge({
    query,
    projectId: options?.projectId,
    path: options?.path,
    kinds: options?.kinds as Parameters<typeof learning.searchKnowledge>[0]['kinds'],
    limit: options?.limit,
  }));
  handle('learning:item', (id: string) => learning.item(id));
  // Until this channel existed there was no way to take an artifact out of
  // circulation from inside the app, and every active item is injected into an
  // agent's context — so a wrong one stayed wrong and kept being spent on.
  // Retiring destroys nothing: the item keeps every version, citation and
  // projection, the reason and the actor are recorded as an operational signal,
  // and the record can be made active again.
  handle('learning:retireItem', (id: unknown, reason: unknown) => {
    if (typeof id !== 'string' || !id.trim()) throw new Error('Choose a knowledge item to retire.');
    const note = typeof reason === 'string' ? reason.trim() : '';
    if (!note) {
      throw new Error('Say why this is being retired. "Who removed this, and why" is the part that outlives the removal.');
    }
    return retireKnowledgeItem(id.trim(), note);
  });
  handle('learning:briefing', (input: Parameters<typeof learning.briefing>[0]) =>
    learning.briefing(input));
  // A LIST never carries the bytes. Each row holds proposedContent plus a
  // whole-file previousContent snapshot (512KB cap each), so a 500-row listing
  // was hundreds of megabytes through the structured clone to read a path.
  // The single-projection reads that need content go through learning:item.
  handle('learning:projections', (filter?: Parameters<typeof learning.listProjections>[0]) =>
    learning.listProjections(filter).map((projection) => ({
      ...projection, proposedContent: '', previousContent: null,
    })));
  handle('learning:undoProjection', (id: string) => learning.undo(id));
  handle('learning:diagnostics', (projectId?: string | null) =>
    learning.diagnoseKnowledge({ projectId }));
  handle('learning:forgeSkill', (input: Parameters<typeof learning.forgeSkill>[0]) =>
    learning.forgeSkill(input));
  // The overlap check compares against the skills a session in this project
  // would actually see, so the doctor gets the catalogue, not an empty list.
  // The renderer currently sends the project path as `root`, which is a
  // repository and not a skill directory, and helper references were being
  // resolved against the wrong base; a registered project path therefore
  // selects the catalogue and is not used as the root. Anything else is the
  // skill's own directory, as the option was designed.
  handle('learning:doctorSkill', (skillMd: string, root?: string, projectId?: string | null) => {
    const byPath = root ? listProjects().find((p) => p.path === root) ?? null : null;
    const project = projectId ? projectById(projectId) ?? null : byPath;
    const knownSkills = skills.discoverSkills(project?.id).skills
      .map((s) => ({ name: s.name, description: s.description }));
    return learning.doctorSkill(skillMd, { root: byPath ? null : root, knownSkills });
  });
  handle('learning:installSkill', (
    skill: Parameters<typeof learning.installSkill>[0], providerIds: string[], projectId?: string | null,
  ) => learning.installSkill(skill, providerIds, projectId));
  handle('learning:experiments', (filter?: Parameters<typeof learning.experimentList>[0]) =>
    learning.experimentList(filter));
  handle('learning:createExperiment', (input: learning.CreateExperimentInput) =>
    learning.createExperiment(input));
  handle('learning:setExperimentStatus', (
    id: string, action: 'start' | 'cancel' | 'complete', outcome?: Record<string, unknown>,
  ) => learning.setExperimentStatus(id, action, outcome));
  // ── the legibility surface: recorded facts about what the engine did ──
  handle('learning:sessionLedger', (sessionId: string) => learning.sessionLedger(sessionId));
  handle('learning:pipeline', (input?: { projectId?: string | null; windowDays?: number }) =>
    learning.pipeline(input ?? {}));
  handle('learning:candidateExplain', (id: string) => learning.explain(id));
  handle('learning:candidateSignals', (id: string) => learning.candidateSignals(id));
  handle('learning:relations', (itemId?: string) => learning.relations(itemId));
  handle('learning:freshness', (itemId: string) => learning.freshnessReport(itemId));

  // ══ phase 27 · observed sessions ════════════════════════════════════
  // listObserved() returns [] when the lane is off, so observed:state is what
  // lets the surface tell "switched off" from "nothing running". They are
  // different sentences and a UI that cannot tell them apart prints the wrong
  // one with total confidence.
  handle('observed:list', () => observed.listObserved());
  handle('observed:state', () => observed.observedState());
  handle('observed:setEnabled', (on: boolean) => observed.setObservedEnabled(on));

  // ══ phase 29 · what leaves this machine ═════════════════════════════
  handle('egress:report', () => egressReport());

  // ══ backup and restore ══════════════════════════════════════════════
  // Goals, proofs, the policy ledger, the knowledge record and every citation
  // that makes a briefing checkable are rows in one SQLite file. The app could
  // forget a transcript but never copy anything out, so a dead disk ended the
  // record permanently and nothing ever said so.
  handle('backup:create', async (): Promise<BackupSummary | null> => {
    if (!win) return null;
    const res = await dialog.showSaveDialog(win, {
      title: 'Back up Wanigan’s record',
      defaultPath: path.join(defaultBackupParent(), `wanigan-backup-${backupStamp()}`),
      buttonLabel: 'Back up',
      properties: ['createDirectory'],
    });
    if (res.canceled || !res.filePath) return null;
    return backup.createBackup(res.filePath);
  });
  // Read-only: verify a backup and say what restoring it would cost, so the
  // decision is made against the dates rather than against a folder name.
  handle('backup:inspect', async (): Promise<BackupCheck | null> => {
    if (!win) return null;
    const res = await dialog.showOpenDialog(win, {
      title: 'Check a Wanigan backup',
      properties: ['openDirectory'],
      buttonLabel: 'Check this backup',
    });
    if (res.canceled || !res.filePaths[0]) return null;
    return backup.inspectBackup(res.filePaths[0]);
  });
  handle('backup:restore', async (): Promise<BackupRestoreSummary | null> => {
    const w = liveWindow();
    if (!w || w.isDestroyed()) return null;

    // A restore swaps the database file out from under this process. Anything
    // still writing to it — a PTY recording events, a headless row banking a
    // cost — would start throwing mid-run against a file that has moved.
    const live = listSessions().filter((s) => s.status === 'starting' || s.status === 'running').length;
    const headlessLive = headless.liveHeadlessCount();
    if (live || headlessLive) {
      throw new Error(
        `${live + headlessLive} agent${live + headlessLive === 1 ? ' is' : 's are'} still running, and a restore `
        + 'replaces the database they are writing to. Stop them first, then restore.'
      );
    }

    const picked = await dialog.showOpenDialog(w, {
      title: 'Restore a Wanigan backup',
      properties: ['openDirectory'],
      buttonLabel: 'Choose this backup',
    });
    if (picked.canceled || !picked.filePaths[0]) return null;

    const check = backup.inspectBackup(picked.filePaths[0]);
    if (check.problems.length) {
      throw new Error(
        `This backup did not verify, so nothing was changed:\n- ${check.problems.map((p) => p.detail).join('\n- ')}`
      );
    }

    // Name what is being replaced, not "are you sure": the only fact that
    // decides this is whether the database in place holds work the backup does
    // not, and that is the sentence a person can actually act on.
    const takenAt = check.createdAt ? new Date(check.createdAt).toLocaleString() : 'an unrecorded date';
    const backupEvidence = check.latestEvidenceAt
      ? new Date(check.latestEvidenceAt).toLocaleString()
      : 'nothing recorded';
    const currentEvidence = check.currentLatestEvidenceAt
      ? new Date(check.currentLatestEvidenceAt).toLocaleString()
      : 'nothing recorded';
    const answer = await dialog.showMessageBox(w, {
      type: 'warning',
      buttons: ['Cancel', 'Replace the database'],
      defaultId: 0,
      cancelId: 0,
      title: 'Replace Wanigan’s record with this backup?',
      message: `The database Wanigan is using now and its ${check.transcripts.files} archived transcript`
        + `${check.transcripts.files === 1 ? '' : 's'} will be replaced by the backup taken ${takenAt}.`,
      detail: `That backup records work up to ${backupEvidence}. The database in place records work up to `
        + `${currentEvidence}.${check.wouldDiscardNewer ? ' Everything in between will be dropped.' : ''}\n\n`
        + 'Nothing is deleted: the replaced database and transcripts are moved into a dated folder inside '
        + 'Wanigan’s data directory. The API credential and provider/MCP trust grants are not restored — '
        + 'those are made on one machine, for one machine. Wanigan must restart immediately afterwards.',
    });
    if (answer.response !== 1) return null;

    const report = backup.restoreBackup(picked.filePaths[0], {
      confirm: true,
      // The dialog above showed both dates, which is the whole precondition
      // this flag exists to enforce.
      overwriteNewer: check.wouldDiscardNewer,
    });

    // The connection this process held is closed and every later db() call
    // throws. Say so and relaunch, rather than leaving a window whose every
    // control now fails against a file that has moved.
    setTimeout(() => {
      void dialog.showMessageBox({
        type: 'info',
        buttons: ['Restart Wanigan'],
        defaultId: 0,
        title: 'Backup restored',
        message: 'Wanigan will restart to open the restored database.',
        detail: `The database that was in place was moved to ${report.replacedDir} and not deleted.`,
      }).finally(() => { app.relaunch(); app.exit(0); });
    }, 0);

    return report;
  });

  // ══ settings ════════════════════════════════════════════════════════
  handle('settings:all', () => allSettings());
  handle('settings:set', (key: string, value: string) => {
    const next = setUserPreference(key, value);
    // The View menu carries a tick for the sidebar. Rebuild it here so the tick
    // is the stored answer rather than whatever it was when the app launched.
    if (key === 'nav_sidebar') installApplicationMenu(() => win);
    return next;
  });
  handle('settings:setTheme', (value: ThemeSetting) => { setTheme(value); return allSettings(); });

  // Hot-path traffic: fire-and-forget, no round trip.
  ipcMain.on('sessions:write', (event, id: string, data: string) => {
    if (trustedSender(event.sender, event.senderFrame) && !demoWindows.has(event.sender) && !changingDemoWindow) writeSession(id, data);
  });
  ipcMain.on('sessions:resize', (event, id: string, cols: number, rows: number) => {
    if (trustedSender(event.sender, event.senderFrame) && !demoWindows.has(event.sender) && !changingDemoWindow) resizeSession(id, cols, rows);
  });
}

/** Streams a run's results to disk without materialising them in memory. */
function writeExport(runId: string, format: 'jsonl' | 'csv', filePath: string): string {
  // Deliberately lazy: this path runs during quit, after the module graph has
  // already been torn down in some exit orders. typescript-eslint renamed the
  // rule to no-require-imports in v8, which is why the old directive name here
  // had stopped disabling anything.
  /* eslint-disable @typescript-eslint/no-require-imports */
  const fs = require('node:fs') as typeof import('node:fs');
  const { db } = require('./db') as typeof import('./db');
  /* eslint-enable @typescript-eslint/no-require-imports */

  const stmt = db().prepare(`
    SELECT custom_id, row_index, row_json, rendered, status, output_text,
           error_type, error_message, in_tokens, out_tokens
    FROM requests WHERE run_id = ? ORDER BY row_index
  `);
  const out = fs.createWriteStream(filePath, { flags: 'w' });
  const cell = (v: unknown) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  if (format === 'csv') {
    out.write('custom_id,row_index,status,output_text,error_type,error_message,in_tokens,out_tokens\n');
  }
  for (const r of stmt.iterate(runId) as Iterable<Record<string, unknown>>) {
    out.write(format === 'jsonl'
      ? JSON.stringify({ ...r, row: JSON.parse(String(r.row_json)) }) + '\n'
      : [r.custom_id, r.row_index, r.status, r.output_text, r.error_type, r.error_message, r.in_tokens, r.out_tokens].map(cell).join(',') + '\n');
  }
  out.end();
  return filePath;
}
