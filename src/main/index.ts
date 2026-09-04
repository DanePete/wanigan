import { app, BrowserWindow, ipcMain, dialog, shell, session } from 'electron';
import type { WebContents, WebFrameMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  detectProviders, effectiveProviderBackendId, providerById, providerPackRegistry, refreshProviderPacks,
  runsClaudeCli, usesAnthropicAccount,
} from './providers';
import {
  initSessions, listSessions, createSession, writeSession, resizeSession,
  killSession, closeSession, scrollback, markRead, shutdownAll, sessionBaseline, interruptSession,
  pastSessions, forgetPastSession, recoverExactCodexThread, setSessionExitObserver,
  setSessionTuning, setConversationFlag, renameSession, redirectsAnthropicApiFor,
} from './sessions';
import { listProjects, addProject, removeProject, refreshBranches, projectById } from './store';
import * as batch from './batch';
import * as code from './code';
import { getSetting, setSetting, setTheme, setUserPreference, spendCap } from './settings';
import { hasKey, setKey, clearKey, keyFingerprint, verifyKey, encryptionAvailable, getWorkspaceId,
         hasProviderKey, setProviderKey, clearProviderKey, providerKeyFingerprint } from './keys';
import type {
  BackupCheck, BackupRestoreSummary, BackupSummary, DocketPlanNode,
  HeadlessRowDetail, HeadlessRowSummary, HeadlessStartRequest, HookInput,
  InteractiveSessionLoad, LaunchOptions, McpServerConfig, PluginScope,
  ProviderInfo, ProviderManifestInspection, QueueSlots, RunConfig, Session,
  SourceConfig, ThemeSetting, TrustLevel,
} from '../shared/types';
import { EFFORT_LEVELS } from '../shared/types';
import { assertManagedRoot, assertOpenablePath } from './roots';

// ── phases 1-24 ────────────────────────────────────────────────────────
import * as otel from './otel';
import { codexUsageSummary } from './codex-usage';
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
import * as skills from './skills';
import * as plugins from './plugins';
import { glmModels, verifyGlmKey } from './glm';
import { deepseekModels, verifyDeepSeekKey } from './deepseek';
import * as gitOps from './git';
import * as gh from './gh';
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
import * as backup from './backup';
import * as learning from './learning-service';
// The canonical knowledge record, not a second copy of it: learning-service
// wraps consolidation and briefing, and has no retirement path of its own.
import { retireKnowledgeItem } from './learning';
import * as control from './control';
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
/** Slower than the dispatcher: a docket becomes eligible when work finishes. */
const AUTOPILOT_SWEEP_MS = 10_000;
let autopilotTimer: NodeJS.Timeout | null = null;
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
  const w = win;
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
    const w = win;
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
  const w = win;
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

type ManagedProviderCredentialId = 'glm' | 'deepseek';

/** Provider keys are stored under predictable names in the OS keychain. Do
 * not let a renderer choose an arbitrary key identifier and turn this into a
 * secret-presence oracle for the process environment or credential store. */
function managedProviderCredentialId(value: unknown): ManagedProviderCredentialId {
  if (value === 'glm' || value === 'deepseek') return value;
  throw new Error('Wanigan manages provider credentials only for GLM and DeepSeek.');
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
  // eslint-disable-next-line no-control-regex
  if (/\s/.test(source) || /[\u0000-\u001f\u007f]/.test(source)) {
    throw new Error('A marketplace source cannot contain spaces or control characters.');
  }
  return source;
}

type ModelChoice = { value: string; label: string };

/**
 * Model aliases each built-in backend publishes.
 *
 * Keyed on the BACKEND, never on the profile. Which models exist is a property
 * of the service being called: 'anthropic' answers for any profile pointed at
 * Anthropic no matter what that profile is named, and a pack that points the
 * same harness somewhere else does not inherit the list by accident. spend.ts
 * already draws this line in the same place and for the same reason.
 *
 * It is the last resort, not the rule — see providerModelChoices.
 */
/** Bounds for the Codex model probe — it runs while a picker is rendering. */
const CODEX_MODELS_TIMEOUT_MS = 4_000;
const CODEX_MODELS_MAX_BYTES = 512 * 1024;

const PUBLISHED_BACKEND_MODELS: Record<string, ModelChoice[]> = {
  anthropic: [
    { value: 'opus', label: 'Opus' }, { value: 'sonnet', label: 'Sonnet' },
    { value: 'haiku', label: 'Haiku' }, { value: 'fable', label: 'Fable' },
  ],
  openai: [
    { value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
    { value: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
    { value: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
  ],
};

/**
 * Backends Wanigan can ask for a live catalogue, because it holds the
 * credential that call needs — the same two ids managedProviderCredentialId
 * governs, keyed the same way.
 */
const LIVE_BACKEND_MODELS: Record<string, (provider: ProviderInfo) => Promise<ModelChoice[]>> = {
  zai: async () => (await glmModels()).models.map((m) => ({ value: m.id, label: m.label })),
  deepseek: async () => (await deepseekModels()).models.map((m) => ({ value: m.id, label: m.label })),
  openai: (provider) => codexModels(provider),
};

/**
 * Ask the installed Codex CLI what it can run, rather than shipping a list that
 * is wrong the day OpenAI names a new model.
 *
 * `codex app-server` speaks JSON-RPC over stdio and answers `model/list` with
 * the ids, display names and per-model reasoning efforts the binary actually
 * accepts. That is the authority: a model this build has never heard of is a
 * launch failure no matter what Wanigan offers, and a model it gained this
 * morning works without anyone editing this file.
 *
 * Bounded on every axis, because it runs on the launch path: no credential is
 * passed, output is capped, and the child is killed on the timeout, on a parse
 * failure and on the success path alike — an unbounded probe that spawns a
 * process per picker render is worse than a stale list.
 */
async function codexModels(provider: ProviderInfo): Promise<ModelChoice[]> {
  const bin = provider.path;
  if (!bin) return [];
  return new Promise<ModelChoice[]>((resolve) => {
    let child: ReturnType<typeof spawn> | null = null;
    let out = '';
    let settled = false;
    const finish = (models: ModelChoice[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Terminate on every path, not just the error one: a probe that leaves an
      // app-server behind on success leaks one process per refresh.
      try { child?.kill('SIGKILL'); } catch { /* already gone is the outcome we wanted */ }
      resolve(models);
    };
    const timer = setTimeout(() => finish([]), CODEX_MODELS_TIMEOUT_MS);
    try {
      child = spawn(bin, ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch { return finish([]); }
    child.on('error', () => finish([]));
    child.on('exit', () => finish([]));
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
      if (out.length > CODEX_MODELS_MAX_BYTES) return finish([]);
      for (const line of out.split('\n')) {
        if (!line.trim()) continue;
        let msg: { id?: unknown; result?: { data?: unknown } };
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== 2) continue;
        const rows = Array.isArray(msg.result?.data) ? msg.result.data : [];
        finish(rows
          .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object')
          // `hidden` is the CLI's own word for a model it lists but does not
          // want offered; honour it rather than second-guessing it.
          .filter((row) => row.hidden !== true)
          .map((row) => ({
            value: String(row.id ?? row.model ?? ''),
            label: String(row.displayName ?? row.id ?? ''),
          }))
          .filter((choice) => choice.value !== ''));
        return;
      }
    });
    child.stdin?.on('error', () => finish([]));
    child.stdin?.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { clientInfo: { name: 'wanigan', version: app.getVersion() } },
    }) + '\n');
    child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'model/list', params: {} }) + '\n');
  });
}

/** The choices a profile's own launch field declares, which is the manifest's
 *  existing mechanism for saying what a profile accepts. */
function declaredChoices(provider: ProviderInfo, fieldId: string): ModelChoice[] {
  const field = provider.launchFields?.find((value) => value.id === fieldId);
  return (field?.options ?? []).map((option) => ({ value: option.value, label: option.label }));
}

/**
 * What to offer for a provider's model, in the order Wanigan can vouch for it.
 *
 * This used to be a table keyed on four hardcoded profile ids, which is the
 * shape CLAUDE.md forbids: a pack declaring its own models got an empty picker,
 * a renamed built-in got somebody else's list, and neither could be fixed
 * without editing this file. The manifest wins, then the backend Wanigan can
 * ask, then what that backend publishes.
 */
async function providerModelChoices(provider: ProviderInfo): Promise<ModelChoice[]> {
  const declared = declaredChoices(provider, 'model');
  if (declared.length) return declared;
  const live = provider.backendId ? LIVE_BACKEND_MODELS[provider.backendId] : undefined;
  if (live) {
    // One backend that will not answer must not empty the whole picker, and a
    // stale cached list is better than claiming the provider has no models.
    try { return await live(provider); } catch { return []; }
  }
  return (provider.backendId ? PUBLISHED_BACKEND_MODELS[provider.backendId] : undefined) ?? [];
}

/**
 * Effort values the profile itself declares.
 *
 * The previous list appended 'ultra' whenever the id read 'codex' — a value no
 * manifest declares, so picking it produced an argv entry the profile's own
 * select rejects. EFFORT_LEVELS stands in only for a legacy definition that
 * carries no launch fields at all.
 */
function providerEffortChoices(provider: ProviderInfo): string[] {
  if (!provider.supports.effort) return [];
  const declared = declaredChoices(provider, 'effort').map((choice) => choice.value);
  return declared.length ? declared : [...EFFORT_LEVELS];
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
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
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

  const devRenderer = developmentRendererUrl();
  if (devRenderer) {
    win.loadURL(devRenderer);
  } else {
    win.loadFile(rendererEntryPath());
  }
}

app.whenReady().then(async () => {
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

  if (startupState.phase !== 'recovery') {
    const state = await startAttendedServices();
    if (state.phase === 'recovery') showStartupRecoveryNotice(state);
  } else {
    showStartupRecoveryNotice();
  }

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
        message: `${summary} will be stopped.`,
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

  // Background learning activity (a signal from a live session, a timer
  // consolidation pass) pushes one debounced event so the Learning view can
  // refresh without polling. User-initiated mutations reload via their own
  // IPC round trip and do not need it.
  learning.setLearningChangedNotifier(() => {
    const w = win;
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
    const w = win;
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
  schedule.startScheduler(() => {
    const w = win;
    if (w && !w.isDestroyed()) w.webContents.send('queue:changed');
  });
  queue.registerRunner('node', async (payload) => {
    const nodeId = (payload as { nodeId?: unknown } | null)?.nodeId;
    if (typeof nodeId !== 'string' || !nodeId) {
      throw new Error('This autopilot queue item names no Goal task. Remove it and re-enable autopilot on the docket.');
    }
    await control.startQueuedNode(nodeId);
  });
  queue.startDispatcher(() => {
    const w = win;
    if (w && !w.isDestroyed()) w.webContents.send('queue:changed');
  });
  // The sweep only writes queue rows; the dispatcher above still decides when
  // one may start. It runs on its own slower interval because a docket becomes
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
        const w = win;
        if (w && !w.isDestroyed()) w.webContents.send('queue:changed');
      }
    } catch (e) {
      // Same reasoning as the dispatcher's own guarded tick: a throw here has
      // no handler and would take Electron down with every live PTY.
      console.warn('[wanigan] autopilot sweep failed; skipping this pass:', e);
    }
  }, AUTOPILOT_SWEEP_MS);

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
  // A docket task left 'running' by a crash describes an agent that no longer
  // exists — and holds path claims nobody can release until it is reopened.
  try {
    const reopened = control.reconcileRunningNodes();
    if (reopened) console.warn(`[wanigan] reopened ${reopened} docket task(s) whose session did not survive the last run`);
  } catch (e) { console.warn('[wanigan] docket reconciliation skipped:', e); }
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
  mobile.configureMobileControlSource({
    projects: async () => listProjects().map((project) => ({ id: project.id, name: project.name, branch: project.branch })),
    providers: async () => {
      const providers = await detectProviders();
      return Promise.all(providers.map(async (provider) => ({
        id: provider.id, label: provider.label, available: Boolean(provider.path),
        models: await providerModelChoices(provider),
        efforts: providerEffortChoices(provider),
      })));
    },
    launch: async ({ projectId, providerId, model, effort, prompt }) => {
      const session = await createSession({ providerId, projectId, model, effort, initialPrompt: prompt });
      return { id: session.id, title: session.title };
    },
    prompt: async (sessionId, prompt) => {
      const session = listSessions().find((value) => value.id === sessionId && value.status !== 'exited');
      if (!session) throw new Error('That session is no longer running.');
      writeSession(sessionId, `${prompt}\r`);
    },
    interrupt: async (sessionId) => interruptSession(sessionId),
    terminal: async (sessionId) => {
      const session = listSessions().find((value) => value.id === sessionId);
      if (!session) throw new Error('That session is no longer available.');
      return { title: session.title, running: session.status !== 'exited', text: scrollback(sessionId) };
    },
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
      initSessions(() => win);
      setSessionExitObserver((value) => notify.announceAttention(attention.attentionOf(value)));
      // Clicking a banner already raises the window; this is the half that was
      // missing. Without a route the operator lands on whichever tab happened
      // to be open and still has to hunt for the agent they were told about.
      notify.setNotificationOpener((target) => {
        const w = win;
        if (!w || w.isDestroyed()) return;
        w.webContents.send('notify:open', target);
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
  stopHookEventListener?.();
  stopHookEventListener = null;
  try { mobile.stopMobileMonitor(); } catch { /* already down */ }
  learning.stopConsolidator();
  learning.setLearningChangedNotifier(null);
  hooks.setLearningBriefingHook(null);
  try { schedule.stopScheduler(); } catch { /* already down */ }
  try { queue.stopDispatcher(); } catch { /* already down */ }
  if (autopilotTimer) { clearInterval(autopilotTimer); autopilotTimer = null; }
  try { hooks.stopHookServer(); } catch { /* already down */ }
  try { otel.stopCollector(); } catch { /* already down */ }
  try { mcpServer.stopMcpServer(); } catch { /* already down */ }
}

/**
 * Whether demo masking is on, without asking SQLite twice per IPC call.
 *
 * unmaskIn and maskOut each call demoOn(), which calls getSetting(), which
 * compiles a fresh prepared statement every time. Two of those wrap all 291
 * handlers, so the Sessions tab alone paid for roughly 280 prepare-and-query
 * pairs a minute to learn that a screenshot mode nobody had switched on was
 * still off. demo.ts is the only writer and there is exactly one of it in this
 * process — the demo:set handler below — so the memo is invalidated there; the
 * short window is belt and braces for a writer this file does not know about.
 */
const DEMO_MODE_TTL_MS = 1_000;
let demoModeCheckedAt = 0;
let demoModeCached = false;

function demoMasking(): boolean {
  const now = Date.now();
  if (demoModeCheckedAt && now - demoModeCheckedAt < DEMO_MODE_TTL_MS) return demoModeCached;
  try {
    demoModeCached = demoOn();
  } catch {
    // This runs before the handler's own try, and in recovery mode the database
    // holding the setting is the thing that could not be opened. Masking off is
    // the only answer available, and it keeps startup:status — the one handler
    // that has to work here — from failing with a message about SQLite.
    demoModeCached = false;
  }
  demoModeCheckedAt = now;
  return demoModeCached;
}

function forgetDemoMasking(): void {
  demoModeCheckedAt = 0;
}

function registerIpc() {
  const handle = <T>(channel: string, fn: (...args: never[]) => T | Promise<T>) => {
    ipcMain.handle(channel, async (event, ...args) => {
      if (!trustedSender(event.sender, event.senderFrame)) {
        return { ok: false, error: 'Untrusted IPC sender.' };
      }
      // Demo mode is bidirectional on purpose: a masked path handed back to
      // git has to become real again, or every action fails while the demo
      // is running — which is exactly when nobody can debug it. While it is
      // off, neither walk is entered at all.
      const masking = demoMasking();
      try {
        const real = masking ? (unmaskIn(args) as never[]) : (args as never[]);
        const data = await fn(...real);
        return { ok: true, data: masking ? maskOut(data) : data };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false, error: masking ? maskOut(msg) : msg };
      }
    });
  };

  // This handler is intentionally database-free. It remains available when a
  // failed migration has put the attended UI in recovery mode, so the renderer
  // can explain why normal controls are paused and offer one bounded retry.
  handle('startup:status', () => startupSnapshot());
  handle('startup:retry', () => startAttendedServices());

  handle('demo:state', () => ({ on: demoOn(), map: demoMap() }));
  handle('demo:set', (on: boolean) => {
    setDemo(on);
    forgetDemoMasking();
    return { on: demoOn(), map: demoMap() };
  });

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
  handle('sessions:create', (opts: LaunchOptions) => createSession(opts));
  // Separate from sessions:create: only the exact UUID + selected project
  // cross this boundary, so arbitrary launch flags cannot turn recovery into a
  // broad Codex picker or a second writer.
  handle('sessions:recoverExactCodex', (input: { threadId: unknown; projectId: unknown }) =>
    recoverExactCodexThread(input));
  handle('sessions:scrollback', (id: string) => scrollback(id));
  handle('sessions:interrupt', (id: string, force?: boolean) => interruptSession(id, force === true));
  handle('sessions:kill', (id: string) => { killSession(id); return true; });
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
  handle('key:provider', (rawId: string) => {
    const id = managedProviderCredentialId(rawId);
    return {
      present: hasProviderKey(id),
      fingerprint: providerKeyFingerprint(id),
    };
  });
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
    setProviderKey(id, key);
    return { present: true, fingerprint: providerKeyFingerprint(id) };
  });
  handle('key:clearProvider', (rawId: string) => { clearProviderKey(managedProviderCredentialId(rawId)); return true; });
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
  handle('worktrees:list', (repoRoot: string) => worktrees.listWorktrees(repoRoot));
  handle('worktrees:status', (p: string) => worktrees.worktreeStatus(p));
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
  handle('worktrees:orphans', () => worktrees.reconcileWorktrees());
  handle('worktrees:relink', (p: string) => worktrees.relinkWorktree(assertManagedRoot(p, 'That worktree')));
  handle('worktrees:forSession', (id: string) => worktrees.worktreeForSession(id));

  // ══ phase 10 · headless fan-out ═════════════════════════════════════
  handle('headless:start', (cfg: HeadlessStartRequest) => headless.startHeadlessRun(cfg));
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
  // Every root here goes through gitRoot(); see its comment for why the reads
  // are confined as well as the writes.
  handle('git:status', (root: string) => gitOps.status(gitRoot(root)));
  handle('git:log', async (root: string, opts?: { limit?: number; all?: boolean }) => {
    const cs = await gitOps.log(gitRoot(root), opts);
    noteAuthors(cs.map((c) => c.author));
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
  handle('review:saveRecipe', (projectId: string, commands: string[]) => review.saveRecipe(projectId, commands));
  handle('review:history', (projectId: string, limit?: number) => review.history(projectId, limit));
  handle('review:run', async (projectId: string) => {
    const result = await review.run(projectId);
    try { learning.observeReviewResult(result); }
    catch (error) { console.warn('[wanigan] review learning signal skipped:', error); }
    return result;
  });

  // ══ P30 · durable agent control plane ═══════════════════════════════
  handle('usage:snapshot', (input?: { days?: number; force?: boolean }) => usage.snapshot(input));
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
    const w = win;
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
  handle('browse:reveal', (p: string) => browse.revealInFinder(p));
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
    const w = win;
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
  handle('settings:set', (key: string, value: string) => setUserPreference(key, value));
  handle('settings:setTheme', (value: ThemeSetting) => { setTheme(value); return allSettings(); });

  // Hot-path traffic: fire-and-forget, no round trip.
  ipcMain.on('sessions:write', (event, id: string, data: string) => {
    if (trustedSender(event.sender, event.senderFrame)) writeSession(id, data);
  });
  ipcMain.on('sessions:resize', (event, id: string, cols: number, rows: number) => {
    if (trustedSender(event.sender, event.senderFrame)) resizeSession(id, cols, rows);
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
