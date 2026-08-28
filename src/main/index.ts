import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import path from 'node:path';
import { detectProviders } from './providers';
import {
  initSessions, listSessions, createSession, writeSession, resizeSession,
  killSession, closeSession, scrollback, markRead, killAll, sessionBaseline, interruptSession,
  pastSessions, forgetPastSession,
} from './sessions';
import { listProjects, addProject, removeProject, refreshBranches, projectById } from './store';
import * as batch from './batch';
import * as code from './code';
import { getSetting, setSetting, spendCap } from './settings';
import { hasKey, getKey, setKey, clearKey, keyFingerprint, verifyKey, encryptionAvailable, getWorkspaceId,
         hasProviderKey, setProviderKey, clearProviderKey, providerKeyFingerprint } from './keys';
import type {
  LaunchOptions, RunConfig, SourceConfig, HeadlessConfig, HookInput,
  McpServerConfig, QueueKind, QueueSlots, TrustLevel,
} from '../shared/types';

// ── phases 1-24 ────────────────────────────────────────────────────────
import * as otel from './otel';
import * as hooks from './hooks';
import * as attention from './attention';
import * as transcripts from './transcripts';
import * as worktrees from './worktrees';
import * as queue from './queue';
import * as policy from './policy';
import * as headless from './headless';
import * as spend from './spend';
import * as notify from './notify';
import * as skills from './skills';
import * as plugins from './plugins';
import { glmModels } from './glm';
import * as gitOps from './git';
import { demoOn, setDemo, demoMap, maskOut, unmaskIn, noteAuthors } from './demo';
import * as schedule from './schedule';
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

/**
 * Batches advance in the main process on a timer. BatchStudio needed a separate
 * poller process because its server could be stopped independently; here the
 * app IS the process, so a batch keeps moving as long as Wanigan is open.
 */
let pollTimer: NodeJS.Timeout | null = null;

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
  };
  pollTimer = setInterval(tick, 10_000);
  void tick();
}

let win: BrowserWindow | null = null;

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
      sandbox: false,
    },
  });

  win.on('ready-to-show', () => win?.show());

  // External links open in the real browser, never inside the app shell.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(async () => {
  // Headless command path: same database, same Electron ABI, no window. This
  // has to come first — reaching createWindow() would open a window nobody
  // asked for and never exit, which is what a CLI hanging looks like.
  if (isCliInvocation()) {
    const code = await runCli(process.argv);
    app.exit(code);
    return;
  }

  // Headless verification path: exercise the real main process, then exit.
  if (process.env.WANIGAN_SMOKE === '1') {
    const { runSmoke } = await import('./smoke');
    await runSmoke();
    return;
  }

  initSessions(() => win);
  await startServices();
  registerIpc();
  createWindow();
  startPoller();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// An agent left running with no window is an agent burning tokens unseen.
app.on('before-quit', () => {
  if (pollTimer) clearInterval(pollTimer);
  killAll();
  stopServices();
});

/**
 * The three loopback listeners and the dispatcher, started before the first
 * window so no session can ever spawn pointing at a collector that is not up
 * yet — a session launched into a dead endpoint reports nothing and looks,
 * indistinguishably, like a session doing nothing.
 */
async function startServices() {
  const f = flags();

  if (f.telemetry) {
    try { await otel.startCollector(); }
    catch (e) { console.warn('[wanigan] telemetry collector did not start:', e); }
  }

  if (f.hooks) {
    try {
      await hooks.startHookServer();
      // Phase 19 decides; phase 2 carries the decision back to the agent.
      hooks.setPolicyHook((input: HookInput) => {
        const s = listSessions().find((x) => x.id === input.wanigan_session_id);
        const ctx = {
          sessionId: s?.id ?? null,
          projectId: s?.projectId ?? null,
          projectPath: s?.projectPath ?? null,
          trust: (s?.trust ?? policy.defaultTrust()) as TrustLevel,
        };
        const decision = policy.decideFor(ctx, input);
        policy.recordDecision(ctx, input, decision);
        return decision;
      });
      // Hook traffic is how the renderer knows an agent is blocked.
      hooks.onHookEvent((e) => {
        const w = win;
        if (w && !w.isDestroyed()) w.webContents.send('session:event', e);
      });
    } catch (e) { console.warn('[wanigan] hook bus did not start:', e); }
  }

  // Both directions, or neither works: headless hands each repo to the queue,
  // and the queue hands it back one slot at a time. Wiring only the second half
  // leaves headless silently falling back to its own internal limit, which is
  // the kind of bug that looks like "the slots setting does nothing".
  queue.registerRunner('headless', async (payload) => {
    const p = payload as { runId: string; projectId: string };
    await headless.runOneRepo(p.runId, p.projectId);
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
}

function stopServices() {
  try { schedule.stopScheduler(); } catch { /* already down */ }
  try { queue.stopDispatcher(); } catch { /* already down */ }
  try { hooks.stopHookServer(); } catch { /* already down */ }
  try { otel.stopCollector(); } catch { /* already down */ }
  try { mcpServer.stopMcpServer(); } catch { /* already down */ }
}

function registerIpc() {
  const handle = <T>(channel: string, fn: (...args: never[]) => T | Promise<T>) => {
    ipcMain.handle(channel, async (_e, ...args) => {
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
  handle('batch:estimate', (config: RunConfig, observed?: number) => batch.estimateRun(config, observed));
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
  handle('key:setProvider', (id: string, key: string) => {
    setProviderKey(id, key);
    return { present: true, fingerprint: providerKeyFingerprint(id) };
  });
  handle('key:clearProvider', (id: string) => { clearProviderKey(id); return true; });
  handle('glm:models', (force?: boolean) => glmModels(force === true));
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
    const list = attachments.sessionAttachments(sessionId);
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

  // ══ settings ════════════════════════════════════════════════════════
  handle('settings:all', () => allSettings());
  handle('settings:set', (k: string, v: string) => { setSetting(k, v); return allSettings(); });

  // Hot-path traffic: fire-and-forget, no round trip.
  ipcMain.on('sessions:write', (_e, id: string, data: string) => writeSession(id, data));
  ipcMain.on('sessions:resize', (_e, id: string, cols: number, rows: number) =>
    resizeSession(id, cols, rows));
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
