import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import path from 'node:path';
import { detectProviders } from './providers';
import {
  initSessions, listSessions, createSession, writeSession, resizeSession,
  killSession, closeSession, scrollback, markRead, killAll,
} from './sessions';
import { listProjects, addProject, removeProject, refreshBranches } from './store';
import type { LaunchOptions } from '../shared/types';

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

app.whenReady().then(() => {
  initSessions(() => win);
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// An agent left running with no window is an agent burning tokens unseen.
app.on('before-quit', () => killAll());

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

  // Hot-path traffic: fire-and-forget, no round trip.
  ipcMain.on('sessions:write', (_e, id: string, data: string) => writeSession(id, data));
  ipcMain.on('sessions:resize', (_e, id: string, cols: number, rows: number) =>
    resizeSession(id, cols, rows));
}
