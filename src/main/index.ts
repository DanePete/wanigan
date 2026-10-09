// The Electron main process: windows, the menu, and a narrow bridge to the core.
// Privileged work lives in the core; this process only forwards what the
// renderer is allowed to ask for.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BrowserWindow, Menu, app, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { corePaths } from '../core/paths.ts';
import { alertKeys } from '../shared/notifications.ts';
import { ACCESS, type Method } from '../shared/protocol.ts';
import { wireAppSettings, type AppSettingsWiring } from './app-settings.ts';
import { wireLiveShots } from './live-shots.ts';
import { wireLiveAgent } from './live-agent.ts';
import { wireLiveView, type LiveViewWiring } from './live-view.ts';
import { CoreConnection } from './core-process.ts';
import { menuTemplate, type MenuProject } from './menu.ts';
import { createUpdateMenu } from './update-menu.ts';
import { NeedNotifier } from './notify.ts';
import { readPicked } from './picked.ts';
import type { CommandId } from '../shared/shortcuts.ts';

// Started with ELECTRON_RUN_AS_NODE set (inherited from a shell or a tool that
// runs Electron as Node), Electron is plain Node and there is no `app` at all.
if (!app) {
  process.stderr.write('Wanigan cannot start with ELECTRON_RUN_AS_NODE set. Unset ELECTRON_RUN_AS_NODE, then start Wanigan again.\n');
  process.exit(1);
}

// The demo runs as its own instance with its own data, beside the real one.
const demo = process.argv.includes('--demo') || process.env.WANIGAN_DEMO === '1';
const dataDir = demo
  ? process.env.WANIGAN_DATA_DIR || join(app.getPath('appData'), 'Wanigan 2 Demo')
  : process.env.WANIGAN_DATA_DIR || join(app.getPath('appData'), 'Wanigan 2');
app.setName('Wanigan');
app.setPath('userData', join(dataDir, 'electron'));

/** Methods the window may call: everything the owner may call, nothing else. */
const OWNER_METHODS = new Set(Object.entries(ACCESS).filter(([, roles]) => roles.includes('owner')).map(([m]) => m));

const core = new CoreConnection({
  dataDir,
  coreEntry: join(__dirname, 'core.js'),
  cliEntry: join(__dirname, 'cli.js'),
  socketPath: corePaths(dataDir).socket,
  runtime: process.execPath,
  ...(demo ? { coreArgs: ['--demo'] } : {}),
});

let win: BrowserWindow | null = null;
let appSettings: AppSettingsWiring | null = null;
let liveView: LiveViewWiring | null = null;

const notifier = new NeedNotifier(async () => (await core.get()).call('needs.list', {}), () => win, showRoute,
  () => appSettings?.store.get().notifications ?? 'all');

const RENDERER_FILE = join(__dirname, '../renderer/index.html');

function rendererUrl(): string {
  return process.env.ELECTRON_RENDERER_URL ?? pathToFileURL(RENDERER_FILE).href;
}

/**
 * Whether a URL is our own page. Compared as parsed URLs and real file paths,
 * never as strings: a packaged app lives at ".../Wanigan 2.app/...", and the
 * page reports that space percent-encoded.
 */
function ownPage(raw: string | undefined): boolean {
  if (!raw) return false;
  let url: URL;
  try { url = new URL(raw); } catch { return false; }
  const dev = process.env.ELECTRON_RENDERER_URL;
  if (dev) return url.origin === new URL(dev).origin;
  return url.protocol === 'file:' && fileURLToPath(url) === RENDERER_FILE;
}

/** Only our own page may use the bridge. */
function trusted(event: IpcMainInvokeEvent): boolean {
  return ownPage(event.senderFrame?.url);
}

/** Bring the window forward at a route, opening it there if it was closed. */
function showRoute(route: string): void {
  if (!win) { createWindow(route); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  win.webContents.send('app:navigate', route);
}

function createWindow(route = ''): void {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: demo ? 'Wanigan · Demo' : 'Wanigan',
    backgroundColor: '#111417',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });
  win.once('ready-to-show', () => win?.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!ownPage(url)) event.preventDefault();
  });
  win.on('closed', () => { liveView?.release(); win = null; notifier.schedule(); });
  // Coming forward or going away changes where a need is announced.
  win.on('focus', () => notifier.schedule());
  win.on('blur', () => notifier.schedule());
  void win.loadURL(`${rendererUrl()}${route}`);
}

function wireBridge(): void {
  appSettings = wireAppSettings({ core: () => core.get(), window: () => win, trusted, demo });
  liveView = wireLiveView({ window: () => win, trusted, enabled: () => appSettings?.store.get().liveView === true });
  // Switching the live view off takes it away at once, not at the next navigation.
  appSettings.store.onChange((s) => { if (!s.liveView) liveView?.release(); });
  const view = liveView;
  const shots = wireLiveShots({ client: () => core.get(), settings: () => appSettings?.store.get() ?? null, shoot: (...a) => view.shoot(...a) });
  // Agents' looks at the live view (wanigan mcp), relayed by the core: answered from a hidden window, never the owner's view.
  const agentLooks = wireLiveAgent({
    client: () => core.get(), settings: () => appSettings?.store.get() ?? null, view, windowOpen: () => !!win && !win.isDestroyed(),
  });
  ipcMain.handle('core:call', async (event, method: unknown, params: unknown) => {
    if (!trusted(event)) return { ok: false, error: { code: 'forbidden', message: 'Untrusted sender.' } };
    if (typeof method !== 'string' || !OWNER_METHODS.has(method)) {
      return { ok: false, error: { code: 'forbidden', message: `No method ${String(method)}.` } };
    }
    try {
      const client = await core.get();
      return { ok: true, result: await client.callRaw(method as Method, params) };
    } catch (error) {
      const e = error as { code?: string; message?: string };
      return { ok: false, error: { code: e.code ?? 'unavailable', message: e.message ?? String(error) } };
    }
  });
  ipcMain.handle('core:status', (event) => (trusted(event) ? core.current : 'unavailable'));
  ipcMain.handle('core:problem', (event) => (trusted(event) ? core.problem : null));
  ipcMain.handle('core:action', async (event, action: unknown) => {
    if (!trusted(event)) return;
    // What follows (connected, or a new reason it failed) arrives as status and problem.
    if (action === 'retry') await core.retry().catch(() => {});
    else if (action === 'restart') await core.restart().catch(() => {});
    else if (action === 'keep') core.keep();
  });
  ipcMain.handle('app:openDemo', (event) => {
    if (!trusted(event) || demo) return false;
    openDemo();
    return true;
  });
  ipcMain.handle('app:pickFolder', async (event) => {
    if (!trusted(event) || !win) return null;
    const result = await dialog.showOpenDialog(win, { title: 'Open a project folder', properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  // Only what the owner picked in the dialog is read; the window names no path.
  ipcMain.handle('app:pickFiles', async (event) => {
    if (!trusted(event) || !win) return null;
    const result = await dialog.showOpenDialog(win, { title: 'Attach files', buttonLabel: 'Attach', properties: ['openFile', 'multiSelections'] });
    return result.canceled ? null : readPicked(result.filePaths);
  });
  ipcMain.handle('app:openPath', async (event, path: unknown) => {
    if (!trusted(event) || typeof path !== 'string' || !path.startsWith('/')) return;
    shell.showItemInFolder(path);
  });
  ipcMain.handle('app:alertsSeen', (event, keys: unknown) => { if (trusted(event)) notifier.seen(alertKeys(keys)); });
  ipcMain.handle('app:alertsDismissed', (event, keys: unknown) => { if (trusted(event)) notifier.dismissed(alertKeys(keys)); });
  core.onEvent((event, data) => {
    // A question for the app, not news for the window.
    if (event === 'liveAsk') { agentLooks.onEvent(event, data); return; }
    win?.webContents.send('core:event', event, data);
    if (event === 'needs' || event === 'sessions' || event === 'board') notifier.schedule();
    appSettings?.onCoreEvent(event);
    shots.onEvent(event, data);
    if (event === 'projects') refreshMenu();
  });
  core.onProblem((problem) => win?.webContents.send('core:problem', problem));
  core.onStatus((status) => {
    win?.webContents.send('core:status', status);
    if (status === 'connected') { notifier.schedule(); appSettings?.onCoreConnected(); refreshMenu(); agentLooks.onConnected(); }
  });
}

/** The demo opens as a second instance with its own data, so the real desk stays as it is. */
function openDemo(): void {
  const env: NodeJS.ProcessEnv = { ...process.env, WANIGAN_DEMO: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  // Its own data, always: a data directory set for this instance would make the
  // demo the same instance, and it would quit.
  delete env.WANIGAN_DATA_DIR;
  const args = app.isPackaged ? ['--demo'] : [app.getAppPath(), '--demo'];
  spawn(process.execPath, args, { detached: true, stdio: 'ignore', env }).unref();
}

let menuProjects: MenuProject[] = [];

function buildMenu(): void {
  const template = menuTemplate(menuProjects, { command: sendCommand, go: showRoute, ...(demo ? {} : { checkForUpdates: () => void checkFromMenu() }) });
  // The demo is a second instance with its own data; Help opens it, or leaves it.
  const help = template.find((m) => m.role === 'help');
  if (help && Array.isArray(help.submenu)) {
    help.submenu.push({ type: 'separator' }, demo ? { label: 'Leave the Demo', click: () => app.quit() } : { label: 'Open the Demo', click: openDemo });
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** The Go menu lists open projects; rebuild it when they change. */
let menuTimer: NodeJS.Timeout | null = null;
function refreshMenu(): void {
  if (menuTimer) return;
  menuTimer = setTimeout(() => {
    menuTimer = null;
    void core.get().then((c) => c.call('projects.list', {})).then((list) => {
      const next = list.map((p) => ({ key: p.key, name: p.name }));
      if (JSON.stringify(next) === JSON.stringify(menuProjects)) return;
      menuProjects = next;
      buildMenu();
    }).catch(() => {});
  }, 300);
}

/** Run a menu command in the window, as its key would; open the window first if it was closed. */
function sendCommand(id: CommandId): void {
  if (!win) {
    createWindow();
    const opened = win as BrowserWindow | null;
    // Give the page a moment past loading to start listening.
    opened?.webContents.once('did-finish-load', () => setTimeout(() => win?.webContents.send('app:command', id), 500));
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  win.webContents.send('app:command', id);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  void app.whenReady().then(() => {
    wireBridge();
    buildMenu();
    createWindow();
    void core.get().catch(() => {});
    app.on('activate', () => { if (!win) createWindow(); });
  });
  // Closing the window keeps sessions running in the core, on every platform.
  // The demo ends with its window; the real app keeps sessions running either way.
  app.on('window-all-closed', () => { if (demo || process.platform !== 'darwin') app.quit(); });
  app.on('before-quit', (event) => {
    // The demo's stand-in agents need no warning.
    if (quitChecked || demo) { appSettings?.release(); core.close(); return; }
    event.preventDefault();
    quitChecked = true;
    void confirmQuit().catch(() => true).then((quit) => { if (quit) app.quit(); });
  });
}

/* ── Check for Updates… ───────────────────────────────────────────────────── */

/**
 * The menu's check, answered the way Mac apps answer it: a dialog saying the
 * version is current, or what is out and how to install it. Until Wanigan is
 * signed with a Developer ID, macOS will not let it replace itself, so a new
 * version is a download.
 */
const checkFromMenu = createUpdateMenu({
  check: async () => appSettings?.updates?.check() ?? null,
  show: (options) => win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options),
  version: () => app.getVersion(),
  open: (which) => appSettings?.openUpdate(which),
});

/* ── an honest quit ───────────────────────────────────────────────────────── */

// Sessions outlive the app, but what notifies the owner lives in this process:
// after a quit nothing says when one needs them. Say so, once per launch.
let quitChecked = false;
const quitPrefs = (): string => join(app.getPath('userData'), 'quit-warning.json');

async function confirmQuit(): Promise<boolean> {
  try {
    if (JSON.parse(readFileSync(quitPrefs(), 'utf8')).ask === false) return true;
  } catch { /* never answered: ask */ }
  const live = await liveSessions();
  if (!live) return true;
  const options = {
    type: 'warning' as const,
    message: `${live === 1 ? '1 session keeps' : `${live} sessions keep`} running.`,
    detail: 'Wanigan won’t notify you while it’s closed.',
    buttons: ['Quit', 'Keep open'],
    defaultId: 0,
    cancelId: 1,
    checkboxLabel: 'Don’t ask again',
  };
  const { response, checkboxChecked } = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
  if (checkboxChecked) {
    try { writeFileSync(quitPrefs(), `${JSON.stringify({ ask: false })}\n`); } catch { /* asked again next launch */ }
  }
  return response === 0;
}

/** Live sessions in the core, or 0 when it cannot say quickly. Never starts a core to ask. */
async function liveSessions(): Promise<number> {
  if (core.current !== 'connected') return 0;
  const count = core.get().then((c) => c.call('sessions.list', { live: true })).then((list) => list.length, () => 0);
  return Promise.race([count, new Promise<number>((resolve) => setTimeout(() => resolve(0), 1500))]);
}
