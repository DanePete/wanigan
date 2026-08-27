import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import path from 'node:path';
import { detectProviders } from './providers';
import {
  initSessions, listSessions, createSession, writeSession, resizeSession,
  killSession, closeSession, scrollback, markRead, killAll,
} from './sessions';
import { listProjects, addProject, removeProject, refreshBranches } from './store';
import * as batch from './batch';
import { getSetting, setSetting, spendCap } from './settings';
import { hasKey, getKey, setKey, clearKey, keyFingerprint, verifyKey, encryptionAvailable, getWorkspaceId } from './keys';
import type { LaunchOptions, RunConfig, SourceConfig } from '../shared/types';

/**
 * Batches advance in the main process on a timer. BatchStudio needed a separate
 * poller process because its server could be stopped independently; here the
 * app IS the process, so a batch keeps moving as long as Foreman is open.
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
  // Headless verification path: exercise the real main process, then exit.
  if (process.env.FOREMAN_SMOKE === '1') {
    const { runSmoke } = await import('./smoke');
    await runSmoke();
    return;
  }

  initSessions(() => win);
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
});

function registerIpc() {
  const handle = <T>(channel: string, fn: (...args: never[]) => T | Promise<T>) => {
    ipcMain.handle(channel, async (_e, ...args) => {
      try {
        return { ok: true, data: await fn(...(args as never[])) };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    });
  };

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
  handle('sessions:kill', (id: string) => { killSession(id); return true; });
  handle('sessions:close', (id: string) => { closeSession(id); return true; });
  handle('sessions:markRead', (id: string) => { markRead(id); return true; });
  handle('sessions:reveal', (p: string) => { shell.openPath(p); return true; });

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
  handle('settings:get', () => ({ spendCapUsd: spendCap() }));
  handle('settings:setSpendCap', (v: number) => { setSetting('spend_cap_usd', String(v)); return spendCap(); });
  handle('key:clear', () => { clearKey(); return true; });

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
