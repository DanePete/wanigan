import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { CoreProblem, CoreStatus, LiveBridge, LiveRecordState, LiveViewState, PickedFiles, VoiceBridge, WaniganBridge } from '../shared/bridge.ts';
import type { VoiceState } from '../shared/voice.ts';
import type { LiveEdited } from '../shared/live-lens.ts';
import type { AppState } from '../shared/settings.ts';

type Reply = { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } };

const live: LiveBridge = {
  show: (projectId, url, bounds, token, env) => ipcRenderer.invoke('live:show', projectId, url, bounds, token ?? null, env ?? null) as Promise<boolean>,
  bounds: (bounds) => ipcRenderer.send('live:bounds', bounds),
  hide: () => ipcRenderer.invoke('live:hide') as Promise<void>,
  cover: (covered) => ipcRenderer.invoke('live:cover', covered) as Promise<string | null>,
  reload: (hard) => ipcRenderer.invoke('live:reload', hard === true) as Promise<void>,
  css: () => ipcRenderer.invoke('live:css') as Promise<number>,
  hideAdmin: (hide) => ipcRenderer.invoke('live:hideAdmin', hide) as Promise<boolean>,
  go: (url) => ipcRenderer.invoke('live:go', url) as Promise<boolean>,
  back: () => ipcRenderer.invoke('live:back') as Promise<void>,
  forward: () => ipcRenderer.invoke('live:forward') as Promise<void>,
  open: () => ipcRenderer.invoke('live:open') as Promise<void>,
  // The page's own DevTools, in the dock or its own window (src/main/live-devtools.ts).
  devtoolsShow: (bounds, focus) => ipcRenderer.invoke('live:devtoolsShow', bounds, focus === true) as ReturnType<LiveBridge['devtoolsShow']>,
  devtoolsBounds: (bounds) => ipcRenderer.send('live:devtoolsBounds', bounds),
  devtoolsHide: (frame) => ipcRenderer.invoke('live:devtoolsHide', frame === true) as Promise<string | null>,
  devtoolsClose: () => ipcRenderer.invoke('live:devtoolsClose') as Promise<void>,
  devtoolsDetach: () => ipcRenderer.invoke('live:devtoolsDetach') as Promise<boolean>,
  devtoolsInspect: (x, y) => ipcRenderer.invoke('live:devtoolsInspect', x, y) as Promise<boolean>,
  onDevtools(listener) {
    const handler = (_e: IpcRendererEvent, mode: unknown): void => { if (mode === 'closed' || mode === 'docked' || mode === 'detached') listener(mode); };
    ipcRenderer.on('live:devtoolsMode', handler);
    return () => { ipcRenderer.off('live:devtoolsMode', handler); };
  },
  reveal: (index) => ipcRenderer.invoke('live:reveal', index) as ReturnType<LiveBridge['reveal']>,
  scan: () => ipcRenderer.invoke('live:scan') as ReturnType<LiveBridge['scan']>,
  outline: (indexes, label, tone) => ipcRenderer.invoke('live:outline', indexes, label, tone ?? 'edit') as Promise<number>,
  clear: () => ipcRenderer.invoke('live:clear') as Promise<void>,
  pick: (start) => ipcRenderer.invoke('live:pick', start ?? null) as ReturnType<LiveBridge['pick']>,
  choose: (index) => ipcRenderer.invoke('live:choose', index) as ReturnType<LiveBridge['choose']>,
  cancelPick: () => ipcRenderer.invoke('live:cancelPick') as Promise<void>,
  capture: (rect) => ipcRenderer.invoke('live:capture', rect ?? null) as Promise<string | null>,
  hasScript: () => ipcRenderer.invoke('live:hasScript') as Promise<boolean>,
  problems: () => ipcRenderer.invoke('live:problems') as ReturnType<LiveBridge['problems']>,
  helperChanged: () => ipcRenderer.invoke('live:helper', 'changed') as Promise<number | null>,
  helperSave: async (field, before, after) => (await ipcRenderer.invoke('live:helper', 'save', { field, before, after }))
    ?? { ok: false, error: 'The live view has no helper for this site.', label: null },
  mutations: () => ipcRenderer.invoke('live:mutations') as Promise<number>,
  picked: () => ipcRenderer.invoke('live:picked') as ReturnType<LiveBridge['picked']>,
  compareShot: (request) => ipcRenderer.invoke('live:compareShot', request) as ReturnType<LiveBridge['compareShot']>,
  onState(listener) {
    const handler = (_e: IpcRendererEvent, state: LiveViewState): void => listener(state);
    ipcRenderer.on('live:state', handler);
    return () => { ipcRenderer.off('live:state', handler); };
  },
  onSiteMessages(listener) {
    const handler = (_e: IpcRendererEvent, said: Parameters<Parameters<LiveBridge['onSiteMessages']>[0]>[0]): void => listener(said);
    ipcRenderer.on('live:siteMessages', handler);
    return () => { ipcRenderer.off('live:siteMessages', handler); };
  },
  // The helper's trace, lenses and editing in place (src/main/live-inspect.ts).
  trace: () => ipcRenderer.invoke('live:trace') as ReturnType<LiveBridge['trace']>,
  siteAi: () => ipcRenderer.invoke('live:siteAi') as ReturnType<LiveBridge['siteAi']>,
  paint: (items) => ipcRenderer.invoke('live:paint', items) as Promise<number>,
  where: (index) => ipcRenderer.invoke('live:where', index) as ReturnType<LiveBridge['where']>,
  fingerprints: (indexes) => ipcRenderer.invoke('live:fingerprints', indexes) as ReturnType<LiveBridge['fingerprints']>,
  focusWindow: () => ipcRenderer.invoke('live:focusWindow') as Promise<void>,
  editOpen: (target, bounds) => ipcRenderer.invoke('live:editOpen', target, bounds) as ReturnType<LiveBridge['editOpen']>,
  editBounds: (bounds) => ipcRenderer.send('live:editBounds', bounds),
  editClose: () => ipcRenderer.invoke('live:editClose') as Promise<void>,
  editSave: (target, value, options) => ipcRenderer.invoke('live:editSave', target, value, options ?? null) as ReturnType<LiveBridge['editSave']>,
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
  arrange: (spec) => ipcRenderer.invoke('live:arrange', spec) as ReturnType<LiveBridge['arrange']>,
  disarm: () => ipcRenderer.invoke('live:disarm') as Promise<void>,
  preview: (item, ref, place) => ipcRenderer.invoke('live:preview', item, ref, place) as Promise<boolean>,
  unpreview: () => ipcRenderer.invoke('live:unpreview') as Promise<void>,
  move: (move, options) => ipcRenderer.invoke('live:move', move, options ?? null) as ReturnType<LiveBridge['move']>,
  insert: (insert, options) => ipcRenderer.invoke('live:insert', insert, options ?? null) as ReturnType<LiveBridge['insert']>,
  remove: (remove, options) => ipcRenderer.invoke('live:remove', remove, options ?? null) as ReturnType<LiveBridge['remove']>,
  undo: (token) => ipcRenderer.invoke('live:undo', token) as ReturnType<LiveBridge['undo']>,
  // The component library (src/main/live-library.ts).
  library: (projectId, options) => ipcRenderer.invoke('live:library', projectId, options ?? null) as ReturnType<LiveBridge['library']>,
  libraryPictures: (projectId, entries, options) => ipcRenderer.invoke('live:libraryPictures', projectId, entries, options ?? null) as ReturnType<LiveBridge['libraryPictures']>,
  libraryPicture: (projectId, entry, width) => ipcRenderer.invoke('live:libraryPicture', projectId, entry, width) as ReturnType<LiveBridge['libraryPicture']>,
  libraryUsage: (projectId, entry, options) => ipcRenderer.invoke('live:libraryUsage', projectId, entry, options ?? null) as ReturnType<LiveBridge['libraryUsage']>,
  // The design layer (src/main/live-layer.ts).
  layerApply: () => ipcRenderer.invoke('live:layerApply') as ReturnType<LiveBridge['layerApply']>,
  layerShow: (on) => ipcRenderer.invoke('live:layerShow', on) as ReturnType<LiveBridge['layerShow']>,
  layerTarget: () => ipcRenderer.invoke('live:layerTarget') as ReturnType<LiveBridge['layerTarget']>,
  layerImplement: (id) => ipcRenderer.invoke('live:layerImplement', id) as ReturnType<LiveBridge['layerImplement']>,
  layerUndo: (id) => ipcRenderer.invoke('live:layerUndo', id) as ReturnType<LiveBridge['layerUndo']>,
  layerVerify: (id, options) => ipcRenderer.invoke('live:layerVerify', id, options ?? null) as ReturnType<LiveBridge['layerVerify']>,
  layerPicture: (path) => ipcRenderer.invoke('live:layerPicture', path) as ReturnType<LiveBridge['layerPicture']>,
  layerType: () => ipcRenderer.invoke('live:layerType') as ReturnType<LiveBridge['layerType']>,
  layerTypeEnd: (keep) => ipcRenderer.invoke('live:layerTypeEnd', keep === true) as Promise<void>,
  layerTry: (values, scope) => ipcRenderer.invoke('live:layerTry', values ?? null, scope ?? 'this') as Promise<number>,
  // The Go to launcher (src/main/live-find.ts).
  find: (projectId, query, options) => ipcRenderer.invoke('live:find', projectId, query ?? '', options ?? null) as ReturnType<LiveBridge['find']>,
  findHere: (projectId) => ipcRenderer.invoke('live:findHere', projectId) as ReturnType<LiveBridge['findHere']>,
  awaitGoto: () => ipcRenderer.invoke('live:awaitGoto') as ReturnType<LiveBridge['awaitGoto']>,
  gotoFocus: () => ipcRenderer.invoke('live:gotoFocus') as Promise<boolean>,
  gotoReturn: () => ipcRenderer.invoke('live:gotoReturn') as Promise<void>,
  openInBrowser: (projectId, path) => ipcRenderer.invoke('live:openInBrowser', projectId, path) as Promise<boolean>,
  // Snap and Record (src/main/live-snap.ts, src/main/live-record.ts).
  snap: (mode) => ipcRenderer.invoke('live:snap', mode) as ReturnType<LiveBridge['snap']>,
  recordStart: () => ipcRenderer.invoke('live:recordStart') as ReturnType<LiveBridge['recordStart']>,
  recordStop: () => ipcRenderer.invoke('live:recordStop') as ReturnType<LiveBridge['recordStop']>,
  recordSay: (text, at) => ipcRenderer.invoke('live:recordSay', text, at ?? null) as Promise<boolean>,
  onRecord(listener) {
    const handler = (_e: IpcRendererEvent, state: LiveRecordState): void => listener(state);
    ipcRenderer.on('live:record', handler);
    return () => { ipcRenderer.off('live:record', handler); };
  },
  recordFile: (projectId, id, file) => ipcRenderer.invoke('live:recordFile', projectId, id, file) as Promise<string | null>,
  recordReveal: (projectId, id) => ipcRenderer.invoke('live:recordReveal', projectId, id) as Promise<boolean>,
  recordDelete: (projectId, id) => ipcRenderer.invoke('live:recordDelete', projectId, id) as Promise<boolean>,
};

// Voice input (src/main/voice.ts). A stream's MessagePort comes from the main process and is handed to the page with
// window.postMessage, the one way a port crosses into a context-isolated page; lib/voice.ts takes it from there.
const voice: VoiceBridge = {
  state: () => ipcRenderer.invoke('voice:state') as Promise<VoiceState | null>,
  onState(listener) {
    const handler = (_e: IpcRendererEvent, state: VoiceState): void => listener(state);
    ipcRenderer.on('voice:state', handler);
    return () => { ipcRenderer.off('voice:state', handler); };
  },
  setSettings: (patch) => ipcRenderer.invoke('voice:setSettings', patch) as Promise<VoiceState | null>,
  download: (id) => ipcRenderer.invoke('voice:download', id) as Promise<VoiceState | null>,
  cancel: (id) => ipcRenderer.invoke('voice:cancel', id) as Promise<VoiceState | null>,
  remove: (id) => ipcRenderer.invoke('voice:remove', id) as Promise<VoiceState | null>,
  start: () => ipcRenderer.invoke('voice:start') as ReturnType<VoiceBridge['start']>,
  openMicSettings: () => ipcRenderer.invoke('voice:openMicSettings') as Promise<boolean>,
};
ipcRenderer.on('voice:port', (event, data: unknown) => {
  const port = event.ports[0];
  const id = data && typeof data === 'object' ? (data as { id?: unknown }).id : null;
  const page = globalThis as unknown as { postMessage(message: unknown, origin: string, transfer: unknown[]): void };
  if (port && typeof id === 'string') page.postMessage({ wanigan: 'voice-port', id }, '*', [port]);
});

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
  voice,
  platform: process.platform,
  toursOff: process.env.WANIGAN_TOURS === 'off',
};

contextBridge.exposeInMainWorld('wanigan', bridge);
