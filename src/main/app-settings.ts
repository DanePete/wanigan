// The app's settings and what they switch, wired to the window: the settings
// file, keeping the Mac awake while sessions are live, checking for a new
// version, and the IPC calls the Settings view uses.
import { join } from 'node:path';
import { app, ipcMain, net, powerSaveBlocker, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import type { AppState } from '../shared/settings.ts';
import { RELEASES_REPO } from '../shared/updates.ts';
import type { CoreClient } from '../client/client.ts';
import { KeepAwake } from './awake.ts';
import { SettingsStore } from './settings.ts';
import { UpdateChecker } from './updates.ts';

export interface AppSettingsWiring {
  store: SettingsStore;
  /** Checks GitHub for a new version; null in the demo, which never asks the network. */
  updates: UpdateChecker | null;
  /** Open what the last check found: its disk image, or its release page. */
  openUpdate(which: 'download' | 'notes'): void;
  /** Call on every core event; live sessions are recounted on `sessions`. */
  onCoreEvent(event: string): void;
  onCoreConnected(): void;
  /** The app is quitting. */
  release(): void;
}

export function wireAppSettings(options: {
  core: () => Promise<CoreClient>;
  window: () => BrowserWindow | null;
  trusted: (event: IpcMainInvokeEvent) => boolean;
  /** The demo's stand-in agents are not work: they never hold the Mac awake. */
  demo?: boolean;
}): AppSettingsWiring {
  const store = new SettingsStore(join(app.getPath('userData'), 'settings.json'));
  const awake = new KeepAwake(powerSaveBlocker, !options.demo && store.get().keepAwake);

  const updates = options.demo ? null : new UpdateChecker({
    current: app.getVersion(),
    file: join(app.getPath('userData'), 'updates.json'),
    fetch: (url, init) => net.fetch(url, init),
    checks: () => store.get().updateChecks,
    onChange: () => push(),
  });

  const state = (): AppState => ({
    settings: store.get(),
    awake: { holding: awake.holding, live: awake.liveSessions },
    version: app.getVersion(),
    updates: updates?.status ?? null,
  });
  const push = (): void => { options.window()?.webContents.send('app:state', state()); };

  // Only links the check itself found and kept are opened; the window names none.
  const openUpdate = (which: 'download' | 'notes'): void => {
    const s = updates?.status;
    const fallback = `https://github.com/${RELEASES_REPO.owner}/${RELEASES_REPO.repo}/releases`;
    const url = s?.state === 'available' ? (which === 'download' ? s.release.dmg ?? s.release.page : s.release.page) : fallback;
    void shell.openExternal(url);
  };

  let timer: NodeJS.Timeout | null = null;
  const recount = (): void => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      void options.core()
        .then((c) => c.call('sessions.list', { live: true }))
        .then((live) => {
          const before = `${awake.holding}:${awake.liveSessions}`;
          awake.setLive(live.length);
          if (`${awake.holding}:${awake.liveSessions}` !== before) push();
        })
        // The core is unreachable: what is running is unknown, so leave the hold as it was.
        .catch(() => {});
    }, 300);
  };

  store.onChange((s) => { awake.setEnabled(!options.demo && s.keepAwake); updates?.schedule(); push(); });
  updates?.schedule();
  ipcMain.handle('app:state', (event) => (options.trusted(event) ? state() : null));
  ipcMain.handle('app:setSettings', (event, patch: unknown) => {
    if (!options.trusted(event)) return null;
    store.update(patch);
    return state();
  });
  ipcMain.handle('app:checkUpdates', async (event) => {
    if (!options.trusted(event)) return null;
    await updates?.check();
    return state();
  });
  ipcMain.handle('app:openUpdate', (event, which: unknown) => {
    if (options.trusted(event) && (which === 'download' || which === 'notes')) openUpdate(which);
  });

  return {
    store,
    updates,
    openUpdate,
    onCoreEvent: (event) => { if (event === 'sessions') recount(); },
    onCoreConnected: recount,
    release: () => { awake.release(); updates?.stop(); },
  };
}
