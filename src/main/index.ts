import { app, BrowserWindow, ipcMain, dialog, shell, session } from 'electron';
import type { WebContents } from 'electron';
import path from 'node:path';
import {
  detectProviders, effectiveProviderBackendId, providerPackRegistry, refreshProviderPacks,
} from './providers';
import {
  initSessions, listSessions, createSession, writeSession, resizeSession,
  killSession, closeSession, scrollback, markRead, shutdownAll, sessionBaseline, interruptSession,
  pastSessions, forgetPastSession, setSessionExitObserver,
} from './sessions';
import { listProjects, addProject, removeProject, refreshBranches, projectById } from './store';
import * as batch from './batch';
import * as code from './code';
import { getSetting, setSetting, spendCap } from './settings';
import { hasKey, getKey, setKey, clearKey, keyFingerprint, verifyKey, encryptionAvailable, getWorkspaceId,
         hasProviderKey, setProviderKey, clearProviderKey, providerKeyFingerprint } from './keys';
import type {
  LaunchOptions, RunConfig, SourceConfig, HeadlessConfig, HookInput,
  McpServerConfig, ProviderManifestInspection, QueueKind, QueueSlots, TrustLevel,
} from '../shared/types';

// ── phases 1-24 ────────────────────────────────────────────────────────
import * as otel from './otel';
import { codexUsageSummary } from './codex-usage';
import * as hooks from './hooks';
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
import * as skills from './skills';
import * as plugins from './plugins';
import { glmModels, verifyGlmKey } from './glm';
import { deepseekModels, verifyDeepSeekKey } from './deepseek';
import * as gitOps from './git';
import { demoOn, setDemo, demoMap, maskOut, unmaskIn, noteAuthors } from './demo';
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
import * as refusal from './batch/refusal';
import * as cachediag from './batch/cachediag';
import * as evals from './batch/evals';
import * as uploads from './batch/files';
import { allSettings, flags, slotsSetting } from './settings';
import { migrateUserData } from './migrate';
import { isDaemonInvocation, daemonStatus, installDaemon, uninstallDaemon } from './daemon';
import * as review from './review';
import * as codexStatus from './codex-status';
import * as learning from './learning-service';
import * as control from './control';

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

function startPoller() {
  if (pollTimer) return;
  const tick = async () => {
    try {
      const s = await batch.pollOnce();
      if (s.ended || s.ingested) {
        const w = win;
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
let uiInitialized = false;

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
 * be able to invoke it merely because it knows a channel name.
 */
function trustedSender(sender: WebContents): boolean {
  return !!win && !win.isDestroyed() && sender.id === win.webContents.id;
}

/** Open only ordinary web links outside Wanigan; never hand arbitrary schemes
 * from a renderer or agent-produced text to the operating system. */
function openSafeExternal(raw: string): void {
  try {
    const url = new URL(raw);
    if (url.protocol === 'https:' || url.protocol === 'http:') void shell.openExternal(url.toString());
  } catch { /* malformed links are not an operating-system action */ }
}

function createWindow() {
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
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.on('ready-to-show', () => win?.show());
  // The renderer's watched id does not change when the whole app loses focus.
  // Re-checking here lets a Mac banner that was intentionally quiet while the
  // session was visible fire once the operator moves to another app.
  win.on('blur', announceCurrentAttention);
  win.on('closed', () => { win = null; });

  // External links open in the real browser, never inside the app shell.
  // This shell never navigates away from its bundled renderer.  Links belong
  // in the system browser, after scheme validation, and child web contents are
  // not part of Wanigan's privilege boundary.
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    openSafeExternal(url);
    return { action: 'deny' };
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(async () => {
  if (!ownsUiInstance) return;
  // Wanigan does not use camera, microphone, notifications from web content,
  // or any other Chromium permission. OS notifications are created only by
  // the main process, never granted to a renderer.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
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
  if (process.env.WANIGAN_SMOKE === '1') {
    const { runSmoke } = await import('./smoke');
    await runSmoke();
    return;
  }

  initSessions(() => win);
  setSessionExitObserver((value) => notify.announceAttention(attention.attentionOf(value)));
  mobile.configureSnapshotSource(() => {
    const sessions = listSessions();
    return mobileFleetSnapshot(
      sessions,
      attention.attentionFor(sessions),
      otel.usageForMany(sessions.map((value) => value.id)),
    );
  });
  mobile.configureMobileControlSource({
    projects: async () => listProjects().map((project) => ({ id: project.id, name: project.name, branch: project.branch })),
    providers: async () => (await detectProviders()).map((provider) => ({ id: provider.id, label: provider.label, available: Boolean(provider.path) })),
    launch: async ({ projectId, providerId, prompt }) => {
      const session = await createSession({ providerId, projectId, initialPrompt: prompt });
      return { id: session.id, title: session.title };
    },
    prompt: async (sessionId, prompt) => {
      const session = listSessions().find((value) => value.id === sessionId && value.status !== 'exited');
      if (!session) throw new Error('That session is no longer running.');
      writeSession(sessionId, `${prompt}\r`);
    },
    interrupt: async (sessionId) => interruptSession(sessionId),
  });
  await startServices();
  try { await mobile.startMobileMonitor(); }
  catch (e) { console.warn('[wanigan] phone monitor did not start:', e); }
  registerIpc();
  createWindow();
  uiInitialized = true;
  startPoller();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
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
  // boundary explicit when Wanigan still owns live terminals: their saved
  // history survives, their actual PTYs do not.
  if (!quitConfirmed) {
    const live = listSessions().filter((s) => s.status === 'starting' || s.status === 'running');
    if (live.length) {
      const named = live.slice(0, 3).map((s) => s.title).join(', ');
      const remainder = live.length > 3 ? ` and ${live.length - 3} more` : '';
      const choice = dialog.showMessageBoxSync({
        type: 'warning',
        buttons: ['Keep Wanigan open', 'Stop agents and quit'],
        defaultId: 0,
        cancelId: 0,
        title: 'Stop live agents?',
        message: `${live.length} live agent${live.length === 1 ? '' : 's'} will be stopped.`,
        detail: `${named}${remainder}. Projects, settings and saved transcripts remain, but a live terminal cannot survive a full app quit.`,
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
  void shutdownAll().finally(() => {
    quitReady = true;
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
  hooks.setLearningBriefingHook((_sessionId, context) => context
    ? learning.briefingForContext(context)
    : null);

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
    const w = win;
    if (w && !w.isDestroyed()) w.webContents.send('session:event', e);
    const s = listSessions().find((x) => x.id === e.sessionId);
    try { learning.observeSessionEvent(e, s); }
    catch (error) { console.warn('[wanigan] learning signal skipped:', error); }
    if (s && !quitDraining) notify.announceAttention(attention.attentionOf(s));
  });

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
    const p = payload as { runId?: unknown; projectId?: unknown; prompt?: unknown; scheduleId?: unknown };
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
    // Named after the schedule that fired it. "scheduled · <date>" tells you
    // nothing once there are four of them, and this run id is what Insights and
    // the run list will show it as for as long as the row exists.
    const from = typeof p.scheduleId === 'string'
      ? schedule.listSchedules().find((x) => x.id === p.scheduleId)?.name ?? null
      : null;
    await headless.startHeadlessRun({
      name: `${from ?? 'scheduled'} · ${new Date().toLocaleString()}`,
      providerId: 'claude',
      projectIds: ids,
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
  headless.registerHeadlessRunner((runId, projectId) => {
    const name = projectById(projectId)?.name ?? projectId;
    queue.enqueue('headless', `${name} · ${runId}`, { runId, projectId });
  });
  queue.setSlots(slotsSetting());
  // Schedules feed the dispatcher; the dispatcher decides when there is a slot.
  schedule.startScheduler(() => {
    const w = win;
    if (w && !w.isDestroyed()) w.webContents.send('queue:changed');
  });
  queue.startDispatcher(() => {
    const w = win;
    if (w && !w.isDestroyed()) w.webContents.send('queue:changed');
  });

  if (f.mcpServerEnabled) {
    try {
      await mcpServer.startMcpServer();
      // An agent that can spend money with no human in the loop is a budget
      // incident waiting for a bad prompt, so submission always asks.
      mcpServer.setConfirmHandler(async (req) => {
        const w = win;
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
  void worktrees.reconcileWorktrees().catch(() => {});
  // Deterministic consolidation runs only while the app or its launchd daemon
  // is alive. The service checks the visible controls on every pass.
  learning.startConsolidator();
}

function stopServices() {
  setSessionExitObserver(null);
  stopHookEventListener?.();
  stopHookEventListener = null;
  try { mobile.stopMobileMonitor(); } catch { /* already down */ }
  learning.stopConsolidator();
  hooks.setLearningBriefingHook(null);
  try { schedule.stopScheduler(); } catch { /* already down */ }
  try { queue.stopDispatcher(); } catch { /* already down */ }
  try { hooks.stopHookServer(); } catch { /* already down */ }
  try { otel.stopCollector(); } catch { /* already down */ }
  try { mcpServer.stopMcpServer(); } catch { /* already down */ }
}

function registerIpc() {
  const handle = <T>(channel: string, fn: (...args: never[]) => T | Promise<T>) => {
    ipcMain.handle(channel, async (event, ...args) => {
      if (!trustedSender(event.sender)) return { ok: false, error: 'Untrusted IPC sender.' };
      try {
        // Demo mode is bidirectional on purpose: a masked path handed back to
        // git has to become real again, or every action fails while the demo
        // is running — which is exactly when nobody can debug it.
        const real = unmaskIn(args) as never[];
        const data = await fn(...real);
        return { ok: true, data: maskOut(data) };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false, error: maskOut(msg) };
      }
    });
  };

  handle('demo:state', () => ({ on: demoOn(), map: demoMap() }));
  handle('demo:set', (on: boolean) => { setDemo(on); return { on: demoOn(), map: demoMap() }; });

  handle('providers:list', () => detectProviders());
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
  handle('providerPacks:trustManifest', (packId: string, sha256: string) => {
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
  handle('providerPacks:trustAdapter', (packId: string, sha256: string) => {
    providerPackRegistry.trustAdapter(packId, sha256);
    refreshProviderPacks(); return publicProviderPacks();
  });
  handle('providerPacks:revokeAdapterTrust', (packId: string) => {
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
  handle('projects:add', (dir: string) => addProject(dir));
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

  handle('sessions:list', () => listSessions());
  handle('sessions:create', (opts: LaunchOptions) => createSession(opts));
  handle('sessions:scrollback', (id: string) => scrollback(id));
  handle('sessions:interrupt', (id: string, force?: boolean) => interruptSession(id, force === true));
  handle('sessions:kill', (id: string) => { killSession(id); return true; });
  handle('sessions:close', (id: string) => { closeSession(id); return true; });
  handle('sessions:markRead', (id: string) => { markRead(id); return true; });
  handle('sessions:reveal', (p: string) => { shell.openPath(p); return true; });
  handle('sessions:baseline', (id: string) => sessionBaseline(id));
  handle('sessions:past', () => pastSessions());
  handle('sessions:forget', (id: string) => { forgetPastSession(id); return pastSessions(); });

  // ── batches ──────────────────────────────────────────────────────────
  handle('batch:presets', (projectId?: string) => batch.presetsFor(projectId));
  handle('batch:refreshModels', async () => {
    try {
      return await batch.refreshModels();
    } catch (e) {
      // Keep the local table in play; report why the live catalog is unavailable.
      return {
        models: [], fetchedAt: 0,
        source: `unavailable — ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  });
  handle('batch:insights', () => batch.insights());
  handle('batch:preview', (source: SourceConfig, userTemplate: string) => batch.previewSource(source, userTemplate));
  handle('batch:estimate', (config: RunConfig, observedOut?: number) => batch.estimateRun(config, observedOut));
  handle('batch:dryRun', (config: RunConfig, rowIndex?: number) => batch.dryRunOne(config, rowIndex));
  handle('batch:runs', () => batch.listRuns());
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
  handle('key:provider', (id: string) => ({
    present: hasProviderKey(id),
    fingerprint: providerKeyFingerprint(id),
  }));
  handle('key:setProvider', async (id: string, key: string) => {
    if (id === 'glm') {
      const verified = await verifyGlmKey(key);
      if (!verified.ok) throw new Error(verified.detail);
    }
    if (id === 'deepseek') {
      const verified = await verifyDeepSeekKey(key);
      if (!verified.ok) throw new Error(verified.detail);
    }
    setProviderKey(id, key);
    return { present: true, fingerprint: providerKeyFingerprint(id) };
  });
  handle('key:clearProvider', (id: string) => { clearProviderKey(id); return true; });
  handle('glm:models', (force?: boolean) => glmModels(force === true));
  handle('glm:verify', () => verifyGlmKey());
  handle('deepseek:models', (force?: boolean) => deepseekModels(force === true));
  handle('deepseek:verify', () => verifyDeepSeekKey());
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
  handle('settings:setSpendCap', (v: number) => { setSetting('spend_cap_usd', String(v)); return spendCap(); });
  handle('key:clear', () => { clearKey(); return true; });


  // ══ phase 1 · telemetry ═════════════════════════════════════════════
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

  // ══ phase 9 · worktrees ═════════════════════════════════════════════
  handle('worktrees:list', (repoRoot: string) => worktrees.listWorktrees(repoRoot));
  handle('worktrees:status', (p: string) => worktrees.worktreeStatus(p));
  handle('worktrees:remove', (p: string, force: boolean) => worktrees.removeWorktree(p, force));
  // Without this a fleet run ends with N worktrees holding the only copy of the
  // work and no way to land any of them from inside the app. Every refusal
  // comes back as { merged: false, detail }; it only throws when there is no
  // worktree at the path at all, so ok:false here is the rare case.
  handle('worktrees:merge', (p: string, opts?: { squash?: boolean; message?: string }) =>
    worktrees.mergeWorktree(p, opts));
  handle('worktrees:orphans', () => worktrees.reconcileWorktrees());
  handle('worktrees:relink', (p: string) => worktrees.relinkWorktree(p));
  handle('worktrees:forSession', (id: string) => worktrees.worktreeForSession(id));

  // ══ phase 10 · headless fan-out ═════════════════════════════════════
  handle('headless:start', (cfg: HeadlessConfig) => headless.startHeadlessRun(cfg));
  handle('headless:rows', (runId: string) => headless.headlessRows(runId));
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
  handle('queue:enqueue', (kind: QueueKind, label: string, payload: unknown, priority?: number) =>
    queue.enqueue(kind, label, payload, priority));

  // ══ phase 12 · MCP ══════════════════════════════════════════════════
  handle('mcp:servers', (projectId?: string | null) => mcpRegistry.listServers(projectId));
  handle('mcp:upsert', (cfg: Omit<McpServerConfig, 'id'> & { id?: string }) => mcpRegistry.upsertServer(cfg));
  handle('mcp:remove', (id: string) => { mcpRegistry.removeServer(id); return true; });
  handle('mcp:status', () => mcpRegistry.serverStatuses());
  handle('mcp:server', () => mcpServer.mcpServerInfo());
  handle('mcp:pending', () => mcpServer.pendingConfirmations());

  // ══ phases 5/18 · spend, budgets, reconciliation ════════════════════
  handle('spend:byProject', (days?: number) => spend.spendByProject(days));
  handle('spend:cache', () => spend.unifiedCacheRate());
  handle('spend:sync', (days?: number) => spend.syncComparison(days));
  handle('spend:effort', () => otel.effortBreakdown());
  handle('spend:byDay', (days: number) => otel.spendByDay(days));
  handle('budgets:list', () => spend.budgets());
  handle('budgets:set', (scopeId: string | null, monthly: number, warnAt?: number) => {
    spend.setBudget(scopeId, monthly, warnAt); return spend.budgets();
  });
  handle('budgets:breached', () => spend.budgetBreached());
  handle('budgets:reconcile', (from: string, to: string) => spend.reconcile(from, to));
  handle('budgets:accuracy', () => spend.estimateAccuracy());

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
    // Switching tabs/sessions can reveal that an alert previously suppressed
    // on the Mac is no longer on screen. Run after this IPC answer rather than
    // making renderer navigation wait on database reads and notification APIs.
    queueMicrotask(announceCurrentAttention);
    return true;
  });
  handle('mobile:status', () => mobile.mobileStatus());
  handle('mobile:configure', async (patch: Parameters<typeof mobile.setMobileConfig>[0]) => {
    const before = mobile.mobileConfig();
    const status = await mobile.setMobileConfig(patch);
    const deliveryChanged = before.pushEnabled !== status.config.pushEnabled
      || before.pushServer !== status.config.pushServer
      || before.pushTopic !== status.config.pushTopic;
    // Enabling alerts while a session is already waiting should not require
    // another lifecycle transition (or up to one poll interval) to be useful.
    if (deliveryChanged) notify.resetMobileAttentionDelivery();
    if (deliveryChanged && status.config.pushEnabled) queueMicrotask(announceCurrentAttention);
    return status;
  });
  handle('mobile:regenerateToken', () => mobile.regenerateMobileToken());
  handle('mobile:regenerateTopic', async () => {
    const status = await mobile.regenerateMobilePushTopic();
    notify.resetMobileAttentionDelivery();
    if (status.config.pushEnabled) queueMicrotask(announceCurrentAttention);
    return status;
  });
  handle('mobile:testPush', async () => {
    const result = await mobile.testMobilePush();
    return {
      ok: result.ok,
      detail: result.ok
        ? 'Test alert accepted by ntfy; device receipt is not reported.'
        : result.error ?? (result.skipped ? 'Phone alerts are disabled.' : 'ntfy did not accept the test alert.'),
    };
  });

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
  handle('skills:send', (sessionId: string, invoke: string) => { writeSession(sessionId, invoke + ' '); return true; });

  // ══ phase 28 · git ══════════════════════════════════════════════════
  handle('git:status', (root: string) => gitOps.status(root));
  handle('git:log', async (root: string, opts?: { limit?: number; all?: boolean }) => {
    const cs = await gitOps.log(root, opts);
    noteAuthors(cs.map((c) => c.author));
    return cs;
  });
  handle('git:branches', (root: string) => gitOps.branches(root));
  handle('git:stashes', (root: string) => gitOps.stashes(root));
  handle('git:commitDiff', (root: string, hash: string) => gitOps.commitDiff(root, hash));
  handle('git:fileDiff', (root: string, file: string, staged: boolean) => gitOps.fileDiff(root, file, staged));
  handle('git:stage', (root: string, files: string[]) => gitOps.stage(root, files));
  handle('git:unstage', (root: string, files: string[]) => gitOps.unstage(root, files));
  handle('git:discard', (root: string, tracked: string[], untracked: string[]) => gitOps.discard(root, tracked, untracked));
  handle('git:commit', (root: string, msg: string, opts?: { amend?: boolean; all?: boolean }) => gitOps.commit(root, msg, opts));
  handle('git:checkout', (root: string, ref: string, create?: boolean) => gitOps.checkout(root, ref, create === true));
  handle('git:deleteBranch', (root: string, name: string, force?: boolean) => gitOps.deleteBranch(root, name, force === true));
  handle('git:merge', (root: string, ref: string) => gitOps.merge(root, ref));
  handle('git:fetch', (root: string) => gitOps.fetchAll(root));
  handle('git:pull', (root: string) => gitOps.pull(root));
  handle('git:push', (root: string, opts?: { setUpstream?: boolean; branch?: string }) => gitOps.push(root, opts));
  handle('git:stashSave', (root: string, msg: string) => gitOps.stashSave(root, msg));
  handle('git:stashApply', (root: string, i: number, drop: boolean) => gitOps.stashApply(root, i, drop));
  handle('git:stashDrop', (root: string, i: number) => gitOps.stashDrop(root, i));

  // ══ phase 25 · schedules ════════════════════════════════════════════
  handle('schedule:list', () => schedule.listSchedules());
  handle('schedule:create', (input: { name: string; cron: string; kind: schedule.ScheduleKind; payload: unknown; projectId?: string | null }) =>
    schedule.createSchedule(input));
  handle('schedule:setEnabled', (id: string, on: boolean) => schedule.setScheduleEnabled(id, on));
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

  // ── reproducible review gates ──────────────────────────────────────
  handle('review:recipe', (projectId: string) => review.recipe(projectId));
  handle('review:saveRecipe', (projectId: string, commands: string[]) => review.saveRecipe(projectId, commands));
  handle('review:history', (projectId: string, limit?: number) => review.history(projectId, limit));
  handle('review:run', async (projectId: string) => {
    const result = await review.run(projectId);
    try { learning.observeReviewResult(result); }
    catch (error) { console.warn('[wanigan] review learning signal skipped:', error); }
    return result;
  });

  // ══ P30 · durable agent control plane ═══════════════════════════════
  handle('control:list', (projectId?: string | null, limit?: number) => control.listDockets(projectId, limit));
  handle('control:get', (id: string) => control.docket(id));
  handle('control:create', (input: {
    projectId: string; title: string; objective: string; acceptance?: string[];
    risk?: 'low' | 'elevated' | 'high'; budgetUsd?: number | null;
  }) => control.createDocket(input));
  handle('control:claim', (nodeId: string, relPath: string) => control.claimPath(nodeId, relPath));
  handle('control:releaseClaim', (id: string) => control.releaseClaim(id));
  handle('control:start', (nodeId: string, input: { providerId: string; model?: string; effort?: string; permissionMode?: string }) =>
    control.startNode(nodeId, input));
  handle('control:checkpoint', (nodeId: string, note: string) => control.checkpointNode(nodeId, note));
  handle('control:runProof', (nodeId: string) => control.runProof(nodeId));
  handle('control:complete', (nodeId: string, input?: { detail?: string; decision?: 'approve' | 'request_changes' | 'reject' }) =>
    control.completeNode(nodeId, input ?? {}));
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
  handle('plugins:details', (name: string) => plugins.details(name));
  handle('plugins:install', (id: string, scope?: 'user' | 'project' | 'local') => plugins.install(id, scope));
  handle('plugins:setEnabled', (id: string, on: boolean) => plugins.setEnabled(id, on));
  handle('plugins:marketUpdate', (name?: string) => plugins.updateMarketplaces(name));
  handle('plugins:marketAdd', (source: string) => plugins.addMarketplace(source));
  handle('plugins:marketRemove', (name: string) => plugins.removeMarketplace(name));

  // ══ file explorer ═══════════════════════════════════════════════════
  handle('browse:pick', (multi?: boolean, startIn?: string) => browse.pickFiles(win, { multi, startIn }));
  handle('browse:pickDir', (title?: string) => browse.pickDirectory(win, title));
  handle('browse:list', (dir: string, showHidden?: boolean) => browse.browse(dir, { showHidden }));
  handle('browse:places', () => browse.places());
  handle('browse:reveal', (p: string) => browse.revealInFinder(p));
  handle('browse:open', (p: string) => browse.openExternally(p));

  // ══ phase 21 · attachments ══════════════════════════════════════════
  handle('attach:inspect', (p: string) => attachments.inspect(p));
  handle('attach:add', (sessionId: string, p: string) => attachments.attachToSession(sessionId, p));
  handle('attach:paste', (sessionId: string, data: ArrayBuffer, name: string) =>
    attachments.attachBufferToSession(sessionId, Buffer.from(data), name));
  handle('attach:list', (sessionId: string) => attachments.sessionAttachments(sessionId));
  handle('attach:remove', (id: string) => attachments.removeAttachment(id));
  // Deliberately no trailing return: the human decides when to send.
  handle('attach:type', (sessionId: string) => {
    const list = attachments.promptableSessionAttachments(sessionId);
    if (!list.length) return false;
    writeSession(sessionId, attachments.promptReferenceFor(list));
    return true;
  });

  // ══ phases 13/15/16/17 · batch depth ════════════════════════════════
  handle('uploads:list', () => uploads.listUploads());
  handle('uploads:delete', (hash: string) => uploads.deleteUpload(hash));
  handle('uploads:prune', () => uploads.pruneOrphans());
  handle('refusal:rows', (runId: string) => refusal.refusedRows(runId));
  handle('refusal:summary', (runId: string) => refusal.refusalSummary(runId));
  handle('refusal:rescue', (runId: string, model: string) => refusal.rescueRefusals(runId, model));
  handle('refusal:merge', (childRunId: string) => refusal.mergeRescue(childRunId));
  handle('refusal:children', (runId: string) => refusal.rescueChildren(runId));
  handle('cache:hitRate', (runId: string) => cachediag.observedHitRate(runId));
  handle('cache:minimum', (modelId: string) => cachediag.minimumCacheablePrefix(modelId));
  handle('cache:ttl', (cfg: RunConfig, requests: number) => cachediag.recommendedTtl(cfg, requests));
  handle('evals:pairs', () => evals.listPairs());
  handle('evals:createPair', (name: string, a: string, b: string) => evals.createPair(name, a, b));
  handle('evals:diff', (pairId: string) => evals.pairDiff(pairId));
  handle('evals:summary', (pairId: string) => evals.regressionSummary(pairId));
  handle('evals:ingest', (judgeRunId: string) => evals.ingestJudgement(judgeRunId));
  handle('evals:golden', () => evals.listGoldenSets());
  handle('evals:saveGolden', (name: string, runId: string) => evals.saveGoldenSet(name, runId));
  handle('evals:goldenSource', (id: string) => evals.goldenSetSource(id));

  // ══ phase 23 · project context ══════════════════════════════════════
  // Everything a project injects into an agent before it has done anything.
  handle('context:instructions', (projectPath: string) => ctxInstructions.resolveInstructions(projectPath));
  handle('context:memory', (projectPath: string) => ctxMemory.readMemory(projectPath));
  handle('context:config', (projectPath: string) => ctxConfig.readProjectConfig(projectPath));
  handle('context:budget', (projectPath: string, files: { path: string; label: string }[], model?: string) =>
    ctxConfig.contextBudget(projectPath, files, model));
  handle('context:read', (p: string) => ctxInstructions.readInstruction(p));
  handle('context:memoryBody', (p: string) => ctxMemory.memoryBody(p));
  handle('context:agentsMd', (projectPath: string) => ctxInstructions.agentsMdStatus(projectPath));
  handle('context:refresh', (projectPath: string) => {
    ctxInstructions.refreshInstructions();
    ctxConfig.refreshProjectConfig();
    return ctxInstructions.resolveInstructions(projectPath);
  });

  // ══ Wanigan Compound · provider-neutral learning ═══════════════════
  handle('learning:overview', (projectId?: string | null) => learning.overview(projectId));
  handle('learning:settings', () => learning.settings());
  handle('learning:setSettings', (patch: Parameters<typeof learning.updateSettings>[0]) =>
    learning.updateSettings(patch));
  handle('learning:teach', (input: Parameters<typeof learning.teach>[0]) => learning.teach(input));
  handle('learning:consolidate', (projectId?: string | null) => learning.consolidate(projectId));
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
  handle('learning:briefing', (input: Parameters<typeof learning.briefing>[0]) =>
    learning.briefing(input));
  handle('learning:projections', (filter?: Parameters<typeof learning.listProjections>[0]) =>
    learning.listProjections(filter));
  handle('learning:undoProjection', (id: string) => learning.undo(id));
  handle('learning:diagnostics', (projectId?: string | null) =>
    learning.diagnoseKnowledge({ projectId }));
  handle('learning:forgeSkill', (input: Parameters<typeof learning.forgeSkill>[0]) =>
    learning.forgeSkill(input));
  handle('learning:doctorSkill', (skillMd: string, root?: string) =>
    learning.doctorSkill(skillMd, { root }));
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

  // ══ settings ════════════════════════════════════════════════════════
  handle('settings:all', () => allSettings());
  handle('settings:set', (k: string, v: string) => { setSetting(k, v); return allSettings(); });

  // Hot-path traffic: fire-and-forget, no round trip.
  ipcMain.on('sessions:write', (event, id: string, data: string) => {
    if (trustedSender(event.sender)) writeSession(id, data);
  });
  ipcMain.on('sessions:resize', (event, id: string, cols: number, rows: number) => {
    if (trustedSender(event.sender)) resizeSession(id, cols, rows);
  });
}

/** Streams a run's results to disk without materialising them in memory. */
function writeExport(runId: string, format: 'jsonl' | 'csv', filePath: string): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('node:fs') as typeof import('node:fs');
  const { db } = require('./db') as typeof import('./db');

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
