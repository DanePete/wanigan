import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { CoreProblem, CoreStatus, LiveBridge, LiveViewState, PickedFiles, WaniganBridge } from '../shared/bridge.ts';
import type { LiveEdited } from '../shared/live-lens.ts';
import type { AppState } from '../shared/settings.ts';

type Reply = { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } };

const live: LiveBridge = {
  show: (projectId, url, bounds, token) => ipcRenderer.invoke('live:show', projectId, url, bounds, token ?? null) as Promise<boolean>,
  bounds: (bounds) => ipcRenderer.send('live:bounds', bounds),
  hide: () => ipcRenderer.invoke('live:hide') as Promise<void>,
  cover: (covered) => ipcRenderer.invoke('live:cover', covered) as Promise<string | null>,
  reload: (hard) => ipcRenderer.invoke('live:reload', hard === true) as Promise<void>,
  css: () => ipcRenderer.invoke('live:css') as Promise<number>,
  go: (url) => ipcRenderer.invoke('live:go', url) as Promise<boolean>,
  back: () => ipcRenderer.invoke('live:back') as Promise<void>,
  forward: () => ipcRenderer.invoke('live:forward') as Promise<void>,
  open: () => ipcRenderer.invoke('live:open') as Promise<void>,
  devtools: () => ipcRenderer.invoke('live:devtools') as Promise<void>,
  scan: () => ipcRenderer.invoke('live:scan') as ReturnType<LiveBridge['scan']>,
  outline: (indexes, label, tone) => ipcRenderer.invoke('live:outline', indexes, label, tone ?? 'edit') as Promise<number>,
  clear: () => ipcRenderer.invoke('live:clear') as Promise<void>,
  pick: () => ipcRenderer.invoke('live:pick') as ReturnType<LiveBridge['pick']>,
  cancelPick: () => ipcRenderer.invoke('live:cancelPick') as Promise<void>,
  capture: (rect) => ipcRenderer.invoke('live:capture', rect ?? null) as Promise<string | null>,
  hasScript: () => ipcRenderer.invoke('live:hasScript') as Promise<boolean>,
  problems: () => ipcRenderer.invoke('live:problems') as ReturnType<LiveBridge['problems']>,
  helperChanged: () => ipcRenderer.invoke('live:helper', 'changed') as Promise<number | null>,
  helperSave: async (field, before, after) => (await ipcRenderer.invoke('live:helper', 'save', { field, before, after }))
    ?? { ok: false, error: 'The live view has no helper for this site.', label: null },
  mutations: () => ipcRenderer.invoke('live:mutations') as Promise<number>,
  picked: () => ipcRenderer.invoke('live:picked') as ReturnType<LiveBridge['picked']>,
  style: (values) => ipcRenderer.invoke('live:style', values) as ReturnType<LiveBridge['style']>,
  unstyle: () => ipcRenderer.invoke('live:unstyle') as ReturnType<LiveBridge['unstyle']>,
  editText: () => ipcRenderer.invoke('live:editText') as ReturnType<LiveBridge['editText']>,
  cancelEdit: () => ipcRenderer.invoke('live:cancelEdit') as Promise<void>,
  onState(listener) {
    const handler = (_e: IpcRendererEvent, state: LiveViewState): void => listener(state);
    ipcRenderer.on('live:state', handler);
    return () => { ipcRenderer.off('live:state', handler); };
  },
  // The helper's trace, lenses and editing in place (src/main/live-inspect.ts).
  trace: () => ipcRenderer.invoke('live:trace') as ReturnType<LiveBridge['trace']>,
  paint: (items) => ipcRenderer.invoke('live:paint', items) as Promise<number>,
  where: (index) => ipcRenderer.invoke('live:where', index) as ReturnType<LiveBridge['where']>,
  editOpen: (target, bounds) => ipcRenderer.invoke('live:editOpen', target, bounds) as ReturnType<LiveBridge['editOpen']>,
  editBounds: (bounds) => ipcRenderer.send('live:editBounds', bounds),
  editClose: () => ipcRenderer.invoke('live:editClose') as Promise<void>,
  editSave: (target, value) => ipcRenderer.invoke('live:editSave', target, value) as ReturnType<LiveBridge['editSave']>,
  onEdited(listener) {
    const handler = (_e: IpcRendererEvent, edited: LiveEdited): void => listener(edited);
    ipcRenderer.on('live:edited', handler);
    return () => { ipcRenderer.off('live:edited', handler); };
  },
  onKey(listener) {
    const handler = (_e: IpcRendererEvent, key: unknown): void => { if (key === 'Escape') listener(key); };
    ipcRenderer.on('live:key', handler);
    return () => { ipcRenderer.off('live:key', handler); };
  },
};

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
  live,
  platform: process.platform,
};

contextBridge.exposeInMainWorld('wanigan', bridge);
