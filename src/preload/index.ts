import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { CoreProblem, CoreStatus, PickedFiles, WaniganBridge } from '../shared/bridge.ts';
import type { AppState } from '../shared/settings.ts';

type Reply = { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } };

const bridge: WaniganBridge = {
  async call(method, params) {
    const reply = (await ipcRenderer.invoke('core:call', method, params)) as Reply;
    if (!reply.ok) throw Object.assign(new Error(reply.error.message), { code: reply.error.code });
    return reply.result as never;
  },
  on(listener) {
    const handler = (_e: IpcRendererEvent, event: string, data: unknown): void => (listener as (e: string, d: unknown) => void)(event, data);
    ipcRenderer.on('core:event', handler);
    return () => { ipcRenderer.off('core:event', handler); };
  },
  status: () => ipcRenderer.invoke('core:status') as Promise<CoreStatus>,
  onStatus(listener) {
    const handler = (_e: IpcRendererEvent, status: CoreStatus): void => listener(status);
    ipcRenderer.on('core:status', handler);
    return () => { ipcRenderer.off('core:status', handler); };
  },
  coreProblem: () => ipcRenderer.invoke('core:problem') as Promise<CoreProblem | null>,
  onCoreProblem(listener) {
    const handler = (_e: IpcRendererEvent, problem: CoreProblem | null): void => listener(problem);
    ipcRenderer.on('core:problem', handler);
    return () => { ipcRenderer.off('core:problem', handler); };
  },
  coreAction: (action) => ipcRenderer.invoke('core:action', action) as Promise<void>,
  pickFolder: () => ipcRenderer.invoke('app:pickFolder') as Promise<string | null>,
  openDemo: () => ipcRenderer.invoke('app:openDemo') as Promise<boolean>,
  pickFiles: () => ipcRenderer.invoke('app:pickFiles') as Promise<PickedFiles | null>,
  openPath: (path) => ipcRenderer.invoke('app:openPath', path) as Promise<void>,
  onNavigate(listener) {
    const handler = (_e: IpcRendererEvent, hash: string): void => { if (typeof hash === 'string' && hash.startsWith('#/')) listener(hash); };
    ipcRenderer.on('app:navigate', handler);
    return () => { ipcRenderer.off('app:navigate', handler); };
  },
  onAlerts(listener) {
    const handler = (_e: IpcRendererEvent, needs: unknown): void => { if (Array.isArray(needs)) listener(needs); };
    ipcRenderer.on('app:alerts', handler);
    return () => { ipcRenderer.off('app:alerts', handler); };
  },
  alertsSeen: (keys) => ipcRenderer.invoke('app:alertsSeen', keys) as Promise<void>,
  alertsDismissed: (keys) => ipcRenderer.invoke('app:alertsDismissed', keys) as Promise<void>,
  onCommand(listener) {
    const handler = (_e: IpcRendererEvent, id: unknown): void => { if (typeof id === 'string') listener(id); };
    ipcRenderer.on('app:command', handler);
    return () => { ipcRenderer.off('app:command', handler); };
  },
  appState: () => ipcRenderer.invoke('app:state') as Promise<AppState | null>,
  setSettings: (patch) => ipcRenderer.invoke('app:setSettings', patch) as Promise<AppState | null>,
  checkForUpdates: () => ipcRenderer.invoke('app:checkUpdates') as Promise<AppState | null>,
  openUpdate: (which) => ipcRenderer.invoke('app:openUpdate', which) as Promise<void>,
  onAppState(listener) {
    const handler = (_e: IpcRendererEvent, state: AppState): void => listener(state);
    ipcRenderer.on('app:state', handler);
    return () => { ipcRenderer.off('app:state', handler); };
  },
  platform: process.platform,
};

contextBridge.exposeInMainWorld('wanigan', bridge);
